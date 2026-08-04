import path from 'path';
import fs from 'fs';
import { isPidRunningAt } from '@/lib/processCheck';

// Single source of truth for which strategies exist and how their debug/ files are named.
// Both /api/strategies (start/stop/status) and /api/exit-all (nuclear liquidation) import
// from here — they used to keep separate hardcoded key lists, which silently drifted and
// left several strategies out of the "Exit All Positions" sweep.

export const PROJECT_ROOT = path.resolve(process.cwd(), '..');
export const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

export const STRATEGIES_METADATA: Record<string, { name: string; path: string }> = {
  nifty_advanced_imbalance: {
    name: 'Nifty Advanced Imbalance',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_advanced_imbalance.py')
  },
  nifty_delta_neutral: {
    name: 'Nifty Delta Neutral (0.5 Delta)',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_delta_neutral.py')
  },
  nifty_value_imbalance_straddle: {
    name: 'Nifty Value Imbalance Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_straddle.py')
  },
  nifty_value_imbalance_strangle: {
    name: 'Nifty Value Imbalance Strangle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_strangle.py')
  },
  nifty_vwap_1min_straddle: {
    name: 'Nifty VWAP 1-Min Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_vwap_1min_straddle.py')
  },
  nifty_vix_straddle: {
    name: 'Nifty VIX-Filtered Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_vix_straddle.py')
  },
  nifty_spread_trend: {
    name: 'Nifty Spread Trend-Following',
    path: path.join(PROJECT_ROOT, 'strategies', 'spread_trend', 'nifty_spread_trend.py')
  },
  nifty_oi_directional: {
    name: 'Nifty OI Directional',
    path: path.join(PROJECT_ROOT, 'strategies', 'oi_directional', 'nifty_oi_directional.py')
  },
  crudeoilm_supertrend: {
    name: 'CrudeOil Mini Supertrend',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_supertrend.py')
  },
  crudeoilm_renko_sar: {
    name: 'CrudeOil Mini Renko SAR',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_renko_sar.py')
  },
  nifty_st_oi_bearcall: {
    name: 'Nifty ST+OI Bear Call Spread',
    path: path.join(PROJECT_ROOT, 'strategies', 'st_oi_bearcall', 'nifty_st_oi_bearcall.py')
  },
  nifty_rolling_straddle: {
    name: 'Nifty Rolling Short Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_rolling_straddle.py')
  },
  // The only positional / multi-day / CNC-delivery strategy here. Unlike every entry above,
  // stopping it does NOT flatten the book: it exits cleanly and leaves holdings in place,
  // persisted in debug/nifty500_momentum_portfolio.json for the next start to reload.
  nifty500_momentum: {
    name: 'Nifty 500 Momentum Portfolio',
    path: path.join(PROJECT_ROOT, 'strategies', 'momentum_investing', 'nifty500_momentum.py')
  },
};

// Python's save_strategy_state() rewrites the whole <key>_state.json every cycle with only
// the fields the strategy itself tracks — it has no notion of pid_start_time, so that field
// can't live in the state file (it would be clobbered within a second of the process starting).
// Kept in a side-channel file instead, written once at spawn time.
export function pidMetaPath(key: string): string {
  return path.join(DEBUG_DIR, `${key}_pid.json`);
}

const pidMetaCache = new Map<string, { startTime: string | null; mtime: number }>();

function readExpectedStartTime(key: string): string | null {
  const filePath = pidMetaPath(key);
  try {
    const stat = fs.statSync(filePath);
    const hit = pidMetaCache.get(key);
    if (hit && hit.mtime === stat.mtimeMs) {
      return hit.startTime;
    }
    const meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const startTime = meta.startTime ?? null;
    pidMetaCache.set(key, { startTime, mtime: stat.mtimeMs });
    return startTime;
  } catch {
    pidMetaCache.delete(key);
    return null;
  }
}

/**
 * Is this state key's recorded PID actually still ITS process? Verifies the process start
 * time against the one captured at spawn, because Windows recycles PIDs — a plain
 * image-name check would report a stale PID as "running" once an unrelated python process
 * inherits that number, which for the exit-all sweep would mean force-killing a bystander.
 */
export function isStrategyRunning(pid: number, key: string): boolean {
  return isPidRunningAt(pid, readExpectedStartTime(key));
}

// Instance IDs are user-supplied and land directly in file names — keep them tight.
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,20}$/;

export function isValidInstanceId(instanceId: unknown): instanceId is string {
  return typeof instanceId === 'string' && INSTANCE_ID_RE.test(instanceId);
}

/**
 * Maps a base strategy key + optional instance id to the key used for all of that
 * process's debug files (state/pid/shutdown-trigger). No instanceId => the plain base
 * key, i.e. byte-for-byte identical to the pre-multi-instance behavior.
 */
export function stateKeyFor(strategy: string, instanceId?: string): string {
  return instanceId ? `${strategy}_${instanceId}` : strategy;
}

/**
 * Discovers named instances of a base key by scanning debug/ for `<key>_<id>_state.json`.
 * The primary (suffix-less) instance is handled separately by callers.
 *
 * Guards against one base key being a prefix of another: if `<key>_<id>` is itself a known
 * strategy key, that file belongs to that other strategy, not to an instance of this one.
 */
export function discoverInstanceIds(key: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(DEBUG_DIR);
  } catch {
    return [];
  }
  const prefix = `${key}_`;
  const suffix = '_state.json';
  const ids: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const id = name.slice(prefix.length, -suffix.length);
    if (!isValidInstanceId(id)) continue;
    if (STRATEGIES_METADATA[stateKeyFor(key, id)]) continue; // belongs to another strategy
    ids.push(id);
  }
  return ids;
}

/**
 * Every state key that could correspond to a live strategy process: each base key plus
 * every discovered named instance. Used by the "Exit All Positions" sweep so duplicated
 * runs are terminated too — an orphaned instance whose positions were just liquidated at
 * the broker would otherwise keep managing (and could re-enter) phantom positions.
 */
export function allStateKeys(): { baseKey: string; instanceId: string; stateKey: string }[] {
  const out: { baseKey: string; instanceId: string; stateKey: string }[] = [];
  for (const baseKey of Object.keys(STRATEGIES_METADATA)) {
    out.push({ baseKey, instanceId: '', stateKey: baseKey });
    for (const instanceId of discoverInstanceIds(baseKey)) {
      out.push({ baseKey, instanceId, stateKey: stateKeyFor(baseKey, instanceId) });
    }
  }
  return out;
}
