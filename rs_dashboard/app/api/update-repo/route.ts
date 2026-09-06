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

/** POST — sync local master with origin no matter how it has diverged.
 * Uncommitted local changes are auto-stashed before pulling and restored
 * after, fast-forward is tried first, and only falls back to a real merge
 * commit when local commits exist that a fast-forward can't reconcile. A
 * failure at either the merge or the stash-restore step is surfaced, never
 * silently discarded — the stash is only dropped once it has been cleanly
 * reapplied. */
export async function POST() {
  const branch = await currentBranch();
  if (!branch) {
    return NextResponse.json({ success: false, error: 'Could not resolve the current branch' }, { status: 500 });
  }

  const beforeRes = await runGit(['rev-parse', 'HEAD']);
  const before = beforeRes.ok ? beforeRes.stdout : null;

  const fetchRes = await runGit(['fetch', 'origin', branch], 60_000);
  if (!fetchRes.ok) {
    return NextResponse.json({ success: false, error: fetchRes.stderr || 'git fetch failed' }, { status: 502 });
  }

  const dirtyRes = await runGit(['status', '--porcelain']);
  const dirty = dirtyRes.ok && dirtyRes.stdout.length > 0;

  let stashed = false;
  if (dirty) {
    const stashRes = await runGit(['stash', 'push', '-u', '-m', 'update-app-auto-stash']);
    if (!stashRes.ok) {
      return NextResponse.json(
        { success: false, error: stashRes.stderr || 'Could not stash local changes before pulling' },
        { status: 409 },
      );
    }
    stashed = !/no local changes to save/i.test(stashRes.stdout);
  }

  // Fast-forward first — the clean, no-merge-commit path when local history
  // hasn't diverged from origin. Only reached for local commits ahead of
  // origin as well as behind it; a dirty-but-not-diverged tree already went
  // through the stash above and fast-forwards cleanly.
  let mergeRes = await runGit(['merge', '--ff-only', `origin/${branch}`]);
  let mergedWithCommit = false;
  if (!mergeRes.ok) {
    mergeRes = await runGit(['merge', `origin/${branch}`, '--no-edit'], 60_000);
    mergedWithCommit = mergeRes.ok;
    if (!mergeRes.ok) {
      await runGit(['merge', '--abort']);
      if (stashed) await runGit(['stash', 'pop']);
      return NextResponse.json(
        { success: false, error: mergeRes.stderr || mergeRes.stdout || 'git merge failed — resolve manually' },
        { status: 409 },
      );
    }
  }

  let stashConflict = false;
  if (stashed) {
    const popRes = await runGit(['stash', 'pop']);
    // Leave the stash in place on failure — nothing is lost, but it needs a
    // manual `git stash pop` and conflict resolution.
    stashConflict = !popRes.ok;
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
    message: stashConflict
      ? 'Pulled, but restoring your local changes hit a conflict. They are safe — resolve with `git stash pop` manually.'
      : (mergeRes.stdout || 'Already up to date.'),
    updated,
    needsRestart,
    changedFiles,
    merged: mergedWithCommit,
    stashConflict,
    isProd,
  });
}
