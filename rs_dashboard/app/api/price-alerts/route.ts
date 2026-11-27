import { NextRequest, NextResponse } from 'next/server';
import { alertsView, resolveInput, startPriceAlertLoop, updateAlerts } from '@/lib/priceAlertServer';
import { expiryReason, MAX_ALERTS, MAX_SOUND_SEC, newId, parseAlertInput, type PriceAlert } from '@/lib/priceAlerts';
import { istDateIso } from '@/lib/nseHolidays';

export const dynamic = 'force-dynamic';

// Price Alerts (docs/PRICE_ALERTS_GUIDE.md). GET = alerts + arm state + recent fired events. POST = one action:
//   create {alert} | update {id, alert} | move {id, value} | pause {id} | resume {id} | delete {id}
//   arm | disarm | settings {defaultSoundSec} | clearLog
// A trade alert places a REAL Dhan or Kotak order when it fires (server watcher, lib/priceAlertServer.ts) — only on a day it was
// armed. Instruments are resolved here from master_list.csv; the browser never supplies a security id.

const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });

export async function GET() {
  startPriceAlertLoop();
  try {
    return NextResponse.json({ success: true, data: alertsView() });
  } catch (e) {
    return bad(`Could not read alerts: ${(e as Error).message}`, 500);
  }
}

export async function POST(req: NextRequest) {
  startPriceAlertLoop();
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return bad('Invalid JSON'); }
  const action = String(body.action ?? '');
  const id = typeof body.id === 'string' ? body.id : '';
  const now = Date.now();

  try {
    if (action === 'create' || action === 'update') {
      const input = parseAlertInput(body.alert, now);
      if (typeof input === 'string') return bad(input);
      const resolved = await resolveInput(input);
      if (typeof resolved === 'string') return bad(resolved);
      const err = await updateAlerts<string | null>(action, s => {
        if (action === 'create') {
          if (s.alerts.length >= MAX_ALERTS) return { changed: false, result: `At most ${MAX_ALERTS} alerts — delete some first` };
          const alert: PriceAlert = {
            id: newId(now), createdAt: now, updatedAt: now, ...resolved,
            status: 'active', firedCount: 0, lastFiredAt: null, lastFiredPrice: null,
          };
          s.alerts.push(alert);
          return { changed: true, result: null };
        }
        const a = s.alerts.find(x => x.id === id);
        if (!a) return { changed: false, result: 'Alert not found' };
        if (a.status === 'firing') return { changed: false, result: 'Its order is being sent — wait a moment' };
        // Editing restarts the alert (TradingView's behaviour): a fired trade alert becomes a NEW order the next time.
        Object.assign(a, resolved, { updatedAt: now, status: 'active' });
        delete a.order; delete a.correlationId;
        return { changed: true, result: null };
      });
      return err ? bad(err, 409) : NextResponse.json({ success: true, data: alertsView() });
    }

    if (action === 'move') {
      const value = Number(body.value);
      if (!(value > 0) || !Number.isFinite(value)) return bad('Value must be a positive price');
      const err = await updateAlerts<string | null>('move', s => {
        const a = s.alerts.find(x => x.id === id);
        if (!a) return { changed: false, result: 'Alert not found' };
        if (a.status !== 'active' && a.status !== 'paused') return { changed: false, result: `A ${a.status} alert cannot be moved` };
        a.value = value; a.updatedAt = now;
        return { changed: true, result: null };
      });
      return err ? bad(err, 409) : NextResponse.json({ success: true, data: alertsView() });
    }

    if (action === 'pause' || action === 'resume' || action === 'delete') {
      const err = await updateAlerts<string | null>(action, s => {
        const i = s.alerts.findIndex(x => x.id === id);
        if (i < 0) return { changed: false, result: 'Alert not found' };
        const a = s.alerts[i];
        if (a.status === 'firing') return { changed: false, result: 'Its order is being sent — wait a moment' };
        if (action === 'delete') { s.alerts.splice(i, 1); return { changed: true, result: null }; }
        if (action === 'pause') {
          if (a.status !== 'active') return { changed: false, result: `A ${a.status} alert cannot be paused` };
          a.status = 'paused';
        } else {
          if (expiryReason(a, now)) return { changed: false, result: `${expiryReason(a, now)} — edit it to restart` };
          // Resuming a fired trade alert is a new order the next time it fires.
          a.status = 'active'; delete a.order; delete a.correlationId;
        }
        a.updatedAt = now;
        return { changed: true, result: null };
      });
      return err ? bad(err, 409) : NextResponse.json({ success: true, data: alertsView() });
    }

    if (action === 'arm' || action === 'disarm') {
      await updateAlerts('arm', s => {
        s.armedOn = action === 'arm' ? istDateIso(now) : null;
        return { changed: true, result: null };
      });
      return NextResponse.json({ success: true, data: alertsView() });
    }

    if (action === 'settings') {
      const sec = Number(body.defaultSoundSec);
      if (!Number.isInteger(sec) || sec < 1 || sec > MAX_SOUND_SEC) return bad(`Sound must be 1-${MAX_SOUND_SEC} seconds`);
      await updateAlerts('settings', s => { s.defaultSoundSec = sec; return { changed: true, result: null }; });
      return NextResponse.json({ success: true, data: alertsView() });
    }

    if (action === 'clearLog') {
      await updateAlerts('clear-log', () => ({ changed: true, result: null, log: [] }));
      return NextResponse.json({ success: true, data: alertsView() });
    }

    return bad(`Unknown action: ${action}`);
  } catch (e) {
    return bad(`Alert update failed: ${(e as Error).message}`, 500);
  }
}
