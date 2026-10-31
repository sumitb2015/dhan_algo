// Resting LIMIT / SL-limit orders placed from a P&F chart's B / S rail. Pure: ops in, new state out; the route
// (app/api/straddle-pnf/resting) serialises them under a file lock and writes the file atomically.
//
// venue 'broker': a REAL single-leg order resting at the broker. It is reserved BEFORE it is sent (`sending`), so a tab that
//   dies with the order on the wire leaves a row the user resolves, never a lost or duplicated order.
// venue 'page': a PAPER order (any chart) or a REAL watched level on a straddle chart, held here and acted on by the page's
//   leader tab. A REAL level is reserved (`firing`) before its MARKET orders go out, so it can fire at most once.
//
//   broker: sending → working (placed) | rejected | unknown;  working → filled | cancelled | rejected | unknown
//   page:   working → filled (paper) | firing → filled | rejected | unknown;  working → cancelled
//   unknown / a stale sending or firing → filled | cancelled by the user (resolve). Open on an earlier IST day → cancelled
//   (rollDay). State never moves back.
import { parseTarget, targetKey, type Target } from './pnfTarget.ts';
import { lotCap } from './pnfOrderLogic.ts';
import type { RestingKind, RestingSide } from './pnfResting.ts';
import type { BracketSpec } from './pnfBracket.ts';

export type RestingMode = 'PAPER' | 'REAL';
export type RestingState = 'sending' | 'working' | 'firing' | 'filled' | 'cancelled' | 'rejected' | 'unknown';

export interface RestingRow {
  id: string;
  /** IST date it was placed. */
  day: string;
  chart: 1 | 2;
  target: Target;
  targetKey: string;
  broker: string;
  mode: RestingMode;
  venue: 'broker' | 'page';
  side: RestingSide;
  kind: RestingKind;
  /** The box price clicked (where the line is drawn). */
  level: number;
  /** LIMIT: the limit; SL-limit: the limit once triggered. */
  price: number;
  trigger?: number;
  lots: number;
  /** INTRADAY / MARGIN (the trade bar's MIS / NRML). */
  product: string;
  /** Rupees per point for the whole order (paper P&L). */
  unitsPerPoint: number;
  /** Bracket / Cover attached to an ENTRY order: when it fills, the exit rows below are created from its fill price. */
  bracket?: BracketSpec;
  /** An exit row of a bracket: the entry's id, its role, and (a stop) the trailing distance in points. Rows of one group cancel each other. */
  group?: string;
  role?: 'sl' | 'target';
  trailPts?: number;
  /** Rupees per point for the whole order, per leg (a straddle's CE and PE can differ); absent on older rows. */
  legUnits?: number[];
  state: RestingState;
  brokerOrderId?: string;
  /** PAPER SL-limit: the trigger was reached and it now waits for its limit. */
  triggered?: boolean;
  fillPrice?: number;
  fillT?: number;
  t: number;
  /** When it went to sending / firing: a reservation much older than an order takes is stale. */
  pendingSince?: number;
  note?: string;
}

export interface RestingLedger { rev: number; rows: RestingRow[] }
export const EMPTY_RESTING: RestingLedger = { rev: 0, rows: [] };
/** Working orders per chart: a rail is a handful of levels, not a book. */
export const MAX_WORKING_PER_CHART = 10;
const MAX_ROWS = 500;

export const isOpenOrder = (r: RestingRow) => r.state === 'sending' || r.state === 'working' || r.state === 'firing' || r.state === 'unknown';

/** A sending / firing reservation older than this is a tab that died mid-order: the user may settle it. */
export const STALE_PENDING_S = 60;

/** An order the user settles by hand: its outcome is unknown, or its reservation was never finished. */
export const needsResolve = (r: RestingRow, nowS: number) =>
  r.state === 'unknown' || ((r.state === 'sending' || r.state === 'firing') && nowS - (r.pendingSince ?? r.t) > STALE_PENDING_S);

/**
 * A new IST day closes every open order placed on an earlier one: a broker DAY order has expired (it is not in today's order
 * book, so the book sync would never close it) and a page-held level must not fill on a new session. Same ledger back when
 * nothing changed.
 */
export function rollDay(led: RestingLedger, today: string): RestingLedger {
  if (!led.rows.some(r => r.day < today && isOpenOrder(r))) return led;
  return {
    rev: led.rev + 1,
    rows: led.rows.map(r => (r.day < today && isOpenOrder(r) ? { ...r, state: 'cancelled' as const, note: `expired: placed on ${r.day}`, pendingSince: undefined } : r)),
  };
}

export type RestingOp =
  | { op: 'create'; row: Omit<RestingRow, 'state' | 'targetKey' | 'pendingSince'> }
  | { op: 'placed'; id: string; brokerOrderId: string }
  | { op: 'modify'; id: string; level: number; price: number; trigger?: number }
  | { op: 'trigger'; id: string }
  | { op: 'fire'; id: string; t: number }
  | { op: 'fill'; id: string; price: number; t: number; /** A broker order cancelled after a part fill: the lots that did fill. */ lots?: number }
  | { op: 'cancel'; id: string; t: number }
  | { op: 'reject'; id: string; note: string }
  | { op: 'markUnknown'; id: string; note: string }
  | { op: 'resolve'; id: string; as: 'filled' | 'cancelled'; price?: number; t: number };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function parseResting(raw: unknown): RestingLedger {
  if (!raw || typeof raw !== 'object') return EMPTY_RESTING;
  const o = raw as Partial<RestingLedger>;
  return { rev: finite(o.rev) ? o.rev : 0, rows: Array.isArray(o.rows) ? o.rows : [] };
}

type Result = { ok: true; ledger: RestingLedger } | { ok: false; status: number; error: string };

export function applyRestingOp(led: RestingLedger, op: RestingOp): Result {
  const bump = (rows: RestingRow[]): Result => ({ ok: true, ledger: { rev: led.rev + 1, rows: rows.slice(-MAX_ROWS) } });
  const at = (id: string) => led.rows.findIndex(r => r.id === id);
  const set = (i: number, patch: Partial<RestingRow>) => { const rows = [...led.rows]; rows[i] = { ...led.rows[i], ...patch }; return bump(rows); };
  const need = (i: number, states: RestingState[]): Result | null => {
    if (i < 0) return { ok: false, status: 404, error: 'No such order' };
    return states.includes(led.rows[i].state) ? null : { ok: false, status: 409, error: `Order is ${led.rows[i].state}` };
  };

  switch (op.op) {
    case 'create': {
      const r = op.row;
      const target = parseTarget(r.target);
      if (!target || target.kind === 'index') return { ok: false, status: 400, error: 'A resting order needs a tradable chart' };
      if (r.chart !== 1 && r.chart !== 2) return { ok: false, status: 400, error: 'chart must be 1 or 2' };
      if (r.side !== 'BUY' && r.side !== 'SELL') return { ok: false, status: 400, error: 'side must be BUY or SELL' };
      if (r.kind !== 'limit' && r.kind !== 'stop') return { ok: false, status: 400, error: 'kind must be limit or stop' };
      if (r.mode !== 'PAPER' && r.mode !== 'REAL') return { ok: false, status: 400, error: 'mode must be PAPER or REAL' };
      if (r.venue !== 'broker' && r.venue !== 'page') return { ok: false, status: 400, error: 'venue must be broker or page' };
      if (r.mode === 'PAPER' && r.venue !== 'page') return { ok: false, status: 400, error: 'A paper order is held by the page' };
      const cap = lotCap(target);
      if (!Number.isInteger(r.lots) || r.lots < 1 || r.lots > cap) return { ok: false, status: 400, error: `lots must be 1-${cap}` };
      if (![r.level, r.price, r.unitsPerPoint, r.t].every(finite) || !(r.price > 0) || !r.id) return { ok: false, status: 400, error: 'Invalid order' };
      if (r.kind === 'stop' && !(finite(r.trigger) && r.trigger > 0)) return { ok: false, status: 400, error: 'An SL-limit needs a trigger' };
      if (led.rows.some(x => x.id === r.id)) return { ok: false, status: 409, error: 'Order already exists' };
      const working = led.rows.filter(x => x.chart === r.chart && isOpenOrder(x)).length;
      if (working >= MAX_WORKING_PER_CHART) return { ok: false, status: 409, error: `Chart ${r.chart} already has ${MAX_WORKING_PER_CHART} working orders` };
      const sending = r.mode === 'REAL' && r.venue === 'broker';
      return bump([...led.rows, { ...r, target, targetKey: targetKey(target), state: sending ? 'sending' : 'working', ...(sending ? { pendingSince: r.t } : {}) }]);
    }
    case 'placed': {
      const i = at(op.id); const bad = need(i, ['sending']); if (bad) return bad;
      if (!op.brokerOrderId) return { ok: false, status: 400, error: 'brokerOrderId required' };
      return set(i, { state: 'working', brokerOrderId: op.brokerOrderId, pendingSince: undefined });
    }
    case 'modify': {
      const i = at(op.id); const bad = need(i, ['working']); if (bad) return bad;
      if (![op.level, op.price].every(finite) || !(op.price > 0)) return { ok: false, status: 400, error: 'Invalid price' };
      if (led.rows[i].kind === 'stop' && !(finite(op.trigger) && op.trigger > 0)) return { ok: false, status: 400, error: 'An SL-limit needs a trigger' };
      return set(i, { level: op.level, price: op.price, ...(op.trigger !== undefined ? { trigger: op.trigger } : {}), triggered: false });
    }
    case 'trigger': {
      const i = at(op.id); const bad = need(i, ['working']); if (bad) return bad;
      return led.rows[i].venue === 'page' ? set(i, { triggered: true }) : { ok: false, status: 409, error: 'A broker order triggers at the broker' };
    }
    case 'fire': {
      const i = at(op.id); const bad = need(i, ['working']); if (bad) return bad;
      const r = led.rows[i];
      if (r.venue !== 'page' || r.mode !== 'REAL') return { ok: false, status: 409, error: 'Only a REAL page-held level fires' };
      return set(i, { state: 'firing', pendingSince: finite(op.t) ? op.t : r.t });
    }
    case 'fill': {
      const i = at(op.id);
      const r = i >= 0 ? led.rows[i] : null;
      // PAPER fills from working; a REAL level only after it was reserved (fire); a broker order once the book says TRADED.
      const from: RestingState[] = !r ? [] : r.venue === 'broker' ? ['working'] : r.mode === 'REAL' ? ['firing'] : ['working'];
      const bad = need(i, from); if (bad) return bad;
      if (!finite(op.price) || !(op.price > 0) || !finite(op.t)) return { ok: false, status: 400, error: 'Invalid fill' };
      const n = op.lots;
      const part = n !== undefined && r && Number.isInteger(n) && n >= 1 && n < r.lots ? { lots: n, unitsPerPoint: (r.unitsPerPoint / r.lots) * n, legUnits: r.legUnits?.map(u => (u / r.lots) * n), note: `part fill: ${n} of ${r.lots} lots` } : {};
      return set(i, { state: 'filled', fillPrice: op.price, fillT: op.t, pendingSince: undefined, ...part });
    }
    case 'cancel': {
      const i = at(op.id); const bad = need(i, ['working']); if (bad) return bad;
      return set(i, { state: 'cancelled', fillT: finite(op.t) ? op.t : undefined });
    }
    case 'reject': {
      const i = at(op.id); const bad = need(i, ['sending', 'working', 'firing']); if (bad) return bad;
      return set(i, { state: 'rejected', note: op.note, pendingSince: undefined });
    }
    case 'markUnknown': {
      const i = at(op.id); const bad = need(i, ['sending', 'working', 'firing']); if (bad) return bad;
      return set(i, { state: 'unknown', note: op.note });
    }
    case 'resolve': {
      // The user has checked the broker. A stale sending / firing row (the tab died mid-order) is settled the same way.
      const i = at(op.id); const bad = need(i, ['unknown', 'sending', 'firing']); if (bad) return bad;
      if (op.as === 'filled') {
        const px = finite(op.price) && op.price > 0 ? op.price : led.rows[i].price;
        return set(i, { state: 'filled', fillPrice: px, fillT: op.t, note: 'resolved by the user: filled', pendingSince: undefined });
      }
      return set(i, { state: 'cancelled', note: 'resolved by the user: not working', pendingSince: undefined });
    }
    default:
      return { ok: false, status: 400, error: 'Unknown op' };
  }
}
