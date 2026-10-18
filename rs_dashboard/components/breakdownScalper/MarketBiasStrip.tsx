'use client';

import { Play, Pause, AlertOctagon, Settings, ShieldAlert, TrendingUp, TrendingDown, Minus, BookOpen, Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { indexTrendParamsOf, type UnderlyingTrend } from '@/lib/breakdownScalper';
import type { BreakdownConfig, LedgerMode } from '@/lib/breakdownLedger';

interface MarketBiasStripProps {
  underlying: string;
  trend: UnderlyingTrend;
  config: BreakdownConfig;
  mode: LedgerMode;
  openCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  onToggleEngine: () => void;
  onSquareOffAll: () => void;
  onOpenSettings: () => void;
  onOpenDocs?: () => void;
  vixLtp?: number | null;
  vixChangePct?: number | null;
  vixPrevClose?: number | null;
  wsTransport?: 'ws' | 'poll';
  wsStatus?: string;
  wsStale?: boolean;
}

export function MarketBiasStrip({
  underlying,
  trend,
  config,
  mode,
  openCount,
  realizedPnl,
  unrealizedPnl,
  onToggleEngine,
  onSquareOffAll,
  onOpenSettings,
  onOpenDocs,
  vixLtp,
  vixChangePct,
  vixPrevClose,
  wsTransport,
  wsStatus,
  wsStale,
}: MarketBiasStripProps) {
  const tp = indexTrendParamsOf(config);
  const totalPnl = realizedPnl + unrealizedPnl;
  const isLossBreached = totalPnl <= -config.dailyLossLimit;
  const remainingBudget = Math.max(0, config.dailyLossLimit + totalPnl);
  const budgetPct = Math.min(100, Math.max(0, (remainingBudget / config.dailyLossLimit) * 100));

  const pnlColor = (v: number) =>
    v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400';

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 backdrop-blur">
      {/* Top row: Underlying telemetry & Market Trend */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Left: Underlying ticker & indicators */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
              {underlying} SPOT:
            </span>
            <span className="font-mono text-base font-extrabold text-white">
              {trend.spot > 0 ? trend.spot.toFixed(1) : '—'}
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            <span className="rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800">
              EMA {tp.emaFast}: <strong className="font-mono text-zinc-200">{trend.emaFast ? trend.emaFast.toFixed(1) : '—'}</strong>
            </span>
            <span className="rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800">
              EMA {tp.emaSlow}: <strong className="font-mono text-zinc-200">{trend.emaSlow ? trend.emaSlow.toFixed(1) : '—'}</strong>
            </span>
            {tp.useSupertrend && (
              <span className="rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800">
                ST ({tp.stPeriod}, {tp.stMultiplier}):{' '}
                <strong
                  className={cn(
                    'font-mono',
                    trend.stDir === 1 ? 'text-emerald-400' : trend.stDir === -1 ? 'text-red-400' : 'text-zinc-400',
                  )}
                >
                  {trend.stDir === 1 ? '▲ ' : trend.stDir === -1 ? '▼ ' : ''}
                  {trend.stLine ? trend.stLine.toFixed(1) : '—'}
                </strong>
              </span>
            )}
            <span className="rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800">
              Spread:{' '}
              <strong
                className={cn(
                  'font-mono',
                  trend.spread != null && trend.spread > 0
                    ? 'text-emerald-400'
                    : trend.spread != null && trend.spread < 0
                    ? 'text-red-400'
                    : 'text-zinc-400',
                )}
              >
                {trend.spread != null ? (trend.spread > 0 ? `+${trend.spread.toFixed(1)}` : trend.spread.toFixed(1)) : '—'}
              </strong>
            </span>

            <span className="flex items-center gap-1.5 rounded bg-zinc-900 px-2 py-0.5 border border-zinc-800">
              <span className="text-zinc-400">INDIA VIX:</span>
              <strong className="font-mono text-zinc-100">{vixLtp != null ? vixLtp.toFixed(2) : '—'}</strong>
              {vixChangePct != null && (
                <span
                  className={cn(
                    'font-mono text-[11px] font-bold',
                    vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400',
                  )}
                  title={vixPrevClose != null ? `Yesterday close: ₹${vixPrevClose.toFixed(2)}` : undefined}
                >
                  {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''}{' '}
                  {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
                </span>
              )}
            </span>

            {wsStatus && (
              <span
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-0.5 border text-[11px] font-mono font-bold',
                  wsStatus !== 'RUNNING'
                    ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
                    : wsStale
                    ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
                )}
                title={`Live Options WebSocket: ${wsStatus} · Transport: ${wsTransport?.toUpperCase() ?? 'WS'}`}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    wsStatus !== 'RUNNING'
                      ? 'bg-zinc-500'
                      : wsStale
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-emerald-400 animate-ping',
                  )}
                />
                <span>
                  {wsStatus !== 'RUNNING'
                    ? `WS ${wsStatus}`
                    : wsStale
                    ? 'WS STALE'
                    : `LIVE · ${wsTransport?.toUpperCase() ?? 'WS'}`}
                </span>
              </span>
            )}
          </div>
        </div>

        {/* Center / Right: Engine Controls & Emergency Action */}
        <div className="flex items-center gap-2">
          {/* Engine state button */}
          <button
            type="button"
            onClick={onToggleEngine}
            disabled={isLossBreached}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all shadow-sm',
              config.engineActive
                ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-600/30'
                : 'bg-zinc-800/90 text-zinc-300 border border-zinc-700 hover:bg-zinc-700',
              isLossBreached && 'cursor-not-allowed opacity-50',
            )}
          >
            {config.engineActive ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                </span>
                <Pause className="h-3.5 w-3.5" />
                <span>AUTO-TRADER ACTIVE</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 text-zinc-400" />
                <span>AUTO-TRADER PAUSED</span>
              </>
            )}
          </button>

          {/* Square Off All */}
          <button
            type="button"
            onClick={onSquareOffAll}
            disabled={openCount === 0}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Immediately close all active short positions"
          >
            <AlertOctagon className="h-3.5 w-3.5" />
            <span>EXIT ALL ({openCount})</span>
          </button>

          {/* Settings button */}
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-800"
          >
            <Settings className="h-3.5 w-3.5 text-zinc-400" />
            <span>RULES</span>
          </button>

          {/* Documentation / Playbook button */}
          {onOpenDocs && (
            <button
              type="button"
              onClick={onOpenDocs}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:border-emerald-500/30 hover:bg-zinc-800"
              title="Open Breakdown Auto-Scalper Strategy Playbook & Rules Documentation"
            >
              <BookOpen className="h-3.5 w-3.5 text-emerald-400" />
              <span>PLAYBOOK</span>
            </button>
          )}
        </div>
      </div>

      {/* Second row: Market Direction Filter Badges, Risk Monitor & India VIX */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
        {/* 1. Underlying Trend Badge */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Market Direction Filter
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              {trend.trend === 'BULLISH' && <TrendingUp className="h-4 w-4 text-emerald-400" />}
              {trend.trend === 'BEARISH' && <TrendingDown className="h-4 w-4 text-red-400" />}
              {trend.trend === 'SIDEWAYS' && <Minus className="h-4 w-4 text-amber-400" />}
              <span
                className={cn(
                  'text-sm font-extrabold tracking-tight',
                  trend.trend === 'BULLISH'
                    ? 'text-emerald-400'
                    : trend.trend === 'BEARISH'
                    ? 'text-red-400'
                    : 'text-amber-400',
                )}
              >
                {trend.trend}
              </span>
            </div>
          </div>
          <span className="text-[10px] text-zinc-500 font-medium">
            {config.trendMode === 'AUTO' ? 'Auto Bias Active' : config.trendMode}
          </span>
        </div>

        {/* 2. Selling Eligibility Pill */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Eligible Selling Side
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span
                className={cn(
                  'rounded px-2 py-0.5 text-xs font-bold uppercase tracking-wider',
                  trend.eligibleSide === 'PE'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : trend.eligibleSide === 'CE'
                    ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                    : trend.eligibleSide === 'BOTH'
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                    : 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
                )}
              >
                {trend.eligibleSide === 'PE'
                  ? 'PUTS (PE) ONLY'
                  : trend.eligibleSide === 'CE'
                  ? 'CALLS (CE) ONLY'
                  : trend.eligibleSide === 'BOTH'
                  ? 'BOTH CE & PE (BYPASS)'
                  : 'BLOCKED: SIDEWAYS'}
              </span>
            </div>
          </div>
          <span className="text-[10px] text-zinc-500 text-right max-w-[120px] truncate" title={trend.headline}>
            {trend.headline}
          </span>
        </div>

        {/* 3. India VIX & Volatility Regime Card */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              India VIX · Volatility
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <Activity
                className={cn(
                  'h-4 w-4',
                  vixChangePct != null && vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400',
                )}
              />
              <span className="font-mono text-sm font-extrabold text-white">
                {vixLtp != null ? vixLtp.toFixed(2) : '—'}
              </span>
              {vixChangePct != null && (
                <span
                  className={cn(
                    'font-mono text-xs font-bold',
                    vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400',
                  )}
                  title={vixPrevClose != null ? `Yesterday close: ₹${vixPrevClose.toFixed(2)}` : undefined}
                >
                  {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''}{' '}
                  {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                vixLtp == null
                  ? 'bg-zinc-800 text-zinc-500'
                  : vixLtp < 13
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : vixLtp <= 18
                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
              )}
            >
              {vixLtp == null
                ? 'N/A'
                : vixLtp < 13
                ? 'Low Vol'
                : vixLtp <= 18
                ? 'Normal Vol'
                : 'Elevated'}
            </span>
            {vixPrevClose != null && (
              <span className="text-[9px] font-mono text-zinc-500 mt-0.5">
                prev {vixPrevClose.toFixed(2)}
              </span>
            )}
          </div>
        </div>

        {/* 3. Portfolio Allocation & Positions Limit */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Concurrent Positions
            </p>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-sm font-extrabold text-white">
                {openCount} <span className="text-zinc-500 text-xs">/ {config.maxConcurrent} MAX</span>
              </span>
              <span className="text-[10px] text-zinc-500">
                (max {config.maxSameSide}/side)
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                mode === 'REAL'
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
              )}
            >
              {mode} MODE
            </span>
          </div>
        </div>

        {/* 4. Daily P&L & Loss Limit Gauge */}
        <div className="flex flex-col justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Daily P&L / Loss Limit
            </p>
            <span className={cn('text-xs font-bold tabular-nums', pnlColor(totalPnl))}>
              {totalPnl >= 0 ? `+₹${totalPnl.toLocaleString('en-IN')}` : `-₹${Math.abs(totalPnl).toLocaleString('en-IN')}`}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  isLossBreached
                    ? 'bg-red-500'
                    : budgetPct < 30
                    ? 'bg-amber-500'
                    : 'bg-emerald-500',
                )}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-zinc-400 font-medium whitespace-nowrap">
              Limit: ₹{config.dailyLossLimit.toLocaleString('en-IN')}
            </span>
          </div>

          {isLossBreached && (
            <p className="mt-1 text-[10px] font-bold text-red-400 flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" /> HARD DAILY LOSS LIMIT REACHED — LOCKED OUT
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
