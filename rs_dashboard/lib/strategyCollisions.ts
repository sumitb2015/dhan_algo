// Read-only, additive collision awareness for the vault's 2026-07-30 incident
// follow-up (open weakness #3: "running two instances short the same strike is
// still allowed"). Exact strikes are chosen at runtime (delta/offset-based —
// see strategies/*/strategy.md), so this can never be a launch-time hard block;
// it's a post-entry banner computed from data the /strategies page already
// polls every 2s (app/api/strategies GET) — no new polling, no strategy
// process touched. See .claude/skills/dhan-terminal-position-ownership's
// Invariant 8 and lib/strategy_risk.py's detect_phantom_leg(_broker) for the
// Python-side half of this incident's follow-up (the victim-side reconcile).
//
// Each strategy's state.json shape is its own (there is no shared leg
// schema — see the vault's incident writeup) — extractLegs() below tries the
// handful of shapes actually in use rather than requiring one.

export interface NormalizedLeg {
  strategyKey: string;
  instanceId: string;
  legLabel: string;
  underlying: string;
  expiry: string;
  strike: number;
  optType: 'CE' | 'PE';
}

export interface StrategyCollision {
  underlying: string;
  expiry: string;
  strike: number;
  optType: 'CE' | 'PE';
  legs: NormalizedLeg[];
}

interface StrategyMeta {
  key: string;
  name: string;
  underlying: string;
}

type StrategyState = Record<string, unknown> | null | undefined;

function asNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function asLegDict(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Extract whatever (strike, expiry, CE/PE) legs a strategy's own state.json
 * shape happens to expose. Returns [] rather than throwing on an unrecognized
 * or equity (non-options) shape — a strategy this can't parse is silently
 * skipped, not flagged as an error, since being unable to normalize a shape
 * is not evidence of a collision.
 */
export function extractLegs(
  strategyKey: string,
  instanceId: string,
  underlyingFallback: string,
  state: StrategyState,
): NormalizedLeg[] {
  if (!state) return [];
  const legs: NormalizedLeg[] = [];
  const expiryTop = asStr(state.expiry);
  const underlying = asStr(state.underlying) || underlyingFallback;

  const push = (legLabel: string, strike: unknown, expiry: string, optType: 'CE' | 'PE') => {
    const s = asNum(strike);
    if (s !== null && expiry) {
      legs.push({ strategyKey, instanceId, legLabel, underlying, expiry, strike: s, optType });
    }
  };

  // Shape A: flat ce_strike/pe_strike + top-level expiry (advanced_imbalance,
  // value_imbalance_strangle/straddle, delta_neutral, rolling_straddle, vwap_1min_straddle).
  if (state.ce_strike !== undefined) push('ce', state.ce_strike, expiryTop, 'CE');
  if (state.pe_strike !== undefined) push('pe', state.pe_strike, expiryTop, 'PE');

  // Shape B: single naked leg (oi_directional) — sold_strike + position_type ("PE_SELL"/"CE_SELL").
  if (state.sold_strike !== undefined) {
    const posType = asStr(state.position_type);
    const optType: 'CE' | 'PE' = posType.startsWith('PE') ? 'PE' : 'CE';
    push('sold', state.sold_strike, expiryTop, optType);
  }

  // Shape C: named leg dicts directly on state (overnight_fly: ce_short/pe_short/ce_hedge/pe_hedge,
  // each {strike, ...}, sharing the top-level expiry).
  for (const [label, optType] of [
    ['ce_short', 'CE'], ['pe_short', 'PE'], ['ce_hedge', 'CE'], ['pe_hedge', 'PE'],
  ] as const) {
    const leg = asLegDict(state[label]);
    if (leg) push(label, leg.strike, expiryTop, optType);
  }

  // Shape D: state.legs as {ce, pe} (delta_strangle) — each a dict with its own strike,
  // sharing the top-level expiry.
  const legsField = state.legs;
  if (legsField && typeof legsField === 'object' && !Array.isArray(legsField)) {
    const legsDict = legsField as Record<string, unknown>;
    for (const key of ['ce', 'pe'] as const) {
      const leg = asLegDict(legsDict[key]);
      if (leg) push(key, leg.strike, expiryTop, key === 'ce' ? 'CE' : 'PE');
    }

    // Shape E: state.legs as a generic {name: {strike, expiry, type}} map (flyagonal) —
    // each leg carries its own expiry/type, distinct from shapes A-D's shared top-level ones.
    for (const [label, leg] of Object.entries(legsDict)) {
      if (label === 'ce' || label === 'pe') continue; // already handled as shape D
      const d = asLegDict(leg);
      if (!d) continue;
      const t = asStr(d.type).toUpperCase();
      if (t === 'CE' || t === 'PE') {
        push(label, d.strike, asStr(d.expiry) || expiryTop, t as 'CE' | 'PE');
      }
    }
  }

  return legs;
}

/** Only a RUNNING instance's legs count — a stopped/flat strategy's last-known
 *  strike is history, not a live collision risk. */
function isRunning(state: StrategyState): boolean {
  const status = asStr((state as Record<string, unknown> | null)?.status).toUpperCase();
  return status !== '' && status !== 'STOPPED' && status !== 'IDLE' && status !== 'WAITING';
}

/**
 * Scan the /api/strategies GET aggregate for two DIFFERENT running instances
 * (any strategy, any instance id) that both hold the same (underlying, expiry,
 * strike, CE/PE) leg right now — the exact Dhan same-security-id sharing that
 * caused the 2026-07-30 incident. A strategy's own CE+PE straddle legs never
 * collide with each other (different strikes or different option types); this
 * only fires across two independently-tracked legs.
 */
export function findCollisions(
  strategies: Record<string, { meta: StrategyMeta; instances: Record<string, StrategyState> }>,
): StrategyCollision[] {
  const allLegs: NormalizedLeg[] = [];
  for (const { meta, instances } of Object.values(strategies)) {
    for (const [instanceId, state] of Object.entries(instances || {})) {
      if (!isRunning(state)) continue;
      allLegs.push(...extractLegs(meta.key, instanceId, meta.underlying, state));
    }
  }

  const byTuple = new Map<string, NormalizedLeg[]>();
  for (const leg of allLegs) {
    const tuple = `${leg.underlying}|${leg.expiry}|${leg.strike}|${leg.optType}`;
    const bucket = byTuple.get(tuple);
    if (bucket) bucket.push(leg);
    else byTuple.set(tuple, [leg]);
  }

  const collisions: StrategyCollision[] = [];
  for (const legsAtTuple of byTuple.values()) {
    const distinctInstances = new Set(legsAtTuple.map((l) => `${l.strategyKey}:${l.instanceId}`));
    if (distinctInstances.size < 2) continue; // same instance's own CE+PE, or just one holder
    const { underlying, expiry, strike, optType } = legsAtTuple[0];
    collisions.push({ underlying, expiry, strike, optType, legs: legsAtTuple });
  }
  return collisions;
}
