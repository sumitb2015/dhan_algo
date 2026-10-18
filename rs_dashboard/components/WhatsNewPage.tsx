'use client';

import { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import { markAllSeen, useWhatsNew } from '@/lib/whatsNewStore';
import NavBar from './NavBar';
import WhatsNewList from './WhatsNewList';

export default function WhatsNewPage() {
  const { notes, loaded, error, seen } = useWhatsNew();
  // Capture the watermark once, before this visit marks everything seen.
  const initialSeen = useRef<string | null | undefined>(undefined);
  if (initialSeen.current === undefined && loaded) initialSeen.current = seen;

  useEffect(() => {
    if (loaded) markAllSeen();
  }, [loaded]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Sparkles className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">App · Releases</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">What&apos;s New</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Features, fixes and speed-ups, from the git history</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-3xl w-full mx-auto">
        {!loaded && <p className="text-xs text-zinc-500">Loading…</p>}
        {loaded && error && <p className="text-xs text-red-400">Could not read release notes from git.</p>}
        {loaded && !error && notes.length === 0 && <p className="text-xs text-zinc-500">Nothing to show yet.</p>}
        {notes.length > 0 && (
          <WhatsNewList notes={notes} unreadAfter={initialSeen.current ?? null} />
        )}
      </div>
    </div>
  );
}
