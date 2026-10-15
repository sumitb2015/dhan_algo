// Multi-Leg Focus guards ("Risk rules" in the UI): spot-level triggers, net-Greek bands, the max-loss rule and the margin-use alert.
// Pure rules only (no fetch, no React) so the watcher in MultiLegFocus.tsx stays thin and every decision is tested.
//
// Safety shape shared by all three:
//  - nothing acts on a missing or non-positive reading (unknown is never "breached"),
//  - a trigger must still be breached after SPOT_CONFIRM_MS before it acts (one bad tick cannot exit a book),
//  - an exit trigger records `firedAt` first, so a reload continues the exit instead of ignoring or repeating it,
//  - alarms announce once per escalation and re-arm only after the reading recovers past a hysteresis margin.

import { LEG_FILL_GRACE_MS, type MultiLegLeg } from './multiLegFocus.ts';

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
  /** IST day (YYYY-MM-DD) it was armed. An armed guard does not carry into another day (see expireStaleGuards). */
  armedDay?: string;
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
  armedDay?: string;
  firedAt?: string;
}

/** Rupee max-loss rule, measured on today's P&L (live legs plus legs closed today, the page's Today P&L). */
export interface RiskAlarm {
  armed: boolean;
  armedDay?: string;
  /** Max tolerated loss in rupees (positive number). A heads-up is announced at DEFAULT_WARN_PCT of it. */
  maxLoss?: number;
  /** Also close the basket when the full maxLoss is reached. */
  exitAtMaxLoss?: boolean;
  /** ISO time the close-at-max-loss exit started. Set means "closing": it retries until flat, then the alarm disarms, so a
   *  position added afterwards is not closed by a loss that was already realized. */
  firedAt?: string;
}

/** Account margin-utilisation alert (used / (used + available)). Alert only, account-wide, with its own switch. */
export interface MarginAlarm {
  armed: boolean;
  armedDay?: string;
  /** Alert when utilisation reaches this %. */
  pct?: number;
}

export interface BasketGuards {
  spotTriggers?: SpotTrigger[];
  greekBands?: GreekBand[];
  alarm?: RiskAlarm;
  marginAlarm?: MarginAlarm;
}

/** Fields older saves carried on `alarm` (before 2026-10-15): margin shared the loss rule's switch, and the warn % and
 *  P&L scope were editable. normalizeGuards moves them out. */
type LegacyRiskAlarm = RiskAlarm & { lossScope?: 'today' | 'total'; warnPct?: number; marginWarnPct?: number };

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
  if (spotBreached(t, spot)) return `Spot is already ${t.dir === 'above' ? 'above' : 'below'} ${t.level.toLocaleString('en-IN')}, so this rule would fire at once. Pick a level spot has not reached.`;
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
 * True while an exit on the legs `action` names may still be unconfirmed: any of them holds a pending order, or was closed
 * within the fill-grace window. An exit flips the leg to CLOSED on ACK, so a flat scope alone does not mean the position is
 * flat: a rejected exit reopens the leg once the order book says so.
 */
export function legsSettling(legs: MultiLegLeg[], action: SpotAction, now: number): boolean {
  return legs.some(l => {
    if (l.option === 'FUT') return false;
    if (action === 'EXIT_CE' && l.option !== 'CE') return false;
    if (action === 'EXIT_PE' && l.option !== 'PE') return false;
    // A resting limit exit leaves the leg OPEN and unconfirmed-free: it must never hold a guard back (the guard's own exit cancels it first).
    if ((l.pendingOrders ?? []).some(p => !p.resting)) return true;
    return l.status === 'CLOSED' && l.closedAt != null && now - l.closedAt >= 0 && now - l.closedAt < LEG_FILL_GRACE_MS;
  });
}

/**
 * True when a SHORT leg on that side was closed but its exit is not yet confirmed. A retry whose scope is hedges only (the
 * shorts already ACKed closed) must wait: if that exit is then rejected the short reopens, and selling the hedge first
 * would have left it naked.
 */
export function shortsSettling(legs: MultiLegLeg[], action: SpotAction, now: number): boolean {
  return legsSettling(legs.filter(l => l.side === 'S'), action, now);
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
 * `settling` = an exit order on its scope is still unconfirmed (see legsSettling): an exit marks the leg CLOSED when the broker
 * ACKs it, and a rejection later reopens it, so the guard must not finish (and stop retrying) until that has settled.
 */
export function stepGuard(
  g: { armed: boolean; firedAt?: string }, breached: boolean, exits: boolean, now: number,
  state: { since?: number; lastAttempt?: number; scopeOpen: number; settling?: boolean },
): GuardStep {
  if (!g.armed) return { kind: 'idle' };
  if (g.firedAt) {
    // Firing: keep going until the scope is flat, whatever the reading does now.
    if (!exits) return { kind: 'finish' };
    if (state.scopeOpen === 0) return state.settling ? { kind: 'idle' } : { kind: 'finish' };
    return state.lastAttempt != null && now - state.lastAttempt < GUARD_EXIT_RETRY_MS ? { kind: 'idle' } : { kind: 'retry' };
  }
  const c = confirmBreach(state.since, breached, now);
  if (c.fire) return { kind: 'fire' };
  return c.since != null ? { kind: 'watch', since: c.since } : { kind: 'idle' };
}

export function stepSpotTrigger(
  t: SpotTrigger, spot: number | undefined | null, now: number,
  state: { since?: number; lastAttempt?: number; scopeOpen: number; settling?: boolean },
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
  if (!finite(b.min) && !finite(b.max)) return 'Enter a lower limit, an upper limit, or both.';
  if (finite(b.min) && finite(b.max) && b.min > b.max) return 'The lower limit is above the upper limit.';
  return null;
}

// ── Max-loss and margin alarm ─────────────────────────────────────────────────

export type AlarmLevel = 'ok' | 'warn' | 'breach';
const RANK: Record<AlarmLevel, number> = { ok: 0, warn: 1, breach: 2 };

/** Loss level for a rupee P&L: 'warn' from DEFAULT_WARN_PCT of maxLoss, 'breach' at maxLoss. Unknown P&L reads as ok. */
export function lossLevel(pnlRupees: number | undefined | null, alarm: Pick<RiskAlarm, 'maxLoss'> | undefined): AlarmLevel {
  if (!alarm || !finite(pnlRupees) || !(alarm.maxLoss != null && alarm.maxLoss > 0)) return 'ok';
  const loss = -pnlRupees;
  if (loss >= alarm.maxLoss) return 'breach';
  return loss >= alarm.maxLoss * (DEFAULT_WARN_PCT / 100) ? 'warn' : 'ok';
}

/** Account margin utilisation in % (used / (used + available)), or null when the funds reading is unusable. */
export function marginUtilisationPct(funds: { available: number; used: number } | null | undefined): number | null {
  if (!funds || !finite(funds.available) || !finite(funds.used) || funds.available < 0 || funds.used < 0) return null;
  const total = funds.available + funds.used;
  return total > 0 ? (funds.used / total) * 100 : null;
}

export function marginLevel(utilPct: number | null | undefined, m: Pick<MarginAlarm, 'pct'> | undefined): AlarmLevel {
  if (!finite(utilPct) || !(m?.pct != null && m.pct > 0)) return 'ok';
  return utilPct >= m.pct ? 'warn' : 'ok';
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
export function lossRecovered(pnlRupees: number, alarm: Pick<RiskAlarm, 'maxLoss'>, prev: AlarmLevel): boolean {
  if (!(alarm.maxLoss != null && alarm.maxLoss > 0)) return true;
  const lowerEdge = prev === 'breach' ? 100 : DEFAULT_WARN_PCT;
  return (-pnlRupees / alarm.maxLoss) * 100 <= lowerEdge - ALARM_HYSTERESIS_PCT;
}

export function marginRecovered(utilPct: number, m: Pick<MarginAlarm, 'pct'>): boolean {
  return !(m.pct != null && m.pct > 0) || utilPct <= m.pct - ALARM_HYSTERESIS_PCT;
}

// ── Housekeeping ──────────────────────────────────────────────────────────────

/**
 * Moves fields older saves kept on `alarm` (see LegacyRiskAlarm) to today's shape. Idempotent; returns `g` itself when it is
 * already current. The margin level becomes its own rule (keeping its switch). A loss rule whose meaning changed (it
 * counted all trades, or warned at another %) is turned off rather than silently re-scoped. A legacy alarm with no max
 * loss was a margin-only alarm, so it leaves no loss rule behind.
 */
export function normalizeGuards(g: BasketGuards | undefined): BasketGuards {
  if (!g) return {};
  const a = g.alarm as LegacyRiskAlarm | undefined;
  if (!a || (a.lossScope === undefined && a.warnPct === undefined && a.marginWarnPct === undefined)) return g;
  const { lossScope, warnPct, marginWarnPct, ...loss } = a;
  const out: BasketGuards = { ...g };
  if (marginWarnPct != null && marginWarnPct > 0 && !g.marginAlarm) {
    out.marginAlarm = { armed: a.armed, ...(a.armed && a.armedDay ? { armedDay: a.armedDay } : {}), pct: marginWarnPct };
  }
  if ((loss.maxLoss != null && loss.maxLoss > 0) || loss.firedAt) {
    const changed = lossScope === 'total' || (warnPct != null && warnPct !== DEFAULT_WARN_PCT);
    // A close-at-max-loss already under way keeps going: stopping it halfway would leave part of the book open.
    out.alarm = changed && loss.armed && !loss.firedAt ? { ...loss, armed: false, armedDay: undefined } : loss;
  } else {
    delete out.alarm;
  }
  return out;
}

/** True when the migration in normalizeGuards turned an armed max-loss rule off. */
export function lossRuleDisarmedByMigration(before: BasketGuards | undefined, after: BasketGuards): boolean {
  return !!before?.alarm?.armed && !!before.alarm.maxLoss && !after.alarm?.armed;
}

/**
 * True when any guard is armed AS STORED (not normalized). The watcher gates on this, so a legacy rule that normalizeGuards
 * would turn off still reaches the engine once, which stores the new shape and says so. Use armedRuleCount for display.
 */
export function guardsArmed(g: BasketGuards | undefined): boolean {
  return !!g && ((g.spotTriggers ?? []).some(t => t.armed) || (g.greekBands ?? []).some(b => b.armed) || !!g.alarm?.armed || !!g.marginAlarm?.armed);
}

/** How many rules on the basket are switched on. */
export function armedRuleCount(g: BasketGuards | undefined): number {
  if (!g) return 0;
  const n = normalizeGuards(g);
  return (n.spotTriggers ?? []).filter(t => t.armed).length + (n.greekBands ?? []).filter(b => b.armed).length
    + (n.alarm?.armed ? 1 : 0) + (n.marginAlarm?.armed ? 1 : 0);
}

/**
 * Every guard disarmed, nothing else touched. Used when legs move between groups: a trigger such as "exit the call side"
 * written for one set of legs must not start acting on a different set. Also clears `firedAt` so nothing resumes by itself.
 */
export function disarmGuards(g: BasketGuards | undefined): BasketGuards | undefined {
  if (!g) return g;
  g = normalizeGuards(g);
  return {
    ...(g.marginAlarm ? { marginAlarm: { ...g.marginAlarm, armed: false } } : {}),
    ...(g.spotTriggers ? { spotTriggers: g.spotTriggers.map(t => ({ ...t, armed: false, firedAt: undefined })) } : {}),
    ...(g.greekBands ? { greekBands: g.greekBands.map(b => ({ ...b, armed: false, firedAt: undefined })) } : {}),
    ...(g.alarm ? { alarm: { ...g.alarm, armed: false, firedAt: undefined } } : {}),
  };
}

// ── Edit reducers ─────────────────────────────────────────────────────────────
// The panel applies these through a functional state update (patchGuards), never from the render's copy of `guards`: the
// watcher writes the same object (firedAt, armed) and a stale whole-object write would revert it. Each reducer touches
// only the item it names and leaves every other array by reference.

const upd = <T extends { id: string }>(arr: T[] | undefined, id: string, fn: (x: T) => T): T[] | undefined =>
  arr?.map(x => (x.id === id ? fn(x) : x));

// Every reducer normalizes first, so an edit on a basket saved in the older shape writes the current shape.
const N = normalizeGuards;

export const addSpotTrigger = (g: BasketGuards, t: SpotTrigger): BasketGuards => { g = N(g); return { ...g, spotTriggers: [...(g.spotTriggers ?? []), t] }; };
export const removeSpotTrigger = (g: BasketGuards, id: string): BasketGuards => { g = N(g); return { ...g, spotTriggers: (g.spotTriggers ?? []).filter(t => t.id !== id) }; };
/** Any edit disarms: a level changed under a live guard could fire on the very next tick. */
export const editSpotTrigger = (g: BasketGuards, id: string, patch: Partial<SpotTrigger>): BasketGuards =>
  { g = N(g); return { ...g, spotTriggers: upd(g.spotTriggers, id, t => ({ ...t, ...patch, armed: false, firedAt: undefined })) }; };
export const setSpotArmed = (g: BasketGuards, id: string, armed: boolean, day?: string): BasketGuards =>
  { g = N(g); return { ...g, spotTriggers: upd(g.spotTriggers, id, t => ({ ...t, armed, armedDay: armed ? day : undefined, firedAt: undefined })) }; };

export const addGreekBand = (g: BasketGuards, b: GreekBand): BasketGuards => { g = N(g); return { ...g, greekBands: [...(g.greekBands ?? []), b] }; };
export const removeGreekBand = (g: BasketGuards, id: string): BasketGuards => { g = N(g); return { ...g, greekBands: (g.greekBands ?? []).filter(b => b.id !== id) }; };
export const editGreekBand = (g: BasketGuards, id: string, patch: Partial<GreekBand>): BasketGuards =>
  { g = N(g); return { ...g, greekBands: upd(g.greekBands, id, b => ({ ...b, ...patch, armed: false, firedAt: undefined })) }; };
export const setBandArmed = (g: BasketGuards, id: string, armed: boolean, day?: string): BasketGuards =>
  { g = N(g); return { ...g, greekBands: upd(g.greekBands, id, b => ({ ...b, armed, armedDay: armed ? day : undefined, firedAt: undefined })) }; };

/** Adds an empty max-loss rule (off) when there is none. */
export const addLossRule = (g: BasketGuards): BasketGuards => { g = N(g); return g.alarm ? g : { ...g, alarm: { armed: false } }; };
export const removeLossRule = (g: BasketGuards): BasketGuards => { const out = { ...N(g) }; delete out.alarm; return out; };
export const editAlarm = (g: BasketGuards, patch: Partial<Pick<RiskAlarm, 'maxLoss' | 'exitAtMaxLoss'>>): BasketGuards =>
  { g = N(g); return { ...g, alarm: { ...(g.alarm ?? { armed: false }), ...patch, armed: false, firedAt: undefined } }; };
export const setAlarmArmed = (g: BasketGuards, armed: boolean, day?: string): BasketGuards =>
  { g = N(g); return { ...g, alarm: { ...(g.alarm ?? { armed: false }), armed, armedDay: armed ? day : undefined, firedAt: undefined } }; };

/** Adds an empty margin-use rule (off) when there is none. */
export const addMarginRule = (g: BasketGuards): BasketGuards => { g = N(g); return g.marginAlarm ? g : { ...g, marginAlarm: { armed: false } }; };
export const removeMarginRule = (g: BasketGuards): BasketGuards => { const out = { ...N(g) }; delete out.marginAlarm; return out; };
export const editMarginRule = (g: BasketGuards, pct: number | undefined): BasketGuards =>
  { g = N(g); return { ...g, marginAlarm: { ...(g.marginAlarm ?? { armed: false }), pct, armed: false, armedDay: undefined } }; };
export const setMarginArmed = (g: BasketGuards, armed: boolean, day?: string): BasketGuards =>
  { g = N(g); return { ...g, marginAlarm: { ...(g.marginAlarm ?? { armed: false }), armed, armedDay: armed ? day : undefined } }; };

// ── Exiting one side ──────────────────────────────────────────────────────────

export interface SideExitDeps<L> {
  /** Sends the exit for one leg. `closed` is the broker ACK, not a fill; `maxAfter` is the broker |netQty| allowed once it fills. */
  exitLeg: (leg: L) => Promise<{ closed: boolean; maxAfter?: number }>;
  /** A leg whose exit is already in flight elsewhere: treated as NOT closed (it is not ours to confirm). */
  isBusy: (leg: L) => boolean;
  /** Reads the broker and says whether every listed short came down to its `maxAfter`. */
  confirmShortsDown: (done: { leg: L; maxAfter: number }[]) => Promise<boolean>;
}

export type SideExitOutcome = 'done' | 'short_not_closed' | 'short_busy' | 'shorts_unconfirmed';

/**
 * Closes the legs of one side: shorts first, then the hedges, same rule as exitBasket (Invariants 9 and 10).
 * A hedge is sold only when every short exit was ACKed AND the broker shows the shorts down. An ACK is not a fill: if
 * the short exit is rejected afterwards, selling the hedge anyway leaves a naked short. With no hedges there is nothing
 * to protect, so no confirmation is needed.
 */
export async function exitSide<L extends { side: 'B' | 'S' }>(scope: L[], deps: SideExitDeps<L>): Promise<SideExitOutcome> {
  const shorts = scope.filter(l => l.side === 'S');
  const longs = scope.filter(l => l.side === 'B');
  const busy = shorts.map(l => deps.isBusy(l));   // decided once: a leg finishing mid-call must not flip the outcome
  const results = await Promise.all(shorts.map(async (l, i) => {
    if (busy[i]) return { closed: false as boolean, maxAfter: undefined as number | undefined };
    try { return await deps.exitLeg(l); } catch { return { closed: false, maxAfter: undefined }; }
  }));
  // A short another exit is already working on is "in progress", not a failure: say so, keep the hedges, retry later.
  if (results.some((r, i) => !r.closed && !busy[i])) return 'short_not_closed';
  if (busy.some(Boolean)) return 'short_busy';
  if (longs.length === 0) return 'done';
  const toVerify = shorts.flatMap((leg, i) => (results[i].maxAfter != null ? [{ leg, maxAfter: results[i].maxAfter as number }] : []));
  if (toVerify.length && !(await deps.confirmShortsDown(toVerify))) return 'shorts_unconfirmed';
  await Promise.all(longs.filter(l => !deps.isBusy(l)).map(async l => { try { await deps.exitLeg(l); } catch { /* the retry window resends */ } }));
  return 'done';
}

// ── Day roll ──────────────────────────────────────────────────────────────────

/** IST calendar day (YYYY-MM-DD) of a timestamp. */
export function istDayOf(ts: number): string {
  return new Date(ts + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Guards armed on an earlier IST day (or with no stamp, i.e. armed before stamping existed) are disarmed: a level or limit
 * chosen for yesterday's market must not act on a position opened or carried into today. Re-arm each day on purpose.
 * Returns null when nothing is stale.
 */
export function expireStaleGuards(g: BasketGuards | undefined, today: string): BasketGuards | null {
  if (!g) return null;
  g = normalizeGuards(g);
  const stale = (x: { armed: boolean; armedDay?: string }) => x.armed && x.armedDay !== today;
  const any = (g.spotTriggers ?? []).some(stale) || (g.greekBands ?? []).some(stale) || (g.alarm != null && stale(g.alarm))
    || (g.marginAlarm != null && stale(g.marginAlarm));
  if (!any) return null;
  const off = <T extends { armed: boolean; armedDay?: string; firedAt?: string }>(x: T): T => (stale(x) ? { ...x, armed: false, armedDay: undefined, firedAt: undefined } : x);
  return {
    ...g,
    ...(g.marginAlarm ? { marginAlarm: stale(g.marginAlarm) ? { ...g.marginAlarm, armed: false, armedDay: undefined } : g.marginAlarm } : {}),
    ...(g.spotTriggers ? { spotTriggers: g.spotTriggers.map(off) } : {}),
    ...(g.greekBands ? { greekBands: g.greekBands.map(off) } : {}),
    ...(g.alarm ? { alarm: off(g.alarm) } : {}),
  };
}
