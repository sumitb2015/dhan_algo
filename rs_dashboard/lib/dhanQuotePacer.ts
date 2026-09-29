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
//
// Across processes: every call also books its slot in the shared lane file
// (dhanQuoteLaneFile.ts, twin of lib/dhan_quote_lane.py) so it can't collide with the
// options-screener collector, and reports 429s there so the collector backs off too.

import { reportSharedOutcome, waitForSharedSlot } from './dhanQuoteLaneFile.ts';

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

/** Off in unit tests so they neither wait on nor disturb a running collector. */
let sharedLane = true;
export function setSharedQuoteLane(enabled: boolean): void { sharedLane = enabled; }

export function pacedQuoteCall<T>(fn: () => Promise<T>): Promise<T> {
  if (lane.pending >= MAX_PENDING) {
    return Promise.reject(Object.assign(new Error('Dhan quote lane busy'), { busy: true }) as QuoteLaneError);
  }
  lane.pending++;
  const run = lane.chain.then(async () => {
    try {
      if (sharedLane) await waitForSharedSlot();
      const result = await fn();
      lane.gapMs = Math.max(BASE_GAP_MS, Math.round(lane.gapMs * 0.7));
      if (sharedLane) void reportSharedOutcome(false);
      return result;
    } catch (err) {
      if ((err as QuoteLaneError | null)?.status === 429) {
        lane.gapMs = Math.min(MAX_GAP_MS, lane.gapMs * 2);
        if (sharedLane) void reportSharedOutcome(true);
      }
      throw err;
    } finally {
      lane.pending--;
    }
  });
  const gap = () => new Promise<void>(resolve => setTimeout(resolve, lane.gapMs));
  lane.chain = run.then(gap, gap);
  return run;
}
