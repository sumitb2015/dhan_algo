import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { applyHeldOp, emptyHeld, type HeldLedger, type HeldOp } from '../lib/pnfIndexHeld';

// A Renko INDEX chart that trades options (lib/pnfIndexMap.ts): Buy = the map's bullish leg, Sell = its bearish leg, each resolved by the
// server at the click; the held option is what Close / Reverse act on. Every broker-backed call is mocked, the held-option ledger too;
// any non-GET the mock does not handle is refused (599), so nothing reaches a broker.

const SPOT = 25010;
const EXPIRY = '2026-11-11';
const ID = { CE: '40001', PE: '40002' } as const;

type Target = { kind: string; symbol: string; strike?: number; side?: 'CE' | 'PE'; expiry?: string };
type OrderBody = { mode: string; broker: string; action?: string; lots?: number; close?: boolean; target: Target; exitOwn?: { side: string; units: number[]; product: string } };
type Leg = { action: 'BUY' | 'SELL'; opt: 'CE' | 'PE'; offset: number };

/** `fillsOnBook: false`: an order is 'placed' but the broker book never shows it (an exchange rejection after the reply). `otherNet`: units of
 *  the same strikes another page holds (in the broker's net, not this chart's). */
async function installMock(page: Page, opts: { orderOutcome?: (b: OrderBody) => string; fillsOnBook?: boolean; otherNet?: Partial<Record<'CE' | 'PE', number>> } = {}) {
  const placed: OrderBody[] = [];
  const resolves: { dir: string; bull: Leg; bear: Leg }[] = [];
  const blocked: string[] = [];
  const book = { net: { CE: opts.otherNet?.CE ?? 0, PE: opts.otherNet?.PE ?? 0 } as Record<'CE' | 'PE', number> };
  // the REAL held-option ledger: the route's own pure rules (lib/pnfIndexHeld.ts), in memory
  const held: { led: HeldLedger } = { led: emptyHeld() };
  const premium = { CE: 120, PE: 90 };
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf' && method === 'GET') {
      const start = Math.floor(Date.now() / 60_000) * 60 - 300;
      return json(route, {
        success: true, mode: 'price', atm: 0, strikes: [0], name: 'Nifty 50', instrument: { segment: 'IDX_I', security_id: '13' },
        errors: {}, dataDate: '2026-11-06',
        bars: { 0: [{ t: start, ce: SPOT - 20, pe: 0, straddle: SPOT - 20, vol: 0 }, { t: start + 60, ce: SPOT - 10, pe: 0, straddle: SPOT - 10, vol: 0 }, { t: start + 120, ce: SPOT, pe: 0, straddle: SPOT, vol: 0 }] },
      });
    }
    if (p === '/api/straddle-pnf/live' && method === 'GET') {
      const ids = u.searchParams.get('ids') ?? '';
      const ltp = ids === `NSE_FNO:${ID.CE}` ? premium.CE : ids === `NSE_FNO:${ID.PE}` ? premium.PE : SPOT;
      return json(route, { success: true, legs: [{ quote: { ltp, changedMs: Date.now(), prevClose: ltp, volume: 0 }, last: null }] });
    }
    if (p === '/api/straddle-pnf/contracts' && method === 'GET') {
      return json(route, { success: true, expiries: [EXPIRY, '2026-11-18'], expiry: EXPIRY, strikes: [24900, 24950, 25000, 25050, 25100], spot: SPOT, atm: 25000 });
    }
    if (p === '/api/straddle-pnf/index-trade' && method === 'GET') {
      const map = JSON.parse(u.searchParams.get('map') ?? '{}') as { bull: Leg; bear: Leg };
      const dir = u.searchParams.get('dir') as 'bull' | 'bear';
      resolves.push({ dir, ...map });
      const leg = map[dir];
      const strikes = [24900, 24950, 25000, 25050, 25100];
      const strike = strikes[2 + (leg.opt === 'CE' ? leg.offset : -leg.offset)];
      return json(route, {
        success: true, traded: { kind: 'options', symbol: 'NIFTY', name: 'NIFTY', expiry: EXPIRY, strike, side: leg.opt }, action: leg.action,
        ids: `NSE_FNO:${ID[leg.opt]}`, spot: SPOT, spotSource: 'bridge', premium: u.searchParams.get('premium') === '1' ? premium[leg.opt] : null,
        unsupported: null, legs: [{ label: `NIFTY ${strike} ${leg.opt}`, side: leg.opt, segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, tick: 0.05, key: ID[leg.opt], lotUnits: 65 }],
      });
    }
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      const t = JSON.parse(u.searchParams.get('target') ?? '{}') as Target;
      const opt = t.side === 'PE' ? 'PE' : 'CE';
      return json(route, { success: true, unsupported: null, legs: [{ label: `NIFTY ${t.strike} ${opt}`, side: opt, segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, tick: 0.05, key: ID[opt], lotUnits: 65 }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const body = req.postDataJSON() as OrderBody;
      placed.push(body);
      const outcome = opts.orderOutcome?.(body) ?? 'placed';
      const opt = body.target.side === 'PE' ? 'PE' : 'CE';
      if (outcome === 'placed' && body.mode === 'REAL' && opts.fillsOnBook !== false) {
        if (body.exitOwn) book.net[opt] += (body.exitOwn.side === 'BUY' ? 1 : -1) * body.exitOwn.units[0];
        else book.net[opt] = body.close ? 0 : book.net[opt] + (body.action === 'BUY' ? 1 : -1) * (body.lots ?? 1) * 65;
      }
      return json(route, {
        success: outcome !== 'rejected', mode: body.mode, broker: body.broker, outcome, message: outcome === 'placed' ? 'Sent.' : `Outcome ${outcome}`,
        legs: [{ label: 'leg', side: body.action ?? 'SELL', qty: (body.lots ?? 1) * 65, product: 'INTRADAY', status: outcome, orderId: 'ORD-1' }],
      });
    }
    if (p === '/api/straddle-pnf/index-held') {
      if (method === 'GET') return json(route, { success: true, ledger: held.led });
      const op = req.postDataJSON() as HeldOp;
      const r = applyHeldOp(held.led, { ...op, now: Math.floor(Date.now() / 1000) } as HeldOp);
      if (!r.ok) return json(route, { success: false, error: r.error, ledger: held.led }, r.status);
      held.led = r.ledger;
      return json(route, { success: true, ledger: r.ledger, row: r.row ?? null });
    }
    if (p === '/api/scalper/poll' && method === 'GET') {
      const positions = (['CE', 'PE'] as const).filter(o => book.net[o]).map(o => ({
        securityId: ID[o], tradingSymbol: `NIFTY-${o}`, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: book.net[o], realizedProfit: 0, unrealizedProfit: 0, lastTradedPrice: premium[o],
      }));
      return json(route, { positions, positionsError: null });
    }
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: { orderStatus: 'TRADED', filledQty: 65, averageTradedPrice: 120 } });
    if (p === '/api/straddle-pnf/server-guard') return json(route, { success: true, guards: {} });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: JSON.stringify({ success: false, error: `unmocked ${method} ${p}` }) });
  });
  return { placed, resolves, blocked, book, held, premium };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

async function openIndex(page: Page) {
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Index' }).click();
  const bar = page.getByTestId('pnf-trade-bar');
  await expect(bar.getByTestId('index-map')).toBeVisible();
  await expect(bar.getByTestId('index-map-bull-preview')).toHaveText('BUY 25000 CE');
  return bar;
}

const goReal = async (page: Page) => {
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
};

test('PAPER: a bullish SELL PE map sells the PE on Buy; the bearish click closes that leg', async ({ page }) => {
  const { placed, resolves, blocked } = await installMock(page);
  const bar = await openIndex(page);
  const bull = bar.getByTestId('index-map-bull');
  await bull.getByRole('button', { name: 'SELL' }).click();
  await bull.getByRole('button', { name: 'PE' }).click();
  await bull.getByLabel('Bullish strike').selectOption('1');
  await expect(bar.getByTestId('index-map-bull-preview')).toHaveText('SELL 24950 PE');

  await bar.getByTestId('pnf-trade-buy').click();
  await expect.poll(() => placed.length).toBe(1);
  expect(resolves[0]).toMatchObject({ dir: 'bull', bull: { action: 'SELL', opt: 'PE', offset: 1 } });
  expect(placed[0]).toMatchObject({ mode: 'PAPER', action: 'SELL', lots: 1, target: { kind: 'options', symbol: 'NIFTY', strike: 24950, side: 'PE' } });
  await expect(bar.getByTestId('index-held')).toContainText('BULL · SELL NIFTY 24950 PE');
  await expect(bar.getByTestId('pnf-trade-position')).toBeVisible();

  // the bearish button while the bullish leg is held closes it (paper: nothing is sent), it does not open the bearish leg
  await bar.getByTestId('pnf-trade-sell').click();
  await expect(bar.getByTestId('index-held')).toHaveCount(0);
  expect(placed.length).toBe(1);
  expect(resolves.length).toBe(1);
  expect(blocked).toEqual([]);
});

test('PAPER: Reverse closes the held CE, then opens the bearish leg, resolved fresh', async ({ page }) => {
  const { placed, resolves } = await installMock(page);
  const bar = await openIndex(page);
  await bar.getByRole('button', { name: '2L' }).click();
  await bar.getByTestId('pnf-trade-buy').click();
  await expect(bar.getByTestId('index-held')).toContainText('BULL · BUY NIFTY 25000 CE');

  await page.getByRole('button', { name: 'Scalper', exact: true }).click();
  const win = page.getByTestId('scalper-window');
  await expect(win.getByTestId('scalper-buy')).toContainText('BUY CE ATM');
  await expect(win.getByTestId('scalper-position')).toHaveText(/^Long 2L/);
  await win.getByTestId('scalper-reverse').click();
  await expect(bar.getByTestId('index-held')).toContainText('BEAR · BUY NIFTY 25000 PE');
  expect(resolves.map(r => r.dir)).toEqual(['bull', 'bear']);
  expect(placed.map(b => [b.action, b.target.side, b.lots])).toEqual([['BUY', 'CE', 2], ['BUY', 'PE', 2]]);
});

test('REAL: an unknown entry holds the chart (no second order) until settled by the user', async ({ page }) => {
  const { placed, held } = await installMock(page, { orderOutcome: () => 'unknown' });
  const rows = () => held.led.rows;
  const bar = await openIndex(page);
  await goReal(page);
  await bar.getByTestId('pnf-trade-buy').click();
  await expect.poll(() => placed.length).toBe(1);
  await expect(bar.getByTestId('index-held')).toContainText('UNKNOWN');
  expect(rows()[0].state).toBe('unknown');
  await expect(bar.getByTestId('pnf-trade-buy')).toBeDisabled();
  await expect(bar.getByTestId('pnf-trade-sell')).toBeDisabled();

  await bar.getByRole('button', { name: 'It did not' }).click();
  await expect(bar.getByTestId('index-held')).toHaveCount(0);
  await expect(bar.getByTestId('pnf-trade-buy')).toBeEnabled();
  expect(placed.length).toBe(1);
});

test('REAL: a refused entry leaves nothing held; a refused close on Reverse never opens the other leg', async ({ page }) => {
  let refuse: 'entry' | 'close' | null = 'entry';
  const { placed, resolves, held } = await installMock(page, {
    orderOutcome: b => (refuse === 'entry' && !b.exitOwn) || (refuse === 'close' && b.exitOwn) ? 'rejected' : 'placed',
  });
  const bar = await openIndex(page);
  await goReal(page);
  await bar.getByTestId('pnf-trade-buy').click();
  await expect.poll(() => placed.length).toBe(1);
  await expect.poll(() => held.led.rows.length).toBe(0);

  refuse = 'close';
  await bar.getByTestId('pnf-trade-buy').click();
  await expect(bar.getByTestId('index-held')).toContainText('BULL · BUY NIFTY 25000 CE');
  await expect(bar.getByTestId('pnf-trade-position')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Scalper', exact: true }).click();
  const win = page.getByTestId('scalper-window');
  await win.getByTestId('scalper-unlock').click();
  await win.getByTestId('scalper-reverse').click();
  await expect.poll(() => placed.length).toBe(3);
  // the close is sized by the chart's OWN units (an exitOwn), never a whole-contract close
  expect(placed[2]).toMatchObject({ exitOwn: { side: 'SELL', units: [65], product: 'INTRADAY' }, target: { side: 'CE' } });
  expect(placed[2].close).toBeUndefined();
  await page.waitForTimeout(500);
  expect(resolves.map(r => r.dir)).toEqual(['bull', 'bull']);   // the bearish leg was never resolved, never sent
  expect(placed.length).toBe(3);
  await expect(bar.getByTestId('index-held')).toContainText('BULL');
});

test('REAL: the other side\'s click reduces only this chart\'s own lots, even when the broker net holds another page\'s too', async ({ page }) => {
  // another page is already long 4 lots (260) of the same CE
  const { placed, held } = await installMock(page, { otherNet: { CE: 260 } });
  const bar = await openIndex(page);
  await goReal(page);
  await bar.getByTestId('pnf-trade-buy').click();
  await expect(bar.getByTestId('index-held')).toContainText('BULL · BUY NIFTY 25000 CE 11 Nov 26 · 1L');
  await bar.getByRole('button', { name: '5L' }).click();
  await bar.getByTestId('pnf-trade-sell').click();
  await expect.poll(() => placed.length).toBe(2);
  expect(placed[1]).toMatchObject({ exitOwn: { side: 'SELL', units: [65] } });   // 1 lot of 65, not the broker's 5 lots
  await expect.poll(() => held.led.rows.length).toBe(0);
  await expect(bar.getByTestId('index-held')).toHaveCount(0);
});

test('REAL: an option the broker never shows (rejected after a placed reply) is forgotten 30 s later, without a re-render', async ({ page }) => {
  test.setTimeout(120_000);
  const { placed, held } = await installMock(page, { fillsOnBook: false });
  const bar = await openIndex(page);
  await goReal(page);
  await bar.getByTestId('pnf-trade-buy').click();
  await expect.poll(() => placed.length).toBe(1);
  await expect(bar.getByTestId('index-held')).toContainText('BULL');
  await page.waitForTimeout(10_000);
  expect(held.led.rows.length).toBe(1);                                          // not before the fill-lag grace
  await expect.poll(() => held.led.rows.length, { timeout: 45_000 }).toBe(0);
  await expect(bar.getByTestId('index-held')).toHaveCount(0);
});
