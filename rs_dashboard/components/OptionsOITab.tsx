'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface OcSide {
  last_price?: number;
  oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
}

interface OcEntry { ce?: OcSide; pe?: OcSide }

interface OIRow {
  strike: number;
  ceOI: number;
  peOI: number;
  ceDelta: number;
  peDelta: number;
  isATM: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const WING_COUNT  = 10;

const POLL_OPTIONS = [
  { label: '10s', ms: 10_000  },
  { label: '20s', ms: 20_000  },
  { label: '30s', ms: 30_000  },
  { label: '1m',  ms: 60_000  },
  { label: '2m',  ms: 120_000 },
  { label: '3m',  ms: 180_000 },
] as const;

type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

// ─── Tooltips ─────────────────────────────────────────────────────

const OITooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: OIRow }>)[0]?.payload;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px]">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold">CE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(row?.ceOI ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-red-400 font-semibold">PE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(row?.peOI ?? 0)}</span>
      </div>
      {(row?.ceOI ?? 0) > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex justify-between gap-8">
          <span className="text-zinc-400">PCR</span>
          <span className="text-yellow-400 font-bold tabular-nums">
            {((row?.peOI ?? 0) / (row?.ceOI ?? 1)).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
};

const DeltaTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: OIRow }>)[0]?.payload;
  const ceD = row?.ceDelta ?? 0;
  const peD = row?.peDelta ?? 0;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[190px]">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold">CE ΔOI</span>
        <span className={`font-bold tabular-nums ${ceD >= 0 ? 'text-blue-300' : 'text-blue-600'}`}>
          {ceD >= 0 ? '+' : ''}{fmtOI(ceD)}
        </span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-red-400 font-semibold">PE ΔOI</span>
        <span className={`font-bold tabular-nums ${peD >= 0 ? 'text-red-300' : 'text-red-600'}`}>
          {peD >= 0 ? '+' : ''}{fmtOI(peD)}
        </span>
      </div>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────

function StatChip({
  label, value, sub, color = 'text-white',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsOITab({ expiry }: { expiry: string }) {
  const [rows, setRows]               = useState<OIRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [pollMs, setPollMs]           = useState<PollMs>(20_000);

  // Snapshot of OI from the previous poll, keyed by strike
  const prevOIRef = useRef<Map<number, { ceOI: number; peOI: number }>>(new Map());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchOI = useCallback(async () => {
    if (!expiry) return;
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      const newRows: OIRow[] = Object.entries(oc)
        .map(([k, v]) => {
          const strike = Number(k);
          const ceOI   = v.ce?.oi ?? 0;
          const peOI   = v.pe?.oi ?? 0;
          const prev   = prevOIRef.current.get(strike);
          return {
            strike,
            ceOI,
            peOI,
            ceDelta: prev != null ? ceOI - prev.ceOI : 0,
            peDelta: prev != null ? peOI - prev.peOI : 0,
            isATM:   strike === atmStrike,
          };
        })
        .filter(r => {
          if (isNaN(r.strike)) return false;
          if (Math.abs(r.strike - atmStrike) > WING_COUNT * STRIKE_STEP) return false;
          return (r.ceOI > 0 || r.peOI > 0);
        })
        .sort((a, b) => a.strike - b.strike);

      // Persist current snapshot for next delta
      const nextPrev = new Map<number, { ceOI: number; peOI: number }>();
      newRows.forEach(r => nextPrev.set(r.strike, { ceOI: r.ceOI, peOI: r.peOI }));
      prevOIRef.current = nextPrev;

      setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(newRows);
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
    if (!expiry) return;
    prevOIRef.current = new Map();
    setRows([]);
    setSpot(0);
    setAtm(0);
    setLastUpdated(null);
    setLoading(true);
    void fetchOI();
    intervalRef.current = setInterval(() => { void fetchOI(); }, pollMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry, fetchOI, pollMs]);

  // ── Derived stats ─────────────────────────────────────────────────
  const totalCeOI = rows.reduce((s, r) => s + r.ceOI, 0);
  const totalPeOI = rows.reduce((s, r) => s + r.peOI, 0);
  const chainPCR  = totalCeOI > 0 ? totalPeOI / totalCeOI : 0;
  const hasDelta  = rows.some(r => r.ceDelta !== 0 || r.peDelta !== 0);

  const pcrColor  = chainPCR > 1.3 ? 'text-emerald-400'
                  : chainPCR > 0 && chainPCR < 0.7 ? 'text-red-400'
                  : 'text-yellow-400';
  const pcrLabel  = chainPCR > 1.3 ? 'Bullish' : chainPCR < 0.7 && chainPCR > 0 ? 'Bearish' : 'Neutral';

  const xAxisProps = {
    dataKey: 'strike' as const,
    tickFormatter: fmtStrike,
    tick:      { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine:  false,
    axisLine:  { stroke: '#27272a' },
  };
  const gridProps = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false as const };

  if (loading && !rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading open interest…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-5 px-4 py-3 bg-zinc-900/80 rounded-xl border border-zinc-800 flex-wrap">
        <StatChip label="Spot" value={spot > 0 ? spot.toLocaleString('en-IN') : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="ATM" value={atm > 0 ? atm.toLocaleString('en-IN') : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="Chain PCR"
          value={chainPCR > 0 ? chainPCR.toFixed(2) : '—'}
          sub={chainPCR > 0 ? pcrLabel : undefined}
          color={pcrColor}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total CE OI" value={totalCeOI > 0 ? fmtOI(totalCeOI) : '—'} color="text-blue-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total PE OI" value={totalPeOI > 0 ? fmtOI(totalPeOI) : '—'} color="text-red-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="PE − CE"
          value={totalCeOI > 0 || totalPeOI > 0 ? `${totalPeOI - totalCeOI >= 0 ? '+' : ''}${fmtOI(totalPeOI - totalCeOI)}` : '—'}
          sub={totalPeOI - totalCeOI > 0 ? 'PE dominant' : totalPeOI - totalCeOI < 0 ? 'CE dominant' : undefined}
          color={totalPeOI - totalCeOI > 0 ? 'text-emerald-400' : totalPeOI - totalCeOI < 0 ? 'text-red-400' : 'text-zinc-400'}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Expiry" value={expiry || '—'} />

        <div className="ml-auto flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-400 tabular-nums">
              Updated {lastUpdated}
            </span>
          )}

          {/* Poll interval selector */}
          <div className="flex items-center bg-zinc-800 border border-zinc-700 p-0.5 rounded-xl gap-0.5">
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={ms}
                onClick={() => setPollMs(ms)}
                className={`px-2 py-1 text-[10px] font-bold rounded-lg transition-all ${
                  pollMs === ms
                    ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
          {expiry ? 'No OI data available for this expiry' : 'Select an expiry to view open interest'}
        </div>
      ) : (<>

        {/* ── OI Bar Chart ─────────────────────────────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">Open Interest Across Strikes</p>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                CE OI vs PE OI · ATM ±{WING_COUNT} strikes · {rows.length} strikes
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-semibold">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-blue-400" />
                <span className="text-zinc-300">CE OI</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-red-400" />
                <span className="text-zinc-300">PE OI</span>
              </span>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={380}>
            <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="20%" barGap={2}>
              <CartesianGrid {...gridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                width={54}
                tickFormatter={fmtOI}
              />
              <Tooltip content={<OITooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
              />
              {atm > 0 && (
                <ReferenceLine
                  x={atm}
                  stroke="#71717a"
                  strokeDasharray="5 4"
                  strokeWidth={1.5}
                  label={{ value: 'ATM', position: 'top', fill: '#a1a1aa', fontSize: 10, fontWeight: 700 }}
                />
              )}
              <Bar dataKey="ceOI" name="CE OI" radius={[3, 3, 0, 0]}>
                {rows.map(r => (
                  <Cell
                    key={r.strike}
                    fill={r.isATM ? '#93c5fd' : '#3b82f6'}
                    fillOpacity={r.isATM ? 1 : 0.85}
                  />
                ))}
              </Bar>
              <Bar dataKey="peOI" name="PE OI" radius={[3, 3, 0, 0]}>
                {rows.map(r => (
                  <Cell
                    key={r.strike}
                    fill={r.isATM ? '#fca5a5' : '#ef4444'}
                    fillOpacity={r.isATM ? 1 : 0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* ── Change in OI ─────────────────────────────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">Change in Open Interest</p>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                {hasDelta
                  ? 'CE ΔOI vs PE ΔOI · change since previous snapshot'
                  : 'Δ will appear after first 20s poll'}
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-semibold">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-blue-500" />
                <span className="text-zinc-300">CE ΔOI</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-red-500" />
                <span className="text-zinc-300">PE ΔOI</span>
              </span>
            </div>
          </div>

          {!hasDelta ? (
            <div className="flex flex-col items-center justify-center h-[220px] gap-2">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
              <p className="text-xs text-zinc-500">Waiting for first delta snapshot…</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="20%" barGap={2}>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                  tickFormatter={fmtOI}
                />
                <Tooltip content={<DeltaTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
                />
                <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                {atm > 0 && (
                  <ReferenceLine
                    x={atm}
                    stroke="#71717a"
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    label={{ value: 'ATM', position: 'top', fill: '#a1a1aa', fontSize: 10, fontWeight: 700 }}
                  />
                )}
                <Bar dataKey="ceDelta" name="CE ΔOI" radius={[3, 3, 0, 0]}>
                  {rows.map(r => (
                    <Cell
                      key={r.strike}
                      fill={r.ceDelta >= 0 ? '#60a5fa' : '#1d4ed8'}
                      fillOpacity={r.isATM ? 1 : 0.85}
                    />
                  ))}
                </Bar>
                <Bar dataKey="peDelta" name="PE ΔOI" radius={[3, 3, 0, 0]}>
                  {rows.map(r => (
                    <Cell
                      key={r.strike}
                      fill={r.peDelta >= 0 ? '#f87171' : '#b91c1c'}
                      fillOpacity={r.isATM ? 1 : 0.85}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

      </>)}
    </div>
  );
}
