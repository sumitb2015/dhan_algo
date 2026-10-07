// Gamma exposure (GEX) per strike for an option chain, plus the levels read off it. This module follows the source video
// ("Trade the Influence, Not Contracts", Trading with 915) and contains no option-pricing maths:
//
//   GEX_strike = gamma x OI_units x spot x 0.01
//
// gamma is Dhan's own chain value (greeks.gamma), used exactly as given; OI_units = contracts x lot (Dhan's chain OI is already in
// units); spot is the index spot. The result is the number of INDEX UNITS dealers must trade per 1% move. The video labels the
// answer in rupees; k = 2 multiplies by spot once more and gives the rupee notional.
//   Video example (0.0008, 50,000 lots, lot 65, spot 24,200): k = 1 gives 629,200 units, k = 2 gives Rs 1,522.66 Cr.
//   The slide's "Rs 62.9 Cr" is neither (it is 62.9 million = Rs 6.29 Cr, the product without the x 0.01).
// Sign convention (video): calls positive, puts negative, net = call minus put. Dealers are assumed long calls / short puts;
// that is an assumption (Indian index options have no public dealer book), not a measurement.
//
// A Black-76 recompute of gamma, for the v2 page only, lives in gexModel.ts. Nothing here imports it.

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

/** Where each strike's gamma comes from: Dhan's own chain value (the video's method, default) or our Black-76 recompute. */
export type GammaSource = 'dhan' | 'model';

/** One strike-side of GEX. `oiUnits` is open interest in index units (contracts x lot). */
export function gexValue(gamma: number, oiUnits: number, underlying: number, power: GexPower = 1): number {
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
  /** Index spot: the price multiplier in the video's formula. */
  spot: number;
  /** Needed only to convert lot-denominated OI to units. */
  lotSize?: number | null;
  /** Default 'units' (Dhan's convention). Never inferred; see the note above. */
  oiUnit?: 'units' | 'lots';
  power?: GexPower;
}

/** Dhan's own gamma for a leg, or 0 when the chain gives none (untraded strike, closed market). */
export function chainGamma(leg: GexLegInput | null | undefined): number {
  const g = leg?.greeks?.gamma;
  return typeof g === 'number' && g > 0 ? g : 0;
}

/** Per-strike GEX from Dhan's chain gamma: gamma x OI units x spot x 0.01 (x spot again when power = 2). */
export function buildGexRows(oc: Record<string, GexChainEntry>, p: GexParams): GexRow[] {
  const power = p.power ?? 1;
  if (!(p.spot > 0)) return [];
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(oiToUnits > 0)) return [];

  const rows: GexRow[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ceOi = Math.max(0, v.ce?.oi ?? 0);
    const peOi = Math.max(0, v.pe?.oi ?? 0);
    if (ceOi === 0 && peOi === 0) continue;
    const ceGamma = chainGamma(v.ce);
    const peGamma = chainGamma(v.pe);
    const ceGex = gexValue(ceGamma, ceOi * oiToUnits, p.spot, power);
    const peGex = -gexValue(peGamma, peOi * oiToUnits, p.spot, power);
    rows.push({ strike, ceOi, peOi, ceGamma, peGamma, ceGex, peGex, netGex: ceGex + peGex });
  }
  return rows.sort((a, b) => a.strike - b.strike);
}

/**
 * Gamma flip, as the video defines it: where the Total (net) GEX column flips from negative to positive (slide 13, step 4).
 * Reported as the midpoint of the two adjacent strikes, which is how the video reads its own chart (-597 at 24,200 and +250 at
 * 24,250 are marked "Gamma Flip ~24,225"). Strikes with exactly zero net GEX carry no sign and are skipped. Only negative-to-positive
 * changes count. The video shows one flip; if a chain has several, the one nearest `near` (spot) is used.
 */
export function gammaFlip(rows: GexRow[], near?: number): number | null {
  const crossings: number[] = [];
  // A sign change between two near-zero strikes (far-OTM tails with almost no gamma) is noise, not a regime change: ignore pairs
  // whose larger |net| is under 1% of the chain's peak |net|.
  const floor = rows.reduce((m, r) => Math.max(m, Math.abs(r.netGex)), 0) * 0.01;
  let last: GexRow | null = null; // last strike with a non-zero net
  for (const r of rows) {
    if (r.netGex === 0) continue;
    if (last && last.netGex < 0 && r.netGex > 0 && Math.max(-last.netGex, r.netGex) > floor) crossings.push((last.strike + r.strike) / 2);
    last = r;
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

export interface WallValue { strike: number; v: number }

/** The largest and second-largest values on one side, for the "walls are clear" check. The video gives no number for "clear". */
export function topTwo(values: WallValue[]): { leader: WallValue | null; runnerUp: WallValue | null } {
  const s = [...values].filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  return { leader: s[0] ?? null, runnerUp: s[1] ?? null };
}

export type ChecklistTone = 'ok' | 'warn' | 'bad' | 'manual';
export interface ChecklistItem { label: string; detail: string; tone: ChecklistTone }

/**
 * The video's five-point entry checklist (slide 10). Informational only.
 *  1. Net GEX positive: the sign of the whole-chain total.
 *  2. Gamma flip below spot.
 *  3. VIX below 18 on the slide (the speaker says 20): green under 18, amber from 18 to 20, red above.
 *  4. No major event in 3 days: always manual, the app has no event calendar.
 *  5. Call and put walls clear: "one dominant strike each side, not scattered". The video gives no threshold and says to confirm it
 *     on the GEX chart (slide 13, step 5), so this is shown as the top two values per side for you to judge, never auto-graded.
 */
export function gexChecklist(input: {
  levels: GexLevels;
  spot: number;
  vix: number | null;
  call: { leader: WallValue | null; runnerUp: WallValue | null };
  put: { leader: WallValue | null; runnerUp: WallValue | null };
}): ChecklistItem[] {
  const { levels, spot, vix, call, put } = input;
  const unknown = levels.regime === 'unknown';
  const side = (name: string, t: { leader: WallValue | null; runnerUp: WallValue | null }) =>
    t.leader == null ? `${name} none` : `${name} ${t.leader.strike.toLocaleString('en-IN')} ${fmtGex(t.leader.v)}${t.runnerUp ? ` vs ${t.runnerUp.strike.toLocaleString('en-IN')} ${fmtGex(t.runnerUp.v)}` : ''}`;
  return [
    {
      label: 'Net GEX positive',
      detail: unknown ? 'no data' : `total ${fmtGex(levels.totalNet)}`,
      tone: unknown ? 'manual' : levels.totalNet > 0 ? 'ok' : 'bad',
    },
    {
      label: 'Flip below spot',
      detail: levels.flip == null
        ? (unknown ? 'no data' : 'no negative-to-positive flip in chain')
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
      detail: `${side('call', call)} · ${side('put', put)}`,
      tone: 'manual',
    },
  ];
}

export interface GexCalcSide {
  /** Open interest in index units, after any lot conversion. */
  oiUnits: number;
  /** Gamma used in GEX. */
  gamma: number;
  /** Signed: positive for calls, negative for puts. */
  gex: number;
}

export interface GexCalcRow<S extends GexCalcSide = GexCalcSide> { strike: number; ce: S | null; pe: S | null; netGex: number }

export interface GexCalcTable<S extends GexCalcSide = GexCalcSide> {
  rows: GexCalcRow<S>[];
  source: GammaSource;
  /** Index spot of this chain, one factor of the formula. */
  spot: number;
  /** Contract lot size, used to show OI in lots (units / lot). Null when unknown; GEX never depends on it. */
  lot: number | null;
  /** The price actually multiplied into GEX. */
  price: number;
  power: GexPower;
  /** price^k x 0.01: the factor that turns gamma x OI into GEX. */
  scale: number;
}

/** Every number behind each strike's GEX, for the calculation table. Sums to exactly what `buildGexRows` gives. */
export function gexCalcTable(oc: Record<string, GexChainEntry>, p: GexParams): GexCalcTable {
  const power = p.power ?? 1;
  const out: GexCalcTable = { rows: [], source: 'dhan', spot: p.spot, lot: p.lotSize && p.lotSize > 0 ? p.lotSize : null, price: p.spot, power, scale: p.spot > 0 ? Math.pow(p.spot, power) * 0.01 : 0 };
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(p.spot > 0) || !(oiToUnits > 0)) return out;
  const side = (type: 'CE' | 'PE', leg: GexLegInput | null | undefined, oi: number): GexCalcSide | null => {
    if (!(oi > 0)) return null;
    const gamma = chainGamma(leg);
    const oiUnits = oi * oiToUnits;
    const g = gexValue(gamma, oiUnits, p.spot, power);
    return { oiUnits, gamma, gex: type === 'CE' ? g : -g };
  };
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ce = side('CE', v.ce, Math.max(0, v.ce?.oi ?? 0));
    const pe = side('PE', v.pe, Math.max(0, v.pe?.oi ?? 0));
    if (!ce && !pe) continue;
    out.rows.push({ strike, ce, pe, netGex: (ce?.gex ?? 0) + (pe?.gex ?? 0) });
  }
  out.rows.sort((a, b) => a.strike - b.strike);
  return out;
}
