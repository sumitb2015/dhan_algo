import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const LOGS_ROOT = path.join(PROJECT_ROOT, 'debug', 'logs');

// Maps strategy key → log subfolder name.
//
// This is a SECOND registry: a strategy also has to be in STRATEGIES_METADATA
// (lib/strategyRegistry.ts) to be startable, and the keys are not derivable from
// each other — the key is `nifty_rolling_straddle` while the folder the script
// writes to is `rolling_straddle`. Adding a strategy in only one place makes it
// launch fine and then fail with "Invalid or missing strategy key" the moment
// anyone opens its logs, so add it here whenever you add it there.
const STRATEGY_LOG_DIRS: Record<string, string> = {
  nifty_advanced_imbalance:      'advanced_imbalance',
  nifty_delta_neutral:           'delta_neutral',
  nifty_spread_trend:            'spread_trend',
  nifty_value_imbalance_straddle:'straddle',
  nifty_value_imbalance_strangle:'strangle',
  nifty_vwap_straddle:           'vwap_straddle',
  nifty_intraday_vwap_straddle:  'intraday_vwap',
  nifty_vwap_1min_straddle:      'vwap_1min',
  nifty_rolling_straddle:        'rolling_straddle',
  nifty_oi_directional:          'oi_directional',
  nifty_vix_straddle:            'vix_straddle',
  nifty_st_oi_bearcall:          'st_oi_bearcall',
  crudeoilm_supertrend:          'crudeoil',
  crudeoilm_renko_sar:           'crudeoil_renko',
  crudeoilm_vwap_supertrend:     'crudeoil_vwap',
  crudeoilm_orb:                 'crudeoil_orb',
  nifty500_momentum:             'momentum_investing',
};

// Duplicated instances write `<YYYYMMDD>_<instanceId>.log` alongside the primary's
// `<YYYYMMDD>.log` (see instance_log_suffix() in lib/strategy_state_helper.py).
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]{1,20}$/;
const ANY_INSTANCE_LOG_RE = /^\d{8}_[a-zA-Z0-9_-]{1,20}\.log$/;

/**
 * Returns the most-recently-modified .log file belonging to this specific instance.
 *
 * The primary instance deliberately matches "anything that is NOT an instance log"
 * rather than a strict `<YYYYMMDD>.log` pattern, so pre-existing/oddly-named files
 * (e.g. crudeoil/renko_20260713.log) keep showing exactly as they did before.
 */
function getLatestLogFile(strategyKey: string, instanceId: string): string | null {
  const folder = STRATEGY_LOG_DIRS[strategyKey];
  if (!folder) return null;

  const dir = path.join(LOGS_ROOT, folder);
  if (!fs.existsSync(dir)) return null;

  // instanceId is validated against INSTANCE_ID_RE by the caller, so it is safe to
  // interpolate into a regex here (no metacharacters can survive that check).
  const thisInstanceRe = instanceId ? new RegExp(`^\\d{8}_${instanceId}\\.log$`) : null;
  const matches = thisInstanceRe
    ? (f: string) => thisInstanceRe.test(f)
    : (f: string) => !ANY_INSTANCE_LOG_RE.test(f);

  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.log') && matches(f))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length ? path.join(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

/** Reads the last N lines from a file. */
function tailFile(filePath: string, lineCount = 150): string {
  try {
    const buf = fs.readFileSync(filePath);
    let idx = buf.length - 1;
    let newlines = 0;
    while (idx >= 0 && newlines < lineCount) {
      if (buf[idx] === 10) newlines++;
      idx--;
    }
    return buf.toString('utf8', idx + 1);
  } catch {
    return 'Error reading logs.';
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy');

    if (!strategy || !STRATEGY_LOG_DIRS[strategy]) {
      return NextResponse.json({ success: false, error: 'Invalid or missing strategy key' }, { status: 400 });
    }

    const rawInstanceId = searchParams.get('instanceId') ?? '';
    if (rawInstanceId && !INSTANCE_ID_RE.test(rawInstanceId)) {
      return NextResponse.json({ success: false, error: 'Invalid instanceId' }, { status: 400 });
    }

    const logFile = getLatestLogFile(strategy, rawInstanceId);
    if (!logFile) {
      return NextResponse.json({ success: true, logs: 'No logs available yet for this strategy. Start it to begin logging.' });
    }

    return NextResponse.json({ success: true, logs: tailFile(logFile) });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
