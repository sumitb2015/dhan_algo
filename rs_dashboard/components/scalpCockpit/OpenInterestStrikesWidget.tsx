'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import { BarChart2, RefreshCw, Sliders, ChevronDown } from 'lucide-react';
import CockpitSpinner from './CockpitSpinner';

interface OcSide {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  implied_volatility?: number;
}

interface OcEntry {
  ce?: OcSide;
  pe?: OcSide;
}

interface OIRow {
  strike: number;
  ceOI: number;
  peOI: number;
  ceDelta: number;
  peDelta: number;
  isATM: boolean;
}

const STRIKE_STEPS: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  CRUDEOIL: 50,
  CRUDEOILM: 50,
};

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

type ViewMode = 'oi' | 'delta';

export interface OpenInterestStrikesWidgetProps {
  underlying: string;
  expiriesProp?: string[];
  selectedExpiryProp?: string;
  onExpiryChange?: (exp: string) => void;
  onChainLoaded?: (oc: Record<string, OcEntry>, spot: number, atm: number, expiry: string) => void;
}

export default function OpenInterestStrikesWidget({
  underlying,
  expiriesProp,
  selectedExpiryProp,
  onExpiryChange,
  onChainLoaded,
}: OpenInterestStrikesWidgetProps) {
  const [rows, setRows] = useState<OIRow[]>([]);
  const [spot, setSpot] = useState(0);
  const [atm, setAtm] = useState(0);
  const [expiries, setExpiries] = useState<string[]>(expiriesProp || []);
  const [selectedExpiry, setSelectedExpiry] = useState<string>(selectedExpiryProp || '');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Sync with props if provided
  useEffect(() => {
    if (expiriesProp && expiriesProp.length > 0) {
      setExpiries(expiriesProp);
      if (!selectedExpiry || !expiriesProp.includes(selectedExpiry)) {
        const next = selectedExpiryProp && expiriesProp.includes(selectedExpiryProp) ? selectedExpiryProp : expiriesProp[0];
        setSelectedExpiry(next);
        onExpiryChange?.(next);
      }
    }
  }, [expiriesProp, selectedExpiryProp, selectedExpiry, onExpiryChange]);

  // Slider state: number of wing strikes (ATM ± wingCount)
  const [wingCount, setWingCount] = useState<number>(10);
  // View mode: Total OI vs Change in OI
  const [viewMode, setViewMode] = useState<ViewMode>('oi');

  const step = STRIKE_STEPS[underlying] || 50;

  // 1. Fetch available expiries for underlying only if not provided by parent
  useEffect(() => {
    if (expiriesProp && expiriesProp.length > 0) return;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data && j.data.length > 0) {
          setExpiries(j.data);
          const next = j.data.includes(selectedExpiry) ? selectedExpiry : j.data[0];
          setSelectedExpiry(next);
          onExpiryChange?.(next);
        }
      })
      .catch(() => {});
  }, [underlying, expiriesProp]);

  // Reset data on underlying switch to display spinner immediately
  useEffect(() => {
    setRows([]);
    setLoading(true);
  }, [underlying]);

  // Monotonic request sequence to guard against out-of-order responses
  const requestSeq = useRef(0);
  const onChainLoadedRef = useRef(onChainLoaded);
  useEffect(() => { onChainLoadedRef.current = onChainLoaded; }, [onChainLoaded]);

  // 2. Fetch Option Chain OI
  const fetchOI = useCallback(async (expiryToFetch = selectedExpiry, silent = false) => {
    if (!expiryToFetch) return;
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    else setIsRefreshing(true);

    try {
      const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiryToFetch}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
        error?: string;
      };

      if (seq !== requestSeq.current) return; // Discard out-of-order response

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / step) * step;
      const oc = json.data.chain.oc;

      const newRows: OIRow[] = Object.entries(oc)
        .map(([k, v]) => {
          const strike = Number(k);
          const ceOI = v.ce?.oi ?? 0;
          const peOI = v.pe?.oi ?? 0;
          const cePrev = v.ce?.previous_oi ?? 0;
          const pePrev = v.pe?.previous_oi ?? 0;
          return {
            strike,
            ceOI,
            peOI,
            ceDelta: ceOI - cePrev,
            peDelta: peOI - pePrev,
            isATM: strike === atmStrike,
          };
        })
        .filter(r => !isNaN(r.strike) && (r.ceOI > 0 || r.peOI > 0))
        .sort((a, b) => a.strike - b.strike);

      setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(newRows);
      setError('');
      onChainLoadedRef.current?.(oc, spotPrice, atmStrike, expiryToFetch);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [underlying, selectedExpiry, step]);

  useEffect(() => {
    if (selectedExpiry) {
      fetchOI(selectedExpiry);
      const interval = setInterval(() => {
        fetchOI(selectedExpiry, true);
      }, 45_000);
      return () => clearInterval(interval);
    }
  }, [selectedExpiry, fetchOI]);

  // Filter rows based on wing slider (ATM ± wingCount)
  const filteredRows = useMemo(() => {
    if (!atm || rows.length === 0) return rows;
    const maxDiff = wingCount * step;
    return rows.filter(r => Math.abs(r.strike - atm) <= maxDiff);
  }, [rows, atm, wingCount, step]);

  const totalCeOI = useMemo(() => filteredRows.reduce((s, r) => s + r.ceOI, 0), [filteredRows]);
  const totalPeOI = useMemo(() => filteredRows.reduce((s, r) => s + r.peOI, 0), [filteredRows]);
  const pcr = totalCeOI > 0 ? (totalPeOI / totalCeOI).toFixed(2) : '—';
  const diffOI = totalPeOI - totalCeOI;

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Widget Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-violet-500/10 text-violet-400 border border-violet-500/25">
            <BarChart2 className="w-3 h-3" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-white tracking-tight">
              OI <span className="hidden xl:inline">Across </span>Strikes
            </span>
            {isRefreshing && <RefreshCw className="w-2.5 h-2.5 text-violet-400 animate-spin" />}
          </div>
        </div>

        {/* View mode toggle (Total OI vs Change in OI) */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 bg-zinc-950 p-0.5 rounded border border-zinc-800 text-[10px]">
            <button
              type="button"
              onClick={() => setViewMode('oi')}
              className={`px-2 py-0.5 font-bold rounded transition-colors ${
                viewMode === 'oi'
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Show total Open Interest across strikes"
            >
              Total OI
            </button>
            <button
              type="button"
              onClick={() => setViewMode('delta')}
              className={`px-2 py-0.5 font-bold rounded transition-colors ${
                viewMode === 'delta'
                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Show Change in Open Interest since previous session"
            >
              Δ OI Chg
            </button>
          </div>

          {/* Expiry Dropdown */}
          {expiries.length > 0 && (
            <div className="relative">
              <select
                value={selectedExpiry}
                onChange={e => {
                  const val = e.target.value;
                  setSelectedExpiry(val);
                  onExpiryChange?.(val);
                }}
                className="h-6 bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-200 font-semibold rounded px-1.5 pr-4 focus:outline-none cursor-pointer appearance-none"
              >
                {expiries.slice(0, 5).map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
              <ChevronDown className="w-2.5 h-2.5 text-zinc-500 absolute right-1 top-1.5 pointer-events-none" />
            </div>
          )}

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => fetchOI(selectedExpiry)}
            title="Refresh Open Interest"
            className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Sub-bar with Slider and Metrics */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-950/40 border-b border-zinc-800/60 text-[10px] flex-wrap gap-2">
        {/* Strikes Range Slider */}
        <div className="flex items-center gap-2">
          <Sliders className="w-3 h-3 text-zinc-400" />
          <span className="text-zinc-400 font-medium">Range:</span>
          <input
            type="range"
            min={4}
            max={20}
            step={1}
            value={wingCount}
            onChange={e => setWingCount(Number(e.target.value))}
            className="w-14 sm:w-18 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-violet-500"
            title={`Adjust strikes window: ATM ±${wingCount} strikes (${filteredRows.length} strikes)`}
          />
          <span className="font-mono font-bold text-violet-400 tabular-nums">
            ±{wingCount}
          </span>
          <span className="text-zinc-600 hidden md:inline">({filteredRows.length} strikes)</span>
        </div>

        {/* Telemetry Pills */}
        <div className="flex items-center gap-2 font-mono tabular-nums text-[10px]">
          <span className="text-zinc-400">
            ATM: <strong className="text-white">{atm > 0 ? atm : '—'}</strong>
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">
            PCR: <strong className="text-yellow-400">{pcr}</strong>
          </span>
          <span className="text-zinc-600">|</span>
          <span className={`font-bold ${diffOI >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {diffOI >= 0 ? '+' : ''}{fmtOI(diffOI)}
          </span>
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="flex-1 min-h-[170px] p-2 flex flex-col justify-between">
        {loading && (
          <CockpitSpinner
            label={`Loading ${underlying} Strikes OI`}
            sublabel="Scanning ATM strikes & open interest buildup..."
            color="violet"
          />
        )}

        {error && rows.length === 0 && (
          <div className="flex-1 flex items-center justify-center p-3 text-center">
            <span className="text-[11px] text-rose-400">{error}</span>
          </div>
        )}

        {!loading && filteredRows.length === 0 && !error && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px]">
            No strikes found in this range.
          </div>
        )}

        {filteredRows.length > 0 && (
          <div className="flex-1 w-full h-[155px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={filteredRows}
                margin={{ top: 6, right: 6, left: -24, bottom: 0 }}
                barCategoryGap="18%"
                barGap={1}
              >
                <CartesianGrid strokeDasharray="2 2" stroke="#27272a" vertical={false} />
                <XAxis
                  dataKey="strike"
                  tickFormatter={fmtStrike}
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickLine={false}
                  axisLine={{ stroke: '#27272a' }}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickFormatter={fmtOI}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  content={({ active, payload, label }) => {
                    if (!active || !Array.isArray(payload) || !payload.length) return null;
                    const r = payload[0]?.payload as OIRow;
                    if (!r) return null;
                    return (
                      <div className="bg-zinc-950/95 border border-zinc-700/80 rounded-lg px-2.5 py-2 text-[11px] shadow-2xl backdrop-blur min-w-[145px] font-mono">
                        <p className="text-zinc-300 font-bold mb-1">
                          Strike {r.strike} {r.isATM ? '· (ATM)' : ''}
                        </p>
                        <div className="flex justify-between gap-3 mb-0.5">
                          <span className="text-blue-400 font-semibold">CE OI</span>
                          <span className="text-zinc-100 font-bold tabular-nums">{fmtOI(r.ceOI)}</span>
                        </div>
                        <div className="flex justify-between gap-3 mb-0.5">
                          <span className="text-rose-400 font-semibold">PE OI</span>
                          <span className="text-zinc-100 font-bold tabular-nums">{fmtOI(r.peOI)}</span>
                        </div>
                        <div className="flex justify-between gap-3 pt-0.5 border-t border-zinc-800">
                          <span className="text-blue-300 font-semibold">Δ CE OI</span>
                          <span className={`font-bold tabular-nums ${r.ceDelta >= 0 ? 'text-blue-300' : 'text-blue-600'}`}>
                            {r.ceDelta >= 0 ? '+' : ''}{fmtOI(r.ceDelta)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-rose-300 font-semibold">Δ PE OI</span>
                          <span className={`font-bold tabular-nums ${r.peDelta >= 0 ? 'text-rose-300' : 'text-rose-600'}`}>
                            {r.peDelta >= 0 ? '+' : ''}{fmtOI(r.peDelta)}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                />
                {atm > 0 && (
                  <ReferenceLine
                    x={atm}
                    stroke="#a1a1aa"
                    strokeDasharray="3 2"
                    strokeWidth={1.2}
                    label={{ value: 'ATM', position: 'top', fill: '#e4e4e7', fontSize: 9, fontWeight: 700 }}
                  />
                )}
                {viewMode === 'delta' && (
                  <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
                )}

                {/* Bars for Total OI */}
                {viewMode === 'oi' && (
                  <>
                    <Bar dataKey="ceOI" name="CE OI" radius={[2, 2, 0, 0]}>
                      {filteredRows.map(r => (
                        <Cell
                          key={`ce-${r.strike}`}
                          fill={r.isATM ? '#93c5fd' : '#3b82f6'}
                          fillOpacity={r.isATM ? 1 : 0.85}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="peOI" name="PE OI" radius={[2, 2, 0, 0]}>
                      {filteredRows.map(r => (
                        <Cell
                          key={`pe-${r.strike}`}
                          fill={r.isATM ? '#fca5a5' : '#ef4444'}
                          fillOpacity={r.isATM ? 1 : 0.85}
                        />
                      ))}
                    </Bar>
                  </>
                )}

                {/* Bars for Change in OI */}
                {viewMode === 'delta' && (
                  <>
                    <Bar dataKey="ceDelta" name="CE ΔOI" radius={[2, 2, 0, 0]}>
                      {filteredRows.map(r => (
                        <Cell
                          key={`ce-delta-${r.strike}`}
                          fill={r.ceDelta >= 0 ? '#60a5fa' : '#1d4ed8'}
                          fillOpacity={r.isATM ? 1 : 0.85}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="peDelta" name="PE ΔOI" radius={[2, 2, 0, 0]}>
                      {filteredRows.map(r => (
                        <Cell
                          key={`pe-delta-${r.strike}`}
                          fill={r.peDelta >= 0 ? '#f87171' : '#b91c1c'}
                          fillOpacity={r.isATM ? 1 : 0.85}
                        />
                      ))}
                    </Bar>
                  </>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Legend Footer */}
        <div className="mt-1 pt-1 border-t border-zinc-800/80 flex items-center justify-between text-[9px] text-zinc-400 font-semibold">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-blue-500" />
              <span>{viewMode === 'oi' ? 'Call OI' : 'Δ Call OI'}</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-sm bg-rose-500" />
              <span>{viewMode === 'oi' ? 'Put OI' : 'Δ Put OI'}</span>
            </span>
          </div>
          <span className="text-zinc-500">{selectedExpiry}</span>
        </div>
      </div>
    </div>
  );
}
