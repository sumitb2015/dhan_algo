// Gamma exposure (GEX) per strike for an option chain, plus the levels read off it.
//
// GEX_strike = gamma x OI_units x U^k x 0.01, where OI_units = contracts x lot (Dhan's chain OI is already in units).
//   gamma x U x 0.01 is the delta change per unit for a 1% move, so with k = 1 the result is the number of INDEX UNITS
//   dealers must trade per 1% move. The video's formula (gamma x OI x lot x spot x 0.01) is exactly this, but it labels
//   the answer in rupees. k = 2 multiplies by U once more and gives the rupee notional.
//   Video example (0.0008, 50,000 lots, lot 65, spot 24,200): k = 1 gives 629,200 units, k = 2 gives Rs 1,522.66 Cr.
//   The slide's "Rs 62.9 Cr" is neither (it is 62.9 million = Rs 6.29 Cr, the product without the x 0.01).
// Sign convention: dealers are assumed long calls / short puts, so call GEX is positive and put GEX negative.
// That is an assumption (Indian index options have no public dealer book), not a measurement.
//
// Gamma is Black-76 on the future (black76Gamma below, the same closed form as computeBsGreeksExact but with a 10-minute
// time floor instead of 6 hours), never from rounded display values.

import { calculateTimeToExpiryYears, expiryEpochMs, normPdf, CALENDAR_DAYS_PER_YEAR, RISK_FREE_RATE } from './optionsPricing.ts';

/** Black-76 forward for `expiry` implied by spot alone (cost of carry S*e^{rT}). Used only when no future price is available. */
export function forwardFromSpot(spot: number, expiry: string, r = RISK_FREE_RATE, now: number = Date.now()): number {
  return spot > 0 ? spot * Math.exp(r * calculateTimeToExpiryYears(expiry, now)) : 0;
}

/** Compact GEX / OI figure: 1.2K, 3.4L, 5.97 Cr, 5,972 Cr. */
export function fmtGex(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}${Math.round(a / 1e7).toLocaleString('en-IN')} Cr`;
  if (a >= 1e7) return `${s}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${s}${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`;
  return `${s}${a.toFixed(0)}`;
}

export interface GexLegInput {
  oi?: number | null;
  /** Dhan chain IV, in percent (e.g. 14.2). */
  implied_volatility?: number | null;
  greeks?: { iv?: number | null; gamma?: number | null } | null;
}

export interface GexChainEntry { ce?: GexLegInput | null; pe?: GexLegInput | null }

export type GexPower = 1 | 2;

/** One strike-side of GEX. `oiUnits` is open interest in index units (contracts x lot). */
export function gexValue(gamma: number, oiUnits: number, underlying: number, power: GexPower = 2): number {
  return gamma * oiUnits * Math.pow(underlying, power) * 0.01;
}

// OI unit: Dhan's chain reports OI in UNITS (every OI on the live chain was a multiple of the lot size, checked
// 2026-10-06). There is deliberately no auto-detection: a lot revision leaves older series with OI in multiples of the
// previous lot, which any divisibility test would misread as "lots" and silently inflate every strike 65x. A caller whose
// source really is in lots passes oiUnit: 'lots' explicitly.

export interface GexRow {
  strike: number;
  /** Open interest in index UNITS, exactly as built; a view that shows lots divides in its own row type. */
  ceOi: number;
  peOi: number;
  ceGamma: number;
  peGamma: number;
  /** Positive. */
  ceGex: number;
  /** Negative. */
  peGex: number;
  netGex: number;
}

export interface GexLevels {
  callWall: number | null;
  putWall: number | null;
  /** Strike with the largest ceGex + |peGex|: the likeliest expiry magnet. */
  pin: number | null;
  /** Net-GEX zero crossing, interpolated between adjacent strikes. Null when net GEX never changes sign. */
  flip: number | null;
  totalNet: number;
  totalCall: number;
  totalPut: number;
  regime: 'positive' | 'negative' | 'unknown';
}

export interface GexParams {
  expiry: string;
  /** Black-76 underlying: the future rolled to the chain's expiry. Spot is only an approximation (no cost of carry). */
  underlying: number;
  /** Needed only to convert lot-denominated OI to units. */
  lotSize?: number | null;
  /** Default 'units' (Dhan's convention). Never inferred; see the note above. */
  oiUnit?: 'units' | 'lots';
  power?: GexPower;
  now?: number;
  r?: number;
}

/** Smallest time-to-expiry GEX will use (10 minutes). The shared pricing clock floors at 6 hours, which freezes every
 *  gamma from ~09:40 on expiry day and understates ATM against OTM strikes by 1.4x at 3h left and 2.5x at 1h left. */
export const GEX_MIN_T = 10 / (60 * 24 * CALENDAR_DAYS_PER_YEAR);

/** Years to the 15:40 IST close with only a 10-minute floor. GEX-only: prices and payoffs keep calculateTimeToExpiryYears. */
export function gexTimeYears(expiry: string, now: number = Date.now()): number {
  if (!expiry) return calculateTimeToExpiryYears(expiry, now);
  const ms = expiryEpochMs(expiry) - now;
  if (!Number.isFinite(ms)) return calculateTimeToExpiryYears(expiry, now);
  return Math.max(GEX_MIN_T, ms / (CALENDAR_DAYS_PER_YEAR * 24 * 3600 * 1000));
}

export interface Black76GammaTerms {
  /** Time used, after the GEX floor. */
  t: number;
  /** sigma x sqrt(t). */
  sd: number;
  d1: number;
  /** Standard normal density at d1. */
  pdf: number;
  /** e^{-rt}. */
  discount: number;
  gamma: number;
}

/** Every intermediate of the Black-76 gamma, so a table can show the numbers the formula used. */
export function black76GammaTerms(F: number, strike: number, t: number, iv: number, r: number = RISK_FREE_RATE): Black76GammaTerms | null {
  if (!(F > 0) || !(strike > 0) || !(iv > 0)) return null;
  const tt = Math.max(t, GEX_MIN_T);
  const sd = iv * Math.sqrt(tt);
  const d1 = (Math.log(F / strike) + 0.5 * iv * iv * tt) / sd;
  const pdf = normPdf(d1);
  const discount = Math.exp(-r * tt);
  return { t: tt, sd, d1, pdf, discount, gamma: (discount * pdf) / (F * sd) };
}

/** Black-76 gamma per index unit (same for calls and puts) with the GEX time floor. Matches computeBsGreeksExact's gamma. */
export function black76Gamma(F: number, strike: number, t: number, iv: number, r: number = RISK_FREE_RATE): number {
  return black76GammaTerms(F, strike, t, iv, r)?.gamma ?? 0;
}

const firstIv = (leg: GexLegInput | null | undefined): number =>
  // First positive IV wins: Dhan sends 0 (not null) for an untraded strike, which `??` would accept as the answer.
  [leg?.implied_volatility, leg?.greeks?.iv].find((v): v is number => typeof v === 'number' && v > 0) ?? 0;

export type IvSource = 'own' | 'otm-leg' | 'other-leg' | 'nearest';

/**
 * IV in percent for every strike-side that has open interest, keyed `${strike}|CE` / `${strike}|PE`, with where it came from.
 * Preference: the OTM leg's own IV (an ITM leg's IV from the chain is noisy), then the opposite leg at the same strike
 * (put-call parity: same IV), then the nearest strike's IV on the same side within `maxGap` points. Absent only when none exists.
 */
export function resolveIvDetail(oc: Record<string, GexChainEntry>, F: number, maxGap = 200): Map<string, { iv: number; source: IvSource }> {
  const entries = Object.entries(oc).map(([k, v]) => ({ strike: Number(k), v })).filter(e => Number.isFinite(e.strike));
  const own = (e: { v: GexChainEntry }, type: 'CE' | 'PE') => firstIv(type === 'CE' ? e.v.ce : e.v.pe);
  const nearest = (strike: number, type: 'CE' | 'PE'): number => {
    let best = 0;
    let gap = Infinity;
    for (const e of entries) {
      const iv = own(e, type);
      const g = Math.abs(e.strike - strike);
      if (iv > 0 && g > 0 && g <= maxGap && g < gap) { best = iv; gap = g; }
    }
    return best;
  };
  const out = new Map<string, { iv: number; source: IvSource }>();
  for (const e of entries) {
    for (const type of ['CE', 'PE'] as const) {
      const leg = type === 'CE' ? e.v.ce : e.v.pe;
      if (!((leg?.oi ?? 0) > 0)) continue;
      const other = type === 'CE' ? 'PE' : 'CE';
      const itm = type === 'CE' ? e.strike < F : e.strike > F;
      const a = own(e, type);
      const b = own(e, other);
      let iv = 0;
      let source: IvSource = 'own';
      if (itm && b > 0) { iv = b; source = 'otm-leg'; }
      else if (a > 0) { iv = a; source = 'own'; }
      else if (b > 0) { iv = b; source = 'other-leg'; }
      else { iv = nearest(e.strike, type); source = 'nearest'; }
      if (iv > 0) out.set(`${e.strike}|${type}`, { iv, source });
    }
  }
  return out;
}

/** IV in percent per strike-side (see resolveIvDetail for the preference order). */
export function resolveIvs(oc: Record<string, GexChainEntry>, F: number, maxGap = 200): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of resolveIvDetail(oc, F, maxGap)) out.set(k, v.iv);
  return out;
}

function legGamma(ivPct: number | undefined, strike: number, F: number, t: number, r: number): number {
  if (!(ivPct && ivPct > 0)) return 0; // no IV anywhere nearby, no gamma: a zero is honest, a guess is not
  return black76Gamma(F, strike, t, ivPct / 100, r);
}

export function buildGexRows(oc: Record<string, GexChainEntry>, p: GexParams): GexRow[] {
  const power = p.power ?? 2;
  const r = p.r ?? RISK_FREE_RATE;
  const t = gexTimeYears(p.expiry, p.now);
  if (!(p.underlying > 0)) return [];
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(oiToUnits > 0)) return [];

  const ivs = resolveIvs(oc, p.underlying);
  const rows: GexRow[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ceOi = Math.max(0, v.ce?.oi ?? 0);
    const peOi = Math.max(0, v.pe?.oi ?? 0);
    if (ceOi === 0 && peOi === 0) continue;
    const ceGamma = legGamma(ivs.get(`${strike}|CE`), strike, p.underlying, t, r);
    const peGamma = legGamma(ivs.get(`${strike}|PE`), strike, p.underlying, t, r);
    const ceGex = gexValue(ceGamma, ceOi * oiToUnits, p.underlying, power);
    const peGex = -gexValue(peGamma, peOi * oiToUnits, p.underlying, power);
    rows.push({ strike, ceOi, peOi, ceGamma, peGamma, ceGex, peGex, netGex: ceGex + peGex });
  }
  return rows.sort((a, b) => a.strike - b.strike);
}

/**
 * Linear interpolation of the net-GEX zero crossing nearest to `near` (spot) when there are several.
 * A sign change between two strikes whose net GEX is a rounding error next to the chain's biggest strike is noise
 * (far-OTM strikes with tiny OI), not a regime change, so crossings below `minShare` of the peak |net| are ignored.
 */
export function gammaFlip(rows: GexRow[], near?: number, minShare = 0.01): number | null {
  const peak = rows.reduce((m, r) => Math.max(m, Math.abs(r.netGex)), 0);
  const floor = peak * minShare;
  const crossings: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (Math.max(Math.abs(a.netGex), Math.abs(b.netGex)) <= floor) continue;
    if (a.netGex === 0) { crossings.push(a.strike); continue; }
    if ((a.netGex < 0) !== (b.netGex < 0) && b.netGex !== 0) {
      const w = Math.abs(a.netGex) / (Math.abs(a.netGex) + Math.abs(b.netGex));
      crossings.push(a.strike + w * (b.strike - a.strike));
    }
  }
  if (!crossings.length) return null;
  if (near == null) return crossings[0];
  return crossings.reduce((best, c) => (Math.abs(c - near) < Math.abs(best - near) ? c : best));
}

export function gexLevels(rows: GexRow[], spot?: number): GexLevels {
  if (!rows.length) {
    return { callWall: null, putWall: null, pin: null, flip: null, totalNet: 0, totalCall: 0, totalPut: 0, regime: 'unknown' };
  }
  let callWall = rows[0];
  let putWall = rows[0];
  let pin = rows[0];
  let totalCall = 0;
  let totalPut = 0;
  for (const r of rows) {
    if (r.ceGex > callWall.ceGex) callWall = r;
    if (r.peGex < putWall.peGex) putWall = r;
    if (r.ceGex - r.peGex > pin.ceGex - pin.peGex) pin = r;
    totalCall += r.ceGex;
    totalPut += r.peGex;
  }
  const flip = gammaFlip(rows, spot);
  const totalNet = totalCall + totalPut;
  // Regime is where spot sits relative to the flip; with no crossing, the sign of the whole chain decides.
  let regime: GexLevels['regime'] = 'unknown';
  if (spot && spot > 0) {
    if (flip != null) regime = spot >= flip ? 'positive' : 'negative';
    else regime = totalNet >= 0 ? 'positive' : 'negative';
  }
  return {
    callWall: callWall.ceGex > 0 ? callWall.strike : null,
    putWall: putWall.peGex < 0 ? putWall.strike : null,
    pin: pin.ceGex - pin.peGex > 0 ? pin.strike : null,
    flip,
    totalNet,
    totalCall,
    totalPut,
    regime,
  };
}

/** Walls are "clear" when the runner-up is well below the leader; two near-equal strikes should split the position. */
export function wallClarity(values: { strike: number; v: number }[], ratio = 0.8): { clear: boolean; runnerUp: number | null } {
  const s = [...values].sort((a, b) => b.v - a.v);
  if (s.length < 2 || s[0].v <= 0) return { clear: false, runnerUp: null };
  return { clear: s[1].v < s[0].v * ratio, runnerUp: s[1].strike };
}

export type ChecklistTone = 'ok' | 'warn' | 'bad' | 'manual';
export interface ChecklistItem { label: string; detail: string; tone: ChecklistTone }

/**
 * The source video's five-point strangle entry checklist. Informational only. `eventsManual` is always manual: the app has
 * no event calendar. Net GEX and the flip can disagree (total positive while spot sits below the flip); that case is amber,
 * never green, because the video's real test is "are we in the positive zone", not the chain total alone.
 */
export function gexChecklist(input: {
  levels: GexLevels;
  spot: number;
  vix: number | null;
  call: { clear: boolean; runnerUp: number | null };
  put: { clear: boolean; runnerUp: number | null };
}): ChecklistItem[] {
  const { levels, spot, vix, call, put } = input;
  const unknown = levels.regime === 'unknown';
  const spotInPositive = levels.flip == null ? levels.totalNet > 0 : spot >= levels.flip;
  const totalPositive = levels.totalNet > 0;
  const disagree = !unknown && totalPositive !== spotInPositive;
  return [
    {
      label: 'Net GEX positive',
      detail: unknown ? 'no data' : `total ${fmtGex(levels.totalNet)}${disagree ? ' · disagrees with spot vs flip' : ''}`,
      tone: unknown ? 'manual' : disagree ? 'warn' : totalPositive ? 'ok' : 'bad',
    },
    {
      label: 'Flip below spot',
      detail: levels.flip == null
        ? (unknown ? 'no data' : 'no sign change in chain')
        : `flip ${Math.round(levels.flip).toLocaleString('en-IN')} vs spot ${Math.round(spot).toLocaleString('en-IN')}`,
      tone: levels.flip == null ? 'manual' : levels.flip < spot ? 'ok' : 'bad',
    },
    {
      label: 'India VIX below 18',
      detail: vix == null ? 'unavailable' : `VIX ${vix.toFixed(2)}`,
      tone: vix == null ? 'manual' : vix < 18 ? 'ok' : vix < 20 ? 'warn' : 'bad',
    },
    { label: 'No major event in 3 days', detail: 'check manually (RBI, Fed, Budget, results)', tone: 'manual' },
    {
      label: 'Walls clear',
      detail: call.runnerUp == null
        ? 'no data'
        : `${call.clear ? 'call clear' : `call split with ${call.runnerUp}`} · ${put.clear ? 'put clear' : `put split with ${put.runnerUp}`}`,
      tone: call.runnerUp == null ? 'manual' : call.clear && put.clear ? 'ok' : 'warn',
    },
  ];
}

export interface GexCalcSide {
  /** Open interest in index units, after any lot conversion. */
  oiUnits: number;
  ivPct: number;
  ivSource: IvSource;
  d1: number;
  /** Standard normal density at d1. */
  pdf: number;
  gamma: number;
  /** Signed: positive for calls, negative for puts. */
  gex: number;
}

export interface GexCalcRow { strike: number; ce: GexCalcSide | null; pe: GexCalcSide | null; netGex: number }

export interface GexCalcTable {
  rows: GexCalcRow[];
  /** Black-76 forward used for every strike of this expiry. */
  F: number;
  /** Years to expiry after the GEX floor. */
  t: number;
  r: number;
  power: GexPower;
  discount: number;
  /** F^k x 0.01: the factor that turns gamma x OI into GEX. */
  scale: number;
}

/** Every number behind each strike's GEX, for the calculation table. Sums to exactly what `buildGexRows` gives. */
export function gexCalcTable(oc: Record<string, GexChainEntry>, p: GexParams): GexCalcTable {
  const power = p.power ?? 2;
  const r = p.r ?? RISK_FREE_RATE;
  const t = Math.max(gexTimeYears(p.expiry, p.now), GEX_MIN_T);
  const F = p.underlying;
  const out: GexCalcTable = { rows: [], F, t, r, power, discount: Math.exp(-r * t), scale: F > 0 ? Math.pow(F, power) * 0.01 : 0 };
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(F > 0) || !(oiToUnits > 0)) return out;
  const ivs = resolveIvDetail(oc, F);
  const side = (type: 'CE' | 'PE', strike: number, oi: number): GexCalcSide | null => {
    if (!(oi > 0)) return null;
    const d = ivs.get(`${strike}|${type}`);
    const terms = d ? black76GammaTerms(F, strike, t, d.iv / 100, r) : null;
    const oiUnits = oi * oiToUnits;
    const gamma = terms?.gamma ?? 0;
    const g = gexValue(gamma, oiUnits, F, power);
    return { oiUnits, ivPct: d?.iv ?? 0, ivSource: d?.source ?? 'own', d1: terms?.d1 ?? NaN, pdf: terms?.pdf ?? NaN, gamma, gex: type === 'CE' ? g : -g };
  };
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ce = side('CE', strike, Math.max(0, v.ce?.oi ?? 0));
    const pe = side('PE', strike, Math.max(0, v.pe?.oi ?? 0));
    if (!ce && !pe) continue;
    out.rows.push({ strike, ce, pe, netGex: (ce?.gex ?? 0) + (pe?.gex ?? 0) });
  }
  out.rows.sort((a, b) => a.strike - b.strike);
  return out;
}
