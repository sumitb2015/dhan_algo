import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// /gearbox (Gearbox Drive): the driving-game page over CRUDEOIL(M) options. Every /api call is mocked in the browser; any non-GET
// the mock does not handle is refused (599) and listed, and /api/gearbox/trade is answered by the mock alone, so no case here can
// reach a broker. The mock never books a REAL order: REAL cases only check that the buttons lock and unlock.

const FUT = { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-16' };
const CE = { kind: 'options', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-16', strike: 5400, side: 'CE' };
const PE = { kind: 'options', symbol: 'CRUDEOILM', name: 'CRUDEOILM', expiry: '2026-12-16', strike: 5400, side: 'PE' };
const MAP = { LONG: { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' }, SHORT: { action: 'BUY', opt: 'PE', offset: 0, expiry: 'nearest' } };

type Row = Record<string, unknown>;
type Opts = { mode?: 'SIM' | 'REAL'; tf?: 1 | 3 | 5; bars?: number; staleFeed?: boolean; rows?: Row[]; noBook?: boolean; map?: typeof MAP };

function heldRow(mode: 'SIM' | 'REAL', dir: 'LONG' | 'SHORT' = 'LONG'): Row {
  return {
    id: 'gbx-1', mode, broker: 'dhan', underlying: 'CRUDEOILM', dir, leg: MAP[dir], target: dir === 'LONG' ? CE : PE,
    lots: 1, units: 1, unitsPerLot: 10, entry: 120, entryDecision: 5400, entryAt: Date.now() - 60_000, day: '2026-11-20',
    status: 'open', lastLtp: 121,
  };
}

/** Deterministic 1-minute history ending at the last full minute (or 30 min ago for a stale feed). */
function history(n: number, stale: boolean) {
  const end = Math.floor(Date.now() / 60_000) * 60 - 60 - (stale ? 1800 : 0);
  const out = [];
  let p = 5400;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 9) * 3 + ((i * 7919) % 5) - 2;
    out.push({ t: end - (n - 1 - i) * 60, ce: p, pe: 0, straddle: p, vol: 10 + (i % 7), h: p + 2, l: p - 2 });
  }
  return out;
}

async function installMock(page: Page, o: Opts = {}) {
  const trades: Record<string, unknown>[] = [];
  const ops: Record<string, unknown>[] = [];
  const blocked: string[] = [];
  const st = {
    rev: 1, mode: o.mode ?? 'SIM', rows: [...(o.rows ?? [])] as Row[],
    config: { underlying: 'CRUDEOILM', broker: 'dhan', lots: 1, tf: o.tf ?? 1, map: o.map ?? MAP, slPts: null, tgtPts: null, maxLoss: null, maxTrades: null },
  };
  const ledger = () => ({ rev: st.rev, updatedAt: Date.now(), mode: st.mode, config: st.config, rows: st.rows, log: [], lastSquareOffDay: null });
  const bars = history(o.bars ?? 260, !!o.staleFeed);
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    if (p === '/api/gearbox/state' && method === 'GET') {
      const live = st.rows.find(r => r.status === 'open');
      return json(route, {
        success: true, ledger: ledger(), future: FUT, contracts: { LONG: CE, SHORT: PE }, contractErrors: { LONG: null, SHORT: null }, expiries: ['2026-12-16', '2027-01-15'],
        prices: {
          future: { ltp: 5400, ageMs: 400 }, contracts: { LONG: { ltp: 120, ageMs: 400 }, SHORT: { ltp: 110, ageMs: 400 } },
          rows: live ? { [String(live.id)]: { ltp: 125, ageMs: 400 } } : {},
        },
        caps: { REAL: 1, SIM: 10 }, unitsPerLot: 10, today: '2026-11-20',
        session: { open: 900, close: 2355, autoExit: 2340, autoExitLabel: '23:40' },
      });
    }
    if (p === '/api/gearbox/state' && method === 'POST') {
      const b = req.postDataJSON() as Record<string, unknown>;
      ops.push(b);
      if (b.op === 'setMode') st.mode = b.mode as 'SIM' | 'REAL';
      st.rev++;
      return json(route, { success: true, ledger: ledger() });
    }
    if (p === '/api/gearbox/trade' && method === 'POST') {
      const b = req.postDataJSON() as Record<string, unknown>;
      trades.push(b);
      if (st.mode !== 'SIM') return json(route, { success: false, error: 'mock: REAL never books' }, 409);
      if (o.noBook) return json(route, { success: true, ledger: ledger() });
      if (b.action === 'open') st.rows = [...st.rows, { ...heldRow('SIM', b.dir as 'LONG' | 'SHORT'), id: `gbx-${trades.length}` }];
      if (b.action === 'exit') st.rows = st.rows.map(r => (r.status === 'open' ? { ...r, status: 'closed', exit: 125, exitAt: Date.now() } : r));
      st.rev++;
      return json(route, { success: true, ledger: ledger() });
    }
    if (p === '/api/straddle-pnf' && method === 'GET') {
      return json(route, {
        success: true, mode: 'contract', strikes: [0], name: 'CRUDEOILM FUT 16 Dec 26', instrument: { segment: 'MCX_COMM', security_id: '999' },
        errors: {}, dataDate: '2026-11-20', bars: { 0: bars },
      });
    }
    if (p === '/api/straddle-pnf/live' && method === 'GET') return json(route, { success: true, legs: [{ quote: null, last: null }] });
    if (method === 'GET') return json(route, { success: true });
    blocked.push(`${method} ${p}`);
    return route.fulfill({ status: 599, body: JSON.stringify({ success: false, error: `unmocked ${method} ${p}` }) });
  });
  return { trades, ops, blocked, st };
}

const long = (page: Page) => page.getByTestId('gb-long');
const short = (page: Page) => page.getByTestId('gb-short');
const exit = (page: Page) => page.getByTestId('gb-exit');

test.beforeEach(async ({ context }) => { await signIn(context); });

test('disabled while warming up', async ({ page }) => {
  const { blocked, trades } = await installMock(page, { bars: 100, tf: 5 });
  await page.goto('/gearbox');
  await expect(page.getByTestId('gb-reason')).toContainText('Warming up');
  await expect(page.getByTestId('gb-warming')).toContainText('closed bars');
  await expect(page.getByTestId('gb-lamps')).toHaveCount(0);
  await expect(page.getByTestId('gb-knob')).toHaveCount(0);
  await expect(long(page)).toBeDisabled();
  await expect(short(page)).toBeDisabled();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  expect(trades).toEqual([]);
  expect(blocked).toEqual([]);
});

test('SIM open and exit', async ({ page }) => {
  const { trades, blocked } = await installMock(page);
  await page.goto('/gearbox');
  await expect(long(page)).toBeEnabled();
  await long(page).click();
  await expect.poll(() => trades.length).toBe(1);
  expect(trades[0]).toMatchObject({ action: 'open', dir: 'LONG', underlying: 'CRUDEOILM', mode: 'SIM', broker: 'dhan' });
  await expect(page.getByTestId('gb-held')).toContainText('LONG');
  await expect(page.getByTestId('gb-held')).toContainText('5400 CE');
  await exit(page).click();
  await expect.poll(() => trades.length).toBe(2);
  expect(trades[1]).toMatchObject({ action: 'exit', underlying: 'CRUDEOILM' });
  await expect(page.getByTestId('gb-held')).toContainText('Flat');
  expect(blocked).toEqual([]);
});

test('REAL needs arming on every page load', async ({ page }) => {
  const { trades, blocked } = await installMock(page, { mode: 'REAL' });
  await page.goto('/gearbox');
  await expect(page.getByTestId('gb-reason')).toContainText('not armed');
  await expect(long(page)).toBeDisabled();
  await expect(short(page)).toBeDisabled();
  let asked = '';
  page.once('dialog', d => { asked = d.message(); void d.accept(); });
  await page.getByRole('button', { name: 'Arm real money' }).click();
  await expect(long(page)).toBeEnabled();
  expect(asked).toMatch(/REAL/);
  // a REAL click asks again; dismissing it sends nothing
  page.once('dialog', d => { void d.dismiss(); });
  await long(page).click();
  await page.waitForTimeout(300);
  expect(trades).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('gb-reason')).toContainText('not armed');
  await expect(long(page)).toBeDisabled();
  expect(blocked).toEqual([]);
});

test('a held key sends once', async ({ page }) => {
  // the mock books nothing, so a repeated keydown that got through would send a second open
  const { trades } = await installMock(page, { noBook: true });
  await page.goto('/gearbox');
  await expect(long(page)).toBeEnabled();
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.down('ArrowUp');
  await expect.poll(() => trades.length).toBe(1);
  await page.keyboard.down('ArrowUp');   // auto-repeat: repeat = true
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(500);
  await page.keyboard.up('ArrowUp');
  expect(trades.length).toBe(1);
  expect(trades[0]).toMatchObject({ action: 'open', dir: 'LONG' });
});

test('reload restores the held leg', async ({ page }) => {
  const { blocked } = await installMock(page, { mode: 'REAL', rows: [heldRow('REAL', 'SHORT')] });
  await page.goto('/gearbox');
  await expect(page.getByTestId('gb-held')).toContainText('SHORT');
  await expect(page.getByTestId('gb-held')).toContainText('5400 PE');
  await expect(exit(page)).toBeEnabled();
  await expect(page.getByLabel('Underlying')).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId('gb-held')).toContainText('SHORT');
  await expect(exit(page)).toBeEnabled();
  expect(blocked).toEqual([]);
});

test('a stale feed disables REAL entries', async ({ page }) => {
  const { trades } = await installMock(page, { mode: 'REAL', staleFeed: true });
  await page.goto('/gearbox');
  page.once('dialog', d => { void d.accept(); });
  await page.getByRole('button', { name: 'Arm real money' }).click();
  await expect(page.getByTestId('gb-reason')).toContainText('Feed stale');
  await expect(long(page)).toBeDisabled();
  await expect(short(page)).toBeDisabled();
  expect(trades).toEqual([]);
});

test('the direction map flags SELL legs, legs against their arrow, and lists the expiries', async ({ page }) => {
  const map = { LONG: { action: 'SELL', opt: 'CE', offset: 0, expiry: 'nearest' }, SHORT: { action: 'BUY', opt: 'PE', offset: 0, expiry: 'nearest' } };
  const { blocked } = await installMock(page, { map: map as unknown as typeof MAP });
  await page.goto('/gearbox');
  await expect(page.getByTestId('gb-map-sell-LONG')).toContainText('margin, unlimited risk');
  await expect(page.getByTestId('gb-map-against-LONG')).toBeVisible();   // ↑ with a CE SELL gains on a fall
  await expect(page.getByTestId('gb-map-sell-SHORT')).toHaveCount(0);
  await expect(page.getByTestId('gb-map-against-SHORT')).toHaveCount(0);  // ↓ with a PE BUY is the normal map
  const exp = page.getByLabel('LONG expiry');
  await expect(exp.locator('option')).toHaveText(['Nearest', '2026-12-16', '2027-01-15']);
  expect(blocked).toEqual([]);
});
