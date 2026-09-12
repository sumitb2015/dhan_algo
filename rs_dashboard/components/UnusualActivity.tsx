'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Filter,
  Flame,
  Layers,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';

interface FlowAlert {
  strike: number;
  type: 'CE' | 'PE';
  ltp: number;
  change_pct: number;
  volume: number;
  oi: number;
  oi_change: number;
  oi_change_pct: number;
  vol_oi_ratio: number;
  turnover_cr: number;
  iv: number;
  delta: number;
  theta: number;
  gamma: number;
  vega: number;
  sentiment: string;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  reasons: string[];
  spot_distance: number;
}

interface ScanData {
  success: boolean;
  underlying: string;
  spot: number;
  lot_size: number;
  expiry: string;
  expiries: string[];
  summary: {
    net_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    pcr_oi: number;
    pcr_vol: number;
    total_ce_turnover_cr: number;
    total_pe_turnover_cr: number;
    total_ce_oi: number;
    total_pe_oi: number;
    total_ce_oi_change: number;
    total_pe_oi_change: number;
    bullish_alert_turnover_cr: number;
    bearish_alert_turnover_cr: number;
    total_alerts: number;
  };
  alerts: FlowAlert[];
  flows: FlowAlert[];
  error?: string;
}

const UNDERLYING_OPTIONS = [
  { label: 'NIFTY 50', value: 'NIFTY' },
  { label: 'BANKNIFTY', value: 'BANKNIFTY' },
  { label: 'FINNIFTY', value: 'FINNIFTY' },
  { label: 'SENSEX', value: 'SENSEX' },
  { label: 'RELIANCE', value: 'RELIANCE' },
  { label: 'HDFCBANK', value: 'HDFCBANK' },
  { label: 'INFY', value: 'INFY' },
  { label: 'ICICIBANK', value: 'ICICIBANK' },
  { label: 'TCS', value: 'TCS' },
];

function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

function fmtCr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} Cr`;
}

function getSentimentBadge(sentiment: string) {
  switch (sentiment) {
    case 'LONG_BUILDUP':
      return { label: 'Long Buildup', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' };
    case 'SHORT_COVERING':
      return { label: 'Short Covering', cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30' };
    case 'SHORT_BUILDUP':
      return { label: 'Short Buildup', cls: 'bg-red-500/15 text-red-400 border-red-500/30' };
    case 'LONG_UNWINDING':
      return { label: 'Long Unwinding', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' };
    default:
      return { label: 'Neutral', cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
  }
}

export default function UnusualActivity() {
  const [underlying, setUnderlying] = useState('NIFTY');
  const [expiry, setExpiry] = useState('');
  const [data, setData] = useState<ScanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterTab, setFilterTab] = useState<'all' | 'high_ratio' | 'oi_spike' | 'blocks' | 'bullish' | 'bearish'>('all');
  const [searchStrike, setSearchStrike] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchData = useCallback(async (und = underlying, exp = expiry) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/options/unusual-activity?underlying=${und}${exp ? `&expiry=${exp}` : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok || json.success === false) {
        throw new Error(json.error || 'Failed to scan options activity');
      }
      setData(json);
      if (!exp && json.expiry) {
        setExpiry(json.expiry);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [underlying, expiry]);

  useEffect(() => {
    fetchData(underlying, expiry);
  }, [underlying, expiry, fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchData(underlying, expiry);
    }, 15_000);
    return () => clearInterval(interval);
  }, [autoRefresh, underlying, expiry, fetchData]);

  const filteredAlerts = useMemo(() => {
    if (!data?.alerts) return [];
    return data.alerts.filter(item => {
      if (searchStrike && !item.strike.toString().includes(searchStrike)) return false;
      if (filterTab === 'high_ratio') return item.vol_oi_ratio >= 1.2;
      if (filterTab === 'oi_spike') return Math.abs(item.oi_change) >= 100_000;
      if (filterTab === 'blocks') return item.turnover_cr >= 5;
      if (filterTab === 'bullish') return item.bias === 'BULLISH';
      if (filterTab === 'bearish') return item.bias === 'BEARISH';
      return true;
    });
  }, [data?.alerts, filterTab, searchStrike]);

  const sum = data?.summary;

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-white">
      {/* ── Sticky Top Header ── */}
      <div className="shrink-0 z-40 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/25 shrink-0">
            <Flame className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-amber-500 uppercase tracking-[0.18em] mb-0.5">
              Flow Intelligence · Unusual Options
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Institutional Options & Volume Flow Scanner
            </h1>
          </div>
        </div>

        {/* Selectors & Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Underlying Selector */}
          <select
            value={underlying}
            onChange={e => {
              setUnderlying(e.target.value);
              setExpiry('');
            }}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1 text-xs text-zinc-100 font-bold focus:outline-none focus:border-amber-500"
          >
            {UNDERLYING_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Expiry Selector */}
          {data?.expiries && data.expiries.length > 0 && (
            <select
              value={expiry || data.expiry}
              onChange={e => setExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1 text-xs text-zinc-100 font-mono focus:outline-none focus:border-amber-500"
            >
              {data.expiries.map(exp => (
                <option key={exp} value={exp}>{exp}</option>
              ))}
            </select>
          )}

          {/* Spot Display */}
          {data?.spot ? (
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-200">
              SPOT: {data.spot.toFixed(2)}
            </span>
          ) : null}

          {/* Auto Refresh Toggle */}
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border font-bold transition-colors ${
              autoRefresh
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-zinc-200'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoRefresh ? 'bg-amber-400 animate-pulse' : 'bg-zinc-600'}`} />
            Auto-15s
          </button>

          {/* Manual Refresh Button */}
          <button
            onClick={() => fetchData(underlying, expiry)}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 hover:border-zinc-500 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-amber-400' : ''}`} />
            Refresh
          </button>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {/* ── Main Content Area ── */}
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
        {/* KPI Ribbon */}
        {sum && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {/* Net Bias */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Net Flow Bias</span>
              <div className="flex items-center gap-1.5">
                {sum.net_bias === 'BULLISH' ? (
                  <>
                    <TrendingUp className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-bold text-emerald-400 font-mono tracking-tight">BULLISH FLOW</span>
                  </>
                ) : sum.net_bias === 'BEARISH' ? (
                  <>
                    <TrendingDown className="w-4 h-4 text-red-400" />
                    <span className="text-sm font-bold text-red-400 font-mono tracking-tight">BEARISH FLOW</span>
                  </>
                ) : (
                  <>
                    <Layers className="w-4 h-4 text-zinc-400" />
                    <span className="text-sm font-bold text-zinc-300 font-mono tracking-tight">BALANCED</span>
                  </>
                )}
              </div>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                {fmtCr(sum.bullish_alert_turnover_cr)} Bull vs {fmtCr(sum.bearish_alert_turnover_cr)} Bear
              </span>
            </div>

            {/* PCR Ratio */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">PCR (OI / Volume)</span>
              <div className="text-sm font-mono font-bold text-zinc-100">
                {sum.pcr_oi.toFixed(2)} <span className="text-zinc-500 text-xs font-normal">OI</span> · {sum.pcr_vol.toFixed(2)} <span className="text-zinc-500 text-xs font-normal">Vol</span>
              </div>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                {sum.pcr_oi >= 1.2 ? 'Strong Put Support' : sum.pcr_oi <= 0.8 ? 'Call Resistance Heavy' : 'Neutral Range'}
              </span>
            </div>

            {/* Total CE Turnover */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-sky-400 uppercase tracking-wider block mb-1">Call Premium Turnover</span>
              <div className="text-sm font-mono font-bold text-sky-300">{fmtCr(sum.total_ce_turnover_cr)}</div>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                OI Δ {sum.total_ce_oi_change >= 0 ? '+' : ''}{fmtNum(sum.total_ce_oi_change)} contracts
              </span>
            </div>

            {/* Total PE Turnover */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider block mb-1">Put Premium Turnover</span>
              <div className="text-sm font-mono font-bold text-amber-300">{fmtCr(sum.total_pe_turnover_cr)}</div>
              <span className="text-[10px] text-zinc-500 mt-1 block">
                OI Δ {sum.total_pe_oi_change >= 0 ? '+' : ''}{fmtNum(sum.total_pe_oi_change)} contracts
              </span>
            </div>

            {/* Total Alerts Triggered */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Unusual Flow Triggers</span>
              <div className="text-sm font-mono font-bold text-amber-400">{sum.total_alerts}</div>
              <span className="text-[10px] text-zinc-500 mt-1 block">Institutional Volume & OI spikes</span>
            </div>

            {/* Lot Size & Expiry */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3">
              <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Contract Spec</span>
              <div className="text-sm font-mono font-bold text-zinc-200">Lot: {data?.lot_size}</div>
              <span className="text-[10px] text-zinc-500 mt-1 block">Expiry: {data?.expiry}</span>
            </div>
          </div>
        )}

        {/* Filter Toolbar */}
        <div className="flex items-center justify-between gap-3 flex-wrap bg-zinc-900/40 border border-zinc-800/80 rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mr-2 flex items-center gap-1">
              <Filter className="w-3 h-3" /> View:
            </span>
            {(
              [
                { id: 'all', label: 'All Alerts' },
                { id: 'high_ratio', label: 'High Vol/OI (≥1.2x)' },
                { id: 'oi_spike', label: 'OI Spikes (≥100k)' },
                { id: 'blocks', label: 'Large Blocks (≥₹5 Cr)' },
                { id: 'bullish', label: 'Bullish Flow' },
                { id: 'bearish', label: 'Bearish Flow' },
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                onClick={() => setFilterTab(tab.id)}
                className={`text-xs font-bold px-2.5 py-1 rounded-md transition-colors ${
                  filterTab === tab.id
                    ? 'bg-zinc-700 text-oncolor'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search strike..."
              value={searchStrike}
              onChange={e => setSearchStrike(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500 w-32"
            />
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Table of Alerts */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex-1">
          <div className="overflow-x-auto">
            <table className="w-full text-xs whitespace-nowrap">
              <thead>
                <tr className="bg-zinc-800">
                  <th className="text-xs font-bold text-white text-left px-3 py-2.5">Type</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">Strike</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">Offset</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">LTP (₹)</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">Chg %</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5 border-l border-zinc-700">Volume</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">Open Int</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">OI Change</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5">Vol / OI</th>
                  <th className="text-xs font-bold text-white text-right px-3 py-2.5 border-l border-zinc-700">Turnover</th>
                  <th className="text-xs font-bold text-white text-center px-3 py-2.5">Sentiment</th>
                  <th className="text-xs font-bold text-white text-center px-3 py-2.5">Flow Bias</th>
                  <th className="text-xs font-bold text-white text-left px-3 py-2.5">Alert Triggers</th>
                </tr>
              </thead>
              <tbody>
                {filteredAlerts.length === 0 && !loading && (
                  <tr>
                    <td colSpan={13} className="text-center py-12 text-zinc-500 text-xs">
                      No unusual options flow triggers found for current filter.
                    </td>
                  </tr>
                )}
                {filteredAlerts.map((item, idx) => {
                  const isCall = item.type === 'CE';
                  const rowBg = idx % 2 === 0 ? '' : 'bg-zinc-950/40';
                  const sentiment = getSentimentBadge(item.sentiment);
                  const isBull = item.bias === 'BULLISH';
                  const isBear = item.bias === 'BEARISH';

                  return (
                    <tr key={`${item.strike}-${item.type}`} className={`border-t border-zinc-800 ${rowBg} hover:bg-zinc-800/30 transition-colors`}>
                      {/* Option Type */}
                      <td className="px-3 py-2 font-bold">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${
                          isCall
                            ? 'bg-sky-500/15 text-sky-400 border-sky-500/30'
                            : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                        }`}>
                          {item.type}
                        </span>
                      </td>

                      {/* Strike */}
                      <td className="px-3 py-2 text-right font-mono font-bold text-zinc-100">
                        {fmtNum(item.strike)}
                      </td>

                      {/* Offset from spot */}
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-zinc-400">
                        {item.spot_distance >= 0 ? `+${item.spot_distance}` : item.spot_distance}
                      </td>

                      {/* LTP */}
                      <td className="px-3 py-2 text-right font-mono font-bold text-zinc-200">
                        {item.ltp.toFixed(2)}
                      </td>

                      {/* Chg % */}
                      <td className={`px-3 py-2 text-right font-mono font-bold ${
                        item.change_pct > 0 ? 'text-emerald-400' : item.change_pct < 0 ? 'text-red-400' : 'text-zinc-400'
                      }`}>
                        {item.change_pct >= 0 ? '+' : ''}{item.change_pct.toFixed(1)}%
                      </td>

                      {/* Volume */}
                      <td className="px-3 py-2 text-right font-mono text-zinc-200 border-l border-zinc-800">
                        {fmtNum(item.volume)}
                      </td>

                      {/* OI */}
                      <td className="px-3 py-2 text-right font-mono text-zinc-300">
                        {fmtNum(item.oi)}
                      </td>

                      {/* OI Change */}
                      <td className={`px-3 py-2 text-right font-mono font-bold ${
                        item.oi_change > 0 ? 'text-emerald-400' : item.oi_change < 0 ? 'text-red-400' : 'text-zinc-400'
                      }`}>
                        {item.oi_change > 0 ? '+' : ''}{fmtNum(item.oi_change)}
                      </td>

                      {/* Vol / OI Ratio */}
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] ${
                          item.vol_oi_ratio >= 1.5
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : item.vol_oi_ratio >= 1.0
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : 'text-zinc-400'
                        }`}>
                          {item.vol_oi_ratio.toFixed(2)}x
                        </span>
                      </td>

                      {/* Turnover */}
                      <td className="px-3 py-2 text-right font-mono font-bold text-zinc-100 border-l border-zinc-800">
                        {fmtCr(item.turnover_cr)}
                      </td>

                      {/* Sentiment */}
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border ${sentiment.cls}`}>
                          {sentiment.label}
                        </span>
                      </td>

                      {/* Flow Bias */}
                      <td className="px-3 py-2 text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${
                          isBull
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : isBear
                            ? 'bg-red-500/15 text-red-400 border-red-500/30'
                            : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}>
                          {isBull ? <ArrowUpRight className="w-3 h-3" /> : isBear ? <ArrowDownRight className="w-3 h-3" /> : null}
                          {item.bias}
                        </span>
                      </td>

                      {/* Alert Triggers */}
                      <td className="px-3 py-2 text-left">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {item.reasons.map((r, ri) => (
                            <span key={ri} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                              {r}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
