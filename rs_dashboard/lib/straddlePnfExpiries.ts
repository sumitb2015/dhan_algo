// Expiry choices for the Straddle P&F page: at most four, in order — upcoming weekly, next weekly, this monthly, next monthly.
// A monthly is the last expiry date of a calendar month in the list Dhan returns, so the list must reach past the month.

export type PnfExpiry = { value: string; label: string; kind: 'weekly1' | 'weekly2' | 'monthly1' | 'monthly2' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function label(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${DAYS[d.getUTCDay()]}`;
}

/** `all` and `today` are YYYY-MM-DD (ISO dates compare correctly as strings). */
export function pickExpiries(all: string[], today: string): PnfExpiry[] {
  const dates = Array.from(new Set(all)).sort();
  const upcoming = dates.filter(d => d >= today);

  const out: PnfExpiry[] = [];
  const weeklyKinds = ['weekly1', 'weekly2'] as const;
  upcoming.slice(0, 2).forEach((value, i) => out.push({ value, label: label(value), kind: weeklyKinds[i] }));

  const lastOfMonth = new Map<string, string>();
  for (const d of dates) lastOfMonth.set(d.slice(0, 7), d); // sorted ascending, so the final write per month is its last date
  const monthlies = Array.from(lastOfMonth.values()).filter(d => d >= today && !out.some(e => e.value === d));
  const monthlyKinds = ['monthly1', 'monthly2'] as const;
  monthlies.slice(0, 2).forEach((value, i) => out.push({ value, label: label(value), kind: monthlyKinds[i] }));

  return out;
}
