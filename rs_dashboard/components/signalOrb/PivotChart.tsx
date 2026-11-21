'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { istClock } from '@/lib/istTime';
import { computePivots, PIVOT_FORMULAS, type PivotFormula } from '@/lib/pivotLevels';
import { pivotZone, type KeyLevels } from '@/lib/signalOrbPanels';

// The live price drawn against the previous session's CPR and R1-R4 / S1-S4 (lib/pivotLevels.ts, the Price Ladder's own maths), with
// today's price path across them. A level the day has already traded through is drawn solid, an untouched one dashed.
// Information only: nothing here changes a rule or sends an order.

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';
const FORMULA_KEY = 'signalOrb.pivotFormula';
const ZOOM_KEY = 'signalOrb.pivotZoom';
const FORMULA_LABEL: Record<PivotFormula, string> = { classic: 'Classic', traditional: 'Traditional', camarilla: 'Camarilla' };
const FORMULA_HINT: Record<PivotFormula, string> = {
  classic: 'R1-R4 / S1-S4 at P ± 1, 2, 3 ranges (TradingView Classic)',
  traditional: 'Floor-trader pivots: R3 / S3 reach further, R4 / S4 extend by the R2-R1 gap',
  camarilla: 'Tight levels around the close; R4 / S4 are the breakout lines',
};
const fmt = (n: number, dp = 1) => n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n: number, dp = 1) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}`;

const W = 420, H = 470, PAD_L = 8, PAD_R = 118, PAD_T = 14, PAD_B = 20;
const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;
const GAP = 11;

type Zoom = 'all' | 'near';
type Line = { key: string; label: string; price: number; group: 'r' | 's' | 'cpr' };

export function PivotPanel({ levels, price, path, symbol }: { levels: KeyLevels | null; price: number | null; path: { t: number; c: number }[]; symbol: string }) {
  const [formula, setFormula] = useState<PivotFormula>('classic');
  const [zoom, setZoom] = useState<Zoom>('near');
  // saved choices are read after mount, never during render, so the first render matches the server's
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const f = localStorage.getItem(FORMULA_KEY), z = localStorage.getItem(ZOOM_KEY);
        if (f && (PIVOT_FORMULAS as readonly string[]).includes(f)) setFormula(f as PivotFormula);
        if (z === 'all' || z === 'near') setZoom(z);
      } catch { /* defaults */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const pickFormula = (f: PivotFormula) => { setFormula(f); try { localStorage.setItem(FORMULA_KEY, f); } catch { /* best effort */ } };
  const pickZoom = (z: Zoom) => { setZoom(z); try { localStorage.setItem(ZOOM_KEY, z); } catch { /* best effort */ } };

  const set = useMemo(
    () => (levels && levels.prevHigh !== null && levels.prevLow !== null && levels.prevClose !== null ? computePivots(levels.prevHigh, levels.prevLow, levels.prevClose, formula) : null),
    [levels, formula],
  );

  const chart = useMemo(() => {
    if (!set) return null;
    const lines = ([
      { key: 'r4', label: 'R4', price: set.r4, group: 'r' }, { key: 'r3', label: 'R3', price: set.r3, group: 'r' }, { key: 'r2', label: 'R2', price: set.r2, group: 'r' }, { key: 'r1', label: 'R1', price: set.r1, group: 'r' },
      { key: 'tc', label: 'TC', price: set.tc, group: 'cpr' }, { key: 'p', label: 'P', price: set.p, group: 'cpr' }, { key: 'bc', label: 'BC', price: set.bc, group: 'cpr' },
      { key: 's1', label: 'S1', price: set.s1, group: 's' }, { key: 's2', label: 'S2', price: set.s2, group: 's' }, { key: 's3', label: 'S3', price: set.s3, group: 's' }, { key: 's4', label: 'S4', price: set.s4, group: 's' },
    ] as Line[]).sort((a, b) => b.price - a.price);
    const closes = path.map(p => p.c);
    if (price !== null) closes.push(price);
    let pool = lines.map(l => l.price);
    if (zoom === 'near' && price !== null) {
      const asc = [...pool].sort((a, b) => a - b);
      const idx = asc.filter(v => v <= price).length;
      // three levels at or below the price and the next one above it: the neighbourhood the price is trading in
      pool = asc.slice(Math.max(0, idx - 3), idx + 1);
    }
    const all = [...pool, ...closes];
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.04 || 1;
    lo -= pad; hi += pad;
    const y = (p: number) => PAD_T + ((hi - p) / (hi - lo)) * PLOT_H;
    // labels keep a minimum gap so close levels (a narrow CPR, Camarilla) stay readable
    const ly: Record<string, number> = {};
    let prev = -Infinity;
    // the live price takes a label row of its own in the margin, so it never sits on the path or on a level's label
    const rows = [...lines.map(l => ({ key: l.key, price: l.price })), ...(price !== null ? [{ key: '__px', price }] : [])]
      .filter(r => r.price >= lo && r.price <= hi)   // a level outside the zoomed range is not drawn and takes no label room
      .sort((a, b) => b.price - a.price);
    for (const r of rows) { const want = y(r.price); ly[r.key] = Math.max(want, prev + GAP); prev = ly[r.key]; }
    const t0 = path.length ? path[0].t : 0, t1 = path.length ? path[path.length - 1].t : 1;
    const x = (t: number) => PAD_L + (t1 > t0 ? ((t - t0) / (t1 - t0)) * PLOT_W : PLOT_W);
    const pts = path.map(p => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`);
    if (price !== null && path.length) pts.push(`${(PAD_L + PLOT_W).toFixed(1)},${y(price).toFixed(1)}`);
    return { lines, y, ly, pts: pts.join(' '), t0, t1, inRange: (p: number) => p >= lo && p <= hi };
  }, [set, path, price, zoom]);

  if (!levels || !set || !chart) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 backdrop-blur">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">CPR &amp; pivots</h2>
        <p className="mt-2 text-[11px] text-zinc-500">{levels ? 'Needs a previous session in the loaded bars.' : 'Loading bars…'}</p>
      </section>
    );
  }
  const zone = price !== null ? pivotZone(price, set) : null;
  const cprW = set.tc - set.bc;
  const touched = (p: number) => p >= levels.dayLow && p <= levels.dayHigh;
  const yPrice = price !== null ? chart.y(price) : null;
  const tone = (g: Line['group']) => (g === 'r' ? 'text-red-400' : g === 's' ? 'text-emerald-400' : 'text-sky-400');
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 backdrop-blur">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.25em] text-zinc-500">CPR &amp; pivots</h2>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Zoom" className="inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
            {(['all', 'near'] as const).map(z => (
              <button key={z} type="button" aria-pressed={zoom === z} onClick={() => pickZoom(z)}
                className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold', FOCUS, zoom === z ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{z === 'all' ? 'All' : 'Near'}</button>
            ))}
          </div>
        </div>
      </div>
      <div role="group" aria-label="Pivot formula" className="mb-2 inline-flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
        {PIVOT_FORMULAS.map(f => (
          <button key={f} type="button" aria-pressed={formula === f} onClick={() => pickFormula(f)} title={FORMULA_HINT[f]}
            className={cn('rounded px-2 py-0.5 text-[10px] font-bold', FOCUS, formula === f ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{FORMULA_LABEL[f]}</button>
        ))}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`Price ${price === null ? 'unknown' : fmt(price)} against the CPR and R1-R4, S1-S4 levels${zone ? `: ${zone.text}` : ''}`}>
        {/* the CPR band */}
        <rect x={PAD_L} y={chart.y(set.tc)} width={PLOT_W} height={Math.max(3, chart.y(set.bc) - chart.y(set.tc))} className="fill-sky-500/15" />
        {chart.lines.map(l => {
          const yy = chart.y(l.price);
          if (!chart.inRange(l.price)) return null;
          const stroke = l.group === 'r' ? 'stroke-red-500' : l.group === 's' ? 'stroke-emerald-500' : 'stroke-sky-400';
          return (
            <g key={l.key}>
              <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={yy} y2={yy} className={stroke} strokeWidth={l.key === 'p' ? 1.2 : 1} strokeDasharray={touched(l.price) ? undefined : '4 3'} opacity={touched(l.price) ? 0.9 : 0.55} />
              <text x={PAD_L + PLOT_W + 6} y={chart.ly[l.key] + 3} fontSize="10" fontWeight={700} className={cn('fill-current font-mono', tone(l.group))}>{l.label}</text>
              <text x={W - 4} y={chart.ly[l.key] + 3} fontSize="10" textAnchor="end" className="fill-zinc-300 font-mono">
                {fmt(l.price)}{price !== null ? ` ${signed(price - l.price, 0)}` : ''}
              </text>
            </g>
          );
        })}
        {/* today's path and the live price */}
        {chart.pts && <polyline points={chart.pts} fill="none" className="stroke-zinc-100" strokeWidth={1.4} strokeLinejoin="round" />}
        {yPrice !== null && price !== null && chart.ly.__px !== undefined && (
          <g>
            <line x1={PAD_L} x2={PAD_L + PLOT_W} y1={yPrice} y2={yPrice} className="stroke-zinc-100" strokeWidth={0.6} strokeDasharray="1 3" opacity={0.7} />
            {/* a pill in the label margin, joined to the dot (it moves off the exact height only to clear a neighbouring label) */}
            <polyline points={`${PAD_L + PLOT_W},${yPrice} ${PAD_L + PLOT_W + 4},${chart.ly.__px} ${PAD_L + PLOT_W + 8},${chart.ly.__px}`} fill="none" className="stroke-zinc-100" strokeWidth={0.8} />
            <rect x={PAD_L + PLOT_W + 8} y={chart.ly.__px - 7} width={W - (PAD_L + PLOT_W + 8) - 2} height={14} rx={3} className="fill-zinc-100" />
            <text x={PAD_L + PLOT_W + 8 + (W - (PAD_L + PLOT_W + 8) - 2) / 2} y={chart.ly.__px + 4} fontSize="11" fontWeight={800} textAnchor="middle" className="fill-zinc-950 font-mono">{fmt(price)}</text>
            <circle cx={PAD_L + PLOT_W} cy={yPrice} r={4.5} className="fill-zinc-100 stroke-zinc-950" strokeWidth={1.5} />
          </g>
        )}
        {/* time axis */}
        {chart.t1 > chart.t0 && (
          <>
            <text x={PAD_L} y={H - 5} fontSize="9" className="fill-zinc-600 font-mono">{istClock(chart.t0 * 1000).slice(0, 5)}</text>
            <text x={PAD_L + PLOT_W} y={H - 5} fontSize="9" textAnchor="end" className="fill-zinc-600 font-mono">{istClock(chart.t1 * 1000).slice(0, 5)}</text>
          </>
        )}
      </svg>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
        <dt className="text-zinc-500">Price is</dt>
        <dd className="text-right font-bold text-zinc-100">{zone ? zone.text : '—'}</dd>
        {zone?.above && <><dt className="text-zinc-500">Next up</dt><dd className="text-right text-red-300">{zone.above.label} {fmt(zone.above.price)} · {fmt(Math.abs(zone.above.dist))} pts away</dd></>}
        {zone?.below && <><dt className="text-zinc-500">Next down</dt><dd className="text-right text-emerald-300">{zone.below.label} {fmt(zone.below.price)} · {fmt(Math.abs(zone.below.dist))} pts away</dd></>}
        <dt className="text-zinc-500">CPR width</dt>
        <dd className="text-right text-zinc-300" title="A narrow CPR often comes before a trending day, a wide one before a range day">{fmt(cprW)} pts · {((cprW / set.p) * 100).toFixed(2)}%</dd>
      </dl>
      <p className="mt-2 text-[10px] text-zinc-600">
        {FORMULA_LABEL[formula]} levels from the {symbol} future&apos;s previous session ({levels.prevDay?.slice(5)}: H {fmt(levels.prevHigh as number)} · L {fmt(levels.prevLow as number)} · C {fmt(levels.prevClose as number)}), not the index. Solid = already traded through today, dashed = untouched. Dist. beside each price = live price minus level.
      </p>
    </section>
  );
}
