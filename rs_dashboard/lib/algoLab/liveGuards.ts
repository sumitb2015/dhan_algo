/**
 * Live-engine guards that must hold across tabs and reloads (Breakdown Scalper's, namespaced per strategy).
 * Storage is injected so the rules are testable; the page passes window.localStorage (null when blocked, then an
 * in-memory fallback gives the single-tab behaviour).
 */

export type OrderOutcome = 'ok' | 'failed' | 'unknown';

/** Classify an order route's reply. A network error, a 504 or an `unknown` flag may still have booked: never 'failed'. */
export function classifyOrderReply(
  httpStatus: number | null,
  json: { success?: boolean; unknown?: boolean; error?: string; order_id?: string; orderId?: string } | null,
): { outcome: OrderOutcome; orderId?: string; error?: string } {
  if (httpStatus == null) return { outcome: 'unknown', error: 'no reply' };
  if (json?.success) return { outcome: 'ok', orderId: json.order_id ?? json.orderId };
  if (json?.unknown || httpStatus === 504 || json == null) return { outcome: 'unknown', error: json?.error ?? `HTTP ${httpStatus}` };
  return { outcome: 'failed', error: json.error ?? `HTTP ${httpStatus}` };
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/**
 * Per-position exit state:
 *  - 'inflight' an exit order is being sent (any tab); others must not send one. Expires after INFLIGHT_TTL_MS,
 *               longer than fast-order's worst case (10 s send + ~28 s correlationId reconcile).
 *  - 'exited'   the broker accepted the exit but the ledger close has not landed: retry only the ledger close.
 *  - 'unknown'  the outcome is unknown and it may have filled: never resent automatically.
 */
export type ExitState = 'inflight' | 'exited' | 'unknown';
export type ExitMark = { s: ExitState; at: number };
export const INFLIGHT_TTL_MS = 60_000;
const MARK_MAX_AGE_MS = 24 * 3600_000;

export function exitMarks(kv: KV | null, strategy: string) {
  const key = `algoLab.${strategy}.exitState`;
  let mem: Record<string, ExitMark> = {};
  const readAll = (): Record<string, ExitMark> => {
    if (!kv) return mem;
    try {
      const raw = JSON.parse(kv.getItem(key) ?? '{}') as Record<string, ExitMark>;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return mem;
    }
  };
  return {
    get(id: string, now: number): ExitMark | null {
      const m = readAll()[id];
      if (!m || typeof m.at !== 'number') return null;
      const age = now - m.at;
      if (age > MARK_MAX_AGE_MS || (m.s === 'inflight' && age > INFLIGHT_TTL_MS)) return null;
      return m;
    },
    set(id: string, s: ExitState | null, now: number): void {
      const all = { ...readAll() };
      for (const [k, v] of Object.entries(all)) if (!v || now - v.at > MARK_MAX_AGE_MS) delete all[k];
      if (s) all[id] = { s, at: now };
      else delete all[id];
      mem = all;
      if (!kv) return;
      try {
        kv.setItem(key, JSON.stringify(all));
      } catch {
        /* storage full / blocked: the in-memory copy still guards this tab */
      }
    },
  };
}

export const LEADER_TTL_MS = 5_000;

/** One tab per strategy acts on the ledger; the lock is refreshed every engine tick and stolen only when stale. */
export function claimLeader(kv: KV | null, strategy: string, viewerId: string, now: number): boolean {
  if (!kv) return true; // storage blocked: single-tab assumption
  const key = `algoLab.${strategy}.engineLock`;
  try {
    const raw = kv.getItem(key);
    const cur = raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
    if (!cur || cur.id === viewerId || now - (cur.at ?? 0) > LEADER_TTL_MS) {
      kv.setItem(key, JSON.stringify({ id: viewerId, at: now }));
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function releaseLeader(kv: KV | null, strategy: string, viewerId: string): void {
  if (!kv) return;
  const key = `algoLab.${strategy}.engineLock`;
  try {
    const raw = kv.getItem(key);
    if (raw && (JSON.parse(raw) as { id?: string }).id === viewerId) kv.removeItem(key);
  } catch {
    /* storage blocked */
  }
}
