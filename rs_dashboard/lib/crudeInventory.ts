// Pure maths for the Crude Inventories page (/crude-inventories). No React, no fetch.
// Input is debug/crude_inventory.json, written by scripts/tools/crude_inventory_fetch.py:
// EIA weekly series (week-ending Friday dates) plus Investing.com consensus rows keyed by
// release date, in million barrels.

export type SeriesKey =
  | 'crude' | 'cushing' | 'spr' | 'gasoline' | 'distillate'
  | 'refinery' | 'production' | 'imports' | 'exports';

export type SeriesUnit = 'kbbl' | 'pct' | 'kbd';

/** [YYYY-MM-DD week ending, value]. kbbl = thousand barrels, kbd = thousand barrels/day. */
export type Point = [string, number];

export interface InventorySeries {
  id: string;
  label: string;
  unit: SeriesUnit;
  points: Point[];
}

export interface ConsensusRow {
  release: string;          // YYYY-MM-DD
  time: string;             // HH:MM, US Eastern
  actual: number | null;    // million barrels
  forecast: number | null;
  previous: number | null;
}

export interface InventoryFile {
  fetched_at: string;
  latest_week: string | null;
  series: Record<SeriesKey, InventorySeries>;
  consensus: { eia: ConsensusRow[]; api: ConsensusRow[] };
  consensus_status: string;
  errors: string[];
}

const DAY_MS = 86_400_000;

function toUtc(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The week a release reports on: the latest Friday at least 3 days before the release.
 * API comes out Tuesday (Friday = -4), EIA Wednesday (-5) or Thursday after a holiday (-6).
 */
export function weekEndingForRelease(release: string): string {
  let t = toUtc(release) - 3 * DAY_MS;
  while (new Date(t).getUTCDay() !== 5) t -= DAY_MS;
  return fromUtc(t);
}

export interface ChangeRow {
  week: string;
  value: number;
  change: number | null;   // vs the previous week, same unit as value
}

/** Week-over-week change. A gap of more than 10 days (missing week) gives no change. */
export function weeklyChanges(points: Point[]): ChangeRow[] {
  return points.map(([week, value], i) => {
    if (i === 0) return { week, value, change: null };
    const [pw, pv] = points[i - 1];
    const gap = (toUtc(week) - toUtc(pw)) / DAY_MS;
    return { week, value, change: gap <= 10 ? value - pv : null };
  });
}

/** Value of the point nearest `target`, if one lies within `tolDays`. */
function nearestValue(points: Point[], target: number, tolDays: number): number | null {
  // Points are sorted by date: binary search for the insertion index.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toUtc(points[mid][0]) < target) lo = mid + 1; else hi = mid;
  }
  let best: number | null = null;
  let bestGap = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= points.length) continue;
    const gap = Math.abs(toUtc(points[i][0]) - target) / DAY_MS;
    if (gap < bestGap) { bestGap = gap; best = points[i][1]; }
  }
  return bestGap <= tolDays ? best : null;
}

export interface SeasonalRow {
  week: string;
  value: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** [min, max] for a recharts range Area. */
  range: [number, number] | null;
  years: number;   // how many prior years contributed
}

/**
 * EIA-style seasonal band: for each of the last `weeks` points, the min / max / average of the
 * same calendar week in each of the previous `years` years (nearest weekly point within 3 days of
 * the same month/day). Needs at least 3 prior years for a band, else the band is null.
 */
export function seasonalBand(points: Point[], weeks = 52, years = 5): SeasonalRow[] {
  const recent = points.slice(-weeks);
  return recent.map(([week, value]) => {
    const [y, m, d] = week.split('-').map(Number);
    const prior: number[] = [];
    for (let k = 1; k <= years; k++) {
      // Feb 29 has no twin in most years: Date.UTC rolls it to Mar 1, within tolerance.
      const v = nearestValue(points, Date.UTC(y - k, m - 1, d), 3);
      if (v !== null) prior.push(v);
    }
    if (prior.length < 3) {
      return { week, value, min: null, max: null, avg: null, range: null, years: prior.length };
    }
    const min = Math.min(...prior);
    const max = Math.max(...prior);
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    return { week, value, min, max, avg, range: [min, max], years: prior.length };
  });
}

export interface ConsensusJoin {
  week: string;
  release: string;
  time: string;
  actual: number | null;
  forecast: number | null;
  surprise: number | null;  // actual - forecast, million bbl; negative = bigger draw than expected
}

/** Consensus rows keyed by the week they report on. */
export function consensusByWeek(rows: ConsensusRow[]): Map<string, ConsensusJoin> {
  const out = new Map<string, ConsensusJoin>();
  for (const r of rows) {
    const week = weekEndingForRelease(r.release);
    const surprise = r.actual !== null && r.forecast !== null ? r.actual - r.forecast : null;
    out.set(week, { week, release: r.release, time: r.time, actual: r.actual, forecast: r.forecast, surprise });
  }
  return out;
}

/**
 * Investing.com posts the Actual some time after EIA does. When the row has no Actual yet but
 * EIA's own change for that week is known (million bbl), use it so the surprise is not blank.
 */
export function withOfficialActual(j: ConsensusJoin | undefined, officialM: number | null): ConsensusJoin | undefined {
  if (!j || j.actual !== null || officialM === null) return j;
  return { ...j, actual: officialM, surprise: j.forecast !== null ? officialM - j.forecast : null };
}

/**
 * The upcoming report: first release on or after `today` with no Actual whose week EIA has not
 * already published (`latestWeek`), else null.
 */
export function nextRelease(rows: ConsensusRow[], today: string, latestWeek: string | null = null): ConsensusRow | null {
  const pending = rows
    .filter(r => r.actual === null && r.release >= today)
    .filter(r => latestWeek === null || weekEndingForRelease(r.release) > latestWeek)
    .sort((a, b) => a.release.localeCompare(b.release));
  return pending[0] ?? null;
}

export interface SurpriseStats {
  count: number;
  hits: number;        // actual on the same side of zero as the forecast (direction call right)
  meanAbsSurprise: number | null;
}

export function surpriseStats(joins: ConsensusJoin[]): SurpriseStats {
  const done = joins.filter(j => j.actual !== null && j.forecast !== null);
  if (done.length === 0) return { count: 0, hits: 0, meanAbsSurprise: null };
  const hits = done.filter(j => Math.sign(j.actual!) === Math.sign(j.forecast!)).length;
  const mean = done.reduce((s, j) => s + Math.abs(j.surprise!), 0) / done.length;
  return { count: done.length, hits, meanAbsSurprise: mean };
}

/** kbbl -> million barrels, rounded for display maths. */
export function toMillion(kbbl: number): number {
  return kbbl / 1000;
}

export function fmtMillion(m: number | null | undefined, signed = false, digits = 2): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  const s = m.toFixed(digits);
  return `${signed && m > 0 ? '+' : ''}${s}M`;
}

/** Display a series value in its natural unit. */
export function fmtValue(v: number | null | undefined, unit: SeriesUnit, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = signed && v > 0 ? '+' : '';
  if (unit === 'kbbl') return `${sign}${(v / 1000).toFixed(signed ? 2 : 1)}M bbl`;
  if (unit === 'pct') return `${sign}${v.toFixed(1)}%`;
  return `${sign}${Math.round(v).toLocaleString('en-US')} kb/d`;
}

/** % of the seasonal average, e.g. -4.2 means 4.2 % below the 5-year average. */
export function vsAvgPct(row: SeasonalRow | undefined): number | null {
  if (!row || row.avg === null || row.avg === 0) return null;
  return ((row.value - row.avg) / row.avg) * 100;
}
