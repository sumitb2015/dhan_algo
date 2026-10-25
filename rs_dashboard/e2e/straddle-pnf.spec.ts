import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Straddle P&F (/straddle-pnf): three straddle charts, expiry list, VWAP/SMA toggle, history-vs-live alerting, DATA chip.
// Every /api/* call is answered here; any non-GET this mock does not handle is refused with 599 and fails the test.
// The page places no orders, so there is no order route to mock.

const ATM = 25000;
const STRIKES = [ATM - 200, ATM, ATM + 200];
const A = 100; // first straddle price of every history series
const BOX = A * 0.005;
const priceAt = (l: number) => A + l * BOX; // exactly on a box label

// Level paths (see lib/straddlePnf.test.ts): X, O, X, O with a double bottom on the last bar / one short of it / quiet.
const PATH_WITH_BREAK = [0, 5, 2, 0, 3, 7, 4, -1];
const PATH_BEFORE_BREAK = [0, 5, 2, 0, 3, 7, 4];
const PATH_QUIET = [0, 1, 2];

const NOW_MIN = Math.floor(Date.now() / 60_000) * 60; // current minute, epoch seconds

interface Mock {
  /** 0 = no ticks yet, 1 = a tick in minute M (bar forming), 2 = a tick in minute M+1 (bar M closes). */
  phase: 0 | 1 | 2;
  blocked: Call[];
  /** Give the +200 strike a long, wide history (many columns) instead of the short quiet one. */
  longHistory?: boolean;
}

/** A deterministic wandering series: many columns over a wide price range. */
function longHistory() {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const start = NOW_MIN - 120 - 799 * 60;
  let level = 0;
  return Array.from({ length: 800 }, (_, i) => {
    level += Math.round((rnd() - 0.5) * 9);
    const s = i === 0 ? A : Math.max(10, priceAt(level));
    return { t: start + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 10 };
  });
}

function history(levels: number[]) {
  const start = NOW_MIN - 120 - (levels.length - 1) * 60; // last history bar is two minutes old: closed
  return levels.map((l, i) => {
    const s = priceAt(l);
    return { t: start + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 10 };
  });
}

function quotes(phase: Mock['phase']) {
  const updated = phase === 2 ? NOW_MIN + 65 : NOW_MIN + 5;
  const strikes: Record<string, unknown> = {};
  if (phase > 0) {
    for (const k of STRIKES) {
      const half = priceAt(-1) / 2; // every chart ticks at level -1
      strikes[String(k)] = { strike: k, ce: { ltp: half, oi: 1000, volume: 500 }, pe: { ltp: half, oi: 900, volume: 400 } };
    }
  }
  return {
    updated_at: new Date(updated * 1000).toISOString(), underlying: 'NIFTY', expiry: upcomingTuesdays(1)[0], spot: 25012.3, atm: ATM,
    straddle_premium: 190, strikes, future: { ltp: 25050.1 },
  };
}

function upcomingTuesdays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 2) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function install(page: Page, m: Mock) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();

    if (p === '/api/straddle-pnf' && method === 'GET') {
      return json(route, {
        success: true, atm: ATM, strikes: STRIKES, errors: {}, dataDate: '2026-10-23',
        bars: { [STRIKES[0]]: history(PATH_WITH_BREAK), [STRIKES[1]]: history(PATH_BEFORE_BREAK), [STRIKES[2]]: m.longHistory ? longHistory() : history(PATH_QUIET) },
      });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: upcomingTuesdays(10) });
    if (p === '/api/options/live' && method === 'GET') return json(route, { success: true, status: { status: 'RUNNING' }, quotes: quotes(m.phase) });
    if (p === '/api/options/live' && method === 'POST') return json(route, { success: true });
    if (method === 'GET') return json(route, { success: true });

    m.blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('three straddle panels sit side by side with the DATA chip, spot and future price', async ({ page }) => {
  const m: Mock = { phase: 1, blocked: [] };
  await install(page, m);
  await page.goto('/straddle-pnf');

  const panels = page.getByTestId('pnf-panel');
  await expect(panels).toHaveCount(3);
  const boxes = await Promise.all([0, 1, 2].map(i => panels.nth(i).boundingBox()));
  for (const b of boxes) expect(b).not.toBeNull();
  expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(4);
  expect(Math.abs(boxes[1]!.y - boxes[2]!.y)).toBeLessThan(4);
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width - 2);
  expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x + boxes[1]!.width - 2);
  await expect(panels.nth(0)).toHaveAttribute('data-strike', String(STRIKES[0]));
  await expect(panels.nth(1)).toHaveAttribute('data-strike', String(STRIKES[1]));

  await expect(page.getByText('DATA: 2026-10-23')).toBeVisible();
  await expect(page.getByTestId('pnf-spot')).toContainText('25,012.30');
  await expect(page.getByTestId('pnf-future')).toContainText('25,050.10');
  expect(m.blocked).toEqual([]);
});

test('the expiry dropdown offers at most four expiries', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const options = page.getByLabel('Expiry').locator('option');
  await expect(options.first()).toBeAttached();
  const n = await options.count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(4);
});

test('the VWAP / SMA toggle switches the overlay legend', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const legend = page.getByTestId('pnf-overlay-legend').first();
  await expect(legend).toHaveText(/VWAP/);
  await page.getByRole('button', { name: 'SMA 10' }).click();
  await expect(legend).toHaveText(/SMA 10/);
  await page.getByRole('button', { name: 'VWAP' }).click();
  await expect(legend).toHaveText(/VWAP/);
});

test('a double bottom in history is marked but never alerts; a live one alerts once', async ({ page }) => {
  const m: Mock = { phase: 0, blocked: [] };
  await install(page, m);
  await page.goto('/straddle-pnf');

  const first = page.locator('[data-testid="pnf-panel"][data-strike="24800"]');
  const mid = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(first.locator('[data-testid="pnf-signal"][data-kind="DOUBLE_BOTTOM_SELL"]')).toHaveCount(1);
  await expect(mid.locator('[data-testid="pnf-signal"]')).toHaveCount(1); // only the history double top buy
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);

  m.phase = 1; // bar M is forming: still nothing closed, still no alert
  await page.waitForTimeout(600);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);

  m.phase = 2; // minute M+1 arrives: bar M closes and breaks the ATM chart's first O bottom
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(1);
  await expect(page.getByTestId('pnf-log-row').first()).toContainText(String(ATM));
  await expect(mid.locator('[data-testid="pnf-signal"][data-kind="DOUBLE_BOTTOM_SELL"]')).toHaveCount(1);

  await page.waitForTimeout(600); // more polls of the same quote must not add a second entry
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(1);
  expect(m.blocked).toEqual([]);
});

test('the price axis sits at the right edge of each panel and the newest column is next to it, even with few columns', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(panel.getByTestId('pnf-axis')).toBeAttached();
  const p = (await panel.boundingBox())!;
  const axis = (await panel.getByTestId('pnf-axis').boundingBox())!;
  expect(p.x + p.width - (axis.x + axis.width)).toBeLessThan(24); // labels end at the panel's right edge
  const lastGlyph = panel.locator('svg path, svg circle').last();
  const g = (await lastGlyph.boundingBox())!;
  expect(axis.x - (g.x + g.width)).toBeLessThan(40);               // newest column hugs the axis, no empty gap
});

test('the chart shows a box grid', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`).getByTestId('pnf-grid')).toBeAttached();
});

test('a long history is never clipped: the chart scrolls, opens on the newest column, and the axis stays put while panning', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM + 200}"]`);
  const scroller = panel.getByTestId('pnf-scroll');
  await expect(scroller).toBeAttached();
  const dims = () => scroller.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  await expect.poll(async () => (await dims()).sw).toBeGreaterThan((await dims()).cw + 100); // wider than the view: nothing dropped
  const start = await dims();
  expect(start.sl + start.cw).toBeGreaterThanOrEqual(start.sw - 40);                          // opens at the newest column
  const before = (await panel.getByTestId('pnf-axis').boundingBox())!;
  await scroller.evaluate(el => { el.scrollLeft = 0; });
  expect((await dims()).sl).toBe(0);                                                          // the oldest columns are reachable
  const after = (await panel.getByTestId('pnf-axis').boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);                                       // the price axis did not move
});

test('each panel header shows the change versus the session open and the latest signal', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const sell = page.locator('[data-testid="pnf-panel"][data-strike="24800"]');   // history ends on a double bottom, 100.00 -> 99.50
  await expect(sell.getByTestId('pnf-vs-open')).toHaveText(/-0\.50 \(-0\.50%\) vs open/);
  await expect(sell.getByTestId('pnf-last-signal')).toContainText('DB sell');
  const buy = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);   // latest signal is a double top
  await expect(buy.getByTestId('pnf-last-signal')).toContainText('DT buy');
  const quiet = page.locator('[data-testid="pnf-panel"][data-strike="25200"]');  // no signal at all: no chip
  await expect(quiet.getByTestId('pnf-last-signal')).toHaveCount(0);
});
