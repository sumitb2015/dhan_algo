// Per-viewer UI preferences in localStorage. Every access is guarded: a private window, blocked site data or SSR has no
// storage, and the page must work without it (it then just forgets the choice).

export function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** A stored value only when it is one of `allowed` (a stale or hand-edited value falls back). */
export function readPrefOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = readPref(key);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function savePref(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: best effort */ }
}
