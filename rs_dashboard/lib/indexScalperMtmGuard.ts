// Index Scalper global MTM target / stop (header, beside Exit All). It watches the day P&L (realized + open) of the
// underlying on screen (see Scope below; the figure is shown in the control) and, when that reaches the
// target or falls to minus the stop, runs Exit All. Like the Price Ladder's MTM guard it then switches itself OFF:
// re-arm it to carry on. It never trips on a partial total (an open position with no price) or with no open position.
// Browser-only: the page must be open (and, for REAL, armed). Pure: no React. Tested in indexScalperMtmGuard.test.ts.
//
// Scope (review 2026-11-26): REAL broker rows are the WHOLE account, but Exit All closes only the underlying on screen. The
// guard therefore sums only that underlying's rows (`guardScopeIds`, the legs' own symbol rules): an account-wide total
// let another underlying's P&L trip an exit of this one (and then switch the guard off with that loss still open).

import { parseScalperContract } from './indexScalperPositions.ts';
import type { Underlying } from './indexScalperInstrument.ts';

export interface MtmGuardSettings {
  on: boolean;
  /** Exit All when the day P&L reaches this many rupees of profit (0 = no target). */
  target: number;
  /** Exit All when the day P&L falls to this many rupees of loss, a positive number (0 = no stop). */
  stop: number;
}

export const MTM_GUARD_DEFAULTS: MtmGuardSettings = { on: true, target: 8000, stop: 8000 };
export const MTM_GUARD_MAX = 10_000_000;

/** A rupee amount typed in the header: a whole, non-negative number up to the max; null = not a valid amount. */
export function parseRupees(raw: string): number | null {
  const s = raw.replace(/[,\s₹]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n <= MTM_GUARD_MAX ? n : null;
}

/** Saved settings (localStorage JSON), with anything missing or invalid taken from the defaults. */
export function readMtmGuard(raw: string | null): MtmGuardSettings {
  let v: Record<string, unknown> = {};
  try { const p = raw ? JSON.parse(raw) : null; if (p && typeof p === 'object') v = p as Record<string, unknown>; } catch { /* defaults */ }
  const amt = (x: unknown, d: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MTM_GUARD_MAX ? x : d);
  return {
    on: typeof v.on === 'boolean' ? v.on : MTM_GUARD_DEFAULTS.on,
    target: amt(v.target, MTM_GUARD_DEFAULTS.target),
    stop: amt(v.stop, MTM_GUARD_DEFAULTS.stop),
  };
}

export type MtmTrip = { kind: 'target' | 'stop'; pnl: number; level: number };

/**
 * Whether the guard trips now. `pnl` null (book not read) or `unpriced` > 0 (a partial total) never trips; nor does a
 * book with no open position (a day already past a level, flat, has nothing to exit).
 */
export function mtmGuardTrip(g: MtmGuardSettings, pnl: number | null, unpriced: number, openPositions: number): MtmTrip | null {
  if (!g.on || pnl === null || !Number.isFinite(pnl) || unpriced > 0 || openPositions === 0) return null;
  if (g.target > 0 && pnl >= g.target) return { kind: 'target', pnl, level: g.target };
  if (g.stop > 0 && pnl <= -g.stop) return { kind: 'stop', pnl, level: g.stop };
  return null;
}

/**
 * The broker rows (open AND closed today) that belong to the underlying on screen, by the id the panel rows carry: Dhan's
 * security id, Kotak's trading symbol. Dhan: the legs' own parser (`parseScalperContract`). Kotak: the exact root then a
 * digit (CRUDEOIL never takes CRUDEOILM's rows). A Kotak row of this root on another expiry is in scope: its realized
 * P&L counts, and while it is open with no price the guard pauses rather than trip on a partial total.
 */
export function guardScopeIds(rows: Record<string, unknown>[], underlying: Underlying, broker: 'dhan' | 'kotak'): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) {
    const sym = String(r.tradingSymbol ?? r.trading_symbol ?? '');
    if (broker === 'kotak') {
      // The NIFTY future is not a leg here (legsFromKotakPositions skips it, so Exit All never closes it): out of scope too.
      if (underlying === 'NIFTY' && sym.endsWith('FUT')) continue;
      if (sym.startsWith(underlying) && /\d/.test(sym.charAt(underlying.length))) ids.add(sym);
    } else if (parseScalperContract(sym, underlying)) {
      const id = String(r.securityId ?? r.security_id ?? '');
      if (id) ids.add(id);
    }
  }
  return ids;
}
