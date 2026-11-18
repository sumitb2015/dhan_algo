import { test } from 'node:test';
import assert from 'node:assert';
import { isTokenExpired, isSessionDead, KOTAK_UNAUTHORIZED, KOTAK_INVALID_SESSION, KOTAK_INVALID_SESSION_TOKEN } from './kotakToken.ts';

test('isTokenExpired: undefined expiry is treated as expired', () => {
  assert.strictEqual(isTokenExpired(undefined), true);
});

test('isTokenExpired: future date is not expired', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.strictEqual(isTokenExpired(future), false);
});

test('isTokenExpired: past date is expired', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(isTokenExpired(past), true);
});

test('isSessionDead: identifies Kotak dead session status codes', () => {
  assert.strictEqual(isSessionDead({ stCode: KOTAK_UNAUTHORIZED }), true);
  assert.strictEqual(isSessionDead({ stCode: KOTAK_INVALID_SESSION }), true);
  assert.strictEqual(isSessionDead({ stCode: KOTAK_INVALID_SESSION_TOKEN }), true);
  assert.strictEqual(isSessionDead({ data: { stCode: 100022 } }), true);
});

test('isSessionDead: identifies Kotak login-check failure response', () => {
  const response = {
    stCode: 100022,
    errMsg: 'invalid session token',
    stat: 'error in neo-login-check-api',
  };
  assert.strictEqual(isSessionDead(response), true);
});

test('isSessionDead: false on normal business replies', () => {
  assert.strictEqual(isSessionDead({ stat: 'Ok', data: [] }), false);
  assert.strictEqual(isSessionDead({ stat: 'Not_Ok', stCode: 5203, errMsg: 'No Data' }), false);
});

test('a failed Kotak request logs WHICH path it was (errors were untraceable)', async (t) => {
  const { raiseIfError } = await import('./kotakToken.ts');
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  assert.throws(() => raiseIfError({ stCode: 5000, errMsg: 'bad request', stat: 'Not_Ok' }, '/quick/user/positions'), /bad request \(stCode 5000\)/);
  assert.ok(logged.some(l => l.includes('/quick/user/positions') && l.includes('5000')), logged.join('\n'));
});

test('reserveReadSlot: reads start a gap apart and never inside a rate-limit pause', async () => {
  const { reserveReadSlot } = await import('./kotakToken.ts');
  const st = { nextAt: 0, pausedUntil: 0 };
  assert.equal(reserveReadSlot(st, 1000, 350), 0);
  assert.equal(reserveReadSlot(st, 1000, 350), 350);
  assert.equal(reserveReadSlot(st, 1100, 350), 600);
  assert.equal(reserveReadSlot(st, 5000, 350), 0);      // idle lane: no wait
  st.pausedUntil = 7000;
  assert.equal(reserveReadSlot(st, 5400, 350), 1600);   // paused: waits for the pause to end
});

const RATE = () => Object.assign(new Error('rate limit exceeded (stCode 100025)'), {});

test('laneRead: a rate-limited read pauses and retries instead of failing', async (t) => {
  const { laneRead } = await import('./kotakToken.ts');
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let calls = 0;
  const p = laneRead('GET t1', async () => { calls++; if (calls === 1) throw RATE(); return { ok: 1 }; });
  for (let i = 0; i < 10 && calls < 2; i++) { t.mock.timers.tick(500); await new Promise(r => setImmediate(r)); }
  assert.deepEqual(await p, { ok: 1 });
  assert.equal(calls, 2);
  t.mock.timers.reset();
});

test('laneRead: gives up after the retries with the rate-limit error', async (t) => {
  const { laneRead } = await import('./kotakToken.ts');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  let calls = 0;
  const p = laneRead('GET t2', async () => { calls++; throw RATE(); });
  p.catch(() => {});
  for (let i = 0; i < 40 && calls < 3; i++) { t.mock.timers.tick(500); await new Promise(r => setImmediate(r)); }
  await assert.rejects(p, /100025/);
  assert.equal(calls, 3);
  t.mock.timers.reset();
});

test('laneRead: a second identical read joins the one on the wire; another path does not; any other error is not retried', async (t) => {
  const { laneRead } = await import('./kotakToken.ts');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 3_000_000 });
  let calls = 0;
  let release!: (v: Record<string, unknown>) => void;
  const send = () => { calls++; return new Promise<Record<string, unknown>>(r => { release = r; }); };
  const a = laneRead('GET same', send);
  const b = laneRead('GET same', send);
  for (let i = 0; i < 5 && calls < 1; i++) { t.mock.timers.tick(400); await new Promise(r => setImmediate(r)); }
  release({ v: 1 });
  assert.deepEqual(await a, { v: 1 });
  assert.deepEqual(await b, { v: 1 });
  assert.equal(calls, 1);
  let other = 0;
  const c = laneRead('GET other', async () => { other++; throw new Error('Unauthorized (stCode 900901)'); });
  c.catch(() => {});
  for (let i = 0; i < 5 && other < 1; i++) { t.mock.timers.tick(400); await new Promise(r => setImmediate(r)); }
  await assert.rejects(c, /900901/);
  assert.equal(other, 1);
  t.mock.timers.reset();
});

test('raiseIfError: a rate limit is quiet only when the read lane asks (an order write rate-limited is still logged)', async (t) => {
  const { raiseIfError } = await import('./kotakToken.ts');
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  const rl = { stCode: 100025, errMsg: 'rate limit exceeded', stat: 'too many request received' };
  assert.throws(() => raiseIfError(rl, 'quick/order/rule/ms/place'), /stCode 100025/);
  assert.ok(logged.some(l => l.includes('quick/order/rule/ms/place')), 'order write logged');
  logged.length = 0;
  assert.throws(() => raiseIfError(rl, 'portfolio/v2/positions', true), /stCode 100025/);
  assert.deepEqual(logged, []);
});

test('isKotakRateLimit: matches the stCode, not any 100025 in a message', async () => {
  const { isKotakRateLimit } = await import('./kotakToken.ts');
  assert.equal(isKotakRateLimit(new Error('rate limit exceeded (stCode 100025)')), true);
  assert.equal(isKotakRateLimit(new Error('order 251118000100025 not found (stCode 5000)')), false);
  assert.equal(isKotakRateLimit('Kotak rejected the request (stCode 100025)'), true);
});

test('laneRead: a read queued before an order write is never joined after it (it could carry the pre-order book)', async (t) => {
  const { laneRead, noteKotakOrderWrite } = await import('./kotakToken.ts');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 4_000_000 });
  let calls = 0;
  const releases: ((v: Record<string, unknown>) => void)[] = [];
  const send = () => { calls++; const n = calls; return new Promise<Record<string, unknown>>(r => { releases.push(() => r({ n })); }); };
  const before = laneRead('GET book', send);
  t.mock.timers.tick(1);
  noteKotakOrderWrite();
  t.mock.timers.tick(1);
  const after = laneRead('GET book', send);       // must not join `before`
  const again = laneRead('GET book', send);       // joins `after`
  for (let i = 0; i < 10 && calls < 2; i++) { t.mock.timers.tick(400); await new Promise(r => setImmediate(r)); }
  assert.equal(calls, 2);
  releases.forEach(r => r({}));
  assert.deepEqual(await before, { n: 1 });
  assert.deepEqual(await after, { n: 2 });
  assert.deepEqual(await again, { n: 2 });
  t.mock.timers.reset();
});

test('laneRead: a read whose slot falls inside a rate-limit pause waits for the pause to end', async (t) => {
  const { laneRead } = await import('./kotakToken.ts');
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  const sentAt: Record<string, number[]> = { a: [], b: [] };
  let aCalls = 0;
  const a = laneRead('GET pa', async () => { sentAt.a.push(Date.now()); aCalls++; if (aCalls === 1) throw new Error('rate limit exceeded (stCode 100025)'); return { a: 1 }; });
  const b = laneRead('GET pb', async () => { sentAt.b.push(Date.now()); return { b: 1 }; });   // slot reserved ~350 ms after a's
  for (let i = 0; i < 40 && (sentAt.b.length === 0 || aCalls < 2); i++) { t.mock.timers.tick(100); await new Promise(r => setImmediate(r)); }
  assert.deepEqual(await a, { a: 1 });
  assert.deepEqual(await b, { b: 1 });
  // a was refused at its first send, which paused the lane 1500 ms: b must not have gone out inside that pause.
  assert.ok(sentAt.b[0] >= sentAt.a[0] + 1500, `b sent ${sentAt.b[0] - sentAt.a[0]} ms after a's refusal`);
  t.mock.timers.reset();
});
