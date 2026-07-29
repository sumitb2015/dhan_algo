import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { isPidRunning, isPidRunningAt, resolveWorkerPid } from '@/lib/processCheck';
import {
  PROJECT_ROOT, DEBUG_DIR, STRATEGIES_METADATA, pidMetaPath, isStrategyRunning,
  isValidInstanceId, stateKeyFor, discoverInstanceIds,
} from '@/lib/strategyRegistry';

const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');


/**
 * GET handler: Returns the active status, parameters, and live states of all strategy processes.
 */
function readInstanceState(stateKey: string): any {
  const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
  let state: any = {
    strategy: stateKey,
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

      if (data && data.pid && isStrategyRunning(data.pid, stateKey)) {
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
      console.error(`Error reading/parsing state file for ${stateKey}:`, err);
    }
  }

  return state;
}

export async function GET() {
  try {
    const results: Record<string, any> = {};

    // Ensure debug dir exists
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    for (const [key, meta] of Object.entries(STRATEGIES_METADATA)) {
      // Primary (no instance id) instance is always present, even if stopped, so the
      // existing "start primary" row keeps working unmodified. Named instances only
      // show up once a debug/<key>_<id>_state.json file exists for them.
      const instances: Record<string, any> = { '': readInstanceState(key) };
      for (const instanceId of discoverInstanceIds(key)) {
        instances[instanceId] = readInstanceState(stateKeyFor(key, instanceId));
      }

      results[key] = {
        meta: {
          key,
          name: meta.name
        },
        // `state` is the primary instance, kept for backward compatibility: /strategies
        // (StrategyCard) predates multi-instance and reads this field directly — dropping
        // it crashes that page on `state.status`. Only /strategies-plus reads `instances`.
        state: instances[''],
        instances
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
    const { action, strategy, args = [], instanceId: rawInstanceId } = body;

    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    // Global action: stop all running strategies (primary + any named instances)
    if (action === 'stop_all') {
      const triggered: string[] = [];
      for (const key of Object.keys(STRATEGIES_METADATA)) {
        const stateKeys = [key, ...discoverInstanceIds(key).map(id => stateKeyFor(key, id))];
        for (const stateKey of stateKeys) {
          const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
          let isRunning = false;
          if (fs.existsSync(stateFile)) {
            try {
              const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
              isRunning = !!(data.pid && isStrategyRunning(data.pid, stateKey));
            } catch {}
          }
          if (isRunning) {
            const triggerFile = path.join(DEBUG_DIR, `${stateKey}_shutdown.trigger`);
            fs.writeFileSync(triggerFile, '');
            triggered.push(stateKey);
            console.log(`Global exit: shutdown trigger written for ${stateKey}`);
          }
        }
      }
      return NextResponse.json({ success: true, triggered });
    }

    if (!strategy || !STRATEGIES_METADATA[strategy]) {
      return NextResponse.json({ success: false, error: 'Invalid or missing strategy key' }, { status: 400 });
    }

    if (rawInstanceId !== undefined && rawInstanceId !== '' && !isValidInstanceId(rawInstanceId)) {
      return NextResponse.json({ success: false, error: 'Invalid instanceId — use 1-20 letters/digits/underscores/hyphens' }, { status: 400 });
    }
    const instanceId: string | undefined = rawInstanceId || undefined;
    const stateKey = stateKeyFor(strategy, instanceId);

    const meta = STRATEGIES_METADATA[strategy];

    if (action === 'start') {
      // Check if this specific instance is already running
      const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (data.pid && isStrategyRunning(data.pid, stateKey)) {
            return NextResponse.json({ success: false, error: 'Strategy is already running' }, { status: 400 });
          }
        } catch (e) {}
      }

      // Ensure any old shutdown trigger file is removed
      const triggerFile = path.join(DEBUG_DIR, `${stateKey}_shutdown.trigger`);
      if (fs.existsSync(triggerFile)) {
        fs.unlinkSync(triggerFile);
      }

      // Strip any client-supplied --instance-id: this route decides the instance, and the
      // spawned process MUST write to the same stateKey the initial state/pid files below
      // are keyed by. A stray flag in args would desync those and orphan the process.
      const cleanArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--instance-id') { i++; continue; }
        if (typeof args[i] === 'string' && args[i].startsWith('--instance-id=')) continue;
        cleanArgs.push(args[i]);
      }

      // Spawn process in background
      const processArgs = [meta.path, ...cleanArgs, ...(instanceId ? ['--instance-id', instanceId] : [])];
      console.log(`Spawning background strategy: ${PYTHON_EXE} ${processArgs.join(' ')}`);

      const child = spawn(PYTHON_EXE, processArgs, {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });

      child.unref();

      // Resolve the real worker PID (see resolveWorkerPid docs — child.pid is often just
      // the venv launcher stub) and record its start time, so isStrategyRunning() can later
      // detect Windows recycling that PID to an unrelated process after this one exits/crashes.
      let workerPid = child.pid;
      if (child.pid) {
        const worker = await resolveWorkerPid(child.pid);
        if (worker) {
          workerPid = worker.pid;
          try {
            fs.writeFileSync(pidMetaPath(stateKey), JSON.stringify(worker));
          } catch (writeErr) {
            console.error('Failed to write pid meta file:', writeErr);
          }
        }
      }

      // Write initial state to prevent UI flicker
      const initialState = {
        strategy: stateKey,
        status: 'INITIALIZING',
        pid: workerPid,
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

      return NextResponse.json({ success: true, pid: workerPid });

    } else if (action === 'stop') {
      // Write trigger file for graceful shutdown
      const triggerFile = path.join(DEBUG_DIR, `${stateKey}_shutdown.trigger`);
      console.log(`Writing shutdown trigger for strategy: ${stateKey} at ${triggerFile}`);
      fs.writeFileSync(triggerFile, '');
      return NextResponse.json({ success: true, message: 'Graceful shutdown trigger written successfully' });

    } else if (action === 'remove_instance') {
      // Delete a stopped duplicate's files so its row disappears from the dashboard.
      // Hard-guarded: never the primary instance (that row must always exist), and never
      // a live process — removing a running instance's state file would orphan it, leaving
      // a strategy trading with no dashboard row and no way to stop it.
      if (!instanceId) {
        return NextResponse.json({ success: false, error: 'Cannot remove the primary instance' }, { status: 400 });
      }
      const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (data.pid && isStrategyRunning(data.pid, stateKey)) {
            return NextResponse.json({ success: false, error: 'Instance is still running — stop it first' }, { status: 400 });
          }
        } catch {
          // Unparseable state file — treat as stopped and let the removal proceed.
        }
      }
      for (const f of [stateFile, pidMetaPath(stateKey), path.join(DEBUG_DIR, `${stateKey}_shutdown.trigger`)]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (rmErr) {
          console.error(`Failed to remove ${f}:`, rmErr);
        }
      }
      console.log(`Removed instance files for ${stateKey}`);
      return NextResponse.json({ success: true, message: `Instance ${instanceId} removed` });

    } else if (action === 'force_stop') {
      // Force-kill the process by PID (used when graceful stop hangs)
      const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
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
      if (!pid || !isStrategyRunning(pid, stateKey)) {
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
      console.log(`Force-killed PID ${pid} for strategy ${stateKey}`);
      try {
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        fs.writeFileSync(stateFile, JSON.stringify({ ...data, status: 'STOPPED' }, null, 2));
      } catch {}
      return NextResponse.json({ success: true, message: `Process ${pid} force-killed` });

    } else {
      return NextResponse.json({ success: false, error: 'Invalid action, must be start, stop, force_stop, or remove_instance' }, { status: 400 });
    }

  } catch (err) {
    console.error('Error in POST strategies API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
