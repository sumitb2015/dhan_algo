'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import NavBar from '@/components/NavBar';
import { Activity, RefreshCw, AlertCircle, Loader2, Download } from 'lucide-react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { ContractStats, ChartPoint, FuturesResponse } from '@/app/api/futures/route';
import type { FuturesRefreshStatus } from '@/app/api/futures-refresh/route';
import OIBuildupDashboard from '@/components/OIBuildupDashboard';
import FuturesBasketCards from '@/components/FuturesBasketCards';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000)   return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000)     return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtChange(v: number): string {
  return (v >= 0 ? '+' : '-') + fmtLakh(Math.abs(v));
}

function fmtBasis(v: number | null): string {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function oiChangeColor(v: number): string {
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-400';
}

function basisColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function cocColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function dteColor(days: number): string {
  if (days <= 5) return 'text-red-400';
  if (days <= 15) return 'text-amber-400';
  return 'text-zinc-300';
}

function dteChipClass(days: number): string {
  if (days <= 5) return 'bg-red-500/10 text-red-400 border-red-500/20';
  if (days <= 15) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  return 'bg-zinc-800 text-zinc-400 border-zinc-700';
}

// ─── Shared quant-terminal primitives ──────────────────────────────────────────

function PulseStat({
  label, value, sub, color = 'text-white', size = 'text-lg',
}: { label: string; value: string; sub?: React.ReactNode; color?: string; size?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`${size} font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
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
        <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold">{legend}</div>}
    </div>
  );
}

// ─── Market pulse ribbon ────────────────────────────────────────────────────────

function InstrumentPulseBlock({ name, near }: { name: string; near: ContractStats | undefined }) {
  if (!near) {
    return (
      <div className="flex flex-col min-w-0">
        <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{name}</span>
        <span className="text-lg font-mono font-bold text-zinc-600">No data</span>
      </div>
    );
  }

  type OIDir = 'building' | 'unwinding' | 'neutral' | 'nodata';
  const oiDir: OIDir = !near.oiHasData ? 'nodata'
    : near.oiChange > 0 ? 'building'
    : near.oiChange < 0 ? 'unwinding'
    : 'neutral';

  const oiBadge: Record<OIDir, { label: string; cls: string }> = {
    building:  { label: '▲ Building',  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    unwinding: { label: '▼ Unwinding', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
    neutral:   { label: '— Neutral',   cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
    nodata:    { label: '— No OI',     cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
  };
  const badge = oiBadge[oiDir];

  return (
    <div className="flex items-center gap-5 flex-wrap">
      <PulseStat label={`${name} Near`} value={fmtPrice(near.price)} size="text-2xl" />
      <PulseStat
        label="Basis"
        value={fmtBasis(near.basis)}
        color={basisColor(near.basis)}
        size="text-sm"
      />
      <PulseStat
        label="OI Δ"
        value={near.oiHasData ? fmtChange(near.oiChange) : '—'}
        color={near.oiHasData ? oiChangeColor(near.oiChange) : 'text-zinc-600'}
        size="text-sm"
      />
      <div className="flex flex-col min-w-0">
        <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-1">Flow</span>
        <span className={`inline-flex w-fit items-center text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${dteChipClass(near.daysToExpiry)}`}>
        {near.daysToExpiry}d to expiry
      </span>
    </div>
  );
}

function MarketPulseRibbon({
  data, dlStatus, loading, onDownload, onReload,
}: {
  data: FuturesResponse;
  dlStatus: FuturesRefreshStatus | null;
  loading: boolean;
  onDownload: () => void;
  onReload: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-sky-500/[0.06] via-transparent to-emerald-500/[0.04]" />

      <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
        <InstrumentPulseBlock name="NIFTY" near={data.instruments.NIFTY[0]} />
        <div className="w-px bg-zinc-800 self-stretch" />
        <InstrumentPulseBlock name="BANKNIFTY" near={data.instruments.BANKNIFTY[0]} />
      </div>

      {/* Control strip */}
      <div className="relative flex items-center justify-between gap-3 px-5 py-2 border-t border-zinc-800/80 bg-zinc-950/40 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-400 border border-sky-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
            DATA
          </span>
          <span className="text-[10px] text-zinc-500 font-mono tabular-nums">{data.dataDate}</span>
        </div>

        <div className="flex items-center gap-2">
          {dlStatus?.running ? (
            <div className="flex items-center gap-1.5 text-[11px] text-sky-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{dlStatus.message || 'Downloading…'}</span>
            </div>
          ) : (
            <button
              onClick={onDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 hover:border-sky-500/35 transition-all"
              title="Download fresh futures data (runs download_futures_manual.py)"
            >
              <Download className="h-3 w-3" />
              Download Data
            </button>
          )}
          <button
            onClick={onReload}
            disabled={loading}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40"
            title="Reload from disk"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ContractTable ────────────────────────────────────────────────────────────

function ContractTable({ name, contracts }: { name: string; contracts: ContractStats[] }) {
  const labels = ['Near', 'Mid', 'Far'];
  const showBasisCoc = name === 'NIFTY';
  const thCls  = 'px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-left';
  const thRCls = 'px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-right';

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-[12px] border-collapse font-mono">
        <thead>
          <tr className="bg-zinc-800">
            <th className={thCls + ' font-sans'}>Contract</th>
            <th className={thRCls}>Price</th>
            <th className={thRCls}>Open</th>
            <th className={thRCls}>High</th>
            <th className={thRCls}>Low</th>
            <th className={thRCls}>Volume</th>
            <th className={thRCls}>OI (contracts)</th>
            <th className={thRCls}>OI Δ</th>
            {showBasisCoc && <th className={thRCls}>Basis</th>}
            {showBasisCoc && <th className={thRCls}>CoC % p.a.</th>}
            <th className={thRCls}>DTE</th>
          </tr>
        </thead>
        <tbody>
          {contracts.slice(0, 3).map((c, i) => (
            <tr key={c.expiry} className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
              <td className="px-3 py-2.5 font-sans">
                <span className="font-semibold text-zinc-100">{c.label}</span>
                <span className="ml-2 text-[10px] text-zinc-500">{labels[i] ?? ''}</span>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums font-bold text-zinc-100">
                {fmtPrice(c.price)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                {fmtPrice(c.open)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">
                {fmtPrice(c.high)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-red-400">
                {fmtPrice(c.low)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                {fmtLakh(c.volume)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-200">
                {c.oiHasData ? fmtLakh(c.oi) : '—'}
              </td>
              <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${
                c.oiHasData ? oiChangeColor(c.oiChange) : 'text-zinc-600'
              }`}>
                {c.oiHasData ? fmtChange(c.oiChange) : '—'}
              </td>
              {showBasisCoc && (
                <td className={`px-3 py-2.5 text-right tabular-nums ${basisColor(c.basis)}`}>
                  {fmtBasis(c.basis)}
                </td>
              )}
              {showBasisCoc && (
                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${cocColor(c.coc)}`}>
                  {c.coc !== null
                    ? (c.coc >= 0 ? '+' : '') + c.coc.toFixed(2) + '%'
                    : '—'}
                </td>
              )}
              <td className={`px-3 py-2.5 text-right tabular-nums ${dteColor(c.daysToExpiry)}`}>
                {c.daysToExpiry}d
              </td>
            </tr>
          ))}
          {contracts.length === 0 && (
            <tr>
              <td colSpan={showBasisCoc ? 11 : 9}
                className="px-3 py-8 text-center text-zinc-600 text-[11px] font-sans">
                No contract data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── CoC Callout ──────────────────────────────────────────────────────────────

function CoCCallout({ contracts }: { contracts: ContractStats[] }) {
  const items = contracts
    .slice(0, 3)
    .map((c, i) => ({ label: ['Near', 'Mid', 'Far'][i] ?? c.label, coc: c.coc }))
    .filter(item => item.coc !== null) as { label: string; coc: number }[];

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-6 flex-wrap text-[11px] px-1">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="text-zinc-500">{item.label}-month CoC:</span>
          <span className={`font-mono font-semibold ${cocColor(item.coc)}`}>
            {(item.coc >= 0 ? '+' : '') + item.coc.toFixed(2)}% p.a.
          </span>
          <span className="text-zinc-600">
            ({item.coc > 0 ? 'contango' : item.coc < 0 ? 'backwardation' : 'at par'})
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── Spot × Futures Chart (recharts, quant-terminal style) ─────────────────────

const SpotFutureTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: ChartPoint }>)[0]?.payload;
  const basis = row && row.spotClose ? row.futureClose - row.spotClose : null;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{String(label)}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-sky-400 font-semibold font-sans">Futures</span>
        <span className="text-white font-bold tabular-nums">
          {row?.futureClose ? fmtPrice(row.futureClose) : '—'}
        </span>
      </div>
      {row?.spotClose !== null && (
        <div className="flex justify-between gap-8 mb-2">
          <span className="text-emerald-400 font-semibold font-sans">Spot</span>
          <span className="text-white font-bold tabular-nums">{fmtPrice(row?.spotClose ?? 0)}</span>
        </div>
      )}
      {basis !== null && (
        <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8">
          <span className="text-zinc-400 font-sans">Basis</span>
          <span className={`font-bold tabular-nums ${basisColor(basis)}`}>{fmtBasis(basis)}</span>
        </div>
      )}
    </div>
  );
};

function SpotFutureChart({ points, name }: { points: ChartPoint[]; name: string }) {
  if (!points.length) return null;

  const fmtDate = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en', { day: 'numeric', month: 'short' });
  };
  const chartData = points.map(p => ({ ...p, dateLabel: fmtDate(p.date) }));
  const hasSpot = points.some(p => p.spotClose !== null && (p.spotClose as number) > 0);

  const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };
  const tickStyle = { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' };

  return (
    <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[280px] bg-sky-500/[0.05] blur-3xl rounded-full" />

      <ChartHeader
        eyebrow="Spread"
        title={`${name} Spot vs. Near Futures`}
        sub={`Daily close — last ${points.length} sessions`}
        legend={<>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-sky-400" />
            <span className="text-zinc-400">Near Futures</span>
          </span>
          {hasSpot && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 border-t border-dashed border-emerald-400" />
              <span className="text-zinc-400">{name} Spot</span>
            </span>
          )}
        </>}
      />

      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`fill-future-${name}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="dateLabel" tick={tickStyle} tickLine={false} axisLine={{ stroke: '#27272a' }}
            interval="preserveStartEnd" minTickGap={18} />
          <YAxis
            domain={['dataMin - 20', 'dataMax + 20']}
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={60}
            tickFormatter={(v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          />
          <Tooltip content={<SpotFutureTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
            formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
          />
          <Area
            type="monotone"
            dataKey="futureClose"
            name="Near Futures"
            stroke="#38bdf8"
            strokeWidth={2.5}
            fill={`url(#fill-future-${name})`}
            dot={false}
            activeDot={{ r: 5, fill: '#38bdf8', stroke: '#082f49', strokeWidth: 2 }}
            connectNulls
          />
          {hasSpot && (
            <Line
              type="monotone"
              dataKey="spotClose"
              name={`${name} Spot`}
              stroke="#34d399"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── InstrumentSection ────────────────────────────────────────────────────────

function InstrumentSection({
  name,
  contracts,
  chartPoints,
}: {
  name: string;
  contracts: ContractStats[];
  chartPoints: ChartPoint[];
}) {
  return (
    <section className="border-t border-zinc-800 pt-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-5 border-l-2 border-sky-500" />
        <h2 className="text-sm font-bold text-zinc-100">{name} Futures</h2>
        <span className="text-[10px] text-zinc-600 font-medium">{contracts.length} contracts</span>
      </div>
      <div className="space-y-3">
        <ContractTable name={name} contracts={contracts} />
        <SpotFutureChart points={chartPoints} name={name} />
        {name === 'NIFTY' && <CoCCallout contracts={contracts} />}
      </div>
    </section>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function FuturesDashboard() {
  const [data, setData]         = useState<FuturesResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [dlStatus, setDlStatus] = useState<FuturesRefreshStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/futures');
      const json: FuturesResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  const pollDownload = useCallback(async () => {
    try {
      const res  = await fetch('/api/futures-refresh');
      const json: FuturesRefreshStatus = await res.json();
      setDlStatus(json);
      if (!json.running && json.done) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        fetchData();
        setRefreshKey(k => k + 1);
      }
    } catch { /* ignore */ }
  }, [fetchData]);

  const startDownload = useCallback(async () => {
    try {
      const res = await fetch('/api/futures-refresh', { method: 'POST' });
      if (!res.ok) return;
      setDlStatus({ running: true, done: false, message: 'Starting…', error: null });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollDownload, 2000);
    } catch { /* ignore */ }
  }, [pollDownload]);

  useEffect(() => {
    fetchData();
    pollDownload();
  }, [fetchData, pollDownload]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* Sticky header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Futures Monitor
            </h1>
            {data?.dataDate && (
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                DATA: {data.dataDate}
              </p>
            )}
          </div>
        </div>

        <NavBar />
      </header>

      {/* Body */}
      <main className="flex-1 px-5 py-6 mx-auto w-full">
        {loading && !data ? (
          <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading futures data…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-red-400">
            <AlertCircle className="h-8 w-8" />
            <span className="text-sm text-center max-w-md">{error}</span>
          </div>
        ) : data ? (
          <div className="space-y-6">

            {/* Index basket turnover / OI header */}
            <FuturesBasketCards refreshKey={refreshKey} />

            {/* Market pulse ribbon */}
            <MarketPulseRibbon
              data={data}
              dlStatus={dlStatus}
              loading={loading}
              onDownload={startDownload}
              onReload={fetchData}
            />

            {/* NIFTY instrument section */}
            <InstrumentSection
              name="NIFTY"
              contracts={data.instruments.NIFTY}
              chartPoints={data.charts?.NIFTY ?? []}
            />

            {/* BANKNIFTY instrument section */}
            <InstrumentSection
              name="BANKNIFTY"
              contracts={data.instruments.BANKNIFTY}
              chartPoints={data.charts?.BANKNIFTY ?? []}
            />

            {/* OI Buildup */}
            <section className="border-t border-zinc-800 pt-6 mt-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-5 border-l-2 border-sky-500" />
                <h2 className="text-sm font-bold text-zinc-100">Stock Futures — OI Buildup</h2>
              </div>
              <OIBuildupDashboard refreshKey={refreshKey} />
            </section>

          </div>
        ) : null}
      </main>
    </div>
  );
}
