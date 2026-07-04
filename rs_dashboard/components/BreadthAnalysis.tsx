'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BreadthResponse, IndexStats, BreadthStats } from '@/app/api/breadth/route';
import NavBar from './NavBar';

// ─── Regime metadata ──────────────────────────────────────────────────────────

const REGIME_META = {
  green:  { label: 'BULL MARKET',    condition: '≥60% stocks above 200d SMA', action: 'Favour long/momentum strategies.',                           bg: 'bg-emerald-950', border: 'border-emerald-900', accent: 'border-l-emerald-500', text: 'text-emerald-400' },
  lime:   { label: 'CAUTIOUS BULL',  condition: '50–60% stocks above 200d SMA', action: 'Selective longs; avoid low-quality stocks.',               bg: 'bg-lime-950',    border: 'border-lime-900',    accent: 'border-l-lime-500',    text: 'text-lime-400'    },
  yellow: { label: 'CAUTION / CHOP', condition: '45–50% stocks above 200d SMA', action: 'Ideal for non-directional options (Straddles/Strangles).', bg: 'bg-yellow-950',  border: 'border-yellow-900',  accent: 'border-l-yellow-500',  text: 'text-yellow-400'  },
  orange: { label: 'TRANSITION',     condition: '40–45% stocks above 200d SMA', action: 'Reduce leverage; wait for breakout confirmation.',          bg: 'bg-orange-950',  border: 'border-orange-900',  accent: 'border-l-orange-500',  text: 'text-orange-400'  },
  red:    { label: 'BEAR MARKET',    condition: '<40% stocks above 200d SMA',   action: 'Avoid longs; hedge portfolio; favour cash.',                bg: 'bg-red-950',     border: 'border-red-900',     accent: 'border-l-red-500',     text: 'text-red-400'     },
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function valueColorClass(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

function pctSignalClass(pct: number): string {
  if (pct >= 60) return 'text-emerald-400';
  if (pct >= 50) return 'text-lime-400';
  if (pct >= 45) return 'text-yellow-400';
  if (pct >= 40) return 'text-orange-400';
  return 'text-red-400';
}

function pctBarClass(pct: number): string {
  if (pct >= 60) return 'bg-emerald-500';
  if (pct >= 50) return 'bg-lime-500';
  if (pct >= 45) return 'bg-yellow-500';
  if (pct >= 40) return 'bg-orange-500';
  return 'bg-red-500';
}

function getTrendStrengthScore(stats: IndexStats): number {
  let score = 50;
  if (stats.trendState === 'Strong Uptrend') score += 20;
  else if (stats.trendState === 'Uptrend') score += 10;
  else if (stats.trendState === 'Above EMA 200') score += 5;
  else if (stats.trendState === 'Below EMA 200') score -= 10;
  else if (stats.trendState === 'Downtrend') score -= 20;
  if (stats.adx14 !== null) {
    if (stats.adx14 >= 25) score += 15;
    else if (stats.adx14 < 20) score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

// ─── Primitive components ─────────────────────────────────────────────────────

function Tooltip({ label, content, scale }: { label: string; content: string; scale?: string }) {
  return (
    <span className="relative group inline-block">
      <span className="border-b border-dotted border-zinc-600 cursor-help text-zinc-400 text-xs font-medium uppercase tracking-widest leading-none">
        {label}
      </span>
      <span className="pointer-events-none absolute left-0 bottom-full mb-2 z-50 hidden group-hover:block w-72 bg-zinc-800 border border-zinc-700 rounded p-3 shadow-xl">
        <span className="block text-zinc-200 text-xs font-semibold mb-1">{label}</span>
        <span className="block text-zinc-300 text-xs leading-relaxed">{content}</span>
        {scale && <span className="block text-zinc-500 text-xs mt-2 leading-relaxed border-t border-zinc-700 pt-2">{scale}</span>}
      </span>
    </span>
  );
}

interface KPITileProps {
  label: string; tooltip: string; tooltipScale?: string;
  value: React.ReactNode; valueClass?: string;
  subLabel?: string; subClass?: string;
}
function KPITile({ label, tooltip, tooltipScale, value, valueClass, subLabel, subClass }: KPITileProps) {
  return (
    <div>
      <Tooltip label={label} content={tooltip} scale={tooltipScale} />
      <div className={`text-2xl font-bold tabular-nums mt-1 ${valueClass ?? 'text-zinc-100'}`}>{value}</div>
      {subLabel && <div className={`text-xs mt-0.5 ${subClass ?? 'text-zinc-400'}`}>{subLabel}</div>}
    </div>
  );
}

interface MetricRowProps {
  label: string; tooltip: string; tooltipScale?: string;
  children: React.ReactNode;
  bar?: { pct: number; colorClass: string };
}
function MetricRow({ label, tooltip, tooltipScale, children, bar }: MetricRowProps) {
  return (
    <div className="py-3 border-b border-zinc-800/50 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <Tooltip label={label} content={tooltip} scale={tooltipScale} />
        <div className="text-right">{children}</div>
      </div>
      {bar && (
        <div className="h-1.5 w-full bg-zinc-800 rounded-full mt-2">
          <div className={`h-full rounded-full ${bar.colorClass}`} style={{ width: `${Math.min(100, bar.pct)}%` }} />
        </div>
      )}
    </div>
  );
}

function SectionCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden ${className ?? ''}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="bg-zinc-800 px-4 py-3">
      <div className="text-xs font-bold text-white uppercase tracking-widest">{title}</div>
      {subtitle && <div className="text-xs text-zinc-500 mt-0.5">{subtitle}</div>}
    </div>
  );
}

// ─── Regime Banner ────────────────────────────────────────────────────────────

function RegimeBanner({ data }: { data: BreadthResponse }) {
  const meta = REGIME_META[data.regimeColor];
  const b = data.nifty500Breadth;

  const partClass = b.participationScore >= 70 ? 'text-emerald-400' : b.participationScore >= 55 ? 'text-lime-400' : b.participationScore >= 45 ? 'text-yellow-400' : b.participationScore >= 35 ? 'text-orange-400' : 'text-red-400';
  const partLabel = b.participationScore >= 70 ? 'Strong Participation' : b.participationScore >= 55 ? 'Good Participation' : b.participationScore >= 45 ? 'Neutral' : b.participationScore >= 35 ? 'Weak Participation' : 'Very Weak';

  const adClass = b.advDecRatio >= 2 ? 'text-emerald-400' : b.advDecRatio >= 1 ? 'text-lime-400' : b.advDecRatio >= 0.5 ? 'text-yellow-400' : 'text-red-400';
  const adLabel = b.advDecRatio >= 3 ? 'Strongly Bullish' : b.advDecRatio >= 2 ? 'Bullish' : b.advDecRatio >= 1 ? 'Neutral-Bull' : b.advDecRatio >= 0.5 ? 'Neutral-Bear' : 'Bearish';

  const netClass = b.netAdvanceDecline >= 0 ? 'text-emerald-400' : 'text-red-400';
  const netStr = (b.netAdvanceDecline > 0 ? '+' : '') + b.netAdvanceDecline;

  return (
    <div className={`${meta.bg} ${meta.border} border-b border-l-4 ${meta.accent} px-6 py-5 flex items-center gap-8 flex-wrap`}>
      <div>
        <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Market Regime · Nifty 500</div>
        <div className={`text-3xl font-black tracking-wider ${meta.text}`}>{meta.label}</div>
      </div>

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="Participation Score"
        tooltip="Weighted composite of Nifty 500 breadth metrics."
        tooltipScale="SMA200 pct ×0.40 + SMA50 pct ×0.30 + SMA20 pct ×0.20 + A/D transform ×0.10"
        value={<>{b.participationScore}<span className="text-base text-zinc-500">/100</span></>}
        valueClass={partClass}
        subLabel={partLabel}
        subClass={partClass}
      />

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="A/D Ratio (1W)"
        tooltip="Advancing ÷ Declining stocks over past 7 calendar days. Nifty 500 universe."
        tooltipScale="≥3 strongly bullish · ≥2 bullish · ≥1 neutral-bull · <0.5 bearish"
        value={<>{b.advDecRatio.toFixed(2)}<span className="text-base text-zinc-500">x</span></>}
        valueClass={adClass}
        subLabel={adLabel}
        subClass={adClass}
      />

      <div className="w-px h-12 bg-zinc-800 hidden sm:block" />

      <KPITile
        label="Net Advance-Decline"
        tooltip="Advancing minus Declining stocks (past 7 calendar days). Nifty 500 universe."
        value={netStr}
        valueClass={netClass}
        subLabel={`${b.advancing1W} adv · ${b.declining1W} dec`}
        subClass="text-zinc-500"
      />

      <div className="ml-auto text-right hidden lg:block max-w-xs">
        <div className="text-xs text-zinc-500 uppercase tracking-widest">{meta.condition}</div>
        <div className="text-sm text-zinc-300 mt-1">{meta.action}</div>
      </div>
    </div>
  );
}

// ─── Main component (stub — sections added in Tasks 3–6) ─────────────────────

export default function BreadthAnalysis() {
  const [data, setData] = useState<BreadthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/breadth');
      const json = await res.json();
      if (json.success) {
        setData(json.data);
        setLastUpdated(new Date());
      } else {
        setError(json.error ?? 'Failed to load breadth data');
      }
    } catch {
      setError('Network error. Failed to load breadth data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return (
    <div className="bg-zinc-950 min-h-screen flex flex-col">
      {/* Sticky Header */}
      <header className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 flex items-center gap-4 sticky top-0 z-30 flex-wrap">
        <div>
          <div className="text-sm font-bold text-zinc-100 tracking-wide uppercase">Market Breadth</div>
          <div className="text-xs text-zinc-500 tracking-widest">Nifty 50 · Nifty 500 Universe</div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="font-mono text-xs bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">
              DATA: {data.dataDate}
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-zinc-500">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={fetchData}
            className="w-8 h-8 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-600 text-zinc-400 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-amber-400' : ''} />
          </button>
        </div>
      </header>

      {/* Loading */}
      {loading && !data && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <RefreshCw size={20} className="animate-spin text-zinc-400" />
          <div className="text-sm text-zinc-400 uppercase tracking-widest">Computing Breadth…</div>
          <div className="text-xs text-zinc-600 uppercase tracking-widest">Scanning Nifty 500 Universe</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="m-4 p-3 border border-red-900 bg-red-950 text-red-400 text-sm rounded">
          {error}
        </div>
      )}

      {/* Content — populated in Tasks 3–6 */}
      {data && (
        <main className="flex-1 overflow-y-auto">
          <RegimeBanner data={data} />
          <div className="px-4 py-6">
            <p className="text-zinc-500 text-sm">Grid loading…</p>
          </div>
        </main>
      )}
    </div>
  );
}
