// GEX levels, v2: the interpretation layer changes suggested by the "Gamma Exposure Explained" video (Flow Zone Trader,
// G5MOoK_Hurk). The gamma / GEX maths is NOT redefined here: rows still come from `buildGexRows` in ./gex.ts, so v1 and v2
// can be compared on identical per-strike numbers. What is new:
//   - walls restricted to their side of spot (call wall = upper boundary, put wall = lower boundary), plus top-N walls
//   - a gamma flip found by re-pricing every leg at hypothetical spots (the zero-gamma level), not the per-strike sign change
//   - expected move = ATM call + ATM put, and a confluence check of levels against its bands
//   - a plain-language regime note
// Pure functions, no I/O.

import { calculateTimeToExpiryYears, computeBsGreeksExact, RISK_FREE_RATE } from './optionsPricing.ts';
import { gexValue, type GexChainEntry, type GexPower, type GexRow } from './gex.ts';
import { black76Gamma, gexTimeYears, resolveIvs } from './gexModel.ts';

// ───────────────────────── walls ─────────────────────────

export interface Wall {
  strike: number;
  /** Positive for calls, negative for puts (the row's own sign). */
  gex: number;
  side: 'call' | 'put';
  /** Spot has already crossed this wall: a call wall below spot / a put wall above spot. It now acts the other way round. */
  broken: boolean;
}

export interface SpotSideWalls {
  /** Highest call GEX at or above spot. */
  callWall: number | null;
  /** Highest put |GEX| at or below spot. */
  putWall: number | null;
  /** Global maxima, kept so the difference from v1 stays visible. */
  callOverall: number | null;
  putOverall: number | null;
}

export function spotSideWalls(rows: GexRow[], spot: number): SpotSideWalls {
  let call: GexRow | null = null;
  let put: GexRow | null = null;
  let callAll: GexRow | null = null;
  let putAll: GexRow | null = null;
  for (const r of rows) {
    if (r.ceGex > 0 && (!callAll || r.ceGex > callAll.ceGex)) callAll = r;
    if (r.peGex < 0 && (!putAll || r.peGex < putAll.peGex)) putAll = r;
    if (spot > 0 && r.strike >= spot && r.ceGex > 0 && (!call || r.ceGex > call.ceGex)) call = r;
    if (spot > 0 && r.strike <= spot && r.peGex < 0 && (!put || r.peGex < put.peGex)) put = r;
  }
  return {
    callWall: call?.strike ?? null,
    putWall: put?.strike ?? null,
    callOverall: callAll?.strike ?? null,
    putOverall: putAll?.strike ?? null,
  };
}

/** The `n` largest call walls and `n` largest put walls over the whole chain, each flagged when spot has crossed it. */
export function topWalls(rows: GexRow[], spot: number, n = 3): { call: Wall[]; put: Wall[] } {
  const call = rows
    .filter(r => r.ceGex > 0)
    .sort((a, b) => b.ceGex - a.ceGex)
    .slice(0, n)
    .map((r): Wall => ({ strike: r.strike, gex: r.ceGex, side: 'call', broken: spot > 0 && spot > r.strike }));
  const put = rows
    .filter(r => r.peGex < 0)
    .sort((a, b) => a.peGex - b.peGex)
    .slice(0, n)
    .map((r): Wall => ({ strike: r.strike, gex: r.peGex, side: 'put', broken: spot > 0 && spot < r.strike }));
  return { call, put };
}

/** Rank (1-based) of `strike` among a wall list, or null when it is not one of them. */
export function wallRank(walls: Wall[], strike: number): number | null {
  const i = walls.findIndex(w => w.strike === strike);
  return i < 0 ? null : i + 1;
}

// ───────────────────────── multi-expiry merge ─────────────────────────

/** Sum rows of several expiries by strike. Gamma columns are not meaningful across expiries and keep the first expiry's value. */
export function mergeGexRows(sets: GexRow[][]): GexRow[] {
  const by = new Map<number, GexRow>();
  for (const rows of sets) {
    for (const r of rows) {
      const cur = by.get(r.strike);
      if (!cur) { by.set(r.strike, { ...r }); continue; }
      cur.ceOi += r.ceOi;
      cur.peOi += r.peOi;
      cur.ceGex += r.ceGex;
      cur.peGex += r.peGex;
      cur.netGex = cur.ceGex + cur.peGex;
    }
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

// ───────────────────────── dynamic gamma flip ─────────────────────────

/** One option leg with everything needed to re-price its gamma at another underlying level. */
export interface GexLeg {
  type: 'CE' | 'PE';
  strike: number;
  /** Open interest in index units. */
  oiUnits: number;
  /** Implied vol in percent (first positive of the chain's two IV fields). */
  ivPct: number;
  /** Years to this leg's expiry. */
  t: number;
  /** Black-76 forward divided by spot for this leg's expiry; keeps a hypothetical spot consistent with its forward. */
  fwdRatio: number;
}

export function buildGexLegs(
  oc: Record<string, GexChainEntry>,
  p: { expiry: string; underlying: number; spot: number; now?: number },
): GexLeg[] {
  if (!(p.underlying > 0) || !(p.spot > 0)) return [];
  const t = gexTimeYears(p.expiry, p.now);
  const fwdRatio = p.underlying / p.spot;
  const ivs = resolveIvs(oc, p.underlying);
  const legs: GexLeg[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    for (const [type, leg] of [['CE', v.ce], ['PE', v.pe]] as const) {
      const oi = Math.max(0, leg?.oi ?? 0);
      if (oi === 0) continue;
      // Same IV resolution as v1 (OTM leg preferred, parity and nearest-strike fallbacks).
      const ivPct = ivs.get(`${strike}|${type}`) ?? 0;
      if (!(ivPct > 0)) continue;
      legs.push({ type, strike, oiUnits: oi, ivPct, t, fwdRatio });
    }
  }
  return legs;
}

/** Net dealer GEX (calls +, puts -) with every leg re-priced as if spot were `spotH`. */
export function netGexAtSpot(legs: GexLeg[], spotH: number, power: GexPower = 1, r = RISK_FREE_RATE): number {
  let net = 0;
  for (const l of legs) {
    const F = spotH * l.fwdRatio;
    const gamma = black76Gamma(F, l.strike, l.t, l.ivPct / 100, r);
    const g = gexValue(gamma, l.oiUnits, F, power);
    net += l.type === 'CE' ? g : -g;
  }
  return net;
}

export interface DynamicFlip {
  /** Spot level where recomputed net GEX crosses zero, nearest to spot. Null when it never crosses inside the scan. */
  flip: number | null;
  /** The scan: hypothetical spot and net GEX there. */
  curve: { spot: number; net: number }[];
}

/**
 * Zero-gamma level: net GEX recomputed at `points` hypothetical spots across +-`span` of real spot (default 61 points, +-20%),
 * refined by bisection at the sign change closest to real spot.
 */
export function dynamicFlip(legs: GexLeg[], spot: number, opts: { span?: number; points?: number; power?: GexPower; r?: number; minShare?: number } = {}): DynamicFlip {
  const span = opts.span ?? 0.2;
  const points = Math.max(3, opts.points ?? 61);
  if (!legs.length || !(spot > 0)) return { flip: null, curve: [] };
  const curve: { spot: number; net: number }[] = [];
  for (let i = 0; i < points; i++) {
    const s = spot * (1 - span + (2 * span * i) / (points - 1));
    curve.push({ spot: s, net: netGexAtSpot(legs, s, opts.power ?? 1, opts.r) });
  }
  // Like v1's gammaFlip: a sign change between two near-zero points (far-OTM tails of the scan) is noise, not a regime change.
  const peak = curve.reduce((m, c) => Math.max(m, Math.abs(c.net)), 0);
  const floor = peak * (opts.minShare ?? 0.01);
  const crossings: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (Math.max(Math.abs(a.net), Math.abs(b.net)) <= floor) continue;
    if (a.net === 0) { crossings.push(a.spot); continue; }
    if ((a.net < 0) !== (b.net < 0) && b.net !== 0) {
      // The 61-point grid is ~150 index points wide: bisect on the real curve instead of interpolating across it.
      let lo = a.spot;
      let hi = b.spot;
      const loNeg = a.net < 0;
      for (let k = 0; k < 40 && hi - lo > 0.05; k++) {
        const mid = (lo + hi) / 2;
        if ((netGexAtSpot(legs, mid, opts.power ?? 1, opts.r) < 0) === loNeg) lo = mid; else hi = mid;
      }
      crossings.push((lo + hi) / 2);
    }
  }
  if (!crossings.length) return { flip: null, curve };
  const flip = crossings.reduce((best, c) => (Math.abs(c - spot) < Math.abs(best - spot) ? c : best));
  return { flip, curve };
}

// ───────────────────────── expected move ─────────────────────────

export interface ExpectedMove {
  strike: number;
  /** ATM call + ATM put premium, in index points. */
  em: number;
  upper: number;
  lower: number;
  /** 'ltp' = the chain's last prices; 'model' = Black-76 from the chain IV (used when a last price is missing). */
  source: 'ltp' | 'model';
}

export function expectedMove(
  oc: Record<string, GexChainEntry & { ce?: { last_price?: number | null } | null; pe?: { last_price?: number | null } | null }>,
  p: { spot: number; underlying: number; expiry: string; now?: number; r?: number },
): ExpectedMove | null {
  if (!(p.spot > 0)) return null;
  // Dhan keys strikes as "22800.000000", so match on the numeric value, never on String(strike).
  const entries = Object.entries(oc).map(([k, v]) => ({ k: Number(k), v })).filter(x => Number.isFinite(x.k));
  if (!entries.length) return null;
  const best = entries.reduce((b, x) => (Math.abs(x.k - p.spot) < Math.abs(b.k - p.spot) ? x : b), entries[0]);
  const atm = best.k;
  const e = best.v;
  const ceLtp = Number(e.ce?.last_price);
  const peLtp = Number(e.pe?.last_price);
  let em: number;
  let source: 'ltp' | 'model' = 'ltp';
  if (ceLtp > 0 && peLtp > 0) {
    em = ceLtp + peLtp;
  } else {
    const t = calculateTimeToExpiryYears(p.expiry, p.now);
    const iv = (leg: GexChainEntry['ce']) => [leg?.implied_volatility, leg?.greeks?.iv].find((x): x is number => typeof x === 'number' && x > 0) ?? 0;
    const ivC = iv(e.ce);
    const ivP = iv(e.pe);
    if (!(p.underlying > 0) || !(ivC > 0 || ivP > 0)) return null;
    const r = p.r ?? RISK_FREE_RATE;
    em = computeBsGreeksExact('CE', p.underlying, atm, t, (ivC || ivP) / 100, r, true).price
       + computeBsGreeksExact('PE', p.underlying, atm, t, (ivP || ivC) / 100, r, true).price;
    source = 'model';
  }
  if (!(em > 0)) return null;
  return { strike: atm, em, upper: p.spot + em, lower: p.spot - em, source };
}

export interface Confluence { label: string; value: number; band: 'upper' | 'lower'; distance: number }

/** Levels that sit within `tolFrac` x EM of an expected-move band. */
export function emConfluence(levels: { label: string; value: number | null }[], em: ExpectedMove, tolFrac = 0.25): Confluence[] {
  const tol = em.em * tolFrac;
  const out: Confluence[] = [];
  for (const l of levels) {
    if (l.value == null || !Number.isFinite(l.value)) continue;
    const du = Math.abs(l.value - em.upper);
    const dl = Math.abs(l.value - em.lower);
    if (du <= tol && du <= dl) out.push({ label: l.label, value: l.value, band: 'upper', distance: du });
    else if (dl <= tol) out.push({ label: l.label, value: l.value, band: 'lower', distance: dl });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// ───────────────────────── regime note ─────────────────────────

export function regimeNote(regime: 'positive' | 'negative' | 'unknown'): string {
  if (regime === 'positive') return 'Positive gamma: dealers sell rallies and buy dips. Expect rotation between the walls; fading the edges is the usual read, and breakouts tend to fail.';
  if (regime === 'negative') return 'Negative gamma: dealers sell weakness and buy strength. Moves run further and faster, and a broken wall can flip to the other side. Do not fade a breakout until price accepts back inside.';
  return 'Regime unknown: no usable chain data.';
}
