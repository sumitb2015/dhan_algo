'use client';

import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { ConfirmPayload } from './types';

/**
 * One modal for every real-money confirmation on this page — the SL/Target
 * auto-exit and the Exit-All square-off both route through it, so a trader
 * never sees two different "are you sure" affordances for the same class of
 * action. Focus lands on Cancel and Escape dismisses.
 */
export default function ConfirmDialog({
  payload,
  onCancel,
}: {
  payload: ConfirmPayload | null;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload, onCancel]);

  if (!payload) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={payload.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <Card className="w-full max-w-sm border border-zinc-700 bg-zinc-900 shadow-2xl">
        <CardContent className="flex flex-col gap-4 py-1">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-red-800 bg-red-950">
              <AlertTriangle className="size-5 text-red-400" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-zinc-100">{payload.title}</div>
              {payload.subtitle && (
                <div className="mt-0.5 truncate font-mono text-xs text-zinc-400">{payload.subtitle}</div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-xs leading-relaxed text-zinc-200">
            {payload.reason}
          </div>

          <div className="text-xs leading-relaxed text-zinc-400">{payload.detail}</div>

          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 bg-red-600 text-oncolor hover:bg-red-500"
              onClick={payload.onConfirm}
            >
              {payload.confirmLabel}
            </Button>
            <Button autoFocus size="sm" variant="outline" className="flex-1" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
