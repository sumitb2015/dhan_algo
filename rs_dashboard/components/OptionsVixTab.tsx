'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────
// Inline to avoid type-resolution issues with route file imports
interface VixCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  roc5: number | null;
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
}

// ─── Constants ────────────────────────────────────────────────────

const POLL_MS   = 60_000;
const COUNTDOWN = 60;

// ─── Helpers ──────────────────────────────────────────────────────

function regimeLabel(vix: number): { label: string; color: string; pill: string } {
  if (vix < 13) return { label: 'CALM',     color: 'text-emerald-400', pill: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
  if (vix < 16) return { label: 'NORMAL',   color: 'text-yellow-400',  pill: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30'    };
  if (vix < 20) return { label: 'ELEVATED', color: 'text-orange-400',  pill: 'bg-orange-500/15 text-orange-400 border-orange-500/30'    };
  return          { label: 'FEARFUL',  color: 'text-red-400',    pill: 'bg-red-500/15 text-red-400 border-red-500/30'            };
}

function fmtTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtVix(n: number): string {
  return n.toFixed(2);
}

// Show every 30th 1-min candle label on X axis (≈ every 30 min)
function xTickFormatter(value: string, index: number): string {
  return index % 30 === 0 ? value : '';
}

// ─── Tooltips ─────────────────────────────────────────────────────

const VixTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: VixCandle }>)[0]?.payload;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[140px] backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold">{String(label)}</p>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-indigo-400 font-semibold">VIX</span>
        <span className="text-white font-bold tabular-nums">{fmtVix(row?.close ?? 0)}</span>
      </div>
      {row?.roc5 != null && (
        <div className="flex justify-between gap-4">
          <span className="text-zinc-400 font-semibold">ROC 5m</span>
          <span className={`font-bold tabular-nums ${row.roc5 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {row.roc5 >= 0 ? '+' : ''}{row.roc5.toFixed(3)}%
          </span>
        </div>
      )}
    </div>
  );
};

const RocTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const val = (payload as Array<{ value: number }>)[0]?.value ?? 0;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3 py-2 text-xs shadow-2xl backdrop-blur">
      <p className="text-zinc-400 mb-1 font-semibold">{String(label)}</p>
      <span className={`font-bold tabular-nums ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        ROC 5m: {val >= 0 ? '+' : ''}{val.toFixed(3)}%
      </span>
    </div>
  );
};

// ─── Stat Tile ────────────────────────────────────────────────────

function StatTile({ label, value, valueClass = 'text-zinc-100' }: {
  label: string; value: string; valueClass?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex flex-col gap-1 min-w-0 flex-1">
      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className={`text-lg font-bold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsVixTab() {
  const [data, setData]               = useState<VixData | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [countdown, setCountdown]     = useState(COUNTDOWN);

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/options/vix-candles');
      const json = await res.json() as { success: boolean } & Partial<VixData> & { error?: string };
      if (!json.success) {
        setError(json.error ?? 'Unknown error');
      } else {
        setData(json as VixData);
        setError('');
        setLastUpdated(new Date());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setCountdown(COUNTDOWN);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const pollId = setInterval(() => void fetchData(), POLL_MS);
    const tickId = setInterval(() => setCountdown(c => (c > 0 ? c - 1 : 0)), 1_000);
    return () => { clearInterval(pollId); clearInterval(tickId); };
  }, [fetchData]);

  // ROC chart data: filter out null roc5 values
  const rocData = data?.candles.filter(c => c.roc5 != null) ?? [];

  const regime = data ? regimeLabel(data.spot) : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="grid grid-cols-5 gap-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-zinc-800 rounded-xl h-16" />
          ))}
        </div>
        <div className="bg-zinc-800 rounded-xl h-64" />
        <div className="bg-zinc-800 rounded-xl h-36" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <div className="px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400 max-w-lg text-center">
          {error}
        </div>
        <button
          onClick={() => { setLoading(true); void fetchData(); }}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-200 font-semibold transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Stat row */}
      <div className="flex items-stretch gap-3">
        {/* VIX current — wider tile with regime badge */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 flex flex-col gap-1 min-w-0 flex-shrink-0">
          <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">VIX</span>
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold tabular-nums ${regime?.color ?? 'text-zinc-100'}`}>
              {data ? fmtVix(data.spot) : '—'}
            </span>
            {regime && (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${regime.pill}`}>
                {regime.label}
              </span>
            )}
          </div>
        </div>

        <StatTile label="Open"       value={data ? fmtVix(data.day_open)   : '—'} valueClass="text-zinc-100"     />
        <StatTile label="High"       value={data ? fmtVix(data.day_high)   : '—'} valueClass="text-emerald-400"  />
        <StatTile label="Low"        value={data ? fmtVix(data.day_low)    : '—'} valueClass="text-red-400"      />
        <StatTile label="Prev Close" value={data ? fmtVix(data.prev_close) : '—'} valueClass="text-zinc-400"     />
      </div>

      {/* Main VIX line chart */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs font-semibold text-zinc-400 mb-3">India VIX — 1 min</p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data?.candles ?? []} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={xTickFormatter}
              interval={29}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={(v: number) => v.toFixed(2)}
              domain={([min, max]: readonly [number, number]): [number, number] => [
                parseFloat((min * 0.95).toFixed(2)),
                parseFloat((max * 1.05).toFixed(2)),
              ]}
              width={44}
            />
            <Tooltip content={<VixTooltip />} />
            {data && (
              <ReferenceLine
                y={data.prev_close}
                stroke="#52525b"
                strokeDasharray="4 3"
                label={{ value: 'PDC', fill: '#71717a', fontSize: 9, position: 'insideTopRight' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="close"
              stroke="#818cf8"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: '#818cf8' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ROC histogram */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <p className="text-xs font-semibold text-zinc-400 mb-3">VIX Velocity — 5-min ROC %</p>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={rocData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={xTickFormatter}
              interval={29}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={(v: number) => `${v.toFixed(2)}%`}
              width={52}
              label={{ value: 'ROC 5m %', angle: -90, position: 'insideLeft', fill: '#52525b', fontSize: 9, dx: -4 }}
            />
            <Tooltip content={<RocTooltip />} />
            <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
            <Bar dataKey="roc5" maxBarSize={6}>
              {rocData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={(entry.roc5 ?? 0) >= 0 ? '#10b981' : '#ef4444'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {data && (
          <span className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono text-[10px]">
            DATA: {data.data_date}
          </span>
        )}
        {data && !data.is_today && (
          <span className="px-2 py-0.5 bg-amber-500/15 border border-amber-500/30 rounded text-amber-400 font-semibold text-[10px]">
            NOT TODAY
          </span>
        )}
        {lastUpdated && (
          <span>Last updated: {fmtTime(lastUpdated)}</span>
        )}
        <span className={`ml-auto font-semibold ${countdown <= 10 ? 'text-amber-400 animate-pulse' : 'text-zinc-500'}`}>
          Refresh in {countdown}s
        </span>
      </div>

    </div>
  );
}
