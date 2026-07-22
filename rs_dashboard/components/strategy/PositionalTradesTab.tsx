'use client';

import React, { useState, useEffect, useCallback } from 'react';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import {
  computePayoffStats,
  buildPayoffCurve,
  ResolvedLeg,
  PayoffStats,
  ChainOc,
} from '@/lib/optionsStrategy';
import { Trash2, AlertTriangle, TrendingUp, TrendingDown, Clock, Activity, Check, ChevronDown, ChevronRight } from 'lucide-react';

const UNDERLYING = 'NIFTY';
const FALLBACK_LOT_SIZE = 75;

interface PositionalTrade {
  id: string;
  strategyId: string;
  strategyName: string;
  expiry: string;
  lots: number;
  params: Record<string, number>;
  entrySpot: number;
  exitSpot?: number;
  entryNetPremium: number;
  target: number | null;
  stoploss: number | null;
  status: 'active' | 'exited';
  isDemo?: boolean;
  mode?: 'intraday' | 'positional';
  lotSize?: number;           // Lot size at entry time; older trades may lack it
  orderIds?: string;          // Broker order IDs (only on confirmed live trades)
  createdAt: string;
  exitedAt?: string;
  finalPnl?: number;
  legs: {
    strike: number;
    type: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    qtyRatio: number;
    entryPrice: number;
    securityId: string | null;
  }[];
}

export default function PositionalTradesTab({ lotSize }: { lotSize: number | null }) {
  const tradeLotSize = useCallback(
    (trade: PositionalTrade) => trade.lotSize ?? lotSize ?? FALLBACK_LOT_SIZE,
    [lotSize],
  );
  const [trades, setTrades] = useState<PositionalTrade[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  
  // Real-time pricing states
  const [spot, setSpot] = useState<number>(0);
  const [chainCache, setChainCache] = useState<Record<string, ChainOc>>({});
  const [pollingError, setPollingError] = useState<string | null>(null);
  
  // Active exits
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [exitMessages, setExitMessages] = useState<Record<string, { success: boolean; message: string }>>({});
  
  // Inline edit state for Target and Stop Loss
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<string>('');
  const [editStoploss, setEditStoploss] = useState<string>('');

  // Load trades from localStorage
  const loadTrades = useCallback(() => {
    try {
      const raw = localStorage.getItem('positional_trades');
      setTrades(raw ? JSON.parse(raw) : []);
    } catch {
      setTrades([]);
    }
  }, []);

  useEffect(() => {
    loadTrades();
  }, [loadTrades]);

  // Persist updated trades list
  const saveTrades = (updated: PositionalTrade[]) => {
    setTrades(updated);
    try {
      localStorage.setItem('positional_trades', JSON.stringify(updated));
    } catch {}
  };

  const handleExitTrade = useCallback(async (trade: PositionalTrade, reason: string = 'Manual Exit') => {
    if (exitingIds.has(trade.id)) return;
    setExitingIds((prev) => {
      const next = new Set(prev);
      next.add(trade.id);
      return next;
    });

    if (trade.isDemo) {
      try {
        const activeExpiryChain = chainCache[trade.expiry];
        const finalPnl = calculatePnl(trade, spot, activeExpiryChain);
        
        const updated = trades.map((t) => {
          if (t.id === trade.id) {
            return {
              ...t,
              status: 'exited' as const,
              exitSpot: spot,
              exitedAt: new Date().toISOString(),
              finalPnl,
            };
          }
          return t;
        });
        saveTrades(updated);
        
        setExitMessages((prev) => ({
          ...prev,
          [trade.id]: { success: true, message: `${reason} complete (Paper Trade). Final P&L: ₹${finalPnl.toFixed(0)}` },
        }));
      } catch (err) {
        setExitMessages((prev) => ({
          ...prev,
          [trade.id]: { success: false, message: String(err) },
        }));
      } finally {
        setExitingIds((prev) => {
          const next = new Set(prev);
          next.delete(trade.id);
          return next;
        });
      }
      return;
    }

    // Guard: without a stored lot size, don't fall back to a guess for a live order
    if (trade.lotSize === undefined && lotSize === null) {
      setExitMessages((prev) => ({
        ...prev,
        [trade.id]: { success: false, message: 'Cannot exit — lot size not loaded yet. Wait a moment and retry.' },
      }));
      setExitingIds((prev) => { const next = new Set(prev); next.delete(trade.id); return next; });
      return;
    }

    const legsPayload = trade.legs.map((l) => ({
      securityId: l.securityId,
      quantity: l.qtyRatio * trade.lots * tradeLotSize(trade),
      side: l.side === 'BUY' ? 'SELL' : 'BUY',
    }));

    // Guard: all legs must have resolved security IDs
    const unresolved = legsPayload.filter((l) => !l.securityId);
    if (unresolved.length > 0) {
      setExitMessages((prev) => ({
        ...prev,
        [trade.id]: { success: false, message: 'Cannot exit — some leg security IDs are unresolved. Live market data may not be available for this expiry.' },
      }));
      setExitingIds((prev) => { const next = new Set(prev); next.delete(trade.id); return next; });
      return;
    }

    try {
      const res = await fetch('/api/options/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ legs: legsPayload, mode: 'positional' }),
      });
      const json = await res.json();
      
      if (json.success) {
        // Calculate final P&L
        const activeExpiryChain = chainCache[trade.expiry];
        const finalPnl = calculatePnl(trade, spot, activeExpiryChain);
        
        const updated = trades.map((t) => {
          if (t.id === trade.id) {
            return {
              ...t,
              status: 'exited' as const,
              exitSpot: spot,
              exitedAt: new Date().toISOString(),
              finalPnl,
            };
          }
          return t;
        });
        saveTrades(updated);
        
        const ids = json.data.map((o: any) => o.orderId).join(', ');
        setExitMessages((prev) => ({
          ...prev,
          [trade.id]: { success: true, message: `${reason} complete. Order IDs: ${ids}. Final P&L: ₹${finalPnl.toFixed(0)}` },
        }));
      } else {
        setExitMessages((prev) => ({
          ...prev,
          [trade.id]: { success: false, message: json.error || 'Failed to place exit orders.' },
        }));
      }
    } catch (err) {
      setExitMessages((prev) => ({
        ...prev,
        [trade.id]: { success: false, message: String(err) },
      }));
    } finally {
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.delete(trade.id);
        return next;
      });
    }
  }, [trades, spot, chainCache, exitingIds, lotSize, tradeLotSize]);

  // Calculate live P&L for a trade
  const calculatePnl = (trade: PositionalTrade, currentSpot: number, oc?: ChainOc): number => {
    if (trade.status === 'exited') {
      return trade.finalPnl ?? 0;
    }
    if (!oc || currentSpot === 0) return 0;

    const currentNetPremium = trade.legs.reduce((sum, l) => {
      const entry = oc[String(l.strike)] ?? oc[l.strike.toFixed(6)] ?? Object.entries(oc).find(([k]) => Math.abs(parseFloat(k) - l.strike) < 0.01)?.[1];
      const chainLeg = l.type === 'CE' ? entry?.ce : entry?.pe;
      const currentPrice = chainLeg?.last_price ?? l.entryPrice;
      return sum + (l.side === 'SELL' ? currentPrice : -currentPrice) * l.qtyRatio * trade.lots;
    }, 0);

    return (trade.entryNetPremium - currentNetPremium) * tradeLotSize(trade);
  };

  // Main polling logic for spot and options chains
  useEffect(() => {
    const activeExpiries = Array.from(
      new Set(trades.filter((t) => t.status === 'active').map((t) => t.expiry))
    );

    if (activeExpiries.length === 0) return;

    const poll = async () => {
      try {
        // Fetch Spot
        const spotRes = await fetch(`/api/options/spot?underlying=${UNDERLYING}`).then((r) => r.json());
        const currentSpot = spotRes?.spot ?? 0;
        if (currentSpot > 0) setSpot(currentSpot);

        // Fetch Option Chains for unique active expiries
        const newCache: Record<string, ChainOc> = { ...chainCache };
        for (const exp of activeExpiries) {
          const chainRes = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${exp}`).then((r) => r.json());
          const oc = chainRes?.data?.chain?.oc;
          if (oc) {
            newCache[exp] = oc;
          }
        }
        setChainCache(newCache);
        setPollingError(null);

        // Perform auto-exit evaluations
        for (const trade of trades) {
          if (trade.status !== 'active') continue;
          const oc = newCache[trade.expiry];
          if (!oc || currentSpot === 0) continue;

          const pnl = calculatePnl(trade, currentSpot, oc);
          
          if (trade.target !== null && pnl >= trade.target) {
            handleExitTrade(trade, 'Target Profit Hit');
          } else if (trade.stoploss !== null && pnl <= -trade.stoploss) {
            handleExitTrade(trade, 'Stop Loss Hit');
          }
        }
      } catch (err) {
        setPollingError('Error polling live quotes.');
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [trades, chainCache, handleExitTrade]);

  const handleDeleteTrade = (id: string) => {
    const updated = trades.filter((t) => t.id !== id);
    saveTrades(updated);
    if (openId === id) setOpenId(null);
  };

  const startEdit = (trade: PositionalTrade) => {
    setEditingId(trade.id);
    setEditTarget(trade.target !== null ? String(trade.target) : '');
    setEditStoploss(trade.stoploss !== null ? String(trade.stoploss) : '');
  };

  const saveEdit = (tradeId: string) => {
    const targetVal = editTarget.trim() === '' ? null : Number(editTarget);
    const stoplossVal = editStoploss.trim() === '' ? null : Number(editStoploss);
    
    if ((targetVal !== null && isNaN(targetVal)) || (stoplossVal !== null && isNaN(stoplossVal))) {
      return;
    }

    const updated = trades.map((t) => {
      if (t.id === tradeId) {
        return {
          ...t,
          target: targetVal,
          stoploss: stoplossVal,
        };
      }
      return t;
    });

    saveTrades(updated);
    setEditingId(null);
  };

  // Build current live payoff stats & curve for open detail panel
  const getLiveStatsAndCurve = (trade: PositionalTrade) => {
    const activeExpiryChain = chainCache[trade.expiry];
    const resolved: ResolvedLeg[] = trade.legs.map((l) => {
      const entry = activeExpiryChain ? (activeExpiryChain[String(l.strike)] ?? activeExpiryChain[l.strike.toFixed(6)] ?? Object.entries(activeExpiryChain).find(([k]) => Math.abs(parseFloat(k) - l.strike) < 0.01)?.[1]) : undefined;
      const chainLeg = l.type === 'CE' ? entry?.ce : entry?.pe;
      return {
        strike: l.strike,
        type: l.type,
        side: l.side,
        qtyLots: trade.lots * l.qtyRatio,
        price: l.entryPrice, // Base payoff curve relative to entry cost
        delta: chainLeg?.greeks?.delta ?? null,
        iv: typeof chainLeg?.implied_volatility === 'number' ? chainLeg.implied_volatility / 100 : null,
        vega: chainLeg?.greeks?.vega ?? null,
        securityId: l.securityId,
      };
    });

    const activeSpot = spot || trade.entrySpot;
    return {
      stats: computePayoffStats(resolved, activeSpot, tradeLotSize(trade), trade.expiry),
      curve: buildPayoffCurve(resolved, activeSpot, tradeLotSize(trade)),
      resolvedLegs: resolved,
      liveSpot: activeSpot,
    };
  };

  // Get live LTP for a leg from chain cache
  const getLiveLtp = (trade: PositionalTrade, legIndex: number): number | null => {
    const oc = chainCache[trade.expiry];
    if (!oc) return null;
    const l = trade.legs[legIndex];
    const entry = oc[String(l.strike)] ?? oc[l.strike.toFixed(6)] ?? Object.entries(oc).find(([k]) => Math.abs(parseFloat(k) - l.strike) < 0.01)?.[1];
    const chainLeg = l.type === 'CE' ? entry?.ce : entry?.pe;
    return chainLeg?.last_price ?? null;
  };

  const [expandedLegs, setExpandedLegs] = useState<Set<string>>(new Set());
  const toggleLegs = (id: string) => {
    setExpandedLegs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const totalActivePnl = trades
    .filter((t) => t.status === 'active')
    .reduce((sum, t) => sum + calculatePnl(t, spot, chainCache[t.expiry]), 0);

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between backdrop-blur-md">
          <div className="space-y-1">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Total Active Positions</span>
            <div className="text-2xl font-bold text-white font-mono">
              {trades.filter((t) => t.status === 'active').length}
            </div>
          </div>
          <Activity className="text-sky-400 w-8 h-8 opacity-80" />
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between backdrop-blur-md">
          <div className="space-y-1">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Consolidated Active P&amp;L</span>
            <div className={`text-2xl font-bold font-mono flex items-center gap-1 ${
              totalActivePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}>
              {totalActivePnl >= 0 ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
              ₹{totalActivePnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
          </div>
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between backdrop-blur-md">
          <div className="space-y-1">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Historical Exits</span>
            <div className="text-2xl font-bold text-white font-mono">
              {trades.filter((t) => t.status === 'exited').length}
            </div>
          </div>
          <Clock className="text-zinc-500 w-8 h-8 opacity-80" />
        </div>
      </div>

      {pollingError && (
        <div className="bg-rose-950/80 border border-rose-800 text-rose-300 text-xs rounded-lg px-4 py-2.5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {pollingError}
        </div>
      )}

      {/* Positions Table */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden backdrop-blur-md">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-950/80 border-b border-zinc-800">
                {['', 'Strategy', 'Expiry', 'Lots', 'Status', 'Target Profit', 'Stop Loss', 'Entry Spot', 'Live P&L', 'Created At', ''].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-bold text-zinc-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {trades.map((t) => {
                const currentPnl = calculatePnl(t, spot, chainCache[t.expiry]);
                const isExiting = exitingIds.has(t.id);

                const legsExpanded = expandedLegs.has(t.id);
                return (
                  <React.Fragment key={t.id}>
                  <tr className="hover:bg-zinc-800/20 transition-colors duration-150">
                    {/* Expand legs toggle */}
                    <td className="px-2 py-3 w-6">
                      <button
                        onClick={() => toggleLegs(t.id)}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                        title={legsExpanded ? 'Collapse legs' : 'Expand legs'}
                      >
                        {legsExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setOpenId(openId === t.id ? null : t.id)}
                        className={`text-sm font-semibold hover:text-sky-300 transition-colors text-left ${
                          openId === t.id ? 'text-sky-400' : 'text-zinc-100'
                        }`}
                      >
                        {t.strategyName}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-zinc-300 font-mono">{t.expiry}</td>
                    <td className="px-4 py-3 text-zinc-300 font-mono">{t.lots}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5 items-center">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${
                          t.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                            : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                        }`}>
                          {t.status}
                        </span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${
                          t.isDemo
                            ? 'bg-purple-500/15 text-purple-400 border border-purple-500/25'
                            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                        }`}>
                          {t.isDemo ? 'DEMO' : 'LIVE'}
                        </span>
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider ${
                          t.mode === 'intraday'
                            ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                            : 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25'
                        }`}>
                          {t.mode || 'positional'}
                        </span>
                      </div>
                    </td>
                    
                    {/* Editable Target & Stoploss */}
                    <td className="px-4 py-3">
                      {editingId === t.id ? (
                        <input
                          type="number"
                          value={editTarget}
                          onChange={(e) => setEditTarget(e.target.value)}
                          className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-100 font-mono w-20 text-xs"
                          placeholder="None"
                        />
                      ) : (
                        <span className="font-mono text-zinc-300">
                          {t.target !== null ? `₹${t.target}` : 'None'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingId === t.id ? (
                        <input
                          type="number"
                          value={editStoploss}
                          onChange={(e) => setEditStoploss(e.target.value)}
                          className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-100 font-mono w-20 text-xs"
                          placeholder="None"
                        />
                      ) : (
                        <span className="font-mono text-zinc-300">
                          {t.stoploss !== null ? `₹${t.stoploss}` : 'None'}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 text-zinc-400 font-mono">{t.entrySpot.toFixed(1)}</td>
                    <td className={`px-4 py-3 font-mono font-semibold ${
                      currentPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      ₹{currentPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-4 py-3 text-zinc-500 font-mono">{t.createdAt.slice(0, 10)}</td>
                    
                    {/* Row Actions */}
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      {editingId === t.id ? (
                        <button
                          onClick={() => saveEdit(t.id)}
                          className="px-2 py-0.5 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded flex inline-flex items-center gap-0.5 transition-all"
                        >
                          <Check className="w-3 h-3" /> Save
                        </button>
                      ) : (
                        t.status === 'active' && (
                          <button
                            onClick={() => startEdit(t)}
                            className="px-2 py-1 text-[11px] font-medium text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 rounded transition-all"
                          >
                            Edit limits
                          </button>
                        )
                      )}
                      
                      {t.status === 'active' && (
                        <button
                          onClick={() => handleExitTrade(t)}
                          disabled={isExiting}
                          className="px-2 py-1 text-[11px] font-medium text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 rounded transition-all"
                        >
                          {isExiting ? 'Exiting...' : 'Exit Position'}
                        </button>
                      )}

                      <button
                        onClick={() => handleDeleteTrade(t.id)}
                        className="px-2 py-1 text-[11px] font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-all"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                  {/* Inline legs sub-rows */}
                  {legsExpanded && t.legs.map((leg, li) => {
                    const liveLtp = getLiveLtp(t, li);
                    const pnlPerLot = liveLtp !== null
                      ? (leg.side === 'SELL' ? leg.entryPrice - liveLtp : liveLtp - leg.entryPrice)
                      : null;
                    return (
                      <tr key={`${t.id}-leg-${li}`} className="bg-zinc-950/40 border-t border-zinc-800/30">
                        <td className="px-2 py-1.5" />
                        <td className="px-4 py-1.5 pl-8" colSpan={1}>
                          <div className="flex items-center gap-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${leg.side === 'BUY' ? 'bg-sky-500/10 text-sky-400' : 'bg-rose-500/10 text-rose-400'}`}>{leg.side}</span>
                            <span className="font-mono text-zinc-300 text-xs">{leg.strike}</span>
                            <span className={`text-[10px] font-semibold ${leg.type === 'CE' ? 'text-orange-400' : 'text-teal-400'}`}>{leg.type}</span>
                          </div>
                        </td>
                        <td className="px-4 py-1.5 text-zinc-500 font-mono text-xs">{leg.qtyRatio * t.lots} lots</td>
                        <td className="px-4 py-1.5" colSpan={2}>
                          <span className="text-zinc-500 text-[10px]">Entry </span>
                          <span className="font-mono text-zinc-300 text-xs">₹{leg.entryPrice.toFixed(2)}</span>
                        </td>
                        <td className="px-4 py-1.5" colSpan={2}>
                          <span className="text-zinc-500 text-[10px]">LTP </span>
                          <span className={`font-mono text-xs font-semibold ${liveLtp !== null ? (pnlPerLot! >= 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'}`}>
                            {liveLtp !== null ? `₹${liveLtp.toFixed(2)}` : '—'}
                          </span>
                          {pnlPerLot !== null && (
                            <span className={`ml-1.5 text-[10px] font-mono ${pnlPerLot >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                              ({pnlPerLot >= 0 ? '+' : ''}{pnlPerLot.toFixed(1)})
                            </span>
                          )}
                        </td>
                        <td colSpan={4} />
                      </tr>
                    );
                  })}
                  </React.Fragment>
                );
              })}
              {trades.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-zinc-500">
                    No positional trades executed.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Expansion Panel */}
      {openId !== null && (() => {
        const trade = trades.find((t) => t.id === openId);
        if (!trade) return null;
        
        const { stats: liveStats, curve: liveCurve, resolvedLegs: liveLegs, liveSpot } = getLiveStatsAndCurve(trade);
        const exitMsg = exitMessages[trade.id];

        return (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-5 backdrop-blur-md transition-all duration-300">
            {exitMsg && (
              <div className={`border rounded-lg px-4 py-2.5 text-xs font-semibold ${
                exitMsg.success
                  ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                  : 'bg-rose-950/80 border-rose-800 text-rose-300'
              }`}>
                {exitMsg.message}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-white flex flex-wrap items-center gap-2">
                  {trade.strategyName}
                  <span className="text-xs font-mono font-normal bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
                    {UNDERLYING}
                  </span>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
                    trade.isDemo
                      ? 'bg-purple-500/15 text-purple-400 border border-purple-500/25'
                      : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                  }`}>
                    {trade.isDemo ? 'DEMO' : 'LIVE'}
                  </span>
                  <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
                    trade.mode === 'intraday'
                      ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                      : 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25'
                  }`}>
                    {trade.mode || 'positional'}
                  </span>
                </h3>
                <p className="text-xs text-zinc-500 mt-1">
                  Entry Spot: <span className="font-mono text-zinc-300">{trade.entrySpot.toFixed(1)}</span>
                  <span className="mx-1.5">|</span>
                  Live Spot: <span className="font-mono text-zinc-300">{liveSpot.toFixed(1)}</span>
                  {trade.status === 'exited' && trade.exitSpot && (
                    <>
                      <span className="mx-1.5">|</span>
                      Exit Spot: <span className="font-mono text-zinc-300">{trade.exitSpot.toFixed(1)}</span>
                    </>
                  )}
                </p>
                {!trade.isDemo && trade.orderIds && (
                  <p className="text-[10px] text-zinc-600 mt-0.5 font-mono">
                    Order IDs: <span className="text-zinc-400">{trade.orderIds}</span>
                  </p>
                )}
              </div>

              {trade.status === 'active' && (
                <button
                  onClick={() => handleExitTrade(trade)}
                  disabled={exitingIds.has(trade.id)}
                  className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 text-white text-xs font-semibold rounded-lg transition-colors"
                >
                  {exitingIds.has(trade.id) ? 'Exiting...' : 'Exit Position'}
                </button>
              )}
            </div>

            {/* Layout Grid: Payoff Curve + Table */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Payoff curve */}
              <div className="lg:col-span-2 space-y-2">
                <span className="text-xs text-zinc-400 font-semibold uppercase tracking-wider block">Payoff Curve (Expiry P&amp;L relative to entry cost)</span>
                <div className="h-64 bg-zinc-950/60 rounded-xl p-3 border border-zinc-800">
                  <PayoffDiagram curve={liveCurve} currentSpot={liveSpot} breakevens={liveStats.breakevensExpiry} />
                </div>
              </div>

              {/* Stats panel */}
              <div className="bg-zinc-950/40 rounded-xl p-4 border border-zinc-850 space-y-4 text-xs">
                <span className="text-xs text-zinc-400 font-semibold uppercase tracking-wider block">Position Performance</span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="text-zinc-500 block">Entry Net Premium</span>
                    <span className="font-mono font-semibold text-zinc-300">
                      ₹{(trade.entryNetPremium * tradeLotSize(trade)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block">Live Net Premium</span>
                    <span className="font-mono font-semibold text-zinc-300">
                      {liveStats.netPremium ? `₹${(liveStats.netPremium * tradeLotSize(trade)).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : 'Calculating...'}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block">Max Profit (Expiry)</span>
                    <span className="font-mono font-semibold text-emerald-400">
                      {liveStats.maxProfit === 'Unlimited' ? 'Unlimited' : `₹${liveStats.maxProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500 block">Max Loss (Expiry)</span>
                    <span className="font-mono font-semibold text-rose-400">
                      {liveStats.maxLoss === 'Unlimited' ? 'Unlimited' : `₹${liveStats.maxLoss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Strategy Legs Table */}
            <div className="space-y-2">
              <span className="text-xs text-zinc-400 font-semibold uppercase tracking-wider block">Leg Details</span>
              <div className="overflow-x-auto border border-zinc-800 rounded-xl">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-zinc-950/60 border-b border-zinc-800 text-zinc-400 font-semibold">
                      <th className="px-3 py-2">B/S</th>
                      <th className="px-3 py-2">Strike</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Entry Price</th>
                      <th className="px-3 py-2">Live Price (LTP)</th>
                      <th className="px-3 py-2">Lots</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-850">
                    {liveLegs.map((leg, index) => {
                      const liveLtp = getLiveLtp(trade, index);
                      const entryPx = trade.legs[index].entryPrice;
                      const pnlPerUnit = liveLtp !== null
                        ? (leg.side === 'SELL' ? entryPx - liveLtp : liveLtp - entryPx)
                        : null;
                      return (
                      <tr key={index} className="hover:bg-zinc-800/10">
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                            leg.side === 'BUY' ? 'bg-sky-500/10 text-sky-400' : 'bg-rose-500/10 text-rose-400'
                          }`}>
                            {leg.side}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-200">{leg.strike}</td>
                        <td className="px-3 py-2 font-semibold">{leg.type}</td>
                        <td className="px-3 py-2 font-mono text-zinc-400">₹{entryPx.toFixed(2)}</td>
                        <td className="px-3 py-2 font-mono">
                          <span className={liveLtp !== null ? (pnlPerUnit! >= 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'}>
                            {liveLtp !== null ? `₹${liveLtp.toFixed(2)}` : '—'}
                          </span>
                          {pnlPerUnit !== null && (
                            <span className={`ml-1.5 text-[10px] ${pnlPerUnit >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                              ({pnlPerUnit >= 0 ? '+' : ''}{pnlPerUnit.toFixed(1)})
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-400">{leg.qtyLots}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
