import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// The Renko page's floating Scalper window (components/straddlePnf/ScalperWindow.tsx): a second view of the trade bar's order
// engine. Every broker-backed call is mocked; any non-GET the mock does not handle is refused (599), so nothing reaches a broker.

const ATM = 25000;

type OrderBody = { mode: string; broker: string; action?: string; lots?: number; close?: boolean; target?: { kind: string } };

async function installMock(page: Page, opts: { realNet?: number } = {}) {
  const placed: OrderBody[] = [];
  const blocked: string[] = [];
  const live = { ltp: 103.5 };
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf' && method === 'GET') {
      const isIndex = u.searchParams.get('kind') === 'index';
      const start = Math.floor(Date.now() / 60_000) * 60 - 300;
      return json(route, {
        success: true, mode: isIndex ? 'price' : 'contract', atm: ATM, strikes: [ATM],
        name: isIndex ? 'Nifty 50' : 'NIFTY FUT 24 Nov 26',
        instrument: { segment: isIndex ? 'IDX_I' : 'NSE_FNO', security_id: isIndex ? '13' : '54321' },
        errors: {}, dataDate: '2026-10-23',
        bars: { [ATM]: [{ t: start, ce: 50, pe: 50, straddle: 100, vol: 10 }, { t: start + 60, ce: 51, pe: 50, straddle: 101, vol: 10 }, { t: start + 120, ce: 52, pe: 51, straddle: 103, vol: 10 }] },
      });
    }
    if (p === '/api/straddle-pnf/live' && method === 'GET') {
      return json(route, { success: true, legs: [{ quote: { ltp: live.ltp, changedMs: Date.now(), prevClose: 100, volume: 100 }, last: null }] });
    }
    if (p === '/api/straddle-pnf/contracts' && method === 'GET') return json(route, { success: true, expiries: ['2026-11-24'] });
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65 }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const body = req.postDataJSON() as OrderBody;
      placed.push(body);
      return json(route, {
        success: true, mode: body.mode, broker: body.broker, outcome: 'placed', message: 'Sent.',
        legs: [{ label: 'NIFTY NOV FUT', side: body.close ? 'SELL' : body.action, qty: (body.lots ?? 2) * 65, product: 'INTRADAY', status: 'placed', orderId: 'ORD-1' }],
      });
    }
    if (p === '/api/scalper/poll' && method === 'GET') {
      const net = opts.realNet ?? 0;
      return json(route, { positions: net ? [{ securityId: '54321', tradingSymbol: 'NIFTY-Nov2026-FUT', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: net, realizedProfit: 0, unrealizedProfit: 1300, lastTradedPrice: 103.5 }] : [], positionsError: null });
    }
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: { orderStatus: 'TRADED', filledQty: 130, averageTradedPrice: 103.25 } });
    if (p === '/api/straddle-pnf/server-guard') return json(route, { success: true, guards: {} });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: JSON.stringify({ success: false, error: `unmocked ${method} ${p}` }) });
  });
  return { placed, blocked, live };
}

/** /renko on the near future, with the Scalper opened from the header. */
async function openScalper(page: Page) {
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await page.getByRole('button', { name: 'Scalper', exact: true }).click();
  const win = page.getByTestId('scalper-window');
  await expect(win).toBeVisible();
  await expect(win.getByTestId('scalper-ltp')).not.toHaveText('—');
  return win;
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('PAPER: buy from the window, the P&L follows the price, lots are shared with the trade bar, close and reverse', async ({ page }) => {
  const { placed, blocked, live } = await installMock(page);
  const win = await openScalper(page);
  await expect(win.getByTestId('scalper-mode')).toHaveText('Paper');
  await expect(win.getByTestId('scalper-position')).toHaveText('Flat');

  // presets and the stepper drive the same lots as the trade bar
  await win.getByRole('button', { name: '2L' }).click();
  await expect(win.getByTestId('scalper-lots')).toHaveValue('2');
  await expect(page.getByTestId('pnf-trade-bar').getByLabel('Order lots')).toHaveValue('2');
  await win.getByLabel('Increase lots').click();
  await win.getByLabel('Decrease lots').click();
  await expect(win.getByTestId('scalper-lots')).toHaveValue('2');

  await win.getByTestId('scalper-buy').click();
  await expect.poll(() => placed.length).toBe(1);
  expect(placed[0]).toMatchObject({ mode: 'PAPER', action: 'BUY', lots: 2 });
  await expect(win.getByTestId('scalper-position')).toHaveText('Long 2 lots');

  // the price moves up 2 points: 2 lots x 65 x 2 = +₹260, green edge
  live.ltp = 105.5;
  await expect(win.getByTestId('scalper-pnl')).toHaveText('+₹260', { timeout: 10_000 });
  await expect(win.getByTestId('scalper-edge')).toHaveAttribute('data-tone', 'up');

  // reverse: the paper close sends nothing, the new entry goes for the position's own size
  await win.getByTestId('scalper-reverse').click();
  await expect(win.getByTestId('scalper-position')).toHaveText('Short 2 lots');
  await expect.poll(() => placed.length).toBe(2);
  expect(placed[1]).toMatchObject({ mode: 'PAPER', action: 'SELL', lots: 2 });

  await win.getByTestId('scalper-close').click();
  await expect(win.getByTestId('scalper-position')).toHaveText('Flat');
  expect(blocked).toEqual([]);
});

test('hotkeys trade only while the window has focus, and a held key never sends twice', async ({ page }) => {
  const { placed } = await installMock(page);
  const win = await openScalper(page);
  await win.focus();
  await page.keyboard.press('b');
  await expect.poll(() => placed.length).toBe(1);
  expect(placed[0].action).toBe('BUY');
  // a key auto-repeat (repeat: true) is ignored
  await win.dispatchEvent('keydown', { key: 's', repeat: true, bubbles: true });
  await page.waitForTimeout(300);
  expect(placed.length).toBe(1);
  // ↑ raises the lots
  await page.keyboard.press('ArrowUp');
  await expect(win.getByTestId('scalper-lots')).toHaveValue('2');
});

test('REAL opens locked: nothing is sent until Unlock, and a mode change locks it again', async ({ page }) => {
  const { placed } = await installMock(page, { realNet: 130 });
  const win = await openScalper(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await expect(win.getByTestId('scalper-mode')).toContainText('REAL');
  await expect(win.getByTestId('scalper-buy')).toBeDisabled();
  await expect(win.getByTestId('scalper-status')).toContainText('locked');
  await win.focus();
  await page.keyboard.press('b');
  await page.waitForTimeout(300);
  expect(placed).toEqual([]);

  // the broker's 130 units at a 65 lot = Long 2 lots
  await expect(win.getByTestId('scalper-position')).toHaveText('Long 2 lots');
  await win.getByTestId('scalper-unlock').click();
  await win.getByTestId('scalper-close').click();
  await expect.poll(() => placed.length).toBe(1);
  expect(placed[0]).toMatchObject({ mode: 'REAL', close: true });
  expect(placed[0].action).toBeUndefined();

  // back to PAPER and REAL again: locked again
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'PAPER' }).click();
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  await expect(win.getByTestId('scalper-unlock')).toBeVisible();
});

test('the window minimises to a pill, remembers it is open, and is closed from its header', async ({ page }) => {
  await installMock(page);
  const win = await openScalper(page);
  await win.getByRole('button', { name: 'Minimise the scalper' }).click();
  await expect(page.getByTestId('scalper-expand')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('scalper-expand')).toBeVisible();
  await page.getByTestId('scalper-expand').click();
  await expect(page.getByTestId('scalper-buy')).toBeVisible();
  await page.getByRole('button', { name: 'Close the scalper' }).click();
  await expect(page.getByTestId('scalper-window')).toHaveCount(0);
});
