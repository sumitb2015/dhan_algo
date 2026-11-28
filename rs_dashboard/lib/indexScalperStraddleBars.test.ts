import test from 'node:test';
import assert from 'node:assert/strict';
import { combineStraddleBars, straddleLive } from './indexScalperStraddleBars.ts';

test('combine: joins on time, sums open / close and volume, range from opposite extremes (combine_legs_ohlc)', () => {
  const ce = [
    { t: 60, o: 100, h: 110, l: 95, c: 105, v: 10 },
    { t: 120, o: 105, h: 108, l: 100, c: 101, v: 5 },
    { t: 180, o: 101, h: 102, l: 99, c: 100, v: 1 }, // PE did not trade this minute: dropped
  ];
  const pe = [
    { t: 120, o: 90, h: 96, l: 88, c: 95, v: 7 },
    { t: 60, o: 92, h: 94, l: 85, c: 90, v: 20 },
  ];
  const s = combineStraddleBars(ce, pe);
  assert.equal(s.length, 2);
  // up = 110 + 85 = 195, down = 95 + 94 = 189, open 192, close 195 -> high 195, low 189
  assert.deepEqual(s[0], { t: 60, o: 192, h: 195, l: 189, c: 195, v: 30 });
  // up = 108 + 88 = 196, down = 100 + 96 = 196, open 195, close 196 -> high 196, low 195
  assert.deepEqual(s[1], { t: 120, o: 195, h: 196, l: 195, c: 196, v: 12 });
});

test('combine: no volume unless both legs have it; empty legs give no bars', () => {
  assert.equal(combineStraddleBars([{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 3 }], [{ t: 1, o: 2, h: 2, l: 2, c: 2 }])[0].v, undefined);
  assert.deepEqual(combineStraddleBars([], [{ t: 1, o: 2, h: 2, l: 2, c: 2 }]), []);
});

test('live price: both legs or nothing', () => {
  assert.equal(straddleLive(120.5, 99.5), 220);
  assert.equal(straddleLive(120.5, null), null);
  assert.equal(straddleLive(undefined, 99), null);
  assert.equal(straddleLive(0, 99), null);
});
