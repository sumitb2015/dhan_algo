import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBasketGuards, newGuardRuntime, type GuardEffect, type GuardInput, type GuardRuntime } from './multiLegGuardEngine.ts';
import { SPOT_CONFIRM_MS, GUARD_EXIT_RETRY_MS, type BasketGuards, type SpotTrigger, type GreekBand } from './multiLegGuards.ts';
import type { MultiLegLeg } from './multiLegFocus.ts';

const T0 = 1_800_000_000_000;               // 2027-01-15 ~08:00 UTC
const TODAY = new Date(T0 + 5.5 * 3_600_000).toISOString().slice(0, 10);

const leg = (id: string, side: 'B' | 'S', option: 'CE' | 'PE', o: Record<string, unknown> = {}) =>
  ({ id, side, option, strike: 24000, status: 'OPEN', fill: { qty: 75, avgPrice: 100 }, lots: 1, ...o }) as unknown as MultiLegLeg;
const spotTrig = (o: Partial<SpotTrigger> = {}): SpotTrigger => ({ id: 't', level: 24500, dir: 'above', action: 'EXIT_ALL', armed: true, armedDay: TODAY, ...o });
const band = (o: Partial<GreekBand> = {}): GreekBand => ({ id: 'b', metric: 'delta', min: -100, action: 'ALERT', armed: true, armedDay: TODAY, ...o });

function input(over: Partial<GuardInput> & { guards: BasketGuards }): GuardInput {
  return {
    basketId: 'B1', label: 'Strangle', underlying: 'NIFTY', broker: 'dhan',
    legs: [leg('s', 'S', 'CE'), leg('p', 'S', 'PE')],
    now: T0, today: TODAY, spot: 24000, busy: false,
    netGreeks: () => ({ delta: 0, gamma: 0, theta: 0, vega: 0 }),
    pnlToday: () => 0, funds: null, fmtMoney: n => `₹${Math.round(n)}`,
    ...over,
  };
}
const kinds = (fx: GuardEffect[]) => fx.map(e => e.kind);
const run = (inp: GuardInput, rt: GuardRuntime, atMs = 0) => evaluateBasketGuards({ ...inp, now: inp.now + atMs }, rt);
const applyPatches = (g: BasketGuards, fx: GuardEffect[]) => fx.reduce((acc, e) => (e.kind === 'patch' ? e.fn(acc) : acc), g);

test('spot trigger: watch, then fire after the confirmation window, once', () => {
  const rt = newGuardRuntime();
  const inp = input({ guards: { spotTriggers: [spotTrig()] }, spot: 24600 });
  assert.deepEqual(run(inp, rt, 0), []);                                                  // breach starts: nothing yet
  const fx = run(inp, rt, SPOT_CONFIRM_MS);
  assert.deepEqual(kinds(fx), ['patch', 'toast', 'exitAll']);
  const patched = applyPatches(inp.guards, fx);
  assert.ok(patched.spotTriggers![0].firedAt);
  // right after firing: retry spacing holds the next send
  assert.deepEqual(run({ ...inp, guards: patched }, rt, SPOT_CONFIRM_MS + 1000), []);
});

test('spot trigger: a bounce under the level before confirmation cancels it', () => {
  const rt = newGuardRuntime();
  const inp = input({ guards: { spotTriggers: [spotTrig()] } });
  run({ ...inp, spot: 24600 }, rt, 0);
  run({ ...inp, spot: 24400 }, rt, 1000);
  assert.deepEqual(run({ ...inp, spot: 24600 }, rt, SPOT_CONFIRM_MS), []);                // clock restarted
});

test('spot trigger: unknown spot never fires', () => {
  const rt = newGuardRuntime();
  const inp = input({ guards: { spotTriggers: [spotTrig()] }, spot: 0 });
  assert.deepEqual(run(inp, rt, 0), []);
  assert.deepEqual(run(inp, rt, 60_000), []);
});

test('spot trigger: EXIT_CE sends only the call-side legs, shorts before hedges', () => {
  const rt = newGuardRuntime();
  const legs = [leg('hedge', 'B', 'CE'), leg('short', 'S', 'CE'), leg('put', 'S', 'PE')];
  const inp = input({ guards: { spotTriggers: [spotTrig({ action: 'EXIT_CE' })] }, legs, spot: 24600 });
  run(inp, rt, 0);
  const fx = run(inp, rt, SPOT_CONFIRM_MS);
  const side = fx.find(e => e.kind === 'exitSide') as Extract<GuardEffect, { kind: 'exitSide' }>;
  assert.deepEqual(side.scope.map(l => l.id), ['short', 'hedge']);
});

test('spot trigger: busy row defers the fire without losing the breach clock', () => {
  const rt = newGuardRuntime();
  const inp = input({ guards: { spotTriggers: [spotTrig()] }, spot: 24600 });
  run(inp, rt, 0);
  assert.deepEqual(run({ ...inp, busy: true }, rt, SPOT_CONFIRM_MS), []);
  assert.deepEqual(kinds(run(inp, rt, SPOT_CONFIRM_MS + 500)), ['patch', 'toast', 'exitAll']);
});

test('spot trigger: a firing exit that is flat but still settling does not disarm; a rejection reopens the leg and it retries', () => {
  const rt = newGuardRuntime();
  const fired = { spotTriggers: [spotTrig({ action: 'EXIT_CE', firedAt: 'x' })] };
  rt.lastAttempt.set('B1:t', T0);
  // short ACKed closed, order still pending: scope is empty but settling -> hold (no finish, no patch)
  const closedPending = [leg('short', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{ kind: 'exit' }] }), leg('put', 'S', 'PE')];
  assert.deepEqual(run(input({ guards: fired, legs: closedPending, spot: 24000 }), rt, 30_000), []);
  // the order book then rejects it: the leg is OPEN again -> the trigger retries
  const reopened = [leg('short', 'S', 'CE'), leg('put', 'S', 'PE')];
  assert.deepEqual(kinds(run(input({ guards: fired, legs: reopened, spot: 24000 }), rt, 30_000)), ['exitSide']);
  // settled and flat -> finish disarms it
  const settled = [leg('short', 'S', 'CE', { status: 'CLOSED', closedAt: T0 - 60_000 }), leg('put', 'S', 'PE')];
  const fx = run(input({ guards: fired, legs: settled, spot: 24000 }), rt, 30_000);
  assert.deepEqual(kinds(fx), ['patch']);
  assert.equal(applyPatches(fired, fx).spotTriggers![0].armed, false);
});

test('spot trigger: hedges-only retry waits while the shorts it closed are still settling', () => {
  const rt = newGuardRuntime();
  const g = { spotTriggers: [spotTrig({ action: 'EXIT_CE', firedAt: 'x' })] };
  const legs = [leg('hedge', 'B', 'CE'), leg('short', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{ kind: 'exit' }] })];
  assert.deepEqual(run(input({ guards: g, legs }), rt, 0), []);
  const settled = [leg('hedge', 'B', 'CE'), leg('short', 'S', 'CE', { status: 'CLOSED', closedAt: T0 - 60_000 })];
  assert.deepEqual(kinds(run(input({ guards: g, legs: settled }), rt, 0)), ['exitSide']);
});

test('spot ALERT fires once and then disarms itself', () => {
  const rt = newGuardRuntime();
  const inp = input({ guards: { spotTriggers: [spotTrig({ action: 'ALERT' })] }, spot: 24600 });
  run(inp, rt, 0);
  const fx = run(inp, rt, SPOT_CONFIRM_MS);
  assert.deepEqual(kinds(fx), ['patch', 'toast']);
  const fired = applyPatches(inp.guards, fx);
  assert.deepEqual(kinds(run({ ...inp, guards: fired }, rt, SPOT_CONFIRM_MS + 1000)), ['patch']);   // finish
});

test('no open legs: a firing guard is disarmed, an idle one waits, and nothing happens while an exit settles', () => {
  const rt = newGuardRuntime();
  const flat = [leg('s', 'S', 'CE', { status: 'CLOSED', closedAt: T0 - 120_000 })];
  const firing = { spotTriggers: [spotTrig({ firedAt: 'x' })] };
  const fx = run(input({ guards: firing, legs: flat }), rt, 0);
  assert.equal(applyPatches(firing, fx).spotTriggers![0].armed, false);
  const idle = { spotTriggers: [spotTrig()] };
  assert.deepEqual(run(input({ guards: idle, legs: flat, spot: 24600 }), rt, 0), []);
  const settling = [leg('s', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{}] })];
  assert.deepEqual(run(input({ guards: firing, legs: settling }), rt, 0), []);
});

test('Greek ALERT band: announces once per breach; an unpriced blip neither resets nor re-announces', () => {
  const rt = newGuardRuntime();
  const g = { greekBands: [band()] };
  const breached = { delta: -150, gamma: 0, theta: 0, vega: 0 };
  const inp = input({ guards: g, netGreeks: () => breached });
  assert.deepEqual(run(inp, rt, 0), []);
  assert.deepEqual(kinds(run(inp, rt, SPOT_CONFIRM_MS)), ['toast']);
  assert.deepEqual(run(inp, rt, SPOT_CONFIRM_MS + 1000), []);                              // already announced
  assert.deepEqual(run({ ...inp, netGreeks: () => null }, rt, SPOT_CONFIRM_MS + 2000), []); // marks flicker away
  assert.deepEqual(run(inp, rt, SPOT_CONFIRM_MS + 3000), []);                               // still the same breach: no repeat
  run({ ...inp, netGreeks: () => ({ ...breached, delta: 0 }) }, rt, SPOT_CONFIRM_MS + 4000); // back inside
  run(inp, rt, SPOT_CONFIRM_MS + 5000);
  assert.deepEqual(kinds(run(inp, rt, 2 * SPOT_CONFIRM_MS + 5000)), ['toast']);             // a new breach announces again
});

test('Greek EXIT_ALL band: unknown Greeks never fire; a confirmed breach exits the basket', () => {
  const rt = newGuardRuntime();
  const g = { greekBands: [band({ action: 'EXIT_ALL' })] };
  assert.deepEqual(run(input({ guards: g, netGreeks: () => null }), rt, 0), []);
  assert.deepEqual(run(input({ guards: g, netGreeks: () => null }), rt, 60_000), []);
  const inp = input({ guards: g, netGreeks: () => ({ delta: -150, gamma: 0, theta: 0, vega: 0 }) });
  run(inp, rt, 100_000);
  assert.deepEqual(kinds(run(inp, rt, 100_000 + SPOT_CONFIRM_MS)), ['patch', 'toast', 'exitAll']);
});

test('loss alarm: heads-up then breach each announce once', () => {
  const rt = newGuardRuntime();
  const g = { alarm: { armed: true, armedDay: TODAY, maxLoss: 10_000 } };
  let pnl = -8_500;
  const mk = () => input({ guards: g, pnlToday: () => pnl });
  assert.deepEqual(kinds(run(mk(), rt, 0)), ['toast']);
  assert.deepEqual(run(mk(), rt, 1000), []);
  pnl = -10_500;
  assert.deepEqual(kinds(run(mk(), rt, 2000)), ['toast']);
  assert.deepEqual(run(mk(), rt, 3000), []);
});

test('legacy guards: stored in the new shape on first pass; a re-scoped loss rule is turned off with a notice', () => {
  const rt = newGuardRuntime();
  const legacy = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true, lossScope: 'total', marginWarnPct: 50 } } as unknown as BasketGuards;
  const funds = { available: 10_000, used: 90_000 };
  const fx = run(input({ guards: legacy, pnlToday: () => -5000, funds }), rt, 0);
  assert.deepEqual(kinds(fx), ['patch', 'toast', 'toast']);                                 // migrate, loss-rule notice, margin alert
  assert.equal(fx.some(e => e.kind === 'exitAll'), false);                                  // the turned-off loss rule does not exit
  const after = applyPatches(legacy, fx);
  assert.equal(after.alarm!.armed, false);
  assert.deepEqual(after.marginAlarm, { armed: true, armedDay: TODAY, pct: 50 });
});

test('legacy guards: an armed all-trades loss rule with nothing else armed is still migrated and announced', () => {
  const legacy = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true, lossScope: 'total' } } as unknown as BasketGuards;
  const fx = run(input({ guards: legacy, pnlToday: () => -5000 }), newGuardRuntime(), 0);
  assert.deepEqual(kinds(fx), ['patch', 'toast']);                                          // migrate + notice, no exit
  assert.equal(applyPatches(legacy, fx).alarm!.armed, false);
});

test('margin rule acts on its own switch, independent of the loss rule (even while it is closing)', () => {
  const funds = { available: 10_000, used: 90_000 };
  const closing = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true, firedAt: 'x' }, marginAlarm: { armed: true, armedDay: TODAY, pct: 80 } };
  assert.deepEqual(kinds(run(input({ guards: closing, funds }), newGuardRuntime(), 0)), ['toast', 'exitAll']);
  const lossOff = { alarm: { armed: false, maxLoss: 1000 }, marginAlarm: { armed: true, armedDay: TODAY, pct: 80 } };
  assert.deepEqual(kinds(run(input({ guards: lossOff, funds }), newGuardRuntime(), 0)), ['toast']);
});

test('loss alarm: unpriced P&L reads as unknown, never as a breach', () => {
  const rt = newGuardRuntime();
  const g = { alarm: { armed: true, armedDay: TODAY, maxLoss: 100, exitAtMaxLoss: true } };
  assert.deepEqual(run(input({ guards: g, pnlToday: () => null }), rt, 0), []);
});

test('loss alarm: close-at-max-loss exits once (stamping firedAt) and never while the row is busy', () => {
  const rt = newGuardRuntime();
  const g = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true } };
  assert.deepEqual(kinds(run(input({ guards: g, pnlToday: () => -1500 }), rt, 0)), ['toast', 'patch', 'exitAll']);
  assert.deepEqual(run(input({ guards: g, pnlToday: () => -1500, busy: true }), newGuardRuntime(), 0).filter(e => e.kind === 'exitAll'), []);
});

test('margin alarm: per-basket announce state, so two thresholds on one account do not flip-flop', () => {
  const rt = newGuardRuntime();
  const funds = { available: 15_000, used: 85_000 };                                        // 85% in use
  const a = (ms: number) => run(input({ basketId: 'A', guards: { marginAlarm: { armed: true, armedDay: TODAY, pct: 80 } }, funds }), rt, ms);
  const b = (ms: number) => run(input({ basketId: 'B', guards: { marginAlarm: { armed: true, armedDay: TODAY, pct: 90 } }, funds }), rt, ms);
  const toasts = [...a(0), ...b(0), ...a(1000), ...b(1000), ...a(2000), ...b(2000)].filter(e => e.kind === 'toast');
  assert.equal(toasts.length, 1);                                                           // A once; B (90%) never
});

test('margin alarm: unknown funds say nothing', () => {
  const rt = newGuardRuntime();
  assert.deepEqual(run(input({ guards: { marginAlarm: { armed: true, armedDay: TODAY, pct: 50 } }, funds: null }), rt, 0), []);
});

test('day roll: guards armed on an earlier day (or unstamped) are disarmed with one notice and do not act', () => {
  const rt = newGuardRuntime();
  const old = { spotTriggers: [spotTrig({ armedDay: '2026-10-09' })], greekBands: [band({ armedDay: undefined })], alarm: { armed: true, armedDay: '2026-10-09', maxLoss: 100 } };
  const fx = run(input({ guards: old, spot: 24600, pnlToday: () => -5000 }), rt, 0);
  assert.deepEqual(kinds(fx), ['patch', 'toast']);
  const after = applyPatches(old, fx);
  assert.equal(after.spotTriggers![0].armed, false);
  assert.equal(after.greekBands![0].armed, false);
  assert.equal(after.alarm!.armed, false);
  assert.equal(after.spotTriggers![0].level, 24500);                                        // config kept
  // same-day guards are untouched
  assert.deepEqual(run(input({ guards: { spotTriggers: [spotTrig()] } }), rt, 0), []);
});

// ── Second-level review: the alarm closes once, then disarms ──

test('close-at-max-loss: stamps firedAt with the exit, retries until flat, then disarms so a later leg is not closed', () => {
  const rt = newGuardRuntime();
  const g = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true } };
  const inp = input({ guards: g, pnlToday: () => -1500 });
  const fx = run(inp, rt, 0);
  assert.deepEqual(kinds(fx), ['toast', 'patch', 'exitAll']);
  const fired = applyPatches(g, fx);
  assert.ok(fired.alarm!.firedAt);
  // closing: P&L recovering does not cancel it, retries are spaced
  const closing = { ...inp, guards: fired, pnlToday: () => 0 };
  assert.deepEqual(run(closing, rt, 5000), []);
  assert.deepEqual(kinds(run(closing, rt, GUARD_EXIT_RETRY_MS)), ['exitAll']);
  // flat and settled -> the alarm disarms
  const flat = [leg('s', 'S', 'CE', { status: 'CLOSED', closedAt: T0 - 120_000 })];
  const done = applyPatches(fired, run({ ...closing, legs: flat }, rt, 60_000));
  assert.equal(done.alarm!.armed, false);
  // ...so a new leg added the same day is left alone even though today's realized loss is still past the limit
  const newLeg = [...flat, leg('n', 'S', 'CE')];
  assert.deepEqual(run(input({ guards: done, legs: newLeg, pnlToday: () => -1500 }), rt, 120_000), []);
});

test('close-at-max-loss: still settling does not disarm; hedges-only retry waits for the shorts it closed', () => {
  const rt = newGuardRuntime();
  const fired = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true, firedAt: 'x' } };
  const settling = [leg('s', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{}] })];
  assert.deepEqual(run(input({ guards: fired, legs: settling }), rt, 0), []);                       // flat but settling: no patch
  const hedgeOnly = [leg('h', 'B', 'CE'), leg('s', 'S', 'CE', { status: 'CLOSED', pendingOrders: [{}] })];
  assert.deepEqual(run(input({ guards: fired, legs: hedgeOnly }), rt, 0), []);                      // waits
  const settled = [leg('h', 'B', 'CE'), leg('s', 'S', 'CE', { status: 'CLOSED', closedAt: T0 - 60_000 })];
  assert.deepEqual(kinds(run(input({ guards: fired, legs: settled }), rt, 0)), ['exitAll']);
});

test('close-at-max-loss: a busy row defers the exit without stamping firedAt', () => {
  const rt = newGuardRuntime();
  const g = { alarm: { armed: true, armedDay: TODAY, maxLoss: 1000, exitAtMaxLoss: true } };
  const fx = run(input({ guards: g, pnlToday: () => -1500, busy: true }), rt, 0);
  assert.deepEqual(kinds(fx), ['toast']);
});
