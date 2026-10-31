import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { EMPTY_RESTING, applyRestingOp, type RestingLedger, type RestingOp } from '../lib/pnfRestingLedger';

// The ladder-style B / S rail on a P&F chart: click a box row to rest a LIMIT / SL-limit, × cancels, PAPER fills when the
// live price reaches it, REAL single-leg orders go to the broker as LIMIT / SL and fill from the broker's order book.
// Everything is mocked in the browser (the resting ledger with the real applyRestingOp, the order route as a recorder), so
// no file is written and no order can leave. The page clock is pinned to an NSE trading morning.

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 30, hh, mm, ss) - 5.5 * 3600_000;
type Body = { mode?: string; action?: string; lots?: number; orderType?: string; price?: number; trigger?: number; brokerOp?: { op: string; orderId: string } };

async function install(page: Page, opts: { ledger?: RestingLedger; levels?: number[] } = {}) {
  const orders: Body[] = [];
  const state = {
    ledger: (opts.ledger ?? EMPTY_RESTING) as RestingLedger, tick: { ltp: 99.33, at: ist(10, 30, 10) }, book: [] as Record<string, unknown>[],
    /** Set: the next resting placement gets no clean reply (the route's 504 / UNKNOWN). */
    unknownNext: false,
  };
  // `levels`: box labels around 100 with a 0.1 box (the page's default 0.1% box), one 1-minute bar each, ending before the pinned clock.
  const bars = opts.levels
    ? opts.levels.map((l, i) => { const p = Number((100 + l * 0.1).toFixed(2)); return { t: ist(10, 20 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }; })
    : [100, 99.5, 100].map((p, i) => ({ t: ist(10, 27 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }));
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf/contracts') {
      if (u.searchParams.get('kind') === 'options') return json(route, { success: true, expiries: ['2026-11-03'], expiry: '2026-11-03', strikes: [23000], spot: 23000, atm: 23000 });
      return json(route, { success: true, expiries: ['2026-11-24'] });
    }
    if (p === '/api/straddle-pnf' && method === 'GET') {
      const fut = u.searchParams.get('mode') === 'contract';
      const straddle = u.searchParams.get('type') === 'STRADDLE';
      return json(route, {
        success: true, atm: 0, strikes: [0], name: straddle ? 'NIFTY 23000 STRADDLE' : fut ? 'NIFTY NOV FUT' : 'Nifty 50', errors: {}, dataDate: '2026-10-30',
        instruments: straddle ? [{ segment: 'NSE_FNO', security_id: '1' }, { segment: 'NSE_FNO', security_id: '2' }] : [{ segment: fut ? 'NSE_FNO' : 'IDX_I', security_id: fut ? '54321' : '13' }],
        bars: { 0: straddle ? bars.map(b => ({ ...b, ce: b.straddle / 2, pe: b.straddle / 2 })) : bars },
      });
    }
    if (p === '/api/straddle-pnf/live') {
      const two = (u.searchParams.get('ids') ?? '').includes(',');
      const q = (ltp: number) => ({ quote: { ltp, changedMs: state.tick.at, volume: 100, prevClose: 49 }, last: null });
      return json(route, { success: true, legs: two ? [q(state.tick.ltp / 2), q(state.tick.ltp / 2)] : [q(state.tick.ltp)] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65, tick: 0.05 }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const b = req.postDataJSON() as Body;
      orders.push(b);
      if (b.brokerOp) return json(route, { success: true, outcome: 'placed', price: b.price, trigger: b.trigger });
      if ((b.orderType === 'LIMIT' || b.orderType === 'SL') && state.unknownNext) {
        state.unknownNext = false;
        return json(route, { success: false, outcome: 'unknown', error: 'Order status unknown - check the order book' }, 504);
      }
      if (b.orderType === 'LIMIT' || b.orderType === 'SL') return json(route, { success: true, outcome: 'placed', orderId: `B-${orders.length}`, price: b.price, trigger: b.trigger });
      return json(route, { success: true, outcome: 'placed', legs: [{ label: 'NIFTY NOV FUT', side: b.action, qty: (b.lots ?? 1) * 65, product: 'INTRADAY', status: 'placed' }] });
    }
    if (p === '/api/straddle-pnf/resting') {
      if (method === 'GET') return json(route, { success: true, ledger: state.ledger });
      const r = applyRestingOp(state.ledger, req.postDataJSON() as RestingOp);
      if (!r.ok) return json(route, { success: false, error: r.error, ledger: state.ledger }, r.status);
      state.ledger = r.ledger;
      return json(route, { success: true, ledger: state.ledger });
    }
    if (p === '/api/scalper/orders') return json(route, { success: true, data: state.book });
    if (p === '/api/straddle-pnf/auto') return json(route, { success: true, ledger: { rev: 0, rows: [], log: [] } });
    if (p.endsWith('/funds')) return json(route, { success: true, data: { availabelBalance: 100000 } });
    if (p === '/api/scalper/poll') return json(route, { positions: [], positionsError: null });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: `unmocked ${method} ${p}` });
  });
  return { orders, state };
}

async function openFuture(page: Page) {
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.33');
}

/** The rail cell of chart 1 for `side` whose box price is nearest `price`. */
async function cell(page: Page, side: 'BUY' | 'SELL', price: number) {
  const cells = page.getByTestId('pnf-panel').nth(0).locator(`[data-testid="pnf-rail-cell"][data-side="${side}"]`);
  await expect(cells.first()).toBeAttached();
  const levels = await cells.evaluateAll(els => els.map(e => Number(e.getAttribute('data-level'))));
  let best = 0;
  levels.forEach((l, i) => { if (Math.abs(l - price) < Math.abs(levels[best] - price)) best = i; });
  return { el: cells.nth(best), level: levels[best] };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('PAPER: B below the price rests a LIMIT, the price falling through fills it into the paper position', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  expect(state.ledger.rows[0]).toMatchObject({ side: 'BUY', kind: 'limit', mode: 'PAPER', venue: 'page', lots: 1 });
  expect(state.ledger.rows[0].level).toBeCloseTo(level, 6);
  const line = page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-order-line');
  await expect(line).toHaveAttribute('data-kind', 'limit');
  expect(orders.length, 'a paper order never reaches the order route').toBe(0);

  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  await expect(line).toHaveCount(0);
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');
  // The ladder shows the position too: an entry line with side / size / premium, and its live P&L chip on the rail.
  const panel = page.getByTestId('pnf-panel').nth(0);
  await expect(panel.getByTestId('pnf-position-line')).toHaveAttribute('data-side', 'LONG');
  await expect(panel.getByTestId('pnf-position-line')).toContainText('LONG 1L @');
  await expect(panel.getByTestId('pnf-rail-pnl')).toContainText('₹');
});

test('PAPER: the order tag keeps "BUY LMT @ price" and its + / - change the lots of the working order', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  const line = page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-order-line');
  await expect(line).toContainText(`BUY LMT @ ${level.toFixed(2)} · 1L`);
  await line.getByTestId('pnf-order-lots-up').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.lots).toBe(2);
  await expect(line).toContainText('· 2L');
  await line.getByTestId('pnf-order-lots-down').dispatchEvent('pointerdown', { button: 0 });
  await line.getByTestId('pnf-order-lots-down').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.lots).toBe(1);        // never below one lot
  // the orders bar chip has the same + / -, so the size can be changed with the order lines hidden too
  const chip = page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-orders-chip');
  await chip.getByTestId('pnf-chip-lots-up').click();
  await expect.poll(() => state.ledger.rows[0]?.lots).toBe(2);
  await expect(chip).toContainText('· 2L');
  expect(orders.length, 'a paper order never reaches the order route').toBe(0);
});

test('PAPER: B above the price is an SL-limit (trigger and a limit past it); × cancels it', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const { el } = await cell(page, 'BUY', 99.85);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  const r = state.ledger.rows[0];
  expect(r.kind).toBe('stop');
  expect(r.trigger).toBeGreaterThan(99.33);
  expect(r.price).toBeGreaterThan(r.trigger!);
  await page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-order-cancel').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('cancelled');
  await expect(page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-order-line')).toHaveCount(0);
});

test('REAL single leg: asks once, sends a LIMIT at the box price to the broker, and fills from the broker order book', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await page.getByTestId('pnf-rail-lock').first().click();   // REAL: the rail stays locked until it is unlocked
  let asked = 0;
  page.on('dialog', d => { asked++; void d.accept(); });
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  expect(asked).toBe(1);
  expect(orders[0]).toMatchObject({ mode: 'REAL', action: 'BUY', lots: 1, orderType: 'LIMIT' });
  expect(orders[0].price).toBeLessThanOrEqual(level + 1e-9);                       // never pays more than the box
  expect(state.ledger.rows[0]).toMatchObject({ venue: 'broker', brokerOrderId: 'B-1' });

  // A second order does not ask again (once per page load)
  const s2 = await cell(page, 'SELL', 99.85);
  await s2.el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => orders.length).toBe(2);
  expect(asked).toBe(1);
  expect(orders[1]).toMatchObject({ action: 'SELL', orderType: 'LIMIT' });
  await expect.poll(() => state.ledger.rows[1]?.brokerOrderId).toBe('B-2');

  // The broker's book reports the first one TRADED (the second stays working)
  state.book = [{ orderId: 'B-1', orderStatus: 'TRADED', quantity: 65, filledQty: 65, averageTradedPrice: 99, tradingSymbol: 'NIFTY-Nov2026-FUT', transactionType: 'BUY' }];
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  expect(state.ledger.rows[0].fillPrice).toBe(99);
  expect(state.ledger.rows[1].state).toBe('working');
});

test('an index chart has no rail', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await expect(page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-rail')).toHaveCount(0);
});

test('drag an order to another box moves it (a page order: modified in place)', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const { el } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  const before = state.ledger.rows[0].level;
  const handle = page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-rail-order');
  await handle.evaluate(e => e.scrollIntoView({ block: 'center' }));                        // the chart scrolls vertically
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 6 });     // down = a lower box
  await page.mouse.up();
  await expect.poll(() => state.ledger.rows[0]?.level).toBeLessThan(before);
  expect(state.ledger.rows[0].state).toBe('working');
});

test('REAL straddle: a page-held level, sent as both legs at MARKET once when the combined price reaches it', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'CE+PE' }).first().click();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.33');
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await page.getByTestId('pnf-rail-lock').first().click();   // REAL: the rail stays locked until it is unlocked
  page.on('dialog', d => { void d.accept(); });
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  expect(state.ledger.rows[0]).toMatchObject({ venue: 'page', mode: 'REAL', kind: 'limit' });
  expect(orders.length, 'nothing goes to the broker until the level is reached').toBe(0);

  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  expect(orders.length).toBe(1);
  expect(orders[0]).toMatchObject({ mode: 'REAL', action: 'BUY', lots: 1 });
  expect(orders[0].orderType, 'both legs at MARKET (the route sends CE then PE)').toBeUndefined();
  await page.waitForTimeout(2500);
  expect(orders.length, 'fired once').toBe(1);
});

test('REAL single leg with no clean reply: UNKNOWN on the chart, never resent; ? settles it after a confirm', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await page.getByTestId('pnf-rail-lock').first().click();   // REAL: the rail stays locked until it is unlocked
  const dialogs: string[] = [];
  page.on('dialog', d => { dialogs.push(d.message()); void d.accept(); });
  state.unknownNext = true;
  const { el } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('unknown');
  const panel = page.getByTestId('pnf-panel').nth(0);
  await expect(panel.getByTestId('pnf-order-line')).toHaveAttribute('data-state', 'unknown');
  await expect(panel.getByTestId('pnf-order-cancel')).toHaveCount(0);
  await page.waitForTimeout(2500);
  expect(orders.length, 'an unknown order is never resent').toBe(1);

  await panel.getByTestId('pnf-order-resolve').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('cancelled');
  expect(dialogs.at(-1)).toMatch(/outcome is unknown/);
  expect(orders.length, 'settling places and cancels nothing at the broker').toBe(1);
  await expect(panel.getByTestId('pnf-order-line')).toHaveCount(0);
});

test('REAL straddle: a level the price reaches on a STALE feed does not fire; it fires once the feed is fresh', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: 'CE+PE' }).first().click();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.33');
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await page.getByTestId('pnf-rail-lock').first().click();   // REAL: the rail stays locked until it is unlocked
  page.on('dialog', d => { void d.accept(); });
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');

  // Ten minutes on with no newer print: the price that "reached" the level is old.
  // The page re-reads its clock every 5 s: let it see the new time before the price moves.
  await page.clock.setFixedTime(ist(10, 40, 30));
  await page.waitForTimeout(6000);
  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await page.waitForTimeout(4000);
  expect(orders.length, 'nothing fires on a stale price').toBe(0);
  expect(state.ledger.rows[0].state).toBe('working');

  await page.clock.setFixedTime(ist(10, 30, 20));
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  expect(orders.length).toBe(1);
});

test('REAL: a banner shows, the rail is locked until unlocked (clicks do nothing), and switching to REAL asks first', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  await expect(page.getByTestId('pnf-real-banner')).toHaveCount(0);
  const real = page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' });
  // Declining the confirm keeps PAPER.
  page.once('dialog', d => { void d.dismiss(); });
  await real.click();
  await expect(page.getByTestId('pnf-real-banner')).toHaveCount(0);
  page.once('dialog', d => { expect(d.message()).toMatch(/Switch to REAL/); void d.accept(); });
  await real.click();
  await expect(page.getByTestId('pnf-real-banner')).toBeVisible();
  await expect(page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-rail-locked')).toBeVisible();
  const { el } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await page.waitForTimeout(600);
  expect(state.ledger.rows.length, 'a locked rail places nothing').toBe(0);
  expect(orders.length).toBe(0);
  await page.getByTestId('pnf-rail-lock').first().click();
  await expect(page.getByTestId('pnf-panel').nth(0).getByTestId('pnf-rail-locked')).toHaveCount(0);
});

test('PAPER: the orders bar lists resting orders and Cancel all (or Shift+C) clears them; the hover label names what a click places', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const a = await cell(page, 'BUY', 99.05);
  await a.el.hover();
  await expect(page.getByTestId('pnf-rail-hover-label')).toContainText('BUY LMT @');
  await a.el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(1);
  const b = await cell(page, 'BUY', 98.75);
  await b.el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(2);
  const panel = page.getByTestId('pnf-panel').nth(0);
  await expect(panel.getByTestId('pnf-orders-chip')).toHaveCount(2);
  await panel.getByTestId('pnf-cancel-all').click();
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(0);
  await expect(panel.getByTestId('pnf-orders-chip')).toHaveCount(0);
});

test('REAL: cancelling a broker order asks first (declining keeps it); Instant skips the question', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await page.getByTestId('pnf-rail-lock').first().click();
  const msgs: string[] = [];
  let answer = true;
  page.on('dialog', d => { msgs.push(d.message()); void (answer ? d.accept() : d.dismiss()); });
  for (const [px, n] of [[99.05, 1], [98.75, 2]] as const) {
    const c = await cell(page, 'BUY', px);
    await c.el.dispatchEvent('pointerdown', { button: 0 });
    await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(n);
  }
  const panel = page.getByTestId('pnf-panel').nth(0);
  const placedMsgs = msgs.length;
  // Declining the cancel question leaves the order working and sends nothing.
  answer = false;
  await panel.getByTestId('pnf-orders-chip').first().getByRole('button').click();
  await page.waitForTimeout(500);
  expect(msgs.length).toBe(placedMsgs + 1);
  expect(msgs.at(-1)).toMatch(/Cancel this REAL/);
  expect(orders.some(o => o.brokerOp), 'declined: no cancel sent').toBe(false);
  expect(state.ledger.rows.filter(r => r.state === 'working').length).toBe(2);
  // Instant ON: the cancel goes straight out.
  await panel.getByTestId('pnf-rail-instant').click();
  await panel.getByTestId('pnf-orders-chip').first().getByRole('button').click();
  await expect.poll(() => orders.filter(o => o.brokerOp?.op === 'cancel').length).toBe(1);
  expect(msgs.length, 'Instant asks nothing').toBe(placedMsgs + 1);
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(1);
});

test('PAPER: order and position lines can be hidden (the orders bar keeps listing them) and their tags aligned left', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const { el } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  const panel = page.getByTestId('pnf-panel').nth(0);
  await expect(panel.getByTestId('pnf-order-line')).toHaveCount(1);
  const right = await panel.getByTestId('pnf-order-line').locator('rect').first().evaluate(e => e.getBoundingClientRect().x);
  await panel.getByRole('button', { name: 'Align order tags to the left' }).click();
  const left = await panel.getByTestId('pnf-order-line').locator('rect').first().evaluate(e => e.getBoundingClientRect().x);
  expect(left).toBeLessThan(right);
  await panel.getByRole('button', { name: 'Hide order and position lines' }).click();
  await expect(panel.getByTestId('pnf-order-line')).toHaveCount(0);
  await expect(panel.getByTestId('pnf-orders-chip')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Show order and position lines' }).click();
  await expect(panel.getByTestId('pnf-order-line')).toHaveCount(1);
});



test('Bracket (PAPER): the entry that fills arms a stop-loss and a target at points from its fill; the target fills and the stop is cancelled', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  await page.getByTestId('pnf-style-bracket').click();
  await page.getByLabel('Target points').fill('0.5');
  await page.getByLabel('SL points').fill('0.4');
  await page.getByLabel('SL points').press('Enter');
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  expect(state.ledger.rows[0].bracket).toMatchObject({ style: 'Bracket', tgtPts: 0.5, slPts: 0.4 });
  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows.filter(r => r.group).length, { timeout: 10_000 }).toBe(2);
  const fill = state.ledger.rows[0].fillPrice!;
  const sl = state.ledger.rows.find(r => r.role === 'sl')!, tp = state.ledger.rows.find(r => r.role === 'target')!;
  expect(sl.side).toBe('SELL'); expect(tp.side).toBe('SELL');
  expect(sl.trigger!).toBeCloseTo(fill - 0.4, 1);
  expect(tp.level).toBeCloseTo(fill + 0.5, 1);
  state.tick = { ltp: fill + 0.6, at: ist(10, 30, 16) };
  await expect.poll(() => state.ledger.rows.find(r => r.role === 'target')?.state, { timeout: 10_000 }).toBe('filled');
  await expect.poll(() => state.ledger.rows.find(r => r.role === 'sl')?.state, { timeout: 10_000 }).toBe('cancelled');
  await expect(page.getByTestId('pnf-trade-position')).toHaveCount(0);
});

test('Bracket: an unfilled Bracket / Cover places nothing (the stop-loss points are required)', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  await page.getByTestId('pnf-style-cover').click();
  const { el } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await page.waitForTimeout(600);
  expect(state.ledger.rows.length).toBe(0);
});

test('MTM guard (PAPER): a stop-loss on the chart P&L squares the position off and cancels its orders', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');
  // a resting order that the guard must cancel too
  const far = await cell(page, 'BUY', level - 0.6);
  await far.el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(1);
  await page.getByTestId('pnf-guard-toggle').click();
  await page.getByLabel('MTM stop-loss in rupees', { exact: true }).fill('50');
  await page.getByRole('button', { name: 'Switch on' }).click();
  await expect(page.getByTestId('pnf-guard-toggle')).toContainText('ON');
  // 1 point on 65 units is Rs 65 of loss: past the Rs 50 stop
  state.tick = { ltp: level - 0.2 - 1.2, at: ist(10, 30, 17) };
  await expect(page.getByTestId('pnf-trade-position')).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => state.ledger.rows.filter(r => r.state === 'working').length).toBe(0);
});

test('Bracket: an order that reduces the open position carries no bracket, even with Bracket selected', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });            // Single: a plain long
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('working');
  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  await page.getByTestId('pnf-style-bracket').click();
  await page.getByLabel('Target points').fill('0.5');
  await page.getByLabel('SL points').fill('0.4');
  await page.getByLabel('SL points').press('Enter');
  const up = await cell(page, 'SELL', level + 0.6);                // a take-profit SELL against the long
  await up.el.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => state.ledger.rows.length).toBe(2);
  expect(state.ledger.rows[1].bracket, 'a reducing order has no bracket').toBeUndefined();
});

test('MTM guard (PAPER): switched on while flat, it measures from the position that opens afterwards and does not trip on a small move', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  await page.getByTestId('pnf-guard-toggle').click();
  await page.getByLabel('MTM stop-loss in rupees', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Switch on' }).click();
  await expect(page.getByTestId('pnf-guard-toggle')).toContainText('ON');
  const { el, level } = await cell(page, 'BUY', 99.05);
  await el.dispatchEvent('pointerdown', { button: 0 });
  state.tick = { ltp: level - 0.2, at: ist(10, 30, 15) };
  await expect.poll(() => state.ledger.rows[0]?.state, { timeout: 10_000 }).toBe('filled');
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');       // 0 move: no trip
  state.tick = { ltp: level - 0.2 - 10, at: ist(10, 30, 17) };                              // -10 pts x 65 = Rs 650 past the Rs 500 stop
  await expect(page.getByTestId('pnf-trade-position')).toHaveCount(0, { timeout: 10_000 });
});

/** A ledger with a bracket's two exit rows (group g) built by the real ledger rules. */
function bracketLedger(over: { mode: 'PAPER' | 'REAL'; ageS: number; slState?: 'unknown' }): RestingLedger {
  const nowS = ist(10, 30, 20) / 1000;
  const fut = { kind: 'futures', symbol: 'NIFTY', name: 'NIFTY', expiry: '2026-11-24' } as const;
  const base = { day: '2026-10-30', chart: 1 as const, target: fut, broker: 'kotak', mode: over.mode, venue: 'page' as const, lots: 1, product: 'INTRADAY', unitsPerPoint: 65, t: nowS - over.ageS, group: 'g1' };
  let led = EMPTY_RESTING;
  for (const row of [
    { ...base, id: 'g1-sl', side: 'SELL' as const, kind: 'stop' as const, level: 90, price: 1, trigger: 90, role: 'sl' as const },
    { ...base, id: 'g1-target', side: 'SELL' as const, kind: 'limit' as const, level: 110, price: 110, role: 'target' as const },
  ]) {
    const r = applyRestingOp(led, { op: 'create', row });
    if (!r.ok) throw new Error(r.error);
    led = r.ledger;
  }
  if (over.slState === 'unknown') {
    const r = applyRestingOp(led, { op: 'markUnknown', id: 'g1-sl', note: 'no reply' });
    if (!r.ok) throw new Error(r.error);
    led = r.ledger;
  }
  return led;
}

test('Bracket: REAL exits are left alone when the page is in PAPER (a mode flip never cancels the other side\'s stops)', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page, { ledger: bracketLedger({ mode: 'REAL', ageS: 300 }) });
  await openFuture(page);                                             // the page is in PAPER, no position: a PAPER-judged sweep would cancel them
  await page.waitForTimeout(3500);
  expect(state.ledger.rows.map(r => r.state)).toEqual(['working', 'working']);
});

test('Bracket: an exit whose outcome is unknown does not cancel the sibling exit (only a confirmed fill does)', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page, { ledger: bracketLedger({ mode: 'PAPER', ageS: 0, slState: 'unknown' }) });
  await openFuture(page);
  await page.waitForTimeout(3500);
  expect(state.ledger.rows.find(r => r.role === 'sl')?.state).toBe('unknown');
  expect(state.ledger.rows.find(r => r.role === 'target')?.state).toBe('working');
});

test('Triangle: a 4-column squeeze that breaks up is drawn with its entry / stop / target; hide and the minimum-columns button work', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page, { levels: [0, 10, 3, 9, 5, 10] });
  state.tick = { ltp: 101, at: ist(10, 30, 15) };
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('101.00');
  const panel = page.getByTestId('pnf-panel').nth(0);
  const tri = panel.getByTestId('pnf-triangle');
  await expect(tri).toHaveCount(1);
  await expect(tri).toHaveAttribute('data-state', 'up');
  await expect(tri).toHaveAttribute('data-cols', '4');
  await expect(tri).toContainText('Entry');
  await expect(tri).toContainText('Stop');
  await expect(tri).toContainText('Target');
  // minimum columns: 3 -> 4 still shows it, 5 hides it, 6 -> 3 shows it again
  await panel.getByRole('button', { name: /Triangles need at least 3 columns/ }).click();
  await expect(tri).toHaveCount(1);
  await panel.getByRole('button', { name: /Triangles need at least 4 columns/ }).click();
  await expect(tri).toHaveCount(0);
  await panel.getByRole('button', { name: /Triangles need at least 5 columns/ }).click();
  await panel.getByRole('button', { name: /Triangles need at least 6 columns/ }).click();
  await expect(tri).toHaveCount(1);
  await panel.getByRole('button', { name: 'Hide triangles' }).click();
  await expect(tri).toHaveCount(0);
  await panel.getByRole('button', { name: 'Show triangles' }).click();
  await expect(tri).toHaveCount(1);
});
