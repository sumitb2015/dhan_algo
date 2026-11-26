'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { alertSoundReady, installAlertSoundUnlock, playAlarm, playWarnChime } from '@/lib/alertSound';
import { useTabLeader } from '@/hooks/useTabLeader';
import { priceAlertsStore, usePriceAlertsUi } from '@/lib/priceAlertsUi';
import type { AlertEvent, AlertsView } from '@/lib/priceAlerts';
import PriceAlertsPanel from './PriceAlertsPanel';
import AlertDialog from './AlertDialog';

// Mounted ONCE in app/layout.tsx. The only browser code that talks to the alerts server:
//   • keeps the store (lib/priceAlertsUi.ts) current: the leader tab from /api/price-alerts/stream (SSE), other tabs by
//     polling (one stream per browser);
//   • on a newly fired event: a toast in every tab, and the alarm (N seconds) in the ONE leader tab, which also tells the
//     server it is listening (?leader=1) so the server does not play it on the speakers as well;
//   • renders the header's panel and the create / edit dialog.
// Events already in the log when the page loads are marked seen: an old alert never rings again on reload.

const POLL_MS = 5000;

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function PriceAlertListener() {
  const pathname = usePathname();
  const onLogin = pathname === '/login';
  const { isLeader, leaderRef } = useTabLeader('price-alerts');
  const seen = useRef<Map<string, string> | null>(null);
  const stops = useRef<Map<string, () => void>>(new Map());
  const ui = usePriceAlertsUi();

  useEffect(() => installAlertSoundUnlock(), []);

  useEffect(() => {
    if (onLogin || isLeader === null) return;
    let disposed = false;
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const ring = (e: AlertEvent) => {
      const stop = leaderRef.current ? playAlarm(e.soundSec * 1000) : () => {};
      stops.current.set(e.id, stop);
      toast(`🔔 ${e.symbol} ${fmt(e.price)}`, {
        id: `pa-${e.id}`,
        description: e.trade ? `${e.message} — ${e.trade}` : e.message,
        duration: Math.max(8000, e.soundSec * 1000 + 3000),
        action: { label: 'Stop sound', onClick: () => { stops.current.get(e.id)?.(); stops.current.delete(e.id); } },
      });
    };

    const outcome = (e: AlertEvent) => {
      const o = e.order;
      if (!o) return;
      if (o.status === 'placed') toast.success(`Alert order placed: ${e.trade}`, { description: `Order ${o.orderId}` });
      else {
        toast.error(`Alert order ${o.status}: ${e.trade}`, { description: o.message, duration: 15_000 });
        if (o.status !== 'skipped' && leaderRef.current) playWarnChime();
      }
    };

    const apply = (view: AlertsView) => {
      priceAlertsStore.setView(view);
      if (!seen.current) {
        seen.current = new Map(view.log.map(e => [e.id, e.order?.status ?? '']));
        return;
      }
      for (const e of view.log) {
        const prev = seen.current.get(e.id);
        const now = e.order?.status ?? '';
        if (prev === undefined) { ring(e); if (now) outcome(e); }
        else if (prev !== now && now) outcome(e);
        seen.current.set(e.id, now);
      }
    };

    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/price-alerts', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!disposed && j.success) apply(j.data);
      } catch { /* offline: next poll */ }
    };

    const startPoll = () => { if (!poll) poll = setInterval(() => { void fetchOnce(); }, POLL_MS); };
    const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };

    // Only the leader tab holds the stream: one SSE connection per browser, not one per tab (HTTP/1.1 allows 6 per
    // origin across ALL tabs, and the chart / order pages need theirs). Followers poll every POLL_MS (toast only).
    // The leader says ?leader=1 — "a browser will sound this, server stay quiet" — only once its audio is unlocked;
    // until the first click it streams without it, so the server's speakers still ring.
    let streamLeader = false;
    const open = () => {
      if (es || disposed) return;
      streamLeader = alertSoundReady();
      es = new EventSource(`/api/price-alerts/stream${streamLeader ? '?leader=1' : ''}`);
      es.onmessage = ev => {
        try { const j = JSON.parse(ev.data); if (j.success) { stopPoll(); apply(j.data); } } catch { /* ignore */ }
      };
      es.onerror = () => { startPoll(); };   // EventSource reconnects by itself; poll meanwhile
    };
    const close = () => { es?.close(); es = null; };

    // The first click / key unlocks audio: reopen the leader's stream as ?leader=1.
    const onUnlock = () => {
      if (!leaderRef.current || streamLeader) return;
      setTimeout(() => { if (!disposed && alertSoundReady() && !streamLeader) { close(); open(); } }, 200);
    };

    if (leaderRef.current) void fetchOnce().then(() => { if (!disposed) open(); });
    else { void fetchOnce(); startPoll(); }
    window.addEventListener('pointerdown', onUnlock);
    window.addEventListener('keydown', onUnlock);
    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', onUnlock);
      window.removeEventListener('keydown', onUnlock);
      close(); stopPoll();
    };
  }, [onLogin, isLeader, leaderRef]);

  if (onLogin) return null;
  return (
    <>
      <PriceAlertsPanel open={ui.panelOpen} onClose={priceAlertsStore.closePanel} />
      {ui.dialog && <AlertDialog init={ui.dialog} onClose={priceAlertsStore.closeDialog} />}
    </>
  );
}
