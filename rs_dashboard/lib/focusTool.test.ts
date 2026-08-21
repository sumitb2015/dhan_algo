import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseHHMM, atmStrike, resolveStrikes, dteFor, dteMatches, pairPnl,
  evaluateExit, evaluateEntry, evaluateGlobalRisk,
  newRow, newGroup, defaultConfig, emptyExits,
  INTRADAY_EXIT_MINUTES,
  type FocusRow, type ExitContext, type RowFill,
} from './focusTool.ts';

const MIN = (h: number, m: number) => h * 60 + m;

/** An entered short straddle: both legs at 24000, 20 rupees each, 65 units. */
function enteredRow(over: Partial<FocusRow> = {}): FocusRow {
  const fill: RowFill = {
    ceStrike: 24000, peStrike: 24000,
    ceEntry: 120, peEntry: 100,
    qty: 65, ts: '2026-08-21T09:20:00',
  };
  return { ...newRow('r1'), state: 'ENTERED', side: 'SELL', fill, ...over };
}

function ctx(over: Partial<ExitContext> = {}): ExitContext {
  return {
    nowMinutes: MIN(11, 0),
    spot: 24000,
    ceLtp: 120, peLtp: 100,
    vwap: null,
    bookExit: { enabled: false, spotHigh: null, spotLow: null },
    ...over,
  };
}

// ─── Time ─────────────────────────────────────────────────────────

test('parseHHMM accepts HH:MM and rejects everything else', () => {
  assert.strictEqual(parseHHMM('09:20'), 560);
  assert.strictEqual(parseHHMM('9:20'), 560);
  assert.strictEqual(parseHHMM('15:17'), INTRADAY_EXIT_MINUTES);
  assert.strictEqual(parseHHMM('00:00'), 0);
  assert.strictEqual(parseHHMM(''), null);
  assert.strictEqual(parseHHMM('24:00'), null);
  assert.strictEqual(parseHHMM('09:60'), null);
  assert.strictEqual(parseHHMM('0920'), null);
});

// ─── Strikes ──────────────────────────────────────────────────────

test('atmStrike snaps to the nearest step and refuses nonsense input', () => {
  assert.strictEqual(atmStrike(24231.85, 50), 24250);
  assert.strictEqual(atmStrike(24224.00, 50), 24225 - 25); // 24224 -> 24200
  assert.strictEqual(atmStrike(57620, 100), 57600);
  assert.strictEqual(atmStrike(0, 50), 0);
  assert.strictEqual(atmStrike(24000, 0), 0);
});

test('resolveStrikes builds a straddle at offset 0 and a symmetric strangle beyond', () => {
  assert.deepStrictEqual(resolveStrikes(24250, 0, 50), { ceStrike: 24250, peStrike: 24250 });
  assert.deepStrictEqual(resolveStrikes(24250, 2, 50), { ceStrike: 24350, peStrike: 24150 });
  // A negative offset is the same width, not an inverted strangle: CE must
  // never end up below PE (the inversion guard the straddle strategies enforce).
  assert.deepStrictEqual(resolveStrikes(24250, -2, 50), { ceStrike: 24350, peStrike: 24150 });
});

// ─── DTE ──────────────────────────────────────────────────────────

test('dteFor counts calendar days and reports 0 on expiry day', () => {
  assert.strictEqual(dteFor('2026-08-21', '2026-08-21'), 0);
  assert.strictEqual(dteFor('2026-08-26', '2026-08-21'), 5);
  assert.strictEqual(dteFor('2026-09-01', '2026-08-30'), 2);   // across a month boundary
  assert.strictEqual(dteFor('2026-08-20', '2026-08-21'), -1);  // lapsed
  assert.strictEqual(dteFor('', '2026-08-21'), null);
  assert.strictEqual(dteFor('not-a-date', '2026-08-21'), null);
});

test('dteMatches honours each chip, and an unknown DTE never matches', () => {
  assert.strictEqual(dteMatches('any', 5), true);
  assert.strictEqual(dteMatches('any', 0), true);
  assert.strictEqual(dteMatches('any', -1), false);  // lapsed is not "any"
  assert.strictEqual(dteMatches('0', 0), true);
  assert.strictEqual(dteMatches('0', 1), false);
  assert.strictEqual(dteMatches('1', 1), true);
  assert.strictEqual(dteMatches('0+1', 0), true);
  assert.strictEqual(dteMatches('0+1', 1), true);
  assert.strictEqual(dteMatches('0+1', 2), false);
  for (const f of ['any', '0', '1', '0+1'] as const) {
    assert.strictEqual(dteMatches(f, null), false, `${f} matched an unknown DTE`);
  }
});

// ─── P&L ──────────────────────────────────────────────────────────

test('pairPnl gives a short the decay and a long the expansion', () => {
  const fill = enteredRow().fill!;
  // Entry 220 combined, now 200 -> short is up 20 x 65.
  assert.strictEqual(pairPnl(fill, 110, 90, 'SELL'), 20 * 65);
  assert.strictEqual(pairPnl(fill, 110, 90, 'BUY'), -20 * 65);
  assert.strictEqual(pairPnl(fill, 120, 100, 'SELL'), 0);
});

// ─── Exit ladder ──────────────────────────────────────────────────

test('a row that is not ENTERED never exits', () => {
  for (const state of ['DRAFT', 'ARMED', 'EXITED', 'ERROR'] as const) {
    const d = evaluateExit(enteredRow({ state }), ctx({ nowMinutes: MIN(15, 30) }));
    assert.strictEqual(d.exit, false, `${state} produced an exit`);
  }
});

test('the 15:17 bell outranks every other rule', () => {
  const row = enteredRow({ exitTime: '15:00', exits: { ...emptyExits(), spotHigh: 10 } });
  const d = evaluateExit(row, ctx({ nowMinutes: INTRADAY_EXIT_MINUTES }));
  assert.strictEqual(d.exit, true);
  assert.match(d.reason, /15:17/);
});

test('group Book Exit fires on either spot level and outranks the row exit time', () => {
  const row = enteredRow({ exitTime: '10:00' });
  const bookExit = { enabled: true, spotHigh: 24500, spotLow: 23500 };

  const hi = evaluateExit(row, ctx({ spot: 24500, bookExit }));
  assert.strictEqual(hi.exit, true);
  assert.match(hi.reason, /Book exit/);

  const lo = evaluateExit(row, ctx({ spot: 23400, bookExit }));
  assert.strictEqual(lo.exit, true);
  assert.match(lo.reason, /Book exit/);

  // Disabled means disabled, even with levels filled in.
  const off = evaluateExit(row, ctx({ spot: 24500, bookExit: { ...bookExit, enabled: false } }));
  assert.match(off.reason, /Exit time/);
});

test('the row exit time fires at or after its minute, not before', () => {
  const row = enteredRow({ exitTime: '15:00' });
  assert.strictEqual(evaluateExit(row, ctx({ nowMinutes: MIN(14, 59) })).exit, false);
  assert.strictEqual(evaluateExit(row, ctx({ nowMinutes: MIN(15, 0) })).exit, true);
});

test('H↑ and L↓ fire on the underlying', () => {
  const row = enteredRow({ exits: { ...emptyExits(), spotHigh: 24400, spotLow: 24100 } });
  assert.strictEqual(evaluateExit(row, ctx({ spot: 24250 })).exit, false);
  assert.match(evaluateExit(row, ctx({ spot: 24400 })).reason, /H↑/);
  assert.match(evaluateExit(row, ctx({ spot: 24050 })).reason, /L↓/);
});

test('a dropped spot quote suppresses every spot rule instead of reading as a breach', () => {
  // This is the whole reason the guard exists: 0 is below every conceivable L↓,
  // so without it one failed quote read flattens the entire book.
  const row = enteredRow({ exits: { ...emptyExits(), spotLow: 24100 } });
  const bookExit = { enabled: true, spotHigh: null, spotLow: 23000 };
  assert.strictEqual(evaluateExit(row, ctx({ spot: 0, bookExit })).exit, false);
  assert.strictEqual(evaluateExit(row, ctx({ spot: -1, bookExit })).exit, false);
});

test('VWAP exits a short on expansion and a long on collapse', () => {
  const exits = { ...emptyExits(), vwap: true };
  const short = enteredRow({ exits });
  const long = enteredRow({ side: 'BUY', exits });

  // Combined 230 vs VWAP 220: bad for the short, fine for the long.
  assert.strictEqual(evaluateExit(short, ctx({ ceLtp: 130, peLtp: 100, vwap: 220 })).exit, true);
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 130, peLtp: 100, vwap: 220 })).exit, false);

  // Combined 210 vs VWAP 220: the mirror image.
  assert.strictEqual(evaluateExit(short, ctx({ ceLtp: 110, peLtp: 100, vwap: 220 })).exit, false);
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 110, peLtp: 100, vwap: 220 })).exit, true);
});

test('VWAP is inert without a usable VWAP or with both quotes missing', () => {
  const long = enteredRow({ side: 'BUY', exits: { ...emptyExits(), vwap: true } });
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 110, peLtp: 100, vwap: null })).exit, false);
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 110, peLtp: 100, vwap: 0 })).exit, false);
  // 0 + 0 is a pair of missing quotes, not a premium that collapsed to nothing.
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 0, peLtp: 0, vwap: 220 })).exit, false);
});

test('SL ₹ fires on absolute rupee loss for the pair', () => {
  const row = enteredRow({ exits: { ...emptyExits(), slRupees: 1000 } });
  // Premium 220 -> 235 is 15 x 65 = 975 against a short: not yet.
  assert.strictEqual(evaluateExit(row, ctx({ ceLtp: 135, peLtp: 100 })).exit, false);
  // -> 240 is 20 x 65 = 1300.
  assert.match(evaluateExit(row, ctx({ ceLtp: 140, peLtp: 100 })).reason, /SL ₹1000/);
  // A profit of the same magnitude must not trigger it.
  assert.strictEqual(evaluateExit(row, ctx({ ceLtp: 100, peLtp: 80 })).exit, false);
});

test('SL × is symmetric: a short exits on a multiple, a long on the reciprocal', () => {
  const exits = { ...emptyExits(), slMult: 2 };
  const short = enteredRow({ exits });
  const long = enteredRow({ side: 'BUY', exits });

  // Entry combined is 220. Short stops at 440, long stops at 110.
  assert.strictEqual(evaluateExit(short, ctx({ ceLtp: 240, peLtp: 190 })).exit, false); // 430
  assert.match(evaluateExit(short, ctx({ ceLtp: 240, peLtp: 200 })).reason, /SL ×2/);   // 440
  assert.strictEqual(evaluateExit(long, ctx({ ceLtp: 60, peLtp: 55 })).exit, false);    // 115
  assert.match(evaluateExit(long, ctx({ ceLtp: 60, peLtp: 50 })).reason, /SL ×2/);      // 110

  // A multiple of 1 or less is meaningless and must be ignored, not treated as
  // an instant stop.
  const degenerate = enteredRow({ exits: { ...emptyExits(), slMult: 1 } });
  assert.strictEqual(evaluateExit(degenerate, ctx()).exit, false);
});

test('an entered row with no rules configured simply stays open', () => {
  assert.strictEqual(evaluateExit(enteredRow(), ctx()).exit, false);
});

// ─── Entry rules ──────────────────────────────────────────────────

const entryCtx = (over: Partial<{ nowMinutes: number; dte: number | null; groupStarted: boolean }> = {}) =>
  ({ nowMinutes: MIN(9, 30), dte: 0, groupStarted: true, ...over });

test('a DRAFT row never enters, however complete it looks', () => {
  const row = { ...newRow('r'), entryTime: '09:20', lots: 1, state: 'DRAFT' as const };
  assert.strictEqual(evaluateEntry(row, entryCtx()).enter, false);
});

test('an armed row enters once its entry time passes', () => {
  const row = { ...newRow('r'), entryTime: '09:20', state: 'ARMED' as const };
  assert.strictEqual(evaluateEntry(row, entryCtx({ nowMinutes: MIN(9, 19) })).enter, false);
  assert.strictEqual(evaluateEntry(row, entryCtx({ nowMinutes: MIN(9, 20) })).enter, true);
});

test('entry needs a started group, a positive lot count and an entry time', () => {
  const base = { ...newRow('r'), entryTime: '09:20', state: 'ARMED' as const };
  assert.strictEqual(evaluateEntry(base, entryCtx({ groupStarted: false })).enter, false);
  assert.strictEqual(evaluateEntry({ ...base, lots: 0 }, entryCtx()).enter, false);
  assert.strictEqual(evaluateEntry({ ...base, entryTime: '' }, entryCtx()).enter, false);
});

test('the DTE chip gates entry, and an unresolved DTE blocks it', () => {
  const row = { ...newRow('r'), entryTime: '09:20', state: 'ARMED' as const, dte: '0' as const };
  assert.strictEqual(evaluateEntry(row, entryCtx({ dte: 0 })).enter, true);
  assert.strictEqual(evaluateEntry(row, entryCtx({ dte: 1 })).enter, false);
  assert.strictEqual(evaluateEntry(row, entryCtx({ dte: null })).enter, false);
});

test('entry is refused past 15:17 and past the row own exit time', () => {
  const row = { ...newRow('r'), entryTime: '09:20', state: 'ARMED' as const };
  assert.strictEqual(evaluateEntry(row, entryCtx({ nowMinutes: INTRADAY_EXIT_MINUTES })).enter, false);

  // Opening at 15:01 against a 15:00 exit would be flattened on the next tick.
  const withExit = { ...row, exitTime: '15:00' };
  assert.strictEqual(evaluateEntry(withExit, entryCtx({ nowMinutes: MIN(15, 1) })).enter, false);
  assert.strictEqual(evaluateEntry(withExit, entryCtx({ nowMinutes: MIN(14, 59) })).enter, true);
});

// ─── Global risk + trail ──────────────────────────────────────────

function cfgWith(over: Partial<ReturnType<typeof defaultConfig>>) {
  return { ...defaultConfig(), ...over };
}

test('target and stop fire on total P&L, and do nothing while disabled', () => {
  const on = cfgWith({ risk: { enabled: true, targetRs: 2000, stopRs: 1500 } });
  assert.match(evaluateGlobalRisk(on, { totalPnl: 2000, peakPnl: 2000, lockFloor: null }).reason, /Target/);
  assert.match(evaluateGlobalRisk(on, { totalPnl: -1500, peakPnl: 0, lockFloor: null }).reason, /Stop/);
  assert.strictEqual(evaluateGlobalRisk(on, { totalPnl: 500, peakPnl: 500, lockFloor: null }).exitAll, false);

  const off = cfgWith({ risk: { enabled: false, targetRs: 2000, stopRs: 1500 } });
  assert.strictEqual(evaluateGlobalRisk(off, { totalPnl: 5000, peakPnl: 5000, lockFloor: null }).exitAll, false);
});

test('the stop reads STOP ₹ as a positive magnitude, not a signed number', () => {
  const cfg = cfgWith({ risk: { enabled: true, targetRs: null, stopRs: 1500 } });
  assert.strictEqual(evaluateGlobalRisk(cfg, { totalPnl: -1499, peakPnl: 0, lockFloor: null }).exitAll, false);
  assert.strictEqual(evaluateGlobalRisk(cfg, { totalPnl: -1501, peakPnl: 0, lockFloor: null }).exitAll, true);
});

test('the trail stays dormant below TRIGGER, then arms with a floor one LOCK below it', () => {
  const cfg = cfgWith({ trail: { enabled: true, triggerRs: 2000, lockRs: 500 } });

  const dormant = evaluateGlobalRisk(cfg, { totalPnl: 1900, peakPnl: 1900, lockFloor: null });
  assert.strictEqual(dormant.trailState, 'DORMANT');
  assert.strictEqual(dormant.lockFloor, null);
  assert.strictEqual(dormant.exitAll, false);

  const armed = evaluateGlobalRisk(cfg, { totalPnl: 2000, peakPnl: 2000, lockFloor: null });
  assert.strictEqual(armed.trailState, 'ARMED');
  assert.strictEqual(armed.lockFloor, 1500);
  assert.strictEqual(armed.exitAll, false);
});

test('the trail floor ratchets on the peak and never moves down', () => {
  const cfg = cfgWith({ trail: { enabled: true, triggerRs: 2000, lockRs: 500 } });

  // Peak 3000 pulls the floor up to 2500...
  const up = evaluateGlobalRisk(cfg, { totalPnl: 2800, peakPnl: 3000, lockFloor: 1500 });
  assert.strictEqual(up.lockFloor, 2500);
  assert.strictEqual(up.exitAll, false);

  // ...and a fade back to 2600 leaves it there rather than lowering it.
  const held = evaluateGlobalRisk(cfg, { totalPnl: 2600, peakPnl: 3000, lockFloor: 2500 });
  assert.strictEqual(held.lockFloor, 2500);
  assert.strictEqual(held.exitAll, false);

  // Touching the floor fires.
  const fired = evaluateGlobalRisk(cfg, { totalPnl: 2500, peakPnl: 3000, lockFloor: 2500 });
  assert.strictEqual(fired.exitAll, true);
  assert.match(fired.reason, /Trail lock/);
});

test('a disabled or unconfigured trail never arms', () => {
  const off = cfgWith({ trail: { enabled: false, triggerRs: 2000, lockRs: 500 } });
  assert.strictEqual(evaluateGlobalRisk(off, { totalPnl: 9999, peakPnl: 9999, lockFloor: null }).trailState, 'INACTIVE');

  const noTrigger = cfgWith({ trail: { enabled: true, triggerRs: null, lockRs: 500 } });
  assert.strictEqual(evaluateGlobalRisk(noTrigger, { totalPnl: 9999, peakPnl: 9999, lockFloor: null }).trailState, 'INACTIVE');
});

test('the hard stop outranks the trail when both would fire', () => {
  const cfg = cfgWith({
    risk:  { enabled: true, targetRs: null, stopRs: 1000 },
    trail: { enabled: true, triggerRs: 2000, lockRs: 500 },
  });
  const d = evaluateGlobalRisk(cfg, { totalPnl: -1200, peakPnl: 2500, lockFloor: 2000 });
  assert.strictEqual(d.exitAll, true);
  assert.match(d.reason, /Stop/);
});

// ─── Defaults ─────────────────────────────────────────────────────

test('defaultConfig is inert: not live, no risk, no started groups, no rows', () => {
  const cfg = defaultConfig();
  assert.strictEqual(cfg.live, false);
  assert.strictEqual(cfg.risk.enabled, false);
  assert.strictEqual(cfg.trail.enabled, false);
  assert.strictEqual(cfg.groups.length, 3);
  for (const g of cfg.groups) {
    assert.strictEqual(g.started, false);
    assert.strictEqual(g.rows.length, 0);
    assert.strictEqual(g.bookExit.enabled, false);
  }
});

test('a new row starts as a DRAFT short straddle with no rules', () => {
  const r = newRow('x');
  assert.strictEqual(r.state, 'DRAFT');
  assert.strictEqual(r.side, 'SELL');
  assert.strictEqual(r.offset, 0);
  assert.deepStrictEqual(r.exits, emptyExits());
  assert.strictEqual(newGroup('NIFTY').underlying, 'NIFTY');
});
