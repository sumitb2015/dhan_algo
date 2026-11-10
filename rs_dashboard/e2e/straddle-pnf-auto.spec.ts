import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import { EMPTY_LEDGER, applyAutoOp, type AutoLedger, type AutoOp } from '../lib/pnfAutoLedger';
import { apply, autoExit, autoGet, engineView, newAutoServer, serverClose, serverEnter } from './autoServer';

// P&F AUTO (strategies/pnf_auto/strategy.md), the page's side: arming, what it shows of the server's rows (status, chart markers, books,
// header P&L, chimes), Exit and an unresolved row. AUTO trades on the dashboard server since feaa01a5; ./autoServer.ts plays the server's
// part (why, and where the engine's own rules are tested). Everything is mocked in the browser - the ledger with the real applyAutoOp - so
// no file is written and no order can leave. The page clock is pinned to an NSE trading morning.

const ist = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 9, 30, hh, mm, ss) - 5.5 * 3600_000;   // Fri 30 Oct 2026, ms
type Body = { mode?: string; broker?: string; action?: string; lots?: number; source?: string; close?: boolean; exitOwn?: { side: string; units: number[] }; target?: { kind: string } };

/** A fake AudioContext that records every tone the page plays as `type:Hz` (lib/alertSound.ts chimes). */
async function recordTones(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tones: string[]; AudioContext: unknown };
    w.__tones = [];
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    w.AudioContext = class {
      state = 'running'; currentTime = 0; destination = {};
      resume() { return Promise.resolve(); }
      createGain() { return { gain: param(), connect() {} }; }
      createOscillator() {
        const o = { type: 'sine', connect() {}, start() { w.__tones.push(`${o.type}:${o.frequency.value}`); }, stop() {}, frequency: param() };
        return o;
      }
    };
  });
  return async () => page.evaluate(() => (window as unknown as { __tones: string[] }).__tones.slice());
}

async function install(page: Page, opts: { reply?: (b: Body) => Record<string, unknown> } = {}) {
  const orders: Body[] = [];
  const state = { ledger: EMPTY_LEDGER as AutoLedger, tick: { ltp: 99.33, at: ist(10, 30, 10) } };
  const server = newAutoServer();
  // Box 0.10 (0.1% of 100). 10:27 100.0, 10:28 99.5 (O column), 10:29 100.0 (X column): the 10:30 bar at 99.33 draws O boxes
  // down to 99.40, below the 99.50 low → double-bottom SELL. The live price 99.33 is inside the 99.40 box, not on it.
  const bars = [100, 99.5, 100].map((p, i) => ({ t: ist(10, 27 + i) / 1000, ce: p, pe: 0, straddle: p, vol: 10 }));
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
    if (p === '/api/straddle-pnf/auto') {
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
  return { orders, state, server };
}

/** Chart 1 on the NIFTY future, then wait for the forming 10:30 bar to be on screen. */
async function openFuture(page: Page) {
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Futures' }).click();
  await expect(page.getByLabel('Expiry')).toHaveValue('2026-11-24');
  await expect(page.getByTestId('pnf-header-summary')).toContainText('99.33');
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('PAPER: arming saves the chart for the server; the server\'s SELL and reversal exit show in the status, markers, books and P&L, with chimes', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const tones = await recordTones(page);
  const { orders, state } = await install(page);
  await openFuture(page);
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  // The instrument is locked while armed, and the arming says what the server is to trade
  await expect(page.getByRole('group', { name: 'Segment' }).getByRole('button', { name: 'Options' })).toBeDisabled();
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('PAPER');
  expect(state.ledger.arms!['1']).toMatchObject({ lots: 1, run: { target: { kind: 'futures' } } });

  // 10:31: the 10:30 bar closed with the double bottom; the server books 1 lot SELL on the confirmed box (99.40, not the live 99.33)
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', box: 99.4, barT: ist(10, 30) / 1000, t: ist(10, 31, 5) / 1000 });
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('SHORT 1L @ 99.40', { timeout: 15_000 });
  // The Price Ladder's entry chime (two rising sine tones) on the server's entry line; the signal itself stays silent on an armed chart
  await expect.poll(tones).toContain('sine:784');
  expect((await tones()).some(t => t.startsWith('triangle:')), 'no signal chime on an armed chart').toBe(false);
  // The open paper trade is in the strip's Positions, marked at the chart price (not at the broker)
  const books = page.getByTestId('pnf-books');
  await books.getByRole('tab', { name: /Positions/ }).click();
  await expect(books.getByTestId('pnf-books-auto-positions')).toContainText('NIFTY FUT');
  await expect(books.getByTestId('pnf-books-auto-positions')).toContainText('-65');

  // 10:31 prints 100.04 (an X column up to the 100.00 box); the server exits the short on that reversal, on its confirmed box
  state.tick = { ltp: 100.04, at: ist(10, 31, 20) };
  await page.clock.setFixedTime(ist(10, 32, 5));
  serverClose(state, { price: 100, box: 100, barT: ist(10, 31) / 1000, reason: 'reversal', t: ist(10, 32, 5) / 1000 });
  expect(Math.round(state.ledger.rows[0].pnl!)).toBe(-39);                      // (99.4 - 100) x 65
  // Markers sit on the signal's own column (the O column that broke below: col 2) and the reversal X column (col 3)
  const panel1 = page.getByTestId('pnf-panel').nth(0);
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="SELL"]')).toHaveAttribute('data-col', '2', { timeout: 15_000 });
  await expect(panel1.locator('[data-testid="pnf-trade-marker"][data-action="BUY"]')).toHaveAttribute('data-col', '3');
  await expect(page.getByTestId('pnf-auto-status-1')).not.toContainText('SHORT');
  await expect.poll(tones, { message: 'the exit chime (two falling sine tones)' }).toContain('sine:698');

  // Its P&L shows in the header's PAPER P&L chip, the strip, the P&L tab and the AUTO tab
  await expect(page.getByTestId('header-pnl-margin')).toContainText('-₹39');
  await expect(books.getByTestId('pnf-books-auto-paper')).toHaveText('-₹39');
  await expect(books.getByTestId('pnf-books-auto-positions')).toHaveCount(0);   // closed: no longer an open position
  await books.getByRole('tab', { name: 'P&L' }).click();
  await expect(books.getByTestId('pnf-books-auto-pnl')).toContainText('-₹39');
  await expect(books.getByTestId('pnf-books-auto-pnl')).toContainText('0 / 1');   // open / closed
  await books.getByRole('tab', { name: /AUTO/ }).click();
  await expect(books.locator('tbody tr').first()).toContainText('reversal');
  expect(orders, 'the page never sends an AUTO order: the server does').toEqual([]);
});

test('REAL: arming takes a second click; the server\'s REAL row is shown; Exit takes a second click and asks the server to exit it', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const { orders, state, server } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'false');                    // first click only asks
  await expect(auto).toContainText('ARM REAL AUTO?');
  expect(state.ledger.arms?.['1'], 'the first click saves nothing').toBeUndefined();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect(auto).toHaveAttribute('data-armed', 'true');
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');

  // the server's REAL entry books the live price (a market fill) and keeps the confirmed box for its marker
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { side: 'SELL', price: 99.33, box: 99.4, barT: ist(10, 30) / 1000 });
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

test('REAL: an entry the server marked unknown shows UNRESOLVED with the warn buzz, and waits for the user to resolve it', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  const tones = await recordTones(page);
  const { orders, state, server } = await install(page);
  await openFuture(page);
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('group', { name: 'Execution mode' }).getByRole('button', { name: 'REAL' }).click();
  const auto = page.getByTestId('pnf-auto-1');
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await auto.getByRole('button', { name: 'Start AUTO on chart 1' }).click();
  await expect.poll(() => state.ledger.arms?.['1']?.mode).toBe('REAL');
  // the server: no clean reply from the order route - the row is UNKNOWN, the chart halts and is disarmed
  await page.clock.setFixedTime(ist(10, 31, 5));
  serverEnter(state, { unknown: true, box: 99.4, barT: ist(10, 30) / 1000, t: ist(10, 31, 5) / 1000 });
  apply(state, { op: 'setArm', chart: 1, arm: null, t: ist(10, 31, 5) / 1000, text: 'AUTO switched off: entry outcome unknown' });
  server.view['1'] = engineView({ halt: 'entry outcome unknown - check Orders/Positions, then resolve it' });
  await expect(auto).toHaveAttribute('data-armed', 'false', { timeout: 15_000 });   // halted
  await expect(page.getByTestId('pnf-auto-status-1')).toContainText('UNRESOLVED');
  await expect.poll(tones, { message: 'the warn buzz' }).toContain('square:330');
  // The user checks the broker: nothing was opened
  await auto.getByRole('button', { name: 'Is flat' }).click();
  await expect.poll(() => state.ledger.rows[0]?.state).toBe('closed');
  expect(orders).toEqual([]);
});

test('no AUTO on an index chart', async ({ page }) => {
  await page.clock.setFixedTime(ist(10, 30, 20));
  await install(page);
  await page.goto('/straddle-pnf');
  await expect(page.getByTestId('pnf-header-summary')).toContainText(/vs (prev close|open)/);
  await expect(page.getByTestId('pnf-auto-1').getByRole('button', { name: 'Start AUTO on chart 1' })).toBeDisabled();
});
