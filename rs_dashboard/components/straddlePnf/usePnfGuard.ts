'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { carryRuntime, cleanGuard, evalGuard, type LadderGuard } from '@/lib/priceLadderGuard';
import { effectiveGuard, noteBoxes } from '@/lib/pnfGuardBoxes';
import type { LadderPosition } from '@/lib/pnfLadderPosition';

// The MTM guard of a P&F chart (same rules and card as the Price Ladder: target, stop-loss, trailing, Protect profit), held by
// this page: it reads the chart's own P&L (paper ledger or broker book) and, when a rule trips, the leader tab exits that chart.
// It runs only while the page is open (nothing here runs on the server). Levels are remembered; the guard starts OFF every load.
// The P&L it watches is measured from the moment the guard was switched on, so earlier realised P&L never trips it.

const FIELDS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep', 'targetBoxes', 'stopBoxes'] as const;
const KEY = 'straddle-pnf-guard-';
const TICK_MS = 1_000;
/** Target and stop-loss (in chart BOXES) a chart's guard starts with when the user has never saved levels for it. */
export const DEFAULT_GUARD_BOXES = 10;
const RETRY_EXIT_S = 6;
/** How long a chart must read flat before the guard drops its baseline: a REAL book read can briefly miss a position (polled every 5 s). PAPER is local and exact. */
const FLAT_RESET_S_REAL = 12;

export interface GuardChart { chart: 1 | 2; targetKey: string }
/** `base` is the chart's P&L when the guard was switched on, or null when it was flat then: captured when a position first appears. */
type Slot = { guard: LadderGuard; base: number | null };

const readLevels = (key: string, chart: number): LadderGuard => {
  try {
    const raw = localStorage.getItem(`${key}${chart}`);
    // Nothing ever saved for this chart: the defaults (what AUTO switches the guard on with). Saved levels - even a cleared field - win.
    if (raw === null) return { on: false, targetBoxes: DEFAULT_GUARD_BOXES, stopBoxes: DEFAULT_GUARD_BOXES };
    const j = JSON.parse(raw) as Record<string, unknown>;
    const g: LadderGuard = { on: false };
    for (const f of FIELDS) { const n = Number(j[f]); if (Number.isFinite(n) && (n > 0 || (f === 'lockKeep' && n === 0))) g[f] = n; }
    return g;
  } catch { return { on: false }; }
};
const saveLevels = (key: string, chart: number, g: LadderGuard) => {
  try { localStorage.setItem(`${key}${chart}`, JSON.stringify(Object.fromEntries(FIELDS.filter(f => g[f] != null).map(f => [f, g[f]])))); } catch { /* ignore */ }
};

export function usePnfGuard({ charts, positions, positionsLoaded, scope, leaderRef, exitChart, onEvent, rupeesPerBox, storeKey = KEY }: {
  charts: GuardChart[];
  positions: Record<string, LadderPosition | null>;
  positionsLoaded: boolean;
  /** broker + mode: a guard belongs to one account and mode, so changing either switches every guard off. */
  scope: string;
  leaderRef: React.RefObject<boolean>;
  /**
   * Cancel the chart's resting orders and bracket exits, then square its position off. True = nothing of this chart's is left to
   * exit, so the guard stops retrying. 'kept' = what remains on the contract is the other page's AUTO position: the guard has no
   * position of its own to watch any more and switches off (it must never baseline on, or exit, a position it does not own).
   */
  exitChart: (chart: 1 | 2, reason: string) => Promise<boolean | 'kept'>;
  onEvent: (chart: 1 | 2, kind: 'warn' | 'info', text: string) => void;
  /** What one chart box is worth in rupees on that chart's open position (null when unknown): turns the box target / stop into rupees. */
  rupeesPerBox: (chart: 1 | 2) => number | null;
  /** localStorage prefix of the remembered levels (the Renko page keeps its own). */
  storeKey?: string;
}) {
  const [slots, setSlots] = useState<Record<number, Slot>>({});
  const slotsRef = useRef(slots);
  useEffect(() => { slotsRef.current = slots; });
  const scopeRef = useRef(scope);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; });
  // Another broker or mode: nothing carries over (the levels stay, the switch goes off).
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    const lost = Object.entries(slotsRef.current).filter(([, sl]) => sl.guard.on && sl.guard.tripped).map(([c]) => Number(c) as 1 | 2);
    for (const c of lost) onEventRef.current(c, 'warn', `MTM guard on chart ${c} was still exiting a position when the broker or mode changed: it stopped. Check Positions.`);
    setSlots({});
  }, [scope]);

  const levelsOf = useCallback((chart: number): LadderGuard => slots[chart]?.guard ?? readLevels(storeKey, chart), [slots, storeKey]);
  const mtmOf = (chart: GuardChart): number | null => {
    const s = slots[chart.chart];
    const pos = positions[chart.targetKey];
    return s?.guard.on && pos && pos.pnl !== null && s.base !== null ? pos.pnl - s.base : null;
  };

  /** The card's `post`: validates like the ladder's route does, then stores the guard (fresh runtime when switched on again). */
  const post = (chart: GuardChart) => async (body: Record<string, unknown>): Promise<boolean> => {
    const on = body.on === true;
    const old = slots[chart.chart]?.guard;
    if (!on) {
      const g = old ?? readLevels(storeKey, chart.chart);
      setSlots(s => ({ ...s, [chart.chart]: { guard: { ...g, on: false, tripped: undefined, peak: undefined, floor: undefined }, base: null } }));
      return true;
    }
    const cleaned = cleanGuard(body);
    if (typeof cleaned === 'string') { toast.error(cleaned); return false; }
    const pos = positions[chart.targetKey];
    if (pos && pos.pnl === null) { toast.error('No live price for this position yet - the guard cannot read its P&L'); return false; }
    const next = carryRuntime(cleaned, old);
    saveLevels(storeKey, chart.chart, next);
    setSlots(s => ({ ...s, [chart.chart]: { guard: next, base: old?.on ? s[chart.chart]?.base ?? null : pos?.pnl ?? null } }));
    return true;
  };

  const exitedAt = useRef<Record<number, number>>({});
  /** The `firedAt` of the last trip each chart settled, so a slow or repeated exit result settles a trip once and never touches the next trade. */
  const settledTrip = useRef<Record<number, number>>({});
  const flatSince = useRef<Record<number, number | null>>({});
  /**
   * A trip is over (`at` = its fire time; a result for any other trip is ignored). `keepOn`: the guard has done its job for this trade
   * and STAYS ON until the user switches it off - the tripped state, peak and locked floor are cleared and the baseline dropped, so the
   * NEXT trade is measured from its own start. Not `keepOn` (an exit that left only another page's position): it switches OFF.
   */
  const settle = (chart: number, reason: string, at: number | undefined, keepOn: boolean) => {
    const cur = slotsRef.current[chart]?.guard;
    if (!cur?.tripped || cur.firedAt !== at || settledTrip.current[chart] === at) return;
    settledTrip.current[chart] = at!;
    setSlots(s => {
      const g = s[chart]?.guard;
      if (!g || g.firedAt !== at) return s;
      return { ...s, [chart]: { guard: { ...g, on: keepOn, tripped: undefined, peak: undefined, floor: undefined, firedAt: undefined, firedReason: reason }, base: null } };
    });
    onEventRef.current(chart as 1 | 2, 'info', keepOn
      ? `MTM guard fired (${reason}) and is still ON: it measures the next trade from its own start. Switch it off to stop guarding.`
      : `MTM guard fired (${reason}); what is left on the contract belongs to another page's AUTO, so the guard switched off.`);
  };
  const exitThen = (chart: number, reason: string, at: number | undefined) => {
    void exitChart(chart as 1 | 2, reason).then(done => { if (done === 'kept') settle(chart, reason, at, false); else if (done) settle(chart, reason, at, true); });
  };
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    tickRef.current = () => {
      if (!leaderRef.current) return;
      const nowS = Date.now() / 1000;
      for (const c of charts) {
        const slot = slotsRef.current[c.chart];
        if (!slot?.guard.on) continue;
        const pos = positions[c.targetKey];
        const g = slot.guard;
        if (g.tripped) {
          // Still holding: keep exiting (retried, never faster than every few seconds). Flat and read: the guard has done its job.
          if (pos) {
            if (nowS - (exitedAt.current[c.chart] ?? 0) > RETRY_EXIT_S) { exitedAt.current[c.chart] = nowS; exitThen(c.chart, g.tripped, g.firedAt); }
          } else if (positionsLoaded && nowS - (g.firedAt ?? nowS) > RETRY_EXIT_S) settle(c.chart, g.tripped, g.firedAt, true);
          continue;
        }
        // Flat (the book read): the last trade is over, whoever closed it. Its baseline, peak and locked floor are dropped so the next
        // trade is measured from its own start; the guard itself stays ON. A REAL book must read flat for a while first (a poll can miss a
        // position for a moment, and forgetting its loss then would delay the stop); PAPER is local and exact.
        if (pos) flatSince.current[c.chart] = null;
        else if (positionsLoaded) {
          const since = (flatSince.current[c.chart] ??= nowS);
          const wait = scope.endsWith(':REAL') ? FLAT_RESET_S_REAL : 0;
          if (nowS - since >= wait && (slot.base !== null || g.peak !== undefined || g.floor !== undefined)) {
            setSlots(s => ({ ...s, [c.chart]: { guard: { ...g, peak: undefined, floor: undefined }, base: null } }));
            continue;
          }
        }
        // No baseline yet: the first priced position sets it (earlier realised P&L must not count).
        if (slot.base === null) {
          if (pos && pos.pnl !== null) { const b0 = pos.pnl; setSlots(s => ({ ...s, [c.chart]: { ...slot, base: b0 } })); }
          continue;
        }
        const mtm = pos && pos.pnl !== null ? pos.pnl - slot.base : null;
        // Box levels become rupee levels at the position's current box value; the first level reached (rupees or boxes) exits.
        const rpb = rupeesPerBox(c.chart);
        const eff = effectiveGuard(g, rpb);
        const er = evalGuard(eff, mtm);
        // the runtime (peak / floor) is kept, the levels stay the user's own (not the folded ones)
        const r = { guard: er.guard === eff ? g : { ...er.guard, target: g.target, stop: g.stop }, reason: er.reason ? noteBoxes(g, rpb, er.reason) : null };
        if (r.reason) {
          exitedAt.current[c.chart] = nowS;
          const trippedSlot = { guard: { ...r.guard, tripped: r.reason!, firedAt: nowS }, base: slot.base };
          slotsRef.current = { ...slotsRef.current, [c.chart]: trippedSlot };      // settle() reads this: a PAPER exit can answer before the next render
          setSlots(s => ({ ...s, [c.chart]: trippedSlot }));
          onEvent(c.chart, 'warn', `MTM guard: ${r.reason} - exiting chart ${c.chart}`);
          exitThen(c.chart, r.reason, nowS);
        } else if (r.guard !== g) {
          setSlots(s => ({ ...s, [c.chart]: { guard: r.guard, base: slot.base } }));
        }
      }
    };
  });
  useEffect(() => {
    const id = setInterval(() => tickRef.current(), TICK_MS);
    return () => clearInterval(id);
  }, []);

  /**
   * AUTO was switched on for this chart: switch its guard on too, with the remembered levels (the 10 / 10 box defaults when none were
   * ever saved, or when every rule was cleared). A guard already on is left alone.
   */
  const armDefault = async (chart: GuardChart): Promise<void> => {
    const cur = levelsOf(chart.chart);
    if (cur.on) return;
    const none = cur.target == null && cur.stop == null && cur.targetBoxes == null && cur.stopBoxes == null && cur.trailBy == null && cur.lockAt == null;
    const body = { ...cur, on: true, ...(none ? { targetBoxes: DEFAULT_GUARD_BOXES, stopBoxes: DEFAULT_GUARD_BOXES } : {}) };
    if (await post(chart)(body)) {
      onEventRef.current(chart.chart, 'info', `MTM guard switched on with AUTO: target ${body.targetBoxes != null ? `${body.targetBoxes} boxes` : body.target != null ? `₹${body.target}` : '-'}, stop ${body.stopBoxes != null ? `${body.stopBoxes} boxes` : body.stop != null ? `₹${body.stop}` : '-'}. It stays on until you switch it off.`);
    } else {
      // post() already said why (no live price for an open position, an invalid level): AUTO is armed, its guard is not.
      onEventRef.current(chart.chart, 'warn', `AUTO is armed on chart ${chart.chart} WITHOUT its MTM guard - open the MTM Guard card and switch it on.`);
    }
  };

  return { guardOf: levelsOf, mtmOf, post, armDefault };
}
