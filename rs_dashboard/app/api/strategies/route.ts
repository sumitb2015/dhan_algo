import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync, spawn } from 'child_process';
import { isPidRunning, isPidRunningAt, resolveWorkerPid } from '@/lib/processCheck';
import { runPythonJson } from '@/lib/pyExec';
import {
  PROJECT_ROOT, DEBUG_DIR, STRATEGIES_METADATA, pidMetaPath, isStrategyRunning,
  isValidInstanceId, stateKeyFor, discoverInstanceIds,
} from '@/lib/strategyRegistry';

const PYTHON_EXE = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');

/**
 * Day P&L to carry into the initial state file when (re)starting a strategy.
 *
 * Strategies restore the day's P&L themselves (_restore_daily_pnl in
 * lib/strategy_state_helper.py users) by reading their state file at startup — but
 * `start` overwrites that file first, so whatever is omitted here is destroyed, not
 * merely hidden. Left unhandled, every mid-day restart silently reset the daily
 * target/stop to zero, letting a strategy lose its full stop a second time.
 *
 * "Is this from today?" must also be decided here: the Python side dates the file by
 * mtime, and our own write refreshes it, so by the time the strategy looks, a file
 * from last week appears to be from this second.
 *
 * Only the REALIZED part carries. A state file written mid-position has
 * daily_pnl = realized + unrealized, and the position itself is not recovered on
 * restart, so the unrealized mark is subtracted back out.
 */
function carryOverDayPnl(stateFile: string, data: any): Record<string, number> {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  try {
    const mtime = fs.statSync(stateFile).mtime;
    const now = new Date();
    const sameDay =
      mtime.getFullYear() === now.getFullYear() &&
      mtime.getMonth() === now.getMonth() &&
      mtime.getDate() === now.getDate();
    if (!sameDay) return {};

    const carried: Record<string, number> = {};
    const daily = num(data?.daily_pnl);
    if (daily !== undefined) {
      const realized = daily - (num(data?.position_pnl) ?? 0);
      carried.daily_pnl = realized;
      carried.total_pnl = realized;
    }
    const realizedPnl = num(data?.realized_pnl);
    if (realizedPnl !== undefined && realizedPnl !== 0) carried.realized_pnl = realizedPnl;
    return carried;
  } catch {
    return {};
  }
}


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
          name: meta.name,
          // /strategies and /strategies-plus both group by this. Object.entries above
          // preserves the registry's key order, so group order follows the registry too.
          underlying: meta.underlying
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
    const { action, strategy, args = [], instanceId: rawInstanceId, realizedPnl, broker } = body;

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
      // Determine execution broker
      let targetBroker = (broker as string | undefined)?.toLowerCase().trim();
      if (!targetBroker) {
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--broker' && args[i + 1]) {
            targetBroker = String(args[i + 1]).toLowerCase().trim();
            break;
          }
          if (typeof args[i] === 'string' && args[i].startsWith('--broker=')) {
            targetBroker = args[i].split('=')[1]?.toLowerCase().trim();
            break;
          }
        }
      }

      // Pre-flight session check for alternate execution broker
      if (meta.execBrokerEligible && targetBroker && targetBroker !== 'dhan') {
        try {
          const verifyScript = path.join(PROJECT_ROOT, 'scripts', 'tools', 'verify_broker_session.py');
          const verifyRes = await runPythonJson<{ status: string; broker: string; message: string }>(
            verifyScript,
            [targetBroker],
            10000
          );
          if (verifyRes.status !== 'ok') {
            return NextResponse.json({
              success: false,
              error: `Broker session verification failed for ${targetBroker}: ${verifyRes.message || 'Session invalid'}`,
            }, { status: 400 });
          }
        } catch (verifyErr: any) {
          let errMsg = String(verifyErr.message || verifyErr);
          if (verifyErr.stdout) {
            try {
              const lastLine = verifyErr.stdout.trim().split('\n').pop();
              const parsed = JSON.parse(lastLine);
              if (parsed.message) errMsg = parsed.message;
            } catch {}
          }
          return NextResponse.json({
            success: false,
            error: `Broker session verification failed for ${targetBroker}: ${errMsg}`,
          }, { status: 400 });
        }
      }

      // Check if this specific instance is already running
      const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
      // Carried across a same-day restart so the strategy's daily target/stop keeps
      // counting from where it left off. See carryOverDayPnl() for why this has to be
      // decided here rather than by the Python side.
      let carried: Record<string, number> = {};
      if (fs.existsSync(stateFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (data.pid && isStrategyRunning(data.pid, stateKey)) {
            return NextResponse.json({ success: false, error: 'Strategy is already running' }, { status: 400 });
          }
          carried = carryOverDayPnl(stateFile, data);
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

      // Ensure --broker is forwarded for eligible strategies if specified
      if (meta.execBrokerEligible && targetBroker) {
        let hasBroker = false;
        for (let i = 0; i < cleanArgs.length; i++) {
          if (cleanArgs[i] === '--broker') {
            cleanArgs[i + 1] = targetBroker;
            hasBroker = true;
            break;
          }
        }
        if (!hasBroker) {
          cleanArgs.push('--broker', targetBroker);
        }
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

      // Write initial state to prevent UI flicker. The carried day P&L must be part
      // of this write: the strategy's own _restore_daily_pnl() reads THIS file at
      // startup, so anything omitted here is lost, not merely hidden.
      const initialState = {
        strategy: stateKey,
        status: 'INITIALIZING',
        pid: workerPid,
        total_pnl: 0,
        realized_pnl: 0,
        spot: 0,
        adjustments: 0,
        broker: targetBroker || 'dhan',
        ...carried,
        last_update: new Date().toISOString()
      };
      if (Object.keys(carried).length) {
        console.log(`Carrying today's P&L across restart of ${stateKey}:`, carried);
      }

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

    } else if (action === 'reset') {
      // "I squared this off myself — forget the trade."
      //
      // Deliberately does NOT use the `stop` trigger: that routes through the
      // strategy's graceful shutdown, which calls its exit handler and places a
      // real square-off order. Against a position the user already closed, that
      // order has nothing to close and OPENS A FRESH OPPOSITE POSITION instead.
      // So this hard-kills the process (the in-memory position dies with it) and
      // then clears the position fields from the state file so the row stops
      // showing a phantom trade. It never places or cancels a broker order, and
      // it never touches the day's realized P&L unless the caller supplies one.
      const stateFile = path.join(DEBUG_DIR, `${stateKey}_state.json`);
      if (!fs.existsSync(stateFile)) {
        return NextResponse.json({ success: false, error: 'No state file found — nothing to reset' }, { status: 404 });
      }
      let data: Record<string, any>;
      try {
        data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        return NextResponse.json({ success: false, error: 'Could not read the state file' }, { status: 500 });
      }

      // 1. Kill first. Resetting the file under a live process is pointless — it
      //    rewrites the file every tick from the position still held in memory.
      const pid: number | null = data.pid ?? null;
      let killedPid: number | null = null;
      if (pid && isStrategyRunning(pid, stateKey)) {
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe', windowsHide: true });
        } catch {
          // taskkill exits non-zero when the process is already gone; the check below decides.
        }
        if (isPidRunning(pid)) {
          return NextResponse.json(
            { success: false, error: `Process ${pid} could not be killed — try running as administrator. Nothing was reset.` },
            { status: 500 }
          );
        }
        killedPid = pid;
        console.log(`Reset: force-killed PID ${pid} for ${stateKey} (no exit order placed)`);
      }

      // 2. Flatten the state file's view of the book. Only keys the strategy
      //    already writes are touched, so this stays correct across the very
      //    different shapes (futures direction, option legs, spreads).
      const FLAT_POSITION_FIELDS: Record<string, unknown> = {
        direction: 'NONE', position_pnl: 0, entry_price: 0, avg_price: 0,
        in_position: false, position_type: null, sold_strike: null, current_ltp: 0,
        ce_strike: null, pe_strike: null, ce_lots: 0, pe_lots: 0,
        ce_avg_price: 0, pe_avg_price: 0, ce_active: false, pe_active: false,
        ce_sl: 0, pe_sl: 0,
        active_spread: null, short_symbol: null, long_symbol: null,
        short_strike: null, long_strike: null,
        candidate_strike: null, candidate_symbol: null,
      };
      const cleared: Record<string, any> = { ...data, status: 'STOPPED' };
      const changed: string[] = [];
      for (const [key, flatValue] of Object.entries(FLAT_POSITION_FIELDS)) {
        if (key in cleared && JSON.stringify(cleared[key]) !== JSON.stringify(flatValue)) {
          cleared[key] = flatValue;
          changed.push(key);
        }
      }
      delete cleared.pid;

      // Day P&L. The caller can state the true figure; otherwise strip the discarded
      // position's unrealized mark back out, leaving what was actually banked — the
      // same rule `start` applies via carryOverDayPnl(), so a reset-then-start does
      // not double-count or lose the day.
      if (typeof realizedPnl === 'number' && Number.isFinite(realizedPnl)) {
        cleared.daily_pnl = realizedPnl;
        cleared.total_pnl = realizedPnl;
        if ('realized_pnl' in cleared) cleared.realized_pnl = realizedPnl;
        changed.push('daily_pnl');
      } else if (typeof data.daily_pnl === 'number' && Number.isFinite(data.daily_pnl)) {
        const priorPositionPnl =
          typeof data.position_pnl === 'number' && Number.isFinite(data.position_pnl) ? data.position_pnl : 0;
        const banked = data.daily_pnl - priorPositionPnl;
        if (banked !== data.daily_pnl) {
          cleared.daily_pnl = banked;
          cleared.total_pnl = banked;
          changed.push('daily_pnl');
        }
      }
      cleared.last_update = new Date().toISOString();

      // Atomic write so a dashboard poll can never read a half-written file.
      const tmpFile = `${stateFile}.tmp`;
      try {
        fs.writeFileSync(tmpFile, JSON.stringify(cleared, null, 2));
        fs.renameSync(tmpFile, stateFile);
      } catch (writeErr) {
        console.error('Failed to write reset state file:', writeErr);
        return NextResponse.json({ success: false, error: 'Process stopped, but the state file could not be rewritten' }, { status: 500 });
      }

      // 3. Drop the stale pid meta and any pending trigger, so the next start is clean.
      for (const f of [pidMetaPath(stateKey), path.join(DEBUG_DIR, `${stateKey}_shutdown.trigger`)]) {
        try {
          if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (rmErr) {
          console.error(`Failed to remove ${f}:`, rmErr);
        }
      }

      return NextResponse.json({
        success: true,
        killedPid,
        clearedFields: changed,
        message: killedPid
          ? `Stopped PID ${killedPid} without placing an exit order, and cleared the position`
          : 'Cleared the position (process was not running)',
      });

    } else {
      return NextResponse.json({ success: false, error: 'Invalid action, must be start, stop, force_stop, reset, or remove_instance' }, { status: 400 });
    }

  } catch (err) {
    console.error('Error in POST strategies API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
