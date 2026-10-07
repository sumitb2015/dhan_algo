import { test } from 'node:test';
import assert from 'node:assert';
import { black76Gamma, buildGexRows, fmtGex, forwardFromSpot, gammaFlip, gexChecklist, gexLevels, gexCalcTable, gexTimeYears, gexValue, resolveIvs, wallClarity, type GexRow } from './gex.ts';
import { computeBsGreeksExact, RISK_FREE_RATE } from './optionsPricing.ts';

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
  // A call with no IV borrows the same strike's put IV (parity); it is not zero any more.
  const [r] = buildGexRows(oc, { ...base, lotSize: 65 });
  assert.ok(r.ceGex > 0);
  assert.ok(r.peGex < 0);
  // No IV on either side and no neighbour within range: still an honest zero.
  const [z] = buildGexRows({ '24000': { ce: { oi: 1000 }, pe: { oi: 500 } } }, { ...base, lotSize: 65 });
  assert.strictEqual(z.ceGex, 0);
  assert.ok(z.peGex === 0); // -0 === 0
});

test('resolveIvs prefers the OTM leg, then parity, then the nearest strike', () => {
  const oc = {
    '24000': { ce: { oi: 1, implied_volatility: 30 }, pe: { oi: 1, implied_volatility: 12 } }, // CE is ITM at F=24200: use the put's 12
    '24400': { ce: { oi: 1, implied_volatility: 11 }, pe: { oi: 1, implied_volatility: 40 } }, // PE is ITM: use the call's 11
    '24450': { ce: { oi: 1, implied_volatility: 0 }, pe: { oi: 0 } },                           // no IV: nearest CE strike (24400 -> 11)
  };
  const m = resolveIvs(oc, 24200);
  assert.strictEqual(m.get('24000|CE'), 12);
  assert.strictEqual(m.get('24400|PE'), 11);
  assert.strictEqual(m.get('24450|CE'), 11);
});

test('gexTimeYears floors at 10 minutes, not 6 hours, so expiry-afternoon gamma keeps growing', () => {
  const exp = Date.UTC(2026, 9, 13, 10, 10); // 15:40 IST
  const oneHour = gexTimeYears('2026-10-13', exp - 3600_000);
  const tenMin = gexTimeYears('2026-10-13', exp - 600_000);
  assert.ok(oneHour < 0.25 / 365, 'one hour left must be below the shared 6h floor');
  assert.ok(Math.abs(oneHour * 365 * 24 - 1) < 1e-9);
  assert.strictEqual(gexTimeYears('2026-10-13', exp + 1e6), tenMin);
  assert.ok(black76Gamma(24000, 24000, oneHour, 0.12) > 2 * black76Gamma(24000, 24000, 0.25 / 365, 0.12));
});

test('black76Gamma agrees with computeBsGreeksExact away from the time floor', () => {
  const t = 5 / 365;
  const a = black76Gamma(24200, 24300, t, 0.14);
  const b = computeBsGreeksExact('CE', 24200, 24300, t, 0.14, RISK_FREE_RATE, true).gamma;
  assert.ok(Math.abs(a - b) / b < 1e-12);
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

test('gexCalcTable reproduces buildGexRows exactly and exposes the formula terms', () => {
  const oc = {
    '24000': { ce: { oi: 130000, implied_volatility: 0 }, pe: { oi: 650000, implied_volatility: 13 } },
    '24200': { ce: { oi: 260000, implied_volatility: 12 }, pe: { oi: 390000, implied_volatility: 12.5 } },
    '24400': { ce: { oi: 650000, implied_volatility: 11 }, pe: { oi: 0, implied_volatility: 0 } },
  };
  const p = { expiry: '2026-10-27', underlying: 24250, lotSize: 65, now: Date.UTC(2026, 9, 6, 4, 0) };
  const rows = buildGexRows(oc, p);
  const tab = gexCalcTable(oc, p);
  assert.strictEqual(tab.rows.length, rows.length);
  tab.rows.forEach((r, i) => {
    assert.strictEqual(r.strike, rows[i].strike);
    assert.ok(Math.abs(r.netGex - rows[i].netGex) <= Math.abs(rows[i].netGex) * 1e-12);
    for (const s of [r.ce, r.pe]) if (s) {
      // gamma = e^{-rt} x pdf(d1) / (F x sigma x sqrt(t)), and GEX = gamma x OI x F^k x 0.01, recomputed from the exposed terms.
      const g = (tab.discount * s.pdf) / (tab.F * (s.ivPct / 100) * Math.sqrt(tab.t));
      assert.ok(Math.abs(g - s.gamma) <= s.gamma * 1e-12);
      assert.ok(Math.abs(Math.abs(s.gex) - s.gamma * s.oiUnits * tab.scale) <= Math.abs(s.gex) * 1e-12);
    }
  });
  assert.strictEqual(tab.rows[0].ce?.ivSource, 'otm-leg'); // 24000 CE is ITM at F=24250 and has no IV: take the put's 13
  assert.strictEqual(tab.rows[0].ce?.ivPct, 13);
});
