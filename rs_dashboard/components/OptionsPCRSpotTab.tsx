'use client';

import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  ComposedChart, Line, ReferenceArea, ReferenceLine, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface RawPoint {
  time: string;
  ts:   number;
  spot: number;
  ceOI: number;
  peOI: number;
  diff: number;
}

interface CumulativeResponse {
  success: boolean;
  date:    string;
  atm:     number;
  expiry:  string;
  wings:   number;
  data:    RawPoint[];
  error?:  string;
}

interface ChartPoint {
  time: string;
  ts:   number;
  pcr:  number | null;
  spotPct: number;
  niftyNorm: number | null;
}

// ─── Palette ──────────────────────────────────────────────────────
// PCR = red-400, NIFTY% (indexed onto the PCR axis) = teal-400 — high-separation
// pair already used elsewhere in this codebase (OI red / VIX-style teal).
const PCR_COLOR    = '#f87171';
const NIFTY_COLOR  = '#2dd4bf';
const AXIS         = '#a1a1aa';
const GRID         = '#27272a';
const ZONE_GREEN   = '#10b981';
const ZONE_AMBER   = '#f59e0b';
const ZONE_RED     = '#ef4444';

// ─── Helpers ──────────────────────────────────────────────────────

function fmtTick(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function sessionBoundsIST(date: string): { start: number; end: number } {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  const end   = new Date(`${date}T15:30:00+05:30`).getTime();
  return { start, end };
}

/** Pearson correlation — invariant to the positive-linear min-max mapping used
 * to index NIFTY% onto the PCR axis, so it's computed on the raw values. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? null : num / den;
}

// ─── Tooltip ──────────────────────────────────────────────────────

const PCRTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const point = (payload[0] as { payload: ChartPoint }).payload;
  const pcr = point.pcr;
  const sentiment = pcr == null ? null
    : Math.abs(pcr - 1) <= 0.2 ? { label: 'Neutral', color: 'text-emerald-400' }
    : Math.abs(pcr - 1) <= 0.4 ? { label: 'Caution', color: 'text-amber-400' }
    : { label: pcr < 1 ? 'Bearish-skewed' : 'Bullish-skewed', color: 'text-red-400' };
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[190px]">
      <p className="text-zinc-300 font-bold mb-2">{typeof label === 'number' ? fmtTick(label) : String(label)}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="flex items-center gap-1.5 text-zinc-400 font-semibold">
          <span className="w-2 h-2 rounded-sm" style={{ background: PCR_COLOR }} />PCR
        </span>
        <span className="text-white font-bold tabular-nums">{pcr == null ? '—' : pcr.toFixed(3)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="flex items-center gap-1.5 text-zinc-400 font-semibold">
          <span className="w-2 h-2 rounded-sm" style={{ background: NIFTY_COLOR }} />NIFTY50 %
        </span>
        <span className={`font-bold tabular-nums ${point.spotPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {point.spotPct >= 0 ? '+' : ''}{point.spotPct.toFixed(2)}%
        </span>
      </div>
      {sentiment && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex justify-between gap-8">
          <span className="text-zinc-400">Zone</span>
          <span className={`font-bold ${sentiment.color}`}>{sentiment.label}</span>
        </div>
      )}
    </div>
  );
};

function StatChip({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsPCRSpotTab({ expiry: _expiry }: { expiry: string }) {
  const [response, setResponse]   = useState<CumulativeResponse | null>(null);
  const [prevClose, setPrevClose] = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchData = () => {
    fetch('/api/options/iv-history?mode=cumulative&wings=10')
      .then(r => r.json())
      .then((j: CumulativeResponse) => {
        if (j.success) { setResponse(j); setError(''); }
        else           { setError(j.error ?? 'No data'); setResponse(null); }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));

    // Previous session's close — the same anchor the rest of the dashboard uses
    // for "% change". The collector's own first snapshot is taken at market open
    // (~09:15), not the prior close, so anchoring on it there understates the
    // day's real move by whatever the stock gapped at open.
    fetch('/api/options/spot?underlying=NIFTY')
      .then(r => r.json())
      .then((j: { success: boolean; prev_close?: number }) => {
        if (j.success && j.prev_close) setPrevClose(j.prev_close);
      })
      .catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    fetchData();
    pollRef.current = setInterval(fetchData, 60_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const raw  = response?.data ?? [];
  const date = response?.date ?? '';

  // ── Derive PCR + NIFTY% and index NIFTY% onto the PCR axis ──────
  // Two measures of different scale don't get a second y-axis (dual-axis charts
  // hide the real relationship behind independently-chosen scales) — instead
  // NIFTY%'s min-max range is mapped onto the PCR domain so both lines share one
  // axis. Correlation is computed on the raw values; Pearson r is invariant to
  // this kind of positive-linear rescale, so the stat isn't affected by it.
  const { chartData, domain, corr, last } = useMemo(() => {
    if (raw.length === 0) {
      return { chartData: [] as ChartPoint[], domain: [0.4, 1.0] as [number, number], corr: null as number | null, last: null as RawPoint | null };
    }
    const base = prevClose || raw[0].spot || raw.find(p => p.spot > 0)?.spot || 0;
    const pcrVals: number[] = [];
    const pctVals: number[] = [];
    const pre = raw.map(p => {
      const pcr = p.ceOI > 0 ? p.peOI / p.ceOI : null;
      const spotPct = base > 0 ? ((p.spot - base) / base) * 100 : 0;
      if (pcr != null) pcrVals.push(pcr);
      pctVals.push(spotPct);
      return { time: p.time.slice(0, 5), ts: p.ts, pcr, spotPct };
    });

    const dataMin = pcrVals.length ? Math.min(...pcrVals) : 0.6;
    const dataMax = pcrVals.length ? Math.max(...pcrVals) : 1.0;
    const lo = Math.floor(Math.min(dataMin, 1) * 10) / 10 - 0.05;
    const hi = Math.ceil(Math.max(dataMax, 1) * 10) / 10 + 0.05;

    const pctMin = Math.min(...pctVals);
    const pctMax = Math.max(...pctVals);
    const pctSpan = (pctMax - pctMin) || 1;
    const domSpan = hi - lo;

    const chartData: ChartPoint[] = pre.map(p => ({
      ...p,
      niftyNorm: lo + ((p.spotPct - pctMin) / pctSpan) * domSpan,
    }));

    const corr = pearson(
      pre.filter(p => p.pcr != null).map(p => p.pcr as number),
      pre.filter(p => p.pcr != null).map(p => p.spotPct),
    );

    return { chartData, domain: [lo, hi] as [number, number], corr, last: raw[raw.length - 1] };
  }, [raw, prevClose]);

  const pcr = last && last.ceOI > 0 ? last.peOI / last.ceOI : null;
  const pcrColor = pcr == null ? 'text-zinc-400'
    : Math.abs(pcr - 1) <= 0.2 ? 'text-emerald-400'
    : Math.abs(pcr - 1) <= 0.4 ? 'text-amber-400'
    : 'text-red-400';

  // ── Background zones by |PCR - 1| ────────────────────────────────
  const [lo, hi] = domain;
  const clip = (a: number, b: number) => [Math.max(a, lo), Math.min(b, hi)] as [number, number];
  const zones: { from: number; to: number; color: string }[] = [
    { from: 1 - 0.2, to: 1 + 0.2, color: ZONE_GREEN },
    { from: 1 - 0.4, to: 1 - 0.2, color: ZONE_AMBER },
    { from: 1 + 0.2, to: 1 + 0.4, color: ZONE_AMBER },
    { from: lo,      to: 1 - 0.4, color: ZONE_RED },
    { from: 1 + 0.4, to: hi,      color: ZONE_RED },
  ]
    .map(z => { const [from, to] = clip(z.from, z.to); return { ...z, from, to }; })
    .filter(z => z.to > z.from);

  const { start: xStart, end: xEnd } = date
    ? sessionBoundsIST(date)
    : { start: Date.now() - 30 * 60_000, end: Date.now() };

  const sessionTicks = (() => {
    const interval = 60 * 60_000;
    const first = Math.ceil(xStart / interval) * interval;
    const ticks: number[] = [];
    for (let t = first; t <= xEnd; t += interval) ticks.push(t);
    return ticks;
  })();

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading PCR data…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <p className="text-sm text-zinc-400 font-medium text-center max-w-sm">
          {error.includes('No IV snapshot') || error.includes('No data')
            ? 'No OI snapshot data for today — start iv_snapshot_collector.py (auto-starts with the server)'
            : error}
        </p>
        <p className="text-xs text-zinc-600 font-mono">python scripts/tools/iv_snapshot_collector.py</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Status bar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-5 px-4 py-3 bg-zinc-900/80 rounded-xl border border-zinc-800 flex-wrap">
        <StatChip label="Chain PCR" value={pcr != null ? pcr.toFixed(3) : '—'} color={pcrColor} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="NIFTY50 % (vs prev close)"
          value={chartData.length ? `${chartData[chartData.length - 1].spotPct >= 0 ? '+' : ''}${chartData[chartData.length - 1].spotPct.toFixed(2)}%` : '—'}
          color={chartData.length && chartData[chartData.length - 1].spotPct >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="Corr (PCR vs %)"
          value={corr != null ? `${corr >= 0 ? '+' : ''}${corr.toFixed(3)}` : '—'}
          sub={corr == null ? undefined : Math.abs(corr) >= 0.6 ? (corr > 0 ? 'Strong positive' : 'Strong negative') : 'Weak / mixed'}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Expiry" value={response?.expiry || '—'} />

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {date && (
            <span className="text-[10px] font-bold text-zinc-400 bg-zinc-800/80 border border-zinc-700 px-2.5 py-1 rounded-full tracking-widest uppercase">
              DATA: {date}
            </span>
          )}
          {chartData.length > 0 && (
            <span className="text-[10px] text-zinc-400 tabular-nums">
              {chartData.length} pt{chartData.length !== 1 ? 's' : ''} · refreshes every 60s
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            CSV
          </span>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
          Accumulating data — first point appears within 30s of collector start…
        </div>
      ) : (
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">PCR vs NIFTY50 % — intraday correlation</p>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                Put/Call OI ratio (ATM ±{response?.wings ?? 10} strikes) against NIFTY50&apos;s % move from open,
                indexed onto the PCR axis so both lines share one scale
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-semibold flex-wrap">
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 h-0.5 rounded-full" style={{ background: PCR_COLOR }} />
                <span className="text-zinc-300">PCR</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3.5 h-0.5 rounded-full" style={{ background: NIFTY_COLOR }} />
                <span className="text-zinc-300">NIFTY50 %</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: ZONE_GREEN, opacity: 0.5 }} />
                <span className="text-zinc-400">PCR ±0.2 (neutral)</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: ZONE_AMBER, opacity: 0.5 }} />
                <span className="text-zinc-400">0.2–0.4 from 1</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: ZONE_RED, opacity: 0.5 }} />
                <span className="text-zinc-400">&gt;0.4 from 1</span>
              </span>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              {zones.map((z, i) => (
                <ReferenceArea key={i} y1={z.from} y2={z.to} fill={z.color} fillOpacity={0.09} strokeWidth={0} />
              ))}
              <CartesianGrid strokeDasharray="4 4" stroke={GRID} vertical={false} />
              <XAxis
                dataKey="ts" type="number" scale="time" domain={[xStart, xEnd]}
                ticks={sessionTicks} tickFormatter={fmtTick} allowDataOverflow={false}
                tick={{ fontSize: 10, fill: AXIS, fontWeight: 500 }} tickLine={false}
                axisLine={{ stroke: GRID }}
              />
              <YAxis
                dataKey="pcr" domain={domain} tickFormatter={(v: number) => v.toFixed(1)}
                tick={{ fontSize: 10, fill: AXIS, fontWeight: 500 }} tickLine={false}
                axisLine={false} width={40} label={{ value: 'PCR', position: 'insideTopLeft', fill: AXIS, fontSize: 10, dy: -4 }}
              />
              <ReferenceLine y={1} stroke="#71717a" strokeDasharray="3 4" strokeWidth={1} />
              <Tooltip content={<PCRTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
              <Line type="monotone" dataKey="pcr" name="PCR" stroke={PCR_COLOR} strokeWidth={2}
                dot={false} connectNulls activeDot={{ r: 4, fill: PCR_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
              <Line type="monotone" dataKey="niftyNorm" name="NIFTY50 %" stroke={NIFTY_COLOR} strokeWidth={2}
                dot={false} connectNulls activeDot={{ r: 4, fill: NIFTY_COLOR, stroke: '#18181b', strokeWidth: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
