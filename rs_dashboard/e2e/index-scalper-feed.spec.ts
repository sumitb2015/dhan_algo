import type { AddressInfo } from 'node:net';
import { expect, test, type Page, type Route } from '@playwright/test';
import { json, sessionCookieValue, signIn } from './support';

// /index-scalper's two real-money plumbing paths, checked without a market and without placing anything:
//  1. LIVE PRICES: a real local WebSocket server stands in for the Python options bridge's push server. The page finds
//     it through the bridge status (`ws_port`), as in production, and every price on screen must come from its frames:
//     the HTTP fallback answers with no quotes.
//  2. ORDER ROUTE: the real /api/scalper/fast-order is sent only requests it must refuse BEFORE any Dhan call (400 /
//     401), with a security id that does not exist. Never add a valid-order case here: with a live token it would trade.

// Next ships the `ws` package (no type declarations) as next/dist/compiled/ws: a real WebSocket server for the test.
// @ts-expect-error no types for next's compiled ws
import * as wsLib from 'next/dist/compiled/ws';
const { Server } = wsLib as unknown as { Server: new (o: { port: number; host: string }) => WsServer };
interface WsClient { send: (s: string) => void; readyState: number }
interface WsServer { clients: Set<WsClient>; address: () => AddressInfo; on: (e: string, f: (c?: WsClient) => void) => void; close: (cb?: () => void) => void }

const IDS: Record<string, [string, string]> = { '25300': ['301', '401'], '25350': ['302', '402'], '25400': ['303', '403'] };

function frame(spot: number, ce350: number) {
  const strikes = Object.fromEntries(Object.keys(IDS).map(k => [k, {
    strike: Number(k),
    ce: { ltp: k === '25350' ? ce350 : 200, oi: 1_000_000, oi_chg_pct: 1, change_pct: 1, buildup: '' },
    pe: { ltp: 180, oi: 1_000_000, oi_chg_pct: 1, change_pct: 1, buildup: '' },
  }]));
  return JSON.stringify({ type: 'quotes', underlying: 'NIFTY', expiry: '2026-12-01', spot, atm: 25350, straddle_premium: 0, strikes, updated_at: new Date().toISOString() });
}

async function mockPage(page: Page, wsPort: number, http: { liveGets: number }) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/index-scalper/candles') return json(route, { success: true, candles: [{ t: 1795405500, o: 25300, h: 25400, l: 25290, c: 25350 }], interval: '5' });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') {
      return json(route, { success: true, data: { lotSize: 65, strikes: Object.fromEntries(Object.entries(IDS).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }])) } });
    }
    if (p === '/api/options/live') {
      if (req.method() === 'POST') return json(route, { success: true });
      http.liveGets++;
      // status carries the push server's port; the HTTP fallback itself has NO quotes, so prices can only come over the WS
      return json(route, { success: true, status: { status: 'RUNNING', ws_port: wsPort }, quotes: null });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 100000, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions' || p === '/api/scalper/orders' || p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (req.method() !== 'GET') return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false}' });
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

test.describe('Index Scalper feed + order route', () => {
  let server: WsServer;
  let port = 0;
  let connections = 0;

  test.beforeEach(async () => {
    server = new Server({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(r => server.on('listening', () => r()));
    port = server.address().port;
    connections = 0;
    server.on('connection', () => { connections++; });
  });
  test.afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  const push = (s: string) => { for (const c of server.clients) if (c.readyState === 1) c.send(s); };
  const heartbeat = (feedAtMs: number) => push(JSON.stringify({ type: 'heartbeat', underlying: 'NIFTY', expiry: '2026-12-01', feed_at: new Date(feedAtMs).toISOString(), pushed_at: Date.now() / 1000 }));

  test('a quiet market is not stale while the bridge heartbeat says Dhan is still sending; a frozen feed is', async ({ page, context }) => {
    test.setTimeout(90_000);
    const http = { liveGets: 0 };
    await signIn(context);
    await mockPage(page, port, http);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(0);
    push(frame(25351, 210.5)); // one price, then no price change at all

    // 14 s of heartbeats with a fresh feed_at (Dhan still sending, prices unchanged): never stale
    for (let i = 0; i < 7; i++) { heartbeat(Date.now()); await page.waitForTimeout(2_000); }
    await expect(page.getByText(/Live ticks are stale/)).toHaveCount(0);

    // heartbeats keep coming but feed_at stops moving (Dhan's socket froze inside a running bridge): stale after 10 s
    const frozen = Date.now();
    for (let i = 0; i < 7; i++) { heartbeat(frozen); await page.waitForTimeout(2_000); }
    await expect(page.getByText(/Live ticks are stale/)).toBeVisible();
  });

  test('the ticket refuses a limit price off the 0.05 tick and names the nearest valid prices', async ({ page, context }) => {
    const http = { liveGets: 0 };
    await signIn(context);
    await mockPage(page, port, http);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(0);
    push(frame(25351, 210.5));
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await ticket.getByRole('button', { name: 'Limit', exact: true }).click();
    await ticket.getByLabel('Price').fill('180.03');
    await ticket.getByRole('button', { name: /^Buy / }).click();
    await expect(ticket).toContainText('Price 180.03 is not a multiple of ₹0.05: use 180.00 or 180.05');
    await expect(page.getByTestId('position-chip')).toHaveCount(0);
  });

  test('chain, ticket and spot update from WebSocket pushes in real time', async ({ page, context }) => {
    const http = { liveGets: 0 };
    await signIn(context);
    await mockPage(page, port, http);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Option chain' }).click();
    const panel = page.getByTestId('option-chain-panel');
    push(frame(25351.1, 210.5));
    await expect(panel.getByRole('button', { name: 'Trade 25350 CE' })).toHaveText('210.50', { timeout: 5_000 });
    await expect(panel.getByText('LIVE', { exact: true })).toBeVisible();

    // an open ticket follows the push too
    await panel.getByRole('button', { name: 'Trade 25350 CE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket.getByRole('button', { name: /^Buy 210\.50/ })).toBeVisible();

    // each new frame lands on screen within a frame or two, no polling delay
    for (const [spot, ltp] of [[25355.25, 214.05], [25349.8, 209.35], [25362.4, 221.9]] as const) {
      const t0 = Date.now();
      push(frame(spot, ltp));
      await expect(panel.getByRole('button', { name: 'Trade 25350 CE' })).toHaveText(ltp.toFixed(2), { timeout: 2_000 });
      await expect(ticket.getByRole('button', { name: new RegExp(`^Buy ${ltp.toFixed(2).replace('.', '\\.')}`) })).toBeVisible();
      await expect(page.getByTitle('Live tick bridge')).toContainText(spot.toFixed(2));
      expect(Date.now() - t0).toBeLessThan(2_000);
    }
  });

  test('a paper order fills at the latest pushed price, and stops filling once pushes stop (stale)', async ({ page, context }) => {
    test.setTimeout(90_000);
    const http = { liveGets: 0 };
    await signIn(context);
    await mockPage(page, port, http);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThan(0);
    push(frame(25351, 210.5));
    push(frame(25353, 212.25));
    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByRole('button', { name: 'Trade 25350 CE' })).toHaveText('212.25', { timeout: 5_000 });
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('order-ticket')).toContainText('@ 212.25');

    // no push for >10 s: the feed is stale, a market order is refused and the banner says so
    await expect(page.getByText(/Live ticks are stale/)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await expect(page.getByTestId('order-ticket')).toContainText('stale');
  });
});

test.describe('Index Scalper order route refuses bad orders before reaching Dhan', () => {
  const headers = () => ({ Cookie: `dhan_session=${sessionCookieValue()}`, 'Content-Type': 'application/json' });
  // securityId '0' does not exist, so even a request that slipped past validation could not trade anything.
  const BASE = { securityId: '0', exchangeSegment: 'NSE_FNO', side: 'BUY', productType: 'INTRADAY', orderType: 'MARKET', quantity: 65, source: 'isx' };

  test('unauthenticated requests are refused', async ({ request }) => {
    const res = await request.post('/api/scalper/fast-order', { data: BASE, headers: { 'Content-Type': 'application/json' } });
    expect(res.status()).toBe(401);
  });

  for (const [name, patch, message] of [
    ['over the isx cap (20 lots x 75 = 1500 units)', { quantity: 1501 }, /cap|exceeds|max/i],
    ['a fractional quantity', { quantity: 6.5 }, /quantity/i],
    ['an unknown side', { side: 'HOLD' }, /side/i],
    ['a LIMIT without a price', { orderType: 'LIMIT', price: 0 }, /price/i],
    ['a stop without a trigger', { orderType: 'STOP_LOSS_MARKET', triggerPrice: 0 }, /trigger/i],
    ['an unknown product', { productType: 'XYZ' }, /productType/i],
  ] as [string, Record<string, unknown>, RegExp][]) {
    test(`refuses ${name}`, async ({ request }) => {
      const res = await request.post('/api/scalper/fast-order', {
        headers: headers(), data: { ...BASE, ...patch, idempotencyKey: `isxe2e${Math.random().toString(36).slice(2, 10)}` },
      });
      const body = await res.json() as { success: boolean; error?: string; unknown?: boolean };
      expect(res.status()).toBe(400);
      expect(body.success).toBe(false);
      expect(body.unknown).toBeUndefined();
      expect(body.error).toMatch(message);
    });
  }
});
