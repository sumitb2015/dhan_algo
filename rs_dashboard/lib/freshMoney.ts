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
 *  entry); and `day` = the strike's OI change vs the previous close as of `OiFlow.dayAt` (the latest COMPLETED slot
 *  edge that has a reading), so each slot that completes adds exactly its cell to it. Null = not known. */
export interface SideFlow { cells: (number | null)[]; day: number | null }

export interface OiFlow {
  /** Slot length, minutes. */
  slotMin: number;
  /** Slot boundaries as minutes of the day, oldest first: `slots + 1` entries, the last one = the running slot's start. */
  bounds: number[];
  /** Per boundary: an OI reading was available there (false = collector gap / before the session). */
  boundOk: boolean[];
  /** "HH:MM:SS" of the latest snapshot: the running slot's "so far". */
  lastTs: string;
  /** The slot edge (minutes of the day) every `day` is read at: the latest completed edge with a reading, or an earlier
   *  one when a collector gap (e.g. a restart) left that edge empty; null when no shown edge has a reading. */
  dayAt: number | null;
  /** The session is over: `bounds` end AT the close, every cell is a completed slot and there is no running one (so
   *  `bounds` has one more entry than the cells' slot count + 1 would suggest: cells = bounds.length − 1). */
  closed: boolean;
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
  /** Set once the session is over (minute of the day of the close): the slots stop at the close — `slots + 1` completed
   *  slots ending there, no running one — so OI the chain moves after the bell never shows as a slot or in `day`. */
  endMin?: number;
}

/**
 * OI change per strike in fixed slots counted from the session open (09:15, 09:18, 09:21 … for 3 min), so a completed
 * slot never changes; the last cell is the current slot so far and freezes when the slot ends.
 *
 * OI at a boundary = the latest snapshot at or before it, accepted only within `slackMin` (a collector gap is not a
 * reading) and on the last snapshot's expiry. The open boundary needs no snapshot: OI at the open is the previous
 * close's OI, i.e. a snapshot's OI minus its change vs the previous close (the day's first snapshot is used). A missing
 * OI is never read as 0. `day` is the snapshot's own change vs the previous close (0 at the open edge) at `dayAt`, so
 * day(next edge) − day(this edge) = the completed slot's cell. A gap at the latest edge falls back to the newest earlier
 * edge with a reading (labelled by `dayAt`) instead of blanking every strike's number until the next slot completes.
 */
export function oiFlow(snaps: Snapshot[], opts: OiFlowOpts): OiFlow {
  const slots = opts.slots ?? 5, slotMin = opts.slotMin ?? 3, slack = opts.slackMin ?? 1, anchor = opts.anchorMin;
  const byStrike = new Map<number, { ce: SideFlow; pe: SideFlow }>();
  const last = snaps[snaps.length - 1];
  const end = opts.endMin;
  const closed = end !== undefined && !!last;
  let bounds: number[];
  if (closed) {
    // Completed slots up to the close; a close off the slot grid (MCX 23:55) ends with one short slot.
    const lastEdge = anchor + Math.max(0, Math.floor((end - anchor + 1e-9) / slotMin)) * slotMin;
    const onGrid = Math.abs(lastEdge - end) < 1e-9;
    const k = onGrid ? slots + 1 : slots;
    bounds = Array.from({ length: k + 1 }, (_, i) => lastEdge - (k - i) * slotMin);
    if (!onGrid) bounds.push(end);
  } else {
    const cur = last ? anchor + Math.max(0, Math.floor((last.min - anchor + 1e-9) / slotMin)) * slotMin : anchor;
    bounds = Array.from({ length: slots + 1 }, (_, i) => cur - (slots - i) * slotMin);   // oldest first
  }
  if (!last) return { slotMin, bounds, boundOk: bounds.map(() => false), lastTs: '', dayAt: null, closed: false, byStrike };
  const top = bounds.length - 1;   // index of the newest edge

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
  // The edge today's change is read at: the latest completed edge with a reading (one global choice for every strike).
  let dayIdx = -1;
  for (let i = top; i >= 0; i--) if (refs[i] !== null) { dayIdx = i; break; }
  const sideFlow = (k: number, side: 'ce' | 'pe'): SideFlow => {
    const at = refs.map(r => oiAt(r, k, side));
    const cells: (number | null)[] = [];
    for (let i = 0; i < top; i++) cells.push(at[i] === null || at[i + 1] === null ? null : at[i + 1]! - at[i]!);
    if (!closed) {   // running slot so far
      const now = oiAt(last, k, side);
      cells.push(now === null || at[top] === null ? null : now - at[top]!);
    }
    // Today's change at that edge: the snapshot's own change vs the previous close (never assumed 0).
    const edge = dayIdx >= 0 ? refs[dayIdx] : null;
    let day: number | null = null;
    if (edge === 'open') day = at[dayIdx] === null ? null : 0;
    else if (edge) { const c = edge.strikes.get(k)?.[side].chg; day = c == null || !Number.isFinite(c) ? null : c; }
    return { cells, day };
  };
  for (const k of last.strikes.keys()) byStrike.set(k, { ce: sideFlow(k, 'ce'), pe: sideFlow(k, 'pe') });
  return {
    slotMin, bounds, boundOk: refs.map(r => r !== null), lastTs: last.ts.slice(11, 19),
    dayAt: dayIdx >= 0 ? bounds[dayIdx] : null, closed, byStrike,
  };
}

export type FlowTier = 'none' | 'low' | 'mid' | 'high';

/** Board-wide scale for the slot cells: the 95th percentile of |v| over every known cell (not the max: one of Dhan's
 *  one-minute OI dips would otherwise set the scale and wash every other cell out). 0 when there are none. */
export function flowScale(values: (number | null)[]): number {
  const a = values.filter((v): v is number => v !== null && Number.isFinite(v)).map(Math.abs).sort((x, y) => x - y);
  if (!a.length) return 0;
  const pos = (a.length - 1) * 0.95, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** Tint tier of one cell against the board scale: under 10 % = none (shown grey), then <35 %, <70 %, >=70 %. */
export function flowTier(v: number | null, scale: number): FlowTier {
  if (v === null || !Number.isFinite(v) || !(scale > 0)) return 'none';
  const r = Math.abs(v) / scale;
  return r < 0.1 ? 'none' : r < 0.35 ? 'low' : r < 0.7 ? 'mid' : 'high';
}

/** Run of the most recent COMPLETED slots (the first `slots` cells; the running one after them is ignored) moving the
 *  same way, newest backwards. Null, a sign change, or a move the tint calls noise (`flowTier(v, scale) === 'none'`,
 *  under 10 % of the board scale, which includes 0) ends it, so a badge never sits on grey cells. Null when the run is
 *  shorter than `min`. */
export function flowStreak(cells: (number | null)[], slots: number, scale: number, min = 3): { dir: 1 | -1; n: number } | null {
  let dir: 1 | -1 | 0 = 0, n = 0;
  for (let i = Math.min(slots, cells.length) - 1; i >= 0; i--) {
    const v = cells[i];
    const sg = v === null || flowTier(v, scale) === 'none' ? 0 : v > 0 ? 1 : -1;
    if (sg === 0 || (dir !== 0 && sg !== dir)) break;
    dir = sg; n++;
  }
  return dir !== 0 && n >= min ? { dir, n } : null;
}

/** Board totals for one side: per slot the sum over the strikes on the board, plus how many strikes fed it. */
export interface SumFlow extends SideFlow {
  /** Per slot (and for `day`): how many strikes had a value. */
  counts: number[];
  dayCount: number;
  /** Strikes that have any reading at all (a strike the collector never recorded is not counted). */
  n: number;
}

/** Board totals: per slot index the sum over strikes. A slot (or `day`) only gets a total when EVERY strike with data
 *  has a value there; otherwise it is null and `counts` says how many did. A partial sum would add fewer strikes than its
 *  neighbours and show a step that looks like a move (e.g. after a collector restart re-centres its strike band). */
export function sumFlows(flows: (SideFlow | null)[], cellsLen: number): SumFlow {
  const known = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
  const live = flows.filter((f): f is SideFlow => !!f && (f.cells.some(known) || known(f.day)));
  const n = live.length;
  const counts: number[] = [];
  const cells: (number | null)[] = Array.from({ length: cellsLen }, (_, i) => {
    let t = 0, c = 0;
    for (const f of live) { const v = f.cells[i]; if (known(v)) { t += v; c++; } }
    counts.push(c);
    return c > 0 && c === n ? t : null;
  });
  let day = 0, dayCount = 0;
  for (const f of live) if (known(f.day)) { day += f.day; dayCount++; }
  return { cells, day: dayCount > 0 && dayCount === n ? day : null, counts, dayCount, n };
}

/** A streak against today's net change (e.g. ▼3 beside +14,052: built all day, now unwinding) is a possible turn;
 *  'with' when they agree; null without a streak or a non-zero day. */
export function streakVsDay(st: { dir: 1 | -1 } | null, day: number | null): 'with' | 'against' | null {
  if (!st || day === null || !Number.isFinite(day) || Math.round(day) === 0) return null;
  return Math.sign(day) === st.dir ? 'with' : 'against';
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
