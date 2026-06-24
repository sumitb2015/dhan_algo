import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

// Mapping strategy key to log file prefixes
const STRATEGY_LOG_PREFIXES: Record<string, string> = {
  nifty_advanced_imbalance: 'advanced_imbalance_',
  nifty_spread_trend: 'spread_trend_',
  nifty_value_imbalance_strangle: 'strangle_'
};

/**
 * Finds the latest modified log file with the corresponding prefix in the debug folder.
 */
function getLatestLogFile(strategyKey: string): string | null {
  const prefix = STRATEGY_LOG_PREFIXES[strategyKey];
  if (!prefix) return null;

  try {
    if (!fs.existsSync(DEBUG_DIR)) return null;

    const files = fs.readdirSync(DEBUG_DIR)
      .filter(file => file.startsWith(prefix) && file.endsWith('.log'))
      .map(file => {
        const filePath = path.join(DEBUG_DIR, file);
        const stat = fs.statSync(filePath);
        return { file, mtime: stat.mtimeMs };
      });

    if (files.length === 0) return null;

    // Sort by modified time descending (newest first)
    files.sort((a, b) => b.mtime - a.mtime);
    return path.join(DEBUG_DIR, files[0].file);
  } catch (err) {
    console.error('Error finding latest log file:', err);
    return null;
  }
}

/**
 * Reads the last N lines from a file using standard Node filesystem buffer.
 */
function tailFile(filePath: string, lineCount: number = 150): string {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    let index = fileBuffer.length - 1;
    let newlines = 0;
    while (index >= 0 && newlines < lineCount) {
      if (fileBuffer[index] === 10) { // ASCII code for '\n'
        newlines++;
      }
      index--;
    }
    // Convert the tail portion of the buffer to a string
    return fileBuffer.toString('utf8', index + 1);
  } catch (err) {
    console.error('Error tailing log file:', err);
    return 'Error reading logs.';
  }
}

/**
 * GET handler: Returns the tail of the log file for a given strategy.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const strategy = searchParams.get('strategy');

    if (!strategy || !STRATEGY_LOG_PREFIXES[strategy]) {
      return NextResponse.json({ success: false, error: 'Invalid or missing strategy key' }, { status: 400 });
    }

    const logFile = getLatestLogFile(strategy);
    if (!logFile || !fs.existsSync(logFile)) {
      return NextResponse.json({ success: true, logs: 'No logs available yet for this strategy. Please start it.' });
    }

    const lines = tailFile(logFile, 150);
    return NextResponse.json({ success: true, logs: lines });
  } catch (err) {
    console.error('Error in strategy logs API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
