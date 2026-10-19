import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdownAutoScalper as S } from './breakdownAutoScalper.ts';
import { defaultsOf } from '../configSchema.ts';
import { closeBar, istMsOf, minToHm } from '../bars.ts';
import type { AlgoConfig, AlgoCtx, Bar, CtxContract } from '../types.ts';

const DAY = '2026-10-14';
const cfg = (extra: Record<string, unknown> = {}): AlgoConfig =>
  ({ ...defaultsOf(S), timeframe: 1, ...extra }) as AlgoConfig;

/** 1-minute bars from 09:15 with the given closes (o = h = l = c, volume 2000, oi 100000). */
const barsOf = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ t: `${DAY} ${minToHm(9 * 60 + 15 + i)}:00`, o: c, h: c, l: c, c, v: 2000 }));

function ctxOf(closes: number[], spotCloses: number[], option: 'CE' | 'PE' = 'PE'): AlgoCtx {
  const hm = minToHm(9 * 60 + 15 + closes.length);
  const key = `25000${option}`;
  const ct: CtxContract = {
    key,
    strike: 25000,
    option,
    ltp: closes[closes.length - 1],
    volume: 5000,
    oi: 20000,
    prevClose: null,
    prevOi: null,
    bars1m: barsOf(closes),
    warmupBars: 0,
  };
  return {
    nowIstMs: istMsOf(DAY, hm),
    date: DAY,
    hm,
    underlying: 'NIFTY',
    expiry: '2026-10-20',
    lotSize: 65,
    step: 50,
    spot: spotCloses[spotCloses.length - 1],
    atm: 25000,
    spotBars1m: spotCloses.map((c, i) => closeBar(DAY, minToHm(9 * 60 + 15 + i), c)),
    contracts: { [key]: ct },
    open: [],
  };
}

const rising = Array.from({ length: 30 }, (_, i) => 25000 + i * 5);
const falling = Array.from({ length: 30 }, (_, i) => 25150 - i * 5);

test('breakdownAutoScalper gate: rising index allows PE selling only, falling CE selling only', () => {
  const up = S.gate(ctxOf([100, 100], rising), cfg());
  assert.equal(up.bias, 'BULLISH');
  assert.deepEqual(up.allowed, ['PE']);

  const down = S.gate(ctxOf([100, 100], falling), cfg());
  assert.equal(down.bias, 'BEARISH');
  assert.deepEqual(down.allowed, ['CE']);

  const off = S.gate(ctxOf([100, 100], falling), cfg({ trendMode: 'BYPASS' }));
  assert.deepEqual(off.allowed, ['CE', 'PE']);
});

test('breakdownAutoScalper scan: fresh option breakdown is eligible to short', () => {
  // Option flat at 100, then breaks down to 88
  const closes = [...Array(20).fill(100), 95, 90, 88];
  const ctx = ctxOf(closes, rising, 'PE');
  const [c] = S.scan(ctx, cfg(), S.gate(ctx, cfg()));
  assert.equal(c.eligible, true, c.blockReason);
  assert.equal(c.option, 'PE');
});

test('breakdownAutoScalper scan: trend gate blocks disallowed option side', () => {
  const closes = [...Array(20).fill(100), 95, 90, 88];
  // Bullish index trend allows PE, but we check CE
  const ctx = ctxOf(closes, rising, 'CE');
  const [c] = S.scan(ctx, cfg(), S.gate(ctx, cfg()));
  assert.equal(c.eligible, false);
  assert.match(c.blockReason ?? '', /Trend/);
});

test('breakdownAutoScalper onEntry: sets correct initial stop loss and target profit', () => {
  const plan = S.onEntry({} as any, 100, cfg({ slPct: 20, targetPct: 35 }));
  // SELL: stop is above entry (100 * 1.20 = 120), target is below (100 * 0.65 = 65)
  assert.equal(plan.stop, 120);
  assert.equal(plan.target, 65);
});

test('breakdownAutoScalper manage: lock & trail ratchets stop down as premium decays', () => {
  const closes = [...Array(20).fill(100), 95, 90, 88];
  const ctx = ctxOf(closes, rising, 'PE');
  // Sold at 100, best reached 80 (20% profit > 15% lock threshold)
  const pos = {
    id: 'p1',
    key: '25000PE',
    strike: 25000,
    option: 'PE' as const,
    side: 'SELL' as const,
    entryPrice: 100,
    stop: 120,
    initialStop: 120,
    best: 80,
    target: 65,
    state: null,
    openedAt: 0,
  };
  const r = S.manage(pos, 82, ctx, cfg({ trailStartPct: 15, trailStepPts: 2, trailByPts: 1 }));
  // After 20 pts gain with 15% trigger: gain (20) >= 15 -> steps = floor((20 - 15) / 2) = 2.
  // level = 100 - 2 * 1 = 98.
  assert.ok(r.stop <= 98, `stop ${r.stop} should have ratcheted down to <= 98`);
});

test('breakdownAutoScalper manage: triggers target exit when premium drops to target', () => {
  const closes = [...Array(20).fill(100), 95, 90, 88];
  const ctx = ctxOf(closes, rising, 'PE');
  const pos = {
    id: 'p2',
    key: '25000PE',
    strike: 25000,
    option: 'PE' as const,
    side: 'SELL' as const,
    entryPrice: 100,
    stop: 120,
    initialStop: 120,
    best: 64,
    target: 65,
    state: null,
    openedAt: 0,
  };
  const r = S.manage(pos, 64, ctx, cfg());
  assert.equal(r.exits?.[0]?.kind, 'TARGET');
});


test('breakdownAutoScalper scan: otmOnly blocks ATM/ITM strikes and keeps OTM ones', () => {
  // spot ends near 25145: PE 25000 is OTM (below spot), CE 25000 is ITM (below spot).
  const pe = S.scan(ctxOf(falling, rising, 'PE'), cfg({ otmOnly: true }), {} as never);
  assert.notEqual(pe[0].blockReason, 'ATM/ITM — OTM only');
  const ce = S.scan(ctxOf(falling, rising, 'CE'), cfg({ otmOnly: true }), {} as never);
  assert.equal(ce[0].eligible, false);
  assert.equal(ce[0].blockReason, 'ATM/ITM — OTM only');
  const off = S.scan(ctxOf(falling, rising, 'CE'), cfg(), {} as never);
  assert.notEqual(off[0].blockReason, 'ATM/ITM — OTM only');
});
