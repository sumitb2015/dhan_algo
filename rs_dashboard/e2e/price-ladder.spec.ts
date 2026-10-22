import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import type { LadderSlice, LadderState } from '../lib/priceLadder';

// Price Ladder, browser side only. /api/price-ladder/state is answered by an in-browser fake (no server watcher, no
// broker); every other non-GET that is not handled is refused (599) and fails the test, so nothing can reach an order route.

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const SPOT = 23200;

async function install(page: Page, opts: { liveArmed?: boolean; openLong?: boolean } = {}) {
  const seen = { posts: [] as Record<string, unknown>[], blocked: [] as string[] };
  const state: LadderState = { date: istToday(), slices: [], events: [] };
  if (opts.openLong) {
    state.slices.push({
      id: 'open1', kind: 'xy', broker: 'dhan', mode: 'sim', side: 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open',
      contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
      createdAt: Date.now(), updatedAt: Date.now(), openedAt: Date.now(), filledQty: 65, avg: 110, entryLevel: 23180, entryY: 23180,
      bracket: { tgtPts: 40, slPts: 30 }, tgtY: 23220, slY: 23150, slY0: 23150,
    });
  }
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-27'] });
    if (p === '/api/options/chain') {
      const oc: Record<string, unknown> = {};
      for (const k of [23100, 23150, 23200, 23250, 23300]) oc[`${k}.000000`] = { ce: {}, pe: {} };
      return json(route, { success: true, data: { spot: SPOT, chain: { oc } } });
    }
    if (p === '/api/scalper/top-indices') return json(route, { success: true, quotes: { NIFTY: { ltp: SPOT, prev_close: 23100, change_pct: 0.43, day_high: 23250, day_low: 23050 } } });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/price-ladder/state') {
      if (method === 'GET') {
        return json(route, { success: true, data: {
          state, spots: { NIFTY: { spot: SPOT, at: Date.now(), source: 'indices', fresh: true } }, ltps: { '111': 120 },
          liveArmed: !!opts.liveArmed, now: Date.now(), contract: { securityId: '111', lotSize: 65, ltp: 120 },
        } });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      if (body.action === 'arm') {
        const s: LadderSlice = {
          id: `t${seen.posts.length}`, kind: 'xy', broker: 'dhan', mode: 'sim',
          contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
          side: body.side as 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'armed', createdAt: Date.now(), updatedAt: Date.now(),
          entryLevel: Number(body.level), entryDir: 'below', seenSafe: true, bracket: body.bracket as LadderSlice['bracket'],
        };
        state.slices.push(s);
      }
      if (body.action === 'cancel') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, state: 'cancelled' } : x));
      if (body.action === 'lots') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, lots: Number(body.lots), qty: Number(body.lots) * 65 } : x));
      if (body.action === 'modify') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, entryLevel: Number(body.level) } : x));
      return json(route, { success: true, data: { state } });
    }
    if (method !== 'GET') {
      seen.blocked.push(`${method} ${p}`);
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return route.continue();
  });
  return seen;
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('XY SIM: clicking Buy below spot arms a bracketed CE entry, and its badge cancels it', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /NIFTY\s+23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  const arm = seen.posts.find(b => b.action === 'arm')!;
  expect(arm).toMatchObject({ kind: 'xy', mode: 'sim', broker: 'dhan', side: 'BUY', level: 23180, opt: 'CE', strike: 23200, bracket: { tgtPts: 40, slPts: 30 } });
  await page.getByRole('button', { name: 'Cancel Entry BUY 1 lot at 23180' }).click();
  await expect.poll(() => seen.posts.some(b => b.action === 'cancel')).toBe(true);
  expect(seen.blocked).toEqual([]);
});

test('XY: a Buy above spot with Order Type Limit is refused in the page (it is a breakout: needs SL)', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect(page.getByText(/breakout entry — switch Order Type to SL/)).toBeVisible();
  expect(seen.posts).toEqual([]);
});

test('Put in XY mode: the ladder is inverted — a Buy above spot is a limit', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Put' }).click();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ opt: 'PE', side: 'BUY', level: 23220 });
});

test('REAL without the daily arm: the ladder is disabled and nothing is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: false });
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(page.getByText(/arm LIVE · REAL MONEY for today before placing/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy at 23180' })).toBeDisabled();
  expect(seen.posts).toEqual([]);
  expect(seen.blocked).toEqual([]);
});

test('REAL armed: the first click asks for confirmation before anything is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ mode: 'real', level: 23180 });
});

test('Bracket: target and SL show on the ladder as soon as it is armed (dashed, before the fill)', async ({ page }) => {
  await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  // 23180 + 40 = 23220 target, 23180 - 30 = 23150 SL
  await expect(page.locator('[title="Target — set when the entry fills"]', { hasText: '23220' })).toHaveCount(1);
  await expect(page.locator('[title="SL — set when the entry fills"]', { hasText: '23150' })).toHaveCount(1);
});

test('Cover order sends an SL-only bracket (target 0)', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cover', exact: true }).click();
  await expect(page.getByLabel('Target points')).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ bracket: { tgtPts: 0, slPts: 30 } });
});

test('Drag an armed entry to another row to move its level', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  const badge = page.locator('[title="Entry — drag to another price to move it"]');
  await expect(badge).toBeVisible();
  await badge.dragTo(page.getByRole('button', { name: 'Buy at 23170' }));
  await expect.poll(() => seen.posts.find(b => b.action === 'modify')).toMatchObject({ action: 'modify', level: 23170 });
  expect(seen.blocked).toEqual([]);
});

test('Zerodha: the broker picker offers Zerodha and new ladder orders go to it', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByLabel('Broker for new orders').selectOption('zerodha');
  await expect(page.getByText(/SIM · Zerodha/)).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ broker: 'zerodha', mode: 'sim', side: 'BUY', level: 23180 });
  expect(seen.blocked).toEqual([]);
});

test('An armed order sits in the Buy column as price | + − | qty, and the Price column shows only prices', async ({ page }) => {
  const seen = await install(page);
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  const buyCell = page.getByRole('button', { name: 'Buy at 23180' });
  await expect(buyCell.locator('[data-widget="entry"]')).toContainText('65');
  // the price cell next to it is just the price
  const row = buyCell.locator('xpath=..');
  await expect(row.locator(':scope > div').nth(2)).toHaveText('23180');
  // + raises the armed order to 2 lots in place; − at 1 lot does not go below 1
  await page.getByRole('button', { name: 'Plus one lot: Entry BUY 1 lot at 23180' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'lots')).toMatchObject({ action: 'lots', lots: 2 });
  await expect(buyCell.locator('[data-widget="entry"]')).toContainText('130');
  expect(seen.blocked).toEqual([]);
});

test('An open bracket shows TGT and SL widgets in the Sell column; + adds a lot, − exits a lot', async ({ page }) => {
  const seen = await install(page, { openLong: true });
  await page.goto('/price-ladder');
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  const tgt = page.getByRole('button', { name: 'Sell at 23220' }).locator('[data-widget="tgt"]');
  const sl = page.getByRole('button', { name: 'Sell at 23150' }).locator('[data-widget="sl"]');
  await expect(tgt).toContainText('65');
  await expect(sl).toContainText('65');
  await page.getByRole('button', { name: 'Minus one lot: Target SELL 1 lot at 23220' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'exit')).toMatchObject({ action: 'exit', ids: ['open1'], lots: 1 });
  await page.getByRole('button', { name: 'Plus one lot: SL SELL 1 lot at 23150' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'add')).toMatchObject({ action: 'add', id: 'open1' });
  expect(seen.blocked).toEqual([]);
});
