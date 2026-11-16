import { test } from 'node:test';
import assert from 'node:assert';
import {
  tpoLetter,
  isoWeekKey,
  suggestRowSize,
  splitSessions,
  sessionPeriods,
  pocIndex,
  valueAreaIdx,
  buildDayProfiles,
  buildCompositeProfiles,
  classifyDay,
  averageIb,
  powerDegree,
  tpoSkew,
  nakedPocs,
  rowFloor,
  minRowSize,
  MAX_ROWS_PER_PROFILE,
  type Bar,
  type Profile,
} from './marketProfile.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** One 1-minute bar per period at the period's first minute, with the given range. */
function periodBars(day: string, ranges: [number, number][], opts: { v?: number; endMin?: number } = {}): Bar[] {
  const bars: Bar[] = ranges.map(([l, h], i) => {
    const m = 9 * 60 + 15 + i * 30;
    return { t: `${day} ${pad(Math.floor(m / 60))}:${pad(m % 60)}:00`, o: l, h, l, c: h, v: opts.v ?? 0 };
  });
  if (opts.endMin !== undefined) {
    const last = bars[bars.length - 1];
    bars.push({ ...last, t: `${day} ${pad(Math.floor(opts.endMin / 60))}:${pad(opts.endMin % 60)}:00`, o: last.c, h: last.c, l: last.c });
  }
  return bars;
}

const rowsOf = (p: Profile) => p.rows.map((r) => `${r.price}:${r.marks.map(tpoLetter).join('')}`);

test('tpoLetter runs A-Z then a-z', () => {
  assert.strictEqual(tpoLetter(0), 'A');
  assert.strictEqual(tpoLetter(12), 'M');
  assert.strictEqual(tpoLetter(26), 'a');
  assert.strictEqual(tpoLetter(51), 'z');
  assert.strictEqual(tpoLetter(52), 'A');
});

test('isoWeekKey uses ISO weeks across a year boundary', () => {
  assert.strictEqual(isoWeekKey('2026-11-16'), '2026-W47');
  assert.strictEqual(isoWeekKey('2026-01-01'), '2026-W01'); // Thursday
  assert.strictEqual(isoWeekKey('2027-01-01'), '2026-W53'); // Friday of 2026's last week
});

test('suggestRowSize snaps the median range / 40 onto the tick ladder', () => {
  assert.strictEqual(suggestRowSize([200, 180, 220]), 5);
  assert.strictEqual(suggestRowSize([]), 0.05);
});

test('splitSessions drops pre-open and post-close bars and sorts', () => {
  const bars: Bar[] = [
    { t: '2026-11-13 09:20:00', o: 1, h: 2, l: 1, c: 2, v: 0 },
    { t: '2026-11-13 09:00:00', o: 1, h: 2, l: 1, c: 2, v: 0 },
    { t: '2026-11-13 15:45:00', o: 1, h: 2, l: 1, c: 2, v: 0 },
    { t: '2026-11-13 09:15:00', o: 1, h: 2, l: 1, c: 2, v: 0 },
  ];
  const s = splitSessions(bars);
  assert.deepStrictEqual(s.get('2026-11-13')!.map((b) => b.t), ['2026-11-13 09:15:00', '2026-11-13 09:20:00']);
});

test('sessionPeriods anchors 30-minute periods at 09:15 and aggregates OHLC', () => {
  const bars: Bar[] = [
    { t: '2026-11-13 09:15:00', o: 10, h: 12, l: 9, c: 11, v: 0 },
    { t: '2026-11-13 09:44:00', o: 11, h: 14, l: 10, c: 13, v: 0 },
    { t: '2026-11-13 09:45:00', o: 13, h: 13, l: 12, c: 12, v: 0 },
    { t: '2026-11-13 15:29:00', o: 20, h: 21, l: 19, c: 20, v: 0 },
  ];
  const p = sessionPeriods(bars);
  assert.deepStrictEqual(p.map((x) => [x.letter, x.t.slice(11, 16), x.o, x.h, x.l, x.c]), [
    ['A', '09:15', 10, 14, 9, 13],
    ['B', '09:45', 13, 13, 12, 12],
    ['M', '15:15', 20, 21, 19, 20],
  ]);
});

test('pocIndex breaks ties toward the middle of the range', () => {
  assert.strictEqual(pocIndex([3, 1, 3, 1, 1]), 2);
  assert.strictEqual(pocIndex([1, 5, 2]), 1);
  assert.strictEqual(pocIndex([]), -1);
});

test('valueAreaIdx adds the heavier two-row PAIR as a whole (Steidlmayer / CBOT)', () => {
  // total 20, 70% = 14. POC row 3 (6). Up pair (4,5)=3+1=4, down pair (2,1)=4+2=6 → down: 6+4+2=12.
  // Next: up (4,5)=4 vs down (0)=1 → up pair added WHOLE: +3+1 = 16 (stopping at row 4's 15
  // would leave the value area one row narrower than a TPO platform shows).
  const counts = [1, 2, 4, 6, 3, 1, 1, 2];
  assert.deepStrictEqual(valueAreaIdx(counts, 3, 70), { lo: 1, hi: 5 });
  // Near an edge the pair is whatever rows are left.
  assert.deepStrictEqual(valueAreaIdx([5, 1, 1], 0, 100), { lo: 0, hi: 2 });
});

test("TPO count above/below the POC leaves out the POC row and single-print tails (Dalton)", () => {
  // A sells off from 30 to 20 alone (selling tail 26-30); B-D build 20-25, POC in there.
  const [p] = buildDayProfiles(periodBars('2026-11-13', [[20, 30], [20, 25], [20, 25], [21, 24]]), { rowSize: 1 });
  assert.deepStrictEqual(p.sellingTail, { from: 26, to: 30 });
  const pocRow = p.rows.findIndex((r) => r.price === p.poc);
  const above = p.rows.slice(pocRow + 1).filter((r) => r.price < 26).reduce((s, r) => s + r.marks.length, 0);
  const below = p.rows.slice(0, pocRow).reduce((s, r) => s + r.marks.length, 0);
  assert.strictEqual(p.tpoAbove, above, 'tail rows 26-30 are not counted');
  assert.strictEqual(p.tpoBelow, below);
});

test('day profile reproduces the course diagram (letters, POC, IB, value area)', () => {
  // Rows 1..10 at row size 1. Each period's [low, high] read off the diagram in the course.
  const ranges: [number, number][] = [
    [4, 10], // A
    [1, 7],  // B
    [6, 9],  // C
    [4, 6],  // D
    [2, 5],  // E
    [1, 2],  // F
    [2, 8],  // G
    [4, 6],  // H
    [2, 5],  // I
    [4, 5],  // J
    [5, 7],  // K
    [3, 5],  // L
    [5, 5],  // M
  ];
  const [p] = buildDayProfiles(periodBars('2026-11-13', ranges), { rowSize: 1 });
  assert.strictEqual(p.rows.length, 10);
  assert.deepStrictEqual(rowsOf(p).slice(-1), ['10:A']);
  const r5 = p.rows.find((r) => r.price === 5)!;
  assert.strictEqual(r5.marks.map(tpoLetter).join(''), 'ABDEGHIJKLM');
  assert.strictEqual(p.poc, 5);
  assert.strictEqual(p.ibHigh, 10);
  assert.strictEqual(p.ibLow, 1);
  assert.strictEqual(p.extUp, 0);
  assert.strictEqual(p.extDown, 0);
  assert.ok(p.val <= 4 && p.vah >= 6, `VA ${p.val}-${p.vah} should wrap the fat middle`);
  assert.strictEqual(p.totalTpo, p.rows.reduce((s, r) => s + r.marks.length, 0));
  assert.strictEqual(p.vpoc, null, 'no volume → no VPOC');
});

test('selling tail, buying tail, mid-profile single prints and poor high/low', () => {
  // A spikes 20-24 alone (selling tail 22-24 after B..D overlap at 20-21). E drops to 0.
  const ranges: [number, number][] = [
    [18, 24], // A
    [15, 21], // B
    [15, 20], // C
    [15, 20], // D
    [10, 16], // E  → 10..14 single (with F below)
    [0, 3],   // F  → after a gap: buying tail 0..3 is single and 4..9 empty? no – rows must be contiguous
  ];
  // F's range leaves rows 4..9 untouched; the profile still spans them with zero TPOs.
  const [p] = buildDayProfiles(periodBars('2026-11-13', ranges), { rowSize: 1 });
  assert.deepStrictEqual(p.sellingTail, { from: 22, to: 24 });
  assert.deepStrictEqual(p.buyingTail, { from: 0, to: 3 });
  assert.deepStrictEqual(p.singlePrints, [{ from: 10, to: 14 }]);
  assert.strictEqual(p.poorHigh, false);
  assert.strictEqual(p.poorLow, false);

  const [q] = buildDayProfiles(periodBars('2026-11-13', [[10, 15], [10, 15], [12, 13]]), { rowSize: 1 });
  assert.strictEqual(q.poorHigh, true);
  assert.strictEqual(q.poorLow, true);
  assert.strictEqual(q.sellingTail, null);
});

test('a developing period does not make single prints; only today can be developing', () => {
  const ranges: [number, number][] = [[10, 12], [10, 12], [12, 20]];
  const bars = periodBars('2026-11-16', ranges);
  const [live] = buildDayProfiles(bars, { rowSize: 1, today: '2026-11-16' });
  assert.strictEqual(live.developing, true);
  assert.strictEqual(live.sellingTail, null, 'C is still forming');
  const [past] = buildDayProfiles(bars, { rowSize: 1, today: '2026-11-17' });
  assert.strictEqual(past.developing, false);
  assert.deepStrictEqual(past.sellingTail, { from: 13, to: 20 });
  const [closed] = buildDayProfiles(periodBars('2026-11-16', ranges, { endMin: 15 * 60 + 29 }), { rowSize: 1, today: '2026-11-16' });
  assert.strictEqual(closed.developing, false);
});

test('volume is spread over the rows each bar spans and gives the VPOC', () => {
  const bars: Bar[] = [
    { t: '2026-11-13 09:15:00', o: 10, h: 11, l: 10, c: 11, v: 100 },
    { t: '2026-11-13 09:16:00', o: 11, h: 13, l: 11, c: 12, v: 30 },
  ];
  const [p] = buildDayProfiles(bars, { rowSize: 1 });
  assert.deepStrictEqual(p.rows.map((r) => r.volume), [50, 60, 10, 10]);
  assert.strictEqual(p.vpoc, 11);
});

test('rotation factor sums higher/lower highs and lows', () => {
  const [p] = buildDayProfiles(periodBars('2026-11-13', [[10, 12], [11, 13], [11, 14], [9, 12]]), { rowSize: 1 });
  // B: +1 +1, C: +1 0, D: -1 -1 → 1
  assert.strictEqual(p.rotationFactor, 1);
});

function dayWith(ib: [number, number], rest: [number, number][], close?: number): Profile {
  const bars = periodBars('2026-11-13', [ib, ib, ...rest]);
  if (close !== undefined) bars[bars.length - 1].c = close;
  return buildDayProfiles(bars, { rowSize: 1 })[0];
}

test('classifyDay covers each course day type', () => {
  assert.strictEqual(classifyDay(dayWith([100, 110], [[102, 108]]), 30), 'Non-Trend');
  assert.strictEqual(classifyDay(dayWith([100, 140], [[110, 130]]), 30), 'Normal');
  assert.strictEqual(classifyDay(dayWith([100, 120], [[110, 130]], 125), 20), 'Normal Variation Up');
  assert.strictEqual(classifyDay(dayWith([100, 120], [[90, 110]], 100), 20), 'Normal Variation Down');
  assert.strictEqual(classifyDay(dayWith([100, 110], [[108, 125]], 124), 20), 'Trend Up');
  assert.strictEqual(classifyDay(dayWith([100, 110], [[60, 105]], 80), 20), 'Trend Down', 'extension > 2× IB');
  assert.strictEqual(classifyDay(dayWith([100, 120], [[90, 130]], 110), 20), 'Neutral Center');
  assert.strictEqual(classifyDay(dayWith([100, 120], [[90, 130]], 129), 20), 'Neutral Extreme');
});

test('averageIb uses only earlier sessions', () => {
  const bars = [
    ...periodBars('2026-11-11', [[100, 110], [100, 110]]),
    ...periodBars('2026-11-12', [[100, 130], [100, 130]]),
    ...periodBars('2026-11-13', [[100, 200], [100, 200]]),
  ];
  const ps = buildDayProfiles(bars, { rowSize: 1 });
  assert.strictEqual(averageIb(ps, 0), null);
  assert.strictEqual(averageIb(ps, 2), 20);
});

test('powerDegree ranks the six bullish and six bearish degrees', () => {
  // Previous day: VA 100-110, range 90-120. Today: IB 115-125, VA 112-128 (synthetic).
  // vah is the bottom of the top VA row: with rowSize 1 the value area tops out at vah + 1.
  const prev = { vah: 110, val: 100, high: 120, low: 90, rowSize: 1 } as Profile;
  const today = { vah: 128, val: 112, ibHigh: 125, ibLow: 115, rowSize: 1 } as Profile;
  assert.strictEqual(powerDegree(today, prev, 105).side, 'balanced');
  assert.strictEqual(powerDegree(today, prev, 122).degree, 1 + 3, 'in IB, above prev range');
  assert.strictEqual(powerDegree({ ...today, ibLow: 111, ibHigh: 113 } as Profile, prev, 112).degree, 1);
  const lowToday = { vah: 119, val: 108, ibHigh: 113, ibLow: 108, rowSize: 1 } as Profile;
  assert.strictEqual(powerDegree(lowToday, prev, 112).degree, 1, 'within IB, above prev VA');
  assert.strictEqual(powerDegree(lowToday, prev, 115).degree, 2, 'above IB within VA');
  assert.strictEqual(powerDegree({ ...lowToday, vah: 116 } as Profile, prev, 118).degree, 3, 'above own VA');
  assert.strictEqual(powerDegree(today, prev, 126).degree, 5);
  assert.strictEqual(powerDegree(today, prev, 130).degree, 6);

  const bearToday = { vah: 98, val: 82, ibHigh: 95, ibLow: 85, rowSize: 1 } as Profile;
  assert.deepStrictEqual(
    [92, 88 - 4, 80].map((p) => [powerDegree(bearToday, prev, p).side, powerDegree(bearToday, prev, p).degree]),
    [['bearish', 1], ['bearish', 5], ['bearish', 6]],
  );
});

test('powerDegree: a price inside the top value-area row is still inside value', () => {
  // Row size 5: the VAH row 24100 covers 24100-24105, so a 24102 close is balanced, not bullish.
  const prev = { vah: 24100, val: 24000, high: 24150, low: 23950, rowSize: 5 } as Profile;
  assert.strictEqual(powerDegree({ vah: 24100, val: 24050, ibHigh: 24110, ibLow: 24060, rowSize: 5 } as Profile, prev, 24102).side, 'balanced');
  assert.strictEqual(powerDegree({ vah: 24100, val: 24050, ibHigh: 24110, ibLow: 24060, rowSize: 5 } as Profile, prev, 24106).side, 'bullish');
  // …and the same row edge decides "above its own value area" (+2): 24104 sits in today's VAH row.
  const today = { vah: 24100, val: 24060, ibHigh: 24090, ibLow: 24070, rowSize: 5 } as Profile;
  const p2 = { ...prev, vah: 24050, high: 24080 } as Profile;
  assert.strictEqual(powerDegree(today, p2, 24104).degree, 5, 'above IB within VA, above prev range');
  assert.strictEqual(powerDegree(today, p2, 24106).degree, 6);
});

test('rowFloor matches row prices exactly for fractional row sizes', () => {
  const [p] = buildDayProfiles([{ t: '2026-11-13 09:15:00', o: 100.6, h: 100.7, l: 100.6, c: 100.65, v: 0 }], { rowSize: 0.05 });
  assert.ok(p.rows.some((r) => r.price === rowFloor(100.65, 0.05)));
  assert.strictEqual(rowFloor(100.65, 0.05), 100.65);
});

test('minRowSize keeps a profile under MAX_ROWS_PER_PROFILE rows', () => {
  assert.strictEqual(minRowSize(1500), 5);
  assert.ok(1500 / minRowSize(1500) <= MAX_ROWS_PER_PROFILE);
  assert.strictEqual(minRowSize(0), 0);
});

test('tpoSkew leans toward the thin side', () => {
  assert.strictEqual(tpoSkew({ tpoAbove: 5, tpoBelow: 20 } as Profile), 'bullish');
  assert.strictEqual(tpoSkew({ tpoAbove: 20, tpoBelow: 5 } as Profile), 'bearish');
  assert.strictEqual(tpoSkew({ tpoAbove: 10, tpoBelow: 11 } as Profile), 'balanced');
});

test('nakedPocs stays naked until a later range trades through it', () => {
  const bars = [
    ...periodBars('2026-11-11', [[100, 110], [104, 106], [104, 106]]), // POC 104..106 area
    ...periodBars('2026-11-12', [[126, 136], [126, 136]]),
    ...periodBars('2026-11-13', [[103, 125], [115, 125]]),
  ];
  const ps = buildDayProfiles(bars, { rowSize: 1 });
  const n = nakedPocs(ps);
  assert.strictEqual(n[0].touchedBy, '2026-11-13');
  assert.strictEqual(n[1].touchedBy, null);
  assert.strictEqual(n[2].touchedBy, null);
});

test('weekly composite letters each TPO by its day and recomputes the POC', () => {
  const bars = [
    ...periodBars('2026-11-09', [[100, 102], [100, 102]]),
    ...periodBars('2026-11-10', [[101, 103]]),
    ...periodBars('2026-11-16', [[200, 201]]), // next ISO week
  ];
  const ws = buildCompositeProfiles(bars, 'week', { rowSize: 1 });
  assert.deepStrictEqual(ws.map((w) => w.key), ['2026-W46', '2026-W47']);
  const w = ws[0];
  assert.deepStrictEqual(w.days, ['2026-11-09', '2026-11-10']);
  assert.deepStrictEqual(rowsOf(w), ['100:AA', '101:AAB', '102:AAB', '103:B']);
  assert.strictEqual(w.ibHigh, null);
  assert.strictEqual(w.open, 100);
  assert.strictEqual(w.close, 103);
  const ms = buildCompositeProfiles(bars, 'month', { rowSize: 1 });
  assert.deepStrictEqual(ms.map((m) => [m.key, m.days.length]), [['2026-11', 3]]);
});

test('empty input and a zero row size return nothing', () => {
  assert.deepStrictEqual(buildDayProfiles([], { rowSize: 1 }), []);
  assert.deepStrictEqual(buildDayProfiles(periodBars('2026-11-13', [[1, 2]]), { rowSize: 0 }), []);
  const [one] = buildDayProfiles(periodBars('2026-11-13', [[5, 5]]), { rowSize: 1 });
  assert.strictEqual(one.poc, 5);
  assert.strictEqual(one.vah, 5);
  assert.strictEqual(one.val, 5);
  assert.strictEqual(one.sellingTail, null);
});
