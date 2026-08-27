'use client';

/**
 * Renders adjustment suggestions a Claude session wrote to
 * debug/options_suggestions_<UNDERLYING>.json after being asked to review this
 * book's risk/payoff (see rs_dashboard/scripts/analyze-positions.ts and
 * app/api/options/suggestions/route.ts for the read/propose half of this
 * flow). This component only ever DISPLAYS a proposal and, on confirm, calls
 * the caller-supplied `onConfirm` — the same handleCloseLeg() the manual exit
 * chips already use. No order-placement logic lives here.
 */

import React, { useState } from 'react';
import { Sparkles, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PositionLeg } from '@/lib/positionLegs';
import type { Suggestion } from '@/app/api/options/suggestions/route';
import type { ClosePct } from '@/lib/partialQty';

interface Props {
  suggestions: Suggestion[];
  legs: PositionLeg[];
  closingKeys: Set<string>;
  legKeyOf: (leg: PositionLeg) => string;
  onConfirm: (leg: PositionLeg, pct: ClosePct) => void;
  onDismiss: (id: string) => void;
}

/** A suggestion identifies its target leg by (strike, type, expiry) — the same
 *  fields a human reasons about — rather than a broker-specific trading symbol. */
function findMatchingLeg(s: Suggestion, legs: PositionLeg[]): PositionLeg | undefined {
  return legs.find((l) => l.strike === s.strike && l.type === s.type && l.expiry === s.expiry);
}

export default function SuggestedActionsCard({ suggestions, legs, closingKeys, legKeyOf, onConfirm, onDismiss }: Props) {
  const [armedId, setArmedId] = useState<string | null>(null);

  if (!suggestions.length) return null;

  return (
    <section className="space-y-2 rounded-xl border border-sky-900 bg-sky-950/20 p-3">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-sky-400" />
        <h2 className="text-xs font-bold uppercase tracking-wider text-sky-300">Suggested Actions</h2>
      </div>

      {suggestions.map((s) => {
        const leg = findMatchingLeg(s, legs);
        const closing = leg ? closingKeys.has(legKeyOf(leg)) : false;
        const armed = armedId === s.id;
        return (
          <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs font-bold text-zinc-100">
                  {s.action === 'CLOSE' ? 'Close' : `Trim ${s.pct}%`} {s.strike.toLocaleString('en-IN')} {s.type}
                  <span className="ml-1.5 text-[10px] font-normal text-zinc-500">{s.expiry}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{s.rationale}</p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {!leg ? (
                  <span className="flex items-center gap-1 rounded border border-amber-800 bg-amber-950 px-2 py-1 text-[10px] font-bold text-amber-300">
                    <AlertTriangle className="h-3 w-3" /> Position no longer open
                  </span>
                ) : closing ? (
                  <span className="text-[10px] text-zinc-400">Closing…</span>
                ) : (
                  <button type="button"
                    onClick={() => {
                      if (!armed) { setArmedId(s.id); setTimeout(() => setArmedId((a) => (a === s.id ? null : a)), 3000); return; }
                      setArmedId(null);
                      onConfirm(leg, s.pct);
                    }}
                    className={cn('rounded border px-2 py-1 font-mono text-[10px] font-bold transition-colors',
                      armed
                        ? 'border-rose-500 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                        : 'border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900')}>
                    {armed ? 'Confirm?' : 'Confirm'}
                  </button>
                )}
                <button type="button" onClick={() => onDismiss(s.id)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[10px] font-bold text-zinc-400 hover:text-zinc-200">
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
