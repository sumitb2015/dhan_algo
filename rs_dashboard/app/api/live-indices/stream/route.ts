import { NextRequest } from 'next/server';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
const HISTORY_FILE = path.join(DEBUG_DIR, 'live_indices_history.json');
const STATUS_FILE  = path.join(DEBUG_DIR, 'live_indices_status.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(controller) {
      let lastChangeKey = '';

      const tick = () => {
        const history   = readJson(HISTORY_FILE);
        const status    = readJson(STATUS_FILE) ?? { status: 'STOPPED', subscribed: 0 };
        const historyAt = (history?.updated_at   as string) ?? '';
        const statusAt  = (status.last_update    as string) ?? '';
        // Combined key: fires when history changes OR when status changes (e.g. bridge stops).
        // Also fires on the very first call because '' !== '|' is true, guaranteeing
        // an immediate event even when no history file exists yet.
        const changeKey = `${historyAt}|${statusAt}`;

        if (changeKey !== lastChangeKey) {
          lastChangeKey = changeKey;
          const payload = { success: true, status, history: history ?? null };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch { /* stream closed */ }
        }
      };

      tick(); // immediate event on connect
      interval = setInterval(tick, 1000);
    },
    cancel() {
      clearInterval(interval);
    },
  });

  request.signal.addEventListener('abort', () => clearInterval(interval));

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
