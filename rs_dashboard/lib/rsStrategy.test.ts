import { test } from 'node:test';
import assert from 'node:assert';
import { isBuy, isSell, evaluateStock, resampleWeekly, DEFAULT_PARAMS as DEFAULTS } from './rsStrategyCore.ts';
import { emaSmaSeeded } from './indicators.ts';

// Most tests use short synthetic series on which a 200-bar EMA cannot exist, so they run with the gate off.
const DEFAULT_PARAMS = { ...DEFAULTS, emaGate: false };
import { supertrendSeries } from './indicators.ts';

function mk(closes: number[], start = 0) {
  return closes.map((c, i) => {
    const d = new Date(Date.UTC(2024, 0, 1 + start + i)).toISOString().slice(0, 10);
    return { date: d, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 };
  });
}

test('buy needs RS>0, bullish Supertrend and RSI>min; sell needs both negative', () => {
  assert.equal(isBuy(0.1, 1, 60, 50), true);
  assert.equal(isBuy(0.1, 1, 45, 50), false);
  assert.equal(isBuy(0.1, 1, 45, 0), true); // RSI filter off
  assert.equal(isBuy(0.1, -1, 60, 50), false);
  assert.equal(isBuy(0, 1, 60, 50), false);
  assert.equal(isSell(-0.1, -1), true);
  assert.equal(isSell(0.1, -1), false);
  assert.equal(isSell(-0.1, 1), false);
});

test('HOLD: after a BUY, a Supertrend flip with RS still >0 is not an exit', () => {
  const up = Array.from({ length: 80 }, (_, i) => 50 + i * 1.25);
  const down = Array.from({ length: 10 }, (_, i) => up[79] - (i + 1) * 3);
  const closes = [...up, ...down];
  const idx = mk(Array(closes.length).fill(100));
  const r = evaluateStock('X', mk(closes), idx, DEFAULT_PARAMS)!;
  assert.equal(r.stDir, -1);
  assert.ok(r.rs > 0);
  assert.equal(r.signal, 'HOLD');
});

test('WAIT: RS>0 but price below a bearish Supertrend, never bought, is WAIT (not SELL)', () => {
  const stock = mk(Array.from({ length: 100 }, (_, i) => 100 - i * 0.15)); // 100 -> ~85
  const idx = mk(Array.from({ length: 100 }, (_, i) => 100 - i * 0.5)); // 100 -> ~50
  const r = evaluateStock('X', stock, idx, DEFAULT_PARAMS)!;
  assert.ok(r.rs > 0 && r.stDir === -1);
  assert.equal(r.signal, 'WAIT');
});

test('rsRising is true for 3 consecutive rising RS readings, false when RS is falling', () => {
  const idx = mk(Array(100).fill(100));
  const accel = mk(Array.from({ length: 100 }, (_, i) => 50 * Math.exp((i * i) / 2000)));
  assert.equal(evaluateStock('X', accel, idx, DEFAULT_PARAMS)!.rsRising, true);
  const fade = mk(Array.from({ length: 100 }, (_, i) => 100 - i * 0.5));
  assert.equal(evaluateStock('X', fade, idx, DEFAULT_PARAMS)!.rsRising, false);
});

test('RS formula: stock doubling vs flat index over 55 bars = RS 1.0 (a ratio, not a percent)', () => {
  const n = 100;
  const idx = mk(Array(n).fill(100));
  const stock = mk(Array.from({ length: n }, (_, i) => (i < n - 55 ? 50 : 50 + ((i - (n - 56)) / 55) * 50)));
  const r = evaluateStock('X', stock, idx, DEFAULT_PARAMS)!;
  assert.ok(Math.abs(r.rs - 1) < 1e-9, `rs=${r.rs}`);
  assert.equal(r.signal, 'BUY');
  assert.ok(r.close > r.supertrend);
});

test('steadily falling stock vs flat index is SELL', () => {
  const n = 100;
  const idx = mk(Array(n).fill(100));
  const stock = mk(Array.from({ length: n }, (_, i) => 100 - i * 0.5));
  const r = evaluateStock('X', stock, idx, DEFAULT_PARAMS)!;
  assert.equal(r.signal, 'SELL');
  assert.ok(r.rs < 0 && r.close < r.supertrend);
});

test('supertrend flips bearish after a sharp drop', () => {
  const closes = [...Array(30).fill(0).map((_, i) => 100 + i), ...Array(10).fill(0).map((_, i) => 129 - i * 6)];
  const st = supertrendSeries(mk(closes), 10, 2);
  assert.equal(st[29].dir, 1);
  assert.equal(st[st.length - 1].dir, -1);
});

test('short history is skipped', () => {
  const idx = mk(Array(40).fill(100));
  assert.equal(evaluateStock('X', mk(Array(40).fill(100)), idx, DEFAULT_PARAMS), null);
});

test('daysInSignal counts consecutive bars', () => {
  const n = 100;
  const idx = mk(Array(n).fill(100));
  const stock = mk(Array.from({ length: n }, (_, i) => 100 - i * 0.5));
  const r = evaluateStock('X', stock, idx, DEFAULT_PARAMS)!;
  assert.ok(r.daysInSignal > 5); // SELL phase counted from entering the flat/short state
});

test('resampleWeekly groups Mon-Sun, keeps OHLC semantics and dates each bar by its Monday', () => {
  // 2024-01-01 is a Monday. Days 0-4 = week 1 (Mon-Fri), day 7 = Mon of week 2, day 6 = Sun (week 1).
  const rows = [
    { date: '2024-01-01', open: 10, high: 12, low: 9, close: 11, volume: 1 },
    { date: '2024-01-02', open: 11, high: 15, low: 10, close: 14, volume: 2 },
    { date: '2024-01-05', open: 14, high: 14, low: 8, close: 9, volume: 3 },
    { date: '2024-01-08', open: 9, high: 10, low: 9, close: 10, volume: 4 },
  ];
  const w = resampleWeekly(rows);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { date: '2024-01-01', open: 10, high: 15, low: 8, close: 9, volume: 6 });
  assert.equal(w[1].date, '2024-01-08');
  // A stock halted on Friday must still share its week's date with the index.
  const idxWeek = resampleWeekly([...rows.slice(0, 3), { date: '2024-01-06', open: 9, high: 9, low: 9, close: 9, volume: 0 }]);
  assert.equal(idxWeek[0].date, w[0].date);
  assert.equal(rows[0].high, 12); // input not mutated
});

test('weekly signal: null on short history, BUY on a long steady outperformer', () => {
  const short = mk(Array.from({ length: 100 }, (_, i) => 50 + i));
  assert.equal(evaluateStock('X', short, mk(Array(100).fill(100)), DEFAULT_PARAMS)!.weekly, null);

  const n = 700; // ~100 weeks
  const idx = mk(Array(n).fill(100));
  const up = mk(Array.from({ length: n }, (_, i) => 50 * Math.exp(i / 300)));
  const r = evaluateStock('X', up, idx, DEFAULT_PARAMS)!;
  assert.equal(r.weekly, 'BUY');
  const down = mk(Array.from({ length: n }, (_, i) => 200 * Math.exp(-i / 300)));
  assert.equal(evaluateStock('X', down, idx, DEFAULT_PARAMS)!.weekly, 'SELL');
});

test('emaSmaSeeded matches TradingView ta.ema: SMA seed, null warm-up, then the standard recursion', () => {
  const e = emaSmaSeeded([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2); // SMA(1,2,3)
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5); // k = 2/(3+1) = 0.5
  assert.equal(e[4], 5 * 0.5 + 3 * 0.5);
  assert.deepEqual(emaSmaSeeded([1, 2], 3), [null, null]);
});

test('isBuy: the EMA term only ever blocks an entry', () => {
  assert.equal(isBuy(0.1, 1, 60, 50, true), true);
  assert.equal(isBuy(0.1, 1, 60, 50, false), false);
  assert.equal(isBuy(0.1, 1, 60, 50), true); // default = gate not applied
});

// 260 bars: a long steady climb (stock far above its 200 EMA), then a fall that carries price back under it.
const climb = Array.from({ length: 220 }, (_, i) => 50 * Math.exp(i / 150));
const flatIdx = (n: number) => mk(Array(n).fill(100));

test('EMA gate: a stock under its 200 EMA cannot be bought even when RS, Supertrend and RSI all pass', () => {
  // Falls hard then rebounds for 25 bars: RS>0 (vs a flat index it is up over 55 bars), price above its
  // short Supertrend, RSI high — yet still below the 200 EMA built from the earlier, higher prices.
  const closes = [...Array.from({ length: 200 }, (_, i) => 300 - i * 0.2), ...Array.from({ length: 60 }, (_, i) => 150 + i * 1.5)];
  const idx = flatIdx(closes.length);
  const gated = evaluateStock('X', mk(closes), idx, { ...DEFAULTS, emaGate: true })!;
  const open = evaluateStock('X', mk(closes), idx, { ...DEFAULTS, emaGate: false })!;
  assert.ok(gated.ema !== null && gated.close < gated.ema, `close ${gated.close} ema ${gated.ema}`);
  assert.equal(open.signal, 'BUY');
  assert.equal(gated.signal, 'WAIT'); // never bought, so not Hold either
});

test('EMA gate: a held stock that slips under its 200 EMA stays HOLD, because the gate is entry-only', () => {
  // Falls for 200 bars (EMA ends high), rebounds above the EMA for 40 bars (a buy), then dips back under it
  // while still well above its price 55 bars ago (RS > 0) — so neither RS nor price has hit the sell rule.
  const closes = [
    ...Array.from({ length: 200 }, (_, i) => 300 - i * 0.75),
    ...Array.from({ length: 40 }, (_, i) => 150 + (i / 39) * (260 - 150)),
    ...Array.from({ length: 25 }, (_, i) => 260 - ((i + 1) / 25) * (260 - 215)),
  ];
  const r = evaluateStock('X', mk(closes), flatIdx(closes.length), { ...DEFAULTS, emaGate: true })!;
  assert.ok(r.ema !== null && r.close < r.ema, 'precondition: price is under the 200 EMA');
  assert.ok(r.rs > 0, 'precondition: RS still positive');
  assert.equal(r.signal, 'HOLD');
});

test('EMA gate never blocks an exit: below the EMA with RS and Supertrend both negative is SELL either way', () => {
  const closes = [...climb, ...Array.from({ length: 80 }, (_, i) => climb[219] * Math.exp(-i / 25))];
  const idx = flatIdx(closes.length);
  const gated = evaluateStock('X', mk(closes), idx, { ...DEFAULTS, emaGate: true })!;
  const open = evaluateStock('X', mk(closes), idx, { ...DEFAULTS, emaGate: false })!;
  assert.equal(gated.signal, 'SELL');
  assert.equal(open.signal, 'SELL');
});

test('EMA gate: fewer than 200 bars means no EMA and no Buy; the EMA column is null, not 0', () => {
  const closes = Array.from({ length: 150 }, (_, i) => 50 + i);
  const r = evaluateStock('X', mk(closes), flatIdx(150), { ...DEFAULTS, emaGate: true })!;
  assert.equal(r.ema, null);
  assert.notEqual(r.signal, 'BUY');
  assert.equal(evaluateStock('X', mk(closes), flatIdx(150), { ...DEFAULTS, emaGate: false })!.signal, 'BUY');
});

test('weekly state ignores the EMA gate (a 200-week EMA would need ~4 years of history)', () => {
  const n = 700;
  const up = mk(Array.from({ length: n }, (_, i) => 50 * Math.exp(i / 300)));
  const r = evaluateStock('X', up, flatIdx(n), { ...DEFAULTS, emaGate: true })!;
  assert.equal(r.weekly, 'BUY');
});
