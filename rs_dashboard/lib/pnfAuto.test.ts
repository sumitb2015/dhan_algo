import test from 'node:test';
import assert from 'node:assert/strict';
import { withSide } from './pnfAutoRule.ts';
import { decideAuto, reversalColumn, autoWindow, boxPriceAt, rowMarket, type AutoModel } from './pnfAuto.ts';
import type { PnfColumn, PnfSignal } from './straddlePnf.ts';

// 2026-10-30 (a Friday, an NSE trading day) at IST hh:mm, as epoch seconds.
const ist = (hh: number, mm: number) => Date.UTC(2026, 9, 30, hh, mm) / 1000 - 5.5 * 3600;
const col = (dir: 'X' | 'O'): PnfColumn => ({ dir, low: 0, high: 1, boxes: 3, startBar: 0, endBar: 0, session: '2026-10-30', breakBar: null, boxBars: [] });
const sig = (kind: PnfSignal['kind'], t: number): PnfSignal => ({ id: `${kind}:${t}`, kind, col: 0, bar: 0, t, price: 100, belowVwap: false });

/** Columns X, O, X starting at 10:00, 10:10, 10:20; a double-bottom SELL on the 10:30 bar (a 4th, O column). */
function model(extra: Partial<AutoModel> = {}): AutoModel {
  return {
    box: 1,
    columns: [col('X'), col('O'), col('X'), col('O')],
    columnTimes: [{ start: ist(10, 0), end: ist(10, 9) }, { start: ist(10, 10), end: ist(10, 19) }, { start: ist(10, 20), end: ist(10, 29) }, { start: ist(10, 30), end: ist(10, 30) }],
    signals: [sig('DOUBLE_TOP_BUY', ist(10, 22)), sig('DOUBLE_BOTTOM_SELL', ist(10, 30))],
    lastBarT: ist(10, 30),
    ...extra,
  };
}

test('a fresh double-bottom SELL on the last closed bar enters SELL; a double-top BUY enters BUY', () => {
  const d = decideAuto({ model: model(), position: null, watermarkT: ist(10, 25), nowS: ist(10, 31) + 5, market: 'NSE' });
  assert.equal(d.action, 'enter');
  assert.equal(d.action === 'enter' && d.side, 'SELL');
  const buy = model({ signals: [sig('DOUBLE_TOP_BUY', ist(10, 30))] });
  const b = decideAuto({ model: buy, position: null, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' });
  assert.equal(b.action === 'enter' && b.side, 'BUY');
});

test('never chases: a signal at or before the watermark, not on the last closed bar, or too old is not entered', () => {
  assert.equal(decideAuto({ model: model(), position: null, watermarkT: ist(10, 30), nowS: ist(10, 31), market: 'NSE' }).action, 'none');
  const later = model({ lastBarT: ist(10, 33) });                               // the signal bar is no longer the newest
  assert.equal(decideAuto({ model: later, position: null, watermarkT: 0, nowS: ist(10, 34), market: 'NSE' }).action, 'none');
  assert.equal(decideAuto({ model: model(), position: null, watermarkT: 0, nowS: ist(10, 40), market: 'NSE' }).action, 'none');
});

test('no entry while a position is open, before the open, or after the entry cutoff (no separate cutoff: the 15:30 session end)', () => {
  const held = decideAuto({ model: model(), position: { side: 'BUY', entryBarT: ist(10, 30) }, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' });
  assert.notEqual(held.action, 'enter');
  const late = model({ lastBarT: ist(15, 30), signals: [sig('DOUBLE_BOTTOM_SELL', ist(15, 30))] });
  assert.equal(decideAuto({ model: late, position: null, watermarkT: 0, nowS: ist(15, 31), market: 'NSE' }).action, 'none');
  const at1510 = model({ lastBarT: ist(15, 10), signals: [sig('DOUBLE_BOTTOM_SELL', ist(15, 10))] });
  assert.equal(decideAuto({ model: at1510, position: null, watermarkT: 0, nowS: ist(15, 11), market: 'NSE' }).action, 'enter', 'entries run until the session end');
  const justBefore = model({ lastBarT: ist(15, 3), signals: [sig('DOUBLE_BOTTOM_SELL', ist(15, 3))] });
  assert.equal(decideAuto({ model: justBefore, position: null, watermarkT: 0, nowS: ist(15, 4), market: 'NSE' }).action, 'enter', 'still allowed well before the exit');
  const early = model({ lastBarT: ist(9, 10), signals: [sig('DOUBLE_BOTTOM_SELL', ist(9, 10))] });
  assert.equal(decideAuto({ model: early, position: null, watermarkT: 0, nowS: ist(9, 11), market: 'NSE' }).action, 'none');
});

test('a short exits on the first X column after its entry bar; a long on the first O column', () => {
  const m = model({ columns: [...model().columns, col('X')], columnTimes: [...model().columnTimes, { start: ist(10, 40), end: ist(10, 41) }] });
  const short = { side: 'SELL' as const, entryBarT: ist(10, 30) };
  assert.equal(reversalColumn(m, short), 4);
  const d = decideAuto({ model: m, position: short, watermarkT: 0, nowS: ist(10, 42), market: 'NSE' });
  assert.equal(d.action === 'exit' && d.reason, 'reversal');
  assert.equal(d.action === 'exit' && d.col, 4);
  // the columns before the entry never count: holding until a new opposite column forms
  assert.equal(decideAuto({ model: model(), position: short, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' }).action, 'none');
  const long = { side: 'BUY' as const, entryBarT: ist(10, 22) };
  assert.equal(reversalColumn(model(), long), 3, 'the O column started at 10:30 reverses a long from 10:22');
});

test('end of day: flat at the 15:30 session end on NSE (no 15:15 square-off since 2026-11-08) (even with no reversal), and the MCX window follows that day\'s close', () => {
  const short = { side: 'SELL' as const, entryBarT: ist(10, 30) };
  assert.deepEqual(decideAuto({ model: model(), position: short, watermarkT: 0, nowS: ist(15, 30), market: 'NSE' }), { action: 'exit', reason: 'eod' });
  const mcx = autoWindow('MCX', ist(12, 0));
  assert.ok(mcx && mcx.eodExit >= mcx.entryCutoff && mcx.entryCutoff > mcx.open);
});

test('an NSE weekend: no entries, but an open position still exits on a reversal', () => {
  const sat = Date.UTC(2026, 9, 31, 5, 0) / 1000;                              // Saturday 10:30 IST
  const m = model({ lastBarT: sat - 60, signals: [sig('DOUBLE_BOTTOM_SELL', sat - 60)] });
  assert.equal(decideAuto({ model: m, position: null, watermarkT: 0, nowS: sat, market: 'NSE' }).action, 'none');
  assert.equal(autoWindow('NSE', sat), null);
});

test('boxPriceAt: the confirmed box a column had reached by a bar - highest for X, lowest for O, never a box drawn later', () => {
  // An O column whose boxes (bottom to top, centred on 95..99) were drawn by bars 12, 12, 11, 10, 10 (top-down), box 1.
  const o: PnfColumn = { ...col('O'), low: 94.5, high: 99.5, boxBars: [12, 12, 11, 10, 10] };
  const x: PnfColumn = { ...col('X'), low: 99.5, high: 103.5, boxBars: [20, 20, 21, 22] };   // boxes 100..103
  const m = { box: 1, columns: [o, x] };
  assert.equal(boxPriceAt(m, 0, 10), 98, 'at bar 10 the O column had reached 98');
  assert.equal(boxPriceAt(m, 0, 11), 97);
  assert.equal(boxPriceAt(m, 0, 12), 95);
  assert.equal(boxPriceAt(m, 1, 20), 101, 'the X column reached 101 on its first bar');
  assert.equal(boxPriceAt(m, 1, 22), 103);
  assert.equal(boxPriceAt(m, 1, 5), null, 'nothing drawn yet');
});

test('the entry and the reversal exit carry their confirmed box price', () => {
  const o: PnfColumn = { ...col('O'), low: 94.5, high: 99.5, boxBars: [12, 12, 11, 10, 10] };
  const sigO = { ...sig('DOUBLE_BOTTOM_SELL', ist(10, 30)), col: 3, bar: 11 };
  const m = model({ columns: [col('X'), col('O'), col('X'), o], signals: [sigO] });
  const d = decideAuto({ model: m, position: null, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' });
  assert.equal(d.action === 'enter' && d.boxPrice, 97, 'booked at the box the signal bar reached, not the live price');
  const x: PnfColumn = { ...col('X'), low: 96.5, high: 99.5, boxBars: [13, 13, 13] };
  const m2 = model({ columns: [...m.columns, { ...x, startBar: 13 }], columnTimes: [...m.columnTimes, { start: ist(10, 40), end: ist(10, 40) }] });
  const e = decideAuto({ model: m2, position: { side: 'SELL', entryBarT: ist(10, 30) }, watermarkT: 0, nowS: ist(10, 41), market: 'NSE' });
  assert.equal(e.action === 'exit' && e.boxPrice, 99);
});

test('a CAS stock (NSE_CAS) runs to 15:15 (its continuous session) from 3 Aug 2026; 15:30 before that date', () => {
  const at = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
  assert.deepEqual(autoWindow('NSE_CAS', at('2026-10-30T10:00:00')), { open: 9 * 60 + 15, entryCutoff: 15 * 60 + 15, eodExit: 15 * 60 + 15 });
  assert.deepEqual(autoWindow('NSE_CAS', at('2026-07-31T10:00:00')), { open: 9 * 60 + 15, entryCutoff: 15 * 60 + 30, eodExit: 15 * 60 + 30 });
  assert.equal(autoWindow('NSE', at('2026-10-30T10:00:00'))!.eodExit, 15 * 60 + 30);   // a stock without derivatives: unchanged
  // MCX on a 23:55 close (from 2 Nov 2026): exit 23:45, entries stop 10 minutes before the CLOSE (23:45); a 23:30 close: 23:20 / 23:20
  assert.deepEqual(autoWindow('MCX', at('2026-11-03T12:00:00')), { open: 9 * 60, entryCutoff: 23 * 60 + 45, eodExit: 23 * 60 + 45 });
  assert.deepEqual(autoWindow('MCX', at('2026-10-30T12:00:00')), { open: 9 * 60, entryCutoff: 23 * 60 + 20, eodExit: 23 * 60 + 20 });
});

test('a two-back position exits on its stop only: not on an opposite brick, and an EOD still flattens it', () => {
  const m = model();                                              // has an O column after a 10:00 entry
  const long = { side: 'BUY' as const, entryBarT: ist(10, 0), stop: 90 };
  const hold = decideAuto({ model: m, position: long, watermarkT: 0, nowS: ist(10, 40), market: 'NSE', price: 95 });
  assert.equal(hold.action, 'none', 'an opposite brick does not exit a stop position');
  const hit = decideAuto({ model: m, position: long, watermarkT: 0, nowS: ist(10, 40), market: 'NSE', price: 90 });
  assert.deepEqual(hit, { action: 'exit', reason: 'stop', boxPrice: 90 });
  const noPx = decideAuto({ model: m, position: long, watermarkT: 0, nowS: ist(10, 40), market: 'NSE' });
  assert.equal(noPx.action, 'none', 'no price, no stop decision');
  const short = { side: 'SELL' as const, entryBarT: ist(10, 0), stop: 110 };
  assert.equal(decideAuto({ model: m, position: short, watermarkT: 0, nowS: ist(10, 40), market: 'NSE', price: 111 }).action, 'exit');
  assert.equal(decideAuto({ model: m, position: short, watermarkT: 0, nowS: ist(15, 31), market: 'NSE', price: 100 }).action, 'exit');
});

test('a stop gapped through books the price, not the stop (long and short)', () => {
  const m = model();
  const long = decideAuto({ model: m, position: { side: 'BUY', entryBarT: ist(10, 0), stop: 90 }, watermarkT: 0, nowS: ist(10, 40), market: 'NSE', price: 85 });
  assert.deepEqual(long, { action: 'exit', reason: 'stop', boxPrice: 85 });
  const short = decideAuto({ model: m, position: { side: 'SELL', entryBarT: ist(10, 0), stop: 110 }, watermarkT: 0, nowS: ist(10, 40), market: 'NSE', price: 118 });
  assert.deepEqual(short, { action: 'exit', reason: 'stop', boxPrice: 118 });
});

test('a row\'s end-of-day time comes from its own market, not the chart on screen: a CRUDEOILM long is not flattened at the NSE 15:15', () => {
  const crude = { symbol: 'CRUDEOILM' };
  assert.equal(rowMarket({ target: crude }), 'MCX', 'an older row without a saved market is read off its contract');
  assert.equal(rowMarket({ market: 'NSE_CAS', target: crude }), 'NSE_CAS', 'a saved market wins');
  assert.equal(rowMarket({ target: { symbol: 'NIFTY' } }), 'NSE');
  const long = { side: 'BUY' as const, entryBarT: ist(21, 40) };
  const at = ist(21, 47);                                              // 21:47 IST on a Friday: long past the NSE 15:15, hours before MCX's
  const empty = model();
  assert.deepEqual(decideAuto({ model: empty, position: long, watermarkT: 0, nowS: at, market: 'NSE' }), { action: 'exit', reason: 'eod' }, 'the wrong (NSE) market would have flattened it');
  assert.equal(decideAuto({ model: empty, position: long, watermarkT: 0, nowS: at, market: rowMarket({ target: crude }) }).action, 'none');
});

test('Supertrend rule: a position exits when the line turns against it, not on an opposite-colour brick, whatever rule the page shows', () => {
  // columns X, O, X, O at 10:00 / 10:10 / 10:20 / 10:30; the line is up until the 10:30 brick
  const base = model();
  const up = model({ supertrend: [{ dir: 1 }, { dir: 1 }, { dir: 1 }, { dir: -1 }] });
  const plain = { side: 'BUY' as const, entryBarT: ist(10, 0) };
  const byLine = { ...plain, exitBy: 'supertrend' as const };
  assert.equal(reversalColumn(up, plain), 1, 'a row without exitBy still exits on the first O brick (the supertrend data is ignored)');
  assert.equal(reversalColumn(up, byLine), 3, 'a Supertrend row exits only on the flip brick');
  const short = { side: 'SELL' as const, exitBy: 'supertrend' as const, entryBarT: ist(10, 30) };
  const longer = model({ supertrend: [{ dir: -1 }, { dir: -1 }, { dir: -1 }, { dir: -1 }, { dir: 1 }], columns: [...base.columns, col('X')], columnTimes: [...base.columnTimes, { start: ist(10, 40), end: ist(10, 41) }] });
  assert.equal(reversalColumn(longer, short), 4);
  // a column whose direction is not readable yet never exits; no supertrend data at all never exits either
  assert.equal(reversalColumn(model({ supertrend: [{ dir: null }, { dir: null }, { dir: null }, { dir: null }] }), byLine), -1);
  assert.equal(reversalColumn(base, byLine), -1);
  const d = decideAuto({ model: up, position: byLine, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' });
  assert.equal(d.action === 'exit' && d.col, 3);
});

test('side filter: a buy-only chart never enters the sell signal on the last bar, a sell-only chart does; exits ignore the filter', () => {
  const m = model();                                                       // a double-bottom SELL on the last (10:30) bar
  const entry = (side: 'both' | 'buy' | 'sell') => decideAuto({ model: withSide(m, side), position: null, watermarkT: ist(10, 25), nowS: ist(10, 31), market: 'NSE' });
  assert.equal(entry('both').action, 'enter');
  assert.equal(entry('sell').action, 'enter');
  const buyOnly = entry('buy');
  assert.equal(buyOnly.action, 'none');
  // an open SELL position under a buy-only filter still exits on its reversal
  const m2 = model({ columns: [...m.columns, col('X')], columnTimes: [...m.columnTimes, { start: ist(10, 40), end: ist(10, 41) }] });
  const d = decideAuto({ model: withSide(m2, 'buy'), position: { side: 'SELL', entryBarT: ist(10, 30) }, watermarkT: 0, nowS: ist(10, 42), market: 'NSE' });
  assert.equal(d.action === 'exit' && d.reason, 'reversal');
});

// ── pyramid (decideAdd) ──
import { decideAdd, pyramidEveryOf, PYRAMID_EVERY_MAX, reentryBlockOf, stopBrickColumn, trailBest, trailLevel, trailOf } from './pnfAuto.ts';

/** A Renko short entered on the 10:00 brick (close 100); bricks of box 1 after it: [time, dir, close]. */
function renkoModel(bricks: [number, 'X' | 'O', number][], lastBarT: number): AutoModel {
  const cols: PnfColumn[] = [{ ...col('O'), low: 100, high: 101 }];
  const times = [{ start: ist(10, 0), end: ist(10, 0) }];
  for (const [t, dir, close] of bricks) {
    cols.push({ ...col(dir), low: dir === 'O' ? close : close - 1, high: dir === 'O' ? close + 1 : close });
    times.push({ start: t, end: t });
  }
  return { chart: 'renko', box: 1, columns: cols, columnTimes: times, signals: [], lastBarT };
}
const shortRow = (over: Record<string, unknown> = {}) => ({ side: 'SELL' as const, entryBarT: ist(10, 0), entryPrice: 100, entryBox: 100, lots: 2, ...over });

test('pyramid: a short adds on a new lower brick on the newest bar; a long on a new higher one', () => {
  const m = renkoModel([[ist(10, 5), 'O', 99]], ist(10, 5));
  const d = decideAdd({ model: m, row: shortRow(), nowS: ist(10, 6), market: 'NSE', maxLots: 10 });
  assert.deepEqual(d, { add: true, barT: ist(10, 5), box: 99 });
  const up = renkoModel([[ist(10, 5), 'X', 102]], ist(10, 5));
  const b = decideAdd({ model: up, row: shortRow({ side: 'BUY', entryBox: 101, entryPrice: 101 }), nowS: ist(10, 6), market: 'NSE', maxLots: 10 });
  assert.equal(b.add, true);
});

test('pyramid: a pullback that only re-covers ground never adds; a brick beyond the best does', () => {
  // down to 97, pullback up to 99, then down to 98 on the newest bar: 98 is not beyond 97
  const bricks: [number, 'X' | 'O', number][] = [[ist(10, 1), 'O', 99], [ist(10, 2), 'O', 98], [ist(10, 3), 'O', 97], [ist(10, 4), 'X', 99], [ist(10, 6), 'O', 98]];
  assert.equal(decideAdd({ model: renkoModel(bricks, ist(10, 6)), row: shortRow(), nowS: ist(10, 7), market: 'NSE', maxLots: 10 }).add, false);
  const more: [number, 'X' | 'O', number][] = [...bricks, [ist(10, 7), 'O', 97], [ist(10, 8), 'O', 96]];
  const d = decideAdd({ model: renkoModel(more, ist(10, 8)), row: shortRow(), nowS: ist(10, 9), market: 'NSE', maxLots: 10 });
  assert.deepEqual(d, { add: true, barT: ist(10, 8), box: 96 });
});

test('pyramid: one add per bar however many bricks it printed; never on an older bar; never past the cap or the cutoff', () => {
  const two = renkoModel([[ist(10, 5), 'O', 99], [ist(10, 5), 'O', 98]], ist(10, 5));
  const d = decideAdd({ model: two, row: shortRow(), nowS: ist(10, 6), market: 'NSE', maxLots: 10 });
  assert.deepEqual(d, { add: true, barT: ist(10, 5), box: 98 });
  assert.equal(decideAdd({ model: two, row: shortRow({ adds: [{ barT: ist(10, 5) }] }), nowS: ist(10, 6), market: 'NSE', maxLots: 10 }).add, false);
  // the brick printed on 10:05 but the newest closed bar is 10:07 (the tab slept): not chased
  const old = renkoModel([[ist(10, 5), 'O', 99]], ist(10, 7));
  assert.equal(decideAdd({ model: old, row: shortRow(), nowS: ist(10, 8), market: 'NSE', maxLots: 10 }).add, false);
  assert.equal(decideAdd({ model: renkoModel([[ist(10, 5), 'O', 99]], ist(10, 5)), row: shortRow({ lots: 3 }), nowS: ist(10, 6), market: 'NSE', maxLots: 3 }).add, false);
  assert.equal(decideAdd({ model: renkoModel([[ist(10, 5), 'O', 99]], ist(10, 5)), row: shortRow(), nowS: ist(10, 15), market: 'NSE', maxLots: 10 }).add, false, 'stale');
  const late = renkoModel([[ist(15, 30), 'O', 99]], ist(15, 30));
  assert.equal(decideAdd({ model: late, row: shortRow(), nowS: ist(15, 31), market: 'NSE', maxLots: 10 }).add, false, 'at the 15:30 session end');
  // a P&F chart never adds
  assert.equal(decideAdd({ model: { ...renkoModel([[ist(10, 5), 'O', 99]], ist(10, 5)), chart: 'pnf' }, row: shortRow(), nowS: ist(10, 6), market: 'NSE', maxLots: 10 }).add, false);
});

test('pyramid: without an entry brick the starting level is the FIRST tranche price, not the average entry', () => {
  // a short opened at 100 (no box), bricks since entry down to 97: a 98 brick on the newest bar is no new best
  const m = renkoModel([[ist(10, 1), 'O', 97], [ist(10, 2), 'X', 99], [ist(10, 4), 'O', 98]], ist(10, 4));
  const row = { side: 'SELL' as const, entryBarT: ist(10, 0), entryPrice: 99, lots: 2, base: { price: 100 }, adds: [{ barT: ist(10, 1) }] };
  assert.equal(decideAdd({ model: m, row, nowS: ist(10, 5), market: 'NSE', maxLots: 10 }).add, false);
  // with no bricks before the newest bar, a 99.5 brick beats the base 100 but not the 99 average: it adds (base is the reference)
  const first = renkoModel([[ist(10, 4), 'O', 99.5]], ist(10, 4));
  assert.equal(decideAdd({ model: first, row: { ...row, adds: [] }, nowS: ist(10, 5), market: 'NSE', maxLots: 10 }).add, true);
});

test('pyramid every N bricks: the first add waits N bricks past the entry brick, the next N bricks past the last add', () => {
  // a short entered on the 100 brick, every 2 bricks
  const one = renkoModel([[ist(10, 5), 'O', 99]], ist(10, 5));
  assert.deepEqual(decideAdd({ model: one, row: shortRow({ pyramidEvery: 2 }), nowS: ist(10, 6), market: 'NSE', maxLots: 10 }),
    { add: false, why: 'waiting for 2 bricks past the last add' });
  const two = renkoModel([[ist(10, 5), 'O', 99], [ist(10, 6), 'O', 98]], ist(10, 6));
  assert.deepEqual(decideAdd({ model: two, row: shortRow({ pyramidEvery: 2 }), nowS: ist(10, 7), market: 'NSE', maxLots: 10 }), { add: true, barT: ist(10, 6), box: 98 });
  // added at 98: 97 is one brick past it (no add), 96 is two (adds)
  const added = shortRow({ pyramidEvery: 2, adds: [{ barT: ist(10, 6), box: 98 }] });
  const three = renkoModel([[ist(10, 5), 'O', 99], [ist(10, 6), 'O', 98], [ist(10, 7), 'O', 97]], ist(10, 7));
  assert.equal(decideAdd({ model: three, row: added, nowS: ist(10, 8), market: 'NSE', maxLots: 10 }).add, false);
  const four = renkoModel([[ist(10, 5), 'O', 99], [ist(10, 6), 'O', 98], [ist(10, 7), 'O', 97], [ist(10, 8), 'O', 96]], ist(10, 8));
  assert.deepEqual(decideAdd({ model: four, row: added, nowS: ist(10, 9), market: 'NSE', maxLots: 10 }), { add: true, barT: ist(10, 8), box: 96 });
  // one bar printing both bricks counts: a long, every 3, one bar jumps 3 bricks past the entry
  const jump = renkoModel([[ist(10, 5), 'X', 102], [ist(10, 5), 'X', 103], [ist(10, 5), 'X', 104]], ist(10, 5));
  assert.equal(decideAdd({ model: jump, row: shortRow({ side: 'BUY', entryBox: 101, entryPrice: 101, pyramidEvery: 3 }), nowS: ist(10, 6), market: 'NSE', maxLots: 10 }).add, true);
  // N = 1 (or absent / invalid) is the every-new-best-brick rule
  assert.equal(decideAdd({ model: one, row: shortRow({ pyramidEvery: 1 }), nowS: ist(10, 6), market: 'NSE', maxLots: 10 }).add, true);
  assert.equal(pyramidEveryOf(0), 1); assert.equal(pyramidEveryOf(2.5), 1); assert.equal(pyramidEveryOf(3), 3); assert.equal(pyramidEveryOf(PYRAMID_EVERY_MAX + 1), 1);
});

test('pyramid trailing SL: none before an add; after one, a closed brick N boxes back from the best exits (before the Supertrend rule)', () => {
  // a short entered on the 100 brick: down to 97 (added on the 10:02 brick at 98), then back up
  const base: [number, 'X' | 'O', number][] = [[ist(10, 1), 'O', 99], [ist(10, 2), 'O', 98], [ist(10, 3), 'O', 97]];
  const pos = (row: Record<string, unknown>) => ({ side: 'SELL' as const, entryBarT: ist(10, 0), exitBy: 'supertrend' as const, trail: trailOf({ entryPrice: 100, entryBox: 100, ...row }) });
  const added = { trailBoxes: 2, adds: [{ barT: ist(10, 2) }] };
  const dec = (bricks: [number, 'X' | 'O', number][], row: Record<string, unknown>) =>
    decideAuto({ model: renkoModel(bricks, bricks[bricks.length - 1][0]), position: pos(row), watermarkT: 0, nowS: ist(10, 9), market: 'NSE' });
  // 1 box back (98) holds; 2 boxes back (99) exits at that brick's close
  assert.equal(dec([...base, [ist(10, 4), 'X', 98]], added).action, 'none');
  const two = [...base, [ist(10, 4), 'X', 98], [ist(10, 5), 'X', 99]] as [number, 'X' | 'O', number][];
  assert.deepEqual(dec(two, added), { action: 'exit', reason: 'trail', col: 5, boxPrice: 99 });
  assert.equal(trailLevel(renkoModel(base, ist(10, 3)), pos(added)), 99);
  // no add yet, or the trail switched off: the Supertrend rule (no direction data here) holds
  assert.equal(dec(two, { trailBoxes: 2 }).action, 'none');
  assert.equal(dec(two, { adds: [{ barT: ist(10, 2) }] }).action, 'none');
  // N = 3 needs 3 boxes back
  assert.equal(dec(two, { ...added, trailBoxes: 3 }).action, 'none');
  assert.equal(dec([...two, [ist(10, 6), 'X', 100]], { ...added, trailBoxes: 3 }).action, 'exit');
  // a pullback brick on (or before) the add's bar does not count
  const early: [number, 'X' | 'O', number][] = [[ist(10, 1), 'O', 98], [ist(10, 1), 'X', 100], [ist(10, 2), 'O', 97]];
  assert.equal(dec(early, { trailBoxes: 2, adds: [{ barT: ist(10, 2) }] }).action, 'none');
  // EOD still comes first; a P&F model never trails
  assert.deepEqual(decideAuto({ model: renkoModel(two, ist(10, 5)), position: pos(added), watermarkT: 0, nowS: ist(15, 31), market: 'NSE' }), { action: 'exit', reason: 'eod' });
  assert.equal(decideAuto({ model: { ...renkoModel(two, ist(10, 5)), chart: 'pnf' }, position: pos(added), watermarkT: 0, nowS: ist(10, 9), market: 'NSE' }).action, 'none');
  // a long: entry 101, best 104 after an add, a brick closing at 102 is 2 back
  const up: [number, 'X' | 'O', number][] = [[ist(10, 1), 'X', 102], [ist(10, 2), 'X', 103], [ist(10, 3), 'X', 104], [ist(10, 4), 'O', 102]];
  const d = decideAuto({ model: renkoModel(up, ist(10, 4)), position: { side: 'BUY', entryBarT: ist(10, 0), trail: trailOf({ entryPrice: 101, entryBox: 101, ...added }) }, watermarkT: 0, nowS: ist(10, 5), market: 'NSE' });
  assert.deepEqual(d, { action: 'exit', reason: 'trail', col: 4, boxPrice: 102 });
});

test('after a trailing-SL exit the same side waits for a brick beyond the trade best; the opposite side enters as usual', () => {
  // a long from the 101 brick: up to 104, trailed out on the 10:04 brick at 102; Supertrend still up, so every brick is a BUY signal
  const bricks: [number, 'X' | 'O', number][] = [[ist(10, 1), 'X', 102], [ist(10, 2), 'X', 103], [ist(10, 3), 'X', 104], [ist(10, 4), 'O', 102]];
  const row = { side: 'BUY' as const, state: 'closed', reason: 'trail', entryBarT: ist(10, 0), exitBarT: ist(10, 4), entryBox: 101, entryPrice: 101 };
  const block = reentryBlockOf(row, renkoModel(bricks, ist(10, 4)))!;
  assert.deepEqual(block, { side: 'BUY', beyond: 104, afterBarT: ist(10, 4) });
  const at = (b: [number, 'X' | 'O', number][], kind: PnfSignal['kind']) => {
    const last = b[b.length - 1][0];
    return decideAuto({ model: { ...renkoModel(b, last), signals: [sig(kind, last)] }, position: null, watermarkT: 0, nowS: last + 30, market: 'NSE', reentryBlock: block });
  };
  // the BUY signal on the exit brick itself (what re-bought 4 lots on 2026-11-05) and on a later 103 brick: held
  assert.equal(at(bricks, 'RENKO_BUY').action, 'none');
  const back103: [number, 'X' | 'O', number][] = [...bricks, [ist(10, 5), 'X', 103]];
  assert.match((at(back103, 'RENKO_BUY') as { why: string }).why, /waits for a brick beyond 104/);
  // a brick at 104 only equals the best: still held; 105 is beyond it: entered
  assert.equal(at([...back103, [ist(10, 6), 'X', 104]], 'RENKO_BUY').action, 'none');
  assert.equal(at([...back103, [ist(10, 6), 'X', 104], [ist(10, 7), 'X', 105]], 'RENKO_BUY').action, 'enter');
  // the opposite side is not held
  assert.equal(at(bricks, 'RENKO_SELL').action, 'enter');
  // only a trail exit leaves a block
  assert.equal(reentryBlockOf({ ...row, reason: 'reversal' }, renkoModel(bricks, ist(10, 4))), undefined);
  assert.equal(reentryBlockOf({ ...row, state: 'open' }, renkoModel(bricks, ist(10, 4))), undefined);
  // a short: best is the LOWEST brick close
  const down: [number, 'X' | 'O', number][] = [[ist(10, 1), 'O', 99], [ist(10, 2), 'O', 97], [ist(10, 3), 'X', 99]];
  assert.equal(reentryBlockOf({ ...row, side: 'SELL', entryBox: 100, entryPrice: 100, exitBarT: ist(10, 3) }, renkoModel(down, ist(10, 3)))!.beyond, 97);
});

test('re-entry wait (review fixes): an opposite signal since the exit ends it; the saved trail best wins over the chart', () => {
  const bricks: [number, 'X' | 'O', number][] = [[ist(10, 1), 'X', 102], [ist(10, 2), 'X', 103], [ist(10, 3), 'X', 104], [ist(10, 4), 'O', 102]];
  const row = { side: 'BUY' as const, state: 'closed', reason: 'trail', entryBarT: ist(10, 0), exitBarT: ist(10, 4), entryBox: 101, entryPrice: 101 };
  const m = renkoModel(bricks, ist(10, 6));
  // the Supertrend turned down after the exit (a SELL signal, even one the Buy only filter ignores): a new uptrend is not held
  assert.equal(reentryBlockOf(row, { ...m, signals: [sig('RENKO_SELL', ist(10, 5))] }), undefined);
  // a SELL signal on or before the exit bar, or a BUY after it, does not end the wait
  assert.ok(reentryBlockOf(row, { ...m, signals: [sig('RENKO_SELL', ist(10, 4)), sig('RENKO_BUY', ist(10, 5))] }));
  // the best saved at the exit is used as is (a box change since cannot move it)
  assert.equal(reentryBlockOf({ ...row, trailBest: 8488 }, m)!.beyond, 8488);
  // trailBest: the best favourable close since entry, null without an active trail
  const pos = { side: 'BUY' as const, entryBarT: ist(10, 0), trail: trailOf({ entryPrice: 101, entryBox: 101, trailBoxes: 2, adds: [{ barT: ist(10, 2) }] }) };
  assert.equal(trailBest(renkoModel(bricks, ist(10, 4)), pos), 104);
  assert.equal(trailBest(renkoModel(bricks, ist(10, 4)), { side: 'BUY', entryBarT: ist(10, 0) }), null);
});

test('NRML (MARGIN) squares off NSE at 15:35 (entries run to the exit), pulled inside an earlier close; MIS runs to the 15:30 session end; MCX is the same for both', () => {
  const at = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
  const t = at('2026-10-30T10:00:00');
  assert.deepEqual(autoWindow('NSE_FNO', t, 'MARGIN'), { open: 9 * 60 + 15, entryCutoff: 15 * 60 + 35, eodExit: 15 * 60 + 35 });
  assert.deepEqual(autoWindow('NSE_FNO', t, 'INTRADAY'), { open: 9 * 60 + 15, entryCutoff: 15 * 60 + 30, eodExit: 15 * 60 + 30 });
  assert.deepEqual(autoWindow('NSE_FNO', t), autoWindow('NSE_FNO', t, 'INTRADAY'), 'MIS is the default');
  assert.equal(autoWindow('NSE', t, 'MARGIN')!.eodExit, 15 * 60 + 25, 'a 15:30 close: 5 minutes before it, never after the bell');
  assert.equal(autoWindow('NSE_CAS', t, 'MARGIN')!.eodExit, 15 * 60 + 10, 'a CAS stock: inside its 15:15 continuous session');
  assert.deepEqual(autoWindow('MCX', at('2026-11-03T12:00:00'), 'MARGIN'), autoWindow('MCX', at('2026-11-03T12:00:00'), 'INTRADAY'));
});

test('decideAuto: an NRML position holds through 15:15 and exits at 15:35; an MIS one exits at 15:30; NRML entries run to 15:35', () => {
  const at = (hh: number, mm: number) => Date.parse(`2026-10-30T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`) / 1000;
  const pos = { side: 'SELL' as const, entryBarT: at(14, 0) };
  const m = model({ lastBarT: at(15, 29) });
  assert.equal(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: at(15, 30), market: 'NSE_FNO' }).action, 'exit');
  assert.equal(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: at(15, 30), market: 'NSE_FNO', product: 'MARGIN' }).action, 'none');
  assert.equal(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: at(15, 34), market: 'NSE_FNO', product: 'MARGIN' }).action, 'none');
  const e = decideAuto({ model: m, position: pos, watermarkT: 0, nowS: at(15, 35), market: 'NSE_FNO', product: 'MARGIN' });
  assert.equal(e.action === 'exit' && e.reason, 'eod');
  const s = sig('DOUBLE_TOP_BUY' as PnfSignal['kind'], at(15, 30));
  const sm = model({ signals: [s], lastBarT: at(15, 30) });
  assert.equal(decideAuto({ model: sm, position: null, watermarkT: 0, nowS: at(15, 30) + 5, market: 'NSE_FNO' }).action, 'none', 'MIS: past the 15:30 session end');
  assert.equal(decideAuto({ model: sm, position: null, watermarkT: 0, nowS: at(15, 30) + 5, market: 'NSE_FNO', product: 'MARGIN' }).action, 'enter');
  const late = model({ signals: [sig('DOUBLE_TOP_BUY' as PnfSignal['kind'], at(15, 35))], lastBarT: at(15, 35) });
  assert.equal(decideAuto({ model: late, position: null, watermarkT: 0, nowS: at(15, 35) + 5, market: 'NSE_FNO', product: 'MARGIN' }).action, 'none', 'NRML: past 15:35');
});

test('review fixes: a Renko stop with no usable price exits on a closed brick beyond it, booked no better than the stop', () => {
  // a long from 103 with its stop at 101: bricks fall to 102 then 100
  const bricks: [number, 'X' | 'O', number][] = [[ist(10, 1), 'X', 103], [ist(10, 2), 'O', 102], [ist(10, 3), 'O', 100]];
  const m = renkoModel(bricks, ist(10, 3));
  const pos = { side: 'BUY' as const, entryBarT: ist(10, 1), stop: 101 };
  assert.equal(stopBrickColumn(m, pos), 3);
  assert.deepEqual(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: ist(10, 4), market: 'NSE', price: null }), { action: 'exit', reason: 'stop', col: 3, boxPrice: 100 });
  // a live price above the stop wins over the bricks; no brick past the stop yet: holding
  assert.equal(decideAuto({ model: m, position: pos, watermarkT: 0, nowS: ist(10, 4), market: 'NSE', price: 101.5 }).action, 'none');
  assert.equal(decideAuto({ model: renkoModel(bricks.slice(0, 2), ist(10, 2)), position: pos, watermarkT: 0, nowS: ist(10, 3), market: 'NSE', price: null }).action, 'none');
  // a P&F model has no brick fallback
  assert.equal(stopBrickColumn({ ...m, chart: 'pnf' }, pos), -1);
});

test('review fixes: bricks printed on the entry bar after the signal brick count toward the trail best and the pyramid start', () => {
  // a long entered on the 102 brick of a 10:01 bar that went on to 104; best is 104, so a 102 brick later is 2 back
  const bricks: [number, 'X' | 'O', number][] = [[ist(10, 1), 'X', 102], [ist(10, 1), 'X', 103], [ist(10, 1), 'X', 104], [ist(10, 3), 'X', 105], [ist(10, 4), 'O', 103]];
  const m = renkoModel(bricks, ist(10, 4));
  const pos = { side: 'BUY' as const, entryBarT: ist(10, 1), trail: trailOf({ entryPrice: 102, entryBox: 102, trailBoxes: 2, adds: [{ barT: ist(10, 3) }] }) };
  assert.equal(trailBest(m, pos), 105);
  // no add on 10:03's 104 when the entry bar already reached 104; 105 is a new best
  const add = (b: typeof bricks, last: number) => decideAdd({ model: renkoModel(b, last), row: { side: 'BUY', entryBarT: ist(10, 1), entryPrice: 102, entryBox: 102, lots: 1 }, nowS: last + 30, market: 'NSE', maxLots: 5 });
  assert.equal(add([...bricks.slice(0, 3), [ist(10, 3), 'X', 104]], ist(10, 3)).add, false);
  assert.deepEqual(add(bricks.slice(0, 4), ist(10, 3)), { add: true, barT: ist(10, 3), box: 105 });
  // never an add on the entry bar itself
  assert.equal(add(bricks.slice(0, 3), ist(10, 1)).add, false);
});
