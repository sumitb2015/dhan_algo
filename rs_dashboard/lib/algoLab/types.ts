/**
 * Algo Lab (/algo-lab): the contract every automated strategy implements, and the shared types of the ledger,
 * simulator and pages built around it.
 *
 * A strategy is pure: it receives the same AlgoCtx in the live engine and in the backtest simulator and cannot tell
 * which it runs in. The generic layers (lib/algoLab/simulator.ts, components/algoLab/LiveEngine.tsx) own fills,
 * caps, the loss limit, EOD, re-entry locks and the stop ratchet; a strategy only decides bias, candidates, entry
 * levels and how an open position's stop moves or exits.
 *
 * v1 positions hold one leg; `legs` is an array so multi-leg strategies can be added without migrating ledgers.
 */

import type { Bar } from '../volumeProfile.ts';

export type { Bar };
export type Side = 'BUY' | 'SELL';
export type OptType = 'CE' | 'PE';
export type LedgerMode = 'SIM' | 'REAL';
export type AlgoBroker = 'dhan' | 'kotak' | 'zerodha';
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Timeframe = 1 | 3 | 5;

/** Settings every strategy has; the generic engine and simulator read them. Strategy fields are added on top. */
export interface BaseConfig {
  engineActive: boolean;
  timeframe: Timeframe;
  /** Contracts scanned: ATM +- N strikes (the options DB holds ATM +- 10). */
  strikeWindow: number;
  maxConcurrent: number;
  maxSameSide: number;
  lotsPerTrade: number;
  dailyLossLimit: number;
  entryStart: string;
  entryEnd: string;
  eodExit: string;
  /** Rupees per executed order (Dhan 20, Kotak 0). */
  brokerage: number;
  /** Backtest only: points lost on every fill. */
  slippagePts: number;
  /** Backtest only: skip entries on contracts whose previous-session bars cannot seed the indicators. */
  btWarmOnly: boolean;
}

export type ConfigValue = number | boolean | string;
export type AlgoConfig = BaseConfig & Record<string, ConfigValue>;

interface FieldBase {
  key: string;
  label: string;
  group: string;
  help?: string;
  /** Only the simulator reads it (still part of the backtest rules stamp). */
  backtestOnly?: boolean;
}
export type ConfigField =
  | (FieldBase & { kind: 'number'; min: number; max: number; step?: number; integer?: boolean; unit?: string })
  | (FieldBase & { kind: 'boolean' })
  | (FieldBase & { kind: 'select'; options: { value: string | number; label: string }[] })
  | (FieldBase & { kind: 'time' });

/** One contract as a strategy sees it at the decision time. */
export interface CtxContract {
  key: string; // "24500CE"
  strike: number;
  option: OptType;
  /** Last traded price at the decision time (backtest: last closed 1-minute bar's close). */
  ltp: number;
  /** Today's traded volume so far. */
  volume: number;
  oi: number | null;
  /** Previous session's last close / OI of the same contract (null when unknown). */
  prevClose: number | null;
  prevOi: number | null;
  /** CLOSED 1-minute bars, oldest first: previous session(s) of the same contract for warm-up, then today. */
  bars1m: Bar[];
  /** How many of bars1m are from before today (indicator warm-up). */
  warmupBars: number;
}

export interface CtxOpen {
  id: string;
  key: string;
  option: OptType;
  side: Side;
  entryPrice: number;
}

export interface AlgoCtx {
  /** Decision time: the START of the current minute, IST wall clock as epoch ms (Date.UTC of the IST stamp). */
  nowIstMs: number;
  date: string; // YYYY-MM-DD (IST)
  hm: string; // HH:MM
  underlying: string;
  expiry: string;
  lotSize: number;
  step: number;
  spot: number;
  atm: number;
  /**
   * The underlying's CLOSED 1-minute bars of today. Close-only (o = h = l = c, v = 0) in both modes: the backtest
   * store holds only the spot close, so a strategy that read the live high/low would not backtest the same.
   */
  spotBars1m: Bar[];
  /** Scanned window (ATM +- strikeWindow) plus every contract this strategy holds open. */
  contracts: Record<string, CtxContract>;
  open: CtxOpen[];
}

export interface GateResult {
  /** Short label for the bias strip ("BULLISH", "STANDBY", ...). */
  bias: string;
  tone: 'bull' | 'bear' | 'neutral';
  /** Option types a new entry may use right now. */
  allowed: OptType[];
  detail: string;
  metrics?: Record<string, number | string | null>;
}

export type CellValue = number | string | boolean | null;

export interface Candidate {
  key: string;
  strike: number;
  option: OptType;
  ltp: number;
  /** 0-100, higher first. */
  score: number;
  eligible: boolean;
  blockReason?: string;
  /** Strategy-defined display values (see StrategyDefinition.columns.scanner). Stored on the trade at entry. */
  cols: Record<string, CellValue>;
}

export interface EntryPlan {
  stop: number;
  target: number | null;
  state?: Json;
}

/** An open position as manage() sees it. */
export interface PositionView {
  id: string;
  key: string;
  strike: number;
  option: OptType;
  side: Side;
  entryPrice: number;
  /** Current stop (already ratcheted). */
  stop: number;
  initialStop: number;
  /** Best price seen since entry (SELL: lowest, BUY: highest). */
  best: number;
  target: number | null;
  state: Json;
  openedAt: number;
}

export interface ExitSignal {
  /** Strategy label, e.g. 'TARGET', 'RECOVERY'. The generic layer adds 'STOP', 'EOD', 'SESSION_END'. */
  kind: string;
  /** Price level the exit triggers at: the fill is this level clamped onto the price path. */
  level: number;
  reason: string;
}

export interface ManageResult {
  /** Proposed stop; the generic layer only ever tightens (SELL: down, BUY: up). */
  stop: number;
  state?: Json;
  /** Triggered exits other than the stop (the generic layer checks the stop itself and fills the first crossed). */
  exits?: ExitSignal[];
}

export interface Col {
  key: string;
  label: string;
  fmt?: 'num' | 'int' | 'pct' | 'text' | 'bool';
  digits?: number;
}

export interface StrategyDefinition {
  key: string; // url/file key: [a-z0-9_]+
  label: string;
  description: string;
  /** Repo-relative path of the strategy's spec. */
  docPath: string;
  side: Side;
  underlyings: string[];
  /** 'UNVALIDATED' until a backtest and forward test justify REAL money. */
  status: 'UNVALIDATED' | 'VALIDATED';
  /** Strategy-specific settings (the base settings are added by configSchema). */
  schema: ConfigField[];
  /** Defaults for schema fields, plus optional overrides of base defaults. */
  defaults: Record<string, ConfigValue>;
  /** 1-minute warm-up bars a contract needs before its signals match live (cold-entry threshold). */
  warmupBars(c: AlgoConfig): number;
  gate(ctx: AlgoCtx, c: AlgoConfig): GateResult;
  /** Ranked candidates, best first. Held contracts (ctx.open) are skipped by the engine, whatever `eligible` says. */
  scan(ctx: AlgoCtx, c: AlgoConfig, gate: GateResult): Candidate[];
  onEntry(cand: Candidate, entryPrice: number, c: AlgoConfig): EntryPlan;
  manage(pos: PositionView, px: number, ctx: AlgoCtx, c: AlgoConfig): ManageResult;
  columns: { scanner: Col[] };
}

// ── Ledger ──────────────────────────────────────────────────────────────────
export interface AlgoLeg {
  strike: number;
  option: OptType;
  side: Side;
  qty: number;
  lotSize: number;
  /** Dhan security id, or the Kotak/Zerodha trading symbol in `symbol`. */
  securityId?: string;
  symbol?: string;
  entryPrice: number;
}

export interface AlgoPosition {
  id: string;
  strategy: string;
  mode: LedgerMode;
  broker: AlgoBroker;
  tag: 'AUTO' | 'MANUAL';
  underlying: string;
  expiry: string;
  side: Side;
  legs: AlgoLeg[];
  initialStop: number;
  stop: number;
  best: number;
  target: number | null;
  state: Json;
  /** Candidate columns at entry (shown in the positions table). */
  entryCols: Record<string, CellValue>;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  closedAt?: number;
  exitPrice?: number;
  exitKind?: string;
  exitReason?: string;
  realized: number;
  /** Last open P&L the leader tab computed (account-level loss cap across strategies). */
  openPnl?: number | null;
}

export interface AuditLogItem {
  id: string;
  at: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
}

export interface AlgoStateFile {
  rev: number;
  strategy: string;
  mode: LedgerMode;
  config: AlgoConfig;
  positions: AlgoPosition[];
  logs: AuditLogItem[];
}

export class AlgoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
