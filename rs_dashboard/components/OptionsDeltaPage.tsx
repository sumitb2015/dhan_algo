'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { 
  ShieldAlert, 
  RotateCw, 
  TrendingUp, 
  TrendingDown, 
  Minus, 
  Info,
  Layers,
  ArrowUpDown,
  Download,
  ToggleLeft,
  ToggleRight
} from 'lucide-react';
import NavBar from './NavBar';

// ── Types ────────────────────────────────────────────────────────────

interface Leg {
  securityId: string;
  symbol: string;
  displayName: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  netQty: number;
  ltp: number;
  entryPrice: number;
  pnl: number;
  lotSize: number;
  spot: number;
  delta: number;
  positionDelta: number;
  lotDelta: number;
}

interface ApiResponse {
  has_positions: boolean;
  net_delta: number;
  net_lot_delta: number;
  legs: Leg[];
  timestamp: string;
  error?: string;
}

const POLL_INTERVALS = [
  { label: 'Manual', ms: 0 },
  { label: '2s', ms: 2000 },
  { label: '5s', ms: 5000 },
  { label: '10s', ms: 10000 },
] as const;

// ── Mock Data for Testing ────────────────────────────────────────────

const MOCK_LEGS: Leg[] = [
  {
    securityId: "51385",
    symbol: "NIFTY-JUL2026-24300-CE",
    displayName: "NIFTY 14 JUL 24300 CALL",
    underlying: "NIFTY",
    expiry: "2026-07-14",
    strike: 24300,
    type: "CE",
    side: "SELL",
    netQty: -65, // 1 Lot Short
    ltp: 110.5,
    entryPrice: 145.2,
    pnl: 2255.5,
    lotSize: 65,
    spot: 24285.5,
    delta: 0.4852,
    positionDelta: -31.54,
    lotDelta: -0.4852,
  },
  {
    securityId: "51386",
    symbol: "NIFTY-JUL2026-24100-PE",
    displayName: "NIFTY 14 JUL 24100 PUT",
    underlying: "NIFTY",
    expiry: "2026-07-14",
    strike: 24100,
    type: "PE",
    side: "SELL",
    netQty: -130, // 2 Lots Short
    ltp: 85.2,
    entryPrice: 98.4,
    pnl: 858.0,
    lotSize: 65,
    spot: 24285.5,
    delta: -0.2241,
    positionDelta: 29.13,
    lotDelta: 0.4482,
  },
  {
    securityId: "51387",
    symbol: "NIFTY-JUL2026-24500-CE",
    displayName: "NIFTY 14 JUL 24500 CALL",
    underlying: "NIFTY",
    expiry: "2026-07-14",
    strike: 24500,
    type: "CE",
    side: "BUY",
    netQty: 195, // 3 Lots Long
    ltp: 35.4,
    entryPrice: 42.1,
    pnl: -871.0,
    lotSize: 65,
    spot: 24285.5,
    delta: 0.1584,
    positionDelta: 30.89,
    lotDelta: 0.4752,
  }
];

// ── Helpers ──────────────────────────────────────────────────────────

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
}

export default function OptionsDeltaPage() {
  const [legs, setLegs] = useState<Leg[]>([]);
  const [netDelta, setNetDelta] = useState(0);
  const [netLotDelta, setNetLotDelta] = useState(0);
  const [timestamp, setTimestamp] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState<number>(5000);
  const [useMock, setUseMock] = useState(false);
  const [sortField, setSortField] = useState<keyof Leg>('symbol');
  const [sortAsc, setSortAsc] = useState(true);

  // Fetch Delta Data
  const fetchData = useCallback(async () => {
    if (useMock) {
      setLegs(MOCK_LEGS);
      const totalDelta = MOCK_LEGS.reduce((sum, l) => sum + l.positionDelta, 0);
      const totalLotDelta = MOCK_LEGS.reduce((sum, l) => sum + l.lotDelta, 0);
      setNetDelta(totalDelta);
      setNetLotDelta(totalLotDelta);
      setTimestamp(new Date().toISOString());
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/options/positions-delta');
      const data = await res.json() as ApiResponse;

      if (data.error === 'auth') {
        setError('Authentication expired. Run login.py to refresh Dhan access token.');
        setLoading(false);
        return;
      }

      setLegs(data.legs || []);
      setNetDelta(data.net_delta || 0);
      setNetLotDelta(data.net_lot_delta || 0);
      setTimestamp(data.timestamp || new Date().toISOString());
      setError(null);
    } catch (err) {
      setError('Network error fetching positions delta.');
    } finally {
      setLoading(false);
    }
  }, [useMock]);

  // Handle Mock Toggle
  const handleToggleMock = () => {
    setUseMock(prev => !prev);
  };

  // Poll setup
  useEffect(() => {
    fetchData();
    if (pollMs <= 0) return;
    const interval = setInterval(fetchData, pollMs);
    return () => clearInterval(interval);
  }, [fetchData, pollMs]);

  // Export to CSV helper
  const handleExportCSV = () => {
    if (legs.length === 0) return;
    const headers = ['Symbol', 'Expiry', 'Strike', 'Type', 'Side', 'Qty', 'LTP', 'Entry Price', 'Unrealized P&L', 'Delta (Unit)', 'Delta (Position)', 'Delta (Lots)'];
    const csvRows = [
      headers.join(','),
      ...legs.map(l => [
        l.symbol,
        l.expiry,
        l.strike,
        l.type,
        l.side,
        l.netQty,
        l.ltp,
        l.entryPrice,
        l.pnl,
        l.delta,
        l.positionDelta,
        l.lotDelta
      ].join(','))
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `options_net_delta_${new Date().toISOString().slice(0,10)}.csv`);
    a.click();
  };

  // Sorting
  const sortedLegs = useMemo(() => {
    return [...legs].sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortAsc ? valA - valB : valB - valA;
      }
      return 0;
    });
  }, [legs, sortField, sortAsc]);

  const toggleSort = (field: keyof Leg) => {
    if (sortField === field) {
      setSortAsc(asc => !asc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  // Derived properties
  const openLegsCount = legs.length;
  const bias = netLotDelta > 0.1 ? 'BULLISH' : netLotDelta < -0.1 ? 'BEARISH' : 'NEUTRAL';
  const biasClass = 
    bias === 'BULLISH' ? 'text-emerald-400 border-emerald-500/20 bg-emerald-500/10' :
    bias === 'BEARISH' ? 'text-red-400 border-red-500/20 bg-red-500/10' :
    'text-zinc-400 border-zinc-700/60 bg-zinc-800/40';

  const biasIcon = 
    bias === 'BULLISH' ? <TrendingUp className="h-4 w-4" /> :
    bias === 'BEARISH' ? <TrendingDown className="h-4 w-4" /> :
    <Minus className="h-4 w-4" />;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
              <Layers className="h-4 w-4 text-emerald-400" />
              Net Delta exposure
            </h1>
            <p className="text-[10px] text-zinc-400 font-medium">
              Live Options Delta & Directional Portfolio Exposure
            </p>
          </div>

          <Link
            href="/options"
            className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            ← Straddle Charts
          </Link>

          <NavBar />
        </div>

        {/* Polling / Mock Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Mock Mode Toggle */}
          <button
            onClick={handleToggleMock}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
              useMock 
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            {useMock ? <ToggleRight className="h-4 w-4 text-amber-400" /> : <ToggleLeft className="h-4 w-4 text-zinc-500" />}
            Demo Mode {useMock ? 'On' : 'Off'}
          </button>

          {/* Polling selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
            {POLL_INTERVALS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => setPollMs(ms)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  pollMs === ms
                    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Manual Refresh */}
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-750 border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
            title="Refresh delta risk"
          >
            <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* CSV Export */}
          <button
            onClick={handleExportCSV}
            disabled={legs.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-zinc-750 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-all disabled:opacity-35"
            title="Export positions to CSV"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {error && (
          <div className="flex items-start gap-2.5 px-4 py-3 bg-red-950/20 border border-red-750/30 rounded-xl text-xs text-red-400">
            <ShieldAlert className="h-4.5 w-4.5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Failed to fetch live delta exposure</p>
              <p className="text-[11px] text-red-400/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Net Delta (Index Units) */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl px-5 py-4">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5 flex items-center gap-1">
              Net Delta (Index)
              <Info className="h-3 w-3 text-zinc-600" title="Index-equivalent units. 1.00 Net Delta is equivalent to holding 1 share of Nifty index." />
            </p>
            <h2 className={`text-2xl font-black tracking-tight tabular-nums ${
              netDelta > 1 ? 'text-emerald-400' : netDelta < -1 ? 'text-red-400' : 'text-zinc-200'
            }`}>
              {netDelta > 0 ? '+' : ''}{fmtNum(netDelta)}
            </h2>
            <p className="text-[10px] text-zinc-500 mt-1 font-medium">
              Index share equivalents
            </p>
          </div>

          {/* Card 2: Net Delta (Lots) */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl px-5 py-4">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5 flex items-center gap-1">
              Net Delta (Lots)
              <Info className="h-3 w-3 text-zinc-600" title="Calculated based on standard index contract lot size (e.g. 65 for Nifty)." />
            </p>
            <h2 className={`text-2xl font-black tracking-tight tabular-nums ${
              netLotDelta > 0.05 ? 'text-emerald-400' : netLotDelta < -0.05 ? 'text-red-400' : 'text-zinc-200'
            }`}>
              {netLotDelta > 0 ? '+' : ''}{fmtNum(netLotDelta, 3)}
            </h2>
            <p className="text-[10px] text-zinc-500 mt-1 font-medium">
              Index contract lot equivalents
            </p>
          </div>

          {/* Card 3: Exposure Directional Bias */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl px-5 py-4">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
              Directional Bias
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border ${biasClass}`}>
                {biasIcon}
                {bias}
              </span>
            </div>
            <p className="text-[10px] text-zinc-500 mt-2 font-medium">
              Based on net lot delta exposure
            </p>
          </div>

          {/* Card 4: Open Legs */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl px-5 py-4">
            <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
              Open Option Legs
            </p>
            <h2 className="text-2xl font-black tracking-tight text-zinc-200 tabular-nums">
              {openLegsCount}
            </h2>
            <p className="text-[10px] text-zinc-500 mt-1 font-medium flex items-center justify-between">
              <span>Active F&amp;O Positions</span>
              {timestamp && <span className="font-mono text-[9px] text-zinc-600">Updated: {fmtTime(timestamp)}</span>}
            </p>
          </div>
        </div>

        {/* Positions Table Grid */}
        <div className="bg-zinc-900/60 border border-zinc-850 rounded-2xl overflow-hidden shadow-2xl">
          <div className="px-5 py-4 border-b border-zinc-850 flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight">Active Option Positions &amp; Greeks</h3>
              <p className="text-[10px] text-zinc-400 mt-0.5">Click column headers to sort positions</p>
            </div>
            {useMock && (
              <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                DISPLAYING DEMO DATA
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-zinc-850/60 text-zinc-400 font-bold border-b border-zinc-800 select-none">
                  <th onClick={() => toggleSort('symbol')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors">
                    <div className="flex items-center gap-1">Symbol <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('expiry')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-center">
                    <div className="flex items-center justify-center gap-1">Expiry <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('strike')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-center">
                    <div className="flex items-center justify-center gap-1">Strike <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('type')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-center">
                    <div className="flex items-center justify-center gap-1">Type <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('side')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-center">
                    <div className="flex items-center justify-center gap-1">Side <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('netQty')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right">
                    <div className="flex items-center justify-end gap-1">Qty <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('ltp')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right">
                    <div className="flex items-center justify-end gap-1">LTP <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('pnl')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right">
                    <div className="flex items-center justify-end gap-1">P&amp;L <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('delta')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right border-l border-zinc-800">
                    <div className="flex items-center justify-end gap-1">Delta (Unit) <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('positionDelta')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right">
                    <div className="flex items-center justify-end gap-1">Pos Delta <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                  <th onClick={() => toggleSort('lotDelta')} className="px-4 py-3 cursor-pointer hover:bg-zinc-800/50 transition-colors text-right">
                    <div className="flex items-center justify-end gap-1">Lot Delta <ArrowUpDown className="h-3 w-3" /></div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedLegs.map((leg, i) => {
                  const isLong = leg.netQty > 0;
                  const isCall = leg.type === 'CE';
                  
                  // Color codes
                  const qtyColor = isLong ? 'text-blue-400' : 'text-red-400';
                  
                  // Delta contributions (long CE / short PE are bullish / green; long PE / short CE are bearish / red)
                  const deltaColor = leg.positionDelta > 0.01 ? 'text-emerald-400' : leg.positionDelta < -0.01 ? 'text-red-400' : 'text-zinc-400';
                  const pnlColor = leg.pnl > 0 ? 'text-emerald-400' : leg.pnl < 0 ? 'text-red-400' : 'text-zinc-400';

                  return (
                    <tr key={i} className="border-t border-zinc-850 hover:bg-zinc-800/25 transition-colors font-medium">
                      <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-300">
                        <div className="font-bold text-zinc-100">{leg.symbol}</div>
                        <div className="text-[9px] text-zinc-500 font-sans mt-0.5">{leg.displayName}</div>
                      </td>
                      <td className="px-4 py-3.5 text-center text-zinc-400 tabular-nums">
                        {leg.expiry}
                      </td>
                      <td className="px-4 py-3.5 text-center font-bold text-zinc-300 tabular-nums">
                        {leg.strike.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                          isCall
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/25'
                            : 'bg-red-500/10 text-red-400 border-red-500/25'
                        }`}>
                          {leg.type}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                          leg.side === 'BUY'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/25'
                        }`}>
                          {leg.side}
                        </span>
                      </td>
                      <td className={`px-4 py-3.5 text-right font-bold tabular-nums ${qtyColor}`}>
                        {leg.netQty > 0 ? '+' : ''}{leg.netQty}
                      </td>
                      <td className="px-4 py-3.5 text-right text-zinc-300 tabular-nums">
                        ₹{fmtNum(leg.ltp)}
                      </td>
                      <td className={`px-4 py-3.5 text-right font-semibold tabular-nums ${pnlColor}`}>
                        {leg.pnl >= 0 ? '+' : ''}₹{fmtNum(leg.pnl)}
                      </td>
                      {/* Greeks block */}
                      <td className="px-4 py-3.5 text-right text-zinc-400 tabular-nums border-l border-zinc-850">
                        {leg.delta > 0 ? '+' : ''}{leg.delta.toFixed(4)}
                      </td>
                      <td className={`px-4 py-3.5 text-right font-bold tabular-nums ${deltaColor}`}>
                        {leg.positionDelta > 0 ? '+' : ''}{fmtNum(leg.positionDelta)}
                      </td>
                      <td className={`px-4 py-3.5 text-right font-bold tabular-nums ${deltaColor}`}>
                        {leg.lotDelta > 0 ? '+' : ''}{leg.lotDelta.toFixed(3)}
                      </td>
                    </tr>
                  );
                })}

                {legs.length === 0 && !loading && (
                  <tr>
                    <td colSpan={11} className="py-16 text-center text-zinc-500 font-medium">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <Info className="h-6 w-6 text-zinc-600" />
                        <p className="text-sm text-zinc-400">No open F&amp;O options positions detected.</p>
                        <p className="text-xs text-zinc-500 max-w-[280px] leading-relaxed">
                          Delta exposure calculations will automatically populate when you hold active option trades.
                          Use the <span className="text-amber-400 font-semibold">Demo Mode</span> toggle above to inspect the page layout.
                        </p>
                      </div>
                    </td>
                  </tr>
                )}

                {loading && legs.length === 0 && (
                  <tr>
                    <td colSpan={11} className="py-16 text-center text-zinc-500">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <div className="h-5 w-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
                        <p className="text-sm font-medium">Loading position deltas…</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Explainers block */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
          <div className="bg-zinc-900/40 border border-zinc-850 rounded-2xl p-5">
            <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-widest mb-2.5">Understanding Delta</h4>
            <ul className="text-[11px] text-zinc-400 space-y-2 leading-relaxed list-disc pl-4">
              <li><strong>Delta</strong> measures the expected change in option price per 1-point move in the underlying index spot price.</li>
              <li>CE options have positive delta (0 to +1), while PE options have negative delta (0 to -1).</li>
              <li><strong>Position Delta</strong> adjusts the contract delta for your trade size: <code className="bg-zinc-950 px-1 py-0.5 rounded text-zinc-300 font-mono">Net Quantity × Unit Delta</code>.</li>
              <li>A net positive delta means a bullish exposure (portfolio value rises as spot rises); a net negative delta represents bearish exposure.</li>
            </ul>
          </div>

          <div className="bg-zinc-900/40 border border-zinc-850 rounded-2xl p-5">
            <h4 className="text-xs font-bold text-zinc-300 uppercase tracking-widest mb-2.5">Dynamic Risk Calculations</h4>
            <ul className="text-[11px] text-zinc-400 space-y-2 leading-relaxed list-disc pl-4">
              <li>This dashboard queries live Dhan position records and pulls matching Greek values from the active option chain contracts.</li>
              <li>If broker Greeks are temporarily unavailable (e.g. pre-market or over the weekend), the system falls back to calculating theoretical Black-Scholes deltas using current VIX as input.</li>
              <li><strong>Lot Delta</strong> normalizes your exposure in terms of index lot sizes, providing a standard gauge of leverage across different indexes.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
