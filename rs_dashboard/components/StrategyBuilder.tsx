'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import NavBar from '@/components/NavBar';
import StrategyCardGrid from '@/components/strategy/StrategyCardGrid';
import StrategySettingsPanel from '@/components/strategy/StrategySettingsPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import SavedStrategiesTab from '@/components/strategy/SavedStrategiesTab';
import PositionalTradesTab from '@/components/strategy/PositionalTradesTab';
import PctStrangleTab from '@/components/strategy/PctStrangleTab';
import {
  STRATEGY_TEMPLATES, getTemplate, defaultParams, classifyExpiries, computeAtm,
  resolveLegs, computePayoffStats, buildPayoffCurve, buildTargetPayoffCurve, findBreakevens,
  ChainOc, ResolvedLeg, PayoffStats,
} from '@/lib/optionsStrategy';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { AlertTriangle, CheckIcon, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

const UNDERLYING = 'NIFTY';
const FALLBACK_LOT_SIZE = 75;

type MarginData = { total_margin: number; hedge_benefit: number; available_funds: number };

export default function StrategyBuilder() {
  const [activeTab, setActiveTab] = useState<'builder' | 'saved' | 'positions' | 'pct_strangle'>('builder');
  const [target, setTarget] = useState<number | null>(null);
  const [stoploss, setStoploss] = useState<number | null>(null);

  const [expiries, setExpiries] = useState<{ date: string; kind: 'weekly' | 'monthly' }[]>([]);
  const [expiryKindFilter, setExpiryKindFilter] = useState<'weekly' | 'monthly' | 'all'>('all');
  const [selectedExpiry, setSelectedExpiry] = useState('');

  const [spot, setSpot] = useState(0);
  const [chainOc, setChainOc] = useState<ChainOc>({});
  // null until fetched — orders are blocked until the real lot size is known
  const [lotSize, setLotSize] = useState<number | null>(null);
  const effectiveLotSize = lotSize ?? FALLBACK_LOT_SIZE;

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

  // Fetch the current lot size from the master list once on mount
  useEffect(() => {
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then((r) => r.json())
      .then((json) => {
        const lot = Number(json?.lot_size);
        if (Number.isFinite(lot) && lot > 0) setLotSize(lot);
      })
      .catch(() => {});
  }, []);

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
    const payoffStats = computePayoffStats(legs, spot, effectiveLotSize, selectedExpiry);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(legs, spot, effectiveLotSize));
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
  }, [selectedTemplate, params, lots, spot, chainOc, selectedExpiry, effectiveLotSize]);

  // Recompute target breakevens on demand when the toggle is switched to 'target'
  useEffect(() => {
    if (breakevenMode !== 'target' || !resolvedLegs || targetBreakevens !== null) return;
    const expiryDate = new Date(selectedExpiry);
    const daysToExpiry = Math.max(0, Math.round((expiryDate.getTime() - Date.now()) / 86_400_000));
    const targetCurve = buildTargetPayoffCurve(resolvedLegs, spot, effectiveLotSize, daysToExpiry);
    setTargetBreakevens(findBreakevens(targetCurve));
  }, [breakevenMode, resolvedLegs, targetBreakevens, selectedExpiry, spot, effectiveLotSize]);

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
      lot_size: effectiveLotSize,
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
  }, [selectedTemplate, resolvedLegs, stats, selectedExpiry, lots, params, spot, saving, effectiveLotSize]);

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
          lotSize: effectiveLotSize,
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

    // Guard: never place live orders with the fallback lot size
    if (lotSize === null) {
      setOrderResult({ success: false, message: 'Cannot enter trade — lot size not loaded yet. Wait a moment and retry.' });
      setEntering(false);
      return;
    }

    const legsPayload = resolvedLegs.map((l) => ({
      securityId: l.securityId,
      quantity: l.qtyLots * lotSize,
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
              lotSize,
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
  }, [resolvedLegs, mode, stats, selectedTemplate, selectedExpiry, lots, params, spot, target, stoploss, tradingType, lotSize, effectiveLotSize]);

  const handleExitTrade = useCallback(() => {
    if (!resolvedLegs) return;
    setExiting(true);
    setOrderResult(null);

    // Guard: never place live orders with the fallback lot size
    if (lotSize === null) {
      setOrderResult({ success: false, message: 'Cannot exit trade — lot size not loaded yet. Wait a moment and retry.' });
      setExiting(false);
      return;
    }

    const legsPayload = resolvedLegs.map((l) => ({
      securityId: l.securityId,
      quantity: l.qtyLots * lotSize,
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
  }, [resolvedLegs, mode, lotSize]);

  const handleUpdateLegLots = useCallback((index: number, delta: number) => {
    if (!resolvedLegs) return;
    const updated = [...resolvedLegs];
    const newLots = Math.max(1, updated[index].qtyLots + delta);
    updated[index] = { ...updated[index], qtyLots: newLots };
    setResolvedLegs(updated);
    const payoffStats = computePayoffStats(updated, spot, effectiveLotSize, selectedExpiry);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(updated, spot, effectiveLotSize));
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
  }, [resolvedLegs, spot, selectedExpiry, effectiveLotSize]);

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
      iv: typeof legData.implied_volatility === 'number' ? legData.implied_volatility / 100 : null,
      vega: legData.greeks?.vega ?? null,
      securityId: legData.security_id ? String(legData.security_id) : null,
    };

    setResolvedLegs(updated);

    const payoffStats = computePayoffStats(updated, spot, effectiveLotSize, selectedExpiry);
    setStats(payoffStats);
    setCurve(buildPayoffCurve(updated, spot, effectiveLotSize));
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
  }, [resolvedLegs, chainOc, spot, selectedExpiry, effectiveLotSize]);

  const displayedCurve = useMemo(() => curve, [curve]);

  return (
    <div className="min-h-screen text-zinc-300">
      <NavBar />

      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="max-w-screen-xl mx-auto flex flex-wrap items-center gap-3">
          <h1 className="mr-2 text-sm font-bold text-white">Strategy Builder</h1>
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono text-zinc-300">NIFTY</Badge>
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-mono tabular-nums text-emerald-400">
            SPOT {spot > 0 ? spot.toFixed(1) : '—'}
          </Badge>
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono tabular-nums text-zinc-400">
            LOT {lotSize ?? '…'}
          </Badge>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as typeof activeTab)}
            className="ml-auto"
          >
            <TabsList className="bg-zinc-900">
              <TabsTrigger value="builder">Builder</TabsTrigger>
              <TabsTrigger value="pct_strangle">% Strangle</TabsTrigger>
              <TabsTrigger value="saved">Saved Strategies</TabsTrigger>
              <TabsTrigger value="positions">Positions</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">
        {activeTab === 'positions' ? (
          <PositionalTradesTab lotSize={lotSize} />
        ) : activeTab === 'saved' ? (
          <SavedStrategiesTab />
        ) : activeTab === 'pct_strangle' ? (
          <PctStrangleTab
            spot={spot}
            chainOc={chainOc}
            expiries={expiries}
            selectedExpiry={selectedExpiry}
            lotSize={lotSize}
          />
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
              <Alert className="border-rose-800/60 bg-rose-950/60 text-rose-300">
                <AlertTriangle />
                <AlertTitle className="text-xs font-semibold text-rose-300">
                  Chain data unavailable for strike(s): {missingStrikes.join(', ')}. Try a different expiry or offsets.
                </AlertTitle>
              </Alert>
            )}

            {orderResult && (
              <Alert
                className={cn(
                  orderResult.success
                    ? 'border-emerald-800/60 bg-emerald-950/60 text-emerald-300'
                    : 'border-rose-800/60 bg-rose-950/60 text-rose-300',
                )}
              >
                {orderResult.success ? <CheckIcon /> : <AlertTriangle />}
                <AlertTitle className={cn('text-xs font-semibold', orderResult.success ? 'text-emerald-300' : 'text-rose-300')}>
                  {orderResult.message}
                </AlertTitle>
              </Alert>
            )}

            {saveResult && (
              <Alert
                className={cn(
                  saveResult.success
                    ? 'border-sky-800/60 bg-sky-950/60 text-sky-300'
                    : 'border-rose-800/60 bg-rose-950/60 text-rose-300',
                )}
              >
                {saveResult.success ? <CheckIcon /> : <AlertTriangle />}
                <AlertTitle className={cn('text-xs font-semibold', saveResult.success ? 'text-sky-300' : 'text-rose-300')}>
                  {saveResult.message}
                </AlertTitle>
              </Alert>
            )}

            {resolvedLegs && resolvedLegs.length > 0 && (
              <Card className="bg-card/80">
                <CardHeader className="border-b [.border-b]:pb-3">
                  <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Strategy legs</CardTitle>
                </CardHeader>
                <CardContent className="px-0">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow className="bg-zinc-800 hover:bg-zinc-800">
                        <TableHead className="px-4 text-xs font-bold text-white">B/S</TableHead>
                        <TableHead className="text-xs font-bold text-white">Expiry</TableHead>
                        <TableHead className="w-40 text-center text-xs font-bold text-white">Strike</TableHead>
                        <TableHead className="text-xs font-bold text-white">Type</TableHead>
                        <TableHead className="text-xs font-bold text-white">LTP</TableHead>
                        <TableHead className="text-xs font-bold text-white">IV</TableHead>
                        <TableHead className="text-xs font-bold text-white">Delta</TableHead>
                        <TableHead className="text-xs font-bold text-white">Lots</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resolvedLegs.map((leg, idx) => (
                        <TableRow key={idx} className="border-zinc-800/60">
                          <TableCell className="px-4 py-3">
                            <Badge
                              variant="outline"
                              className={cn(
                                'rounded-md text-[10px] font-bold',
                                leg.side === 'BUY'
                                  ? 'border-sky-500/30 bg-sky-500/10 text-sky-400'
                                  : 'border-rose-500/30 bg-rose-500/10 text-rose-400',
                              )}
                            >
                              {leg.side}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-3 font-mono text-zinc-300">{selectedExpiry}</TableCell>
                          <TableCell className="py-3">
                            <div className="flex items-center justify-center gap-1.5">
                              <Button
                                variant="outline"
                                size="icon-xs"
                                aria-label={`Decrease ${leg.type} strike`}
                                onClick={() => handleUpdateLegStrike(idx, leg.strike - 50)}
                              >
                                <Minus />
                              </Button>
                              <span className="w-16 text-center font-mono font-bold tabular-nums text-zinc-100">{leg.strike}</span>
                              <Button
                                variant="outline"
                                size="icon-xs"
                                aria-label={`Increase ${leg.type} strike`}
                                onClick={() => handleUpdateLegStrike(idx, leg.strike + 50)}
                              >
                                <Plus />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className={cn('py-3 font-mono font-semibold', leg.type === 'CE' ? 'text-emerald-400' : 'text-rose-400')}>
                            {leg.type}
                          </TableCell>
                          <TableCell className="py-3 font-mono tabular-nums text-zinc-200">₹{leg.price.toFixed(1)}</TableCell>
                          <TableCell className="py-3 font-mono tabular-nums text-zinc-400">
                            {leg.iv !== null ? `${(leg.iv * 100).toFixed(1)}%` : '—'}
                          </TableCell>
                          <TableCell className="py-3 font-mono tabular-nums text-zinc-400">
                            {leg.delta !== null ? leg.delta.toFixed(2) : '—'}
                          </TableCell>
                          <TableCell className="py-3">
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="icon-xs"
                                aria-label={`Decrease ${leg.type} lots`}
                                onClick={() => handleUpdateLegLots(idx, -1)}
                              >
                                <Minus />
                              </Button>
                              <span className="w-6 text-center font-mono font-bold tabular-nums text-zinc-100">{leg.qtyLots}</span>
                              <Button
                                variant="outline"
                                size="icon-xs"
                                aria-label={`Increase ${leg.type} lots`}
                                onClick={() => handleUpdateLegLots(idx, 1)}
                              >
                                <Plus />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {stats && (
              <>
                <Card className="bg-card/80">
                  <CardHeader className="border-b [.border-b]:pb-3">
                    <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Payoff at expiry</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <PayoffDiagram
                      curve={displayedCurve}
                      currentSpot={spot}
                      breakevens={breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? [])}
                    />
                  </CardContent>
                </Card>
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
