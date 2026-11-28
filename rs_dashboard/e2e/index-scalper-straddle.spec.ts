import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { installSessionClock, moveSessionClock, sessionIso, SESSION_START_MS } from './isxClock';

// /index-scalper's Straddle pane: CE + PE premium chart of one strike (ATM by default), one-click Sell / Buy straddle and
// the straddle's exit rules. Every /api/* call is mocked in the browser: no Dhan session, and no order can reach a broker
// (any non-GET the mock does not handle is refused with 599).

interface Call { path: string; body: Record<string, unknown> | null }
interface State { calls: Call[]; blocked: Call[]; candleReqs: string[]; positions: Record<string, unknown>[]; peFails?: boolean }
const SPOT = 25350;
const STRIKES = Array.from({ length: 21 }, (_, i) => 24850 + i * 50);
const idsOf = (k: number): [string, string] => [`1${k}`, `2${k}`];
const CE = 210.5, PE = 229.95; // ATM 25350: straddle 440.45

// 5-minute straddle bars up to the session clock's 10:30 (the last one ends exactly at "now"), around 400
// with volume, so the VWAP sits near 400 and the live 440.45 is far above it.
function straddleBars() {
  // 30 bars: enough for EMA 20 (the first ones fall on the previous session, as a real 10-day backfill would)
  const start = SESSION_START_MS / 1000 - 150 * 60;
  return Array.from({ length: 30 }, (_, i) => {
    const c = 400 + (i % 2 ? 3 : -3);
    return { t: start + i * 300, o: 400, h: c + 4, l: c - 4, c, v: 5000 };
  });
}

async function mockApi(page: Page, state: State) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    if (p === '/api/index-scalper/candles') {
      state.candleReqs.push(u.search);
      const kind = u.searchParams.get('kind');
      if (kind === 'straddle') return json(route, { success: true, candles: straddleBars(), interval: u.searchParams.get('interval') });
      const start = SESSION_START_MS / 1000 - 75 * 60;
      return json(route, { success: true, interval: u.searchParams.get('interval'), candles: Array.from({ length: 15 }, (_, i) => ({ t: start + i * 300, o: SPOT, h: SPOT + 10, l: SPOT - 10, c: SPOT + (i % 2 ? 5 : -5) })) });
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-12-01'] });
    if (p === '/api/scalper/lookup') {
      const strikes = Object.fromEntries(STRIKES.map(k => { const [ce, pe] = idsOf(k); return [String(k), { ceId: ce, peId: pe }]; }));
      return json(route, { success: true, data: { lotSize: 65, strikes, future: { securityId: '58875', expiry: '2026-12-29' } } });
    }
    if (p === '/api/options/live') {
      if (method === 'POST') return json(route, { success: true });
      // 25450: listed in the expiry but outside the bridge's live window (no ticks)
      const strikes = Object.fromEntries(STRIKES.filter(k => k !== 25450).map(k => [String(k), {
        strike: k,
        ce: { ltp: k === SPOT ? CE : 100 + (SPOT - k) / 2, volume: 100_000, oi: 1_000_000, prev_oi: 900_000, oi_chg_pct: 11 },
        pe: { ltp: k === SPOT ? PE : 100 + (k - SPOT) / 2, volume: 120_000, oi: 1_000_000, prev_oi: 900_000, oi_chg_pct: 11 },
      }]));
      return json(route, { success: true, status: { status: 'RUNNING' }, quotes: { underlying: 'NIFTY', expiry: '2026-12-01', spot: SPOT, atm: SPOT, updated_at: sessionIso(), strikes, future: { ltp: SPOT + 110, expiry: '2026-12-29', volume: 2_000_000 } } });
    }
    if (p === '/api/options/chain') return json(route, { success: false, error: 'e2e: no chain' }, 502);
    if (p === '/api/options/margin') return json(route, { success: true, data: { total_margin: 100000 } });
    if (p === '/api/scalper/funds') return json(route, { success: true, data: { availabelBalance: 4684089.17, utilizedAmount: 0 } });
    if (p === '/api/scalper/positions') return json(route, { success: true, data: state.positions });
    if (p === '/api/scalper/orders' && method === 'GET') return json(route, { success: true, data: [] });
    if (p === '/api/index-scalper/tick') return json(route, { success: true, tick: 0.05 });
    if (p === '/api/index-scalper/lots') return json(route, { success: true, lots: Object.fromEntries((u.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(id => [id, 65])) });
    if (p === '/api/index-scalper/holdings') return json(route, { success: true, data: [] });
    if (p === '/api/scalper/fast-order') {
      state.calls.push({ path: p, body });
      const isPe = body?.securityId === idsOf(SPOT)[1];
      if (isPe && state.peFails) return json(route, { success: false, error: 'RMS: margin shortfall' });
      return json(route, { success: true, order_id: isPe ? '8002' : '8001' });
    }
    if (method !== 'GET') {
      state.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

const newState = (): State => ({ calls: [], blocked: [], candleReqs: [], positions: [] });
// Default per-leg target / stop off; the straddle's VWAP exit on, its time exit off (the session clock is 10:30).
const seed = (page: Page, lines: { vwap: boolean; ema: boolean } = { vwap: true, ema: false }) => page.addInitScript(l => {
  try {
    localStorage.setItem('indexScalper.defaultBrackets.v1', JSON.stringify({ on: false, tpPct: 30, slPct: 20 }));
    // no indicators of the viewer's own: the straddle pane's VWAP / EMA lines come from its exit rules
    localStorage.setItem('indexScalper.indicators.v2', '[]');
    localStorage.setItem('indexScalper.structureIndicatorAdded', '1');
    localStorage.setItem('indexScalper.dayLevelsIndicatorAdded', '1');
    localStorage.setItem('indexScalper.volumeIndicatorAdded', '1');
    localStorage.setItem('indexScalper.straddleRules.v1', JSON.stringify({ targetPct: 30, slPct: 20, vwap: { on: l.vwap, bufferPts: 0 }, ema: { on: l.ema, len: 20, bufferPts: 0 }, slToCost: { on: false, triggerPct: 15 }, timeExit: { on: false, hhmm: '15:17' } }));
  } catch { /* private mode */ }
}, lines);

async function openStraddlePane(page: Page) {
  await page.goto('/index-scalper', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chart-pane-0')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Two charts side by side' }).click();
  const right = page.getByTestId('chart-pane-1');
  await right.getByRole('button', { name: 'STR' }).click();
  await expect(right).toContainText('NIFTY 25350 STRADDLE', { timeout: 30_000 });
  return right;
}

test.describe('Index Scalper Straddle pane', () => {
  test.beforeEach(async ({ page }) => { await installSessionClock(page); });

  test('the pane plots the ATM straddle, follows a strike change, and asks for both legs\' candles', async ({ page, context }) => {
    const state = newState();
    await seed(page);
    await signIn(context);
    await mockApi(page, state);
    const right = await openStraddlePane(page);
    await expect(right.getByLabel('Chart 2 strike')).toHaveValue('25350');
    await expect.poll(() => state.candleReqs.find(q => q.includes('kind=straddle'))).toContain('ceId=125350&peId=225350');
    await expect(right.getByTestId('straddle-controls')).toContainText('440.45');
    await right.getByLabel('Chart 2 strike').selectOption('25400');
    await expect(right).toContainText('NIFTY 25400 STRADDLE');
    await expect.poll(() => state.candleReqs.some(q => q.includes('ceId=125400&peId=225400'))).toBe(true);
    await expect(right.getByTestId('straddle-sell')).toBeEnabled();
    // a strike with no live ticks: Sell / Buy are greyed out (not a click that is then refused)
    await right.getByLabel('Chart 2 strike').selectOption('25450');
    await expect(right).toContainText('NIFTY 25450 STRADDLE');
    await expect(right.getByTestId('straddle-sell')).toBeDisabled();
    await expect(right.getByTestId('straddle-buy')).toBeDisabled();
    await expect(right.getByTestId('straddle-sell')).toHaveAttribute('title', /No live price/);
    await right.getByLabel('Chart 2 strike').selectOption('25400');
    // a reload keeps the straddle pane (a picked strike is kept)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chart-pane-1')).toContainText('NIFTY 25400 STRADDLE', { timeout: 60_000 });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('SIM: Sell straddle opens both legs as one straddle; a candle closing above VWAP exits it once', async ({ page, context }) => {
    const state = newState();
    await seed(page);
    await signIn(context);
    await mockApi(page, state);
    const right = await openStraddlePane(page);
    const ctl = right.getByTestId('straddle-controls');
    await expect(ctl.getByTestId('straddle-sell')).toBeEnabled({ timeout: 30_000 });
    await ctl.getByTestId('straddle-sell').click();
    await expect(ctl.getByTestId('straddle-open')).toContainText('SHORT 1L', { timeout: 15_000 });
    await expect(ctl.getByTestId('straddle-pnl')).toContainText('₹0');
    // the candle that was already closed at entry (10:25-10:30) is not a signal: still open
    await page.waitForTimeout(1500);
    await expect(ctl.getByTestId('straddle-open')).toBeVisible();
    if (process.env.ISX_SHOT) await right.screenshot({ path: process.env.ISX_SHOT });
    // 6 minutes on: the 10:30 candle (built from the live 440.45 ticks) closed above the ~400 VWAP -> exit
    await moveSessionClock(page, SESSION_START_MS + 6 * 60_000);
    await expect(ctl.getByTestId('straddle-open')).toHaveCount(0, { timeout: 20_000 });
    await expect(ctl.getByTestId('straddle-sell')).toBeEnabled();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('indexScalper.straddles.v1') ?? '[]'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'CLOSED', closeReason: 'VWAP', side: 'S', mode: 'SIM' });
    // paper only: nothing reached an order route
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });

  test('REAL: both legs go out as isx market sells; a rejected leg shows ONE LEG and nothing is resent', async ({ page, context }) => {
    const state = newState();
    state.peFails = true;
    await seed(page);
    await signIn(context);
    await mockApi(page, state);
    const right = await openStraddlePane(page);
    await page.getByRole('button', { name: 'REAL', exact: true }).click();
    await page.getByRole('button', { name: 'Arm REAL' }).click();
    const ctl = right.getByTestId('straddle-controls');
    await expect(ctl).toContainText('REAL');
    await expect(ctl.getByTestId('straddle-sell')).toBeEnabled({ timeout: 30_000 });
    await ctl.getByTestId('straddle-sell').click();
    const orders = () => state.calls.filter(c => c.path === '/api/scalper/fast-order');
    await expect.poll(() => orders().length, { timeout: 15_000 }).toBe(2);
    for (const o of orders()) expect(o.body).toMatchObject({ side: 'SELL', orderType: 'MARKET', quantity: 65, source: 'isx' });
    expect(orders().map(o => o.body?.securityId).sort()).toEqual(['125350', '225350']);
    await expect(ctl.getByTestId('straddle-one-leg')).toContainText('ONE LEG', { timeout: 15_000 });
    // no retry of the rejected leg, and the rules do not exit a half straddle on their own
    await page.waitForTimeout(3000);
    expect(orders()).toHaveLength(2);
    expect(state.blocked).toEqual([]);
  });

  test('the straddle chart draws the VWAP and EMA its exit rules use; EMA only: a close above the EMA exits', async ({ page, context }) => {
    const state = newState();
    await seed(page, { vwap: false, ema: true });
    await signIn(context);
    await mockApi(page, state);
    const right = await openStraddlePane(page);
    const ctl = right.getByTestId('straddle-controls');
    // EMA rule on, VWAP off: the chart shows EMA (20) and no VWAP
    await right.getByTestId('indicator-list-toggle').click();
    await expect(right.getByTestId('indicator-list')).toContainText('EMA (20)');
    await expect(right.getByTestId('indicator-list')).not.toContainText('VWAP');
    // switching VWAP on draws it too
    await ctl.getByRole('switch', { name: 'Exit on VWAP close' }).click();
    await expect(right.getByTestId('indicator-list')).toContainText('VWAP');
    await ctl.getByRole('switch', { name: 'Exit on VWAP close' }).click();
    await expect(right.getByTestId('indicator-list')).not.toContainText('VWAP');
    if (process.env.ISX_SHOT2) await right.screenshot({ path: process.env.ISX_SHOT2 });

    await expect(ctl.getByTestId('straddle-sell')).toBeEnabled({ timeout: 30_000 });
    await ctl.getByTestId('straddle-sell').click();
    await expect(ctl.getByTestId('straddle-open')).toContainText('SHORT 1L', { timeout: 15_000 });
    await expect(ctl.getByTestId('straddle-ema')).not.toHaveText('—');
    await moveSessionClock(page, SESSION_START_MS + 6 * 60_000);
    await expect(ctl.getByTestId('straddle-open')).toHaveCount(0, { timeout: 20_000 });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('indexScalper.straddles.v1') ?? '[]'));
    expect(stored[0]).toMatchObject({ status: 'CLOSED', closeReason: 'EMA' });
    expect(state.calls).toEqual([]);
    expect(state.blocked).toEqual([]);
  });
});
