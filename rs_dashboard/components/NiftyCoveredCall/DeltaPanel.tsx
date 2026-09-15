'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { NetGreeks } from '@/lib/positionGreeks';
import type { ShortCallSuggestion } from '@/lib/coveredCallEngine';

// ── Local type scale (mirrors components/FocusTool.tsx's TXT_* constants) ──
const TXT_LABEL = 'text-[9px]'; // field labels, badges, uppercase tags
const TXT_VALUE = 'text-[10px]'; // secondary readouts
const TXT_CAPTION = 'text-[11px]'; // primary compact copy

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
  const currentNetDelta = suggestion?.netDelta ?? null;

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
        <div className={cn(TXT_VALUE, 'text-amber-300')}>
          {greeks.missing.length} leg(s) excluded from the sum above — chain returned no greeks for them.
        </div>
      )}

      <div className="border-t border-zinc-800/60 pt-2 space-y-2">
        <DeltaGauge
          targetNetDelta={targetNetDelta}
          bandWidth={bandWidth}
          currentNetDelta={currentNetDelta}
        />
        {suggestion ? (
          <div className={cn(TXT_CAPTION, 'text-zinc-200')}>
            Suggested short call: <span className="font-bold text-emerald-400">{suggestion.strike} CE</span>
            {' '}× {suggestion.callLots} lot(s) (Δ {suggestion.strikeDelta.toFixed(2)}, net Δ {suggestion.netDelta.toFixed(2)})
          </div>
        ) : (
          <div className={cn(TXT_CAPTION, 'text-zinc-500')}>No suggestion — waiting for a live chain / futures LTP.</div>
        )}
      </div>

      {rollNeeded && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold mb-1">
            ROLL SUGGESTED
          </Badge>
          <div className={cn(TXT_CAPTION, 'text-amber-300')}>
            {rollReason || 'Net delta has drifted outside the configured band.'}
          </div>
          <div className={cn(TXT_VALUE, 'text-zinc-400 mt-1')}>
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
      <div className={cn(TXT_LABEL, 'text-zinc-500 uppercase')}>{label}</div>
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

// ── Signature element: a slim delta rail scaled to [target - band, target + band],
// with the current net delta plotted as a marker. Single consumer — declared
// locally per the terminal-polish convention (no charting library for one bar).
// The exact numbers stay as text next to the bar — this is a real-money page and
// the number matters more than the visual.
function DeltaGauge({
  targetNetDelta,
  bandWidth,
  currentNetDelta,
}: {
  targetNetDelta: number;
  bandWidth: number;
  currentNetDelta: number | null;
}) {
  const hasBand = bandWidth > 0;
  // Domain spans the band plus 50% headroom on each side so an out-of-band
  // marker is still visible on the rail instead of clamped to the edge.
  const lo = targetNetDelta - bandWidth;
  const hi = targetNetDelta + bandWidth;
  const domainLo = hasBand ? lo - bandWidth * 0.5 : targetNetDelta - 1;
  const domainHi = hasBand ? hi + bandWidth * 0.5 : targetNetDelta + 1;
  const domainSpan = domainHi - domainLo || 1;

  const pct = (v: number) => Math.min(100, Math.max(0, ((v - domainLo) / domainSpan) * 100));

  const bandStartPct = hasBand ? pct(lo) : 0;
  const bandEndPct = hasBand ? pct(hi) : 100;
  const targetPct = pct(targetNetDelta);

  const inBand = hasBand && currentNetDelta != null && currentNetDelta >= lo && currentNetDelta <= hi;
  const markerColor = currentNetDelta == null
    ? 'bg-zinc-500'
    : !hasBand
      ? 'bg-zinc-400'
      : inBand
        ? 'bg-emerald-400'
        : 'bg-amber-400';

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn(TXT_LABEL, 'text-zinc-500 uppercase')}>Net Δ vs. band</span>
        <span className={cn(TXT_CAPTION, 'font-mono font-bold', currentNetDelta == null ? 'text-zinc-600' : inBand ? 'text-emerald-400' : hasBand ? 'text-amber-400' : 'text-zinc-300')}>
          {currentNetDelta != null ? currentNetDelta.toFixed(2) : '—'} target {targetNetDelta.toFixed(2)} ± {bandWidth.toFixed(2)}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-zinc-900/80 border border-zinc-800 overflow-hidden">
        {hasBand && (
          <div
            className="absolute inset-y-0 bg-zinc-700/60"
            style={{ left: `${bandStartPct}%`, width: `${Math.max(0, bandEndPct - bandStartPct)}%` }}
          />
        )}
        <div
          className="absolute inset-y-0 w-px bg-zinc-500"
          style={{ left: `${targetPct}%` }}
        />
        {currentNetDelta != null && (
          <div
            className={cn('absolute top-0 bottom-0 w-1 rounded-full', markerColor)}
            style={{ left: `calc(${pct(currentNetDelta)}% - 1px)` }}
          />
        )}
      </div>
    </div>
  );
}
