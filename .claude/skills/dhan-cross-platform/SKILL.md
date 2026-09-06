---
name: dhan-cross-platform
description: Use when writing or reviewing code in rs_dashboard that spawns a Python process, resolves a filesystem path, kills a process, or renders a GPU-composited animation — this codebase was written Windows-first (CLAUDE.md's own command reference is PowerShell) but now runs on Linux dev machines too, and the same class of "works on Windows, breaks on Linux" bug keeps recurring.
---

# Cross-Platform (Windows ⇄ Linux) Compatibility

## Overview
`CLAUDE.md` documents this repo in Windows/PowerShell terms (`c:\dhan_algo\dhan_algo`,
`venv\Scripts\python.exe`), but active development also happens on Linux. Four
separate commits in one week fixed the same underlying mistake — code (or an
example in a skill) that assumed Windows and threw `ENOENT`, hung, or crash-looped
on Linux instead: `137b131` (Python resolution + IV collector auth retry),
`2e449700` (framer-motion login background — insufficient fix, see below),
`e2fceeb` (21 routes hardcoded `pythonw.exe`; `taskkill` force-kill), and the
login background's actual fix (animation disabled on Linux via UA check, since
`2e449700`'s "reduce path count + add `translateZ(0)`" did not resolve it).

## When to Use
- Adding a new API route under `rs_dashboard/app/api/` that spawns a Python
  script, or copying an existing route as a template.
- Writing code that kills/checks a process by PID.
- Adding or reviewing a GPU-composited CSS/SVG animation (framer-motion,
  `transform: translateZ/matrix3d`, `will-change`) anywhere in `rs_dashboard`.
- Any `path.join(...)` that spells out `venv`, `Scripts`, or `.exe` directly
  instead of importing from `lib/pyExec.ts`.

## Rules

### 1. Never hardcode the Python executable path
`venv/Scripts/pythonw.exe` is Windows-only (POSIX venvs put the interpreter at
`venv/bin/python3`). Import `PYTHON_EXE` and `PROJECT_ROOT` from
`lib/pyExec.ts` — it already probes both layouts and falls back to `python3`/
`python` on `PATH`:
```ts
import { PYTHON_EXE, PROJECT_ROOT } from '@/lib/pyExec';
```
21 routes got this wrong before `e2fceeb` swept them — grep for
`'venv', 'Scripts'` or `pythonw.exe` in a new/copied route before merging; either
literal appearing outside `pyExec.ts` itself is the bug.

### 2. Process kill must branch on `process.platform`
`taskkill /PID <pid> /T /F` doesn't exist on Linux/macOS. Branch it:
```ts
function forceKillProcessTree(pid: number) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe', windowsHide: true });
  } else {
    execSync(`kill -9 -${pid}`, { stdio: 'pipe' });  // negative PID = the process group
  }
}
```
The negative-PID form on POSIX only works because strategies/workers are always
spawned with `detached: true`, which makes the child its own process group
leader — `kill -9 -PID` then reaches the whole tree, mirroring `taskkill /T`.
(`e2fceeb`, in `app/api/strategies/route.ts`)

### 3. Diagnosing a stuck/orphaned process: know both OS's command
`dhan-polling-guards` guard 8 gives the PowerShell way to list live Python
processes (`Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'"`). On
Linux, the equivalent is `pgrep -fa python` (or `ps aux | grep <script name>`)
— filter on the script's command line the same way, since PID reuse makes a
bare PID number meaningless across a restart.

### 4. GPU-composited animations can crash-loop Chrome on Linux — don't just tune it, gate it
The login page's `FloatingPaths` background (`components/ui/background-paths.tsx`)
runs 12+ `framer-motion` SVG paths animating `pathLength`/`pathOffset` forever,
under a `transform: translateZ(0)` that forces a GPU compositor layer. On some
Linux GPU/driver stacks (Mesa llvmpipe, VMs, remote desktops, older Intel
drivers) this repeatedly crashes Chrome's GPU process, which reads as the whole
page rapidly flickering/refreshing — it does not reproduce on Windows' GPU
stack. `2e449700` tried to fix this by cutting the path count (36→12) and
tuning `strokeOpacity`/duration — **that did not fix it**; the crash-loop is
about the animation model (rAF-driven attribute mutation + forced layer), not
its complexity. The actual fix detects Linux client-side
(`/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)`,
via a `useEffect` so SSR/hydration still matches) and renders a **static**,
unanimated version of the same paths on Linux only — Windows keeps the original
animation unchanged. If you hit a similar "whole page flickers" report tied to
a decorative animation, reach for gating by platform before reaching for tuning
parameters; tuning already failed once here.

## Common Mistakes
- Copying an existing API route as a template for a new one — if the template
  predates `e2fceeb`, it may still carry the hardcoded `pythonw.exe` path
  (check `dhan-dashboard-page`'s Path Resolution section is current before
  trusting it verbatim).
- Testing a Linux fix only by reading the diff — GPU compositing bugs are
  driver/environment-specific; when possible, actually load the page in a
  browser running on the target OS (see the login background fix, verified via
  `mcp__claude-in-chrome__*` in-session) rather than reasoning from the diff alone.
- Assuming a `.exe`/`taskkill`/backslash-path fix only matters for the one
  route being edited — these bugs come in sweeps (21 routes in one commit);
  grep the whole `app/api/` tree for the same literal before considering the
  fix done.
