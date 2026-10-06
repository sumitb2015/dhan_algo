'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';
import NavBar from './NavBar';
import DataChip from './DataChip';
import { PulseStat, ChartHeader } from './QuantPanel';
import { useMarketLive } from '@/lib/useMarketLive';
import { expiryEpochMs, rollForward } from '@/lib/optionsPricing';
import {
  buildGexRows, forwardFromSpot, fmtGex, gexChecklist, gexLevels, wallClarity, type ChecklistTone, type GexChainEntry, type GexPower, type GexRow,
} from '@/lib/gex';

const UNDERLYING = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS = 15_000;
const RANGE_OPTIONS = [8, 12, 20, 30] as const;

/** A GexRow plus the OI figures the charts show (lots at the current lot size, or units when the lot is unknown). */
interface GexViewRow extends GexRow { ceOiView: number; peOiView: number }

interface ChainPayload {
  /** The expiry this response was requested for; a response for another expiry must never be rendered. */
  reqExpiry?: string;
  chain: { oc?: Record<string, GexChainEntry> };
  spot: number;
  future_price?: number;
  future_expiry?: string;
}

const fmtStrike = (n: number) => n.toLocaleString('en-IN');
const fmtOi = (n: number) => fmtGex(n);
const POWER_UNIT: Record<number, string> = { 1: 'index units', 2: '₹' };

const GexTooltip = ({ active, payload, label, oiLabel }: Record<string, unknown> & { oiLabel: string }) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: GexViewRow }>)[0]?.payload;
  if (!row) return null;
  return (
    <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-4 py-3 text-xs shadow-2xl min-w-[200px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">Strike {fmtStrike(Number(label))}</p>
      <div className="flex justify-between gap-8 mb-1"><span className="text-red-400 font-sans">Call GEX</span><span className="text-white font-bold tabular-nums">{fmtGex(row.ceGex)}</span></div>
      <div className="flex justify-between gap-8 mb-1"><span className="text-emerald-400 font-sans">Put GEX</span><span className="text-white font-bold tabular-nums">{fmtGex(row.peGex)}</span></div>
      <div className="flex justify-between gap-8 mb-2 pt-2 border-t border-zinc-800"><span className="text-zinc-400 font-sans">Net GEX</span><span className={`font-bold tabular-nums ${row.netGex >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtGex(row.netGex)}</span></div>
      <div className="flex justify-between gap-8 mb-1 pt-2 border-t border-zinc-800"><span className="text-zinc-400 font-sans">CE OI ({oiLabel})</span><span className="text-white tabular-nums">{fmtOi(row.ceOiView)}</span></div>
      <div className="flex justify-between gap-8"><span className="text-zinc-400 font-sans">PE OI ({oiLabel})</span><span className="text-white tabular-nums">{fmtOi(row.peOiView)}</span></div>
    </div>
  );
};

const OiTooltip = ({ active, payload, label, oiLabel }: Record<string, unknown> & { oiLabel: string }) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: GexViewRow }>)[0]?.payload;
  if (!row) return null;
  return (
    <div className="bg-zinc-950 border border-zinc-700 rounded-xl px-4 py-3 text-xs shadow-2xl min-w-[170px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">Strike {fmtStrike(Number(label))}</p>
      <div className="flex justify-between gap-8 mb-1"><span className="text-red-400 font-sans">CE OI ({oiLabel})</span><span className="text-white font-bold tabular-nums">{fmtOi(row.ceOiView)}</span></div>
      <div className="flex justify-between gap-8"><span className="text-emerald-400 font-sans">PE OI ({oiLabel})</span><span className="text-white font-bold tabular-nums">{fmtOi(row.peOiView)}</span></div>
    </div>
  );
};

const TONE_CLS: Record<ChecklistTone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  bad: 'border-red-500/40 bg-red-500/10 text-red-400',
  manual: 'border-zinc-700 bg-zinc-800/60 text-zinc-400',
};

function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export default function GexOiPage() {
  const live = useMarketLive(UNDERLYING);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [lot, setLot] = useState<number | null | undefined>(undefined); // undefined = still loading, null = unknown
  const [power, setPower] = useState<GexPower>(2);
  const [range, setRange] = useState<number>(12);
  const [payload, setPayload] = useState<ChainPayload | null>(null);
  const [vix, setVix] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState<string | null>(null);
  const [dataDate, setDataDate] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (j.success && j.data?.length) {
          // Skip an expiry whose 15:40 IST close has already passed: its gamma is a clamped-time artefact, not a signal.
          const open = j.data.filter(e => expiryEpochMs(e) > Date.now());
          const list = open.length ? open : j.data;
          setExpiries(list);
          setExpiry(list[0]);
        }
        else setError(j.error ?? 'Failed to load expiries');
      })
      .catch(e => setError(String(e)));
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { lot_size?: number | null }) => setLot(j.lot_size && j.lot_size > 0 ? j.lot_size : null))
      .catch(() => setLot(null));
  }, []);

  const fetchAll = useCallback(async () => {
    if (!expiry) return;
    const mine = ++seq.current;
    try {
      const res = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const j = await res.json() as { success: boolean; data?: ChainPayload; error?: string };
      if (mine !== seq.current) return; // a newer request owns the screen
      if (!j.success || !j.data?.chain?.oc) { setError(j.error ?? 'No chain data'); return; }
      setPayload({ ...j.data, reqExpiry: expiry });
      setError('');
      setUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setDataDate(todayIST());
      fetch('/api/scalper/top-indices')
        .then(r => r.json())
        .then((t: { quotes?: Record<string, { ltp?: number }> }) => {
          const v = Number(t.quotes?.VIX?.ltp);
          if (mine === seq.current) setVix(v > 0 ? v : null);
        })
        // A failed read clears the value: a stale VIX would keep the checklist tile green on old data.
        .catch(() => { if (mine === seq.current) setVix(null); });
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    if (!expiry) return;
    // Deferred a task so no setState runs during the effect pass (same pattern as useMarketLive).
    const first = setTimeout(() => { void fetchAll(); }, 0);
    return () => clearTimeout(first);
  }, [expiry, fetchAll]);

  useEffect(() => {
    if (!expiry || !live) return;
    const id = setInterval(() => { if (!document.hidden) void fetchAll(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) void fetchAll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [expiry, live, fetchAll]);

  // A response fetched for another expiry (still in flight when the select changed) is ignored, not rendered.
  const chain = payload && payload.reqExpiry === expiry ? payload : null;
  const spot = chain?.spot ?? 0;
  // Black-76 wants the future that matches this chain; fall back to spot only when no future was returned.
  const isFut = !!(chain?.future_price && chain.future_price > 0 && chain.future_expiry);
  // The returned future is usually a later contract than the chain's expiry (monthly future, weekly chain), so roll it to
  // the chain's own expiry; Black-76 with the wrong forward shifts every gamma.
  const underlying = isFut ? rollForward(chain!.future_price!, chain!.future_expiry!, expiry) : forwardFromSpot(spot, expiry);
  // With no future price (typically after hours) the forward is spot carried to expiry (S*e^{rT}): still an estimate, so flagged.
  const approxForward = !!chain && !isFut;

  // GEX is always built from OI in units (Dhan's convention, never guessed). Charts show lots when the lot size is known.
  const oiDiv = lot && lot > 0 ? lot : 1;
  const oiLabel = oiDiv > 1 ? 'lots' : 'units';
  // Anchor the window on spot; with a transient spot of 0 fall back to the forward so the chart does not blank.
  const anchor = spot > 0 ? spot : underlying;

  const { rows, levels, clarity, outside } = useMemo(() => {
    if (!chain?.chain.oc || !(underlying > 0)) {
      return { rows: [] as GexViewRow[], levels: gexLevels([], spot), clarity: { call: wallClarity([]), put: wallClarity([]) }, outside: [] as string[] };
    }
    const all = buildGexRows(chain.chain.oc, { expiry, underlying, lotSize: lot, power });
    const centre = Math.round(anchor / STRIKE_STEP) * STRIKE_STEP;
    // Levels and wall clarity both come from the whole chain, so the checklist describes the walls actually reported.
    const lv = gexLevels(all, spot);
    const cl = {
      call: wallClarity(all.map(r => ({ strike: r.strike, v: r.ceGex }))),
      put: wallClarity(all.map(r => ({ strike: r.strike, v: -r.peGex }))),
    };
    const inWin = (k: number | null) => k == null || Math.abs(k - centre) <= range * STRIKE_STEP;
    const out: string[] = [];
    if (!inWin(lv.callWall)) out.push(`call wall ${lv.callWall}`);
    if (!inWin(lv.putWall)) out.push(`put wall ${lv.putWall}`);
    if (!inWin(lv.pin)) out.push(`pin ${lv.pin}`);
    if (!inWin(lv.flip == null ? null : Math.round(lv.flip))) out.push(`flip ${Math.round(lv.flip!)}`);
    const win: GexViewRow[] = all
      .filter(r => Math.abs(r.strike - centre) <= range * STRIKE_STEP)
      .map(r => ({ ...r, ceOiView: r.ceOi / oiDiv, peOiView: r.peOi / oiDiv }));
    return { rows: win, levels: lv, clarity: cl, outside: out };
  }, [chain, lot, underlying, spot, anchor, expiry, power, range, oiDiv]);

  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : 0;
  // Regime comes from spot vs the flip; the checklist's first tile uses the whole-chain total. Say so when they disagree.
  const regimeMismatch = levels.regime !== 'unknown' && levels.flip != null && (levels.totalNet > 0) !== (levels.regime === 'positive');

  const checklist = gexChecklist({ levels, spot, vix, call: clarity.call, put: clarity.put });

  const regimeCls = levels.regime === 'positive' ? TONE_CLS.ok : levels.regime === 'negative' ? TONE_CLS.bad : TONE_CLS.manual;
  const regimeLabel = levels.regime === 'positive' ? 'POSITIVE GAMMA · dealers dampen'
    : levels.regime === 'negative' ? 'NEGATIVE GAMMA · dealers amplify' : 'REGIME UNKNOWN';

  const xAxisProps = {
    dataKey: 'strike' as const,
    tickFormatter: fmtStrike,
    tick: { fontSize: 10, fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine: false,
    interval: 'preserveStartEnd' as const,
    minTickGap: 18,
  };
  const numFmt = (v: number) => fmtGex(v);
  const flipRef = levels.flip != null && rows.length ? levels.flip : null;
  // A reference line on a category axis must sit on a real category: snap the flip to the nearest strike in view.
  const nearestStrike = (x: number) => rows.reduce((b, r) => (Math.abs(r.strike - x) < Math.abs(b - x) ? r.strike : b), rows[0]?.strike ?? x);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">Options · {UNDERLYING}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">GEX OI Chart</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Gamma-weighted open interest: call wall, put wall, gamma flip</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DataChip date={dataDate} lastSession={!live} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
            <select value={expiry} onChange={e => { setLoading(true); setExpiry(e.target.value); }}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums">
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strikes ±</span>
            <select value={range} onChange={e => setRange(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500">
              {RANGE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">GEX in</span>
            <select value={power} onChange={e => setPower(Number(e.target.value) as GexPower)}
              title="₹ notional = gamma x OI units x spot² x 0.01. Index units = the video's formula (spot once), the number of units dealers trade per 1% move. Walls and flip are identical either way."
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500">
              <option value={2}>₹ notional</option>
              <option value={1}>index units (video)</option>
            </select>
          </label>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
      )}
      {lot === null && (
        <div className="mx-6 mt-3 px-3 py-2 bg-amber-900/20 border border-amber-700/40 rounded-lg text-xs text-amber-400">
          Lot size is unknown. GEX is unaffected (Dhan reports OI in units), but OI is shown in units, not lots, and is never defaulted.
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {loading && !chain ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400 font-medium">Loading option chain…</p>
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <div className="flex items-stretch gap-6 px-5 py-4 flex-wrap">
                <PulseStat label={`${UNDERLYING} spot`} value={spot > 0 ? spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} size="text-2xl" />
                <div className="w-px bg-zinc-800 self-stretch" />
                <PulseStat label="Call wall" value={levels.callWall ? fmtStrike(levels.callWall) : '—'} color="text-red-400" size="text-2xl" sub="resistance · highest call GEX" />
                <PulseStat label="Put wall" value={levels.putWall ? fmtStrike(levels.putWall) : '—'} color="text-emerald-400" size="text-2xl" sub="support · highest put GEX" />
                <PulseStat label="Gamma flip" value={levels.flip != null ? Math.round(levels.flip).toLocaleString('en-IN') : '—'} color="text-amber-400" size="text-2xl" sub="net GEX zero crossing" />
                <PulseStat label="Pin strike" value={levels.pin ? fmtStrike(levels.pin) : '—'} color="text-zinc-200" size="text-2xl" sub="largest call + put GEX" />
                <div className="ml-auto flex items-center gap-5 flex-wrap">
                  <PulseStat label="Net GEX" value={fmtGex(levels.totalNet)} color={levels.totalNet >= 0 ? 'text-emerald-400' : 'text-red-400'} size="text-sm" sub={`${POWER_UNIT[power]} per 1% move, whole chain`} />
                  <PulseStat label="Underlying" value={underlying > 0 ? underlying.toFixed(1) : '—'} size="text-sm" color="text-zinc-300" sub={isFut ? `future ${chain?.future_expiry ?? ''} rolled to expiry · Black-76` : 'spot carried to expiry (no future): approximate'} />
                  <PulseStat label="Lot · OI unit" value={lot ? String(lot) : '—'} size="text-sm" color="text-zinc-300" sub={`OI charted in ${oiLabel}; GEX built from units`} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-2 border-t border-zinc-800 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${regimeCls}`}>{regimeLabel}</span>
                  {regimeMismatch && (
                    <span className="text-[10px] text-amber-400">
                      spot is {levels.regime === 'positive' ? 'above' : 'below'} the flip, but whole-chain net GEX is {levels.totalNet > 0 ? 'positive' : 'negative'} ({fmtGex(levels.totalNet)})
                    </span>
                  )}
                  {approxForward && <span className="text-[10px] text-amber-400">no future price: forward estimated from spot with cost of carry (approximate)</span>}
                </div>
                {updated && <span className="text-[10px] text-zinc-500 font-mono tabular-nums">Updated {updated}{live ? '' : ' · market closed, not polling'}</span>}
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
                No GEX data for this expiry
              </div>
            ) : (
              <>
                {outside.length > 0 && (
                  <div className="px-3 py-2 bg-amber-900/20 border border-amber-700/40 rounded-lg text-xs text-amber-400">
                    Outside the ±{range} strike window (see KPIs): {outside.join(', ')}. Widen the window to see them.
                  </div>
                )}
                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                  <ChartHeader
                    eyebrow="Gamma exposure"
                    title="Call vs put GEX by strike"
                    sub={`Bars: dealer hedge size per 1% move, in ${POWER_UNIT[power]} (calls positive, puts negative). Line: net. Assumes dealers are long calls and short puts.`}
                    legend={<>
                      <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-red-500" /><span className="text-zinc-300">Call GEX</span></span>
                      <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-500" /><span className="text-zinc-300">Put GEX</span></span>
                      <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-amber-400" /><span className="text-zinc-300">Net GEX</span></span>
                    </>}
                  />
                  <ResponsiveContainer width="100%" height={400}>
                    <ComposedChart data={rows} stackOffset="sign" margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 6" vertical={false} />
                      <XAxis {...xAxisProps} />
                      <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={numFmt} />
                      <Tooltip content={<GexTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                      <ReferenceLine y={0} stroke="var(--color-zinc-500)" />
                      {atm > 0 && <ReferenceLine x={nearestStrike(spot)} stroke="var(--color-zinc-400)" strokeDasharray="5 4" label={{ value: `SPOT ${spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}`, position: 'top', fontSize: 10, fontWeight: 700 }} />}
                      {flipRef != null && <ReferenceLine x={nearestStrike(flipRef)} stroke="#fbbf24" strokeWidth={2} label={{ value: `FLIP ${Math.round(flipRef)}`, position: 'insideBottomRight', fontSize: 10, fontWeight: 700, fill: '#fbbf24' }} />}
                      <Bar dataKey="ceGex" name="Call GEX" stackId="g" isAnimationActive={false}>
                        {rows.map(r => <Cell key={r.strike} fill="#ef4444" stroke={r.strike === levels.callWall ? '#fecaca' : 'transparent'} strokeWidth={r.strike === levels.callWall ? 2 : 0} />)}
                      </Bar>
                      <Bar dataKey="peGex" name="Put GEX" stackId="g" isAnimationActive={false}>
                        {rows.map(r => <Cell key={r.strike} fill="#10b981" stroke={r.strike === levels.putWall ? '#a7f3d0' : 'transparent'} strokeWidth={r.strike === levels.putWall ? 2 : 0} />)}
                      </Bar>
                      <Line type="monotone" dataKey="netGex" name="Net GEX" stroke="#fbbf24" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                    <ChartHeader eyebrow="Net" title="Net dealer GEX by strike" sub="Call minus put. Red zone below the flip amplifies moves; green above dampens them." />
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={rows} margin={{ top: 20, right: 16, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 6" vertical={false} />
                        <XAxis {...xAxisProps} />
                        <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={numFmt} />
                        <Tooltip content={<GexTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        <ReferenceLine y={0} stroke="var(--color-zinc-500)" />
                        {atm > 0 && <ReferenceLine x={nearestStrike(spot)} stroke="var(--color-zinc-400)" strokeDasharray="5 4" label={{ value: `SPOT ${spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}`, position: 'top', fontSize: 10, fontWeight: 700 }} />}
                        {flipRef != null && <ReferenceLine x={nearestStrike(flipRef)} stroke="#fbbf24" strokeWidth={2} />}
                        <Bar dataKey="netGex" name="Net GEX" isAnimationActive={false}>
                          {rows.map(r => <Cell key={r.strike} fill={r.netGex >= 0 ? '#10b981' : '#ef4444'} />)}
                        </Bar>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                    <ChartHeader eyebrow="Raw" title="Open interest by strike" sub="What the plain option chain shows, for comparison with the GEX walls." />
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barGap={2}>
                        <CartesianGrid strokeDasharray="3 6" vertical={false} />
                        <XAxis {...xAxisProps} />
                        <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={fmtOi} />
                        <Tooltip content={<OiTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        {atm > 0 && <ReferenceLine x={nearestStrike(spot)} stroke="var(--color-zinc-400)" strokeDasharray="5 4" />}
                        <Bar dataKey="ceOiView" name="Call OI" fill="#ef4444" isAnimationActive={false} />
                        <Bar dataKey="peOiView" name="Put OI" fill="#10b981" isAnimationActive={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                  <ChartHeader eyebrow="Reference only" title="Strangle entry checklist" sub="From the source video. Informational: this page places no orders and the rule set is unvalidated." />
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                    {checklist.map(c => (
                      <div key={c.label} className={`rounded-xl border px-3 py-2 ${TONE_CLS[c.tone]}`}>
                        <p className="text-xs font-bold">{c.label}</p>
                        <p className="text-[10px] mt-1 text-zinc-300">{c.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
