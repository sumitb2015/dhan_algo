import path from 'path';
import fs from 'fs';
import { isPidRunningAt } from '@/lib/processCheck';

// Single source of truth for which strategies exist and how their debug/ files are named.
// Both /api/strategies (start/stop/status) and /api/exit-all (nuclear liquidation) import
// from here — they used to keep separate hardcoded key lists, which silently drifted and
// left several strategies out of the "Exit All Positions" sweep.

export const PROJECT_ROOT = path.resolve(process.cwd(), '..');
export const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

/**
 * `underlying` is the instrument a strategy is built around, used by /strategies-plus to
 * group its rows. It is the strategy's DEFAULT/primary underlying, not a hard constraint —
 * nifty_spread_trend for instance accepts a Bank Nifty flag at launch. Group order on the
 * page follows this object's key order, so place a new entry next to its siblings rather
 * than maintaining a separate ordering list.
 */
/**
 * Trading-logic taxonomy for the /strategies-plus "By Strategy Type" grouping view —
 * an alternative to grouping by `underlying`, for when the question is "what kind of
 * edge am I running" rather than "what am I exposed to". Order here controls card order.
 */
export const LOGIC_GROUPS: Record<string, { title: string; tagline: string; icon: string }> = {
  harvest: {
    title: 'Premium Harvest',
    tagline: 'Sell & hold — theta does the work',
    icon: 'Sprout',
  },
  rotation: {
    title: 'Roll & Rotate',
    tagline: 'Exit a decaying leg into a fresh strike',
    icon: 'Repeat',
  },
  volatility: {
    title: 'Volatility Adaptive',
    tagline: 'Entry and hedge gated by the vol regime',
    icon: 'Activity',
  },
  directional: {
    title: 'Directional Options',
    tagline: 'Trend + OI-confirmed spreads and sells',
    icon: 'TrendingUp',
  },
  futures_trend: {
    title: 'Futures Trend',
    tagline: 'Ride MCX momentum in one direction',
    icon: 'Flame',
  },
  momentum: {
    title: 'Equity Momentum',
    tagline: 'Relative-strength stock rotation',
    icon: 'Rocket',
  },
  overnight_hedge: {
    title: 'Overnight Hedge',
    tagline: 'Hedged straddle held past the close',
    icon: 'Moon',
  },
};

export const STRATEGIES_METADATA: Record<string, {
  name: string;
  path: string;
  underlying: string;
  logicGroup: keyof typeof LOGIC_GROUPS;
  timeframe: 'intraday' | 'positional';
  execBrokerEligible?: boolean;
}> = {
  nifty_advanced_imbalance: {
    name: 'Nifty Advanced Imbalance',
    underlying: 'NIFTY',
    logicGroup: 'harvest',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_advanced_imbalance.py'),
    execBrokerEligible: true,
  },
  nifty_delta_neutral: {
    name: 'Nifty Delta Neutral (0.5 Delta)',
    underlying: 'NIFTY',
    logicGroup: 'volatility',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_delta_neutral.py'),
    execBrokerEligible: true,
  },
  nifty_value_imbalance_straddle: {
    name: 'Nifty Value Imbalance Straddle',
    underlying: 'NIFTY',
    logicGroup: 'harvest',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_straddle.py'),
    execBrokerEligible: true,
  },
  nifty_value_imbalance_strangle: {
    name: 'Nifty Value Imbalance Strangle',
    underlying: 'NIFTY',
    logicGroup: 'harvest',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_strangle.py'),
    execBrokerEligible: true,
  },
  nifty_vwap_1min_straddle: {
    name: 'Nifty VWAP 1-Min Straddle',
    underlying: 'NIFTY',
    logicGroup: 'harvest',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_vwap_1min_straddle.py'),
    execBrokerEligible: true,
  },
  nifty_vix_straddle: {
    name: 'Nifty VIX-Filtered Straddle',
    underlying: 'NIFTY',
    logicGroup: 'volatility',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_vix_straddle.py'),
    execBrokerEligible: true,
  },
  nifty_spread_trend: {
    name: 'Nifty Spread Trend-Following',
    underlying: 'NIFTY',
    logicGroup: 'directional',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'spread_trend', 'nifty_spread_trend.py'),
    execBrokerEligible: true,
  },
  nifty_oi_directional: {
    name: 'Nifty OI Directional',
    underlying: 'NIFTY',
    logicGroup: 'directional',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'oi_directional', 'nifty_oi_directional.py'),
    execBrokerEligible: true,
  },
  nifty_st_oi_bearcall: {
    name: 'Nifty ST+OI Bear Call Spread',
    underlying: 'NIFTY',
    logicGroup: 'directional',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'st_oi_bearcall', 'nifty_st_oi_bearcall.py'),
    execBrokerEligible: true,
  },
  nifty_rolling_straddle: {
    name: 'Nifty Rolling Short Straddle',
    underlying: 'NIFTY',
    logicGroup: 'rotation',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_rolling_straddle.py'),
    execBrokerEligible: true,
  },
  nifty_delta_strangle: {
    name: 'Nifty Delta Strangle (Weekly)',
    underlying: 'NIFTY',
    logicGroup: 'rotation',
    timeframe: 'positional',
    path: path.join(PROJECT_ROOT, 'strategies', 'delta_strangle', 'nifty_delta_strangle.py'),
    execBrokerEligible: true,
  },
  crudeoilm_supertrend: {
    name: 'CrudeOil Mini Supertrend',
    underlying: 'CRUDEOILM',
    logicGroup: 'futures_trend',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_supertrend.py')
  },
  crudeoilm_renko_sar: {
    name: 'CrudeOil Mini Renko SAR',
    underlying: 'CRUDEOILM',
    logicGroup: 'futures_trend',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_renko_sar.py')
  },
  crudeoilm_vwap_supertrend: {
    name: 'CrudeOil Mini VWAP + Supertrend',
    underlying: 'CRUDEOILM',
    logicGroup: 'futures_trend',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_vwap_supertrend.py')
  },
  crudeoilm_orb: {
    name: 'CrudeOil Mini ORB + Pivot Stop',
    underlying: 'CRUDEOILM',
    logicGroup: 'futures_trend',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'crudeoil', 'crudeoilm_orb.py')
  },
  // The only MULTI-SYMBOL strategy here: it tracks all 50 Nifty names and may hold several
  // at once, so its state file carries `positions` and `candidates` arrays rather than the
  // single-instrument fields every entry above uses.
  // NOTE: its rule set is not backtest-validated (-0.28R over 81 sessions), so the script
  // refuses --live without an explicit acknowledgement flag. Dry run is the intended mode.
  nifty50_vwap_rs: {
    name: 'Nifty 50 Intraday VWAP + RS',
    underlying: 'NIFTY 50',
    logicGroup: 'momentum',
    timeframe: 'intraday',
    path: path.join(PROJECT_ROOT, 'strategies', 'intraday_equity', 'nifty50_vwap_rs.py')
  },
  // The only positional / multi-day / CNC-delivery strategy here. Unlike every entry above,
  // stopping it does NOT flatten the book: it exits cleanly and leaves holdings in place,
  // persisted in debug/nifty500_momentum_portfolio.json for the next start to reload.
  nifty500_momentum: {
    name: 'Nifty 500 Momentum Portfolio',
    underlying: 'NIFTY 500',
    logicGroup: 'momentum',
    timeframe: 'positional',
    path: path.join(PROJECT_ROOT, 'strategies', 'momentum_investing', 'nifty500_momentum.py')
  },
  // The only OVERNIGHT options strategy here: it deliberately does NOT flatten at the
  // usual 15:17 intraday cutoff, holding a hedged short straddle from the day before
  // expiry through to expiry day. Unlike nifty500_momentum, Stop DOES flatten it (no
  // supervising process = no one managing the rolls/SL on a live short straddle) —
  // position state persists in debug/nifty_overnight_fly_position.json so a restart
  // reconciles the open hedge instead of re-entering blind.
  nifty_overnight_fly: {
    name: 'Nifty Overnight Fly',
    underlying: 'NIFTY',
    logicGroup: 'overnight_hedge',
    timeframe: 'positional',
    path: path.join(PROJECT_ROOT, 'strategies', 'overnight_fly', 'nifty_overnight_fly.py'),
    execBrokerEligible: true,
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
