'use client';

import React, { useState, useRef, useMemo } from 'react';
import {
  Wallet,
  Clock,
  Shield,
  ShieldAlert,
  Zap,
  CheckCircle2,
  TrendingUp,
  AlertTriangle,
  Flame,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { cyberAudio } from '@/lib/cyberAudio';

export interface PositionItem {
  id: string;
  tradingSymbol: string;
  securityId?: string;
  productType: string;
  exchangeSegment: string;
  netQty: number;
  buyAvg: number;
  sellAvg?: number;
  avgPrice: number;
  ltp: number;
  pnl: number;
  points: number;
  side: 'BUY' | 'SELL';
  openedAt?: string;
}

export interface PositionGuard {
  target: string;        // target price (₹)
  sl: string;            // stop-loss price (₹)
  trailEnabled: boolean; // whether trailing SL is enabled
  bestPrice: number;     // peak price achieved (highest for long, lowest for short)
  triggered: boolean;    // lock to prevent double execution while exit is in flight
}

export interface ScalpLogItem {
  id: string;
  time: string;
  type: 'BUY' | 'SELL' | 'EXIT' | 'ERROR';
  message: string;
  detail?: string;
}

// Quick presets for Target and Stop Loss (in points)
const TARGET_PRESET_PTS = [5, 10, 20, 30];
const SL_PRESET_PTS = [5, 10, 15, 25];

interface CyberGuardInputProps {
  value: string;
  onCommit: (val: string) => void;
  colorCls: string;
  focusBorderCls: string;
  placeholder?: string;
  disabled?: boolean;
}

function CyberGuardInput({
  value,
  onCommit,
  colorCls,
  focusBorderCls,
  placeholder = '---',
  disabled = false,
}: CyberGuardInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);

  const updateDraft = (v: string | null) => {
    draftRef.current = v;
    setDraft(v);
  };

  const commit = () => {
    const d = draftRef.current;
    if (d !== null && d !== value) {
      onCommit(d);
    }
    updateDraft(null);
  };

  const displayVal = draft !== null ? draft : value;
  const isDirty = draft !== null && draft !== value;

  return (
    <input
      type="number"
      step="0.05"
      min="0"
      disabled={disabled}
      placeholder={placeholder}
      value={displayVal}
      onChange={(e) => updateDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          updateDraft(null);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'w-20 py-1 px-1.5 text-center rounded-lg bg-zinc-950 border font-mono text-xs font-bold transition-all focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed',
        isDirty ? 'border-amber-500 text-amber-300' : 'border-zinc-800 text-zinc-200',
        colorCls,
        focusBorderCls
      )}
    />
  );
}

interface PositionsPanelProps {
  positions: PositionItem[];
  logs: ScalpLogItem[];
  guards: Record<string, PositionGuard>;
  onGuardChange: (posKey: string, field: 'target' | 'sl', val: string) => void;
  onToggleTrail: (posKey: string) => void;
  onSetPresetPts: (pos: PositionItem, type: 'TP' | 'SL', pts: number) => void;
  onToggleTrailAll?: () => void;
  onClosePosition: (pos: PositionItem) => Promise<void>;
  onFlattenAll: () => Promise<void>;
  isExecuting: boolean;
}

export default function CyberPositionsPanel({
  positions,
  logs,
  guards,
  onGuardChange,
  onToggleTrail,
  onSetPresetPts,
  onToggleTrailAll,
  onClosePosition,
  onFlattenAll,
  isExecuting,
}: PositionsPanelProps) {
  // Pin each position to the order it was first seen in, so rows never jump or
  // reshuffle across ticks as broker payloads arrive.
  const rowOrderRef = useRef<Map<string, number>>(new Map());
  const nextOrderRef = useRef(0);

  const activePositions = useMemo(() => {
    const active = positions.filter((p) => p.netQty !== 0);
    const order = rowOrderRef.current;
    for (const p of active) {
      const key = `${p.tradingSymbol || p.id}_${p.productType}`;
      if (!order.has(key)) {
        order.set(key, nextOrderRef.current++);
      }
    }
    return [...active].sort((a, b) => {
      const keyA = `${a.tradingSymbol || a.id}_${a.productType}`;
      const keyB = `${b.tradingSymbol || b.id}_${b.productType}`;
      return (order.get(keyA) ?? 0) - (order.get(keyB) ?? 0);
    });
  }, [positions]);

  const openCount = activePositions.length;
  const totalPnl = activePositions.reduce((sum, p) => sum + (p.pnl || 0), 0);

  const allTrailingActive =
    openCount > 0 && activePositions.every((p) => guards[p.id]?.trailEnabled);

  const fmtRupees = (v: number) =>
    `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
      {/* Positions Table (3 cols on large screen) */}
      <div className="lg:col-span-3 bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 lg:p-5 backdrop-blur-md flex flex-col justify-between shadow-xl">
        <div>
          {/* Header Bar */}
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                <Wallet className="w-4 h-4" />
              </div>
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                ACTIVE SCALPING POSITIONS ({openCount})
              </h3>
            </div>

            {/* Quick Actions & Total MTM */}
            <div className="flex items-center gap-2 flex-wrap">
              {openCount > 0 && onToggleTrailAll && (
                <button
                  onClick={onToggleTrailAll}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold border transition-all flex items-center gap-1 active:scale-95',
                    allTrailingActive
                      ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300 shadow-sm shadow-cyan-500/20'
                      : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-400 hover:text-white'
                  )}
                  title="Toggle Trailing Stop Loss on all open positions"
                >
                  <Shield className="w-3 h-3" />
                  <span>{allTrailingActive ? 'ALL TRAIL ON' : 'TRAIL ALL'}</span>
                </button>
              )}

              {openCount > 0 && (
                <button
                  onClick={() => {
                    cyberAudio.exit();
                    onFlattenAll();
                  }}
                  disabled={isExecuting}
                  className="px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold bg-rose-950/60 hover:bg-rose-900 border border-rose-700/60 text-rose-300 transition-all flex items-center gap-1 active:scale-95 disabled:opacity-50"
                  title="Emergency square off all positions immediately"
                >
                  <XCircle className="w-3 h-3" />
                  <span>FLATTEN ALL</span>
                </button>
              )}

              <div className="flex items-center gap-1.5 pl-1">
                <span className="text-[10px] font-mono text-zinc-400 uppercase">TOTAL MTM:</span>
                <span
                  className={cn(
                    'text-xs font-mono font-black px-2.5 py-0.5 rounded-lg border',
                    totalPnl >= 0
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-sm shadow-emerald-500/10'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-400 shadow-sm shadow-rose-500/10'
                  )}
                >
                  {fmtRupees(totalPnl)}
                </span>
              </div>
            </div>
          </div>

          {/* Table */}
          {openCount === 0 ? (
            <div className="py-12 text-center text-zinc-500 font-mono text-xs flex flex-col items-center justify-center gap-2">
              <Zap className="w-6 h-6 text-zinc-700 animate-pulse" />
              <span className="font-bold text-zinc-400">NO ACTIVE SCALPING POSITIONS</span>
              <span className="text-[11px] text-zinc-600">
                Place an instant trade above or hit hotkey [B] (ATM Call) or [S] (ATM Put)
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-800/90 text-[11px] font-bold text-white uppercase tracking-wider">
                    <th className="py-2.5 px-3">Contract</th>
                    <th className="py-2.5 px-2">Side</th>
                    <th className="py-2.5 px-2 text-right">Qty</th>
                    <th className="py-2.5 px-2 text-right">Avg Price</th>
                    <th className="py-2.5 px-2 text-right">LTP</th>
                    <th className="py-2.5 px-2 text-right">Pts</th>
                    <th className="py-2.5 px-3 text-right">P&L</th>
                    <th className="py-2.5 px-3 text-center text-emerald-400">Target (TP)</th>
                    <th className="py-2.5 px-3 text-center text-rose-400">Stop Loss (SL)</th>
                    <th className="py-2.5 px-3 text-center text-cyan-400">Trailing SL</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-xs">
                  {activePositions.map((pos) => {
                    const isProfit = pos.pnl >= 0;
                    const isLong = pos.netQty > 0;
                    const guard = guards[pos.id];
                    const entryPrice = pos.avgPrice > 0 ? pos.avgPrice : (isLong ? pos.buyAvg : (pos.sellAvg || 0));

                    // Target calculation & display
                    const targetNum = parseFloat(guard?.target ?? '');
                    const hasTarget = !isNaN(targetNum) && targetNum > 0 && entryPrice > 0;
                    const targetDiff = hasTarget ? (isLong ? targetNum - entryPrice : entryPrice - targetNum) : null;
                    const targetRupees = targetDiff !== null ? targetDiff * Math.abs(pos.netQty) : null;

                    // SL calculation & display
                    const slNum = parseFloat(guard?.sl ?? '');
                    const hasSl = !isNaN(slNum) && slNum > 0 && entryPrice > 0;
                    const slDiff = hasSl ? (isLong ? entryPrice - slNum : slNum - entryPrice) : null;
                    const slRupees = slDiff !== null ? slDiff * Math.abs(pos.netQty) : null;

                    // Trailing SL evaluation display
                    const isTrailing = Boolean(guard?.trailEnabled);
                    const trailBest = guard?.bestPrice ?? 0;
                    const initialRisk = hasSl && entryPrice > 0 ? Math.abs(entryPrice - slNum) : 0;
                    const effectiveTrailFloor = (isTrailing && trailBest > 0 && initialRisk > 0)
                      ? (isLong ? trailBest - initialRisk : trailBest + initialRisk)
                      : null;

                    return (
                      <tr
                        key={pos.id}
                        className={cn(
                          'hover:bg-zinc-800/30 transition-colors',
                          guard?.triggered && 'bg-rose-950/20'
                        )}
                      >
                        {/* Contract */}
                        <td className="py-3 px-3 text-white font-bold whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            {isTrailing && (
                              <span
                                className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shrink-0"
                                title="Trailing SL active"
                              />
                            )}
                            <span>{pos.tradingSymbol}</span>
                            <span className="text-[9px] font-normal px-1 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                              {pos.productType || 'INTRADAY'}
                            </span>
                          </div>
                        </td>

                        {/* Side */}
                        <td className="py-3 px-2">
                          <span
                            className={cn(
                              'px-2 py-0.5 rounded text-[10px] font-bold tracking-wide',
                              isLong
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            )}
                          >
                            {isLong ? 'LONG' : 'SHORT'}
                          </span>
                        </td>

                        {/* Qty */}
                        <td className="py-3 px-2 text-right text-zinc-200 font-bold tabular-nums">
                          {Math.abs(pos.netQty)}
                        </td>

                        {/* Avg Price */}
                        <td className="py-3 px-2 text-right text-zinc-300 font-medium tabular-nums">
                          {entryPrice > 0 ? `₹${entryPrice.toFixed(2)}` : '---'}
                        </td>

                        {/* LTP */}
                        <td className="py-3 px-2 text-right text-white font-bold tabular-nums">
                          {pos.ltp > 0 ? `₹${pos.ltp.toFixed(2)}` : '---'}
                        </td>

                        {/* Pts */}
                        <td
                          className={cn(
                            'py-3 px-2 text-right font-bold tabular-nums',
                            pos.points >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          )}
                        >
                          {pos.points >= 0 ? `+${pos.points.toFixed(2)}` : pos.points.toFixed(2)}
                        </td>

                        {/* P&L */}
                        <td
                          className={cn(
                            'py-3 px-3 text-right font-black whitespace-nowrap tabular-nums text-sm',
                            isProfit ? 'text-emerald-400' : 'text-rose-400'
                          )}
                        >
                          {fmtRupees(pos.pnl)}
                        </td>

                        {/* Target (TP) Input & Presets */}
                        <td className="py-3 px-3">
                          <div className="flex flex-col items-center gap-1">
                            <CyberGuardInput
                              value={guard?.target ?? ''}
                              onCommit={(v) => onGuardChange(pos.id, 'target', v)}
                              colorCls="text-emerald-300"
                              focusBorderCls="focus:border-emerald-500"
                              placeholder="TP Price"
                              disabled={isExecuting}
                            />
                            {/* Preset Buttons */}
                            <div className="flex items-center gap-1">
                              {TARGET_PRESET_PTS.map((pts) => (
                                <button
                                  key={`tp-${pts}`}
                                  disabled={isExecuting || entryPrice <= 0}
                                  onClick={() => onSetPresetPts(pos, 'TP', pts)}
                                  className="px-1 py-0.2 rounded bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-800/70 text-emerald-400 text-[9px] font-bold transition-all disabled:opacity-30 active:scale-95"
                                  title={`Set Target to +${pts} pts (₹${(isLong ? entryPrice + pts : entryPrice - pts).toFixed(2)})`}
                                >
                                  +{pts}
                                </button>
                              ))}
                            </div>
                            {/* Target Subtext */}
                            {targetDiff !== null && targetRupees !== null && (
                              <span className="text-[9px] font-mono text-emerald-400/90 whitespace-nowrap">
                                +{targetDiff.toFixed(1)} pts (+₹{targetRupees.toFixed(0)})
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Stop Loss (SL) Input & Presets */}
                        <td className="py-3 px-3">
                          <div className="flex flex-col items-center gap-1">
                            <CyberGuardInput
                              value={guard?.sl ?? ''}
                              onCommit={(v) => onGuardChange(pos.id, 'sl', v)}
                              colorCls="text-rose-300"
                              focusBorderCls="focus:border-rose-500"
                              placeholder="SL Price"
                              disabled={isExecuting}
                            />
                            {/* Preset Buttons */}
                            <div className="flex items-center gap-1">
                              {SL_PRESET_PTS.map((pts) => (
                                <button
                                  key={`sl-${pts}`}
                                  disabled={isExecuting || entryPrice <= 0}
                                  onClick={() => onSetPresetPts(pos, 'SL', pts)}
                                  className="px-1 py-0.2 rounded bg-rose-950/80 hover:bg-rose-900 border border-rose-800/70 text-rose-400 text-[9px] font-bold transition-all disabled:opacity-30 active:scale-95"
                                  title={`Set Stop Loss to -${pts} pts (₹${(isLong ? entryPrice - pts : entryPrice + pts).toFixed(2)})`}
                                >
                                  -{pts}
                                </button>
                              ))}
                            </div>
                            {/* SL Subtext */}
                            {slDiff !== null && slRupees !== null && (
                              <span className="text-[9px] font-mono text-rose-400/90 whitespace-nowrap">
                                -{slDiff.toFixed(1)} pts (-₹{slRupees.toFixed(0)})
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Trailing SL Toggle Button */}
                        <td className="py-3 px-3 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <button
                              onClick={() => onToggleTrail(pos.id)}
                              disabled={isExecuting}
                              className={cn(
                                'px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all flex items-center gap-1 active:scale-95',
                                isTrailing
                                  ? 'bg-cyan-500/20 border-cyan-500/60 text-cyan-300 shadow-sm shadow-cyan-500/20'
                                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
                              )}
                              title={isTrailing ? 'Click to disable Trailing SL' : 'Click to enable Trailing SL (trails 1:1 with profit from SL)'}
                            >
                              <Shield className={cn('w-3 h-3', isTrailing && 'text-cyan-400')} />
                              <span>{isTrailing ? 'TRAIL ON' : 'TRAIL OFF'}</span>
                            </button>

                            {/* Effective Trailing Floor */}
                            {effectiveTrailFloor !== null && isTrailing ? (
                              <span className="text-[9px] font-mono text-cyan-400 font-bold whitespace-nowrap">
                                Floor: ₹{effectiveTrailFloor.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-[9px] font-mono text-zinc-600">
                                {isTrailing ? 'Arming on SL' : 'Inactive'}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Square Off Button */}
                        <td className="py-3 px-3 text-right whitespace-nowrap">
                          <button
                            onClick={() => {
                              cyberAudio.click();
                              onClosePosition(pos);
                            }}
                            disabled={isExecuting}
                            className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/50 border border-zinc-700 text-zinc-300 text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50"
                            title="Square off this leg instantly at market"
                          >
                            SQUARE OFF
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Cyber Scalp Telemetry Log (1 col on large screen) */}
      <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-4 lg:p-5 backdrop-blur-md flex flex-col justify-between h-full shadow-xl">
        <div>
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="p-1 rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-400">
                <Clock className="w-4 h-4" />
              </div>
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                EXECUTION TELEMETRY
              </h3>
            </div>
            <span className="text-[10px] font-mono text-zinc-500 flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              <span>LIVE BUS</span>
            </span>
          </div>

          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {logs.length === 0 ? (
              <div className="py-12 text-center text-zinc-500 font-mono text-xs">
                AWAITING FIRST TRADE EXECUTION
              </div>
            ) : (
              logs.slice(0, 15).map((log) => (
                <div
                  key={log.id}
                  className="p-2 rounded-xl bg-zinc-950/80 border border-zinc-800/80 text-[11px] font-mono flex items-start gap-2 shadow-sm"
                >
                  <span
                    className={cn(
                      'px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 mt-0.5',
                      log.type === 'BUY'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : log.type === 'SELL'
                        ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        : log.type === 'EXIT'
                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                        : 'bg-red-500/20 text-red-400 border border-red-500/30'
                    )}
                  >
                    {log.type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-zinc-200 font-semibold truncate">{log.message}</p>
                    {log.detail && (
                      <p className="text-zinc-500 text-[10px] truncate">{log.detail}</p>
                    )}
                  </div>
                  <span className="text-[9px] text-zinc-600 shrink-0">{log.time}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
