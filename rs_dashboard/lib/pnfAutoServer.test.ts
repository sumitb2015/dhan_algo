import test from 'node:test';
import assert from 'node:assert/strict';
import { reservedByAuto } from './pnfAutoServer.ts';
import type { AutoLedger, AutoRow } from './pnfAutoLedger.ts';

const row = (o: Partial<AutoRow>): AutoRow => ({
  id: 'r', day: '2026-11-02', chart: 1, target: { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY' } as AutoRow['target'], targetKey: 'F', mode: 'REAL',
  broker: 'dhan', side: 'SELL', lots: 1, unitsPerPoint: 65, legs: [{ label: 'NIFTY FUT', key: '1', units: 65 }], entryT: 0, entryBarT: 0, entryPrice: 100,
  state: 'open', ...o,
});

test('the other page\'s live REAL AUTO rows reserve their units, signed, per leg; closed / paper / other contracts do not', () => {
  const led: AutoLedger = { rev: 1, log: [], rows: [
    row({}), row({ id: 'b', side: 'BUY', legs: [{ label: 'x', key: '1', units: 65 }], state: 'unknownEntry' }),
    row({ id: 'c', state: 'closed' }), row({ id: 'd', mode: 'PAPER' }), row({ id: 'e', targetKey: 'G' }), row({ id: 'f', broker: 'kotak' }),
    row({ id: 'g', legs: [{ label: 'CE', key: '1', units: 65 }, { label: 'PE', key: '2', units: 65 }] }),
  ] };
  assert.deepEqual(reservedByAuto(led, 'dhan', 'F', 2), [-65, -65]);   // -65 (a) +65 (b, outcome still open) -65 (g); g's PE leg -65
});

test('exceptChart: chart N\'s MTM guard keeps only the OTHER chart\'s AUTO units of this page (its own row is the one being closed)', () => {
  const led: AutoLedger = { rev: 1, log: [], rows: [
    row({ id: 'c1', chart: 1, side: 'SELL' }),                    // chart 1 (the guarding chart): short 65
    row({ id: 'c2', chart: 2, side: 'BUY', legs: [{ label: 'x', key: '1', units: 130 }] }),   // chart 2 on the same contract: long 130
  ] };
  assert.deepEqual(reservedByAuto(led, 'dhan', 'F', 1, 1), [130], 'chart 2\'s long is kept when chart 1 guards');
  assert.deepEqual(reservedByAuto(led, 'dhan', 'F', 1, 2), [-65]);
  assert.deepEqual(reservedByAuto(led, 'dhan', 'F', 1), [65], 'no exceptChart: every live row (the other page\'s ledger)');
});

test('a pyramid add whose outcome is open (adding / unknownAdd) reserves its units too: the lot may be live at the broker', () => {
  const pending = { id: 'a1', t: 1, barT: 1, lots: 1, units: [65], unitsPerPoint: 65, price: 99, status: 'pending' as const };
  const led: AutoLedger = { rev: 1, log: [], rows: [row({ state: 'unknownAdd', adds: [pending] }), row({ id: 'b', chart: 2, state: 'adding', adds: [pending] })] };
  assert.deepEqual(reservedByAuto(led, 'dhan', 'F', 1), [-260]);
  const done: AutoLedger = { rev: 1, log: [], rows: [row({ lots: 2, legs: [{ label: 'x', key: '1', units: 130 }], adds: [{ ...pending, status: 'done' }] })] };
  assert.deepEqual(reservedByAuto(done, 'dhan', 'F', 1), [-130], 'a confirmed add is already in the legs: not counted twice');
});
