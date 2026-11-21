import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClientOp, closeRow, emptyLedger, normalizeLedger, realisedToday, sanitizeConfigPatch, trimRows, type OrbLedger, type OrbRow,
} from './signalOrbLedger.ts';

const target = { kind: 'futures' as const, symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-17' };
const row = (extra: Partial<OrbRow> = {}): OrbRow => ({
  id: 'r1', mode: 'SIM', broker: 'dhan', target, side: 'LONG', lots: 1, units: 0, unitsPerLot: 10, entry: 6000, entryAt: 1, day: '2026-11-19', status: 'open', ...extra,
});
const withRow = (r: OrbRow): OrbLedger => ({ ...emptyLedger(), rows: [r] });

test('config: no lot cap, bounds and time order', () => {
  const cur = emptyLedger().config;
  const big = sanitizeConfigPatch({ lots: 250 }, cur);
  assert.ok(typeof big !== 'string' && big.lots === 250);
  assert.equal(typeof sanitizeConfigPatch({ lots: 0 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ lots: 1.5 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ timeframe: 2 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ entryStart: '23:10' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ entryEnd: '9:00' }, cur), 'string');
  const ok = sanitizeConfigPatch({ stopPts: 25, timeframe: 3, trailStartPts: 20, trailGapPts: 10 }, cur);
  assert.ok(typeof ok !== 'string' && ok.stopPts === 25 && ok.timeframe === 3 && ok.trailStartPts === 20 && ok.trailGapPts === 10);
  assert.equal(typeof sanitizeConfigPatch({ trailStartPts: -5 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ trailGapPts: 0 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ indicators: [{ id: 'a', kind: 'ema', period: 9 }, { id: 'a', kind: 'rsi' }] }, cur), 'string');
});

test('mode switch refused with a live row, and lands paused', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'setMode', mode: 'REAL' }, 1).ok, false);
  const r = applyClientOp({ ...emptyLedger(), engineActive: true }, { op: 'setMode', mode: 'REAL' }, 1);
  assert.ok(r.ok && r.ledger.mode === 'REAL' && r.ledger.engineActive === false);
});

test('REAL engine needs a stop; an UNKNOWN row blocks the engine', () => {
  const l = { ...emptyLedger(), mode: 'REAL' as const, config: { ...emptyLedger().config, stopPts: 0 } };
  assert.equal(applyClientOp(l, { op: 'setEngine', active: true }, 1).ok, false);
  assert.equal(applyClientOp(withRow(row({ status: 'unknown' })), { op: 'setEngine', active: true }, 1).ok, false);
  assert.ok(applyClientOp(emptyLedger(), { op: 'setEngine', active: true }, 1).ok);
});

test('symbol, instrument and strike offset: bounded, defaults keep CRUDEOILM futures ATM', () => {
  const cur = emptyLedger().config;
  assert.equal(cur.symbol, 'CRUDEOILM');
  assert.equal(cur.instrument, 'futures');
  assert.equal(cur.strikeOffset, 0);
  const ok = sanitizeConfigPatch({ symbol: 'CRUDEOIL', instrument: 'options', strikeOffset: -2 }, cur);
  assert.ok(typeof ok !== 'string' && ok.symbol === 'CRUDEOIL' && ok.instrument === 'options' && ok.strikeOffset === -2);
  assert.equal(typeof sanitizeConfigPatch({ symbol: 'GOLD' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ instrument: 'spread' }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ strikeOffset: 11 }, cur), 'string');
  assert.equal(typeof sanitizeConfigPatch({ strikeOffset: 0.5 }, cur), 'string');
  // a ledger written before these fields existed reads as the old behaviour
  const old = normalizeLedger({ config: { lots: 1, broker: 'dhan' } });
  assert.equal(old.config.symbol, 'CRUDEOILM');
  assert.equal(old.config.instrument, 'futures');
});

test('symbol, instrument, strike are pinned while a position is open; lots may change', () => {
  for (const patch of [{ symbol: 'CRUDEOIL' }, { instrument: 'options' }, { strikeOffset: 1 }]) {
    assert.equal(applyClientOp(withRow(row()), { op: 'setConfig', patch }, 1).ok, false, JSON.stringify(patch));
    assert.ok(applyClientOp(emptyLedger(), { op: 'setConfig', patch }, 1).ok);
  }
});

test('an options row is booked as a sold option', () => {
  const opt = { kind: 'options' as const, symbol: 'CRUDEOIL', name: 'CRUDEOIL', expiry: '2026-12-14', strike: 5600, side: 'PE' as const };
  const l = closeRow(withRow(row({ target: opt, side: 'LONG', entry: 80, unitsPerLot: 100, lots: 2, signalEntry: 5650 })), 'r1', 65, 'x', 2);
  assert.equal(l.rows[0].pnl, 3000);
});

test('broker is pinned while a position is open', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'setConfig', patch: { broker: 'kotak' } }, 1).ok, false);
  assert.ok(applyClientOp(emptyLedger(), { op: 'setConfig', patch: { broker: 'kotak' } }, 1).ok);
});

test('resolve an UNKNOWN row: open, failed or closed at a price', () => {
  const l = withRow(row({ status: 'unknown', mode: 'REAL' }));
  const a = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'open' }, 1);
  assert.ok(a.ok && a.ledger.rows[0].status === 'open');
  const c = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed', price: 6020 }, 1);
  assert.ok(c.ok && c.ledger.rows[0].status === 'closed' && c.ledger.rows[0].pnl === 200);
  assert.equal(applyClientOp(withRow(row({ status: 'sending' })), { op: 'resolve', id: 'r1', as: 'failed' }, 1).ok, false);
});

test('closeRow P&L and realised P&L by mode and day', () => {
  let l = withRow(row({ side: 'SHORT' }));
  l = closeRow(l, 'r1', 5990, 'x', 2);
  assert.equal(l.rows[0].pnl, 100);
  l = { ...l, rows: [...l.rows, { ...row({ id: 'r2', mode: 'REAL' }), status: 'closed', pnl: -500 }, { ...row({ id: 'r3', day: '2026-11-18' }), status: 'closed', pnl: -900 }] };
  assert.equal(realisedToday(l, 'SIM', '2026-11-19'), 100);
  assert.equal(realisedToday(l, 'REAL', '2026-11-19'), -500);
});

test('trimRows never drops a live row; normalizeLedger survives junk', () => {
  const rows = Array.from({ length: 205 }, (_, i) => row({ id: `r${i}`, status: i === 0 ? 'open' : 'closed' }));
  const t = trimRows(rows);
  assert.equal(t.length, 200);
  assert.equal(t[0].id, 'r0');
  const n = normalizeLedger({ mode: 'X', config: 'junk', rows: 'no' });
  assert.equal(n.mode, 'SIM');
  assert.deepEqual(n.rows, []);
  assert.equal(n.config.indicators.length, 2);
});

test('resetSim refuses with a SIM position open', () => {
  assert.equal(applyClientOp(withRow(row()), { op: 'resetSim' }, 1).ok, false);
  const r = applyClientOp(withRow(row({ status: 'closed' })), { op: 'resetSim' }, 1);
  assert.ok(r.ok && r.ledger.rows.length === 0);
});

test('a row stuck in flight past STUCK_MS can be resolved; a fresh one cannot', () => {
  const l = withRow(row({ status: 'sending', mode: 'REAL', entryAt: 1_000, sentAt: 1_000 }));
  assert.equal(applyClientOp(l, { op: 'resolve', id: 'r1', as: 'failed' }, 2_000).ok, false);
  const r = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'failed' }, 1_000 + 91_000);
  assert.ok(r.ok && r.ledger.rows[0].status === 'failed');
  assert.equal(applyClientOp(l, { op: 'setEngine', active: true }, 1_000 + 91_000).ok, false);
});

test('peak op ratchets in the trade\'s favour only, and only on an open row', () => {
  const up = (l: OrbLedger, price: number) => { const r = applyClientOp(l, { op: 'peak', id: 'r1', price }, 1); assert.ok(r.ok); return r.ledger; };
  let l = withRow(row({ side: 'LONG', entry: 6000 }));
  l = up(l, 6010); assert.equal(l.rows[0].bestPrice, 6010);
  l = up(l, 6005); assert.equal(l.rows[0].bestPrice, 6010);
  l = up(l, 6025); assert.equal(l.rows[0].bestPrice, 6025);
  let s = withRow(row({ side: 'SHORT' }));
  s = up(s, 5990); s = up(s, 5995); assert.equal(s.rows[0].bestPrice, 5990);
  s = up(s, 5980); assert.equal(s.rows[0].bestPrice, 5980);
  const closed = withRow(row({ status: 'closed' }));
  assert.equal(up(closed, 6100).rows[0].bestPrice, undefined);
  assert.equal(up(withRow(row()), -1).rows[0].bestPrice, undefined);
});

test('normalizeLedger keeps good config fields when one stored field is bad', () => {
  const l = normalizeLedger({ config: { lots: 5, stopPts: 45, broker: 'kotak', timeframe: 7, trailStartPts: -3 } });
  assert.equal(l.config.lots, 5);
  assert.equal(l.config.stopPts, 45);
  assert.equal(l.config.broker, 'kotak');
  assert.equal(l.config.timeframe, emptyLedger().config.timeframe);
  assert.equal(l.config.trailStartPts, emptyLedger().config.trailStartPts);
  const t = normalizeLedger({ config: { entryStart: '10:00', entryEnd: '20:00', eodExit: '21:00' } });
  assert.deepEqual([t.config.entryStart, t.config.entryEnd, t.config.eodExit], ['10:00', '20:00', '21:00']);
});

test('NIFTY: accepted, and a symbol switch brings that exchange\'s session times', () => {
  const cur = emptyLedger().config;
  const n = sanitizeConfigPatch({ symbol: 'NIFTY' }, cur);
  assert.ok(typeof n !== 'string' && n.symbol === 'NIFTY' && n.entryStart === '09:16' && n.entryEnd === '15:00' && n.eodExit === '15:17');
  const back = sanitizeConfigPatch({ symbol: 'CRUDEOILM' }, n as typeof cur);
  assert.ok(typeof back !== 'string' && back.eodExit === '23:00' && back.entryEnd === '22:45');
  // times in the same patch win
  const own = sanitizeConfigPatch({ symbol: 'NIFTY', entryStart: '09:30', entryEnd: '14:30', eodExit: '15:10' }, cur);
  assert.ok(typeof own !== 'string' && own.entryStart === '09:30' && own.eodExit === '15:10');
  // a patch that keeps the symbol leaves the user's times alone
  const same = sanitizeConfigPatch({ symbol: 'NIFTY', lots: 3 }, { ...(n as typeof cur), eodExit: '15:12' });
  assert.ok(typeof same !== 'string' && same.eodExit === '15:12');
  // stored times survive normalizeLedger
  const l = normalizeLedger({ config: { symbol: 'NIFTY', entryStart: '09:20', entryEnd: '14:00', eodExit: '15:10' } });
  assert.deepEqual([l.config.symbol, l.config.entryStart, l.config.eodExit], ['NIFTY', '09:20', '15:10']);
});

test('symbol switch: brings the stop / trail of that symbol and clears the old symbol\'s watermark and stop-out block', () => {
  const cur = emptyLedger().config;
  const n = sanitizeConfigPatch({ symbol: 'NIFTY' }, cur);
  assert.ok(typeof n !== 'string' && n.stopPts === 40 && n.trailStartPts === 25 && n.trailGapPts === 15);
  const keep = sanitizeConfigPatch({ symbol: 'NIFTY', stopPts: 55 }, cur);
  assert.ok(typeof keep !== 'string' && keep.stopPts === 55);
  const l: OrbLedger = { ...emptyLedger(), watermarkT: 1_700_000_000, blockedSide: 'LONG' };
  const r = applyClientOp(l, { op: 'setConfig', patch: { symbol: 'NIFTY' } }, 1);
  assert.ok(r.ok && r.ledger.watermarkT === 0 && r.ledger.blockedSide === null && r.ledger.config.symbol === 'NIFTY');
  const same = applyClientOp(l, { op: 'setConfig', patch: { lots: 3 } }, 1);
  assert.ok(same.ok && same.ledger.watermarkT === 1_700_000_000 && same.ledger.blockedSide === 'LONG');
});

test('normalizeLedger: a stored NIFTY config keeps its own stop and trail (the symbol is applied first)', () => {
  const l = normalizeLedger({ config: { stopPts: 55, trailStartPts: 12, trailGapPts: 6, symbol: 'NIFTY' } });
  assert.deepEqual([l.config.symbol, l.config.stopPts, l.config.trailStartPts, l.config.trailGapPts], ['NIFTY', 55, 12, 6]);
});

test('live edits are strict: bad indicator values are refused, REAL keeps its stop, cutoff stays inside the session', () => {
  const l = emptyLedger();
  const ec = (fast: number, slow: number) => applyClientOp(l, { op: 'setConfig', patch: { indicators: [{ id: 'x-1', kind: 'emaCross', fast, slow }] } }, 1);
  assert.equal(ec(30, 20).ok, false);
  assert.equal(ec(9, 21).ok, true);
  const rsi = (upper: number, lower: number) => applyClientOp(l, { op: 'setConfig', patch: { indicators: [{ id: 'r-1', kind: 'rsi', period: 14, upper, lower }] } }, 1);
  assert.equal(rsi(40, 30).ok, false);   // bull level below 50
  assert.equal(rsi(55, 45).ok, true);
  const real: OrbLedger = { ...emptyLedger(), mode: 'REAL' };
  assert.equal(applyClientOp(real, { op: 'setConfig', patch: { stopPts: 0 } }, 1).ok, false);
  assert.equal(applyClientOp(real, { op: 'setConfig', patch: { stopPts: 20 } }, 1).ok, true);
  assert.equal(applyClientOp(l, { op: 'setConfig', patch: { stopPts: 0 } }, 1).ok, true);   // SIM may run without
  const n = sanitizeConfigPatch({ symbol: 'NIFTY' }, l.config);
  assert.ok(typeof n !== 'string');
  assert.equal(typeof sanitizeConfigPatch({ eodExit: '23:00' }, n as typeof l.config), 'string');
  assert.equal(typeof sanitizeConfigPatch({ eodExit: '15:25' }, n as typeof l.config), 'object');
});

import { closeRowLegs, rowInstrument } from './signalOrbLedger.ts';
import { rowLegsPnl } from './signalOrb.ts';

const cePE = (strike = 25800) => ({
  ce: { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24', strike, side: 'CE' as const },
  pe: { kind: 'options' as const, symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24', strike, side: 'PE' as const },
});
const synRow = (extra: Partial<OrbRow> = {}): OrbRow => {
  const { ce, pe } = cePE();
  return {
    ...row(), id: 's1', unitsPerLot: 65, lots: 2, structure: 'synthetic', target: ce, entry: 100,
    legs: [{ target: ce, action: 'BUY', entry: 100, units: 130, status: 'open' }, { target: pe, action: 'SELL', entry: 90, units: 130, status: 'open' }],
    ...extra,
  };
};

test('rowLegsPnl: a synthetic gains on the bought leg rising and the sold leg falling; any leg without a mark makes it unknown', () => {
  const r = synRow();
  assert.equal(rowLegsPnl({ lots: r.lots, unitsPerLot: r.unitsPerLot, legs: r.legs! }, [110, 80]), (10 + 10) * 2 * 65);
  assert.equal(rowLegsPnl({ lots: r.lots, unitsPerLot: r.unitsPerLot, legs: r.legs! }, [90, 100]), (-10 - 10) * 2 * 65);
  assert.equal(rowLegsPnl({ lots: r.lots, unitsPerLot: r.unitsPerLot, legs: r.legs! }, [110, null]), null);
});

test('closeRowLegs books each leg at its exit; a leg without one is booked at entry; closed legs keep their exit', () => {
  const l = withRow(synRow());
  const c = closeRowLegs(l, 's1', [112, 85], 'Cutoff', 5);
  const r = c.rows[0];
  assert.equal(r.status, 'closed');
  assert.deepEqual(r.legs!.map(g => [g.status, g.exit]), [['closed', 112], ['closed', 85]]);
  assert.equal(r.pnl, (12 + 5) * 2 * 65);
  const half = synRow({ legs: synRow().legs!.map((g, i) => (i === 1 ? { ...g, status: 'closed' as const, exit: 70 } : g)) });
  const c2 = closeRowLegs(withRow(half), 's1', [105, 999], 'x', 5).rows[0];
  assert.deepEqual(c2.legs!.map(g => g.exit), [105, 70]);             // the earlier close stands
  const c3 = closeRowLegs(l, 's1', [null, null], 'x', 5).rows[0];
  assert.equal(c3.pnl, 0);                                             // no price anywhere: booked at entry, no P&L
});

test('synthetic: a row knows its instrument; Dhan only; the instrument is pinned while a position is open; resolve closed books at entry', () => {
  assert.equal(rowInstrument(synRow()), 'synthetic');
  assert.equal(rowInstrument(row({ target: cePE().pe })), 'options');
  assert.equal(rowInstrument(row()), 'futures');
  const cur = emptyLedger().config;
  const ok = sanitizeConfigPatch({ instrument: 'synthetic' }, cur);
  assert.ok(typeof ok !== 'string' && ok.instrument === 'synthetic');
  assert.equal(typeof sanitizeConfigPatch({ instrument: 'synthetic', broker: 'kotak' }, cur), 'string');
  const syn = { ...cur, instrument: 'synthetic' as const };
  assert.equal(typeof sanitizeConfigPatch({ broker: 'zerodha' }, syn), 'string');
  assert.equal(applyClientOp(withRow(synRow()), { op: 'setConfig', patch: { instrument: 'options' } }, 1).ok, false);
  const r = applyClientOp(withRow(synRow({ status: 'unknown' })), { op: 'resolve', id: 's1', as: 'closed' }, 1);
  assert.ok(r.ok && r.ledger.rows[0].status === 'closed' && r.ledger.rows[0].pnl === 0);
  // legacy rows without legs load unchanged
  const l = normalizeLedger({ rows: [row()] });
  assert.equal(l.rows[0].legs, undefined);
});
