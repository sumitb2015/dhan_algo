import { test } from 'node:test';
import assert from 'node:assert';
import {
  sessionVwap, sessionStartFor, closedBarsOnly, computeIndicators, evaluateBearish, recordTick, mergeBars, passesFilters, oiView, type LiveMinutes,
} from './bearishStrikes.ts';
import type { Bar } from './volumeProfile.ts';

const pad = (n: number) => String(n).padStart(2, '0');
function mk(n: number, price: (i: number) => number, v = 100, day = '2026-10-14'): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const mins = 9 * 60 + 15 + i;
    const c = price(i);
    return { t: `${day} ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`, o: c, h: c + 1, l: c - 1, c, v };
  });
}
const NOW = Date.UTC(2026, 9, 14, 15, 0); // IST-shifted axis, well after the bars

test('sessionVwap resets each day and is null with zero volume', () => {
  const a = mk(2, () => 100, 0);
  assert.deepStrictEqual(sessionVwap(a), [null, null]);
  const two = [...mk(2, () => 100, 10, '2026-10-13'), ...mk(2, () => 50, 10, '2026-10-14')];
  const vw = sessionVwap(two);
  assert.ok(Math.abs((vw[3] as number) - 50) < 1e-9);
});

test('closedBarsOnly drops the forming bar', () => {
  const bars = mk(3, () => 100);
  const lastStart = Date.UTC(2026, 9, 14, 9, 17);
  assert.strictEqual(closedBarsOnly(bars, 1, lastStart + 30_000).length, 2);
  assert.strictEqual(closedBarsOnly(bars, 1, lastStart + 60_000).length, 3);
});

test('warm-up gives null signal, not bearish', () => {
  const sig = evaluateBearish(computeIndicators(mk(15, () => 100), 1, NOW));
  assert.strictEqual(sig.bearish, null);
});

test('steady decline is bearish on all three', () => {
  const sig = evaluateBearish(computeIndicators(mk(60, (i) => 200 - i * 2), 1, NOW));
  assert.strictEqual(sig.bearish, true);
});

test('steady rise is not bearish', () => {
  const sig = evaluateBearish(computeIndicators(mk(60, (i) => 100 + i * 2), 1, NOW));
  assert.strictEqual(sig.bearish, false);
});

test('recordTick builds minute OHLC; mergeBars extends, appends and keeps API volume', () => {
  const api = mk(2, () => 100, 50);                       // 09:15, 09:16
  const live: LiveMinutes = new Map();
  recordTick(live, 90, Date.UTC(2026, 9, 14, 9, 16, 10));  // same minute as last API bar
  recordTick(live, 95, Date.UTC(2026, 9, 14, 9, 16, 40));
  recordTick(live, 80, Date.UTC(2026, 9, 14, 9, 18, 5));   // gap minute 09:17 missing, 09:18 live-only
  recordTick(live, -1, Date.UTC(2026, 9, 14, 9, 18, 6));   // ignored
  const m = mergeBars(api, live);
  assert.strictEqual(m.length, 3);
  assert.strictEqual(m[1].v, 50);
  assert.strictEqual(m[1].c, 95);
  assert.strictEqual(m[1].l, 90);
  assert.strictEqual(m[2].v, 0);
  assert.strictEqual(m[2].c, 80);
});

test('mergeBars never rewrites an earlier (final) backfilled minute with live prints', () => {
  const api = mk(3, () => 100, 50);                       // 09:15, 09:16, 09:17
  const live: LiveMinutes = new Map();
  recordTick(live, 140, Date.UTC(2026, 9, 14, 9, 15, 30)); // a stale/odd print inside a closed minute
  const m = mergeBars(api, live);
  assert.strictEqual(m[0].c, 100);
  assert.strictEqual(m[0].h, 101);
});

test('passesFilters honours side, OTM and the individual conditions', () => {
  const sig = evaluateBearish(computeIndicators(mk(60, (i) => 200 - i * 2), 1, NOW));
  const row = { option: 'CE' as const, strike: 24500, ltp: 80, oi: 6500, volume: 6500, spreadPct: 1, sig };
  const f = { side: 'BOTH' as const, minLtp: 5, minOiLots: 1, minVolLots: 1, maxSpreadPct: 5, otmOnly: true, requireSt: true, requireVwap: true, requireEma: true };
  assert.strictEqual(passesFilters(row, 24400, 65, f), true);
  assert.strictEqual(passesFilters(row, 24600, 65, f), false);          // ITM CE
  assert.strictEqual(passesFilters(row, 24400, 65, { ...f, side: 'PE' }), false);
  assert.strictEqual(passesFilters({ ...row, spreadPct: 9 }, 24400, 65, f), false);
});

test('each condition filter is independent; warming-up fails a ticked condition', () => {
  const warm = evaluateBearish(computeIndicators(mk(15, () => 100), 1, NOW));   // too few bars: ST/EMA null
  const row = { option: 'CE' as const, strike: 24500, ltp: 80, oi: 6500, volume: 6500, spreadPct: null, sig: warm };
  const f = { side: 'BOTH' as const, minLtp: 5, minOiLots: 0, minVolLots: 0, maxSpreadPct: 0, otmOnly: false, requireSt: false, requireVwap: false, requireEma: false };
  assert.strictEqual(passesFilters(row, 24400, 65, f), true);                         // nothing ticked
  assert.strictEqual(passesFilters(row, 24400, 65, { ...f, requireSt: true }), false);
  assert.strictEqual(passesFilters(row, 24400, 65, { ...f, requireEma: true }), false);
  const dec = evaluateBearish(computeIndicators(mk(60, (i) => 200 - i * 2), 1, NOW));
  assert.strictEqual(passesFilters({ ...row, sig: dec }, 24400, 65, { ...f, requireSt: true, requireVwap: true }), true);
});

test('prior-day history warms Supertrend/EMA20 at the open; VWAP is today only', () => {
  const prev = mk(375, (i) => 300 - i * 0.2, 100, '2026-10-13');         // full prior session, falling
  const today = mk(8, (i) => 200 - i, 100, '2026-10-14');                // 09:15-09:22 today
  const NOW_0923 = Date.UTC(2026, 9, 14, 9, 23);
  const cold = computeIndicators(today, 1, NOW_0923);
  assert.strictEqual(cold.ema, null);                                    // today alone: still warming up
  const warm = computeIndicators([...prev, ...today], 1, NOW_0923);
  assert.notStrictEqual(warm.ema, null);
  assert.notStrictEqual(warm.stLine, null);
  // VWAP must ignore yesterday's 300-ish prices: it sits near today's 196-200 range
  assert.ok((warm.vwap as number) < 205 && (warm.vwap as number) > 190, String(warm.vwap));
  assert.strictEqual(warm.barTime, '2026-10-14 09:22:00');
});

test('3-minute bars are built per day on the 09:15 grid across the day boundary', () => {
  const prev = mk(375, (i) => 300 - i * 0.2, 100, '2026-10-13');
  const today = mk(12, (i) => 200 - i, 100, '2026-10-14');
  const ind = computeIndicators([...prev, ...today], 3, Date.UTC(2026, 9, 14, 9, 40));
  assert.strictEqual(ind.barTime, '2026-10-14 09:24:00');                // last fully closed 3m bucket
  assert.notStrictEqual(ind.ema, null);
});

test('oiView: bearish + SB/LU confirms, bearish + LB conflicts, others and non-bearish are neutral', () => {
  const bear = evaluateBearish(computeIndicators(mk(60, (i) => 200 - i * 2), 1, NOW));
  const bull = evaluateBearish(computeIndicators(mk(60, (i) => 100 + i * 2), 1, NOW));
  assert.strictEqual(bear.bearish, true);
  assert.strictEqual(oiView('SB', bear), 'confirm');
  assert.strictEqual(oiView('LU', bear), 'confirm');
  assert.strictEqual(oiView('LB', bear), 'conflict');
  assert.strictEqual(oiView('SC', bear), null);
  assert.strictEqual(oiView('', bear), null);
  assert.strictEqual(oiView(undefined, bear), null);
  assert.strictEqual(oiView('LB', bull), null);                       // signal not bearish: nothing to disagree with
  assert.strictEqual(oiView('SB', { bearish: null }), null);          // still warming up
});

test('oiMode filter: confirm keeps SB/LU only, no-conflict drops LB only', () => {
  const sig = evaluateBearish(computeIndicators(mk(60, (i) => 200 - i * 2), 1, NOW));
  const f = { side: 'BOTH' as const, minLtp: 0, minOiLots: 0, minVolLots: 0, maxSpreadPct: 0, otmOnly: false, requireSt: true, requireVwap: true, requireEma: true };
  const row = (b: string) => ({ option: 'CE' as const, strike: 24500, ltp: 80, oi: 1, volume: 1, spreadPct: null, sig, buildup: b });
  for (const [b, confirm, noConflict] of [['SB', true, true], ['LU', true, true], ['LB', false, false], ['SC', false, true], ['', false, true]] as const) {
    assert.strictEqual(passesFilters(row(b), 24400, 1, { ...f, oiMode: 'confirm' }), confirm, `confirm ${b}`);
    assert.strictEqual(passesFilters(row(b), 24400, 1, { ...f, oiMode: 'no-conflict' }), noConflict, `no-conflict ${b}`);
    assert.strictEqual(passesFilters(row(b), 24400, 1, { ...f, oiMode: 'any' }), true);
  }
});

test('maxLtp keeps only premiums at or below it (0 = off)', () => {
  const f = { side: 'BOTH' as const, minLtp: 0, minOiLots: 0, minVolLots: 0, maxSpreadPct: 0, otmOnly: false, requireSt: false, requireVwap: false, requireEma: false };
  const sig = { below: { st: true, vwap: true, ema: true } } as never;
  const row = (ltp: number) => ({ option: 'PE' as const, strike: 8800, ltp, oi: 0, volume: 0, spreadPct: null, sig });
  assert.strictEqual(passesFilters(row(50), 9000, 1, { ...f, maxLtp: 50 }), true);
  assert.strictEqual(passesFilters(row(50.05), 9000, 1, { ...f, maxLtp: 50 }), false);
  assert.strictEqual(passesFilters(row(500), 9000, 1, { ...f, maxLtp: 0 }), true);
});

test('MCX 3m buckets keep 09:00-09:14 bars out of the 09:15 bucket', () => {
  const bars: Bar[] = Array.from({ length: 30 }, (_, i) => {
    const mins = 9 * 60 + i;
    return { t: `2026-10-14 ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`, o: 100, h: 101, l: 99, c: 100, v: 10 };
  });
  const mcx = computeIndicators(bars, 3, NOW, undefined, sessionStartFor('CRUDEOILM'));
  assert.strictEqual(mcx.barsUsed, 10);                   // 30 minutes / 3, none merged
  const nse = computeIndicators(bars, 3, NOW);             // NSE anchor would fold the first 15 minutes into one bar
  assert.strictEqual(nse.barsUsed, 5);
});
