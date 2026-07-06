'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import NavBar from '@/components/NavBar';
import StrategyCardGrid from '@/components/strategy/StrategyCardGrid';
import StrategySettingsPanel from '@/components/strategy/StrategySettingsPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import StrategySummaryPanel from '@/components/strategy/StrategySummaryPanel';
import SavedStrategiesTab from '@/components/strategy/SavedStrategiesTab';
import {
  STRATEGY_TEMPLATES, getTemplate, defaultParams, classifyExpiries, computeAtm,
  resolveLegs, computePayoffStats, buildPayoffCurve, buildTargetPayoffCurve, findBreakevens,
  ChainOc, ResolvedLeg, PayoffStats,
} from '@/lib/optionsStrategy';

const UNDERLYING = 'NIFTY';
const LOT_SIZE = 75;

type MarginData = { total_margin: number; hedge_benefit: number; available_funds: number };

export default function StrategyBuilder() {
  const [activeTab, setActiveTab] = useState<'builder' | 'saved'>('builder');

  const [expiries, setExpiries] = useState<{ date: string; kind: 'weekly' | 'monthly' }[]>([]);
  const [expiryKindFilter, setExpiryKindFilter] = useState<'weekly' | 'monthly' | 'all'>('all');
  const [selectedExpiry, setSelectedExpiry] = useState('');

  const [spot, setSpot] = useState(0);
  const [chainOc, setChainOc] = useState<ChainOc>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, number>>({});
  const [lots, setLots] = useState(1);
  const [mode, setMode] = useState<'intraday' | 'positional'>('intraday');

  const [resolvedLegs, setResolvedLegs] = useState<ResolvedLeg[] | null>(null);
  const [missingStrikes, setMissingStrikes] = useState<number[]>([]);
  const [stats, setStats] = useState<PayoffStats | null>(null);
  const [curve, setCurve] = useState<{ spot: number; pnl: number }[]>([]);
  const [breakevenMode, setBreakevenMode] = useState<'target' | 'expiry'>('expiry');
  const [targetBreakevens, setTargetBreakevens] = useState<number[] | null>(null);

  const [margin, setMargin] = useState<MarginData | null>(null);
  const [marginLoading, setMarginLoading] = useState(false);

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
  }, []);

  const handleAnalyze = useCallback(() => {
    if (!selectedTemplate) return;
    const atm = computeAtm(spot);
    const specs = selectedTemplate.legs(params);
    const { legs, missingStrikes: missing } = resolveLegs(specs, atm, lots, chainOc);
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
    if (!selectedTemplate || !resolvedLegs || !stats) return;
    const payload = {
      strategy_type: selectedTemplate.id,
      display_name: selectedTemplate.name,
      underlying: UNDERLYING,
      expiry: selectedExpiry,
      mode: 'positional',
      lots,
      lot_size: LOT_SIZE,
      params,
      entry_spot: spot,
      entry_net_premium: stats.netPremium,
      legs: resolvedLegs.map((l) => ({
        strike: l.strike, option_type: l.type, side: l.side, qty_lots: l.qtyLots,
        entry_price: l.price, entry_delta: l.delta, security_id: null,
      })),
      notes: null,
    };
    fetch('/api/saved-strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, [selectedTemplate, resolvedLegs, stats, selectedExpiry, lots, params, spot]);

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
            {(['builder', 'saved'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`px-3 py-1 font-medium capitalize ${
                  activeTab === t ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t === 'builder' ? 'Builder' : 'Saved Strategies'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-screen-xl mx-auto px-4 py-6 space-y-6">
        {activeTab === 'saved' ? (
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
                mode={mode}
                onModeChange={setMode}
                expiryKindFilter={expiryKindFilter}
                onExpiryKindFilterChange={setExpiryKindFilter}
                expiries={expiries}
                selectedExpiry={selectedExpiry}
                onExpiryChange={setSelectedExpiry}
                onAnalyze={handleAnalyze}
                onSave={handleSave}
                canSave={mode === 'positional' && stats !== null}
              />
            )}

            {missingStrikes.length > 0 && (
              <div className="bg-rose-950 border border-rose-800 text-rose-300 text-xs rounded-lg px-4 py-2.5">
                Chain data unavailable for strike(s): {missingStrikes.join(', ')}. Try a different expiry or offsets.
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
