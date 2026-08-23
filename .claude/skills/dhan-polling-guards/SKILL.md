---
name: dhan-polling-guards
description: Use when adding or debugging a poll loop, a cached fetch, a read-modify-write on a JSON file under debug/, or an API route that spawns a Python script or WebSocket bridge. Covers duplicate spawns, lost updates, stale cache entries, out-of-order responses, and Dhan rate-limit races across dashboard windows.
---

# Dhan Polling, Caching & Race Guards

## Overview
The dashboard is a polling application on top of a rate-limited broker API, with
several windows often open at once and Python processes spawned from API routes.
Nine separate commits fixed the same family of bug: an operation that is safe with
one caller in one tab, and wrong with two.

The recurring root cause is **check-then-act with nothing serializing it**.

## When to Use
- Adding a `setInterval` poll, a `cachedFetch`, or any page that refetches on a
  selector change.
- Any route that spawns a process (`refresh/`, `live-*`, `options/live`,
  `crudeoil-oi-collector/`, `backfill/`) or persists JSON under `debug/`.
- Debugging "why are there N copies of this process", "my save got clobbered",
  "the page shows data for the previous selection", or a chart spike.

## The Guards

### 1. A status file is not a lock
The start branch of the options bridge read the status file, saw "not running", and
spawned. A freshly spawned bridge takes a second or two to write its status, so
concurrent starts — a page mount under StrictMode, a second tab, a fast
broker/expiry toggle — each read "not running" and each spawned. The evidence was
**30 orphaned `live_options_ws.py` processes started in one afternoon**, several
sharing a ws-port and so unable to serve at all.

`findFreePort` compounds it: it binds, closes, then returns the port, so racing
callers are handed the same one.

`dedupe()` in `lib/pyExec.ts` is not sufficient on its own here — its inflight Map
is module-scoped and per-process. `app/api/options/live/route.ts` uses an atomic
on-disk lock (`fs.writeFileSync(lockPath, ..., { flag: 'wx' })`) with a
`LOCK_STALE_MS` steal window, so a start that crashed before releasing does not
block the bridge forever. Copy that pattern for any new spawn route. (`f776aa3`)

For plain read-only Python invocations, `dedupe(key, fn)` from `lib/pyExec.ts` is the
right tool — see `app/api/options/live-charts/route.ts`.

### 2. Read-modify-write on a JSON file needs a queue
`readConfig()` / `writeConfig()` with no locking means two concurrent POSTs (two tabs
saving around the same time) both read the same pre-write snapshot, and the later
write silently clobbers the earlier one.

`app/api/portfolio-weekly-target/route.ts` serializes through an in-process promise
chain — copy it:
```ts
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => T): Promise<T> {
  const result = writeQueue.then(fn, fn);      // run even if the previous cycle threw
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}
```
(`3ea2450`)

### 3. Never cache an unsuccessful or empty response
Routes in this repo surface a Python-script failure as **200 OK JSON** with
`{success:false}` or an empty data array. `cachedFetch()` memoized those and served
them stale for the full TTL. It takes an `isValid` predicate for exactly this
(`lib/clientCache.ts:52`; default is "not explicitly `success:false`"). Pass a
stricter one where an empty array is also not-yet-cacheable. (`83a932b`)

### 4. Guard against out-of-order responses
A slow abandoned fetch can resolve after the one the user is actually looking at and
overwrite it. Use a monotonic request sequence — `app/trending-oi/page.tsx:79-80`:
```ts
const seq = ++requestSeq.current;
const isStale = () => seq !== requestSeq.current;
```
Check `isStale()` before every `setState` in the async body, not just once at the
end. (`5a6bdc7`)

Server-side, key the cache TTL off the data's own liveness verdict, not off a request
parameter — keying on "did the caller pass `?date=`" froze *today* for 24h.

### 5. Fall back to the last good value, never to a session-open value
`iv_snapshot_collector.py` fell back to the market-open spot whenever `get_ltp()` had
a transient hiccup, producing a one-tick spike back to the 09:15 price hours into the
session — permanently written into the CSV. Fall back to the last successfully
fetched live price, and hold if there isn't one. (`5722417`)

If a series already contains such spikes, a despike pass (a point that jumps away
from both neighbours while they stay close to each other) can clean them at read time
without touching the raw CSV.

### 6. Dhan rate buckets are account-wide; helper spacing is per-process
`DhanHelper`'s 1 req/s spacing only covers one process. With several dashboard
windows open, each spawning its own fetch script, a per-render option-chain call
(capped ~1 call/3s account-wide) loses the race, returns empty, and the page reports
"cannot determine strikes" for a perfectly healthy chain.

Static data — strike ladders, CE/PE security ids, expiry lists — is already in
`master_list.csv`. Read it from there and keep the API call as a fallback for an
expiry missing from the master. (`867ad07`)

### 7. Surface the error instead of reporting "no data"
Data API methods return empty on failure. A `DH-902` subscription lapse or an auth
failure otherwise reads as "no data / market may have been closed". Thread
`helper.last_api_error` through and report it in every bail message; short-circuit on
a fatal error rather than burning 25s of paced calls to reach the same answer.
(`5a6bdc7`)

### 8. A detached spawn outlives the frontend that started it

`spawn(PYTHON_EXE, [...], { detached: true })` (the Focus Tool rows worker,
started from `app/api/focus-tool/worker/route.ts`) is intentionally independent
of the Next.js process — that's what lets it keep watching entries/exits after
the browser tab closes. It also means **restarting the Next.js dev server does
not stop it**. Debugging a worker that appears stuck after a frontend restart
by only restarting the frontend again is chasing nothing — the old process (or
several, from repeated Start clicks) is still running, still writing to the
same status file, and a fresh Start click can no-op against it (`currentStatus()`
sees `RUNNING` with a matching broker and returns "already running" without
spawning anything new).

Diagnose with the OS, not the UI: `Get-CimInstance Win32_Process -Filter
"Name='pythonw.exe'"` (PowerShell) filtered on the script's command line shows
every live instance and its actual start time — compare that against when a
code fix landed to tell whether you're looking at a fresh process or a stale
one still running the old code. To clear a stuck one without a hard kill,
write the same stop-trigger file the app's own Stop button writes
(`debug/focus_tool_rows_worker_stop.trigger`) and confirm the process list goes
empty — cleaner than `Stop-Process`, since it lets the worker exit through its
own shutdown path rather than being killed mid-write. (Encountered while
debugging `dd5c3a0 revert(focus-tool): back out the unfinished WebSocket-feed
refactor` — two stale pre-fix processes kept erroring long after the source
file was already corrected.)

This applies to every `detached: true` spawn in the dashboard, not just this
one — grep `detached: true` in `app/api/` before assuming a restart cleared
anything.

## Before You Ship
- Can two tabs run this at once? What happens if they do?
- If this spawns something, what stops a second spawn during the startup window?
- If this caches, what does it do with a `{success:false}` 200?
- If this is async and sets state, what happens when the previous request lands last?
