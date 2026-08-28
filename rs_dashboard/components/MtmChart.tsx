'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier, isMcxRow } from '@/lib/positionPnl';

// ─── Types ────────────────────────────────────────────────────────

export interface MtmPoint { time: string; pnl: number; realized?: number; unrealized?: number }

/** Where the historical part of the curve came from, so the UI can say so rather than
 *  presenting a realized-only approximation as if it were the real thing. */
export interface MtmSource {
  status: 'idle' | 'loading' | 'ready' | 'error';
  unresolved: string[];  // contracts marked at last traded price instead of a candle close
  truncated: number;
  error: string | null;
}

export interface MtmStats {
  current: number;
  dayHigh: number;
  dayHighIndex: number; // index into `data` of the first point reaching dayHigh — not the value,
  dayLow: number;       // since ties (e.g. multiple points flat at 0 before the first fill) would
  dayLowIndex: number;  // otherwise mark every tied point as a peak/trough.
  maxDrawdown: number;  // positive number = largest peak-to-trough drop from the running high
}

const MAX_TAIL_POINTS = 2000;
const SAMPLE_MS        = 2000; // cadence of the live tail sampled after the last trade fill

const FNO_CLOSE_MINUTES = 15 * 60 + 30; // 15:30 IST — matches NSE/BSE F&O session end
const MCX_CLOSE_MINUTES = 23 * 60 + 30; // 23:30 IST — MCX runs an evening session

function istMinutesSinceMidnight(d: Date): number | null {
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function withinSession(iso: string, closeMinutes: number): boolean {
  const mins = istMinutesSinceMidnight(new Date(iso));
  return mins !== null && mins <= closeMinutes;
}

/** When does today's book stop trading? An MCX leg runs to 23:30, so clipping the whole
 *  chart at the 15:30 equity close silently discards every evening commodity fill. */
function sessionCloseMinutes(trades: Record<string, unknown>[], positions?: Record<string, unknown>[]): number {
  return trades.some(isMcxRow) || (positions ?? []).some(isMcxRow) ? MCX_CLOSE_MINUTES : FNO_CLOSE_MINUTES;
}

function todayIstDateString(): string {
  // en-CA formats as YYYY-MM-DD, which is what a bare time string below needs prepended.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

const BARE_TIME = /^\d{2}:\d{2}:\d{2}$/;

// Kotak's trade-book fill time is HH:MM:SS with no date at all (unlike Dhan/Zerodha,
// which both include the full date) — `new Date("09:29:21")` is Invalid Date, which
// silently dropped every Kotak fill from the session-window filter below. Stamp it
// with today's IST date and an explicit +05:30 offset so it parses unambiguously
// regardless of the machine's local timezone.
function normalizeTradeTime(raw: string): string {
  return BARE_TIME.test(raw) ? `${todayIstDateString()}T${raw}+05:30` : raw;
}

function rowIdentityKey(row: Record<string, unknown>): string {
  const secId = String(row.securityId ?? row.security_id ?? row.instrument_token ?? row.tok ?? '').trim();
  const prod = String(row.productType ?? row.product ?? row.prod ?? '').trim().toUpperCase();
  const sym = String(row.tradingSymbol ?? row.customSymbol ?? row.tradingsymbol ?? row.symbol ?? '').trim();
  if (secId) return prod ? `${secId}::${prod}` : secId;
  if (sym) return prod ? `${sym}::${prod}` : sym;
  return '';
}

function extractClientStartingPositions(positions: Record<string, unknown>[]): Map<string, { qty: number; avgPrice: number; mult: number }> {
  const map = new Map<string, { qty: number; avgPrice: number; mult: number }>();
  for (const p of positions) {
    const k = rowIdentityKey(p);
    if (!k) continue;
    const mult = contractMultiplier(p);
    const cfBuy = Number(p.carryForwardBuyQty ?? p.cfBuyQty) || 0;
    const cfSell = Number(p.carryForwardSellQty ?? p.cfSellQty) || 0;
    const cfBuyVal = Number(p.carryForwardBuyValue ?? p.cfBuyAmt) || 0;
    const cfSellVal = Number(p.carryForwardSellValue ?? p.cfSellAmt) || 0;

    const overnight = Number(p.overnightQuantity ?? p.overnight_quantity) || 0;
    let buy = cfBuy;
    let sell = cfSell;
    let buyVal = cfBuyVal;
    let sellVal = cfSellVal;

    if (overnight !== 0 && buy === 0 && sell === 0) {
      if (overnight > 0) {
        buy = overnight;
        buyVal = overnight * (Number(p.buyAvg ?? p.buy_price) || 0);
      } else {
        sell = Math.abs(overnight);
        sellVal = Math.abs(overnight) * (Number(p.sellAvg ?? p.sell_price) || 0);
      }
    }

    if (buy > 0) {
      const avg = buyVal && mult > 0 ? buyVal / (buy * mult) : (Number(p.buyAvg) || 0);
      map.set(k, { qty: buy, avgPrice: avg, mult });
    } else if (sell > 0) {
      const avg = sellVal && mult > 0 ? sellVal / (sell * mult) : (Number(p.sellAvg) || 0);
      map.set(k, { qty: -sell, avgPrice: avg, mult });
    }
  }
  return map;
}

// ─── Fallback: cumulative REALIZED P&L from the trade book ─────────
function buildTradeMtmSeries(trades: Record<string, unknown>[], positions: Record<string, unknown>[] = []): MtmPoint[] {
  const closeMinutes = sessionCloseMinutes(trades, positions);
  const fills = trades
    .map(t => ({
      key: rowIdentityKey(t),
      symbol: String(t.tradingSymbol ?? t.customSymbol ?? t.tradingsymbol ?? t.symbol ?? ''),
      side: String(t.transactionType ?? '').toUpperCase(),
      qty: Number(t.tradedQuantity ?? t.quantity) || 0,
      price: Number(t.tradedPrice ?? t.price) || 0,
      time: normalizeTradeTime(String(t.createTime ?? t.exchangeTime ?? t.fill_timestamp ?? '')),
      mult: contractMultiplier(t),
    }))
    .filter(t => t.symbol && t.qty > 0 && t.price > 0 && t.time && withinSession(t.time, closeMinutes) && (t.side === 'BUY' || t.side === 'SELL'))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const running = extractClientStartingPositions(positions);
  let cumRealized = 0;
  const points: MtmPoint[] = [];

  for (const fill of fills) {
    const k = fill.key || fill.symbol;
    const pos = running.get(k) ?? { qty: 0, avgPrice: 0, mult: fill.mult };
    const signedQty = fill.side === 'BUY' ? fill.qty : -fill.qty;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      // Opening or adding to a position in the same direction — roll the average cost, nothing realized.
      const newQty = pos.qty + signedQty;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + fill.price * fill.qty) / Math.abs(newQty);
      pos.qty = newQty;
      pos.mult = fill.mult;
    } else {
      // Reducing, closing, or reversing through zero.
      const closingQty = Math.min(Math.abs(pos.qty), fill.qty);
      const closingSign = pos.qty > 0 ? 1 : -1;
      const realizedDelta = closingSign * closingQty * (fill.price - pos.avgPrice) * fill.mult;
      const remaining = fill.qty - closingQty;
      pos.qty += signedQty;
      if (remaining > 0) pos.avgPrice = fill.price; // reversed — leftover opens fresh in the other direction
      pos.mult = fill.mult;
      cumRealized += realizedDelta;
    }

    running.set(k, pos);
    points.push({ time: fill.time, pnl: cumRealized, realized: cumRealized });
  }

  // Deduplicate points with identical second stamps
  const deduped: MtmPoint[] = [];
  for (const p of points) {
    if (deduped.length && deduped[deduped.length - 1].time === p.time) {
      deduped[deduped.length - 1] = p;
    } else {
      deduped.push(p);
    }
  }
  return deduped;
}

// ─── Hook: server-marked MTM curve ─────────────────────────────────

const IDLE_SOURCE: MtmSource = { status: 'idle', unresolved: [], truncated: 0, error: null };

// Stable identities, so downstream memos don't rerun while the book is stale.
const NO_TRADES: Record<string, unknown>[] = [];
const NO_POSITIONS: Record<string, unknown>[] = [];

function useBrokerData(
  broker: Broker,
  trades: Record<string, unknown>[],
  positions: Record<string, unknown>[],
): { trades: Record<string, unknown>[]; positions: Record<string, unknown>[] } {
  const seenTrades = useRef(trades);
  const seenPositions = useRef(positions);
  const brokerRef = useRef(broker);
  if (seenTrades.current !== trades || seenPositions.current !== positions) {
    seenTrades.current = trades;
    seenPositions.current = positions;
    brokerRef.current = broker;
  }
  const isCurrent = brokerRef.current === broker;
  return {
    trades: isCurrent ? trades : NO_TRADES,
    positions: isCurrent ? positions : NO_POSITIONS,
  };
}

// Rebuilding the curve costs one rate-limited Dhan intraday call per contract traded today,
// so it is only worth doing when a new fill has actually landed — and never more than once
// a minute, however fast the fills arrive.
const MARK_REFRESH_MS = 60_000;

/** Asks the server to re-mark today's book against 1-minute candles. Refetches when the fill
 *  count or positions count changes (throttled), never on the 5s position poll alone. */
function useMarkedMtmSeries(
  broker: Broker,
  trades: Record<string, unknown>[],
  positions: Record<string, unknown>[],
) {
  const [points, setPoints] = useState<MtmPoint[]>([]);
  const [source, setSource] = useState<MtmSource>(IDLE_SOURCE);
  const lastKey = useRef('');
  const lastFetchAt = useRef(0);
  const reqId = useRef(0);

  useEffect(() => {
    // Broker switch ⇒ a different account's book; drop the curve rather than re-marking onto it.
    lastKey.current = '';
    lastFetchAt.current = 0;
    reqId.current += 1;
    setPoints([]);
    setSource(IDLE_SOURCE);
  }, [broker]);

  useEffect(() => {
    const key = `${trades.length}:${positions.length}`;
    if ((trades.length === 0 && positions.length === 0) || key === lastKey.current) return;
    // Still cooling down.
    if (Date.now() - lastFetchAt.current < MARK_REFRESH_MS) return;

    lastKey.current = key;
    lastFetchAt.current = Date.now();
    const id = ++reqId.current;
    setSource(prev => ({ ...prev, status: 'loading' }));

    fetch('/api/scalper/mtm-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker, trades, positions }),
    })
      .then(r => r.json())
      .then((json: { success?: boolean; points?: MtmPoint[]; unresolved?: string[]; truncated?: number; error?: string }) => {
        // A slower earlier request must not overwrite a newer one's answer.
        if (id !== reqId.current) return;
        if (!json?.success) throw new Error(json?.error || 'marking failed');
        setPoints(Array.isArray(json.points) ? json.points : []);
        setSource({
          status: 'ready',
          unresolved: json.unresolved ?? [],
          truncated: json.truncated ?? 0,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (id !== reqId.current) return;
        // Let the next poll retry once the cooldown lapses rather than wedging on one failure.
        lastKey.current = '';
        setSource({ status: 'error', unresolved: [], truncated: 0, error: err.message });
      });
  }, [broker, trades, positions]);

  return { points, source };
}

// ─── Hook: marked MTM curve + a short live tail ────────────────────

export function useMtmHistory(
  broker: Broker,
  rawTrades: Record<string, unknown>[],
  rawPositions: Record<string, unknown>[],
  unrealizedPnl: number,
): { data: MtmPoint[]; stats: MtmStats; source: MtmSource } {
  const { trades, positions } = useBrokerData(broker, rawTrades, rawPositions);
  const fallbackSeries = useMemo(() => buildTradeMtmSeries(trades, positions), [trades, positions]);
  const { points: markedSeries, source } = useMarkedMtmSeries(broker, trades, positions);

  // Prefer the marked curve; the realized-only replay just fills the gap until it arrives.
  const history = markedSeries.length ? markedSeries : fallbackSeries;

  // The tail anchor is the cumulative realized P&L from the marked series or fallback.
  const lastRealized = markedSeries.length
    ? (markedSeries[markedSeries.length - 1].realized ?? 0)
    : (fallbackSeries.length ? fallbackSeries[fallbackSeries.length - 1].pnl : 0);

  const [liveTail, setLiveTail] = useState<MtmPoint[]>([]);
  const brokerRef = useRef(broker);
  const lastRealizedRef = useRef(lastRealized);
  lastRealizedRef.current = lastRealized;
  const unrealizedRef = useRef(unrealizedPnl);
  unrealizedRef.current = unrealizedPnl;

  // Broker switch ⇒ this is a different account's P&L; never splice it onto the prior tail.
  useEffect(() => {
    if (brokerRef.current === broker) return;
    brokerRef.current = broker;
    setLiveTail([]);
  }, [broker]);

  const closeMinutes = useMemo(() => sessionCloseMinutes(trades, positions), [trades, positions]);
  const closeMinutesRef = useRef(closeMinutes);
  closeMinutesRef.current = closeMinutes;

  const hasDataRef = useRef(trades.length > 0 || positions.length > 0);
  hasDataRef.current = trades.length > 0 || positions.length > 0;

  useEffect(() => {
    const sample = () => {
      const unrealized = unrealizedRef.current;
      const now = new Date();
      if (!hasDataRef.current) return;
      if (!Number.isFinite(unrealized) || !withinSession(now.toISOString(), closeMinutesRef.current)) return;
      const pnl = lastRealizedRef.current + unrealized;
      setLiveTail(prev => [...prev, { time: now.toISOString(), pnl, realized: lastRealizedRef.current, unrealized }].slice(-MAX_TAIL_POINTS));
    };
    sample();
    const id = setInterval(sample, SAMPLE_MS);
    return () => clearInterval(id);
  }, [broker]);

  const data = useMemo<MtmPoint[]>(() => {
    const lastHistoryMs = history.length ? new Date(history[history.length - 1].time).getTime() : null;
    const tail = lastHistoryMs !== null ? liveTail.filter(p => new Date(p.time).getTime() > lastHistoryMs) : liveTail;
    return [...history, ...tail];
  }, [history, liveTail]);

  const stats = useMemo<MtmStats>(() => {
    if (data.length === 0) return { current: 0, dayHigh: 0, dayHighIndex: -1, dayLow: 0, dayLowIndex: -1, maxDrawdown: 0 };
    let dayHigh = data[0].pnl;
    let dayHighIndex = 0;
    let dayLow = data[0].pnl;
    let dayLowIndex = 0;
    // Drawdown is measured from flat, not from the first plotted point: the account starts
    // the session at 0, so an opening dip is a real drawdown. Seeding `peak` from data[0]
    // (which may already be deep in the red) understated it.
    let peak = 0;
    let maxDrawdown = 0;
    data.forEach((p, i) => {
      if (p.pnl > dayHigh) { dayHigh = p.pnl; dayHighIndex = i; }
      if (p.pnl < dayLow) { dayLow = p.pnl; dayLowIndex = i; }
      if (p.pnl > peak) peak = p.pnl;
      const dd = peak - p.pnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    });
    return { current: data[data.length - 1].pnl, dayHigh, dayHighIndex, dayLow, dayLowIndex, maxDrawdown };
  }, [data]);

  return { data, stats, source };
}

// ─── Presentation helpers ───────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

function fmtPnl(n: number, signed = true): string {
  const sign = signed ? (n >= 0 ? '+' : '-') : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toneClass(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-300';
}

function StatTile({ label, value, valueClass }: { label: string; value: string; valueClass: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 min-w-[130px]">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const value = payload[0].value;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-400 mb-1 font-medium">{fmtTime(label ?? '')}</p>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${value >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}`} />
        <span className="text-zinc-300">MTM:</span>
        <span className={`font-semibold ${toneClass(value)}`}>{fmtPnl(value)}</span>
      </div>
    </div>
  );
}

// ─── Zero-anchored split color (green above, red below) ────────────

const GREEN = '#34d399';
const RED   = '#fb7185';

/** Y-axis domain padded around the data, plus the % offset (from the top) where pnl=0
 *  falls in that domain — used to hard-split the fill/stroke gradients exactly at zero,
 *  so the line is green while MTM is positive and red the moment it dips below, regardless
 *  of where the session ends up. */
function useZeroSplit(data: MtmPoint[]) {
  return useMemo(() => {
    if (data.length === 0) return { domainMin: -1, domainMax: 1, zeroOffsetPct: 50 };
    const values = data.map(p => p.pnl);
    const rawMin = Math.min(0, ...values);
    const rawMax = Math.max(0, ...values);
    const span = rawMax - rawMin || 1;
    const pad = span * 0.1;
    const domainMin = rawMin - pad;
    const domainMax = rawMax + pad;
    const zeroOffsetPct = Math.min(100, Math.max(0, (domainMax / (domainMax - domainMin)) * 100));
    return { domainMin, domainMax, zeroOffsetPct };
  }, [data]);
}

/** Says how trustworthy the curve currently is. The realized-only fallback is a genuinely
 *  different (and misleading) quantity, so it is never drawn without saying so. */
function SourceBadge({ source }: { source: MtmSource }) {
  let text: string;
  if (source.status === 'ready' && source.unresolved.length === 0 && source.truncated === 0) {
    text = 'Marked to 1-min closes · pre-charges';
  } else if (source.status === 'ready') {
    const unpriced = source.unresolved.length + source.truncated;
    text = `Partial · ${unpriced} contract${unpriced === 1 ? '' : 's'} marked at last traded price`;
  } else if (source.status === 'error') {
    text = `Realized P&L only — open legs unmarked (${source.error})`;
  } else {
    text = 'Realized P&L only — marking open legs to market…';
  }

  return (
    <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
      <p className="text-[11px] text-zinc-400">{text}</p>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export default function MtmChart({ data, stats, source }: { data: MtmPoint[]; stats: MtmStats; source: MtmSource }) {
  const { domainMin, domainMax, zeroOffsetPct } = useZeroSplit(data);
  const fadeAbove = Math.max(0, zeroOffsetPct - 15);
  const fadeBelow = Math.min(100, zeroOffsetPct + 15);

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <StatTile label="Current MTM" value={fmtPnl(stats.current)} valueClass={toneClass(stats.current)} />
        <StatTile label="Day High" value={fmtPnl(stats.dayHigh)} valueClass={toneClass(stats.dayHigh)} />
        <StatTile label="Day Low" value={fmtPnl(stats.dayLow)} valueClass={toneClass(stats.dayLow)} />
        <StatTile
          label="Max Drawdown"
          value={stats.maxDrawdown > 0 ? `-${fmtPnl(stats.maxDrawdown, false)}` : fmtPnl(0, false)}
          valueClass={stats.maxDrawdown > 0 ? 'text-rose-400' : 'text-zinc-300'}
        />
        <SourceBadge source={source} />
      </div>

      {data.length < 2 ? (
        <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
          Collecting data…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <defs>
              <linearGradient id="mtmFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
                <stop offset={`${fadeAbove}%`} stopColor={GREEN} stopOpacity={0.04} />
                <stop offset={`${zeroOffsetPct}%`} stopColor={GREEN} stopOpacity={0} />
                <stop offset={`${zeroOffsetPct}%`} stopColor={RED} stopOpacity={0} />
                <stop offset={`${fadeBelow}%`} stopColor={RED} stopOpacity={0.04} />
                <stop offset="100%" stopColor={RED} stopOpacity={0.35} />
              </linearGradient>
              <linearGradient id="mtmStroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset={`${zeroOffsetPct}%`} stopColor={GREEN} />
                <stop offset={`${zeroOffsetPct}%`} stopColor={RED} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 11 }}
              axisLine={{ stroke: '#3f3f46' }}
              tickLine={false}
              tickFormatter={(v: string, i: number) => (i % Math.max(1, Math.floor(data.length / 8)) === 0 ? fmtTime(v) : '')}
            />
            <YAxis
              domain={[domainMin, domainMax]}
              tick={{ fill: '#71717a', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={70}
              tickFormatter={(v: number) => fmtPnl(v)}
            />
            <Tooltip content={<ChartTooltip />} />
            <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="pnl"
              name="MTM"
              stroke="url(#mtmStroke)"
              strokeWidth={2}
              fill="url(#mtmFill)"
              dot={(props: { cx?: number; cy?: number; index?: number }) => {
                const { cx, cy, index } = props;
                // ReferenceDot can't reliably locate a point on a string-category x-axis (it
                // collapses to the axis origin), so the peak/trough markers are drawn as the
                // line's own per-point dots instead — they inherit Recharts' real pixel position.
                // Matched by array index (not value), since ties — e.g. several points flat at
                // 0 before the first fill — would otherwise mark every tied point as a peak/trough.
                if (index === stats.dayHighIndex) {
                  return <circle key={`peak-${index}`} cx={cx} cy={cy} r={5} fill={GREEN} stroke="#052e1e" strokeWidth={2} />;
                }
                if (index === stats.dayLowIndex) {
                  return <circle key={`trough-${index}`} cx={cx} cy={cy} r={5} fill={RED} stroke="#450a0a" strokeWidth={2} />;
                }
                return <circle key={`dot-${index}`} cx={cx} cy={cy} r={0} />;
              }}
              activeDot={(props: { cx?: number; cy?: number; payload?: MtmPoint }) => {
                const { cx, cy, payload } = props;
                const color = (payload?.pnl ?? 0) >= 0 ? GREEN : RED;
                return <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={3} fill={color} stroke={color} />;
              }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
