'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw, TrendingDown, DollarSign } from 'lucide-react';
import CockpitSpinner from './CockpitSpinner';

interface CandleRow {
  time: string;
  'CE LTP': number;
  'PE LTP': number;
  Straddle: number;
  'CE Vol'?: number;
  'PE Vol'?: number;
}

interface StraddleData {
  data: CandleRow[];
  dataDate?: string;
  isToday?: boolean;
  ce_prev_close?: number;
  pe_prev_close?: number;
}

const STRIKE_STEPS: Record<string, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  CRUDEOIL: 50,
  CRUDEOILM: 50,
};

function isValidStrikeForUnderlying(underlying: string, strike: number): boolean {
  if (!strike || strike <= 0) return false;
  const u = underlying.toUpperCase();
  if (u === 'NIFTY') return strike >= 15000 && strike <= 35000;
  if (u === 'BANKNIFTY') return strike >= 35000 && strike <= 70000;
  if (u === 'FINNIFTY') return strike >= 15000 && strike <= 35000;
  if (u === 'MIDCPNIFTY') return strike >= 8000 && strike <= 20000;
  if (u === 'SENSEX') return strike >= 50000 && strike <= 110000;
  if (u === 'BANKEX') return strike >= 40000 && strike <= 80000;
  if (u === 'CRUDEOIL' || u === 'CRUDEOILM') return strike >= 3000 && strike <= 15000;
  return true;
}

export interface StraddleDecayWidgetProps {
  underlying: string;
  atmStrikeProp?: number;
  expiryProp?: string;
}

export default function StraddleDecayWidget({ underlying, atmStrikeProp, expiryProp }: StraddleDecayWidgetProps) {
  const [data, setData] = useState<CandleRow[]>([]);
  const [atmStrike, setAtmStrike] = useState<number>(
    atmStrikeProp && isValidStrikeForUnderlying(underlying, atmStrikeProp) ? atmStrikeProp : 0
  );
  const [expiry, setExpiry] = useState<string>(expiryProp || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestSeq = useRef(0);

  // Reset internal state completely whenever underlying changes
  useEffect(() => {
    setData([]);
    setAtmStrike(0);
    setExpiry('');
    setError('');
    setLoading(true);
  }, [underlying]);

  // Sync with incoming props if they match the active underlying
  useEffect(() => {
    if (atmStrikeProp && isValidStrikeForUnderlying(underlying, atmStrikeProp)) {
      setAtmStrike(atmStrikeProp);
    }
    if (expiryProp) {
      setExpiry(expiryProp);
    }
  }, [underlying, atmStrikeProp, expiryProp]);

  // Fetch straddle candles using known ATM strike & expiry
  const fetchCandles = useCallback(async (effAtm: number, effExp: string, silent = false) => {
    if (!effAtm || !effExp || !isValidStrikeForUnderlying(underlying, effAtm)) return;
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    else setIsRefreshing(true);

    try {
      const candleRes = await fetch(`/api/options/candles?underlying=${underlying}&expiry=${effExp}&strike=${effAtm}&interval=1`);
      const candleJson = await candleRes.json();
      if (seq !== requestSeq.current) return;
      if (candleJson.success && candleJson.data) {
        setData(candleJson.data);
        setError('');
      } else {
        setError(candleJson.error || 'No straddle candles available');
      }
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [underlying]);

  // Fetch or fallback if atm/expiry not yet known
  const resolveAtmAndFetch = useCallback(async (silent = false) => {
    const validAtmProp = (atmStrikeProp && isValidStrikeForUnderlying(underlying, atmStrikeProp)) ? atmStrikeProp : 0;
    const curAtm = validAtmProp || (isValidStrikeForUnderlying(underlying, atmStrike) ? atmStrike : 0);
    const curExp = expiryProp || expiry;

    if (curAtm > 0 && curExp) {
      return fetchCandles(curAtm, curExp, silent);
    }

    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    else setIsRefreshing(true);

    try {
      const chainRes = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${curExp || 'nearest'}`);
      const chainJson = await chainRes.json();
      if (seq !== requestSeq.current) return;
      if (!chainJson.success || !chainJson.data) {
        setError(chainJson.error || 'Failed to resolve ATM');
        return;
      }

      const spot = chainJson.data.spot ?? 0;
      const step = STRIKE_STEPS[underlying] || 50;
      const resolvedAtm = Math.round(spot / step) * step;
      const resolvedExp = curExp || chainJson.data.future_expiry || '';

      if (isValidStrikeForUnderlying(underlying, resolvedAtm)) {
        setAtmStrike(resolvedAtm);
      }
      if (resolvedExp) setExpiry(resolvedExp);

      if (resolvedAtm > 0 && resolvedExp && isValidStrikeForUnderlying(underlying, resolvedAtm)) {
        await fetchCandles(resolvedAtm, resolvedExp, silent);
      }
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [underlying, atmStrikeProp, expiryProp, atmStrike, expiry, fetchCandles]);

  useEffect(() => {
    resolveAtmAndFetch();
    const timer = setInterval(() => resolveAtmAndFetch(true), 60_000);
    return () => clearInterval(timer);
  }, [resolveAtmAndFetch]);

  // Derived stats
  const initialStraddle = data.length > 0 ? data[0].Straddle : 0;
  const currentStraddle = data.length > 0 ? data[data.length - 1].Straddle : 0;
  const decayPts = initialStraddle > 0 ? initialStraddle - currentStraddle : 0;
  const decayPct = initialStraddle > 0 ? (decayPts / initialStraddle) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-amber-500/10 text-amber-400 border border-amber-500/25">
            <TrendingDown className="w-3 h-3" />
          </div>
          <div>
            <span className="text-xs font-bold text-white tracking-tight">ATM Straddle Decay</span>
            {atmStrike > 0 && isValidStrikeForUnderlying(underlying, atmStrike) && (
              <span className="ml-1 text-[10px] text-zinc-500 font-mono">({atmStrike} Strike)</span>
            )}
          </div>
        </div>

        {/* Stats Pill */}
        <div className="flex items-center gap-2 font-mono text-[10px]">
          {currentStraddle > 0 && (
            <div className="flex items-baseline gap-1">
              <span className="text-zinc-400">ATM Sum:</span>
              <span className="font-bold text-white">₹{currentStraddle.toFixed(1)}</span>
              <span className={`font-bold ml-1 ${decayPts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                ({decayPts >= 0 ? '-' : '+'}{Math.abs(decayPts).toFixed(1)} pts / {decayPct.toFixed(1)}%)
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => resolveAtmAndFetch()}
            title="Refresh Straddle Decay"
            className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            <RefreshCw className={`w-2.5 h-2.5 ${isRefreshing ? 'animate-spin text-amber-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="flex-1 min-h-[170px] p-2 flex flex-col justify-between">
        {loading && (
          <CockpitSpinner
            label={`Loading ${underlying} Straddle Decay`}
            sublabel={`ATM ${atmStrike > 0 ? atmStrike : ''} Premium Decay Curve...`}
            color="amber"
          />
        )}

        {error && data.length === 0 && (
          <div className="flex-1 flex items-center justify-center p-3 text-center">
            <span className="text-[11px] text-rose-400">{error}</span>
          </div>
        )}

        {!loading && data.length === 0 && !error && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px]">
            No intraday straddle candles recorded yet.
          </div>
        )}

        {data.length > 0 && (
          <div className="flex-1 w-full h-[155px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 6, right: 6, left: -26, bottom: 0 }}>
                <defs>
                  <linearGradient id="straddleGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 2" stroke="#27272a" vertical={false} />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickLine={false}
                  axisLine={{ stroke: '#27272a' }}
                  interval="preserveStartEnd"
                  minTickGap={35}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickFormatter={(v: number) => Math.round(v).toString()}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                />
                <Tooltip
                  cursor={{ stroke: 'rgba(255,255,255,0.2)', strokeDasharray: '2 2' }}
                  content={({ active, payload, label }) => {
                    if (!active || !Array.isArray(payload) || !payload.length) return null;
                    const r = payload[0]?.payload as CandleRow;
                    if (!r) return null;
                    return (
                      <div className="bg-zinc-950/95 border border-zinc-700/80 rounded-lg px-2.5 py-2 text-[11px] shadow-2xl backdrop-blur min-w-[130px] font-mono">
                        <p className="text-zinc-400 font-bold mb-1">{String(label)}</p>
                        <div className="flex justify-between gap-3 mb-0.5">
                          <span className="text-amber-400 font-semibold">Straddle</span>
                          <span className="text-white font-bold tabular-nums">₹{r.Straddle.toFixed(1)}</span>
                        </div>
                        <div className="flex justify-between gap-3 mb-0.5">
                          <span className="text-blue-400">CE LTP</span>
                          <span className="text-zinc-200 tabular-nums">{r['CE LTP']?.toFixed(1) ?? '—'}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-rose-400">PE LTP</span>
                          <span className="text-zinc-200 tabular-nums">{r['PE LTP']?.toFixed(1) ?? '—'}</span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="Straddle"
                  name="Straddle"
                  stroke="#f59e0b"
                  strokeWidth={1.8}
                  fill="url(#straddleGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Footer */}
        <div className="mt-1 pt-1 border-t border-zinc-800/80 flex items-center justify-between text-[10px] text-zinc-400 font-mono">
          <span>Open: <strong className="text-zinc-200">₹{initialStraddle.toFixed(1)}</strong></span>
          <span>Expiry: <strong className="text-amber-400">{expiry || 'Nearest'}</strong></span>
        </div>
      </div>
    </div>
  );
}
