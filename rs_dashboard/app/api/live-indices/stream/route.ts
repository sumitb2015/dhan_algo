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
      let lastUpdatedAt = '';

      const tick = () => {
        const history = readJson(HISTORY_FILE);
        const status  = readJson(STATUS_FILE) ?? { status: 'STOPPED', subscribed: 0 };
        const updatedAt = (history?.updated_at as string) ?? '';

        // Send immediately on first call (lastUpdatedAt === ''), then only on change
        if (updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = updatedAt;
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
