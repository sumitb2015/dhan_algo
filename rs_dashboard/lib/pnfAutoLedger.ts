// The P&F AUTO ledger: every position the AUTO engine opened, owned by the ledger (not read off the broker's netted book).
// Pure: ops in, new state out; the route (app/api/straddle-pnf/auto) serialises them and writes the file atomically.
// Safety properties live here so the browser cannot bypass them: one live row per chart, state moves forward only,
// an unknown order outcome stays unknown until the user resolves it, and every op bumps `rev`.
//
// REAL orders are reserved BEFORE they are sent: an entry is written `entering`, an exit `exiting`. If the tab dies with the
// order on the wire the row stays reserved, so it blocks that chart and asks the user, and is never lost or sent twice.
//   entering → open (confirmEntry) | closed (voidEntry: refused, nothing open) | unknownEntry (markUnknown)
//   open → exiting (beginExit) → closed (close) | open (abortExit: cleanly refused) | unknownExit (markUnknown)
//   unknown* / a stale entering / exiting → open | closed by the user (resolve). PAPER rows open as `open` and close directly.
import { parseTarget, targetKey, type Target } from './pnfTarget.ts';
import type { Market } from './straddlePnfLive.ts';

export type AutoMode = 'PAPER' | 'REAL';
export type AutoRowState = 'entering' | 'open' | 'exiting' | 'closed' | 'unknownEntry' | 'unknownExit';

export interface AutoLeg { label: string; /** The broker's key (Dhan security id / trading symbol), REAL only. */ key: string | null; units: number }

export interface AutoRow {
  id: string;
  /** IST date of the entry. */
  day: string;
  chart: 1 | 2;
  target: Target;
  targetKey: string;
  /** The market the contract trades in, saved at entry: its end-of-day exit time comes from this, not from whatever chart is on screen. */
  market?: Market;
  mode: AutoMode;
  broker: string;
  side: 'BUY' | 'SELL';
  lots: number;
  /** Rupees per point for the whole position (all legs, all lots). */
  unitsPerPoint: number;
  legs: AutoLeg[];
  entryT: number;
  /** Time of the bar whose signal opened it: the reversal is looked for after this. */
  entryBarT: number;
  /** Two-back rows: the protective stop (one brick beyond the pullback); the exit is this level, not a reversal brick. */
  stop?: number;
  /** Supertrend-rule rows: the exit is the Supertrend line flipping against the position (kept on the row so a reload cannot change it). */
  exitBy?: 'supertrend';
  /**
   * PAPER: the confirmed box the signal bar reached (where the trade is booked). REAL: the chart's live price at the decision
   * (an estimate of the market fill).
   */
  entryPrice: number;
  /** The confirmed box the signal reached: where the chart marker sits (REAL books the live price, this is still the box). */
  entryBox?: number;
  /**
   * REAL fills. `entryPrice` / `exitPrice` start as the chart's price at the DECISION; once the broker reports the orders final, the
   * `fillPrice` op replaces them with the broker's average traded price (summed over a straddle's legs), keeps the decision price in
   * `entryDecision` / `exitDecision`, and recomputes `pnl`. The order ids are what lets any open tab do that, after a reload too.
   */
  entryOrderIds?: string[];
  exitOrderIds?: string[];
  entryFilled?: boolean;
  exitFilled?: boolean;
  entryDecision?: number;
  exitDecision?: number;
  state: AutoRowState;
  exitT?: number;
  /** Time of the bar that triggered the exit (the reversal column's first bar), for the chart marker; absent on older rows. */
  exitBarT?: number;
  exitPrice?: number;
  /** The confirmed box the reversal reached (none for an EOD exit): where the exit marker sits. */
  exitBox?: number;
  reason?: string;
  pnl?: number;
  note?: string;
  /** When the REAL entry / exit was reserved (entering / exiting): a reservation much older than an order takes is stale. */
  pendingSince?: number;
}

export interface AutoLogEntry { t: number; chart: 1 | 2; text: string }

/**
 * A chart's AUTO switch as last set by a page (arming is in the browser, but it is SAVED here): a reload, a rebuild or another tab of the
 * same page reads it back and resumes AUTO (lib/pnfAutoArm.ts resumeArm decides when), and a stop in one tab disarms every tab. Before this
 * a reload silently left AUTO off while its open position still exited by its rule - an exit with no re-entry (2026-11-04).
 */
export interface AutoArmRecord {
  mode: AutoMode;
  broker: string;
  /** The chart's contract when it was armed: a different contract on screen is never resumed. */
  targetKey: string;
  /** IST date it was armed: an arm never carries into another day. */
  day: string;
  /** Epoch s of the arming (its identity: a tab follows a different `t` as a new arming). */
  t: number;
  /** The bar time signals had to be newer than when it was armed. */
  watermarkT: number;
  lots: number;
  /** Renko AUTO rule / side filter it was armed with (restored with it; absent on the P&F page). */
  rule?: string;
  side?: string;
}

export interface AutoLedger { rev: number; rows: AutoRow[]; log: AutoLogEntry[]; arms?: Partial<Record<'1' | '2', AutoArmRecord>> }

export const EMPTY_LEDGER: AutoLedger = { rev: 0, rows: [], log: [] };
/** A broker fill further than this from the decision price is refused as a bad read (a leg missing, a wrong scale). */
export const FILL_BAND = 0.2;
const MAX_ROWS = 500;
const MAX_LOG = 200;

/** A row still owning a position at the broker (or possibly owning one): it blocks a new entry on that chart. */
export const isLive = (r: AutoRow) => r.state !== 'closed';

export const rowPnl = (side: 'BUY' | 'SELL', entry: number, exit: number, unitsPerPoint: number) =>
  (side === 'BUY' ? exit - entry : entry - exit) * unitsPerPoint;

export type AutoOp =
  | { op: 'open'; row: Omit<AutoRow, 'state' | 'targetKey'> & { state?: 'open' | 'entering' } }
  | { op: 'confirmEntry'; id: string; legs: AutoLeg[]; orderIds?: string[] }
  | { op: 'voidEntry'; id: string; t: number; note: string }
  | { op: 'beginExit'; id: string; t: number }
  | { op: 'abortExit'; id: string; note: string }
  | { op: 'markUnknown'; id: string; note: string }
  | { op: 'close'; id: string; exitT: number; exitPrice: number; reason: string; note?: string; exitBarT?: number; exitBox?: number; orderIds?: string[] }
  | { op: 'fillPrice'; id: string; which: 'entry' | 'exit'; price: number; /** how many orders were summed: must be one per leg */ legCount: number }
  | { op: 'resolve'; id: string; as: 'open' | 'flat'; exitPrice?: number; t: number }
  | { op: 'log'; chart: 1 | 2; t: number; text: string }
  /** Save (arm) or clear (null) a chart's AUTO switch, with the log line that says why - one op, so the two never disagree. */
  | { op: 'setArm'; chart: 1 | 2; arm: AutoArmRecord | null; t: number; text: string }
  | { op: 'resetPaper' };

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
/** The order ids of an op: non-empty strings only, at most 8; undefined when none. */
const cleanIds = (v: unknown): string[] | undefined => {
  const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, 8) : [];
  return ids.length ? ids : undefined;
};

export function parseLedger(raw: unknown): AutoLedger {
  if (!raw || typeof raw !== 'object') return EMPTY_LEDGER;
  const o = raw as Partial<AutoLedger>;
  const arms: Partial<Record<'1' | '2', AutoArmRecord>> = {};
  if (o.arms && typeof o.arms === 'object') for (const k of ['1', '2'] as const) { const a = armOk((o.arms as Record<string, unknown>)[k]); if (a) arms[k] = a; }
  return { rev: finite(o.rev) ? o.rev! : 0, rows: Array.isArray(o.rows) ? o.rows : [], log: Array.isArray(o.log) ? o.log : [], ...(Object.keys(arms).length ? { arms } : {}) };
}

/** A well-formed arm record, or null (a bad one is dropped: it can only ever mean "not armed"). */
function armOk(v: unknown): AutoArmRecord | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Partial<AutoArmRecord>;
  if (a.mode !== 'PAPER' && a.mode !== 'REAL') return null;
  if (typeof a.broker !== 'string' || !a.broker || typeof a.targetKey !== 'string' || !a.targetKey || typeof a.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.day)) return null;
  if (!finite(a.t) || !finite(a.watermarkT) || !Number.isInteger(a.lots) || a.lots! < 1 || a.lots! > 20) return null;
  const str = (s: unknown) => (typeof s === 'string' && s.length > 0 && s.length <= 20 ? s : undefined);
  const rule = str(a.rule), side = str(a.side);
  return { mode: a.mode, broker: a.broker, targetKey: a.targetKey, day: a.day, t: a.t!, watermarkT: a.watermarkT!, lots: a.lots!, ...(rule ? { rule } : {}), ...(side ? { side } : {}) };
}

/** Apply one op. Returns the new ledger, or an error with an HTTP status (the file is left as it was). */
export function applyAutoOp(led: AutoLedger, op: AutoOp): { ok: true; ledger: AutoLedger } | { ok: false; status: number; error: string } {
  const bump = (rows: AutoRow[], log = led.log, arms = led.arms): { ok: true; ledger: AutoLedger } =>
    ({ ok: true, ledger: { rev: led.rev + 1, rows: rows.slice(-MAX_ROWS), log: log.slice(-MAX_LOG), ...(arms && Object.keys(arms).length ? { arms } : {}) } });
  const find = (id: string) => led.rows.findIndex(r => r.id === id);

  switch (op.op) {
    case 'open': {
      const r = op.row;
      const target = parseTarget(r.target);
      if (!target || target.kind === 'index') return { ok: false, status: 400, error: 'An AUTO row needs a tradable chart target' };
      if (r.chart !== 1 && r.chart !== 2) return { ok: false, status: 400, error: 'chart must be 1 or 2' };
      if (r.side !== 'BUY' && r.side !== 'SELL') return { ok: false, status: 400, error: 'side must be BUY or SELL' };
      if (r.mode !== 'PAPER' && r.mode !== 'REAL') return { ok: false, status: 400, error: 'mode must be PAPER or REAL' };
      if (!Number.isInteger(r.lots) || r.lots < 1 || r.lots > 20) return { ok: false, status: 400, error: 'lots must be 1-20' };
      if (![r.entryT, r.entryBarT, r.entryPrice, r.unitsPerPoint].every(finite) || !r.id) return { ok: false, status: 400, error: 'Invalid row' };
      if (r.stop !== undefined && (!finite(r.stop) || (r.side === 'BUY' ? r.stop >= r.entryPrice : r.stop <= r.entryPrice))) return { ok: false, status: 400, error: 'stop must be beyond the entry, on the losing side' };
      if (r.exitBy !== undefined && r.exitBy !== 'supertrend') return { ok: false, status: 400, error: 'Invalid exitBy' };
      if (r.market !== undefined && !(['NSE', 'NSE_CAS', 'NSE_FNO', 'MCX'] as const).includes(r.market)) return { ok: false, status: 400, error: 'Invalid market' };
      if (led.rows.some(x => x.id === r.id)) return { ok: false, status: 409, error: 'Row already exists' };
      const live = led.rows.find(x => x.chart === r.chart && isLive(x));
      if (live) return { ok: false, status: 409, error: `Chart ${r.chart} already holds an AUTO position (${live.state})` };
      if (r.mode === 'REAL' && r.state !== 'entering') return { ok: false, status: 400, error: 'A REAL row is reserved as entering before its order is sent' };
      return bump([...led.rows, { ...r, target, targetKey: targetKey(target), state: r.mode === 'REAL' ? 'entering' : 'open', pendingSince: r.mode === 'REAL' ? r.entryT : undefined }]);
    }
    case 'confirmEntry':
    case 'voidEntry':
    case 'beginExit':
    case 'abortExit':
    case 'markUnknown': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      const need: Record<string, AutoRowState[]> = {
        confirmEntry: ['entering'], voidEntry: ['entering'], beginExit: ['open'], abortExit: ['exiting'], markUnknown: ['entering', 'exiting'],
      };
      if (!need[op.op].includes(r.state)) return { ok: false, status: 409, error: `Row is ${r.state}` };
      const rows = [...led.rows];
      if (op.op === 'confirmEntry') {
        if (!Array.isArray(op.legs) || !op.legs.length || !op.legs.every(l => Number.isInteger(l.units) && l.units > 0)) return { ok: false, status: 400, error: 'Invalid legs' };
        rows[i] = { ...r, state: 'open', legs: op.legs, ...(cleanIds(op.orderIds) ? { entryOrderIds: cleanIds(op.orderIds) } : {}) };
      } else if (op.op === 'voidEntry') rows[i] = { ...r, state: 'closed', exitT: op.t, exitPrice: r.entryPrice, reason: 'refused', pnl: 0, note: op.note };
      else if (op.op === 'beginExit') rows[i] = { ...r, state: 'exiting', pendingSince: finite(op.t) ? op.t : r.entryT };
      else if (op.op === 'abortExit') rows[i] = { ...r, state: 'open', note: op.note };
      else rows[i] = { ...r, state: r.state === 'entering' ? 'unknownEntry' : 'unknownExit', note: op.note };
      return bump(rows);
    }
    case 'close': {
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      // PAPER closes from open; REAL only after its exit was reserved (beginExit) and sent.
      if (r.state !== (r.mode === 'REAL' ? 'exiting' : 'open')) return { ok: false, status: 409, error: `Row is ${r.state}` };
      if (!finite(op.exitPrice) || !finite(op.exitT)) return { ok: false, status: 400, error: 'Invalid exit' };
      const rows = [...led.rows];
      rows[i] = {
        ...r, state: 'closed', exitT: op.exitT, exitPrice: op.exitPrice, reason: op.reason, pnl: rowPnl(r.side, r.entryPrice, op.exitPrice, r.unitsPerPoint),
        note: op.note ?? r.note, ...(finite(op.exitBarT) ? { exitBarT: op.exitBarT } : {}), ...(finite(op.exitBox) ? { exitBox: op.exitBox } : {}),
        ...(cleanIds(op.orderIds) ? { exitOrderIds: cleanIds(op.orderIds) } : {}),
      };
      return bump(rows);
    }
    case 'fillPrice': {
      // The broker's average traded price replaces a REAL row's decision price (idempotent: a price already filled stays).
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      if (r.mode !== 'REAL') return { ok: false, status: 409, error: 'Only a REAL row has broker fills' };
      if (!finite(op.price) || !(op.price > 0)) return { ok: false, status: 400, error: 'Invalid fill price' };
      // A price summed over fewer orders than the row has legs (a leg that was already flat, a slice) is a fraction of the price, not the price.
      if (op.legCount !== r.legs.length) return { ok: false, status: 409, error: `Fill covers ${op.legCount} order(s) but the row has ${r.legs.length} leg(s)` };
      // A row closed without an AUTO order (flat at the broker, resolved by the user, refused) has no real exit to price against.
      if (r.state === 'closed' && (r.reason === 'flat at broker' || r.reason === 'resolved' || r.reason === 'refused')) return { ok: false, status: 409, error: `Row was closed as ${r.reason}: nothing to re-price` };
      // One wrong sum (a missing leg, a wrong scale, the wrong order) must not be locked in: a fill is within FILL_BAND of its decision price.
      const ref = op.which === 'entry' ? (r.entryDecision ?? r.entryPrice) : (r.exitDecision ?? r.exitPrice);
      if (finite(ref) && ref! > 0 && Math.abs(op.price / ref! - 1) > FILL_BAND) return { ok: false, status: 422, error: `Fill ${op.price} is more than ${FILL_BAND * 100}% from the decision price ${ref}` };
      const rows = [...led.rows];
      if (op.which === 'entry') {
        if (r.state === 'entering' || r.state === 'unknownEntry') return { ok: false, status: 409, error: `Row is ${r.state}` };
        if (r.entryFilled) return { ok: true, ledger: led };
        const next = { ...r, entryDecision: r.entryDecision ?? r.entryPrice, entryPrice: op.price, entryFilled: true };
        rows[i] = r.state === 'closed' && r.exitPrice !== undefined ? { ...next, pnl: rowPnl(r.side, op.price, r.exitPrice, r.unitsPerPoint) } : next;
      } else {
        if (r.state !== 'closed' || r.exitPrice === undefined) return { ok: false, status: 409, error: `Row is ${r.state}` };
        if (r.exitFilled) return { ok: true, ledger: led };
        rows[i] = { ...r, exitDecision: r.exitDecision ?? r.exitPrice, exitPrice: op.price, exitFilled: true, pnl: rowPnl(r.side, r.entryPrice, op.price, r.unitsPerPoint) };
      }
      return bump(rows);
    }
    case 'resolve': {
      // The user has checked the broker: an unknown entry really is open / never happened; an unknown exit is flat / still open.
      const i = find(op.id);
      if (i < 0) return { ok: false, status: 404, error: 'No such row' };
      const r = led.rows[i];
      // A stale entering / exiting row (the tab died with the order on the wire) is resolved the same way as an unknown one.
      if (r.state === 'open' || r.state === 'closed') return { ok: false, status: 409, error: 'Only an unresolved row can be resolved' };
      const rows = [...led.rows];
      if (op.as === 'open') rows[i] = { ...r, state: 'open', note: 'resolved by the user: open' };
      else {
        const px = finite(op.exitPrice) ? op.exitPrice! : r.entryPrice;
        const neverOpened = r.state === 'unknownEntry' || r.state === 'entering';
        rows[i] = { ...r, state: 'closed', exitT: op.t, exitPrice: px, reason: 'resolved', pnl: neverOpened ? 0 : rowPnl(r.side, r.entryPrice, px, r.unitsPerPoint), note: 'resolved by the user: flat' };
      }
      return bump(rows);
    }
    case 'log':
      if (typeof op.text !== 'string' || !op.text) return { ok: false, status: 400, error: 'Empty log' };
      return bump(led.rows, [...led.log, { t: op.t, chart: op.chart, text: op.text.slice(0, 300) }]);
    case 'setArm': {
      if (op.chart !== 1 && op.chart !== 2) return { ok: false, status: 400, error: 'chart must be 1 or 2' };
      if (typeof op.text !== 'string' || !op.text || !finite(op.t)) return { ok: false, status: 400, error: 'An arm change needs a time and a log line' };
      const k = String(op.chart) as '1' | '2';
      const arms = { ...(led.arms ?? {}) };
      if (op.arm === null) {
        if (!arms[k]) return { ok: true, ledger: led };                          // already off: nothing to log twice (every tab follows a stop)
        delete arms[k];
      } else {
        const a = armOk(op.arm);
        if (!a) return { ok: false, status: 400, error: 'Invalid arm' };
        arms[k] = a;
      }
      return bump(led.rows, [...led.log, { t: op.t, chart: op.chart, text: op.text.slice(0, 300) }], arms);
    }
    case 'resetPaper':
      // Live REAL rows are never touched; open PAPER rows go too (they own nothing at the broker).
      return bump(led.rows.filter(r => r.mode === 'REAL'));
    default:
      return { ok: false, status: 400, error: 'Unknown op' };
  }
}

/** Today's (IST) closed P&L and trade count for one mode, per chart. */
export function dayStats(led: AutoLedger, day: string, mode: AutoMode): Record<1 | 2, { pnl: number; trades: number }> {
  const out: Record<1 | 2, { pnl: number; trades: number }> = { 1: { pnl: 0, trades: 0 }, 2: { pnl: 0, trades: 0 } };
  for (const r of led.rows) {
    if (r.day !== day || r.mode !== mode) continue;
    out[r.chart].trades++;
    if (r.state === 'closed') out[r.chart].pnl += r.pnl ?? 0;
  }
  return out;
}

export interface AutoDaySummary {
  realised: number; unrealised: number; total: number;
  /** Open rows with no live price: their unrealised P&L is unknown (not counted as 0 silently: shown with a marker). */
  unpriced: number; open: number; closed: number; wins: number; losses: number;
}

/**
 * One mode's AUTO P&L for an IST day: closed rows' booked P&L plus open rows marked at `priceOf(targetKey)` (the price of
 * a chart showing that contract, or null when no chart shows it).
 */
export function autoDaySummary(rows: AutoRow[], day: string, mode: AutoMode, priceOf: (targetKey: string) => number | null): AutoDaySummary {
  const s: AutoDaySummary = { realised: 0, unrealised: 0, total: 0, unpriced: 0, open: 0, closed: 0, wins: 0, losses: 0 };
  for (const r of rows) {
    if (r.day !== day || r.mode !== mode) continue;
    if (r.state === 'closed') {
      const p = r.pnl ?? 0;
      s.realised += p; s.closed++;
      if (p > 0) s.wins++; else if (p < 0) s.losses++;
    } else if (r.state === 'open') {
      s.open++;
      const px = priceOf(r.targetKey);
      if (px === null || !(px > 0)) s.unpriced++;
      else s.unrealised += rowPnl(r.side, r.entryPrice, px, r.unitsPerPoint);
    }
  }
  s.total = s.realised + s.unrealised;
  return s;
}

/**
 * The chart markers of AUTO rows for one contract, drawn from the ledger on their confirmed boxes (entryBox / exitBox; older
 * rows fall back to the booked price): the entry on its SIGNAL bar, the exit on the bar that
 * triggered it (the reversal column's first bar). Never at the decision time: that is the minute after, often already in
 * the next column, which put a SELL on an X column. A row without `exitBarT` (older rows) uses the bar that closed just before
 * its exit was decided.
 */
export function autoMarkers(rows: AutoRow[], tk: string): { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] {
  const out: { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] = [];
  for (const r of rows) {
    if (r.targetKey !== tk || r.state === 'entering' || r.state === 'unknownEntry') continue;
    if (r.state === 'closed' && r.reason === 'refused') continue;          // never opened
    out.push({ id: `${r.id}:in`, t: r.entryBarT, action: r.side, price: r.entryBox ?? r.entryPrice, lots: r.lots, mode: r.mode });
    if (r.state === 'closed' && r.reason !== 'resolved' && r.exitPrice !== undefined && r.exitT !== undefined) {
      const t = r.exitBarT ?? Math.floor(r.exitT / 60) * 60 - 60;
      out.push({ id: `${r.id}:out`, t, action: r.side === 'BUY' ? 'SELL' : 'BUY', price: r.exitBox ?? r.exitPrice, lots: r.lots, mode: r.mode });
    }
  }
  return out;
}
