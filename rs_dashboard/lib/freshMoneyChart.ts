/**
 * Fresh Money chart — what is drawn and what it says (pure). The chart shows, per side, the share of the last 5 minutes'
 * volume that changed open interest ("new money"); these helpers turn the series into points, the visible time span,
 * collector gaps, and a plain-language reading of the latest values.
 */
import type { BandPoint, SeriesPoint } from './freshMoney.ts';

export interface ChartPoint {
  m: number;
  puts: number | null;          // percent
  calls: number | null;
  putBand: [number, number] | null;   // normal range for this minute (percent), when history allows
  callBand: [number, number] | null;
  /** The gap between the two lines, filled in the leading side's colour. */
  putLead: [number, number] | null;
  callLead: [number, number] | null;
}

/** Two readings closer than this (percentage points) are "even". */
export const LEAD_PP = 3;
/** A move larger than this over TREND_MIN minutes is rising / falling. */
export const TREND_PP = 3;
export const TREND_MIN = 10;
/** No point for longer than this (minutes) = the collector was not writing, shown as a gap. */
export const GAP_MIN = 3;
/** Never zoom tighter than this many minutes. */
const MIN_SPAN = 180;

/**
 * The x-axis span: from the hour of the first reading (never before the session) to the session end, so a session that
 * starts late (MCX evening-only) or a page opened mid-day is not squeezed into a sliver of a 15-hour axis.
 */
export function chartDomain(series: SeriesPoint[], day: { from: number; to: number }): [number, number] {
  const first = series.find(p => p.puts !== null || p.calls !== null)?.m;
  if (first === undefined) return [day.from, day.to];
  let start = Math.max(day.from, Math.floor(first / 60) * 60);
  if (day.to - start < MIN_SPAN) start = Math.max(day.from, day.to - MIN_SPAN);
  return [start, day.to];
}

/** Stretches with no reading for more than GAP_MIN minutes, between the first and last reading. */
export function findGaps(series: SeriesPoint[]): [number, number][] {
  const ms = series.filter(p => p.puts !== null || p.calls !== null).map(p => p.m).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 1; i < ms.length; i++) if (ms[i] - ms[i - 1] > GAP_MIN) out.push([ms[i - 1], ms[i]]);
  return out;
}

export function buildChartPoints(series: SeriesPoint[], band: BandPoint[], domain: [number, number]): ChartPoint[] {
  const s = new Map(series.map(p => [p.m, p] as const));
  const b = new Map(band.map(p => [p.m, p] as const));
  const out: ChartPoint[] = [];
  for (let m = domain[0]; m <= domain[1]; m++) {
    const sp = s.get(m), bp = b.get(m);
    const puts = sp?.puts != null ? sp.puts * 100 : null;
    const calls = sp?.calls != null ? sp.calls * 100 : null;
    const both = puts !== null && calls !== null;
    out.push({
      m, puts, calls,
      putBand: bp ? [bp.putLo * 100, bp.putHi * 100] : null,
      callBand: bp ? [bp.callLo * 100, bp.callHi * 100] : null,
      putLead: both && puts! > calls! ? [calls!, puts!] : null,
      callLead: both && calls! > puts! ? [puts!, calls!] : null,
    });
  }
  return out;
}

export type Trend = 'rising' | 'falling' | 'flat';
export type Versus = 'above' | 'normal' | 'below';
export interface SideReading { value: number; trend: Trend | null; vsNormal: Versus | null }
export interface Reading {
  m: number;
  puts: SideReading | null;
  calls: SideReading | null;
  leader: 'puts' | 'calls' | 'even' | null;
  text: string;
}

function sideReading(series: SeriesPoint[], band: BandPoint[], side: 'puts' | 'calls'): (SideReading & { m: number }) | null {
  let last: SeriesPoint | undefined;
  for (let i = series.length - 1; i >= 0; i--) if (series[i][side] !== null) { last = series[i]; break; }
  if (!last) return null;
  const value = last[side]! * 100;
  // Trend: against the reading about TREND_MIN minutes earlier (within a few minutes either way).
  let earlier: number | null = null;
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    if (p.m > last.m - TREND_MIN) continue;
    if (p.m < last.m - TREND_MIN - 3) break;
    if (p[side] !== null) { earlier = p[side]! * 100; break; }
  }
  const trend: Trend | null = earlier === null ? null : value - earlier > TREND_PP ? 'rising' : earlier - value > TREND_PP ? 'falling' : 'flat';
  const bp = band.find(b => b.m === last!.m);
  const lo = bp ? (side === 'puts' ? bp.putLo : bp.callLo) * 100 : null;
  const hi = bp ? (side === 'puts' ? bp.putHi : bp.callHi) * 100 : null;
  const vsNormal: Versus | null = lo === null || hi === null ? null : value > hi ? 'above' : value < lo ? 'below' : 'normal';
  return { m: last.m, value, trend, vsNormal };
}

const pct = (v: number) => `${Math.round(v)}%`;

/** The latest reading per side, which side leads, and one plain sentence saying so. */
export function latestReading(series: SeriesPoint[], band: BandPoint[]): Reading | null {
  const p = sideReading(series, band, 'puts');
  const c = sideReading(series, band, 'calls');
  if (!p && !c) return null;
  const m = Math.max(p?.m ?? 0, c?.m ?? 0);
  let leader: Reading['leader'] = null;
  if (p && c) leader = Math.abs(p.value - c.value) < LEAD_PP ? 'even' : p.value > c.value ? 'puts' : 'calls';
  const parts: string[] = [];
  if (leader === 'puts' || leader === 'calls') {
    const [a, b] = leader === 'puts' ? [p!, c!] : [c!, p!];
    parts.push(`${leader === 'puts' ? 'Puts' : 'Calls'} lead: ${pct(a.value)} of ${leader === 'puts' ? 'put' : 'call'} volume is opening or closing positions, vs ${pct(b.value)} on ${leader === 'puts' ? 'calls' : 'puts'}.`);
  } else if (leader === 'even') {
    parts.push(`Both sides about even (puts ${pct(p!.value)}, calls ${pct(c!.value)}).`);
  } else {
    const only = p ?? c!;
    parts.push(`${p ? 'Puts' : 'Calls'} ${pct(only.value)} of volume is opening or closing positions.`);
  }
  const moves = ([['Puts', p], ['Calls', c]] as const)
    .filter(([, r]) => r && r.trend && r.trend !== 'flat')
    .map(([n, r]) => `${n} ${r!.trend}`);
  if (moves.length) parts.push(`${moves.join(', ')} over the last ${TREND_MIN} min.`);
  const abn = ([['Puts', p], ['Calls', c]] as const)
    .filter(([, r]) => r && r.vsNormal && r.vsNormal !== 'normal')
    .map(([n, r]) => `${n} ${r!.vsNormal} normal`);
  if (abn.length) parts.push(`${abn.join(', ')} for this time of day.`);
  return {
    m,
    puts: p ? { value: p.value, trend: p.trend, vsNormal: p.vsNormal } : null,
    calls: c ? { value: c.value, trend: c.trend, vsNormal: c.vsNormal } : null,
    leader,
    text: parts.join(' '),
  };
}
