import { test } from 'node:test';
import assert from 'node:assert';
import { computeBatmanAtOffset } from './batmanMath.ts';
import type { ChainStrikeQuote } from './strangleMath.ts';

const quotes = (entries: Record<number, { pe?: number; ce?: number }>): Record<number, ChainStrikeQuote> => {
  const out: Record<number, ChainStrikeQuote> = {};
  for (const [strikeStr, { pe, ce }] of Object.entries(entries)) {
    const strike = Number(strikeStr);
    out[strike] = {
      strike,
      ce: { ltp: ce ?? 0, securityId: `CE_${strike}`, iv: 12.0 },
      pe: { ltp: pe ?? 0, securityId: `PE_${strike}`, iv: 12.0 },
    };
  }
  return out;
};

test('computeBatmanAtOffset: basic symmetric Batman math with 1:2 ratio', () => {
  // Spot: 24000, ATM: 24000, Step: 50, Offset: 2 (100 pts), Wing: 2 (100 pts)
  // Long Put: 23900 @ 40, Short Put: 23800 @ 25
  // Long Call: 24100 @ 40, Short Call: 24200 @ 25
  const chain = quotes({
    23800: { pe: 25 },
    23900: { pe: 40 },
    24100: { ce: 40 },
    24200: { ce: 25 },
  });

  const cell = computeBatmanAtOffset({
    underlying: 'NIFTY',
    atmStrike: 24000,
    offset: 2,
    wing: 2,
    step: 50,
    spot: 24000,
    dte: 7,
    lotSize: 65,
    chainQuotes: chain,
  });

  assert.ok(cell !== null);
  assert.strictEqual(cell!.offset, 2);
  assert.strictEqual(cell!.wing, 2);
  assert.strictEqual(cell!.wingPoints, 100);

  // Strikes
  assert.strictEqual(cell!.longPutStrike, 23900);
  assert.strictEqual(cell!.shortPutStrike, 23800);
  assert.strictEqual(cell!.longCallStrike, 24100);
  assert.strictEqual(cell!.shortCallStrike, 24200);

  // Credits
  assert.strictEqual(cell!.putCredit, 10);  // 2*25 - 40
  assert.strictEqual(cell!.callCredit, 10); // 2*25 - 40
  assert.strictEqual(cell!.netPremiumPoints, 20);
  assert.strictEqual(cell!.netPremium, 20 * 65); // 1300

  // Ear peaks max profit
  assert.strictEqual(cell!.maxProfitPoints, 120); // 100 + 20
  assert.strictEqual(cell!.maxProfit, 120 * 65);   // 7800

  // Breakevens
  assert.deepStrictEqual(cell!.breakevens, [23680, 24320]);
  assert.strictEqual(cell!.breakevenWidth, 640);

  // Distance (to short strikes / ears)
  assert.strictEqual(cell!.distancePoints, 200); // 24000 - 23800
  assert.strictEqual(cell!.distancePct, Math.round((200 / 24000) * 10000) / 100);
});

test('computeBatmanAtOffset: returns null when a leg quote is missing or illiquid', () => {
  const chain = quotes({
    23800: { pe: 25 },
    23900: { pe: 40 },
    24100: { ce: 40 },
    // 24200 is missing
  });

  const cell = computeBatmanAtOffset({
    underlying: 'NIFTY',
    atmStrike: 24000,
    offset: 2,
    wing: 2,
    step: 50,
    spot: 24000,
    dte: 7,
    lotSize: 65,
    chainQuotes: chain,
  });

  assert.strictEqual(cell, null);
});

test('computeBatmanAtOffset: scales correctly with wing width', () => {
  // Wing: 3 strikes (150 pts). Offset: 1 (50 pts).
  // Long Put: 23950, Short Put: 23800
  // Long Call: 24050, Short Call: 24200
  const chain = quotes({
    23800: { pe: 30 },
    23950: { pe: 50 },
    24050: { ce: 50 },
    24200: { ce: 30 },
  });

  const cell = computeBatmanAtOffset({
    underlying: 'NIFTY',
    atmStrike: 24000,
    offset: 1,
    wing: 3,
    step: 50,
    spot: 24000,
    dte: 7,
    lotSize: 65,
    chainQuotes: chain,
  });

  assert.ok(cell !== null);
  assert.strictEqual(cell!.wing, 3);
  assert.strictEqual(cell!.wingPoints, 150);
  assert.strictEqual(cell!.longPutStrike, 23950);
  assert.strictEqual(cell!.shortPutStrike, 23800);
  assert.strictEqual(cell!.longCallStrike, 24050);
  assert.strictEqual(cell!.shortCallStrike, 24200);

  // Put credit: 2*30 - 50 = 10, Call credit: 2*30 - 50 = 10
  assert.strictEqual(cell!.netPremiumPoints, 20);
  assert.strictEqual(cell!.maxProfitPoints, 170); // 150 + 20
});
