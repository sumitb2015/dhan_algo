/**
 * Server-side persistence for the Focus Tool config and worker status.
 *
 * Server-only (it touches `fs`) — the browser gets this data through
 * /api/focus-tool. The pure rule engine lives in focusTool.ts and is shared.
 *
 * Everything written here is read by a process that places real orders, so
 * `sanitizeConfig` is not defensive politeness: it is the boundary. A stray
 * `lots: "3"` from a form field, a NaN strike level, or an unknown broker
 * string must not reach the worker in a shape it will act on.
 */

import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { BROKERS, type Broker } from '@/hooks/useBrokerSelector';
import {
  UNDERLYINGS, STRIKE_STEP, defaultConfig, newRow,
  type FocusConfig, type FocusGroup, type FocusRow, type LevelExits,
  type Underlying, type RowState, type DteFilter,
} from '@/lib/focusTool';

const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
export const CONFIG_FILE = path.join(DEBUG_DIR, 'focus_tool_config.json');
export const STATUS_FILE = path.join(DEBUG_DIR, 'focus_tool_status.json');
export const STOP_TRIGGER = path.join(DEBUG_DIR, 'focus_tool_stop.trigger');
export const WORKER_LOG   = path.join(DEBUG_DIR, 'focus_tool_worker.log');

// ─── Coercion helpers ─────────────────────────────────────────────

/** A finite number, or null. Rejects NaN/Infinity and empty-string form values. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A finite number strictly greater than zero, or null. Levels and limits use
 *  this: a 0 spot level is indistinguishable from "unset" and would fire. */
function posNum(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = num(v);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function bool(v: unknown): boolean {
  return v === true;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** "HH:MM" or '' — anything else becomes '' (meaning "no schedule"), never a
 *  half-parsed time the worker might act on at an unintended minute. */
function hhmm(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const ROW_STATES: readonly RowState[] = ['DRAFT', 'ARMED', 'ENTERED', 'EXITED', 'ERROR'];
const DTE_FILTERS: readonly DteFilter[] = ['any', '0', '1', '0+1'];

const MAX_ROWS_PER_GROUP = 12;
const MAX_LOTS = 100;
const MAX_OFFSET = 40;

// ─── Sanitisation ─────────────────────────────────────────────────

function sanitizeExits(raw: unknown): LevelExits {
  const r = (raw ?? {}) as Record<string, unknown>;
  const slMult = posNum(r.slMult);
  return {
    spotHigh: posNum(r.spotHigh),
    spotLow:  posNum(r.spotLow),
    vwap:     bool(r.vwap),
    slRupees: posNum(r.slRupees),
    // A multiple of 1 or less is not a stop — it is either "no move at all" or
    // nonsense. Drop it rather than let it read as an instant exit.
    slMult:   slMult !== null && slMult > 1 ? slMult : null,
  };
}

/**
 * A fill is only trusted when it is internally complete. A half-written fill
 * (say, a qty but no entry prices) would make P&L and every SL rule wrong, so
 * it is dropped entirely and the row falls back to whatever its state says.
 */
function sanitizeFill(raw: unknown): FocusRow['fill'] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ceStrike = posNum(r.ceStrike);
  const peStrike = posNum(r.peStrike);
  const ceEntry  = num(r.ceEntry);
  const peEntry  = num(r.peEntry);
  const qty      = posNum(r.qty);
  if (ceStrike === null || peStrike === null || ceEntry === null || peEntry === null || qty === null) {
    return undefined;
  }
  const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  return {
    ceStrike, peStrike, ceEntry, peEntry, qty,
    ts: String(r.ts ?? ''),
    ceId: str(r.ceId), peId: str(r.peId),
    ceSymbol: str(r.ceSymbol), peSymbol: str(r.peSymbol),
  };
}

function sanitizeRow(raw: unknown, index: number): FocusRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = String(r.id ?? '').trim() || `row-${index + 1}`;
  const fill = sanitizeFill(r.fill);
  let state = oneOf(r.state, ROW_STATES, 'DRAFT');

  // ENTERED without a usable fill is a contradiction the worker cannot act on:
  // it would try to exit a position it knows nothing about. Demote it to ERROR
  // so it is visible on screen rather than silently inert.
  if (state === 'ENTERED' && !fill) state = 'ERROR';

  return {
    ...newRow(id),
    entryTime: hhmm(r.entryTime),
    exitTime:  hhmm(r.exitTime),
    dte:       oneOf(r.dte, DTE_FILTERS, 'any'),
    offset:    int(r.offset, 0, 0, MAX_OFFSET),
    lots:      int(r.lots, 1, 1, MAX_LOTS),
    side:      oneOf(r.side, ['SELL', 'BUY'] as const, 'SELL'),
    state,
    exits:     sanitizeExits(r.exits),
    ...(fill ? { fill } : {}),
    ...(r.error ? { error: String(r.error) } : {}),
  };
}

function sanitizeGroup(raw: unknown, underlying: Underlying): FocusGroup {
  const g = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(g.rows) ? g.rows.slice(0, MAX_ROWS_PER_GROUP) : [];
  const be = (g.bookExit ?? {}) as Record<string, unknown>;
  const step = posNum(g.strikeStep);

  return {
    underlying,
    started:    bool(g.started),
    atmBy:      oneOf(g.atmBy, ['SPOT', 'FUT'] as const, 'SPOT'),
    product:    oneOf(g.product, ['INTRADAY', 'MARGIN'] as const, 'INTRADAY'),
    strikeStep: step,
    bookExit: {
      enabled:  bool(be.enabled),
      spotHigh: posNum(be.spotHigh),
      spotLow:  posNum(be.spotLow),
    },
    rows: rows.map(sanitizeRow),
  };
}

/**
 * Coerce an arbitrary request body into a config the worker can safely act on.
 *
 * Groups are rebuilt from the canonical UNDERLYINGS list rather than from the
 * payload, so the file always holds exactly three groups in a known order and
 * a client cannot introduce a fourth underlying the worker has no ids for.
 */
export function sanitizeConfig(raw: unknown): FocusConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const incoming = Array.isArray(c.groups) ? (c.groups as Record<string, unknown>[]) : [];
  const risk  = (c.risk  ?? {}) as Record<string, unknown>;
  const trail = (c.trail ?? {}) as Record<string, unknown>;

  return {
    broker: oneOf(c.broker, BROKERS, 'dhan') as Broker,
    live:   bool(c.live),
    risk:  { enabled: bool(risk.enabled),  targetRs: posNum(risk.targetRs), stopRs: posNum(risk.stopRs) },
    trail: { enabled: bool(trail.enabled), triggerRs: posNum(trail.triggerRs), lockRs: posNum(trail.lockRs) },
    groups: UNDERLYINGS.map(u => sanitizeGroup(incoming.find(g => g?.underlying === u), u)),
  };
}

/** The group's effective strike ladder spacing. */
export function stepFor(group: FocusGroup): number {
  return group.strikeStep && group.strikeStep > 0 ? group.strikeStep : STRIKE_STEP[group.underlying];
}

// ─── File IO ──────────────────────────────────────────────────────

/** Write-then-rename. The worker re-reads this file whenever its mtime moves,
 *  and a torn read would parse as "no groups" — i.e. stop trading mid-session. */
function writeJsonAtomic(file: string, data: unknown) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readConfig(): FocusConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
    return sanitizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
  } catch {
    // A corrupt config must not be silently "fixed" into something tradeable.
    // defaultConfig() is inert — not live, no started groups, no rows.
    return defaultConfig();
  }
}

export function writeConfig(cfg: FocusConfig): void {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

export interface WorkerStatusRow {
  id: string;
  state: RowState;
  ceStrike?: number;
  peStrike?: number;
  ceLtp?: number;
  peLtp?: number;
  combined?: number;
  vwap?: number | null;
  pnl?: number;
  reason?: string;
  error?: string;
}

export interface WorkerStatusGroup {
  underlying: Underlying;
  spot?: number;
  fut?: number;
  atm?: number;
  expiry?: string;
  dte?: number | null;
  lot?: number | null;
  rows: WorkerStatusRow[];
}

export interface WorkerStatus {
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'STALE' | 'ERROR';
  pid?: number;
  last_update_ts?: number;
  broker?: Broker;
  live?: boolean;
  message?: string;
  groups?: WorkerStatusGroup[];
  pnl?: {
    realised: number;
    unrealised: number;
    total: number;
    peak: number;
    lock: number | null;
    trailState?: string;
  };
}

export function readStatus(): WorkerStatus | null {
  try {
    if (!fs.existsSync(STATUS_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as WorkerStatus;
  } catch {
    return null;
  }
}
