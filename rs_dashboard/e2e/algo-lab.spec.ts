import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn, type Call } from './support';
import { applyOp, emptyState, type LedgerOp } from '../lib/algoLab/ledger';
import { strategyConfig, STRATEGIES } from '../lib/algoLab/registry';
import type { AlgoStateFile } from '../lib/algoLab/types';

// Algo Lab (/algo-lab): the strategy picker, both tabs, the schema-generated rules drawer and a SIM manual entry/close.
// Every /api/* call is answered here; any non-GET this mock does not handle is refused with 599 and fails the test,
// so nothing can reach a real order route. There is deliberately no REAL-order case.

const KEY = STRATEGIES[0].key;
const { fields, defaults } = strategyConfig(STRATEGIES[0]);

interface Mock {
  ledger: AlgoStateFile;
  writes: Call[];
  blocked: Call[];
}

const quotes = () => {
  const strikes: Record<string, unknown> = {};
  for (let s = 24900; s <= 25100; s += 50) {
    strikes[String(s)] = { strike: s, ce: { ltp: 100 + (25000 - s) / 10, oi: 1000, volume: 500 }, pe: { ltp: 90 - (25000 - s) / 10, oi: 900, volume: 400 } };
  }
  return { updated_at: new Date().toISOString(), underlying: 'NIFTY', expiry: '2026-10-20', spot: 25000, atm: 25000, straddle_premium: 190, strikes };
};

const trade = {
  n: 1, contract: '25000CE', strike: 25000, option: 'CE', side: 'BUY', lots: 1, qty: 65, entryTime: '09:40', decisionPrice: 100, entryPrice: 100,
  exitTime: '10:05', exitPrice: 140, exitKind: 'TARGET', exitReason: 'TARGET ₹140', gross: 2600, costs: 64, net: 2536, initialStop: 80, target: 140,
  stopAtExit: 100, best: 141, maxAdverse: 2, holdMin: 25, score: 70, bias: 'BULLISH', warmupBars: 375, cols: { ema: 95, vwap: 96, strength: 4.5, age: 1, steps: 0 },
};
const day = {
  date: '2026-10-13', weekday: 'Tue', expiry: '2026-10-20', dte: 7, source: 'db', lotSize: 65, trades: [trade], gross: 2600, costs: 64, net: 2536,
  wins: 1, losses: 0, haltedAt: null, signalMinutes: 3, spotOpen: 25000, spotClose: 25100, warmupSessions: 1, notes: [],
};
const checks = ['gross', 'net', 'time', 'levels', 'entryFill', 'exitFill', 'slots', 'side', 'lock'].map((id) => ({ id, label: id, rule: id, checked: 1, failures: 0, examples: [] }));

async function install(page: Page, m: Mock) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : ((req.postDataJSON() as Record<string, unknown> | null) ?? null);

    if (p === `/api/algo-lab/${KEY}/state`) {
      if (method === 'GET') return json(route, { success: true, ...m.ledger });
      m.writes.push({ method, path: p, search: u.search, body });
      try {
        m.ledger = applyOp(m.ledger, body as unknown as LedgerOp, fields, defaults);
        return json(route, { success: true, ...m.ledger });
      } catch (e) {
        return json(route, { success: false, error: String((e as Error).message) }, 400);
      }
    }
    if (p === `/api/algo-lab/${KEY}/backtest` && method === 'GET') {
      return json(route, {
        success: true, running: false, status: { state: 'done', message: 'Up to date through 2026-10-13' }, dbRange: { earliest: '2020-12-31', latest: '2026-10-13' },
        missing: [], configKey: 'K', rulesChanged: false,
        store: {
          from: '2026-10-13', to: '2026-10-13', window: 'week', updatedAt: '2026-10-18T10:00:00Z', config: defaults, failures: {},
          audit: { at: '2026-10-18T10:00:00Z', configKey: 'K', sessions: 1, trades: 1, sessionsWithBars: 1, checks, warmup: { Tue: { sessions: 1, partial: 0 } }, coldEntries: { trades: 0, net: 0, minBars: 100 } },
          days: [day],
        },
      });
    }
    if (p === '/api/algo-lab/account') return json(route, { success: true, total: 0, limit: 10000 });
    if (p === '/api/algo-lab/spot') return json(route, { success: true, date: new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10), bars: [] });
    if (p === '/api/options/expiries') return json(route, { success: true, data: ['2026-10-20'] });
    if (p === '/api/options/live' && method === 'GET') return json(route, { success: true, status: { status: 'RUNNING' }, quotes: quotes() });
    if (p === '/api/options/live' && method === 'POST') return json(route, { success: true });
    if (p === '/api/scalper/lookup') return json(route, { success: true, data: { lotSize: 65, strikes: { '25000': { ceId: '111', peId: '211' } } } });
    if (p === '/api/bearish-strikes/bars') return json(route, { success: true, bars: {} });
    if (method !== 'GET') {
      m.blocked.push({ method, path: p, search: u.search, body });
      return route.fulfill({ status: 599, body: 'blocked by e2e mock' });
    }
    return json(route, { success: false, error: 'not mocked' });
  });
}

/** Session window wide enough that the engine's EOD square-off cannot fire mid-test, whatever the wall clock. */
const ALL_DAY = { entryStart: '00:01', entryEnd: '23:57', eodExit: '23:58' };
const newMock = (cfg: Record<string, string> = ALL_DAY): Mock => {
  const ledger = emptyState(KEY, defaults);
  return { ledger: { ...ledger, config: { ...ledger.config, ...cfg } }, writes: [], blocked: [] };
};

test.beforeEach(async ({ context }) => {
  await signIn(context);
});

test('backtest tab: picker, KPIs, trade log and the stored audit', async ({ page }) => {
  const m = newMock();
  await install(page, m);
  await page.goto(`/algo-lab?strategy=${KEY}&tab=backtest`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByLabel('Strategy')).toHaveValue(KEY);
  await expect(page.getByText('+₹2,536').first()).toBeVisible();
  await expect(page.getByText('ALL 9 CHECKS PASSED')).toBeVisible();
  await page.getByRole('button', { name: /Day-wise trade log/ }).click();
  await page.getByRole('row', { name: /2026-10-13 Tue/ }).click();
  await expect(page.getByRole('cell', { name: 'TARGET ₹140' })).toBeVisible();
  expect(m.blocked).toEqual([]);
});

test('rules drawer: generated from the schema, commits on blur, REAL needs a confirm', async ({ page }) => {
  const m = newMock();
  await install(page, m);
  await page.goto(`/algo-lab?strategy=${KEY}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Engine OFF' })).toBeVisible(); // hydrated: the ledger has loaded
  await page.getByRole('button', { name: 'Rules', exact: true }).first().click();
  const lots = page.getByLabel('Lots per trade');
  await lots.fill('2');
  expect(m.writes.filter((w) => (w.body as { op?: string })?.op === 'setConfig')).toHaveLength(0); // not while typing
  await lots.press('Enter');
  await expect.poll(() => m.ledger.config.lotsPerTrade).toBe(2);
  await expect(page.getByLabel('Option EMA period')).toBeVisible(); // a strategy field, from its schema
  page.once('dialog', (d) => void d.dismiss());
  await page.getByRole('button', { name: 'REAL (live orders)' }).click();
  expect(m.ledger.mode).toBe('SIM');
  expect(m.blocked).toEqual([]);
});

test('live tab: a SIM manual entry opens a BUY row and Close books it, with no order route called', async ({ page }) => {
  const m = newMock();
  await install(page, m);
  await page.goto(`/algo-lab?strategy=${KEY}`, { waitUntil: 'domcontentloaded' });
  const row = page.getByRole('row').filter({ hasText: /^25000\s*CE/ });
  await row.getByRole('button', { name: 'Buy' }).click();
  await expect.poll(() => m.ledger.positions.length).toBe(1);
  const pos = m.ledger.positions[0];
  expect(pos.mode).toBe('SIM');
  expect(pos.side).toBe('BUY');
  expect(pos.legs[0]).toMatchObject({ strike: 25000, option: 'CE', qty: 65 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => m.ledger.positions[0].status).toBe('CLOSED');
  expect(m.writes.some((w) => w.path.includes('order'))).toBe(false);
  expect(m.blocked).toEqual([]);
});

test('live tab: the engine squares a SIM position off by itself once the EOD cutoff has passed', async ({ page }) => {
  const m = newMock({ entryStart: '00:01', entryEnd: '00:02', eodExit: '00:03' });
  await install(page, m);
  await page.goto(`/algo-lab?strategy=${KEY}`, { waitUntil: 'domcontentloaded' });
  test.skip(new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16) < '00:04', 'needs an IST time after 00:03');
  const row = page.getByRole('row').filter({ hasText: /^25000\s*CE/ });
  await row.getByRole('button', { name: 'Buy' }).click();
  await expect.poll(() => m.ledger.positions[0]?.status).toBe('CLOSED');
  expect(m.ledger.positions[0].exitKind).toBe('EOD');
  expect(m.blocked).toEqual([]);
});
