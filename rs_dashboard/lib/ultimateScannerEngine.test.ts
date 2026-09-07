import { test } from 'node:test';
import assert from 'node:assert';
import { scanOptionChain } from './ultimateScannerEngine.ts';
import type { ChainStrikeQuote } from './strangleMath.ts';

const buildMockChain = (
  strikes: number[],
  spot: number,
): Record<number, ChainStrikeQuote> => {
  const chain: Record<number, ChainStrikeQuote> = {};
  for (const strike of strikes) {
    const dist = Math.abs(strike - spot);
    const ceLtp = Math.max(0.5, Math.round((Math.max(0, spot - strike) + Math.max(1, 150 - dist * 0.4)) * 10) / 10);
    const peLtp = Math.max(0.5, Math.round((Math.max(0, strike - spot) + Math.max(1, 150 - dist * 0.4)) * 10) / 10);
    chain[strike] = {
      strike,
      ce: { ltp: ceLtp, securityId: `CE_${strike}`, iv: 12.5 },
      pe: { ltp: peLtp, securityId: `PE_${strike}`, iv: 12.5 },
    };
  }
  return chain;
};

test('scanOptionChain: generates valid Batman candidates with 1:2 ratio spreads', () => {
  const spot = 24000;
  const strikes: number[] = [];
  for (let s = 23000; s <= 25000; s += 50) {
    strikes.push(s);
  }
  const chain = buildMockChain(strikes, spot);

  // Provide realistic prices for Batman candidate:
  // Spot: 24000. Step: 50. Wing: 100.
  // Long Put: 23900 (PE LTP: 40)
  // Short Put: 23800 (PE LTP: 25) -> PE Credit: 2 * 25 - 40 = 10
  // Long Call: 24100 (CE LTP: 40)
  // Short Call: 24200 (CE LTP: 25) -> CE Credit: 2 * 25 - 40 = 10
  // Total Credit: 20 pts
  chain[23800] = { strike: 23800, pe: { ltp: 25, securityId: 'PE_23800', iv: 12.5 }, ce: { ltp: 5, securityId: 'CE_23800' } };
  chain[23900] = { strike: 23900, pe: { ltp: 40, securityId: 'PE_23900', iv: 12.5 }, ce: { ltp: 10, securityId: 'CE_23900' } };
  chain[24100] = { strike: 24100, ce: { ltp: 40, securityId: 'CE_24100', iv: 12.5 }, pe: { ltp: 10, securityId: 'PE_24100' } };
  chain[24200] = { strike: 24200, ce: { ltp: 25, securityId: 'CE_24200', iv: 12.5 }, pe: { ltp: 5, securityId: 'PE_24200' } };

  const results = scanOptionChain(
    'NIFTY',
    '2026-09-17',
    spot,
    chain,
    strikes,
    {
      underlying: 'NIFTY',
      minRom: 0.1,
      minDistancePct: 0.1,
      maxDistancePct: 5.0,
      riskProfile: 'all',
      strategyTypes: ['batman'],
      sortBy: 'score',
      maxResults: 80,
    }
  );

  assert.ok(results.length > 0, 'Should find at least one Batman candidate');
  const target = results.find(r => r.id.includes('23800_23900_24100_24200'));
  assert.ok(target, 'Target Batman candidate 23800/23900/24100/24200 should exist');

  assert.strictEqual(target.type, 'batman');
  assert.strictEqual(target.sentiment, 'Range-Bound');
  assert.strictEqual(target.maxLossUnlimited, true);
  assert.strictEqual(target.maxLoss, 0);
  assert.strictEqual(target.netPremiumPoints, 20); // 10 + 10 pts
  assert.strictEqual(target.netPremium, 20 * 65);  // 1300 Rs (Nifty lotSize = 65)

  // Max profit at ears: (wing + totalCreditPts) * lotSize = (100 + 20) * 65 = 7800
  assert.strictEqual(target.maxProfit, 120 * 65);

  // Breakevens: lower = shortPut - (wing + totalCredit) = 23800 - 120 = 23680
  // upper = shortCall + (wing + totalCredit) = 24200 + 120 = 24320
  assert.deepStrictEqual(target.breakevens, [23680, 24320]);

  // Legs verification: 4 legs
  assert.strictEqual(target.legs.length, 4);
  assert.deepStrictEqual(target.legs.map(l => ({ strike: l.strike, option: l.option, side: l.side, lots: l.lots })), [
    { strike: 23800, option: 'PE', side: 'SELL', lots: 2 },
    { strike: 23900, option: 'PE', side: 'BUY', lots: 1 },
    { strike: 24100, option: 'CE', side: 'BUY', lots: 1 },
    { strike: 24200, option: 'CE', side: 'SELL', lots: 2 },
  ]);
});

test('scanOptionChain: filters respect strategy selection', () => {
  const spot = 24000;
  const strikes: number[] = [];
  for (let s = 23000; s <= 25000; s += 50) {
    strikes.push(s);
  }
  const chain = buildMockChain(strikes, spot);

  // Scan only for iron_condor -> no batman returned
  const icResults = scanOptionChain(
    'NIFTY',
    '2026-09-17',
    spot,
    chain,
    strikes,
    {
      underlying: 'NIFTY',
      minRom: 0.1,
      minDistancePct: 0.1,
      maxDistancePct: 5.0,
      riskProfile: 'all',
      strategyTypes: ['iron_condor'],
      sortBy: 'score',
      maxResults: 80,
    }
  );
  assert.ok(icResults.every(r => r.type === 'iron_condor'));
});
