import { NextRequest } from 'next/server';
import { startPriceLadderLoop } from '@/lib/priceLadderServer';
import { buildLadderView } from '@/lib/priceLadderView';

export const dynamic = 'force-dynamic';

// The Price Ladder page's push feed (Server-Sent Events): the same view as GET /api/price-ladder/state, sent the
// moment it changes (checked every 250 ms) instead of on the page's 1 s poll. The prices behind it are the WebSocket
// feeds' files, so this only shortens the last hop to the browser. Read-only; the page falls back to polling if the
// stream drops (and closes it while its tab is hidden).
//
// Builds are shared: every connection showing the same selection reuses one build per CHECK_MS, so extra tabs add
// no extra file reads on the server that also places the orders.

const CHECK_MS = 250;
/** A comment line now and then, so an idle connection is not closed by a proxy and a dead one is noticed. */
const KEEPALIVE_MS = 15_000;

type View = Awaited<ReturnType<typeof buildLadderView>>;
interface Shared { at: number; run: Promise<{ view?: View; error?: string }> }
const builds: Map<string, Shared> = ((globalThis as { __priceLadderStreamBuilds?: Map<string, Shared> }).__priceLadderStreamBuilds ??= new Map());

/** One build per selection per CHECK_MS, shared by every connection asking for it. */
function sharedBuild(key: string, params: URLSearchParams): Shared['run'] {
  const now = Date.now();
  const hit = builds.get(key);
  if (hit && now - hit.at < CHECK_MS) return hit.run;
  const run = buildLadderView(params).then(view => ({ view }), (err: unknown) => ({ error: String((err as Error)?.message ?? err) }));
  builds.set(key, { at: now, run });
  // Old selections nobody asks for any more are dropped.
  for (const [k, b] of builds) if (now - b.at > 60_000) builds.delete(k);
  return run;
}

export async function GET(req: NextRequest): Promise<Response> {
  startPriceLadderLoop();
  const params = new URLSearchParams(req.nextUrl.searchParams);
  const key = ['underlying', 'expiry', 'strike', 'opt'].map(k => params.get(k) ?? '').join('|');
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
      // One check at a time: the next is scheduled only after this one finished.
      const loop = async () => {
        if (closed) return;
        const r = await sharedBuild(key, params);
        if (r.view) {
          // `now` changes on every build; leave it out of the change test. After an error the next good view is always
          // sent (last was reset), so the page's error clears even if the view itself did not change.
          const k = JSON.stringify({ ...r.view, now: 0 });
          if (k !== last) { last = k; lastError = ''; send(`data: ${JSON.stringify({ success: true, data: r.view })}\n\n`); }
        } else if (r.error !== lastError) {
          // An error is sent once (not every 250 ms) and forgets the last view, so recovery is re-sent.
          lastError = r.error ?? 'error'; last = '';
          send(`data: ${JSON.stringify({ success: false, error: lastError })}\n\n`);
        }
        if (Date.now() - sentAt >= KEEPALIVE_MS) send(': keepalive\n\n');
        if (!closed) timer = setTimeout(() => { void loop(); }, CHECK_MS);
      };
      void loop();
    },
    cancel() { stop(); },
  });
  req.signal.addEventListener('abort', stop);

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
