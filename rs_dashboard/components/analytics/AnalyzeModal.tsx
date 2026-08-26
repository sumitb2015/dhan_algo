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
      className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Sparkles className="h-4 w-4 text-sky-400" />
          <h2 className="text-sm font-bold text-zinc-100">Antigravity Position Analysis</h2>
          <span className="rounded border border-sky-800 bg-sky-950/60 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-300">
            Risk &amp; Adjustment Engine
          </span>
          <button type="button" onClick={onClose} aria-label="Close"
            className="ml-auto rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-4">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" /> Reviewing open positions &amp; Greeks risk profile…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 rounded border border-rose-800 bg-rose-950 px-3 py-2 text-xs text-rose-300">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {error}
            </div>
          )}

          {!loading && !error && summary && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-3 text-xs leading-relaxed text-zinc-300 space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-zinc-200">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
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
