/**
 * Fresh Money Board — pure engine (no I/O).
 *
 * Input: the IV snapshot collector's CSV (debug/iv_snapshots_<U>_<date>.csv, one row per strike every ~30 s,
 * with cumulative-for-the-day OI, change_OI vs previous close, and volume per side).
 *
 * "Fresh" share = |OI change| / volume: the part of the traded volume that opened or closed positions rather than
 * just passing contracts between holders. Every trade moves OI by at most its own size, so it lies in 0..1.
 *
 *  - Per strike:   |change_OI| / volume_today            (latest snapshot)
 *  - Board:        Σ|change_OI| / Σvolume over the board  (puts and calls separately)
 *  - Rolling 5 min: Σ_k |OI_k(t) − OI_k(t−5m)| / Σ_k (vol_k(t) − vol_k(t−5m)) over strikes present in both snapshots
 *  - Normal:       p10–p90 of the same number across previous days (board: at the same time of day;
 *                  band: per minute of the day)
 */

export interface SideSnap {
  oi: number | null;
  chg: number | null;
  vol: number | null;
}

export interface Snapshot {
  ts: string;          // "YYYY-MM-DD HH:MM:SS" (IST)
  min: number;         // minutes since midnight, fractional
  spot: number | null;
  expiry: string;
  strikes: Map<number, { ce: SideSnap; pe: SideSnap }>;
}

export interface SidePair { puts: number | null; calls: number | null }

export interface SeriesPoint { m: number; puts: number | null; calls: number | null }

export interface BandPoint { m: number; putLo: number; putHi: number; callLo: number; callHi: number }

export interface Range { lo: number; hi: number }

export interface BoardSide { oiMoved: number | null; vol: number | null; fresh: number | null }

export interface BoardRow { strike: number; put: BoardSide | null; call: BoardSide | null }

export interface DaySummary {
  series: SeriesPoint[];                 // rolling 5-min fresh share, one point per minute
  boardByMinute: Map<number, SidePair>;  // board fresh share, last snapshot of each minute
}

export const ROLL_MINUTES = 5;
/** A 5-min lookback that finds no snapshot within this many extra minutes is a collector gap, not a reading. */
const ROLL_SLACK_MINUTES = 2;

function num(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse the collector CSV into snapshots ordered by time. Rows of another expiry than `expiry` are dropped
 *  when it is given; otherwise each snapshot keeps the expiry of its own rows (first one seen). */
export function parseSnapshotCsv(text: string, expiry?: string): Snapshot[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  const ix = (name: string) => head.indexOf(name);
  const I = {
    ts: ix('timestamp'), spot: ix('spot'), exp: ix('expiry'), k: ix('strike'),
    ceOi: ix('CE_OI'), ceChg: ix('CE_change_OI'), ceVol: ix('CE_volume'),
    peOi: ix('PE_OI'), peChg: ix('PE_change_OI'), peVol: ix('PE_volume'),
  };
  if (I.ts < 0 || I.k < 0) return [];
  const byTs = new Map<string, Snapshot>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    const ts = c[I.ts];
    const strike = num(c[I.k]);
    if (!ts || strike === null) continue;
    const exp = I.exp >= 0 ? c[I.exp] : '';
    if (expiry && exp !== expiry) continue;
    let snap = byTs.get(ts);
    if (!snap) {
      const t = ts.split(' ')[1] ?? '';
      const [h, m, s] = t.split(':').map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      snap = { ts, min: h * 60 + m + (Number.isFinite(s) ? s / 60 : 0), spot: num(c[I.spot]), expiry: exp, strikes: new Map() };
      byTs.set(ts, snap);
    }
    if (snap.expiry !== exp) continue;
    snap.strikes.set(strike, {
      ce: { oi: num(c[I.ceOi]), chg: num(c[I.ceChg]), vol: num(c[I.ceVol]) },
      pe: { oi: num(c[I.peOi]), chg: num(c[I.peChg]), vol: num(c[I.peVol]) },
    });
  }
  return [...byTs.values()].sort((a, b) => a.min - b.min);
}

/** The expiry the latest snapshot belongs to (the collector can switch expiry across days, rarely within one). */
export function latestExpiry(snaps: Snapshot[]): string {
  return snaps.length ? snaps[snaps.length - 1].expiry : '';
}

function sideFresh(s: SideSnap | undefined): BoardSide | null {
  if (!s) return null;
  const fresh = s.chg !== null && s.vol !== null && s.vol > 0 ? Math.abs(s.chg) / s.vol : null;
  return { oiMoved: s.chg, vol: s.vol, fresh };
}

/** Board-level fresh share of one snapshot: Σ|chg| / Σvol per side, over strikes that report both. */
export function boardFresh(snap: Snapshot): SidePair {
  let pAbs = 0, pVol = 0, cAbs = 0, cVol = 0;
  for (const { ce, pe } of snap.strikes.values()) {
    if (pe.chg !== null && pe.vol !== null && pe.vol > 0) { pAbs += Math.abs(pe.chg); pVol += pe.vol; }
    if (ce.chg !== null && ce.vol !== null && ce.vol > 0) { cAbs += Math.abs(ce.chg); cVol += ce.vol; }
  }
  return { puts: pVol > 0 ? pAbs / pVol : null, calls: cVol > 0 ? cAbs / cVol : null };
}

/** Rolling-window fresh share between two snapshots, over strikes present in both. A strike whose cumulative
 *  volume went backwards (feed reset) is skipped rather than allowed to cancel other strikes' volume. */
export function windowFresh(prev: Snapshot, cur: Snapshot): SidePair {
  let pAbs = 0, pVol = 0, cAbs = 0, cVol = 0;
  for (const [k, now] of cur.strikes) {
    const was = prev.strikes.get(k);
    if (!was) continue;
    const acc = (a: SideSnap, b: SideSnap): [number, number] | null => {
      if (a.oi === null || b.oi === null || a.vol === null || b.vol === null) return null;
      const dv = b.vol - a.vol;
      if (dv < 0) return null;
      return [Math.abs(b.oi - a.oi), dv];
    };
    const p = acc(was.pe, now.pe);
    if (p) { pAbs += p[0]; pVol += p[1]; }
    const c = acc(was.ce, now.ce);
    if (c) { cAbs += c[0]; cVol += c[1]; }
  }
  return { puts: pVol > 0 ? pAbs / pVol : null, calls: cVol > 0 ? cAbs / cVol : null };
}

/**
 * True when volume is the day's running total, as the IV snapshot collector writes it. Backfilled files
 * (build_oi_snapshots.py from 1-minute candles) carry per-candle volume, which goes up and down from row to
 * row and makes |ΔOI| / volume meaningless (well above 100%). Such a day must not feed the normal band.
 */
export function hasCumulativeVolume(snaps: Snapshot[]): boolean {
  let pairs = 0, drops = 0;
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    for (const [k, now] of snaps[i].strikes) {
      const was = prev.strikes.get(k);
      if (!was) continue;
      for (const [a, b] of [[was.ce.vol, now.ce.vol], [was.pe.vol, now.pe.vol]] as const) {
        if (a === null || b === null) continue;
        pairs++;
        if (b < a) drops++;
      }
    }
  }
  return pairs === 0 || drops / pairs < 0.05;
}

/** A share above 100% cannot happen (a trade moves OI by at most its own size): it is a data fault. */
function sane(p: SidePair): SidePair {
  return {
    puts: p.puts !== null && p.puts <= 1 ? p.puts : null,
    calls: p.calls !== null && p.calls <= 1 ? p.calls : null,
  };
}

/** One day's rolling series (one point per minute, the minute's last snapshot) and board-by-minute map. */
export function summarizeDay(snaps: Snapshot[]): DaySummary {
  const series = new Map<number, SeriesPoint>();
  const boardByMinute = new Map<number, SidePair>();
  let j = 0;
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i];
    const minute = Math.floor(cur.min);
    boardByMinute.set(minute, sane(boardFresh(cur)));
    const target = cur.min - ROLL_MINUTES;
    // Advance j to the latest snapshot at or before target.
    while (j + 1 < i && snaps[j + 1].min <= target) j++;
    const prev = snaps[j];
    if (j >= i || prev.min > target || target - prev.min > ROLL_SLACK_MINUTES) continue;
    if (prev.expiry !== cur.expiry) continue;
    const w = sane(windowFresh(prev, cur));
    series.set(minute, { m: minute, puts: w.puts, calls: w.calls });
  }
  return { series: [...series.values()].sort((a, b) => a.m - b.m), boardByMinute };
}

/** Linear-interpolated percentile of an unsorted list (p in 0..1). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Value of a by-minute map at `minute`, or the latest earlier minute (a day's board "as of" that time). */
function asOf(map: Map<number, SidePair>, minute: number): SidePair | null {
  for (let m = minute; m >= minute - 30; m--) {
    const v = map.get(m);
    if (v) return v;
  }
  return null;
}

export const MIN_HISTORY_DAYS = 5;

/** p10–p90 of previous days' board fresh share as of the same time of day. Null when too few days. */
export function normalAt(history: DaySummary[], minute: number): { puts: Range | null; calls: Range | null } {
  const p: number[] = [], c: number[] = [];
  for (const d of history) {
    const v = asOf(d.boardByMinute, minute);
    if (v?.puts != null) p.push(v.puts);
    if (v?.calls != null) c.push(v.calls);
  }
  const range = (xs: number[]): Range | null =>
    xs.length >= MIN_HISTORY_DAYS ? { lo: percentile(xs, 0.1), hi: percentile(xs, 0.9) } : null;
  return { puts: range(p), calls: range(c) };
}

/** Per-minute p10–p90 of the rolling series across previous days, smoothed with a centred 5-minute mean. */
export function bandFromHistory(history: DaySummary[], fromMin = 9 * 60 + 15, toMin = 15 * 60 + 30): BandPoint[] {
  const idx = history.map(d => new Map(d.series.map(p => [p.m, p] as const)));
  const raw: (BandPoint | null)[] = [];
  for (let m = fromMin; m <= toMin; m++) {
    const p: number[] = [], c: number[] = [];
    for (const map of idx) {
      const v = map.get(m) ?? map.get(m - 1) ?? map.get(m + 1);
      if (v?.puts != null) p.push(v.puts);
      if (v?.calls != null) c.push(v.calls);
    }
    if (p.length < MIN_HISTORY_DAYS || c.length < MIN_HISTORY_DAYS) { raw.push(null); continue; }
    raw.push({ m, putLo: percentile(p, 0.1), putHi: percentile(p, 0.9), callLo: percentile(c, 0.1), callHi: percentile(c, 0.9) });
  }
  const out: BandPoint[] = [];
  const W = 2;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r) continue;
    const win = raw.slice(Math.max(0, i - W), i + W + 1).filter((x): x is BandPoint => x !== null);
    const mean = (k: keyof Omit<BandPoint, 'm'>) => win.reduce((a, x) => a + x[k], 0) / win.length;
    out.push({ m: r.m, putLo: mean('putLo'), putHi: mean('putHi'), callLo: mean('callLo'), callHi: mean('callHi') });
  }
  return out;
}

/** Infer the strike step from the strikes on the board (smallest positive gap). */
export function strikeStep(strikes: number[]): number {
  const s = [...new Set(strikes)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) step = Math.min(step, s[i] - s[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

/** Board rows on a fixed ATM±wings grid, highest strike first. Strikes the snapshot lacks get null sides. */
export function buildBoardRows(snap: Snapshot, wings = 12): BoardRow[] {
  const strikes = [...snap.strikes.keys()];
  if (!strikes.length) return [];
  const step = strikeStep(strikes);
  const spot = snap.spot ?? strikes[Math.floor(strikes.length / 2)];
  const atm = Math.round(spot / step) * step;
  // The collector's own window was centred where spot stood when it wrote; keep at most two empty strikes
  // beyond what it actually collected so a drifted window does not leave a stack of blank rows.
  const hiK = Math.min(atm + wings * step, Math.max(...strikes) + 2 * step);
  const loK = Math.max(atm - wings * step, Math.min(...strikes) - 2 * step);
  const rows: BoardRow[] = [];
  for (let k = hiK; k >= loK; k -= step) {
    const s = snap.strikes.get(k);
    rows.push({ strike: k, put: sideFresh(s?.pe), call: sideFresh(s?.ce) });
  }
  return rows;
}

export type Intensity = 'low' | 'mid' | 'high';

/** Below / inside / above the side's normal range. Without a range every bar is 'mid'. */
export function intensity(fresh: number | null, range: Range | null): Intensity {
  if (fresh === null || !range) return 'mid';
  if (fresh < range.lo) return 'low';
  if (fresh > range.hi) return 'high';
  return 'mid';
}

/** Signed OI in the screenshot's style: +83,718 below a lakh, +1.9L / +1.2Cr above. */
export function fmtOi(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(1)}L`;
  return `${sign}${Math.round(a).toLocaleString('en-IN')}`;
}

export function fmtPct(f: number | null): string {
  return f === null || !Number.isFinite(f) ? '–' : `${Math.round(f * 100)}%`;
}
