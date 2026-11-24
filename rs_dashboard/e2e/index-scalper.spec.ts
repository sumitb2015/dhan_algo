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

type MockState = { calls: Call[]; blocked: Call[]; positions: Record<string, unknown>[]; orders?: Record<string, unknown>[]; noLive?: boolean; chainCalls?: number };

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
      const strikes = Object.fromEntries(Object.entries(IDS).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }]));
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
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      if (state.noLive) return json(route, { success: true, status: { status: 'STOPPED' }, quotes: null });
      const strikes = Object.fromEntries(Object.keys(IDS).map(k => [k, {
        strike: Number(k),
        ce: { ltp: 210.5, oi: 1_200_000, oi_chg_pct: 12.5, change_pct: -3.2, buildup: 'SB' },
        pe: { ltp: 229.95, oi: 2_300_000, oi_chg_pct: -4.1, change_pct: 5.5, buildup: 'LB' },
      }]));
      const expiry = u.searchParams.get('expiry') || '2026-12-01';
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry, spot: SPOT, atm: SPOT, updated_at: new Date().toISOString(), strikes } });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: state.orders ?? [] });
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
    await expect(page.getByTestId('open-pnl')).toContainText('+₹21,414');

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
});
