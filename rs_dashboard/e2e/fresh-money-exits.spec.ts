import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Fresh Money target / stop-loss, browser side only. Every /api/fresh-money* call and the collector status are answered
// in the browser; any other non-GET /api request is refused (599) and fails the test, so nothing can reach an order route.

const KEY = 'dhan|111';
const istNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
const istToday = () => istNow().slice(0, 10);

const side = (oi: number, chg: number) => ({ oi, oiMoved: chg, fresh: 0.2, buildup: null });
function board() {
  const rows = [8300, 8200, 8100, 8000, 7900].map(strike => ({ strike, put: side(4000, 300), call: side(3000, -200) }));
  return {
    underlying: 'CRUDEOIL', date: istToday(), isToday: true, lastTs: istNow(), spot: 8105, expiry: '2026-11-17', step: 100,
    lot: 1, oiUnit: 'lots', market: 'MCX', mult: 100, day: { from: 540, to: 1435 }, rows,
    board: { puts: 0.15, calls: 0.1 }, normal: { puts: null, calls: null }, series: [], band: [], historyDays: 1, hasBuildup: false,
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
