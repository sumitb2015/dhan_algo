import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDEX_MAP, againstDir, chartActionOf, dirOf, legBias, legText, mappedTarget, parseIndexMap, pickExpiry, pickStrike, readIndexMap, tradedOf,
  type IndexMap,
} from './pnfIndexMap.ts';

const K = [24000, 24050, 24100, 24150, 24200, 24250, 24300];

test('parseIndexMap: a valid map passes; anything malformed is refused, not defaulted', () => {
  const ok = { bull: { action: 'SELL', opt: 'PE', offset: 1 }, bear: { action: 'SELL', opt: 'CE', offset: 2 }, expiry: '2026-11-11' };
  assert.deepEqual(parseIndexMap(ok), ok);
  assert.equal(parseIndexMap({ ...ok, expiry: 'NEAREST' })?.expiry, 'NEAREST');
  assert.equal(parseIndexMap(null), null);
  assert.equal(parseIndexMap({ ...ok, bull: { action: 'HOLD', opt: 'PE', offset: 0 } }), null);
  assert.equal(parseIndexMap({ ...ok, bull: { action: 'BUY', opt: 'FUT', offset: 0 } }), null);
  assert.equal(parseIndexMap({ ...ok, bear: { action: 'BUY', opt: 'CE', offset: 1.5 } }), null);
  assert.equal(parseIndexMap({ ...ok, bear: { action: 'BUY', opt: 'CE', offset: 11 } }), null);
  assert.equal(parseIndexMap({ ...ok, expiry: 'soon' }), null);
  assert.equal(parseIndexMap({ bull: ok.bull, expiry: 'NEAREST' }), null);
});

test('readIndexMap: corrupt storage falls back to BUY CE / BUY PE at ATM on the nearest expiry', () => {
  assert.deepEqual(readIndexMap(null), DEFAULT_INDEX_MAP);
  assert.deepEqual(readIndexMap('{oops'), DEFAULT_INDEX_MAP);
  assert.deepEqual(readIndexMap(JSON.stringify({ bull: 1 })), DEFAULT_INDEX_MAP);
});

test('dirOf / chartActionOf: BUY is bullish, SELL is bearish', () => {
  assert.equal(dirOf('BUY'), 'bull');
  assert.equal(dirOf('SELL'), 'bear');
  assert.equal(chartActionOf('bull'), 'BUY');
  assert.equal(chartActionOf('bear'), 'SELL');
});

test('legBias: BUY CE and SELL PE gain as the index rises; BUY PE and SELL CE as it falls', () => {
  assert.equal(legBias({ action: 'BUY', opt: 'CE', offset: 0 }), 1);
  assert.equal(legBias({ action: 'SELL', opt: 'PE', offset: 0 }), 1);
  assert.equal(legBias({ action: 'BUY', opt: 'PE', offset: 0 }), -1);
  assert.equal(legBias({ action: 'SELL', opt: 'CE', offset: 0 }), -1);
  assert.equal(againstDir('bull', { action: 'BUY', opt: 'PE', offset: 0 }), true);
  assert.equal(againstDir('bear', { action: 'SELL', opt: 'CE', offset: 0 }), false);
});

test('pickStrike: ATM is the nearest strike; +N steps OTM (CE up, PE down), -N steps ITM', () => {
  assert.equal(pickStrike(K, 24160, 'CE', 0), 24150);
  assert.equal(pickStrike(K, 24160, 'PE', 0), 24150);
  assert.equal(pickStrike(K, 24160, 'CE', 2), 24250);
  assert.equal(pickStrike(K, 24160, 'PE', 2), 24050);
  assert.equal(pickStrike(K, 24160, 'CE', -1), 24100);
  assert.equal(pickStrike(K, 24160, 'PE', -1), 24200);
  assert.equal(pickStrike(K, 24125, 'CE', 0), 24100, 'a tie takes the lower strike, as atmStrike does');
});

test('pickStrike: no spot or an offset off the list end is null, never a guessed strike', () => {
  assert.equal(pickStrike(K, null, 'CE', 0), null);
  assert.equal(pickStrike(K, 0, 'CE', 0), null);
  assert.equal(pickStrike(K, 24290, 'CE', 1), null);
  assert.equal(pickStrike(K, 24010, 'PE', 1), null);
  assert.equal(pickStrike([], 24100, 'CE', 0), null);
});

test('pickExpiry: NEAREST is the first listed; a chosen expiry only while it is still listed', () => {
  const ex = ['2026-11-11', '2026-11-18'];
  assert.equal(pickExpiry(DEFAULT_INDEX_MAP, ex), '2026-11-11');
  assert.equal(pickExpiry({ ...DEFAULT_INDEX_MAP, expiry: '2026-11-18' }, ex), '2026-11-18');
  assert.equal(pickExpiry({ ...DEFAULT_INDEX_MAP, expiry: '2026-11-04' }, ex), null);
  assert.equal(pickExpiry(DEFAULT_INDEX_MAP, []), null);
});

test('mappedTarget: each direction trades its own leg', () => {
  const map: IndexMap = { bull: { action: 'SELL', opt: 'PE', offset: 1 }, bear: { action: 'BUY', opt: 'PE', offset: 0 }, expiry: 'NEAREST' };
  const bull = mappedTarget({ symbol: 'NIFTY' }, map, 'bull', 24160, ['2026-11-11'], () => K);
  assert.deepEqual(bull, { target: { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-11', strike: 24100, side: 'PE' }, action: 'SELL' });
  const bear = mappedTarget({ symbol: 'NIFTY' }, map, 'bear', 24160, ['2026-11-11'], () => K);
  assert.ok(typeof bear !== 'string');
  assert.equal(bear.target.strike, 24150);
  assert.equal(bear.action, 'BUY');
});

test('mappedTarget: refuses with no spot, no expiry or an off-list strike', () => {
  assert.match(mappedTarget({ symbol: 'NIFTY' }, DEFAULT_INDEX_MAP, 'bull', null, ['2026-11-11'], () => K) as string, /No fresh NIFTY price/);
  assert.match(mappedTarget({ symbol: 'NIFTY' }, DEFAULT_INDEX_MAP, 'bull', 24100, [], () => K) as string, /no live options/);
  assert.match(mappedTarget({ symbol: 'NIFTY' }, { ...DEFAULT_INDEX_MAP, expiry: '2026-10-01' }, 'bull', 24100, ['2026-11-11'], () => K) as string, /pick another expiry/);
  const far = { ...DEFAULT_INDEX_MAP, bull: { action: 'BUY' as const, opt: 'CE' as const, offset: 5 } };
  assert.match(mappedTarget({ symbol: 'NIFTY' }, far, 'bull', 24290, ['2026-11-11'], () => K) as string, /outside the listed/);
});

test('tradedOf: only a single CE / PE of the same underlying belongs to the index chart', () => {
  const o = { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-11', strike: 24100, side: 'CE' as const };
  assert.equal(tradedOf({ symbol: 'NIFTY' }, o), true);
  assert.equal(tradedOf({ symbol: 'BANKNIFTY' }, o), false);
  assert.equal(tradedOf({ symbol: 'NIFTY' }, { ...o, side: 'STRADDLE' }), false);
  assert.equal(tradedOf({ symbol: 'NIFTY' }, { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' }), false);
});

test('legText', () => {
  assert.equal(legText({ action: 'BUY', opt: 'CE', offset: 0 }), 'BUY CE ATM');
  assert.equal(legText({ action: 'SELL', opt: 'PE', offset: 2 }), 'SELL PE +2 OTM');
  assert.equal(legText({ action: 'BUY', opt: 'CE', offset: -1 }), 'BUY CE 1 ITM');
});
