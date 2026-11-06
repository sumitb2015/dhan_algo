import test from 'node:test';
import assert from 'node:assert/strict';
import { ignoredByFilter, modelForRule, ruleText, skippedBrick, withSide, type AutoRule } from './pnfAutoRule.ts';
import type { PnfSignal } from './straddlePnf.ts';

const sig = (id: string): PnfSignal => ({ id, kind: 'RENKO_BUY', col: 0, bar: 0, t: 0, price: 1, belowVwap: false });
const m = { signals: [sig('n')], trend: [sig('t')], twoBack: [sig('2')], oneBack: [sig('1')], stSignals: [sig('s')], other: 7 };

test('every rule maps to its own signal set and keeps the rest of the model', () => {
  const ids: Record<AutoRule, string> = { nbrick: 'n', trend: 't', twoback: '2', oneback: '1', supertrend: 's' };
  for (const [rule, id] of Object.entries(ids) as [AutoRule, string][]) {
    const out = modelForRule(rule, m);
    assert.equal(out.signals[0].id, id, rule);
    assert.equal(out.other, 7);
  }
  assert.equal(modelForRule('nbrick', m), m, 'the plain rule is the model itself');
});

test('every rule has its own description, naming N where it matters', () => {
  const texts = (['nbrick', 'trend', 'twoback', 'oneback', 'supertrend'] as const).map(r => ruleText(r, 3));
  assert.equal(new Set(texts).size, 5);
  assert.match(ruleText('trend', 3), /completes 3 same-colour/);
  assert.match(ruleText('nbrick', 2), /after 2 confirming bricks/);
});

test('withSide keeps only the allowed side\'s signals; both is the model itself; exits are the engine\'s, not filtered here', () => {
  const buy = sig('b'); const sell = { ...sig('s'), kind: 'RENKO_SELL' as const };
  const pnfSell = { ...sig('p'), kind: 'DOUBLE_BOTTOM_SELL' as const };
  const model = { signals: [buy, sell, pnfSell], other: 1 };
  assert.equal(withSide(model, 'both'), model);
  assert.deepEqual(withSide(model, 'buy').signals.map(s => s.id), ['b']);
  assert.deepEqual(withSide(model, 'sell').signals.map(s => s.id), ['s', 'p']);
  assert.equal(withSide(model, 'buy').other, 1);
});

test('ignoredByFilter names the fresh signal the filter holds back, and only that', () => {
  const buy = { ...sig('b'), t: 100 };
  const sell = { ...sig('s'), kind: 'RENKO_SELL' as const, t: 100 };
  const older = { ...sig('o'), kind: 'RENKO_SELL' as const, t: 40 };
  const m = (signals: PnfSignal[], lastBarT: number | null = 100) => ({ signals, lastBarT });
  assert.equal(ignoredByFilter(m([sell]), 'buy', 0)?.id, 's', 'a SELL on the last bar under Buy only');
  assert.equal(ignoredByFilter(m([buy]), 'sell', 0)?.id, 'b');
  assert.equal(ignoredByFilter(m([sell]), 'both', 0), null, 'nothing is held back without a filter');
  assert.equal(ignoredByFilter(m([sell]), 'sell', 0), null, 'an allowed signal is entered, not ignored');
  assert.equal(ignoredByFilter(m([sell, buy]), 'buy', 0), null, 'an allowed signal on the same bar wins');
  assert.equal(ignoredByFilter(m([older]), 'buy', 0), null, 'a signal that is not on the last bar is old news');
  assert.equal(ignoredByFilter(m([sell]), 'buy', 100), null, 'at or before the watermark: already handled');
  assert.equal(ignoredByFilter(m([sell], null), 'buy', 0), null);
});

test('skippedBrick explains a Supertrend brick of the wrong colour on the newest closed bar, and nothing else', () => {
  // 2026-11-06 chart 2: armed at 12:05:25 (watermark = bar 12:04:30), the 12:05:00 bar printed a red brick while the line was up at 73.75.
  const m = {
    columns: [{ dir: 'X' as const }, { dir: 'O' as const }],
    columnTimes: [{ start: 100 }, { start: 130 }],
    supertrend: [{ line: 73.75, dir: 1 as const }, { line: 73.75, dir: 1 as const }],
    lastBarT: 130,
  };
  const s = skippedBrick(m, 'supertrend', 100);
  assert.match(s?.text ?? '', /^red brick skipped: Supertrend line is up \(73\.75\)/);
  assert.equal(skippedBrick(m, 'trend', 100), null, 'other rules are not explained here');
  assert.equal(skippedBrick(m, 'supertrend', 130), null, 'a brick from before arming is not news');
  assert.equal(skippedBrick({ ...m, lastBarT: 160 }, 'supertrend', 100), null, 'the newest closed bar printed no brick');
  // the brick agrees with the line: it is a signal, so nothing to explain
  assert.equal(skippedBrick({ ...m, supertrend: [m.supertrend[0], { line: 80, dir: -1 as const }] }, 'supertrend', 100), null);
  assert.match(skippedBrick({ ...m, supertrend: [m.supertrend[0], { line: null, dir: null }] }, 'supertrend', 100)?.text ?? '', /not ready/);
  // several bricks on one bar: the last one is explained
  const two = { ...m, columns: [...m.columns, { dir: 'X' as const }], columnTimes: [...m.columnTimes, { start: 130 }], supertrend: [...m.supertrend, { line: 90, dir: -1 as const }] };
  assert.match(skippedBrick(two, 'supertrend', 100)?.text ?? '', /^green brick skipped: Supertrend line is down \(90\.00\)/);
});
