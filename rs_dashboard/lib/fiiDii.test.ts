import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cashSeries, fmtCr, longShortBias, metricChange, positionMetrics, statsNet, streak, sumLast,
  type CashDay, type FnoDay, type ParticipantRow,
} from './fiiDii.ts';

const flow = (net: number) => ({ buy: 100, sell: 100 - net, net });
const day = (date: string, fii: number, dii: number, nse = false): CashDay =>
  nse ? { date, nse: { fii: flow(fii), dii: flow(dii) } } : { date, combined: { fii: flow(fii), dii: flow(dii) } };

test('cash series keeps only days that carry the chosen source', () => {
  const rows = [day('2026-10-13', -1, 2), day('2026-10-14', -3, 4, true), day('2026-10-15', 5, -6)];
  const s = cashSeries(rows, 'combined');
  assert.deepEqual(s.map(p => p.date), ['2026-10-13', '2026-10-15']);
  assert.equal(s[1].total, -1);
});

test('sumLast refuses a partial window', () => {
  const s = cashSeries([day('a', 1, 0), day('b', 2, 0)], 'combined');
  assert.equal(sumLast(s, 2, 'fii'), 3);
  assert.equal(sumLast(s, 5, 'fii'), null);
});

test('streak counts same-sign sessions back from the latest', () => {
  const s = cashSeries([day('a', 5, 0), day('b', -1, 0), day('c', -2, 0), day('d', -3, 0)], 'combined');
  assert.equal(streak(s, 'fii'), -3);
  assert.equal(streak(cashSeries([day('a', -1, 0), day('b', 4, 0)], 'combined'), 'fii'), 1);
  assert.equal(streak([], 'fii'), 0);
});

const row = (over: Partial<ParticipantRow>): ParticipantRow => ({
  fut_idx_long: 0, fut_idx_short: 0, fut_stk_long: 0, fut_stk_short: 0,
  opt_idx_call_long: 0, opt_idx_put_long: 0, opt_idx_call_short: 0, opt_idx_put_short: 0,
  opt_stk_call_long: 0, opt_stk_put_long: 0, opt_stk_call_short: 0, opt_stk_put_short: 0,
  total_long: 0, total_short: 0, ...over,
});

test('position metrics from the NSE participant file (FII, 14-Oct-2026)', () => {
  const m = positionMetrics(row({
    fut_idx_long: 34282, fut_idx_short: 330979,
    opt_idx_call_long: 675757, opt_idx_call_short: 1008663,
    opt_idx_put_long: 1095900, opt_idx_put_short: 551135,
  }));
  assert.equal(m.idxFutNet, -296697);
  assert.ok(Math.abs(m.idxFutLongPct! - 9.385) < 0.01);
  assert.equal(m.idxCallNet, -332906);
  assert.equal(m.idxPutNet, 544765);
});

test('long share is null with no index futures at all', () => {
  assert.equal(positionMetrics(row({})).idxFutLongPct, null);
  assert.equal(longShortBias(null).label, '—');
  assert.equal(longShortBias(9.4).label, 'Very bearish');
  assert.equal(longShortBias(70).tone, 'bull');
});

test('day change is null without a prior session', () => {
  const cur = positionMetrics(row({ fut_idx_long: 10, fut_idx_short: 4 }));
  const prev = positionMetrics(row({ fut_idx_long: 8, fut_idx_short: 5 }));
  assert.equal(metricChange(cur, prev).idxFutNet, 3);
  assert.equal(metricChange(cur, null).idxFutNet, null);
});

test('stats net is buy minus sell, null when the file was missing', () => {
  const d = { date: 'x', oi: {} as FnoDay['oi'], fii_stats: { idx_fut: { buy_contracts: 1, buy_cr: 1426.84, sell_contracts: 1, sell_cr: 2527.84, oi_contracts: 0, oi_cr: 0 } } } as FnoDay;
  assert.equal(statsNet(d, 'idx_fut'), 1426.84 - 2527.84);
  assert.equal(statsNet(d, 'stk_fut'), null);
  assert.equal(statsNet(undefined, 'idx_fut'), null);
});

test('crore formatting uses Indian grouping and a real minus', () => {
  assert.equal(fmtCr(-5285.37), '−₹5,285.37 Cr');
  assert.equal(fmtCr(123456.7), '+₹1,23,456.70 Cr');
  assert.equal(fmtCr(null), '—');
});
