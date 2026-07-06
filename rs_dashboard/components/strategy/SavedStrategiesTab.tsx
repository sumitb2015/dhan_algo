'use client';

import { useState, useEffect, useCallback } from 'react';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import { computePayoffStats, buildPayoffCurve, ResolvedLeg, PayoffStats, ChainOc } from '@/lib/optionsStrategy';

interface StrategyRow {
  id: number;
  strategy_type: string;
  display_name: string;
  underlying: string;
  expiry: string;
  mode: string;
  lots: number;
  lot_size: number;
  entry_spot: number;
  entry_net_premium: number;
  status: string;
  created_at: string;
}

interface StrategyDetail extends StrategyRow {
  legs_json: {
    strike: number;
    option_type: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    qty_lots: number;
    entry_price: number;
    entry_delta: number | null;
  }[];
}

export default function SavedStrategiesTab() {
  const [rows, setRows] = useState<StrategyRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [liveLegs, setLiveLegs] = useState<ResolvedLeg[] | null>(null);
  const [liveSpot, setLiveSpot] = useState(0);
  const [liveStats, setLiveStats] = useState<PayoffStats | null>(null);
  const [liveCurve, setLiveCurve] = useState<{ spot: number; pnl: number }[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const refreshList = useCallback(() => {
    fetch('/api/saved-strategies')
      .then((r) => r.json())
      .then((json) => setRows(json?.data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const handleOpen = useCallback((id: number) => {
    setOpenId(id);
    setDetail(null);
    setLiveLegs(null);
    setLiveStats(null);
    setLoadingDetail(true);

    fetch(`/api/saved-strategies/${id}`)
      .then((r) => r.json())
      .then(async (json) => {
        if (!json?.success) return;
        const d: StrategyDetail = json.data;
        setDetail(d);

        const [spotRes, chainRes] = await Promise.all([
          fetch(`/api/options/spot?underlying=${d.underlying}`).then((r) => r.json()).catch(() => null),
          fetch(`/api/options/chain?underlying=${d.underlying}&expiry=${d.expiry}`).then((r) => r.json()).catch(() => null),
        ]);
        const currentSpot = spotRes?.spot ?? d.entry_spot;
        const oc: ChainOc = chainRes?.data?.chain?.oc ?? {};

        const resolved: ResolvedLeg[] = d.legs_json.map((leg) => {
          const entry = oc[String(leg.strike)] ?? oc[leg.strike.toFixed(6)] ?? Object.entries(oc).find(([k]) => Math.abs(parseFloat(k) - leg.strike) < 0.01)?.[1];
          const chainLeg = leg.option_type === 'CE' ? entry?.ce : entry?.pe;
          return {
            strike: leg.strike,
            type: leg.option_type,
            side: leg.side,
            qtyLots: leg.qty_lots,
            price: chainLeg?.last_price ?? leg.entry_price,
            delta: chainLeg?.greeks?.delta ?? leg.entry_delta,
            iv: chainLeg?.implied_volatility ?? null,
          };
        });

        setLiveSpot(currentSpot);
        setLiveLegs(resolved);
        setLiveStats(computePayoffStats(resolved, currentSpot, d.lot_size));
        setLiveCurve(buildPayoffCurve(resolved, currentSpot, d.lot_size));
      })
      .catch(() => {})
      .finally(() => {
        setLoadingDetail(false);
      });
  }, []);

  const handleClose = useCallback((id: number) => {
    fetch(`/api/saved-strategies/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    }).then(() => refreshList());
  }, [refreshList]);

  const handleDelete = useCallback((id: number) => {
    fetch(`/api/saved-strategies/${id}`, { method: 'DELETE' }).then(() => {
      refreshList();
      if (openId === id) {
        setOpenId(null);
        setDetail(null);
      }
    });
  }, [refreshList, openId]);

  const currentNetPremium = liveLegs
    ? liveLegs.reduce((sum, l) => sum + (l.side === 'SELL' ? l.price : -l.price) * l.qtyLots, 0)
    : null;
  const livePnl = detail && currentNetPremium !== null
    ? (detail.entry_net_premium - currentNetPremium) * detail.lot_size
    : null;

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden backdrop-blur-md">
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-950/80 border-b border-zinc-800">
                {['Strategy', 'Expiry', 'Lots', 'Status', 'Created', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold text-zinc-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {rows.map((r, i) => (
                <tr key={r.id} className="hover:bg-zinc-800/30 transition-colors duration-150">
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleOpen(r.id)}
                      className={`text-sm font-semibold hover:text-sky-300 transition-colors duration-150 text-left ${
                        openId === r.id ? 'text-sky-400' : 'text-zinc-100'
                      }`}
                    >
                      {r.display_name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-zinc-300 font-mono">{r.expiry}</td>
                  <td className="px-4 py-3 text-zinc-300 font-mono tabular-nums">{r.lots}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      r.status === 'open'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                    }`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 font-mono">{r.created_at.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    {r.status === 'open' && (
                      <button
                        onClick={() => handleClose(r.id)}
                        className="px-2 py-1 text-[11px] font-medium text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 rounded transition-all duration-150"
                      >
                        Close
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(r.id)}
                      className="px-2 py-1 text-[11px] font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-all duration-150"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No saved strategies found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {openId !== null && (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-5 backdrop-blur-md transition-all duration-300">
          {loadingDetail ? (
            <div className="flex items-center justify-center py-10 space-x-2 text-zinc-400 animate-pulse text-sm">
              <span>Restoring strategy state and fetching live P&amp;L…</span>
            </div>
          ) : detail && liveStats ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    {detail.display_name}
                    <span className="text-xs font-mono font-normal bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">
                      {detail.underlying}
                    </span>
                  </h3>
                  <p className="text-xs text-zinc-500 mt-1">
                    Entry Spot: <span className="font-mono text-zinc-300">{detail.entry_spot.toFixed(1)}</span>
                    <span className="mx-1.5">|</span>
                    Live Spot: <span className="font-mono text-zinc-300">{liveSpot.toFixed(1)}</span>
                  </p>
                </div>

                <div className="flex items-center gap-6">
                  <div className="text-right">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Entry Premium</div>
                    <div className="text-sm font-semibold text-zinc-300 font-mono tabular-nums">
                      {detail.entry_net_premium >= 0 ? '+' : ''}{detail.entry_net_premium.toFixed(1)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Live Premium</div>
                    <div className="text-sm font-semibold text-zinc-300 font-mono tabular-nums">
                      {currentNetPremium !== null ? `${currentNetPremium >= 0 ? '+' : ''}${currentNetPremium.toFixed(1)}` : '—'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Live P&amp;L</div>
                    <div className={`text-base font-bold font-mono tabular-nums ${
                      livePnl !== null ? (livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'
                    }`}>
                      {livePnl !== null ? `${livePnl >= 0 ? '+' : ''}₹${livePnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-zinc-950/40 rounded-xl p-4 border border-zinc-800/80">
                  <PayoffDiagram curve={liveCurve} currentSpot={liveSpot} breakevens={liveStats.breakevensExpiry} />
                </div>

                <div className="space-y-4">
                  <div className="bg-zinc-950/40 rounded-xl p-4 border border-zinc-800/80 space-y-3">
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider border-b border-zinc-800 pb-1.5">Strategy Legs</h4>
                    <div className="space-y-2 text-xs">
                      {detail.legs_json.map((leg, idx) => {
                        const liveLeg = liveLegs?.[idx];
                        const diff = liveLeg ? (liveLeg.price - leg.entry_price) : 0;
                        const sideColor = leg.side === 'BUY' ? 'text-sky-400' : 'text-amber-400';
                        return (
                          <div key={idx} className="flex justify-between items-center py-1 border-b border-zinc-800/30 last:border-0">
                            <div>
                              <span className={`font-semibold ${sideColor} mr-1.5`}>{leg.side}</span>
                              <span className="font-mono text-zinc-200">{leg.strike} {leg.option_type}</span>
                            </div>
                            <div className="text-right font-mono tabular-nums">
                              <div className="text-zinc-300">₹{liveLeg?.price.toFixed(1) ?? leg.entry_price.toFixed(1)}</div>
                              <div className={`text-[10px] ${diff >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                {diff >= 0 ? '+' : ''}{diff.toFixed(1)} (entry: {leg.entry_price.toFixed(1)})
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-zinc-950/40 rounded-xl p-4 border border-zinc-800/80 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <div className="text-zinc-500 uppercase tracking-wider text-[10px]">Max Profit</div>
                      <div className="font-semibold text-emerald-400 font-mono tabular-nums mt-0.5">
                        {liveStats.maxProfit === 'Unlimited' ? 'Unlimited' : `+₹${liveStats.maxProfit.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 uppercase tracking-wider text-[10px]">Max Loss</div>
                      <div className="font-semibold text-rose-400 font-mono tabular-nums mt-0.5">
                        {liveStats.maxLoss === 'Unlimited' ? 'Unlimited' : `₹${liveStats.maxLoss.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 uppercase tracking-wider text-[10px]">POP</div>
                      <div className="font-semibold text-zinc-300 font-mono mt-0.5">
                        {liveStats.popPct !== null ? `${liveStats.popPct}%` : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 uppercase tracking-wider text-[10px]">R:R Ratio</div>
                      <div className="font-semibold text-zinc-300 font-mono mt-0.5">
                        {liveStats.rewardRisk === null ? 'NA' : `1:${(1 / liveStats.rewardRisk).toFixed(1)}`}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-8 text-zinc-500 text-sm">
              Failed to load strategy details.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
