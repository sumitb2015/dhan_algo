import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { EMPTY_LEDGER, applyAutoOp, type AutoLedger, type AutoOp } from '../lib/pnfAutoLedger';
import { apply, autoExit, autoGet, engineView, newAutoServer, serverClose, serverEnter } from './autoServer';

// Renko AUTO, the page's side: arming, what the page shows of the server's rows and status, Exit, the MTM guard, reload and tabs.
// AUTO itself trades on the dashboard server since feaa01a5; ./autoServer.ts plays the server's part (why, and where the engine's own
// rules are tested). Everything is mocked in the browser, so nothing is written and no order can leave. Also proves the page uses ITS
// OWN ledger (?scope=renko).

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 30, hh, mm, ss) - 5.5 * 3600_000;   // Fri 30 Oct 2026, ms
type Body = { mode?: string; action?: string; lots?: number; source?: string; scope?: string; close?: boolean; exitOwn?: { side: string; units: number[] }; target?: { kind: string } };

async function install(page: Page, opts: { reply?: (b: Body) => Record<string, unknown> } = {}) {
  const orders: Body[] = [];
  const ledgerCalls: string[] = [];
  // 10:26 100.0, 10:27 100.3 = three up bricks (100.0-100.3). The forming 10:30 bar at 99.95 prints two down bricks
  // (100.1-100.2, 100.0-100.1): the 2nd confirms a SELL, booked at its close 100.0.
  const state = { ledger: EMPTY_LEDGER as AutoLedger, tick: { ltp: 99.95, at: ist(10, 30, 10) } };
  const server = newAutoServer();
  const bars = [100, 100.3, 100.3, 100.3].map((p, i) => ({ t: ist(10, 26 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }));
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
        instruments: [{ segment: fut ? 'NSE_FNO' : 'IDX_I', security_id: fut ? '54321' : '13' }], bars: { 0: bars },
      });
    }
    if (p === '/api/straddle-pnf/live') {
      return json(route, { success: true, legs: [{ quote: { ltp: state.tick.ltp, changedMs: state.tick.at, volume: 100, prevClose: 99 }, last: null }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'GET') {
      return json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: '54321', lotUnits: 65 }] });
    }
    if (p === '/api/straddle-pnf/order' && method === 'POST') {
      const b = req.postDataJSON() as Body;
      orders.push(b);
      if (opts.reply) return json(route, opts.reply(b));
      const side = b.exitOwn ? b.exitOwn.side : b.action;
      return json(route, { success: true, outcome: 'placed', message: 'Sent.', legs: [{ label: 'NIFTY NOV FUT', side, qty: b.exitOwn ? b.exitOwn.units[0] : (b.lots ?? 1) * 65, product: 'INTRADAY', status: 'placed', orderId: 'O1' }] });
    }
    if (p === '/api/straddle-pnf/auto/exit' && method === 'POST') return autoExit(route, state, server);
    if (p === '/api/straddle-pnf/auto' || p === '/api/straddle-pnf/resting') {
      ledgerCalls.push(`${method} ${p}${u.search}`);
      if (p === '/api/straddle-pnf/resting') return json(route, { success: true, ledger: { rev: 0, day: '2026-10-30', rows: [] } });
      if (method === 'GET') return autoGet(route, state, server);
      const r = applyAutoOp(state.ledger, req.postDataJSON() as AutoOp);
      if (!r.ok) return json(route, { success: false, error: r.error, ledger: state.ledger }, r.status);
      state.ledger = r.ledger;
      return json(route, { success: true, ledger: state.ledger });
    }
    if (p.endsWith('/funds')) return json(route, { success: true, data: { availabelBalance: 100000 } });
    if (p === '/api/scalper/poll') return json(route, { positions: [], positionsError: null });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/straddle-pnf/server-guard') return json(route, { success: true, guards: {} });   // the page syncs its MTM guard to the server watcher
    if (method === 'GET') return json(route, { success: true });
    return route.fulfill({ status: 599, body: `unmocked ${method} ${p}` });
  });
  return { orders, state, ledgerCalls, server };
}

async function openFuture(page: Page) {
  await page.goto('/renko');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.95');
}

test.beforeEach(async ({ context }) => {
  await signIn(context);
  await context.addInitScript(() => {
    const st = JSON.stringify({ interval: 1, boxMode: 'pts', boxPct: 0.1, boxPts: 0.1, reversal: 2, smaPeriod: 50 });
    try { for (const k of ['renko-auto-rule-1', 'renko-auto-rule-2']) if (!localStorage.getItem(k)) localStorage.setItem(k, 'nbrick'); } catch { /* ignore */ }   // the default rule is Supertrend: these older tests trade N-brick
    try { if (!localStorage.getItem('renko-settings')) { localStorage.setItem('renko-settings', st); localStorage.setItem('renko-settings-2', st); } } catch { /* ignore */ }
  });
});

test('PAPER: arming saves the chart for the server; the server\'s entry and exit are shown on the chart; the page sends no order', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, ledgerCalls } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  // what the server trades from: this chart's contract and settings, in PAPER, 1 lot, the N-brick rule
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('PAPER');
  const arm = state.ledger.arms!['1']!;
  expect(arm).toMatchObject({ lots: 1, rule: 'nbrick', run: { target: { kind: 'futures' }, settings: { boxPts: 0.1, reversal: 2 } } });

  // 10:30 closes: the server enters SELL at the confirming brick (100.0, the 4th brick column)
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', box: 100, barT: ist(10, 30) / 1000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L @ 100.00', { timeout: 15_000 });
  const panel1 = page.getByTestId('pnf-panel').nth(0);
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="SELL"]')).toHaveAttribute('data-col', '4');

  // one up brick (100.1-100.2) on the 10:31 bar; the server exits on it: the exit marker sits on that brick (column 5)
  state.tick = { ltp: 100.25, at: ist(10, 31, 20) };
  await page.clock.setFixedTime(ist(10, 32, 5));
  serverClose(state, { price: 100.2, box: 100.2, barT: ist(10, 31) / 1000, reason: 'reversal' });
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="BUY"]')).toHaveAttribute('data-col', '5', { timeout: 15_000 });
  await expect(page.getByTestId('pnf-auto-status-1')).not.toContainText('SHORT');
  expect(orders, 'the page never sends an AUTO order: the server does').toEqual([]);
  // Renko's own ledgers only: never the P&F page's files
  expect(ledgerCalls.length).toBeGreaterThan(0);
  expect(ledgerCalls.every(c => c.endsWith('?scope=renko')), ledgerCalls.join('\n')).toBe(true);
});

test('REAL: arming takes a second click; the server\'s REAL row is shown; Exit takes a second click and asks the server, scope renko', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, server } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'false');
  await expect(auto).toContainText('ARM REAL AUTO?');
  expect(state.ledger.arms?.['1'], 'the first click saves nothing').toBeUndefined();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');

  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', price: 99.95, box: 100, barT: ist(10, 30) / 1000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L', { timeout: 15_000 });
  const exit = page.getByTestId('pnf-auto-exit-1');
  await exit.click();
  await expect(exit).toHaveText('EXIT REAL?');
  expect(server.exits, 'the first click asks nothing').toEqual([]);
  await exit.click();
  await expect.poll(() => server.exits).toEqual([{ chart: 1, why: 'manual' }]);
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
  await expect(auto).toHaveAttribute('data-armed', 'false', { timeout: 15_000 });
  expect(orders, 'the exit is the server\'s: the page sends no order').toEqual([]);
});

// 2026-11-04 15:31: one click switched REAL AUTO off with a position open; its 15:39 reversal exited and nothing re-entered.
test('REAL: stopping AUTO while it holds a position takes a second click (no re-entry warning); the position stays open', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, server } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', price: 99.95, box: 100, barT: ist(10, 30) / 1000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L', { timeout: 15_000 });

  const stop = auto.getByRole('button', { name: 'Stop AUTO on chart 1' });
  await stop.click();
  await expect(auto).toContainText('STOP AUTO? no re-entry');
  await expect(auto).toHaveAttribute('data-armed', 'true');
  expect(state.ledger.arms?.['1']?.mode, 'the first click changes nothing').toBe('REAL');
  await stop.click();
  await expect(auto).toHaveAttribute('data-armed', 'false');
  await expect.poll(() => state.ledger.arms?.['1']).toBeUndefined();
  expect(state.ledger.rows[0].state, 'stopping AUTO never closes the position').toBe('open');
  expect(server.exits).toEqual([]);
  expect(orders).toEqual([]);
});

test('REAL: an entry the server marked unknown shows UNRESOLVED and the server\'s halt, and waits for the user to resolve it', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, server } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');
  // the server: the order route gave no clean reply - the row is UNKNOWN, the chart halts and is disarmed
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { unknown: true, box: 100, barT: ist(10, 30) / 1000 });
  apply(state, { op: 'setArm', chart: 1, arm: null, t: ist(10, 31, 5) / 1000, text: 'AUTO switched off: entry outcome unknown' });
  server.view['1'] = engineView({ halt: 'entry outcome unknown - check Orders/Positions, then resolve it' });
  await expect(auto).toHaveAttribute('data-armed', 'false', { timeout: 15_000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('UNRESOLVED');
  await expect(page.getByTestId('pnf-auto-status-1')).toHaveAttribute('title', /entry outcome unknown/);
  await auto.getByRole('button', { name: 'Is flat' }).click();
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
  expect(orders).toEqual([]);
});

test('the forming bar\'s bricks are drawn unconfirmed (dimmed) like P&F boxes, and become real bricks once the bar closes', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));                      // the 10:30 bar is still forming at 99.95
  await install(page);
  await openFuture(page);
  const panel = page.getByTestId('pnf-panel').first();
  const count = async (id: string) => ((await panel.getByTestId(id).getAttribute('d')) ?? '').split('z').length - 1;
  // confirmed: 3 up bricks (100.0-100.3); the forming 99.95 adds 2 down bricks, drawn dimmed and not counted as confirmed
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveAttribute('data-count', '2');
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveAttribute('opacity', '0.35');
  expect(await count('pnf-bricks-up')).toBe(3);
  expect(await count('pnf-bricks-down')).toBe(0);
  // 10:31: the bar has closed, so the two bricks are confirmed and nothing is left unconfirmed
  await page.clock.setFixedTime(ist(10, 31, 5));
  await expect.poll(() => count('pnf-bricks-down'), { timeout: 15_000 }).toBe(2);
  await expect(panel.getByTestId('pnf-unconfirmed')).toHaveCount(0);
});

test('the ladder rows are brick edges (multiples of the box), so an order waits for the brick to complete', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  const placed: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.url().includes('/api/straddle-pnf/resting') && r.method() === 'POST') placed.push(r.postDataJSON() as Record<string, unknown>); });
  await openFuture(page);
  const cells = page.getByTestId('pnf-panel').nth(0).locator('[data-testid="pnf-rail-cell"][data-side="SELL"]');
  await expect(cells.first()).toBeAttached();
  const levels = await cells.evaluateAll(els => els.map(e => Number(e.getAttribute('data-level'))));
  expect(levels.length).toBeGreaterThan(3);
  for (const l of levels) expect(Math.abs(l / 0.1 - Math.round(l / 0.1)), `row ${l} is not on the 0.1 brick grid`).toBeLessThan(1e-6);
  // a SELL below the price (99.95) is a stop: on the 99.90 edge, not the 99.85 / 99.95 box middle
  const i = levels.reduce((b, l, k) => (Math.abs(l - 99.9) < Math.abs(levels[b] - 99.9) ? k : b), 0);
  await cells.nth(i).dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => placed.length).toBeGreaterThan(0);
  const row = (placed[0].row ?? placed[0]) as { level?: number };
  expect(row.level).toBeCloseTo(99.9, 6);
});

test('PAPER: the page\'s MTM guard watches AUTO\'s own position - a stop-loss asks the server to exit it (mtm guard) and AUTO goes off', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, server } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('PAPER');
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', box: 100, barT: ist(10, 30) / 1000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L @ 100.00', { timeout: 15_000 });

  // arming AUTO leaves the guard OFF; its card starts at target 10 boxes / stop 10 boxes: switch to rupees, set a tight stop and switch it on
  await expect(page.getByTestId('pnf-guard-toggle')).not.toContainText('ON');
  await page.getByTestId('pnf-guard-toggle').click();
  await expect(page.getByLabel('MTM target in boxes', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('MTM stop-loss in boxes', { exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: '₹ Rupees' }).click();
  await page.getByLabel('MTM stop-loss in rupees', { exact: true }).fill('50');
  await page.getByTestId('pnf-guard-card').getByRole('button', { name: 'Switch on', exact: true }).click();
  await page.waitForTimeout(2500);                                      // the guard's baseline is set on its first priced tick
  // +1 point against the short x 65 = Rs 65 of loss, past the Rs 50 stop
  state.tick = { ltp: 101.05, at: ist(10, 31, 20) };
  await expect.poll(() => server.exits, { timeout: 15_000 }).toEqual([{ chart: 1, why: 'mtm guard' }]);
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
  expect(state.ledger.rows[0]).toMatchObject({ reason: 'mtm guard', side: 'SELL', mode: 'PAPER' });
  expect(orders, 'a paper exit sends nothing').toEqual([]);
  await expect(auto).toHaveAttribute('data-armed', 'false', { timeout: 15_000 });
});

test('Supertrend rule: it is selectable, and arming it locks the ATR / multiplier (the eye still works) until AUTO is stopped', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await openFuture(page);
  const rule = page.getByLabel('AUTO rule on chart 1');
  await expect(rule.locator('option[value="supertrend"]')).toHaveText('Supertrend');
  await rule.selectOption('supertrend');
  await expect(page.getByRole('button', { name: 'Increase Supertrend period' })).toBeEnabled();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect(page.getByRole('button', { name: 'Increase Supertrend period' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Increase Supertrend multiplier' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /(Hide|Show) the Supertrend/ })).toBeEnabled();
});

test('the chosen AUTO rule is remembered per chart across a reload; it is locked only while AUTO is armed', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await openFuture(page);
  const rule = page.getByLabel('AUTO rule on chart 1');
  await rule.selectOption('supertrend');
  await page.reload();
  await expect(page.getByLabel('AUTO rule on chart 1')).toHaveValue('supertrend');
  await expect(page.getByLabel('AUTO rule on chart 1')).toBeEnabled();
  // armed: locked
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect(page.getByLabel('AUTO rule on chart 1')).toBeDisabled();
});

test('a chart starts on the Supertrend rule when nothing is saved', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.removeItem('renko-auto-rule-1'); localStorage.removeItem('renko-auto-rule-2'); } catch { /* ignore */ } });
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await openFuture(page);
  await expect(page.getByLabel('AUTO rule on chart 1')).toHaveValue('supertrend');
  await expect(page.getByLabel('AUTO rule on chart 2')).toHaveValue('supertrend');
});

test('AUTO side: the choice is remembered across a reload, saved with the arming for the server, and locked while armed', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state, server } = await install(page);
  await openFuture(page);
  const side = page.getByLabel('AUTO side on chart 1');
  await expect(side).toHaveValue('both');
  await side.selectOption('buy');
  await page.reload();
  await expect(page.getByLabel('AUTO side on chart 1')).toHaveValue('buy');
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect(page.getByLabel('AUTO side on chart 1')).toBeDisabled();
  await expect.poll(() => state.ledger.arms?.['1']?.side).toBe('buy');          // the server filters the signals by it
  // the server's status line is what the page shows (the engine says why it did not enter: lib/pnfAutoChart.test.ts)
  server.view['1'] = engineView({ note: 'SELL signal ignored (Buy only)' });
  await expect(auto).toContainText('SELL signal ignored (Buy only)', { timeout: 15_000 });
});

// The AUTO switch is saved in the ledger (`arms`): a reload resumes it. Before, a reload (13 dashboard rebuilds on 2026-11-04) left AUTO
// silently off while its open position still exited on the flip - an exit with no re-entry.
test('a reload resumes PAPER AUTO from the ledger; a stop clears it, and an open position with AUTO off says "exit only"', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('PAPER');
  const armT = state.ledger.arms!['1']!.t;
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', box: 100, barT: ist(10, 30) / 1000 });

  await page.reload();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.95');
  await expect(page.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'true', { timeout: 15_000 });   // the page follows the saved switch
  expect(state.ledger.arms?.['1']?.t, 'a reload follows the saved arming, it does not arm again').toBe(armT);

  await page.getByTestId('pnf-auto-1').getByRole('button', { name: 'Stop AUTO on chart 1' }).click();
  await expect(page.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'false');
  await expect.poll(() => state.ledger.arms?.['1']).toBeUndefined();
  expect(state.ledger.log.at(-1)?.text).toBe('AUTO switched off: stopped by the user');
  await expect(page.getByTestId('pnf-auto-off-1')).toContainText('AUTO OFF · exit only');

  await page.reload();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.95');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'false');
  await expect(page.getByText(/holds an AUTO SELL position but AUTO is OFF/)).toBeVisible();
  expect(orders).toEqual([]);
});

test('a REAL arming survives a reload: the server keeps trading it, and the page (which loads in PAPER) shows it armed and unspent', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  page.on('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');
  const armT = state.ledger.arms!['1']!.t;

  await page.reload();
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.95');
  await expect(page.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'true', { timeout: 15_000 });
  await page.waitForTimeout(3500);                                      // a ledger poll later: still the same arming, not re-saved or dropped
  expect(state.ledger.arms?.['1']).toMatchObject({ mode: 'REAL', t: armT });
});

test('a stop in one tab switches AUTO off in the other tab too', async ({ page, context }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  await page.getByTestId('pnf-auto-1').getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('PAPER');

  // A second tab of the same page: its own API mock, but the SAME ledger (a route registered later takes precedence).
  const other = await context.newPage();
  await other.clock.setFixedTime(ist(10, 30, 25));
  await install(other);
  await other.route('**/api/straddle-pnf/auto**', async route => {
    const req = route.request();
    if (req.method() === 'GET') return json(route, { success: true, ledger: state.ledger });
    const r = applyAutoOp(state.ledger, req.postDataJSON() as AutoOp);
    if (r.ok) state.ledger = r.ledger;
    return json(route, { success: r.ok, ledger: state.ledger });
  });
  await other.goto('/renko');
  await expect(other.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'true', { timeout: 15_000 });

  await other.getByTestId('pnf-auto-1').getByRole('button', { name: 'Stop AUTO on chart 1' }).click();
  await expect.poll(() => state.ledger.arms?.['1']).toBeUndefined();
  await expect(page.getByTestId('pnf-auto-1')).toHaveAttribute('data-armed', 'false', { timeout: 15_000 });
});

// Kotak's position book has no LTP: an open leg came back with lastTradedPrice 0 / unrealizedProfit 0, and the header's REAL P&L was the
// realised part only (₹1.4k shown on a ₹2.7k day, 2026-11-04). The chart streams that contract's price, so the header prices the leg with it.
test('Kotak REAL: the header P&L prices an open leg Kotak sends without a price from the chart\'s live price', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await page.addInitScript(() => { try { localStorage.setItem('dhan_algo.selected_broker', 'kotak'); } catch { /* ignore */ } });
  const polls: string[] = [];
  await install(page);
  await page.route('**/api/straddle-pnf/order**', route => route.request().method() === 'GET'
    ? json(route, { success: true, unsupported: null, legs: [{ label: 'NIFTY NOV FUT', side: 'FUT', segment: 'NSE_FNO', lot: 65, unitsPerLot: 65, key: 'NIFTY24NOVFUT', lotUnits: 65 }] })
    : route.fallback());
  await page.route('**/api/scalper/kotak/poll**', route => {
    polls.push(new URL(route.request().url()).search);
    return json(route, { success: true, positionsError: null, positions: [
      // short 65 from 100.50 (Kotak's own realised 300 on the closed part), no price on the open part
      { tradingSymbol: 'NIFTY24NOVFUT', netQty: -65, buyQty: 130, sellQty: 195, buyAvg: 98.19, sellAvg: 100.5, lastTradedPrice: 0, realizedProfit: 300, unrealizedProfit: 0, productType: 'MIS' },
    ] });
  });
  await page.route('**/api/scalper/kotak/funds**', route => json(route, { success: true, data: { availabelBalance: 100000 } }));
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const chip = page.getByTestId('header-pnl-margin');
  // 300 realised + short 65 x (100.50 - 99.95) = 300 + 35.75
  await expect(chip).toContainText('+₹336', { timeout: 15_000 });
  await expect(chip.getByTestId('pnl-unpriced')).toHaveCount(0);
  expect(polls.some(q => q.includes('ltp=1')), 'Kotak option legs are priced by the route').toBe(true);
});

test('pyramid: the +1L/brick setting (Max commits on Enter, Escape cancels) is saved with the arming and locked; the server\'s adds show as lots', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { state } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByTestId('pnf-auto-pyr-1').click();
  const max = auto.getByTestId('pnf-auto-pyr-max-1');
  await max.fill('7');
  await max.press('Escape');                                            // Escape cancels the edit: Max stays at its default
  await expect(max).toHaveValue('10');
  await max.fill('3');
  await max.press('Enter');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect(auto.getByTestId('pnf-auto-pyr-1')).toBeDisabled();
  await expect.poll(() => state.ledger.arms?.['1']?.pyramid?.max).toBe(3);   // what the server adds up to

  // the server enters, then adds two lots (decideAdd / addLot are unit-tested): the page shows the position as 3 lots, 1 + 2 adds
  await page.clock.setFixedTime(ist(10, 31, 5));
  const id = serverEnter(state, { side: 'SELL', box: 100, barT: ist(10, 30) / 1000 });
  apply(state, { op: 'addPaper', id, add: { id: 'a1', t: ist(10, 32, 5) / 1000, barT: ist(10, 31) / 1000, box: 99.9, lots: 1, price: 99.9 } });
  apply(state, { op: 'addPaper', id, add: { id: 'a2', t: ist(10, 33, 5) / 1000, barT: ist(10, 32) / 1000, box: 99.7, lots: 1, price: 99.7 } });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 3L (1+2)', { timeout: 15_000 });
});

