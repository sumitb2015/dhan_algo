import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// E2E verification of Point & Figure 1-click execution trade bar:
// - Trade bar visibility & toggle
// - Broker & Mode selection
// - Sizing controls & commit-on-blur
// - Simulated PAPER execution & position tracking
// - SQUARE OFF order execution
// - Index non-tradable guidance & contract switching

const ATM = 25000;

function mockHistory() {
  const start = Math.floor(Date.now() / 60_000) * 60 - 300;
  return [
    { t: start, ce: 50, pe: 50, straddle: 100, vol: 10 },
    { t: start + 60, ce: 51, pe: 50, straddle: 101, vol: 10 },
    { t: start + 120, ce: 52, pe: 51, straddle: 103, vol: 10 },
  ];
}

async function installTradeMock(page: Page) {
  const placedOrders: Array<{ mode: string; broker: string; action: string; lots: number }> = [];

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();

    if (p === '/api/straddle-pnf' && method === 'GET') {
      const kind = u.searchParams.get('kind');
      const isIndex = kind === 'index';
      return json(route, {
        success: true,
        mode: isIndex ? 'price' : 'contract',
        atm: ATM,
        strikes: [ATM],
        name: isIndex ? 'Nifty 50' : 'NIFTY FUT 24 Nov 26',
        instrument: { segment: isIndex ? 'IDX_I' : 'NSE_FNO', security_id: isIndex ? '13' : '54321' },
        contracts: isIndex ? [] : [
          { segment: 'NSE_FNO', securityId: '54321', instrument: 'FUTIDX', displayName: 'NIFTY 24 Nov FUT', lot: 65, expiry: '2026-11-24' },
        ],
        errors: {},
        dataDate: '2026-10-23',
        bars: { [ATM]: mockHistory() },
      });
    }

    if (p === '/api/straddle-pnf/live' && method === 'GET') {
      const q = { ltp: 103.5, changedMs: Date.now(), prevClose: 100, volume: 100 };
      return json(route, { success: true, legs: [{ quote: q, last: null }] });
    }

    if (p === '/api/straddle-pnf/contracts' && method === 'GET') {
      return json(route, { success: true, expiries: ['2026-11-24'] });
    }

    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const body = req.postDataJSON() as { mode: string; broker: string; action: string; lots: number };
      placedOrders.push(body);
      return json(route, {
        success: true,
        mode: body.mode,
        broker: body.broker,
        orders: [{ symbol: 'NIFTY 24 Nov FUT', status: 'placed', orderId: 'ORD-12345' }],
      });
    }

    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, quotes: { NIFTY: { ltp: 24123.45, change_pct: 0.42 }, VIX: { ltp: 13.21, change_pct: -1.5 } } });
    }

    if (method === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 200, body: JSON.stringify({ success: true }) });
  });

  return { placedOrders };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('P&F trade bar is toggled by Zap button and remembers open state', async ({ page }) => {
  await installTradeMock(page);
  await page.goto('/straddle-pnf');

  // Trade bar is open by default
  const tradeBar = page.getByTestId('pnf-trade-bar');
  await expect(tradeBar).toBeVisible();

  // Clicking Zap toggle hides the trade bar
  const toggleBtn = page.getByRole('button', { name: /Hide trade desk/i });
  await toggleBtn.click();
  await expect(tradeBar).toBeHidden();

  // Reloading the page respects the hidden preference
  await page.reload();
  await expect(page.getByTestId('pnf-trade-bar')).toBeHidden();

  // Clicking Zap again re-opens the trade bar
  await page.getByRole('button', { name: /Show trade desk/i }).click();
  await expect(page.getByTestId('pnf-trade-bar')).toBeVisible();
});

test('Index shows non-tradable note; switching to Futures enables 1-click trading', async ({ page }) => {
  const { placedOrders } = await installTradeMock(page);
  await page.goto('/straddle-pnf');

  // On Index, it warns non-tradable
  await expect(page.getByText(/Index spot is non-tradable directly/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Trade Near Future' })).toBeVisible();

  // Switch to Futures segment
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();

  // Now trading controls are active
  const buyBtn = page.getByRole('button', { name: 'BUY MARKET' });
  const sellBtn = page.getByRole('button', { name: 'SELL MARKET' });
  await expect(buyBtn).toBeVisible();
  await expect(sellBtn).toBeVisible();

  // Position is FLAT initially
  await expect(page.getByText('FLAT')).toBeVisible();

  // Click BUY MARKET in PAPER mode
  await buyBtn.click();

  // Order API was called
  expect(placedOrders.length).toBe(1);
  expect(placedOrders[0].mode).toBe('PAPER');
  expect(placedOrders[0].action).toBe('BUY');
  expect(placedOrders[0].lots).toBe(1);

  // Position updates to LONG 1 lots and shows SQUARE OFF
  await expect(page.getByText(/LONG 1 lots/i)).toBeVisible();
  const squareOffBtn = page.getByRole('button', { name: 'SQUARE OFF' });
  await expect(squareOffBtn).toBeVisible();

  // Clicking SQUARE OFF dispatches a SELL order to flatten position
  await squareOffBtn.click();
  expect(placedOrders.length).toBe(2);
  expect(placedOrders[1].action).toBe('SELL');

  // Position returns to FLAT
  await expect(page.getByText('FLAT')).toBeVisible();
});

test('Lot sizing controls: preset buttons and commit-on-blur protection', async ({ page }) => {
  await installTradeMock(page);
  await page.goto('/straddle-pnf');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();

  const lotInput = page.getByLabel('Order lots');
  await expect(lotInput).toHaveValue('1');

  // Quick preset button "5L"
  await page.getByRole('button', { name: '5L' }).click();
  await expect(lotInput).toHaveValue('5');

  // Stepper "+" button increments to 6
  await page.getByLabel('Increase lots').click();
  await expect(lotInput).toHaveValue('6');

  // Stepper "-" button decrements to 5
  await page.getByLabel('Decrease lots').click();
  await expect(lotInput).toHaveValue('5');

  // Typing invalid value clamps back on blur
  await lotInput.fill('99');
  await lotInput.blur();
  // MAX_PNF_LOTS is 20
  await expect(lotInput).toHaveValue('20');
});
