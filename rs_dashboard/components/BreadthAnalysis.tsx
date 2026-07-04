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

// ─── BreadthColumn ────────────────────────────────────────────────────────────

function BreadthColumn({ title, subtitle, stats }: { title: string; subtitle: string; stats: BreadthStats }) {
  const total = stats.totalScanned;

  const partClass = stats.participationScore >= 70 ? 'text-emerald-400' : stats.participationScore >= 55 ? 'text-lime-400' : stats.participationScore >= 45 ? 'text-yellow-400' : stats.participationScore >= 35 ? 'text-orange-400' : 'text-red-400';
  const partLabel = stats.participationScore >= 70 ? 'Strong' : stats.participationScore >= 55 ? 'Good' : stats.participationScore >= 45 ? 'Neutral' : stats.participationScore >= 35 ? 'Weak' : 'Very Weak';

  const adClass = stats.advDecRatio >= 2 ? 'text-emerald-400' : stats.advDecRatio >= 1 ? 'text-lime-400' : stats.advDecRatio >= 0.5 ? 'text-yellow-400' : 'text-red-400';
  const adLabel = stats.advDecRatio >= 3 ? 'Strongly Bullish' : stats.advDecRatio >= 2 ? 'Bullish' : stats.advDecRatio >= 1 ? 'Neutral-Bull' : stats.advDecRatio >= 0.5 ? 'Neutral-Bear' : 'Bearish';
  const netClass = stats.netAdvanceDecline >= 0 ? 'text-emerald-400' : 'text-red-400';

  const rsiElevated = stats.rsiAbove60 - stats.rsiOverbought;
  const rsiNeutral40to60 = stats.rsiBucket40to70 - rsiElevated;

  const hlRatio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
  const hlClass = hlRatio >= 2 ? 'text-emerald-400' : hlRatio >= 1 ? 'text-yellow-400' : 'text-red-400';

  return (
    <SectionCard>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="px-4 py-2">
        {/* Participation Score prominent */}
        <div className="py-3 border-b border-zinc-800/50">
          <div className="mb-1">
            <Tooltip
              label="Participation Score"
              content="Weighted composite of breadth metrics."
              scale="SMA200 pct ×0.40 + SMA50 pct ×0.30 + SMA20 pct ×0.20 + A/D transform ×0.10"
            />
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold tabular-nums ${partClass}`}>{stats.participationScore}</span>
            <span className="text-base text-zinc-500">/100</span>
            <span className={`text-xs ${partClass}`}>{partLabel}</span>
          </div>
        </div>

        <MetricRow
          label="Above SMA 200"
          tooltip="Stocks with close > 200-day simple moving average. Primary breadth/regime indicator. Note: stock breadth uses SMA; Nifty 50 Index uses EMA."
          tooltipScale="≥60% bull · 50–60% cautious · 45–50% caution/chop · 40–45% transition · <40% bear"
          bar={{ pct: stats.aboveEma200Pct, colorClass: pctBarClass(stats.aboveEma200Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma200Pct)}`}>{stats.aboveEma200Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma200Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Above SMA 50"
          tooltip="Stocks above 50-day simple moving average — medium-term market breadth."
          bar={{ pct: stats.aboveEma50Pct, colorClass: pctBarClass(stats.aboveEma50Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma50Pct)}`}>{stats.aboveEma50Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma50Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Above SMA 20"
          tooltip="Stocks above 20-day simple moving average — short-term breadth momentum."
          bar={{ pct: stats.aboveEma20Pct, colorClass: pctBarClass(stats.aboveEma20Pct) }}
        >
          <span>
            <span className={`text-xl font-bold tabular-nums ${pctSignalClass(stats.aboveEma20Pct)}`}>{stats.aboveEma20Pct}%</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.aboveEma20Count}/{total})</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Bull Power"
          tooltip="Close > SMA20 > SMA50 > SMA200 — all three MAs fully bullish-aligned. Strongest structural buy signal."
        >
          <span>
            <span className="text-emerald-400 font-bold tabular-nums">{stats.bullPowerCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.bullPowerPct}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Bear Power"
          tooltip="Close < SMA20 < SMA50 < SMA200 — all three MAs fully bearish-aligned. Strongest structural sell signal."
        >
          <span>
            <span className="text-red-400 font-bold tabular-nums">{stats.bearPowerCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({stats.bearPowerPct}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="A/D Ratio (1W)"
          tooltip="Advancing ÷ Declining stocks over past 7 calendar days (not trading days — weekend gaps included)."
          tooltipScale="≥3 strongly bullish · ≥2 bullish · ≥1 neutral-bull · <0.5 bearish"
        >
          <span>
            <span className={`font-bold tabular-nums ${adClass}`}>{stats.advDecRatio.toFixed(2)}x</span>
            <span className={`text-xs ml-1 ${adClass}`}>{adLabel}</span>
          </span>
        </MetricRow>

        <MetricRow
          label="Net A/D"
          tooltip="Advancing stocks minus Declining stocks (past 7 calendar days)."
        >
          <span className={`font-semibold tabular-nums ${netClass}`}>
            {stats.netAdvanceDecline > 0 ? '+' : ''}{stats.netAdvanceDecline}
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Overbought >70"
          tooltip="14-period Wilder RSI > 70. High reading = crowded market, elevated mean-reversion risk."
          bar={{ pct: total > 0 ? (stats.rsiOverbought / total) * 100 : 0, colorClass: 'bg-red-500' }}
        >
          <span>
            <span className="text-red-400 font-semibold tabular-nums">{stats.rsiOverbought}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.rsiOverbought / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Elevated 60–70"
          tooltip="RSI 60–70 = bullish momentum zone, not yet overextended. Derived: rsiAbove60 − rsiOverbought."
          bar={{ pct: total > 0 ? (rsiElevated / total) * 100 : 0, colorClass: 'bg-orange-500' }}
        >
          <span>
            <span className="text-orange-400 font-semibold tabular-nums">{rsiElevated}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((rsiElevated / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Neutral 40–60"
          tooltip="RSI 40–60 = neutral zone, no strong directional momentum. Derived: rsiBucket40to70 − (rsiAbove60 − rsiOverbought)."
          bar={{ pct: total > 0 ? (rsiNeutral40to60 / total) * 100 : 0, colorClass: 'bg-zinc-500' }}
        >
          <span>
            <span className="text-zinc-400 font-semibold tabular-nums">{rsiNeutral40to60}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((rsiNeutral40to60 / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="RSI Oversold <40"
          tooltip="14-period Wilder RSI < 40. Potential mean-reversion / oversold bounce candidates."
          bar={{ pct: total > 0 ? (stats.rsiOversold / total) * 100 : 0, colorClass: 'bg-emerald-500' }}
        >
          <span>
            <span className="text-emerald-400 font-semibold tabular-nums">{stats.rsiOversold}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.rsiOversold / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="52W Highs"
          tooltip="Stocks within 0.5% of their 52-week high (trailing 252 trading days). Threshold: (close − high52W) / high52W ≥ −0.005."
        >
          <span>
            <span className="text-emerald-400 font-semibold tabular-nums">{stats.new52WHighCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.new52WHighCount / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="52W Lows"
          tooltip="Stocks within 0.5% of their 52-week low (trailing 252 trading days). Threshold: (close − low52W) / low52W ≤ 0.005."
        >
          <span>
            <span className="text-red-400 font-semibold tabular-nums">{stats.new52WLowCount}</span>
            <span className="text-xs text-zinc-500 ml-1">({total > 0 ? ((stats.new52WLowCount / total) * 100).toFixed(1) : 0}%)</span>
          </span>
        </MetricRow>

        <MetricRow
          label="H/L Ratio"
          tooltip="New 52W Highs ÷ New 52W Lows. Measures balance of bullish vs bearish price extremes."
          tooltipScale="≥2 bullish · ≥1 slightly bullish · <0.5 bearish"
        >
          <span className={`font-bold tabular-nums ${hlClass}`}>
            {stats.new52WLowCount > 0 ? hlRatio.toFixed(2) + 'x' : `${stats.new52WHighCount}H / 0L`}
          </span>
        </MetricRow>
      </div>
    </SectionCard>
  );
}

// ─── MAPenetrationTable ───────────────────────────────────────────────────────

function MAPenetrationTable({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  const rows = (stats: BreadthStats) => [
    {
      label: 'Above SMA 20', count: stats.aboveEma20Count, pct: stats.aboveEma20Pct,
      signal: stats.aboveEma20Pct > 60 ? 'Short-term broadly bullish' : stats.aboveEma20Pct > 40 ? 'Mixed; watch for expansion' : 'Short-term breadth weak',
    },
    {
      label: 'Above SMA 50', count: stats.aboveEma50Count, pct: stats.aboveEma50Pct,
      signal: stats.aboveEma50Pct > 55 ? 'Medium-term healthy breadth' : stats.aboveEma50Pct > 40 ? 'Neutral; caution advised' : 'Medium-term deteriorating',
    },
    {
      label: 'Above SMA 200', count: stats.aboveEma200Count, pct: stats.aboveEma200Pct,
      signal: stats.aboveEma200Pct >= 60 ? 'Structural bull' : stats.aboveEma200Pct >= 50 ? 'Cautiously positive' : stats.aboveEma200Pct >= 40 ? 'Transition zone' : 'Structural bear',
    },
  ];

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">MA Penetration Detail</div>
      <div className="grid grid-cols-2 gap-4">
        {([['NIFTY 50 STOCKS', n50], ['NIFTY 500 STOCKS', n500]] as [string, BreadthStats][]).map(([label, stats]) => (
          <SectionCard key={label}>
            <CardHeader title={label} subtitle="Simple moving average penetration" />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-zinc-800">
                    {['Indicator', 'Count', '% Universe', 'Below', 'Signal'].map(h => (
                      <th key={h} className="text-left px-3 py-2 text-xs font-bold text-white uppercase tracking-widest border-b border-zinc-700">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows(stats).map(row => {
                    const rowBg = row.pct >= 60 ? 'bg-emerald-950/40' : row.pct < 40 ? 'bg-red-950/40' : '';
                    return (
                      <tr key={row.label} className={`border-b border-zinc-800/50 ${rowBg}`}>
                        <td className="px-3 py-2.5 text-xs text-zinc-300">{row.label}</td>
                        <td className={`px-3 py-2.5 text-sm font-bold tabular-nums ${pctSignalClass(row.pct)}`}>{row.count}</td>
                        <td className={`px-3 py-2.5 text-sm font-bold tabular-nums ${pctSignalClass(row.pct)}`}>{row.pct}%</td>
                        <td className="px-3 py-2.5 text-xs text-zinc-500">{stats.totalScanned - row.count} ({(100 - row.pct).toFixed(1)}%)</td>
                        <td className="px-3 py-2.5 text-xs text-zinc-400">{row.signal}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        ))}
      </div>
    </div>
  );
}

// ─── RSIDistribution ──────────────────────────────────────────────────────────

function RSIDistribution({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function buildSegs(stats: BreadthStats) {
    const total = stats.totalScanned;
    const elevated = Math.max(0, stats.rsiAbove60 - stats.rsiOverbought);
    const neutral = Math.max(0, stats.rsiBucket40to70 - elevated);
    return [
      { label: '>70 Overbought', count: stats.rsiOverbought, pct: total > 0 ? (stats.rsiOverbought / total) * 100 : 0, bg: 'bg-red-500' },
      { label: '60–70 Elevated', count: elevated, pct: total > 0 ? (elevated / total) * 100 : 0, bg: 'bg-orange-500' },
      { label: '40–60 Neutral', count: neutral, pct: total > 0 ? (neutral / total) * 100 : 0, bg: 'bg-zinc-600' },
      { label: '<40 Oversold', count: stats.rsiOversold, pct: total > 0 ? (stats.rsiOversold / total) * 100 : 0, bg: 'bg-emerald-500' },
    ];
  }

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">
        <Tooltip label="RSI Distribution (14-Period)" content="Wilder RSI computed over trailing 60 closes per stock. Buckets: >70 overbought, 60–70 elevated, 40–60 neutral, <40 oversold." />
      </div>
      <div className="grid grid-cols-2 gap-4">
        {([['NIFTY 50 STOCKS', n50], ['NIFTY 500 STOCKS', n500]] as [string, BreadthStats][]).map(([label, stats]) => {
          const segs = buildSegs(stats);
          return (
            <SectionCard key={label}>
              <CardHeader title={label} subtitle="RSI zone breakdown" />
              <div className="px-4 py-4">
                <div className="h-10 flex rounded overflow-hidden gap-px mb-4">
                  {segs.map(seg => (
                    <div
                      key={seg.label}
                      className={`${seg.bg} flex items-center justify-center`}
                      style={{ width: `${seg.pct}%`, minWidth: seg.pct > 0 ? 2 : 0 }}
                    >
                      {seg.pct > 8 && (
                        <span className="text-xs text-white font-bold">{seg.pct.toFixed(0)}%</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-y-2">
                  {segs.map(seg => (
                    <div key={seg.label} className="flex items-center justify-between pr-4">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-sm flex-shrink-0 ${seg.bg}`} />
                        <span className="text-xs text-zinc-400">{seg.label}</span>
                      </div>
                      <span className="text-xs font-semibold tabular-nums text-zinc-200">
                        {seg.count} <span className="text-zinc-500">({seg.pct.toFixed(1)}%)</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </SectionCard>
          );
        })}
      </div>
    </div>
  );
}

// ─── Extremes52W ──────────────────────────────────────────────────────────────

function Extremes52W({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function Panel({ stats, label }: { stats: BreadthStats; label: string }) {
    const total = stats.totalScanned;
    const highPct = total > 0 ? (stats.new52WHighCount / total) * 100 : 0;
    const lowPct = total > 0 ? (stats.new52WLowCount / total) * 100 : 0;
    const ratio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
    const ratioClass = ratio >= 2 ? 'text-emerald-400' : ratio >= 1 ? 'text-yellow-400' : 'text-red-400';
    const ratioLabel = ratio >= 2 ? 'Bullish — highs dominating' : ratio >= 1 ? 'Slightly bullish' : ratio >= 0.5 ? 'Slightly bearish' : 'Bearish — lows dominating';

    return (
      <SectionCard>
        <CardHeader title={label} subtitle="Within 0.5% of 52-week extreme" />
        <div className="px-4 py-4 space-y-4">
          <div>
            <div className="flex justify-between mb-1.5">
              <Tooltip label="New 52W Highs" content="Stocks within 0.5% of their 52-week high. Formula: (close − high52W) / high52W ≥ −0.005." />
              <span className="text-emerald-400 text-sm font-semibold tabular-nums">
                {stats.new52WHighCount} <span className="text-zinc-500 text-xs">({highPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${highPct}%` }} />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1.5">
              <Tooltip label="New 52W Lows" content="Stocks within 0.5% of their 52-week low. Formula: (close − low52W) / low52W ≤ 0.005." />
              <span className="text-red-400 text-sm font-semibold tabular-nums">
                {stats.new52WLowCount} <span className="text-zinc-500 text-xs">({lowPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full">
              <div className="h-full bg-red-500 rounded-full" style={{ width: `${lowPct}%` }} />
            </div>
          </div>

          <div className="pt-3 border-t border-zinc-800">
            <Tooltip
              label="H/L Ratio"
              content="New 52W Highs ÷ New 52W Lows. Positive divergence: N50 highs dominate while N500 shows fewer — signals narrow market leadership."
              scale="≥2 bullish · ≥1 slightly bullish · <0.5 bearish"
            />
            <div className={`text-2xl font-bold tabular-nums mt-1 ${ratioClass}`}>
              {stats.new52WLowCount > 0 ? ratio.toFixed(2) + 'x' : `${stats.new52WHighCount}H / 0L`}
            </div>
            <div className={`text-xs mt-0.5 ${ratioClass}`}>{ratioLabel}</div>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <div>
      <div className="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3">52-Week Extremes</div>
      <div className="grid grid-cols-2 gap-4">
        <Panel stats={n50} label="NIFTY 50 STOCKS" />
        <Panel stats={n500} label="NIFTY 500 STOCKS" />
      </div>
    </div>
  );
}

// ─── RegimeGuide ──────────────────────────────────────────────────────────────

function RegimeGuide({ activeColor }: { activeColor: BreadthResponse['regimeColor'] }) {
  return (
    <SectionCard>
      <CardHeader title="REGIME INTERPRETATION GUIDE" subtitle="Breadth-derived market regime thresholds — based on Nifty 500 % above 200d SMA" />
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-zinc-800">
              {['Regime', 'Condition (Nifty 500)', 'Trading Action'].map(h => (
                <th key={h} className="text-left px-4 py-2.5 text-xs font-bold text-white uppercase tracking-widest border-b border-zinc-700">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(Object.entries(REGIME_META) as [BreadthResponse['regimeColor'], typeof REGIME_META[keyof typeof REGIME_META]][]).map(([key, meta]) => {
              const isActive = key === activeColor;
              return (
                <tr
                  key={key}
                  className={`border-b border-zinc-800/50 border-l-4 ${isActive ? `${meta.bg} ${meta.accent}` : 'border-l-transparent'}`}
                >
                  <td className={`px-4 py-3 text-sm font-semibold ${isActive ? meta.text : 'text-zinc-600'}`}>
                    {isActive && <span className="mr-1.5">▶</span>}{meta.label}
                  </td>
                  <td className={`px-4 py-3 text-sm ${isActive ? 'text-zinc-200' : 'text-zinc-600'}`}>{meta.condition}</td>
                  <td className={`px-4 py-3 text-sm ${isActive ? 'text-zinc-300' : 'text-zinc-700'}`}>{meta.action}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

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

      {data && (
        <main className="flex-1 overflow-y-auto">
          <RegimeBanner data={data} />
          <div className="px-4 py-6 space-y-8">
            {/* Three-column comparison grid */}
            <div className="grid grid-cols-3 gap-4">
              <IndexColumn stats={data.nifty50} />
              <BreadthColumn title="NIFTY 50 STOCKS" subtitle="50 constituents" stats={data.nifty50Breadth} />
              <BreadthColumn title="NIFTY 500 STOCKS" subtitle="500 universe" stats={data.nifty500Breadth} />
            </div>

            <MAPenetrationTable n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
            <RSIDistribution n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
            <Extremes52W n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
            <RegimeGuide activeColor={data.regimeColor} />
          </div>
        </main>
      )}
    </div>
  );
}
