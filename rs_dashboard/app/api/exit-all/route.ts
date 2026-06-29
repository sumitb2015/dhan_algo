import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe');
const EXIT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'exit_all_positions.py');

const STRATEGY_KEYS = [
  'nifty_advanced_imbalance',
  'nifty_value_imbalance_straddle',
  'nifty_value_imbalance_strangle',
  'nifty_tick_mean_straddle',
  'nifty_vwap_1min_straddle',
  'nifty_spread_trend',
  'nifty_oi_directional',
];

function isPidRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return output.toLowerCase().includes(pid.toString());
    } else {
      execSync(`ps -p ${pid}`, { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/** Write a STOPPED state for a strategy so the dashboard clears zombie state immediately. */
function clearStrategyState(key: string, existingState: Record<string, any>) {
  try {
    const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
    const cleared = {
      ...existingState,
      status: 'STOPPED',
      // Clear live position fields so the dashboard shows no stale data
      ce_strike: null,
      pe_strike: null,
      ce_ltp: 0,
      pe_ltp: 0,
      ce_lots: 0,
      pe_lots: 0,
      ce_active: false,
      pe_active: false,
      ce_sl: 0,
      pe_sl: 0,
      active_spread: null,
      short_symbol: null,
      long_symbol: null,
      short_strike: null,
      long_strike: null,
      short_ltp: 0,
      long_ltp: 0,
      in_position: false,
      sold_strike: null,
      current_ltp: 0,
      combined_best_premium: null,
      last_update: new Date().toISOString(),
    };
    const tmpPath = stateFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cleared, null, 2));
    fs.renameSync(tmpPath, stateFile);
  } catch {
    // Non-fatal — dashboard will eventually re-read
  }
}

/** Remove any stale shutdown trigger files so a future strategy start isn't auto-stopped. */
function cleanTriggerFile(key: string) {
  try {
    const triggerFile = path.join(DEBUG_DIR, `${key}_shutdown.trigger`);
    if (fs.existsSync(triggerFile)) fs.unlinkSync(triggerFile);
  } catch {}
}

export async function POST() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    // ── Step 1: Broker-level nuclear exit (DELETE /positions) ──────────────
    // Do this FIRST — strategies must not race to close positions themselves.
    let brokerExit = false;
    let brokerError: string | null = null;
    try {
      const { stdout } = await execFileAsync(PYTHON_EXE, [EXIT_SCRIPT], {
        cwd: PROJECT_ROOT,
        timeout: 20000,
        windowsHide: true,
      });
      const lines = stdout.trim().split('\n').filter(Boolean);
      const result = JSON.parse(lines[lines.length - 1]);
      brokerExit = result.success === true;
      if (!brokerExit) brokerError = result.error || 'Unknown error';
    } catch (err: any) {
      if (err.stdout) {
        try {
          const lines = String(err.stdout).trim().split('\n').filter(Boolean);
          const result = JSON.parse(lines[lines.length - 1]);
          brokerExit = result.success === true;
          if (!brokerExit) brokerError = result.error || 'Script failed';
        } catch {}
      }
      if (!brokerExit) brokerError = String(err.message);
    }

    // ── Step 2: Sync all strategy processes ────────────────────────────────
    // Positions are already closed at the broker. Force-kill each running
    // strategy so it cannot attempt its own position-close or re-enter.
    // Then immediately clear its state file so the dashboard shows STOPPED.
    const killed: string[] = [];
    const triggerFallback: string[] = [];

    for (const key of STRATEGY_KEYS) {
      const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
      if (!fs.existsSync(stateFile)) continue;

      let existingState: Record<string, any> = {};
      try {
        existingState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        continue;
      }

      const pid: number | undefined = existingState.pid;
      if (!pid || !isPidRunning(pid)) {
        // Process already dead — just clear state and remove any stale trigger
        cleanTriggerFile(key);
        if (existingState.status !== 'STOPPED') clearStrategyState(key, existingState);
        continue;
      }

      const didKill = forceKillPid(pid);
      if (didKill) {
        killed.push(key);
      } else {
        // Kill failed (permissions?) — fall back to graceful shutdown trigger
        const triggerFile = path.join(DEBUG_DIR, `${key}_shutdown.trigger`);
        fs.writeFileSync(triggerFile, '');
        triggerFallback.push(key);
      }

      // Always clear state file immediately regardless of kill method
      clearStrategyState(key, existingState);
    }

    return NextResponse.json({
      success: brokerExit,
      broker_exit: brokerExit,
      killed,
      trigger_fallback: triggerFallback,
      error: brokerError,
    });
  } catch (err) {
    console.error('Error in exit-all API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
