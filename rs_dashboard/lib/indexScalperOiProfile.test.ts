import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOiProfile, fmtOI, oiBars, oiProfileKey } from './indexScalperOiProfile.ts';

const chain = {
  '25300': { strike: 25300, ce: { oi: 1_000_000 }, pe: { oi: 4_000_000 } },
  '25350': { strike: 25350, ce: { oi: 2_000_000 }, pe: { oi: 2_000_000 } },
  '25400': { strike: 25400, ce: { oi: 5_000_000 }, pe: { oi: 500_000 } },
  '25450': { strike: 25450, ce: { oi: 0 }, pe: { oi: 0 } }, // no OI either side: dropped
};

test('profile: sorted rows, empty strikes dropped, max Call / Put strikes found', () => {
  const p = buildOiProfile(chain)!;
  assert.deepEqual(p.rows.map(r => r.strike), [25300, 25350, 25400]);
  assert.equal(p.maxCeStrike, 25400);
  assert.equal(p.maxPeStrike, 25300);
  assert.equal(buildOiProfile(null), null);
  assert.equal(buildOiProfile({}), null);
  // the strike key is used when a row has no strike field (snapshot shape)
  assert.equal(buildOiProfile({ '6100': { ce: { oi: 5 }, pe: { oi: 0 } } })!.rows[0].strike, 6100);
});

test('key changes only with OI', () => {
  const a = oiProfileKey(buildOiProfile(chain));
  assert.equal(a, oiProfileKey(buildOiProfile(JSON.parse(JSON.stringify(chain)))));
  assert.notEqual(a, oiProfileKey(buildOiProfile({ ...chain, '25350': { strike: 25350, ce: { oi: 2_000_001 }, pe: { oi: 2_000_000 } } })));
  assert.equal(oiProfileKey(null), '');
});

test('bars: one shared scale, Call above / Put below the level, from the right edge, off-screen skipped', () => {
  const p = buildOiProfile(chain)!;
  // 1 point = 1 px, 25400 at y=100: strikes 50 px apart
  const yOf = (price: number) => 100 + (25400 - price);
  const bars = oiBars(p, yOf, 500, 400, 200);
  const ce400 = bars.find(b => b.strike === 25400 && b.side === 'CE')!;
  const pe300 = bars.find(b => b.strike === 25300 && b.side === 'PE')!;
  assert.equal(ce400.w, 200); // the largest OI on screen is the full width
  assert.equal(pe300.w, 160); // 4.0 / 5.0 of it
  assert.equal(ce400.x + ce400.w, 500); // grows leftwards from the right edge
  assert.equal(ce400.y + ce400.h, 100); // Call bar ends at the strike level (above it)
  assert.equal(pe300.y, 200); // Put bar starts at the strike level (below it)
  assert.equal(ce400.h, 14); // capped (half of a 50 px gap would be 24)
  assert.ok(ce400.max && pe300.max);
  assert.equal(bars.filter(b => b.max).length, 2);
  // a strike off screen is skipped
  assert.equal(oiBars(p, (price) => (price === 25400 ? -5 : yOf(price)), 500, 400, 200).some(b => b.strike === 25400), false);
  assert.deepEqual(oiBars(p, () => null, 500, 400, 200), []);
});

test('bars never overlap the next strike when strikes are close together', () => {
  const p = buildOiProfile(chain)!;
  const bars = oiBars(p, price => 100 + (25400 - price) / 10, 500, 400, 200); // 5 px apart
  for (const b of bars) assert.ok(2 * b.h < 5, `bar ${b.strike} ${b.side} h=${b.h}`); // a strike's two bars fit inside one 5 px gap
});

test('fmtOI', () => {
  assert.equal(fmtOI(12_345_678), '1.23 Cr');
  assert.equal(fmtOI(456_000), '4.56 L');
  assert.equal(fmtOI(7_800), '7.8 K');
  assert.equal(fmtOI(0), '—');
});
