'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { NetGreeks } from '@/lib/positionGreeks';
import type { ShortCallSuggestion } from '@/lib/coveredCallEngine';

export default function DeltaPanel({
  greeks,
  suggestion,
  rollNeeded,
  rollReason,
  targetNetDelta,
  bandWidth,
}: {
  greeks: NetGreeks | null;
  suggestion: ShortCallSuggestion | null;
  rollNeeded: boolean;
  rollReason?: string;
  targetNetDelta: number;
  bandWidth: number;
}) {
  return (
    <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-3">
      <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide">Delta Panel</div>

      <div className="grid grid-cols-4 gap-2">
        <GreekTile label="Delta" value={greeks?.delta} />
        <GreekTile label="Gamma" value={greeks?.gamma} />
        <GreekTile label="Theta" value={greeks?.theta} />
        <GreekTile label="Vega" value={greeks?.vega} />
      </div>

      {greeks && greeks.missing.length > 0 && (
        <div className="text-[10px] text-amber-300">
          {greeks.missing.length} leg(s) excluded from the sum above — chain returned no greeks for them.
        </div>
      )}

      <div className="border-t border-zinc-800/60 pt-2">
        <div className="text-[10px] text-zinc-500 mb-1">
          Hedge target: {targetNetDelta.toFixed(2)} ± {bandWidth.toFixed(2)}
        </div>
        {suggestion ? (
          <div className="text-xs text-zinc-200">
            Suggested short call: <span className="font-bold text-emerald-400">{suggestion.strike} CE</span>
            {' '}× {suggestion.callLots} lot(s) (Δ {suggestion.strikeDelta.toFixed(2)}, net Δ {suggestion.netDelta.toFixed(2)})
          </div>
        ) : (
          <div className="text-xs text-zinc-500">No suggestion — waiting for a live chain / futures LTP.</div>
        )}
      </div>

      {rollNeeded && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <span className="font-bold">ROLL SUGGESTED — </span>
          {rollReason || 'Net delta has drifted outside the configured band.'}
          <div className="text-[10px] text-zinc-400 mt-1">
            Informational only — place the roll manually via the order pad.
          </div>
        </div>
      )}
    </div>
  );
}

function GreekTile({ label, value }: { label: string; value?: number }) {
  const v = typeof value === 'number' ? value : null;
  return (
    <div className="bg-zinc-900/60 rounded-lg px-2 py-1.5 text-center">
      <div className="text-[9px] text-zinc-500 uppercase">{label}</div>
      <div
        className={cn(
          'text-sm font-bold tabular-nums',
          v === null ? 'text-zinc-600' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-zinc-200',
        )}
      >
        {v === null ? '—' : v.toFixed(3)}
      </div>
    </div>
  );
}
