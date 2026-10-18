/**
 * Algo Lab strategy registry: add a strategy by importing its definition and listing it here.
 * Keys are used in URLs (/algo-lab?strategy=<key>), API paths and debug/algo_lab/<key>_* files.
 */

import { fieldsOf, defaultsOf, normalizeConfig } from './configSchema.ts';
import type { AlgoConfig, ConfigField, StrategyDefinition } from './types.ts';
import { vwapMomentumBuyer } from './strategies/vwapMomentumBuyer.ts';
import { breakdownAutoScalper } from './strategies/breakdownAutoScalper.ts';
import { managedStraddle } from './strategies/managedStraddle.ts';

export const STRATEGIES: StrategyDefinition[] = [vwapMomentumBuyer, breakdownAutoScalper, managedStraddle];

const KEY_RE = /^[a-z0-9_]{2,40}$/;

export function getStrategy(key: string | null | undefined): StrategyDefinition | null {
  if (!key || !KEY_RE.test(key)) return null;
  return STRATEGIES.find((s) => s.key === key) ?? null;
}

/** Fields, defaults and a normaliser bound to one strategy. */
export function strategyConfig(def: StrategyDefinition): {
  fields: ConfigField[];
  defaults: AlgoConfig;
  normalize: (raw: unknown) => AlgoConfig;
} {
  const fields = fieldsOf(def);
  const defaults = defaultsOf(def);
  return { fields, defaults, normalize: (raw) => normalizeConfig(fields, defaults, raw) };
}
