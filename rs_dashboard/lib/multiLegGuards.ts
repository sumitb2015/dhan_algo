// Multi-Leg Focus guards: spot-level triggers, net-Greek bands and the max-loss / margin alarm.
// Pure rules only (no fetch, no React) so the watcher in MultiLegFocus.tsx stays thin and every decision is tested.
//
// Safety shape shared by all three:
//  - nothing acts on a missing or non-positive reading (unknown is never "breached"),
//  - a trigger must still be breached after SPOT_CONFIRM_MS before it acts (one bad tick cannot exit a book),
//  - an exit trigger records `firedAt` first, so a reload continues the exit instead of ignoring or repeating it,
//  - alarms announce once per escalation and re-arm only after the reading recovers past a hysteresis margin.

import type { MultiLegLeg } from './multiLegFocus.ts';

/** What a spot trigger does when the underlying crosses its level. EXIT_CE / EXIT_PE close every open CE / PE leg. */
export type SpotAction = 'ALERT' | 'EXIT_ALL' | 'EXIT_CE' | 'EXIT_PE';

export interface SpotTrigger {
  id: string;
  /** Underlying price level (must be > 0). */
  level: number;
  /** 'above' fires when spot >= level, 'below' when spot <= level. */
  dir: 'above' | 'below';
  action: SpotAction;
  armed: boolean;
  /** ISO time the breach was confirmed. Set means "firing": an exit action keeps retrying until its scope is flat. */
  firedAt?: string;
}

export type GreekMetric = 'delta' | 'gamma' | 'theta' | 'vega';

/** Net-Greek band for one basket, in the units the Greeks panel shows (delta/gamma in underlying units, theta ₹/day, vega ₹ per 1% IV). */
export interface GreekBand {
  id: string;
  metric: GreekMetric;
  min?: number;
  max?: number;
  /** ALERT only warns; EXIT_ALL squares the whole basket off. (Auto-hedge is deliberately not offered yet.) */
  action: 'ALERT' | 'EXIT_ALL';
  armed: boolean;
  firedAt?: string;
}

/** Rupee max-loss and account margin-utilisation alarm. */
export interface RiskAlarm {
  armed: boolean;
  /** Max tolerated loss in rupees (positive number). */
  maxLoss?: number;
  /** Warn when the loss reaches this % of maxLoss. Default 80. */
  warnPct?: number;
  /** Also close the basket when the full maxLoss is reached. */
  exitAtMaxLoss?: boolean;
  /** Warn when account margin utilisation (used / (used + available)) reaches this %. */
  marginWarnPct?: number;
}

export interface BasketGuards {
  spotTriggers?: SpotTrigger[];
  greekBands?: GreekBand[];
  alarm?: RiskAlarm;
}

export const SPOT_CONFIRM_MS = 3_000;
export const GUARD_EXIT_RETRY_MS = 15_000;
export const DEFAULT_WARN_PCT = 80;
/** A warning clears only after the reading is this many points (of the % scale) back below its threshold. */
export const ALARM_HYSTERESIS_PCT = 5;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

// ── Spot triggers ─────────────────────────────────────────────────────────────

/** True when spot is on the trigger side of its level. An unknown spot is never a breach. */
export function spotBreached(t: Pick<SpotTrigger, 'level' | 'dir'>, spot: number | undefined | null): boolean {
  if (!finite(spot) || !(spot > 0) || !(t.level > 0)) return false;
  return t.dir === 'above' ? spot >= t.level : spot <= t.level;
}

/** Why a trigger cannot be armed right now, or null. Arming past the level would fire on the very next tick. */
export function spotArmBlocker(t: Pick<SpotTrigger, 'level' | 'dir'>, spot: number | undefined | null): string | null {
  if (!(t.level > 0)) return 'Enter a level above 0.';
  if (!finite(spot) || !(spot > 0)) return 'No live spot price yet.';
  if (spotBreached(t, spot)) return `Spot ${spot} is already ${t.dir === 'above' ? 'above' : 'below'} ${t.level}: it would fire immediately.`;
  return null;
}

/** The legs a spot action closes, shorts first. ALERT closes nothing. Only OPEN legs with a fill count. */
export function spotActionLegs(legs: MultiLegLeg[], action: SpotAction): MultiLegLeg[] {
  if (action === 'ALERT') return [];
  const open = legs.filter(l => l.status === 'OPEN' && l.fill && l.option !== 'FUT'
    && (action === 'EXIT_ALL' || l.option === (action === 'EXIT_CE' ? 'CE' : 'PE')));
  return [...open.filter(l => l.side === 'S'), ...open.filter(l => l.side === 'B')];
}

/**
 * Debounce for a breach: returns the time the breach began and whether it has now lasted `confirmMs`.
 * Pass `since = undefined` when no breach was being tracked. Clears (since undefined) the moment it is not breached.
 */
export function confirmBreach(since: number | undefined, breached: boolean, now: number, confirmMs = SPOT_CONFIRM_MS): { since: number | undefined; fire: boolean } {
  if (!breached) return { since: undefined, fire: false };
  const start = since ?? now;
  return { since: start, fire: now - start >= confirmMs };
}

export type GuardStep =
  | { kind: 'idle' }
  | { kind: 'watch'; since: number }
  | { kind: 'fire' }                       // breach confirmed: stamp firedAt, then act
  | { kind: 'finish' }                     // firing and its scope is flat (or it only alerts): disarm
  | { kind: 'retry' };                     // firing, scope still open, retry window elapsed

/**
 * One evaluation of one guard (spot trigger or Greek band). `lastAttempt` is when an exit for it was last sent
 * (retry spacing); `scopeOpen` is how many legs its exit still has to close; `exits` is false for alert-only guards.
 */
export function stepGuard(
  g: { armed: boolean; firedAt?: string }, breached: boolean, exits: boolean, now: number,
  state: { since?: number; lastAttempt?: number; scopeOpen: number },
): GuardStep {
  if (!g.armed) return { kind: 'idle' };
  if (g.firedAt) {
    // Firing: keep going until the scope is flat, whatever the reading does now.
    if (!exits || state.scopeOpen === 0) return { kind: 'finish' };
    return state.lastAttempt != null && now - state.lastAttempt < GUARD_EXIT_RETRY_MS ? { kind: 'idle' } : { kind: 'retry' };
  }
  const c = confirmBreach(state.since, breached, now);
  if (c.fire) return { kind: 'fire' };
  return c.since != null ? { kind: 'watch', since: c.since } : { kind: 'idle' };
}

export function stepSpotTrigger(
  t: SpotTrigger, spot: number | undefined | null, now: number,
  state: { since?: number; lastAttempt?: number; scopeOpen: number },
): GuardStep {
  return stepGuard(t, spotBreached(t, spot), t.action !== 'ALERT', now, state);
}

// ── Greek bands ───────────────────────────────────────────────────────────────

export interface NetGreeks { delta: number; gamma: number; theta: number; vega: number }

export interface BandReading { value: number; breached: boolean; side?: 'min' | 'max' }

/** Reads one band against net Greeks. A missing/NaN value or an empty band is never a breach. */
export function readGreekBand(band: Pick<GreekBand, 'metric' | 'min' | 'max'>, net: NetGreeks | null | undefined): BandReading | null {
  if (!net) return null;
  const value = net[band.metric];
  if (!finite(value)) return null;
  if (finite(band.min) && value < band.min) return { value, breached: true, side: 'min' };
  if (finite(band.max) && value > band.max) return { value, breached: true, side: 'max' };
  return { value, breached: false };
}

/** A band with min above max can never be satisfied: reject it instead of exiting on the first tick. */
export function greekBandInvalid(b: Pick<GreekBand, 'min' | 'max'>): string | null {
  if (!finite(b.min) && !finite(b.max)) return 'Set a min, a max, or both.';
  if (finite(b.min) && finite(b.max) && b.min > b.max) return 'Min is above max.';
  return null;
}

// ── Max-loss and margin alarm ─────────────────────────────────────────────────

export type AlarmLevel = 'ok' | 'warn' | 'breach';
const RANK: Record<AlarmLevel, number> = { ok: 0, warn: 1, breach: 2 };

/** Loss level for a rupee P&L: 'warn' from warnPct of maxLoss, 'breach' at maxLoss. Unknown P&L reads as ok. */
export function lossLevel(pnlRupees: number | undefined | null, alarm: Pick<RiskAlarm, 'maxLoss' | 'warnPct'> | undefined): AlarmLevel {
  if (!alarm || !finite(pnlRupees) || !(alarm.maxLoss != null && alarm.maxLoss > 0)) return 'ok';
  const loss = -pnlRupees;
  if (loss >= alarm.maxLoss) return 'breach';
  const warn = (alarm.warnPct != null && alarm.warnPct > 0 && alarm.warnPct < 100 ? alarm.warnPct : DEFAULT_WARN_PCT) / 100;
  return loss >= alarm.maxLoss * warn ? 'warn' : 'ok';
}

/** Account margin utilisation in % (used / (used + available)), or null when the funds reading is unusable. */
export function marginUtilisationPct(funds: { available: number; used: number } | null | undefined): number | null {
  if (!funds || !finite(funds.available) || !finite(funds.used) || funds.available < 0 || funds.used < 0) return null;
  const total = funds.available + funds.used;
  return total > 0 ? (funds.used / total) * 100 : null;
}

export function marginLevel(utilPct: number | null | undefined, alarm: Pick<RiskAlarm, 'marginWarnPct'> | undefined): AlarmLevel {
  if (!finite(utilPct) || !(alarm?.marginWarnPct != null && alarm.marginWarnPct > 0)) return 'ok';
  return utilPct >= alarm.marginWarnPct ? 'warn' : 'ok';
}

/**
 * Announce-once state machine for an alarm: announce when the level escalates; step down only after the reading has
 * recovered past the hysteresis margin, so a number hovering on a threshold does not toast every poll.
 * `recovered` = the reading is clear of the lower level by ALARM_HYSTERESIS_PCT (caller decides what that means for its metric).
 */
export function nextAlarmState(prev: AlarmLevel, level: AlarmLevel, recovered: boolean): { state: AlarmLevel; announce: boolean } {
  if (RANK[level] > RANK[prev]) return { state: level, announce: true };
  if (RANK[level] < RANK[prev]) return recovered ? { state: level, announce: false } : { state: prev, announce: false };
  return { state: prev, announce: false };
}

/** For loss: recovered once loss is ALARM_HYSTERESIS_PCT of maxLoss below the level it was announced at. */
export function lossRecovered(pnlRupees: number, alarm: Pick<RiskAlarm, 'maxLoss' | 'warnPct'>, prev: AlarmLevel): boolean {
  if (!(alarm.maxLoss != null && alarm.maxLoss > 0)) return true;
  const warn = (alarm.warnPct != null && alarm.warnPct > 0 && alarm.warnPct < 100 ? alarm.warnPct : DEFAULT_WARN_PCT);
  const lowerEdge = prev === 'breach' ? 100 : warn;
  return (-pnlRupees / alarm.maxLoss) * 100 <= lowerEdge - ALARM_HYSTERESIS_PCT;
}

export function marginRecovered(utilPct: number, alarm: Pick<RiskAlarm, 'marginWarnPct'>): boolean {
  return !(alarm.marginWarnPct != null && alarm.marginWarnPct > 0) || utilPct <= alarm.marginWarnPct - ALARM_HYSTERESIS_PCT;
}

// ── Housekeeping ──────────────────────────────────────────────────────────────

/** True when any guard on the basket is armed. */
export function guardsArmed(g: BasketGuards | undefined): boolean {
  return !!g && ((g.spotTriggers ?? []).some(t => t.armed) || (g.greekBands ?? []).some(b => b.armed) || !!g.alarm?.armed);
}

/**
 * Every guard disarmed, nothing else touched. Used when legs move between groups: a trigger such as "exit the call side"
 * written for one set of legs must not start acting on a different set. Also clears `firedAt` so nothing resumes by itself.
 */
export function disarmGuards(g: BasketGuards | undefined): BasketGuards | undefined {
  if (!g) return g;
  return {
    ...(g.spotTriggers ? { spotTriggers: g.spotTriggers.map(t => ({ ...t, armed: false, firedAt: undefined })) } : {}),
    ...(g.greekBands ? { greekBands: g.greekBands.map(b => ({ ...b, armed: false, firedAt: undefined })) } : {}),
    ...(g.alarm ? { alarm: { ...g.alarm, armed: false } } : {}),
  };
}
