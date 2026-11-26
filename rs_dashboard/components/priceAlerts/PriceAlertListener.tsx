'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { installAlertSoundUnlock, playAlarm, playWarnChime } from '@/lib/alertSound';
import { useTabLeader } from '@/hooks/useTabLeader';
import { priceAlertsStore, usePriceAlertsUi } from '@/lib/priceAlertsUi';
import type { AlertEvent, AlertsView } from '@/lib/priceAlerts';
import PriceAlertsPanel from './PriceAlertsPanel';
import AlertDialog from './AlertDialog';

// Mounted ONCE in app/layout.tsx. The only browser code that talks to the alerts server:
//   • keeps the store (lib/priceAlertsUi.ts) current from /api/price-alerts/stream (SSE), polling as a fallback;
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

    const open = () => {
      if (es || disposed) return;
      es = new EventSource(`/api/price-alerts/stream${leaderRef.current ? '?leader=1' : ''}`);
      es.onmessage = ev => {
        try { const j = JSON.parse(ev.data); if (j.success) { stopPoll(); apply(j.data); } } catch { /* ignore */ }
      };
      es.onerror = () => { startPoll(); };   // EventSource reconnects by itself; poll meanwhile
    };
    const close = () => { es?.close(); es = null; };

    // Followers close the stream while hidden; the leader keeps it (it must hear an alert to ring it).
    const onVis = () => {
      if (document.hidden && !leaderRef.current) { close(); startPoll(); }
      else { open(); }
    };

    void fetchOnce().then(() => { if (!disposed) onVis(); });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
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
