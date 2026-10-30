import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAuto, reversalColumn, autoWindow, boxPriceAt, type AutoModel } from './pnfAuto.ts';
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

test('no entry while a position is open, before the open, or after the 15:00 entry cutoff', () => {
  const held = decideAuto({ model: model(), position: { side: 'BUY', entryBarT: ist(10, 30) }, watermarkT: 0, nowS: ist(10, 31), market: 'NSE' });
  assert.notEqual(held.action, 'enter');
  const late = model({ lastBarT: ist(15, 0), signals: [sig('DOUBLE_BOTTOM_SELL', ist(15, 0))] });
  assert.equal(decideAuto({ model: late, position: null, watermarkT: 0, nowS: ist(15, 1), market: 'NSE' }).action, 'none');
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

test('end of day: flat at 15:15 on NSE (even with no reversal), and the MCX window follows that day\'s close', () => {
  const short = { side: 'SELL' as const, entryBarT: ist(10, 30) };
  assert.deepEqual(decideAuto({ model: model(), position: short, watermarkT: 0, nowS: ist(15, 15), market: 'NSE' }), { action: 'exit', reason: 'eod' });
  const mcx = autoWindow('MCX', ist(12, 0));
  assert.ok(mcx && mcx.eodExit > mcx.entryCutoff && mcx.entryCutoff > mcx.open);
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
