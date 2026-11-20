import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGbStateFileForTests } from './gearboxFile.ts';
import { closeRowNow, gbClientOp, gbState, gbTrade, parseTrade, pickTarget, type GbDeps, type TradeReq } from './gearboxCore.ts';
import { emptyLedger, type GbLedger, type GbRow } from './gearboxLedger.ts';
import type { FnoRow } from './pnfContracts.ts';
import type { Target } from './pnfTarget.ts';

// Gearbox server core with every broker / network call stubbed. The ledger lives in a temp dir, never debug/.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gearbox-'));
const FILE = path.join(dir, 'gearbox_state.json');
setGbStateFileForTests(FILE);

const TODAY = '2026-11-20';
const NEXT = '2026-12-16';
const NOW = Date.parse('2026-11-20T09:30:00Z'); // 15:00 IST, a Friday MCX session
const U = 'CRUDEOILM' as const;

const fnoRow = (expiry: string, strike: number, optType: 'CE' | 'PE' | null, id: string): FnoRow => ({
  exch: 'MCX', segment: 'MCX_COMM', securityId: id, instrument: optType ? 'OPTFUT' : 'FUTCOM', underlying: U,
  displayName: `${U} ${expiry} ${strike} ${optType ?? 'FUT'}`, expiry, strike: optType ? strike : -0.01, optType, lot: 1,
});
const FNO: FnoRow[] = [fnoRow('2026-12-17', 0, null, 'F1')];
for (const e of [TODAY, NEXT]) for (const k of [5900, 5950, 6000, 6050, 6100]) for (const s of ['CE', 'PE'] as const) FNO.push(fnoRow(e, k, s, `${e}-${k}-${s}`));

type PlaceCall = { order: Record<string, unknown>; scope: string; tag: string; fileAtSend: GbLedger };
const placed = (orderId = 'O1') => ({ status: 200, body: { success: true, outcome: 'placed', legs: [{ status: 'placed', orderId }] } });

function stubs(over: Partial<GbDeps> & { orders?: (string | null)[] } = {}) {
  const calls: PlaceCall[] = [];
  let reads = 0;
  const orders = over.orders ?? ['TRADED'];
  const deps: GbDeps = {
    now: () => NOW,
    price: () => ({ ltp: 6010, ageMs: 500 }),
    optionPrice: () => ({ ltp: 120, ageMs: 500 }),
    place: async (order, scope, tag) => {
      calls.push({ order: order as unknown as Record<string, unknown>, scope, tag, fileAtSend: JSON.parse(fs.readFileSync(FILE, 'utf8')) });
      return placed();
    },
    readOrder: async () => {
      const s = orders[Math.min(reads++, orders.length - 1)];
      return s === null ? null : { orderStatus: s, filledQty: s === 'TRADED' ? 1 : 0, averageTradedPrice: s === 'TRADED' ? 123.5 : 0 };
    },
    sleep: async () => undefined,
    lotUnits: async () => 1,
    fno: FNO,
    ...over,
  };
  return { deps, calls, reads: () => reads };
}

const write = (l: Partial<GbLedger>) => fs.writeFileSync(FILE, JSON.stringify({ ...emptyLedger(), ...l }));
const read = (): GbLedger => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const real = (extra: Partial<GbLedger> = {}) => write({ mode: 'REAL', ...extra });
const opt = (strike: number, side: 'CE' | 'PE', expiry = NEXT): Target => ({ kind: 'options', symbol: U, name: U, expiry, strike, side });
const openRow = (extra: Partial<GbRow> = {}): GbRow => ({
  id: 'r1', mode: 'SIM', broker: 'dhan', underlying: U, dir: 'LONG', leg: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
  target: opt(6000, 'CE'), lots: 1, units: 1, unitsPerLot: 10, entry: 100, entryDecision: 6000, entryAt: NOW - 60_000, day: TODAY,
  status: 'open', ...extra,
});
const req = (action: TradeReq['action'], dirn?: 'LONG' | 'SHORT'): TradeReq => ({ action, ...(dirn ? { dir: dirn } : {}), underlying: U, decisionPrice: 6010, reason: 'click' });

test('parseTrade validates the action, direction, underlying and price', () => {
  assert.equal(typeof parseTrade({ action: 'buy', underlying: U, decisionPrice: 1 }), 'string');
  assert.equal(typeof parseTrade({ action: 'open', underlying: U, decisionPrice: 1 }), 'string');
  assert.equal(typeof parseTrade({ action: 'open', dir: 'LONG', underlying: 'NIFTY', decisionPrice: 1 }), 'string');
  assert.equal(typeof parseTrade({ action: 'exit', underlying: U, decisionPrice: '6000' }), 'string');
  const ok = parseTrade({ action: 'open', dir: 'SHORT', underlying: U, decisionPrice: 6000, strike: 1, lots: 9 });
  assert.ok(typeof ok !== 'string' && ok.dir === 'SHORT' && !('lots' in ok) && !('strike' in ok));
});

test('nearest skips today\'s expiry; +N is OTM (CE up, PE down)', () => {
  const ce = pickTarget(U, { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' }, 6010, TODAY, FNO);
  assert.deepEqual(ce, opt(6000, 'CE'));
  assert.equal((pickTarget(U, { action: 'BUY', opt: 'CE', offset: 1, expiry: 'nearest' }, 6010, TODAY, FNO) as Target).strike, 6050);
  assert.equal((pickTarget(U, { action: 'BUY', opt: 'PE', offset: 1, expiry: 'nearest' }, 6010, TODAY, FNO) as Target).strike, 5950);
  assert.equal((pickTarget(U, { action: 'BUY', opt: 'CE', offset: -2, expiry: 'nearest' }, 6010, TODAY, FNO) as Target).strike, 5900);
  assert.equal(typeof pickTarget(U, { action: 'BUY', opt: 'CE', offset: 3, expiry: 'nearest' }, 6010, TODAY, FNO), 'string');
  assert.equal(typeof pickTarget(U, { action: 'BUY', opt: 'CE', offset: 0, expiry: TODAY }, 6010, TODAY, FNO), 'string');
});

test('refuses an open on a stale future price, nothing sent', async () => {
  real();
  const s = stubs({ price: () => ({ ltp: 6010, ageMs: 11_000 }) });
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 409);
  assert.equal(s.calls.length, 0);
  const none = stubs({ price: () => null });
  assert.equal((await gbTrade(req('open', 'LONG'), none.deps)).status, 409);
  assert.equal(read().rows.length, 0);
});

test('SIM open books the option LTP, decision price kept apart', async () => {
  write({});
  const s = stubs();
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 200);
  const row = read().rows[0];
  assert.equal(row.status, 'open');
  assert.equal(row.entry, 120);
  assert.equal(row.entryDecision, 6010);
  assert.deepEqual(row.target, opt(6000, 'CE'));
  assert.equal(row.unitsPerLot, 10);
  assert.equal(s.calls.length, 0);
});

test('REAL open writes the sending row before placing, sends 1 lot INTRADAY tagged gbx, books the traded price', async () => {
  real();
  const s = stubs({ orders: [null, 'PENDING', 'TRADED'] });
  const r = await gbTrade(req('open', 'SHORT'), s.deps);
  assert.equal(r.status, 200);
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.fileAtSend.rows.length, 1);
  assert.equal(c.fileAtSend.rows[0].status, 'sending');
  assert.equal(c.tag, 'gbx');
  assert.equal(c.scope, 'pnf');
  assert.equal(c.order.lots, 1);
  assert.equal(c.order.product, 'INTRADAY');
  assert.equal(c.order.action, 'BUY');
  assert.deepEqual(c.order.target, opt(6000, 'PE'));
  assert.equal(s.reads(), 3);
  const row = read().rows[0];
  assert.equal(row.status, 'open');
  assert.equal(row.entry, 123.5);
  assert.equal(row.units, 1);
  assert.equal(row.entryOrderId, 'O1');
});

test('REAL open with no fill confirmed keeps the option LTP and logs it (10 polls max)', async () => {
  real();
  const s = stubs({ orders: ['PENDING'] });
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 200);
  assert.equal(s.reads(), 10);
  const l = read();
  assert.equal(l.rows[0].status, 'open');
  assert.equal(l.rows[0].entry, 120);
  assert.ok(l.log.some(x => x.level === 'warn' && /not confirmed/.test(x.msg)));
});

test('REAL open rejected after placing marks the row failed', async () => {
  real();
  const s = stubs({ orders: ['REJECTED'] });
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 502);
  assert.equal(read().rows[0].status, 'failed');
});

test('a second open while the first is sending is refused', async () => {
  real();
  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  const s = stubs();
  const slow = { ...s.deps, place: async (o: Parameters<GbDeps['place']>[0], sc: 'pnf', t: 'gbx') => { await gate; return s.deps.place(o, sc, t); } };
  const a = gbTrade(req('open', 'LONG'), slow);
  const b = gbTrade(req('open', 'LONG'), slow);
  await new Promise(r => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(s.calls.length, 1);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 409);
});

test('an unknown outcome is never resent', async () => {
  real();
  const s = stubs({ place: async () => ({ status: 504, body: { success: false, outcome: 'unknown', error: 'timeout' } }) });
  let n = 0;
  const counting = { ...s.deps, place: async (o: Parameters<GbDeps['place']>[0], sc: 'pnf', t: 'gbx') => { n++; return s.deps.place(o, sc, t); } };
  const r = await gbTrade(req('open', 'LONG'), counting);
  assert.equal(r.status, 504);
  assert.equal(read().rows[0].status, 'unknown');
  const x = await gbTrade(req('exit'), counting);
  assert.equal(x.status, 409);
  assert.match(String(x.body.error), /resolve it first/);
  assert.equal((await gbTrade(req('open', 'LONG'), counting)).status, 409);
  assert.equal(n, 1);
});

test('a throwing send is UNKNOWN, not refused', async () => {
  real();
  const s = stubs({ place: async () => { throw new Error('socket hang up'); } });
  assert.equal((await gbTrade(req('open', 'LONG'), s.deps)).status, 504);
  assert.equal(read().rows[0].status, 'unknown');
});

test('exit sends exitOwn with the row\'s own units', async () => {
  real({ rows: [openRow({ mode: 'REAL', units: 1, leg: { action: 'SELL', opt: 'PE', offset: 0, expiry: 'nearest' }, dir: 'LONG', target: opt(6000, 'PE') })] });
  const s = stubs();
  const r = await gbTrade(req('exit'), s.deps);
  assert.equal(r.status, 200);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].order.exitOwn, { side: 'BUY', units: [1], product: 'INTRADAY' });
  assert.equal(s.calls[0].fileAtSend.rows[0].status, 'closing');
  const row = read().rows[0];
  assert.equal(row.status, 'closed');
  assert.equal(row.exit, 123.5);
});

test('reverse opens the new leg only after the exit is TRADED', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  const s = stubs({ orders: ['TRADED'] });
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 200);
  assert.equal(s.calls.length, 2);
  assert.ok(s.calls[0].order.exitOwn);
  assert.equal((s.calls[1].order.target as Target).side, 'PE');
  const rows = read().rows;
  assert.equal(rows[0].status, 'closed');
  assert.equal(rows[1].status, 'open');
  assert.equal(rows[1].dir, 'SHORT');
});

test('reverse stops on a REJECTED exit and keeps the row open', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  const s = stubs({ orders: ['REJECTED'] });
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 502);
  assert.equal(s.calls.length, 1);
  const rows = read().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
});

test('reverse with no exit fill in 10 polls goes UNKNOWN and opens nothing', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  const s = stubs({ orders: ['PENDING'] });
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 504);
  assert.equal(s.calls.length, 1);
  assert.equal(s.reads(), 10);
  const rows = read().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'unknown');
});

test('reverse refused before the exit when the entry would be refused', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  const s = stubs({ price: () => ({ ltp: 6010, ageMs: 20_000 }) });
  assert.equal((await gbTrade(req('reverse', 'SHORT'), s.deps)).status, 409);
  assert.equal(s.calls.length, 0);
  assert.equal(read().rows[0].status, 'open');
});

test('the daily limit blocks entries, not exits', async () => {
  const done = openRow({ id: 'r0', status: 'closed', exit: 90 });
  write({ config: { ...emptyLedger().config, maxTrades: 2 }, rows: [done, openRow()] });
  const s = stubs();
  const rev = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(rev.status, 409);
  assert.match(String(rev.body.error), /Daily limit/);
  const x = await gbTrade(req('exit'), s.deps);
  assert.equal(x.status, 200);
  assert.equal(read().rows[1].status, 'closed');
  assert.equal((await gbTrade(req('open', 'LONG'), s.deps)).status, 409);
});

test('the same direction while held is refused', async () => {
  write({ rows: [openRow()] });
  const r = await gbTrade(req('open', 'LONG'), stubs().deps);
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /Already LONG/);
});

test('REAL with a broker other than dhan is refused; a stale page mode is refused', async () => {
  real();
  const s = stubs();
  assert.equal((await gbTrade({ ...req('open', 'LONG'), broker: 'kotak' }, s.deps)).status, 400);
  assert.equal((await gbTrade({ ...req('open', 'LONG'), mode: 'SIM' }, s.deps)).status, 409);
  assert.equal(s.calls.length, 0);
  assert.equal(read().rows.length, 0);
});

test('SIM close with a stale option price uses lastLtp and logs it', async () => {
  const row = openRow({ lastLtp: 111 });
  const l: GbLedger = { ...emptyLedger(), rows: [row] };
  const s = stubs({ optionPrice: () => ({ ltp: 999, ageMs: 60_000 }) });
  const out = await closeRowNow(l, row, 'square-off', s.deps);
  assert.ok(out.ok);
  assert.equal(out.ledger.rows[0].exit, 111);
  assert.ok(out.ledger.log.some(x => /last good price/.test(x.msg)));
});

test('a SENDING / CLOSING row left by a restart becomes UNKNOWN at the next op and is never sent', async () => {
  real({ rows: [openRow({ mode: 'REAL', status: 'sending' })] });
  const s = stubs();
  const x = await gbTrade(req('exit'), s.deps);
  assert.equal(x.status, 409);
  assert.match(String(x.body.error), /UNKNOWN - resolve it first/);
  assert.equal(s.calls.length, 0);
  const row = read().rows[0];
  assert.equal(row.status, 'unknown');
  assert.equal(row.note, 'orphaned by a restart — check the order book');
  assert.ok(read().log.some(e => /no order in flight/.test(e.msg)));
  // a client op recovers it too, and then the row can be resolved
  real({ rows: [openRow({ mode: 'REAL', status: 'closing' })] });
  const r = await gbClientOp({ op: 'resolve', id: 'r1', as: 'open' }, s.deps);
  assert.equal(r.status, 200);
  assert.equal(read().rows[0].status, 'open');
});

test('an unreadable ledger file refuses every trade / op / state read with 503 and is never written', async () => {
  fs.writeFileSync(FILE, '{"rows": [');
  const s = stubs();
  for (const r of [await gbTrade(req('open', 'LONG'), s.deps), await gbClientOp({ op: 'setMode', mode: 'SIM' }, s.deps), gbState(s.deps)]) {
    assert.equal(r.status, 503);
    assert.match(String(r.body.error), /gearbox ledger unreadable/);
  }
  assert.equal(fs.readFileSync(FILE, 'utf8'), '{"rows": [');
  assert.equal(s.calls.length, 0);
});

test('a SIM entry on a stale option price is refused', async () => {
  write({});
  const s = stubs({ optionPrice: () => ({ ltp: 120, ageMs: 11_000 }) });
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /s old/);
  assert.equal(read().rows.length, 0);
});

test('an exit answered flat within 60 s of the entry fill is UNKNOWN; later it closes the row', async () => {
  const flat = async () => ({ status: 200, body: { success: true, outcome: 'flat' } });
  real({ rows: [openRow({ mode: 'REAL', entryFilledAt: NOW - 20_000 })] });
  const a = await gbTrade(req('exit'), stubs({ place: flat }).deps);
  assert.equal(a.status, 504);
  assert.equal(read().rows[0].status, 'unknown');
  real({ rows: [openRow({ mode: 'REAL', entryAt: NOW - 30_000 })] }); // fill never confirmed: counted from the entry
  await gbTrade(req('exit'), stubs({ place: flat }).deps);
  assert.equal(read().rows[0].status, 'unknown');
  real({ rows: [openRow({ mode: 'REAL', entryFilledAt: NOW - 61_000 })] });
  const b = await gbTrade(req('exit'), stubs({ place: flat }).deps);
  assert.equal(b.status, 200);
  assert.equal(read().rows[0].status, 'closed');
});

test('a REAL entry fill records when it was confirmed', async () => {
  real();
  await gbTrade(req('open', 'LONG'), stubs().deps);
  assert.equal(read().rows[0].entryFilledAt, NOW);
});

test('reverse picks the new leg from the price AFTER the exit', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  let fut = 6010;
  const s = stubs({ price: () => ({ ltp: fut, ageMs: 500 }) });
  const place = s.deps.place;
  s.deps.place = async (o, sc, t) => { const r = await place(o, sc, t); fut = 6090; return r; };
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 200);
  assert.equal((s.calls[1].order.target as Target).strike, 6100);
});

test('reverse stops after the exit when the future price has gone stale', async () => {
  real({ rows: [openRow({ mode: 'REAL' })] });
  let age = 500;
  const s = stubs({ price: () => ({ ltp: 6010, ageMs: age }) });
  const place = s.deps.place;
  s.deps.place = async (o, sc, t) => { const r = await place(o, sc, t); age = 30_000; return r; };
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 409);
  assert.equal(s.calls.length, 1);
  const l = read();
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0].status, 'closed');
  assert.ok(l.log.some(e => e.msg === 'reverse stopped: stale price'));
});

test('state lists the option expiries after today for the expiry picker', () => {
  write({});
  const r = gbState(stubs().deps);
  assert.deepEqual(r.body.expiries, [NEXT]);
});

// ── FUT legs (2026-11-20): the signal future itself ──

const FUT_T: Target = { kind: 'futures', symbol: U, name: U, expiry: '2026-12-17' };
const futLeg = (action: 'BUY' | 'SELL') => ({ action, opt: 'FUT' as const, offset: 0, expiry: 'nearest' });
const futMap = (dirn: 'LONG' | 'SHORT', action: 'BUY' | 'SELL') => {
  const m = { ...emptyLedger().config.map };
  m[dirn] = futLeg(action);
  return { ...emptyLedger().config, map: m };
};
const noOption = () => { throw new Error('optionPrice must not be asked for a FUT leg'); };

test('pickTarget of a FUT leg is the signal future (first future on or after the nearest option expiry)', () => {
  assert.deepEqual(pickTarget(U, futLeg('BUY'), 6010, TODAY, FNO), FUT_T);
  assert.deepEqual(pickTarget(U, { ...futLeg('SELL'), expiry: NEXT }, 6010, TODAY, FNO), FUT_T);
  assert.equal(typeof pickTarget(U, { ...futLeg('BUY'), expiry: TODAY }, 6010, TODAY, FNO), 'string'); // never today's expiry
  assert.equal(typeof pickTarget(U, futLeg('BUY'), 6010, TODAY, FNO.filter(r => r.optType !== null)), 'string'); // no future listed
});

test('FUT SIM open books the future price as entry', async () => {
  write({ config: futMap('LONG', 'BUY') });
  const s = stubs({ optionPrice: noOption });
  const r = await gbTrade(req('open', 'LONG'), s.deps);
  assert.equal(r.status, 200, String(r.body.error));
  const row = read().rows[0];
  assert.deepEqual(row.target, FUT_T);
  assert.equal(row.entry, 6010);
  assert.equal(row.lastLtp, 6010);
  assert.equal(row.leg.opt, 'FUT');
  assert.equal(s.calls.length, 0);
});

test('FUT REAL open sends 1 lot SELL on the future, INTRADAY, tag gbx', async () => {
  real({ config: futMap('SHORT', 'SELL') });
  const s = stubs({ optionPrice: noOption });
  const r = await gbTrade(req('open', 'SHORT'), s.deps);
  assert.equal(r.status, 200, String(r.body.error));
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.tag, 'gbx');
  assert.equal(c.order.lots, 1);
  assert.equal(c.order.action, 'SELL');
  assert.equal(c.order.product, 'INTRADAY');
  assert.deepEqual(c.order.target, FUT_T);
  assert.equal(c.fileAtSend.rows[0].status, 'sending');
  const row = read().rows[0];
  assert.equal(row.status, 'open');
  assert.equal(row.entry, 123.5);
  assert.equal(row.units, 1);
});

test('FUT open on a stale or missing future price is refused, nothing sent', async () => {
  real({ config: futMap('LONG', 'BUY') });
  const s = stubs({ price: () => ({ ltp: 6010, ageMs: 10_001 }), optionPrice: noOption });
  assert.equal((await gbTrade(req('open', 'LONG'), s.deps)).status, 409);
  const n = stubs({ price: () => null, optionPrice: noOption });
  assert.equal((await gbTrade(req('open', 'LONG'), n.deps)).status, 409);
  assert.equal(s.calls.length + n.calls.length, 0);
  assert.equal(read().rows.length, 0);
});

test('FUT exit sends exitOwn on the future with the row\'s own units', async () => {
  real({ config: futMap('SHORT', 'SELL'), rows: [openRow({ mode: 'REAL', dir: 'SHORT', leg: futLeg('SELL'), target: FUT_T, units: 1, entry: 6000 })] });
  const s = stubs({ optionPrice: noOption });
  const r = await gbTrade(req('exit'), s.deps);
  assert.equal(r.status, 200, String(r.body.error));
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0].order.target, FUT_T);
  assert.deepEqual(s.calls[0].order.exitOwn, { side: 'BUY', units: [1], product: 'INTRADAY' });
  assert.equal(read().rows[0].status, 'closed');
});

test('FUT SIM close uses the future price (not an option price)', async () => {
  const row = openRow({ leg: futLeg('SELL'), target: FUT_T, entry: 6000 });
  const l: GbLedger = { ...emptyLedger(), config: futMap('LONG', 'SELL'), rows: [row] };
  const out = await closeRowNow(l, row, 'click', stubs({ price: () => ({ ltp: 5990, ageMs: 500 }), optionPrice: noOption }).deps);
  assert.ok(out.ok);
  assert.equal(out.ledger.rows[0].exit, 5990);
});

test('reverse LONG BUY FUT -> SHORT BUY PE', async () => {
  const cfgMap = { ...emptyLedger().config, map: { LONG: futLeg('BUY'), SHORT: { action: 'BUY' as const, opt: 'PE' as const, offset: 0, expiry: 'nearest' } } };
  real({ config: cfgMap, rows: [openRow({ mode: 'REAL', leg: futLeg('BUY'), target: FUT_T, entry: 6000 })] });
  const s = stubs();
  const r = await gbTrade(req('reverse', 'SHORT'), s.deps);
  assert.equal(r.status, 200, String(r.body.error));
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[0].order.target, FUT_T);
  assert.deepEqual(s.calls[0].order.exitOwn, { side: 'SELL', units: [1], product: 'INTRADAY' });
  assert.deepEqual(s.calls[1].order.target, opt(6000, 'PE'));
  const rows = read().rows;
  assert.equal(rows[0].status, 'closed');
  assert.equal(rows[1].dir, 'SHORT');
  assert.equal(rows[1].entry, 123.5);
});

test('state shows the future as the contract of a FUT direction and prices a FUT row from the future', () => {
  write({ config: futMap('SHORT', 'SELL'), rows: [openRow({ leg: futLeg('SELL'), target: FUT_T, dir: 'SHORT' })] });
  const asked: string[] = [];
  const r = gbState(stubs({ optionPrice: t => { asked.push(t.kind); return { ltp: 120, ageMs: 500 }; } }).deps);
  const contracts = r.body.contracts as Record<string, Target | null>;
  assert.deepEqual(contracts.SHORT, FUT_T);
  assert.deepEqual(contracts.LONG, opt(6000, 'CE'));
  const prices = r.body.prices as { contracts: Record<string, { ltp: number } | null>; rows: Record<string, { ltp: number } | null> };
  assert.equal(prices.contracts.SHORT?.ltp, 6010);
  assert.equal(prices.rows.r1?.ltp, 6010);
  assert.ok(!asked.includes('futures'));
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
