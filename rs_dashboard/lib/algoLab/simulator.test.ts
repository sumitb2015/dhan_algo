import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateDay, type BtBar, type DayData } from './simulator.ts';
import { minToHm, SESSION_LAST, SESSION_OPEN } from './bars.ts';
import { defaultsOf } from './configSchema.ts';
import { initialStop, targetHit, targetOf } from './risk.ts';
import { orderCost } from './costs.ts';
import type { AlgoConfig, Side, StrategyDefinition } from './types.ts';

const DAY = '2026-10-14';
const violations: string[] = [];

/** Stub strategy: contract K is eligible from config `from_<K>` (HH:MM) on; 20% stop, 30% target, static stop. */
function stub(side: Side): StrategyDefinition {
  return {
    key: 'stub',
    label: 'Stub',
    description: '',
    docPath: '',
    side,
    underlyings: ['NIFTY'],
    status: 'UNVALIDATED',
    schema: [],
    defaults: {},
    warmupBars: () => 0,
    gate: () => ({ bias: 'TEST', tone: 'neutral', allowed: ['CE', 'PE'], detail: '' }),
    scan(ctx, c) {
      for (const ct of Object.values(ctx.contracts)) {
        for (const b of ct.bars1m) if (b.t.slice(0, 16) >= `${ctx.date} ${ctx.hm}`) violations.push(`${ct.key} ${b.t} at ${ctx.hm}`);
      }
      return Object.values(ctx.contracts).map((ct) => {
        const from = c[`from_${ct.key}`];
        return { key: ct.key, strike: ct.strike, option: ct.option, ltp: ct.ltp, score: 50, eligible: typeof from === 'string' && ctx.hm >= from, cols: {} };
      });
    },
    onEntry: (_c, entry) => ({ stop: initialStop(side, entry, 20), target: targetOf(side, entry, 30) }),
    manage: (pos, px) => ({
      stop: pos.stop,
      exits: targetHit(side, px, pos.target) ? [{ kind: 'TARGET', level: pos.target!, reason: 'target' }] : [],
    }),
    columns: { scanner: [] },
  };
}

type B = [string, number, number, number, number];
/** Flat 100 bars all session for each key, with overrides. */
function day(overrides: Record<string, B[]>): DayData {
  const contracts: DayData['contracts'] = {};
  for (const [key, rows] of Object.entries(overrides)) {
    const map = new Map<string, BtBar>();
    for (let m = SESSION_OPEN; m <= SESSION_LAST; m++) {
      const hm = minToHm(m);
      map.set(hm, { t: `${DAY} ${hm}:00`, o: 100, h: 100, l: 100, c: 100, v: 10, oi: 1000 });
    }
    for (const [hm, o, h, l, c] of rows) map.set(hm, { t: `${DAY} ${hm}:00`, o, h, l, c, v: 10, oi: 1000 });
    contracts[key] = { strike: Number(key.slice(0, -2)), option: key.endsWith('CE') ? 'CE' : 'PE', bars: [...map.values()] };
  }
  const spot: [string, number][] = [];
  for (let m = SESSION_OPEN; m <= SESSION_LAST; m++) spot.push([minToHm(m), 25000]);
  return { date: DAY, expiry: '2026-10-20', source: 'test', lotSize: 65, warmupSessions: 1, spot, contracts };
}

const cfg = (side: Side, extra: Record<string, unknown>): AlgoConfig =>
  ({ ...defaultsOf(stub(side)), maxConcurrent: 1, maxSameSide: 1, brokerage: 20, ...extra }) as AlgoConfig;

test('BUY: a target crossed inside the bar fills at the target', () => {
  const r = simulateDay(stub('BUY'), day({ '25000CE': [['09:31', 105, 140, 104, 120]] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30' }));
  const t = r.trades[0];
  assert.equal(t.entryTime, '09:31');
  assert.equal(t.entryPrice, 105);
  assert.equal(t.exitKind, 'TARGET');
  assert.equal(t.exitPrice, 136.5);
  assert.equal(t.exitTime, '09:31');
});

test('BUY: a gap through the stop at the open fills at the open', () => {
  const r = simulateDay(stub('BUY'), day({ '25000CE': [['09:32', 70, 72, 65, 70]] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30' }));
  const t = r.trades[0];
  assert.equal(t.entryPrice, 100);
  assert.equal(t.exitKind, 'STOP');
  assert.equal(t.exitTime, '09:32');
  assert.equal(t.exitPrice, 70);
});

test('SELL: a stop crossed inside the bar fills at the stop', () => {
  const r = simulateDay(stub('SELL'), day({ '25000PE': [['09:32', 101, 125, 100, 110]] }), cfg('SELL', { from_25000PE: '09:31', entryStart: '09:30' }));
  const t = r.trades[0];
  assert.equal(t.exitKind, 'STOP');
  assert.equal(t.exitPrice, 120);
  assert.equal(t.gross, (100 - 120) * 65);
});

test('adverse first: SELL walks the high before the low, BUY the low before the high', () => {
  const sell = simulateDay(stub('SELL'), day({ '25000PE': [['09:32', 100, 125, 60, 90]] }), cfg('SELL', { from_25000PE: '09:31', entryStart: '09:30' }));
  assert.equal(sell.trades[0].exitKind, 'STOP');
  const buy = simulateDay(stub('BUY'), day({ '25000CE': [['09:32', 100, 140, 75, 120]] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30' }));
  assert.equal(buy.trades[0].exitKind, 'STOP');
  assert.equal(buy.trades[0].exitPrice, 80);
});

test('a stop can be hit inside the entry bar', () => {
  const r = simulateDay(stub('BUY'), day({ '25000CE': [['09:31', 100, 102, 75, 90]] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30' }));
  assert.equal(r.trades[0].entryTime, '09:31');
  assert.equal(r.trades[0].exitTime, '09:31');
  assert.equal(r.trades[0].exitPrice, 80);
});

test('a position closed inside bar m holds its slot for entries at bar m open', () => {
  const r = simulateDay(
    stub('BUY'),
    day({ '25000CE': [['09:35', 100, 140, 99, 120]], '25050CE': [] }),
    cfg('BUY', { from_25000CE: '09:31', from_25050CE: '09:35', entryStart: '09:30' }),
  );
  const a = r.trades.find((t) => t.contract === '25000CE')!;
  const b = r.trades.find((t) => t.contract === '25050CE')!;
  assert.equal(a.exitTime, '09:35');
  assert.equal(b.entryTime, '09:36');
});

test('EOD exits at the cutoff bar open', () => {
  const r = simulateDay(stub('BUY'), day({ '25000CE': [['15:15', 103, 104, 102, 103]] }), cfg('BUY', { from_25000CE: '15:00', entryStart: '09:30', entryEnd: '15:00' }));
  const t = r.trades[0];
  assert.equal(t.exitKind, 'EOD');
  assert.equal(t.exitTime, '15:15');
  assert.equal(t.exitPrice, 103);
});

test('slippage is lost on both fills and costs are booked per order', () => {
  const r = simulateDay(stub('BUY'), day({ '25000CE': [['09:32', 100, 135, 99, 120]] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30', slippagePts: 0.5 }));
  const t = r.trades[0];
  assert.equal(t.entryPrice, 100.5);
  assert.equal(t.decisionPrice, 100);
  assert.equal(t.exitPrice, 129.5);
  const costs = orderCost('BUY', 100.5, 65, 20) + orderCost('SELL', 129.5, 65, 20);
  assert.ok(Math.abs(t.costs - costs) < 0.01);
  assert.ok(Math.abs(t.net - (t.gross - t.costs)) < 0.02);
});

test('daily loss limit stops new entries for the day', () => {
  const r = simulateDay(
    stub('BUY'),
    day({ '25000CE': [['09:32', 50, 50, 50, 50]] }),
    cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30', dailyLossLimit: 1000 }),
  );
  assert.equal(r.trades.length, 1);
  assert.ok(r.haltedAt);
});

test('strategies only ever see bars that closed before the decision minute', () => {
  violations.length = 0;
  simulateDay(stub('BUY'), day({ '25000CE': [['09:32', 100, 135, 99, 120]], '25000PE': [] }), cfg('BUY', { from_25000CE: '09:31', entryStart: '09:30' }));
  assert.deepEqual(violations, []);
});
