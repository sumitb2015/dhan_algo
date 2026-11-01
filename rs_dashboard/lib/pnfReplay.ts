// Bar Replay for the P&F / Renko page (TradingView's "Bar replay"): the chart is shown as it stood at a past moment and played
// forward one chart bar at a time, with PRACTICE trading at the replayed prices. Pure: no clock, no fetch, no React.
//
// The cursor is a time (epoch s): each chart shows its 1-minute bars with t <= cursor, all closed. One step moves the cursor to the
// last minute of the next chart bar (one bar of the chart's interval), on the same clock buckets as the chart (resample).
// Practice trades live in a PracticeBook: never a ledger file, an order route or a broker.
import type { Bar } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';
import { applyPaperFill, FLAT_LEG, paperPnl, type PaperLeg } from './pnfOrderLogic.ts';
import { boxPriceAt, decideAuto, type AutoModel, type AutoPosition, type AutoSide } from './pnfAuto.ts';
import type { Market } from './straddlePnfLive.ts';

/** TradingView's replay speeds: chart-bar updates per second. */
export const REPLAY_SPEEDS = [
  { id: '10x', ms: 100, label: '10 upd per 1 sec' },
  { id: '7x', ms: Math.round(1000 / 7), label: '7 upd per 1 sec' },
  { id: '5x', ms: 200, label: '5 upd per 1 sec' },
  { id: '3x', ms: Math.round(1000 / 3), label: '3 upd per 1 sec' },
  { id: '1x', ms: 1000, label: '1 upd per 1 sec' },
  { id: '0.5x', ms: 2000, label: '1 upd per 2 sec' },
  { id: '0.3x', ms: 3000, label: '1 upd per 3 sec' },
  { id: '0.2x', ms: 5000, label: '1 upd per 5 sec' },
  { id: '0.1x', ms: 10_000, label: '1 upd per 10 sec' },
] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]['id'];
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = '1x';
export const speedMs = (id: ReplaySpeed) => REPLAY_SPEEDS.find(s => s.id === id)?.ms ?? 1000;
export const isReplaySpeed = (v: unknown): v is ReplaySpeed => REPLAY_SPEEDS.some(s => s.id === v);

/** How many of the (time-sorted) bars have t <= `t`: the replayed history is `bars.slice(0, countUpTo(bars, t))`. */
export function countUpTo(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The bars a chart shows at cursor `t` (the same objects, so a model built on the previous step can be carried on). */
export const barsUpTo = (bars: Bar[], t: number): Bar[] => bars.slice(0, countUpTo(bars, t));

/** 1-min bars that can sit in one chart bar of `interval` minutes (a day, week or month bucket can hold many). */
const bucketSpan = (interval: number) => (interval < 1440 ? interval : interval <= 1440 ? 1_000 : interval <= 10_080 ? 5_000 : 25_000);

/**
 * The cursor one chart bar later: the time of the last 1-min bar of the chart bar after `cursorT` (on the chart's clock buckets,
 * so a cursor in the middle of a bar completes that bar). Null at the end of the data.
 */
export function nextStepT(bars: Bar[], cursorT: number, interval: number, sessionCloseMin?: number): number | null {
  const i = countUpTo(bars, cursorT);
  if (i >= bars.length) return null;
  if (interval <= 1) return bars[i].t;
  const slice = bars.slice(i, i + bucketSpan(interval) + 1);
  const r = resample(slice, interval, sessionCloseMin, true);
  return r.endIdx.length ? slice[r.endIdx[0]].t : bars[i].t;
}

/** A start point: the cursor sits just before `t`, so the bar at `t` is the first one the replay reveals. */
export function cursorBefore(bars: Bar[], t: number): number {
  const i = countUpTo(bars, t - 1);
  return i > 0 ? bars[i - 1].t : (bars[0]?.t ?? t) - 60;
}

/**
 * "First available": the first 1-minute bar when the history starts with daily bars (`anchorT`, the first real minute), else the
 * first bar. "Random": any bar between that and the last session, never in the last session (there would be nothing to replay).
 */
export function firstAvailableT(bars: Bar[], anchorT?: number | null): number | null {
  if (!bars.length) return null;
  const i = anchorT ? countUpTo(bars, anchorT - 1) : 0;
  return bars[Math.min(i, bars.length - 1)].t;
}
export function randomStartT(bars: Bar[], rnd: () => number, anchorT?: number | null): number | null {
  const first = firstAvailableT(bars, anchorT);
  if (first === null) return null;
  const lo = countUpTo(bars, first - 1);
  const lastDay = Math.floor((bars[bars.length - 1].t + 19_800) / 86_400);
  let hi = bars.length;
  while (hi > lo && Math.floor((bars[hi - 1].t + 19_800) / 86_400) === lastDay) hi--;
  if (hi <= lo) return bars[lo].t;
  return bars[lo + Math.floor(rnd() * (hi - lo))].t;
}

// ── Practice trading ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PracticeSide = 'BUY' | 'SELL';
/** A rail order: a LIMIT (BUY below / SELL above the price when placed) fills at its level; a stop (the other side) at the close that crosses it. */
export interface PracticeOrder { id: string; chart: 1 | 2; targetKey: string; side: PracticeSide; kind: 'limit' | 'stop'; level: number; lots: number }
export interface PracticeTrade { id: string; t: number; chart: 1 | 2; targetKey: string; side: PracticeSide; lots: number; price: number; reason: 'manual' | 'order' | 'auto' | 'flatten' }
export interface PracticeAuto { on: boolean; position: AutoPosition | null; watermarkT: number; lots: number }
export interface PracticeBook {
  /** Per chart instrument (targetKey): one paper leg per contract leg (a straddle has two). */
  legs: Record<string, PaperLeg[]>;
  orders: PracticeOrder[];
  trades: PracticeTrade[];
  auto: Record<number, PracticeAuto>;
  seq: number;
  /** The replay cursor the book was last advanced to (orders crossed, AUTO decided); null before a start point. */
  at: number | null;
}
export const EMPTY_BOOK: PracticeBook = { legs: {}, orders: [], trades: [], auto: {}, seq: 0, at: null };

/** What a fill needs about the chart's instrument at the cursor. */
export interface PracticeQuote {
  chart: 1 | 2; targetKey: string; t: number;
  /** The chart price (a straddle's CE + PE) and each leg's price. */
  price: number; legPrices: number[];
  /** Rupees per point per lot, per leg. */
  unitsPerLot: number[];
}

/** A fill of `lots` (> 0) on `side` at the quote's leg prices (or `price` for a single-leg instrument, e.g. a limit level). */
export function practiceFill(book: PracticeBook, q: PracticeQuote, side: PracticeSide, lots: number, reason: PracticeTrade['reason'], price = q.price): PracticeBook {
  if (!(lots > 0) || !(price > 0)) return book;
  const legPrices = q.legPrices.length === 1 ? [price] : q.legPrices;
  const delta = side === 'BUY' ? lots : -lots;
  const legs = (book.legs[q.targetKey] ?? legPrices.map(() => FLAT_LEG)).map((l, i) => applyPaperFill(l, delta, legPrices[i] ?? 0, q.unitsPerLot[i] ?? 1));
  const seq = book.seq + 1;
  return {
    ...book, seq, legs: { ...book.legs, [q.targetKey]: legs },
    trades: [...book.trades, { id: `pr-${seq}`, t: q.t, chart: q.chart, targetKey: q.targetKey, side, lots, price, reason }],
  };
}

/** Lots open on an instrument (signed: + long, - short); a straddle's legs move together, so the first leg tells. */
export const openLots = (book: PracticeBook, targetKey: string) => book.legs[targetKey]?.[0]?.lots ?? 0;

/** Flattens the instrument's position at the quote. */
export function practiceFlatten(book: PracticeBook, q: PracticeQuote): PracticeBook {
  const lots = openLots(book, q.targetKey);
  return lots === 0 ? book : practiceFill(book, q, lots > 0 ? 'SELL' : 'BUY', Math.abs(lots), 'flatten');
}

/** A rail click: BUY below the price / SELL above it rests as a LIMIT, the other way round as a stop (the live rail's rule). */
export function practicePlace(book: PracticeBook, chart: 1 | 2, targetKey: string, side: PracticeSide, level: number, lots: number, price: number): PracticeBook {
  if (!(lots > 0) || !(level > 0)) return book;
  const kind = (side === 'BUY') === (level < price) ? 'limit' : 'stop';
  const seq = book.seq + 1;
  return { ...book, seq, orders: [...book.orders, { id: `po-${seq}`, chart, targetKey, side, kind, level, lots }] };
}
export const practiceCancel = (book: PracticeBook, id: string): PracticeBook => ({ ...book, orders: book.orders.filter(o => o.id !== id) });
export const practiceMove = (book: PracticeBook, id: string, level: number): PracticeBook =>
  ({ ...book, orders: book.orders.map(o => (o.id === id ? { ...o, level } : o)) });

/** Fills the instrument's resting orders that the price now at the quote has reached (a limit at its level, a stop at the price). */
export function practiceCross(book: PracticeBook, q: PracticeQuote): PracticeBook {
  let out = book;
  for (const o of book.orders) {
    if (o.targetKey !== q.targetKey) continue;
    const hit = o.kind === 'limit' ? (o.side === 'BUY' ? q.price <= o.level : q.price >= o.level) : (o.side === 'BUY' ? q.price >= o.level : q.price <= o.level);
    if (!hit) continue;
    out = practiceCancel(practiceFill(out, q, o.side, o.lots, 'order', o.kind === 'limit' && q.legPrices.length === 1 ? o.level : q.price), o.id);
  }
  return out;
}

/** Realised + open P&L of every practice position, marked at `quotes` (by targetKey); a position without a quote counts realised only. */
export function practicePnl(book: PracticeBook, quotes: Record<string, { legPrices: number[]; unitsPerLot: number[] } | undefined>): number {
  return Object.entries(book.legs).reduce((sum, [key, legs]) => {
    const q = quotes[key];
    return sum + (q ? paperPnl(legs, q.legPrices, q.unitsPerLot) : legs.reduce((s, l) => s + l.realised, 0));
  }, 0);
}

/**
 * Arms (or stops) practice AUTO on a chart; arming at `cursorT` ignores every signal at or before it (the live rule). Stopping
 * keeps an open position, which still exits on its reversal (as live AUTO's open row does).
 */
export function practiceAutoArm(book: PracticeBook, chart: 1 | 2, on: boolean, cursorT: number, lots: number): PracticeBook {
  const cur = book.auto[chart];
  return { ...book, auto: { ...book.auto, [chart]: { on, position: cur?.position ?? null, watermarkT: on ? cursorT : cur?.watermarkT ?? 0, lots } } };
}

/**
 * One practice AUTO decision on a chart at the cursor: the live engine's own rules (decideAuto) with the replay clock, booked
 * at the confirmed box / brick a single-leg chart reached (as PAPER AUTO books live), or the legs' prices for a straddle.
 */
export function practiceAutoStep(book: PracticeBook, q: PracticeQuote, model: AutoModel, market: Market): PracticeBook {
  const a = book.auto[q.chart];
  if (!a || (!a.on && !a.position)) return book;
  const d = decideAuto({ model, position: a.position, watermarkT: a.watermarkT, nowS: q.t + 60, market });
  if (d.action === 'enter' && a.on) {
    const px = q.legPrices.length === 1 ? d.boxPrice ?? q.price : q.price;
    const filled = practiceFill(book, q, d.side, a.lots, 'auto', px);
    return { ...filled, auto: { ...filled.auto, [q.chart]: { ...a, position: { side: d.side as AutoSide, entryBarT: d.signal.t }, watermarkT: d.signal.t } } };
  }
  if (d.action === 'exit' && a.position) {
    const box = d.col !== undefined ? boxPriceAt(model, d.col, model.columns[d.col].startBar) : null;
    const px = q.legPrices.length === 1 ? box ?? q.price : q.price;
    const filled = practiceFill(book, q, a.position.side === 'SELL' ? 'BUY' : 'SELL', a.lots, 'auto', px);
    return { ...filled, auto: { ...filled.auto, [q.chart]: { ...a, position: null } } };
  }
  return book;
}
