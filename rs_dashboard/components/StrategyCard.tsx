'use client';

import React, { useState } from 'react';
import { Play, Square, Settings, Activity, ShieldAlert, Award } from 'lucide-react';
import LogConsole from './LogConsole';

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

  // Configuration form state
  const [isLive, setIsLive] = useState<boolean>(false);
  const [lots, setLots] = useState<number>(1);
  const [profitTarget, setProfitTarget] = useState<number>(4000);
  const [stopLoss, setStopLoss] = useState<number>(4000);
  const [startTime, setStartTime] = useState<string>('09:20');

  // Strategy specific configurations
  const [mode, setMode] = useState<string>('winner_roll_atm'); // for advanced
  const [entryType, setEntryType] = useState<string>('straddle'); // straddle vs strangle
  const [strikeSelection, setStrikeSelection] = useState<string>('distance'); // distance, delta, premium
  const [ceOffset, setCeOffset] = useState<number>(200);
  const [peOffset, setPeOffset] = useState<number>(200);
  const [targetDelta, setTargetDelta] = useState<number>(0.20);
  const [targetPremium, setTargetPremium] = useState<number>(50.0);
  
  // Nifty Spread specific configs
  const [symbol, setSymbol] = useState<string>('NIFTY');
  const [interval, setIntervalVal] = useState<string>('5');
  const [spreadWidth, setSpreadWidth] = useState<number>(100);

  const isRunning = state.status !== 'STOPPED';

  const handleStart = async () => {
    setSubmitting(true);
    try {
      const args: string[] = [];
      
      // Live vs Dry run
      if (isLive) args.push('--live');
      
      // Sizing
      args.push('--lots');
      args.push(String(lots));

      // Global Targets
      args.push('--target-profit');
      args.push(String(profitTarget));
      args.push('--stop-loss');
      args.push(String(stopLoss));

      // Build parameters based on strategy type
      if (meta.key === 'nifty_advanced_imbalance') {
        args.push('--mode');
        args.push(mode);
        args.push('--entry-type');
        args.push(entryType);
        args.push('--start-time');
        args.push(startTime);

        if (entryType === 'strangle') {
          if (strikeSelection === 'delta') {
            args.push('--delta');
            args.push('--target-delta');
            args.push(String(targetDelta));
          } else if (strikeSelection === 'premium') {
            args.push('--premium');
            args.push('--target-premium');
            args.push(String(targetPremium));
          } else {
            args.push('--ce-offset');
            args.push(String(ceOffset));
            args.push('--pe-offset');
            args.push(String(peOffset));
          }
        }
      } else if (meta.key === 'nifty_value_imbalance_straddle') {
        args.push('--start-time');
        args.push(startTime);
      } else if (meta.key === 'nifty_value_imbalance_strangle') {
        args.push('--start-time');
        args.push(startTime);
        
        if (strikeSelection === 'delta') {
          args.push('--delta');
          args.push('--target-delta');
          args.push(String(targetDelta));
        } else if (strikeSelection === 'premium') {
          args.push('--premium');
          args.push('--target-premium');
          args.push(String(targetPremium));
        } else {
          args.push('--ce-offset');
          args.push(String(ceOffset));
          args.push('--pe-offset');
          args.push(String(peOffset));
        }
      } else if (meta.key === 'nifty_spread_trend') {
        args.push('--symbol');
        args.push(symbol);
        args.push('--interval');
        args.push(interval);
        args.push('--ce-offset');
        args.push(String(ceOffset));
        args.push('--pe-offset');
        args.push(String(peOffset));
        args.push('--spread-width');
        args.push(String(spreadWidth));
      }

      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          strategy: meta.key,
          args
        })
      });
      const data = await res.json();
      if (data.success) {
        onRefresh();
        setShowLogs(true);
      } else {
        alert(`Failed to start strategy: ${data.error}`);
      }
    } catch (e) {
      alert(`Error starting strategy: ${e}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      const timer = setTimeout(() => {
        setConfirmStop(false);
      }, 4000);
      setConfirmTimeoutId(timer);
      return;
    }

    if (confirmTimeoutId) {
      clearTimeout(confirmTimeoutId);
      setConfirmTimeoutId(null);
    }
    setConfirmStop(false);
    setSubmitting(true);
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          strategy: meta.key
        })
      });
      const data = await res.json();
      if (data.success) {
        // Poll status updates
        setTimeout(onRefresh, 1500);
      } else {
        alert(`Failed to stop strategy: ${data.error}`);
      }
    } catch (e) {
      alert(`Error stopping strategy: ${e}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Helper styles for status badge
  const getStatusBadge = () => {
    switch (state.status) {
      case 'RUNNING':
        return <span className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />Live</span>;
      case 'BALANCING':
        return <span className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase bg-sky-500/10 text-sky-400 border border-sky-500/20"><span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />Balancing</span>;
      case 'SCANNING':
        return <span className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"><span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />Scanning</span>;
      case 'INITIALIZING':
        return <span className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20"><span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />Initializing</span>;
      default:
        return <span className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold tracking-wide uppercase bg-zinc-800 text-zinc-400 border border-zinc-700/50"><span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />Stopped</span>;
    }
  };

  const pnl = state.total_pnl ?? 0;
  const isPnlPositive = pnl >= 0;

  return (
    <div className={`border rounded-2xl bg-zinc-950/40 backdrop-blur-md transition-all duration-300 flex flex-col overflow-hidden ${
      isRunning ? 'border-zinc-800 shadow-lg shadow-emerald-500/5' : 'border-zinc-900/80'
    }`}>
      {/* Header Panel */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-zinc-900/60 bg-zinc-900/10">
        <div>
          <h3 className="font-bold text-white tracking-wide text-sm sm:text-base flex items-center gap-2">
            {meta.name}
            {isRunning && <span className="text-[10px] text-zinc-500 font-mono font-normal">PID: {state.pid}</span>}
          </h3>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono mt-0.5">
            {meta.key.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {getStatusBadge()}
          <button
            onClick={() => setShowConfig(!showConfig)}
            disabled={isRunning}
            className={`p-2 border rounded-xl transition-all duration-200 ${
              isRunning 
                ? 'opacity-30 border-zinc-900 text-zinc-700' 
                : showConfig 
                  ? 'bg-zinc-900 text-white border-zinc-700' 
                  : 'border-zinc-900 text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
            }`}
            title="Configure Strategy Parameters"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main Stats / Status View */}
      <div className="p-4 flex-1 flex flex-col gap-4">
        {isRunning ? (
          /* Realtime Run Metrics */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-zinc-900 bg-zinc-950/60 p-4 rounded-xl">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Position details</span>
              {meta.key === 'nifty_spread_trend' ? (
                /* Spread position details */
                <div className="mt-1">
                  <div className="text-xs font-bold text-sky-400">{state.active_spread || 'No Active Spread'}</div>
                  <div className="text-[9px] text-zinc-500 mt-0.5 font-mono truncate">
                    Short: {state.short_strike || '-'} | Long: {state.long_strike || '-'}
                  </div>
                </div>
              ) : (
                /* Straddle/Strangle details */
                <div className="mt-1">
                  <div className="text-xs text-zinc-300 font-bold font-mono">
                    CE: {state.ce_strike || '-'} ({state.ce_lots || 0}L)
                  </div>
                  <div className="text-xs text-zinc-300 font-bold font-mono">
                    PE: {state.pe_strike || '-'} ({state.pe_lots || 0}L)
                  </div>
                </div>
              )}
            </div>

            <div className="border border-zinc-900 bg-zinc-950/60 p-4 rounded-xl">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">Execution logs</span>
              <div className="text-lg font-mono font-bold text-zinc-300 mt-1">
                {state.adjustments ?? 0}
              </div>
              <div className="text-[9px] text-zinc-500 mt-1 font-mono">
                Adjustments
              </div>
            </div>
          </div>
        ) : showConfig ? (
          /* Configurations form panel */
          <div className="flex flex-col gap-5 border border-zinc-900 p-5 rounded-xl bg-zinc-950/30">
            <h4 className="text-xs font-bold text-white uppercase tracking-wider border-b border-zinc-900 pb-2">
              Parameters Configuration
            </h4>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-xs">
              {/* Live Run vs Simulation */}
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-500 font-medium">Execution Mode</label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="checkbox"
                    id={`live-${meta.key}`}
                    checked={isLive}
                    onChange={(e) => setIsLive(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-800 bg-zinc-900 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-black"
                  />
                  <label htmlFor={`live-${meta.key}`} className="text-white font-semibold flex items-center gap-1">
                    LIVE order placement
                    {isLive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />}
                  </label>
                </div>
              </div>

              {/* Initial Lots */}
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-500 font-medium">Quantity (Lots)</label>
                <input
                  type="number"
                  value={lots}
                  onChange={(e) => setLots(parseInt(e.target.value) || 1)}
                  min={1}
                  max={20}
                  className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                />
              </div>

              {/* Start monitoring Time */}
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-500 font-medium">Market Start Monitoring Time</label>
                <input
                  type="text"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  placeholder="09:20"
                  className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                />
              </div>

              {/* Target Profit */}
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-500 font-medium">Profit Target (INR)</label>
                <input
                  type="number"
                  value={profitTarget}
                  onChange={(e) => setProfitTarget(parseInt(e.target.value) || 1000)}
                  className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                />
              </div>

              {/* Stop Loss */}
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-500 font-medium">Stop Loss Limit (INR)</label>
                <input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(parseInt(e.target.value) || 1000)}
                  className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                />
              </div>

              {/* Symbol for Spread strategy */}
              {meta.key === 'nifty_spread_trend' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Indices Index Symbol</label>
                    <select
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white"
                    >
                      <option value="NIFTY">NIFTY</option>
                      <option value="BANKNIFTY">BANKNIFTY</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Candle Period Timeframe</label>
                    <select
                      value={interval}
                      onChange={(e) => setIntervalVal(e.target.value)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white"
                    >
                      <option value="1">1 Min</option>
                      <option value="5">5 Min</option>
                      <option value="15">15 Min</option>
                      <option value="30">30 Min</option>
                      <option value="60">1 Hour</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Spread Width (Points)</label>
                    <input
                      type="number"
                      value={spreadWidth}
                      onChange={(e) => setSpreadWidth(parseInt(e.target.value) || 100)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                    />
                  </div>
                </>
              )}

              {/* Advanced Imbalance adjustment modes */}
              {meta.key === 'nifty_advanced_imbalance' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Adjustment Algorithm Mode</label>
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white"
                    >
                      <option value="winner_roll_atm">Winner Roll ATM (Neutral)</option>
                      <option value="loser_ratio_roll">Loser Ratio Roll (Defensive)</option>
                      <option value="hedged_addition">Hedged Winner Addition (Safe)</option>
                      <option value="legacy">Legacy Lot Addition (Naked)</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Strangle vs Straddle Entry</label>
                    <select
                      value={entryType}
                      onChange={(e) => setEntryType(e.target.value)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white"
                    >
                      <option value="straddle">Straddle (ATM Entry)</option>
                      <option value="strangle">Strangle (OTM Entry)</option>
                    </select>
                  </div>
                </>
              )}

              {/* Strike selection for strangle */}
              {(meta.key === 'nifty_value_imbalance_strangle' || (meta.key === 'nifty_advanced_imbalance' && entryType === 'strangle')) && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Strike Selection Strategy</label>
                    <select
                      value={strikeSelection}
                      onChange={(e) => setStrikeSelection(e.target.value)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white"
                    >
                      <option value="distance">Fixed Point Offset</option>
                      <option value="delta">Greek Delta Based</option>
                      <option value="premium">Target Premium Price</option>
                    </select>
                  </div>

                  {strikeSelection === 'distance' && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-zinc-500 font-medium">CE Offset (Points)</label>
                        <input
                          type="number"
                          value={ceOffset}
                          onChange={(e) => setCeOffset(parseInt(e.target.value) || 200)}
                          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-zinc-500 font-medium">PE Offset (Points)</label>
                        <input
                          type="number"
                          value={peOffset}
                          onChange={(e) => setPeOffset(parseInt(e.target.value) || 200)}
                          className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                        />
                      </div>
                    </>
                  )}

                  {strikeSelection === 'delta' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-zinc-500 font-medium">Target Delta (e.g. 0.20)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={targetDelta}
                        onChange={(e) => setTargetDelta(parseFloat(e.target.value) || 0.20)}
                        className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                      />
                    </div>
                  )}

                  {strikeSelection === 'premium' && (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-zinc-500 font-medium">Target Premium Limit (₹)</label>
                      <input
                        type="number"
                        value={targetPremium}
                        onChange={(e) => setTargetPremium(parseFloat(e.target.value) || 50.0)}
                        className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                      />
                    </div>
                  )}
                </>
              )}

              {/* Offset for Spread Trend calls */}
              {meta.key === 'nifty_spread_trend' && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Short CE Offset (Points)</label>
                    <input
                      type="number"
                      value={ceOffset}
                      onChange={(e) => setCeOffset(parseInt(e.target.value) || 100)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-500 font-medium">Short PE Offset (Points)</label>
                    <input
                      type="number"
                      value={peOffset}
                      onChange={(e) => setPeOffset(parseInt(e.target.value) || 100)}
                      className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white font-mono"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          /* Normal stopped standby screen */
          <div className="flex items-center justify-center p-8 rounded-xl border border-dashed border-zinc-900 bg-zinc-950/10 text-zinc-500 text-xs gap-2">
            <Activity className="h-4 w-4 animate-pulse text-zinc-600" />
            Strategy is not running. Configure settings or hit start to launch.
          </div>
        )}

        {/* Buttons Action Bar */}
        <div className="flex items-center gap-3 mt-4 border-t border-zinc-900/60 pt-4">
          {isRunning ? (
            /* Running Stop controls */
            <>
              <button
                onClick={handleStop}
                disabled={submitting}
                className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 border rounded-xl font-semibold active:scale-98 transition-all duration-200 disabled:opacity-50 text-xs sm:text-sm ${
                  confirmStop 
                    ? 'border-rose-500 bg-rose-500/20 text-rose-300 animate-pulse' 
                    : 'border-red-500/25 bg-red-950/20 text-red-400 hover:bg-red-950/30 hover:border-red-500/40'
                }`}
              >
                <Square className={`h-4 w-4 ${confirmStop ? 'fill-rose-300' : 'fill-red-400'}`} />
                <span>{confirmStop ? 'Confirm Square Off & Stop' : 'Square Off & Stop'}</span>
              </button>
              <button
                onClick={() => setShowLogs(!showLogs)}
                className={`px-5 py-3 border rounded-xl font-semibold transition-all text-xs sm:text-sm ${
                  showLogs 
                    ? 'bg-zinc-800 text-white border-zinc-700' 
                    : 'border-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-800'
                }`}
              >
                {showLogs ? 'Hide Console' : 'View Console'}
              </button>
            </>
          ) : (
            /* Stopped Start controls */
            <button
              onClick={handleStart}
              disabled={submitting}
              className="flex-1 flex items-center justify-center gap-2 px-5 py-3 bg-gradient-to-tr from-emerald-600 to-teal-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/10 hover:from-emerald-500 hover:to-teal-400 active:scale-98 transition-all duration-200 disabled:opacity-50 text-xs sm:text-sm"
            >
              <Play className="h-4 w-4 fill-white" />
              <span>Launch Algorithm</span>
            </button>
          )}
        </div>

        {/* Live log panel wrapper */}
        {showLogs && (
          <div className="mt-4 animate-fadeIn">
            <LogConsole strategyKey={meta.key} isActive={isRunning} />
          </div>
        )}
      </div>
    </div>
  );
}
