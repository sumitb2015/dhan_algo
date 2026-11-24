// OI profile for the /index-scalper underlying chart: per strike, the Call and the Put open interest drawn as
// horizontal bars at that strike's price level. Pure: no React, no canvas. Tested in indexScalperOiProfile.test.ts.
//
// Display only. The source is the live bridge chain, else Dhan's REST snapshot (feed.chain): OI never prices or sends.
// OI is in the units the bridge carries (Dhan's: contracts x lot size), shown compact (K / L / Cr).

export interface OiRow { strike: number; ce: number; pe: number }

export interface OiProfile {
  rows: OiRow[];
  /** Largest Call / Put OI among the rows (0 when none) and where it sits: the strongest resistance / support. */
  maxCe: number; maxCeStrike: number | null;
  maxPe: number; maxPeStrike: number | null;
}

interface StrikeLike { strike?: number; ce?: { oi?: number } | null; pe?: { oi?: number } | null }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Rows from a chain's `strikes` map (live bridge or snapshot), sorted by strike; strikes with no OI on either side are
 *  dropped. Null without a chain. */
export function buildOiProfile(strikes: Record<string, StrikeLike> | null | undefined): OiProfile | null {
  if (!strikes) return null;
  const rows: OiRow[] = [];
  for (const [k, sd] of Object.entries(strikes)) {
    const strike = Number(sd?.strike ?? k);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const ce = num(sd?.ce?.oi), pe = num(sd?.pe?.oi);
    if (ce === 0 && pe === 0) continue;
    rows.push({ strike, ce, pe });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.strike - b.strike);
  let maxCe = 0, maxPe = 0, maxCeStrike: number | null = null, maxPeStrike: number | null = null;
  for (const r of rows) {
    if (r.ce > maxCe) { maxCe = r.ce; maxCeStrike = r.strike; }
    if (r.pe > maxPe) { maxPe = r.pe; maxPeStrike = r.strike; }
  }
  return { rows, maxCe, maxCeStrike, maxPe, maxPeStrike };
}

/** One string for everything the overlay draws, so the memoised chart re-renders only when OI actually changes (most
 *  feed pushes move only prices). */
export function oiProfileKey(p: OiProfile | null): string {
  return p ? p.rows.map(r => `${r.strike}:${r.ce}:${r.pe}`).join(',') : '';
}

export interface OiBar { strike: number; side: 'CE' | 'PE'; x: number; y: number; w: number; h: number; oi: number; max: boolean }

/**
 * Bar rectangles in plot pixels. Bars grow leftwards from the plot's right edge (`right`, just left of the price axis),
 * the longest `maxW` wide; the Call bar sits just above the strike's level, the Put bar just below it, each up to half
 * the strike spacing tall. Strikes off screen (`yOf` null, or outside 0..height) are skipped. Bars share ONE scale (the
 * larger of the two maxima among the strikes on screen) so a Call and a Put bar compare directly.
 */
export function oiBars(
  p: OiProfile,
  yOf: (price: number) => number | null,
  right: number,
  height: number,
  maxW: number,
): OiBar[] {
  const placed: { r: OiRow; y: number }[] = [];
  for (const r of p.rows) {
    const y = yOf(r.strike);
    if (y === null || !Number.isFinite(y) || y < 0 || y > height) continue;
    placed.push({ r, y });
  }
  if (placed.length === 0) return [];
  // Strike spacing in pixels (median gap between neighbours on screen), so bars never overlap the next strike.
  const gaps: number[] = [];
  for (let i = 1; i < placed.length; i++) gaps.push(Math.abs(placed[i].y - placed[i - 1].y));
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 16;
  const h = Math.max(2, Math.min(14, gap / 2 - 1));
  const scale = Math.max(...placed.map(({ r }) => Math.max(r.ce, r.pe)));
  if (!(scale > 0)) return [];
  const out: OiBar[] = [];
  for (const { r, y } of placed) {
    if (r.ce > 0) {
      const w = Math.max(1, (r.ce / scale) * maxW);
      out.push({ strike: r.strike, side: 'CE', x: right - w, y: y - h, w, h, oi: r.ce, max: r.strike === p.maxCeStrike });
    }
    if (r.pe > 0) {
      const w = Math.max(1, (r.pe / scale) * maxW);
      out.push({ strike: r.strike, side: 'PE', x: right - w, y, w, h, oi: r.pe, max: r.strike === p.maxPeStrike });
    }
  }
  return out;
}

/** Compact OI: 1.23 Cr / 4.56 L / 7.8 K; "—" for none. */
export function fmtOI(n: number | undefined): string {
  if (!n) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} K`;
  return String(n);
}
