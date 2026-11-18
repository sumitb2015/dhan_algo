import test from 'node:test';
import assert from 'node:assert/strict';
import { indexEntryLines } from './pnfIndexLines.ts';

const auto = { id: 'r1', entryPrice: 25381.5, lots: 3, mode: 'REAL', entryFilled: true, traded: { action: 'SELL' as const, target: { strike: 25100, side: 'PE' }, entryPremium: 92.9 } };
const held = { id: 'h1', entryY: 25350, action: 'BUY' as const, traded: { strike: 25600, side: 'CE' } };

test('AUTO option row: line at the index entry, tag with the option, its premium and P&L', () => {
  assert.deepEqual(indexEntryLines({ auto, autoPnl: 2252, held: null, heldLeg: null, heldAvg: null }), [
    { key: 'auto:r1', y: 25381.5, side: 'SHORT', pnl: 2252, text: 'AUTO SELL 3L 25100 PE @ 92.90' },
  ]);
});

test('REAL entry not yet filled: premium marked ~; unpriced P&L stays null', () => {
  const [l] = indexEntryLines({ auto: { ...auto, entryFilled: false }, autoPnl: null, held: null, heldLeg: null, heldAvg: null });
  assert.equal(l.text, 'AUTO SELL 3L 25100 PE @ ~92.90');
  assert.equal(l.pnl, null);
});

test('hand-held option: line at its entry spot, own mark lots and P&L', () => {
  assert.deepEqual(indexEntryLines({ auto: null, autoPnl: null, held, heldLeg: { side: 'LONG', lots: 2, pnl: -150 }, heldAvg: 41.25 }), [
    { key: 'held:h1', y: 25350, side: 'LONG', pnl: -150, text: 'BUY 2L 25600 CE @ ~41.25' },
  ]);
});

test('nothing drawn without a position or an entry level', () => {
  assert.deepEqual(indexEntryLines({ auto: null, autoPnl: null, held: null, heldLeg: null, heldAvg: null }), []);
  assert.deepEqual(indexEntryLines({ auto: { ...auto, traded: undefined }, autoPnl: 0, held: null, heldLeg: null, heldAvg: null }), []);
  assert.deepEqual(indexEntryLines({ auto: null, autoPnl: null, held: { ...held, entryY: undefined }, heldLeg: { side: 'LONG', lots: 1, pnl: 0 }, heldAvg: null }), []);
  assert.deepEqual(indexEntryLines({ auto: null, autoPnl: null, held, heldLeg: null, heldAvg: null }), []);   // flat / never priced
});

test('both at once: two lines', () => {
  assert.equal(indexEntryLines({ auto, autoPnl: 1, held, heldLeg: { side: 'LONG', lots: 1, pnl: 0 }, heldAvg: null }).length, 2);
});
