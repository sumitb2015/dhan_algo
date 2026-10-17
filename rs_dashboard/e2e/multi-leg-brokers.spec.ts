import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Multi-Leg Focus order flows on DHAN and KOTAK, end to end in the browser against a stateful MOCK broker (book, order
// statuses, funds, margin). Nothing reaches a broker: every order/cancel route is answered here, any other non-GET is
// refused (599) and fails the test, and unmocked GETs answer 503 locally instead of reaching the dev server's routes.
//
// Per broker: two-phase placement (hedges confirmed before any short), Exit Strategy (shorts confirmed down before the
// hedges), a post-ACK rejection rolling back what filled, the margin/funds gate, and a leg's partial / LIMIT / market exit
// (a market exit cancels the resting LIMIT first). Every order must go to the strategy's own broker and nowhere else.

type Bk = 'dhan' | 'kotak';
const EXP = '2026-10-20';
const STRIKES = [23600, 23700, 23800, 23900, 24000, 24100, 24200, 24300, 24400];
const LOT = 65;
const premium = (k: number, opt: 'CE' | 'PE') => Math.max(5, 120 - (opt === 'CE' ? k - 24000 : 24000 - k) * 0.4);
const kotakSym = (k: number, opt: 'CE' | 'PE') => `NIFTY26O20${k}${opt}`;
const dhanId = (k: number, opt: 'CE' | 'PE') => `${k}${opt === 'CE' ? 1 : 2}`;
const contractOf = (bk: Bk, k: number, opt: 'CE' | 'PE') => (bk === 'dhan' ? dhanId(k, opt) : kotakSym(k, opt));

interface Pos { strike: number; opt: 'CE' | 'PE'; buyQty: number; sellQty: number; buyVal: number; sellVal: number }
interface Order { id: string; key: string; side: 'BUY' | 'SELL'; qty: number; type: string; price: number; status: string }

interface Mock {
  bk: Bk;
  calls: Call[];
  blocked: Call[];
  /** Any request to the OTHER broker's account/order routes (its poll excepted: the page polls every broker by design). */
  wrongBroker: string[];
  book: Map<string, Pos>;
  orders: Order[];
  funds: number;
  /** null = margin calculator fails. */
  margin: number | null;
  /** Contracts whose next order is ACKed and then REJECTED. */
  rejectAfterAck: Set<string>;
  /** Contracts whose next order the broker refuses outright (success: false). */
  refuseOnSend: Set<string>;
  /** Kotak instrument-cache entries beyond the weekly NIFTY chain (symbol-lookup), e.g. monthly symbols and futures. */
  kotakExtra: Record<string, { underlying: string; expiry: string; strike: number; side: 'CE' | 'PE' | 'FUT' }>;
  /** Raw extra rows in this broker's book (positions this page never placed), shaped as the broker returns them. */
  extraRows: Record<string, unknown>[];
  store: Map<string, Record<string, unknown>>;
}

function newMock(bk: Bk, baskets: Record<string, unknown>[] = []): Mock {
  return {
    bk, calls: [], blocked: [], wrongBroker: [], book: new Map(), orders: [], funds: 5_00_000, margin: 1_20_000,
    rejectAfterAck: new Set(), refuseOnSend: new Set(), kotakExtra: {}, extraRows: [], store: new Map(baskets.map(b => [String(b.id), b])),
  };
}

const underlyingParam = (u: URL) => (u.searchParams.get('underlying') ?? '').toUpperCase();
const netQty = (p: Pos) => p.buyQty - p.sellQty;
/** The exchange prints the trigger: a resting stop order trades in full. */
function triggerStop(m: Mock, o: Order, price: number) {
  o.status = 'TRADED';
  o.price = price;
  fill(m, o.key, o.side, o.qty, price);
}
const netOf = (m: Mock, k: number, opt: 'CE' | 'PE') => { const p = m.book.get(contractOf(m.bk, k, opt)); return p ? netQty(p) : 0; };

function fill(m: Mock, key: string, side: 'BUY' | 'SELL', qty: number, price: number) {
  const [strike, opt] = m.bk === 'dhan'
    ? [Number(key.slice(0, -1)), key.endsWith('1') ? 'CE' : 'PE'] as const
    : [Number(key.slice(10, -2)), key.slice(-2) as 'CE' | 'PE'] as const;
  const p = m.book.get(key) ?? { strike, opt, buyQty: 0, sellQty: 0, buyVal: 0, sellVal: 0 };
  if (side === 'BUY') { p.buyQty += qty; p.buyVal += qty * price; } else { p.sellQty += qty; p.sellVal += qty * price; }
  m.book.set(key, p);
}

function positionRows(m: Mock): Record<string, unknown>[] {
  return [...m.extraRows, ...[...m.book.entries()].map(([key, p]) => {
    const n = netQty(p);
    const buyAvg = p.buyQty ? p.buyVal / p.buyQty : 0;
    const sellAvg = p.sellQty ? p.sellVal / p.sellQty : 0;
    if (m.bk === 'dhan') {
      return {
        securityId: key, tradingSymbol: `NIFTY-Oct2026-${p.strike}-${p.opt}`, exchangeSegment: 'NSE_FNO', productType: 'MARGIN',
        netQty: n, positionType: n > 0 ? 'LONG' : n < 0 ? 'SHORT' : 'CLOSED', buyQty: p.buyQty, sellQty: p.sellQty, buyAvg, sellAvg,
        costPrice: n > 0 ? buyAvg : sellAvg, unrealizedProfit: 0, realizedProfit: 0,
        drvExpiryDate: EXP, drvOptionType: p.opt === 'CE' ? 'CALL' : 'PUT', drvStrikePrice: p.strike,
      };
    }
    return {
      tradingSymbol: key, securityId: '1', exchange: 'nse_fo', productType: 'NRML', lotSize: LOT, netQty: n,
      buyQty: p.buyQty, sellQty: p.sellQty, buyAvg, sellAvg, lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
    };
  })];
}

const orderRows = (m: Mock) => m.orders.map(o => ({
  orderId: o.id, orderStatus: o.status, transactionType: o.side, quantity: o.qty, filledQty: o.status === 'TRADED' ? o.qty : 0,
  averageTradedPrice: o.status === 'TRADED' ? o.price : 0, orderType: o.type, correlationId: 'mlf-e2e',
  ...(m.bk === 'dhan' ? { securityId: o.key, exchangeSegment: 'NSE_FNO' } : { tradingSymbol: o.key, exchange: 'nse_fo' }),
}));

/** The order route this broker's legs must use; everything else that would trade or read the OTHER account is flagged. */
const ORDER_ROUTE: Record<Bk, string> = { dhan: '/api/scalper/fast-order', kotak: '/api/scalper/kotak/order' };
const ACCOUNT_ROUTES: Record<Bk, RegExp> = {
  dhan: /^\/api\/(scalper\/(fast-order|order|positions|funds|lookup|trades|all)|super-order|pnl-exit|exit-all)$/,
  kotak: /^\/api\/scalper\/kotak\/(order|positions|funds|lookup|all|exit-all|orders)$/,
};

async function install(page: Page, m: Mock): Promise<void> {
  const other: Bk = m.bk === 'dhan' ? 'kotak' : 'dhan';
  await page.addInitScript((b: string) => { try { localStorage.setItem('dhan_algo.selected_broker', b); } catch { /* ignore */ } }, m.bk);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    const call: Call = { method, path: p, search: u.search, body };
    const qBroker = u.searchParams.get('broker') ?? (body?.broker as string | undefined);
    if (ACCOUNT_ROUTES[other].test(p) || (p === '/api/scalper/orders' && (qBroker ?? 'dhan') === other)) m.wrongBroker.push(`${method} ${p}${u.search}`);

    if (p === '/api/auth/broker-status') return json(route, { dhan: true, zerodha: false, kotak: true });
    if (p === '/api/multi-leg-focus/baskets') {
      if (method === 'GET') return json(route, { success: true, data: [...m.store.values()] });
      if (method === 'POST') { m.store.set(String(body!.id), body!); return json(route, { success: true, data: [...m.store.values()], basket: body }); }
      if (method === 'DELETE') { m.store.delete(String(body!.id)); return json(route, { success: true, data: [...m.store.values()] }); }
    }
    if (p === '/api/multi-leg-focus/margin') {
      if (m.margin == null) return json(route, { success: false, error: 'e2e: calculator down' }, 502);
      // Per leg, standalone: a short ~60k per lot, a long its premium (what Add Lots scales from).
      const legs = (body?.legs ?? []) as { id: string; side: string; quantity: number; price: number }[];
      const legMargins = Object.fromEntries(legs.map(l => [l.id, l.side === 'S' ? 60_000 * (l.quantity / LOT) : l.price * l.quantity]));
      const legMarginSource = Object.fromEntries(legs.map(l => [l.id, 'live']));
      return json(route, { success: true, data: { legMargins, legMarginSource, basketMargin: m.margin, basketMarginSource: 'live', overallMargin: m.margin, hedgeBenefit: 0, spanMargin: m.margin, exposureMargin: 0 } });
    }
    if (p === '/api/multi-leg-focus/depth') {
      const legs = (body?.legs ?? []) as { strike: number; option: 'CE' | 'PE'; expiry: string }[];
      return json(route, { success: true, data: Object.fromEntries(legs.map(l => { const px = premium(l.strike, l.option); return [`${l.expiry}:${l.strike}:${l.option}`, { bid: px - 0.05, ask: px + 0.05 }]; })) });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: [EXP, '2026-10-27'] });
    if (p === '/api/options/chain') {
      const oc = Object.fromEntries(STRIKES.map(k => [`${k}.000000`, { ce: { last_price: premium(k, 'CE'), previous_close_price: premium(k, 'CE') }, pe: { last_price: premium(k, 'PE'), previous_close_price: premium(k, 'PE') } }]));
      return json(route, { success: true, data: { spot: 24000, prev_close: 23950, chain: { oc } } });
    }
    if (p === '/api/scalper/kotak/symbol-lookup') {
      const und = underlyingParam(u);
      const data: Record<string, { expiry: string; strike: number; side: string }> = {};
      if (und === 'NIFTY') for (const k of STRIKES) for (const o of ['CE', 'PE'] as const) data[kotakSym(k, o)] = { expiry: EXP, strike: k, side: o };
      for (const [sym, c] of Object.entries(m.kotakExtra)) if (c.underlying === und) data[sym] = { expiry: c.expiry, strike: c.strike, side: c.side };
      return json(route, { success: true, data });
    }
    if (p === '/api/scalper/lookup' || p === '/api/scalper/kotak/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => [String(k), p === '/api/scalper/lookup'
        ? { ceId: dhanId(k, 'CE'), peId: dhanId(k, 'PE') }
        : { ceSymbol: kotakSym(k, 'CE'), peSymbol: kotakSym(k, 'PE') }]));
      return json(route, { success: true, data: { lotSize: LOT, strikes } });
    }

    // ── The tested broker's account ──
    const own = (ep: string) => p === (m.bk === 'dhan' ? `/api/scalper/${ep}` : `/api/scalper/kotak/${ep}`);
    if (own('funds')) return json(route, { success: true, data: { availabelBalance: m.funds, utilizedAmount: 0 } });
    if (own('positions')) return json(route, { success: true, data: positionRows(m) });
    if (own('poll')) return json(route, { success: true, positions: positionRows(m), orders: orderRows(m), trades: [] });
    if (p === ORDER_ROUTE[m.bk] && method === 'POST') {
      m.calls.push(call);
      const key = String(m.bk === 'dhan' ? body!.securityId : body!.tradingsymbol);
      const side = body!.side as 'BUY' | 'SELL';
      const qty = Number(body!.quantity);
      const id = String(9000 + m.orders.length);
      const pos = m.book.get(key);
      const strikeOpt = STRIKES.flatMap(k => (['CE', 'PE'] as const).map(o => ({ k, o }))).find(({ k, o }) => contractOf(m.bk, k, o) === key);
      if (!strikeOpt) return json(route, { success: false, error: `e2e: unknown contract ${key}` }, 400);
      const price = Number(body!.price) || premium(strikeOpt.k, strikeOpt.o);
      if (m.refuseOnSend.has(key)) { m.refuseOnSend.delete(key); return json(route, { success: false, error: 'e2e: RMS refused' }); }
      let status = 'TRADED';
      if (m.rejectAfterAck.has(key)) { m.rejectAfterAck.delete(key); status = 'REJECTED'; }
      else if (body!.orderType === 'LIMIT' && pos) status = 'PENDING';   // a resting exit: never fills in these tests
      else if (/^(STOP_LOSS|SL)/.test(String(body!.orderType))) status = 'PENDING';   // a stop entry rests until triggerStop()
      else fill(m, key, side, qty, price);
      m.orders.push({ id, key, side, qty, type: String(body!.orderType), price, status });
      return json(route, { success: true, order_id: id });
    }
    if (p === '/api/scalper/orders' && (qBroker ?? 'dhan') === m.bk) {
      m.calls.push(call);
      if (method === 'GET') {
        const o = m.orders.find(x => x.id === u.searchParams.get('orderId'));
        if (!o) return json(route, { success: true, data: orderRows(m) });
        return json(route, { success: true, data: { orderStatus: o.status, filledQty: o.status === 'TRADED' ? o.qty : 0, averageTradedPrice: o.status === 'TRADED' ? o.price : 0, reason: o.status === 'REJECTED' ? 'RMS: e2e rejection' : '' } });
      }
      if (method === 'DELETE') {
        const o = m.orders.find(x => x.id === String(body?.orderId));
        if (o && o.status === 'PENDING') { o.status = 'CANCELLED'; return json(route, { success: true }); }
        return json(route, { success: false, error: 'e2e: not cancellable' });
      }
    }
    // Every other broker's poll: an empty, healthy book (the page polls all brokers by design).
    if (/^\/api\/scalper\/(poll|zerodha\/poll|kotak\/poll)$/.test(p)) return json(route, { success: true, positions: [], orders: [], trades: [] });
    if (method === 'POST' && p === '/api/options/live') return json(route, { success: true });

    if (method !== 'GET') { m.blocked.push(call); return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' }); }
    return json(route, { success: false, error: 'e2e: not mocked' }, 503);
  });
}

const orderCalls = (m: Mock) => m.calls.filter(c => c.method === 'POST' && c.path === ORDER_ROUTE[m.bk]);
const identOf = (m: Mock, c: Call) => String(m.bk === 'dhan' ? c.body?.securityId : c.body?.tradingsymbol);
const storedLegs = (m: Mock, id = 'b1') => ((m.store.get(id)?.legs ?? []) as { id: string; status: string; side: string; strike: number; option: string; lots: number; fill?: { qty: number } }[]);

const NOW = Date.now();
const IRON_CONDOR = (bk: Bk) => ({
  id: 'b1', name: 'Iron Condor', underlying: 'NIFTY', expiry: EXP, broker: bk, presetKey: 'iron-condor', multiplier: 1,
  legs: [
    { id: 'l1', side: 'B', option: 'CE', strike: 24300, expiry: EXP, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
    { id: 'l2', side: 'S', option: 'CE', strike: 24100, expiry: EXP, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
    { id: 'l3', side: 'S', option: 'PE', strike: 23900, expiry: EXP, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
    { id: 'l4', side: 'B', option: 'PE', strike: 23700, expiry: EXP, ratio: 1, lots: 1, type: 'MARKET', status: 'DRAFT' },
  ],
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), rev: 1,
});

/** A short 24100 CE, 2 lots, already open at the broker (filled 10 min ago: outside the fill grace). */
function openShort(m: Mock) {
  const key = contractOf(m.bk, 24100, 'CE');
  fill(m, key, 'SELL', 2 * LOT, 80);
  return {
    // groupName: a one-leg row without one is an ungrouped trade (isLooseTrade), listed in another table.
    id: 'b1', name: 'Short Call', groupName: 'Short Call', underlying: 'NIFTY', expiry: EXP, broker: m.bk, multiplier: 1,
    legs: [{
      id: 'l1', side: 'S', option: 'CE', strike: 24100, expiry: EXP, ratio: 1, lots: 2, type: 'MARKET', status: 'OPEN',
      fill: { qty: 2 * LOT, avgPrice: 80, orderId: '100' }, filledAt: NOW - 600_000, price: 80,
      orderRef: m.bk === 'dhan' ? { securityId: key } : { symbol: key },
    }],
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), rev: 1,
  };
}

/** The iron condor, OPEN at the broker (1 lot each, filled 10 min ago). */
function openCondor(m: Mock) {
  const b = IRON_CONDOR(m.bk);
  return {
    ...b, groupName: 'Iron Condor',
    legs: b.legs.map((l, i) => {
      const o = l.option as 'CE' | 'PE';
      const key = contractOf(m.bk, l.strike, o);
      const px = premium(l.strike, o);
      fill(m, key, l.side === 'B' ? 'BUY' : 'SELL', LOT, px);
      return {
        ...l, status: 'OPEN', fill: { qty: LOT, avgPrice: px, orderId: String(100 + i) }, filledAt: NOW - 600_000, price: px,
        orderRef: m.bk === 'dhan' ? { securityId: key } : { symbol: key },
      };
    }),
  };
}

const legRow = (page: Page, strike: number, opt: string) => page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select ${strike} ${opt} to group` }) }).first();

async function open(page: Page) {
  await page.goto('/multi-leg-focus', { waitUntil: 'domcontentloaded' });
  // A draft row renders expanded, an open one collapsed.
  const toggle = page.getByRole('button', { name: /^(Expand|Collapse) strategy$/ }).first();
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  if (await toggle.getAttribute('title') === 'Expand strategy') await toggle.click();
}

async function placeBasket(page: Page) {
  const btn = page.getByRole('button', { name: /^(Place Basket|Confirm Place\?)$/ }).first();
  await expect(btn).toHaveText('Place Basket');
  await btn.click();
  await expect(btn).toHaveText('Confirm Place?');
  await btn.click();
}

test.beforeEach(async ({ context }) => { await signIn(context); });

for (const bk of ['dhan', 'kotak'] as const) {
  test.describe(`Multi-Leg Focus on ${bk}`, () => {
    test(`${bk}: places hedges before shorts, then Exit Strategy closes shorts before hedges`, async ({ page }) => {
      const m = newMock(bk, [IRON_CONDOR(bk)]);
      await install(page, m);
      await open(page);
      await placeBasket(page);

      await expect.poll(() => storedLegs(m).map(l => l.status).join(','), { timeout: 30_000 }).toBe('OPEN,OPEN,OPEN,OPEN');
      const placed = orderCalls(m);
      expect(placed).toHaveLength(4);
      const sides = placed.map(c => c.body!.side);
      expect(sides.slice(0, 2).sort()).toEqual(['BUY', 'BUY']);
      expect(sides.slice(2)).toEqual(['SELL', 'SELL']);
      for (const c of placed) {
        expect(c.body!.quantity).toBe(LOT);
        expect(c.body!.orderType).toBe('MARKET');
        if (bk === 'dhan') { expect(c.body).toMatchObject({ exchangeSegment: 'NSE_FNO', productType: 'MARGIN', source: 'mlf' }); }
        else { expect(c.body).toMatchObject({ exchange: 'nse_fo', product: 'NRML' }); }
      }
      expect(placed.map(c => identOf(m, c)).sort()).toEqual([
        contractOf(bk, 23700, 'PE'), contractOf(bk, 23900, 'PE'), contractOf(bk, 24100, 'CE'), contractOf(bk, 24300, 'CE'),
      ].sort());
      // Each fill was confirmed on this broker's order book before the strategy moved on.
      const confirms = m.calls.filter(c => c.method === 'GET' && c.path === '/api/scalper/orders');
      expect(confirms.length).toBeGreaterThanOrEqual(4);
      expect(netOf(m, 24100, 'CE')).toBe(-LOT);
      expect(netOf(m, 24300, 'CE')).toBe(LOT);

      // Exit Strategy: confirm-on-click is not used here; one click exits.
      const before = orderCalls(m).length;
      await page.getByRole('button', { name: 'Exit Strategy' }).first().click();
      await expect.poll(() => storedLegs(m).map(l => l.status).join(','), { timeout: 30_000 }).toBe('CLOSED,CLOSED,CLOSED,CLOSED');
      const exits = orderCalls(m).slice(before);
      expect(exits).toHaveLength(4);
      expect(exits.slice(0, 2).map(c => c.body!.side)).toEqual(['BUY', 'BUY']);     // shorts covered first
      expect(exits.slice(2).map(c => c.body!.side)).toEqual(['SELL', 'SELL']);     // then hedges sold
      for (const k of [23700, 23900] as const) expect(netOf(m, k, 'PE')).toBe(0);
      for (const k of [24100, 24300] as const) expect(netOf(m, k, 'CE')).toBe(0);

      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: a short rejected after ACK stops the strategy and reverses everything that filled`, async ({ page }) => {
      const m = newMock(bk, [IRON_CONDOR(bk)]);
      m.rejectAfterAck.add(contractOf(bk, 24100, 'CE'));
      await install(page, m);
      await open(page);
      await placeBasket(page);

      await expect(page.getByText(/Rejected SELL 24100 CE after acceptance/).first()).toBeVisible({ timeout: 30_000 });
      // 4 placements (one rejected) + 3 reversals of what filled; the book ends flat, nothing naked.
      await expect.poll(() => orderCalls(m).length, { timeout: 30_000 }).toBe(7);
      for (const [k, o] of [[24300, 'CE'], [24100, 'CE'], [23900, 'PE'], [23700, 'PE']] as const) expect(netOf(m, k, o)).toBe(0);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: margin gate blocks placement when funds are short or margin is unverified`, async ({ page }) => {
      const m = newMock(bk, [IRON_CONDOR(bk)]);
      m.funds = 10_000;
      await install(page, m);
      await open(page);
      const btn = page.getByRole('button', { name: 'Insufficient Margin' }).first();
      await expect(btn).toBeDisabled({ timeout: 30_000 });

      // Calculator down: the button is clickable, but the click is refused before any order.
      m.funds = 5_00_000;
      m.margin = null;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await open(page);
      await placeBasket(page);
      await expect(page.getByText('Margin not verified — placement blocked').first()).toBeVisible();
      expect(orderCalls(m)).toEqual([]);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: leg exit — partial lots, a resting LIMIT, then MARKET cancels the LIMIT first`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openShort(m));
      await install(page, m);
      await open(page);

      // 1 of 2 lots at market.
      await page.getByRole('button', { name: 'Exit this leg' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Exit position' });
      await dialog.getByRole('spinbutton').fill('1');
      await dialog.getByRole('button', { name: 'Confirm Exit 1 Lot' }).click();
      await expect.poll(() => netOf(m, 24100, 'CE'), { timeout: 20_000 }).toBe(-LOT);
      expect(orderCalls(m).at(-1)!.body).toMatchObject({ side: 'BUY', quantity: LOT, orderType: 'MARKET' });
      await expect.poll(() => storedLegs(m).map(l => `${l.status}:${l.fill?.qty ?? 0}`).sort().join(','), { timeout: 20_000 }).toBe(`CLOSED:0,OPEN:${LOT}`);

      // A LIMIT exit rests: the leg stays OPEN and shows the LMT chip.
      await page.getByRole('button', { name: 'Exit this leg' }).first().click();
      await dialog.getByRole('button', { name: 'LIMIT' }).click();
      // An off-tick price is accepted: the ticket says what will be sent, and the order goes out on the tick.
      await dialog.getByRole('spinbutton', { name: 'Limit price' }).fill('70.03');
      await expect(dialog.getByText('Off the ₹0.05 tick: sent as ₹70.05')).toBeVisible();
      await dialog.getByRole('button', { name: /Confirm Exit 1 Lot/ }).click();
      await expect(page.getByText(/^LMT 70\.05$/).first()).toBeVisible({ timeout: 20_000 });
      const lim = orderCalls(m).at(-1)!;
      expect(lim.body).toMatchObject({ side: 'BUY', quantity: LOT, orderType: 'LIMIT', price: 70.05 });
      expect(netOf(m, 24100, 'CE')).toBe(-LOT);

      // A MARKET exit now cancels the resting LIMIT on THIS broker first, then closes.
      await page.getByRole('button', { name: 'Exit this leg' }).first().click();
      await dialog.getByRole('button', { name: 'MARKET' }).click();
      await dialog.getByRole('button', { name: /Confirm Exit 1 Lot/ }).click();
      await expect.poll(() => netOf(m, 24100, 'CE'), { timeout: 20_000 }).toBe(0);
      const del = m.calls.find(c => c.method === 'DELETE' && c.path === '/api/scalper/orders');
      expect(del?.body).toMatchObject({ orderId: m.orders.find(o => o.type === 'LIMIT')!.id, broker: bk });
      expect(m.calls.indexOf(del!)).toBeLessThan(m.calls.indexOf(orderCalls(m).at(-1)!));
      expect(m.orders.filter(o => o.status === 'PENDING')).toEqual([]);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: Add Lots grows the short on this broker's contract`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      await install(page, m);
      await open(page);
      await legRow(page, 24100, 'CE').getByRole('button', { name: /ADD/ }).click();
      await page.getByRole('button', { name: 'Confirm Add 1 Lot' }).click();
      await expect.poll(() => netOf(m, 24100, 'CE'), { timeout: 20_000 }).toBe(-2 * LOT);
      const c = orderCalls(m).at(-1)!;
      expect(identOf(m, c)).toBe(contractOf(bk, 24100, 'CE'));
      expect(c.body).toMatchObject({ side: 'SELL', quantity: LOT, orderType: 'MARKET' });
      await expect.poll(() => storedLegs(m).find(l => l.id === 'l2')?.lots, { timeout: 20_000 }).toBe(2);
      expect(orderCalls(m)).toHaveLength(1);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: Add Lots is blocked before any order when the leg's margin exceeds funds`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      m.funds = 30_000;   // one more short lot needs ~60k
      await install(page, m);
      await open(page);
      await legRow(page, 24100, 'CE').getByRole('button', { name: /ADD/ }).click();
      await page.getByRole('button', { name: 'Confirm Add 1 Lot' }).click();
      await expect(page.getByText('Insufficient margin — add blocked').first()).toBeVisible({ timeout: 20_000 });
      expect(orderCalls(m)).toEqual([]);
      expect(netOf(m, 24100, 'CE')).toBe(-LOT);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: shifting a short up one strike closes it, confirms flat, then reopens on the new strike`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      await install(page, m);
      await open(page);
      await legRow(page, 24100, 'CE').getByRole('button', { name: 'Shift this leg up 1 strike' }).click();
      await expect.poll(() => netOf(m, 24200, 'CE'), { timeout: 30_000 }).toBe(-LOT);
      expect(netOf(m, 24100, 'CE')).toBe(0);
      const [close, reopen] = orderCalls(m);
      expect(identOf(m, close)).toBe(contractOf(bk, 24100, 'CE'));
      expect(close.body).toMatchObject({ side: 'BUY', quantity: LOT });
      expect(identOf(m, reopen)).toBe(contractOf(bk, 24200, 'CE'));
      expect(reopen.body).toMatchObject({ side: 'SELL', quantity: LOT });
      expect(orderCalls(m)).toHaveLength(2);
      await expect.poll(() => storedLegs(m).filter(l => l.status === 'OPEN').map(l => `${l.side}${l.strike}${l.option}`).sort().join(','), { timeout: 20_000 })
        .toBe('B23700PE,B24300CE,S23900PE,S24200CE');
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: Scale +1 places one more copy, hedges before shorts`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      await install(page, m);
      await open(page);
      await page.getByRole('button', { name: /Scale…/ }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Scale strategy' });
      await dialog.getByRole('button', { name: 'Place orders (+1×)' }).click();
      await expect.poll(() => orderCalls(m).length, { timeout: 30_000 }).toBe(4);
      const sides = orderCalls(m).map(c => c.body!.side);
      expect(sides.slice(0, 2)).toEqual(['BUY', 'BUY']);
      expect(sides.slice(2)).toEqual(['SELL', 'SELL']);
      expect(netOf(m, 24100, 'CE')).toBe(-2 * LOT);
      expect(netOf(m, 24300, 'CE')).toBe(2 * LOT);
      expect(netOf(m, 23900, 'PE')).toBe(-2 * LOT);
      expect(netOf(m, 23700, 'PE')).toBe(2 * LOT);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: a stop entry rests, opens a leg only when it trades, and Exit Strategy cancels another resting stop`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      await install(page, m);
      await open(page);

      const placeStop = async (option: 'CE' | 'PE') => {
        await page.getByRole('button', { name: 'Add Leg' }).first().click();
        const form = page.locator('form').filter({ has: page.getByRole('button', { name: /^(Place & Add Leg|Place Stop Order)$/ }) });
        await form.getByRole('button', { name: option, exact: true }).click();
        await form.getByRole('button', { name: 'SL-M' }).click();
        await form.getByLabel('Stop trigger price').fill('100');
        await form.getByRole('button', { name: 'Place Stop Order' }).click();
        await expect(page.getByRole('button', { name: `Cancel stop order SELL 24000 ${option}` })).toBeVisible({ timeout: 20_000 });
      };

      await placeStop('CE');
      const stop = orderCalls(m).at(-1)!;
      expect(identOf(m, stop)).toBe(contractOf(bk, 24000, 'CE'));
      expect(stop.body).toMatchObject({ side: 'SELL', quantity: LOT, triggerPrice: 100, orderType: bk === 'dhan' ? 'STOP_LOSS_MARKET' : 'SLM' });
      expect(netOf(m, 24000, 'CE')).toBe(0);
      expect(storedLegs(m).some(l => l.strike === 24000)).toBe(false);   // resting: not a leg

      triggerStop(m, m.orders.at(-1)!, 99.5);
      await expect.poll(() => storedLegs(m).filter(l => l.strike === 24000 && l.option === 'CE').map(l => `${l.side}:${l.status}:${l.fill?.qty}`).join(','), { timeout: 30_000 })
        .toBe(`S:OPEN:${LOT}`);
      await expect(page.getByRole('button', { name: 'Cancel stop order SELL 24000 CE' })).toBeHidden();

      // A second stop, still resting when the whole strategy is exited: it is cancelled on THIS broker.
      await placeStop('PE');
      const restingId = m.orders.at(-1)!.id;
      await page.getByRole('button', { name: 'Exit Strategy' }).first().click();
      await expect.poll(() => m.orders.find(o => o.id === restingId)?.status, { timeout: 30_000 }).toBe('CANCELLED');
      const del = m.calls.find(c => c.method === 'DELETE' && c.path === '/api/scalper/orders');
      expect(del?.body).toMatchObject({ orderId: restingId, broker: bk });
      await expect.poll(() => storedLegs(m).every(l => l.status === 'CLOSED'), { timeout: 30_000 }).toBe(true);
      for (const [k, o] of [[24300, 'CE'], [24100, 'CE'], [24000, 'CE'], [24000, 'PE'], [23900, 'PE'], [23700, 'PE']] as const) expect(netOf(m, k, o)).toBe(0);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });

    test(`${bk}: Exit Strategy keeps the hedges when a short's exit is refused`, async ({ page }) => {
      const m = newMock(bk);
      m.store.set('b1', openCondor(m));
      m.refuseOnSend.add(contractOf(bk, 24100, 'CE'));
      await install(page, m);
      await open(page);
      await page.getByRole('button', { name: 'Exit Strategy' }).first().click();
      await expect(page.getByText('Long legs NOT exited').first()).toBeVisible({ timeout: 30_000 });
      // The other short closed; the refused short and BOTH hedges are still on.
      expect(netOf(m, 23900, 'PE')).toBe(0);
      expect(netOf(m, 24100, 'CE')).toBe(-LOT);
      expect(netOf(m, 24300, 'CE')).toBe(LOT);
      expect(netOf(m, 23700, 'PE')).toBe(LOT);
      expect(orderCalls(m).every(c => c.body!.side === 'BUY')).toBe(true);
      expect(m.blocked).toEqual([]);
      expect(m.wrongBroker).toEqual([]);
    });
  });
}

// ── One broker at a time ─────────────────────────────────────────────────

test('the page shows only the selected broker: a Dhan strategy is hidden on Kotak, and Dhan is not polled for drafts', async ({ page }) => {
  const m = newMock('kotak');
  m.store.set('b1', openShort(m));
  m.store.set('d1', { ...IRON_CONDOR('dhan'), id: 'd1', name: 'Dhan Condor' });
  const seen: string[] = [];
  page.on('request', r => { seen.push(new URL(r.url()).pathname); });
  await install(page, m);
  await open(page);

  await expect(page.getByText('1 Running · 1 Total')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Exit Strategy' })).toHaveCount(1);   // the open Kotak strategy
  await expect(page.getByRole('button', { name: 'Place Basket' })).toHaveCount(0);   // the Dhan draft is not listed
  await page.waitForTimeout(4_000);   // > one 3 s poll
  // The Dhan strategy holds only drafts, so the Dhan account is not read from a Kotak page.
  expect(seen.filter(p => p === '/api/scalper/poll' || p === '/api/scalper/zerodha/poll')).toEqual([]);
  expect(m.wrongBroker).toEqual([]);

  // Switching to Dhan shows the Dhan draft and hides the Kotak strategy.
  await page.getByRole('combobox', { name: 'Broker for new strategies' }).selectOption('dhan');
  await expect(page.getByText('0 Running · 1 Total')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Place Basket' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Exit Strategy' })).toHaveCount(0);   // the Kotak strategy is not listed
  expect(orderCalls(m)).toEqual([]);
  expect(m.blocked).toEqual([]);
});

test('kotak: monthly NIFTY options and a CRUDEOILM future traded outside the page become selectable ungrouped trades, not BROKER ONLY', async ({ page }) => {
  // The 2026-10-17 book: Kotak's monthly symbols carry no expiry day, so only the instrument cache identifies them.
  const m = newMock('kotak');
  m.store.set('b1', openShort(m));   // something placed, so the leader tab adopts outside positions
  const row = (tradingSymbol: string, exchange: string, netQty: number, avg: number) => ({
    tradingSymbol, securityId: '1', exchange, productType: 'NRML', lotSize: exchange === 'mcx_fo' ? 10 : LOT, netQty,
    buyQty: netQty > 0 ? netQty : 0, sellQty: netQty < 0 ? -netQty : 0, buyAvg: netQty > 0 ? avg : 0, sellAvg: netQty < 0 ? avg : 0,
    lastTradedPrice: 0, realizedProfit: 0, unrealizedProfit: 0,
  });
  m.extraRows = [row('NIFTY26OCT22500PE', 'nse_fo', -390, 36.75), row('NIFTY27MAR24000PE', 'nse_fo', 130, 868.2), row('CRUDEOILM19NOV26FUT', 'mcx_fo', -150, 9393)];
  m.kotakExtra = {
    NIFTY26OCT22500PE: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 22500, side: 'PE' },
    NIFTY27MAR24000PE: { underlying: 'NIFTY', expiry: '2027-03-30', strike: 24000, side: 'PE' },
    CRUDEOILM19NOV26FUT: { underlying: 'CRUDEOILM', expiry: '2026-11-19', strike: 0, side: 'FUT' },
  };
  await install(page, m);
  await open(page);

  const table = page.getByRole('region', { name: 'Ungrouped trades' });
  await expect(table.getByRole('checkbox', { name: 'Select 22500 PE to group' })).toBeVisible({ timeout: 30_000 });
  await expect(table.getByRole('checkbox', { name: 'Select 24000 PE to group' })).toBeVisible();
  await expect(table.getByText('BROKER ONLY')).toHaveCount(0);
  const adopted = [...m.store.values()].flatMap(b => (b.legs as { option: string; strike: number; expiry: string; orderRef?: { symbol?: string } }[]))
    .filter(l => l.orderRef?.symbol && m.kotakExtra[l.orderRef.symbol])
    .map(l => `${l.orderRef!.symbol} ${l.strike} ${l.option} ${l.expiry}`).sort();
  expect(adopted).toEqual([
    'CRUDEOILM19NOV26FUT 0 FUT 2026-11-19',
    'NIFTY26OCT22500PE 22500 PE 2026-10-27',
    'NIFTY27MAR24000PE 24000 PE 2027-03-30',
  ]);
  expect(orderCalls(m)).toEqual([]);
  expect(m.blocked).toEqual([]);
  expect(m.wrongBroker).toEqual([]);
});
