import test from 'node:test';
import assert from 'node:assert/strict';
import { auditResults } from './audit.ts';
import { simulateDay, type DayData } from './simulator.ts';
import { sessionsToHold, summarize, windowFrom } from './runStore.ts';
import { defaultsOf } from './configSchema.ts';
import { minToHm, SESSION_LAST, SESSION_OPEN } from './bars.ts';
import { initialStop, targetHit, targetOf } from './risk.ts';
import type { AlgoConfig, StrategyDefinition } from './types.ts';

const DAY = '2026-10-14';
const def: StrategyDefinition = {
  key: 'stub', label: 'Stub', description: '', docPath: '', side: 'BUY', underlyings: ['NIFTY'], status: 'UNVALIDATED',
  schema: [], defaults: {}, warmupBars: () => 10,
  gate: () => ({ bias: 'T', tone: 'neutral', allowed: ['CE', 'PE'], detail: '' }),
  scan: (ctx) => Object.values(ctx.contracts).map((c) => ({ key: c.key, strike: c.strike, option: c.option, ltp: c.ltp, score: 1, eligible: true, cols: {} })),
  onEntry: (_c, e) => ({ stop: initialStop('BUY', e, 20), target: targetOf('BUY', e, 10) }),
  manage: (p, px) => ({ stop: p.stop, exits: targetHit('BUY', px, p.target) ? [{ kind: 'TARGET', level: p.target!, reason: '' }] : [] }),
  columns: { scanner: [] },
};

function data(): DayData {
  const bars = [];
  for (let m = SESSION_OPEN; m <= SESSION_LAST; m++) {
    const c = 100 + Math.sin(m / 7) * 15;
    bars.push({ t: `${DAY} ${minToHm(m)}:00`, o: c, h: c + 3, l: c - 3, c: c + 1, v: 10, oi: null });
  }
  const spot: [string, number][] = [];
  for (let m = SESSION_OPEN; m <= SESSION_LAST; m++) spot.push([minToHm(m), 25000]);
  return { date: DAY, expiry: '2026-10-20', source: 'test', lotSize: 65, warmupSessions: 0, spot, contracts: { '25000CE': { strike: 25000, option: 'CE', bars } } };
}

const cfg = { ...defaultsOf(def), slippagePts: 0.25 } as AlgoConfig;

test('audit: a simulated day passes every check', () => {
  const d = data();
  const day = simulateDay(def, d, cfg);
  assert.ok(day.trades.length > 3);
  const a = auditResults(def, [day], cfg, 'k', () => d);
  for (const c of a.checks) assert.equal(c.failures, 0, `${c.id}: ${c.examples.join('; ')}`);
  assert.equal(a.coldEntries.trades, day.trades.length); // no warm-up bars at all
  assert.equal(a.warmup.Wed.partial, 1);
});

test('audit: a tampered trade fails exactly the matching check', () => {
  const d = data();
  const day = simulateDay(def, d, cfg);
  day.trades[0] = { ...day.trades[0], gross: day.trades[0].gross + 500 };
  const a = auditResults(def, [day], cfg, 'k', () => d);
  const failing = a.checks.filter((c) => c.failures > 0).map((c) => c.id);
  assert.deepEqual(failing, ['gross', 'net']);
});

test('sessionsToHold: today only after 15:35, never past `to`', () => {
  const all = () => true;
  assert.deepEqual(sessionsToHold('2026-10-12', '2026-10-14', '15:00', all), ['2026-10-12', '2026-10-13']);
  assert.deepEqual(sessionsToHold('2026-10-12', '2026-10-14', '15:40', all), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.deepEqual(sessionsToHold('2026-10-12', '2026-10-14', '15:40', all, '2026-10-12'), ['2026-10-12']);
});

test('windowFrom: counts back from the DB latest, never before its earliest', () => {
  assert.equal(windowFrom('week', '2026-10-13', '2020-12-31'), '2026-10-06');
  assert.equal(windowFrom('1year', '2021-03-01', '2020-12-31'), '2020-12-31');
});

test('summarize: drawdown on the cumulative daily net', () => {
  const d = (date: string, net: number) => ({ ...simulateDay(def, { ...data(), contracts: {} }, cfg), date, net });
  const s = summarize([d('2026-10-01', 100), d('2026-10-02', -300), d('2026-10-03', 50)]);
  assert.equal(s.net, -150);
  assert.equal(s.maxDrawdown, -300);
});
