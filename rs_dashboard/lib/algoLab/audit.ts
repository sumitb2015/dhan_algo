/**
 * Re-checks every stored trade against the rules and the bars it was simulated on. Pure: `loadDay` supplies a
 * session's bar file (null when missing; the fill checks then skip that session). The runner stores the result as
 * results.json `audit`, and the panel's audit card renders only that object, never hand-written text.
 */

import { hmToMin } from './bars.ts';
import { orderCost } from './costs.ts';
import { exitSideOf, pnlPts, r2 } from './risk.ts';
import { REENTRY_LOCK_MIN, type BtBar, type BtTrade, type DayData, type DayResult } from './simulator.ts';
import type { AlgoConfig, StrategyDefinition } from './types.ts';

export interface BtAuditCheck {
  id: string;
  label: string;
  rule: string;
  checked: number;
  failures: number;
  /** Up to 5 failing items, "date contract time: detail". */
  examples: string[];
}

export interface BtAudit {
  at: string;
  configKey: string;
  sessions: number;
  trades: number;
  sessionsWithBars: number;
  checks: BtAuditCheck[];
  /** Per weekday: sessions, and how many lacked the previous session for warm-up. */
  warmup: Record<string, { sessions: number; partial: number }>;
  /** Trades on contracts with fewer warm-up bars than the strategy needs: their signals came from today's bars only. */
  coldEntries: { trades: number; net: number; minBars: number };
}

export function auditResults(
  def: StrategyDefinition,
  days: DayResult[],
  config: AlgoConfig,
  configKey: string,
  loadDay: (date: string) => DayData | null,
  at = new Date().toISOString(),
): BtAudit {
  const side = def.side;
  const slip = Math.max(0, config.slippagePts);
  const eod = hmToMin(config.eodExit);
  const checks: Record<string, BtAuditCheck> = {};
  const mk = (id: string, label: string, rule: string) => (checks[id] = { id, label, rule, checked: 0, failures: 0, examples: [] });
  mk('gross', 'Gross P&L maths', `${side === 'SELL' ? '(entry − exit)' : '(exit − entry)'} × qty`);
  mk('net', 'Net P&L & costs', 'costs = Dhan F&O charges on both orders; net = gross − costs');
  mk('time', 'Chronology', 'entry ≤ exit ≤ EOD cutoff; entry inside the entry window');
  mk('levels', 'Stop & target sizing', "the strategy's onEntry levels on the decision price");
  mk('entryFill', 'Entry fill', `entry = that bar's open ${side === 'SELL' ? '−' : '+'} slippage (${slip} pt)`);
  mk('exitFill', 'Exit fill traded', 'exit (less slippage) lies inside the exit bar (low..high); EOD at the cutoff bar open');
  mk('slots', 'Max open at bar open', `positions holding a slot at the entry bar's OPEN < max open (${config.maxConcurrent})`);
  mk('side', 'Max per side at bar open', `same-side positions at the entry bar's OPEN < per side (${config.maxSameSide})`);
  mk('lock', 'Re-entry lock', `same contract not re-entered within ${REENTRY_LOCK_MIN} min of its exit`);
  const fail = (id: string, what: string) => {
    const c = checks[id];
    c.failures++;
    if (c.examples.length < 5) c.examples.push(what);
  };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  /** The exit price before slippage was applied. */
  const rawExit = (t: BtTrade) => (side === 'SELL' ? t.exitPrice - slip : t.exitPrice + slip);

  let sessionsWithBars = 0;
  let tradeCount = 0;
  const warmup: BtAudit['warmup'] = {};
  const minBars = def.warmupBars(config);
  const cold = { trades: 0, net: 0, minBars };

  for (const day of days) {
    const data = loadDay(day.date);
    if (data) sessionsWithBars++;
    const w = (warmup[day.weekday] ??= { sessions: 0, partial: 0 });
    w.sessions++;
    const ws = day.warmupSessions ?? data?.warmupSessions ?? null;
    if (ws != null && ws < 1) w.partial++;

    const barOf = (contract: string, hm: string): BtBar | undefined =>
      data?.contracts[contract]?.bars.find((b) => b.t.slice(0, 10) === day.date && b.t.slice(11, 16) === hm);
    const exitAtOpen = (t: BtTrade) => {
      if (t.exitKind === 'EOD' || t.exitKind === 'SESSION_END') return true;
      const b = barOf(t.contract, t.exitTime);
      return !!b && near(rawExit(t), b.o, 0.006);
    };

    for (const t of day.trades) {
      tradeCount++;
      if (t.warmupBars < minBars) {
        cold.trades++;
        cold.net = r2(cold.net + t.net);
      }
      const tag = `${day.date} ${t.contract} ${t.entryTime}`;
      for (const id of ['gross', 'net', 'time', 'levels', 'lock', 'slots', 'side']) checks[id].checked++;

      if (!near(pnlPts(side, t.entryPrice, t.exitPrice) * t.qty, t.gross, 0.01 * t.qty + 0.02)) fail('gross', `${tag}: ${t.gross}`);
      const costs = orderCost(side, t.entryPrice, t.qty, config.brokerage) + orderCost(exitSideOf(side), t.exitPrice, t.qty, config.brokerage);
      if (!near(costs, t.costs, 0.05) || !near(t.gross - t.costs, t.net, 0.02)) fail('net', `${tag}: costs ${t.costs} vs ${r2(costs)}`);

      const em = hmToMin(t.entryTime);
      const xm = hmToMin(t.exitTime);
      if (em > xm || (t.exitKind !== 'SESSION_END' && xm > eod) || t.entryTime < config.entryStart || t.entryTime > config.entryEnd) {
        fail('time', `${tag}: ${t.entryTime} → ${t.exitTime}`);
      }

      const plan = def.onEntry(
        { key: t.contract, strike: t.strike, option: t.option, ltp: t.decisionPrice, score: t.score, eligible: true, cols: t.cols },
        t.decisionPrice,
        config,
      );
      if (!near(plan.stop, t.initialStop, 0.011) || (plan.target == null) !== (t.target == null) || (plan.target != null && !near(plan.target, t.target!, 0.011))) {
        fail('levels', `${tag}: stop ${t.initialStop} vs ${plan.stop}, target ${t.target} vs ${plan.target}`);
      }

      if (data) {
        const eb = barOf(t.contract, t.entryTime);
        checks.entryFill.checked++;
        const wantEntry = eb ? (side === 'SELL' ? Math.max(0.05, eb.o - slip) : eb.o + slip) : NaN;
        if (!eb || !near(t.entryPrice, wantEntry, 0.006)) fail('entryFill', `${tag}: ${t.entryPrice} vs open ${eb?.o}`);
        checks.exitFill.checked++;
        const raw = rawExit(t);
        const xb = barOf(t.contract, t.exitTime);
        if (t.exitKind === 'EOD') {
          const prior = data.contracts[t.contract]?.bars.filter((b) => b.t.slice(0, 10) === day.date && b.t.slice(11, 16) < t.exitTime).pop();
          if (!(xb ? near(raw, xb.o, 0.006) : prior ? near(raw, prior.c, 0.006) : true)) fail('exitFill', `${tag}: EOD ${t.exitPrice}`);
        } else if (t.exitKind !== 'SESSION_END') {
          // A BUY exit price is floored at 0.05 after slippage; compare the unfloored value only when not floored.
          const floored = side === 'BUY' && t.exitPrice <= 0.05 + 1e-9;
          if (!xb || (!floored && (raw < xb.l - 0.006 || raw > xb.h + 0.006))) fail('exitFill', `${tag}: exit ${t.exitPrice} outside ${xb?.l}..${xb?.h}`);
        }
      }

      const holding = day.trades.filter((o) => {
        if (o === t) return false;
        const oe = hmToMin(o.entryTime);
        const ox = hmToMin(o.exitTime);
        if (oe === em) return o.n < t.n;
        if (oe > em || ox < em) return false;
        return ox > em || !exitAtOpen(o);
      });
      if (holding.length >= config.maxConcurrent) fail('slots', `${tag}: ${holding.length} already held`);
      if (holding.filter((o) => o.option === t.option).length >= config.maxSameSide) fail('side', `${tag}: ${t.option} side full`);

      const before = day.trades.filter((o) => o.contract === t.contract && o.n < t.n);
      const lastExit = before.length ? Math.max(...before.map((o) => hmToMin(o.exitTime))) : null;
      if (lastExit != null && em < lastExit + REENTRY_LOCK_MIN) fail('lock', `${tag}: re-entered ${em - lastExit} min after exit`);
    }
  }
  return { at, configKey, sessions: days.length, trades: tradeCount, sessionsWithBars, checks: Object.values(checks), warmup, coldEntries: cold };
}
