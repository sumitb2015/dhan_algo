// Cross-process half of the Dhan quote lane. Node twin of lib/dhan_quote_lane.py — same
// file, same format, keep the two in sync.
//
// Dhan's quote bucket (~1 req/s) is per ACCOUNT, but the options-screener collector is a
// separate Python process. dhanQuotePacer.ts serialises calls inside this Node process;
// this file makes those calls also book their slot in debug/dhan_quote_lane.json, so the
// collector and the dashboard never fire in the same second, and a 429 seen by either
// widens the gap for both.
//
// The lock is an exclusive-create lock file (portable to Windows), held only for the
// read-modify-write — never while waiting for the slot. A lock older than LOCK_STALE_MS
// belongs to a crashed holder and is taken over. Any fs failure degrades to "no shared
// pacing" (the in-process pacer still applies), never to a thrown error.

import path from 'path';
import { promises as fs } from 'fs';

const DEBUG_DIR = path.join(path.resolve(process.cwd(), '..'), 'debug');
const LANE_FILE = path.join(DEBUG_DIR, 'dhan_quote_lane.json');
const LOCK_FILE = path.join(DEBUG_DIR, 'dhan_quote_lane.lock');

export const LANE_BASE_GAP_MS = 1_100;
export const LANE_MAX_GAP_MS = 20_000;
const LOCK_STALE_MS = 3_000;
const LOCK_WAIT_MS = 2_000;

interface LaneFileState { next_at_ms: number; gap_ms: number }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquire(): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await fs.open(LOCK_FILE, 'wx');
      await h.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        const st = await fs.stat(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fs.unlink(LOCK_FILE); continue; }
      } catch { /* holder released it meanwhile */ }
    }
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

async function release(): Promise<void> {
  try { await fs.unlink(LOCK_FILE); } catch { /* already gone */ }
}

async function readState(): Promise<LaneFileState> {
  try {
    const s = JSON.parse(await fs.readFile(LANE_FILE, 'utf8')) as Partial<LaneFileState>;
    const gap = Number(s.gap_ms);
    return {
      next_at_ms: Number(s.next_at_ms) || 0,
      gap_ms: Number.isFinite(gap) ? Math.min(LANE_MAX_GAP_MS, Math.max(LANE_BASE_GAP_MS, gap)) : LANE_BASE_GAP_MS,
    };
  } catch {
    return { next_at_ms: 0, gap_ms: LANE_BASE_GAP_MS };
  }
}

async function writeState(s: LaneFileState): Promise<void> {
  const tmp = `${LANE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s));
  await fs.rename(tmp, LANE_FILE);
}

/** Book the next shared slot; resolves once that slot has arrived. */
export async function waitForSharedSlot(minGapMs = LANE_BASE_GAP_MS): Promise<void> {
  let waitMs = 0;
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    if (!(await acquire())) return;
    try {
      const s = await readState();
      const now = Date.now();
      const slot = Math.max(now, s.next_at_ms);
      s.next_at_ms = slot + Math.max(minGapMs, s.gap_ms);
      await writeState(s);
      waitMs = slot - now;
    } finally {
      await release();
    }
  } catch {
    return;
  }
  if (waitMs > 0) await sleep(waitMs);
}

/** Feed a call's outcome back: a 429 doubles the shared gap for every process. */
export async function reportSharedOutcome(rateLimited: boolean): Promise<void> {
  try {
    if (!(await acquire())) return;
    try {
      const s = await readState();
      if (rateLimited) {
        s.gap_ms = Math.min(LANE_MAX_GAP_MS, s.gap_ms * 2);
        s.next_at_ms = Math.max(s.next_at_ms, Date.now() + s.gap_ms);
      } else {
        s.gap_ms = Math.max(LANE_BASE_GAP_MS, Math.round(s.gap_ms * 0.7));
      }
      await writeState(s);
    } finally {
      await release();
    }
  } catch { /* shared pacing is best-effort */ }
}
