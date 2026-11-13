import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Fresh Money target / stop-loss, browser side only. Every /api/fresh-money* call and the collector status are answered
// in the browser; any other non-GET /api request is refused (599) and fails the test, so nothing can reach an order route.

const KEY = 'dhan|111';
const istNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
const istToday = () => istNow().slice(0, 10);

// Slot cells: 10 completed slots oldest first, then the running slot; the oldest edge had no reading (null).
const PUT_FLOW = { cells: [null, 2, 3, 4, 6, 8, 120, 0, -40, 1500, 77], total: 1657 };
const CALL_FLOW = { cells: [11, 12, 13, 14, 15, 10, 20, 30, -900, -12000, 5], total: -12835 };
const side = (oi: number, chg: number, flow: unknown) => ({ oi, oiMoved: chg, buildup: null, flow });
function board() {
  const rows = [8300, 8200, 8100, 8000, 7900].map(strike => ({ strike, put: side(4000, 300, PUT_FLOW), call: side(3000, -200, CALL_FLOW) }));
  return {
    underlying: 'CRUDEOIL', date: istToday(), isToday: true, lastTs: istNow(), spot: 8105, expiry: '2026-11-17', step: 100,
    lot: 1, oiUnit: 'lots', market: 'MCX', mult: 100, day: { from: 540, to: 1435 }, rows,
    hasBuildup: false,
    flowSlots: { slotMin: 3, bounds: ['10:00', '10:03', '10:06', '10:09', '10:12', '10:15', '10:18', '10:21', '10:24', '10:27', '10:30'],
      boundOk: [false, true, true, true, true, true, true, true, true, true, true], lastTs: '10:31:20' },
  };
}

const position = {
  key: KEY, broker: 'dhan', securityId: '111', priceId: '111', segment: 'MCX_COMM', mult: 100, underlying: 'CRUDEOIL',
  expiry: '2026-11-17', strike: 8100, opt: 'CE', lot: 1, netQty: 1, avgPrice: 100, realised: 0, ltp: 110,
  unrealised: 1000, pnl: 1000, busy: null,
};
const exitRecord = {
  key: KEY, openedAt: Date.now(), dir: 'long', target: { value: 30, unit: 'pct' }, sl: { value: 20, unit: 'pct' },
  basis: 100, targetPx: 130, slPx: 80, state: 'watching',
};

async function install(page: Page, opts: { watcherAlive?: boolean; withPosition?: boolean } = {}) {
  const posts: Record<string, unknown>[] = [];
  const blocked: string[] = [];
  const state = () => ({
    date: istToday(), tradable: ['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM'], maxLots: 20, maxPositionLots: 60,
    sessions: Object.fromEntries(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM'].map(u => [u, { gate: 'open', note: null }])),
    boardExpiry: { NIFTY: null, BANKNIFTY: null, CRUDEOIL: '2026-11-17', CRUDEOILM: null },
    ltpSource: { '111': 'ws' }, brokers: { dhan: true, kotak: true, zerodha: true },
    positions: opts.withPosition ? [position] : [], orders: [],
    exits: opts.withPosition ? { [KEY]: exitRecord } : {},
    exitWatcher: { alive: opts.watcherAlive ?? true, at: Date.now() },
  });
  await page.addInitScript(() => {
    localStorage.setItem('freshMoney.underlying', 'CRUDEOIL');
    localStorage.setItem('freshMoney.broker', 'dhan');
  });
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === '/api/fresh-money') return json(route, board());
    if (p === '/api/fresh-money/live') {
      return json(route, { underlying: 'CRUDEOIL', label: 'CRUDEOIL NOV FUT', spot: 8105, prevClose: 8050, change: 55, changePct: 0.68, changedMs: Date.now(), instrument: 'MCX_COMM:1' });
    }
    if (p === '/api/fresh-money/trade') {
      if (req.method() === 'GET') return json(route, state());
      const body = req.postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (body.action === 'order') return json(route, { success: true, order_id: 'X1', note: 'T 30% · SL 20 pts' });
      if (body.action === 'setExit') return json(route, { success: true });
      return json(route, { success: false, error: 'not mocked' }, 400);
    }
    if (p === '/api/options/iv-history') {
      const now = Date.now();
      const data = Array.from({ length: 12 }, (_, i) => ({
        time: '', ts: now - (11 - i) * 300_000, spot: 8100 + i, ceOI: 1_000_000 + i * 20_000, peOI: 900_000 + i * 35_000,
        diff: -100_000 + i * 15_000, oiZ: 0, slopeZ: 0, wpiZ: 0, regimeLabel: 'Neutral', regimeConfirmed: false,
      }));
      return json(route, { success: true, date: istToday(), atm: 8100, expiry: '2026-11-17', wings: 10, maxWings: 10, pcr: { value: 1.23, centre: 8100, wings: 10, clipped: false }, data });
    }
    if (p === '/api/crudeoil-oi-collector') return json(route, { success: true, status: { status: 'RUNNING', last_update: istNow() } });
    if (req.method() !== 'GET') { blocked.push(`${req.method()} ${p}`); return route.fulfill({ status: 599, body: 'blocked by test' }); }
    return route.continue();
  });
  await page.goto('/options/fresh-money');
  await expect(page.getByRole('heading', { name: 'Fresh Money Board' })).toBeVisible();
  await expect(page.getByText('8100').first()).toBeVisible();
  return { posts, blocked };
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('header target commits on blur, Escape reverts, and the order carries the defaults', async ({ page }) => {
  const m = await install(page);
  const target = page.getByLabel('Target value (blank = off)').first();
  await target.fill('30');
  await target.press('Tab');
  await expect(target).toHaveValue('30');
  await target.fill('3');
  await target.press('Escape');
  await expect(target).toHaveValue('30');
  const sl = page.getByLabel('SL value (blank = off)').first();
  await sl.fill('20');
  await page.getByRole('group', { name: 'SL unit' }).first().getByRole('button', { name: 'pts' }).click();

  await page.getByRole('button', { name: /Arm live trading/ }).click();
  await page.getByRole('button', { name: 'Buy 8100 CE' }).click();
  await expect(page.getByText('T 30% · SL 20 pts', { exact: false })).toBeVisible();
  const order = m.posts.find(b => b.action === 'order')!;
  expect(order.exitDefaults).toEqual({ target: { value: 30, unit: 'pct' }, sl: { value: 20, unit: 'pts' } });
  expect(m.blocked).toEqual([]);
});

test('an invalid header value is refused and keeps the last good value', async ({ page }) => {
  await install(page);
  const target = page.getByLabel('Target value (blank = off)').first();
  await target.fill('30');
  await target.press('Tab');
  await target.fill('5000');
  await target.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: 'At most 1000%' })).toBeVisible();
  await expect(target).toHaveValue('30');
});

test('the defaults survive a reload', async ({ page }) => {
  await install(page);
  const target = page.getByLabel('Target value (blank = off)').first();
  await target.fill('25');
  await target.press('Enter');
  await page.reload();
  await expect(page.getByLabel('Target value (blank = off)').first()).toHaveValue('25');
});

test('Positions editor saves a per-position stop-loss in points', async ({ page }) => {
  const m = await install(page, { withPosition: true });
  await expect(page.getByText('130.00 / 80.00')).toBeVisible();
  await page.getByRole('button', { name: /Arm live trading/ }).click();
  await page.getByRole('button', { name: 'Edit target and stop-loss of CRUDEOIL 8100 CE on Dhan' }).click();
  const sl = page.getByLabel('SL value (blank = off)').last();
  await sl.fill('15');
  await sl.press('Tab');
  await page.getByRole('group', { name: 'SL unit' }).last().getByRole('button', { name: 'pts' }).click();
  await expect(page.getByText('target 130.00 · SL 85.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => m.posts.find(b => b.action === 'setExit')).toEqual({
    action: 'setExit', key: KEY, target: { value: 30, unit: 'pct' }, sl: { value: 15, unit: 'pts' },
  });
  expect(m.blocked).toEqual([]);
});

test('a level the price has already passed is flagged before Save', async ({ page }) => {
  await install(page, { withPosition: true });
  await page.getByRole('button', { name: /Arm live trading/ }).click();
  await page.getByRole('button', { name: 'Edit target and stop-loss of CRUDEOIL 8100 CE on Dhan' }).click();
  const target = page.getByLabel('Target value (blank = off)').last();
  await target.fill('5');          // target 105 < LTP 110
  await target.press('Tab');
  await expect(page.getByText('Target already past — exits within ~4 s')).toBeVisible();
});

test('watcher chip: running vs STOPPED', async ({ page }) => {
  await install(page, { withPosition: true, watcherAlive: false });
  await expect(page.getByText('Exits watcher STOPPED — levels are not being watched')).toBeVisible();
});

test('watcher chip: watching', async ({ page }) => {
  await install(page, { withPosition: true, watcherAlive: true });
  await expect(page.getByText('Exits: watching')).toBeVisible();
});

for (const bad of ['-5', '1e9', 'abc', '0']) {
  test(`typing ${bad} is refused with a message, never rewritten into another level`, async ({ page }) => {
    await install(page);
    const target = page.getByLabel('Target value (blank = off)').first();
    await target.fill('30');
    await target.press('Tab');
    await target.fill(bad);
    await target.press('Tab');
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(target).toHaveValue('30');
  });
}

test('Δ OI tab: call OI − put OI on the left, coloured by the heavier side; right panel empty', async ({ page }) => {
  await install(page);
  await page.getByRole('tab', { name: 'Δ OI' }).click();
  await expect(page.getByText('Δ OI: calls − puts (total)')).toBeVisible();
  // Every mocked strike: CE 3,000 − PE 4,000 = −1,000 (puts heavier → green).
  const cell = page.getByText('-1,000', { exact: true }).first();
  await expect(cell).toBeVisible();
  await expect(cell).toHaveClass(/text-emerald-400/);
  await expect(cell).toHaveAttribute('title', 'Call OI 3,000 − Put OI 4,000');
  await expect(page.getByText('3,000', { exact: true })).toHaveCount(0);   // right panel empty
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Δ OI' })).toHaveAttribute('aria-selected', 'true');
});

test('3m slots tab: frozen slots + shaded running slot, coloured by sign, running next to the strike; survives a reload', async ({ page }) => {
  const m = await install(page);
  await page.getByRole('tab', { name: '3m slots' }).click();
  await expect(page.getByText('PUTS: 10 × 3 min + now')).toBeVisible();
  // Completed slot: exact value and slot in the hover.
  const add = page.getByText('+1.5k', { exact: true }).first();
  await expect(add).toHaveClass(/text-emerald-400/);
  await expect(add).toHaveAttribute('title', '10:27–10:30: +1,500 lots');
  await expect(page.getByText('-40', { exact: true }).first()).toHaveClass(/text-red-400/);
  // Running slot: shaded, italic, labelled as running.
  const run = page.getByText('+77', { exact: true }).first();
  await expect(run).toHaveClass(/italic/);
  await expect(run).toHaveAttribute('title', '10:30–10:33, running (so far to 10:31:20): +77 lots');
  await expect(page.getByText('10:33…').first()).toBeVisible();
  // An edge with no reading.
  const unknown = page.getByTitle('10:00–10:03: no OI reading at a slot edge').first();
  await expect(unknown).toHaveText('–');
  // Totals.
  await expect(page.getByText('-12,835', { exact: true }).first()).toHaveAttribute('title', 'OI change 10:00–10:31:20: -12,835 lots');
  // Running slot sits next to the strike on both sides.
  const row = page.locator('div.grid', { hasText: '8100' }).filter({ hasText: '+1.5k' }).first();
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  expect(text.indexOf('+1.5k')).toBeLessThan(text.indexOf('+77'));
  expect(text.indexOf('+77')).toBeLessThan(text.indexOf('8100'));
  expect(text.indexOf('+5 ')).toBeGreaterThan(text.indexOf('8100'));
  expect(text.indexOf('+5 ')).toBeLessThan(text.indexOf('-12k'));
  await page.reload();
  await expect(page.getByRole('tab', { name: '3m slots' })).toHaveAttribute('aria-selected', 'true');
  expect(m.blocked).toEqual([]);
});

test('− / + step the header level by 1: off → 1 → 2, back to off; a typed value is stepped from', async ({ page }) => {
  await install(page);
  const target = page.getByLabel('Target value (blank = off)').first();
  const plus = page.getByRole('button', { name: 'Target one % higher' }).first();
  const minus = page.getByRole('button', { name: 'Target one % lower' }).first();
  await plus.click();
  await expect(target).toHaveValue('1');
  await plus.click();
  await expect(target).toHaveValue('2');
  await minus.click();
  await minus.click();
  await expect(target).toHaveValue('');          // off
  await target.fill('20');
  await plus.click();                            // the blur commits 20 first; the step builds on it
  await expect(target).toHaveValue('21');
  await page.getByRole('group', { name: 'Target unit' }).first().getByRole('button', { name: 'pts' }).click();
  await page.getByRole('button', { name: 'Target one point higher' }).first().click();
  await expect(target).toHaveValue('22');
  await page.reload();
  await expect(page.getByLabel('Target value (blank = off)').first()).toHaveValue('22');
});

test('strike-row Target button opens a popover and saves that position\'s own SL in points', async ({ page }) => {
  const m = await install(page, { withPosition: true });
  await page.getByRole('button', { name: /Arm live trading/ }).click();
  const btn = page.getByRole('button', { name: 'Target and stop-loss for 8100 CE' });
  await expect(btn).toBeVisible();
  await btn.click();
  const dlg = page.getByRole('dialog', { name: '8100 CE target and stop-loss' });
  await expect(dlg).toBeVisible();
  await page.screenshot({ path: '/tmp/claude-1000/-home-sumit-dhan-algo/69b017f5-26e6-4b1a-b412-ef2f63cac250/scratchpad/fm-popover.png' });
  // Escape closes it, re-open, edit SL to 15 pts and Save
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await btn.click();
  const sl = dlg.getByLabel('SL value (blank = off)');
  await sl.fill('15');
  await sl.press('Tab');
  await dlg.getByRole('group', { name: 'SL unit' }).getByRole('button', { name: 'pts' }).click();
  await expect(dlg.getByText('target 130.00 · SL 85.00')).toBeVisible();
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => m.posts.find(b => b.action === 'setExit')).toEqual({
    action: 'setExit', key: KEY, target: { value: 30, unit: 'pct' }, sl: { value: 15, unit: 'pts' },
  });
  await expect(dlg).toBeHidden();
  expect(m.blocked).toEqual([]);
});

test('header shows the labelled New positions and Total groups', async ({ page }) => {
  await install(page);
  await expect(page.getByText('New positions', { exact: true })).toBeVisible();
  await expect(page.getByText('Total · all brokers')).toBeVisible();
  await expect(page.getByText(/Board fresh money|fresh share|normal range/i)).toHaveCount(0);
  await expect(page.getByText('Cumulative OI', { exact: true })).toBeVisible();
  await expect(page.locator('.recharts-area').first()).toBeVisible();
  // The picker offers half and full of the recorded band the API reports; the PCR pill shows the spot-centred value.
  await expect(page.getByRole('button', { name: '±5', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '±10', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '±15', exact: true })).toHaveCount(0);
  await expect(page.getByText(/PCR ±10/)).toContainText('1.23');
  await page.screenshot({ path: '/tmp/claude-1000/-home-sumit-dhan-algo/69b017f5-26e6-4b1a-b412-ef2f63cac250/scratchpad/fm-header.png', fullPage: true });
});
