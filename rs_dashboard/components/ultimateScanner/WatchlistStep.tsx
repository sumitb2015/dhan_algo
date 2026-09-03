'use client';

import React, { useState } from 'react';
import {
  Eye,
  Sliders,
  Zap,
  Trash2,
  CheckCircle2,
  Clock,
  ArrowRight,
  RefreshCw,
  TrendingUp,
  AlertTriangle,
  PlayCircle,
  ExternalLink,
  PlusCircle,
} from 'lucide-react';
import type { WatchlistItem } from '@/lib/ultimateScannerTypes';

interface WatchlistStepProps {
  watchlist: WatchlistItem[];
  onUpdateItem: (id: string, patch: Partial<WatchlistItem>) => void;
  onDeleteItem: (id: string) => void;
  onTradeInMultiLegFocus: (item: WatchlistItem) => void;
  onNavigateToScanner: () => void;
  onRefresh: () => void;
}

export default function WatchlistStep({
  watchlist,
  onUpdateItem,
  onDeleteItem,
  onTradeInMultiLegFocus,
  onNavigateToScanner,
  onRefresh,
}: WatchlistStepProps) {
  const [selectedItemId, setSelectedItemId] = useState<string | null>(
    watchlist[0]?.id || null
  );

  const selectedItem = watchlist.find(w => w.id === selectedItemId) || watchlist[0];

  return (
    <div className="flex flex-col gap-6">
      {/* ── Top KPI Bar ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Monitored Setups</p>
          <p className="text-xl font-bold text-white tabular-nums mt-0.5">{watchlist.length}</p>
        </div>
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Total Max Profit Potential</p>
          <p className="text-xl font-bold text-emerald-400 tabular-nums mt-0.5">
            ₹{watchlist.reduce((sum, w) => sum + w.maxProfit, 0).toLocaleString('en-IN')}
          </p>
        </div>
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Total Est. Margin</p>
          <p className="text-xl font-bold text-zinc-300 tabular-nums mt-0.5">
            ₹{(watchlist.reduce((sum, w) => sum + w.estMargin, 0) / 1000).toFixed(0)}k
          </p>
        </div>
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4">
          <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Avg Return on Margin</p>
          <p className="text-xl font-bold text-cyan-400 tabular-nums mt-0.5">
            {watchlist.length > 0
              ? (watchlist.reduce((sum, w) => sum + w.romPct, 0) / watchlist.length).toFixed(1)
              : '0.0'}
            %
          </p>
        </div>
      </div>

      {/* ── Empty State ────────────────────────────────────────────── */}
      {watchlist.length === 0 ? (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-3xl p-12 text-center flex flex-col items-center justify-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
            <Eye className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Your Watchlist is Empty</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-md">
              Run Step 1 Scanner to scan Nifty & Sensex option chains, filter by your preferred RoM% & distance, and shortlist your favorite setups here.
            </p>
          </div>
          <button
            onClick={onNavigateToScanner}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-all shadow-lg shadow-emerald-900/30"
          >
            <PlusCircle className="w-4 h-4" />
            Go to Step 1: Scanner
          </button>
        </div>
      ) : (
        /* ── Master-Detail Layout ──────────────────────────────────── */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left Column: Watchlist Items (5 cols) */}
          <div className="lg:col-span-5 flex flex-col gap-3">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                Watchlist Items ({watchlist.length})
              </span>
              <button
                onClick={onRefresh}
                className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-semibold"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
            </div>

            <div className="flex flex-col gap-2.5 max-h-[750px] overflow-y-auto pr-1">
              {watchlist.map(item => {
                const isSelected = item.id === (selectedItem?.id || '');
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedItemId(item.id)}
                    className={`p-4 rounded-2xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-zinc-900 border-emerald-500/50 shadow-lg shadow-emerald-950/20'
                        : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{item.name}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                            {item.underlying}
                          </span>
                          <span className="text-[10px] text-zinc-400 font-mono">
                            {item.expiry} ({item.dte.toFixed(0)}d)
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-bold text-emerald-400 tabular-nums bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                          {item.romPct.toFixed(1)}% RoM
                        </span>
                        <p className="text-[10px] text-zinc-400 tabular-nums mt-1">
                          ₹{item.netPremium.toLocaleString('en-IN')}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-zinc-400 mt-3 pt-2.5 border-t border-zinc-800/80">
                      <span>POP: <strong className="text-cyan-400">{item.popPct.toFixed(0)}%</strong></span>
                      <span>Target: <strong className="text-emerald-400">{item.targetProfitPct}%</strong></span>
                      <span>SL: <strong className="text-red-400">{item.stopLossPct}%</strong></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Selected Item Detail & Rules Panel (7 cols) */}
          {selectedItem && (
            <div className="lg:col-span-7 flex flex-col gap-5 bg-zinc-900/90 border border-zinc-800 rounded-3xl p-6 shadow-2xl">
              {/* Header */}
              <div className="flex items-start justify-between gap-3 pb-4 border-b border-zinc-800">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-white">{selectedItem.name}</h2>
                    <span className="px-2.5 py-0.5 text-[10px] font-bold rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      {selectedItem.status}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">
                    Underlying: <strong className="text-white">{selectedItem.underlying}</strong> &bull; Expiry: <strong className="text-white font-mono">{selectedItem.expiry}</strong> &bull; Spot: <strong className="text-white tabular-nums">{selectedItem.spot.toLocaleString('en-IN')}</strong>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onDeleteItem(selectedItem.id)}
                    className="p-2 rounded-xl bg-zinc-800 hover:bg-red-500/20 text-zinc-400 hover:text-red-400 transition-all border border-zinc-700"
                    title="Remove from Watchlist"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Legs Table */}
              <div className="flex flex-col gap-2">
                <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Strategy Legs</span>
                <div className="bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider">
                      <tr>
                        <th className="py-2.5 px-3">Side</th>
                        <th className="py-2.5 px-3">Strike</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3">Lots / Qty</th>
                        <th className="py-2.5 px-3 text-right">LTP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 text-zinc-300 font-mono">
                      {selectedItem.legs.map((leg, idx) => (
                        <tr key={idx} className="hover:bg-zinc-900/50">
                          <td className="py-2 px-3">
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                                leg.side === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
                              }`}
                            >
                              {leg.side}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-bold text-white">{leg.strike}</td>
                          <td className={`py-2 px-3 ${leg.option === 'CE' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {leg.option}
                          </td>
                          <td className="py-2 px-3 text-zinc-400">
                            {leg.lots} lot ({leg.lots * leg.lotSize} qty)
                          </td>
                          <td className="py-2 px-3 text-right font-bold text-white tabular-nums">
                            ₹{leg.ltp.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Entry & Exit Strategy Rules Configuration */}
              <div className="bg-zinc-950/90 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                    Entry &amp; Exit Strategy Rules
                  </h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Target Profit % */}
                  <div className="flex flex-col gap-1.5 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-bold text-zinc-400">Target Profit</label>
                      <span className="text-xs font-bold text-emerald-400 tabular-nums">
                        {selectedItem.targetProfitPct}% (₹{((selectedItem.maxProfit * selectedItem.targetProfitPct) / 100).toFixed(0)})
                      </span>
                    </div>
                    <input
                      type="range"
                      min="20"
                      max="90"
                      step="5"
                      value={selectedItem.targetProfitPct}
                      onChange={e =>
                        onUpdateItem(selectedItem.id, { targetProfitPct: parseInt(e.target.value) })
                      }
                      className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg mt-1"
                    />
                    <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                      <span>30%</span>
                      <span>50% (Standard)</span>
                      <span>80%</span>
                    </div>
                  </div>

                  {/* Stop Loss % */}
                  <div className="flex flex-col gap-1.5 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-bold text-zinc-400">Stop Loss (% of Premium)</label>
                      <span className="text-xs font-bold text-red-400 tabular-nums">
                        {selectedItem.stopLossPct}% (₹{((selectedItem.netPremium * selectedItem.stopLossPct) / 100).toFixed(0)})
                      </span>
                    </div>
                    <input
                      type="range"
                      min="50"
                      max="200"
                      step="10"
                      value={selectedItem.stopLossPct}
                      onChange={e =>
                        onUpdateItem(selectedItem.id, { stopLossPct: parseInt(e.target.value) })
                      }
                      className="w-full accent-red-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg mt-1"
                    />
                    <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                      <span>50%</span>
                      <span>100% (1x Premium)</span>
                      <span>200%</span>
                    </div>
                  </div>

                  {/* Trailing Stop Loss */}
                  <div className="flex flex-col justify-between bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-bold text-zinc-400">Trailing Stop Loss</label>
                      <button
                        onClick={() =>
                          onUpdateItem(selectedItem.id, { trailingSl: !selectedItem.trailingSl })
                        }
                        className={`w-9 h-5 rounded-full transition-colors flex items-center p-0.5 ${
                          selectedItem.trailingSl ? 'bg-emerald-600 justify-end' : 'bg-zinc-700 justify-start'
                        }`}
                      >
                        <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-1">
                      {selectedItem.trailingSl
                        ? 'Trails stop loss upward as premium decays by 20%'
                        : 'Fixed stop loss threshold'}
                    </p>
                  </div>

                  {/* Expiry Auto-Exit Time */}
                  <div className="flex flex-col justify-between bg-zinc-900/60 p-3 rounded-xl border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-bold text-zinc-400">Expiry Auto-Exit</label>
                      <input
                        type="time"
                        value={selectedItem.expiryAutoExitTime || '15:15'}
                        onChange={e =>
                          onUpdateItem(selectedItem.id, { expiryAutoExitTime: e.target.value })
                        }
                        className="bg-zinc-800 border border-zinc-700 text-white text-xs font-mono rounded px-2 py-0.5 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-1">Auto square-off before market close</p>
                  </div>
                </div>
              </div>

              {/* ── Direct Multi-Leg Focus Bridge Action ─────────────── */}
              <div className="bg-gradient-to-r from-emerald-950/40 via-zinc-900 to-zinc-900 border border-emerald-500/30 rounded-2xl p-5 flex flex-col md:flex-row items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-emerald-400" />
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                      Initiate Trade in Multi-Leg Focus
                    </h4>
                  </div>
                  <p className="text-xs text-zinc-400 max-w-md">
                    Seamlessly push this strategy into the Multi-Leg Focus terminal to analyze live Greeks, margin benefits, and execute 1-click orders.
                  </p>
                </div>

                <button
                  onClick={() => onTradeInMultiLegFocus(selectedItem)}
                  className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-all shadow-xl shadow-emerald-900/40 shrink-0"
                >
                  <PlayCircle className="w-4 h-4" />
                  Trade in Multi-Leg Focus
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
