import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';

// Point & Figure (/straddle-pnf): one price chart (index / stock / future / option), VWAP/SMA toggle, history-vs-new-bar alerting, DATA chip.
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
  /** The WebSocket bridge's latest price (null = the bridge has not ticked). The page must show it, not the history's last close. */
  liveLtp?: number | null;
  /** Every `/api/straddle-pnf/live` request, to prove the page asks the bridge for the history's instrument. */
  liveCalls?: string[];
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
      return json(route, { success: true, mode: 'price', atm: 0, strikes: [ATM], name: 'Nifty 50', instrument: { segment: 'IDX_I', security_id: '13' }, errors: {}, dataDate: '2026-10-23', bars: { [ATM]: series } });
    }
    if (p === '/api/straddle-pnf/live' && method === 'GET') {
      m.liveCalls?.push(u.search);
      const q = m.liveLtp ? { ltp: m.liveLtp, changedMs: Date.now(), prevClose: null, volume: null } : null;
      return json(route, { success: true, bridge: true, hub: true, quote: q, last: null, legs: [{ quote: q, last: null }] });
    }
    if (p === '/api/straddle-pnf/contracts' && method === 'GET') {
      return json(route, { success: true, expiries: ['2026-11-24'] });
    }
    // The header's Nifty / India VIX chips: the bridge start (a POST, never an order) and the indices poll.
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/scalper/top-indices') {
      return json(route, { success: true, updated_at: new Date().toISOString(), quotes: { NIFTY: { ltp: 24123.45, change_pct: 0.42 }, VIX: { ltp: 13.21, change_pct: -1.5 } } });
    }
    if (method === 'GET') return json(route, { success: true });

    m.blocked.push({ method, path: p, search: u.search, body: null });
    return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
  });
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('dual chart view by default, can toggle to one chart and back', async ({ page }) => {
  const m: Mock = { phase: 1, blocked: [] };
  await install(page, m);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);

  // Default is 2 chart view
  const panels = page.getByTestId('pnf-panel');
  await expect(panels).toHaveCount(2);

  // First chart defaults to 0.1% box, second chart defaults to 1% box
  await expect(panels.nth(0)).toContainText('0.1% box');
  await expect(panels.nth(1)).toContainText('1% box');

  // Toggle to 1 Chart view
  await page.getByRole('button', { name: '1 Chart View' }).click();
  await expect(panels).toHaveCount(1);
  const box = (await panels.nth(0).boundingBox())!;
  expect(box.width).toBeGreaterThan(900); // single chart takes full width

  // Toggle back to 2 Charts view
  await page.getByRole('button', { name: '2 Charts View' }).click();
  await expect(panels).toHaveCount(2);

  await expect(page.getByText('DATA: 2026-10-23')).toBeVisible();
  await expect(page.getByLabel('Expiry')).toHaveCount(0); // no options: no expiry, strikes, offsets or ATM
  await expect(page.getByLabel('ATM', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Strike offsets' })).toHaveCount(0);
  expect(m.blocked).toEqual([]);
});

test('an index has no VWAP (no traded volume): the button is disabled and the box SMA is drawn', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');                                 // NIFTY index by default
  const legend = page.getByTestId('pnf-overlay-legend').first();
  await expect(legend).toHaveText(/SMA 50/);
  await expect(page.getByRole('button', { name: 'VWAP' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'SMA 50' })).toHaveAttribute('aria-pressed', 'true');
});

test('the VWAP / SMA toggle switches the overlay legend (a traded instrument), and the SMA period is configurable', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const legend = page.getByTestId('pnf-overlay-legend').first();
  await expect(legend).toHaveText(/SMA 50/);                        // hydrated on the NIFTY index
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();   // a future trades volume: VWAP is allowed
  await expect(page.getByRole('button', { name: 'VWAP' })).toBeEnabled();
  await expect(legend).toHaveText(/VWAP/);
  await page.getByRole('button', { name: 'SMA 50' }).click();      // the default period
  await expect(legend).toHaveText(/SMA 50/);
  const period = page.getByLabel('SMA period', { exact: true });
  await period.fill('2');                                           // typing alone changes nothing
  await expect(legend).toHaveText(/SMA 50/);
  await period.press('Enter');
  await expect(legend).toHaveText(/SMA 2/);
  await expect(page.getByRole('button', { name: 'SMA 2' })).toBeVisible();
  await period.fill('1');                                           // out of range: reverts on commit
  await period.blur();
  await expect(period).toHaveValue('2');
  await expect(page.getByRole('button', { name: 'Decrease SMA period' })).toBeDisabled();   // 2 is the minimum
  await period.fill('40');                                          // a half-typed draft is discarded by a step
  await page.getByRole('button', { name: 'Increase SMA period' }).click();
  await expect(period).toHaveValue('3');                            // stepped from the applied 2, not from 40
  await page.getByRole('button', { name: 'Decrease SMA period' }).click();
  await page.getByRole('button', { name: 'Increase SMA period' }).click();
  await expect(period).toHaveValue('3');
  await expect(legend).toHaveText(/SMA 3/);
  await page.getByRole('button', { name: 'Increase SMA period' }).click({ modifiers: ['Shift'] });
  await expect(period).toHaveValue('13');
  await page.getByRole('button', { name: 'Decrease SMA period' }).click();
  await expect(legend).toHaveText(/SMA 12/);
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
  expect(p.x + p.width - (axis.x + axis.width)).toBeLessThan(32); // labels (left-aligned in the 66px axis) end near the panel's right edge
  const lastGlyph = panel.getByTestId('pnf-newest');
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
  await expect(page.getByTestId('pnf-vs-open').first()).toHaveText(/vs (prev close|open)/);
  await expect(page.getByTestId('pnf-scrip').first()).toHaveText(/\S/); // the price is never shown without its scrip
  await expect(page.getByTestId('pnf-last-signal').first()).toContainText('DT buy');
});

test('the header price follows the WebSocket bridge, asked for the history\'s own instrument', async ({ page }) => {
  const m: Mock = { phase: 0, blocked: [], liveLtp: 105.75, liveCalls: [] };
  await install(page, m);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('105.75');
  expect(m.liveCalls?.[0]).toBe('?ids=IDX_I:13');
});

test('the header shows Nifty and India VIX with their % change from the indices bridge', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.locator('header')).toContainText('24,123.45');
  await expect(page.locator('header')).toContainText('13.21');
  await expect(page.locator('header')).toContainText('0.42');
});

// ── interval and box size ─────────────────────────────────────────────────────
const cols = async (panel: ReturnType<Page['locator']>) => Number(((await panel.getByTestId('pnf-box-info').textContent()) ?? '').match(/(\d+) cols/)?.[1]);

test('the interval and box % controls default to 1 minute / 0.1% and say so in the header', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.getByLabel('Interval')).toHaveValue('1');
  await expect(page.getByLabel('Box %')).toHaveValue('0.1');
  await expect(page.getByText(/1-min · 0.1% box/)).toBeVisible();
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('(0.1% of');
});

test('changing the interval regroups the bars: fewer columns, and the header says 5-min', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(panel.getByTestId('pnf-box-info')).toContainText('cols');
  const one = await cols(panel);
  await page.getByLabel('Interval').selectOption('15');
  await expect(page.getByText(/15-min · 0.1% box/)).toBeVisible();
  await expect.poll(async () => cols(panel)).toBeLessThan(one);
  await expect(page.getByLabel('Interval').locator('option')).toHaveText(['1 min', '3 min', '5 min', '15 min']);
});

test('the box % applies on Enter, an invalid entry is refused and reverts, and the header follows', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  await expect(panel.getByTestId('pnf-box-info')).toContainText('cols');
  const boxOf = async () => Number(((await panel.getByTestId('pnf-box-info').textContent()) ?? '').match(/Box ([\d.]+)/)?.[1]);
  const baseBox = await boxOf();

  const input = page.getByLabel('Box %');
  await input.fill('0.2');
  await expect(panel.getByTestId('pnf-box-info')).toContainText('(0.1% of');           // typing alone changes nothing
  await input.press('Enter');
  await expect(panel.getByTestId('pnf-box-info')).toContainText('(0.2% of');
  expect(Math.abs((await boxOf()) / baseBox - 2)).toBeLessThan(0.05);                      // twice the box
  await expect(page.getByText(/1-min · 0.2% box/)).toBeVisible();

  await input.fill('abc');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await input.blur();
  await expect(input).toHaveValue('0.2');                                                  // reverted to the last valid value
  await input.fill('99');
  await input.blur();
  await expect(input).toHaveValue('0.2');                                                  // out of range (0.05-5) is refused too
  await expect(panel.getByTestId('pnf-box-info')).toContainText('(0.2% of');
});

test('the chosen interval and box % are remembered after a reload', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  // Wait until the page is live: the chart's header summary only exists after hydration, and a control changed before then is reset by it.
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByLabel('Interval').selectOption('5');
  await page.getByLabel('Box %').fill('0.75');
  await page.getByLabel('Box %').press('Enter');
  await expect(page.getByText(/5-min · 0.75% box/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Interval')).toHaveValue('5');
  await expect(page.getByLabel('Box %')).toHaveValue('0.75');
  await expect(page.getByText(/5-min · 0.75% box/)).toBeVisible();
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
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
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
  await expect(panel.getByTestId('pnf-box-info')).toContainText('cols');
  await expect(page.getByLabel('Reversal')).toHaveValue('3');
  await expect(page.getByLabel('Reversal').locator('option')).toHaveText(['1-box', '2-box', '3-box', '4-box', '5-box']);
  // longHistory moves in 0.5% steps: at the 0.1% default every move is 5 boxes, so 2-box and 3-box draw the same columns
  await page.getByLabel('Box %').fill('0.5');
  await page.getByLabel('Box %').press('Enter');
  await expect(panel.getByTestId('pnf-box-info')).toContainText('3-box');
  const three = await cols(panel);
  await page.getByRole('button', { name: 'Alert log' }).click();
  await page.getByLabel('Reversal').selectOption('2');
  await expect(page.getByText(/2-box reversal/)).toBeVisible();
  await expect(panel.getByTestId('pnf-box-info')).toContainText('2-box');
  await expect.poll(async () => cols(panel)).toBeGreaterThan(three);   // a smaller reversal turns the column more often
  await page.waitForTimeout(400);
  await expect(page.getByTestId('pnf-log-row')).toHaveCount(0);        // redrawing never alerts
  await page.reload();
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await expect(page.getByLabel('Reversal')).toHaveValue('2');
});

test('the chart has a crosshair: lines snapped to the column and box under the pointer, a price tag and a column readout', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  const sc = panel.getByTestId('pnf-scroll');
  await expect(sc).toHaveClass(/cursor-crosshair/);
  const glyph = panel.getByTestId('pnf-newest');
  const g = (await glyph.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await expect(panel.getByTestId('pnf-crosshair')).toBeAttached();
  await expect(panel.getByTestId('pnf-crosshair-price')).toBeAttached();
  await expect(panel.getByTestId('pnf-crosshair-readout')).toContainText(/box/);
  await page.mouse.move(5, 5);                                       // off the chart
  await expect(panel.getByTestId('pnf-crosshair')).toHaveCount(0);
});

test('the box can be set in points: the unit toggle swaps the input, Enter applies it, and % mode keeps its own value', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Box unit' }).getByRole('button', { name: 'pts' }).click();
  const pts = page.getByLabel('Box points');
  await expect(pts).toHaveValue('10');                                            // the default points value
  await pts.fill('2');
  await expect(page.getByTestId('pnf-box-info').first()).not.toContainText('Box 2.00');  // typing alone changes nothing
  await pts.press('Enter');
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('Box 2.00 (points)');
  await expect(page.getByText(/1-min · 2-pt box/)).toBeVisible();
  await pts.fill('-3');                                                           // invalid: reverts on commit
  await pts.blur();
  await expect(pts).toHaveValue('2');
  await page.getByRole('group', { name: 'Box unit' }).getByRole('button', { name: '%' }).click();
  await expect(page.getByLabel('Box %')).toHaveValue('0.1');
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('(0.1% of');
  await page.reload();                                                            // both values and the mode persist
  await expect(page.getByLabel('Box %')).toHaveValue('0.1');
  await page.getByRole('group', { name: 'Box unit' }).getByRole('button', { name: 'pts' }).click();
  await expect(page.getByLabel('Box points')).toHaveValue('2');
});

test('the box − / + buttons step to the next round size and apply at once, in either unit', async ({ page }) => {
  await install(page, { phase: 0, blocked: [] });
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('button', { name: 'Increase box size' }).click();
  await expect(page.getByLabel('Box %')).toHaveValue('0.15');
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('(0.15% of');
  await page.getByRole('button', { name: 'Decrease box size' }).click();
  await page.getByRole('button', { name: 'Decrease box size' }).click();
  await expect(page.getByLabel('Box %')).toHaveValue('0.05');
  await page.getByRole('group', { name: 'Box unit' }).getByRole('button', { name: 'pts' }).click();
  await page.getByLabel('Box points').fill('37');                                 // a half-typed draft is discarded by a step
  await page.getByRole('button', { name: 'Increase box size' }).click();
  await expect(page.getByLabel('Box points')).toHaveValue('20');                   // stepped from the applied 10, not from 37
  await expect(page.getByTestId('pnf-box-info').first()).toContainText('Box 20.00 (points)');
});

test('the session names stay at the top of the chart while it is scrolled down', async ({ page }) => {
  await install(page, { phase: 0, blocked: [], longHistory: true });
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${ATM}"]`);
  const scroller = panel.getByTestId('pnf-scroll');
  await expect(scroller).toBeAttached();
  const strip = panel.getByTestId('pnf-session-strip');
  await expect(strip).toBeAttached();
  const labels = strip.locator('text');
  await expect.poll(async () => labels.count()).toBeGreaterThan(0);
  // wherever the chart is scrolled vertically, the strip stays at the top edge of the view
  const top = async () => (await strip.boundingBox())!.y - (await scroller.boundingBox())!.y;
  const t0 = await top();
  const room = await scroller.evaluate(el => el.scrollHeight - el.clientHeight);
  if (room > 40) {
    await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(Math.abs((await top()) - t0)).toBeLessThan(2);
  }
  expect(Math.abs(t0)).toBeLessThan(2);
});
