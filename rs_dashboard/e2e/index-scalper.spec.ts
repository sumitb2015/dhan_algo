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

async function mockApi(page: Page, state: { calls: Call[]; blocked: Call[]; positions: Record<string, unknown>[] }) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);

    if (p === '/api/index-scalper/candles') return json(route, { success: true, candles: candles(), interval: '5' });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(Object.entries(IDS).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }]));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      const strikes = Object.fromEntries(Object.keys(IDS).map(k => [k, {
        strike: Number(k),
        ce: { ltp: 210.5, oi: 1_200_000, oi_chg_pct: 12.5, change_pct: -3.2, buildup: 'SB' },
        pe: { ltp: 229.95, oi: 2_300_000, oi_chg_pct: -4.1, change_pct: 5.5, buildup: 'LB' },
      }]));
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-12-01', spot: SPOT, atm: SPOT, updated_at: new Date().toISOString(), strikes } });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
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
    await expect(page.getByTestId('option-chain-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Trade 25350 PE' })).toBeVisible({ timeout: 30_000 });
    // default indicators from the reference screenshot: Supertrend + EMA
    await expect(page.getByText('Supertrend (10, 3)')).toBeVisible();
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

  test('REAL: arming is explicit, broker position is drawn, Exit sizes off the live row and tags source isx', async ({ page, context }) => {
    const state = {
      calls: [] as Call[], blocked: [] as Call[],
      positions: [{
        tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
        netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
      }] as Record<string, unknown>[],
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
    await expect(page.getByTestId('open-pnl')).toContainText('+₹1,947');

    await page.getByRole('button', { name: 'Exit PE 25350' }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({
      securityId: '402', quantity: 65, side: 'SELL', orderType: 'MARKET', productType: 'INTRADAY', source: 'isx', exchangeSegment: 'NSE_FNO',
    });
    expect(String(state.calls[0].body?.idempotencyKey ?? '').length).toBeGreaterThanOrEqual(8);
    expect(state.blocked).toEqual([]);
  });
});
