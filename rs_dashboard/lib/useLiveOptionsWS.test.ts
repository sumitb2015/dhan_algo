import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { runChannel } from './useLiveOptionsWS.ts';

// The HTTP fallback poll of /api/options/live: 100 ms while it brings fresh quotes, 2 s while it brings none (bridge
// starting / stopped / dead). It used to poll every 100 ms forever when the bridge never came up.

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function setup(fresh: () => boolean) {
  const calls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { fetch: g.fetch, WebSocket: g.WebSocket, raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  g.fetch = async (url: string) => {
    calls.push(url);
    const strikes = fresh() ? { '25000': { strike: 25000 } } : {};
    return { json: async () => ({ success: true, status: { status: fresh() ? 'RUNNING' : 'STOPPED' }, quotes: { expiry: '2026-12-01', underlying: 'NIFTY', updated_at: new Date().toISOString(), strikes } }) };
  };
  g.WebSocket = class { static OPEN = 1; static CONNECTING = 0; close() {} };
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  const restore = () => { g.fetch = saved.fetch; g.WebSocket = saved.WebSocket; g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf; };
  const polls = () => calls.filter(u => !u.includes('checkPid')).length;
  return { polls, restore };
}

test('no quotes (bridge down): the fallback polls every 2 s, not every 100 ms', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { polls, restore } = setup(() => false);
  const stop = runChannel('dhan', '2026-12-01', 'NIFTY', () => {});
  try {
    await flush();
    assert.equal(polls(), 1, 'one poll at start');
    for (let i = 0; i < 100; i++) { mock.timers.tick(100); await flush(); }   // 10 s
    assert.ok(polls() >= 5 && polls() <= 7, `about one poll per 2 s over 10 s, got ${polls()}`);
  } finally { stop(); restore(); mock.timers.reset(); }
});

test('fresh quotes (bridge writing, WS unreachable): the fallback keeps polling every 100 ms', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { polls, restore } = setup(() => true);
  const stop = runChannel('dhan', '2026-12-01', 'NIFTY', () => {});
  try {
    await flush();
    for (let i = 0; i < 10; i++) { mock.timers.tick(100); await flush(); }    // 1 s
    assert.ok(polls() >= 10, `about 10 polls per second, got ${polls()}`);
  } finally { stop(); restore(); mock.timers.reset(); }
});

test('the bridge coming up speeds the poll back up; disposing stops it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let up = false;
  const { polls, restore } = setup(() => up);
  const stop = runChannel('dhan', '2026-12-01', 'NIFTY', () => {});
  try {
    await flush();
    for (let i = 0; i < 40; i++) { mock.timers.tick(100); await flush(); }    // 4 s slow
    const slow = polls();
    up = true;
    for (let i = 0; i < 40; i++) { mock.timers.tick(100); await flush(); }    // 4 s: <= 2 s to notice, then fast
    assert.ok(polls() - slow >= 15, `fast again once quotes are fresh, got ${polls() - slow}`);
    stop();
    const atStop = polls();
    for (let i = 0; i < 40; i++) { mock.timers.tick(100); await flush(); }
    assert.equal(polls(), atStop, 'no poll after dispose');
  } finally { stop(); restore(); mock.timers.reset(); }
});
