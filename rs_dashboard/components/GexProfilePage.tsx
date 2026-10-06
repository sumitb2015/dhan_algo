'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Cell, LabelList,
} from 'recharts';
import NavBar from './NavBar';
import DataChip from './DataChip';
import { PulseStat, ChartHeader } from './QuantPanel';
import { useMarketLive } from '@/lib/useMarketLive';
import { expiryEpochMs, rollForward } from '@/lib/optionsPricing';
import {
  buildGexRows, forwardFromSpot, fmtGex, gexChecklist, gexLevels, wallClarity, type ChecklistTone, type GexChainEntry, type GexLevels, type GexPower, type GexRow,
} from '@/lib/gex';
import {
  buildGexLegs, dynamicFlip, emConfluence, expectedMove, mergeGexRows, regimeNote, spotSideWalls, topWalls, wallRank, type GexLeg,
} from '@/lib/gexV2';

const UNDERLYING = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS = 15_000;
const RANGE_OPTIONS = [8, 12, 20, 30] as const;
const SCOPE_OPTIONS = [1, 2, 3] as const;
const EM_TOLERANCE = 0.25;

/** A GexRow plus the OI figures the charts show (lots at the current lot size, or units when the lot is unknown). */
interface GexViewRow extends GexRow { ceOiView: number; peOiView: number }

type ChainOc = Record<string, GexChainEntry & { ce?: { last_price?: number | null } | null; pe?: { last_price?: number | null } | null }>;

interface ChainPayload {
  /** The expiry this response was requested for; a response for another expiry must never be rendered. */
  reqExpiry?: string;
  /** The expiry this chain belongs to (aggregate scope fetches several). */
  expiry?: string;
  chain: { oc?: ChainOc };
  spot: number;
  future_price?: number;
  future_expiry?: string;
}

const fmtStrike = (n: number) => n.toLocaleString('en-IN');
const fmtOi = (n: number) => fmtGex(n);
/** Value label for a bar: above a positive bar, below a negative one, horizontal. */
const barValueLabel = (props: Record<string, unknown>) => {
  const { x, y, width, height, value } = props as { x: number; y: number; width: number; height: number; value: number };
  const v = Number(value);
  if (!Number.isFinite(v) || v === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const top = Math.min(y, y + height);
  const bottom = Math.max(y, y + height);
  const cx = x + width / 2;
  const py = v > 0 ? top - 6 : bottom + 10;
  return (
    <text x={cx} y={py} textAnchor="middle"
      fontSize={9} fontWeight={600} fontFamily="var(--font-mono)" fill="var(--color-zinc-300)">{fmtGex(v)}</text>
  );
};

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

export default function GexProfilePage() {
  const live = useMarketLive(UNDERLYING);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [lot, setLot] = useState<number | null | undefined>(undefined); // undefined = still loading, null = unknown
  const [power, setPower] = useState<GexPower>(2);
  const [range, setRange] = useState<number>(12);
  const [showValues, setShowValues] = useState(false);
  useEffect(() => {
    // Deferred a task so no setState runs during the effect pass (same pattern as the fetch effects below).
    const t = setTimeout(() => { try { setShowValues(localStorage.getItem('gex_show_values') === '1'); } catch { /* storage blocked */ } }, 0);
    return () => clearTimeout(t);
  }, []);
  const toggleValues = () => setShowValues(v => {
    const n = !v;
    try { localStorage.setItem('gex_show_values', n ? '1' : '0'); } catch { /* storage blocked */ }
    return n;
  });
  const [scope, setScope] = useState<number>(1);
  const [payload, setPayload] = useState<{ key: string; items: ChainPayload[] } | null>(null);
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

  // Single scope = the selected expiry; aggregate scope = the nearest N open expiries (the selector is then ignored).
  const scopeExpiries = useMemo(() => (scope <= 1 ? (expiry ? [expiry] : []) : expiries.slice(0, scope)), [scope, expiry, expiries]);
  const reqKey = scopeExpiries.join('|');

  const fetchAll = useCallback(async () => {
    if (!scopeExpiries.length) return;
    const mine = ++seq.current;
    try {
      const items: ChainPayload[] = [];
      // Sequential: the chain route is rate limited (1 call / 3 s account-wide) and caches each expiry for 30 s.
      for (const ex of scopeExpiries) {
        const res = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${ex}`);
        const j = await res.json() as { success: boolean; data?: ChainPayload; error?: string };
        if (mine !== seq.current) return; // a newer request owns the screen
        if (!j.success || !j.data?.chain?.oc) { setError(j.error ?? `No chain data for ${ex}`); return; }
        items.push({ ...j.data, expiry: ex });
      }
      setPayload({ key: scopeExpiries.join('|'), items });
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
  }, [scopeExpiries]);

  useEffect(() => {
    if (!scopeExpiries.length) return;
    // Deferred a task so no setState runs during the effect pass (same pattern as useMarketLive).
    const first = setTimeout(() => { void fetchAll(); }, 0);
    return () => clearTimeout(first);
  }, [scopeExpiries, fetchAll]);

  useEffect(() => {
    if (!scopeExpiries.length || !live) return;
    const id = setInterval(() => { if (!document.hidden) void fetchAll(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) void fetchAll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [scopeExpiries, live, fetchAll]);

  // A response fetched for another expiry/scope (still in flight when the selection changed) is ignored, not rendered.
  const items = payload && payload.key === reqKey ? payload.items : null;
  const head = items?.[0] ?? null;
  const spot = head?.spot ?? 0;

  // Black-76 wants the future that matches each chain; fall back to spot only when no future was returned.
  // The returned future is usually a later contract than the chain's expiry (monthly future, weekly chain), so roll it to
  // the chain's own expiry; Black-76 with the wrong forward shifts every gamma.
  const underlyingFor = useCallback((c: ChainPayload, ex: string) => (
    c.future_price && c.future_price > 0 && c.future_expiry ? rollForward(c.future_price, c.future_expiry, ex) : forwardFromSpot(c.spot, ex)
  ), []);
  const isFut = !!(head?.future_price && head.future_price > 0 && head.future_expiry);
  const headExpiry = head?.expiry ?? expiry;
  const underlying = head ? underlyingFor(head, headExpiry) : 0;
  // With no future price (typically after hours) the forward is spot carried to expiry (S*e^{rT}): still an estimate, so flagged.
  const approxForward = !!head && !isFut;

  // GEX is always built from OI in units (Dhan's convention, never guessed). Charts show lots when the lot size is known.
  const oiDiv = lot && lot > 0 ? lot : 1;
  const oiLabel = oiDiv > 1 ? 'lots' : 'units';
  // Anchor the window on spot; with a transient spot of 0 fall back to the forward so the chart does not blank.
  const anchor = spot > 0 ? spot : underlying;

  const model = useMemo(() => {
    const empty = {
      rows: [] as GexViewRow[], levels: gexLevels([], spot), clarity: { call: wallClarity([]), put: wallClarity([]) }, outside: [] as string[],
      walls: spotSideWalls([], spot), top: { call: [], put: [] } as ReturnType<typeof topWalls>,
      flip: null as number | null, strikeFlip: null as number | null, em: null as ReturnType<typeof expectedMove>, emExpiry: '',
      confluence: [] as ReturnType<typeof emConfluence>, regime: 'unknown' as GexLevels['regime'], totalNet: 0,
    };
    if (!items || !(spot > 0)) return empty;
    const perExpiry = items.map(c => {
      const ex = c.expiry ?? expiry;
      const u = underlyingFor(c, ex);
      return { c, ex, u, rows: u > 0 ? buildGexRows(c.chain.oc!, { expiry: ex, underlying: u, lotSize: lot, power }) : [], legs: u > 0 ? buildGexLegs(c.chain.oc!, { expiry: ex, underlying: u, spot: c.spot > 0 ? c.spot : spot }) : [] as GexLeg[] };
    });
    const all = mergeGexRows(perExpiry.map(x => x.rows));
    if (!all.length) return empty;
    const legs = perExpiry.flatMap(x => x.legs);
    const centre = Math.round(anchor / STRIKE_STEP) * STRIKE_STEP;
    const lv = gexLevels(all, spot); // v1 levels: strike-profile flip, global-max walls, pin, total net
    const walls = spotSideWalls(all, spot);
    const top = topWalls(all, spot, 3);
    const dyn = dynamicFlip(legs, spot, { power });
    const flip = dyn.flip;
    const regime: GexLevels['regime'] = flip != null ? (spot >= flip ? 'positive' : 'negative') : (lv.totalNet >= 0 ? 'positive' : 'negative');
    const nearest = perExpiry[0];
    const em = expectedMove(nearest.c.chain.oc!, { spot, underlying: nearest.u, expiry: nearest.ex });
    const confluence = em ? emConfluence([
      { label: 'Call wall', value: walls.callWall },
      { label: 'Put wall', value: walls.putWall },
      { label: 'Gamma flip', value: flip },
    ], em, EM_TOLERANCE) : [];
    const cl = {
      call: wallClarity(all.filter(r => r.strike >= spot).map(r => ({ strike: r.strike, v: r.ceGex }))),
      put: wallClarity(all.filter(r => r.strike <= spot).map(r => ({ strike: r.strike, v: -r.peGex }))),
    };
    const inWin = (k: number | null) => k == null || Math.abs(k - centre) <= range * STRIKE_STEP;
    const out: string[] = [];
    if (!inWin(walls.callWall)) out.push(`call wall ${walls.callWall}`);
    if (!inWin(walls.putWall)) out.push(`put wall ${walls.putWall}`);
    if (!inWin(lv.pin)) out.push(`pin ${lv.pin}`);
    if (!inWin(flip == null ? null : Math.round(flip))) out.push(`flip ${Math.round(flip!)}`);
    const win: GexViewRow[] = all
      .filter(r => Math.abs(r.strike - centre) <= range * STRIKE_STEP)
      .map(r => ({ ...r, ceOiView: r.ceOi / oiDiv, peOiView: r.peOi / oiDiv }));
    return { rows: win, levels: lv, clarity: cl, outside: out, walls, top, flip, strikeFlip: lv.flip, em, emExpiry: nearest.ex, confluence, regime, totalNet: lv.totalNet };
  }, [items, lot, spot, anchor, expiry, power, range, oiDiv, underlyingFor]);
  const { rows, levels, clarity, outside, walls, top, flip, strikeFlip, em, emExpiry, confluence, regime, totalNet } = model;

  const atm = spot > 0 ? Math.round(spot / STRIKE_STEP) * STRIKE_STEP : 0;
  // Regime comes from spot vs the flip; the checklist's first tile uses the whole-chain total. Say so when they disagree.
  // v2 levels: walls on their side of spot, flip from the hypothetical-spot recompute, regime from spot vs that flip.
  const levelsV2: GexLevels = { ...levels, callWall: walls.callWall, putWall: walls.putWall, flip, regime };
  // Regime comes from spot vs the flip; the checklist's first tile uses the whole-chain total. Say so when they disagree.
  const regimeMismatch = regime !== 'unknown' && flip != null && (totalNet > 0) !== (regime === 'positive');

  const checklist = gexChecklist({ levels: levelsV2, spot, vix, call: clarity.call, put: clarity.put });

  const regimeCls = regime === 'positive' ? TONE_CLS.ok : regime === 'negative' ? TONE_CLS.bad : TONE_CLS.manual;
  const regimeLabel = regime === 'positive' ? 'POSITIVE GAMMA · dealers dampen'
    : regime === 'negative' ? 'NEGATIVE GAMMA · dealers amplify' : 'REGIME UNKNOWN';

  const xAxisProps = {
    dataKey: 'strike' as const,
    tickFormatter: fmtStrike,
    tick: { fontSize: 10, fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine: false,
    interval: 'preserveStartEnd' as const,
    minTickGap: 18,
  };
  const numFmt = (v: number) => fmtGex(v);
  const flipRef = flip != null && rows.length ? flip : null;
  const strikeFlipRef = strikeFlip != null && rows.length ? strikeFlip : null;
  // A reference line on a category axis must sit on a real category: snap the flip to the nearest strike in view.
  const nearestStrike = (x: number) => rows.reduce((b, r) => (Math.abs(r.strike - x) < Math.abs(b - x) ? r.strike : b), rows[0]?.strike ?? x);
  const inView = (x: number) => rows.length > 0 && x >= rows[0].strike - STRIKE_STEP / 2 && x <= rows[rows.length - 1].strike + STRIKE_STEP / 2;

  // Shared annotations for the two GEX charts: spot, flip band (zone, not a line), strike-profile flip (v1, for comparison),
  // and the expected-move bands. Returned as a keyed array because recharts reads its direct children.
  const overlays = (labels: boolean) => {
    const out: React.ReactNode[] = [];
    if (atm > 0) out.push(<ReferenceLine key="spot" x={nearestStrike(spot)} stroke="var(--color-zinc-400)" strokeDasharray="5 4" label={labels ? { value: `SPOT ${spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}`, position: 'top', fontSize: 10, fontWeight: 700 } : undefined} />);
    // A level outside the strike window is not drawn (snapping it to the edge would pass it off as a real level); the
    // "outside the window" notice above the chart lists it instead.
    if (flipRef != null && inView(flipRef)) {
      // Band half-width 0.3% of spot, widened to one strike each side when both ends land on the same strike.
      const tol = spot * 0.003;
      let lo = nearestStrike(flipRef - tol);
      let hi = nearestStrike(flipRef + tol);
      if (lo === hi) { lo = nearestStrike(lo - STRIKE_STEP); hi = nearestStrike(hi + STRIKE_STEP); }
      // At the very edge of the window both ends can still coincide: a zero-width area draws nothing, so skip it.
      if (lo !== hi) out.push(<ReferenceArea key="flipband" x1={lo} x2={hi} fill="#fbbf24" fillOpacity={0.12} stroke="none" />);
      out.push(<ReferenceLine key="flip" x={nearestStrike(flipRef)} stroke="#fbbf24" strokeWidth={2} label={labels ? { value: `FLIP ${Math.round(flipRef)}`, position: 'insideBottomRight', fontSize: 10, fontWeight: 700, fill: '#fbbf24' } : undefined} />);
    }
    if (strikeFlipRef != null && inView(strikeFlipRef) && (flipRef == null || !inView(flipRef) || nearestStrike(strikeFlipRef) !== nearestStrike(flipRef))) {
      out.push(<ReferenceLine key="sflip" x={nearestStrike(strikeFlipRef)} stroke="#fbbf24" strokeDasharray="2 4" label={labels ? { value: `STRIKE FLIP ${Math.round(strikeFlipRef)}`, position: 'insideTopLeft', fontSize: 9, fontWeight: 600, fill: '#fbbf24' } : undefined} />);
    }
    if (em) {
      if (inView(em.upper)) out.push(<ReferenceLine key="emu" x={nearestStrike(em.upper)} stroke="var(--color-sky-400)" strokeDasharray="6 3" label={labels ? { value: `EM + ${Math.round(em.upper)}`, position: 'insideTopRight', fontSize: 9, fontWeight: 700, fill: 'var(--color-sky-400)' } : undefined} />);
      if (inView(em.lower)) out.push(<ReferenceLine key="eml" x={nearestStrike(em.lower)} stroke="var(--color-sky-400)" strokeDasharray="6 3" label={labels ? { value: `EM − ${Math.round(em.lower)}`, position: 'insideTopLeft', fontSize: 9, fontWeight: 700, fill: 'var(--color-sky-400)' } : undefined} />);
    }
    return out;
  };
  // Wall cell outline: the spot-side wall is bold, the 2nd/3rd largest walls on that side are thin.
  const wallStroke = (strike: number, side: 'call' | 'put') => {
    const primary = side === 'call' ? walls.callWall : walls.putWall;
    if (strike === primary) return { stroke: side === 'call' ? '#fecaca' : '#a7f3d0', w: 2 };
    if (wallRank(side === 'call' ? top.call : top.put, strike) != null) return { stroke: side === 'call' ? '#fecaca' : '#a7f3d0', w: 1 };
    return { stroke: 'transparent', w: 0 };
  };

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
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">GEX Profile <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold border border-sky-500/40 bg-sky-500/10 text-sky-400 align-middle">v2</span></h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Spot-side walls, zero-gamma flip and expected move (compare with GEX OI Chart)</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DataChip date={dataDate} lastSession={!live} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
            <select value={expiry} disabled={scope > 1} title={scope > 1 ? 'Aggregate scope uses the nearest expiries' : undefined} onChange={e => { setLoading(true); setExpiry(e.target.value); }}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums">
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Scope</span>
            <select value={scope} onChange={e => { setLoading(true); setScope(Number(e.target.value)); }}
              title="Single expiry, or the summed GEX of the nearest N expiries (0DTE and the next weeklies all hedge together)"
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500">
              {SCOPE_OPTIONS.map(n => <option key={n} value={n}>{n === 1 ? 'Single expiry' : `Nearest ${n} expiries`}</option>)}
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
          <button
            role="switch"
            aria-checked={showValues}
            onClick={toggleValues}
            title="Show or hide the values on the bars"
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Values</span>
            <span className={`relative inline-block w-7 h-4 rounded-full transition-colors ${showValues ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-oncolor transition-transform ${showValues ? 'translate-x-3' : ''}`} />
            </span>
          </button>
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
        {loading && !items ? (
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
                <PulseStat label="Call wall" value={walls.callWall ? fmtStrike(walls.callWall) : '—'} color="text-red-400" size="text-2xl"
                  sub={walls.callOverall != null && walls.callOverall !== walls.callWall ? `highest call GEX at/above spot · overall max ${fmtStrike(walls.callOverall)}` : 'resistance · highest call GEX at/above spot'} />
                <PulseStat label="Put wall" value={walls.putWall ? fmtStrike(walls.putWall) : '—'} color="text-emerald-400" size="text-2xl"
                  sub={walls.putOverall != null && walls.putOverall !== walls.putWall ? `highest put GEX at/below spot · overall max ${fmtStrike(walls.putOverall)}` : 'support · highest put GEX at/below spot'} />
                <PulseStat label="Gamma flip" value={flip != null ? Math.round(flip).toLocaleString('en-IN') : '—'} color="text-amber-400" size="text-2xl"
                  sub={strikeFlip != null ? `re-priced at ±20% spots · strike-profile flip ${Math.round(strikeFlip).toLocaleString('en-IN')}` : 're-priced at ±20% spots'} />
                <PulseStat label="Expected move" value={em ? `±${Math.round(em.em).toLocaleString('en-IN')}` : '—'} color="text-sky-400" size="text-2xl"
                  sub={em ? `${emExpiry} ATM ${fmtStrike(em.strike)} straddle${em.source === 'model' ? ' (model price)' : ''} · ${Math.round(em.lower).toLocaleString('en-IN')} to ${Math.round(em.upper).toLocaleString('en-IN')}` : 'no ATM prices'} />
                <PulseStat label="Pin strike" value={levels.pin ? fmtStrike(levels.pin) : '—'} color="text-zinc-200" size="text-2xl" sub="largest call + put GEX" />
                <div className="ml-auto flex items-center gap-5 flex-wrap">
                  <PulseStat label="Net GEX" value={fmtGex(totalNet)} color={totalNet >= 0 ? 'text-emerald-400' : 'text-red-400'} size="text-sm" sub={`${POWER_UNIT[power]} per 1% move, whole chain`} />
                  <PulseStat label="Underlying" value={underlying > 0 ? underlying.toFixed(1) : '—'} size="text-sm" color="text-zinc-300" sub={isFut ? `future ${head?.future_expiry ?? ''} rolled to expiry · Black-76` : 'spot carried to expiry (no future): approximate'} />
                  <PulseStat label="Lot · OI unit" value={lot ? String(lot) : '—'} size="text-sm" color="text-zinc-300" sub={`OI charted in ${oiLabel}; GEX built from units`} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 px-5 py-2 border-t border-zinc-800 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold border ${regimeCls}`}>{regimeLabel}</span>
                  {regimeMismatch && (
                    <span className="text-[10px] text-amber-400">
                      spot is {regime === 'positive' ? 'above' : 'below'} the flip, but whole-chain net GEX is {totalNet > 0 ? 'positive' : 'negative'} ({fmtGex(totalNet)})
                    </span>
                  )}
                  {confluence.map(c => (
                    <span key={c.label} className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border border-sky-500/40 bg-sky-500/10 text-sky-400">
                      {c.label} {Math.round(c.value).toLocaleString('en-IN')} ≈ {c.band === 'upper' ? 'upper' : 'lower'} expected move ({Math.round(c.distance)} pts)
                    </span>
                  ))}
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
                  <ChartHeader eyebrow="Reading" title="Regime and walls" sub={`${regimeNote(regime)} Walls are not guaranteed floors or ceilings; they matter most where they line up with the expected move or another level.`} />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {([['Call walls', top.call, 'text-red-400'], ['Put walls', top.put, 'text-emerald-400']] as const).map(([title, list, cls]) => (
                      <div key={title} className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2">
                        <p className={`text-[10px] font-bold uppercase tracking-widest ${cls}`}>{title} · top 3</p>
                        <div className="mt-1.5 space-y-1">
                          {list.length === 0 && <p className="text-xs text-zinc-500">none</p>}
                          {list.map((w, i) => (
                            <div key={w.strike} className="flex items-center justify-between gap-3 text-xs font-mono tabular-nums">
                              <span className="text-zinc-400">#{i + 1}</span>
                              <span className="text-zinc-100 font-bold">{fmtStrike(w.strike)}</span>
                              <span className="text-zinc-300">{fmtGex(w.gex)}</span>
                              <span className={`text-[10px] font-sans font-bold ${w.broken ? 'text-amber-400' : 'text-zinc-500'}`}>
                                {w.broken ? (w.side === 'call' ? 'broken · now support' : 'broken · now resistance') : (w.side === 'call' ? 'above spot' : 'below spot')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
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
                    <ComposedChart data={rows} stackOffset="sign" margin={{ top: 48, right: 16, left: 0, bottom: 40 }}>
                      <CartesianGrid strokeDasharray="3 6" vertical={false} />
                      <XAxis {...xAxisProps} />
                      <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={numFmt} />
                      <Tooltip content={<GexTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                      <ReferenceLine y={0} stroke="var(--color-zinc-500)" />
                      {overlays(true)}
                      <Bar dataKey="ceGex" name="Call GEX" stackId="g" isAnimationActive={false}>
                        {rows.map(r => { const w = wallStroke(r.strike, 'call'); return <Cell key={r.strike} fill="#ef4444" stroke={w.stroke} strokeWidth={w.w} />; })}
                        {showValues && <LabelList dataKey="ceGex" content={barValueLabel as never} />}
                      </Bar>
                      <Bar dataKey="peGex" name="Put GEX" stackId="g" isAnimationActive={false}>
                        {rows.map(r => { const w = wallStroke(r.strike, 'put'); return <Cell key={r.strike} fill="#10b981" stroke={w.stroke} strokeWidth={w.w} />; })}
                        {showValues && <LabelList dataKey="peGex" content={barValueLabel as never} />}
                      </Bar>
                      <Line type="monotone" dataKey="netGex" name="Net GEX" stroke="#fbbf24" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                    <ChartHeader eyebrow="Net" title="Net dealer GEX by strike" sub="Call minus put. Red zone below the flip amplifies moves; green above dampens them." />
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={rows} margin={{ top: 48, right: 16, left: 0, bottom: 40 }}>
                        <CartesianGrid strokeDasharray="3 6" vertical={false} />
                        <XAxis {...xAxisProps} />
                        <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={numFmt} />
                        <Tooltip content={<GexTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        <ReferenceLine y={0} stroke="var(--color-zinc-500)" />
                        {overlays(false)}
                        <Bar dataKey="netGex" name="Net GEX" isAnimationActive={false}>
                          {rows.map(r => <Cell key={r.strike} fill={r.netGex >= 0 ? '#10b981' : '#ef4444'} />)}
                          {showValues && <LabelList dataKey="netGex" content={barValueLabel as never} />}
                        </Bar>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                    <ChartHeader eyebrow="Raw" title="Open interest by strike" sub="What the plain option chain shows, for comparison with the GEX walls." />
                    <ResponsiveContainer width="100%" height={300}>
                      <ComposedChart data={rows} margin={{ top: 40, right: 16, left: 0, bottom: 0 }} barGap={2}>
                        <CartesianGrid strokeDasharray="3 6" vertical={false} />
                        <XAxis {...xAxisProps} />
                        <YAxis tick={{ fontSize: 10, fontFamily: 'var(--font-mono)' }} tickLine={false} axisLine={false} width={58} tickFormatter={fmtOi} />
                        <Tooltip content={<OiTooltip oiLabel={oiLabel} />} cursor={{ fill: 'var(--chart-cursor-fill)', opacity: 0.5 }} />
                        {atm > 0 && <ReferenceLine x={nearestStrike(spot)} stroke="var(--color-zinc-400)" strokeDasharray="5 4" />}
                        <Bar dataKey="ceOiView" name="Call OI" fill="#ef4444" isAnimationActive={false}>
                          {showValues && <LabelList dataKey="ceOiView" content={barValueLabel as never} />}
                        </Bar>
                        <Bar dataKey="peOiView" name="Put OI" fill="#10b981" isAnimationActive={false}>
                          {showValues && <LabelList dataKey="peOiView" content={barValueLabel as never} />}
                        </Bar>
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
