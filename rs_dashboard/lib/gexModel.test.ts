import { test } from 'node:test';
import assert from 'node:assert';
import {
  black76Gamma, buildGexRowsModel, forwardFromSpot, gexModelCalcTable, gexTimeYears, resolveIvs,
} from './gexModel.ts';
import { computeBsGreeksExact, RISK_FREE_RATE } from './optionsPricing.ts';

const now = Date.UTC(2026, 3, 20, 4, 0);

test('buildGexRowsModel: call positive, put negative, lots and power scale as declared', () => {
  const oc = { '24000.000000': { ce: { oi: 1000, implied_volatility: 14 }, pe: { oi: 1000, implied_volatility: 14 } } };
  const base = { expiry: '2026-04-23', underlying: 24200, lotSize: 65, now };
  const [r] = buildGexRowsModel(oc, { ...base, power: 2 });
  assert.ok(r.ceGex > 0 && r.peGex < 0 && r.ceGamma > 0);
  const [r2] = buildGexRowsModel(oc, { ...base, lotSize: 130, power: 2 });
  assert.strictEqual(r2.ceGex, r.ceGex);
  const [rl] = buildGexRowsModel(oc, { ...base, oiUnit: 'lots', power: 2 });
  assert.ok(Math.abs(rl.ceGex / r.ceGex - 65) < 1e-9);
  const [r1] = buildGexRowsModel(oc, { ...base, power: 1 });
  assert.ok(Math.abs(r.ceGex / r1.ceGex - 24200) < 1e-6);
});

test('buildGexRowsModel: a zero chain IV falls back to greeks.iv instead of dropping the strike', () => {
  const base = { expiry: '2026-04-23', underlying: 24200, now };
  const [a] = buildGexRowsModel({ '24000': { ce: { oi: 1000, implied_volatility: 0, greeks: { iv: 14 } } } }, base);
  const [b] = buildGexRowsModel({ '24000': { ce: { oi: 1000, implied_volatility: 14 } } }, base);
  assert.ok(a.ceGex > 0);
  assert.strictEqual(a.ceGex, b.ceGex);
});

test('buildGexRowsModel: unknown lot size or missing IV never invents numbers', () => {
  const oc = { '24000': { ce: { oi: 1000 }, pe: { oi: 500, implied_volatility: 14 } } };
  const base = { expiry: '2026-04-23', underlying: 24200, now };
  assert.deepStrictEqual(buildGexRowsModel(oc, { ...base, lotSize: 0, oiUnit: 'lots' }), []);
  const [r] = buildGexRowsModel(oc, { ...base, lotSize: 65 });
  assert.ok(r.ceGex > 0); // borrows the same strike's put IV (parity)
  const [z] = buildGexRowsModel({ '24000': { ce: { oi: 1000 }, pe: { oi: 500 } } }, { ...base, lotSize: 65 });
  assert.strictEqual(z.ceGex, 0);
  assert.ok(z.peGex === 0); // -0 === 0
});

test('resolveIvs prefers the OTM leg, then parity, then the nearest strike', () => {
  const oc = {
    '24000': { ce: { oi: 1, implied_volatility: 30 }, pe: { oi: 1, implied_volatility: 12 } },
    '24400': { ce: { oi: 1, implied_volatility: 11 }, pe: { oi: 1, implied_volatility: 40 } },
    '24450': { ce: { oi: 1, implied_volatility: 0 }, pe: { oi: 0 } },
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
  assert.ok(oneHour < 0.25 / 365);
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

test('forwardFromSpot carries spot to expiry; zero spot gives zero', () => {
  const n = Date.UTC(2026, 9, 6, 4, 0);
  const f = forwardFromSpot(22776.1, '2026-10-27', undefined, n);
  assert.ok(f > 22776.1 && f < 22776.1 * 1.01, String(f));
  assert.strictEqual(forwardFromSpot(0, '2026-10-27', undefined, n), 0);
});

test('gexModelCalcTable reproduces buildGexRowsModel and exposes every Black-76 term; Dhan source uses chain gamma and spot', () => {
  const oc = {
    '24000': { ce: { oi: 130000, implied_volatility: 0 }, pe: { oi: 650000, implied_volatility: 13, greeks: { gamma: 0.0006 } } },
    '24200': { ce: { oi: 260000, implied_volatility: 12, greeks: { gamma: 0.0009 } }, pe: { oi: 390000, implied_volatility: 12.5 } },
  };
  const p = { expiry: '2026-10-27', underlying: 24250, lotSize: 65, now: Date.UTC(2026, 9, 6, 4, 0), power: 2 as const };
  const rows = buildGexRowsModel(oc, p);
  const tab = gexModelCalcTable(oc, { ...p, spot: 24200, gammaSource: 'model' });
  assert.strictEqual(tab.rows.length, rows.length);
  tab.rows.forEach((r, i) => {
    assert.ok(Math.abs(r.netGex - rows[i].netGex) <= Math.abs(rows[i].netGex) * 1e-12);
    for (const x of [r.ce, r.pe]) if (x) {
      const g = (tab.discount * x.pdf) / (tab.F * (x.ivPct / 100) * Math.sqrt(tab.t));
      assert.ok(Math.abs(g - x.gamma) <= x.gamma * 1e-12);
    }
  });
  assert.strictEqual(tab.rows[0].ce?.ivSource, 'otm-leg');
  const dhan = gexModelCalcTable(oc, { ...p, spot: 24200, gammaSource: 'dhan' });
  assert.strictEqual(dhan.price, 24200);
  assert.strictEqual(dhan.rows[1].ce?.gamma, 0.0009);
  assert.ok((dhan.rows[1].ce?.modelGamma ?? 0) > 0);
  assert.ok(Math.abs((dhan.rows[1].ce?.gex ?? 0) - 0.0009 * 260000 * 24200 ** 2 * 0.01) < 1);
});
