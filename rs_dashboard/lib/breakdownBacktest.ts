/**
 * Breakdown Scalper — daily backtest simulator (/breakdown-scalper "Strategy Backtest" panel).
 *
 * Replays one NIFTY session minute by minute through the SAME rule functions the live engine runs
 * (lib/breakdownScalper.ts: evaluateOptionBreakdown, evaluateUnderlyingTrend, rankBreakdownSignals,
 * evaluatePositionRisk), so the backtest and the page cannot drift apart. Pure: data in, result out.
 *
 * Fill model (no look-ahead):
 *  - At the start of minute m only bars that CLOSED before m are known (signals, trend, LTP for ranking).
 *  - An entry fills at the contract's bar-m OPEN.
 *  - Stops/targets are checked inside bar m in the adverse-first order open -> high -> low -> close (a short loses
 *    on the high, so a bar touching both the stop and the target counts as the stop). A level crossed inside the
 *    bar fills AT the level; a gap through it at the open fills at the open. Recovery exit uses the close.
 *  - EOD exits at the open of the first bar at/after config.eodExit.
 *
 * What the live engine does that this cannot: tick-level fills (LTP every second), broker rejections, slippage
 * beyond the bar's own range. The underlying trend uses the options DB's 1-minute spot closes (the live feed uses
 * index OHLC; with no index volume both fall back to the running mean of price for VWAP).
 */

import {
  evaluateOptionBreakdown,
  evaluatePositionRisk,
  evaluateUnderlyingTrend,
  rankBreakdownSignals,
  type CandidateSignal,
  type OptionBreakdownState,
  type UnderlyingTrend,
} from './breakdownScalper.ts';
import type { BreakdownConfig } from './breakdownLedger.ts';
import type { Bar } from './volumeProfile.ts';

// ── Data shape (written by scripts/tools/breakdown_backtest_data.py) ─────────
export interface BtBar extends Bar {
  oi: number | null;
}

export interface BtContract {
  strike: number;
  option: 'CE' | 'PE';
  /** 1-minute bars, oldest first: up to 2 prior sessions of the SAME expiry (indicator warm-up), then the day. */
  bars: BtBar[];
}

export interface BtDayData {
  date: string; // YYYY-MM-DD (the simulated session)
  expiry: string; // nearest weekly expiry on/after date
  source: 'db' | 'expired_api' | 'intraday_api';
  lotSize: number;
  /** Prior sessions present for indicator warm-up (2 = full; the offline DB mode can have fewer on Wed/Thu). */
  warmupSessions?: number;
  /** NIFTY spot 1-minute closes for the session, 'HH:MM' -> price. */
  spot: [string, number][];
  contracts: Record<string, BtContract>;
}

// ── Result shape ────────────────────────────────────────────────────────────
export type BtExitKind = 'TARGET' | 'TRAIL_SL' | 'INITIAL_SL' | 'RECOVERY' | 'EOD' | 'SESSION_END';

export interface BtTrade {
  n: number;
  contract: string; // e.g. "23400PE"
  strike: number;
  option: 'CE' | 'PE';
  entryTime: string; // HH:MM
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  lots: number;
  qty: number;
  holdMin: number;
  exitKind: BtExitKind;
  exitReason: string;
  gross: number; // ₹, short P&L before costs
  costs: number; // ₹, both orders
  net: number;
  initialSl: number;
  targetPrice: number | null;
  lowestPrice: number;
  trailingSlAtExit: number;
  /** Worst adverse premium seen while open (₹ per unit above entry). */
  maxAdverse: number;
  rankScore: number;
  breakdownAgeBars: number;
  trendAtEntry: UnderlyingTrend['trend'];
  spotAtEntry: number;
  atmAtEntry: number;
  stepsFromAtm: number;
  oiView: 'confirm' | 'conflict' | null;
}

export interface BtDayResult {
  date: string;
  weekday: string;
  expiry: string;
  dte: number;
  source: BtDayData['source'];
  lotSize: number;
  trades: BtTrade[];
  gross: number;
  costs: number;
  net: number;
  wins: number;
  losses: number;
  /** HH:MM the daily loss limit stopped new entries, if it did. */
  haltedAt: string | null;
  /** Minutes in the entry window with at least one eligible signal. */
  signalMinutes: number;
  spotOpen: number | null;
  spotClose: number | null;
  notes: string[];
}

// ── Costs ───────────────────────────────────────────────────────────────────
/**
 * Dhan F&O option charges per order (audit of 4,155 real Dhan trades, dhan-backtest-data skill): ₹20 brokerage,
 * 18% GST on brokerage + exchange + SEBI fees, STT 0.1% of SELL premium turnover, exchange charge ~0.05% of premium
 * turnover, SEBI ₹10/crore, stamp duty 0.003% on the BUY side.
 */
export const DHAN_OPTION_COSTS = {
  brokeragePerOrder: 20,
  gstPct: 18,
  sttSellPct: 0.1,
  exchangePct: 0.05,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
} as const;

export function orderCost(side: 'BUY' | 'SELL', premium: number, qty: number, c = DHAN_OPTION_COSTS): number {
  const turnover = premium * qty;
  const exchange = (turnover * c.exchangePct) / 100;
  const sebi = (turnover * c.sebiPerCrore) / 1e7;
  const gst = ((c.brokeragePerOrder + exchange + sebi) * c.gstPct) / 100;
  const stt = side === 'SELL' ? (turnover * c.sttSellPct) / 100 : 0;
  const stamp = side === 'BUY' ? (turnover * c.stampBuyPct) / 100 : 0;
  return c.brokeragePerOrder + exchange + sebi + gst + stt + stamp;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const SESSION_OPEN = 9 * 60 + 15;
const SESSION_LAST = 15 * 60 + 29;
const REENTRY_LOCK_MIN = 5; // same as the live engine's REENTRY_LOCK_MS
const NIFTY_STEP = 50;
const BUILDUP_MIN_PRICE_PCT = 0.01; // scripts/tools/live_options_ws.py _classify_buildup
const BUILDUP_MIN_OI_PCT = 0.5;

const pad = (n: number) => String(n).padStart(2, '0');
export const minToHm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const hmToMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** OI buildup label vs the previous session, the live bridge's own rule (live_options_ws._classify_buildup). */
export function classifyBuildup(changePct: number, oiChgPct: number): string | undefined {
  if (Math.abs(changePct) < BUILDUP_MIN_PRICE_PCT || Math.abs(oiChgPct) < BUILDUP_MIN_OI_PCT) return undefined;
  if (oiChgPct > 0) return changePct > 0 ? 'LB' : 'SB';
  return changePct > 0 ? 'SC' : 'LU';
}

/** pandas ewm(span, adjust=False).mean() last value, as scripts/tools/cyber_scalper_feed.py computes EMA9/EMA20. */
export function ewmLast(values: number[], span: number): number | null {
  if (!values.length) return null;
  const a = 2 / (span + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = a * values[i] + (1 - a) * e;
  return e;
}

/**
 * The live trend feed's numbers at the start of minute `m` from today's spot closes before m: spot = last close,
 * VWAP = running mean (index has no volume), EMA9/EMA20 = ewm on tf-minute closes from 09:15 (forming bucket
 * included, as the live feed's last bar is the forming one).
 */
export function trendInputsAt(spot: [string, number][], m: number, tf: number) {
  const known = spot.filter(([hm]) => hmToMin(hm) < m);
  if (!known.length) return null;
  const closes = known.map(([, c]) => c);
  const buckets: number[] = [];
  let lastBucket = -1;
  for (const [hm, c] of known) {
    const b = Math.floor((hmToMin(hm) - SESSION_OPEN) / tf);
    if (b !== lastBucket) {
      buckets.push(c);
      lastBucket = b;
    } else buckets[buckets.length - 1] = c;
  }
  return {
    spot: closes[closes.length - 1],
    vwap: closes.reduce((a, b) => a + b, 0) / closes.length,
    ema9: ewmLast(buckets, 9),
    ema20: ewmLast(buckets, 20),
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface OpenPos {
  key: string;
  strike: number;
  option: 'CE' | 'PE';
  entryMin: number;
  entryPrice: number;
  qty: number;
  lowest: number;
  trailingSl: number;
  initialSl: number;
  targetPrice: number | null;
  maxAdverse: number;
  meta: Pick<BtTrade, 'rankScore' | 'breakdownAgeBars' | 'trendAtEntry' | 'spotAtEntry' | 'atmAtEntry' | 'stepsFromAtm' | 'oiView'>;
}

// ── The simulator ───────────────────────────────────────────────────────────
export function simulateDay(data: BtDayData, config: BreakdownConfig): BtDayResult {
  const notes: string[] = [];
  const day = data.date;
  const tf = config.timeframe;
  const lots = config.lotsPerTrade;
  const qty = lots * data.lotSize;

  // Per contract: index of today's bars by minute, the bar list, and the previous session's close/OI.
  const keys = Object.keys(data.contracts);
  const byMin = new Map<string, Map<number, BtBar>>();
  const prev = new Map<string, { close: number; oi: number | null }>();
  for (const k of keys) {
    const bars = data.contracts[k].bars;
    const m = new Map<number, BtBar>();
    let prevBar: BtBar | null = null;
    for (const b of bars) {
      if (b.t.slice(0, 10) === day) m.set(hmToMin(b.t.slice(11, 16)), b);
      else if (b.t.slice(0, 10) < day) prevBar = b;
    }
    byMin.set(k, m);
    if (prevBar) prev.set(k, { close: prevBar.c, oi: prevBar.oi });
  }
  const strikes = [...new Set(keys.map((k) => data.contracts[k].strike))].sort((a, b) => a - b);

  // Indicator state per contract is cached per closed bucket (it only changes when a tf bucket closes).
  const stateCache = new Map<string, { bucket: number; state: OptionBreakdownState }>();
  const stateAt = (k: string, m: number): OptionBreakdownState => {
    const bucket = Math.floor((m - SESSION_OPEN) / tf);
    const hit = stateCache.get(k);
    if (hit && hit.bucket === bucket && tf > 1) return hit.state;
    const cutoff = `${day} ${minToHm(m)}`;
    const bars = data.contracts[k].bars.filter((b) => b.t.slice(0, 16) < cutoff);
    const nowIst = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), Math.floor(m / 60), m % 60, 1);
    const state = evaluateOptionBreakdown(bars, tf, nowIst);
    stateCache.set(k, { bucket, state });
    return state;
  };
  /** Last known bar of a contract strictly before minute m (today only). */
  const lastBefore = (k: string, m: number): BtBar | null => {
    const mm = byMin.get(k)!;
    for (let x = m - 1; x >= SESSION_OPEN; x--) {
      const b = mm.get(x);
      if (b) return b;
    }
    return null;
  };
  const cumVolBefore = (k: string, m: number): number => {
    let v = 0;
    for (const [x, b] of byMin.get(k)!) if (x < m) v += b.v || 0;
    return v;
  };

  const open: OpenPos[] = [];
  const trades: BtTrade[] = [];
  const lockUntil = new Map<string, number>(); // contract -> minute
  let realizedGross = 0;
  let haltedAt: string | null = null;
  let signalMinutes = 0;
  const entryStart = hmToMin(config.entryStart);
  const entryEnd = hmToMin(config.entryEnd);
  const eod = hmToMin(config.eodExit);

  const close = (p: OpenPos, m: number, price: number, kind: BtExitKind, reason: string) => {
    const gross = (p.entryPrice - price) * p.qty;
    const costs = orderCost('SELL', p.entryPrice, p.qty) + orderCost('BUY', price, p.qty);
    realizedGross += gross;
    trades.push({
      n: trades.length + 1,
      contract: p.key,
      strike: p.strike,
      option: p.option,
      entryTime: minToHm(p.entryMin),
      entryPrice: r2(p.entryPrice),
      exitTime: minToHm(m),
      exitPrice: r2(price),
      lots,
      qty: p.qty,
      holdMin: m - p.entryMin,
      exitKind: kind,
      exitReason: reason,
      gross: r2(gross),
      costs: r2(costs),
      net: r2(gross - costs),
      initialSl: p.initialSl,
      targetPrice: p.targetPrice,
      lowestPrice: r2(p.lowest),
      trailingSlAtExit: r2(p.trailingSl),
      maxAdverse: r2(p.maxAdverse),
      ...p.meta,
    });
    open.splice(open.indexOf(p), 1);
    lockUntil.set(p.key, m + REENTRY_LOCK_MIN);
  };

  for (let m = SESSION_OPEN + 1; m <= SESSION_LAST; m++) {
    const hm = minToHm(m);

    // ── 1. Manage open positions inside bar m ──
    for (const p of [...open]) {
      const bar = byMin.get(p.key)!.get(m);
      if (m >= eod) {
        const px = bar ? bar.o : lastBefore(p.key, m)?.c ?? p.entryPrice;
        close(p, m, px, 'EOD', `EOD MANDATORY EXIT: Session cutoff at ${config.eodExit} IST`);
        continue;
      }
      if (!bar) continue; // no print this minute: nothing to evaluate (the live engine would not either)
      const st = stateAt(p.key, m);
      const points: [number, 'open' | 'high' | 'low' | 'close'][] = [
        [bar.o, 'open'],
        [bar.h, 'high'],
        [bar.l, 'low'],
        [bar.c, 'close'],
      ];
      for (const [px, label] of points) {
        p.maxAdverse = Math.max(p.maxAdverse, px - p.entryPrice);
        const risk = evaluatePositionRisk(
          p.entryPrice,
          px,
          p.lowest,
          config.slPct,
          config.trailStartPct ?? config.trailPct ?? 15,
          config.targetPct,
          st.indicators.stLine,
          st.indicators.ema,
          config.recoveryExit && label === 'close',
          p.trailingSl,
          config.trailStartPct ?? config.trailPct ?? 15,
          config.trailStepPts ?? 5,
          config.trailByPts ?? 2,
        );
        p.lowest = risk.lowestPrice;
        if (risk.shouldExit) {
          // Same precedence as evaluatePositionRisk: target, trailing, initial, recovery.
          let kind: BtExitKind;
          let level: number;
          if (risk.isTargetHit) {
            kind = 'TARGET';
            level = risk.targetPrice ?? px;
          } else if (risk.isTrailingSlHit && risk.trailingSl < risk.initialSl) {
            kind = 'TRAIL_SL';
            level = risk.trailingSl;
          } else if (risk.isInitialSlHit) {
            kind = 'INITIAL_SL';
            level = risk.initialSl;
          } else {
            kind = 'RECOVERY';
            level = px;
          }
          // A level crossed inside the bar fills at the level; a gap through it at the open fills at the open.
          const fill = label === 'open' || kind === 'RECOVERY' ? px : level;
          p.trailingSl = risk.trailingSl;
          close(p, m, fill, kind, risk.exitReason ?? kind);
          break;
        }
        p.trailingSl = risk.trailingSl;
      }
    }

    // ── 2. Entries ──
    if (m < entryStart || m > entryEnd || m >= eod || haltedAt) continue;

    // Daily loss limit (gross, like the live engine): realized + open marked at the last known close.
    let openGross = 0;
    for (const p of open) openGross += (p.entryPrice - (lastBefore(p.key, m)?.c ?? p.entryPrice)) * p.qty;
    if (realizedGross + openGross <= -config.dailyLossLimit) {
      haltedAt = hm;
      notes.push(`Daily loss limit ₹${config.dailyLossLimit} hit at ${hm}: no new entries for the rest of the day.`);
      continue;
    }
    if (open.length >= config.maxConcurrent) continue;

    const t = trendInputsAt(data.spot, m, tf);
    if (!t) continue;
    const trend = evaluateUnderlyingTrend(t.spot, t.vwap, t.ema9, t.ema20, config.trendMode);
    const atm = strikes.reduce((a, b) => (Math.abs(b - t.spot) < Math.abs(a - t.spot) ? b : a), strikes[0]);
    const ai = strikes.indexOf(atm);
    const window = strikes.slice(Math.max(0, ai - config.strikeWindow), ai + config.strikeWindow + 1);

    const raw = [];
    for (const s of window) {
      for (const opt of ['CE', 'PE'] as const) {
        const k = `${s}${opt}`;
        if (!data.contracts[k]) continue;
        const last = lastBefore(k, m);
        if (!last) continue;
        const pv = prev.get(k);
        const buildup =
          pv && pv.close > 0 && pv.oi && last.oi != null
            ? classifyBuildup(((last.c - pv.close) / pv.close) * 100, ((last.oi - pv.oi) / pv.oi) * 100)
            : undefined;
        raw.push({
          strike: s,
          option: opt,
          contractKey: k,
          ltp: last.c,
          volume: cumVolBefore(k, m),
          oi: last.oi ?? 0,
          buildup,
          state: stateAt(k, m),
        });
      }
    }
    const held = new Set(open.map((p) => p.key));
    const ranked: CandidateSignal[] = rankBreakdownSignals(raw, t.spot, atm, NIFTY_STEP, trend, held);
    if (ranked.some((c) => c.isEligible)) signalMinutes++;

    // Same pick rule as the live engine: best-ranked contract passing every rule; repeat while slots remain
    // (the live engine opens one per second, so several can open within one minute).
    for (const c of ranked) {
      if (open.length >= config.maxConcurrent) break;
      if (!c.isEligible || held.has(c.contractKey)) continue;
      if ((lockUntil.get(c.contractKey) ?? 0) > m) continue;
      if (open.filter((p) => p.option === c.option).length >= config.maxSameSide) continue;
      const bar = byMin.get(c.contractKey)!.get(m);
      if (!bar || !(bar.o > 0)) continue; // no print to fill against
      const entry = bar.o;
      const initialSl = r2(entry * (1 + config.slPct / 100));
      open.push({
        key: c.contractKey,
        strike: c.strike,
        option: c.option,
        entryMin: m,
        entryPrice: entry,
        qty,
        lowest: entry,
        trailingSl: initialSl,
        initialSl,
        targetPrice: config.targetPct > 0 ? r2(entry * (1 - config.targetPct / 100)) : null,
        maxAdverse: 0,
        meta: {
          rankScore: c.rankScore,
          breakdownAgeBars: c.state.barsSinceBreakdown,
          trendAtEntry: trend.trend,
          spotAtEntry: r2(t.spot),
          atmAtEntry: atm,
          stepsFromAtm: c.distFromAtmSteps,
          oiView: c.oiView ?? null,
        },
      });
      held.add(c.contractKey);
      // Manage the fresh position inside its entry bar too (a stop can be hit in the same minute).
      const p = open[open.length - 1];
      const st = stateAt(p.key, m);
      for (const [px, label] of [
        [bar.h, 'high'],
        [bar.l, 'low'],
        [bar.c, 'close'],
      ] as const) {
        p.maxAdverse = Math.max(p.maxAdverse, px - p.entryPrice);
        const risk = evaluatePositionRisk(
          p.entryPrice, px, p.lowest, config.slPct, config.trailStartPct ?? config.trailPct ?? 15, config.targetPct,
          st.indicators.stLine, st.indicators.ema, config.recoveryExit && label === 'close', p.trailingSl,
          config.trailStartPct ?? config.trailPct ?? 15, config.trailStepPts ?? 5, config.trailByPts ?? 2,
        );
        p.lowest = risk.lowestPrice;
        p.trailingSl = risk.trailingSl;
        if (risk.shouldExit) {
          const kind: BtExitKind = risk.isTargetHit
            ? 'TARGET'
            : risk.isTrailingSlHit && risk.trailingSl < risk.initialSl
              ? 'TRAIL_SL'
              : risk.isInitialSlHit
                ? 'INITIAL_SL'
                : 'RECOVERY';
          const level =
            kind === 'TARGET' ? (risk.targetPrice ?? px) : kind === 'TRAIL_SL' ? risk.trailingSl : kind === 'INITIAL_SL' ? risk.initialSl : px;
          close(p, m, level, kind, risk.exitReason ?? kind);
          break;
        }
      }
    }
  }

  // Anything still open after the last bar (EOD set after 15:29) closes at its last print.
  for (const p of [...open]) {
    const last = lastBefore(p.key, SESSION_LAST + 1);
    close(p, SESSION_LAST, last?.c ?? p.entryPrice, 'SESSION_END', 'SESSION END: no EOD cutoff before 15:29');
  }

  const sum = (f: (t: BtTrade) => number) => r2(trades.reduce((a, t) => a + f(t), 0));
  const spotVals = data.spot.filter(([hm]) => hmToMin(hm) >= SESSION_OPEN && hmToMin(hm) <= SESSION_LAST);
  if (!keys.length) notes.push('No option data for this session.');
  if (data.warmupSessions != null && data.warmupSessions < 2) {
    notes.push(`Partial warm-up: ${data.warmupSessions}/2 prior sessions (offline DB mode), early-session indicators are not fully settled.`);
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
    spotOpen: spotVals[0]?.[1] ?? null,
    spotClose: spotVals[spotVals.length - 1]?.[1] ?? null,
    notes,
  };
}

// ── Run bookkeeping shared by the runner, the API route and the panel ────────
/** The config fields that change a backtest result (engineActive and mode do not). */
export function backtestConfigKey(c: BreakdownConfig): string {
  const {
    strikeWindow,
    timeframe,
    trendMode,
    maxConcurrent,
    maxSameSide,
    lotsPerTrade,
    slPct,
    trailStartPct,
    trailStepPts,
    trailByPts,
    targetPct,
    recoveryExit,
    dailyLossLimit,
    entryStart,
    entryEnd,
    eodExit,
  } = c;
  return JSON.stringify({
    strikeWindow,
    timeframe,
    trendMode,
    maxConcurrent,
    maxSameSide,
    lotsPerTrade,
    slPct,
    trailStartPct: trailStartPct ?? c.trailPct ?? 15,
    trailStepPts: trailStepPts ?? 5,
    trailByPts: trailByPts ?? 2,
    targetPct,
    recoveryExit,
    dailyLossLimit,
    entryStart,
    entryEnd,
    eodExit,
  });
}

export type BtWindow = 'week' | 'month' | 'db4';

/** First session of a fresh backfill: the same calendar day one week (or one month) back. Daily appends keep it. */
export function backfillStart(todayIst: string, window: BtWindow = 'week'): string {
  const d = new Date(`${todayIst}T00:00:00Z`);
  if (window === 'month') d.setUTCMonth(d.getUTCMonth() - 1);
  else d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** Session close plus a margin for Dhan's minute data to settle; before this, today is not backtestable. */
export const EOD_READY_HHMM = '15:35';

/**
 * Sessions the store should hold: every regular NSE session from `from` through today (today only once the
 * session is over). `isRegular` is lib/nseHolidays.ts isRegularSession, injected to keep this module pure.
 */
export function sessionsToHold(
  from: string,
  todayIst: string,
  nowHm: string,
  isRegular: (d: string) => boolean,
  to: string | null = null,
): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = nowHm >= EOD_READY_HHMM ? todayIst : null;
  for (;;) {
    const iso = d.toISOString().slice(0, 10);
    if (iso > todayIst || (iso === todayIst && !end) || (to && iso > to)) break;
    if (isRegular(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export interface BtStore {
  version: 1;
  underlying: 'NIFTY';
  configKey: string;
  config: BreakdownConfig;
  /** First session of the history (set by the backfill, kept by daily appends). */
  from: string;
  /** Last session of a fixed historical range (db4 mode); null = rolling, extended by daily appends. */
  to?: string | null;
  /** Built from the local options DB only (no Dhan calls); Wed/Thu may have partial warm-up. */
  offline?: boolean;
  window: BtWindow;
  updatedAt: string | null;
  days: Record<string, BtDayResult>;
  /** Sessions that could not be backtested yet (no data, API error): retried on the next catch-up. */
  failures: Record<string, { at: string; error: string }>;
}

export interface BtSummary {
  days: number;
  tradingDays: number;
  trades: number;
  wins: number;
  winRate: number | null;
  gross: number;
  costs: number;
  net: number;
  avgPerDay: number | null;
  avgPerTrade: number | null;
  bestDay: { date: string; net: number } | null;
  worstDay: { date: string; net: number } | null;
  maxDrawdown: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  exitMix: Record<BtExitKind, number>;
}

/** Totals over a set of days (oldest first is not required). Drawdown is on the cumulative daily net curve. */
export function summarize(days: BtDayResult[]): BtSummary {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const trades = sorted.flatMap((d) => d.trades);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const d of sorted) {
    cum += d.net;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }
  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.net, 0);
  const exitMix = { TARGET: 0, TRAIL_SL: 0, INITIAL_SL: 0, RECOVERY: 0, EOD: 0, SESSION_END: 0 } as Record<BtExitKind, number>;
  for (const t of trades) exitMix[t.exitKind]++;
  const byNet = [...sorted].sort((a, b) => a.net - b.net);
  const net = r2(sorted.reduce((a, d) => a + d.net, 0));
  return {
    days: sorted.length,
    tradingDays: sorted.filter((d) => d.trades.length > 0).length,
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    gross: r2(sorted.reduce((a, d) => a + d.gross, 0)),
    costs: r2(sorted.reduce((a, d) => a + d.costs, 0)),
    net,
    avgPerDay: sorted.length ? r2(net / sorted.length) : null,
    avgPerTrade: trades.length ? r2(net / trades.length) : null,
    bestDay: byNet.length ? { date: byNet[byNet.length - 1].date, net: byNet[byNet.length - 1].net } : null,
    worstDay: byNet.length ? { date: byNet[0].date, net: byNet[0].net } : null,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    avgWin: wins.length ? r2(grossWin / wins.length) : null,
    avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
    exitMix,
  };
}
