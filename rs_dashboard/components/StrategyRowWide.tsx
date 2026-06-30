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

interface StrategyMeta { key: string; name: string }

interface StrategyState {
  strategy: string; status: string; pid?: number; dry_run?: boolean;
  lots?: number; max_lots?: number; loser_ratio_lots?: number;
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
  combined_best_premium?: number | null; trail_combined_buffer?: number; leg_sl_pct?: number;
  use_ema?: boolean; use_supertrend?: boolean;
}

interface Props { meta: StrategyMeta; state: StrategyState; onRefresh: () => void }

export default function StrategyRowWide({ meta, state, onRefresh }: Props) {
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmTimeoutId, setConfirmTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  // --- Config state (mirrors StrategyCard) ---
  const [isLive, setIsLive] = useState(false);
  const [lots, setLots] = useState(1);
  const [profitTarget, setProfitTarget] = useState(4000);
  const [stopLoss, setStopLoss] = useState(4000);
  const [startTime, setStartTime] = useState('09:20');
  const [maxLots, setMaxLots] = useState(4);
  const [mode, setMode] = useState('winner_roll_atm');
  const [loserRatioLots, setLoserRatioLots] = useState(1);
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
  const [vwapWarmup, setVwapWarmup] = useState(60);
  const [vwapWarmupBars, setVwapWarmupBars] = useState(10);
  const [pcrThreshold, setPcrThreshold] = useState(1.5);
  const [exitPcrChange, setExitPcrChange] = useState(30);
  const [pollInterval, setPollInterval] = useState(60);
  const [expansionWindow, setExpansionWindow] = useState(3);
  const [trailCombinedBuffer, setTrailCombinedBuffer] = useState(1.0);
  const [legSlPct, setLegSlPct] = useState(0.20);
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
        if (!useEma) args.push('--no-ema');
        if (!useSupertrend) args.push('--no-supertrend');
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
    INITIALIZING: { dot: 'bg-amber-400',   text: 'text-amber-400',   badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  };
  const statusCfg = STATUS_MAP[state.status];

  const lbl = 'text-[9px] text-zinc-300 uppercase tracking-wider font-semibold leading-none mb-0.5';
  const val = 'font-mono font-bold text-xs text-white leading-tight';
  const fieldCls = 'flex flex-col gap-1';
  const inputCls = 'bg-zinc-900/80 border-zinc-800 text-white font-mono h-7 text-xs';

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
          {state.max_lots != null && <div className="text-[9px] text-zinc-300 font-mono">max {state.max_lots}L</div>}
        </div>
      </div>
    );
  };

  /* ── CONFIG PANEL ─────────────────────────────────────────── */
  const configPanel = (
    <div className="border-t border-zinc-800/60 px-4 py-3 bg-zinc-950/60">
      <div className="flex flex-wrap gap-2.5 text-xs">
        <div className={fieldCls}>
          <label className={lbl}>Execution</label>
          <div className="flex items-center gap-2 h-7">
            <input type="checkbox" id={`live-${meta.key}`} checked={isLive} onChange={e => setIsLive(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
            <label htmlFor={`live-${meta.key}`} className="text-white font-semibold flex items-center gap-1 text-xs">
              LIVE {isLive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />}
            </label>
          </div>
        </div>

        <div className={fieldCls}>
          <label className={lbl}>Lots</label>
          <Input type="number" value={lots} onChange={e => setLots(parseInt(e.target.value) || 1)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
        </div>

        {(meta.key === 'nifty_advanced_imbalance' || meta.key === 'nifty_value_imbalance_straddle' || meta.key === 'nifty_value_imbalance_strangle') && (
          <div className={fieldCls}>
            <label className={lbl}>Max Lots</label>
            <Input type="number" value={maxLots} onChange={e => setMaxLots(parseInt(e.target.value) || 4)} min={1} max={20} className={inputCls} style={{ width: 64 }} />
          </div>
        )}

        {meta.key !== 'nifty_spread_trend' && (
          <div className={fieldCls}>
            <label className={lbl}>Start Time</label>
            <Input type="text" value={startTime} onChange={e => setStartTime(e.target.value)} placeholder="09:20" className={inputCls} style={{ width: 72 }} />
          </div>
        )}

        <div className={fieldCls}>
          <label className={lbl}>Target ₹</label>
          <Input type="number" value={profitTarget} onChange={e => setProfitTarget(parseInt(e.target.value) || 1000)} className={inputCls} style={{ width: 80 }} />
        </div>

        <div className={fieldCls}>
          <label className={lbl}>Stop Loss ₹</label>
          <Input type="number" value={stopLoss} onChange={e => setStopLoss(parseInt(e.target.value) || 1000)} className={inputCls} style={{ width: 80 }} />
        </div>

        {meta.key === 'nifty_spread_trend' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Symbol</label>
              <Select value={symbol} onValueChange={v => v && setSymbol(v)}>
                <SelectTrigger className={inputCls} style={{ width: 110 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="NIFTY">NIFTY</SelectItem>
                  <SelectItem value="BANKNIFTY">BANKNIFTY</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}>
              <label className={lbl}>Timeframe</label>
              <Select value={interval} onValueChange={v => v && setIntervalVal(v)}>
                <SelectTrigger className={inputCls} style={{ width: 90 }}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['1','5','15','30','60'].map(v => <SelectItem key={v} value={v}>{v === '60' ? '1 Hr' : `${v} Min`}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className={fieldCls}><label className={lbl}>Spread (pts)</label><Input type="number" value={spreadWidth} onChange={e => setSpreadWidth(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>CE Offset</label><Input type="number" value={ceOffset} onChange={e=>setCeOffset(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>PE Offset</label><Input type="number" value={peOffset} onChange={e=>setPeOffset(parseInt(e.target.value)||100)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input type="checkbox" id={`use-ema-${meta.key}`} checked={useEma} onChange={e => setUseEma(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`use-ema-${meta.key}`} className={lbl}>EMA</label>
              </div>
              {useEma && <Input type="number" value={emaPeriod} onChange={e=>setEmaPeriod(parseInt(e.target.value)||20)} className={inputCls} style={{width:64}} placeholder="Period"/>}
            </div>
            <div className={fieldCls}>
              <div className="flex items-center gap-2 h-5">
                <input type="checkbox" id={`use-st-${meta.key}`} checked={useSupertrend} onChange={e => setUseSupertrend(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`use-st-${meta.key}`} className={lbl}>Supertrend</label>
              </div>
              {useSupertrend && <>
                <Input type="number" value={supertrendPeriod} onChange={e=>setSupertrendPeriod(parseInt(e.target.value)||7)} className={inputCls} style={{width:64}} placeholder="Period"/>
                <Input type="number" step="0.5" value={supertrendMultiplier} onChange={e=>setSupertrendMultiplier(parseFloat(e.target.value)||3.0)} className={inputCls} style={{width:64}} placeholder="Multi"/>
              </>}
            </div>
            {spreadTrendNoIndicators && (
              <div className="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-400 font-medium">
                Enable at least one indicator to launch.
              </div>
            )}
            <div className={fieldCls}><label className={lbl}>EOD Time</label><Input type="text" value={eodTime} onChange={e=>setEodTime(e.target.value)} placeholder="15:15" className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>Cooldown (min)</label><Input type="number" value={cooldownMinutes} onChange={e=>setCooldownMinutes(parseInt(e.target.value)||5)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}>
              <label className={lbl}>Exit on Signal</label>
              <div className="flex items-center gap-2 h-7">
                <input type="checkbox" id={`exit-sig-${meta.key}`} checked={exitOnSignalChange} onChange={e=>setExitOnSignalChange(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-800 bg-zinc-900 accent-emerald-500" />
                <label htmlFor={`exit-sig-${meta.key}`} className="text-white font-semibold text-xs">Enabled</label>
              </div>
            </div>
          </>
        )}

        {meta.key === 'nifty_oi_directional' && (
          <>
            <div className={fieldCls}><label className={lbl}>PCR Threshold</label><Input type="number" step="0.1" value={pcrThreshold} onChange={e=>setPcrThreshold(parseFloat(e.target.value)||1.5)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>Exit PCR Chg%</label><Input type="number" value={exitPcrChange} onChange={e=>setExitPcrChange(parseInt(e.target.value)||30)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>Poll (s)</label><Input type="number" value={pollInterval} onChange={e=>setPollInterval(parseInt(e.target.value)||60)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><label className={lbl}>Exp Window</label><Input type="number" value={expansionWindow} onChange={e=>setExpansionWindow(parseInt(e.target.value)||3)} className={inputCls} style={{width:64}}/></div>
          </>
        )}

        {meta.key === 'nifty_value_imbalance_straddle' && (
          <div className={fieldCls}><label className={lbl}>Bal Threshold%</label><Input type="number" step="0.5" value={entryBalanceThreshold} onChange={e=>setEntryBalanceThreshold(parseFloat(e.target.value)||15.0)} className={inputCls} style={{width:80}}/></div>
        )}

        {(meta.key === 'nifty_tick_mean_straddle' || meta.key === 'nifty_vwap_1min_straddle') && (
          <>
            <div className={fieldCls}><label className={lbl}>Entry Band</label><Input type="number" step="0.5" value={entryBand} onChange={e=>setEntryBand(parseFloat(e.target.value)||5.0)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>Decline Ticks</label><Input type="number" value={declineTicks} onChange={e=>setDeclineTicks(parseInt(e.target.value)||5)} className={inputCls} style={{width:64}}/></div>
            <div className={fieldCls}><label className={lbl}>Exit Buffer</label><Input type="number" step="0.5" value={exitBuffer} onChange={e=>setExitBuffer(parseFloat(e.target.value)||10.0)} className={inputCls} style={{width:72}}/></div>
            <div className={fieldCls}><label className={lbl}>Max Prem Diff%</label><Input type="number" step="0.5" value={maxPremiumDiff} onChange={e=>setMaxPremiumDiff(parseFloat(e.target.value)||15.0)} className={inputCls} style={{width:80}}/></div>
            {meta.key === 'nifty_tick_mean_straddle' && (
              <div className={fieldCls}><label className={lbl}>Warmup (ticks)</label><Input type="number" value={vwapWarmup} onChange={e=>setVwapWarmup(parseInt(e.target.value)||60)} className={inputCls} style={{width:80}}/></div>
            )}
            {meta.key === 'nifty_vwap_1min_straddle' && (
              <div className={fieldCls}><label className={lbl}>Warmup (bars)</label><Input type="number" value={vwapWarmupBars} onChange={e=>setVwapWarmupBars(parseInt(e.target.value)||10)} className={inputCls} style={{width:80}}/></div>
            )}
          </>
        )}

        {meta.key === 'nifty_advanced_imbalance' && (
          <>
            <div className={fieldCls}>
              <label className={lbl}>Mode</label>
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
              <div className={fieldCls}><label className={lbl}>Ratio Lots</label><Input type="number" value={loserRatioLots} onChange={e=>setLoserRatioLots(parseInt(e.target.value)||1)} min={1} max={20} className={inputCls} style={{width:64}}/></div>
            )}
            {mode === 'reentry_straddle' && (
              <>
                <div className={fieldCls}><label className={lbl}>Trail Buffer</label><Input type="number" step="0.5" value={trailCombinedBuffer} onChange={e=>setTrailCombinedBuffer(parseFloat(e.target.value)||1.0)} min={0.1} className={inputCls} style={{width:72}}/></div>
                <div className={fieldCls}><label className={lbl}>Leg SL%</label><Input type="number" step="1" value={Math.round(legSlPct*100)} onChange={e=>setLegSlPct((parseInt(e.target.value)||20)/100)} min={1} max={100} className={inputCls} style={{width:64}}/></div>
              </>
            )}
            {mode !== 'reentry_straddle' && (
              <div className={fieldCls}>
                <label className={lbl}>Entry Type</label>
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
              <label className={lbl}>Strike Selection</label>
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
                <div className={fieldCls}><label className={lbl}>CE Offset</label><Input type="number" value={ceOffset} onChange={e=>setCeOffset(parseInt(e.target.value)||200)} className={inputCls} style={{width:72}}/></div>
                <div className={fieldCls}><label className={lbl}>PE Offset</label><Input type="number" value={peOffset} onChange={e=>setPeOffset(parseInt(e.target.value)||200)} className={inputCls} style={{width:72}}/></div>
              </>
            )}
            {strikeSelection === 'delta' && (
              <div className={fieldCls}><label className={lbl}>Target Delta</label><Input type="number" step="0.01" value={targetDelta} onChange={e=>setTargetDelta(parseFloat(e.target.value)||0.20)} className={inputCls} style={{width:72}}/></div>
            )}
            {strikeSelection === 'premium' && (
              <div className={fieldCls}><label className={lbl}>Target Prem ₹</label><Input type="number" value={targetPremium} onChange={e=>setTargetPremium(parseFloat(e.target.value)||50.0)} className={inputCls} style={{width:80}}/></div>
            )}
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
