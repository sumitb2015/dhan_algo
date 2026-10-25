import { expect, test, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';
import type { LadderSlice, LadderState } from '../lib/priceLadder';

// Price Ladder, browser side only. /api/price-ladder/state is answered by an in-browser fake (no server watcher, no
// broker); every other non-GET that is not handled is refused (599) and fails the test, so nothing can reach an order route.

import { isRegularSession } from '../lib/nseHolidays';

/** The latest IST date (today or before) on which NSE had a regular session: the 'market is trading' tests need one, and today may be a weekend. */
const lastTradingDay = () => {
  for (let back = 0; back < 10; back++) {
    const d = new Date(Date.now() + 5.5 * 3600_000 - back * 86_400_000).toISOString().slice(0, 10);
    if (isRegularSession(d)) return d;
  }
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
};
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const SPOT = 23200;

async function install(page: Page, opts: { liveArmed?: boolean; openLong?: boolean; sessions?: Record<string, boolean>; /** Server clock as IST HH:MM today, and a spot that last moved a minute before it. */ staleAt?: string; /** How long ago the server watcher last ticked (ms); absent = healthy. */ watcherLagMs?: number; /** One open XY slice, one open Plain slice and one open short strangle (every mode has a position). */ openAll?: boolean; /** One open SIM short iron condor (2 lots) on the mocked strikes. */ openBasket?: boolean; /** N armed (not yet fired) pairs on the two legs the Pair ladder shows. */ armedPairs?: number; /** One armed pair on OTHER strikes (23300 CE / 23100 PE) than the Pair ladder shows. */ offPair?: boolean; /** Give the chain open interest on 23200 so the XY ladder draws OI bars. */ oi?: boolean; /** Broker positions the books window lists, and what POST /api/price-ladder/close-position answers. */ positions?: Record<string, unknown>[]; closeReply?: { status?: number; body: Record<string, unknown> } } = {}) {
  const clock = opts.staleAt ? new Date(`${lastTradingDay()}T${opts.staleAt}:00+05:30`).getTime() : null;
  let armed = !!opts.liveArmed;   // POST action 'live' flips it, as the server does
  const seen = { posts: [] as Record<string, unknown>[], blocked: [] as string[], gets: [] as string[], closes: [] as Record<string, unknown>[] };
  const state: LadderState = { date: istToday(), slices: [], events: [] };
  if (opts.openLong) {
    state.slices.push({
      id: 'open1', kind: 'xy', broker: 'dhan', mode: 'sim', side: 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open',
      contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
      createdAt: Date.now(), updatedAt: Date.now(), openedAt: Date.now(), filledQty: 65, avg: 110, entryLevel: 23180, entryY: 23180,
      bracket: { tgtPts: 40, slPts: 30 }, tgtY: 23220, slY: 23150, slY0: 23150,
    });
  }
  if (opts.openAll) {
    const c = (securityId: string, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt, securityId, lotSize: 65, exchangeSegment: 'NSE_FNO' });
    const base = { broker: 'dhan', mode: 'sim', side: 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open', createdAt: Date.now(), updatedAt: Date.now(), openedAt: Date.now(), filledQty: 65 };
    state.slices.push(
      { ...base, id: 'xy1', kind: 'xy', contract: c('111', 'CE'), avg: 110, entryLevel: 23180, entryY: 23180, bracket: { tgtPts: 40, slPts: 30 }, tgtY: 23220, slY: 23150, slY0: 23150 } as LadderSlice,
      { ...base, id: 'pl1', kind: 'plain', contract: c('222', 'PE'), avg: 85, orderType: 'LIMIT' } as LadderSlice,
    );
    const leg = (id: string, opt: 'CE' | 'PE', avg: number) => ({ contract: c(id, opt), avg, held: 65, entry: 'filled' });
    state.pairs = [{ id: 'pp1', broker: 'dhan', mode: 'sim', structure: 'strangle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'open', legs: { ce: leg('111', 'CE', 100), pe: leg('222', 'PE', 90) }, createdAt: Date.now(), updatedAt: Date.now(), openedAt: Date.now() }] as unknown as LadderState['pairs'];
  }
  if (opts.armedPairs) {
    const c = (securityId: string, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt, securityId, lotSize: 65, exchangeSegment: 'NSE_FNO' });
    state.pairs = Array.from({ length: opts.armedPairs }, (_, i) => ({
      id: `ap${i}`, broker: 'dhan', mode: 'sim', structure: 'straddle', side: i % 2 ? 'BUY' : 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'armed',
      legs: { ce: { contract: c('111', 'CE') }, pe: { contract: c('222', 'PE') } }, createdAt: Date.now() + i, updatedAt: Date.now(), entryLevel: 250 + i, entryDir: 'above', seenSafe: true,
    })) as unknown as LadderState['pairs'];
  }
  if (opts.offPair) {
    const c = (strike: number, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike, opt, securityId: `${strike}${opt}`, lotSize: 65, exchangeSegment: 'NSE_FNO' });
    state.pairs = [...(state.pairs ?? []), {
      id: 'off1', broker: 'dhan', mode: 'sim', structure: 'strangle', side: 'SELL', lots: 1, qty: 65, product: 'MIS', state: 'armed',
      legs: { ce: { contract: c(23300, 'CE') }, pe: { contract: c(23100, 'PE') } }, createdAt: Date.now(), updatedAt: Date.now(), entryLevel: 185, entryDir: 'above', seenSafe: true,
    }] as unknown as LadderState['pairs'];
  }
  const bpx = (strike: number, opt: 'CE' | 'PE') => Math.max(5, opt === 'CE' ? 120 - (strike - 23200) * 0.4 : 100 + (strike - 23200) * 0.4);
  if (opts.openBasket) {
    const c = (strike: number, opt: 'CE' | 'PE') => ({ underlying: 'NIFTY', expiry: '2026-10-27', strike, opt, securityId: `${strike}${opt}`, lotSize: 65, exchangeSegment: 'NSE_FNO' });
    const leg = (key: string, side: 'BUY' | 'SELL', strike: number, opt: 'CE' | 'PE') => ({ key, side, ratio: 1, contract: c(strike, opt), avg: bpx(strike, opt), held: 130, filledQty: 130, entry: 'filled' });
    state.baskets = [{
      id: 'bk1', strategy: 'iron-condor', name: 'Iron Condor', broker: 'dhan', mode: 'sim', side: 'SELL', lots: 2, product: 'MIS', state: 'open',
      legs: [leg('l0', 'SELL', 23350, 'CE'), leg('l1', 'BUY', 23500, 'CE'), leg('l2', 'SELL', 23050, 'PE'), leg('l3', 'BUY', 22900, 'PE')],
      createdAt: Date.now(), updatedAt: Date.now(), openedAt: Date.now(), entryY: 90,
    }] as unknown as LadderState['baskets'];
  }
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    // The push stream would answer from the real server's ledger and overwrite this fake: refuse it, the page falls back to its 1 s poll.
    if (p === '/api/price-ladder/stream') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'mocked off' });
    // Read-only broker endpoints the page polls: answered here so a test never reads a real account.
    if (p === '/api/auth/broker-status') return json(route, { dhan: true, kotak: true, zerodha: true, ...opts.sessions });
    if (p === '/api/dashboard/portfolio') {
      seen.gets.push(`${p}?broker=${u.searchParams.get('broker')}`);
      const broker = u.searchParams.get('broker');
      return json(route, { success: true, brokers: [{ broker, connected: true, error: null, unpricedPositions: 0, openPositions: 2, totalPnl: broker === 'dhan' ? -8012 : 150 }] });
    }
    if (/^\/api\/scalper(\/(kotak|zerodha))?\/poll$/.test(p)) {
      seen.gets.push(p);
      return json(route, { success: true, positions: opts.positions ?? [], orders: [], trades: [] });
    }
    if (p === '/api/price-ladder/close-position' && method === 'POST') {
      seen.closes.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, opts.closeReply?.body ?? { success: true, data: { message: 'Close sent: e2e' } }, opts.closeReply?.status ?? 200);
    }
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-27'] });
    if (p === '/api/options/chain') {
      const oc: Record<string, unknown> = {};
      for (const k of [22800, 22850, 22900, 22950, 23000, 23050, 23100, 23150, 23200, 23250, 23300, 23350, 23400, 23450, 23500, 23550, 23600]) oc[`${k}.000000`] = opts.oi && k === 23200 ? { ce: { oi: 3_146_455 }, pe: { oi: 1_722_500 } } : { ce: {}, pe: {} };
      return json(route, { success: true, data: { spot: SPOT, chain: { oc } } });
    }
    if (p === '/api/scalper/top-indices') return json(route, { success: true, quotes: { NIFTY: { ltp: SPOT, prev_close: 23100, change_pct: 0.43, day_high: 23250, day_low: 23050 } } });
    if (p === '/api/live-indices' && method === 'POST') return json(route, { success: true });
    if (p === '/api/price-ladder/state') {
      if (method === 'GET') {
        return json(route, { success: true, data: {
          state, spots: { NIFTY: clock ? { spot: SPOT, at: clock - 60_000, source: 'ws (not moved yet)', fresh: false } : { spot: SPOT, at: Date.now(), source: 'indices', fresh: true } }, ltps: { '111': 120, '222': 100, ...(opts.openBasket ? Object.fromEntries([[23350, 'CE'], [23500, 'CE'], [23050, 'PE'], [22900, 'PE']].map(([k, o]) => [`${k}${o}`, bpx(k as number, o as 'CE' | 'PE')])) : {}) },
          liveArmed: armed, now: clock ?? Date.now(), watcherQuiet: (opts.watcherLagMs ?? 0) > 8000,
          // The page reads the contract only from a reply that echoes the selection it is showing.
          request: { underlying: u.searchParams.get('underlying'), expiry: u.searchParams.get('expiry') ?? '', strike: Number(u.searchParams.get('strike')) || null, opt: u.searchParams.get('opt'), pairCe: Number(u.searchParams.get('pairCe')) || null, pairPe: Number(u.searchParams.get('pairPe')) || null, basket: u.searchParams.get('basket') ?? '' },
          pair: Number(u.searchParams.get('pairCe')) > 0 ? {
            ce: { strike: Number(u.searchParams.get('pairCe')), securityId: '111', ltp: 120 }, pe: { strike: Number(u.searchParams.get('pairPe')), securityId: '222', ltp: 100 },
            combined: 220, lotSize: 65, mult: 1,
          } : null,
          contract: { securityId: '111', lotSize: 65, ltp: 120 },
          ...(u.searchParams.get('basket') ? (() => {
            const legs = u.searchParams.get('basket')!.split(',').map(t => { const [k, o, s, r] = t.split(':'); return { strike: Number(k), opt: o as 'CE' | 'PE', side: s === 'S' ? 'SELL' as const : 'BUY' as const, ratio: Number(r) }; });
            const d = legs.reduce((a, l) => a + (l.side === 'BUY' ? 1 : -1) * l.ratio * bpx(l.strike, l.opt), 0);
            return { basket: { legs: legs.map(l => ({ ...l, securityId: `${l.strike}${l.opt}`, ltp: bpx(l.strike, l.opt) })), a: Math.abs(Number(d.toFixed(2))), credit: d < 0, lotSize: 65, mult: 1 } };
          })() : {}),
        } });
      }
      const body = req.postDataJSON() as Record<string, unknown>;
      seen.posts.push(body);
      if (body.action === 'live') armed = body.on === true;
      if (body.action === 'arm') {
        const s: LadderSlice = {
          id: `t${seen.posts.length}`, kind: 'xy', broker: (body.broker as 'dhan') ?? 'dhan', mode: 'sim',
          contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
          side: body.side as 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'armed', createdAt: Date.now(), updatedAt: Date.now(),
          entryLevel: Number(body.level), entryDir: 'below', seenSafe: true, bracket: body.bracket as LadderSlice['bracket'],
        };
        state.slices.push(s);
      }
      if (body.action === 'market') {
        state.slices.push({
          id: `m${seen.posts.length}`, kind: 'plain', broker: (body.broker as 'dhan') ?? 'dhan', mode: body.mode === 'real' ? 'real' : 'sim',
          contract: { underlying: 'NIFTY', expiry: '2026-10-27', strike: 23200, opt: 'CE', securityId: '111', lotSize: 65, exchangeSegment: 'NSE_FNO' },
          side: body.side as 'BUY', lots: 1, qty: 65, product: 'MIS', state: 'open', createdAt: Date.now(), updatedAt: Date.now(), market: true,
        } as LadderSlice);
      }
      if (body.action === 'pair' && body.op === 'cancelAll') state.pairs = (state.pairs ?? []).map(x => ((body.ids as string[]).includes(x.id) && x.state === 'armed' ? { ...x, state: 'cancelled' as const } : x));
      if (body.action === 'cancel') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, state: 'cancelled' } : x));
      if (body.action === 'lots') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, lots: Number(body.lots), qty: Number(body.lots) * 65 } : x));
      if (body.action === 'modify') state.slices = state.slices.map(x => (x.id === body.id ? { ...x, entryLevel: Number(body.level) } : x));
      return json(route, { success: true, data: { state } });
    }
    if (method !== 'GET') {
      seen.blocked.push(`${method} ${p}`);
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return route.continue();
  });
  return seen;
}

// The page opens with two ladders (ATM call + ATM put); the single-ladder tests below close the second so their
// locators stay unique.
async function gotoSingle(page: Page) {
  await page.goto('/price-ladder');
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(page.getByLabel('Underlying')).toHaveCount(1);
}

test.beforeEach(async ({ context }) => { await signIn(context); });

test('XY SIM: clicking Buy below spot arms a bracketed CE entry, and its badge cancels it', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /NIFTY\s+23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  const arm = seen.posts.find(b => b.action === 'arm')!;
  expect(arm).toMatchObject({ kind: 'xy', mode: 'sim', broker: 'dhan', side: 'BUY', level: 23180, opt: 'CE', strike: 23200, bracket: { tgtPts: 40, slPts: 30 } });
  await page.getByRole('button', { name: 'Cancel Entry BUY 1 lot at 23180' }).click();
  await expect.poll(() => seen.posts.some(b => b.action === 'cancel')).toBe(true);
  expect(seen.blocked).toEqual([]);
});

test('XY: a Buy above spot with Order Type Limit is refused in the page (it is a breakout: needs SL)', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect(page.getByText(/breakout entry — switch Order Type to SL/)).toBeVisible();
  expect(seen.posts).toEqual([]);
});

test('Put in XY mode: the ladder is inverted — a Buy above spot is a limit', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Put' }).click();
  await page.getByRole('button', { name: 'Buy at 23220' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ opt: 'PE', side: 'BUY', level: 23220 });
});

test('Choosing REAL without the daily arm asks first; Cancel stays on SIM and sends nothing', async ({ page }) => {
  const seen = await install(page, { liveArmed: false });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/Arm LIVE · REAL MONEY for today\?/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'SIM', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(seen.posts).toEqual([]);
  expect(seen.blocked).toEqual([]);
});

test('Arming from the REAL choice arms for today, switches to REAL, and the header offers Disarm', async ({ page }) => {
  const seen = await install(page, { liveArmed: false });
  await gotoSingle(page);
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: /Arm for today and switch to REAL/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'live')).toEqual([{ action: 'live', on: true }]);
  await expect(page.getByRole('button', { name: 'REAL', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /REAL armed · Disarm/ })).toBeVisible();
  await page.getByRole('button', { name: /REAL armed · Disarm/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'live').length).toBe(2);
  await expect(page.getByRole('button', { name: /REAL armed · Disarm/ })).toHaveCount(0);
  expect(seen.blocked).toEqual([]);
});

test('REAL armed: the first click asks for confirmation before anything is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ mode: 'real', level: 23180 });
});

test('Buy Market / Sell Market (SIM): one click sends the selected contract at market with the current lots', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Sell at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'market').length).toBe(1);
  expect(seen.posts.find(b => b.action === 'market')).toMatchObject({ mode: 'sim', broker: 'dhan', side: 'SELL', lots: 1, opt: 'CE', strike: 23200 });
  expect(seen.blocked).toEqual([]);
});

test('Buy Market (REAL): the first click asks for confirmation before anything is sent', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Buy at market' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'market').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ action: 'market', mode: 'real', side: 'BUY' });
});

test('SIM mode shows a loud paper marker; REAL hides it', async ({ page }) => {
  await install(page, { liveArmed: true });
  await gotoSingle(page);
  const badge = page.getByRole('status').filter({ hasText: 'SIM · PAPER — NOT REAL' });
  await expect(badge).toBeVisible();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(badge).toHaveCount(0);
});

test('The chime toggle mutes and unmutes trade sounds and is remembered', async ({ page }) => {
  await install(page);
  await gotoSingle(page);
  await page.getByRole('button', { name: 'Mute trade chimes' }).click();
  await expect(page.getByRole('button', { name: 'Unmute trade chimes' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(page.getByRole('button', { name: 'Unmute trade chimes' })).toBeVisible();
  await page.getByRole('button', { name: 'Unmute trade chimes' }).click();
  await expect(page.getByRole('button', { name: 'Mute trade chimes' })).toBeVisible();
});

test('Settings: the NSE cutoff is set separately from the MCX one', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await page.getByTitle('Configure Price Ladder trading cutoff & session thresholds').click();
  await expect(page.getByText('NSE Trading Cutoff (Nifty, Bank Nifty & other indices)')).toBeVisible();
  await expect(page.getByText('MCX Trading Cutoff (CRUDEOILM)')).toBeVisible();
  const nse = page.getByText('NSE Trading Cutoff (Nifty, Bank Nifty & other indices)').locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]');
  await nse.getByRole('button', { name: /^15:35/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'settings').length).toBe(1);
  expect(seen.posts.find(b => b.action === 'settings')).toMatchObject({ nseAutoExitTime: '15:35', confirmPast: false });
  expect(seen.posts.find(b => b.action === 'settings')).not.toHaveProperty('mcxAutoExitTime');
});

test('Bracket: target and SL show on the ladder as soon as it is armed (dashed, before the fill)', async ({ page }) => {
  await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  // 23180 + 40 = 23220 target, 23180 - 30 = 23150 SL
  await expect(page.locator('[title^="Target — set when the entry fills"]', { hasText: '23220' })).toHaveCount(1);
  await expect(page.locator('[title^="SL — set when the entry fills"]', { hasText: '23150' })).toHaveCount(1);
});

test('Cover order sends an SL-only bracket (target 0)', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cover', exact: true }).click();
  await expect(page.getByLabel('Target points')).toHaveCount(0);
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ bracket: { tgtPts: 0, slPts: 30 } });
});

test('Drag an armed entry to another row to move its level', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  const badge = page.locator('[title="Entry — drag to another price to move it"]');
  await expect(badge).toBeVisible();
  await badge.dragTo(page.getByRole('button', { name: 'Buy at 23170' }));
  await expect.poll(() => seen.posts.find(b => b.action === 'modify')).toMatchObject({ action: 'modify', level: 23170 });
  expect(seen.blocked).toEqual([]);
});

test('Zerodha: the broker picker offers Zerodha and new ladder orders go to it', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByLabel('Broker for new orders').selectOption('zerodha');
  await expect(page.getByLabel('Broker for new orders')).toHaveValue('zerodha');
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  expect(seen.posts[0]).toMatchObject({ broker: 'zerodha', mode: 'sim', side: 'BUY', level: 23180 });
  expect(seen.blocked).toEqual([]);
});

test('An armed order sits in the Buy column as price | + − | qty, and the Price column shows only prices', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Buy at 23180' }).click();
  const buyCell = page.getByRole('button', { name: 'Buy at 23180' });
  await expect(buyCell.locator('[data-widget="entry"]')).toContainText('65');
  // the price cell next to it is just the price
  const row = buyCell.locator('xpath=..');
  await expect(row.locator(':scope > div').nth(2)).toHaveText('23180');
  // + raises the armed order to 2 lots in place; − at 1 lot does not go below 1
  await page.getByRole('button', { name: 'Plus one lot: Entry BUY 1 lot at 23180' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'lots')).toMatchObject({ action: 'lots', lots: 2 });
  await expect(buyCell.locator('[data-widget="entry"]')).toContainText('130');
  expect(seen.blocked).toEqual([]);
});

test('An open bracket shows TGT and SL widgets in the Sell column; + adds a lot, − exits a lot', async ({ page }) => {
  const seen = await install(page, { openLong: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  const tgt = page.getByRole('button', { name: 'Sell at 23220' }).locator('[data-widget="tgt"]');
  const sl = page.getByRole('button', { name: 'Sell at 23150' }).locator('[data-widget="sl"]');
  await expect(tgt).toContainText('65');
  await expect(sl).toContainText('65');
  await page.getByRole('button', { name: 'Minus one lot: Target SELL 1 lot at 23220' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'exit')).toMatchObject({ action: 'exit', ids: ['open1'], lots: 1 });
  await page.getByRole('button', { name: 'Plus one lot: SL SELL 1 lot at 23150' }).click();
  await expect.poll(() => seen.posts.find(b => b.action === 'add')).toMatchObject({ action: 'add', id: 'open1' });
  expect(seen.blocked).toEqual([]);
});

test('Two ladders by default: ladder 1 is the call, ladder 2 the put, each with its own selection; Close / Add ladder toggles the second', async ({ page }) => {
  const seen = await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  const underlying = page.getByLabel('Underlying');
  await expect(underlying).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Add ladder/ })).toHaveCount(0);   // at most two
  // Both panes hydrated (their expiry lists loaded): an earlier selectOption would be reset by the mount effect that restores saved choices.
  await expect(page.getByLabel('Expiry').first()).toHaveValue('2026-10-27');
  await expect(page.getByLabel('Expiry').nth(1)).toHaveValue('2026-10-27');
  // Call on ladder 1, Put on ladder 2 (the Call/Put switch's pressed side)
  await expect(page.getByRole('button', { name: 'Call', exact: true, pressed: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Put', exact: true, pressed: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Call', exact: true })).toHaveCount(2);
  // Page-wide header controls appear once, not once per ladder
  // The books sit under each ladder's header (the account chips stay once)
  for (const name of [/Order book/, /Trade book/, /^Positions/]) await expect(page.getByRole('button', { name })).toHaveCount(2);
  await expect(page.locator('.sticky').getByText('Settings', { exact: true })).toHaveCount(1);
  await expect(page.getByText(/^DATA:/)).toHaveCount(1);
  // Side by side, the two ladders start at the same height (headers held to the taller one)
  await expect.poll(async () => {
    const h = await page.locator('.sticky').evaluateAll(els => els.filter(e => e.querySelector('h1')).map(e => Math.round(e.getBoundingClientRect().height)));
    return h.length === 2 && h[0] === h[1];
  }).toBe(true);
  await underlying.nth(1).selectOption('BANKNIFTY');
  await expect(underlying.nth(0)).toHaveValue('NIFTY');
  await expect(underlying.nth(1)).toHaveValue('BANKNIFTY');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Close ladder 2/ }).click();
  await expect(underlying).toHaveCount(1);
  await page.getByRole('button', { name: /Add ladder/ }).click();
  await expect(underlying).toHaveCount(2);
  expect(seen.blocked).toEqual([]);
});

test('The header controls fold away for more room (both ladders at once), keep a broker · mode chip, and stay folded on reload', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  await expect(page.getByLabel('Expiry').first()).toHaveValue('2026-10-27');
  await expect(page.getByRole('button', { name: /Option chain/ })).toHaveCount(2);
  const head = () => page.locator('.sticky').first().evaluate(e => e.getBoundingClientRect().height);
  const open = await head();
  await page.getByRole('button', { name: 'Hide header controls' }).first().click();
  await expect(page.getByRole('button', { name: /Option chain/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show header controls' })).toHaveCount(2);
  await expect(page.getByText('Dhan · SIM')).toHaveCount(2);
  // Indices and P&L stay visible while the controls are folded
  await expect(page.getByText('INDIA VIX')).toBeVisible();
  await expect(page.getByText(/^Ladder P&L/)).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Order book/ })).toHaveCount(0);
  expect(await head()).toBeLessThan(open);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show header controls' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Show header controls' }).first().click();
  await expect(page.getByRole('button', { name: /Option chain/ })).toHaveCount(2);
});

// ── every broker ──────────────────────────────────────────────────────────────────────────────────────────────
// The browser side of the per-broker paths (the order/placement code itself is covered by the unit tests and cannot be
// run against a live account): each mode sends the selected broker, the books and account chip read THAT broker, a
// logged-out broker blocks REAL, and MCX stays Dhan-only.
for (const broker of ['dhan', 'kotak', 'zerodha'] as const) {
  const Name = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' }[broker];
  test.describe(`${Name}`, () => {
    test(`XY, Plain and Pair orders all carry the broker`, async ({ page }) => {
      const seen = await install(page);
      await gotoSingle(page);
      await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await expect(page.getByLabel('Broker for new orders')).toHaveValue(broker);   // the toolbar no longer repeats the broker name; the posts below prove it is the one used
      await page.getByRole('button', { name: 'Buy at 23180' }).click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
      expect(seen.posts[0]).toMatchObject({ kind: 'xy', broker, mode: 'sim', side: 'BUY', level: 23180 });
      await page.getByRole('button', { name: 'Plain', exact: true }).click();
      await page.getByRole('button', { name: /^Buy at 119\.00/ }).first().click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(2);
      expect(seen.posts[1]).toMatchObject({ kind: 'plain', broker, mode: 'sim', side: 'BUY' });
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      await page.getByRole('button', { name: /^Buy at 21[0-9]/ }).first().click();
      await expect.poll(() => seen.posts.filter(b => b.action === 'pair').length).toBe(1);
      expect(seen.posts.find(b => b.action === 'pair')).toMatchObject({ op: 'arm', broker, mode: 'sim', side: 'BUY' });
      expect(seen.blocked).toEqual([]);
    });

    test(`the account chip and the books read ${Name}'s own endpoints`, async ({ page }) => {
      const seen = await install(page);
      await gotoSingle(page);
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await expect(page.getByText(`${Name} P&L`)).toBeVisible();
      await expect.poll(() => seen.gets.includes(`/api/dashboard/portfolio?broker=${broker}`)).toBe(true);
      await page.getByRole('button', { name: /^Positions/ }).click();
      await expect.poll(() => seen.gets.includes(broker === 'dhan' ? '/api/scalper/poll' : `/api/scalper/${broker}/poll`)).toBe(true);
      expect(seen.blocked).toEqual([]);
    });

    test(`REAL with ${Name} logged out is blocked up front and sends nothing`, async ({ page }) => {
      const seen = await install(page, { liveArmed: true, sessions: { [broker]: false } });
      await gotoSingle(page);
      await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
      await page.getByLabel('Broker for new orders').selectOption(broker);
      await page.getByRole('button', { name: 'REAL', exact: true }).first().click();
      await expect(page.getByText(new RegExp(`${Name} session is not logged in`))).toBeVisible();
      await page.getByRole('button', { name: 'Buy at 23180' }).click({ force: true });
      await page.waitForTimeout(500);
      expect(seen.posts.filter(b => b.action === 'arm')).toEqual([]);
      expect(seen.blocked).toEqual([]);
    });

    if (broker !== 'dhan') {
      test(`MCX crude is selectable on ${Name}: no Dhan-only banner, nothing placed`, async ({ page }) => {
        const seen = await install(page);
        await gotoSingle(page);
        await page.getByLabel('Broker for new orders').selectOption(broker);
        await page.getByLabel('Underlying').selectOption('CRUDEOILM');
        await page.waitForTimeout(500);
        await expect(page.getByText(/trades on Dhan only in the Price Ladder/)).toHaveCount(0);
        expect(seen.posts.filter(b => b.action === 'arm' || b.action === 'pair')).toEqual([]);
        expect(seen.blocked).toEqual([]);
      });
    }
  });
}

test('Two ladders on different brokers: each shows its own broker account chip; on the same broker the chip is shown once (both ladders keep their own books)', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/price-ladder');
  await expect(page.getByLabel('Expiry').nth(1)).toHaveValue('2026-10-27');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(2);
  await page.getByLabel('Broker for new orders').nth(1).selectOption('kotak');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(2);
  await expect(page.getByText('Dhan P&L')).toHaveCount(1);
  await expect(page.getByText('Kotak P&L')).toHaveCount(1);
  await page.getByLabel('Broker for new orders').nth(1).selectOption('dhan');
  await expect(page.getByRole('button', { name: /^Positions/ })).toHaveCount(2);
});

test('The stale-price warning shows only while the market is trading, not after hours', async ({ page }) => {
  await install(page, { staleAt: '11:00' });
  await gotoSingle(page);
  await expect(page.getByText(/price is stale|spot is stale/)).toBeVisible();
});

test('After hours (05:30 IST) a stale price is not warned about', async ({ page }) => {
  await install(page, { staleAt: '05:30' });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText(/is stale/)).toHaveCount(0);
});

// Positions window: close all / part of a broker position. The server derives side and quantity from the broker's own
// book, so the page may only name the position and the share.
const SHORT_PE = { tradingSymbol: 'NIFTY-Nov2026-22000-PE', securityId: '222', exchangeSegment: 'NSE_FNO', productType: 'MARGIN', netQty: -195, buyAvg: 0, sellAvg: 114.24, unrealizedProfit: -15495.07, realizedProfit: 0 };

async function openPositions(page: Page) {
  await gotoSingle(page);
  await page.getByRole('button', { name: /^Positions/ }).click();
  await expect(page.getByText('NIFTY-Nov2026-22000-PE')).toBeVisible();
}

test('Positions window: Close asks first, and dismissing the confirm sends nothing', async ({ page }) => {
  const seen = await install(page, { positions: [SHORT_PE] });
  const asked: string[] = [];
  page.on('dialog', d => { asked.push(d.message()); void d.dismiss(); });
  await openPositions(page);
  await page.getByRole('button', { name: 'Close 100% of NIFTY-Nov2026-22000-PE' }).click();
  await expect.poll(() => asked.length).toBe(1);
  expect(asked[0]).toMatch(/Close ALL of Dhan/);
  await expect(page.getByText('Cancelled — nothing was sent')).toBeVisible();
  expect(seen.closes).toEqual([]);
  expect(seen.blocked).toEqual([]);
});

test('Positions window: 50% names only the position and the share (no side / qty from the browser)', async ({ page }) => {
  const seen = await install(page, { positions: [SHORT_PE] });
  page.on('dialog', d => { void d.accept(); });
  await openPositions(page);
  await page.getByRole('button', { name: 'Close 50% of NIFTY-Nov2026-22000-PE' }).click();
  await expect.poll(() => seen.closes.length).toBe(1);
  expect(seen.closes[0]).toEqual({ broker: 'dhan', key: '222', product: 'MARGIN', pct: 50 });
  await expect(page.getByText('Close sent: e2e')).toBeVisible();
  expect(seen.blocked).toEqual([]);
});

test('Positions window: a refused close shows the server error and an unknown outcome says to check the book', async ({ page }) => {
  const seen = await install(page, { positions: [SHORT_PE], closeReply: { status: 504, body: { success: false, unknown: true, error: 'Order status unknown' } } });
  page.on('dialog', d => { void d.accept(); });
  await openPositions(page);
  await page.getByRole('button', { name: 'Close 100% of NIFTY-Nov2026-22000-PE' }).click();
  await expect(page.getByText(/Order status unknown — check Orders\/Positions before retrying/)).toBeVisible();
  expect(seen.closes).toHaveLength(1);
});

test('Header warns when the server watcher has gone quiet while a position is live, and not otherwise', async ({ page }) => {
  await install(page, { openLong: true, watcherLagMs: 30_000 });
  await gotoSingle(page);
  await expect(page.getByText('Server not tracking your trades')).toBeVisible();
});

test('No "not tracking" warning when the watcher is ticking, or when nothing is live', async ({ page }) => {
  await install(page, { openLong: true, watcherLagMs: 1_000 });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await expect(page.getByText('Server not tracking your trades')).toHaveCount(0);
  const idle = await page.context().newPage();
  await install(idle, { watcherLagMs: 30_000 });
  await gotoSingle(idle);
  await expect(idle.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await expect(idle.getByText('Server not tracking your trades')).toHaveCount(0);
});

test('Strike choices carry their distance from ATM (ATM, ATM+1, ATM-2 …)', async ({ page }) => {
  await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  const strike = page.getByLabel('Strike');
  await expect(strike.locator('option', { hasText: '23200' })).toHaveText(/23200\s+·\s+ATM$/);
  await expect(strike.locator('option', { hasText: '23250' })).toHaveText(/ATM\+1$/);
  await expect(strike.locator('option', { hasText: '23100' })).toHaveText(/ATM-2$/);
});

test('Pair strangle: the call and put offsets are set separately and the legs show their distance from ATM', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByRole('button', { name: 'Strangle', exact: true }).click();
  const call = page.getByLabel('Call strikes above the centre', { exact: true }), put = page.getByLabel('Put strikes below the centre', { exact: true });
  await call.fill('1'); await call.blur();
  await put.fill('2'); await put.blur();
  await expect(page.getByText('CE 23250 (ATM+1) · PE 23100 (ATM-2)')).toBeVisible();
  await page.getByRole('button', { name: /^Buy at 21[0-9]/ }).first().click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'pair').length).toBe(1);
  expect(seen.posts.find(b => b.action === 'pair')).toMatchObject({ op: 'arm', structure: 'strangle', ceStrike: 23250, peStrike: 23100 });
  // both offsets 0 would put the CE on the PE: refused in the page
  await call.fill('0'); await call.blur();
  await put.fill('0'); await put.blur();
  await expect(page.getByText('A strangle needs the call above the put')).toBeVisible();
  expect(seen.blocked).toEqual([]);
});

test('The trades strip shows only the number of open positions (armed levels are not positions)', async ({ page }) => {
  const seen = await install(page, { openLong: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await expect(page.getByLabel('Open positions', { exact: true })).toHaveText('1');
  await page.getByRole('button', { name: 'Buy at 23180' }).click();             // an armed level: still 1 open position
  await expect.poll(() => seen.posts.filter(b => b.action === 'arm').length).toBe(1);
  await expect(page.getByLabel('Open positions', { exact: true })).toHaveText('1');
  await expect(page.getByText('View on ladder')).toHaveCount(0);
  // The strip also carries the ladder's total P&L (open leg 65 units, 110 -> 120 = +650), the same figure as the header chip.
  await expect(page.getByTitle(/This ladder's total P&L/)).toContainText('+₹650');
});

test('The open positions count and total P&L are the same in XY, Plain and Pair modes', async ({ page }) => {
  // XY +650 (110 -> 120), Plain +975 (85 -> 100), short strangle -1950: three positions, -₹325, whichever ladder is showing.
  await install(page, { openAll: true });
  await gotoSingle(page);
  const strip = () => page.getByLabel('Open positions', { exact: true });
  for (const [name, heading] of [['Index', /23200\.00/], ['Plain', /23200/], ['Pair', /23200/]] as const) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expect(strip()).toHaveText('3');
    await expect(page.getByTitle(/This ladder's total P&L/)).toContainText('−₹325');
  }
});

test('Every ladder shows its open positions and total P&L, even with nothing open, in every mode', async ({ page }) => {
  await install(page);
  await page.goto('/price-ladder');                                   // two ladders by default
  await expect(page.getByLabel('Underlying')).toHaveCount(2);
  await expect(page.getByLabel('Open positions', { exact: true })).toHaveCount(2);
  await expect(page.getByTitle(/This ladder's total P&L/)).toHaveCount(2);
  await expect(page.getByLabel('Open positions', { exact: true }).nth(1)).toHaveText('0');
  for (const name of ['Plain', 'Pair', 'Index']) {
    await page.getByRole('button', { name, exact: true }).nth(1).click();   // ladder 2's mode
    await expect(page.getByLabel('Open positions', { exact: true })).toHaveCount(2);
  }
});

test('Pair mode has Buy Market / Sell Market: both legs of the shown structure at market, no level, no bracket', async ({ page }) => {
  const seen = await install(page);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByRole('button', { name: 'Strangle', exact: true }).click();
  const call = page.getByLabel('Call strikes above the centre', { exact: true }), put = page.getByLabel('Put strikes below the centre', { exact: true });
  await call.fill('1'); await call.blur();
  await put.fill('2'); await put.blur();
  await expect(page.getByText('CE 23250 (ATM+1) · PE 23100 (ATM-2)')).toBeVisible();
  await page.getByRole('button', { name: 'Sell at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'pair' && b.op === 'market').length).toBe(1);
  const sent = seen.posts.find(b => b.op === 'market')!;
  expect(sent).toMatchObject({ action: 'pair', op: 'market', mode: 'sim', broker: 'dhan', side: 'SELL', lots: 1, structure: 'strangle', ceStrike: 23250, peStrike: 23100 });
  expect(sent).not.toHaveProperty('level');
  expect(sent).not.toHaveProperty('bracket');
  await page.getByRole('button', { name: 'Buy at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'market').length).toBe(2);
  expect(seen.posts.filter(b => b.op === 'market')[1]).toMatchObject({ side: 'BUY' });
  expect(seen.blocked).toEqual([]);
});

test('Pair mode REAL: the first Buy / Sell Market asks before sending both legs', async ({ page }) => {
  const seen = await install(page, { liveArmed: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: 'Sell at market' }).click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  expect(seen.posts.filter(b => b.op === 'market')).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'market').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'market')).toMatchObject({ mode: 'real', side: 'SELL', structure: 'straddle' });
});

test('Pair ladder has the Net Pos / P&L / Avg Price panel with 25 / 50 / 75 / Exit for the pairs on its legs', async ({ page }) => {
  const seen = await install(page, { openAll: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByLabel('Pair net position')).toHaveText('-1 lot');                // one short 1-lot strangle on these legs
  await expect(page.getByText('190.00', { exact: true })).toBeVisible();                  // combined entry 100 + 90
  await expect(page.getByRole('button', { name: 'Partial exit' })).toBeDisabled();         // 25/50/75% of 1 lot are all under a lot: nothing to part-exit
  await page.getByRole('button', { name: /^Exit \(1L\)$/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'exitShare').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'exitShare')).toMatchObject({ action: 'pair', op: 'exitShare', ids: ['pp1'], pct: 100 });
  expect(seen.blocked).toEqual([]);
});

test('OI bars: call OI is drawn left of the Price column and put OI right of it', async ({ page }) => {
  await install(page, { oi: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  const ce = page.getByTitle(/^23200 CE OI/), pe = page.getByTitle(/^23200 PE OI/);
  await expect(ce).toHaveCount(1);
  await expect(pe).toHaveCount(1);
  const [c, p] = [await ce.boundingBox(), await pe.boundingBox()];
  expect(c!.x + c!.width).toBeLessThanOrEqual(p!.x);          // the call bar ends before the put bar starts: call left, put right
});

test('OI bars: they start on the outer edges (call far left, put far right); the Settings choice "Beside price" moves them to the Price column and is remembered', async ({ page }) => {
  await install(page, { oi: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  const ce = page.getByTitle(/^23200 CE OI/), pe = page.getByTitle(/^23200 PE OI/);
  await expect(ce).toHaveCount(1);
  const row = ce.locator('xpath=ancestor::div[contains(@class,"grid-cols")][1]');
  const rowBox = (await row.boundingBox())!;
  const c0 = (await ce.boundingBox())!, p0 = (await pe.boundingBox())!;
  expect(Math.round(c0.x - rowBox.x)).toBeLessThanOrEqual(1);                                      // call bar starts at the row's left edge
  expect(Math.round(rowBox.x + rowBox.width - (p0.x + p0.width))).toBeLessThanOrEqual(1);          // put bar ends at the right edge
  await page.getByTitle('Configure Price Ladder trading cutoff & session thresholds').click();
  await page.getByRole('button', { name: 'Beside price' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await ce.boundingBox())!.x + (await ce.boundingBox())!.width).toBeGreaterThan(rowBox.x + rowBox.width * 0.3);   // now ends at the Price column (~42 % across)
  expect(await page.evaluate(() => localStorage.getItem('price-ladder-defaults'))).toContain('"oiPlace":"center"');
});

// ── Basket mode ──
async function openBasketMode(page: Page, opts: Parameters<typeof install>[1] = {}) {
  const seen = await install(page, opts);
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Basket', exact: true }).click();
  await expect(page.getByLabel('Basket strategy')).toHaveValue('iron-condor');
  return seen;
}

test('Basket mode: the iron condor is built around ATM with its net credit as the ladder axis', async ({ page }) => {
  await openBasketMode(page);
  const legs = page.getByLabel('Basket legs').locator('li');
  await expect(legs).toHaveCount(4);
  // sells 3 strikes out, buys 6 out, both sides (ATM 23200, step 50): 23350 CE / 23500 CE / 23050 PE / 22900 PE
  await expect(legs.nth(0)).toContainText('23350CE');
  await expect(legs.nth(1)).toContainText('23500CE');
  await expect(legs.nth(2)).toContainText('23050PE');
  await expect(legs.nth(3)).toContainText('22900PE');
  await expect(page.getByText('net credit')).toBeVisible();                           // 60 - 5 + 40 - 5 = 90
  await expect(page.getByTitle(/Net premium: the strategy/)).toContainText('90.00');
});

test('Basket mode: legs can be edited, added, removed and reset in the pop-up', async ({ page }) => {
  await openBasketMode(page);
  await page.getByRole('button', { name: 'Edit legs' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit basket legs' });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Remove leg 4').click();
  await expect(page.getByLabel('Basket legs').locator('li')).toHaveCount(3);
  await dlg.getByLabel('Leg 1 ratio').selectOption('2');
  await expect(page.getByLabel('Basket legs').locator('li').nth(0)).toContainText('×2');
  await dlg.getByRole('button', { name: 'Add leg' }).click();
  await expect(page.getByLabel('Basket legs').locator('li')).toHaveCount(4);
  await dlg.getByLabel('Leg 4 side').selectOption('SELL');
  await dlg.getByLabel('Leg 4 strike').selectOption('23000');
  await expect(page.getByText(/edited/).first()).toBeVisible();
  await dlg.getByRole('button', { name: 'Reset to template' }).click();
  await expect(page.getByLabel('Basket legs').locator('li').nth(3)).toContainText('22900PE');
  await expect(page.getByLabel('Basket legs').locator('li').nth(0)).not.toContainText('×2');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toHaveCount(0);
});

test('Basket mode: Sell at a level above the credit arms the edited legs and Market sends them now', async ({ page }) => {
  const seen = await openBasketMode(page);
  await page.getByRole('button', { name: /^Sell at 9[2-9]/ }).first().click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'basket' && b.op === 'arm').length).toBe(1);
  const arm = seen.posts.find(b => b.op === 'arm')!;
  expect(arm).toMatchObject({ action: 'basket', op: 'arm', mode: 'sim', broker: 'dhan', side: 'SELL', lots: 1, strategy: 'iron-condor', underlying: 'NIFTY' });
  expect(arm.legs).toEqual([
    { side: 'SELL', opt: 'CE', strike: 23350, ratio: 1 }, { side: 'BUY', opt: 'CE', strike: 23500, ratio: 1 },
    { side: 'SELL', opt: 'PE', strike: 23050, ratio: 1 }, { side: 'BUY', opt: 'PE', strike: 22900, ratio: 1 },
  ]);
  expect(arm).toHaveProperty('bracket');
  await page.getByRole('button', { name: 'Buy at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'market').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'market')).toMatchObject({ action: 'basket', side: 'BUY', mode: 'sim' });
  expect(seen.blocked).toEqual([]);
});

test('Basket mode: an open basket shows in Net Pos, the strip and the Exit buttons', async ({ page }) => {
  const seen = await openBasketMode(page, { openBasket: true });
  await expect(page.getByLabel('Basket net position')).toHaveText('-2 lots');             // a short condor, 2 lots
  await expect(page.getByLabel('Open positions', { exact: true })).toHaveText('1');
  await expect(page.getByText('90.00', { exact: true }).first()).toBeVisible();           // entry net
  await page.getByRole('button', { name: 'Partial exit' }).click();
  await expect(page.getByRole('menuitem', { name: 'Exit 25%' })).toBeDisabled();           // 25% of 2 lots is under a lot
  await page.getByRole('menuitem', { name: 'Exit 50%' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'exitShare').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'exitShare')).toMatchObject({ action: 'basket', op: 'exitShare', ids: ['bk1'], pct: 50 });
  await page.getByRole('button', { name: /^Exit \(2L\)$/ }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'exitShare').length).toBe(2);
  await expect(page.getByText('Basket orders & positions')).toBeVisible();
  expect(seen.blocked).toEqual([]);
});

test('Basket mode REAL: needs the daily arm; the first order asks and says hedges go first; the request carries mode real', async ({ page }) => {
  const seen = await openBasketMode(page, { liveArmed: true });
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await page.getByRole('button', { name: /^Sell at 9[2-9]/ }).first().click();
  await expect(page.getByText('Place a REAL-money order?')).toBeVisible();
  await expect(page.getByText(/BUY legs at MARKET first, the SELL legs only after they fill/)).toBeVisible();
  expect(seen.posts.filter(b => b.action === 'basket')).toEqual([]);
  await page.getByRole('button', { name: 'Place REAL order' }).click();
  await expect.poll(() => seen.posts.filter(b => b.action === 'basket' && b.op === 'arm').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'arm')).toMatchObject({ action: 'basket', mode: 'real', side: 'SELL' });
  // a REAL Market order asks only once per page load (the first confirm covers it)
  await page.getByRole('button', { name: 'Buy at market' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'market').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'market')).toMatchObject({ mode: 'real', side: 'BUY' });
  expect(seen.blocked).toEqual([]);
});

test('Basket mode REAL without the daily arm: choosing REAL asks to arm and nothing is sent', async ({ page }) => {
  const seen = await openBasketMode(page, { liveArmed: false });
  await page.getByRole('button', { name: 'REAL', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/Arm LIVE · REAL MONEY for today\?/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Sell at 9[2-9]/ }).first()).toBeEnabled();   // still SIM: the ladder works
  expect(seen.posts.filter(b => b.action === 'basket')).toEqual([]);
});

test('Pair mode has a Cancel all: the toolbar button and the table header cancel every armed pair, open ones are untouched', async ({ page }) => {
  const seen = await install(page, { armedPairs: 3 });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel all (3)' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Cancel all armed (3)' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel all (3)' }).click();
  await expect.poll(() => seen.posts.filter(b => b.op === 'cancelAll').length).toBe(1);
  expect(seen.posts.find(b => b.op === 'cancelAll')).toMatchObject({ action: 'pair', op: 'cancelAll', ids: ['ap0', 'ap1', 'ap2'] });
  await expect(page.getByRole('button', { name: 'Cancel all (0)' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Cancel all armed/ })).toHaveCount(0);
  expect(seen.blocked).toEqual([]);
});

test('A pair on other strikes is not drawn on the ladder: the page says so and one click puts it there', async ({ page }) => {
  await install(page, { offPair: true });
  await gotoSingle(page);
  await expect(page.getByRole('heading', { name: /23200\.00/ })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText(/1 live pair\(s\) are on other strikes/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'View on ladder' })).toBeVisible();
  await page.getByRole('button', { name: /^Show 23300CE\/23100PE strangle$/ }).click();
  await expect(page.getByText('CE 23300 (ATM+2) · PE 23100 (ATM-2)')).toBeVisible();
});
