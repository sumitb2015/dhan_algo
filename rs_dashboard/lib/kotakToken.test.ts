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

test('a failed Kotak request logs WHICH path it was (rate-limit errors were untraceable)', async (t) => {
  const { raiseIfError } = await import('./kotakToken.ts');
  const logged: string[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
  assert.throws(() => raiseIfError({ stCode: 100025, errMsg: 'rate limit exceeded', stat: 'too many request received' }, '/quick/user/positions'),
    /rate limit exceeded \(stCode 100025\)/);
  assert.ok(logged.some(l => l.includes('/quick/user/positions') && l.includes('100025')), logged.join('\n'));
});
