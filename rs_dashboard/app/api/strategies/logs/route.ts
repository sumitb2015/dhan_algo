import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const LOGS_ROOT = path.join(PROJECT_ROOT, 'debug', 'logs');

// Maps strategy key → log subfolder name
const STRATEGY_LOG_DIRS: Record<string, string> = {
  nifty_advanced_imbalance:      'advanced_imbalance',
  nifty_delta_neutral:           'delta_neutral',
  nifty_spread_trend:            'spread_trend',
  nifty_value_imbalance_straddle:'straddle',
  nifty_value_imbalance_strangle:'strangle',
  nifty_vwap_straddle:           'vwap_straddle',
  nifty_intraday_vwap_straddle:  'intraday_vwap',
  nifty_vwap_1min_straddle:      'vwap_1min',
  nifty_oi_directional:          'oi_directional',
  crudeoilm_supertrend:          'crudeoil',
  crudeoilm_renko_sar:           'crudeoil_renko',
};

/** Returns the path to the most-recently-modified .log file in the strategy's folder. */
function getLatestLogFile(strategyKey: string): string | null {
  const folder = STRATEGY_LOG_DIRS[strategyKey];
  if (!folder) return null;

  const dir = path.join(LOGS_ROOT, folder);
  if (!fs.existsSync(dir)) return null;

  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.log'))
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

    const logFile = getLatestLogFile(strategy);
    if (!logFile) {
      return NextResponse.json({ success: true, logs: 'No logs available yet for this strategy. Start it to begin logging.' });
    }

    return NextResponse.json({ success: true, logs: tailFile(logFile) });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
