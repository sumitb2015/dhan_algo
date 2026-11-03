import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Bar Replay on /renko (lib/pnfReplay.ts, components/straddlePnf/ReplayBar.tsx): the chart cut at a chosen moment, stepped / played
// forward one chart bar at a time, with practice trading at the replayed price. Every /api call is mocked; any non-GET request
// is refused and recorded — practice trading must never call an order, resting or AUTO route.

// NIFTY future, Fri 30 Oct 2026 09:15-11:14: the close rises 0.10 a minute, so with a 0.1-point brick each minute prints one brick.
const ist = (hh: number, mm: number) => Date.UTC(2026, 9, 30, hh, mm) / 1000 - 5.5 * 3600;
const BARS = Array.from({ length: 120 }, (_, i) => { const p = +(100 + i * 0.1).toFixed(2); return { t: ist(9, 15) + i * 60, ce: p, pe: 0, straddle: p, vol: 10 }; });

async function install(page: Page, blocked: Call[]) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-pnf/contracts') return json(route, { success: true, expiries: ['2026-11-24'] });
    if (p === '/api/straddle-pnf' && method === 'GET') {
      const fut = u.searchParams.get('mode') === 'contract';
      return json(route, {
        success: true, atm: 0, strikes: [0], name: fut ? 'NIFTY NOV FUT' : 'Nifty 50', errors: {}, dataDate: '2026-10-30',
        instruments: [{ segment: fut ? 'NSE_FNO' : 'IDX_I', security_id: fut ? '54321' : '13' }], bars: { 0: BARS },
      });
    }
    if (p === '/api/straddle-pnf/live') return json(route, { success: true, legs: [{ quote: null, last: { ltp: 111.9, prevClose: 99 } }] });
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65 }] });
    }
    if (p === '/api/straddle-pnf/auto' || p === '/api/straddle-pnf/resting') return json(route, { success: true, ledger: { rev: 0, rows: [], log: [] } });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });   // the header's Nifty / VIX chips
    if (p.endsWith('/funds')) return json(route, { success: true, data: { availabelBalance: 100000 } });
    if (p === '/api/scalper/poll') return json(route, { positions: [], positionsError: null });
    if (p === '/api/straddle-pnf/server-guard') return json(route, { success: true, guards: {} });   // the page syncs its MTM guard to the server watcher
    if (method === 'GET') return json(route, { success: true });
    blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

const bricks = async (page: Page) => ((await page.getByTestId('pnf-panel').first().getByTestId('pnf-bricks-up').getAttribute('d')) ?? '').split('z').length - 1;

test.beforeEach(async ({ context }) => {
  await signIn(context);
  await context.addInitScript(() => {
    const st = JSON.stringify({ interval: 1, boxMode: 'pts', boxPct: 0.1, boxPts: 0.1, reversal: 2, smaPeriod: 50 });
    try {
      if (!localStorage.getItem('renko-settings')) { localStorage.setItem('renko-settings', st); localStorage.setItem('renko-settings-2', st); }
      localStorage.setItem('renko-chart-view', '1');
    } catch { /* ignore */ }
  });
});

test('replay: pick a date, step forward, practise a trade at the replayed price; nothing is sent', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked);
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect.poll(() => bricks(page)).toBe(119);                       // the whole morning, live

  // Open replay: picking; the trade bar (and its REAL switch) gives way to the replay bar
  await page.getByRole('button', { name: 'Bar replay' }).click();
  const bar = page.getByTestId('pnf-replay-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('pnf-replay-clock')).toHaveText('Click a bar on the chart to start');
  await expect(page.getByRole('group', { name: 'Execution mode' })).toHaveCount(0);

  // Select date 10:00: the chart stops at 09:59 (44 bricks: 09:16-09:59)
  await bar.getByRole('button', { name: 'More ways to choose the start' }).click();
  await page.getByRole('menuitem', { name: 'Select date…' }).click();
  await page.getByLabel('Replay start date').fill('2026-10-30');
  await page.getByLabel('Replay start time').fill('10:00');
  await page.getByRole('button', { name: 'Start the replay at this time' }).click();
  await expect(bar.getByTestId('pnf-replay-clock')).toHaveText("30 Oct '26  09:59");
  await expect.poll(() => bricks(page)).toBe(44);
  await expect(page.getByTestId('pnf-replay-start')).toBeAttached();

  // Forward = one 1-min bar = one brick
  await bar.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(bar.getByTestId('pnf-replay-clock')).toHaveText("30 Oct '26  10:00");
  await expect.poll(() => bricks(page)).toBe(45);

  // Practice: buy 1 lot at 104.50 (10:00), step twice, sell at 104.70 -> (104.70 - 104.50) x 65 = +13
  await bar.getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(bar.getByTestId('pnf-replay-position')).toHaveText('LONG 1L @ 104.50');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(bar.getByTestId('pnf-replay-clock')).toHaveText("30 Oct '26  10:02");
  await bar.getByRole('button', { name: 'Sell', exact: true }).click();
  await expect(bar.getByTestId('pnf-replay-position')).toHaveText('FLAT');
  await expect(bar.getByTestId('pnf-replay-pnl')).toHaveText('+₹13');
  await expect(page.getByTestId('pnf-panel').first().locator('[data-testid="pnf-trade-marker"]')).toHaveCount(2);
  expect(blocked, 'practice trading never sends anything').toEqual([]);
});

/** /renko on the future, replay opened and started at `hhmm` on 30 Oct through Select date. */
async function replayFrom(page: Page, hhmm: string) {
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect.poll(() => bricks(page)).toBe(119);
  await page.getByRole('button', { name: 'Bar replay' }).click();
  const bar = page.getByTestId('pnf-replay-bar');
  await bar.getByRole('button', { name: 'More ways to choose the start' }).click();
  await page.getByRole('menuitem', { name: 'Select date…' }).click();
  await page.getByLabel('Replay start date').fill('2026-10-30');
  await page.getByLabel('Replay start time').fill(hhmm);
  await page.getByRole('button', { name: 'Start the replay at this time' }).click();
  return bar;
}

test('replay: play at 10x and pause, jump back to real time, continue the session after a reload', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked);
  const bar = await replayFrom(page, '10:00');
  await expect.poll(() => bricks(page)).toBe(44);

  // Play at 10x moves several bars; Pause stops it
  await bar.getByRole('button', { name: /Replay speed/ }).click();
  await page.getByRole('menuitemradio', { name: /^10x/ }).click();
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => bricks(page), { timeout: 5000 }).toBeGreaterThan(50);
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await bricks(page);
  await page.waitForTimeout(600);
  expect(await bricks(page)).toBe(paused);

  // Jump to real time: the live chart and the trade bar are back
  await bar.getByRole('button', { name: 'Jump to real-time chart' }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => bricks(page)).toBe(119);
  await expect(page.getByRole('group', { name: 'Execution mode' })).toBeVisible();

  // The session is remembered: after a reload, Replay offers to continue it
  await page.reload();
  await expect.poll(() => bricks(page)).toBe(119);
  await page.getByRole('button', { name: 'Bar replay' }).click();
  await expect(page.getByTestId('pnf-replay-bar').getByRole('button', { name: /^Continue/ })).toBeVisible();
  expect(blocked).toEqual([]);
});

test('replay: Select bar picks the clicked column as the start', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked);
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect.poll(() => bricks(page)).toBe(119);
  await page.getByRole('button', { name: 'Bar replay' }).click();
  const sc = page.getByTestId('pnf-panel').first().getByTestId('pnf-scroll');
  const box = (await sc.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByTestId('pnf-replay-pick-line')).toBeAttached();
  await page.mouse.down();
  await page.mouse.up();
  const clock = page.getByTestId('pnf-replay-bar').getByTestId('pnf-replay-clock');
  await expect(clock).toHaveText(/^30 Oct '26  \d\d:\d\d$/);
  const n = await bricks(page);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(119);
  expect(blocked).toEqual([]);
});

test('replay keeps the room dragged open right of the newest brick: steps do not slide it back under the rail', async ({ page }) => {
  const blocked: Call[] = [];
  await install(page, blocked);
  await page.goto('/renko');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect.poll(() => bricks(page)).toBe(119);
  await page.getByRole('button', { name: 'Bar replay' }).click();
  const bar = page.getByTestId('pnf-replay-bar');
  await bar.getByRole('button', { name: 'More ways to choose the start' }).click();
  await page.getByRole('menuitem', { name: 'Select date…' }).click();
  await page.getByLabel('Replay start date').fill('2026-10-30');
  await page.getByLabel('Replay start time').fill('10:00');
  await page.getByRole('button', { name: 'Start the replay at this time' }).click();
  await expect.poll(() => bricks(page)).toBe(44);

  const panel = page.getByTestId('pnf-panel').first();
  const newestRight = async () => { const g = (await panel.getByTestId('pnf-newest').boundingBox())!; return g.x + g.width; };
  const before = await newestRight();
  // Drag the chart 150 px to the left: room opens right of the newest brick
  const b = (await panel.getByTestId('pnf-scroll').boundingBox())!;
  const cx = b.x + b.width / 3, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 150, cy, { steps: 8 });
  await page.mouse.up();
  const dragged = await newestRight();
  expect(before - dragged).toBeGreaterThan(100);

  // Three steps = three new bricks; the chart follows them and keeps the room
  for (let i = 0; i < 3; i++) await bar.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect.poll(() => bricks(page)).toBe(47);
  await expect.poll(async () => Math.abs((await newestRight()) - dragged)).toBeLessThan(20);
  expect(blocked).toEqual([]);
});
