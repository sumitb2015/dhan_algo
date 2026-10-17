import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// The Focus Tool's broker ownership (lib/focusToolBroker.ts), in the browser with EVERY /api/* call mocked: nothing
// reaches Dhan or Kotak, row saves land in memory (never debug/focus_tool_rows.json), and any write the mock does not
// expect is refused with 599 and fails the test.
//
// The broker selector is one localStorage setting shared by every dashboard page. Before 2026-10-17 a REAL row opened
// on Kotak, reloaded after another page had picked Dhan, ran on Dhan: its next exit read the leg flat in Dhan's book
// and dropped it from the ledger, leaving the Kotak short unwatched.

const EXPIRY = '2026-10-19';
const STRIKES = ['23100', '23150', '23200'];
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

function realRow(id: string, broker: 'dhan' | 'kotak' | undefined) {
  return {
    id, underlying: 'NIFTY', entryTime: '09:30', exitTime: '', dte: 'Any', expiry: EXPIRY,
    strikeMode: 'ATM', linked: false, ceOffset: 0, peOffset: 0, cePremium: '', pePremium: '', lots: 1, side: 'BOTH',
    status: 'entered', mode: 'real', levelHigh: '', levelLow: '', levelVw: false, vwapInterval: '1', vwapBufferPct: '0.1',
    slRupees: '', slMultiplier: '', ceSlMultiplier: '', peSlMultiplier: '', slRollStrikes: 0, slRollMax: 2,
    slToCost: false, reSlMode: 'off', reTgtMode: 'off', createdAt: '2026-10-17T04:00:00.000Z', updatedAt: '2026-10-17T04:00:00.000Z', rev: 1,
    fill: {
      ceStrike: 23150, peStrike: 23150, ceQty: 65, peQty: 65, ceEntry: 100, peEntry: 90, bookedPnl: 0,
      // Opened an hour ago: past the ghost-drop grace, so a flat-reading book WOULD drop the leg without the fix.
      ceOpenedTs: Date.now() - 3_600_000, peOpenedTs: Date.now() - 3_600_000, ts: '2026-10-17T04:00:00.000Z',
      ...(broker ? { broker } : {}),
    },
  };
}

function config(rows: unknown[]) {
  // MARGIN and no exit time: neither the row's exit time nor the 15:17 intraday backstop squares the rows off mid-test.
  const group = (underlying: string) => ({ underlying, enabled: false, atmBy: 'Spot', product: 'MARGIN', strikesOffset: 0, bookExit: false, spotHigh: '', spotLow: '' });
  return {
    groups: ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOILM'].map(group), rows,
    riskEnabled: false, targetRupees: '', stopRupees: '', trailEnabled: false, triggerRupees: '', lockRupees: '',
    // Armed today, so the row's manual Exit is enabled (the arm only gates opens; a reduce is always allowed).
    liveRealMoney: true, liveArmedOn: istToday(), deletedRowIds: [],
  };
}

/** Kotak's broker position, as /api/scalper/kotak/poll returns it (through shapeKotakPosition). */
const kotakPos = (sym: string, netQty: number) => ({
  tradingSymbol: sym, securityId: '1', exchange: 'nse_fo', netQty, productType: 'NRML', lotSize: 65,
  buyQty: 0, sellQty: -netQty, buyAvg: 0, sellAvg: 100, lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
});

interface Mock {
  calls: Call[];
  blocked: Call[];
  config: ReturnType<typeof config>;
  /** Saved rows as the page POSTed them, newest last. */
  saves: { rows?: { id: string; fill?: { ceQty?: number; peQty?: number } }[] }[];
  kotakPositions: Record<string, unknown>[];
  /** What Kotak's poll answers for positions: the book, or the "not connected" shape (success, empty, positionsError). */
  kotakPositionsError: string | null;
}

async function install(page: Page, m: Mock, savedBroker: 'dhan' | 'kotak'): Promise<void> {
  await page.addInitScript(b => { try { localStorage.setItem('dhan_algo.selected_broker', b); } catch { /* ignore */ } }, savedBroker);
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
        m.saves.push(body as Mock['saves'][number]);
        if (Array.isArray(body?.rows)) m.config = { ...m.config, rows: body.rows as unknown[] };
        return json(route, { success: true, data: m.config, conflicts: [], refusedDeletes: [] });
      }
    }
    if (p === '/api/focus-tool/presets' && method === 'GET') return json(route, { success: true, data: [] });
    // Journal / event log / feed starters: harmless, answered locally.
    if (method === 'POST' && ['/api/focus-tool/events', '/api/focus-tool/sim-trades', '/api/focus-tool/live-ws', '/api/options/live', '/api/live-indices'].includes(p)) {
      return json(route, { success: true });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXPIRY] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { last_price: 100, previous_close_price: 100 }, pe: { last_price: 90, previous_close_price: 90 } }]));
      return json(route, { success: true, data: { spot: 23150, prev_close: 23000, chain: { oc } } });
    }
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(STRIKES.map((k, i) => [k, { ceId: String(100 + i), peId: String(200 + i) }]));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
    }
    if (p === '/api/scalper/kotak/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => [k, { ceSymbol: `NIFTY26O19${k}CE`, peSymbol: `NIFTY26O19${k}PE` }]));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
    }
    if (p === '/api/scalper/poll') return json(route, { success: true, positions: [], positionsError: null, orders: [], trades: [] });
    if (p === '/api/scalper/kotak/poll') {
      return json(route, m.kotakPositionsError
        ? { success: true, positions: [], positionsError: m.kotakPositionsError, orders: [], trades: [] }
        : { success: true, positions: m.kotakPositions, positionsError: null, orders: [], trades: [] });
    }
    if (p === '/api/scalper/funds' || p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 500000 } });
    if (p === '/api/scalper/orders' || p === '/api/scalper/kotak/orders') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/trades' || p === '/api/scalper/kotak/trades') return json(route, { success: true, data: [] });
    // Order routes: recorded; a test asserts on them. Never forwarded.
    if (p === '/api/scalper/kotak/order' || p === '/api/scalper/fast-order') return json(route, { success: true, order_id: 'E2E1' });

    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    // Every other read (indices, VIX, futures, VWAP, range...) answers "unavailable": nothing reaches a broker.
    return json(route, { success: false, error: 'e2e' });
  });
}

const orders = (m: Mock) => m.calls.filter(c => c.method === 'POST' && (c.path === '/api/scalper/kotak/order' || c.path === '/api/scalper/fast-order'));
const lastSavedQty = (m: Mock, id: string) => {
  for (let i = m.saves.length - 1; i >= 0; i--) {
    const r = m.saves[i].rows?.find(x => x.id === id);
    if (r) return { ce: Number(r.fill?.ceQty ?? 0), pe: Number(r.fill?.peQty ?? 0) };
  }
  return null;
};

async function open(page: Page): Promise<void> {
  await page.goto('/focus-tool', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Exit CE leg' }).first().waitFor({ timeout: 90_000 });
}

let m: Mock;

test.beforeEach(async ({ context }) => {
  m = { calls: [], blocked: [], config: config([]), saves: [], kotakPositions: [], kotakPositionsError: null };
  await signIn(context);
});

test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

test('a page saved on Dhan follows the broker its open REAL row is on, without changing the saved choice', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -65), kotakPos('NIFTY26O1923150PE', -65)];
  await install(page, m, 'dhan');
  await open(page);

  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Kotak' }) }).first();
  await expect(select).toHaveValue('kotak');
  await expect(select).toBeDisabled();
  // The dashboard-wide choice is untouched: other pages still open on Dhan.
  expect(await page.evaluate(() => localStorage.getItem('dhan_algo.selected_broker'))).toBe('dhan');
  // The page now reads the Kotak book the row's legs are in.
  await expect.poll(() => m.calls.some(c => c.path === '/api/scalper/kotak/poll')).toBe(true);
  expect(orders(m)).toEqual([]);
  expect(lastSavedQty(m, 'ft_kotak_1') ?? { ce: 65, pe: 65 }).toEqual({ ce: 65, pe: 65 });
});

test('after following Kotak, Exit closes the leg on Kotak with the Kotak contract — never through Dhan', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositions = [kotakPos('NIFTY26O1923150CE', -65), kotakPos('NIFTY26O1923150PE', -65)];
  await install(page, m, 'dhan');
  await open(page);
  await expect(page.locator('select').filter({ has: page.locator('option', { hasText: 'Kotak' }) }).first()).toHaveValue('kotak');

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect.poll(() => orders(m).length).toBe(1);
  expect(orders(m)[0].path).toBe('/api/scalper/kotak/order');
  expect(orders(m)[0].body).toMatchObject({ tradingsymbol: 'NIFTY26O1923150CE', side: 'BUY', quantity: 65, exchange: 'nse_fo' });
  expect(m.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
});

test('rows split across brokers: the selector unlocks and the other broker’s row refuses every order', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak'), realRow('ft_dhan_1', 'dhan')]);
  await install(page, m, 'dhan');
  await open(page);

  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Kotak' }) }).first();
  await expect(select).toHaveValue('dhan');
  await expect(select).toBeEnabled();
  // The Kotak row's leg buttons are disabled and say why; the Dhan row's are live.
  const exits = page.getByRole('button', { name: 'Exit CE leg' });
  await expect(exits).toHaveCount(2);
  const titles = await exits.evaluateAll(els => els.map(e => ({ title: e.getAttribute('title') ?? '', disabled: (e as HTMLButtonElement).disabled })));
  expect(titles.filter(t => t.disabled && /position is on Kotak/.test(t.title))).toHaveLength(1);
  expect(orders(m)).toEqual([]);
});

test('an unreadable Kotak book ("not connected") is not read as flat: Exit keeps the leg and sends nothing', async ({ page }) => {
  m.config = config([realRow('ft_kotak_1', 'kotak')]);
  m.kotakPositionsError = 'Kotak not connected — run kotak_autologin.py';
  await install(page, m, 'kotak');
  await open(page);

  await page.getByRole('button', { name: 'Exit CE leg' }).first().click();
  await expect(page.getByText(/position book not readable yet/).first()).toBeVisible();
  await expect(page.getByText(/closed outside the tool/)).toHaveCount(0);
  expect(orders(m)).toEqual([]);
  // The ledger still holds both legs (before the fix the CE leg was saved as 0 — "already flat at the broker").
  const q = lastSavedQty(m, 'ft_kotak_1');
  if (q) expect(q).toEqual({ ce: 65, pe: 65 });
});
