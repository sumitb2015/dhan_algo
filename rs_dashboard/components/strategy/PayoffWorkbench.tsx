'use client';

/**
 * The payoff workbench shared by Baskets and the Options Monitor: the one PayoffDiagram, plus the target-price and target-date controls,
 * the futures card, the standard-deviation table and the strike-clearance card that sit under it. Display only: the page supplies the
 * curves (from generatePayoffCurve, which prices through lib/optionsPayoff.ts) and owns the target state.
 */

import React, { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import TerminalPanel from '@/components/options-monitor/TerminalPanel';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import { OptionLegModel, PayoffPoint, SdLevels, formatShortExpiry } from '@/lib/optionsMonitorMath';
import { expiryEpochMs } from '@/lib/optionsPricing';
import { unlimitedFlags } from '@/lib/optionsPayoff';

export interface PayoffWorkbenchProps {
  legs: OptionLegModel[];
  spot: number;
  strikeStep: number;
  underlying?: string;
  currentExpiry?: string;
  futurePrice?: number | null;
  futureBasis?: number | null;
  payoffPoints: PayoffPoint[];
  breakevens: number[];
  sdLevels?: SdLevels | null;
  /** Target price the user is probing (null = current spot). */
  targetSpot: number | null;
  onTargetSpotChange: (v: number | null) => void;
  /** Days to expiry at the target date (null = today). */
  targetDays: number | null;
  onTargetDaysChange: (v: number | null) => void;
  /** Real remaining days to expiry: the target-date slider's upper bound. */
  maxDays: number;
  emptyReason?: string;
}

function formatTargetDateDisplay(daysRemaining: number, expiryDateStr?: string): string {
  if (!expiryDateStr) return `${daysRemaining.toFixed(1)}d`;
  try {
    // One expiry clock for every surface: the library's F&O close (15:40 IST), not a second hand-copied constant.
    const expTime = expiryEpochMs(expiryDateStr);
    const targetMs = expTime - (daysRemaining * 24 * 3600 * 1000);
    const dt = new Date(targetMs);
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dow = daysOfWeek[dt.getDay()];
    const day = dt.getDate();
    const mon = months[dt.getMonth()];
    return `${dow}, ${day} ${mon}`;
  } catch {
    return `${daysRemaining.toFixed(1)}d`;
  }
}

export default function PayoffWorkbench({
  legs, spot, strikeStep, underlying = 'NIFTY', currentExpiry = '', futurePrice = null, futureBasis = null,
  payoffPoints, breakevens, sdLevels = null, targetSpot, onTargetSpotChange, targetDays, onTargetDaysChange, maxDays, emptyReason,
}: PayoffWorkbenchProps) {
  const setTargetSpot = onTargetSpotChange;
  const setTargetDays = onTargetDaysChange;
  const effectiveTargetSpot = targetSpot ?? spot;
  // Default (untouched slider) is "today", i.e. the full remaining time to the real expiry.
  const effectiveTargetDays = Math.min(targetDays ?? maxDays, maxDays);
  const targetSpotChangePct = spot > 0 ? ((effectiveTargetSpot - spot) / spot) * 100 : 0;

  // Nearest short strikes, for the clearance card.
  const shortCeLeg = useMemo(() => legs.filter((l) => l.type === 'CE' && l.side === 'SELL').sort((a, b) => a.strike - b.strike)[0], [legs]);
  const shortPeLeg = useMemo(() => legs.filter((l) => l.type === 'PE' && l.side === 'SELL').sort((a, b) => b.strike - a.strike)[0], [legs]);
  const ceClearancePts = shortCeLeg && spot > 0 ? Math.round(shortCeLeg.strike - spot) : null;
  const peClearancePts = shortPeLeg && spot > 0 ? Math.round(spot - shortPeLeg.strike) : null;

  const diagram = useMemo(() => {
    if (payoffPoints.length < 2) return null;
    const expiry = payoffPoints.map((p) => ({ spot: p.spot, pnl: p.pnlExpiry }));
    const today = payoffPoints.map((p) => ({ spot: p.spot, pnl: p.pnlToday }));
    const flags = unlimitedFlags(legs.map((l) => ({ type: l.type, qty: (l.side === 'SELL' ? -1 : 1) * (l.qty || 1) })));
    return {
      expiry, today,
      maxProfit: Math.max(...expiry.map((p) => p.pnl)),
      maxLoss: Math.min(...expiry.map((p) => p.pnl)),
      ...flags,
    };
  }, [payoffPoints, legs]);

  if (!diagram) {
    return (
      <TerminalPanel title="PAYOFF & STRIKE CLEARANCE GRAPH" icon={TrendingUp}>
        <div className="flex flex-col items-center justify-center h-80 gap-1.5 text-zinc-500 font-mono">
          <p className="text-sm font-semibold text-zinc-400">No payoff to show yet</p>
          <p className="text-xs">{emptyReason ?? 'Pick a strategy or add legs with valid prices'}</p>
        </div>
      </TerminalPanel>
    );
  }

  return (
    <TerminalPanel title="PAYOFF & STRIKE CLEARANCE GRAPH" icon={TrendingUp}>
      <div className="p-3.5 flex flex-col gap-3">
        <PayoffDiagram
          title=""
          curve={diagram.expiry}
          todayCurve={diagram.today}
          breakevens={breakevens}
          currentSpot={spot}
          targetSpot={effectiveTargetSpot}
          maxProfit={diagram.maxProfit}
          maxProfitUnlimited={diagram.maxProfitUnlimited}
          maxLoss={diagram.maxLoss}
          maxLossUnlimited={diagram.maxLossUnlimited}
          expectedMove={sdLevels ? { sd1Lo: sdLevels.exactLo1, sd1Hi: sdLevels.exactHi1, sd2Lo: sdLevels.exactLo2, sd2Hi: sdLevels.exactHi2 } : null}
          legendLabels={{ expiry: 'On expiry', today: 'On target date (T+0)' }}
          height={340}
        />

          {/* ── INTERACTIVE TARGET SPOT & TARGET DATE CONTROLS (Sensibull Parity) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
            {/* Left: Target Spot Slider */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-200">{underlying} Target</span>
                  <span className={`text-[11px] font-bold tabular-nums ${targetSpotChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {targetSpotChangePct >= 0 ? '+' : ''}{targetSpotChangePct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center border border-zinc-700 bg-zinc-900 rounded px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setTargetSpot(Math.round((effectiveTargetSpot - strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Decrease target spot"
                    >
                      -
                    </button>
                    <span className="px-2 font-mono font-bold text-zinc-100 tabular-nums text-xs">
                      {effectiveTargetSpot.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTargetSpot(Math.round((effectiveTargetSpot + strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Increase target spot"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetSpot(spot)}
                    className="text-[11px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer ml-1"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Slider for Target Spot */}
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={Math.round(spot * 0.94)}
                  max={Math.round(spot * 1.06)}
                  step={strikeStep / 10}
                  value={effectiveTargetSpot}
                  onChange={(e) => setTargetSpot(parseFloat(e.target.value))}
                  className="w-full accent-sky-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500 tabular-nums">
                <span>-6% ({(spot * 0.94).toFixed(0)})</span>
                <span className="text-zinc-400 font-medium">Current: {spot.toFixed(1)}</span>
                <span>+6% ({(spot * 1.06).toFixed(0)})</span>
              </div>
            </div>

            {/* Right: Target Date Slider */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-200">Date:</span>
                  <span className="text-amber-400 font-bold tabular-nums text-xs">
                    {effectiveTargetDays.toFixed(1)}D to expiry
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center border border-zinc-700 bg-zinc-900 rounded px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setTargetDays(Math.min(maxDays, effectiveTargetDays + 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Earlier date (more days to expiry)"
                    >
                      &lt;
                    </button>
                    <span className="px-2 font-mono font-medium text-zinc-200 tabular-nums text-xs">
                      {formatTargetDateDisplay(effectiveTargetDays, currentExpiry)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTargetDays(Math.max(0.05, effectiveTargetDays - 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Later date (fewer days to expiry)"
                    >
                      &gt;
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetDays(null)}
                    className="text-[11px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer ml-1"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Slider for Target Date */}
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.05}
                  max={maxDays}
                  step={0.1}
                  value={effectiveTargetDays}
                  onChange={(e) => setTargetDays(parseFloat(e.target.value))}
                  className="w-full accent-amber-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500 tabular-nums">
                <span>At Expiry (0D)</span>
                <span className="text-zinc-400 font-medium">Target: {effectiveTargetDays.toFixed(1)}d</span>
                <span>Inception ({maxDays.toFixed(1)}D)</span>
              </div>
            </div>
          </div>

          {/* ── SENSIBULL PARITY METRICS: TARGET DAY FUTURES & STANDARD DEVIATION ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
            {/* Target Day Futures Card */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Target Day Futures Prices
                </span>
                <span className="text-[10px] text-zinc-500">Black-76 Base</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-zinc-300 font-semibold">
                  {formatShortExpiry(currentExpiry)} FUT
                </span>
                <span className="font-bold text-white tabular-nums text-sm">
                  ₹{futurePrice != null && futurePrice > 0
                    ? futurePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : (spot + (futureBasis || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              {futureBasis != null && (
                <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 pt-1 border-t border-zinc-900">
                  <span>Futures Basis:</span>
                  <span className={`font-bold tabular-nums ${futureBasis >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {futureBasis >= 0 ? '+' : ''}{futureBasis.toFixed(2)} pts
                  </span>
                </div>
              )}
            </div>

            {/* Standard Deviation Table (Sensibull Parity: 1SD and 2SD bands) */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Standard Deviation
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  {sdLevels ? `${(sdLevels.vol * 100).toFixed(1)}% IV · ${sdLevels.days.toFixed(1)}d` : ''}
                </span>
              </div>
              {sdLevels ? (
                <div className="mt-1 font-mono text-[11px]">
                  <div className="grid grid-cols-3 text-zinc-500 pb-1 border-b border-zinc-900 text-[10px] font-semibold">
                    <span>SD</span>
                    <span className="text-center">Points</span>
                    <span className="text-right">Price</span>
                  </div>
                  <div className="grid grid-cols-3 py-1 items-start border-b border-zinc-900/50">
                    <span className="text-zinc-400 font-medium">1 SD</span>
                    <span className="text-center text-zinc-400 tabular-nums">
                      {sdLevels.points1.toFixed(1)} ({((sdLevels.points1 / spot) * 100).toFixed(1)}%)
                    </span>
                    <div className="text-right flex flex-col font-bold text-zinc-200 tabular-nums">
                      <span>{sdLevels.exactLo1.toFixed(1)}</span>
                      <span>{sdLevels.exactHi1.toFixed(1)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 py-1 items-start">
                    <span className="text-zinc-400 font-medium">2 SD</span>
                    <span className="text-center text-zinc-400 tabular-nums">
                      {sdLevels.points2.toFixed(1)} ({((sdLevels.points2 / spot) * 100).toFixed(1)}%)
                    </span>
                    <div className="text-right flex flex-col font-bold text-zinc-200 tabular-nums">
                      <span>{sdLevels.exactLo2.toFixed(1)}</span>
                      <span>{sdLevels.exactHi2.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <span className="text-zinc-500 text-[11px]">Calculating SD levels...</span>
              )}
            </div>

            {/* Breakeven & Clearance Summary */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Clearance & Range
                </span>
                <span className="text-[10px] text-zinc-500">Intraday Safety</span>
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px]">
                <span className="text-zinc-400">PE {shortPeLeg ? shortPeLeg.strike : '—'}:</span>
                <span className={`font-bold tabular-nums ${peClearancePts != null && peClearancePts > 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {peClearancePts != null ? `-${peClearancePts} pts` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-400">CE {shortCeLeg ? shortCeLeg.strike : '—'}:</span>
                <span className={`font-bold tabular-nums ${ceClearancePts != null && ceClearancePts > 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {ceClearancePts != null ? `+${ceClearancePts} pts` : '—'}
                </span>
              </div>
              {breakevens.length >= 2 && (
                <div className="flex items-center justify-between text-[11px] pt-1 mt-1 border-t border-zinc-900">
                  <span className="text-zinc-400">BE Width:</span>
                  <span className="font-bold text-amber-400 tabular-nums">
                    {breakevens[1] - breakevens[0]} pts
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── EXPECTED MOVE (SD) READOUT ── */}
          {sdLevels && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-zinc-400 font-semibold">Expected Move:</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">1SD</span>
                  <span className="text-zinc-200 font-bold tabular-nums">
                    {sdLevels.lo1.toLocaleString('en-IN')} &mdash; {sdLevels.hi1.toLocaleString('en-IN')}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-bold tabular-nums">
                    (&plusmn;{sdLevels.points1.toLocaleString('en-IN')} pts / {((sdLevels.points1 / spot) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">2SD</span>
                  <span className="text-zinc-200 font-bold tabular-nums">
                    {sdLevels.lo2.toLocaleString('en-IN')} &mdash; {sdLevels.hi2.toLocaleString('en-IN')}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-bold tabular-nums">
                    (&plusmn;{sdLevels.points2.toLocaleString('en-IN')} pts / {((sdLevels.points2 / spot) * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-zinc-500 text-[11px]">
                <span>from</span>
                <span className="text-zinc-300 font-bold tabular-nums">
                  {(sdLevels.vol * 100).toFixed(1)}% IV
                </span>
                <span>over</span>
                <span className="text-zinc-300 font-bold tabular-nums">
                  {sdLevels.days.toFixed(2)}d
                </span>
                <span>t</span>
              </div>
            </div>
          )}
      </div>
    </TerminalPanel>
  );
}
