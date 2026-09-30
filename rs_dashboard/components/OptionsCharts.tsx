'use client';

// Options page shell: expiry, tab bar, header controls, the live-bridge client
// and the historical-download button. Tab content lives in the tab components;
// the bridge-driven views (Premium / PC Diff / Multi-Strike) live in
// OptionsStraddleWorkspace, which is mounted only while one of them is active,
// so their spot/VIX/candle polling stops when another tab is showing.

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Combine, Download } from 'lucide-react';
import NavBar from './NavBar';
import DataChip, { toIsoDate } from './DataChip';
import { cachedFetch } from '@/lib/clientCache';
import { useScriptRefresh } from '@/lib/useScriptRefresh';
import { useOptionsLiveBridge, type BridgeStatus } from '@/lib/useOptionsLiveBridge';
import dynamic from 'next/dynamic';
import type { CandleMeta, StraddleView } from './OptionsStraddleWorkspace';

// Lazy-load tab components so only the active tab's code (recharts-heavy)
// is compiled and shipped; other tabs load on first click.
const TabLoading = () => (
  <div className="h-72 bg-zinc-900/60 border border-zinc-800/60 rounded-xl animate-pulse" />
);
const OptionsSkewTab         = dynamic(() => import('./OptionsSkewTab'), { ssr: false, loading: TabLoading });
const OptionsOITab           = dynamic(() => import('./OptionsOITab'), { ssr: false, loading: TabLoading });
const OptionsCumulativeOITab = dynamic(() => import('./OptionsCumulativeOITab'), { ssr: false, loading: TabLoading });
const OptionsPCRSpotTab      = dynamic(() => import('./OptionsPCRSpotTab'), { ssr: false, loading: TabLoading });
const OptionsSmartChainTab   = dynamic(() => import('./OptionsSmartChainTab'), { ssr: false, loading: TabLoading });
const OptionsIntelligenceTab = dynamic(() => import('./OptionsIntelligenceTab'), { ssr: false, loading: TabLoading });
const OptionsVixTab          = dynamic(() => import('./OptionsVixTab'), { ssr: false, loading: TabLoading });
const OptionsBuildupTab      = dynamic(() => import('./OptionsBuildupTab'), { ssr: false, loading: TabLoading });
const OptionsPositionsTab    = dynamic(() => import('./OptionsPositionsTab'), { ssr: false, loading: TabLoading });
const OptionsPremiumBarTab   = dynamic(() => import('./OptionsPremiumBarTab'), { ssr: false, loading: TabLoading });
const OptionsStraddleWorkspace = dynamic(() => import('./OptionsStraddleWorkspace'), { ssr: false, loading: TabLoading });

// ─── Status badge ─────────────────────────────────────────────────

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

type TabKey = 'premium' | 'premium-bar' | 'skew' | 'oi' | 'cumulative' | 'pcrspot' | 'chain'
  | 'intelligence' | 'vix' | 'buildup' | 'multistrike' | 'pcdiff' | 'positions';

export default function OptionsCharts() {
  const [expiry, setExpiry]     = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiriesLoading, setExpiriesLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('premium');
  const bridgeView: StraddleView | null =
    activeTab === 'premium' || activeTab === 'multistrike' || activeTab === 'pcdiff' ? activeTab : null;
  const isBridgeTab = bridgeView !== null;

  // Header controls for the bridge views, and the strike they chart — kept here
  // so they survive the workspace unmounting while another tab is open.
  const [pollInterval, setPollInterval]     = useState<2 | 5 | 10 | 30>(30);
  const [candleInterval, setCandleInterval] = useState<'1' | '5'>('1');
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [candleMeta, setCandleMeta] = useState<CandleMeta>({ date: null, isToday: true });
  const [dataVersion, setDataVersion] = useState(0);

  const bridge = useOptionsLiveBridge(UNDERLYING, { active: isBridgeTab, pollIntervalSec: pollInterval });
  const isLive = bridge.isLive;
  // Session date of what the bridge views chart: the live snapshot's own
  // timestamp, else the candle series' date (both from the payload).
  const dataDate = isLive ? toIsoDate(bridge.quotes?.updated_at) : toIsoDate(candleMeta.date);

  const onDownloadDone = useCallback(() => setDataVersion(v => v + 1), []);
  const { status: dlStatus, start: startDownload } = useScriptRefresh('/api/options-refresh', onDownloadDone);

  // ── Fetch expiries ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    cachedFetch<{ success: boolean; data?: string[]; error?: string }>(
      `/api/options/expiries?underlying=${UNDERLYING}`, 10 * 60_000,
      (j) => j.success === true && !!j.data?.length)
      .then(j => {
        if (cancelled) return;
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        } else {
          setError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setExpiriesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const changeExpiry = (e: string) => {
    setExpiry(e);
    setSelectedStrike(null); // re-centre on the new expiry's ATM
  };

  // ── Bridge start / stop ───────────────────────────────────────────
  const startBridge = async () => {
    if (!expiry) { setError('Select an expiry first'); return; }
    setError('');
    try {
      await bridge.start(expiry);
    } catch (e) {
      setError(String(e));
    }
  };
  const stopBridge = () => bridge.stop().catch(() => {});

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Combine className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Options · NIFTY</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Nifty Straddle Chart</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              {isLive
                ? 'Live WebSocket · OI & Premium'
                : candleMeta.date && !candleMeta.isToday
                  ? `Historical ${candleInterval}-min candles · ${candleMeta.date}`
                  : `Today's ${candleInterval}-min candles · OI & Premium`}
            </p>
          </div>

          <Link
            href="/options/crudeoil"
            className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Switch to Crude Oil Options →
          </Link>

          <Link
            href="/options/delta"
            className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Net Delta →
          </Link>

        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry */}
          {activeTab !== 'vix' && activeTab !== 'positions' && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-300 font-medium">Expiry</span>
            <select
              value={expiry}
              onChange={e => changeExpiry(e.target.value)}
              disabled={expiriesLoading || isLive}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                         disabled:opacity-50"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          )}

          {/* Candle interval (premium / multi-strike / pcdiff tabs, not live) */}
          {isBridgeTab && !isLive && (
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

          {/* Live poll interval (premium / multi-strike / pcdiff tabs) */}
          {isBridgeTab && isLive && (
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
              {([2, 5, 10, 30] as const).map(s => (
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

          {/* Start / Stop — premium / multi-strike / pcdiff tabs */}
          {isBridgeTab && (
            <button
              onClick={isLive ? stopBridge : startBridge}
              disabled={bridge.busy || !expiry}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all disabled:opacity-50 ${
                isLive
                  ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20'
                  : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
              }`}
            >
              {bridge.busy ? '…' : isLive ? 'Stop' : 'Go Live'}
            </button>
          )}

          {/* Download Options Data Button */}
          {!isLive && (
            <>
              {dlStatus?.running ? (
                <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-sky-400 bg-sky-950/20 border border-sky-500/20 rounded-lg">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                  <span className="font-mono text-[11px] truncate max-w-[160px]" title={dlStatus.message}>
                    {dlStatus.message || 'Downloading…'}
                  </span>
                </div>
              ) : (
                <button
                  onClick={startDownload}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 hover:border-sky-500/35 transition-all"
                  title="Download fresh historical options data (runs download_expired_options.py)"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download Options
                </button>
              )}
            </>
          )}

          {isBridgeTab && <StatusBadge status={bridge.status.status} />}

          <DataChip date={dataDate} lastSession={!isLive && !candleMeta.isToday} />

          <span className="w-px h-5 bg-zinc-800 mx-1 shrink-0" />
          <NavBar />
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
              { key: 'premium',      label: 'Premium'       },
              { key: 'premium-bar',  label: 'Premium Bar'   },
              { key: 'skew',         label: 'Skew'          },
              { key: 'oi',           label: 'Open Interest' },
              { key: 'cumulative',   label: 'Cumulative OI' },
              { key: 'pcrspot',      label: 'PCR vs Spot'   },
              { key: 'chain',        label: 'Smart Chain'   },
              { key: 'intelligence', label: 'Intelligence'  },
              { key: 'vix',          label: 'India VIX'    },
              { key: 'buildup',      label: 'Buildup'      },
              { key: 'multistrike',  label: 'Multi-Strike' },
              { key: 'pcdiff',       label: 'PC Diff'      },
              { key: 'positions',    label: 'Positions'    },
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

          {activeTab === 'premium-bar' && <OptionsPremiumBarTab expiry={expiry} />}
          {activeTab === 'skew'       && <OptionsSkewTab         expiry={expiry} />}
          {activeTab === 'oi'         && <OptionsOITab           expiry={expiry} />}
          {activeTab === 'cumulative' && <OptionsCumulativeOITab expiry={expiry} />}
          {activeTab === 'pcrspot'    && <OptionsPCRSpotTab      expiry={expiry} />}
          {activeTab === 'chain'      && <OptionsSmartChainTab   expiry={expiry} />}
          {activeTab === 'intelligence' && <OptionsIntelligenceTab expiry={expiry} />}
          {activeTab === 'vix'          && <OptionsVixTab />}
          {activeTab === 'positions'    && <OptionsPositionsTab />}
          {activeTab === 'buildup'      && <OptionsBuildupTab expiry={expiry} />}
          {bridgeView && (
            <OptionsStraddleWorkspace
              view={bridgeView}
              expiry={expiry}
              isLive={isLive}
              quotes={bridge.quotes}
              history={bridge.history}
              bridgeLastUpdate={bridge.status.last_update}
              candleInterval={candleInterval}
              selectedStrike={selectedStrike}
              setSelectedStrike={setSelectedStrike}
              dataVersion={dataVersion}
              onCandleMeta={setCandleMeta}
            />
          )}
      </div>
    </div>
  );
}
