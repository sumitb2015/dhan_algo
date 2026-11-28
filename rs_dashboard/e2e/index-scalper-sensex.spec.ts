import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { installSessionClock, sessionIso } from './isxClock';

// /index-scalper on SENSEX (BSE) with every /api/* call mocked in the browser: no Dhan / Kotak session is needed and no
// order can reach a broker. Any non-GET the mock does not handle is refused with 599 and fails the test.
// Never add an unmocked order case: on a machine with a live token it would trade.

interface Call { path: string; body: Record<string, unknown> | null }

const SPOT = 84960;
const FUT_ID = '1145756';
// Dhan ids per strike (CE, PE); BSE SENSEX strikes step 100
const IDS: Record<string, [string, string]> = {
  '84900': ['1165201', '1165202'],
  '85000': ['1165299', '1165300'],
  '85100': ['1165401', '1165402'],
};
const NIFTY_IDS: Record<string, [string, string]> = { '25350': ['302', '402'] };
const LOT = 20; // the lookup's lot for the expiry on screen (never hardcoded on the page)

function candles(base: number) {
  const start = Date.UTC(2026, 10, 20, 3, 45, 0) / 1000;
  return Array.from({ length: 75 }, (_, i) => {
    const b = base - 60 + Math.sin(i / 6) * 60;
    return { t: start + i * 300, o: b, h: b + 20, l: b - 20, c: b + (i % 2 ? 8 : -8) };
  });
}

type MockState = {
  calls: Call[]; blocked: Call[]; positions: Record<string, unknown>[];
  candleCalls: string[]; lookups: string[]; liveStarts: Record<string, unknown>[];
  kotakPositions?: Record<string, unknown>[];
  /** The screen shows the Jan 2027 weekly (lot 25) instead of Dec 3 (lot 20). */
  jan?: boolean;
  lotCalls?: string[];
};
// Jan 2027 weekly contracts (lot 25); the Dec ids above are lot 20.
const JAN_IDS: Record<string, [string, string]> = { '84900': ['1172201', '1172202'], '85000': ['1172299', '1172300'], '85100': ['1172401', '1172402'] };
const MASTER_LOTS: Record<string, number> = Object.fromEntries([
  ...Object.values(IDS).flat().map(id => [id, 20]), ...Object.values(JAN_IDS).flat().map(id => [id, 25]),
]);

async function mockApi(page: Page, state: MockState) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    const und = u.searchParams.get('underlying') ?? 'NIFTY';

    if (p === '/api/index-scalper/candles') {
      state.candleCalls.push(req.url());
      const kind = u.searchParams.get('kind') ?? 'underlying';
      return json(route, { success: true, candles: candles(kind === 'option' ? 300 : und === 'SENSEX' ? SPOT : 25350), interval: '5' });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: [und === 'SENSEX' ? (state.jan ? '2027-01-07' : '2026-12-03') : '2026-12-01'] });
    if (p === '/api/index-scalper/lots') {
      (state.lotCalls ??= []).push(req.url());
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return json(route, { success: true, lots: Object.fromEntries(ids.filter(id => MASTER_LOTS[id]).map(id => [id, MASTER_LOTS[id]])) });
    }
    if (p === '/api/scalper/lookup') {
      state.lookups.push(`${und}:${u.searchParams.get('expiry')}`);
      const ids = und === 'SENSEX' ? (state.jan ? JAN_IDS : IDS) : NIFTY_IDS;
      const strikes = Object.fromEntries(Object.entries(ids).map(([k, [ce, pe]]) => [k, { ceId: ce, peId: pe }]));
      // the shape scripts/tools/scalper_api.py `lookup` returns: SENSEX's lot from the expiry's own rows + its BSE future
      return json(route, { success: true, data: und === 'SENSEX'
        ? { lotSize: state.jan ? 25 : LOT, strikes, future: { securityId: FUT_ID, expiry: '2026-12-31' }, freezeQty: 1001 }
        : { lotSize: 65, strikes } });
    }
    if (p === '/api/options/chain') return json(route, { success: true, data: { chain: { oc: {} }, spot: SPOT } });
    if (p === '/api/options/margin') return json(route, { success: true, data: { total_margin: 120000 } });
    if (p === '/api/options/live') {
      if (method === 'POST') {
        if (body?.action === 'start') state.liveStarts.push(body);
        return json(route, { success: true });
      }
      const ids = und === 'SENSEX' ? IDS : NIFTY_IDS;
      const strikes = Object.fromEntries(Object.keys(ids).map(k => [k, {
        strike: Number(k),
        ce: { ltp: 310.5, oi: 52000, prev_oi: 40000, oi_chg_pct: 30, change_pct: -2.1, buildup: 'SB', volume: 1000 },
        pe: { ltp: 280.0, oi: 61000, prev_oi: 50000, oi_chg_pct: 22, change_pct: 1.5, buildup: 'LB', volume: 1200 },
      }]));
      return json(route, {
        success: true, status: { status: 'RUNNING' },
        quotes: und === 'SENSEX'
          ? { underlying: 'SENSEX', expiry: state.jan ? '2027-01-07' : '2026-12-03', spot: SPOT, atm: 85000, updated_at: sessionIso(), strikes,
              future: { ltp: SPOT + 40, symbol: '', expiry: '2026-12-31', volume: 5000 } }
          : { underlying: 'NIFTY', expiry: '2026-12-01', spot: 25350, atm: 25350, updated_at: sessionIso(), strikes },
      });
    }
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 1000000, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 0.05 });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order') {
      state.calls.push({ path: p, body });
      return json(route, { success: true, order_id: '9001' });
    }
    if (p === '/api/index-scalper/kotak-order') {
      if (method === 'GET') return json(route, { success: true, day: '2026-11-25', records: [] });
      state.calls.push({ path: p, body });
      return json(route, { success: true, order_id: 'K9001' });
    }
    if (p === '/api/scalper/kotak/lookup') {
      return json(route, { success: true, data: {
        lotSize: LOT, exchangeSegment: 'bse_fo', freezeQty: 1000, future: { trading_symbol: 'SENSEX26DECFUT' },
        strikes: Object.fromEntries(Object.keys(IDS).map(k => [k, { ceSymbol: `SENSEX26D03${k}CE`, peSymbol: `SENSEX26D03${k}PE` }])),
      } });
    }
    if (p === '/api/scalper/kotak/symbol-lookup') {
      return json(route, { success: true, data: {
        ...Object.fromEntries(Object.keys(IDS).flatMap(k => [
          [`SENSEX26D03${k}CE`, { expiry: '2026-12-03', strike: Number(k), side: 'CE' }],
          [`SENSEX26D03${k}PE`, { expiry: '2026-12-03', strike: Number(k), side: 'PE' }],
        ])),
        SENSEX26DECFUT: { expiry: '2026-12-31', strike: 0, side: 'FUT' },
      } });
    }
    if (p === '/api/scalper/kotak/funds') return json(route, { success: true, data: { availabelBalance: 500000, availableBalance: 500000, utilizedAmount: 0 } });
    if (p === '/api/scalper/kotak/positions' || p === '/api/index-scalper/kotak-positions') return json(route, { success: true, data: state.kotakPositions ?? [] });
    if (p === '/api/scalper/kotak/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/equity-order/holdings') return json(route, { success: true, data: {} });
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

const newState = (): MockState => ({ calls: [], blocked: [], positions: [], candleCalls: [], lookups: [], liveStarts: [] });

async function openSensex(page: Page, context: import('@playwright/test').BrowserContext, state: MockState) {
  await signIn(context);
  await mockApi(page, state);
  await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('index-scalper')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel('Broker for new orders')).toBeEnabled({ timeout: 30_000 }); // hydrated: clicks land
  await page.getByRole('button', { name: 'SENSEX', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SENSEX', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => state.lookups.includes(`SENSEX:${state.jan ? '2027-01-07' : '2026-12-03'}`), { timeout: 15_000 }).toBe(true);
}

test.describe('Index Scalper - SENSEX (BSE)', () => {
  test.beforeEach(async ({ page }) => { await installSessionClock(page); });

  test('SENSEX index, FUT and option panes load their own candles; the bridge starts for SENSEX; SIM buy fills 1 lot = 20 units', async ({ page, context }) => {
    const state = newState();
    await openSensex(page, context, state);
    const pane = page.getByTestId('chart-pane-0');
    await expect(pane).toContainText('SENSEX', { timeout: 30_000 });
    await expect.poll(() => state.liveStarts.some(b => b.underlying === 'SENSEX' && b.expiry === '2026-12-03'), { timeout: 15_000 }).toBe(true);
    // the index pane asks for SENSEX candles (the route pins IDX_I / 51 itself)
    await expect.poll(() => state.candleCalls.some(c => c.includes('underlying=SENSEX') && !c.includes('kind=')), { timeout: 15_000 }).toBe(true);

    // FUT pane: the SENSEX future by the lookup's BSE id, chart only (no "+" order menu)
    await pane.getByRole('button', { name: 'FUT', exact: true }).click();
    await expect.poll(() => state.candleCalls.some(c => c.includes('underlying=SENSEX') && c.includes(`kind=future&securityId=${FUT_ID}`)), { timeout: 15_000 }).toBe(true);
    // option pane: 85000 CE (ATM of the 100-point strikes) by its BSE id
    await pane.getByRole('button', { name: 'CE', exact: true }).click();
    await expect.poll(() => state.candleCalls.some(c => c.includes('kind=option&securityId=1165299')), { timeout: 15_000 }).toBe(true);
    await pane.getByRole('button', { name: 'Index', exact: true }).click();

    // chain on SENSEX strikes, and a paper buy from it
    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByRole('button', { name: 'Trade 85000 PE' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Trade 85000 PE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket.getByText('SIM · paper')).toBeVisible();
    await ticket.getByRole('button', { name: /^Buy / }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toContainText('PE 85000');
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Long 1 lot (20 units)');
    await ticket.getByRole('button', { name: 'Close order ticket' }).click();
    await page.getByRole('button', { name: 'Exit PE 85000' }).click();
    await expect(pane.getByTestId('position-chip')).toHaveCount(0);

    expect(state.calls).toEqual([]); // paper only
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade shows SENSEX strike chips with live premiums; a SIM buy draws a leg on its strike', async ({ page, context }) => {
    const state = newState();
    await openSensex(page, context, state);
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await expect(overlay.getByRole('button', { name: 'Quick 85000 CE' })).toContainText('310.50', { timeout: 15_000 });
    await expect(overlay.getByRole('button', { name: 'Quick 85000 PE' })).toContainText('280.00');
    await expect(overlay.locator('[data-strike="85000"]')).toContainText('ATM');
    // price % and OI % above each chip, OI coloured by its buildup: CE price down + OI up = Short Buildup (rose),
    // PE price up + OI up = Long Buildup (emerald)
    const stats = overlay.locator('[data-strike="85000"]').getByTestId('quick-chip-stats');
    await expect(stats.nth(0)).toHaveText(/-2\.1%\s*\|\s*\+30\.0%/);
    await expect(stats.nth(0)).toHaveAttribute('data-buildup', 'SB');
    await expect(stats.nth(0).locator('span').nth(2)).toHaveClass(/text-rose-400/);
    await expect(stats.nth(1)).toHaveText(/\+1\.5%\s*\|\s*\+22\.0%/);
    await expect(stats.nth(1)).toHaveAttribute('data-buildup', 'LB');
    await expect(stats.nth(1).locator('span').nth(2)).toHaveClass(/text-emerald-400/);
    // the stats line sits above its chip without touching the row above
    const ceBox = (await overlay.getByRole('button', { name: 'Quick 85000 CE' }).boundingBox())!;
    const stBox = (await stats.nth(0).boundingBox())!;
    expect(stBox.y + stBox.height).toBeLessThanOrEqual(ceBox.y + 0.5);
    expect(stBox.width).toBeLessThanOrEqual(ceBox.width + 0.5);
    // the widest values it can show (two 6-character percents and the | separator) still fit inside the chip's width
    const worst = await stats.nth(0).evaluate(el => {
      const [a, , b] = Array.from(el.querySelectorAll('span'));
      const keep = [a.textContent, b.textContent];
      a.textContent = '-99.9%'; b.textContent = '+99.9%';
      const w = el.scrollWidth;
      a.textContent = keep[0]; b.textContent = keep[1];
      return w;
    });
    expect(worst).toBeLessThanOrEqual(ceBox.width + 0.5);
    if (process.env.ISX_SHOT) await page.screenshot({ path: process.env.ISX_SHOT, clip: { x: ceBox.x - 120, y: ceBox.y - 60, width: 340, height: 120 } });
    // the Quick Trade settings switch hides the line (and back on), remembered
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    const statsSwitch = page.getByRole('switch', { name: 'Show price and OI change' });
    await expect(statsSwitch).toBeChecked();
    await statsSwitch.click();
    await expect(overlay.getByTestId('quick-chip-stats')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('indexScalper.quick.v1') ?? '{}').showStats)).toBe(false);
    await statsSwitch.click();
    await expect(stats.nth(0)).toBeVisible();
    // strong tag below the chip: none at the defaults (price ±10%, OI +20%); CE -2.1% with OI +30% is Strong Bearish at
    // price ±2%, PE +1.5% stays untagged; OI ≥ 40% takes the CE tag away again
    const strong = overlay.locator('[data-strike="85000"]').getByTestId('quick-chip-strong');
    await expect(strong).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Strong tag price move' }).selectOption('2');
    await expect(strong).toHaveCount(1);
    await expect(strong).toHaveAttribute('data-strong', 'bear');
    await expect(strong).toHaveText(/Strong Bearish/);
    const tagBox = (await strong.boundingBox())!;
    const ceNow = (await overlay.getByRole('button', { name: 'Quick 85000 CE' }).boundingBox())!;
    expect(tagBox.y).toBeGreaterThanOrEqual(ceNow.y + ceNow.height - 0.5); // below the chip
    expect(await strong.evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(ceNow.width + 0.5);
    if (process.env.ISX_SHOT2) await page.screenshot({ path: process.env.ISX_SHOT2, clip: { x: ceNow.x - 120, y: ceNow.y - 60, width: 340, height: 120 } });
    await page.getByRole('combobox', { name: 'Strong tag OI change' }).selectOption('40');
    await expect(strong).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('indexScalper.quick.v1') ?? '{}'))).toMatchObject({ strongPricePct: 2, strongOiPct: 40 });
    await page.getByRole('switch', { name: 'Strong bull or bear tag' }).click();
    await expect(page.getByRole('combobox', { name: 'Strong tag price move' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await overlay.getByRole('button', { name: 'Quick 85000 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 85000 CE 1 lot' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Long 1 lot (20 units)', { timeout: 15_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Dhan REAL: an option buy is BSE_FNO, quantity = lots x the expiry\'s lot, tagged isx; Exit closes the broker row in full', async ({ page, context }) => {
    const state = newState();
    // a short 85000 CE opened elsewhere (2 lots = 40 units), plus a SENSEX future and a NIFTY option that must stay off
    state.positions = [
      { tradingSymbol: 'SENSEX-Dec2026-85000-CE', securityId: '1165299', exchangeSegment: 'BSE_FNO', productType: 'INTRADAY', netQty: -40, sellAvg: 320.5, buyAvg: 0, costPrice: 320.5, positionType: 'SHORT' },
      { tradingSymbol: 'SENSEX-Dec2026-FUT', securityId: FUT_ID, exchangeSegment: 'BSE_FNO', productType: 'MARGIN', netQty: 20, buyAvg: 84900, costPrice: 84900, sellAvg: 0, positionType: 'LONG' },
      { tradingSymbol: 'NIFTY-Dec2026-25350-PE', securityId: '402', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' },
    ];
    await openSensex(page, context, state);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    await expect(page.getByRole('button', { name: 'NIFTY', exact: true })).toBeDisabled(); // no switch while armed
    await expect(page.getByRole('button', { name: 'SENSEX', exact: true })).toBeDisabled();

    const chips = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chips).toHaveCount(1, { timeout: 15_000 }); // only the SENSEX option
    await expect(chips).toContainText('CE 85000');
    await expect(chips.getByTestId('position-lots')).toHaveText('2');
    await expect(chips).toContainText('+400 INR'); // 40 x (320.50 - 310.50)

    // Buy 2 lots of 85000 PE from the ticket
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 85000 PE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await ticket.getByLabel(/Lots/).fill('2');
    await ticket.getByLabel(/Lots/).blur();
    await ticket.getByRole('button', { name: /^Buy / }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].path).toBe('/api/scalper/fast-order');
    expect(state.calls[0].body).toMatchObject({ securityId: '1165300', exchangeSegment: 'BSE_FNO', side: 'BUY', quantity: 40, source: 'isx' });
    await ticket.getByRole('button', { name: 'Close order ticket' }).click();
    await page.getByRole('button', { name: 'Close option chain' }).click();

    // Exit on the short CE: sized from a fresh broker read, whoever opened it, uncapped close tag
    await chips.filter({ hasText: 'CE 85000' }).getByRole('button', { name: 'Exit CE 85000' }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(2);
    expect(state.calls[1].body).toMatchObject({ securityId: '1165299', exchangeSegment: 'BSE_FNO', side: 'BUY', quantity: 40, orderType: 'MARKET', productType: 'INTRADAY', source: 'isxx' });
    expect(state.blocked).toEqual([]);
  });

  test('SENSEX caps an order at 20 lots: 21 is refused and nothing is sent', async ({ page, context }) => {
    const state = newState();
    await openSensex(page, context, state);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 85000 CE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await expect(ticket).toContainText('max 20');
    await ticket.getByLabel(/Lots/).fill('21');
    await ticket.getByRole('button', { name: /^Buy / }).click();
    await expect(ticket).toContainText('Max 20 lots per order');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Kotak REAL: SENSEX option ordered by Kotak symbol in units (lots x 20); Kotak SENSEX rows are legs, its future is not', async ({ page, context }) => {
    const state = newState();
    state.kotakPositions = [
      { tradingSymbol: 'SENSEX26D0384900CE', productType: 'MIS', netQty: -20, sellAvg: 330, buyAvg: 0 },
      { tradingSymbol: 'SENSEX26DECFUT', productType: 'NRML', netQty: 20, buyAvg: 84900, sellAvg: 0 },
    ];
    await page.addInitScript(() => { try { localStorage.setItem('indexScalper.broker', 'kotak'); } catch { /* ignore */ } });
    await openSensex(page, context, state);
    await expect(page.getByLabel('Broker for new orders')).toHaveValue('kotak');
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: /Arm REAL on Kotak/i }).click();

    const chips = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chips).toHaveCount(1, { timeout: 20_000 });
    await expect(chips).toContainText('CE 84900');
    await expect(chips.getByTestId('position-lots')).toHaveText('1');

    await page.getByRole('button', { name: 'Option chain' }).click();
    await page.getByRole('button', { name: 'Trade 85000 CE' }).click();
    const ticket = page.getByTestId('order-ticket');
    await ticket.getByLabel(/Lots/).fill('3');
    await ticket.getByLabel(/Lots/).blur();
    await ticket.getByRole('button', { name: /^Sell / }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(1);
    expect(state.calls[0].path).toBe('/api/index-scalper/kotak-order');
    expect(state.calls[0].body).toMatchObject({ tradingSymbol: 'SENSEX26D0385000CE', quantity: 60, side: 'SELL', intent: 'open' });
    expect(state.calls[0].body).not.toHaveProperty('securityId');
    expect(state.blocked).toEqual([]);
  });
  test('a Dec position (lot 20) under a Jan screen (lot 25) is sized with ITS lot: 4 lots shown, Reverse sends 80 units, not 100', async ({ page, context }) => {
    const state = newState();
    state.jan = true;
    state.positions = [
      { tradingSymbol: 'SENSEX-Dec2026-85000-CE', securityId: '1165299', exchangeSegment: 'BSE_FNO', productType: 'INTRADAY', netQty: -80, sellAvg: 320.5, buyAvg: 0, costPrice: 320.5, positionType: 'SHORT' },
    ];
    await openSensex(page, context, state);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    // the Dec contract's lot is asked from the master list (it is not on the Jan screen)
    await expect.poll(() => (state.lotCalls ?? []).some(c => c.includes('segment=BSE_FNO') && c.includes('1165299')), { timeout: 15_000 }).toBe(true);
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('4', { timeout: 15_000 }); // 80 / 20, not 80 / 25
    await chip.getByRole('button', { name: 'Reverse CE 85000' }).click();
    await page.getByRole('alertdialog', { name: 'Reverse position' }).getByRole('button', { name: /^Reverse to long/ }).click();
    await expect.poll(() => state.calls.length, { timeout: 15_000 }).toBe(2);
    expect(state.calls[0].body).toMatchObject({ securityId: '1165299', exchangeSegment: 'BSE_FNO', side: 'BUY', quantity: 80, source: 'isxx' });
    expect(state.calls[1].body).toMatchObject({ securityId: '1165299', exchangeSegment: 'BSE_FNO', side: 'BUY', quantity: 80, source: 'isx' });
    expect(state.blocked).toEqual([]);
  });

  test('a held contract whose lot the master list does not know: Reverse is refused, nothing sent', async ({ page, context }) => {
    const state = newState();
    state.jan = true;
    state.positions = [
      { tradingSymbol: 'SENSEX-Dec2026-85000-PE', securityId: '1199999', exchangeSegment: 'BSE_FNO', productType: 'INTRADAY', netQty: 40, buyAvg: 200, sellAvg: 0, costPrice: 200, positionType: 'LONG' },
    ];
    await openSensex(page, context, state);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: /Arm REAL on Dhan/i }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => (state.lotCalls ?? []).some(c => c.includes('1199999')), { timeout: 15_000 }).toBe(true);
    await chip.getByRole('button', { name: 'Reverse PE 85000' }).click();
    await page.getByRole('alertdialog', { name: 'Reverse position' }).getByRole('button', { name: /^Reverse to short/ }).click();
    await expect(page.getByText(/Cannot reverse PE 85000/)).toBeVisible({ timeout: 15_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });
});
