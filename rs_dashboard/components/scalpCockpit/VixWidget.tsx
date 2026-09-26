'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw, Flame, TrendingUp, TrendingDown } from 'lucide-react';
import CockpitSpinner from './CockpitSpinner';

interface VixCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  roc5: number | null;
  nifty: number | null;
}

interface VixData {
  candles: VixCandle[];
  spot: number;
  day_open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  data_date: string;
  is_today: boolean;
  nifty_spot?: number;
  nifty_change_pct?: number;
}

function regimeStyle(vix: number) {
  if (vix < 13) return { label: 'CALM', text: 'text-emerald-400', badge: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' };
  if (vix < 16) return { label: 'NORMAL', text: 'text-amber-400', badge: 'bg-amber-500/15 border-amber-500/30 text-amber-400' };
  if (vix < 20) return { label: 'ELEVATED', text: 'text-orange-400', badge: 'bg-orange-500/15 border-orange-500/30 text-orange-400' };
  return { label: 'FEARFUL', text: 'text-rose-400', badge: 'bg-rose-500/15 border-rose-500/30 text-rose-400' };
}

const CompactVixTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const candle = (payload[0]?.payload as VixCandle) ?? null;
  if (!candle) return null;

  return (
    <div className="bg-zinc-950/95 border border-zinc-700/80 rounded-lg px-2.5 py-2 text-[11px] shadow-2xl backdrop-blur min-w-[130px] font-mono">
      <p className="text-zinc-400 font-bold mb-1">{String(label)}</p>
      <div className="flex justify-between gap-3 mb-0.5">
        <span className="text-indigo-400 font-semibold">VIX</span>
        <span className="text-zinc-100 font-bold tabular-nums">{candle.close != null ? candle.close.toFixed(2) : '—'}</span>
      </div>
      {candle.roc5 != null && (
        <div className="flex justify-between gap-3 mb-0.5">
          <span className="text-zinc-400 font-semibold">ROC 5m</span>
          <span className={`font-bold tabular-nums ${candle.roc5 >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {candle.roc5 >= 0 ? '+' : ''}{candle.roc5.toFixed(2)}%
          </span>
        </div>
      )}
      {candle.nifty != null && (
        <div className="flex justify-between gap-3 pt-0.5 border-t border-zinc-800">
          <span className="text-amber-400 font-semibold">NIFTY</span>
          <span className="text-amber-300 font-bold tabular-nums">{candle.nifty.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
};

export default function VixWidget() {
  const [data, setData] = useState<VixData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async (silent = false) => {
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    else setIsRefreshing(true);
    try {
      const res = await fetch('/api/options/vix-candles');
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      if (json.success) {
        setData(json);
        setError('');
      } else {
        setError(json.error || 'Failed to load VIX');
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
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      fetchData(true);
    }, 45_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const spot = data?.spot ?? 0;
  const prevClose = data?.prev_close ?? 0;
  const chg = prevClose > 0 && spot > 0 ? spot - prevClose : 0;
  const chgPct = prevClose > 0 && spot > 0 ? (chg / prevClose) * 100 : 0;
  const regime = spot > 0 ? regimeStyle(spot) : null;

  const candles = data?.candles ?? [];
  const latestCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const roc5 = latestCandle?.roc5;

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Widget Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-indigo-500/10 text-indigo-400 border border-indigo-500/25">
            <Activity className="w-3 h-3" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-bold text-white tracking-tight">India VIX</span>
            {isRefreshing && <RefreshCw className="w-2.5 h-2.5 text-indigo-400 animate-spin" />}
          </div>
        </div>

        {/* Spot & Regime Pill */}
        <div className="flex items-center gap-2">
          {spot > 0 && (
            <div className="flex items-baseline gap-1 font-mono tabular-nums">
              <span className="text-xs font-bold text-white">{spot.toFixed(2)}</span>
              {chg !== 0 && (
                <span className={`text-[10px] font-bold ${chg >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {chg >= 0 ? '+' : ''}{chgPct.toFixed(1)}%
                </span>
              )}
            </div>
          )}

          {regime && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${regime.badge}`}>
              {regime.label}
            </span>
          )}

          <button
            type="button"
            onClick={() => fetchData()}
            title="Refresh VIX"
            className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-[170px] p-2 flex flex-col justify-between">
        {loading && !data && (
          <CockpitSpinner
            label="Loading India VIX"
            sublabel="Fetching 1-min intraday volatility series..."
            color="cyan"
          />
        )}

        {error && !data && (
          <div className="flex-1 flex items-center justify-center p-3 text-center">
            <span className="text-[11px] text-rose-400">{error}</span>
          </div>
        )}

        {!loading && candles.length === 0 && !error && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px]">
            No intraday VIX candles available.
          </div>
        )}

        {candles.length > 0 && (
          <div className="flex-1 w-full h-[155px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={candles} margin={{ top: 4, right: 6, left: -26, bottom: 0 }}>
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
                  yAxisId="vix"
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  tickLine={false}
                  axisLine={false}
                  width={34}
                />
                <YAxis
                  yAxisId="nifty"
                  orientation="right"
                  domain={['auto', 'auto']}
                  hide
                />
                <Tooltip content={<CompactVixTooltip />} />
                <Line
                  yAxisId="vix"
                  type="monotone"
                  dataKey="close"
                  name="VIX"
                  stroke="#818cf8"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="nifty"
                  type="monotone"
                  dataKey="nifty"
                  name="Nifty"
                  stroke="#f59e0b"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Bottom Stat Strip */}
        {data && (
          <div className="mt-1 pt-1 border-t border-zinc-800/80 flex items-center justify-between text-[10px] text-zinc-400 font-mono">
            <div className="flex items-center gap-3">
              <span>H: <strong className="text-emerald-400">{data.day_high > 0 ? data.day_high.toFixed(2) : '—'}</strong></span>
              <span>L: <strong className="text-rose-400">{data.day_low > 0 ? data.day_low.toFixed(2) : '—'}</strong></span>
            </div>
            {roc5 != null && (
              <span className="flex items-center gap-1">
                ROC 5m:
                <strong className={roc5 >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {roc5 >= 0 ? '+' : ''}{roc5.toFixed(2)}%
                </strong>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
