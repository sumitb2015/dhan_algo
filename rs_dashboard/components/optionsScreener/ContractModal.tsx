'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  D_IV_CHG, D_OI_CHG, D_OI_PCT, D_PRICE_CHG, D_PRICE_PCT, D_RVOL, D_WIN_VOL,
  PRESET_BY_ID, WINDOWS, roundToTick, type ResultRow,
} from '@/lib/optionsScreener';
import { MoneyChip, TypeChip, contractLabel } from './ResultsTable';
import { FOCUS_RING, fmtCompact, fmtPct, fmtPrice, fmtSigned, toneClass } from './format';

const MAX_LOTS = 25; // mirrors the server cap in app/api/options-screener/order/route.ts

type Side = 'BUY' | 'SELL';
type OrdType = 'MARKET' | 'LIMIT';
type Product = 'INTRADAY' | 'MARGIN';

interface Props {
  row: ResultRow;
  onClose: () => void;
}

/** Free-typed number that only commits on blur/Enter (dhan-commit-on-blur): a half-typed
 *  "25" must never be read as "2" by the order button. */
function CommitNumber({
  value, onCommit, min, max, step, ariaLabel, className,
}: {
  value: number; onCommit: (v: number) => void; min: number; max?: number; step?: number;
  ariaLabel: string; className?: string;
}) {
  // Parent remounts this via `key={value}` when the committed value changes.
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || (max != null && n > max)) {
      setDraft(String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={`bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1.5 text-sm font-mono text-zinc-100 ${FOCUS_RING} ${className ?? ''}`}
    />
  );
}

export default function ContractModal({ row, onClose }: Props) {
  const [side, setSideRaw] = useState<Side>('BUY');
  const [lots, setLotsRaw] = useState(1);
  const [ordType, setOrdTypeRaw] = useState<OrdType>('LIMIT');
  const [price, setPriceRaw] = useState(() => roundToTick(row.ltp, row.tick));
  const [product, setProductRaw] = useState<Product>('INTRADAY');
  const [confirming, setConfirming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  // Any edit to the ticket voids a pending confirmation.
  const voiding = <V,>(set: (v: V) => void) => (v: V) => { setConfirming(false); set(v); };
  const setSide = voiding(setSideRaw);
  const setLots = voiding(setLotsRaw);
  const setOrdType = voiding(setOrdTypeRaw);
  const setPrice = voiding(setPriceRaw);
  const setProduct = voiding(setProductRaw);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !placing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, placing]);

  const qty = lots * row.lot;
  const refPrice = ordType === 'LIMIT' ? price : row.ltp;
  const premium = lots * row.mult * refPrice;
  const label = `${contractLabel(row)} ${row.t}`;

  const place = async () => {
    if (!confirming) { setConfirming(true); return; }
    setPlacing(true);
    setError(null);
    try {
      const res = await fetch('/api/options-screener/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, side, lots, orderType: ordType, price: ordType === 'LIMIT' ? price : undefined, product }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Order failed');
      setPlaced(`${json.summary} · order ${json.orderId}`);
      toast.success('Order placed', { description: `${json.summary} · #${json.orderId}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error('Order failed', { description: msg });
    } finally {
      setPlacing(false);
      setConfirming(false);
    }
  };

  const sideBtn = (s: Side) => (
    <button
      type="button"
      onClick={() => setSide(s)}
      aria-pressed={side === s}
      className={`flex-1 py-1.5 rounded-md text-xs font-bold transition ${FOCUS_RING} ${
        side === s
          ? s === 'BUY' ? 'bg-emerald-600 text-oncolor' : 'bg-red-600 text-oncolor'
          : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
      }`}
    >
      {s}
    </button>
  );

  const seg = <T extends string>(val: T, cur: T, set: (v: T) => void, text: string) => (
    <button
      key={val}
      type="button"
      onClick={() => set(val)}
      aria-pressed={cur === val}
      className={`px-2.5 py-1 rounded text-[11px] font-semibold transition ${FOCUS_RING} ${
        cur === val ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {text}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !placing) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={label}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* header */}
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-bold text-white">{contractLabel(row)}</h2>
              <TypeChip t={row.t} />
              <MoneyChip money={row.money} />
              <span className="text-[10px] font-mono text-zinc-500">{row.xs} · {row.sid}</span>
            </div>
            <p className="text-[11px] text-zinc-400 mt-1">
              LTP <span className="font-mono text-zinc-100">{fmtPrice(row.ltp)}</span>
              {' · '}Spot <span className="font-mono text-zinc-100">{fmtPrice(row.spot)}</span>
              {' · '}OI <span className="font-mono text-zinc-100">{fmtCompact(row.oi)}</span> lots
              {' · '}Day vol <span className="font-mono text-zinc-100">{fmtCompact(row.dayVol)}</span> lots
              {' · '}IV <span className="font-mono text-zinc-100">{row.iv == null ? '—' : `${row.iv.toFixed(1)}%`}</span>
            </p>
            {row.presets.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {row.presets.map((p) => (
                  <span key={p} title={PRESET_BY_ID[p].desc}
                    className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] font-semibold text-zinc-300">
                    {PRESET_BY_ID[p].label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" disabled={placing}
            className={`p-1 rounded text-zinc-400 hover:text-zinc-100 ${FOCUS_RING}`}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* windows table */}
        <div className="px-5 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500 mb-1.5">Change by look-back window</p>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="bg-zinc-800 text-left">
                <th className="px-2 py-1 text-xs font-bold text-white">WINDOW</th>
                <th className="px-2 py-1 text-xs font-bold text-white text-right">PREMIUM</th>
                <th className="px-2 py-1 text-xs font-bold text-white text-right">OI</th>
                <th className="px-2 py-1 text-xs font-bold text-white text-right">VOL (LOTS)</th>
                <th className="px-2 py-1 text-xs font-bold text-white text-right">RVOL</th>
                <th className="px-2 py-1 text-xs font-bold text-white text-right">IV Δ</th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => {
                const d = row.d?.[String(w)];
                const g = (i: number) => (d && typeof d[i] === 'number' ? (d[i] as number) : null);
                return (
                  <tr key={w} className="border-b border-zinc-800/70">
                    <td className="px-2 py-1 font-mono text-zinc-300">{w} min</td>
                    {d ? (
                      <>
                        <td className="px-2 py-1 text-right">
                          <span className={toneClass(g(D_PRICE_PCT))}>{fmtPct(g(D_PRICE_PCT))}</span>
                          <span className="text-zinc-500"> ({fmtSigned(g(D_PRICE_CHG), 2)})</span>
                        </td>
                        <td className="px-2 py-1 text-right">
                          <span className={toneClass(g(D_OI_PCT))}>{fmtPct(g(D_OI_PCT), 1)}</span>
                          <span className="text-zinc-500"> ({fmtSigned(g(D_OI_CHG), 0)})</span>
                        </td>
                        <td className="px-2 py-1 text-right text-zinc-200">{fmtCompact(g(D_WIN_VOL))}</td>
                        <td className="px-2 py-1 text-right text-zinc-300">{g(D_RVOL) == null ? '—' : `${g(D_RVOL)!.toFixed(1)}×`}</td>
                        <td className={`px-2 py-1 text-right ${toneClass(g(D_IV_CHG))}`}>{fmtSigned(g(D_IV_CHG))}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="px-2 py-1 text-right text-zinc-600">no baseline yet</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* order ticket */}
        <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-violet-300">Trade · Dhan · real money</p>
            <span className="text-[10px] text-zinc-500">lot = {row.lot} qty{row.x === 'MCX' ? ` (${row.mult} units)` : ''} · tick {row.tick}</span>
          </div>

          <div className="flex gap-2 mb-3">{sideBtn('BUY')}{sideBtn('SELL')}</div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Lots (max {MAX_LOTS})
              <CommitNumber key={`lots-${lots}`} value={lots} min={1} max={MAX_LOTS} step={1} ariaLabel="Lots"
                onCommit={(v) => setLots(Math.max(1, Math.min(MAX_LOTS, Math.floor(v))))} />
            </label>
            <div className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Order type
              <div className="flex bg-zinc-950 border border-zinc-800 rounded-md p-0.5">
                {seg<OrdType>('LIMIT', ordType, setOrdType, 'Limit')}
                {seg<OrdType>('MARKET', ordType, setOrdType, 'Market')}
              </div>
            </div>
            <label className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Limit price
              <CommitNumber key={`px-${price}`} value={price} min={0.05} step={row.tick} ariaLabel="Limit price"
                className={ordType === 'MARKET' ? 'opacity-40 pointer-events-none' : ''}
                onCommit={(v) => setPrice(roundToTick(v, row.tick))} />
            </label>
            <div className="flex flex-col gap-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Product
              <div className="flex bg-zinc-950 border border-zinc-800 rounded-md p-0.5">
                {seg<Product>('INTRADAY', product, setProduct, 'Intraday')}
                {seg<Product>('MARGIN', product, setProduct, 'Carry')}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-zinc-400 mt-3">
            {side} <span className="font-mono text-zinc-100">{lots}</span> lot{lots === 1 ? '' : 's'} = qty{' '}
            <span className="font-mono text-zinc-100">{qty}</span> · premium ≈{' '}
            <span className="font-mono text-zinc-100">₹{Math.round(premium).toLocaleString('en-IN')}</span>
            {ordType === 'MARKET' && <span className="text-amber-300"> · market order — fills at the prevailing ask/bid</span>}
            {side === 'SELL' && <span className="text-amber-300"> · short option: margin blocked, risk is unlimited on CE</span>}
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}
            </div>
          )}
          {placed && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />{placed}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mt-4">
            {confirming && (
              <button type="button" onClick={() => setConfirming(false)}
                className={`px-3 py-2 rounded-md text-xs font-semibold text-zinc-300 border border-zinc-700 hover:border-zinc-500 ${FOCUS_RING}`}>
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={place}
              disabled={placing}
              className={`px-4 py-2 rounded-md text-xs font-bold text-oncolor transition disabled:opacity-60 ${FOCUS_RING} ${
                side === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'
              } ${confirming ? 'ring-2 ring-amber-400' : ''}`}
            >
              {placing ? (
                <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Placing…</span>
              ) : confirming ? (
                `Confirm ${side} ${lots} × ${label}${ordType === 'LIMIT' ? ` @ ${price}` : ' @ MKT'}`
              ) : (
                `${side} ${lots} lot${lots === 1 ? '' : 's'}`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
