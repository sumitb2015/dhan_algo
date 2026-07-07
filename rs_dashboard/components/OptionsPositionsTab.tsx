'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

const POLL_OPTIONS = [
  { label: '5s',   ms: 5000  },
  { label: '10s',  ms: 10000 },
  { label: '20s',  ms: 20000 },
  { label: '30s',  ms: 30000 },
  { label: 'Live', ms: 2000  },
] as const;
type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ── Types ────────────────────────────────────────────────────────────

interface Leg {
  symbol: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'SELL' | 'BUY';
  ltp: number;
  entryPrice: number;
  pnl: number;
  realizedPnl: number;
  netQty: number;
}

interface ApiResponse {
  has_positions: boolean;
  net_premium: number;
  vix: number;
  legs: Leg[];
  timestamp: string;
  error?: string;
}

interface DataPoint {
  time: string;
  netPremium: number;
  vix: number;
}

interface PremiumPoint { time: string; premium: number }
interface SymbolMeta { securityId: string; tradingSymbol: string; displayName: string }

function isMarketHours(): boolean {
  const now = new Date();
  const hm  = now.getHours() * 100 + now.getMinutes();
  return hm >= 915 && hm <= 1530;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

// ── Custom tooltip ───────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-400 mb-1 font-medium">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-zinc-300">{p.name}:</span>
          <span className="text-white font-semibold">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────

function StatTile({ label, value, sub, valueClass }: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 min-w-[130px]">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-lg font-bold ${valueClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function OptionsPositionsTab() {
  const [dataPoints, setDataPoints]   = useState<DataPoint[]>([]);
  const [legs, setLegs]               = useState<Leg[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [pollMs, setPollMs]           = useState<PollMs>(30000);
  const entryPremiumRef               = useRef<number | null>(null);

  const [premiumData, setPremiumData]               = useState<PremiumPoint[]>([]);
  const [bySymbol, setBySymbol]                     = useState<Record<string, PremiumPoint[]>>({});
  const [premiumSymbols, setPremiumSymbols]         = useState<SymbolMeta[]>([]);
  const [selectedStrike, setSelectedStrike]         = useState<string>('all');
  const [selectedType, setSelectedType]             = useState<string>('all');
  const [currentPremium, setCurrentPremium]         = useState<number>(0);
  const [premiumLastUpdated, setPremiumLastUpdated] = useState<string>('');

  const handleRowClick = (strike: number, type: 'CE' | 'PE') => {
    const strikeStr = String(strike);
    if (selectedStrike === strikeStr && selectedType === type) {
      setSelectedStrike('all');
      setSelectedType('all');
    } else {
      setSelectedStrike(strikeStr);
      setSelectedType(type);
    }
  };
  const [isPostSession, setIsPostSession]           = useState<boolean>(false);
  const [premiumError, setPremiumError]             = useState<string | null>(null);
  const [premiumRefreshKey, setPremiumRefreshKey]   = useState(0);

  // ── Live polling ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res  = await fetch('/api/options/positions-live');
        const data = await res.json() as ApiResponse;
        if (cancelled) return;

        if (data.error === 'auth') {
          setError('Authentication error — run login.py to refresh the access token.');
          setLoading(false);
          return;
        }
        if (data.error === 'api') {
          setError('Could not reach the Dhan API. Check connectivity.');
          setLoading(false);
          return;
        }

        setLegs(data.legs);
        setLoading(false);
        setError(null);

        if (!data.has_positions) return;

        // Skip data points where premium is 0 — means LTPs are unavailable (market closed / API issue)
        if (data.net_premium === 0) return;

        // lock entry premium to first non-zero value
        if (entryPremiumRef.current === null) {
          entryPremiumRef.current = data.net_premium;
        }

        const point: DataPoint = {
          time:       fmtTime(data.timestamp),
          netPremium: data.net_premium,
          vix:        data.vix,
        };
        setDataPoints(prev => [...prev.slice(-1999), point]);
      } catch {
        if (!cancelled) setError('Network error fetching positions.');
      }
    }

    poll(); // immediate first call
    const id = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollMs]); // restart interval when poll rate changes

  // ── Premium chart (tradebook-based) ─────────────────────────────────
  useEffect(() => {
    const postSession = !isMarketHours();
    setIsPostSession(postSession);

    async function fetchPremiumChart() {
      try {
        const res  = await fetch('/api/options/premium-chart');
        const data = await res.json() as {
          success: boolean;
          data: PremiumPoint[];
          by_symbol: Record<string, PremiumPoint[]>;
          symbols: SymbolMeta[];
          current_premium: number;
          error?: string;
        };
        if (!data.success) {
          setPremiumError(data.error ?? 'Failed to load premium chart');
          return;
        }
        setPremiumData(data.data);
        setBySymbol(data.by_symbol ?? {});
        setPremiumSymbols(data.symbols ?? []);
        setCurrentPremium(data.current_premium ?? 0);
        setPremiumLastUpdated(
          new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        );
        setPremiumError(null);
      } catch {
        setPremiumError('Network error fetching premium chart');
      }
    }

    fetchPremiumChart();
    if (!postSession) {
      const id = setInterval(fetchPremiumChart, 30_000);
      return () => clearInterval(id);
    }
  }, [premiumRefreshKey]);

  // ── Derived values ───────────────────────────────────────────────

  const uniqueStrikes = React.useMemo(() => {
    const strikes = premiumSymbols.map(s => {
      const parts = s.tradingSymbol.split('-');
      return parts.length >= 2 ? parts[parts.length - 2] : '';
    }).filter(Boolean);
    return Array.from(new Set(strikes)).sort((a, b) => Number(a) - Number(b));
  }, [premiumSymbols]);

  const activePremiumData = React.useMemo(() => {
    if (selectedStrike === 'all' && selectedType === 'all') {
      return premiumData;
    }

    const matchingSymbols = Object.keys(bySymbol).filter(sym => {
      const parts = sym.split('-');
      if (parts.length < 2) return false;
      const strike = parts[parts.length - 2];
      const type = parts[parts.length - 1]; // 'CE' or 'PE'

      const strikeMatch = selectedStrike === 'all' || strike === selectedStrike;
      const typeMatch = selectedType === 'all' || type === selectedType;
      return strikeMatch && typeMatch;
    });

    if (matchingSymbols.length === 0) return [];

    // Combine minute-by-minute across matching symbols
    const timeMap: Record<string, number> = {};
    matchingSymbols.forEach(sym => {
      const points = bySymbol[sym] ?? [];
      points.forEach(p => {
        timeMap[p.time] = (timeMap[p.time] ?? 0) + p.premium;
      });
    });

    return Object.entries(timeMap)
      .map(([time, premium]) => ({ time, premium: Number(premium.toFixed(2)) }))
      .sort((a, b) => a.time.localeCompare(b.time));
  }, [premiumData, bySymbol, selectedStrike, selectedType]);

  const activeCurrentPremium = React.useMemo(() => {
    if (selectedStrike === 'all' && selectedType === 'all') {
      return currentPremium;
    }
    if (activePremiumData.length > 0) {
      return activePremiumData[activePremiumData.length - 1].premium;
    }
    return 0;
  }, [activePremiumData, currentPremium, selectedStrike, selectedType]);

  const statSub = React.useMemo(() => {
    if (selectedStrike === 'all' && selectedType === 'all') {
      return 'pts/lot · all open positions';
    }
    const strikeText = selectedStrike === 'all' ? 'All Strikes' : selectedStrike;
    const typeText = selectedType === 'all' ? 'Combined' : selectedType;
    return `pts/lot · ${strikeText} ${typeText}`;
  }, [selectedStrike, selectedType]);

  const latest             = dataPoints[dataPoints.length - 1];
  const entryPremium       = entryPremiumRef.current;
  const netPremium         = latest?.netPremium ?? 0;
  const vix                = latest?.vix ?? 0;
  // unrealized P&L: Dhan-computed per leg (sign-correct for buyers and sellers)
  const totalUnrealizedPnl = legs.reduce((sum, l) => sum + (l.pnl ?? 0), 0);
  // realized P&L: from closed intraday trades
  const totalRealizedPnl   = legs.reduce((sum, l) => sum + (l.realizedPnl ?? 0), 0);

  // Y axis domain helpers — sign-safe 10 % padding
  const premiums = dataPoints.map(d => d.netPremium);
  const vixes    = dataPoints.map(d => d.vix);
  const premiumDomain = premiums.length > 1
    ? [
        Math.floor(Math.min(...premiums) - Math.abs(Math.min(...premiums)) * 0.1),
        Math.ceil( Math.max(...premiums) + Math.abs(Math.max(...premiums)) * 0.1),
      ]
    : ['auto', 'auto'];
  const vixDomain = vixes.length > 1
    ? [
        Math.floor((Math.min(...vixes) - Math.abs(Math.min(...vixes)) * 0.05) * 10) / 10,
        Math.ceil( (Math.max(...vixes) + Math.abs(Math.max(...vixes)) * 0.05) * 10) / 10,
      ]
    : ['auto', 'auto'];

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        <svg className="animate-spin h-5 w-5 mr-2 text-emerald-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading positions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-2 mt-4 px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {!legs.length && (
        <div className="flex items-center justify-center h-32 text-zinc-500 text-sm border border-zinc-800 rounded-2xl bg-zinc-900/40">
          No open F&amp;O option positions
        </div>
      )}

      {legs.length > 0 && (
      <>{/* Stat row */}
      <div className="flex gap-3 flex-wrap">
        <StatTile
          label="Net Premium"
          value={fmtNum(netPremium)}
          sub={entryPremium !== null ? `Start: ${fmtNum(entryPremium)}` : 'Net credit'}
          valueClass={netPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <StatTile
          label="Unrealized P&L"
          value={(totalUnrealizedPnl >= 0 ? '+' : '') + fmtNum(totalUnrealizedPnl)}
          sub="Dhan computed"
          valueClass={totalUnrealizedPnl > 0 ? 'text-emerald-400' : totalUnrealizedPnl < 0 ? 'text-red-400' : 'text-zinc-400'}
        />
        <StatTile
          label="Realized P&L"
          value={(totalRealizedPnl >= 0 ? '+' : '') + fmtNum(totalRealizedPnl)}
          sub="closed intraday"
          valueClass={totalRealizedPnl > 0 ? 'text-emerald-400' : totalRealizedPnl < 0 ? 'text-red-400' : 'text-zinc-400'}
        />
        <StatTile
          label="India VIX"
          value={fmtNum(vix)}
          valueClass="text-amber-400"
        />
        <StatTile
          label="Open Legs"
          value={String(legs.length)}
          valueClass="text-zinc-200"
        />
      </div>

      {/* Dual-axis chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Combined Premium vs VIX</h3>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              LIVE
            </span>
          </div>
          {/* Poll interval selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => setPollMs(ms)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  pollMs === ms
                    ? label === 'Live'
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {dataPoints.length < 2 ? (
          <div className="flex items-center justify-center h-[420px] text-zinc-500 text-sm">
            Collecting data…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={dataPoints} margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={{ stroke: '#3f3f46' }}
                tickLine={false}
                minTickGap={60}
              />
              <YAxis
                yAxisId="premium"
                domain={premiumDomain as [number, number]}
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={55}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <YAxis
                yAxisId="vix"
                orientation="right"
                domain={vixDomain as [number, number]}
                tick={{ fill: '#f59e0b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                formatter={(value: string) => (
                  <span style={{ color: '#a1a1aa', fontSize: 11 }}>{value}</span>
                )}
              />

              {entryPremium !== null && (
                <ReferenceLine
                  yAxisId="premium"
                  y={entryPremium}
                  stroke="#ffffff"
                  strokeDasharray="4 3"
                  strokeOpacity={0.4}
                  label={{
                    value: 'Start',
                    position: 'insideTopLeft',
                    fill: '#a1a1aa',
                    fontSize: 10,
                  }}
                />
              )}

              <Line
                yAxisId="premium"
                type="monotone"
                dataKey="netPremium"
                name="Net Premium"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                yAxisId="vix"
                type="monotone"
                dataKey="vix"
                name="India VIX"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Positions table */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800">
              <th className="text-left px-4 py-2.5 text-xs font-bold text-white">Symbol</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Strike</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Type</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Side</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">Entry</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">LTP</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">P&amp;L</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">Qty</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => {
              const isSelected = selectedStrike === String(leg.strike) && (selectedType === 'all' || selectedType === leg.type);
              return (
                <tr
                  key={i}
                  onClick={() => handleRowClick(leg.strike, leg.type)}
                  className={`border-t border-zinc-800 hover:bg-zinc-800/40 cursor-pointer transition-colors ${
                    isSelected ? 'bg-zinc-800/80 border-l-2 border-emerald-500' : ''
                  }`}
                >
                  <td className="px-4 py-2.5 text-zinc-300 font-mono text-[11px]">{leg.symbol}</td>
                  <td className="px-4 py-2.5 text-center text-zinc-200 font-semibold">{leg.strike.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`font-bold ${leg.type === 'CE' ? 'text-blue-400' : 'text-red-400'}`}>
                      {leg.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      leg.side === 'SELL'
                        ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                        : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    }`}>
                      {leg.side}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">{fmtNum(leg.entryPrice)}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-200 font-semibold">{fmtNum(leg.ltp)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold ${
                    leg.pnl > 0 ? 'text-emerald-400' : leg.pnl < 0 ? 'text-red-400' : 'text-zinc-400'
                  }`}>
                    {leg.pnl >= 0 ? '+' : ''}{fmtNum(leg.pnl)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">{leg.netQty}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      </>)}

      {/* Combined Open Premium Chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Combined Open Premium</h3>
            {isPostSession ? (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-zinc-700 text-zinc-400 border border-zinc-600">
                POST-SESSION
              </span>
            ) : (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                LIVE
              </span>
            )}
            {premiumLastUpdated && (
              <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
                DATA: {premiumLastUpdated}
              </span>
            )}
          </div>
          <button
            onClick={() => setPremiumRefreshKey(k => k + 1)}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Refresh premium chart"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </button>
        </div>

        {/* Filters: Strike & Option Type */}
        {premiumSymbols.length > 0 && (
          <div className="flex flex-col gap-2 mb-4 bg-zinc-900/40 p-3 rounded-xl border border-zinc-800">
            {/* Strike price selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider w-12">Strike:</span>
              <button
                onClick={() => setSelectedStrike('all')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                  selectedStrike === 'all'
                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                All
              </button>
              {uniqueStrikes.map(strike => (
                <button
                  key={strike}
                  onClick={() => setSelectedStrike(strike)}
                  className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                    selectedStrike === strike
                      ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
                  }`}
                >
                  {strike}
                </button>
              ))}
            </div>

            {/* Option type selector */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-zinc-500 text-[10px] uppercase font-bold tracking-wider w-12">Type:</span>
              <button
                onClick={() => setSelectedType('all')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                  selectedType === 'all'
                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setSelectedType('CE')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                  selectedType === 'CE'
                    ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                Calls (CE)
              </button>
              <button
                onClick={() => setSelectedType('PE')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg border transition-all ${
                  selectedType === 'PE'
                    ? 'bg-red-500/15 text-red-400 border-red-500/30'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                Puts (PE)
              </button>
            </div>
          </div>
        )}

        <div className="mb-4">
          <StatTile
            label="Open Sell Premium"
            value={fmtNum(activeCurrentPremium)}
            sub={statSub}
            valueClass={activeCurrentPremium > 0 ? 'text-emerald-400' : 'text-zinc-400'}
          />
        </div>

        {premiumError ? (
          <div className="px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400">
            {premiumError}
          </div>
        ) : activePremiumData.length < 2 ? (
          <div className="flex items-center justify-center h-[280px] text-zinc-500 text-sm">
            {premiumData.length === 0 ? 'No FNO trades today' : 'Collecting data…'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={activePremiumData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={{ stroke: '#3f3f46' }}
                tickLine={false}
                tickFormatter={(v: string, i: number) => i % 30 === 0 ? v : ''}
              />
              <YAxis
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={55}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
              <Line
                type="stepAfter"
                dataKey="premium"
                name="Open Premium"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

    </div>
  );
}
