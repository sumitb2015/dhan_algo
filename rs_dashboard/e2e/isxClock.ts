import type { Page } from '@playwright/test';

// /index-scalper only fills paper orders and sends market orders inside the NSE F&O session (09:15-15:40 IST on a trading
// day). Its browser tests therefore run on a browser clock that starts inside a fixed session (Wed 2026-11-25 10:30
// IST) and then flows in real time, whatever day the suite runs. Mocked prices are stamped with the same clock.
export const SESSION_START_MS = Date.parse('2026-11-25T05:00:00Z');

let offset = 0;
/** Install the session clock on this page before it loads; returns nothing, use `sessionNow()` for mock timestamps. */
export async function installSessionClock(page: Page): Promise<void> {
  offset = SESSION_START_MS - Date.now();
  await page.clock.install({ time: SESSION_START_MS });
}
/** "Now" on the page's clock, for timestamps the mocks send (updated_at, feed_at). */
export const sessionNow = () => Date.now() + offset;
export const sessionIso = () => new Date(sessionNow()).toISOString();
/** Jump the page clock to `ms` and keep the mocks' timestamps on it (so the feed stays fresh at the new time). */
export async function moveSessionClock(page: Page, ms: number): Promise<void> {
  offset = ms - Date.now();
  await page.clock.setSystemTime(ms);
}
