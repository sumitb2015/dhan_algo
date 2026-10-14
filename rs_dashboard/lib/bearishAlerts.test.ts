import { test } from 'node:test';
import assert from 'node:assert';
import {
  levelStates, stepTracker, activeLevels, watchState, CONFIRM_MS, REARM_MS, type Tracker, type LevelState,
} from './bearishAlerts.ts';
import type { Indicators } from './bearishStrikes.ts';

const ind = (o: Partial<Indicators> = {}): Indicators => ({
  close: 90, stLine: 100, stDir: -1, vwap: 95, ema: 98, barTime: 't', barsUsed: 80, ...o,
});

test('respected levels: price below all three is fine on both bases', () => {
  assert.deepStrictEqual(levelStates(ind(), 85, 'live'), { st: false, vwap: false, ema: false });
  assert.deepStrictEqual(levelStates(ind(), 85, 'closed'), { st: false, vwap: false, ema: false });
});

test('live basis: price above Supertrend line is a breach; closed basis waits for the bar', () => {
  assert.strictEqual(levelStates(ind(), 101, 'live').st, true);
  assert.strictEqual(levelStates(ind(), 101, 'closed').st, false);          // closed bar still 90, below the line
  assert.strictEqual(levelStates(ind({ close: 101 }), 85, 'closed').st, true);
});

test('Supertrend turning bullish is adverse even if the price is under the (now lower) line', () => {
  assert.strictEqual(levelStates(ind({ stDir: 1, stLine: 80 }), 79, 'live').st, true);
});

test('warming-up levels are unknown, not breached', () => {
  assert.deepStrictEqual(levelStates(ind({ stLine: null, stDir: null, ema: null }), 120, 'live'), { st: null, vwap: true, ema: null });
  assert.deepStrictEqual(levelStates(ind(), null, 'live'), { st: null, vwap: null, ema: null });
});

const obs = (state: LevelState) => [{ positionId: 'p1', level: 'st' as const, state }];

test('a breach alerts once, only after it has held for CONFIRM_MS', () => {
  let t: Tracker = {};
  let r = stepTracker(t, obs(false), 0); t = r.tracker;
  r = stepTracker(t, obs(true), 1_000); t = r.tracker;
  assert.strictEqual(r.events.length, 0);
  r = stepTracker(t, obs(true), 1_000 + CONFIRM_MS - 1); t = r.tracker;
  assert.strictEqual(r.events.length, 0);
  r = stepTracker(t, obs(true), 1_000 + CONFIRM_MS); t = r.tracker;
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['breach']);
  r = stepTracker(t, obs(true), 60_000); t = r.tracker;
  assert.strictEqual(r.events.length, 0);                                     // no repeat while still breached
  assert.deepStrictEqual(activeLevels(t, 'p1'), ['st']);
});

test('a flicker shorter than CONFIRM_MS never alerts', () => {
  let t: Tracker = {};
  t = stepTracker(t, obs(false), 0).tracker;
  t = stepTracker(t, obs(true), 1_000).tracker;
  const r = stepTracker(t, obs(false), 3_000);
  assert.strictEqual(r.events.length, 0);
  const r2 = stepTracker(r.tracker, obs(true), 20_000);
  assert.strictEqual(r2.events.length, 0);
});

test('re-arms after being respected for REARM_MS, then alerts again', () => {
  let t: Tracker = {};
  t = stepTracker(t, obs(true), 0).tracker;
  t = stepTracker(t, obs(true), CONFIRM_MS).tracker;                           // fired
  t = stepTracker(t, obs(false), 10_000).tracker;
  let r = stepTracker(t, obs(false), 10_000 + REARM_MS); t = r.tracker;
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['recovered']);
  assert.deepStrictEqual(activeLevels(t, 'p1'), []);
  t = stepTracker(t, obs(true), 40_000).tracker;
  r = stepTracker(t, obs(true), 40_000 + CONFIRM_MS);
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['breach']);
});

test('a breach that already exists on first sight (page reload) still alerts after CONFIRM_MS', () => {
  let t = stepTracker({}, obs(true), 0).tracker;
  const r = stepTracker(t, obs(true), CONFIRM_MS);
  assert.deepStrictEqual(r.events.map((e) => e.kind), ['breach']);
});

test('unknown holds state; dropped observations leave the tracker', () => {
  let t = stepTracker({}, obs(true), 0).tracker;
  t = stepTracker(t, obs(null), 2_000).tracker;
  assert.strictEqual(t['p1:st'].breached, true);
  t = stepTracker(t, [], 3_000).tracker;
  assert.deepStrictEqual(t, {});
});

test('watchState names the reason a position is not being watched', () => {
  const states = { st: false, vwap: false, ema: false } as const;
  const base = { inScope: true, feedFresh: true, hasPrice: true, hasBars: true, states, watch: { st: true, vwap: false, ema: false } };
  assert.strictEqual(watchState(base), 'watching');
  assert.strictEqual(watchState({ ...base, inScope: false }), 'other-chain');
  assert.strictEqual(watchState({ ...base, feedFresh: false }), 'no-price');
  assert.strictEqual(watchState({ ...base, hasBars: false }), 'no-bars');
  assert.strictEqual(watchState({ ...base, states: { st: null, vwap: false, ema: false } }), 'warming');
  // warming of an UNwatched level is irrelevant
  assert.strictEqual(watchState({ ...base, states: { st: false, vwap: null, ema: null } }), 'watching');
});
