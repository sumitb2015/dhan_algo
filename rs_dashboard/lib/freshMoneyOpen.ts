// Fresh Money: when the page should re-check every second around the market open. Pure (no I/O, no timers).
//
// The B / S buttons need two things after the open: the server's session gate to read "open" and today's first OI
// snapshot on the board. The page's normal polls are 10 s (trade state) and 30 s (board), far too slow for the open,
// so for a short window around it the page polls both once a second until the buttons are usable.
import { IST_OFFSET_S } from './istTime.ts';

/** The window starts this long before the open (the first poll must already be running at the open)... */
export const OPEN_BURST_BEFORE_MS = 5_000;
/** ...and ends this long after it (a collector that is late by more than this is a fault, not the open). */
export const OPEN_BURST_AFTER_MS = 120_000;

const DAY_MS = 86_400_000;

/** For a market that opens at `openMin` (IST minutes of the day): whether `nowMs` is inside the window, and how long
 *  until the next window starts (0 while inside one; tomorrow's when today's has passed). Calendar-blind: the caller
 *  checks that the day is a trading day. */
export function openBurst(nowMs: number, openMin: number): { active: boolean; startsInMs: number } {
  const inDay = (((nowMs + IST_OFFSET_S * 1000) % DAY_MS) + DAY_MS) % DAY_MS;
  const from = openMin * 60_000 - OPEN_BURST_BEFORE_MS, to = openMin * 60_000 + OPEN_BURST_AFTER_MS;
  if (inDay >= from && inDay < to) return { active: true, startsInMs: 0 };
  return { active: false, startsInMs: inDay < from ? from - inDay : from + DAY_MS - inDay };
}
