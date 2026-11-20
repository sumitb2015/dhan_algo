import test from 'node:test';
import assert from 'node:assert/strict';
import { ORPHAN_NOTE, applyClientOp, emptyLedger, entryBlock, normalizeLedger, recoverOrphans, reservedUnits, rowPnl, type GbLedger, type GbRow } from './gearboxLedger.ts';
import { reservedByGearbox } from './gearboxFile.ts';
import { targetKey } from './pnfTarget.ts';

const target = { kind: 'options' as const, symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-15', strike: 6000, side: 'CE' as const };
const row = (x: Partial<GbRow> = {}): GbRow => ({
  id: 'r1', mode: 'REAL', broker: 'dhan', underlying: 'CRUDEOILM', dir: 'LONG', leg: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' },
  target, lots: 1, units: 1, unitsPerLot: 10, entry: 100, entryDecision: 100, entryAt: 1, day: '2026-11-20', status: 'open', ...x,
});
const withRows = (rows: GbRow[], mode: 'SIM' | 'REAL' = 'SIM'): GbLedger => ({ ...emptyLedger(), mode, rows });
const cfg = (l: GbLedger, patch: object) => applyClientOp(l, { op: 'setConfig', patch }, 1);

test('normalizeLedger of junk is the empty ledger', () => {
  assert.deepEqual(normalizeLedger('x'), emptyLedger());
  assert.deepEqual(normalizeLedger(null), emptyLedger());
});

test('lots cap per mode', () => {
  assert.equal(cfg({ ...emptyLedger(), mode: 'REAL' }, { lots: 2 }).ok, false);
  const r = cfg({ ...emptyLedger(), mode: 'REAL' }, { lots: 2 });
  assert.ok(!r.ok && r.status === 400);
  const s = cfg(emptyLedger(), { lots: 11 });
  assert.ok(!s.ok && s.status === 400);
  assert.ok(cfg(emptyLedger(), { lots: 10 }).ok);
});

test('config validation', () => {
  assert.equal(cfg(emptyLedger(), { broker: 'zerodha' }).ok, false);
  const leg = { action: 'BUY', opt: 'CE', offset: 4, expiry: 'nearest' };
  assert.equal(cfg(emptyLedger(), { map: { LONG: leg } }).ok, false);
  assert.ok(cfg(emptyLedger(), { map: { LONG: { ...leg, offset: -3 } } }).ok);
  assert.equal(cfg(emptyLedger(), { slPts: 0 }).ok, false);
  assert.equal(cfg(emptyLedger(), { tgtPts: -5 }).ok, false);
  const ok = cfg(emptyLedger(), { slPts: 10, maxLoss: null });
  assert.ok(ok.ok && ok.ledger.config.slPts === 10 && ok.ledger.config.maxLoss === null);
});

test('underlying / map / broker locked while a live row exists', () => {
  const l = withRows([row({ status: 'open' })]);
  const a = cfg(l, { underlying: 'CRUDEOIL' });
  assert.ok(!a.ok && a.status === 409);
  const b = cfg(l, { map: { SHORT: { action: 'SELL', opt: 'CE', offset: 1, expiry: 'nearest' } } });
  assert.ok(!b.ok && b.status === 409);
  assert.ok(cfg(l, { slPts: 5 }).ok);
});

test('setMode: lowers lots for REAL, refused while live', () => {
  const l = cfg(emptyLedger(), { lots: 5 });
  assert.ok(l.ok);
  const r = applyClientOp(l.ok ? l.ledger : emptyLedger(), { op: 'setMode', mode: 'REAL' }, 2);
  assert.ok(r.ok && r.ledger.mode === 'REAL' && r.ledger.config.lots === 1 && r.ledger.log.length === 1);
  const refused = applyClientOp(withRows([row()]), { op: 'setMode', mode: 'REAL' }, 2);
  assert.ok(!refused.ok && refused.status === 409);
});

test('resolve moves only an unknown row', () => {
  const l = withRows([row({ status: 'unknown' }), row({ id: 'r2', status: 'open' })]);
  const ok = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed', price: 105 }, 5);
  assert.ok(ok.ok && ok.ledger.rows[0].status === 'closed' && ok.ledger.rows[0].exit === 105);
  const no = applyClientOp(l, { op: 'resolve', id: 'r2', as: 'failed' }, 5);
  assert.ok(!no.ok && no.status === 409);
  assert.equal(applyClientOp(l, { op: 'resolve', id: 'r1', as: 'closed' }, 5).ok, false);
});

test('rowPnl signs by leg action', () => {
  assert.equal(rowPnl(row(), 110), 100);
  assert.equal(rowPnl(row({ leg: { action: 'SELL', opt: 'CE', offset: 0, expiry: 'nearest' } }), 110), -100);
  assert.equal(rowPnl(row({ status: 'closed', exit: 90 }), 200), -100);
  assert.equal(rowPnl(row(), null), null);
  assert.equal(rowPnl(row({ units: 7 }), 110), 100); // units (broker order units) never affect P&L
});

test('entryBlock on max loss and max trades', () => {
  const closed = row({ status: 'closed', exit: 90, mode: 'SIM' }); // -100
  const base = withRows([closed]);
  assert.equal(entryBlock(base, '2026-11-20'), null);
  const ml = { ...base, config: { ...base.config, maxLoss: 100 } };
  assert.match(entryBlock(ml, '2026-11-20') ?? '', /max loss/i);
  assert.equal(entryBlock(ml, '2026-11-21'), null);
  const mt = { ...base, config: { ...base.config, maxTrades: 1 } };
  assert.match(entryBlock(mt, '2026-11-20') ?? '', /trades/i);
});

test('reservedUnits sums only live REAL rows of the key', () => {
  const k = targetKey(target);
  const other = { ...target, strike: 6100 };
  const l = withRows([
    row({ id: 'a' }),
    row({ id: 'b', leg: { action: 'SELL', opt: 'CE', offset: 0, expiry: 'nearest' }, units: 4 }),
    row({ id: 'c', status: 'closed' }),
    row({ id: 'd', mode: 'SIM' }),
    row({ id: 'e', target: other }),
    row({ id: 'f', status: 'unknown', units: 20 }),
  ]);
  assert.equal(reservedUnits(l, 'dhan', k, targetKey), 1 - 4 + 20);
  assert.equal(reservedUnits(l, 'kotak', k, targetKey), 0);
});

test('resolve an unknown row as open or as failed', () => {
  const l = withRows([row({ status: 'unknown', note: 'x' })]);
  const o = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'open' }, 5);
  assert.ok(o.ok && o.ledger.rows[0].status === 'open' && o.ledger.rows[0].exit === undefined);
  const f = applyClientOp(l, { op: 'resolve', id: 'r1', as: 'failed' }, 5);
  assert.ok(f.ok && f.ledger.rows[0].status === 'failed');
  assert.equal(reservedUnits(f.ok ? f.ledger : l, 'dhan', targetKey(target), targetKey), 0);
});

test('recoverOrphans turns sending / closing rows UNKNOWN with a note; null when there are none', () => {
  assert.equal(recoverOrphans(withRows([row(), row({ id: 'u', status: 'unknown' })]), 9), null);
  const r = recoverOrphans(withRows([row({ status: 'sending' }), row({ id: 'c', status: 'closing' }), row({ id: 'o' })]), 9);
  assert.ok(r);
  assert.deepEqual(r.rows.map(x => x.status), ['unknown', 'unknown', 'open']);
  assert.equal(r.rows[0].note, ORPHAN_NOTE);
  assert.equal(r.log.length, 2);
});

test('normalizeLedger drops rows and log entries no reader could use', () => {
  const good = row();
  const l = normalizeLedger({
    rows: [good, null, 'x', { ...good, status: 'weird' }, { ...good, target: null }, { ...good, target: { kind: 'options' } },
      { ...good, lots: '1' }, { ...good, units: undefined }, { ...good, leg: null }],
    log: [{ at: 1, level: 'info', msg: 'ok' }, null, { at: 'x', level: 'info', msg: 'm' }, { at: 1, level: 'loud', msg: 'm' }],
  });
  assert.deepEqual(l.rows, [good]);
  assert.equal(l.log.length, 1);
});

test('reservedByGearbox never throws on a bad ledger: 0 and a warning', () => {
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const bad = { ...emptyLedger(), rows: [{ ...row(), target: null }] } as unknown as GbLedger;
    assert.equal(reservedByGearbox('dhan', targetKey(target), 'INTRADAY', bad), 0);
    assert.equal(warned, 1);
  } finally { console.warn = warn; }
  assert.equal(reservedByGearbox('dhan', targetKey(target), 'INTRADAY', withRows([row()])), 1);
});

// ── FUT legs and seconds bars (2026-11-20) ──

test('a FUT leg is accepted with its offset forced to 0; other opt values are refused', () => {
  const r = cfg(emptyLedger(), { map: { SHORT: { action: 'SELL', opt: 'FUT', offset: 2, expiry: 'nearest' } } });
  assert.ok(r.ok);
  assert.deepEqual(r.ledger.config.map.SHORT, { action: 'SELL', opt: 'FUT', offset: 0, expiry: 'nearest' });
  assert.equal(cfg(emptyLedger(), { map: { LONG: { action: 'BUY', opt: 'FUTURE', offset: 0, expiry: 'nearest' } } }).ok, false);
  assert.equal(cfg(emptyLedger(), { map: { LONG: { action: 'BUY', opt: 'FUT', offset: 9, expiry: 'nearest' } } }).ok, false);
});

test('tf accepts 1 / 3 / 5 min and 5 / 10 / 20 / 30 s, stored as given; anything else is refused', () => {
  for (const tf of [1, 3, 5, '5s', '10s', '20s', '30s'] as const) {
    const r = cfg(emptyLedger(), { tf });
    assert.ok(r.ok && r.ledger.config.tf === tf, String(tf));
  }
  for (const tf of [2, 10, '1s', '15s', '5', '60s', null]) assert.equal(cfg(emptyLedger(), { tf }).ok, false, String(tf));
});

test('a config saved before FUT / seconds bars loads unchanged', () => {
  const old = {
    underlying: 'CRUDEOIL', broker: 'dhan', lots: 1, tf: 3,
    map: { LONG: { action: 'SELL', opt: 'PE', offset: 1, expiry: 'nearest' }, SHORT: { action: 'BUY', opt: 'PE', offset: -2, expiry: '2026-12-16' } },
    slPts: 12, tgtPts: null, maxLoss: 2000, maxTrades: 5,
  };
  const l = normalizeLedger({ mode: 'REAL', config: old, rows: [row()] });
  assert.deepEqual(l.config, old);
  assert.equal(l.rows.length, 1);
});

test('rowPnl of a FUT SELL: 1 lot CRUDEOIL 6000 -> 5990 = +1000', () => {
  const fut = { kind: 'futures' as const, symbol: 'CRUDEOIL', name: 'CRUDEOIL', expiry: '2026-12-17' };
  const r = row({ underlying: 'CRUDEOIL', target: fut, leg: { action: 'SELL', opt: 'FUT', offset: 0, expiry: 'nearest' }, unitsPerLot: 100, entry: 6000 });
  assert.equal(rowPnl(r, 5990), 1000);
  assert.equal(rowPnl({ ...r, leg: { ...r.leg, action: 'BUY' } }, 5990), -1000);
});

test('legAgainstDir: options by side and action, FUT by action only', async () => {
  const { legAgainstDir } = await import('./gearboxLedger.ts');
  const leg = (action: 'BUY' | 'SELL', opt: 'CE' | 'PE' | 'FUT') => ({ action, opt, offset: 0, expiry: 'nearest' });
  assert.equal(legAgainstDir('LONG', leg('BUY', 'CE')), false);
  assert.equal(legAgainstDir('LONG', leg('SELL', 'CE')), true);
  assert.equal(legAgainstDir('SHORT', leg('BUY', 'CE')), true);
  assert.equal(legAgainstDir('SHORT', leg('SELL', 'PE')), true);
  // BUY FUT gains on a rise, SELL FUT on a fall: LONG flags SELL FUT, SHORT flags BUY FUT
  assert.equal(legAgainstDir('LONG', leg('BUY', 'FUT')), false);
  assert.equal(legAgainstDir('LONG', leg('SELL', 'FUT')), true);
  assert.equal(legAgainstDir('SHORT', leg('SELL', 'FUT')), false);
  assert.equal(legAgainstDir('SHORT', leg('BUY', 'FUT')), true);
});

test('gbContractLabel: a future reads FUT <symbol> <month>, an option <symbol> <strike> <side>', async () => {
  const { gbContractLabel } = await import('./gearboxLedger.ts');
  assert.equal(gbContractLabel({ kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-16' }), 'FUT CRUDEOILM DEC');
  assert.equal(gbContractLabel({ kind: 'futures', symbol: 'CRUDEOIL', name: 'CRUDEOIL' }), 'FUT CRUDEOIL');
  assert.equal(gbContractLabel(target), 'CRUDEOILM 6000 CE');
});
