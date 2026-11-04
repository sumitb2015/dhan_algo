import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeArm } from './pnfAutoArm.ts';
import { applyAutoOp, EMPTY_LEDGER, parseLedger, type AutoArmRecord, type AutoRow } from './pnfAutoLedger.ts';

const TK = 'futures|CRUDEOILM|2026-11-19||';
const rec: AutoArmRecord = { mode: 'REAL', broker: 'kotak', targetKey: TK, day: '2026-11-04', t: 1000, watermarkT: 900, lots: 2, rule: 'supertrend', side: 'both' };
const ctx = { chart: 1 as const, today: '2026-11-04', broker: 'kotak', targetKey: TK, mode: 'REAL' as const, rows: [] as AutoRow[] };
const row = (o: Partial<AutoRow>): AutoRow => ({
  id: 'r', day: '2026-11-04', chart: 1, target: { kind: 'futures', symbol: 'CRUDEOILM', name: 'x', expiry: '2026-11-19' } as AutoRow['target'], targetKey: TK,
  mode: 'REAL', broker: 'kotak', side: 'SELL', lots: 2, unitsPerPoint: 20, legs: [], entryT: 1100, entryBarT: 1080, entryPrice: 9000, state: 'closed', ...o,
});

test('setArm saves and clears a chart\'s switch with its log line; clearing twice logs once; other ops keep it', () => {
  let r = applyAutoOp(EMPTY_LEDGER, { op: 'setArm', chart: 1, arm: rec, t: 1000, text: 'AUTO armed' });
  assert.ok(r.ok);
  let led = r.ledger;
  assert.deepEqual(led.arms?.['1'], rec);
  assert.equal(led.log.at(-1)?.text, 'AUTO armed');
  r = applyAutoOp(led, { op: 'log', chart: 2, t: 1001, text: 'x' });
  assert.ok(r.ok);
  assert.deepEqual(r.ledger.arms?.['1'], rec, 'a plain op must not drop the saved switch');
  r = applyAutoOp(r.ledger, { op: 'setArm', chart: 1, arm: null, t: 1002, text: 'AUTO switched off: halt' });
  assert.ok(r.ok);
  led = r.ledger;
  assert.equal(led.arms, undefined);
  const again = applyAutoOp(led, { op: 'setArm', chart: 1, arm: null, t: 1003, text: 'AUTO switched off: other tab' });
  assert.ok(again.ok);
  assert.equal(again.ledger, led, 'already off: no new rev, no second log line');
});

test('setArm refuses a bad record; parseLedger keeps a good saved switch and drops a bad one', () => {
  const bad = applyAutoOp(EMPTY_LEDGER, { op: 'setArm', chart: 1, arm: { ...rec, lots: 0 }, t: 1, text: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(applyAutoOp(EMPTY_LEDGER, { op: 'setArm', chart: 1, arm: rec, t: 1, text: '' }).ok, false);
  const parsed = parseLedger({ rev: 3, rows: [], log: [], arms: { 1: rec, 2: { ...rec, mode: 'LIVE' } } });
  assert.deepEqual(parsed.arms, { 1: rec });
  assert.equal(parseLedger({ rev: 1, rows: [], log: [] }).arms, undefined);
});

test('resumeArm: same day, contract, broker and mode resumes, with the watermark past the last AUTO entry since the arming', () => {
  assert.deepEqual(resumeArm(rec, ctx), { ok: true, watermarkT: 900 });
  const v = resumeArm(rec, { ...ctx, rows: [row({ entryT: 1100, entryBarT: 1080 }), row({ chart: 2, entryT: 1200, entryBarT: 1190 }), row({ entryT: 500, entryBarT: 5000 })] });
  assert.deepEqual(v, { ok: true, watermarkT: 1080 }, 'only this chart, only entries after the arming');
});

test('resumeArm: the page loads in PAPER, so a REAL arm waits for the switch to REAL (and a broker / contract change waits too)', () => {
  const p = resumeArm(rec, { ...ctx, mode: 'PAPER' });
  assert.equal(p.ok, false);
  assert.ok(!p.ok && p.wait && /switch the page to REAL/.test(p.why));
  const b = resumeArm(rec, { ...ctx, broker: 'dhan' });
  assert.ok(!b.ok && b.wait);
  const k = resumeArm(rec, { ...ctx, targetKey: 'futures|CRUDEOILM|2026-12-17||' });
  assert.ok(!k.ok && k.wait);
});

test('resumeArm: an arm from another day, or one the server guard ended, is spent', () => {
  const d = resumeArm(rec, { ...ctx, today: '2026-11-05' });
  assert.ok(!d.ok && !d.wait);
  const g = resumeArm(rec, { ...ctx, rows: [row({ exitT: 1500, reason: 'server guard: stop' })] });
  assert.ok(!g.ok && !g.wait);
  const older = resumeArm(rec, { ...ctx, rows: [row({ exitT: 800, reason: 'server guard: stop' })] });
  assert.equal(older.ok, true, 'a guard exit before the arming does not count');
});
