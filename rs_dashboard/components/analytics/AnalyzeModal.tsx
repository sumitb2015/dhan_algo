'use client';

/**
 * Modal shell for the "Analyze" button on /options-analytics/[underlying].
 * Purely presentational: PositionsAnalysis.tsx owns the fetch to
 * /api/options/analyze and passes the result down. The suggestions list is
 * the SAME SuggestedActionsCard the persistent sidebar panel uses (this
 * modal's parent has already written the fresh suggestions into the same
 * `suggestions` state the sidebar polls from, so both stay in sync and
 * Confirm/Dismiss here behave identically to the sidebar's).
 */

import React, { useEffect } from 'react';
import { Sparkles, X, Loader2, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { PositionLeg } from '@/lib/positionLegs';
import type { Suggestion } from '@/app/api/options/suggestions/route';
import type { ClosePct } from '@/lib/partialQty';
import SuggestedActionsCard from './SuggestedActionsCard';

interface Props {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  summary: string | null;
  suggestions: Suggestion[];
  legs: PositionLeg[];
  closingKeys: Set<string>;
  legKeyOf: (leg: PositionLeg) => string;
  onConfirm: (leg: PositionLeg, pct: ClosePct) => void;
  onDismiss: (id: string) => void;
}

export default function AnalyzeModal({
  open, onClose, loading, error, summary, suggestions, legs, closingKeys, legKeyOf, onConfirm, onDismiss,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Position analysis"
      className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 p-4 backdrop-blur-md"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900/95 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-2.5 border-b border-zinc-800/80 px-5 py-3.5 bg-zinc-950/60">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
            <Sparkles className="h-4 w-4 text-sky-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Antigravity Position Analysis</h2>
            <span className="text-[10px] font-semibold text-sky-400">
              Risk &amp; Adjustment Engine
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3.5 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2.5 py-8 text-sm text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" /> Reviewing open positions &amp; Greeks risk profile…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-800/80 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && summary && (
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/80 p-3.5 text-xs leading-relaxed text-zinc-300 space-y-1.5 shadow-sm">
              <div className="flex items-center gap-1.5 font-bold text-zinc-100">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                <span>Executive Risk Summary</span>
              </div>
              <p className="text-zinc-400">{summary}</p>
            </div>
          )}

          {!loading && !error && suggestions.length === 0 && summary && (
            <p className="text-[11px] text-zinc-500">No adjustments suggested right now. Book risk is balanced.</p>
          )}

          {!loading && !error && (
            <SuggestedActionsCard
              suggestions={suggestions}
              legs={legs}
              closingKeys={closingKeys}
              legKeyOf={legKeyOf}
              onConfirm={onConfirm}
              onDismiss={onDismiss}
            />
          )}
        </div>
      </div>
    </div>
  );
}
