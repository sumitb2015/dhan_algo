// The Straddle P&F page's user settings: bar interval and box size. Pure, so parsing and persistence rules are tested.
import { INTERVALS, type Interval } from './straddlePnfInterval.ts';

export type PnfSettings = { interval: Interval; boxPct: number };

export const DEFAULT_SETTINGS: PnfSettings = { interval: 1, boxPct: 0.5 };
/** Box size limits, in % of the first price: below the minimum the chart turns into thousands of boxes, above the maximum it is a single column. */
export const MIN_BOX_PCT = 0.05;
export const MAX_BOX_PCT = 5;

/** "0.5", "0.75%", " 1 " or "0,25" -> a number inside [MIN_BOX_PCT, MAX_BOX_PCT]; anything else -> null. */
export function parseBoxPct(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= MIN_BOX_PCT && n <= MAX_BOX_PCT ? n : null;
}

/** Stored settings, field by field falling back to the defaults for anything missing, mistyped or out of range. */
export function readSettings(raw: string | null): PnfSettings {
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const interval = typeof o.interval === 'number' && (INTERVALS as readonly number[]).includes(o.interval)
    ? (o.interval as Interval) : DEFAULT_SETTINGS.interval;
  const boxPct = typeof o.boxPct === 'number' && Number.isFinite(o.boxPct) && o.boxPct >= MIN_BOX_PCT && o.boxPct <= MAX_BOX_PCT
    ? o.boxPct : DEFAULT_SETTINGS.boxPct;
  return { interval, boxPct };
}

export function serializeSettings(s: PnfSettings): string {
  return JSON.stringify(s);
}
