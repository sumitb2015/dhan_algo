import test from 'node:test';
import assert from 'node:assert/strict';
import { chainSnapshot } from './indexScalperChain.ts';

test('REST chain becomes the bridge shape: numeric strike keys, prev-close change, prev-OI change, bridge buildup rule', () => {
  const snap = chainSnapshot({
    spot: 25349.65,
    chain: { oc: {
      '25300.000000': { ce: { last_price: 300, oi: 100, previous_close_price: 0, previous_oi: 0 }, pe: { last_price: 200, oi: 100 } },
      '25350.000000': {
        ce: { last_price: 270, oi: 577395, previous_close_price: 551.55, previous_oi: 109720 },
        pe: { last_price: 229.95, oi: 1118715, previous_close_price: 98.85, previous_oi: 262730 },
      },
    } },
  }, 'NIFTY', '2026-12-01', Date.UTC(2026, 10, 24, 5, 0));
  assert.ok(snap);
  assert.deepEqual(Object.keys(snap.strikes).sort(), ['25300', '25350']);
  assert.equal(snap.atm, 25350);
  assert.equal(snap.straddle_premium, 499.95);
  const ce = snap.strikes['25350'].ce;
  assert.equal(ce.ltp, 270);
  assert.equal(ce.change_pct!.toFixed(2), '-51.05');
  assert.equal(ce.buildup, 'SB');
  assert.equal(snap.strikes['25350'].pe.buildup, 'LB');
  // a missing / zero previous close or OI is "unknown", never a 0 % move or a label
  const far = snap.strikes['25300'].ce;
  assert.equal(far.change_pct, undefined);
  assert.equal(far.oi_chg_pct, undefined);
  assert.equal(far.buildup, undefined);
  assert.equal(snap.updated_at, '2026-11-24T05:00:00.000Z');
});

test('no spot or no strikes is no snapshot', () => {
  assert.equal(chainSnapshot({ spot: 0, chain: { oc: { '25350': {} } } }, 'NIFTY', 'x', 0), null);
  assert.equal(chainSnapshot({ spot: 25000, chain: { oc: {} } }, 'NIFTY', 'x', 0), null);
  assert.equal(chainSnapshot({}, 'NIFTY', 'x', 0), null);
});
