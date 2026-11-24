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

interface State { calls: Call[]; blocked: Call[]; candleReqs: string[]; positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; noSpot?: boolean; noPrevOi?: boolean }

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
      return json(route, { success: true, candles: opt ? bars(210, 20) : bars(SPOT, 40), interval: u.searchParams.get('interval') });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(ALL_STRIKES.map(k => { const [ce, pe] = idsOf(k); return [String(k), { ceId: ce, peId: pe }]; }));
      return json(route, { success: true, data: { lotSize: 65, strikes } });
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
          ce: { ltp: IDS[String(k)] ? 210.5 : 100, change_pct: -3, buildup: 'SB', ...side(ceOi, k >= SPOT) },
          pe: { ltp: IDS[String(k)] ? 229.95 : 100, change_pct: 5, buildup: 'LB', ...side(peOi, k < SPOT) },
        }];
      }));
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-12-01', spot: SPOT, atm: SPOT, updated_at: sessionIso(), strikes } });
    }
    if (p === '/api/options/chain') return json(route, { success: false, error: 'e2e: no chain' }, 502);
    if (p === '/api/options/margin') return json(route, { success: true, data: { total_margin: 100000 } });
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: state.orders });
    if (p === '/api/scalper/orders' && method === 'DELETE') { state.calls.push({ path: p, body }); return json(route, { success: true }); }
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 0.05 });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order') { state.calls.push({ path: p, body }); return json(route, { success: true, order_id: '7001' }); }
    if (method === 'POST' && (p === '/api/live-indices' || p === '/api/live-equity')) return json(route, { success: true });
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

const newState = (): State => ({ calls: [], blocked: [], candleReqs: [], positions: [], orders: [] });

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
    await expect(rightChip.getByRole('button', { name: 'SL', exact: true })).toBeVisible();

    await dragFrom(page, rightChip.getByRole('button', { name: 'SL', exact: true }), 60);
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

  test('REAL option leg: dragging SL on its premium chart sends an SL-M on that option, tagged isx', async ({ page, context }) => {
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
    await dragFrom(page, chip.getByRole('button', { name: 'SL', exact: true }), 60);
    await expect.poll(() => state.calls.filter(c => c.path === '/api/scalper/fast-order').length, { timeout: 15_000 }).toBe(1);
    const sent = state.calls.find(c => c.path === '/api/scalper/fast-order')!.body!;
    expect(sent).toMatchObject({ securityId: '302', side: 'SELL', orderType: 'STOP_LOSS_MARKET', quantity: 65, source: 'isx', exchangeSegment: 'NSE_FNO' });
    const trig = Number(sent.triggerPrice ?? sent.trigger);
    expect(trig).toBeGreaterThan(100);
    expect(trig).toBeLessThan(200);
    expect(state.blocked).toEqual([]);
  });
});
