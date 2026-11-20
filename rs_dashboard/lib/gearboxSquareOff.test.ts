import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGbStateFileForTests } from './gearboxFile.ts';
import type { GbDeps } from './gearboxCore.ts';
import { gearboxSquareOffTickCore as tick, squareOffDue } from './gearboxSquareOffCore.ts';
import { emptyLedger, type GbLedger, type GbRow } from './gearboxLedger.ts';
import type { Target } from './pnfTarget.ts';

// Gearbox square-off with every broker / network call stubbed. The ledger lives in a temp dir, never debug/.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gearbox-sq-'));
const FILE = path.join(dir, 'gearbox_state.json');
setGbStateFileForTests(FILE);

const TODAY = '2026-11-20'; // a Friday; US DST is over, so the MCX auto-exit is 23:40 IST
const U = 'CRUDEOILM' as const;
const at = (hhmm: string, date = TODAY) => Date.parse(`${date}T${hhmm}:00+05:30`);
const BEFORE = at('23:39');
const AFTER = at('23:41');

const target: Target = { kind: 'options', symbol: U, name: U, expiry: '2026-12-16', strike: 6000, side: 'CE' };
const row = (extra: Partial<GbRow> = {}): GbRow => ({
  id: 'r1', mode: 'SIM', broker: 'dhan', underlying: U, dir: 'LONG', leg: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
  target, lots: 1, units: 1, unitsPerLot: 10, entry: 100, entryDecision: 6000, entryAt: AFTER - 3_600_000, day: TODAY, status: 'open', ...extra,
});
const write = (rows: GbRow[], extra: Partial<GbLedger> = {}) => fs.writeFileSync(FILE, JSON.stringify({ ...emptyLedger(), rows, ...extra }));
const read = (): GbLedger => JSON.parse(fs.readFileSync(FILE, 'utf8'));

function stubs(now: number, over: Partial<GbDeps> = {}) {
  const calls: Record<string, unknown>[] = [];
  const deps: GbDeps = {
    now: () => now,
    price: () => null,
    optionPrice: () => ({ ltp: 120, ageMs: 500 }),
    place: async order => { calls.push(order as unknown as Record<string, unknown>); return { status: 200, body: { success: true, outcome: 'placed', legs: [{ status: 'placed', orderId: 'X1' }] } }; },
    readOrder: async () => ({ orderStatus: 'TRADED', filledQty: 1, averageTradedPrice: 121 }),
    sleep: async () => undefined,
    lotUnits: async () => 1,
    ...over,
  };
  return { deps, calls };
}

test('squareOffDue: open rows from the auto-exit on, none before', () => {
  const l = { ...emptyLedger(), rows: [row(), row({ id: 'r2', status: 'unknown' })] };
  assert.deepEqual(squareOffDue(BEFORE, l), []);
  assert.deepEqual(squareOffDue(AFTER, l).map(r => r.id), ['r1']);
});

test('squareOffDue: an earlier day\'s row is due at any time once the session is open; nothing on a shut day', () => {
  const l = { ...emptyLedger(), rows: [row({ day: '2026-11-19' })] };
  assert.deepEqual(squareOffDue(at('10:00'), l).map(r => r.id), ['r1']);
  assert.deepEqual(squareOffDue(at('08:00'), l), []);
  assert.deepEqual(squareOffDue(at('12:00', '2026-11-21'), l), []); // Saturday
});

test('a SIM row is closed at the option price and lastSquareOffDay is set', async () => {
  write([row()]);
  await tick(stubs(AFTER).deps);
  const l = read();
  assert.equal(l.rows[0].status, 'closed');
  assert.equal(l.rows[0].exit, 120);
  assert.equal(l.rows[0].reason, 'square-off');
  assert.equal(l.lastSquareOffDay, TODAY);
});

test('nothing happens before the auto-exit', async () => {
  write([row()]);
  await tick(stubs(BEFORE).deps);
  assert.equal(read().rows[0].status, 'open');
  assert.equal(read().lastSquareOffDay, null);
});

test('a SIM row with no price closes at lastLtp and logs it', async () => {
  write([row({ lastLtp: 111 })]);
  await tick(stubs(AFTER, { optionPrice: () => null }).deps);
  const l = read();
  assert.equal(l.rows[0].exit, 111);
  assert.ok(l.log.some(e => e.msg.includes('square-off at last price')));
});

test('a REAL row with no price still sends exitOwn', async () => {
  write([row({ mode: 'REAL', lastLtp: 111 })], { mode: 'REAL' });
  const s = stubs(AFTER, { optionPrice: () => null });
  await tick(s.deps);
  assert.equal(s.calls.length, 1);
  const own = s.calls[0].exitOwn as { side: string; units: number[] };
  assert.equal(own.side, 'SELL');
  assert.deepEqual(own.units, [1]);
  assert.equal(read().rows[0].status, 'closed');
});

test('a refused REAL exit leaves the row open and the next tick retries it', async () => {
  write([row({ mode: 'REAL' })], { mode: 'REAL' });
  let n = 0;
  const s = stubs(AFTER, {
    place: async () => (n++ === 0
      ? { status: 409, body: { success: false, outcome: 'refused', error: 'busy' } }
      : { status: 200, body: { success: true, outcome: 'placed', legs: [{ status: 'placed', orderId: 'X2' }] } }),
  });
  await tick(s.deps);
  assert.equal(read().rows[0].status, 'open');
  await tick(s.deps);
  assert.equal(read().rows[0].status, 'closed');
  assert.equal(n, 2);
});

test('an UNKNOWN REAL exit is never resent; an UNKNOWN row is skipped and logged once', async () => {
  write([row({ mode: 'REAL' }), row({ id: 'r2', status: 'unknown' })], { mode: 'REAL' });
  let n = 0;
  const s = stubs(AFTER, { place: async () => { n++; return { status: 504, body: { success: false, outcome: 'unknown', message: 'timeout' } }; } });
  await tick(s.deps);
  await tick(s.deps);
  await tick(s.deps);
  assert.equal(n, 1);
  const l = read();
  assert.equal(l.rows.find(r => r.id === 'r1')?.status, 'unknown');
  assert.equal(l.log.filter(e => e.msg.includes('square-off skipped: row r2 is UNKNOWN')).length, 1);
});

test('a tick after the square-off with nothing live does nothing', async () => {
  write([row({ status: 'closed' })], { lastSquareOffDay: TODAY });
  const before = fs.readFileSync(FILE, 'utf8');
  const s = stubs(AFTER);
  await tick(s.deps);
  assert.equal(fs.readFileSync(FILE, 'utf8'), before);
  assert.equal(s.calls.length, 0);
});
