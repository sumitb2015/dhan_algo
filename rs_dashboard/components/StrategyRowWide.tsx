'use client';

import React, { useState, useEffect } from 'react';
import { Play, Square, Settings, ShieldAlert, Loader2, ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import LogConsole from './LogConsole';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

interface StrategyMeta { key: string; name: string }

interface StrategyState {
  strategy: string; status: string; pid?: number; dry_run?: boolean;
  lots?: number; max_lots?: number; threshold_lot?: number; loser_ratio_lots?: number;
  ce_strike?: number | null; pe_strike?: number | null;
  ce_lots?: number; pe_lots?: number; ce_ltp?: number; pe_ltp?: number;
  ce_avg_price?: number; pe_avg_price?: number;
  realized_pnl?: number; total_pnl?: number; spot?: number; adjustments?: number;
  profit_target?: number; stop_loss?: number; mode?: string; entry_type?: string;
  symbol?: string; interval?: string;
  active_spread?: string | null; short_symbol?: string | null; long_symbol?: string | null;
  short_strike?: number | null; long_strike?: number | null;
  short_ltp?: number; long_ltp?: number;
  in_position?: boolean; position_type?: string; sold_strike?: number | null;
  entry_pcr?: number; exit_pcr_level?: number; avg_price?: number;
  current_ltp?: number; direction?: string; oi_diff?: number; pcr_threshold?: number;
  ce_active?: boolean; pe_active?: boolean; ce_sl?: number; pe_sl?: number;
  leg_sl_pct?: number;
  // Combined-premium trailing SL
  trail_active?: boolean; trail_start_pct?: number; trail_gap_pts?: number;
  entry_combined_pts?: number; best_combined_pts?: number; trail_exit_combined?: number | null;
  use_ema?: boolean; use_supertrend?: boolean;
  // CrudeOil Mini Supertrend
  entry_price?: number; st_level?: number; daily_pnl?: number;
  expiry?: string; supertrend_period?: number; supertrend_multiplier?: number;
  ltp?: number; target_profit?: number; use_vwap?: boolean; vwap?: number;
  // CrudeOil Mini Renko SAR
  box_size?: number; reverse_bricks?: number; brick_count?: number;
  last_brick_color?: string; consecutive_opposite?: number; qty?: number;
  // ST+OI Bear Call Spread
  phase?: string; index_interval?: string; option_interval?: string;
  index_st_period?: number; index_st_multiplier?: number;
  option_st_period?: number; option_st_multiplier?: number;
  candidate_strike?: number | null; candidate_symbol?: string | null;
  watching_since?: string | null; index_st_dir?: number | null; option_st_dir?: number | null;
  ce_price_change_pct?: number | null; ce_oi_change_pct?: number | null;
  require_short_buildup?: boolean;
  min_price_drop_pct?: number; min_oi_rise_pct?: number;
}

interface Props { meta: StrategyMeta; state: StrategyState; onRefresh: () => void }

function StrategyRowWide({ meta, state, onRefresh }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmTimeoutId, setConfirmTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // --- Config state (mirrors StrategyCard) ---
  const [isLive, setIsLive] = useState(false);
  const [lots, setLots] = useState(1);
  const [profitTarget, setProfitTarget] = useState('4000');
  const [stopLoss, setStopLoss] = useState('4000');
  const [startTime, setStartTime] = useState('09:20');
  const [maxLots, setMaxLots] = useState(4);
  const [mode, setMode] = useState('winner_roll_atm');
  const [loserRatioLots, setLoserRatioLots] = useState(1);
  const [thresholdLot, setThresholdLot] = useState(25.0);
  const [entryType, setEntryType] = useState('strangle');
  const [strikeSelection, setStrikeSelection] = useState('distance');
  const [ceOffset, setCeOffset] = useState(200);
  const [peOffset, setPeOffset] = useState(200);
  const [targetDelta, setTargetDelta] = useState(0.20);
  const [targetPremium, setTargetPremium] = useState(50.0);
  const [entryBalanceThreshold, setEntryBalanceThreshold] = useState(15.0);
  const [entryBand, setEntryBand] = useState(5.0);
  const [declineTicks, setDeclineTicks] = useState(5);
  const [exitBuffer, setExitBuffer] = useState(10.0);
  const [maxPremiumDiff, setMaxPremiumDiff] = useState(15.0);
  const [vwapWarmupBars, setVwapWarmupBars] = useState(10);
  const [pcrThreshold, setPcrThreshold] = useState(1.5);
  const [exitPcrChange, setExitPcrChange] = useState(30);
  const [pollInterval, setPollInterval] = useState(60);
  const [expansionWindow, setExpansionWindow] = useState(3);
  const [legSlPct, setLegSlPct] = useState(0.20);
  const [trailStartPct, setTrailStartPct] = useState(5.0);
  const [trailGapPts, setTrailGapPts] = useState(15.0);
  const [symbol, setSymbol] = useState('NIFTY');
  const [interval, setIntervalVal] = useState('5');
  const [spreadWidth, setSpreadWidth] = useState(100);
  const [emaPeriod, setEmaPeriod] = useState(20);
  const [supertrendPeriod, setSupertrendPeriod] = useState(7);
  const [supertrendMultiplier, setSupertrendMultiplier] = useState(3.0);
  const [exitOnSignalChange, setExitOnSignalChange] = useState(true);
  const [eodTime, setEodTime] = useState('15:15');
  const [cooldownMinutes, setCooldownMinutes] = useState(5);
  const [useEma, setUseEma] = useState(true);
  const [useSupertrend, setUseSupertrend] = useState(true);
  // CrudeOil Mini Supertrend
  const [crudeoilInterval, setCrudeoilInterval] = useState('5');
  const [crudeoilStPeriod, setCrudeoilStPeriod] = useState(7);
  const [crudeoilStMultiplier, setCrudeoilStMultiplier] = useState(3.0);
  const [crudeoilStartTime, setCrudeoilStartTime] = useState('09:00');
  const [crudeoilEodTime, setCrudeoilEodTime] = useState('23:30');
  const [crudeoilUseVwap, setCrudeoilUseVwap] = useState(false);
  // CrudeOil Mini Renko SAR (shares crudeoilInterval/StartTime/EodTime above)
  const [renkoQty, setRenkoQty] = useState(10);
  const [renkoBoxSize, setRenkoBoxSize] = useState(5);
  const [renkoReverseBricks, setRenkoReverseBricks] = useState(3);
  // ST+OI Bear Call Spread
  const [indexInterval, setIndexInterval] = useState('3');
  const [indexStPeriod, setIndexStPeriod] = useState(10);
  const [indexStMultiplier, setIndexStMultiplier] = useState(2.0);
  const [optionInterval, setOptionInterval] = useState('3');
  const [optionStPeriod, setOptionStPeriod] = useState(10);
  const [optionStMultiplier, setOptionStMultiplier] = useState(2.0);
  const [stOiCeOffset, setStOiCeOffset] = useState(100);
  const [stOiSpreadWidth, setStOiSpreadWidth] = useState(100);
  const [requireShortBuildup, setRequireShortBuildup] = useState(false);
  const [minPriceDropPct, setMinPriceDropPct] = useState(-0.5);
  const [minOiRisePct, setMinOiRisePct] = useState(5.0);
  const [stOiPollInterval, setStOiPollInterval] = useState(30);
  const [maxWaitMinutes, setMaxWaitMinutes] = useState(45);
  const [stOiEodTime, setStOiEodTime] = useState('15:15');
  const [stOiCooldownMinutes, setStOiCooldownMinutes] = useState(5);
  const [exitOnSignalFlip, setExitOnSignalFlip] = useState(true);
  const [exitOnOptionStFlip, setExitOnOptionStFlip] = useState(true);

  const spreadTrendNoIndicators = meta.key === 'nifty_spread_trend' && !useEma && !useSupertrend;

  const isRunning = state.status !== 'STOPPED';
  const pnl = state.total_pnl ?? 0;
  const isPnlPositive = pnl >= 0;

  useEffect(() => {
    if (!isRunning && submitting) setSubmitting(false);
  }, [isRunning]);

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
        if (mode !== 'reentry_straddle') args.push('--max-lots', String(maxLots));
        const effectiveEntryType = mode === 'reentry_straddle' ? 'straddle' : entryType;
        args.push('--mode', mode, '--entry-type', effectiveEntryType, '--start-time', startTime);
        if (mode === 'loser_ratio_roll') args.push('--loser-ratio-lots', String(loserRatioLots));
        if (mode === 'winner_roll_atm') args.push('--threshold-lot', String(thresholdLot));
        if (mode === 'reentry_straddle') {
          args.push('--leg-sl-pct', String(legSlPct));
        }
        if (effectiveEntryType === 'strangle') {
          if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
          else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
          else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        }
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
      if (data.success) { setTimeout(onRefresh, 1500); }
      else { setStartError(data.error || 'Failed to stop'); setSubmitting(false); }
    } catch (e) {
      setStartError(`Network error: ${e}`);
      setSubmitting(false);
    }
  };

  const STATUS_MAP: Record<string, { dot: string; text: string; badge: string }> = {
    RUNNING:      { dot: 'bg-emerald-400', text: 'text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    MONITORING:   { dot: 'bg-sky-400',     text: 'text-sky-400',     badge: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
    BALANCING:    { dot: 'bg-sky-400',     text: 'text-sky-400',     badge: 'bg-sky-500/10 text-sky-400 border-sky-500/20' },
    SCANNING:     { dot: 'bg-indigo-400',  text: 'text-indigo-400',  badge: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
    WATCHING:     { dot: 'bg-violet-400',  text: 'text-violet-400',  badge: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
    INITIALIZING: { dot: 'bg-amber-400',   text: 'text-amber-400',   badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  };
  const statusCfg = STATUS_MAP[state.status];

  const lbl = 'text-[9px] text-zinc-300 uppercase tracking-wider font-semibold leading-none mb-0.5';
  const val = 'font-mono font-bold text-xs text-white leading-tight';
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

  /* ── LIVE STATS CELLS ─────────────────────────────────────── */
  const liveStats = () => {
    if (meta.key === 'nifty_oi_directional') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          {state.spot != null && (
            <div className="px-3 flex flex-col justify-center shrink-0">
              <div className={lbl}>Spot</div>
              <div className={val}>{state.spot.toFixed(1)}</div>
            </div>
          )}
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Direction</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.direction === 'BULLISH' ? 'text-emerald-400' : state.direction === 'BEARISH' ? 'text-rose-400' : 'text-zinc-400'}`}>
              {state.direction || '—'}
            </div>
            <div className="text-[9px] text-zinc-300 font-mono">Δ{state.oi_diff != null ? (state.oi_diff > 0 ? '+' : '') + state.oi_diff.toFixed(0) : '—'}</div>
          </div>
          <div className="px-3 flex flex-col justify-center min-w-[110px]">
            <div className={lbl}>Position</div>
            {state.in_position && state.sold_strike ? (
              <>
                <div className={`font-mono font-bold text-xs ${state.position_type === 'PE_SELL' ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {state.sold_strike} {state.position_type?.replace('_SELL', '') ?? ''}
                </div>
                <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">avg ₹{state.avg_price?.toFixed(1) ?? '—'} · ₹{state.current_ltp?.toFixed(1) ?? '—'}</div>
              </>
            ) : (
              <div className="text-xs font-mono text-zinc-600">FLAT</div>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>PCR</div>
            <div className={val}>{state.entry_pcr ? state.entry_pcr.toFixed(3) : '—'}</div>
            {state.exit_pcr_level && <div className="text-[9px] text-zinc-300 font-mono">exit @{state.exit_pcr_level.toFixed(3)}</div>}
          </div>
        </div>
      );
    }

    if (meta.key === 'crudeoilm_supertrend') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Direction</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.direction === 'LONG' ? 'text-emerald-400' : state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'}`}>
              {state.direction || 'NONE'}
            </div>
            {state.expiry && <div className="text-[9px] text-zinc-500 font-mono">{state.expiry}</div>}
          </div>
          <div className="px-3 flex flex-col justify-center min-w-[110px]">
            <div className={lbl}>Entry / LTP</div>
            {state.direction && state.direction !== 'NONE' ? (
              <>
                <div className={val}>{state.ltp != null ? state.ltp.toFixed(2) : '—'}</div>
                <div className="text-[9px] text-zinc-400 font-mono whitespace-nowrap">avg ₹{state.entry_price?.toFixed(2) ?? '—'}</div>
              </>
            ) : (
              <div className="text-xs font-mono text-zinc-600">—</div>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>ST SL</div>
            <div className="font-mono font-bold text-xs text-amber-400 leading-tight">
              {state.st_level != null && state.st_level > 0 ? state.st_level.toFixed(2) : '—'}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono">
              {state.interval ? `${state.interval}m ST(${state.supertrend_period ?? 7},${state.supertrend_multiplier ?? 3})${state.use_vwap ? ' +VWAP' : ''}` : ''}
            </div>
            {state.use_vwap && state.vwap != null && state.vwap > 0 && (
              <div className="text-[9px] text-sky-400 font-mono">VWAP {state.vwap.toFixed(2)}</div>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Day P&amp;L</div>
            <div className={`font-mono font-bold text-xs leading-tight ${(state.daily_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {(state.daily_pnl ?? 0) >= 0 ? '+' : ''}₹{(state.daily_pnl ?? 0).toFixed(0)}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
              tgt ₹{state.target_profit?.toFixed(0) ?? '—'} · sl ₹{state.stop_loss?.toFixed(0) ?? '—'}
            </div>
          </div>
        </div>
      );
    }

    if (meta.key === 'crudeoilm_renko_sar') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Direction</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.direction === 'LONG' ? 'text-emerald-400' : state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'}`}>
              {state.direction || 'NONE'}
            </div>
            {state.expiry && <div className="text-[9px] text-zinc-500 font-mono">{state.expiry}</div>}
          </div>
          <div className="px-3 flex flex-col justify-center min-w-[110px]">
            <div className={lbl}>Entry / LTP</div>
            {state.direction && state.direction !== 'NONE' ? (
              <>
                <div className={val}>{state.ltp != null ? state.ltp.toFixed(2) : '—'}</div>
                <div className="text-[9px] text-zinc-400 font-mono whitespace-nowrap">avg ₹{state.entry_price?.toFixed(2) ?? '—'} · qty {state.qty ?? '—'}</div>
              </>
            ) : (
              <div className="text-xs font-mono text-zinc-600">—</div>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Renko</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.last_brick_color === 'GREEN' ? 'text-emerald-400' : state.last_brick_color === 'RED' ? 'text-rose-400' : 'text-zinc-500'}`}>
              {state.last_brick_color || '—'}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
              {state.interval ?? 5}m · box {state.box_size ?? 5} · opp {state.consecutive_opposite ?? 0}/{state.reverse_bricks ?? 3}
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Day P&amp;L</div>
            <div className={`font-mono font-bold text-xs leading-tight ${(state.daily_pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {(state.daily_pnl ?? 0) >= 0 ? '+' : ''}₹{(state.daily_pnl ?? 0).toFixed(0)}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
              {state.brick_count ?? 0} bricks
            </div>
          </div>
        </div>
      );
    }

    if (meta.key === 'nifty_spread_trend') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Spread</div>
            <div className="font-mono font-bold text-xs text-sky-400">{state.active_spread || '—'}</div>
            <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
              S:{state.short_strike || '-'} · L:{state.long_strike || '-'}
            </div>
            <div className="flex gap-1 mt-0.5">
              {(state.use_ema !== false) && (
                <span className="text-[9px] font-bold px-1 rounded bg-indigo-500/15 text-indigo-400">EMA</span>
              )}
              {(state.use_supertrend !== false) && (
                <span className="text-[9px] font-bold px-1 rounded bg-violet-500/15 text-violet-400">ST</span>
              )}
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Short LTP</div>
            <div className={val}>₹{state.short_ltp?.toFixed(1) ?? '—'}</div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Long LTP</div>
            <div className={val}>₹{state.long_ltp?.toFixed(1) ?? '—'}</div>
          </div>
        </div>
      );
    }

    if (meta.key === 'nifty_st_oi_bearcall') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Phase</div>
            <div className={`font-mono font-bold text-xs leading-tight ${
              state.phase === 'ENTERED' ? 'text-emerald-400' :
              state.phase === 'WATCHING' ? 'text-violet-400' : 'text-zinc-500'
            }`}>
              {state.phase || 'IDLE'}
            </div>
            {state.spot != null && state.spot > 0 && (
              <div className="text-[9px] text-zinc-500 font-mono">spot {state.spot.toFixed(1)}</div>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center min-w-[110px]">
            {state.phase === 'ENTERED' ? (
              <>
                <div className={lbl}>Spread</div>
                <div className="font-mono font-bold text-xs text-sky-400">S:{state.short_strike || '-'} · L:{state.long_strike || '-'}</div>
                <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
                  {state.short_ltp != null ? `₹${state.short_ltp.toFixed(1)}` : '—'} / {state.long_ltp != null ? `₹${state.long_ltp.toFixed(1)}` : '—'}
                </div>
              </>
            ) : (
              <>
                <div className={lbl}>Candidate</div>
                <div className="font-mono font-bold text-xs text-amber-400">{state.candidate_strike ? `${state.candidate_strike} CE` : '—'}</div>
                <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
                  idxST {state.index_st_dir === -1 ? 'BEAR' : state.index_st_dir === 1 ? 'BULL' : '—'} · optST {state.option_st_dir === -1 ? 'BEAR' : state.option_st_dir === 1 ? 'BULL' : '—'}
                </div>
              </>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Short Buildup</div>
            {state.require_short_buildup ? (
              <>
                <div className="font-mono font-bold text-xs text-zinc-200 leading-tight">
                  {state.ce_price_change_pct != null ? `${state.ce_price_change_pct.toFixed(1)}%` : '—'} / {state.ce_oi_change_pct != null ? `+${state.ce_oi_change_pct.toFixed(1)}%` : '—'}
                </div>
                <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
                  need ≤{state.min_price_drop_pct ?? -0.5}% / ≥{state.min_oi_rise_pct ?? 5.0}%
                </div>
              </>
            ) : (
              <div className="text-xs font-mono text-zinc-600">Disabled</div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-stretch divide-x divide-zinc-800/60">
        {state.spot != null && state.spot > 0 && (
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Spot</div>
            <div className={val}>{state.spot.toFixed(1)}</div>
          </div>
        )}
        <div className="px-3 flex flex-col justify-center min-w-[100px]">
          <div className={lbl}>CE</div>
          <div className="font-mono font-bold text-xs text-emerald-400 leading-tight">
            {state.ce_strike || '—'}
            {state.mode === 'reentry_straddle' && state.ce_active != null && (
              <span className={`ml-1 text-[8px] font-bold px-1 rounded ${state.ce_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                {state.ce_active ? 'L' : 'R'}
              </span>
            )}
          </div>
          <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
            {state.ce_lots ?? 0}L{state.ce_ltp != null ? ` ₹${state.ce_ltp.toFixed(0)}` : ''}
          </div>
          {state.mode === 'reentry_straddle' && state.ce_sl != null && state.ce_sl > 0 && (
            <div className="text-[9px] text-rose-400 font-mono">SL ₹{state.ce_sl.toFixed(0)}</div>
          )}
        </div>
        <div className="px-3 flex flex-col justify-center min-w-[100px]">
          <div className={lbl}>PE</div>
          <div className="font-mono font-bold text-xs text-rose-400 leading-tight">
            {state.pe_strike || '—'}
            {state.mode === 'reentry_straddle' && state.pe_active != null && (
              <span className={`ml-1 text-[8px] font-bold px-1 rounded ${state.pe_active ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                {state.pe_active ? 'L' : 'R'}
              </span>
            )}
          </div>
          <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
            {state.pe_lots ?? 0}L{state.pe_ltp != null ? ` ₹${state.pe_ltp.toFixed(0)}` : ''}
          </div>
          {state.mode === 'reentry_straddle' && state.pe_sl != null && state.pe_sl > 0 && (
            <div className="text-[9px] text-rose-400 font-mono">SL ₹{state.pe_sl.toFixed(0)}</div>
          )}
        </div>
        <div className="px-3 flex flex-col justify-center shrink-0">
          <div className={lbl}>Adj</div>
          <div className={val}>{state.adjustments ?? 0}</div>
          {state.max_lots != null && state.mode !== 'reentry_straddle' && <div className="text-[9px] text-zinc-300 font-mono">max {state.max_lots}L</div>}
          {state.threshold_lot != null && state.mode === 'winner_roll_atm' && <div className="text-[9px] text-zinc-300 font-mono">thresh {state.threshold_lot}%</div>}
        </div>
        {state.entry_combined_pts != null && state.entry_combined_pts > 0 && (
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Trail SL</div>
            {state.trail_active ? (
              <>
                <div className="font-mono font-bold text-[10px] text-amber-400">ACTIVE</div>
                <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
                  best {state.best_combined_pts?.toFixed(1)} · exit@{state.trail_exit_combined?.toFixed(1) ?? '—'}
                </div>
              </>
            ) : (
              <>
                <div className="font-mono text-[10px] text-zinc-500">inactive</div>
                <div className="text-[9px] text-zinc-600 font-mono whitespace-nowrap">
                  entry {state.entry_combined_pts.toFixed(1)}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ── CONFIG PANEL ─────────────────────────────────────────── */
  const configPanel = (
    <div className="border-t border-zinc-800/60 px-4 py-3 bg-zinc-950/60">
      <div className="flex flex-wrap gap-2.5 text-xs">
        <div className={fieldCls}>
          <FieldLabel text="Execution" tip="Dry run (default) only simulates/logs orders. LIVE places real broker orders." />
          <div className="flex items-center gap-2 h-7">
            <input type="checkbox" id={`live-${meta.key}`} checked={isLive} onChange={e => setIsLive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
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
            <Input type="number" value={renkoQty} onChange={e => setRenkoQty(parseInt(e.target.value) || 10)} min={1} step={1} className={inputCls} style={{ width: 72 }} />
          </div>
        ) : (
          <div className={fieldCls}>
            <FieldLabel text="Lots" tip="Number of lot-sized units traded per leg at entry (multiplied by the instrument's live lot size)." />
            <Input type="number" value={lots} onChange={e => setLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
          </div>
        )}

        {(meta.key === 'nifty_value_imbalance_straddle' || meta.key === 'nifty_value_imbalance_strangle' ||
          (meta.key === 'nifty_advanced_imbalance' && mode !== 'reentry_straddle')) && (
          <div className={fieldCls}>
            <FieldLabel text="Max Lots" tip="Maximum lots per leg reached via lot averaging/rolling before a strike shift is triggered." />
            <Input type="number" value={maxLots} onChange={e => setMaxLots(parseInt(e.target.value) || 4)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
          </div>
        )}

        {meta.key === 'nifty_advanced_imbalance' && mode === 'winner_roll_atm' && (
          <div className={fieldCls}>
            <FieldLabel text="Threshold Lot %" tip="Base premium imbalance % (added to the post-entry/post-roll baseline offset) that triggers a winner-roll adjustment." />
            <Input type="number" value={thresholdLot} onChange={e => setThresholdLot(parseFloat(e.target.value) || 25.0)} min={1} step={0.5} className={inputCls} style={{ width: 64 }} />
          </div>
        )}

        {meta.key !== 'nifty_spread_trend' && meta.key !== 'crudeoilm_supertrend' && meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'nifty_st_oi_bearcall' && (
          <div className={fieldCls}>
            <FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins monitoring for entries." />
            <Input type="text" value={startTime} onChange={e => setStartTime(e.target.value)} placeholder="09:20" className={inputCls} style={{ width: 72 }} />
          </div>
        )}

        {meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR; strategy squares off and stops once reached." />
              <Input type="number" value={profitTarget} onChange={e => setProfitTarget(e.target.value || '1000')} className={inputCls} style={{ width: 80 }} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR; strategy squares off and stops once breached." />
              <Input type="number" value={stopLoss} onChange={e => setStopLoss(e.target.value || '1000')} className={inputCls} style={{ width: 80 }} />
            </div>
          </>
        )}

        {meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR, or a percentage of entry premium collected e.g. '20%'; strategy squares off and stops once reached." />
              <Input type="text" inputMode="decimal" value={profitTarget} onChange={e => setProfitTarget(e.target.value)} placeholder="4000 or 20%" className={inputCls} style={{ width: 80 }} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR, or a percentage of entry premium collected e.g. '20%'; strategy squares off and stops once breached." />
              <Input type="text" inputMode="decimal" value={stopLoss} onChange={e => setStopLoss(e.target.value)} placeholder="4000 or 20%" className={inputCls} style={{ width: 80 }} />
            </div>
          </>
        )}

        {meta.key === 'nifty_spread_trend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Symbol" tip="Underlying index traded (NIFTY or BANKNIFTY)." />
              <Select value={symbol} onValueChange={v => v && setSymbol(v)}>
                <SelectTrigger className={inputCls} style={{ width: 110 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NIFTY">NIFTY</SelectItem>
                  <SelectItem value="BANKNIFTY">BANKNIFTY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Candle interval in minutes used for the EMA/Supertrend trend signal." />
              <Select value={interval} onValueChange={v => v && setIntervalVal(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['1','5','15','30','60'].map(v => <SelectItem key={v} value={v}>{v === '60' ? '1 Hr' : `${v} Min`}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="Spread (pts)" tip="Point gap between the short strike and the long hedge strike." /><Input type="number" value={spreadWidth} onChange={e => setSpreadWidth(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="CE Offset" tip="Points above spot for the short Call strike." /><Input type="number" value={ceOffset} onChange={e=>setCeOffset(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="PE Offset" tip="Points below spot for the short Put strike." /><Input type="number" value={peOffset} onChange={e=>setPeOffset(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input type="checkbox" id={`use-ema-${meta.key}`} checked={useEma} onChange={e => setUseEma(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`use-ema-${meta.key}`} title="Enables the EMA trend filter; EMA and Supertrend must both agree to trade unless disabled" className={lbl}>EMA</label>
              </div>
              {useEma && <Input type="number" value={emaPeriod} onChange={e=>setEmaPeriod(parseInt(e.target.value)||20)} className={inputCls} style={{width:64}} placeholder="Period" title="EMA lookback period (bars)"/>}
            </div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input type="checkbox" id={`use-st-${meta.key}`} checked={useSupertrend} onChange={e => setUseSupertrend(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`use-st-${meta.key}`} title="Enables the Supertrend trend filter; EMA and Supertrend must both agree to trade unless disabled" className={lbl}>Supertrend</label>
              </div>
              {useSupertrend && <>
                <Input type="number" value={supertrendPeriod} onChange={e=>setSupertrendPeriod(parseInt(e.target.value)||7)} className={inputCls} style={{width:64}} placeholder="Period" title="ATR lookback length for the Supertrend"/>
                <Input type="number" step="0.5" value={supertrendMultiplier} onChange={e=>setSupertrendMultiplier(parseFloat(e.target.value)||3.0)} className={inputCls} style={{width:64}} placeholder="Multi" title="ATR multiplier controlling the Supertrend band width"/>
              </>}
            </div>
            {spreadTrendNoIndicators && (
              <div className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-400 font-medium">
                Enable at least one indicator to launch.
              </div>
            )}
            <div className={fieldCls}><FieldLabel text="EOD Time" tip="Time (HH:MM IST) positions are auto-squared-off for the day." /><Input type="text" value={eodTime} onChange={e=>setEodTime(e.target.value)} placeholder="15:15" className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Cooldown (min)" tip="Minutes to wait after a standard exit before a new entry is allowed." /><Input type="number" value={cooldownMinutes} onChange={e=>setCooldownMinutes(parseInt(e.target.value)||5)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Signal" tip="If enabled, exits early when the EMA/Supertrend trend reverses instead of holding to SL/target/EOD." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`exit-sig-${meta.key}`} checked={exitOnSignalChange} onChange={e=>setExitOnSignalChange(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`exit-sig-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
          </>
        )}

        {meta.key === 'nifty_st_oi_bearcall' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Index Timeframe" tip="Candle interval (minutes) for the index's own Supertrend, resampled from 1-min data." />
              <Select value={indexInterval} onValueChange={v => v && setIndexInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="Index ST Period" tip="ATR lookback length for the index Supertrend." /><Input type="number" value={indexStPeriod} onChange={e => setIndexStPeriod(parseInt(e.target.value) || 10)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Index ST Multi" tip="ATR multiplier for the index Supertrend band width." /><Input type="number" step="0.5" value={indexStMultiplier} onChange={e => setIndexStMultiplier(parseFloat(e.target.value) || 2.0)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="Option Timeframe" tip="Candle interval (minutes) for the candidate option's own Supertrend." />
              <Select value={optionInterval} onValueChange={v => v && setOptionInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="Option ST Period" tip="ATR lookback length for the candidate option's own Supertrend." /><Input type="number" value={optionStPeriod} onChange={e => setOptionStPeriod(parseInt(e.target.value) || 10)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Option ST Multi" tip="ATR multiplier for the option's own Supertrend band width." /><Input type="number" step="0.5" value={optionStMultiplier} onChange={e => setOptionStMultiplier(parseFloat(e.target.value) || 2.0)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="CE Offset" tip="Fixed points above ATM used to lock the candidate short CE strike." /><Input type="number" value={stOiCeOffset} onChange={e => setStOiCeOffset(parseInt(e.target.value) || 100)} className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="Spread (pts)" tip="Point gap between the short CE and the long hedge CE strike." /><Input type="number" value={stOiSpreadWidth} onChange={e => setStOiSpreadWidth(parseInt(e.target.value) || 100)} className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input type="checkbox" id={`require-buildup-${meta.key}`} checked={requireShortBuildup} onChange={e => setRequireShortBuildup(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`require-buildup-${meta.key}`} title="Also requires price-down + OI-up confirmation on the candidate strike before entry" className={lbl}>Require Buildup</label>
              </div>
            </div>
            {requireShortBuildup && (
              <>
                <div className={fieldCls}><FieldLabel text="Min Price Drop %" tip="Max allowed CE price change vs previous close for short-buildup confirmation." /><Input type="number" step="0.1" value={minPriceDropPct} onChange={e => setMinPriceDropPct(parseFloat(e.target.value) || -0.5)} className={inputCls} style={{ width: 72 }} /></div>
                <div className={fieldCls}><FieldLabel text="Min OI Rise %" tip="Min required CE OI change vs previous OI for short-buildup confirmation." /><Input type="number" step="0.5" value={minOiRisePct} onChange={e => setMinOiRisePct(parseFloat(e.target.value) || 5.0)} className={inputCls} style={{ width: 72 }} /></div>
              </>
            )}
            <div className={fieldCls}><FieldLabel text="Poll Interval (s)" tip="Seconds between checks while watching for the option's own Supertrend to turn bearish." /><Input type="number" value={stOiPollInterval} onChange={e => setStOiPollInterval(parseInt(e.target.value) || 30)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Max Wait (min)" tip="Abandons a watch cycle and resets if no entry occurs within this many minutes of locking a candidate strike." /><Input type="number" value={maxWaitMinutes} onChange={e => setMaxWaitMinutes(parseInt(e.target.value) || 45)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="EOD Time" tip="Time (HH:MM IST) positions are auto-squared-off for the day." /><Input type="text" value={stOiEodTime} onChange={e => setStOiEodTime(e.target.value)} placeholder="15:15" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="Cooldown (min)" tip="Minutes to wait after an exit or abandoned watch cycle before scanning again." /><Input type="number" value={stOiCooldownMinutes} onChange={e => setStOiCooldownMinutes(parseInt(e.target.value) || 5)} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Index ST" tip="If enabled, exits early if the index Supertrend flips back bullish." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`exit-idx-st-${meta.key}`} checked={exitOnSignalFlip} onChange={e => setExitOnSignalFlip(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`exit-idx-st-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit on Option ST" tip="If enabled, exits early if the short option's own Supertrend flips back bullish." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`exit-opt-st-${meta.key}`} checked={exitOnOptionStFlip} onChange={e => setExitOnOptionStFlip(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`exit-opt-st-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
          </>
        )}

        {meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Candle interval in minutes used for the Supertrend signal." />
              <Select value={crudeoilInterval} onValueChange={v => v && setCrudeoilInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="ST Period" tip="ATR lookback length for the Supertrend." /><Input type="number" value={crudeoilStPeriod} onChange={e => setCrudeoilStPeriod(parseInt(e.target.value) || 7)} min={2} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="ST Multiplier" tip="ATR multiplier for the Supertrend band width; becomes the trailing stop level." /><Input type="number" step="0.5" value={crudeoilStMultiplier} onChange={e => setCrudeoilStMultiplier(parseFloat(e.target.value) || 3.0)} min={0.5} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins monitoring for entries." /><Input type="text" value={crudeoilStartTime} onChange={e => setCrudeoilStartTime(e.target.value)} placeholder="09:00" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="EOD Time" tip="Time (HH:MM IST) the position is flattened for the day." /><Input type="text" value={crudeoilEodTime} onChange={e => setCrudeoilEodTime(e.target.value)} placeholder="23:25" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="VWAP Filter" tip="Uses session VWAP as an additional exit signal alongside the Supertrend trail." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`vwap-${meta.key}`} checked={crudeoilUseVwap} onChange={e => setCrudeoilUseVwap(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`vwap-${meta.key}`} className="text-zinc-300 text-xs">Require above/below VWAP</label>
              </div>
            </div>
          </>
        )}

        {meta.key === 'crudeoilm_renko_sar' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Source candle interval (minutes) used to build the Renko brick series." />
              <Select value={crudeoilInterval} onValueChange={v => v && setCrudeoilInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="Brick Size (pts)" tip="Point size of each Renko brick." /><Input type="number" step="0.5" value={renkoBoxSize} onChange={e => setRenkoBoxSize(parseFloat(e.target.value) || 5)} min={0.5} className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="Reverse Bricks" tip="Consecutive opposite-colored bricks required to flip the held position." /><Input type="number" value={renkoReverseBricks} onChange={e => setRenkoReverseBricks(parseInt(e.target.value) || 3)} min={1} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins trading." /><Input type="text" value={crudeoilStartTime} onChange={e => setCrudeoilStartTime(e.target.value)} placeholder="09:00" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="EOD Time" tip="Time (HH:MM IST) the position is flattened for the day (otherwise always-in)." /><Input type="text" value={crudeoilEodTime} onChange={e => setCrudeoilEodTime(e.target.value)} placeholder="23:30" className={inputCls} style={{ width: 72 }} /></div>
          </>
        )}

        {meta.key === 'nifty_oi_directional' && (
          <>
            <div className={fieldCls}><FieldLabel text="PCR Threshold" tip="PCR level above which a PE is sold (bullish); CE entry threshold is the reciprocal (1/X)." /><Input type="number" step="0.1" value={pcrThreshold} onChange={e=>setPcrThreshold(parseFloat(e.target.value)||1.5)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Exit PCR Chg%" tip="% change in the held strike's PCR from its entry level that triggers an exit." /><Input type="number" value={exitPcrChange} onChange={e=>setExitPcrChange(parseInt(e.target.value)||30)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Poll (s)" tip="Seconds between option-chain/OI snapshot fetches." /><Input type="number" value={pollInterval} onChange={e=>setPollInterval(parseInt(e.target.value)||60)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><FieldLabel text="Exp Window" tip="Number of OI snapshots required before a direction is trusted and entries are allowed." /><Input type="number" value={expansionWindow} onChange={e=>setExpansionWindow(parseInt(e.target.value)||3)} className={inputCls} style={{width:64}}/></div>
          </>
        )}

        {meta.key === 'nifty_value_imbalance_straddle' && (
          <div className={fieldCls}><FieldLabel text="Bal Threshold%" tip="Max CE/PE premium difference allowed at entry; trade only enters when imbalance is below this." /><Input type="number" step="0.5" value={entryBalanceThreshold} onChange={e=>setEntryBalanceThreshold(parseFloat(e.target.value)||15.0)} className={inputCls} style={{width:80}}/></div>
        )}

        {meta.key === 'nifty_vwap_1min_straddle' && (
          <>
            <div className={fieldCls}><FieldLabel text="Entry Band" tip="Max points above the straddle's VWAP at which entry is still allowed." /><Input type="number" step="0.5" value={entryBand} onChange={e=>setEntryBand(parseFloat(e.target.value)||5.0)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Decline Ticks" tip="Number of recent WebSocket ticks over which combined premium must be falling before entry." /><Input type="number" value={declineTicks} onChange={e=>setDeclineTicks(parseInt(e.target.value)||5)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><FieldLabel text="Exit Buffer" tip="Points above VWAP that trigger exit (buy back both legs); should stay ≥ Entry Band." /><Input type="number" step="0.5" value={exitBuffer} onChange={e=>setExitBuffer(parseFloat(e.target.value)||10.0)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Max Prem Diff%" tip="Max allowed % difference between CE and PE premiums for entry to be considered balanced." /><Input type="number" step="0.5" value={maxPremiumDiff} onChange={e=>setMaxPremiumDiff(parseFloat(e.target.value)||15.0)} className={inputCls} style={{width:80}}/></div>
            <div className={fieldCls}><FieldLabel text="Warmup (bars)" tip="Minimum completed 1-min bars required before VWAP is trusted for trade decisions." /><Input type="number" value={vwapWarmupBars} onChange={e=>setVwapWarmupBars(parseInt(e.target.value)||10)} className={inputCls} style={{width:80}}/></div>
          </>
        )}

        {meta.key === 'nifty_advanced_imbalance' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Mode" tip="Adjustment logic on imbalance: rolls/hedges/adds lots to the winning or losing leg, or runs independent per-leg re-entry." />
              <Select value={mode} onValueChange={v => v && setMode(v)}>
                <SelectTrigger className={inputCls} style={{ width: 160 }}><SelectValue /></SelectTrigger>
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
              <div className={fieldCls}><FieldLabel text="Ratio Lots" tip="Lots added to the rolled losing leg on each adjustment." /><Input type="number" value={loserRatioLots} onChange={e=>setLoserRatioLots(parseInt(e.target.value)||1)} min={1} max={20} className={inputCls} style={{width:64}}/></div>
            )}
            {mode === 'reentry_straddle' && (
              <div className={fieldCls}><FieldLabel text="Leg SL%" tip="Per-leg stop loss as a % of entry premium; only that leg exits and re-enters, the other keeps running." /><Input type="number" step="1" value={Math.round(legSlPct*100)} onChange={e=>setLegSlPct((parseInt(e.target.value)||20)/100)} min={1} max={100} className={inputCls} style={{width:64}}/></div>
            )}
            {mode !== 'reentry_straddle' && (
              <div className={fieldCls}>
                <FieldLabel text="Entry Type" tip="Sell an ATM straddle (CE+PE at spot) or an OTM strangle (offset CE/PE strikes)." />
                <Select value={entryType} onValueChange={v => v && setEntryType(v)}>
                  <SelectTrigger className={inputCls} style={{ width: 130 }}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="straddle">Straddle (ATM)</SelectItem>
                    <SelectItem value="strangle">Strangle (OTM)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </>
        )}

        {(meta.key === 'nifty_value_imbalance_strangle' ||
          (meta.key === 'nifty_advanced_imbalance' && entryType === 'strangle' && mode !== 'reentry_straddle')) && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Strike Selection" tip="How strangle strikes are chosen: fixed point distance, target option delta, or target premium value." />
              <Select value={strikeSelection} onValueChange={v => v && setStrikeSelection(v)}>
                <SelectTrigger className={inputCls} style={{ width: 120 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="distance">Fixed Offset</SelectItem>
                  <SelectItem value="delta">Delta Based</SelectItem>
                  <SelectItem value="premium">Target Premium</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {strikeSelection === 'distance' && (
              <>
                <div className={fieldCls}><FieldLabel text="CE Offset" tip="Points above spot for the Call strike." /><Input type="number" value={ceOffset} onChange={e=>setCeOffset(parseInt(e.target.value)||200)} className={inputCls} style={{width:72}}/></div>
                <div className={fieldCls}><FieldLabel text="PE Offset" tip="Points below spot for the Put strike." /><Input type="number" value={peOffset} onChange={e=>setPeOffset(parseInt(e.target.value)||200)} className={inputCls} style={{width:72}}/></div>
              </>
            )}
            {strikeSelection === 'delta' && (
              <div className={fieldCls}><FieldLabel text="Target Delta" tip="Target absolute option delta used to pick the CE/PE strikes." /><Input type="number" step="0.01" value={targetDelta} onChange={e=>setTargetDelta(parseFloat(e.target.value)||0.20)} className={inputCls} style={{width:72}}/></div>
            )}
            {strikeSelection === 'premium' && (
              <div className={fieldCls}><FieldLabel text="Target Prem ₹" tip="Target premium value used to pick the CE/PE strikes." /><Input type="number" value={targetPremium} onChange={e=>setTargetPremium(parseFloat(e.target.value)||50.0)} className={inputCls} style={{width:80}}/></div>
            )}
          </>
        )}

        {/* Combined-premium trailing SL */}
        {(meta.key === 'nifty_advanced_imbalance' ||
          meta.key === 'nifty_value_imbalance_straddle' ||
          meta.key === 'nifty_value_imbalance_strangle') && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Trail Start (%)" tip="Arms the trailing stop once profit reaches this % of entry combined premium." />
              <Input type="number" step="0.5" value={trailStartPct} onChange={e => setTrailStartPct(parseFloat(e.target.value) || 5.0)} min={0.5} className={inputCls} style={{ width: 72 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Trail Gap (pts)" tip="Once armed, exits if combined premium rises this many points above its lowest point since arming." />
              <Input type="number" step="0.5" value={trailGapPts} onChange={e => setTrailGapPts(parseFloat(e.target.value) || 15.0)} min={0.5} className={inputCls} style={{ width: 72 }} />
            </div>
          </>
        )}

        {/* Launch button inline in config */}
        <div className="flex items-end">
          <Button onClick={handleStart} disabled={submitting || spreadTrendNoIndicators}
            className="h-7 px-4 gap-1.5 bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold rounded-lg shadow-md shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-[0.98] transition-all text-xs border-0 disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-white" />}
            {submitting ? 'Launching…' : 'Launch'}
          </Button>
        </div>
      </div>

      {startError && (
        <div className="mt-2 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-rose-950/30 border border-rose-500/20 text-xs text-rose-400">
          <span className="truncate">{startError}</span>
          <button onClick={() => setStartError(null)} className="text-rose-500 hover:text-rose-300 font-bold shrink-0">×</button>
        </div>
      )}
    </div>
  );

  return (
    <div className={`border-b border-zinc-800/50 last:border-b-0 ${isRunning ? 'border-l-2 border-l-emerald-500/30 bg-emerald-950/5' : ''}`}>
      {/* ── Main row ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-0 min-h-[52px] px-4">

        {/* Status indicator */}
        <div className="w-[90px] shrink-0 flex items-center gap-1.5">
          {statusCfg ? (
            <Badge className={`gap-1 font-bold uppercase text-[9px] tracking-wide h-5 px-1.5 ${statusCfg.badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full bg-current animate-pulse`} />
              {state.status === 'INITIALIZING' ? 'Init' : state.status.charAt(0) + state.status.slice(1).toLowerCase()}
            </Badge>
          ) : (
            <Badge className="gap-1 font-bold uppercase text-[9px] tracking-wide h-5 px-1.5 bg-zinc-800/80 text-zinc-600 border-zinc-700/50">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
              Stopped
            </Badge>
          )}
        </div>

        {/* Name + mode/type tags */}
        <div className="w-[240px] shrink-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-bold text-white truncate">{meta.name}</span>
          </div>
          {isRunning && (
            <div className="flex items-center gap-1 flex-wrap">
              {state.mode && (
                <span className="text-[9px] font-mono text-indigo-400 bg-indigo-500/10 border border-indigo-500/20 px-1 rounded">
                  {state.mode.replace(/_/g, '-')}
                </span>
              )}
              {state.entry_type && (
                <span className="text-[9px] font-mono text-zinc-500 bg-zinc-800/60 border border-zinc-700/40 px-1 rounded capitalize">
                  {state.entry_type}
                </span>
              )}
              {state.dry_run && (
                <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1 rounded flex items-center gap-0.5">
                  <ShieldAlert className="h-2.5 w-2.5" />SIM
                </span>
              )}
              {state.pid && (
                <span className="text-[9px] text-zinc-500 font-mono">·{state.pid}</span>
              )}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-8 w-px bg-zinc-800/60 mx-2 shrink-0" />

        {/* Live stats OR placeholder */}
        <div className="flex-1 min-w-0 overflow-x-auto">
          {isRunning ? (
            liveStats()
          ) : (
            <span className="text-xs text-zinc-500 italic px-2">not running</span>
          )}
        </div>

        {/* P&L */}
        {isRunning && (
          <>
            <div className="h-8 w-px bg-zinc-800/60 mx-2 shrink-0" />
            <div className="shrink-0 flex flex-col items-end min-w-[80px]">
              <span className={`font-mono font-bold text-base leading-tight tabular-nums ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isPnlPositive ? '+' : ''}₹{pnl.toFixed(0)}
              </span>
              {state.realized_pnl !== undefined && state.realized_pnl !== 0 && (
                <span className="text-[9px] text-zinc-400 font-mono tabular-nums">real ₹{state.realized_pnl.toFixed(0)}</span>
              )}
            </div>
          </>
        )}

        {/* Action buttons */}
        <div className="h-8 w-px bg-zinc-800/60 mx-3 shrink-0" />
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning ? (
            <>
              <button onClick={handleStop} disabled={submitting}
                className={`h-7 px-3 rounded-md text-[11px] font-semibold border transition-all flex items-center gap-1 ${
                  submitting ? 'border-zinc-700 bg-zinc-900 text-zinc-500 cursor-not-allowed'
                  : confirmStop ? 'border-rose-500 bg-rose-500/20 text-rose-300 animate-pulse'
                  : 'border-red-500/25 bg-red-950/20 text-red-400 hover:bg-red-950/30 hover:border-red-500/40'
                }`}>
                {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-2.5 w-2.5 fill-current" />}
                {submitting ? 'Stopping…' : confirmStop ? 'Confirm?' : 'Stop'}
              </button>
              <button onClick={() => setShowLogs(!showLogs)}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-colors flex items-center gap-1 ${
                  showLogs ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-transparent border-zinc-800/60 text-zinc-400 hover:text-white hover:border-zinc-700'
                }`}>
                <Terminal className="h-3 w-3" />
                {showLogs ? 'Hide' : 'Logs'}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setShowConfig(!showConfig)}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-colors flex items-center gap-1 ${
                  showConfig ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-transparent border-zinc-800/60 text-zinc-400 hover:text-white hover:border-zinc-700'
                }`}>
                {showConfig ? <ChevronUp className="h-3 w-3" /> : <Settings className="h-3 w-3" />}
                Configure
              </button>
              <Button onClick={handleStart} disabled={submitting || spreadTrendNoIndicators}
                className="h-7 px-3 gap-1 bg-emerald-600/80 hover:bg-emerald-500/80 text-white font-bold rounded-md text-[11px] border-0 shadow-none active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
                <Play className="h-2.5 w-2.5 fill-white" />
                Launch
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Expanded sections ─────────────────────────────────────── */}
      {!isRunning && showConfig && configPanel}

      {isRunning && showLogs && (
        <div className="border-t border-zinc-800/60 px-4 py-3">
          <LogConsole strategyKey={meta.key} isActive={isRunning} />
        </div>
      )}

      {isRunning && startError && (
        <div className="border-t border-zinc-800/60 px-4 py-2 flex items-center justify-between gap-2 bg-rose-950/20">
          <span className="text-xs text-rose-400 truncate">{startError}</span>
          <button onClick={() => setStartError(null)} className="text-rose-500 hover:text-rose-300 font-bold text-sm shrink-0">×</button>
        </div>
      )}
    </div>
  );
}

// The /api/strategies poll rebuilds meta/state objects every 2s even when
// nothing changed, so identity comparison would re-render every row each
// tick. Compare by content instead (small objects; N is a handful of rows).
export default React.memo(StrategyRowWide, (prev, next) =>
  prev.onRefresh === next.onRefresh &&
  JSON.stringify(prev.meta) === JSON.stringify(next.meta) &&
  JSON.stringify(prev.state) === JSON.stringify(next.state)
);
