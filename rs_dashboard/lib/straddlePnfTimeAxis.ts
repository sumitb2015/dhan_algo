// The bottom time axis of an index P&F chart, as TradingView draws it: a P&F chart has no time scale, so each label sits under the
// column whose time it names, day numbers along the way with the month's name replacing the first label of a new month ("17 25
// Sep 7 11 ... 28 Oct 6 8"). Pure (tested in lib/straddlePnfTimeAxis.test.ts); `times` are epoch seconds, `xs` pixel centres.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_S = 5.5 * 3600;

const istParts = (t: number) => {
  const d = new Date((t + IST_OFFSET_S) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
};

export interface TimeAxisLabel { x: number; text: string; /** A month's or a year's name (drawn bolder) rather than a day number. */ major: boolean }

/** How coarse the labels are: days for a chart of a few months, months for up to ~3 years, years beyond (TradingView's own steps). */
export type AxisGranularity = 'day' | 'month' | 'year';
export function granularityFor(firstT: number, lastT: number): AxisGranularity {
  const days = (lastT - firstT) / 86_400;
  return days <= 150 ? 'day' : days <= 3 * 366 ? 'month' : 'year';
}

/**
 * One label at the first column of each new IST day / month / year (by granularity, default from the chart's span), kept at least
 * `minGap` pixels apart. Days: the day number, the month's name on a month's first label. Months: the month's name, the year on
 * January. Years: the year.
 */
export function timeAxisLabels(times: number[], xs: number[], minGap = 44, gran?: AxisGranularity): TimeAxisLabel[] {
  const out: TimeAxisLabel[] = [];
  if (!times.length) return out;
  const g = gran ?? granularityFor(times[0], times[times.length - 1]);
  let lastX = -Infinity;
  let prevKey = -1;
  let labelledMonth = -1;
  for (let i = 0; i < times.length; i++) {
    const p = istParts(times[i]);
    const key = g === 'day' ? p.y * 400 + p.m * 32 + p.d : g === 'month' ? p.y * 12 + p.m : p.y;
    if (key === prevKey) continue;
    prevKey = key;
    if (xs[i] - lastX < minGap) continue;
    let text: string, major: boolean;
    if (g === 'day') {
      const monthKey = p.y * 12 + p.m;
      major = monthKey !== labelledMonth;
      text = major ? MONTHS[p.m] : String(p.d);
      labelledMonth = monthKey;
    } else if (g === 'month') {
      major = p.m === 0;
      text = major ? String(p.y) : MONTHS[p.m];
    } else {
      major = true;
      text = String(p.y);
    }
    out.push({ x: xs[i], text, major });
    lastX = xs[i];
  }
  return out;
}

/** The crosshair's date chip: "15 Oct '26  11:18" (IST), or just "15 Oct '26" for a daily or longer bar (no time of day). */
export function crosshairStamp(t: number, withTime = true): string {
  const p = istParts(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${p.d} ${MONTHS[p.m]} '${pad(p.y % 100)}`;
  return withTime ? `${date}  ${pad(p.hh)}:${pad(p.mm)}` : date;
}
