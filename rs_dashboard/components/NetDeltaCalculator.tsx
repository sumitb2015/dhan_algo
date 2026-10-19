'use client';

/**
 * Net-delta what-if calculator for the Cyber Scalper positions panel. It starts from the active positions on screen
 * (futures and option legs), lets the lots, the underlying price and each leg's IV be edited, and shows the net Greeks and a
 * price-move table. All pricing goes through lib/optionsPricing.ts; nothing here is a private Black-Scholes.
 *
 * Read-only: it never places an order.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, X, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RISK_FREE_RATE, calculateTimeToExpiryYears, computeBsGreeksExact, priceOption } from '@/lib/optionsPricing';
import type { CalcLeg } from '@/lib/deltaCalcLegs';

export interface DeltaCalcSnapshot {
  legs: CalcLeg[];
  /** Starting underlying price. */
  price: number;
  /** True for options on a futures price (MCX): Black-76. Otherwise Black-Scholes on spot. */
  isFuturesPricing: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Read once each time the window opens, and again on "Reset to live". */
  getSnapshot: () => DeltaCalcSnapshot;
  /** Shown under the title, e.g. which book the legs came from. */
  subtitle?: string;
  /** Rendered above the inputs, e.g. an underlying picker. */
  headerExtra?: React.ReactNode;
  /** Changing this re-reads the snapshot while the window is open (e.g. after switching underlying). */
  snapshotKey?: string;
}

const MOVES = [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10];

const nf2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const nf4 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4, minimumFractionDigits: 4 });
const signed = (v: number, f: Intl.NumberFormat) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f.format(Math.abs(v))}`;
const tone = (v: number) => (v > 0.005 ? 'text-emerald-400' : v < -0.005 ? 'text-red-400' : 'text-zinc-300');

export default function NetDeltaCalculator({ open, onClose, getSnapshot, subtitle, headerExtra, snapshotKey }: Props) {
  const [priceDraft, setPriceDraft] = useState('');
  const [scaleDraft, setScaleDraft] = useState('1');
  const [lotsDraft, setLotsDraft] = useState<Record<string, string>>({});
  const [ivDraft, setIvDraft] = useState<Record<string, string>>({});

  // Fresh snapshot every time the window opens; the 5 s position polling must not rewrite what is being edited.
  const [legs, setLegs] = useState<CalcLeg[]>([]);
  const [anchor, setAnchor] = useState(0);
  const [isFuturesPricing, setIsFuturesPricing] = useState(false);
  const reset = () => {
    const snap = getSnapshot();
    const built = snap.legs;
    const F = snap.price;
    setLegs(built);
    setAnchor(F);
    setIsFuturesPricing(snap.isFuturesPricing);
    setPriceDraft(F > 0 ? String(F) : '');
    setScaleDraft('1');
    setLotsDraft(Object.fromEntries(built.map((l) => [l.key, String(l.liveLots)])));
    setIvDraft(Object.fromEntries(built.map((l) => [l.key, String(l.liveIv)])));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset(); }, [open, snapshotKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const F = Number(priceDraft) > 0 ? Number(priceDraft) : 0;
  const scale = Number(scaleDraft) > 0 ? Number(scaleDraft) : 0;

  const calc = useMemo(() => {
    const evaluate = (price: number) => {
      const t = { delta: 0, gamma: 0, theta: 0, vega: 0, value: 0 };
      for (const l of legs) {
        const units = (Number(lotsDraft[l.key]) || 0) * scale * l.unitsPerLot;
        if (l.kind === 'FUT') {
          t.delta += units; t.value += units * price;
          continue;
        }
        const years = l.expiry ? calculateTimeToExpiryYears(l.expiry) : 0;
        const iv = (Number(ivDraft[l.key]) || 0) / 100;
        if (!(price > 0) || !(years > 0) || !(iv > 0)) { t.value += units * (priceOption(l.kind, price, l.strike, 0, 0, RISK_FREE_RATE, isFuturesPricing)); continue; }
        const g = computeBsGreeksExact(l.kind, price, l.strike, years, iv, RISK_FREE_RATE, isFuturesPricing);
        t.delta += g.delta * units; t.gamma += g.gamma * units; t.theta += g.theta * units; t.vega += g.vega * units;
        t.value += g.price * units;
      }
      return t;
    };
    const now = evaluate(F);
    const rows = MOVES.map((m) => {
      const p = F * (1 + m / 100);
      const e = evaluate(p);
      return { m, p, delta: e.delta, pl: e.value - now.value };
    });
    let flipAt: number | null = null;
    let prev = 0;
    for (const r of rows) {
      const s = Math.sign(Math.round(r.delta * 100));
      if (s !== 0 && prev !== 0 && s !== prev && flipAt === null) flipAt = r.p;
      if (s !== 0) prev = s;
    }
    return { now, rows, flipAt };
  }, [legs, lotsDraft, ivDraft, F, scale, isFuturesPricing]);

  if (!open) return null;

  const lotUnit = legs.find((l) => l.kind === 'FUT')?.unitsPerLot ?? legs[0]?.unitsPerLot ?? 1;
  const futLotsEq = lotUnit > 0 ? calc.now.delta / lotUnit : 0;
  const inputCls = 'w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-white focus:border-cyan-500/60 focus:outline-none';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Net delta calculator"
      className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 p-4 backdrop-blur-md"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900/95 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2.5 border-b border-zinc-800/80 bg-zinc-950/60 px-5 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10">
            <Calculator className="h-4 w-4 text-cyan-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Net Delta Calculator</h2>
            <span className="text-[10px] font-semibold text-cyan-400">{subtitle ?? 'What-if on the open legs. Nothing is ordered.'}</span>
          </div>
          <button type="button" onClick={reset}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-bold text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white">
            <RotateCcw className="h-3 w-3" /> Reset to live
          </button>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {headerExtra}
          {legs.length === 0 ? (
            <p className="py-10 text-center text-xs text-zinc-500">No open futures or option legs to calculate on.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="calc-price" className="mb-1 block text-[11px] font-medium text-zinc-400">Underlying price</label>
                  <input id="calc-price" className={inputCls} inputMode="decimal" value={priceDraft}
                    onChange={(e) => setPriceDraft(e.target.value.replace(/[^0-9.]/g, ''))} />
                </div>
                <div>
                  <label htmlFor="calc-scale" className="mb-1 block text-[11px] font-medium text-zinc-400">Scale all lots ×</label>
                  <input id="calc-scale" className={inputCls} inputMode="decimal" value={scaleDraft}
                    onChange={(e) => setScaleDraft(e.target.value.replace(/[^0-9.]/g, ''))} />
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-zinc-800/80 bg-zinc-950/40">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      {['Leg', 'Lots (− short)', 'Units', 'IV %'].map((h, i) => (
                        <th key={h} className={cn('whitespace-nowrap bg-zinc-800 px-3 py-2 text-xs font-bold text-white', i === 0 ? 'text-left' : 'text-center')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {legs.map((l) => {
                      const lots = (Number(lotsDraft[l.key]) || 0) * scale;
                      return (
                        <tr key={l.key} className="border-b border-zinc-800/60 last:border-0">
                          <td className="whitespace-nowrap px-3 py-2 text-left font-mono text-xs font-semibold text-zinc-100">{l.label}</td>
                          <td className="px-3 py-2">
                            <input aria-label={`Lots for ${l.label}`} className={cn(inputCls, 'mx-auto w-20 text-center')} inputMode="decimal"
                              value={lotsDraft[l.key] ?? ''}
                              onChange={(e) => setLotsDraft((d) => ({ ...d, [l.key]: e.target.value.replace(/[^0-9.-]/g, '') }))} />
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-center font-mono text-xs tabular-nums text-zinc-300">{nf0.format(lots * l.unitsPerLot)}</td>
                          <td className="px-3 py-2">
                            {l.kind === 'FUT' ? <span className="block text-center font-mono text-xs text-zinc-600">—</span> : (
                              <input aria-label={`IV for ${l.label}`} className={cn(inputCls, 'mx-auto w-20 text-center')} inputMode="decimal"
                                value={ivDraft[l.key] ?? ''}
                                onChange={(e) => setIvDraft((d) => ({ ...d, [l.key]: e.target.value.replace(/[^0-9.]/g, '') }))} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Net delta</div>
                <div className={cn('font-mono text-3xl font-semibold tabular-nums', tone(calc.now.delta))}>
                  {signed(calc.now.delta, nf2)} <span className="text-sm font-medium text-zinc-400">units</span>
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  {futLotsEq === 0 ? 'Flat.' : `Same as ${futLotsEq < 0 ? 'short' : 'long'} ${nf2.format(Math.abs(futLotsEq))} lots of the future.`}{' '}
                  About ₹{nf0.format(Math.abs(calc.now.delta))} {calc.now.delta < 0 ? 'lost' : 'gained'} per ₹1 rise.
                </div>
                <div className="mt-3 grid grid-cols-3 gap-3 border-t border-zinc-800 pt-3">
                  <div><div className={cn('font-mono text-sm font-semibold tabular-nums', tone(calc.now.gamma))}>{signed(calc.now.gamma, nf4)}</div><div className="text-[11px] text-zinc-500">Net gamma</div></div>
                  <div><div className={cn('font-mono text-sm font-semibold tabular-nums', tone(calc.now.theta))}>{signed(calc.now.theta, nf0)}</div><div className="text-[11px] text-zinc-500">Theta ₹/day</div></div>
                  <div><div className={cn('font-mono text-sm font-semibold tabular-nums', tone(calc.now.vega))}>{signed(calc.now.vega, nf0)}</div><div className="text-[11px] text-zinc-500">Vega ₹ per 1% IV</div></div>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-zinc-800/80 bg-zinc-950/40">
                <table className="w-full border-collapse font-mono text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      {['If price moves', 'Price', 'Net delta', 'P&L ₹'].map((h, i) => (
                        <th key={h} className={cn('whitespace-nowrap bg-zinc-800 px-3 py-2 text-xs font-bold text-white', i === 0 ? 'text-left' : 'text-right')}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {calc.rows.map((r) => (
                      <tr key={r.m} className={cn('border-b border-zinc-800/60 last:border-0', r.m === 0 && 'bg-zinc-800/50 font-bold')}>
                        <td className="px-3 py-1.5 text-left text-zinc-300">{r.m > 0 ? '+' : r.m < 0 ? '−' : ''}{Math.abs(r.m)}%</td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">{nf0.format(r.p)}</td>
                        <td className={cn('px-3 py-1.5 text-right', tone(r.delta))}>{signed(r.delta, nf2)}</td>
                        <td className={cn('px-3 py-1.5 text-right', tone(r.pl))}>{signed(r.pl, nf0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {calc.flipAt !== null && (
                <div className="rounded-lg border border-amber-800/80 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-300">
                  The net delta changes sign near ₹{nf0.format(calc.flipAt)}.
                </div>
              )}
              <p className="text-[11px] text-zinc-500">
                Starting IVs are solved from each leg&apos;s live price at {anchor > 0 ? `₹${nf0.format(anchor)}` : 'the underlying'}. P&amp;L reprices every leg at the new price today, with IV and days held fixed.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
