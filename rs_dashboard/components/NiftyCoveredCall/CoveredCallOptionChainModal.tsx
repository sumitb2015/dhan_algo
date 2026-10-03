'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, RefreshCw, Table2, Check, Crosshair } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChainOc, ChainLegData } from '@/lib/optionsStrategy';
import { lookupChainLegData } from '@/lib/optionsStrategy';
import { estimatePopAndDelta } from '@/lib/ultimateScannerEngine';
import { daysToExpiry } from '@/lib/coveredCallEngine';

export interface CoveredCallOptionChainModalProps {
  isOpen: boolean;
  onClose: () => void;
  spot: number;
  expiries: string[];
  currentExpiry: string | null;
  onSelectExpiry: (expiry: string) => void;
  chains: Record<string, ChainOc>;
  selectedStrike: number | null;
  onSelectStrike: (strike: number, delta?: number) => void;
  lotSize: number;
  onRefresh?: () => void;
}

type WingRange = 10 | 15 | 25 | 'all';

function fmtOI(n: number | undefined | null): string {
  if (n == null || n === 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${sign}${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-IN');
}

function fmtVol(n: number | undefined | null): string {
  if (n == null || n === 0) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtLTP(n: number | undefined | null): string {
  if (n == null || n <= 0) return '—';
  return `₹${n.toFixed(2)}`;
}

export default function CoveredCallOptionChainModal({
  isOpen,
  onClose,
  spot,
  expiries,
  currentExpiry,
  onSelectExpiry,
  chains,
  selectedStrike,
  onSelectStrike,
  lotSize,
  onRefresh,
}: CoveredCallOptionChainModalProps) {
  const [wingRange, setWingRange] = useState<WingRange>(15);
  const [localChains, setLocalChains] = useState<Record<string, ChainOc>>({});
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const tableContainerRef = useRef<HTMLDivElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement>(null);

  const activeExpiry = currentExpiry || (expiries.length > 0 ? expiries[0] : null);
  const activeChain = (activeExpiry ? (chains[activeExpiry] || localChains[activeExpiry]) : null) ?? null;

  const dte = activeExpiry ? daysToExpiry(activeExpiry) : 1;
  const atmStrike = spot > 0 ? Math.round(spot / 50) * 50 : 0;

  // Fetch chain if not present in chains cache
  const fetchMissingChain = useCallback(async (exp: string) => {
    if (chains[exp] || localChains[exp] || isFetching) return;
    setIsFetching(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/options/chain?underlying=NIFTY&expiry=${exp}`);
      const json = await res.json();
      if (json.success && json.data?.chain?.oc) {
        setLocalChains((prev) => ({ ...prev, [exp]: json.data.chain.oc as ChainOc }));
      } else {
        setFetchError(json.error || 'Failed to fetch chain data');
      }
    } catch (err) {
      setFetchError(String((err as Error).message ?? err));
    } finally {
      setIsFetching(false);
    }
  }, [chains, localChains, isFetching]);

  useEffect(() => {
    if (isOpen && activeExpiry && !activeChain) {
      fetchMissingChain(activeExpiry);
    }
  }, [isOpen, activeExpiry, activeChain, fetchMissingChain]);

  // Keyboard escape listener
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Parse and process all strikes
  const processedRows = useMemo(() => {
    if (!activeChain) return [];
    const strikes = Array.from(new Set(
      Object.keys(activeChain)
        .map((k) => parseFloat(k))
        .filter((s) => !isNaN(s) && s > 0)
    )).sort((a, b) => a - b);

    if (strikes.length === 0) return [];

    let maxCEOI = 1;
    let maxPEOI = 1;

    const all = strikes.map((strike) => {
      const ce = lookupChainLegData(activeChain, strike, 'CE');
      const pe = lookupChainLegData(activeChain, strike, 'PE');

      const ceOI = ce?.oi ?? 0;
      const peOI = pe?.oi ?? 0;
      if (ceOI > maxCEOI) maxCEOI = ceOI;
      if (peOI > maxPEOI) maxPEOI = peOI;

      // Calculate or estimate CE Delta
      let ceDelta = ce?.greeks?.delta ?? 0;
      let ceDeltaEst = false;
      if (!ceDelta && spot > 0) {
        const iv = ce?.implied_volatility && ce.implied_volatility > 0 ? ce.implied_volatility : 12;
        ceDelta = estimatePopAndDelta(spot, strike, Math.max(dte, 0.25), iv, true).delta;
        ceDeltaEst = true;
      }
      ceDelta = Math.abs(ceDelta);

      // Calculate or estimate PE Delta
      let peDelta = pe?.greeks?.delta ?? 0;
      let peDeltaEst = false;
      if (!peDelta && spot > 0) {
        const iv = pe?.implied_volatility && pe.implied_volatility > 0 ? pe.implied_volatility : 12;
        peDelta = estimatePopAndDelta(spot, strike, Math.max(dte, 0.25), iv, false).delta;
        peDeltaEst = true;
      }
      peDelta = -Math.abs(peDelta);

      const isAtm = strike === atmStrike;
      const isCE_ITM = spot > 0 && strike < spot;
      const isPE_ITM = spot > 0 && strike > spot;

      return {
        strike,
        ce,
        pe,
        ceOI,
        peOI,
        ceDelta,
        ceDeltaEst,
        peDelta,
        peDeltaEst,
        isAtm,
        isCE_ITM,
        isPE_ITM,
      };
    });

    // Filter by wing range around ATM
    if (wingRange === 'all' || atmStrike === 0) {
      return all.map((r) => ({
        ...r,
        ceOIPct: (r.ceOI / maxCEOI) * 100,
        peOIPct: (r.peOI / maxPEOI) * 100,
      }));
    }

    const atmIdx = all.findIndex((r) => r.strike === atmStrike);
    const centerIdx = atmIdx >= 0 ? atmIdx : Math.floor(all.length / 2);
    const start = Math.max(0, centerIdx - wingRange);
    const end = Math.min(all.length, centerIdx + wingRange + 1);

    const filtered = all.slice(start, end);
    return filtered.map((r) => ({
      ...r,
      ceOIPct: (r.ceOI / maxCEOI) * 100,
      peOIPct: (r.peOI / maxPEOI) * 100,
    }));
  }, [activeChain, spot, dte, atmStrike, wingRange]);

  // Auto-scroll to ATM when modal opens or expiry changes
  const scrollToATM = useCallback(() => {
    if (atmRowRef.current) {
      atmRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  useEffect(() => {
    if (isOpen && processedRows.length > 0) {
      const t = setTimeout(scrollToATM, 150);
      return () => clearTimeout(t);
    }
  }, [isOpen, activeExpiry, processedRows.length, scrollToATM]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-6xl h-[88vh] flex flex-col bg-zinc-950 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* MODAL HEADER */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-900/90 backdrop-blur shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <Table2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-white uppercase tracking-wider">
                  NIFTY Option Chain
                </h2>
                <span className="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  Spot: {spot > 0 ? `₹${spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                </span>
                {atmStrike > 0 && (
                  <span className="text-xs font-mono text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20 hidden sm:inline">
                    ATM: {atmStrike}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400">
                Click any Call (CE) strike to select it for your Covered Call write · 1 lot = {lotSize} units
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Jump to ATM button */}
            <button
              type="button"
              onClick={scrollToATM}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-zinc-300 hover:text-white transition-colors"
              title="Scroll to ATM Strike"
            >
              <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
              <span className="hidden sm:inline">Jump ATM</span>
            </button>

            {/* Refresh */}
            <button
              type="button"
              onClick={() => {
                if (activeExpiry) fetchMissingChain(activeExpiry);
                if (onRefresh) onRefresh();
              }}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-cyan-400 transition-colors"
              title="Refresh Chain"
            >
              <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin text-cyan-400')} />
            </button>

            {/* Close */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* SUB-CONTROLS STRIP: EXPIRIES + STRIKE RANGE */}
        <div className="flex items-center justify-between px-5 py-2 border-b border-zinc-800/80 bg-zinc-900/40 text-xs gap-3 flex-wrap shrink-0">
          {/* Expiry Selector */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase font-bold text-zinc-500">Expiry:</span>
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 flex-wrap">
              {expiries.slice(0, 7).map((exp) => (
                <button
                  key={exp}
                  type="button"
                  onClick={() => onSelectExpiry(exp)}
                  className={cn(
                    'px-2.5 py-1 rounded text-xs font-mono font-bold transition-all',
                    activeExpiry === exp
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  {exp}
                </button>
              ))}
            </div>
            {activeExpiry && (
              <span className="text-[11px] font-mono text-zinc-400 ml-1">
                ({dte.toFixed(0)}d DTE)
              </span>
            )}
          </div>

          {/* Wing range filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase font-bold text-zinc-500">Strikes:</span>
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
              {([10, 15, 25, 'all'] as const).map((w) => (
                <button
                  key={String(w)}
                  type="button"
                  onClick={() => setWingRange(w)}
                  className={cn(
                    'px-2 py-0.5 rounded text-[11px] font-mono font-bold transition-all',
                    wingRange === w
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  {w === 'all' ? 'All' : `±${w}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {fetchError && (
          <div className="mx-4 mt-2 p-2 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
            {fetchError}
          </div>
        )}

        {/* CHAIN TABLE */}
        <div ref={tableContainerRef} className="flex-1 overflow-auto bg-zinc-950">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-20 bg-zinc-800 text-white text-xs font-bold shadow-md">
              <tr className="border-b border-zinc-700">
                {/* CALLS HEADER (CE) */}
                <th colSpan={6} className="py-1 px-3 text-center text-[11px] uppercase tracking-wider bg-emerald-950/40 text-emerald-300 border-r border-zinc-700">
                  Calls (CE) · Write Target
                </th>
                {/* STRIKE HEADER */}
                <th className="py-1 px-3 text-center text-[11px] uppercase tracking-wider bg-zinc-800 text-white border-r border-zinc-700">
                  Strike
                </th>
                {/* PUTS HEADER (PE) */}
                <th colSpan={5} className="py-1 px-3 text-center text-[11px] uppercase tracking-wider bg-rose-950/40 text-rose-300">
                  Puts (PE)
                </th>
              </tr>
              <tr className="text-[11px] border-b border-zinc-700">
                {/* CE columns */}
                <th className="py-2 px-2 text-center text-zinc-300 font-bold w-14">Action</th>
                <th className="py-2 px-2 text-right text-emerald-400 font-bold">Delta (Δ)</th>
                <th className="py-2 px-2 text-right text-zinc-300 font-bold">IV</th>
                <th className="py-2 px-2 text-right text-zinc-300 font-bold">Vol</th>
                <th className="py-2 px-2 text-right text-zinc-300 font-bold">OI (Contracts)</th>
                <th className="py-2 px-3 text-right text-emerald-400 font-bold border-r border-zinc-700">LTP</th>

                {/* Center Strike */}
                <th className="py-2 px-4 text-center text-white font-bold bg-zinc-800 border-r border-zinc-700 w-24">
                  Strike
                </th>

                {/* PE columns */}
                <th className="py-2 px-3 text-left text-rose-400 font-bold">LTP</th>
                <th className="py-2 px-2 text-left text-zinc-300 font-bold">OI (Contracts)</th>
                <th className="py-2 px-2 text-left text-zinc-300 font-bold">Vol</th>
                <th className="py-2 px-2 text-left text-zinc-300 font-bold">IV</th>
                <th className="py-2 px-2 text-left text-rose-400 font-bold">Delta (Δ)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-mono">
              {processedRows.map((row) => {
                const isSelected = selectedStrike === row.strike;
                const isAtm = row.isAtm;

                return (
                  <tr
                    key={row.strike}
                    ref={isAtm ? atmRowRef : null}
                    className={cn(
                      'transition-colors text-[11px] group',
                      isSelected
                        ? 'bg-emerald-500/15 border-y border-emerald-500/50'
                        : isAtm
                        ? 'bg-cyan-500/10 border-y-2 border-cyan-500/60'
                        : 'hover:bg-zinc-900/60'
                    )}
                  >
                    {/* CE Action: Select button */}
                    <td className={cn('py-1.5 px-2 text-center', row.isCE_ITM && !isSelected && 'bg-amber-500/[0.03]')}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectStrike(row.strike, row.ceDelta);
                          onClose();
                        }}
                        className={cn(
                          'px-2 py-0.5 rounded text-[10px] font-bold font-sans transition-all',
                          isSelected
                            ? 'bg-emerald-500 text-white shadow-sm'
                            : 'bg-zinc-800 hover:bg-emerald-600 text-zinc-300 hover:text-white border border-zinc-700 hover:border-emerald-500'
                        )}
                        title={`Select ${row.strike} CE (${row.ceDelta.toFixed(2)} Δ) for Covered Call`}
                      >
                        {isSelected ? <Check className="w-3 h-3 inline" /> : 'Select'}
                      </button>
                    </td>

                    {/* CE Delta */}
                    <td className={cn('py-1.5 px-2 text-right font-bold', row.isCE_ITM && !isSelected && 'bg-amber-500/[0.03]')}>
                      <span className={cn(
                        row.ceDelta >= 0.20 && row.ceDelta <= 0.30
                          ? 'text-emerald-400 font-extrabold'
                          : row.ceDelta < 0.20
                          ? 'text-sky-300'
                          : 'text-amber-400'
                      )}>
                        {row.ceDelta.toFixed(3)}
                        {row.ceDeltaEst && <span className="text-[9px] text-zinc-500 ml-0.5">e</span>}
                      </span>
                    </td>

                    {/* CE IV */}
                    <td className={cn('py-1.5 px-2 text-right text-zinc-400', row.isCE_ITM && !isSelected && 'bg-amber-500/[0.03]')}>
                      {row.ce?.implied_volatility ? `${row.ce.implied_volatility.toFixed(1)}%` : '—'}
                    </td>

                    {/* CE Volume */}
                    <td className={cn('py-1.5 px-2 text-right text-zinc-400', row.isCE_ITM && !isSelected && 'bg-amber-500/[0.03]')}>
                      {fmtVol(row.ce?.volume)}
                    </td>

                    {/* CE OI with progress bar */}
                    <td className={cn('py-1.5 px-2 text-right', row.isCE_ITM && !isSelected && 'bg-amber-500/[0.03]')}>
                      <div className="relative flex items-center justify-end w-full">
                        <div
                          className="absolute inset-y-0 right-0 bg-blue-500/20 rounded-sm"
                          style={{ width: `${Math.min(100, row.ceOIPct)}%` }}
                        />
                        <span className="relative z-10 text-zinc-300 text-[10px]">
                          {fmtOI(row.ceOI)}
                        </span>
                      </div>
                    </td>

                    {/* CE LTP (Clickable to select) */}
                    <td
                      onClick={() => {
                        onSelectStrike(row.strike, row.ceDelta);
                        onClose();
                      }}
                      className={cn(
                        'py-1.5 px-3 text-right font-bold text-emerald-400 border-r border-zinc-700/80 cursor-pointer group-hover:underline',
                        row.isCE_ITM && !isSelected && 'bg-amber-500/[0.04]'
                      )}
                    >
                      {fmtLTP(row.ce?.last_price)}
                    </td>

                    {/* CENTER STRIKE */}
                    <td className={cn(
                      'py-1.5 px-4 text-center font-bold border-r border-zinc-700/80',
                      isSelected
                        ? 'bg-emerald-500/25 text-emerald-300'
                        : isAtm
                        ? 'bg-cyan-500/25 text-cyan-200'
                        : 'bg-zinc-900/90 text-white'
                    )}>
                      <div className="flex items-center justify-center gap-1.5">
                        <span>{row.strike.toLocaleString('en-IN')}</span>
                        {isAtm && (
                          <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-500/30 text-cyan-300 font-sans font-bold">
                            ATM
                          </span>
                        )}
                      </div>
                    </td>

                    {/* PE LTP */}
                    <td className={cn('py-1.5 px-3 text-left font-bold text-rose-400', row.isPE_ITM && 'bg-amber-500/[0.04]')}>
                      {fmtLTP(row.pe?.last_price)}
                    </td>

                    {/* PE OI with progress bar */}
                    <td className={cn('py-1.5 px-2 text-left', row.isPE_ITM && 'bg-amber-500/[0.03]')}>
                      <div className="relative flex items-center justify-start w-full">
                        <div
                          className="absolute inset-y-0 left-0 bg-rose-500/20 rounded-sm"
                          style={{ width: `${Math.min(100, row.peOIPct)}%` }}
                        />
                        <span className="relative z-10 text-zinc-300 text-[10px]">
                          {fmtOI(row.peOI)}
                        </span>
                      </div>
                    </td>

                    {/* PE Volume */}
                    <td className={cn('py-1.5 px-2 text-left text-zinc-400', row.isPE_ITM && 'bg-amber-500/[0.03]')}>
                      {fmtVol(row.pe?.volume)}
                    </td>

                    {/* PE IV */}
                    <td className={cn('py-1.5 px-2 text-left text-zinc-400', row.isPE_ITM && 'bg-amber-500/[0.03]')}>
                      {row.pe?.implied_volatility ? `${row.pe.implied_volatility.toFixed(1)}%` : '—'}
                    </td>

                    {/* PE Delta */}
                    <td className={cn('py-1.5 px-2 text-left text-rose-400 font-bold', row.isPE_ITM && 'bg-amber-500/[0.03]')}>
                      <span>
                        {row.peDelta.toFixed(3)}
                        {row.peDeltaEst && <span className="text-[9px] text-zinc-500 ml-0.5">e</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {processedRows.length === 0 && !isFetching && (
            <div className="py-16 text-center text-zinc-500">
              No option contracts found for {activeExpiry ?? 'this expiry'}. Click Refresh to fetch from broker.
            </div>
          )}
        </div>

        {/* MODAL FOOTER LEGEND */}
        <div className="px-5 py-2.5 border-t border-zinc-800 bg-zinc-900/80 flex items-center justify-between text-[11px] text-zinc-400 shrink-0 flex-wrap gap-2">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-cyan-500/40 border border-cyan-500" />
              <span>ATM Strike</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/30 border border-emerald-500" />
              <span>Selected Call Strike</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-amber-500/10 border border-amber-500/30" />
              <span>In-the-Money (ITM)</span>
            </span>
            <span className="text-zinc-500 hidden md:inline">
              (e) = Black-Scholes estimate
            </span>
          </div>

          <div className="text-zinc-400 font-mono text-[10px]">
            {processedRows.length} strikes loaded
          </div>
        </div>
      </div>
    </div>
  );
}
