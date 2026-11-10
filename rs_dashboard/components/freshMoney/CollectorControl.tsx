'use client';

/**
 * Start / stop the MCX OI collector (scripts/tools/crudeoil_oi_collector.py) that feeds the CRUDEOIL / CRUDEOILM board.
 * The dashboard starts it by itself for each MCX session (lib/crudeCollector.ts); Stop keeps it off for the rest of the
 * day, Start brings it back. NSE boards need nothing here. Market data only, no orders.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';

interface Status { status?: string; reason?: string; last_update?: string | null; expiry?: string; error?: string }

const POLL_MS = 10_000;
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

export default function CollectorControl({ underlying }: { underlying: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetch(`/api/crudeoil-oi-collector?underlying=${underlying}`, { cache: 'no-store' });
      const j = (await res.json()) as { status?: Status };
      if (my === seq.current) setStatus(j.status ?? null);
    } catch { /* keep the last status */ }
  }, [underlying]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive && !document.hidden) refresh(); };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [refresh]);

  const act = async (action: 'start' | 'stop') => {
    setBusy(true);
    try {
      await fetch('/api/crudeoil-oi-collector', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, underlying }),
      });
    } finally {
      setTimeout(() => { refresh(); setBusy(false); }, 2_500);
    }
  };

  const waiting = status?.status === 'WAITING';
  const running = status?.status === 'RUNNING' || waiting;
  const why: Record<string, string> = { stopped_today: ' — off for today', no_futures_price: ' (no futures price — retrying)', crashed: ' (crashed)', mcx_closed_today: ' (MCX closed today)', market_closed: ' (MCX closed for the day)' };
  const label = waiting
    ? 'Collector waiting for the MCX open'
    : running
      ? `Collector running${status?.last_update ? ` · ${status.last_update.slice(11)}` : ''}`
      : `Collector stopped${why[status?.reason === 'stop_trigger' ? 'stopped_today' : status?.reason ?? ''] ?? ''}`;

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1">
      <span className={`h-1.5 w-1.5 rounded-full ${waiting ? 'bg-amber-400' : running ? 'bg-emerald-400' : 'bg-zinc-500'}`} aria-hidden />
      <span className="text-[10px] font-medium text-zinc-300" title={status?.error ?? undefined}>{label}</span>
      {busy ? <Loader2 className="h-3 w-3 animate-spin text-zinc-400" aria-label="Working" /> : running ? (
        <button type="button" onClick={() => act('stop')} aria-label={`Stop the ${underlying} OI collector`} title="Stop the collector for the rest of today (it starts again by itself next session)"
          className={`${FOCUS} flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-white`}>
          <Square className="h-3 w-3" />
        </button>
      ) : (
        <button type="button" onClick={() => act('start')} aria-label={`Start the ${underlying} OI collector`} title="Start collecting this board now (it also starts by itself at each MCX session)"
          className={`${FOCUS} flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold text-emerald-400 hover:bg-zinc-800`}>
          <Play className="h-3 w-3" /> Start
        </button>
      )}
    </div>
  );
}
