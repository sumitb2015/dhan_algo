import test from 'node:test';
import assert from 'node:assert/strict';
import { claimLeader, classifyOrderReply, exitMarks, INFLIGHT_TTL_MS, releaseLeader, type KV } from './liveGuards.ts';
import { buildLiveCtx } from './liveCtx.ts';
import { recordTick } from '../bearishStrikes.ts';

const kv = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

test('classifyOrderReply: only an explicit rejection is "failed"', () => {
  assert.equal(classifyOrderReply(200, { success: true, order_id: '1' }).outcome, 'ok');
  assert.equal(classifyOrderReply(400, { success: false, error: 'no margin' }).outcome, 'failed');
  assert.equal(classifyOrderReply(504, { success: false }).outcome, 'unknown');
  assert.equal(classifyOrderReply(200, { success: false, unknown: true }).outcome, 'unknown');
  assert.equal(classifyOrderReply(null, null).outcome, 'unknown');
  assert.equal(classifyOrderReply(500, null).outcome, 'unknown');
});

test('exitMarks: shared across instances (tabs), inflight expires, unknown persists', () => {
  const store = kv();
  const a = exitMarks(store, 's');
  const b = exitMarks(store, 's');
  a.set('p1', 'inflight', 1000);
  assert.equal(b.get('p1', 2000)?.s, 'inflight');
  assert.equal(b.get('p1', 1000 + INFLIGHT_TTL_MS + 1), null);
  a.set('p2', 'unknown', 1000);
  assert.equal(b.get('p2', 1000 + 3600_000)?.s, 'unknown');
  assert.equal(exitMarks(store, 'other').get('p2', 2000), null);
});

test('claimLeader: one tab per strategy, stolen only when stale, released on unmount', () => {
  const store = kv();
  assert.equal(claimLeader(store, 's', 'tabA', 0), true);
  assert.equal(claimLeader(store, 's', 'tabB', 1000), false);
  assert.equal(claimLeader(store, 'other', 'tabB', 1000), true);
  assert.equal(claimLeader(store, 's', 'tabB', 7000), true);
  releaseLeader(store, 's', 'tabB');
  assert.equal(claimLeader(store, 's', 'tabA', 7100), true);
});

test('buildLiveCtx: closed bars only, decision at the minute start, window + held contracts', () => {
  // 2026-10-14 10:00:30 IST
  const nowMs = Date.UTC(2026, 9, 14, 10, 0, 30) - 5.5 * 3600_000;
  const bar = (t: string, c: number) => ({ t: `2026-10-14 ${t}:00`, o: c, h: c, l: c, c, v: 5 });
  const live = new Map();
  recordTick(live, 101, Date.UTC(2026, 9, 14, 10, 0, 10)); // forming minute: must be excluded
  const spotLive = new Map();
  recordTick(spotLive, 25010, Date.UTC(2026, 9, 14, 9, 59, 30));
  const strikes: Record<string, { ce?: { ltp: number }; pe?: { ltp: number } }> = {};
  for (let s = 24800; s <= 25200; s += 50) strikes[String(s)] = { ce: { ltp: 100 }, pe: { ltp: 90 } };
  const ctx = buildLiveCtx({
    nowMs, underlying: 'NIFTY', expiry: '2026-10-20', lotSize: 65, spot: 25010, strikes, strikeWindow: 1,
    open: [{ id: 'x', key: '25200CE', option: 'CE', side: 'BUY', entryPrice: 50 }],
    apiBars: (k) => (k === '25000CE' ? [{ ...bar('09:58', 99), t: '2026-10-13 15:29:00' }, bar('09:58', 99), bar('09:59', 100)] : []),
    liveMinutes: (k) => (k === '25000CE' ? live : undefined),
    spotCloses: [['09:58', 25000]],
    spotLive,
  })!;
  assert.equal(ctx.hm, '10:00');
  assert.equal(ctx.atm, 25000);
  assert.deepEqual(Object.keys(ctx.contracts).sort(), ['24950CE', '24950PE', '25000CE', '25000PE', '25050CE', '25050PE', '25200CE'].sort());
  const c = ctx.contracts['25000CE'];
  assert.deepEqual(c.bars1m.map((b) => b.t.slice(0, 16)), ['2026-10-13 15:29', '2026-10-14 09:58', '2026-10-14 09:59']);
  assert.equal(c.warmupBars, 1);
  assert.deepEqual(ctx.spotBars1m.map((b) => [b.t.slice(11, 16), b.c]), [['09:58', 25000], ['09:59', 25010]]);
});
