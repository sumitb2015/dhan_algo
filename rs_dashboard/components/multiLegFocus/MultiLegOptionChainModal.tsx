'use client';

/**
 * Read-only option chain + greeks reference for Multi-Leg Focus.
 *
 * Deliberately standalone from FocusOptionChainModal.tsx (same convention as
 * that modal's own header comment) — this one drops order placement (legs
 * are built via the page's own strategy-row/leg builder, not from here) and
 * adds a fifth underlying set (BANKNIFTY/SENSEX/CRUDEOIL/CRUDEOILM) plus
 * IV/Delta/Theta/Gamma/Vega columns sourced from the same raw chain payload.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { type Broker } from '@/hooks/useBrokerSelector';
import { FocusModal } from '../FocusTool';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
type Underlying = typeof UNDERLYINGS[number];

const STRIKE_STEP: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  CRUDEOIL: 50,
  CRUDEOILM: 50,
};

const POLL_MS = 60_000;
const WING_OPTIONS = [5, 10, 15] as const;
type Wings = typeof WING_OPTIONS[number];

interface ChainGreeks { delta?: number; theta?: number; gamma?: number; vega?: number }
interface RawChainSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  greeks?: ChainGreeks;
}
interface RawChainEntry { ce?: RawChainSide; pe?: RawChainSide }

interface ProcessedRow {
  strike: number;
  ce: RawChainSide | null;
  pe: RawChainSide | null;
  ceOIPct: number;
  peOIPct: number;
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
}

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

function fmtGreek(n: number | undefined, digits: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

function fmtIV(side: RawChainSide | null): string {
  const iv = side?.implied_volatility;
  if (iv === undefined || iv === null) return '—';
  return `${iv.toFixed(2)}%`;
}

interface StrikeEntry { key: string; strike: number; entry: RawChainEntry }

function parseStrikeEntries(oc: Record<string, RawChainEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

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

export default function MultiLegOptionChainModal({
  isOpen, onClose, underlying, expiriesMap, broker,
}: {
  isOpen: boolean;
  onClose: () => void;
  /** Underlying active on the page when the modal was opened — seeds the
   *  modal's own selector but doesn't force-sync afterwards (user may want
   *  to check a different underlying's chain while building a basket). */
  underlying: Underlying;
  /** Page's already-fetched expiries per underlying — avoids a redundant fetch. */
  expiriesMap: Record<string, string[]>;
  broker?: Broker;
}) {
  const [selUnderlying, setSelUnderlying] = useState<Underlying>(underlying);
  const [expiry, setExpiry]               = useState('');
  const [wings, setWings]                 = useState<Wings>(10);
  const [rows, setRows]                   = useState<ProcessedRow[]>([]);
  const [spot, setSpot]                   = useState(0);
  const [atm, setAtm]                     = useState(0);
  const [lastUpdated, setLastUpdated]     = useState<string | null>(null);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Re-seed the underlying selector from the page's active underlying each
  // time the modal is (re)opened, but not while it stays open.
  useEffect(() => {
    if (isOpen) setSelUnderlying(underlying);
  }, [isOpen, underlying]);

  const expiries = expiriesMap[selUnderlying] ?? [];

  useEffect(() => {
    if ((!expiry || (expiries.length > 0 && !expiries.includes(expiry))) && expiries.length > 0) {
      setExpiry(expiries[0]);
    }
  }, [expiries, expiry]);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const url = `/api/options/chain?underlying=${selUnderlying}&expiry=${expiry}${broker ? `&broker=${broker}` : ''}`;
      const res  = await fetch(url);
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
        setError('Spot price unavailable — showing last known chain');
        return;
      }
      const step = STRIKE_STEP[selUnderlying];
      const atmStrike = Math.round(spotPrice / step) * step;
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
  }, [selUnderlying, expiry, wings, broker]);

  useEffect(() => {
    if (!isOpen || !expiry) return;
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isOpen, expiry, wings, fetchChain]);

  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-2.5 py-2 whitespace-nowrap';

  return (
    <FocusModal isOpen={isOpen} onClose={onClose} title={`${selUnderlying} Option Chain & Greeks`} variant="center">
      <div className="flex flex-col gap-3">
        {/* Controls */}
        <div className="flex items-center gap-4 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-400 font-semibold">Underlying</span>
            <select
              value={selUnderlying}
              onChange={e => { setSelUnderlying(e.target.value as Underlying); setExpiry(''); }}
              className={cn('bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-violet-500', FOCUS_RING)}
            >
              {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-1.5 border-l border-zinc-800 pl-4">
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
                <th className={cn(thCls, 'text-right text-blue-300')}>CE IV</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>Delta</th>
                <th className={cn(thCls, 'text-right text-blue-300')}>CE Price</th>
                <th className={cn(thCls, 'text-center text-amber-300 border-x border-zinc-700')}>STRIKE</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE Price</th>
                <th className={cn(thCls, 'text-left text-red-300')}>Delta</th>
                <th className={cn(thCls, 'text-left text-red-300')}>PE IV</th>
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
                    <td className="px-2.5 py-2 text-right" style={{ backgroundColor: ceBg }}>
                      <div className="flex items-center justify-end gap-1.5">
                        {row.isMaxCEOI && <span className="text-[10px] font-bold text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">MAX</span>}
                        <span className={cn('tabular-nums font-bold', ceDim)}>{fmtOI(row.ce?.oi ?? 0)}</span>
                      </div>
                    </td>
                    <td className="px-2.5 py-2 w-20"><OIBar pct={row.ceOIPct} side="ce" /></td>
                    <td className={cn('px-2.5 py-2 text-right tabular-nums font-semibold', isITM_CE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtIV(row.ce)}</td>
                    <td className={cn('px-2.5 py-2 text-right tabular-nums font-semibold', isITM_CE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtGreek(row.ce?.greeks?.delta, 3)}</td>
                    <td className={cn('px-2.5 py-2 text-right tabular-nums font-bold', isITM_CE ? 'text-zinc-400' : 'text-white')}>{fmtLTP(row.ce?.last_price)}</td>

                    <td className={cn('px-3 py-2 text-center font-bold tabular-nums border-x border-zinc-700', row.isATM ? 'text-amber-300 text-sm' : 'text-zinc-100')}>
                      {fmtStrike(row.strike)}
                      {row.isATM && <span className="ml-1 text-[10px] text-amber-500">ATM</span>}
                    </td>

                    <td className={cn('px-2.5 py-2 text-left tabular-nums font-bold', isITM_PE ? 'text-zinc-400' : 'text-white')}>{fmtLTP(row.pe?.last_price)}</td>
                    <td className={cn('px-2.5 py-2 text-left tabular-nums font-semibold', isITM_PE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtGreek(row.pe?.greeks?.delta, 3)}</td>
                    <td className={cn('px-2.5 py-2 text-left tabular-nums font-semibold', isITM_PE ? 'text-zinc-500' : 'text-zinc-300')}>{fmtIV(row.pe)}</td>
                    <td className="px-2.5 py-2 w-20"><OIBar pct={row.peOIPct} side="pe" /></td>
                    <td className="px-2.5 py-2 text-left border-r border-zinc-700" style={{ backgroundColor: peBg }}>
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
                  <td colSpan={11} className="text-center text-zinc-500 py-12">
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
