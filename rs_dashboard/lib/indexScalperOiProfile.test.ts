import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOiProfile, fmtOI, fmtOIChange, oiBars, oiChange, oiProfileKey, placeOiLabels, oiBarsBelowChips, type OiBar } from './indexScalperOiProfile.ts';

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

test('OI change: exact from prev_oi; from a non-zero pct otherwise; unknown is null, never 0', () => {
  assert.equal(oiChange({ oi: 1_200_000, prev_oi: 1_000_000, oi_chg_pct: 20 }), 200_000);
  assert.equal(oiChange({ oi: 800_000, prev_oi: 1_000_000 }), -200_000); // shed OI is a real negative
  assert.equal(oiChange({ oi: 1_000_000, prev_oi: 1_000_000, oi_chg_pct: 0 }), 0); // real flat (baseline known)
  assert.equal(oiChange({ oi: 1_200_000, oi_chg_pct: 20 }), 200_000); // older bridge: backed out of the pct
  assert.equal(oiChange({ oi: 1_200_000, oi_chg_pct: 0 }), null); // 0.0 with no baseline = unknown
  assert.equal(oiChange({ oi: 1_200_000, prev_oi: 0, oi_chg_pct: 0 }), null);
  assert.equal(oiChange({ oi: 1_200_000 }), null);
  assert.equal(oiChange({ oi: 0, prev_oi: 1_000_000 }), null); // no current OI reading
  assert.equal(oiChange(null), null);
});

test('change mode: bars by |change|, shed OI flagged neg, unknown sides skipped, max = most OI added', () => {
  const p = buildOiProfile({
    '25300': { strike: 25300, ce: { oi: 1_000_000, prev_oi: 1_500_000 }, pe: { oi: 4_000_000, prev_oi: 3_000_000 } },
    '25350': { strike: 25350, ce: { oi: 2_000_000, prev_oi: 1_800_000 }, pe: { oi: 2_000_000, oi_chg_pct: 0 } },
    '25400': { strike: 25400, ce: { oi: 5_000_000, prev_oi: 4_800_000 }, pe: { oi: 500_000, prev_oi: 500_000 } },
  })!;
  assert.equal(p.hasChange, true);
  assert.equal(p.maxCeChgStrike, 25350); // 25350 and 25400 both added 2.0L: strict '>' keeps the first
  assert.equal(p.maxPeChgStrike, 25300); // +10L
  const yOf = (price: number) => 100 + (25400 - price);
  const bars = oiBars(p, yOf, 500, 400, 200, 'change');
  const ce300 = bars.find(b => b.strike === 25300 && b.side === 'CE')!;
  const pe300 = bars.find(b => b.strike === 25300 && b.side === 'PE')!;
  assert.equal(pe300.w, 200); // +10L is the largest magnitude on screen
  assert.equal(ce300.w, 100); // -5L: half of it, flagged as shed OI
  assert.equal(ce300.neg, true);
  assert.equal(ce300.oi, -500_000);
  assert.equal(bars.some(b => b.strike === 25350 && b.side === 'PE'), false); // unknown change: no bar
  assert.equal(bars.some(b => b.strike === 25400 && b.side === 'PE'), false); // real zero change: nothing to draw
  // total mode is unchanged by the change fields
  assert.equal(oiBars(p, yOf, 500, 400, 200).find(b => b.strike === 25400 && b.side === 'CE')!.w, 200);
});

test('no previous-day OI anywhere: hasChange false and no change bars', () => {
  const p = buildOiProfile({ '25300': { strike: 25300, ce: { oi: 1_000_000, oi_chg_pct: 0 }, pe: { oi: 2_000_000 } } })!;
  assert.equal(p.hasChange, false);
  assert.deepEqual(oiBars(p, () => 100, 500, 400, 200, 'change'), []);
  assert.equal(p.maxCeChgStrike, null);
});

test('fmtOIChange', () => {
  assert.equal(fmtOIChange(120_000), '+1.20L');
  assert.equal(fmtOIChange(-45_000), '-45.0K');
  assert.equal(fmtOIChange(0), '0');
});

const bar = (o: Partial<OiBar>): OiBar => ({ strike: 25000, side: 'CE', x: 400, y: 100, w: 100, h: 8, oi: 1_000_000, max: false, neg: false, ...o });

test('labels never overlap: the highlighted max first, then the largest OI; thin bars get none', () => {
  const bars = [
    bar({ strike: 1, y: 100, oi: 500_000 }),                // overlaps the next one vertically and horizontally
    bar({ strike: 2, y: 104, oi: 2_000_000 }),              // larger: wins
    bar({ strike: 3, y: 106, oi: 100_000, max: true }),     // highlighted max: placed first
    bar({ strike: 4, y: 200, oi: 50_000 }),                 // far away: kept
    bar({ strike: 5, y: 300, oi: 9_000_000, h: 2 }),        // too thin for text
  ];
  const got = placeOiLabels(bars, () => 40);
  assert.deepEqual([...got].sort(), [2, 3]); // max (index 2) and the far bar (index 3) only
  // side by side horizontally (different bar ends) at the same height do not collide
  const side = [bar({ x: 400, y: 100 }), bar({ x: 200, y: 100, oi: 10 })];
  assert.equal(placeOiLabels(side, () => 40).size, 2);
  // every placed pair is disjoint
  const many = Array.from({ length: 60 }, (_, i) => bar({ strike: i, y: 50 + i * 3, x: 300 + (i % 5) * 10, oi: (i * 7919) % 1000 }));
  const idx = [...placeOiLabels(many, () => 36)];
  for (const a of idx) for (const b of idx) {
    if (a >= b) continue;
    const A = many[a], B = many[b];
    const overlapY = Math.abs((A.y + A.h / 2) - (B.y + B.h / 2)) < 11;
    const overlapX = (A.x - 3 - 36) < (B.x - 3) && (A.x - 3) > (B.x - 3 - 36);
    assert.ok(!(overlapX && overlapY), `labels ${a} and ${b} overlap`);
  }
});

test('oiBarsBelowChips: a strike under a position chip gets its Call / Put bars just below the chip', () => {
  const bar = (strike: number, side: 'CE' | 'PE', y: number, h = 10): OiBar => ({ strike, side, x: 100, y, w: 50, h, oi: 1000, max: false, neg: false });
  // strike 25800 at y=200 (CE 190-200, PE 200-210), 25850 at y=130 (no chip)
  const bars = [bar(25850, 'CE', 120), bar(25850, 'PE', 130), bar(25800, 'CE', 190), bar(25800, 'PE', 200)];
  const out = oiBarsBelowChips(bars, [{ top: 189, bottom: 213 }]);
  assert.deepEqual(out.map(b => [b.strike, b.side, b.y]), [[25850, 'CE', 120], [25850, 'PE', 130], [25800, 'CE', 215], [25800, 'PE', 225]]);
  assert.equal(out[2].h, 10); assert.equal(out[2].w, 50); // size kept
  // no chip: unchanged (same array)
  assert.equal(oiBarsBelowChips(bars, []), bars);
  // two chips stacked (CE and PE positions on one strike, pushed 26 px apart): below both
  const two = oiBarsBelowChips(bars, [{ top: 189, bottom: 213 }, { top: 215, bottom: 239 }]);
  assert.deepEqual(two.slice(2).map(b => b.y), [241, 251]);
  // only a Put bar on the strike, touching the chip's lower edge: moved too
  const pe = oiBarsBelowChips([bar(25800, 'PE', 200)], [{ top: 180, bottom: 204 }]);
  assert.equal(pe[0].y, 206);
});
