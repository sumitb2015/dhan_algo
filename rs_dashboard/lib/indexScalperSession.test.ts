import test from 'node:test';
import assert from 'node:assert/strict';
import { inNseSession, inNseFnoSession, inMcxSession, inMarketSession, inOrderSession, barAnchorSec } from './indexScalperSession.ts';

const ist = (iso: string) => Date.parse(`${iso}+05:30`);

test('NSE session: 09:15 to 15:30 IST on a regular trading day only', () => {
  assert.equal(inNseSession(ist('2026-11-25T09:14:59')), false);
  assert.equal(inNseSession(ist('2026-11-25T09:15:00')), true);
  assert.equal(inNseSession(ist('2026-11-25T15:29:59')), true);
  assert.equal(inNseSession(ist('2026-11-25T15:30:00')), false); // a feed still sending after the close is not "open"
  assert.equal(inNseSession(ist('2026-11-24T11:00:00')), false); // NSE holiday (Guru Nanak Jayanti)
  assert.equal(inNseSession(ist('2026-11-28T11:00:00')), false); // Saturday
});

test('MCX session: 09:00 to 23:30/23:55 IST on trading weekdays', () => {
  // 2026-11-25 is a Wednesday in winter (after US DST ends in early Nov), closes 23:55
  assert.equal(inMcxSession(ist('2026-11-25T08:59:59')), false);
  assert.equal(inMcxSession(ist('2026-11-25T09:00:00')), true);
  assert.equal(inMcxSession(ist('2026-11-25T16:00:00')), true); // evening when NSE is shut!
  assert.equal(inMcxSession(ist('2026-11-25T23:54:59')), true);
  assert.equal(inMcxSession(ist('2026-11-25T23:55:00')), false);
  assert.equal(inMcxSession(ist('2026-11-28T11:00:00')), false); // Saturday closed
});

test('inMarketSession routes by underlying', () => {
  const eveningWeekday = ist('2026-11-25T16:30:00');
  assert.equal(inMarketSession('NIFTY', eveningWeekday), false);
  assert.equal(inMarketSession('CRUDEOILM', eveningWeekday), true);
});

test('NSE F&O (orders, option premiums) trade to 15:40 IST; the index (cash) still closes at 15:30', () => {
  assert.equal(inNseFnoSession(ist('2026-11-25T15:35:00')), true);
  assert.equal(inNseFnoSession(ist('2026-11-25T15:39:59')), true);
  assert.equal(inNseFnoSession(ist('2026-11-25T15:40:00')), false);
  assert.equal(inNseFnoSession(ist('2026-11-25T09:14:59')), false);
  assert.equal(inNseFnoSession(ist('2026-11-24T11:00:00')), false); // holiday
  assert.equal(inOrderSession('NIFTY', ist('2026-11-25T15:35:00')), true);
  assert.equal(inMarketSession('NIFTY', ist('2026-11-25T15:35:00')), false); // no index candle after 15:30
  assert.equal(inOrderSession('CRUDEOILM', ist('2026-11-25T16:30:00')), true);
});

test('SENSEX: index candles 09:15-15:30, BSE F&O orders to 15:40, NSE/BSE holidays and evenings closed, 09:15 bar anchor', () => {
  assert.equal(inMarketSession('SENSEX', ist('2026-11-25T09:14:59')), false);
  assert.equal(inMarketSession('SENSEX', ist('2026-11-25T09:15:00')), true);
  assert.equal(inMarketSession('SENSEX', ist('2026-11-25T15:29:59')), true);
  assert.equal(inMarketSession('SENSEX', ist('2026-11-25T15:30:00')), false);
  assert.equal(inOrderSession('SENSEX', ist('2026-11-25T15:35:00')), true);
  assert.equal(inOrderSession('SENSEX', ist('2026-11-25T15:40:00')), false);
  assert.equal(inOrderSession('SENSEX', ist('2026-11-25T16:30:00')), false); // never MCX's evening
  assert.equal(inOrderSession('SENSEX', ist('2026-11-24T11:00:00')), false); // holiday
  assert.equal(inOrderSession('SENSEX', ist('2026-11-28T11:00:00')), false); // Saturday
  assert.equal(barAnchorSec('SENSEX'), 9 * 3600 + 15 * 60);
});
