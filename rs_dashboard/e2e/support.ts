import { createHmac, randomUUID } from 'node:crypto';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { COOKIE_SECRET, SESSION_COOKIE } from '../lib/auth';

/** A validly signed dashboard session cookie (the proxy only checks the HMAC). */
export function sessionCookieValue(): string {
  const uuid = randomUUID();
  return `${uuid}.${createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex')}`;
}

export async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: SESSION_COOKIE, value: sessionCookieValue(), domain: 'localhost', path: '/' }]);
}

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ─── Scalper mock broker ─────────────────────────────────────────────────

export interface Call { method: string; path: string; search: string; body: Record<string, unknown> | null }

/** Mutable per-test broker state; the mocked routes read it on every request. */
export interface ScalperMock {
  /** Order-related calls the mock explicitly handled. */
  calls: Call[];
  /** Non-GET requests nothing here mocks: refused with 599 and listed so a test can assert there were none. */
  blocked: Call[];
  positions: Record<string, unknown>[];
  /** Raw GET /api/super-order rows. */
  superOrders: Record<string, unknown>[];
  quotesFresh: boolean;
  ltp: number;
  superListFails: boolean;
  superDeleteFails: boolean;
}

export function newScalperMock(): ScalperMock {
  return { calls: [], blocked: [], positions: [], superOrders: [], quotesFresh: true, ltp: 100.07, superListFails: false, superDeleteFails: false };
}

/** An open long NIFTY 24000 CE, 1 lot (75), under the given product. */
export function longCall(productType: 'MARGIN' | 'INTRADAY' = 'MARGIN'): Record<string, unknown> {
  return {
    tradingSymbol: 'NIFTY-Oct2026-24000-CE', securityId: '111', exchangeSegment: 'NSE_FNO', productType,
    netQty: 75, buyAvg: 100, costPrice: 100, sellAvg: 0, unrealizedProfit: 5, realizedProfit: 0,
    positionType: 'LONG', drvExpiryDate: '2026-10-13', drvOptionType: 'CALL', drvStrikePrice: 24000, buyQty: 75, sellQty: 0,
  };
}

/** A filled bracket on security 111: entry traded, target and stop resting. */
export const LIVE_BRACKET = {
  orderId: '5001', securityId: '111', orderStatus: 'PENDING',
  legDetails: [
    { legName: 'ENTRY_LEG', orderStatus: 'TRADED' },
    { legName: 'TARGET_LEG', orderStatus: 'PENDING' },
    { legName: 'STOP_LOSS_LEG', orderStatus: 'TRIGGER_PENDING' },
  ],
};

const STRIKE_IDS: Record<string, [string, string]> = { '23950': ['110', '210'], '24000': ['111', '211'], '24050': ['112', '212'] };

/**
 * Mocks everything the Advanced Scalper needs from the broker. Safety net: any non-GET /api/ request
 * that is not explicitly mocked here is refused (599) instead of being forwarded, so a test can never
 * reach a real order route on a machine that has a live Dhan token.
 */
export async function installScalperMock(page: Page, m: ScalperMock): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const record = () => m.calls.push({ method, path: p, search: u.search, body: method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null) });

    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-13'] });
    if (p === '/api/options/chain') {
      const oc: Record<string, unknown> = {};
      for (const k of Object.keys(STRIKE_IDS)) oc[`${k}.000000`] = { ce: { previous_close_price: 100 }, pe: { previous_close_price: 90 } };
      return json(route, { success: true, data: { spot: 24000, prev_close: 23900, chain: { oc } } });
    }
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(Object.entries(STRIKE_IDS).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe, ceSymbol: `N${k}CE`, peSymbol: `N${k}PE` }]));
      return json(route, { success: true, data: { lotSize: 75, strikes } });
    }
    if (p === '/api/options/live') {
      const strikes = Object.fromEntries(Object.keys(STRIKE_IDS).map(k => [k, { ce: { ltp: k === '24000' ? m.ltp : 80 }, pe: { ltp: 90.02 } }]));
      // The feed poll rejects quotes older than 60 s, so "stale" is simulated by ageing updated_at.
      const updated_at = new Date(m.quotesFresh ? Date.now() : Date.now() - 120_000).toISOString();
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-10-13', spot: 24000, updated_at, strikes } });
    }
    if (p === '/api/scalper/all' || p === '/api/scalper/poll') {
      return json(route, { success: true, positions: m.positions, orders: [], trades: [], funds: {}, pnl_guard: null, pnl_guard_unknown: true });
    }
    if (p === '/api/scalper/positions') return json(route, { success: true, positions: m.positions });
    if (p === '/api/scalper/trades') return json(route, { success: true, trades: [] });

    if (p === '/api/super-order') {
      record();
      if (method === 'GET') return m.superListFails ? json(route, { success: false, error: 'boom' }, 502) : json(route, { success: true, orders: m.superOrders });
      if (method === 'DELETE') return m.superDeleteFails ? json(route, { success: false, error: 'rejected' }) : json(route, { success: true });
      if (method === 'POST') return json(route, { success: true, order_id: '9001' });
    }
    if (p === '/api/scalper/fast-order') { record(); return json(route, { success: true, order_id: '7001' }); }

    // Read-style POST (history reconstruction) and the P&L-guard read: answered locally so a machine with a
    // live token never reaches Dhan from a test. The page tolerates both failing.
    if (p === '/api/scalper/mtm-history') return json(route, { success: false, error: 'e2e' });
    if (p === '/api/pnl-exit' && method === 'GET') return json(route, { success: false, error: 'e2e' }, 500);

    // Background bridge starters the page fires on load: harmless, answered locally.
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });

    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body: req.postDataJSON() as Record<string, unknown> | null });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' }); }
    return route.continue();
  });
}

/** Calls that would move money or cancel something: every non-GET. */
export const writes = (m: ScalperMock) => m.calls.filter(c => c.method !== 'GET');

export async function openScalper(page: Page): Promise<void> {
  await page.goto('/advanced-scalper', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'BUY CE' }).waitFor({ timeout: 60_000 });
  // The strike ladder, lookup and first quote poll land a moment after the buttons render.
  await page.getByText('₹100.07').first().waitFor({ timeout: 30_000 });
}
