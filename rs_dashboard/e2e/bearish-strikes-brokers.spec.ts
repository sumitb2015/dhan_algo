import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { applyOp, type LedgerFile, type LedgerOp } from '../lib/bearishLedger';

// Bearish Strikes REAL path on each broker. Safe by construction: page.route answers EVERY /api call in the browser, so
// no request reaches the server or a broker; any non-GET this file does not handle is refused (599) and fails the test.
// Covers: the sell and the buy-back go to the row's own broker route by that broker's contract handle (security id vs
// trading symbol), quantity = lots x the broker's lot size, the fill settles from the order status, and the realized P&L.

const pad = (n: number) => String(n).padStart(2, '0');
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const DOWN = Array.from({ length: 75 }, (_, i) => {
  const mins = 9 * 60 + 15 + i;
  const c = 200 - i;
  return { t: `${istToday()} ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`, o: c, h: c + 0.5, l: c - 0.5, c, v: 100 };
});
const q = (ltp: number) => ({ ltp, oi: 65 * 500, volume: 65 * 800, open: 220, prev_close: 210, change_pct: -10, oi_chg_pct: 5, buildup: 'SB' });

const SELL_FILL = 99.5;
const BUY_FILL = 80;
const LOT = 65;

type BrokerKey = 'dhan' | 'kotak' | 'zerodha';
const CASES: { broker: BrokerKey; label: string; lookup: string; order: string; handle: Record<string, string>; contract: Record<string, string> }[] = [
  { broker: 'dhan', label: 'Dhan', lookup: '/api/scalper/lookup', order: '/api/scalper/fast-order',
    handle: { securityId: '555001' }, contract: { ceId: '555001', peId: '555002' } },
  { broker: 'kotak', label: 'Kotak', lookup: '/api/scalper/kotak/lookup', order: '/api/scalper/kotak/order',
    handle: { tradingsymbol: 'NIFTY26O2024600CE' }, contract: { ceSymbol: 'NIFTY26O2024600CE', peSymbol: 'NIFTY26O2024600PE' } },
  { broker: 'zerodha', label: 'Zerodha', lookup: '/api/scalper/zerodha/lookup', order: '/api/scalper/zerodha/order',
    handle: { tradingsymbol: 'NIFTY26O2024600CE' }, contract: { ceSymbol: 'NIFTY26O2024600CE', peSymbol: 'NIFTY26O2024600PE' } },
];

async function install(page: Page, c: (typeof CASES)[number], opts: { firstSellUnknown?: boolean } = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const blocked: string[] = [];
  const cancels: string[] = [];
  // A LIMIT order rests (PENDING) until it is cancelled; MARKET orders fill at once.
  const orders = new Map<string, { qty: number; side: string; type: string; status: string; corr?: string }>();
  let ledger: LedgerFile = { rev: 0, positions: [] };
  const px = { ce24600: 100 };
  const quotes = () => ({
    updated_at: new Date().toISOString(), underlying: 'NIFTY', expiry: '2099-12-31', spot: 24500, atm: 24500, straddle_premium: 200,
    strikes: { '24600': { strike: 24600, ce: q(px.ce24600), pe: q(40) }, '24400': { strike: 24400, ce: q(150), pe: q(100) } },
  });

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    if (p === c.order && method === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      sent.push({ path: p, body });
      const id = String(7000 + orders.size);
      const type = String(body.orderType ?? 'MARKET');
      orders.set(id, { qty: Number(body.quantity), side: String(body.side), type, status: type === 'LIMIT' ? 'PENDING' : 'TRADED', corr: typeof body.correlationId === 'string' ? body.correlationId : undefined });
      // The broker took the order but the reply was lost: the page only learns of it from the order book.
      if (opts.firstSellUnknown && sent.length === 1) return json(route, { success: false, unknown: true, error: 'e2e: reply lost' }, 504);
      return json(route, { success: true, order_id: id });
    }
    if (p === '/api/scalper/orders' && method === 'DELETE') {
      const id = String((req.postDataJSON() as { orderId?: string }).orderId ?? '');
      const o = orders.get(id);
      cancels.push(id);
      if (!o) return json(route, { success: false, error: 'not found' }, 404);
      o.status = 'CANCELLED';
      return json(route, { success: true });
    }
    if (p === (c.broker === 'dhan' ? '/api/scalper/poll' : `/api/scalper/${c.broker}/poll`)) {
      return json(route, { success: true, positions: [], positionsError: null, trades: [],
        orders: [...orders].map(([id, o]) => ({ orderId: id, correlationId: o.corr, tradingSymbol: c.contract.ceSymbol ?? '', transactionType: o.side, quantity: o.qty, orderStatus: o.status, createTime: '' })) });
    }
    // Any other broker's order route is a wrong-account order.
    if (/\/(fast-order|kotak\/order|zerodha\/order)$/.test(p)) { blocked.push(`${method} ${p}`); return route.fulfill({ status: 599, body: 'wrong broker' }); }
    if (p === '/api/scalper/orders' && method === 'GET') {
      const id = url.searchParams.get('orderId') ?? '';
      const o = orders.get(id);
      if (url.searchParams.get('broker') !== c.broker) { blocked.push(`status read on ${url.searchParams.get('broker')}`); return json(route, { success: false, error: 'wrong broker' }, 404); }
      if (!o) return json(route, { success: false, error: 'Order not found' }, 404);
      const filled = o.status === 'TRADED';
      return json(route, { success: true, data: { orderId: id, orderStatus: o.status, quantity: o.qty, filledQty: filled ? o.qty : 0, averageTradedPrice: filled ? (o.side === 'SELL' ? SELL_FILL : BUY_FILL) : 0, reason: '' } });
    }
    if (p === '/api/scalper/nifty-prev-close') return json(route, { success: true, prevClose: 24400, source: 'dhan' });
    if (p === '/api/live-indices') return json(route, { success: true });
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, updated_at: new Date().toISOString(), quotes: { NIFTY: { ltp: 24512.35, prev_close: 24512.35, change_pct: 0 }, VIX: { ltp: 13.42, prev_close: 13.42, change_pct: 0 } } });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2099-12-31'] });
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      return json(route, { success: true, status: { status: 'RUNNING', subscribed: 4 }, quotes: quotes(), history: { history: [] } });
    }
    if (p === c.lookup) return json(route, { success: true, data: { lotSize: LOT, strikes: { '24600': c.contract } } });
    if (p === '/api/bearish-strikes/bars') {
      const keys = (url.searchParams.get('contracts') ?? '').split(',').filter(Boolean);
      return json(route, { success: true, bars: Object.fromEntries(keys.map((k) => [k, DOWN])), errors: {} });
    }
    if (p === '/api/bearish-strikes/state') {
      if (method === 'GET') return json(route, { success: true, ...ledger });
      try { ledger = applyOp(ledger, req.postDataJSON() as LedgerOp); return json(route, { success: true, ...ledger }); }
      catch (e) { return json(route, { success: false, error: String((e as Error).message) }, 400); }
    }
    if (method === 'GET') return json(route, { success: false, error: 'e2e' }, 503);
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: 'blocked by e2e' });
  });
  return { sent, blocked, cancels, px, ledger: () => ledger };
}

/** Arms REAL through the confirmation dialog (one click alone never arms). */
async function armReal(page: Page, label: string) {
  await page.getByRole('button', { name: 'SIM', exact: true }).click();
  const ask = page.getByRole('dialog', { name: `Arm REAL on ${label}?` });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: `Arm REAL on ${label}` }).click();
  await expect(page.getByRole('button', { name: /LIVE · REAL MONEY/ })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Real money armed' })).toContainText(`REAL MONEY · ${label}`);
}

test.beforeEach(async ({ context }) => { await signIn(context); });

for (const c of CASES) {
  test(`${c.label}: REAL sell then buy-back go to ${c.label} by its own contract handle, size and P&L come from the ledger`, async ({ page }) => {
    const seen = await install(page, c);
    await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });

    const picker = page.getByRole('combobox', { name: 'Broker for new orders' });
    await expect(async () => { await picker.selectOption(c.broker); await expect(picker).toHaveValue(c.broker, { timeout: 1_000 }); }).toPass({ timeout: 30_000 });
    await page.getByRole('button', { name: 'CE', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: '24600' })).toContainText(/BEARISH/, { timeout: 60_000 });

    await armReal(page, c.label);                                                                // arm REAL (mocked)
    await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
    await expect(page.getByRole('heading', { name: /Add New Leg/ })).toBeVisible();
    await page.getByRole('button', { name: /Place & Add Leg/ }).click();

    const pos = page.getByRole('region', { name: 'Positions on this page' });
    // ('REAL' alone is in the panel's header, so wait for the row itself.)
    await expect(pos).toContainText('24600 CE', { timeout: 30_000 });
    await expect(pos).toContainText('OPEN', { timeout: 30_000 });
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0].body).toMatchObject({ side: 'SELL', quantity: LOT, ...c.handle });
    // Kotak / Zerodha: the sell names its source so the route applies the `bs` lot cap. Dhan: a correlationId to find a lost reply.
    if (c.broker === 'dhan') expect(String(seen.sent[0].body.correlationId)).toMatch(/^[a-z0-9]{8,25}$/);
    else expect(seen.sent[0].body.source).toBe('bs');
    const row = seen.ledger().positions[0];
    expect(row).toMatchObject({ mode: 'REAL', broker: c.broker, qty: LOT, avgPrice: SELL_FILL, status: 'OPEN' });
    if (c.broker === 'dhan') expect(row.securityId).toBe('555001'); else expect(row.symbol).toBe('NIFTY26O2024600CE');

    await page.getByRole('button', { name: 'Exit 24600 CE' }).click();
    const dlg = page.getByRole('dialog', { name: 'Exit position' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: /exit|confirm|place/i }).last().click();
    await expect(pos).toContainText('CLOSED', { timeout: 30_000 });

    expect(seen.sent).toHaveLength(2);
    expect(seen.sent[1].body).toMatchObject({ side: 'BUY', quantity: LOT, ...c.handle });
    // Kotak / Zerodha: a buy-back names no source, so their lot cap can never refuse a close. (Dhan tags every order 'bs'
    // for its correlationId; its 3750-unit cap sits above any 50-lot position.)
    if (c.broker !== 'dhan') expect(seen.sent[1].body.source).toBeUndefined();
    expect(seen.ledger().positions[0]).toMatchObject({ status: 'CLOSED', qty: 0, exitPrice: BUY_FILL });
    expect(seen.ledger().positions[0].realized).toBeCloseTo((SELL_FILL - BUY_FILL) * LOT, 2);
    expect(seen.blocked).toEqual([]);
  });
}

const DHAN = CASES[0];

test('Dhan: an SL hit with Auto-exit on replaces a resting LIMIT buy-back with a MARKET exit (cancel first)', async ({ page }) => {
  const seen = await install(page, DHAN);
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CE', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '24600' })).toContainText(/BEARISH/, { timeout: 60_000 });
  await armReal(page, DHAN.label);
  await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
  await page.getByRole('button', { name: /Place & Add Leg/ }).click();
  const pos = page.getByRole('region', { name: 'Positions on this page' });
  await expect(pos).toContainText('OPEN', { timeout: 30_000 });

  // A buy-back limit far below the market: it rests.
  await page.getByRole('button', { name: 'Exit 24600 CE' }).click();
  const dlg = page.getByRole('dialog', { name: 'Exit position' });
  await dlg.getByRole('button', { name: 'LIMIT', exact: true }).click();
  await dlg.getByRole('spinbutton', { name: 'Limit price' }).fill('50');
  await dlg.getByRole('button', { name: /exit|confirm|place/i }).last().click();
  await expect(pos).toContainText('exit order working', { timeout: 30_000 });

  await pos.getByRole('checkbox', { name: 'Supertrend' }).uncheck();               // isolate the SL rule from the level alert
  await pos.getByRole('spinbutton', { name: 'SL %' }).fill('30');
  await pos.getByRole('spinbutton', { name: 'SL %' }).press('Enter');
  await pos.getByRole('switch', { name: 'Auto-exit' }).click();
  seen.px.ce24600 = 140;                                                            // +40% over the 99.5 fill: SL hit

  await expect(pos).toContainText('CLOSED', { timeout: 30_000 });
  expect(seen.cancels).toEqual(['7001']);                                           // the resting limit, cancelled first
  expect(seen.sent.map((x) => [x.body.side, x.body.orderType])).toEqual([['SELL', 'MARKET'], ['BUY', 'LIMIT'], ['BUY', 'MARKET']]);
  expect(seen.ledger().positions[0]).toMatchObject({ status: 'CLOSED', qty: 0, exitPrice: BUY_FILL });
  expect(seen.blocked).toEqual([]);
});

test('Dhan: a sell whose reply was lost is found in the order book by correlationId and tracked, not dropped', async ({ page }) => {
  test.setTimeout(180_000);                                                         // the reservation goes stale after 60 s
  const seen = await install(page, DHAN, { firstSellUnknown: true });
  await page.goto('/bearish-strikes', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'CE', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: '24600' })).toContainText(/BEARISH/, { timeout: 60_000 });
  await armReal(page, DHAN.label);
  await page.getByRole('button', { name: 'Sell 24600 CE' }).click();
  await page.getByRole('button', { name: /Place & Add Leg/ }).click();
  const pos = page.getByRole('region', { name: 'Positions on this page' });
  await expect(pos).toContainText('entry order working', { timeout: 30_000 });     // reservation kept: blocks a blind re-send

  await expect.poll(() => seen.ledger().positions[0]?.qty ?? 0, { timeout: 120_000 }).toBe(LOT);
  expect(seen.ledger().positions[0]).toMatchObject({ status: 'OPEN', avgPrice: SELL_FILL, broker: 'dhan' });
  expect(seen.sent).toHaveLength(1);                                               // adopted, never re-sent
  expect(seen.blocked).toEqual([]);
});
