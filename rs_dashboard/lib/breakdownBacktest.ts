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
  DEFAULT_BREAKDOWN_PARAMS,
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
  source: 'db' | 'breeze_db' | 'expired_api' | 'intraday_api';
  lotSize: number;
  /** Prior sessions present for indicator warm-up (WARMUP_SESSIONS_NEEDED = full; the offline DB has none on Wednesdays). */
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
  /**
   * 1-minute bars of this contract in the previous session (its indicator warm-up). The options DB stores only the
   * strikes inside ATM+-10 each minute, so a strike far from the previous day's spot can have few or none: it then
   * starts cold, unlike live, which loads every strike's history. Absent on stores built before 2026-10-18.
   */
  warmupBars?: number;
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
  /** Prior sessions of the contract the indicators were warmed on. Absent on stores built before 2026-10-18. */
  warmupSessions?: number | null;
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

export function orderCost(
  side: 'BUY' | 'SELL',
  premium: number,
  qty: number,
  brokeragePerOrder = 20,
  c = DHAN_OPTION_COSTS,
): number {
  const turnover = premium * qty;
  const exchange = (turnover * c.exchangePct) / 100;
  const sebi = (turnover * c.sebiPerCrore) / 1e7;
  const gst = ((brokeragePerOrder + exchange + sebi) * c.gstPct) / 100;
  const stt = side === 'SELL' ? (turnover * c.sttSellPct) / 100 : 0;
  const stamp = side === 'BUY' ? (turnover * c.stampBuyPct) / 100 : 0;
  return brokeragePerOrder + exchange + sebi + gst + stt + stamp;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const SESSION_OPEN = 9 * 60 + 15;
const SESSION_LAST = 15 * 60 + 29;
const REENTRY_LOCK_MIN = 5;
/**
 * Prior sessions the indicators need to be settled from 09:15: the previous session alone is ample (75+ bars even
 * on 5m vs EMA20 / Supertrend(10)). The data file may carry more; fewer means the session started cold.
 */
export const WARMUP_SESSIONS_NEEDED = 1; // same as the live engine's REENTRY_LOCK_MS
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
  /** The bar open the decision saw: the stop / trail / target basis (the live ledger stores the decision LTP). */
  entryPrice: number;
  /** What the sell actually filled at: entryPrice minus slippage. P&L is booked on this. */
  fillEntry: number;
  /** Gross booked when it closed (set by close), for the loss-limit view of a position closed inside the bar. */
  closedGross?: number;
  qty: number;
  lowest: number;
  trailingSl: number;
  initialSl: number;
  targetPrice: number | null;
  maxAdverse: number;
  meta: Pick<BtTrade, 'rankScore' | 'breakdownAgeBars' | 'trendAtEntry' | 'spotAtEntry' | 'atmAtEntry' | 'stepsFromAtm' | 'oiView' | 'warmupBars'>;
}

/**
 * Which exit fired at one price point, and at what level. The target comes first (price fell to it). Among the
 * stop-type exits (trail, initial, recovery) the price, rising, crosses the LOWEST triggered level first, so that one
 * is the exit; evaluatePositionRisk's fixed precedence would pick the trail even when a lower recovery level was hit.
 */
export function exitOf(
  risk: ReturnType<typeof evaluatePositionRisk>,
  px: number,
  stLine: number | null,
  ema: number | null,
  slPct: number,
): { kind: BtExitKind; level: number; reason: string } {
  if (risk.isTargetHit) return { kind: 'TARGET', level: risk.targetPrice ?? px, reason: risk.exitReason ?? 'TARGET HIT' };
  const hit: { kind: BtExitKind; level: number; reason: string }[] = [];
  if (risk.isTrailingSlHit && risk.trailingSl < risk.initialSl) {
    hit.push({
      kind: 'TRAIL_SL',
      level: risk.trailingSl,
      reason: `TRAILING SL HIT: Trailing stop at ₹${risk.trailingSl.toFixed(1)} hit (Lowest was ₹${risk.lowestPrice.toFixed(1)})`,
    });
  }
  if (risk.isInitialSlHit) {
    hit.push({ kind: 'INITIAL_SL', level: risk.initialSl, reason: `INITIAL SL HIT: Loss reached ${slPct}% (Initial SL ₹${risk.initialSl.toFixed(1)})` });
  }
  if (risk.isRecoveryExitHit) {
    const crossed = [stLine, ema].filter((v): v is number => v != null && px > v);
    if (crossed.length) {
      const level = Math.min(...crossed);
      hit.push({ kind: 'RECOVERY', level, reason: `RECOVERY EXIT: Price recovered above indicator (₹${level.toFixed(1)})` });
    }
  }
  hit.sort((a, b) => a.level - b.level);
  return hit[0] ?? { kind: 'INITIAL_SL', level: risk.initialSl, reason: risk.exitReason ?? 'STOP' };
}

/** Previous-session 1-minute bars a contract needs to seed EMA20 on the run's timeframe; fewer = a cold contract. */
export const coldMinBars = (c: BreakdownConfig) => DEFAULT_BREAKDOWN_PARAMS.emaPeriod * c.timeframe;

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
  const warmBars = new Map<string, number>();
  for (const k of keys) {
    const bars = data.contracts[k].bars;
    const m = new Map<number, BtBar>();
    let prevBar: BtBar | null = null;
    let nWarm = 0;
    for (const b of bars) {
      if (b.t.slice(0, 10) === day) m.set(hmToMin(b.t.slice(11, 16)), b);
      else if (b.t.slice(0, 10) < day) {
        prevBar = b;
        nWarm++;
      }
    }
    byMin.set(k, m);
    warmBars.set(k, nWarm);
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
  const slip = Math.max(0, config.slippagePts ?? 0);
  const trailStart = config.trailStartPct ?? config.trailPct ?? 15;
  const trailStep = config.trailStepPts ?? 5;
  const trailBy = config.trailByPts ?? 2;
  /** Previous-session 1-minute bars a contract needs to seed EMA20 on this timeframe; fewer = a cold contract. */
  const coldBelow = coldMinBars(config);
  /**
   * Positions closed INSIDE the current bar (at its high/low/close, not a gap at its open). The bar's open came
   * before that exit, so an entry filled at this bar's open must still see them as holding their slot (and their
   * P&L as open, not realized). Cleared at the start of every minute.
   */
  let closedIntrabar: OpenPos[] = [];

  const close = (p: OpenPos, m: number, rawPrice: number, kind: BtExitKind, reason: string, atOpen: boolean) => {
    // Every exit is a MARKET buy in the live engine (target included), so slippage applies to all of them.
    const price = rawPrice + slip;
    const gross = (p.fillEntry - price) * p.qty;
    const brokerage = config.brokerage ?? 20;
    const costs = orderCost('SELL', p.fillEntry, p.qty, brokerage) + orderCost('BUY', price, p.qty, brokerage);
    realizedGross += gross;
    p.closedGross = gross;
    if (!atOpen) closedIntrabar.push(p);
    trades.push({
      n: trades.length + 1,
      contract: p.key,
      strike: p.strike,
      option: p.option,
      entryTime: minToHm(p.entryMin),
      entryPrice: r2(p.fillEntry),
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

  /**
   * Walks a position through bar m's price points in the adverse-first order (O -> H -> L -> C, or H -> L -> C in its
   * entry bar, whose open is the entry). Closes it and returns true on an exit. A fill always lies on the price
   * segment the trigger happened on (previous point -> this point), so it is a price the bar actually traded: a level
   * crossed between two points fills at the level, a stop ratcheted below the current price fills at the price, and a
   * gap at the open fills at the open.
   */
  const manageInBar = (p: OpenPos, bar: BtBar, m: number, fromOpen: boolean): boolean => {
    const st = stateAt(p.key, m);
    const points: [number, 'open' | 'high' | 'low' | 'close'][] = [
      ...(fromOpen ? ([[bar.o, 'open']] as [number, 'open'][]) : []),
      [bar.h, 'high'],
      [bar.l, 'low'],
      [bar.c, 'close'],
    ];
    let prevPx = bar.o;
    for (const [px, label] of points) {
      p.maxAdverse = Math.max(p.maxAdverse, px - p.entryPrice);
      // Recovery is checked at every point, as the live engine checks it on every tick (not only at the bar close).
      const risk = evaluatePositionRisk(
        p.entryPrice, px, p.lowest, config.slPct, trailStart, config.targetPct,
        st.indicators.stLine, st.indicators.ema, config.recoveryExit, p.trailingSl,
        trailStart, trailStep, trailBy,
      );
      p.lowest = risk.lowestPrice;
      p.trailingSl = risk.trailingSl;
      if (risk.shouldExit) {
        const ex = exitOf(risk, px, st.indicators.stLine, st.indicators.ema, config.slPct);
        const fill = Math.min(Math.max(prevPx, px), Math.max(Math.min(prevPx, px), ex.level));
        close(p, m, fill, ex.kind, ex.reason, label === 'open');
        return true;
      }
      prevPx = px;
    }
    return false;
  };

  for (let m = SESSION_OPEN + 1; m <= SESSION_LAST; m++) {
    const hm = minToHm(m);
    closedIntrabar = [];

    // ── 1. Manage open positions inside bar m ──
    for (const p of [...open]) {
      const bar = byMin.get(p.key)!.get(m);
      if (m >= eod) {
        const px = bar ? bar.o : lastBefore(p.key, m)?.c ?? p.entryPrice;
        close(p, m, px, 'EOD', `EOD MANDATORY EXIT: Session cutoff at ${config.eodExit} IST`, true);
        continue;
      }
      if (!bar) continue; // no print this minute: nothing to evaluate (the live engine would not either)
      manageInBar(p, bar, m, true);
    }

    // ── 2. Entries ──
    if (m < entryStart || m > entryEnd || m >= eod || haltedAt) continue;

    // Daily loss limit (gross, like the live engine), as known at bar m's OPEN: realized up to then, plus every
    // position still open at the open (including those step 1 closed later inside this bar) at the last known close.
    let openGross = 0;
    for (const p of [...open, ...closedIntrabar]) openGross += (p.fillEntry - (lastBefore(p.key, m)?.c ?? p.entryPrice)) * p.qty;
    const realizedAtOpen = realizedGross - closedIntrabar.reduce((a, p) => a + (p.closedGross ?? 0), 0);
    if (realizedAtOpen + openGross <= -config.dailyLossLimit) {
      haltedAt = hm;
      notes.push(`Daily loss limit ₹${config.dailyLossLimit} hit at ${hm}: no new entries for the rest of the day.`);
      continue;
    }
    /** Slots taken at bar m's open: open positions plus those that only close later inside this bar. */
    const busy = () => open.length + closedIntrabar.length;
    const busySide = (opt: 'CE' | 'PE') => [...open, ...closedIntrabar].filter((p) => p.option === opt).length;
    if (busy() >= config.maxConcurrent) continue;

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
      if (busy() >= config.maxConcurrent) break;
      if (!c.isEligible || held.has(c.contractKey)) continue;
      if ((lockUntil.get(c.contractKey) ?? 0) > m) continue;
      if (busySide(c.option) >= config.maxSameSide) continue;
      // Optional: a contract whose indicators were seeded on today's bars only would not signal like live.
      if (config.btWarmOnly && (warmBars.get(c.contractKey) ?? 0) < coldBelow) continue;
      const bar = byMin.get(c.contractKey)!.get(m);
      if (!bar || !(bar.o > 0)) continue; // no print to fill against
      const entry = bar.o;
      const initialSl = r2(entry * (1 + config.slPct / 100));
      const p: OpenPos = {
        key: c.contractKey,
        strike: c.strike,
        option: c.option,
        entryMin: m,
        entryPrice: entry,
        fillEntry: Math.max(0.05, entry - slip),
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
          warmupBars: warmBars.get(c.contractKey) ?? 0,
        },
      };
      open.push(p);
      held.add(c.contractKey);
      // Manage the fresh position inside its entry bar too (a stop can be hit in the same minute). If it closes there
      // it lands in closedIntrabar, so its slot stays taken for the rest of this minute's entries.
      manageInBar(p, bar, m, false);
    }
  }

  // Anything still open after the last bar (EOD set after 15:29) closes at its last print.
  for (const p of [...open]) {
    const last = lastBefore(p.key, SESSION_LAST + 1);
    close(p, SESSION_LAST, last?.c ?? p.entryPrice, 'SESSION_END', 'SESSION END: no EOD cutoff before 15:29', true);
  }

  const sum = (f: (t: BtTrade) => number) => r2(trades.reduce((a, t) => a + f(t), 0));
  const spotVals = data.spot.filter(([hm]) => hmToMin(hm) >= SESSION_OPEN && hmToMin(hm) <= SESSION_LAST);
  if (!keys.length) notes.push('No option data for this session.');
  if (data.warmupSessions != null && data.warmupSessions < WARMUP_SESSIONS_NEEDED) {
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
    spotOpen: spotVals[0]?.[1] ?? null,
    spotClose: spotVals[spotVals.length - 1]?.[1] ?? null,
    warmupSessions: data.warmupSessions ?? null,
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
    brokerage: c.brokerage ?? 20,
    // Only keyed when set, so a store built before slippage existed (= 0) still matches a 0-slippage config.
    ...(c.slippagePts ? { slippagePts: c.slippagePts } : {}),
    ...(c.btWarmOnly ? { btWarmOnly: true } : {}),
    // Only keyed for Breeze, so a store built before the selector existed (= Dhan) still matches.
    ...(c.dataSource === 'breeze' ? { dataSource: 'breeze' } : {}),
  });
}

export type BtWindow = 'week' | 'month' | 'db4' | '3months' | '6months' | '1year' | 'all' | 'custom';

/** First session of a fresh backfill: the same calendar day one week (or months/year) back. Daily appends keep it. */
export function backfillStart(todayIst: string, window: BtWindow = 'week'): string {
  const d = new Date(`${todayIst}T00:00:00Z`);
  if (window === 'month') d.setUTCMonth(d.getUTCMonth() - 1);
  else if (window === '3months') d.setUTCMonth(d.getUTCMonth() - 3);
  else if (window === '6months') d.setUTCMonth(d.getUTCMonth() - 6);
  else if (window === '1year') d.setUTCFullYear(d.getUTCFullYear() - 1);
  else if (window === 'all') return '2021-01-01';
  else d.setUTCDate(d.getUTCDate() - (window === 'db4' ? 28 : 7));
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
  /** Breeze only: sessions the DB does not cover (not failures); the page does not list them as missing. */
  uncovered?: string[];
  /** Invariant audit of `days`, computed by the runner at the end of a run (auditResults). */
  audit?: BtAudit | null;
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

// ── Audit: invariants re-checked from the stored trades and the raw bars ─────
export interface BtAuditCheck {
  id: string;
  label: string;
  rule: string;
  /** How many items were checked (trades, or entries for the slot checks). */
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
  /** Sessions whose cached bar file could be read (the fill checks need it). */
  sessionsWithBars: number;
  checks: BtAuditCheck[];
  /** Per weekday: sessions, and how many lacked the previous session for warm-up (indicators not like live). */
  warmup: Record<string, { sessions: number; partial: number }>;
  /**
   * Trades entered on a contract whose previous-session bars could not seed EMA20 on the run's timeframe
   * (warmupBars < emaPeriod x tf): their entry signal came from indicators seeded on today's bars only, unlike live.
   * null when the stored trades predate warmupBars.
   */
  coldEntries: { trades: number; net: number; minBars: number } | null;
}

/**
 * Re-checks every stored trade against the rules and the bars it was simulated on. Pure: `loadDay` supplies a
 * session's bar file (null when missing, then the fill checks skip that session). Used by the runner after a run,
 * so the page's audit card shows numbers computed from the current results, never fixed text.
 */
export function auditResults(
  days: BtDayResult[],
  config: BreakdownConfig,
  loadDay: (date: string) => BtDayData | null,
  at = new Date().toISOString(),
): BtAudit {
  const slip = Math.max(0, config.slippagePts ?? 0);
  const brokerage = config.brokerage ?? 20;
  const eod = hmToMin(config.eodExit);
  const checks: Record<string, BtAuditCheck> = {};
  const mk = (id: string, label: string, rule: string) => (checks[id] = { id, label, rule, checked: 0, failures: 0, examples: [] });
  mk('gross', 'Gross P&L maths', '(entry − exit) × qty');
  mk('net', 'Net P&L & costs', 'costs = F&O charges on both orders (brokerage per the rules); net = gross − costs');
  mk('time', 'Chronology', 'entry ≤ exit ≤ EOD cutoff; entry inside the entry window');
  mk('levels', 'Stop & target sizing', 'initial SL = entry × (1 + SL%), target = entry × (1 − target%) on the decision price');
  mk('entryFill', 'Entry fill', `entry = that bar's open − slippage (${slip} pt)`);
  mk('exitFill', 'Exit fill traded', 'exit − slippage lies inside the exit bar (low..high); EOD at the cutoff bar open');
  mk('slots', 'Max open at bar open', `positions holding a slot at the entry bar's OPEN < max open (${config.maxConcurrent})`);
  mk('side', 'Max per side at bar open', `same-side positions at the entry bar's OPEN < per side (${config.maxSameSide})`);
  mk('lock', 'Re-entry lock', `same contract not re-entered within ${REENTRY_LOCK_MIN} min of its exit`);
  const fail = (id: string, what: string) => {
    const c = checks[id];
    c.failures++;
    if (c.examples.length < 5) c.examples.push(what);
  };
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  let sessionsWithBars = 0;
  let tradeCount = 0;
  const warmup: BtAudit['warmup'] = {};
  const minBars = coldMinBars(config);
  let cold: BtAudit['coldEntries'] = null;
  for (const day of days) {
    const data = loadDay(day.date);
    if (data) sessionsWithBars++;
    const w = (warmup[day.weekday] ??= { sessions: 0, partial: 0 });
    w.sessions++;
    const ws = day.warmupSessions ?? data?.warmupSessions ?? null;
    for (const t of day.trades) {
      if (t.warmupBars == null) continue;
      cold ??= { trades: 0, net: 0, minBars };
      if (t.warmupBars < minBars) {
        cold.trades++;
        cold.net = r2(cold.net + t.net);
      }
    }
    if (ws != null && ws < WARMUP_SESSIONS_NEEDED) w.partial++;

    const barOf = (contract: string, hm: string): BtBar | undefined =>
      data?.contracts[contract]?.bars.find((b) => b.t.slice(0, 10) === day.date && b.t.slice(11, 16) === hm);
    /** True when a trade's exit was a gap at its exit bar's open (that slot was free at the open). */
    const exitAtOpen = (t: BtTrade) => {
      if (t.exitKind === 'EOD' || t.exitKind === 'SESSION_END') return true;
      const b = barOf(t.contract, t.exitTime);
      return !!b && near(t.exitPrice - slip, b.o, 0.006);
    };

    for (const t of day.trades) {
      tradeCount++;
      const tag = `${day.date} ${t.contract} ${t.entryTime}`;
      for (const id of ['gross', 'net', 'time', 'levels', 'lock', 'slots', 'side']) checks[id].checked++;

      if (!near((t.entryPrice - t.exitPrice) * t.qty, t.gross, 0.01 * t.qty + 0.02)) fail('gross', `${tag}: ${t.gross}`);
      const costs = orderCost('SELL', t.entryPrice, t.qty, brokerage) + orderCost('BUY', t.exitPrice, t.qty, brokerage);
      if (!near(costs, t.costs, 0.05) || !near(t.gross - t.costs, t.net, 0.02)) fail('net', `${tag}: costs ${t.costs} vs ${r2(costs)}`);

      const em = hmToMin(t.entryTime);
      const xm = hmToMin(t.exitTime);
      if (em > xm || (t.exitKind !== 'SESSION_END' && xm > eod) || t.entryTime < config.entryStart || t.entryTime > config.entryEnd) {
        fail('time', `${tag}: ${t.entryTime} → ${t.exitTime}`);
      }

      // The open the rules were sized on. A sub-slippage premium has its fill floored at ₹0.05, which loses the open:
      // those trades skip this check (their entry fill is still checked against the bar below).
      const decision = t.entryPrice + slip;
      const sl = r2(decision * (1 + config.slPct / 100));
      const tgt = config.targetPct > 0 ? r2(decision * (1 - config.targetPct / 100)) : null;
      if (slip > 0 && t.entryPrice <= 0.05 + 1e-9) {
        // floored fill: not comparable
      } else if (!near(sl, t.initialSl, 0.011) || (tgt == null) !== (t.targetPrice == null) || (tgt != null && !near(tgt, t.targetPrice!, 0.011))) {
        fail('levels', `${tag}: SL ${t.initialSl} vs ${sl}, target ${t.targetPrice} vs ${tgt}`);
      }

      if (data) {
        const eb = barOf(t.contract, t.entryTime);
        checks.entryFill.checked++;
        if (!eb || !near(t.entryPrice, Math.max(0.05, eb.o - slip), 0.006)) fail('entryFill', `${tag}: ${t.entryPrice} vs open ${eb?.o}`);
        checks.exitFill.checked++;
        const raw = t.exitPrice - slip;
        if (t.exitKind === 'EOD') {
          const xb = barOf(t.contract, t.exitTime);
          const prior = data.contracts[t.contract]?.bars.filter((b) => b.t.slice(0, 10) === day.date && b.t.slice(11, 16) < t.exitTime).pop();
          if (!(xb ? near(raw, xb.o, 0.006) : prior ? near(raw, prior.c, 0.006) : true)) fail('exitFill', `${tag}: EOD ${t.exitPrice}`);
        } else if (t.exitKind !== 'SESSION_END') {
          const xb = barOf(t.contract, t.exitTime);
          if (!xb || raw < xb.l - 0.006 || raw > xb.h + 0.006) fail('exitFill', `${tag}: exit ${t.exitPrice} outside ${xb?.l}..${xb?.h}`);
        }
      }

      // Slots at the entry bar's open: earlier entries still open then (exit later, or inside this bar not at a gap
      // at its open), plus entries opened earlier in this same minute (they hold a slot until it ends).
      const holding = day.trades.filter((o) => {
        if (o === t) return false;
        const oe = hmToMin(o.entryTime);
        const ox = hmToMin(o.exitTime);
        // Same entry minute: `n` is exit order, not entry order, so this may count a later entry. It cannot cause a
        // false failure: the simulator never opened more than the caps in one minute.
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
  return {
    at,
    configKey: backtestConfigKey(config),
    sessions: days.length,
    trades: tradeCount,
    sessionsWithBars,
    checks: Object.values(checks),
    warmup,
    coldEntries: cold,
  };
}
