import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { EMPTY_LEDGER, applyAutoOp, type AutoLedger, type AutoOp } from '../lib/pnfAutoLedger';

// P&F AUTO (strategies/pnf_auto/strategy.md): a double-bottom SELL that closes AFTER arming is entered once, the first X
// column after it exits. Everything is mocked in the browser — the ledger with the real applyAutoOp, the order route as a
// recorder — so no file is written and no order can leave. The page clock is pinned to an NSE trading morning.

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 30, hh, mm, ss) - 5.5 * 3600_000;   // Fri 30 Oct 2026, ms
type Body = { mode?: string; broker?: string; action?: string; lots?: number; source?: string; close?: boolean; exitOwn?: { side: string; units: number[] }; target?: { kind: string } };

async function install(page: Page, opts: { reply?: (b: Body) => Record<string, unknown> } = {}) {
  const orders: Body[] = [];
  const state = { ledger: EMPTY_LEDGER as AutoLedger, tick: { ltp: 99.3, at: ist(10, 30, 10) } };
  // 10:27 100.0, 10:28 99.5 (O column), 10:29 100.0 (X column): the 10:30 bar at 99.3 breaks the O low → double-bottom SELL.
  const bars = [100, 99.5, 100].map((p, i) => ({ t: ist(10, 27 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }));
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf/contracts') return json(route, { success: true, expiries: ['2026-11-24'] });
    if (p === '/api/straddle-pnf' && method === 'GET') {
      const fut = u.searchParams.get('mode') === 'contract';
      return json(route, {
        success: true, atm: 0, strikes: [0], name: fut ? 'NIFTY NOV FUT' : 'Nifty 50', errors: {}, dataDate: '2026-10-30',
        instruments: [{ segment: fut ? 'NSE_FNO' : 'IDX_I', security_id: fut ? '54321' : '13' }], bars: { 0: bars },
      });
    }
    if (p === '/api/straddle-pnf/live') {
      return json(route, { success: true, legs: [{ quote: { ltp: state.tick.ltp, changedMs: state.tick.at, volume: 100, prevClose: 99 }, last: null }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65 }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const b = req.postDataJSON() as Body;
      orders.push(b);
      if (opts.reply) return json(route, opts.reply(b));
      const side = b.exitOwn ? b.exitOwn.side : b.action;
      return json(route, { success: true, outcome: 'placed', message: 'Sent.', legs: [{ label: 'NIFTY NOV FUT', side, qty: b.exitOwn ? b.exitOwn.units[0] : (b.lots ?? 1) * 65, product: 'INTRADAY', status: 'placed', orderId: 'O1' }] });
    }
    if (p === '/api/straddle-pnf/auto') {
      if (method === 'GET') return json(route, { success: true, ledger: state.ledger });
      const r = applyAutoOp(state.ledger, req.postDataJSON() as AutoOp);
      if (!r.ok) return json(route, { success: false, error: r.error, ledger: state.ledger }, r.status);
      state.ledger = r.ledger;
      return json(route, { success: true, ledger: state.ledger });
    }
    if (p.endsWith('/funds')) return json(route, { success: true, data: { availabelBalance: 100000 } });
    if (p === '/api/scalper/poll') return json(route, { positions: [], positionsError: null });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: `unmocked ${method} ${p}` });
  });
  return { orders, state };
}

/** Chart 1 on the NIFTY future, then wait for the forming 10:30 bar to be on screen. */
async function openFuture(page: Page) {
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.30');
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('PAPER: arms on chart 1, enters SELL on the double bottom that closes after arming, exits on the first X column', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  // The instrument is locked while armed
  await expect(page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' })).toBeDisabled();

  // 10:31: the 10:30 bar has closed with the double bottom → one PAPER SELL of 1 lot
  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => orders.length, { timeout: 15_000 }).toBe(1);
  expect(orders[0]).toMatchObject({ mode: 'PAPER', action: 'SELL', lots: 1, source: 'auto', target: { kind: 'futures' } });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L @ 99.30');
  await page.waitForTimeout(2500);
  expect(orders.length, 'the same signal is never entered twice').toBe(1);

  // 10:31 prints 100.0 (7 boxes up: an X column); once it closes the short exits on the reversal
  state.tick = { ltp: 100, at: ist(10, 31, 20) };
  await page.clock.setFixedTime(ist(10, 32, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('closed');
  expect(state.ledger.rows[0]).toMatchObject({ reason: 'reversal', side: 'SELL', exitPrice: 100 });
  expect(Math.round(state.ledger.rows[0].pnl!)).toBe(-46);                      // (99.3 - 100) x 65
  expect(orders.length, 'a paper exit sends nothing').toBe(1);
  await expect(page.getByTestId('pnf-auto-status-1')).not.toContainText('SHORT');

  // The AUTO tab in the bottom strip lists it
  await page.getByTestId('pnf-books').getByRole('tab', { name: /AUTO/ }).click();
  await expect(page.getByTestId('pnf-books').locator('tbody tr').first()).toContainText('reversal');
});

test('REAL: arming takes a second click; entry is reserved then confirmed; the exit sends exitOwn with AUTO\'s own units', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'false');                    // first click only asks
  await expect(auto).toContainText('ARM REAL AUTO?');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');

  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('open');
  expect(orders[0]).toMatchObject({ mode: 'REAL', action: 'SELL', lots: 1, source: 'auto' });
  expect(state.ledger.rows[0].legs[0]).toMatchObject({ key: '54321', units: 65 });

  state.tick = { ltp: 100, at: ist(10, 31, 20) };
  await page.clock.setFixedTime(ist(10, 32, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('closed');
  expect(orders[1]).toMatchObject({ mode: 'REAL', source: 'auto', exitOwn: { side: 'BUY', units: [65] } });
  expect(orders[1].close, 'never the whole-position close').toBeUndefined();
  expect(orders[1].lots).toBeUndefined();
});

test('REAL: an unknown entry outcome halts the chart, is never resent, and waits for the user', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page, { reply: () => ({ success: false, outcome: 'unknown', message: 'Status unknown' }) });
  await openFuture(page);
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('unknownEntry');
  await expect(auto).toHaveAttribute('data-armed', 'false');                    // halted
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('UNRESOLVED');
  await page.waitForTimeout(3000);
  expect(orders.length).toBe(1);
  // The user checks the broker: nothing was opened
  await auto.getByRole('button', { name: 'Is flat' }).click();
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
});

test('no AUTO on an index chart', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await expect(page.getByTestId('pnf-auto-1').getByRole('button', { name: 'Start AUTO on chart 1' })).toBeDisabled();
});
