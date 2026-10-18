import type { Page, Route } from '@playwright/test';
import { json, type Call } from './support';

// The Focus Tool with EVERY /api/* call mocked: nothing reaches Dhan or Kotak, row saves land in memory (never
// debug/focus_tool_rows.json), and any write the mock does not expect is refused with 599 (a spec's afterEach fails
// on it). Order routes answer whatever `orderReply` says; nothing is forwarded.

export const EXPIRY = '2026-10-19';
export const STRIKES = ['23100', '23150', '23200'];
export const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const RULES = {
  underlying: 'NIFTY', entryTime: '09:30', exitTime: '', dte: 'Any', expiry: EXPIRY,
  strikeMode: 'ATM', linked: false, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '', lots: 1, side: 'BOTH',
  mode: 'real', levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1',
  slRupees: '', slMultiplier: '', ceSlMultiplier: '', peSlMultiplier: '', slRollStrikes: 0, slRollMax: 2,
  slToCost: false, reSlMode: 'off', reTgtMode: 'off', createdAt: '2026-10-17T04:00:00.000Z', updatedAt: '2026-10-17T04:00:00.000Z', rev: 1,
};

/** A REAL NIFTY 23150 straddle row holding 1 lot a leg, opened an hour ago (past the ghost-drop grace). */
export function realRow(id: string, broker: 'dhan' | 'kotak' | undefined) {
  return {
    ...RULES, id, status: 'entered',
    fill: {
      ceStrike: 23150, peStrike: 23150, ceQty: 65, peQty: 65, ceEntry: 100, peEntry: 90, bookedPnl: 0,
      ceOpenedTs: Date.now() - 3_600_000, peOpenedTs: Date.now() - 3_600_000, ts: '2026-10-17T04:00:00.000Z',
      ...(broker ? { broker } : {}),
    },
  };
}

/** A flat REAL NIFTY ATM straddle row, ready for "Enter now". */
export function flatRealRow(id: string) {
  return { ...RULES, id, status: 'draft' };
}

export function config(rows: unknown[]) {
  // MARGIN and no exit time: neither the row's exit time nor the 15:17 intraday backstop squares the rows off mid-test.
  const group = (underlying: string) => ({ underlying, enabled: false, atmBy: 'Spot', product: 'MARGIN', strikesOffset: 0, bookExit: false, spotHigh: '', spotLow: '' });
  return {
    groups: ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOILM'].map(group), rows,
    riskEnabled: false, targetRupees: '', stopRupees: '', trailEnabled: false, triggerRupees: '', lockRupees: '',
    // Armed today: REAL opens are allowed (exits always are).
    liveRealMoney: true, liveArmedOn: istToday(), deletedRowIds: [],
  };
}

/** Kotak's broker position, as /api/scalper/kotak/poll returns it (through shapeKotakPosition). */
export const kotakPos = (sym: string, netQty: number) => ({
  tradingSymbol: sym, securityId: '1', exchange: 'nse_fo', netQty, productType: 'NRML', lotSize: 65,
  buyQty: netQty > 0 ? netQty : 0, sellQty: netQty < 0 ? -netQty : 0, buyAvg: 0, sellAvg: 100,
  lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
});

/** Dhan's broker position, as /api/scalper/poll returns it. */
export const dhanPos = (securityId: string, sym: string, netQty: number) => ({
  tradingSymbol: sym, securityId, exchangeSegment: 'NSE_FNO', netQty, productType: 'MARGIN',
  buyQty: netQty > 0 ? netQty : 0, sellQty: netQty < 0 ? -netQty : 0, buyAvg: 0, sellAvg: 100,
  costPrice: 100, unrealizedProfit: 0, realizedProfit: 0,
});

export interface OrderReply { status: number; body: unknown }

export interface FocusMock {
  calls: Call[];
  blocked: Call[];
  config: ReturnType<typeof config>;
  /** Saved rows as the page POSTed them, newest last. */
  saves: { rows?: { id: string; orderUnknown?: unknown; fill?: { ceQty?: number; peQty?: number } }[] }[];
  kotakPositions: Record<string, unknown>[];
  dhanPositions: Record<string, unknown>[];
  /** What Kotak's poll answers for positions: the book, or the "not connected" shape (success, empty, positionsError). */
  kotakPositionsError: string | null;
  /** The reply to an order POST. Default: booked. A test may also move the mocked book here (a fill). */
  orderReply: (path: string, body: Record<string, unknown> | null, m: FocusMock) => OrderReply;
  /** One order's status (/api/scalper/orders?orderId=): its `data`, or null for "not found" (the default, like a lag). */
  orderStatus: (orderId: string, m: FocusMock) => Record<string, unknown> | null;
  /** Freeze quantity the lookups report (the broker's own units), or undefined for an older cache without one. */
  freezeQty?: number;
}

export function newFocusMock(): FocusMock {
  return {
    calls: [], blocked: [], config: config([]), saves: [], kotakPositions: [], dhanPositions: [], kotakPositionsError: null,
    orderReply: () => ({ status: 200, body: { success: true, order_id: 'E2E1' } }),
    orderStatus: () => null,
  };
}

export const ORDER_ROUTES = ['/api/scalper/kotak/order', '/api/scalper/fast-order'];
export const orders = (m: FocusMock) => m.calls.filter(c => c.method === 'POST' && ORDER_ROUTES.includes(c.path));

/** The audit events the page logged (POST /api/focus-tool/events) of one kind. */
export const events = (m: FocusMock, kind: string) =>
  m.calls.filter(c => c.method === 'POST' && c.path === '/api/focus-tool/events' && c.body?.kind === kind).map(c => c.body!);

export const lastSavedRow = (m: FocusMock, id: string) => {
  for (let i = m.saves.length - 1; i >= 0; i--) {
    const r = m.saves[i].rows?.find(x => x.id === id);
    if (r) return r;
  }
  return null;
};

/** `view`: the row view to open in ('pro' has "Enter now"; a fresh browser opens in 'table'). */
export async function installFocusMock(page: Page, m: FocusMock, savedBroker: 'dhan' | 'kotak', view: 'pro' | 'table' = 'table'): Promise<void> {
  await page.addInitScript(([b, v]) => {
    try { localStorage.setItem('dhan_algo.selected_broker', b); localStorage.setItem('focusTool.viewMode', v); } catch { /* ignore */ }
  }, [savedBroker, view] as const);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    m.calls.push({ method, path: p, search: u.search, body });

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/focus-tool/rows') {
      if (method === 'GET') return json(route, { success: true, data: m.config });
      if (method === 'POST') {
        m.saves.push(body as FocusMock['saves'][number]);
        if (Array.isArray(body?.rows)) m.config = { ...m.config, rows: body.rows as unknown[] };
        return json(route, { success: true, data: m.config, conflicts: [], refusedDeletes: [] });
      }
    }
    if (p === '/api/focus-tool/presets' && method === 'GET') return json(route, { success: true, data: [] });
    // Journal / event log / feed starters: harmless, answered locally.
    if (method === 'POST' && ['/api/focus-tool/events', '/api/focus-tool/sim-trades', '/api/focus-tool/live-ws', '/api/options/live', '/api/live-indices'].includes(p)) {
      return json(route, { success: true });
    }
    // Spot, so an ATM row resolves its strikes (23150).
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, updated_at: new Date().toISOString(), quotes: { 'NIFTY 50': { ltp: 23150, change_pct: 0 } } });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXPIRY] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { last_price: 100, previous_close_price: 100 }, pe: { last_price: 90, previous_close_price: 90 } }]));
      return json(route, { success: true, data: { spot: 23150, prev_close: 23000, chain: { oc } } });
    }
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(STRIKES.map((k, i) => [k, { ceId: String(100 + i), peId: String(200 + i) }]));
      return json(route, { success: true, data: { lotSize: 65, strikes, ...(m.freezeQty ? { freezeQty: m.freezeQty } : {}) } });
    }
    if (p === '/api/scalper/kotak/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { ceSymbol: `NIFTY26O19${k}CE`, peSymbol: `NIFTY26O19${k}PE` }]));
      return json(route, { success: true, data: { lotSize: 65, strikes, ...(m.freezeQty ? { freezeQty: m.freezeQty } : {}) } });
    }
    if (p === '/api/scalper/poll') return json(route, { success: true, positions: m.dhanPositions, positionsError: null, orders: [], trades: [] });
    if (p === '/api/scalper/kotak/poll') {
      return json(route, m.kotakPositionsError
        ? { success: true, positions: [], positionsError: m.kotakPositionsError, orders: [], trades: [] }
        : { success: true, positions: m.kotakPositions, positionsError: null, orders: [], trades: [] });
    }
    if (p === '/api/scalper/funds' || p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 500000 } });
    if (p === '/api/scalper/orders' || p === '/api/scalper/kotak/orders') {
      // A single order's status (fill confirmation / traded price): unknown to the mock → "not found", like a lag.
      const oid = u.searchParams.get('orderId');
      if (oid) {
        const st = m.orderStatus(oid, m);
        return st ? json(route, { success: true, data: st }) : json(route, { success: false, error: 'Order not found' }, 404);
      }
      return json(route, { success: true, data: [] });
    }
    if (p === '/api/scalper/trades' || p === '/api/scalper/kotak/trades') return json(route, { success: true, data: [] });
    if (method === 'POST' && ORDER_ROUTES.includes(p)) {
      const r = m.orderReply(p, body, m);
      return json(route, r.body, r.status);
    }

    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    // Every other read (VIX, futures, VWAP, range...) answers "unavailable": nothing reaches a broker.
    return json(route, { success: false, error: 'e2e' });
  });
}

export async function openFocusTool(page: Page, readyButton: string): Promise<void> {
  await page.goto('/focus-tool', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: readyButton }).first().waitFor({ timeout: 90_000 });
}
