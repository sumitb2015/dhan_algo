import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { isPidRunning } from '@/lib/processCheck';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');
const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');

// Metadata mapping strategy key to display names and absolute paths
const STRATEGIES_METADATA: Record<string, { name: string; path: string }> = {
  nifty_advanced_imbalance: {
    name: 'Nifty Advanced Imbalance',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_advanced_imbalance.py')
  },
  nifty_value_imbalance_straddle: {
    name: 'Nifty Value Imbalance Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_straddle.py')
  },
  nifty_value_imbalance_strangle: {
    name: 'Nifty Value Imbalance Strangle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_value_imbalance_strangle.py')
  },
  nifty_tick_mean_straddle: {
    name: 'Nifty Tick Mean Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_tick_mean_straddle.py')
  },
  nifty_vwap_1min_straddle: {
    name: 'Nifty VWAP 1-Min Straddle',
    path: path.join(PROJECT_ROOT, 'strategies', 'value_imbalance', 'nifty_vwap_1min_straddle.py')
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
};

/**
 * GET handler: Returns the active status, parameters, and live states of all strategy processes.
 */
export async function GET() {
  try {
    const results: Record<string, any> = {};

    // Ensure debug dir exists
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    for (const [key, meta] of Object.entries(STRATEGIES_METADATA)) {
      const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
      let state: any = {
        strategy: key,
        status: 'STOPPED',
        total_pnl: 0,
        realized_pnl: 0,
        spot: 0,
        adjustments: 0
      };

      if (fs.existsSync(stateFile)) {
        try {
          const content = fs.readFileSync(stateFile, 'utf8');
          const data = JSON.parse(content);
          
          if (data && data.pid && isPidRunning(data.pid)) {
            // Process is running, trust the file state
            state = data;
          } else {
            // Process is not running anymore
            state = {
              ...data,
              status: 'STOPPED'
            };
          }
        } catch (err) {
          console.error(`Error reading/parsing state file for ${key}:`, err);
        }
      }

      results[key] = {
        meta: {
          key,
          name: meta.name
        },
        state
      };
    }

    return NextResponse.json({ success: true, strategies: results });
  } catch (err) {
    console.error('Error in GET strategies API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

/**
 * POST handler: Triggers start or graceful stop of the strategy processes.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, strategy, args = [] } = body;

    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    // Global action: stop all running strategies
    if (action === 'stop_all') {
      const triggered: string[] = [];
      for (const key of Object.keys(STRATEGIES_METADATA)) {
        const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
        let isRunning = false;
        if (fs.existsSync(stateFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            isRunning = !!(data.pid && isPidRunning(data.pid));
          } catch {}
        }
        if (isRunning) {
          const triggerFile = path.join(DEBUG_DIR, `${key}_shutdown.trigger`);
          fs.writeFileSync(triggerFile, '');
          triggered.push(key);
          console.log(`Global exit: shutdown trigger written for ${key}`);
        }
      }
      return NextResponse.json({ success: true, triggered });
    }

    if (!strategy || !STRATEGIES_METADATA[strategy]) {
      return NextResponse.json({ success: false, error: 'Invalid or missing strategy key' }, { status: 400 });
    }

    const meta = STRATEGIES_METADATA[strategy];

    if (action === 'start') {
      // Check if it's already running
      const stateFile = path.join(DEBUG_DIR, `${strategy}_state.json`);
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (data.pid && isPidRunning(data.pid)) {
            return NextResponse.json({ success: false, error: 'Strategy is already running' }, { status: 400 });
          }
        } catch (e) {}
      }

      // Ensure any old shutdown trigger file is removed
      const triggerFile = path.join(DEBUG_DIR, `${strategy}_shutdown.trigger`);
      if (fs.existsSync(triggerFile)) {
        fs.unlinkSync(triggerFile);
      }

      // Spawn process in background
      const processArgs = [meta.path, ...args];
      console.log(`Spawning background strategy: ${PYTHON_EXE} ${processArgs.join(' ')}`);

      const child = spawn(PYTHON_EXE, processArgs, {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });

      child.unref();

      // Write initial state to prevent UI flicker
      const initialState = {
        strategy,
        status: 'INITIALIZING',
        pid: child.pid,
        total_pnl: 0,
        realized_pnl: 0,
        spot: 0,
        adjustments: 0,
        last_update: new Date().toISOString()
      };
      
      try {
        fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
      } catch (writeErr) {
        console.error('Failed to write initial state file:', writeErr);
      }

      return NextResponse.json({ success: true, pid: child.pid });

    } else if (action === 'stop') {
      // Write trigger file for graceful shutdown
      const triggerFile = path.join(DEBUG_DIR, `${strategy}_shutdown.trigger`);
      console.log(`Writing shutdown trigger for strategy: ${strategy} at ${triggerFile}`);
      fs.writeFileSync(triggerFile, '');
      return NextResponse.json({ success: true, message: 'Graceful shutdown trigger written successfully' });

    } else if (action === 'force_stop') {
      // Force-kill the process by PID (used when graceful stop hangs)
      const stateFile = path.join(DEBUG_DIR, `${strategy}_state.json`);
      if (!fs.existsSync(stateFile)) {
        return NextResponse.json({ success: false, error: 'No state file found — strategy may already be stopped' }, { status: 404 });
      }
      let pid: number | null = null;
      try {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        pid = data.pid ?? null;
      } catch {
        return NextResponse.json({ success: false, error: 'Could not read PID from state file' }, { status: 500 });
      }
      if (!pid || !isPidRunning(pid)) {
        return NextResponse.json({ success: true, message: 'Process is not running' });
      }
      // /T kills the process tree (child processes too); /F forces termination
      // taskkill exits non-zero if the process is already gone — that's fine, swallow it
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe', windowsHide: true });
      } catch {
        // Ignore — check below whether the process is actually gone
      }
      // Source of truth: is the process still alive?
      if (isPidRunning(pid)) {
        return NextResponse.json({ success: false, error: `Process ${pid} could not be killed — try running as administrator` }, { status: 500 });
      }
      console.log(`Force-killed PID ${pid} for strategy ${strategy}`);
      try {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.writeFileSync(stateFile, JSON.stringify({ ...data, status: 'STOPPED' }, null, 2));
      } catch {}
      return NextResponse.json({ success: true, message: `Process ${pid} force-killed` });

    } else {
      return NextResponse.json({ success: false, error: 'Invalid action, must be start, stop, or force_stop' }, { status: 400 });
    }

  } catch (err) {
    console.error('Error in POST strategies API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
