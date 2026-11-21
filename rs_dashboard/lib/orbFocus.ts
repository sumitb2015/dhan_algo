// The Signal Orb's short straddle / strangle rules, run by the Ultimate Scalper (Focus Tool) rule engine itself.
// The Focus Tool's decisions are pure functions over a row's config (`FocusRow`), its fill ledger and a live view (`RowLive`)
// (lib/focusToolRules.ts, parity-tested against its Python twin). The Orb does not copy them: it builds those inputs from its own
// legs each tick and calls them, so a leg SL x, its Trail SL, SL-to-cost, a leg target, the pair SL and the overall target behave
// exactly as on the Focus Tool page and cannot drift from it. No IO, no clock (the minute is passed in), no React.
// Relative imports only so lib/orbFocus.test.ts runs under `node --test`.

import {
  costStopReason, entryPremiumWeighted, evaluateEntry, evaluateOverallExit, evaluateRowExit, legStopHit, legStopLevel, legTargetReason, nextOverallPeak,
  overallProgress, type RowLive,
} from './focusToolRules.ts';
import type { FocusRow, FocusRowStatus } from './focusToolRows.ts';

/** Leg Trail SL (Focus: AlgoTest "X-Y"): every `every` the premium falls below entry, the leg's stop moves `by` closer; `startAt` delays it. */
export interface PremiumTrail { enabled: boolean; unit: 'pts' | 'pct'; every: number; by: number; startAt: number }

/** The straddle / strangle rule set. 0 = off. The names and units are the Focus Tool's. */
export interface PremiumConfig {
  /** IST HH:MM the structure is sold at (the first minute at or after it; one entry a day). */
  entryTime: string;
  /** Leg SL: a leg exits when its premium reaches entry x this (Focus "SL x", e.g. 1.5). */
  legSlX: number;
  /** After a leg's SL, the other leg's stop moves to its entry premium (Focus "SL to cost"). */
  slToCost: boolean;
  /** Total premium SL: exit all when the combined premium has risen this % over the combined entry (Focus pair SL x = 1 + pct/100). */
  totalSlPct: number;
  /** Total SL in rupees (MTM): exit all when the P&L falls to minus this. */
  totalSlRs: number;
  /** Leg target: a leg exits when its premium has decayed this % from entry. */
  legTgtPct: number;
  /** Overall target: exit all at `targetValue` rupees of profit (mtm) or % of the combined entry premium (premiumPct). */
  targetMode: 'mtm' | 'premiumPct';
  targetValue: number;
  trail: PremiumTrail;
}

export const DEFAULT_PREMIUM: PremiumConfig = {
  entryTime: '09:20', legSlX: 1.5, slToCost: false, totalSlPct: 30, totalSlRs: 0, legTgtPct: 0, targetMode: 'premiumPct', targetValue: 50,
  trail: { enabled: false, unit: 'pts', every: 10, by: 5, startAt: 0 },
};

/** The premium rules a REAL run needs: at least one stop that closes the structure. */
export const premiumHasStop = (p: PremiumConfig): boolean => p.legSlX > 1 || p.totalSlPct > 0 || p.totalSlRs > 0;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Merge a premium patch into `cur`, bounded; a reason string when it is refused. */
export function sanitizePremiumPatch(patch: unknown, cur: PremiumConfig): PremiumConfig | string {
  if (!patch || typeof patch !== 'object') return 'premium settings must be an object';
  const p = patch as Record<string, unknown>;
  const next: PremiumConfig = { ...cur, trail: { ...cur.trail } };
  const num = (k: string, lo: number, hi: number, what: string): string | null => {
    if (p[k] === undefined) return null;
    const n = Number(p[k]);
    if (!Number.isFinite(n) || !(n === 0 || (n >= lo && n <= hi))) return `${what} must be 0 (off) or ${lo}-${hi}`;
    (next as unknown as Record<string, number>)[k] = n;
    return null;
  };
  if (p.entryTime !== undefined) {
    if (typeof p.entryTime !== 'string' || !HHMM.test(p.entryTime)) return 'entryTime must be HH:MM';
    next.entryTime = p.entryTime;
  }
  const errs = [
    num('legSlX', 1.05, 10, 'Leg SL x'), num('totalSlPct', 5, 500, 'Total SL %'), num('totalSlRs', 100, 5_000_000, 'Total SL (Rs)'),
    num('legTgtPct', 5, 95, 'Leg target %'), num('targetValue', 1, 5_000_000, 'Target'),
  ].filter(Boolean);
  if (errs.length) return errs[0] as string;
  if (p.slToCost !== undefined) next.slToCost = p.slToCost === true;
  if (p.targetMode !== undefined) {
    if (p.targetMode !== 'mtm' && p.targetMode !== 'premiumPct') return 'targetMode must be mtm or premiumPct';
    next.targetMode = p.targetMode;
  }
  if (p.trail !== undefined) {
    const t = (p.trail ?? {}) as Record<string, unknown>;
    if (t.unit !== undefined && t.unit !== 'pts' && t.unit !== 'pct') return 'trail unit must be pts or pct';
    const every = t.every === undefined ? next.trail.every : Number(t.every), by = t.by === undefined ? next.trail.by : Number(t.by);
    const startAt = t.startAt === undefined ? next.trail.startAt : Number(t.startAt);
    if (!(every > 0 && every <= 10_000) || !(by > 0 && by <= 10_000) || !(startAt >= 0 && startAt <= 10_000)) return 'trail every / by must be above 0, start at 0 or more';
    if (by > every) return 'trail: "by" larger than "every" locks the stop past the profit - use by <= every';
    next.trail = { enabled: t.enabled === undefined ? next.trail.enabled : t.enabled === true, unit: (t.unit as 'pts' | 'pct' | undefined) ?? next.trail.unit, every, by, startAt };
  }
  return next;
}

// ── The tick ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PremiumLegIn {
  side: 'CE' | 'PE';
  /** Premium it was sold at. */
  entry: number;
  /** Broker units held (lots x the broker's lot). */
  units: number;
  status: 'open' | 'closed' | 'failed';
  exit?: number;
  /** Set once the other leg's SL fired and SL-to-cost applies: this leg now exits when its premium climbs back to `entry`. */
  costStop?: boolean;
  /** Trail SL steps already earned (never lost). */
  trailSteps?: number;
}
export interface PremiumRowIn {
  lots: number;
  /** Rupees per point per lot (barrels for crude, the lot for NIFTY). */
  unitsPerLot: number;
  /** Broker units per lot (NSE: the master lot; Dhan MCX: 1). */
  lotUnits: number;
  legs: PremiumLegIn[];
  /** The running peak of profit (rupees and premium points), never below 0. */
  peak?: { pnl: number; pts: number };
}

export type PremiumAction =
  | { kind: 'stopLeg'; index: number; why: 'sl' | 'tgt' | 'cost'; reason: string }
  | { kind: 'exitAll'; why: 'sl' | 'target' | 'eod'; reason: string };

export interface TickResult {
  actions: PremiumAction[];
  peak: { pnl: number; pts: number };
  /** Trail steps per leg index after this tick (to be saved: a step once earned is kept). */
  trailSteps: Record<number, number>;
}

/** The Focus rule inputs built from the Orb's own legs. `side` is 'BOTH': a straddle and a strangle both trade the two legs. */
function focusInputs(cfg: PremiumConfig, row: PremiumRowIn, marks: { CE: number | null; PE: number | null }) {
  const open = (s: 'CE' | 'PE') => row.legs.find(l => l.side === s && l.status === 'open');
  const ce = open('CE'), pe = open('PE');
  const trail = cfg.trail.enabled ? { enabled: true, unit: cfg.trail.unit, every: String(cfg.trail.every), by: String(cfg.trail.by), ...(cfg.trail.startAt > 0 ? { startAt: String(cfg.trail.startAt) } : {}) } : undefined;
  const view = {
    side: 'BOTH', lots: row.lots,
    ceSlMultiplier: cfg.legSlX > 1 ? String(cfg.legSlX) : undefined, peSlMultiplier: cfg.legSlX > 1 ? String(cfg.legSlX) : undefined,
    ceTrailSl: trail, peTrailSl: trail,
    slToCost: cfg.slToCost, slToCostScope: 'all',
    ceTgtPct: cfg.legTgtPct > 0 ? String(cfg.legTgtPct) : undefined, peTgtPct: cfg.legTgtPct > 0 ? String(cfg.legTgtPct) : undefined, legTgtUnit: 'pct',
    slMultiplier: cfg.totalSlPct > 0 ? String(1 + cfg.totalSlPct / 100) : undefined,
    slRupees: cfg.totalSlRs > 0 ? String(cfg.totalSlRs) : undefined,
    overallTarget: cfg.targetValue > 0 ? { enabled: true, mode: cfg.targetMode, value: String(cfg.targetValue) } : undefined,
    fill: {
      ceStrike: null, peStrike: null,
      ceQty: ce?.units ?? 0, peQty: pe?.units ?? 0,
      ceEntry: ce?.entry ?? null, peEntry: pe?.entry ?? null,
      ceCostStop: !!ce?.costStop, peCostStop: !!pe?.costStop,
      ceTrailSteps: ce?.trailSteps ?? 0, peTrailSteps: pe?.trailSteps ?? 0,
    },
  } as unknown as FocusRow;
  // Realised + open rupees across the legs: a leg is (entry - premium) x lots x rupees per point per lot, a closed leg at its exit.
  let pnl = 0;
  for (const l of row.legs) {
    if (l.status === 'failed') continue;
    const lots = row.lotUnits > 0 ? l.units / row.lotUnits : 0;
    const px = l.status === 'closed' ? l.exit ?? l.entry : marks[l.side] ?? l.entry;
    pnl += (l.entry - px) * lots * row.unitsPerLot;
  }
  const held = (l?: PremiumLegIn) => (l ? { netQty: -l.units, sellAvg: l.entry, buyAvg: 0 } as unknown as RowLive['cePosition'] : null);
  const live: RowLive = {
    ceStrike: null, peStrike: null, ltpCe: marks.CE, ltpPe: marks.PE, cePosition: held(ce), pePosition: held(pe), pnl,
    entryPremium: entryPremiumWeighted([ce && { premium: ce.entry, qty: ce.units }, pe && { premium: pe.entry, qty: pe.units }].filter(Boolean) as { premium: number; qty: number }[], row.lotUnits),
    lotSize: row.lotUnits, vwap: null, vwapClose: null, ceBuildup: null, peBuildup: null, ceOiChgPct: null, peOiChgPct: null,
    ceOi: null, peOi: null, vwap1m: null, vwapClose1m: null,
  };
  return { view, live };
}

/**
 * What the structure must do now, by the Focus Tool's own rules, in its order: the cutoff, the pair SL (total premium % / rupees),
 * the overall target, then each open leg's cost stop, SL (with its Trail SL) and target. The pair and overall rules need a live
 * premium on every open leg and are skipped otherwise; a leg is judged on its own premium. Only open legs are judged; nothing
 * here knows a broker.
 */
export function premiumTick(i: { cfg: PremiumConfig; row: PremiumRowIn; marks: { CE: number | null; PE: number | null }; minute: number; eodMin: number }): TickResult {
  const { cfg, row, marks } = i;
  const open = row.legs.map((l, index) => ({ l, index })).filter(x => x.l.status === 'open');
  const peak0 = row.peak ?? { pnl: 0, pts: 0 };
  const trailSteps: Record<number, number> = {};
  if (!open.length) return { actions: [], peak: peak0, trailSteps };
  if (i.minute >= i.eodMin) return { actions: [{ kind: 'exitAll', why: 'eod', reason: `Cutoff reached` }], peak: peak0, trailSteps };

  const { view, live } = focusInputs(cfg, row, marks);
  let peak = peak0;
  if (open.every(x => (marks[x.l.side] ?? 0) > 0)) {
    const pair = evaluateRowExit(view, live, 0, undefined, row.lotUnits);
    if (pair) return { actions: [{ kind: 'exitAll', why: 'sl', reason: pair }], peak, trailSteps };
    const p = overallProgress(view, live, undefined, row.lotUnits);
    peak = nextOverallPeak(row.peak, { pnl: p.pnl, pts: p.pts });
    const ov = evaluateOverallExit(view, live, peak, undefined, row.lotUnits);
    if (ov) return { actions: [{ kind: 'exitAll', why: ov.kind === 'target' ? 'target' : 'sl', reason: ov.reason }], peak, trailSteps };
  }
  const actions: PremiumAction[] = [];
  for (const { l, index } of open) {
    const ltp = marks[l.side];
    if (!(ltp && ltp > 0)) continue;
    const cost = costStopReason(view, l.side, live);
    const stop = legStopLevel(view, l.side, live, ltp);
    if (stop && stop.trailed > 0) trailSteps[index] = Math.max(stop.trailed, l.trailSteps ?? 0);
    const sl = legStopHit(stop, l.side, live, 0);
    const tgt = legTargetReason(view, l.side, live, undefined, 0);
    if (cost) actions.push({ kind: 'stopLeg', index, why: 'cost', reason: cost });
    else if (sl) actions.push({ kind: 'stopLeg', index, why: 'sl', reason: sl });
    else if (tgt) actions.push({ kind: 'stopLeg', index, why: 'tgt', reason: tgt });
  }
  return { actions, peak, trailSteps };
}

/** The stop level in force on a leg, for display (the same call the tick makes). Null when the leg has none or is not open. */
export function legStopForDisplay(cfg: PremiumConfig, row: PremiumRowIn, index: number, ltp: number): { level: number; label: string; trailed: number } | null {
  const leg = row.legs[index];
  if (!leg || leg.status !== 'open') return null;
  const { view, live } = focusInputs(cfg, row, { CE: leg.side === 'CE' ? ltp : null, PE: leg.side === 'PE' ? ltp : null });
  if (leg.costStop && cfg.slToCost) return { level: leg.entry, label: 'SL to cost', trailed: 0 };
  const s = legStopLevel(view, leg.side, live, ltp);
  return s ? { level: s.level, label: s.label, trailed: s.trailed } : null;
}

/**
 * Should the structure be sold now? The Focus Tool's own entry gate (evaluateEntry): the group switch is the Orb's Auto, the row is
 * armed, it is flat, today is a trading day, the clock has reached the entry time and is not past the row's exit time (the cutoff)
 * or the intraday bell. `reason` is what the Focus Tool would log.
 */
export function premiumEntryCheck(i: { entryTime: string; cutoffHm: string; nowHm: string; autoOn: boolean; flat: boolean; tradingDay: boolean }): { enter: boolean; reason: string } {
  return evaluateEntry(
    { status: 'armed' as FocusRowStatus, lots: 1, dte: 'Any', entryTime: i.entryTime, exitTime: i.cutoffHm, side: 'BOTH' },
    { nowHm: i.nowHm, groupEnabled: i.autoOn, product: 'INTRADAY', backstopHm: i.cutoffHm, dte: null, strikesReady: true, flat: i.flat, tradingDay: i.tradingDay },
  );
}
