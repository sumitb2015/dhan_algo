import { test } from 'node:test';
import assert from 'node:assert';
import { computeStrangleAtOffset, type ChainStrikeQuote } from './strangleMath.ts';

const quotes = (entries: Record<number, { pe?: number; ce?: number }>): Record<number, ChainStrikeQuote> => {
  const out: Record<number, ChainStrikeQuote> = {};
  for (const [strikeStr, { pe, ce }] of Object.entries(entries)) {
    const strike = Number(strikeStr);
    out[strike] = {
      strike,
      ce: { ltp: ce ?? 0 },
      pe: { ltp: pe ?? 0 },
    };
  }
  return out;
};

test('computeStrangleAtOffset: basic symmetric strangle math', () => {
  // spot=100, atm=100, step=10, offset=2 -> sell 80 PE / 120 CE, both @ ltp 5
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 80: { pe: 5 }, 120: { ce: 5 } }),
  });

  assert.ok(cell !== null);
  assert.strictEqual(cell!.putStrike, 80);
  assert.strictEqual(cell!.callStrike, 120);
  assert.strictEqual(cell!.netPremiumPoints, 10);
  assert.strictEqual(cell!.netPremium, 10); // lotSize=1
  assert.strictEqual(cell!.distancePct, 20); // both legs 20% OTM
  assert.strictEqual(cell!.estMargin, 120000); // flat NIFTY estimate
  assert.strictEqual(cell!.romPct, 0.01); // rounded to 2 decimals
  assert.deepStrictEqual(cell!.breakevens, [70, 130]);
});

test('computeStrangleAtOffset: returns null when the put leg quote is missing', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 120: { ce: 5 } }), // no 80 strike at all
  });
  assert.strictEqual(cell, null);
});

test('computeStrangleAtOffset: returns null when a leg is too illiquid (ltp <= 0.05)', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'NIFTY',
    atmStrike: 100,
    offset: 2,
    step: 10,
    spot: 100,
    dte: 7,
    lotSize: 1,
    chainQuotes: quotes({ 80: { pe: 0.05 }, 120: { ce: 5 } }),
  });
  assert.strictEqual(cell, null);
});

test('computeStrangleAtOffset: SENSEX uses its own flat margin estimate', () => {
  const cell = computeStrangleAtOffset({
    underlying: 'SENSEX',
    atmStrike: 80000,
    offset: 3,
    step: 100,
    spot: 80000,
    dte: 5,
    lotSize: 10,
    chainQuotes: quotes({ 79700: { pe: 40 }, 80300: { ce: 40 } }),
  });
  assert.ok(cell !== null);
  assert.strictEqual(cell!.estMargin, 95000);
});
