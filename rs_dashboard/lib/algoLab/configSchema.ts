/**
 * Settings schema -> defaults, validation and the backtest rules stamp. The rules drawer is generated from the same
 * fields, so a strategy declares a setting once (lib/algoLab/types.ts ConfigField) and gets the input, the server-side
 * bounds and the "rules changed, re-run" detection for free.
 */

import { AlgoError, type AlgoConfig, type BaseConfig, type ConfigField, type ConfigValue, type StrategyDefinition } from './types.ts';

export const MAX_LOTS_PER_TRADE = 20;

export const BASE_FIELDS: ConfigField[] = [
  {
    key: 'timeframe',
    label: 'Timeframe',
    group: 'Signal',
    kind: 'select',
    options: [
      { value: 1, label: '1m' },
      { value: 3, label: '3m' },
      { value: 5, label: '5m' },
    ],
    help: 'Candle interval the strategy computes its signals on (closed candles only).',
  },
  { key: 'strikeWindow', label: 'Strike window (ATM ±)', group: 'Signal', kind: 'number', min: 1, max: 10, integer: true },
  { key: 'maxConcurrent', label: 'Max open positions', group: 'Risk', kind: 'number', min: 1, max: 5, integer: true },
  { key: 'maxSameSide', label: 'Max per side (CE / PE)', group: 'Risk', kind: 'number', min: 1, max: 5, integer: true },
  { key: 'lotsPerTrade', label: 'Lots per trade', group: 'Risk', kind: 'number', min: 1, max: MAX_LOTS_PER_TRADE, integer: true },
  { key: 'dailyLossLimit', label: 'Daily loss limit', group: 'Risk', kind: 'number', min: 500, max: 100000, step: 500, unit: '₹' },
  { key: 'entryStart', label: 'Entries from', group: 'Session', kind: 'time' },
  { key: 'entryEnd', label: 'Entries until', group: 'Session', kind: 'time' },
  { key: 'eodExit', label: 'Square-off (EOD)', group: 'Session', kind: 'time' },
  { key: 'brokerage', label: 'Brokerage per order', group: 'Costs', kind: 'number', min: 0, max: 50, unit: '₹' },
  { key: 'slippagePts', label: 'Slippage per fill', group: 'Costs', kind: 'number', min: 0, max: 10, step: 0.05, unit: 'pts', backtestOnly: true },
  {
    key: 'btWarmOnly',
    label: 'Skip cold contracts',
    group: 'Costs',
    kind: 'boolean',
    backtestOnly: true,
    help: 'Skip entries on contracts the options DB has too little previous-session history for (their indicators would not match live).',
  },
];

export const BASE_DEFAULTS: BaseConfig = {
  engineActive: false,
  timeframe: 5,
  strikeWindow: 6,
  maxConcurrent: 2,
  maxSameSide: 1,
  lotsPerTrade: 1,
  dailyLossLimit: 5000,
  entryStart: '09:30',
  entryEnd: '15:00',
  eodExit: '15:15',
  brokerage: 20,
  slippagePts: 0,
  btWarmOnly: false,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isHHMM = (v: unknown): v is string => typeof v === 'string' && HHMM.test(v);
const TIME_KEYS = ['entryStart', 'entryEnd', 'eodExit'] as const;

export const fieldsOf = (def: Pick<StrategyDefinition, 'schema'>): ConfigField[] => [...BASE_FIELDS, ...def.schema];

export function defaultsOf(def: Pick<StrategyDefinition, 'defaults'>): AlgoConfig {
  return { ...BASE_DEFAULTS, ...def.defaults, engineActive: false } as AlgoConfig;
}

export function timesInOrder(c: Pick<BaseConfig, 'entryStart' | 'entryEnd' | 'eodExit'>): boolean {
  return c.entryStart < c.entryEnd && c.entryEnd < c.eodExit;
}

/** One field's value if valid, else undefined. */
function coerce(f: ConfigField, v: unknown): ConfigValue | undefined {
  switch (f.kind) {
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < f.min || n > f.max) return undefined;
      if (f.integer && !Number.isInteger(n)) return undefined;
      return n;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'select': {
      const hit = f.options.find((o) => o.value === v || String(o.value) === String(v));
      return hit ? hit.value : undefined;
    }
    case 'time':
      return isHHMM(v) ? v : undefined;
  }
}

/** Validates a config patch. Unknown keys are dropped; a known key with a bad value refuses the whole patch. */
export function sanitizePatch(fields: ConfigField[], patch: unknown): Partial<AlgoConfig> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AlgoError('config must be an object');
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === 'engineActive') {
      if (typeof v !== 'boolean') throw new AlgoError('engineActive must be a boolean');
      out[k] = v;
      continue;
    }
    const f = fields.find((x) => x.key === k);
    if (!f) continue;
    const c = coerce(f, v);
    if (c === undefined) throw new AlgoError(`invalid value for ${f.label}: ${JSON.stringify(v)}`);
    out[k] = c;
  }
  return out as Partial<AlgoConfig>;
}

/** A complete, valid config from whatever is stored: every bad or missing field falls back to its default. */
export function normalizeConfig(fields: ConfigField[], defaults: AlgoConfig, raw: unknown): AlgoConfig {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, ConfigValue> = { ...defaults };
  out.engineActive = typeof src.engineActive === 'boolean' ? src.engineActive : false;
  for (const f of fields) {
    const c = coerce(f, src[f.key]);
    if (c !== undefined) out[f.key] = c;
  }
  const cfg = out as AlgoConfig;
  if (!timesInOrder(cfg)) for (const k of TIME_KEYS) out[k] = defaults[k];
  return cfg;
}

/** Applies a patch to a stored config. Time order is checked only when the patch edits a time, so an engine halt
 *  (engineActive:false) is never refused for an unrelated reason. */
export function applyConfigPatch(fields: ConfigField[], defaults: AlgoConfig, stored: unknown, patch: unknown): AlgoConfig {
  const p = sanitizePatch(fields, patch);
  const merged = { ...normalizeConfig(fields, defaults, stored), ...p } as AlgoConfig;
  if (TIME_KEYS.some((k) => k in p) && !timesInOrder(merged)) {
    throw new AlgoError('times must satisfy entryStart < entryEnd < eodExit (HH:MM)');
  }
  return merged;
}

/**
 * The backtest rules stamp: every field that changes a result (all schema fields, in order; not engineActive).
 * Adding a field to a strategy changes the stamp, so stored results are flagged "rules changed" until a re-run.
 */
export function configKey(fields: ConfigField[], c: AlgoConfig): string {
  return JSON.stringify(fields.map((f) => [f.key, c[f.key] ?? null]));
}
