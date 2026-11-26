// OI profile for the /index-scalper underlying chart: per strike, the Call and the Put open interest drawn as
// horizontal bars at that strike's price level. Pure: no React, no canvas. Tested in indexScalperOiProfile.test.ts.
//
// Display only. The source is the live bridge chain, else Dhan's REST snapshot (feed.chain): OI never prices or sends.
// OI is in the units the bridge carries (Dhan's: contracts x lot size), shown compact (K / L / Cr).

export type OiMode = 'total' | 'change';

/** `ceChg` / `peChg`: OI change since the previous day, in the same units; null when there is no previous-day OI
 *  (unknown is not zero: such a strike gets no change bar). */
export interface OiRow { strike: number; ce: number; pe: number; ceChg: number | null; peChg: number | null }

export interface OiProfile {
  rows: OiRow[];
  /** Largest Call / Put OI among the rows (0 when none) and where it sits: the strongest resistance / support. */
  maxCe: number; maxCeStrike: number | null;
  maxPe: number; maxPeStrike: number | null;
  /** Largest Call / Put OI ADDED today (positive change only) and where: the freshest writing. */
  maxCeChgStrike: number | null;
  maxPeChgStrike: number | null;
  /** Any strike with a known change: false when the source has no previous-day OI at all. */
  hasChange: boolean;
}

interface SideLike { oi?: number; prev_oi?: number; oi_chg_pct?: number }
interface StrikeLike { strike?: number; ce?: SideLike | null; pe?: SideLike | null }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** OI change of one side. Exact from the previous-day OI when known (`prev_oi`: the live bridge and the snapshot carry
 *  it). Without it (a bridge started before `prev_oi` existed), back out of `oi_chg_pct`, but ONLY when non-zero: the
 *  bridge writes 0.0 both for "no change" and for "no baseline", so a 0 there is unknown. */
export function oiChange(sd: SideLike | null | undefined): number | null {
  const oi = num(sd?.oi);
  if (oi === 0) return null;
  const prev = num(sd?.prev_oi);
  if (prev > 0) return oi - prev;
  const pct = sd?.oi_chg_pct;
  if (typeof pct === 'number' && Number.isFinite(pct) && pct !== 0 && pct > -100) return Math.round(oi - oi / (1 + pct / 100));
  return null;
}

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
    rows.push({ strike, ce, pe, ceChg: oiChange(sd?.ce), peChg: oiChange(sd?.pe) });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.strike - b.strike);
  // Seeded at 0 with a strict ">": an all-zero side nominates no strike (no signal), not the lowest one.
  let maxCe = 0, maxPe = 0, maxCeStrike: number | null = null, maxPeStrike: number | null = null;
  let maxCeChg = 0, maxPeChg = 0, maxCeChgStrike: number | null = null, maxPeChgStrike: number | null = null;
  let hasChange = false;
  for (const r of rows) {
    if (r.ce > maxCe) { maxCe = r.ce; maxCeStrike = r.strike; }
    if (r.pe > maxPe) { maxPe = r.pe; maxPeStrike = r.strike; }
    if (r.ceChg !== null || r.peChg !== null) hasChange = true;
    if (r.ceChg !== null && r.ceChg > maxCeChg) { maxCeChg = r.ceChg; maxCeChgStrike = r.strike; }
    if (r.peChg !== null && r.peChg > maxPeChg) { maxPeChg = r.peChg; maxPeChgStrike = r.strike; }
  }
  return { rows, maxCe, maxCeStrike, maxPe, maxPeStrike, maxCeChgStrike, maxPeChgStrike, hasChange };
}

/** One string for everything the overlay draws, so the memoised chart re-renders only when OI actually changes (most
 *  feed pushes move only prices). */
export function oiProfileKey(p: OiProfile | null): string {
  return p ? p.rows.map(r => `${r.strike}:${r.ce}:${r.pe}:${r.ceChg}:${r.peChg}`).join(',') : '';
}

/** `oi` is the value drawn: the total OI, or the change (negative = OI shed; drawn as an outline). */
export interface OiBar { strike: number; side: 'CE' | 'PE'; x: number; y: number; w: number; h: number; oi: number; max: boolean; neg: boolean }

/**
 * Bar rectangles in plot pixels. Bars grow leftwards from the plot's right edge (`right`, just left of the price axis),
 * the longest `maxW` wide; the Call bar sits just above the strike's level, the Put bar just below it, each up to half
 * the strike spacing tall. Strikes off screen (`yOf` null, or outside 0..height) are skipped. Bars share ONE scale (the
 * largest magnitude among the strikes on screen) so a Call and a Put bar compare directly. In `change` mode the length is
 * |change|; a strike side with an unknown change gets no bar.
 */
export function oiBars(
  p: OiProfile,
  yOf: (price: number) => number | null,
  right: number,
  height: number,
  maxW: number,
  mode: OiMode = 'total',
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
  const ceVal = (r: OiRow) => (mode === 'change' ? r.ceChg : r.ce);
  const peVal = (r: OiRow) => (mode === 'change' ? r.peChg : r.pe);
  const scale = Math.max(0, ...placed.map(({ r }) => Math.max(Math.abs(ceVal(r) ?? 0), Math.abs(peVal(r) ?? 0))));
  if (!(scale > 0)) return [];
  const ceMax = mode === 'change' ? p.maxCeChgStrike : p.maxCeStrike;
  const peMax = mode === 'change' ? p.maxPeChgStrike : p.maxPeStrike;
  const out: OiBar[] = [];
  for (const { r, y } of placed) {
    const c = ceVal(r), q = peVal(r);
    if (c !== null && c !== 0) {
      const w = Math.max(1, (Math.abs(c) / scale) * maxW);
      out.push({ strike: r.strike, side: 'CE', x: right - w, y: y - h, w, h, oi: c, max: r.strike === ceMax, neg: c < 0 });
    }
    if (q !== null && q !== 0) {
      const w = Math.max(1, (Math.abs(q) / scale) * maxW);
      out.push({ strike: r.strike, side: 'PE', x: right - w, y, w, h, oi: q, max: r.strike === peMax, neg: q < 0 });
    }
  }
  return out;
}

/**
 * A strike's Call / Put bars (and their labels) that a position chip covers, moved to just below that chip: the Call
 * bar first, the Put bar under it, both keeping their size. `chips` are the chips' vertical bands in the same pixels
 * as the bars (top / bottom). A bar pair is moved when either of its bars touches a band; a strike no chip covers is
 * left where it is. The bars' order is unchanged, so labels are placed afterwards on the moved bars.
 */
export function oiBarsBelowChips(bars: OiBar[], chips: { top: number; bottom: number }[], gap = 2): OiBar[] {
  if (!chips.length || !bars.length) return bars;
  const bands = [...chips].sort((a, b) => a.top - b.top);
  const byStrike = new Map<number, OiBar[]>();
  for (const b of bars) byStrike.set(b.strike, [...(byStrike.get(b.strike) ?? []), b]);
  const moved = new Map<OiBar, OiBar>();
  for (const pair of byStrike.values()) {
    const top = Math.min(...pair.map(b => b.y));
    const bottom = Math.max(...pair.map(b => b.y + b.h));
    const hit = bands.find(c => top < c.bottom && bottom > c.top);
    if (!hit) continue;
    // Several chips stacked one under another (pushed apart 26 px): go below the whole run, not into the next chip.
    let below = hit.bottom;
    for (const c of bands) if (c.top <= below + gap && c.bottom > below) below = c.bottom;
    let y = below + gap;
    for (const b of [...pair].sort((a, c) => (a.side === 'CE' ? 0 : 1) - (c.side === 'CE' ? 0 : 1))) {
      moved.set(b, { ...b, y });
      y += b.h;
    }
  }
  return moved.size ? bars.map(b => moved.get(b) ?? b) : bars;
}

/**
 * Which bars get a text label so that no two labels overlap. A label sits just left of its bar, vertically centred on it,
 * `lineH` px tall and `widthOf(bar)` px wide. Priority: the highlighted largest Call / Put first, then by |OI| (the walls
 * a trader reads first); a label that would touch one already placed is dropped. Bars thinner than `minH` get none
 * (text would sit on the neighbouring bar). Returns the indexes of the labelled bars.
 */
export function placeOiLabels(bars: OiBar[], widthOf: (b: OiBar) => number, lineH = 11, minH = 4, pad = 3): Set<number> {
  const order = bars.map((b, i) => i).filter(i => bars[i].h >= minH)
    .sort((a, b) => (Number(bars[b].max) - Number(bars[a].max)) || (Math.abs(bars[b].oi) - Math.abs(bars[a].oi)));
  const placed: { l: number; r: number; t: number; b: number }[] = [];
  const out = new Set<number>();
  for (const i of order) {
    const bar = bars[i];
    const w = widthOf(bar);
    const cy = bar.y + bar.h / 2;
    const rect = { l: bar.x - pad - w, r: bar.x - pad, t: cy - lineH / 2, b: cy + lineH / 2 };
    if (placed.some(p => rect.l < p.r && rect.r > p.l && rect.t < p.b && rect.b > p.t)) continue;
    placed.push(rect);
    out.add(i);
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

/** Compact signed OI change: +1.20L / -45.0K / 0. */
export function fmtOIChange(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '-'}${fmtOI(Math.abs(n)).replace(' ', '')}`;
}
