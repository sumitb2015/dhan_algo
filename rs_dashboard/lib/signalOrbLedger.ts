// Signal Orb ledger: pure state + ops. The server (lib/signalOrbServer.ts) owns the file debug/signal_orb_state.json and applies
// these under one in-process chain; the browser only sends config / mode / engine ops and asks the trade route to act. Real money:
// the ledger is the authority for what THIS page opened (an exit closes only its own units, never the broker's whole net).

import { TIMEFRAMES, sanitizeSpec, hhmmToMin, defaultSpec, rowPnl, type IndicatorSpec, type Side, type Timeframe } from './signalOrb.ts';
import type { Target } from './pnfTarget.ts';

export type OrbMode = 'SIM' | 'REAL';
export type OrbBroker = 'dhan' | 'kotak' | 'zerodha';
export type RowStatus = 'sending' | 'open' | 'closing' | 'closed' | 'failed' | 'unknown';
export type OrbSymbol = 'CRUDEOILM' | 'CRUDEOIL';
export const ORB_SYMBOLS: OrbSymbol[] = ['CRUDEOILM', 'CRUDEOIL'];
/** futures: long on BULL, short on BEAR. options: SELL a PE on BULL, SELL a CE on BEAR (the indicators always read the future). */
export type OrbInstrument = 'futures' | 'options';
/** Strike offset bounds: 0 = ATM, +N = N strikes OTM (PE down, CE up), -N = ITM. */
export const MAX_STRIKE_OFFSET = 10;
export const MAX_INDICATORS = 8;
export const MAX_REJECTS = 3;
/** A 'sending' / 'closing' row older than this lost its order call (server restart mid-send): the user may resolve it. */
export const STUCK_MS = 90_000;

/** In flight past STUCK_MS: the request that owned it is gone, only the broker book can say what happened. */
export const isStuck = (r: OrbRow, now: number) =>
  (r.status === 'sending' || r.status === 'closing') && now - (r.sentAt ?? r.entryAt) > STUCK_MS;
const LOG_MAX = 60;
const ROWS_MAX = 200;

export interface OrbConfig {
  indicators: IndicatorSpec[];
  timeframe: Timeframe;
  lots: number;
  /** Hard stop, points from entry. REAL needs it > 0. */
  stopPts: number;
  /** Rupees; today's realised loss (active mode) at or past it halts entries. */
  dailyLossLimit: number;
  entryStart: string;
  entryEnd: string;
  eodExit: string;
  broker: OrbBroker;
  symbol: OrbSymbol;
  instrument: OrbInstrument;
  strikeOffset: number;
}

export interface OrbRow {
  id: string;
  mode: OrbMode;
  broker: OrbBroker;
  target: Target;
  side: Side;
  lots: number;
  /** Broker quantity sent (lots x the broker's own lot units); 0 for SIM. */
  units: number;
  /** Rupees per point per lot (CRUDEOILM: 10 barrels). */
  unitsPerLot: number;
  /** Decision price of the row's OWN instrument (futures LTP, or the option premium) when the order was sent, not the broker fill. */
  entry: number;
  /** The future the signal (and the stop) read. Absent on rows written before options existed: then `target`. */
  signalTarget?: Target;
  /** The future's price at entry: the stop is measured from it. Absent on old rows: then `entry`. */
  signalEntry?: number;
  entryAt: number;
  day: string;
  status: RowStatus;
  exit?: number;
  exitAt?: number;
  exitReason?: string;
  pnl?: number;
  note?: string;
  /** When the row last went 'sending' / 'closing' (ms): an order still in flight after STUCK_MS died with the server. */
  sentAt?: number;
}

export interface OrbLog { at: number; level: 'info' | 'warn' | 'error' | 'trade'; msg: string }

export interface OrbLedger {
  rev: number;
  config: OrbConfig;
  mode: OrbMode;
  engineActive: boolean;
  haltReason: string | null;
  /** Newest bar an entry / reversal was taken on. */
  watermarkT: number;
  /** After a stop-out: this side waits for the colour to change. */
  blockedSide: Side | null;
  rejects: number;
  rows: OrbRow[];
  log: OrbLog[];
  updatedAt: number;
}

export const DEFAULT_CONFIG: OrbConfig = {
  indicators: [defaultSpec('ema', 'ema-9'), defaultSpec('supertrend', 'st-10-2')],
  timeframe: 1,
  lots: 1,
  stopPts: 30,
  dailyLossLimit: 3000,
  entryStart: '09:15',
  entryEnd: '22:45',
  eodExit: '23:00',
  broker: 'dhan',
  symbol: 'CRUDEOILM',
  instrument: 'futures',
  strikeOffset: 0,
};

export const emptyLedger = (): OrbLedger => ({
  rev: 0, config: { ...DEFAULT_CONFIG, indicators: [...DEFAULT_CONFIG.indicators] }, mode: 'SIM', engineActive: false, haltReason: null,
  watermarkT: 0, blockedSide: null, rejects: 0, rows: [], log: [], updatedAt: 0,
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stored ledger of any shape -> a valid one (corrupt fields fall back to defaults; rows are kept as written). */
export function normalizeLedger(v: unknown): OrbLedger {
  const base = emptyLedger();
  if (!v || typeof v !== 'object') return base;
  const o = v as Partial<OrbLedger>;
  const cfg = sanitizeConfigPatch(o.config ?? {}, base.config);
  return {
    rev: Number.isInteger(o.rev) ? (o.rev as number) : 0,
    config: typeof cfg === 'string' ? base.config : cfg,
    mode: o.mode === 'REAL' ? 'REAL' : 'SIM',
    engineActive: o.engineActive === true,
    haltReason: typeof o.haltReason === 'string' ? o.haltReason : null,
    watermarkT: Number.isFinite(o.watermarkT) ? (o.watermarkT as number) : 0,
    blockedSide: o.blockedSide === 'LONG' || o.blockedSide === 'SHORT' ? o.blockedSide : null,
    rejects: Number.isInteger(o.rejects) ? (o.rejects as number) : 0,
    rows: Array.isArray(o.rows) ? o.rows : [],
    log: Array.isArray(o.log) ? o.log : [],
    updatedAt: Number.isFinite(o.updatedAt) ? (o.updatedAt as number) : 0,
  };
}

/** Merge a config patch into `cur`, bounded; a reason string when it is refused. Time order is checked only when a time is patched. */
export function sanitizeConfigPatch(patch: unknown, cur: OrbConfig): OrbConfig | string {
  if (!patch || typeof patch !== 'object') return 'config patch must be an object';
  const p = patch as Record<string, unknown>;
  const next: OrbConfig = { ...cur, indicators: [...cur.indicators] };
  if (p.indicators !== undefined) {
    if (!Array.isArray(p.indicators)) return 'indicators must be a list';
    if (p.indicators.length > MAX_INDICATORS) return `At most ${MAX_INDICATORS} indicators`;
    const specs = p.indicators.map(sanitizeSpec);
    if (specs.some(s => s === null)) return 'An indicator is invalid';
    const ids = new Set(specs.map(s => s!.id));
    if (ids.size !== specs.length) return 'Indicator ids must be unique';
    next.indicators = specs as IndicatorSpec[];
  }
  if (p.timeframe !== undefined) {
    if (!TIMEFRAMES.includes(p.timeframe as Timeframe)) return `timeframe must be one of ${TIMEFRAMES.join(', ')} minutes`;
    next.timeframe = p.timeframe as Timeframe;
  }
  if (p.lots !== undefined) {
    const n = Number(p.lots);
    // no lot cap on this page (the user's call, 2026-11-20); the exchange's freeze quantity still rejects an oversized order
    if (!Number.isSafeInteger(n) || n < 1) return 'lots must be a whole number of at least 1';
    next.lots = n;
  }
  if (p.stopPts !== undefined) {
    const n = Number(p.stopPts);
    if (!Number.isFinite(n) || n < 0 || n > 1000) return 'stopPts must be 0-1000';
    next.stopPts = n;
  }
  if (p.dailyLossLimit !== undefined) {
    const n = Number(p.dailyLossLimit);
    if (!Number.isFinite(n) || n < 100 || n > 500_000) return 'dailyLossLimit must be 100-500000';
    next.dailyLossLimit = n;
  }
  if (p.broker !== undefined) {
    if (p.broker !== 'dhan' && p.broker !== 'kotak' && p.broker !== 'zerodha') return 'broker must be dhan, kotak or zerodha';
    next.broker = p.broker;
  }
  if (p.symbol !== undefined) {
    if (!ORB_SYMBOLS.includes(p.symbol as OrbSymbol)) return `symbol must be ${ORB_SYMBOLS.join(' or ')}`;
    next.symbol = p.symbol as OrbSymbol;
  }
  if (p.instrument !== undefined) {
    if (p.instrument !== 'futures' && p.instrument !== 'options') return 'instrument must be futures or options';
    next.instrument = p.instrument;
  }
  if (p.strikeOffset !== undefined) {
    const n = Number(p.strikeOffset);
    if (!Number.isInteger(n) || Math.abs(n) > MAX_STRIKE_OFFSET) return `strikeOffset must be a whole number from -${MAX_STRIKE_OFFSET} to ${MAX_STRIKE_OFFSET}`;
    next.strikeOffset = n;
  }
  let timePatched = false;
  for (const k of ['entryStart', 'entryEnd', 'eodExit'] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== 'string' || !HHMM_RE.test(p[k] as string)) return `${k} must be HH:MM`;
    next[k] = p[k] as string;
    timePatched = true;
  }
  if (timePatched && !(hhmmToMin(next.entryStart) < hhmmToMin(next.entryEnd) && hhmmToMin(next.entryEnd) <= hhmmToMin(next.eodExit))) {
    return 'Times must run entry start < entry end <= cutoff';
  }
  return next;
}

/** A row that holds (or may hold) a broker position: nothing new may open while one exists. */
export const isLive = (r: OrbRow) => r.status === 'open' || r.status === 'sending' || r.status === 'closing' || r.status === 'unknown';
export const liveRow = (l: OrbLedger): OrbRow | null => l.rows.find(isLive) ?? null;

/** Today's realised P&L of one mode. */
export const realisedToday = (l: OrbLedger, mode: OrbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && r.status === 'closed').reduce((s, r) => s + (r.pnl ?? 0), 0);

export const tradesToday = (l: OrbLedger, mode: OrbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && (r.status === 'closed' || isLive(r))).length;

export function addLog(l: OrbLedger, level: OrbLog['level'], msg: string, at: number): OrbLedger {
  return { ...l, log: [...l.log, { at, level, msg }].slice(-LOG_MAX) };
}

export function halt(l: OrbLedger, reason: string, at: number): OrbLedger {
  return addLog({ ...l, engineActive: false, haltReason: reason }, 'error', `HALTED: ${reason}`, at);
}

/** Old rows trimmed (closed / failed only, oldest first); live rows are never dropped. */
export function trimRows(rows: OrbRow[]): OrbRow[] {
  if (rows.length <= ROWS_MAX) return rows;
  let drop = rows.length - ROWS_MAX;
  return rows.filter(r => (drop > 0 && !isLive(r) ? (drop--, false) : true));
}

export type ClientOp =
  | { op: 'setConfig'; patch: unknown }
  | { op: 'setMode'; mode: OrbMode }
  | { op: 'setEngine'; active: boolean }
  | { op: 'addLog'; level: OrbLog['level']; msg: string }
  | { op: 'resetSim' }
  | { op: 'resolve'; id: string; as: 'open' | 'closed' | 'failed'; price?: number };

export type OpResult = { ok: true; ledger: OrbLedger } | { ok: false; status: number; error: string };

/** The browser's ops (never a trade: those are the trade route's). Pure; the caller bumps rev and writes. */
export function applyClientOp(l: OrbLedger, raw: unknown, now: number): OpResult {
  const bad = (error: string, status = 400): OpResult => ({ ok: false, status, error });
  if (!raw || typeof raw !== 'object') return bad('Invalid op');
  const op = raw as ClientOp;
  const live = liveRow(l);
  switch (op.op) {
    case 'setConfig': {
      const next = sanitizeConfigPatch(op.patch, l.config);
      if (typeof next === 'string') return bad(next);
      if (live && next.broker !== l.config.broker) return bad('The broker cannot change while a position is open', 409);
      if (live && (next.symbol !== l.config.symbol || next.instrument !== l.config.instrument || next.strikeOffset !== l.config.strikeOffset)) {
        return bad('Symbol, instrument and strike cannot change while a position is open', 409);
      }
      return { ok: true, ledger: { ...l, config: next } };
    }
    case 'setMode': {
      if (op.mode !== 'SIM' && op.mode !== 'REAL') return bad('mode must be SIM or REAL');
      if (live) return bad('Close the open position before switching mode', 409);
      if (op.mode === 'REAL' && !(l.config.stopPts > 0)) return bad('REAL needs a hard stop (points) above 0', 409);
      // a mode switch always lands paused: REAL is armed by the user, never inherited from SIM's running engine
      return { ok: true, ledger: addLog({ ...l, mode: op.mode, engineActive: false, watermarkT: 0, blockedSide: null, rejects: 0 }, 'info', `Mode -> ${op.mode}`, now) };
    }
    case 'setEngine': {
      const active = op.active === true;
      if (active && l.mode === 'REAL' && !(l.config.stopPts > 0)) return bad('REAL needs a hard stop (points) above 0', 409);
      if (active && !l.config.indicators.length) return bad('Add at least one indicator', 409);
      if (active && (live?.status === 'unknown' || (live && isStuck(live, now)))) return bad('A position has an UNKNOWN outcome - resolve it from the broker book first', 409);
      return { ok: true, ledger: addLog({ ...l, engineActive: active, haltReason: active ? null : l.haltReason, rejects: active ? 0 : l.rejects }, 'info', active ? 'Auto ON' : 'Auto OFF', now) };
    }
    case 'addLog': {
      const level = op.level === 'warn' || op.level === 'error' || op.level === 'trade' ? op.level : 'info';
      if (typeof op.msg !== 'string' || !op.msg.trim()) return bad('msg required');
      return { ok: true, ledger: addLog(l, level, op.msg.slice(0, 240), now) };
    }
    case 'resetSim': {
      if (live?.mode === 'SIM') return bad('Close the SIM position first', 409);
      return { ok: true, ledger: addLog({ ...l, rows: l.rows.filter(r => r.mode !== 'SIM') }, 'info', 'SIM trades cleared', now) };
    }
    case 'resolve': {
      // The user's reading of the broker book for a row the page cannot be sure of (UNKNOWN outcome, or one from an earlier day).
      const r = l.rows.find(x => x.id === op.id);
      if (!r || !isLive(r)) return bad('No such live row', 404);
      if ((r.status === 'sending' || r.status === 'closing') && !isStuck(r, now)) return bad('An order for this row is still in flight', 409);
      if (op.as === 'open') return { ok: true, ledger: addLog(patchRow(l, r.id, { status: 'open', note: 'confirmed open by user' }), 'warn', `Row ${r.id} confirmed OPEN by user`, now) };
      if (op.as === 'failed') return { ok: true, ledger: addLog(patchRow(l, r.id, { status: 'failed', note: 'confirmed not filled by user' }), 'warn', `Row ${r.id} marked NOT FILLED by user`, now) };
      if (op.as === 'closed') {
        const px = Number(op.price);
        const exit = Number.isFinite(px) && px > 0 ? px : r.entry;
        return { ok: true, ledger: addLog(closeRow(l, r.id, exit, 'Marked closed by user', now), 'warn', `Row ${r.id} marked CLOSED by user`, now) };
      }
      return bad('as must be open, closed or failed');
    }
    default:
      return bad('Unknown op');
  }
}

export function patchRow(l: OrbLedger, id: string, patch: Partial<OrbRow>): OrbLedger {
  return { ...l, rows: l.rows.map(r => (r.id === id ? { ...r, ...patch } : r)) };
}

export function closeRow(l: OrbLedger, id: string, exit: number, reason: string, at: number): OrbLedger {
  return {
    ...l,
    rows: l.rows.map(r => (r.id !== id ? r : {
      ...r, status: 'closed' as const, exit, exitAt: at, exitReason: reason,
      pnl: Math.round(rowPnl(r, exit) * 100) / 100,
    })),
  };
}
