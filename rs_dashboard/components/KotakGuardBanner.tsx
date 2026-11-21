'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Lock, ShieldAlert, X } from 'lucide-react';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';

// One global banner (mounted in app/layout.tsx) for the Kotak whole-account loss limit:
//  - LOCKED: the loss limit fired; new positions are refused by the dashboard and squared off on sight for the rest of the day.
//  - NOT PROTECTING: the daily default guard is on but the watcher cannot act (Kotak session expired, book unreadable).
// Nothing renders while all is well. Read-only: it never arms, clears or sends anything. The server watcher
// (lib/guardServerCore.ts) is the only executor, so closing every tab does not switch the guard off.

interface GuardStatus {
  sessionValid: boolean;
  state?: { lock?: { at: number; reason: string } | null; pnl?: unknown; health?: { watching: boolean; reason: string } };
  defaults?: { enabled: boolean; loss: number } | null;
}

const POLL_MS = 10_000;

export default function KotakGuardBanner() {
  const pathname = usePathname();
  const [status, setStatus] = useState<GuardStatus | null>(null);
  const [dismissedWarn, setDismissedWarn] = useState(false);
  const { isLeader } = useTabLeader('kotak-guard-banner');
  const chimedFor = useRef<number | null>(null);
  const onLogin = pathname === '/login';

  // `busy` belongs to one effect run: a shared ref stayed true after React's dev double-mount aborted the first request, so
  // the second run's first poll was skipped for a whole interval.
  const load = useCallback(async (signal: AbortSignal, busy: { v: boolean }) => {
    if (busy.v || document.visibilityState === 'hidden') return;
    busy.v = true;
    try {
      const r = await fetch('/api/scalper/kotak/guards', { cache: 'no-store', signal });
      if (!r.ok) return;
      const j = await r.json() as GuardStatus & { success?: boolean };
      if (j.success) setStatus(j);
    } catch { /* offline or aborted: keep the last status */ }
    finally { busy.v = false; }
  }, []);

  useEffect(() => {
    if (onLogin) return;
    const ctl = new AbortController();
    const busy = { v: false };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(ctl.signal, busy);
    const t = setInterval(() => { void load(ctl.signal, busy); }, POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') void load(ctl.signal, busy); };
    document.addEventListener('visibilitychange', vis);
    const unlock = installAlertSoundUnlock();
    return () => { ctl.abort(); clearInterval(t); document.removeEventListener('visibilitychange', vis); unlock(); };
  }, [onLogin, load]);

  const lock = status?.state?.lock ?? null;
  // One chime per lock, from the leader tab only (several tabs polling would otherwise each beep).
  useEffect(() => {
    if (!lock || isLeader !== true || chimedFor.current === lock.at) return;
    chimedFor.current = lock.at;
    playAlertChime();
  }, [lock, isLeader]);

  if (onLogin || !status) return null;

  if (lock) {
    return (
      <div role="alert" className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 flex max-w-[min(92vw,720px)] items-center gap-2.5 rounded-lg border border-red-500/40 bg-zinc-900 px-3.5 py-2.5 font-mono text-xs text-zinc-100 shadow-2xl">
        <Lock className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
        <div className="min-w-0">
          <div className="font-bold text-red-400">KOTAK LOCKED FOR TODAY</div>
          <div className="text-zinc-300">{lock.reason}. New positions are refused here and squared off within seconds, including ones placed in the Kotak app. Exits still work.</div>
        </div>
      </div>
    );
  }

  const armed = status.defaults?.enabled === true || status.state?.pnl != null;
  const reason = !status.sessionValid ? 'Kotak session expired - log in again' : status.state?.health && !status.state.health.watching ? status.state.health.reason : '';
  if (armed && reason && !dismissedWarn) {
    return (
      <div role="alert" className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 flex max-w-[min(92vw,720px)] items-center gap-2.5 rounded-lg border border-amber-500/40 bg-zinc-900 px-3.5 py-2.5 font-mono text-xs text-zinc-100 shadow-2xl">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
        <div className="min-w-0">
          <div className="font-bold text-amber-400">KOTAK LOSS LIMIT IS NOT PROTECTING</div>
          <div className="text-zinc-300">{reason}. Nothing will stop a loss on Kotak until this is fixed.</div>
        </div>
        <button type="button" aria-label="Dismiss warning" onClick={() => setDismissedWarn(true)} className="ml-1 shrink-0 rounded p-1 text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60">
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    );
  }
  return null;
}
