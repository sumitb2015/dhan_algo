import { NextResponse } from 'next/server';
import { runGit } from '@/lib/gitExec';
import { dedupe } from '@/lib/pyExec';
import { parseCommits, RELEASE_LOG_FORMAT, type ReleaseNote } from '@/lib/releaseNotes';

// Local `git log` only (no fetch), so it is fast and works offline. The cache
// keeps several open tabs polling the bell from spawning git each time.
const TTL_MS = 30_000;
const LOG_DEPTH = 400;
let cache: { at: number; notes: ReleaseNote[] } | null = null;

async function load(): Promise<ReleaseNote[] | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.notes;
  const res = await runGit(
    ['log', '--no-merges', `-n`, String(LOG_DEPTH), `--pretty=format:${RELEASE_LOG_FORMAT}`],
    15_000,
  );
  if (!res.ok) return null;
  const notes = parseCommits(res.stdout);
  cache = { at: Date.now(), notes };
  return notes;
}

/** GET — recent feat / fix / perf commits as release notes, newest first. */
export async function GET() {
  const notes = await dedupe('release-notes', load);
  if (!notes) {
    return NextResponse.json({ success: false, error: 'Could not read git history' }, { status: 500 });
  }
  return NextResponse.json({ success: true, notes });
}
