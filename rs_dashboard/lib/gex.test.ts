import { test } from 'node:test';
import assert from 'node:assert';
import { buildGexRows, fmtGex, forwardFromSpot, gammaFlip, gexChecklist, gexLevels, gexValue, wallClarity, type GexRow } from './gex.ts';

const row = (strike: number, netGex: number, ceGex = Math.max(netGex, 0), peGex = Math.min(netGex, 0)): GexRow => ({
  strike, ceOi: 1, peOi: 1, ceGamma: 0, peGamma: 0, ceGex, peGex, netGex,
});

test('gamma flip interpolates the zero crossing (video example -597 / +250)', () => {
  const flip = gammaFlip([row(24150, -900), row(24200, -597), row(24250, 250), row(24300, 800)]);
  assert.ok(flip != null);
  // |-597| / (597 + 250) of the way from 24200 to 24250 = 24235.2 (the video rounds to ~24225)
  assert.ok(Math.abs(flip - 24235.2) < 0.1, String(flip));
});

test('gamma flip ignores a sign change between near-zero strikes far from the action', () => {
  const rows = [row(100, -1000), row(150, -900), row(200, -0.4), row(250, 0.5), row(300, -0.3), row(350, 0.2)];
  assert.strictEqual(gammaFlip(rows, 250), null);
  // The same tiny wobble next to a real sign change does not hide the real one.
  const real = [row(100, -1000), row(150, -300), row(200, 400), row(250, 0.5), row(300, -0.3)];
  assert.ok(Math.abs((gammaFlip(real, 180) ?? 0) - 171.4) < 0.1);
});

test('gamma flip is null when net GEX never changes sign', () => {
  assert.strictEqual(gammaFlip([row(100, 5), row(150, 9)]), null);
});

test('flip picks the crossing nearest spot when there are several', () => {
  const rows = [row(100, -1), row(150, 1), row(200, 1), row(250, -1)];
  assert.ok(Math.abs((gammaFlip(rows, 240) ?? 0) - 225) < 0.1);
  assert.ok(Math.abs((gammaFlip(rows, 110) ?? 0) - 125) < 0.1);
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

test('buildGexRows: call positive, put negative, scales with lot size and power', () => {
  const oc = { '24000.000000': { ce: { oi: 1000, implied_volatility: 14 }, pe: { oi: 1000, implied_volatility: 14 } } };
  const now = Date.UTC(2026, 3, 20, 4, 0);
  const base = { expiry: '2026-04-23', underlying: 24200, lotSize: 65, now };
  const [r] = buildGexRows(oc, base);
  assert.ok(r.ceGex > 0 && r.peGex < 0);
  assert.ok(r.ceGamma > 0);
  // OI in units: lot size does not scale GEX. Declared as lots, it does.
  const [r2] = buildGexRows(oc, { ...base, lotSize: 130 });
  assert.strictEqual(r2.ceGex, r.ceGex);
  const [rl] = buildGexRows(oc, { ...base, oiUnit: 'lots' });
  assert.ok(Math.abs(rl.ceGex / r.ceGex - 65) < 1e-9);
  const [r1] = buildGexRows(oc, { ...base, power: 1 });
  assert.ok(Math.abs(r.ceGex / r1.ceGex - 24200) < 1e-6);
});

test('video formula: 0.0008 x 50,000 lots x 65 x 24,200 x 0.01 = 629,200 index units; Rs 1,522.66 Cr with spot squared', () => {
  const oiUnits = 50_000 * 65;
  assert.strictEqual(Math.round(gexValue(0.0008, oiUnits, 24200, 1)), 629_200);
  assert.ok(Math.abs(gexValue(0.0008, oiUnits, 24200, 2) / 1e7 - 1522.664) < 0.001);
  // The slide's "Rs 62.9 Cr" is the same product without the x 0.01, in rupees: 62,920,000 = Rs 6.292 Cr.
  assert.strictEqual(Math.round(gexValue(0.0008, oiUnits, 24200, 1) * 100), 62_920_000);
});

test('buildGexRows: a zero chain IV falls back to greeks.iv instead of dropping the strike', () => {
  const base = { expiry: '2026-04-23', underlying: 24200, now: Date.UTC(2026, 3, 20, 4, 0) };
  const withFallback = { '24000': { ce: { oi: 1000, implied_volatility: 0, greeks: { iv: 14 } } } };
  const direct = { '24000': { ce: { oi: 1000, implied_volatility: 14 } } };
  const [a] = buildGexRows(withFallback, base);
  const [b] = buildGexRows(direct, base);
  assert.ok(a.ceGex > 0);
  assert.strictEqual(a.ceGex, b.ceGex);
});

test('OI is never rescaled by lot size unless the caller declares lots (no divisibility guessing)', () => {
  // OI of 100 and 130 is not a multiple of 65, the case an auto-detector would misread as lots.
  const oc = { '24000': { ce: { oi: 100, implied_volatility: 14 } } };
  const base = { expiry: '2026-04-23', underlying: 24200, now: Date.UTC(2026, 3, 20, 4, 0) };
  const [u] = buildGexRows(oc, { ...base, lotSize: 65 });
  const [again] = buildGexRows(oc, { ...base, lotSize: 75 });
  assert.strictEqual(u.ceGex, again.ceGex);
});

test('buildGexRows: unknown lot size or missing IV never invents numbers', () => {
  const oc = { '24000': { ce: { oi: 1000 }, pe: { oi: 500, implied_volatility: 14 } } };
  const base = { expiry: '2026-04-23', underlying: 24200, now: Date.UTC(2026, 3, 20, 4, 0) };
  // Lots declared but no lot size to convert with: refuse rather than guess.
  assert.deepStrictEqual(buildGexRows(oc, { ...base, lotSize: 0, oiUnit: 'lots' }), []);
  const [r] = buildGexRows(oc, { ...base, lotSize: 65 });
  assert.strictEqual(r.ceGex, 0);
  assert.ok(r.peGex < 0);
});

test('wallClarity flags near-equal runners-up', () => {
  assert.strictEqual(wallClarity([{ strike: 1, v: 100 }, { strike: 2, v: 95 }]).clear, false);
  assert.strictEqual(wallClarity([{ strike: 1, v: 100 }, { strike: 2, v: 40 }]).clear, true);
});

const lv = (over: Partial<ReturnType<typeof gexLevels>>) => ({ ...gexLevels([], 100), ...over });

test('checklist: total positive but spot below the flip is amber, not green', () => {
  const items = gexChecklist({
    levels: lv({ regime: 'negative', flip: 24300, totalNet: 5e8 }),
    spot: 24200, vix: 14, call: { clear: true, runnerUp: 24400 }, put: { clear: true, runnerUp: 23800 },
  });
  assert.strictEqual(items[0].tone, 'warn');
  assert.strictEqual(items[1].tone, 'bad'); // flip is above spot
  assert.strictEqual(items[2].tone, 'ok');
  assert.strictEqual(items[3].tone, 'manual');
});

test('checklist: all green in a clean positive-gamma setup; VIX bands and missing data', () => {
  const good = gexChecklist({
    levels: lv({ regime: 'positive', flip: 24100, totalNet: 5e8 }),
    spot: 24200, vix: 15, call: { clear: true, runnerUp: 24400 }, put: { clear: true, runnerUp: 23800 },
  });
  assert.deepStrictEqual(good.map(i => i.tone), ['ok', 'ok', 'ok', 'manual', 'ok']);
  const edge = (vix: number | null) => gexChecklist({ levels: lv({ regime: 'positive', flip: 1, totalNet: 1 }), spot: 2, vix, call: { clear: false, runnerUp: 1 }, put: { clear: true, runnerUp: 2 } });
  assert.strictEqual(edge(19)[2].tone, 'warn');
  assert.strictEqual(edge(25)[2].tone, 'bad');
  assert.strictEqual(edge(null)[2].tone, 'manual');
  assert.strictEqual(edge(15)[4].tone, 'warn'); // call wall split
  const none = gexChecklist({ levels: lv({}), spot: 0, vix: null, call: { clear: false, runnerUp: null }, put: { clear: false, runnerUp: null } });
  assert.deepStrictEqual(none.map(i => i.tone), ['manual', 'manual', 'manual', 'manual', 'manual']);
});

test('forwardFromSpot carries spot to expiry; zero spot gives zero (page falls back, never invents)', () => {
  const now = Date.UTC(2026, 9, 6, 4, 0);
  const f = forwardFromSpot(22776.1, '2026-10-27', undefined, now);
  assert.ok(f > 22776.1 && f < 22776.1 * 1.01, String(f));
  assert.strictEqual(forwardFromSpot(0, '2026-10-27', undefined, now), 0);
});

test('fmtGex tiers are consistent', () => {
  assert.strictEqual(fmtGex(5.97e7), '5.97 Cr');
  assert.strictEqual(fmtGex(-5.972e10), '-5,972 Cr');
  assert.strictEqual(fmtGex(1.5e5), '1.50L');
  assert.strictEqual(fmtGex(1234), '1.2K');
  assert.strictEqual(fmtGex(12), '12');
});
