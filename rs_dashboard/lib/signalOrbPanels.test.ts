import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpec, closedBars } from './signalOrb.ts';
import { keyLevels, mtfTable, signalChanges, type Bar1m } from './signalOrbPanels.ts';

// 2026-11-18 03:45 UTC = 09:15 IST: three sessions of one-minute bars, price following `f(minuteIndex)`
const DAY0 = Date.UTC(2026, 10, 18, 3, 45) / 1000;
const session = (dayOffset: number, mins: number, f: (i: number) => number, vol = 100): Bar1m[] =>
  Array.from({ length: mins }, (_, i) => { const c = f(i); return { t: DAY0 + dayOffset * 86_400 + i * 60, straddle: c, h: c + 1, l: c - 1, vol }; });

test('keyLevels: today range + VWAP, previous session close / high / low; no volume = no VWAP', () => {
  const prev = session(0, 100, i => 1000 + i);          // 1000 .. 1099, high 1100, low 999, close 1099
  const today = session(1, 50, i => 1200 - i);          // 1200 .. 1151
  const k = keyLevels([...prev, ...today])!;
  assert.equal(k.day, '2026-11-19');
  assert.equal(k.prevDay, '2026-11-18');
  assert.equal(k.dayHigh, 1201);
  assert.equal(k.dayLow, 1150);
  assert.equal(k.prevClose, 1099);
  assert.equal(k.prevHigh, 1100);
  assert.equal(k.prevLow, 999);
  assert.ok(k.vwap !== null && k.vwap > 1150 && k.vwap < 1201);
  const none = keyLevels(session(0, 10, i => 500 + i, 0))!;
  assert.equal(none.vwap, null);
  assert.equal(none.prevClose, null);
  assert.equal(keyLevels([]), null);
});

test('signalChanges: newest first, whipsaw shows a negative move, the live colour is flagged', () => {
  // up, then down, then up: EMA 5 flips each time
  const rows = [...session(0, 60, i => 1000 + i * 2), ...session(0, 0, () => 0)];
  const down = Array.from({ length: 40 }, (_, i) => ({ t: DAY0 + (60 + i) * 60, straddle: 1118 - i * 3, h: 1119 - i * 3, l: 1117 - i * 3, vol: 100 }));
  const up = Array.from({ length: 40 }, (_, i) => ({ t: DAY0 + (100 + i) * 60, straddle: 1000 + i * 3, h: 1001 + i * 3, l: 999 + i * 3, vol: 100 }));
  const bars = closedBars([...rows, ...down, ...up], 1, DAY0 + 10_000 * 60);
  const ch = signalChanges([defaultSpec('ema', 'e')], bars, 10);
  assert.ok(ch.length >= 2);
  assert.equal(ch[0].now, true);
  assert.ok(ch.slice(1).every(c => !c.now));
  assert.ok(ch.every((c, i) => i === 0 || c.t < ch[i - 1].t));      // newest first
  const bear = ch.find(c => c.signal === 'BEAR');
  assert.ok(bear && bear.move !== null && bear.move > 0);            // the sell-off paid the bear colour
  assert.equal(signalChanges([], bars).length, 0);
});

test('mtfTable: one row per indicator, one cell per timeframe, orb colour per timeframe', () => {
  const bars = session(0, 400, i => 1000 + i);                       // a steady climb
  const t = mtfTable([defaultSpec('ema', 'e')], bars, DAY0 + 10_000 * 60);
  assert.equal(t.timeframes.length, 5);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].cells.length, 5);
  assert.equal(t.rows[0].cells[0].vote, 1);                          // 1m: price above its EMA
  assert.equal(t.signals[0], 'BULL');
  assert.ok(t.bull >= 1 && t.bear === 0);
  const empty = mtfTable([], bars, DAY0 + 10_000 * 60);
  assert.deepEqual(empty.signals, ['NEUTRAL', 'NEUTRAL', 'NEUTRAL', 'NEUTRAL', 'NEUTRAL']);
});
