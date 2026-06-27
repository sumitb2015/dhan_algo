'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface OptionSide { ltp: number; oi: number; volume: number }
interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

interface HistoryPoint {
  timestamp: string;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

interface LiveQuotes {
  updated_at: string | null;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

interface BridgeStatus {
  status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  pid?: number;
  subscribed?: number;
  last_update?: string;
}

interface ChainOcEntry {
  ce?: { last_price?: number; oi?: number };
  pe?: { last_price?: number; oi?: number };
}

interface CandleRow {
  time: string;
  'CE LTP': number;
  'PE LTP': number;
  Straddle: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

// ─── Tooltip ──────────────────────────────────────────────────────

const ChartTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl min-w-[150px]">
      <p className="text-zinc-500 mb-1.5 font-medium">{String(label)}</p>
      {(payload as Array<{ color: string; name: string; value: number }>).map(p => (
        <div key={p.name} className="flex justify-between gap-4">
          <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
          <span className="tabular-nums text-zinc-200 font-semibold">
            {typeof p.value === 'number' ? fmtNum(p.value, 2) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Status badge ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: BridgeStatus['status'] }) {
  const cls =
    status === 'RUNNING'  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
    status === 'STARTING' ? 'bg-yellow-500/15  text-yellow-400  border-yellow-500/30'  :
    status === 'ERROR'    ? 'bg-red-500/15     text-red-400     border-red-500/30'      :
                            'bg-zinc-800       text-zinc-500    border-zinc-700';
  const dot =
    status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
    status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
    status === 'ERROR'    ? 'bg-red-400'                   : 'bg-zinc-600';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {status}
    </span>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

const UNDERLYING = 'NIFTY';

export default function OptionsCharts() {
  const [expiry, setExpiry]     = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [pollInterval, setPollInterval]     = useState<2 | 5 | 10>(2);
  const [candleInterval, setCandleInterval] = useState<'1' | '5'>('1');

  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'STOPPED' });
  const [quotes, setQuotes]   = useState<LiveQuotes | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  // Static chain for strike list
  const [chainStrikes, setChainStrikes] = useState<number[]>([]);
  const [chainSpot, setChainSpot]       = useState(0);
  const [chainLoading, setChainLoading] = useState(false);

  // Intraday candle data (shown when bridge is stopped)
  const [candleData, setCandleData]     = useState<CandleRow[]>([]);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError]   = useState('');

  const [bridgeLoading, setBridgeLoading]     = useState(false);
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // ── Fetch expiries ────────────────────────────────────────────────
  useEffect(() => {
    setExpiry('');
    setExpiries([]);
    setSelectedStrike(null);
    setChainStrikes([]);
    setError('');
    setExpiriesLoading(true);

    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        } else {
          setError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  // ── Fetch static chain when expiry changes ────────────────────────
  useEffect(() => {
    if (!expiry) return;
    setChainStrikes([]);
    setSelectedStrike(null);
    setCandleData([]);
    setChainLoading(true);

    fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: {
        success: boolean;
        data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number };
        error?: string;
      }) => {
        if (j.success && j.data?.chain?.oc) {
          const strikes = Object.keys(j.data.chain.oc)
            .map(Number)
            .filter(n => !isNaN(n))
            .sort((a, b) => a - b);
          setChainStrikes(strikes);
          setChainSpot(j.data.spot ?? 0);

          if (j.data.spot > 0 && strikes.length) {
            const atm     = Math.round(j.data.spot / 50) * 50;
            const nearest = strikes.reduce((prev, cur) =>
              Math.abs(cur - atm) < Math.abs(prev - atm) ? cur : prev);
            setSelectedStrike(nearest);
          }
        }
      })
      .catch(() => {})
      .finally(() => setChainLoading(false));
  }, [expiry]);

  // ── Fetch today's 1-min candles (when bridge is stopped) ──────────
  const fetchCandles = useCallback((strike: number, exp: string, interval: string) => {
    setCandleData([]);
    setCandleError('');
    setCandleLoading(true);

    fetch(`/api/options/candles?expiry=${exp}&strike=${strike}&interval=${interval}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: CandleRow[]; error?: string }) => {
        if (j.success && j.data?.length) {
          setCandleData(j.data);
        } else {
          setCandleError(j.error ?? 'No candle data returned');
        }
      })
      .catch(e => setCandleError(String(e)))
      .finally(() => setCandleLoading(false));
  }, []);

  // Trigger candle fetch whenever strike, expiry, or interval changes and bridge is not live
  useEffect(() => {
    if (bridgeStatus.status === 'RUNNING') return;
    if (!selectedStrike || !expiry) return;
    fetchCandles(selectedStrike, expiry, candleInterval);
  }, [selectedStrike, expiry, candleInterval, bridgeStatus.status, fetchCandles]);

  // ── Poll live data ────────────────────────────────────────────────
  const pollLive = useCallback(() => {
    fetch('/api/options/live')
      .then(r => r.json())
      .then((j: {
        success: boolean;
        status: BridgeStatus;
        quotes: LiveQuotes;
        history: { history: HistoryPoint[] };
      }) => {
        if (!j.success) return;
        setBridgeStatus(j.status);

        if (j.quotes?.strikes && Object.keys(j.quotes.strikes).length) {
          setQuotes(j.quotes);
          setSelectedStrike(prev => prev ?? j.quotes.atm ?? null);
        }
        if (j.history?.history?.length) {
          setHistory(j.history.history);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    pollLive();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(pollLive, pollInterval * 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollLive, pollInterval]);

  // ── Bridge start / stop ───────────────────────────────────────────
  const startBridge = async () => {
    if (!expiry) { setError('Select an expiry first'); return; }
    setError('');
    setBridgeLoading(true);
    try {
      await fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying: UNDERLYING, expiry }),
      });
      setHistory([]);
      setCandleData([]);
      setTimeout(pollLive, 800);
    } catch (e) {
      setError(String(e));
    } finally {
      setBridgeLoading(false);
    }
  };

  const stopBridge = async () => {
    setBridgeLoading(true);
    try {
      await fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      setTimeout(pollLive, 800);
    } finally {
      setBridgeLoading(false);
    }
  };

  // ── Derived ───────────────────────────────────────────────────────
  const isLive = bridgeStatus.status === 'RUNNING';

  const liveStrikeKeys = quotes?.strikes
    ? Object.keys(quotes.strikes).map(Number).sort((a, b) => a - b)
    : [];
  const strikeKeys = isLive && liveStrikeKeys.length ? liveStrikeKeys : chainStrikes;

  const atm  = isLive && quotes?.atm ? quotes.atm : chainSpot > 0 ? Math.round(chainSpot / 50) * 50 : 0;
  const spot = isLive ? (quotes?.spot ?? chainSpot) : chainSpot;

  const chartStrike    = selectedStrike ?? atm;
  const chartStrikeStr = String(chartStrike);

  // Live snapshot for stats (only meaningful when bridge is running)
  const liveData = quotes?.strikes[chartStrikeStr];
  const ceLtp    = liveData?.ce?.ltp ?? 0;
  const peLtp    = liveData?.pe?.ltp ?? 0;
  const straddle = ceLtp + peLtp;

  // Chart data: live WebSocket history when running, candle data otherwise
  const liveChartData: CandleRow[] = history.map(h => {
    const sk = h.strikes[chartStrikeStr];
    const ce = sk?.ce?.ltp ?? 0;
    const pe = sk?.pe?.ltp ?? 0;
    return { time: fmtTime(h.timestamp), 'CE LTP': ce, 'PE LTP': pe, Straddle: ce + pe };
  });

  const chartData    = isLive ? liveChartData : candleData;
  const chartSource  = isLive ? 'WebSocket' : `${candleInterval}m candles`;
  const hasData      = chartData.length > 1;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">Nifty Straddle Chart</h1>
            <p className="text-[10px] text-zinc-600 font-medium">
              {isLive ? 'Live WebSocket feed' : `Today's ${candleInterval}-min candles (static)`}
            </p>
          </div>

          {/* Page nav */}
          <div className="flex items-center bg-zinc-900/80 border border-zinc-800 p-0.5 rounded-xl">
            {([
              ['/', 'RS Scanner'],
              ['/movers', 'Movers'],
              ['/scanner', 'Scanner'],
              ['/normalized', 'Charts'],
              ['/distribution', 'Distribution'],
              ['/breadth', 'Breadth'],
              ['/strategies', 'Strategies'],
              ['/portfolio', 'Portfolio'],
              ['/reports', 'Reports'],
              ['/performance', 'Performance'],
              ['/options', 'Options'],
            ] as [string, string][]).map(([href, label]) =>
              href === '/options' ? (
                <span key={href} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {label}
                </span>
              ) : (
                <Link key={href} href={href} className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-500 hover:text-zinc-300 transition-all">
                  {label}
                </Link>
              )
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500 font-medium">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={expiriesLoading || isLive}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                         disabled:opacity-50"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>

          {/* Candle interval (only when not live) */}
          {!isLive && (
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {(['1', '5'] as const).map(s => (
                <button key={s} onClick={() => setCandleInterval(s)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    candleInterval === s
                      ? 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}>
                  {s}m
                </button>
              ))}
            </div>
          )}

          {/* Live poll interval */}
          {isLive && (
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {([2, 5, 10] as const).map(s => (
                <button key={s} onClick={() => setPollInterval(s)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    pollInterval === s
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}>
                  {s}s
                </button>
              ))}
            </div>
          )}

          {/* Start / Stop */}
          <button
            onClick={isLive ? stopBridge : startBridge}
            disabled={bridgeLoading || !expiry}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 ${
              isLive
                ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
            }`}
          >
            {bridgeLoading ? '…' : isLive ? 'Stop' : 'Go Live'}
          </button>

          <StatusBadge status={bridgeStatus.status} />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { label: 'Spot',
              value: spot > 0 ? fmtNum(spot, 2) : '—',
              color: 'text-white' },
            { label: 'Strike',
              value: chartStrike > 0 ? fmtNum(chartStrike) : '—',
              sub: chartStrike > 0 && atm > 0
                ? chartStrike === atm ? 'ATM'
                  : chartStrike > atm ? `ATM + ${chartStrike - atm}` : `ATM − ${atm - chartStrike}`
                : undefined,
              color: 'text-zinc-200' },
            { label: 'Straddle',
              value: isLive && straddle > 0 ? fmtNum(straddle, 2) : '—',
              sub: isLive ? undefined : 'live only',
              color: 'text-emerald-400' },
            { label: 'CE / PE',
              value: isLive && (ceLtp > 0 || peLtp > 0)
                ? `${fmtNum(ceLtp, 2)} / ${fmtNum(peLtp, 2)}` : '—',
              sub: isLive ? undefined : 'live only',
              color: 'text-zinc-300' },
          ] as { label: string; value: string; color: string; sub?: string }[]).map(
            ({ label, value, color, sub }) => (
              <div key={label} className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
                <p className={`text-xl font-bold tabular-nums mt-0.5 ${color}`}>{value}</p>
                {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
              </div>
            )
          )}
        </div>

        {/* Strike selector */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide whitespace-nowrap">
            Strike
          </span>
          {chainLoading ? (
            <span className="text-xs text-zinc-600">Loading strikes…</span>
          ) : strikeKeys.length > 0 ? (
            <select
              value={chartStrike || ''}
              onChange={e => setSelectedStrike(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm font-semibold
                         rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500 w-48"
            >
              {strikeKeys.map(sk => (
                <option key={sk} value={sk}>
                  {fmtNum(sk)}{sk === atm ? '  ← ATM' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-zinc-600">
              {expiry ? 'Could not load chain — check auth token' : 'Select an expiry first'}
            </span>
          )}

          {/* Refresh candles button (not live) */}
          {!isLive && selectedStrike && expiry && (
            <button
              onClick={() => fetchCandles(selectedStrike, expiry, candleInterval)}
              disabled={candleLoading}
              className="px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-zinc-700
                         bg-zinc-900 text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-all"
            >
              {candleLoading ? '…' : 'Refresh'}
            </button>
          )}
        </div>

        {/* Straddle chart */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex-1 min-h-[360px]">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs font-bold text-white">
                Straddle Premium
                <span className="ml-2 text-zinc-400 font-normal">
                  {chartStrike > 0 ? fmtNum(chartStrike) : '—'}
                  {chartStrike === atm && atm > 0 && (
                    <span className="ml-1 text-yellow-400 font-semibold text-[10px]">ATM</span>
                  )}
                </span>
              </p>
              <p className="text-[10px] text-zinc-500 mt-0.5">
                NIFTY · {expiry || '—'} · {chartSource}
                {hasData && ` · ${chartData.length} points`}
              </p>
            </div>
            {isLive && bridgeStatus.last_update && (
              <p className="text-[10px] text-zinc-600">
                updated {fmtTime(bridgeStatus.last_update)}
              </p>
            )}
          </div>

          {hasData ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  width={60}
                  tickFormatter={v => fmtNum(v, 0)}
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa', paddingTop: 8 }} />
                <Line type="monotone" dataKey="Straddle"
                  stroke="#10b981" strokeWidth={2.5}
                  dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                <Line type="monotone" dataKey="CE LTP"
                  stroke="#60a5fa" strokeWidth={1.5}
                  dot={false} strokeDasharray="5 3"
                  activeDot={{ r: 3, strokeWidth: 0 }} />
                <Line type="monotone" dataKey="PE LTP"
                  stroke="#f87171" strokeWidth={1.5}
                  dot={false} strokeDasharray="5 3"
                  activeDot={{ r: 3, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center h-[300px] gap-2">
              {candleLoading ? (
                <>
                  <div className="w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                  <p className="text-sm text-zinc-600">Loading {candleInterval}-min candles…</p>
                </>
              ) : isLive ? (
                <>
                  <div className="w-5 h-5 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-zinc-600">Accumulating live ticks…</p>
                  <p className="text-xs text-zinc-700">Chart updates every {pollInterval}s</p>
                </>
              ) : candleError ? (
                <>
                  <p className="text-sm text-red-500">{candleError}</p>
                  <button
                    onClick={() => selectedStrike && fetchCandles(selectedStrike, expiry, candleInterval)}
                    className="text-xs text-zinc-500 underline mt-1"
                  >
                    Retry
                  </button>
                </>
              ) : (
                <p className="text-sm text-zinc-600">Select a strike to load chart</p>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
