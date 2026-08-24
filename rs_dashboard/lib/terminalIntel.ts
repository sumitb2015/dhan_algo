/**
 * Derived intelligence for the Intraday Terminal.
 *
 * Everything here is computed in the browser from the payload that
 * /api/intraday-terminal already returns — the Python strategy is not aware of
 * any of it. Keep these functions pure (no React, no fetch, no clock reads
 * inside): the components memoise them, and a pure module stays testable.
 */

import {
  CONDITION_NAMES, HARD_GATES,
  type ConditionName, type TerminalCandidate, type TerminalOrder, type TerminalState,
} from './terminalTypes';

export type Tone = 'up' | 'down' | 'neutral' | 'warn';

/** Basis points of price vs session VWAP — the blotter's primary edge column. */
export function vwapBps(c: TerminalCandidate): number {
  if (!c.vwap || !c.price) return 0;
  return ((c.price - c.vwap) / c.vwap) * 10000;
}

// ── Regime ───────────────────────────────────────────────────────────────────

export interface Regime {
  /** 0-100 composite of the three breadth legs. */
  score: number;
  label: 'RISK-ON' | 'MIXED' | 'RISK-OFF';
  tone: Tone;
  /** Universe size the breadth was measured over. */
  universe: number;
  aboveVwapPct: number;
  stBullPct: number;
  rsDayPct: number;
  meanScore: number;
  tradeable: number;
}

/**
 * Breadth of the scanned universe, not of the index.
 *
 * This strategy is long-only and needs price above VWAP, a bullish 5m Supertrend
 * and positive day-RS. So the honest "can this thing trade right now" reading is
 * how much of its own universe satisfies those three, not what NIFTY did.
 */
export function regime(state: TerminalState | null): Regime | null {
  const list = state?.candidates ?? [];
  if (!list.length) return null;

  const n = list.length;
  const pct = (f: (c: TerminalCandidate) => boolean) => (list.filter(f).length / n) * 100;

  const aboveVwapPct = pct((c) => !!c.conditions?.above_vwap);
  const stBullPct = pct((c) => !!c.conditions?.st_bull_htf);
  const rsDayPct = pct((c) => !!c.conditions?.rs_day_ok);
  const score = (aboveVwapPct + stBullPct + rsDayPct) / 3;

  return {
    score,
    label: score >= 55 ? 'RISK-ON' : score >= 30 ? 'MIXED' : 'RISK-OFF',
    tone: score >= 55 ? 'up' : score >= 30 ? 'warn' : 'down',
    universe: n,
    aboveVwapPct,
    stBullPct,
    rsDayPct,
    meanScore: list.reduce((s, c) => s + (c.score || 0), 0) / n,
    tradeable: list.filter((c) => c.gated).length,
  };
}

// ── Gate blockers ────────────────────────────────────────────────────────────

export interface GateBlocker {
  name: ConditionName;
  hard: boolean;
  failing: number;
  pct: number;
  /** Names this condition is the SOLE remaining hard blocker for. */
  soleBlockFor: number;
}

/**
 * Which condition is keeping the book flat.
 *
 * Hard gates first, then failure count: a soft condition failing on 40 names
 * costs nothing, a hard gate failing on 40 names is the whole story.
 */
export function gateBlockers(state: TerminalState | null): GateBlocker[] {
  const list = state?.candidates ?? [];
  if (!list.length) return [];

  const sole = new Map<ConditionName, number>();
  for (const c of list) {
    const blocked = (c.blocked_by ?? []).filter((b) => HARD_GATES.includes(b));
    if (blocked.length === 1) sole.set(blocked[0], (sole.get(blocked[0]) ?? 0) + 1);
  }

  return CONDITION_NAMES.map((name) => {
    const failing = list.filter((c) => !c.conditions?.[name]).length;
    return {
      name,
      hard: HARD_GATES.includes(name),
      failing,
      pct: (failing / list.length) * 100,
      soleBlockFor: sole.get(name) ?? 0,
    };
  }).sort((a, b) => Number(b.hard) - Number(a.hard) || b.failing - a.failing);
}

// ── Near miss ────────────────────────────────────────────────────────────────

export interface NearMiss {
  symbol: string;
  score: number;
  blocker: ConditionName;
}

/**
 * Names one hard gate away from being tradeable, best score first.
 *
 * These are invisible in the raw blotter (just another dimmed row) but they are
 * what the next tick is most likely to turn into an order.
 */
export function nearMiss(state: TerminalState | null, limit = 8): NearMiss[] {
  const list = state?.candidates ?? [];
  return list
    .filter((c) => !c.gated)
    .map((c) => ({ c, hard: (c.blocked_by ?? []).filter((b) => HARD_GATES.includes(b)) }))
    .filter((x) => x.hard.length === 1)
    .sort((a, b) => b.c.score - a.c.score)
    .slice(0, limit)
    .map((x) => ({ symbol: x.c.symbol, score: x.c.score, blocker: x.hard[0] }));
}

/** Symbols one hard gate away — used to mark blotter rows. */
export function nearMissSymbols(state: TerminalState | null): Set<string> {
  return new Set(nearMiss(state, Number.MAX_SAFE_INTEGER).map((n) => n.symbol));
}

// ── Sector heat ──────────────────────────────────────────────────────────────

export interface SectorRow {
  sector: string;
  count: number;
  meanScore: number;
  gated: number;
  open: number;
  atCap: boolean;
}

export function sectorHeat(state: TerminalState | null): SectorRow[] {
  const list = state?.candidates ?? [];
  if (!list.length) return [];

  const cap = state?.risk.max_per_sector ?? 0;
  const openBySector = new Map<string, number>();
  for (const p of state?.positions ?? []) {
    openBySector.set(p.sector, (openBySector.get(p.sector) ?? 0) + 1);
  }

  const bucket = new Map<string, TerminalCandidate[]>();
  for (const c of list) {
    const key = c.sector || '—';
    const arr = bucket.get(key);
    if (arr) arr.push(c); else bucket.set(key, [c]);
  }

  return [...bucket.entries()]
    .map(([sector, cs]) => {
      const open = openBySector.get(sector) ?? 0;
      return {
        sector,
        count: cs.length,
        meanScore: cs.reduce((s, c) => s + (c.score || 0), 0) / cs.length,
        gated: cs.filter((c) => c.gated).length,
        open,
        atCap: cap > 0 && open >= cap,
      };
    })
    .sort((a, b) => b.meanScore - a.meanScore);
}

// ── Session clock ────────────────────────────────────────────────────────────

export type SessionPhase = 'PRE' | 'ENTRY' | 'NO-NEW-ENTRIES' | 'SQUARE-OFF';

export interface SessionClock {
  phase: SessionPhase;
  label: string;
  /** Minutes until the next boundary; null once the day is done. */
  minsLeft: number | null;
  /** 0-1 progress through the entry window. */
  entryProgress: number;
  entryStart: string;
  entryCutoff: string;
  squareOff: string;
  tone: Tone;
}

const toMins = (hhmm: string): number => {
  const [h, m] = (hhmm ?? '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

/**
 * Where we are in the trading day.
 *
 * `nowMins` is passed in rather than read from the clock so this stays pure and
 * the caller controls the tick rate.
 */
export function sessionClock(state: TerminalState | null, nowMins: number): SessionClock | null {
  const s = state?.session;
  if (!s) return null;
  const start = toMins(s.entry_start);
  const cutoff = toMins(s.entry_cutoff);
  const off = toMins(s.square_off);
  if (!Number.isFinite(start) || !Number.isFinite(cutoff) || !Number.isFinite(off)) return null;

  const base = {
    entryStart: s.entry_start,
    entryCutoff: s.entry_cutoff,
    squareOff: s.square_off,
    entryProgress: Math.max(0, Math.min(1, (nowMins - start) / Math.max(1, cutoff - start))),
  };

  if (nowMins < start) {
    return { ...base, entryProgress: 0, phase: 'PRE', label: 'Pre-entry', minsLeft: start - nowMins, tone: 'neutral' };
  }
  if (nowMins < cutoff) {
    return { ...base, phase: 'ENTRY', label: 'Entry window', minsLeft: cutoff - nowMins, tone: 'up' };
  }
  if (nowMins < off) {
    return { ...base, entryProgress: 1, phase: 'NO-NEW-ENTRIES', label: 'No new entries', minsLeft: off - nowMins, tone: 'warn' };
  }
  return { ...base, entryProgress: 1, phase: 'SQUARE-OFF', label: 'Square-off', minsLeft: null, tone: 'down' };
}

// ── Trade stats ──────────────────────────────────────────────────────────────

export interface TradeStats {
  closed: number;
  wins: number;
  losses: number;
  winRate: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  best: number;
  worst: number;
}

/**
 * Today's closed trades, from the append-only order log.
 *
 * Every EXIT record carries its own `entry_price`, so realised P&L per trade is
 * exact without pairing legs. Deliberately reported in rupees rather than R:
 * `stop` on an EXIT row is the *trailed* stop at exit time, so an R computed
 * from it would understate the risk taken on every trade that trailed — a
 * misleading number is worse than an absent one.
 */
export function tradeStats(orders: TerminalOrder[]): TradeStats | null {
  const exits = (orders ?? []).filter((o) => o.kind === 'EXIT');
  if (!exits.length) return null;

  let grossWin = 0, grossLoss = 0, wins = 0, losses = 0;
  let best = -Infinity, worst = Infinity;

  for (const o of exits) {
    const dir = o.side === 'SHORT' ? -1 : 1;
    const pnl = (o.price - o.entry_price) * o.qty * dir;
    if (pnl >= 0) { wins++; grossWin += pnl; } else { losses++; grossLoss += -pnl; }
    best = Math.max(best, pnl);
    worst = Math.min(worst, pnl);
  }

  const closed = exits.length;
  return {
    closed,
    wins,
    losses,
    winRate: (wins / closed) * 100,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: (grossWin - grossLoss) / closed,
    best: Number.isFinite(best) ? best : 0,
    worst: Number.isFinite(worst) ? worst : 0,
  };
}

// ── Health ───────────────────────────────────────────────────────────────────

export interface Health {
  verdict: 'OK' | 'DEGRADED' | 'STALE' | 'OFFLINE';
  tone: Tone;
  reasons: string[];
  pollLagS: number | null;
  wsHealthy: boolean;
  lastPoll: string | null;
}

/**
 * One verdict folding process liveness, feed health and UI poll staleness.
 *
 * A dead WebSocket behind a running process is the failure mode that looks fine
 * — the tables keep rendering the last known prices. Surface it explicitly.
 */
export function health(
  state: TerminalState | null,
  running: boolean,
  /** True when the dashboard's own poll has gone quiet, not the strategy's. */
  fetchStale: boolean,
): Health {
  const reasons: string[] = [];
  if (!running) reasons.push('process not running');
  if (state && state.ws_healthy === false) reasons.push('market feed unhealthy');
  if (state?.poll_lag_s != null && state.poll_lag_s > 30) {
    reasons.push(`strategy poll lag ${state.poll_lag_s.toFixed(0)}s`);
  }
  if (fetchStale) reasons.push('dashboard feed stale');

  const verdict: Health['verdict'] = !running ? 'OFFLINE'
    : fetchStale ? 'STALE'
      : reasons.length ? 'DEGRADED' : 'OK';

  return {
    verdict,
    tone: verdict === 'OK' ? 'up' : verdict === 'OFFLINE' ? 'neutral' : 'warn',
    reasons,
    pollLagS: state?.poll_lag_s ?? null,
    wsHealthy: state?.ws_healthy !== false,
    lastPoll: state?.last_poll ?? null,
  };
}
