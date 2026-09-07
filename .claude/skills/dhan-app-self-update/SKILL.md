---
name: dhan-app-self-update
description: Use when touching rs_dashboard/app/api/update-repo/route.ts, rs_dashboard/lib/gitExec.ts, or rs_dashboard/components/UpdateAppPanel.tsx — the in-dashboard "Update App" button that pulls from GitHub and reports whether a rebuild/restart is needed. Not for general git usage — this is specifically the self-modifying-app mechanics: dev-vs-prod rebuild detection, diverged-history merge safety, and surfacing "you must restart" to a user who is looking at the very app that needs restarting.
---

# Dhan App Self-Update

## Overview
The dashboard can update itself from GitHub without a terminal: `NavBar`'s
Update App button hits `POST /api/update-repo`, which fetches, stashes any
dirty local state, fast-forwards or merges, and reports whether the running
process needs a rebuild/restart before the pulled code takes effect. It took 4
commits in one day (`9344484`, `a1529fe`, `eae1bf6`, `b20aa24`) to get the
restart-detection and merge-safety right — read `route.ts`'s and
`UpdateAppPanel.tsx`'s own header/inline comments first, they're detailed and
this skill doesn't repeat all of them.

## When to Use
- Changing what counts as "restart required."
- Changing the git sync strategy (fetch/stash/merge order).
- Adding a new signal to the Update App panel (e.g. a changelog, a diff
  preview) that needs to read `route.ts`'s response shape.
- Debugging: update reports success but the running page still shows old
  behavior, or a user's uncommitted local edit went missing after an update.

## Invariants

1. **`next start` (production) needs a rebuild for *any* pulled change; `next
   dev` only needs a restart for a narrow set of files.** `isProd =
   process.env.NODE_ENV === 'production'` short-circuits `needsRestart` to
   `true` unconditionally under `next start`, because it serves a pre-built
   `.next` bundle with no file watcher — a pulled source change is invisible
   until a manual rebuild no matter what changed. Under `next dev`,
   `needsRestart` is instead computed from whether any pulled file is in
   `RESTART_SENSITIVE_FILES` (`package.json`, `package-lock.json`,
   `next.config.ts`) — anything else, the dev server's own watcher picks up
   live. **Don't collapse this to one rule** — a dev-mode-only heuristic would
   under-report in production, and a prod-mode-only "always restart" would
   make every dev-mode pull needlessly nag for a restart it doesn't need.

2. **Local uncommitted changes are auto-stashed before pulling, and the stash
   is only ever dropped after it re-applies cleanly.** A stash-pop conflict
   surfaces as `stashConflict: true` with an explicit "resolve with `git stash
   pop` manually" message — it never silently discards the stash. If you add
   a new failure branch to the POST handler, preserve this property: nothing
   this route does should be able to lose a user's uncommitted local edit
   without telling them exactly how to recover it.

3. **Fast-forward is tried first; a real merge commit only happens if
   fast-forward fails.** `git merge --ff-only origin/<branch>` covers the
   common case (no local commits ahead of origin). Only on its failure does
   the route fall back to `git merge origin/<branch> --no-edit`, and only a
   failure of *that* triggers `git merge --abort` + stash restore + a 409 with
   the raw git error surfaced. Never skip straight to the merge-commit path —
   it produces a merge commit even when a clean fast-forward was available,
   cluttering history for the common no-divergence case.

4. **`GIT_TERMINAL_PROMPT=0` on every git call, no exceptions.** `runGit()` in
   `gitExec.ts` sets this so a failed credential lookup errors out immediately
   instead of hanging the request — a spawned Next.js API route can never
   satisfy an interactive credential prompt, so without this a bad/expired
   git credential turns into an indefinitely hung request, not a clean error.

5. **The restart-required state is announced as a blocking modal, not an
   inline panel line.** `UpdateAppPanel.tsx` deliberately interrupts with
   `aria-modal="true"` when `needsRestart` is true, rather than just adding
   another line to the results sheet — the user is looking at the exact
   process that's about to serve stale code, so a dismissible inline note is
   easy to miss and keep using the app. Keep any new "action required" signal
   from this route at the same modal severity, not folded into the passive
   result summary.

## Common Mistakes
- Adding a new "does this file need a restart" file to the dev-mode check
  without asking whether it also needs a rebuild under prod — under `isProd`
  the check doesn't even run, so this only matters for the dev-mode list.
- Treating a fast-forward failure as a hard error instead of falling through
  to the real-merge attempt — divergence (local commits + incoming commits)
  is a routine, expected case here, not exceptional.
- Building a new mutation into `route.ts`'s POST without checking `runGit`'s
  `.ok` before proceeding to the next git step — `runGit` never throws by
  design (see `gitExec.ts`'s own comment), so an unchecked `.ok` silently
  chains a git command onto a repo left in a bad state by the previous one.
- Surfacing a new failure mode as a passive UI state when it should block —
  match invariant 5's severity for anything that means "the code you're
  looking at is now stale."
