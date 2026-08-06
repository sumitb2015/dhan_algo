'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { X } from 'lucide-react';
import type { TrendingOiRow } from '@/app/api/trending-oi/route';

/* ── Palette ───────────────────────────────────────────────────────────────
 * Two hues carry everything: calls red, puts blue. The Diff. in OI bars reuse
 * the same pair as a diverging encoding (positive = puts ahead = blue), so the
 * bar colour tells you which line is winning without adding a third hue.
 *
 * This deliberately does NOT use the emerald/rose pair the table uses for
 * signed values: green↔red is the classic deuteranope collision (OKLab ΔE 5.6
 * — a hard fail), whereas blue↔red separates at ΔE 26.7 protan / 35.2 normal.
 * Sign is additionally carried in words by the tooltip and the insight list, so
 * nothing here is encoded by colour alone. */
const CALL_HUE = '#ef4444';
const PUT_HUE = '#3b82f6';
const CALL_FILL = 'rgba(239, 68, 68, 0.28)';
const PUT_FILL = 'rgba(59, 130, 246, 0.28)';
const SPOT_HUE = '#f59e0b';

type SeriesKey = 'callChng' | 'putChng' | 'diff';

const SERIES: { key: SeriesKey; label: string; hue: string }[] = [
  { key: 'callChng', label: 'Chng. In Call OI', hue: CALL_HUE },
  { key: 'putChng', label: 'Chng. In Put OI', hue: PUT_HUE },
  { key: 'diff', label: 'Diff. in OI', hue: '#a1a1aa' },
];

interface Point {
  ts: number;
  timeLabel: string;
  callChng: number | null;
  putChng: number | null;
  diff: number | null;
  chngDir: number | null;
  spot: number | null;
  netPcr: number | null;
  sentiment: 'Bullish' | 'Bearish' | null;
}

export interface TrendingOiChartModalProps {
  rows: TrendingOiRow[];
  interval: string;
  expiry: string;
  spot?: number;
  strikeCount: number;
  onClose: () => void;
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : '−'}${fmtOI(Math.abs(n))}`;
}

/** Axis ticks must share ONE unit — mixing "+2.55Cr" and "+85.00L" down a single
 *  scale makes the reader re-anchor at every gridline. Pick the unit from the
 *  largest value on the axis and hold it for every tick. */
function axisFormatter(maxAbs: number): (v: number) => string {
  const [div, suffix] = maxAbs >= 10_000_000 ? [10_000_000, 'Cr']
    : maxAbs >= 100_000 ? [100_000, 'L']
      : maxAbs >= 1_000 ? [1_000, 'K']
        : [1, ''];
  const digits = div === 1 ? 0 : 2;
  return (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${(Math.abs(v) / div).toFixed(digits)}${suffix}`;
}

function fmtTick(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  });
}

/** Rows carry `date` as DD-MM-YYYY and `time` as HH:MM:SS (trending_oi_fetch.py:450).
 *  `new Date(row.date)` misreads that, so reassemble an explicit IST instant. */
function toTs(date: string, time: string): number {
  const [dd, mm, yyyy] = date.split('-');
  if (!dd || !mm || !yyyy) return NaN;
  return Date.parse(`${yyyy}-${mm}-${dd}T${time}+05:30`);
}

function isoDate(date: string): string {
  const [dd, mm, yyyy] = date.split('-');
  return dd && mm && yyyy ? `${yyyy}-${mm}-${dd}` : date;
}

/* ── Insights ─────────────────────────────────────────────────────────────
 * Every bullet is derived from a number that is also on screen (chart + the
 * table behind the modal). Descriptive only — no trade suggestions. */

type Tone = 'bullish' | 'bearish' | 'neutral';
interface Insight { tone: Tone; label: string; text: string }

function buildInsights(pts: Point[]): Insight[] {
  const out: Insight[] = [];
  const all = pts.filter((p) => p.diff !== null);
  // The opening bucket is the baseline every change is measured against, so its
  // three values are structurally 0. Leaving it in reports a fake session low of
  // "+0 at 09:15" and a fake crossover — drop it from the analysis.
  const baseline = all.length > 1 && all[0].diff === 0 && (all[0].callChng ?? 0) === 0 && (all[0].putChng ?? 0) === 0;
  const series = baseline ? all.slice(1) : all;
  if (series.length === 0) return out;

  const last = series[series.length - 1];
  const diff = last.diff as number;
  // ~5 buckets back, or the oldest bucket when the session is still young.
  const backIdx = Math.max(0, series.length - 6);
  const back = series[backIdx];

  // 1 ── Current bias
  out.push({
    tone: diff > 0 ? 'bullish' : diff < 0 ? 'bearish' : 'neutral',
    label: 'Current bias',
    text: diff === 0
      ? `Call and put OI have moved by exactly the same amount since open (as of ${last.timeLabel}).`
      : `${diff > 0 ? 'Puts' : 'Calls'} have added ${fmtOI(Math.abs(diff))} more OI than ${diff > 0 ? 'calls' : 'puts'} since open — a ${diff > 0 ? 'bullish' : 'bearish'} tilt as of ${last.timeLabel}.`,
  });

  // 2 ── Write ratio, and whether the gap is opening or closing
  if (last.callChng !== null && last.putChng !== null && last.callChng > 0 && last.putChng > 0) {
    const ratio = last.putChng / last.callChng;
    let trend = '';
    if (back !== last && back.callChng !== null && back.putChng !== null && back.callChng > 0 && back.putChng > 0) {
      const prev = back.putChng / back.callChng;
      trend = ratio > prev * 1.05 ? ', and widening'
        : ratio < prev * 0.95 ? ', and narrowing'
          : ', and holding steady';
    }
    out.push({
      tone: ratio > 1.05 ? 'bullish' : ratio < 0.95 ? 'bearish' : 'neutral',
      label: 'Write ratio',
      text: `Put writing is running at ${ratio.toFixed(2)}× call writing since open${trend} (calls ${fmtOI(last.callChng)}, puts ${fmtOI(last.putChng)}).`,
    });
  }

  // 3 ── Unwinding: a cumulative change below zero means that side is being
  //      covered rather than written, which reads opposite to the usual sign.
  const sides: { name: string; cur: number | null; prev: number | null; tone: Tone }[] = [
    { name: 'Call', cur: last.callChng, prev: back.callChng, tone: 'bullish' },
    { name: 'Put', cur: last.putChng, prev: back.putChng, tone: 'bearish' },
  ];
  for (const s of sides) {
    if (s.cur === null || s.cur >= 0) continue;
    const falling = s.prev !== null && s.cur < s.prev;
    out.push({
      tone: s.tone,
      label: `${s.name} unwinding`,
      text: `${s.name} OI is ${fmtOI(Math.abs(s.cur))} BELOW the open — ${s.name.toLowerCase()} writers are covering${falling ? ', and the unwind is still deepening' : ', though it has stopped deepening'}.`,
    });
  }

  // 4 ── Last zero-line crossover. Track the last NON-ZERO sign rather than
  //      comparing adjacent values: diff_in_oi does land on exactly 0 in real
  //      sessions, and treating that as a crossing both invents a flip and
  //      mislabels its direction (a fall from +5 to 0 would read as "flipped
  //      positive"). A zero is a pause, not a flip — skip it and wait for the
  //      next signed value to decide.
  let prevSign = 0;
  let crossIdx = -1;
  let crossUp = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i].diff as number;
    const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (sign === 0) continue;
    if (prevSign !== 0 && sign !== prevSign) { crossIdx = i; crossUp = sign > 0; }
    prevSign = sign;
  }
  if (crossIdx > 0) {
    const at = series[crossIdx];
    const ago = series.length - 1 - crossIdx;
    out.push({
      tone: crossUp ? 'bullish' : 'bearish',
      label: 'Last flip',
      text: `Diff. in OI last crossed zero at ${at.timeLabel}, flipping ${crossUp ? 'positive (puts took the lead)' : 'negative (calls took the lead)'} — ${ago} bucket${ago === 1 ? '' : 's'} ago.`,
    });
  } else if (series.length > 1) {
    out.push({
      tone: diff >= 0 ? 'bullish' : 'bearish',
      label: 'No flip',
      text: `Diff. in OI has stayed ${diff >= 0 ? 'positive' : 'negative'} for the whole session — one-sided positioning, no contest between the two legs.`,
    });
  }

  // 5 ── Session extremes and where we sit inside them
  const hi = series.reduce((a, b) => ((b.diff as number) > (a.diff as number) ? b : a));
  const lo = series.reduce((a, b) => ((b.diff as number) < (a.diff as number) ? b : a));
  const span = (hi.diff as number) - (lo.diff as number);
  if (span > 0) {
    const pct = ((diff - (lo.diff as number)) / span) * 100;
    out.push({
      tone: pct >= 66 ? 'bullish' : pct <= 33 ? 'bearish' : 'neutral',
      label: 'Session range',
      text: `Diff. in OI ranged ${fmtSigned(lo.diff as number)} (${lo.timeLabel}) to ${fmtSigned(hi.diff as number)} (${hi.timeLabel}); it now sits at ${pct.toFixed(0)}% of that range.`,
    });
  }

  // 6 ── Momentum: the claim is "3 CONSECUTIVE buckets", so read the last three
  //      buckets positionally. Collecting the last three non-zero values instead
  //      would let nulls and flat buckets in between pass as consecutive — real
  //      responses do contain both.
  if (series.length >= 3) {
    const tail = series.slice(-3).map((p) => p.chngDir);
    const allUp = tail.every((v) => v !== null && v > 0);
    const allDown = tail.every((v) => v !== null && v < 0);
    if (allUp || allDown) {
      out.push({
        tone: allUp ? 'bullish' : 'bearish',
        label: 'Momentum',
        text: `The bias has moved ${allUp ? 'further bullish' : 'further bearish'} for 3 consecutive buckets — the shift is building, not oscillating.`,
      });
    }
  }

  // 7 ── Price/OI divergence — the one non-obvious read. Only fire when both
  //      legs are unambiguous, so it stays a signal rather than noise.
  const spots = series.filter((p) => p.spot !== null && p.spot > 0);
  if (spots.length >= 8 && back !== last && back.diff !== null && last.spot) {
    const maxSpot = Math.max(...spots.map((p) => p.spot as number));
    const minSpot = Math.min(...spots.map((p) => p.spot as number));
    const range = maxSpot - minSpot;
    // A zero range makes every point simultaneously "near the high" and "near
    // the low" — there is no divergence to call when price hasn't moved.
    if (range > 0) {
      const nearHigh = last.spot >= maxSpot - range * 0.1;
      const nearLow = last.spot <= minSpot + range * 0.1;
      const window = series.length - 1 - backIdx;
      if (nearHigh && diff < back.diff) {
        out.push({
          tone: 'bearish',
          label: 'Divergence',
          text: `Spot is near its session high (${last.spot.toFixed(2)}) but Diff. in OI has fallen over the last ${window} buckets — the OI build is not confirming the move up.`,
        });
      } else if (nearLow && diff > back.diff) {
        out.push({
          tone: 'bullish',
          label: 'Divergence',
          text: `Spot is near its session low (${last.spot.toFixed(2)}) but Diff. in OI has risen over the last ${window} buckets — the OI build is not confirming the move down.`,
        });
      }
    }
  }

  return out;
}

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

function ChartTooltip({ active, payload }: Record<string, unknown>) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const p = (payload[0] as { payload?: Point })?.payload;
  if (!p) return null;
  const diff = p.diff;
  return (
    <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-4 py-3 text-xs shadow-2xl min-w-[230px]">
      <p className="text-zinc-200 font-bold mb-2 tabular-nums">
        {p.timeLabel}
        {p.spot != null && <span className="ml-2 font-medium text-zinc-400">spot {p.spot.toFixed(2)}</span>}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="flex items-center gap-1.5 text-zinc-300">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CALL_HUE }} />Chng. In Call OI
        </span>
        <span className="text-zinc-100 font-bold tabular-nums">{p.callChng != null ? fmtSigned(p.callChng) : '—'}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="flex items-center gap-1.5 text-zinc-300">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: PUT_HUE }} />Chng. In Put OI
        </span>
        <span className="text-zinc-100 font-bold tabular-nums">{p.putChng != null ? fmtSigned(p.putChng) : '—'}</span>
      </div>
      <div className="mt-2 pt-2 border-t border-zinc-800 flex justify-between gap-8">
        <span className="text-zinc-300 font-semibold">Diff. in OI</span>
        <span className="text-zinc-100 font-bold tabular-nums">{diff != null ? fmtSigned(diff) : '—'}</span>
      </div>
      {diff != null && (
        <p className="mt-1 text-[11px] font-semibold text-zinc-300">
          {diff > 0 ? 'Puts ahead — bullish tilt' : diff < 0 ? 'Calls ahead — bearish tilt' : 'Level'}
        </p>
      )}
      <div className="mt-1.5 flex justify-between gap-8 text-[11px]">
        <span className="text-zinc-400">Net PCR</span>
        <span className="text-zinc-200 font-semibold tabular-nums">{p.netPcr != null ? p.netPcr.toFixed(2) : '—'}</span>
      </div>
    </div>
  );
}

/* ── Component ───────────────────────────────────────────────────────────── */

export function TrendingOiChartModal({
  rows, interval, expiry, spot, strikeCount, onClose,
}: TrendingOiChartModalProps) {
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set());
  const closeRef = useRef<HTMLButtonElement>(null);
  // A click's target is the common ancestor of press and release, so a drag that
  // starts on the chart and ends past the panel edge reports the backdrop as its
  // target and closes the modal mid-interaction. Only honour a backdrop click
  // when the press ALSO landed on the backdrop.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the dialog so keyboard users don't keep tabbing the page behind.
  useEffect(() => { closeRef.current?.focus(); }, []);

  // Rows arrive most-recent-first; charts need them oldest-first.
  const points = useMemo<Point[]>(() => (
    [...rows]
      .reverse()
      .map((r) => ({
        ts: toTs(r.date, r.time),
        timeLabel: r.time.slice(0, 5),
        callChng: r.chng_in_call_oi,
        putChng: r.chng_in_put_oi,
        diff: r.diff_in_oi,
        chngDir: r.chng_in_direction,
        spot: r.spot,
        netPcr: r.net_pcr,
        sentiment: r.sentiment,
      }))
      .filter((p) => Number.isFinite(p.ts))
  ), [rows]);

  const insights = useMemo(() => buildInsights(points), [points]);

  const dataDate = rows.length > 0 ? isoDate(rows[0].date) : '';
  const last = points.length > 0 ? points[points.length - 1] : null;

  // Full 09:15–15:30 IST session window so the x-axis doesn't rescale on every poll.
  const [xStart, xEnd] = useMemo(() => {
    if (points.length === 0) return [0, 1];
    const d = dataDate;
    const s = Date.parse(`${d}T09:15:00+05:30`);
    const e = Date.parse(`${d}T15:30:00+05:30`);
    return Number.isFinite(s) && Number.isFinite(e) ? [s, e] : [points[0].ts, points[points.length - 1].ts];
  }, [points, dataDate]);

  const ticks = useMemo(() => {
    const step = 30 * 60_000;
    const out: number[] = [];
    for (let t = Math.ceil(xStart / step) * step; t <= xEnd; t += step) out.push(t);
    return out;
  }, [xStart, xEnd]);

  const xAxisProps = {
    dataKey: 'ts' as const,
    type: 'number' as const,
    scale: 'time' as const,
    domain: [xStart, xEnd] as [number, number],
    ticks,
    tickFormatter: fmtTick,
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine: false,
    axisLine: { stroke: '#27272a' },
  };
  const gridProps = { stroke: '#27272a', vertical: false as const };

  // Numeric x-scales give recharts no band to size bars from, and a 2px surface
  // gap between neighbours is what separates them (no borders).
  const barSize = Math.max(2, Math.min(16, Math.floor(1000 / Math.max(points.length, 1)) - 2));

  const oiTickFormatter = useMemo(() => {
    const vals = points.flatMap((p) => [p.callChng, p.putChng, p.diff])
      .filter((v): v is number => v !== null);
    return axisFormatter(vals.length ? Math.max(...vals.map(Math.abs)) : 0);
  }, [points]);

  const toggle = (k: SeriesKey) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k);
    else if (next.size < SERIES.length - 1) next.add(k); // never hide the last one
    return next;
  });

  const toneStyles: Record<Tone, string> = {
    bullish: 'border-emerald-500/40 bg-emerald-500/10',
    bearish: 'border-rose-500/40 bg-rose-500/10',
    neutral: 'border-zinc-700 bg-zinc-800/50',
  };
  const toneDot: Record<Tone, string> = {
    bullish: 'bg-emerald-400',
    bearish: 'bg-rose-400',
    neutral: 'bg-zinc-500',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Trending OI chart"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedBackdrop.current) onClose();
        pressedBackdrop.current = false;
      }}
    >
      <div className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">

        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-900 px-5 py-4">
          <div>
            <h2 className="text-base font-bold tracking-tight text-white">OI Change Trend</h2>
            <p className="mt-0.5 text-xs text-zinc-400">
              Call &amp; put OI change since the session open, with their difference — all in OI contracts on one scale
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest">
              <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">{interval}m buckets</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">Exp {expiry || '—'}</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">{strikeCount} strike{strikeCount === 1 ? '' : 's'}</span>
              <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">{points.length} bucket{points.length === 1 ? '' : 's'}</span>
              {spot != null && spot > 0 && (
                <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">Spot {spot.toFixed(2)}</span>
              )}
              {dataDate && (
                <span className="rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-zinc-300">DATA: {dataDate}</span>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close chart"
            className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-950 p-1.5 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          {points.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-400">No buckets to chart for this selection.</div>
          ) : (
            <>
              {/* Legend + series toggles. Doubles as the endpoint direct-label:
                  the latest value of each series is spelled out here. */}
              <div className="flex flex-wrap items-center gap-2">
                {SERIES.map((s) => {
                  const off = hidden.has(s.key);
                  const v = last ? last[s.key] : null;
                  const swatch = s.key === 'diff'
                    ? (v ?? 0) >= 0 ? PUT_FILL : CALL_FILL
                    : s.hue;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggle(s.key)}
                      aria-pressed={!off}
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                        off ? 'border-zinc-800 bg-zinc-950 text-zinc-500' : 'border-zinc-700 bg-zinc-950 text-zinc-200 hover:border-zinc-500'
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 ${s.key === 'diff' ? 'rounded-sm' : 'rounded-full'}`}
                        style={{ background: off ? '#3f3f46' : swatch }}
                      />
                      <span className="font-semibold">{s.label}</span>
                      <span className="font-mono tabular-nums text-zinc-400">{v != null ? fmtSigned(v) : '—'}</span>
                    </button>
                  );
                })}
                <span className="ml-auto text-[11px] text-zinc-500">Click a series to hide it · Esc to close</span>
              </div>

              {/* Main overlay: two lines + diverging bars, one shared OI scale. */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis {...xAxisProps} />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                      domain={['auto', 'auto']}
                      tickFormatter={oiTickFormatter}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#52525b', strokeWidth: 1 }} />
                    <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                    {!hidden.has('diff') && (
                      <Bar dataKey="diff" name="Diff. in OI" barSize={barSize} isAnimationActive={false}>
                        {points.map((p) => (
                          <Cell key={p.ts} fill={(p.diff ?? 0) >= 0 ? PUT_FILL : CALL_FILL} />
                        ))}
                      </Bar>
                    )}
                    {!hidden.has('callChng') && (
                      <Line type="monotone" dataKey="callChng" name="Chng. In Call OI" stroke={CALL_HUE}
                        strokeWidth={2} dot={false} connectNulls isAnimationActive={false}
                        activeDot={{ r: 4, fill: CALL_HUE, stroke: '#18181b', strokeWidth: 2 }} />
                    )}
                    {!hidden.has('putChng') && (
                      <Line type="monotone" dataKey="putChng" name="Chng. In Put OI" stroke={PUT_HUE}
                        strokeWidth={2} dot={false} connectNulls isAnimationActive={false}
                        activeDot={{ r: 4, fill: PUT_HUE, stroke: '#18181b', strokeWidth: 2 }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="mt-2 text-[11px] text-zinc-500">
                  Bars are the difference (put change − call change): blue = puts ahead (bullish tilt), red = calls ahead
                  (bearish tilt). Values below zero mean that side&apos;s OI is under its opening level — unwinding, not writing.
                </p>
              </div>

              {/* Spot on its own plot sharing the x-axis — never a second y-scale. */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="mb-2 text-xs font-bold tracking-tight text-white">NIFTY spot</p>
                <ResponsiveContainer width="100%" height={150}>
                  <ComposedChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis {...xAxisProps} />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                      domain={['auto', 'auto']}
                      tickFormatter={(v: number) => v.toFixed(0)}
                    />
                    <Tooltip
                      cursor={{ stroke: '#52525b', strokeWidth: 1 }}
                      contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 10, fontSize: 11 }}
                      labelFormatter={(v) => fmtTick(Number(v))}
                      formatter={(v) => [Number(v).toFixed(2), 'Spot']}
                    />
                    <Line type="monotone" dataKey="spot" name="Spot" stroke={SPOT_HUE} strokeWidth={2}
                      dot={false} connectNulls isAnimationActive={false}
                      activeDot={{ r: 4, fill: SPOT_HUE, stroke: '#18181b', strokeWidth: 2 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Insights */}
              <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
                <p className="text-xs font-bold tracking-tight text-white">What the series is saying</p>
                <p className="mb-3 mt-0.5 text-[11px] text-zinc-400">
                  Computed from the same buckets shown above — descriptive readings, not trade advice.
                </p>
                {insights.length === 0 ? (
                  <p className="text-xs text-zinc-400">Not enough buckets yet to read a trend.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {insights.map((ins) => (
                      <li key={ins.label} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${toneStyles[ins.tone]}`}>
                        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[ins.tone]}`} />
                        <span className="text-xs text-zinc-200">
                          <span className="font-bold text-white">{ins.label}:</span> {ins.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default TrendingOiChartModal;
