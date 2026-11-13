/**
 * Fresh Money Board — pure engine (no I/O).
 *
 * Input: the IV snapshot collector's CSV (debug/iv_snapshots_<U>_<date>.csv, one row per strike every ~30 s,
 * with cumulative-for-the-day OI, change_OI vs previous close, and volume per side). The board shows per strike the
 * total OI, today's OI change and the call − put OI difference, plus a buildup tag from the option's own premium.
 */

export interface SideSnap {
  oi: number | null;
  chg: number | null;
  vol: number | null;
  /** Option last price (absent in hand-built snapshots = unknown). */
  ltp?: number | null;
}

export interface Snapshot {
  ts: string;          // "YYYY-MM-DD HH:MM:SS" (IST)
  min: number;         // minutes since midnight, fractional
  spot: number | null;
  expiry: string;
  strikes: Map<number, { ce: SideSnap; pe: SideSnap }>;
}

/** `oi` = total open interest now; `oiMoved` = its change vs the previous close; `buildup` = what that move means. */
export interface BoardSide { oi: number | null; oiMoved: number | null; vol: number | null; buildup: Buildup | null }

/**
 * OI buildup of one option (one side of one strike), the repo's standard four quadrants (OptionsBuildupTab's
 * classifyBuildup, dhan-oi-analytics): sign of today's OI change x sign of the OPTION's own price change vs its previous
 * close. An unchanged price counts as up, like that classifier. Null when OI did not change or a price is unknown.
 */
export type Buildup = 'LB' | 'SB' | 'SC' | 'LU';

export function buildupOf(oiChg: number | null, ltp: number | null | undefined, prevClose: number | null | undefined): Buildup | null {
  if (oiChg === null || !Number.isFinite(oiChg) || oiChg === 0) return null;
  if (ltp == null || !(ltp > 0) || prevClose == null || !(prevClose > 0)) return null;
  const up = ltp - prevClose >= 0;
  if (oiChg > 0) return up ? 'LB' : 'SB';
  return up ? 'SC' : 'LU';
}

export const BUILDUP_TEXT: Record<Buildup, { name: string; meaning: string }> = {
  LB: { name: 'Long buildup', meaning: 'OI up, premium up: buyers adding' },
  SB: { name: 'Short buildup', meaning: 'OI up, premium down: writers adding' },
  SC: { name: 'Short covering', meaning: 'OI down, premium up: writers exiting' },
  LU: { name: 'Long unwinding', meaning: 'OI down, premium down: buyers exiting' },
};

/** Previous closes of the options on the board, by strike (from the collector's _prev_close.json side file). */
export interface PrevCloses { ce: Record<string, number>; pe: Record<string, number> }

export interface BoardRow { strike: number; put: BoardSide | null; call: BoardSide | null }

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
    ceOi: ix('CE_OI'), ceChg: ix('CE_change_OI'), ceVol: ix('CE_volume'), ceLtp: ix('CE_LTP'),
    peOi: ix('PE_OI'), peChg: ix('PE_change_OI'), peVol: ix('PE_volume'), peLtp: ix('PE_LTP'),
  };
  if (I.ts < 0 || I.k < 0) return [];
  const byTs = new Map<string, Snapshot>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const c = line.split(',');
    // A row the collector is still writing (one snapshot is ~10 KB, more than one write()) can be cut short: a cut
    // inside CE_OI would read 11265020 as 112. Skip any row with fewer fields than the header.
    if (c.length < head.length) continue;
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
      ce: { oi: num(c[I.ceOi]), chg: num(c[I.ceChg]), vol: num(c[I.ceVol]), ltp: I.ceLtp >= 0 ? num(c[I.ceLtp]) : null },
      pe: { oi: num(c[I.peOi]), chg: num(c[I.peChg]), vol: num(c[I.peVol]), ltp: I.peLtp >= 0 ? num(c[I.peLtp]) : null },
    });
  }
  return [...byTs.values()].sort((a, b) => a.min - b.min);
}

/** The expiry the latest snapshot belongs to (the collector can switch expiry across days, rarely within one). */
export function latestExpiry(snaps: Snapshot[]): string {
  return snaps.length ? snaps[snaps.length - 1].expiry : '';
}

function sideRow(s: SideSnap | undefined, prevClose?: number): BoardSide | null {
  if (!s) return null;
  return { oi: s.oi, oiMoved: s.chg, vol: s.vol, buildup: buildupOf(s.chg, s.ltp, prevClose) };
}

/**
 * True when volume is the day's running total, as the IV snapshot collector writes it. Backfilled files
 * (build_oi_snapshots.py from 1-minute candles) carry per-candle volume, which goes up and down from row to
 * row and makes the day's volume meaningless. Such a day is neither shown nor traded from.
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

/** Infer the strike step from the strikes on the board (smallest positive gap). */
export function strikeStep(strikes: number[]): number {
  const s = [...new Set(strikes)].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) step = Math.min(step, s[i] - s[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 50;
}

/** Board rows on a fixed ATM±wings grid, highest strike first. Strikes the snapshot lacks get null sides. */
export function buildBoardRows(snap: Snapshot, wings = 12, prevClose: PrevCloses | null = null): BoardRow[] {
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
    rows.push({ strike: k, put: sideRow(s?.pe, prevClose?.pe[String(k)]), call: sideRow(s?.ce, prevClose?.ce[String(k)]) });
  }
  return rows;
}

/** Call total OI minus put total OI at one strike (+ = calls heavier, - = puts heavier); null when a side is unknown. */
export function oiDelta(r: { call: { oi: number | null } | null; put: { oi: number | null } | null }): number | null {
  const c = r.call?.oi, p = r.put?.oi;
  return c == null || p == null || !Number.isFinite(c) || !Number.isFinite(p) ? null : c - p;
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

/** Unsigned OI (a total, not a change): 8,371 below a lakh, 1.9L / 1.2Cr above. */
export function fmtOiAbs(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e7) return `${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(a / 1e5).toFixed(1)}L`;
  return Math.round(a).toLocaleString('en-IN');
}

// ── OI flow in fixed session slots (the "3m slots" tab) ───────────────────────────────────────────────────────────

/** One side of one strike: OI change in each completed slot (oldest first), then the running slot so far (last
 *  entry), and the total from the oldest shown slot's start to the latest snapshot. Null = not known. */
export interface SideFlow { cells: (number | null)[]; total: number | null }

export interface OiFlow {
  /** Slot length, minutes. */
  slotMin: number;
  /** Slot boundaries as minutes of the day, oldest first: `slots + 1` entries, the last one = the running slot's start. */
  bounds: number[];
  /** Per boundary: an OI reading was available there (false = collector gap / before the session). */
  boundOk: boolean[];
  /** "HH:MM:SS" of the latest snapshot: the running slot's "so far". */
  lastTs: string;
  byStrike: Map<number, { ce: SideFlow; pe: SideFlow }>;
}

export interface OiFlowOpts {
  /** Completed slots shown before the running one. */
  slots?: number;
  slotMin?: number;
  /** Session open, minutes of the day (09:15 NSE, 09:00 MCX): slots are counted from here. */
  anchorMin: number;
  /** A boundary reads the latest snapshot at or before it, no more than this many minutes earlier. */
  slackMin?: number;
}

/**
 * OI change per strike in fixed slots counted from the session open (09:15, 09:18, 09:21 … for 3 min), so a completed
 * slot never changes; the last cell is the current slot so far and freezes when the slot ends.
 *
 * OI at a boundary = the latest snapshot at or before it, accepted only within `slackMin` (a collector gap is not a
 * reading) and on the last snapshot's expiry. The open boundary needs no snapshot: OI at the open is the previous
 * close's OI, i.e. a snapshot's OI minus its change vs the previous close (the day's first snapshot is used). A missing
 * OI is never read as 0. The total is end to end when both ends are known, else the sum of the cells when all are known.
 */
export function oiFlow(snaps: Snapshot[], opts: OiFlowOpts): OiFlow {
  const slots = opts.slots ?? 5, slotMin = opts.slotMin ?? 3, slack = opts.slackMin ?? 1, anchor = opts.anchorMin;
  const byStrike = new Map<number, { ce: SideFlow; pe: SideFlow }>();
  const last = snaps[snaps.length - 1];
  const cur = last ? anchor + Math.max(0, Math.floor((last.min - anchor + 1e-9) / slotMin)) * slotMin : anchor;
  const bounds = Array.from({ length: slots + 1 }, (_, i) => cur - (slots - i) * slotMin);   // oldest first
  if (!last) return { slotMin, bounds, boundOk: bounds.map(() => false), lastTs: '', byStrike };

  // Each boundary resolves to a snapshot, to 'open' (previous-close OI), or to nothing.
  const first = snaps.find(s => s.expiry === last.expiry) ?? null;
  type Ref = Snapshot | 'open' | null;
  const refs: Ref[] = bounds.map(b => {
    if (b < anchor - 1e-9) return null;                      // before the session
    let j = snaps.length - 1;
    while (j >= 0 && snaps[j].min > b + 1e-9) j--;
    const s = j >= 0 ? snaps[j] : null;
    if (s && b - s.min <= slack && s.expiry === last.expiry) return s;
    return Math.abs(b - anchor) < 1e-9 && first ? 'open' : null;
  });
  const oiAt = (r: Ref, k: number, side: 'ce' | 'pe'): number | null => {
    if (r === null) return null;
    const sd = (r === 'open' ? first! : r).strikes.get(k)?.[side];
    if (!sd || sd.oi == null || !Number.isFinite(sd.oi)) return null;
    if (r !== 'open') return sd.oi;
    return sd.chg == null || !Number.isFinite(sd.chg) ? null : sd.oi - sd.chg;
  };
  const sideFlow = (k: number, side: 'ce' | 'pe'): SideFlow => {
    const at = refs.map(r => oiAt(r, k, side));
    const now = oiAt(last, k, side);
    const cells: (number | null)[] = [];
    for (let i = 0; i < slots; i++) cells.push(at[i] === null || at[i + 1] === null ? null : at[i + 1]! - at[i]!);
    cells.push(now === null || at[slots] === null ? null : now - at[slots]!);   // running slot so far
    const total = now !== null && at[0] !== null ? now - at[0]
      : cells.every(c => c !== null) ? cells.reduce<number>((t, c) => t + (c as number), 0) : null;
    return { cells, total };
  };
  for (const k of last.strikes.keys()) byStrike.set(k, { ce: sideFlow(k, 'ce'), pe: sideFlow(k, 'pe') });
  return { slotMin, bounds, boundOk: refs.map(r => r !== null), lastTs: last.ts.slice(11, 19), byStrike };
}

/** Minutes of the day → "HH:MM". */
export function fmtMinOfDay(m: number): string {
  const r = Math.round(m);
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
}

/** Compact signed OI for narrow cells: +950, +84k, -1.2L, +1.1Cr; 0 unsigned; '–' when unknown. */
export function fmtOiShort(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  const r = Math.round(n);
  if (r === 0) return '0';
  const sign = r > 0 ? '+' : '-';
  const a = Math.abs(r);
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}k`;
  return `${sign}${a}`;
}
