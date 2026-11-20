// Gearbox ledger: pure state + ops. The server (Task 4) is the only writer of debug/gearbox_state.json; the browser sends only
// config / mode / resolve ops. Real money: the ledger is the authority for what THIS page opened (exits close only its own units).

import type { Target } from './pnfTarget.ts';

export type GbMode = 'SIM' | 'REAL';
export type GbUnderlying = 'CRUDEOIL' | 'CRUDEOILM';
export type Dir = 'LONG' | 'SHORT';

export interface DirLeg { action: 'BUY' | 'SELL'; opt: 'CE' | 'PE'; offset: number; expiry: 'nearest' | string }

export interface GbConfig {
  underlying: GbUnderlying;
  broker: 'dhan';
  lots: number;
  tf: 1 | 3 | 5;
  map: Record<Dir, DirLeg>;
  slPts: number | null;
  tgtPts: number | null;
  maxLoss: number | null;
  maxTrades: number | null;
}

export type GbStatus = 'sending' | 'open' | 'closing' | 'closed' | 'failed' | 'unknown';

export interface GbRow {
  id: string;
  mode: GbMode;
  broker: 'dhan';
  underlying: GbUnderlying;
  dir: Dir;
  leg: DirLeg;
  target: Target;
  lots: number;
  units: number;
  unitsPerLot: number;
  entry: number;
  entryDecision: number;
  entryAt: number;
  entryOrderId?: string;
  exit?: number;
  exitDecision?: number;
  exitAt?: number;
  exitOrderId?: string;
  reason?: string;
  day: string;
  status: GbStatus;
  note?: string;
  /** Last good option price, kept fresh by gbState(); the square-off's SIM fallback. */
  lastLtp?: number;
}

export interface GbLog { at: number; level: 'info' | 'warn' | 'error' | 'trade'; msg: string }

export interface GbLedger {
  rev: number;
  updatedAt: number;
  mode: GbMode;
  config: GbConfig;
  rows: GbRow[];
  log: GbLog[];
  lastSquareOffDay: string | null;
}

export const MAX_REAL_LOTS = 1;
export const MAX_SIM_LOTS = 10;
export const MAX_ROWS = 200;
export const MAX_LOG = 300;

export const DEFAULT_CONFIG: GbConfig = {
  underlying: 'CRUDEOILM',
  broker: 'dhan',
  lots: 1,
  tf: 5,
  map: {
    LONG: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
    SHORT: { action: 'BUY', opt: 'PE', offset: 0, expiry: 'nearest' },
  },
  slPts: null,
  tgtPts: null,
  maxLoss: null,
  maxTrades: null,
};

const cloneConfig = (c: GbConfig): GbConfig => ({ ...c, map: { LONG: { ...c.map.LONG }, SHORT: { ...c.map.SHORT } } });

export const emptyLedger = (): GbLedger => ({
  rev: 0, updatedAt: 0, mode: 'SIM', config: cloneConfig(DEFAULT_CONFIG), rows: [], log: [], lastSquareOffDay: null,
});

const posOrNull = (v: unknown): number | null | undefined => {
  if (v === null) return null;
  const n = Number(v);
  return typeof v === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

function sanitizeLeg(v: unknown): DirLeg | string {
  if (!v || typeof v !== 'object') return 'map leg must be an object';
  const o = v as Record<string, unknown>;
  if (o.action !== 'BUY' && o.action !== 'SELL') return 'leg action must be BUY or SELL';
  if (o.opt !== 'CE' && o.opt !== 'PE') return 'leg opt must be CE or PE';
  if (typeof o.offset !== 'number' || !Number.isInteger(o.offset) || o.offset < -3 || o.offset > 3) return 'leg offset must be an integer -3..3';
  const exp = o.expiry;
  if (exp !== 'nearest' && !(typeof exp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(exp))) return 'leg expiry must be "nearest" or YYYY-MM-DD';
  return { action: o.action, opt: o.opt, offset: o.offset, expiry: exp };
}

/** Merge a config patch into `cur`, bounded; a reason string when refused. Unknown keys are ignored. */
export function sanitizeConfigPatch(patch: unknown, cur: GbConfig, mode: GbMode): GbConfig | string {
  if (!patch || typeof patch !== 'object') return 'config patch must be an object';
  const p = patch as Record<string, unknown>;
  const next = cloneConfig(cur);
  if (p.underlying !== undefined) {
    if (p.underlying !== 'CRUDEOIL' && p.underlying !== 'CRUDEOILM') return 'underlying must be CRUDEOIL or CRUDEOILM';
    next.underlying = p.underlying;
  }
  if (p.broker !== undefined) {
    if (p.broker !== 'dhan') return 'broker must be dhan';
    next.broker = 'dhan';
  }
  if (p.lots !== undefined) {
    const n = p.lots;
    const cap = mode === 'REAL' ? MAX_REAL_LOTS : MAX_SIM_LOTS;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > cap) return `lots must be 1-${cap} in ${mode}`;
    next.lots = n;
  }
  if (p.tf !== undefined) {
    if (p.tf !== 1 && p.tf !== 3 && p.tf !== 5) return 'tf must be 1, 3 or 5 minutes';
    next.tf = p.tf;
  }
  if (p.map !== undefined) {
    if (!p.map || typeof p.map !== 'object') return 'map must be an object';
    const m = p.map as Record<string, unknown>;
    for (const d of ['LONG', 'SHORT'] as const) {
      if (m[d] === undefined) continue;
      const leg = sanitizeLeg(m[d]);
      if (typeof leg === 'string') return `${d}: ${leg}`;
      next.map[d] = leg;
    }
  }
  for (const k of ['slPts', 'tgtPts', 'maxLoss', 'maxTrades'] as const) {
    if (p[k] === undefined) continue;
    const v = posOrNull(p[k]);
    if (v === undefined) return `${k} must be null or a positive number`;
    if (k === 'maxTrades' && v !== null && !Number.isInteger(v)) return 'maxTrades must be a whole number';
    next[k] = v;
  }
  return next;
}

/** A stored ledger of any shape -> a valid one (corrupt fields fall back to defaults; rows are kept as written). */
export function normalizeLedger(v: unknown): GbLedger {
  const base = emptyLedger();
  if (!v || typeof v !== 'object') return base;
  const o = v as Partial<GbLedger>;
  const mode: GbMode = o.mode === 'REAL' ? 'REAL' : 'SIM';
  const cfg = sanitizeConfigPatch(o.config ?? {}, base.config, mode);
  return {
    rev: Number.isInteger(o.rev) ? (o.rev as number) : 0,
    updatedAt: Number.isFinite(o.updatedAt) ? (o.updatedAt as number) : 0,
    mode,
    config: typeof cfg === 'string' ? base.config : cfg,
    rows: Array.isArray(o.rows) ? o.rows : [],
    log: Array.isArray(o.log) ? o.log : [],
    lastSquareOffDay: typeof o.lastSquareOffDay === 'string' ? o.lastSquareOffDay : null,
  };
}

/** A row that holds (or may hold) a broker position. */
export const isLive = (r: GbRow): boolean => r.status === 'sending' || r.status === 'open' || r.status === 'closing' || r.status === 'unknown';
export const liveRow = (l: GbLedger, u: GbUnderlying): GbRow | null => l.rows.find(r => r.underlying === u && isLive(r)) ?? null;

/** (exit | ltp - entry) x units, sign by leg action; null with no price. */
export function rowPnl(r: GbRow, ltp: number | null): number | null {
  const price = r.status === 'closed' && Number.isFinite(r.exit) ? (r.exit as number) : ltp;
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  const move = r.leg.action === 'BUY' ? price - r.entry : r.entry - price;
  return move * r.units;
}

export const realisedToday = (l: GbLedger, mode: GbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && r.status === 'closed').reduce((s, r) => s + (rowPnl(r, null) ?? 0), 0);

export const tradesToday = (l: GbLedger, mode: GbMode, day: string): number =>
  l.rows.filter(r => r.mode === mode && r.day === day && (r.status === 'closed' || isLive(r))).length;

/** The daily-limit message that blocks a new entry, or null. Uses the ledger's active mode. */
export function entryBlock(l: GbLedger, day: string): string | null {
  const { maxLoss, maxTrades } = l.config;
  if (maxLoss !== null && realisedToday(l, l.mode, day) <= -maxLoss) return `Daily max loss of ${maxLoss} reached`;
  if (maxTrades !== null && tradesToday(l, l.mode, day) >= maxTrades) return `Daily limit of ${maxTrades} trades reached`;
  return null;
}

export const addLog = (l: GbLedger, level: GbLog['level'], msg: string, at: number): GbLedger =>
  ({ ...l, log: [...l.log, { at, level, msg }].slice(-MAX_LOG) });

/** Old rows trimmed (closed / failed only, oldest first); live rows are never dropped. */
export function trimRows(rows: GbRow[]): GbRow[] {
  if (rows.length <= MAX_ROWS) return rows;
  let drop = rows.length - MAX_ROWS;
  return rows.filter(r => (drop > 0 && !isLive(r) ? (drop--, false) : true));
}

export type ClientOp =
  | { op: 'setConfig'; patch: Partial<GbConfig> }
  | { op: 'setMode'; mode: GbMode }
  | { op: 'resolve'; id: string; as: 'open' | 'closed' | 'failed'; price?: number };

type OpResult = { ok: true; ledger: GbLedger } | { ok: false; status: number; error: string };
const refuse = (status: number, error: string): OpResult => ({ ok: false, status, error });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function applyClientOp(l: GbLedger, raw: unknown, now: number): OpResult {
  if (!raw || typeof raw !== 'object') return refuse(400, 'op must be an object');
  const op = raw as Record<string, unknown>;
  const stamp = (next: GbLedger): GbLedger => ({ ...next, rev: l.rev + 1, updatedAt: now });

  if (op.op === 'setConfig') {
    const next = sanitizeConfigPatch(op.patch, l.config, l.mode);
    if (typeof next === 'string') return refuse(400, next);
    const live = liveRow(l, l.config.underlying);
    if (live && (next.underlying !== l.config.underlying || next.broker !== l.config.broker || !same(next.map, l.config.map))) {
      return refuse(409, 'Underlying, broker and the direction map are locked while a position is open');
    }
    return { ok: true, ledger: stamp({ ...l, config: next }) };
  }

  if (op.op === 'setMode') {
    if (op.mode !== 'SIM' && op.mode !== 'REAL') return refuse(400, 'mode must be SIM or REAL');
    if (l.rows.some(isLive)) return refuse(409, 'Mode cannot change while a position is open');
    let next: GbLedger = { ...l, mode: op.mode };
    if (op.mode === 'REAL' && l.config.lots > MAX_REAL_LOTS) {
      next = addLog({ ...next, config: { ...l.config, lots: MAX_REAL_LOTS } }, 'warn', `Lots lowered to ${MAX_REAL_LOTS} for REAL`, now);
    }
    return { ok: true, ledger: stamp(next) };
  }

  if (op.op === 'resolve') {
    if (typeof op.id !== 'string') return refuse(400, 'id required');
    if (op.as !== 'open' && op.as !== 'closed' && op.as !== 'failed') return refuse(400, 'as must be open, closed or failed');
    const idx = l.rows.findIndex(r => r.id === op.id);
    if (idx < 0) return refuse(404, 'row not found');
    const row = l.rows[idx];
    if (row.status !== 'unknown') return refuse(409, 'Only an unknown row can be resolved');
    let price: number | undefined;
    if (op.price !== undefined) {
      if (typeof op.price !== 'number' || !Number.isFinite(op.price) || op.price <= 0) return refuse(400, 'price must be a positive number');
      price = op.price;
    }
    const upd: GbRow = { ...row, status: op.as };
    if (op.as === 'closed') {
      if (price === undefined) return refuse(400, 'price required to close a row');
      upd.exit = price;
      upd.exitAt = now;
    }
    const rows = l.rows.map((r, i) => (i === idx ? upd : r));
    return { ok: true, ledger: stamp(addLog({ ...l, rows }, 'info', `Row ${row.id} resolved as ${op.as}`, now)) };
  }

  return refuse(400, 'unknown op');
}

/** Signed broker units held by live REAL rows of a contract key (BUY +, SELL -); pure core of gearboxFile's reservedByGearbox. */
export function reservedUnits(l: GbLedger, broker: string, tKey: string, keyOf: (t: Target) => string): number {
  let out = 0;
  for (const r of l.rows) {
    if (!isLive(r) || r.mode !== 'REAL' || r.broker !== broker || keyOf(r.target) !== tKey) continue;
    out += (r.leg.action === 'BUY' ? 1 : -1) * (Number(r.units) || 0);
  }
  return out;
}
