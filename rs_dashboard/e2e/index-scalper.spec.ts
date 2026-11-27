import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { installSessionClock, moveSessionClock, sessionIso } from './isxClock';

// /index-scalper with every /api/* call mocked in the browser: no Dhan session needed and no order can reach a broker.
// Any non-GET the mock does not handle is refused with 599 and fails the test.

interface Call { path: string; body: Record<string, unknown> | null }

const SPOT = 25350;
const IDS: Record<string, [string, string]> = { '25300': ['301', '401'], '25350': ['302', '402'], '25400': ['303', '403'] };

function candles() {
  // 120 five-minute bars around the spot, ending at a fixed past session (09:15 IST on 2026-11-20).
  const start = Date.UTC(2026, 10, 20, 3, 45, 0) / 1000;
  return Array.from({ length: 75 }, (_, i) => {
    const base = SPOT - 40 + Math.sin(i / 6) * 40;
    return { t: start + i * 300, o: base, h: base + 12, l: base - 12, c: base + (i % 2 ? 6 : -6) };
  });
}

type MockState = { calls: Call[]; blocked: Call[]; positions: Record<string, unknown>[]; orders?: Record<string, unknown>[]; noLive?: boolean; chainCalls?: number; liveExpiry?: string; marginCalls?: number; cancels?: string[]; holdings?: Record<string, unknown>[]; positionsFail?: boolean; tick?: number; rejectOrders?: boolean };

async function mockApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);

    if (p === '/api/index-scalper/candles') return json(route, { success: true, candles: candles(), interval: '5' });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01', '2026-12-08'] });
    if (p === '/api/scalper/lookup') {
      // each expiry has its own contracts: the later expiry's ids end in 8
      const suffix = u.searchParams.get('expiry') === '2026-12-08' ? '8' : '';
      const strikes = Object.fromEntries(Object.entries(IDS).map(([k, [ce, pe]]) => [k, { ceId: ce + suffix, peId: pe + suffix }]));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
    }
    if (p === '/api/options/chain') {
      state.chainCalls = (state.chainCalls ?? 0) + 1;
      // Dhan REST shape: strike keys "25350.000000", previous_close_price, previous_oi (holiday snapshot)
      const oc = Object.fromEntries(Object.keys(IDS).map(k => [`${k}.000000`, {
        ce: { last_price: 270, oi: 577395, previous_close_price: 551.55, previous_oi: 109720, volume: 1 },
        pe: { last_price: 229.95, oi: 1118715, previous_close_price: 98.85, previous_oi: 262730, volume: 1 },
      }]));
      return json(route, { success: true, data: { chain: { oc }, spot: 25349.65 } });
    }
    if (p === '/api/options/margin') {
      state.marginCalls = (state.marginCalls ?? 0) + 1;
      return json(route, { success: true, data: { total_margin: 215121.01 } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') {
        // the bridge follows the expiry the page last started it for
        if (body?.action === 'start' && typeof body.expiry === 'string') state.liveExpiry = body.expiry;
        return json(route, { success: true });
      }
      if (state.noLive) return json(route, { success: true, status: { status: 'STOPPED' }, quotes: null });
      const strikes = Object.fromEntries(Object.keys(IDS).map(k => [k, {
        strike: Number(k),
        ce: { ltp: 210.5, oi: 1_200_000, oi_chg_pct: 12.5, change_pct: -3.2, buildup: 'SB' },
        pe: { ltp: 229.95, oi: 2_300_000, oi_chg_pct: -4.1, change_pct: 5.5, buildup: 'LB' },
      }]));
      const expiry = state.liveExpiry ?? '2026-12-01';
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry, spot: SPOT, atm: SPOT, updated_at: sessionIso(), strikes } });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') {
      if (state.positionsFail) return json(route, { success: false, error: 'Dhan API unavailable' }, 502);
      return json(route, { success: true, data: state.positions });
    }
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: state.orders ?? [] });
    if (p === '/api/scalper/orders' && method === 'DELETE') {
      (state.cancels ??= []).push(String(body?.orderId ?? ''));
      return json(route, { success: true });
    }
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: state.tick ?? 0.05 });
    // each contract's own lot (master list): every NIFTY expiry is 65
    if (p === '/api/index-scalper/lots') return json(route, { success: true, lots: Object.fromEntries((u.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(id => [id, 65])) });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: state.holdings ?? [] });
    if (p === '/api/scalper/fast-order') {
      state.calls.push({ path: p, body });
      if (state.rejectOrders) return json(route, { success: false, error: 'RMS: rejected' }, 400);
      state.positions = [];
      return json(route, { success: true, order_id: '7001' });
    }
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

test.describe('Index Scalper', () => {
  test.beforeEach(async ({ page }) => { await installSessionClock(page); });
  test('SIM: chart + chain render, a paper buy shows a position chip, Exit clears it, no order route is touched', async ({ page, context }) => {
    const state = { calls: [] as Call[], blocked: [] as Call[], positions: [] as Record<string, unknown>[] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('index-scalper')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    // the chain is closed until its toolbar button is clicked
    await expect(page.getByTestId('option-chain-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByTestId('option-chain-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trade 25350 PE' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('chain-snapshot')).toHaveCount(0); // live ticks: no snapshot badge
    // default indicators from the reference screenshot: Supertrend + EMA, listed in a dropdown that starts collapsed
    await expect(page.getByTestId('indicator-list')).toHaveCount(0);
    await page.getByTestId('indicator-list-toggle').first().click();
    await expect(page.getByTestId('indicator-list').first()).toBeVisible();
    await expect(page.getByText('Supertrend (10, 2)')).toBeVisible();
    await expect(page.getByText('EMA (20)')).toBeVisible();

    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket).toBeVisible();
    await expect(ticket.getByText('SIM · paper')).toBeVisible();
    await ticket.getByRole('button', { name: /^Buy / }).click();

    const chip = page.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('PE 25350');
    await expect(chip).toHaveAttribute('data-side', 'long');
    await expect(chip.getByTestId('position-lots')).toHaveText('1'); // 1 lot of 65
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Long 1 lot (65 units)');
    await expect(chip).toContainText('SIM');

    // the ticket floats above the chart chips: close it to reach the chip's Exit
    await ticket.getByRole('button', { name: 'Close order ticket' }).click();
    await page.getByRole('button', { name: 'Exit PE 25350' }).click();
    await expect(page.getByTestId('position-chip')).toHaveCount(0);

    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('indicators: add RSI into its own pane, change a length on blur, remove it', async ({ page, context }) => {
    const state = { calls: [] as Call[], blocked: [] as Call[], positions: [] as Record<string, unknown>[] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: /Indicators/ }).click();
    await page.getByRole('button', { name: /^RSI/ }).click();
    await page.getByTestId('indicator-list-toggle').first().click();
    await expect(page.getByText('RSI (14)')).toBeVisible();

    await page.getByRole('button', { name: 'Indicator settings' }).last().click({ force: true });
    const len = page.getByRole('dialog', { name: 'Indicators' }).getByRole('textbox').first();
    await len.fill('9');
    await len.blur();
    // line width: Auto by default; 3 px is saved with the indicator and survives a reload
    const dlg = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dlg.getByRole('button', { name: 'Line width auto' })).toHaveAttribute('aria-pressed', 'true');
    await dlg.getByRole('button', { name: 'Line width 3' }).click();
    await expect(dlg.getByRole('button', { name: 'Line width 3' })).toHaveAttribute('aria-pressed', 'true');
    if (process.env.ISX_SHOT) await dlg.screenshot({ path: process.env.ISX_SHOT });
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('RSI (9)')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const raw = localStorage.getItem('indexScalper.indicators.v2') ?? '[]';
      return (JSON.parse(raw) as { kind: string; width?: number }[]).find(i => i.kind === 'rsi')?.width;
    })).toBe(3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    const rsiRow = page.locator('div', { has: page.getByText('RSI (9)', { exact: true }) }).last();
    await rsiRow.hover();
    await rsiRow.getByRole('button', { name: 'Indicator settings' }).click({ force: true });
    await expect(page.getByRole('dialog', { name: 'Indicators' }).getByRole('button', { name: 'Line width 3' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Remove indicator' }).last().click({ force: true });
    await expect(page.getByText('RSI (9)')).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });

  test('EMA Cross is in the Indicators menu with EMA 9 / 20 by default', async ({ page, context }) => {
    const state = { calls: [] as Call[], blocked: [] as Call[], positions: [] as Record<string, unknown>[] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /Indicators/ }).click();
    await page.getByRole('button', { name: /^EMA Cross/ }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('indicator-list-toggle').first().click();
    await expect(page.getByText('EMA Cross (9, 20)')).toBeVisible();
    if (process.env.ISX_SHOT) { await page.waitForTimeout(800); await page.locator('canvas').first().locator('..').locator('..').screenshot({ path: process.env.ISX_SHOT }); }
    expect(state.blocked).toEqual([]);
  });

  test('Stochastic RSI is in the Indicators menu with TradingView defaults and draws K / D in its own pane', async ({ page, context }) => {
    const state = { calls: [] as Call[], blocked: [] as Call[], positions: [] as Record<string, unknown>[] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /Indicators/ }).click();
    await page.getByRole('button', { name: /^Stochastic RSI/ }).click();
    await page.getByTestId('indicator-list-toggle').first().click();
    await expect(page.getByText('Stochastic RSI (3, 3, 14, 14)')).toBeVisible();
    if (process.env.ISX_SHOT) await page.screenshot({ path: process.env.ISX_SHOT });
    expect(state.blocked).toEqual([]);
  });

  test('REAL: arming is explicit, broker position is drawn, Exit closes the whole broker row (any owner) and tags source isxx (uncapped close)', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [],
      // 715 at the broker: 65 from this page's isx orders, 650 opened elsewhere (mobile app / strategy). Exit closes all.
      positions: [{
        tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
        netQty: 715, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
      }],
      orders: [
        { correlationId: 'isxk1', securityId: '402', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 65 },
        { correlationId: '', securityId: '402', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 650 },
      ],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });

    // SIM first: the broker position is NOT shown and nothing is armed
    await expect(page.getByTestId('position-chip')).toHaveCount(0);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Arm REAL' }).click();

    const chip = page.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('PE 25350');
    // the broker's whole position (715 = 11 lots) is drawn, and Exit closes all of it, whoever opened it
    await expect(chip.getByTestId('position-lots')).toHaveText('11');
    await expect(chip).toContainText('+21,414 INR');
    await expect(page.getByTestId('day-pnl')).toHaveText('21,414.25'); // 715 x (229.95 - 200), live LTP

    await page.getByRole('button', { name: 'Exit PE 25350' }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({
      securityId: '402', quantity: 715, side: 'SELL', orderType: 'MARKET', productType: 'INTRADAY', source: 'isxx', exchangeSegment: 'NSE_FNO',
    });
    expect(String(state.calls[0].body?.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);
    expect(state.blocked).toEqual([]);
  });

  test('REAL Reverse: asks first, re-reads the book, cancels this page\'s stop, closes (isxx) then opens the same lots on the position\'s own contract', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [],
      // a long CE of the NEXT expiry (id 3028) while the screen shows 2026-12-01: the reverse must trade 3028, not 302
      positions: [{ tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '3028', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 130, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' }],
      orders: [{ orderId: 'SL1', correlationId: 'isxsl', securityId: '3028', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 150, price: 0, quantity: 130, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350 }],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('2', { timeout: 15_000 });

    // the broker shows 1 lot now (the mobile app sold one): the reverse is sized from that, not the chip's 2
    state.positions = [{ ...state.positions[0], netQty: 65 }];
    await chip.getByRole('button', { name: 'Reverse CE 25350' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Reverse position' });
    await expect(dlg).toContainText('SL1');
    await dlg.getByRole('button', { name: 'Cancel', exact: true }).click(); // the first answer is no: nothing sent
    expect(state.calls).toEqual([]);
    await chip.getByRole('button', { name: 'Reverse CE 25350' }).click();
    await dlg.getByRole('button', { name: 'Reverse to short' }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(2);
    expect(state.cancels).toEqual(['SL1']);
    expect(state.calls[0].body).toMatchObject({ securityId: '3028', side: 'SELL', quantity: 65, orderType: 'MARKET', productType: 'INTRADAY', source: 'isxx' });
    expect(state.calls[1].body).toMatchObject({ securityId: '3028', side: 'SELL', quantity: 65, orderType: 'MARKET', productType: 'INTRADAY', source: 'isx' });
    expect(state.blocked).toEqual([]);
  });

  test('REAL Reverse whose close is rejected keeps the position\'s stop (nothing cancelled, nothing opened)', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [], rejectOrders: true,
      positions: [{ tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' }],
      orders: [{ orderId: 'SL1', correlationId: 'isxsl', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 150, price: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350 }],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('1', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Reverse CE 25350' }).click();
    await page.getByRole('alertdialog', { name: 'Reverse position' }).getByRole('button', { name: 'Reverse to short' }).click();
    await expect(page.getByText(/not closed \(its target \/ stop orders are untouched\)/)).toBeVisible({ timeout: 15_000 });
    expect(state.calls.length).toBe(1);
    expect(state.calls[0].body).toMatchObject({ side: 'SELL', source: 'isxx' });
    expect(state.cancels ?? []).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL Reverse is refused (nothing sent) while another placer\'s order works on the closing side, or above the per-order cap', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [],
      positions: [{ tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' }],
      orders: [{ orderId: 'ST9', correlationId: 'strat', securityId: '402', tradingSymbol: 'NIFTY-Dec2026-25350-PE', productType: 'INTRADAY', transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 150, price: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'PUT', drvStrikePrice: 25350 }],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('1', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Reverse PE 25350' }).click();
    const dlg = page.getByRole('alertdialog', { name: 'Reverse position' });
    await expect(dlg).toContainText('ST9 placed elsewhere');
    await dlg.getByRole('button', { name: 'Reverse to short' }).click();
    await expect(page.getByText(/order ST9 placed elsewhere works on the closing side/)).toBeVisible({ timeout: 15_000 });
    expect(state.calls).toEqual([]);
    expect(state.cancels ?? []).toEqual([]);

    // 21 lots: the other side would be one 21-lot order, above NIFTY's 20-lot cap
    state.orders = [];
    state.positions = [{ ...state.positions[0], netQty: 1365 }];
    await expect(chip.getByTestId('position-lots')).toHaveText('21', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Reverse PE 25350' }).click();
    await dlg.getByRole('button', { name: 'Reverse to short' }).click();
    await expect(page.getByText(/above the 20-lot cap per order/)).toBeVisible({ timeout: 15_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL Exit All: one order per broker row (duplicates collapsed), never a second pass, legs opened elsewhere closed too', async ({ page, context }) => {
    const row = { tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', sellAvg: 230, buyAvg: 0, positionType: 'SHORT' };
    const state: MockState = {
      calls: [], blocked: [],
      positions: [
        { ...row, productType: 'INTRADAY', netQty: -65 },
        { ...row, productType: 'INTRADAY', netQty: -65 }, // Dhan's verbatim duplicate row
        { ...row, productType: 'MARGIN', netQty: -65 }, // opened elsewhere
      ],
      orders: [{ correlationId: 'isxk2', securityId: '402', productType: 'INTRADAY', transactionType: 'SELL', filledQty: 65 }],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await expect(page.getByTestId('position-chip')).toHaveCount(2, { timeout: 15_000 });

    await page.getByRole('button', { name: 'Exit All' }).click();
    // the MARGIN row was not opened from this page: Exit All lists it and asks first; nothing is sent yet
    const ask = page.getByRole('alertdialog', { name: 'Exit all including positions opened elsewhere' });
    await expect(ask.getByTestId('exit-all-elsewhere')).toHaveText(/PE 25350 MARGIN · -65/);
    await expect(ask.getByTestId('exit-all-elsewhere').locator('li')).toHaveCount(1);
    expect(state.calls.length).toBe(0);
    await ask.getByRole('button', { name: /^Close all/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Exit All' })).toContainText('Exit All sent for 2 leg(s)', { timeout: 15_000 });
    expect(state.calls.length).toBe(2);
    expect(state.calls.map(c => c.body?.productType).sort()).toEqual(['INTRADAY', 'MARGIN']);
    for (const c of state.calls) expect(c.body).toMatchObject({ securityId: '402', quantity: 65, side: 'BUY', source: 'isxx' });
    expect(state.blocked).toEqual([]);
  });

  test('an open ticket closes when the expiry changes, so it can never send the previous expiry\'s contract', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 }); // hydrated: clicks are handled
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click({ timeout: 60_000 });
    await expect(page.getByTestId('order-ticket')).toContainText('2026-12-01');
    await page.getByTestId('option-chain-panel').getByRole('combobox').selectOption('2026-12-08');
    await expect(page.getByTestId('order-ticket')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('no live ticks (holiday / bridge down): the chain shows Dhan\'s REST snapshot, flagged, and nothing trades on it', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [], noLive: true };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 }); // hydrated: clicks are handled
    await page.getByRole('button', { name: 'Option chain' }).click();
    const panel = page.getByTestId('option-chain-panel');
    await expect(panel.getByTestId('chain-snapshot')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByRole('button', { name: 'Trade 25350 CE' })).toHaveText('270.00');
    await expect(panel).toContainText('Short Buildup'); // CE: price down, OI up vs the previous session
    await expect(panel).toContainText('Long Buildup'); // PE: price up, OI up

    // a paper order from a snapshot price is refused: orders only ever price off live ticks
    await panel.getByRole('button', { name: 'Trade 25350 CE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('order-ticket')).toContainText('No live price');
    await expect(page.getByTestId('position-chip')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('chain B / S: open the ticket by default; in one-click Scalper mode they trade at once (SIM)', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    const panel = page.getByTestId('option-chain-panel');
    const row = panel.getByRole('row').filter({ hasText: '25350' });
    await expect(row.getByRole('button', { name: 'Buy 25350 CE' })).toBeVisible({ timeout: 30_000 });

    // one-click off: B opens the ticket, nothing is filled
    await row.hover();
    await row.getByRole('button', { name: 'Buy 25350 CE' }).click();
    await expect(page.getByTestId('order-ticket')).toContainText('25350 CALL');
    await expect(page.getByTestId('position-chip')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close order ticket' }).click();

    // one-click on: S sells the PE at once (paper), sized by the Scalper lots
    await page.getByRole('button', { name: 'Scalper' }).click();
    await row.hover();
    await row.getByRole('button', { name: 'Sell 25350 PE' }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveAttribute('data-side', 'short');
    await expect(chip).toContainText('PE 25350');
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Short 1 lot (65 units)');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('chain B / S in REAL one-click mode send one tagged market order for that exact contract', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await page.getByRole('button', { name: 'Scalper' }).click();
    await page.getByRole('button', { name: 'Option chain' }).click();
    const row = page.getByTestId('option-chain-panel').getByRole('row').filter({ hasText: '25300' });
    await row.hover();
    await row.getByRole('button', { name: 'Buy 25300 CE' }).dblclick(); // a double click must still send ONE order
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(500);
    expect(state.calls.length).toBe(1);
    expect(state.calls[0].body).toMatchObject({
      securityId: '301', quantity: 65, side: 'BUY', orderType: 'MARKET', productType: 'INTRADAY', source: 'isx', exchangeSegment: 'NSE_FNO',
    });
    expect(state.blocked).toEqual([]);
  });

  test('a snapshot chain (no live ticks) shows B / S disabled', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [], noLive: true };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByTestId('chain-snapshot')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Buy 25350 CE' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Sell 25350 PE' })).toBeDisabled();
    expect(state.calls).toEqual([]);
  });

  test('Scalper widget: +/- sizes the ATM CALL, closing it disarms one-click, sells show Dhan\'s margin (SIM)', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Scalper' }).click();
    const w = page.getByTestId('dhan-scalper-widget');
    await expect(w).toBeVisible();
    // the top row SELLs: under each button is Dhan's margin calculator, not a premium or a formula
    await expect(w.getByText('Margin: ₹2,15,121.01')).toHaveCount(2, { timeout: 15_000 });
    await expect(w).not.toContainText('₹14,946.75'); // the PE's buy premium (229.95 x 65) is not a sell requirement

    // +/- must register even while live ticks re-render the widget
    await w.getByRole('button', { name: 'More lots (ATM)' }).click();
    await expect(w).toContainText('Lot: 2');
    await w.getByRole('button', { name: /^Sell ATM call/ }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('CE 25350');
    await expect(chip).toHaveAttribute('data-side', 'short');
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Short 2 lots (130 units)'); // 2 lots x 65

    // the ATM sell section folds like the CE / PE cards; the choice survives closing and reopening the widget
    await w.getByRole('button', { name: 'Collapse ATM sell' }).click();
    await expect(w.getByRole('button', { name: /^Sell ATM call/ })).toHaveCount(0);
    await expect(w).toContainText('Sell PE 25350 · CE 25350');
    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    await expect(w).toHaveCount(0);
    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    await expect(w.getByRole('button', { name: 'Expand ATM sell' })).toHaveAttribute('aria-expanded', 'false');
    await w.getByRole('button', { name: 'Expand ATM sell' }).click();
    await expect(w.getByRole('button', { name: /^Sell ATM call/ })).toBeVisible();

    // X closes the widget AND disarms one-click: the chain's B opens the ticket again instead of trading
    await w.getByRole('button', { name: 'Close scalper' }).click();
    await expect(w).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scalper' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Option chain' }).click();
    const row = page.getByTestId('option-chain-panel').getByRole('row').filter({ hasText: '25300' });
    await row.hover();
    await row.getByRole('button', { name: 'Buy 25300 CE' }).click();
    await expect(page.getByTestId('order-ticket')).toContainText('25300 CALL');
    await expect(page.getByTestId('position-chip')).toHaveCount(1);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Scalper widget follows an expiry change made in the chain: its REAL order is not refused', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByTestId('option-chain-panel').getByRole('combobox').selectOption('2026-12-08');
    await page.getByRole('button', { name: 'Scalper' }).click();
    const w = page.getByTestId('dhan-scalper-widget');
    await expect(w).toContainText('08 DEC');
    await expect(w.getByRole('button', { name: /^Sell ATM put/ })).toBeEnabled({ timeout: 15_000 });
    await w.getByRole('button', { name: /^Sell ATM put/ }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({ securityId: '4028', quantity: 65, side: 'SELL', orderType: 'MARKET', source: 'isx' }); // the 08-Dec contract
    expect(state.blocked).toEqual([]);
  });

  test('account panel: Dhan-style summary, tabs, orders with status chips, cancel on any working order, paper positions with Exit', async ({ page, context }) => {
    const order = {
      orderId: '2152611247467', correlationId: 'Z_CHART', orderStatus: 'CANCELLED', transactionType: 'SELL', exchangeSegment: 'NSE_FNO',
      productType: 'MARGIN', orderType: 'LIMIT', tradingSymbol: 'NIFTY-Dec2026-25550-CE', securityId: '47812', quantity: 65, price: 180,
      triggerPrice: 0, createTime: '2026-11-24 09:47:15', updateTime: '2026-11-24 09:47:15', drvExpiryDate: '2026-12-01',
      drvOptionType: 'CALL', drvStrikePrice: 25550, omsErrorDescription: '', filledQty: 0, averageTradedPrice: 0,
    };
    const state: MockState = {
      calls: [], blocked: [], positions: [],
      orders: [order, { ...order, orderId: '777', correlationId: 'isxabc', orderStatus: 'PENDING', createTime: '2026-11-24 09:50:00' },
        { ...order, orderId: '888', correlationId: 'stg01', orderStatus: 'PENDING', createTime: '2026-11-24 09:51:00' }],
      holdings: [{ tradingSymbol: 'NIFTYBEES', securityId: '1', totalQty: 10, avgCostPrice: 280, lastTradedPrice: 278.774 }],
    };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    const panel = page.getByTestId('account-panel');
    await expect(panel).toContainText('Available Margin');
    await expect(panel).toContainText('46,84,089.17');
    await expect(panel).toContainText('-12.26'); // Holding P&L

    // Orders tab: Dhan's columns and status chips; Cancel on every working order (this page's or not), none on a closed one
    await panel.getByRole('tab', { name: 'Orders' }).click();
    await expect(panel.getByRole('button', { name: 'All 3' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Open 2' })).toBeVisible();
    await panel.getByRole('button', { name: 'Cancelled 1' }).click();
    const row = panel.getByTestId('panel-order-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('NIFTY 01 DEC 25550 CALL');
    await expect(row).toContainText('24 Nov 2026, 09:47:15');
    for (const t of ['NSE', 'Sell', 'Limit', 'Normal', '65', '180.00', 'CANCELLED', '2152611247467']) await expect(row).toContainText(t);
    await panel.getByRole('button', { name: 'All 3' }).click();
    await expect(panel.getByRole('button', { name: 'Cancel order 888' })).toHaveCount(1); // a strategy's order: cancellable too
    // ...but only after a confirmation; "Keep it" sends nothing
    await panel.getByRole('button', { name: 'Cancel order 888' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Cancel an order placed elsewhere' });
    await expect(ask).toContainText('order 888');
    await ask.getByRole('button', { name: 'Keep it' }).click();
    await expect(ask).toHaveCount(0);
    expect(state.cancels ?? []).toEqual([]);
    await expect(panel.getByRole('button', { name: 'Cancel order 2152611247467' })).toHaveCount(0); // cancelled already
    await panel.getByRole('button', { name: 'Cancel order 777' }).click();
    await expect.poll(() => state.cancels ?? []).toEqual(['777']);

    // Portfolio tab
    await panel.getByRole('tab', { name: /Portfolio/ }).click();
    await expect(panel).toContainText('NIFTYBEES');

    // a paper trade shows in Positions with its Exit, and Exit closes it
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await panel.getByRole('tab', { name: /^Positions/ }).click();
    const pos = panel.getByTestId('panel-position-row');
    await expect(pos).toContainText('NIFTY 01 DEC 25350 PUT', { timeout: 15_000 });
    await pos.getByRole('button', { name: /^Exit / }).click();
    await expect(pos).toHaveCount(0);
    await panel.getByRole('tab', { name: /Closed Positions/ }).click();
    await expect(panel).toContainText('NIFTY 01 DEC 25350 PUT');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('day P&L: unknown (—) when REAL positions cannot be read, never 0.00', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [], positionsFail: true };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('day-pnl')).toHaveText('0.00'); // SIM, no paper positions: a real zero
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await expect(page.getByTestId('account-panel')).toContainText('Dhan API unavailable', { timeout: 15_000 });
    await expect(page.getByTestId('day-pnl')).toHaveText('—');
  });

  test('day P&L is flagged partial when an open paper leg has no price (its expiry left the chain)', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('day-pnl-partial')).toHaveCount(0);
    await page.getByTestId('option-chain-panel').getByRole('combobox').selectOption('2026-12-08');
    await expect(page.getByTestId('day-pnl-partial')).toHaveText('partial · 1 unpriced', { timeout: 15_000 });
    expect(state.calls).toEqual([]);
  });

  test('15:35 IST: NSE F&O is still open (close auction to 15:40), so a paper order fills', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await moveSessionClock(page, Date.parse('2026-11-25T10:05:00Z')); // 15:35 IST
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('position-chip')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('market-closed')).toHaveCount(0);
    expect(state.calls).toEqual([]); // SIM: no order route
  });

  test('after the close nothing fills: paper orders are refused and the page says NSE is closed', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.clock.setSystemTime(Date.parse('2026-11-25T10:45:00Z')); // 16:15 IST, same day
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('market-closed')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 PE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('order-ticket')).toContainText(/NSE is closed|stale|No live price/); // refused, whichever guard trips first
    await expect(page.getByTestId('position-chip')).toHaveCount(0);
    expect(state.calls).toEqual([]);
  });

  test('Escape closes the Indicators window; an empty demat reads Holding P&L 0.00', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [], holdings: [] };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: /Indicators/ }).click();
    await expect(page.getByRole('dialog', { name: 'Indicators' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Indicators' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Option chain' }).click(); // the page is clickable again
    await expect(page.getByTestId('option-chain-panel')).toBeVisible();
    await expect(page.getByTestId('account-panel').getByText('Holding P&L').locator('..')).toContainText('0.00');
  });

  test('the ticket checks prices against the contract\'s own tick from the master list', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], positions: [], tick: 0.1 };
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByLabel('Price').fill('180.05');
    await ticket.getByRole('button', { name: /^Buy / }).click();
    await expect(ticket).toContainText('Price 180.05 is not a multiple of ₹0.10: use 180.00 or 180.10');
  });
});
