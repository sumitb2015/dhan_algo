import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { installSessionClock, sessionIso } from './isxClock';

interface Call { path: string; body: Record<string, unknown> | null }

const CRUDE_SPOT = 6120;
const CRUDE_IDS: Record<string, [string, string]> = {
  '6100': ['501', '601'],
  '6150': ['502', '602'],
  '6200': ['503', '603'],
};
// Full-size CRUDEOIL: its own contract ids, future 9101, Kotak symbols CRUDEOIL... (never the mini's).
const CRUDEOIL_IDS: Record<string, [string, string]> = {
  '6100': ['701', '801'],
  '6150': ['702', '802'],
  '6200': ['703', '803'],
};
const isCrude = (u: string) => u === 'CRUDEOILM' || u === 'CRUDEOIL';
const idsFor = (u: string) => (u === 'CRUDEOIL' ? CRUDEOIL_IDS : CRUDE_IDS);

function crudeCandles() {
  const start = Date.UTC(2026, 10, 20, 3, 45, 0) / 1000;
  return Array.from({ length: 75 }, (_, i) => {
    const base = CRUDE_SPOT - 10 + Math.sin(i / 6) * 10;
    return { t: start + i * 300, o: base, h: base + 2, l: base - 2, c: base + (i % 2 ? 1 : -1) };
  });
}

type MockState = {
  calls: Call[];
  blocked: Call[];
  underlyingCalls: string[];
  candleCalls: string[];
  positions: Record<string, unknown>[];
  orders?: Record<string, unknown>[];
};

async function mockCrudeApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);

    if (p === '/api/index-scalper/candles') {
      state.candleCalls.push(req.url());
      return json(route, { success: true, candles: crudeCandles(), interval: '5' });
    }
    if (p === '/api/options/expiries') {
      const und = u.searchParams.get('underlying') ?? 'NIFTY';
      state.underlyingCalls.push(und);
      if (isCrude(und)) {
        return json(route, { success: true, data: ['2026-12-15'] });
      }
      return json(route, { success: true, data: ['2026-12-01'] });
    }
    if (p === '/api/scalper/lookup') {
      const und = u.searchParams.get('underlying') ?? 'NIFTY';
      if (isCrude(und)) {
        const strikes = Object.fromEntries(Object.entries(idsFor(und)).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }]));
        return json(route, {
          success: true,
          data: {
            lotSize: 1,
            // the shape scripts/tools/scalper_api.py `lookup` returns
            future: { securityId: und === 'CRUDEOIL' ? '9101' : '9001', expiry: '2026-12-18' },
            strikes,
          },
        });
      }
      return json(route, { success: true, data: { lotSize: 65, strikes: {} } });
    }
    if (p === '/api/options/chain') {
      return json(route, { success: true, data: { chain: { oc: {} }, spot: CRUDE_SPOT } });
    }
    if (p === '/api/options/margin') {
      return json(route, { success: true, data: { total_margin: 50000 } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      const und = u.searchParams.get('underlying') ?? 'NIFTY';
      const strikes = Object.fromEntries(Object.keys(CRUDE_IDS).map(k => [k, {
        strike: Number(k),
        ce: { ltp: 110.5, oi: 12000, oi_chg_pct: 1.5, change_pct: -0.2, buildup: 'SB' },
        pe: { ltp: 120.0, oi: 15000, oi_chg_pct: 2.1, change_pct: 0.5, buildup: 'LB' },
      }]));
      return json(route, {
        success: true,
        status: { status: 'RUNNING' },
        quotes: {
          underlying: und,
          expiry: isCrude(und) ? '2026-12-15' : '2026-12-01',
          spot: CRUDE_SPOT,
          atm: 6100,
          updated_at: sessionIso(),
          strikes,
        },
      });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 1000000, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: state.orders ?? [] });
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 1.0 });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order') {
      state.calls.push({ path: p, body });
      return json(route, { success: true, order_id: '8001' });
    }
    if (p === '/api/index-scalper/kotak-order') {
      if (method === 'GET') return json(route, { success: true, day: '2026-11-25', records: [] });
      state.calls.push({ path: p, body });
      return json(route, { success: true, order_id: 'K8001' });
    }
    // Kotak contracts, in the shapes /api/scalper/kotak/lookup and /symbol-lookup return
    if (p === '/api/scalper/kotak/lookup') {
      const und = u.searchParams.get('underlying') ?? 'CRUDEOILM';
      const root = und === 'CRUDEOIL' ? 'CRUDEOIL' : 'CRUDEOILM';
      return json(route, {
        success: true,
        data: {
          lotSize: und === 'CRUDEOIL' ? 100 : 10, exchangeSegment: 'mcx_fo', future: { trading_symbol: `${root}26DECFUT` },
          strikes: Object.fromEntries(Object.keys(CRUDE_IDS).map(k => [k, { ceSymbol: `${root}26DEC${k}CE`, peSymbol: `${root}26DEC${k}PE` }])),
        },
      });
    }
    if (p === '/api/scalper/kotak/symbol-lookup') {
      return json(route, { success: true, data: {
        CRUDEOILM26DECFUT: { expiry: '2026-12-18', strike: 0, side: 'FUT' },
        CRUDEOIL26DECFUT: { expiry: '2026-12-18', strike: 0, side: 'FUT' },
      } });
    }
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 1000000, availableBalance: 1000000, utilizedAmount: 0 } });
    if (p === '/api/scalper/kotak/positions' || p === '/api/index-scalper/kotak-positions') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/kotak/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/equity-order/holdings') return json(route, { success: true, data: {} });
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

test.describe('Index Scalper - CRUDEOILM Integration', () => {
  test.beforeEach(async ({ page }) => {
    await installSessionClock(page);
  });

  test('switches to CRUDEOILM, displays FUT actions, and disables underlying switch in REAL', async ({ page, context }) => {
    const state: MockState = {
      calls: [],
      blocked: [],
      underlyingCalls: [],
      candleCalls: [],
      positions: [],
    };
    await signIn(context);
    await mockCrudeApi(page, state);

    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="index-scalper"]')).toBeVisible();

    // Select CRUDEOILM
    const crudeBtn = page.getByRole('button', { name: 'CRUDEOILM', exact: true });
    await expect(crudeBtn).toBeVisible();
    await crudeBtn.click();

    // Verify Buy FUT and Sell FUT buttons appear in toolbar
    await expect(page.getByRole('button', { name: 'Buy FUT', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sell FUT', exact: true })).toBeVisible();

    // Verify option chain displays the pinned FUT row
    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByText('FUT · CRUDEOILM')).toBeVisible();

    // Arm REAL
    await page.getByRole('button', { name: 'REAL' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();

    // While REAL is armed, underlying switch buttons must be disabled
    await expect(crudeBtn).toBeDisabled();
    await expect(page.getByRole('button', { name: 'NIFTY' })).toBeDisabled();

    // One-click (Scalper) mode: without it Buy FUT only opens the order ticket
    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    // Click Buy FUT in Dhan REAL mode: should send fast-order with exchangeSegment: 'MCX_COMM' and quantity: 1 lot
    await page.getByRole('button', { name: 'Buy FUT', exact: true }).first().click(); // the toolbar's (the Scalper window has one too)
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    const dhanCall = state.calls[0];
    expect(dhanCall.path).toBe('/api/scalper/fast-order');
    expect(dhanCall.body?.exchangeSegment).toBe('MCX_COMM');
    expect(dhanCall.body?.quantity).toBe(1); // 1 lot on Dhan
    expect(dhanCall.body?.securityId).toBe('9001');
  });

  test('Kotak REAL trades CRUDEOILM in barrels (lots * 10)', async ({ page, context }) => {
    const state: MockState = {
      calls: [],
      blocked: [],
      underlyingCalls: [],
      candleCalls: [],
      positions: [],
    };
    await signIn(context);
    await mockCrudeApi(page, state);

    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="index-scalper"]')).toBeVisible();

    // Select Kotak broker
    const brokerSel = page.getByLabel('Broker for new orders');
    await expect(brokerSel).toBeEnabled({ timeout: 30_000 });
    await brokerSel.selectOption('kotak');

    // Select CRUDEOILM
    await page.getByRole('button', { name: 'CRUDEOILM', exact: true }).click();

    // Arm REAL
    await page.getByRole('button', { name: 'REAL' }).click();
    await page.getByRole('button', { name: /Arm REAL on Kotak/i }).click();

    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    // Click Buy FUT in Kotak REAL mode: should send kotak-order with exchange: 'mcx_fo' and quantity: 10 barrels
    await page.getByRole('button', { name: 'Buy FUT', exact: true }).first().click(); // the toolbar's (the Scalper window has one too)
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    const kotakCall = state.calls[0];
    expect(kotakCall.path).toBe('/api/index-scalper/kotak-order');
    expect(kotakCall.body?.tradingSymbol).toBe('CRUDEOILM26DECFUT');
    expect(kotakCall.body?.quantity).toBe(10); // 10 barrels on Kotak (1 lot * 10)
  });

  test('CRUDEOIL (full-size) on Dhan: 1 lot = quantity 1 tagged isxc; P&L x100 per point; the mini\'s position stays off its chart', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [], underlyingCalls: [], candleCalls: [],
      positions: [
        // Dhan MCX netQty is in LOTS: 2 CRUDEOIL lots = 200 bbl, opened 10 points below the live 6120
        { tradingSymbol: 'CRUDEOIL-18Dec2026-FUT', securityId: '9101', exchangeSegment: 'MCX_COMM', productType: 'MARGIN', netQty: 2, buyAvg: CRUDE_SPOT - 10, costPrice: CRUDE_SPOT - 10, sellAvg: 0, positionType: 'LONG' },
        // a CRUDEOILM future in the same book: never on the CRUDEOIL chart
        { tradingSymbol: 'CRUDEOILM-18Dec2026-FUT', securityId: '9001', exchangeSegment: 'MCX_COMM', productType: 'MARGIN', netQty: 3, buyAvg: CRUDE_SPOT - 10, costPrice: CRUDE_SPOT - 10, sellAvg: 0, positionType: 'LONG' },
      ],
    };
    await signIn(context);
    await mockCrudeApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="index-scalper"]')).toBeVisible();
    await expect(page.getByLabel('Broker for new orders')).toBeEnabled({ timeout: 30_000 }); // hydrated: clicks land
    await page.getByRole('button', { name: 'CRUDEOIL', exact: true }).click();
    await expect.poll(() => state.underlyingCalls.includes('CRUDEOIL'), { timeout: 15_000 }).toBe(true);
    await expect(page.getByTestId('chart-pane-0')).toContainText('CRUDEOIL FUT', { timeout: 30_000 }); // not 'CRUDEOILM FUT'
    await page.getByRole('button', { name: 'REAL' }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    const chips = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chips).toHaveCount(1, { timeout: 15_000 });
    await expect(chips.getByTestId('position-lots')).toHaveText('2');
    await expect(chips).toContainText('+2,000 INR'); // 2 lots x 100 bbl x 10 points

    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    await page.getByRole('button', { name: 'Buy FUT', exact: true }).first().click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].path).toBe('/api/scalper/fast-order');
    expect(state.calls[0].body).toMatchObject({ securityId: '9101', exchangeSegment: 'MCX_COMM', quantity: 1, source: 'isxc' });
    expect(state.blocked).toEqual([]);
  });

  test('CRUDEOIL on Dhan: a 10-lot position (above the 5-lot cap) still exits in full, tagged isxx (uncapped close)', async ({ page, context }) => {
    const state: MockState = {
      calls: [], blocked: [], underlyingCalls: [], candleCalls: [],
      positions: [{ tradingSymbol: 'CRUDEOIL-18Dec2026-FUT', securityId: '9101', exchangeSegment: 'MCX_COMM', productType: 'MARGIN', netQty: 10, buyAvg: CRUDE_SPOT - 10, costPrice: CRUDE_SPOT - 10, sellAvg: 0, positionType: 'LONG' }],
    };
    await signIn(context);
    await mockCrudeApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByLabel('Broker for new orders')).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: 'CRUDEOIL', exact: true }).click();
    await expect(page.getByTestId('chart-pane-0')).toContainText('CRUDEOIL FUT', { timeout: 30_000 });
    await page.getByRole('button', { name: 'REAL' }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('10', { timeout: 15_000 });
    await chip.getByRole('button', { name: /^Exit / }).click(); // the chip's own x, not Exit All
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].body).toMatchObject({ securityId: '9101', side: 'SELL', quantity: 10, source: 'isxx' });
    expect(state.blocked).toEqual([]);
  });

  test('CRUDEOIL on Kotak: 1 lot = 100 barrels', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], underlyingCalls: [], candleCalls: [], positions: [] };
    await signIn(context);
    await mockCrudeApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="index-scalper"]')).toBeVisible();
    const brokerSel = page.getByLabel('Broker for new orders');
    await expect(brokerSel).toBeEnabled({ timeout: 30_000 });
    await brokerSel.selectOption('kotak');
    await page.getByRole('button', { name: 'CRUDEOIL', exact: true }).click();
    await page.getByRole('button', { name: 'REAL' }).click();
    await page.getByRole('button', { name: /Arm REAL on Kotak/i }).click();
    await page.getByRole('button', { name: 'Scalper', exact: true }).click();
    await page.getByRole('button', { name: 'Buy FUT', exact: true }).first().click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].path).toBe('/api/index-scalper/kotak-order');
    expect(state.calls[0].body).toMatchObject({ tradingSymbol: 'CRUDEOIL26DECFUT', quantity: 100 });
    expect(state.blocked).toEqual([]);
  });

  test('CRUDEOIL caps an order at 5 lots: 6 is refused and nothing is sent', async ({ page, context }) => {
    const state: MockState = { calls: [], blocked: [], underlyingCalls: [], candleCalls: [], positions: [] };
    await signIn(context);
    await mockCrudeApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="index-scalper"]')).toBeVisible();
    await expect(page.getByLabel('Broker for new orders')).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: 'CRUDEOIL', exact: true }).click();
    await expect(page.getByTestId('chart-pane-0')).toContainText('CRUDEOIL FUT', { timeout: 30_000 });
    await page.getByRole('button', { name: 'REAL' }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    // without one-click mode, Buy FUT opens the ticket
    await page.getByRole('button', { name: 'Buy FUT', exact: true }).first().click();
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket).toContainText('max 5');
    await ticket.getByLabel(/Lots/).fill('6');
    await ticket.getByRole('button', { name: /^Buy / }).click();
    await expect(ticket).toContainText('Max 5 lots per order');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });
});
