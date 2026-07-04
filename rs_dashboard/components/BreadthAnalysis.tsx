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

// ─── TrendBadge + helpers ─────────────────────────────────────────────────────

function TrendBadge({ state }: { state: string }) {
  const cls =
    state === 'Strong Uptrend' ? 'bg-emerald-950 text-emerald-400 border-emerald-800' :
    state === 'Uptrend'        ? 'bg-lime-950 text-lime-400 border-lime-800' :
    state === 'Above EMA 200'  ? 'bg-yellow-950 text-yellow-400 border-yellow-800' :
    state === 'Below EMA 200'  ? 'bg-orange-950 text-orange-400 border-orange-800' :
    state === 'Downtrend'      ? 'bg-red-950 text-red-400 border-red-800' :
    'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold border ${cls}`}>
      {state}
    </span>
  );
}

function adxInfo(adx: number | null): { label: string; cls: string } {
  if (adx === null) return { label: 'N/A', cls: 'text-zinc-500' };
  if (adx >= 40) return { label: 'Strong Trend', cls: 'text-emerald-400' };
  if (adx >= 25) return { label: 'Trending', cls: 'text-lime-400' };
  if (adx >= 20) return { label: 'Weak Trend', cls: 'text-yellow-400' };
  return { label: 'No Trend / Choppy', cls: 'text-orange-400' };
}

function chopInfo(chop: number | null): { label: string; cls: string } {
  if (chop === null) return { label: 'N/A', cls: 'text-zinc-500' };
  if (chop < 38.2) return { label: 'Trending', cls: 'text-emerald-400' };
  if (chop < 61.8) return { label: 'Transitioning', cls: 'text-yellow-400' };
  return { label: 'Choppy', cls: 'text-orange-400' };
}

// ─── IndexColumn ──────────────────────────────────────────────────────────────

function IndexColumn({ stats }: { stats: IndexStats }) {
  const score = getTrendStrengthScore(stats);
  const scoreClass = score >= 70 ? 'text-emerald-400' : score >= 55 ? 'text-lime-400' : score >= 45 ? 'text-yellow-400' : score >= 35 ? 'text-orange-400' : 'text-red-400';
  const scoreLabel = score >= 70 ? 'Strong' : score >= 55 ? 'Good' : score >= 45 ? 'Neutral' : score >= 35 ? 'Weakening' : 'Weak';
  const adx = adxInfo(stats.adx14);
  const chop = chopInfo(stats.chopIndex);

  return (
    <SectionCard>
      <CardHeader title="NIFTY 50 INDEX" subtitle="Trend analysis — EMA-based" />
      <div className="px-4 py-2">
        {/* Close — prominent */}
        <div className="py-3 border-b border-zinc-800/50">
          <div className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Close</div>
          <div className="text-3xl font-bold tabular-nums text-zinc-100">{fmt(stats.close)}</div>
        </div>

        <MetricRow
          label="Trend State"
          tooltip="EMA alignment: Strong Uptrend = Close > EMA20 > EMA50 > EMA200. Each step down removes one condition."
          tooltipScale="Strong Uptrend · Uptrend · Above EMA200 · Below EMA200 · Downtrend"
        >
          <TrendBadge state={stats.trendState} />
        </MetricRow>

        <MetricRow
          label="EMA 20"
          tooltip="20-day exponential moving average. Multiplier k = 2/(20+1) = 0.0952. Index uses EMA; stock breadth uses SMA."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema20)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma20)}`}>{fmtPct(stats.pctVsEma20)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="EMA 50"
          tooltip="50-day EMA — medium-term trend anchor. Index uses EMA; stock breadth uses SMA."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema50)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma50)}`}>{fmtPct(stats.pctVsEma50)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="EMA 200"
          tooltip="200-day EMA — long-term structural trend level. Primary input for regime classification."
        >
          <span>
            <span className="text-zinc-200 font-semibold tabular-nums">{fmt(stats.ema200)}</span>
            <span className={`text-xs ml-2 ${valueColorClass(stats.pctVsEma200)}`}>{fmtPct(stats.pctVsEma200)}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="ADX (14)"
          tooltip="Average Directional Index (Wilder smoothing, 14-period). Measures trend strength regardless of direction."
          tooltipScale=">40 strong trend · 25–40 trending · 20–25 weak · <20 no trend / choppy"
        >
          <span>
            <span className={`font-bold tabular-nums ${adx.cls}`}>{stats.adx14?.toFixed(1) ?? 'N/A'}</span>
            <span className={`text-xs ml-2 ${adx.cls}`}>{adx.label}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Chop Index"
          tooltip="Choppiness Index = 100 × log₁₀(ΣTR₁₄ / (HH₁₄ − LL₁₄)) / log₁₀(14). Below 38.2 = directional trend."
          tooltipScale="<38.2 trending · 38.2–61.8 transitioning · >61.8 choppy / ranging"
        >
          <span>
            <span className={`font-bold tabular-nums ${chop.cls}`}>{stats.chopIndex?.toFixed(1) ?? 'N/A'}</span>
            <span className={`text-xs ml-2 ${chop.cls}`}>{chop.label}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Trend Strength Score"
          tooltip="Composite: base 50; +20 Strong Uptrend / +10 Uptrend / +5 Above EMA200 / −10 Below EMA200 / −20 Downtrend. +15 if ADX≥25, −5 if ADX<20. Clamped 0–100."
          tooltipScale="≥70 strong · 55–70 good · 45–55 neutral · 35–45 weakening · <35 bearish"
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${scoreClass}`}>{score}</span>
            <span className="text-zinc-500 text-sm">/100</span>
            <span className={`text-xs ml-2 ${scoreClass}`}>{scoreLabel}</span>
          </span>
        </MetricRow>
      </div>
    </SectionCard>
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
          <div className="px-4 py-6 space-y-8">
            {/* Three-column comparison grid */}
            <div className="grid grid-cols-3 gap-4">
              <IndexColumn stats={data.nifty50} />
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center text-zinc-600 text-sm p-8">N50 Stocks — Task 5</div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-center text-zinc-600 text-sm p-8">N500 Stocks — Task 5</div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
