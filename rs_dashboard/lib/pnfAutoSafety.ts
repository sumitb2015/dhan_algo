// Renko AUTO risk gates (2026-11-18, from the /renko review): one pure place for the three rules the page, the ledger route, the server engine
// and the server guard watcher all apply, so they cannot drift.
//
//  1. A REAL arming of a rule with no stop of its own (Supertrend, N-brick, N-brick trend) needs the chart's MTM guard ON with a stop-loss,
//     synced to the server (debug/auto_server_guards.json): the guard is that rule's only loss limit.
//  2. On the Renko page an NRML NIFTY option is carried overnight only while such a guard covers it; without one it gets the NRML end-of-day
//     exit, and a position already carried whose guard has gone is closed at the next open (carryLapsed).
//  3. Daily limits per chart (max realised loss, max trades, max losses in a row): once one is reached the chart takes no new entry today.
// Pure: no I/O, no clock (tested in lib/pnfAutoSafety.test.ts).
import { carriesOvernight } from './pnfAuto.ts';
import { istDateIso } from './nseHolidays.ts';
import type { AutoRow } from './pnfAutoLedger.ts';
import type { Target } from './pnfTarget.ts';
import type { ServerGuardCfg } from './autoServerGuard.ts';

/** Rules that carry their own protective stop on the row (Two-back / One-back): they arm without a guard. */
export const RULES_WITH_OWN_STOP: readonly string[] = ['twoback', 'oneback'];

/**
 * Does this arming need an MTM-guard stop-loss? Only a REAL arming on the Renko page of a rule with no stop of its own. An arming with no
 * rule saved reads as the default rule (Supertrend), which has none.
 */
export function armNeedsGuardStop(scope: string, arm: { mode: string; rule?: string }): boolean {
  return scope === 'renko' && arm.mode === 'REAL' && !RULES_WITH_OWN_STOP.includes(arm.rule ?? '');
}

/** The stop-loss levels of a guard (the card's or the server copy's). */
export type StopLevels = { stop?: number | null; stopBoxes?: number | null };

/**
 * Does a guard with these levels bound the loss? A rupee stop always does. A box stop does only on a contract chart whose box size is known
 * (`boxPts`): an index chart's guard is rupees only (a box there is an index move, not the option's premium), and with no box size the
 * server cannot turn boxes into rupees, so it would not enforce them.
 */
export function levelsHaveStop(levels: StopLevels | null | undefined, opts: { index: boolean; boxPts: number | null }): boolean {
  if (!levels) return false;
  if (Number(levels.stop) > 0) return true;
  return !opts.index && Number(levels.stopBoxes) > 0 && opts.boxPts !== null && opts.boxPts > 0;
}

/**
 * Why this server guard copy does NOT bound the loss for this broker and mode, or null when it does (ON, same broker and mode, with a
 * stop-loss it can enforce). The text names what is missing, for the arming refusal and the engine's switch-off line.
 */
export function guardStopProblem(cfg: ServerGuardCfg | undefined | null, want: { broker: string; mode: string; index: boolean }): string | null {
  if (!cfg || !cfg.on) return 'the MTM guard is not on the server (switched off, or its copy has not arrived yet)';
  if (cfg.broker !== want.broker || cfg.mode !== want.mode) return `the server's MTM guard is for ${cfg.broker} ${cfg.mode}, not ${want.broker} ${want.mode}`;
  if (!levelsHaveStop(cfg.levels, { index: want.index, boxPts: cfg.boxPts })) {
    return !want.index && Number(cfg.levels.stopBoxes) > 0 ? 'the server\'s MTM guard has a box stop-loss but no box size to enforce it with' : 'the server\'s MTM guard has no stop-loss';
  }
  return null;
}

/** Is this server guard copy ON for exactly this broker and mode, with a stop-loss it can enforce? */
export function guardStopOk(cfg: ServerGuardCfg | undefined | null, want: { broker: string; mode: string; index: boolean }): boolean {
  return guardStopProblem(cfg, want) === null;
}

/** What to tell the user when a REAL arming has no guard stop. */
export const NEEDS_STOP_TEXT = 'REAL AUTO on a rule with no stop of its own (Supertrend, N-brick, trend) needs the MTM guard ON with a stop-loss first: open the MTM Guard card, set a stop-loss and click Switch on';

type CarryRow = Pick<AutoRow, 'product' | 'target' | 'broker' | 'mode'> & { traded?: { target: Target } };

/**
 * Is this open row carried overnight? An NRML NIFTY option (carriesOvernight) - and on the Renko page only while the server holds a guard with
 * a stop-loss for its chart, broker and mode, so an overnight gap with no loss limit is never taken. The P&F page keeps the plain rule.
 * The one decision the engine and the guard watcher both use.
 */
export function carryAllowed(scope: string, row: CarryRow, nowS: number, cfg: ServerGuardCfg | undefined | null): boolean {
  if (!carriesOvernight(row, nowS)) return false;
  return scope !== 'renko' || guardStopOk(cfg, { broker: row.broker, mode: row.mode, index: !!row.traded });
}

/**
 * A Renko position carried from an earlier day whose guard stop-loss is gone (switched off overnight, moved to another broker / mode): it
 * has no loss limit for the new session, so it is closed as soon as the market is open instead of waiting for the end-of-day minute.
 */
export function carryLapsed(scope: string, row: CarryRow & Pick<AutoRow, 'day' | 'entryT'>, nowS: number, cfg: ServerGuardCfg | undefined | null): boolean {
  return scope === 'renko' && row.day !== istDateIso(nowS * 1000) && carriesOvernight(row, row.entryT) && !carryAllowed(scope, row, nowS, cfg);
}

/** Per-chart daily limits saved with the arming. Each one is optional; absent = no limit. */
export interface AutoLimits {
  /** Realised loss for the day (rupees, positive): no new entry once the chart's closed trades have lost this much. */
  maxLoss?: number;
  /** Trades opened today: no new entry once this many have been taken. */
  maxTrades?: number;
  /** Losing trades in a row (today): no new entry after this many. */
  maxLosses?: number;
}

export const LIMIT_MAX_LOSS_MAX = 10_000_000;
export const LIMIT_MAX_TRADES_MAX = 200;
export const LIMIT_MAX_LOSSES_MAX = 50;

/** A well-formed limits object, or undefined when none is set. Out-of-range fields are dropped (never read as a looser limit). */
export function parseLimits(v: unknown): AutoLimits | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: AutoLimits = {};
  const loss = Number(o.maxLoss);
  if (o.maxLoss !== undefined && o.maxLoss !== null && Number.isFinite(loss) && loss > 0 && loss <= LIMIT_MAX_LOSS_MAX) out.maxLoss = loss;
  const int = (x: unknown, max: number) => (Number.isInteger(x) && (x as number) >= 1 && (x as number) <= max ? (x as number) : undefined);
  const trades = int(o.maxTrades, LIMIT_MAX_TRADES_MAX);
  if (trades !== undefined) out.maxTrades = trades;
  const losses = int(o.maxLosses, LIMIT_MAX_LOSSES_MAX);
  if (losses !== undefined) out.maxLosses = losses;
  return Object.keys(out).length ? out : undefined;
}

/** A row that was a trade: anything opened. A refused entry, or one the user resolved flat from an unknown entry, never opened. */
const traded = (r: Pick<AutoRow, 'state' | 'reason' | 'neverOpened'>) => !(r.state === 'closed' && (r.reason === 'refused' || r.neverOpened));

/**
 * The chart's day so far in one mode: trades OPENED today (by entry day), and the realised P&L and current run of losing trades of the trades
 * CLOSED today (by exit day: a carried trade opened yesterday that lost today counts toward today's limit).
 */
export function dayRecord(rows: AutoRow[], chart: 1 | 2, mode: string, day: string): { trades: number; pnl: number; lossStreak: number } {
  const mine = rows.filter(r => r.chart === chart && r.mode === mode && traded(r));
  const opened = mine.filter(r => r.day === day);
  const closed = mine.filter(r => r.state === 'closed' && r.exitT !== undefined && istDateIso(r.exitT * 1000) === day).sort((a, b) => (a.exitT ?? 0) - (b.exitT ?? 0));
  let streak = 0;
  for (let i = closed.length - 1; i >= 0 && (closed[i].pnl ?? 0) < 0; i--) streak++;
  return { trades: opened.length, pnl: closed.reduce((s, r) => s + (r.pnl ?? 0), 0), lossStreak: streak };
}

/** Why the chart may not open another trade today, or null. Read before every entry (the open row, if any, is never touched). */
export function dayLimitHit(rows: AutoRow[], chart: 1 | 2, mode: string, day: string, limits: AutoLimits | undefined): string | null {
  if (!limits) return null;
  const d = dayRecord(rows, chart, mode, day);
  const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  if (limits.maxLoss !== undefined && d.pnl <= -limits.maxLoss) return `daily loss limit reached (${rs(-d.pnl)} lost today, limit ${rs(limits.maxLoss)})`;
  if (limits.maxTrades !== undefined && d.trades >= limits.maxTrades) return `daily trade limit reached (${d.trades} of ${limits.maxTrades} trades today)`;
  if (limits.maxLosses !== undefined && d.lossStreak >= limits.maxLosses) return `${d.lossStreak} losing trades in a row (limit ${limits.maxLosses})`;
  return null;
}

/** "max loss ₹5,000 · 10 trades · 3 losses in a row", for the arming's log line and the controls' tooltip. */
export function limitsText(l: AutoLimits | undefined): string {
  if (!l) return 'no daily limits';
  const parts: string[] = [];
  if (l.maxLoss !== undefined) parts.push(`max loss ₹${l.maxLoss.toLocaleString('en-IN')}`);
  if (l.maxTrades !== undefined) parts.push(`${l.maxTrades} trades`);
  if (l.maxLosses !== undefined) parts.push(`${l.maxLosses} losses in a row`);
  return parts.join(' · ');
}
