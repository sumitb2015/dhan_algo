import { execSync } from 'child_process';

// tasklist/ps is a blocking child-process spawn (~50-200ms on Windows). Several routes
// poll this every 2-3s to check whether a background Python process is still alive;
// calling it unconditionally on every poll can saturate the single-threaded Node event
// loop and starve concurrent requests (e.g. order placement) on unrelated pages. Cache
// the result per PID for a few seconds instead of re-checking on every poll.
const PID_CHECK_TTL = 3000;
const cache = new Map<number, { result: boolean; ts: number }>();

/** `force` bypasses the cache — use only for short-lived poll loops (e.g. waiting
 *  for a process to exit) where the 3s TTL would otherwise mask the state change. */
export function isPidRunning(pid: number, force = false): boolean {
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

/** Returns the process's start time (.NET ticks, as a string) or null if it can't be determined. */
export function getPidStartTime(pid: number): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.Ticks"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
    );
    const ticks = out.trim();
    return ticks || null;
  } catch {
    return null;
  }
}

const startTimeCache = new Map<string, { result: boolean; ts: number }>();

/**
 * Like isPidRunning, but also verifies the live process's start time matches
 * expectedStartTime (from getPidStartTime() captured when the process was spawned).
 * Windows recycles PIDs — without this check, a crashed/killed process whose PID gets
 * reassigned to an unrelated python(w).exe would look "still running" forever, leaving
 * a dashboard Stop button that writes a shutdown trigger nobody reads. If expectedStartTime
 * is null/undefined (not recorded), falls back to plain PID+image-name matching.
 */
export function isPidRunningAt(pid: number, expectedStartTime?: string | null, force = false): boolean {
  if (!expectedStartTime) return isPidRunning(pid, force);

  const key = `${pid}:${expectedStartTime}`;
  const hit = force ? undefined : startTimeCache.get(key);
  if (hit && Date.now() - hit.ts < PID_CHECK_TTL) {
    return hit.result;
  }

  const result = isPidRunning(pid, force) && getPidStartTime(pid) === expectedStartTime;
  startTimeCache.set(key, { result, ts: Date.now() });
  return result;
}

function firstChildPid(parentPid: number): number | null {
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
 * Resolves the PID that actually corresponds to a just-spawned strategy process, plus its
 * start time. On Windows, venv's Scripts\pythonw.exe (venvlauncher.exe) is a launcher stub
 * that spawns a SEPARATE real interpreter process and just waits on it — so the PID returned
 * by child_process.spawn() is the launcher, not the one that calls os.getpid() and shows up
 * in the strategy's own state file. Without resolving the real child, PID-identity checks
 * compare the launcher's start time against the worker's PID and never match, making every
 * freshly-launched strategy look immediately "stopped" even though it's running fine.
 * Retries briefly since the child may not be visible to WMI for a few hundred ms after spawn.
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
  // No child found within the window (e.g. a venv without the launcher stub) — the
  // launcher process itself is the real worker.
  const startTime = getPidStartTime(launcherPid);
  return startTime ? { pid: launcherPid, startTime } : null;
}
