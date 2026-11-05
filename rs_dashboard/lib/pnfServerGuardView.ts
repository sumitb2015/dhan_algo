// What the P&F / Renko page shows and does about the MTM guards the dashboard SERVER holds (debug/auto_server_guards.json, enforced on
// open REAL AUTO positions by lib/autoServerWatcher.ts). Pure: the page polls the server and applies these rules.
//
// Why: a page opens in PAPER and used to read the server once per load, so a REAL guard could be enforced by the server while the card
// said OFF (2026-11-05: two CRUDEOILM trades exited by a guard the user believed was off). The server's guards are now always listed on
// the page, and the card follows the server for the page's own broker and mode.
import type { LadderGuard } from './priceLadderGuard.ts';

export const GUARD_LEVEL_FIELDS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep', 'targetBoxes', 'stopBoxes'] as const;
export type GuardLevelsIn = Partial<Record<(typeof GUARD_LEVEL_FIELDS)[number], number>>;
export interface ServerGuardView { broker: string; mode: 'PAPER' | 'REAL'; levels: GuardLevelsIn }

/** Same level set (runtime fields such as peak / floor are ignored). */
export function sameGuardLevels(a: GuardLevelsIn, b: GuardLevelsIn): boolean {
  return GUARD_LEVEL_FIELDS.every(f => (a[f] ?? null) === (b[f] ?? null));
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** A short label of a guard's levels, e.g. "T 8 bx · SL 10 bx · trail ₹500". */
export function guardLevelsText(l: GuardLevelsIn): string {
  const parts: string[] = [];
  if (l.targetBoxes != null) parts.push(`T ${l.targetBoxes} bx`);
  if (l.target != null) parts.push(`T ${inr(l.target)}`);
  if (l.stopBoxes != null) parts.push(`SL ${l.stopBoxes} bx`);
  if (l.stop != null) parts.push(`SL ${inr(l.stop)}`);
  if (l.trailBy != null) parts.push(`trail ${inr(l.trailBy)}`);
  if (l.lockAt != null) parts.push(`lock ${inr(l.lockAt)}→${inr(l.lockKeep ?? 0)}`);
  return parts.join(' · ') || 'no levels';
}

export type GuardSync =
  /** Switch the card ON with the server's levels (or update its levels). */
  | { action: 'adopt'; levels: GuardLevelsIn }
  /** The server copy this page had seen is gone (switched off in another tab, or on the server): switch the card OFF. */
  | { action: 'release' }
  | { action: 'none' };

/**
 * One chart's card against the server, for the page's broker and mode. `card`: the card's guard now. `server`: the server's copy for this
 * chart (any broker / mode) or undefined. `wasOnServer`: the previous poll had a copy for this broker and mode. `recentLocalChange`: the
 * card was changed here moments ago (its sync may still be on the wire): nothing is pulled then, the page's own sync is the newer truth.
 */
export function syncGuardFromServer({ card, server, broker, mode, wasOnServer, recentLocalChange }: {
  card: Pick<LadderGuard, 'on'> & GuardLevelsIn; server: ServerGuardView | undefined; broker: string; mode: 'PAPER' | 'REAL';
  wasOnServer: boolean; recentLocalChange: boolean;
}): GuardSync {
  if (recentLocalChange) return { action: 'none' };
  const mine = server && server.broker === broker && server.mode === mode ? server : undefined;
  if (mine) return card.on && sameGuardLevels(card, mine.levels) ? { action: 'none' } : { action: 'adopt', levels: mine.levels };
  // Only a copy that WAS on the server and is gone switches the card off: a card switched on while the chart's box was unknown is not
  // synced yet (it is pushed once the box is known), and must not be switched off for that.
  return card.on && wasOnServer ? { action: 'release' } : { action: 'none' };
}
