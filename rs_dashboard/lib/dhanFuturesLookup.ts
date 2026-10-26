import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

/** One listed futures contract of an MCX underlying, from Dhan's master list. */
export interface DhanFuture { securityId: string; expiry: string; tick: number; lotSize: number }

const cache = new Map<string, { at: number; list: DhanFuture[] }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
// A failed lookup is remembered briefly: the 1 s ladder poll would otherwise spawn a Python process per poll.
const failed = new Map<string, number>();
const FAIL_TTL_MS = 15_000;

/** Contracts expiring after today (IST): a future on its last day is not offered for a new ladder position. */
const liveOnly = (list: DhanFuture[]): DhanFuture[] => {
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  return list.filter(f => f.expiry > today);
};

/** Live futures contracts of `underlying` (CRUDEOILM / CRUDEOIL), nearest expiry first, or null when they cannot be read. */
export async function getDhanFutures(underlying: string): Promise<DhanFuture[] | null> {
  const hit = cache.get(underlying);
  // The list is cached for an hour, so the expiry filter is applied on every read: a contract that expires today drops out at midnight.
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return liveOnly(hit.list);
  if (Date.now() - (failed.get(underlying) ?? 0) < FAIL_TTL_MS) return null;
  try {
    const r = await dedupe(`dhan-futures:${underlying}`, () =>
      runPythonJson<{ success: boolean; data?: { contracts?: DhanFuture[] } }>(SCALPER_SCRIPT, ['futures', '--underlying', underlying], 30_000));
    const list = r.success ? r.data?.contracts : undefined;
    if (list?.length) { cache.set(underlying, { at: Date.now(), list }); failed.delete(underlying); return liveOnly(list); }
  } catch { /* fall through */ }
  failed.set(underlying, Date.now());
  return null;
}
