'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Brush,
} from 'recharts';
import { cachedFetch } from '@/lib/clientCache';

// ─── Palette ──────────────────────────────────────────────────────
// Categorical pair validated for dark surfaces (OKLCH L in 0.48–0.67,
// protan/deutan/tritan ΔE > 24) — CE blue vs PE amber.
const CE_COLOR   = '#3b82f6';
const PE_COLOR   = '#c47f0a';
const NEUTRAL    = '#0e9d6a';   // third slot: spot / straddle, never adjacent to CE/PE
const AXIS       = '#a1a1aa';
const GRID       = '#27272a';

// Sequential single-hue ramp (dim → bright) for the IV surface heatmap
// (monotone L, ΔL >= 0.06 per step, lowest step still clears the zinc surface at 2.09:1)
const HEAT_RAMP = ['#2f4e78', '#376696', '#3f7eb5', '#4896d4', '#68ace5', '#8fc4f2', '#bad9fc'];

// ─── Types ────────────────────────────────────────────────────────

interface SeriesPoint {
  time: string;  ts: number;  spot: number;
  ceIV: number | null;   peIV: number | null;
  ivAvg: number | null;  ivSpread: number | null;
  ceLTP: number;  peLTP: number;  straddle: number;
  ceOI: number;   peOI: number;
  ceDelta: number; peDelta: number;
  ceVega: number;  ceTheta: number; peTheta: number;
}

interface SkewPoint {
  strike: number;
  ceIVOpen: number | null; peIVOpen: number | null;
  ceIV: number | null;     peIV: number | null;
  ceOI: number;  peOI: number;  straddle: number | null;
}

interface Summary {
  ivOpen: number | null;  ivLast: number | null;
  ivMin: number | null;   ivMax: number | null;
  ceIVLast: number | null; peIVLast: number | null;
  spotOpen: number | null; spotLast: number | null;
  straddleOpen: number | null; straddleLast: number | null;
  lastTime: string; points: number;
}

interface IVResponse {
  success: boolean;
  date: string;  requestedDate: string;  isFallback: boolean;  today: string;
  availableDates: string[];
  atm: number;   expiry: string;
  strikes: number[];  selectedStrike: number;
  series: SeriesPoint[];
  skew: SkewPoint[];
  surface: { times: string[]; strikes: number[]; grid: (number | null)[][] };
  summary: Summary;
  error?: string;
}

type View = 'overview' | 'skew' | 'surface' | 'table';

// ─── Helpers ──────────────────────────────────────────────────────

const fmt = (n: number | null | undefined, dec = 0) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: dec });

const pct = (n: number | null | undefined, dec = 2) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(dec)}%`;

const signed = (n: number | null | undefined, dec = 2, suffix = '') =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(dec)}${suffix}`;

/**
 * Pad a numeric domain so small IV moves fill the plot instead of hugging a 0
 * baseline, then snap the ends to a round step so the ticks read as whole numbers.
 */
function paddedDomain(values: number[]): [number, number] | undefined {
  const clean = values.filter(v => Number.isFinite(v));
  if (clean.length < 2) return undefined;
  const lo = Math.min(...clean), hi = Math.max(...clean);
  const pad  = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.002, 0.01);
  const span = (hi - lo) + 2 * pad;
  const mag  = Math.pow(10, Math.floor(Math.log10(span / 4)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= 5) ?? mag * 10;
  return [Math.floor((lo - pad) / step) * step, Math.ceil((hi + pad) / step) * step];
}

/** Value at a percentile of a sorted-able list — used to clip heatmap outliers. */
function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

// ─── Quant-terminal primitives ─────────────────────────────────────

function PulseStat({
  label, value, sub, color = 'text-white', size = 'text-lg',
}: { label: string; value: string; sub?: string; color?: string; size?: string }) {
  const isHex = color.startsWith('#');
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span
        className={`${size} font-mono font-bold tabular-nums leading-none ${isHex ? '' : color}`}
        style={isHex ? { color } : undefined}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

function ChartHeader({
  eyebrow, title, sub, legend,
}: { eyebrow: string; title: string; sub: string; legend?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5 max-w-xl">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold flex-wrap">{legend}</div>}
    </div>
  );
}

function Section({
  eyebrow, title, sub, legend, glow, children,
}: {
  eyebrow: string; title: string; sub: string; legend?: React.ReactNode;
  glow?: 'blue' | 'emerald' | 'amber'; children: React.ReactNode;
}) {
  const glowColor = glow === 'emerald' ? 'bg-emerald-500/[0.05]'
    : glow === 'amber' ? 'bg-amber-500/[0.05]'
    : glow === 'blue'  ? 'bg-blue-500/[0.05]'
    : '';
  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
      {glow && (
        <div className={`pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[280px] ${glowColor} blur-3xl rounded-full`} />
      )}
      <div className="relative">
        <ChartHeader eyebrow={eyebrow} title={title} sub={sub} legend={legend} />
        {children}
      </div>
    </div>
  );
}

function ToggleChip({
  label, on, color, onClick,
}: { label: string; on: boolean; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${
        on ? 'border-zinc-600 bg-zinc-800 text-white' : 'border-zinc-800 text-zinc-500'
      }`}
    >
      <span className="w-2 h-2 rounded-sm" style={{ background: on ? color : '#52525b' }} />
      {label}
    </button>
  );
}

function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {items.map(i => (
        <span key={i.label} className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-300">
          <span
            className="w-3.5 h-0.5 rounded-full shrink-0"
            style={{
              background: i.dashed
                ? `repeating-linear-gradient(90deg, ${i.color} 0 3px, transparent 3px 6px)`
                : i.color,
            }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}

const chartTooltip = (
  rows: { key: string; label: string; color: string; fmt: (v: number) => string }[],
  labelFmt?: (label: unknown) => string,
) => {
  const Inner = ({ active, payload, label }: Record<string, unknown>) => {
    if (!active || !Array.isArray(payload) || !payload.length) return null;
    const point = (payload[0] as { payload: Record<string, number> }).payload;
    return (
      <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
        <p className="text-zinc-300 mb-2 font-bold tracking-wide font-sans">
          {labelFmt ? labelFmt(label) : String(label)}
        </p>
        {rows.map(r => {
          const v = point[r.key];
          if (v == null || !Number.isFinite(v)) return null;
          return (
            <div key={r.key} className="flex items-center justify-between gap-6 mb-1 last:mb-0">
              <span className="flex items-center gap-1.5 text-zinc-400 font-sans font-semibold">
                <span className="w-2 h-2 rounded-sm" style={{ background: r.color }} />
                {r.label}
              </span>
              <span className="tabular-nums text-white font-bold">{r.fmt(v)}</span>
            </div>
          );
        })}
      </div>
    );
  };
  Inner.displayName = 'ChartTooltip';
  return <Inner />;
};

// ─── Main ─────────────────────────────────────────────────────────

export default function IVChartsPage() {
  const [res, setRes]       = useState<IVResponse | null>(null);
  const [dates, setDates]   = useState<string[]>([]);
  const [date, setDate]     = useState<string>('');
  const [strike, setStrike] = useState<number | null>(null);
  const [view, setView]     = useState<View>('overview');
  const [otmOnly, setOtmOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [updatedAt, setUpdatedAt] = useState<string>('');

  const dateRef   = useRef<string>('');
  const strikeRef = useRef<number | null>(null);
  const initRef   = useRef(false);

  const fetchData = useCallback((opts?: { date?: string; strike?: number | null }) => {
    const d  = opts?.date   ?? dateRef.current;
    const sk = opts?.strike !== undefined ? opts.strike : strikeRef.current;
    const qs = new URLSearchParams({ mode: 'all', fallback: '1' });
    if (d)  qs.set('date', d);
    if (sk != null) qs.set('strike', String(sk));

    cachedFetch<IVResponse>(`/api/options/iv-history?${qs}`, 25_000)
      .then(j => {
        if (!j.success) { setError(j.error ?? 'No data'); setRes(null); return; }
        setRes(j);
        setError('');
        setUpdatedAt(new Date().toLocaleTimeString('en-IN', { hour12: false }));
        setDates(j.availableDates ?? []);
        dateRef.current = j.date;
        setDate(j.date);
        if (!initRef.current) {
          initRef.current = true;
          strikeRef.current = j.selectedStrike;
          setStrike(j.selectedStrike);
        }
      })
      .catch(e => {
        const msg = String(e);
        setError(msg.includes('404') ? 'No IV snapshot files found in debug/' : msg);
        setRes(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const id = setInterval(() => fetchData(), 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const onDate = (d: string) => {
    dateRef.current = d; setDate(d); setLoading(true);
    fetchData({ date: d });
  };
  const onStrike = (sk: number) => {
    strikeRef.current = sk; setStrike(sk);
    fetchData({ strike: sk });
  };

  const series  = useMemo(() => res?.series ?? [], [res]);
  const rawSkew = useMemo(() => res?.skew ?? [], [res]);
  const surface = res?.surface;
  const sum     = res?.summary;
  const atm     = res?.atm ?? 0;

  // OTM-only smile: puts below ATM, calls above. Deep-ITM legs trade off a wide
  // spread, so their implied vol is noise that swamps the scale of the live wing.
  const skew = useMemo(() => {
    if (!otmOnly) return rawSkew;
    return rawSkew.map(p => ({
      ...p,
      ceIV:     p.strike >= atm ? p.ceIV : null,
      ceIVOpen: p.strike >= atm ? p.ceIVOpen : null,
      peIV:     p.strike <= atm ? p.peIV : null,
      peIVOpen: p.strike <= atm ? p.peIVOpen : null,
    }));
  }, [rawSkew, otmOnly, atm]);

  const ceIvDomain = useMemo(() => paddedDomain(
    series.map(p => p.ceIV).filter((v): v is number => v != null),
  ), [series]);
  const peIvDomain = useMemo(() => paddedDomain(
    series.map(p => p.peIV).filter((v): v is number => v != null),
  ), [series]);
  const cePremiumDomain = useMemo(() => paddedDomain(series.map(p => p.ceLTP)), [series]);
  const pePremiumDomain = useMemo(() => paddedDomain(series.map(p => p.peLTP)), [series]);
  const straddleDomain = useMemo(() => paddedDomain(series.map(p => p.straddle)), [series]);
  const skewDomain     = useMemo(() => paddedDomain(
    skew.flatMap(p => [p.ceIV, p.peIV, p.ceIVOpen, p.peIVOpen].filter((v): v is number => v != null)),
  ), [skew]);

  // Median gap between snapshots — the collector's cadence has changed over time,
  // so read it off the data rather than hardcoding it in the caption.
  const sampleSec = useMemo(() => {
    if (series.length < 3) return null;
    const gaps: number[] = [];
    for (let i = 1; i < series.length; i++) gaps.push((series[i].ts - series[i - 1].ts) / 1000);
    gaps.sort((a, b) => a - b);
    return Math.round(gaps[Math.floor(gaps.length / 2)]);
  }, [series]);

  // Tick every ~30 min so labels never collide regardless of session length
  const xTicks = useMemo(() => {
    if (!series.length) return [];
    const step = Math.max(1, Math.ceil(series.length / 12));
    const out = series.filter((_, i) => i % step === 0).map(p => p.time);
    const last = series[series.length - 1].time;
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }, [series]);

  const xAxis = {
    dataKey: 'time' as const,
    tick: { fontSize: 10, fill: AXIS, fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine: false,
    axisLine: { stroke: GRID },
    ticks: xTicks,
    interval: 0 as const,
  };
  const yAxis = {
    tick: { fontSize: 10, fill: AXIS, fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine: false,
    axisLine: false,
    width: 48,
  };
  const grid = { strokeDasharray: '3 6', stroke: GRID, vertical: false };

  const ivChange       = sum?.ivLast != null && sum?.ivOpen != null ? sum.ivLast - sum.ivOpen : null;
  const spotChange     = sum?.spotLast != null && sum?.spotOpen != null ? sum.spotLast - sum.spotOpen : null;
  const straddleChange = sum?.straddleLast != null && sum?.straddleOpen != null
    ? sum.straddleLast - sum.straddleOpen : null;
  const ceSkew = sum?.ceIVLast != null && sum?.peIVLast != null ? sum.ceIVLast - sum.peIVLast : null;

  // ─── Heatmap colour scale ───────────────────────────────────────
  // Clipped to the 3rd–97th percentile: a handful of stale far-strike quotes would
  // otherwise stretch the ramp and flatten every cell into the same middle step.
  const heat = useMemo(() => {
    if (!surface) return null;
    const vals = surface.grid.flat().filter((v): v is number => v != null).sort((a, b) => a - b);
    if (vals.length < 2) return null;
    const lo = quantile(vals, 0.03), hi = quantile(vals, 0.97);
    const color = (v: number | null) => {
      if (v == null) return '#18181b';
      const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)));
      return HEAT_RAMP[Math.round(t * (HEAT_RAMP.length - 1))];
    };
    return { lo, hi, color };
  }, [surface]);

  const hasData = !loading && !error && series.length > 0;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-6 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/25 shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-blue-400">
                <path d="M2 14c2.5 0 2.5-6 5-6s2.5 9 5 9 2.5-11 5-11 2.5 8 5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="text-[9px] font-bold text-blue-500 uppercase tracking-[0.18em] mb-0.5">
                Options · NIFTY
              </p>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none">Implied Volatility Terminal</h1>
              <p className="text-[10px] text-zinc-500 font-medium mt-1">
                Intraday IV, term structure, smile and surface across the strike chain
              </p>
            </div>
          </div>

          {updatedAt && (
            <span className="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-500">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Updated {updatedAt}
            </span>
          )}
        </div>

        {/* Stays up for any past session, not just the first fallback response —
            otherwise the warning vanishes on the next 30 s poll. */}
        {res && res.date !== res.today && (
          <p className="mt-2 text-[11px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-1.5 inline-block">
            {dates.includes(res.today)
              ? `Viewing a past session (${res.date}) — pick ${res.today} for today.`
              : <>No snapshots recorded for {res.today} — showing the most recent session ({res.date}).
                  Start <span className="font-mono">scripts/tools/iv_snapshot_collector.py</span> to record today.</>}
          </p>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">

        {loading && (
          <div className="flex items-center justify-center h-64 gap-3">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-blue-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-300 font-medium">Loading IV data…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <p className="text-sm text-zinc-400 font-medium text-center max-w-md">{error}</p>
            <p className="text-xs text-zinc-500 font-mono">
              python scripts/tools/iv_snapshot_collector.py (after activating the venv)
            </p>
          </div>
        )}

        {hasData && (
          <>
            {/* ── Market pulse ribbon ───────────────────────────── */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-blue-500/[0.06] via-transparent to-emerald-500/[0.04]" />

              <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
                <PulseStat
                  label="ATM avg IV"
                  value={pct(sum?.ivLast)}
                  sub={`open ${pct(sum?.ivOpen)}`}
                  size="text-2xl"
                />
                <div className="w-px bg-zinc-800 self-stretch" />
                <PulseStat
                  label="IV change"
                  value={signed(ivChange, 2, ' pts')}
                  sub={`range ${pct(sum?.ivMin)} – ${pct(sum?.ivMax)}`}
                  color={ivChange == null ? 'text-zinc-400' : ivChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}
                  size="text-2xl"
                />
                <div className="w-px bg-zinc-800 self-stretch" />
                <PulseStat label="CE IV" value={pct(sum?.ceIVLast)} color={CE_COLOR}
                  sub={`strike ${fmt(strike ?? 0)}`} size="text-2xl" />
                <PulseStat label="PE IV" value={pct(sum?.peIVLast)} color={PE_COLOR}
                  sub={`CE−PE ${signed(ceSkew)}`} size="text-2xl" />

                <div className="ml-auto flex items-center gap-5 flex-wrap">
                  <PulseStat
                    label="Straddle"
                    value={`₹${fmt(sum?.straddleLast, 1)}`}
                    sub={`${signed(straddleChange, 1)} from open`}
                    color={straddleChange == null ? 'text-zinc-400' : straddleChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}
                    size="text-sm"
                  />
                  <PulseStat
                    label="Spot"
                    value={fmt(sum?.spotLast, 1)}
                    sub={`${signed(spotChange, 1)} from open`}
                    color={spotChange == null ? 'text-zinc-400' : spotChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}
                    size="text-sm"
                  />
                  <PulseStat label="Expiry" value={res?.expiry || '—'} size="text-sm" color="text-zinc-300" />
                </div>
              </div>

              {/* Control strip */}
              <div className="relative flex items-center justify-between gap-3 px-5 py-2 border-t border-zinc-800/80 bg-zinc-950/40 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30">
                    DATA
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
                    {date || '—'}{sum?.points ? ` · ${sum.points} snapshots · last ${sum.lastTime}` : ''}
                  </span>

                  {dates.length > 0 && (
                    <label className="flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Date</span>
                      <select
                        value={date}
                        onChange={e => onDate(e.target.value)}
                        className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
                      >
                        {dates.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </label>
                  )}

                  {(res?.strikes.length ?? 0) > 0 && (
                    <label className="flex items-center gap-1.5">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strike</span>
                      <select
                        value={strike ?? ''}
                        onChange={e => onStrike(Number(e.target.value))}
                        className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-blue-500 w-36 tabular-nums"
                      >
                        {res!.strikes.map(sk => (
                          <option key={sk} value={sk}>{fmt(sk)}{sk === atm ? '  · ATM' : ''}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
                  {(['overview', 'skew', 'surface', 'table'] as View[]).map(v => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-md capitalize transition-colors ${
                        view === v
                          ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                          : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Overview ──────────────────────────────────────── */}
            {view === 'overview' && (
              <>
                {/* Call and put IV as separate panels — each on its own scale, so a
                    tight one-sided move isn't flattened by the other leg's range. */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Section
                    eyebrow="Term Structure"
                    title={`Call IV · ${fmt(strike ?? 0)}${strike === atm ? ' ATM' : ''}`}
                    sub={`${sampleSec ?? 30}s snapshots · IV (left) vs CE premium (right) · drag the handles below the axis to zoom`}
                    glow="blue"
                    legend={<Legend items={[
                      { label: 'CE IV', color: CE_COLOR }, { label: 'CE Premium', color: NEUTRAL, dashed: true },
                    ]} />}
                  >
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={series} margin={{ top: 8, right: 20, left: 0, bottom: 0 }} syncId="ivsync">
                        <CartesianGrid {...grid} />
                        <XAxis {...xAxis} />
                        <YAxis {...yAxis} yAxisId="iv" domain={ceIvDomain ?? ['auto', 'auto']}
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                        <YAxis {...yAxis} yAxisId="premium" orientation="right"
                          domain={cePremiumDomain ?? ['auto', 'auto']}
                          tickFormatter={(v: number) => `₹${v.toFixed(0)}`} />
                        <Tooltip
                          content={chartTooltip([
                            { key: 'ceIV', label: 'CE IV', color: CE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                            { key: 'ceLTP', label: 'CE Premium', color: NEUTRAL, fmt: v => `₹${v.toFixed(1)}` },
                            { key: 'spot', label: 'Spot', color: AXIS, fmt: v => v.toFixed(1) },
                          ])}
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Line yAxisId="iv" type="monotone" dataKey="ceIV" name="CE IV" stroke={CE_COLOR}
                          strokeWidth={2} dot={false} connectNulls
                          activeDot={{ r: 4, fill: CE_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
                        <Line yAxisId="premium" type="monotone" dataKey="ceLTP" name="CE Premium" stroke={NEUTRAL}
                          strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls
                          activeDot={{ r: 3, fill: NEUTRAL, stroke: '#18181b', strokeWidth: 2 }} />
                        <Brush dataKey="time" height={22} travellerWidth={8}
                          stroke="#52525b" fill="#09090b"
                          tickFormatter={(t: string) => t} />
                      </LineChart>
                    </ResponsiveContainer>
                  </Section>

                  <Section
                    eyebrow="Term Structure"
                    title={`Put IV · ${fmt(strike ?? 0)}${strike === atm ? ' ATM' : ''}`}
                    sub={`${sampleSec ?? 30}s snapshots · IV (left) vs PE premium (right) · drag the handles below the axis to zoom`}
                    glow="amber"
                    legend={<Legend items={[
                      { label: 'PE IV', color: PE_COLOR }, { label: 'PE Premium', color: NEUTRAL, dashed: true },
                    ]} />}
                  >
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={series} margin={{ top: 8, right: 20, left: 0, bottom: 0 }} syncId="ivsync">
                        <CartesianGrid {...grid} />
                        <XAxis {...xAxis} />
                        <YAxis {...yAxis} yAxisId="iv" domain={peIvDomain ?? ['auto', 'auto']}
                          tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                        <YAxis {...yAxis} yAxisId="premium" orientation="right"
                          domain={pePremiumDomain ?? ['auto', 'auto']}
                          tickFormatter={(v: number) => `₹${v.toFixed(0)}`} />
                        <Tooltip
                          content={chartTooltip([
                            { key: 'peIV', label: 'PE IV', color: PE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                            { key: 'peLTP', label: 'PE Premium', color: NEUTRAL, fmt: v => `₹${v.toFixed(1)}` },
                            { key: 'spot', label: 'Spot', color: AXIS, fmt: v => v.toFixed(1) },
                          ])}
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Line yAxisId="iv" type="monotone" dataKey="peIV" name="PE IV" stroke={PE_COLOR}
                          strokeWidth={2} dot={false} connectNulls
                          activeDot={{ r: 4, fill: PE_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
                        <Line yAxisId="premium" type="monotone" dataKey="peLTP" name="PE Premium" stroke={NEUTRAL}
                          strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls
                          activeDot={{ r: 3, fill: NEUTRAL, stroke: '#18181b', strokeWidth: 2 }} />
                        <Brush dataKey="time" height={22} travellerWidth={8}
                          stroke="#52525b" fill="#09090b"
                          tickFormatter={(t: string) => t} />
                      </LineChart>
                    </ResponsiveContainer>
                  </Section>
                </div>

                {/* Small multiples share the x-axis instead of stacking a second y-scale */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Section eyebrow="Skew" title="IV spread · CE − PE" sub="positive = calls carry richer volatility than puts" glow="blue">
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={series} margin={{ top: 8, right: 20, left: 0, bottom: 0 }} syncId="ivsync">
                        <defs>
                          <linearGradient id="skewFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={CE_COLOR} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={CE_COLOR} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid {...grid} />
                        <XAxis {...xAxis} />
                        <YAxis {...yAxis} domain={['auto', 'auto']}
                          tickFormatter={(v: number) => v.toFixed(1)} />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
                        <Tooltip
                          content={chartTooltip([
                            { key: 'ivSpread', label: 'CE−PE', color: CE_COLOR, fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(2)} pts` },
                          ])}
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Area type="monotone" dataKey="ivSpread" stroke={CE_COLOR} strokeWidth={2}
                          fill="url(#skewFill)" dot={false} connectNulls />
                      </AreaChart>
                    </ResponsiveContainer>
                  </Section>

                  <Section eyebrow="Premium" title="Straddle premium" sub={`CE + PE last price at ${fmt(strike ?? 0)}`} glow="emerald">
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={series} margin={{ top: 8, right: 20, left: 0, bottom: 0 }} syncId="ivsync">
                        <CartesianGrid {...grid} />
                        <XAxis {...xAxis} />
                        <YAxis {...yAxis} domain={straddleDomain ?? ['auto', 'auto']}
                          tickFormatter={(v: number) => v.toFixed(0)} />
                        <Tooltip
                          content={chartTooltip([
                            { key: 'straddle', label: 'Straddle', color: NEUTRAL, fmt: v => `₹${v.toFixed(1)}` },
                            { key: 'ceLTP', label: 'CE', color: CE_COLOR, fmt: v => `₹${v.toFixed(1)}` },
                            { key: 'peLTP', label: 'PE', color: PE_COLOR, fmt: v => `₹${v.toFixed(1)}` },
                          ])}
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                        />
                        <Line type="monotone" dataKey="straddle" stroke={NEUTRAL} strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </Section>
                </div>
              </>
            )}

            {/* ── Skew (smile) ──────────────────────────────────── */}
            {view === 'skew' && (
              <Section
                eyebrow="Curvature"
                title="Volatility smile across strikes"
                sub={`solid = latest (${sum?.lastTime ?? ''}) · dashed = first snapshot of the day`}
                glow="blue"
                legend={<>
                  <ToggleChip label="OTM only" on={otmOnly} color={CE_COLOR} onClick={() => setOtmOnly(v => !v)} />
                  <Legend items={[
                    { label: 'CE now', color: CE_COLOR },
                    { label: 'CE open', color: CE_COLOR, dashed: true },
                    { label: 'PE now', color: PE_COLOR },
                    { label: 'PE open', color: PE_COLOR, dashed: true },
                  ]} />
                </>}
              >
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={skew} margin={{ top: 20, right: 24, left: 0, bottom: 4 }}>
                    <CartesianGrid {...grid} />
                    <XAxis
                      dataKey="strike" type="number" domain={['dataMin', 'dataMax']}
                      tick={{ fontSize: 10, fill: AXIS, fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                      tickLine={false} axisLine={{ stroke: GRID }}
                      ticks={skew.map(s => s.strike)}
                      tickFormatter={(v: number) => fmt(v)}
                      angle={-35} textAnchor="end" height={46}
                    />
                    <YAxis {...yAxis} domain={skewDomain ?? ['auto', 'auto']}
                      tickFormatter={(v: number) => `${v.toFixed(1)}%`} />
                    {atm > 0 && (
                      <ReferenceLine x={atm} stroke="#71717a" strokeDasharray="4 3"
                        label={{ value: 'ATM', fill: AXIS, fontSize: 10, position: 'top' }} />
                    )}
                    <Tooltip
                      content={chartTooltip([
                        { key: 'ceIV', label: 'CE now', color: CE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                        { key: 'ceIVOpen', label: 'CE open', color: CE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                        { key: 'peIV', label: 'PE now', color: PE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                        { key: 'peIVOpen', label: 'PE open', color: PE_COLOR, fmt: v => `${v.toFixed(2)}%` },
                        { key: 'straddle', label: 'Straddle', color: NEUTRAL, fmt: v => `₹${v.toFixed(1)}` },
                      ], v => `Strike ${fmt(Number(v))}`)}
                      cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                    />
                    <Line type="monotone" dataKey="ceIVOpen" stroke={CE_COLOR} strokeWidth={1.5}
                      strokeDasharray="4 3" dot={false} connectNulls opacity={0.55} />
                    <Line type="monotone" dataKey="peIVOpen" stroke={PE_COLOR} strokeWidth={1.5}
                      strokeDasharray="4 3" dot={false} connectNulls opacity={0.55} />
                    <Line type="monotone" dataKey="ceIV" stroke={CE_COLOR} strokeWidth={2}
                      dot={{ r: 3, fill: CE_COLOR, stroke: '#18181b', strokeWidth: 1.5 }} connectNulls
                      activeDot={{ r: 5, fill: CE_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
                    <Line type="monotone" dataKey="peIV" stroke={PE_COLOR} strokeWidth={2}
                      dot={{ r: 3, fill: PE_COLOR, stroke: '#18181b', strokeWidth: 1.5 }} connectNulls
                      activeDot={{ r: 5, fill: PE_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-[10px] text-zinc-500 mt-2">
                  {otmOnly
                    ? 'Showing the out-of-the-money leg on each side of ATM — toggle off to include ITM quotes.'
                    : 'Including ITM legs — their wide spreads produce inflated, noisy implied vol.'}
                  {' '}Pick a strike in the control strip above to load its intraday series.
                </p>
              </Section>
            )}

            {/* ── Surface heatmap ───────────────────────────────── */}
            {view === 'surface' && surface && heat && (
              <Section
                eyebrow="Surface"
                title="IV surface · strike × time"
                sub="cell = out-of-the-money leg's implied volatility at that strike and minute · scale clipped to the 3rd–97th percentile"
                glow="amber"
                legend={
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold text-zinc-400 tabular-nums">{heat.lo.toFixed(1)}%</span>
                    <span className="flex h-3 w-28 rounded-sm overflow-hidden border border-zinc-700">
                      {HEAT_RAMP.map(c => <span key={c} className="flex-1" style={{ background: c }} />)}
                    </span>
                    <span className="text-[10px] font-semibold text-zinc-400 tabular-nums">{heat.hi.toFixed(1)}%</span>
                  </div>
                }
              >
                <div className="overflow-x-auto">
                  <div className="min-w-[720px]">
                    {surface.strikes.map((sk, r) => (
                      <div key={sk} className="flex items-center gap-1.5 mb-[2px]">
                        <span className={`w-16 shrink-0 text-right text-[10px] tabular-nums font-semibold ${
                          sk === atm ? 'text-white' : 'text-zinc-400'
                        }`}>
                          {fmt(sk)}
                        </span>
                        <div className="flex gap-[1px] flex-1">
                          {surface.grid[r].map((v, c) => (
                            <div
                              key={c}
                              className="flex-1 h-4 rounded-[2px]"
                              style={{ background: heat.color(v) }}
                              title={`${fmt(sk)} @ ${surface.times[c]} — ${v == null ? 'no data' : `${v.toFixed(2)}%`}`}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className="w-16 shrink-0" />
                      <div className="flex flex-1 justify-between text-[10px] text-zinc-500 font-semibold tabular-nums">
                        {surface.times
                          .filter((_, i) => i % Math.max(1, Math.ceil(surface.times.length / 8)) === 0)
                          .map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
              </Section>
            )}

            {/* ── Table view (accessibility + exact values) ──────── */}
            {view === 'table' && (
              <Section eyebrow="Raw Data" title={`Snapshots · ${fmt(strike ?? 0)}`} sub={`${series.length} rows · newest first`}>
                <div className="overflow-auto max-h-[70vh] rounded-lg border border-zinc-800">
                  <table className="w-full text-xs tabular-nums font-mono">
                    <thead className="sticky top-0">
                      <tr className="bg-zinc-800">
                        {['Time', 'Spot', 'CE IV', 'PE IV', 'CE−PE', 'CE LTP', 'PE LTP', 'Straddle', 'CE OI', 'PE OI']
                          .map(h => (
                            <th key={h} className="text-xs font-bold text-white px-3 py-2 text-right first:text-left whitespace-nowrap font-sans">
                              {h}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...series].reverse().map((p, i) => (
                        <tr key={p.ts} className={i % 2 ? 'bg-zinc-900' : 'bg-zinc-950'}>
                          <td className="px-3 py-1.5 text-zinc-300 font-semibold font-sans">{p.time}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-300">{fmt(p.spot, 2)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-100">{pct(p.ceIV)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-100">{pct(p.peIV)}</td>
                          <td className={`px-3 py-1.5 text-right ${
                            p.ivSpread == null ? 'text-zinc-500' : p.ivSpread >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}>{signed(p.ivSpread)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-300">{fmt(p.ceLTP, 2)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-300">{fmt(p.peLTP, 2)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-200 font-semibold">{fmt(p.straddle, 2)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-400">{fmt(p.ceOI)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-400">{fmt(p.peOI)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
