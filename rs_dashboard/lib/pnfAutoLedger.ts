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
  /** The chart's price at the decision (REAL: an estimate of the fill). */
  entryPrice: number;
  state: AutoRowState;
  exitT?: number;
  /** Time of the bar that triggered the exit (the reversal column's first bar), for the chart marker; absent on older rows. */
  exitBarT?: number;
  exitPrice?: number;
  reason?: string;
  pnl?: number;
  note?: string;
  /** When the REAL entry / exit was reserved (entering / exiting): a reservation much older than an order takes is stale. */
  pendingSince?: number;
}

export interface AutoLogEntry { t: number; chart: 1 | 2; text: string }
export interface AutoLedger { rev: number; rows: AutoRow[]; log: AutoLogEntry[] }

export const EMPTY_LEDGER: AutoLedger = { rev: 0, rows: [], log: [] };
const MAX_ROWS = 500;
const MAX_LOG = 200;

/** A row still owning a position at the broker (or possibly owning one): it blocks a new entry on that chart. */
export const isLive = (r: AutoRow) => r.state !== 'closed';

export const rowPnl = (side: 'BUY' | 'SELL', entry: number, exit: number, unitsPerPoint: number) =>
  (side === 'BUY' ? exit - entry : entry - exit) * unitsPerPoint;

export type AutoOp =
  | { op: 'open'; row: Omit<AutoRow, 'state' | 'targetKey'> & { state?: 'open' | 'entering' } }
  | { op: 'confirmEntry'; id: string; legs: AutoLeg[] }
  | { op: 'voidEntry'; id: string; t: number; note: string }
  | { op: 'beginExit'; id: string; t: number }
  | { op: 'abortExit'; id: string; note: string }
  | { op: 'markUnknown'; id: string; note: string }
  | { op: 'close'; id: string; exitT: number; exitPrice: number; reason: string; note?: string; exitBarT?: number }
  | { op: 'resolve'; id: string; as: 'open' | 'flat'; exitPrice?: number; t: number }
  | { op: 'log'; chart: 1 | 2; t: number; text: string }
  | { op: 'resetPaper' };

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

export function parseLedger(raw: unknown): AutoLedger {
  if (!raw || typeof raw !== 'object') return EMPTY_LEDGER;
  const o = raw as Partial<AutoLedger>;
  return { rev: finite(o.rev) ? o.rev! : 0, rows: Array.isArray(o.rows) ? o.rows : [], log: Array.isArray(o.log) ? o.log : [] };
}

/** Apply one op. Returns the new ledger, or an error with an HTTP status (the file is left as it was). */
export function applyAutoOp(led: AutoLedger, op: AutoOp): { ok: true; ledger: AutoLedger } | { ok: false; status: number; error: string } {
  const bump = (rows: AutoRow[], log = led.log): { ok: true; ledger: AutoLedger } =>
    ({ ok: true, ledger: { rev: led.rev + 1, rows: rows.slice(-MAX_ROWS), log: log.slice(-MAX_LOG) } });
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
        rows[i] = { ...r, state: 'open', legs: op.legs };
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
        note: op.note ?? r.note, ...(finite(op.exitBarT) ? { exitBarT: op.exitBarT } : {}),
      };
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
 * The chart markers of AUTO rows for one contract, drawn from the ledger: the entry on its SIGNAL bar, the exit on the bar that
 * triggered it (the reversal column's first bar). Never at the decision time: that is the minute after, often already in
 * the next column, which put a SELL on an X column. A row without `exitBarT` (older rows) uses the bar that closed just before
 * its exit was decided.
 */
export function autoMarkers(rows: AutoRow[], tk: string): { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] {
  const out: { id: string; t: number; action: 'BUY' | 'SELL'; price: number; lots: number; mode: AutoMode }[] = [];
  for (const r of rows) {
    if (r.targetKey !== tk || r.state === 'entering' || r.state === 'unknownEntry') continue;
    if (r.state === 'closed' && r.reason === 'refused') continue;          // never opened
    out.push({ id: `${r.id}:in`, t: r.entryBarT, action: r.side, price: r.entryPrice, lots: r.lots, mode: r.mode });
    if (r.state === 'closed' && r.reason !== 'resolved' && r.exitPrice !== undefined && r.exitT !== undefined) {
      const t = r.exitBarT ?? Math.floor(r.exitT / 60) * 60 - 60;
      out.push({ id: `${r.id}:out`, t, action: r.side === 'BUY' ? 'SELL' : 'BUY', price: r.exitPrice, lots: r.lots, mode: r.mode });
    }
  }
  return out;
}
