'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Sparkles, X } from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { markAllSeen, useWhatsNew } from '@/lib/whatsNewStore';
import WhatsNewList from './WhatsNewList';

const PANEL_LIMIT = 40;

interface WhatsNewPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function WhatsNewPanel({ open, onClose }: WhatsNewPanelProps) {
  const { notes, loaded, error, seen } = useWhatsNew();
  // Freeze the watermark while the panel is open so the unread highlight
  // survives the mark-as-seen that happens on open.
  const frozenSeen = useRef<string | null>(null);
  if (!open) frozenSeen.current = seen;

  useEffect(() => {
    if (open && loaded) markAllSeen();
  }, [open, loaded]);

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[440px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0"
      >
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <Sparkles className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">What&apos;s New</SheetTitle>
              <SheetDescription className="text-[11px] text-zinc-500">
                Recent features, fixes and speed-ups
              </SheetDescription>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center h-7 w-7 rounded-xl border border-zinc-700/60 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!loaded && <p className="text-xs text-zinc-500">Loading…</p>}
          {loaded && error && (
            <p className="text-xs text-red-400">Could not read release notes from git.</p>
          )}
          {loaded && !error && notes.length === 0 && (
            <p className="text-xs text-zinc-500">Nothing to show yet.</p>
          )}
          {notes.length > 0 && (
            <WhatsNewList
              notes={notes.slice(0, PANEL_LIMIT)}
              unreadAfter={frozenSeen.current}
              onNavigate={onClose}
            />
          )}
        </div>

        <div className="flex-none px-5 py-3 border-t border-zinc-800">
          <Link
            href="/whats-new"
            onClick={onClose}
            className="text-xs font-medium text-emerald-400 hover:underline"
          >
            See full history →
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
