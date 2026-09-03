'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { getCached, setCached } from '@/lib/clientCache';
import StraddleValidityReportModal from '@/components/StraddleValidityReportModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DteStats {
  count: number;
  avg: number;
  median: number;
  std: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  seller_win_pct: number;
  avg_decay_pct: number;
  avg_range: number;
  avg_range_pct: number;
}

interface Distribution {
  bins: number[];
  counts: number[];
  mean: number;
  std: number;
  median: number;
  skew: number;
  kurtosis: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

interface DecayPoint {
  dte: number | string;
  label: string;
  avg: number;
  p25: number;
  p75: number;
  count: number;
}

interface IntradayPoint {
  time: string;
  avg: number;
  p25: number;
  p75: number;
}

interface MonthlyPoint {
  month: string;
  avg: number;
  count: number;
}

interface RangeEntry {
  avg_range: number;
  avg_range_pct: number;
  seller_win_pct?: number;
}

interface StatusData {
  status: 'idle' | 'running' | 'done' | 'error';
  pct: number;
  message: string;
}

// AnalysisData covers one regime's stats; FullData is the top-level JSON shape
type AnalysisData = {
  date_range: { from: string; to: string };
  total_days: number;
  total_expiries: number;
  summary: {
    overall_avg: number;
    overall_median: number;
    overall_min: number;
    overall_max: number;
    avg_daily_decay_pct: number;
    seller_win_pct: number;
  };
  by_weekday: Record<string, DteStats>;
  by_dte: Record<string, DteStats>;
  distribution: Distribution;
  decay_dte_curve: DecayPoint[];
  intraday_decay: Record<string, IntradayPoint[]>;
  monthly_trend: MonthlyPoint[];
  range_analysis: {
    by_dte: Record<string, RangeEntry>;
    by_weekday: Record<string, RangeEntry>;
  };
  insights: string[];
};

interface FullData {
  generated_at: string;
  regime_cutoff: string;
  regimes: {
    all: AnalysisData;
    pre_sep2025: AnalysisData;
    post_sep2025: AnalysisData;
  };
}

type RegimeKey = 'all' | 'pre_sep2025' | 'post_sep2025';

// ─── Constants & Color Palette ────────────────────────────────────────────────

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DTE_LABELS = ['0', '1', '2', '3', '4', '5+'];

const WEEKDAY_COLORS: Record<string, string> = {
  Monday: '#38bdf8',    // Sky blue
  Tuesday: '#a78bfa',   // Violet
  Wednesday: '#34d399', // Emerald
  Thursday: '#fbbf24',  // Amber
  Friday: '#f87171',    // Rose
};

const DTE_COLORS = [
  '#f87171', // 0 DTE: Rose / Crimson
  '#fb923c', // 1 DTE: Orange
  '#fbbf24', // 2 DTE: Amber
  '#a3e635', // 3 DTE: Lime
  '#22d3ee', // 4 DTE: Cyan
  '#818cf8', // 5+ DTE: Indigo
];

const CHART_COLORS = {
  primary:  '#38bdf8', // Sky 400
  emerald:  '#34d399', // Emerald 400
  rose:     '#f87171', // Rose 400
  amber:    '#fbbf24', // Amber 400
  violet:   '#a78bfa', // Violet 400
  cyan:     '#22d3ee', // Cyan 400
  grid:     '#20202380',
  muted:    '#71717a',
};

const monoTick = {
  fontSize: 10,
  fill: '#a1a1aa',
  fontWeight: 500 as const,
  fontFamily: 'var(--font-mono, monospace)',
};

const gridProps = {
  strokeDasharray: '3 6',
  stroke: CHART_COLORS.grid,
  vertical: false as const,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmtPremium = (n: number | undefined) =>
  n != null
    ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}`
    : '—';

const fmtPct = (n: number | undefined) =>
  n != null ? `${n.toFixed(1)}%` : '—';

const fmtCount = (n: number | undefined) =>
  n != null ? n.toLocaleString('en-IN') : '—';

function dataDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

// ─── Metric Card (Executive KPI) ──────────────────────────────────────────────

function MetricKpiCard({
  label,
  value,
  sub,
  badge,
  badgeColor = 'text-sky-400 bg-sky-500/10 border-sky-500/20',
  color = 'text-white',
  glow = 'sky',
}: {
  label: string;
  value: string;
  sub?: string;
  badge?: string;
  badgeColor?: string;
  color?: string;
  glow?: 'sky' | 'emerald' | 'amber' | 'violet' | 'rose';
}) {
  const glowBorder =
    glow === 'emerald'
      ? 'hover:border-emerald-500/40'
      : glow === 'amber'
      ? 'hover:border-amber-500/40'
      : glow === 'violet'
      ? 'hover:border-violet-500/40'
      : glow === 'rose'
      ? 'hover:border-rose-500/40'
      : 'hover:border-sky-500/40';

  const glowBg =
    glow === 'emerald'
      ? 'bg-emerald-500/[0.04]'
      : glow === 'amber'
      ? 'bg-amber-500/[0.04]'
      : glow === 'violet'
      ? 'bg-violet-500/[0.04]'
      : glow === 'rose'
      ? 'bg-rose-500/[0.04]'
      : 'bg-sky-500/[0.04]';

  return (
    <div
      className={`relative flex-1 min-w-[200px] bg-zinc-900/70 border border-zinc-800 rounded-2xl p-4 transition-all duration-200 overflow-hidden ${glowBorder}`}
    >
      <div className={`pointer-events-none absolute -top-12 -right-12 w-28 h-28 ${glowBg} blur-2xl rounded-full`} />
      <div className="relative flex flex-col justify-between h-full">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-[0.14em]">
            {label}
          </span>
          {badge && (
            <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border ${badgeColor}`}>
              {badge}
            </span>
          )}
        </div>
        <div className="my-1">
          <span className={`text-2xl font-mono font-extrabold tabular-nums tracking-tight ${color}`}>
            {value}
          </span>
        </div>
        {sub && (
          <span className="text-[11px] text-zinc-400 font-medium mt-1">
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Info Button Popover ──────────────────────────────────────────────────────

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
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="w-4 h-4 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white text-[10px] font-bold leading-none flex items-center justify-center transition-colors flex-shrink-0 border border-zinc-700/80"
        aria-label="More information"
      >
        i
      </button>
      {open && (
        <div
          className="absolute left-6 top-0 z-50 w-80 bg-zinc-950/98 border border-zinc-700/80 rounded-xl shadow-2xl p-4 text-xs backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between mb-2.5">
            <span className="font-bold text-white text-sm leading-tight pr-2">{title}</span>
            <button
              onClick={() => setOpen(false)}
              className="text-zinc-500 hover:text-white flex-shrink-0 leading-none mt-0.5"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="text-zinc-300 leading-relaxed space-y-2">{children}</div>
        </div>
      )}
    </div>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────

function ChartHeader({
  eyebrow,
  title,
  sub,
  legend,
  info,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  legend?: React.ReactNode;
  info?: { title: string; content: React.ReactNode };
}) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.16em]">
            {eyebrow}
          </p>
          {info && <InfoButton title={info.title}>{info.content}</InfoButton>}
        </div>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[11px] text-zinc-400 mt-0.5 max-w-xl">{sub}</p>
      </div>
      {legend && (
        <div className="flex items-center gap-3 text-[10px] font-semibold flex-wrap">
          {legend}
        </div>
      )}
    </div>
  );
}

// ─── Section Container (Quant-Terminal Card) ───────────────────────────────────

function SectionCard({
  eyebrow,
  title,
  sub,
  children,
  note,
  info,
  glow = 'sky',
}: {
  eyebrow: string;
  title: string;
  sub: string;
  children: React.ReactNode;
  note?: string;
  info?: { title: string; content: React.ReactNode };
  glow?: 'emerald' | 'sky' | 'amber' | 'violet';
}) {
  const glowColor =
    glow === 'emerald'
      ? 'bg-emerald-500/[0.04]'
      : glow === 'amber'
      ? 'bg-amber-500/[0.04]'
      : glow === 'violet'
      ? 'bg-violet-500/[0.04]'
      : 'bg-sky-500/[0.04]';

  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden backdrop-blur-sm">
      <div
        className={`pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[580px] h-[280px] ${glowColor} blur-3xl rounded-full`}
      />
      <div className="relative">
        <ChartHeader
          eyebrow={eyebrow}
          title={title}
          sub={sub}
          info={info}
          legend={note ? <span className="text-[10px] text-zinc-500 font-mono">{note}</span> : undefined}
        />
        {children}
      </div>
    </div>
  );
}

// ─── Custom Recharts Tooltip ──────────────────────────────────────────────────

function QuantChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; stroke?: string }[];
  label?: string;
  formatter?: (v: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter((p) => !p.name.startsWith('_'));
  if (!visible.length) return null;

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/80 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px] font-mono">
      {label && <div className="text-zinc-200 font-bold mb-2 font-sans border-b border-zinc-800 pb-1.5">{label}</div>}
      <div className="space-y-1.5">
        {visible.map((p) => (
          <div key={p.name} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-zinc-400 font-sans">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.stroke ?? p.color }} />
              {p.name}
            </span>
            <span className="text-white font-bold tabular-nums">
              {formatter ? formatter(p.value, p.name) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Stats Table Helper ───────────────────────────────────────────────────────

function StatsTable({
  rows,
  columns,
}: {
  rows: { key: string; label: string; color?: string }[];
  columns: { header: string; accessor: (key: string) => string; className?: string }[];
}) {
  return (
    <div className="overflow-x-auto mt-4 rounded-xl border border-zinc-800">
      <table className="w-full text-xs border-collapse font-mono">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3.5 py-2.5 text-xs font-bold text-white whitespace-nowrap font-sans">
              Segment
            </th>
            {columns.map((c) => (
              <th
                key={c.header}
                className={`px-3.5 py-2.5 text-xs font-bold text-white uppercase tracking-wider whitespace-nowrap text-right ${c.className ?? ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {rows.map((r, i) => (
            <tr
              key={r.key}
              className={`${i % 2 === 0 ? 'bg-zinc-900/30' : 'bg-transparent'} hover:bg-zinc-800/40 transition-colors`}
            >
              <td className="px-3.5 py-2 whitespace-nowrap font-sans">
                <div className="flex items-center gap-2">
                  {r.color && (
                    <span className="w-2 h-2 rounded-full flex-shrink-0 shadow-sm" style={{ background: r.color }} />
                  )}
                  <span className="text-zinc-200 font-semibold">{r.label}</span>
                </div>
              </td>
              {columns.map((c) => (
                <td
                  key={c.header}
                  className={`px-3.5 py-2 text-right tabular-nums text-zinc-300 whitespace-nowrap ${c.className ?? ''}`}
                >
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

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StraddleAnalysis() {
  const [fullData, setFullData] = useState<FullData | null>(null);
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
    const cached = getCached<FullData>('/api/straddle-analysis');
    if (cached) {
      setFullData(cached);
      setLoadState('loaded');
    }
    try {
      const res = await fetch('/api/straddle-analysis');
      if (res.status === 404) {
        setLoadState('not_generated');
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
      if (!res.ok) {
        if (!cached) setLoadState('error');
        return;
      }
      const json = await res.json();
      if (json.error) {
        setLoadState('not_generated');
        return;
      }
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
      } catch {
        /* keep polling */
      }
    }, 2000);
  }, [fetchData]);

  useEffect(() => {
    fetchData();
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
      await fetch('/api/straddle-analysis', {
        method: 'POST',
        body: JSON.stringify({ action: 'regenerate' }),
      });
    } catch {
      /* ignore */
    }
    startPolling();
  };

  // Filter monthly trend by date filter
  const filteredMonthly = useMemo(() => {
    if (!data) return [];
    if (dateFilter === 'all') return data.monthly_trend;
    const years = dateFilter === '1y' ? 1 : dateFilter === '2y' ? 2 : 3;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const cutoffStr = cutoff.toISOString().slice(0, 7);
    return data.monthly_trend.filter((m) => m.month >= cutoffStr);
  }, [data, dateFilter]);

  // ── Loading / empty states ────────────────────────────────────────────────
  if (loadState === 'loading') {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading straddle analysis…</p>
      </div>
    );
  }

  if (loadState === 'not_generated') {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full relative bg-zinc-900/70 border border-zinc-800 rounded-2xl p-8 text-center overflow-hidden shadow-2xl">
          <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[400px] h-[200px] bg-emerald-500/[0.08] blur-3xl rounded-full" />
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4 text-emerald-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.16em] mb-1">Analysis Database</p>
            <h2 className="text-white text-lg font-bold font-mono mb-2">Straddle Dataset Not Generated</h2>
            <p className="text-zinc-400 text-xs mb-6 leading-relaxed">
              Run the analysis engine to build the historical straddle premium dataset from{' '}
              <span className="text-zinc-300 font-mono">nifty_options.db</span> (~60s).
            </p>
            {regenerating ? (
              <div className="space-y-2">
                <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-emerald-400 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${regenProgress}%` }}
                  />
                </div>
                <p className="text-xs text-zinc-400 font-mono">{regenMessage} ({regenProgress}%)</p>
              </div>
            ) : (
              <button
                onClick={startRegen}
                className="w-full py-2.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 text-xs font-bold font-mono rounded-xl transition-colors shadow-sm"
              >
                Run Straddle Analysis
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !fullData || !data) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6 text-rose-400 text-sm">
        Failed to load straddle analysis data. Please check server logs or click regenerate.
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

  const { mean: dMean, std: dStd } = data.distribution;
  const totalCount = data.distribution.counts.reduce((a, b) => a + b, 0);
  const binWidth = data.distribution.bins[1] - data.distribution.bins[0];
  const normalData = histData.map((h) => {
    const x = h.bin + binWidth / 2;
    const normal =
      (1 / (dStd * Math.sqrt(2 * Math.PI))) *
      Math.exp(-0.5 * ((x - dMean) / dStd) ** 2) *
      totalCount *
      binWidth;
    return { ...h, normal: Math.round(normal) };
  });

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

  const regimeLabel =
    regime === 'all'
      ? 'Full History (2020–Present)'
      : regime === 'pre_sep2025'
      ? 'Pre-Sep 2025 (Thursday Expiry)'
      : 'Post-Sep 2025 (Tuesday Expiry)';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-300">
      {/* ── Sticky Header (Quant-Terminal Standard) ─────────────────────────── */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-4 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        {/* Left: Icon Badge & Title */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M12 3v18M3 12h18M5 7l14 10M5 17L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-bold text-emerald-400 uppercase tracking-[0.18em]">
                Options Analytics · NIFTY 50
              </p>
              <span className="inline-flex items-center text-[9px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-1.5 py-0.2 rounded">
                DATA: {dataDate(fullData.generated_at)}
              </span>
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none mt-0.5">
              NIFTY ATM Straddle Premium Analysis{' '}
              <span className="text-zinc-400 font-mono text-xs font-medium">
                (9:15 AM ATM Combined CE+PE)
              </span>
            </h1>
          </div>
        </div>

        {/* Right: Controls Cluster */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Regime Selector */}
          <div className="flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-1 rounded-xl text-[10px]">
            {(
              [
                { key: 'all',          label: 'All',          title: 'Full history' },
                { key: 'pre_sep2025',  label: 'Pre Sep\'25',  title: 'Before 2025-09-01 · Thursday weekly expiry' },
                { key: 'post_sep2025', label: 'Post Sep\'25', title: 'From 2025-09-01 · Tuesday weekly expiry' },
              ] as { key: RegimeKey; label: string; title: string }[]
            ).map(({ key, label, title }) => (
              <button
                key={key}
                onClick={() => setRegime(key)}
                title={title}
                className={`px-2.5 py-1 font-mono font-bold rounded-lg transition-all whitespace-nowrap ${
                  regime === key
                    ? key === 'pre_sep2025'
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : key === 'post_sep2025'
                      ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                      : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Date Range Filter */}
          <div className="flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-1 rounded-xl text-[10px]">
            {(['all', '3y', '2y', '1y'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setDateFilter(f)}
                className={`px-2 py-1 font-mono font-bold rounded-lg transition-all ${
                  dateFilter === f
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {f === 'all' ? 'All' : f.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Validity & Intelligence Report Trigger */}
          <button
            onClick={() => setShowReportModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 rounded-xl transition-colors shadow-sm"
            title="Open Straddle Validity Audit & Intelligence Report"
          >
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Analyse Report
          </button>

          {/* Regenerate Trigger */}
          {regenerating ? (
            <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-3 py-1.5 rounded-xl min-w-36">
              <div className="w-full bg-zinc-800 rounded-full h-1.5">
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
              className="px-3 py-1.5 text-xs font-mono font-bold bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-xl transition-colors"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>

      {/* ── Main Dashboard Body ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col gap-5 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {/* Regime Notice Banner if filtering by regime */}
        {regime !== 'all' && (
          <div
            className={`rounded-xl px-4 py-2.5 text-xs flex items-center justify-between gap-3 border font-mono ${
              regime === 'pre_sep2025'
                ? 'bg-amber-500/[0.06] border-amber-500/25 text-amber-300'
                : 'bg-violet-500/[0.06] border-violet-500/25 text-violet-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-bold uppercase tracking-wider text-[10px]">
                {regime === 'pre_sep2025' ? 'Pre-Sep 2025 Regime' : 'Post-Sep 2025 Regime'}
              </span>
              <span className="text-zinc-600">•</span>
              <span className="font-sans text-zinc-300 text-xs">
                {regime === 'pre_sep2025'
                  ? 'Thursday weekly expiry regime prior to SEBI single weekly index mandate.'
                  : 'Tuesday weekly expiry regime effective 2025-09-01 under current market structure.'}
              </span>
            </div>
            <span className="text-[10px] font-mono text-zinc-400">
              {data.date_range.from} → {data.date_range.to}
            </span>
          </div>
        )}

        {/* ── Market Pulse Hero Cards ───────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
          <MetricKpiCard
            label="Dataset Depth"
            value={fmtCount(data.total_days)}
            sub={`${data.total_expiries} weekly cycles · ${data.date_range.from.slice(0, 7)} → ${data.date_range.to.slice(0, 7)}`}
            badge="HISTORICAL"
            glow="sky"
          />
          <MetricKpiCard
            label="Avg Opening Premium"
            value={fmtPremium(data.summary.overall_avg)}
            sub={`Median ${fmtPremium(data.summary.overall_median)} · P25–P75: ${fmtPremium(data.distribution.p25)}–${fmtPremium(data.distribution.p75)}`}
            badge="9:15 AM ATM"
            color="text-sky-300"
            glow="sky"
          />
          <MetricKpiCard
            label="Seller Win Rate"
            value={fmtPct(data.summary.seller_win_pct)}
            sub={`Avg daily decay ${fmtPct(data.summary.avg_daily_decay_pct)} across sessions`}
            badge="EDGE"
            badgeColor="text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
            color="text-emerald-400"
            glow="emerald"
          />
          <MetricKpiCard
            label="Intraday Volatility"
            value={fmtPremium(data.range_analysis.by_dte['0']?.avg_range ?? 0)}
            sub={`0-DTE session swing · ${fmtPct(data.range_analysis.by_dte['0']?.avg_range_pct ?? 0)} of open`}
            badge="0-DTE SWING"
            badgeColor="text-violet-400 bg-violet-500/10 border-violet-500/20"
            color="text-violet-300"
            glow="violet"
          />
          <MetricKpiCard
            label="Extreme Corridor"
            value={`${fmtPremium(data.summary.overall_min)} – ${fmtPremium(data.summary.overall_max)}`}
            sub={`Historical low vs peak 9:15 AM straddle opening`}
            badge="VOL RANGE"
            badgeColor="text-amber-400 bg-amber-500/10 border-amber-500/20"
            color="text-amber-300"
            glow="amber"
          />
        </div>

        {/* ── DTE Breakdown Quick Ribbon ────────────────────────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 overflow-hidden">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.16em]">
                DTE Term Snapshot
              </p>
              <h3 className="text-xs font-bold text-white tracking-tight">
                Days to Expiry Curve Summary ({regimeLabel})
              </h3>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">
              ATM Straddle Value by Calendar Segment
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {DTE_LABELS.filter((l) => data.by_dte[l]).map((l, i) => {
              const dteInfo = data.by_dte[l];
              const rangeInfo = data.range_analysis.by_dte[l];
              return (
                <div
                  key={l}
                  className="bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-3 flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold font-mono text-white flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: DTE_COLORS[i] }} />
                      {l} DTE
                    </span>
                    <span className="text-[9px] font-mono text-zinc-500">
                      N={dteInfo.count}
                    </span>
                  </div>
                  <div className="text-sm font-extrabold font-mono text-sky-300 my-0.5">
                    {fmtPremium(dteInfo.avg)}
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                    <span>Decay:</span>
                    <span className="text-emerald-400 font-bold">{fmtPct(dteInfo.avg_decay_pct)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                    <span>Win %:</span>
                    <span className="text-zinc-200">{fmtPct(dteInfo.seller_win_pct)}</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 border-t border-zinc-800/60 pt-1 mt-1">
                    <span>Range:</span>
                    <span className="text-amber-400">{fmtPremium(rangeInfo?.avg_range)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Section 1: Weekday Analysis ───────────────────────────────────── */}
        <SectionCard
          eyebrow="Seasonality Profile"
          title="Opening Straddle Premium by Weekday"
          sub="9:15 AM NIFTY ATM straddle premium grouped by session weekday"
          note={regimeLabel}
          glow="sky"
          info={{
            title: 'Opening Premium by Weekday',
            content: (
              <>
                <p>
                  Shows the average NIFTY ATM straddle premium at 9:15 AM grouped by trading day, calculated across the historical dataset.
                </p>
                <p className="mt-1 font-semibold text-zinc-200">Key Takeaways:</p>
                <ul className="list-disc list-inside space-y-1 text-zinc-400">
                  <li>Higher premium days offer greater absolute theta collection upon opening.</li>
                  <li>Dashed amber reference line indicates the overall dataset average.</li>
                  <li>
                    <span className="text-emerald-400">Seller Win%</span> indicates what percentage of sessions closed
                    below the 9:15 AM opening premium.
                  </li>
                </ul>
              </>
            ),
          }}
        >
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdayChartData} barSize={38} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="name" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={54} />
                <Tooltip content={<QuantChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                <Bar dataKey="avg" name="Avg Premium" radius={[5, 5, 0, 0]}>
                  {weekdayChartData.map((entry) => (
                    <Cell key={entry.fullName} fill={WEEKDAY_COLORS[entry.fullName] ?? CHART_COLORS.primary} />
                  ))}
                </Bar>
                <ReferenceLine
                  y={data.summary.overall_avg}
                  stroke={CHART_COLORS.amber}
                  strokeDasharray="4 3"
                  label={{
                    value: `Avg ₹${data.summary.overall_avg.toFixed(1)}`,
                    fill: '#fbbf24',
                    fontSize: 10,
                    fontWeight: 700,
                    position: 'insideTopRight',
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <StatsTable
            rows={WEEKDAYS.filter((d) => data.by_weekday[d]).map((d) => ({
              key: d,
              label: d,
              color: WEEKDAY_COLORS[d],
            }))}
            columns={[
              { header: 'Sessions',    accessor: (k) => fmtCount(data.by_weekday[k]?.count) },
              { header: 'Avg Open',    accessor: (k) => fmtPremium(data.by_weekday[k]?.avg) },
              { header: 'Median',      accessor: (k) => fmtPremium(data.by_weekday[k]?.median) },
              { header: 'P25',         accessor: (k) => fmtPremium(data.by_weekday[k]?.p25) },
              { header: 'P75',         accessor: (k) => fmtPremium(data.by_weekday[k]?.p75) },
              { header: 'Seller Win%', accessor: (k) => fmtPct(data.by_weekday[k]?.seller_win_pct), className: 'text-emerald-400 font-bold' },
              { header: 'Avg Decay%',  accessor: (k) => fmtPct(data.by_weekday[k]?.avg_decay_pct), className: 'text-sky-400' },
            ]}
          />
        </SectionCard>

        {/* ── Section 2: DTE Term Structure ─────────────────────────────────── */}
        <SectionCard
          eyebrow="Term Structure"
          title="Opening Premium by Days to Expiry (DTE)"
          sub="Theta decay curve — opening premium shrinkage with P25–P75 confidence corridor"
          note={regimeLabel}
          glow="emerald"
          info={{
            title: 'Days to Expiry (DTE) Analysis',
            content: (
              <>
                <p>
                  <strong className="text-zinc-200">DTE</strong> reflects market trading days remaining until weekly expiry.
                  0 DTE represents the expiration day itself.
                </p>
                <p className="mt-1 text-zinc-400">
                  The shaded band represents the P25–P75 interquartile spread, showing premium distribution stability across cycles.
                </p>
              </>
            ),
          }}
        >
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dteChartData} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="dteBand" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="name" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={54} />
                <Tooltip
                  content={<QuantChartTooltip formatter={(v) => fmtPremium(v)} />}
                  cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area type="monotone" dataKey="p75" name="_band_top" fill="url(#dteBand)" stroke="none" legendType="none" />
                <Area type="monotone" dataKey="p25" name="_band_bot" fill="#09090b" stroke="none" legendType="none" />
                <Line type="monotone" dataKey="p75" name="P75 (Upper Band)" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="p25" name="P25 (Lower Band)" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line
                  type="monotone"
                  dataKey="avg"
                  name="Avg Premium"
                  stroke={CHART_COLORS.primary}
                  strokeWidth={2.5}
                  dot={{ r: 4.5, fill: CHART_COLORS.primary, strokeWidth: 0 }}
                  activeDot={{ r: 6 }}
                />
                <Line type="monotone" dataKey="median" name="Median" stroke={CHART_COLORS.amber} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <StatsTable
            rows={DTE_LABELS.filter((l) => data.by_dte[l]).map((l, i) => ({
              key: l,
              label: `${l} DTE`,
              color: DTE_COLORS[i],
            }))}
            columns={[
              { header: 'Sessions',    accessor: (k) => fmtCount(data.by_dte[k]?.count) },
              { header: 'Avg Open',    accessor: (k) => fmtPremium(data.by_dte[k]?.avg) },
              { header: 'Median',      accessor: (k) => fmtPremium(data.by_dte[k]?.median) },
              { header: 'P25',         accessor: (k) => fmtPremium(data.by_dte[k]?.p25) },
              { header: 'P75',         accessor: (k) => fmtPremium(data.by_dte[k]?.p75) },
              { header: 'Seller Win%', accessor: (k) => fmtPct(data.by_dte[k]?.seller_win_pct), className: 'text-emerald-400 font-bold' },
              { header: 'Avg Decay%',  accessor: (k) => fmtPct(data.by_dte[k]?.avg_decay_pct), className: 'text-sky-400 font-bold' },
            ]}
          />
        </SectionCard>

        {/* ── Section 3: Premium Distribution ───────────────────────────────── */}
        <SectionCard
          eyebrow="Statistical Properties"
          title="Premium Distribution & Quantiles"
          sub="Empirical frequency histogram of 9:15 AM opening straddle prices vs fitted normal curve"
          glow="amber"
          info={{
            title: 'Premium Distribution & Tail Risk',
            content: (
              <>
                <p>
                  Displays the probability density of straddle opening values across the selected regime.
                </p>
                <p className="mt-1 text-zinc-400">
                  A positive skew reflects fat right tails during high-volatility macro shocks (elections, budgets, sudden geopolitical events).
                </p>
              </>
            ),
          }}
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={normalData} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid {...gridProps} />
                <XAxis
                  dataKey="bin"
                  tick={{ ...monoTick, fontSize: 9 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  tickFormatter={(v) => `₹${v}`}
                  interval={3}
                />
                <YAxis tick={monoTick} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700/80 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="text-zinc-200 font-bold mb-2 font-sans border-b border-zinc-800 pb-1">{d.binLabel}</div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                          <span>Observed Days</span>
                          <span className="text-white font-bold">{d.count}</span>
                        </div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                          <span>Fitted Normal</span>
                          <span className="text-amber-400 font-bold">{d.normal}</span>
                        </div>
                      </div>
                    );
                  }}
                  cursor={{ fill: '#27272a', opacity: 0.4 }}
                />
                <Bar dataKey="count" name="Days" fill={CHART_COLORS.primary} fillOpacity={0.6} radius={[3, 3, 0, 0]} barSize={16} />
                <Line type="monotone" dataKey="normal" name="Fitted Normal" stroke={CHART_COLORS.amber} strokeWidth={2} dot={false} />
                <ReferenceLine
                  x={Math.round(data.distribution.mean)}
                  stroke={CHART_COLORS.rose}
                  strokeDasharray="4 3"
                  label={{ value: 'Mean', fill: '#f87171', fontSize: 10, fontWeight: 700, position: 'insideTopRight' }}
                />
                <ReferenceLine
                  x={Math.round(data.distribution.median)}
                  stroke={CHART_COLORS.emerald}
                  strokeDasharray="4 3"
                  label={{ value: 'Median', fill: '#34d399', fontSize: 10, fontWeight: 700, position: 'insideTopLeft' }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
            {[
              { label: 'Mean',     value: fmtPremium(data.distribution.mean), color: 'text-white' },
              { label: 'Median',   value: fmtPremium(data.distribution.median), color: 'text-emerald-400' },
              { label: 'Std Dev',  value: fmtPremium(data.distribution.std), color: 'text-zinc-300' },
              { label: 'Skew',     value: data.distribution.skew.toFixed(2), color: 'text-amber-400' },
              { label: 'P10',      value: fmtPremium(data.distribution.p10), color: 'text-zinc-300' },
              { label: 'P25',      value: fmtPremium(data.distribution.p25), color: 'text-sky-300' },
              { label: 'P75',      value: fmtPremium(data.distribution.p75), color: 'text-violet-300' },
              { label: 'P90',      value: fmtPremium(data.distribution.p90), color: 'text-rose-400' },
            ].map((s) => (
              <div key={s.label} className="bg-zinc-950/80 border border-zinc-800 rounded-xl px-3 py-2 text-center">
                <div className="text-[9px] text-zinc-400 uppercase font-bold tracking-wider mb-0.5">{s.label}</div>
                <div className={`text-xs font-bold font-mono tabular-nums ${s.color}`}>{s.value}</div>
              </div>
            ))}
          </div>
        </SectionCard>

        {/* ── Section 4: Decay Analysis (Dual View) ─────────────────────────── */}
        <SectionCard
          eyebrow="Theta Burn Velocity"
          title="Decay Dynamics & Intraday Burn Profile"
          sub="Day-over-day opening theta decay curve alongside minute-by-minute intraday premium erosion"
          glow="emerald"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: DTE Curve */}
            <div>
              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-2 font-bold">
                Day-over-Day: Opening Premium by DTE
              </p>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dteCurveData} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="decayBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34d399" stopOpacity={0.16} />
                        <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="label" tick={monoTick} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<QuantChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                    <Area type="monotone" dataKey="p75" name="_band_top" fill="url(#decayBand)" stroke="none" legendType="none" />
                    <Area type="monotone" dataKey="p25" name="_band_bot" fill="#09090b" stroke="none" legendType="none" />
                    <Line type="monotone" dataKey="p75" name="P75" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line type="monotone" dataKey="p25" name="P25" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line
                      type="monotone"
                      dataKey="avg"
                      name="Avg"
                      stroke={CHART_COLORS.emerald}
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: CHART_COLORS.emerald, strokeWidth: 0 }}
                      activeDot={{ r: 6 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Right: Intraday Curve */}
            <div>
              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-2 font-bold">
                Intraday: Average Straddle Premium Bleed (9:15 → 15:30)
              </p>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis
                      dataKey="time"
                      type="category"
                      allowDuplicatedCategory={false}
                      tick={{ ...monoTick, fontSize: 9 }}
                      axisLine={{ stroke: '#27272a' }}
                      tickLine={false}
                      interval={11}
                    />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<QuantChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
                    <Legend
                      wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                      formatter={(v: string) => <span style={{ color: '#e4e4e7', fontWeight: 600 }}>{v}</span>}
                    />
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
                          strokeWidth={1.8}
                          dot={false}
                          activeDot={{ r: 3.5 }}
                          type="monotone"
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* ── Section 5: Monthly Macro Trend ────────────────────────────────── */}
        <SectionCard
          eyebrow="Macro Regime"
          title="Premium Trend Over Time (Monthly Average)"
          sub="Long-term monthly average NIFTY ATM opening straddle premium reflecting macro IV cycles"
          note={dateFilter !== 'all' ? `${dateFilter.toUpperCase()} window` : 'Full timeline'}
          glow="sky"
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={filteredMonthly} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
                <defs>
                  <linearGradient id="premGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.32} />
                    <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis
                  dataKey="month"
                  tick={{ ...monoTick, fontSize: 9 }}
                  axisLine={{ stroke: '#27272a' }}
                  tickLine={false}
                  interval={Math.max(1, Math.floor(filteredMonthly.length / 12))}
                />
                <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={54} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as MonthlyPoint;
                    return (
                      <div className="bg-zinc-950/98 border border-zinc-700/80 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur font-mono">
                        <div className="text-zinc-200 font-bold mb-1.5 font-sans border-b border-zinc-800 pb-1">{d.month}</div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                          <span>Avg Opening</span>
                          <span className="text-sky-300 font-bold">{fmtPremium(d.avg)}</span>
                        </div>
                        <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                          <span>Sessions</span>
                          <span className="text-white font-bold">{d.count}</span>
                        </div>
                      </div>
                    );
                  }}
                  cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                />
                <Area
                  type="monotone"
                  dataKey="avg"
                  name="Avg Premium"
                  stroke={CHART_COLORS.primary}
                  strokeWidth={2.5}
                  fill="url(#premGrad)"
                  activeDot={{ r: 5 }}
                />
                <ReferenceLine
                  y={data.summary.overall_avg}
                  stroke={CHART_COLORS.amber}
                  strokeDasharray="4 3"
                  label={{
                    value: `Historical Mean ₹${data.summary.overall_avg.toFixed(1)}`,
                    fill: '#fbbf24',
                    fontSize: 10,
                    fontWeight: 700,
                    position: 'insideTopRight',
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>

        {/* ── Section 6: Intraday Range & Volatility ─────────────────────────── */}
        <SectionCard
          eyebrow="Intraday Volatility"
          title="Intraday Premium Range & Seller Performance"
          sub="Quantifies the high-to-low swing amplitude of combined CE+PE ATM straddle legs by DTE and weekday"
          glow="violet"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-2 font-bold">
                Avg Session High-Low Swing by DTE
              </p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByDte} barSize={30} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="name" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={50} />
                    <Tooltip content={<QuantChartTooltip formatter={(v, n) => n === 'Range %' ? fmtPct(v) : fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                    <Bar dataKey="avg_range" name="Avg Range" radius={[4, 4, 0, 0]}>
                      {rangeByDte.map((entry, i) => (
                        <Cell key={entry.label} fill={DTE_COLORS[i]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-2 font-bold">
                Avg Session High-Low Swing by Weekday
              </p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByWd} barSize={30} margin={{ top: 8, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="name" tick={{ ...monoTick, fontSize: 9 }} axisLine={{ stroke: '#27272a' }} tickLine={false} />
                    <YAxis tick={monoTick} axisLine={false} tickLine={false} tickFormatter={(v) => `₹${v}`} width={50} />
                    <Tooltip content={<QuantChartTooltip formatter={(v) => fmtPremium(v)} />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
                    <Bar dataKey="avg_range" name="Avg Range" radius={[4, 4, 0, 0]}>
                      {rangeByWd.map((entry) => (
                        <Cell key={entry.fullName} fill={WEEKDAY_COLORS[entry.fullName] ?? CHART_COLORS.primary} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto mt-4 rounded-xl border border-zinc-800">
            <table className="w-full text-xs border-collapse font-mono">
              <thead>
                <tr className="bg-zinc-800">
                  <th className="px-3.5 py-2.5 text-xs font-bold text-white text-left font-sans">
                    DTE Level
                  </th>
                  <th className="px-3.5 py-2.5 text-xs font-bold text-white text-right">Avg Opening</th>
                  <th className="px-3.5 py-2.5 text-xs font-bold text-white text-right">Avg Range</th>
                  <th className="px-3.5 py-2.5 text-xs font-bold text-white text-right">Range / Open</th>
                  <th className="px-3.5 py-2.5 text-xs font-bold text-white text-right text-emerald-400">Seller Win %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {DTE_LABELS.filter((l) => data.range_analysis.by_dte[l] && data.by_dte[l]).map((l, i) => (
                  <tr
                    key={l}
                    className={`${i % 2 === 0 ? 'bg-zinc-900/30' : 'bg-transparent'} hover:bg-zinc-800/40 transition-colors`}
                  >
                    <td className="px-3.5 py-2 text-left font-sans">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full shadow-sm" style={{ background: DTE_COLORS[i] }} />
                        <span className="text-zinc-200 font-semibold">{l} DTE</span>
                      </div>
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums text-zinc-300">
                      {fmtPremium(data.by_dte[l]?.avg)}
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums text-zinc-300">
                      {fmtPremium(data.range_analysis.by_dte[l]?.avg_range)}
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums text-sky-400">
                      {fmtPct(data.range_analysis.by_dte[l]?.avg_range_pct)}
                    </td>
                    <td className="px-3.5 py-2 text-right tabular-nums text-emerald-400 font-bold">
                      {fmtPct(data.range_analysis.by_dte[l]?.seller_win_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* ── Section 7: Key Observations & Insights ────────────────────────── */}
        {data.insights.length > 0 && (
          <SectionCard
            eyebrow="Synthesis"
            title="Statistical Observations & Edge Breakdown"
            sub="Algorithmic observations derived from cross-regime empirical distributions"
            glow="emerald"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {data.insights.map((insight, i) => {
                const isPositive = /seller win|highest seller|won on/i.test(insight);
                const isRisk = /lowest|worst|risk/i.test(insight);

                const cardBorder = isRisk
                  ? 'border-rose-500/30 bg-rose-500/[0.04]'
                  : isPositive
                  ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
                  : 'border-sky-500/30 bg-sky-500/[0.04]';

                const dotColor = isRisk ? 'bg-rose-400' : isPositive ? 'bg-emerald-400' : 'bg-sky-400';
                const tag = isRisk ? 'RISK' : isPositive ? 'EDGE' : 'INFO';
                const tagClass = isRisk
                  ? 'text-rose-400 bg-rose-500/10 border-rose-500/30'
                  : isPositive
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                  : 'text-sky-400 bg-sky-500/10 border-sky-500/30';

                return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 border rounded-xl p-3.5 transition-all duration-200 ${cardBorder}`}
                  >
                    <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded border ${tagClass}`}>
                          {tag}
                        </span>
                      </div>
                      <p className="text-zinc-200 text-xs leading-relaxed font-sans">{insight}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        )}

        {/* ── Footer ────────────────────────────────────────────────────────── */}
        <div className="text-[11px] text-zinc-500 text-center py-4 font-mono border-t border-zinc-800/80 mt-2">
          NIFTY ATM Straddle · 9:15 AM Opening Premium · Database: nifty_options.db · Regime: {regimeLabel}
        </div>
      </div>

      {/* ── Straddle Validity & Intelligence Report Modal ───────────────────── */}
      <StraddleValidityReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        fullData={fullData}
        activeRegime={regime}
      />
    </div>
  );
}
