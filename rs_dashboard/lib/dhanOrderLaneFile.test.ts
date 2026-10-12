import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { book, LANE_LIMIT, LANE_WINDOW_MS, reserveOrderSlotAt, waitForSharedOrderSlot, withinLimit } from './dhanOrderLaneFile.ts';

const maxInWindow = (ts: number[]) => Math.max(...ts.map(b => ts.filter(x => b - LANE_WINDOW_MS < x && x <= b).length));

test('a burst is spread into windows of at most the limit; a free window books immediately', () => {
  const b: number[] = [];
  const times = Array.from({ length: 30 }, () => book(b, 0));
  assert.ok(maxInWindow(times) <= LANE_LIMIT);
  assert.deepStrictEqual(times.slice(0, LANE_LIMIT), Array(LANE_LIMIT).fill(0));
});

test('withinLimit counts duplicates and window edges exactly', () => {
  assert.ok(withinLimit([0, 0, 0], 3, 1000));
  assert.ok(!withinLimit([0, 0, 0, 0], 3, 1000));
  assert.ok(withinLimit([0, 0, 0, 1000], 3, 1000));          // 0 has left the window ending at 1000
});

test('an unusable lane directory fails OPEN: no wait, no throw', async () => {
  const prev = process.env.DHAN_ORDER_LANE_DIR;
  // A FILE where the directory should be: mkdir under it fails on every platform.
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), 'orderlane-bad-')), 'afile');
  writeFileSync(blocker, 'x');
  process.env.DHAN_ORDER_LANE_DIR = path.join(blocker, 'sub');
  try {
    assert.strictEqual(await reserveOrderSlotAt(), null);
    assert.strictEqual(await waitForSharedOrderSlot(), false);
  } finally {
    if (prev === undefined) delete process.env.DHAN_ORDER_LANE_DIR; else process.env.DHAN_ORDER_LANE_DIR = prev;
  }
});

// The point of the lane: Python strategies and Node routes must share ONE window.
test('Python processes and Node book on the same lane without exceeding the limit', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orderlane-'));
  const prev = process.env.DHAN_ORDER_LANE_DIR;
  process.env.DHAN_ORDER_LANE_DIR = dir;
  const root = path.resolve(process.cwd(), '..');
  const code = 'import sys; sys.path.insert(0, sys.argv[1]); from lib import dhan_order_lane as l; print(l.reserve_at_ms())';
  const py = () => new Promise<number>((resolve, reject) => {
    const p = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, root], { env: { ...process.env, DHAN_ORDER_LANE_DIR: dir } });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', () => (Number.isFinite(Number(out.trim())) ? resolve(Number(out.trim())) : reject(new Error(`bad python output: ${out}`))));
  });
  try {
    const jobs: Promise<number | null>[] = [];
    for (let i = 0; i < 12; i++) jobs.push(py());
    for (let i = 0; i < 12; i++) jobs.push(reserveOrderSlotAt());
    const times = (await Promise.all(jobs)) as number[];
    assert.ok(times.every(t => typeof t === 'number'));
    assert.ok(maxInWindow(times) <= LANE_LIMIT, `window held ${maxInWindow(times)} bookings`);
    assert.ok(Math.max(...times) - Math.min(...times) >= 1000, '24 orders at 8/s cannot fit in one window');
  } finally {
    if (prev === undefined) delete process.env.DHAN_ORDER_LANE_DIR; else process.env.DHAN_ORDER_LANE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
