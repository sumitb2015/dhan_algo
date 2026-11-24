import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

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

type MockState = { calls: Call[]; blocked: Call[]; positions: Record<string, unknown>[]; orders?: Record<string, unknown>[]; noLive?: boolean; chainCalls?: number; liveExpiry?: string; marginCalls?: number; cancels?: string[]; holdings?: Record<string, unknown>[]; positionsFail?: boolean };

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
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry, spot: SPOT, atm: SPOT, updated_at: new Date().toISOString(), strikes } });
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
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: state.holdings ?? [] });
    if (p === '/api/scalper/fast-order') {
      state.calls.push({ path: p, body });
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
    // default indicators from the reference screenshot: Supertrend + EMA
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
    await expect(chip).toContainText('65');
    await expect(chip).toContainText('SIM');

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
    await expect(page.getByText('RSI (14)')).toBeVisible();

    await page.getByRole('button', { name: 'Indicator settings' }).last().click({ force: true });
    const len = page.getByRole('dialog', { name: 'Indicators' }).getByRole('textbox').first();
    await len.fill('9');
    await len.blur();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('RSI (9)')).toBeVisible();

    await page.getByRole('button', { name: 'Remove indicator' }).last().click({ force: true });
    await expect(page.getByText('RSI (9)')).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });

  test('REAL: arming is explicit, broker position is drawn, Exit closes only what this page opened and tags source isx', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [],
      // 715 at the broker, of which this page's isx orders filled 65; the other 650 belong to a strategy.
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
    await expect(chip).toContainText('@ 200.00');
    await expect(page.getByTestId('day-pnl')).toHaveText('21,414.25'); // 715 x (229.95 - 200), live LTP

    await page.getByRole('button', { name: 'Exit PE 25350' }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({
      securityId: '402', quantity: 65, side: 'SELL', orderType: 'MARKET', productType: 'INTRADAY', source: 'isx', exchangeSegment: 'NSE_FNO',
    });
    expect(String(state.calls[0].body?.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);
    expect(state.blocked).toEqual([]);
  });

  test('REAL Exit All: one order per owned row, never a second pass, legs it did not open are left alone', async ({ page, context }) => {
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
    await expect(page.getByRole('status').filter({ hasText: 'Exit All' })).toContainText('1 leg(s) not opened from this page left open', { timeout: 15_000 });
    expect(state.calls.length).toBe(1);
    expect(state.calls[0].body).toMatchObject({ securityId: '402', quantity: 65, side: 'BUY', productType: 'INTRADAY', source: 'isx' });
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
    await expect(chip).toHaveText(/^S\s*PE 25350\s*65\b/); // short ("S"), 1 lot of 65
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
    // Dhan's margin calculator, not a formula
    await expect(w).toContainText('Margin: ₹2,15,121.01', { timeout: 15_000 });

    // +/- must register even while live ticks re-render the widget
    await w.getByRole('button', { name: 'More lots (ATM)' }).click();
    await expect(w).toContainText('Lot: 2');
    await w.getByRole('button', { name: /^Buy ATM call/ }).click();
    const chip = page.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('CE 25350');
    await expect(chip).toContainText('130'); // 2 lots x 65

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
    await expect(w.getByRole('button', { name: /^Buy ATM put/ })).toBeEnabled({ timeout: 15_000 });
    await w.getByRole('button', { name: /^Buy ATM put/ }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({ securityId: '4028', quantity: 65, side: 'BUY', orderType: 'MARKET', source: 'isx' }); // the 08-Dec contract
    expect(state.blocked).toEqual([]);
  });

  test('account panel: Dhan-style summary, tabs, orders with status chips, own-order cancel only, paper positions with Exit', async ({ page, context }) => {
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

    // Orders tab: Dhan's columns and status chips; Cancel only on THIS page's working order
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
    await expect(panel.getByRole('button', { name: 'Cancel order 888' })).toHaveCount(0); // a strategy's order
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
});
