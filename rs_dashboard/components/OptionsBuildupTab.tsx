'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────

interface ChainSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number; delta?: number; gamma?: number; theta?: number };
}

interface ChainEntry { ce?: ChainSide; pe?: ChainSide; }

type BuildupLabel = 'Long Buildup' | 'Short Buildup' | 'Short Covering' | 'Long Unwinding' | 'Neutral';

interface ParsedStrike {
  strike: number;
  ce: ChainSide;
  pe: ChainSide;
}

interface WallRow {
  rank: number;
  strike: number;
  oi: number;
  oiChgPct: number | null;
  buildup: BuildupLabel;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS     = 30_000;
const WINGS       = 10;
const TOP_N       = 5;

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  if (n === 0) return '—';
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtOIChgPct(current: number, prev: number | undefined): string {
  if (!prev || prev === 0) return '—';
  const pct = ((current - prev) / prev) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

function oiChgPct(current: number, prev: number | undefined): number | null {
  if (!prev || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

function fmtPriceChg(last: number | undefined, prev: number | undefined): string {
  if (!last || !prev) return '—';
  const d = last - prev;
  return (d >= 0 ? '+' : '') + d.toFixed(1);
}

// ─── Classification ───────────────────────────────────────────────

function classifyBuildup(side: ChainSide): BuildupLabel {
  const curOI  = side.oi ?? 0;
  const prevOI = side.previous_oi;
  if (!prevOI || prevOI === 0) return 'Neutral';
  const oiChg    = curOI - prevOI;
  const priceChg = (side.last_price ?? 0) - (side.previous_close_price ?? 0);
  if (oiChg === 0) return 'Neutral';
  if (oiChg > 0 && priceChg >= 0) return 'Long Buildup';
  if (oiChg > 0 && priceChg <  0) return 'Short Buildup';
  if (oiChg < 0 && priceChg >= 0) return 'Short Covering';
  return 'Long Unwinding';
}

// ─── Max Pain ─────────────────────────────────────────────────────

function computeMaxPain(strikes: ParsedStrike[]): number {
  if (!strikes.length) return 0;
  let maxPain = strikes[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of strikes) {
    let payout = 0;
    for (const { strike: s, ce, pe } of strikes) {
      payout += (ce.oi ?? 0) * Math.max(0, K - s);
      payout += (pe.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
}

// ─── Buildup badge ────────────────────────────────────────────────

function BuildupBadge({ label }: { label: BuildupLabel }) {
  if (label === 'Neutral') {
    return <span className="text-[10px] text-zinc-500 font-medium">—</span>;
  }
  const cls =
    label === 'Long Buildup'   ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' :
    label === 'Short Buildup'  ? 'text-red-400     bg-red-500/10     border-red-500/20'     :
    label === 'Short Covering' ? 'text-sky-400     bg-sky-500/10     border-sky-500/20'     :
                                 'text-amber-400   bg-amber-500/10   border-amber-500/20';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  color = 'text-white',
  accent = 'border-zinc-700/60',
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  accent?: string;
}) {
  return (
    <div className={`bg-zinc-900/70 border rounded-xl px-3 py-3 ${accent}`}>
      <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-400 mt-0.5 font-medium truncate">{sub}</p>}
    </div>
  );
}

// ─── OI Change pill ───────────────────────────────────────────────

function OIChgPill({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-zinc-600 text-xs">—</span>;
  const cls = pct > 5 ? 'text-emerald-400' : pct < -5 ? 'text-red-400' : 'text-zinc-400';
  return (
    <span className={`tabular-nums text-xs font-semibold ${cls}`}>
      {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsBuildupTab({ expiry }: { expiry: string }) {
  const [allStrikes, setAllStrikes]   = useState<ParsedStrike[]>([]);
  const [spot, setSpot]               = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, ChainEntry> }; spot: number };
        error?: string;
      };
      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const oc  = json.data.chain.oc;
      const parsed: ParsedStrike[] = Object.entries(oc)
        .map(([key, entry]) => ({ strike: Number(key), entry }))
        .filter(x => !isNaN(x.strike))
        .sort((a, b) => a.strike - b.strike)
        .map(({ strike, entry }) => ({
          strike,
          ce: entry.ce ?? {},
          pe: entry.pe ?? {},
        }));

      setAllStrikes(parsed);
      setSpot(json.data.spot ?? 0);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchChain]);

  // ── Derived computations ─────────────────────────────────────────

  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : 0;

  // ATM±10 visible window
  const atmIdx = atm > 0
    ? allStrikes.reduce((best, { strike }, i) =>
        Math.abs(strike - atm) < Math.abs(allStrikes[best].strike - atm) ? i : best, 0)
    : Math.floor(allStrikes.length / 2);

  const visible = allStrikes.slice(
    Math.max(0, atmIdx - WINGS),
    Math.min(allStrikes.length, atmIdx + WINGS + 1),
  );

  // PCR across all strikes
  const totalCEOI = allStrikes.reduce((s, r) => s + (r.ce.oi ?? 0), 0);
  const totalPEOI = allStrikes.reduce((s, r) => s + (r.pe.oi ?? 0), 0);
  const pcr = totalCEOI > 0 ? totalPEOI / totalCEOI : null;

  // Max pain
  const maxPain = allStrikes.length > 0 ? computeMaxPain(allStrikes) : null;

  // ATM straddle
  const atmRow = visible.find(r => r.strike === atm);
  const atmCELtp = atmRow?.ce.last_price ?? 0;
  const atmPELtp = atmRow?.pe.last_price ?? 0;
  const straddle = atmCELtp + atmPELtp;

  // DTE
  const dte = expiry
    ? Math.ceil((new Date(expiry).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000)
    : null;

  // Top CE OI walls (resistance)
  const topCE: WallRow[] = [...allStrikes]
    .sort((a, b) => (b.ce.oi ?? 0) - (a.ce.oi ?? 0))
    .slice(0, TOP_N)
    .map((r, i) => ({
      rank: i + 1,
      strike: r.strike,
      oi: r.ce.oi ?? 0,
      oiChgPct: oiChgPct(r.ce.oi ?? 0, r.ce.previous_oi),
      buildup: classifyBuildup(r.ce),
    }));

  // Top PE OI walls (support)
  const topPE: WallRow[] = [...allStrikes]
    .sort((a, b) => (b.pe.oi ?? 0) - (a.pe.oi ?? 0))
    .slice(0, TOP_N)
    .map((r, i) => ({
      rank: i + 1,
      strike: r.strike,
      oi: r.pe.oi ?? 0,
      oiChgPct: oiChgPct(r.pe.oi ?? 0, r.pe.previous_oi),
      buildup: classifyBuildup(r.pe),
    }));

  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap';
  const pcrColor = pcr === null ? 'text-white'
    : pcr > 1.3 ? 'text-emerald-400'
    : pcr < 0.7 ? 'text-red-400'
    : 'text-amber-400';

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">

      {/* ── Seller Metrics ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile
          label="Max Pain"
          value={maxPain ? maxPain.toLocaleString('en-IN') : '—'}
          color="text-violet-300"
          accent="border-violet-500/20"
        />
        <StatTile
          label="PCR"
          value={pcr !== null ? pcr.toFixed(2) : '—'}
          sub={pcr !== null ? (pcr > 1.3 ? 'Bullish' : pcr < 0.7 ? 'Bearish' : 'Neutral') : undefined}
          color={pcrColor}
          accent={pcr !== null ? (pcr > 1.3 ? 'border-emerald-500/25' : pcr < 0.7 ? 'border-red-500/25' : 'border-amber-500/25') : 'border-zinc-700/60'}
        />
        <StatTile
          label="ATM Straddle"
          value={straddle > 0 ? `₹${fmtNum(straddle)}` : '—'}
          sub={straddle > 0 ? `CE ₹${fmtNum(atmCELtp)} + PE ₹${fmtNum(atmPELtp)}` : undefined}
          color="text-cyan-300"
          accent="border-cyan-500/20"
        />
        <StatTile
          label="Expected Move ±"
          value={straddle > 0 && spot > 0 ? `₹${straddle.toFixed(0)} (${(straddle / spot * 100).toFixed(1)}%)` : '—'}
          color="text-sky-300"
          accent="border-sky-500/20"
        />
        <StatTile
          label="Breakeven Range"
          value={straddle > 0 && spot > 0 ? `${(spot - straddle).toFixed(0)} – ${(spot + straddle).toFixed(0)}` : '—'}
          color="text-zinc-200"
          accent="border-zinc-700/60"
        />
        <StatTile
          label="DTE"
          value={dte !== null ? `${dte}d` : '—'}
          sub={expiry ?? undefined}
          color={dte !== null && dte <= 1 ? 'text-red-400' : dte !== null && dte <= 3 ? 'text-amber-400' : 'text-zinc-200'}
          accent={dte !== null && dte <= 1 ? 'border-red-500/25' : 'border-zinc-700/60'}
        />
      </div>

      {/* ── Status bar ────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-[10px] text-zinc-500 font-medium">
        {loading && <span className="text-zinc-400 animate-pulse">Refreshing…</span>}
        {lastUpdated && <span>Updated {lastUpdated}</span>}
        <span className="ml-auto">Auto-refresh: 30s</span>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      {/* ── OI Walls ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* PE Walls — Support */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
            <span className="text-sm font-bold text-white">PE Walls</span>
            <span className="text-[10px] font-semibold text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">Support</span>
            <span className="text-[10px] text-zinc-500 ml-auto">Top {TOP_N} by PE OI</span>
          </div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className={`${thCls} text-center w-8`}>#</th>
                <th className={`${thCls} text-center`}>STRIKE</th>
                <th className={`${thCls} text-right`}>PE OI</th>
                <th className={`${thCls} text-right`}>OI CHG%</th>
                <th className={`${thCls} text-center`}>BUILDUP</th>
              </tr>
            </thead>
            <tbody>
              {topPE.map(row => (
                <tr
                  key={row.strike}
                  className={`border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30 ${
                    row.rank === 1 ? 'ring-1 ring-inset ring-red-500/30' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    {row.rank === 1
                      ? <span className="text-red-400 font-bold text-[11px]">1</span>
                      : <span className="text-zinc-500">{row.rank}</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-center font-bold tabular-nums text-zinc-100">
                    {row.strike.toLocaleString('en-IN')}
                    {row.strike < atm && atm > 0 && (
                      <span className="ml-1 text-[9px] text-zinc-500">
                        ({atm - row.strike > 0 ? `-${atm - row.strike}` : ''})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-red-300">
                    {fmtOI(row.oi)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <OIChgPill pct={row.oiChgPct} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <BuildupBadge label={row.buildup} />
                  </td>
                </tr>
              ))}
              {topPE.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-zinc-600">
                    {expiry ? 'No data' : 'Select an expiry'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* CE Walls — Resistance */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
            <span className="text-sm font-bold text-white">CE Walls</span>
            <span className="text-[10px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">Resistance</span>
            <span className="text-[10px] text-zinc-500 ml-auto">Top {TOP_N} by CE OI</span>
          </div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className={`${thCls} text-center w-8`}>#</th>
                <th className={`${thCls} text-center`}>STRIKE</th>
                <th className={`${thCls} text-right`}>CE OI</th>
                <th className={`${thCls} text-right`}>OI CHG%</th>
                <th className={`${thCls} text-center`}>BUILDUP</th>
              </tr>
            </thead>
            <tbody>
              {topCE.map(row => (
                <tr
                  key={row.strike}
                  className={`border-b border-zinc-800/50 transition-colors hover:bg-zinc-800/30 ${
                    row.rank === 1 ? 'ring-1 ring-inset ring-blue-500/30' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    {row.rank === 1
                      ? <span className="text-blue-400 font-bold text-[11px]">1</span>
                      : <span className="text-zinc-500">{row.rank}</span>
                    }
                  </td>
                  <td className="px-3 py-2 text-center font-bold tabular-nums text-zinc-100">
                    {row.strike.toLocaleString('en-IN')}
                    {row.strike > atm && atm > 0 && (
                      <span className="ml-1 text-[9px] text-zinc-500">
                        (+{row.strike - atm})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-blue-300">
                    {fmtOI(row.oi)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <OIChgPill pct={row.oiChgPct} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <BuildupBadge label={row.buildup} />
                  </td>
                </tr>
              ))}
              {topCE.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-zinc-600">
                    {expiry ? 'No data' : 'Select an expiry'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </div>

      {/* ── Buildup Table ─────────────────────────────────────────── */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
          <span className="text-sm font-bold text-white">Buildup Table</span>
          <span className="text-[10px] text-zinc-500">ATM ±{WINGS} strikes · vs prev day</span>
          {atm > 0 && (
            <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 ml-auto">
              ATM {atm.toLocaleString('en-IN')}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                {/* CE side */}
                <th className={`${thCls} text-center text-blue-300`}>CE BUILDUP</th>
                <th className={`${thCls} text-right  text-blue-200`}>LTP CHG</th>
                <th className={`${thCls} text-right  text-blue-200`}>OI CHG%</th>
                <th className={`${thCls} text-right  text-blue-300`}>CE OI</th>
                {/* Center */}
                <th className={`${thCls} text-center text-amber-300 border-x border-zinc-700`}>STRIKE</th>
                {/* PE side */}
                <th className={`${thCls} text-left   text-red-300`}>PE OI</th>
                <th className={`${thCls} text-left   text-red-200`}>OI CHG%</th>
                <th className={`${thCls} text-left   text-red-200`}>LTP CHG</th>
                <th className={`${thCls} text-center text-red-300`}>PE BUILDUP</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => {
                const isATM = row.strike === atm;
                const ceBl  = classifyBuildup(row.ce);
                const peBl  = classifyBuildup(row.pe);
                const ceOI  = row.ce.oi ?? 0;
                const peOI  = row.pe.oi ?? 0;
                const cePct = oiChgPct(ceOI, row.ce.previous_oi);
                const pePct = oiChgPct(peOI, row.pe.previous_oi);

                return (
                  <tr
                    key={row.strike}
                    className={`border-b border-zinc-800/50 last:border-b-0 transition-colors ${
                      isATM
                        ? 'bg-amber-500/10 border-l-2 border-l-amber-400'
                        : 'bg-zinc-950 hover:bg-zinc-900/40'
                    }`}
                  >
                    {/* CE Buildup */}
                    <td className="px-3 py-2 text-center">
                      <BuildupBadge label={ceBl} />
                    </td>

                    {/* CE LTP Chg */}
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold text-xs ${
                      (row.ce.last_price ?? 0) >= (row.ce.previous_close_price ?? 0)
                        ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {fmtPriceChg(row.ce.last_price, row.ce.previous_close_price)}
                    </td>

                    {/* CE OI Chg% */}
                    <td className="px-3 py-2 text-right">
                      <OIChgPill pct={cePct} />
                    </td>

                    {/* CE OI */}
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-blue-300">
                      {ceOI > 0 ? fmtOI(ceOI) : <span className="text-zinc-600">—</span>}
                    </td>

                    {/* Strike */}
                    <td className={`px-4 py-2 text-center font-bold tabular-nums border-x border-zinc-700 ${
                      isATM ? 'text-amber-300 text-sm' : 'text-zinc-100'
                    }`}>
                      {row.strike.toLocaleString('en-IN')}
                      {isATM && <span className="ml-1 text-[10px] text-amber-500">ATM</span>}
                    </td>

                    {/* PE OI */}
                    <td className="px-3 py-2 text-left tabular-nums font-bold text-red-300">
                      {peOI > 0 ? fmtOI(peOI) : <span className="text-zinc-600">—</span>}
                    </td>

                    {/* PE OI Chg% */}
                    <td className="px-3 py-2 text-left">
                      <OIChgPill pct={pePct} />
                    </td>

                    {/* PE LTP Chg */}
                    <td className={`px-3 py-2 text-left tabular-nums font-semibold text-xs ${
                      (row.pe.last_price ?? 0) >= (row.pe.previous_close_price ?? 0)
                        ? 'text-emerald-400' : 'text-red-400'
                    }`}>
                      {fmtPriceChg(row.pe.last_price, row.pe.previous_close_price)}
                    </td>

                    {/* PE Buildup */}
                    <td className="px-3 py-2 text-center">
                      <BuildupBadge label={peBl} />
                    </td>
                  </tr>
                );
              })}

              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center text-zinc-500">
                    {loading
                      ? 'Loading chain data…'
                      : expiry
                        ? 'No chain data available — check auth token'
                        : 'Select an expiry to load buildup data'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-widest">Legend:</span>
        {(['Long Buildup', 'Short Buildup', 'Short Covering', 'Long Unwinding'] as BuildupLabel[]).map(l => (
          <BuildupBadge key={l} label={l} />
        ))}
        <span className="text-[10px] text-zinc-500 ml-2">OI change vs previous day close</span>
      </div>

    </div>
  );
}
