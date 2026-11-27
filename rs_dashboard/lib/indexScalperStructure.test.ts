import test from 'node:test';
import assert from 'node:assert/strict';
import { marketStructure } from './indexScalperStructure.ts';

// Bars from a list of [high, low, close].
const B = (rows: [number, number, number][]) => rows.map(([h, l, c]) => ({ h, l, c }));

test('swings: strict pivots with len bars each side, labelled against the previous swing of their kind', () => {
  // two swing highs (110, then 115 = HH) and two swing lows (95, then 100 = HL); len 2
  const bars = B([
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [101, 95, 97],
    [103, 99, 102], [108, 101, 107], [115, 106, 113], [109, 102, 104], [104, 100, 102],
    [106, 101, 105], [107, 103, 106],
  ]);
  const s = marketStructure(bars, 2);
  const sw = s.swings.map(x => `${x.kind}${x.i}:${x.price}:${x.label ?? '-'}@${x.knownAt}`);
  assert.deepEqual(sw, ['H2:110:-@4', 'L4:95:-@6', 'H7:115:HH@9', 'L9:100:HL@11']);
});

test('ties are not swings (strict comparison)', () => {
  const bars = B([[100, 90, 95], [101, 91, 96], [105, 92, 100], [105, 93, 100], [101, 92, 96], [100, 91, 95]]);
  assert.equal(marketStructure(bars, 2).swings.filter(x => x.kind === 'H').length, 0);
});

test('a swing is never used before it is known: no break, no label until bar i + len', () => {
  const bars = B([[100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [101, 95, 97]]);
  const s = marketStructure(bars.slice(0, 4), 2); // bar 2's right side incomplete
  assert.equal(s.swings.length, 0);
  assert.deepEqual(marketStructure(bars, 2).swings.map(x => x.i), [2]);
});

test('direction: HH + HL up, LH + LL down, mixed otherwise, null until both kinds are labelled', () => {
  // highs 110 then 115 (HH), lows 95 then 100 (HL): up
  const up = B([
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [101, 95, 97],
    [103, 99, 102], [108, 101, 107], [115, 106, 113], [109, 102, 104], [104, 100, 102],
    [106, 101, 105], [107, 103, 106],
  ]);
  const u = marketStructure(up, 2);
  assert.equal(u.dir, 1);
  assert.deepEqual([u.lastHigh?.label, u.lastLow?.label], ['HH', 'HL']);
  // the mirror image (negated prices): LH + LL, down
  const down = up.map(b => ({ h: -b.l, l: -b.h, c: -b.c }));
  const d = marketStructure(down, 2);
  assert.equal(d.dir, -1);
  assert.deepEqual([d.lastHigh?.label, d.lastLow?.label], ['LH', 'LL']);
  // only the first swing of each kind (nothing to compare): no direction
  assert.equal(marketStructure(up.slice(0, 7), 2).dir, null);
  // HH with a LL: mixed
  const mixed = B([
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [101, 95, 97],
    [103, 99, 102], [108, 101, 107], [115, 106, 113], [109, 92, 104], [104, 100, 102],
    [106, 101, 105], [107, 103, 106],
  ]);
  assert.equal(marketStructure(mixed, 2).dir, 0);
});

test('empty / too short / len < 1: nothing', () => {
  assert.deepEqual(marketStructure([], 3), { swings: [], dir: null, lastHigh: null, lastLow: null });
  assert.equal(marketStructure(B([[1, 0, 1], [2, 1, 2]]), 3).swings.length, 0);
  assert.deepEqual(marketStructure(B([[1, 0, 1]]), 0), { swings: [], dir: null, lastHigh: null, lastLow: null });
});

test('chart indicator: swing labels only (no BOS / CHoCH), line on by default and hideable; the forming bar is left out', async () => {
  const { computeIndicator, newIndicator, indicatorLabel } = await import('./indexScalperIndicators.ts');
  const rows: [number, number, number][] = [
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [103, 99, 101],
    [107, 102, 106], [113, 105, 112], [114, 108, 113], [111, 104, 106], [112, 106, 110],
    [113, 107, 111], [109, 105, 106], [106, 98, 100], [104, 97, 99],
  ];
  const bars = rows.map(([h, l, c], i) => ({ t: 1_800_000_000 + i * 300, o: c, h, l, c }));
  const ind = { ...newIndicator('structure', 's1'), params: { len: 2, line: 1 } };
  const out = computeIndicator(bars, ind);
  assert.equal(out.series.length, 1);                       // the break-arrow series is gone
  const [s] = out.series;
  assert.equal(s.noLabel, true);
  assert.equal(s.color, ind.color);
  assert.deepEqual(s.values.flatMap((v, i) => (v === null ? [] : [`${i}:${v}`])), ['2:110', '7:114', '8:104', '10:113']);
  assert.deepEqual(s.markers!.map(m => `${m.i}:${m.text ?? '-'}`), ['2:-', '7:HH', '8:-', '10:LH']);
  assert.equal(s.markers!.some(m => m.text === 'BOS' || m.text === 'CHoCH'), false);
  for (const m of s.markers!) assert.notEqual(s.values[m.i], null);   // a marker needs a value at its bar
  // line off: the same points (the labels still need them), drawn transparent
  const off = computeIndicator(bars, { ...ind, params: { len: 2, line: 0 } }).series[0];
  assert.equal(off.color, 'transparent');
  assert.deepEqual(off.values, s.values);
  assert.deepEqual(off.markers, s.markers);
  assert.equal(indicatorLabel(ind), 'Structure (2)');       // the on / off setting is not shown as a number
  // the forming (last) bar never confirms a swing
  assert.deepEqual(computeIndicator(bars.slice(0, 12), ind).series[0].markers!.map(m => m.i), [2, 7, 8]);
});

test('withStructureLine: sets the line on every structure indicator, same list when nothing changes', async () => {
  const { newIndicator, withStructureLine } = await import('./indexScalperIndicators.ts');
  const list = [newIndicator('ema', 'a'), newIndicator('structure', 's')];
  const off = withStructureLine(list, false);
  assert.equal(off.find(i => i.kind === 'structure')!.params.line, 0);
  assert.equal(off.find(i => i.kind === 'ema'), list[0]);
  assert.equal(withStructureLine(off, false), off);
  assert.equal(withStructureLine(list, true), list);         // default (1): already on
  assert.equal(withStructureLine(off, true).find(i => i.kind === 'structure')!.params.line, 1);
});

test('withStructure: the strip switch shows / hides the chart labels, adding the indicator once when there is none', async () => {
  const { newIndicator, withStructure } = await import('./indexScalperIndicators.ts');
  const base = [newIndicator('ema', 'a')];
  const on = withStructure(base, true, 's');
  assert.deepEqual(on.map(i => `${i.kind}:${i.visible}`), ['ema:true', 'structure:true']);
  const custom = on.map(i => (i.kind === 'structure' ? { ...i, params: { len: 5 } } : i));
  const off = withStructure(custom, false, 'x');
  assert.deepEqual(off.map(i => `${i.kind}:${i.visible}`), ['ema:true', 'structure:false']);
  assert.equal(off.find(i => i.kind === 'structure')!.params.len, 5);           // hidden, never removed: swing length kept
  assert.equal(withStructure(off, true, 'y').length, 2);                         // un-hidden, not added again
  assert.equal(withStructure(on, true, 'z'), on);                                // nothing to change: same list
  assert.equal(withStructure(base, false, 'z'), base);                           // off with none: nothing added
});
