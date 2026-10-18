import { test } from 'node:test';
import assert from 'node:assert';
import { brokerSelectorLocked, heldBrokers, holdsRealPosition, nextFillBroker, rowBrokerMismatch } from './focusToolBroker.ts';
import type { FocusRow } from './focusToolRows.ts';

type R = Pick<FocusRow, 'mode' | 'fill'>;
const row = (mode: 'real' | 'sim' | undefined, ceQty: number, peQty: number, broker?: 'dhan' | 'kotak' | 'zerodha'): R => ({
  mode,
  fill: { ceStrike: 25000, peStrike: 25000, ceQty, peQty, ...(broker ? { broker } : {}) } as FocusRow['fill'],
});

test('a REAL row holds a position on either leg; a sim, flat or unfilled row does not', () => {
  assert.equal(holdsRealPosition(row('real', 65, 0)), true);
  assert.equal(holdsRealPosition(row(undefined, 0, 65)), true, 'a row with no mode is REAL (older rows traded real money)');
  assert.equal(holdsRealPosition(row('sim', 65, 65)), false);
  assert.equal(holdsRealPosition(row('real', 0, 0)), false);
  assert.equal(holdsRealPosition({ mode: 'real' }), false);
});

test('nextFillBroker stamps on open from flat, keeps it while held, drops it when flat or sim', () => {
  const flat = { ceQty: 0, peQty: 0 };
  assert.equal(nextFillBroker(false, flat, { ceQty: 65, peQty: 0 }, 'kotak'), 'kotak');
  // One leg already held on Kotak: adding the other leg (or a ladder fill) keeps Kotak.
  assert.equal(nextFillBroker(false, { ceQty: 65, peQty: 0, broker: 'kotak' }, { ceQty: 65, peQty: 65 }, 'kotak'), 'kotak');
  // A reduce keeps it until both legs are flat.
  assert.equal(nextFillBroker(false, { ceQty: 65, peQty: 65, broker: 'dhan' }, { ceQty: 0, peQty: 65 }, 'dhan'), 'dhan');
  assert.equal(nextFillBroker(false, { ceQty: 0, peQty: 65, broker: 'dhan' }, flat, 'dhan'), undefined);
  // Re-opening after flat records the broker of the NEW position.
  assert.equal(nextFillBroker(false, { ceQty: 0, peQty: 0, broker: 'dhan' }, { ceQty: 0, peQty: 65 }, 'kotak'), 'kotak');
  // A held row recorded before the field existed is not guessed.
  assert.equal(nextFillBroker(false, { ceQty: 65, peQty: 0 }, { ceQty: 130, peQty: 0 }, 'dhan'), undefined);
  assert.equal(nextFillBroker(true, flat, { ceQty: 65, peQty: 0 }, 'dhan'), undefined, 'sim rows never carry a broker');
});

test('rowBrokerMismatch names the owning broker only for an open REAL row on another account', () => {
  assert.equal(rowBrokerMismatch(row('real', 65, 0, 'kotak'), 'dhan'), 'kotak');
  assert.equal(rowBrokerMismatch(row('real', 65, 0, 'kotak'), 'kotak'), null);
  assert.equal(rowBrokerMismatch(row('real', 0, 0, 'kotak'), 'dhan'), null, 'a flat row can trade on any broker');
  assert.equal(rowBrokerMismatch(row('sim', 65, 0, 'kotak'), 'dhan'), null);
  assert.equal(rowBrokerMismatch(row('real', 65, 0), 'dhan'), null, 'an unrecorded (pre-2026-10-17) row keeps the old behaviour');
});

test('heldBrokers follows the one broker the open rows agree on, and flags a split', () => {
  assert.deepStrictEqual(heldBrokers([]), { brokers: [], follow: null, conflict: false });
  assert.deepStrictEqual(heldBrokers([row('real', 65, 0, 'kotak'), row('real', 0, 65, 'kotak'), row('sim', 65, 0, 'dhan')]),
    { brokers: ['kotak'], follow: 'kotak', conflict: false });
  assert.deepStrictEqual(heldBrokers([row('real', 0, 0, 'kotak'), row('real', 65, 0)]), { brokers: [], follow: null, conflict: false });
  assert.deepStrictEqual(heldBrokers([row('real', 65, 0, 'kotak'), row('real', 65, 0, 'dhan')]),
    { brokers: ['dhan', 'kotak'], follow: null, conflict: true });
});

test('the selector locks on any open REAL row, but not while rows are split across brokers', () => {
  assert.equal(brokerSelectorLocked([row('sim', 65, 65), row('real', 0, 0, 'dhan')]), false);
  assert.equal(brokerSelectorLocked([row('real', 65, 0, 'kotak')]), true);
  assert.equal(brokerSelectorLocked([row('real', 65, 0)]), true, 'an unrecorded open row still locks');
  assert.equal(brokerSelectorLocked([row('real', 65, 0, 'kotak'), row('real', 65, 0, 'dhan')]), false);
});

test('legProductFor: a held REAL leg keeps the product it opened under; anything else follows the group', async () => {
  const { legProductFor } = await import('./focusToolBroker.ts');
  const held = { mode: 'real' as const, fill: { ceStrike: 25000, peStrike: null, ceQty: 65, peQty: 0, ceProduct: 'INTRADAY' } as FocusRow['fill'] };
  // Group switched to MARGIN while the CE is open: the CE is still looked up under INTRADAY.
  assert.equal(legProductFor(held, 'CE', 'MARGIN'), 'INTRADAY');
  // The flat PE follows the group.
  assert.equal(legProductFor(held, 'PE', 'MARGIN'), 'MARGIN');
  // A leg opened before the stamp existed: the group's.
  const legacy = { mode: 'real' as const, fill: { ceStrike: 25000, peStrike: null, ceQty: 65, peQty: 0 } as FocusRow['fill'] };
  assert.equal(legProductFor(legacy, 'CE', 'MIS'), 'MIS');
  // SIM rows never use a stamp.
  assert.equal(legProductFor({ ...held, mode: 'sim' }, 'CE', 'MARGIN'), 'MARGIN');
});

test('nextLegProduct: stamped on open from flat, kept on an add or reduce, dropped when flat or SIM', async () => {
  const { nextLegProduct } = await import('./focusToolBroker.ts');
  assert.equal(nextLegProduct(false, 0, 65, undefined, 'INTRADAY'), 'INTRADAY');
  assert.equal(nextLegProduct(false, 65, 130, 'INTRADAY', 'MARGIN'), 'INTRADAY', 'an add keeps the open product');
  assert.equal(nextLegProduct(false, 130, 65, 'INTRADAY', 'MARGIN'), 'INTRADAY');
  assert.equal(nextLegProduct(false, 65, 0, 'INTRADAY', 'MARGIN'), undefined);
  assert.equal(nextLegProduct(true, 0, 65, undefined, 'INTRADAY'), undefined);
});
