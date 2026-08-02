import { execSync } from 'child_process';

// tasklist/ps is a blocking child-process spawn (~50-200ms on Windows). Several routes
// poll this every 2-3s to check whether a background Python process is still alive;
// calling it unconditionally on every poll can saturate the single-threaded Node event
// loop and starve concurrent requests. Cache the result per PID.
const PID_CHECK_TTL = 3000;
const cache = new Map<number, { result: boolean; ts: number }>();
const pidStartTimeMap = new Map<number, string>();

/** `force` bypasses the cache — use only for short-lived poll loops (e.g. waiting
 *  for a process to exit) where the 3s TTL would otherwise mask the state change. */
export function isPidRunning(pid: number, force = false): boolean {
  if (!pid || isNaN(pid)) return false;

  // Ultra-fast zero-cost native check (0.001ms). If process.kill(pid, 0) fails,
  // the OS guarantees no process exists with this PID.
  try {
    process.kill(pid, 0);
  } catch {
    cache.delete(pid);
    pidStartTimeMap.delete(pid);
    return false;
  }

  const hit = force ? undefined : cache.get(pid);
  if (hit && Date.now() - hit.ts < PID_CHECK_TTL) {
    return hit.result;
  }

  let result: boolean;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      const lower = out.toLowerCase();
      result = lower.includes('python') && lower.includes(pid.toString());
    } else {
      const out = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      result = out.toLowerCase().includes('python');
    }
  } catch {
    result = false;
  }

  cache.set(pid, { result, ts: Date.now() });
  return result;
}

/** Returns the process's start time (.NET ticks, as a string) or null if it can't be determined.
 *  Caches the start time permanently for running PIDs, since a process's start time never changes. */
export function getPidStartTime(pid: number): string | null {
  if (process.platform !== 'win32' || !pid) return null;

  if (pidStartTimeMap.has(pid)) {
    return pidStartTimeMap.get(pid)!;
  }

  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    const ticks = out.trim();
    if (ticks) {
      pidStartTimeMap.set(pid, ticks);
      return ticks;
    }
    return null;
  } catch {
    return null;
  }
}

const startTimeCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Like isPidRunning, but also verifies the live process's start time matches
 * expectedStartTime (from getPidStartTime() captured when the process was spawned).
 */
export function isPidRunningAt(pid: number, expectedStartTime?: string | null, force = false): boolean {
  if (!expectedStartTime) return isPidRunning(pid, force);

  const key = `${pid}:${expectedStartTime}`;
  const hit = force ? undefined : startTimeCache.get(key);
  if (hit && Date.now() - hit.ts < PID_CHECK_TTL) {
    return hit.result;
  }

  const running = isPidRunning(pid, force);
  const result = running && getPidStartTime(pid) === expectedStartTime;
  startTimeCache.set(key, { result, ts: Date.now() });
  return result;
}

function firstChildPid(parentPid: number): number | null {
  try {
    const out = execSync(
      `wmic process where "ParentProcessId=${parentPid}" get ProcessId /format:csv`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    const lines = out.trim().split(/\r?\n/).filter(line => line.trim() && !line.includes('Node,ProcessId'));
    if (lines.length > 0) {
      const parts = lines[lines.length - 1].split(',');
      const pidVal = parseInt(parts[parts.length - 1].trim(), 10);
      if (!isNaN(pidVal) && pidVal > 0) return pidVal;
    }
  } catch {}

  // Fallback to PowerShell if WMIC is unavailable
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | Select-Object -First 1 -ExpandProperty ProcessId)"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    return out ? parseInt(out, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the PID that actually corresponds to a just-spawned strategy process, plus its start time.
 */
export async function resolveWorkerPid(launcherPid: number, timeoutMs = 3000): Promise<{ pid: number; startTime: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const childPid = firstChildPid(launcherPid);
    if (childPid) {
      const startTime = getPidStartTime(childPid);
      if (startTime) return { pid: childPid, startTime };
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const startTime = getPidStartTime(launcherPid);
  return startTime ? { pid: launcherPid, startTime } : null;
}
