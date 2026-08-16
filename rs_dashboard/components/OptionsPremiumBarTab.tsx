'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceDot, Cell,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface OcSide {
  last_price?: number;
  oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
}

interface OcEntry { ce?: OcSide; pe?: OcSide }

interface PremiumRow {
  strike: number;
  cePremium: number;
  pePremium: number;
  straddlePremium: number;
  ceOi: number;
  peOi: number;
  isATM: boolean;
}

function fmtOi(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
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

function fmtPrice(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}`;
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

// ─── Tooltips ─────────────────────────────────────────────────────

const PremiumTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: PremiumRow }>)[0]?.payload;
  const diff = (row?.cePremium ?? 0) - (row?.pePremium ?? 0);
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold font-sans">CE Premium</span>
        <span className="text-white font-bold tabular-nums">{fmtPrice(row?.cePremium ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-2">
        <span className="text-red-400 font-semibold font-sans">PE Premium</span>
        <span className="text-white font-bold tabular-nums">{fmtPrice(row?.pePremium ?? 0)}</span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Straddle</span>
        <span className="text-emerald-400 font-bold tabular-nums">{fmtPrice(row?.straddlePremium ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-2">
        <span className="text-zinc-400 font-sans">Difference</span>
        <span className={`font-bold tabular-nums ${diff >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
          {diff >= 0 ? '+' : ''}{diff.toFixed(2)}
        </span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8 mb-1">
        <span className="text-cyan-400 font-semibold font-sans">CE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOi(row?.ceOi ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-amber-400 font-semibold font-sans">PE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOi(row?.peOi ?? 0)}</span>
      </div>
    </div>
  );
};

const SmileTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: PremiumRow }>)[0]?.payload;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">CE Component</span>
        <span className="text-blue-400 font-bold tabular-nums">{fmtPrice(row?.cePremium ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-2">
        <span className="text-zinc-400 font-sans">PE Component</span>
        <span className="text-red-400 font-bold tabular-nums">{fmtPrice(row?.pePremium ?? 0)}</span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8">
        <span className="text-emerald-400 font-semibold font-sans">Total Straddle</span>
        <span className="text-emerald-400 font-bold tabular-nums">{fmtPrice(row?.straddlePremium ?? 0)}</span>
      </div>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────

function PulseStat({
  label, value, sub, color = 'text-white', size = 'text-lg',
}: { label: string; value: string; sub?: string; color?: string; size?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`${size} font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

function ChartHeader({
  eyebrow, title, sub, legend,
}: { eyebrow: string; title: string; sub: string; legend: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-semibold">{legend}</div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsPremiumBarTab({ expiry }: { expiry: string }) {
  const [rows, setRows]               = useState<PremiumRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [pollMs, setPollMs]           = useState<PollMs>(30_000);
  const [showOi, setShowOi]           = useState(true);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const atmRef       = useRef(0); // last known-good ATM strike, survives transient spot=0 glitches

  const fetchPremium = useCallback(async () => {
    if (!expiry) return;
    if (document.hidden) return; // skip polling while tab is backgrounded

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`, {
        signal: controller.signal,
      });
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
      // The spot-price lookup is a separate call from the option chain fetch and can
      // transiently return 0 (rate limit / momentary lookup miss) even when the chain
      // itself is valid. Falling back to the last known-good ATM avoids filtering out
      // every strike (and blanking the chart) over a spot-only hiccup.
      const atmStrike = spotPrice > 0
        ? Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP
        : atmRef.current;
      const oc        = json.data.chain.oc;

      const newRows: PremiumRow[] = Object.entries(oc)
        .map(([k, v]) => {
          const strike    = Number(k);
          const cePremium = v.ce?.last_price ?? 0;
          const pePremium = v.pe?.last_price ?? 0;
          return {
            strike,
            cePremium,
            pePremium,
            straddlePremium: cePremium + pePremium,
            ceOi:            v.ce?.oi ?? 0,
            peOi:            v.pe?.oi ?? 0,
            isATM:           strike === atmStrike,
          };
        })
        .filter(r => {
          if (isNaN(r.strike)) return false;
          if (Math.abs(r.strike - atmStrike) > WING_COUNT * STRIKE_STEP) return false;
          return (r.cePremium > 0 || r.pePremium > 0);
        })
        .sort((a, b) => a.strike - b.strike);

      atmRef.current = atmStrike;
      if (spotPrice > 0) setSpot(spotPrice); // don't overwrite a good spot with a transient 0
      setAtm(atmStrike);
      setRows(newRows);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    if (!expiry) return;
    setRows([]);
    setSpot(0);
    setAtm(0);
    atmRef.current = 0;
    setLastUpdated(null);
    setLoading(true);
    void fetchPremium();
    intervalRef.current = setInterval(() => { void fetchPremium(); }, pollMs);

    const onVisibilityChange = () => { if (!document.hidden) void fetchPremium(); };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      abortRef.current?.abort();
    };
  }, [expiry, fetchPremium, pollMs]);

  // ── Derived stats ─────────────────────────────────────────────────
  const atmRow = rows.find(r => r.isATM);
  const atmStraddle = atmRow?.straddlePremium ?? 0;
  const atmStraddlePct = spot > 0 ? (atmStraddle / spot) * 100 : 0;
  const totalChainPremium = rows.reduce((s, r) => s + r.straddlePremium, 0);
  const maxSmileRow = rows.reduce<PremiumRow | undefined>(
    (max, r) => (!max || r.straddlePremium > max.straddlePremium ? r : max), undefined,
  );
  const maxSmileIdx = maxSmileRow ? rows.indexOf(maxSmileRow) : -1;
  const maxSmileLabelPos =
    maxSmileIdx <= 1 ? 'right' : maxSmileIdx >= rows.length - 2 ? 'left' : 'top';

  const xAxisProps = {
    dataKey: 'strike' as const,
    tickFormatter: fmtStrike,
    tick:      { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine:  false,
    axisLine:  { stroke: '#27272a' },
    interval:  'preserveStartEnd' as const,
    minTickGap: 18,
  };
  const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };

  if (loading && !rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading option premium data…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Market pulse ribbon ─────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-blue-500/[0.04]" />

        <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
          <PulseStat
            label={`${UNDERLYING} Spot`}
            value={spot > 0 ? spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
            size="text-2xl"
          />
          <div className="w-px bg-zinc-800 self-stretch" />
          <PulseStat
            label="ATM Strike"
            value={atm > 0 ? atm.toLocaleString('en-IN') : '—'}
            size="text-2xl"
            color="text-zinc-200"
          />
          <div className="w-px bg-zinc-800 self-stretch" />
          <PulseStat
            label="ATM Straddle"
            value={atmStraddle > 0 ? fmtPrice(atmStraddle) : '—'}
            sub={atmStraddle > 0 ? `${atmStraddlePct.toFixed(2)}% of spot · implied move` : undefined}
            color="text-emerald-400"
            size="text-2xl"
          />

          <div className="ml-auto flex items-center gap-5 flex-wrap">
            <PulseStat
              label="ATM CE"
              value={atmRow && atmRow.cePremium > 0 ? fmtPrice(atmRow.cePremium) : '—'}
              color="text-blue-400"
              size="text-sm"
            />
            <PulseStat
              label="ATM PE"
              value={atmRow && atmRow.pePremium > 0 ? fmtPrice(atmRow.pePremium) : '—'}
              color="text-red-400"
              size="text-sm"
            />
            <PulseStat
              label="Wing Total"
              value={totalChainPremium > 0 ? fmtPrice(totalChainPremium) : '—'}
              sub={`±${WING_COUNT} strikes`}
              color="text-zinc-200"
              size="text-sm"
            />
            <PulseStat label="Expiry" value={expiry || '—'} size="text-sm" color="text-zinc-300" />
          </div>
        </div>

        {/* Control strip */}
        <div className="relative flex items-center justify-between gap-3 px-5 py-2 border-t border-zinc-800/80 bg-zinc-950/40 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
            {lastUpdated && (
              <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
                Updated {lastUpdated}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <span className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest pl-1.5 pr-1">Refresh</span>
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={ms}
                onClick={() => setPollMs(ms)}
                className={`px-2 py-1 text-[10px] font-mono font-bold rounded-md transition-colors ${
                  pollMs === ms
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
                    : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
          {expiry ? 'No premium data available for this expiry' : 'Select an expiry to view option premiums'}
        </div>
      ) : (<>

        <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
          {/* CE vs PE Premium Side-by-Side Bar Chart */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <ChartHeader
              eyebrow="Distribution"
              title="Option Premium by Strike"
              sub={`CE vs PE premium · ATM ±${WING_COUNT} strikes · ${rows.length} strikes loaded`}
              legend={<>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-blue-500" />
                  <span className="text-zinc-300">CE Premium</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-red-500" />
                  <span className="text-zinc-300">PE Premium</span>
                </span>
                <div className="w-px h-4 bg-zinc-700 mx-0.5" />
                <button
                  onClick={() => setShowOi(v => !v)}
                  className={`flex items-center gap-2 pl-1 pr-2 py-1 rounded-full border transition-colors ${
                    showOi
                      ? 'border-cyan-500/40 bg-cyan-500/10 text-zinc-100'
                      : 'border-zinc-700 bg-zinc-800/60 text-zinc-500 hover:text-zinc-300'
                  }`}
                  title={showOi ? 'Hide OI overlay' : 'Show OI overlay'}
                >
                  <span
                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                      showOi ? 'bg-cyan-500' : 'bg-zinc-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                        showOi ? 'translate-x-3.5' : 'translate-x-0.5'
                      }`}
                    />
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-0.5 bg-cyan-400" />
                    <span className="w-3 h-0.5 bg-amber-400" />
                    <span>OI Overlay</span>
                  </span>
                </button>
              </>}
            />

            <ResponsiveContainer width="100%" height={420}>
              <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barCategoryGap="20%" barGap={2}>
                <defs>
                  <linearGradient id="ceBarFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity={1} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.55} />
                  </linearGradient>
                  <linearGradient id="peBarFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f87171" stopOpacity={1} />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity={0.55} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  yAxisId="premium"
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                  tickFormatter={v => `₹${v}`}
                />
                {showOi && (
                  <YAxis
                    yAxisId="oi"
                    orientation="right"
                    tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                    tickLine={false}
                    axisLine={false}
                    width={54}
                    tickFormatter={fmtOi}
                  />
                )}
                <Tooltip content={<PremiumTooltip />} cursor={{ fill: '#27272a', opacity: 0.5 }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
                />
                {atm > 0 && (
                  <ReferenceLine
                    yAxisId="premium"
                    x={atm}
                    stroke="#71717a"
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    label={{ value: 'ATM', position: 'top', fill: '#a1a1aa', fontSize: 10, fontWeight: 700 }}
                  />
                )}
                <Bar yAxisId="premium" dataKey="cePremium" name="CE Premium" radius={[3, 3, 0, 0]}>
                  {rows.map(r => (
                    <Cell
                      key={r.strike}
                      fill="url(#ceBarFill)"
                      stroke={r.isATM ? '#93c5fd' : 'transparent'}
                      strokeWidth={r.isATM ? 1.5 : 0}
                    />
                  ))}
                </Bar>
                <Bar yAxisId="premium" dataKey="pePremium" name="PE Premium" radius={[3, 3, 0, 0]}>
                  {rows.map(r => (
                    <Cell
                      key={r.strike}
                      fill="url(#peBarFill)"
                      stroke={r.isATM ? '#fca5a5' : 'transparent'}
                      strokeWidth={r.isATM ? 1.5 : 0}
                    />
                  ))}
                </Bar>
                {showOi && (
                  <Line
                    yAxisId="oi"
                    type="monotone"
                    dataKey="ceOi"
                    name="CE OI"
                    stroke="#22d3ee"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                )}
                {showOi && (
                  <Line
                    yAxisId="oi"
                    type="monotone"
                    dataKey="peOi"
                    name="PE OI"
                    stroke="#fbbf24"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Volatility Smile — signature straddle curve */}
          <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
            <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[520px] h-[280px] bg-emerald-500/[0.05] blur-3xl rounded-full" />

            <ChartHeader
              eyebrow="Curvature"
              title="Straddle Volatility Smile"
              sub="Total premium (CE + PE) across strikes — the curve's shape reads the market's priced-in skew"
              legend={<>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-blue-400" />
                  <span className="text-zinc-400">CE Leg</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-red-400" />
                  <span className="text-zinc-400">PE Leg</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-emerald-500" />
                  <span className="text-zinc-300">Straddle Premium</span>
                </span>
              </>}
            />

            <ResponsiveContainer width="100%" height={420}>
              <ComposedChart data={rows} margin={{ top: 28, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="smileFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#059669" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  domain={[0, (max: number) => Math.ceil(max * 1.22 / 50) * 50]}
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  axisLine={false}
                  width={54}
                  tickFormatter={v => `₹${v}`}
                />
                <Tooltip content={<SmileTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
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
                <Area
                  type="monotone"
                  dataKey="straddlePremium"
                  name="Straddle Premium"
                  stroke="#34d399"
                  strokeWidth={2.5}
                  fill="url(#smileFill)"
                  dot={false}
                  activeDot={{ r: 5, fill: '#34d399', stroke: '#022c22', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="cePremium"
                  name="CE Leg"
                  stroke="#60a5fa"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                <Line
                  type="monotone"
                  dataKey="pePremium"
                  name="PE Leg"
                  stroke="#f87171"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={false}
                  activeDot={{ r: 3 }}
                />
                {maxSmileRow && (
                  <ReferenceDot
                    x={maxSmileRow.strike}
                    y={maxSmileRow.straddlePremium}
                    r={5}
                    fill="#34d399"
                    stroke="#022c22"
                    strokeWidth={2}
                    label={{
                      value: fmtPrice(maxSmileRow.straddlePremium),
                      position: maxSmileLabelPos,
                      fill: '#6ee7b7',
                      fontSize: 11,
                      fontWeight: 700,
                      offset: 10,
                    }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

      </>)}
    </div>
  );
}
