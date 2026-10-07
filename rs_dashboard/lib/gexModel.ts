// Black-76 gamma model for GEX. NOT from the source video: the video takes gamma from the broker's chain (see gex.ts, which has
// no pricing maths at all). This module exists only for GEX v2 (its zero-gamma flip needs gamma at hypothetical spots, and its
// Gamma switch offers the model as a cross-check). GEX OI Chart (v1) must never import it.
//
// Gamma here is Black-76 on the future rolled to the expiry, from the chain IV, with a 10-minute time floor instead of the shared
// pricing clock's 6 hours (which froze expiry-day gamma from ~09:40).

import { calculateTimeToExpiryYears, expiryEpochMs, normPdf, CALENDAR_DAYS_PER_YEAR, RISK_FREE_RATE } from './optionsPricing.ts';
import {
  chainGamma, gexValue,
  type GammaSource, type GexCalcRow, type GexCalcSide, type GexCalcTable, type GexChainEntry, type GexLegInput, type GexPower, type GexRow,
} from './gex.ts';

/** Black-76 forward for `expiry` implied by spot alone (cost of carry S*e^{rT}). Used only when no future price is available. */
export function forwardFromSpot(spot: number, expiry: string, r = RISK_FREE_RATE, now: number = Date.now()): number {
  return spot > 0 ? spot * Math.exp(r * calculateTimeToExpiryYears(expiry, now)) : 0;
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


export interface ModelGexParams {
  expiry: string;
  /** Black-76 underlying: the future rolled to the chain's expiry. */
  underlying: number;
  lotSize?: number | null;
  oiUnit?: 'units' | 'lots';
  power?: GexPower;
  now?: number;
  r?: number;
}

function legGamma(ivPct: number | undefined, strike: number, F: number, t: number, r: number): number {
  if (!(ivPct && ivPct > 0)) return 0; // no IV anywhere nearby, no gamma: a zero is honest, a guess is not
  return black76Gamma(F, strike, t, ivPct / 100, r);
}

/** Per-strike GEX with gamma recomputed by Black-76. Price multiplier is the rolled future. */
export function buildGexRowsModel(oc: Record<string, GexChainEntry>, p: ModelGexParams): GexRow[] {
  const power = p.power ?? 1;
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

export interface GexModelCalcSide extends GexCalcSide {
  /** Dhan's chain gamma for this leg (0 when none). */
  chainGamma: number;
  /** Black-76 gamma recomputed from IV. */
  modelGamma: number;
  ivPct: number;
  ivSource: IvSource;
  d1: number;
  pdf: number;
}

export interface GexModelCalcTable extends GexCalcTable<GexModelCalcSide> {
  F: number;
  spot: number;
  t: number;
  r: number;
  discount: number;
}

/** v2's calculation table: both gammas per leg, `gammaSource` choosing which one feeds GEX. */
export function gexModelCalcTable(oc: Record<string, GexChainEntry>, p: ModelGexParams & { spot: number; gammaSource: GammaSource }): GexModelCalcTable {
  const power = p.power ?? 1;
  const r = p.r ?? RISK_FREE_RATE;
  const source = p.gammaSource;
  const t = Math.max(gexTimeYears(p.expiry, p.now), GEX_MIN_T);
  const F = p.underlying;
  const price = source === 'dhan' && p.spot > 0 ? p.spot : F;
  const out: GexModelCalcTable = { rows: [], source, lot: p.lotSize && p.lotSize > 0 ? p.lotSize : null, price, power, scale: price > 0 ? Math.pow(price, power) * 0.01 : 0, F, spot: p.spot, t, r, discount: Math.exp(-r * t) };
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(price > 0) || !(oiToUnits > 0)) return out;
  const ivs = F > 0 ? resolveIvDetail(oc, F) : new Map<string, { iv: number; source: IvSource }>();
  const side = (type: 'CE' | 'PE', strike: number, leg: GexLegInput | null | undefined, oi: number): GexModelCalcSide | null => {
    if (!(oi > 0)) return null;
    const d = ivs.get(`${strike}|${type}`);
    const terms = d && F > 0 ? black76GammaTerms(F, strike, t, d.iv / 100, r) : null;
    const cg = chainGamma(leg);
    const mg = terms?.gamma ?? 0;
    const gamma = source === 'dhan' ? cg : mg;
    const oiUnits = oi * oiToUnits;
    const g = gexValue(gamma, oiUnits, price, power);
    return { oiUnits, gamma, gex: type === 'CE' ? g : -g, chainGamma: cg, modelGamma: mg, ivPct: d?.iv ?? 0, ivSource: d?.source ?? 'own', d1: terms?.d1 ?? NaN, pdf: terms?.pdf ?? NaN };
  };
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ce = side('CE', strike, v.ce, Math.max(0, v.ce?.oi ?? 0));
    const pe = side('PE', strike, v.pe, Math.max(0, v.pe?.oi ?? 0));
    if (!ce && !pe) continue;
    out.rows.push({ strike, ce, pe, netGex: (ce?.gex ?? 0) + (pe?.gex ?? 0) } as GexCalcRow<GexModelCalcSide>);
  }
  out.rows.sort((a, b) => a.strike - b.strike);
  return out;
}
