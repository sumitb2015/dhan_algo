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

type OrderBody = { mode: string; broker: string; action?: string; lots?: number; product?: string; close?: boolean; target?: { kind: string }; legs?: unknown };

/** `realNet`: the Dhan book's net quantity on the future (units, lot 65) that the REAL position poll returns. */
async function installTradeMock(page: Page, opts: { realNet?: number } = {}) {
  const placedOrders: OrderBody[] = [];

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

    // What one lot is on the selected broker (server-resolved).
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, {
        success: true, unsupported: null,
        legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65 }],
      });
    }

    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const body = req.postDataJSON() as OrderBody;
      placedOrders.push(body);
      const side = body.close ? 'SELL' : body.action;
      return json(route, {
        success: true, mode: body.mode, broker: body.broker, outcome: 'placed', message: 'Sent.',
        legs: [{ label: 'NIFTY NOV FUT', side, qty: body.close ? Math.abs(opts.realNet ?? 0) : (body.lots ?? 0) * 65, product: 'INTRADAY', status: 'placed', orderId: 'ORD-12345' }],
      });
    }

    if (p === '/api/scalper/poll' && method === 'GET') {
      const net = opts.realNet ?? 0;
      return json(route, { positions: net ? [{ securityId: '54321', tradingSymbol: 'NIFTY-Nov2026-FUT', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: net, realizedProfit: 0, unrealizedProfit: 1300, lastTradedPrice: 103.5 }] : [], positionsError: null });
    }
    if (p === '/api/scalper/orders' && method === 'GET') {
      return json(route, { success: true, data: { orderStatus: 'TRADED', filledQty: 130, averageTradedPrice: 103.25 } });
    }

    if (p.includes('/api/scalper') && p.endsWith('/funds')) {
      return json(route, { success: true, data: { availabelBalance: 154200, utilizedAmount: 45000 } });
    }

    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, quotes: { NIFTY: { ltp: 24123.45, change_pct: 0.42 }, VIX: { ltp: 13.21, change_pct: -1.5 } } });
    }

    if (method === 'GET') return json(route, { success: true });
    // Anything else that is not a GET is refused: these tests must never reach a real order route.
    return route.fulfill({ status: 599, body: JSON.stringify({ success: false, error: `unmocked ${method} ${p}` }) });
  });

  return { placedOrders };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('P&F trade bar is toggled by Zap button and remembers open state', async ({ page }) => {
  await installTradeMock(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);

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
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);

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

  // The order names only the chart target, side and lots: no contract, security id or lot size from the browser
  await expect.poll(() => placedOrders.length).toBe(1);
  expect(placedOrders[0].mode).toBe('PAPER');
  expect(placedOrders[0].action).toBe('BUY');
  expect(placedOrders[0].lots).toBe(1);
  expect(placedOrders[0].target?.kind).toBe('futures');
  expect(placedOrders[0].legs).toBeUndefined();

  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');

  // One BUY marker on each chart (two charts)
  const markers = page.getByTestId('pnf-trade-marker');
  await expect(markers).toHaveCount(2);
  await expect(markers.first()).toHaveAttribute('data-action', 'BUY');
  await expect(markers.first().getByText('B', { exact: true })).toBeVisible();

  // A paper square-off is sized from the paper ledger and sends nothing
  await page.getByRole('button', { name: 'SQUARE OFF' }).click();
  await expect(page.getByText('FLAT')).toBeVisible();
  expect(placedOrders.length).toBe(1);

  // BUY and SELL markers on both charts
  await expect(markers).toHaveCount(4);
  await expect(page.locator('[data-testid="pnf-trade-marker"][data-action="SELL"]')).toHaveCount(2);
});

test('REAL is never remembered: a reload starts in PAPER', async ({ page }) => {
  await installTradeMock(page);
  await page.goto('/straddle-pnf');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  const modes = page.getByRole('group', { name: 'Execution mode' });
  await modes.getByRole('button', { name: 'REAL' }).click();
  await expect(page.getByTestId('header-pnl-margin').getByText('P&L', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('header-pnl-margin').getByText(/PAPER P&L/)).toBeVisible();
});

test('REAL square off reads the broker position and sends only close:true (the server sizes it)', async ({ page }) => {
  const { placedOrders } = await installTradeMock(page, { realNet: 130 });
  await page.goto('/straddle-pnf');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();

  // 130 units at a 65 lot = 2 lots, whatever the Lots box says
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 2 lots');
  await page.getByRole('button', { name: '5L' }).click();
  await page.getByRole('button', { name: 'SQUARE OFF' }).click();

  await expect.poll(() => placedOrders.length).toBe(1);
  expect(placedOrders[0]).toMatchObject({ mode: 'REAL', broker: 'dhan', close: true });
  expect(placedOrders[0].lots).toBeUndefined();
  expect(placedOrders[0].action).toBeUndefined();

  // The marker moves from the live estimate to the traded price the broker reports
  const marker = page.getByTestId('pnf-trade-marker').first();
  await expect(marker).toHaveAttribute('data-action', 'SELL');
  await expect(marker).toHaveAttribute('data-price', '103.25');
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

test('Header displays available margin and live P&L chips', async ({ page }) => {
  await installTradeMock(page);
  await page.goto('/straddle-pnf');

  // Header Margin chip shows formatted available margin
  const marginChip = page.getByTestId('header-pnl-margin');
  await expect(marginChip).toBeVisible();
  await expect(marginChip.getByText('Margin')).toBeVisible();
  await expect(marginChip.getByText('₹1.54L')).toBeVisible();

  // Header P&L chip starts at ₹0
  await expect(marginChip.getByText(/PAPER P&L/i)).toBeVisible();
  await expect(marginChip.getByText('₹0')).toBeVisible();

  // Switch to Futures and place a PAPER BUY order
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await page.getByRole('button', { name: 'BUY MARKET' }).click();

  // Active paper position updates and live price (103.5 vs 103 entry) updates P&L chip
  await expect(page.getByTestId('pnf-trade-position')).toHaveText('LONG 1 lot');
  await expect(marginChip.getByText(/PAPER P&L/i)).toBeVisible();
});

