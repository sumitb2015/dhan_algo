// Account-wide pacer for Dhan's market-quote bucket (POST /marketfeed/quote|ohlc|ltp,
// about 1 request/second per ACCOUNT, not per caller).
//
// Same shape as the margin lane in ultimateScannerDhan.ts: the gap is applied AFTER a
// call (it delays the NEXT caller, never the one that already has its answer), grows on
// a 429 and relaxes toward the baseline on success. Growth is driven centrally by a
// `.status === 429` tag on the thrown error, so any caller going through this lane
// backs the others off.
//
// Unlike the margin lane this one is used at ORDER time (bid/ask check), where waiting
// behind a long queue is worse than skipping the check: the queue is capped, and a call
// that would wait behind it is rejected immediately with `busy: true`.

const BASE_GAP_MS = 1_100;
const MAX_GAP_MS = 20_000;
/** One running + this many waiting; anything beyond is rejected fast. */
const MAX_PENDING = 2;

// State lives on globalThis: Next can give each route bundle its own copy of a module, and the
// whole point of this lane is that every caller shares ONE account-wide queue.
interface LaneState { chain: Promise<unknown>; gapMs: number; pending: number }
const g = globalThis as { __dhanQuoteLane?: LaneState };
const lane: LaneState = (g.__dhanQuoteLane ??= { chain: Promise.resolve(), gapMs: BASE_GAP_MS, pending: 0 });

export interface QuoteLaneError extends Error { status?: number; busy?: boolean }

export function pacedQuoteCall<T>(fn: () => Promise<T>): Promise<T> {
  if (lane.pending >= MAX_PENDING) {
    return Promise.reject(Object.assign(new Error('Dhan quote lane busy'), { busy: true }) as QuoteLaneError);
  }
  lane.pending++;
  const run = lane.chain.then(async () => {
    try {
      const result = await fn();
      lane.gapMs = Math.max(BASE_GAP_MS, Math.round(lane.gapMs * 0.7));
      return result;
    } catch (err) {
      if ((err as QuoteLaneError | null)?.status === 429) lane.gapMs = Math.min(MAX_GAP_MS, lane.gapMs * 2);
      throw err;
    } finally {
      lane.pending--;
    }
  });
  const gap = () => new Promise<void>(resolve => setTimeout(resolve, lane.gapMs));
  lane.chain = run.then(gap, gap);
  return run;
}
