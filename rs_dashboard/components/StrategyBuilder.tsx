'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import NavBar from '@/components/NavBar';
import StrategyCardGrid from '@/components/strategy/StrategyCardGrid';
import StrategySettingsPanel from '@/components/strategy/StrategySettingsPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import SavedStrategiesTab from '@/components/strategy/SavedStrategiesTab';
import PositionalTradesTab from '@/components/strategy/PositionalTradesTab';
import {
  STRATEGY_TEMPLATES, getTemplate, defaultParams, classifyExpiries, computeAtm,
  resolveLegs, computePayoffStats, buildPayoffCurve, buildTargetPayoffCurve, findBreakevens,
  ChainOc, ResolvedLeg, PayoffStats,
} from '@/lib/optionsStrategy';

const UNDERLYING = 'NIFTY';
const LOT_SIZE = 75;

type MarginData = { total_margin: number; hedge_benefit: number; available_funds: number };

export default function StrategyBuilder() {
  const [activeTab, setActiveTab] = useState<'builder' | 'saved' | 'positions'>('builder');
  const [target, setTarget] = useState<number | null>(null);
  const [stoploss, setStoploss] = useState<number | null>(null);

  const [expiries, setExpiries] = useState<{ date: string; kind: 'weekly' | 'monthly' }[]>([]);
  const [expiryKindFilter, setExpiryKindFilter] = useState<'weekly' | 'monthly' | 'all'>('all');
  const [selectedExpiry, setSelectedExpiry] = useState('');

  const [spot, setSpot] = useState(0);
  const [chainOc, setChainOc] = useState<ChainOc>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, number>>({});
  const [lots, setLots] = useState(1);
  const [mode, setMode] = useState<'intraday' | 'positional'>('intraday');
  const [tradingType, setTradingType] = useState<'live' | 'demo'>('demo');

  const [resolvedLegs, setResolvedLegs] = useState<ResolvedLeg[] | null>(null);
  const [missingStrikes, setMissingStrikes] = useState<number[]>([]);
  const [stats, setStats] = useState<PayoffStats | null>(null);
  const [curve, setCurve] = useState<{ spot: number; pnl: number }[]>([]);
  const [breakevenMode, setBreakevenMode] = useState<'target' | 'expiry'>('expiry');
  const [targetBreakevens, setTargetBreakevens] = useState<number[] | null>(null);

  const [margin, setMargin] = useState<MarginData | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);

  const [entering, setEntering] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [orderResult, setOrderResult] = useState<{ success: boolean; message: string } | null>(null);

  const selectedTemplate = selectedId ? getTemplate(selectedId) : undefined;

  // Fetch expiries once on mount
  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then((r) => r.json())
      .then((json) => {
        const dates: string[] = json?.data ?? [];
        const classified = classifyExpiries(dates);
        setExpiries(classified);
        if (classified.length > 0) setSelectedExpiry(classified[0].date);
      })
      .catch(() => {});
  }, []);

  // Fetch chain + spot whenever the expiry changes
  useEffect(() => {
    if (!selectedExpiry) return;
    fetch(`/api/options/spot?underlying=${UNDERLYING}`).then((r) => r.json()).then((json) => setSpot(json?.spot ?? 0)).catch(() => {});
    fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${selectedExpiry}`)
      .then((r) => r.json())
      .then((json) => setChainOc(json?.data?.chain?.oc ?? {}))
      .catch(() => {});
  }, [selectedExpiry]);

  const handleSelectStrategy = useCallback((id: string) => {
    setSelectedId(id);
    const t = getTemplate(id);
    if (t) setParams(defaultParams(t));
    setResolvedLegs(null);
    setStats(null);
    setMargin(null);
    setTargetBreakevens(null);
    setOrderResult(null);
  }, []);

  const handleAnalyze = useCallback(() => {
    if (!selectedTemplate) return;
    setOrderResult(null);
    const atm = computeAtm(spot);
    const specs = selectedTemplate.legs(params);
    const { legs, missingStrikes: missing } = resolveLegs(specs, atm, Math.max(1, lots), chainOc);
    setMissingStrikes(missing);
    if (missing.length > 0) {
      setResolvedLegs(null);
      setStats(null);
      return;
    }
    setResolvedLegs(legs);
    const payoffStats = computePayoffStats(legs, spot, LOT_SIZE);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(legs, spot, LOT_SIZE));
    setTargetBreakevens(null); // recomputed lazily below when breakevenMode === 'target'

    setMarginLoading(true);
    fetch('/api/options/margin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        underlying: UNDERLYING,
        expiry: selectedExpiry,
        legs: legs.map((l) => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots, price: l.price })),
      }),
    })
      .then((r) => r.json())
      .then((json) => setMargin(json?.success ? json.data : null))
      .catch(() => setMargin(null))
      .finally(() => setMarginLoading(false));
  }, [selectedTemplate, params, lots, spot, chainOc, selectedExpiry]);

  // Recompute target breakevens on demand when the toggle is switched to 'target'
  useEffect(() => {
    if (breakevenMode !== 'target' || !resolvedLegs || targetBreakevens !== null) return;
    const expiryDate = new Date(selectedExpiry);
    const daysToExpiry = Math.max(0, Math.round((expiryDate.getTime() - Date.now()) / 86_400_000));
    const targetCurve = buildTargetPayoffCurve(resolvedLegs, spot, LOT_SIZE, daysToExpiry);
    setTargetBreakevens(findBreakevens(targetCurve));
  }, [breakevenMode, resolvedLegs, targetBreakevens, selectedExpiry, spot]);

  const handleSave = useCallback(() => {
    if (!selectedTemplate || !resolvedLegs || !stats || saving) return;
    setSaving(true);
    setSaveResult(null);
    const payload = {
      strategy_type: selectedTemplate.id,
      display_name: selectedTemplate.name,
      underlying: UNDERLYING,
      expiry: selectedExpiry,
      mode: 'positional',
      lots: Math.max(1, lots),
      lot_size: LOT_SIZE,
      params,
      entry_spot: spot,
      entry_net_premium: stats.netPremium,
      legs: resolvedLegs.map((l) => ({
        strike: l.strike, option_type: l.type, side: l.side, qty_lots: l.qtyLots,
        entry_price: l.price, entry_delta: l.delta, security_id: l.securityId,
      })),
      notes: null,
    };
    fetch('/api/saved-strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setSaveResult({ success: true, message: `Strategy saved (ID: ${json.data?.id ?? '?'}).` });
        } else {
          setSaveResult({ success: false, message: json.error || 'Failed to save strategy.' });
        }
      })
      .catch((err) => {
        setSaveResult({ success: false, message: String(err) });
      })
      .finally(() => {
        setSaving(false);
      });
  }, [selectedTemplate, resolvedLegs, stats, selectedExpiry, lots, params, spot, saving]);

  const handleEnterTrade = useCallback(() => {
    if (!resolvedLegs) return;
    setEntering(true);
    setOrderResult(null);

    const saveDemoTrade = () => {
      if (stats && selectedTemplate) {
        const newTrade = {
          id: String(Date.now()),
          strategyId: selectedTemplate.id,
          strategyName: selectedTemplate.name,
          expiry: selectedExpiry,
          lots: Math.max(1, lots),
          params,
          entrySpot: spot,
          entryNetPremium: stats.netPremium,
          target: target,
          stoploss: stoploss,
          status: 'active',
          isDemo: true,
          mode: mode,
          createdAt: new Date().toISOString(),
          legs: resolvedLegs.map((l) => ({
            strike: l.strike,
            type: l.type,
            side: l.side,
            qtyRatio: l.qtyLots / Math.max(1, lots),
            entryPrice: l.price,
            securityId: l.securityId,
          })),
        };

        const existingStr = localStorage.getItem('positional_trades');
        const trades = existingStr ? JSON.parse(existingStr) : [];
        trades.unshift(newTrade);
        localStorage.setItem('positional_trades', JSON.stringify(trades));
      }
    };

    if (tradingType === 'demo') {
      setTimeout(() => {
        saveDemoTrade();
        setOrderResult({ success: true, message: `Demo strategy entered successfully (Paper Trade).` });
        setEntering(false);
      }, 500);
      return;
    }

    const legsPayload = resolvedLegs.map((l) => ({
      securityId: l.securityId,
      quantity: l.qtyLots * LOT_SIZE,
      side: l.side,
    }));

    // Guard: all legs must have resolved security IDs before touching the broker
    const unresolved = legsPayload.filter((l) => !l.securityId);
    if (unresolved.length > 0) {
      setOrderResult({ success: false, message: 'Cannot enter trade — option chain not fully loaded. Try refreshing the strategy analysis.' });
      setEntering(false);
      return;
    }

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          const ids = json.data.map((o: any) => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strategy entered successfully. Order IDs: ${ids}` });

          // Only persist to Positions tab after confirmed broker success
          if (mode === 'positional' && stats && selectedTemplate) {
            const newTrade = {
              id: String(Date.now()),
              strategyId: selectedTemplate.id,
              strategyName: selectedTemplate.name,
              expiry: selectedExpiry,
              lots: Math.max(1, lots),
              params,
              entrySpot: spot,
              entryNetPremium: stats.netPremium,
              target: target,
              stoploss: stoploss,
              status: 'active',
              isDemo: false,
              mode: 'positional',
              orderIds: ids,
              createdAt: new Date().toISOString(),
              legs: resolvedLegs.map((l) => ({
                strike: l.strike,
                type: l.type,
                side: l.side,
                qtyRatio: l.qtyLots / Math.max(1, lots),
                entryPrice: l.price,
                securityId: l.securityId,
              })),
            };

            const existingStr = localStorage.getItem('positional_trades');
            const trades = existingStr ? JSON.parse(existingStr) : [];
            trades.unshift(newTrade);
            localStorage.setItem('positional_trades', JSON.stringify(trades));
          }
        } else {
          setOrderResult({ success: false, message: json.error || 'Order failed. No positions were recorded.' });
        }
      })
      .catch((err) => {
        setOrderResult({ success: false, message: String(err) });
      })
      .finally(() => {
        setEntering(false);
      });
  }, [resolvedLegs, mode, stats, selectedTemplate, selectedExpiry, lots, params, spot, target, stoploss, tradingType]);

  const handleExitTrade = useCallback(() => {
    if (!resolvedLegs) return;
    setExiting(true);
    setOrderResult(null);

    const legsPayload = resolvedLegs.map((l) => ({
      securityId: l.securityId,
      quantity: l.qtyLots * LOT_SIZE,
      side: l.side === 'BUY' ? 'SELL' : 'BUY',
    }));

    // Guard: all legs must have resolved security IDs
    const unresolved = legsPayload.filter((l) => !l.securityId);
    if (unresolved.length > 0) {
      setOrderResult({ success: false, message: 'Cannot exit trade — option chain not fully loaded. Refresh and retry.' });
      setExiting(false);
      return;
    }

    fetch('/api/options/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs: legsPayload, mode }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          const ids = json.data.map((o: any) => o.orderId).join(', ');
          setOrderResult({ success: true, message: `Strategy exited successfully. Order IDs: ${ids}` });
        } else {
          setOrderResult({ success: false, message: json.error || 'Failed to place exit orders.' });
        }
      })
      .catch((err) => {
        setOrderResult({ success: false, message: String(err) });
      })
      .finally(() => {
        setExiting(false);
      });
  }, [resolvedLegs, mode]);

  const handleUpdateLegStrike = useCallback((index: number, newStrike: number) => {
    if (!resolvedLegs) return;
    const updated = [...resolvedLegs];
    const leg = updated[index];
    
    const strikeKey = String(newStrike);
    const entry = chainOc[strikeKey] ?? chainOc[newStrike.toFixed(6)] ?? Object.entries(chainOc).find(([k]) => Math.abs(parseFloat(k) - newStrike) < 0.01)?.[1];
    const legData = leg.type === 'CE' ? entry?.ce : entry?.pe;
    
    if (!legData || typeof legData.last_price !== 'number') {
      return;
    }
    
    updated[index] = {
      ...leg,
      strike: newStrike,
      price: legData.last_price,
      delta: legData.greeks?.delta ?? null,
      iv: legData.implied_volatility ?? null,
      securityId: legData.security_id ? String(legData.security_id) : null,
    };
    
    setResolvedLegs(updated);
    
    const payoffStats = computePayoffStats(updated, spot, LOT_SIZE);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(updated, spot, LOT_SIZE));
    setTargetBreakevens(null);
    
    setMarginLoading(true);
    fetch('/api/options/margin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        underlying: UNDERLYING,
        expiry: selectedExpiry,
        legs: updated.map((l) => ({ strike: l.strike, type: l.type, side: l.side, qtyLots: l.qtyLots, price: l.price })),
      }),
    })
      .then((r) => r.json())
      .then((json) => setMargin(json?.success ? json.data : null))
      .catch(() => setMargin(null))
      .finally(() => setMarginLoading(false));
  }, [resolvedLegs, chainOc, spot, selectedExpiry]);

  const displayedCurve = useMemo(() => curve, [curve]);

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-300">
      <NavBar />

      <div className="sticky top-0 z-30 bg-zinc-900 border-b border-zinc-800 px-4 py-3">
        <div className="max-w-screen-xl mx-auto flex flex-wrap items-center gap-3">
          <h1 className="text-sm font-bold text-white mr-2">Strategy Builder</h1>
          <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded">NIFTY</span>
          <span className="text-xs font-mono bg-zinc-800 text-emerald-400 px-2 py-0.5 rounded">Spot: {spot.toFixed(1)}</span>

          <div className="ml-auto flex rounded-md overflow-hidden border border-zinc-700 text-xs">
            {(['builder', 'saved', 'positions'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-3 py-1 font-medium capitalize ${
                  activeTab === t ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t === 'builder' ? 'Builder' : t === 'saved' ? 'Saved Strategies' : 'Positions'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">
        {activeTab === 'positions' ? (
          <PositionalTradesTab />
        ) : activeTab === 'saved' ? (
          <SavedStrategiesTab />
        ) : (
          <>
            <StrategyCardGrid templates={STRATEGY_TEMPLATES} selectedId={selectedId} onSelect={handleSelectStrategy} />

             {selectedTemplate && (
              <StrategySettingsPanel
                template={selectedTemplate}
                params={params}
                onParamsChange={setParams}
                lots={lots}
                onLotsChange={setLots}
                target={target}
                onTargetChange={setTarget}
                stoploss={stoploss}
                onStoplossChange={setStoploss}
                mode={mode}
                onModeChange={setMode}
                tradingType={tradingType}
                onTradingTypeChange={setTradingType}
                expiryKindFilter={expiryKindFilter}
                onExpiryKindFilterChange={setExpiryKindFilter}
                expiries={expiries}
                selectedExpiry={selectedExpiry}
                onExpiryChange={setSelectedExpiry}
                onAnalyze={handleAnalyze}
                onSave={handleSave}
                canSave={mode === 'positional' && stats !== null && !saving}
                onEnterTrade={handleEnterTrade}
                onExitTrade={handleExitTrade}
                canEnter={stats !== null && resolvedLegs !== null && resolvedLegs.every(l => l.securityId !== null)}
                canExit={stats !== null && resolvedLegs !== null && resolvedLegs.every(l => l.securityId !== null)}
                entering={entering}
                exiting={exiting}
              />
            )}

            {missingStrikes.length > 0 && (
              <div className="bg-rose-950 border border-rose-800 text-rose-300 text-xs rounded-lg px-4 py-2.5">
                Chain data unavailable for strike(s): {missingStrikes.join(', ')}. Try a different expiry or offsets.
              </div>
            )}

            {orderResult && (
              <div className={`border rounded-lg px-4 py-2.5 text-xs font-semibold ${
                orderResult.success
                  ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                  : 'bg-rose-950/80 border-rose-800 text-rose-300'
              }`}>
                {orderResult.message}
              </div>
            )}

            {saveResult && (
              <div className={`border rounded-lg px-4 py-2.5 text-xs font-semibold ${
                saveResult.success
                  ? 'bg-sky-950/80 border-sky-800 text-sky-300'
                  : 'bg-rose-950/80 border-rose-800 text-rose-300'
              }`}>
                {saveResult.message}
              </div>
            )}

            {resolvedLegs && resolvedLegs.length > 0 && (
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider border-b border-zinc-800 pb-2">Strategy Legs</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-400 font-semibold">
                        <th className="px-3 py-2 text-left">B/S</th>
                        <th className="px-3 py-2 text-left">Expiry</th>
                        <th className="px-3 py-2 text-center w-40">Strike</th>
                        <th className="px-3 py-2 text-left">Type</th>
                        <th className="px-3 py-2 text-left">Price (LTP)</th>
                        <th className="px-3 py-2 text-left">Lots</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/40">
                      {resolvedLegs.map((leg, idx) => {
                        const sideColor = leg.side === 'BUY' ? 'text-sky-400 bg-sky-500/10 border border-sky-500/20' : 'text-rose-400 bg-rose-500/10 border border-rose-500/20';
                        return (
                          <tr key={idx} className="hover:bg-zinc-850/50 transition-colors">
                            <td className="px-3 py-3">
                              <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold ${sideColor}`}>
                                {leg.side === 'BUY' ? 'BUY' : 'SELL'}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-zinc-300 font-mono">
                              {selectedExpiry}
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex items-center justify-center gap-2">
                                <button
                                  onClick={() => handleUpdateLegStrike(idx, leg.strike - 50)}
                                  className="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-650 border border-zinc-700 rounded text-zinc-300 font-semibold"
                                >
                                  -
                                </button>
                                <span className="font-mono font-bold text-zinc-100 w-16 text-center">{leg.strike}</span>
                                <button
                                  onClick={() => handleUpdateLegStrike(idx, leg.strike + 50)}
                                  className="w-6 h-6 flex items-center justify-center bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-650 border border-zinc-700 rounded text-zinc-300 font-semibold"
                                >
                                  +
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-3">
                              <span className={`font-semibold font-mono ${leg.type === 'CE' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {leg.type}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-zinc-300 font-mono">
                              ₹{leg.price.toFixed(1)}
                            </td>
                            <td className="px-3 py-3 text-zinc-300 font-mono">
                              {leg.qtyLots}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {stats && (
              <>
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
                  <PayoffDiagram
                    curve={displayedCurve}
                    currentSpot={spot}
                    breakevens={breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? [])}
                  />
                </div>
                <StrategySummaryPanel
                  stats={stats}
                  targetBreakevens={targetBreakevens}
                  breakevenMode={breakevenMode}
                  onBreakevenModeChange={setBreakevenMode}
                  margin={margin}
                  marginLoading={marginLoading}
                  spot={spot}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
