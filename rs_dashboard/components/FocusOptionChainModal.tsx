'use client';

/**
 * Full NIFTY option chain in a modal, launched from the Focus Tool header.
 *
 * Deliberately standalone from OptionsSmartChainTab.tsx (the standalone
 * Options page's own chain tab) — same convention as focus_tool_ws.py vs
 * live_options_ws.py: small helpers are copied, not cross-imported, so this
 * modal and that page can evolve independently. Adds two columns
 * OptionsSmartChainTab doesn't have: day-over-day Price% and OI% (that page's
 * "OI ▌" bar is OI-relative-to-max-in-window, a different question).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { FocusModal } from './FocusTool';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

// ─── Types ────────────────────────────────────────────────────────

interface RawChainSide {
  last_price?: number;
  /** Dhan's option-chain response names this previous_close_price, not
   *  previous_close — see CLAUDE.md's Critical API Conventions. */
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  security_id?: string | number;
}

interface RawChainEntry { ce?: RawChainSide; pe?: RawChainSide }

interface ProcessedRow {
  strike: number;
  ce: RawChainSide | null;
  pe: RawChainSide | null;
  /** OI relative to the max OI in the visible strike window — "which strike
   *  has the biggest OI here", not a day-over-day change. */
  ceOIPct: number;
  peOIPct: number;
  /** Day-over-day, vs previous_oi / previous_close_price. Null when the
   *  bridge/API hasn't got a baseline yet, not zero. */
  cePriceChgPct: number | null;
  pePriceChgPct: number | null;
  ceOIChgPct: number | null;
  peOIChgPct: number | null;
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
// Slightly longer than OptionsSmartChainTab's 15s: this is a transient,
// user-attended overlay that can be open alongside that page's own polling,
// and /api/options/chain already absorbs the difference with its 10s cache.
const POLL_MS = 20_000;

const WING_OPTIONS = [5, 10, 15] as const;
type Wings = typeof WING_OPTIONS[number];

// ─── Helpers (copied from OptionsSmartChainTab.tsx, not imported) ─

function fmtOI(n: number): string {
  if (n === 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${sign}${(abs / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtLTP(n: number | undefined): string {
  if (!n) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function pctColor(n: number | null): string {
  if (n === null) return 'text-zinc-500';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-rose-400';
  return 'text-zinc-400';
}

interface StrikeEntry { key: string; strike: number; entry: RawChainEntry }

function parseStrikeEntries(oc: Record<string, RawChainEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

// OI% mini bar — fills from right for CE side, left for PE side. Local copy;
// OptionsSmartChainTab.tsx's version isn't exported.
function OIBar({ pct, side }: { pct: number; side: 'ce' | 'pe' }) {
  const barColor = side === 'ce' ? 'rgba(59,130,246,0.35)' : 'rgba(239,68,68,0.35)';
  const width = `${Math.min(pct, 100)}%`;
  return (
    <div className="relative h-4 w-full min-w-[48px]">
      {side === 'ce' ? (
        <div className="absolute inset-y-0 right-0 rounded-sm" style={{ width, backgroundColor: barColor }} />
      ) : (
        <div className="absolute inset-y-0 left-0 rounded-sm" style={{ width, backgroundColor: barColor }} />
      )}
      <span className={cn('relative z-10 text-xs tabular-nums font-bold text-zinc-200', side === 'ce' ? 'float-right' : 'float-left')}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function FocusOptionChainModal({
  isOpen, onClose, expiries,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** NIFTY expiries, nearest first — FocusTool's own expiries.NIFTY. */
  expiries: string[];
}) {
  const [expiry, setExpiry]           = useState('');
  const [wings, setWings]             = useState<Wings>(10);
  const [rows, setRows]               = useState<ProcessedRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  const [lots, setLots]               = useState(1);
  // null until /api/lotsize resolves it — never seed with a literal, lot
  // sizes change (NIFTY has been both 75 and 65 within one year).
  const [lotSize, setLotSize]         = useState<number | null>(null);
  const [orderMessage, setOrderMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [ordering, setOrdering]       = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Default to the nearest expiry once the list arrives; don't clobber a
  // user-picked expiry on a later re-render of the same `expiries` prop.
  useEffect(() => {
    if (!expiry && expiries.length > 0) setExpiry(expiries[0]);
  }, [expiries, expiry]);

  useEffect(() => {
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then(r => r.json())
      .then(json => { if (json.lot_size) setLotSize(json.lot_size); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (orderMessage) {
      const t = setTimeout(() => setOrderMessage(null), 6000);
      return () => clearTimeout(t);
    }
  }, [orderMessage]);

  const handlePlaceOrder = useCallback(async (securityId: string | number, side: 'BUY' | 'SELL') => {
    if (ordering) return;
    if (!lotSize || lotSize <= 0) {
      setOrderMessage({ text: `Lot size for ${UNDERLYING} not resolved yet — retry in a moment`, isError: true });
      return;
    }
    setOrdering(true);
    setOrderMessage(null);
    try {
      const qty = lots * lotSize;
      const res = await fetch('/api/options/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legs: [{ securityId: String(securityId), quantity: qty, side }],
          mode: 'intraday',
        }),
      });
      const json = await res.json();
      if (json.success) {
        setOrderMessage({
          text: `Successfully fired MARKET order to ${side} ${qty} Qty (${lots} Lot${lots > 1 ? 's' : ''})! Order ID: ${json.data?.[0]?.orderId || 'N/A'}`,
          isError: false,
        });
      } else {
        setOrderMessage({ text: `Failed: ${json.error || 'Unknown error'}`, isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error placing order: ${String(err)}`, isError: true });
    } finally {
      setOrdering(false);
    }
  }, [lots, lotSize, ordering]);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, RawChainEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      if (spotPrice <= 0) {
        // Keep showing the last good render rather than re-centering the
        // strike window on strike 0.
        setError('Spot price unavailable — showing last known chain');
        return;
      }
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc = json.data.chain.oc;
      if (!oc || Object.keys(oc).length === 0) {
        setError('Option chain data empty — showing last known chain');
        return;
      }

      const allEntries = parseStrikeEntries(oc);
      const atmIdx = allEntries.reduce((best, { strike }, i) =>
        Math.abs(strike - atmStrike) < Math.abs(allEntries[best].strike - atmStrike) ? i : best, 0);
      const lo = Math.max(0, atmIdx - wings);
      const hi = Math.min(allEntries.length - 1, atmIdx + wings);
      const visible = allEntries.slice(lo, hi + 1);

      let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
      for (const { strike, entry } of visible) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = strike; }
        if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = strike; }
      }

      const pctChange = (ltp: number | undefined, prevClose: number | undefined): number | null => {
        const p = Number(prevClose) || 0;
        const l = Number(ltp) || 0;
        return p > 0 ? ((l - p) / p) * 100 : null;
      };
      const oiChange = (oi: number | undefined, prevOi: number | undefined): number | null => {
        const p = Number(prevOi) || 0;
        const o = Number(oi) || 0;
        return p > 0 ? ((o - p) / p) * 100 : null;
      };

      const processed: ProcessedRow[] = visible.map(({ strike, entry }) => {
        const ce = entry.ce ?? null;
        const pe = entry.pe ?? null;
        const ceOI = ce?.oi ?? 0;
        const peOI = pe?.oi ?? 0;
        return {
          strike,
          ce,
          pe,
          ceOIPct: maxCEOI > 0 ? (ceOI / maxCEOI) * 100 : 0,
          peOIPct: maxPEOI > 0 ? (peOI / maxPEOI) * 100 : 0,
          cePriceChgPct: pctChange(ce?.last_price, ce?.previous_close_price),
          pePriceChgPct: pctChange(pe?.last_price, pe?.previous_close_price),
          ceOIChgPct: oiChange(ce?.oi, ce?.previous_oi),
          peOIChgPct: oiChange(pe?.oi, pe?.previous_oi),
          isATM: strike === atmStrike,
          isMaxCEOI: strike === maxCEStrike && maxCEOI > 0,
          isMaxPEOI: strike === maxPEStrike && maxPEOI > 0,
        };
      });

      setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(processed);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry, wings]);

  // Gated on isOpen rather than conditionally mounting this component at the
  // call site — staying mounted lets lotSize and the last-good `rows` persist
  // across close/reopen, so reopening shows the last chain instantly instead
  // of a blank loading flash.
  useEffect(() => {
    if (!isOpen || !expiry) return;
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isOpen, expiry, wings, fetchChain]);

  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap';

  return (
    <FocusModal isOpen={isOpen} onClose={onClose} title="NIFTY Option Chain" variant="center">
      <div className="flex flex-col gap-3">
        {/* Controls */}
        <div className="flex items-center gap-4 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-400 font-semibold">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={expiries.length === 0}
              className={cn('bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-violet-500 disabled:opacity-50', FOCUS_RING)}
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
            <span className="text-xs text-zinc-400 font-semibold">Strikes:</span>
            {WING_OPTIONS.map(w => (
              <button
                key={w}
                onClick={() => setWings(w)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer',
                  wings === w ? 'bg-violet-600 text-oncolor' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200',
                  FOCUS_RING,
                )}
              >
                ±{w}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
            <span className="text-xs text-zinc-400 font-semibold">Lots:</span>
            <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
              <button
                disabled={lots <= 1}
                onClick={() => setLots(prev => Math.max(1, prev - 1))}
                className={cn('px-2 py-0.5 text-xs font-bold text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none rounded hover:bg-zinc-800 cursor-pointer', FOCUS_RING)}
              >
                -
              </button>
              <span className="w-8 text-center text-xs font-mono font-bold text-zinc-200">{lots}</span>
              <button
                onClick={() => setLots(prev => prev + 1)}
                className={cn('px-2 py-0.5 text-xs font-bold text-zinc-400 hover:text-white rounded hover:bg-zinc-800 cursor-pointer', FOCUS_RING)}
              >
                +
              </button>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">({lotSize ? `${lots * lotSize} Qty` : 'lot size…'})</span>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <span className="text-[10px] text-zinc-500 font-mono">
              {spot > 0 ? `Spot ₹${spot.toLocaleString('en-IN')} · ATM ${fmtStrike(atm)}` : ''}
            </span>
            {loading ? (
              <span className="text-[10px] text-zinc-500 animate-pulse">Refreshing…</span>
            ) : (
              <span className="text-[10px] text-zinc-600">{lastUpdated ? `Updated ${lastUpdated}` : ''}</span>
            )}
          </div>
        </div>

        {orderMessage && (
          <div className={cn(
            'text-xs font-semibold rounded-xl px-4 py-3 border flex items-center gap-2',
            orderMessage.isError ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
          )}>
            <span className={cn('inline-block w-2 h-2 rounded-full', orderMessage.isError ? 'bg-rose-500 animate-pulse' : 'bg-emerald-500')} />
            <span className="flex-1">{orderMessage.text}</span>
            <button onClick={() => setOrderMessage(null)} className={cn('text-[10px] text-zinc-400 hover:text-white font-bold ml-auto px-1.5 py-0.5 hover:bg-zinc-800/40 rounded cursor-pointer', FOCUS_RING)}>
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-2">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-zinc-800 max-h-[65vh] overflow-y-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE OI</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE OI ▌</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE OI%</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE Vol</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE Price%</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE Price</th>
                <th className={cn(thCls, 'text-center text-amber-300 border-x border-zinc-700')}>STRIKE</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE Price</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE Price%</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE Vol</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE OI%</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE OI ▌</th>
                <th className={cn(thCls, 'text-left text-red-300 border-r border-zinc-700')}>PE OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const isITM_CE = row.strike < spot && spot > 0;
                const isITM_PE = row.strike > spot && spot > 0;
                const ceDim = isITM_CE ? 'text-zinc-400' : 'text-white';
                const peDim = isITM_PE ? 'text-zinc-400' : 'text-white';
                const ceBg = row.ce?.oi ? `rgba(59,130,246,${Math.min(row.ceOIPct * 0.006, 0.55)})` : 'transparent';
                const peBg = row.pe?.oi ? `rgba(239,68,68,${Math.min(row.peOIPct * 0.006, 0.55)})` : 'transparent';
                const rowBg = row.isATM ? 'bg-amber-500/10' : 'bg-zinc-950 hover:bg-zinc-900/60';
                const rowBorderL = row.isATM
                  ? 'border-l-2 border-l-amber-400'
                  : row.isMaxCEOI ? 'border-l-4 border-l-blue-400' : '';
                const rowBorderR = row.isMaxPEOI ? 'border-r-4 border-r-red-400' : '';

                return (
                  <tr key={row.strike} className={cn('transition-colors border-b border-zinc-800/60 last:border-b-0', rowBg, rowBorderL, rowBorderR)}>
                    <td className="px-3 py-2 text-right" style={{ backgroundColor: ceBg }}>
                      <div className="flex items-center justify-end gap-1.5">
                        {row.isMaxCEOI && <span className="text-[10px] font-bold text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">MAX</span>}
                        <span className={cn('tabular-nums font-bold', ceDim)}>{fmtOI(row.ce?.oi ?? 0)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 w-24"><OIBar pct={row.ceOIPct} side="ce" /></td>
                    <td className={cn('px-3 py-2 text-right tabular-nums font-bold', pctColor(row.ceOIChgPct))}>{fmtPct(row.ceOIChgPct)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums font-bold', isITM_CE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtOI(row.ce?.volume ?? 0)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums font-bold', pctColor(row.cePriceChgPct))}>{fmtPct(row.cePriceChgPct)}</td>
                    <td className={cn('px-3 py-2 text-right tabular-nums font-bold', isITM_CE ? 'text-zinc-400' : 'text-white')}>
                      <div className="flex items-center justify-end gap-2">
                        <span>{fmtLTP(row.ce?.last_price)}</span>
                        {row.ce?.security_id && (
                          <div className="flex gap-1">
                            <button
                              disabled={ordering}
                              onClick={() => handlePlaceOrder(row.ce!.security_id!, 'SELL')}
                              className={cn('bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-oncolor disabled:opacity-50 disabled:pointer-events-none border border-rose-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px] cursor-pointer', FOCUS_RING)}
                              title="Market Sell Option"
                            >
                              S
                            </button>
                            <button
                              disabled={ordering}
                              onClick={() => handlePlaceOrder(row.ce!.security_id!, 'BUY')}
                              className={cn('bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-oncolor disabled:opacity-50 disabled:pointer-events-none border border-emerald-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px] cursor-pointer', FOCUS_RING)}
                              title="Market Buy Option"
                            >
                              B
                            </button>
                          </div>
                        )}
                      </div>
                    </td>

                    <td className={cn('px-4 py-2 text-center font-bold tabular-nums border-x border-zinc-700', row.isATM ? 'text-amber-300 text-sm' : 'text-zinc-100')}>
                      {fmtStrike(row.strike)}
                      {row.isATM && <span className="ml-1 text-[10px] text-amber-500">ATM</span>}
                    </td>

                    <td className={cn('px-3 py-2 text-left tabular-nums font-bold', isITM_PE ? 'text-zinc-400' : 'text-white')}>
                      <div className="flex items-center justify-start gap-2">
                        {row.pe?.security_id && (
                          <div className="flex gap-1">
                            <button
                              disabled={ordering}
                              onClick={() => handlePlaceOrder(row.pe!.security_id!, 'BUY')}
                              className={cn('bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500 hover:text-oncolor disabled:opacity-50 disabled:pointer-events-none border border-emerald-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px] cursor-pointer', FOCUS_RING)}
                              title="Market Buy Option"
                            >
                              B
                            </button>
                            <button
                              disabled={ordering}
                              onClick={() => handlePlaceOrder(row.pe!.security_id!, 'SELL')}
                              className={cn('bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-oncolor disabled:opacity-50 disabled:pointer-events-none border border-rose-500/30 rounded px-1.5 py-0.5 font-bold transition-all text-[10px] cursor-pointer', FOCUS_RING)}
                              title="Market Sell Option"
                            >
                              S
                            </button>
                          </div>
                        )}
                        <span>{fmtLTP(row.pe?.last_price)}</span>
                      </div>
                    </td>
                    <td className={cn('px-3 py-2 text-left tabular-nums font-bold', pctColor(row.pePriceChgPct))}>{fmtPct(row.pePriceChgPct)}</td>
                    <td className={cn('px-3 py-2 text-left tabular-nums font-bold', isITM_PE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtOI(row.pe?.volume ?? 0)}</td>
                    <td className={cn('px-3 py-2 text-left tabular-nums font-bold', pctColor(row.peOIChgPct))}>{fmtPct(row.peOIChgPct)}</td>
                    <td className="px-3 py-2 w-24"><OIBar pct={row.peOIPct} side="pe" /></td>
                    <td className="px-3 py-2 text-left border-r border-zinc-700" style={{ backgroundColor: peBg }}>
                      <div className="flex items-center gap-1.5">
                        <span className={cn('tabular-nums font-bold', peDim)}>{fmtOI(row.pe?.oi ?? 0)}</span>
                        {row.isMaxPEOI && <span className="text-[10px] font-bold text-red-400 bg-red-500/20 px-1.5 py-0.5 rounded">MAX</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={13} className="text-center text-zinc-500 py-12">
                    {expiry ? 'No chain data available' : 'Select an expiry to load chain'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </FocusModal>
  );
}
