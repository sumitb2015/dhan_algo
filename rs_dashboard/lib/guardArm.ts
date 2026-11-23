// Pure decisions of the server-resident guard loop that live around the engine (lib/guardServerCore.ts does the I/O). Kept
// here, with no `@/` imports, so node --test covers them: arming the daily default, the idle-poll skip and the health record.

import type { GuardDefaults } from './guardDefaults.ts';
import type { GuardHealth, ServerGuardState } from './kotakGuardEngine.ts';

/** Poll interval for an armed default while nothing is open (a position then moves it back to the 2.5 s tick). */
export const IDLE_POLL_MS = 10_000;
/** A health record is rewritten when it changes or at least this often, so the banner can tell a stalled watcher from a calm one. */
export const HEALTH_REFRESH_MS = 60_000;

/** Whether today's default guard should be armed now: once per IST day, never over a guard or a lock, never after a clear. */
export function shouldAutoArm(
  state: Pick<ServerGuardState, 'pnl' | 'lock' | 'autoArmedDate'>, defaults: GuardDefaults, today: string, sessionValid: boolean,
): boolean {
  return defaults.enabled && sessionValid && !state.pnl && !state.lock && state.autoArmedDate !== today;
}

/** The state with the default armed (call only when shouldAutoArm says so; re-check inside the lock). */
export function withAutoArm(s: ServerGuardState, d: GuardDefaults, today: string, now: number): ServerGuardState {
  const text = `Daily default armed: loss limit ₹${d.loss}${d.profit > 0 ? `, target ₹${d.profit}` : ''} on ${d.products.join('/')}${d.lockDay ? ' (day lock on)' : ''}`;
  return {
    ...s, autoArmedDate: today, pnl: { profit: d.profit, loss: d.loss, products: d.products, date: today, lockDay: d.lockDay === true },
    events: [...s.events, { at: now, kind: 'armed' as const, text }].slice(-40),
  };
}

/** True while the loop may skip this tick: an armed default with nothing open is polled slowly; anything in flight, any bracket and a lock are not. */
export function shouldSkipIdleTick(
  s: Pick<ServerGuardState, 'lock' | 'brackets' | 'watch'>, idleUntil: number, now: number,
): boolean {
  return !s.lock && s.brackets.length === 0 && s.watch.length === 0 && now < idleUntil;
}

/** The health record to write, or null when the stored one is still current. */
export function nextHealth(prev: GuardHealth | undefined, watching: boolean, reason: string, now: number): GuardHealth | null {
  if (prev && prev.watching === watching && prev.reason === reason && now - prev.at < HEALTH_REFRESH_MS) return null;
  return { watching, reason, at: now };
}
