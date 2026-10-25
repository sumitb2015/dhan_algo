import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Straddle Simulator (/straddle-simulator): load a past range, replay it at 1X/50X/100X/200X through the live page's P&F engine.
// Every /api/* call is answered here; any non-GET this mock does not handle is refused with 599 and fails the test.
// The page is signals-only and places no orders, so there is no order route to mock.

const STRIKES = [24800, 25000, 25200];
const A = 100;
const BOX = A * 0.005;
const priceAt = (l: number) => A + l * BOX; // exactly on a box label

const epoch = (day: number, minute: number) => Date.UTC(2026, 9, day, 3, 45 + minute) / 1000; // Oct <day> 09:15 IST + minutes
const REPLAY_START = epoch(19, 0);

// Strike 25000: the preload day (Fri 16 Oct) already contains a double bottom and a double top; the replay day (Mon 19 Oct)
// then makes a NEW double top (step 2) and a NEW double bottom (step 4). Only those two may alert.
const PRELOAD = [0, 5, 2, 0, 3, 7, 4, -1];
const REPLAY = [3, 8, 5, -3];

function series(preload: number[], replay: number[]) {
  const mk = (day: number, levels: number[]) => levels.map((l, i) => {
    const s = priceAt(l);
    return { t: epoch(day, i), ce: s / 2, pe: s / 2, straddle: s, vol: 10 };
  });
  return [...mk(16, preload), ...mk(19, replay)];
}

const LOAD = {
  success: true, expiry: '2026-10-19', atm: 25000, strikes: STRIKES, preloadSession: '2026-10-16', sessions: ['2026-10-19'],
  replayStartT: REPLAY_START,
  bars: { '24800': series([0, 1], [1, 1, 1, 1]), '25000': series(PRELOAD, REPLAY), '25200': series([0, 1], [1, 1, 1, 1]) },
  coverage: { '24800': 6, '25000': 12, '25200': 6 },
  spotT: REPLAY.map((_, i) => epoch(19, i)), spotV: [25001.5, 25010, 25020.25, 24990],
};

interface Mock { loads: Call[]; blocked: Call[] }

async function install(page: Page, m: Mock) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/straddle-simulator' && method === 'GET') {
      if (u.searchParams.get('mode') === 'expiries') {
        return json(route, { success: true, expiries: [{ expiry: '2026-10-19', first: '2026-10-14', last: '2026-10-19' }] });
      }
      m.loads.push({ method, path: p, search: u.search, body: null });
      return json(route, LOAD);
    }
    if (method === 'GET') return json(route, { success: true });
    m.blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

async function load(page: Page) {
  await page.goto('/straddle-simulator');
  await expect(page.getByLabel('Expiry').locator('option').first()).toBeAttached();
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByTestId('sim-clock')).toContainText('minute 0 of 4');
}

test('loading shows three panels with the preload day already drawn, and no alert for it', async ({ page }) => {
  const m: Mock = { loads: [], blocked: [] };
  await install(page, m);
  await load(page);

  await expect(page.getByTestId('pnf-panel')).toHaveCount(3);
  const mid = page.locator('[data-testid="pnf-panel"][data-strike="25000"]');
  await expect(mid.locator('[data-testid="pnf-signal"]')).toHaveCount(2); // the preload's double top and double bottom are drawn
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);           // but never alerted
  await expect(page.getByTestId('sim-clock')).toContainText('Mon 19 Oct 09:15');
  expect(m.blocked).toEqual([]);
});

test('playing at 200X replays the bars and alerts once for each new double top / double bottom', async ({ page }) => {
  const m: Mock = { loads: [], blocked: [] };
  await install(page, m);
  await load(page);
  await page.getByRole('button', { name: '200X' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByRole('button', { name: 'Alert log' }).click();

  await expect(page.getByTestId('sim-clock')).toContainText('minute 4 of 4');
  const rows = page.getByTestId('pnf-log-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('DB sell'); // newest first: the double bottom (step 4) is on top
  await expect(rows.nth(1)).toContainText('DT buy');  // then the double top (step 2)
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();     // it stopped at the end
  await page.waitForTimeout(700);
  await expect(rows).toHaveCount(2);                                          // nothing re-fires
  expect(m.blocked).toEqual([]);
});

test('pause stops the replay, Reset goes back to minute 0 and clears the log', async ({ page }) => {
  await install(page, { loads: [], blocked: [] });
  await load(page);
  await page.getByRole('button', { name: '1X' }).click(); // slow: one bar a minute, so Pause is easy to catch
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  await expect(page.getByTestId('sim-clock')).toContainText('minute 0 of 4');

  await page.getByRole('button', { name: '200X' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('sim-clock')).toContainText('minute 4 of 4');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByTestId('sim-clock')).toContainText('minute 0 of 4');
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);
});

test('scrubbing forward skips alerts; scrubbing back and playing again alerts normally', async ({ page }) => {
  await install(page, { loads: [], blocked: [] });
  await load(page);
  await page.getByRole('button', { name: 'Alert log' }).click();
  await page.getByLabel('Replay position').fill('4');                     // jump to the end
  await expect(page.getByTestId('sim-clock')).toContainText('minute 4 of 4');
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);           // skipped bars never alert

  await page.getByLabel('Replay position').fill('0');
  await page.getByRole('button', { name: '200X' }).click();
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(2);           // a stale watermark from the jump must not hide them
});

test('a date that is not in the past is refused before any request is made', async ({ page }) => {
  const m: Mock = { loads: [], blocked: [] };
  await install(page, m);
  await page.goto('/straddle-simulator');
  await expect(page.getByLabel('Expiry').locator('option').first()).toBeAttached();
  await page.getByLabel('To', { exact: true }).fill('2099-01-01');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /before today/i })).toBeVisible(); // (Next's route announcer is also role=alert)
  expect(m.loads).toEqual([]);
});

test('SENSEX is listed but disabled: the store has no SENSEX option data', async ({ page }) => {
  await install(page, { loads: [], blocked: [] });
  await page.goto('/straddle-simulator');
  const sensex = page.getByLabel('Index', { exact: true }).locator('option', { hasText: 'SENSEX' });
  await expect(sensex).toHaveAttribute('disabled', ''); // (Playwright's toBeDisabled does not cover <option>)
  await expect(sensex).toContainText(/no data/i);
});

test('the charts fit the window and opening the alert log does not push them down', async ({ page }) => {
  await install(page, { loads: [], blocked: [] });
  await load(page);
  const panel = page.locator('[data-testid="pnf-panel"][data-strike="25000"]');
  const before = (await panel.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(before.y + before.height).toBeLessThanOrEqual(vh + 2);      // the whole panel is inside the window, nothing cut off below
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log')).toBeVisible();
  const after = (await panel.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);              // the log floats over the page instead of moving the charts
});
