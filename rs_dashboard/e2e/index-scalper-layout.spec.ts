import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { installSessionClock, sessionIso } from './isxClock';

// /index-scalper's 1 / 2 chart layout and option (premium) charts, with every /api/* call mocked in the browser: no
// Dhan session needed and no order can reach a broker. Any non-GET the mock does not handle is refused with 599.

interface Call { path: string; body: Record<string, unknown> | null }
const SPOT = 25350;
const IDS: Record<string, [string, string]> = { '25300': ['301', '401'], '25350': ['302', '402'], '25400': ['303', '403'] };
// The expiry lists many more strikes than the bridge ticks: 23000-27000 step 50 (middle 25000, which is NOT ATM).
const ALL_STRIKES = Array.from({ length: 81 }, (_, i) => 23000 + i * 50);
const idsOf = (k: number): [string, string] => IDS[String(k)] ?? [`9${k}1`, `9${k}2`];

function bars(level: number, swing: number) {
  const start = Date.UTC(2026, 10, 20, 3, 45, 0) / 1000;
  return Array.from({ length: 75 }, (_, i) => {
    const base = level + Math.sin(i / 6) * swing;
    return { t: start + i * 300, o: base, h: base + swing / 4, l: base - swing / 4, c: base + (i % 2 ? 1 : -1) * swing / 8 };
  });
}

interface State { calls: Call[]; blocked: Call[]; bridgeStarts: string[]; candleReqs: string[]; positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; noSpot?: boolean; noPrevOi?: boolean; noLtpStrike?: number; snapChain?: boolean; ce25350?: number; optVolume?: boolean }

async function mockApi(page: Page, state: State) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    if (p === '/api/index-scalper/candles') {
      state.candleReqs.push(u.search);
      const opt = u.searchParams.get('kind') === 'option';
      if (u.searchParams.get('kind') === 'future') return json(route, { success: true, candles: bars(SPOT + 110, 40).map((b, i) => ({ ...b, v: 50_000 + (i % 7) * 9_000 })), interval: u.searchParams.get('interval') });
      const cs = opt ? bars(210, 20) : bars(SPOT, 40);
      // option bars carry volume when asked (the index never does)
      return json(route, { success: true, candles: opt && state.optVolume ? cs.map((b, i) => ({ ...b, v: 1000 + (i % 9) * 400 })) : cs, interval: u.searchParams.get('interval') });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(ALL_STRIKES.map(k => { const [ce, pe] = idsOf(k); return [String(k), { ceId: ce, peId: pe }]; }));
      // the NIFTY future (nearest on or after the option expiry), as scalper_api.py's lookup returns it
      return json(route, { success: true, data: { lotSize: 65, strikes, future: { securityId: '58875', expiry: '2026-12-29' } } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      if (state.noSpot) return json(route, { success: true, status: { status: 'STARTING' }, quotes: null });
      // 21 strikes around ATM; Call OI peaks above spot (25600), Put OI below it (25100)
      const live = ALL_STRIKES.filter(k => Math.abs(k - SPOT) <= 500);
      // previous-day OI: Calls added above spot and shed below it; Puts the other way round
      const side = (oi: number, grew: boolean) => {
        const prev = Math.round(oi / (grew ? 1.25 : 0.8));
        return state.noPrevOi
          ? { oi, oi_chg_pct: 0 } // a bridge without a baseline: 0.0 means unknown
          : { oi, prev_oi: prev, oi_chg_pct: ((oi - prev) / prev) * 100 };
      };
      const strikes = Object.fromEntries(live.map(k => {
        const ceOi = Math.round(4_000_000 * Math.exp(-(((k - 25600) / 180) ** 2))) + 200_000;
        const peOi = Math.round(3_500_000 * Math.exp(-(((k - 25100) / 180) ** 2))) + 200_000;
        return [String(k), {
          strike: k,
          ce: { ...(state.noLtpStrike === k ? { prev_close: 88.4 } : {}), ltp: state.noLtpStrike === k ? 0 : k === 25350 && state.ce25350 ? state.ce25350 : IDS[String(k)] ? 210.5 : 100, change_pct: -3, buildup: 'SB', ...side(ceOi, k >= SPOT) },
          pe: { ltp: IDS[String(k)] ? 229.95 : 100, change_pct: 5, buildup: 'LB', ...side(peOi, k < SPOT) },
        }];
      }));
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-12-01', spot: SPOT, atm: SPOT, updated_at: sessionIso(), strikes, future: { ltp: SPOT + 110, expiry: '2026-12-29', volume: 2_000_000 } } });
    }
    if (p === '/api/options/chain') {
      if (!state.snapChain) return json(route, { success: false, error: 'e2e: no chain' }, 502);
      // Dhan REST shape (strike keys "25350.000000"): the last traded prices of a closed market
      const oc = Object.fromEntries(ALL_STRIKES.filter(k => Math.abs(k - SPOT) <= 300).map(k => [`${k}.000000`, {
        ce: { last_price: 195, oi: 2_761_590, previous_close_price: 180, previous_oi: 2_000_000, volume: 1 },
        pe: { last_price: 54.5, oi: 6_129_890, previous_close_price: 60, previous_oi: 6_000_000, volume: 1 },
      }]));
      return json(route, { success: true, data: { chain: { oc }, spot: SPOT } });
    }
    if (p === '/api/options/margin') return json(route, { success: true, data: { total_margin: 100000 } });
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: state.orders });
    if (p === '/api/scalper/orders' && method === 'DELETE') { state.calls.push({ path: p, body }); return json(route, { success: true }); }
    if (p === '/api/scalper/orders' && method === 'PATCH') { state.calls.push({ path: `${p}#PATCH`, body }); return json(route, { success: true }); }
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 0.05 });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order') { state.calls.push({ path: p, body }); return json(route, { success: true, order_id: '7001' }); }
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) { state.bridgeStarts.push(p); return json(route, { success: true }); }
    if (p === '/api/index-scalper/market-watch/stream') {
      // one SSE frame per connection (EventSource reconnects on its own); stamped with the page's session clock
      const want = (u.searchParams.get('want') ?? '').split(',');
      const frame: Record<string, unknown> = {};
      if (want.includes('indices')) frame.indices = { updated_at: sessionIso(), quotes: {
        NIFTY: { ltp: 25500, prev_close: 25000, high: 25600, low: 24900 },
        BANKNIFTY: { ltp: 55440, prev_close: 56000 },
        VIX: { ltp: 12, prev_close: 0 }, // no genuine previous close: the move is unknown
      } };
      if (want.includes('stocks')) frame.stocks = { updated_at: sessionIso(), quotes: {
        HDFCBANK: { ltp: 1010, prev_close: 1000 },
        RELIANCE: { ltp: 1485, prev_close: 1500 },
      } };
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(frame)}\n\n` });
    }
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

/** Saves the default target / stop as switched off before the page loads (it is on by default). */
const defaultBracketsOff = (page: Page) => page.addInitScript(() => {
  try { localStorage.setItem('indexScalper.defaultBrackets.v1', JSON.stringify({ on: false, tpPct: 30, slPct: 20 })); } catch { /* private mode */ }
});
const newState = (): State => ({ calls: [], blocked: [], bridgeStarts: [], candleReqs: [], positions: [], orders: [] });

async function dragFrom(page: Page, locator: ReturnType<Page['locator']>, dy: number) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('no box');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - 40, y + (dy * i) / 8);
  await page.mouse.up();
}

test.describe('Index Scalper layout + option charts', () => {
  test.beforeEach(async ({ page }) => { await installSessionClock(page); });

  test('ATM waits for a price (never the middle of the strike list), and the strike list shows every strike', async ({ page, context }) => {
    const state = newState();
    state.noSpot = true; // the bridge has not sent a price yet, and there is no chain snapshot
    await signIn(context);
    await page.addInitScript(() => {
      // a pane config saved before this fix, pinned to a guessed strike: it must go back to ATM
      if (!localStorage.getItem('indexScalper.layout.v2')) {
        localStorage.setItem('indexScalper.layout.v1', JSON.stringify({ layout: 2, panes: [
          { source: { kind: 'underlying' }, interval: '5' }, { source: { kind: 'option', type: 'CE', strike: 24200 }, interval: '3' },
        ] }));
      }
    });
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const right = page.getByTestId('chart-pane-1');
    await expect(right).toBeVisible({ timeout: 60_000 });
    await expect(right).toContainText('Waiting for the NIFTY price to pick the ATM strike', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    expect(state.candleReqs.filter(q => q.includes('kind=option'))).toEqual([]); // nothing pinned, nothing loaded

    state.noSpot = false; // NIFTY at 25350 arrives
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350', { timeout: 30_000 });
    await expect(right.getByRole('button', { name: '3m', exact: true })).toHaveAttribute('aria-pressed', 'true'); // v1 timeframe kept
    expect(state.candleReqs.some(q => q.includes('securityId=250001'))).toBe(false); // 25000 (list middle) never charted
    expect(state.candleReqs.some(q => q.includes('securityId=242001'))).toBe(false); // v1's 24200 never charted

    // every strike of the expiry, ATM marked
    const opts = right.getByLabel('Chart 2 strike').locator('option');
    await expect(opts).toHaveCount(ALL_STRIKES.length);
    await expect(opts.first()).toHaveText('23000');
    await expect(opts.last()).toHaveText('27000');
    await expect(right.getByLabel('Chart 2 strike').locator('option:checked')).toHaveText('25350 (ATM)');

    // a picked far strike is a user choice: kept across a reload; the pane's own ATM pin is saved as ATM
    await right.getByLabel('Chart 2 strike').selectOption('23500');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('indexScalper.layout.v2') ?? '{}').panes?.[1]?.source?.strike)).toBe(23500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-1').getByLabel('Chart 2 strike')).toHaveValue('23500', { timeout: 60_000 });
    expect(state.blocked).toEqual([]);
  });

  test('OI profile: Call / Put bars on the index chart only, toggled from the header and remembered', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const left = page.getByTestId('chart-pane-0'), right = page.getByTestId('chart-pane-1');
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350', { timeout: 60_000 });
    await expect(page.getByRole('switch', { name: 'OI profile' })).toBeChecked();
    await expect(left.getByTestId('oi-profile')).toHaveCount(1);
    await expect(right.getByTestId('oi-profile')).toHaveCount(0); // a premium chart has no strike levels
    // something is painted: red (Call) and green (Put) pixels on the index chart's overlay
    await expect.poll(() => left.getByTestId('oi-profile').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let red = 0, green = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 0) continue; if (d[i] > d[i + 1] + 60) red++; else if (d[i + 1] > d[i] + 60) green++; }
      return red > 50 && green > 50;
    }), { timeout: 10_000 }).toBe(true);

    await page.getByRole('switch', { name: 'OI profile' }).click();
    await expect(page.getByRole('switch', { name: 'OI profile' })).not.toBeChecked();
    await expect(left.getByTestId('oi-profile')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('switch', { name: 'OI profile' })).not.toBeChecked({ timeout: 60_000 });
    await expect(page.getByTestId('oi-profile')).toHaveCount(0);
    // clicking the switch's label (its icon, not the switch) turns it back on, exactly once: not toggled twice
    await page.locator('label').filter({ has: page.getByRole('switch', { name: 'OI profile' }) }).click({ position: { x: 10, y: 14 } });
    await expect(page.getByRole('switch', { name: 'OI profile' })).toBeChecked();
    await expect(page.getByTestId('chart-pane-0').getByTestId('oi-profile')).toHaveCount(1);
    expect(state.blocked).toEqual([]);
  });

  test('OI profile shows total OI or the change in OI (added filled, shed outlined); no baseline is said, not drawn as 0', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const left = page.getByTestId('chart-pane-0');
    await expect(left.getByTestId('oi-profile')).toHaveCount(1, { timeout: 60_000 });
    const total = page.getByRole('button', { name: 'Total OI' }), chg = page.getByRole('button', { name: 'Change in OI' });
    await expect(total).toHaveAttribute('aria-pressed', 'true');
    // pixels: filled red / green, and in change mode also outline-only rows (shed OI)
    const painted = () => left.getByTestId('oi-profile').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    await expect.poll(painted, { timeout: 10_000 }).toBeGreaterThan(200);
    const totalPx = await painted();

    await chg.click();
    await expect(chg).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await painted()) !== totalPx, { timeout: 10_000 }).toBe(true); // a different picture
    await expect.poll(painted).toBeGreaterThan(100);
    await expect(left.getByTestId('oi-change-unavailable')).toHaveCount(0);

    // remembered across a reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Change in OI' })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });

    // the OI switch off disables the choice
    await page.getByRole('switch', { name: 'OI profile' }).click();
    await expect(page.getByRole('button', { name: 'Change in OI' })).toBeDisabled();
    await page.getByRole('switch', { name: 'OI profile' }).click();

    // a chain with no previous-day OI: change mode draws nothing and says why
    state.noPrevOi = true;
    await expect(page.getByTestId('chart-pane-0').getByTestId('oi-change-unavailable')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.getByTestId('chart-pane-0').getByTestId('oi-profile').evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
      return true;
    }), { timeout: 10_000 }).toBe(true);
    // ...while total OI still draws
    await page.getByRole('button', { name: 'Total OI' }).click();
    await expect(page.getByTestId('chart-pane-0').getByTestId('oi-change-unavailable')).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });

  test('30m and 1h timeframes: buttons load those candles and are remembered', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    const tf = page.getByRole('group', { name: 'Chart 1 timeframe' });
    await expect(tf.getByRole('button')).toHaveText(['1m', '3m', '5m', '15m', '30m', '1h']);
    await tf.getByRole('button', { name: '1h' }).click();
    await expect(tf.getByRole('button', { name: '1h' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => state.candleReqs.some(q => q.includes('interval=60'))).toBe(true);
    await tf.getByRole('button', { name: '30m' }).click();
    await expect.poll(() => state.candleReqs.some(q => q.includes('interval=30'))).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('group', { name: 'Chart 1 timeframe' }).getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
    expect(state.blocked).toEqual([]);
  });

  test('REAL working order: lots and price edited from its chip, and its line dragged to a new price (modify, isx)', async ({ page, context }) => {
    const state = newState();
    const ord = (x: Record<string, unknown>) => ({
      securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      transactionType: 'BUY', orderType: 'LIMIT', price: 200, triggerPrice: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING',
      drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01', ...x,
    });
    state.orders = [
      ord({ orderId: 'L1', correlationId: 'isxl1' }),
      ord({ orderId: 'F1', correlationId: 'stg01', price: 190, createTime: '2026-11-25 09:20:00' }), // a strategy's
    ];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const right = page.getByTestId('chart-pane-1');
    await expect(right).toContainText('NIFTY 25350 CE', { timeout: 30_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const patches = () => state.calls.filter(c => c.path === '/api/scalper/orders#PATCH').map(c => c.body);

    // the page's own order is editable; the strategy's has no editor and no drag handle
    await expect(right.getByRole('button', { name: 'Edit order L1' })).toHaveText('1 lot', { timeout: 15_000 });
    await expect(right.getByRole('button', { name: 'Edit order F1' })).toHaveCount(0);
    await expect(right.getByTestId('order-line-handle')).toHaveCount(1);

    // lots 1 -> 3 and price 200 -> 195 in one modify
    await right.getByRole('button', { name: 'Edit order L1' }).click();
    const ed = page.getByRole('dialog', { name: 'Edit order L1' });
    await ed.getByLabel('Order lots').selectOption('3');
    if (process.env.ISX_SHOT) await right.screenshot({ path: process.env.ISX_SHOT });
    await ed.getByLabel('Order price').fill('195');
    await ed.getByRole('button', { name: 'Modify' }).click();
    await expect.poll(patches, { timeout: 15_000 }).toHaveLength(1);
    expect(patches()[0]).toMatchObject({ orderId: 'L1', broker: 'dhan', orderType: 'LIMIT', quantity: 195, price: 195, source: 'isx' });
    await expect(ed).toHaveCount(0);

    // a Buy Limit typed above the live 210.50 is refused (it would fill at once): nothing sent
    await right.getByRole('button', { name: 'Edit order L1' }).click();
    await ed.getByLabel('Order price').fill('215');
    await ed.getByRole('button', { name: 'Modify' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'fills at once' })).toBeVisible();
    expect(patches()).toHaveLength(1);
    await ed.getByRole('button', { name: 'Close' }).click();

    // pressing and dragging an UNSELECTED line only selects it: nothing moves, nothing is sent
    const handle = right.getByTestId('order-line-handle');
    const box = (await handle.boundingBox())!;
    const x = box.x + 40;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + i * 6);
    await page.mouse.up();
    const grip = right.getByTestId('order-line-grip');
    await expect(grip).toBeVisible();
    expect(patches()).toHaveLength(1);
    // Esc deselects (grip gone); a click selects again
    await page.keyboard.press('Escape');
    await expect(grip).toHaveCount(0);
    await page.mouse.click(x, y);
    await expect(grip).toBeVisible();

    if (process.env.ISX_SHOT2) await right.screenshot({ path: process.env.ISX_SHOT2 });
    // drag the grip down: one modify at a lower price on the 0.05 tick, same quantity (65)
    const g = (await grip.boundingBox())!;
    const gx = g.x + g.width / 2;
    const gy = g.y + g.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(gx, gy + i * 6);
    await page.mouse.up();
    await expect.poll(patches, { timeout: 15_000 }).toHaveLength(2);
    const moved = patches()[1] as { price: number; quantity: number; orderId: string };
    expect(moved.orderId).toBe('L1');
    expect(moved.quantity).toBe(65);
    expect(moved.price).toBeLessThan(200);
    expect(Math.abs(Math.round(moved.price / 0.05) * 0.05 - moved.price)).toBeLessThan(1e-6);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('zoom buttons at the bottom of each chart: in keeps the live edge, out widens, reset fits the bars again', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const pane = page.getByTestId('chart-pane-0');
    await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    const zoom = pane.getByTestId('chart-zoom');
    await expect(zoom.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    // each click bumps data-seq once the chart has applied it; read the range after that
    let seq = 0;
    const click = async (name: string) => {
      await zoom.getByRole('button', { name }).click();
      seq++;
      await expect(zoom).toHaveAttribute('data-seq', String(seq));
    };
    const range = async () => ({ from: Number(await zoom.getAttribute('data-from')), to: Number(await zoom.getAttribute('data-to')) });
    await click('Reset zoom');
    const fit = await range();
    const w0 = fit.to - fit.from;
    expect(w0).toBeGreaterThan(20);
    // zoom in: 70 % of the bars, the right edge (the live candle) kept where it was
    await click('Zoom in');
    const zin = await range();
    expect(zin.to).toBeCloseTo(fit.to, 1);
    expect(zin.to - zin.from).toBeCloseTo(w0 * 0.7, 0);
    // zoom out twice: wider than the fitted view
    await click('Zoom out');
    await click('Zoom out');
    const zout = await range();
    expect(zout.to - zout.from).toBeGreaterThan(w0);
    // reset: back to the fitted range
    await click('Reset zoom');
    const again = await range();
    expect(again.to - again.from).toBeCloseTo(w0, 0);
    // two charts: each pane has its own controls
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    await expect(page.getByTestId('chart-zoom')).toHaveCount(2, { timeout: 30_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('background grid: on by default, toggled off from the scale bar, remembered after a reload', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    const grid = page.getByRole('button', { name: 'Grid', exact: true });
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'false');
    if (process.env.ISX_SHOT) await page.getByTestId('chart-pane-0').screenshot({ path: process.env.ISX_SHOT });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'false', { timeout: 60_000 });
    expect(state.blocked).toEqual([]);
  });

  test('trade chimes: on by default, muted from the header, remembered after a reload', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const mute = page.getByRole('button', { name: 'Mute trade chimes', exact: true });
    await expect(mute).toBeVisible({ timeout: 60_000 });
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await mute.click();
    const unmute = page.getByRole('button', { name: 'Unmute trade chimes', exact: true });
    await expect(unmute).toHaveAttribute('aria-pressed', 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Unmute trade chimes', exact: true })).toBeVisible({ timeout: 60_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Volume is an indicator: on by default with MA 20, its settings set the MA, hidden from the legend and remembered', async ({ page, context }) => {
    const state = newState();
    state.optVolume = true;
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const right = page.getByTestId('chart-pane-1');
    await expect(right).toContainText('NIFTY 25350 CE', { timeout: 30_000 });
    await right.getByTestId('indicator-list-toggle').click();
    await expect(right.getByText('Volume (20)', { exact: true })).toBeVisible();
    // the old scale-bar switch is gone
    await expect(page.getByRole('button', { name: 'Volume', exact: true })).toHaveCount(0);
    await page.waitForTimeout(800);
    if (process.env.ISX_SHOT) await right.screenshot({ path: process.env.ISX_SHOT });

    // settings: the MA length (no colour / width rows: fixed green / red bars)
    const row = right.locator('div', { has: page.getByText('Volume (20)', { exact: true }) }).last();
    await row.hover();
    await row.getByRole('button', { name: 'Indicator settings' }).click({ force: true });
    const dlg = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dlg.getByText('MA length (0 = off)')).toBeVisible();
    await expect(dlg.getByRole('group', { name: 'Line width' })).toHaveCount(0);
    const len = dlg.getByRole('textbox').first();
    await len.fill('10');
    await len.blur();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(right.getByText('Volume (10)', { exact: true })).toBeVisible();

    // hide it from the legend: remembered after a reload
    const row10 = right.locator('div', { has: page.getByText('Volume (10)', { exact: true }) }).last();
    await row10.hover();
    await row10.getByRole('button', { name: 'Hide indicator' }).click({ force: true });
    await expect(row10.getByRole('button', { name: 'Show indicator' })).toHaveCount(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const after = page.getByTestId('chart-pane-1');
    // the open list is remembered across the reload too
    await expect(after.getByText('Volume (10)', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(after.locator('div', { has: page.getByText('Volume (10)', { exact: true }) }).last().getByRole('button', { name: 'Show indicator' })).toHaveCount(1);
    // listed in the Indicators menu
    await page.getByRole('button', { name: /Indicators/ }).click();
    await expect(page.getByRole('button', { name: /^Volume/ })).toBeVisible();
    expect(state.blocked).toEqual([]);
  });

  test('NIFTY FUT pane: plots the future with volume, chart only (no "+" order menu), and survives a reload', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const pane = page.getByTestId('chart-pane-0');
    await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await pane.getByRole('button', { name: 'FUT', exact: true }).click();
    await expect(pane).toContainText('NIFTY FUT');
    await expect(pane).toContainText('2026-12-29 · chart only');
    await expect.poll(() => state.candleReqs.some(q => q.includes('kind=future') && q.includes('securityId=58875'))).toBe(true);
    await page.waitForTimeout(800);
    if (process.env.ISX_SHOT) await pane.screenshot({ path: process.env.ISX_SHOT });
    // no "+" order menu on the price axis here
    const box = (await pane.locator('canvas').first().boundingBox())!;
    const paneBox = (await pane.boundingBox())!;
    await page.mouse.move(paneBox.x + paneBox.width - 110, box.y + box.height * 0.4);
    await page.waitForTimeout(400);
    await expect(pane.getByRole('button', { name: /^Order options at / })).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toContainText('NIFTY FUT', { timeout: 60_000 });
    await expect(page.getByTestId('chart-pane-0').getByRole('button', { name: 'FUT', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('header shows the current IST time', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTitle('Current time (IST)')).toHaveText(/^\d{2}:\d{2}:\d{2} IST$/);
    if (process.env.ISX_SHOT) await page.screenshot({ path: process.env.ISX_SHOT, clip: { x: 0, y: 0, width: 1600, height: 80 } });
    expect(state.blocked).toEqual([]);
  });

  test('a new trade keeps a price axis the user scaled by hand; Reset scale returns it to auto-scale', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const pane = page.getByTestId('chart-pane-0');
    await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const overlay = pane.getByTestId('quick-overlay');
    const strikeY = async () => (await overlay.getByRole('button', { name: 'Quick 25350 CE' }).boundingBox())!.y;
    await expect(overlay.getByRole('button', { name: 'Quick 25350 CE' })).toBeVisible({ timeout: 15_000 });
    const before = await strikeY();
    // drag the price axis to scale it by hand (lightweight-charts turns its auto-scale off)
    const box = (await pane.locator('canvas').first().boundingBox())!;
    const ax = box.x + box.width + 30;
    const ay = box.y + box.height / 3;
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(ax, ay + i * 12);
    await page.mouse.up();
    await expect.poll(strikeY).not.toBeCloseTo(before, 0);
    await page.waitForTimeout(500);
    const scaled = await strikeY();
    // a SIM trade adds a position level: the hand-made scale must stay
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick sell 25350 CE 1 lot' }).click();
    await expect(pane.getByTestId('position-chip')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1_000);
    expect(Math.abs((await strikeY()) - scaled)).toBeLessThan(2);
    // the header's Reset scale button puts the axis back on auto-scale
    await page.getByRole('button', { name: 'Reset scale' }).click();
    await expect.poll(async () => Math.abs((await strikeY()) - scaled), { timeout: 5_000 }).toBeGreaterThan(5);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade is off by default: no strike chips, nothing changes', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('switch', { name: 'Quick Trade' })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Quick Trade settings' })).toBeDisabled();
    await page.waitForTimeout(800);
    await expect(page.getByTestId('quick-overlay')).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade SIM: live C / P chips on the strikes in view; Buy fills a paper leg drawn on its strike line', async ({ page, context }) => {
    const state = newState();
    state.noLtpStrike = 25400; // its Call has no live price: that chip cannot trade
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(overlay.getByRole('button', { name: 'Quick 25350 CE' })).toContainText('210.50');
    await expect(overlay.getByRole('button', { name: 'Quick 25350 PE' })).toContainText('229.95');
    await expect(overlay.locator('[data-strike="25350"]')).toContainText('ATM');

    // no trade today: shows the previous close, dimmed and not live, and its Buy / Sell are disabled with the reason
    await expect(overlay.getByRole('button', { name: 'Quick 25400 CE' })).toContainText('88.40');
    await expect(overlay.getByRole('button', { name: 'Quick 25400 CE' }).locator('[data-live]')).toHaveAttribute('data-live', '0');
    await expect(overlay.getByRole('button', { name: 'Quick 25400 CE' })).toHaveAttribute('title', /previous close \(no trade today\), not live/);
    await overlay.getByRole('button', { name: 'Quick 25400 CE' }).click();
    await expect(overlay.getByRole('button', { name: /^Quick buy 25400 CE/ })).toBeDisabled();
    await expect(overlay.getByRole('group', { name: 'Trade 25400 CE' })).toHaveAttribute('data-reason', /No live price for this strike/);
    await expect(overlay.getByRole('button', { name: /^Quick buy 25400 CE/ })).toHaveAttribute('title', /No live price for this strike/);
    await page.keyboard.press('Escape');
    await expect(overlay.getByRole('group', { name: /^Trade / })).toHaveCount(0);

    // C -> Buy: one paper leg of the Buy lots, drawn on the strike line
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    await expect(overlay.getByRole('group', { name: /^Trade / })).toHaveCount(0); // closes after sending
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip.getByRole('button', { name: 'Exit CE 25350' })).toBeVisible();
    await expect(chip.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Long 1 lot (65 units)');
    const rowY = Number(await overlay.locator('[data-strike="25350"]').getAttribute('data-y'));
    const chipBox = (await chip.boundingBox())!, paneBox = (await page.getByTestId('chart-pane-0').locator('canvas').first().boundingBox())!;
    expect(Math.abs(chipBox.y + chipBox.height / 2 - (paneBox.y + rowY))).toBeLessThan(6); // on its strike line
    expect(state.calls).toEqual([]); // SIM: no order route touched
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade strikes around ATM: only ATM ± n rows, default 10', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await expect(page.getByLabel('Strikes around ATM')).toHaveValue('10');
    await page.getByLabel('Strikes around ATM').selectOption('1');
    await page.keyboard.press('Escape');
    await expect(overlay.getByTestId('quick-strike-row')).toHaveCount(3);
    for (const k of ['25300', '25350', '25400']) await expect(overlay.locator(`[data-strike="${k}"]`)).toHaveCount(1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Quick Trade settings' }).click({ timeout: 60_000 });
    await expect(page.getByLabel('Strikes around ATM')).toHaveValue('1'); // kept across reloads
  });

  test('Quick Trade with no live ticks: chips show the snapshot last price (dimmed, not live) and cannot trade', async ({ page, context }) => {
    const state = newState();
    state.noSpot = true; // bridge has no quotes (closed market / bridge down)
    state.snapChain = true; // Dhan's chain snapshot has the last prices
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    const ce = overlay.getByRole('button', { name: 'Quick 25350 CE' });
    await expect(ce).toContainText('195.00', { timeout: 20_000 });
    await expect(overlay.getByRole('button', { name: 'Quick 25350 PE' })).toContainText('54.50');
    await expect(ce.locator('[data-live]')).toHaveAttribute('data-live', '0');
    await expect(ce).toHaveAttribute('title', /not live/);
    await ce.click();
    await expect(overlay.getByRole('button', { name: /^Quick buy 25350 CE/ })).toBeDisabled();
    await expect(overlay.getByRole('button', { name: /^Quick sell 25350 CE/ })).toBeDisabled();
    await expect(overlay.getByRole('button', { name: /^Quick buy 25350 CE/ })).toHaveAttribute('title', /not live/);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade SIM position: premium P&L on the strike chip, premium target validated, set, and hit', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await defaultBracketsOff(page); // this test sets its target by hand on a position that has none
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip).toContainText('+0 INR (+0.00%)', { timeout: 15_000 });

    // P&L follows the option's own premium, not the index: 210.50 -> 220.00 on 65 units = +617.5, +4.51 %
    state.ce25350 = 220;
    await expect(chip).toContainText('+618 INR (+4.51%)', { timeout: 15_000 });

    // a target on the wrong side of the live premium is refused before anything is set
    await chip.getByRole('button', { name: 'Target for CE 25350' }).click();
    const tp = page.getByRole('dialog', { name: 'Target premium for CE 25350' });
    await expect(tp.getByLabel('TP premium')).toHaveValue('264.00'); // 20 % above the live premium
    await tp.getByLabel('TP premium').fill('215');
    await expect(tp).toContainText("A long's target must be above the live premium 220.00");
    await expect(tp.getByRole('button', { name: 'Set' })).toBeDisabled();
    await tp.getByLabel('TP premium').fill('225');
    await expect(tp).toContainText('Books about +943 at 225.00 (SIM)');
    await tp.getByRole('button', { name: 'Set' }).click();
    await expect(chip.getByTestId('premium-tp')).toContainText('TP 225.00');
    await expect(chip.getByTestId('premium-tp')).toContainText('+943');
    // the wider chip never covers its own strike's C / P chips (the row measures it and moves left)
    await expect.poll(async () => {
      const pe = (await overlay.getByRole('button', { name: 'Quick 25350 PE' }).boundingBox())!;
      const cb = (await chip.boundingBox())!;
      return pe.x + pe.width <= cb.x;
    }, { timeout: 5_000 }).toBe(true);

    // the live premium crosses the target: the paper leg closes
    state.ce25350 = 226;
    await expect(page.getByRole('status').filter({ hasText: 'Target hit' })).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByTestId('position-chip')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL position: SL as a premium sends an SL-M on that option (closing tag isxx); its badge cancels the order', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    state.orders = [{ correlationId: 'isxk1', securityId: '302', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 65, orderStatus: 'TRADED' }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toContainText('+683 INR (+5.25%)', { timeout: 15_000 }); // (210.50 - 200) x 65

    await chip.getByRole('button', { name: 'Stop loss for CE 25350' }).click();
    const sl = page.getByRole('dialog', { name: 'Stop loss premium for CE 25350' });
    await sl.getByLabel('SL premium').fill('190');
    await expect(sl).toContainText('Books about -650 at 190.00');
    await sl.getByLabel('SL premium').press('Enter');
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    expect(state.calls.find(c => c.path === '/api/scalper/fast-order')!.body).toMatchObject({
      securityId: '302', side: 'SELL', orderType: 'STOP_LOSS', triggerPrice: 190, price: 180.5, quantity: 65, productType: 'INTRADAY', source: 'isxx',
    });

    // the order book now shows it: the chip's badge reads it, and its x cancels that order
    state.orders = [...state.orders, {
      orderId: 'SL1', correlationId: 'isxsl', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY',
      transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 190, price: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING',
      drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01',
    }];
    await expect(chip.getByTestId('premium-sl')).toContainText('SL 190.00', { timeout: 15_000 });
    await expect(chip.getByTestId('premium-sl')).toContainText('-650');
    // not drawn on the index axis as an order line / chip
    await expect(page.getByTestId('chart-pane-0').getByTestId('order-chip')).toHaveCount(0);
    await chip.getByRole('button', { name: 'Cancel SL CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/orders').map(c => c.body?.orderId)).toEqual(['SL1']);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade SIM TSL on a strike: follows the premium high, survives a reload, closes the paper leg when crossed', async ({ page, context }) => {
    test.setTimeout(120_000);
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip).toContainText('+0 INR (+0.00%)', { timeout: 15_000 });

    // points only: a % is refused; 10 points behind the live 210.50 = 200.50
    await chip.getByRole('button', { name: 'Trailing stop for CE 25350' }).click();
    const dlg = page.getByRole('dialog', { name: 'Trailing stop for CE 25350' });
    await dlg.getByLabel('Trail points').fill('10%');
    await expect(dlg).toContainText('Enter the trail distance in points');
    await dlg.getByLabel('Trail points').fill('10');
    await expect(dlg).toContainText('Stop starts at 200.50');
    await dlg.getByLabel('Trail points').press('Enter');
    const badge = chip.getByTestId('trail-badge');
    await expect(badge).toContainText('TSL 200.50');

    state.ce25350 = 230; // new high -> 220.00
    await expect(badge).toContainText('TSL 220.00', { timeout: 15_000 });
    state.ce25350 = 225; // pullback above the stop: kept, never loosened
    await page.waitForTimeout(3_000);
    await expect(badge).toContainText('TSL 220.00');

    // SIM trails are saved with the paper book
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(pane.getByTestId('trail-badge')).toContainText('TSL 220.00', { timeout: 60_000 });

    state.ce25350 = 219; // through the stop: the paper leg closes
    await expect(pane.getByTestId('position-chip')).toHaveCount(0, { timeout: 15_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL one-cancels-other: the target fills -> this page\'s stop is cancelled; another placer\'s order is left alone', async ({ page, context }) => {
    test.setTimeout(90_000);
    const state = newState();
    const pos = { tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' };
    const o = (orderId: string, correlationId: string, orderType: string, extra: Record<string, unknown>) => ({
      orderId, correlationId, securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'SELL',
      orderType, quantity: 65, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01', ...extra,
    });
    state.positions = [pos];
    state.orders = [
      o('TP1', 'isxtp', 'LIMIT', { price: 230, triggerPrice: 0 }),
      o('SL1', 'isxsl', 'STOP_LOSS_MARKET', { price: 0, triggerPrice: 190 }),
      o('ST9', 'strategy', 'STOP_LOSS_MARKET', { price: 0, triggerPrice: 180 }),
    ];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await expect(page.getByTestId('chart-pane-0').getByTestId('position-chip')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(4_000); // a few polls with the position open: nothing is touched
    expect(state.calls).toEqual([]);

    // the target fills at the broker: the position is gone and TP1 is TRADED
    state.positions = [];
    state.orders = state.orders.map(x => (x.orderId === 'TP1' ? { ...x, orderStatus: 'TRADED', filledQty: 65 } : x));
    const cancels = () => state.calls.filter(c => c.path === '/api/scalper/orders').map(c => c.body?.orderId);
    await expect.poll(cancels, { timeout: 15_000 }).toEqual(['SL1']);
    await expect(page.getByText(/cancelled its other target \/ stop order SL1/)).toBeVisible();
    await page.waitForTimeout(4_000);
    expect(cancels()).toEqual(['SL1']); // once, and never the strategy's ST9
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL one-cancels-other: a part-filled target cuts this page\'s bigger stop down to what is left', async ({ page, context }) => {
    test.setTimeout(90_000);
    const state = newState();
    const pos = { tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: 130, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' };
    state.positions = [pos];
    state.orders = [
      { orderId: 'TP1', correlationId: 'isxtp', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'SELL', orderType: 'LIMIT', price: 230, triggerPrice: 0, quantity: 130, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01' },
      { orderId: 'SL1', correlationId: 'isxsl', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', price: 0, triggerPrice: 190, quantity: 130, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01' },
    ];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await expect(page.getByTestId('chart-pane-0').getByTestId('position-chip').getByTestId('position-lots')).toHaveText('2', { timeout: 15_000 });

    // half the target fills: 65 left; the stop for 130 would flip the position, so it is cut to 65 (1 lot)
    state.positions = [{ ...pos, netQty: 65 }];
    state.orders = state.orders.map(x => (x.orderId === 'TP1' ? { ...x, orderStatus: 'PART_TRADED', filledQty: 65 } : x));
    const patches = () => state.calls.filter(c => c.path === '/api/scalper/orders#PATCH');
    await expect.poll(() => patches().length, { timeout: 15_000 }).toBe(1);
    expect(patches()[0].body).toMatchObject({ orderId: 'SL1', quantity: 65, orderType: 'STOP_LOSS_MARKET', triggerPrice: 190 });
    expect(state.calls.filter(c => c.path === '/api/scalper/orders')).toEqual([]); // nothing cancelled
    expect(state.blocked).toEqual([]);
  });

  test('REAL lots added: this page\'s target and stop grow to the whole position (a 1-lot target on a 4-lot short)', async ({ page, context }) => {
    test.setTimeout(90_000);
    const state = newState();
    const pos = { tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', netQty: -65, buyAvg: 0, costPrice: 200, sellAvg: 200, positionType: 'SHORT' };
    const o = (orderId: string, correlationId: string, orderType: string, extra: Record<string, unknown>) => ({
      orderId, correlationId, securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY', transactionType: 'BUY',
      orderType, quantity: 65, filledQty: 0, orderStatus: 'PENDING', drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01', ...extra,
    });
    state.positions = [pos];
    state.orders = [
      o('TP1', 'isxtp', 'LIMIT', { price: 150, triggerPrice: 0 }),
      o('SL1', 'isxsl', 'STOP_LOSS', { price: 252, triggerPrice: 240 }),
      o('ST9', 'strategy', 'STOP_LOSS', { price: 270, triggerPrice: 260 }),
    ];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    await expect(page.getByTestId('chart-pane-0').getByTestId('position-chip')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(4_000);
    expect(state.calls).toEqual([]);

    // 3 more lots sold (elsewhere, or from the ticket): short 4 lots
    state.positions = [{ ...pos, netQty: -260 }];
    const patches = () => state.calls.filter(c => c.path === '/api/scalper/orders#PATCH');
    await expect.poll(() => patches().length, { timeout: 15_000 }).toBe(2);
    expect(patches().map(c => [c.body?.orderId, c.body?.quantity]).sort()).toEqual([['SL1', 260], ['TP1', 260]]);
    await page.waitForTimeout(4_000);
    expect(patches().length).toBe(2); // once each, and never the strategy's ST9
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('SIM: a paper target does not come back on the next position after an Exit', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await defaultBracketsOff(page); // this test sets its target by hand on a position that has none
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await chip.getByRole('button', { name: 'Target for CE 25350' }).click();
    await page.getByRole('dialog', { name: 'Target premium for CE 25350' }).getByLabel('TP premium').fill('250');
    await page.getByRole('dialog', { name: 'Target premium for CE 25350' }).getByRole('button', { name: 'Set' }).click();
    await expect(chip.getByTestId('premium-tp')).toContainText('TP 250.00');
    await page.getByRole('button', { name: 'Exit CE 25350' }).click();
    await expect(pane.getByTestId('position-chip')).toHaveCount(0, { timeout: 15_000 });
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    await expect(pane.getByTestId('position-chip')).toHaveCount(1, { timeout: 15_000 });
    await expect(pane.getByTestId('premium-tp')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('SIM Reverse: a paper long becomes the same lots short at once (no question), nothing reaches a broker', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip.getByTestId('leg-label')).toHaveText('B CE 25350', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Reverse CE 25350' }).click();
    await expect(chip.getByTestId('leg-label')).toHaveText('S CE 25350', { timeout: 15_000 });
    await expect(chip.getByTestId('position-lots')).toHaveText('1');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL TSL on a strike: one market close when the premium crosses the stop, x removes a trail', async ({ page, context }) => {
    test.setTimeout(90_000);
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toContainText('+683 INR', { timeout: 15_000 });
    const orders = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');

    // set, then x: removed, nothing sent
    await chip.getByRole('button', { name: 'Trailing stop for CE 25350' }).click();
    await page.getByRole('dialog', { name: 'Trailing stop for CE 25350' }).getByLabel('Trail points').fill('20');
    await page.getByRole('dialog', { name: 'Trailing stop for CE 25350' }).getByRole('button', { name: 'Set' }).click();
    await expect(chip.getByTestId('trail-badge')).toContainText('TSL 190.50');
    await chip.getByRole('button', { name: 'Cancel TSL CE 25350' }).click();
    await expect(chip.getByTestId('trail-badge')).toHaveCount(0);

    await chip.getByRole('button', { name: 'Trailing stop for CE 25350' }).click();
    await page.getByRole('dialog', { name: 'Trailing stop for CE 25350' }).getByLabel('Trail points').fill('5');
    await page.getByRole('dialog', { name: 'Trailing stop for CE 25350' }).getByRole('button', { name: 'Set' }).click();
    await expect(chip.getByTestId('trail-badge')).toContainText('TSL 205.50');
    state.ce25350 = 205; // through the stop
    await expect.poll(() => orders().length, { timeout: 15_000 }).toBe(1);
    expect(orders()[0].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'MARKET', quantity: 65, productType: 'INTRADAY', source: 'isxx' });
    await page.waitForTimeout(5_000);
    expect(orders().length).toBe(1); // the broker still shows the row (mock): never a second exit
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL position: TP / SL typed as a % of entry ("10%") send the premium that percentage gives', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip).toContainText('+683 INR', { timeout: 15_000 }); // live premium 210.50, entry 200
    const orders = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');

    // SL 10% below the 200 entry = 180.00
    await chip.getByRole('button', { name: 'Stop loss for CE 25350' }).click();
    const sl = page.getByRole('dialog', { name: 'Stop loss premium for CE 25350' });
    await sl.getByLabel('SL premium').fill('10%');
    await expect(sl).toContainText('10% of entry → Books about -1,300 at 180.00');
    await sl.getByLabel('SL premium').press('Enter');
    await expect.poll(() => orders().length, { timeout: 15_000 }).toBe(1);
    expect(orders()[0].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'STOP_LOSS', triggerPrice: 180, price: 171, quantity: 65 });

    // TP 2% above entry = 204.00 is below the live 210.50: refused, nothing sent; 15% = 230.00 goes as a LIMIT
    await chip.getByRole('button', { name: 'Target for CE 25350' }).click();
    const tp = page.getByRole('dialog', { name: 'Target premium for CE 25350' });
    await tp.getByLabel('TP premium').fill('2%');
    await expect(tp).toContainText("A long's target must be above the live premium");
    await expect(tp.getByRole('button', { name: 'Set' })).toBeDisabled();
    await tp.getByLabel('TP premium').fill('15%');
    await tp.getByRole('button', { name: 'Set' }).click();
    await expect.poll(() => orders().length, { timeout: 15_000 }).toBe(2);
    expect(orders()[1].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'LIMIT', price: 230, quantity: 65 });
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL: a stop placed elsewhere shows as the leg\'s SL, and its x asks before cancelling it', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    state.orders = [{
      orderId: 'STG1', correlationId: 'stg01', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY',
      transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 185, price: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING',
      drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01', exchangeSegment: 'NSE_FNO',
    }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    // the strategy's stop shows as the leg's SL
    await expect(chip.getByTestId('premium-sl')).toContainText('SL 185.00', { timeout: 15_000 });
    await chip.getByRole('button', { name: 'Cancel SL CE 25350' }).click();
    // its x asks first (not this page's order); keep it
    const ask = page.getByRole('alertdialog', { name: 'Cancel an order placed elsewhere' });
    await expect(ask).toContainText('order STG1');
    await ask.getByRole('button', { name: 'Keep it' }).click();
    expect(state.calls.filter(c => c.path === '/api/scalper/orders')).toEqual([]);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL "-": sized off the fresh broker row, so a position reduced elsewhere still keeps one lot', async ({ page, context }) => {
    const state = newState();
    const row = { tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG' };
    state.positions = [{ ...row, netQty: 195 }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await page.getByRole('combobox', { name: 'Lots per plus or minus' }).selectOption('2');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('3', { timeout: 15_000 });
    // the mobile app sold one lot: the broker now holds 2; the chip may still say 3
    state.positions = [{ ...row, netQty: 130 }];
    await chip.getByRole('button', { name: 'Fewer lots CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    // step 2 on a fresh 2-lot row takes 1 lot (one stays), never the whole 130
    expect(state.calls.find(c => c.path === '/api/scalper/fast-order')!.body).toMatchObject({ securityId: '302', side: 'SELL', quantity: 65 });
    await expect(page.getByRole('status').filter({ hasText: 'taken off' })).toContainText('1 lot taken off');
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL: a set SL is edited from its badge (prefilled), replacing this page\'s order; same level sends nothing', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    state.orders = [{
      orderId: 'SL1', correlationId: 'isxsl', securityId: '302', tradingSymbol: 'NIFTY-Dec2026-25350-CE', productType: 'INTRADAY',
      transactionType: 'SELL', orderType: 'STOP_LOSS_MARKET', triggerPrice: 190, price: 0, quantity: 65, filledQty: 0, orderStatus: 'PENDING',
      drvOptionType: 'CALL', drvStrikePrice: 25350, drvExpiryDate: '2026-12-01', exchangeSegment: 'NSE_FNO',
    }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('premium-sl')).toContainText('SL 190.00', { timeout: 15_000 });
    const sends = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');
    const cancels = () => state.calls.filter(c => c.path === '/api/scalper/orders').map(c => c.body?.orderId);

    // open from the badge: prefilled with the current level; Set on the same level sends nothing
    await chip.getByRole('button', { name: 'Edit SL CE 25350' }).click();
    const sl = page.getByRole('dialog', { name: 'Stop loss premium for CE 25350' });
    await expect(sl.getByLabel('SL premium')).toHaveValue('190.00');
    await sl.getByLabel('SL premium').press('Enter');
    await expect(sl).toHaveCount(0);
    expect(sends()).toEqual([]);
    expect(cancels()).toEqual([]);

    // edit to 10% of entry (180.00): this page's SL1 is cancelled and a new SL-M at 180 placed
    await chip.getByRole('button', { name: 'Edit SL CE 25350' }).click();
    await sl.getByLabel('SL premium').fill('10%');
    await sl.getByLabel('SL premium').press('Enter');
    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(1);
    expect(cancels()).toEqual(['SL1']);
    expect(sends()[0].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'STOP_LOSS', triggerPrice: 180, price: 171, quantity: 65 });
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade straddle: CE and PE sold on one strike are independent legs, each labelled, with its own +/- lots', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    for (const t of ['CE', 'PE']) {
      await overlay.getByRole('button', { name: `Quick 25350 ${t}` }).click();
      // the second leg's B / S stays clickable once the strike already holds the first leg's chip
      await overlay.getByRole('button', { name: `Quick sell 25350 ${t} 1 lot` }).click({ timeout: 5_000 });
    }
    const chips = pane.getByTestId('position-chip');
    await expect(chips).toHaveCount(2, { timeout: 15_000 });
    await expect(chips.getByTestId('leg-label')).toHaveText(['S CE 25350', 'S PE 25350']);
    await expect(pane.getByTestId('strike-total')).toHaveCount(0); // nothing combined: each leg stands alone
    const ce = chips.filter({ has: page.getByRole('button', { name: 'Exit CE 25350' }) });
    const pe = chips.filter({ has: page.getByRole('button', { name: 'Exit PE 25350' }) });

    // "-" is off at one lot (Exit closes the last one); "+" adds a lot in the leg's own direction (another sell)
    await expect(ce.getByRole('button', { name: 'Fewer lots CE 25350' })).toBeDisabled();
    await ce.getByRole('button', { name: 'More lots CE 25350' }).click();
    await expect(ce.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Short 2 lots (130 units)', { timeout: 15_000 });
    await expect(ce.getByTestId('position-lots')).toHaveText('2');
    await expect(pe.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Short 1 lot (65 units)'); // the PE is untouched
    // "-" takes one lot off again
    await ce.getByRole('button', { name: 'Fewer lots CE 25350' }).click();
    await expect(ce.getByTestId('position-lots')).toHaveAttribute('aria-label', 'Short 1 lot (65 units)', { timeout: 15_000 });
    await expect(chips).toHaveCount(2);
    // the two chips never overlap
    const boxes = await chips.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom]; }).sort((a, b) => a[0] - b[0]));
    expect(boxes[1][0]).toBeGreaterThanOrEqual(boxes[0][1]);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL +/-: + sends one more lot in the leg\'s direction, - closes one lot', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 130, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    state.orders = [{ correlationId: 'isxk1', securityId: '302', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 130, orderStatus: 'TRADED' }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('2', { timeout: 15_000 });

    await chip.getByRole('button', { name: 'More lots CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')[0].body).toMatchObject({
      securityId: '302', side: 'BUY', orderType: 'MARKET', quantity: 65, productType: 'INTRADAY', source: 'isx',
    });

    await chip.getByRole('button', { name: 'Fewer lots CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(2);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')[1].body).toMatchObject({
      securityId: '302', side: 'SELL', orderType: 'MARKET', quantity: 65, source: 'isxx',
    });
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL +/- step: "Lots per + / -" = 3 sends 3 lots on +, and - never takes the last lot', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 130, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await page.getByRole('combobox', { name: 'Lots per plus or minus' }).selectOption('3');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const chip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    await expect(chip.getByTestId('position-lots')).toHaveText('2', { timeout: 15_000 });

    await chip.getByRole('button', { name: 'More lots CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')[0].body).toMatchObject({ securityId: '302', side: 'BUY', quantity: 195 });

    // the broker still shows 2 lots: "-" with a step of 3 takes off 1 (one lot always stays)
    await chip.getByRole('button', { name: 'Fewer lots CE 25350' }).click();
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(2);
    expect(state.calls.filter(c => c.path === '/api/scalper/fast-order')[1].body).toMatchObject({ securityId: '302', side: 'SELL', quantity: 65 });
    expect(state.blocked).toEqual([]);
  });

  test('Quick Trade REAL: settings Sell 2 lots, P -> Sell sends ONE tagged market order for that strike; settings persist', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await page.getByLabel('Sell lots per click').selectOption('2');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();

    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25300 PE' }).click();
    await expect(overlay.getByRole('button', { name: 'Quick sell 25300 PE 2 lots' })).toHaveAttribute('title', 'Sell 2 lots 25300 PE at market (REAL)');
    await overlay.getByRole('button', { name: 'Quick sell 25300 PE 2 lots' }).dblclick(); // a double click is ONE order
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(600);
    const orders = state.calls.filter(c => c.path === '/api/scalper/fast-order');
    expect(orders.length).toBe(1);
    expect(orders[0].body).toMatchObject({
      securityId: '401', side: 'SELL', orderType: 'MARKET', quantity: 130, productType: 'INTRADAY', source: 'isx', exchangeSegment: 'NSE_FNO',
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('switch', { name: 'Quick Trade' })).toBeChecked({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await expect(page.getByLabel('Sell lots per click')).toHaveValue('2');
    await expect(page.getByLabel('Buy lots per click')).toHaveValue('1');
    expect(state.blocked).toEqual([]);
  });

  test('price-axis "+" stays put under the pointer (no flicker) and opens the order menu', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    const pane = page.getByTestId('chart-pane-0');
    await expect(pane.locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(800);
    // hover the chart just left of the price axis: the "+" appears there
    const box = (await pane.locator('canvas').first().boundingBox())!;
    const paneBox = (await pane.boundingBox())!;
    await page.mouse.move(paneBox.x + paneBox.width - 110, box.y + box.height * 0.4);
    const plus = pane.getByRole('button', { name: /^Order options at / });
    await expect(plus).toBeVisible();
    // move ONTO it, the way a user does, and let it sit: it must stay (it used to vanish and reappear on every move)
    const pb = (await plus.boundingBox())!;
    const cx = pb.x + pb.width / 2, cy = pb.y + pb.height / 2;
    await page.mouse.move(cx - 6, cy, { steps: 4 });
    await page.mouse.move(cx, cy, { steps: 4 });
    let seen = 0;
    for (let i = 0; i < 10; i++) { seen += await plus.count(); await page.waitForTimeout(50); }
    expect(seen).toBe(10);
    await page.mouse.down();
    await page.mouse.up();
    await expect(pane.getByTestId('chart-scale-menu')).toBeVisible();
    // leaving the "+" for somewhere outside the chart hides it (the menu stays until closed)
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await expect(plus).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });

  test('2-chart layout: right pane plots the ATM CE premium, picks a PE and its own timeframe, survives a reload', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('chart-pane-1')).toHaveCount(0);

    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const right = page.getByTestId('chart-pane-1');
    await expect(right).toBeVisible();
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350', { timeout: 30_000 });
    await expect(right).toContainText('NIFTY 25350 CE');
    await expect.poll(() => state.candleReqs.some(q => q.includes('kind=option') && q.includes('securityId=302'))).toBe(true);
    await expect(right.locator('canvas').first()).toBeVisible();

    // choosing an instrument shows it auto-scaled, even after auto-scale was turned off
    await page.getByRole('button', { name: 'auto', exact: true }).click();
    await expect(page.getByRole('button', { name: 'auto', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await right.getByRole('button', { name: 'PE', exact: true }).click();
    await expect(page.getByRole('button', { name: 'auto', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await right.getByLabel('Chart 2 strike').selectOption('25400');
    await expect(right).toContainText('NIFTY 25400 PE');
    await expect.poll(() => state.candleReqs.some(q => q.includes('securityId=403'))).toBe(true);
    await right.getByRole('button', { name: '1m', exact: true }).click();
    await expect.poll(() => state.candleReqs.some(q => q.includes('securityId=403') && q.includes('interval=1'))).toBe(true);
    // the left pane keeps its own instrument and timeframe
    await expect(page.getByTestId('chart-pane-0')).toContainText('NIFTY IDX');
    await expect(page.getByTestId('chart-pane-0').getByRole('button', { name: '5m', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-1')).toContainText('NIFTY 25400 PE', { timeout: 60_000 });
    await expect(page.getByTestId('chart-pane-1').getByRole('button', { name: '1m', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('SIM option leg: TP / SL only on its premium chart; a dragged SL is a premium level on the 0.05 tick', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const right = page.getByTestId('chart-pane-1');
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Option chain' }).click();
    await expect(page.getByRole('button', { name: 'Trade 25350 CE' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Trade 25350 CE' }).click();
    await page.getByTestId('order-ticket').getByRole('button', { name: /^Buy / }).click();
    await page.getByRole('button', { name: 'Close option chain' }).click().catch(() => {});

    const leftChip = page.getByTestId('chart-pane-0').getByTestId('position-chip');
    const rightChip = right.getByTestId('position-chip');
    await expect(rightChip).toBeVisible({ timeout: 15_000 });
    await expect(leftChip).toBeVisible();
    // index chart: no TP / SL handles for an option leg
    await expect(leftChip.getByRole('button', { name: 'TP', exact: true })).toHaveCount(0);
    // the option's own chart: the same chip as the index chart's strike chip (label, typed TP / SL, - / + lots)
    await expect(rightChip.getByTestId('leg-label')).toHaveText('B CE 25350');
    await expect(rightChip.getByRole('button', { name: 'More lots CE 25350' })).toBeVisible();
    await expect(rightChip.getByRole('button', { name: 'Fewer lots CE 25350' })).toBeDisabled(); // one lot: Exit closes it
    await expect(rightChip.getByRole('button', { name: 'Stop loss for CE 25350' })).toBeVisible();

    await dragFrom(page, rightChip.getByRole('button', { name: 'Stop loss for CE 25350' }), 60);
    const toast = page.getByRole('status').filter({ hasText: 'SIM SL set at' });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    const px = Number((await toast.textContent())!.replace(/[^0-9.]/g, ''));
    expect(px).toBeGreaterThan(100); // a premium, not an index level
    expect(px).toBeLessThan(210.5);
    expect(Math.abs(Math.round(px / 0.05) * 0.05 - px)).toBeLessThan(1e-6);
    await expect(right.getByTestId('sl-chip')).toBeVisible();
    await expect(page.getByTestId('chart-pane-0').getByTestId('sl-chip')).toHaveCount(0);
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL option leg: dragging SL on its premium chart sends a stop-limit on that option, tagged isxx (a close)', async ({ page, context }) => {
    const state = newState();
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 200, costPrice: 200, sellAvg: 0, positionType: 'LONG',
    }];
    state.orders = [{ correlationId: 'isxk1', securityId: '302', productType: 'INTRADAY', transactionType: 'BUY', filledQty: 65, orderStatus: 'TRADED' }];
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Two charts side by side' }).click();
    const right = page.getByTestId('chart-pane-1');
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350', { timeout: 30_000 });
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();

    const chip = right.getByTestId('position-chip');
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await dragFrom(page, chip.getByRole('button', { name: 'Stop loss for CE 25350' }), 60);
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    const sent = state.calls.find(c => c.path === '/api/scalper/fast-order')!.body!;
    // an option stop is a stop-LIMIT a 5% cushion below the trigger (brokers refuse SL-M on options)
    expect(sent).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'STOP_LOSS', quantity: 65, source: 'isxx', exchangeSegment: 'NSE_FNO' });
    const trig = Number(sent.triggerPrice ?? sent.trigger);
    expect(trig).toBeGreaterThan(100);
    expect(trig).toBeLessThan(200);
    const px = Number(sent.price);
    expect(px).toBeLessThan(trig);
    expect(Math.abs(px - Math.floor(trig * 0.95 / 0.05 + 1e-9) * 0.05)).toBeLessThan(1e-6);
    expect(state.blocked).toEqual([]);
  });

  test('Top indices / Top 10 stocks: header buttons open live watch windows over the stream, start the bridges, place nothing', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Top indices', exact: true }).click();
    const idx = page.getByTestId('market-watch-indices');
    await expect(idx).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('market-watch-indices-state')).toHaveText('LIVE');
    await expect(idx.getByRole('row', { name: /Nifty 50/ })).toContainText('25,500.00');
    await expect(idx.getByRole('row', { name: /Nifty 50/ })).toContainText('+2.00%');
    await expect(idx.getByRole('row', { name: /Bank Nifty/ })).toContainText('-1.00%');
    await expect(idx.getByRole('row', { name: /India VIX/ })).not.toContainText('%'); // unknown move, not 0.00%
    // sorted by change, highest first; unpriced rows last
    await expect(idx.locator('tbody tr').first()).toContainText('Nifty 50');

    await page.getByRole('button', { name: 'Top 10 stocks', exact: true }).click();
    const stk = page.getByTestId('market-watch-stocks');
    await expect(stk.locator('tbody tr')).toHaveCount(10);
    await expect(stk.getByRole('row', { name: /HDFC Bank/ })).toContainText('+1.00%');
    // weighted pull: 11.18 x 1% + 8.00 x -1% = +0.03%
    await expect(stk).toContainText('Weighted pull on NIFTY (2/10 priced)');
    await expect(stk).toContainText('+0.03%');

    expect([...new Set(state.bridgeStarts)].sort()).toEqual(['/api/live-equity', '/api/live-indices']);
    expect(state.calls).toEqual([]); // watch-only: no order route touched
    await stk.getByRole('button', { name: 'Close Top 10 Stocks' }).click();
    await expect(stk).toHaveCount(0);
    await page.getByRole('button', { name: 'Top indices', exact: true }).click();
    await expect(idx).toHaveCount(0);
    expect(state.blocked).toEqual([]);
  });
  test('default TP / SL (on, 30 % / 20 %): a SIM buy at market gets its paper target and stop from the entry premium', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('default-brackets-chip')).toHaveText('TP 30% · SL 20%');
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    // entry 210.50: target 210.50 x 1.3 = 273.65, stop 210.50 x 0.8 = 168.40
    await expect(chip.getByTestId('premium-tp')).toContainText('TP 273.65', { timeout: 15_000 });
    await expect(chip.getByTestId('premium-sl')).toContainText('SL 168.40');
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('default TP / SL in REAL: once the market buy shows in the book, a Limit target and an SL-M stop are sent once', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const sends = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');
    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(1);
    expect(sends()[0].body).toMatchObject({ securityId: '302', side: 'BUY', orderType: 'MARKET', quantity: 65 });
    // the fill shows in the broker book at 210.50
    state.positions = [{
      tradingSymbol: 'NIFTY-Dec2026-25350-CE', securityId: '302', exchangeSegment: 'NSE_FNO', productType: 'INTRADAY',
      netQty: 65, buyAvg: 210.5, costPrice: 210.5, sellAvg: 0, positionType: 'LONG',
    }];
    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(3);
    expect(sends()[1].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'LIMIT', price: 273.65, quantity: 65 });
    expect(sends()[2].body).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'STOP_LOSS', triggerPrice: 168.4, price: 159.95, quantity: 65 });
    // at most once: the order book still shows neither order, yet nothing more is sent
    await page.waitForTimeout(4000);
    expect(sends()).toHaveLength(3);
    expect(state.blocked).toEqual([]);
  });

  test('default TP / SL switched off in the settings: a buy gets no levels, and it stays off after a reload', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Default target and stop settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Default target and stop panel' });
    await expect(panel.getByLabel('Default target percent')).toHaveValue('30');
    await expect(panel.getByLabel('Default stop percent')).toHaveValue('20');
    await panel.getByRole('switch', { name: 'Default target and stop' }).click();
    await expect(page.getByTestId('default-brackets-chip')).toHaveText('TP/SL off');
    await page.keyboard.press('Escape');
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(2500);
    await expect(chip.getByTestId('premium-tp')).toHaveCount(0);
    await expect(chip.getByTestId('premium-sl')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('default-brackets-chip')).toHaveText('TP/SL off', { timeout: 60_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });
  test('default TP / SL after a SIM flip: the short gets its own levels; the old long target neither blocks them nor closes it', async ({ page, context }) => {
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    const pane = page.getByTestId('chart-pane-0');
    const overlay = pane.getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const chip = pane.getByTestId('position-chip');
    await expect(chip.getByTestId('premium-tp')).toContainText('TP 273.65', { timeout: 15_000 });
    // sell 2 lots at market: long 1 -> short 1 (Sell lots per click = 2)
    await page.getByRole('button', { name: 'Quick Trade settings' }).click();
    await page.getByLabel('Sell lots per click').selectOption('2');
    await page.keyboard.press('Escape');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick sell 25350 CE 2 lots' }).click();
    await expect(chip.getByTestId('leg-label')).toHaveText('S CE 25350', { timeout: 15_000 });
    // a short from 210.50: target 30 % below (147.35), stop 20 % above (252.60)
    await expect(chip.getByTestId('premium-tp')).toContainText('TP 147.35', { timeout: 15_000 });
    await expect(chip.getByTestId('premium-sl')).toContainText('SL 252.60');
    await page.waitForTimeout(2000);
    await expect(chip).toHaveCount(1); // still open: the old long target 273.65 did not "hit" the short
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('default TP / SL in REAL: a fill that never shows in the book is reported after 30 s, nothing sent', async ({ page, context }) => {
    test.setTimeout(150_000);
    const state = newState();
    await signIn(context);
    await mockApi(page, state);
    await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-0').locator('canvas').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('switch', { name: 'Quick Trade' }).click();
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const overlay = page.getByTestId('chart-pane-0').getByTestId('quick-overlay');
    await overlay.getByRole('button', { name: 'Quick 25350 CE' }).click();
    await overlay.getByRole('button', { name: 'Quick buy 25350 CE 1 lot' }).click();
    const sends = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');
    await expect.poll(() => sends().length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: 'No default target / stop' }))
      .toContainText('the position did not show within 30 s', { timeout: 70_000 });
    expect(sends()).toHaveLength(1);
    expect(state.blocked).toEqual([]);
  });
});
