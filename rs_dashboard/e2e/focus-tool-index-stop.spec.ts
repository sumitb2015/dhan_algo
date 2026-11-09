import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support';
import { config, dhanPos, flatRealRow, installFocusMock, newFocusMock, openFocusTool, orders, realRow, type FocusMock } from './focusToolMock';

// A stopped index refuses every RE on SL / Tgt, so a leg that stops out is not re-sold and the other leg is left
// naked (2026-11-09). These prove: a manual entry on a stopped index asks to start it; Stop asks while the index holds
// positions; a save never carries the tab's copy of the index switches. Every /api/* call is mocked (focusToolMock.ts).

let m: FocusMock;
test.beforeEach(async ({ context }) => { m = newFocusMock(); await signIn(context); });
test.afterEach(() => {
  expect(m.blocked.map(c => `${c.method} ${c.path}`), 'an unmocked write was attempted').toEqual([]);
});

const rowSaves = (mk: FocusMock) => mk.calls.filter(c => c.method === 'POST' && c.path === '/api/focus-tool/rows');
const groupPatches = (mk: FocusMock) => rowSaves(mk).map(c => c.body?.groupPatch).filter(Boolean) as { underlying: string; patch: { enabled?: boolean } }[];
const niftyEnabled = (mk: FocusMock) => !!(mk.config.groups.find(g => g.underlying === 'NIFTY') as { enabled?: boolean } | undefined)?.enabled;

/** Answer every browser dialog; record the texts. */
function onDialogs(page: Page, accept: boolean): string[] {
  const seen: string[] = [];
  page.on('dialog', d => { seen.push(d.message()); void (accept ? d.accept() : d.dismiss()); });
  return seen;
}

test('Enter now on a STOPPED index asks to start it — declining sends nothing and leaves it stopped', async ({ page }) => {
  m.config = config([flatRealRow('ft_s1')]);
  await installFocusMock(page, m, 'dhan', 'pro');
  await openFocusTool(page, 'Enter now');
  const seen = onDialogs(page, false);
  await page.getByRole('button', { name: /Enter now/ }).first().click();
  await expect.poll(() => seen.length).toBe(1);
  expect(seen[0]).toMatch(/NIFTY is STOPPED[\s\S]*naked[\s\S]*Start NIFTY/);
  await page.waitForTimeout(3_000);
  expect(orders(m)).toEqual([]);
  expect(groupPatches(m)).toEqual([]);
  expect(niftyEnabled(m)).toBe(false);
});

test('Enter now on a STOPPED index, accepted: the index is started (one prompt, not two) and the row enters', async ({ page }) => {
  m.config = config([flatRealRow('ft_s2')]);
  await installFocusMock(page, m, 'dhan', 'pro');
  await openFocusTool(page, 'Enter now');
  const seen = onDialogs(page, true);
  await page.getByRole('button', { name: /Enter now/ }).first().click();
  await expect.poll(() => orders(m).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  expect(seen).toHaveLength(1);
  expect(groupPatches(m)).toEqual([{ underlying: 'NIFTY', patch: { enabled: true } }]);
  expect(niftyEnabled(m)).toBe(true);
});

test('Stop is REFUSED while the index holds a position — no prompt to override, nothing saved', async ({ page }) => {
  m.config = config([realRow('ft_s3', 'dhan')]);
  m.config.groups = m.config.groups.map(g => (g.underlying === 'NIFTY' ? { ...g, enabled: true } : g));
  m.dhanPositions = [dhanPos('101', 'NIFTY-Oct2026-23150-CE', -65), dhanPos('201', 'NIFTY-Oct2026-23150-PE', -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');
  const seen = onDialogs(page, true);
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect(page.getByText(/NIFTY not stopped/).first()).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(seen).toEqual([]);
  expect(groupPatches(m)).toEqual([]);
  expect(niftyEnabled(m)).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true }).first()).toBeVisible();
});

test('Stop on an index holding nothing sends a one-index patch and is logged; no save carries a whole groups array', async ({ page }) => {
  m.config = config([flatRealRow('ft_s4')]);
  m.config.groups = m.config.groups.map(g => (g.underlying === 'NIFTY' ? { ...g, enabled: true } : g));
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Stop');
  await page.getByRole('button', { name: 'Stop', exact: true }).first().click();
  await expect.poll(() => groupPatches(m)).toEqual([{ underlying: 'NIFTY', patch: { enabled: false } }]);
  expect(niftyEnabled(m)).toBe(false);
  expect(m.calls.some(c => c.method === 'POST' && c.path === '/api/focus-tool/events' && c.body?.kind === 'index_stopped')).toBe(true);
  await page.waitForTimeout(4_000);
  expect(rowSaves(m).filter(c => c.body && 'groups' in c.body)).toEqual([]);
});

test('an index already STOPPED while holding positions shows a banner whose Start button turns re-entries back on', async ({ page }) => {
  m.config = config([realRow('ft_s5', 'dhan')]);                 // NIFTY stopped (the default), row holds CE + PE
  m.dhanPositions = [dhanPos('101', 'NIFTY-Oct2026-23150-CE', -65), dhanPos('201', 'NIFTY-Oct2026-23150-PE', -65)];
  await installFocusMock(page, m, 'dhan');
  await openFocusTool(page, 'Exit CE leg');
  await expect(page.getByText(/NIFTY is STOPPED with 1 row\(s\) holding positions — re-entries are OFF/)).toBeVisible();
  await page.getByRole('button', { name: 'Start NIFTY so its re-entries run' }).click();
  await expect.poll(() => groupPatches(m)).toEqual([{ underlying: 'NIFTY', patch: { enabled: true } }]);
  await expect(page.getByText(/re-entries are OFF/)).toHaveCount(0);
});
