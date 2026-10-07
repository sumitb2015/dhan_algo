'use client';

// "Calc table" button + modal for the GEX pages: every number that goes into each strike's gamma and GEX, so the maths can be
// checked by hand. Built by gexCalcTable() in lib/gex.ts, which is tested to sum to exactly what the charts draw.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sigma, X, Copy } from 'lucide-react';
import { gexCalcTable, fmtGex, type GexCalcSide, type GexChainEntry, type GexPower, type IvSource } from '@/lib/gex';

export interface GexCalcSet { expiry: string; oc: Record<string, GexChainEntry>; underlying: number }

const WINDOWS = [8, 12, 20, 30, 0] as const; // 0 = every strike
const STRIKE_STEP = 50;
const SRC_LABEL: Record<IvSource, string> = { own: 'own', 'otm-leg': 'OTM leg', 'other-leg': 'other leg', nearest: 'nearest strike' };

const n0 = (v: number) => v.toLocaleString('en-IN');
const sci = (v: number) => (v > 0 ? v.toExponential(4) : '—');
const fx = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export default function GexCalcButton({ sets, power, spot, wallStrikes = [] }: {
  sets: GexCalcSet[]; power: GexPower; spot: number; wallStrikes?: number[];
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
    () => (open && set ? gexCalcTable(set.oc, { expiry: set.expiry, underlying: set.underlying, power }) : null),
    [open, set, power],
  );
  const rows = useMemo(() => {
    if (!tab) return [];
    if (!win || !(spot > 0)) return tab.rows;
    return tab.rows.filter(r => Math.abs(r.strike - spot) <= win * STRIKE_STEP + STRIKE_STEP / 2);
  }, [tab, win, spot]);
  const atmStrike = useMemo(() => (tab && spot > 0 ? tab.rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b - spot) ? r.strike : b), tab.rows[0]?.strike ?? 0) : 0), [tab, spot]);

  const copyCsv = async () => {
    if (!tab) return;
    const h = ['strike', 'ce_oi_units', 'ce_iv_pct', 'ce_iv_source', 'ce_d1', 'ce_pdf_d1', 'ce_gamma', 'ce_gex', 'pe_oi_units', 'pe_iv_pct', 'pe_iv_source', 'pe_d1', 'pe_pdf_d1', 'pe_gamma', 'pe_gex', 'net_gex'];
    const side = (s: GexCalcSide | null) => (s ? [s.oiUnits, s.ivPct, s.ivSource, s.d1, s.pdf, s.gamma, s.gex] : ['', '', '', '', '', '', '']);
    const lines = [h.join(','), ...rows.map(r => [r.strike, ...side(r.ce), ...side(r.pe), r.netGex].join(','))];
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const cell = 'px-2 py-1 text-right whitespace-nowrap';
  const unit = power === 2 ? '₹' : 'index units';

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
                <p className="text-[11px] text-zinc-400 mt-1 font-mono">
                  GEX = Γ × OI(units) × F<sup>{power}</sup> × 0.01 &nbsp;·&nbsp; Γ = e<sup>−rT</sup> · φ(d1) / (F · σ · √T) &nbsp;·&nbsp; d1 = (ln(F/K) + ½σ²T) / (σ√T)
                </p>
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
                <Const label="F (forward)" value={fx(tab.F, 2)} />
                <Const label="T (years)" value={`${fx(tab.t, 6)} · ${fx(tab.t * 365, 3)} d`} />
                <Const label="r" value={fx(tab.r, 4)} />
                <Const label="e^(−rT)" value={fx(tab.discount, 6)} />
                <Const label="k" value={String(tab.power)} />
                <Const label={`F^${tab.power} × 0.01`} value={tab.scale.toExponential(4)} />
                <Const label="Spot" value={spot > 0 ? fx(spot, 2) : '—'} />
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
                    <th className="px-2 py-1.5 text-center bg-zinc-800 text-red-400 border-l border-zinc-700" colSpan={7}>CALL</th>
                    <th className="px-2 py-1.5 text-center bg-zinc-800 text-emerald-400 border-l border-zinc-700" colSpan={7}>PUT</th>
                    <th className="px-2 py-1.5 text-right bg-zinc-800 border-l border-zinc-700" rowSpan={2}>Net GEX</th>
                  </tr>
                  <tr className="text-xs font-bold text-white bg-zinc-800">
                    {['CE', 'PE'].flatMap(side => [
                      <th key={side + 'oi'} className={`${cell} bg-zinc-800 ${side === 'CE' ? 'border-l border-zinc-700' : 'border-l border-zinc-700'}`}>OI (units)</th>,
                      <th key={side + 'iv'} className={`${cell} bg-zinc-800`}>σ IV %</th>,
                      <th key={side + 'src'} className={`${cell} bg-zinc-800`}>IV from</th>,
                      <th key={side + 'd1'} className={`${cell} bg-zinc-800`}>d1</th>,
                      <th key={side + 'pdf'} className={`${cell} bg-zinc-800`}>φ(d1)</th>,
                      <th key={side + 'g'} className={`${cell} bg-zinc-800`}>Γ gamma</th>,
                      <th key={side + 'gex'} className={`${cell} bg-zinc-800`}>GEX</th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const isAtm = r.strike === atmStrike;
                    const isWall = wallStrikes.includes(r.strike);
                    const bg = isAtm ? 'bg-amber-500/10' : isWall ? 'bg-sky-500/10' : '';
                    const sideCells = (s: GexCalcSide | null, tone: string) => s ? [
                      <td key="oi" className={`${cell} border-l border-zinc-800 text-zinc-200`}>{n0(s.oiUnits)}</td>,
                      <td key="iv" className={`${cell} text-zinc-200`}>{fx(s.ivPct, 2)}</td>,
                      <td key="src" className={`${cell} font-sans text-[10px] ${s.ivSource === 'own' ? 'text-zinc-500' : 'text-amber-400'}`}>{SRC_LABEL[s.ivSource]}</td>,
                      <td key="d1" className={`${cell} text-zinc-300`}>{fx(s.d1, 4)}</td>,
                      <td key="pdf" className={`${cell} text-zinc-300`}>{fx(s.pdf, 5)}</td>,
                      <td key="g" className={`${cell} text-zinc-100`}>{sci(s.gamma)}</td>,
                      <td key="gex" className={`${cell} font-bold ${tone}`}>{fmtGex(s.gex)}</td>,
                    ] : [<td key="none" className={`${cell} border-l border-zinc-800 text-zinc-600 text-center`} colSpan={7}>no open interest</td>];
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
                  {rows.length === 0 && <tr><td colSpan={16} className="px-3 py-8 text-center text-zinc-500 font-sans">No strikes with open interest</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="px-5 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
              F is the future rolled to this expiry (spot carried to expiry when no future is quoted). The IV-from column shows when a leg borrowed another IV: the OTM leg (ITM
              IVs are noisy), the other side of the same strike, or the nearest strike within 200 points. Gamma uses a 10-minute minimum T.
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
