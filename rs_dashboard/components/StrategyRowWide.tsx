'use client';

import React, { useState, useEffect } from 'react';
import { Play, Square, Settings, ShieldAlert, Loader2, ChevronDown, ChevronUp, Terminal, RotateCcw } from 'lucide-react';
import LogConsole from './LogConsole';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { type Broker } from '@/hooks/useBrokerSelector';

interface StrategyMeta {
  key: string;
  name: string;
  underlying?: string;
  execBrokerEligible?: boolean;
}

// Dhan's intraday candle endpoint accepts only these. Anything else returns an API error →
// empty DataFrame, so the strategy would silently never see a candle. A dropdown rather than
// a free-text field keeps that failure mode unreachable.
const ORB_INTERVALS = ['1', '5', '15', '25', '60'] as const;

/** nifty_advanced_imbalance's argparse default for --max-lots, which reentry_straddle pins. */
const REENTRY_MAX_LOTS = 4;

interface StrategyState {
  strategy: string; status: string; pid?: number; dry_run?: boolean;
  lots?: number; max_lots?: number; threshold_lot?: number; threshold_strike?: number; scalp_floor_pct?: number; multi_cycle?: boolean; cycle_cooldown?: number; initial_combined_premium?: number; loser_ratio_lots?: number;
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
  // crudeoilm_orb — opening range + two-stage stop (stop_source: 'RANGE' | 'PIVOT' | 'NONE')
  orh?: number; orl?: number; range_locked?: boolean; or_minutes?: number;
  session_start?: string; stop_level?: number; stop_source?: string;
  taken_long?: boolean; taken_short?: boolean; pivot_n?: number; pivot_interval?: string;
  ce_active?: boolean; pe_active?: boolean; ce_sl?: number; pe_sl?: number;
  leg_sl_pct?: number;
  // Combined-premium trailing SL
  trail_active?: boolean; trail_start_rs?: number; trail_gap_rs?: number;
  best_pnl?: number; trail_exit_pnl?: number | null;
  use_ema?: boolean; use_supertrend?: boolean;
  // CrudeOil Mini Supertrend
  entry_price?: number; st_level?: number; daily_pnl?: number;
  expiry?: string; supertrend_period?: number; supertrend_multiplier?: number;
  ltp?: number; target_profit?: number; use_vwap?: boolean; vwap?: number;
  // CrudeOil Mini Renko SAR
  box_size?: number; reverse_bricks?: number; brick_count?: number;
  last_brick_color?: string; consecutive_opposite?: number; qty?: number;
  // CrudeOil Mini VWAP + Supertrend (also reuses entry_price/st_level/vwap/ltp/daily_pnl above)
  signal_close?: number; contract_size?: number; exposure_units?: number;
  allow_reverse?: boolean; exit_on_close?: boolean;
  // Anti-chop regime gate + per-trade stop (stop_level/stop_source shared with ORB above)
  regime?: string; regime_reason?: string; adx?: number; chop?: number;
  htf_st_dir?: number; htf_interval?: string; band_gap?: number;
  blocked_reason?: string; trades_today?: number; max_trades_per_day?: number;
  loss_streak?: number;
  // ST+OI Bear Call Spread
  phase?: string; index_interval?: string; option_interval?: string;
  index_st_period?: number; index_st_multiplier?: number;
  option_st_period?: number; option_st_multiplier?: number;
  candidate_strike?: number | null; candidate_symbol?: string | null;
  watching_since?: string | null; index_st_dir?: number | null; option_st_dir?: number | null;
  ce_price_change_pct?: number | null; ce_oi_change_pct?: number | null;
  require_short_buildup?: boolean;
  min_price_drop_pct?: number; min_oi_rise_pct?: number;
  // Rolling Short Straddle
  roll_type?: 'points' | 'percentage'; roll_buffer?: number; roll_trigger_pct?: number; ref_spot?: number; max_rolls?: number; roll_count?: number;
  current_atm?: number | null; upper_bound?: number | null; lower_bound?: number | null;
  broker?: string;
}

interface Props {
  meta: StrategyMeta; state: StrategyState; onRefresh: () => void; instanceId?: string;
  /** Only passed for the primary (no-instanceId) row — reveals a second, blank config row for a new concurrent run. */
  onAddInstance?: (strategyKey: string) => void;
  /** Only passed for duplicate rows — discards the stopped instance and its debug files. */
  onRemoveInstance?: (strategyKey: string, instanceId: string) => void;
  selectedBroker?: Broker;
}

function StrategyRowWide({ meta, state, onRefresh, instanceId, onAddInstance, onRemoveInstance, selectedBroker }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmTimeoutId, setConfirmTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetTimeoutId, setResetTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // --- Config state (mirrors StrategyCard) ---
  const [isLive, setIsLive] = useState(false);
  const [lots, setLots] = useState(1);
  const [profitTarget, setProfitTarget] = useState('25%');
  const [stopLoss, setStopLoss] = useState('25%');
  const [startTime, setStartTime] = useState('09:20');
  const [maxLots, setMaxLots] = useState(4);
  const [mode, setMode] = useState('winner_roll_atm');
  const [loserRatioLots, setLoserRatioLots] = useState(1);
  const [thresholdLot, setThresholdLot] = useState(25.0);
  const [thresholdStrike, setThresholdStrike] = useState(40.0);
  const [scalpFloorPct, setScalpFloorPct] = useState(0.0);
  const [multiCycle, setMultiCycle] = useState(false);
  const [cycleCooldown, setCycleCooldown] = useState(300);
  const [entryType, setEntryType] = useState('strangle');
  const [strikeSelection, setStrikeSelection] = useState('distance');
  const [ceOffset, setCeOffset] = useState(200);
  const [peOffset, setPeOffset] = useState(200);
  const [targetDelta, setTargetDelta] = useState(0.20);
  const [targetPremium, setTargetPremium] = useState(50.0);
  const [dnTargetDelta, setDnTargetDelta] = useState(0.5);
  const [dnThresholdLot, setDnThresholdLot] = useState(50.0);
  const [entryBalanceThreshold, setEntryBalanceThreshold] = useState(15.0);
  const [entryBand, setEntryBand] = useState(5.0);
  const [declineTicks, setDeclineTicks] = useState(5);
  const [exitBuffer, setExitBuffer] = useState(10.0);
  const [maxPremiumDiff, setMaxPremiumDiff] = useState(15.0);
  const [vwapWarmupBars, setVwapWarmupBars] = useState(10);
  // VIX-Filtered Straddle
  const [vixExitBuffer, setVixExitBuffer] = useState(5.0);
  const [stPeriod, setStPeriod] = useState(10);
  const [stMultiplier, setStMultiplier] = useState(2.0);
  const [stInterval, setStInterval] = useState('3');
  const [vixStPeriod, setVixStPeriod] = useState(10);
  const [vixStMultiplier, setVixStMultiplier] = useState(2.0);
  const [vixStInterval, setVixStInterval] = useState('3');
  const [atmShiftBuffer, setAtmShiftBuffer] = useState(5.0);
  // Rolling Short Straddle
  const [rollType, setRollType] = useState<'points' | 'percentage'>('points');
  const [rollBuffer, setRollBuffer] = useState(35.0);
  const [rollTriggerPct, setRollTriggerPct] = useState(0.4);
  const [maxRolls, setMaxRolls] = useState(5);
  const [rollCooldown, setRollCooldown] = useState(60);
  const [entryBalanceThresholdRS, setEntryBalanceThresholdRS] = useState(15.0);
  const [pcrThreshold, setPcrThreshold] = useState(1.5);
  const [exitPcrChange, setExitPcrChange] = useState(30);
  const [pollInterval, setPollInterval] = useState(60);
  const [expansionWindow, setExpansionWindow] = useState(3);
  const [legSlPct, setLegSlPct] = useState(0.20);
  const [trailStartRs, setTrailStartRs] = useState(500);
  const [trailGapRs, setTrailGapRs] = useState(300);
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
  const [crudeoilTargetInr, setCrudeoilTargetInr] = useState(3000);
  const [crudeoilStopInr, setCrudeoilStopInr] = useState(3000);
  // CrudeOil Mini ORB + Pivot Stop. Defaults mirror the script's argparse defaults, so
  // launching without touching anything reproduces a bare CLI run.
  const [orbInterval, setOrbInterval] = useState('5');
  const [orbMinutes, setOrbMinutes] = useState(15);
  const [orbSessionStart, setOrbSessionStart] = useState('09:00');
  const [orbEodTime, setOrbEodTime] = useState('23:30');
  const [orbPivotN, setOrbPivotN] = useState(5);
  const [orbPivotInterval, setOrbPivotInterval] = useState('1');
  const [orbPivotFilter, setOrbPivotFilter] = useState(true);
  const [orbAllowReentry, setOrbAllowReentry] = useState(false);
  const [orbTargetInr, setOrbTargetInr] = useState(3000);
  const [orbStopInr, setOrbStopInr] = useState(3000);
  // CrudeOil Mini Renko SAR (shares crudeoilInterval/StartTime/EodTime above)
  const [renkoQty, setRenkoQty] = useState(10);
  const [momentumCapital, setMomentumCapital] = useState(175000);
  const [momentumSlots, setMomentumSlots] = useState(10);
  // Defaults ON — see StrategyCard: turning the market filter off deepens the backtested
  // drawdown from -13.1% to -18.1% for no meaningful gain in return.
  const [momentumRegime, setMomentumRegime] = useState(true);
  const [renkoBoxSize, setRenkoBoxSize] = useState(5);
  const [renkoReverseBricks, setRenkoReverseBricks] = useState(3);
  // CrudeOil Mini VWAP + Supertrend (shares crudeoilInterval/StartTime/EodTime above)
  const [cvsLots, setCvsLots] = useState(5);
  const [cvsContractSize, setCvsContractSize] = useState(10);
  const [cvsStPeriod, setCvsStPeriod] = useState(7);
  const [cvsStMultiplier, setCvsStMultiplier] = useState(2.0);
  const [cvsTargetInr, setCvsTargetInr] = useState(5000);
  const [cvsStopInr, setCvsStopInr] = useState(5000);
  const [cvsPollSeconds, setCvsPollSeconds] = useState(15);
  const [cvsFlipCooldown, setCvsFlipCooldown] = useState(30);
  const [cvsAllowReverse, setCvsAllowReverse] = useState(true);
  const [cvsExitOnClose, setCvsExitOnClose] = useState(false);
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

  // reentry_straddle rejects a non-default --max-lots (it never scales lots), so the flag is
  // omitted below and the script's own default of 4 applies — which its `--lots > --max-lots`
  // check then enforces against Lots. Mirrors StrategyCard.
  const reentryLotsTooHigh =
    meta.key === 'nifty_advanced_imbalance' && mode === 'reentry_straddle' && lots > REENTRY_MAX_LOTS;

  const isRunning = state.status !== 'STOPPED';
  const pnl = state.total_pnl ?? 0;
  const isPnlPositive = pnl >= 0;

  // Does the state file still claim an open position? Drives the Reset button, which
  // exists for exactly one case: the book was squared off manually at the broker and
  // the strategy has not noticed.
  const hasTrackedPosition = Boolean(
    (state.direction && state.direction !== 'NONE') ||
    state.in_position || state.ce_strike || state.pe_strike || state.active_spread || state.sold_strike
  );

  useEffect(() => {
    if (!isRunning && submitting) setSubmitting(false);
  }, [isRunning]);

  const handleStart = async () => {
    setStartError(null);
    // Refuse locally what the script would refuse at startup: argparse exits 2 while
    // /api/strategies has already returned success, so the row would just stay STOPPED
    // with nothing explaining why.
    if (reentryLotsTooHigh) {
      setStartError(
        `Re-entry Straddle caps Lots at ${REENTRY_MAX_LOTS} (the mode always re-enters at the ` +
        `initial lot size). Lower Lots or pick another mode.`
      );
      return;
    }
    setSubmitting(true);
    try {
      const args: string[] = [];
      if (isLive) args.push('--live');
      if (meta.key === 'nifty500_momentum') {
        // Positional equity portfolio: sized in rupees and slots, not lots, and it has no
        // daily target/stop-loss caps — exits are per-position, not per-session.
        args.push('--capital', String(momentumCapital));
        args.push('--slots', String(momentumSlots));
        if (!momentumRegime) args.push('--no-regime');
      } else if (meta.key === 'crudeoilm_renko_sar') {
        // Renko SAR takes order quantity directly (barrels), not lots
        args.push('--qty', String(renkoQty));
        // and is a pure stop-and-reverse system with no daily P&L caps
      } else if (meta.key === 'crudeoilm_supertrend') {
        // Crude oil supertrend expects --target-profit / --stop-loss as plain floats (INR), not percentages
        args.push('--lots', String(lots));
        args.push('--target-profit', String(crudeoilTargetInr));
        args.push('--stop-loss', String(crudeoilStopInr));
      } else if (meta.key === 'crudeoilm_orb') {
        // --target-profit / --stop-loss are argparse floats (INR). The generic branch below
        // sends the "25%" string, which argparse rejects ("invalid float value: '25%'") and
        // the process dies at startup with exit code 2.
        args.push('--lots', String(lots));
        args.push('--target-profit', String(orbTargetInr));
        args.push('--stop-loss', String(orbStopInr));
      } else if (meta.key === 'crudeoilm_vwap_supertrend') {
        // --lots is the broker order quantity verbatim (Dhan takes MCX qty in lots);
        // --contract-size is barrels per lot and only scales the P&L, hence the daily caps.
        args.push('--lots', String(cvsLots));
        args.push('--contract-size', String(cvsContractSize));
        args.push('--target-profit', String(cvsTargetInr));
        args.push('--stop-loss', String(cvsStopInr));
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
        if (mode !== 'reentry_straddle') args.push('--threshold-strike', String(thresholdStrike));
        if (mode === 'reentry_straddle') {
          args.push('--leg-sl-pct', String(legSlPct));
        }
        if (effectiveEntryType === 'strangle') {
          if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
          else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
          else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        }
        args.push('--trail-start-rs', String(trailStartRs));
        args.push('--trail-gap-rs', String(trailGapRs));
        if (scalpFloorPct > 0) args.push('--scalp-floor-pct', String(scalpFloorPct));
        if (multiCycle) args.push('--multi-cycle');
        if (cycleCooldown !== 300) args.push('--cycle-cooldown', String(cycleCooldown));
      } else if (meta.key === 'nifty_delta_neutral') {
        args.push('--start-time', startTime);
        args.push('--target-delta', String(dnTargetDelta));
        args.push('--threshold-lot', String(dnThresholdLot));
        args.push('--trail-start-rs', String(trailStartRs));
        args.push('--trail-gap-rs', String(trailGapRs));
      } else if (meta.key === 'nifty_value_imbalance_straddle') {
        args.push('--max-lots', String(maxLots));
        args.push('--start-time', startTime);
        args.push('--entry-balance-threshold', String(entryBalanceThreshold));
        args.push('--trail-start-rs', String(trailStartRs));
        args.push('--trail-gap-rs', String(trailGapRs));
      } else if (meta.key === 'nifty_vwap_1min_straddle') {
        args.push('--start-time', startTime);
        args.push('--entry-band', String(entryBand));
        args.push('--decline-ticks', String(declineTicks));
        args.push('--exit-buffer', String(exitBuffer));
        args.push('--max-premium-diff', String(maxPremiumDiff));
        args.push('--vwap-warmup-bars', String(vwapWarmupBars));
      } else if (meta.key === 'nifty_vix_straddle') {
        args.push('--start-time', startTime);
        args.push('--st-period', String(stPeriod));
        args.push('--st-multiplier', String(stMultiplier));
        args.push('--st-interval', stInterval);
        args.push('--vix-st-period', String(vixStPeriod));
        args.push('--vix-st-multiplier', String(vixStMultiplier));
        args.push('--vix-st-interval', vixStInterval);
        args.push('--exit-buffer', String(vixExitBuffer));
        args.push('--max-premium-diff', String(maxPremiumDiff));
        args.push('--vwap-warmup-bars', String(vwapWarmupBars));
        args.push('--atm-shift-buffer', String(atmShiftBuffer));
      } else if (meta.key === 'nifty_value_imbalance_strangle') {
        args.push('--max-lots', String(maxLots));
        args.push('--start-time', startTime);
        if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
        else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
        else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        args.push('--trail-start-rs', String(trailStartRs));
        args.push('--trail-gap-rs', String(trailGapRs));
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
      } else if (meta.key === 'crudeoilm_orb') {
        args.push('--interval', orbInterval);
        args.push('--or-minutes', String(orbMinutes));
        args.push('--session-start', orbSessionStart);
        args.push('--eod-time', orbEodTime);
        args.push('--pivot-n', String(orbPivotN));
        args.push('--pivot-interval', orbPivotInterval);
        if (!orbPivotFilter) args.push('--no-pivot-filter');
        if (orbAllowReentry) args.push('--allow-reentry');
      } else if (meta.key === 'crudeoilm_vwap_supertrend') {
        args.push('--interval', crudeoilInterval);
        args.push('--supertrend-period', String(cvsStPeriod));
        args.push('--supertrend-multiplier', String(cvsStMultiplier));
        args.push('--start-time', crudeoilStartTime);
        args.push('--eod-time', crudeoilEodTime);
        args.push('--poll-seconds', String(cvsPollSeconds));
        args.push('--flip-cooldown', String(cvsFlipCooldown));
        if (!cvsAllowReverse) args.push('--no-reverse');
        if (cvsExitOnClose) args.push('--exit-on-close');
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
      } else if (meta.key === 'nifty_rolling_straddle') {
        args.push('--roll-type', rollType);
        if (rollType === 'percentage') {
          args.push('--roll-trigger-pct', String(rollTriggerPct));
        } else {
          args.push('--roll-buffer', String(rollBuffer));
        }
        args.push('--max-rolls', String(maxRolls));
        args.push('--roll-cooldown', String(rollCooldown));
        args.push('--entry-balance-threshold', String(entryBalanceThresholdRS));
        args.push('--start-time', startTime);
        args.push('--trail-start-rs', String(trailStartRs));
        args.push('--trail-gap-rs', String(trailGapRs));
      }

      const payload: any = { action: 'start', strategy: meta.key, args, instanceId };
      if (meta.execBrokerEligible && selectedBroker && selectedBroker !== 'dhan') {
        payload.broker = selectedBroker;
      }

      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
        body: JSON.stringify({ action: 'stop', strategy: meta.key, instanceId }),
      });
      const data = await res.json();
      if (data.success) { setTimeout(onRefresh, 1500); }
      else { setStartError(data.error || 'Failed to stop'); setSubmitting(false); }
    } catch (e) {
      setStartError(`Network error: ${e}`);
      setSubmitting(false);
    }
  };

  // "I squared this off myself." Stops the process WITHOUT the graceful shutdown
  // that would place a real exit order, then clears the phantom position. Two-click
  // confirm like Stop, because it kills a live process.
  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      const timer = setTimeout(() => setConfirmReset(false), 4000);
      setResetTimeoutId(timer);
      return;
    }
    if (resetTimeoutId) { clearTimeout(resetTimeoutId); setResetTimeoutId(null); }
    setConfirmReset(false);
    setSubmitting(true);
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', strategy: meta.key, instanceId }),
      });
      const data = await res.json();
      if (data.success) { setTimeout(onRefresh, 1000); }
      else { setStartError(data.error || 'Failed to reset'); }
    } catch (e) {
      setStartError(`Network error: ${e}`);
    } finally {
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
  const statusCfg = state.status?.startsWith('COOLDOWN')
    ? { dot: 'bg-amber-400', text: 'text-amber-400', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20' }
    : STATUS_MAP[state.status];

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
    if (meta.key === 'nifty_rolling_straddle') {
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          {state.spot != null && state.spot > 0 && (
            <div className="px-3 flex flex-col justify-center shrink-0">
              <div className={lbl}>Spot</div>
              <div className={val}>{state.spot.toFixed(1)}</div>
            </div>
          )}
          <div className="px-3 flex flex-col justify-center min-w-[120px]">
            <div className={lbl}>ATM Straddle</div>
            <div className="font-mono font-bold text-xs text-emerald-400">{state.current_atm || state.ce_strike || '—'}</div>
            <div className="text-[9px] text-zinc-400 font-mono whitespace-nowrap">
              CE ₹{state.ce_ltp?.toFixed(1) ?? '—'} · PE ₹{state.pe_ltp?.toFixed(1) ?? '—'}
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>
              Roll Bounds ({state.roll_type === 'percentage' ? `±${state.roll_trigger_pct ?? 0.4}%` : `±${state.roll_buffer ?? 35}pt`})
            </div>
            <div className="font-mono font-bold text-xs text-amber-400">
              {state.lower_bound != null ? state.lower_bound.toFixed(0) : '—'} - {state.upper_bound != null ? state.upper_bound.toFixed(0) : '—'}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono">Rolls {state.roll_count ?? 0}/{state.max_rolls ?? 5}</div>
          </div>
        </div>
      );
    }

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

    if (meta.key === 'crudeoilm_orb') {
      const rangeReady = (state.orh ?? 0) > 0 && (state.orl ?? 0) > 0;
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Direction</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.direction === 'LONG' ? 'text-emerald-400' : state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'}`}>
              {state.direction || 'NONE'}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono">
              {/* Which sides are already spent — the cap is per side, per day. */}
              {state.taken_long || state.taken_short
                ? `taken ${[state.taken_long ? 'L' : '', state.taken_short ? 'S' : ''].filter(Boolean).join('+')}`
                : 'no trade yet'}
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0 min-w-[120px]">
            <div className={lbl}>Range {state.range_locked ? '(locked)' : '(forming)'}</div>
            {rangeReady ? (
              <>
                <div className={val}>{state.orh!.toFixed(2)} / {state.orl!.toFixed(2)}</div>
                <div className="text-[9px] text-zinc-500 font-mono">
                  {state.session_start ?? '—'} +{state.or_minutes ?? '—'}m · w {(state.orh! - state.orl!).toFixed(2)}
                </div>
              </>
            ) : (
              <div className="text-xs font-mono text-zinc-600">building…</div>
            )}
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
            <div className={lbl}>Stop</div>
            <div className="font-mono font-bold text-xs text-amber-400 leading-tight">
              {state.stop_level != null && state.stop_level > 0 ? state.stop_level.toFixed(2) : '—'}
            </div>
            {/* RANGE = stage 1 (opening-range edge), PIVOT = stage 2 (trailing structure stop) */}
            <div className={`text-[9px] font-mono ${state.stop_source === 'PIVOT' ? 'text-sky-400' : 'text-zinc-500'}`}>
              {state.stop_source && state.stop_source !== 'NONE' ? state.stop_source : '—'}
              {state.pivot_n ? ` · n${state.pivot_n}@${state.pivot_interval ?? '?'}m` : ''}
            </div>
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

    if (meta.key === 'crudeoilm_vwap_supertrend') {
      const above = (p?: number, b?: number) => p != null && b != null && b > 0 && p > b;
      const px = state.ltp && state.ltp > 0 ? state.ltp : state.signal_close;
      return (
        <div className="flex items-stretch divide-x divide-zinc-800/60">
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Direction</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.direction === 'LONG' ? 'text-emerald-400' : state.direction === 'SHORT' ? 'text-rose-400' : 'text-zinc-500'}`}>
              {state.direction || 'FLAT'}
            </div>
            <div className="text-[9px] font-mono whitespace-nowrap">
              <span className="text-zinc-500">{state.allow_reverse === false ? 'no-reverse' : 'always-on'} · </span>
              {/* Exit trigger decides whether a live dip below both bands acts now or
                  waits for the candle to close — make it visible, not a hidden setting. */}
              <span className={state.exit_on_close ? 'text-amber-400' : 'text-zinc-500'}>
                {state.exit_on_close ? 'close-exit' : 'ltp-exit'}
              </span>
              <span className="text-zinc-500">{state.expiry ? ` · ${state.expiry}` : ''}</span>
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center min-w-[110px]">
            <div className={lbl}>Entry / LTP</div>
            {state.direction && state.direction !== 'NONE' ? (
              <>
                <div className={val}>{state.ltp != null ? state.ltp.toFixed(2) : '—'}</div>
                <div className="text-[9px] text-zinc-400 font-mono whitespace-nowrap">
                  avg ₹{state.entry_price?.toFixed(2) ?? '—'} · {state.lots ?? '—'} lot · {state.exposure_units ?? '—'} bbl
                </div>
              </>
            ) : (
              <>
                <div className="text-xs font-mono text-zinc-600">—</div>
                <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
                  {state.lots ?? '—'} lot · {state.exposure_units ?? '—'} bbl
                </div>
              </>
            )}
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>ST / VWAP</div>
            <div className="font-mono font-bold text-xs leading-tight whitespace-nowrap">
              <span className={above(px, state.st_level) ? 'text-emerald-400' : 'text-rose-400'}>
                {state.st_level != null && state.st_level > 0 ? state.st_level.toFixed(2) : '—'}
              </span>
              <span className="text-zinc-500"> / </span>
              <span className={above(px, state.vwap) ? 'text-emerald-400' : 'text-rose-400'}>
                {state.vwap != null && state.vwap > 0 ? state.vwap.toFixed(2) : '—'}
              </span>
            </div>
            <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
              {state.interval ?? 5}m ST({state.supertrend_period ?? 7},{state.supertrend_multiplier ?? 2}) + VWAP
            </div>
          </div>
          {/* Regime gate. Without this the strategy sitting flat through a live
              ABOVE-BOTH/BELOW-BOTH signal reads as hung rather than as filtered. */}
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Regime</div>
            <div className={`font-mono font-bold text-xs leading-tight ${state.regime === 'TREND' ? 'text-emerald-400' : 'text-amber-400'}`}>
              {state.regime ?? '—'}
            </div>
            <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
              ADX {state.adx?.toFixed(0) ?? '—'} · CHOP {state.chop?.toFixed(0) ?? '—'} · HTF{' '}
              <span className={state.htf_st_dir === 1 ? 'text-emerald-400' : state.htf_st_dir === -1 ? 'text-rose-400' : 'text-zinc-500'}>
                {state.htf_st_dir === 1 ? 'BULL' : state.htf_st_dir === -1 ? 'BEAR' : '?'}
              </span>
            </div>
          </div>
          <div className="px-3 flex flex-col justify-center shrink-0 min-w-[120px]">
            <div className={lbl}>{state.direction && state.direction !== 'NONE' ? 'Stop' : 'Blocked By'}</div>
            {state.direction && state.direction !== 'NONE' ? (
              <>
                <div className={val}>{state.stop_level != null && state.stop_level > 0 ? state.stop_level.toFixed(2) : '—'}</div>
                <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
                  {state.stop_source || 'no stop'} · {state.trades_today ?? 0}{state.max_trades_per_day ? `/${state.max_trades_per_day}` : ''} trades
                </div>
              </>
            ) : (
              <>
                <div className="font-mono text-[10px] text-amber-400 leading-tight">{state.blocked_reason || '—'}</div>
                <div className="text-[9px] text-zinc-500 font-mono whitespace-nowrap">
                  {state.trades_today ?? 0}{state.max_trades_per_day ? `/${state.max_trades_per_day}` : ''} trades
                  {state.loss_streak ? ` · ${state.loss_streak} loss streak` : ''}
                </div>
              </>
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
          {state.threshold_lot != null && (state.mode === 'winner_roll_atm' || state.mode === 'delta_neutral_winner_roll') && <div className="text-[9px] text-zinc-300 font-mono">lot {state.threshold_lot}%</div>}
          {state.threshold_strike != null && state.mode !== 'reentry_straddle' && <div className="text-[9px] text-amber-500/80 font-mono">strk {state.threshold_strike}%</div>}
          {state.scalp_floor_pct != null && state.scalp_floor_pct > 0 && <div className="text-[9px] text-emerald-400 font-mono">scalp {state.scalp_floor_pct}%</div>}
        </div>
        {state.trail_start_rs != null && (
          <div className="px-3 flex flex-col justify-center shrink-0">
            <div className={lbl}>Trail SL</div>
            {state.trail_active ? (
              <>
                <div className="font-mono font-bold text-[10px] text-amber-400">ACTIVE</div>
                <div className="text-[9px] text-zinc-300 font-mono whitespace-nowrap">
                  best ₹{Math.round(state.best_pnl ?? 0)} · exit@₹{state.trail_exit_pnl != null ? Math.round(state.trail_exit_pnl) : '—'}
                </div>
              </>
            ) : (
              <>
                <div className="font-mono text-[10px] text-zinc-500">inactive</div>
                <div className="text-[9px] text-zinc-600 font-mono whitespace-nowrap">
                  arms ₹{Math.round(state.trail_start_rs)}
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

        {meta.key === 'nifty500_momentum' ? (
          // Positional equity portfolio: rupees and slots, not lots. It also has no session
          // start-time or daily target/stop, so those generic fields are suppressed below.
          <>
            <div className={fieldCls}>
              <FieldLabel text="Capital ₹" tip="Total rupees allocated to the portfolio. Ranks 1-5 get a 4:3 larger slot than ranks 6-10." />
              <Input type="number" value={momentumCapital} onChange={e => setMomentumCapital(parseInt(e.target.value) || 175000)} className={inputCls} style={{ width: 92 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Slots" tip="Maximum stocks held at once. Freed slots are refilled at the next weekly review." />
              <Input type="number" value={momentumSlots} onChange={e => setMomentumSlots(parseInt(e.target.value) || 10)} min={1} max={30} className={inputCls} style={{ width: 64 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Market Filter" tip="ON: only buys while last week's Nifty closed above its 200-day average, and moves to cash when it does not. OFF: always eligible to be invested. Backtested 2019-2026, turning it off leaves return almost unchanged (13.35% vs 13.63% CAGR) but deepens the worst drawdown from -13.1% to -18.1%." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`momentum-regime-wide-${meta.key}`}
                  checked={momentumRegime}
                  onChange={e => setMomentumRegime(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`momentum-regime-wide-${meta.key}`} className="text-xs text-zinc-400">
                  {momentumRegime ? 'On' : 'Off'}
                </label>
              </div>
            </div>
          </>
        ) : meta.key === 'crudeoilm_renko_sar' ? (
          <div className={fieldCls}>
            <FieldLabel text="Quantity" tip="Order size in barrels (MCX lot size = 10); not multiplied like other strategies' Lots field." />
            <Input type="number" value={renkoQty} onChange={e => setRenkoQty(parseInt(e.target.value) || 10)} min={1} step={1} className={inputCls} style={{ width: 72 }} />
          </div>
        ) : meta.key === 'crudeoilm_vwap_supertrend' ? (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Lots" tip="Order quantity sent to the broker as-is — Dhan takes MCX quantity in lots, so 5 here is 5 lots." />
              <Input type="number" value={cvsLots} onChange={e => setCvsLots(parseInt(e.target.value) || 1)} min={1} max={50} className={inputCls} style={{ width: 64 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Barrels/Lot" tip="Contract size used for P&L only (CRUDEOILM = 10, CRUDEOIL = 100). It does not change the order quantity, but it does scale the Target/Stop below." />
              <Input type="number" value={cvsContractSize} onChange={e => setCvsContractSize(parseInt(e.target.value) || 10)} min={1} className={inputCls} style={{ width: 72 }} />
            </div>
          </>
        ) : (
          <div className={fieldCls}>
            <FieldLabel text="Lots" tip="Number of lot-sized units traded per leg at entry (multiplied by the instrument's live lot size)." />
            <Input type="number" value={lots} onChange={e => setLots(parseInt(e.target.value) || 1)} min={1}
              max={meta.key === 'nifty_advanced_imbalance' && mode === 'reentry_straddle' ? REENTRY_MAX_LOTS : 20}
              className={`${inputCls}${reentryLotsTooHigh ? ' border-red-600 text-red-300' : ''}`} style={{ width: 64 }} />
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

        {meta.key === 'nifty_advanced_imbalance' && mode !== 'reentry_straddle' && (
          <div className={fieldCls}>
            <FieldLabel text="Threshold Strike %" tip="Premium imbalance % that triggers a strike shift once max-lots is reached. Must be greater than Threshold Lot %." />
            <Input type="number" value={thresholdStrike} onChange={e => setThresholdStrike(parseFloat(e.target.value) || 40.0)} min={1} step={0.5} className={inputCls} style={{ width: 64 }} />
          </div>
        )}

        {meta.key === 'nifty_advanced_imbalance' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Scalp Lock %" tip="Combined premium decay % that triggers an immediate profit exit & lock (e.g. 30.0 for 30% decay)." />
              <Input type="number" value={scalpFloorPct} onChange={e => setScalpFloorPct(parseFloat(e.target.value) || 0.0)} min={0} max={100} step={5} className={inputCls} style={{ width: 64 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Multi-Cycle" tip="Auto-restarts a fresh ATM cycle on the same day after scalp floor or profit target exits." />
              <div className="flex items-center gap-2 h-7">
                <input
                  type="checkbox"
                  id={`multi-cycle-${meta.key}`}
                  checked={multiCycle}
                  onChange={e => setMultiCycle(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
                />
                <label htmlFor={`multi-cycle-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
            {multiCycle && (
              <div className={fieldCls}>
                <FieldLabel text="Cooldown (s)" tip="Seconds to wait between scalp cycles before placing the next entry." />
                <Input type="number" value={cycleCooldown} onChange={e => setCycleCooldown(parseInt(e.target.value) || 300)} min={0} step={30} className={inputCls} style={{ width: 64 }} />
              </div>
            )}
          </>
        )}

        {meta.key === 'nifty_delta_neutral' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target Delta" tip="Target absolute delta used to pick CE and PE strikes independently; can produce a straddle, strangle, or inverted strangle depending on skew." />
              <Input type="number" step="0.1" min={0.1} max={0.9} value={dnTargetDelta} onChange={e => setDnTargetDelta(Math.round((parseFloat(e.target.value) || 0.5) * 10) / 10)} className={inputCls} style={{ width: 72 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Threshold Lot %" tip="Premium imbalance % (added to the post-entry/post-roll baseline offset) that triggers closing the winning leg and matching its strike to the losing leg's premium." />
              <Input type="number" value={dnThresholdLot} onChange={e => setDnThresholdLot(parseFloat(e.target.value) || 50.0)} min={1} step={0.5} className={inputCls} style={{ width: 64 }} />
            </div>
          </>
        )}

        {meta.key !== 'nifty_spread_trend' && meta.key !== 'crudeoilm_supertrend' && meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'crudeoilm_vwap_supertrend' && meta.key !== 'nifty_st_oi_bearcall' && meta.key !== 'nifty500_momentum' && (
          <div className={fieldCls}>
            <FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins monitoring for entries." />
            <Input type="text" value={startTime} onChange={e => setStartTime(e.target.value)} placeholder="09:20" className={inputCls} style={{ width: 72 }} />
          </div>
        )}

        {meta.key === 'crudeoilm_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR; strategy squares off and stops once reached." />
              <Input type="number" value={crudeoilTargetInr} onChange={e => setCrudeoilTargetInr(parseInt(e.target.value) || 3000)} className={inputCls} style={{ width: 80 }} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR; strategy squares off and stops once breached." />
              <Input type="number" value={crudeoilStopInr} onChange={e => setCrudeoilStopInr(parseInt(e.target.value) || 3000)} className={inputCls} style={{ width: 80 }} />
            </div>
          </>
        )}

        {meta.key === 'crudeoilm_vwap_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR. This is the only thing besides EOD that stops the always-on cycle — the position is flattened and the strategy exits." />
              <Input type="number" value={cvsTargetInr} onChange={e => setCvsTargetInr(parseInt(e.target.value) || 5000)} className={inputCls} style={{ width: 80 }} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR (positive number). Flattens the position and stops the strategy for the day." />
              <Input type="number" value={cvsStopInr} onChange={e => setCvsStopInr(parseInt(e.target.value) || 5000)} className={inputCls} style={{ width: 80 }} />
            </div>
          </>
        )}

        {meta.key !== 'crudeoilm_renko_sar' && meta.key !== 'crudeoilm_supertrend' && meta.key !== 'crudeoilm_vwap_supertrend' && meta.key !== 'nifty500_momentum' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR, or a percentage of entry premium collected e.g. '25%'; strategy squares off and stops once reached." />
              <Input type="text" inputMode="decimal" value={profitTarget} onChange={e => setProfitTarget(e.target.value)} placeholder="25% or 4000" className={inputCls} style={{ width: 80 }} />
            </div>

            <div className={fieldCls}>
              <FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR, or a percentage of entry premium collected e.g. '25%'; strategy squares off and stops once breached." />
              <Input type="text" inputMode="decimal" value={stopLoss} onChange={e => setStopLoss(e.target.value)} placeholder="25% or 4000" className={inputCls} style={{ width: 80 }} />
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

        {meta.key === 'nifty_rolling_straddle' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Roll Variant" tip="Select rolling trigger variant: Fixed Points Buffer (pts) or Rolling Trigger % (monitors spot move from reference spot)." />
              <Select value={rollType} onValueChange={(v) => v && setRollType(v as 'points' | 'percentage')}>
                <SelectTrigger className={inputCls} style={{ width: 150 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="points">Fixed Points Buffer (pts)</SelectItem>
                  <SelectItem value="percentage">Rolling Trigger (%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {rollType === 'percentage' ? (
              <div className={fieldCls}>
                <FieldLabel text="Roll Trigger (%)" tip="Percentage move from reference spot price to trigger an ATM roll (e.g. 0.4%)." />
                <Input type="number" step="0.05" min={0.05} max={5.0} value={rollTriggerPct} onChange={(e) => setRollTriggerPct(parseFloat(e.target.value) || 0.4)} className={inputCls} style={{ width: 72 }} />
              </div>
            ) : (
              <div className={fieldCls}>
                <FieldLabel text="Roll Buffer (pts)" tip="Custom ATM shift buffer in points (e.g. 35.0 pts triggers ATM roll at ±35 pts from active ATM)." />
                <Input type="number" step="1" value={rollBuffer} onChange={(e) => setRollBuffer(parseFloat(e.target.value) || 35.0)} className={inputCls} style={{ width: 72 }} />
              </div>
            )}
            <div className={fieldCls}>
              <FieldLabel text="Max Rolls / Day" tip="Maximum number of straddle rolls allowed per trading session." />
              <Input type="number" value={maxRolls} onChange={(e) => setMaxRolls(parseInt(e.target.value) || 5)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Roll Cooldown (s)" tip="Minimum delay in seconds between consecutive straddle rolls to prevent whipsaws." />
              <Input type="number" value={rollCooldown} onChange={(e) => setRollCooldown(parseInt(e.target.value) || 60)} min={0} step={10} className={inputCls} style={{ width: 64 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Entry Balance (%)" tip="Maximum CE/PE premium difference % to allow entry. Strategy waits until premiums are within this threshold. Set 0 to disable." />
              <Input type="number" step="0.5" min={0} max={50} value={entryBalanceThresholdRS} onChange={(e) => setEntryBalanceThresholdRS(parseFloat(e.target.value) || 0)} className={inputCls} style={{ width: 64 }} />
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

        {meta.key === 'crudeoilm_orb' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Opening Range (min)" tip="Width of the opening-range window measured from Session Start. ORH/ORL are the highest high and lowest low inside it; no trading happens until the window closes." />
              <Input type="number" value={orbMinutes} onChange={e => setOrbMinutes(parseInt(e.target.value) || 15)} min={1} step={5} className={inputCls} style={{ width: 72 }} />
            </div>
            <div className={fieldCls}><FieldLabel text="Session Start" tip="Time (HH:MM IST) the opening range starts building. MCX crude opens at 09:00 — not the NSE 09:15/09:20 open." /><Input type="text" value={orbSessionStart} onChange={e => setOrbSessionStart(e.target.value)} placeholder="09:00" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="EOD Flat" tip="Time (HH:MM IST) any open position is squared off and the strategy stops for the day." /><Input type="text" value={orbEodTime} onChange={e => setOrbEodTime(e.target.value)} placeholder="23:30" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="Trade Candles" tip="Candle interval used to evaluate the breakout. The decision is taken on the last CLOSED candle, so a wick through the range that closes back inside does not trigger." />
              <Select value={orbInterval} onValueChange={v => v && setOrbInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORB_INTERVALS.map(v => <SelectItem key={v} value={v}>{v} Min</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Pivot Candles" tip="Candle interval the pivot detector runs on — usually FASTER than the trade candles so the structure stop appears sooner. Only 1/5/15/25/60 are valid; other values make Dhan return an empty frame and no pivot would ever confirm." />
              <Select value={orbPivotInterval} onValueChange={v => v && setOrbPivotInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORB_INTERVALS.map(v => <SelectItem key={v} value={v}>{v} Min</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Pivot N" tip="Candles required on EACH side of a swing point. A pivot cannot be confirmed until N candles close after it, so this sets how far the structure stop lags price." />
              <Input type="number" value={orbPivotN} onChange={e => setOrbPivotN(parseInt(e.target.value) || 5)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
              <span className="text-[9px] text-zinc-600">~{(orbPivotN + 1) * (parseInt(orbPivotInterval) || 1)} min lag</span>
            </div>
            <div className={fieldCls}><FieldLabel text="Target ₹" tip="Daily cumulative profit target in INR; flattens and stops once reached." /><Input type="number" value={orbTargetInr} onChange={e => setOrbTargetInr(parseInt(e.target.value) || 3000)} className={inputCls} style={{ width: 80 }} /></div>
            <div className={fieldCls}><FieldLabel text="Stop Loss ₹" tip="Daily cumulative stop loss in INR (positive number); flattens and stops for the day." /><Input type="number" value={orbStopInr} onChange={e => setOrbStopInr(parseInt(e.target.value) || 3000)} className={inputCls} style={{ width: 80 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="Pivot Filter" tip="ON: a breakout must also clear the most recent pivot high (long) / low (short), rejecting weak pokes through the range. Early in the session no pivot exists yet and the filter is skipped rather than blocking every trade. OFF: enter on the range break alone — pivots still trail the stop." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`orb-filter-wide-${meta.key}`} checked={orbPivotFilter} onChange={e => setOrbPivotFilter(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`orb-filter-wide-${meta.key}`} className="text-zinc-300 text-xs">Require pivot break</label>
              </div>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Re-entry" tip="Default OFF: at most one long and one short per session — the opening range is a once-a-day edge and repeated re-entry into the same level is where ORB bleeds. ON lifts the cap; avoid it on rangebound days." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`orb-reentry-wide-${meta.key}`} checked={orbAllowReentry} onChange={e => setOrbAllowReentry(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`orb-reentry-wide-${meta.key}`} className="text-zinc-300 text-xs">Allow re-entry</label>
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

        {meta.key === 'crudeoilm_vwap_supertrend' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Timeframe" tip="Candle interval in minutes used for both the Supertrend and the VWAP." />
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
            <div className={fieldCls}><FieldLabel text="ST Period" tip="ATR lookback length for the Supertrend (7 by default)." /><Input type="number" value={cvsStPeriod} onChange={e => setCvsStPeriod(parseInt(e.target.value) || 7)} min={2} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="ST Multiplier" tip="ATR multiplier for the Supertrend band width (2 by default)." /><Input type="number" step="0.5" value={cvsStMultiplier} onChange={e => setCvsStMultiplier(parseFloat(e.target.value) || 2.0)} min={0.5} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Start Time" tip="Time (HH:MM IST) the strategy begins trading." /><Input type="text" value={crudeoilStartTime} onChange={e => setCrudeoilStartTime(e.target.value)} placeholder="09:00" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="EOD Time" tip="Time (HH:MM IST) the position is flattened for the day (otherwise always-in)." /><Input type="text" value={crudeoilEodTime} onChange={e => setCrudeoilEodTime(e.target.value)} placeholder="23:30" className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}><FieldLabel text="Poll (s)" tip="Seconds between Supertrend/VWAP refreshes. Exits still react to live ticks every second." /><Input type="number" value={cvsPollSeconds} onChange={e => setCvsPollSeconds(parseInt(e.target.value) || 15)} min={5} className={inputCls} style={{ width: 64 }} /></div>
            <div className={fieldCls}><FieldLabel text="Flip Cooldown (s)" tip="Minimum seconds between position flips. The Supertrend and VWAP cross each other regularly, and when they nearly coincide the hold-zone collapses to a point — without this a price ticking across it would flip the position every second." /><Input type="number" value={cvsFlipCooldown} onChange={e => setCvsFlipCooldown(parseInt(e.target.value) || 0)} min={0} className={inputCls} style={{ width: 72 }} /></div>
            <div className={fieldCls}>
              <FieldLabel text="Always-On" tip="ON: a signal flip exits and immediately opens the opposite position (stop-and-reverse), so the strategy is always in the market. OFF: it exits to flat and waits for the next candle before re-entering." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`cvs-reverse-wide-${meta.key}`} checked={cvsAllowReverse} onChange={e => setCvsAllowReverse(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`cvs-reverse-wide-${meta.key}`} className="text-zinc-300 text-xs">Reverse on flip</label>
              </div>
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Exit Trigger" tip="Unchecked (default): exits fire on the live LTP as soon as it clears both bands. Checked: exits wait for a confirmed candle close, which is slower but ignores intra-candle spikes." />
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`cvs-close-wide-${meta.key}`} checked={cvsExitOnClose} onChange={e => setCvsExitOnClose(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`cvs-close-wide-${meta.key}`} className="text-zinc-300 text-xs">On candle close</label>
              </div>
            </div>
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

        {meta.key === 'nifty_vix_straddle' && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Straddle ST TF" tip="Candle interval (minutes) for the straddle premium's own Supertrend, resampled from 1-min bars." />
              <Select value={stInterval} onValueChange={v => v && setStInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="Straddle ST Period" tip="ATR lookback length for the straddle premium's own Supertrend." /><Input type="number" value={stPeriod} onChange={e=>setStPeriod(parseInt(e.target.value)||10)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><FieldLabel text="Straddle ST Multi" tip="ATR multiplier controlling the straddle premium's Supertrend band width." /><Input type="number" step="0.5" value={stMultiplier} onChange={e=>setStMultiplier(parseFloat(e.target.value)||2.0)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}>
              <FieldLabel text="VIX ST TF" tip="Candle interval (minutes) for India VIX's own Supertrend, resampled from 1-min bars." />
              <Select value={vixStInterval} onValueChange={v => v && setVixStInterval(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="3">3 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><FieldLabel text="VIX ST Period" tip="ATR lookback length for India VIX's own Supertrend." /><Input type="number" value={vixStPeriod} onChange={e=>setVixStPeriod(parseInt(e.target.value)||10)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><FieldLabel text="VIX ST Multi" tip="ATR multiplier controlling India VIX's Supertrend band width." /><Input type="number" step="0.5" value={vixStMultiplier} onChange={e=>setVixStMultiplier(parseFloat(e.target.value)||2.0)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><FieldLabel text="Exit Buffer" tip="Points above VWAP that trigger exit (buy back both legs), in addition to the VIX Supertrend flip exit." /><Input type="number" step="0.5" value={vixExitBuffer} onChange={e=>setVixExitBuffer(parseFloat(e.target.value)||5.0)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><FieldLabel text="Max Prem Diff%" tip="Max allowed % difference between CE and PE premiums for entry to be considered balanced." /><Input type="number" step="0.5" value={maxPremiumDiff} onChange={e=>setMaxPremiumDiff(parseFloat(e.target.value)||15.0)} className={inputCls} style={{width:80}}/></div>
            <div className={fieldCls}><FieldLabel text="Warmup (bars)" tip="Minimum completed 1-min bars required before VWAP is trusted for trade decisions." /><Input type="number" value={vwapWarmupBars} onChange={e=>setVwapWarmupBars(parseInt(e.target.value)||10)} className={inputCls} style={{width:80}}/></div>
            <div className={fieldCls}><FieldLabel text="ATM Shift Buffer" tip="Points spot must move past a strike midpoint before re-centering ATM. Prevents rapid flip-flopping between two strikes when spot hovers near the midpoint." /><Input type="number" step="0.5" value={atmShiftBuffer} onChange={e=>setAtmShiftBuffer(parseFloat(e.target.value)||5.0)} className={inputCls} style={{width:72}}/></div>
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

        {/* Rupee-MTM trailing SL */}
        {(meta.key === 'nifty_advanced_imbalance' ||
          meta.key === 'nifty_value_imbalance_straddle' ||
          meta.key === 'nifty_value_imbalance_strangle' ||
          meta.key === 'nifty_delta_neutral') && (
          <>
            <div className={fieldCls}>
              <FieldLabel text="Trail Arm (₹)" tip="Arms the trailing stop once MTM profit reaches this many rupees. Size it against your lot count." />
              <Input type="number" step="50" value={trailStartRs} onChange={e => setTrailStartRs(parseFloat(e.target.value) || 500)} min={0} className={inputCls} style={{ width: 72 }} />
            </div>
            <div className={fieldCls}>
              <FieldLabel text="Trail Gap (₹)" tip="Once armed, exits if MTM gives back this many rupees from its best level. Survives rolls — the trail runs on realized + unrealized P&L." />
              <Input type="number" step="50" value={trailGapRs} onChange={e => setTrailGapRs(parseFloat(e.target.value) || 300)} min={50} className={inputCls} style={{ width: 72 }} />
            </div>
          </>
        )}

        {/* Launch button inline in config */}
        <div className="flex items-end">
          <Button onClick={handleStart} disabled={submitting || spreadTrendNoIndicators || reentryLotsTooHigh}
            className="h-7 px-4 gap-1.5 bg-gradient-to-tr from-emerald-600 to-teal-500 text-oncolor font-bold rounded-lg shadow-md shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-[0.98] transition-all text-xs border-0 disabled:opacity-50 disabled:cursor-not-allowed">
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
            <span className="text-sm font-bold text-white truncate">{meta.name}{instanceId ? ` #${instanceId}` : ''}</span>
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
              {isRunning && (
                <span className={`px-1 py-0.5 rounded text-[8px] font-bold font-mono uppercase ${
                  state.broker === 'zerodha' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' :
                  state.broker === 'kotak' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                  'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                }`}>
                  {state.broker || 'dhan'}
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
              <button onClick={handleReset} disabled={submitting}
                title="Already squared off manually? Stops the strategy WITHOUT sending an exit order and clears the position it thinks it holds. Use Stop instead if the position is still open."
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-all flex items-center gap-1 ${
                  submitting ? 'border-zinc-700 bg-zinc-900 text-zinc-500 cursor-not-allowed'
                  : confirmReset ? 'border-amber-500 bg-amber-500/20 text-amber-300 animate-pulse'
                  : 'border-amber-500/25 bg-amber-950/20 text-amber-400 hover:bg-amber-950/30 hover:border-amber-500/40'
                }`}>
                <RotateCcw className="h-3 w-3" />
                {confirmReset ? 'No exit order — sure?' : 'Reset'}
              </button>
              <button onClick={() => setShowLogs(!showLogs)}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-colors flex items-center gap-1 ${
                  showLogs ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-transparent border-zinc-800/60 text-zinc-400 hover:text-white hover:border-zinc-700'
                }`}>
                <Terminal className="h-3 w-3" />
                {showLogs ? 'Hide' : 'Logs'}
              </button>
              {onAddInstance && (
                <button onClick={() => onAddInstance(meta.key)} title="Run another concurrent copy of this strategy with its own lot size"
                  className="h-7 px-2.5 rounded-md text-[11px] font-semibold border border-zinc-800/60 bg-transparent text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors flex items-center gap-1">
                  + Add run
                </button>
              )}
            </>
          ) : (
            <>
              {/* Stopped, but the file still shows a position — e.g. the process was
                  killed while holding one. Reset clears it without any broker order. */}
              {hasTrackedPosition && (
                <button onClick={handleReset} disabled={submitting}
                  title="Clear the stale position this stopped row still shows. Sends no broker order."
                  className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-all flex items-center gap-1 ${
                    submitting ? 'border-zinc-700 bg-zinc-900 text-zinc-500 cursor-not-allowed'
                    : confirmReset ? 'border-amber-500 bg-amber-500/20 text-amber-300 animate-pulse'
                    : 'border-amber-500/25 bg-amber-950/20 text-amber-400 hover:bg-amber-950/30 hover:border-amber-500/40'
                  }`}>
                  <RotateCcw className="h-3 w-3" />
                  {confirmReset ? 'No exit order — sure?' : 'Reset'}
                </button>
              )}
              {onAddInstance && (
                <button onClick={() => onAddInstance(meta.key)} title="Run another concurrent copy of this strategy with its own lot size"
                  className="h-7 px-2.5 rounded-md text-[11px] font-semibold border border-zinc-800/60 bg-transparent text-zinc-400 hover:text-white hover:border-zinc-700 transition-colors flex items-center gap-1">
                  + Add run
                </button>
              )}
              {onRemoveInstance && instanceId && (
                <button onClick={() => onRemoveInstance(meta.key, instanceId)} title="Discard this duplicate run and remove its row"
                  className="h-7 px-2.5 rounded-md text-[11px] font-semibold border border-zinc-800/60 bg-transparent text-zinc-500 hover:text-rose-300 hover:border-rose-500/40 transition-colors flex items-center gap-1">
                  Remove
                </button>
              )}
              <button onClick={() => setShowConfig(!showConfig)}
                className={`h-7 px-2.5 rounded-md text-[11px] font-semibold border transition-colors flex items-center gap-1 ${
                  showConfig ? 'bg-zinc-800 text-white border-zinc-700' : 'bg-transparent border-zinc-800/60 text-zinc-400 hover:text-white hover:border-zinc-700'
                }`}>
                {showConfig ? <ChevronUp className="h-3 w-3" /> : <Settings className="h-3 w-3" />}
                Configure
              </button>
              <Button onClick={handleStart} disabled={submitting || spreadTrendNoIndicators || reentryLotsTooHigh}
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
          <LogConsole strategyKey={meta.key} isActive={isRunning} instanceId={instanceId} />
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
  prev.instanceId === next.instanceId &&
  prev.onAddInstance === next.onAddInstance &&
  prev.onRemoveInstance === next.onRemoveInstance &&
  JSON.stringify(prev.meta) === JSON.stringify(next.meta) &&
  JSON.stringify(prev.state) === JSON.stringify(next.state)
);
