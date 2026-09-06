import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(process.cwd(), '..');

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command against the repo root. Never throws — failures (bad
 * fast-forward, dirty tree, network error) are routine, expected outcomes
 * here, not exceptional ones, so callers just check `.ok` and surface
 * `.stderr` verbatim rather than any pattern-matched interpretation of it.
 * GIT_TERMINAL_PROMPT=0 guarantees a failed credential lookup errors out
 * instead of hanging the request waiting for interactive input that can
 * never come from a spawned server process.
 */
export async function runGit(args: string[], timeoutMs = 30_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? 'git command failed').trim(),
    };
  }
}
