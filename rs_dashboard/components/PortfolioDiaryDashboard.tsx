'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BookOpen, RefreshCw, Award, PartyPopper, ChevronLeft, ChevronRight, Flame, LineChart as LineChartIcon } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useTradeSync } from '@/lib/useTradeSync';
import NavBar from './NavBar';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DailyPnlPoint {
  date: string;
  grossPnl: number;
  charges: number;
  statutoryCharges: number;
  netPnl: number;
  tradeCount: number;
}

interface TradeHistoryResponse {
  success: boolean;
  available: boolean;
  fromDate?: string;
  toDate?: string;
  marketTradingDates?: string[];
  dailyPnl?: DailyPnlPoint[];
  dailyPnlBySegment?: Record<string, DailyPnlPoint[]>;
}

interface Bucket {
  label: string;
  startDate: string;
  endDate: string;
  tradeCount: number;
  grossPnl: number;
  netPnl: number;
  charges: number;
  statutoryCharges: number;
}

// ─── Date helpers (UTC-based to avoid local-timezone day shifts) ──────────────

function toUTCDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTCDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(dateStr: string, days: number): string {
  const d = toUTCDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTCDate(d);
}

function dayOfWeekUTC(dateStr: string): number {
  return toUTCDate(dateStr).getUTCDay(); // 0=Sun..6=Sat
}

function fmtShort(dateStr: string): string {
  const d = toUTCDate(dateStr);
  return d.toLocaleDateString('en-IN', { month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function fmtDateLong(dateStr: string): string {
  const d = toUTCDate(dateStr);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function yearKey(dateStr: string): string {
  return dateStr.slice(0, 4);
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtINR(n: number, compact = false): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₹${abs.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PnlText({ v, compact }: { v: number; compact?: boolean }) {
  return (
    <span className={cn('tabular-nums font-bold', v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {v >= 0 ? '+' : ''}{fmtINR(v, compact)}
    </span>
  );
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

function buildWeeklyBuckets(fromDate: string, toDate: string, byDate: Map<string, DailyPnlPoint>): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const dow = dayOfWeekUTC(cursor); // 0=Sun..6=Sat
    const daysToSunday = dow === 0 ? 0 : 7 - dow;
    let end = addDaysUTC(cursor, daysToSunday);
    if (end > toDate) end = toDate;

    let tradeCount = 0, grossPnl = 0, netPnl = 0, charges = 0, statutoryCharges = 0;
    let d = cursor;
    while (d <= end) {
      const pt = byDate.get(d);
      if (pt) { tradeCount += pt.tradeCount; grossPnl += pt.grossPnl; netPnl += pt.netPnl; charges += pt.charges; statutoryCharges += pt.statutoryCharges; }
      d = addDaysUTC(d, 1);
    }

    const sameMonth = cursor.slice(0, 7) === end.slice(0, 7);
    const label = sameMonth
      ? `${fmtShort(cursor)} - ${end.slice(8, 10)}`
      : `${fmtShort(cursor)} - ${fmtShort(end)}`;

    buckets.push({ label, startDate: cursor, endDate: end, tradeCount, grossPnl: round2(grossPnl), netPnl: round2(netPnl), charges: round2(charges), statutoryCharges: round2(statutoryCharges) });
    cursor = addDaysUTC(end, 1);
  }
  return buckets;
}

function buildMonthlyBuckets(fromDate: string, toDate: string, byDate: Map<string, DailyPnlPoint>): Bucket[] {
  const map = new Map<string, Bucket>();
  let cursor = fromDate;
  while (cursor <= toDate) {
    const key = monthKey(cursor);
    if (!map.has(key)) {
      map.set(key, { label: monthLabel(key), startDate: cursor, endDate: cursor, tradeCount: 0, grossPnl: 0, netPnl: 0, charges: 0, statutoryCharges: 0 });
    }
    const b = map.get(key)!;
    b.endDate = cursor;
    const pt = byDate.get(cursor);
    if (pt) { b.tradeCount += pt.tradeCount; b.grossPnl += pt.grossPnl; b.netPnl += pt.netPnl; b.charges += pt.charges; b.statutoryCharges += pt.statutoryCharges; }
    cursor = addDaysUTC(cursor, 1);
  }
  return Array.from(map.values()).map(b => ({ ...b, grossPnl: round2(b.grossPnl), netPnl: round2(b.netPnl), charges: round2(b.charges), statutoryCharges: round2(b.statutoryCharges) }));
}

function buildYearlyBuckets(fromDate: string, toDate: string, byDate: Map<string, DailyPnlPoint>): Bucket[] {
  const map = new Map<string, Bucket>();
  let cursor = fromDate;
  while (cursor <= toDate) {
    const key = yearKey(cursor);
    if (!map.has(key)) {
      map.set(key, { label: key, startDate: cursor, endDate: cursor, tradeCount: 0, grossPnl: 0, netPnl: 0, charges: 0, statutoryCharges: 0 });
    }
    const b = map.get(key)!;
    b.endDate = cursor;
    const pt = byDate.get(cursor);
    if (pt) { b.tradeCount += pt.tradeCount; b.grossPnl += pt.grossPnl; b.netPnl += pt.netPnl; b.charges += pt.charges; b.statutoryCharges += pt.statutoryCharges; }
    cursor = addDaysUTC(cursor, 1);
  }
  return Array.from(map.values()).map(b => ({ ...b, grossPnl: round2(b.grossPnl), netPnl: round2(b.netPnl), charges: round2(b.charges), statutoryCharges: round2(b.statutoryCharges) }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Merge two per-date P&L series (e.g. FNO + COMMODITY) into one, summing overlapping dates.
function mergeDailyPnl(...series: DailyPnlPoint[][]): DailyPnlPoint[] {
  const byDate = new Map<string, DailyPnlPoint>();
  for (const pts of series) {
    for (const pt of pts) {
      const existing = byDate.get(pt.date);
      if (existing) {
        existing.grossPnl += pt.grossPnl;
        existing.charges += pt.charges;
        existing.statutoryCharges += pt.statutoryCharges;
        existing.netPnl += pt.netPnl;
        existing.tradeCount += pt.tradeCount;
      } else {
        byDate.set(pt.date, { ...pt });
      }
    }
  }
  return Array.from(byDate.values())
    .map(pt => ({ ...pt, grossPnl: round2(pt.grossPnl), charges: round2(pt.charges), statutoryCharges: round2(pt.statutoryCharges), netPnl: round2(pt.netPnl) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Stats (streaks/in-profit use GROSS P&L per day — verified against Dhan's own Trader's Diary:
// "most profitable day", "in-profit days", and "winning streak" all matched exactly using gross,
// while only the headline total is net-of-charges) ─────────────────────────────────────────────

function computeStats(dailyPnl: DailyPnlPoint[]) {
  const traded = dailyPnl.filter(d => d.tradeCount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const netTotal = round2(dailyPnl.reduce((s, d) => s + d.netPnl, 0));
  let mostProfitable: DailyPnlPoint | null = null;
  for (const d of traded) {
    if (!mostProfitable || d.grossPnl > mostProfitable.grossPnl) mostProfitable = d;
  }
  const inProfitDays = traded.filter(d => d.grossPnl > 0).length;

  let winningStreak = 0, run = 0;
  for (const d of traded) {
    if (d.grossPnl > 0) { run += 1; winningStreak = Math.max(winningStreak, run); }
    else run = 0;
  }
  let currentStreak = 0;
  for (let i = traded.length - 1; i >= 0; i--) {
    if (traded[i].grossPnl > 0) currentStreak += 1;
    else break;
  }

  return { netTotal, mostProfitable, tradedOn: traded.length, inProfitDays, winningStreak, currentStreak };
}

// ─── Stat chip ────────────────────────────────────────────────────────────────

function StatChip({ value, label, color }: { value: number | string; label: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={cn('h-9 w-9 flex items-center justify-center rounded-lg border text-sm font-bold tabular-nums', color)}>
        {value}
      </div>
      <span className="text-[9px] text-zinc-500 text-center">{label}</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = 'yearly' | 'weekly' | 'monthly' | 'daily' | 'chart';

type ChartMetric = 'grossPnl' | 'netPnl' | 'charges' | 'brokerage' | 'totalCharges';

const CHART_METRICS: { key: ChartMetric; label: string; color: string }[] = [
  { key: 'grossPnl', label: 'Overall P&L', color: '#10b981' },
  { key: 'netPnl', label: 'Net P&L', color: '#38bdf8' },
  { key: 'charges', label: 'Charges', color: '#a78bfa' },
  { key: 'brokerage', label: 'Brokerage', color: '#f472b6' },
  { key: 'totalCharges', label: 'Total Charges', color: '#f59e0b' },
];

export default function PortfolioDiaryDashboard() {
  const [data, setData] = useState<TradeHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('weekly');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [segment, setSegment] = useState<'ALL' | 'EQUITY' | 'FNO' | 'COMMODITY' | 'TRADING' | 'INVESTING'>('ALL');
  const [chartMetric, setChartMetric] = useState<ChartMetric>('netPnl');

  const fetchData = useCallback(() => {
    fetch('/api/portfolio-trades')
      .then(r => r.json())
      .then(resp => {
        setData(resp);
        if (resp.dailyPnl?.length) {
          const lastDate = resp.dailyPnl[resp.dailyPnl.length - 1].date;
          setSelectedMonth(monthKey(lastDate));
          setSelectedYear(yearKey(lastDate));
        }
      })
      .catch(() => setData({ success: false, available: false }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const { syncing, syncError, startSync } = useTradeSync(fetchData);

  const dailyPnl = useMemo(() => {
    if (segment === 'TRADING') {
      return mergeDailyPnl(data?.dailyPnlBySegment?.FNO ?? [], data?.dailyPnlBySegment?.COMMODITY ?? []);
    }
    if (segment === 'INVESTING') {
      return data?.dailyPnlBySegment?.EQUITY ?? [];
    }
    return data?.dailyPnlBySegment?.[segment] ?? data?.dailyPnl ?? [];
  }, [data, segment]);
  const byDate = useMemo(() => new Map(dailyPnl.map(d => [d.date, d])), [dailyPnl]);
  const stats = useMemo(() => computeStats(dailyPnl), [dailyPnl]);

  const weeklyBuckets = useMemo(
    () => (data?.fromDate && data?.toDate ? buildWeeklyBuckets(data.fromDate, data.toDate, byDate) : []),
    [data, byDate],
  );
  const monthlyBuckets = useMemo(
    () => (data?.fromDate && data?.toDate ? buildMonthlyBuckets(data.fromDate, data.toDate, byDate) : []),
    [data, byDate],
  );
  const monthKeys = useMemo(() => monthlyBuckets.map(b => monthKey(b.startDate)), [monthlyBuckets]);
  const yearlyBuckets = useMemo(
    () => (data?.fromDate && data?.toDate ? buildYearlyBuckets(data.fromDate, data.toDate, byDate) : []),
    [data, byDate],
  );
  const yearKeys = useMemo(() => yearlyBuckets.map(b => yearKey(b.startDate)), [yearlyBuckets]);
  const monthlyByKey = useMemo(() => new Map(monthlyBuckets.map(b => [monthKey(b.startDate), b])), [monthlyBuckets]);

  // Render all weeks side-by-side in a single row

  const fyLabel = data?.fromDate ? `${data.fromDate.slice(0, 4)}-${(parseInt(data.fromDate.slice(0, 4)) + 1).toString().slice(2)}` : '';

  // Day-of-month calendar grid for the Monthly tab
  const monthGrid = useMemo(() => {
    if (!selectedMonth) return null;
    const [y, m] = selectedMonth.split('-').map(Number);
    const firstOfMonth = new Date(Date.UTC(y, m - 1, 1));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const firstDow = firstOfMonth.getUTCDay(); // 0=Sun
    const leadBlanks = firstDow === 0 ? 6 : firstDow - 1; // Mon-start grid
    const cells: (string | null)[] = Array(leadBlanks).fill(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push(`${selectedMonth}-${String(day).padStart(2, '0')}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [selectedMonth]);

  // Day-by-day calendar grid for the Daily tab (horizontal scrollable grid)
  const dailyGrid = useMemo(() => {
    if (!data?.fromDate || !data?.toDate) return null;
    const start = toUTCDate(data.fromDate);
    const startDow = start.getUTCDay();
    const startOffset = startDow === 0 ? 6 : startDow - 1; // Mon-start
    const gridStart = new Date(start.getTime() - startOffset * 24 * 60 * 60 * 1000);

    const end = toUTCDate(data.toDate);
    const endDow = end.getUTCDay();
    const endOffset = endDow === 0 ? 0 : 7 - endDow;
    const gridEnd = new Date(end.getTime() + endOffset * 24 * 60 * 60 * 1000);

    const cells: string[] = [];
    const curr = new Date(gridStart.getTime());
    while (curr <= gridEnd) {
      cells.push(fromUTCDate(curr));
      curr.setUTCDate(curr.getUTCDate() + 1);
    }
    return cells;
  }, [data]);

  const selectedMonthStats = useMemo(() => {
    if (!selectedMonth) return null;
    const monthDaily = dailyPnl.filter(d => monthKey(d.date) === selectedMonth);
    return computeStats(monthDaily);
  }, [dailyPnl, selectedMonth]);

  const monthIdx = selectedMonth ? monthKeys.indexOf(selectedMonth) : -1;

  const selectedYearStats = useMemo(() => {
    if (!selectedYear) return null;
    const yearDaily = dailyPnl.filter(d => yearKey(d.date) === selectedYear);
    return computeStats(yearDaily);
  }, [dailyPnl, selectedYear]);

  const yearIdx = selectedYear ? yearKeys.indexOf(selectedYear) : -1;

  // Chart tab: only traded days, sorted chronologically, with a cumulative running total per metric
  const chartData = useMemo(() => {
    const traded = [...dailyPnl].filter(d => d.tradeCount > 0).sort((a, b) => a.date.localeCompare(b.date));
    let cumGross = 0, cumNet = 0, cumCharges = 0, cumStatutory = 0, cumBrokerage = 0;
    return traded.map(d => {
      const brokerage = d.charges - d.statutoryCharges;
      cumGross += d.grossPnl;
      cumNet += d.netPnl;
      cumCharges += d.charges;
      cumStatutory += d.statutoryCharges;
      cumBrokerage += brokerage;
      return {
        date: d.date,
        grossPnl: round2(cumGross),
        netPnl: round2(cumNet),
        charges: round2(cumStatutory),
        brokerage: round2(cumBrokerage),
        totalCharges: round2(cumCharges),
      };
    });
  }, [dailyPnl]);

  const activeChartMetric = CHART_METRICS.find(m => m.key === chartMetric)!;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-200">
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 sticky top-0 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center shadow-md shadow-amber-500/10 shrink-0">
            <BookOpen className="h-4 w-4 text-black" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">Trader's Diary</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {data?.fromDate ? `${data.fromDate} → ${data.toDate}` : 'Loading…'}
            </p>
          </div>
        </div>
        <NavBar />
        <button
          onClick={startSync}
          disabled={syncing || !data?.available}
          title="Fetch new days' trades and update totals (incremental — a few seconds)"
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </header>

      {syncError && (
        <div className="w-full border-b border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[11px] text-red-400">
          {syncError}
        </div>
      )}

      <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
        <Link href="/portfolio" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Portfolio</Link>
        <Link href="/portfolio/trades" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Trade P&amp;L</Link>
        <Link href="/reports" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Reports</Link>
      </div>

      <main className="flex-1 w-full mx-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-amber-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Loading trade diary…</span>
          </div>
        ) : !data?.available || dailyPnl.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px] gap-3">
            <BookOpen className="h-8 w-8 text-zinc-700" />
            <p className="text-sm font-semibold text-zinc-300">No diary data yet</p>
            <p className="text-xs text-zinc-600 max-w-md text-center">
              Run "Trade P&amp;L by Segment" from Reports to generate the trade history this diary is built from.
            </p>
            <Link href="/reports" className="mt-1 px-4 py-1.5 text-xs font-semibold bg-amber-950/40 border border-amber-800 text-amber-400 rounded-lg hover:bg-amber-900/40 transition-all">
              Go to Reports
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[10px] text-zinc-600 leading-relaxed">
              F&amp;O/Commodity P&amp;L is FIFO-matched (same-day round trips, no cost-basis ambiguity). Equity
              uses day-priority matching (same-day buys against same-day sells first, remainder against the
              carried position at weighted-average cost) — the convention that reproduces Dhan's own
              "Trader's Diary" most closely: July 2026 matched to within ₹1; trade counts and charges match
              every month to the paisa. A small residual (±~₹1K) can appear on months where a position sold
              across two months was lot-allocated differently by Dhan — the totals agree, only the monthly
              split shifts.
            </p>
            {/* Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Tabs */}
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                {(['yearly', 'weekly', 'monthly', 'daily', 'chart'] as Tab[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      'px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all capitalize',
                      tab === t ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Segment Selector Slider-Box */}
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                {(['ALL', 'EQUITY', 'FNO', 'COMMODITY'] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setSegment(s)}
                    className={cn(
                      'px-3.5 py-1.5 text-[10px] font-semibold rounded-md transition-all uppercase tracking-wider',
                      segment === s ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400 font-bold' : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                    )}
                  >
                    {s === 'FNO' ? 'F&O' : s}
                  </button>
                ))}
              </div>

              {/* Trading vs Investing quick-filter */}
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                {([
                  { key: 'TRADING', label: 'Trading', title: 'F&O + Commodity' },
                  { key: 'INVESTING', label: 'Investing', title: 'Equity' },
                ] as const).map(o => (
                  <button
                    key={o.key}
                    onClick={() => setSegment(o.key)}
                    title={o.title}
                    className={cn(
                      'px-3.5 py-1.5 text-[10px] font-semibold rounded-md transition-all uppercase tracking-wider',
                      segment === o.key ? 'bg-sky-500/15 border border-sky-500/30 text-sky-400 font-bold' : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                    )}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Stats header — scoped to full range on Weekly tab, selected month/year on Monthly/Yearly tabs */}
            {(() => {
              const s = tab === 'monthly' && selectedMonthStats ? selectedMonthStats
                : tab === 'yearly' && selectedYearStats ? selectedYearStats
                : stats;
              const scopeLabel = tab === 'monthly' && selectedMonth ? monthLabel(selectedMonth)
                : tab === 'yearly' && selectedYear ? selectedYear
                : `since ${data.fromDate}`;
              const marketDates = data.marketTradingDates ?? [];
              const tradingDaysCount = tab === 'monthly' && selectedMonth
                ? marketDates.filter(d => monthKey(d) === selectedMonth).length
                : tab === 'yearly' && selectedYear
                ? marketDates.filter(d => yearKey(d) === selectedYear).length
                : marketDates.length;
              return (
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-8 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-500">Net Realised P&amp;L:</span>
                      <PnlText v={s.netTotal} />
                      <span className="text-[10px] text-zinc-600">{scopeLabel}</span>
                    </div>
                    {s.mostProfitable && (
                      <div className="flex items-center gap-1.5">
                        <Award className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-[11px] text-zinc-500">Most Profitable:</span>
                        <span className="text-emerald-400 font-bold text-[11px]">{fmtINR(s.mostProfitable.grossPnl)}</span>
                        <span className="text-[10px] text-zinc-600">on {fmtShort(s.mostProfitable.date)}</span>
                      </div>
                    )}
                    {stats.mostProfitable && (
                      <div className="flex items-center gap-1.5">
                        <PartyPopper className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-[11px] text-zinc-500">Most Profitable (all time):</span>
                        <span className="text-emerald-400 font-bold text-[11px]">{fmtINR(stats.mostProfitable.grossPnl)}</span>
                        <span className="text-[10px] text-zinc-600">on {fmtShort(stats.mostProfitable.date)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-6 flex-wrap">
                    <StatChip value={tradingDaysCount || '—'} label="Trading Days" color="border-violet-500/40 text-violet-300 bg-violet-500/5" />
                    <StatChip value={s.tradedOn} label="Traded On" color="border-amber-500/40 text-amber-300 bg-amber-500/5" />
                    <StatChip value={s.inProfitDays} label="In-Profit Days" color="border-emerald-500/40 text-emerald-300 bg-emerald-500/5" />
                    <StatChip value={s.winningStreak} label="Winning Streak" color="border-blue-500/40 text-blue-300 bg-blue-500/5" />
                    <StatChip value={s.currentStreak} label="Current Streak" color="border-blue-500/40 text-blue-300 bg-blue-500/5" />
                  </div>
                </div>
              );
            })()}

            {tab === 'yearly' ? (
              <>
                {/* Month-of-year calendar */}
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 w-fit">
                  <div className="flex items-center justify-between mb-3 gap-4">
                    <button
                      onClick={() => yearIdx > 0 && setSelectedYear(yearKeys[yearIdx - 1])}
                      disabled={yearIdx <= 0}
                      className="p-1 rounded border border-zinc-800 text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-800/50"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-[11px] font-semibold text-zinc-300">{selectedYear ?? ''}</span>
                    <button
                      onClick={() => yearIdx >= 0 && yearIdx < yearKeys.length - 1 && setSelectedYear(yearKeys[yearIdx + 1])}
                      disabled={yearIdx < 0 || yearIdx >= yearKeys.length - 1}
                      className="p-1 rounded border border-zinc-800 text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-800/50"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-2 w-fit" style={{ gridTemplateColumns: 'repeat(4, 64px)' }}>
                    {Array.from({ length: 12 }, (_, i) => {
                      const key = selectedYear ? `${selectedYear}-${String(i + 1).padStart(2, '0')}` : null;
                      const b = key ? monthlyByKey.get(key) : null;
                      const monthName = new Date(Date.UTC(2000, i, 1)).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
                      return (
                        <button
                          key={i}
                          disabled={!b}
                          onClick={() => { if (key) { setSelectedMonth(key); setTab('monthly'); } }}
                          title={b ? `${fmtINR(b.netPnl)} net (${b.tradeCount} trades)` : undefined}
                          className={cn(
                            'h-12 rounded flex flex-col items-center justify-center text-[10px] font-bold border transition-all duration-150',
                            !b || b.tradeCount === 0 ? 'bg-zinc-900 border-zinc-800 text-zinc-500' :
                            b.grossPnl > 0.005 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20' :
                            b.grossPnl < -0.005 ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20' :
                            'bg-zinc-800 border-zinc-700 text-zinc-300',
                          )}
                        >
                          {monthName}
                        </button>
                      );
                    })}
                  </div>
                  {selectedYearStats && (
                    <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <Flame className="h-3 w-3 text-amber-500" />
                      Total days you're profitable for: <span className="text-amber-400 font-semibold">{selectedYearStats.inProfitDays}/{selectedYearStats.tradedOn} traded days</span>
                    </div>
                  )}
                </div>

                {/* Yearly trades table */}
                <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                  <table className="w-full border-collapse">
                    <thead className="bg-zinc-800">
                      <tr>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Year</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">No. of Trades</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Overall P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Net P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Brokerage</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyBuckets.map(y => (
                        <tr
                          key={y.startDate}
                          onClick={() => setSelectedYear(yearKey(y.startDate))}
                          className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors cursor-pointer"
                        >
                          <td className="py-[6px] px-2 text-[12px] text-white font-medium">{y.label}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{y.tradeCount}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={y.grossPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={y.netPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(y.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(y.charges - y.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(y.charges)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : tab === 'weekly' ? (
              <>
                {/* Weekly calendar grid */}
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 w-full">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[11px] font-semibold text-zinc-300">Weekly P&amp;L Calendar ({weeklyBuckets.length} Weeks of FY {fyLabel})</span>
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <div className="flex gap-1.5 w-max select-none">
                      {weeklyBuckets.map((w, i) => {
                        const idx = i + 1;
                        const hasTrades = w.tradeCount > 0;
                        return (
                          <div
                            key={w.startDate}
                            title={`${w.label}: ${fmtINR(w.netPnl)} net (${w.tradeCount} trades)`}
                            className={cn(
                              'w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold border transition-all duration-150 shrink-0',
                              !hasTrades ? 'bg-zinc-900 border-zinc-800 text-zinc-600' :
                              w.grossPnl > 0.005 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                              w.grossPnl < -0.005 ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                              'bg-zinc-800 border-zinc-700 text-zinc-300',
                            )}
                          >
                            {idx}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-500">
                    <Flame className="h-3 w-3 text-amber-500" />
                    Total days you're profitable for: <span className="text-amber-400 font-semibold">{stats.inProfitDays}/{stats.tradedOn} traded days</span>
                  </div>
                </div>

                {/* Weekly trades table */}
                <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                  <table className="w-full border-collapse">
                    <thead className="bg-zinc-800">
                      <tr>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Week</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">No. of Trades</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Overall P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Net P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Brokerage</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyBuckets.map(w => (
                        <tr key={w.startDate} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                          <td className="py-[6px] px-2 text-[12px] text-white font-medium">{w.label}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{w.tradeCount}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={w.grossPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={w.netPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(w.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(w.charges - w.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(w.charges)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : tab === 'monthly' ? (
              <>
                {/* Day-of-month calendar */}
                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 w-fit">
                  <div className="flex items-center justify-between mb-3 gap-4">
                    <button
                      onClick={() => monthIdx > 0 && setSelectedMonth(monthKeys[monthIdx - 1])}
                      disabled={monthIdx <= 0}
                      className="p-1 rounded border border-zinc-800 text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-800/50"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-[11px] font-semibold text-zinc-300">{selectedMonth ? monthLabel(selectedMonth) : ''}</span>
                    <button
                      onClick={() => monthIdx >= 0 && monthIdx < monthKeys.length - 1 && setSelectedMonth(monthKeys[monthIdx + 1])}
                      disabled={monthIdx < 0 || monthIdx >= monthKeys.length - 1}
                      className="p-1 rounded border border-zinc-800 text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-zinc-800/50"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-1.5 mb-1.5 w-fit" style={{ gridTemplateColumns: 'repeat(7, 24px)' }}>
                    {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(d => (
                      <div key={d} className="w-6 text-center text-[10px] text-zinc-500 font-medium select-none">{d}</div>
                    ))}
                  </div>
                  <div className="grid gap-1.5 w-fit" style={{ gridTemplateColumns: 'repeat(7, 24px)' }}>
                    {monthGrid?.map((date, i) => {
                      const pt = date ? byDate.get(date) : null;
                      const dayNum = date ? Number(date.slice(8, 10)) : null;
                      return (
                        <div
                          key={i}
                          title={pt ? `${fmtINR(pt.netPnl)} net (${pt.tradeCount} trades)` : undefined}
                          className={cn(
                            'w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold border transition-all duration-150',
                            !date ? 'border-transparent' :
                            !pt || pt.tradeCount === 0 ? 'bg-zinc-900 border-zinc-800 text-zinc-500' :
                            pt.grossPnl > 0.005 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                            pt.grossPnl < -0.005 ? 'bg-red-500/10 border-red-500/30 text-red-400' :
                            'bg-zinc-800 border-zinc-700 text-zinc-300',
                          )}
                        >
                          {dayNum}
                        </div>
                      );
                    })}
                  </div>
                  {selectedMonthStats && (
                    <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <Flame className="h-3 w-3 text-amber-500" />
                      Total days you're profitable for: <span className="text-amber-400 font-semibold">{selectedMonthStats.inProfitDays}/{selectedMonthStats.tradedOn} traded days</span>
                    </div>
                  )}
                </div>

                {/* Monthly trades table */}
                <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                  <table className="w-full border-collapse">
                    <thead className="bg-zinc-800">
                      <tr>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Month</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">No. of Trades</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Overall P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Net P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Brokerage</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyBuckets.map(m => (
                        <tr
                          key={m.startDate}
                          onClick={() => setSelectedMonth(monthKey(m.startDate))}
                          className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors cursor-pointer"
                        >
                          <td className="py-[6px] px-2 text-[12px] text-white font-medium">{m.label}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{m.tradeCount}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={m.grossPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={m.netPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(m.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(m.charges - m.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(m.charges)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : tab === 'daily' ? (
              <>
                {/* Daily calendar map */}
                {dailyGrid && dailyGrid.length > 0 && (
                  <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 mb-4">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-[11px] font-semibold text-zinc-300">Daily P&amp;L Calendar Map</span>
                      <span className="text-[10px] text-zinc-500">
                        {fmtShort(dailyGrid[0])} — {fmtShort(dailyGrid[dailyGrid.length - 1])}
                      </span>
                    </div>

                    <div className="flex items-end overflow-x-auto pb-2">
                      {/* Weekday labels */}
                      <div className="grid text-[11px] text-zinc-500 pr-2 select-none mb-1 shrink-0" style={{ gridTemplateRows: 'repeat(7, 24px)', gap: '4px' }}>
                        <span className="flex items-center">Mon</span>
                        <span></span>
                        <span className="flex items-center">Wed</span>
                        <span></span>
                        <span className="flex items-center">Fri</span>
                        <span></span>
                        <span className="flex items-center">Sun</span>
                      </div>

                      {/* Grid container */}
                      <div className="flex-1 min-w-0">
                        {/* Month labels */}
                        <div className="grid gap-1 mb-1.5 select-none h-4 relative" style={{ gridTemplateColumns: `repeat(${Math.ceil(dailyGrid.length / 7)}, 24px)` }}>
                          {Array.from({ length: Math.ceil(dailyGrid.length / 7) }).map((_, i) => {
                            const dateStr = dailyGrid[i * 7];
                            const prevDateStr = i > 0 ? dailyGrid[(i - 1) * 7] : null;
                            const isNewMonth = !prevDateStr || dateStr.slice(5, 7) !== prevDateStr.slice(5, 7);
                            return (
                              <div key={i} className="text-[11px] text-zinc-400 font-semibold relative h-full">
                                {isNewMonth && (
                                  <span className="absolute left-0 top-0 whitespace-nowrap overflow-visible text-zinc-300">
                                    {toUTCDate(dateStr).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Days grid */}
                        <div className="grid grid-flow-col gap-1" style={{ gridTemplateRows: 'repeat(7, 24px)', gridTemplateColumns: `repeat(${Math.ceil(dailyGrid.length / 7)}, 24px)` }}>
                          {dailyGrid.map((date) => {
                            const pt = byDate.get(date);
                            const hasTrades = pt && pt.tradeCount > 0;
                            return (
                              <div
                                key={date}
                                title={pt && hasTrades ? `${fmtINR(pt.netPnl)} net (${pt.tradeCount} trades) on ${fmtShort(date)}` : `${fmtShort(date)}`}
                                className={cn(
                                  'w-6 h-6 rounded-[2px] border transition-all duration-150',
                                  !hasTrades ? 'bg-zinc-950 border-zinc-900/60' :
                                  pt.grossPnl > 0.005 ? 'bg-emerald-500/20 border-emerald-500/40 hover:bg-emerald-500/30' :
                                  pt.grossPnl < -0.005 ? 'bg-red-500/20 border-red-500/40 hover:bg-red-500/30' :
                                  'bg-zinc-800 border-zinc-700 text-zinc-300',
                                )}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-4 text-[10px] text-zinc-500 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <Flame className="h-3 w-3 text-amber-500" />
                        Total profitable days: <span className="text-amber-400 font-semibold">{stats.inProfitDays}/{stats.tradedOn} traded days</span>
                      </div>
                      <div className="flex items-center gap-2 ml-auto text-[10px]">
                        <span>Less</span>
                        <div className="w-6 h-6 rounded-[2px] bg-zinc-950 border-zinc-900/60" title="No trades" />
                        <div className="w-6 h-6 rounded-[2px] bg-red-500/20 border-red-500/40" title="Loss day" />
                        <div className="w-6 h-6 rounded-[2px] bg-emerald-500/20 border-emerald-500/40" title="Profit day" />
                        <span>More</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Daily trades table */}
                <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
                  <table className="w-full border-collapse">
                    <thead className="bg-zinc-800">
                      <tr>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-left">Date</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">No. of Trades</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Overall P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Net P&amp;L</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Charges</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Brokerage</th>
                        <th style={{ color: '#fff' }} className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...dailyPnl].reverse().map(d => (
                        <tr key={d.date} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                          <td className="py-[6px] px-2 text-[12px] text-white font-medium">{fmtDateLong(d.date)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{d.tradeCount}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={d.grossPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right"><PnlText v={d.netPnl} /></td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(d.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(d.charges - d.statutoryCharges)}</td>
                          <td className="py-[6px] px-2 text-[12px] text-right text-zinc-400 tabular-nums">{fmtINR(d.charges)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                {/* Chart tab: cumulative running total for the selected metric, traded days only */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-zinc-600 uppercase tracking-wide flex items-center gap-1.5">
                    <LineChartIcon className="h-3 w-3" /> Metric
                  </span>
                  <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                    {CHART_METRICS.map(m => (
                      <button
                        key={m.key}
                        onClick={() => setChartMetric(m.key)}
                        className={cn(
                          'px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all',
                          chartMetric === m.key ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300',
                        )}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
                  <div className="text-[11px] font-semibold text-zinc-300 mb-3">
                    Cumulative {activeChartMetric.label} over time
                  </div>
                  {chartData.length === 0 ? (
                    <div className="flex items-center justify-center h-64 text-xs text-zinc-600">No trades in range</div>
                  ) : (
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 9, fill: '#71717a' }}
                            tickFormatter={fmtShort}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fontSize: 9, fill: '#71717a' }}
                            tickFormatter={v => fmtINR(v, true)}
                            width={56}
                          />
                          <Tooltip
                            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                            labelStyle={{ color: '#a1a1aa' }}
                            labelFormatter={(d: any) => fmtDateLong(String(d))}
                            formatter={(v: unknown) => [fmtINR(v as number), activeChartMetric.label]}
                          />
                          <ReferenceLine y={0} stroke="#52525b" strokeDasharray="4 2" />
                          <Line
                            type="monotone"
                            dataKey={chartMetric}
                            name={activeChartMetric.label}
                            stroke={activeChartMetric.color}
                            dot={false}
                            strokeWidth={1.5}
                            isAnimationActive={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
