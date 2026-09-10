'use client';

/**
 * "Portfolio Greeks" scan for the scalper terminals (AdvancedScalper.tsx,
 * and reusable from Scalper.tsx). Unlike PositionsAnalysis.tsx — which is
 * scoped to one underlying by page design — a scalper session can hold open
 * legs across several underlyings/expiries at once (the ticket's own
 * underlying selector doesn't limit what the broker book actually holds), so
 * this scans the WHOLE open book for the selected broker, not just the
 * underlying currently on screen.
 *
 * Same data-sourcing rule as Positions Analysis: positions come from the
 * selected broker, greeks/IV always come from Dhan's option chain
 * (`/api/options/chain` with no `broker` param) — Kotak's own chain source
 * is an instrument cache with no greeks at all.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Sigma, X, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Broker } from '@/hooks/useBrokerSelector';
import {
  buildPositionLegs, parseTradingSymbol, legExpiries,
  type PositionLeg, type UnparseableLeg,
} from '@/lib/positionLegs';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';
import { computeNetGreeks } from '@/lib/positionGreeks';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import { StatChip } from './PayoffMetricStrip';

/** Dhan's option-chain API is rate limited (~1 call / 3.5 s per underlying). */
const CHAIN_SPACING_MS = 3_800;
/** Caps scan time and Dhan chain-API load for a book with many distinct expiries. */
const MAX_CHAIN_FETCHES = 6;

const posSign = (leg: PositionLeg) => (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;

function fmt(n: number | null, dec: number): string {
  return n === null ? '—' : n.toFixed(dec);
}

/** Best-effort underlying label for grouping/display — not used for pricing. */
function legUnderlying(leg: PositionLeg): string {
  return parseTradingSymbol(leg.display.tradingSymbol)?.underlying ?? '—';
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Broker-shaped raw positions — same array driving the terminal's positions table. */
  rawPositions: Record<string, unknown>[];
  broker: Broker;
}

export default function ScalperGreeksModal({ open, onClose, rawPositions, broker }: Props) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [legs, setLegs] = useState<PositionLeg[]>([]);
  const [unparseable, setUnparseable] = useState<UnparseableLeg[]>([]);
  const [chainErrors, setChainErrors] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(0);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);

  const runScan = useCallback(async () => {
    setScanning(true);
    setChainErrors([]);
    setProgress('Resolving open legs…');

    const positions = rawPositions as unknown as ScalperPosition[];
    const { legs: rawLegs, unparseable: unp } = buildPositionLegs(positions, {
      // Only Dhan's raw row carries drvStrikePrice/drvOptionType/drvExpiryDate;
      // Kotak/Zerodha rows are already shaped and resolve via trading-symbol parsing.
      raw: broker === 'dhan' ? rawPositions : undefined,
    });
    setUnparseable(unp);

    if (!rawLegs.length) {
      setLegs([]);
      setScanning(false);
      setScannedAt(new Date());
      return;
    }

    // Distinct (underlying, expiry) pairs actually present in the book.
    const pairs = [...new Map(
      rawLegs
        .filter((l) => l.expiry)
        .map((l) => [`${legUnderlying(l)}|${l.expiry}`, { underlying: legUnderlying(l), expiry: l.expiry as string }]),
    ).values()].filter((p) => p.underlying !== '—');

    const wanted = pairs.slice(0, MAX_CHAIN_FETCHES);
    setTruncated(Math.max(0, pairs.length - MAX_CHAIN_FETCHES));

    const chains = new Map<string, ChainOc>();
    const errors: string[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const { underlying, expiry } = wanted[i];
      setProgress(`Loading ${underlying} ${expiry} chain (${i + 1}/${wanted.length})…`);
      if (i > 0) await new Promise((r) => setTimeout(r, CHAIN_SPACING_MS));
      try {
        // No `broker` param, deliberately — greeks always come from Dhan's
        // live chain regardless of which broker holds the position.
        const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}`);
        const json = await res.json();
        if (!json?.success || !json.data?.chain?.oc) {
          errors.push(`${underlying} ${expiry}: ${json?.error ?? 'chain unavailable'}`);
          continue;
        }
        chains.set(`${underlying}|${expiry}`, json.data.chain.oc as ChainOc);
      } catch (err) {
        errors.push(`${underlying} ${expiry}: ${String((err as Error).message ?? err)}`);
      }
    }
    setChainErrors(errors);

    const priced = rawLegs.map((leg) => {
      const oc = leg.expiry ? chains.get(`${legUnderlying(leg)}|${leg.expiry}`) : undefined;
      if (!oc) return leg;
      const cl = lookupChainLegData(oc, leg.strike, leg.type);
      if (!cl) return leg;
      return {
        ...leg,
        delta: cl.greeks?.delta ?? leg.delta,
        gamma: cl.greeks?.gamma ?? leg.gamma,
        theta: cl.greeks?.theta ?? leg.theta,
        vega: cl.greeks?.vega ?? leg.vega,
        iv: typeof cl.implied_volatility === 'number' && cl.implied_volatility > 0
          ? cl.implied_volatility / 100
          : leg.iv,
        display: {
          ...leg.display,
          ltp: leg.display.ltp ?? (cl.last_price > 0 ? cl.last_price : null),
        },
      };
    });

    setLegs(priced);
    setScanning(false);
    setProgress('');
    setScannedAt(new Date());
  }, [rawPositions, broker]);

  useEffect(() => {
    if (!open) return;
    runScan();
    // Deliberately NOT re-running on every positionsData poll (every 5s) —
    // this is an on-demand scan, not a live feed, to stay clear of Dhan's
    // chain-API rate limit. Re-open (or hit Rescan) to refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const net = computeNetGreeks(legs);
  const expiries = legExpiries(legs);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Portfolio greeks"
      className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 p-4 backdrop-blur-md"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900/95 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2.5 border-b border-zinc-800/80 px-5 py-3.5 bg-zinc-950/60">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/10">
            <Sigma className="h-4 w-4 text-violet-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Portfolio Greeks</h2>
            <span className="text-[10px] font-semibold text-violet-400">
              {scannedAt ? `Scanned ${scannedAt.toLocaleTimeString('en-IN')}` : 'Whole open book, every underlying & expiry'}
            </span>
          </div>
          <button type="button" onClick={runScan} disabled={scanning}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-bold text-zinc-300 hover:border-zinc-500 hover:text-white transition-colors disabled:opacity-50">
            {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Rescan
          </button>
          <button type="button" onClick={onClose} aria-label="Close"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 overflow-y-auto px-5 py-4">
          {scanning && (
            <div className="flex items-center gap-2.5 py-8 text-sm text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-violet-400" /> {progress || 'Scanning…'}
            </div>
          )}

          {!scanning && legs.length === 0 && unparseable.length === 0 && (
            <p className="py-10 text-center text-xs text-zinc-500">
              No open {broker !== 'dhan' ? `${broker} ` : ''}positions to show greeks for.
            </p>
          )}

          {!scanning && (legs.length > 0 || unparseable.length > 0) && (
            <>
              <div className="flex flex-wrap items-center gap-y-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <StatChip
                  label="Net Delta"
                  value={net.delta.toFixed(2)}
                  color={net.delta > 0 ? 'text-emerald-400' : net.delta < 0 ? 'text-red-400' : 'text-zinc-100'}
                  title="Sum of per-contract delta × signed quantity across every leg. Positive = net long the underlying(s)."
                />
                <StatChip label="Net Gamma" value={net.gamma.toFixed(4)}
                  color={net.gamma < 0 ? 'text-rose-400' : 'text-zinc-100'}
                  title="Negative gamma means delta moves against you as spot moves — the short-option regime." />
                <StatChip label="Net Theta" value={`₹${net.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                  sub="per day, per set"
                  color={net.theta > 0 ? 'text-emerald-400' : 'text-red-400'} />
                <StatChip label="Net Vega" value={net.vega.toFixed(2)}
                  sub="per 1 vol point"
                  color={net.vega < 0 ? 'text-rose-400' : 'text-zinc-100'} />
                <StatChip label="Legs" value={String(legs.length)} />
                <StatChip label="Expiries" value={expiries.length ? expiries.join(', ') : '—'} />
              </div>

              {net.missing.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-800/80 bg-amber-950/40 px-3.5 py-2.5 text-[11px] text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    {net.missing.length} leg{net.missing.length > 1 ? 's' : ''} had no greeks in the option chain
                    ({net.missing.map((l) => `${legUnderlying(l)} ${l.strike} ${l.type}`).join(', ')}) and{' '}
                    {net.missing.length > 1 ? 'are' : 'is'} excluded from the net figures above — real exposure is larger.
                  </span>
                </div>
              )}

              {unparseable.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-800/80 bg-rose-950/40 px-3.5 py-2.5 text-[11px] text-rose-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
                  <span>
                    {unparseable.length} position{unparseable.length > 1 ? 's' : ''} could not be identified as an option leg
                    ({unparseable.map((u) => u.tradingSymbol).join(', ')}) and {unparseable.length > 1 ? 'are' : 'is'} not
                    included anywhere above — real exposure is larger still.
                  </span>
                </div>
              )}

              {chainErrors.length > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-950/60 px-3.5 py-2.5 text-[11px] text-zinc-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span>Chain fetch failed for: {chainErrors.join('; ')}</span>
                </div>
              )}

              {truncated > 0 && (
                <div className="flex items-start gap-2 rounded-xl border border-zinc-700 bg-zinc-950/60 px-3.5 py-2.5 text-[11px] text-zinc-400">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  <span>{truncated} further underlying/expiry combination(s) were skipped to stay within the chain-API rate limit.</span>
                </div>
              )}

              {legs.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-zinc-800/80 bg-zinc-950/40 shadow-inner">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-left">Leg</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Qty</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">IV</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Delta</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Pos Delta</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Gamma</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Theta</th>
                        <th className="bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center">Vega</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-850/60">
                      {legs.map((l) => {
                        const k = posSign(l);
                        return (
                          <tr key={`${l.display.tradingSymbol}|${l.display.productType}`} className="transition-colors even:bg-zinc-900/25 hover:bg-zinc-800/40">
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-left">
                              <span className={cn(
                                'mr-1.5 inline-flex items-center justify-center rounded px-1 py-0.25 text-[8.5px] font-bold leading-none',
                                l.side === 'SELL'
                                  ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300'
                                  : 'border border-sky-500/30 bg-sky-500/15 text-sky-300',
                              )}>
                                {l.side}
                              </span>
                              <span className="font-semibold text-zinc-100">
                                {legUnderlying(l)} {l.strike.toLocaleString('en-IN')} {l.type}
                              </span>
                              <span className="ml-1 text-zinc-500">{l.expiry ?? ''}</span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{l.display.netQty.toLocaleString('en-IN')}</td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{l.iv === null ? '—' : `${(l.iv * 100).toFixed(1)}%`}</td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{fmt(l.delta, 4)}</td>
                            <td className={cn('px-3 py-2 font-mono text-xs tabular-nums whitespace-nowrap text-center font-bold', l.delta === null ? 'text-zinc-500' : (l.delta * k) > 0 ? 'text-emerald-400' : 'text-red-400')}>
                              {l.delta === null ? '—' : (l.delta * k).toFixed(2)}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{fmt(l.gamma, 5)}</td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{fmt(l.theta === null ? null : l.theta * k, 1)}</td>
                            <td className="px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center">{fmt(l.vega === null ? null : l.vega * k, 2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
