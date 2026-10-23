import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import type { LadderSlice, LadderState } from '../lib/priceLadder';

// Price Ladder, browser side only. /api/price-ladder/state is answered by an in-browser fake (no server watcher, no
// broker); every other non-GET that is not handled is refused (599) and fails the test, so nothing can reach an order route.

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const SPOT = 23200;

async function install(page: Page, opts: { liveArmed?: boolean; openLong?: boolean; sessions?: Record<string, boolean>; /** Server clock as IST HH:MM today, and a spot that last moved a minute before it. */ staleAt?: string } = {}) {
  const clock = opts.staleAt ? new Date(`${istToday()}T${opts.staleAt}:00+05:30`).getTime() : null;
  const seen = { posts: [] as Record<string, unknown>[], blocked: [] as string[], gets: [] as string[] };
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
    // The push stream would answer from the real server's ledger and overwrite this fake: refuse it, the page falls back to its 1 s poll.
    if (p === '/api/price-ladder/stream') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'mocked off' });
    // Read-only broker endpoints the page polls: answered here so a test never reads a real account.
    if (p === '/api/auth/broker-status') return json(route, { dhan: true, kotak: true, zerodha: true, ...opts.sessions });
    if (p === '/api/dashboard/portfolio') {
      seen.gets.push(`${p}?broker=${u.searchParams.get('broker')}`);
      const broker = u.searchParams.get('broker');
      return json(route, { success: true, brokers: [{ broker, connected: true, error: null, unpricedPositions: 0, openPositions: 2, totalPnl: broker === 'dhan' ? -8012 : 150 }] });
    }
    if (/^\/api\/scalper(\/(kotak|zerodha))?\/poll$/.test(p)) {
      seen.gets.push(p);
      return json(route, { success: true, positions: [], orders: [], trades: [] });
    }
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
          state, spots: { NIFTY: clock ? { spot: SPOT, at: clock - 60_000, source: 'ws (not moved yet)', fresh: false } : { spot: SPOT, at: Date.now(), source: 'indices', fresh: true } }, ltps: { '111': 120 },
          liveArmed: !!opts.liveArmed, now: clock ?? Date.now(),
          // The page reads the contract only from a reply that echoes the selection it is showing.
          request: { underlying: u.searchParams.get('underlying'), expiry: u.searchParams.get('expiry') ?? '', strike: Number(u.searchParams.get('strike')) || null, opt: u.searchParams.get('opt'), pairCe: Number(u.searchParams.get('pairCe')) || null, pairPe: Number(u.searchParams.get('pairPe')) || null },
          pair: Number(u.searchParams.get('pairCe')) > 0 ? {
            ce: { strike: Number(u.searchParams.get('pairCe')), securityId: '111', ltp: 120 }, pe: { strike: Number(u.searchParams.get('pairPe')), securityId: '222', ltp: 100 },
            combined: 220, lotSize: 65, mult: 1,
          } : null,
          contract: { securityId: '111', lotSize: 65, ltp: 120 },
        } });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      if (body.action === 'arm') {
        const s: LadderSlice = {
          id: `t${seen.posts.length}`, kind: 'xy', broker: (body.broker as 'dhan') ?? 'dhan', mode: 'sim',
          contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
          side: body.side as 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'armed', createdAt: Date.now(), updatedAt: Date.now(),
          entryLevel: Number(body.level), entryDir: 'below', seenSafe: true, bracket: body.bracket as LadderSlice['bracket'],
        };
        state.slices.push(s);
      }
      if (body.action === 'market') {
        state.slices.push({
          id: `m${seen.posts.length}`, kind: 'plain', broker: (body.broker as 'dhan') ?? 'dhan', mode: body.mode === 'real' ? 'real' : 'sim',
          contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
          side: body.side as 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open', createdAt: Date.now(), updatedAt: Date.now(), market: true,
        } as LadderSlice);
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

// The page opens with two ladders (ATM call + ATM put); the single-ladder tests below close the second so their
// locators stay unique.
async function gotoSingle(page: Page) {
  await page.goto('/price-ladder');
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(page.getByLabel('Underlying')).toHaveCount(1);
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('XY SIM: clicking Buy below spot arms a bracketed CE entry, and its badge cancels it', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
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
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect(page.getByText(/breakout entry — switch Order Type to SL/)).toBeVisible();
  expect(seen.posts).toEqual([]);
});

test('Put in XY mode: the ladder is inverted — a Buy above spot is a limit', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Put' }).click();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ opt: 'PE', side: 'BUY', level: 23220 });
});

test('REAL without the daily arm: the ladder is disabled and nothing is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: false });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(page.getByText(/arm LIVE · REAL MONEY for today before placing/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy at 23180' })).toBeDisabled();
  expect(seen.posts).toEqual([]);
  expect(seen.blocked).toEqual([]);
});

test('REAL armed: the first click asks for confirmation before anything is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ mode: 'real', level: 23180 });
});

test('Buy Market / Sell Market (SIM): one click sends the selected contract at market with the current lots', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sell at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'market').length).toBe(1);
  expect(seen.posts.find(b => b.action === 'market')).toMatchObject({ mode: 'sim', broker: 'dhan', side: 'SELL', lots: 1, opt: 'CE', strike: 23200 });
  expect(seen.blocked).toEqual([]);
});

test('Buy Market (REAL): the first click asks for confirmation before anything is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Buy at market' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'market').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ action: 'market', mode: 'real', side: 'BUY' });
});

test('SIM mode shows a loud paper marker; REAL hides it', async ({ page }) => {
  await install(page, { liveArmed: true });
  await gotoSingle(page);
  const badge = page.getByRole('status').filter({ hasText: 'SIM · PAPER — NOT REAL' });
  await expect(badge).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(badge).toHaveCount(0);
});

test('The chime toggle mutes and unmutes trade sounds and is remembered', async ({ page }) => {
  await install(page);
  await gotoSingle(page);
  await page.getByRole('button', { name: 'Mute trade chimes' }).click();
  await expect(page.getByRole('button', { name: 'Unmute trade chimes' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(page.getByRole('button', { name: 'Unmute trade chimes' })).toBeVisible();
  await page.getByRole('button', { name: 'Unmute trade chimes' }).click();
  await expect(page.getByRole('button', { name: 'Mute trade chimes' })).toBeVisible();
});

test('Settings: the NSE cutoff is set separately from the MCX one', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await page.getByTitle('Configure Price Ladder trading cutoff & session thresholds').click();
  await expect(page.getByText('NSE Trading Cutoff (Nifty, Bank Nifty & other indices)')).toBeVisible();
  await expect(page.getByText('MCX Trading Cutoff (CRUDEOILM)')).toBeVisible();
  const nse = page.getByText('NSE Trading Cutoff (Nifty, Bank Nifty & other indices)').locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]');
  await nse.getByRole('button', { name: /^15:35/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'settings').length).toBe(1);
  expect(seen.posts.find(b => b.action === 'settings')).toMatchObject({ nseAutoExitTime: '15:35', confirmPast: false });
  expect(seen.posts.find(b => b.action === 'settings')).not.toHaveProperty('mcxAutoExitTime');
});

test('Bracket: target and SL show on the ladder as soon as it is armed (dashed, before the fill)', async ({ page }) => {
  await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  // 23180 + 40 = 23220 target, 23180 - 30 = 23150 SL
  await expect(page.locator('[title^="Target — set when the entry fills"]', { hasText: '23220' })).toHaveCount(1);
  await expect(page.locator('[title^="SL — set when the entry fills"]', { hasText: '23150' })).toHaveCount(1);
});

test('Cover order sends an SL-only bracket (target 0)', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cover', exact: true }).click();
  await expect(page.getByLabel('Target points')).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ bracket: { tgtPts: 0, slPts: 30 } });
});

test('Drag an armed entry to another row to move its level', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
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
  await gotoSingle(page);
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
  await gotoSingle(page);
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
  await gotoSingle(page);
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

test('Two ladders by default: ladder 1 is the call, ladder 2 the put, each with its own selection; Close / Add ladder toggles the second', async ({ page }) => {
  const seen = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  const underlying = page.getByLabel('Underlying');
  await expect(underlying).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Add ladder/ })).toHaveCount(0);   // at most two
  // Both panes hydrated (their expiry lists loaded): an earlier selectOption would be reset by the mount effect that restores saved choices.
  await expect(page.getByLabel('Expiry').first()).toHaveValue('2026-10-27');
  await expect(page.getByLabel('Expiry').nth(1)).toHaveValue('2026-10-27');
  // Call on ladder 1, Put on ladder 2 (the Call/Put switch's pressed side)
  await expect(page.getByRole('button', { name: 'Call', exact: true, pressed: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Put', exact: true, pressed: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Call', exact: true })).toHaveCount(2);
  // Page-wide header controls appear once, not once per ladder
  for (const name of [/Arm LIVE/, /Order book/, /Trade book/, /^Positions/]) await expect(page.getByRole('button', { name })).toHaveCount(1);
  await expect(page.locator('.sticky').getByText('Settings', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^DATA:/)).toHaveCount(1);
  // Side by side, the two ladders start at the same height (headers held to the taller one)
  await expect.poll(async () => {
    const h = await page.locator('.sticky').evaluateAll(els => els.filter(e => e.querySelector('h1')).map(e => Math.round(e.getBoundingClientRect().height)));
    return h.length === 2 && h[0] === h[1];
  }).toBe(true);
  await underlying.nth(1).selectOption('BANKNIFTY');
  await expect(underlying.nth(0)).toHaveValue('NIFTY');
  await expect(underlying.nth(1)).toHaveValue('BANKNIFTY');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(underlying).toHaveCount(1);
  await page.getByRole('button', { name: /Add ladder/ }).click();
  await expect(underlying).toHaveCount(2);
  expect(seen.blocked).toEqual([]);
});

test('The header controls fold away for more room (both ladders at once), keep a broker · mode chip, and stay folded on reload', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  await expect(page.getByLabel('Expiry').first()).toHaveValue('2026-10-27');
  await expect(page.getByRole('button', { name: /Arm LIVE/ })).toHaveCount(1);
  const head = () => page.locator('.sticky').first().evaluate(e => e.getBoundingClientRect().height);
  const open = await head();
  await page.getByRole('button', { name: 'Hide header controls' }).first().click();
  await expect(page.getByRole('button', { name: /Arm LIVE/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show header controls' })).toHaveCount(2);
  await expect(page.getByText('Dhan · SIM')).toHaveCount(2);
  // Indices and P&L stay visible while the controls are folded
  await expect(page.getByText('INDIA VIX')).toBeVisible();
  await expect(page.getByText(/^Ladder P&L/)).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Order book/ })).toHaveCount(0);
  expect(await head()).toBeLessThan(open);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show header controls' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Show header controls' }).first().click();
  await expect(page.getByRole('button', { name: /Arm LIVE/ })).toHaveCount(1);
});

// ── every broker ──────────────────────────────────────────────────────────────────────────────────────────────
// The browser side of the per-broker paths (the order/placement code itself is covered by the unit tests and cannot be
// run against a live account): each mode sends the selected broker, the books and account chip read THAT broker, a
// logged-out broker blocks REAL, and MCX stays Dhan-only.
for (const broker of ['dhan', 'kotak', 'zerodha'] as const) {
  const Name = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' }[broker];
  test.describe(`${Name}`, () => {
    test(`XY, Plain and Pair orders all carry the broker`, async ({ page }) => {
      const seen = await install(page);
      await gotoSingle(page);
      await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await expect(page.getByText(new RegExp(`SIM · ${Name}`))).toBeVisible();
      await page.getByRole('button', { name: 'Buy at 23180' }).click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
      expect(seen.posts[0]).toMatchObject({ kind: 'xy', broker, mode: 'sim', side: 'BUY', level: 23180 });
      await page.getByRole('button', { name: 'Plain', exact: true }).click();
      await page.getByRole('button', { name: /^Buy at 119\.00/ }).first().click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(2);
      expect(seen.posts[1]).toMatchObject({ kind: 'plain', broker, mode: 'sim', side: 'BUY' });
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      await page.getByRole('button', { name: /^Buy at 21[0-9]/ }).first().click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'pair').length).toBe(1);
      expect(seen.posts.find(b => b.action === 'pair')).toMatchObject({ op: 'arm', broker, mode: 'sim', side: 'BUY' });
      expect(seen.blocked).toEqual([]);
    });

    test(`the account chip and the books read ${Name}'s own endpoints`, async ({ page }) => {
      const seen = await install(page);
      await gotoSingle(page);
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await expect(page.getByText(`${Name} P&L`)).toBeVisible();
      await expect.poll(() => seen.gets.includes(`/api/dashboard/portfolio?broker=${broker}`)).toBe(true);
      await page.getByRole('button', { name: /^Positions/ }).click();
      await expect.poll(() => seen.gets.includes(broker === 'dhan' ? '/api/scalper/poll' : `/api/scalper/${broker}/poll`)).toBe(true);
      expect(seen.blocked).toEqual([]);
    });

    test(`REAL with ${Name} logged out is blocked up front and sends nothing`, async ({ page }) => {
      const seen = await install(page, { liveArmed: true, sessions: { [broker]: false } });
      await gotoSingle(page);
      await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await page.getByRole('button', { name: 'REAL', exact: true }).first().click();
      await expect(page.getByText(new RegExp(`${Name} session is not logged in`))).toBeVisible();
      await page.getByRole('button', { name: 'Buy at 23180' }).click({ force: true });
      await page.waitForTimeout(500);
      expect(seen.posts.filter(b => b.action === 'arm')).toEqual([]);
      expect(seen.blocked).toEqual([]);
    });

    if (broker !== 'dhan') {
      test(`MCX crude is selectable on ${Name}: no Dhan-only banner, nothing placed`, async ({ page }) => {
        const seen = await install(page);
        await gotoSingle(page);
        await page.getByLabel('Broker for new orders').selectOption(broker);
        await page.getByLabel('Underlying').selectOption('CRUDEOILM');
        await page.waitForTimeout(500);
        await expect(page.getByText(/trades on Dhan only in the Price Ladder/)).toHaveCount(0);
        expect(seen.posts.filter(b => b.action === 'arm' || b.action === 'pair')).toEqual([]);
        expect(seen.blocked).toEqual([]);
      });
    }
  });
}

test('Two ladders on different brokers: each shows its own broker account chip and books; on the same broker they are shown once', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  await expect(page.getByLabel('Expiry').nth(1)).toHaveValue('2026-10-27');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(1);
  await page.getByLabel('Broker for new orders').nth(1).selectOption('kotak');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(2);
  await expect(page.getByText('Dhan P&L')).toHaveCount(1);
  await expect(page.getByText('Kotak P&L')).toHaveCount(1);
  await page.getByLabel('Broker for new orders').nth(1).selectOption('dhan');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(1);
});

test('The stale-price warning shows only while the market is trading, not after hours', async ({ page }) => {
  await install(page, { staleAt: '11:00' });
  await gotoSingle(page);
  await expect(page.getByText(/price is stale|spot is stale/)).toBeVisible();
});

test('After hours (05:30 IST) a stale price is not warned about', async ({ page }) => {
  await install(page, { staleAt: '05:30' });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/is stale/)).toHaveCount(0);
});
