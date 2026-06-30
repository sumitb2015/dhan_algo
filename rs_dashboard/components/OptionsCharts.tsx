'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import NavBar from './NavBar';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import OptionsSkewTab from './OptionsSkewTab';
import OptionsOITab from './OptionsOITab';
import OptionsCumulativeOITab from './OptionsCumulativeOITab';

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
  ce?: { last_price?: number; oi?: number; implied_volatility?: number; greeks?: { iv?: number } };
  pe?: { last_price?: number; oi?: number; implied_volatility?: number; greeks?: { iv?: number } };
}

interface CandleRow {
  time: string;
  'CE LTP': number;
  'PE LTP': number;
  Straddle: number;
  'CE Vol'?: number;
  'PE Vol'?: number;
  'CE OI'?: number;
  'PE OI'?: number;
}

interface IvPoint { time: string; ceIV: number; peIV: number }

// ─── Helpers ──────────────────────────────────────────────────────

function extractIV(side?: { implied_volatility?: number; greeks?: { iv?: number } }): number {
  return side?.implied_volatility ?? side?.greeks?.iv ?? 0;
}

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

function fmtOI(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return fmtNum(n);
}

// ─── Tooltip ──────────────────────────────────────────────────────

const ChartTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[160px] backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold tracking-wide">{String(label)}</p>
      {(payload as Array<{ color: string; name: string; value: number }>).map(p => (
        <div key={p.name} className="flex justify-between gap-6 mb-0.5">
          <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
          <span className="tabular-nums text-white font-bold">
            {typeof p.value === 'number'
              ? p.value > 10_000 ? fmtNum(p.value) : fmtNum(p.value, 2)
              : p.value}
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
  const [candleDate, setCandleDate]     = useState<string | null>(null);
  const [candleIsToday, setCandleIsToday] = useState(true);

  // Historical seed for live mode — candles from 9:15 AM prepended to live WS history
  const [liveSeedData, setLiveSeedData]         = useState<CandleRow[]>([]);
  const [liveSeedStrike, setLiveSeedStrike]     = useState<number | null>(null);

  const [bridgeLoading, setBridgeLoading]     = useState(false);
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // Premium chart visibility toggles
  const [showCE,   setShowCE]   = useState(true);
  const [showPE,   setShowPE]   = useState(true);
  const [showVWAP, setShowVWAP] = useState(false);
  const [activeTab, setActiveTab] = useState<'premium' | 'skew' | 'oi' | 'cumulative'>('premium');

  // IV time-series state
  const [ivHistory, setIvHistory] = useState<IvPoint[]>([]);
  const [showCeIV, setShowCeIV]   = useState(true);
  const [showPeIV, setShowPeIV]   = useState(true);
  const ivPollRef = useRef<NodeJS.Timeout | null>(null);

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

          const spotPrice = j.data.spot ?? 0;

          const applySpot = (sp: number) => {
            setChainSpot(sp);
            if (sp > 0 && strikes.length) {
              const atmStrike = Math.round(sp / 50) * 50;
              const nearest   = strikes.reduce((prev, cur) =>
                Math.abs(cur - atmStrike) < Math.abs(prev - atmStrike) ? cur : prev);
              setSelectedStrike(nearest);
            }
          };

          if (spotPrice > 0) {
            applySpot(spotPrice);
          } else {
            // Fetch spot from dedicated LTP endpoint when chain doesn't return it
            fetch(`/api/options/spot?underlying=${UNDERLYING}`)
              .then(r => r.json())
              .then((s: { success: boolean; spot?: number }) => {
                if (s.success && s.spot && s.spot > 0) applySpot(s.spot);
              })
              .catch(() => {});
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
      .then((j: { success: boolean; data?: CandleRow[]; error?: string; dataDate?: string; isToday?: boolean }) => {
        if (j.success && j.data?.length) {
          setCandleData(j.data);
          setCandleDate(j.dataDate ?? null);
          setCandleIsToday(j.isToday ?? true);
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

  // Seed live chart with today's 1-min candles from 9:15 AM when bridge is running.
  // Refreshes every 60 s (matching server-side cache TTL) so newly closed 1-min
  // candles extend the seed base as the session progresses.
  const seedRefreshRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (seedRefreshRef.current) clearInterval(seedRefreshRef.current);

    if (bridgeStatus.status !== 'RUNNING') {
      setLiveSeedData([]);
      setLiveSeedStrike(null);
      return;
    }
    if (!selectedStrike || !expiry) return;

    const fetchSeed = () => {
      fetch(`/api/options/candles?expiry=${expiry}&strike=${selectedStrike}&interval=1`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: CandleRow[] }) => {
          if (j.success && j.data?.length) setLiveSeedData(j.data);
        })
        .catch(() => {});
    };

    if (selectedStrike !== liveSeedStrike) {
      setLiveSeedStrike(selectedStrike);
      fetchSeed();
    }

    seedRefreshRef.current = setInterval(fetchSeed, 60_000);
    return () => { if (seedRefreshRef.current) clearInterval(seedRefreshRef.current); };
  }, [bridgeStatus.status, selectedStrike, expiry, liveSeedStrike]);

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

  // ── IV time-series polling ────────────────────────────────────────
  useEffect(() => {
    if (!expiry || !selectedStrike) return;
    setIvHistory([]);

    const fetchIV = () => {
      fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> } } }) => {
          if (!j.success || !j.data?.chain?.oc) return;
          const entry = j.data.chain.oc[String(selectedStrike)];
          if (!entry) return;
          const ceIV = extractIV(entry.ce);
          const peIV = extractIV(entry.pe);
          if (ceIV === 0 && peIV === 0) return;
          const time = new Date().toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          });
          setIvHistory(prev => [...prev, { time, ceIV, peIV }]);
        })
        .catch(() => {});
    };

    fetchIV();
    ivPollRef.current = setInterval(fetchIV, 30_000);
    return () => { if (ivPollRef.current) clearInterval(ivPollRef.current); };
  }, [expiry, selectedStrike]);

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

  // ATM ±10 strikes for the dropdown, index-based
  const visibleStrikes = (() => {
    if (!strikeKeys.length) return strikeKeys;
    const center = atm > 0 ? atm : selectedStrike ?? 0;
    const nearestIdx = center > 0
      ? strikeKeys.reduce((best, sk, i) =>
          Math.abs(sk - center) < Math.abs(strikeKeys[best] - center) ? i : best, 0)
      : Math.floor(strikeKeys.length / 2);
    return strikeKeys.slice(Math.max(0, nearestIdx - 10), nearestIdx + 11);
  })();

  // Live snapshot for stats (only meaningful when bridge is running)
  const liveData = quotes?.strikes[chartStrikeStr];
  const ceLtp    = liveData?.ce?.ltp ?? 0;
  const peLtp    = liveData?.pe?.ltp ?? 0;
  const straddle = ceLtp + peLtp;

  // Chart data: live WebSocket history when running, candle data otherwise.
  // When seed is present, only include live ticks that come AFTER the last seed
  // candle minute to prevent time discontinuity (stale WS history from an earlier
  // bridge session would otherwise appear to the right of newer seed candles).
  const lastSeedMins = liveSeedData.length > 0
    ? (() => {
        const [hh, mm] = liveSeedData[liveSeedData.length - 1].time.split(':').map(Number);
        return hh * 60 + (mm || 0);
      })()
    : -1;

  const liveChartData: CandleRow[] = history
    .filter(h => {
      if (lastSeedMins < 0) return true;
      const d = new Date(h.timestamp);
      return d.getHours() * 60 + d.getMinutes() > lastSeedMins;
    })
    .map(h => {
      const sk = h.strikes[chartStrikeStr];
      const ce = sk?.ce?.ltp ?? 0;
      const pe = sk?.pe?.ltp ?? 0;
      return {
        time: fmtTime(h.timestamp),
        'CE LTP': ce,
        'PE LTP': pe,
        Straddle: ce + pe,
        'CE OI': sk?.ce?.oi ?? 0,
        'PE OI': sk?.pe?.oi ?? 0,
      };
    });

  const rawChartData = isLive ? [...liveSeedData, ...liveChartData] : candleData;

  // Compute cumulative intraday VWAP: Σ(Straddle × Vol) / Σ(Vol) where Vol = CE Vol + PE Vol.
  // Falls back to equal-weight mean (TWAP) when volume is absent (live WebSocket mode).
  const chartData = (() => {
    let cumPV = 0;
    let cumV  = 0;
    return rawChartData.map(row => {
      const vol = (row['CE Vol'] ?? 0) + (row['PE Vol'] ?? 0);
      cumPV += row.Straddle * (vol > 0 ? vol : 1);
      cumV  += vol > 0 ? vol : 1;
      return { ...row, VWAP: parseFloat((cumPV / cumV).toFixed(2)) };
    });
  })();

  const chartSource  = isLive
    ? 'WebSocket'
    : candleDate
      ? `${candleInterval}m candles · ${candleIsToday ? 'today' : candleDate}`
      : `${candleInterval}m candles`;
  const hasData      = chartData.length > 1;

  // Latest OI values for stat tiles
  const lastRow      = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const latestCeOi   = isLive ? (liveData?.ce?.oi ?? 0) : (lastRow?.['CE OI'] ?? 0);
  const latestPeOi   = isLive ? (liveData?.pe?.oi ?? 0) : (lastRow?.['PE OI'] ?? 0);
  const hasOiData    = chartData.some(r => (r['CE OI'] ?? 0) > 0 || (r['PE OI'] ?? 0) > 0);
  const pcr          = latestCeOi > 0 ? (latestPeOi / latestCeOi) : 0;
  const xTickInterval = chartData.length > 0 ? Math.max(0, Math.floor(chartData.length / 10) - 1) : 0;

  // Shared chart axes config
  const xAxisProps = {
    dataKey: 'time' as const,
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine: false,
    axisLine: { stroke: '#27272a' },
    interval: xTickInterval,
  };
  const gridProps = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false };
  const tooltipProps = { content: <ChartTooltip />, cursor: { stroke: '#3f3f46', strokeWidth: 1 } };
  const legendProps = {
    wrapperStyle: { fontSize: 11, paddingTop: 12 },
    formatter: (v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>,
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">Nifty Straddle Chart</h1>
            <p className="text-[10px] text-zinc-400 font-medium">
              {isLive
                ? 'Live WebSocket · OI & Premium'
                : candleDate && !candleIsToday
                  ? `Historical ${candleInterval}-min candles · ${candleDate}`
                  : `Today's ${candleInterval}-min candles · OI & Premium`}
            </p>
          </div>

          {/* Page nav */}
          <NavBar />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-300 font-medium">Expiry</span>
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

          {/* Candle interval (premium tab only, not live) */}
          {activeTab === 'premium' && !isLive && (
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {(['1', '5'] as const).map(s => (
                <button key={s} onClick={() => setCandleInterval(s)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    candleInterval === s
                      ? 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}>
                  {s}m
                </button>
              ))}
            </div>
          )}

          {/* Live poll interval (premium tab only) */}
          {activeTab === 'premium' && isLive && (
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {([2, 5, 10] as const).map(s => (
                <button key={s} onClick={() => setPollInterval(s)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    pollInterval === s
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}>
                  {s}s
                </button>
              ))}
            </div>
          )}

          {/* Start / Stop — premium tab only */}
          {activeTab === 'premium' && (
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
          )}

          {activeTab === 'premium' && <StatusBadge status={bridgeStatus.status} />}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">

          {/* Tab bar */}
          <div className="flex border-b border-zinc-800 -mx-6 px-6 -mt-5 mb-1">
            {([
              { key: 'premium',    label: 'Premium'       },
              { key: 'skew',       label: 'Skew'          },
              { key: 'oi',         label: 'Open Interest' },
              { key: 'cumulative', label: 'Cumulative OI' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-4 py-2.5 text-xs font-semibold capitalize transition-all border-b-2 -mb-px ${
                  activeTab === key
                    ? 'text-white border-blue-500'
                    : 'text-zinc-400 border-transparent hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {activeTab === 'skew'       && <OptionsSkewTab         expiry={expiry} />}
          {activeTab === 'oi'         && <OptionsOITab           expiry={expiry} />}
          {activeTab === 'cumulative' && <OptionsCumulativeOITab expiry={expiry} />}

          {activeTab === 'premium' && <>

        {/* Stats — 6 tiles */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
          {([
            { label: 'Spot',
              value: spot > 0 ? fmtNum(spot, 2) : '—',
              color: 'text-white', accent: 'border-zinc-700/60' },
            { label: 'Strike',
              value: chartStrike > 0 ? fmtNum(chartStrike) : '—',
              sub: chartStrike > 0 && atm > 0
                ? chartStrike === atm ? 'ATM'
                  : chartStrike > atm ? `+${chartStrike - atm}` : `−${atm - chartStrike}`
                : undefined,
              color: 'text-zinc-100', accent: 'border-zinc-700/60' },
            { label: 'CE OI',
              value: latestCeOi > 0 ? fmtOI(latestCeOi) : '—',
              sub: latestCeOi > 0 ? fmtNum(latestCeOi) : undefined,
              color: 'text-blue-400', accent: 'border-blue-500/25' },
            { label: 'PE OI',
              value: latestPeOi > 0 ? fmtOI(latestPeOi) : '—',
              sub: latestPeOi > 0 ? fmtNum(latestPeOi) : undefined,
              color: 'text-red-400', accent: 'border-red-500/25' },
            { label: 'PCR',
              value: pcr > 0 ? pcr.toFixed(2) : '—',
              sub: pcr > 1.3 ? 'Bullish' : pcr > 0 && pcr < 0.7 ? 'Bearish' : pcr > 0 ? 'Neutral' : undefined,
              color: pcr > 1.3 ? 'text-emerald-400' : pcr > 0 && pcr < 0.7 ? 'text-red-400' : 'text-yellow-400',
              accent: pcr > 1.3 ? 'border-emerald-500/25' : pcr > 0 && pcr < 0.7 ? 'border-red-500/25' : 'border-yellow-500/25' },
            { label: 'Straddle',
              value: isLive && straddle > 0 ? fmtNum(straddle, 2)
                : lastRow && (lastRow['CE LTP'] + lastRow['PE LTP']) > 0
                  ? fmtNum(lastRow['CE LTP'] + lastRow['PE LTP'], 2)
                  : '—',
              sub: isLive ? `CE ${fmtNum(ceLtp, 2)} + PE ${fmtNum(peLtp, 2)}` : undefined,
              color: 'text-emerald-400', accent: 'border-emerald-500/25' },
          ]).map(({ label, value, color, sub, accent }) => (
            <div key={label} className={`bg-zinc-900/70 border rounded-xl px-3 py-3 ${accent}`}>
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-base font-bold tabular-nums ${color}`}>{value}</p>
              {sub && <p className="text-[10px] text-zinc-400 mt-0.5 font-medium truncate">{sub}</p>}
            </div>
          ))}
        </div>

        {/* Strike selector */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest whitespace-nowrap">Strike</span>
          {chainLoading ? (
            <span className="text-xs text-zinc-400">Loading strikes…</span>
          ) : strikeKeys.length > 0 ? (
            <select
              value={chartStrike || ''}
              onChange={e => setSelectedStrike(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm font-semibold
                         rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500 w-48"
            >
              {visibleStrikes.map(sk => (
                <option key={sk} value={sk}>
                  {fmtNum(sk)}{sk === atm ? '  ← ATM' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-zinc-400">
              {expiry ? 'Could not load chain — check auth token' : 'Select an expiry first'}
            </span>
          )}
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
          {hasData && (
            <span className="text-[10px] text-zinc-400 font-medium ml-1">
              {chartData.length} candles · {chartSource}
            </span>
          )}
          {isLive && bridgeStatus.last_update && (
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 ml-auto">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              updated {fmtTime(bridgeStatus.last_update)}
            </div>
          )}
        </div>

        {/* ── Dual charts ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* OI chart */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-white tracking-tight">Open Interest</p>
                  {chartStrike > 0 && (
                    <span className="text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                      {fmtNum(chartStrike)}{chartStrike === atm && atm > 0 ? ' ATM' : ''}
                    </span>
                  )}
                  {hasOiData && pcr > 0 && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      pcr > 1.3 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : pcr < 0.7 ? 'bg-red-500/10 text-red-400 border-red-500/30'
                      : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30'
                    }`}>PCR {pcr.toFixed(2)}</span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-400 mt-0.5">CE OI vs PE OI · NIFTY {expiry || '—'}</p>
              </div>
            </div>

            {hasData && hasOiData ? (
              <ResponsiveContainer width="100%" height={420}>
                <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradCE" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#60a5fa" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#60a5fa" stopOpacity={0.01} />
                    </linearGradient>
                    <linearGradient id="gradPE" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#f87171" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#f87171" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }} tickLine={false}
                    axisLine={false} domain={['auto', 'auto']} width={52} tickFormatter={fmtOI} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} />
                  <Area type="monotone" dataKey="CE OI" stroke="#60a5fa" strokeWidth={2}
                    fill="url(#gradCE)" dot={false} activeDot={{ r: 4, fill: '#60a5fa', strokeWidth: 0 }} />
                  <Area type="monotone" dataKey="PE OI" stroke="#f87171" strokeWidth={2}
                    fill="url(#gradPE)" dot={false} activeDot={{ r: 4, fill: '#f87171', strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-[420px] gap-3">
                {candleLoading ? (
                  <>
                    <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
                    <p className="text-sm text-zinc-300 font-medium">Loading candles…</p>
                  </>
                ) : isLive ? (
                  <>
                    <div className="w-6 h-6 border-2 border-emerald-700 border-t-emerald-400 rounded-full animate-spin" />
                    <p className="text-sm text-zinc-300 font-medium">Accumulating live ticks…</p>
                  </>
                ) : hasData && !hasOiData ? (
                  <p className="text-sm text-zinc-300 font-medium">OI not returned by API for this contract</p>
                ) : candleError ? (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-sm text-red-500 font-medium">{candleError}</p>
                    <button onClick={() => selectedStrike && fetchCandles(selectedStrike, expiry, candleInterval)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all">
                      Retry
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-300 font-medium">Select a strike to load chart</p>
                )}
              </div>
            )}
          </div>

          {/* Premium chart */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-white tracking-tight">Straddle Premium</p>
                  {chartStrike > 0 && (
                    <span className="text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                      {fmtNum(chartStrike)}{chartStrike === atm && atm > 0 ? ' ATM' : ''}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-400 mt-0.5">CE LTP + PE LTP · NIFTY {expiry || '—'}</p>
              </div>
              {/* Series toggles */}
              <div className="flex items-center gap-1.5">
                {([
                  { key: 'CE',   label: 'CE',   active: showCE,   toggle: () => setShowCE(v => !v),   color: 'text-blue-400  border-blue-500/30  bg-blue-500/10  data-[on]:bg-blue-500/20'  },
                  { key: 'PE',   label: 'PE',   active: showPE,   toggle: () => setShowPE(v => !v),   color: 'text-red-400   border-red-500/30   bg-red-500/10   data-[on]:bg-red-500/20'   },
                  { key: 'VWAP', label: 'VWAP', active: showVWAP, toggle: () => setShowVWAP(v => !v), color: 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10 data-[on]:bg-yellow-500/20' },
                ] as const).map(({ key, label, active, toggle, color }) => (
                  <button
                    key={key}
                    onClick={toggle}
                    className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${color} ${
                      active ? 'opacity-100' : 'opacity-35'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {hasData ? (
              <ResponsiveContainer width="100%" height={420}>
                <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradStraddle" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#10b981" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }} tickLine={false}
                    axisLine={false} domain={['auto', 'auto']} width={52}
                    tickFormatter={v => fmtNum(v, 0)} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} />
                  <Area type="monotone" dataKey="Straddle" stroke="#10b981" strokeWidth={2.5}
                    fill="url(#gradStraddle)" dot={false} activeDot={{ r: 4, fill: '#10b981', strokeWidth: 0 }} />
                  {showCE && (
                    <Line type="monotone" dataKey="CE LTP" stroke="#60a5fa" strokeWidth={1.5}
                      strokeDasharray="5 3" dot={false} activeDot={{ r: 3, fill: '#60a5fa', strokeWidth: 0 }} />
                  )}
                  {showPE && (
                    <Line type="monotone" dataKey="PE LTP" stroke="#f87171" strokeWidth={1.5}
                      strokeDasharray="5 3" dot={false} activeDot={{ r: 3, fill: '#f87171', strokeWidth: 0 }} />
                  )}
                  {showVWAP && (
                    <Line type="monotone" dataKey="VWAP" stroke="#facc15" strokeWidth={1.5}
                      strokeDasharray="8 4" dot={false} activeDot={{ r: 3, fill: '#facc15', strokeWidth: 0 }} />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex flex-col items-center justify-center h-[420px] gap-3">
                {candleLoading ? (
                  <>
                    <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
                    <p className="text-sm text-zinc-300 font-medium">Loading candles…</p>
                  </>
                ) : isLive ? (
                  <>
                    <div className="w-6 h-6 border-2 border-emerald-700 border-t-emerald-400 rounded-full animate-spin" />
                    <p className="text-sm text-zinc-300 font-medium">Accumulating live ticks…</p>
                  </>
                ) : candleError ? (
                  <div className="flex flex-col items-center gap-2">
                    <p className="text-sm text-red-500 font-medium">{candleError}</p>
                    <button onClick={() => selectedStrike && fetchCandles(selectedStrike, expiry, candleInterval)}
                      className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-all">
                      Retry
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-zinc-300 font-medium">Select a strike to load chart</p>
                )}
              </div>
            )}
          </div>

        </div>

        {/* ── IV time-series ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {([
            { key: 'ceIV' as const, label: 'CE IV', color: '#60a5fa', show: showCeIV, setShow: setShowCeIV,
              badgeCls: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
            { key: 'peIV' as const, label: 'PE IV', color: '#fbbf24', show: showPeIV, setShow: setShowPeIV,
              badgeCls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
          ]).map(({ key, label, color, show, setShow, badgeCls }) => (
            <div key={key} className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-bold text-white tracking-tight">
                    {label}
                    {chartStrike > 0 && (
                      <span className="ml-2 text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                        {fmtNum(chartStrike)}{chartStrike === atm && atm > 0 ? ' ATM' : ''}
                      </span>
                    )}
                  </p>
                  <p className="text-[10px] text-zinc-400 mt-0.5">
                    sampled every 30s · {ivHistory.length} point{ivHistory.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <button
                  onClick={() => setShow(v => !v)}
                  className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${badgeCls} ${show ? 'opacity-100' : 'opacity-35'}`}
                >
                  {label}
                </button>
              </div>

              {ivHistory.length < 2 ? (
                <div className="flex items-center justify-center h-[420px] text-zinc-500 text-xs">
                  {chartStrike > 0
                    ? 'IV chart builds as data accumulates — first point appears within 30s'
                    : 'Select a strike to start tracking IV'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={420}>
                  <LineChart data={ivHistory} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid {...gridProps} />
                    <XAxis
                      dataKey="time"
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      tickLine={false}
                      axisLine={{ stroke: '#27272a' }}
                      interval={Math.max(0, Math.floor(ivHistory.length / 10) - 1)}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                      tickLine={false}
                      axisLine={false}
                      domain={['auto', 'auto']}
                      width={40}
                      tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    />
                    <Tooltip
                      contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                      labelStyle={{ color: '#a1a1aa', fontWeight: 600, marginBottom: 4 }}
                      formatter={(v: unknown) => [typeof v === 'number' ? `${v.toFixed(2)}%` : '—', label]}
                    />
                    {show && (
                      <Line type="monotone" dataKey={key} name={label} stroke={color}
                        strokeWidth={2} dot={false} activeDot={{ r: 4, fill: color, strokeWidth: 0 }} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          ))}
        </div>

          </>}
      </div>
    </div>
  );
}
