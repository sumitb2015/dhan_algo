import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NSE_HOLIDAYS, isNseTradingDay, isRegularSession, istDateIso } from './nseHolidays.ts';
import { isNseLive } from './marketHours.ts';
import { indianMarketState } from './marketStatus.ts';

// NSE equity holidays for 2026: https://www.nseindia.com/resources/exchange-communication-holidays
const NSE_2026 = [
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
];

test('2026 holidays match NSE', () => {
  assert.deepEqual([...NSE_HOLIDAYS].filter(d => d.startsWith('2026')).sort(), NSE_2026);
});

test('only weekday holidays are listed', () => {
  for (const d of NSE_HOLIDAYS) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    assert.ok(day !== 0 && day !== 6, d);
  }
});

test('isNseTradingDay', () => {
  assert.equal(isNseTradingDay('2026-10-02'), false);   // Gandhi Jayanti
  assert.equal(isNseTradingDay('2026-10-03'), false);   // Saturday
  assert.equal(isNseTradingDay('2026-10-05'), true);
  assert.equal(isNseTradingDay('2030-01-02'), true);    // year not listed → weekdays only
});

test('istDateIso uses the IST calendar day', () => {
  // 2026-10-01 20:00 UTC is already 2026-10-02 01:30 IST.
  assert.equal(istDateIso(Date.parse('2026-10-01T20:00:00Z')), '2026-10-02');
});

test('NSE live / market state close on a holiday, MCX keeps its own calendar', () => {
  const holidayMidday = Date.parse('2026-10-02T06:00:00Z');   // Fri 11:30 IST, Gandhi Jayanti
  const normalMidday = Date.parse('2026-10-01T06:00:00Z');    // Thu 11:30 IST
  assert.equal(isNseLive(new Date(holidayMidday)), false);
  assert.equal(isNseLive(new Date(normalMidday)), true);
  assert.equal(indianMarketState(holidayMidday, false, false), 'closed');
  assert.equal(indianMarketState(normalMidday, false, false), 'live');
  assert.equal(indianMarketState(holidayMidday, true, false), 'live');   // MCX not modelled
});

test('Muhurat is a trading day but not a regular session', () => {
  assert.equal(isNseTradingDay('2024-11-01'), true);
  assert.equal(isRegularSession('2024-11-01'), false);
  assert.equal(isRegularSession('2025-10-21'), false);   // NSE also lists it as a holiday
  assert.equal(isRegularSession('2024-11-04'), true);
});

test('pre-2026 years corrected from NSE', () => {
  for (const [wrong, right] of [['2023-06-28', '2023-06-29'], ['2023-11-13', '2023-11-14'], ['2024-04-10', '2024-04-11']]) {
    assert.equal(isNseTradingDay(wrong), true);
    assert.equal(isNseTradingDay(right), false);
  }
  for (const d of ['2024-01-22', '2024-05-20', '2024-11-20', '2025-10-22', '2025-11-05']) assert.equal(isNseTradingDay(d), false);
});
