import { NextRequest } from 'next/server';
import path from 'path';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { pickStockQuotes, type RawQuote } from '@/lib/indexScalperMarketWatch';

// Server-sent events for the Index Scalper's Top Indices / Top 10 Stocks windows. Watch-only.
//
// Both sources are Dhan WebSocket ticks: live_indices_ws.py and live_equity_ws.py read the shared market_data_hub
// feed and rewrite their JSON file every 2 s. This route only watches those files (1 s check) and pushes a frame when
// one changes. It makes no Dhan REST call and spawns nothing; the page starts the bridges through the idempotent
// POST /api/live-indices and /api/live-equity (never stops them: other pages share them).

export const dynamic = 'force-dynamic';

const INDICES_FILE = path.join(PROJECT_ROOT, 'debug', 'live_indices_quotes.json');
const EQUITY_FILE = path.join(PROJECT_ROOT, 'debug', 'live_equity_quotes.json');
const CHECK_MS = 1000;
/** A comment line every 15 s keeps proxies from closing a quiet stream (after hours nothing changes). */
const KEEPALIVE_MS = 15000;

interface QuotesFile { updated_at?: string | null; quotes?: Record<string, RawQuote> }

/** The equity bridge writes a naive local timestamp; send absolute ISO so the browser never guesses the zone. */
function absIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function GET(request: NextRequest) {
  const want = new Set((request.nextUrl.searchParams.get('want') ?? 'indices,stocks').split(','));
  const wantIdx = want.has('indices');
  const wantStk = want.has('stocks');
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stop = () => { clearInterval(timer); clearInterval(keepalive); };

  const stream = new ReadableStream({
    start(controller) {
      let lastKey = '';
      const send = (s: string) => {
        try { controller.enqueue(encoder.encode(s)); } catch { stop(); }
      };
      const tick = () => {
        const idx = wantIdx ? readJsonFile<QuotesFile>(INDICES_FILE) : null;
        const stk = wantStk ? readJsonFile<QuotesFile>(EQUITY_FILE) : null;
        const key = JSON.stringify([idx?.updated_at ?? '', stk?.updated_at ?? '']);
        if (key === lastKey) return;
        lastKey = key;
        const payload: Record<string, unknown> = {};
        if (wantIdx) payload.indices = { updated_at: absIso(idx?.updated_at), quotes: idx?.quotes ?? {} };
        if (wantStk) payload.stocks = { updated_at: absIso(stk?.updated_at), quotes: pickStockQuotes(stk?.quotes) };
        send(`data: ${JSON.stringify(payload)}\n\n`);
      };
      tick(); // first frame immediately
      timer = setInterval(tick, CHECK_MS);
      keepalive = setInterval(() => send(': keepalive\n\n'), KEEPALIVE_MS);
    },
    cancel: stop,
  });

  request.signal.addEventListener('abort', stop);

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
