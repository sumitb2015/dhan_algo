'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BookOpen, RefreshCw, Award, PartyPopper, ChevronLeft, ChevronRight, Flame, LineChart as LineChartIcon } from 'lucide-react';
import { LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
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
  // Kotak-only. Its Gain/Loss export aggregates per scrip over a DATE RANGE and carries no per-trade
  // date, so a multi-day export cannot be split into daily points — it becomes one point stamped at
  // the range's end date with approx=true. Exact when the export covers a single day.
  approx?: boolean;
  spanDays?: number;
  fromDate?: string;
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

interface KotakPeriod {
  sourceFile: string;
  fromDate: string;
  toDate: string;
  spanDays: number;
  daily: boolean;
  grossPnl: number;
  charges: number;
  netPnl: number;
  tradeCount: number;
  reconciled: boolean;
}

interface KotakResponse {
  success: boolean;
  available: boolean;
  fromDate?: string;
  toDate?: string;
  clientCode?: string | null;
  periodCount?: number;
  exactPeriodCount?: number;
  approxPeriodCount?: number;
  tradedDayCount?: number;
  segments?: string[];
  openAtEnd?: Record<string, number>;
  totalGrossPnl?: number;
  totalCharges?: number;
  totalNetPnl?: number;
  periods?: KotakPeriod[];
  dailyPnl?: DailyPnlPoint[];
  dailyPnlBySegment?: Record<string, DailyPnlPoint[]>;
  marketTradingDates?: string[];
  pendingFiles?: string[];
  reportDir?: string;
  skipped?: { sourceFile: string; reason: string }[];
  failures?: { sourceFile: string; error: string }[];
}

type BrokerView = 'DHAN' | 'KOTAK' | 'COMBINED';

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

interface WeekdayStat {
  dow: number;
  label: string;
  totalGross: number;
  totalNet: number;
  avgGross: number;
  totalTrades: number;
  tradedDays: number;
  winDays: number;
  winRate: number;
}

// Aggregate P&L by day-of-week (Mon-Fri) to surface which weekday trades best overall.
function computeWeekdayStats(dailyPnl: DailyPnlPoint[]): WeekdayStat[] {
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets = Array.from({ length: 7 }, (_, i) => ({
    dow: i, label: labels[i], totalGross: 0, totalNet: 0, totalTrades: 0, tradedDays: 0, winDays: 0,
  }));
  for (const d of dailyPnl) {
    if (d.tradeCount === 0) continue;
    const b = buckets[dayOfWeekUTC(d.date)];
    b.totalGross += d.grossPnl;
    b.totalNet += d.netPnl;
    b.totalTrades += d.tradeCount;
    b.tradedDays += 1;
    if (d.grossPnl > 0) b.winDays += 1;
  }
  return buckets
    .filter(b => b.dow >= 1 && b.dow <= 5)
    .map(b => ({
      ...b,
      totalGross: round2(b.totalGross),
      totalNet: round2(b.totalNet),
      avgGross: b.tradedDays ? round2(b.totalGross / b.tradedDays) : 0,
      winRate: b.tradedDays ? Math.round((b.winDays / b.tradedDays) * 100) : 0,
    }));
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
  const [kotak, setKotak] = useState<KotakResponse | null>(null);
  const [broker, setBroker] = useState<BrokerView>('DHAN');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('weekly');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [segment, setSegment] = useState<'ALL' | 'EQUITY' | 'FNO' | 'COMMODITY' | 'TRADING' | 'INVESTING'>('ALL');
  const [chartMetric, setChartMetric] = useState<ChartMetric>('netPnl');
  const [weekdayMetric, setWeekdayMetric] = useState<'totalGross' | 'totalNet' | 'totalTrades'>('totalNet');

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

  const fetchKotak = useCallback(() => {
    fetch('/api/kotak-pnl')
      .then(r => r.json())
      .then(setKotak)
      .catch(() => setKotak({ success: false, available: false }));
  }, []);

  useEffect(() => { fetchData(); fetchKotak(); }, [fetchData, fetchKotak]);

  const { syncing, syncError, startSync } = useTradeSync(fetchData);

  // Re-parses every export in debug/kotak_pnl_reports/. Local file parse, no broker call.
  const runKotakImport = useCallback(async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await fetch('/api/kotak-pnl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import' }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) {
        setImportMsg(j.error ?? 'Kotak import failed');
      } else {
        setImportMsg(`Imported ${j.periods} period(s) from ${j.files} file(s)${j.skipped ? `, ${j.skipped} skipped` : ''}${j.failures ? `, ${j.failures} failed` : ''}`);
        fetchKotak();
      }
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : 'Kotak import failed');
    } finally {
      setImporting(false);
    }
  }, [fetchKotak]);

  const dhanDaily = useMemo(() => {
    if (segment === 'TRADING') {
      return mergeDailyPnl(data?.dailyPnlBySegment?.FNO ?? [], data?.dailyPnlBySegment?.COMMODITY ?? []);
    }
    if (segment === 'INVESTING') {
      return data?.dailyPnlBySegment?.EQUITY ?? [];
    }
    return data?.dailyPnlBySegment?.[segment] ?? data?.dailyPnl ?? [];
  }, [data, segment]);

  // Mirrors the Dhan mapping above. A transaction-statement import carries a real segment per fill
  // (F&O vs MCX commodity), so these filters are meaningful rather than all-or-nothing; segments the
  // Kotak account never traded simply resolve to an empty series.
  const kotakDaily = useMemo(() => {
    const bySeg = kotak?.dailyPnlBySegment;
    if (segment === 'TRADING') return mergeDailyPnl(bySeg?.FNO ?? [], bySeg?.COMMODITY ?? []);
    if (segment === 'INVESTING') return bySeg?.EQUITY ?? [];
    if (segment === 'ALL') return kotak?.dailyPnl ?? [];
    return bySeg?.[segment] ?? [];
  }, [kotak, segment]);

  const dailyPnl = useMemo(() => {
    if (broker === 'DHAN') return dhanDaily;
    if (broker === 'KOTAK') return kotakDaily;
    return mergeDailyPnl(dhanDaily, kotakDaily);
  }, [broker, dhanDaily, kotakDaily]);

  const kotakAvailable = !!kotak?.available && (kotak.periodCount ?? 0) > 0;

  // Any Kotak point that came from a multi-day export is stamped at its range end. It is exact in
  // cumulative and total terms but not attributable to that one calendar day, so the day-level views
  // (daily grid, month calendar, day-of-week) carry a caveat whenever one is in scope.
  const hasApproxKotak = useMemo(
    () => broker !== 'DHAN' && kotakDaily.some(d => d.approx),
    [broker, kotakDaily],
  );
  // Bucket/grid extents must follow the selected broker — Kotak's history starts wherever its first
  // export does, which is unrelated to Dhan's reporting window.
  const [rangeFrom, rangeTo] = useMemo(() => {
    const dhanRange: [string?, string?] = [data?.fromDate, data?.toDate];
    const kotakRange: [string?, string?] = [kotak?.fromDate, kotak?.toDate];
    const pick: [string?, string?][] =
      broker === 'DHAN' ? [dhanRange] : broker === 'KOTAK' ? [kotakRange] : [dhanRange, kotakRange];
    const froms = pick.map(r => r[0]).filter(Boolean) as string[];
    const tos = pick.map(r => r[1]).filter(Boolean) as string[];
    return [
      froms.length ? froms.reduce((a, b) => (a < b ? a : b)) : undefined,
      tos.length ? tos.reduce((a, b) => (a > b ? a : b)) : undefined,
    ];
  }, [broker, data, kotak]);

  const byDate = useMemo(() => new Map(dailyPnl.map(d => [d.date, d])), [dailyPnl]);
  const stats = useMemo(() => computeStats(dailyPnl), [dailyPnl]);
  const weekdayStats = useMemo(() => computeWeekdayStats(dailyPnl), [dailyPnl]);
  const bestWeekday = useMemo(
    () => weekdayStats.reduce<WeekdayStat | null>((best, w) => (w.tradedDays > 0 && (!best || w[weekdayMetric] > best[weekdayMetric]) ? w : best), null),
    [weekdayStats, weekdayMetric],
  );

  const weeklyBuckets = useMemo(
    () => (rangeFrom && rangeTo ? buildWeeklyBuckets(rangeFrom, rangeTo, byDate) : []),
    [rangeFrom, rangeTo, byDate],
  );
  const monthlyBuckets = useMemo(
    () => (rangeFrom && rangeTo ? buildMonthlyBuckets(rangeFrom, rangeTo, byDate) : []),
    [rangeFrom, rangeTo, byDate],
  );
  const monthKeys = useMemo(() => monthlyBuckets.map(b => monthKey(b.startDate)), [monthlyBuckets]);
  const yearlyBuckets = useMemo(
    () => (rangeFrom && rangeTo ? buildYearlyBuckets(rangeFrom, rangeTo, byDate) : []),
    [rangeFrom, rangeTo, byDate],
  );
  const yearKeys = useMemo(() => yearlyBuckets.map(b => yearKey(b.startDate)), [yearlyBuckets]);
  const monthlyByKey = useMemo(() => new Map(monthlyBuckets.map(b => [monthKey(b.startDate), b])), [monthlyBuckets]);

  // Switching broker changes which months/years exist. Without this the Monthly/Yearly tabs keep a
  // selection outside the new range and render an empty scope with dead prev/next arrows.
  useEffect(() => {
    if (monthKeys.length && (!selectedMonth || !monthKeys.includes(selectedMonth))) {
      setSelectedMonth(monthKeys[monthKeys.length - 1]);
    }
  }, [monthKeys, selectedMonth]);
  useEffect(() => {
    if (yearKeys.length && (!selectedYear || !yearKeys.includes(selectedYear))) {
      setSelectedYear(yearKeys[yearKeys.length - 1]);
    }
  }, [yearKeys, selectedYear]);

  // Render all weeks side-by-side in a single row

  const fyLabel = rangeFrom ? `${rangeFrom.slice(0, 4)}-${(parseInt(rangeFrom.slice(0, 4)) + 1).toString().slice(2)}` : '';

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
    if (!rangeFrom || !rangeTo) return null;
    const start = toUTCDate(rangeFrom);
    const startDow = start.getUTCDay();
    const startOffset = startDow === 0 ? 6 : startDow - 1; // Mon-start
    const gridStart = new Date(start.getTime() - startOffset * 24 * 60 * 60 * 1000);

    const end = toUTCDate(rangeTo);
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
  }, [rangeFrom, rangeTo]);

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

  // Day-wise (non-cumulative) values per metric, for the bar chart under the cumulative line chart
  const dayWiseChartData = useMemo(() => {
    const traded = [...dailyPnl].filter(d => d.tradeCount > 0).sort((a, b) => a.date.localeCompare(b.date));
    return traded.map(d => ({
      date: d.date,
      grossPnl: round2(d.grossPnl),
      netPnl: round2(d.netPnl),
      charges: round2(d.statutoryCharges),
      brokerage: round2(d.charges - d.statutoryCharges),
      totalCharges: round2(d.charges),
    }));
  }, [dailyPnl]);

  const activeChartMetric = CHART_METRICS.find(m => m.key === chartMetric)!;


  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-200">
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 sticky top-0 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-amber-500 to-yellow-300 flex items-center justify-center shadow-md shadow-amber-500/10 shrink-0">
            <BookOpen className="h-4 w-4 text-oncolor-dark" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">Trader's Diary</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {rangeFrom ? `${rangeFrom} → ${rangeTo}` : 'Loading…'}
              {broker !== 'DHAN' && kotak?.clientCode ? ` · Kotak ${kotak.clientCode}` : ''}
            </p>
          </div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-2">
          {broker !== 'DHAN' && (
            <button
              onClick={runKotakImport}
              disabled={importing}
              title="Re-parse every Gain/Loss export in debug/kotak_pnl_reports/"
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', importing && 'animate-spin')} />
              {importing ? 'Importing…' : 'Import Kotak'}
            </button>
          )}
          {broker !== 'KOTAK' && (
            <button
              onClick={startSync}
              disabled={syncing || !data?.available}
              title="Fetch new days' trades and update totals (incremental — a few seconds)"
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
          )}
        </div>
      </header>

      {syncError && (
        <div className="w-full border-b border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[11px] text-red-400">
          {syncError}
        </div>
      )}

      {importMsg && (
        <div className="w-full border-b border-violet-900/40 bg-violet-950/20 px-4 py-1.5 text-[11px] text-violet-300">
          {importMsg}
        </div>
      )}

      {/* A dropped-but-unparsed export reads to the user as "loaded" — say so explicitly. */}
      {!!kotak?.pendingFiles?.length && (
        <div className="w-full border-b border-amber-900/40 bg-amber-950/20 px-4 py-1.5 text-[11px] text-amber-300">
          {kotak.pendingFiles.length} Kotak export(s) not yet imported: {kotak.pendingFiles.join(', ')} — click "Import Kotak".
        </div>
      )}

      {!!kotak?.failures?.length && (
        <div className="w-full border-b border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[11px] text-red-400">
          Kotak import failed for: {kotak.failures.map(f => `${f.sourceFile} (${f.error})`).join('; ')}
        </div>
      )}

      <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
        <Link href="/portfolio" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Portfolio</Link>
        <Link href="/portfolio/trades" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Trade P&amp;L</Link>
        <Link href="/portfolio/weekly-target" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Weekly Target</Link>
        <Link href="/portfolio/stats" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">P&amp;L Stats</Link>
        <Link href="/reports" className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-amber-300 hover:border-amber-500/30 transition-all">Reports</Link>
      </div>

      <main className="flex-1 w-full mx-auto px-4 py-4">
        {/* Banners and controls live OUTSIDE the loading/empty branches below: a broker or
            segment with no data must not hide the controls needed to switch away from it. */}
        {!loading && (
          <div className="flex flex-col gap-4 mb-4">
            {broker !== 'DHAN' && (
            <div className="text-[10px] leading-relaxed rounded-lg border border-violet-900/40 bg-violet-950/20 px-3 py-2 text-violet-300 flex flex-col gap-1">
              <span>
                <span className="font-bold">Kotak data comes from statement exports, not the broker API.</span>{' '}
                Kotak Neo has no historical trade endpoint — its trade report returns only the current day —
                so history cannot be synced, only imported from files in debug/kotak_pnl_reports/.
                {kotak?.exactPeriodCount ? (
                  <> A <span className="font-semibold">Transaction Statement</span> export is per-fill, so
                  P&amp;L is FIFO-matched per security and attributed to the actual closing-trade date —
                  the same method the Dhan side uses — across {kotak.tradedDayCount} traded day(s) and
                  segment(s) {(kotak.segments ?? []).join(' + ')}.</>
                ) : null}
              </span>
              {hasApproxKotak && (
                <span className="text-amber-300">
                  {kotak?.approxPeriodCount} Gain/Loss export(s) span multiple days. That format aggregates
                  per scrip over a date range with no per-trade date, so each is plotted as a single point at
                  its range end: totals and cumulative P&amp;L are exact, but the daily grid, month calendar,
                  day-of-week split and streaks are not day-accurate for those spans. Export a Transaction
                  Statement over the same range for exact daily attribution.
                </span>
              )}
              {!!kotak?.openAtEnd && Object.keys(kotak.openAtEnd).length > 0 && (
                <span className="text-amber-300">
                  {Object.keys(kotak.openAtEnd).length} security(ies) still hold open quantity at the end of
                  the imported window, meaning a position was opened before it and FIFO had no cost basis —
                  some P&amp;L is misattributed. Re-export starting earlier to clear this.
                </span>
              )}
            </div>
          )}
          {broker !== 'KOTAK' && (
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            F&amp;O/Commodity P&amp;L is FIFO-matched (same-day round trips, no cost-basis ambiguity). Equity
            uses day-priority matching (same-day buys against same-day sells first, remainder against the
            carried position at weighted-average cost) — the convention that reproduces Dhan's own
            "Trader's Diary" most closely: July 2026 matched to within ₹1; trade counts and charges match
            every month to the paisa. A small residual (±~₹1K) can appear on months where a position sold
            across two months was lot-allocated differently by Dhan — the totals agree, only the monthly
            split shifts.
          </p>
          )}
          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            {/* Broker Selector — scopes every tab, stat and chart below */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
              {([
                { key: 'DHAN', label: 'Dhan', title: 'Dhan account — synced from the broker trade API' },
                { key: 'KOTAK', label: 'Kotak', title: 'Kotak account — imported from Gain/Loss statement exports' },
                { key: 'COMBINED', label: 'Combined', title: 'Dhan + Kotak, summed per date' },
              ] as const).map(o => (
                <button
                  key={o.key}
                  onClick={() => setBroker(o.key)}
                  title={o.title}
                  disabled={o.key !== 'DHAN' && !kotakAvailable}
                  className={cn(
                    'px-3.5 py-1.5 text-[10px] font-semibold rounded-md transition-all uppercase tracking-wider',
                    broker === o.key
                      ? 'bg-violet-500/15 border border-violet-500/30 text-violet-300 font-bold'
                      : 'text-zinc-500 hover:text-zinc-300 border border-transparent',
                    o.key !== 'DHAN' && !kotakAvailable && 'opacity-40 cursor-not-allowed hover:text-zinc-500',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>

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
          </div>
        )}
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-amber-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Loading trade diary…</span>
          </div>
        ) : dailyPnl.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px] gap-3">
            <BookOpen className="h-8 w-8 text-zinc-700" />
            <p className="text-sm font-semibold text-zinc-300">
              {kotakAvailable && broker !== 'DHAN' && segment !== 'ALL'
                ? `No ${segment === 'FNO' ? 'F&O' : segment.toLowerCase()} data for this selection`
                : 'No diary data yet'}
            </p>
            {broker === 'KOTAK' ? (
              <>
                <p className="text-xs text-zinc-600 max-w-md text-center">
                  {kotakAvailable
                    ? `This Kotak import covers ${(kotak?.segments ?? []).join(' and ') || 'no'} segment(s) — pick one of those, or ALL.`
                    : 'Kotak has no historical trade API, so this view is built from statement exports. Drop the .xlsx files (a Transaction Statement gives exact daily P&L; a Gain/Loss export is a coarser fallback) into debug/kotak_pnl_reports/ and hit Import.'}
                </p>
                <button
                  onClick={runKotakImport}
                  disabled={importing}
                  className="mt-1 px-4 py-1.5 text-xs font-semibold bg-amber-950/40 border border-amber-800 text-amber-400 rounded-lg hover:bg-amber-900/40 transition-all disabled:opacity-40"
                >
                  {importing ? 'Importing…' : 'Import Kotak exports'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-zinc-600 max-w-md text-center">
                  Run "Trade P&amp;L by Segment" from Reports to generate the trade history this diary is built from.
                </p>
                <Link href="/reports" className="mt-1 px-4 py-1.5 text-xs font-semibold bg-amber-950/40 border border-amber-800 text-amber-400 rounded-lg hover:bg-amber-900/40 transition-all">
                  Go to Reports
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Stats header — scoped to full range on Weekly tab, selected month/year on Monthly/Yearly tabs */}
            {(() => {
              const s = tab === 'monthly' && selectedMonthStats ? selectedMonthStats
                : tab === 'yearly' && selectedYearStats ? selectedYearStats
                : stats;
              const scopeLabel = tab === 'monthly' && selectedMonth ? monthLabel(selectedMonth)
                : tab === 'yearly' && selectedYear ? selectedYear
                : `since ${rangeFrom}`;
              const marketDates = Array.from(new Set([
                ...(broker !== 'KOTAK' ? data?.marketTradingDates ?? [] : []),
                ...(broker !== 'DHAN' ? kotak?.marketTradingDates ?? [] : []),
              ])).filter(d => (!rangeFrom || d >= rangeFrom) && (!rangeTo || d <= rangeTo));
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

            {/* Day-of-week breakdown — which weekday is most profitable overall */}
            {weekdayStats.some(w => w.tradedDays > 0) && (
              <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] font-semibold text-zinc-300">Day-of-Week Performance</span>
                    <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                      {([
                        { key: 'totalGross', label: 'Overall P&L' },
                        { key: 'totalNet', label: 'Net P&L' },
                        { key: 'totalTrades', label: 'Total Trades' },
                      ] as const).map(o => (
                        <button
                          key={o.key}
                          onClick={() => setWeekdayMetric(o.key)}
                          className={cn(
                            'px-2.5 py-1 text-[10px] font-semibold rounded-md transition-all',
                            weekdayMetric === o.key ? 'bg-amber-500/10 text-amber-400' : 'text-zinc-500 hover:text-zinc-300',
                          )}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {bestWeekday && (
                    <div className="flex items-center gap-1.5">
                      <Award className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-[11px] text-zinc-500">{weekdayMetric === 'totalTrades' ? 'Most Active:' : 'Best Day:'}</span>
                      <span className="text-[11px] font-bold text-emerald-400">{bestWeekday.label}</span>
                      <span className="text-[10px] text-zinc-600">
                        ({weekdayMetric === 'totalTrades' ? `${bestWeekday.totalTrades} trades` : `${fmtINR(bestWeekday[weekdayMetric], true)} total`}, {bestWeekday.winRate}% win rate)
                      </span>
                    </div>
                  )}
                </div>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weekdayStats} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#a1a1aa' }} />
                      <YAxis
                        tick={{ fontSize: 9, fill: '#71717a' }}
                        tickFormatter={v => (weekdayMetric === 'totalTrades' ? String(v) : fmtINR(v, true))}
                        width={56}
                      />
                      <ReferenceLine y={0} stroke="#52525b" />
                      <Tooltip
                        cursor={{ fill: '#3f3f46', opacity: 0.35 }}
                        contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                        labelStyle={{ color: '#a1a1aa' }}
                        itemStyle={{ color: 'var(--chart-tooltip-text)' }}
                        formatter={(v: unknown, name: unknown, props: any) => {
                          const w = props.payload as WeekdayStat;
                          if (weekdayMetric === 'totalTrades') {
                            return [`${v} trades  (${w.tradedDays} days, ${w.winRate}% win rate)`, 'Total Trades'] as [string, string];
                          }
                          const label = weekdayMetric === 'totalGross' ? 'Overall P&L' : 'Net P&L';
                          return [`${fmtINR(v as number)}  (${w.tradedDays} days, ${w.winRate}% win rate)`, label] as [string, string];
                        }}
                      />
                      <Bar dataKey={weekdayMetric} radius={[4, 4, 0, 0]}>
                        {weekdayStats.map(w => (
                          <Cell
                            key={w.dow}
                            fill={
                              w.tradedDays === 0 ? '#3f3f46' :
                              weekdayMetric === 'totalTrades' ? '#38bdf8' :
                              w[weekdayMetric] >= 0 ? '#10b981' : '#ef4444'
                            }
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {weekdayStats.map(w => (
                    <div key={w.dow} className="flex flex-col items-center gap-0.5 py-1.5 rounded-lg border border-zinc-800/60 bg-zinc-950/40">
                      <span className="text-[10px] text-zinc-500 font-medium">{w.label}</span>
                      {weekdayMetric === 'totalTrades' ? (
                        <span className="tabular-nums font-bold text-sky-400">{w.totalTrades}</span>
                      ) : (
                        <PnlText v={w[weekdayMetric]} compact />
                      )}
                      <span className="text-[9px] text-zinc-600">{w.tradedDays} days · {w.winRate}% win</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-left">Year</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">No. of Trades</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Overall P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Net P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Charges</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Brokerage</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Total Charges</th>
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
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-left">Week</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">No. of Trades</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Overall P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Net P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Charges</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Brokerage</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyBuckets.map(w => (
                        <tr key={w.startDate} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                          <td className="py-[6px] px-2 text-[12px] text-zinc-100 dark:text-white font-medium">{w.label}</td>
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
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-left">Month</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">No. of Trades</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Overall P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Net P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Charges</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Brokerage</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyBuckets.map(m => (
                        <tr
                          key={m.startDate}
                          onClick={() => setSelectedMonth(monthKey(m.startDate))}
                          className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors cursor-pointer"
                        >
                          <td className="py-[6px] px-2 text-[12px] text-zinc-100 dark:text-white font-medium">{m.label}</td>
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
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-left">Date</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">No. of Trades</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Overall P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Net P&amp;L</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Charges</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Brokerage</th>
                        <th className="py-2 px-2 text-xs font-bold uppercase tracking-wide text-zinc-100 dark:text-zinc-200 text-right">Total Charges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...dailyPnl].reverse().map(d => (
                        <tr key={d.date} className="border-b border-zinc-900/60 hover:bg-zinc-800/20 transition-colors">
                          <td className="py-[6px] px-2 text-[12px] text-zinc-100 dark:text-white font-medium">{fmtDateLong(d.date)}</td>
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
                        itemStyle={{ color: 'var(--chart-tooltip-text)' }}
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

                <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4">
                  <div className="text-[11px] font-semibold text-zinc-300 mb-3">
                    Day-wise {activeChartMetric.label}
                  </div>
                  {dayWiseChartData.length === 0 ? (
                    <div className="flex items-center justify-center h-64 text-xs text-zinc-600">No trades in range</div>
                  ) : (
                    <div className="h-72">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={dayWiseChartData} margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
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
                            cursor={{ fill: '#3f3f46', opacity: 0.35 }}
                            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                            labelStyle={{ color: '#a1a1aa' }}
                        itemStyle={{ color: 'var(--chart-tooltip-text)' }}
                            labelFormatter={(d: any) => fmtDateLong(String(d))}
                            formatter={(v: unknown) => [fmtINR(v as number), activeChartMetric.label]}
                          />
                          <ReferenceLine y={0} stroke="#52525b" strokeDasharray="4 2" />
                          <Bar dataKey={chartMetric} name={activeChartMetric.label} radius={[2, 2, 0, 0]} isAnimationActive={false}>
                            {dayWiseChartData.map((d: any) => (
                              <Cell
                                key={d.date}
                                fill={
                                  chartMetric === 'grossPnl' || chartMetric === 'netPnl'
                                    ? d[chartMetric] >= 0 ? '#10b981' : '#ef4444'
                                    : activeChartMetric.color
                                }
                              />
                            ))}
                          </Bar>
                        </BarChart>
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
