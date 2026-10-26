// The Straddle P&F pages' user settings: bar interval, box size and reversal. Pure, so parsing and persistence rules are tested.
import { DEFAULT_OFFSETS, parseOffsetsParam, type Offsets } from './straddlePnfStrikes.ts';
import { INTERVALS, type Interval } from './straddlePnfInterval.ts';

/** Boxes against the column it takes to reverse it (the classic setting is 3). */
export const REVERSALS = [1, 2, 3, 4, 5] as const;
export type Reversal = (typeof REVERSALS)[number];

export type PnfSettings = { interval: Interval; boxPct: number; reversal: Reversal };

/** localStorage key shared by the live page and the simulator, so both show the chart the same way. */
export const SETTINGS_KEY = 'straddle-pnf-settings';

export const DEFAULT_SETTINGS: PnfSettings = { interval: 1, boxPct: 0.5, reversal: 3 };
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
  const reversal = typeof o.reversal === 'number' && (REVERSALS as readonly number[]).includes(o.reversal)
    ? (o.reversal as Reversal) : DEFAULT_SETTINGS.reversal;
  return { interval, boxPct, reversal };
}

export function serializeSettings(s: PnfSettings): string {
  return JSON.stringify(s);
}

/** localStorage key for the three chart offsets from ATM. */
export const OFFSETS_KEY = 'straddle-pnf-offsets';

/** Stored offsets, or the defaults when missing or invalid. */
export function readOffsets(raw: string | null): Offsets {
  try {
    const a = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a)) return parseOffsetsParam(a.join(',')) ?? DEFAULT_OFFSETS;
  } catch { /* corrupt: defaults */ }
  return DEFAULT_OFFSETS;
}
