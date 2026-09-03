'use client';

import React, { useState, useEffect } from 'react';
import {
  Search,
  Sliders,
  ShieldCheck,
  Zap,
  TrendingUp,
  TrendingDown,
  Activity,
  Layers,
  CheckCircle,
  Plus,
  ArrowRight,
  Sparkles,
  RefreshCw,
  Eye,
  LayoutGrid,
  Table as TableIcon,
  HelpCircle,
} from 'lucide-react';
import type {
  StrategyType,
  UnderlyingType,
  RiskProfile,
  ScanFilters,
  ScannedStrategy,
  ScanResponse,
} from '@/lib/ultimateScannerTypes';

interface ScannerStepProps {
  onAddToWatchlist: (candidate: ScannedStrategy) => void;
  onTradeInMultiLegFocus: (candidate: ScannedStrategy) => void;
  onNavigateToWatchlist: () => void;
  watchlistCount: number;
}

const STRATEGY_OPTIONS: { id: StrategyType; label: string; desc: string; category: string }[] = [
  { id: 'bull_put_spread', label: 'Bull Put Spread', desc: 'Credit Put Spread for bullish/neutral bias', category: 'Credit Spreads' },
  { id: 'bear_call_spread', label: 'Bear Call Spread', desc: 'Credit Call Spread for bearish/neutral bias', category: 'Credit Spreads' },
  { id: 'iron_condor', label: 'Iron Condor', desc: '4-leg range-bound market neutral setup', category: 'Range Bound' },
  { id: 'short_strangle', label: 'Short Strangle', desc: 'OTM Call & Put sell for high decay collection', category: 'Range Bound' },
  { id: 'jade_lizard', label: 'Jade Lizard', desc: 'Bull Put + Bear Call Spread with zero upside risk', category: 'Asymmetric' },
  { id: 'naked_put', label: 'Naked Put / CSP', desc: 'Cash Secured Put for strong support bounces', category: 'Naked' },
];

export default function ScannerStep({
  onAddToWatchlist,
  onTradeInMultiLegFocus,
  onNavigateToWatchlist,
  watchlistCount,
}: ScannerStepProps) {
  // ── Filters State ───────────────────────────────────────────────────
  const [underlying, setUnderlying] = useState<UnderlyingType | 'ALL'>('ALL');
  const [minRom, setMinRom] = useState<number>(2.5);
  const [minDistancePct, setMinDistancePct] = useState<number>(1.5);
  const [maxDistancePct, setMaxDistancePct] = useState<number>(6.0);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('all');
  const [selectedStrategies, setSelectedStrategies] = useState<StrategyType[]>([
    'bull_put_spread',
    'bear_call_spread',
    'iron_condor',
  ]);
  const [sortBy, setSortBy] = useState<'score' | 'rom' | 'pop' | 'premium' | 'distance'>('score');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');

  // ── Scan Data State ────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  // ── Run Scan Function ──────────────────────────────────────────────
  const handleRunScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload: Partial<ScanFilters> = {
        underlying,
        minRom,
        minDistancePct,
        maxDistancePct,
        riskProfile,
        strategyTypes: selectedStrategies,
        sortBy,
        maxResults: 60,
      };

      const res = await fetch('/api/ultimate-scanner/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as ScanResponse;
      if (data.success) {
        setScanResult(data);
      } else {
        setError(data.error || 'Failed to scan option chains');
      }
    } catch (err: unknown) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  };

  // Initial scan on mount
  useEffect(() => {
    handleRunScan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStrategy = (strat: StrategyType) => {
    setSelectedStrategies(prev =>
      prev.includes(strat) ? prev.filter(s => s !== strat) : [...prev, strat]
    );
  };

  const handleAdd = (strat: ScannedStrategy) => {
    onAddToWatchlist(strat);
    setAddedIds(prev => new Set([...prev, strat.id]));
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Top VIX & Market Regime Banner ─────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* VIX Card */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <Activity className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">India VIX</p>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold text-white tabular-nums">
                  {scanResult?.vix.vix ? scanResult.vix.vix.toFixed(2) : '13.50'}
                </span>
                <span
                  className={`text-xs font-semibold tabular-nums ${
                    (scanResult?.vix.change ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {(scanResult?.vix.change ?? 0) >= 0 ? '+' : ''}
                  {scanResult?.vix.changePct ? scanResult.vix.changePct.toFixed(2) : '0.00'}%
                </span>
              </div>
            </div>
          </div>
          <span className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/30">
            {scanResult?.vix.regime || 'Normal Volatility'}
          </span>
        </div>

        {/* Spot Tickers Card */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Spot Prices</p>
              <div className="flex items-center gap-3 mt-0.5">
                <div className="text-xs font-medium">
                  <span className="text-zinc-400">NIFTY: </span>
                  <span className="text-white font-bold tabular-nums">
                    {scanResult?.spotPrices?.NIFTY ? scanResult.spotPrices.NIFTY.toLocaleString('en-IN') : '—'}
                  </span>
                </div>
                <div className="text-xs font-medium">
                  <span className="text-zinc-400">SENSEX: </span>
                  <span className="text-white font-bold tabular-nums">
                    {scanResult?.spotPrices?.SENSEX ? scanResult.spotPrices.SENSEX.toLocaleString('en-IN') : '—'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Process Status & Watchlist Link */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Step 1: Scanner Results</p>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-xl font-bold text-emerald-400 tabular-nums">
                {scanResult?.shortlistedCount ?? 0}
              </span>
              <span className="text-xs text-zinc-400">setups shortlisted</span>
            </div>
          </div>
          <button
            onClick={onNavigateToWatchlist}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white transition-all border border-zinc-700"
          >
            <Eye className="w-4 h-4 text-emerald-400" />
            Watchlist ({watchlistCount})
            <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />
          </button>
        </div>
      </div>

      {/* ── Interactive Scanner Preferences & Filters ─────────────── */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-5 shadow-xl">
        <div className="flex items-center justify-between flex-wrap gap-3 pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-emerald-400" />
            <h2 className="text-sm font-bold text-white tracking-wide">Scanner Preferences & Risk Sizing</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRunScan}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-lg shadow-emerald-900/30 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Scanning Chains...' : 'Scan Option Chains'}
            </button>
          </div>
        </div>

        {/* Filters Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* 1. Underlying Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
              Index Underlying
            </label>
            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
              {(['ALL', 'NIFTY', 'SENSEX'] as const).map(u => (
                <button
                  key={u}
                  onClick={() => setUnderlying(u)}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    underlying === u
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {u === 'ALL' ? 'Nifty + Sensex' : u}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Return on Margin (RoM %) Slider */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Min. Profit / RoM %
              </label>
              <span className="text-xs font-bold text-emerald-400 tabular-nums bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                &ge; {minRom.toFixed(1)}% / cycle
              </span>
            </div>
            <input
              type="range"
              min="0.5"
              max="10.0"
              step="0.5"
              value={minRom}
              onChange={e => setMinRom(parseFloat(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg mt-2"
            />
            <div className="flex justify-between items-center text-[10px] text-zinc-500 font-medium">
              <span>0.5% (Ultra Safe)</span>
              <span>3.0% (Balanced)</span>
              <span>10.0%+ (Aggressive)</span>
            </div>
          </div>

          {/* 3. Distance Threshold (% OTM) Slider */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Distance Threshold
              </label>
              <span className="text-xs font-bold text-cyan-400 tabular-nums bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                {minDistancePct.toFixed(1)}% - {maxDistancePct.toFixed(1)}% OTM
              </span>
            </div>
            <input
              type="range"
              min="0.5"
              max="6.0"
              step="0.5"
              value={minDistancePct}
              onChange={e => setMinDistancePct(parseFloat(e.target.value))}
              className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg mt-2"
            />
            <div className="flex justify-between items-center text-[10px] text-zinc-500 font-medium">
              <span>0.5% (Near ATM)</span>
              <span>2.5% (Safe)</span>
              <span>6.0% (Far OTM)</span>
            </div>
          </div>

          {/* 4. Risk Profile */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
              Risk Profile (POP & Delta)
            </label>
            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
              {(['all', 'conservative', 'moderate', 'aggressive'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setRiskProfile(p)}
                  className={`flex-1 py-1.5 text-[11px] font-semibold capitalize rounded-lg transition-all ${
                    riskProfile === p
                      ? 'bg-zinc-800 text-white border border-zinc-700'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Strategy Selector Chips */}
        <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800/80">
          <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
            Shortlist Option Strategies:
          </label>
          <div className="flex flex-wrap gap-2">
            {STRATEGY_OPTIONS.map(opt => {
              const active = selectedStrategies.includes(opt.id);
              return (
                <button
                  key={opt.id}
                  onClick={() => toggleStrategy(opt.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-2 border transition-all ${
                    active
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 shadow-sm'
                      : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${
                      active ? 'bg-emerald-400 shadow-sm shadow-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Results Header & Sort Controls ─────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-400" />
          <h3 className="text-xs font-bold text-white uppercase tracking-wider">
            Shortlisted Strategies ({scanResult?.candidates?.length ?? 0})
          </h3>
        </div>

        <div className="flex items-center gap-3">
          {/* Sort Selector */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span>Sort by:</span>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as typeof sortBy)}
              className="bg-zinc-900 border border-zinc-800 text-white rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-emerald-500"
            >
              <option value="score">Composite Score</option>
              <option value="rom">Highest RoM %</option>
              <option value="pop">Highest POP %</option>
              <option value="premium">Net Premium</option>
              <option value="distance">Distance OTM</option>
            </select>
          </div>

          {/* View Mode Toggle */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setViewMode('cards')}
              className={`p-1.5 rounded ${viewMode === 'cards' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500'}`}
              title="Cards View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded ${viewMode === 'table' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-500'}`}
              title="Table View"
            >
              <TableIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Error Banner ───────────────────────────────────────────── */}
      {error && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-red-400 text-xs">
          <strong>Scan Error:</strong> {error}
        </div>
      )}

      {/* ── Loading Skeleton ───────────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div
              key={i}
              className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl p-5 h-64 animate-pulse flex flex-col justify-between"
            >
              <div className="flex justify-between">
                <div className="w-32 h-4 bg-zinc-800 rounded" />
                <div className="w-16 h-4 bg-zinc-800 rounded" />
              </div>
              <div className="space-y-2">
                <div className="w-full h-3 bg-zinc-800/60 rounded" />
                <div className="w-3/4 h-3 bg-zinc-800/60 rounded" />
              </div>
              <div className="w-full h-8 bg-zinc-800/80 rounded-xl" />
            </div>
          ))}
        </div>
      )}

      {/* ── Results: Cards View ────────────────────────────────────── */}
      {!loading && viewMode === 'cards' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scanResult?.candidates?.map(strat => {
            const isAdded = addedIds.has(strat.id);
            return (
              <div
                key={strat.id}
                className="bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 rounded-2xl p-5 flex flex-col justify-between gap-4 transition-all hover:shadow-xl relative overflow-hidden group"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white tracking-wide">{strat.name}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                        {strat.underlying}
                      </span>
                      <span className="text-[10px] text-zinc-400 font-mono">
                        Exp: {strat.expiry} ({strat.dte.toFixed(0)}d)
                      </span>
                    </div>
                  </div>

                  {/* RoM Highlight Badge */}
                  <div className="text-right">
                    <span className="px-2.5 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-bold text-xs tabular-nums">
                      {strat.romPct.toFixed(1)}% RoM
                    </span>
                    <p className="text-[9px] text-zinc-500 font-mono mt-0.5">
                      {strat.romAnnualizedPct.toLocaleString()}% p.a.
                    </p>
                  </div>
                </div>

                {/* Key Metrics Grid */}
                <div className="grid grid-cols-3 gap-2 p-3 bg-zinc-950/80 rounded-xl border border-zinc-800/80 text-center">
                  <div>
                    <p className="text-[9px] font-bold text-zinc-500 uppercase">Net Credit</p>
                    <p className="text-xs font-bold text-white tabular-nums mt-0.5">
                      ₹{strat.netPremium.toLocaleString('en-IN')}
                    </p>
                    <p className="text-[9px] text-zinc-400">({strat.netPremiumPoints.toFixed(1)} pts)</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-zinc-500 uppercase">Est. Margin</p>
                    <p className="text-xs font-bold text-zinc-300 tabular-nums mt-0.5">
                      ₹{(strat.estMargin / 1000).toFixed(0)}k
                    </p>
                    <p className="text-[9px] text-zinc-500">1 Lot</p>
                  </div>
                  <div>
                    <p className="text-[9px] font-bold text-zinc-500 uppercase">Prob. of Profit</p>
                    <p className="text-xs font-bold text-cyan-400 tabular-nums mt-0.5">
                      {strat.popPct.toFixed(0)}%
                    </p>
                    <p className="text-[9px] text-cyan-500/80">{strat.distancePct.toFixed(1)}% OTM</p>
                  </div>
                </div>

                {/* Legs Breakdown */}
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Strategy Legs</p>
                  <div className="space-y-1">
                    {strat.legs.map((leg, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-xs px-2.5 py-1 rounded bg-zinc-950/50 border border-zinc-800/60 font-mono"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${
                              leg.side === 'SELL' ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
                            }`}
                          >
                            {leg.side}
                          </span>
                          <span className="text-white font-bold">{leg.strike}</span>
                          <span className={leg.option === 'CE' ? 'text-emerald-400' : 'text-red-400'}>
                            {leg.option}
                          </span>
                        </div>
                        <span className="text-zinc-300 tabular-nums">₹{leg.ltp.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Risk / Reward & Breakevens Info */}
                <div className="flex items-center justify-between text-[10px] text-zinc-400 pt-2 border-t border-zinc-800/60">
                  <span>
                    BE: <strong className="text-zinc-200">{strat.breakevens.map(b => b.toFixed(0)).join(' - ')}</strong>
                  </span>
                  <span
                    className={`font-semibold ${
                      strat.riskTier === 'Conservative'
                        ? 'text-emerald-400'
                        : strat.riskTier === 'Moderate'
                        ? 'text-amber-400'
                        : 'text-red-400'
                    }`}
                  >
                    {strat.riskTier} Risk
                  </span>
                </div>

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => handleAdd(strat)}
                    disabled={isAdded}
                    className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                      isAdded
                        ? 'bg-zinc-800 text-zinc-400 border-zinc-700 cursor-default'
                        : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border-emerald-500/30'
                    }`}
                  >
                    {isAdded ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                        In Watchlist
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5" />
                        Add to Watchlist
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => onTradeInMultiLegFocus(strat)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold transition-all border border-zinc-700"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    Focus Trade
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Results: Table View ────────────────────────────────────── */}
      {!loading && viewMode === 'table' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto shadow-xl">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider">
              <tr>
                <th className="py-3 px-4">Strategy</th>
                <th className="py-3 px-3">Underlying</th>
                <th className="py-3 px-3">Expiry</th>
                <th className="py-3 px-3">Strikes</th>
                <th className="py-3 px-3 text-right">Net Credit</th>
                <th className="py-3 px-3 text-right">Est Margin</th>
                <th className="py-3 px-3 text-right">RoM %</th>
                <th className="py-3 px-3 text-right">POP %</th>
                <th className="py-3 px-3 text-right">Distance</th>
                <th className="py-3 px-3 text-center">Risk Tier</th>
                <th className="py-3 px-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {scanResult?.candidates?.map(strat => {
                const isAdded = addedIds.has(strat.id);
                return (
                  <tr key={strat.id} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="py-3 px-4 font-bold text-white">{strat.name}</td>
                    <td className="py-3 px-3">{strat.underlying}</td>
                    <td className="py-3 px-3 font-mono">{strat.expiry}</td>
                    <td className="py-3 px-3 font-mono">
                      {strat.legs.map(l => `${l.side}${l.strike}${l.option}`).join(' / ')}
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-emerald-400 tabular-nums">
                      ₹{strat.netPremium.toLocaleString('en-IN')}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      ₹{(strat.estMargin / 1000).toFixed(0)}k
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-emerald-400 tabular-nums">
                      {strat.romPct.toFixed(1)}%
                    </td>
                    <td className="py-3 px-3 text-right text-cyan-400 font-bold tabular-nums">
                      {strat.popPct.toFixed(0)}%
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {strat.distancePct.toFixed(1)}%
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span
                        className={`px-2 py-0.5 text-[10px] font-bold rounded ${
                          strat.riskTier === 'Conservative'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : strat.riskTier === 'Moderate'
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-red-500/20 text-red-400'
                        }`}
                      >
                        {strat.riskTier}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          onClick={() => handleAdd(strat)}
                          disabled={isAdded}
                          className="px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 text-xs font-semibold disabled:opacity-40"
                        >
                          {isAdded ? 'Added' : '+ Watch'}
                        </button>
                        <button
                          onClick={() => onTradeInMultiLegFocus(strat)}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold"
                        >
                          Trade
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
