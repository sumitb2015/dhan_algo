import test from 'node:test';
import assert from 'node:assert/strict';
import { unguardedShorts } from './multiLegUnguarded.ts';
import type { MultiLegBasket, MultiLegLeg } from './multiLegFocus.ts';

const T = '2026-10-13';
const leg = (id: string, side: 'B' | 'S', option: string, o: Partial<MultiLegLeg> = {}) =>
  ({ id, side, option, strike: 22700, status: 'OPEN', lots: 1, fill: { qty: 65, avgPrice: 97 }, ...o }) as unknown as MultiLegLeg;
const bk = (legs: MultiLegLeg[], extra: Partial<MultiLegBasket> = {}) => ({ id: 'b', legs, ...extra }) as unknown as MultiLegBasket;
const ids = (b: MultiLegBasket) => unguardedShorts(b, T).map(l => l.id);

test('a bare open short is reported; hedges, closed, futures and unfilled legs are not', () => {
  const b = bk([leg('s', 'S', 'CE'), leg('h', 'B', 'CE'), leg('c', 'S', 'PE', { status: 'CLOSED' }), leg('f', 'S', 'FUT'), leg('u', 'S', 'PE', { fill: undefined })]);
  assert.deepEqual(ids(b), ['s']);
});

test('a leg SL protects only that leg', () => {
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE', { sl: 50, slType: 'pct' }), leg('b', 'S', 'PE')])), ['b']);
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE', { sl: 0 })])), ['a']);
});

test('armed strategy SL protects every short; a basket default rule alone does not (it only reaches legs placed after it)', () => {
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE')], { autoLegRule: { enabled: true, slPct: 50, tpPct: 0 } })), ['a']);
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE')], { autoLegRule: { enabled: false, slPct: 50, tpPct: 0 } })), ['a']);
  const rc = (armed: boolean, slValue?: number) => ({ riskConfig: { armed, slValue, slUnit: 'pct', targetUnit: 'pct' } }) as Partial<MultiLegBasket>;
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE')], rc(true, 30))), []);
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE')], rc(false, 30))), ['a']);
  assert.deepEqual(ids(bk([leg('a', 'S', 'CE')], rc(true))), ['a']);
});

test('spot triggers: only armed-today exits count, and EXIT_CE covers CE only', () => {
  const g = (action: string, o: object = {}) => ({ guards: { spotTriggers: [{ id: 't', level: 22600, dir: 'above', action, armed: true, armedDay: T, ...o }] } }) as unknown as Partial<MultiLegBasket>;
  const legs = [leg('ce', 'S', 'CE'), leg('pe', 'S', 'PE')];
  assert.deepEqual(ids(bk(legs, g('EXIT_CE'))), ['pe']);
  assert.deepEqual(ids(bk(legs, g('EXIT_PE'))), ['ce']);
  assert.deepEqual(ids(bk(legs, g('EXIT_ALL'))), []);
  assert.deepEqual(ids(bk(legs, g('ALERT'))), ['ce', 'pe']);
  assert.deepEqual(ids(bk(legs, g('EXIT_ALL', { armed: false }))), ['ce', 'pe']);
  assert.deepEqual(ids(bk(legs, g('EXIT_ALL', { armedDay: '2026-10-12' }))), ['ce', 'pe']);
});

test('max-loss alarm protects only with exitAtMaxLoss and a limit; Greek band only with EXIT_ALL', () => {
  const al = (o: object) => ({ guards: { alarm: { armed: true, armedDay: T, ...o } } }) as unknown as Partial<MultiLegBasket>;
  const legs = [leg('a', 'S', 'CE')];
  assert.deepEqual(ids(bk(legs, al({ maxLoss: 20000, exitAtMaxLoss: true }))), []);
  assert.deepEqual(ids(bk(legs, al({ maxLoss: 20000 }))), ['a']);
  assert.deepEqual(ids(bk(legs, al({ exitAtMaxLoss: true }))), ['a']);
  const band = (action: string) => ({ guards: { greekBands: [{ id: 'g', metric: 'delta', max: 5, action, armed: true, armedDay: T }] } }) as unknown as Partial<MultiLegBasket>;
  assert.deepEqual(ids(bk(legs, band('EXIT_ALL'))), []);
  assert.deepEqual(ids(bk(legs, band('ALERT'))), ['a']);
  const noLimit = { guards: { greekBands: [{ id: 'g', metric: 'delta', action: 'EXIT_ALL', armed: true, armedDay: T }] } } as unknown as Partial<MultiLegBasket>;
  assert.deepEqual(ids(bk(legs, noLimit)), ['a']);
});
