'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Layers, Activity, TrendingUp, TrendingDown, BarChart2 } from 'lucide-react';
import type { BreadthResponse, IndexStats, BreadthStats } from '@/app/api/breadth/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(n: number, sign = true): string {
  return (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function pctColor(n: number): string {
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-zinc-400';
}

// ─── Regime config ────────────────────────────────────────────────────────────

const REGIME_ROWS = [
  {
    label: 'Bull Market',
    color: 'green' as const,
    condition: '≥60% stocks above EMA 200',
    action: 'Favour long/momentum strategies.',
    bg: 'bg-emerald-500/15',
    text: 'text-emerald-300',
    border: 'border-emerald-500/30',
  },
  {
    label: 'Cautious Bull',
    color: 'lime' as const,
    condition: '50–60% stocks above EMA 200',
    action: 'Selective long entries; avoid low-quality stocks.',
    bg: 'bg-lime-500/10',
    text: 'text-lime-300',
    border: 'border-lime-500/30',
  },
  {
    label: 'Caution / Chop',
    color: 'yellow' as const,
    condition: '45–55% stocks above EMA 200',
    action: 'Ideal for non-directional options (Straddles/Strangles).',
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-300',
    border: 'border-yellow-500/30',
  },
  {
    label: 'Transition',
    color: 'orange' as const,
    condition: '40–50% above EMA 200, Nifty',
    action: 'Reduce leverage; wait for breakout confirmation.',
    bg: 'bg-orange-500/10',
    text: 'text-orange-300',
    border: 'border-orange-500/30',
  },
  {
    label: 'Bear Market',
    color: 'red' as const,
    condition: '≤35% stocks above EMA 200',
    action: 'Avoid longs; hedge portfolio; favour cash.',
    bg: 'bg-red-500/10',
    text: 'text-red-300',
    border: 'border-red-500/30',
  },
];

function getRegimeStyle(color: BreadthResponse['regimeColor']) {
  return REGIME_ROWS.find((r) => r.color === color) ?? REGIME_ROWS[2];
}

// ─── Breadth interpretation helpers ──────────────────────────────────────────

function emaBreadthInterpretation(pct: number, label: string): string {
  if (label === 'EMA 20') {
    if (pct > 60) return 'Short-term momentum breadth: reading >60% is broadly bullish.';
    if (pct > 40) return 'Mixed short-term breadth; watch for expansion.';
    return 'Short-term breadth weak; momentum deteriorating.';
  }
  if (label === 'EMA 50') {
    if (pct > 55) return 'Medium-term trend breadth: healthy market >55%.';
    if (pct > 40) return 'Medium-term breadth neutral; caution advised.';
    return 'Medium-term trend breadth deteriorating.';
  }
  // EMA 200
  if (pct >= 60) return 'Long-term structural breadth: core indicator of market health — Bull Market.';
  if (pct >= 50) return 'Long-term breadth cautiously positive.';
  if (pct >= 40) return 'Long-term breadth at transition zone.';
  return 'Long-term structural breadth weak — Bear Market.';
}

function ema200Color(pct: number): string {
  if (pct >= 60) return 'text-emerald-400';
  if (pct >= 50) return 'text-lime-400';
  if (pct >= 45) return 'text-yellow-400';
  if (pct >= 40) return 'text-orange-400';
  return 'text-red-400';
}

function extremeRatioLabel(ratio: number): { label: string; color: string } {
  if (ratio >= 3) return { label: 'Very Bullish (>3x more Highs than Lows)', color: 'text-emerald-400' };
  if (ratio >= 2) return { label: 'Bullish', color: 'text-lime-400' };
  if (ratio >= 1) return { label: 'Slightly Bullish', color: 'text-yellow-400' };
  if (ratio >= 0.5) return { label: 'Slightly Bearish', color: 'text-orange-400' };
  return { label: 'Bearish', color: 'text-red-400' };
}

function high52WLabel(count: number): { label: string; color: string } {
  if (count >= 30) return { label: 'Bullish Dominance — High count: broad buying interest; ideal for momentum entries.', color: 'text-emerald-400' };
  if (count >= 15) return { label: 'Moderate Highs — selective breakout opportunity.', color: 'text-lime-400' };
  return { label: 'Low Stress — few new highs; market consolidating.', color: 'text-yellow-400' };
}

function low52WLabel(count: number): { label: string; color: string } {
  if (count >= 30) return { label: 'High count: distribution pressure; consider defensive posture.', color: 'text-red-400' };
  if (count >= 10) return { label: 'Moderate Lows — selective weakness.', color: 'text-orange-400' };
  return { label: 'Low Stress — few new lows; broadly healthy.', color: 'text-emerald-400' };
}

function advDecLabel(ratio: number): { label: string; color: string } {
  if (ratio >= 3) return { label: 'Strongly Bullish', color: 'text-emerald-400' };
  if (ratio >= 2) return { label: 'Bullish', color: 'text-lime-400' };
  if (ratio >= 1) return { label: 'Neutral-Bullish', color: 'text-yellow-400' };
  if (ratio >= 0.5) return { label: 'Neutral-Bearish', color: 'text-orange-400' };
  return { label: 'Bearish', color: 'text-red-400' };
}

function chopLabel(chop: number | null): { label: string; color: string } {
  if (chop === null) return { label: 'N/A', color: 'text-zinc-500' };
  if (chop < 38.2) return { label: 'Trending', color: 'text-emerald-400' };
  if (chop < 61.8) return { label: 'Transitioning', color: 'text-yellow-400' };
  return { label: 'Choppy', color: 'text-orange-400' };
}

function adxLabel(adx: number | null): { label: string; color: string } {
  if (adx === null) return { label: 'N/A', color: 'text-zinc-500' };
  if (adx >= 40) return { label: 'Strong Trend', color: 'text-emerald-400' };
  if (adx >= 25) return { label: 'Trending', color: 'text-lime-400' };
  if (adx >= 20) return { label: 'Weak Trend', color: 'text-yellow-400' };
  return { label: 'No Trend / Choppy', color: 'text-orange-400' };
}

function trendStateColor(state: string): string {
  if (state === 'Strong Uptrend') return 'text-emerald-400';
  if (state === 'Uptrend') return 'text-lime-400';
  if (state === 'Above EMA 200') return 'text-yellow-400';
  if (state === 'Below EMA 200') return 'text-orange-400';
  if (state === 'Downtrend') return 'text-red-400';
  return 'text-zinc-500';
}

// ─── Shared table components ──────────────────────────────────────────────────

function SectionCard({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/80">
        {icon && <span className="text-emerald-400">{icon}</span>}
        <h2 className="text-xs font-bold text-white uppercase tracking-widest">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function StatRow({ label, value, valueClass = 'text-white' }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-zinc-800/60 last:border-0">
      <span className="text-xs text-zinc-400">{label}</span>
      <span className={cn('text-xs font-semibold tabular-nums', valueClass)}>{value}</span>
    </div>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function Nifty50Panel({ stats }: { stats: IndexStats }) {
  const chop = chopLabel(stats.chopIndex);
  const adxInfo = adxLabel(stats.adx14);
  return (
    <SectionCard title="Nifty 50 Index Status" icon={<Activity className="h-3.5 w-3.5" />}>
      <StatRow label="Nifty 50 Close" value={fmt(stats.close)} />
      <StatRow label="EMA 20" value={fmt(stats.ema20)} />
      <StatRow label="EMA 50" value={fmt(stats.ema50)} />
      <StatRow label="EMA 200" value={fmt(stats.ema200)} />
      <StatRow
        label="% vs EMA 200"
        value={fmtPct(stats.pctVsEma200)}
        valueClass={pctColor(stats.pctVsEma200)}
      />
      <StatRow
        label="% vs EMA 50"
        value={fmtPct(stats.pctVsEma50)}
        valueClass={pctColor(stats.pctVsEma50)}
      />
      <StatRow
        label="% vs EMA 20"
        value={fmtPct(stats.pctVsEma20)}
        valueClass={pctColor(stats.pctVsEma20)}
      />
      <StatRow
        label="Nifty ADX (14)"
        value={stats.adx14 !== null ? (
          <span className="flex items-center gap-2">
            <span>{stats.adx14.toFixed(2)}</span>
            <span className={cn('text-[10px]', adxInfo.color)}>{adxInfo.label}</span>
          </span>
        ) : 'N/A'}
        valueClass={adxInfo.color}
      />
      <StatRow
        label="Nifty Chop Index"
        value={stats.chopIndex !== null ? (
          <span className="flex items-center gap-2">
            <span>{stats.chopIndex.toFixed(2)}</span>
            <span className={cn('text-[10px]', chop.color)}>{chop.label}</span>
          </span>
        ) : 'N/A'}
        valueClass={chop.color}
      />
      <StatRow label="Index Trend State" value={stats.trendState} valueClass={trendStateColor(stats.trendState)} />
    </SectionCard>
  );
}

function BreadthOverviewPanel({ stats }: { stats: BreadthStats }) {
  return (
    <SectionCard title="Breadth Overview (Nifty 500 Universe)" icon={<BarChart2 className="h-3.5 w-3.5" />}>
      <StatRow label="Total Stocks Scanned" value={stats.totalScanned} />
      <StatRow
        label="Above EMA 20 (count)"
        value={<span>{stats.aboveEma20Count} <span className={ema200Color(stats.aboveEma20Pct)}>({stats.aboveEma20Pct}%)</span></span>}
      />
      <StatRow
        label="Above EMA 50 (count)"
        value={<span>{stats.aboveEma50Count} <span className={ema200Color(stats.aboveEma50Pct)}>({stats.aboveEma50Pct}%)</span></span>}
      />
      <StatRow
        label="Above EMA 200 (count)"
        value={<span>{stats.aboveEma200Count} <span className={ema200Color(stats.aboveEma200Pct)}>({stats.aboveEma200Pct}%)</span></span>}
      />
      <StatRow label="New 52W Highs" value={stats.new52WHighCount} valueClass="text-emerald-400" />
      <StatRow label="New 52W Lows" value={stats.new52WLowCount} valueClass="text-red-400" />
      <StatRow label="Advancing (1W)" value={stats.advancing1W} valueClass="text-emerald-400" />
      <StatRow label="Declining (1W)" value={stats.declining1W} valueClass="text-red-400" />
      <StatRow label="Adv/Dec Ratio" value={stats.advDecRatio.toFixed(2)} valueClass={advDecLabel(stats.advDecRatio).color} />
    </SectionCard>
  );
}

function EmaPenetrationTable({ stats }: { stats: BreadthStats }) {
  const rows = [
    { indicator: 'Stocks above EMA 20', count: stats.aboveEma20Count, pct: stats.aboveEma20Pct, label: 'EMA 20' },
    { indicator: 'Stocks above EMA 50', count: stats.aboveEma50Count, pct: stats.aboveEma50Pct, label: 'EMA 50' },
    { indicator: 'Stocks above EMA 200', count: stats.aboveEma200Count, pct: stats.aboveEma200Pct, label: 'EMA 200' },
  ];
  return (
    <SectionCard title="EMA Penetration Breadth" icon={<TrendingUp className="h-3.5 w-3.5" />}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 font-bold text-white">Indicator</th>
            <th className="text-right px-3 py-2 font-bold text-white">Count</th>
            <th className="text-right px-3 py-2 font-bold text-white">% of Universe</th>
            <th className="text-left px-3 py-2 font-bold text-white">Interpretation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-zinc-800/60">
              <td className="px-3 py-2 text-zinc-300">{row.indicator}</td>
              <td className="px-3 py-2 text-right tabular-nums text-white font-semibold">{row.count}</td>
              <td className={cn('px-3 py-2 text-right tabular-nums font-semibold', ema200Color(row.pct))}>
                {row.pct}%
              </td>
              <td className="px-3 py-2 text-zinc-400 text-[10px]">{emaBreadthInterpretation(row.pct, row.label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}

function ExtremeAnalysisTable({ stats }: { stats: BreadthStats }) {
  const ratio = stats.new52WLowCount > 0 ? stats.new52WHighCount / stats.new52WLowCount : stats.new52WHighCount;
  const highInfo = high52WLabel(stats.new52WHighCount);
  const lowInfo = low52WLabel(stats.new52WLowCount);
  const ratioInfo = extremeRatioLabel(ratio);
  return (
    <SectionCard title="52-Week Extreme Analysis" icon={<Activity className="h-3.5 w-3.5" />}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 font-bold text-white">Indicator</th>
            <th className="text-right px-3 py-2 font-bold text-white">Count</th>
            <th className="text-left px-3 py-2 font-bold text-white w-28">Signal</th>
            <th className="text-left px-3 py-2 font-bold text-white">Interpretation</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">New 52-Week Highs (within 0.5%)</td>
            <td className="px-3 py-2 text-right tabular-nums text-white font-semibold">{stats.new52WHighCount}</td>
            <td className={cn('px-3 py-2 font-semibold', highInfo.color)}>{highInfo.label.split('—')[0].trim()}</td>
            <td className="px-3 py-2 text-zinc-400 text-[10px]">{highInfo.label.split('—')[1]?.trim()}</td>
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">New 52-Week Lows (within 0.5%)</td>
            <td className="px-3 py-2 text-right tabular-nums text-white font-semibold">{stats.new52WLowCount}</td>
            <td className={cn('px-3 py-2 font-semibold', lowInfo.color)}>{lowInfo.label.split('—')[0].trim()}</td>
            <td className="px-3 py-2 text-zinc-400 text-[10px]">{lowInfo.label.split('—')[1]?.trim()}</td>
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">52W High/Low Ratio</td>
            <td className="px-3 py-2 text-right tabular-nums text-white font-semibold">{ratio.toFixed(2)}</td>
            <td colSpan={2} className={cn('px-3 py-2 font-semibold text-[10px]', ratioInfo.color)}>{ratioInfo.label}</td>
          </tr>
        </tbody>
      </table>
    </SectionCard>
  );
}

function AdvanceDeclineTable({ stats }: { stats: BreadthStats }) {
  const total = stats.advancing1W + stats.declining1W + stats.unchanged1W;
  const advPct = total > 0 ? ((stats.advancing1W / total) * 100).toFixed(1) : '0.0';
  const decPct = total > 0 ? ((stats.declining1W / total) * 100).toFixed(1) : '0.0';
  const uncPct = total > 0 ? ((stats.unchanged1W / total) * 100).toFixed(1) : '0.0';
  const ratioInfo = advDecLabel(stats.advDecRatio);
  return (
    <SectionCard title="Advance / Decline Breakdown (1-Week Basis)" icon={<TrendingDown className="h-3.5 w-3.5" />}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 font-bold text-white">Category</th>
            <th className="text-right px-3 py-2 font-bold text-white">Count</th>
            <th className="text-right px-3 py-2 font-bold text-white">% of Universe</th>
            <th className="text-left px-3 py-2 font-bold text-white">Signal</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">Advancing Stocks (1W &gt; 0%)</td>
            <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold">{stats.advancing1W}</td>
            <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold">{advPct}%</td>
            <td className="px-3 py-2" />
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">Declining Stocks (1W &lt; 0%)</td>
            <td className="px-3 py-2 text-right tabular-nums text-red-400 font-semibold">{stats.declining1W}</td>
            <td className="px-3 py-2 text-right tabular-nums text-red-400 font-semibold">{decPct}%</td>
            <td className="px-3 py-2" />
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">Unchanged / Flat</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-400 font-semibold">{stats.unchanged1W}</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-400 font-semibold">{uncPct}%</td>
            <td className="px-3 py-2" />
          </tr>
          <tr className="border-t border-zinc-800">
            <td className="px-3 py-2 text-zinc-300 font-semibold">Advance/Decline Ratio</td>
            <td className="px-3 py-2 text-right tabular-nums font-bold text-white">{stats.advDecRatio.toFixed(2)}</td>
            <td className="px-3 py-2" />
            <td className={cn('px-3 py-2 font-bold text-[10px]', ratioInfo.color)}>{ratioInfo.label}</td>
          </tr>
        </tbody>
      </table>
    </SectionCard>
  );
}

function RSIDistributionPanel({ stats }: { stats: BreadthStats }) {
  const total = stats.rsiOverbought + stats.rsiNeutral + stats.rsiOversold;
  const obPct = total > 0 ? ((stats.rsiOverbought / total) * 100).toFixed(1) : '0.0';
  const nPct = total > 0 ? ((stats.rsiNeutral / total) * 100).toFixed(1) : '0.0';
  const osPct = total > 0 ? ((stats.rsiOversold / total) * 100).toFixed(1) : '0.0';
  return (
    <SectionCard title="RSI Distribution (14-Period)" icon={<Activity className="h-3.5 w-3.5" />}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 font-bold text-white">Zone</th>
            <th className="text-right px-3 py-2 font-bold text-white">Count</th>
            <th className="text-right px-3 py-2 font-bold text-white">% of Universe</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-red-300">Overbought (RSI &gt; 70)</td>
            <td className="px-3 py-2 text-right tabular-nums text-red-400 font-semibold">{stats.rsiOverbought}</td>
            <td className="px-3 py-2 text-right tabular-nums text-red-400 font-semibold">{obPct}%</td>
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-zinc-300">Neutral (RSI 40–70)</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-300 font-semibold">{stats.rsiNeutral}</td>
            <td className="px-3 py-2 text-right tabular-nums text-zinc-300 font-semibold">{nPct}%</td>
          </tr>
          <tr className="border-t border-zinc-800/60">
            <td className="px-3 py-2 text-emerald-300">Oversold (RSI &lt; 40)</td>
            <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold">{stats.rsiOversold}</td>
            <td className="px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold">{osPct}%</td>
          </tr>
        </tbody>
      </table>
    </SectionCard>
  );
}

function RegimeGuide({ activeColor }: { activeColor: BreadthResponse['regimeColor'] }) {
  return (
    <SectionCard title="Regime Interpretation Guide" icon={<BarChart2 className="h-3.5 w-3.5" />}>
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-zinc-800">
            <th className="text-left px-3 py-2 font-bold text-white">Regime</th>
            <th className="text-left px-3 py-2 font-bold text-white">Condition</th>
            <th className="text-left px-3 py-2 font-bold text-white">Action</th>
          </tr>
        </thead>
        <tbody>
          {REGIME_ROWS.map((row) => {
            const isActive = row.color === activeColor;
            return (
              <tr
                key={row.label}
                className={cn('border-t border-zinc-800/60 transition-all', isActive ? row.bg + ' border-l-2 ' + row.border : '')}
              >
                <td className={cn('px-3 py-2 font-bold', isActive ? row.text : 'text-zinc-500')}>
                  {isActive && <span className="mr-1.5">▶</span>}
                  {row.label}
                </td>
                <td className={cn('px-3 py-2', isActive ? 'text-white' : 'text-zinc-500')}>{row.condition}</td>
                <td className={cn('px-3 py-2', isActive ? 'text-zinc-300' : 'text-zinc-600')}>{row.action}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

  const regime = data ? getRegimeStyle(data.regimeColor) : null;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-black text-zinc-150">
      {/* ── Header ── */}
      <header className="flex-none w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-2.5 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <Layers className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Market Breadth Analysis
            </h1>
            <p className="text-[10px] text-zinc-600 font-medium mt-0.5">Nifty 50 Index · Nifty 500 Universe</p>
          </div>
        </div>

        {/* Nav */}
        <NavBar />

        {/* Right controls */}
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          {/* Regime badge */}
          {regime && data && (
            <div className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold', regime.bg, regime.text, regime.border)}>
              <span className="h-2 w-2 rounded-full bg-current opacity-80" />
              {data.regimeLabel}
            </div>
          )}

          {/* Last updated + refresh */}
          <div className="flex items-center gap-1.5">
            {lastUpdated && (
              <span className="text-[10px] text-zinc-600 font-mono">
                {lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </span>
            )}
            <button
              onClick={fetchData}
              className="h-8 w-8 flex items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-white hover:border-zinc-700 transition-all"
              title="Refresh"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin text-emerald-400')} />
            </button>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="flex-1 overflow-y-auto px-5 py-4">
        {loading && !data && (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <RefreshCw className="h-8 w-8 animate-spin text-emerald-400 mx-auto mb-3" />
              <p className="text-zinc-500 text-sm">Computing breadth for Nifty 500 universe…</p>
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 mb-4">{error}</div>
        )}
        {data && (
          <div className="space-y-4">
            {/* Data date */}
            <div className="flex items-center gap-2 text-[10px] text-zinc-600">
              <span>Data as of:</span>
              <span className="font-mono text-zinc-400">{data.dataDate}</span>
            </div>

            {/* Top row: Index Status + Breadth Overview */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Nifty50Panel stats={data.nifty50} />
              <BreadthOverviewPanel stats={data.nifty500Breadth} />
            </div>

            {/* EMA Penetration Breadth */}
            <EmaPenetrationTable stats={data.nifty500Breadth} />

            {/* 52W Extreme + Advance/Decline side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ExtremeAnalysisTable stats={data.nifty500Breadth} />
              <RSIDistributionPanel stats={data.nifty500Breadth} />
            </div>

            {/* Advance/Decline full-width */}
            <AdvanceDeclineTable stats={data.nifty500Breadth} />

            {/* Regime Guide */}
            <RegimeGuide activeColor={data.regimeColor} />
          </div>
        )}
      </main>
    </div>
  );
}
