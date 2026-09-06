import { NextResponse } from 'next/server';
import { runGit } from '@/lib/gitExec';

const RESTART_SENSITIVE_FILES = new Set([
  'rs_dashboard/package.json',
  'rs_dashboard/package-lock.json',
  'rs_dashboard/next.config.ts',
]);

// `next start` serves a pre-built .next bundle — it doesn't watch files or
// recompile like `next dev` does, so *any* pulled source change is invisible
// until a manual `npm run build` + restart, not just the dependency/config
// files that matter under `next dev`.
const isProd = process.env.NODE_ENV === 'production';

async function currentBranch(): Promise<string | null> {
  const res = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.ok ? res.stdout : null;
}

/** GET — fetch from origin (no mutation) and report how far behind/ahead
 * the current branch is, plus the incoming commit subjects. */
export async function GET() {
  const branch = await currentBranch();
  if (!branch) {
    return NextResponse.json({ success: false, error: 'Could not resolve the current branch' }, { status: 500 });
  }

  const fetchRes = await runGit(['fetch', 'origin', branch]);
  if (!fetchRes.ok) {
    return NextResponse.json({ success: false, error: fetchRes.stderr || 'git fetch failed' }, { status: 502 });
  }

  const dirtyRes = await runGit(['status', '--porcelain']);
  const dirty = dirtyRes.ok && dirtyRes.stdout.length > 0;

  const countRes = await runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  let ahead = 0;
  let behind = 0;
  if (countRes.ok) {
    const [a, b] = countRes.stdout.split(/\s+/).map((n) => parseInt(n, 10));
    ahead = Number.isFinite(a) ? a : 0;
    behind = Number.isFinite(b) ? b : 0;
  }

  let incomingCommits: string[] = [];
  if (behind > 0) {
    const logRes = await runGit(['log', `HEAD..origin/${branch}`, '--pretty=format:%h %s']);
    if (logRes.ok && logRes.stdout) incomingCommits = logRes.stdout.split('\n');
  }

  return NextResponse.json({ success: true, branch, ahead, behind, dirty, incomingCommits, isProd });
}

/** POST — pull with --ff-only. Never merges or rebases: if the branch has
 * diverged, or a dirty working tree would be overwritten, git refuses on its
 * own and we just surface that message rather than trying to resolve it. */
export async function POST() {
  const branch = await currentBranch();
  if (!branch) {
    return NextResponse.json({ success: false, error: 'Could not resolve the current branch' }, { status: 500 });
  }

  const beforeRes = await runGit(['rev-parse', 'HEAD']);
  const before = beforeRes.ok ? beforeRes.stdout : null;

  const pullRes = await runGit(['pull', '--ff-only', 'origin', branch], 60_000);
  if (!pullRes.ok) {
    return NextResponse.json(
      { success: false, error: pullRes.stderr || pullRes.stdout || 'git pull failed' },
      { status: 409 },
    );
  }

  const afterRes = await runGit(['rev-parse', 'HEAD']);
  const after = afterRes.ok ? afterRes.stdout : null;
  const updated = !!before && !!after && before !== after;

  let needsRestart = false;
  let changedFiles: string[] = [];
  if (updated && before && after) {
    const diffRes = await runGit(['diff', '--name-only', before, after]);
    if (diffRes.ok && diffRes.stdout) {
      changedFiles = diffRes.stdout.split('\n');
    }
    // Under `next start`, every pulled file needs a rebuild — there's no file
    // watcher to fall back on. Under `next dev`, only these specific files do.
    needsRestart = isProd || changedFiles.some((f) => RESTART_SENSITIVE_FILES.has(f));
  }

  return NextResponse.json({
    success: true,
    message: pullRes.stdout || 'Already up to date.',
    updated,
    needsRestart,
    changedFiles,
    isProd,
  });
}
