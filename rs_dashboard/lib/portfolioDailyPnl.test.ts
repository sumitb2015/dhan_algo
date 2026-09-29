import { test } from 'node:test';
import assert from 'node:assert';
import { previousDaysPnl, type DailyPnlPoint } from './portfolioDailyPnl.ts';

const pt = (date: string, grossPnl: number, charges: number): DailyPnlPoint =>
  ({ date, grossPnl, charges, statutoryCharges: 0, netPnl: grossPnl - charges, tradeCount: 1 });

test('previousDaysPnl takes the last n market days before today, zero-filling untraded ones', () => {
  const r = previousDaysPnl({
    success: true, available: true,
    // 09-25 is a market day with no trades; 09-29 is today and must be excluded.
    marketTradingDates: ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'],
    dailyPnl: [pt('2026-09-23', 500, 10), pt('2026-09-24', 1000, 100), pt('2026-09-28', -300, 50), pt('2026-09-29', 9999, 0)],
  }, '2026-09-29', 3);
  assert.deepStrictEqual(r.days.map(d => [d.date, d.netPnl]), [['2026-09-28', -350], ['2026-09-25', 0], ['2026-09-24', 900]]);
  assert.deepStrictEqual({ gross: r.gross, charges: r.charges, net: r.net }, { gross: 700, charges: 150, net: 550 });
});

test('previousDaysPnl keeps a traded day the market calendar is missing', () => {
  const r = previousDaysPnl({
    success: true, available: true,
    marketTradingDates: ['2026-09-24', '2026-09-25'], // calendar CSV not yet refreshed for 09-28
    dailyPnl: [pt('2026-09-28', 100, 0)],
  }, '2026-09-29', 3);
  assert.deepStrictEqual(r.days.map(d => d.date), ['2026-09-28', '2026-09-25', '2026-09-24']);
});
