/**
 * Breakdown Scalper Ledger (/breakdown-scalper)
 *
 * Dedicated state and position tracker saved to debug/breakdown_scalper_state.json.
 * Tracks active and closed short positions in both SIM (paper) and REAL mode.
 * Exits are sized from the ledger's own qty, never the raw broker net quantity.
 */

import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import type { TrendFilterMode } from './breakdownScalper.ts';
import { istDayOf } from './multiLegGuards.ts';

export type LedgerMode = 'SIM' | 'REAL';

export interface BreakdownPosition {
  id: string;
  mode: LedgerMode;
  broker: 'dhan' | 'kotak' | 'zerodha';
  underlying: string;
  expiry: string;
  option: 'CE' | 'PE';
  strike: number;
  securityId?: string;
  symbol?: string;
  lotSize: number;
  qty: number;
  entryPrice: number;
  lowestPrice: number;
  initialSl: number;
  trailingSl: number;
  targetPrice?: number | null;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  closedAt?: number;
  realized: number;
  exitPrice?: number;
  exitReason?: string;
  note?: string;
}

export interface BreakdownConfig {
  engineActive: boolean;
  strikeWindow: number; // ATM ± N (default 6 = 13 strikes x 2 = 26 contracts)
  timeframe: 1 | 3 | 5; // default 5m
  trendMode: TrendFilterMode; // default AUTO
  maxConcurrent: number; // default 2
  maxSameSide: number; // default 1
  lotsPerTrade: number; // default 1
  slPct: number; // default 25%
  trailPct: number; // default 15%
  targetPct: number; // default 35%
  recoveryExit: boolean; // default false
  dailyLossLimit: number; // default ₹5,000
  entryStart: string; // default "09:30"
  entryEnd: string; // default "15:00"
  eodExit: string; // default "15:15"
}

export const DEFAULT_CONFIG: BreakdownConfig = {
  engineActive: false,
  strikeWindow: 6,
  timeframe: 5,
  trendMode: 'AUTO',
  maxConcurrent: 2,
  maxSameSide: 1,
  lotsPerTrade: 1,
  slPct: 25,
  trailPct: 15,
  targetPct: 35,
  recoveryExit: false,
  dailyLossLimit: 5000,
  entryStart: '09:30',
  entryEnd: '15:00',
  eodExit: '15:15',
};

export interface AuditLogItem {
  id: string;
  at: number;
  level: 'INFO' | 'SIGNAL' | 'ORDER' | 'EXIT' | 'WARN' | 'ERROR';
  message: string;
}

export interface BreakdownStateFile {
  rev: number;
  mode: LedgerMode;
  config: BreakdownConfig;
  positions: BreakdownPosition[];
  logs: AuditLogItem[];
  date: string;
}

export type LedgerOp =
  | { op: 'open'; position: BreakdownPosition }
  | { op: 'close'; id: string; exitPrice: number; exitReason: string; at: number }
  | { op: 'updateLowsAndSl'; updates: { id: string; lowestPrice: number; trailingSl: number }[] }
  | { op: 'setConfig'; config: Partial<BreakdownConfig> }
  | { op: 'setMode'; mode: LedgerMode }
  | { op: 'addLog'; item: AuditLogItem }
  | { op: 'clearLogs' }
  | { op: 'resetSim' };

export class LedgerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);

/** IST calendar day (YYYY-MM-DD) of an epoch-ms instant — the shared helper, re-exported for this desk. */
export { istDayOf };

/** Underlyings this desk can order (NSE_FNO / BSE_FNO on Dhan, nse_fo / bse_fo on Kotak). */
export const ALLOWED_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
/** Brokers REAL orders can go to; every other broker is SIM-only here. */
export const REAL_BROKERS = ['dhan', 'kotak'] as const;
export const MAX_LOTS_PER_TRADE = 20;

const clampNum = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/**
 * Keeps only known config keys with sane values; anything malformed is dropped (never coerced to a default),
 * so a bad patch cannot move a risk limit. Time-window order is checked against the merged result by the caller.
 */
export function sanitizeConfigPatch(patch: unknown): Partial<BreakdownConfig> {
  const out: Partial<BreakdownConfig> = {};
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.engineActive === 'boolean') out.engineActive = p.engineActive;
  if (typeof p.recoveryExit === 'boolean') out.recoveryExit = p.recoveryExit;
  if (p.timeframe === 1 || p.timeframe === 3 || p.timeframe === 5) out.timeframe = p.timeframe;
  if (p.trendMode === 'AUTO' || p.trendMode === 'BYPASS' || p.trendMode === 'CE_ONLY' || p.trendMode === 'PE_ONLY') {
    out.trendMode = p.trendMode;
  }
  const int = (k: 'strikeWindow' | 'maxConcurrent' | 'maxSameSide' | 'lotsPerTrade', lo: number, hi: number) => {
    const n = clampNum(p[k], lo, hi);
    if (n !== undefined) out[k] = Math.round(n);
  };
  int('strikeWindow', 2, 10);
  int('maxConcurrent', 1, 5);
  int('maxSameSide', 1, 5);
  int('lotsPerTrade', 1, MAX_LOTS_PER_TRADE);
  const num = (k: 'slPct' | 'trailPct' | 'targetPct' | 'dailyLossLimit', lo: number, hi: number) => {
    const n = clampNum(p[k], lo, hi);
    if (n !== undefined) out[k] = n;
  };
  num('slPct', 5, 100);
  num('trailPct', 5, 50);
  num('targetPct', 0, 90);
  num('dailyLossLimit', 1000, 10_000_000);
  for (const k of ['entryStart', 'entryEnd', 'eodExit'] as const) {
    if (isHHMM(p[k])) out[k] = p[k] as string;
  }
  return out;
}

/** entryStart < entryEnd < eodExit, or the time rules would fire exits/entries at nonsense moments. */
export function timesInOrder(c: Pick<BreakdownConfig, 'entryStart' | 'entryEnd' | 'eodExit'>): boolean {
  return isHHMM(c.entryStart) && isHHMM(c.entryEnd) && isHHMM(c.eodExit) && c.entryStart < c.entryEnd && c.entryEnd < c.eodExit;
}

const TIME_KEYS = ['entryStart', 'entryEnd', 'eodExit'] as const;

/**
 * A stored config made safe to run: unknown/malformed values fall back to defaults, and a time window that is out of
 * order (e.g. a "9:30" saved by the old per-keystroke input) is reset to the default window as a whole. Used on every
 * read, so a bad file can never block later writes such as the engine halt.
 */
export function normalizeConfig(raw: unknown): BreakdownConfig {
  const merged: BreakdownConfig = { ...DEFAULT_CONFIG, ...sanitizeConfigPatch(raw) };
  if (!timesInOrder(merged)) {
    for (const k of TIME_KEYS) merged[k] = DEFAULT_CONFIG[k];
  }
  return merged;
}

function validateNewPosition(p: BreakdownPosition): void {
  const bad = (m: string): never => {
    throw new LedgerError(`invalid position: ${m}`, 400);
  };
  if (!p || typeof p !== 'object') bad('missing');
  if (typeof p.id !== 'string' || p.id.length < 8 || p.id.length > 64) bad('id');
  if (p.mode !== 'SIM' && p.mode !== 'REAL') bad('mode');
  if (p.broker !== 'dhan' && p.broker !== 'kotak' && p.broker !== 'zerodha') bad('broker');
  if (!(ALLOWED_UNDERLYINGS as readonly string[]).includes(p.underlying)) bad('underlying');
  if (p.mode === 'REAL' && !(REAL_BROKERS as readonly string[]).includes(p.broker)) bad('REAL supports Dhan and Kotak only');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.expiry))) bad('expiry');
  if (p.option !== 'CE' && p.option !== 'PE') bad('option');
  if (!(Number(p.strike) > 0)) bad('strike');
  if (!Number.isInteger(p.lotSize) || p.lotSize <= 0) bad('lotSize');
  if (!Number.isInteger(p.qty) || p.qty <= 0 || p.qty % p.lotSize !== 0 || p.qty / p.lotSize > MAX_LOTS_PER_TRADE) bad('qty');
  for (const k of ['entryPrice', 'lowestPrice', 'initialSl', 'trailingSl'] as const) {
    if (!(Number(p[k]) > 0)) bad(k);
  }
  if (p.status !== 'OPEN') bad('status');
  // The contract handle the exit will use: Dhan = numeric security id, every other broker = trading symbol.
  if (p.mode === 'REAL' && p.broker === 'dhan' && !p.securityId) bad('securityId');
  if (p.mode === 'REAL' && p.broker === 'kotak' && !p.symbol) bad('symbol');
}

export const pnlMultiplier = (underlying: string, broker: 'dhan' | 'kotak' | 'zerodha' = 'dhan'): number =>
  broker === 'kotak' ? 1 : MCX_LOT_MULTIPLIER[underlying] ?? 1;

/**
 * Calculates current P&L for a short position (short gains when price drops).
 */
export function legPnl(p: BreakdownPosition, ltp: number | null): number | null {
  let open: number | null = 0;
  if (p.qty > 0) {
    if (ltp == null || !(ltp > 0)) open = null;
    else open = (p.entryPrice - ltp) * p.qty * pnlMultiplier(p.underlying, p.broker);
  }
  return open == null ? null : open + p.realized;
}

export function contractKey(
  p: Pick<BreakdownPosition, 'mode' | 'underlying' | 'expiry' | 'option' | 'strike' | 'broker'>,
): string {
  return `${p.mode}|${p.broker ?? 'dhan'}|${p.underlying}|${p.expiry}|${p.option}|${p.strike}`;
}

export function applyOp(file: BreakdownStateFile, op: LedgerOp): BreakdownStateFile {
  const positions = file.positions.map((p) => ({ ...p }));
  const logs = [...file.logs];

  switch (op.op) {
    case 'open': {
      validateNewPosition(op.position);
      const key = contractKey(op.position);
      const existing = positions.find((p) => p.status === 'OPEN' && contractKey(p) === key);
      if (existing) {
        throw new LedgerError(`contract ${key} is already open in position ${existing.id}`, 409);
      }
      positions.unshift(op.position);
      return {
        ...file,
        rev: file.rev + 1,
        positions,
      };
    }

    case 'close': {
      const idx = positions.findIndex((p) => p.id === op.id);
      if (idx === -1) throw new LedgerError(`position ${op.id} not found`, 404);
      const p = positions[idx];
      if (p.status === 'CLOSED') return file;
      if (!(Number(op.exitPrice) > 0)) throw new LedgerError('exitPrice must be a positive number', 400);

      const realizedDelta = (p.entryPrice - op.exitPrice) * p.qty * pnlMultiplier(p.underlying, p.broker);
      const closedPos: BreakdownPosition = {
        ...p,
        status: 'CLOSED',
        qty: 0,
        closedAt: op.at,
        exitPrice: op.exitPrice,
        exitReason: op.exitReason,
        realized: Number((p.realized + realizedDelta).toFixed(2)),
      };
      positions[idx] = closedPos;
      return {
        ...file,
        rev: file.rev + 1,
        positions,
      };
    }

    case 'updateLowsAndSl': {
      let changed = false;
      for (const u of op.updates) {
        const p = positions.find((x) => x.id === u.id && x.status === 'OPEN');
        if (p) {
          // Down-only: a stop never loosens and the low-water mark never rises, whatever the caller sends.
          const low = Number(u.lowestPrice) > 0 ? Math.min(p.lowestPrice, Number(u.lowestPrice)) : p.lowestPrice;
          const sl = Number(u.trailingSl) > 0 ? Math.min(p.trailingSl, Number(u.trailingSl)) : p.trailingSl;
          if (p.lowestPrice !== low || p.trailingSl !== sl) {
            p.lowestPrice = low;
            p.trailingSl = sl;
            changed = true;
          }
        }
      }
      if (!changed) return file;
      return {
        ...file,
        rev: file.rev + 1,
        positions,
      };
    }

    case 'setConfig': {
      const patch = sanitizeConfigPatch(op.config);
      const merged = { ...normalizeConfig(file.config), ...patch };
      // Only a patch that edits a time is checked against the window, so a non-time write (the engine halt above
      // all) is never refused because of the times. A time edit that breaks the order is refused whole.
      if (TIME_KEYS.some((k) => k in patch) && !timesInOrder(merged)) {
        throw new LedgerError('times must satisfy entryStart < entryEnd < eodExit (HH:MM)', 400);
      }
      return {
        ...file,
        rev: file.rev + 1,
        config: merged,
      };
    }

    case 'setMode': {
      if (op.mode !== 'SIM' && op.mode !== 'REAL') throw new LedgerError('mode must be SIM or REAL', 400);
      return {
        ...file,
        rev: file.rev + 1,
        mode: op.mode,
      };
    }

    case 'addLog': {
      const item = op.item;
      if (!item || typeof item.message !== 'string' || typeof item.id !== 'string') throw new LedgerError('invalid log item', 400);
      logs.unshift({ ...item, message: item.message.slice(0, 500) });
      if (logs.length > 200) logs.pop();
      return {
        ...file,
        rev: file.rev + 1,
        logs,
      };
    }

    case 'clearLogs': {
      return {
        ...file,
        rev: file.rev + 1,
        logs: [],
      };
    }

    case 'resetSim': {
      const retained = positions.filter((p) => p.mode !== 'SIM');
      return {
        ...file,
        rev: file.rev + 1,
        positions: retained,
      };
    }

    default:
      return file;
  }
}
