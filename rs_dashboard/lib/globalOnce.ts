/**
 * Process-wide state that survives Next's per-bundle module copies. Next compiles each route (and instrumentation)
 * into its own bundle, so a module-level `let` / `new Map()` exists once PER BUNDLE: two callers in one server process
 * then keep two throttles and two caches (Fresh Money's route and exit watcher each read Kotak positions on their own
 * 15 s clock). `globalOnce(key, init)` returns the one object stored on globalThis under `key`, creating it once.
 */
export function globalOnce<T>(key: string, init: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>;
  return (g[key] ??= init());
}
