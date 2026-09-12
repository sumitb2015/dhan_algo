'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Filter,
  Flame,
  Layers,
  RefreshCw,
  ShieldAlert,
  Target,
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
  const [showPlaybook, setShowPlaybook] = useState(false);
  const [playbookTab, setPlaybookTab] = useState<'setups' | 'matrix' | 'metrics' | 'checklist'>('setups');

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

          {/* Playbook / Guide Button */}
          <button
            onClick={() => setShowPlaybook(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border transition-colors ${
              showPlaybook
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-700 hover:border-zinc-500'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>Playbook &amp; Guide</span>
            {showPlaybook ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
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

        {/* ── Actionable Playbook & README Drawer ── */}
        {showPlaybook && (
          <div className="rounded-2xl border border-amber-500/30 bg-zinc-900/90 p-5 backdrop-blur shadow-2xl transition-all animate-in fade-in duration-200">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/30">
                  <BookOpen className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h2 className="text-xs font-bold text-white uppercase tracking-wider">
                    Institutional Flow Playbook &amp; Action Guide
                  </h2>
                  <p className="text-[10px] text-zinc-400">
                    How to interpret volume/OI surges, big blocks, and market microstructure into high-probability trades
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {(
                  [
                    { id: 'setups', label: '1. Trading Setups' },
                    { id: 'matrix', label: '2. Sentiment Matrix' },
                    { id: 'metrics', label: '3. Metric Reference' },
                    { id: 'checklist', label: '4. Execution Checklist' },
                  ] as const
                ).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setPlaybookTab(tab.id)}
                    className={`text-xs font-bold px-2.5 py-1 rounded-md transition-colors ${
                      playbookTab === tab.id
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
                <button
                  onClick={() => setShowPlaybook(false)}
                  className="text-xs font-bold text-zinc-400 hover:text-white px-2 py-1 rounded hover:bg-zinc-800"
                >
                  ✕ Close
                </button>
              </div>
            </div>

            {/* Tab 1: Trading Setups */}
            {playbookTab === 'setups' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
                {/* Setup A: Institutional Breakout */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold mb-1">
                      <Target className="w-3.5 h-3.5" />
                      <span>SETUP A: MOMENTUM BREAKOUT</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 block mb-2">Directional trend continuation</span>
                    <ul className="text-zinc-300 font-sans text-[11px] space-y-1.5 leading-relaxed">
                      <li>
                        <strong className="text-zinc-100">Trigger:</strong> OTM Call (100–200 pts above spot) exhibits <span className="text-amber-400 font-mono font-bold">Vol/OI &ge; 2.0x</span> and turnover &gt; ₹100 Cr with <span className="text-emerald-400 font-mono font-bold">LONG_BUILDUP</span>.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Confirmation:</strong> Simultaneous <span className="text-emerald-400 font-mono">SHORT_BUILDUP</span> on Puts below spot (put writers creating support floor).
                      </li>
                      <li>
                        <strong className="text-zinc-100">Action:</strong> Buy ATM Bull Call Spread or Long Future.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Stop Loss:</strong> Exit if index breaks below the highest Put OI strike.
                      </li>
                    </ul>
                  </div>
                  <div className="mt-3 pt-2 border-t border-zinc-800/80 text-[10px] text-emerald-400 font-bold">
                    Target: Next major Call open interest wall
                  </div>
                </div>

                {/* Setup B: Iron Put Support Floor */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-sky-400 font-bold mb-1">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>SETUP B: IRON PUT FLOOR</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 block mb-2">Credit selling &amp; dip buying</span>
                    <ul className="text-zinc-300 font-sans text-[11px] space-y-1.5 leading-relaxed">
                      <li>
                        <strong className="text-zinc-100">Trigger:</strong> Heavy Put <span className="text-sky-400 font-mono font-bold">SHORT_BUILDUP</span> at a round strike (e.g. 23300 PE) with multiple multi-crore turnover blocks.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Confirmation:</strong> Net Flow Bias is Bullish, and <span className="text-zinc-200 font-mono font-bold">PCR (OI) &ge; 1.15</span>.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Action:</strong> Sell Put Credit Spread (Bull Put Spread) with the short strike at the buildup level.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Rule:</strong> Avoid buying naked puts when institutional put writing is dominant.
                      </li>
                    </ul>
                  </div>
                  <div className="mt-3 pt-2 border-t border-zinc-800/80 text-[10px] text-sky-400 font-bold">
                    Target: 70–80% premium decay into expiry
                  </div>
                </div>

                {/* Setup C: Short Squeeze Panic */}
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3.5 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-amber-400 font-bold mb-1">
                      <Zap className="w-3.5 h-3.5" />
                      <span>SETUP C: SHORT SQUEEZE PANIC</span>
                    </div>
                    <span className="text-[10px] text-zinc-500 block mb-2">Fast explosive momentum bursts</span>
                    <ul className="text-zinc-300 font-sans text-[11px] space-y-1.5 leading-relaxed">
                      <li>
                        <strong className="text-zinc-100">Trigger:</strong> A heavy Call OI resistance strike shows negative OI change (<span className="text-red-400 font-mono font-bold">&Delta;OI &lt; 0</span>) and <span className="text-sky-400 font-mono font-bold">SHORT_COVERING</span>.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Market Context:</strong> Spot price pushes through the strike while Call writers are forced to buy back shorts to stop runaway losses.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Action:</strong> Fast scalp long on the breakout candle.
                      </li>
                      <li>
                        <strong className="text-zinc-100">Discipline:</strong> Trail tight stop; exit quickly once covering exhaustion volume tapers.
                      </li>
                    </ul>
                  </div>
                  <div className="mt-3 pt-2 border-t border-zinc-800/80 text-[10px] text-amber-400 font-bold">
                    Target: Rapid 50–100 pt index squeeze burst
                  </div>
                </div>
              </div>
            )}

            {/* Tab 2: Sentiment Matrix */}
            {playbookTab === 'matrix' && (
              <div className="space-y-3 text-xs">
                <p className="text-zinc-300 font-sans text-[11px]">
                  Institutional positioning is decoded via the 4-quadrant relationship between <strong>Price Change (&Delta;P)</strong> and <strong>Open Interest Change (&Delta;OI)</strong>:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Call Matrix */}
                  <div className="rounded-xl border border-sky-500/25 bg-zinc-950/70 p-3">
                    <span className="text-sky-400 font-bold font-mono text-[11px] block mb-2">CALL (CE) DYNAMICS</span>
                    <div className="space-y-2">
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-emerald-400">Long Buildup (&Delta;P &gt; 0, &Delta;OI &gt; 0)</span>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase">Bullish</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Aggressive buyers entering fresh long calls. Expects upward rally.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-red-400">Short Buildup (&Delta;P &lt; 0, &Delta;OI &gt; 0)</span>
                          <span className="text-[10px] font-bold text-red-400 uppercase">Bearish</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Call writers shorting contracts. Creates an institutional resistance ceiling.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-sky-400">Short Covering (&Delta;P &gt; 0, &Delta;OI &lt; 0)</span>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase">Bullish Squeeze</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Trapped call sellers covering shorts, amplifying upward momentum.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-amber-400">Long Unwinding (&Delta;P &lt; 0, &Delta;OI &lt; 0)</span>
                          <span className="text-[10px] font-bold text-red-400 uppercase">Bearish Fade</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Call buyers liquidating losing positions. Upward momentum is dying.</p>
                      </div>
                    </div>
                  </div>

                  {/* Put Matrix */}
                  <div className="rounded-xl border border-amber-500/25 bg-zinc-950/70 p-3">
                    <span className="text-amber-400 font-bold font-mono text-[11px] block mb-2">PUT (PE) DYNAMICS</span>
                    <div className="space-y-2">
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-red-400">Long Buildup (&Delta;P &gt; 0, &Delta;OI &gt; 0)</span>
                          <span className="text-[10px] font-bold text-red-400 uppercase">Bearish</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Aggressive put buying for market downside or portfolio crash hedging.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-emerald-400">Short Buildup (&Delta;P &lt; 0, &Delta;OI &gt; 0)</span>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase">Bullish Support</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Institutions writing puts. Absorbing downside risk and creating strong support floors.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-red-400">Short Covering (&Delta;P &gt; 0, &Delta;OI &lt; 0)</span>
                          <span className="text-[10px] font-bold text-red-400 uppercase">Bearish Drop</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Put sellers in panic, closing short puts as market breaches support.</p>
                      </div>
                      <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="font-bold text-emerald-400">Long Unwinding (&Delta;P &lt; 0, &Delta;OI &lt; 0)</span>
                          <span className="text-[10px] font-bold text-emerald-400 uppercase">Bullish Rally</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 font-sans">Put buyers taking profit or cutting losses as market rebounds higher.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Metric Cheat Sheet */}
            {playbookTab === 'metrics' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800">
                  <span className="text-amber-400 font-mono font-bold block mb-1">1. VOL / OI RATIO</span>
                  <p className="text-zinc-300 font-sans text-[11px] leading-relaxed mb-2">
                    Measures the velocity of contract trading relative to resting open interest.
                  </p>
                  <ul className="text-zinc-400 font-sans text-[10px] space-y-1">
                    <li><strong className="text-zinc-200">&lt; 0.8x:</strong> Passive trading; normal retail liquidity.</li>
                    <li><strong className="text-emerald-300">1.2x – 2.5x:</strong> Significant fresh institutional activity.</li>
                    <li><strong className="text-amber-300">&gt; 3.0x:</strong> Extreme unusual flow; explosive directional bias.</li>
                  </ul>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800">
                  <span className="text-sky-400 font-mono font-bold block mb-1">2. PREMIUM TURNOVER (₹ CR)</span>
                  <p className="text-zinc-300 font-sans text-[11px] leading-relaxed mb-2">
                    Calculated as <code className="text-zinc-200">(Volume &times; LTP) / 10,000,000</code>. Reflects real monetary commitment.
                  </p>
                  <ul className="text-zinc-400 font-sans text-[10px] space-y-1">
                    <li>Filters out misleading volume spikes on deep OTM ₹0.50 lottery options.</li>
                    <li>Turnover &ge; ₹5 Cr (Index) or &ge; ₹1 Cr (Stock) highlights high-conviction institutional blocks.</li>
                  </ul>
                </div>

                <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800">
                  <span className="text-purple-400 font-mono font-bold block mb-1">3. PUT-CALL RATIO (PCR)</span>
                  <p className="text-zinc-300 font-sans text-[11px] leading-relaxed mb-2">
                    Compares total PE vs CE exposure across Open Interest and Volume.
                  </p>
                  <ul className="text-zinc-400 font-sans text-[10px] space-y-1">
                    <li><strong className="text-emerald-300">PCR(OI) &ge; 1.20:</strong> Heavy put writing; bullish support floor.</li>
                    <li><strong className="text-red-300">PCR(OI) &le; 0.80:</strong> Heavy call writing; bearish resistance ceiling.</li>
                    <li><strong className="text-amber-300">Divergence:</strong> PCR(Vol) surging while PCR(OI) is low signals smart money front-running an OI flip.</li>
                  </ul>
                </div>
              </div>
            )}

            {/* Tab 4: Execution Checklist */}
            {playbookTab === 'checklist' && (
              <div className="p-4 rounded-xl bg-zinc-950/70 border border-zinc-800 text-xs font-sans">
                <span className="text-amber-400 font-mono font-bold block mb-2">
                  THE 4-STEP PRE-ORDER EXECUTION CHECKLIST
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="font-bold text-zinc-100 font-mono block mb-1">STEP 1: ALIGN BIAS</span>
                    <p className="text-zinc-400">Ensure the alert matches the aggregate Net Flow Bias (Bullish vs Bearish) and PCR structure.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="font-bold text-zinc-100 font-mono block mb-1">STEP 2: VERIFY REAL TURNOVER</span>
                    <p className="text-zinc-400">Verify Turnover &gt; ₹5 Cr. Never risk capital on low-turnover illiquid OTM penny spikes.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="font-bold text-zinc-100 font-mono block mb-1">STEP 3: CHECK SPOT DISTANCE</span>
                    <p className="text-zinc-400">Focus on strikes within 0.5%–1.5% of Spot price. Far OTM strikes suffer from heavy theta decay.</p>
                  </div>
                  <div className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="font-bold text-zinc-100 font-mono block mb-1">STEP 4: DEFINE INVALIDATION</span>
                    <p className="text-zinc-400">Anchor your stop loss at the nearest heavy Put/Call OI wall before entering the order.</p>
                  </div>
                </div>
              </div>
            )}
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
