import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enterStraddle, exitStraddle, type EntryParams } from './tripleStraddleClient.ts';
import type { TsPosition } from './tripleStraddle.ts';

// A scripted broker: every fetch is routed here and recorded.
interface Sent { url: string; body?: Record<string, unknown> }
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; sent = []; });

type Orders = Record<string, { status: string; avg?: number; qty?: number }>;
function broker(opts: {
  /** security id -> how its next POST /fast-order behaves */
  post: Record<string, 'ok' | 'reject' | 'unknown'>;
  orders?: Orders;
  positions?: Record<string, unknown>[] | 'fail';
}) {
  let n = 0;
  const idFor: Record<string, string> = {};
  globalThis.fetch = (async (input: string, init?: { body?: string }) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    sent.push({ url, body });
    const json = (o: unknown, status = 200) => ({ ok: status < 400, status, json: async () => o }) as Response;
    if (url.startsWith('/api/scalper/fast-order')) {
      const mode = opts.post[String(body!.securityId)] ?? 'ok';
      if (mode === 'reject') return json({ success: false, error: 'RMS reject' }, 400);
      if (mode === 'unknown') return json({ success: false, error: 'timeout' }, 504);
      n += 1;
      const id = `O${n}`;
      idFor[`${body!.securityId}|${body!.side}`] = id;
      return json({ success: true, order_id: id });
    }
    if (url.startsWith('/api/scalper/orders?orderId=')) {
      const id = decodeURIComponent(url.split('=')[1]);
      const o = opts.orders?.[id] ?? { status: 'TRADED', avg: 100, qty: 65 };
      return json({ success: true, data: { orderStatus: o.status, filledQty: o.status === 'TRADED' ? (o.qty ?? 65) : 0, averageTradedPrice: o.avg ?? 0, reason: o.status === 'REJECTED' ? 'margin' : '' } });
    }
    if (url.startsWith('/api/scalper/positions')) {
      if (opts.positions === 'fail') return json({ success: false }, 500);
      return json({ success: true, data: opts.positions ?? [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}
const orderPosts = () => sent.filter((s) => s.url.startsWith('/api/scalper/fast-order'));

const params = (over: Partial<EntryParams> = {}): EntryParams => ({
  slot: 'center', underlying: 'NIFTY', expiry: '2026-10-13', strike: 25000, side: 'S', lots: 1, lotSize: 65,
  product: 'INTRADAY', mode: 'REAL', ids: { ceId: 'CE1', peId: 'PE1' }, prices: { CE: 100, PE: 80 },
  risk: { armed: true, slPct: 30 }, onIntent: async () => true, ...over,
});

function openPos(over: Partial<TsPosition> = {}): TsPosition {
  return {
    id: 'p1', slot: 'center', mode: 'REAL', side: 'S', underlying: 'NIFTY', expiry: '2026-10-13', strike: 25000,
    lots: 1, lotSize: 65, product: 'INTRADAY', status: 'OPEN', openedAt: Date.now() - 600_000,
    risk: { armed: true }, legs: [
      { option: 'CE', qty: 65, entry: 100, securityId: 'CE1', orderIds: [] },
      { option: 'PE', qty: 65, entry: 80, securityId: 'PE1', orderIds: [] },
    ], ...over,
  };
}

test('SIM entry fills at the quote and never touches the broker', async () => {
  broker({ post: {} });
  const out = await enterStraddle(params({ mode: 'SIM' }));
  assert.equal(out.ok, true);
  assert.equal(sent.length, 0);
  assert.deepEqual(out.position!.legs.map((l) => l.entry), [100, 80]);
});

test('REAL entry places NO order if the intent record cannot be saved', async () => {
  broker({ post: {} });
  const out = await enterStraddle(params({ onIntent: async () => false }));
  assert.equal(out.ok, false);
  assert.equal(out.position, null);
  assert.equal(orderPosts().length, 0);
});

test('REAL entry checkpoints the intent BEFORE sending any order', async () => {
  broker({ post: {} });
  let ordersAtIntent = -1;
  await enterStraddle(params({ onIntent: async (p) => { ordersAtIntent = orderPosts().length; assert.ok(p.legs.every((l) => l.unconfirmed)); return true; } }));
  assert.equal(ordersAtIntent, 0);
});

test('REAL entry: both fill, entry uses the order-book average', async () => {
  broker({ post: {}, orders: { O1: { status: 'TRADED', avg: 101 }, O2: { status: 'TRADED', avg: 79 } } });
  const out = await enterStraddle(params());
  assert.equal(out.ok, true);
  assert.equal(out.position!.status, 'OPEN');
  assert.deepEqual(out.position!.legs.map((l) => l.entry), [101, 79]);
});

test('REAL entry: PE rejected, CE filled -> CE reversed and CONFIRMED, position CLOSED', async () => {
  broker({ post: { PE1: 'reject' } });
  const out = await enterStraddle(params());
  assert.equal(out.ok, false);
  assert.equal(out.position!.status, 'CLOSED');
  assert.ok(out.position!.legs.every((l) => l.closed));
  const posts = orderPosts();
  assert.equal(posts.length, 3);                                  // CE in, PE in, CE reverse
  assert.equal(posts[2].body!.side, 'BUY');                       // short entry is reversed by a BUY
  assert.equal(posts[2].body!.securityId, 'CE1');
});

test('REAL entry: a rejected reversal leaves the leg OPEN on the ledger, never silently flat', async () => {
  broker({ post: { PE1: 'reject' }, orders: { O1: { status: 'TRADED', avg: 100 }, O2: { status: 'REJECTED' } } });
  // O1 = CE entry (fills), O2 = the reversal order (rejected after acceptance)
  const out = await enterStraddle(params());
  assert.equal(out.position!.status, 'OPEN');
  const ce = out.position!.legs[0];
  assert.equal(ce.closed, undefined);
});

test('REAL entry: PE order status unknown (504) -> leg unconfirmed at the live quote, not entry 0', async () => {
  broker({ post: { PE1: 'unknown' } });
  const out = await enterStraddle(params());
  const pe = out.position!.legs[1];
  assert.equal(pe.unconfirmed, true);
  assert.equal(pe.entry, 80);
  assert.equal(out.position!.status, 'OPEN');
});

test('exit: SIM closes at live prices, no broker', async () => {
  broker({ post: {} });
  const out = await exitStraddle(openPos({ mode: 'SIM' }), { CE: 90, PE: 70 }, 'MANUAL');
  assert.equal(out.position.status, 'CLOSED');
  assert.equal(sent.length, 0);
});

test('exit: closes with a BUY of own qty and records the confirmed fill', async () => {
  broker({ post: {}, positions: [
    { securityId: 'CE1', productType: 'INTRADAY', netQty: -65 }, { securityId: 'PE1', productType: 'INTRADAY', netQty: -65 },
  ], orders: { O1: { status: 'TRADED', avg: 90 }, O2: { status: 'TRADED', avg: 70 } } });
  const out = await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'SL');
  assert.equal(out.position.status, 'CLOSED');
  assert.equal(out.position.exitReason, 'SL');
  assert.ok(orderPosts().every((o) => o.body!.side === 'BUY' && o.body!.quantity === 65));
  assert.deepEqual(out.position.legs.map((l) => l.exit), [90, 70]);
});

test('exit: clamps to what the broker still shows', async () => {
  broker({ post: {}, positions: [
    { securityId: 'CE1', productType: 'INTRADAY', netQty: -30 }, { securityId: 'PE1', productType: 'INTRADAY', netQty: -65 },
  ] });
  await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'MANUAL');
  const ce = orderPosts().find((o) => o.body!.securityId === 'CE1')!;
  assert.equal(ce.body!.quantity, 30);
});

test('exit: NO matching broker row after the grace period -> no order, leg stays open', async () => {
  broker({ post: {}, positions: [] });
  const out = await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'MANUAL');
  assert.equal(orderPosts().length, 0);
  assert.equal(out.position.status, 'OPEN');
  assert.ok(out.notes.some((n) => /not visible/.test(n)));
});

test('exit: right after entry the book may lag, so own qty is still sent', async () => {
  broker({ post: {}, positions: [] });
  await exitStraddle(openPos({ openedAt: Date.now() - 2000 }), { CE: 95, PE: 75 }, 'SL');
  assert.equal(orderPosts().length, 2);
});

test('exit: a failed positions call fails OPEN (a stop must still fire)', async () => {
  broker({ post: {}, positions: 'fail' });
  const out = await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'SL');
  assert.equal(orderPosts().length, 2);
  assert.equal(out.position.status, 'CLOSED');
});

test('exit: a row for the OTHER product is not mistaken for this leg', async () => {
  broker({ post: {}, positions: [
    { securityId: 'CE1', productType: 'MARGIN', netQty: -65 }, { securityId: 'PE1', productType: 'MARGIN', netQty: -65 },
  ] });
  const out = await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'MANUAL');
  assert.equal(orderPosts().length, 0);
  assert.equal(out.position.status, 'OPEN');
});

test('exit: explicitly flat at the broker -> closed without sending an order', async () => {
  broker({ post: {}, positions: [
    { securityId: 'CE1', productType: 'INTRADAY', netQty: 0, positionType: 'CLOSED' },
    { securityId: 'PE1', productType: 'INTRADAY', netQty: 0, positionType: 'CLOSED' },
  ] });
  const out = await exitStraddle(openPos(), { CE: 95, PE: 75 }, 'MANUAL');
  assert.equal(orderPosts().length, 0);
  assert.equal(out.position.status, 'CLOSED');
});

test('exit: a still-unsettled previous exit order is NOT re-sent', async () => {
  broker({ post: {}, positions: [{ securityId: 'CE1', productType: 'INTRADAY', netQty: -65 }, { securityId: 'PE1', productType: 'INTRADAY', netQty: -65 }],
    orders: { OLD: { status: 'TRANSIT' } } });
  const pos = openPos();
  pos.legs[0] = { ...pos.legs[0], pendingExit: { orderId: 'OLD', at: Date.now() } };
  pos.legs[1] = { ...pos.legs[1], closed: true, exit: 70 };
  const out = await exitStraddle(pos, { CE: 95 }, 'SL');
  assert.equal(orderPosts().length, 0);
  assert.equal(out.position.status, 'OPEN');
});

test('exit: a pending exit that turned out FILLED is adopted, not re-sent', async () => {
  broker({ post: {}, orders: { OLD: { status: 'TRADED', avg: 88 } } });
  const pos = openPos();
  pos.legs[0] = { ...pos.legs[0], pendingExit: { orderId: 'OLD', at: Date.now() } };
  pos.legs[1] = { ...pos.legs[1], closed: true, exit: 70 };
  const out = await exitStraddle(pos, { CE: 95 }, 'MANUAL');
  assert.equal(orderPosts().length, 0);
  assert.equal(out.position.status, 'CLOSED');
  assert.equal(out.position.legs[0].exit, 88);
});

test('exit: unconfirmed entry legs are never auto-closed', async () => {
  broker({ post: {} });
  const pos = openPos();
  pos.legs[1] = { ...pos.legs[1], unconfirmed: true };
  await exitStraddle(pos, { CE: 95, PE: 75 }, 'MANUAL');
  assert.ok(orderPosts().every((o) => o.body!.securityId !== 'PE1'));
});
