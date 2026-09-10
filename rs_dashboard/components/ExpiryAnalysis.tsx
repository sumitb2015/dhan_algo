'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  ComposedChart,
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  Line,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import type { WeeklyBucket, DailyStats, DailyRow } from '@/app/api/expiry-analysis/route';
import { cachedFetch } from '@/lib/clientCache';
import NavBar from './NavBar';

// ─── Nifty 50 constituents + index ────────────────────────────────────────────
const SYMBOL_OPTIONS: { value: string; label: string; group: string }[] = [
  { value: 'NIFTY50',      label: 'Nifty 50 Index',  group: 'Index' },
  { value: 'ADANIENT',     label: 'Adani Enterprises', group: 'Nifty 50 Stocks' },
  { value: 'ADANIPORTS',   label: 'Adani Ports',       group: 'Nifty 50 Stocks' },
  { value: 'APOLLOHOSP',   label: 'Apollo Hospitals',  group: 'Nifty 50 Stocks' },
  { value: 'ASIANPAINT',   label: 'Asian Paints',      group: 'Nifty 50 Stocks' },
  { value: 'AXISBANK',     label: 'Axis Bank',         group: 'Nifty 50 Stocks' },
  { value: 'BAJAJ-AUTO',   label: 'Bajaj Auto',        group: 'Nifty 50 Stocks' },
  { value: 'BAJAJFINSV',   label: 'Bajaj Finserv',     group: 'Nifty 50 Stocks' },
  { value: 'BAJFINANCE',   label: 'Bajaj Finance',     group: 'Nifty 50 Stocks' },
  { value: 'BHARTIARTL',   label: 'Bharti Airtel',     group: 'Nifty 50 Stocks' },
  { value: 'BPCL',         label: 'BPCL',              group: 'Nifty 50 Stocks' },
  { value: 'BRITANNIA',    label: 'Britannia',         group: 'Nifty 50 Stocks' },
  { value: 'CIPLA',        label: 'Cipla',             group: 'Nifty 50 Stocks' },
  { value: 'COALINDIA',    label: 'Coal India',        group: 'Nifty 50 Stocks' },
  { value: 'DIVISLAB',     label: "Divi's Labs",       group: 'Nifty 50 Stocks' },
  { value: 'DRREDDY',      label: 'Dr. Reddy\'s',      group: 'Nifty 50 Stocks' },
  { value: 'EICHERMOT',    label: 'Eicher Motors',     group: 'Nifty 50 Stocks' },
  { value: 'ETERNAL',      label: 'Eternal (Zomato)',  group: 'Nifty 50 Stocks' },
  { value: 'GRASIM',       label: 'Grasim',            group: 'Nifty 50 Stocks' },
  { value: 'HCLTECH',      label: 'HCL Tech',          group: 'Nifty 50 Stocks' },
  { value: 'HDFCBANK',     label: 'HDFC Bank',         group: 'Nifty 50 Stocks' },
  { value: 'HDFCLIFE',     label: 'HDFC Life',         group: 'Nifty 50 Stocks' },
  { value: 'HEROMOTOCO',   label: 'Hero MotoCorp',     group: 'Nifty 50 Stocks' },
  { value: 'HINDALCO',     label: 'Hindalco',          group: 'Nifty 50 Stocks' },
  { value: 'HINDUNILVR',   label: 'HUL',               group: 'Nifty 50 Stocks' },
  { value: 'ICICIBANK',    label: 'ICICI Bank',        group: 'Nifty 50 Stocks' },
  { value: 'INDUSINDBK',   label: 'IndusInd Bank',     group: 'Nifty 50 Stocks' },
  { value: 'INFY',         label: 'Infosys',           group: 'Nifty 50 Stocks' },
  { value: 'ITC',          label: 'ITC',               group: 'Nifty 50 Stocks' },
  { value: 'JSWSTEEL',     label: 'JSW Steel',         group: 'Nifty 50 Stocks' },
  { value: 'KOTAKBANK',    label: 'Kotak Bank',        group: 'Nifty 50 Stocks' },
  { value: 'LT',           label: 'L&T',               group: 'Nifty 50 Stocks' },
  { value: 'M&M',          label: 'M&M',               group: 'Nifty 50 Stocks' },
  { value: 'MARUTI',       label: 'Maruti Suzuki',     group: 'Nifty 50 Stocks' },
  { value: 'NESTLEIND',    label: 'Nestle India',      group: 'Nifty 50 Stocks' },
  { value: 'NTPC',         label: 'NTPC',              group: 'Nifty 50 Stocks' },
  { value: 'ONGC',         label: 'ONGC',              group: 'Nifty 50 Stocks' },
  { value: 'POWERGRID',    label: 'Power Grid',        group: 'Nifty 50 Stocks' },
  { value: 'RELIANCE',     label: 'Reliance',          group: 'Nifty 50 Stocks' },
  { value: 'SBILIFE',      label: 'SBI Life',          group: 'Nifty 50 Stocks' },
  { value: 'SBIN',         label: 'SBI',               group: 'Nifty 50 Stocks' },
  { value: 'SHRIRAMFIN',   label: 'Shriram Finance',   group: 'Nifty 50 Stocks' },
  { value: 'SUNPHARMA',    label: 'Sun Pharma',        group: 'Nifty 50 Stocks' },
  { value: 'TATACONSUM',   label: 'Tata Consumer',     group: 'Nifty 50 Stocks' },
  { value: 'TATAMOTORS',   label: 'Tata Motors',       group: 'Nifty 50 Stocks' },
  { value: 'TATASTEEL',    label: 'Tata Steel',        group: 'Nifty 50 Stocks' },
  { value: 'TCS',          label: 'TCS',               group: 'Nifty 50 Stocks' },
  { value: 'TECHM',        label: 'Tech Mahindra',     group: 'Nifty 50 Stocks' },
  { value: 'TITAN',        label: 'Titan',             group: 'Nifty 50 Stocks' },
  { value: 'TRENT',        label: 'Trent',             group: 'Nifty 50 Stocks' },
  { value: 'ULTRACEMCO',   label: 'UltraTech Cement',  group: 'Nifty 50 Stocks' },
  { value: 'WIPRO',        label: 'Wipro',             group: 'Nifty 50 Stocks' },
];

// ─── Return range buckets ─────────────────────────────────────────────────────
const RETURN_BUCKETS = [
  { label: '>5%',            min: 5,         max: Infinity, color: '#00ff88' },
  { label: '4.5% to 5.0%',  min: 4.5,       max: 5,        color: '#22d86e' },
  { label: '4.0% to 4.5%',  min: 4,         max: 4.5,      color: '#4ade80' },
  { label: '3.5% to 4.0%',  min: 3.5,       max: 4,        color: '#86efac' },
  { label: '3.0% to 3.5%',  min: 3,         max: 3.5,      color: '#bbf7d0' },
  { label: '2.0% to 3.0%',  min: 2,         max: 3,        color: '#d1fae5' },
  { label: '1.0% to 2.0%',  min: 1,         max: 2,        color: '#ecfdf5' },
  { label: '0.0% to 1.0%',  min: 0,         max: 1,        color: '#f4f4f5' },
  { label: '-1.0% to 0.0%', min: -1,        max: 0,        color: '#fef9c3' },
  { label: '-2.0% to -1.0%',min: -2,        max: -1,       color: '#fed7aa' },
  { label: '-3.0% to -2.0%',min: -3,        max: -2,       color: '#fca5a5' },
  { label: '-3.5% to -3.0%',min: -3.5,      max: -3,       color: '#f87171' },
  { label: '-4.0% to -3.5%',min: -4,        max: -3.5,     color: '#ef4444' },
  { label: '-4.5% to -4.0%',min: -4.5,      max: -4,       color: '#dc2626' },
  { label: '-5.0% to -4.5%',min: -5,        max: -4.5,     color: '#b91c1c' },
  { label: '<-5%',           min: -Infinity, max: -5,       color: '#7f1d1d' },
] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function fmtINRInt(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

interface ClassifiedBucket extends WeeklyBucket {
  endTimestamp: number;
  status: 'within' | 'upside' | 'downside';
}

interface ScatterPoint {
  x: number;
  y: number;
  startDate: string;
  endDate: string;
  returnPct: number;
  status: 'within' | 'upside' | 'downside';
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoYearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

function computeBoundaries(
  returnPcts: number[],
  probability: number,
): { lower: number; upper: number } {
  if (returnPcts.length === 0) return { lower: 0, upper: 0 };
  const sorted = [...returnPcts].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 4) return { lower: sorted[0], upper: sorted[n - 1] };
  const tail = (1 - probability) / 2;
  const lowerIdx = Math.max(0, Math.floor(tail * n));
  const upperIdx = Math.min(n - 1, n - 1 - lowerIdx);
  return { lower: sorted[lowerIdx], upper: sorted[upperIdx] };
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Info button (click-to-open popup) ───────────────────────────────────────

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
          className="absolute left-6 top-0 z-50 w-80 bg-zinc-800 border border-zinc-600 rounded-xl shadow-2xl p-4 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between mb-2">
            <span className="font-bold text-white text-sm leading-tight">{title}</span>
            <button
              onClick={() => setOpen(false)}
              className="text-zinc-500 hover:text-white ml-2 leading-none flex-shrink-0"
            >✕</button>
          </div>
          <div className="text-zinc-300 leading-relaxed space-y-1.5">{children}</div>
        </div>
      )}
    </div>
  );
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScatterPoint }[] }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const color =
    d.status === 'upside' ? '#34d399' : d.status === 'downside' ? '#f87171' : '#a1a1aa';
  const signChar = d.returnPct >= 0 ? '+' : '';
  const label =
    d.status === 'within' ? 'Within boundary' : d.status + ' outlier';
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <div className="text-zinc-400 mb-1">
        {fmtDate(d.startDate)} → {fmtDate(d.endDate)}
      </div>
      <div style={{ color }} className="font-mono font-bold text-sm">
        {signChar}{d.returnPct.toFixed(2)}%
      </div>
      <div className="text-zinc-500 capitalize mt-0.5">{label}</div>
    </div>
  );
}

// ─── Dot shapes ───────────────────────────────────────────────────────────────

function SmallDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={3.5} fill="#a1a1aa" opacity={1} />;
}
function GreenDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={6} fill="#00ffaa" filter="url(#glow-green)" />;
}
function RedDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={6} fill="#ff4444" filter="url(#glow-red)" />;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ExpiryAnalysis() {
  const [weeks, setWeeks] = useState<WeeklyBucket[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStats | null>(null);
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataStart, setDataStart] = useState('');
  const [dataEnd, setDataEnd] = useState('');

  const [symbol, setSymbol] = useState('NIFTY50');
  const [startDate, setStartDate] = useState(isoYearsAgo(5));
  const [endDate, setEndDate] = useState(isoToday);

  const [probability, setProbability] = useState(95);
  const [maWindow, setMaWindow] = useState(20);
  const [showMA, setShowMA]     = useState(true);

  const selectedOption = SYMBOL_OPTIONS.find((o) => o.value === symbol) ?? SYMBOL_OPTIONS[0];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    cachedFetch<Record<string, any>>(
      `/api/expiry-analysis?symbol=${encodeURIComponent(symbol)}&startDate=${startDate}&endDate=${endDate}`,
      5 * 60_000,
    )
      .then((data) => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setWeeks(data.weeks ?? []);
        setDailyStats(data.dailyStats ?? null);
        setDailyRows(data.dailyRows ?? []);
        setDataStart(data.dataStart ?? '');
        setDataEnd(data.dataEnd ?? '');
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [symbol, startDate, endDate]);

  const { lower, upper, withinData, upsideData, downsideData, outliers } = useMemo(() => {
    const { lower, upper } = computeBoundaries(
      weeks.map((w) => w.returnPct),
      probability / 100,
    );

    const classified: ClassifiedBucket[] = weeks.map((w) => ({
      ...w,
      endTimestamp: new Date(w.endDate + 'T00:00:00Z').getTime(),
      status:
        w.returnPct < lower ? 'downside' : w.returnPct > upper ? 'upside' : 'within',
    }));

    const toPoint = (c: ClassifiedBucket): ScatterPoint => ({
      x: c.endTimestamp,
      y: c.returnPct,
      startDate: c.startDate,
      endDate: c.endDate,
      returnPct: c.returnPct,
      status: c.status,
    });

    const withinData  = classified.filter((c) => c.status === 'within').map(toPoint);
    const upsideData  = classified.filter((c) => c.status === 'upside').map(toPoint);
    const downsideData = classified.filter((c) => c.status === 'downside').map(toPoint);
    const outliers = classified
      .filter((c) => c.status !== 'within')
      .sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct));

    return { lower, upper, withinData, upsideData, downsideData, outliers };
  }, [weeks, probability]);

  // ─── Distribution buckets (empirical) ─────────────────────────────────────
  const distributionBuckets = useMemo(() => {
    if (weeks.length === 0) return [];
    const returns = weeks.map((w) => w.returnPct);
    const total = returns.length;
    const latestClose = dailyStats?.latestClose ?? 0;

    return RETURN_BUCKETS.map((bucket) => {
      const isTopBucket = bucket.max === Infinity;
      const isBottomBucket = bucket.min === -Infinity;

      const count = returns.filter((r) => {
        const aboveMin = isBottomBucket ? true : r >= bucket.min;
        const belowMax = isTopBucket   ? true : r < bucket.max;
        return aboveMin && belowMax;
      }).length;

      const pctOfTotal = total > 0 ? (count / total) * 100 : 0;

      // Cumulative counts from extremes
      const countAboveMax = isTopBucket ? 0 : returns.filter((r) => r >= bucket.max).length;
      const countAboveMin = isBottomBucket ? total : returns.filter((r) => r >= bucket.min).length;
      const countBelowMin = isBottomBucket ? 0 : returns.filter((r) => r < bucket.min).length;
      const countBelowMax = isTopBucket ? total : returns.filter((r) => r < bucket.max).length;

      // Percentile range strings
      let percentileRange: string;
      let probability: string;

      if (isTopBucket) {
        const pTop = (count / total) * 100;
        percentileRange = `Top ${pTop.toFixed(1)}%`;
        probability = `${((total - count) / total * 100).toFixed(1)}%`;
      } else if (isBottomBucket) {
        const pBot = (count / total) * 100;
        percentileRange = `Bottom ${pBot.toFixed(1)}%`;
        probability = `${((total - count) / total * 100).toFixed(1)}%`;
      } else if (bucket.min >= 0) {
        // Positive bucket — measure from top
        const pUpper = (countAboveMax / total) * 100;
        const pLower = (countAboveMin / total) * 100;
        percentileRange = `${pUpper.toFixed(1)}%–${pLower.toFixed(1)}% from top`;
        // Probability range: P(X < lower_bound) to P(X < upper_bound)
        const probLow = (countBelowMin / total) * 100;
        const probHigh = (countBelowMax / total) * 100;
        probability = `${probLow.toFixed(1)}%–${probHigh.toFixed(1)}%`;
      } else {
        // Negative bucket — measure from bottom
        const pUpper = (countBelowMax / total) * 100;
        const pLower = (countBelowMin / total) * 100;
        percentileRange = `${pLower.toFixed(1)}%–${pUpper.toFixed(1)}% from bottom`;
        const probLow = ((total - countBelowMax) / total) * 100;
        const probHigh = ((total - countBelowMin) / total) * 100;
        probability = `${probLow.toFixed(1)}%–${probHigh.toFixed(1)}%`;
      }

      // Price range
      let priceRange: string;
      if (isTopBucket && latestClose > 0) {
        priceRange = `>${fmtINRInt(Math.round(latestClose * (1 + bucket.min / 100)))}`;
      } else if (isBottomBucket && latestClose > 0) {
        priceRange = `<${fmtINRInt(Math.round(latestClose * (1 + bucket.max / 100)))}`;
      } else if (latestClose > 0) {
        const lo = Math.round(latestClose * (1 + bucket.min / 100));
        const hi = Math.round(latestClose * (1 + bucket.max / 100));
        const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
        priceRange = `${fmtINRInt(a)} – ${fmtINRInt(b)}`;
      } else {
        priceRange = '—';
      }

      return { ...bucket, count, pctOfTotal, percentileRange, probability, priceRange };
    });
  }, [weeks, dailyStats]);

  // ─── Weekly returns summary stats + composite chart data ──────────────────
  const weeklyAnalysis = useMemo(() => {
    if (weeks.length === 0) return null;
    const returns = weeks.map((w) => w.returnPct);
    const n = returns.length;
    const posReturns = returns.filter((r) => r > 0);
    const negReturns = returns.filter((r) => r < 0);

    const avg = returns.reduce((a, b) => a + b, 0) / n;
    const variance = returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (n - 1);
    const std = Math.sqrt(variance);

    const downsideVar = negReturns.length > 1
      ? negReturns.reduce((s, r) => s + r * r, 0) / negReturns.length : 0;
    const downsideStd = Math.sqrt(downsideVar);

    const sumPos = posReturns.reduce((a, b) => a + b, 0);
    const sumNeg = Math.abs(negReturns.reduce((a, b) => a + b, 0));

    // Chart data with rolling MA
    const chartData = weeks.map((w, i) => {
      let ma: number | null = null;
      if (i >= maWindow - 1) {
        const slice = returns.slice(i - maWindow + 1, i + 1);
        ma = slice.reduce((a, b) => a + b, 0) / maWindow;
      }
      return {
        index: i,
        endDate: w.endDate,
        returnPct: Math.round(w.returnPct * 100) / 100,
        ma: ma !== null ? Math.round(ma * 10000) / 10000 : null,
        positive: w.returnPct >= 0,
      };
    });

    return {
      avgReturn:     Math.round(avg * 10000) / 10000,
      std:           Math.round(std * 10000) / 10000,
      sharpe:        std > 0 ? Math.round((avg / std) * 100) / 100 : 0,
      sortino:       downsideStd > 0 ? Math.round((avg / downsideStd) * 100) / 100 : 0,
      profitFactor:  sumNeg > 0 ? Math.round((sumPos / sumNeg) * 100) / 100 : Infinity,
      maxGain:       Math.round(Math.max(...returns) * 100) / 100,
      maxLoss:       Math.round(Math.min(...returns) * 100) / 100,
      positiveCount: posReturns.length,
      negativeCount: negReturns.length,
      total:         n,
      chartData,
    };
  }, [weeks, maWindow]);

  // ─── Streak analysis ──────────────────────────────────────────────────────
  const streakAnalysis = useMemo(() => {
    if (weeks.length === 0) return null;

    interface Streak {
      type: 'Positive' | 'Negative';
      length: number;
      startDate: string;
      endDate: string;
      startPrice: number;
      endPrice: number;
      totalReturnPct: number;
      avgWeeklyReturnPct: number;
      endTimestamp: number;
    }

    const streaks: Streak[] = [];
    let cur: { type: 'Positive' | 'Negative'; ws: WeeklyBucket[] } | null = null;
    let neutralCount = 0;

    for (const w of weeks) {
      if (w.returnPct === 0) { neutralCount++; continue; }
      const type: 'Positive' | 'Negative' = w.returnPct > 0 ? 'Positive' : 'Negative';
      if (!cur || cur.type !== type) {
        if (cur && cur.ws.length > 0) {
          const first = cur.ws[0];
          const last  = cur.ws[cur.ws.length - 1];
          const totalRet = ((last.endClose - first.startOpen) / first.startOpen) * 100;
          streaks.push({
            type: cur.type,
            length: cur.ws.length,
            startDate: first.startDate,
            endDate: last.endDate,
            startPrice: first.startOpen,
            endPrice: last.endClose,
            totalReturnPct: Math.round(totalRet * 100) / 100,
            avgWeeklyReturnPct: Math.round(cur.ws.reduce((a, w2) => a + w2.returnPct, 0) / cur.ws.length * 100) / 100,
            endTimestamp: new Date(last.endDate + 'T00:00:00Z').getTime(),
          });
        }
        cur = { type, ws: [w] };
      } else {
        cur.ws.push(w);
      }
    }
    if (cur && cur.ws.length > 0) {
      const first = cur.ws[0];
      const last  = cur.ws[cur.ws.length - 1];
      const totalRet = ((last.endClose - first.startOpen) / first.startOpen) * 100;
      streaks.push({
        type: cur.type,
        length: cur.ws.length,
        startDate: first.startDate,
        endDate: last.endDate,
        startPrice: first.startOpen,
        endPrice: last.endClose,
        totalReturnPct: Math.round(totalRet * 100) / 100,
        avgWeeklyReturnPct: Math.round(cur.ws.reduce((a, w2) => a + w2.returnPct, 0) / cur.ws.length * 100) / 100,
        endTimestamp: new Date(last.endDate + 'T00:00:00Z').getTime(),
      });
    }

    const posStreaks = streaks.filter((s) => s.type === 'Positive');
    const negStreaks = streaks.filter((s) => s.type === 'Negative');

    const longestPos = posStreaks.length ? Math.max(...posStreaks.map((s) => s.length)) : 0;
    const longestNeg = negStreaks.length ? Math.max(...negStreaks.map((s) => s.length)) : 0;
    const bestPosReturn  = posStreaks.length ? Math.max(...posStreaks.map((s) => s.totalReturnPct)) : 0;
    const worstNegReturn = negStreaks.length ? Math.min(...negStreaks.map((s) => s.totalReturnPct)) : 0;
    const avgPosLength   = posStreaks.length ? posStreaks.reduce((a, s) => a + s.length, 0) / posStreaks.length : 0;
    const avgNegLength   = negStreaks.length ? negStreaks.reduce((a, s) => a + s.length, 0) / negStreaks.length : 0;

    const currentStreak = streaks[streaks.length - 1] ?? null;

    // Scatter data
    const posScatter = posStreaks.map((s) => ({ x: s.endTimestamp, y: s.length, r: Math.abs(s.totalReturnPct), ...s }));
    const negScatter = negStreaks.map((s) => ({ x: s.endTimestamp, y: s.length, r: Math.abs(s.totalReturnPct), ...s }));

    return {
      streaks, posScatter, negScatter, neutralCount,
      currentStreak, longestPos, longestNeg,
      bestPosReturn: Math.round(bestPosReturn * 100) / 100,
      worstNegReturn: Math.round(worstNegReturn * 100) / 100,
      avgPosLength: Math.round(avgPosLength * 10) / 10,
      avgNegLength: Math.round(avgNegLength * 10) / 10,
    };
  }, [weeks]);

  // ─── Green / Red split distributions ──────────────────────────────────────
  const { greenDist, redDist, greenStats, redStats, greenCount, redCount, histogramData } = useMemo(() => {
    const empty = { greenDist: [], redDist: [], greenStats: null, redStats: null, greenCount: 0, redCount: 0, histogramData: [] };
    if (weeks.length === 0) return empty;

    const greenReturns = weeks.filter((w) => w.returnPct > 0).map((w) => w.returnPct);
    const redReturns   = weeks.filter((w) => w.returnPct < 0).map((w) => w.returnPct);

    function buildBuckets(returns: number[], isGreen: boolean) {
      if (returns.length === 0) return [];
      const total = returns.length;
      const extreme = isGreen ? Math.max(...returns) : Math.abs(Math.min(...returns));
      const numBuckets = Math.ceil(extreme / 0.1) + 1;
      const result: { label: string; count: number; prob: number; cumulative: number; isMax: boolean }[] = [];
      let cumulative = 0;
      for (let i = 0; i < numBuckets; i++) {
        let lo: number, hi: number, label: string;
        if (isGreen) {
          lo = Math.round(i       * 0.1 * 100) / 100;
          hi = Math.round((i + 1) * 0.1 * 100) / 100;
          label = `${lo.toFixed(1)}% to ${hi.toFixed(1)}%`;
        } else {
          hi = -Math.round(i       * 0.1 * 100) / 100;
          lo = -Math.round((i + 1) * 0.1 * 100) / 100;
          label = `${lo.toFixed(1)}% to ${hi.toFixed(1)}%`;
        }
        const count = returns.filter((r) => r >= lo && r < hi).length;
        const prob  = (count / total) * 100;
        cumulative += prob;
        result.push({ label, count, prob: Math.round(prob * 100) / 100, cumulative: Math.round(cumulative * 100) / 100, isMax: false });
      }
      const maxCount = Math.max(...result.map((r) => r.count));
      result.forEach((r) => { if (r.count === maxCount) r.isMax = true; });
      return result;
    }

    function computeStats(returns: number[]) {
      if (returns.length === 0) return null;
      const sorted = [...returns].sort((a, b) => a - b);
      const n = sorted.length;
      const mean    = returns.reduce((a, b) => a + b, 0) / n;
      const median  = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
      return {
        mean:   Math.round(mean                * 100) / 100,
        median: Math.round(median              * 100) / 100,
        std:    Math.round(Math.sqrt(variance) * 100) / 100,
        max:    Math.round(Math.max(...returns) * 100) / 100,
        min:    Math.round(Math.min(...returns) * 100) / 100,
      };
    }

    // Histogram: 0.25% bins across all returns
    const allReturns = weeks.map((w) => w.returnPct);
    const BIN = 0.25;
    const firstBin = Math.floor(Math.min(...allReturns) / BIN);
    const lastBin  = Math.ceil(Math.max(...allReturns)  / BIN);
    const histogramData = [];
    for (let b = firstBin; b <= lastBin; b++) {
      const lo  = Math.round(b       * BIN * 100) / 100;
      const hi  = Math.round((b + 1) * BIN * 100) / 100;
      const mid = (lo + hi) / 2;
      const count = allReturns.filter((r) => r >= lo && r < hi).length;
      histogramData.push({ bin: `${lo.toFixed(2)}%`, midpoint: mid, count, positive: mid >= 0, lo, hi });
    }

    return {
      greenDist:     buildBuckets(greenReturns, true),
      redDist:       buildBuckets(redReturns,   false),
      greenStats:    computeStats(greenReturns),
      redStats:      computeStats(redReturns),
      greenCount:    greenReturns.length,
      redCount:      redReturns.length,
      histogramData,
    };
  }, [weeks]);

  // Stats
  const totalExpiries = weeks.length;
  const totalOutliers = outliers.length;
  const outlierPct =
    totalExpiries > 0 ? ((totalOutliers / totalExpiries) * 100).toFixed(1) : '0.0';

  const xTickFormatter = (ts: number) =>
    new Date(ts).getUTCFullYear().toString();

  const sign = (n: number) => (n >= 0 ? '+' : '');

  return (
    <div className="min-h-screen bg-black text-white">
      {/* ── Sticky header ── */}
      <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800 px-4 py-2 flex items-center gap-3">
        <TrendingUp className="text-emerald-400 w-5 h-5 flex-shrink-0" />
        <div className="flex-shrink-0">
          <h1 className="text-sm font-bold text-white leading-tight">Expiry Analysis</h1>
          <p className="text-xs text-zinc-500 leading-tight">
            {selectedOption.label} · Weekly Return Distribution
          </p>
        </div>
        <div className="flex-1 min-w-0">
        </div>
        {dataEnd && (
          <span className="flex-shrink-0 text-xs text-zinc-400 font-mono border border-zinc-700 rounded px-2 py-0.5 whitespace-nowrap">
            DATA: {dataEnd}
          </span>
        )}
        <span className="w-px h-5 bg-zinc-800 shrink-0" />
        <NavBar />
      </header>

      <main className="p-4 space-y-4 mx-auto">
        {/* ── Controls ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">Symbol</label>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500 min-w-[180px] cursor-pointer"
              >
                {Array.from(new Set(SYMBOL_OPTIONS.map((o) => o.group))).map((group) => (
                  <optgroup key={group} label={group}>
                    {SYMBOL_OPTIONS.filter((o) => o.group === group).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">Start Date</label>
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">End Date</label>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-3 flex-1 min-w-[300px]">
              <label className="text-xs text-zinc-400 whitespace-nowrap">
                Probability Boundary (%)
              </label>
              <input
                type="range"
                min={70}
                max={99}
                step={1}
                value={probability}
                onChange={(e) => setProbability(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <span className="text-xs font-mono text-emerald-400 whitespace-nowrap min-w-[220px]">
                {probability}% → lower: {lower.toFixed(2)}% / upper: {sign(upper)}{upper.toFixed(2)}%
              </span>
            </div>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Current Return Column: <span className="text-zinc-400">Weekly Return %</span>
            &nbsp;| Total Records: {totalExpiries} expiries.
            Based on the selected {probability}% coverage, the lower boundary is the{' '}
            {(((1 - probability / 100) / 2) * 100).toFixed(1)}th percentile and the upper boundary
            is the {((1 - (1 - probability / 100) / 2) * 100).toFixed(1)}th percentile.
          </p>
        </div>

        {/* ── Scatter chart ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="mb-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              ✈ Outliers Distribution (Survivability Scatter Plot)
              <InfoButton title="Survivability Scatter Plot">
                <p>Inspired by Abraham Wald&apos;s WWII aircraft survivability research. Each dot is one weekly expiry plotted at its return value over time.</p>
                <p>The dashed lines mark the selected <strong className="text-white">probability boundary</strong> — e.g. 95% means only 5% of returns fall outside. Glowing dots are statistical outliers (extreme market moves).</p>
                <p>Use the probability slider above to tighten or widen the boundary and see how many weeks qualify as extreme.</p>
              </InfoButton>
            </h2>
          </div>

          {loading ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              Loading weekly data…
            </div>
          ) : error ? (
            <div className="h-[420px] flex items-center justify-center text-red-400 text-sm">
              Error: {error}
            </div>
          ) : weeks.length === 0 ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              No data for the selected date range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <ScatterChart margin={{ top: 16, right: 80, bottom: 24, left: 8 }}>
                <defs>
                  <filter id="glow-green" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="glow-red" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['auto', 'auto']}
                  scale="time"
                  tickFormatter={xTickFormatter}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: 'Expiry End Date',
                    position: 'insideBottom',
                    offset: -12,
                    fontSize: 10,
                    fill: '#71717a',
                  }}
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={52}
                  label={{
                    value: 'Return (%)',
                    angle: -90,
                    position: 'insideLeft',
                    offset: 8,
                    fontSize: 10,
                    fill: '#71717a',
                  }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(value) => (
                    <span style={{ color: '#a1a1aa' }}>{value}</span>
                  )}
                />
                <ReferenceLine
                  y={upper}
                  stroke="#34d399"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Upper Boundary (${sign(upper)}${upper.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#34d399',
                  }}
                />
                <ReferenceLine
                  y={lower}
                  stroke="#f87171"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Lower Boundary (${sign(lower)}${lower.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#f87171',
                  }}
                />
                <Scatter
                  name="Within Boundary"
                  data={withinData}
                  isAnimationActive={false}
                  shape={<SmallDot />}
                />
                <Scatter
                  name="Upside Outlier"
                  data={upsideData}
                  isAnimationActive={false}
                  shape={<GreenDot />}
                />
                <Scatter
                  name="Downside Outlier"
                  data={downsideData}
                  isAnimationActive={false}
                  shape={<RedDot />}
                />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Expiries', value: String(totalExpiries), colorClass: 'text-white' },
            { label: 'Total Outliers', value: `${totalOutliers} (${outlierPct}%)`, colorClass: 'text-amber-400' },
            { label: 'Downside Outliers 🔴', value: String(downsideData.length), colorClass: 'text-red-400' },
            { label: 'Upside Outliers 🟢', value: String(upsideData.length), colorClass: 'text-emerald-400' },
          ].map((stat) => (
            <div key={stat.label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
              <div className="text-xs text-zinc-500 mb-2">{stat.label}</div>
              <div className={`text-3xl font-bold font-mono ${stat.colorClass}`}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Outlier table ── */}
        {outliers.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">Outlier Expiries Table</h2>
                <InfoButton title="Outlier Expiries Table">
                  <p>Lists every weekly expiry whose return fell <strong className="text-white">outside the selected probability boundary</strong>, sorted by absolute return magnitude (largest moves first).</p>
                  <p>These are the weeks the market moved unusually hard — useful for identifying market crises, rallies, or event-driven spikes (earnings seasons, global shocks, budget days).</p>
                </InfoButton>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                All weekly expiries that fell outside the specified boundaries, sorted by absolute return size.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Start Date (Fri/Wed)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      End Date / Expiry (Thu/Tue)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">
                      Weekly Return %
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {outliers.map((w, i) => {
                    const isUp = w.status === 'upside';
                    return (
                      <tr key={w.endDate} className={i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}>
                        <td className="px-4 py-2 font-mono text-zinc-300">{fmtDate(w.startDate)}</td>
                        <td className="px-4 py-2 font-mono text-zinc-300">{fmtDate(w.endDate)}</td>
                        <td
                          className={`px-4 py-2 font-mono font-bold text-right ${
                            isUp ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {sign(w.returnPct)}{w.returnPct.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
                              isUp
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-red-500/10 text-red-400 border-red-500/30'
                            }`}
                          >
                            {isUp ? 'Upside Outlier' : 'Downside Outlier'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            SECTION A: Weekly Returns Analysis — KPI stats + composite chart
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && weeklyAnalysis && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-sm font-bold text-white">
                {selectedOption.label} Weekly Expiry Returns Analysis (OC)
              </h2>
              <InfoButton title="Weekly Returns Analysis (OC)">
                <p><strong className="text-white">OC = Open to Close.</strong> Each weekly return is measured from the opening price on the window-open day (Friday pre-Sep 2025, Wednesday after) to the closing price on the expiry day (Thursday / Tuesday).</p>
                <p><strong className="text-white">Sharpe Ratio</strong> = avg return ÷ std dev. Higher means better risk-adjusted performance. Assumes risk-free rate = 0.</p>
                <p><strong className="text-white">Sortino Ratio</strong> = avg return ÷ downside deviation (only negative weeks). Penalises losses more heavily than Sharpe — preferred for options sellers.</p>
                <p><strong className="text-white">Profit Factor</strong> = total gains ÷ total losses. &gt;1 means the market recovered more than it lost over the period.</p>
                <p>Bubble size in the chart scales with the absolute return — larger bubble = more extreme move that week.</p>
              </InfoButton>
            </div>

            {/* KPI grid */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[
                { label: 'Average Weekly Return', value: `${sign(weeklyAnalysis.avgReturn)}${weeklyAnalysis.avgReturn.toFixed(2)}%`, color: weeklyAnalysis.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400' },
                { label: 'Weekly Return Std',     value: `${weeklyAnalysis.std.toFixed(2)}%`,       color: 'text-amber-400' },
                { label: 'Sharpe Ratio',          value: weeklyAnalysis.sharpe.toFixed(2),           color: 'text-zinc-200' },
                { label: 'Max Weekly Gain',       value: `+${weeklyAnalysis.maxGain.toFixed(2)}%`,  color: 'text-emerald-400' },
                { label: `Positive Weeklys`,      value: `${weeklyAnalysis.positiveCount} (${((weeklyAnalysis.positiveCount/weeklyAnalysis.total)*100).toFixed(1)}%)`, color: 'text-emerald-400' },
                { label: 'Sortino Ratio',         value: weeklyAnalysis.sortino.toFixed(2),          color: 'text-zinc-200' },
                { label: 'Max Weekly Loss',       value: `${weeklyAnalysis.maxLoss.toFixed(2)}%`,   color: 'text-red-400' },
                { label: `Negative Weeklys`,      value: `${weeklyAnalysis.negativeCount} (${((weeklyAnalysis.negativeCount/weeklyAnalysis.total)*100).toFixed(1)}%)`, color: 'text-red-400' },
                { label: 'Profit Factor',         value: weeklyAnalysis.profitFactor === Infinity ? '∞' : weeklyAnalysis.profitFactor.toFixed(2), color: 'text-zinc-200' },
              ].map((k) => (
                <div key={k.label} className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                  <div className="text-xs text-zinc-500 mb-0.5">{k.label}</div>
                  <div className={`text-xl font-bold font-mono ${k.color}`}>{k.value}</div>
                </div>
              ))}
            </div>

            {/* MA controls */}
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showMA}
                  onChange={(e) => setShowMA(e.target.checked)}
                  className="accent-red-500 w-4 h-4 cursor-pointer"
                />
                Show moving average
              </label>
              {showMA && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400 whitespace-nowrap">MA window (weekly periods)</span>
                  <input
                    type="range"
                    min={5}
                    max={52}
                    step={1}
                    value={maWindow}
                    onChange={(e) => setMaWindow(Number(e.target.value))}
                    className="w-40 accent-red-500"
                  />
                  <span className="text-xs font-mono text-red-400 min-w-[24px]">{maWindow}</span>
                </div>
              )}
            </div>

            {/* Subtitle */}
            <p className="text-xs text-zinc-500 mb-3">
              {selectedOption.label} Weekly Returns (Fri+Thu before Sep 3 2025, Wed+Tue from Sep 3 2025) —{' '}
              {weeklyAnalysis.total} Weeks Analyzed{showMA ? ` — ${maWindow}-week MA` : ''}
            </p>

            {/* Composite chart: bars + bubble dots + MA line */}
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={weeklyAnalysis.chartData} margin={{ top: 8, right: 16, bottom: 24, left: 8 }} barCategoryGap="0%">
                <defs>
                  <filter id="glow-bubble-g" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                  <filter id="glow-bubble-r" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="index"
                  type="number"
                  domain={[0, weeklyAnalysis.chartData.length - 1]}
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(i: number) => {
                    const entry = weeklyAnalysis.chartData[Math.round(i)];
                    return entry ? entry.endDate.slice(0, 4) : '';
                  }}
                  ticks={weeklyAnalysis.chartData
                    .map((d, i) => (d.endDate.endsWith('-12-31') || (i > 0 && weeklyAnalysis.chartData[i - 1].endDate.slice(0, 4) !== d.endDate.slice(0, 4)) ? i : -1))
                    .filter((i) => i >= 0)}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={44}
                  label={{ value: 'Return %', angle: -90, position: 'insideLeft', offset: 8, fontSize: 10, fill: '#71717a' }}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null;
                    const d = payload[0].payload as typeof weeklyAnalysis.chartData[0];
                    return (
                      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
                        <div className="text-zinc-400 mb-0.5">{fmtDate(d.endDate)}</div>
                        <div className={`font-mono font-bold text-sm ${d.positive ? 'text-emerald-400' : 'text-red-400'}`}>
                          {sign(d.returnPct)}{d.returnPct.toFixed(2)}%
                        </div>
                        {d.ma !== null && <div className="text-amber-400 font-mono text-xs mt-0.5">MA{maWindow}: {sign(d.ma)}{d.ma.toFixed(2)}%</div>}
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
                {/* Bars */}
                <Bar dataKey="returnPct" isAnimationActive={false} maxBarSize={6} name="Weekly Returns (Bars)">
                  {weeklyAnalysis.chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.positive ? '#34d399' : '#f87171'} fillOpacity={0.7} />
                  ))}
                </Bar>
                {/* Bubble overlay — Line with no stroke, sized custom dots */}
                <Line
                  dataKey="returnPct"
                  stroke="none"
                  dot={(props: { cx?: number; cy?: number; payload?: typeof weeklyAnalysis.chartData[0]; index?: number }) => {
                    const { cx, cy, payload } = props;
                    if (cx === undefined || cy === undefined || !payload) return <g key={props.index} />;
                    const r = Math.min(Math.max(Math.abs(payload.returnPct) * 2.2, 3), 18);
                    const fill = payload.positive ? '#34d399' : '#f87171';
                    return (
                      <circle
                        key={props.index}
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill={fill}
                        fillOpacity={0.55}
                        stroke={fill}
                        strokeWidth={0.5}
                        strokeOpacity={0.8}
                      />
                    );
                  }}
                  isAnimationActive={false}
                  legendType="none"
                  activeDot={false}
                  name="Weekly Returns (Bubbles)"
                />
                {/* MA line */}
                {showMA && (
                  <Line
                    dataKey="ma"
                    stroke="#fbbf24"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                    name={`${maWindow}-week MA`}
                  />
                )}
                <Legend
                  wrapperStyle={{ fontSize: 10, paddingTop: 8 }}
                  formatter={(value) => <span style={{ color: '#a1a1aa' }}>{value}</span>}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            SECTION B: Weekly Streak Analysis — current streak + summary stats
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && streakAnalysis && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
              <span className="text-white text-sm">✦</span>
              <h2 className="text-sm font-bold text-white">Weekly Streak Analysis</h2>
              <InfoButton title="Weekly Streak Analysis">
                <p>A <strong className="text-white">streak</strong> is a run of consecutive weekly expiries all closing in the same direction — all positive or all negative.</p>
                <p>The <strong className="text-white">Current Streak</strong> shows what&apos;s happening right now: how many weeks in a row the market has moved in the same direction and by how much in total.</p>
                <p><strong className="text-white">Longest streaks</strong> show the maximum observed consecutive run. <strong className="text-white">Best / Worst return</strong> is the compounded price move during the strongest streak of each type — not the longest, just the most extreme.</p>
                <p><strong className="text-white">Avg streak length</strong> tells you how many weeks a typical rally or sell-off tends to persist before reversing.</p>
              </InfoButton>
            </div>

            {/* Current streak */}
            {streakAnalysis.currentStreak && (
              <div className={`px-4 py-4 flex items-center gap-4 border-b border-zinc-800 ${
                streakAnalysis.currentStreak.type === 'Positive'
                  ? 'bg-emerald-950/40'
                  : 'bg-red-950/40'
              }`}>
                <div className={`w-10 h-10 rounded-full flex-shrink-0 ${
                  streakAnalysis.currentStreak.type === 'Positive'
                    ? 'bg-emerald-500'
                    : 'bg-red-500'
                }`} style={{ boxShadow: streakAnalysis.currentStreak.type === 'Positive' ? '0 0 12px #34d399' : '0 0 12px #f87171' }} />
                <div>
                  <div className="text-xs text-zinc-500 mb-0.5">Current Streak</div>
                  <div className={`text-2xl font-bold ${
                    streakAnalysis.currentStreak.type === 'Positive' ? 'text-emerald-300' : 'text-red-300'
                  }`}>
                    {streakAnalysis.currentStreak.type} — {streakAnalysis.currentStreak.length} week{streakAnalysis.currentStreak.length !== 1 ? 's' : ''}
                  </div>
                  <div className="text-xs text-zinc-400 mt-0.5">
                    {fmtDate(streakAnalysis.currentStreak.startDate)} → {fmtDate(streakAnalysis.currentStreak.endDate)}
                    {' · '}Total: <span className={streakAnalysis.currentStreak.type === 'Positive' ? 'text-emerald-400' : 'text-red-400'}>
                      {sign(streakAnalysis.currentStreak.totalReturnPct)}{streakAnalysis.currentStreak.totalReturnPct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3 p-4">
              {[
                { label: 'Longest Positive Streak', value: `${streakAnalysis.longestPos} weeks`,              color: 'text-emerald-400' },
                { label: 'Best Positive Streak Return',  value: `+${streakAnalysis.bestPosReturn.toFixed(2)}%`,  color: 'text-emerald-400' },
                { label: 'Longest Negative Streak', value: `${streakAnalysis.longestNeg} weeks`,              color: 'text-red-400' },
                { label: 'Worst Negative Streak Return', value: `${streakAnalysis.worstNegReturn.toFixed(2)}%`, color: 'text-red-400' },
                { label: 'Avg Positive Streak',     value: `${streakAnalysis.avgPosLength.toFixed(1)} weeks`, color: 'text-emerald-300' },
                { label: 'Avg Negative Streak',     value: `${streakAnalysis.avgNegLength.toFixed(1)} weeks`, color: 'text-red-300' },
              ].map((s) => (
                <div key={s.label} className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                  <div className="text-xs text-zinc-500 mb-0.5">{s.label}</div>
                  <div className={`text-2xl font-bold font-mono ${s.color}`}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-4 pb-3 text-xs text-zinc-500 flex items-center gap-1.5">
              <span>📋</span>
              <span>
                Analysis Details: Analyzed {weeks.length} total weeks. Excluded {streakAnalysis.neutralCount} neutral weeks (0% returns) from streak calculation.
              </span>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            SECTION C: Streak scatter plot — length over time
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && streakAnalysis && (streakAnalysis.posScatter.length > 0 || streakAnalysis.negScatter.length > 0) && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-sm font-bold text-white">Weekly Streak Lengths Over Time (with Total Returns)</h2>
              <InfoButton title="Streak Scatter Plot">
                <p>Each dot represents <strong className="text-white">one historical streak</strong>.</p>
                <p><strong className="text-white">X-axis</strong> = the date the streak ended (time from left to right).</p>
                <p><strong className="text-white">Y-axis</strong> = how many consecutive weeks the streak lasted.</p>
                <p><strong className="text-white">Dot size</strong> scales with the total compounded return during the streak — a small dot high up means a long but moderate streak; a large dot low means a short but violent move.</p>
                <p>Clusters of large dots in time indicate periods of elevated market volatility.</p>
              </InfoButton>
            </div>
            <p className="text-xs text-zinc-500 mb-4">Dot size ∝ |total streak return| · Green = positive · Red = negative</p>
            <ResponsiveContainer width="100%" height={280}>
              <ScatterChart margin={{ top: 8, right: 32, bottom: 32, left: 8 }}>
                <defs>
                  <filter id="glow-streak-g" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                  <filter id="glow-streak-r" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['auto', 'auto']}
                  scale="time"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(ts: number) => new Date(ts).getUTCFullYear().toString()}
                  label={{ value: 'Streak End Date', position: 'insideBottom', offset: -16, fontSize: 10, fill: '#71717a' }}
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  label={{ value: 'Streak Length (weeks)', angle: -90, position: 'insideLeft', offset: 8, fontSize: 10, fill: '#71717a' }}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null;
                    const d = payload[0].payload as (typeof streakAnalysis.posScatter)[0];
                    const isPos = d.type === 'Positive';
                    return (
                      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
                        <div className={`font-bold mb-1 ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>{d.type} Streak · {d.length} week{d.length !== 1 ? 's' : ''}</div>
                        <div className="text-zinc-400">{fmtDate(d.startDate)} → {fmtDate(d.endDate)}</div>
                        <div className={`font-mono font-bold mt-0.5 ${isPos ? 'text-emerald-300' : 'text-red-300'}`}>
                          Total: {sign(d.totalReturnPct)}{d.totalReturnPct.toFixed(2)}%
                        </div>
                        <div className="text-zinc-500 mt-0.5">Avg weekly: {sign(d.avgWeeklyReturnPct)}{d.avgWeeklyReturnPct.toFixed(2)}%</div>
                      </div>
                    );
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                  formatter={(value) => <span style={{ color: '#a1a1aa' }}>{value}</span>}
                />
                <Scatter
                  name="Positive Streak"
                  data={streakAnalysis.posScatter}
                  isAnimationActive={false}
                  shape={(props: { cx?: number; cy?: number; payload?: (typeof streakAnalysis.posScatter)[0] }) => {
                    const { cx = 0, cy = 0, payload } = props;
                    const r = payload ? Math.min(Math.max(Math.abs(payload.r) * 1.5, 4), 20) : 5;
                    return <circle cx={cx} cy={cy} r={r} fill="#34d399" fillOpacity={0.75} filter="url(#glow-streak-g)" />;
                  }}
                />
                <Scatter
                  name="Negative Streak"
                  data={streakAnalysis.negScatter}
                  isAnimationActive={false}
                  shape={(props: { cx?: number; cy?: number; payload?: (typeof streakAnalysis.negScatter)[0] }) => {
                    const { cx = 0, cy = 0, payload } = props;
                    const r = payload ? Math.min(Math.max(Math.abs(payload.r) * 1.5, 4), 20) : 5;
                    return <circle cx={cx} cy={cy} r={r} fill="#f87171" fillOpacity={0.75} filter="url(#glow-streak-r)" />;
                  }}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            SECTION D: Streak Details Table
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && streakAnalysis && streakAnalysis.streaks.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">Streak Details</h2>
                <InfoButton title="Streak Details Table">
                  <p>All streaks listed in <strong className="text-white">chronological order</strong>. Each row is one unbroken run of same-direction weekly expiries.</p>
                  <p><strong className="text-white">Total Return %</strong> = compounded price move from the streak&apos;s opening price to its closing price — this differs from simply summing individual weekly returns because compounding applies.</p>
                  <p><strong className="text-white">Avg Weekly Return %</strong> = arithmetic mean of each individual weekly return within the streak.</p>
                  <p>The glowing dot in the last column confirms positive (green) or negative (red) at a glance.</p>
                </InfoButton>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">{streakAnalysis.streaks.length} streaks identified</p>
            </div>
            <div className="overflow-x-auto">
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2.5 text-left">Streak Type</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2.5 text-right">Length (weeks)</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">Start Date</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">End Date</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Start Price</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">End Price</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Total Return %</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Avg Weekly Return %</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2.5 text-center">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {streakAnalysis.streaks.map((s, i) => {
                      const isPos = s.type === 'Positive';
                      const rowBg = i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950';
                      return (
                        <tr key={i} className={`${rowBg} hover:bg-zinc-800/60 transition-colors`}>
                          <td className={`px-3 py-1.5 font-semibold ${isPos ? 'text-emerald-300' : 'text-red-300'}`}>{s.type}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{s.length}</td>
                          <td className="px-4 py-1.5 font-mono text-zinc-300">{fmtDate(s.startDate)}</td>
                          <td className="px-4 py-1.5 font-mono text-zinc-300">{fmtDate(s.endDate)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-400">{fmtINR(s.startPrice)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-400">{fmtINR(s.endPrice)}</td>
                          <td className={`px-4 py-1.5 text-right font-mono font-bold ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                            {sign(s.totalReturnPct)}{s.totalReturnPct.toFixed(2)}%
                          </td>
                          <td className={`px-4 py-1.5 text-right font-mono ${isPos ? 'text-emerald-300' : 'text-red-300'}`}>
                            {sign(s.avgWeeklyReturnPct)}{s.avgWeeklyReturnPct.toFixed(2)}%
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <span
                              className="inline-block w-3 h-3 rounded-full"
                              style={{
                                backgroundColor: isPos ? '#34d399' : '#f87171',
                                boxShadow: isPos ? '0 0 4px #34d399' : '0 0 4px #f87171',
                              }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            GREEN / RED EXPIRY DISTRIBUTION (side by side)
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && weeks.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* ── Green ── */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 text-center">
                <div className="flex items-center justify-center gap-2">
                  <h2 className="text-sm font-bold text-emerald-400">Green Expiry Distribution</h2>
                  <InfoButton title="Green Expiry Distribution">
                    <p>Shows the distribution of <strong className="text-white">positive weekly returns</strong> broken into 0.1%-wide buckets.</p>
                    <p>The <strong className="text-white">highlighted row</strong> (bright left border) is the most frequently occurring return range among green expiries.</p>
                    <p><strong className="text-white">Probability %</strong> = percentage of green expiries that fell in this specific bucket. <strong className="text-white">Cumulative %</strong> accumulates from the smallest positive return upward — so 50% cumulative means half of all green weeks had a return smaller than this bucket&apos;s upper bound.</p>
                  </InfoButton>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">Based on {greenCount} green expiries</p>
              </div>
              <div className="overflow-x-auto">
                <div className="max-h-[420px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10">
                      <tr>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right w-8">#</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-left">Return Range</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Count</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Probability %</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Cumulative %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {greenDist.map((row, i) => (
                        <tr
                          key={row.label}
                          className={row.isMax
                            ? 'bg-emerald-900/40 border-l-2 border-emerald-500'
                            : i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}
                        >
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-600">{i}</td>
                          <td className="px-3 py-1.5 font-mono text-emerald-300">{row.label}</td>
                          <td className={`px-3 py-1.5 text-right font-mono font-bold ${row.isMax ? 'text-emerald-300' : 'text-zinc-200'}`}>{row.count}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{row.prob.toFixed(2)}%</td>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{row.cumulative.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {greenStats && (
                <div className="px-4 py-4 border-t border-zinc-800 grid grid-cols-2 gap-3">
                  <div className="text-xs text-zinc-500 font-semibold col-span-2 uppercase tracking-wide mb-1">Statistics</div>
                  {[
                    { label: 'Average Return', value: `${sign(greenStats.mean)}${greenStats.mean.toFixed(2)}%`, color: 'text-emerald-400' },
                    { label: 'Median Return',  value: `${sign(greenStats.median)}${greenStats.median.toFixed(2)}%`, color: 'text-emerald-300' },
                    { label: 'Std Dev',        value: `${greenStats.std.toFixed(2)}%`, color: 'text-amber-400' },
                    { label: 'Max Return',     value: `${sign(greenStats.max)}${greenStats.max.toFixed(2)}%`, color: 'text-emerald-400' },
                  ].map((s) => (
                    <div key={s.label} className="bg-zinc-800 rounded-lg px-3 py-2">
                      <div className="text-xs text-zinc-500 mb-0.5">{s.label}</div>
                      <div className={`text-lg font-bold font-mono ${s.color}`}>{s.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Red ── */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800 text-center">
                <div className="flex items-center justify-center gap-2">
                  <h2 className="text-sm font-bold text-red-400">Red Expiry Distribution</h2>
                  <InfoButton title="Red Expiry Distribution">
                    <p>Shows the distribution of <strong className="text-white">negative weekly returns</strong> in 0.1%-wide buckets starting from 0% downward.</p>
                    <p>The <strong className="text-white">highlighted row</strong> is the most frequently occurring loss range. Useful for knowing where most sell-offs cluster — e.g. if most red weeks are only −0.5% to −1%, large losses are rare.</p>
                    <p><strong className="text-white">Cumulative %</strong> accumulates from the smallest loss outward — 50% cumulative means half of all red weeks had a loss smaller (closer to 0%) than this bucket&apos;s boundary.</p>
                  </InfoButton>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">Based on {redCount} red expiries</p>
              </div>
              <div className="overflow-x-auto">
                <div className="max-h-[420px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10">
                      <tr>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right w-8">#</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-left">Return Range</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Count</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Probability %</th>
                        <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2 text-right">Cumulative %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {redDist.map((row, i) => (
                        <tr
                          key={row.label}
                          className={row.isMax
                            ? 'bg-red-900/40 border-l-2 border-red-500'
                            : i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}
                        >
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-600">{i}</td>
                          <td className="px-3 py-1.5 font-mono text-red-300">{row.label}</td>
                          <td className={`px-3 py-1.5 text-right font-mono font-bold ${row.isMax ? 'text-red-300' : 'text-zinc-200'}`}>{row.count}</td>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-300">{row.prob.toFixed(2)}%</td>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-400">{row.cumulative.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {redStats && (
                <div className="px-4 py-4 border-t border-zinc-800 grid grid-cols-2 gap-3">
                  <div className="text-xs text-zinc-500 font-semibold col-span-2 uppercase tracking-wide mb-1">Statistics</div>
                  {[
                    { label: 'Average Return', value: `${sign(redStats.mean)}${redStats.mean.toFixed(2)}%`, color: 'text-red-400' },
                    { label: 'Median Return',  value: `${sign(redStats.median)}${redStats.median.toFixed(2)}%`, color: 'text-red-300' },
                    { label: 'Std Dev',        value: `${redStats.std.toFixed(2)}%`, color: 'text-amber-400' },
                    { label: 'Min Return',     value: `${sign(redStats.min)}${redStats.min.toFixed(2)}%`, color: 'text-red-400' },
                  ].map((s) => (
                    <div key={s.label} className="bg-zinc-800 rounded-lg px-3 py-2">
                      <div className="text-xs text-zinc-500 mb-0.5">{s.label}</div>
                      <div className={`text-lg font-bold font-mono ${s.color}`}>{s.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            DISTRIBUTION BAR CHART (histogram across all expiries)
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && histogramData.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-sm font-bold text-white">Return Distribution Histogram</h2>
              <InfoButton title="Return Distribution Histogram">
                <p>A histogram of <strong className="text-white">all weekly expiry returns</strong> grouped into 0.25%-wide bins. Each bar shows how many weeks fell in that return range.</p>
                <p>Green bars = bins with a positive midpoint; red bars = negative midpoint. The taller the bar, the more common that return range is.</p>
                <p>A symmetric bell shape suggests returns are normally distributed. <strong className="text-white">Skew</strong> (the distribution leaning left or right) and <strong className="text-white">fat tails</strong> (unusually tall outer bars) indicate the market is not behaving normally — important for options pricing and risk sizing.</p>
              </InfoButton>
            </div>
            <p className="text-xs text-zinc-500 mb-4">
              Count of weekly expiries per 0.25% return bin · green = positive expiry · red = negative expiry
            </p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={histogramData} margin={{ top: 8, right: 16, bottom: 32, left: 8 }} barCategoryGap="2%">
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="bin"
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  interval={3}
                  angle={-45}
                  textAnchor="end"
                  height={48}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                  allowDecimals={false}
                  label={{ value: 'Count', angle: -90, position: 'insideLeft', offset: 8, fontSize: 10, fill: '#71717a' }}
                />
                <Tooltip
                  cursor={{ fill: '#3f3f46', opacity: 0.4 }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null;
                    const d = payload[0].payload as { bin: string; count: number; positive: boolean; lo: number; hi: number };
                    return (
                      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
                        <div className="text-zinc-400 mb-0.5">{d.lo.toFixed(2)}% to {d.hi.toFixed(2)}%</div>
                        <div className={`font-mono font-bold text-sm ${d.positive ? 'text-emerald-400' : 'text-red-400'}`}>
                          {d.count} expiries
                        </div>
                      </div>
                    );
                  }}
                />
                <ReferenceLine x="0.00%" stroke="#52525b" strokeWidth={1} strokeDasharray="4 2" />
                <Bar dataKey="count" radius={[2, 2, 0, 0]} maxBarSize={32}>
                  {histogramData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={entry.positive ? '#34d399' : '#f87171'}
                      fillOpacity={0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            NEW SECTION 1: Returns Distribution Table
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && distributionBuckets.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">Weekly Returns Distribution</h2>
                <InfoButton title="Weekly Returns Distribution">
                  <p>A probability table with <strong className="text-white">fixed-width return buckets</strong> covering the full range from &lt;−5% to &gt;+5%. Similar to an options seller&apos;s probability reference card.</p>
                  <p><strong className="text-white">Percentile Range</strong> = where this bucket sits in the ranked empirical distribution, measured from the relevant extreme end (top for positive, bottom for negative).</p>
                  <p><strong className="text-white">Probability</strong> = empirical chance that the market does NOT breach the bucket&apos;s boundary — e.g., a 98% probability means only 2% of historical weeks had a return beyond that level.</p>
                  <p><strong className="text-white">Price Range</strong> = the corresponding Nifty 50 price levels at those return boundaries, projected from the latest close.</p>
                </InfoButton>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                Analyzed {totalExpiries} weekly periods
                {dataStart ? ` from ${fmtDate(dataStart)}` : ''}
                {dataEnd ? ` to ${fmtDate(dataEnd)}` : ''}
                {' '}· Calculation Type: OC (Open to Close)
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left min-w-[140px]">
                      Return Range
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">
                      Number of Periods
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">
                      % of Total
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right min-w-[180px]">
                      Percentile Range
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right min-w-[140px]">
                      Probability
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right min-w-[160px]">
                      {selectedOption.label} Price Range
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {distributionBuckets.map((bucket, i) => {
                    const isPositive = bucket.min >= 0 || bucket.max === Infinity;
                    const isNegative = bucket.max <= 0 || bucket.min === -Infinity;
                    const rowBg = i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950';
                    return (
                      <tr key={bucket.label} className={rowBg}>
                        {/* colored label cell */}
                        <td className="px-0 py-0">
                          <div
                            className="flex items-center h-full px-3 py-2 font-mono font-bold text-xs"
                            style={{
                              backgroundColor: bucket.color + '22',
                              borderLeft: `4px solid ${bucket.color}`,
                              color: bucket.color,
                            }}
                          >
                            {bucket.label}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-zinc-200">
                          {bucket.count}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-zinc-300">
                          {bucket.pctOfTotal.toFixed(1)}%
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-zinc-400 text-xs">
                          {bucket.percentileRange}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono font-semibold text-xs ${
                            isPositive && !isNegative
                              ? 'text-emerald-400'
                              : isNegative && !isPositive
                              ? 'text-red-400'
                              : 'text-zinc-300'
                          }`}
                        >
                          {bucket.probability}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-zinc-300 text-xs">
                          {bucket.priceRange}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            NEW SECTION 2: Weekly Returns Data Table (always visible)
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && weeks.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">Weekly Returns Data</h2>
                <InfoButton title="Weekly Returns Data">
                  <p>Raw data behind all the analysis above. Each row is one <strong className="text-white">weekly expiry period</strong>.</p>
                  <p><strong className="text-white">Start Price</strong> = opening price on the window-open day (Friday pre-Sep 2025 / Wednesday after).</p>
                  <p><strong className="text-white">End Price</strong> = closing price on the expiry day (Thursday / Tuesday).</p>
                  <p><strong className="text-white">Weekly Return %</strong> = (End Price − Start Price) / Start Price × 100. This is an open-to-close return, not a close-to-close.</p>
                </InfoButton>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                {totalExpiries} weekly expiry periods · Fri/Wed open → Thu/Tue close
              </p>
            </div>
            <div className="overflow-x-auto">
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2.5 text-right w-10">#</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">Start Date</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">End Date</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Start Price</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">End Price</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Weekly Return %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.map((w, i) => {
                      const isUp = w.returnPct >= 0;
                      return (
                        <tr key={w.endDate} className={i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-600">{i}</td>
                          <td className="px-4 py-1.5 font-mono text-zinc-300">{fmtDate(w.startDate)}</td>
                          <td className="px-4 py-1.5 font-mono text-zinc-300">{fmtDate(w.endDate)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-300">{fmtINR(w.startOpen)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-300">{fmtINR(w.endClose)}</td>
                          <td className={`px-4 py-1.5 text-right font-mono font-bold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                            {sign(w.returnPct)}{w.returnPct.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            NEW SECTION 2b: Daily Returns Data Table
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && dailyRows.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white">Daily Returns Data</h2>
                <InfoButton title="Daily Returns Data">
                  <p>Daily OHLCV data for every trading day in the selected date range.</p>
                  <p><strong className="text-white">High</strong> (green) = intraday peak. <strong className="text-white">Low</strong> (red) = intraday trough.</p>
                  <p><strong className="text-white">Daily Return %</strong> = (today&apos;s close − yesterday&apos;s close) / yesterday&apos;s close × 100. The first row always shows &quot;—&quot; because there is no prior day in the range.</p>
                  <p>This is a close-to-close return, unlike the weekly OC returns above.</p>
                </InfoButton>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                {dailyRows.length} trading days · OHLCV with daily return %
              </p>
            </div>
            <div className="overflow-x-auto">
              <div className="max-h-[480px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-3 py-2.5 text-right w-10">#</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">Date</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Open</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">High</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Low</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Close</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Volume</th>
                      <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">Daily Return %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyRows.map((row, i) => {
                      const isUp = row.dailyReturnPct !== null && row.dailyReturnPct >= 0;
                      const isDown = row.dailyReturnPct !== null && row.dailyReturnPct < 0;
                      return (
                        <tr key={row.date} className={i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}>
                          <td className="px-3 py-1.5 text-right font-mono text-zinc-600">{i}</td>
                          <td className="px-4 py-1.5 font-mono text-zinc-300">{fmtDate(row.date)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-400">{fmtINR(row.open)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-emerald-300">{fmtINR(row.high)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-red-300">{fmtINR(row.low)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-200 font-semibold">{fmtINR(row.close)}</td>
                          <td className="px-4 py-1.5 text-right font-mono text-zinc-400">{fmtINRInt(row.volume)}</td>
                          <td className={`px-4 py-1.5 text-right font-mono font-bold ${isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-zinc-500'}`}>
                            {row.dailyReturnPct === null
                              ? '—'
                              : `${sign(row.dailyReturnPct)}${row.dailyReturnPct.toFixed(2)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════════════
            NEW SECTION 3: Daily OHLC Analysis
        ══════════════════════════════════════════════════════════════════════ */}
        {!loading && dailyStats && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-sm font-bold text-white">Daily OHLC Analysis</h2>
              <InfoButton title="Daily OHLC Analysis">
                <p>Summary statistics computed from <strong className="text-white">all trading days</strong> in the selected date range.</p>
                <p><strong className="text-white">Daily Return Std</strong> = standard deviation of close-to-close daily returns. Annualise by multiplying by √252 to get approximate annual volatility.</p>
                <p><strong className="text-white">Avg Volume</strong> = mean daily traded volume. For indices this may be 0 or low — volume data is more meaningful for individual stocks.</p>
                <p><strong className="text-white">Period High / Low</strong> = the highest intraday high and lowest intraday low observed in the entire date range.</p>
              </InfoButton>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                {
                  label: 'Latest Close',
                  value: fmtINR(dailyStats.latestClose),
                  colorClass: 'text-white',
                },
                {
                  label: 'Avg Daily Return',
                  value: `${dailyStats.avgDailyReturn >= 0 ? '+' : ''}${dailyStats.avgDailyReturn.toFixed(2)}%`,
                  colorClass: dailyStats.avgDailyReturn >= 0 ? 'text-emerald-400' : 'text-red-400',
                },
                {
                  label: 'Period High',
                  value: fmtINR(dailyStats.periodHigh),
                  colorClass: 'text-emerald-300',
                },
                {
                  label: 'Daily Return Std',
                  value: `${dailyStats.dailyReturnStd.toFixed(2)}%`,
                  colorClass: 'text-amber-400',
                },
                {
                  label: 'Period Low',
                  value: fmtINR(dailyStats.periodLow),
                  colorClass: 'text-red-300',
                },
                {
                  label: 'Avg Volume',
                  value: fmtINRInt(dailyStats.avgVolume),
                  colorClass: 'text-zinc-200',
                },
              ].map((stat) => (
                <div key={stat.label} className="bg-zinc-800 border border-zinc-700 rounded-lg p-3">
                  <div className="text-xs text-zinc-500 mb-1">{stat.label}</div>
                  <div className={`text-xl font-bold font-mono ${stat.colorClass}`}>
                    {stat.value}
                  </div>
                </div>
              ))}
            </div>
            {/* Total trading days full-width */}
            <div className="mt-3 bg-zinc-800 border border-zinc-700 rounded-lg p-3 flex items-center justify-between">
              <span className="text-xs text-zinc-500">Total Trading Days</span>
              <span className="text-xl font-bold font-mono text-white">{dailyStats.totalTradingDays.toLocaleString('en-IN')}</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
