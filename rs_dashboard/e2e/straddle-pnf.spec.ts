import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Point & Figure (/straddle-pnf): one price chart (index / stock / CRUDEOILM future), VWAP/SMA toggle, history-vs-new-bar alerting, DATA chip.
// There are no options on this page. Every /api/* call is answered here; any non-GET this mock does not handle is refused with 599 and fails the test.
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
  /** 0/1 = the history as loaded; 2 = a later refresh in which one more closed bar has broken the chart's first O bottom. */
  phase: 0 | 1 | 2;
  blocked: Call[];
  /** Give the ATM strike a long, wide history (many columns) instead of the short one. */
  longHistory?: boolean;
  /** Give the ATM strike a history at fixed IST times (Fri 23 Oct from 09:15) whose 1-minute chart has a double bottom that the 5-minute chart does not. */
  fixedHistory?: boolean;
}

// 12 minutes from 09:15 IST. 1-minute chart: double top at minute 5, double bottom at minute 7. 5-minute chart (closes at minutes 4 and 9): X 1..3 then a reversal, no signal.
const FIXED_LEVELS = [0, 5, 2, 0, 3, 7, 4, -1, -1, -1, -1, -1];
function fixedHistory() {
  const start = Date.UTC(2026, 9, 23, 3, 45) / 1000;
  return FIXED_LEVELS.map((l, i) => {
    const s = priceAt(l);
    return { t: start + i * 60, ce: s / 2, pe: s / 2, straddle: s, vol: 10 };
  });
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

/** Phase 2: one more CLOSED bar (a minute after the last one) that breaks the chart's first O bottom; the older bars keep their times. */
function withBreak(bars: ReturnType<typeof history>, on: boolean) {
  if (!on) return bars;
  const s = priceAt(-1);
  return [...bars, { t: bars[bars.length - 1].t + 60, ce: s, pe: 0, straddle: s, vol: 10 }];
}

async function install(page: Page, m: Mock) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();

    if (p === '/api/straddle-pnf' && method === 'GET') {
      // The page keys its one series by the first entry of `strikes`; this mock reuses the old ATM number so the locators stay stable.
      const series = m.fixedHistory ? fixedHistory() : m.longHistory ? longHistory() : withBreak(history(PATH_BEFORE_BREAK), m.phase >= 2);
      return json(route, { success: true, mode: 'price', atm: 0, strikes: [ATM], name: 'Nifty 50', errors: {}, dataDate: '2026-10-23', bars: { [ATM]: series } });
    }
    if (method === 'GET') return json(route, { success: true });

    m.blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('one price chart fills the page with the DATA chip and no options controls', async ({ page }) => {
  const m: Mock = { phase: 1, blocked: [] };
  await install(page, m);
  await page.goto('/straddle-pnf');

  const panels = page.getByTestId('pnf-panel');
  await expect(panels).toHaveCount(1);
  const box = (await panels.nth(0).boundingBox())!;
  expect(box.width).toBeGreaterThan(900);                       // the one chart takes the whole width
  await expect(page.getByText('DATA: 2026-10-23')).toBeVisible();
  await expect(page.getByLabel('Expiry')).toHaveCount(0);       // no options: no expiry, strikes, offsets or ATM
  await expect(page.getByLabel('ATM', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Strike offsets' })).toHaveCount(0);
  expect(m.blocked).toEqual([]);
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

test('a double bottom in history is marked but never alerts; a newly closed one alerts once', async ({ page }) => {
  const m: Mock = { phase: 0, blocked: [] };
  await page.clock.install();
  await install(page, m);
  await page.goto('/straddle-pnf');

  const mid = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(mid.locator('[data-testid="pnf-signal"]')).toHaveCount(1); // only the history double top buy
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);

  await page.clock.fastForward(31_000);       // a quiet refresh with nothing new: still no alert
  await page.waitForTimeout(300);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);

  m.phase = 2;                                // the next refresh has one more closed bar that breaks the first O bottom
  await page.clock.fastForward(31_000);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(1);
  await expect(mid.locator('[data-testid="pnf-signal"][data-kind="DOUBLE_BOTTOM_SELL"]')).toHaveCount(1);

  await page.clock.fastForward(31_000);       // another refresh of the same bars must not add a second entry
  await page.waitForTimeout(300);
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
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  const scroller = panel.getByTestId('pnf-scroll');
  await expect(scroller).toBeAttached();
  const dims = () => scroller.evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
  await expect.poll(async () => (await dims()).sw).toBeGreaterThan((await dims()).cw + 100); // wider than the view: nothing dropped
  const start = await dims();
  expect(start.sl + start.cw).toBeGreaterThanOrEqual(start.sw - start.cw / 2 - 40);            // opens at the newest column (half a view of drag room lies right of it)
  const before = (await panel.getByTestId('pnf-axis').boundingBox())!;
  await scroller.evaluate(el => { el.scrollLeft = 0; });
  expect((await dims()).sl).toBe(0);                                                          // the oldest columns are reachable
  const after = (await panel.getByTestId('pnf-axis').boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);                                       // the price axis did not move
});

test('the panel header shows the change versus the session open and the latest signal', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);   // latest signal is a double top
  await expect(page.getByTestId('pnf-vs-open')).toHaveText(/vs open/);
  await expect(page.getByTestId('pnf-last-signal')).toContainText('DT buy');
});

// ── interval and box size ─────────────────────────────────────────────────────
const cols = async (panel: ReturnType<Page['locator']>) => Number(((await panel.page().getByTestId('pnf-box-info').textContent()) ?? '').match(/(\d+) cols/)?.[1]);

test('the interval and box % controls default to 1 minute / 0.5% and say so in the header', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.getByLabel('Interval')).toHaveValue('1');
  await expect(page.getByLabel('Box %')).toHaveValue('0.5');
  await expect(page.getByText('1-min · 0.5% box · 3-box reversal')).toBeVisible();
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('(0.5% of');
});

test('changing the interval regroups the bars: fewer columns, and the header says 5-min', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(page.getByTestId('pnf-box-info')).toContainText('cols');
  const one = await cols(panel);
  await page.getByLabel('Interval').selectOption('15');
  await expect(page.getByText('15-min · 0.5% box · 3-box reversal')).toBeVisible();
  await expect.poll(async () => cols(panel)).toBeLessThan(one);
  await expect(page.getByLabel('Interval').locator('option')).toHaveText(['1 min', '3 min', '5 min', '15 min']);
});

test('the box % applies on Enter, an invalid entry is refused and reverts, and the header follows', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(page.getByTestId('pnf-box-info')).toContainText('cols');
  const boxOf = async () => Number(((await page.getByTestId('pnf-box-info').textContent()) ?? '').match(/Box ([\d.]+)/)?.[1]);
  const half = await boxOf();

  const input = page.getByLabel('Box %');
  await input.fill('1');
  await expect(page.getByTestId('pnf-box-info')).toContainText('(0.5% of');           // typing alone changes nothing
  await input.press('Enter');
  await expect(page.getByTestId('pnf-box-info')).toContainText('(1% of');
  expect(Math.abs((await boxOf()) / half - 2)).toBeLessThan(0.05);                      // twice the box
  await expect(page.getByText('1-min · 1% box · 3-box reversal')).toBeVisible();

  await input.fill('abc');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.blur();
  await expect(input).toHaveValue('1');                                                  // reverted to the last valid value
  await input.fill('99');
  await input.blur();
  await expect(input).toHaveValue('1');                                                  // out of range (0.05-5) is refused too
  await expect(page.getByTestId('pnf-box-info')).toContainText('(1% of');
});

test('the chosen interval and box % are remembered after a reload', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  // Wait until the page is live: the chart's header summary only exists after hydration, and a control changed before then is reset by it.
  await expect(page.getByTestId('pnf-header-summary')).toContainText('vs open');
  await page.getByLabel('Interval').selectOption('5');
  await page.getByLabel('Box %').fill('0.75');
  await page.getByLabel('Box %').press('Enter');
  await expect(page.getByText('5-min · 0.75% box · 3-box reversal')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Interval')).toHaveValue('5');
  await expect(page.getByLabel('Box %')).toHaveValue('0.75');
  await expect(page.getByText('5-min · 0.75% box · 3-box reversal')).toBeVisible();
});

test('changing the interval or the box % redraws the charts but never fires an alert for old signals', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], fixedHistory: true });
  await page.addInitScript(() => { try { localStorage.setItem('straddle-pnf-settings', JSON.stringify({ interval: 5, boxPct: 0.5 })); } catch { /* ignore */ } });
  await page.goto('/straddle-pnf');
  const mid = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(page.getByLabel('Interval')).toHaveValue('5');
  await expect(mid.locator('[data-testid="pnf-signal"]')).toHaveCount(0);               // the 5-minute chart has no signal ...
  await page.getByRole('button', { name: 'Alert log' }).click();
  await page.getByLabel('Interval').selectOption('1');
  await expect(mid.locator('[data-testid="pnf-signal"]')).toHaveCount(2);               // ... the 1-minute chart of the same data has two
  await page.waitForTimeout(500);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);                          // and neither alerted
  await page.getByLabel('Box %').fill('1');
  await page.getByLabel('Box %').press('Enter');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);
});

test('the charts fit the window even though the header wraps, and opening the alert log does not push them down', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('vs open');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  const before = (await panel.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(before.y + before.height).toBeLessThanOrEqual(vh + 2);      // nothing cut off below the window
  await page.getByRole('button', { name: 'Alert log' }).click();
  await expect(page.getByTestId('pnf-log')).toBeVisible();
  const after = (await panel.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);              // the log floats over the page instead of moving the charts
});

// ── reversal ──────────────────────────────────────────────────────────────────
test('the reversal control defaults to 3 boxes, changes how often columns turn, persists, and never alerts for old signals', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(page.getByTestId('pnf-box-info')).toContainText('cols');
  await expect(page.getByLabel('Reversal')).toHaveValue('3');
  await expect(page.getByLabel('Reversal').locator('option')).toHaveText(['1-box', '2-box', '3-box', '4-box', '5-box']);
  const three = await cols(panel);
  await page.getByRole('button', { name: 'Alert log' }).click();
  await page.getByLabel('Reversal').selectOption('2');
  await expect(page.getByText('1-min · 0.5% box · 2-box reversal')).toBeVisible();
  await expect(page.getByTestId('pnf-box-info')).toContainText('2-box');
  await expect.poll(async () => cols(panel)).toBeGreaterThan(three);   // a smaller reversal turns the column more often
  await page.waitForTimeout(400);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);        // redrawing never alerts
  await page.reload();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('vs open');
  await expect(page.getByLabel('Reversal')).toHaveValue('2');
});
