/**
 * Breakdown Scalper Ledger (/breakdown-scalper)
 *
 * Dedicated state and position tracker saved to debug/breakdown_scalper_state.json.
 * Tracks active and closed short positions in both SIM (paper) and REAL mode.
 * Exits are sized from the ledger's own qty, never the raw broker net quantity.
 */

import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import { DEFAULT_INDEX_TREND, type TrendFilterMode } from './breakdownScalper.ts';
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
  trailStartPct: number; // default 15% profit to lock to cost & activate trail
  trailStepPts: number; // default 5 pts (for every x pts gain)
  trailByPts: number; // default 2 pts (trail SL by y pts)
  targetPct: number; // default 35%
  recoveryExit: boolean; // default false
  dailyLossLimit: number; // default ₹5,000
  hardCircuitBreaker?: boolean; // default true (emergency square off all open positions when daily loss limit is hit)
  useSupertrend?: boolean; // default true (option must close below Supertrend)
  useVwap?: boolean; // default true (option must close below VWAP)
  useEma?: boolean; // default true (option must close below EMA 20)
  stPeriod?: number; // default 10 (Supertrend ATR period)
  stMultiplier?: number; // default 2.0 (Supertrend multiplier)
  emaPeriod?: number; // default 20 (EMA period)
  /** Index (NIFTY) trend: EMA fast/slow cross on the option timeframe, optionally confirmed by a Supertrend. */
  trendEmaFast?: number; // default 9
  trendEmaSlow?: number; // default 20 (must be > trendEmaFast)
  trendUseSupertrend?: boolean; // default false (it cut profit in the backtest)
  trendStPeriod?: number; // default 7
  trendStMultiplier?: number; // default 3
  entryStart: string; // default "09:30"
  entryEnd: string; // default "15:00"
  eodExit: string; // default "15:15"
  brokerage?: number; // ₹ per executed order (default 20 for Dhan, 0 for Kotak)
  /** Backtest only: points lost on every fill (entry sells this much lower, every exit buys this much higher). Default 0. */
  slippagePts?: number;
  /**
   * Backtest only: skip entries on a contract whose previous-session bars cannot seed EMA20 on the timeframe (the options
   * DB lacks them: Wednesdays without a --fetch-warm cache, strikes far from the previous day's spot). Default false.
   */
  btWarmOnly?: boolean;
  /** Backtest only: which expired-options DB feeds the replay. Default 'dhan' (nifty_options.db). */
  dataSource?: 'dhan' | 'breeze';
  trailPct?: number; // legacy alias for trailStartPct
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
  trailStartPct: 15,
  trailStepPts: 5,
  trailByPts: 2,
  targetPct: 35,
  recoveryExit: false,
  dailyLossLimit: 5000,
  hardCircuitBreaker: true,
  useSupertrend: true,
  useVwap: true,
  useEma: true,
  stPeriod: 10,
  stMultiplier: 2.0,
  emaPeriod: 20,
  trendEmaFast: DEFAULT_INDEX_TREND.emaFast,
  trendEmaSlow: DEFAULT_INDEX_TREND.emaSlow,
  trendUseSupertrend: DEFAULT_INDEX_TREND.useSupertrend,
  trendStPeriod: DEFAULT_INDEX_TREND.stPeriod,
  trendStMultiplier: DEFAULT_INDEX_TREND.stMultiplier,
  entryStart: '09:30',
  entryEnd: '15:00',
  eodExit: '15:15',
  brokerage: 20,
  trailPct: 15,
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
  if (typeof p.hardCircuitBreaker === 'boolean') out.hardCircuitBreaker = p.hardCircuitBreaker;
  if (typeof p.useSupertrend === 'boolean') out.useSupertrend = p.useSupertrend;
  if (typeof p.useVwap === 'boolean') out.useVwap = p.useVwap;
  if (typeof p.useEma === 'boolean') out.useEma = p.useEma;
  if (typeof p.trendUseSupertrend === 'boolean') out.trendUseSupertrend = p.trendUseSupertrend;
  if (typeof p.btWarmOnly === 'boolean') out.btWarmOnly = p.btWarmOnly;
  if (p.dataSource === 'dhan' || p.dataSource === 'breeze') out.dataSource = p.dataSource;
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
  const indInt = (k: 'stPeriod' | 'emaPeriod', lo: number, hi: number) => {
    const n = clampNum(p[k], lo, hi);
    if (n !== undefined) out[k] = Math.round(n);
  };
  indInt('stPeriod', 2, 50);
  indInt('emaPeriod', 3, 200);
  const trendInt = (k: 'trendEmaFast' | 'trendEmaSlow' | 'trendStPeriod', lo: number, hi: number) => {
    const n = clampNum(p[k], lo, hi);
    if (n !== undefined) out[k] = Math.round(n);
  };
  trendInt('trendEmaFast', 2, 100);
  trendInt('trendEmaSlow', 3, 200);
  trendInt('trendStPeriod', 2, 50);
  const trendMult = clampNum(p.trendStMultiplier, 0.5, 10);
  if (trendMult !== undefined) out.trendStMultiplier = trendMult;
  const stMultVal = clampNum(p.stMultiplier ?? (p as Record<string, unknown>).stMult, 0.5, 10);
  if (stMultVal !== undefined) out.stMultiplier = stMultVal;
  const num = (k: 'slPct' | 'trailPct' | 'trailStartPct' | 'trailStepPts' | 'trailByPts' | 'targetPct' | 'dailyLossLimit' | 'brokerage' | 'slippagePts', lo: number, hi: number) => {
    const n = clampNum(p[k], lo, hi);
    if (n !== undefined) out[k] = n;
  };
  num('slPct', 5, 100);
  num('trailStartPct', 5, 50);
  num('trailStepPts', 0.5, 50);
  num('trailByPts', 0.5, 50);
  num('trailPct', 5, 50);
  num('targetPct', 0, 90);
  num('dailyLossLimit', 1000, 10_000_000);
  num('brokerage', 0, 100);
  num('slippagePts', 0, 10);
  // Keep legacy trailPct and new trailStartPct synced
  if (out.trailStartPct === undefined && out.trailPct !== undefined) {
    out.trailStartPct = out.trailPct;
  } else if (out.trailStartPct !== undefined && out.trailPct === undefined) {
    out.trailPct = out.trailStartPct;
  }
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
  if (merged.trailStartPct === undefined) {
    merged.trailStartPct = merged.trailPct ?? DEFAULT_CONFIG.trailStartPct;
  }
  if (merged.trailStepPts === undefined) {
    merged.trailStepPts = DEFAULT_CONFIG.trailStepPts;
  }
  if (merged.trailByPts === undefined) {
    merged.trailByPts = DEFAULT_CONFIG.trailByPts;
  }
  if (merged.brokerage === undefined) {
    merged.brokerage = DEFAULT_CONFIG.brokerage;
  }
  if (merged.hardCircuitBreaker === undefined) {
    merged.hardCircuitBreaker = DEFAULT_CONFIG.hardCircuitBreaker;
  }
  if (merged.useSupertrend === undefined) {
    merged.useSupertrend = DEFAULT_CONFIG.useSupertrend;
  }
  if (merged.useVwap === undefined) {
    merged.useVwap = DEFAULT_CONFIG.useVwap;
  }
  if (merged.useEma === undefined) {
    merged.useEma = DEFAULT_CONFIG.useEma;
  }
  if (merged.stPeriod === undefined) {
    merged.stPeriod = DEFAULT_CONFIG.stPeriod;
  }
  if (merged.stMultiplier === undefined) {
    merged.stMultiplier = DEFAULT_CONFIG.stMultiplier;
  }
  for (const k of ['trendEmaFast', 'trendEmaSlow', 'trendUseSupertrend', 'trendStPeriod', 'trendStMultiplier'] as const) {
    if (merged[k] === undefined) (merged as unknown as Record<string, unknown>)[k] = DEFAULT_CONFIG[k];
  }
  // A fast EMA that is not faster than the slow one is no cross: reset the pair as a whole.
  if ((merged.trendEmaFast as number) >= (merged.trendEmaSlow as number)) {
    merged.trendEmaFast = DEFAULT_CONFIG.trendEmaFast;
    merged.trendEmaSlow = DEFAULT_CONFIG.trendEmaSlow;
  }
  if (merged.emaPeriod === undefined) {
    merged.emaPeriod = DEFAULT_CONFIG.emaPeriod;
  }
  merged.trailPct = merged.trailStartPct;
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
