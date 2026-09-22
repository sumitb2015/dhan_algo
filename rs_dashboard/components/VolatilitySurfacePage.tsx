'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  Sliders,
  Layers,
  Sparkles,
  Info,
  ShieldAlert,
  Calendar,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import VolSurfaceScene from '@/components/vol-surface/VolSurfaceScene';
import TermStructureChart from '@/components/vol-surface/TermStructureChart';
import VolMetricsStrip from '@/components/vol-surface/VolMetricsStrip';
import type { VolSurfaceData } from '@/app/api/options/volatility-surface/route';
import {
  type XAxisMode,
  type VolMetric,
  type ColorScale,
} from '@/lib/volatilitySurface';
import { lastSessionDate } from '@/lib/optionScatter3d';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'] as const;

export default function VolatilitySurfacePage() {
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [count, setCount] = useState<number>(5);
  const [windowPct, setWindowPct] = useState<number>(8.0);
  const [xAxisMode, setXAxisMode] = useState<XAxisMode>('strike');
  const [volMetric, setVolMetric] = useState<VolMetric>('composite');
  const [colorScale, setColorScale] = useState<ColorScale>('Bloomberg');

  const [data, setData] = useState<VolSurfaceData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchTime, setLastFetchTime] = useState<number>(Date.now());
  const [staleWarning, setStaleWarning] = useState<string | null>(null);

  const fetchData = useCallback(
    async (isRefresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/options/volatility-surface?underlying=${underlying}&count=${count}&window_pct=${windowPct}`
        );
        const json = await res.json();
        if (json.success && json.data) {
          setData(json.data);
          setLastFetchTime(Date.now());
          if (json.fallback) {
            setStaleWarning(
              json.paramsMismatch
                ? 'Live data unavailable — showing a cached snapshot from a different Tenors/Strike Window setting. Adjust and refresh once the feed recovers.'
                : 'Live data unavailable — showing the last cached snapshot for these settings.'
            );
          } else {
            setStaleWarning(null);
          }
        } else {
          setError(json.error || 'Failed to load volatility surface');
        }
      } catch (err: unknown) {
        setError(`Network error: ${String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [underlying, count, windowPct]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const session = lastSessionDate();
  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const isLive = session === todayIst;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white w-full min-w-0">
      <NavBar />

      {/* Sticky Header */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-4 sm:px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur w-full">
        <div className="flex items-center gap-3">
          <Link
            href="/options"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Back to Options Analysis"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path
                d="M3 17l6-6 4 4 8-8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M17 7h4v4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M3 21h18"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                Options Analysis · {underlying}
              </p>
              {data && (
                <span className="text-[10px] font-mono font-bold text-emerald-400">
                  ₹{data.spot.toFixed(2)}
                </span>
              )}
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none mt-0.5">
              3D Implied Volatility Surface
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Smile, Skew &amp; Term Structure across strikes and expiration tenors (Black-76 model)
            </p>
          </div>
        </div>

        {/* Right Header Status & Underlyings */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-[10px] font-mono tabular-nums text-amber-300 font-bold uppercase tracking-wide bg-amber-500/10 border border-amber-500/25 px-2 py-0.5 rounded">
            DATA: {session}
            {isLive ? '' : ' · last session'}
          </span>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />

          {/* Underlying Selection */}
          <select
            value={underlying}
            onChange={(e) => setUnderlying(e.target.value)}
            className="text-xs font-bold bg-zinc-900 border border-zinc-700 text-white rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 transition-colors cursor-pointer"
          >
            {UNDERLYINGS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => fetchData(true)}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors shadow-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? 'Fetching…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Control Strip */}
      <div className="px-4 sm:px-6 py-2.5 border-b border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-4 flex-wrap">
          {/* X Axis Control */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 font-medium text-[11px]">X-Axis:</span>
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              {(['strike', 'moneyness', 'delta'] as XAxisMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setXAxisMode(mode)}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                    xAxisMode === mode
                      ? 'bg-emerald-600 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {mode === 'strike' ? 'Strike (₹)' : mode === 'moneyness' ? 'Moneyness %' : 'Delta'}
                </button>
              ))}
            </div>
          </div>

          {/* Volatility Metric Mode */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 font-medium text-[11px]">Metric:</span>
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              {(['composite', 'ce', 'pe'] as VolMetric[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setVolMetric(m)}
                  className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                    volMetric === m
                      ? 'bg-zinc-800 text-white font-bold'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {m === 'composite' ? 'Blended (OTM)' : m === 'ce' ? 'Call IV' : 'Put IV'}
                </button>
              ))}
            </div>
          </div>

          {/* Colorscale */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 font-medium text-[11px]">Palette:</span>
            <select
              value={colorScale}
              onChange={(e) => setColorScale(e.target.value as ColorScale)}
              className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-[11px] rounded px-2 py-1 focus:outline-none"
            >
              <option value="Bloomberg">Bloomberg (RdYlGn)</option>
              <option value="Turbo">Turbo Spectrum</option>
              <option value="Plasma">Plasma</option>
              <option value="Viridis">Viridis</option>
            </select>
          </div>

          {/* Expiry Count & Range */}
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 font-medium text-[11px]">Tenors:</span>
            <select
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value, 10))}
              className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-[11px] rounded px-2 py-1 focus:outline-none"
            >
              <option value={3}>3 Expiries</option>
              <option value={4}>4 Expiries</option>
              <option value={5}>5 Expiries</option>
              <option value={6}>6 Expiries</option>
              <option value={8}>8 Expiries</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-zinc-400 font-medium text-[11px]">Strike Window:</span>
            <select
              value={windowPct}
              onChange={(e) => setWindowPct(parseFloat(e.target.value))}
              className="bg-zinc-900 border border-zinc-800 text-zinc-200 text-[11px] rounded px-2 py-1 focus:outline-none"
            >
              <option value={5.0}>±5% (Tight)</option>
              <option value={8.0}>±8% (Normal)</option>
              <option value={12.0}>±12% (Wide)</option>
              <option value={15.0}>±15% (Ultra-Wide)</option>
            </select>
          </div>
        </div>

        {data && (
          <span className="text-[10px] text-zinc-500 font-mono">
            {data.strikes.length} strikes × {data.expiries.length} expiries ({data.strikes.length * data.expiries.length} surface nodes)
          </span>
        )}
      </div>

      {/* Main Content Area */}
      <div className="p-4 sm:p-6 flex flex-col gap-6 w-full max-w-[1700px] mx-auto">
        {error && (
          <div className="flex items-center gap-2 text-rose-300 bg-rose-950/40 border border-rose-800/80 p-3 rounded-xl text-xs">
            <ShieldAlert className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {!error && staleWarning && (
          <div className="flex items-center gap-2 text-amber-300 bg-amber-950/30 border border-amber-800/60 p-3 rounded-xl text-xs">
            <ShieldAlert className="w-4 h-4 shrink-0 text-amber-400" />
            <span>{staleWarning}</span>
          </div>
        )}

        {/* 3D WebGL Surface Viewport */}
        {data ? (
          <VolSurfaceScene
            data={data}
            xAxisMode={xAxisMode}
            volMetric={volMetric}
            colorScale={colorScale}
          />
        ) : loading ? (
          <div className="h-[620px] w-full rounded-xl border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-zinc-400 font-medium">
              Generating 3D Implied Volatility Surface across {count} expiries…
            </p>
            <p className="text-[11px] text-zinc-500">
              Retrieving option chains, solving Black-76 smiles &amp; interpolating grid
            </p>
          </div>
        ) : null}

        {/* 2D Companion Cross-Sections (Smile & Term Structure) */}
        {data && <TermStructureChart data={data} />}

        {/* Key Metrics & Strategy Matrix Strip */}
        {data && <VolMetricsStrip data={data} />}

        {/* Institutional Guide & Strategy Breakdown */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 sm:p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-emerald-400">
            <Sparkles className="w-4 h-4" />
            <h4 className="text-xs font-bold uppercase tracking-wider text-white">
              Institutional Volatility Guide &amp; Calendar Trading
            </h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-zinc-400 leading-relaxed pt-1">
            <div>
              <span className="font-bold text-white block mb-1">1. The Volatility Smile (Strike Axis)</span>
              Black-Scholes assumes log-normal returns with constant volatility. In real markets, out-of-the-money (OTM) options trade at higher IV due to tail risk (fat tails) and jump risk. On Nifty, OTM puts typically command a steep volatility premium (put skew) reflecting crash-protection hedging.
            </div>

            <div>
              <span className="font-bold text-white block mb-1">2. Term Structure (Tenor Axis)</span>
              The term structure shows ATM volatility across expiration dates. When the market expects an immediate shock (RBI policy, election, earnings), near-term IV spikes above longer-dated IV creating an <strong>inverted curve (Backwardation)</strong>. In calm regimes, the curve slopes upward (<strong>Contango</strong>).
            </div>

            <div>
              <span className="font-bold text-white block mb-1">3. &quot;Buy Front Vol, Sell Back Vol&quot;</span>
              When near-term volatility is depressed relative to back-month volatility (steep Contango) and an impending catalyst is approaching, traders <strong>buy front-month options and sell back-month options</strong> (long calendar/diagonal spread). Conversely, when front vol is blown out post-spike, selling front decay and buying back protection captures mean-reversion.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
