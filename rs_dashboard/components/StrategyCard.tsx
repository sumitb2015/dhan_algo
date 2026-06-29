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
}

interface StrategyCardProps {
  meta: StrategyMeta;
  state: StrategyState;
  onRefresh: () => void;
}

export default function StrategyCard({ meta, state, onRefresh }: StrategyCardProps) {
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [showLogs, setShowLogs] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [confirmStop, setConfirmStop] = useState<boolean>(false);
  const [confirmTimeoutId, setConfirmTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const [isLive, setIsLive] = useState<boolean>(false);
  const [lots, setLots] = useState<number>(1);
  const [profitTarget, setProfitTarget] = useState<number>(4000);
  const [stopLoss, setStopLoss] = useState<number>(4000);
  const [startTime, setStartTime] = useState<string>('09:20');

  const [maxLots, setMaxLots] = useState<number>(4);
  const [mode, setMode] = useState<string>('winner_roll_atm');
  const [loserRatioLots, setLoserRatioLots] = useState<number>(1);
  const [entryType, setEntryType] = useState<string>('strangle');
  const [strikeSelection, setStrikeSelection] = useState<string>('distance');
  const [ceOffset, setCeOffset] = useState<number>(200);
  const [peOffset, setPeOffset] = useState<number>(200);
  const [targetDelta, setTargetDelta] = useState<number>(0.20);
  const [targetPremium, setTargetPremium] = useState<number>(50.0);

  // Straddle
  const [entryBalanceThreshold, setEntryBalanceThreshold] = useState<number>(15.0);

  // VWAP strategies (shared params)
  const [entryBand, setEntryBand] = useState<number>(5.0);
  const [declineTicks, setDeclineTicks] = useState<number>(5);
  const [exitBuffer, setExitBuffer] = useState<number>(10.0);
  const [maxPremiumDiff, setMaxPremiumDiff] = useState<number>(15.0);
  const [vwapWarmup, setVwapWarmup] = useState<number>(60);       // tick-based
  const [vwapWarmupBars, setVwapWarmupBars] = useState<number>(10); // candle-based

  // OI Directional
  const [pcrThreshold, setPcrThreshold] = useState<number>(1.5);
  const [exitPcrChange, setExitPcrChange] = useState<number>(30);
  const [pollInterval, setPollInterval] = useState<number>(60);
  const [expansionWindow, setExpansionWindow] = useState<number>(3);

  // Reentry Straddle
  const [trailCombinedBuffer, setTrailCombinedBuffer] = useState<number>(1.0);
  const [legSlPct, setLegSlPct] = useState<number>(0.20);

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

  const isRunning = state.status !== 'STOPPED';
  const pnl = state.total_pnl ?? 0;

  // Reset submitting when the strategy finishes stopping so the Launch button re-enables.
  useEffect(() => {
    if (!isRunning && submitting) setSubmitting(false);
  }, [isRunning]);
  const isPnlPositive = pnl >= 0;

  const handleStart = async () => {
    setStartError(null);
    setSubmitting(true);
    try {
      const args: string[] = [];
      if (isLive) args.push('--live');
      args.push('--lots', String(lots));
      args.push('--target-profit', String(profitTarget));
      args.push('--stop-loss', String(stopLoss));

      if (meta.key === 'nifty_advanced_imbalance') {
        args.push('--max-lots', String(maxLots));
        const effectiveEntryType = mode === 'reentry_straddle' ? 'straddle' : entryType;
        args.push('--mode', mode, '--entry-type', effectiveEntryType, '--start-time', startTime);
        if (mode === 'loser_ratio_roll') args.push('--loser-ratio-lots', String(loserRatioLots));
        if (mode === 'reentry_straddle') {
          args.push('--trail-combined-buffer', String(trailCombinedBuffer));
          args.push('--leg-sl-pct', String(legSlPct));
        }
        if (effectiveEntryType === 'strangle') {
          if (strikeSelection === 'delta') args.push('--delta', '--target-delta', String(targetDelta));
          else if (strikeSelection === 'premium') args.push('--premium', '--target-premium', String(targetPremium));
          else args.push('--ce-offset', String(ceOffset), '--pe-offset', String(peOffset));
        }
      } else if (meta.key === 'nifty_value_imbalance_straddle') {
        args.push('--max-lots', String(maxLots));
        args.push('--start-time', startTime);
        args.push('--entry-balance-threshold', String(entryBalanceThreshold));
      } else if (meta.key === 'nifty_tick_mean_straddle') {
        args.push('--start-time', startTime);
        args.push('--entry-band', String(entryBand));
        args.push('--decline-ticks', String(declineTicks));
        args.push('--exit-buffer', String(exitBuffer));
        args.push('--max-premium-diff', String(maxPremiumDiff));
        args.push('--vwap-warmup', String(vwapWarmup));
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

  const statusBadge = () => {
    const map: Record<string, { color: string; label: string }> = {
      RUNNING:      { color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', label: 'Running' },
      MONITORING:   { color: 'bg-sky-500/10 text-sky-400 border-sky-500/20', label: 'Monitoring' },
      BALANCING:    { color: 'bg-sky-500/10 text-sky-400 border-sky-500/20', label: 'Balancing' },
      SCANNING:     { color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20', label: 'Scanning' },
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

  /* ── CONFIG PANEL (shared between stopped-expanded and nothing else) ── */
  const configPanel = (
    <div className="flex flex-col gap-2.5 border border-zinc-800/60 px-3 py-2.5 rounded-lg bg-zinc-950/30">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Parameters</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">

        <div className={fieldCls}>
          <label className={lbl}>Execution</label>
          <div className="flex items-center gap-2 h-7">
            <input
              type="checkbox"
              id={`live-${meta.key}`}
              checked={isLive}
              onChange={(e) => setIsLive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500"
            />
            <label htmlFor={`live-${meta.key}`} className="text-white font-semibold flex items-center gap-1 text-xs">
              LIVE {isLive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />}
            </label>
          </div>
        </div>

        <div className={fieldCls}>
          <label className={lbl}>Lots</label>
          <Input type="number" value={lots} onChange={(e) => setLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} />
        </div>

        {(meta.key === 'nifty_advanced_imbalance' ||
          meta.key === 'nifty_value_imbalance_straddle' ||
          meta.key === 'nifty_value_imbalance_strangle') && (
          <div className={fieldCls}>
            <label className={lbl}>Max Lots</label>
            <Input type="number" value={maxLots} onChange={(e) => setMaxLots(parseInt(e.target.value) || 4)} min={1} max={20} className={inputCls} />
          </div>
        )}

        {meta.key !== 'nifty_spread_trend' && (
          <div className={fieldCls}>
            <label className={lbl}>Start Time</label>
            <Input type="text" value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="09:20" className={inputCls} />
          </div>
        )}

        <div className={fieldCls}>
          <label className={lbl}>Target ₹</label>
          <Input type="number" value={profitTarget} onChange={(e) => setProfitTarget(parseInt(e.target.value) || 1000)} className={inputCls} />
        </div>

        <div className={fieldCls}>
          <label className={lbl}>Stop Loss ₹</label>
          <Input type="number" value={stopLoss} onChange={(e) => setStopLoss(parseInt(e.target.value) || 1000)} className={inputCls} />
        </div>

        {meta.key === 'nifty_spread_trend' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Symbol</label>
              <Select value={symbol} onValueChange={(v) => v && setSymbol(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NIFTY">NIFTY</SelectItem>
                  <SelectItem value="BANKNIFTY">BANKNIFTY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Timeframe</label>
              <Select value={interval} onValueChange={(v) => v && setIntervalVal(v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 Min</SelectItem>
                  <SelectItem value="5">5 Min</SelectItem>
                  <SelectItem value="15">15 Min</SelectItem>
                  <SelectItem value="30">30 Min</SelectItem>
                  <SelectItem value="60">1 Hour</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Spread Width (pts)</label>
              <Input type="number" value={spreadWidth} onChange={(e) => setSpreadWidth(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>CE Offset (pts)</label>
              <Input type="number" value={ceOffset} onChange={(e) => setCeOffset(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>PE Offset (pts)</label>
              <Input type="number" value={peOffset} onChange={(e) => setPeOffset(parseInt(e.target.value) || 100)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>EMA Period</label>
              <Input type="number" value={emaPeriod} onChange={(e) => setEmaPeriod(parseInt(e.target.value) || 20)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>ST Period</label>
              <Input type="number" value={supertrendPeriod} onChange={(e) => setSupertrendPeriod(parseInt(e.target.value) || 7)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>ST Multiplier</label>
              <Input type="number" step="0.5" value={supertrendMultiplier} onChange={(e) => setSupertrendMultiplier(parseFloat(e.target.value) || 3.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>EOD Time</label>
              <Input type="text" value={eodTime} onChange={(e) => setEodTime(e.target.value)} placeholder="15:15" className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Cooldown (min)</label>
              <Input type="number" value={cooldownMinutes} onChange={(e) => setCooldownMinutes(parseInt(e.target.value) || 5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Exit on Signal Change</label>
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

        {/* OI Directional-specific */}
        {meta.key === 'nifty_oi_directional' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>PCR Threshold</label>
              <Input type="number" step="0.1" value={pcrThreshold} onChange={(e) => setPcrThreshold(parseFloat(e.target.value) || 1.5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Exit PCR Change (%)</label>
              <Input type="number" value={exitPcrChange} onChange={(e) => setExitPcrChange(parseInt(e.target.value) || 30)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Poll Interval (s)</label>
              <Input type="number" value={pollInterval} onChange={(e) => setPollInterval(parseInt(e.target.value) || 60)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Expansion Window</label>
              <Input type="number" value={expansionWindow} onChange={(e) => setExpansionWindow(parseInt(e.target.value) || 3)} className={inputCls} />
            </div>
          </>
        )}

        {/* Straddle-specific */}
        {meta.key === 'nifty_value_imbalance_straddle' && (
          <div className={fieldCls}>
            <label className={lbl}>Balance Threshold (%)</label>
            <Input type="number" step="0.5" value={entryBalanceThreshold} onChange={(e) => setEntryBalanceThreshold(parseFloat(e.target.value) || 15.0)} className={inputCls} />
          </div>
        )}

        {/* VWAP shared params (both tick and candle variants) */}
        {(meta.key === 'nifty_tick_mean_straddle' || meta.key === 'nifty_vwap_1min_straddle') && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Entry Band (pts)</label>
              <Input type="number" step="0.5" value={entryBand} onChange={(e) => setEntryBand(parseFloat(e.target.value) || 5.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Decline Ticks</label>
              <Input type="number" value={declineTicks} onChange={(e) => setDeclineTicks(parseInt(e.target.value) || 5)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Exit Buffer (pts)</label>
              <Input type="number" step="0.5" value={exitBuffer} onChange={(e) => setExitBuffer(parseFloat(e.target.value) || 10.0)} className={inputCls} />
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Max Premium Diff (%)</label>
              <Input type="number" step="0.5" value={maxPremiumDiff} onChange={(e) => setMaxPremiumDiff(parseFloat(e.target.value) || 15.0)} className={inputCls} />
            </div>
            {meta.key === 'nifty_tick_mean_straddle' && (
              <div className={fieldCls}>
                <label className={lbl}>Warmup (ticks)</label>
                <Input type="number" value={vwapWarmup} onChange={(e) => setVwapWarmup(parseInt(e.target.value) || 60)} className={inputCls} />
              </div>
            )}
            {meta.key === 'nifty_vwap_1min_straddle' && (
              <div className={fieldCls}>
                <label className={lbl}>VWAP Warmup (bars)</label>
                <Input type="number" value={vwapWarmupBars} onChange={(e) => setVwapWarmupBars(parseInt(e.target.value) || 10)} className={inputCls} />
              </div>
            )}
          </>
        )}

        {meta.key === 'nifty_advanced_imbalance' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Mode</label>
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
                <label className={lbl}>Ratio Lots</label>
                <Input type="number" value={loserRatioLots} onChange={(e) => setLoserRatioLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} />
              </div>
            )}
            {mode === 'reentry_straddle' && (
              <>
                <div className={fieldCls}>
                  <label className={lbl}>Trail Buffer (pts)</label>
                  <Input type="number" step="0.5" value={trailCombinedBuffer} onChange={(e) => setTrailCombinedBuffer(parseFloat(e.target.value) || 1.0)} min={0.1} className={inputCls} />
                </div>
                <div className={fieldCls}>
                  <label className={lbl}>Leg SL (%)</label>
                  <Input type="number" step="1" value={Math.round(legSlPct * 100)} onChange={(e) => setLegSlPct((parseInt(e.target.value) || 20) / 100)} min={1} max={100} className={inputCls} />
                </div>
              </>
            )}
            {mode !== 'reentry_straddle' && (
              <div className={fieldCls}>
                <label className={lbl}>Entry Type</label>
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

        {(meta.key === 'nifty_value_imbalance_strangle' ||
          (meta.key === 'nifty_advanced_imbalance' && entryType === 'strangle' && mode !== 'reentry_straddle')) && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Strike Selection</label>
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
                  <label className={lbl}>CE Offset (pts)</label>
                  <Input type="number" value={ceOffset} onChange={(e) => setCeOffset(parseInt(e.target.value) || 200)} className={inputCls} />
                </div>
                <div className={fieldCls}>
                  <label className={lbl}>PE Offset (pts)</label>
                  <Input type="number" value={peOffset} onChange={(e) => setPeOffset(parseInt(e.target.value) || 200)} className={inputCls} />
                </div>
              </>
            )}
            {strikeSelection === 'delta' && (
              <div className={fieldCls}>
                <label className={lbl}>Target Delta</label>
                <Input type="number" step="0.01" value={targetDelta} onChange={(e) => setTargetDelta(parseFloat(e.target.value) || 0.20)} className={inputCls} />
              </div>
            )}
            {strikeSelection === 'premium' && (
              <div className={fieldCls}>
                <label className={lbl}>Target Premium ₹</label>
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
                  disabled={submitting}
                  className="h-6 px-2.5 gap-1 bg-emerald-600/80 hover:bg-emerald-500/80 text-white font-bold rounded-md text-[10px] border-0 shadow-none active:scale-95 transition-all duration-150"
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
                  </div>
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
                disabled={submitting}
                className="flex-1 h-8 gap-1.5 bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold rounded-lg shadow-md shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-[0.98] transition-all duration-150 text-xs border-0"
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
