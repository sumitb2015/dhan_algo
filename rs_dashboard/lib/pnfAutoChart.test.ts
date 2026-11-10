import test from 'node:test';
import assert from 'node:assert/strict';
import { ChartEngine, MAX_REJECTS, type ChartDeps, type ChartInputs, type OrderReply } from './pnfAutoChart.ts';
import { applyAutoOp, EMPTY_LEDGER, type AutoLedger, type AutoOp } from './pnfAutoLedger.ts';
import type { PnfColumn, PnfSignal } from './straddlePnf.ts';
import type { PanelModel } from './straddlePnfModel.ts';
import type { Target } from './pnfTarget.ts';

// 2026-10-30 (a Friday, an NSE trading day) at IST hh:mm, as epoch seconds.
const ist = (hh: number, mm: number) => Date.UTC(2026, 9, 30, hh, mm) / 1000 - 5.5 * 3600;
const col = (dir: 'X' | 'O', high = 101): PnfColumn => ({ dir, low: high - 1, high, boxes: 1, startBar: 0, endBar: 0, session: '2026-10-30', breakBar: null, boxBars: [] });
const sig = (kind: PnfSignal['kind'], t: number): PnfSignal => ({ id: `${kind}:${t}`, kind, col: 3, bar: 0, t, price: 100, belowVwap: false });
const TARGET: Target = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' };

/** Columns X, O, X, O; a double-bottom SELL on the 10:30 bar (the 4th column). */
function model(extra: Partial<PanelModel> = {}): PanelModel {
  return {
    chart: 'pnf', box: 1,
    columns: [col('X'), col('O'), col('X'), col('O')],
    columnTimes: [{ start: ist(10, 0), end: ist(10, 9) }, { start: ist(10, 10), end: ist(10, 19) }, { start: ist(10, 20), end: ist(10, 29) }, { start: ist(10, 30), end: ist(10, 30) }],
    signals: [sig('DOUBLE_BOTTOM_SELL', ist(10, 30))],
    stSignals: [], trend: [], twoBack: [], oneBack: [], supertrend: [],
    lastBarT: ist(10, 30),
    ...extra,
  } as unknown as PanelModel;
}

/** An in-memory ledger behind the real ops, a scripted order route and a hand-moved clock. */
function rig(replies: (OrderReply | null)[] = [], extra: Partial<ChartDeps> = {}) {
  let ledger: AutoLedger = EMPTY_LEDGER;
  let nowMs = (ist(10, 31) + 5) * 1000;
  const ops: AutoOp[] = [], orders: Record<string, unknown>[] = [], events: string[] = [], disarms: string[] = [];
  const deps: ChartDeps = {
    post: async op => {
      ops.push(op);
      const r = applyAutoOp(ledger, op);
      if (!r.ok) return { ok: false, error: r.error };
      ledger = r.ledger;
      return { ok: true };
    },
    sendOrder: async body => { orders.push(body); return replies.length ? replies.shift()! : null; },
    readOrderPrice: async () => null,
    event: e => events.push(e.text),
    disarm: why => disarms.push(why),
    nowMs: () => nowMs,
    sleep: async () => {},
    ...extra,
  };
  const engine = new ChartEngine(1, deps);
  const inputs = (over: Partial<ChartInputs> = {}): ChartInputs => ({
    arm: { on: true, mode: 'REAL', watermarkT: ist(10, 25), armT: ist(10, 0) }, lots: 1, target: TARGET, model: model(), price: 100, stale: false,
    market: 'NSE_FNO', complete: true, broker: 'dhan', ledger, info: { legs: [{ label: 'NIFTY FUT', lot: 75, unitsPerLot: 75, key: 'k', lotUnits: 75 }], unsupported: null },
    ...over,
  });
  return { engine, inputs, ops, orders, events, disarms, ledger: () => ledger, advance: (s: number) => { nowMs += s * 1000; }, at: (sec: number) => { nowMs = sec * 1000; } };
}

const placed = (orderId = 'O1'): OrderReply => ({ success: true, outcome: 'placed', legs: [{ label: 'NIFTY FUT', side: 'SELL', qty: 75, product: 'INTRADAY', status: 'placed', orderId }] });

test('REAL entry: reserved as entering, sent once, then confirmed open with its order id', async () => {
  const r = rig([placed()]);
  await r.engine.tick(r.inputs());
  assert.deepEqual(r.ops.map(o => o.op), ['open', 'confirmEntry']);
  assert.equal((r.ops[0] as { row: { state?: string } }).row.state, 'entering');
  assert.equal(r.orders.length, 1);
  assert.equal(r.orders[0].action, 'SELL');
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'open');
  assert.deepEqual(row.entryOrderIds, ['O1']);
  // the same signal is never entered again
  await r.engine.tick(r.inputs({ ledger: r.ledger() }));
  assert.equal(r.orders.length, 1);
});

test('REAL entry with no clean reply: marked unknown, the chart halts and disarms, nothing is resent', async () => {
  const r = rig([null]);
  await r.engine.tick(r.inputs());
  assert.equal(r.ledger().rows[0].state, 'unknownEntry');
  assert.match(r.engine.halt ?? '', /unknown/);
  assert.equal(r.disarms.length, 1);
  r.advance(30);
  await r.engine.tick(r.inputs({ ledger: r.ledger() }));
  assert.equal(r.orders.length, 1, 'never resent');
});

test(`${MAX_REJECTS} refused entries in a row halt the chart`, async () => {
  const refused: OrderReply = { success: false, outcome: 'rejected', message: 'margin' };
  const r = rig([refused, refused, refused]);
  for (let k = 0; k < MAX_REJECTS; k++) {
    const t = ist(10, 30 + k);
    await r.engine.tick(r.inputs({ ledger: r.ledger(), model: model({ signals: [sig('DOUBLE_BOTTOM_SELL', t)], lastBarT: t }) }));
    r.advance(60);
  }
  assert.equal(r.orders.length, MAX_REJECTS);
  assert.match(r.engine.halt ?? '', /refused/);
});

test('PAPER entry books the signal box with no order sent to a broker, and a reversal closes it at that box', async () => {
  const r = rig([{ success: true, outcome: 'placed', legs: [] }]);
  const paper = { arm: { on: true, mode: 'PAPER' as const, watermarkT: ist(10, 25), armT: ist(10, 0) } };
  await r.engine.tick(r.inputs(paper));
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'open');
  assert.equal(row.mode, 'PAPER');
  assert.equal(r.orders[0].mode, 'PAPER');
  // an X column after the entry bar: the short exits on it
  const m = model({ columns: [...model().columns, col('X', 103)], columnTimes: [...model().columnTimes, { start: ist(10, 40), end: ist(10, 41) }], lastBarT: ist(10, 41) });
  r.advance(600);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: m }));
  const closed = r.ledger().rows[0];
  assert.equal(closed.state, 'closed');
  assert.equal(closed.reason, 'reversal');
});

test('a refused REAL exit is aborted and retried only after the retry delay', async () => {
  const exitRefused: OrderReply = { success: false, outcome: 'rejected', message: 'busy' };
  const r = rig([placed(), exitRefused, { success: true, outcome: 'placed', legs: [{ label: 'NIFTY FUT', side: 'BUY', qty: 75, product: 'INTRADAY', status: 'placed', orderId: 'X1' }] }]);
  await r.engine.tick(r.inputs());
  const m = model({ columns: [...model().columns, col('X', 103)], columnTimes: [...model().columnTimes, { start: ist(10, 40), end: ist(10, 41) }], lastBarT: ist(10, 41) });
  r.advance(600);
  await r.engine.tick(r.inputs({ ledger: r.ledger(), model: m }));
  assert.equal(r.ledger().rows[0].state, 'open', 'abortExit put it back');
  await r.engine.tick(r.inputs({ ledger: r.ledger(), model: m }));
  assert.equal(r.orders.length, 2, 'not resent inside the retry delay');
  r.advance(11);
  await r.engine.tick(r.inputs({ ledger: r.ledger(), model: m }));
  assert.equal(r.orders.length, 3);
  assert.equal(r.ledger().rows[0].state, 'closed');
});

test('a new arming clears a halt; a guard exit after the arming is seen, an older one is not', async () => {
  const r = rig([null]);
  await r.engine.tick(r.inputs());
  assert.ok(r.engine.halt);
  r.engine.sync({ on: true, mode: 'REAL', watermarkT: ist(10, 50), armT: ist(10, 0) });
  assert.ok(r.engine.halt, 'the same arming (a newer watermark) keeps the halt');
  r.engine.sync({ on: true, mode: 'REAL', watermarkT: ist(10, 50), armT: ist(10, 49) });
  assert.equal(r.engine.halt, null, 'a new arming clears it');
  const led: AutoLedger = { ...EMPTY_LEDGER, rows: [{ ...r.ledger().rows[0], state: 'closed', reason: 'server guard: MTM stop', exitT: ist(10, 45) }] };
  assert.equal(r.engine.guardExitedSinceArm(led, { on: true, mode: 'REAL', watermarkT: 0, armT: ist(10, 0) }), true);
  assert.equal(r.engine.guardExitedSinceArm(led, { on: true, mode: 'REAL', watermarkT: 0, armT: ist(11, 0) }), false);
});

test('the same arming with a newer watermark (a refused entry rebuilt after a restart) keeps counting refusals and never moves back', async () => {
  const refused: OrderReply = { success: false, outcome: 'rejected', message: 'margin' };
  const r = rig([refused, refused, refused]);
  for (let k = 0; k < MAX_REJECTS; k++) {
    const t = ist(10, 30 + k);
    // the engine rebuilds the arming's watermark from the ledger each tick: it rises with every refused entry's bar
    await r.engine.tick(r.inputs({ ledger: r.ledger(), arm: { on: true, mode: 'REAL', watermarkT: k ? ist(10, 29 + k) : ist(10, 25), armT: ist(10, 0) }, model: model({ signals: [sig('DOUBLE_BOTTOM_SELL', t)], lastBarT: t }) }));
    r.advance(60);
  }
  assert.match(r.engine.halt ?? '', /refused/);
});

// ── Renko INDEX chart -> option (lib/pnfIndexMap.ts) ───────────────────────────────────────────────────────────────────────
const INDEX: Target = { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' };
const CE: Target = { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-03', strike: 25000, side: 'CE' };
const MAP = { bull: { action: 'BUY' as const, opt: 'PE' as const, offset: 0 }, bear: { action: 'SELL' as const, opt: 'CE' as const, offset: 0 }, expiry: 'NEAREST' };
/** A resolver for the bear leg (SELL CE 25000) and a premium source the test moves. */
function indexRig(replies: (OrderReply | null)[], opts: { premium?: number | null; prem?: { v: number | null } } = {}) {
  const dirs: string[] = [];
  const prem = opts.prem ?? { v: 90 };
  const r = rig(replies, {
    resolveIndex: async (_b, _i, map, dir) => {
      dirs.push(dir);
      const leg = map[dir];
      return { traded: { ...CE, side: leg.opt }, action: leg.action, ids: 'NSE_FNO:40001', premium: opts.premium === undefined ? 120 : opts.premium, unsupported: null,
        legs: [{ label: 'NIFTY 25000 CE', lot: 65, unitsPerLot: 65, key: '40001', lotUnits: 65 }] };
    },
    premium: async () => prem.v,
  });
  const inputs = (over: Partial<ChartInputs> = {}) => r.inputs({ target: INDEX, info: null, indexMap: MAP, market: 'NSE', ...over });
  return { ...r, inputs, dirs, prem };
}
const placedOpt = (side: 'BUY' | 'SELL', orderId = 'O1'): OrderReply => ({ success: true, outcome: 'placed', legs: [{ label: 'NIFTY 25000 CE', side, qty: 65, product: 'INTRADAY', status: 'placed', orderId }] });
const reversal = () => model({ columns: [...model().columns, col('X', 103)], columnTimes: [...model().columnTimes, { start: ist(10, 40), end: ist(10, 41) }], lastBarT: ist(10, 41) });

test('index chart, REAL: a bearish signal trades the map\'s bear leg (SELL CE) - the row keeps the index as its chart and carries the option', async () => {
  const r = indexRig([placedOpt('SELL')]);
  await r.engine.tick(r.inputs());
  assert.deepEqual(r.dirs, ['bear']);
  assert.equal(r.orders.length, 1);
  assert.deepEqual([r.orders[0].action, (r.orders[0].target as Target).kind, (r.orders[0].target as Target).side], ['SELL', 'options', 'CE']);
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'open');
  assert.equal(row.target.kind, 'index', 'the chart: every brick rule reads the index');
  assert.equal(row.side, 'SELL');
  assert.deepEqual([row.traded?.action, row.traded?.targetKey, row.traded?.entryPremium], ['SELL', 'options|NIFTY|2026-11-03|25000|CE', 120]);
  assert.equal(row.legs[0].units, 65);
  assert.equal(row.pyramidMax, undefined, 'no adds on an option row');
});

test('index chart, REAL: the reversal exits the OPTION on its own closing side (BUY back the CE), sized by its own units', async () => {
  const r = indexRig([placedOpt('SELL'), placedOpt('BUY', 'X1')]);
  await r.engine.tick(r.inputs());
  r.advance(600);
  await r.engine.tick(r.inputs({ ledger: r.ledger(), model: reversal() }));
  const exit = r.orders[1] as { target: Target; exitOwn: { side: string; units: number[] } };
  assert.deepEqual([exit.target.kind, exit.target.side, exit.exitOwn.side, exit.exitOwn.units], ['options', 'CE', 'BUY', [65]]);
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'closed');
  assert.equal(row.traded?.exitPremium, 90);
  assert.equal(row.pnl, (120 - 90) * 65, 'P&L on the premiums, on the option\'s own side');
});

test('index chart, PAPER: booked at the option premiums; a reversal with no option price waits (never booked at the index)', async () => {
  const prem = { v: null as number | null };
  const r = indexRig([{ success: true, outcome: 'placed', legs: [] }], { prem });
  const paper = { arm: { on: true, mode: 'PAPER' as const, watermarkT: ist(10, 25), armT: ist(10, 0) } };
  await r.engine.tick(r.inputs(paper));
  assert.equal(r.ledger().rows[0].traded?.entryPremium, 120);
  r.advance(600);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: reversal() }));
  assert.equal(r.ledger().rows[0].state, 'open', 'no option price: not closed');
  assert.match(r.engine.note, /waiting for the option/);
  prem.v = 140;
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: reversal() }));
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'closed');
  assert.equal(row.pnl, (120 - 140) * 65, 'a short CE that rose 20 loses 20 x 65');
});

test('index chart: no option price at the signal = nothing sent, retried while the signal is fresh', async () => {
  const r = indexRig([placedOpt('SELL')], { premium: null });
  await r.engine.tick(r.inputs());
  assert.equal(r.orders.length, 0);
  assert.equal(r.ledger().rows.length, 0);
  assert.match(r.engine.note, /no price/);
});

test('index chart: an arming without a map never enters', async () => {
  const r = indexRig([placedOpt('SELL')]);
  await r.engine.tick(r.inputs({ indexMap: undefined }));
  assert.equal(r.orders.length, 0);
  assert.match(r.engine.note, /through its map/);
});

// ── paths the browser AUTO specs covered before AUTO moved to the server (feaa01a5, 2026-11-06) ──

test('REAL entry whose ledger reservation fails sends nothing, and is retried on the next tick while the signal is fresh', async () => {
  let failOpen = 1;
  const r = rig([placed()]);
  const inner = r.engine as unknown as { deps: ChartDeps };
  const post = inner.deps.post;
  inner.deps.post = async op => (op.op === 'open' && failOpen-- > 0 ? { ok: false, error: 'ledger unreachable' } : post(op));
  await r.engine.tick(r.inputs());
  assert.equal(r.orders.length, 0, 'nothing is sent without a reservation');
  assert.equal(r.ledger().rows.length, 0);
  r.advance(1);
  await r.engine.tick(r.inputs({ ledger: r.ledger() }));
  assert.equal(r.orders.length, 1, 'the same fresh signal is entered on the retry');
  assert.equal(r.ledger().rows[0].state, 'open');
});

test('side filter at the engine: Buy only does not enter the SELL signal (and says so); Sell only enters it', async () => {
  const buyOnly = rig([placed()]);
  await buyOnly.engine.tick(buyOnly.inputs({ side: 'buy' }));
  assert.equal(buyOnly.orders.length, 0);
  assert.match(buyOnly.engine.note, /SELL signal ignored/);
  const sellOnly = rig([placed()]);
  await sellOnly.engine.tick(sellOnly.inputs({ side: 'sell' }));
  assert.equal(sellOnly.orders.length, 1);
  assert.equal(sellOnly.orders[0].action, 'SELL');
});

/** A Renko chart (box 1): an up brick at 10:20, then a down brick at 10:30 that is a SELL signal, then `bricks` = [bar time, dir, close]. */
function renko(bricks: [number, 'X' | 'O', number][] = []): PanelModel {
  const brick = (dir: 'X' | 'O', close: number): PnfColumn => ({ ...col(dir), low: dir === 'O' ? close : close - 1, high: dir === 'O' ? close + 1 : close });
  const cols = [brick('X', 101), brick('O', 100), ...bricks.map(([, d, c]) => brick(d, c))];
  const times = [ist(10, 20), ist(10, 30), ...bricks.map(([t]) => t)].map(t => ({ start: t, end: t }));
  return model({ chart: 'renko', columns: cols, columnTimes: times, signals: [sig('DOUBLE_BOTTOM_SELL', ist(10, 30))], lastBarT: times[times.length - 1].start } as Partial<PanelModel>);
}
const PYR = { on: true, max: 3, every: 1, trailOn: false, trail: 2 };

test('PAPER pyramid: one lot per bar on a new best brick, never twice on a bar, never past Max; the exit closes every lot', async () => {
  const r = rig([{ success: true, outcome: 'placed', legs: [] }]);   // the paper entry's reply (PAPER adds and exits send nothing)
  const paper = { arm: { on: true, mode: 'PAPER' as const, watermarkT: ist(10, 25), armT: ist(10, 0) }, pyramid: PYR };
  r.at(ist(10, 31) + 5);
  await r.engine.tick(r.inputs({ ...paper, model: renko() }));
  assert.equal(r.ledger().rows[0].lots, 1);
  // 10:32: two new lower bricks on one bar -> one add, booked at the bar's brick
  const b1: [number, 'X' | 'O', number][] = [[ist(10, 32), 'O', 99], [ist(10, 32), 'O', 98]];
  r.at(ist(10, 33) + 5);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: renko(b1) }));
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: renko(b1) }));
  assert.equal(r.ledger().rows[0].lots, 2, 'one add per bar');
  // 10:34 a new best brick: the third lot (Max); 10:36 another: capped
  const b2: [number, 'X' | 'O', number][] = [...b1, [ist(10, 34), 'O', 97]];
  r.at(ist(10, 35) + 5);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: renko(b2) }));
  const b3: [number, 'X' | 'O', number][] = [...b2, [ist(10, 36), 'O', 96]];
  r.at(ist(10, 37) + 5);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: renko(b3) }));
  assert.equal(r.ledger().rows[0].lots, 3, 'never past Max');
  assert.equal(r.ops.filter(o => o.op === 'addPaper').length, 2);
  assert.equal(r.orders.filter(o => o.mode === 'REAL').length, 0, 'PAPER sends nothing to a broker');
  // 10:38 an up brick: the reversal closes the whole 3-lot position
  r.at(ist(10, 39) + 5);
  await r.engine.tick(r.inputs({ ...paper, ledger: r.ledger(), model: renko([...b3, [ist(10, 38), 'X', 97]]) }));
  const row = r.ledger().rows[0];
  assert.equal(row.state, 'closed');
  assert.equal(row.lots, 3);
  assert.equal(row.reason, 'reversal');
});

test('REAL pyramid: the add is reserved, sent as 1 lot on the row\'s side, confirmed; the exit sends exitOwn with every lot\'s units', async () => {
  const r = rig([placed('E1'), placed('A1'), { success: true, outcome: 'placed', legs: [{ label: 'NIFTY FUT', side: 'BUY', qty: 150, product: 'INTRADAY', status: 'placed', orderId: 'X1' }] }]);
  r.at(ist(10, 31) + 5);
  await r.engine.tick(r.inputs({ pyramid: PYR, model: renko() }));
  assert.equal(r.ledger().rows[0].state, 'open');
  const b1: [number, 'X' | 'O', number][] = [[ist(10, 32), 'O', 99]];
  r.at(ist(10, 33) + 5);
  r.ops.length = 0;
  await r.engine.tick(r.inputs({ pyramid: PYR, ledger: r.ledger(), model: renko(b1) }));
  assert.deepEqual(r.ops.map(o => o.op), ['beginAdd', 'confirmAdd'], 'reserved before it is sent');
  assert.deepEqual({ action: r.orders[1].action, lots: r.orders[1].lots, mode: r.orders[1].mode }, { action: 'SELL', lots: 1, mode: 'REAL' });
  assert.equal(r.ledger().rows[0].lots, 2);
  r.at(ist(10, 35) + 5);
  await r.engine.tick(r.inputs({ pyramid: PYR, ledger: r.ledger(), model: renko([...b1, [ist(10, 34), 'X', 100]]) }));
  const exit = r.orders[2] as { exitOwn?: { side: string; units: number[] } };
  assert.deepEqual(exit.exitOwn && { side: exit.exitOwn.side, units: exit.exitOwn.units }, { side: 'BUY', units: [150] }, 'both lots, 2 x 75');
  assert.equal(r.ledger().rows[0].state, 'closed');
});
