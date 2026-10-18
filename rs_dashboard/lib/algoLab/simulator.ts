/**
 * Algo Lab backtest simulator: replays one session minute by minute through a strategy's own gate / scan /
 * onEntry / manage — the functions the live engine calls — with the generic fill model below.
 *
 * Fill model (strategies/algo_lab/README.md; Breakdown Scalper's, made side-aware):
 *  - decisions at minute m see only bars that closed before m; entry at bar m's OPEN (+/- slippage);
 *  - inside a bar the price walks adverse-first: SELL O -> H -> L -> C, BUY O -> L -> H -> C (an entry bar starts at
 *    its second point, the open being the entry);
 *  - at each point the best price and the stop update, then every triggered exit (the stop, and the strategy's own)
 *    is checked; the one the price reaches first fills, on the traded segment (a level crossed fills at the level, a
 *    level already behind the price fills at the price, a gap at the open fills at the open);
 *  - a position closed inside bar m still holds its slot and counts in the loss limit for entries at bar m's open;
 *  - EOD exits at the cutoff bar's open; anything still open after 15:29 at its last print.
 */

import { closeBar, hmToMin, istMsOf, minToHm, SESSION_LAST, SESSION_OPEN } from './bars.ts';
import { orderCost } from './costs.ts';
import { exitSideOf, pnlPts, r2 } from './risk.ts';
import { stepPosition } from './engineStep.ts';
import type {
  AlgoConfig,
  AlgoCtx,
  Bar,
  CellValue,
  CtxContract,
  Json,
  OptType,
  PositionView,
  Side,
  StrategyDefinition,
} from './types.ts';

export interface BtBar extends Bar {
  oi: number | null;
}

export interface DayData {
  date: string;
  expiry: string;
  source: string;
  lotSize: number;
  /** Previous sessions present for warm-up (0 = the contract starts cold). */
  warmupSessions?: number;
  /** Underlying 1-minute closes, 'HH:MM' -> price. */
  spot: [string, number][];
  contracts: Record<string, { strike: number; option: OptType; bars: BtBar[] }>;
}

export interface BtTrade {
  n: number;
  contract: string;
  strike: number;
  option: OptType;
  side: Side;
  lots: number;
  qty: number;
  entryTime: string;
  /** The bar open the decision used (stop/target basis). */
  decisionPrice: number;
  /** Fill: decision price -/+ slippage. P&L is booked on fills. */
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitKind: string;
  exitReason: string;
  gross: number;
  costs: number;
  net: number;
  initialStop: number;
  target: number | null;
  stopAtExit: number;
  best: number;
  maxAdverse: number;
  holdMin: number;
  score: number;
  bias: string;
  warmupBars: number;
  cols: Record<string, CellValue>;
}

export interface DayResult {
  date: string;
  weekday: string;
  expiry: string;
  dte: number;
  source: string;
  lotSize: number;
  trades: BtTrade[];
  gross: number;
  costs: number;
  net: number;
  wins: number;
  losses: number;
  haltedAt: string | null;
  signalMinutes: number;
  spotOpen: number | null;
  spotClose: number | null;
  warmupSessions: number | null;
  notes: string[];
}

export const REENTRY_LOCK_MIN = 5;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface OpenPos {
  id: string;
  key: string;
  strike: number;
  option: OptType;
  entryMin: number;
  decision: number;
  fillEntry: number;
  qty: number;
  best: number;
  stop: number;
  initialStop: number;
  target: number | null;
  state: Json;
  maxAdverse: number;
  closedGross?: number;
  score: number;
  bias: string;
  warmupBars: number;
  cols: Record<string, CellValue>;
}

export function simulateDay(def: StrategyDefinition, data: DayData, config: AlgoConfig): DayResult {
  const day = data.date;
  const side = def.side;
  const exitSide = exitSideOf(side);
  const notes: string[] = [];
  const qty = config.lotsPerTrade * data.lotSize;
  const slip = Math.max(0, config.slippagePts);
  const brokerage = config.brokerage;
  const coldBelow = def.warmupBars(config);

  // Per contract: today's bars by minute, the prior-session bar count and last close/OI.
  const keys = Object.keys(data.contracts);
  const byMin = new Map<string, Map<number, BtBar>>();
  const prev = new Map<string, { close: number; oi: number | null }>();
  const warmBars = new Map<string, number>();
  for (const k of keys) {
    const m = new Map<number, BtBar>();
    let nWarm = 0;
    let last: BtBar | null = null;
    for (const b of data.contracts[k].bars) {
      const d = b.t.slice(0, 10);
      if (d === day) m.set(hmToMin(b.t.slice(11, 16)), b);
      else if (d < day) {
        nWarm++;
        last = b;
      }
    }
    byMin.set(k, m);
    warmBars.set(k, nWarm);
    if (last) prev.set(k, { close: last.c, oi: last.oi });
  }
  // Minute stamps per contract ('YYYY-MM-DD HH:MM'), for a binary-searched "closed before minute m" cut.
  const stamps = new Map<string, string[]>(keys.map((k) => [k, data.contracts[k].bars.map((b) => b.t.slice(0, 16))]));
  const closedCount = (k: string, cutoff: string) => {
    const a = stamps.get(k)!;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < cutoff) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const strikes = [...new Set(keys.map((k) => data.contracts[k].strike))].sort((a, b) => a - b);
  const diffs = strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0);
  const step = diffs.length ? Math.min(...diffs) : 50;
  const spotToday = data.spot.filter(([hm]) => hmToMin(hm) >= SESSION_OPEN && hmToMin(hm) <= SESSION_LAST);

  const open: OpenPos[] = [];
  const trades: BtTrade[] = [];
  const lockUntil = new Map<string, number>();
  let closedIntrabar: OpenPos[] = [];
  let realizedGross = 0;
  let haltedAt: string | null = null;
  let signalMinutes = 0;
  let seq = 0;

  const lastBefore = (k: string, m: number): BtBar | null => {
    const mm = byMin.get(k)!;
    for (let x = m - 1; x >= SESSION_OPEN; x--) {
      const b = mm.get(x);
      if (b) return b;
    }
    return null;
  };

  // ── Decision context at the start of minute m (closed bars only). Built once per minute. ──
  let ctxMin = -1;
  let ctxCache: AlgoCtx | null = null;
  const ctxAt = (m: number): AlgoCtx | null => {
    if (ctxMin === m) return ctxCache;
    ctxMin = m;
    const hm = minToHm(m);
    const spotBars = spotToday.filter(([t]) => t < hm).map(([t, c]) => closeBar(day, t, c));
    const spot = spotBars.length ? spotBars[spotBars.length - 1].c : 0;
    if (!(spot > 0) || !strikes.length) return (ctxCache = null);
    const atm = strikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a), strikes[0]);
    const ai = strikes.indexOf(atm);
    const want = new Set<string>();
    for (const s of strikes.slice(Math.max(0, ai - config.strikeWindow), ai + config.strikeWindow + 1)) {
      want.add(`${s}CE`);
      want.add(`${s}PE`);
    }
    for (const p of open) want.add(p.key);
    const cutoff = `${day} ${hm}`;
    const contracts: Record<string, CtxContract> = {};
    for (const k of want) {
      const src = data.contracts[k];
      if (!src) continue;
      const last = lastBefore(k, m);
      if (!last) continue;
      let vol = 0;
      for (const [x, b] of byMin.get(k)!) if (x < m) vol += b.v || 0;
      const pv = prev.get(k);
      contracts[k] = {
        key: k,
        strike: src.strike,
        option: src.option,
        ltp: last.c,
        volume: vol,
        oi: last.oi,
        prevClose: pv?.close ?? null,
        prevOi: pv?.oi ?? null,
        bars1m: src.bars.slice(0, closedCount(k, cutoff)),
        warmupBars: warmBars.get(k) ?? 0,
      };
    }
    ctxCache = {
      nowIstMs: istMsOf(day, hm),
      date: day,
      hm,
      underlying: 'NIFTY',
      expiry: data.expiry,
      lotSize: data.lotSize,
      step,
      spot,
      atm,
      spotBars1m: spotBars,
      contracts,
      open: open.map((p) => ({ id: p.id, key: p.key, option: p.option, side, entryPrice: p.decision })),
    };
    return ctxCache;
  };

  const close = (p: OpenPos, m: number, fill: number, kind: string, reason: string, atOpen: boolean) => {
    const exitFill = side === 'SELL' ? fill + slip : Math.max(0.05, fill - slip);
    const gross = pnlPts(side, p.fillEntry, exitFill) * p.qty;
    const costs = orderCost(side, p.fillEntry, p.qty, brokerage) + orderCost(exitSide, exitFill, p.qty, brokerage);
    realizedGross += gross;
    p.closedGross = gross;
    if (!atOpen) closedIntrabar.push(p);
    trades.push({
      n: ++seq,
      contract: p.key,
      strike: p.strike,
      option: p.option,
      side,
      lots: config.lotsPerTrade,
      qty: p.qty,
      entryTime: minToHm(p.entryMin),
      decisionPrice: p.decision,
      entryPrice: r2(p.fillEntry),
      exitTime: minToHm(m),
      exitPrice: r2(exitFill),
      exitKind: kind,
      exitReason: reason,
      gross: r2(gross),
      costs: r2(costs),
      net: r2(gross - costs),
      initialStop: p.initialStop,
      target: p.target,
      stopAtExit: r2(p.stop),
      best: r2(p.best),
      maxAdverse: r2(p.maxAdverse),
      holdMin: m - p.entryMin,
      score: p.score,
      bias: p.bias,
      warmupBars: p.warmupBars,
      cols: p.cols,
    });
    open.splice(open.indexOf(p), 1);
    lockUntil.set(p.key, m + REENTRY_LOCK_MIN);
  };

  const view = (p: OpenPos): PositionView => ({
    id: p.id,
    key: p.key,
    strike: p.strike,
    option: p.option,
    side,
    entryPrice: p.decision,
    stop: p.stop,
    initialStop: p.initialStop,
    best: p.best,
    target: p.target,
    state: p.state,
    openedAt: istMsOf(day, minToHm(p.entryMin)),
  });

  /** Walks a position through bar m's price points adverse-first; closes it and returns true on an exit. */
  const manageInBar = (p: OpenPos, bar: BtBar, m: number, fromOpen: boolean, ctx: AlgoCtx): boolean => {
    const path = side === 'SELL' ? [bar.h, bar.l] : [bar.l, bar.h];
    const points: [number, boolean][] = [...(fromOpen ? ([[bar.o, true]] as [number, boolean][]) : []), [path[0], false], [path[1], false], [bar.c, false]];
    let prevPx = bar.o;
    for (const [px, isOpen] of points) {
      p.maxAdverse = Math.max(p.maxAdverse, -pnlPts(side, p.decision, px));
      const r = stepPosition(def, view(p), px, prevPx, ctx, config);
      p.best = r.best;
      p.stop = r.stop;
      p.state = r.state;
      if (r.exit) {
        close(p, m, r.exit.fill, r.exit.kind, r.exit.reason, isOpen);
        return true;
      }
      prevPx = px;
    }
    return false;
  };

  const entryStart = hmToMin(config.entryStart);
  const entryEnd = hmToMin(config.entryEnd);
  const eod = hmToMin(config.eodExit);

  for (let m = SESSION_OPEN + 1; m <= SESSION_LAST; m++) {
    const hm = minToHm(m);
    closedIntrabar = [];

    // ── 1. Manage open positions inside bar m ──
    const tradesBefore = trades.length;
    for (const p of [...open]) {
      const bar = byMin.get(p.key)!.get(m);
      if (m >= eod) {
        close(p, m, bar ? bar.o : lastBefore(p.key, m)?.c ?? p.decision, 'EOD', `EOD square-off at ${config.eodExit}`, true);
        continue;
      }
      if (!bar) continue; // no print this minute: nothing to evaluate (the live engine would not either)
      const ctx = ctxAt(m);
      if (ctx) manageInBar(p, bar, m, true, ctx);
    }
    if (trades.length !== tradesBefore) ctxMin = -1; // ctx.open must not list positions that just closed

    // ── 2. Entries ──
    if (m < entryStart || m > entryEnd || m >= eod || haltedAt) continue;

    // Loss limit as known at bar m's OPEN: realized up to then + every position open at the open, at its last close.
    let openGross = 0;
    for (const p of [...open, ...closedIntrabar]) openGross += pnlPts(side, p.fillEntry, lastBefore(p.key, m)?.c ?? p.decision) * p.qty;
    const realizedAtOpen = realizedGross - closedIntrabar.reduce((a, p) => a + (p.closedGross ?? 0), 0);
    if (realizedAtOpen + openGross <= -config.dailyLossLimit) {
      haltedAt = hm;
      notes.push(`Daily loss limit ₹${config.dailyLossLimit} hit at ${hm}: no new entries for the rest of the day.`);
      continue;
    }
    const holding = () => [...open, ...closedIntrabar];
    if (holding().length >= config.maxConcurrent) continue;

    const ctx = ctxAt(m);
    if (!ctx) continue;
    const gate = def.gate(ctx, config);
    const ranked = def.scan(ctx, config, gate);
    if (ranked.some((c) => c.eligible)) signalMinutes++;

    const held = new Set(open.map((p) => p.key));
    for (const c of ranked) {
      if (holding().length >= config.maxConcurrent) break;
      if (!c.eligible || held.has(c.key)) continue;
      if ((lockUntil.get(c.key) ?? 0) > m) continue;
      if (holding().filter((p) => p.option === c.option).length >= config.maxSameSide) continue;
      if (config.btWarmOnly && (warmBars.get(c.key) ?? 0) < coldBelow) continue;
      const bar = byMin.get(c.key)?.get(m);
      if (!bar || !(bar.o > 0)) continue; // no print to fill against
      const decision = bar.o;
      const plan = def.onEntry(c, decision, config);
      const p: OpenPos = {
        id: `bt_${day}_${m}_${c.key}`,
        key: c.key,
        strike: c.strike,
        option: c.option,
        entryMin: m,
        decision,
        fillEntry: side === 'SELL' ? Math.max(0.05, decision - slip) : decision + slip,
        qty,
        best: decision,
        stop: plan.stop,
        initialStop: plan.stop,
        target: plan.target,
        state: plan.state ?? null,
        maxAdverse: 0,
        score: c.score,
        bias: gate.bias,
        warmupBars: warmBars.get(c.key) ?? 0,
        cols: c.cols,
      };
      open.push(p);
      held.add(c.key);
      // A stop can be hit in the entry minute too; if so it lands in closedIntrabar and keeps its slot this minute.
      manageInBar(p, bar, m, false, ctx);
    }
  }

  for (const p of [...open]) {
    close(p, SESSION_LAST, lastBefore(p.key, SESSION_LAST + 1)?.c ?? p.decision, 'SESSION_END', 'Session end: no EOD cutoff before 15:29', true);
  }

  const sum = (f: (t: BtTrade) => number) => r2(trades.reduce((a, t) => a + f(t), 0));
  if (!keys.length) notes.push('No option data for this session.');
  if (data.warmupSessions != null && data.warmupSessions < 1) {
    notes.push('No previous session of this contract in the options DB: early-session indicators are not settled (live has the previous day).');
  }
  return {
    date: day,
    weekday: WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()],
    expiry: data.expiry,
    dte: dayDiff(day, data.expiry),
    source: data.source,
    lotSize: data.lotSize,
    trades,
    gross: sum((t) => t.gross),
    costs: sum((t) => t.costs),
    net: sum((t) => t.net),
    wins: trades.filter((t) => t.net > 0).length,
    losses: trades.filter((t) => t.net <= 0).length,
    haltedAt,
    signalMinutes,
    spotOpen: spotToday[0]?.[1] ?? null,
    spotClose: spotToday[spotToday.length - 1]?.[1] ?? null,
    warmupSessions: data.warmupSessions ?? null,
    notes,
  };
}
