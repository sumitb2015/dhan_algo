import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { EMPTY_LEDGER, applyAutoOp, type AutoLedger, type AutoOp } from '../lib/pnfAutoLedger';

// Renko AUTO: an N-brick confirmation SELL (2 bricks, box 0.1) that closes after arming is entered once; the first up brick
// exits. Everything is mocked in the browser (the ledger runs the real applyAutoOp, the order route records), so nothing is
// written and no order can leave. Also proves the page uses ITS OWN ledger (?scope=renko) and tags its orders scope 'renko'.

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 30, hh, mm, ss) - 5.5 * 3600_000;   // Fri 30 Oct 2026, ms
type Body = { mode?: string; action?: string; lots?: number; source?: string; scope?: string; close?: boolean; exitOwn?: { side: string; units: number[] }; target?: { kind: string } };

async function install(page: Page, opts: { reply?: (b: Body) => Record<string, unknown> } = {}) {
  const orders: Body[] = [];
  const ledgerCalls: string[] = [];
  // 10:26 100.0, 10:27 100.3 = three up bricks (100.0-100.3). The forming 10:30 bar at 99.95 prints two down bricks
  // (100.1-100.2, 100.0-100.1): the 2nd confirms a SELL, booked at its close 100.0.
  const state = { ledger: EMPTY_LEDGER as AutoLedger, tick: { ltp: 99.95, at: ist(10, 30, 10) } };
  const bars = [100, 100.3, 100.3, 100.3].map((p, i) => ({ t: ist(10, 26 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }));
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
    if (p === '/api/straddle-pnf/auto' || p === '/api/straddle-pnf/resting') {
      ledgerCalls.push(`${method} ${p}${u.search}`);
      if (p === '/api/straddle-pnf/resting') return json(route, { success: true, ledger: { rev: 0, day: '2026-10-30', rows: [] } });
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
  return { orders, state, ledgerCalls };
}

async function openFuture(page: Page) {
  await page.goto('/renko');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.95');
}

test.beforeEach(async ({ context }) => {
  await signIn(context);
  await context.addInitScript(() => {
    const st = JSON.stringify({ interval: 1, boxMode: 'pts', boxPct: 0.1, boxPts: 0.1, reversal: 2, smaPeriod: 50 });
    try { if (!localStorage.getItem('renko-settings')) { localStorage.setItem('renko-settings', st); localStorage.setItem('renko-settings-2', st); } } catch { /* ignore */ }
  });
});

test('PAPER: a 2-brick SELL that closes after arming is entered once at the brick close; the first up brick exits', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, ledgerCalls } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');

  await page.clock.setFixedTime(ist(10, 31, 5));                       // the 10:30 bar has closed
  await expect.poll(() => orders.length, { timeout: 15_000 }).toBe(1);
  expect(orders[0]).toMatchObject({ mode: 'PAPER', action: 'SELL', lots: 1, source: 'auto', scope: 'renko', target: { kind: 'futures' } });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L @ 100.00');
  await page.waitForTimeout(2500);
  expect(orders.length, 'the same signal is never entered twice').toBe(1);

  state.tick = { ltp: 100.25, at: ist(10, 31, 20) };                    // one up brick (100.1-100.2)
  await page.clock.setFixedTime(ist(10, 32, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('closed');
  expect(state.ledger.rows[0]).toMatchObject({ reason: 'reversal', side: 'SELL' });
  expect(state.ledger.rows[0].entryPrice).toBeCloseTo(100, 6);
  expect(state.ledger.rows[0].exitPrice).toBeCloseTo(100.2, 6);
  expect(Math.round(state.ledger.rows[0].pnl!)).toBe(-13);              // (100.0 - 100.2) x 65
  expect(orders.length, 'a paper exit sends nothing').toBe(1);
  // the confirming brick is column 4 (3 up, 2 down), the exit brick column 5
  const panel1 = page.getByTestId('pnf-panel').nth(0);
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="SELL"]')).toHaveAttribute('data-col', '4');
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="BUY"]')).toHaveAttribute('data-col', '5');
  // Renko's own ledgers only: never the P&F page's files
  expect(ledgerCalls.length).toBeGreaterThan(0);
  expect(ledgerCalls.every(c => c.endsWith('?scope=renko')), ledgerCalls.join('\n')).toBe(true);
});

test('REAL: arming takes a second click; the entry is confirmed; the exit sends exitOwn with AUTO\'s own units, scope renko', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'false');
  await expect(auto).toContainText('ARM REAL AUTO?');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');

  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('open');
  expect(orders[0]).toMatchObject({ mode: 'REAL', action: 'SELL', lots: 1, source: 'auto', scope: 'renko' });
  expect(state.ledger.rows[0].entryPrice).toBe(99.95);                  // REAL books the live price
  expect(state.ledger.rows[0].entryBox).toBeCloseTo(100, 6);            // the marker stays on the brick

  state.tick = { ltp: 100.25, at: ist(10, 31, 20) };
  await page.clock.setFixedTime(ist(10, 32, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('closed');
  expect(orders[1]).toMatchObject({ mode: 'REAL', source: 'auto', scope: 'renko', exitOwn: { side: 'BUY', units: [65] } });
  expect(orders[1].close).toBeUndefined();
});

test('REAL: an unknown entry outcome halts the chart, is never resent, and waits for the user', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page, { reply: () => ({ success: false, outcome: 'unknown', message: 'Status unknown' }) });
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 15_000 }).toBe('unknownEntry');
  await expect(auto).toHaveAttribute('data-armed', 'false');
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('UNRESOLVED');
  await page.waitForTimeout(3000);
  expect(orders.length).toBe(1);
  await auto.getByRole('button', { name: 'Is flat' }).click();
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
});

test('the forming bar\'s bricks are drawn unconfirmed (dimmed) like P&F boxes, and become real bricks once the bar closes', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));                      // the 10:30 bar is still forming at 99.95
  await install(page);
  await openFuture(page);
  const panel = page.getByTestId('pnf-panel').first();
  const count = async (id: string) => ((await panel.getByTestId(id).getAttribute('d')) ?? '').split('z').length - 1;
  // confirmed: 3 up bricks (100.0-100.3); the forming 99.95 adds 2 down bricks, drawn dimmed and not counted as confirmed
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveAttribute('data-count', '2');
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveAttribute('opacity', '0.35');
  expect(await count('pnf-bricks-up')).toBe(3);
  expect(await count('pnf-bricks-down')).toBe(0);
  // 10:31: the bar has closed, so the two bricks are confirmed and nothing is left unconfirmed
  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => count('pnf-bricks-down'), { timeout: 15_000 }).toBe(2);
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveCount(0);
});
