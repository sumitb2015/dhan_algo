import test from 'node:test';
import assert from 'node:assert/strict';
import { vwapMomentumBuyer as S } from './vwapMomentumBuyer.ts';
import { defaultsOf } from '../configSchema.ts';
import { closeBar, istMsOf, minToHm } from '../bars.ts';
import type { AlgoConfig, AlgoCtx, Bar, CtxContract } from '../types.ts';

const DAY = '2026-10-14';
const cfg = (extra: Record<string, unknown> = {}): AlgoConfig => ({ ...defaultsOf(S), timeframe: 1, emaPeriod: 5, ...extra }) as AlgoConfig;

/** 1-minute bars from 09:15 with the given closes (o = h = l = c, volume 100). */
const barsOf = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({ t: `${DAY} ${minToHm(9 * 60 + 15 + i)}:00`, o: c, h: c, l: c, c, v: 100 }));

function ctxOf(closes: number[], spotCloses: number[], option: 'CE' | 'PE' = 'CE'): AlgoCtx {
  const hm = minToHm(9 * 60 + 15 + closes.length);
  const key = `25000${option}`;
  const ct: CtxContract = {
    key, strike: 25000, option, ltp: closes[closes.length - 1], volume: 1000, oi: null, prevClose: null, prevOi: null,
    bars1m: barsOf(closes), warmupBars: 0,
  };
  return {
    nowIstMs: istMsOf(DAY, hm), date: DAY, hm, underlying: 'NIFTY', expiry: '2026-10-20', lotSize: 65, step: 50,
    spot: spotCloses[spotCloses.length - 1], atm: 25000,
    spotBars1m: spotCloses.map((c, i) => closeBar(DAY, minToHm(9 * 60 + 15 + i), c)),
    contracts: { [key]: ct }, open: [],
  };
}

const rising = Array.from({ length: 30 }, (_, i) => 25000 + i * 5);
const falling = Array.from({ length: 30 }, (_, i) => 25150 - i * 5);

test('gate: rising index allows calls only, falling puts only', () => {
  const up = S.gate(ctxOf([100, 100], rising), cfg());
  assert.equal(up.bias, 'BULLISH');
  assert.deepEqual(up.allowed, ['CE']);
  const down = S.gate(ctxOf([100, 100], falling), cfg());
  assert.deepEqual(down.allowed, ['PE']);
  const off = S.gate(ctxOf([100, 100], falling), cfg({ trendMode: 'BYPASS' }));
  assert.deepEqual(off.allowed, ['CE', 'PE']);
});

test('scan: a fresh close above VWAP and EMA is eligible', () => {
  const closes = [...Array(20).fill(100), 99, 98, 97, 96, 110];
  const ctx = ctxOf(closes, rising);
  const [c] = S.scan(ctx, cfg(), S.gate(ctx, cfg()));
  assert.equal(c.eligible, true, c.blockReason);
  assert.equal(c.cols.age, 1);
});

test('scan: a signal older than maxSignalAge is blocked', () => {
  const closes = [...Array(20).fill(100), 96, 110, 115, 120, 125];
  const ctx = ctxOf(closes, rising);
  const [c] = S.scan(ctx, cfg({ maxSignalAge: 2 }), S.gate(ctx, cfg()));
  assert.equal(c.eligible, false);
  assert.match(c.blockReason ?? '', /bars old/);
});

test('scan: the trend gate blocks the disallowed side', () => {
  const closes = [...Array(20).fill(100), 99, 98, 97, 96, 110];
  const ctx = ctxOf(closes, falling, 'CE');
  const [c] = S.scan(ctx, cfg(), S.gate(ctx, cfg()));
  assert.equal(c.eligible, false);
  assert.match(c.blockReason ?? '', /Trend gate/);
});

test('manage: momentum-lost exit when the premium falls back below its EMA, and the stop trails up', () => {
  const closes = [...Array(20).fill(100), 99, 98, 97, 96, 110];
  const ctx = ctxOf(closes, rising);
  const pos = { id: 'p', key: '25000CE', strike: 25000, option: 'CE' as const, side: 'BUY' as const, entryPrice: 110, stop: 88, initialStop: 88, best: 130, target: null, state: null, openedAt: 0 };
  const r = S.manage(pos, 95, ctx, cfg());
  assert.ok(r.stop >= 110, `stop ${r.stop} should be locked at or above cost after a 18% gain`);
  assert.equal(r.exits?.[0]?.kind, 'MOMENTUM_LOST');
});
