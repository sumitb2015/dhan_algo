// Cross-process half of the Dhan ORDER lane. Node twin of lib/dhan_order_lane.py - same file,
// same format, same algorithm: keep the two in sync.
//
// Dhan allows about 10 order requests/second per ACCOUNT, but order callers are separate
// processes (every running strategy via DhanHelper, and these dashboard routes). One shared sliding
// window in debug/dhan_order_lane.json keeps the whole account under the limit.
//
// FAIL OPEN and BOUNDED (real-money path): any fs problem returns `false` ("lane unavailable") and the
// caller falls back to its in-process window; an order is never blocked or dropped by the lane, and a
// slot is waited for at most MAX_WAIT_MS. The lock is held only for the read-modify-write.
// DHAN_ORDER_LANE_DIR overrides the directory (tests).

import path from 'path';
import { promises as fs } from 'fs';

const dir = () => process.env.DHAN_ORDER_LANE_DIR || path.join(path.resolve(process.cwd(), '..'), 'debug');
const laneFile = () => path.join(dir(), 'dhan_order_lane.json');
const lockFile = () => path.join(dir(), 'dhan_order_lane.lock');

export const LANE_LIMIT = 8;           // below Dhan's 10/s, for headroom
export const LANE_WINDOW_MS = 1_000;
export const LANE_MAX_WAIT_MS = 2_000;
const LOCK_STALE_MS = 3_000;
const LOCK_WAIT_MS = 1_000;
const MAX_BOOKINGS = 64;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function acquire(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await fs.open(lockFile(), 'wx');
      await h.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        const st = await fs.stat(lockFile());
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fs.unlink(lockFile()); continue; }
      } catch { /* released meanwhile */ }
    }
    if (Date.now() > deadline) return false;
    await sleep(5);
  }
}

const release = async () => { try { await fs.unlink(lockFile()); } catch { /* already gone */ } };

async function read(): Promise<number[]> {
  try {
    const raw = (JSON.parse(await fs.readFile(laneFile(), 'utf8')) as { bookings?: unknown }).bookings;
    return Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  } catch { return []; }
}

async function write(bookings: number[]): Promise<void> {
  const tmp = `${laneFile()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ bookings: bookings.slice(-MAX_BOOKINGS) }));
  await fs.rename(tmp, laneFile());
}

/** First index in sorted `ts` whose value is > x. */
function upperBound(ts: number[], x: number): number {
  let lo = 0, hi = ts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** True when no booking's trailing window (t - window, t] holds more than `limit` bookings. */
export function withinLimit(bookings: number[], limit: number, windowMs: number): boolean {
  const ts = [...bookings].sort((a, b) => a - b);
  return ts.every((b, i) => (i + 1) - upperBound(ts, b - windowMs) <= limit);
}

/**
 * Pure: earliest time >= now at which one more send keeps EVERY window within `limit`.
 * Mutates `bookings` (drops expired, appends the new one).
 */
export function book(bookings: number[], now: number, limit = LANE_LIMIT, windowMs = LANE_WINDOW_MS): number {
  const live = bookings.filter(t => t > now - windowMs);
  bookings.length = 0;
  bookings.push(...live);
  let t = now;
  while (!withinLimit([...bookings, t], limit, windowMs)) {
    t = Math.min(...bookings.filter(b => b > t - windowMs)) + windowMs;
  }
  bookings.push(t);
  bookings.sort((a, b) => a - b);
  return t;
}

/** Book a slot and return its absolute time (ms), or null when the lane is unavailable. */
export async function reserveOrderSlotAt(): Promise<number | null> {
  try {
    await fs.mkdir(dir(), { recursive: true });
    if (!(await acquire())) return null;
    try {
      const bookings = await read();
      const t = book(bookings, Date.now());
      await write(bookings);
      return t;
    } finally {
      await release();
    }
  } catch {
    return null;
  }
}

/** Book a shared slot and wait for it (at most LANE_MAX_WAIT_MS). Resolves true when the lane was used. */
export async function waitForSharedOrderSlot(): Promise<boolean> {
  const t = await reserveOrderSlotAt();
  if (t === null) return false;
  const wait = Math.min(t - Date.now(), LANE_MAX_WAIT_MS);
  if (wait > 0) await sleep(wait);
  return true;
}
