'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { getCached, setCached } from '@/lib/clientCache';
import StraddleValidityReportModal from '@/components/StraddleValidityReportModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DteStats {
  count: number; avg: number; median: number; std: number;
  min: number; max: number; p10: number; p25: number; p75: number; p90: number;
  seller_win_pct: number; avg_decay_pct: number; avg_range: number; avg_range_pct: number;
}

interface Distribution {
  bins: number[]; counts: number[];
  mean: number; std: number; median: number;
  skew: number; kurtosis: number;
  min: number; max: number;
  p10: number; p25: number; p75: number; p90: number;
}

interface DecayPoint { dte: number | string; label: string; avg: number; p25: number; p75: number; count: number; }
interface IntradayPoint { time: string; avg: number; p25: number; p75: number; }
interface MonthlyPoint { month: string; avg: number; count: number; }
interface RangeEntry { avg_range: number; avg_range_pct: number; seller_win_pct?: number; }

interface StatusData { status: 'idle' | 'running' | 'done' | 'error'; pct: number; message: string; }

// AnalysisData covers one regime's stats; FullData is the top-level JSON shape
type AnalysisData = {
  date_range: { from: string; to: string };
  total_days: number;
  total_expiries: number;
  summary: {
    overall_avg: number; overall_median: number;
    overall_min: number; overall_max: number;
    avg_daily_decay_pct: number; seller_win_pct: number;
  };
  by_weekday: Record<string, DteStats>;
  by_dte: Record<string, DteStats>;
  distribution: Distribution;
  decay_dte_curve: DecayPoint[];
  intraday_decay: Record<string, IntradayPoint[]>;
  monthly_trend: MonthlyPoint[];
  range_analysis: { by_dte: Record<string, RangeEntry>; by_weekday: Record<string, RangeEntry>; };
  insights: string[];
};

interface FullData {
  generated_at: string;
  regime_cutoff: string;
  regimes: { all: AnalysisData; pre_sep2025: AnalysisData; post_sep2025: AnalysisData; };
}

type RegimeKey = 'all' | 'pre_sep2025' | 'post_sep2025';

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DTE_LABELS = ['0', '1', '2', '3', '4', '5+'];

const WEEKDAY_COLORS: Record<string, string> = {
  Monday: '#38bdf8', Tuesday: '#a78bfa', Wednesday: '#34d399',
  Thursday: '#fbbf24', Friday: '#f87171',
};
const DTE_COLORS = ['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#22d3ee', '#818cf8'];

const CHART_COLORS = {
  primary:  '#38bdf8',
  emerald:  '#34d399',
  rose:     '#f87171',
  amber:    '#fbbf24',
  violet:   '#a78bfa',
  grid:     '#20202399',
  muted:    '#71717a',
};

const monoTick = { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' };
const gridProps = { strokeDasharray: '3 6', stroke: CHART_COLORS.grid, vertical: false as const };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPremium = (n: number | undefined) =>
  n != null ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}` : '—';

const fmtPct = (n: number | undefined) =>
  n != null ? `${n.toFixed(1)}%` : '—';

const fmtCount = (n: number | undefined) =>
  n != null ? n.toLocaleString('en-IN') : '—';

function dataDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

// ─── Pulse stat (mono hero figure) ─────────────────────────────────────────────

function PulseStat({
  label, value, sub, color = 'text-white', size = 'text-2xl',
}: { label: string; value: string; sub?: string; color?: string; size?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`${size} font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

// ─── Info button ─────────────────────────────────────────────────────────────

function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="w-4 h-4 rounded-full bg-zinc-800 hover:bg-zinc-600 text-zinc-400 hover:text-white text-[10px] font-bold leading-none flex items-center justify-center transition-colors flex-shrink-0 border border-zinc-700"
        aria-label="More information"
      >
        i
      </button>
      {open && (
        <div
          className="absolute left-6 top-0 z-50 w-80 bg-zinc-950/98 border border-zinc-700/70 rounded-xl shadow-2xl p-4 text-xs backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between mb-3">
            <span className="font-bold text-white text-sm leading-tight pr-2">{title}</span>
            <button
              onClick={() => setOpen(false)}
              className="text-zinc-500 hover:text-white flex-shrink-0 leading-none mt-0.5"
              aria-label="Close"
            >✕</button>
          </div>
          <div className="text-zinc-300 leading-relaxed space-y-2">{children}</div>
        </div>
      )}
    </div>
  );
}

// ─── Chart header (eyebrow / title / sub / legend) ─────────────────────────────

function ChartHeader({
  eyebrow, title, sub, legend, info,
}: { eyebrow: string; title: string; sub: string; legend?: React.ReactNode; info?: { title: string; content: React.ReactNode } }) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em]">{eyebrow}</p>
          {info && <InfoButton title={info.title}>{info.content}</InfoButton>}
        </div>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5 max-w-xl">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold flex-wrap">{legend}</div>}
    </div>
  );
}

// ─── Section wrapper (quant-terminal card) ─────────────────────────────────────

function Section({
  eyebrow, title, sub, children, note, info, glow,
}: {
  eyebrow: string; title: string; sub: string; children: React.ReactNode; note?: string;
  info?: { title: string; content: React.ReactNode }; glow?: 'emerald' | 'blue' | 'amber';
}) {
  const glowColor = glow === 'emerald' ? 'bg-emerald-500/[0.05]' : glow === 'amber' ? 'bg-amber-500/[0.05]' : 'bg-sky-500/[0.05]';
  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
      {glow && (
        <div className={`pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[280px] ${glowColor} blur-3xl rounded-full`} />
      )}
      <div className="relative">
        <ChartHeader eyebrow={eyebrow} title={title} sub={sub} info={info}
          legend={note ? <span className="text-[10px] text-zinc-500 font-mono">{note}</span> : undefined} />
        {children}
      </div>
    </div>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, formatter }: {
  active?: boolean; payload?: { name: string; value: number; color: string; stroke?: string }[];
  label?: string; formatter?: (v: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  // Filter out internal band-fill series (prefixed with _)
  const visible = payload.filter((p) => !p.name.startsWith('_'));
  if (!visible.length) return null;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
      {label && <div className="text-zinc-300 font-semibold mb-2 font-sans">{label}</div>}
      {visible.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-6 mb-1 last:mb-0">
          <span className="flex items-center gap-1.5 text-zinc-400 font-sans">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.stroke ?? p.color }} />
            {p.name}
          </span>
          <span className="text-white font-bold tabular-nums">
            {formatter ? formatter(p.value, p.name) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Stats table helper ───────────────────────────────────────────────────────

function StatsTable({
  rows, columns,
}: {
  rows: { key: string; label: string; color?: string }[];
  columns: { header: string; accessor: (key: string) => string; className?: string }[];
}) {
  return (
    <div className="overflow-x-auto mt-4 rounded-lg border border-zinc-800">
      <table className="w-full text-xs border-collapse font-mono">
        <thead>
          <tr className="bg-zinc-950">
            <th className="text-left px-3 py-2 text-xs font-bold text-white whitespace-nowrap font-sans">Segment</th>
            {columns.map((c) => (
              <th key={c.header} className={`px-3 py-2 text-[10px] font-bold text-zinc-400 uppercase tracking-wide whitespace-nowrap text-right ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={`${i % 2 === 0 ? 'bg-zinc-900/40' : 'bg-transparent'} border-t border-zinc-800/60`}>
              <td className="px-3 py-2 whitespace-nowrap font-sans">
                <div className="flex items-center gap-2">
                  {r.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />}
                  <span className="text-zinc-200 font-semibold">{r.label}</span>
                </div>
              </td>
              {columns.map((c) => (
                <td key={c.header} className={`px-3 py-2 text-right tabular-nums text-zinc-300 whitespace-nowrap ${c.className ?? ''}`}>
                  {c.accessor(r.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function StraddleAnalysis() {
  const [fullData, setFullData]   = useState<FullData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'not_generated' | 'error'>('loading');
  const [regenerating, setRegenerating] = useState(false);
  const [regenProgress, setRegenProgress] = useState(0);
  const [regenMessage, setRegenMessage] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | '3y' | '2y' | '1y'>('all');
  const [regime, setRegime] = useState<RegimeKey>('all');
  const [showReportModal, setShowReportModal] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive the active regime's data
  const data: AnalysisData | null = fullData ? fullData.regimes[regime] : null;

  const fetchData = useCallback(async () => {
    // Paint instantly from the session cache, then revalidate in background
    const cached = getCached<FullData>('/api/straddle-analysis');
    if (cached) {
      setFullData(cached);
      setLoadState('loaded');
    }
    try {
      const res = await fetch('/api/straddle-analysis');
      if (res.status === 404) {
        setLoadState('not_generated');
        // Check if generation is running in background
        const sRes = await fetch('/api/straddle-analysis/status');
        if (sRes.ok) {
          const s: StatusData = await sRes.json();
          if (s.status === 'running') {
            setRegenerating(true);
            setRegenProgress(s.pct ?? 0);
            setRegenMessage(s.message ?? '');
          }
        }
        return;
      }
      if (!res.ok) { if (!cached) setLoadState('error'); return; }
      const json = await res.json();
      if (json.error) { setLoadState('not_generated'); return; }
      setCached('/api/straddle-analysis', json);
      setFullData(json);
      setLoadState('loaded');
    } catch {
      if (!cached) setLoadState('error');
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/straddle-analysis/status');
        if (!res.ok) return;
        const s: StatusData = await res.json();
        setRegenProgress(s.pct ?? 0);
        setRegenMessage(s.message ?? '');
        if (s.status === 'done') {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setRegenerating(false);
          await fetchData();
        } else if (s.status === 'error') {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setRegenerating(false);
          setRegenMessage(`Error: ${s.message}`);
        }
      } catch { /* keep polling */ }
    }, 2000);
  }, [fetchData]);

  useEffect(() => {
    fetchData();
    // Check initial status to see if background job is already running
    fetch('/api/straddle-analysis/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: StatusData | null) => {
        if (s?.status === 'running') {
          setRegenerating(true);
          setRegenProgress(s.pct ?? 0);
          setRegenMessage(s.message ?? '');
          startPolling();
        }
      })
      .catch(() => {});

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [fetchData, startPolling]);

  const startRegen = async () => {
    setRegenerating(true);
    setRegenProgress(0);
    setRegenMessage('Starting…');
    try {
      await fetch('/api/straddle-analysis', { method: 'POST', body: JSON.stringify({ action: 'regenerate' }) });
    } catch { /* ignore */ }
    startPolling();
  };

  // Filter monthly trend by date filter
  const filteredMonthly = (() => {
    if (!data) return [];
    if (dateFilter === 'all') return data.monthly_trend;
    const years = dateFilter === '1y' ? 1 : dateFilter === '2y' ? 2 : 3;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffStr = cutoff.toISOString().slice(0, 7);
    return data.monthly_trend.filter((m) => m.month >= cutoffStr);
  })();

  // ── Loading / empty states ────────────────────────────────────────────────
  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading straddle analysis…</p>
      </div>
    );
  }

  if (loadState === 'not_generated') {
    return (
      <div className="min-h-screen bg-zinc-950">
        <div className="max-w-lg mx-auto mt-24 text-center px-4">
          <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-8 overflow-hidden">
            <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[420px] h-[240px] bg-sky-500/[0.06] blur-3xl rounded-full" />
            <div className="relative">
              <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-3">Dataset</p>
              <h2 className="text-white text-lg font-bold mb-2 font-mono">Analysis Not Generated</h2>
              <p className="text-zinc-400 text-sm mb-6">
                Run the analysis script once to build the straddle premium dataset from{' '}
                <span className="text-zinc-300 font-mono">nifty_options.db</span>.
                This takes approximately 60–90 seconds.
              </p>
              {regenerating ? (
                <div className="space-y-2">
                  <div className="w-full bg-zinc-800 rounded-full h-1.5">
                    <div
                      className="bg-emerald-400 h-1.5 rounded-full transition-all duration-500"
                      style={{ width: `${regenProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-400 font-mono">{regenMessage}</p>
                </div>
              ) : (
                <button
                  onClick={startRegen}
                  className="px-6 py-2 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-sm font-bold rounded-lg transition-colors"
                >
                  Run Analysis
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !fullData || !data) {
    return (
      <div className="min-h-screen bg-zinc-950">
        <div className="flex items-center justify-center h-64 text-rose-400 text-sm">
          Failed to load analysis data.
        </div>
      </div>
    );
  }

  // ── Derived chart data ────────────────────────────────────────────────────
  const weekdayChartData = WEEKDAYS
    .filter((d) => data.by_weekday[d])
    .map((d) => ({ name: d.slice(0, 3), fullName: d, ...data.by_weekday[d] }));

  const dteChartData = DTE_LABELS
    .filter((l) => data.by_dte[l])
    .map((l) => ({ name: `${l} DTE`, label: l, ...data.by_dte[l] }));

  const histData = data.distribution.bins.slice(0, -1).map((b, i) => ({
    bin: Math.round(b),
    binLabel: `₹${Math.round(b)}–₹${Math.round(data.distribution.bins[i + 1])}`,
    count: data.distribution.counts[i],
  }));

  // Normal curve overlay
  const { mean: dMean, std: dStd } = data.distribution;
  const totalCount = data.distribution.counts.reduce((a, b) => a + b, 0);
  const binWidth = data.distribution.bins[1] - data.distribution.bins[0];
  const normalData = histData.map((h) => {
    const x = h.bin + binWidth / 2;
    const normal = (1 / (dStd * Math.sqrt(2 * Math.PI))) *
      Math.exp(-0.5 * ((x - dMean) / dStd) ** 2) * totalCount * binWidth;
    return { ...h, normal: Math.round(normal) };
  });

  // Intraday decay — subsample every 5 minutes for readability
  const intradaySubsample = (pts: IntradayPoint[]) =>
    pts.filter((_, i) => i % 5 === 0 || pts[i]?.time === '09:15' || pts[i]?.time === '15:29');

  const dteCurveData = [...data.decay_dte_curve].sort((a, b) => {
    const va = a.dte === '5+' ? 6 : Number(a.dte);
    const vb = b.dte === '5+' ? 6 : Number(b.dte);
    return vb - va;
  });

  const rangeByDte = DTE_LABELS
    .filter((l) => data.range_analysis.by_dte[l])
    .map((l) => ({ name: `${l} DTE`, label: l, ...data.range_analysis.by_dte[l] }));

  const rangeByWd = WEEKDAYS
    .filter((d) => data.range_analysis.by_weekday[d])
    .map((d) => ({ name: d.slice(0, 3), fullName: d, ...data.range_analysis.by_weekday[d] }));

  const regimeLabel = regime === 'all' ? 'Full history' : regime === 'pre_sep2025' ? 'Pre Sep 2025 · Thu expiry' : 'Post Sep 2025 · Tue expiry';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3">
        <div className="mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-white mr-2 tracking-tight">Straddle Premium Analysis</h1>
          <span className="text-[10px] font-mono font-bold bg-zinc-900 text-zinc-400 border border-zinc-800 px-2 py-0.5 rounded">
            NIFTY · ATM
          </span>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded">
            DATA: {dataDate(fullData.generated_at)}
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">
            {data.date_range.from} → {data.date_range.to}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Regime toggle */}
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[10px]">
              {([
                { key: 'all',          label: 'All',            title: 'Full history' },
                { key: 'pre_sep2025',  label: 'Pre Sep\'25',    title: 'Before 2025-09-01 · Thu weekly expiry' },
                { key: 'post_sep2025', label: 'Post Sep\'25',   title: 'From 2025-09-01 · Tue weekly expiry' },
              ] as { key: RegimeKey; label: string; title: string }[]).map(({ key, label, title }) => (
                <button
                  key={key}
                  onClick={() => setRegime(key)}
                  title={title}
                  className={`px-2.5 py-1 font-mono font-bold rounded-md transition-colors whitespace-nowrap ${
                    regime === key
                      ? key === 'pre_sep2025'
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                        : key === 'post_sep2025'
                          ? 'bg-violet-500/15 text-violet-400 border border-violet-500/25'
                          : 'bg-sky-500/15 text-sky-400 border border-sky-500/25'
                      : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Date filter */}
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[10px]">
              {(['all', '3y', '2y', '1y'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setDateFilter(f)}
                  className={`px-2.5 py-1 font-mono font-bold rounded-md transition-colors ${
                    dateFilter === f
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                      : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                  }`}
                >
                  {f === 'all' ? 'All' : f.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Analyse Report Button */}
            <button
              onClick={() => setShowReportModal(true)}
              className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono font-bold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 rounded-lg transition-colors shadow-sm"
              title="Open validity audit & intelligence report"
            >
              <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Analyse Report
            </button>

            {/* Regenerate */}
            {regenerating ? (
              <div className="flex items-center gap-2 min-w-48">
                <div className="flex-1 bg-zinc-800 rounded-full h-1.5">
                  <div
                    className="bg-emerald-400 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${regenProgress}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-400 font-mono whitespace-nowrap">{regenProgress}%</span>
              </div>
            ) : (
              <button
                onClick={startRegen}
                className="px-3 py-1 text-[10px] font-mono font-bold bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg transition-colors"
              >
                Regenerate
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto px-4 py-6 space-y-4 max-w-[1600px]">

        {/* ── Regime banner ─────────────────────────────────────────────────── */}
        {regime !== 'all' && (
          <div className={`rounded-xl px-4 py-2.5 text-xs flex items-center gap-2 border font-mono ${
            regime === 'pre_sep2025'
              ? 'bg-amber-500/[0.06] border-amber-500/25 text-amber-300'
              : 'bg-violet-500/[0.06] border-violet-500/25 text-violet-300'
          }`}>
            <span className="font-bold uppercase tracking-wide text-[10px]">
              {regime === 'pre_sep2025' ? 'Pre-Sep 2025 Regime' : 'Post-Sep 2025 Regime'}
            </span>
            <span className="text-zinc-600">—</span>
            <span className="font-sans text-zinc-400">
              {regime === 'pre_sep2025'
                ? 'NSE weekly Nifty expiry was on Thursday. Data covers the period before the SEBI-mandated change on 2025-09-01.'
                : 'NSE moved the weekly Nifty expiry to Tuesday effective 2025-09-01. This is a shorter dataset — patterns may stabilise as more data accumulates.'}
            </span>
          </div>
        )}

        {/* ── Market pulse ribbon ─────────────────────────────────────────────── */}
        <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-sky-500/[0.04]" />
          <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
            <PulseStat
              label="Trading Days"
              value={fmtCount(data.total_days)}
              sub={`${data.total_expiries} expiries · ${data.date_range.from.slice(0, 7)} → ${data.date_range.to.slice(0, 7)}`}
            />
            <div className="w-px bg-zinc-800 self-stretch" />
            <PulseStat
              label="Avg Opening Premium"
              value={fmtPremium(data.summary.overall_avg)}
              sub={`Median ${fmtPremium(data.summary.overall_median)}`}
              color="text-sky-400"
            />
            <div className="w-px bg-zinc-800 self-stretch" />
            <PulseStat
              label="Seller Win Rate"
              value={fmtPct(data.summary.seller_win_pct)}
              sub={`Avg daily decay ${fmtPct(data.summary.avg_daily_decay_pct)}`}
              color="text-emerald-400"
            />

            <div className="ml-auto flex items-center gap-5 flex-wrap">
              <PulseStat
                label="Highest Premium"
                value={fmtPremium(data.summary.overall_max)}
                color="text-rose-400"
                size="text-sm"
              />
              <PulseStat
                label="Lowest Premium"
                value={fmtPremium(data.summary.overall_min)}
                color="text-emerald-400"
                size="text-sm"
              />
              <PulseStat label="Regime" value={regime === 'all' ? 'ALL' : regime === 'pre_sep2025' ? 'PRE' : 'POST'} size="text-sm" color="text-zinc-300" />
            </div>
          </div>
        </div>

        {/* ── Section: Weekday Analysis ──────────────────────────────────────── */}
        <Section
          eyebrow="Seasonality"
          title="Opening Premium by Weekday"
          sub="9:15 AM NIFTY ATM straddle premium, grouped by session weekday"
          note={regimeLabel}
          glow="blue"
          info={{
            title: 'Opening Premium by Weekday',
            content: (
              <>
                <p>Shows the average NIFTY ATM straddle premium at 9:15 AM grouped by the day of the week, calculated over all historical trading days.</p>
                <p className="mt-1 font-semibold text-zinc-200">What to look for:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li>Higher premium days = more theta collected if you sell at open.</li>
                  <li>Error bars (dashed line = overall avg) let you spot which day is structurally rich or cheap.</li>
                  <li><span className="text-emerald-400">Seller Win%</span> in the table tells you on what % of that weekday's sessions the straddle closed below the open — the seller's edge per day.</li>
                </ul>
                <p className="mt-1 text-zinc-500">Premium reflects both IV and spot movement risk; higher premium on a particular day doesn't always mean more edge — check Seller Win% alongside.</p>
              </>
            ),
          }}
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdayChartData} barSize={36} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="name" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                <Bar dataKey="avg" name="Avg Premium" radius={[4, 4, 0, 0]}>
                  {weekdayChartData.map((entry) => (
                    <Cell key={entry.fullName} fill={WEEKDAY_COLORS[entry.fullName] ?? CHART_COLORS.primary} />
                  ))}
                </Bar>
                <ReferenceLine y={data.summary.overall_avg} stroke={CHART_COLORS.amber} strokeDasharray="4 3"
                  label={{ value: 'Overall Avg', fill: '#fbbf24', fontSize: 10, fontWeight: 700, position: 'insideTopRight' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <StatsTable
            rows={WEEKDAYS.filter((d) => data.by_weekday[d]).map((d) => ({
              key: d, label: d, color: WEEKDAY_COLORS[d],
            }))}
            columns={[
              { header: 'Count',        accessor: (k) => fmtCount(data.by_weekday[k]?.count) },
              { header: 'Avg',          accessor: (k) => fmtPremium(data.by_weekday[k]?.avg) },
              { header: 'Median',       accessor: (k) => fmtPremium(data.by_weekday[k]?.median) },
              { header: 'Min',          accessor: (k) => fmtPremium(data.by_weekday[k]?.min) },
              { header: 'Max',          accessor: (k) => fmtPremium(data.by_weekday[k]?.max) },
              { header: 'P25',          accessor: (k) => fmtPremium(data.by_weekday[k]?.p25) },
              { header: 'P75',          accessor: (k) => fmtPremium(data.by_weekday[k]?.p75) },
              { header: 'Seller Win%',  accessor: (k) => fmtPct(data.by_weekday[k]?.seller_win_pct), className: 'text-emerald-400' },
              { header: 'Avg Decay%',   accessor: (k) => fmtPct(data.by_weekday[k]?.avg_decay_pct) },
            ]}
          />
        </Section>

        {/* ── Section: DTE Analysis ──────────────────────────────────────────── */}
        <Section
          eyebrow="Term Structure"
          title="Opening Premium by Days to Expiry (DTE)"
          sub="Theta decay curve — how opening premium shrinks as expiry approaches, with P25–P75 band"
          note={regimeLabel}
          glow="emerald"
          info={{
            title: 'Days to Expiry (DTE) Analysis',
            content: (
              <>
                <p><strong className="text-zinc-200">DTE</strong> = <em>trading days</em> (business days) between the trade date and the expiry date — weekends and market holidays are excluded. 0 DTE = expiry day itself; 1 DTE = one trading day before expiry, etc.</p>
                <p className="mt-1 text-zinc-500">Using trading days means both regimes map consistently: DTE 2 is always two sessions before expiry (Tuesday for Thu-expiry; Friday for Tue-expiry) rather than counting weekends that have no data.</p>
                <p className="mt-1 font-semibold text-zinc-200">Why it matters:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li>As DTE decreases, theta (time decay) accelerates — premium shrinks faster each day.</li>
                  <li>The shaded band shows the P25–P75 range: how spread out premiums are at each DTE.</li>
                  <li>A narrow band = consistent premium; wide band = high volatility of premium across different expiry cycles.</li>
                  <li><span className="text-emerald-400">Avg Decay%</span> is how much of the opening premium typically evaporates by end of day at that DTE.</li>
                </ul>
                <p className="mt-1 text-zinc-500">Use this to choose your preferred selling DTE: 0 DTE has fast decay but lower absolute premium; 2–3 DTE balances both.</p>
              </>
            ),
          }}
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dteChartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="dteBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="name" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                {/* Band fill — hidden from tooltip (name starts with _) */}
                <Area type="monotone" dataKey="p75" name="_band_top" fill="url(#dteBand)" stroke="none" legendType="none" />
                <Area type="monotone" dataKey="p25" name="_band_bot" fill="#09090b" stroke="none" legendType="none" />
                {/* Visible P25 / P75 lines */}
                <Line type="monotone" dataKey="p75" name="P75" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="p25" name="P25" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="avg" name="Avg Premium" stroke={CHART_COLORS.primary}
                  strokeWidth={2.5} dot={{ r: 5, fill: CHART_COLORS.primary, strokeWidth: 0 }} activeDot={{ r: 6 }} />
                <Line type="monotone" dataKey="median" name="Median" stroke={CHART_COLORS.amber}
                  strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <StatsTable
            rows={DTE_LABELS.filter((l) => data.by_dte[l]).map((l, i) => ({
              key: l, label: `${l} DTE`, color: DTE_COLORS[i],
            }))}
            columns={[
              { header: 'Count',        accessor: (k) => fmtCount(data.by_dte[k]?.count) },
              { header: 'Avg',          accessor: (k) => fmtPremium(data.by_dte[k]?.avg) },
              { header: 'Median',       accessor: (k) => fmtPremium(data.by_dte[k]?.median) },
              { header: 'Min',          accessor: (k) => fmtPremium(data.by_dte[k]?.min) },
              { header: 'Max',          accessor: (k) => fmtPremium(data.by_dte[k]?.max) },
              { header: 'P25',          accessor: (k) => fmtPremium(data.by_dte[k]?.p25) },
              { header: 'P75',          accessor: (k) => fmtPremium(data.by_dte[k]?.p75) },
              { header: 'Seller Win%',  accessor: (k) => fmtPct(data.by_dte[k]?.seller_win_pct), className: 'text-emerald-400' },
              { header: 'Avg Decay%',   accessor: (k) => fmtPct(data.by_dte[k]?.avg_decay_pct) },
            ]}
          />
        </Section>

        {/* ── Section: Distribution ──────────────────────────────────────────── */}
        <Section
          eyebrow="Statistics"
          title="Premium Distribution (All Days)"
          sub="Histogram of every opening straddle premium in the dataset, with a fitted normal curve overlay"
          info={{
            title: 'Premium Distribution',
            content: (
              <>
                <p>A histogram of all opening straddle premiums across the full dataset. Each bar = number of trading days where the 9:15 AM premium fell in that ₹ bucket. The amber curve is a fitted normal distribution.</p>
                <p className="mt-1 font-semibold text-zinc-200">How to read the stats:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li><strong className="text-zinc-300">Skew &gt; 0</strong> means a right tail — rare days with very high IV (elections, budget, global events) pull the average above the median.</li>
                  <li><strong className="text-zinc-300">P10/P90</strong> define the "normal" range. Premiums outside this are statistical outliers worth investigating.</li>
                  <li>If the histogram is left of the normal curve, recent premiums have been compressing (IV regime shift).</li>
                </ul>
                <p className="mt-1 text-zinc-500">Use P25 and P75 as benchmarks: a premium near P25 suggests a "cheap" day to sell; near P75 is a "rich" day.</p>
              </>
            ),
          }}
        >
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={normalData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="bin" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} interval={3} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false} width={40} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="text-zinc-300 font-semibold mb-2 font-sans">{d.binLabel}</div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans"><span>Days</span><span className="text-white font-bold">{d.count}</span></div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans"><span>Normal curve</span><span className="text-amber-400 font-bold">{d.normal}</span></div>
                      </div>
                    );
                  }}
                  cursor={{ fill: '#27272a', opacity: 0.4 }}
                />
                <Bar dataKey="count" name="Days" fill={CHART_COLORS.primary} fillOpacity={0.55} radius={[2, 2, 0, 0]} barSize={14} />
                <Line type="monotone" dataKey="normal" name="Normal" stroke={CHART_COLORS.amber}
                  strokeWidth={2} dot={false} />
                <ReferenceLine x={Math.round(data.distribution.mean)} stroke={CHART_COLORS.rose} strokeDasharray="4 3"
                  label={{ value: 'Mean', fill: '#f87171', fontSize: 10, fontWeight: 700, position: 'insideTopRight' }} />
                <ReferenceLine x={Math.round(data.distribution.median)} stroke={CHART_COLORS.emerald} strokeDasharray="4 3"
                  label={{ value: 'Median', fill: '#34d399', fontSize: 10, fontWeight: 700, position: 'insideTopLeft' }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            {[
              { label: 'Mean',     value: fmtPremium(data.distribution.mean) },
              { label: 'Std Dev',  value: fmtPremium(data.distribution.std) },
              { label: 'Median',   value: fmtPremium(data.distribution.median) },
              { label: 'Skew',     value: data.distribution.skew.toFixed(2) },
              { label: 'P10',      value: fmtPremium(data.distribution.p10) },
              { label: 'P25',      value: fmtPremium(data.distribution.p25) },
              { label: 'P75',      value: fmtPremium(data.distribution.p75) },
              { label: 'P90',      value: fmtPremium(data.distribution.p90) },
            ].map((s) => (
              <div key={s.label} className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-center">
                <div className="text-[9px] text-zinc-500 uppercase tracking-wide mb-0.5">{s.label}</div>
                <div className="text-sm font-bold text-white tabular-nums font-mono">{s.value}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Section: Decay Analysis ────────────────────────────────────────── */}
        <Section
          eyebrow="Theta Burn"
          title="Decay Analysis"
          sub="Day-over-day opening decay curve alongside the intraday burn profile by DTE bucket"
          glow="emerald"
          info={{
            title: 'Decay Analysis — Two Views',
            content: (
              <>
                <p className="font-semibold text-zinc-200">Left — Day-over-Day DTE Curve:</p>
                <p className="text-zinc-400">Shows the average opening premium for each DTE (5+ → 0). This is the theta decay curve: how much premium exists at market open as expiry approaches. The shaded band is P25–P75.</p>
                <p className="mt-2 font-semibold text-zinc-200">Right — Intraday Decay Curves:</p>
                <p className="text-zinc-400">Shows how the straddle premium bleeds from 9:15 AM to 3:30 PM on an average day, split by DTE bucket. Each line is the average across all days in that bucket.</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-1">
                  <li>Steeper slope = faster intraday theta burn.</li>
                  <li>0 DTE line drops fastest — all time value must collapse by 3:30 PM.</li>
                  <li>Crossovers between lines reveal periods where higher-DTE straddles temporarily become cheaper intraday.</li>
                </ul>
                <p className="mt-1 text-zinc-500">Combine both charts: sell at a DTE where opening premium is rich AND intraday decay is fast.</p>
              </>
            ),
          }}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* DTE decay curve */}
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-3 font-bold">Day-over-Day: Avg Opening Premium by DTE</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dteCurveData} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="decayBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.16} />
                        <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="label" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false}
                      label={{ value: 'DTE', position: 'insideBottom', offset: -2, fill: '#71717a', fontSize: 10 }} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                    {/* Band fill — hidden from tooltip */}
                    <Area type="monotone" dataKey="p75" name="_band_top" fill="url(#decayBand)" stroke="none" legendType="none" />
                    <Area type="monotone" dataKey="p25" name="_band_bot" fill="#09090b" stroke="none" legendType="none" />
                    {/* Visible P25 / P75 lines */}
                    <Line type="monotone" dataKey="p75" name="P75" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line type="monotone" dataKey="p25" name="P25" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line type="monotone" dataKey="avg" name="Avg" stroke={CHART_COLORS.emerald}
                      strokeWidth={2.5} dot={{ r: 5, fill: CHART_COLORS.emerald, strokeWidth: 0 }} activeDot={{ r: 6 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Intraday decay by DTE bucket */}
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-3 font-bold">Intraday: Average Straddle Premium Curve by DTE</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="time" type="category" allowDuplicatedCategory={false}
                      tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false} interval={11} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                    <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                      formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>} />
                    {(['0', '1', '2', '3+'] as const).map((bucket, i) => {
                      if (!data.intraday_decay[bucket]) return null;
                      const pts = intradaySubsample(data.intraday_decay[bucket]);
                      return (
                        <Line
                          key={bucket}
                          data={pts}
                          dataKey="avg"
                          name={`${bucket} DTE`}
                          stroke={DTE_COLORS[i]}
                          strokeWidth={1.5}
                          dot={false}
                          activeDot={{ r: 3 }}
                          type="monotone"
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </Section>

        {/* ── Section: Trend Over Time ───────────────────────────────────────── */}
        <Section
          eyebrow="Regime"
          title="Premium Trend Over Time (Monthly Avg)"
          sub="Monthly average NIFTY ATM opening straddle premium — a proxy for the prevailing IV regime"
          note={dateFilter !== 'all' ? `${dateFilter.toUpperCase()} filter applied` : 'Full history'}
          glow="blue"
          info={{
            title: 'Premium Trend Over Time',
            content: (
              <>
                <p>Plots the monthly average NIFTY ATM opening straddle premium from Dec 2020 to present. Each point = average across all trading days in that month, regardless of DTE or weekday.</p>
                <p className="mt-1 font-semibold text-zinc-200">What to look for:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li>Rising trend = expanding IV regime (fear, uncertainty, high VIX) — premiums are rich, good time to sell.</li>
                  <li>Falling trend = IV compression — premiums are cheap, selling edge diminishes.</li>
                  <li>Sudden spikes = event-driven months (elections, budget, global shocks).</li>
                  <li>The amber dashed line is the all-time overall average — gauge whether current premiums are above or below the long-run mean.</li>
                </ul>
                <p className="mt-1 text-zinc-500">Use the date range filter (All / 3Y / 2Y / 1Y) in the header to zoom in on recent regime.</p>
              </>
            ),
          }}
        >
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredMonthly} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="premGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={CHART_COLORS.primary} stopOpacity={0.32} />
                    <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="month" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false}
                  interval={Math.floor(filteredMonthly.length / 12)} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as MonthlyPoint;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="text-zinc-300 font-semibold mb-2 font-sans">{d.month}</div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans"><span>Avg Premium</span><span className="text-sky-400 font-bold">{fmtPremium(d.avg)}</span></div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans"><span>Days</span><span className="text-white font-bold">{d.count}</span></div>
                      </div>
                    );
                  }}
                  cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area type="monotone" dataKey="avg" name="Avg Premium"
                  stroke={CHART_COLORS.primary} strokeWidth={2.5} fill="url(#premGrad)" activeDot={{ r: 5 }} />
                <ReferenceLine y={data.summary.overall_avg} stroke={CHART_COLORS.amber} strokeDasharray="4 3"
                  label={{ value: 'Overall Avg', fill: '#fbbf24', fontSize: 10, fontWeight: 700, position: 'insideTopRight' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>

        {/* ── Section: Range & Seller Performance ────────────────────────────── */}
        <Section
          eyebrow="Volatility"
          title="Intraday Range Analysis"
          sub="How far the combined CE+PE premium typically swings within a session, by DTE and weekday"
          info={{
            title: 'Intraday Range Analysis',
            content: (
              <>
                <p>Measures the typical <strong className="text-zinc-200">day range</strong> of the straddle — the spread between the session high and low of the combined CE+PE premium.</p>
                <p className="mt-1 font-semibold text-zinc-200">Key metrics:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li><strong className="text-zinc-300">Avg Range</strong> — how many ₹ the straddle typically moves intraday. A wider range means more opportunity (and risk) for adjustments.</li>
                  <li><strong className="text-zinc-300">Range / Open %</strong> — range as a percentage of the opening premium. E.g. 40% means the straddle can move ₹40 on a ₹100 opening. This is the "efficiency" measure — how actively the straddle moves relative to its starting value.</li>
                  <li><span className="text-emerald-400">Seller Win%</span> — on what % of days at this DTE does the straddle close below open (seller keeps premium).</li>
                </ul>
                <p className="mt-1 text-zinc-500">Note: Day high/low are computed as CE_high + PE_high and CE_low + PE_low per candle — a slight overestimate since legs don't always peak simultaneously.</p>
              </>
            ),
          }}
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Range by DTE */}
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-3 font-bold">Avg Day Range by DTE</p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByDte} barSize={28} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="name" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={48} />
                    <Tooltip content={<ChartTooltip formatter={(v, n) => n === 'Range %' ? fmtPct(v) : fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                    <Bar dataKey="avg_range" name="Avg Range" radius={[3, 3, 0, 0]}>
                      {rangeByDte.map((entry, i) => (
                        <Cell key={entry.label} fill={DTE_COLORS[i]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Range by Weekday */}
            <div>
              <p className="text-[10px] text-zinc-500 uppercase tracking-wide mb-3 font-bold">Avg Day Range by Weekday</p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByWd} barSize={28} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="name" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={48} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                    <Bar dataKey="avg_range" name="Avg Range" radius={[3, 3, 0, 0]}>
                      {rangeByWd.map((entry) => (
                        <Cell key={entry.fullName} fill={WEEKDAY_COLORS[entry.fullName] ?? CHART_COLORS.primary} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Range table */}
          <div className="overflow-x-auto mt-4 rounded-lg border border-zinc-800">
            <table className="w-full text-xs border-collapse font-mono">
              <thead>
                <tr className="bg-zinc-950">
                  {['DTE', 'Avg Opening', 'Avg Range', 'Range / Open', 'Seller Win%'].map((h) => (
                    <th key={h} className="px-3 py-2 text-[10px] font-bold text-zinc-400 uppercase tracking-wide whitespace-nowrap text-right first:text-left first:font-sans first:text-white first:normal-case first:text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DTE_LABELS.filter((l) => data.range_analysis.by_dte[l] && data.by_dte[l]).map((l, i) => (
                  <tr key={l} className={`border-t border-zinc-800/60 ${i % 2 === 0 ? 'bg-zinc-900/40' : ''}`}>
                    <td className="px-3 py-2 text-left font-sans">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: DTE_COLORS[i] }} />
                        <span className="text-zinc-200 font-semibold">{l} DTE</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPremium(data.by_dte[l]?.avg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPremium(data.range_analysis.by_dte[l]?.avg_range)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPct(data.range_analysis.by_dte[l]?.avg_range_pct)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-bold">{fmtPct(data.range_analysis.by_dte[l]?.seller_win_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Section: Insights ───────────────────────────────────────────────── */}
        {data.insights.length > 0 && (
          <Section
            eyebrow="Synthesis"
            title="Key Observations"
            sub="Auto-generated statistical observations derived from the full dataset — not trading advice"
            info={{
              title: 'Key Observations',
              content: (
                <>
                  <p>Auto-generated insights derived from the full dataset. These are statistical observations, not trading advice.</p>
                  <p className="mt-1 font-semibold text-zinc-200">Colour coding:</p>
                  <ul className="list-disc list-inside space-y-1 text-zinc-400">
                    <li><span className="text-emerald-400">Green dot</span> — seller-positive observation (high win rate, strong decay).</li>
                    <li><span className="text-sky-400">Blue dot</span> — neutral / informational.</li>
                    <li><span className="text-rose-400">Red dot</span> — risk or outlier observation (highest premium, worst loss scenario).</li>
                  </ul>
                  <p className="mt-1 text-zinc-500">Insights are recalculated each time you regenerate the analysis. Add new data by running <span className="font-mono text-zinc-300">straddle_premium_analysis.py</span> again.</p>
                </>
              ),
            }}
          >
            <ul className="space-y-2">
              {data.insights.map((insight, i) => {
                const isPositive = /seller win|highest seller|won on/i.test(insight);
                const isRisk     = /lowest|worst|risk/i.test(insight);
                const dot = isRisk ? 'bg-rose-400' : isPositive ? 'bg-emerald-400' : 'bg-sky-400';
                return (
                  <li key={i} className="flex items-start gap-3 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5">
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                    <span className="text-zinc-300 text-sm leading-relaxed">{insight}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <div className="text-[10px] text-zinc-600 text-center pb-4 font-mono">
          NIFTY ATM straddle · 9:15 AM opening premium · Source: nifty_options.db ·{' '}
          Day high/low are proxies (CE high + PE high per candle)
        </div>
      </div>

      {/* ── Validity & Intelligence Report Modal ─────────────────────────────── */}
      <StraddleValidityReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        fullData={fullData}
        activeRegime={regime}
      />
    </div>
  );
}
