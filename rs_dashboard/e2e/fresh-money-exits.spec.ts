import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Fresh Money target / stop-loss, browser side only. Every /api/fresh-money* call and the collector status are answered
// in the browser; any other non-GET /api request is refused (599) and fails the test, so nothing can reach an order route.

const KEY = 'dhan|111';
const istNow = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
const istToday = () => istNow().slice(0, 10);

// Slot cells: 10 completed slots oldest first, then the running slot; the oldest edge had no reading (null).
// Board scale (95th pct of |cell|) = 1500. Puts: ten tinted adds in a row -> ▲10, and the widest number label
// ("▲10 +99,999"). Calls: -300, -400, -900, -12000 cutting -> ▼4; +12 ... +15 are grey (under 10 %) noise.
const PUT_FLOW = { cells: [300, 320, 340, 360, 380, 400, 600, 450, 400, 1500, 77], day: 99999 };
// The calls' day (+500) is positive while the last 4 slots cut OI: the ▼4 runs against the day -> amber (reversal).
const CALL_FLOW = { cells: [null, 12, 13, 14, 15, 10, -300, -400, -900, -12000, 5], day: 500 };
const side = (oi: number, chg: number, flow: unknown) => ({ oi, oiMoved: chg, buildup: null, flow });
function board() {
  const rows = [8300, 8200, 8100, 8000, 7900].map(strike => ({ strike, put: side(4000, 300, PUT_FLOW), call: side(3000, -200, CALL_FLOW) }));
  return {
    underlying: 'CRUDEOIL', date: istToday(), isToday: true, lastTs: istNow(), spot: 8105, expiry: '2026-11-17', step: 100,
    lot: 1, oiUnit: 'lots', market: 'MCX', mult: 100, day: { from: 540, to: 1435 }, rows,
    hasBuildup: false,
    flowSlots: { slotMin: 3, bounds: ['10:00', '10:03', '10:06', '10:09', '10:12', '10:15', '10:18', '10:21', '10:24', '10:27', '10:30'],
      boundOk: [false, true, true, true, true, true, true, true, true, true, true], lastTs: '10:31:20', dayAt: '10:30' },
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

async function install(page: Page, opts: { watcherAlive?: boolean; withPosition?: boolean; trailed?: boolean } = {}) {
  // Set by the test (fireExit) once the page has recorded the watching state: from then on the server reports it fired.
  let exitFired = false;
  const posts: Record<string, unknown>[] = [];
  const blocked: string[] = [];
  const state = () => ({
    date: istToday(), tradable: ['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM'], maxLots: 20, maxPositionLots: 60,
    sessions: Object.fromEntries(['NIFTY', 'BANKNIFTY', 'CRUDEOIL', 'CRUDEOILM'].map(u => [u, { gate: 'open', note: null }])),
    boardExpiry: { NIFTY: null, BANKNIFTY: null, CRUDEOIL: '2026-11-17', CRUDEOILM: null },
    ltpSource: { '111': 'ws' }, brokers: { dhan: true, kotak: true, zerodha: true },
    positions: opts.withPosition ? [position] : [], orders: [],
    exits: opts.withPosition
      ? { [KEY]: exitFired ? { ...exitRecord, state: 'sent', firedBy: 'target', firedAt: Date.now() }
        : opts.trailed ? { ...exitRecord, slPx: 95, slBasePx: 80, trailSteps: 3, trail: { every: 10, by: 5, unit: 'pts', startAt: null } }
        : exitRecord }
      : {},
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
      if (body.action === 'exitAll') {
        return json(route, { success: true, outcome: 'sent', items: [{ key: KEY, label: 'CRUDEOIL 8100 CE', kind: 'placed' }] });
      }
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
  return { posts, blocked, fireExit: () => { exitFired = true; } };
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
  expect(order.product).toBe('MIS');
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
    action: 'setExit', key: KEY, target: { value: 30, unit: 'pct' }, sl: { value: 15, unit: 'pts' }, trail: null,
  });
  expect(m.blocked).toEqual([]);
});

test('Positions editor: trailing stop-loss X − Y is saved; Y above X is refused before Save', async ({ page }) => {
  const m = await install(page, { withPosition: true });
  await page.getByRole('button', { name: /Arm live trading/ }).click();
  await page.getByRole('button', { name: 'Edit target and stop-loss of CRUDEOIL 8100 CE on Dhan' }).click();
  await page.getByLabel('Trailing stop-loss').last().check();
  const x = page.getByLabel('Trail: price move X').last();
  const y = page.getByLabel('Trail: stop move Y').last();
  await x.fill('5'); await x.press('Tab');
  await y.fill('10'); await y.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: "can't move more than the price" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await x.fill('10'); await x.press('Tab');
  await y.fill('5'); await y.press('Tab');
  await page.getByRole('group', { name: 'Trail unit' }).last().getByRole('button', { name: 'pts' }).click();
  await expect(page.getByText('SL moves +5.00 every +10.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => m.posts.find(b => b.action === 'setExit')).toEqual({
    action: 'setExit', key: KEY, target: { value: 30, unit: 'pct' }, sl: { value: 20, unit: 'pct' },
    trail: { every: 10, by: 5, unit: 'pts', startAt: null },
  });
  expect(m.blocked).toEqual([]);
});

test('a trailed stop shows its T badge with the step count', async ({ page }) => {
  await install(page, { withPosition: true, trailed: true });
  await expect(page.getByLabel('Trailing stop-loss, moved 3 times')).toHaveText('T3');
  await expect(page.getByText('130.00 / 95.00')).toBeVisible();
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

test('3m slots tab: tints, streak / reversal badges, totals row, crosshair, sticky times, legend; survives a reload', async ({ page }) => {
  const m = await install(page);
  await page.getByRole('tab', { name: '3m slots' }).click();
  await expect(page.getByText('PUTS: OI Δ today @ 10:30')).toBeVisible();
  // Completed slot: exact value and slot in the hover.
  const add = page.getByTitle(/^10:27–10:30: \+1,500 lots · OI Δ today at 10:30: /).first();   // a strike's cell (the totals row sums 5)
  await expect(add).toHaveText('+1.5k');
  await expect(add).toHaveClass(/bg-emerald-500\/45/);                 // >= 70 % of the scale: strongest tint, bold
  await expect(add).toHaveClass(/font-bold/);
  await expect(add).toHaveClass(/text-white/);                         // theme token: readable on the strong tint
  await expect(page.getByText('-900', { exact: true }).first()).toHaveClass(/bg-red-500\/25/);   // 60 %: mid tint
  const small = page.getByText('+12', { exact: true }).first();          // under 10 % of the scale: grey, no tint
  await expect(small).toHaveClass(/text-zinc-500/);
  await expect(small).not.toHaveClass(/bg-/);
  // Streak badges: completed slots only, newest backwards.
  const up = page.getByTitle('10 completed slots in a row adding OI (10:00–10:30)', { exact: true }).first();
  await expect(up).toHaveText('▲10');
  await expect(up).toHaveClass(/text-emerald-400/);                    // same direction as today's net: green
  // The widest label stays on one line inside its column (no wrap into the next row).
  const wide = page.getByTitle(/^Today's OI change vs the previous close, as of 10:30: \+99,999 lots = earlier .+ · live \(10:31:20\): \+300 lots$/).first();
  await expect(wide).toHaveText('▲10 +99,999');
  const box = await wide.boundingBox();
  expect(box!.height).toBeLessThan(22);
  expect(await wide.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  // Against today's net (+500): amber, and the hover says so.
  const rev = page.getByTitle("4 completed slots in a row cutting OI (10:18–10:30) — against today's net +500 lots: reversing", { exact: true }).first();
  await expect(rev).toHaveText('▼4');
  await expect(rev).toHaveClass(/text-amber-400/);
  // Running slot: shaded, italic, labelled as running.
  const run = page.getByText('+77', { exact: true }).first();
  await expect(run).toHaveClass(/italic/);
  await expect(run).toHaveClass(/ring-1/);
  await expect(run).toHaveAttribute('title', /^10:30–10:33, running \(so far to 10:31:20\): \+77 lots · OI Δ today so far \(10:31:20\): /);
  await expect(page.getByText('10:33…').first()).toBeVisible();
  // An edge with no reading.
  const unknown = page.getByTitle(/^10:00–10:03: no OI reading at a slot edge/).first();   // the call side's first slot
  await expect(unknown).toHaveText('–');
  // Today's change as of the last completed slot, with the live figure in the hover.
  await expect(page.getByTitle(/^Today's OI change vs the previous close, as of 10:30: \+500 lots.* · live \(10:31:20\): -200 lots$/).first())
    .toHaveText('+500 ▼4');
  // "Earlier" cell at the outer end of each block: everything before the first shown slot, so a row adds up.
  await expect(page.getByTestId('flow-sticky-head').locator('[data-slot="carry"]')).toHaveCount(4);   // slot times + Σ row, both sides
  await expect(page.getByTestId('flow-sticky-head').locator('[data-slot="carry"]').first()).toHaveText(/^<\d\d:\d\d$/);
  const sums = await page.locator('div.grid', { hasText: '8100' }).first().evaluate(row => {
    const block = row.querySelector('span.grid');                       // the put side's cell block (carry first)
    const day = row.querySelector('[title^="Today\'s OI change"]')?.getAttribute('title') ?? '';
    return { cells: [...(block?.children ?? [])].map(c => ({ slot: c.getAttribute('data-slot'), title: c.getAttribute('title') ?? '' })), day };
  });
  expect(sums.cells[0].slot).toBe('carry');
  expect(sums.day).toMatch(/ = earlier .+ \+ slots /);
  // Board totals: the 5 mocked strikes summed per slot, own row under the slot times.
  await expect(page.getByText('Σ shown', { exact: true })).toBeVisible();
  await expect(page.getByTitle(/^10:27–10:30: \+7,500 lots · /)).toHaveText('+7.5k');
  await expect(page.getByTitle(/^10:27–10:30: -60,000 lots · /)).toHaveText('-60k');
  // Slot times + totals are pinned while the ladder scrolls.
  expect(await page.getByTestId('flow-sticky-head').evaluate(el => getComputedStyle(el).position)).toBe('sticky');
  // Crosshair: hovering a cell highlights its strike row and its slot column (other rows and the header).
  await add.hover();
  await expect(page.locator('div.grid').filter({ has: add }).first()).toHaveClass(/bg-zinc-800\/50/);
  await expect(page.getByTitle(/^10:27–10:30: \+1,500 lots · OI Δ today at 10:30: /).nth(1)).toHaveClass(/ring-zinc-300/);
  await expect(page.getByTestId('flow-sticky-head').locator('[data-slot="9"]').first()).toHaveClass(/ring-zinc-300/);
  // Leaving the cells (onto the strike) clears the crosshair.
  await page.getByText('8100', { exact: true }).first().hover();
  await expect(page.locator('div.grid').filter({ has: add }).first()).not.toHaveClass(/bg-zinc-800\/50/);
  await expect(page.getByTestId('flow-sticky-head').locator('[data-slot="9"]').first()).not.toHaveClass(/ring-zinc-300/);
  // Compact legend; the full explanation is behind "?" and the choice is remembered.
  const help = page.getByRole('button', { name: 'How to read the slots' });
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await help.click();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('a possible turn', { exact: false })).toBeVisible();
  // Running slot sits next to the strike on both sides.
  const row = page.locator('div.grid', { hasText: '8100' }).filter({ hasText: '+1.5k' }).first();
  const text = (await row.innerText()).replace(/\s+/g, ' ');
  expect(text.indexOf('+1.5k')).toBeLessThan(text.indexOf('+77'));
  expect(text.indexOf('+77')).toBeLessThan(text.indexOf('8100'));
  expect(text.indexOf('+5 ')).toBeGreaterThan(text.indexOf('8100'));
  expect(text.indexOf('+5 ')).toBeLessThan(text.indexOf('-12k'));
  await page.reload();
  await expect(page.getByRole('tab', { name: '3m slots' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'How to read the slots' })).toHaveAttribute('aria-expanded', 'true');
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
    action: 'setExit', key: KEY, target: { value: 30, unit: 'pct' }, sl: { value: 15, unit: 'pts' }, trail: null,
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

test('sounds: mute button is remembered; a server-fired target exit gets a toast (once)', async ({ page }) => {
  const m = await install(page, { withPosition: true });
  await expect(page.getByText('L1', { exact: true }).first()).toBeVisible();   // the watching position is on screen
  await page.waitForTimeout(2_500);                                            // a poll has recorded it
  m.fireExit();
  // The watcher's exit (sent by the server, not this tab) is announced with a toast; the chime rides on it.
  await expect(page.getByText('Target hit — CRUDEOIL 8100 CE closed')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3_000);
  await expect(page.getByText('Target hit — CRUDEOIL 8100 CE closed')).toHaveCount(1);   // not re-announced every poll
  const mute = page.getByRole('button', { name: 'Mute Fresh Money sounds' });
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await mute.click();
  const unmute = page.getByRole('button', { name: 'Unmute Fresh Money sounds' });
  await expect(unmute).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Unmute Fresh Money sounds' })).toHaveAttribute('aria-pressed', 'true');
  expect(m.blocked).toEqual([]);
});

test('header Exit all: disabled with nothing open; one click only asks, the second sends', async ({ page }) => {
  const flat = await install(page);
  await expect(page.getByTestId('fm-exit-all')).toBeDisabled();
  expect(flat.posts).toEqual([]);

  const m = await install(page, { withPosition: true });
  const btn = page.getByTestId('fm-exit-all');
  await expect(btn).toHaveText('Exit all (1)');
  await btn.click();
  await expect(btn).toHaveText('Confirm exit 1?');
  await page.waitForTimeout(500);
  expect(m.posts.filter(b => b.action === 'exitAll')).toHaveLength(0);   // the first click never sends
  await page.waitForTimeout(4_000);
  await expect(btn).toHaveText('Exit all (1)');                          // the question lapses
  await btn.click();
  await btn.click();
  await expect(page.getByText('Exit all: 1 close sent')).toBeVisible();
  expect(m.posts.filter(b => b.action === 'exitAll')).toHaveLength(1);
  expect(m.blocked).toEqual([]);
});

test('product switch: NRML is sent with the order, labelled, and remembered across a reload', async ({ page }) => {
  const m = await install(page);
  const group = page.getByRole('radiogroup', { name: 'Product for new orders' });
  await expect(group.getByRole('radio', { name: 'MIS' })).toHaveAttribute('aria-checked', 'true');
  await group.getByRole('radio', { name: 'NRML' }).click();
  await expect(group.getByRole('radio', { name: 'NRML' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('MARKET · NRML')).toBeVisible();
  await page.getByRole('button', { name: /Arm live trading/ }).click();
  await page.getByRole('button', { name: 'Buy 8100 CE' }).click();
  await expect.poll(() => m.posts.find(b => b.action === 'order')?.product).toBe('NRML');
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Product for new orders' }).getByRole('radio', { name: 'NRML' }))
    .toHaveAttribute('aria-checked', 'true');
  expect(m.blocked).toEqual([]);
});

test('a past NSE session says where its OI comes from: the official close once loaded, else the last session reading', async ({ page }) => {
  const m = await install(page);
  let closeOi: unknown = null;
  // Registered after install, so it wins over the shared board mock.
  await page.route(/\/api\/fresh-money\?/, route => json(route, {
    ...board(), market: 'NSE', isToday: false, date: '2026-11-13', lastTs: '2026-11-13 15:39:40', closeOi,
  }));
  await page.reload();
  const chip = page.getByTestId('fm-oi-source');
  await expect(chip).toHaveText('OI · last session reading');
  await expect(chip).toHaveAttribute('title', /official close OI loads on the next trading morning/);
  closeOi = { fetchedAt: '2026-11-16 08:38:49', official: 48, total: 50 };
  await page.reload();
  await expect(chip).toHaveText('OI · official close (48/50)');
  await expect(chip).toHaveAttribute('title', /fetched 2026-11-16 08:38:49\), on 48 of 50 strike sides/);
  expect(m.blocked).toEqual([]);
});

test('lots / units switch (NSE): every OI figure × lot size, header says units, choice remembered; not shown on MCX', async ({ page }) => {
  const m = await install(page);
  await expect(page.getByRole('group', { name: 'OI unit' })).toHaveCount(0);   // MCX board: OI is already lots
  await page.route(/\/api\/fresh-money\?/, route => json(route, { ...board(), market: 'NSE', lot: 65, mult: null }));
  await page.reload();
  const units = page.getByRole('group', { name: 'OI unit' }).getByRole('button', { name: 'Units' });
  await expect(page.getByText('+300', { exact: true }).first()).toBeVisible();          // put OI change, lots
  await units.click();
  await expect(units).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/OI in units/)).toBeVisible();
  await expect(page.getByText('+19,500', { exact: true }).first()).toBeVisible();       // 300 x 65
  await page.getByRole('tab', { name: 'Total OI' }).click();
  await expect(page.getByText('2.6L', { exact: true }).first()).toBeVisible();          // 4,000 x 65 = 2,60,000
  await page.reload();
  await expect(page.getByRole('group', { name: 'OI unit' }).getByRole('button', { name: 'Units' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('2.6L', { exact: true }).first()).toBeVisible();
  expect(m.blocked).toEqual([]);
});

test('PCR switch: a column beside the strike (put OI ÷ call OI), board PCR on the Σ row, remembered; rows stay one line', async ({ page }) => {
  const m = await install(page);
  await expect(page.getByTestId('fm-pcr')).toHaveCount(0);
  const btn = page.getByRole('button', { name: 'PCR', exact: true });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const cells = page.getByTestId('fm-pcr');
  await expect(cells).toHaveCount(5);
  await expect(cells.first()).toHaveText('1.33');                       // 4,000 / 3,000
  const row = page.locator('div.grid', { hasText: '8100' }).first();
  expect((await row.boundingBox())!.height).toBeLessThan(30);
  await page.getByRole('tab', { name: '3m slots' }).click();
  await expect(page.getByTitle(/^PCR of the strikes shown: Σ put OI ÷ Σ call OI = 1\.33$/)).toHaveText('1.33');
  await expect(cells).toHaveCount(5);
  await page.reload();
  await expect(page.getByRole('button', { name: 'PCR', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('fm-pcr').first()).toHaveText('1.33');
  expect(m.blocked).toEqual([]);
});

test('PDH / PDL tags sit on the strike nearest each previous-day level, with the exact level in the hover; none on MCX', async ({ page }) => {
  const m = await install(page);
  await expect(page.getByTestId('fm-pdh')).toHaveCount(0);   // MCX board: no index levels
  await page.route(/\/api\/fresh-money\?/, route => json(route, {
    ...board(), market: 'NSE', lot: 65, mult: null, prevDay: { high: 8212.5, low: 7948, close: 8105, date: '2026-11-13' },
  }));
  await page.reload();
  const pdh = page.getByTestId('fm-pdh');
  await expect(pdh).toHaveCount(1);
  await expect(page.locator('div.grid', { hasText: '8200' }).filter({ has: pdh })).toHaveCount(1);
  await expect(pdh.locator('xpath=..')).toHaveAttribute('title', /^Previous day high 8,212\.5 \(2026-11-13\)/);
  await expect(page.locator('div.grid', { hasText: '7900' }).filter({ has: page.getByTestId('fm-pdl') })).toHaveCount(1);
  // With PCR on and on the slots tab, rows still hold one line.
  await page.getByRole('button', { name: 'PCR', exact: true }).click();
  await page.getByRole('tab', { name: '3m slots' }).click();
  expect((await page.locator('div.grid', { hasText: '8200' }).filter({ has: pdh }).first().boundingBox())!.height).toBeLessThan(30);
  expect(m.blocked).toEqual([]);
});
