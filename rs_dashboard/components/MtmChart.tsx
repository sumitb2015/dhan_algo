'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier } from '@/lib/positionPnl';

// ─── Types ────────────────────────────────────────────────────────

export interface MtmPoint { time: string; pnl: number }

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

const FNO_CLOSE_MINUTES = 15 * 60 + 40; // 15:40 IST — chart stops here, matching FNO session end

function istMinutesSinceMidnight(d: Date): number | null {
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

function withinFnoSession(iso: string): boolean {
  const mins = istMinutesSinceMidnight(new Date(iso));
  return mins !== null && mins <= FNO_CLOSE_MINUTES;
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

// ─── Reconstruct cumulative realized P&L from the trade book ───────
//
// Walks today's fills in order, tracking a weighted-average cost per symbol (same
// method Dhan/Zerodha/Kotak positions already use), and books realized P&L each time
// a fill reduces, closes, or reverses an open quantity. This is the only source that
// can reconstruct *historical* MTM — the dashboard has no stored tick history to
// replay unrealized P&L against — so it also works immediately after a reload or
// after market hours, unlike a client-side sample buffer that only grows from the
// moment the page was opened.
function buildTradeMtmSeries(trades: Record<string, unknown>[]): MtmPoint[] {
  const fills = trades
    .map(t => ({
      symbol: String(t.tradingSymbol ?? t.customSymbol ?? ''),
      side: String(t.transactionType ?? '').toUpperCase(),
      qty: Number(t.tradedQuantity) || 0,
      price: Number(t.tradedPrice) || 0,
      time: normalizeTradeTime(String(t.createTime ?? t.exchangeTime ?? '')),
      mult: contractMultiplier(t),
    }))
    .filter(t => t.symbol && t.qty > 0 && t.price > 0 && t.time && withinFnoSession(t.time) && (t.side === 'BUY' || t.side === 'SELL'))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  const running = new Map<string, { qty: number; avgPrice: number }>();
  let cumRealized = 0;
  const points: MtmPoint[] = [];

  for (const fill of fills) {
    const pos = running.get(fill.symbol) ?? { qty: 0, avgPrice: 0 };
    const signedQty = fill.side === 'BUY' ? fill.qty : -fill.qty;

    if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) {
      // Opening or adding to a position in the same direction — roll the average cost, nothing realized.
      const newQty = pos.qty + signedQty;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + fill.price * fill.qty) / Math.abs(newQty);
      pos.qty = newQty;
    } else {
      // Reducing, closing, or reversing through zero.
      const closingQty = Math.min(Math.abs(pos.qty), fill.qty);
      const closingSign = pos.qty > 0 ? 1 : -1;
      const realizedDelta = closingSign * closingQty * (fill.price - pos.avgPrice) * fill.mult;
      const remaining = fill.qty - closingQty;
      pos.qty += signedQty;
      if (remaining > 0) pos.avgPrice = fill.price; // reversed — leftover opens fresh in the other direction
      cumRealized += realizedDelta;
    }

    running.set(fill.symbol, pos);
    points.push({ time: fill.time, pnl: cumRealized });
  }

  // Dhan/Kotak trade timestamps only carry 1-second resolution, so two fills landing in the
  // same second produce two points with an identical x-axis category value. Recharts' category
  // scale plots same-label points at one pixel column, distorting the line into a false spike
  // and confusing which point's value hover/tooltip resolves to — so collapse duplicates down
  // to the last (most current) cumulative value for that displayed second.
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

// ─── Hook: trade-book-derived MTM curve + a short live tail ────────

export function useMtmHistory(
  broker: Broker,
  trades: Record<string, unknown>[],
  unrealizedPnl: number,
): { data: MtmPoint[]; stats: MtmStats } {
  const tradeSeries = useMemo(() => buildTradeMtmSeries(trades), [trades]);
  const lastRealized = tradeSeries.length ? tradeSeries[tradeSeries.length - 1].pnl : 0;

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

  // The live tail only fills the gap between "last trade fill" and "now" — the currently-open
  // book's unrealized swing, which the trade book alone can't show. It's anchored on the
  // trade-derived realized total (not the broker's live totalPnl) so the curve stays continuous:
  // totalPnl bakes in brokerage/charges the naive trade replay above doesn't model, and splicing
  // it in directly would show a fake jump at the exact moment the series crosses from trade-
  // derived points to live samples. Sampling (and therefore the chart) stops at session close.
  useEffect(() => {
    const sample = () => {
      const unrealized = unrealizedRef.current;
      const now = new Date();
      if (!Number.isFinite(unrealized) || !withinFnoSession(now.toISOString())) return;
      const pnl = lastRealizedRef.current + unrealized;
      setLiveTail(prev => [...prev, { time: now.toISOString(), pnl }].slice(-MAX_TAIL_POINTS));
    };
    sample();
    const id = setInterval(sample, SAMPLE_MS);
    return () => clearInterval(id);
  }, [broker]);

  const data = useMemo<MtmPoint[]>(() => {
    const lastTradeMs = tradeSeries.length ? new Date(tradeSeries[tradeSeries.length - 1].time).getTime() : null;
    const tail = lastTradeMs !== null ? liveTail.filter(p => new Date(p.time).getTime() > lastTradeMs) : liveTail;
    return [...tradeSeries, ...tail];
  }, [tradeSeries, liveTail]);

  const stats = useMemo<MtmStats>(() => {
    if (data.length === 0) return { current: 0, dayHigh: 0, dayHighIndex: -1, dayLow: 0, dayLowIndex: -1, maxDrawdown: 0 };
    let dayHigh = data[0].pnl;
    let dayHighIndex = 0;
    let dayLow = data[0].pnl;
    let dayLowIndex = 0;
    let peak = data[0].pnl;
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

  return { data, stats };
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

// ─── Main component ──────────────────────────────────────────────────

export default function MtmChart({ data, stats }: { data: MtmPoint[]; stats: MtmStats }) {
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
