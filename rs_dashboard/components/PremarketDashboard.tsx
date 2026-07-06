'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Sun, Loader2, AlertCircle } from 'lucide-react';
import NavBar from './NavBar';
import type { PremarketData, GlobalMarketItem, CommodityItem, BiasFactor } from '@/app/api/premarket/route';

// ── helpers ────────────────────────────────────────────────────────────
function fmt(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function pctColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}
function pctSign(n: number): string {
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function vixMeta(v: number): { label: string; color: string } {
  if (v < 14)  return { label: 'Low',      color: 'text-emerald-400' };
  if (v <= 18) return { label: 'Moderate', color: 'text-yellow-400'  };
  if (v <= 25) return { label: 'Elevated', color: 'text-orange-400'  };
  return             { label: 'Extreme',   color: 'text-red-400'     };
}
function biasColors(label: string): { text: string; border: string; bg: string } {
  switch (label) {
    case 'Bullish':            return { text: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'bg-emerald-500/5' };
    case 'Cautiously Bullish': return { text: 'text-lime-400',    border: 'border-lime-500/30',    bg: 'bg-lime-500/5'    };
    case 'Neutral':            return { text: 'text-zinc-300',    border: 'border-zinc-600',        bg: 'bg-zinc-800/40'   };
    case 'Cautiously Bearish': return { text: 'text-orange-400',  border: 'border-orange-500/30',  bg: 'bg-orange-500/5'  };
    default:                   return { text: 'text-red-400',     border: 'border-red-500/30',     bg: 'bg-red-500/5'     };
  }
}
function factorDot(dir: BiasFactor['direction']): string {
  return dir === 'positive' ? 'bg-emerald-400' : dir === 'negative' ? 'bg-red-400' : 'bg-zinc-500';
}

// ── primitives ─────────────────────────────────────────────────────────
function StatTile({ label, value, sub, subColor }: { label: string; value: React.ReactNode; sub?: React.ReactNode; subColor?: string }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800 flex flex-col gap-1">
      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className="text-xl font-bold text-zinc-100">{value}</span>
      {sub && <span className={`text-xs ${subColor ?? 'text-zinc-400'}`}>{sub}</span>}
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">{title}</h2>;
}

// ── main component ─────────────────────────────────────────────────────
export default function PremarketDashboard() {
  const [data, setData]       = useState<PremarketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/premarket');
      const json = await res.json() as { success: boolean; data?: PremarketData; error?: string };
      if (!json.success || !json.data) throw new Error(json.error ?? 'Unknown error');
      setData(json.data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const dataDate = data
    ? new Date(data.fetchedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* ── Sticky Header ── */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 shadow">
            <Sun className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-zinc-100 leading-none">Morning Premarket</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Market context before the open</div>
          </div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[10px] font-bold text-zinc-500 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg">
            DATA: {dataDate}
          </span>
          <button
            onClick={fetchData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      {/* ── Loading / Error ── */}
      {loading && (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
          <span className="text-sm text-zinc-500">Fetching premarket data…</span>
        </div>
      )}
      {!loading && error && (
        <div className="flex items-center justify-center h-64 gap-2 text-red-400">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* ── Content ── */}
      {!loading && !error && data && (
        <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

          {/* Section 1 — Market Bias */}
          {(() => {
            const bc = biasColors(data.bias.label);
            return (
              <div className={`rounded-xl border ${bc.border} ${bc.bg} p-5`}>
                <div className="flex items-start justify-between flex-wrap gap-4">
                  <div>
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Market Bias</div>
                    <div className={`text-3xl font-black ${bc.text}`}>{data.bias.label}</div>
                    <div className="text-xs text-zinc-500 mt-1">Score: {data.bias.score > 0 ? '+' : ''}{data.bias.score}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {data.bias.factors.map((f, i) => (
                      <span key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] font-semibold text-zinc-300">
                        <span className={`h-2 w-2 rounded-full ${factorDot(f.direction)}`} />
                        {f.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Section 2 — Nifty Overview */}
          <div>
            <SectionHeader title="Nifty Overview" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile
                label="Nifty Spot"
                value={fmt(data.nifty.spot, 2)}
                sub={`Prev: ${fmt(data.nifty.spotPrevClose, 2)}`}
              />
              <StatTile
                label="Futures Premium"
                value={
                  <span className={data.nifty.futuresPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {data.nifty.futuresPremium >= 0 ? '+' : ''}{fmt(data.nifty.futuresPremium, 2)} pts
                  </span>
                }
                sub={`Fut: ${fmt(data.nifty.futuresLtp, 2)}`}
              />
              <StatTile
                label="Prev Close"
                value={fmt(data.nifty.spotPrevClose, 2)}
                sub={`${pctSign((data.nifty.spot - data.nifty.spotPrevClose) / data.nifty.spotPrevClose * 100)} today`}
                subColor={pctColor((data.nifty.spot - data.nifty.spotPrevClose) / data.nifty.spotPrevClose * 100)}
              />
              <StatTile
                label="Expected Day Range (±1σ)"
                value={`±${fmt(data.nifty.spot * (data.options.atmIV / 100) / 15.87, 0)} pts`}
                sub={`Based on ATM IV ${data.options.atmIV.toFixed(1)}%`}
              />
            </div>
          </div>

          {/* Section 3 — India VIX */}
          <div>
            <SectionHeader title="India VIX" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <StatTile
                label="Current VIX"
                value={
                  <span className={vixMeta(data.vix.vix).color}>
                    {data.vix.vix.toFixed(2)}
                  </span>
                }
                sub={vixMeta(data.vix.vix).label}
                subColor={vixMeta(data.vix.vix).color}
              />
              <StatTile label="VIX Prev Close" value={data.vix.vixPrevClose.toFixed(2)} />
              <StatTile
                label="VIX Change"
                value={<span className={pctColor(data.vix.vixPctChange)}>{pctSign(data.vix.vixPctChange)}</span>}
                sub={data.vix.vixPctChange > 0 ? 'Volatility rising' : data.vix.vixPctChange < 0 ? 'Volatility falling' : 'Unchanged'}
              />
            </div>
          </div>

          {/* Section 4 — ATM IV & OI Levels */}
          <div>
            <SectionHeader title="Options — ATM IV & OI Levels" />
            {data.options.error && !data.options.atmIV ? (
              <div className="text-sm text-zinc-500 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-red-400" />
                Chain unavailable: {data.options.error}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatTile label="ATM IV" value={`${data.options.atmIV.toFixed(2)}%`} sub={`Expiry: ${data.options.expiry ?? ''}`} />
                  <StatTile
                    label="PCR"
                    value={<span className={data.options.pcr > 1.2 ? 'text-emerald-400' : data.options.pcr < 0.8 ? 'text-red-400' : 'text-zinc-100'}>{data.options.pcr.toFixed(3)}</span>}
                    sub={data.options.pcr > 1.2 ? 'Bullish' : data.options.pcr < 0.8 ? 'Bearish' : 'Neutral'}
                    subColor={data.options.pcr > 1.2 ? 'text-emerald-400' : data.options.pcr < 0.8 ? 'text-red-400' : 'text-zinc-400'}
                  />
                  <StatTile label="Max CE OI — Resistance" value={fmt(data.options.maxCeOiStrike, 0)} sub="Call wall (sellers defend)" />
                  <StatTile label="Max PE OI — Support" value={fmt(data.options.maxPeOiStrike, 0)} sub="Put wall (buyers defend)" />
                </div>
                {data.options.chainFetchedAt && (
                  <p className="text-zinc-500 text-[11px] mt-2">
                    Options chain fetched at {new Date(data.options.chainFetchedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} on {new Date(data.options.chainFetchedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Section 5 — Global Markets */}
          <div>
            <SectionHeader title="Global Markets — Previous Close" />
            {!data.globalMarkets ? (
              <p className="text-sm text-zinc-500">Global market data unavailable.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(['US', 'Asia'] as const).map((region) => (
                  <div key={region} className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{region === 'US' ? 'US Markets' : 'Asian Markets'}</div>
                    <div className="space-y-2">
                      {(data.globalMarkets as GlobalMarketItem[]).filter(m => m.region === region).map((m) => (
                        <div key={m.name} className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-zinc-200">{m.name}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-sm text-zinc-100">{m.prevClose.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ${m.pctChange >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                              {pctSign(m.pctChange)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[10px] text-zinc-600 mt-2">Labeled "Previous Close" — US and Asian markets are closed during Indian trading hours.</p>
          </div>

          {/* Section 6 — Commodities */}
          <div>
            <SectionHeader title="MCX Commodities" />
            {data.commodities.length === 0 ? (
              <p className="text-sm text-zinc-500">Commodity data unavailable.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {(data.commodities as CommodityItem[]).map((c) => (
                  <StatTile
                    key={c.name}
                    label={c.name}
                    value={fmt(c.ltp, 2)}
                    sub={pctSign(c.pctChange)}
                    subColor={pctColor(c.pctChange)}
                  />
                ))}
              </div>
            )}
          </div>

        </main>
      )}
    </div>
  );
}
