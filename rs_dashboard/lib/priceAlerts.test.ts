import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionMet, stepAlert, expiryReason, alertOrderQty, sessionOpen, tradeBlock, parseAlertInput, appendLog, alertCorrelationId,
  sessionCloseMs, unarmedTradeAlerts, unarmedTradeMarkets, alertActionQty, alertBroker, kotakAlertQty, kotakLotMismatch, tradeLine, EVERY_COOLDOWN_MS, MAX_ALERT_LOTS, MAX_LOG, type PriceAlert, type AlertEvent, type AlertMemory,
} from './priceAlerts.ts';

// 2026-11-26 is a Thursday. IST = UTC + 5:30.
const ist = (hh: number, mm: number, day = '2026-11-26') => Date.parse(`${day}T00:00:00Z`) + ((hh * 60 + mm) - 330) * 60_000;

test('conditions: crossings need a previous price; Greater/Less Than are states', () => {
  assert.equal(conditionMet('crossUp', 100, null, 105), false);
  assert.equal(conditionMet('crossUp', 100, 99, 100), true);
  assert.equal(conditionMet('crossUp', 100, 100, 101), false);       // already at the level: not a new crossing
  assert.equal(conditionMet('crossUp', 100, 101, 99), false);
  assert.equal(conditionMet('crossDown', 100, 101, 100), true);
  assert.equal(conditionMet('crossDown', 100, 99, 101), false);
  assert.equal(conditionMet('cross', 100, 99, 101), true);
  assert.equal(conditionMet('cross', 100, 101, 99), true);
  assert.equal(conditionMet('cross', 100, 101, 102), false);
  assert.equal(conditionMet('gt', 100, null, 100.5), true);
  assert.equal(conditionMet('gt', 100, null, 100), false);
  assert.equal(conditionMet('lt', 100, null, 99), true);
});

test('first sample is a baseline: a crossing alert never fires on it', () => {
  const a = { condition: 'crossUp' as const, value: 100, trigger: 'once' as const };
  const r1 = stepAlert(a, undefined, 150, 1000);
  assert.equal(r1.fire, false);
  const r2 = stepAlert(a, r1.mem, 90, 2000);
  assert.equal(r2.fire, false);
  const r3 = stepAlert(a, r2.mem, 100, 3000);
  assert.equal(r3.fire, true);
});

test('every time: Greater Than re-arms only after the condition went false, and waits out the cooldown', () => {
  const a = { condition: 'gt' as const, value: 100, trigger: 'every' as const };
  let mem: AlertMemory | undefined;
  let r = stepAlert(a, mem, 101, 0); assert.equal(r.fire, true); mem = r.mem;
  r = stepAlert(a, mem, 102, 20_000); assert.equal(r.fire, false, 'still above: no repeat'); mem = r.mem;
  r = stepAlert(a, mem, 99, 21_000); assert.equal(r.fire, false); mem = r.mem;
  r = stepAlert(a, mem, 101, 22_000); assert.equal(r.fire, true, 're-armed after dipping below'); mem = r.mem;
  r = stepAlert(a, mem, 99, 23_000); mem = r.mem;
  r = stepAlert(a, mem, 101, 24_000); assert.equal(r.fire, false, 'inside the cooldown'); mem = r.mem;
  r = stepAlert(a, mem, 99, 22_000 + EVERY_COOLDOWN_MS); mem = r.mem;
  r = stepAlert(a, mem, 101, 22_000 + EVERY_COOLDOWN_MS + 1); assert.equal(r.fire, true);
});

test('every time crossing: a price hovering on the level fires at most once per cooldown', () => {
  const a = { condition: 'cross' as const, value: 100, trigger: 'every' as const };
  let mem = stepAlert(a, undefined, 99, 0).mem;
  let r = stepAlert(a, mem, 101, 1000); assert.equal(r.fire, true); mem = r.mem;
  r = stepAlert(a, mem, 99, 2000); assert.equal(r.fire, false); mem = r.mem;
  r = stepAlert(a, mem, 101, 3000); assert.equal(r.fire, false); mem = r.mem;
  r = stepAlert(a, mem, 99, 1000 + EVERY_COOLDOWN_MS); assert.equal(r.fire, true);
});

const base = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'abc123', createdAt: 0, updatedAt: 0,
  instrument: { kind: 'index', segment: 'IDX_I', securityId: '13', displayName: 'NIFTY', underlying: 'NIFTY', expiry: null, lot: 1 },
  condition: 'crossUp', value: 24000, trigger: 'once', expiresAt: null, soundSec: 3, message: '',
  action: {
    kind: 'trade', side: 'BUY', lots: 2, product: 'INTRADAY',
    contract: { kind: 'option', segment: 'NSE_FNO', securityId: '555', displayName: 'NIFTY 24000 CE', underlying: 'NIFTY', expiry: '2026-12-01', lot: 65 },
  },
  status: 'active', firedCount: 0, lastFiredAt: null, lastFiredPrice: null, ...over,
});

test('expiry: own expiry time, and an expired watched or traded contract', () => {
  assert.equal(expiryReason(base(), ist(10, 0)), null);
  assert.equal(expiryReason(base({ expiresAt: ist(9, 0) }), ist(10, 0)), 'Alert expired');
  assert.match(String(expiryReason(base(), ist(10, 0, '2026-12-02'))), /NIFTY 24000 CE expired/);
  assert.equal(expiryReason(base(), ist(23, 0, '2026-12-01')), null, 'still live on its expiry day');
});

test('order quantity: NSE units = lots x lot, MCX = lots, out-of-range lots refused', () => {
  assert.equal(alertOrderQty({ segment: 'NSE_FNO', lot: 65 }, 2), 130);
  assert.equal(alertOrderQty({ segment: 'MCX_COMM', lot: 10 }, 3), 3);
  assert.equal(alertOrderQty({ segment: 'NSE_FNO', lot: 65 }, MAX_ALERT_LOTS + 1), 0);
  assert.equal(alertOrderQty({ segment: 'NSE_FNO', lot: 0 }, 1), 0);
  assert.equal(alertOrderQty({ segment: 'NSE_FNO', lot: 65 }, 1.5), 0);
});

test('sessions: NSE 09:15-15:30 on trading days, MCX evening', () => {
  assert.equal(sessionOpen('NSE_FNO', ist(9, 14)), false);
  assert.equal(sessionOpen('NSE_FNO', ist(9, 15)), true);
  assert.equal(sessionOpen('NSE_FNO', ist(15, 30)), false);
  assert.equal(sessionOpen('NSE_FNO', ist(11, 0, '2026-11-28')), false, 'Saturday');
  assert.equal(sessionOpen('MCX_COMM', ist(21, 0)), true);
  assert.equal(sessionOpen('MCX_COMM', ist(8, 0)), false);
});

test('trade block: not armed, closed market, expired contract', () => {
  const now = ist(10, 0);
  assert.match(String(tradeBlock({ armedOn: null }, base(), now)), /not armed/);
  assert.match(String(tradeBlock({ armedOn: '2026-11-25' }, base(), now)), /not armed/, 'yesterday\'s arm does not count');
  assert.equal(tradeBlock({ armedOn: '2026-11-26' }, base(), now), null);
  assert.match(String(tradeBlock({ armedOn: '2026-11-26' }, base(), ist(16, 0))), /closed/);
});

test('input: trade alerts are forced to once only, and indices cannot be traded', () => {
  const now = 1_000;
  const ok = parseAlertInput({
    instrument: { kind: 'index', symbol: 'nifty' }, condition: 'crossUp', value: 24000, trigger: 'every',
    action: { kind: 'trade', contract: { kind: 'option', underlying: 'NIFTY', expiry: '2026-12-01', strike: 24000, optType: 'CE' }, side: 'BUY', lots: 1 },
  }, now);
  assert.ok(typeof ok !== 'string');
  assert.equal(ok.trigger, 'once');
  assert.equal(ok.soundSec, 3);
  assert.deepEqual(ok.instrument, { kind: 'index', symbol: 'NIFTY' });
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: 1,
    action: { kind: 'trade', contract: { kind: 'index', symbol: 'NIFTY' }, side: 'BUY', lots: 1 } }, now)), /cannot be traded/);
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: 1,
    action: { kind: 'trade', contract: { kind: 'future', underlying: 'NIFTY', expiry: '2026-12-30' }, side: 'BUY', lots: 11 } }, now)), /Lots/);
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'bad', value: 1 }, now)), /condition/);
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: -1 }, now)), /Value/);
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: 1, soundSec: 0 }, now)), /Sound/);
  assert.match(String(parseAlertInput({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: 1, expiresAt: 500 }, now)), /future/);
});

test('log is capped, correlation ids are Dhan-valid', () => {
  const ev = (i: number) => ({ id: String(i) }) as AlertEvent;
  const log = appendLog(Array.from({ length: MAX_LOG }, (_, i) => ev(i)), [ev(MAX_LOG)]);
  assert.equal(log.length, MAX_LOG);
  assert.equal(log.at(-1)?.id, String(MAX_LOG));
  const cid = alertCorrelationId('lx9a2-Zq81', Date.now());
  assert.match(cid, /^pa[a-z0-9]{6,23}$/);
});

test('only NIFTY, CRUDEOIL and CRUDEOILM; only NIFTY has an index', () => {
  const base = { condition: 'gt', value: 1 };
  assert.match(String(parseAlertInput({ ...base, instrument: { kind: 'index', symbol: 'BANKNIFTY' } }, 0)), /no index alert/);
  assert.match(String(parseAlertInput({ ...base, instrument: { kind: 'index', symbol: 'CRUDEOILM' } }, 0)), /no index alert/);
  assert.match(String(parseAlertInput({ ...base, instrument: { kind: 'future', underlying: 'BANKNIFTY', expiry: '2026-12-30' } }, 0)), /only for NIFTY, CRUDEOIL, CRUDEOILM/);
  assert.ok(typeof parseAlertInput({ ...base, instrument: { kind: 'future', underlying: 'crudeoilm', expiry: '2026-12-17' } }, 0) !== 'string');
  assert.ok(typeof parseAlertInput({ ...base, instrument: { kind: 'option', underlying: 'CRUDEOIL', expiry: '2026-12-16', strike: 5600, optType: 'PE' } }, 0) !== 'string');
});

test('expire-at-date means that day\'s session close: NSE 15:30, MCX 23:30 / 23:55 IST', () => {
  assert.equal(sessionCloseMs('NIFTY', '2026-12-01'), ist(15, 30, '2026-12-01'));
  assert.equal(sessionCloseMs('CRUDEOILM', '2026-12-16'), ist(23, 55, '2026-12-16'));   // US winter time
  assert.equal(sessionCloseMs('CRUDEOIL', '2026-06-16'), ist(23, 30, '2026-06-16'));    // US summer time
});

test('trade alerts: Greater Than already true on the first price does NOT trade; it must go false and come back', () => {
  const a = { condition: 'gt' as const, value: 100, trigger: 'once' as const };
  const r1 = stepAlert(a, undefined, 105, 0, true);
  assert.equal(r1.fire, false, 'already above at creation / restart: no order');
  const r2 = stepAlert(a, r1.mem, 106, 500, true);
  assert.equal(r2.fire, false, 'still above');
  const r3 = stepAlert(a, r2.mem, 99, 1000, true);
  const r4 = stepAlert(a, r3.mem, 101, 1500, true);
  assert.equal(r4.fire, true, 'moved back above: trades');
  assert.equal(stepAlert(a, undefined, 105, 0).fire, true, 'a notify alert still fires on the level at once (TradingView)');
  const b = stepAlert(a, undefined, 95, 0, true);
  assert.equal(stepAlert(a, b.mem, 101, 500, true).fire, true, 'below at creation, then above: trades');
});

test('trade block: MIS refused from the intraday cutoff (NSE 15:17, MCX auto-exit); NRML is not', () => {
  const armed = { armedOn: '2026-11-26' };
  assert.equal(tradeBlock(armed, base(), ist(15, 16)), null);
  assert.match(String(tradeBlock(armed, base(), ist(15, 17))), /15:17 intraday \(MIS\) cutoff/);
  const nrml = base({ action: { ...(base().action as Extract<PriceAlert['action'], { kind: 'trade' }>), product: 'MARGIN' } });
  assert.equal(tradeBlock(armed, nrml, ist(15, 20)), null);
  assert.match(String(tradeBlock(armed, base(), ist(15, 0), { nse: 1500 })), /15:00/);
  const mcx = base({ action: { kind: 'trade', side: 'BUY', lots: 1, product: 'INTRADAY',
    contract: { kind: 'future', segment: 'MCX_COMM', securityId: '1', displayName: 'CRUDEOILM FUT', underlying: 'CRUDEOILM', expiry: '2026-12-18', lot: 10 } } });
  assert.equal(tradeBlock(armed, mcx, ist(23, 0)), null);
  assert.match(String(tradeBlock(armed, mcx, ist(23, 40))), /23:40/);         // US winter: auto-exit 23:40
  assert.match(String(tradeBlock(armed, mcx, ist(23, 20), { mcx: 2315 })), /23:15/);
});

test('unarmed trade markets: open markets with an active trade alert that would be skipped only for want of arming', () => {
  const nse = base();
  const mcx = base({ id: 'mcx1', action: { kind: 'trade', side: 'SELL', lots: 1, product: 'INTRADAY',
    contract: { kind: 'future', segment: 'MCX_COMM', securityId: '9', displayName: 'CRUDEOILM DEC FUT', underlying: 'CRUDEOILM', expiry: '2026-12-17', lot: 10 } } });
  const notify = base({ id: 'n1', action: { kind: 'notify' } });
  const at = (alerts: PriceAlert[], armedToday = false) => ({ alerts, armedToday });
  assert.deepEqual(unarmedTradeMarkets(at([nse, mcx]), ist(10, 0)), ['NSE', 'MCX']);
  assert.deepEqual(unarmedTradeMarkets(at([nse, mcx], true), ist(10, 0)), [], 'armed: nothing to remind');
  assert.deepEqual(unarmedTradeMarkets(at([nse]), ist(9, 10)), [], 'NSE not open yet');
  assert.deepEqual(unarmedTradeMarkets(at([nse, mcx]), ist(21, 0)), ['MCX'], 'evening: MCX only');
  assert.deepEqual(unarmedTradeMarkets(at([notify]), ist(10, 0)), [], 'notify-only alerts never place orders');
  assert.deepEqual(unarmedTradeMarkets(at([base({ status: 'paused' }), base({ status: 'triggered' })]), ist(10, 0)), []);
  assert.deepEqual(unarmedTradeMarkets(at([nse]), ist(10, 0, '2026-12-02')), [], 'expired contract');
  // the reminder's count: only alerts whose order arming would send now (evening: the NSE alert is not counted)
  assert.deepEqual(unarmedTradeAlerts(at([nse, mcx, notify]), ist(21, 0)).map(a => a.id), ['mcx1']);
  assert.deepEqual(unarmedTradeAlerts(at([nse, mcx, notify]), ist(10, 0)).map(a => a.id), ['abc123', 'mcx1']);
  assert.deepEqual(unarmedTradeAlerts(at([nse, mcx], true), ist(10, 0)), []);
});

// ── Kotak trade alerts ──

const kotakAlert = (over: Partial<Extract<PriceAlert['action'], { kind: 'trade' }>> = {}, alertOver: Partial<PriceAlert> = {}): PriceAlert => {
  const b = base(alertOver);
  if (b.action.kind !== 'trade') throw new Error('trade base');
  return { ...b, action: { ...b.action, broker: 'kotak', kotak: { tradingSymbol: 'NIFTY26D0124000CE', lotSize: 65, segment: 'nse_fo' }, ...over } };
};
const crude = { kind: 'future' as const, segment: 'MCX_COMM' as const, securityId: '777', displayName: 'CRUDEOILM FUT', underlying: 'CRUDEOILM', expiry: '2026-12-17', lot: 1 };

test('broker: an alert saved before Kotak was offered is Dhan; tradeLine names the broker', () => {
  const b = base();
  if (b.action.kind !== 'trade') throw new Error('trade base');
  assert.equal(alertBroker(b.action), 'dhan');
  assert.match(String(tradeLine(b.action)), /on Dhan$/);
  assert.match(String(tradeLine(kotakAlert().action)), /on Kotak$/);
});

test('Kotak quantity: lots x Kotak lot (NSE units, MCX barrels), never the Dhan lot count', () => {
  assert.equal(kotakAlertQty({ lotSize: 65 }, 2), 130);
  assert.equal(kotakAlertQty({ lotSize: 10 }, 3), 30, 'CRUDEOILM: 3 lots = 30 barrels on Kotak');
  assert.equal(kotakAlertQty({ lotSize: 100 }, 1), 100);
  assert.equal(kotakAlertQty({ lotSize: 65 }, MAX_ALERT_LOTS + 1), 0);
  assert.equal(kotakAlertQty(undefined, 1), 0, 'no Kotak contract = refuse');
  const a = kotakAlert({ contract: crude, lots: 3, product: 'MARGIN', kotak: { tradingSymbol: 'CRUDEOILM17DEC26FUT', lotSize: 10, segment: 'mcx_fo' } });
  if (a.action.kind !== 'trade') throw new Error('trade');
  assert.equal(alertActionQty(a.action), 30);
  const d = base({ action: { ...a.action, broker: 'dhan' } });
  if (d.action.kind !== 'trade') throw new Error('trade');
  assert.equal(alertActionQty(d.action), 3, 'Dhan MCX quantity stays in lots');
});

test('Kotak lot check: NSE lot must match the master list, MCX lot must be the barrels per lot', () => {
  const nifty = { segment: 'NSE_FNO' as const, lot: 65, underlying: 'NIFTY', displayName: 'NIFTY 24000 CE' };
  assert.equal(kotakLotMismatch(nifty, 65), null);
  assert.match(String(kotakLotMismatch(nifty, 75)), /is 75, expected 65/);
  assert.equal(kotakLotMismatch({ ...crude }, 10), null);
  assert.match(String(kotakLotMismatch({ ...crude }, 1)), /expected 10 barrels/);
  assert.equal(kotakLotMismatch({ ...crude, underlying: 'CRUDEOIL' }, 100), null);
  assert.match(String(kotakLotMismatch(nifty, 0)), /no lot size/);
});

test('Kotak trade block: crude MIS refused, missing contract refused, NSE MIS allowed', () => {
  const now = ist(10, 0);
  const armed = { armedOn: '2026-11-26' };
  assert.equal(tradeBlock(armed, kotakAlert(), now), null);
  assert.match(String(tradeBlock(armed, kotakAlert({ kotak: undefined }), now)), /No Kotak contract/);
  const mcxNow = ist(19, 0);
  const mis = kotakAlert({ contract: crude, product: 'INTRADAY', kotak: { tradingSymbol: 'CRUDEOILM17DEC26FUT', lotSize: 10, segment: 'mcx_fo' } });
  assert.match(String(tradeBlock(armed, mis, mcxNow)), /NRML only/);
  const nrml = kotakAlert({ contract: crude, product: 'MARGIN', kotak: { tradingSymbol: 'CRUDEOILM17DEC26FUT', lotSize: 10, segment: 'mcx_fo' } });
  assert.equal(tradeBlock(armed, nrml, mcxNow), null);
});

test('input: broker defaults to Dhan, Kotak crude MIS refused, unknown broker refused', () => {
  const body = (action: Record<string, unknown>) => ({ instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'gt', value: 1, action });
  const opt = { kind: 'option', underlying: 'NIFTY', expiry: '2026-12-01', strike: 24000, optType: 'CE' };
  const fut = { kind: 'future', underlying: 'CRUDEOILM', expiry: '2026-12-17' };
  const d = parseAlertInput(body({ kind: 'trade', contract: opt, side: 'BUY', lots: 1 }), 0);
  assert.ok(typeof d !== 'string' && d.action.kind === 'trade' && d.action.broker === 'dhan');
  const k = parseAlertInput(body({ kind: 'trade', contract: opt, side: 'SELL', lots: 2, broker: 'kotak' }), 0);
  assert.ok(typeof k !== 'string' && k.action.kind === 'trade' && k.action.broker === 'kotak');
  assert.match(String(parseAlertInput(body({ kind: 'trade', contract: fut, side: 'BUY', lots: 1, broker: 'kotak' }), 0)), /NRML only/);
  const kn = parseAlertInput(body({ kind: 'trade', contract: fut, side: 'BUY', lots: 1, broker: 'kotak', product: 'MARGIN' }), 0);
  assert.ok(typeof kn !== 'string');
  assert.ok(typeof parseAlertInput(body({ kind: 'trade', contract: fut, side: 'BUY', lots: 1, broker: 'dhan' }), 0) !== 'string', 'Dhan crude MIS unchanged');
  assert.match(String(parseAlertInput(body({ kind: 'trade', contract: opt, side: 'BUY', lots: 1, broker: 'zerodha' }), 0)), /Dhan or Kotak/);
});
