'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend, Cell,
} from 'recharts';
import NavBar from '@/components/NavBar';

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

// AnalysisData covers one regime's stats
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

interface OffsetData {
  regimes: { all: AnalysisData; pre_sep2025: AnalysisData; post_sep2025: AnalysisData; };
}

interface StrangleFullData {
  generated_at: string;
  regime_cutoff: string;
  [key: string]: OffsetData | string;
}

type RegimeKey = 'all' | 'pre_sep2025' | 'post_sep2025';

// ─── Constants ────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const DTE_LABELS = ['0', '1', '2', '3', '4', '5+'];

const WEEKDAY_COLORS: Record<string, string> = {
  Monday: '#0ea5e9', Tuesday: '#8b5cf6', Wednesday: '#10b981',
  Thursday: '#f59e0b', Friday: '#f43f5e',
};
const DTE_COLORS = ['#f43f5e', '#fb923c', '#f59e0b', '#84cc16', '#22d3ee', '#818cf8'];

const CHART_COLORS = {
  primary:  '#0ea5e9',
  emerald:  '#10b981',
  rose:     '#f43f5e',
  amber:    '#f59e0b',
  violet:   '#8b5cf6',
  band:     '#8b5cf620',
  grid:     '#3f3f46',
  muted:    '#71717a',
};

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

// ─── KPI Tile ─────────────────────────────────────────────────────────────────

function KpiTile({
  label, value, sub, color = 'text-white',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-zinc-800 rounded-lg p-4 flex flex-col gap-1 min-w-0">
      <span className="text-xs text-zinc-500 font-medium uppercase tracking-wide truncate">{label}</span>
      <span className={`text-2xl font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
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
        className="w-4 h-4 rounded-full bg-zinc-700 hover:bg-zinc-500 text-zinc-300 hover:text-white text-[10px] font-bold leading-none flex items-center justify-center transition-colors flex-shrink-0"
        aria-label="More information"
      >
        i
      </button>
      {open && (
        <div
          className="absolute left-6 top-0 z-50 w-80 bg-zinc-900 border border-zinc-600 rounded-xl shadow-2xl p-4 text-xs"
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

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title, children, note, info,
}: {
  title: string; children: React.ReactNode; note?: string;
  info?: { title: string; content: React.ReactNode };
}) {
  return (
    <div className="bg-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-700 flex items-center gap-2">
        <h2 className="text-xs font-bold text-white uppercase tracking-wide">{title}</h2>
        {info && <InfoButton title={info.title}>{info.content}</InfoButton>}
        {note && <span className="text-xs text-zinc-500 ml-auto">{note}</span>}
      </div>
      <div className="p-4">{children}</div>
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
    <div className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs shadow-lg">
      {label && <div className="text-zinc-300 font-semibold mb-1">{label}</div>}
      {visible.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.stroke ?? p.color }} />
          <span className="text-zinc-400">{p.name}:</span>
          <span className="text-white font-medium">
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
    <div className="overflow-x-auto mt-4">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 text-xs font-bold text-white whitespace-nowrap">Segment</th>
            {columns.map((c) => (
              <th key={c.header} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-right ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.key} className={i % 2 === 0 ? 'bg-zinc-800' : 'bg-zinc-850'}>
              <td className="px-3 py-2 whitespace-nowrap">
                <div className="flex items-center gap-2">
                  {r.color && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />}
                  <span className="text-zinc-200">{r.label}</span>
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

export default function StrangleAnalysis() {
  const [fullData, setFullData]   = useState<StrangleFullData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'not_generated' | 'error'>('loading');
  const [regenerating, setRegenerating] = useState(false);
  const [regenProgress, setRegenProgress] = useState(0);
  const [regenMessage, setRegenMessage] = useState('');
  const [dateFilter, setDateFilter] = useState<'all' | '3y' | '2y' | '1y'>('all');
  const [regime, setRegime] = useState<RegimeKey>('all');
  const [selectedOffset, setSelectedOffset] = useState<number>(2);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Derive the active offset and regime's data
  const offsetData = fullData?.[`offset_${selectedOffset}`] as OffsetData | undefined;
  const data: AnalysisData | null = offsetData?.regimes?.[regime] ?? null;

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/strangle-analysis');
      if (res.status === 404) { setLoadState('not_generated'); return; }
      if (!res.ok) { setLoadState('error'); return; }
      const json = await res.json();
      if (json.error) { setLoadState('not_generated'); return; }
      setFullData(json);
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const startRegen = async () => {
    setRegenerating(true);
    setRegenProgress(0);
    setRegenMessage('Starting…');
    await fetch('/api/strangle-analysis', { method: 'POST', body: JSON.stringify({ action: 'regenerate' }) });
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/strangle-analysis/status');
        const s: StatusData = await res.json();
        setRegenProgress(s.pct ?? 0);
        setRegenMessage(s.message ?? '');
        if (s.status === 'done') {
          clearInterval(pollRef.current!);
          setRegenerating(false);
          await fetchData();
        } else if (s.status === 'error') {
          clearInterval(pollRef.current!);
          setRegenerating(false);
          setRegenMessage(`Error: ${s.message}`);
        }
      } catch { /* keep polling */ }
    }, 2000);
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
      <div className="min-h-screen bg-zinc-900">
        <NavBar />
        <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">Loading analysis data…</div>
      </div>
    );
  }

  if (loadState === 'not_generated') {
    return (
      <div className="min-h-screen bg-zinc-900">
        <NavBar />
        <div className="max-w-lg mx-auto mt-24 text-center px-4">
          <div className="bg-zinc-800 rounded-xl p-8">
            <div className="text-4xl mb-4">📊</div>
            <h2 className="text-white text-lg font-bold mb-2">Analysis Not Generated</h2>
            <p className="text-zinc-400 text-sm mb-6">
              Strangle analysis not generated. Click Regenerate to run the script for all offsets (1–10).
            </p>
            {regenerating ? (
              <div className="space-y-2">
                <div className="w-full bg-zinc-700 rounded-full h-2">
                  <div
                    className="bg-sky-500 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${regenProgress}%` }}
                  />
                </div>
                <p className="text-xs text-zinc-400">{regenMessage}</p>
              </div>
            ) : (
              <button
                onClick={startRegen}
                className="px-6 py-2 bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold rounded-lg transition-colors"
              >
                Regenerate
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !fullData || !data) {
    return (
      <div className="min-h-screen bg-zinc-900">
        <NavBar />
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-300">
      <NavBar />

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-zinc-900 border-b border-zinc-800 px-4 py-3">
        <div className="max-w-screen-xl mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-base font-bold text-white">
            ATM+{selectedOffset} / ATM-{selectedOffset} Strangle Premium Analysis
          </h1>
          <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
            NIFTY · Strangle
          </span>
          <span className="text-xs font-mono bg-zinc-800 text-emerald-400 px-2 py-0.5 rounded">
            DATA: {dataDate(fullData.generated_at as string)}
          </span>
          <span className="text-xs text-zinc-500">
            {data.date_range.from} → {data.date_range.to}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Regime toggle */}
            <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
              {([
                { key: 'all',          label: 'All',            title: 'Full history' },
                { key: 'pre_sep2025',  label: 'Pre Sep\'25',    title: 'Before 2025-09-01 · Thu weekly expiry' },
                { key: 'post_sep2025', label: 'Post Sep\'25',   title: 'From 2025-09-01 · Tue weekly expiry' },
              ] as { key: RegimeKey; label: string; title: string }[]).map(({ key, label, title }) => (
                <button
                  key={key}
                  onClick={() => setRegime(key)}
                  title={title}
                  className={`px-3 py-1 font-medium transition-colors whitespace-nowrap ${
                    regime === key
                      ? key === 'pre_sep2025'
                        ? 'bg-amber-600 text-white'
                        : key === 'post_sep2025'
                          ? 'bg-violet-600 text-white'
                          : 'bg-sky-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Regime label chip */}
            {regime !== 'all' && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                regime === 'pre_sep2025'
                  ? 'bg-amber-900 text-amber-300'
                  : 'bg-violet-900 text-violet-300'
              }`}>
                {regime === 'pre_sep2025' ? 'Thu expiry' : 'Tue expiry'}
              </span>
            )}

            {/* Offset selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-400 font-medium">Offset:</span>
              <div className="flex gap-0.5">
                {[1,2,3,4,5,6,7,8,9,10].map((n) => (
                  <button
                    key={n}
                    onClick={() => setSelectedOffset(n)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                      selectedOffset === n
                        ? 'bg-emerald-600 text-white'
                        : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            {/* Date filter */}
            <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
              {(['all', '3y', '2y', '1y'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setDateFilter(f)}
                  className={`px-3 py-1 font-medium transition-colors ${
                    dateFilter === f
                      ? 'bg-sky-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {f === 'all' ? 'All' : f.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Regenerate */}
            {regenerating ? (
              <div className="flex items-center gap-2 min-w-48">
                <div className="flex-1 bg-zinc-700 rounded-full h-1.5">
                  <div
                    className="bg-sky-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${regenProgress}%` }}
                  />
                </div>
                <span className="text-xs text-zinc-400 whitespace-nowrap">{regenProgress}%</span>
              </div>
            ) : (
              <button
                onClick={startRegen}
                className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-md transition-colors"
              >
                Regenerate
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">

        {/* ── Regime banner ─────────────────────────────────────────────────── */}
        {regime !== 'all' && (
          <div className={`rounded-lg px-4 py-2.5 text-xs flex items-center gap-2 ${
            regime === 'pre_sep2025'
              ? 'bg-amber-950 border border-amber-800 text-amber-300'
              : 'bg-violet-950 border border-violet-800 text-violet-300'
          }`}>
            <span className="font-bold">
              {regime === 'pre_sep2025' ? 'Pre-Sep 2025 Regime' : 'Post-Sep 2025 Regime'}
            </span>
            <span className="text-zinc-400">—</span>
            <span>
              {regime === 'pre_sep2025'
                ? 'NSE weekly Nifty expiry was on Thursday. Data covers the period before the SEBI-mandated change on 2025-09-01.'
                : 'NSE moved the weekly Nifty expiry to Tuesday effective 2025-09-01. This is a shorter dataset — patterns may stabilise as more data accumulates.'}
            </span>
          </div>
        )}

        {/* ── Section 1: KPI Row ────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiTile
            label="Trading Days Analyzed"
            value={fmtCount(data.total_days)}
            sub={`${data.total_expiries} expiries · ${data.date_range.from.slice(0, 7)} to ${data.date_range.to.slice(0, 7)}`}
          />
          <KpiTile
            label="Avg Opening Premium"
            value={fmtPremium(data.summary.overall_avg)}
            sub={`Median ${fmtPremium(data.summary.overall_median)}`}
          />
          <KpiTile
            label="Highest Opening Premium"
            value={fmtPremium(data.summary.overall_max)}
            color="text-rose-400"
          />
          <KpiTile
            label="Lowest Opening Premium"
            value={fmtPremium(data.summary.overall_min)}
            color="text-emerald-400"
          />
          <KpiTile
            label="Seller Win Rate"
            value={fmtPct(data.summary.seller_win_pct)}
            sub={`Avg daily decay ${fmtPct(data.summary.avg_daily_decay_pct)}`}
            color="text-emerald-400"
          />
        </div>

        {/* ── Section 2: Weekday Analysis ───────────────────────────────────── */}
        <Section title="Opening Premium by Weekday" note={regime === 'all' ? 'Full history' : regime === 'pre_sep2025' ? 'Pre Sep 2025 (Thu expiry)' : 'Post Sep 2025 (Tue expiry)'} info={{
          title: 'Opening Premium by Weekday',
          content: (
            <>
              <p>Shows the average NIFTY ATM+{selectedOffset}/ATM-{selectedOffset} strangle premium at 9:15 AM grouped by the day of the week, calculated over all historical trading days.</p>
              <p className="mt-1 font-semibold text-zinc-200">What to look for:</p>
              <ul className="list-disc list-inside space-y-1 text-zinc-400">
                <li>Higher premium days = more theta collected if you sell at open.</li>
                <li>Error bars (dashed line = overall avg) let you spot which day is structurally rich or cheap.</li>
                <li><span className="text-emerald-400">Seller Win%</span> in the table tells you on what % of that weekday's sessions the strangle closed below the open — the seller's edge per day.</li>
              </ul>
              <p className="mt-1 text-zinc-500">Premium reflects both IV and spot movement risk; higher premium on a particular day doesn't always mean more edge — check Seller Win% alongside.</p>
            </>
          ),
        }}>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdayChartData} barSize={36} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} />
                <Bar dataKey="avg" name="Avg Premium" radius={[4, 4, 0, 0]}>
                  {weekdayChartData.map((entry) => (
                    <Cell key={entry.fullName} fill={WEEKDAY_COLORS[entry.fullName] ?? CHART_COLORS.primary} />
                  ))}
                </Bar>
                <ReferenceLine y={data.summary.overall_avg} stroke={CHART_COLORS.amber} strokeDasharray="4 3"
                  label={{ value: 'Overall Avg', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
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

        {/* ── Section 3: DTE Analysis ───────────────────────────────────────── */}
        <Section title="Opening Premium by Days to Expiry (DTE)" note={regime === 'all' ? 'Full history' : regime === 'pre_sep2025' ? 'Pre Sep 2025 (Thu expiry)' : 'Post Sep 2025 (Tue expiry)'} info={{
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
        }}>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dteChartData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} />
                {/* Band fill — hidden from tooltip (name starts with _) */}
                <Area type="monotone" dataKey="p75" name="_band_top" fill="#8b5cf618" stroke="none" legendType="none" />
                <Area type="monotone" dataKey="p25" name="_band_bot" fill="#27272a" stroke="none" legendType="none" />
                {/* Visible P25 / P75 lines */}
                <Line type="monotone" dataKey="p75" name="P75" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="p25" name="P25" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                <Line type="monotone" dataKey="avg" name="Avg Premium" stroke={CHART_COLORS.primary}
                  strokeWidth={2} dot={{ r: 5, fill: CHART_COLORS.primary, strokeWidth: 0 }} />
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

        {/* ── Section 4: Distribution ───────────────────────────────────────── */}
        <Section title="Premium Distribution (All Days)" info={{
          title: 'Premium Distribution',
          content: (
            <>
              <p>A histogram of all opening strangle premiums across the full dataset. Each bar = number of trading days where the 9:15 AM premium fell in that ₹ bucket. The amber curve is a fitted normal distribution.</p>
              <p className="mt-1 font-semibold text-zinc-200">How to read the stats:</p>
              <ul className="list-disc list-inside space-y-1 text-zinc-400">
                <li><strong className="text-zinc-300">Skew &gt; 0</strong> means a right tail — rare days with very high IV (elections, budget, global events) pull the average above the median.</li>
                <li><strong className="text-zinc-300">P10/P90</strong> define the "normal" range. Premiums outside this are statistical outliers worth investigating.</li>
                <li>If the histogram is left of the normal curve, recent premiums have been compressing (IV regime shift).</li>
              </ul>
              <p className="mt-1 text-zinc-500">Use P25 and P75 as benchmarks: a premium near P25 suggests a "cheap" day to sell; near P75 is a "rich" day.</p>
            </>
          ),
        }}>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={normalData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="bin" tick={{ fill: '#a1a1aa', fontSize: 10 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} interval={3} />
                <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs shadow-lg">
                        <div className="text-zinc-300 font-semibold mb-1">{d.binLabel}</div>
                        <div className="text-zinc-400">Days: <span className="text-white">{d.count}</span></div>
                        <div className="text-zinc-400">Normal curve: <span className="text-white">{d.normal}</span></div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="count" name="Days" fill={CHART_COLORS.primary} fillOpacity={0.7} radius={[2, 2, 0, 0]} barSize={14} />
                <Line type="monotone" dataKey="normal" name="Normal" stroke={CHART_COLORS.amber}
                  strokeWidth={2} dot={false} />
                <ReferenceLine x={Math.round(data.distribution.mean)} stroke={CHART_COLORS.rose} strokeDasharray="4 3"
                  label={{ value: 'Mean', fill: '#f43f5e', fontSize: 10, position: 'insideTopRight' }} />
                <ReferenceLine x={Math.round(data.distribution.median)} stroke={CHART_COLORS.emerald} strokeDasharray="4 3"
                  label={{ value: 'Median', fill: '#10b981', fontSize: 10, position: 'insideTopLeft' }} />
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
              <div key={s.label} className="bg-zinc-900 rounded px-3 py-2 text-center">
                <div className="text-xs text-zinc-500 mb-0.5">{s.label}</div>
                <div className="text-sm font-semibold text-white tabular-nums">{s.value}</div>
              </div>
            ))}
          </div>
        </Section>

        {/* ── Section 5: Decay Analysis ─────────────────────────────────────── */}
        <Section title="Decay Analysis" info={{
          title: 'Decay Analysis — Two Views',
          content: (
            <>
              <p className="font-semibold text-zinc-200">Left — Day-over-Day DTE Curve:</p>
              <p className="text-zinc-400">Shows the average opening premium for each DTE (5+ → 0). This is the theta decay curve: how much premium exists at market open as expiry approaches. The shaded band is P25–P75.</p>
              <p className="mt-2 font-semibold text-zinc-200">Right — Intraday Decay Curves:</p>
              <p className="text-zinc-400">Shows how the strangle premium bleeds from 9:15 AM to 3:30 PM on an average day, split by DTE bucket. Each line is the average across all days in that bucket.</p>
              <ul className="list-disc list-inside space-y-1 text-zinc-400 mt-1">
                <li>Steeper slope = faster intraday theta burn.</li>
                <li>0 DTE line drops fastest — all time value must collapse by 3:30 PM.</li>
                <li>Crossovers between lines reveal periods where higher-DTE strangles temporarily become cheaper intraday.</li>
              </ul>
              <p className="mt-1 text-zinc-500">Combine both charts: sell at a DTE where opening premium is rich AND intraday decay is fast.</p>
            </>
          ),
        }}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* DTE decay curve */}
            <div>
              <p className="text-xs text-zinc-400 mb-3 font-medium">Day-over-Day: Avg Opening Premium by DTE</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dteCurveData} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                      label={{ value: 'DTE', position: 'insideBottom', offset: -2, fill: '#71717a', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} />
                    {/* Band fill — hidden from tooltip */}
                    <Area type="monotone" dataKey="p75" name="_band_top" fill="#8b5cf618" stroke="none" legendType="none" />
                    <Area type="monotone" dataKey="p25" name="_band_bot" fill="#27272a" stroke="none" legendType="none" />
                    {/* Visible P25 / P75 lines */}
                    <Line type="monotone" dataKey="p75" name="P75" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line type="monotone" dataKey="p25" name="P25" stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                    <Line type="monotone" dataKey="avg" name="Avg" stroke={CHART_COLORS.primary}
                      strokeWidth={2.5} dot={{ r: 5, fill: CHART_COLORS.primary, strokeWidth: 0 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Intraday decay by DTE bucket */}
            <div>
              <p className="text-xs text-zinc-400 mb-3 font-medium">Intraday: Average Strangle Premium Curve by DTE</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                    <XAxis dataKey="time" type="category" allowDuplicatedCategory={false}
                      tick={{ fill: '#a1a1aa', fontSize: 9 }} axisLine={false} tickLine={false} interval={11} />
                    <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={52} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
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

        {/* ── Section 6: Trend Over Time ────────────────────────────────────── */}
        <Section
          title="Premium Trend Over Time (Monthly Avg)"
          note={dateFilter !== 'all' ? `${dateFilter.toUpperCase()} filter applied` : 'Full history'}
          info={{
            title: 'Premium Trend Over Time',
            content: (
              <>
                <p>Plots the monthly average NIFTY ATM+{selectedOffset}/ATM-{selectedOffset} opening strangle premium from Dec 2020 to present. Each point = average across all trading days in that month, regardless of DTE or weekday.</p>
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
                    <stop offset="5%"  stopColor={CHART_COLORS.primary} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#a1a1aa', fontSize: 10 }} axisLine={false} tickLine={false}
                  interval={Math.floor(filteredMonthly.length / 12)} />
                <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={(v) => `₹${v}`} width={52} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as MonthlyPoint;
                    return (
                      <div className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs shadow-lg">
                        <div className="text-zinc-300 font-semibold mb-1">{d.month}</div>
                        <div className="text-zinc-400">Avg Premium: <span className="text-white">{fmtPremium(d.avg)}</span></div>
                        <div className="text-zinc-400">Days: <span className="text-white">{d.count}</span></div>
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="avg" name="Avg Premium"
                  stroke={CHART_COLORS.primary} strokeWidth={2} fill="url(#premGrad)" />
                <ReferenceLine y={data.summary.overall_avg} stroke={CHART_COLORS.amber} strokeDasharray="4 3"
                  label={{ value: 'Overall Avg', fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>

        {/* ── Section 7: Range & Seller Performance ─────────────────────────── */}
        <Section title="Intraday Range Analysis" info={{
          title: 'Intraday Range Analysis',
          content: (
            <>
              <p>Measures the typical <strong className="text-zinc-200">day range</strong> of the strangle — the spread between the session high and low of the combined CE+PE premium.</p>
              <p className="mt-1 font-semibold text-zinc-200">Key metrics:</p>
              <ul className="list-disc list-inside space-y-1 text-zinc-400">
                <li><strong className="text-zinc-300">Avg Range</strong> — how many ₹ the strangle typically moves intraday. A wider range means more opportunity (and risk) for adjustments.</li>
                <li><strong className="text-zinc-300">Range / Open %</strong> — range as a percentage of the opening premium. E.g. 40% means the strangle can move ₹40 on a ₹100 opening. This is the "efficiency" measure — how actively the strangle moves relative to its starting value.</li>
                <li><span className="text-emerald-400">Seller Win%</span> — on what % of days at this DTE does the strangle close below open (seller keeps premium).</li>
              </ul>
              <p className="mt-1 text-zinc-500">Note: Day high/low are computed as CE_high + PE_high and CE_low + PE_low per candle — a slight overestimate since legs don't always peak simultaneously.</p>
            </>
          ),
        }}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Range by DTE */}
            <div>
              <p className="text-xs text-zinc-400 mb-3 font-medium">Avg Day Range by DTE</p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByDte} barSize={28} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={48} />
                    <Tooltip content={<ChartTooltip formatter={(v, n) => n === 'Range %' ? fmtPct(v) : fmtPremium(v)} />} />
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
              <p className="text-xs text-zinc-400 mb-3 font-medium">Avg Day Range by Weekday</p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rangeByWd} barSize={28} margin={{ top: 4, right: 12, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
                      tickFormatter={(v) => `₹${v}`} width={48} />
                    <Tooltip content={<ChartTooltip formatter={(v) => fmtPremium(v)} />} />
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
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-800">
                  {['DTE', 'Avg Opening', 'Avg Range', 'Range / Open', 'Seller Win%'].map((h) => (
                    <th key={h} className="px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-right first:text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DTE_LABELS.filter((l) => data.range_analysis.by_dte[l] && data.by_dte[l]).map((l, i) => (
                  <tr key={l} className={i % 2 === 0 ? 'bg-zinc-800' : ''}>
                    <td className="px-3 py-2 text-left">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: DTE_COLORS[i] }} />
                        <span className="text-zinc-200">{l} DTE</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPremium(data.by_dte[l]?.avg)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPremium(data.range_analysis.by_dte[l]?.avg_range)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{fmtPct(data.range_analysis.by_dte[l]?.avg_range_pct)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400">{fmtPct(data.range_analysis.by_dte[l]?.seller_win_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── Section 8: Insights ───────────────────────────────────────────── */}
        {data.insights.length > 0 && (
          <Section title="Key Observations" info={{
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
                <p className="mt-1 text-zinc-500">Insights are recalculated each time you regenerate the analysis. Add new data by running <span className="font-mono text-zinc-300">strangle_premium_analysis.py</span> again.</p>
              </>
            ),
          }}>
            <ul className="space-y-2">
              {data.insights.map((insight, i) => {
                const isPositive = /seller win|highest seller|won on/i.test(insight);
                const isRisk     = /lowest|worst|risk/i.test(insight);
                const dot = isRisk ? 'bg-rose-400' : isPositive ? 'bg-emerald-400' : 'bg-sky-400';
                return (
                  <li key={i} className="flex items-start gap-3 bg-zinc-900 rounded-md px-3 py-2.5">
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                    <span className="text-zinc-300 text-sm leading-relaxed">{insight}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        <div className="text-xs text-zinc-600 text-center pb-4">
          NIFTY ATM+{selectedOffset}/ATM-{selectedOffset} strangle · 9:15 AM opening premium · Source: nifty_options.db ·{' '}
          Day high/low are proxies (CE high + PE high per candle)
        </div>
      </div>
    </div>
  );
}
