import { test } from 'node:test';
import assert from 'node:assert';
import {
  applyFilters,
  evaluatePresets,
  matchesConditions,
  moneyness,
  roundToTick,
  sanitizeConditions,
  sanitizeFilters,
  type SnapshotGroup,
  type SnapshotRow,
  type SnapshotUnderlying,
} from './optionsScreener.ts';

// d tuple: [price%, oi%, winVol, rvol, ivChg, oiChg, priceChg]
function row(p: Partial<SnapshotRow> & { d5?: (number | null)[] | null }): SnapshotRow {
  return {
    id: p.id ?? 'NSE_FNO:1', sid: '1', xs: 'NSE_FNO', x: 'NSE', u: p.u ?? 'HINDALCO', k: p.k ?? 'stock',
    e: p.e ?? '2026-10-27', s: p.s ?? 980, t: p.t ?? 'CE', off: p.off ?? 0, lot: 1400, mult: 1400, tick: 0.05,
    ltp: p.ltp ?? 20, oi: p.oi ?? 1000, v: p.v ?? 500, iv: 20, ts: 0,
    d: { '5': p.d5 === undefined ? [0, 0, 0, null, 0, 0, 0] : p.d5 },
  };
}
const und: Record<string, SnapshotUnderlying> = {
  HINDALCO: { kind: 'stock', exch: 'NSE', spot: 980, chg: { '5': 0.6 } },
};

test('moneyness: CE below ATM is ITM, PE below ATM is OTM', () => {
  assert.equal(moneyness('CE', 0), 'ATM');
  assert.equal(moneyness('CE', -2), 'ITM2');
  assert.equal(moneyness('CE', 3), 'OTM3');
  assert.equal(moneyness('PE', -2), 'OTM2');
  assert.equal(moneyness('PE', 1), 'ITM1');
});

test('custom conditions: all must hold, missing baseline never matches', () => {
  const conds = sanitizeConditions([
    { metric: 'premium_pct', window: 5, op: 'gte', value: 5 },
    { metric: 'oi_pct', window: 5, op: 'gte', value: 10 },
  ]);
  assert.equal(conds.length, 2);
  assert.ok(matchesConditions(row({ d5: [9.9, 17, 390, 15, 0.2, 100, 1.6] }), conds, und));
  assert.ok(!matchesConditions(row({ d5: [9.9, 5, 390, 15, 0.2, 100, 1.6] }), conds, und));
  assert.ok(!matchesConditions(row({ d5: null }), conds, und));
  assert.ok(!matchesConditions(row({ d5: [9.9, 17, 390, 15, 0.2, 100, 1.6] }), [], und));
});

test('sanitizeConditions drops junk', () => {
  assert.deepEqual(sanitizeConditions([{ metric: 'nope', window: 5, op: 'gte', value: 1 }, { metric: 'rvol', window: 7, op: 'gte', value: 1 }, 'x']), []);
});

test('presets: short covering, call writing, unusual volume, breakout', () => {
  const rows = [
    row({ id: 'A:1', d5: [8, -9, 40, 2, 0, -50, 1] }),                   // short covering
    row({ id: 'A:2', t: 'CE', d5: [-7, 12, 40, 1, 0, 80, -1] }),        // call writing
    row({ id: 'A:3', t: 'PE', d5: [-7, 12, 40, 1, 0, 80, -1] }),        // put writing
    row({ id: 'A:4', d5: [1, 1, 60, 8, 0, 5, 0.1] }),                   // unusual volume (+ breakout: CE, up 0.6%, rvol≥3)
    row({ id: 'A:5', t: 'PE', d5: [1, 1, 60, 8, 0, 5, 0.1] }),          // UV but PE against the up-move → no breakout
  ];
  const { hits, counts } = evaluatePresets(rows, [], und, 5, '2026-09-29');
  assert.deepEqual(hits.get('A:1'), ['short_covering']);
  assert.deepEqual(hits.get('A:2'), ['call_writing']);
  assert.deepEqual(hits.get('A:3'), ['put_writing']);
  assert.deepEqual(hits.get('A:4'), ['unusual_volume', 'breakout_activity']);
  assert.deepEqual(hits.get('A:5'), ['unusual_volume']);
  assert.equal(counts.unusual_volume, 2);
});

test('presets: group-level wall shift and straddle flag the right contracts', () => {
  const rows = [
    row({ id: 'N:1', u: 'NIFTY', e: '2026-09-30', s: 25000, t: 'CE', off: 0 }),
    row({ id: 'N:2', u: 'NIFTY', e: '2026-09-30', s: 25000, t: 'PE', off: 0 }),
    row({ id: 'N:3', u: 'NIFTY', e: '2026-09-30', s: 25200, t: 'CE', off: 4 }),
  ];
  const groups: SnapshotGroup[] = [{
    u: 'NIFTY', e: '2026-09-30', x: 'NSE', atm: 25000, pcr: 0.9, ceWall: 25200, peWall: 24800, straddle: 200,
    d: { '5': { pcr: 0.02, ceWallFrom: 25500, peWallFrom: 24800, str: 6.5, tilt: 3 } },
  }];
  const { hits } = evaluatePresets(rows, groups, {}, 5, '2026-09-29');
  assert.deepEqual(hits.get('N:3'), ['oi_wall_shift']);
  assert.deepEqual(hits.get('N:1'), ['straddle_move']);
  assert.deepEqual(hits.get('N:2'), ['straddle_move']);
});

test('filters: segment, type, strikes-from-ATM and nearest expiry', () => {
  const rows = [
    row({ id: '1', e: '2026-09-29', off: 0 }),
    row({ id: '2', e: '2026-10-27', off: 4 }),
    row({ id: '3', e: '2026-10-27', t: 'PE', off: 1 }),
    row({ id: '4', u: 'CRUDEOIL', k: 'mcx', e: '2026-10-16' }),
  ];
  const ids = (f: Record<string, unknown>) => applyFilters(rows, sanitizeFilters(f)).map((r) => r.id);
  assert.deepEqual(ids({ segment: 'mcx' }), ['4']);
  assert.deepEqual(ids({ type: 'PE' }), ['3']);
  assert.deepEqual(ids({ maxOff: 2 }), ['1', '3', '4']);
  assert.deepEqual(ids({ expiry: 'near', segment: 'stock' }), ['1']);
  assert.deepEqual(ids({ expiry: 'next', segment: 'stock' }), ['2', '3']);
  assert.deepEqual(ids({ symbols: ['crudeoil'] }), ['4']);
});

test('roundToTick', () => {
  assert.equal(roundToTick(18.37, 0.05), 18.35);
  assert.equal(roundToTick(18.38, 0.05), 18.4);
  assert.equal(roundToTick(5501.3, 1), 5501);
});
