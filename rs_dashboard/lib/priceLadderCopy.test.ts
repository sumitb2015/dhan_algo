import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyScopeNote } from './priceLadderCopy.ts';

const Z = { broker: 'zerodha', label: 'Zerodha', multiplier: 2 };
const K = { broker: 'kotak', label: 'Kotak', multiplier: 1 };
const base = { armed: true, bridgeRunning: true, failed: {} as Record<string, string>, real: true, broker: 'dhan', underlying: 'NIFTY', isFut: false, children: [Z] };

test('nothing shown while copy trading is disarmed', () => {
  assert.equal(copyScopeNote({ ...base, armed: false }), null);
  assert.equal(copyScopeNote({ ...base, armed: false, broker: 'zerodha' }), null);
});

test('REAL Dhan NIFTY option is copied, naming each child and multiplier', () => {
  assert.deepEqual(copyScopeNote({ ...base, children: [Z, K] })?.text, 'Copying → Zerodha 2x + Kotak 1x');
  assert.equal(copyScopeNote(base)?.tone, 'copy');
});

test('each out-of-scope selection says why it is not copied, as an "off" note', () => {
  const cases: [Partial<typeof base>, RegExp][] = [
    [{ real: false }, /^SIM/], [{ broker: 'kotak', children: [Z] }, /only Dhan/], [{ underlying: 'BANKNIFTY' }, /BANKNIFTY not copied/],
    [{ underlying: 'SENSEX' }, /SENSEX not copied/], [{ underlying: 'CRUDEOILM' }, /CRUDEOILM not copied/], [{ isFut: true }, /Futures not copied/],
  ];
  for (const [o, re] of cases) {
    const n = copyScopeNote({ ...base, ...o })!;
    assert.equal(n.tone, 'off', JSON.stringify(o));
    assert.match(n.text, re);
  }
});

test('a REAL ladder on a broker that is also a copy child is flagged as a shared-account danger', () => {
  const n = copyScopeNote({ ...base, broker: 'kotak', children: [Z, K] })!;
  assert.equal(n.tone, 'danger');
  assert.match(n.text, /Kotak is a copy target/);
  assert.match(n.detail, /watchdog/);
  // SIM sends nothing to the broker: no shared-account danger then
  assert.equal(copyScopeNote({ ...base, broker: 'kotak', children: [Z, K], real: false })!.tone, 'off');
  // A child that is not enabled is not a copy target
  assert.equal(copyScopeNote({ ...base, broker: 'kotak', children: [Z] })!.tone, 'off');
});

test('armed but not working is never shown as copying', () => {
  assert.equal(copyScopeNote({ ...base, bridgeRunning: false })!.tone, 'danger');
  assert.match(copyScopeNote({ ...base, bridgeRunning: false })!.text, /bridge DOWN/);
  assert.equal(copyScopeNote({ ...base, children: [] })!.tone, 'danger');
  const allDown = copyScopeNote({ ...base, failed: { zerodha: 'token expired' } })!;
  assert.equal(allDown.tone, 'danger');
  assert.equal(allDown.text, 'Zerodha DOWN — not copying');
  const oneDown = copyScopeNote({ ...base, children: [Z, K], failed: { kotak: 'login failed' } })!;
  assert.equal(oneDown.tone, 'danger');
  assert.equal(oneDown.text, 'Copying → Zerodha 2x · Kotak DOWN');
  // A failure for a broker that is not a child does not matter
  assert.equal(copyScopeNote({ ...base, failed: { kotak: 'x' } })!.tone, 'copy');
});
