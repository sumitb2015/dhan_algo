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
