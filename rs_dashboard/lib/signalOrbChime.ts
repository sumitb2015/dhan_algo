// Signal Orb: which sound (if any) one engine tick should make, from the state at the previous tick and now. Pure, so it is
// tested without audio; the engine plays it (leader tab only) and checks the mute switches. Announce-once by construction: a
// sound only comes from a CHANGE between two ticks, never from a state that merely holds.

import type { Signal } from './signalOrb.ts';

export type OrbSound = 'bull' | 'bear' | 'neutral' | 'warn';
export type OrbAlertSnap = {
  signal: Signal;
  /** Newest closed bar the signal was read on. */
  barT: number | null;
  /** Ledger halt reason (null = not halted). */
  halt: string | null;
  /** Price feed fresh. */
  fresh: boolean;
  /** A row needs the user (UNKNOWN outcome, stuck in flight, or from an earlier day). */
  unresolved: string | null;
  engineActive: boolean;
};
export type OrbAlert = { sound: OrbSound; group: 'signal' | 'alert'; reason: string } | null;

/**
 * Priority, highest first: a new halt, a row that now needs the user, the feed going stale while auto is on (all `warn`, group
 * 'alert'), then a colour change on a NEWER closed bar (group 'signal'). A colour change the engine is trading on this tick is
 * left silent (`traded`): the entry / reversal chime says it, and a second sound inside the 1.5 s throttle would be lost anyway.
 * The first tick after load (`prev` null) is silent: history never chimes.
 */
export function orbAlert(prev: OrbAlertSnap | null, cur: OrbAlertSnap, traded: boolean): OrbAlert {
  if (!prev) return null;
  if (cur.halt && cur.halt !== prev.halt) return { sound: 'warn', group: 'alert', reason: `Halted: ${cur.halt}` };
  if (cur.unresolved && cur.unresolved !== prev.unresolved) return { sound: 'warn', group: 'alert', reason: cur.unresolved };
  if (cur.engineActive && prev.fresh && !cur.fresh) return { sound: 'warn', group: 'alert', reason: 'Price feed stale - entries paused' };
  const newBar = cur.barT !== null && prev.barT !== null && cur.barT > prev.barT;
  if (newBar && cur.signal !== prev.signal && !traded) {
    const sound: OrbSound = cur.signal === 'BULL' ? 'bull' : cur.signal === 'BEAR' ? 'bear' : 'neutral';
    return { sound, group: 'signal', reason: `Signal ${prev.signal} -> ${cur.signal}` };
  }
  return null;
}

/**
 * A desktop notification for an alert, or null. Only the 'alert' group (halt, a row needing the user, stale feed, a refused order;
 * never a colour change), only from the leader tab, only when switched on and allowed by the browser, and only while the page is
 * NOT in front of the user (the banner and chime already say it there). Halts and unknown / stuck rows stay up until dismissed.
 */
export function orbNotification(alert: OrbAlert, o: { enabled: boolean; permission: string; leader: boolean; visible: boolean }): { title: string; body: string; sticky: boolean } | null {
  if (!alert || alert.group !== 'alert' || !o.enabled || o.permission !== 'granted' || !o.leader || o.visible) return null;
  const sticky = /^Halted|UNKNOWN|stuck|watcher|not being judged/i.test(alert.reason);
  return { title: sticky ? 'Signal Orb - needs you' : 'Signal Orb', body: alert.reason, sticky };
}
