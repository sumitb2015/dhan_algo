import test from 'node:test';
import assert from 'node:assert/strict';
import { pickExpiries } from './straddlePnfExpiries.ts';

const values = (r: ReturnType<typeof pickExpiries>) => r.map(e => e.value);
const kinds = (r: ReturnType<typeof pickExpiries>) => r.map(e => e.kind);

test('normal week: two weeklies, this monthly and next monthly', () => {
  const r = pickExpiries(['2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-29', '2027-01-26'], '2026-11-04');
  assert.deepEqual(values(r), ['2026-11-10', '2026-11-17', '2026-11-24', '2026-12-29']);
  assert.deepEqual(kinds(r), ['weekly1', 'weekly2', 'monthly1', 'monthly2']);
});

test('the nearest weekly is also this month\'s monthly: it keeps the weekly slot and the next monthlies fill in', () => {
  const r = pickExpiries(['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-29'], '2026-10-25');
  assert.deepEqual(values(r), ['2026-10-27', '2026-11-03', '2026-11-24', '2026-12-29']);
  assert.deepEqual(kinds(r), ['weekly1', 'weekly2', 'monthly1', 'monthly2']);
});

test('fewer than four qualifying dates returns what exists, without duplicates', () => {
  const r = pickExpiries(['2026-12-01', '2026-12-29'], '2026-11-25');
  assert.deepEqual(values(r), ['2026-12-01', '2026-12-29']);
});

test('after this month\'s monthly has passed, "this monthly" rolls to the next month', () => {
  const r = pickExpiries(['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-05', '2027-01-26'], '2026-11-25');
  assert.deepEqual(values(r), ['2026-12-01', '2026-12-08', '2026-12-29', '2027-01-26']);
});

test('expired dates are never offered and an empty list gives an empty result', () => {
  assert.deepEqual(values(pickExpiries(['2026-10-20', '2026-10-27'], '2026-10-25')), ['2026-10-27']);
  assert.deepEqual(pickExpiries([], '2026-10-25'), []);
});

test('labels read like "27 Oct · Tue"', () => {
  assert.equal(pickExpiries(['2026-10-27'], '2026-10-25')[0].label, '27 Oct · Tue');
});

test('unsorted and repeated input is normalised', () => {
  const r = pickExpiries(['2026-11-03', '2026-10-27', '2026-10-27'], '2026-10-25');
  assert.deepEqual(values(r), ['2026-10-27', '2026-11-03']);
});
