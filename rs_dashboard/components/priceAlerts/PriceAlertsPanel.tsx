'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AlarmClock, Pause, Pencil, Play, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { CONDITIONS, MAX_SOUND_SEC, alertLabel, tradeLine, type AlertEvent, type PriceAlert } from '@/lib/priceAlerts';
import { ARM_CONFIRM, postAlertAction, priceAlertsStore, usePriceAlertsUi } from '@/lib/priceAlertsUi';

// The header's Price Alerts window: the alert list (edit / pause / resume / delete), the fired-alert log, the daily
// "REAL orders armed" switch and the default alarm length. Creating and editing open AlertDialog.

const STATUS_STYLE: Record<PriceAlert['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  paused: 'bg-zinc-800 text-zinc-400 border-zinc-700',
  triggered: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  expired: 'bg-zinc-800 text-zinc-500 border-zinc-700',
  firing: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
};

const ORDER_STYLE: Record<string, string> = {
  placed: 'text-emerald-400', rejected: 'text-red-400', unknown: 'text-amber-400', skipped: 'text-zinc-400',
};

const time = (ms: number) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

const iconBtn = 'flex items-center justify-center h-7 w-7 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60 disabled:opacity-40 disabled:cursor-not-allowed';

async function act(body: Record<string, unknown>, ok?: string) {
  try { await postAlertAction(body); if (ok) toast.success(ok); } catch (e) { toast.error((e as Error).message); }
}

function AlertRow({ a, unpriced }: { a: PriceAlert; unpriced: boolean }) {
  const busy = a.status === 'firing';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-zinc-100 truncate">{alertLabel(a)}</div>
          <div className="text-[11px] text-zinc-400">
            {a.trigger === 'once' ? 'Once only' : 'Every time'} · {a.expiresAt ? `until ${time(a.expiresAt)}` : 'open-ended'} · sound {a.soundSec}s
          </div>
        </div>
        <span className={cn('shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase', STATUS_STYLE[a.status])}>{a.status}</span>
      </div>
      {a.action.kind === 'trade' && (
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-amber-400">
          <ShieldAlert className="h-3 w-3" /> {tradeLine(a.action)}
        </div>
      )}
      {unpriced && (
        <div className="text-[11px] font-semibold text-red-400">No live price for {a.instrument.displayName} — this alert cannot fire until the price feed returns.</div>
      )}
      {a.message && <div className="text-[11px] text-zinc-300 truncate">“{a.message}”</div>}
      {a.lastFiredAt && (
        <div className="text-[11px] text-zinc-500">
          Fired {a.firedCount}× · last {time(a.lastFiredAt)} at {fmt(a.lastFiredPrice ?? 0)}
          {a.order && <span className={cn('ml-1 font-semibold', ORDER_STYLE[a.order.status])}>· order {a.order.status}</span>}
        </div>
      )}
      {a.order && a.order.status !== 'placed' && <div className="text-[11px] text-zinc-400">{a.order.message}</div>}
      <div className="flex items-center justify-end gap-1 pt-0.5">
        <button type="button" aria-label="Edit alert" title="Edit" className={iconBtn} disabled={busy}
          onClick={() => priceAlertsStore.openDialog({ editId: a.id })}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {a.status === 'active' ? (
          <button type="button" aria-label="Pause alert" title="Pause" className={iconBtn} onClick={() => act({ action: 'pause', id: a.id })}>
            <Pause className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button type="button" aria-label="Restart alert" title={a.action.kind === 'trade' && a.order ? 'Restart (will place a NEW order when it fires)' : 'Restart'}
            className={iconBtn} disabled={busy} onClick={() => act({ action: 'resume', id: a.id })}>
            <Play className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" aria-label="Delete alert" title="Delete" className={cn(iconBtn, 'hover:text-red-400')} disabled={busy}
          onClick={() => act({ action: 'delete', id: a.id })}>
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function LogRow({ e }: { e: AlertEvent }) {
  return (
    <div className="border-b border-zinc-800/70 py-2 text-[11px]">
      <div className="flex justify-between gap-2">
        <span className="font-bold text-zinc-100">{e.symbol} {CONDITIONS[e.condition]} {fmt(e.value)}</span>
        <span className="font-mono text-zinc-500">{time(e.at)}</span>
      </div>
      <div className="text-zinc-400">Price {fmt(e.price)}{e.message ? ` — ${e.message}` : ''}</div>
      {e.trade && (
        <div className="font-mono">
          <span className="text-amber-400">{e.trade}</span>
          {e.order
            ? <span className={cn('ml-1 font-semibold', ORDER_STYLE[e.order.status])}>
                {e.order.status}{e.order.status === 'placed' ? ` #${e.order.orderId}` : `: ${e.order.message}`}
              </span>
            : <span className="ml-1 text-sky-400">sending…</span>}
        </div>
      )}
    </div>
  );
}

export default function PriceAlertsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { view } = usePriceAlertsUi();
  const [tab, setTab] = useState<'alerts' | 'log'>('alerts');
  const [soundDraft, setSoundDraft] = useState<string | null>(null);
  const alerts = view?.alerts ?? [];
  const log = [...(view?.log ?? [])].reverse();
  const unpriced = new Set(view?.watcher?.unpriced ?? []);
  const watcherDown = !!view?.watcher && !view.watcher.running && alerts.some(a => a.status === 'active');
  const hasTrade = alerts.some(a => a.action.kind === 'trade' && (a.status === 'active' || a.status === 'paused'));

  const commitSound = () => {
    if (soundDraft === null) return;
    const n = Number(soundDraft);
    setSoundDraft(null);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SOUND_SEC) { toast.error(`Sound must be 1-${MAX_SOUND_SEC} seconds`); return; }
    if (n !== view?.defaultSoundSec) void act({ action: 'settings', defaultSoundSec: n });
  };

  const toggleArm = () => {
    if (view?.armedToday) { void act({ action: 'disarm' }, 'Alert orders disarmed'); return; }
    if (!window.confirm(ARM_CONFIRM)) return;
    void act({ action: 'arm' }, 'Alert orders armed for today');
  };

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" showCloseButton={false} className="w-[440px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0">
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <AlarmClock className="h-4 w-4 text-amber-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">Price Alerts</SheetTitle>
              <SheetDescription className="text-[10px] text-zinc-500">Run on the server — they work with every tab closed</SheetDescription>
            </div>
          </div>
          <button type="button" aria-label="Close" className="shrink-0 text-zinc-500 hover:text-white cursor-pointer" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </SheetHeader>

        <div className="flex-none px-5 py-3 space-y-3 border-b border-zinc-800">
          <button type="button" onClick={() => priceAlertsStore.openDialog({})}
            className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-oncolor-dark text-xs font-bold cursor-pointer transition-colors">
            <Plus className="h-3.5 w-3.5" /> Create alert
          </button>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={toggleArm} aria-pressed={!!view?.armedToday}
              className={cn('flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11px] font-bold cursor-pointer transition-colors',
                view?.armedToday ? 'border-red-500/50 bg-red-500/15 text-red-400' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white')}>
              <ShieldAlert className="h-3.5 w-3.5" />
              {view?.armedToday ? 'REAL orders ARMED today' : 'REAL orders not armed'}
            </button>
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              Default sound
              <input type="number" min={1} max={MAX_SOUND_SEC} aria-label="Default alarm length in seconds"
                value={soundDraft ?? String(view?.defaultSoundSec ?? 3)}
                onChange={e => setSoundDraft(e.target.value)} onBlur={commitSound}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="w-12 h-7 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-100 font-mono" />
              s
            </label>
          </div>
          {watcherDown && (
            <p className="text-[11px] font-semibold text-red-400">The alert watcher is not running on the server — no alert will fire. Restart the dashboard.</p>
          )}
          {hasTrade && !view?.armedToday && (
            <p className="text-[11px] text-amber-400">Trade alerts will only notify today — their orders are skipped until you arm REAL orders.</p>
          )}
          <div className="flex gap-1" role="tablist">
            {(['alerts', 'log'] as const).map(t => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={cn('flex-1 h-7 rounded-md text-[11px] font-bold uppercase cursor-pointer transition-colors',
                  tab === t ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-200')}>
                {t === 'alerts' ? `Alerts (${alerts.length})` : `Log (${view?.log.length ?? 0})`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-2">
          {!view && <div className="text-xs text-zinc-500">Loading…</div>}
          {view && tab === 'alerts' && (alerts.length
            ? [...alerts].reverse().map(a => <AlertRow key={a.id} a={a} unpriced={unpriced.has(a.id)} />)
            : <div className="text-xs text-zinc-500 py-6 text-center">No alerts yet. Create one here, or from a chart&apos;s “+” price menu.</div>)}
          {view && tab === 'log' && (
            <>
              {log.length > 0 && (
                <div className="flex justify-end">
                  <button type="button" className="text-[11px] text-zinc-500 hover:text-red-400 cursor-pointer" onClick={() => act({ action: 'clearLog' })}>Clear log</button>
                </div>
              )}
              {log.length ? log.map(e => <LogRow key={e.id} e={e} />) : <div className="text-xs text-zinc-500 py-6 text-center">Nothing has fired yet.</div>}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
