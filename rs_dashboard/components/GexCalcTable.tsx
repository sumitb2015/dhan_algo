'use client';

// "Calc table" button + modal for the GEX pages: every number that goes into each strike's gamma and GEX, so the maths can be
// checked by hand. Built by gexCalcTable() in lib/gex.ts, which is tested to sum to exactly what the charts draw.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sigma, X, Copy } from 'lucide-react';
import { fmtGex, type GexCalcSide, type GexCalcTable, type GexChainEntry } from '@/lib/gex';
// Type-only: erased at compile time, so GEX OI Chart (v1) never loads the Black-76 module through this component.
import type { GexModelCalcSide, GexModelCalcTable } from '@/lib/gexModel';

export interface GexCalcSet {
  expiry: string;
  oc: Record<string, GexChainEntry>;
  /** Index spot of this chain, the price multiplier in the video's formula. */
  spot: number;
  /** Rolled future for the Black-76 model. Only GEX v2 supplies it. */
  underlying?: number;
}

const WINDOWS = [8, 12, 20, 30, 0] as const; // 0 = every strike
const STRIKE_STEP = 50;
const SRC_LABEL: Record<string, string> = { own: 'own', 'otm-leg': 'OTM leg', 'other-leg': 'other leg', nearest: 'nearest strike' };

const n0 = (v: number) => v.toLocaleString('en-IN');
const sci = (v: number) => (v > 0 ? v.toExponential(4) : '—');
const fx = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '—');

interface ColDef { key: string; label: string; render: (x: GexCalcSide, t: GexCalcTable<GexCalcSide>) => string; cls: (x: GexCalcSide, tone: string) => string }
const plain = (c: string) => () => c;
const gexCls = (_: GexCalcSide, tone: string) => `font-bold ${tone}`;

const isModel = (t: GexCalcTable<GexCalcSide>): t is GexModelCalcTable => 'F' in t;
const mrow = (x: GexCalcSide) => x as GexModelCalcSide;

/**
 * The video's formula, every factor in its own column: GEX = Gamma x OI x Lot x Spot x 0.01 (slide 3).
 * Dhan reports OI in units (= lots x lot size), so OI(lots) x Lot is the OI(units) the formula really multiplies by.
 */
const DHAN_COLS: ColDef[] = [
  { key: 'oil', label: 'OI (lots)', render: (x, t) => (t.lot ? n0(x.oiUnits / t.lot) : '—'), cls: plain('text-zinc-300') },
  { key: 'lot', label: '× Lot', render: (_, t) => (t.lot ? String(t.lot) : '—'), cls: plain('text-zinc-500') },
  { key: 'oi', label: '= OI (units)', render: x => n0(x.oiUnits), cls: plain('text-zinc-200') },
  { key: 'g', label: '× Γ Dhan', render: x => (x.gamma > 0 ? x.gamma.toFixed(6) : '—'), cls: plain('text-zinc-100') },
  { key: 'spot', label: '× Spot', render: (_, t) => fx(t.spot, 2), cls: plain('text-zinc-500') },
  { key: 'k', label: '× 0.01', render: () => '0.01', cls: plain('text-zinc-500') },
  { key: 'gex', label: '= GEX', render: x => fmtGex(x.gex), cls: gexCls },
];

/** v2 only: the same, plus the Black-76 gamma beside it for comparison. */
const DHAN_WITH_REF_COLS: ColDef[] = [
  ...DHAN_COLS.slice(0, -1),
  { key: 'mg', label: 'Γ Black-76 (ref)', render: x => sci(mrow(x).modelGamma), cls: plain('text-zinc-500') },
  DHAN_COLS[DHAN_COLS.length - 1],
];

/** v2 only: every term of the Black-76 gamma. */
const MODEL_COLS: ColDef[] = [
  { key: 'oi', label: 'OI (units)', render: x => n0(x.oiUnits), cls: plain('text-zinc-200') },
  { key: 'iv', label: 'σ IV %', render: x => fx(mrow(x).ivPct, 2), cls: plain('text-zinc-200') },
  { key: 'src', label: 'IV from', render: x => SRC_LABEL[mrow(x).ivSource], cls: x => `font-sans text-[10px] ${mrow(x).ivSource === 'own' ? 'text-zinc-500' : 'text-amber-400'}` },
  { key: 'd1', label: 'd1', render: x => fx(mrow(x).d1, 4), cls: plain('text-zinc-300') },
  { key: 'pdf', label: 'φ(d1)', render: x => fx(mrow(x).pdf, 5), cls: plain('text-zinc-300') },
  { key: 'g', label: 'Γ gamma', render: x => sci(x.gamma), cls: plain('text-zinc-100') },
  { key: 'gex', label: 'GEX', render: x => fmtGex(x.gex), cls: gexCls },
];

export default function GexCalcButton({ sets, build, spot, wallStrikes = [] }: {
  sets: GexCalcSet[];
  /** Builds the table for one expiry. The page decides the maths; this component only displays what it is given. */
  build: (set: GexCalcSet) => GexCalcTable<GexCalcSide>;
  spot: number;
  wallStrikes?: number[];
}) {
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState(0);
  const [win, setWin] = useState<number>(12);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const set = sets[Math.min(which, sets.length - 1)];
  const tab = useMemo(
    () => (open && set ? build(set) : null),
    [open, set, build],
  );
  const rows = useMemo(() => {
    if (!tab) return [];
    if (!win || !(spot > 0)) return tab.rows;
    return tab.rows.filter(r => Math.abs(r.strike - spot) <= win * STRIKE_STEP + STRIKE_STEP / 2);
  }, [tab, win, spot]);
  const atmStrike = useMemo(() => (tab && spot > 0 ? tab.rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b - spot) ? r.strike : b), tab.rows[0]?.strike ?? 0) : 0), [tab, spot]);

  const copyCsv = async () => {
    if (!tab) return;
    const m = isModel(tab);
    const names = m && tab.source === 'model' ? ['oi_units', 'iv_pct', 'iv_source', 'd1', 'pdf_d1', 'model_gamma', 'gamma_used', 'gex'] : ['oi_lots', 'lot', 'oi_units', 'gamma', 'spot', 'k', 'gex'];
    const h = ['strike', ...['ce', 'pe'].flatMap(x => names.map(c => `${x}_${c}`)), 'net_gex'];
    const side = (x: GexCalcSide | null) => {
      if (!x) return Array(names.length).fill('');
      if (!(m && tab.source === 'model')) return [tab.lot ? x.oiUnits / tab.lot : '', tab.lot ?? '', x.oiUnits, x.gamma, tab.spot, 0.01, x.gex];
      const y = x as GexModelCalcSide;
      return [y.oiUnits, y.ivPct, y.ivSource, y.d1, y.pdf, y.modelGamma, y.gamma, y.gex];
    };
    const lines = [h.join(','), ...rows.map(r => [r.strike, ...side(r.ce), ...side(r.pe), r.netGex].join(','))];
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const cell = 'px-2 py-1 text-right whitespace-nowrap';
  const cols: ColDef[] = !tab ? [] : tab.source === 'model' ? MODEL_COLS : isModel(tab) ? DHAN_WITH_REF_COLS : DHAN_COLS;
  const unit = tab?.power === 2 ? '₹' : 'index units';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Show the table behind every GEX number: inputs, d1, gamma and GEX per strike"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
      >
        <Sigma className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
        Calc table
      </button>
      {open && createPortal(
        // Portalled to <body>: the sticky header's backdrop-blur makes it the containing block for `fixed` descendants.
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/60" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="GEX calculation table"
            className="flex flex-col w-full max-w-[1500px] max-h-[92vh] rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-zinc-800">
              <div>
                <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">Method</p>
                <h2 className="text-sm font-bold text-white tracking-tight">GEX calculation table</h2>
                {tab?.source !== 'model' ? (
                  <p className="text-[11px] text-zinc-400 mt-1 font-mono">
                    GEX = Γ<sub>Dhan</sub> × OI(lots) × Lot × Spot{tab?.power === 2 ? '²' : ''} × 0.01 &nbsp;·&nbsp; Γ is the gamma Dhan reports in the option chain; Dhan&apos;s OI is already in units, so OI(lots) × Lot = OI(units)
                  </p>
                ) : (
                  <p className="text-[11px] text-zinc-400 mt-1 font-mono">
                    GEX = Γ × OI(units) × F<sup>{tab?.power}</sup> × 0.01 &nbsp;·&nbsp; Γ = e<sup>−rT</sup> · φ(d1) / (F · σ · √T) &nbsp;·&nbsp; d1 = (ln(F/K) + ½σ²T) / (σ√T) &nbsp;·&nbsp; Black-76 model, not from the video
                  </p>
                )}
                <p className="text-[10px] text-zinc-500 mt-0.5">Calls count positive, puts negative (dealers assumed long calls, short puts). Unit: {unit} per 1% move.</p>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="p-1.5 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            {tab && (
              <div className="flex items-center gap-x-6 gap-y-2 flex-wrap px-5 py-3 border-b border-zinc-800 text-[11px]">
                {sets.length > 1 && (
                  <label className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
                    <select value={which} onChange={e => setWhich(Number(e.target.value))} className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2 py-1">
                      {sets.map((x, i) => <option key={x.expiry} value={i}>{x.expiry}</option>)}
                    </select>
                  </label>
                )}
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strikes</span>
                  <select value={win} onChange={e => setWin(Number(e.target.value))} className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2 py-1">
                    {WINDOWS.map(w => <option key={w} value={w}>{w ? `±${w} around spot` : 'All'}</option>)}
                  </select>
                </label>
                <Const label={tab.source === 'model' ? 'F (price used)' : 'Spot (price used)'} value={fx(tab.price, 2)} />
                <Const label="k" value={String(tab.power)} />
                <Const label={`${tab.source === 'model' ? 'F' : 'spot'}${tab.power === 2 ? '²' : ''} × 0.01`} value={tab.scale.toExponential(4)} />
                {isModel(tab) && tab.source === 'dhan' && <Const label="Model F (reference)" value={fx(tab.F, 2)} />}
                {isModel(tab) && tab.source === 'model' && (
                  <>
                    <Const label="Spot" value={fx(tab.spot, 2)} />
                    <Const label="T (years)" value={`${fx(tab.t, 6)} · ${fx(tab.t * 365, 3)} d`} />
                    <Const label="r" value={fx(tab.r, 4)} />
                    <Const label="e^(−rT)" value={fx(tab.discount, 6)} />
                  </>
                )}
                <button onClick={copyCsv} className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/50">
                  <Copy className="w-3 h-3" aria-hidden="true" />{copied ? 'Copied' : 'Copy CSV'}
                </button>
              </div>
            )}

            <div className="overflow-auto flex-1">
              <table className="w-full text-[11px] font-mono tabular-nums border-separate border-spacing-0">
                <thead className="sticky top-0 z-10">
                  <tr className="text-xs font-bold text-white bg-zinc-800">
                    <th className="px-2 py-1.5 text-left bg-zinc-800" rowSpan={2}>Strike</th>
                    <th className="px-2 py-1.5 text-center bg-zinc-800 text-red-400 border-l border-zinc-700" colSpan={cols.length}>CALL</th>
                    <th className="px-2 py-1.5 text-center bg-zinc-800 text-emerald-400 border-l border-zinc-700" colSpan={cols.length}>PUT</th>
                    <th className="px-2 py-1.5 text-right bg-zinc-800 border-l border-zinc-700" rowSpan={2}>Net GEX</th>
                  </tr>
                  <tr className="text-xs font-bold text-white bg-zinc-800">
                    {['CE', 'PE'].flatMap(side => cols.map((c, i) => (
                      <th key={side + c.key} className={`${cell} bg-zinc-800 ${i === 0 ? 'border-l border-zinc-700' : ''}`}>{c.label}</th>
                    )))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const isAtm = r.strike === atmStrike;
                    const isWall = wallStrikes.includes(r.strike);
                    const bg = isAtm ? 'bg-amber-500/10' : isWall ? 'bg-sky-500/10' : '';
                    const sideCells = (x: GexCalcSide | null, tone: string) => x ? cols.map((c, i) => (
                      <td key={c.key} className={`${cell} ${i === 0 ? 'border-l border-zinc-800' : ''} ${c.cls(x, tone)}`}>{c.render(x, tab as GexCalcTable<GexCalcSide>)}</td>
                    )) : [<td key="none" className={`${cell} border-l border-zinc-800 text-zinc-600 text-center`} colSpan={cols.length}>no open interest</td>];
                    return (
                      <tr key={r.strike} className={`border-b border-zinc-800 ${bg}`}>
                        <td className={`px-2 py-1 text-left font-bold text-zinc-100 sticky left-0 bg-zinc-950 ${bg}`}>
                          {n0(r.strike)}
                          {isAtm && <span className="ml-1.5 text-[9px] font-sans font-bold text-amber-400">ATM</span>}
                          {isWall && <span className="ml-1.5 text-[9px] font-sans font-bold text-sky-400">WALL</span>}
                        </td>
                        {sideCells(r.ce, 'text-red-400')}
                        {sideCells(r.pe, 'text-emerald-400')}
                        <td className={`${cell} border-l border-zinc-800 font-bold ${r.netGex >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtGex(r.netGex)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr><td colSpan={2 * cols.length + 2} className="px-3 py-8 text-center text-zinc-500 font-sans">No strikes with open interest</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
              {tab?.source === 'model'
                ? 'F is the future rolled to this expiry (spot carried to expiry when no future is quoted). The IV-from column shows when a leg borrowed another IV: the OTM leg (ITM IVs are noisy), the other side of the same strike, or the nearest strike within 200 points. Gamma uses a 10-minute minimum T.'
                : `Gamma is Dhan's own chain value, used as given (0 when the chain gives none).${tab && isModel(tab) ? ' The Black-76 column is recomputed from the chain IV on the rolled future, for comparison only.' : ''}`}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function Const({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">{label}</span>
      <span className="font-mono tabular-nums text-zinc-200 font-semibold">{value}</span>
    </span>
  );
}
