import { istDateIso } from './nseHolidays.ts';
import { istMinuteOfDay } from './istTime.ts';
import { mcxSession } from './mcxSession.ts';
import { resolveFuture, type FnoRow } from './pnfContracts.ts';
import { targetKey, type Target } from './pnfTarget.ts';
import { futureTarget, legExpiry } from './gearboxCore.ts';
import { isLive, type GbLedger } from './gearboxLedger.ts';
import type { WantedPair } from './pnfWanted.ts';

// Which crude futures the dashboard server keeps in the price bridge's tick log for Gearbox's 5-30 s bars, and when
// (lib/gearboxAlwaysRecord.ts does the asking). Pure apart from the master list read when `from` is omitted. Read-only: no orders.

const hhmmToMin = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

/** True from the MCX open to the close of today's session (open <= IST minute < close); a closed day (weekend, holiday) is false. */
export function mcxRecordOpen(nowMs: number): boolean {
  const s = mcxSession(istDateIso(nowMs));
  const m = istMinuteOfDay(nowMs);
  return s.open < s.close && m >= hhmmToMin(s.open) && m < hhmmToMin(s.close);
}

/**
 * The futures to record: the configured underlying's signal future (futureTarget of its nearest option expiry after today, the
 * future the page's bars are built on) plus the future of every live FUT row (it may be on another underlying or expiry after a
 * config change). De-duplicated; a contract missing from the master list is skipped.
 */
export function gbRecordTargets(l: GbLedger, today: string, from?: FnoRow[]): Target[] {
  const out = new Map<string, Target>();
  const u = l.config.underlying;
  const nearest = legExpiry(u, { action: 'BUY', opt: 'CE', offset: 0, expiry: 'nearest' }, today, from);
  const sig = /^\d{4}-\d{2}-\d{2}$/.test(nearest) ? futureTarget(u, nearest, from) : null;
  if (sig) out.set(targetKey(sig), sig);
  for (const r of l.rows) if (isLive(r) && r.target.kind === 'futures') out.set(targetKey(r.target), r.target);
  return [...out.values()];
}

/** The bridge pairs ([segment, security id]) of gbRecordTargets. */
export function gbRecordPairs(l: GbLedger, today: string, from?: FnoRow[]): WantedPair[] {
  const pairs: WantedPair[] = [];
  for (const t of gbRecordTargets(l, today, from)) {
    const c = t.expiry ? resolveFuture(t.symbol, t.expiry, from) : null;
    if (c && !pairs.some(p => p[0] === c.segment && p[1] === c.securityId)) pairs.push([c.segment, c.securityId]);
  }
  return pairs;
}
