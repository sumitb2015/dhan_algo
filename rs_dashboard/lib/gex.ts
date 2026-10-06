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
// Gamma comes from computeBsGreeksExact (Black-76 on the future), never from rounded display values.

import { calculateTimeToExpiryYears, computeBsGreeksExact, RISK_FREE_RATE } from './optionsPricing.ts';

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

function legGamma(
  type: 'CE' | 'PE',
  leg: GexLegInput | null | undefined,
  strike: number,
  F: number,
  t: number,
  r: number,
): number {
  // First positive IV wins: Dhan sends 0 (not null) for an untraded strike, which `??` would accept as the answer.
  const ivPct = [leg?.implied_volatility, leg?.greeks?.iv].find((v): v is number => typeof v === 'number' && v > 0) ?? 0;
  if (!(ivPct > 0)) return 0; // no IV, no gamma: a zero is honest, a guess is not
  return computeBsGreeksExact(type, F, strike, t, ivPct / 100, r, true).gamma;
}

export function buildGexRows(oc: Record<string, GexChainEntry>, p: GexParams): GexRow[] {
  const power = p.power ?? 2;
  const r = p.r ?? RISK_FREE_RATE;
  const t = calculateTimeToExpiryYears(p.expiry, p.now);
  if (!(p.underlying > 0)) return [];
  const oiToUnits = p.oiUnit === 'lots' ? (p.lotSize ?? 0) : 1;
  if (!(oiToUnits > 0)) return [];

  const rows: GexRow[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ceOi = Math.max(0, v.ce?.oi ?? 0);
    const peOi = Math.max(0, v.pe?.oi ?? 0);
    if (ceOi === 0 && peOi === 0) continue;
    const ceGamma = legGamma('CE', v.ce, strike, p.underlying, t, r);
    const peGamma = legGamma('PE', v.pe, strike, p.underlying, t, r);
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
