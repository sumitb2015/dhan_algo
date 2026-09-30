'use client';

// The Premium / PC Diff / Multi-Strike views of the Options page — the tabs
// that read the live WebSocket bridge or the per-strike candle series.
//
// Split out of OptionsCharts so their data (chain, spot, VIX, candles, live
// seed) is fetched only while one of these views is on screen. Before, the
// parent polled spot every 10s, VIX every 60s and candles every 1-5 min — each
// a Python spawn hitting Dhan — even while the user sat on Smart Chain or OI,
// whose own tabs were polling on top. Stays mounted across the three views, so
// switching Premium ↔ PC Diff keeps its data; the selected strike is owned by
// the shell so it also survives a trip to another tab.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { cachedFetch } from '@/lib/clientCache';
import { fmtNum } from '@/lib/numberFormat';
import type { HistoryPoint, LiveQuotes } from '@/lib/useOptionsLiveBridge';

const TabLoading = () => (
  <div className="h-72 bg-zinc-900/60 border border-zinc-800/60 rounded-xl animate-pulse" />
);
const OptionsMultiStrikeTab  = dynamic(() => import('./OptionsMultiStrikeTab'), { ssr: false, loading: TabLoading });
const OptionsPCDiffTab       = dynamic(() => import('./OptionsPCDiffTab'), { ssr: false, loading: TabLoading });

// ─── Types ────────────────────────────────────────────────────────

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

interface VixDataState {
  vix: number;
  prevClose: number;
  niftySpot?: number;
  niftyPrevClose?: number;
  niftyChange?: number;
  niftyChangePct?: number;
}

export type StraddleView = 'premium' | 'pcdiff' | 'multistrike';
export interface CandleMeta { date: string | null; isToday: boolean }

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

function fmtOI(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return fmtNum(n);
}

interface StrikeEntry { key: string; strike: number; entry: ChainOcEntry }

function parseStrikeEntries(oc: Record<string, ChainOcEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

function computeMaxPain(entries: StrikeEntry[]): number {
  if (!entries.length) return 0;
  let maxPain = entries[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of entries) {
    let payout = 0;
    for (const { strike: s, entry } of entries) {
      payout += (entry.ce?.oi ?? 0) * Math.max(0, K - s);
      payout += (entry.pe?.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
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

// ─── Main ─────────────────────────────────────────────────────────

const UNDERLYING = 'NIFTY';

interface Props {
  view: StraddleView;
  expiry: string;
  isLive: boolean;
  quotes: LiveQuotes | null;
  history: HistoryPoint[];
  bridgeLastUpdate?: string;
  candleInterval: '1' | '5';
  selectedStrike: number | null;
  setSelectedStrike: React.Dispatch<React.SetStateAction<number | null>>;
  /** Bumped by the shell when a historical-data download finishes. */
  dataVersion: number;
  /** Reports the candle series' date so the shell header can label it. */
  onCandleMeta: (meta: CandleMeta) => void;
}

export default function OptionsStraddleWorkspace({
  view, expiry, isLive, quotes, history, bridgeLastUpdate, candleInterval,
  selectedStrike, setSelectedStrike, dataVersion, onCandleMeta,
}: Props) {
  // Multi-Strike fetches its own per-strike series; it only needs ATM from here.
  const usesCandles = view !== 'multistrike';

  // Static chain for strike list
  const [chainStrikes, setChainStrikes] = useState<number[]>([]);
  const [chainOc, setChainOc]           = useState<Record<string, ChainOcEntry>>({});
  const [chainSpot, setChainSpot]       = useState(0);
  const [spotChangePctState, setSpotChangePctState] = useState<number | null>(null);
  const [cePrevCloseState, setCePrevCloseState] = useState<number | null>(null);
  const [pePrevCloseState, setPePrevCloseState] = useState<number | null>(null);
  const [chainLoading, setChainLoading] = useState(false);

  // Intraday candle data (shown when bridge is stopped)
  const [candleData, setCandleData]     = useState<CandleRow[]>([]);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError]   = useState('');
  const [candleDate, setCandleDate]     = useState<string | null>(null);
  const [candleIsToday, setCandleIsToday] = useState(true);

  // Historical seed for live mode — candles from 9:15 AM prepended to live WS history
  const [liveSeedData, setLiveSeedData] = useState<CandleRow[]>([]);

  const [vixData, setVixData] = useState<VixDataState | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- passed through to OptionsPCDiffTab untyped
  const [vixCandles, setVixCandles] = useState<any[]>([]);

  // Premium chart visibility toggles
  const [showVWAP,   setShowVWAP]   = useState(true);
  const [showCELine, setShowCELine] = useState(true);
  const [showPELine, setShowPELine] = useState(true);

  useEffect(() => {
    onCandleMeta({ date: candleDate, isToday: candleIsToday });
  }, [candleDate, candleIsToday, onCandleMeta]);

  // Poll vix-candles for spot, prev_close, and candles (60s) — premium/pcdiff only
  useEffect(() => {
    if (!usesCandles) return;
    let cancelled = false;
    async function fetchVix(retriesLeft = 2) {
      try {
        const data = await cachedFetch<{
          success: boolean;
          spot: number;
          prev_close: number;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          candles?: any[];
          nifty_spot?: number;
          nifty_prev_close?: number;
          nifty_change?: number;
          nifty_change_pct?: number;
        }>('/api/options/vix-candles', 55_000);
        if (cancelled) return;
        if (data.success) {
          setVixData({
            vix: data.spot,
            prevClose: data.prev_close,
            niftySpot: data.nifty_spot,
            niftyPrevClose: data.nifty_prev_close,
            niftyChange: data.nifty_change,
            niftyChangePct: data.nifty_change_pct,
          });
          if (data.candles) setVixCandles(data.candles);
        }
      } catch (err) {
        console.error('Failed to fetch VIX candles:', err);
        // Transient network/HMR blips (dev mode) shouldn't leave the ribbon
        // stuck for a full 60s cycle — retry a couple of times with backoff.
        if (retriesLeft > 0 && !cancelled) {
          setTimeout(() => fetchVix(retriesLeft - 1), 5_000);
        }
      }
    }
    fetchVix();
    const id = setInterval(() => fetchVix(), 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [usesCandles]);

  // ── Fetch static chain when expiry changes ────────────────────────
  // Extracted into a callback so a transient failure (expired Dhan token,
  // chain-API 429) can be retried from the UI instead of sticking until
  // the expiry changes.
  const fetchChain = useCallback((exp: string) => {
    setChainStrikes([]);
    setChainOc({});
    setChainLoading(true);

    cachedFetch<{
      success: boolean;
      data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number };
      error?: string;
    }>(`/api/options/chain?underlying=${UNDERLYING}&expiry=${exp}`, 30_000)
      .then(j => {
        if (j.success && j.data?.chain?.oc) {
          const oc = j.data.chain.oc;
          const strikes = Object.keys(oc)
            .map(Number)
            .filter(n => !isNaN(n))
            .sort((a, b) => a - b);
          setChainStrikes(strikes);
          setChainOc(oc);

          const spotPrice = j.data.spot ?? 0;

          const applySpot = (sp: number) => {
            setChainSpot(sp);
            if (sp > 0 && strikes.length) {
              const atmStrike = Math.round(sp / 50) * 50;
              const nearest   = strikes.reduce((prev, cur) =>
                Math.abs(cur - atmStrike) < Math.abs(prev - atmStrike) ? cur : prev);
              // Keep a strike the user picked (e.g. before visiting another
              // tab); default to ATM when none is set or it left the chain.
              setSelectedStrike(prev => (prev != null && strikes.includes(prev) ? prev : nearest));
            }
          };

          if (spotPrice > 0) {
            applySpot(spotPrice);
          } else {
            // Fetch spot from dedicated LTP endpoint when chain doesn't return it
            fetch(`/api/options/spot?underlying=${UNDERLYING}`)
              .then(r => r.json())
              .then((s: { success: boolean; spot?: number; change_pct?: number }) => {
                if (s.success && s.spot && s.spot > 0) {
                  applySpot(s.spot);
                  if (s.change_pct !== undefined) setSpotChangePctState(s.change_pct);
                }
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {})
      .finally(() => setChainLoading(false));
  }, [setSelectedStrike]);

  useEffect(() => {
    if (!expiry) return;
    fetchChain(expiry);
  }, [expiry, fetchChain]);

  // ── Fetch today's 1-min candles (when bridge is stopped) ──────────
  const fetchCandles = useCallback((strike: number, exp: string, interval: string, silent = false) => {
    if (!silent) {
      setCandleData([]);
      setCandleError('');
      setCandleLoading(true);
    }

    cachedFetch<{
      success: boolean;
      data?: CandleRow[];
      error?: string;
      dataDate?: string;
      isToday?: boolean;
      ce_prev_close?: number;
      pe_prev_close?: number;
      // 25 s TTL: shorter than any poll interval so silent refreshes stay
      // fresh, long enough that a page revisit repaints instantly
    }>(`/api/options/candles?expiry=${exp}&strike=${strike}&interval=${interval}`, 25_000)
      .then(j => {
        if (j.success && j.data?.length) {
          setCandleData(j.data);
          setCandleDate(j.dataDate ?? null);
          setCandleIsToday(j.isToday ?? true);
          if (j.ce_prev_close !== undefined) setCePrevCloseState(j.ce_prev_close);
          if (j.pe_prev_close !== undefined) setPePrevCloseState(j.pe_prev_close);
        } else if (!silent) {
          setCandleError(j.error ?? 'No candle data returned');
        }
      })
      .catch(e => {
        if (!silent) setCandleError(String(e));
      })
      .finally(() => {
        if (!silent) setCandleLoading(false);
      });
  }, []);

  // Fetch candles whenever strike, expiry, interval or downloaded data changes
  // and the bridge is not live. Runs once on Multi-Strike too: it tells that
  // view whether the series is today's (candleIsToday gates its own polling).
  useEffect(() => {
    if (isLive) return;
    if (!selectedStrike || !expiry) return;
    fetchCandles(selectedStrike, expiry, candleInterval);
  }, [selectedStrike, expiry, candleInterval, isLive, dataVersion, fetchCandles]);

  // Poll candle data when not live and viewing today's data
  useEffect(() => {
    if (isLive || !usesCandles) return;
    if (!selectedStrike || !expiry || !candleIsToday) return;

    const ms = parseInt(candleInterval, 10) * 60_000;
    const intervalId = setInterval(() => {
      fetchCandles(selectedStrike, expiry, candleInterval, true);
    }, ms);

    return () => clearInterval(intervalId);
  }, [selectedStrike, expiry, candleInterval, isLive, usesCandles, candleIsToday, fetchCandles]);

  // Seed live chart with today's 1-min candles from 9:15 AM when bridge is running.
  // Refreshes every 60 s (matching server-side cache TTL) so newly closed 1-min
  // candles extend the seed base as the session progresses. Before a strike is
  // picked the live ATM is used.
  const seedStrike = selectedStrike ?? quotes?.atm ?? null;
  useEffect(() => {
    if (!isLive || !usesCandles || !seedStrike || !expiry) return;
    let cancelled = false;

    const fetchSeed = () => {
      fetch(`/api/options/candles?expiry=${expiry}&strike=${seedStrike}&interval=1`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: CandleRow[] }) => {
          if (!cancelled && j.success && j.data?.length) setLiveSeedData(j.data);
        })
        .catch(() => {});
    };

    fetchSeed();
    const id = setInterval(fetchSeed, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isLive, usesCandles, seedStrike, expiry]);

  // Poll spot price when bridge is not running (non-live mode). All three
  // views need it: Multi-Strike centres its strikes on the ATM derived here.
  useEffect(() => {
    if (isLive) return;

    const fetchSpot = () => {
      fetch(`/api/options/spot?underlying=${UNDERLYING}`)
        .then(r => r.json())
        .then((s: { success: boolean; spot?: number; change_pct?: number }) => {
          if (s.success && s.spot && s.spot > 0) {
            setChainSpot(s.spot);
            if (s.change_pct !== undefined) setSpotChangePctState(s.change_pct);
          }
        })
        .catch(() => {});
    };

    fetchSpot();
    const intervalId = setInterval(fetchSpot, 10_000);
    return () => clearInterval(intervalId);
  }, [isLive]);

  // ── Derived ───────────────────────────────────────────────────────

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
  const seed = isLive ? liveSeedData : [];
  const lastSeedMins = seed.length > 0
    ? (() => {
        const [hh, mm] = seed[seed.length - 1].time.split(':').map(Number);
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

  const rawChartData = isLive ? [...seed, ...liveChartData] : candleData;

  // Compute cumulative intraday VWAP: Σ(Straddle × Vol) / Σ(Vol) where Vol = CE Vol + PE Vol.
  // Falls back to equal-weight mean (TWAP) when volume is absent (live WebSocket mode).
  const chartData = (() => {
    let cumPV = 0;
    let cumV  = 0;
    return rawChartData.map(row => {
      const vol = (row['CE Vol'] ?? 0) + (row['PE Vol'] ?? 0);
      cumPV += row.Straddle * (vol > 0 ? vol : 1);
      cumV  += vol > 0 ? vol : 1;
      return {
        ...row,
        VWAP: parseFloat((cumPV / cumV).toFixed(2)),
        'OI Diff': (row['PE OI'] ?? 0) - (row['CE OI'] ?? 0),
        PCR: (row['CE OI'] ?? 0) > 0
          ? parseFloat(((row['PE OI'] ?? 0) / (row['CE OI'] ?? 0)).toFixed(3))
          : null,
      };
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
  const pcrLineColor = pcr > 1.3 ? '#34d399' : pcr > 0 && pcr < 0.7 ? '#f87171' : '#facc15';
  const maxPain       = useMemo(() => computeMaxPain(parseStrikeEntries(chainOc)), [chainOc]);

  const spotChangePct = isLive
    ? (quotes?.spot_change_pct ?? null)
    : (spotChangePctState ?? vixData?.niftyChangePct ?? null);

  const wsVix = isLive ? quotes?.vix : undefined;
  const vixLtp  = wsVix ? wsVix.ltp  : vixData?.vix       ?? 0;
  const vixPrev = wsVix ? wsVix.prev_close : vixData?.prevClose ?? 0;
  const vixPct = vixLtp > 0 && vixPrev > 0
    ? ((vixLtp - vixPrev) / vixPrev) * 100 : null;

  const activeCeLtp = isLive ? (liveData?.ce?.ltp ?? 0) : (lastRow?.['CE LTP'] ?? 0);
  const activePeLtp = isLive ? (liveData?.pe?.ltp ?? 0) : (lastRow?.['PE LTP'] ?? 0);

  const ceChangePct = isLive
    ? (liveData?.ce?.change_pct ?? null)
    : (() => {
        const cePrev = cePrevCloseState ?? 0;
        return activeCeLtp > 0 && cePrev > 0 ? ((activeCeLtp - cePrev) / cePrev) * 100 : null;
      })();

  const peChangePct = isLive
    ? (liveData?.pe?.change_pct ?? null)
    : (() => {
        const pePrev = pePrevCloseState ?? 0;
        return activePeLtp > 0 && pePrev > 0 ? ((activePeLtp - pePrev) / pePrev) * 100 : null;
      })();

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
  // Stable Y-axis domain for live data: 3% padding so small movements don't rescale wildly
  const liveDomain: [(v: number) => number, (v: number) => number] = [
    (dataMin: number) => Math.floor(dataMin * 0.97),
    (dataMax: number) => Math.ceil(dataMax * 1.03),
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      {view === 'multistrike' && (
        <OptionsMultiStrikeTab
          expiry={expiry}
          isLive={isLive}
          quotes={quotes}
          history={history}
          candleInterval={candleInterval}
          atm={atm}
          candleIsToday={candleIsToday}
        />
      )}

          {/* Strike selector — premium and pcdiff views */}
          {view !== 'multistrike' && (
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
                <span className="text-xs text-zinc-400 flex items-center gap-2">
                  {expiry ? 'Could not load chain — token expired or rate-limited' : 'Select an expiry first'}
                  {expiry && (
                    <button
                      onClick={() => fetchChain(expiry)}
                      className="px-2 py-1 text-xs font-semibold rounded-lg border border-zinc-700
                                 bg-zinc-900 text-zinc-300 hover:text-white transition-all"
                    >
                      Retry
                    </button>
                  )}
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
              {isLive && bridgeLastUpdate && (
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-400 ml-auto">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  updated {fmtTime(bridgeLastUpdate)}
                </div>
              )}
            </div>
          )}

          {view === 'pcdiff' && (
            <OptionsPCDiffTab
              candles={chartData}
              vixCandles={vixCandles}
              interval={candleInterval}
              isLive={isLive}
              niftyPrice={spot}
              niftyChangePct={spotChangePct}
              vixPrice={vixLtp}
              vixChangePct={vixPct}
              ceChangePct={ceChangePct}
              peChangePct={peChangePct}
            />
          )}

          {view === 'premium' && <>

        {/* Stats — 8 tiles */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-8 gap-3">
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
            {
              label: 'India VIX',
              value: vixLtp > 0 ? fmtNum(vixLtp, 2) : '—',
              sub: vixPct !== null ? `${vixPct >= 0 ? '+' : ''}${vixPct.toFixed(2)}% vs prev` : undefined,
              color: vixPct === null ? 'text-amber-400' : vixPct > 0 ? 'text-red-400' : 'text-emerald-400',
              accent: 'border-amber-500/25',
            },
            { label: 'Max Pain',
              value: maxPain > 0 ? `₹${fmtNum(maxPain)}` : '—',
              sub: "Sellers' sweet spot",
              color: 'text-white', accent: 'border-zinc-700/60' },
          ]).map(({ label, value, color, sub, accent }) => (
            <div key={label} className={`bg-zinc-900/70 border rounded-xl px-3 py-3 ${accent}`}>
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-base font-bold tabular-nums ${color}`}>{value}</p>
              {sub && <p className="text-[10px] text-zinc-400 mt-0.5 font-medium truncate">{sub}</p>}
            </div>
          ))}
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
              {/* VWAP toggle */}
              <button
                onClick={() => setShowVWAP(v => !v)}
                className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all
                  text-yellow-400 border-yellow-500/30 bg-yellow-500/10 ${showVWAP ? 'opacity-100' : 'opacity-35'}`}
              >
                VWAP
              </button>
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
                    axisLine={false} domain={isLive ? liveDomain : ['auto', 'auto']} width={52}
                    tickFormatter={v => fmtNum(v, 0)} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} />
                  <Area type="monotone" dataKey="Straddle" stroke="#10b981" strokeWidth={2.5}
                    fill="url(#gradStraddle)" dot={false} activeDot={{ r: 4, fill: '#10b981', strokeWidth: 0 }} />
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

        {/* CE & PE Premium + OI Diff charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* CE & PE Premium chart */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-white tracking-tight">CE &amp; PE Premium</p>
                  {chartStrike > 0 && (
                    <span className="text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                      {fmtNum(chartStrike)}{chartStrike === atm && atm > 0 ? ' ATM' : ''}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-400 mt-0.5">CE LTP vs PE LTP · NIFTY {expiry || '—'}</p>
              </div>
              {/* CE / PE toggles */}
              <div className="flex items-center gap-1.5">
                {([
                  { key: 'CE', label: 'CE', active: showCELine, toggle: () => setShowCELine(v => !v), color: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
                  { key: 'PE', label: 'PE', active: showPELine, toggle: () => setShowPELine(v => !v), color: 'text-red-400 border-red-500/30 bg-red-500/10'   },
                ] as const).map(({ key, label, active, toggle, color }) => (
                  <button key={key} onClick={toggle}
                    className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${color} ${active ? 'opacity-100' : 'opacity-35'}`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {hasData ? (
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }} tickLine={false}
                    axisLine={false} domain={isLive ? liveDomain : ['auto', 'auto']} width={52}
                    tickFormatter={v => fmtNum(v, 0)} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} />
                  {showCELine && (
                    <Line type="monotone" dataKey="CE LTP" stroke="#60a5fa" strokeWidth={2}
                      dot={false} activeDot={{ r: 4, fill: '#60a5fa', strokeWidth: 0 }} />
                  )}
                  {showPELine && (
                    <Line type="monotone" dataKey="PE LTP" stroke="#f87171" strokeWidth={2}
                      dot={false} activeDot={{ r: 4, fill: '#f87171', strokeWidth: 0 }} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[420px]">
                <p className="text-sm text-zinc-300 font-medium">
                  {candleLoading ? 'Loading candles…' : isLive ? 'Accumulating live ticks…' : 'Select a strike to load chart'}
                </p>
              </div>
            )}
          </div>

          {/* OI Difference chart (CE OI − PE OI) */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-bold text-white tracking-tight">OI Difference (PE − CE)</p>
                  {chartStrike > 0 && (
                    <span className="text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                      {fmtNum(chartStrike)}{chartStrike === atm && atm > 0 ? ' ATM' : ''}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-400 mt-0.5">PE OI − CE OI · +ve = PE heavy · −ve = CE heavy</p>
              </div>
            </div>

            {hasData && hasOiData ? (
              <ResponsiveContainer width="100%" height={420}>
                <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="15%">
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }} tickLine={false}
                    axisLine={false} domain={['auto', 'auto']} width={52} tickFormatter={fmtOI} />
                  <Tooltip {...tooltipProps} />
                  <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} strokeDasharray="4 4" />
                  <Bar dataKey="OI Diff" name="PE OI − CE OI" radius={[2, 2, 0, 0]}>
                    {chartData.map((entry, i) => (
                      <Cell key={i} fill={(entry['OI Diff'] ?? 0) >= 0 ? '#4ade80' : '#f87171'} fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
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
                ) : (
                  <p className="text-sm text-zinc-300 font-medium">Select a strike to load chart</p>
                )}
              </div>
            )}
          </div>

        </div>

        {/* PCR Over Time */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-white tracking-tight">PCR Over Time</p>
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
              <p className="text-[10px] text-zinc-400 mt-0.5">PE OI ÷ CE OI · NIFTY {expiry || '—'}</p>
            </div>
          </div>

          {hasData && hasOiData ? (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, 'auto']}
                  width={40}
                  tickFormatter={v => Number(v).toFixed(2)}
                />
                <Tooltip {...tooltipProps} />
                <ReferenceLine y={1.3} stroke="#34d399" strokeWidth={1} strokeDasharray="5 4"
                  label={{ value: 'Bullish 1.3', position: 'insideTopRight', fontSize: 9, fill: '#34d399' }} />
                <ReferenceLine y={0.7} stroke="#f87171" strokeWidth={1} strokeDasharray="5 4"
                  label={{ value: 'Bearish 0.7', position: 'insideBottomRight', fontSize: 9, fill: '#f87171' }} />
                <Line
                  type="monotone"
                  dataKey="PCR"
                  stroke={pcrLineColor}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  activeDot={{ r: 4, fill: pcrLineColor, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex flex-col items-center justify-center h-[280px] gap-3">
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
              ) : (
                <p className="text-sm text-zinc-300 font-medium">Select a strike to load chart</p>
              )}
            </div>
          )}
        </div>

        {/* IV charts moved to dedicated page */}
        <div className="flex items-center gap-2 py-1">
          <Link href="/iv-charts" className="text-xs text-blue-400 hover:text-blue-300 font-semibold transition-all">
            → View IV Charts (CE IV &amp; PE IV time-series)
          </Link>
        </div>

          </>}
    </>
  );
}
