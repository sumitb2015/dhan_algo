'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { TrendingUp, RefreshCw, Wallet, Check, Pencil } from 'lucide-react';
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
  syncError?: string | null;
  dailyPnl?: DailyPnlPoint[];
  dailyPnlBySegment?: Record<string, DailyPnlPoint[]>;
}

// Mirrors the defaults in app/api/portfolio-capital/route.ts so a failed config fetch degrades
// to the same numbers the route would have served.
const DEFAULT_CAPITAL = 2500000; // 25 lakh — keep in sync with the route
const DEFAULT_FY_START = '2026-04-01';

interface CapitalConfig {
  startingCapital: number;
  fyStart: string;
}

type Segment = 'ALL' | 'EQUITY' | 'FNO' | 'COMMODITY';

const SEGMENTS: Segment[] = ['ALL', 'EQUITY', 'FNO', 'COMMODITY'];

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

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

// "Aug 2026" — the compact form used on the month tiles.
function monthTileLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// "AUGUST 2026" — the KPI-tile caption.
function monthFullLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function fmtShort(dateStr: string): string {
  return toUTCDate(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

// The 12 month keys of the financial year starting at fyStart, in Apr→Mar order.
function fyMonthKeys(fyStart: string): string[] {
  const start = toUTCDate(fyStart);
  const keys: string[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    keys.push(fromUTCDate(d).slice(0, 7));
  }
  return keys;
}

// "2026-27" from an FY start of 2026-04-01.
function fyLabel(fyStart: string): string {
  const y = toUTCDate(fyStart).getUTCFullYear();
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Monday→Sunday window containing `dateStr` (matches the diary's ISO-week convention).
function weekWindow(dateStr: string): { start: string; end: string } {
  const dow = dayOfWeekUTC(dateStr);
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  const start = addDaysUTC(dateStr, -daysFromMonday);
  return { start, end: addDaysUTC(start, 6) };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

function fmtSigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmtINR(n)}`;
}

function PnlText({ v, compact }: { v: number; compact?: boolean }) {
  return (
    <span className={cn('tabular-nums font-bold', v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {v >= 0 ? '+' : ''}{fmtINR(v, compact)}
    </span>
  );
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

interface Agg {
  netPnl: number;      // net of charges — the headline convention
  days: number;        // calendar days present in the dataset for this slice
  tradedDays: number;  // days that actually had trades
  wins: number;        // traded days with gross P&L > 0
  losses: number;      // traded days with gross P&L <= 0
  trades: number;
}

const EMPTY_AGG: Agg = { netPnl: 0, days: 0, tradedDays: 0, wins: 0, losses: 0, trades: 0 };

// Win/loss day counts use GROSS P&L while the headline total uses NET — the same split the
// diary verified against Dhan's own Trader's Diary (see PortfolioDiaryDashboard.tsx:196).
function aggregate(points: DailyPnlPoint[]): Agg {
  let netPnl = 0, tradedDays = 0, wins = 0, losses = 0, trades = 0;
  for (const p of points) {
    netPnl += p.netPnl;
    trades += p.tradeCount;
    if (p.tradeCount > 0) {
      tradedDays += 1;
      if (p.grossPnl > 0) wins += 1;
      else losses += 1;
    }
  }
  return { netPnl: round2(netPnl), days: points.length, tradedDays, wins, losses, trades };
}

function winLossLabel(a: Agg): string {
  return `${a.wins}W / ${a.losses}L`;
}

// ─── Tiles ────────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-4 flex flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{label}</span>
      <div className="text-2xl font-bold tabular-nums leading-tight">{children}</div>
      {sub ? <span className="text-[11px] text-zinc-500">{sub}</span> : null}
    </div>
  );
}

function MonthTile({
  label,
  agg,
  selected,
  onClick,
}: {
  label: string;
  agg: Agg | null;
  selected: boolean;
  onClick: () => void;
}) {
  const hasData = !!agg && agg.days > 0;
  const positive = hasData && agg.netPnl >= 0;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!hasData}
      title={hasData ? `${agg.tradedDays} traded days · ${winLossLabel(agg)} · ${agg.trades} trades` : 'No data'}
      className={cn(
        'rounded-xl border px-3 py-2.5 flex flex-col items-center gap-1 transition-all',
        !hasData && 'border-zinc-800 bg-zinc-950/40 cursor-default',
        hasData && !selected && (positive ? 'border-emerald-500/40 bg-emerald-500/5 hover:border-emerald-400' : 'border-red-500/40 bg-red-500/5 hover:border-red-400'),
        selected && 'border-sky-400 bg-sky-500/10 ring-1 ring-sky-400',
      )}
    >
      <span className={cn('text-[11px] font-bold', hasData ? 'text-zinc-200' : 'text-zinc-600')}>{label}</span>
      {hasData ? (
        <span className={cn('text-[11px] font-bold tabular-nums', positive ? 'text-emerald-400' : 'text-red-400')}>
          {fmtSigned(agg.netPnl)}
        </span>
      ) : (
        <span className="text-[11px] text-zinc-600">—</span>
      )}
    </button>
  );
}

// ─── Equity curve tooltip ─────────────────────────────────────────────────────

interface CurvePoint {
  date: string;
  equity: number;
  cumPnl: number;
  netPnl: number;
}

function CurveTooltip({ active, payload }: { active?: boolean; payload?: { payload: CurvePoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 shadow-xl">
      <div className="text-[11px] font-bold text-white mb-1">{p.date}</div>
      <div className="text-[11px] text-zinc-400">Equity <span className="text-zinc-100 font-semibold tabular-nums">{fmtINR(p.equity)}</span></div>
      <div className="text-[11px] text-zinc-400">Cumulative <PnlText v={p.cumPnl} /></div>
      <div className="text-[11px] text-zinc-400">Day <PnlText v={p.netPnl} /></div>
    </div>
  );
}

// ─── Related links ────────────────────────────────────────────────────────────

function RelatedLinks() {
  const links = [
    { href: '/portfolio', label: 'Portfolio' },
    { href: '/portfolio/trades', label: 'Trade P&L' },
    { href: '/portfolio/diary', label: "Trader's Diary" },
    { href: '/portfolio/weekly-target', label: 'Weekly Target' },
    { href: '/reports', label: 'Reports' },
  ];
  return (
    <div className="w-full border-b border-zinc-900 bg-zinc-950/40 px-4 py-1.5 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Related</span>
      {links.map(l => (
        <Link
          key={l.href}
          href={l.href}
          className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/30 transition-all"
        >
          {l.label}
        </Link>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PortfolioStatsDashboard() {
  const [data, setData] = useState<TradeHistoryResponse | null>(null);
  const [capital, setCapital] = useState<CapitalConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [segment, setSegment] = useState<Segment>('ALL');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [quarter, setQuarter] = useState(0); // 0=Q1 … 3=Q4, independent of the month grid
  const [capitalDraft, setCapitalDraft] = useState<string | null>(null);
  const [savingCapital, setSavingCapital] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  const fetchData = useCallback(() => {
    fetch('/api/portfolio-trades')
      .then(r => r.json())
      .then((d: TradeHistoryResponse) => setData(d))
      .catch(() => setData({ success: false, available: false }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchData();
    fetch('/api/portfolio-capital')
      .then(r => r.json())
      .then((d: CapitalConfig & { success: boolean }) => {
        // Falling back to 0 here would render a ₹0.00 capital base and a blank FY return with
        // no hint that the fetch failed — fall back to the same default the route serves.
        if (!d?.success || !Number.isFinite(d.startingCapital)) throw new Error('bad payload');
        setCapital({ startingCapital: d.startingCapital, fyStart: d.fyStart });
      })
      .catch(() => setCapital({ startingCapital: DEFAULT_CAPITAL, fyStart: DEFAULT_FY_START }));
  }, [fetchData]);

  const { syncing, syncError, startSync } = useTradeSync(fetchData);

  // The daily series for the selected segment. dailyPnlBySegment.ALL is the same series as
  // dailyPnl, so fall back to dailyPnl only when the by-segment map is missing entirely.
  const dailyPnl = useMemo<DailyPnlPoint[]>(() => {
    const bySeg = data?.dailyPnlBySegment;
    if (bySeg && bySeg[segment]) return bySeg[segment];
    return segment === 'ALL' ? (data?.dailyPnl ?? []) : [];
  }, [data, segment]);

  const startingCapital = capital?.startingCapital ?? DEFAULT_CAPITAL;
  const fyStart = capital?.fyStart ?? data?.fromDate ?? DEFAULT_FY_START;
  const toDate = data?.toDate ?? '';

  // ── Derived aggregates ──────────────────────────────────────────────────────

  // Everything FY-scoped is computed off this window, not off the raw series. The trade-history
  // sync keeps appending days forever, so once the dataset spans past 31 Mar the unfiltered
  // series would silently make the FY total, FY return and win rate cover more than the 12
  // months the month grid shows — and the grid would stop summing to the FY tile.
  const fyWindow = useMemo(() => {
    const s = toUTCDate(fyStart);
    const end = new Date(Date.UTC(s.getUTCFullYear() + 1, s.getUTCMonth(), s.getUTCDate()));
    end.setUTCDate(end.getUTCDate() - 1);
    return { start: fyStart, end: fromUTCDate(end) };
  }, [fyStart]);

  const inFy = useCallback(
    (p: DailyPnlPoint) => p.date >= fyWindow.start && p.date <= fyWindow.end,
    [fyWindow],
  );

  const fyDaily = useMemo(() => dailyPnl.filter(inFy), [dailyPnl, inFy]);

  const fy = useMemo(() => aggregate(fyDaily), [fyDaily]);

  // Current capital is an ACCOUNT-level figure, so it always uses the ALL series — adding a
  // segment-filtered P&L to the account-wide base would report a balance that omits the other
  // segments' P&L whenever the segment selector is not on ALL.
  const fyAll = useMemo(() => {
    const all = data?.dailyPnlBySegment?.ALL ?? data?.dailyPnl ?? [];
    return aggregate(all.filter(inFy));
  }, [data, inFy]);

  const monthKeys = useMemo(() => fyMonthKeys(fyStart), [fyStart]);

  const byMonth = useMemo(() => {
    const map = new Map<string, DailyPnlPoint[]>();
    for (const p of fyDaily) {
      const k = monthKey(p.date);
      const arr = map.get(k);
      if (arr) arr.push(p);
      else map.set(k, [p]);
    }
    return new Map(Array.from(map, ([k, v]) => [k, aggregate(v)]));
  }, [fyDaily]);

  // Default the month KPI tile to the month of the latest data point, clamped into the FY grid
  // so a toDate outside the displayed FY can't select a tile that isn't on screen.
  const latestMonth = toDate ? monthKey(toDate) : null;
  const activeMonth = selectedMonth ?? (latestMonth && monthKeys.includes(latestMonth) ? latestMonth : monthKeys[0]);
  const monthAgg = byMonth.get(activeMonth) ?? EMPTY_AGG;

  const quarterAgg = useMemo(() => {
    const keys = monthKeys.slice(quarter * 3, quarter * 3 + 3);
    const pts = fyDaily.filter(p => keys.includes(monthKey(p.date)));
    return aggregate(pts);
  }, [fyDaily, monthKeys, quarter]);

  const quarterRange = useMemo(() => {
    const keys = monthKeys.slice(quarter * 3, quarter * 3 + 3);
    const first = `${keys[0]}-01`;
    const [ly, lm] = keys[2].split('-').map(Number);
    const last = fromUTCDate(new Date(Date.UTC(ly, lm, 0))); // day 0 of next month = last of this
    return `${fmtShort(first)} – ${fmtShort(last)}`;
  }, [monthKeys, quarter]);

  const week = useMemo(() => {
    if (!toDate) return null;
    const { start, end } = weekWindow(toDate);
    const pts = dailyPnl.filter(p => p.date >= start && p.date <= end);
    return { start, end, agg: aggregate(pts) };
  }, [dailyPnl, toDate]);

  const curve = useMemo<CurvePoint[]>(() => {
    let cum = 0;
    return fyDaily.map(p => {
      cum = round2(cum + p.netPnl);
      return { date: p.date, equity: round2(startingCapital + cum), cumPnl: cum, netPnl: p.netPnl };
    });
  }, [fyDaily, startingCapital]);

  // Raw min/max of the plotted series. The stroke gradient below is measured against THIS, not
  // against the axis domain: an SVG gradient defaults to objectBoundingBox units, so its offsets
  // are relative to the line path's own bounding box — which spans exactly the data extent.
  // Measuring against the padded domain instead puts the colour break a few pixels off the line.
  const curveExtent = useMemo(() => {
    if (!curve.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const p of curve) {
      if (p.equity < lo) lo = p.equity;
      if (p.equity > hi) hi = p.equity;
    }
    return { min: lo, max: hi };
  }, [curve]);

  // An explicit Y domain (rather than ['auto','auto']) padded around the data, always widened to
  // include the capital baseline so it stays on screen without ReferenceLine's extendDomain.
  const curveDomain = useMemo(() => {
    if (!curveExtent) return null;
    const lo = Math.min(curveExtent.min, startingCapital);
    const hi = Math.max(curveExtent.max, startingCapital);
    const pad = (hi - lo) * 0.04 || Math.max(Math.abs(hi) * 0.001, 1);
    return { min: lo - pad, max: hi + pad };
  }, [curveExtent, startingCapital]);

  // Height fraction (from the top of the path's bbox) at which equity crosses the capital
  // baseline. Two gradient stops at this same offset give a hard green→red cut, not a blend.
  // Green is above the stop, so offset 1 = entirely green and offset 0 = entirely red; the
  // clamp handles a curve that never crosses. The max === min branch is a perfectly flat curve
  // (a single day, or an all-zero segment) — flat at or above the baseline is green, below red.
  const baselineOffset = !curveExtent
    ? 0
    : curveExtent.max > curveExtent.min
      ? Math.min(1, Math.max(0, (curveExtent.max - startingCapital) / (curveExtent.max - curveExtent.min)))
      : (curveExtent.max >= startingCapital ? 1 : 0);

  const currentCapital = round2(startingCapital + fyAll.netPnl);
  const fyReturnPct = startingCapital > 0 ? (fy.netPnl / startingCapital) * 100 : null;
  const winRate = fy.tradedDays > 0 ? (fy.wins / fy.tradedDays) * 100 : null;

  // ── Starting-capital editing ────────────────────────────────────────────────

  async function saveCapital() {
    if (capitalDraft === null) return;
    const cleaned = capitalDraft.replace(/[^0-9.]/g, '');
    setCapitalDraft(null);
    // Number('') is 0, which would sail through the >= 0 guard here and in the route and
    // permanently persist a capital base of zero — treat a blank/garbage field as "cancel".
    if (cleaned === '') return;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n < 0 || n === startingCapital) return;
    setSavingCapital(true);
    try {
      const res = await fetch('/api/portfolio-capital', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startingCapital: n }),
      });
      const d = await res.json();
      if (d.success) {
        setCapital({ startingCapital: d.startingCapital, fyStart: d.fyStart });
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1500);
      }
    } catch {
      /* leave the previous value in place */
    } finally {
      setSavingCapital(false);
    }
  }

  const hasData = !!data?.available && fyDaily.length > 0;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-200">
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 sticky top-0 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-emerald-500 to-teal-300 flex items-center justify-center shadow-md shadow-emerald-500/10 shrink-0">
            <TrendingUp className="h-4 w-4 text-oncolor-dark" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">P&amp;L Stats</h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">
              {data?.fromDate ? `${data.fromDate} → ${data.toDate}` : 'Loading…'}
            </p>
          </div>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-300 shrink-0">
          DATA: {toDate || '—'}
        </span>
        <NavBar />
        <button
          onClick={startSync}
          disabled={syncing || !data?.available}
          title="Fetch new days' trades and update totals (incremental — a few seconds)"
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </header>

      {/* data.syncError carries a broker-side failure from the last sync run; without it a failed
          sync ends silently and the page keeps showing stale totals (same pattern as
          WeeklyTargetDashboard.tsx). */}
      {(syncError ?? data?.syncError) && (
        <div className="w-full border-b border-red-900/40 bg-red-950/20 px-4 py-1.5 text-[11px] text-red-400">
          {syncError ?? data?.syncError}
        </div>
      )}

      <RelatedLinks />

      <main className="flex-1 w-full mx-auto px-4 py-4 flex flex-col gap-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center p-16 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[300px] gap-3">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-600 text-xs">Loading P&amp;L stats…</span>
          </div>
        ) : !data?.available ? (
          <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-zinc-900 bg-zinc-950/60 min-h-[260px] gap-3">
            <Wallet className="h-8 w-8 text-zinc-700" />
            <p className="text-sm font-semibold text-zinc-300">No trade history yet</p>
            <p className="text-xs text-zinc-600 max-w-md text-center">
              Run "Trade P&amp;L by Segment" from Reports to generate the trade history these stats are built from.
            </p>
            <Link href="/reports" className="mt-1 px-4 py-1.5 text-xs font-semibold bg-emerald-950/40 border border-emerald-800 text-emerald-400 rounded-lg hover:bg-emerald-900/40 transition-all">
              Go to Reports
            </Link>
          </div>
        ) : (
          <>
            {/* Segment selector — every figure below recomputes off the selected series */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Segment</span>
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg gap-0.5 w-fit">
                {SEGMENTS.map(s => (
                  <button
                    key={s}
                    onClick={() => setSegment(s)}
                    className={cn(
                      'px-3 py-1.5 text-[11px] font-semibold rounded-md transition-all',
                      segment === s ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-500 hover:text-zinc-300',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-5">
              {/* 1 — Account header row */}
              <div className="flex items-start justify-between gap-4 flex-wrap pb-4 border-b border-zinc-800">
                <div>
                  <div className="text-base font-bold text-white leading-tight">Main account</div>
                  <div className="text-[12px] text-zinc-500">
                    Dhan verified P&amp;L{segment !== 'ALL' && <span className="text-zinc-400"> · {segment}</span>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">This week P&amp;L</div>
                  <div className="text-3xl font-bold tabular-nums leading-tight">
                    {week ? <PnlText v={week.agg.netPnl} /> : <span className="text-zinc-600">—</span>}
                  </div>
                  {week && (
                    <div className="text-[11px] text-zinc-500 mt-0.5">
                      {fmtShort(week.start)} – {fmtShort(week.end)} · {week.agg.tradedDays} days · {winLossLabel(week.agg)}
                    </div>
                  )}
                </div>
              </div>

              {/* 2 — FY month grid, Apr→Mar */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                {monthKeys.map(k => (
                  <MonthTile
                    key={k}
                    label={monthTileLabel(k)}
                    agg={byMonth.get(k) ?? null}
                    selected={activeMonth === k}
                    // Compare against activeMonth, not selectedMonth: the default month starts
                    // selected with selectedMonth still null, so toggling off the raw state made
                    // its first click a no-op and left it impossible to deselect.
                    onClick={() => setSelectedMonth(activeMonth === k ? null : k)}
                  />
                ))}
              </div>

              {/* 3 — KPI row 1 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <KpiTile
                  label="Starting capital"
                  sub={<>Current: <span className="text-zinc-300 tabular-nums">{fmtINR(currentCapital)}</span> · click to edit</>}
                >
                  {capitalDraft !== null ? (
                    <input
                      autoFocus
                      value={capitalDraft}
                      onChange={e => setCapitalDraft(e.target.value)}
                      onBlur={saveCapital}
                      onKeyDown={e => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setCapitalDraft(null);
                      }}
                      className="w-full bg-zinc-900 border border-emerald-500/40 rounded-lg px-2 py-0.5 text-2xl font-bold tabular-nums text-white outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setCapitalDraft(String(startingCapital))}
                      title="Click to edit the capital base the FY return is measured against"
                      className="group flex items-center gap-2 text-white hover:text-emerald-300 transition-colors"
                    >
                      {/* Dashed underline + pencil so the figure reads as editable — without an
                          affordance it looks like a plain readout and nobody thinks to click it. */}
                      <span className="border-b border-dashed border-zinc-600 group-hover:border-emerald-400">
                        {fmtINR(startingCapital)}
                      </span>
                      {savingCapital ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                      ) : savedTick ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Pencil className="h-3.5 w-3.5 text-zinc-500 group-hover:text-emerald-400" />
                      )}
                    </button>
                  )}
                </KpiTile>

                <KpiTile
                  label={`FY ${fyLabel(fyStart)} P&L`}
                  sub={`${fy.days} days · ${winLossLabel(fy)}`}
                >
                  <PnlText v={fy.netPnl} />
                </KpiTile>

                <KpiTile
                  label={activeMonth ? `${monthFullLabel(activeMonth)} P&L` : 'Month P&L'}
                  sub={`${monthAgg.days} days · ${winLossLabel(monthAgg)}`}
                >
                  <PnlText v={monthAgg.netPnl} />
                </KpiTile>
              </div>

              {/* 4 — KPI row 2 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <KpiTile label="FY return" sub="On capital at FY open">
                  {fyReturnPct === null ? (
                    <span className="text-zinc-600">—</span>
                  ) : (
                    <span className={cn('tabular-nums', fyReturnPct >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                      {fyReturnPct >= 0 ? '+' : ''}{fyReturnPct.toFixed(2)}%
                    </span>
                  )}
                </KpiTile>

                <KpiTile label="Win rate" sub={`Trading days · ${winLossLabel(fy)}`}>
                  {winRate === null ? (
                    <span className="text-zinc-600">—</span>
                  ) : (
                    <span className="tabular-nums text-emerald-400">{winRate.toFixed(1)}%</span>
                  )}
                </KpiTile>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-4 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Q{quarter + 1} P&amp;L</span>
                    <div className="flex items-center gap-0.5">
                      {[0, 1, 2, 3].map(q => (
                        <button
                          key={q}
                          onClick={() => setQuarter(q)}
                          className={cn(
                            'px-1.5 py-0.5 text-[10px] font-bold rounded transition-all',
                            quarter === q ? 'bg-emerald-500/10 text-emerald-400' : 'text-zinc-600 hover:text-zinc-400',
                          )}
                        >
                          Q{q + 1}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="text-2xl font-bold tabular-nums leading-tight">
                    <PnlText v={quarterAgg.netPnl} />
                  </div>
                  <span className="text-[11px] text-zinc-500">{quarterRange} · {quarterAgg.days} days</span>
                </div>
              </div>
            </div>

            {/* 5 — Equity curve */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
                <div className="text-sm font-bold text-white">
                  Equity curve — Main account{segment !== 'ALL' && <span className="text-zinc-400 font-semibold"> ({segment})</span>}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {fy.days} days · <PnlText v={fy.netPnl} />
                </div>
              </div>
              {!hasData ? (
                <div className="flex items-center justify-center h-64 text-xs text-zinc-600">No trades in this segment</div>
              ) : (
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={curve} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <defs>
                      {/* Both stops sit at the same offset, so the stroke flips colour exactly at
                          the capital baseline rather than fading across it. */}
                      <linearGradient id="equityCurveStroke" x1="0" y1="0" x2="0" y2="1">
                        <stop offset={baselineOffset} stopColor="#10b981" />
                        <stop offset={baselineOffset} stopColor="#ef4444" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: '#27272a' }}
                      minTickGap={40}
                      tickFormatter={fmtShort}
                    />
                    <YAxis
                      tick={{ fill: '#71717a', fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                      domain={curveDomain ? [curveDomain.min, curveDomain.max] : ['auto', 'auto']}
                      tickFormatter={(v: number) => fmtINR(v, true)}
                    />
                    <Tooltip content={<CurveTooltip />} />
                    <ReferenceLine y={startingCapital} stroke="#52525b" strokeDasharray="4 4" />
                    <Line
                      type="monotone"
                      dataKey="equity"
                      stroke="url(#equityCurveStroke)"
                      strokeWidth={2}
                      dot={false}
                      // Match the hovered dot to the side of the baseline it sits on, so it never
                      // shows green while resting on a red stretch of the curve.
                      activeDot={(props: { cx?: number; cy?: number; payload?: CurvePoint }) => {
                        const col = (props.payload?.equity ?? 0) >= startingCapital ? '#10b981' : '#ef4444';
                        return <circle cx={props.cx} cy={props.cy} r={3.5} fill={col} stroke={col} />;
                      }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
