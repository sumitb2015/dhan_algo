'use client';

/**
 * PositionVisualizerModal: Center modal dialog rendering the interactive
 * Strike Horizon & Live Positions Bar Chart for a specific strategy row.
 */

import React from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { FocusModal } from '../FocusTool';
import PositionVisualizer from './PositionVisualizer';
import type { MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '../Scalper';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  basketId?: string;
  underlying: string;
  legs: MultiLegLeg[];
  basketExpiry: string;
  spot: number;
  step: number;
  lotSize: number;
  qtyMultiplier: number;
  ltpFor: (leg: MultiLegLeg) => number;
  ivForStrike?: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
}

export default function PositionVisualizerModal({
  isOpen,
  onClose,
  title,
  basketId,
  underlying,
  legs,
  basketExpiry,
  spot,
  step,
  lotSize,
  qtyMultiplier,
  ltpFor,
  ivForStrike,
}: Props) {
  if (!isOpen) return null;

  return (
    <FocusModal isOpen={isOpen} onClose={onClose} title={`${title} — Position map`} variant="center">
      <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-auto p-1">
        {/* Sub-header with Full Page link */}
        <div className="flex items-center justify-between pb-1 text-xs border-b border-zinc-800/80">
          <p className="text-zinc-500">
            Open exposure by strike, against live spot
          </p>
          {basketId && (
            <Link
              href={`/multi-leg-focus/visualization?basketId=${encodeURIComponent(basketId)}&underlying=${encodeURIComponent(underlying)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold text-indigo-300 hover:text-white bg-indigo-950/40 border border-indigo-700/50 hover:bg-indigo-900/60 transition-colors ${FOCUS_RING}`}
              title="Open visualization in a dedicated full page"
            >
              <span>Open full page</span>
              <ExternalLink className="w-3 h-3 text-indigo-400" />
            </Link>
          )}
        </div>

        {legs.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-500">
            This strategy has no legs yet. Add legs to see them on the map.
          </div>
        ) : (
          <PositionVisualizer
            strategyLabel={title}
            underlying={underlying}
            basketExpiry={basketExpiry}
            legs={legs}
            spot={spot}
            step={step}
            lotSize={lotSize}
            qtyMultiplier={qtyMultiplier}
            ltpFor={ltpFor}
            ivForStrike={ivForStrike}
          />
        )}
      </div>
    </FocusModal>
  );
}
