// A long history (an index's two years of 1-minute bars is ~190k) is downloaded once; the page's 30 s refresh asks for only the
// last few sessions and lays them over what it already has. Pure (tested in lib/pnfTail.test.ts).
import type { Bar } from './straddlePnf.ts';

const IST_OFFSET_S = 5.5 * 3600;
const dayOf = (t: number) => Math.floor((t + IST_OFFSET_S) / 86_400);

/** The bars of the last `n` IST calendar days that have bars (the whole array when it holds fewer). */
export function tailSessions(bars: Bar[], n: number): Bar[] {
  if (n < 1 || bars.length === 0) return bars.length ? [] : bars;
  let days = 0;
  let prev = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const d = dayOf(bars[i].t);
    if (d !== prev) { days += 1; prev = d; if (days > n) return bars.slice(i + 1); }
  }
  return bars;
}

/** `prev` with everything from the tail's first bar onwards replaced by the tail (the refresh may have revised those bars). */
export function mergeTail(prev: Bar[], tail: Bar[]): Bar[] {
  if (!tail.length) return prev;
  const from = tail[0].t;
  return [...prev.filter(b => b.t < from), ...tail];
}
