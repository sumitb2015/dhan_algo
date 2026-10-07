import { test } from 'node:test';
import assert from 'node:assert';
import { buildGexRows, chainGamma, fmtGex, gammaFlip, gexChecklist, gexLevels, gexCalcTable, gexValue, topTwo, type GexRow } from './gex.ts';

const row = (strike: number, netGex: number, ceGex = Math.max(netGex, 0), peGex = Math.min(netGex, 0)): GexRow => ({
  strike, ceOi: 1, peOi: 1, ceGamma: 0, peGamma: 0, ceGex, peGex, netGex,
});

test('gamma flip is the midpoint of the negative-to-positive strikes (video: -597 at 24,200, +250 at 24,250 -> ~24,225)', () => {
  const flip = gammaFlip([row(24150, -900), row(24200, -597), row(24250, 250), row(24300, 800)]);
  assert.strictEqual(flip, 24225);
});

test('gamma flip counts only negative-to-positive changes, and skips zero-net strikes', () => {
  // Positive to negative is not the flip.
  assert.strictEqual(gammaFlip([row(100, 5), row(150, -9)]), null);
  // A strike with zero net GEX (no gamma reported) carries no sign: the flip is between the last negative and next positive strike.
  assert.strictEqual(gammaFlip([row(100, -4), row(150, 0), row(200, 6)]), 150);
});

test('gamma flip is null when net GEX never changes sign', () => {
  assert.strictEqual(gammaFlip([row(100, 5), row(150, 9)]), null);
  assert.strictEqual(gammaFlip([row(100, -5), row(150, -9)]), null);
});

test('with several negative-to-positive changes the one nearest spot is used (the video shows a single flip)', () => {
  const rows = [row(100, -1), row(150, 1), row(200, -1), row(250, 1)];
  assert.strictEqual(gammaFlip(rows, 240), 225);
  assert.strictEqual(gammaFlip(rows, 110), 125);
});

test('levels: walls, pin, regime from spot vs flip', () => {
  const rows = [
    row(24000, -400, 50, -400),
    row(24200, -100, 300, -400),
    row(24250, 250, 350, -100),
    row(24500, 500, 500, 0),
  ];
  const above = gexLevels(rows, 24300);
  assert.strictEqual(above.callWall, 24500);
  assert.strictEqual(above.putWall, 24000);
  assert.strictEqual(above.pin, 24200);
  assert.strictEqual(above.regime, 'positive');
  assert.strictEqual(gexLevels(rows, 24100).regime, 'negative');
  assert.strictEqual(gexLevels(rows).regime, 'unknown');
});

test('empty chain yields unknown levels, not NaN', () => {
  const l = gexLevels([], 24000);
  assert.strictEqual(l.regime, 'unknown');
  assert.strictEqual(l.flip, null);
});

test('video formula: 0.0008 x 50,000 lots x 65 x 24,200 x 0.01 = 629,200 index units; Rs 1,522.66 Cr with spot squared', () => {
  const oiUnits = 50_000 * 65;
  assert.strictEqual(Math.round(gexValue(0.0008, oiUnits, 24200, 1)), 629_200);
  assert.ok(Math.abs(gexValue(0.0008, oiUnits, 24200, 2) / 1e7 - 1522.664) < 0.001);
  // The slide's "Rs 62.9 Cr" is the same product without the x 0.01, in rupees: 62,920,000 = Rs 6.292 Cr.
  assert.strictEqual(Math.round(gexValue(0.0008, oiUnits, 24200, 1) * 100), 62_920_000);
});

test('topTwo returns the leader and runner-up, ignoring non-positive values', () => {
  const t = topTwo([{ strike: 1, v: 100 }, { strike: 2, v: 95 }, { strike: 3, v: 0 }, { strike: 4, v: -5 }]);
  assert.deepStrictEqual(t, { leader: { strike: 1, v: 100 }, runnerUp: { strike: 2, v: 95 } });
  assert.deepStrictEqual(topTwo([]), { leader: null, runnerUp: null });
});

const lv = (over: Partial<ReturnType<typeof gexLevels>>) => ({ ...gexLevels([], 100), ...over });


const two = (a: [number, number], b?: [number, number]) => ({ leader: { strike: a[0], v: a[1] }, runnerUp: b ? { strike: b[0], v: b[1] } : null });

test('checklist: items 1 and 2 are independent (positive total with spot below the flip is green then red)', () => {
  const items = gexChecklist({
    levels: lv({ regime: 'negative', flip: 24300, totalNet: 5e8 }),
    spot: 24200, vix: 14, call: two([24500, 4502]), put: two([24000, 4117]),
  });
  assert.strictEqual(items[0].tone, 'ok');
  assert.strictEqual(items[1].tone, 'bad'); // flip is above spot
  assert.strictEqual(items[2].tone, 'ok');
  assert.strictEqual(items[3].tone, 'manual');
});

test('checklist: VIX bands, missing data, and walls-clear is shown for judging, never auto-graded', () => {
  const good = gexChecklist({
    levels: lv({ regime: 'positive', flip: 24100, totalNet: 5e8 }),
    spot: 24200, vix: 15, call: two([24500, 4502], [24200, 3323]), put: two([24000, 4117], [24200, 3920]),
  });
  assert.deepStrictEqual(good.map(i => i.tone), ['ok', 'ok', 'ok', 'manual', 'manual']);
  assert.ok(good[4].detail.includes('24,500') && good[4].detail.includes('24,200'));
  const edge = (vix: number | null) => gexChecklist({ levels: lv({ regime: 'positive', flip: 1, totalNet: 1 }), spot: 2, vix, call: two([1, 5]), put: two([2, 5]) });
  assert.strictEqual(edge(19)[2].tone, 'warn');
  assert.strictEqual(edge(25)[2].tone, 'bad');
  assert.strictEqual(edge(null)[2].tone, 'manual');
  const none = gexChecklist({ levels: lv({}), spot: 0, vix: null, call: two([0, 0]), put: two([0, 0]) });
  assert.deepStrictEqual(none.map(i => i.tone), ['manual', 'manual', 'manual', 'manual', 'manual']);
  // A negative total is red, not amber.
  assert.strictEqual(gexChecklist({ levels: lv({ regime: 'negative', flip: 24300, totalNet: -1 }), spot: 24200, vix: 14, call: two([1, 1]), put: two([1, 1]) })[0].tone, 'bad');
});

test('fmtGex tiers are consistent', () => {
  assert.strictEqual(fmtGex(5.97e7), '5.97 Cr');
  assert.strictEqual(fmtGex(-5.972e10), '-5,972 Cr');
  assert.strictEqual(fmtGex(1.5e5), '1.50L');
  assert.strictEqual(fmtGex(1234), '1.2K');
  assert.strictEqual(fmtGex(12), '12');
});

test('buildGexRows: Dhan chain gamma x OI units x spot x 0.01, the video\'s formula (worked example 629,200 units)', () => {
  // The video's worked example: gamma 0.0008, 50,000 lots of 65, spot 24,200.
  const oc = { '24500': { ce: { oi: 50_000 * 65, greeks: { gamma: 0.0008 } }, pe: { oi: 0 } } };
  const [r] = buildGexRows(oc, { spot: 24200 });
  assert.strictEqual(Math.round(r.ceGex), 629_200);
  assert.strictEqual(r.ceGamma, 0.0008);
  // k = 2 gives the rupee notional, Rs 1,522.66 Cr.
  const [r2] = buildGexRows(oc, { spot: 24200, power: 2 });
  assert.ok(Math.abs(r2.ceGex / 1e7 - 1522.664) < 0.001);
});

test('buildGexRows: call positive, put negative; chain IV and expiry play no part', () => {
  const oc = {
    '24000.000000': {
      ce: { oi: 1000, implied_volatility: 14, greeks: { gamma: 0.0007 } },
      pe: { oi: 1000, implied_volatility: 99, greeks: { gamma: 0.0007 } },
    },
  };
  const [r] = buildGexRows(oc, { spot: 24200 });
  assert.ok(r.ceGex > 0 && r.peGex < 0);
  assert.ok(Math.abs(r.ceGex - 0.0007 * 1000 * 24200 * 0.01) < 1e-9);
  assert.ok(Math.abs(r.netGex) < 1e-9); // same gamma, same OI: net zero
});

test('buildGexRows: a leg with no chain gamma is zero, never a guess; no spot gives no rows', () => {
  const oc = { '24000': { ce: { oi: 1000, implied_volatility: 14 }, pe: { oi: 500, greeks: { gamma: 0.0005 } } } };
  const [r] = buildGexRows(oc, { spot: 24200 });
  assert.strictEqual(r.ceGex, 0);
  assert.ok(r.peGex < 0);
  assert.ok(Math.abs(r.peGex + 0.0005 * 500 * 24200 * 0.01) < 1e-9);
  assert.deepStrictEqual(buildGexRows(oc, { spot: 0 }), []);
  assert.strictEqual(chainGamma({ oi: 1, greeks: { gamma: -1 } }), 0);
});

test('OI is never rescaled by lot size unless the caller declares lots (no divisibility guessing)', () => {
  // OI of 100 and 130 is not a multiple of 65, the case an auto-detector would misread as lots.
  const oc = { '24000': { ce: { oi: 100, greeks: { gamma: 0.0007 } } } };
  const [u] = buildGexRows(oc, { spot: 24200, lotSize: 65 });
  const [again] = buildGexRows(oc, { spot: 24200, lotSize: 75 });
  assert.strictEqual(u.ceGex, again.ceGex);
  const [lots] = buildGexRows(oc, { spot: 24200, lotSize: 65, oiUnit: 'lots' });
  assert.ok(Math.abs(lots.ceGex / u.ceGex - 65) < 1e-9);
  // Lots declared but no lot size to convert with: refuse rather than guess.
  assert.deepStrictEqual(buildGexRows(oc, { spot: 24200, lotSize: 0, oiUnit: 'lots' }), []);
});

test('gexCalcTable shows Dhan gamma x OI x spot per strike and sums to buildGexRows', () => {
  const oc = {
    '24000': { ce: { oi: 130000, greeks: { gamma: 0.0005 } }, pe: { oi: 650000, greeks: { gamma: 0.0006 } } },
    '24200': { ce: { oi: 260000, greeks: { gamma: 0.0009 } }, pe: { oi: 390000, greeks: { gamma: 0.0008 } } },
    '24400': { ce: { oi: 650000, greeks: { gamma: 0.0004 } }, pe: { oi: 0 } },
  };
  const p = { spot: 24200, lotSize: 65, power: 2 as const };
  const rows = buildGexRows(oc, p);
  const tab = gexCalcTable(oc, p);
  assert.strictEqual(tab.spot, 24200);
  assert.strictEqual(tab.lot, 65);
  assert.strictEqual(gexCalcTable(oc, { spot: 24200 }).lot, null);
  assert.strictEqual(tab.source, 'dhan');
  assert.strictEqual(tab.price, 24200);
  assert.strictEqual(tab.rows.length, rows.length);
  tab.rows.forEach((r, i) => {
    assert.strictEqual(r.strike, rows[i].strike);
    assert.ok(Math.abs(r.netGex - rows[i].netGex) <= Math.abs(rows[i].netGex) * 1e-12);
    for (const x of [r.ce, r.pe]) if (x) assert.ok(Math.abs(Math.abs(x.gex) - x.gamma * x.oiUnits * tab.scale) <= Math.abs(x.gex) * 1e-12);
  });
  assert.strictEqual(tab.rows[2].pe, null); // no put OI at 24,400
});

test('gammaFlip ignores a sign change between near-zero tail strikes', () => {
  const rows = [row(100, -0.5), row(150, 0.4), row(200, -900), row(250, 800)];
  assert.strictEqual(gammaFlip(rows), 225);
});
