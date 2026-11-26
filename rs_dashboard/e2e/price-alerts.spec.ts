import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Price Alerts (header bell): create / pause / delete from the panel, and a fired event arriving on the stream shows a toast
// with "Stop sound". Every /api/* call is mocked in the browser: nothing reaches the alerts server or a broker, and any
// non-GET the mock does not handle is refused with 599.

interface Call { path: string; body: Record<string, unknown> | null }
interface State { calls: Call[]; blocked: Call[]; alerts: Record<string, unknown>[]; log: Record<string, unknown>[]; streamLog: Record<string, unknown>[] | null; version: number }

const view = (s: State, log = s.log) => ({ alerts: s.alerts, armedToday: false, defaultSoundSec: 3, version: s.version, log });

function alertFrom(id: string, body: Record<string, unknown>) {
  const a = body.alert as Record<string, unknown>;
  const inst = a.instrument as Record<string, unknown>;
  return {
    id, createdAt: 1, updatedAt: 1,
    instrument: { kind: 'index', segment: 'IDX_I', securityId: '13', displayName: inst.symbol, underlying: inst.symbol, expiry: null, lot: 1 },
    condition: a.condition, value: a.value, trigger: a.trigger, expiresAt: null, soundSec: a.soundSec, message: a.message, action: { kind: 'notify' },
    status: 'active', firedCount: 0, lastFiredAt: null, lastFiredPrice: null,
  };
}

async function mockApi(page: Page, s: State) {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const method = req.method();
    const body = method === 'GET' ? null : (req.postDataJSON() as Record<string, unknown> | null);
    if (p === '/api/price-alerts/stream') {
      // One frame per connection (EventSource reconnects on its own).
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ success: true, data: view(s, s.streamLog ?? s.log) })}\n\n` });
    }
    if (p === '/api/price-alerts' && method === 'GET') return json(route, { success: true, data: view(s) });
    if (p === '/api/price-alerts' && method === 'POST') {
      s.calls.push({ path: p, body });
      const id = String(body?.id ?? '');
      if (body?.action === 'create') s.alerts.push(alertFrom(`a${s.alerts.length + 1}`, body));
      if (body?.action === 'pause') s.alerts = s.alerts.map(a => (a.id === id ? { ...a, status: 'paused' } : a));
      if (body?.action === 'delete') s.alerts = s.alerts.filter(a => a.id !== id);
      s.version += 1;
      return json(route, { success: true, data: view(s) });
    }
    if (method !== 'GET') {
      s.blocked.push({ path: p, body });
      return route.fulfill({ status: 599, contentType: 'application/json', body: '{"success":false,"error":"blocked by e2e safety net"}' });
    }
    return json(route, { success: false, error: 'e2e: unmocked GET' }, 404);
  });
}

const newState = (): State => ({ calls: [], blocked: [], alerts: [], log: [], streamLog: null, version: 1 });

test.describe('Price Alerts', () => {
  test('header bell: create a notify alert, pause it, delete it', async ({ page, context }) => {
    const s = newState();
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Price alerts' }).first().click();
    await expect(page.getByText('Price Alerts', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create alert' }).click();

    const dlg = page.getByRole('dialog', { name: 'Create alert' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('heading')).toContainText('NIFTY');
    await dlg.getByLabel('Condition').selectOption('crossUp');
    await dlg.getByLabel('Value', { exact: true }).fill('24100');
    await dlg.getByLabel('Alarm length in seconds').fill('5');
    await dlg.getByLabel('Message').fill('breakout');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(dlg).toHaveCount(0);

    const create = s.calls.find(c => c.body?.action === 'create');
    expect(create?.body?.alert).toMatchObject({
      instrument: { kind: 'index', symbol: 'NIFTY' }, condition: 'crossUp', value: 24100, trigger: 'once', soundSec: 5, message: 'breakout', action: { kind: 'notify' },
    });

    // the panel comes back with the new alert; the header badge counts it (the open modal panel hides the header from
    // the accessibility tree, hence includeHidden)
    await expect(page.getByText('NIFTY Crossing Up 24,100')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Price alerts, 1 active', includeHidden: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Pause alert' }).click();
    await expect.poll(() => s.calls.some(c => c.body?.action === 'pause' && c.body.id === 'a1')).toBe(true);
    await page.getByRole('button', { name: 'Delete alert' }).click();
    await expect.poll(() => s.calls.some(c => c.body?.action === 'delete' && c.body.id === 'a1')).toBe(true);
    await expect(page.getByText('No alerts yet.', { exact: false })).toBeVisible();
    expect(s.blocked).toEqual([]);
  });

  test('a fired alert on the stream shows a toast with Stop sound; events already in the log on load do not', async ({ page, context }) => {
    const s = newState();
    const old = { id: 'e0', at: 1, alertId: 'a0', symbol: 'NIFTY', condition: 'gt', value: 1, price: 2, message: 'old one', soundSec: 3, action: 'notify' };
    s.log = [old];
    s.streamLog = [old, { id: 'e1', at: 2, alertId: 'a1', symbol: 'NIFTY', condition: 'crossUp', value: 24100, price: 24105.5, message: 'breakout', soundSec: 3, action: 'notify' }];
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });

    const toast = page.getByText('🔔 NIFTY 24,105.5');
    await expect(toast).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop sound' })).toBeVisible();
    await expect(page.getByText('old one')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop sound' }).click();
    expect(s.blocked).toEqual([]);
  });
});
