import test from 'node:test';
import assert from 'node:assert/strict';
import { gbClosedBars, gbSession, gbEvents, hhmmToMin, gbClosedKey, gbSecondBars, tfSeconds } from './gearboxBars.ts';
import { computeGearbox } from './gearbox.ts';
import type { GbState, GhostTrade } from './gearbox.ts';

const IST = 19800;
// 2026-11-18 (a Wednesday, MCX open) 10:00 IST, unix s
const T = Date.UTC(2026, 10, 18, 10, 0) / 1000 - IST;

test('hhmmToMin', () => {
  assert.equal(hhmmToMin(900), 540);
  assert.equal(hhmmToMin(2315), 23 * 60 + 15);
});

test('gbSession reads the MCX session of the bar day', () => {
  const s = gbSession(T);
  assert.equal(s.openMin, 540);
  // November 18 is after the US DST end (first Sunday of November): winter, square-off 23:40
  assert.equal(s.autoExitMin, 23 * 60 + 40);
});

test('gbClosedBars: 5-minute buckets on the IST clock with OHLC and summed volume; the forming bar is dropped', () => {
  const m = (i: number, c: number, vol: number, h?: number, l?: number) => ({ t: T + i * 60, straddle: c, vol, h, l });
  const bars = [m(0, 100, 1, 101, 99), m(1, 102, 2, 103, 100), m(4, 101, 3), m(5, 105, 4, 106, 104), m(6, 106, 5)];
  const out = gbClosedBars(bars, 5, T + 7 * 60);
  assert.equal(out.length, 1, 'the 10:05 bucket is still forming');
  assert.deepEqual(out[0], { t: T, o: 100, h: 103, l: 99, c: 101, v: 6 });
  const all = gbClosedBars(bars, 5, T + 10 * 60);
  assert.equal(all.length, 2);
  assert.deepEqual(all[1], { t: T + 300, o: 105, h: 106, l: 104, c: 106, v: 9 });
});

test('gbClosedBars: a range that does not hold the close falls back to the close; bad prices are skipped', () => {
  const out = gbClosedBars([
    { t: T, straddle: 100, vol: 1, h: 99, l: 98 },
    { t: T + 60, straddle: 0, vol: 5 },
    { t: T + 120, straddle: NaN, vol: 5 },
  ], 1, T + 600);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { t: T, o: 100, h: 100, l: 100, c: 100, v: 1 });
});

test('gbClosedKey changes only when a bar closes', () => {
  const b = [{ t: T, straddle: 100, vol: 1 }, { t: T + 60, straddle: 101, vol: 1 }];
  const k1 = gbClosedKey(b, 1, T + 90, 0);
  const k2 = gbClosedKey([b[0], { ...b[1], straddle: 102 }], 1, T + 95, 0);
  assert.equal(k1, k2, 'the forming minute moving does not change the key');
  const k3 = gbClosedKey(b, 1, T + 125, 0);
  assert.notEqual(k1, k3);
});

const st = (p: Partial<GbState>): GbState => ({
  c: 100, gear: 1, mode: 1, armed: false, signal: false, vwOK: false, stOK: false, sd: 1, sl: 0, sp: 0, acc: 0, rpm: 0, alt: 0, t: T, sessionBar: 0, atr: 1, ...p,
});

test('gbEvents: mode changes, setups, shift-up signals and ghost trades, newest first', () => {
  const states = [
    st({ t: T, mode: 0, gear: 0 }),
    st({ t: T + 300, mode: 1, gear: 4 }),
    st({ t: T + 600, mode: 1, gear: 3, armed: true }),
    st({ t: T + 900, mode: 1, gear: 4, signal: true, c: 110 }),
    st({ t: T + 1200, mode: 1, gear: 5, c: 115 }),
  ];
  const ghost: GhostTrade[] = [{ side: 1, ei: 3, xi: 4, ep: 110, xp: 115, open: false, why: 'mode flipped' }];
  const ev = gbEvents(states, ghost, 0);
  const msgs = ev.map(e => e.msg);
  assert.equal(ev[0].t, T + 1200);
  assert.ok(msgs.some(m => /Mode change: now climbing/.test(m)));
  assert.ok(msgs.some(m => /setup armed/.test(m)));
  assert.ok(msgs.some(m => /Shift up to gear 4/.test(m)));
  assert.ok(msgs.some(m => /Ghost went long at 110/.test(m)));
  assert.ok(msgs.some(m => /Ghost closed \+5\.0 pts · mode flipped/.test(m)));
});

test('gbEvents: the open ghost trade has no exit line, and bars before `from` are ignored', () => {
  const states = [st({ t: T, mode: 1 }), st({ t: T + 300, mode: -1, gear: 2 }), st({ t: T + 600, mode: -1, gear: 3, c: 90 })];
  const ghost: GhostTrade[] = [{ side: -1, ei: 2, xi: 2, ep: 90, xp: 90, open: true, why: 'open' }];
  const ev = gbEvents(states, ghost, 2);
  assert.deepEqual(ev.map(e => e.msg), ['Ghost went short at 90.0']);
});

test('tfSeconds: seconds timeframes as whole seconds, minutes as null', () => {
  assert.equal(tfSeconds('5s'), 5);
  assert.equal(tfSeconds('30s'), 30);
  assert.equal(tfSeconds(1), null);
  assert.equal(tfSeconds(5), null);
});

test('gbSecondBars: one GbBar per closed 10 s tick bar, on whole seconds, nothing dropped as forming', () => {
  const s = (i: number, c: number, vol = 1) => ({ t: T + i * 10, straddle: c, vol });
  const out = gbSecondBars([s(0, 100), s(1, 101, 2), s(2, 0), s(3, 99, 3)], 10);
  assert.deepEqual(out.map(b => b.t), [T, T + 10, T + 30], 'a bad price is skipped; the last bar is kept (already closed)');
  assert.deepEqual(out[1], { t: T + 10, o: 101, h: 101, l: 101, c: 101, v: 2 });
});

test('gbSecondBars: buckets on the IST clock; two bars in one bucket merge; times never go back', () => {
  // 30 s buckets: 10:00:00 and 10:00:20 share one, 10:00:30 opens the next; an unaligned stamp lands in its own bucket's start
  const out = gbSecondBars([
    { t: T, straddle: 100, vol: 1 }, { t: T + 20, straddle: 103, vol: 1 }, { t: T + 30.7, straddle: 98, vol: 2 },
    { t: T + 29, straddle: 97, vol: 1 },   // out of order: folded into the bar it trails
  ], 30);
  assert.deepEqual(out, [
    { t: T, o: 100, h: 103, l: 100, c: 103, v: 2 },
    { t: T + 30, o: 98, h: 98, l: 97, c: 97, v: 3 },
  ]);
  assert.equal(gbSecondBars([{ t: T, straddle: 100, vol: 1 }], 0).length, 0, 'a bad size builds nothing');
});

test('computeGearbox on 10 s bars: session bar counts N-second bars from the MCX open, entry window stays in minutes', () => {
  const open = Date.UTC(2026, 10, 18, 9, 5) / 1000 - IST;   // 09:05 IST, 5 min after the 09:00 open
  const bars = Array.from({ length: 400 }, (_, i) => ({ t: open + i * 10, c: 100 + Math.sin(i / 7) * 2 + i * 0.05, v: 1 }));
  const st = computeGearbox(bars, gbSession);
  assert.equal(st[0].sessionBar, 30, '5 minutes = thirty 10 s bars after the open');
  assert.equal(st[399].sessionBar, 429);
  // 09:05 + 400 x 10 s = 10:11: no bar before 09:15 IST may signal (ENTRY_AFTER_OPEN_MIN)
  for (const s of st) if (s.t < open + 600) assert.equal(s.signal, false);
});

test('tfLabel names the real bar size', async () => {
  const { tfLabel } = await import('./gearboxBars.ts');
  assert.equal(tfLabel(1), '1-min');
  assert.equal(tfLabel(5), '5-min');
  assert.equal(tfLabel('10s'), '10-sec');
  assert.equal(tfLabel('30s'), '30-sec');
});
