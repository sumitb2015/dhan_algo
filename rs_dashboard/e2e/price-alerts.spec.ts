import { test, expect, type Page, type Route } from '@playwright/test';
import { json, signIn } from './support';

// Price Alerts (header bell): create / pause / delete from the panel, and a fired event arriving on the stream shows a toast
// with "Stop sound". Every /api/* call is mocked in the browser: nothing reaches the alerts server or a broker, and any
// non-GET the mock does not handle is refused with 599.

interface Call { path: string; body: Record<string, unknown> | null }
interface State { calls: Call[]; blocked: Call[]; alerts: Record<string, unknown>[]; log: Record<string, unknown>[]; streamLog: Record<string, unknown>[] | null; version: number; armed?: boolean }

const view = (s: State, log = s.log) => ({ alerts: s.alerts, armedToday: !!s.armed, defaultSoundSec: 3, version: s.version, log });

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
    if (p === '/api/straddle-pnf/contracts') {
      // master_list answers: CRUDEOILM options 16 Dec / 15 Jan, spot 7856 (ATM 7850); NIFTY options for the index's expiration
      const u = new URL(req.url()).searchParams;
      if (u.get('underlying') === 'CRUDEOILM') {
        const expiry = u.get('expiry') ?? '2027-12-16';
        const spot = u.get('nospot') === '1' ? null : 7856;
        return json(route, { success: true, expiries: ['2027-12-16', '2028-01-14'], expiry, strikes: [7750, 7800, 7850, 7900, 7950], spot, atm: spot ? 7850 : 7850 });
      }
      return json(route, { success: true, expiries: ['2027-12-07', '2027-12-14'], expiry: '2027-12-07', strikes: [], spot: null, atm: null });
    }
    if (p === '/api/price-alerts' && method === 'GET') return json(route, { success: true, data: view(s) });
    if (p === '/api/price-alerts' && method === 'POST') {
      s.calls.push({ path: p, body });
      const id = String(body?.id ?? '');
      if (body?.action === 'create') s.alerts.push(alertFrom(`a${s.alerts.length + 1}`, body));
      if (body?.action === 'pause') s.alerts = s.alerts.map(a => (a.id === id ? { ...a, status: 'paused' } : a));
      if (body?.action === 'delete') s.alerts = s.alerts.filter(a => a.id !== id);
      if (body?.action === 'arm') s.armed = true;
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

/** Open the header's alerts panel. Retried: on a cold dev server under parallel runs the first click can land before the
 *  page has hydrated (the button takes focus, nothing opens). */
async function openPanel(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Price alerts' }).first().click();
    await expect(page.getByText('Price Alerts', { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

const newState = (): State => ({ calls: [], blocked: [], alerts: [], log: [], streamLog: null, version: 1 });

test.describe('Price Alerts', () => {
  test('header bell: create a notify alert, pause it, delete it', async ({ page, context }) => {
    const s = newState();
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });

    await openPanel(page);
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

  test('crude mini option: expiry, ATM strike and expiration are filled in from the contract list', async ({ page, context }) => {
    const s = newState();
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });
    await openPanel(page);
    await page.getByRole('button', { name: 'Create alert' }).click();
    const dlg = page.getByRole('dialog', { name: 'Create alert' });

    // NIFTY index: only the three underlyings; Expiration defaults to the nearest NIFTY expiry
    await expect(dlg.getByRole('radiogroup', { name: 'Underlying' }).getByRole('radio')).toHaveText(['NIFTY', 'CRUDE OIL', 'CRUDE MINI']);
    await expect(dlg.getByLabel('Expiration', { exact: true })).toHaveValue('exp:2027-12-07');

    await dlg.getByRole('radio', { name: 'CRUDE MINI' }).click();
    await expect(dlg.getByRole('radio', { name: 'Index' })).toHaveCount(0);   // crude has no index
    await dlg.getByRole('radio', { name: 'Option' }).click();
    await expect(dlg.getByLabel('Expiry')).toHaveValue('2027-12-16');
    await expect(dlg.getByLabel('Strike')).toHaveValue('7850');
    await expect(dlg.getByLabel('Expiration', { exact: true })).toHaveValue('exp:2027-12-16');
    await dlg.getByLabel('Value', { exact: true }).fill('120');
    await dlg.getByRole('button', { name: 'Create' }).click();
    await expect(dlg).toHaveCount(0);

    const create = s.calls.find(c => c.body?.action === 'create');
    const alert = create?.body?.alert as Record<string, unknown>;
    expect(alert.instrument).toEqual({ kind: 'option', underlying: 'CRUDEOILM', expiry: '2027-12-16', strike: 7850, optType: 'CE' });
    // 16 Dec 2027 is US winter time: MCX closes 23:55 IST = 18:25 UTC
    expect(alert.expiresAt).toBe(Date.parse('2027-12-16T18:25:00Z'));
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

  test('not armed: an open market with an active trade alert shows a reminder that stays until Arm (confirmed) arms today', async ({ page, context }) => {
    const s = newState();
    s.alerts = [{
      id: 't1', createdAt: 1, updatedAt: 1,
      instrument: { kind: 'index', segment: 'IDX_I', securityId: '13', displayName: 'NIFTY', underlying: 'NIFTY', expiry: null, lot: 1 },
      condition: 'crossDown', value: 25800, trigger: 'once', expiresAt: null, soundSec: 3, message: '',
      action: { kind: 'trade', side: 'BUY', lots: 2, product: 'INTRADAY',
        contract: { kind: 'option', segment: 'NSE_FNO', securityId: '47904', displayName: 'NIFTY 01 DEC 26100 CALL', underlying: 'NIFTY', expiry: '2026-12-01', lot: 65, strike: 26100, optType: 'CE' } },
      status: 'active', firedCount: 0, lastFiredAt: null, lastFiredPrice: null,
    }];
    // Thursday 2026-11-26 10:00 IST: NSE open
    await page.clock.setFixedTime(new Date('2026-11-26T04:30:00Z'));
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });

    const reminder = page.getByText('Trade alerts NOT armed — NSE is open');
    await expect(reminder).toBeVisible();
    await expect(page.getByText('1 active trade alert will only notify')).toBeVisible();
    await page.waitForTimeout(8000);
    await expect(reminder).toBeVisible(); // not a 4 s toast: it stays

    // a cancelled confirm sends nothing and the reminder comes back (only × dismisses it for the day)
    page.once('dialog', d => void d.dismiss());
    await page.getByRole('button', { name: 'Arm', exact: true }).click();
    await expect(reminder).toHaveCount(1); // the closed one fades out, the re-shown one stays
    await expect(reminder).toBeVisible();
    expect(s.calls.filter(c => c.body?.action === 'arm')).toEqual([]);

    page.once('dialog', d => { expect(d.message()).toContain('Arm REAL orders for today?'); void d.accept(); });
    await page.getByRole('button', { name: 'Arm', exact: true }).click();
    await expect.poll(() => s.calls.filter(c => c.body?.action === 'arm').length).toBe(1);
    await expect(reminder).toHaveCount(0);
    expect(s.blocked).toEqual([]);
  });

  test('not armed reminder: never for notify-only alerts, never before the market opens', async ({ page, context }) => {
    const s = newState();
    const nifty = { kind: 'index', segment: 'IDX_I', securityId: '13', displayName: 'NIFTY', underlying: 'NIFTY', expiry: null, lot: 1 };
    s.alerts = [{
      id: 'n1', createdAt: 1, updatedAt: 1, instrument: nifty,
      condition: 'crossDown', value: 25800, trigger: 'once', expiresAt: null, soundSec: 3, message: '', action: { kind: 'notify' },
      status: 'active', firedCount: 0, lastFiredAt: null, lastFiredPrice: null,
    }];
    await page.clock.setFixedTime(new Date('2026-11-26T04:30:00Z'));   // 10:00 IST, NSE open
    await signIn(context);
    await mockApi(page, s);
    await page.goto('/movers-plus', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await expect(page.getByText(/Trade alerts NOT armed/)).toHaveCount(0);

    // a trade alert at 09:00 IST: NSE not open yet
    s.alerts = [{ ...s.alerts[0], id: 't2', action: { kind: 'trade', side: 'BUY', lots: 1, product: 'INTRADAY',
      contract: { kind: 'option', segment: 'NSE_FNO', securityId: '47904', displayName: 'NIFTY 01 DEC 26100 CALL', underlying: 'NIFTY', expiry: '2026-12-01', lot: 65 } } }];
    await page.clock.setFixedTime(new Date('2026-11-26T03:30:00Z'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await expect(page.getByText(/Trade alerts NOT armed/)).toHaveCount(0);
    expect(s.blocked).toEqual([]);
  });
});
