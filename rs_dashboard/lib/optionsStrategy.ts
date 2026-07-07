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
    id: 'batman', name: 'Batman', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Inner buy offset (strikes)', default: 5, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Spread width (strikes)', default: 1, min: 1, max: 5, step: 1 },
    ],
    legs: (p) => [
      // Call side: Buy inner call (qtyRatio 1), Sell outer call (qtyRatio 2)
      { offsetStrikes: +p.N, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'SELL', qtyRatio: 2 },
      // Put side: Buy inner put (qtyRatio 1), Sell outer put (qtyRatio 2)
      { offsetStrikes: -p.N, type: 'PE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'SELL', qtyRatio: 2 },
    ],
  },
  {
    id: 'double_plateau', name: 'Double Plateau', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Inner buy offset (strikes)', default: 4, min: 1, max: 10, step: 1 },
      { key: 'W1', label: 'Spread width (strikes)', default: 5, min: 1, max: 10, step: 1 },
      { key: 'W2', label: 'Plateau width (strikes)', default: 5, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      // Call side: C1 (Buy), C2 (Sell), C3 (Sell), C4 (Buy)
      { offsetStrikes: +p.N, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W1), type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W1 + p.W2), type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + 2 * p.W1 + p.W2), type: 'CE', side: 'BUY', qtyRatio: 1 },
      // Put side: P1 (Buy), P2 (Sell), P3 (Sell), P4 (Buy)
      { offsetStrikes: -p.N, type: 'PE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W1), type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W1 + p.W2), type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + 2 * p.W1 + p.W2), type: 'PE', side: 'BUY', qtyRatio: 1 },
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
  security_id?: number;
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
  securityId: string | null;
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
    const entry = oc[String(strike)] ?? oc[strike.toFixed(6)] ?? Object.entries(oc).find(([k]) => Math.abs(parseFloat(k) - strike) < 0.01)?.[1];
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
      securityId: legData.security_id ? String(legData.security_id) : null,
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

// ── Payoff engine ────────────────────────────────────────────────────────────

/** Per-unit-of-lot payoff at a given expiry spot price (not yet scaled by lotSize). */
export function legPayoffAtExpiry(spot: number, leg: ResolvedLeg): number {
  const intrinsic = leg.type === 'CE' ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
  const perUnit = leg.side === 'SELL' ? (leg.price - intrinsic) : (intrinsic - leg.price);
  return perUnit * leg.qtyLots;
}

function netPnlAtExpiry(legs: ResolvedLeg[], spot: number, lotSize: number): number {
  return legs.reduce((sum, leg) => sum + legPayoffAtExpiry(spot, leg), 0) * lotSize;
}

/** Zero-crossings of a piecewise-linear {spot, pnl} curve, via linear interpolation between adjacent samples. */
export function findBreakevens(curve: { spot: number; pnl: number }[]): number[] {
  const breakevens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const [s0, p0] = [curve[i - 1].spot, curve[i - 1].pnl];
    const [s1, p1] = [curve[i].spot, curve[i].pnl];
    if (p0 === 0) { breakevens.push(s0); continue; }
    if ((p0 < 0 && p1 > 0) || (p0 > 0 && p1 < 0)) {
      const be = s0 + (0 - p0) * (s1 - s0) / (p1 - p0);
      breakevens.push(Math.round(be * 100) / 100);
    }
  }
  return breakevens;
}

/**
 * Sample spot range covering all wings for a NIFTY strategy: +/-15% of spot, with
 * every leg's strike forced in as an exact sample point (piecewise-linear kinks
 * only occur at strikes, so max/min and breakevens must be evaluated exactly there).
 */
function buildSpotSamples(legs: ResolvedLeg[], spot: number): number[] {
  const pctSpan = spot * 0.015; // +/- 1.5% of spot
  const strikes = legs.map((l) => l.strike);
  const minStrike = strikes.length > 0 ? Math.min(...strikes) : spot;
  const maxStrike = strikes.length > 0 ? Math.max(...strikes) : spot;

  const pad = STRIKE_STEP * 4; // 200 points padding for wings
  const lo = Math.min(spot - pctSpan, minStrike - pad);
  const hi = Math.max(spot + pctSpan, maxStrike + pad);

  // Make bounds symmetric around spot
  const maxDiff = Math.max(spot - lo, hi - spot);
  const symLo = spot - maxDiff;
  const symHi = spot + maxDiff;

  const samples = new Set<number>();
  const stepCount = 150;
  for (let i = 0; i <= stepCount; i++) {
    samples.add(Math.round((symLo + ((symHi - symLo) * i) / stepCount) * 100) / 100);
  }
  for (const leg of legs) samples.add(leg.strike);
  return [...samples].sort((a, b) => a - b);
}

export function buildPayoffCurve(
  legs: ResolvedLeg[], spot: number, lotSize: number,
): { spot: number; pnl: number }[] {
  return buildSpotSamples(legs, spot).map((s) => ({ spot: s, pnl: netPnlAtExpiry(legs, s, lotSize) }));
}

export interface PayoffStats {
  maxProfit: number | 'Unlimited';
  maxLoss: number | 'Unlimited';
  breakevensExpiry: number[];
  rewardRisk: number | null;
  netPremium: number;      // per lot, credit(+)/debit(-)
  intrinsicValue: number;  // rupees, at current spot
  timeValue: number;       // rupees, at current spot
  popPct: number | null;
}

export function computePayoffStats(legs: ResolvedLeg[], spot: number, lotSize: number): PayoffStats {
  const curve = buildPayoffCurve(legs, spot, lotSize);

  // Net qty per side (signed lots): >0 means net SHORT that option type -> unbounded loss on that tail.
  const netCallQty = legs.filter(l => l.type === 'CE').reduce((s, l) => s + (l.side === 'SELL' ? l.qtyLots : -l.qtyLots), 0);
  const netPutQty  = legs.filter(l => l.type === 'PE').reduce((s, l) => s + (l.side === 'SELL' ? l.qtyLots : -l.qtyLots), 0);

  const upsideUnlimited = netCallQty > 0;
  const downsideUnlimited = netPutQty > 0;

  const pnls = curve.map(c => c.pnl);
  const maxProfit = Math.max(...pnls);
  const boundedMinLoss = Math.min(...pnls);
  const maxLoss: number | 'Unlimited' = (upsideUnlimited || downsideUnlimited) ? 'Unlimited' : boundedMinLoss;

  const rewardRisk = (maxLoss === 'Unlimited' || maxLoss === 0) ? null : Math.abs(maxProfit / maxLoss);

  const netPremium = legs.reduce((sum, leg) => sum + (leg.side === 'SELL' ? leg.price : -leg.price) * leg.qtyLots, 0);

  let intrinsicValue = 0;
  let timeValue = 0;
  for (const leg of legs) {
    const intrinsicNow = leg.type === 'CE' ? Math.max(spot - leg.strike, 0) : Math.max(leg.strike - spot, 0);
    const sideSign = leg.side === 'SELL' ? 1 : -1;
    intrinsicValue += sideSign * leg.qtyLots * intrinsicNow * lotSize;
    timeValue += sideSign * leg.qtyLots * (leg.price - intrinsicNow) * lotSize;
  }

  // POP: delta-based approximation. Net effective short delta = short legs' |delta| minus
  // hedge (long) legs' |delta| on the same side, floored at 0.
  const hasAllDeltas = legs.every(l => l.delta !== null);
  let popPct: number | null = null;
  if (hasAllDeltas) {
    const shortAbsDelta = legs.filter(l => l.side === 'SELL').reduce((s, l) => s + Math.abs(l.delta as number), 0);
    const longAbsDelta  = legs.filter(l => l.side === 'BUY').reduce((s, l) => s + Math.abs(l.delta as number), 0);
    const effShortDelta = Math.max(0, shortAbsDelta - longAbsDelta);
    popPct = Math.round(Math.min(1, Math.max(0, 1 - effShortDelta)) * 100);
  }

  return {
    maxProfit,
    maxLoss,
    breakevensExpiry: findBreakevens(curve),
    rewardRisk,
    netPremium,
    intrinsicValue,
    timeValue,
    popPct,
  };
}

// ── Minimal Black-Scholes pricer for "Target" (pre-expiry) breakevens ──────────

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (no external dependency). */
function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1) * t * Math.exp(-ax*ax);
  return 0.5 * (1 + sign * y);
}

/** Black-Scholes European option price. t in years, iv as a fraction (e.g. 0.13), r default 6.5%. */
export function bsPrice(type: OptType, S: number, K: number, t: number, iv: number, r = 0.065): number {
  if (t <= 0 || iv <= 0) {
    return type === 'CE' ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  const d2 = d1 - iv * Math.sqrt(t);
  if (type === 'CE') {
    return S * normCdf(d1) - K * Math.exp(-r * t) * normCdf(d2);
  }
  return K * Math.exp(-r * t) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * "Target" (pre-expiry, today) P&L curve using each leg's current IV and current DTE.
 * Falls back to intrinsic-only pricing for a leg with no IV (documented limitation,
 * surfaced by the caller via an InfoButton — see Task 8).
 */
export function buildTargetPayoffCurve(
  legs: ResolvedLeg[], spot: number, lotSize: number, daysToExpiry: number,
): { spot: number; pnl: number }[] {
  const t = Math.max(daysToExpiry, 0) / 365;
  return buildSpotSamples(legs, spot).map((s) => {
    const pnl = legs.reduce((sum, leg) => {
      const iv = leg.iv ?? 0;
      const price = iv > 0 ? bsPrice(leg.type, s, leg.strike, t, iv) : (leg.type === 'CE' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0));
      const perUnit = leg.side === 'SELL' ? (leg.price - price) : (price - leg.price);
      return sum + perUnit * leg.qtyLots;
    }, 0) * lotSize;
    return { spot: s, pnl };
  });
}
