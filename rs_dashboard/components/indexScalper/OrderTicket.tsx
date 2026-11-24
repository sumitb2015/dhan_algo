'use client';

// Floating order ticket for /index-scalper. Collects an order and hands it to the terminal, which decides SIM vs REAL;
// this component never calls an order route. Free-typed fields are only read when Sell/Buy is clicked.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { PickedContract } from './OptionChainPanel';
import { useDraggable } from './useDraggable';
import { MAX_LOTS, OPTION_TICK, orderUnits, tickError } from '@/lib/indexScalperPositions';
import type { Underlying } from '@/lib/indexScalperInstrument';
import { cn } from '@/lib/utils';

export type TicketOrderType = 'MARKET' | 'LIMIT' | 'STOP_LOSS_MARKET' | 'STOP_LOSS';
export type TicketProduct = 'INTRADAY' | 'MARGIN';

export interface TicketRequest {
  contract: PickedContract;
  side: 'BUY' | 'SELL';
  orderType: TicketOrderType;
  price: number | null;
  trigger: number | null;
  product: TicketProduct;
  lots: number;
}

const TYPES: { v: TicketOrderType; label: string }[] = [
  { v: 'MARKET', label: 'Market' }, { v: 'LIMIT', label: 'Limit' }, { v: 'STOP_LOSS_MARKET', label: 'Stop' }, { v: 'STOP_LOSS', label: 'Stop Limit' },
];

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function OrderTicket({ contract, liveLtp, expiry, lotSize, real, available, busy, message, onSubmit, onClose, underlying = 'NIFTY' }: {
  contract: PickedContract;
  liveLtp: number | null;
  expiry: string;
  lotSize: number | null;
  real: boolean;
  available: number | null;
  busy: boolean;
  message: { ok: boolean; text: string } | null;
  onSubmit: (r: TicketRequest) => void;
  onClose: () => void;
  underlying?: Underlying;
}) {
  // Right of the chain panel and left of the chart's position chips, so neither is covered by default.
  const { pos, handle } = useDraggable({ x: Math.max(16, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 800), y: 190 });
  const [orderType, setOrderType] = useState<TicketOrderType>('MARKET');
  const [product, setProduct] = useState<TicketProduct>('INTRADAY');
  const [lotsDraft, setLotsDraft] = useState('1');
  const [priceDraft, setPriceDraft] = useState('');
  const [trigDraft, setTrigDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // This contract's tick from the master list; Rs 0.05 (NSE index options) until it answers or when it is unknown.
  const [tick, setTick] = useState(OPTION_TICK);
  useEffect(() => {
    if (!contract.securityId) return;
    let dead = false;
    const seg = underlying === 'CRUDEOILM' ? 'MCX_COMM' : 'NSE_FNO';
    fetch(`/api/index-scalper/tick?securityId=${encodeURIComponent(contract.securityId)}&segment=${seg}`)
      .then(r => r.json())
      .then((j: { success: boolean; tick?: number | null }) => { if (!dead && j.success && typeof j.tick === 'number' && j.tick > 0) setTick(j.tick); })
      .catch(() => {});
    return () => { dead = true; };
  }, [contract.securityId, underlying]);

  const ltp = liveLtp ?? contract.ltp;
  const lots = Number(lotsDraft);
  const size = orderUnits(lots, lotSize);
  const needsPrice = orderType === 'LIMIT' || orderType === 'STOP_LOSS';
  const needsTrigger = orderType === 'STOP_LOSS' || orderType === 'STOP_LOSS_MARKET';
  const refPrice = needsPrice ? Number(priceDraft) : ltp;
  const value = size.ok && refPrice && refPrice > 0 ? size.units * refPrice : null;

  const submit = (side: 'BUY' | 'SELL') => {
    setErr(null);
    if (!size.ok) return setErr(size.error);
    if (!contract.securityId) return setErr('No security id for this strike');
    const price = needsPrice ? Number(priceDraft) : null;
    const trigger = needsTrigger ? Number(trigDraft) : null;
    if (needsPrice && !(price && price > 0)) return setErr('Enter a limit price');
    if (needsTrigger && !(trigger && trigger > 0)) return setErr('Enter a trigger price');
    const offTick = (needsPrice && price ? tickError('Price', price, tick) : null) ?? (needsTrigger && trigger ? tickError('Trigger', trigger, tick) : null);
    if (offTick) return setErr(offTick);
    if (orderType === 'MARKET' && !(ltp && ltp > 0)) return setErr('No live price for this contract yet');
    onSubmit({ contract, side, orderType, price, trigger, product, lots });
  };

  const inputCls = 'w-full h-8 px-2 rounded bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';

  const title = contract.type === 'FUT'
    ? `${expiry} FUT`
    : `${expiry} ${contract.strike} ${contract.type === 'CE' ? 'CALL' : 'PUT'}`;

  return (
    <div style={{ left: pos.x, top: pos.y }} data-testid="order-ticket"
      className={cn('fixed z-50 w-[320px] rounded-lg border bg-zinc-900 shadow-2xl select-none', real ? 'border-rose-500/70' : 'border-zinc-700')}>
      <div {...handle} className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-800 cursor-move">
        <div className="min-w-0">
          <div className="text-sm font-bold text-white truncate">{underlying} {title}</div>
          <div className={cn('text-[10px] font-bold uppercase tracking-wider', real ? 'text-rose-400' : 'text-amber-300')}>{real ? 'REAL · Dhan' : 'SIM · paper'}</div>
        </div>
        <button type="button" aria-label="Close order ticket" onClick={onClose}
          className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"><X className="w-4 h-4" /></button>
      </div>

      <div className="p-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={() => submit('SELL')}
            className="h-10 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-sm font-bold tabular-nums disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300">
            Sell {ltp ? ltp.toFixed(2) : '—'}
          </button>
          <button type="button" disabled={busy} onClick={() => submit('BUY')}
            className="h-10 rounded bg-sky-600 hover:bg-sky-500 text-oncolor text-sm font-bold tabular-nums disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
            Buy {ltp ? ltp.toFixed(2) : '—'}
          </button>
        </div>

        <div className="flex items-center gap-3 text-xs border-b border-zinc-800">
          {TYPES.map(t => (
            <button key={t.v} type="button" onClick={() => setOrderType(t.v)} disabled={!real && t.v !== 'MARKET' && t.v !== 'LIMIT'}
              title={!real && t.v !== 'MARKET' && t.v !== 'LIMIT' ? 'Stop orders need REAL mode (they rest at the exchange)' : undefined}
              className={cn('pb-1.5 -mb-px border-b-2 font-semibold disabled:opacity-40', orderType === t.v ? 'text-white border-sky-500' : 'text-zinc-400 border-transparent hover:text-zinc-200')}>
              {t.label}
            </button>
          ))}
        </div>

        {needsPrice && (
          <label className="text-[11px] text-zinc-400">Price
            <input inputMode="decimal" className={inputCls} value={priceDraft} placeholder={ltp ? ltp.toFixed(2) : ''} onChange={e => setPriceDraft(e.target.value)} />
          </label>
        )}
        {needsTrigger && (
          <label className="text-[11px] text-zinc-400">Trigger price
            <input inputMode="decimal" className={inputCls} value={trigDraft} onChange={e => setTrigDraft(e.target.value)} />
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-zinc-400">Lots (max {MAX_LOTS})
            <input inputMode="numeric" className={inputCls} value={lotsDraft} onChange={e => setLotsDraft(e.target.value)} />
          </label>
          <label className="text-[11px] text-zinc-400">Product
            <select className={inputCls} value={product} onChange={e => setProduct(e.target.value as TicketProduct)}>
              <option value="INTRADAY">Intraday</option><option value="MARGIN">Normal (carry)</option>
            </select>
          </label>
        </div>
        <div className="text-[11px] text-zinc-500">
          {lotSize === null ? 'Lot size loading…' : size.ok ? `Units ${size.units} (${lots} × ${lotSize})` : <span className="text-rose-400">{size.error}</span>}
        </div>

        <div className="text-[11px] text-zinc-400 flex flex-col gap-0.5 border-t border-zinc-800 pt-2">
          <div className="flex justify-between"><span>Order value</span><span className="text-zinc-100 tabular-nums">{value ? inr(value) : '—'}</span></div>
          <div className="flex justify-between"><span>Available balance</span><span className="text-zinc-100 tabular-nums">{available === null ? '—' : inr(available)}</span></div>
          <div className="text-[10px] text-zinc-600">Selling needs margin: check it at the broker before a large short.</div>
        </div>

        {(err || message) && (
          <div role="status" className={cn('text-[11px] rounded px-2 py-1 border', err || !message?.ok ? 'text-rose-300 border-rose-500/40 bg-rose-500/10' : 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10')}>
            {err ?? message?.text}
          </div>
        )}
      </div>
    </div>
  );
}
