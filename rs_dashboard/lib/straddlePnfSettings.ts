// The Straddle P&F pages' user settings: bar interval, box size and reversal. Pure, so parsing and persistence rules are tested.
import { DEFAULT_OFFSETS, parseOffsetsParam, type Offsets } from './straddlePnfStrikes.ts';
import { INTERVALS, type Interval } from './straddlePnfInterval.ts';

/** Boxes against the column it takes to reverse it (the classic setting is 3). */
export const REVERSALS = [1, 2, 3, 4, 5] as const;
export type Reversal = (typeof REVERSALS)[number];

/**
 * `boxMode`: the box size as a % of the first price (`boxPct`) or as fixed price points (`boxPts`); both values are kept so switching
 * back restores the last one. `smaPeriod`: P&F boxes in the SMA overlay line (an average of box values, not of bar closes).
 */
export type BoxMode = 'pct' | 'pts';
export type PnfSettings = { interval: Interval; boxMode: BoxMode; boxPct: number; boxPts: number; reversal: Reversal; smaPeriod: number };

/** localStorage key shared by the live page and the simulator, so both show the chart the same way. */
export const SETTINGS_KEY = 'straddle-pnf-settings';

export const DEFAULT_SETTINGS: PnfSettings = { interval: 1, boxMode: 'pct', boxPct: 0.5, boxPts: 10, reversal: 3, smaPeriod: 50 };
/** SMA period limits, in P&F boxes (a small box over 10 sessions draws a few hundred to a few thousand boxes). */
export const MIN_SMA_PERIOD = 2;
export const MAX_SMA_PERIOD = 500;

const smaPeriodOk = (n: number) => Number.isInteger(n) && n >= MIN_SMA_PERIOD && n <= MAX_SMA_PERIOD;

/** " 50 " -> 50; a whole number inside [MIN_SMA_PERIOD, MAX_SMA_PERIOD]; anything else -> null. */
export function parseSmaPeriod(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return smaPeriodOk(n) ? n : null;
}
/** Box size limits, in % of the first price: below the minimum the chart turns into thousands of boxes, above the maximum it is a single column. */
export const MIN_BOX_PCT = 0.05;
export const MAX_BOX_PCT = 5;

/** Box size limits in price points. The chart still never uses a box below MIN_BOX_PCT of the price (see buildPanelModel). */
export const MIN_BOX_PTS = 0.01;
export const MAX_BOX_PTS = 100_000;

const boxPtsOk = (n: number) => Number.isFinite(n) && n >= MIN_BOX_PTS && n <= MAX_BOX_PTS;

/** "50", " 2.5 " or "0,5" -> a number inside [MIN_BOX_PTS, MAX_BOX_PTS]; anything else -> null. */
export function parseBoxPts(text: string): number | null {
  const t = text.trim().replace(/\s*(pts?|points?)$/i, '').trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return boxPtsOk(n) ? n : null;
}

/** The box sizes the − / + buttons step through: round values only, so any typed size steps onto the ladder. */
export const BOX_PCT_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5];
export const BOX_PTS_STEPS: number[] = (() => {
  const out: number[] = [];
  for (let e = -2; e <= 5; e++) for (const m of [1, 2, 2.5, 5]) out.push(Number((m * 10 ** e).toFixed(4)));
  return out.filter(v => v >= MIN_BOX_PTS && v <= MAX_BOX_PTS);
})();

/** The next ladder size above (dir 1) or below (dir -1) `value`; `value` itself at either end of the ladder. */
export function stepBox(mode: BoxMode, value: number, dir: 1 | -1): number {
  const ladder = mode === 'pct' ? BOX_PCT_STEPS : BOX_PTS_STEPS;
  const eps = 1e-9;
  if (dir === 1) return ladder.find(v => v > value + eps) ?? value;
  for (let i = ladder.length - 1; i >= 0; i--) if (ladder[i] < value - eps) return ladder[i];
  return value;
}

/** The header's short description of the box: "0.5% box" or "50-pt box". */
export const boxText = (s: Pick<PnfSettings, 'boxMode' | 'boxPct' | 'boxPts'>) => (s.boxMode === 'pts' ? `${s.boxPts}-pt box` : `${s.boxPct}% box`);

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
  const smaPeriod = typeof o.smaPeriod === 'number' && smaPeriodOk(o.smaPeriod) ? o.smaPeriod : DEFAULT_SETTINGS.smaPeriod;
  const boxMode: BoxMode = o.boxMode === 'pts' ? 'pts' : 'pct';
  const boxPts = typeof o.boxPts === 'number' && boxPtsOk(o.boxPts) ? o.boxPts : DEFAULT_SETTINGS.boxPts;
  return { interval, boxMode, boxPct, boxPts, reversal, smaPeriod };
}

export function serializeSettings(s: PnfSettings): string {
  return JSON.stringify(s);
}

/** localStorage key for the three chart offsets from ATM. */
export const OFFSETS_KEY = 'straddle-pnf-offsets';
/** Offsets are remembered per underlying; NIFTY keeps the original key. */
export const offsetsKeyFor = (underlying: string) => (underlying === 'NIFTY' ? OFFSETS_KEY : `${OFFSETS_KEY}-${underlying.toLowerCase()}`);

/** Stored offsets, or the defaults when missing or invalid. */
export function readOffsets(raw: string | null): Offsets {
  try {
    const a = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a)) return parseOffsetsParam(a.join(',')) ?? DEFAULT_OFFSETS;
  } catch { /* corrupt: defaults */ }
  return DEFAULT_OFFSETS;
}
