/**
 * Node.js-only instrumentation — auto-starts the IV snapshot collector at server startup.
 * The Python script handles its own wait-until-09:15 logic and exits at 15:30 IST.
 * Imported exclusively from instrumentation.ts when NEXT_RUNTIME === 'nodejs'.
 */
import path from 'path';
import fs from 'fs';
import { spawn, execSync } from 'child_process';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR    = path.join(PROJECT_ROOT, 'debug');
// pythonw.exe runs without a console window on Windows. The collector writes logs
// directly to its log file (not sys.stderr), so windowless mode works fine.
const PYTHON_EXE   = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const COLLECTOR    = path.join(PROJECT_ROOT, 'scripts', 'tools', 'iv_snapshot_collector.py');
const PID_FILE     = path.join(DEBUG_DIR, 'iv_snapshot_collector.pid');
const STOP_TRIGGER = path.join(DEBUG_DIR, 'iv_snapshots_stop.trigger');

function istHourMinute(): [number, number] {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return [now.getUTCHours(), now.getUTCMinutes()];
}

function isPidRunning(pid: number): boolean {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      const lower = out.toLowerCase();
      return lower.includes('python') && lower.includes(pid.toString());
    }
    const out = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.toLowerCase().includes('python');
  } catch {
    return false;
  }
}

// Skip if market is already closed for the day (after 15:30 IST)
const [h, m] = istHourMinute();
if (h > 15 || (h === 15 && m >= 30)) {
  console.log('[iv-collector] Market closed — skipping auto-start');
} else if (fs.existsSync(STOP_TRIGGER)) {
  // User explicitly stopped it today
  console.log('[iv-collector] Stop trigger found — skipping auto-start');
} else {
  // Guard against double-spawn on hot reloads
  let alreadyRunning = false;
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!isNaN(pid) && isPidRunning(pid)) {
      console.log(`[iv-collector] Already running (PID ${pid}) — skipping`);
      alreadyRunning = true;
    } else {
      fs.unlinkSync(PID_FILE);
    }
  }

  if (!alreadyRunning) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });

    const proc = spawn(PYTHON_EXE, [COLLECTOR], {
      detached: true,
      stdio:    'ignore',
    });

    proc.unref();

    if (proc.pid) {
      fs.writeFileSync(PID_FILE, String(proc.pid), 'utf8');
      console.log(`[iv-collector] Started (PID ${proc.pid}) — logs at debug/iv_snapshot_collector.log`);
    } else {
      console.error('[iv-collector] Failed to spawn — check venv path and run login.py');
    }
  }
}
