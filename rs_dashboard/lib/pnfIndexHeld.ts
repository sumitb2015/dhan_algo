// Which option an index chart holds, and how much of it THIS chart opened (the Renko index -> option mapping, lib/pnfIndexMap.ts). The
// chart is the index; the position is one CE / PE resolved at entry, and Close / Reverse / the next click must act on THAT contract and
// on THIS chart's own quantity - never on whatever the map would pick now, and never on the broker's net (another page or strategy may
// hold the same strike). One row per page scope + chart + broker + index. Pure ops in, ledger out; the route
// (app/api/straddle-pnf/index-held) applies one op under a file lock. PAPER runs the same ops on a ledger in page memory.
//
// Reserve-then-send, for EVERY order (entry, add, reduce, close): `enter` / `begin` write the order's signed quantity as `pending`
// BEFORE it goes out, so a second tab is refused while it is in flight and a tab that dies mid-send leaves a row to settle, never a lost
// or a doubled order. `confirm` books the pending quantity into `units`; `void` drops it (refused); an unclear reply is 'unknown' and is
// settled by the user (`resolve` done / none), never resent. A row whose own quantity reaches 0 is removed.

import { parseTarget, targetKey, type Target } from './pnfTarget.ts';
import { tradedOf, type IndexDir } from './pnfIndexMap.ts';
import type { PnfAction, PnfBroker } from './pnfOrderLogic.ts';

/** open = nothing in flight; sending = an order is out (pending); unknown = its outcome is unclear (pending, until the user settles it). */
export type HeldState = 'sending' | 'open' | 'unknown';
export type HeldProduct = 'INTRADAY' | 'MARGIN';

export interface HeldRow {
  id: string;
  chart: 1 | 2;
  /** targetKey of the index chart the row belongs to. */
  indexKey: string;
  broker: PnfBroker;
  dir: IndexDir;
  /** The option the chart holds. */
  traded: Target;
  /** The option's own side (a bearish SELL CE is a SELL). */
  action: PnfAction;
  /** The product it was opened under (an exit closes that product's row). */
  product: HeldProduct;
  /** `SEG:ID` of the option, for its live price. */
  ids: string;
  /** Broker quantity this chart holds (always >= 0, in the direction of `action`); 0 only while the entry is still pending. */
  units: number;
  /** Broker quantity of the order in flight / unclear: + adds to the position, - reduces it. 0 when none. */
  pending: number;
  state: HeldState;
  /** Epoch seconds of the last change. */
  t: number;
  /** The index price when it was entered (the chart's entry line). */
  entryY?: number;
  note?: string;
}

export interface HeldLedger { rev: number; rows: HeldRow[] }

type NewRow = Omit<HeldRow, 'state' | 't' | 'units' | 'pending'>;
export type HeldOp =
  /** A new entry: the row is created with `units` pending (state 'sending'); or, when this exact leg is already held and idle, `begin` +units on it. */
  | { op: 'enter'; row: NewRow; units: number; now: number }
  /** An add (+) or a reduce / close (-) on the held row: reserved as pending. */
  | { op: 'begin'; id: string; delta: number; now: number }
  | { op: 'confirm' | 'void' | 'clear'; id: string; now: number }
  | { op: 'unknown'; id: string; note?: string; now: number }
  | { op: 'resolve'; id: string; as: 'done' | 'none'; now: number };

export type HeldResult = { ok: true; ledger: HeldLedger; row?: HeldRow | null } | { ok: false; error: string; status: number };

const ID_RE = /^[A-Za-z0-9:_-]{1,80}$/;
const IDS_RE = /^(NSE_FNO|MCX_COMM):\d{1,9}$/;
const MAX_ROWS = 50;
/** No order from this page is this big (20 lots x the largest index lot): a quantity past it is a bug, refused. */
const MAX_UNITS = 100_000;
const qtyOk = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_UNITS;

export const emptyHeld = (): HeldLedger => ({ rev: 0, rows: [] });

function parseRow(v: unknown): HeldRow | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const traded = parseTarget(o.traded);
  if (typeof o.id !== 'string' || !ID_RE.test(o.id) || (o.chart !== 1 && o.chart !== 2) || typeof o.indexKey !== 'string') return null;
  if (o.broker !== 'dhan' && o.broker !== 'kotak' && o.broker !== 'zerodha') return null;
  if (o.dir !== 'bull' && o.dir !== 'bear') return null;
  if (o.action !== 'BUY' && o.action !== 'SELL') return null;
  if (o.product !== 'INTRADAY' && o.product !== 'MARGIN') return null;
  if (o.state !== 'sending' && o.state !== 'open' && o.state !== 'unknown') return null;
  if (!traded || typeof o.ids !== 'string' || !IDS_RE.test(o.ids)) return null;
  const index = o.indexKey.split('|');
  if (index[0] !== 'index' || !tradedOf({ symbol: index[1] ?? '' }, traded)) return null;
  const units = Number(o.units), pending = Number(o.pending);
  if (!Number.isInteger(units) || units < 0 || units > MAX_UNITS || !Number.isInteger(pending) || Math.abs(pending) > MAX_UNITS) return null;
  if (o.state === 'open' ? pending !== 0 || units === 0 : pending === 0) return null;   // the state and the quantities must agree
  return {
    id: o.id, chart: o.chart, indexKey: o.indexKey, broker: o.broker, dir: o.dir, traded, action: o.action, product: o.product, ids: o.ids,
    units, pending, state: o.state, t: Number(o.t) || 0,
    ...(Number(o.entryY) > 0 ? { entryY: Number(o.entryY) } : {}), ...(typeof o.note === 'string' ? { note: o.note.slice(0, 200) } : {}),
  };
}

/** A stored file (any shape) -> a ledger; rows that do not parse are dropped (never trusted half-read). */
export function parseHeld(v: unknown): HeldLedger {
  if (!v || typeof v !== 'object') return emptyHeld();
  const o = v as Record<string, unknown>;
  const rows = Array.isArray(o.rows) ? o.rows.map(parseRow).filter((r): r is HeldRow => r !== null) : [];
  return { rev: Number(o.rev) || 0, rows };
}

/** The row for one chart + broker + index, if any (at most one by construction). */
export const heldFor = (led: HeldLedger, chart: 1 | 2, broker: PnfBroker, indexKey: string) =>
  led.rows.find(r => r.chart === chart && r.broker === broker && r.indexKey === indexKey) ?? null;

/** What the user is asked to settle, in words. */
export function pendingText(r: HeldRow): string {
  if (r.units === 0) return 'the entry';
  return r.pending > 0 ? 'an add' : r.pending + r.units <= 0 ? 'the close' : 'a reduce';
}

const bump = (led: HeldLedger, rows: HeldRow[]): HeldLedger => ({ rev: led.rev + 1, rows });
const refuse = (error: string, status = 409): HeldResult => ({ ok: false, error, status });
const dirWord = (r: HeldRow) => (r.dir === 'bull' ? 'bullish' : 'bearish');

export function applyHeldOp(led: HeldLedger, op: HeldOp): HeldResult {
  const now = Math.floor(Number(op.now)) || 0;
  const put = (row: HeldRow): HeldResult => ({ ok: true, ledger: bump(led, led.rows.map(r => (r.id === row.id ? row : r))), row });
  const drop = (id: string): HeldResult => ({ ok: true, ledger: bump(led, led.rows.filter(r => r.id !== id)), row: null });
  const reserve = (cur: HeldRow, delta: number): HeldResult => {
    if (cur.state !== 'open') return refuse(`Chart ${cur.chart}'s last ${dirWord(cur)} order is ${cur.state === 'unknown' ? 'UNKNOWN' : 'still being sent'} - settle it before another order`);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_UNITS) return refuse('Invalid quantity', 400);
    if (cur.units + delta < 0) return refuse(`Chart ${cur.chart} holds ${cur.units} - it cannot reduce by ${-delta}`);
    return put({ ...cur, pending: delta, state: 'sending', t: now });
  };

  if (op.op === 'enter') {
    if (!qtyOk(op.units)) return refuse('Invalid quantity', 400);
    const row = parseRow({ ...op.row, units: 0, pending: op.units, state: 'sending', t: now });
    if (!row) return refuse('Invalid held-option row', 400);
    const cur = heldFor(led, row.chart, row.broker, row.indexKey);
    if (cur) {
      const same = targetKey(cur.traded) === targetKey(row.traded) && cur.action === row.action && cur.dir === row.dir;
      if (!same) return refuse(`Chart ${row.chart} already holds a ${dirWord(cur)} option - close it first (or Reverse)`);
      if (cur.product !== row.product) return refuse(`Chart ${row.chart} holds it as ${cur.product === 'MARGIN' ? 'NRML' : 'MIS'} - pick that product to add`);
      return reserve(cur, op.units);       // another tab opened the same leg a moment ago: this order adds to it
    }
    if (led.rows.some(r => r.id === row.id)) return refuse('Duplicate row id', 400);
    return { ok: true, ledger: bump(led, [...led.rows, row].slice(-MAX_ROWS)), row };
  }
  const cur = led.rows.find(r => r.id === op.id);
  if (!cur) return refuse('No such held option (already settled?)', 404);
  const book = (r: HeldRow): HeldResult => {           // the pending order went through
    const units = r.units + r.pending;
    return units <= 0 ? drop(r.id) : put({ ...r, units, pending: 0, state: 'open', t: now, note: undefined });
  };
  const unbook = (r: HeldRow): HeldResult =>          // it did not: nothing changed at the broker
    r.units === 0 ? drop(r.id) : put({ ...r, pending: 0, state: 'open', t: now, note: undefined });
  switch (op.op) {
    case 'begin':
      return reserve(cur, op.delta);
    case 'confirm':
      if (cur.state !== 'sending') return refuse(`Cannot confirm a ${cur.state} row`);
      return book(cur);
    case 'void':
      if (cur.state !== 'sending') return refuse(`Cannot void a ${cur.state} row`);
      return unbook(cur);
    case 'unknown':
      if (cur.state !== 'sending') return refuse(`Cannot mark a ${cur.state} row unknown`);
      return put({ ...cur, state: 'unknown', t: now, ...(op.note ? { note: op.note.slice(0, 200) } : {}) });
    case 'resolve':
      // the user checked Orders / Positions: the order in question went through (done) or did not (none)
      if (cur.state === 'open') return refuse('Nothing to settle');
      return op.as === 'done' ? book(cur) : unbook(cur);
    case 'clear':
      // the broker shows the contract flat: nothing of this chart's is left
      if (cur.state !== 'open') return refuse(`Cannot clear a ${cur.state} row - settle it first`);
      return drop(cur.id);
  }
  return refuse('Unknown op', 400);
}
