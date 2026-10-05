'use client';

/**
 * Combined payoff diagram for an open positions book (Positions Analysis, Live Builder, Intraday Edge).
 *
 * No chart code of its own: it maps its props onto the shared PayoffDiagram, so this page draws exactly what every other page draws
 * (same design, same overlays). The page still supplies the curves; this wrapper adds the OI histogram, the draft-legs overlay, the
 * target-price marker and the page-owned zoom as PayoffDiagram props.
 */

import React from 'react';
import PayoffDiagram, { pnlAt } from '@/components/strategy/PayoffDiagram';

export { pnlAt };
export interface CurvePoint { spot: number; pnl: number }
export interface OiBar { strike: number; callOi: number; putOi: number }

interface Props {
  expiryCurve: CurvePoint[];
  /** Pre-expiry curve at the target date. Omit when no leg has usable IV. */
  targetCurve?: CurvePoint[] | null;
  /** Real book + draft legs combined, at expiry: a "what if I added this" overlay. */
  draftCurve?: CurvePoint[] | null;
  breakevens: number[];
  spot: number;
  /** Where the "projected" readout is taken: the target-price slider value. */
  targetSpot: number;
  expiryLabel: string;
  targetLabel: string;
  oiBars?: OiBar[];
  showOi: boolean;
  onToggleOi: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** Plot height in px. */
  height?: number;
  /** Rendered as a warning strip: legs priced intrinsically for want of IV. */
  ivWarning?: string | null;
  emptyReason?: string;
}

export default function PositionsPayoffChart({
  expiryCurve, targetCurve, draftCurve, breakevens, spot, targetSpot, expiryLabel, targetLabel, oiBars, showOi, onToggleOi,
  onZoomIn, onZoomOut, canZoomIn, canZoomOut, height, ivWarning, emptyReason,
}: Props) {
  const hasDraft = !!draftCurve && draftCurve.length >= 2;
  if (expiryCurve.length < 2 && !hasDraft) {
    return (
      <div className="flex h-80 flex-col items-center justify-center gap-1.5 text-zinc-500">
        <p className="text-sm font-semibold text-zinc-400">No payoff to show</p>
        <p className="text-xs text-zinc-500">{emptyReason ?? 'No open option positions for this underlying'}</p>
      </div>
    );
  }
  return (
    <PayoffDiagram
      title=""
      curve={expiryCurve}
      todayCurve={targetCurve && targetCurve.length >= 2 ? targetCurve : undefined}
      draftCurve={draftCurve}
      breakevens={breakevens}
      currentSpot={spot}
      targetSpot={targetSpot}
      legendLabels={{ expiry: expiryLabel, today: targetLabel }}
      oiBars={oiBars}
      showOi={showOi}
      onToggleOi={onToggleOi}
      externalZoom={{ onZoomIn, onZoomOut, canZoomIn, canZoomOut }}
      warning={ivWarning}
      height={height ?? 300}
    />
  );
}
