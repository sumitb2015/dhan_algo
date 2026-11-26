import { NextRequest } from 'next/server';
import { alertsView, listeners, startPriceAlertLoop } from '@/lib/priceAlertServer';

export const dynamic = 'force-dynamic';

// Price Alerts push feed (Server-Sent Events), modelled on app/api/price-ladder/stream: the same view as GET
// /api/price-alerts, sent when it changes (checked every 250 ms). One shared read per CHECK_MS serves every open tab.
// `?leader=1` (the one tab that plays the alarm) also tells the watcher a browser is listening, so it does not play the
// alarm on the server's speakers too.

const CHECK_MS = 250;
const KEEPALIVE_MS = 15_000;

type View = ReturnType<typeof alertsView>;
interface Shared { at: number; view: View | null; error: string | null }
const shared: Shared = ((globalThis as { __priceAlertStream?: Shared }).__priceAlertStream ??= { at: 0, view: null, error: null });

function read(): Shared {
  const now = Date.now();
  if (now - shared.at >= CHECK_MS) {
    shared.at = now;
    try { shared.view = alertsView(); shared.error = null; } catch (e) { shared.error = String((e as Error)?.message ?? e); }
  }
  return shared;
}

export async function GET(req: NextRequest): Promise<Response> {
  startPriceAlertLoop();
  const leader = req.nextUrl.searchParams.get('leader') === '1';
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => { closed = true; if (timer) clearTimeout(timer); };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = '';
      let lastError = '';
      let sentAt = 0;
      const send = (chunk: string) => { sentAt = Date.now(); try { controller.enqueue(encoder.encode(chunk)); } catch { stop(); } };
      const loop = () => {
        if (closed) return;
        if (leader) listeners.leaderAt = Date.now();
        const r = read();
        if (r.view) {
          const v = r.view;
          const tail = v.log.at(-1);
          // Change test: state version + the newest event and its order outcome (an outcome arrives after the event) + the
          // watcher's health (running / alerts without a live price).
          const k = `${v.version}|${v.armedToday}|${v.log.length}|${tail?.id ?? ''}|${v.log.map(e => e.order?.status ?? '').join('')}`
            + `|${v.watcher?.running}|${v.watcher?.unpriced.join(',')}`;
          if (k !== last) { last = k; lastError = ''; send(`data: ${JSON.stringify({ success: true, data: v })}\n\n`); }
        } else if (r.error && r.error !== lastError) {
          lastError = r.error; last = '';
          send(`data: ${JSON.stringify({ success: false, error: lastError })}\n\n`);
        }
        if (Date.now() - sentAt >= KEEPALIVE_MS) send(': keepalive\n\n');
        if (!closed) timer = setTimeout(loop, CHECK_MS);
      };
      loop();
    },
    cancel() { stop(); },
  });
  req.signal.addEventListener('abort', stop);

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
