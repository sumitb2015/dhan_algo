'use client';

import React from 'react';
import {
  Wallet,
  ArrowUpRight,
  ArrowDownRight,
  XCircle,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Flame,
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
  ltp: number;
  pnl: number;
  points: number;
  side: 'BUY' | 'SELL';
  openedAt?: string;
}

export interface ScalpLogItem {
  id: string;
  time: string;
  type: 'BUY' | 'SELL' | 'EXIT' | 'ERROR';
  message: string;
  detail?: string;
}

interface PositionsPanelProps {
  positions: PositionItem[];
  logs: ScalpLogItem[];
  onClosePosition: (pos: PositionItem) => Promise<void>;
  isExecuting: boolean;
}

export default function CyberPositionsPanel({
  positions,
  logs,
  onClosePosition,
  isExecuting,
}: PositionsPanelProps) {
  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const openCount = positions.filter((p) => p.netQty !== 0).length;

  const fmtRupees = (v: number) =>
    `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Positions Table (2 cols on large screen) */}
      <div className="lg:col-span-2 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 lg:p-5 backdrop-blur-md flex flex-col justify-between">
        <div>
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-cyan-400" />
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                ACTIVE SCALPING POSITIONS ({openCount})
              </h3>
            </div>

            {/* Total MTM */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-zinc-400 uppercase">TOTAL MTM:</span>
              <span
                className={cn(
                  'text-sm font-mono font-black px-2.5 py-0.5 rounded-lg border',
                  totalPnl >= 0
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-emerald-500/10'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-400 shadow-rose-500/10'
                )}
              >
                {fmtRupees(totalPnl)}
              </span>
            </div>
          </div>

          {openCount === 0 ? (
            <div className="py-8 text-center text-zinc-500 font-mono text-xs flex flex-col items-center justify-center gap-1">
              <span>NO OPEN SCALP POSITIONS</span>
              <span className="text-[10px] text-zinc-600">
                Hit [B] to Buy ATM Call or [S] to Buy ATM Put
              </span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-800 text-[11px] font-bold text-white uppercase">
                    <th className="py-2 px-3">Contract</th>
                    <th className="py-2 px-3">Side</th>
                    <th className="py-2 px-3">Qty</th>
                    <th className="py-2 px-3">Avg Price</th>
                    <th className="py-2 px-3">LTP</th>
                    <th className="py-2 px-3">Pts</th>
                    <th className="py-2 px-3">P&L</th>
                    <th className="py-2 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 text-xs">
                  {positions
                    .filter((p) => p.netQty !== 0)
                    .map((pos) => {
                      const isProfit = pos.pnl >= 0;
                      return (
                        <tr key={pos.id} className="hover:bg-zinc-800/30 transition-colors">
                          <td className="py-2.5 px-3 text-white font-bold whitespace-nowrap">
                            {pos.tradingSymbol}
                          </td>
                          <td className="py-2.5 px-3">
                            <span
                              className={cn(
                                'px-1.5 py-0.5 rounded text-[10px] font-bold',
                                pos.netQty > 0
                                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                  : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              )}
                            >
                              {pos.netQty > 0 ? 'LONG' : 'SHORT'}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-zinc-300 font-bold">
                            {Math.abs(pos.netQty)}
                          </td>
                          <td className="py-2.5 px-3 text-zinc-400">
                            {pos.buyAvg ? pos.buyAvg.toFixed(2) : '---'}
                          </td>
                          <td className="py-2.5 px-3 text-zinc-200 font-bold">
                            {pos.ltp ? pos.ltp.toFixed(2) : '---'}
                          </td>
                          <td
                            className={cn(
                              'py-2.5 px-3 font-bold',
                              pos.points >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            )}
                          >
                            {pos.points >= 0 ? `+${pos.points.toFixed(2)}` : pos.points.toFixed(2)}
                          </td>
                          <td
                            className={cn(
                              'py-2.5 px-3 font-black whitespace-nowrap',
                              isProfit ? 'text-emerald-400' : 'text-rose-400'
                            )}
                          >
                            {fmtRupees(pos.pnl)}
                          </td>
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            <button
                              onClick={() => {
                                cyberAudio.click();
                                onClosePosition(pos);
                              }}
                              disabled={isExecuting}
                              className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-500/40 border border-zinc-700 text-zinc-300 text-[10px] font-bold transition-all active:scale-95"
                              title="Square off this leg"
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

      {/* Cyber Scalp Telemetry Log (1 col) */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 lg:p-5 backdrop-blur-md flex flex-col justify-between h-full">
        <div>
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-purple-400" />
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                EXECUTION TELEMETRY
              </h3>
            </div>
            <span className="text-[10px] font-mono text-zinc-500">LIVE BUS</span>
          </div>

          <div className="space-y-2 max-h-[220px] overflow-y-auto pr-1">
            {logs.length === 0 ? (
              <div className="py-8 text-center text-zinc-500 font-mono text-xs">
                AWAITING FIRST TRADE EXECUTION
              </div>
            ) : (
              logs.slice(0, 10).map((log) => (
                <div
                  key={log.id}
                  className="p-2 rounded-lg bg-zinc-950/70 border border-zinc-800/70 text-[11px] font-mono flex items-start gap-2"
                >
                  <span
                    className={cn(
                      'px-1.5 py-0.2 rounded text-[9px] font-bold shrink-0 mt-0.5',
                      log.type === 'BUY'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : log.type === 'SELL'
                        ? 'bg-rose-500/20 text-rose-400'
                        : log.type === 'EXIT'
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-red-500/20 text-red-400'
                    )}
                  >
                    {log.type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-zinc-200 font-semibold truncate">{log.message}</p>
                    {log.detail && <p className="text-zinc-500 text-[10px] truncate">{log.detail}</p>}
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
