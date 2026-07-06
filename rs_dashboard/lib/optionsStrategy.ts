/**
 * Core math + template registry for the multi-leg NIFTY options strategy builder.
 * Pure functions only — no fetch/DOM/React here so this file can be unit-verified
 * standalone (see docs/superpowers/plans/2026-07-06-nifty-strategy-builder.md, Task 3/4).
 */

export const STRIKE_STEP = 50; // NIFTY

export type OptType = 'CE' | 'PE';
export type Side = 'BUY' | 'SELL';

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface LegSpec {
  offsetStrikes: number; // signed, in strike steps from ATM
  type: OptType;
  side: Side;
  qtyRatio: number; // multiplied by lots
}

export interface StrategyTemplate {
  id: string;
  name: string;
  undefinedRisk: boolean; // true if any naked short leg exists at default params
  params: ParamDef[];
  legs: (params: Record<string, number>) => LegSpec[];
}

/**
 * Batman and Double Plateau leg shapes are best-effort standard definitions —
 * they vary across brokers/platforms. All offsets below are defaults only;
 * the settings panel (Task 6) always exposes them as user-adjustable params,
 * never hardcodes them past this registry.
 */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'short_straddle', name: 'Short Straddle', undefinedRisk: true, params: [],
    legs: () => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'short_strangle', name: 'Short Strangle', undefinedRisk: true,
    params: [{ key: 'N', label: 'OTM offset (strikes)', default: 2, min: 1, max: 10, step: 1 }],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_butterfly', name: 'Iron Butterfly', undefinedRisk: false,
    params: [{ key: 'W', label: 'Wing width (strikes)', default: 5, min: 1, max: 15, step: 1 }],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.W, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -p.W, type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_condor', name: 'Iron Condor', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 3, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Wing width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'jade_lizard', name: 'Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Call spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 }, // naked put — no downside protection
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'reverse_jade_lizard', name: 'Reverse Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Put spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 }, // naked call — no upside protection
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'batman', name: 'Batman', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Inner short offset (strikes)', default: 2, min: 1, max: 8, step: 1 },
      { key: 'W', label: 'Outer wing offset (strikes)', default: 5, min: 2, max: 15, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.W, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -p.W, type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'double_plateau', name: 'Double Plateau', undefinedRisk: false,
    params: [
      { key: 'N1', label: 'Inner short offset (strikes)', default: 2, min: 1, max: 8, step: 1 },
      { key: 'N2', label: 'Outer short offset (strikes)', default: 4, min: 2, max: 12, step: 1 },
      { key: 'W', label: 'Wing width (strikes)', default: 3, min: 1, max: 8, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N1, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N1, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.N2, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N2, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N2 + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N2 + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
];

export function getTemplate(id: string): StrategyTemplate | undefined {
  return STRATEGY_TEMPLATES.find((t) => t.id === id);
}

export function defaultParams(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of template.params) out[p.key] = p.default;
  return out;
}

export function computeAtm(spot: number): number {
  return Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
}

// ── Chain data shapes (mirrors /api/options/chain's `data.chain.oc`) ───────────

export interface ChainLegData {
  last_price: number;
  oi?: number;
  implied_volatility?: number;
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
}
export interface ChainOc {
  [strike: string]: { ce?: ChainLegData; pe?: ChainLegData };
}

export interface ResolvedLeg {
  strike: number;
  type: OptType;
  side: Side;
  qtyLots: number;
  price: number;
  delta: number | null;
  iv: number | null;
}

/**
 * Resolve LegSpecs (offsets from ATM) against a fetched option chain into concrete
 * strikes with current price/delta/IV. Strikes absent from the chain are reported
 * in `missingStrikes` rather than silently defaulted — callers must block Analyze
 * on a non-empty `missingStrikes`.
 */
export function resolveLegs(
  specs: LegSpec[],
  atm: number,
  lots: number,
  oc: ChainOc,
): { legs: ResolvedLeg[]; missingStrikes: number[] } {
  const legs: ResolvedLeg[] = [];
  const missingStrikes: number[] = [];

  for (const spec of specs) {
    const strike = atm + spec.offsetStrikes * STRIKE_STEP;
    const strikeKey = String(strike);
    const entry = oc[strikeKey];
    const legData = spec.type === 'CE' ? entry?.ce : entry?.pe;

    if (!legData || typeof legData.last_price !== 'number') {
      missingStrikes.push(strike);
      continue;
    }

    legs.push({
      strike,
      type: spec.type,
      side: spec.side,
      qtyLots: lots * spec.qtyRatio,
      price: legData.last_price,
      delta: legData.greeks?.delta ?? null,
      iv: legData.implied_volatility ?? null,
    });
  }

  return { legs, missingStrikes };
}

// ── Expiry classifier (client-side, no backend change) ─────────────────────────

export type ExpiryKind = 'weekly' | 'monthly';

/** The LAST expiry date within each calendar month is classified as 'monthly'; every other date is 'weekly'. */
export function classifyExpiries(dates: string[]): { date: string; kind: ExpiryKind }[] {
  const byMonth = new Map<string, string[]>();
  for (const d of dates) {
    const key = d.slice(0, 7); // 'YYYY-MM'
    const arr = byMonth.get(key);
    if (arr) arr.push(d);
    else byMonth.set(key, [d]);
  }
  const monthly = new Set<string>();
  for (const arr of byMonth.values()) {
    const sorted = [...arr].sort();
    monthly.add(sorted[sorted.length - 1]);
  }
  return dates.map((d) => ({ date: d, kind: monthly.has(d) ? 'monthly' : 'weekly' }));
}
