// The bottom time axis of an index P&F chart, as TradingView draws it: a P&F chart has no time scale, so each label sits under the
// column whose time it names, day numbers along the way with the month's name replacing the first label of a new month ("17 25
// Sep 7 11 ... 28 Oct 6 8"). Pure (tested in lib/straddlePnfTimeAxis.test.ts); `times` are epoch seconds, `xs` pixel centres.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_S = 5.5 * 3600;

const istParts = (t: number) => {
  const d = new Date((t + IST_OFFSET_S) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
};

export interface TimeAxisLabel { x: number; text: string; /** The month's name (drawn bolder) rather than a day number. */ month: boolean }

/**
 * One label at the first column of each new IST day, kept at least `minGap` pixels apart; the first label of a month (and of the
 * chart) is the month's name, every other one the day of the month.
 */
export function timeAxisLabels(times: number[], xs: number[], minGap = 44): TimeAxisLabel[] {
  const out: TimeAxisLabel[] = [];
  let lastX = -Infinity;
  let prevDay = '';
  let labelledMonth = -1;
  for (let i = 0; i < times.length; i++) {
    const p = istParts(times[i]);
    const day = `${p.y}-${p.m}-${p.d}`;
    if (day === prevDay) continue;
    prevDay = day;
    if (xs[i] - lastX < minGap) continue;
    const monthKey = p.y * 12 + p.m;
    const month = monthKey !== labelledMonth;
    out.push({ x: xs[i], text: month ? MONTHS[p.m] : String(p.d), month });
    labelledMonth = monthKey;
    lastX = xs[i];
  }
  return out;
}

/** The crosshair's date chip: "15 Oct '26  11:18" (IST). */
export function crosshairStamp(t: number): string {
  const p = istParts(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.d} ${MONTHS[p.m]} '${pad(p.y % 100)}  ${pad(p.hh)}:${pad(p.mm)}`;
}
