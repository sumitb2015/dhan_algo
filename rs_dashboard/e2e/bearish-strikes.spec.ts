import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { applyOp, type LedgerFile, type LedgerOp } from '../lib/bearishLedger';

// Bearish Strikes, SIM mode only. Every /api call is answered here; any non-GET that is not handled is refused (599)
// and fails the test, and the test asserts /api/scalper/fast-order was never touched. Never add a REAL-mode case: on a
// machine with a live token it would place a real order.

const pad = (n: number) => String(n).padStart(2, '0');
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** 75 one-minute bars from 09:15, price = f(i). */
function bars(f: (i: number) => number) {
  return Array.from({ length: 75 }, (_, i) => {
    const mins = 9 * 60 + 15 + i;
    const c = f(i);
    return { t: `${istToday()} ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
  });
}

const DOWN = bars((i) => 200 - i);        // ends ~126, falling the whole session  -> bearish
const UP = bars((i) => 100 + i);          // rising                                -> not bearish

function strike(ltp: number) {
  return { ltp, oi: 65 * 500, volume: 65 * 800, open: 220, prev_close: 210, change_pct: -10, oi_chg_pct: 5, buildup: 'SB' };
}

async function install(page: Page) {
  const seen = { fastOrder: 0, blocked: [] as string[], paths: [] as string[] };
  let ledger: LedgerFile = { rev: 0, positions: [] };
  const spot = 24500;
  const px = { ce24600: 100 };
  const quotes = () => ({
    updated_at: new Date().toISOString(), underlying: 'NIFTY', expiry: '2099-12-31', spot, atm: 24500, straddle_premium: 200,
    strikes: {
      '24600': { strike: 24600, ce: strike(px.ce24600), pe: strike(40) },
      '24700': { strike: 24700, ce: strike(100), pe: strike(30) },
      '24800': { strike: 24800, ce: { ...strike(100), buildup: 'LB' }, pe: strike(20) },   // bearish bars but LONG buildup
      '24400': { strike: 24400, ce: strike(150), pe: strike(100) },
    },
  });

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const method = req.method();
    seen.paths.push(p);
    if (p === '/api/scalper/fast-order') { seen.fastOrder++; return json(route, { success: false, error: 'e2e: orders disabled' }, 400); }
    if (p === '/api/scalper/poll') return json(route, { success: true, positions: [], orders: [{ orderId: '9001', orderStatus: 'TRADED', tradingSymbol: 'NIFTY-Oct2026-24600-CE', transactionType: 'SELL', quantity: 65 }], trades: [] });
    if (p === '/api/scalper/nifty-prev-close') {
      const u = new URL(req.url()).searchParams.get('underlying');
      return json(route, { success: true, prevClose: u === 'VIX' ? 13.8 : 24400, source: 'dhan' });
    }
    if (p === '/api/live-indices') return json(route, { success: true });
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, updated_at: new Date().toISOString(), quotes: {
        NIFTY: { ltp: 24512.35, prev_close: 24512.35, change_pct: 0 }, VIX: { ltp: 13.42, prev_close: 13.42, change_pct: 0 } } });   // feed's own prev_close deliberately wrong: the page must not use it
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2099-12-31'] });
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      return json(route, { success: true, status: { status: 'RUNNING', subscribed: 6 }, quotes: quotes(), history: { history: [] } });
    }
    if (p === '/api/scalper/lookup') return json(route, { success: true, data: { lotSize: 65, strikes: { '24600': { ceId: '1', peId: '2' } } } });
    if (p === '/api/scalper/zerodha/lookup') return json(route, { success: true, data: { lotSize: 65, strikes: { '24600': { ceSymbol: 'NIFTY26O2024600CE', peSymbol: 'NIFTY26O2024600PE' } } } });
    if (p === '/api/scalper/zerodha/poll') return json(route, { success: true, positions: [], positionsError: null, orders: [{ orderId: '9002', orderStatus: 'COMPLETE', tradingSymbol: 'NIFTY26O2024600CE', transactionType: 'SELL', quantity: 65 }], trades: [] });
    if (p === '/api/bearish-strikes/bars') {
      const keys = (new URL(req.url()).searchParams.get('contracts') ?? '').split(',').filter(Boolean);
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = k === '24700CE' ? UP : DOWN;
      return json(route, { success: true, bars: out, errors: {} });
    }
    if (p === '/api/bearish-strikes/state') {
      if (method === 'GET') return json(route, { success: true, ...ledger });
      try { ledger = applyOp(ledger, req.postDataJSON() as LedgerOp); return json(route, { success: true, ...ledger }); }
      catch (e) { return json(route, { success: false, error: String((e as Error).message) }, 400); }
    }
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    seen.blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  return { ...seen, px };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('lists only strikes below ST, VWAP and EMA20; SIM sell then exit goes through the ledger, never the broker', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'CE', exact: true }).click();   // CE only
  const row = page.getByRole('row').filter({ hasText: '24600' });
  await expect(row).toContainText('CE', { timeout: 60_000 });
  await expect(row).toContainText(/BEARISH/);
  await expect(page.getByRole('row').filter({ hasText: '24700' })).toHaveCount(0);   // rising option is filtered out
  await expect(page.getByRole('button', { name: 'SIM', exact: true })).toBeVisible();
  await expect(page.getByText('24,512.35')).toBeVisible();          // header: Nifty + % change
  await expect(page.getByText('▲ 0.46%')).toBeVisible();
  await expect(page.getByText('13.42')).toBeVisible();               // header: India VIX + % change
  await expect(page.getByText('▼ 2.75%')).toBeVisible();

  await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
  const ticket = page.getByRole('heading', { name: /Add New Leg/ });
  await expect(ticket).toBeVisible();
  await expect(page.getByRole('button', { name: 'BUY', exact: true })).toHaveCount(0);   // sell-only page
  await expect(page.getByRole('button', { name: 'SL-L' })).toHaveCount(0);               // no resting-stop entries
  await page.getByRole('button', { name: /Place & Add Leg/ }).click();

  const pos = page.getByRole('region', { name: 'Positions on this page' });
  await expect(pos).toContainText('SIM');
  await expect(pos).toContainText('24600 CE');
  await expect(pos).toContainText('OPEN');

  await page.getByRole('button', { name: 'Exit 24600 CE' }).click();
  await expect(page.getByRole('dialog', { name: 'Exit position' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Exit position' }).getByRole('button', { name: /exit|confirm|place/i }).last().click();
  await expect(pos).toContainText('CLOSED');

  expect(seen.fastOrder).toBe(0);
  expect(seen.blocked).toEqual([]);
});

test('header opens the broker order book, trade book and positions', async ({ page }) => {
  await install(page);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Orders · Trades · Positions/ }).click();
  await expect(page.getByRole('heading', { name: 'Broker Orders, Trades & Positions' })).toBeVisible();
  await expect(page.getByText('NIFTY-Oct2026-24600-CE')).toBeVisible({ timeout: 30_000 });
});

test('an open short alerts when its price goes above the Supertrend line, even if the filters hide it', async ({ page }) => {
  const m = await install(page);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CE', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '24600' })).toContainText(/BEARISH/, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
  await page.getByRole('button', { name: /Place & Add Leg/ }).click();
  const pos = page.getByRole('region', { name: 'Positions on this page' });
  await expect(pos).toContainText('OPEN');
  await expect(page.getByRole('alert', { name: 'Position alerts' })).toHaveCount(0);       // nothing wrong yet

  m.px.ce24600 = 400;                                                                        // far above the Supertrend line
  const banner = page.getByRole('alert', { name: 'Position alerts' });
  await expect(banner).toContainText('moving against you', { timeout: 30_000 });
  await expect(banner).toContainText('24600 CE');
  await expect(banner).toContainText('Supertrend');
  // Contrast: the global white-mode rules once forced this label dark red on red. It must be white in every theme.
  const exitNow = banner.getByRole('button', { name: /Exit 24600 CE now/ });
  await expect(exitNow).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(page.getByText('1 ALERT', { exact: true })).toBeVisible();
  await expect.poll(() => page.title()).toContain('ALERT');

  await banner.getByRole('button', { name: /Exit 24600 CE now/ }).click();                  // the alert leads straight to the exit ticket
  await expect(page.getByRole('dialog', { name: 'Exit position' })).toBeVisible();
  expect(m.fastOrder).toBe(0);
  expect(m.blocked).toEqual([]);
});

test('OI buildup is highlighted against the bearish signal and can be filtered', async ({ page }) => {
  await install(page);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CE', exact: true }).click();
  const sb = page.getByRole('row').filter({ hasText: '24600' });
  const lb = page.getByRole('row').filter({ hasText: '24800' });
  await expect(sb).toContainText('OI ✓ SB', { timeout: 60_000 });          // short buildup backs the signal
  await expect(lb).toContainText('OI ⚠ LB');                              // long buildup contradicts it

  await page.getByRole('button', { name: 'Not LB' }).click();
  await expect(lb).toHaveCount(0);
  await expect(sb).toHaveCount(1);
  await page.getByRole('button', { name: 'SB / LU' }).click();
  await expect(sb).toHaveCount(1);
  await expect(lb).toHaveCount(0);
  await page.getByRole('button', { name: 'Any', exact: true }).click();
  await expect(lb).toHaveCount(1);
});

for (const theme of ['light', 'beige']) {
  test(`alert banner EXIT NOW label stays white in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((t) => { try { localStorage.setItem('dhan-theme', t); } catch { /* storage blocked */ } }, theme);
    const m = await install(page);
    await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'CE', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: '24600' })).toContainText(/BEARISH/, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
    await page.getByRole('button', { name: /Place & Add Leg/ }).click();
    await expect(page.getByRole('region', { name: 'Positions on this page' })).toContainText('OPEN');
    m.px.ce24600 = 400;
    const banner = page.getByRole('alert', { name: 'Position alerts' });
    await expect(banner).toContainText('moving against you', { timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light'))).toBe(theme);
    await expect(banner.getByRole('button', { name: /Exit 24600 CE now/ })).toHaveCSS('color', 'rgb(255, 255, 255)');
  });
}

test('Zerodha can be picked: its lookup and book are used, and SIM never reaches a broker order route', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  const picker = page.getByRole('combobox', { name: 'Broker for new orders' });
  // Before hydration the select has no handler: retry until the page keeps the choice.
  await expect(async () => { await picker.selectOption('zerodha'); await expect(picker).toHaveValue('zerodha', { timeout: 1_000 }); }).toPass({ timeout: 30_000 });
  await expect.poll(() => seen.paths.includes('/api/scalper/zerodha/lookup'), { timeout: 60_000 }).toBe(true);

  await page.getByRole('button', { name: /Orders · Trades · Positions/ }).click();
  await expect(page.getByText('NIFTY26O2024600CE').first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');

  expect(seen.paths.filter((x) => /\/order$|fast-order/.test(x))).toEqual([]);
  expect(seen.blocked).toEqual([]);
});
