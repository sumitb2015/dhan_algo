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

test('breaks: BOS with the structure, CHoCH against it; a level breaks once; dir = last break', () => {
  // up leg: swing high 110 (bar 2) broken by close 112 at bar 6 -> first break = BOS up
  // then a swing low 104 (bar 8) broken by close 100 at bar 12 -> against an up structure = CHoCH down
  const bars = B([
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [103, 99, 101],
    [107, 102, 106], [113, 105, 112], [114, 108, 113], [111, 104, 106], [112, 106, 110],
    [113, 107, 111], [109, 105, 106], [106, 98, 100], [104, 97, 99],
  ]);
  const s = marketStructure(bars, 2);
  assert.deepEqual(s.breaks.map(b => `${b.kind}${b.up ? '↑' : '↓'}@${b.i}:${b.level}`), ['BOS↑@6:110', 'CHoCH↓@12:104']);
  assert.equal(s.dir, -1);
  assert.equal(s.breaks.filter(b => b.level === 110).length, 1); // closes above 110 later do not break it again
});

test('empty / too short / len < 1: nothing', () => {
  assert.deepEqual(marketStructure([], 3), { swings: [], breaks: [], dir: null });
  assert.equal(marketStructure(B([[1, 0, 1], [2, 1, 2]]), 3).swings.length, 0);
  assert.deepEqual(marketStructure(B([[1, 0, 1]]), 0), { swings: [], breaks: [], dir: null });
});

test('chart indicator: zig-zag through the swings, labelled swing markers, BOS / CHoCH arrows; the forming bar is left out', async () => {
  const { computeIndicator, newIndicator } = await import('./indexScalperIndicators.ts');
  const rows: [number, number, number][] = [
    [100, 96, 98], [105, 97, 103], [110, 101, 108], [104, 98, 100], [103, 99, 101],
    [107, 102, 106], [113, 105, 112], [114, 108, 113], [111, 104, 106], [112, 106, 110],
    [113, 107, 111], [109, 105, 106], [106, 98, 100], [104, 97, 99],
  ];
  const bars = rows.map(([h, l, c], i) => ({ t: 1_800_000_000 + i * 300, o: c, h, l, c }));
  const ind = { ...newIndicator('structure', 's1'), params: { len: 2 } };
  const out = computeIndicator(bars, ind);
  const s = out.series[0];
  assert.equal(out.pane, 'price');
  assert.equal(s.noLabel, true);
  assert.equal(s.values.length, bars.length);
  assert.deepEqual(s.values.flatMap((v, i) => (v === null ? [] : [`${i}:${v}`])), ['2:110', '7:114', '8:104', '10:113']);
  assert.deepEqual(s.markers!.filter(m => m.text === 'BOS' || m.text === 'CHoCH').map(m => `${m.text}@${m.i}`), ['BOS@6', 'CHoCH@12']);
  assert.deepEqual(s.markers!.filter(m => m.shape === 'circle').map(m => `${m.i}:${m.text ?? '-'}`), ['2:-', '7:HH', '8:-', '10:LH']);
  // the forming (last) bar never confirms: a close below 104 on it alone would not be a break
  const formingOnly = computeIndicator(bars.slice(0, 13), ind).series[0].markers!.map(m => m.text);
  assert.equal(formingOnly.includes('CHoCH'), false);
});
