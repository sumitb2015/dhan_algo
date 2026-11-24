'use client';

// Floating Dhan Scalper window for /index-scalper.
// An exact replica of Dhan's live TradingView Instant Scalper tool for high-speed options scalping.
// Fully themed across dark, white, and beige modes using the repo's zinc token system.
// Features "Manage Scrips" settings dialog to adjust CE and PE strikes (ATM, ATM±N) and expiry.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Settings,
  X,
  Zap,
} from 'lucide-react';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import type { PickedContract } from './OptionChainPanel';
import { useDraggable } from './useDraggable';
import { MAX_LOTS, orderUnits } from '@/lib/indexScalperPositions';
import {
  computeAtmStrikes,
  formatDhanExpiry,
  formatManageScripExpiry,
  getStrikeOffsetLabel,
  calcOptionBuyReq,
  calcOptionSellReq,
} from '@/lib/dhanScalperMath';
import { cn } from '@/lib/utils';

export interface DhanScalperWidgetProps {
  feed: IndexScalperFeed;
  real: boolean;
  busy: boolean;
  onTradeContract: (
    contract: PickedContract,
    side: 'BUY' | 'SELL',
    lots: number,
    product?: 'INTRADAY' | 'MARGIN'
  ) => Promise<{ ok: boolean; text: string }>;
  onClose: () => void;
  onFlash: (toast: { ok: boolean; text: string }) => void;
}

const inr = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '₹0.00';
  return `₹${n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export default function DhanScalperWidget({
  feed,
  real,
  busy,
  onTradeContract,
  onClose,
  onFlash,
}: DhanScalperWidgetProps) {
  // Floating position on top right by default, draggable
  const { pos, handle } = useDraggable({
    x: Math.max(16, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 400),
    y: 65,
  });

  const [topLots, setTopLots] = useState(1);
  const [ceLots, setCeLots] = useState(1);
  const [peLots, setPeLots] = useState(1);

  const [customCeStrike, setCustomCeStrike] = useState<number | null>(null);
  const [customPeStrike, setCustomPeStrike] = useState<number | null>(null);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');

  const [ceCardOpen, setCeCardOpen] = useState(true);
  const [peCardOpen, setPeCardOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');

  // Prevent duplicate execution on rapid clicks
  const clickBusyRef = useRef(false);

  const lotSize = feed.lotSize ?? 65;
  const spot = feed.spot ?? feed.chain?.spot ?? 25000;
  const activeExpiry = selectedExpiry || feed.expiry;
  const formattedExpiry = formatDhanExpiry(activeExpiry);

  // Compute strikes:
  // Lower strike for PE (closest round strike below or at spot), Upper strike for CE (closest round strike above or at spot)
  const defaultStrikes = useMemo(() => computeAtmStrikes(spot, 50), [spot]);
  const peStrike = customPeStrike ?? defaultStrikes.peStrike;
  const ceStrike = customCeStrike ?? defaultStrikes.ceStrike;
  const atmBase = Math.round(spot / 50) * 50;

  // Resolve security IDs and LTPs from feed
  const peIds = feed.strikeIds.get(peStrike);
  const ceIds = feed.strikeIds.get(ceStrike);

  const ceQuotes = feed.quotes?.strikes?.[String(ceStrike)]?.ce ?? feed.chain?.strikes?.[String(ceStrike)]?.ce;
  const peQuotes = feed.quotes?.strikes?.[String(peStrike)]?.pe ?? feed.chain?.strikes?.[String(peStrike)]?.pe;

  const ceSecurityId = ceIds?.ceId ?? null;
  const peSecurityId = peIds?.peId ?? null;

  const ceLtp = (ceSecurityId ? feed.ltpById.get(ceSecurityId) : null) ?? ceQuotes?.ltp ?? null;
  const peLtp = (peSecurityId ? feed.ltpById.get(peSecurityId) : null) ?? peQuotes?.ltp ?? null;

  // Reset custom strikes if underlying changes drastically (e.g. > 1000 points)
  useEffect(() => {
    if (customCeStrike && Math.abs(customCeStrike - spot) > 2000) setCustomCeStrike(null);
    if (customPeStrike && Math.abs(customPeStrike - spot) > 2000) setCustomPeStrike(null);
  }, [spot, customCeStrike, customPeStrike]);

  // Contracts
  const ceContract: PickedContract = useMemo(
    () => ({
      strike: ceStrike,
      type: 'CE',
      securityId: ceSecurityId,
      ltp: ceLtp,
      expiry: activeExpiry,
    }),
    [ceStrike, ceSecurityId, ceLtp, activeExpiry]
  );

  const peContract: PickedContract = useMemo(
    () => ({
      strike: peStrike,
      type: 'PE',
      securityId: peSecurityId,
      ltp: peLtp,
      expiry: activeExpiry,
    }),
    [peStrike, peSecurityId, peLtp, activeExpiry]
  );

  // Top Action ATM requirements
  const topCeBuyReq = calcOptionBuyReq(ceLtp, topLots, lotSize);
  const topPeBuyReq = calcOptionBuyReq(peLtp, topLots, lotSize);

  // Card 1 CE requirements
  const ceBuyReq = calcOptionBuyReq(ceLtp, ceLots, lotSize);
  const ceSellReq = calcOptionSellReq(ceStrike, spot, ceLtp, ceLots, lotSize, 'CE');

  // Card 2 PE requirements
  const peBuyReq = calcOptionBuyReq(peLtp, peLots, lotSize);
  const peSellReq = calcOptionSellReq(peStrike, spot, peLtp, peLots, lotSize, 'PE');

  // Execute trade helper
  const handleTrade = async (
    c: PickedContract,
    side: 'BUY' | 'SELL',
    lots: number,
    label: string
  ) => {
    if (clickBusyRef.current || busy) return;
    clickBusyRef.current = true;
    try {
      const units = orderUnits(lots, lotSize);
      if (!units.ok) {
        onFlash({ ok: false, text: units.error });
        return;
      }
      if (!c.securityId) {
        onFlash({ ok: false, text: `No contract ID found for ${c.strike} ${c.type}` });
        return;
      }
      await onTradeContract(c, side, lots, productType);
    } catch (err) {
      onFlash({ ok: false, text: `Trade failed: ${String(err instanceof Error ? err.message : err)}` });
    } finally {
      clickBusyRef.current = false;
    }
  };

  // Stepper component for uniform interactive lot sizing
  const Stepper = ({
    lots,
    onChange,
  }: {
    lots: number;
    onChange: (n: number) => void;
  }) => {
    const qty = lots * lotSize;
    return (
      <div className="flex flex-col w-[100px]">
        <div className="flex justify-between items-center text-[10px] text-zinc-400 font-medium px-1 mb-0.5">
          <span>Qty</span>
          <span>Lot: {lots}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-zinc-800 border border-zinc-700 h-9 px-1">
          <button
            type="button"
            aria-label="Decrease quantity"
            disabled={lots <= 1}
            onClick={() => onChange(Math.max(1, lots - 1))}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30 focus:outline-none"
          >
            −
          </button>
          <span className="text-xs font-bold tabular-nums text-zinc-100 text-center flex-1">
            {qty}
          </span>
          <button
            type="button"
            aria-label="Increase quantity"
            disabled={lots >= MAX_LOTS}
            onClick={() => onChange(Math.min(MAX_LOTS, lots + 1))}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base disabled:opacity-30 focus:outline-none"
          >
            +
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* ── Main Scalper Widget ───────────────────────────────── */}
      <div
        style={{ left: pos.x, top: pos.y }}
        data-testid="dhan-scalper-widget"
        className={cn(
          'fixed z-50 w-[340px] sm:w-[360px] rounded-2xl shadow-2xl select-none',
          'bg-zinc-900 border border-zinc-700',
          real ? 'ring-2 ring-rose-500/80' : 'ring-1 ring-zinc-700/60'
        )}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div
          {...handle}
          className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 cursor-move"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="w-4 h-4 text-sky-400 fill-sky-400 shrink-0" />
            <span className="text-sm font-bold text-zinc-100 tracking-tight">
              NIFTY 50
            </span>
            <span
              className={cn(
                'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded',
                real
                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
              )}
            >
              {real ? 'REAL' : 'SIM'}
            </span>
          </div>

          <div className="flex items-center gap-2 text-zinc-400">
            <button
              type="button"
              aria-label="Scalper settings"
              title="Manage Scrips & Settings"
              onClick={() => setSettingsOpen(s => !s)}
              className={cn(
                'p-1 rounded transition-colors',
                settingsOpen
                  ? 'text-sky-400 bg-zinc-800'
                  : 'hover:text-zinc-100 hover:bg-zinc-800'
              )}
            >
              <Settings className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Popout window"
              title="External View"
              onClick={() => {
                window.open(window.location.href, '_blank', 'width=400,height=600');
              }}
              className="p-1 rounded hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Close scalper"
              title="Close Scalper"
              onClick={onClose}
              className="p-1 rounded hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-3 flex flex-col gap-2.5">
          {/* ── Top Instant Order Bar (ATM Quick Actions) ──────── */}
          <div>
            {/* Strike Indicators */}
            <div className="grid grid-cols-[1fr_100px_1fr] items-center mb-1 px-1">
              <div className="text-xs font-semibold text-zinc-400 text-center tabular-nums">
                {peStrike}
              </div>
              <div />
              <div className="text-xs font-semibold text-zinc-400 text-center tabular-nums">
                {ceStrike}
              </div>
            </div>

            {/* Action Row */}
            <div className="grid grid-cols-[1fr_100px_1fr] gap-2 items-start">
              {/* PUT Button */}
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleTrade(peContract, 'BUY', topLots, `Put (${peStrike})`)}
                  className="w-full h-10 rounded-lg bg-rose-600 hover:bg-rose-500 active:scale-95 text-oncolor font-bold text-sm shadow-sm flex items-center justify-center gap-1 transition-all disabled:opacity-50"
                >
                  <span>↓</span>
                  <span>PUT</span>
                </button>
                <span className="text-[11px] text-zinc-400 text-center mt-1 tabular-nums">
                  Req: {inr(topPeBuyReq)}
                </span>
              </div>

              {/* Quantity Stepper */}
              <div className="flex justify-center">
                <Stepper lots={topLots} onChange={setTopLots} />
              </div>

              {/* CALL Button */}
              <div className="flex flex-col items-center">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleTrade(ceContract, 'BUY', topLots, `Call (${ceStrike})`)}
                  className="w-full h-10 rounded-lg bg-sky-600 hover:bg-sky-500 active:scale-95 text-oncolor font-bold text-sm shadow-sm flex items-center justify-center gap-1 transition-all disabled:opacity-50"
                >
                  <span>↑</span>
                  <span>CALL</span>
                </button>
                <span className="text-[11px] text-zinc-400 text-center mt-1 tabular-nums">
                  Req: {inr(topCeBuyReq)}
                </span>
              </div>
            </div>
          </div>

          {/* ── Card 1: CE Option ─────────────────────────────── */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-2.5 shadow-sm">
            <div
              className="flex items-center justify-between cursor-pointer py-0.5"
              onClick={() => setCeCardOpen(v => !v)}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/30 px-1.5 py-0.5 rounded">
                  CE
                </span>
                <span className="text-xs font-bold text-zinc-100">
                  NIFTY {formattedExpiry} {ceStrike}
                </span>
              </div>
              <button type="button" aria-label="Toggle CE Card" className="text-zinc-400 hover:text-zinc-200">
                {ceCardOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>

            {ceCardOpen && (
              <div className="mt-2.5 flex flex-col gap-1">
                <div className="grid grid-cols-[1fr_100px_1fr] gap-2 items-center">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleTrade(ceContract, 'SELL', ceLots, `Sell CE ${ceStrike}`)}
                    className="w-full h-9 rounded-lg bg-rose-600 hover:bg-rose-500 active:scale-95 text-oncolor font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                  >
                    Sell
                  </button>
                  <div className="flex justify-center">
                    <Stepper lots={ceLots} onChange={setCeLots} />
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleTrade(ceContract, 'BUY', ceLots, `Buy CE ${ceStrike}`)}
                    className="w-full h-9 rounded-lg bg-sky-600 hover:bg-sky-500 active:scale-95 text-oncolor font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                  >
                    Buy
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-400 tabular-nums px-0.5 mt-0.5">
                  <div>Req: {inr(ceSellReq)}</div>
                  <div className="text-right">Req: {inr(ceBuyReq)}</div>
                </div>
              </div>
            )}
          </div>

          {/* ── Card 2: PE Option ─────────────────────────────── */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-2.5 shadow-sm">
            <div
              className="flex items-center justify-between cursor-pointer py-0.5"
              onClick={() => setPeCardOpen(v => !v)}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 px-1.5 py-0.5 rounded">
                  PE
                </span>
                <span className="text-xs font-bold text-zinc-100">
                  NIFTY {formattedExpiry} {peStrike}
                </span>
              </div>
              <button type="button" aria-label="Toggle PE Card" className="text-zinc-400 hover:text-zinc-200">
                {peCardOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>

            {peCardOpen && (
              <div className="mt-2.5 flex flex-col gap-1">
                <div className="grid grid-cols-[1fr_100px_1fr] gap-2 items-center">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleTrade(peContract, 'SELL', peLots, `Sell PE ${peStrike}`)}
                    className="w-full h-9 rounded-lg bg-rose-600 hover:bg-rose-500 active:scale-95 text-oncolor font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                  >
                    Sell
                  </button>
                  <div className="flex justify-center">
                    <Stepper lots={peLots} onChange={setPeLots} />
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleTrade(peContract, 'BUY', peLots, `Buy PE ${peStrike}`)}
                    className="w-full h-9 rounded-lg bg-sky-600 hover:bg-sky-500 active:scale-95 text-oncolor font-bold text-xs shadow-sm transition-all disabled:opacity-50"
                  >
                    Buy
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-400 tabular-nums px-0.5 mt-0.5">
                  <div>Req: {inr(peSellReq)}</div>
                  <div className="text-right">Req: {inr(peBuyReq)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Manage Scrips Panel (opened when clicking ⚙) ───────── */}
      {settingsOpen && (
        <div
          style={{
            left: Math.min(pos.x + 365, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 340),
            top: pos.y,
          }}
          data-testid="manage-scrips-panel"
          className={cn(
            'fixed z-50 w-[320px] rounded-2xl shadow-2xl select-none',
            'bg-zinc-900 border border-zinc-700 p-3.5',
            'ring-1 ring-zinc-700/60'
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between pb-2.5 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-zinc-400" />
              <span className="text-sm font-bold text-zinc-100">Manage Scrips</span>
            </div>
            <button
              type="button"
              aria-label="Close manage scrips"
              onClick={() => setSettingsOpen(false)}
              className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-3">
            {/* CE Row */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-sky-400 bg-sky-500/10 border border-sky-500/30 px-2 py-1 rounded shrink-0">
                CE
              </span>
              <select
                value={activeExpiry}
                onChange={e => {
                  setSelectedExpiry(e.target.value);
                  feed.setExpiry(e.target.value);
                }}
                className="flex-1 h-9 px-2 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 font-medium focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
              >
                {feed.expiries.length > 0 ? (
                  feed.expiries.map(exp => (
                    <option key={exp} value={exp}>
                      {formatManageScripExpiry(exp)}
                    </option>
                  ))
                ) : (
                  <option value={activeExpiry}>{formatManageScripExpiry(activeExpiry) || 'Expiry'}</option>
                )}
              </select>

              {/* CE Strike Stepper */}
              <div className="flex flex-col items-center w-[110px] shrink-0">
                <div className="flex items-center justify-between w-full h-9 rounded-lg bg-zinc-800 border border-zinc-700 px-1">
                  <button
                    type="button"
                    aria-label="Decrease CE strike"
                    onClick={() => setCustomCeStrike(ceStrike - 50)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base focus:outline-none"
                  >
                    −
                  </button>
                  <span className="text-xs font-bold tabular-nums text-sky-400 text-center flex-1">
                    {ceStrike}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase CE strike"
                    onClick={() => setCustomCeStrike(ceStrike + 50)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base focus:outline-none"
                  >
                    +
                  </button>
                </div>
                <span className="text-[10px] text-zinc-400 mt-0.5 tabular-nums">
                  {getStrikeOffsetLabel(ceStrike, atmBase)}
                </span>
              </div>
            </div>

            {/* PE Row */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 px-2 py-1 rounded shrink-0">
                PE
              </span>
              <select
                value={activeExpiry}
                onChange={e => {
                  setSelectedExpiry(e.target.value);
                  feed.setExpiry(e.target.value);
                }}
                className="flex-1 h-9 px-2 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-100 font-medium focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
              >
                {feed.expiries.length > 0 ? (
                  feed.expiries.map(exp => (
                    <option key={exp} value={exp}>
                      {formatManageScripExpiry(exp)}
                    </option>
                  ))
                ) : (
                  <option value={activeExpiry}>{formatManageScripExpiry(activeExpiry) || 'Expiry'}</option>
                )}
              </select>

              {/* PE Strike Stepper */}
              <div className="flex flex-col items-center w-[110px] shrink-0">
                <div className="flex items-center justify-between w-full h-9 rounded-lg bg-zinc-800 border border-zinc-700 px-1">
                  <button
                    type="button"
                    aria-label="Decrease PE strike"
                    onClick={() => setCustomPeStrike(peStrike - 50)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base focus:outline-none"
                  >
                    −
                  </button>
                  <span className="text-xs font-bold tabular-nums text-zinc-100 text-center flex-1">
                    {peStrike}
                  </span>
                  <button
                    type="button"
                    aria-label="Increase PE strike"
                    onClick={() => setCustomPeStrike(peStrike + 50)}
                    className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-300 hover:text-zinc-100 font-bold text-base focus:outline-none"
                  >
                    +
                  </button>
                </div>
                <span className="text-[10px] text-zinc-400 mt-0.5 tabular-nums">
                  {getStrikeOffsetLabel(peStrike, atmBase)}
                </span>
              </div>
            </div>

            {/* Product selection (Intraday vs Normal) */}
            <div className="mt-1 pt-2 border-t border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-400 font-medium">Product Type:</span>
              <div className="flex rounded border border-zinc-700 overflow-hidden bg-zinc-800">
                <button
                  type="button"
                  onClick={() => setProductType('INTRADAY')}
                  className={cn(
                    'px-2.5 py-1 font-semibold text-[11px]',
                    productType === 'INTRADAY'
                      ? 'bg-sky-600 text-oncolor'
                      : 'text-zinc-400 hover:bg-zinc-700/50'
                  )}
                >
                  Intraday (MIS)
                </button>
                <button
                  type="button"
                  onClick={() => setProductType('MARGIN')}
                  className={cn(
                    'px-2.5 py-1 font-semibold text-[11px]',
                    productType === 'MARGIN'
                      ? 'bg-sky-600 text-oncolor'
                      : 'text-zinc-400 hover:bg-zinc-700/50'
                  )}
                >
                  Normal (NRML)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
