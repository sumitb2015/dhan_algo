import { test, expect, type Page } from '@playwright/test';
import { json, signIn } from './support';

// Point & Figure (/straddle-pnf): chart controls (drag pan, wheel zoom, Re-center) and the Index | Equity | Futures | Options picker.
const KEY = 25000;
const NOW_MIN = Math.floor(Date.now() / 60_000) * 60;
const series = (base: number, step = 0.5) => [0, 5, 2, 0, 3, 7, 4].map((l, i, a) => {
  const s = base + l * step;
  return { t: NOW_MIN - 120 - (a.length - 1 - i) * 60, ce: s, pe: 0, straddle: s, vol: 10 };
});

test.beforeEach(async ({ context }) => { await signIn(context); });

/** Answers every /api call; `seen` collects the history queries so a test can check what the page asked for. */
async function mockApi(page: Page, seen: string[] = []) {
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/straddle-pnf/search') {
      const q = (u.searchParams.get('q') ?? '').toUpperCase();
      const seg = u.searchParams.get('segment');
      if (seg === 'futures' || seg === 'options') {
        return json(route, { success: true, results: [q.startsWith('NOP') ? { kind: seg, symbol: 'NOPE', name: 'NSE stock' } : { kind: seg, symbol: 'CRUDEOILM', name: 'MCX commodity' }] });
      }
      if (q.startsWith('ZER')) return json(route, { success: true, results: [{ kind: 'equity', symbol: 'ZEROVOL', name: 'ZERO VOLUME LTD' }] });
      return json(route, { success: true, results: q.startsWith('REL') ? [{ kind: 'equity', symbol: 'RELIANCE', name: 'RELIANCE INDUSTRIES LIMITED' }] : [] });
    }
    if (u.pathname === '/api/straddle-pnf/contracts') {
      seen.push(`contracts?${u.searchParams}`);
      const crude = u.searchParams.get('underlying') === 'CRUDEOILM';
      if (u.searchParams.get('underlying') === 'NOPE') return json(route, { success: false, error: 'NOPE has no live futures' }, 404);
      if (u.searchParams.get('kind') === 'options' && u.searchParams.get('expiry') === '2026-11-10') {
        return json(route, { success: true, expiries: ['2026-11-03', '2026-11-10'], expiry: '2026-11-10', strikes: [22800, 23100, 23400], spot: 23390, atm: 23400 });
      }
      if (u.searchParams.get('kind') === 'futures') return json(route, { success: true, expiries: crude ? ['2026-11-19', '2026-12-17'] : ['2026-11-24', '2026-12-29'] });
      return json(route, { success: true, expiries: ['2026-11-03', '2026-11-10'], expiry: u.searchParams.get('expiry') ?? '2026-11-03', strikes: [22900, 22950, 23000, 23050, 23100], spot: 23010, atm: 23000 });
    }
    if (u.pathname === '/api/straddle-pnf') {
      seen.push(u.search);
      if (u.searchParams.get('mode') === 'contract') {
        const straddle = u.searchParams.get('type') === 'STRADDLE';
        const name = u.searchParams.get('kind') === 'futures' ? `${u.searchParams.get('underlying')} NOV FUT` : 'NIFTY 03 NOV 23000 CALL';
        const bars = series(straddle ? 300 : 150, 2).map(b => (straddle ? { ...b, ce: b.straddle / 2, pe: b.straddle / 2 } : b));
        return json(route, { success: true, atm: 0, strikes: [KEY], name, errors: {}, dataDate: '2026-10-23', bars: { [KEY]: bars },
          instruments: straddle ? [{ segment: 'NSE_FNO', security_id: '1' }, { segment: 'NSE_FNO', security_id: '2' }] : [{ segment: 'NSE_FNO', security_id: '1' }] });
      }
      if (u.searchParams.get('symbol') === 'ZEROVOL') {
        return json(route, { success: true, mode: 'price', atm: 0, strikes: [0], name: 'ZERO VOLUME LTD', errors: {}, dataDate: '2026-10-23', bars: { 0: series(500, 2).map(b => ({ ...b, vol: 0 })) } });
      }
      if (u.searchParams.get('symbol') === 'RELIANCE') {
        return json(route, { success: true, mode: 'price', atm: 0, strikes: [0], name: 'RELIANCE INDUSTRIES LIMITED', errors: {}, dataDate: '2026-10-23', bars: { 0: series(1200, 2) } });
      }
      return json(route, { success: true, mode: 'price', atm: 0, strikes: [KEY], name: 'Nifty 50', errors: {}, dataDate: '2026-10-23', bars: { [KEY]: series(100) } });
    }
    // The header's Nifty / India VIX chips: the bridge start (a POST, never an order) and the indices poll.
    if (u.pathname === '/api/live-indices' && route.request().method() === 'POST') return json(route, { success: true });
    if (u.pathname === '/api/scalper/top-indices') {
      return json(route, { success: true, updated_at: new Date().toISOString(), quotes: { NIFTY: { ltp: 24123.45, change_pct: 0.42 }, VIX: { ltp: 13.21, change_pct: -1.5 } } });
    }
    if (route.request().method() === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: 'blocked' });
  });
}

test('drag pans and wheel zooms a chart that fits the panel', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${KEY}"]`);
  const sc = panel.getByTestId('pnf-scroll');
  await expect(panel.getByTestId('pnf-grid')).toBeAttached();
  const pos = () => sc.evaluate(el => ({ l: el.scrollLeft, t: el.scrollTop, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight }));
  const p0 = await pos();
  expect(p0.sw).toBeGreaterThan(p0.cw);
  expect(p0.sh).toBeGreaterThan(p0.ch);

  const b = (await sc.boundingBox())!;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 8 });
  await page.mouse.up();
  const p1 = await pos();
  expect(p1.l).toBeLessThan(p0.l - 50);
  expect(p1.t).not.toBe(p0.t);

  // Drag the chart to the left, away from the price axis: the newest column must be able to leave the right margin.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 300, cy, { steps: 8 });
  await page.mouse.up();
  const p2 = await pos();
  expect(p2.l).toBeGreaterThan(p0.l + 50);            // past the position where the newest column touches the axis

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await expect(panel.getByTestId('pnf-zoom')).not.toHaveAttribute('data-zoom', '1');
  await panel.getByRole('button', { name: 'Fit chart to panel' }).click();
  await expect(panel.getByTestId('pnf-zoom')).toHaveAttribute('data-zoom', '1');
});

test('the Futures segment charts the near-month future, and the search box switches the underlying', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);   // hydrated: a click before that is lost
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');                              // the nearest expiry is filled in
  await expect.poll(() => seen.some(s => s.includes('mode=contract') && s.includes('kind=futures') && s.includes('underlying=NIFTY') && s.includes('expiry=2026-11-24'))).toBe(true);
  await page.getByRole('combobox', { name: 'Search futures underlying' }).fill('cru');
  await page.getByRole('option', { name: /CRUDEOILM/ }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-19');
  await expect.poll(() => seen.some(s => s.includes('kind=futures') && s.includes('underlying=CRUDEOILM') && s.includes('expiry=2026-11-19'))).toBe(true);
  await expect(page.getByTestId('pnf-header-summary')).not.toContainText('CE ');
  await expect(page.getByLabel('Strike price')).toHaveCount(0);
});

test('the Options segment picks the nearest expiry and ATM, steps the strike and switches CE / PE / CE+PE', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' }).click();
  const strike = page.getByLabel('Strike price');
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-03');
  await expect(strike).toHaveValue('23000');                                                       // ATM
  await expect(page.getByRole('button', { name: 'CE', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => seen.some(s => s.includes('kind=options') && s.includes('strike=23000') && s.includes('type=CE'))).toBe(true);
  await page.getByRole('button', { name: 'Higher strike' }).click();
  await expect(strike).toHaveValue('23050');
  await expect.poll(() => seen.some(s => s.includes('strike=23050') && s.includes('type=CE'))).toBe(true);
  await page.getByRole('button', { name: 'CE+PE' }).click();
  await expect.poll(() => seen.some(s => s.includes('strike=23050') && s.includes('type=STRADDLE'))).toBe(true);
  await expect(page.getByTestId('pnf-header-summary')).toContainText('CE ');                      // a straddle shows both legs
  await expect(page.getByTestId('pnf-header-summary')).toContainText('PE ');
  await page.reload();                                                                             // the pick is remembered
  await expect(page.getByLabel('Strike price')).toHaveValue('23050');
  await expect(page.getByRole('button', { name: 'CE+PE' })).toHaveAttribute('aria-pressed', 'true');
});

test('Re-center resets zoom and puts the newest column in the middle of the chart', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  const panel = page.locator(`[data-testid="pnf-panel"][data-strike="${KEY}"]`);
  const sc = panel.getByTestId('pnf-scroll');
  await expect(panel.getByTestId('pnf-grid')).toBeAttached();
  const b = (await sc.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -300);                                           // zoom in…
  await expect(panel.getByTestId('pnf-zoom')).not.toHaveAttribute('data-zoom', '1');
  await page.mouse.down(); await page.mouse.move(b.x + 100, b.y + 100, { steps: 6 }); await page.mouse.up();   // …and pan away
  await page.getByRole('button', { name: 'Re-center' }).click();
  await expect(panel.getByTestId('pnf-zoom')).toHaveAttribute('data-zoom', '1');
  // the newest glyph now sits near the horizontal middle of the plot (the view minus the pinned axis)
  await expect.poll(async () => {
    const g = (await panel.getByTestId('pnf-newest').boundingBox())!;
    return Math.abs(g.x + g.width / 2 - (b.x + (b.width - 66) / 2));   // 66 = AXIS_W
  }).toBeLessThan(30);
});

test('the Equity segment charts a stock by its plain price, and Index goes back to NIFTY', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Equity' }).click();
  await page.getByRole('combobox', { name: 'Search stock' }).fill('rel');
  await page.getByRole('option', { name: /RELIANCE/ }).click();
  await expect(page.getByText('RELIANCE INDUSTRIES LIMITED').first()).toBeVisible();
  await expect(page.getByTestId('pnf-panel')).toHaveCount(1);
  expect(seen.some(s => s.includes('mode=price') && s.includes('kind=equity') && s.includes('symbol=RELIANCE'))).toBe(true);
  await page.reload();                                                         // the pick is remembered
  await expect(page.getByText('RELIANCE INDUSTRIES LIMITED').first()).toBeVisible();
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Index' }).click();
  await expect(page.getByText('Nifty 50').first()).toBeVisible();
});

test('at 1280px the header stays tidy with the Options pickers open: no sideways scroll, and the chart keeps most of the height', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApi(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Strike price')).toHaveValue('23000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const header = (await page.locator('header').first().boundingBox())!;
  expect(header.height).toBeLessThan(240);   // 220 + the Nifty / VIX chips, which take a line of their own while the Options pickers fill this width
  const chart = (await page.getByTestId('pnf-scroll').boundingBox())!;
  expect(chart.height).toBeGreaterThan(450);
});

test('changing an option expiry keeps the nearest listed strike (not ATM) and never asks for the old strike on the new expiry', async ({ page }) => {
  const seen: string[] = [];
  await mockApi(page, seen);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' }).click();
  await expect(page.getByLabel('Strike price')).toHaveValue('23000');
  await page.getByRole('button', { name: 'Higher strike' }).click();
  await expect(page.getByLabel('Strike price')).toHaveValue('23050');
  await page.getByLabel('Expiry').selectOption('2026-11-10');                    // lists 22,800 / 23,100 / 23,400 (ATM 23,400)
  await expect(page.getByLabel('Strike price')).toHaveValue('23100');            // nearest to 23,050
  await expect.poll(() => seen.some(s => s.includes('expiry=2026-11-10') && s.includes('strike=23100'))).toBe(true);
  expect(seen.some(s => s.includes('mode=contract') && s.includes('expiry=2026-11-10') && s.includes('strike=23050'))).toBe(false);
});

test('a failed contract lookup shows its error in the chart (no endless Loading), and it clears on another segment', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await page.getByRole('combobox', { name: 'Search futures underlying' }).fill('nop');
  await page.getByRole('option', { name: /NOPE/ }).click();
  await expect(page.getByTestId('pnf-instrument-bar').getByRole('alert')).toHaveText('NOPE has no live futures');
  await expect(page.getByTestId('pnf-scroll')).toContainText('NOPE has no live futures');
  await expect(page.getByTestId('pnf-scroll')).not.toContainText('Loading');
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Index' }).click();
  await expect(page.getByTestId('pnf-instrument-bar').getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
});

test('a stock whose bars carry no volume gets the box SMA and a disabled VWAP button (the toggle never contradicts the chart)', async ({ page }) => {
  await mockApi(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Equity' }).click();
  await page.getByRole('combobox', { name: 'Search stock' }).fill('zer');
  await page.getByRole('option', { name: /ZEROVOL/ }).click();
  await expect(page.getByText('ZERO VOLUME LTD').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'VWAP' })).toBeDisabled();
  await expect(page.getByTestId('pnf-overlay-legend').first()).toHaveText(/SMA/);
});
