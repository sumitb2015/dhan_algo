// Delta exposure (DEX) per strike, as the Dhan app's Greeks Exposure > Delta Exposure tab shows it:
//
//   DEX_strike = delta x OI_units x spot          (rupees; shown in Cr = / 1e7)
//
// delta is Dhan's own chain value (greeks.delta). Calls are positive, puts negative, net = call + put, so the sign
// convention matches the gamma view. Checked 2026-10-13 against the app: 21850 put -120.11 Cr, 22300 call 8,279.26 Cr,
// 22400 call 11,314.20 Cr all reproduce within Dhan's 5-decimal delta rounding. Rows reuse GexRow (ceGamma/peGamma hold
// the per-contract delta, ceGex/peGex the exposure) so the gamma charts, tooltip and table render them unchanged.
import { gammaFlip, type GexRow } from './gex.ts';

export interface DexLegInput { oi?: number | null; greeks?: { delta?: number | null } | null }
export interface DexChainEntry { ce?: DexLegInput | null; pe?: DexLegInput | null }

/** Per-strike delta exposure from Dhan's chain delta. Call delta is taken positive and put delta negative whatever the feed's sign. */
export function buildDexRows(oc: Record<string, DexChainEntry>, spot: number): GexRow[] {
  if (!(spot > 0)) return [];
  const rows: GexRow[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const ceOi = Math.max(0, v.ce?.oi ?? 0);
    const peOi = Math.max(0, v.pe?.oi ?? 0);
    if (ceOi === 0 && peOi === 0) continue;
    const ceDelta = Math.abs(v.ce?.greeks?.delta ?? 0);
    const peDelta = Math.abs(v.pe?.greeks?.delta ?? 0);
    const ceGex = ceDelta * ceOi * spot;
    const peGex = -peDelta * peOi * spot;
    rows.push({ strike, ceOi, peOi, ceGamma: ceDelta, peGamma: peDelta, ceGex, peGex, netGex: ceGex + peGex });
  }
  return rows.sort((a, b) => a.strike - b.strike);
}

export interface DexSummary { call: number; put: number; net: number; ratio: number | null }

/** Totals over the rows given (the caller passes the ATM window). Ratio is |put| / call, as the app's DEX Ratio. */
export function dexSummary(rows: GexRow[]): DexSummary {
  const call = rows.reduce((a, r) => a + r.ceGex, 0);
  const put = rows.reduce((a, r) => a + r.peGex, 0);
  return { call, put, net: call + put, ratio: call > 0 ? -put / call : null };
}

/**
 * Bullish / Balanced / Bearish word beside the ratio (|put| / call). Dhan does not publish the cut-offs (its DEXT T3 launch post,
 * madefortrade.in/t/92529, only names the tags). Ground truth read off the app, 2026-10-13:
 *   Bullish  at 0.5703 (GEX), 0.6688 (DEX), 0.7443 (DEX)
 *   Balanced at 0.9544 (DEX)
 * so the Bullish/Balanced boundary lies in (0.7443, 0.9544); 0.8 is inside that bracket but not pinned. The Balanced/Bearish
 * boundary has no data point above 1 yet; 1.2 is a guess. Tighten both from further app screenshots.
 */
export function ratioLabel(ratio: number | null): 'Bullish' | 'Balanced' | 'Bearish' | null {
  if (ratio == null) return null;
  return ratio < 0.8 ? 'Bullish' : ratio > 1.2 ? 'Bearish' : 'Balanced';
}

export interface DexLevels {
  /** Largest call exposure in the rows (the app's Call Resistance). */
  callResistance: number | null;
  /** Largest put exposure by magnitude at a strike other than callResistance (the app's Put Support). */
  putSupport: number | null;
  /** Midpoint of the strikes where net turns negative to positive (the app's Delta Flip). */
  flip: number | null;
}

export function dexLevels(rows: GexRow[], spot?: number): DexLevels {
  // The app picks Call Resistance first (largest call exposure), then Put Support as the largest put exposure at ANY OTHER strike:
  // on 2026-10-13 09:22 the largest put (22400, -15,340 Cr) sat on the Call Resistance strike and the app showed Put Support 22500
  // (-10,444 Cr), the next largest. Neither level is restricted to its side of spot (22400 was below spot 22,439.95).
  let c: GexRow | null = null;
  for (const r of rows) if (r.ceGex > 0 && (!c || r.ceGex > c.ceGex)) c = r;
  let p: GexRow | null = null;
  for (const r of rows) if (r.peGex < 0 && r !== c && (!p || r.peGex < p.peGex)) p = r;
  return { callResistance: c?.strike ?? null, putSupport: p?.strike ?? null, flip: gammaFlip(rows, spot) };
}
