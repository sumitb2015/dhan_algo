import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from './pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_futures_live_quotes.py');

interface LiveQuotesPayload {
  success: boolean;
  updated_at?: string;
  quotes?: Record<string, number>;
}

// Short-TTL cache: the underlying script spawns Python and makes 2-3 batched
// REST calls to Dhan (~1-2s), so every dashboard poll re-spawning it would be
// wasteful and would fight other routes for Dhan's per-account rate bucket.
// dedupe() alone only prevents concurrent duplicate spawns; this cache also
// prevents back-to-back sequential spawns within the TTL window.
const CACHE_TTL_MS = 15_000;
let cache: { at: number; quotes: Record<string, number> } | null = null;

async function fetchLiveQuotes(): Promise<Record<string, number>> {
  return dedupe('futures-live-quotes', async () => {
    try {
      const payload = await runPythonJson<LiveQuotesPayload>(SCRIPT, [], 30_000);
      if (payload?.success && payload.quotes) return payload.quotes;
    } catch {
      /* transient — callers keep showing EOD price rather than failing the request */
    }
    return {};
  });
}

/** Live FUTSTK LTPs, keyed by underlying symbol. Cached for CACHE_TTL_MS. */
export async function getLiveFuturesQuotes(): Promise<Record<string, number>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.quotes;

  const quotes = await fetchLiveQuotes();
  // Don't let a failed fetch (empty quotes) stomp a still-fresh-enough prior
  // result — keep serving the last good snapshot until the TTL genuinely lapses.
  if (Object.keys(quotes).length > 0 || !cache) {
    cache = { at: now, quotes };
  }
  return cache.quotes;
}
