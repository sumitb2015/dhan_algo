/**
 * Algo Lab ledger: one file per strategy (debug/algo_lab/<key>_state.json), changed only through ops applied by
 * the pure applyOp below (app/api/algo-lab/[strategy]/state serialises and writes them atomically).
 *
 * The server enforces the safety properties itself, whatever the browser sends: one open position per contract per
 * strategy, stops that only tighten and best prices that only improve (by side), sane quantities, validated config.
 */

import { applyConfigPatch, MAX_LOTS_PER_TRADE, normalizeConfig } from './configSchema.ts';
import { clampStop, bestOf, pnlPts, r2 } from './risk.ts';
import {
  AlgoError,
  type AlgoConfig,
  type AlgoPosition,
  type AlgoStateFile,
  type AuditLogItem,
  type ConfigField,
  type Json,
  type LedgerMode,
} from './types.ts';

export type LedgerOp =
  | { op: 'open'; position: AlgoPosition }
  | { op: 'close'; id: string; exitPrice: number; exitKind: string; exitReason: string; at: number }
  | { op: 'updateRisk'; updates: { id: string; stop: number; best: number; state?: Json; openPnl?: number | null }[] }
  | { op: 'setConfig'; config: Partial<AlgoConfig> }
  | { op: 'setMode'; mode: LedgerMode }
  | { op: 'addLog'; item: AuditLogItem }
  | { op: 'clearLogs' }
  | { op: 'resetSim' };

export const REAL_BROKERS = ['dhan', 'kotak'] as const;
const MAX_LOGS = 200;
const MAX_POSITIONS = 500;

export const contractKeyOf = (p: Pick<AlgoPosition, 'underlying' | 'expiry'> & { strike: number; option: string }) =>
  `${p.underlying}|${p.expiry}|${p.strike}${p.option}`;

export const legOf = (p: AlgoPosition) => p.legs[0];

/** Mark-to-market of an open position at `ltp` (null when unpriced). */
export function openPnlOf(p: AlgoPosition, ltp: number | null): number | null {
  if (ltp == null || !(ltp > 0)) return null;
  const l = legOf(p);
  return r2(pnlPts(p.side, l.entryPrice, ltp) * l.qty);
}

export function emptyState(strategy: string, defaults: AlgoConfig): AlgoStateFile {
  return { rev: 0, strategy, mode: 'SIM', config: defaults, positions: [], logs: [] };
}

/** A complete, valid state file from whatever is stored. */
export function normalizeState(strategy: string, fields: ConfigField[], defaults: AlgoConfig, raw: unknown): AlgoStateFile {
  const r = raw && typeof raw === 'object' ? (raw as Partial<AlgoStateFile>) : {};
  return {
    rev: Number(r.rev) || 0,
    strategy,
    mode: r.mode === 'REAL' ? 'REAL' : 'SIM',
    config: normalizeConfig(fields, defaults, r.config),
    positions: Array.isArray(r.positions) ? r.positions : [],
    logs: Array.isArray(r.logs) ? r.logs : [],
  };
}

const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;

function validateNew(file: AlgoStateFile, p: AlgoPosition): void {
  if (!p || typeof p !== 'object') throw new AlgoError('position required');
  if (p.strategy !== file.strategy) throw new AlgoError(`position belongs to ${p.strategy}, not ${file.strategy}`);
  if (typeof p.id !== 'string' || !p.id) throw new AlgoError('position id required');
  if (p.status !== 'OPEN') throw new AlgoError('a new position must be OPEN');
  if (p.mode !== 'SIM' && p.mode !== 'REAL') throw new AlgoError('mode must be SIM or REAL');
  if (p.mode === 'REAL' && !(REAL_BROKERS as readonly string[]).includes(p.broker)) throw new AlgoError(`REAL orders are not supported for ${p.broker}`);
  if (p.side !== 'BUY' && p.side !== 'SELL') throw new AlgoError('side must be BUY or SELL');
  if (!Array.isArray(p.legs) || p.legs.length !== 1) throw new AlgoError('v1 positions hold exactly one leg');
  const l = p.legs[0];
  if (l.side !== p.side) throw new AlgoError('leg side must match the position side');
  if (l.option !== 'CE' && l.option !== 'PE') throw new AlgoError('option must be CE or PE');
  if (!pos(l.strike) || !pos(l.entryPrice) || !pos(l.lotSize) || !pos(l.qty)) throw new AlgoError('strike, price, lot size and qty must be positive');
  if (l.qty % l.lotSize !== 0) throw new AlgoError('qty must be a whole number of lots');
  if (l.qty / l.lotSize > MAX_LOTS_PER_TRADE) throw new AlgoError(`at most ${MAX_LOTS_PER_TRADE} lots per trade`);
  if (!pos(p.stop) || !pos(p.initialStop) || !pos(p.best)) throw new AlgoError('stop and best must be positive');
  if (p.target != null && !pos(p.target)) throw new AlgoError('target must be positive or null');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.expiry)) throw new AlgoError('expiry must be YYYY-MM-DD');
}

export function applyOp(file: AlgoStateFile, op: LedgerOp, fields: ConfigField[], defaults: AlgoConfig): AlgoStateFile {
  const bump = (patch: Partial<AlgoStateFile>): AlgoStateFile => ({ ...file, ...patch, rev: file.rev + 1 });
  switch (op?.op) {
    case 'open': {
      validateNew(file, op.position);
      const p = op.position;
      const key = contractKeyOf({ ...p, ...p.legs[0] });
      const dup = file.positions.find((x) => x.status === 'OPEN' && contractKeyOf({ ...x, ...x.legs[0] }) === key);
      if (dup) throw new AlgoError(`contract ${key} is already open in position ${dup.id}`, 409);
      if (file.positions.some((x) => x.id === p.id)) throw new AlgoError(`position ${p.id} already exists`, 409);
      const opened: AlgoPosition = { ...p, realized: 0, closedAt: undefined, exitPrice: undefined };
      return bump({ positions: [opened, ...file.positions].slice(0, MAX_POSITIONS) });
    }
    case 'close': {
      const idx = file.positions.findIndex((x) => x.id === op.id);
      if (idx === -1) throw new AlgoError(`position ${op.id} not found`, 404);
      const p = file.positions[idx];
      if (p.status === 'CLOSED') return file;
      if (!pos(op.exitPrice)) throw new AlgoError('exitPrice must be a positive number');
      const l = legOf(p);
      const closed: AlgoPosition = {
        ...p,
        status: 'CLOSED',
        closedAt: Number(op.at) || Date.now(),
        exitPrice: op.exitPrice,
        exitKind: String(op.exitKind ?? 'MANUAL').slice(0, 30),
        exitReason: String(op.exitReason ?? '').slice(0, 300),
        realized: r2(pnlPts(p.side, l.entryPrice, op.exitPrice) * l.qty),
        openPnl: null,
      };
      const positions = [...file.positions];
      positions[idx] = closed;
      return bump({ positions });
    }
    case 'updateRisk': {
      if (!Array.isArray(op.updates)) throw new AlgoError('updates must be an array');
      let changed = false;
      const positions = file.positions.map((p) => {
        const u = op.updates.find((x) => x.id === p.id);
        if (!u || p.status !== 'OPEN') return p;
        // Tighten-only stop and improve-only best, whatever the caller sends.
        const stop = pos(u.stop) ? clampStop(p.side, p.stop, Number(u.stop)) : p.stop;
        const best = pos(u.best) ? bestOf(p.side, p.best, Number(u.best)) : p.best;
        const state = u.state !== undefined ? u.state : p.state;
        const openPnl = u.openPnl === undefined ? p.openPnl : typeof u.openPnl === 'number' && Number.isFinite(u.openPnl) ? r2(u.openPnl) : null;
        if (stop === p.stop && best === p.best && state === p.state && openPnl === p.openPnl) return p;
        changed = true;
        return { ...p, stop, best, state, openPnl };
      });
      return changed ? bump({ positions }) : file;
    }
    case 'setConfig':
      return bump({ config: applyConfigPatch(fields, defaults, file.config, op.config) });
    case 'setMode':
      if (op.mode !== 'SIM' && op.mode !== 'REAL') throw new AlgoError('mode must be SIM or REAL');
      return bump({ mode: op.mode });
    case 'addLog': {
      const it = op.item;
      if (!it || typeof it.id !== 'string' || typeof it.message !== 'string') throw new AlgoError('invalid log item');
      const level = (['INFO', 'WARN', 'ERROR', 'TRADE'] as const).includes(it.level) ? it.level : 'INFO';
      return bump({ logs: [{ id: it.id, at: Number(it.at) || Date.now(), level, message: it.message.slice(0, 500) }, ...file.logs].slice(0, MAX_LOGS) });
    }
    case 'clearLogs':
      return bump({ logs: [] });
    case 'resetSim':
      return bump({ positions: file.positions.filter((p) => p.mode !== 'SIM' || p.status === 'OPEN') });
    default:
      throw new AlgoError('unknown op');
  }
}
