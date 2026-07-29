'use client';

import React, { useState, useEffect } from 'react';
import { Play, Square, Settings, Activity, ShieldAlert, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import LogConsole from './LogConsole';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

interface StrategyMeta {
  key: string;
  name: string;
}

interface StrategyState {
  strategy: string;
  status: string;
  pid?: number;
  dry_run?: boolean;
  lots?: number;
  max_lots?: number;
  threshold_lot?: number;
  loser_ratio_lots?: number;
  ce_strike?: number | null;
  pe_strike?: number | null;
  ce_lots?: number;
  pe_lots?: number;
  ce_ltp?: number;
  pe_ltp?: number;
  ce_avg_price?: number;
  pe_avg_price?: number;
  realized_pnl?: number;
  total_pnl?: number;
  spot?: number;
  adjustments?: number;
  profit_target?: number;
  stop_loss?: number;
  mode?: string;
  entry_type?: string;
  symbol?: string;
  interval?: string;
  active_spread?: string | null;
  short_symbol?: string | null;
  long_symbol?: string | null;
  short_strike?: number | null;
  long_strike?: number | null;
  short_ltp?: number;
  long_ltp?: number;
  // OI Directional
  in_position?: boolean;
  position_type?: string;
  sold_strike?: number | null;
  entry_pcr?: number;
  exit_pcr_level?: number;
  avg_price?: number;
  current_ltp?: number;
  direction?: string;
  oi_diff?: number;
  pcr_threshold?: number;
  // Reentry Straddle
  ce_active?: boolean;
  pe_active?: boolean;
  ce_sl?: number;
  pe_sl?: number;
  combined_best_premium?: number | null;
  trail_combined_buffer?: number;
  leg_sl_pct?: number;
  // Combined-premium trailing SL
  trail_active?: boolean;
  trail_start_pct?: number;
  trail_gap_pts?: number;
  entry_combined_pts?: number;
  best_combined_pts?: number;
  trail_exit_combined?: number | null;
  // Spread Trend
  use_ema?: boolean;
  use_supertrend?: boolean;
  // CrudeOil Mini Supertrend
  ltp?: number;
  target_profit?: number;
  entry_price?: number;
  st_level?: number;
  daily_pnl?: number;
  expiry?: string;
  supertrend_period?: number;
  supertrend_multiplier?: number;
  use_vwap?: boolean;
  vwap?: number;
  // CrudeOil Mini Renko SAR
  box_size?: number;
  reverse_bricks?: number;
  brick_count?: number;
  last_brick_color?: string;
  last_brick_close?: number;
  consecutive_opposite?: number;
  qty?: number;
  position_pnl?: number;
  // ST+OI Bear Call Spread
  phase?: string;
  index_interval?: string;
  option_interval?: string;
  index_st_period?: number;
  index_st_multiplier?: number;
  option_st_period?: number;
  option_st_multiplier?: number;
  candidate_strike?: number | null;
  candidate_symbol?: string | null;
  watching_since?: string | null;
  index_st_dir?: number | null;
  option_st_dir?: number | null;
  ce_price_change_pct?: number | null;
  ce_oi_change_pct?: number | null;
  require_short_buildup?: boolean;
  min_price_drop_pct?: number;
  min_oi_rise_pct?: number;
}

interface StrategyCardProps {
  meta: StrategyMeta;
  state: StrategyState;
  onRefresh: () => void;
}

function StrategyCard({ meta, state, onRefresh }: StrategyCardProps) {
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [showLogs, setShowLogs] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [confirmStop, setConfirmStop] = useState<boolean>(false);
  const [confirmTimeoutId, setConfirmTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [gracefulStopSent, setGracefulStopSent] = useState<boolean>(false);
  const [forceKilling, setForceKilling] = useState<boolean>(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [isLive, setIsLive] = useState<boolean>(false);
  const [lots, setLots] = useState<number>(1);
  const [profitTarget, setProfitTarget] = useState<string>('4000');
  const [stopLoss, setStopLoss] = useState<string>('4000');
  const [startTime, setStartTime] = useState<string>('09:20');

  const [maxLots, setMaxLots] = useState<number>(4);
  const [mode, setMode] = useState<string>('winner_roll_atm');
  const [loserRatioLots, setLoserRatioLots] = useState<number>(1);
  const [thresholdLot, setThresholdLot] = useState<number>(25.0);
  const [entryType, setEntryType] = useState<string>('strangle');
  const [strikeSelection, setStrikeSelection] = useState<string>('distance');
  const [ceOffset, setCeOffset] = useState<number>(200);
  const [peOffset, setPeOffset] = useState<number>(200);
  const [targetDelta, setTargetDelta] = useState<number>(0.20);
  const [targetPremium, setTargetPremium] = useState<number>(50.0);

  // Delta Neutral
  const [dnTargetDelta, setDnTargetDelta] = useState<number>(0.5);
  const [dnThresholdLot, setDnThresholdLot] = useState<number>(50.0);

  // Straddle
  const [entryBalanceThreshold, setEntryBalanceThreshold] = useState<number>(15.0);

  // VWAP strategies (shared params)
  const [entryBand, setEntryBand] = useState<number>(5.0);
  const [declineTicks, setDeclineTicks] = useState<number>(5);
  const [exitBuffer, setExitBuffer] = useState<number>(10.0);
  const [maxPremiumDiff, setMaxPremiumDiff] = useState<number>(15.0);
  const [vwapWarmupBars, setVwapWarmupBars] = useState<number>(10); // candle-based

  // OI Directional
  const [pcrThreshold, setPcrThreshold] = useState<number>(1.5);
  const [exitPcrChange, setExitPcrChange] = useState<number>(30);
  const [pollInterval, setPollInterval] = useState<number>(60);
  const [expansionWindow, setExpansionWindow] = useState<number>(3);

  // Reentry Straddle
  const [trailCombinedBuffer, setTrailCombinedBuffer] = useState<number>(1.0);
  const [legSlPct, setLegSlPct] = useState<number>(0.20);

  // Combined-premium trailing SL (straddle / strangle / advanced)
  const [trailStartPct, setTrailStartPct] = useState<number>(5.0);
  const [trailGapPts, setTrailGapPts] = useState<number>(15.0);

  // Spread Trend
  const [symbol, setSymbol] = useState<string>('NIFTY');
  const [interval, setIntervalVal] = useState<string>('5');
  const [spreadWidth, setSpreadWidth] = useState<number>(100);
  const [emaPeriod, setEmaPeriod] = useState<number>(20);
  const [supertrendPeriod, setSupertrendPeriod] = useState<number>(7);
  const [supertrendMultiplier, setSupertrendMultiplier] = useState<number>(3.0);
  const [exitOnSignalChange, setExitOnSignalChange] = useState<boolean>(true);
  const [eodTime, setEodTime] = useState<string>('15:15');
  const [cooldownMinutes, setCooldownMinutes] = useState<number>(5);
  const [useEma, setUseEma] = useState<boolean>(true);
  const [useSupertrend, setUseSupertrend] = useState<boolean>(true);

  // CrudeOil Mini Supertrend
  const [crudeoilInterval, setCrudeoilInterval] = useState<string>('5');
  const [crudeoilStPeriod, setCrudeoilStPeriod] = useState<number>(7);
  const [crudeoilStMultiplier, setCrudeoilStMultiplier] = useState<number>(3.0);
  const [crudeoilStartTime, setCrudeoilStartTime] = useState<string>('09:00');
  const [crudeoilEodTime, setCrudeoilEodTime] = useState<string>('23:30');
  const [crudeoilUseVwap, setCrudeoilUseVwap] = useState<boolean>(false);

  // CrudeOil Mini Renko SAR (shares crudeoilInterval/StartTime/EodTime above)
  const [renkoQty, setRenkoQty] = useState<number>(10);
  const [renkoBoxSize, setRenkoBoxSize] = useState<number>(5);
  const [renkoReverseBricks, setRenkoReverseBricks] = useState<number>(3);

  // ST+OI Bear Call Spread
  const [indexInterval, setIndexInterval] = useState<string>('3');
  const [indexStPeriod, setIndexStPeriod] = useState<number>(10);
  const [indexStMultiplier, setIndexStMultiplier] = useState<number>(2.0);
  const [optionInterval, setOptionInterval] = useState<string>('3');
  const [optionStPeriod, setOptionStPeriod] = useState<number>(10);
  const [optionStMultiplier, setOptionStMultiplier] = useState<number>(2.0);
  const [stOiCeOffset, setStOiCeOffset] = useState<number>(100);
  const [stOiSpreadWidth, setStOiSpreadWidth] = useState<number>(100);
  const [requireShortBuildup, setRequireShortBuildup] = useState<boolean>(false);
  const [minPriceDropPct, setMinPriceDropPct] = useState<number>(-0.5);
  const [minOiRisePct, setMinOiRisePct] = useState<number>(5.0);
  const [stOiPollInterval, setStOiPollInterval] = useState<number>(30);
  const [maxWaitMinutes, setMaxWaitMinutes] = useState<number>(45);
  const [stOiEodTime, setStOiEodTime] = useState<string>('15:15');
  const [stOiCooldownMinutes, setStOiCooldownMinutes] = useState<number>(5);
  const [exitOnSignalFlip, setExitOnSignalFlip] = useState<boolean>(true);
  const [exitOnOptionStFlip, setExitOnOptionStFlip] = useState<boolean>(true);

  const spreadTrendNoIndicators =
    meta.key === 'nifty_spread_trend' && !useEma && !useSupertrend;

  const isRunning = state.status !== 'STOPPED';
  const pnl = state.total_pnl ?? 0;

  // Reset stop state when the strategy finishes stopping so the Launch button re-enables.
  useEffect(() => {
    if (!isRunning) {
      if (submitting) setSubmitting(false);
      if (gracefulStopSent) setGracefulStopSent(false);
    }
  }, [isRunning]);
  const isPnlPositive = pnl >= 0;

  const handleStart = async () => {
    setStartError(null);
    setSubmitting(true);
    try {
      const args: string[] = [];
      if (isLive) args.push('--live');
      if (meta.key === 'crudeoilm_renko_sar') {
        // Renko SAR takes order quantity directly (barrels), not lots
        args.push('--qty', String(renkoQty));
        // and is a pure stop-and-reverse system with no daily P&L caps
      } else {
        args.push('--lots', String(lots));
        args.push('--target-profit', profitTarget.trim());
        args.push('--stop-loss', stopLoss.trim());
      }

      if (meta.key === 'nifty_advanced_imbalance') {
        args.push('--max-lots', String(maxLots));
        const effectiveEntryType = mode === 'reentry_straddle' ? 'straddle' : entryType;
        args.push('--mode', mode, '--entry-type', effectiveEntryType, '--start-time', startTime);
        if (mode === 'loser_ratio_roll') args.push('--loser-ratio-lots', String(loserRatioLots));
        if (mode === 'winner_roll_atm') args.push('--threshold-lot', String(thresholdLot));
        if (mode === 'reentry_straddle') {
          args.push('--trail-combined-buffer', String(trailCombinedBuffer));
          args.push('--leg-sl-pct', String(legSlPct));
        }
        if (effectiveEntryType === 'strangle') {
          if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
          else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
          else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        }
        args.push('--trail-start-pct', String(trailStartPct));
        args.push('--trail-gap-pts', String(trailGapPts));
      } else if (meta.key === 'nifty_delta_neutral') {
        args.push('--start-time', startTime);
        args.push('--target-delta', String(dnTargetDelta));
        args.push('--threshold-lot', String(dnThresholdLot));
        args.push('--trail-start-pct', String(trailStartPct));
        args.push('--trail-gap-pts', String(trailGapPts));
      } else if (meta.key === 'nifty_value_imbalance_straddle') {
        args.push('--max-lots', String(maxLots));
        args.push('--start-time', startTime);
        args.push('--entry-balance-threshold', String(entryBalanceThreshold));
        args.push('--trail-start-pct', String(trailStartPct));
        args.push('--trail-gap-pts', String(trailGapPts));
      } else if (meta.key === 'nifty_vwap_1min_straddle') {
        args.push('--start-time', startTime);
        args.push('--entry-band', String(entryBand));
        args.push('--decline-ticks', String(declineTicks));
        args.push('--exit-buffer', String(exitBuffer));
        args.push('--max-premium-diff', String(maxPremiumDiff));
        args.push('--vwap-warmup-bars', String(vwapWarmupBars));
      } else if (meta.key === 'nifty_value_imbalance_strangle') {
        args.push('--max-lots', String(maxLots));
        args.push('--start-time', startTime);
        if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
        else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
        else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        args.push('--trail-start-pct', String(trailStartPct));
        args.push('--trail-gap-pts', String(trailGapPts));
      } else if (meta.key === 'nifty_oi_directional') {
        args.push('--start-time', startTime);
        args.push('--pcr-threshold', String(pcrThreshold));
        args.push('--exit-pcr-change', String(exitPcrChange));
        args.push('--poll-interval', String(pollInterval));
        args.push('--expansion-window', String(expansionWindow));
      } else if (meta.key === 'nifty_spread_trend') {
        args.push('--symbol', symbol, '--interval', interval);
        args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        args.push('--spread-width', String(spreadWidth));
        args.push('--ema-period', String(emaPeriod));
        args.push('--supertrend-period', String(supertrendPeriod));
        args.push('--supertrend-multiplier', String(supertrendMultiplier));
        args.push('--eod-time', eodTime);
        args.push('--cooldown-minutes', String(cooldownMinutes));
        if (!exitOnSignalChange) args.push('--no-exit-on-signal-change');
        if (!useEma) args.push('--no-ema');
        if (!useSupertrend) args.push('--no-supertrend');
      } else if (meta.key === 'crudeoilm_supertrend') {
        args.push('--interval', crudeoilInterval);
        args.push('--supertrend-period', String(crudeoilStPeriod));
        args.push('--supertrend-multiplier', String(crudeoilStMultiplier));
        args.push('--start-time', crudeoilStartTime);
        args.push('--eod-time', crudeoilEodTime);
        if (crudeoilUseVwap) args.push('--use-vwap');
      } else if (meta.key === 'crudeoilm_renko_sar') {
        args.push('--interval', crudeoilInterval);
        args.push('--box-size', String(renkoBoxSize));
        args.push('--reverse-bricks', String(renkoReverseBricks));
        args.push('--start-time', crudeoilStartTime);
        args.push('--eod-time', crudeoilEodTime);
      } else if (meta.key === 'nifty_st_oi_bearcall') {
        args.push('--index-interval', indexInterval);
        args.push('--index-st-period', String(indexStPeriod));
        args.push('--index-st-multiplier', String(indexStMultiplier));
        args.push('--option-interval', optionInterval);
        args.push('--option-st-period', String(optionStPeriod));
        args.push('--option-st-multiplier', String(optionStMultiplier));
        args.push('--ce-offset', String(stOiCeOffset));
        args.push('--spread-width', String(stOiSpreadWidth));
        if (requireShortBuildup) {
          args.push('--require-short-buildup');
          args.push('--min-price-drop-pct', String(minPriceDropPct));
          args.push('--min-oi-rise-pct', String(minOiRisePct));
        }
        args.push('--poll-interval', String(stOiPollInterval));
        args.push('--max-wait-minutes', String(maxWaitMinutes));
        args.push('--eod-time', stOiEodTime);
        args.push('--cooldown-minutes', String(stOiCooldownMinutes));
        if (!exitOnSignalFlip) args.push('--no-exit-on-signal-flip');
        if (!exitOnOptionStFlip) args.push('--no-exit-on-option-st-flip');
      }

      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', strategy: meta.key, args }),
      });
      const data = await res.json();
      if (data.success) { onRefresh(); setShowLogs(true); setShowConfig(false); }
      else setStartError(data.error || 'Failed to start strategy');
    } catch (e) {
      setStartError(`Network error: ${e}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      const timer = setTimeout(() => setConfirmStop(false), 4000);
      setConfirmTimeoutId(timer);
      return;
    }
    if (confirmTimeoutId) { clearTimeout(confirmTimeoutId); setConfirmTimeoutId(null); }
    setConfirmStop(false);
    setSubmitting(true);
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', strategy: meta.key }),
      });
      const data = await res.json();
      if (data.success) {
        setGracefulStopSent(true);
        setTimeout(onRefresh, 1500);
        // Keep submitting=true so spinner shows until isRunning → false
      } else {
        setStartError(data.error || 'Failed to stop strategy');
        setSubmitting(false);
      }
    } catch (e) {
      setStartError(`Network error: ${e}`);
      setSubmitting(false);
    }
  };

  const handleForceKill = async () => {
    setForceKilling(true);
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force_stop', strategy: meta.key }),
      });
      const data = await res.json();
      if (data.success) {
        setGracefulStopSent(false);
        setSubmitting(false);
        setTimeout(onRefresh, 500);
      } else {
        setStartError(data.error || 'Force kill failed');
      }
    } catch (e) {
      setStartError(`Network error: ${e}`);
    } finally {
      setForceKilling(false);
    }
  };

  const statusBadge = () => {
    const map: Record<string, { color: string; label: string }> = {
      RUNNING:      { color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', label: 'Running' },
      MONITORING:   { color: 'bg-sky-500/10 text-sky-400 border-sky-500/20', label: 'Monitoring' },
      BALANCING:    { color: 'bg-sky-500/10 text-sky-400 border-sky-500/20', label: 'Balancing' },
      SCANNING:     { color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20', label: 'Scanning' },
      WATCHING:     { color: 'bg-violet-500/10 text-violet-400 border-violet-500/20', label: 'Watching' },
      INITIALIZING: { color: 'bg-amber-500/10 text-amber-400 border-amber-500/20', label: 'Init' },
    };
    const cfg = map[state.status];
    if (cfg) {
      return (
        <Badge className={`gap-1 font-bold uppercase text-[9px] tracking-wide h-4 px-1.5 ${cfg.color}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          {cfg.label}
        </Badge>
      );
    }
    return (
      <Badge className="gap-1 font-bold uppercase text-[9px] tracking-wide h-4 px-1.5 bg-zinc-800/80 text-zinc-500 border-zinc-700/50">
        <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
        Stopped
      </Badge>
    );
  };

  const lbl = 'text-[10px] text-zinc-400 uppercase tracking-wider font-semibold leading-none';
  const fieldCls = 'flex flex-col gap-1';
  const inputCls = 'bg-zinc-900/80 border-zinc-800 text-white font-mono h-7 text-xs';

  const FieldLabel = ({ text, tip, className }: { text: string; tip: string; className?: string }) => (
    <Tooltip>
      <TooltipTrigger
        className={`${className ?? lbl} cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2 text-left w-fit`}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );

  /* ── CONFIG PANEL (shared between stopped-expanded and nothing else) ── */
  const configPanel = (
    <div className="flex flex-col gap-2.5 border border-zinc-800/60 px-3 py-2.5 rounded-lg bg-zinc-950/30">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Parameters</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">

        <div className={fieldCls}>
          <FieldLabel text="Execution" tip="Dry run (default) only simulates/logs orders. LIVE places real broker orders." />
          <div className="flex items-center gap-2 h-7">
            <input
              type="checkbox"
              id={`live-${meta.key}`}
              checked={isLive}
              onChange={(e) => setIsLive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
            />
            <label
              htmlFor={`live-${meta.key}`}
              title="When checked, places real broker orders instead of simulating them"
              className="text-white font-semibold flex items-center gap-1 text-xs"
            >
              LIVE {isLive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />}
            </label>
          </div>
        </div>

        {meta.key === 'crudeoilm_renko_sar' ? (
          <div className={fieldCls}>
            <FieldLabel text="Quantity" tip="Order size in barrels (MCX lot size = 10); not multiplied like other strategies' Lots field." />
            <Input type="number" value={renkoQty} onChange={(e) => setRenkoQty(parseInt(e.target.value) || 10)} min={1} step={1} className={inputCls} />
            <span className="text-[9px] text-zinc-600">MCX lot size = 10 barrels</span>
          </div>
        ) : (
          <div className={fieldCls}>
            <FieldLabel text="Lots" tip="Number of lot-sized units traded per leg at entry (multiplied by the instrument's live lot size)." />
            <Input type="number" value={lots} onChange={(e) => setLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} />
          </div>
        )}

        {(meta.key === 'nifty_advanced_imbalance' ||
          meta.key === 'nifty_value_imbalance_straddle' ||
          meta.key === 'nifty_value_imbalance_strangle') && (
          <div className={fieldCls}>
            <FieldLabel text="Max Lots" tip="Maximum lots per leg reached via lot averaging/rolling before a strike shift is triggered." />
            <Input type="number" value={maxLots} onChange={(e) => setMaxLots(parseInt(e.target.value) || 4)} min={1} max={20} className={inputCls} />
          </div>
        )}

        {meta.key === 'nifty_advanced_imbalance' && mode === 'winner_roll_atm' && (
          <div className={fieldCls}>
            <FieldLabel text="Threshold Lot %" tip="Base premium imbalance % (added to the post-entry/post-roll baseline offset) that triggers a winner-roll adjustment." />
            <Input type="number" value={thresholdLot} onChange={(e) => setThresholdLot(parseFloat(e.target.value) || 25.0)} min={1} step={0.5} className={inputCls} />
          </div>
        )}

        {meta.key !== 'nifty_spread_trend' && meta.key !== 'crudeoilm_supertrend' && meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'nifty_st_oi_bearcall' && (
          <div className={fieldCls}>
            <FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins monitoring for entries." />
            <Input type="text" value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="09:20" className={inputCls} />
          </div>
        )}

        {meta.key !== 'crudeoilm_renko_sar' && meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR; strategy squares off and stops once reached." />
              <Input type="number" value={profitTarget} onChange={(e) => setProfitTarget(e.target.value || '1000')} className={inputCls} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR; strategy squares off and stops once breached." />
              <Input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value || '1000')} className={inputCls} />
            </div>
          </>
        )}

        {meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR, or a percentage of entry premium collected e.g. '20%'; strategy squares off and stops once reached." />
              <Input type="text" inputMode="decimal" value={profitTarget} onChange={(e) => setProfitTarget(e.target.value)} placeholder="4000 or 20%" className={inputCls} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR, or a percentage of entry premium collected e.g. '20%'; strategy squares off and stops once breached." />
              <Input type="text" inputMode="decimal" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="4000 or 20%" className={inputCls} />
            </div>
          </>
        )}

        {meta.key === 'nifty_spread_trend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Symbol" tip="Underlying index traded (NIFTY or BANKNIFTY)." />
              <Select value={symbol} onValueChange={(v) => v && setSymbol(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NIFTY">NIFTY</SelectItem>
                  <SelectItem value="BANKNIFTY">BANKNIFTY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Candle interval in minutes used for the EMA/Supertrend trend signal." />
              <Select value={interval} onValueChange={(v) => v && setIntervalVal(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Spread Width (pts)" tip="Point gap between the short strike and the long hedge strike." />
              <Input type="number" value={spreadWidth} onChange={(e) => setSpreadWidth(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="CE Offset (pts)" tip="Points above spot for the short Call strike." />
              <Input type="number" value={ceOffset} onChange={(e) => setCeOffset(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="PE Offset (pts)" tip="Points below spot for the short Put strike." />
              <Input type="number" value={peOffset} onChange={(e) => setPeOffset(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input
                  type="checkbox"
                  id={`use-ema-${meta.key}`}
                  checked={useEma}
                  onChange={(e) => setUseEma(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`use-ema-${meta.key}`} title="Enables the EMA trend filter; EMA and Supertrend must both agree to trade unless disabled" className={lbl}>EMA</label>
              </div>
              {useEma && (
                <Input
                  type="number"
                  value={emaPeriod}
                  onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 20)}
                  className={inputCls}
                  placeholder="Period"
                  title="EMA lookback period (bars)"
                />
              )}
            </div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input
                  type="checkbox"
                  id={`use-st-${meta.key}`}
                  checked={useSupertrend}
                  onChange={(e) => setUseSupertrend(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`use-st-${meta.key}`} title="Enables the Supertrend trend filter; EMA and Supertrend must both agree to trade unless disabled" className={lbl}>Supertrend</label>
              </div>
              {useSupertrend && (
                <>
                  <Input
                    type="number"
                    value={supertrendPeriod}
                    onChange={(e) => setSupertrendPeriod(parseInt(e.target.value) || 7)}
                    className={inputCls}
                    placeholder="Period"
                    title="ATR lookback length for the Supertrend"
                  />
                  <Input
                    type="number"
                    step="0.5"
                    value={supertrendMultiplier}
                    onChange={(e) => setSupertrendMultiplier(parseFloat(e.target.value) || 3.0)}
                    className={inputCls}
                    placeholder="Multiplier"
                    title="ATR multiplier controlling the Supertrend band width"
                  />
                </>
              )}
            </div>
            {spreadTrendNoIndicators && (
              <div className="col-span-full px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-400 font-medium">
                Enable at least one indicator to launch.
              </div>
            )}
            <div className={fieldCls}>
              <FieldLabel text="EOD Time" tip="Time (HH:MM IST) positions are auto-squared-off for the day." />
              <Input type="text" value={eodTime} onChange={(e) => setEodTime(e.target.value)} placeholder="15:15" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Cooldown (min)" tip="Minutes to wait after a standard exit before a new entry is allowed." />
              <Input type="number" value={cooldownMinutes} onChange={(e) => setCooldownMinutes(parseInt(e.target.value) || 5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Signal Change" tip="If enabled, exits early when the EMA/Supertrend trend reverses instead of holding to SL/target/EOD." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`exit-signal-${meta.key}`}
                  checked={exitOnSignalChange}
                  onChange={(e) => setExitOnSignalChange(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`exit-signal-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
          </>
        )}

        {/* ST+OI Bear Call Spread-specific */}
        {meta.key === 'nifty_st_oi_bearcall' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Index Timeframe" tip="Candle interval (minutes) for the index's own Supertrend, resampled from 1-min data." />
              <Select value={indexInterval} onValueChange={(v) => v && setIndexInterval(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Index ST Period" tip="ATR lookback length for the index Supertrend." />
              <Input type="number" value={indexStPeriod} onChange={(e) => setIndexStPeriod(parseInt(e.target.value) || 10)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Index ST Multiplier" tip="ATR multiplier for the index Supertrend band width." />
              <Input type="number" step="0.5" value={indexStMultiplier} onChange={(e) => setIndexStMultiplier(parseFloat(e.target.value) || 2.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Option Timeframe" tip="Candle interval (minutes) for the candidate option's own Supertrend." />
              <Select value={optionInterval} onValueChange={(v) => v && setOptionInterval(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Option ST Period" tip="ATR lookback length for the candidate option's own Supertrend." />
              <Input type="number" value={optionStPeriod} onChange={(e) => setOptionStPeriod(parseInt(e.target.value) || 10)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Option ST Multiplier" tip="ATR multiplier for the option's own Supertrend band width." />
              <Input type="number" step="0.5" value={optionStMultiplier} onChange={(e) => setOptionStMultiplier(parseFloat(e.target.value) || 2.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="CE Offset (pts OTM)" tip="Fixed points above ATM used to lock the candidate short CE strike." />
              <Input type="number" value={stOiCeOffset} onChange={(e) => setStOiCeOffset(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Spread Width (pts)" tip="Point gap between the short CE and the long hedge CE strike." />
              <Input type="number" value={stOiSpreadWidth} onChange={(e) => setStOiSpreadWidth(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input
                  type="checkbox"
                  id={`require-buildup-${meta.key}`}
                  checked={requireShortBuildup}
                  onChange={(e) => setRequireShortBuildup(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`require-buildup-${meta.key}`} title="Also requires price-down + OI-up confirmation on the candidate strike before entry" className={lbl}>Require Short Buildup</label>
              </div>
            </div>
            {requireShortBuildup && (
              <>
                <div className={fieldCls}>
                  <FieldLabel text="Min Price Drop %" tip="Max allowed CE price change vs previous close for short-buildup confirmation." />
                  <Input type="number" step="0.1" value={minPriceDropPct} onChange={(e) => setMinPriceDropPct(parseFloat(e.target.value) || -0.5)} className={inputCls} />
                </div>
                <div className={fieldCls}>
                  <FieldLabel text="Min OI Rise %" tip="Min required CE OI change vs previous OI for short-buildup confirmation." />
                  <Input type="number" step="0.5" value={minOiRisePct} onChange={(e) => setMinOiRisePct(parseFloat(e.target.value) || 5.0)} className={inputCls} />
                </div>
              </>
            )}
            <div className={fieldCls}>
              <FieldLabel text="Poll Interval (s)" tip="Seconds between checks while watching for the option's own Supertrend to turn bearish." />
              <Input type="number" value={stOiPollInterval} onChange={(e) => setStOiPollInterval(parseInt(e.target.value) || 30)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Max Wait (min)" tip="Abandons a watch cycle and resets if no entry occurs within this many minutes of locking a candidate strike." />
              <Input type="number" value={maxWaitMinutes} onChange={(e) => setMaxWaitMinutes(parseInt(e.target.value) || 45)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="EOD Time" tip="Time (HH:MM IST) positions are auto-squared-off for the day." />
              <Input type="text" value={stOiEodTime} onChange={(e) => setStOiEodTime(e.target.value)} placeholder="15:15" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Cooldown (min)" tip="Minutes to wait after an exit or abandoned watch cycle before scanning again." />
              <Input type="number" value={stOiCooldownMinutes} onChange={(e) => setStOiCooldownMinutes(parseInt(e.target.value) || 5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Index ST Flip" tip="If enabled, exits early if the index Supertrend flips back bullish." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`exit-idx-st-${meta.key}`}
                  checked={exitOnSignalFlip}
                  onChange={(e) => setExitOnSignalFlip(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`exit-idx-st-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Option ST Flip" tip="If enabled, exits early if the short option's own Supertrend flips back bullish." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`exit-opt-st-${meta.key}`}
                  checked={exitOnOptionStFlip}
                  onChange={(e) => setExitOnOptionStFlip(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`exit-opt-st-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
          </>
        )}

        {/* OI Directional-specific */}
        {meta.key === 'nifty_oi_directional' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="PCR Threshold" tip="PCR level above which a PE is sold (bullish); CE entry threshold is the reciprocal (1/X)." />
              <Input type="number" step="0.1" value={pcrThreshold} onChange={(e) => setPcrThreshold(parseFloat(e.target.value) || 1.5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit PCR Change (%)" tip="% change in the held strike's PCR from its entry level that triggers an exit." />
              <Input type="number" value={exitPcrChange} onChange={(e) => setExitPcrChange(parseInt(e.target.value) || 30)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Poll Interval (s)" tip="Seconds between option-chain/OI snapshot fetches." />
              <Input type="number" value={pollInterval} onChange={(e) => setPollInterval(parseInt(e.target.value) || 60)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Expansion Window" tip="Number of OI snapshots required before a direction is trusted and entries are allowed." />
              <Input type="number" value={expansionWindow} onChange={(e) => setExpansionWindow(parseInt(e.target.value) || 3)} className={inputCls} />
            </div>
          </>
        )}

        {/* CrudeOil Mini Supertrend-specific */}
        {meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Candle interval in minutes used for the Supertrend signal." />
              <Select value={crudeoilInterval} onValueChange={(v) => v && setCrudeoilInterval(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="ST Period" tip="ATR lookback length for the Supertrend." />
              <Input
                type="number"
                value={crudeoilStPeriod}
                onChange={(e) => setCrudeoilStPeriod(parseInt(e.target.value) || 7)}
                min={2}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="ST Multiplier" tip="ATR multiplier for the Supertrend band width; becomes the trailing stop level." />
              <Input
                type="number"
                step="0.5"
                value={crudeoilStMultiplier}
                onChange={(e) => setCrudeoilStMultiplier(parseFloat(e.target.value) || 3.0)}
                min={0.5}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins monitoring for entries." />
              <Input
                type="text"
                value={crudeoilStartTime}
                onChange={(e) => setCrudeoilStartTime(e.target.value)}
                placeholder="09:00"
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="EOD Time" tip="Time (HH:MM IST) the position is flattened for the day." />
              <Input
                type="text"
                value={crudeoilEodTime}
                onChange={(e) => setCrudeoilEodTime(e.target.value)}
                placeholder="23:25"
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="VWAP Filter" tip="Uses session VWAP as an additional exit signal alongside the Supertrend trail." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`vwap-${meta.key}`}
                  checked={crudeoilUseVwap}
                  onChange={(e) => setCrudeoilUseVwap(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`vwap-${meta.key}`} className="text-zinc-300 text-xs">
                  Require price above/below VWAP
                </label>
              </div>
            </div>
          </>
        )}

        {/* CrudeOil Mini Renko SAR-specific */}
        {meta.key === 'crudeoilm_renko_sar' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Source candle interval (minutes) used to build the Renko brick series." />
              <Select value={crudeoilInterval} onValueChange={(v) => v && setCrudeoilInterval(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Brick Size (pts)" tip="Point size of each Renko brick." />
              <Input
                type="number"
                step="0.5"
                value={renkoBoxSize}
                onChange={(e) => setRenkoBoxSize(parseFloat(e.target.value) || 5)}
                min={0.5}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Reverse Bricks" tip="Consecutive opposite-colored bricks required to flip the held position." />
              <Input
                type="number"
                value={renkoReverseBricks}
                onChange={(e) => setRenkoReverseBricks(parseInt(e.target.value) || 3)}
                min={1}
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins trading." />
              <Input
                type="text"
                value={crudeoilStartTime}
                onChange={(e) => setCrudeoilStartTime(e.target.value)}
                placeholder="09:00"
                className={inputCls}
              />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="EOD Time" tip="Time (HH:MM IST) the position is flattened for the day (otherwise always-in)." />
              <Input
                type="text"
                value={crudeoilEodTime}
                onChange={(e) => setCrudeoilEodTime(e.target.value)}
                placeholder="23:30"
                className={inputCls}
              />
            </div>
          </>
        )}

        {/* Straddle-specific */}
        {meta.key === 'nifty_value_imbalance_straddle' && (
          <div className={fieldCls}>
            <FieldLabel text="Balance Threshold (%)" tip="Max CE/PE premium difference allowed at entry; trade only enters when imbalance is below this." />
            <Input type="number" step="0.5" value={entryBalanceThreshold} onChange={(e) => setEntryBalanceThreshold(parseFloat(e.target.value) || 15.0)} className={inputCls} />
          </div>
        )}

        {/* Combined-premium trailing SL — straddle, strangle, advanced imbalance, and delta neutral */}
        {(meta.key === 'nifty_advanced_imbalance' ||
          meta.key === 'nifty_value_imbalance_straddle' ||
          meta.key === 'nifty_value_imbalance_strangle' ||
          meta.key === 'nifty_delta_neutral') && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Trail Start (%)" tip="Arms the trailing stop once profit reaches this % of entry combined premium." />
              <Input type="number" step="0.5" value={trailStartPct} onChange={(e) => setTrailStartPct(parseFloat(e.target.value) || 5.0)} min={0.5} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Trail Gap (pts)" tip="Once armed, exits if combined premium rises this many points above its lowest point since arming." />
              <Input type="number" step="0.5" value={trailGapPts} onChange={(e) => setTrailGapPts(parseFloat(e.target.value) || 15.0)} min={0.5} className={inputCls} />
            </div>
          </>
        )}

        {/* VWAP shared params */}
        {meta.key === 'nifty_vwap_1min_straddle' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Entry Band (pts)" tip="Max points above the straddle's VWAP at which entry is still allowed." />
              <Input type="number" step="0.5" value={entryBand} onChange={(e) => setEntryBand(parseFloat(e.target.value) || 5.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Decline Ticks" tip="Number of recent WebSocket ticks over which combined premium must be falling before entry." />
              <Input type="number" value={declineTicks} onChange={(e) => setDeclineTicks(parseInt(e.target.value) || 5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit Buffer (pts)" tip="Points above VWAP that trigger exit (buy back both legs); should stay ≥ Entry Band." />
              <Input type="number" step="0.5" value={exitBuffer} onChange={(e) => setExitBuffer(parseFloat(e.target.value) || 10.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Max Premium Diff (%)" tip="Max allowed % difference between CE and PE premiums for entry to be considered balanced." />
              <Input type="number" step="0.5" value={maxPremiumDiff} onChange={(e) => setMaxPremiumDiff(parseFloat(e.target.value) || 15.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="VWAP Warmup (bars)" tip="Minimum completed 1-min bars required before VWAP is trusted for trade decisions." />
              <Input type="number" value={vwapWarmupBars} onChange={(e) => setVwapWarmupBars(parseInt(e.target.value) || 10)} className={inputCls} />
            </div>
          </>
        )}

        {meta.key === 'nifty_advanced_imbalance' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Mode" tip="Adjustment logic on imbalance: rolls/hedges/adds lots to the winning or losing leg, or runs independent per-leg re-entry." />
              <Select value={mode} onValueChange={(v) => v && setMode(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="winner_roll_atm">Winner Roll ATM</SelectItem>
                  <SelectItem value="loser_ratio_roll">Loser Ratio Roll</SelectItem>
                  <SelectItem value="hedged_addition">Hedged Addition</SelectItem>
                  <SelectItem value="legacy">Legacy (Naked)</SelectItem>
                  <SelectItem value="reentry_straddle">Re-entry Straddle</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode === 'loser_ratio_roll' && (
              <div className={fieldCls}>
                <FieldLabel text="Ratio Lots" tip="Lots added to the rolled losing leg on each adjustment." />
                <Input type="number" value={loserRatioLots} onChange={(e) => setLoserRatioLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} />
              </div>
            )}
            {mode === 'reentry_straddle' && (
              <>
                <div className={fieldCls}>
                  <FieldLabel text="Trail Buffer (pts)" tip="Points of pullback from the best combined premium allowed before the combined trailing exit triggers." />
                  <Input type="number" step="0.5" value={trailCombinedBuffer} onChange={(e) => setTrailCombinedBuffer(parseFloat(e.target.value) || 1.0)} min={0.1} className={inputCls} />
                </div>
                <div className={fieldCls}>
                  <FieldLabel text="Leg SL (%)" tip="Per-leg stop loss as a % of entry premium; only that leg exits and re-enters, the other keeps running." />
                  <Input type="number" step="1" value={Math.round(legSlPct * 100)} onChange={(e) => setLegSlPct((parseInt(e.target.value) || 20) / 100)} min={1} max={100} className={inputCls} />
                </div>
              </>
            )}
            {mode !== 'reentry_straddle' && (
              <div className={fieldCls}>
                <FieldLabel text="Entry Type" tip="Sell an ATM straddle (CE+PE at spot) or an OTM strangle (offset CE/PE strikes)." />
                <Select value={entryType} onValueChange={(v) => v && setEntryType(v)}>
                  <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="straddle">Straddle (ATM)</SelectItem>
                    <SelectItem value="strangle">Strangle (OTM)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}

        {meta.key === 'nifty_delta_neutral' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target Delta" tip="Target absolute delta used to pick CE and PE strikes independently; can produce a straddle, strangle, or inverted strangle depending on skew." />
              <Input type="number" step="0.1" min={0.1} max={0.9} value={dnTargetDelta} onChange={(e) => setDnTargetDelta(Math.round((parseFloat(e.target.value) || 0.5) * 10) / 10)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Threshold Lot %" tip="Premium imbalance % (added to the post-entry/post-roll baseline offset) that triggers closing the winning leg and matching its strike to the losing leg's premium." />
              <Input type="number" value={dnThresholdLot} onChange={(e) => setDnThresholdLot(parseFloat(e.target.value) || 50.0)} min={1} step={0.5} className={inputCls} />
            </div>
          </>
        )}

        {(meta.key === 'nifty_value_imbalance_strangle' ||
          (meta.key === 'nifty_advanced_imbalance' && entryType === 'strangle' && mode !== 'reentry_straddle')) && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Strike Selection" tip="How strangle strikes are chosen: fixed point distance, target option delta, or target premium value." />
              <Select value={strikeSelection} onValueChange={(v) => v && setStrikeSelection(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="distance">Fixed Offset</SelectItem>
                  <SelectItem value="delta">Delta Based</SelectItem>
                  <SelectItem value="premium">Target Premium</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {strikeSelection === 'distance' && (
              <>
                <div className={fieldCls}>
                  <FieldLabel text="CE Offset (pts)" tip="Points above spot for the Call strike." />
                  <Input type="number" value={ceOffset} onChange={(e) => setCeOffset(parseInt(e.target.value) || 200)} className={inputCls} />
                </div>
                <div className={fieldCls}>
                  <FieldLabel text="PE Offset (pts)" tip="Points below spot for the Put strike." />
                  <Input type="number" value={peOffset} onChange={(e) => setPeOffset(parseInt(e.target.value) || 200)} className={inputCls} />
                </div>
              </>
            )}
            {strikeSelection === 'delta' && (
              <div className={fieldCls}>
                <FieldLabel text="Target Delta" tip="Target absolute option delta used to pick the CE/PE strikes." />
                <Input type="number" step="0.01" value={targetDelta} onChange={(e) => setTargetDelta(parseFloat(e.target.value) || 0.20)} className={inputCls} />
              </div>
            )}
            {strikeSelection === 'premium' && (
              <div className={fieldCls}>
                <FieldLabel text="Target Premium ₹" tip="Target premium value used to pick the CE/PE strikes." />
                <Input type="number" value={targetPremium} onChange={(e) => setTargetPremium(parseFloat(e.target.value) || 50.0)} className={inputCls} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  /* ══════════════════════════════════════════════════════════════════ */

  return (
    <div className="border border-zinc-800/80 bg-zinc-950/50 rounded-xl overflow-hidden flex flex-col">

      {/* ── Header (always visible) ─────────────────────────────────── */}
      <div className="px-3 py-2 flex items-center gap-2">
        {/* Left: name + running badges */}
        <div className="flex-1 flex items-center gap-1.5 min-w-0 overflow-hidden">
          <h3 className="font-bold text-white text-sm leading-none truncate">{meta.name}</h3>
          {isRunning && state.mode && (
            <Badge className="text-[9px] h-4 px-1.5 bg-indigo-500/10 text-indigo-400 border-indigo-500/20 font-mono shrink-0 hidden sm:inline-flex">
              {state.mode.replace(/_/g, '-')}
            </Badge>
          )}
          {isRunning && state.entry_type && (
            <Badge className="text-[9px] h-4 px-1.5 bg-zinc-800 text-zinc-400 border-zinc-700/50 font-mono capitalize shrink-0 hidden md:inline-flex">
              {state.entry_type}
            </Badge>
          )}
          {isRunning && (
            <span className="text-[10px] text-zinc-600 font-mono shrink-0 hidden lg:inline">·{state.pid}</span>
          )}
        </div>

        {/* Right: badges + actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && state.dry_run && (
            <Badge className="gap-0.5 text-[9px] font-bold h-4 px-1.5 bg-amber-500/10 text-amber-400 border-amber-500/20">
              <ShieldAlert className="h-2.5 w-2.5" />SIM
            </Badge>
          )}
          {statusBadge()}

          {/* Stopped: config toggle + inline launch */}
          {!isRunning && (
            <>
              <button
                onClick={() => setShowConfig(!showConfig)}
                title="Configure"
                className={`h-6 w-6 rounded-md flex items-center justify-center transition-colors ${
                  showConfig ? 'bg-zinc-800 text-white' : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/60'
                }`}
              >
                {showConfig ? <ChevronUp className="h-3.5 w-3.5" /> : <Settings className="h-3.5 w-3.5" />}
              </button>
              {!showConfig && (
                <Button
                  onClick={handleStart}
                  disabled={submitting || spreadTrendNoIndicators}
                  className="h-6 px-2.5 gap-1 bg-emerald-600/80 hover:bg-emerald-500/80 text-white font-bold rounded-md text-[10px] border-0 shadow-none active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="h-2.5 w-2.5 fill-white" />
                  Launch
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Body (running stats OR config panel) ────────────────────── */}
      {(isRunning || showConfig) && (
        <div className="border-t border-zinc-800/60 p-3 flex flex-col gap-2.5">

          {isRunning ? (
            /* Running: compact stats strip */
            <div className="flex items-stretch divide-x divide-zinc-800/70 border border-zinc-800/60 rounded-lg bg-zinc-900/30 overflow-x-auto text-xs">
              {meta.key === 'nifty_oi_directional' ? (
                <>
                  {state.spot != null && (
                    <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                      <span className={lbl}>Spot</span>
                      <span className="font-mono font-bold text-zinc-200">{state.spot.toFixed(1)}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Direction</span>
                    <span className={`font-mono font-bold ${state.direction === 'BULLISH' ? 'text-emerald-400' : state.direction === 'BEARISH' ? 'text-rose-400' : 'text-zinc-500'}`}>
                      {state.direction || '—'}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">diff {state.oi_diff != null ? (state.oi_diff > 0 ? '+' : '') + state.oi_diff.toFixed(0) : '—'}</span>
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[100px]">
                    <span className={lbl}>Position</span>
                    {state.in_position && state.sold_strike ? (
                      <>
                        <span className={`font-mono font-bold ${state.position_type === 'PE_SELL' ? 'text-rose-400' : 'text-emerald-400'}`}>
                          {state.sold_strike} {state.position_type?.replace('_SELL', '') ?? ''}
                        </span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          avg ₹{state.avg_price?.toFixed(1) ?? '—'} · ltp ₹{state.current_ltp?.toFixed(1) ?? '—'}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-zinc-600">FLAT</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>PCR</span>
                    <span className="font-mono font-bold text-zinc-300">
                      {state.entry_pcr ? state.entry_pcr.toFixed(3) : '—'}
                    </span>
                    {state.exit_pcr_level ? (
                      <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                        exit @{state.exit_pcr_level.toFixed(3)}
                      </span>
                    ) : null}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
                    </span>
                    {state.realized_pnl !== undefined && state.realized_pnl !== 0 && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">real ₹{state.realized_pnl.toFixed(0)}</span>
                    )}
                  </div>
                </>
              ) : meta.key === 'crudeoilm_supertrend' ? (
                <>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Direction</span>
                    <span className={`font-mono font-bold ${
                      state.direction === 'LONG' ? 'text-emerald-400' :
                      state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'
                    }`}>
                      {state.direction || 'NONE'}
                    </span>
                    {state.expiry && (
                      <span className="text-[10px] text-zinc-500 font-mono">{state.expiry}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[110px]">
                    <span className={lbl}>Entry / LTP</span>
                    {state.direction && state.direction !== 'NONE' ? (
                      <>
                        <span className="font-mono font-bold text-zinc-200">
                          {state.ltp != null ? state.ltp.toFixed(2) : '—'}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono whitespace-nowrap">
                          avg ₹{state.entry_price?.toFixed(2) ?? '—'}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-zinc-600">—</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>ST SL</span>
                    <span className="font-mono font-bold text-amber-400">
                      {state.st_level != null && state.st_level > 0 ? state.st_level.toFixed(2) : '—'}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono">
                      {state.interval ? `${state.interval}m ST(${state.supertrend_period ?? 7},${state.supertrend_multiplier ?? 3})${state.use_vwap ? ' +VWAP' : ''}` : ''}
                    </span>
                    {state.use_vwap && state.vwap != null && state.vwap > 0 && (
                      <span className="text-[10px] text-sky-400 font-mono">VWAP {state.vwap.toFixed(2)}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Day P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${(state.daily_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {(state.daily_pnl ?? 0) >= 0 ? '+' : ''}₹{(state.daily_pnl ?? 0).toFixed(0)}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                      tgt ₹{state.target_profit?.toFixed(0) ?? '—'} · sl ₹{state.stop_loss?.toFixed(0) ?? '—'}
                    </span>
                  </div>
                </>
              ) : meta.key === 'crudeoilm_renko_sar' ? (
                <>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Direction</span>
                    <span className={`font-mono font-bold ${
                      state.direction === 'LONG' ? 'text-emerald-400' :
                      state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'
                    }`}>
                      {state.direction || 'NONE'}
                    </span>
                    {state.expiry && (
                      <span className="text-[10px] text-zinc-500 font-mono">{state.expiry}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[110px]">
                    <span className={lbl}>Entry / LTP</span>
                    {state.direction && state.direction !== 'NONE' ? (
                      <>
                        <span className="font-mono font-bold text-zinc-200">
                          {state.ltp != null ? state.ltp.toFixed(2) : '—'}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono whitespace-nowrap">
                          avg ₹{state.entry_price?.toFixed(2) ?? '—'} · qty {state.qty ?? '—'}
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-zinc-600">—</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Renko</span>
                    <span className={`font-mono font-bold ${
                      state.last_brick_color === 'GREEN' ? 'text-emerald-400' :
                      state.last_brick_color === 'RED' ? 'text-rose-400' : 'text-zinc-500'
                    }`}>
                      {state.last_brick_color || '—'}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                      {state.interval ?? 5}m · box {state.box_size ?? 5} · opp {state.consecutive_opposite ?? 0}/{state.reverse_bricks ?? 3}
                    </span>
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Day P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${(state.daily_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {(state.daily_pnl ?? 0) >= 0 ? '+' : ''}₹{(state.daily_pnl ?? 0).toFixed(0)}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                      {state.brick_count ?? 0} bricks
                    </span>
                  </div>
                </>
              ) : meta.key === 'nifty_st_oi_bearcall' ? (
                <>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Phase</span>
                    <span className={`font-mono font-bold ${
                      state.phase === 'ENTERED' ? 'text-emerald-400' :
                      state.phase === 'WATCHING' ? 'text-violet-400' : 'text-zinc-500'
                    }`}>
                      {state.phase || 'IDLE'}
                    </span>
                    {state.spot != null && state.spot > 0 && (
                      <span className="text-[10px] text-zinc-500 font-mono">spot {state.spot.toFixed(1)}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[120px]">
                    {state.phase === 'ENTERED' ? (
                      <>
                        <span className={lbl}>Spread</span>
                        <span className="font-mono font-bold text-sky-400">S:{state.short_strike || '-'} · L:{state.long_strike || '-'}</span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          {state.short_ltp != null ? `₹${state.short_ltp.toFixed(1)}` : '—'} / {state.long_ltp != null ? `₹${state.long_ltp.toFixed(1)}` : '—'}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={lbl}>Candidate</span>
                        <span className="font-mono font-bold text-amber-400">{state.candidate_strike ? `${state.candidate_strike} CE` : '—'}</span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          idxST {state.index_st_dir === -1 ? 'BEAR' : state.index_st_dir === 1 ? 'BULL' : '—'} · optST {state.option_st_dir === -1 ? 'BEAR' : state.option_st_dir === 1 ? 'BULL' : '—'}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Short Buildup</span>
                    {state.require_short_buildup ? (
                      <>
                        <span className="font-mono font-bold text-xs text-zinc-200">
                          {state.ce_price_change_pct != null ? `${state.ce_price_change_pct.toFixed(1)}%` : '—'} / {state.ce_oi_change_pct != null ? `+${state.ce_oi_change_pct.toFixed(1)}%` : '—'}
                        </span>
                        <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                          need ≤{state.min_price_drop_pct ?? -0.5}% / ≥{state.min_oi_rise_pct ?? 5.0}%
                        </span>
                      </>
                    ) : (
                      <span className="font-mono text-xs text-zinc-600">Disabled</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
                    </span>
                    <span className="text-[10px] text-zinc-500 font-mono whitespace-nowrap">
                      tgt ₹{state.profit_target?.toFixed(0) ?? '—'} · sl ₹{state.stop_loss?.toFixed(0) ?? '—'}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {meta.key !== 'nifty_spread_trend' && state.spot && (
                    <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                      <span className={lbl}>Spot</span>
                      <span className="font-mono font-bold text-zinc-200">{state.spot.toFixed(1)}</span>
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[90px]">
                    {meta.key === 'nifty_spread_trend' ? (
                      <>
                        <span className={lbl}>Spread</span>
                        <span className="font-mono font-bold text-sky-400">{state.active_spread || '—'}</span>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          S:{state.short_strike || '-'} · L:{state.long_strike || '-'}
                        </span>
                        <div className="flex gap-1 mt-0.5">
                          {(state.use_ema !== false) && (
                            <span className="text-[9px] font-bold px-1 rounded bg-indigo-500/15 text-indigo-400">EMA</span>
                          )}
                          {(state.use_supertrend !== false) && (
                            <span className="text-[9px] font-bold px-1 rounded bg-violet-500/15 text-violet-400">ST</span>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={lbl}>CE Strike</span>
                        <div className="flex items-center gap-1">
                          <span className="font-mono font-bold text-emerald-400">{state.ce_strike || '—'}</span>
                          {state.mode === 'reentry_straddle' && state.ce_active != null && (
                            <span className={`text-[9px] font-bold px-1 rounded ${state.ce_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                              {state.ce_active ? 'LIVE' : 'RE-ENTRY'}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                          {state.ce_lots ?? 0}L{state.ce_ltp != null ? ` · ₹${state.ce_ltp.toFixed(0)}` : ''}{state.ce_avg_price ? ` (avg ${state.ce_avg_price.toFixed(0)})` : ''}
                        </span>
                        {state.mode === 'reentry_straddle' && state.ce_sl != null && state.ce_sl > 0 && (
                          <span className="text-[10px] text-rose-400/70 font-mono whitespace-nowrap">
                            SL ₹{state.ce_sl.toFixed(0)}{state.leg_sl_pct != null ? ` (${Math.round(state.leg_sl_pct * 100)}%)` : ''}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {meta.key !== 'nifty_spread_trend' && (
                    <div className="px-3 py-2 flex flex-col gap-1 flex-1 min-w-[90px]">
                      <span className={lbl}>PE Strike</span>
                      <div className="flex items-center gap-1">
                        <span className="font-mono font-bold text-rose-400">{state.pe_strike || '—'}</span>
                        {state.mode === 'reentry_straddle' && state.pe_active != null && (
                          <span className={`text-[9px] font-bold px-1 rounded ${state.pe_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                            {state.pe_active ? 'LIVE' : 'RE-ENTRY'}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                        {state.pe_lots ?? 0}L{state.pe_ltp != null ? ` · ₹${state.pe_ltp.toFixed(0)}` : ''}{state.pe_avg_price ? ` (avg ${state.pe_avg_price.toFixed(0)})` : ''}
                      </span>
                      {state.mode === 'reentry_straddle' && state.pe_sl != null && state.pe_sl > 0 && (
                        <span className="text-[10px] text-rose-400/70 font-mono whitespace-nowrap">SL ₹{state.pe_sl.toFixed(0)}</span>
                      )}
                    </div>
                  )}
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>P&amp;L</span>
                    <span className={`font-mono font-bold text-sm ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
                    </span>
                    {state.realized_pnl !== undefined && state.realized_pnl !== 0 && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">real ₹{state.realized_pnl.toFixed(0)}</span>
                    )}
                  </div>
                  <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                    <span className={lbl}>Adj</span>
                    <span className="font-mono font-bold text-zinc-300">{state.adjustments ?? 0}</span>
                    {state.max_lots != null && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">max {state.max_lots}L</span>
                    )}
                    {state.threshold_lot != null && (state.mode === 'winner_roll_atm' || state.mode === 'delta_neutral_winner_roll') && (
                      <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">thresh {state.threshold_lot}%</span>
                    )}
                  </div>
                  {state.entry_combined_pts != null && state.entry_combined_pts > 0 && (
                    <div className="px-3 py-2 flex flex-col gap-1 shrink-0">
                      <span className={lbl}>Trail SL</span>
                      {state.trail_active ? (
                        <>
                          <span className="font-mono font-bold text-amber-400 text-xs">ACTIVE</span>
                          <span className="text-[10px] text-zinc-300 font-mono whitespace-nowrap">
                            best {state.best_combined_pts?.toFixed(1)} · exit@{state.trail_exit_combined?.toFixed(1) ?? '—'}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-zinc-500 text-xs">inactive</span>
                          <span className="text-[10px] text-zinc-600 font-mono whitespace-nowrap">
                            entry {state.entry_combined_pts.toFixed(1)}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            /* Stopped + config open */
            configPanel
          )}

          {/* Error banner */}
          {startError && (
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-rose-950/30 border border-rose-500/20 text-xs text-rose-400">
              <span className="truncate">{startError}</span>
              <button onClick={() => setStartError(null)} className="text-rose-500 hover:text-rose-300 font-bold text-sm leading-none shrink-0">×</button>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <Button
                  onClick={handleStop}
                  disabled={submitting}
                  className={`flex-1 h-8 gap-1.5 rounded-lg font-semibold text-xs border transition-all ${
                    submitting
                      ? 'border-zinc-700 bg-zinc-900 text-zinc-500 cursor-not-allowed'
                      : confirmStop
                      ? 'border-rose-500 bg-rose-500/20 text-rose-300 animate-pulse hover:bg-rose-500/30'
                      : 'border-red-500/25 bg-red-950/20 text-red-400 hover:bg-red-950/30 hover:border-red-500/40'
                  }`}
                >
                  {submitting ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" />Stopping…</>
                  ) : confirmStop ? (
                    <><Square className="h-3.5 w-3.5 fill-rose-300" />Confirm Stop</>
                  ) : (
                    <><Square className="h-3.5 w-3.5 fill-red-400" />Square Off & Stop</>
                  )}
                </Button>
                {gracefulStopSent && isRunning && (
                  <Button
                    onClick={handleForceKill}
                    disabled={forceKilling}
                    title="Process is not responding to graceful stop — force kill it"
                    className="h-8 px-2.5 gap-1 rounded-lg font-semibold text-xs border border-orange-500/40 bg-orange-950/30 text-orange-400 hover:bg-orange-900/40 hover:border-orange-500/60 transition-all active:scale-95 disabled:opacity-50"
                  >
                    {forceKilling ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                    {forceKilling ? 'Killing…' : 'Force Kill'}
                  </Button>
                )}
                <Button
                  onClick={() => setShowLogs(!showLogs)}
                  className={`h-8 px-3 rounded-lg font-semibold text-xs border transition-colors ${
                    showLogs ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-transparent border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  {showLogs ? 'Hide Logs' : 'Logs'}
                </Button>
              </>
            ) : (
              /* Config open → full-width launch */
              <Button
                onClick={handleStart}
                disabled={submitting || spreadTrendNoIndicators}
                className="flex-1 h-8 gap-1.5 bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold rounded-lg shadow-md shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-[0.98] transition-all duration-150 text-xs border-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-white" />}
                {submitting ? 'Launching…' : 'Launch Algorithm'}
              </Button>
            )}
          </div>

          {showLogs && isRunning && (
            <div className="animate-in fade-in-0 duration-200">
              <LogConsole strategyKey={meta.key} isActive={isRunning} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The /api/strategies poll rebuilds meta/state objects every 2s even when
// nothing changed, so identity comparison would re-render every card each
// tick. Compare by content instead (small objects; N is a handful of cards).
export default React.memo(StrategyCard, (prev, next) =>
  prev.onRefresh === next.onRefresh &&
  JSON.stringify(prev.meta) === JSON.stringify(next.meta) &&
  JSON.stringify(prev.state) === JSON.stringify(next.state)
);
