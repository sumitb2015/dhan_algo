import test from 'node:test';
import assert from 'node:assert/strict';
import { foldTick, newSignalsAfter, nextWatermark, capLog, inSession, feedCloseTrusted, mergeHistory, legsTick } from './straddlePnfLive.ts';
import { vwap, type Bar, type PnfSignal } from './straddlePnf.ts';

const T0 = Date.UTC(2026, 9, 23, 3, 45) / 1000; // 09:15 IST, a minute start
const bar = (i: number, ce: number, pe: number): Bar => ({ t: T0 + i * 60, ce, pe, straddle: ce + pe, vol: 7 });

test('a tick inside the open minute updates only the last bar', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const { bars: out, closedIndex } = foldTick(bars, { t: T0 + 60 + 30, ce: 103, pe: 49 });
  assert.equal(closedIndex, null);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], bars[0]);
  assert.equal(out[1].ce, 103);
  assert.equal(out[1].pe, 49);
  assert.equal(out[1].straddle, 152);
  assert.equal(out[1].t, T0 + 60);
  assert.equal(bars[1].ce, 101); // input not mutated
});

test('a tick in a new minute appends a bar and reports the bar that just closed', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const { bars: out, closedIndex } = foldTick(bars, { t: T0 + 2 * 60 + 5, ce: 102, pe: 52 });
  assert.equal(closedIndex, 1);
  assert.equal(out.length, 3);
  assert.equal(out[2].t, T0 + 2 * 60);
  assert.equal(out[2].straddle, 154);
});

test('ticks with a zero leg are ignored', () => {
  const bars = [bar(0, 100, 50)];
  for (const tick of [{ t: T0 + 70, ce: 0, pe: 50 }, { t: T0 + 70, ce: 100, pe: 0 }, { t: T0 + 70, ce: NaN, pe: 50 }]) {
    const r = foldTick(bars, tick);
    assert.equal(r.closedIndex, null);
    assert.deepEqual(r.bars, bars);
  }
});

test('an out-of-order tick from an earlier minute is ignored', () => {
  const bars = [bar(0, 100, 50), bar(1, 101, 51)];
  const r = foldTick(bars, { t: T0 + 10, ce: 99, pe: 49 });
  assert.equal(r.closedIndex, null);
  assert.deepEqual(r.bars, bars);
});

test('the first tick on an empty chart starts a bar without closing one', () => {
  const r = foldTick([], { t: T0 + 12, ce: 100, pe: 50 });
  assert.equal(r.closedIndex, null);
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].t, T0);
});

const sig = (id: string, t: number): PnfSignal => ({ id, kind: 'DOUBLE_BOTTOM_SELL', col: 3, bar: 7, t, price: 100, belowVwap: true });

test('newSignalsAfter keeps only signals on bars newer than the watermark (history and old bars never alert)', () => {
  const history = sig('DOUBLE_BOTTOM_SELL:1', T0 + 100);
  const onWatermark = sig('DOUBLE_TOP_BUY:2', T0 + 9000);
  const fresh = sig('DOUBLE_BOTTOM_SELL:3', T0 + 9060);
  assert.deepEqual(newSignalsAfter([history, onWatermark, fresh], T0 + 9000).map(s => s.id), ['DOUBLE_BOTTOM_SELL:3']);
});

test('a signal that comes back with a different column number is not re-alerted once the watermark has advanced', () => {
  const first = sig('DOUBLE_BOTTOM_SELL:3', T0 + 500);
  let wm = T0 + 400;
  assert.equal(newSignalsAfter([first], wm).length, 1);
  wm = nextWatermark(wm, T0 + 500);                       // the evaluation consumed that bar
  const renumbered = { ...first, id: 'DOUBLE_BOTTOM_SELL:5', col: 5 }; // e.g. the 3-session window dropped a day
  assert.equal(newSignalsAfter([renumbered], wm).length, 0);
});

test('nextWatermark only moves forward and ignores an empty chart', () => {
  assert.equal(nextWatermark(100, 160), 160);
  assert.equal(nextWatermark(160, 100), 160);
  assert.equal(nextWatermark(160, null), 160);
});

test('capLog keeps the newest 30, newest first', () => {
  let log: number[] = [];
  for (let i = 0; i < 35; i++) log = capLog(log, i);
  assert.equal(log.length, 30);
  assert.equal(log[0], 34);
  assert.equal(log[29], 5);
});

// Live bars must carry volume or VWAP stops moving once the feed starts: the bridge sends cumulative day volume (CE + PE),
// and a minute's volume is the growth in that figure inside the minute.
test('live minutes get volume from the growth of cumulative volume', () => {
  let bars: Bar[] = [bar(0, 100, 50)];
  const feed = (t: number, cumVol: number) => { bars = foldTick(bars, { t, ce: 100, pe: 50, cumVol }).bars; };
  feed(T0 + 60 + 1, 1000);                       // first tick: no baseline yet, nothing to attribute
  assert.equal(bars[1].vol, 0);
  feed(T0 + 60 + 40, 1600);                      // +600 inside the minute
  assert.equal(bars[1].vol, 600);
  feed(T0 + 120 + 2, 2100);                      // new minute: +500 since the last tick belongs to the new bar
  assert.equal(bars[2].vol, 500);
  feed(T0 + 120 + 50, 2300);
  assert.equal(bars[2].vol, 700);
  assert.equal(bars[1].vol, 600);                // a closed bar keeps its volume
});

test('a history bar that is still forming keeps its volume and gains the live growth on top', () => {
  let bars: Bar[] = [{ ...bar(0, 100, 50), vol: 400 }];
  bars = foldTick(bars, { t: T0 + 10, ce: 100, pe: 50, cumVol: 5000 }).bars;
  assert.equal(bars[0].vol, 400);
  bars = foldTick(bars, { t: T0 + 30, ce: 100, pe: 50, cumVol: 5250 }).bars;
  assert.equal(bars[0].vol, 650);
});

test('a cumulative volume that goes backwards (bridge restart) never makes a negative or lost volume', () => {
  let bars: Bar[] = [bar(0, 100, 50)];
  bars = foldTick(bars, { t: T0 + 61, ce: 100, pe: 50, cumVol: 9000 }).bars;
  bars = foldTick(bars, { t: T0 + 100, ce: 100, pe: 50, cumVol: 9300 }).bars;
  bars = foldTick(bars, { t: T0 + 125, ce: 100, pe: 50, cumVol: 40 }).bars;   // restart: counter reset
  assert.ok(bars[bars.length - 1].vol >= 0);
});

test('a tick without volume leaves the bar volume alone', () => {
  const r = foldTick([{ ...bar(0, 100, 50), vol: 77 }], { t: T0 + 20, ce: 101, pe: 50 });
  assert.equal(r.bars[0].vol, 77);
});

test('VWAP keeps moving with live bars once they carry volume', () => {
  const hist: Bar[] = [{ t: T0, ce: 50, pe: 50, straddle: 100, vol: 1000 }];
  let bars = hist;
  bars = foldTick(bars, { t: T0 + 61, ce: 60, pe: 60, cumVol: 10 }).bars;
  bars = foldTick(bars, { t: T0 + 100, ce: 60, pe: 60, cumVol: 3010 }).bars; // 3000 traded at 120
  const v = vwap(bars);
  assert.ok(Math.abs((v[1] as number) - (100 * 1000 + 120 * 3000) / 4000) < 1e-9);
});

test('a plain-price tick (pe 0) folds only in single mode, in the open minute and into a new one', () => {
  const bars = [bar(0, 100, 0)];
  assert.equal(foldTick(bars, { t: T0 + 10, ce: 101, pe: 0 }).bars, bars); // straddle mode needs both legs
  const same = foldTick(bars, { t: T0 + 10, ce: 101, pe: 0 }, true);
  assert.equal(same.bars[0].straddle, 101);
  assert.equal(same.closedIndex, null);
  const next = foldTick(same.bars, { t: T0 + 65, ce: 102, pe: 0 }, true);
  assert.equal(next.bars.length, 2);
  assert.equal(next.closedIndex, 0);
  assert.equal(next.bars[1].straddle, 102);
});

// ── trading session, feed previous close, history merge ─────────────────────
const IST = (h: number, m: number, day = 23) => Date.UTC(2026, 9, day, h, m) / 1000 - 5.5 * 3600; // Fri 23 Oct 2026, IST wall clock

test('inSession: the NSE pre-open and post-close are outside, 09:15 to 15:29 inside; MCX runs 09:00 to 23:54', () => {
  assert.equal(inSession(IST(9, 0), 'NSE'), false);
  assert.equal(inSession(IST(9, 7), 'NSE'), false);
  assert.equal(inSession(IST(9, 15), 'NSE'), true);
  assert.equal(inSession(IST(15, 29), 'NSE'), true);
  assert.equal(inSession(IST(15, 30), 'NSE'), false);
  assert.equal(inSession(IST(9, 0), 'MCX'), true);
  assert.equal(inSession(IST(23, 54), 'MCX'), true);
  assert.equal(inSession(IST(23, 55), 'MCX'), false);
});

test('feedCloseTrusted: before the bell on a trading weekday only (the close flips to today\'s at the bell)', () => {
  assert.equal(feedCloseTrusted(IST(8, 30), 'NSE', true), true);   // pre-market: close === ltp is genuine, not a flip
  assert.equal(feedCloseTrusted(IST(15, 29), 'NSE', true), true);
  assert.equal(feedCloseTrusted(IST(15, 30), 'NSE', true), false);
  assert.equal(feedCloseTrusted(IST(10, 0), 'NSE', false), false); // holiday: still the last session's flipped close
  assert.equal(feedCloseTrusted(IST(10, 0, 24), 'NSE', true), false); // Saturday
  assert.equal(feedCloseTrusted(IST(20, 0), 'MCX', true), true);
  assert.equal(feedCloseTrusted(IST(23, 55), 'MCX', true), false);
});

test('mergeHistory keeps live-built bars newer than the API\'s last bar, then folds the latest tick', () => {
  const p = (i: number, v: number): Bar => ({ t: T0 + i * 60, ce: v, pe: 0, straddle: v, vol: 1 });
  const hist = [p(0, 100), p(1, 101)];
  const onScreen = [p(0, 100), p(1, 101.5), p(2, 102), p(3, 103)];  // minutes 2 and 3 came from ticks; the API lags
  const out = mergeHistory(hist, onScreen, { t: T0 + 3 * 60 + 20, ce: 103.5, pe: 0 }, true);
  assert.deepEqual(out.map(b => b.straddle), [100, 101, 102, 103.5]); // API wins where it has the minute
  assert.deepEqual(mergeHistory([], onScreen, null), []);
  assert.deepEqual(mergeHistory(hist, [], null).map(b => b.straddle), [100, 101]);
});

test('legsTick: one leg is a plain price; a straddle needs both legs, at the later change, volume summed only when both have it', () => {
  assert.deepEqual(legsTick([{ ltp: 101, changedMs: 5000, volume: 7 }]), { t: 5, ce: 101, pe: 0, cumVol: 7 });
  assert.equal(legsTick([null]), null);
  assert.deepEqual(legsTick([{ ltp: 100, changedMs: 5000, volume: 10 }, { ltp: 80, changedMs: 7000, volume: 4 }]), { t: 7, ce: 100, pe: 80, cumVol: 14 });
  assert.deepEqual(legsTick([{ ltp: 100, changedMs: 5000, volume: 10 }, { ltp: 80, changedMs: 7000, volume: null }]), { t: 7, ce: 100, pe: 80, cumVol: undefined });
  assert.equal(legsTick([{ ltp: 100, changedMs: 5000, volume: 10 }, null]), null);   // half a straddle never prints
  assert.equal(legsTick([]), null);
});
