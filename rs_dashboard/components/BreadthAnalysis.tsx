'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, Cell, RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts';
import type { BreadthResponse, IndexStats, BreadthStats } from '@/app/api/breadth/route';
import NavBar from './NavBar';
import { Tooltip as HelpTooltip, TooltipContent as HelpTooltipContent, TooltipTrigger as HelpTooltipTrigger } from './ui/tooltip';

// ─── Series colours (house convention: cyan = N50, amber = N500) ──────────────

const N50_COLOR   = '#22d3ee';
const N500_COLOR  = '#fbbf24';
const UP_COLOR    = '#34d399';
const DOWN_COLOR  = '#f87171';

// ─── Regime metadata ──────────────────────────────────────────────────────────

const REGIME_META = {
  green:  { label: 'BULL MARKET',    condition: '≥60% > 200d SMA', action: 'Favour long / momentum strategies.',                     hex: '#34d399', text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25' },
  lime:   { label: 'CAUTIOUS BULL',  condition: '50–60% > 200d SMA', action: 'Selective longs; avoid low-quality names.',            hex: '#a3e635', text: 'text-lime-400',    bg: 'bg-lime-500/10',    border: 'border-lime-500/25'    },
  yellow: { label: 'CAUTION / CHOP', condition: '45–50% > 200d SMA', action: 'Favour non-directional options (straddle/strangle).',  hex: '#facc15', text: 'text-yellow-400',  bg: 'bg-yellow-500/10',  border: 'border-yellow-500/25'  },
  orange: { label: 'TRANSITION',     condition: '40–45% > 200d SMA', action: 'Reduce leverage; wait for confirmation.',              hex: '#fb923c', text: 'text-orange-400',  bg: 'bg-orange-500/10',  border: 'border-orange-500/25'  },
  red:    { label: 'BEAR MARKET',    condition: '<40% > 200d SMA',   action: 'Avoid longs; hedge; favour cash.',                     hex: '#f87171', text: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/25'     },
} as const;

// ─── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPct(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function scoreColor(pct: number): string {
  if (pct >= 60) return '#34d399';
  if (pct >= 50) return '#a3e635';
  if (pct >= 45) return '#facc15';
  if (pct >= 35) return '#fb923c';
  return '#f87171';
}
function scoreTextClass(pct: number): string {
  if (pct >= 60) return 'text-emerald-400';
  if (pct >= 50) return 'text-lime-400';
  if (pct >= 45) return 'text-yellow-400';
  if (pct >= 35) return 'text-orange-400';
  return 'text-red-400';
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

// ─── Shared quant-terminal primitives ──────────────────────────────────────────

function PulseStat({
  label, value, sub, color = 'text-white', size = 'text-lg', tip,
}: { label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; size?: string; tip?: string }) {
  const labelEl = (
    <span className={`text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5 ${tip ? 'cursor-help' : ''}`}>{label}</span>
  );
  return (
    <div className="flex flex-col min-w-0">
      {tip ? (
        <HelpTooltip>
          <HelpTooltipTrigger render={labelEl} />
          <HelpTooltipContent>{tip}</HelpTooltipContent>
        </HelpTooltip>
      ) : labelEl}
      <span className={`${size} font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

function ChartHeader({
  eyebrow, title, sub, legend, tip,
}: { eyebrow: string; title: string; sub: string; legend?: React.ReactNode; tip?: string }) {
  const titleEl = (
    <p className={`text-sm font-bold text-white tracking-tight ${tip ? 'cursor-help' : ''}`}>{title}</p>
  );
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        {tip ? (
          <HelpTooltip>
            <HelpTooltipTrigger render={titleEl} />
            <HelpTooltipContent>{tip}</HelpTooltipContent>
          </HelpTooltip>
        ) : titleEl}
        <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold">{legend}</div>}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-zinc-300">{label}</span>
    </span>
  );
}

const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };
const tickStyle = { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' };

function ChartCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 ${className ?? ''}`}>
      {children}
    </div>
  );
}

// ─── Custom tooltip ─────────────────────────────────────────────────────────────

interface BarTooltipRow { name: string; value: number; color: string; unit?: string }
function BarTooltip({ active, payload, label }: Record<string, unknown>) {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const rows = payload as Array<{ name: string; value: number; color: string; payload: Record<string, unknown> }>;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{String(label)}</p>
      {rows.map((r) => (
        <div key={r.name} className="flex justify-between gap-8 mb-1 last:mb-0">
          <span className="font-semibold font-sans" style={{ color: r.color }}>{r.name}</span>
          <span className="text-white font-bold tabular-nums">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Regime spectrum bar ────────────────────────────────────────────────────────

function RegimeSpectrum({ pct, activeColor }: { pct: number; activeColor: BreadthResponse['regimeColor'] }) {
  // Non-uniform bands mapped onto a 0–80 display domain (clamped) so the
  // marker position visually matches where the live % sits within its band.
  const bands: Array<{ key: keyof typeof REGIME_META; from: number; to: number }> = [
    { key: 'red', from: 0, to: 40 },
    { key: 'orange', from: 40, to: 45 },
    { key: 'yellow', from: 45, to: 50 },
    { key: 'lime', from: 50, to: 60 },
    { key: 'green', from: 60, to: 80 },
  ];
  const markerPos = `${(Math.min(80, Math.max(0, pct)) / 80) * 100}%`;

  return (
    <div className="w-full">
      <div className="flex justify-between mb-1.5">
        <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em]">Bear</span>
        <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em]">Bull</span>
      </div>
      <div className="relative h-3 w-full rounded-full overflow-hidden flex">
        {bands.map((b) => (
          <div
            key={b.key}
            style={{ width: `${((b.to - b.from) / 80) * 100}%`, backgroundColor: REGIME_META[b.key].hex, opacity: b.key === activeColor ? 1 : 0.35 }}
          />
        ))}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow-[0_0_0_3px_rgba(0,0,0,0.6)] border border-zinc-900"
          style={{ left: markerPos }}
          title={`${pct}% of Nifty 500 above 200d SMA`}
        />
      </div>
      <div className="flex justify-between mt-1.5 text-[9px] text-zinc-600 font-mono tabular-nums">
        <span>0%</span><span>40</span><span>45</span><span>50</span><span>60</span><span>80%+</span>
      </div>
    </div>
  );
}

// ─── Market pulse ribbon (regime + headline stats) ─────────────────────────────

function MarketPulseRibbon({ data }: { data: BreadthResponse }) {
  const meta = REGIME_META[data.regimeColor];
  const b = data.nifty500Breadth;
  const netClass = b.netAdvanceDecline >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-red-500/[0.04]" />

      <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
        <div className="flex flex-col justify-center min-w-[220px]">
          <HelpTooltip>
            <HelpTooltipTrigger render={<span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1 cursor-help">Market Regime · Nifty 500</span>} />
            <HelpTooltipContent>Regime is based on the % of Nifty 500 stocks trading above their 200-day SMA.</HelpTooltipContent>
          </HelpTooltip>
          <span className={`inline-flex items-center gap-2 text-xl font-black tracking-wide ${meta.text}`}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.hex }} />
            {meta.label}
          </span>
          <span className="text-[10px] text-zinc-500 mt-1">{meta.action}</span>
        </div>

        <div className="w-px bg-zinc-800 self-stretch" />

        <PulseStat
          label="Participation Score"
          value={<>{b.participationScore}<span className="text-sm text-zinc-500">/100</span></>}
          color={scoreTextClass(b.participationScore)}
          size="text-2xl"
          tip="Weighted blend of SMA200/50/20 breadth and A/D ratio — 0-100, higher = broader rally."
        />
        <div className="w-px bg-zinc-800 self-stretch" />
        <PulseStat
          label="A/D Ratio (1W)"
          value={<>{b.advDecRatio.toFixed(2)}<span className="text-sm text-zinc-500">x</span></>}
          color={b.advDecRatio >= 1 ? 'text-emerald-400' : 'text-red-400'}
          size="text-2xl"
          tip="Advancing vs declining stocks over the last week; above 1x favors bulls."
        />
        <div className="w-px bg-zinc-800 self-stretch" />
        <PulseStat
          label="Net Advance-Decline"
          value={(b.netAdvanceDecline > 0 ? '+' : '') + b.netAdvanceDecline}
          color={netClass}
          sub={`${b.advancing1W} adv · ${b.declining1W} dec`}
          size="text-2xl"
          tip="Advancing minus declining stocks today."
        />

        <div className="ml-auto flex flex-col justify-center min-w-[260px] max-w-xs">
          <RegimeSpectrum pct={b.aboveEma200Pct} activeColor={data.regimeColor} />
        </div>
      </div>
    </div>
  );
}

// ─── Index trend card (EMA distance ladder) ────────────────────────────────────

function TrendBadge({ state }: { state: string }) {
  const cls =
    state === 'Strong Uptrend' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' :
    state === 'Uptrend'        ? 'bg-lime-500/10 text-lime-400 border-lime-500/25' :
    state === 'Above EMA 200'  ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/25' :
    state === 'Below EMA 200'  ? 'bg-orange-500/10 text-orange-400 border-orange-500/25' :
    state === 'Downtrend'      ? 'bg-red-500/10 text-red-400 border-red-500/25' :
    'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${cls}`}>
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

function IndexTrendCard({ stats }: { stats: IndexStats }) {
  const score = getTrendStrengthScore(stats);
  const adx = adxInfo(stats.adx14);
  const chop = chopInfo(stats.chopIndex);

  const rows = [
    { label: 'EMA 20', value: stats.ema20, pct: stats.pctVsEma20 },
    { label: 'EMA 50', value: stats.ema50, pct: stats.pctVsEma50 },
    { label: 'EMA 200', value: stats.ema200, pct: stats.pctVsEma200 },
  ];
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pct)));

  return (
    <ChartCard>
      <ChartHeader eyebrow="NIFTY 50 Index" title="Trend Ladder" sub="Close vs EMA — distance in %, EMA-based" tip="Nifty 50's close plotted against its EMA 20/50/200 — shows trend distance at a glance." />

      <div className="flex items-end gap-4 mb-4">
        <PulseStat label="Close" value={fmt(stats.close)} size="text-2xl" />
        <TrendBadge state={stats.trendState} />
      </div>

      <div className="space-y-3 mb-4">
        {rows.map((r) => {
          const widthPct = (Math.abs(r.pct) / maxAbs) * 50;
          const positive = r.pct >= 0;
          return (
            <div key={r.label} className="flex items-center gap-2">
              <span className="w-16 text-[10px] font-bold text-zinc-500 uppercase tracking-wider shrink-0">{r.label}</span>
              <div className="relative flex-1 h-4 flex items-center">
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-zinc-700" />
                <div
                  className={`absolute top-1/2 -translate-y-1/2 h-2 rounded-sm ${positive ? 'bg-emerald-500' : 'bg-red-500'}`}
                  style={{
                    width: `${widthPct}%`,
                    left: positive ? '50%' : `${50 - widthPct}%`,
                  }}
                />
              </div>
              <span className={`w-16 text-right text-xs font-mono font-bold tabular-nums ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                {fmtPct(r.pct)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-3 pt-3 border-t border-zinc-800">
        <PulseStat label="ADX (14)" value={stats.adx14?.toFixed(1) ?? 'N/A'} color={adx.cls} sub={adx.label} size="text-base" tip="Trend strength (not direction) — above 25 signals a trending market." />
        <PulseStat label="Chop Idx" value={stats.chopIndex?.toFixed(1) ?? 'N/A'} color={chop.cls} sub={chop.label} size="text-base" tip="Choppiness Index — below 38 = trending, above 62 = range-bound/choppy." />
        <PulseStat label="Trend Score" value={<>{score}<span className="text-xs text-zinc-500">/100</span></>} color={scoreTextClass(score)} size="text-base" tip="Composite 0-100 score from trend state + ADX." />
      </div>
    </ChartCard>
  );
}

// ─── Participation gauges (N50 vs N500) ────────────────────────────────────────

function ParticipationGauges({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function Gauge({ label, score, color }: { label: string; score: number; color: string }) {
    const data = [{ name: label, value: score, fill: color }];
    return (
      <div className="flex flex-col items-center">
        <div className="relative w-full h-[130px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadialBarChart
              data={data}
              startAngle={225}
              endAngle={-45}
              innerRadius="72%"
              outerRadius="100%"
              barSize={10}
            >
              <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
              <RadialBar dataKey="value" cornerRadius={6} background={{ fill: '#27272a' }} />
            </RadialBarChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-mono font-bold tabular-nums" style={{ color }}>{score}</span>
            <span className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest -mt-0.5">/ 100</span>
          </div>
        </div>
        <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest -mt-2">{label}</span>
      </div>
    );
  }

  return (
    <ChartCard>
      <ChartHeader eyebrow="Composite" title="Participation Score" sub="SMA200×0.40 + SMA50×0.30 + SMA20×0.20 + A/D×0.10" tip="Share of each universe's stocks aligned bullishly across SMA20/50/200 + A/D." />
      <div className="grid grid-cols-2 gap-2">
        <Gauge label="Nifty 50" score={n50.participationScore} color={N50_COLOR} />
        <Gauge label="Nifty 500" score={n500.participationScore} color={N500_COLOR} />
      </div>
    </ChartCard>
  );
}

// ─── MA Penetration grouped bar chart ──────────────────────────────────────────

function MAPenetrationChart({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  const data = [
    { name: 'Above SMA 20', n50: n50.aboveEma20Pct, n500: n500.aboveEma20Pct },
    { name: 'Above SMA 50', n50: n50.aboveEma50Pct, n500: n500.aboveEma50Pct },
    { name: 'Above SMA 200', n50: n50.aboveEma200Pct, n500: n500.aboveEma200Pct },
  ];

  return (
    <ChartCard>
      <ChartHeader
        eyebrow="Breadth"
        title="Moving Average Penetration"
        sub="% of universe trading above each SMA — reference lines mark regime thresholds"
        tip="% of each universe trading above its SMA20/50/200 — reference lines mark regime thresholds."
        legend={<>
          <LegendDot color={N50_COLOR} label="Nifty 50" />
          <LegendDot color={N500_COLOR} label="Nifty 500" />
        </>}
      />
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="28%" barGap={4}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" tick={tickStyle} tickLine={false} axisLine={{ stroke: '#27272a' }} />
          <YAxis domain={[0, 100]} tick={tickStyle} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}%`} />
          <Tooltip content={<BarTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
          <ReferenceLine y={40} stroke="#fb923c" strokeDasharray="4 4" strokeOpacity={0.6} />
          <ReferenceLine y={50} stroke="#facc15" strokeDasharray="4 4" strokeOpacity={0.6} />
          <ReferenceLine y={60} stroke="#34d399" strokeDasharray="4 4" strokeOpacity={0.6} />
          <Bar dataKey="n50" name="Nifty 50" fill={N50_COLOR} radius={[3, 3, 0, 0]} />
          <Bar dataKey="n500" name="Nifty 500" fill={N500_COLOR} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ─── RSI distribution 100% stacked bar ─────────────────────────────────────────

function RSIDistributionChart({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function segs(stats: BreadthStats) {
    const total = stats.totalScanned || 1;
    const elevated = Math.max(0, stats.rsiAbove60 - stats.rsiOverbought);
    const neutral = Math.max(0, stats.rsiBucket40to70 - elevated);
    return {
      overbought: +((stats.rsiOverbought / total) * 100).toFixed(1),
      elevated: +((elevated / total) * 100).toFixed(1),
      neutral: +((neutral / total) * 100).toFixed(1),
      oversold: +((stats.rsiOversold / total) * 100).toFixed(1),
      counts: { overbought: stats.rsiOverbought, elevated, neutral, oversold: stats.rsiOversold },
    };
  }
  const n50s = segs(n50);
  const n500s = segs(n500);
  const data = [
    { name: 'Nifty 50', ...n50s },
    { name: 'Nifty 500', ...n500s },
  ];

  return (
    <ChartCard>
      <ChartHeader
        eyebrow="Momentum"
        title="RSI Distribution (14-Period)"
        sub="Wilder RSI over trailing 60 closes — share of universe per zone"
        tip="Where each universe's 14-period RSI sits — overbought (>70) vs oversold (<40) share."
        legend={<>
          <LegendDot color="#f87171" label=">70 OB" />
          <LegendDot color="#fb923c" label="60–70" />
          <LegendDot color="#71717a" label="40–60" />
          <LegendDot color="#34d399" label="<40 OS" />
        </>}
      />
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }} barCategoryGap="35%">
          <CartesianGrid {...gridProps} horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tick={tickStyle} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
          <YAxis type="category" dataKey="name" tick={{ ...tickStyle, fontWeight: 700 }} tickLine={false} axisLine={false} width={70} />
          <Tooltip content={<BarTooltip />} cursor={{ fill: '#27272a', opacity: 0.4 }} />
          <Bar dataKey="overbought" name=">70 Overbought" stackId="rsi" fill="#f87171" />
          <Bar dataKey="elevated" name="60–70 Elevated" stackId="rsi" fill="#fb923c" />
          <Bar dataKey="neutral" name="40–60 Neutral" stackId="rsi" fill="#71717a" />
          <Bar dataKey="oversold" name="<40 Oversold" stackId="rsi" fill="#34d399" radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ─── 52W extremes diverging bar ────────────────────────────────────────────────

function Extremes52WChart({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  function row(label: string, stats: BreadthStats) {
    const total = stats.totalScanned || 1;
    return {
      name: label,
      highs: +((stats.new52WHighCount / total) * 100).toFixed(1),
      lows: -+((stats.new52WLowCount / total) * 100).toFixed(1),
      highCount: stats.new52WHighCount,
      lowCount: stats.new52WLowCount,
    };
  }
  const data = [row('Nifty 50', n50), row('Nifty 500', n500)];

  return (
    <ChartCard>
      <ChartHeader
        eyebrow="Extremes"
        title="52-Week Highs vs Lows"
        sub="Within 0.5% of 52-week extreme — % of universe, highs up / lows down"
        tip="Share of stocks within 0.5% of a new 52-week high (up) or low (down)."
        legend={<>
          <LegendDot color={UP_COLOR} label="New Highs" />
          <LegendDot color={DOWN_COLOR} label="New Lows" />
        </>}
      />
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="35%">
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" tick={{ ...tickStyle, fontWeight: 700 }} tickLine={false} axisLine={{ stroke: '#27272a' }} />
          <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${Math.abs(Number(v))}%`} />
          <Tooltip
            cursor={{ fill: '#27272a', opacity: 0.5 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload as { highCount: number; lowCount: number };
              return (
                <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[160px] font-mono">
                  <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{label}</p>
                  <div className="flex justify-between gap-8 mb-1">
                    <span className="text-emerald-400 font-semibold font-sans">New Highs</span>
                    <span className="text-white font-bold tabular-nums">{d.highCount}</span>
                  </div>
                  <div className="flex justify-between gap-8">
                    <span className="text-red-400 font-semibold font-sans">New Lows</span>
                    <span className="text-white font-bold tabular-nums">{d.lowCount}</span>
                  </div>
                </div>
              );
            }}
          />
          <ReferenceLine y={0} stroke="#3f3f46" strokeWidth={1.5} />
          <Bar dataKey="highs" name="New Highs" fill={UP_COLOR} radius={[3, 3, 0, 0]} />
          <Bar dataKey="lows" name="New Lows" fill={DOWN_COLOR} radius={[0, 0, 3, 3]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

// ─── Advance / Decline / Unchanged snapshot (today) ────────────────────────────

function AdvanceDeclineSnapshot({ data }: { data: BreadthResponse }) {
  const universes: Array<{ label: string; color: string; stats: BreadthStats }> = [
    { label: 'Nifty 50', color: N50_COLOR, stats: data.nifty50Breadth },
    { label: 'Sensex', color: '#c084fc', stats: data.sensexBreadth },
    { label: 'Bank Nifty', color: '#38bdf8', stats: data.bankniftyBreadth },
    { label: 'Nifty 500', color: N500_COLOR, stats: data.nifty500Breadth },
  ];

  return (
    <ChartCard>
      <ChartHeader
        eyebrow="Today"
        title="Advance / Decline / Unchanged"
        sub="Stocks closing above vs below the previous session's close, by universe"
        tip="Today's close vs prior close, by universe — advancing/unchanged/declining stock counts."
        legend={<>
          <LegendDot color={UP_COLOR} label="Advancing" />
          <LegendDot color="#71717a" label="Unchanged" />
          <LegendDot color={DOWN_COLOR} label="Declining" />
        </>}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {universes.map((u) => {
          const { advancingToday: adv, decliningToday: dec, unchangedToday: unch, totalScanned } = u.stats;
          const total = Math.max(1, adv + dec + unch);
          const advPct = (adv / total) * 100;
          const decPct = (dec / total) * 100;
          const unchPct = (unch / total) * 100;
          return (
            <div key={u.label} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: u.color }}>{u.label}</span>
                <span className="text-[9px] text-zinc-500 font-mono">{totalScanned} scanned</span>
              </div>
              <div className="flex h-3 w-full rounded-full overflow-hidden bg-zinc-800">
                <div style={{ width: `${advPct}%`, backgroundColor: UP_COLOR }} title={`Advancing: ${adv}`} />
                <div style={{ width: `${unchPct}%`, backgroundColor: '#52525b' }} title={`Unchanged: ${unch}`} />
                <div style={{ width: `${decPct}%`, backgroundColor: DOWN_COLOR }} title={`Declining: ${dec}`} />
              </div>
              <div className="flex justify-between text-[11px] font-mono font-bold tabular-nums">
                <span className="text-emerald-400">{adv} ▲</span>
                <span className="text-zinc-500">{unch} ●</span>
                <span className="text-red-400">{dec} ▼</span>
              </div>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}

// ─── Bull/Bear power + A/D comparison ──────────────────────────────────────────

function PowerAndADChart({ n50, n500 }: { n50: BreadthStats; n500: BreadthStats }) {
  const data = [
    { name: 'Bull Power', n50: n50.bullPowerPct, n500: n500.bullPowerPct },
    { name: 'Bear Power', n50: n50.bearPowerPct, n500: n500.bearPowerPct },
  ];
  const adData = [
    { name: 'Nifty 50', ratio: n50.advDecRatio, fill: n50.advDecRatio >= 1 ? UP_COLOR : DOWN_COLOR },
    { name: 'Nifty 500', ratio: n500.advDecRatio, fill: n500.advDecRatio >= 1 ? UP_COLOR : DOWN_COLOR },
  ];

  return (
    <ChartCard>
      <ChartHeader
        eyebrow="Structure"
        title="Bull / Bear Power &amp; A-D Ratio"
        sub="Fully MA-aligned stocks (bull/bear power) and 1-week advance/decline ratio"
        tip="% of stocks fully aligned bullish/bearish across MAs, plus the 1-week A/D ratio."
        legend={<>
          <LegendDot color={N50_COLOR} label="Nifty 50" />
          <LegendDot color={N500_COLOR} label="Nifty 500" />
        </>}
      />
      <div className="grid grid-cols-3 gap-4 items-end">
        <div className="col-span-2">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="35%" barGap={4}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="name" tick={tickStyle} tickLine={false} axisLine={{ stroke: '#27272a' }} />
              <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={<BarTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
              <Bar dataKey="n50" name="Nifty 50" fill={N50_COLOR} radius={[3, 3, 0, 0]} />
              <Bar dataKey="n500" name="Nifty 500" fill={N500_COLOR} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={adData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="35%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="name" tick={{ ...tickStyle, fontSize: 9 }} tickLine={false} axisLine={{ stroke: '#27272a' }} />
              <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={30} tickFormatter={(v) => `${v}x`} />
              <Tooltip content={<BarTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
              <ReferenceLine y={1} stroke="#71717a" strokeDasharray="4 4" />
              <Bar dataKey="ratio" name="A/D Ratio" radius={[3, 3, 0, 0]}>
                {adData.map((d) => <Cell key={d.name} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="text-[9px] text-zinc-500 text-center -mt-1">A/D Ratio (1W)</p>
        </div>
      </div>
    </ChartCard>
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
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Sticky header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-30 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div>
            <HelpTooltip>
              <HelpTooltipTrigger render={
                <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none cursor-help">
                  Market Breadth
                </h1>
              } />
              <HelpTooltipContent>Advance/decline health and trend strength across Nifty 50, Sensex, Bank Nifty &amp; Nifty 500.</HelpTooltipContent>
            </HelpTooltip>
            <p className="text-[10px] text-zinc-400 font-medium mt-0.5">Nifty 50 · Nifty 500 Universe</p>
          </div>
        </div>

        <NavBar />

        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="font-mono text-[10px] bg-zinc-900 text-zinc-400 px-2 py-1 rounded-lg border border-zinc-800">
              DATA: {data.dataDate}
            </span>
          )}
          {lastUpdated && (
            <span className="text-[10px] text-zinc-500">
              {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={fetchData}
            className="w-8 h-8 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg hover:border-zinc-600 text-zinc-400 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-emerald-400' : ''} />
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 px-5 py-6">
        {loading && !data ? (
          <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Computing breadth — scanning Nifty 500 universe…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-red-400">
            <AlertCircle className="h-8 w-8" />
            <span className="text-sm text-center max-w-md">{error}</span>
          </div>
        ) : data ? (
          <div className="space-y-4">
            <MarketPulseRibbon data={data} />

            <AdvanceDeclineSnapshot data={data} />

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <IndexTrendCard stats={data.nifty50} />
              <ParticipationGauges n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
              <PowerAndADChart n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
            </div>

            <MAPenetrationChart n50={data.nifty50Breadth} n500={data.nifty500Breadth} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <RSIDistributionChart n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
              <Extremes52WChart n50={data.nifty50Breadth} n500={data.nifty500Breadth} />
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
