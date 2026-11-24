'use client';

// Floating Dhan-style instant scalper for /index-scalper: ATM PUT / CALL buttons, and CE / PE cards with Buy / Sell.
// It places nothing itself: every click goes to the terminal's onTradeContract (placeContract's guards: live price,
// stale feed, lot cap, expiry match, SIM vs REAL). "Manage Scrips" moves each strike by ATM±N and sets the page's expiry.
//
// Rules from review (2026-11-24):
//  - Stepper is a module-level component: defined inside the render it was a new component every tick, so React
//    remounted it and a +/- press and release could land on different buttons (a lost click).
//  - The expiry is the page's (feed.expiry); a widget-local copy went out of sync with the chain and then every order
//    was refused by the expiry check.
//  - No guessed spot or lot size: without a price there is no strike, without a lot size no order.
//  - The sell "Req" is Dhan's own margin calculator (/api/options/margin), not a formula.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Settings, X, Zap } from 'lucide-react';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import type { PickedContract } from './OptionChainPanel';
import { useDraggable } from './useDraggable';
import { MAX_LOTS } from '@/lib/indexScalperPositions';
import {
  calcOptionBuyReq, computeAtmStrikes, formatDhanExpiry, formatManageScripExpiry, getStrikeOffsetLabel,
} from '@/lib/dhanScalperMath';
import { cn } from '@/lib/utils';

const STEP = 50; // NIFTY strike step

/** Manage Scrips sits beside the widget on whichever side has room, never on top of it (the widget opens at the right edge). */
function manageLeft(widgetX: number): number {
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  return widgetX + 368 + 320 <= vw - 8 ? widgetX + 368 : Math.max(8, widgetX - 328);
}
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';

export interface DhanScalperWidgetProps {
  feed: IndexScalperFeed;
  real: boolean;
  /** REAL orders' account: on Kotak the sell margin is not shown (Kotak has no basket-aware margin calculator) and
   *  quantities use Kotak's lot size. */
  broker: 'dhan' | 'kotak';
  busy: boolean;
  /** Lots for the top PUT / CALL bar; shared with the toolbar's Buy CE / Buy PE and the chain's one-click B / S. */
  topLots: number;
  onTopLotsChange: (n: number) => void;
  onTradeContract: (contract: PickedContract, side: 'BUY' | 'SELL', lots: number, product?: 'INTRADAY' | 'MARGIN') => Promise<{ ok: boolean; text: string }>;
  onClose: () => void;
}

const inr = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) || n <= 0 ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Stepper({ lots, lotSize, onChange, label }: { lots: number; lotSize: number | null; onChange: (n: number) => void; label: string }) {
  return (
    <div className="flex flex-col w-[100px]">
      <div className="flex justify-between items-center text-[10px] text-zinc-400 font-medium px-1 mb-0.5">
        <span>Qty</span>
        <span>Lot: {lots}</span>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-zinc-800 border border-zinc-700 h-9 px-1">
        <button type="button" aria-label={`Fewer lots (${label})`} disabled={lots <= 1} onClick={() => onChange(Math.max(1, lots - 1))}
          className={cn('w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30', FOCUS)}>−</button>
        <span className="text-xs font-bold tabular-nums text-zinc-100 text-center flex-1">{lotSize ? lots * lotSize : '—'}</span>
        <button type="button" aria-label={`More lots (${label})`} disabled={lots >= MAX_LOTS} onClick={() => onChange(Math.min(MAX_LOTS, lots + 1))}
          className={cn('w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30', FOCUS)}>+</button>
      </div>
    </div>
  );
}

function StrikeStepper({ strike, atm, onStep, tone, label }: { strike: number | null; atm: number | null; onStep: (d: number) => void; tone: string; label: string }) {
  return (
    <div className="flex flex-col items-center w-[110px] shrink-0">
      <div className="flex items-center justify-between w-full h-9 rounded-lg bg-zinc-800 border border-zinc-700 px-1">
        <button type="button" aria-label={`Lower ${label} strike`} disabled={strike === null} onClick={() => onStep(-1)}
          className={cn('w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30', FOCUS)}>−</button>
        <span className={cn('text-xs font-bold tabular-nums text-center flex-1', tone)}>{strike ?? '—'}</span>
        <button type="button" aria-label={`Higher ${label} strike`} disabled={strike === null} onClick={() => onStep(1)}
          className={cn('w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30', FOCUS)}>+</button>
      </div>
      <span className="text-[10px] text-zinc-400 mt-0.5 tabular-nums">{strike !== null && atm !== null ? getStrikeOffsetLabel(strike, atm, STEP) : '—'}</span>
    </div>
  );
}

/** Dhan's margin to SELL `lots` of one contract, from /api/options/margin, refreshed when the contract or size changes
 *  (debounced; not on every tick: the premium it is priced at is read when the request goes out). */
function useSellMargin(expiry: string, strike: number | null, type: 'CE' | 'PE', lots: number, ltp: number | null, enabled: boolean): number | null {
  const [margin, setMargin] = useState<{ key: string; value: number | null } | null>(null);
  const ltpRef = useRef(ltp);
  useEffect(() => { ltpRef.current = ltp; });
  const key = `${expiry}|${strike}|${type}|${lots}`;
  useEffect(() => {
    if (!enabled || !expiry || strike === null || lots < 1) return;
    let dead = false;
    const t = setTimeout(() => {
      fetch('/api/options/margin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: 'NIFTY', expiry, legs: [{ strike, type, side: 'SELL', qtyLots: lots, price: ltpRef.current ?? 0 }] }),
      })
        .then(r => r.json())
        .then((j: { success: boolean; data?: { total_margin?: number } }) => {
          if (!dead) setMargin({ key, value: j.success && j.data?.total_margin && j.data.total_margin > 0 ? j.data.total_margin : null });
        })
        .catch(() => { if (!dead) setMargin({ key, value: null }); });
    }, 600);
    return () => { dead = true; clearTimeout(t); };
  }, [key, enabled, expiry, strike, type, lots]);
  return margin && margin.key === key ? margin.value : null;
}

export default function DhanScalperWidget({ feed, real, broker, busy, topLots, onTopLotsChange, onTradeContract, onClose }: DhanScalperWidgetProps) {
  const { pos, handle } = useDraggable({ x: Math.max(16, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 400), y: 65 });

  const [ceLots, setCeLots] = useState(1);
  const [peLots, setPeLots] = useState(1);
  const [futLots, setFutLots] = useState(1);
  // Manage Scrips: strike offsets in steps from the ATM pair, so the strikes follow the spot.
  const [ceOffset, setCeOffset] = useState(0);
  const [peOffset, setPeOffset] = useState(0);
  const [ceCardOpen, setCeCardOpen] = useState(true);
  const [peCardOpen, setPeCardOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');
  const clickBusyRef = useRef(false);

  // null until the lookup for THIS expiry lands: no order then. REAL on Kotak sizes with Kotak's lot.
  const kotakReal = real && broker === 'kotak';
  const lotSize = kotakReal ? feed.kotak?.lotSize ?? null : feed.lotSize;
  const spot = feed.spot ?? feed.chain?.spot ?? null;
  const expiry = feed.expiry;
  const strikes = computeAtmStrikes(spot, STEP, peOffset, ceOffset);
  const base = computeAtmStrikes(spot, STEP);
  const atmBase = spot !== null && spot > 0 ? Math.round(spot / STEP) * STEP : null;
  const ceStrike = strikes?.ceStrike ?? null;
  const peStrike = strikes?.peStrike ?? null;

  const futContract: PickedContract | null = useMemo(() => {
    if (!feed.future) return null;
    return {
      strike: 0,
      type: 'FUT',
      securityId: feed.future.dhanId,
      ltp: feed.future.ltp,
      expiry: feed.future.expiry ?? feed.expiry,
    };
  }, [feed.future, feed.expiry]);

  const tradeFut = async (side: 'BUY' | 'SELL') => {
    if (!futContract || clickBusyRef.current || busy) return;
    clickBusyRef.current = true;
    try {
      await onTradeContract(futContract, side, futLots, productType);
    } finally {
      clickBusyRef.current = false;
    }
  };

  const ceId = ceStrike !== null ? feed.strikeIds.get(ceStrike)?.ceId ?? null : null;
  const peId = peStrike !== null ? feed.strikeIds.get(peStrike)?.peId ?? null : null;
  // Displayed premium: live, else the chain snapshot (display only; placeContract prices orders from live ticks).
  const ceLtp = (ceId ? feed.ltpById.get(ceId) : undefined) ?? (ceStrike !== null ? feed.chain?.strikes?.[String(ceStrike)]?.ce?.ltp : undefined) ?? null;
  const peLtp = (peId ? feed.ltpById.get(peId) : undefined) ?? (peStrike !== null ? feed.chain?.strikes?.[String(peStrike)]?.pe?.ltp : undefined) ?? null;

  const contract = (type: 'CE' | 'PE'): PickedContract | null => {
    const strike = type === 'CE' ? ceStrike : peStrike;
    if (strike === null) return null;
    return { strike, type, securityId: type === 'CE' ? ceId : peId, ltp: (type === 'CE' ? ceLtp : peLtp) || null, expiry };
  };

  // Dhan's margin calculator is asked only for a Dhan account: on Kotak it would be another broker's figure.
  const ceSellReq = useSellMargin(expiry, ceStrike, 'CE', ceLots, ceLtp, ceCardOpen && !kotakReal);
  const peSellReq = useSellMargin(expiry, peStrike, 'PE', peLots, peLtp, peCardOpen && !kotakReal);

  const ready = strikes !== null && lotSize !== null;
  const why = spot === null ? 'Waiting for a NIFTY price' : lotSize === null ? (kotakReal ? 'Waiting for Kotak contracts for this expiry' : 'Waiting for the lot size of this expiry') : null;

  const trade = async (type: 'CE' | 'PE', side: 'BUY' | 'SELL', lots: number) => {
    if (clickBusyRef.current || busy) return;
    const c = contract(type);
    if (!c || !ready) return;
    clickBusyRef.current = true;
    try { await onTradeContract(c, side, lots, productType); } finally { clickBusyRef.current = false; }
  };

  const tradeBtn = 'w-full rounded-lg text-oncolor font-bold shadow-sm transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300';
  const expiryLabel = formatDhanExpiry(expiry);

  const card = (type: 'CE' | 'PE') => {
    const ce = type === 'CE';
    const open = ce ? ceCardOpen : peCardOpen;
    const setOpen = ce ? setCeCardOpen : setPeCardOpen;
    const strike = ce ? ceStrike : peStrike;
    const lots = ce ? ceLots : peLots;
    const sellReq = ce ? ceSellReq : peSellReq;
    const buyReq = calcOptionBuyReq(ce ? ceLtp : peLtp, lots, lotSize);
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-2.5 shadow-sm">
        <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}
          className={cn('w-full flex items-center justify-between py-0.5 rounded', FOCUS)}>
          <span className="flex items-center gap-2">
            <span className={cn('text-[10px] font-bold px-1.5 py-0.5 rounded border', ce ? 'text-sky-400 bg-sky-500/10 border-sky-500/30' : 'text-rose-400 bg-rose-500/10 border-rose-500/30')}>{type}</span>
            <span className="text-xs font-bold text-zinc-100">NIFTY {expiryLabel} {strike ?? '—'}</span>
          </span>
          <span className="text-zinc-400">{open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
        </button>
        {open && (
          <div className="mt-2.5 flex flex-col gap-1">
            <div className="grid grid-cols-[1fr_100px_1fr] gap-2 items-center">
              <button type="button" disabled={busy || !ready} onClick={() => trade(type, 'SELL', lots)} aria-label={`Sell ${strike ?? ''} ${type}`}
                className={cn(tradeBtn, 'h-9 text-xs bg-rose-600 hover:bg-rose-500')}>Sell</button>
              <div className="flex justify-center"><Stepper lots={lots} lotSize={lotSize} onChange={ce ? setCeLots : setPeLots} label={type} /></div>
              <button type="button" disabled={busy || !ready} onClick={() => trade(type, 'BUY', lots)} aria-label={`Buy ${strike ?? ''} ${type}`}
                className={cn(tradeBtn, 'h-9 text-xs bg-sky-600 hover:bg-sky-500')}>Buy</button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-400 tabular-nums px-0.5 mt-0.5">
              <div title={kotakReal ? 'Kotak has no basket-aware margin calculator: check margin at Kotak' : "Dhan's margin calculator for this sell"}>Margin: {kotakReal ? '—' : inr(sellReq)}</div>
              <div className="text-right" title="Premium to buy at the shown price">Premium: {inr(buyReq)}</div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div style={{ left: pos.x, top: pos.y }} data-testid="dhan-scalper-widget"
        className={cn('fixed z-50 w-[360px] rounded-2xl shadow-2xl select-none bg-zinc-900 border border-zinc-700', real ? 'ring-2 ring-rose-500/80' : 'ring-1 ring-zinc-700/60')}>
        <div {...handle} className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 cursor-move">
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="w-4 h-4 text-sky-400 fill-sky-400 shrink-0" />
            <span className="text-sm font-bold text-zinc-100 tracking-tight">{feed.underlying === 'CRUDEOILM' ? 'CRUDEOILM (MCX)' : 'NIFTY 50'}</span>
            <span className={cn('text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border',
              real ? 'bg-rose-500/10 text-rose-400 border-rose-500/30' : 'bg-amber-500/10 text-amber-400 border-amber-500/30')}>{real ? `REAL · ${broker === 'kotak' ? 'Kotak' : 'Dhan'}` : 'SIM'}</span>
            <span className="text-[9px] font-bold text-amber-300" title="Buttons here send a market order at once">ONE-CLICK</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <button type="button" aria-label="Manage scrips" title="Manage Scrips: strikes, expiry, product" aria-pressed={settingsOpen} onClick={() => setSettingsOpen(s => !s)}
              className={cn('p-1 rounded transition-colors', FOCUS, settingsOpen ? 'text-sky-400 bg-zinc-800' : 'hover:text-zinc-100 hover:bg-zinc-800')}>
              <Settings className="w-4 h-4" />
            </button>
            <button type="button" aria-label="Close scalper" title="Close (also turns one-click off)" onClick={onClose}
              className={cn('p-1 rounded hover:text-zinc-100 hover:bg-zinc-800 transition-colors', FOCUS)}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-3 flex flex-col gap-2.5">
          {why && <div role="status" className="text-[11px] text-amber-300">{why}: orders are off.</div>}
          <div>
            <div className="grid grid-cols-[1fr_100px_1fr] items-center mb-1 px-1">
              <div className="text-xs font-semibold text-zinc-400 text-center tabular-nums">{base?.peStrike ?? '—'}</div>
              <div />
              <div className="text-xs font-semibold text-zinc-400 text-center tabular-nums">{base?.ceStrike ?? '—'}</div>
            </div>
            <div className="grid grid-cols-[1fr_100px_1fr] gap-2 items-start">
              <div className="flex flex-col items-center">
                <button type="button" disabled={busy || !ready} aria-label={`Buy ATM put ${base?.peStrike ?? ''}`}
                  onClick={() => { if (base) void tradeAtm('PE'); }}
                  className={cn(tradeBtn, 'h-10 text-sm bg-rose-600 hover:bg-rose-500 flex items-center justify-center gap-1')}>
                  <span>↓</span><span>PUT</span>
                </button>
                <span className="text-[11px] text-zinc-400 text-center mt-1 tabular-nums">{inr(calcOptionBuyReq(atmLtp('PE'), topLots, lotSize))}</span>
              </div>
              <div className="flex justify-center"><Stepper lots={topLots} lotSize={lotSize} onChange={onTopLotsChange} label="ATM" /></div>
              <div className="flex flex-col items-center">
                <button type="button" disabled={busy || !ready} aria-label={`Buy ATM call ${base?.ceStrike ?? ''}`}
                  onClick={() => { if (base) void tradeAtm('CE'); }}
                  className={cn(tradeBtn, 'h-10 text-sm bg-sky-600 hover:bg-sky-500 flex items-center justify-center gap-1')}>
                  <span>↑</span><span>CALL</span>
                </button>
                <span className="text-[11px] text-zinc-400 text-center mt-1 tabular-nums">{inr(calcOptionBuyReq(atmLtp('CE'), topLots, lotSize))}</span>
              </div>
            </div>
          </div>
          {card('CE')}
          {card('PE')}
          {feed.underlying === 'CRUDEOILM' && futContract && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 shadow-sm">
              <div className="flex items-center justify-between py-0.5">
                <span className="text-xs font-bold text-amber-300">
                  FUT · {futContract.expiry ? futContract.expiry.slice(5) : ''} ({futContract.ltp ? futContract.ltp.toFixed(2) : '—'})
                </span>
                <span className="text-[10px] text-zinc-400">Mini 10 bbl</span>
              </div>
              <div className="mt-2 grid grid-cols-[1fr_100px_1fr] gap-2 items-center">
                <button
                  type="button"
                  disabled={busy || !ready || !futContract.ltp}
                  onClick={() => void tradeFut('SELL')}
                  className={cn(tradeBtn, 'h-9 text-xs bg-rose-600 hover:bg-rose-500')}
                >
                  Sell FUT
                </button>
                <div className="flex justify-center">
                  <Stepper lots={futLots} lotSize={lotSize} onChange={setFutLots} label="FUT" />
                </div>
                <button
                  type="button"
                  disabled={busy || !ready || !futContract.ltp}
                  onClick={() => void tradeFut('BUY')}
                  className={cn(tradeBtn, 'h-9 text-xs bg-sky-600 hover:bg-sky-500')}
                >
                  Buy FUT
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div style={{ left: manageLeft(pos.x), top: pos.y }}
          data-testid="manage-scrips-panel" className="fixed z-50 w-[320px] rounded-2xl shadow-2xl select-none bg-zinc-900 border border-zinc-700 p-3.5 ring-1 ring-zinc-700/60">
          <div className="flex items-center justify-between pb-2.5 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-bold text-zinc-100">Manage Scrips</span>
            </div>
            <button type="button" aria-label="Close manage scrips" onClick={() => setSettingsOpen(false)}
              className={cn('p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors', FOCUS)}><X className="w-4 h-4" /></button>
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">Expiry
              {/* The page's expiry (chain, ticket and widget share it): changing it here changes it everywhere. */}
              <select value={expiry} onChange={e => feed.setExpiry(e.target.value)}
                className={cn('flex-1 h-9 px-2 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 font-medium cursor-pointer', FOCUS)}>
                {feed.expiries.length > 0
                  ? feed.expiries.map(x => <option key={x} value={x}>{formatManageScripExpiry(x)}</option>)
                  : <option value={expiry}>{formatManageScripExpiry(expiry) || 'Expiry'}</option>}
              </select>
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/30 px-2 py-1 rounded shrink-0">CE</span>
              <StrikeStepper strike={ceStrike} atm={atmBase} onStep={d => setCeOffset(o => o + d)} tone="text-sky-400" label="CE" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 px-2 py-1 rounded shrink-0">PE</span>
              <StrikeStepper strike={peStrike} atm={atmBase} onStep={d => setPeOffset(o => o + d)} tone="text-zinc-100" label="PE" />
            </div>
            <div className="mt-1 pt-2 border-t border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-400 font-medium">Product</span>
              <div role="group" aria-label="Product" className="flex rounded border border-zinc-700 overflow-hidden bg-zinc-800">
                {(['INTRADAY', 'MARGIN'] as const).map(p => (
                  <button key={p} type="button" aria-pressed={productType === p} onClick={() => setProductType(p)}
                    className={cn('px-2.5 py-1 font-semibold text-[11px]', FOCUS, productType === p ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-700/50')}>
                    {p === 'INTRADAY' ? 'Intraday (MIS)' : 'Normal (NRML)'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // The top bar always trades the ATM pair (no Manage Scrips offset), like Dhan's.
  function atmLtp(type: 'CE' | 'PE'): number | null {
    if (!base) return null;
    const strike = type === 'CE' ? base.ceStrike : base.peStrike;
    const id = type === 'CE' ? feed.strikeIds.get(strike)?.ceId : feed.strikeIds.get(strike)?.peId;
    return (id ? feed.ltpById.get(id) : undefined) ?? (type === 'CE' ? feed.chain?.strikes?.[String(strike)]?.ce?.ltp : feed.chain?.strikes?.[String(strike)]?.pe?.ltp) ?? null;
  }
  async function tradeAtm(type: 'CE' | 'PE') {
    if (!base || clickBusyRef.current || busy || !ready) return;
    const strike = type === 'CE' ? base.ceStrike : base.peStrike;
    const id = (type === 'CE' ? feed.strikeIds.get(strike)?.ceId : feed.strikeIds.get(strike)?.peId) ?? null;
    clickBusyRef.current = true;
    try { await onTradeContract({ strike, type, securityId: id, ltp: atmLtp(type), expiry }, 'BUY', topLots, productType); } finally { clickBusyRef.current = false; }
  }
}
