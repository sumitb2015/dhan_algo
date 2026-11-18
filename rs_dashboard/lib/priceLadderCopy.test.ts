import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyScopeNote, copyTargets, copyTargetBlock, cancelCopyTargetLevels } from './priceLadderCopy.ts';
import type { LadderState } from './priceLadder.ts';

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
  assert.equal(n.text, 'Kotak is a copy target — REAL orders blocked');
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

test('copyTargets: armed + enabled children only; a missing file is none; an unreadable one fails closed', () => {
  assert.deepEqual([...copyTargets(undefined)], []);
  assert.deepEqual([...copyTargets({ armed: false, children: [{ broker: 'kotak', enabled: true }] })], []);
  assert.deepEqual([...copyTargets({ armed: true, children: [{ broker: 'kotak', enabled: true }, { broker: 'zerodha', enabled: false }] })], ['kotak']);
  assert.deepEqual([...copyTargets({ armed: true, children: [{ broker: 'Zerodha', multiplier: 2, enabled: 1 }, { broker: 'kotak' }] })], ['zerodha']);
  assert.deepEqual([...copyTargets(null)].sort(), ['kotak', 'zerodha']);
  assert.deepEqual([...copyTargets([1, 2])].sort(), ['kotak', 'zerodha']);
  assert.deepEqual([...copyTargets({ armed: true, children: 'x' })].sort(), ['kotak', 'zerodha']);
});

test('copyTargetBlock: refuses only a copy-target broker, never Dhan (the parent)', () => {
  const t = new Set(['kotak']);
  assert.match(copyTargetBlock('kotak', t)!, /Kotak is armed as a copy-trade child.*Exits still work/);
  assert.equal(copyTargetBlock('zerodha', t), null);
  assert.equal(copyTargetBlock('dhan', new Set(['dhan', 'kotak'])), null);
  assert.equal(copyTargetBlock('kotak', new Set()), null);
});

test('cancelCopyTargetLevels: cancels REAL ARMED levels on a target only — never SIM, Dhan, other brokers or anything already sent', () => {
  const sl = (id: string, broker: string, mode: string, state: string) => ({ id, broker, mode, state, contract: { securityId: id } });
  const s = {
    date: '2026-11-18', events: [],
    slices: [sl('a', 'kotak', 'real', 'armed'), sl('b', 'kotak', 'sim', 'armed'), sl('c', 'dhan', 'real', 'armed'), sl('d', 'zerodha', 'real', 'armed'),
      sl('e', 'kotak', 'real', 'open'), sl('f', 'kotak', 'real', 'working'), sl('g', 'kotak', 'real', 'placing')],
    pairs: [{ id: 'p1', broker: 'kotak', mode: 'real', state: 'armed' }, { id: 'p2', broker: 'kotak', mode: 'real', state: 'open' }],
    baskets: [{ id: 'k1', broker: 'kotak', mode: 'real', state: 'armed' }, { id: 'k2', broker: 'dhan', mode: 'real', state: 'armed' }],
  } as unknown as LadderState;
  const n = cancelCopyTargetLevels(s, new Set(['kotak']), 1);
  assert.deepEqual(n.slices.map(x => x.state), ['cancelled', 'armed', 'armed', 'armed', 'open', 'working', 'placing']);
  assert.deepEqual(n.pairs!.map(x => x.state), ['cancelled', 'open']);
  assert.deepEqual(n.baskets!.map(x => x.state), ['cancelled', 'armed']);
  assert.equal(n.events.length, 3);
  assert.ok(n.events.every(e => e.level === 'warn' && /copy-trade child/.test(e.msg)));
  // Nothing to do: the same object back (no write churn)
  assert.equal(cancelCopyTargetLevels(s, new Set(), 1), s);
  assert.equal(cancelCopyTargetLevels(s, new Set(['dhan']), 1).slices[2].state, 'armed');
});
