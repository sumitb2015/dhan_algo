'use client';

import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import {
  BarChart, Bar, Cell, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const CHAIN_POLL  = 30_000;  // 30 s
const INTEL_POLL  = 60_000;  // 60 s

// ─── Types ────────────────────────────────────────────────────────

interface ChainGreeks { gamma?: number; delta?: number; iv?: number }
interface ChainSide   { last_price?: number; oi?: number; implied_volatility?: number; greeks?: ChainGreeks }
interface ChainEntry  { ce?: ChainSide; pe?: ChainSide }

interface GexProfileEntry { strike: number; net_gex: number; ce_gex: number; pe_gex: number }

interface IntelCurrent {
  net_gex: number; pcr: number; atm_iv: number;
  iv_min: number; iv_max: number; pcr_30min_ago: number | null;
}

interface IntelResponse {
  success: boolean; hasData: boolean; date: string; atm: number; expiry: string;
  current: IntelCurrent | null;
  gex_profile: GexProfileEntry[];
  gex_flip_strike: number | null;
  timeline: Array<{ time: string; ts: number; pcr: number; atm_iv: number; net_gex: number }>;
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtGex(n: number): string {
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '+';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)}L`;
  return `${sign}${abs.toLocaleString('en-IN')}`;
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

// Compute GEX profile from chain API data when no snapshot history.
// `lotSize` is passed in from /api/lotsize (DhanHelper.get_lot_size) rather than
// held as a constant here — GEX scales linearly with it, so a stale literal
// silently skews every strike's number and the flip point derived from them.
function computeGexFromChain(
  oc: Record<string, ChainEntry>, atm: number, spot: number, wings: number, lotSize: number,
): GexProfileEntry[] {
  const wingRange = wings * STRIKE_STEP;
  return Object.entries(oc)
    .map(([key, entry]) => ({ strike: Number(key), entry }))
    .filter(({ strike }) => !isNaN(strike) && Math.abs(strike - atm) <= wingRange)
    .sort((a, b) => a.strike - b.strike)
    .map(({ strike, entry }) => {
      const ceOI    = entry.ce?.oi ?? 0;
      const peOI    = entry.pe?.oi ?? 0;
      const ceGamma = entry.ce?.greeks?.gamma ?? 0;
      const peGamma = entry.pe?.greeks?.gamma ?? 0;
      const ce_gex  = Math.round(ceOI * ceGamma * lotSize);
      const pe_gex  = Math.round(peOI * peGamma * lotSize);
      const net_gex = Math.round((ce_gex - pe_gex) * spot / 100);
      return { strike, net_gex, ce_gex, pe_gex };
    });
}

// Max pain — same algorithm as OptionsSmartChainTab
function computeMaxPain(entries: Array<{ strike: number; entry: ChainEntry }>): number {
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

function computeGexFlipStrike(profile: GexProfileEntry[]): number | null {
  let cumGex = 0;
  for (const { strike, net_gex } of profile) {
    const prevSign = cumGex === 0 ? 0 : Math.sign(cumGex);
    cumGex += net_gex;
    if (prevSign !== 0 && Math.sign(cumGex) !== prevSign) return strike;
  }
  return null;
}

function deriveRegime(netGex: number, atmIV: number, ivMin: number, ivMax: number, hasData: boolean) {
  if (!hasData || atmIV === 0) return { label: 'Indecisive', color: 'text-zinc-400', dot: 'bg-zinc-500' };
  const ivRange       = ivMax - ivMin;
  const ivPercentile  = ivRange > 0.01 ? (atmIV - ivMin) / ivRange : 0;
  if (ivPercentile > 0.8)  return { label: 'Volatile',   color: 'text-red-400',   dot: 'bg-red-500'   };
  if (netGex > 0)           return { label: 'Pinning',    color: 'text-amber-400', dot: 'bg-amber-500' };
  if (netGex < 0)           return { label: 'Trending',   color: 'text-blue-400',  dot: 'bg-blue-500'  };
  return { label: 'Indecisive', color: 'text-zinc-400', dot: 'bg-zinc-500' };
}

function deriveBias(pcr: number, pcr30: number | null) {
  const rising  = pcr30 !== null && pcr > pcr30;
  const falling = pcr30 !== null && pcr < pcr30;
  if (pcr > 1.3 && rising)  return { label: 'Bullish', color: 'text-emerald-400', dot: 'bg-emerald-500' };
  if (pcr < 0.7 && falling) return { label: 'Bearish', color: 'text-red-400',     dot: 'bg-red-500'     };
  return { label: 'Neutral', color: 'text-amber-400', dot: 'bg-amber-500' };
}

// ─── Sub-components ───────────────────────────────────────────────

function StatChip({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col px-4 border-r border-zinc-800 last:border-r-0">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function KeyTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-lg px-4 py-3 flex flex-col gap-0.5">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className="text-xl font-bold tabular-nums text-white">{value}</span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  );
}

function GexTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: GexProfileEntry }> }) {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[180px] backdrop-blur">
      <p className="text-zinc-300 font-bold mb-1.5">Strike {fmtStrike(d.strike)}</p>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-zinc-400">Net GEX</span>
        <span className={`font-bold tabular-nums ${d.net_gex >= 0 ? 'text-blue-400' : 'text-red-400'}`}>{fmtGex(d.net_gex)}</span>
      </div>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-zinc-400">CE GEX</span>
        <span className="text-blue-300 tabular-nums">{fmtGex(d.ce_gex)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-zinc-400">PE GEX</span>
        <span className="text-red-300 tabular-nums">{fmtGex(d.pe_gex)}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsIntelligenceTab({ expiry }: { expiry: string }) {
  const [intel, setIntel]       = useState<IntelResponse | null>(null);
  const [spot, setSpot]         = useState(0);
  const [atm, setAtm]           = useState(0);
  const [maxPain, setMaxPain]   = useState(0);
  const [ceWall, setCeWall]     = useState(0);
  const [peWall, setPeWall]     = useState(0);
  const [expectedMove, setExpectedMove] = useState<number>(0);
  const [gexProfile, setGexProfile]     = useState<GexProfileEntry[]>([]);
  const [gexFlipStrike, setGexFlipStrike] = useState<number | null>(null);
  const [chainPcr, setChainPcr] = useState(0);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const chainTimerRef = useRef<NodeJS.Timeout | null>(null);
  const intelTimerRef = useRef<NodeJS.Timeout | null>(null);
  const intelRef      = useRef<IntelResponse | null>(null);
  // Read in fetchChain, which is a stable useCallback — a ref keeps the chain
  // poll from being torn down and restarted when the lot size arrives.
  const lotSizeRef    = useRef<number | null>(null);

  useEffect(() => {
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then(r => r.json())
      .then((json: { lot_size?: number | null }) => {
        const lot = Number(json?.lot_size);
        if (Number.isFinite(lot) && lot > 0) lotSizeRef.current = lot;
      })
      .catch(() => {});
  }, []);

  const fetchIntel = useCallback(async () => {
    try {
      const res  = await fetch('/api/options/intelligence');
      const json = await res.json() as IntelResponse;
      if (json.success) { setIntel(json); intelRef.current = json; }
    } catch {
      // silent — chain data still provides GEX profile
    }
  }, []);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    setError('');
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

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      setSpot(spotPrice);
      setAtm(atmStrike);

      // All entries for max pain
      const allEntries = Object.entries(oc)
        .map(([key, entry]) => ({ strike: Number(key), entry }))
        .filter(e => !isNaN(e.strike))
        .sort((a, b) => a.strike - b.strike);

      setMaxPain(computeMaxPain(allEntries));

      // CE/PE OI walls from ATM±10; also accumulate totals for chain PCR fallback
      let maxCE = 0, maxPE = 0, ceW = 0, peW = 0;
      let totCE = 0, totPE = 0;
      for (const { strike, entry } of allEntries) {
        if (Math.abs(strike - atmStrike) > 10 * STRIKE_STEP) continue;
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        totCE += ceOI;
        totPE += peOI;
        if (ceOI > maxCE) { maxCE = ceOI; ceW = strike; }
        if (peOI > maxPE) { maxPE = peOI; peW = strike; }
      }
      setChainPcr(totCE > 0 ? Math.round((totPE / totCE) * 100) / 100 : 0);
      setCeWall(ceW);
      setPeWall(peW);

      // Expected move from ATM straddle
      const atmEntry = allEntries.find(e => e.strike === atmStrike);
      const atmStraddle = (atmEntry?.entry?.ce?.last_price ?? 0) + (atmEntry?.entry?.pe?.last_price ?? 0);
      setExpectedMove(Math.round(atmStraddle));

      // GEX profile: use snapshot history if available, else compute from chain greeks
      if (intelRef.current?.hasData && (intelRef.current.gex_profile.length ?? 0) > 0) {
        setGexProfile(intelRef.current.gex_profile);
        setGexFlipStrike(intelRef.current.gex_flip_strike);
      } else if (lotSizeRef.current) {
        const profile = computeGexFromChain(oc, atmStrike, spotPrice, 10, lotSizeRef.current);
        setGexProfile(profile);
        setGexFlipStrike(computeGexFlipStrike(profile));
      } else {
        // No lot size yet — leave GEX empty rather than plotting a profile scaled
        // by a guess. The next poll (30 s) picks it up.
        setGexProfile([]);
        setGexFlipStrike(null);
      }
    } catch (err) {
      setError(`Fetch error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    fetchIntel();
    intelTimerRef.current = setInterval(fetchIntel, INTEL_POLL);
    return () => { if (intelTimerRef.current) clearInterval(intelTimerRef.current); };
  }, [fetchIntel]);

  useEffect(() => {
    fetchChain();
    chainTimerRef.current = setInterval(fetchChain, CHAIN_POLL);
    return () => { if (chainTimerRef.current) clearInterval(chainTimerRef.current); };
  }, [fetchChain]);

  // ── Derived display values ──────────────────────────────────────

  const current    = intel?.current ?? null;
  const hasData    = intel?.hasData ?? false;
  const netGex     = current?.net_gex ?? (gexProfile.reduce((s, e) => s + e.net_gex, 0));
  const pcr        = current?.pcr ?? chainPcr;
  const atmIV      = current?.atm_iv ?? 0;
  const ivMin      = current?.iv_min ?? 0;
  const ivMax      = current?.iv_max ?? 0;
  const pcr30      = current?.pcr_30min_ago ?? null;
  const timeline   = intel?.timeline ?? [];

  const regime     = deriveRegime(netGex, atmIV, ivMin, ivMax, hasData);
  const bias       = deriveBias(pcr, pcr30);

  const ivRangeStr = ivMin > 0 && ivMax > 0 ? `${ivMin.toFixed(1)}–${ivMax.toFixed(1)}%` : '—';
  const emStr      = expectedMove > 0 ? `±${fmtStrike(expectedMove)}` : '—';
  const rangeStr   = expectedMove > 0 && atm > 0
    ? `${fmtStrike(atm - expectedMove)}–${fmtStrike(atm + expectedMove)}`
    : '—';

  // Unique prefix for SVG gradient IDs (prevents collisions when multiple instances render)
  const uid = useId();

  // X-axis domain 09:15–15:30 IST
  const SESSION_START = new Date(`${(intel?.date ?? new Date().toISOString().slice(0, 10))}T09:15:00+05:30`).getTime();
  const SESSION_END   = new Date(`${(intel?.date ?? new Date().toISOString().slice(0, 10))}T15:30:00+05:30`).getTime();

  // Hourly ticks 09:15–15:15 plus explicit 15:30 close
  const SESSION_TICKS = [0, 1, 2, 3, 4, 5, 6].map(i => SESSION_START + i * 60 * 60 * 1000).concat([SESSION_END]);

  // Net GEX sign based on the last timeline entry (drives gradient colour)
  const netGexPositive = (timeline[timeline.length - 1]?.net_gex ?? 0) >= 0;

  return (
    <div className="flex flex-col gap-5">

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
      )}

      {/* ① Regime Header */}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {/* Market Regime tile */}
          <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-5 py-4 flex flex-col gap-2">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Market Regime</span>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${regime.dot}`} />
              <span className={`text-2xl font-bold ${regime.color}`}>{regime.label}</span>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {regime.label === 'Pinning'    ? 'Dealers net long gamma — expect mean reversion. Straddles favoured.' :
               regime.label === 'Trending'   ? 'Dealers net short gamma — expect directional moves. Avoid naked straddles.' :
               regime.label === 'Volatile'   ? 'IV at intraday high — elevated premium. Consider spreads over naked.' :
               'Insufficient snapshot data to classify regime.'}
            </p>
          </div>
          {/* Directional Bias tile */}
          <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl px-5 py-4 flex flex-col gap-2">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Directional Bias</span>
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${bias.dot}`} />
              <span className={`text-2xl font-bold ${bias.color}`}>{bias.label}</span>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {bias.label === 'Bullish' ? `PCR ${pcr.toFixed(2)} rising — put writers defending support.` :
               bias.label === 'Bearish' ? `PCR ${pcr.toFixed(2)} falling — call writers defending resistance.` :
               `PCR ${pcr > 0 ? pcr.toFixed(2) : '—'} — no clear directional pressure.`}
            </p>
          </div>
        </div>
        {/* Stat chips */}
        <div className="flex items-center py-2 bg-zinc-900/40 border border-zinc-800/50 rounded-xl">
          <StatChip label="Net GEX" value={netGex !== 0 ? fmtGex(netGex) : '—'} color={netGex > 0 ? 'text-blue-400' : netGex < 0 ? 'text-red-400' : 'text-zinc-400'} />
          <StatChip label="Chain PCR" value={pcr > 0 ? pcr.toFixed(2) : '—'} color={pcr > 1.3 ? 'text-emerald-400' : pcr < 0.7 ? 'text-red-400' : 'text-amber-400'} />
          <StatChip label="ATM IV" value={atmIV > 0 ? `${atmIV.toFixed(1)}%` : '—'} />
          <StatChip label="IV Range" value={ivRangeStr} />
        </div>
      </div>

      {/* ② GEX Profile */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-bold text-white uppercase tracking-widest">GEX Profile</span>
          <div className="flex items-center gap-4 text-[10px] text-zinc-500">
            <span><span className="inline-block w-2 h-2 rounded-sm bg-blue-500 mr-1" />Stabilising</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-red-500 mr-1" />Amplifying</span>
          </div>
        </div>
        {gexProfile.length === 0 ? (
          <div className="h-[300px] flex items-center justify-center text-zinc-600 text-xs">
            {loading ? 'Loading…' : 'No GEX data'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={gexProfile} margin={{ top: 8, right: 16, bottom: 40, left: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="strike"
                tick={{ fill: '#a1a1aa', fontSize: 9 }}
                angle={-45}
                textAnchor="end"
                tickFormatter={s => String(s)}
                interval={0}
              />
              <YAxis
                tick={{ fill: '#a1a1aa', fontSize: 9 }}
                tickFormatter={v => fmtGex(Number(v))}
                width={72}
              />
              <Tooltip content={<GexTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
              {atm > 0 && (
                <ReferenceLine x={atm} stroke="#f59e0b" strokeDasharray="4 2"
                  label={{ value: 'ATM', fill: '#f59e0b', fontSize: 9, position: 'insideTopLeft' }} />
              )}
              {maxPain > 0 && maxPain !== atm && (
                <ReferenceLine x={maxPain} stroke="#a78bfa" strokeDasharray="4 2"
                  label={{ value: 'MaxPain', fill: '#a78bfa', fontSize: 9, position: 'insideTopRight' }} />
              )}
              {gexFlipStrike && (
                <ReferenceLine x={gexFlipStrike} stroke="#22d3ee" strokeDasharray="4 2"
                  label={{ value: 'GEX Flip', fill: '#22d3ee', fontSize: 9, position: 'insideTopLeft' }} />
              )}
              <Bar dataKey="net_gex" name="Net GEX" maxBarSize={28}>
                {gexProfile.map(({ strike, net_gex }) => (
                  <Cell key={strike} fill={net_gex >= 0 ? '#3b82f6' : '#ef4444'} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ③ Intraday Signal Timeline */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <span className="text-xs font-bold text-white uppercase tracking-widest">Intraday Signals</span>
        {!hasData || timeline.length < 2 ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
            <span className="w-2 h-2 rounded-full bg-zinc-600 flex-shrink-0" />
            Intraday signals require the snapshot collector — start it from the{' '}
            <a href="/iv-charts" className="text-blue-400 underline underline-offset-2">IV Charts page</a>.
          </div>
        ) : (
          <div className="flex flex-col gap-3 mt-3">
            {/* PCR */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">PCR</span>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={SESSION_TICKS} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={36} domain={['auto', 'auto']} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <ReferenceLine y={1.3} stroke="#10b981" strokeDasharray="3 2" strokeOpacity={0.5} />
                  <ReferenceLine y={0.7} stroke="#ef4444" strokeDasharray="3 2" strokeOpacity={0.5} />
                  <Line type="monotone" dataKey="pcr" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="PCR" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* ATM IV */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">ATM IV (%)</span>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={SESSION_TICKS} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={36} domain={['auto', 'auto']} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <Line type="monotone" dataKey="atm_iv" stroke="#60a5fa" strokeWidth={1.5} dot={false} name="ATM IV" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* Net GEX */}
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Net GEX</span>
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={timeline} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id={`${uid}-gexGreen`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id={`${uid}-gexRed`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="ts" type="number" scale="time" domain={[SESSION_START, SESSION_END]}
                    tickFormatter={ts => new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    tick={{ fill: '#71717a', fontSize: 9 }} ticks={SESSION_TICKS} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 9 }} width={48} tickFormatter={v => fmtGex(Number(v))} />
                  <Tooltip
                    labelFormatter={ts => new Date(Number(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    formatter={(v: any) => [typeof v === 'number' ? fmtGex(v as number) : String(v ?? ''), 'Net GEX'] as [string, string]}
                    contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: '#a1a1aa' }} />
                  <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="net_gex"
                    stroke={netGexPositive ? '#10b981' : '#ef4444'} strokeWidth={1.5} dot={false}
                    fill={`url(#${uid}-${netGexPositive ? 'gexGreen' : 'gexRed'})`} name="Net GEX" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* ④ Key Levels */}
      <div className="bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-4">
        <span className="text-xs font-bold text-white uppercase tracking-widest">Key Levels</span>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <KeyTile label="Max Pain" value={maxPain > 0 ? fmtStrike(maxPain) : '—'} sub="option payout minimum" />
          <KeyTile label="GEX Flip Strike" value={gexFlipStrike ? fmtStrike(gexFlipStrike) : '—'} sub="gamma sign change" />
          <KeyTile label="Expected Move" value={emStr} sub={rangeStr} />
          <KeyTile label="PE OI Wall" value={peWall > 0 ? fmtStrike(peWall) : '—'} sub="highest PE open interest" />
          <KeyTile label="CE OI Wall" value={ceWall > 0 ? fmtStrike(ceWall) : '—'} sub="highest CE open interest" />
          <KeyTile label="IV Range" value={ivRangeStr} sub="intraday ATM IV min–max" />
        </div>
      </div>

    </div>
  );
}
