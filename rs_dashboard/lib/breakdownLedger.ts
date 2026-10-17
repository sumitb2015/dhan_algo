/**
 * Breakdown Scalper Ledger (/breakdown-scalper)
 *
 * Dedicated state and position tracker saved to debug/breakdown_scalper_state.json.
 * Tracks active and closed short positions in both SIM (paper) and REAL mode.
 * Exits are sized from the ledger's own qty, never the raw broker net quantity.
 */

import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import type { TrendFilterMode } from './breakdownScalper.ts';

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
          if (p.lowestPrice !== u.lowestPrice || p.trailingSl !== u.trailingSl) {
            p.lowestPrice = u.lowestPrice;
            p.trailingSl = u.trailingSl;
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
      return {
        ...file,
        rev: file.rev + 1,
        config: { ...file.config, ...op.config },
      };
    }

    case 'setMode': {
      return {
        ...file,
        rev: file.rev + 1,
        mode: op.mode,
      };
    }

    case 'addLog': {
      logs.unshift(op.item);
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
