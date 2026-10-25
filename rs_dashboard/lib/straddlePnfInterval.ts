// Groups the page's 1-minute straddle bars into N-minute bars for the chart. Pure, no clocks.
import type { Bar } from './straddlePnf.ts';

/** Offered intervals: each divides the 375-minute session (09:15-15:30) evenly, so no bucket is ever cut short at the close. */
export const INTERVALS = [1, 3, 5, 15] as const;
export type Interval = (typeof INTERVALS)[number];

const SESSION_OPEN_MIN = 9 * 60 + 15; // buckets start at the 09:15 open, like exchange charts
const IST_OFFSET_S = 5.5 * 3600;

/**
 * An N-minute bar takes the close (CE, PE, straddle) of its last minute and the summed volume, and is stamped with its start
 * time. Buckets never span days. A bucket is a bar only once it has closed: it has all N minutes, or a later bucket exists
 * (a missing minute must not hold it back forever). `endIdx[i]` is the index, in the input, of bucket i's last 1-min bar, so a
 * series computed on the 1-minute bars (VWAP) can be read at each bucket's close.
 */
export function resample(bars: Bar[], n: number): { bars: Bar[]; endIdx: number[] } {
  if (n <= 1) return { bars, endIdx: bars.map((_, i) => i) };

  type Group = { key: string; start: number; count: number; vol: number; last: Bar; lastIdx: number };
  const groups: Group[] = [];
  bars.forEach((b, i) => {
    const ist = b.t + IST_OFFSET_S;
    const day = Math.floor(ist / 86_400);
    const minuteOfDay = Math.floor((ist % 86_400) / 60);
    const idx = Math.floor((minuteOfDay - SESSION_OPEN_MIN) / n);
    const key = `${day}:${idx}`;
    const tail = groups[groups.length - 1];
    if (tail && tail.key === key) {
      tail.count += 1; tail.vol += b.vol; tail.last = b; tail.lastIdx = i;
    } else {
      const start = b.t - (b.t % 60) - ((minuteOfDay - SESSION_OPEN_MIN) - idx * n) * 60;
      groups.push({ key, start, count: 1, vol: b.vol, last: b, lastIdx: i });
    }
  });

  const tail = groups[groups.length - 1];
  if (tail && tail.count < n) groups.pop(); // still forming

  return {
    bars: groups.map(g => ({ t: g.start, ce: g.last.ce, pe: g.last.pe, straddle: g.last.straddle, vol: g.vol })),
    endIdx: groups.map(g => g.lastIdx),
  };
}
