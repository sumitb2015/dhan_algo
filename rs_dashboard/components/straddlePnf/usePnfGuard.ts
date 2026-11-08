'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { carryRuntime, cleanGuard, evalGuard, type LadderGuard } from '@/lib/priceLadderGuard';
import { effectiveGuard, noteBoxes, type BoxValue } from '@/lib/pnfGuardBoxes';
import type { LadderPosition } from '@/lib/pnfLadderPosition';
import { rupeeLevels } from '@/lib/pnfIndexGuard';

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

export interface GuardChart {
  chart: 1 | 2; targetKey: string;
  /** A Renko INDEX chart (it trades CE / PE options): rupee levels only - a chart box is an index move, not the option's P&L - and levels saved apart from the chart's contract levels. */
  rupeesOnly?: boolean;
  /** This chart's position source has been read (default: `positionsLoaded`). An index chart's comes from the AUTO and held-option ledgers. */
  loaded?: boolean;
}
/** `base` is the chart's P&L when the guard was switched on, or null when it was flat then: captured when a position first appears. */
type Slot = { guard: LadderGuard; base: number | null };

/** An index chart's levels are stored apart (`…ix1`): its rupee levels must not replace the box levels the chart uses on a contract. */
const slotName = (chart: number, rupeesOnly: boolean) => `${rupeesOnly ? 'ix' : ''}${chart}`;
const readLevels = (key: string, chart: number, rupeesOnly = false): LadderGuard => {
  try {
    const raw = localStorage.getItem(`${key}${slotName(chart, rupeesOnly)}`);
    // Nothing ever saved for this chart: the defaults (what AUTO switches the guard on with). Saved levels - even a cleared field - win.
    // An index chart has no default: its levels are rupees, which only the user can size.
    if (raw === null) return rupeesOnly ? { on: false } : { on: false, targetBoxes: DEFAULT_GUARD_BOXES, stopBoxes: DEFAULT_GUARD_BOXES };
    const j = JSON.parse(raw) as Record<string, unknown>;
    const g: LadderGuard = { on: false };
    for (const f of FIELDS) { const n = Number(j[f]); if (Number.isFinite(n) && (n > 0 || (f === 'lockKeep' && n === 0))) g[f] = n; }
    return rupeesOnly ? rupeeLevels(g) : g;
  } catch { return { on: false }; }
};
const saveLevels = (key: string, chart: number, g: LadderGuard, rupeesOnly = false) => {
  try { localStorage.setItem(`${key}${slotName(chart, rupeesOnly)}`, JSON.stringify(Object.fromEntries(FIELDS.filter(f => g[f] != null).map(f => [f, g[f]])))); } catch { /* ignore */ }
};

export function usePnfGuard({ charts, positions, positionsLoaded, scope, leaderRef, exitChart, onEvent, rupeesPerBox, tradeKey, syncServer, storeKey = KEY }: {
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
  /** A box's rupee value on the chart's open position (per side on a Renko Log % chart), or null while unknown. */
  rupeesPerBox: (chart: 1 | 2) => BoxValue | null;
  /** The id of the AUTO trade open on this chart (null when none): a new id is a new trade, so the guard starts it from its own baseline. */
  tradeKey: (chart: 1 | 2) => string | null;
  /** Tells the dashboard server about this chart's guard (null: switched off) so it can enforce it on open REAL AUTO positions with the tab closed. */
  syncServer: (chart: 1 | 2, guard: LadderGuard | null) => void;
  /** localStorage prefix of the remembered levels (the Renko page keeps its own). */
  storeKey?: string;
}) {
  const [slots, setSlots] = useState<Record<number, Slot>>({});
  const slotsRef = useRef(slots);
  useEffect(() => { slotsRef.current = slots; });
  const scopeRef = useRef(scope);
  /** When this page last changed a chart's guard (switched it, edited it, a trip settled it off): a server poll older than that is not pulled. */
  const localAt = useRef<Record<number, number>>({});
  const onEventRef = useRef(onEvent);
  const chartsRef = useRef(charts);
  useEffect(() => { chartsRef.current = charts; });
  const rupeesOnlyOf = (chart: number) => !!chartsRef.current.find(c => c.chart === chart)?.rupeesOnly;
  const syncServerRef = useRef(syncServer);
  const tradeKeyRef = useRef(tradeKey);
  useEffect(() => { syncServerRef.current = syncServer; tradeKeyRef.current = tradeKey; });
  useEffect(() => { onEventRef.current = onEvent; });
  // Another broker or mode: nothing carries over (the levels stay, the switch goes off).
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    const lost = Object.entries(slotsRef.current).filter(([, sl]) => sl.guard.on && sl.guard.tripped).map(([c]) => Number(c) as 1 | 2);
    for (const c of lost) onEventRef.current(c, 'warn', `MTM guard on chart ${c} was still exiting a position when the broker or mode changed: it stopped. Check Positions.`);
    setSlots({});
    // The server copy goes with the page's guard - EXCEPT for a chart that still holds an AUTO position: that REAL position keeps its
    // server stop (the page's guard is off now, but a position must never be left without its stop by a mode or broker switch).
    for (const c of [1, 2] as const) {
      if (slotsRef.current[c]?.guard.on && tradeKeyRef.current(c) === null) syncServerRef.current(c, null);
    }
  }, [scope]);
  // A chart switched between an index (option P&L, rupee levels) and a contract (box levels): the guard it had was set for the other
  // kind of position, so it switches off (said once). Its levels stay saved for when the chart is that kind again.
  const kindSig = charts.map(c => `${c.chart}:${c.rupeesOnly ? 'ix' : 'c'}`).join('|');
  const lastKind = useRef<Record<number, boolean>>({});
  useEffect(() => {
    for (const c of chartsRef.current) {
      const ix = !!c.rupeesOnly, was = lastKind.current[c.chart];
      lastKind.current[c.chart] = ix;
      if (was === undefined || was === ix) continue;
      const sl = slotsRef.current[c.chart];
      if (!sl?.guard.on || sl.guard.tripped) continue;                  // off already, or an exit in progress that finishes first
      localAt.current[c.chart] = Date.now();
      setSlots(s => ({ ...s, [c.chart]: { guard: { ...readLevels(storeKey, c.chart, ix), on: false }, base: null } }));
      if (tradeKeyRef.current(c.chart) === null) syncServerRef.current(c.chart, null);
      onEventRef.current(c.chart, 'warn', `MTM guard on chart ${c.chart} switched off: the chart changed between an index and a contract. Set it again for this chart.`);
    }
  }, [kindSig, storeKey]);

  const ixSig = charts.filter(c => c.rupeesOnly).map(c => c.chart).join(',');
  const levelsOf = useCallback((chart: number): LadderGuard => {
    const ix = ixSig.split(',').includes(String(chart));
    const g = slots[chart]?.guard ?? readLevels(storeKey, chart, ix);
    return ix ? rupeeLevels(g) : g;
  }, [slots, storeKey, ixSig]);
  const mtmOf = (chart: GuardChart): number | null => {
    const s = slots[chart.chart];
    const pos = positions[chart.targetKey];
    return s?.guard.on && pos && pos.pnl !== null && s.base !== null ? pos.pnl - s.base : null;
  };

  /** The card's `post`: validates like the ladder's route does, then stores the guard (fresh runtime when switched on again). */
  const post = (chart: GuardChart) => async (body: Record<string, unknown>): Promise<boolean> => {
    const on = body.on === true;
    const old = slots[chart.chart]?.guard;
    localAt.current[chart.chart] = Date.now();
    const ix = !!chart.rupeesOnly;
    if (!on) {
      const g = old ?? readLevels(storeKey, chart.chart, ix);
      setSlots(s => ({ ...s, [chart.chart]: { guard: { ...g, on: false, tripped: undefined, peak: undefined, floor: undefined }, base: null } }));
      syncServer(chart.chart, null);
      return true;
    }
    // an index chart takes no box levels (the card does not offer them; anything else sending them is ignored, never read as index boxes)
    const cleaned = cleanGuard(ix ? { ...body, targetBoxes: undefined, stopBoxes: undefined } : body);
    if (typeof cleaned === 'string') { toast.error(cleaned); return false; }
    const pos = positions[chart.targetKey];
    if (pos && pos.pnl === null) { toast.error('No live price for this position yet - the guard cannot read its P&L'); return false; }
    const next = carryRuntime(cleaned, old);
    saveLevels(storeKey, chart.chart, next, ix);
    syncServer(chart.chart, next);
    setSlots(s => ({ ...s, [chart.chart]: { guard: next, base: old?.on ? s[chart.chart]?.base ?? null : pos ? pos.entryPnl ?? pos.pnl : null } }));
    return true;
  };

  const exitedAt = useRef<Record<number, number>>({});
  /** The `firedAt` of the last trip each chart settled, so a slow or repeated exit result settles a trip once and never touches the next trade. */
  const settledTrip = useRef<Record<number, number>>({});
  const flatSince = useRef<Record<number, number | null>>({});
  /** Per chart: the AUTO trade id last seen, the last known box value (rupees) and whether the unreadable-box warning was given this trade. */
  const lastTrade = useRef<Record<number, string | null>>({});
  const lastRpb = useRef<Record<number, BoxValue | 0>>({});
  const warnedBox = useRef<Record<number, boolean>>({});
  /**
   * A trip is over (`at` = its fire time; a result for any other trip is ignored). `keepOn`: the guard has done its job for this trade
   * and STAYS ON until the user switches it off - the tripped state, peak and locked floor are cleared and the baseline dropped, so the
   * NEXT trade is measured from its own start. Not `keepOn` (an exit that left only another page's position): it switches OFF.
   */
  const settle = (chart: number, reason: string, at: number | undefined, keepOn: boolean) => {
    const cur = slotsRef.current[chart]?.guard;
    if (!cur?.tripped || cur.firedAt !== at || settledTrip.current[chart] === at) return;
    settledTrip.current[chart] = at!;
    if (!keepOn) { localAt.current[chart] = Date.now(); syncServerRef.current(chart as 1 | 2, null); }
    setSlots(s => {
      const g = s[chart]?.guard;
      if (!g || g.firedAt !== at) return s;
      return { ...s, [chart]: { guard: { ...g, on: keepOn, tripped: undefined, peak: undefined, floor: undefined, firedAt: undefined, firedReason: reason }, base: null } };
    });
    onEventRef.current(chart as 1 | 2, 'info', keepOn
      ? `MTM guard fired (${reason}) and is still ON: it measures the next trade from its own start. Switch it off to stop guarding.`
      : `MTM guard fired (${reason}); what is left on the contract belongs to another AUTO position (the other chart's or the other page's), so the guard switched off.`);
  };
  const exitThen = (chart: number, reason: string, at: number | undefined) => {
    // 'placed' is not 'done': the exit can still be rejected or part-filled, and re-baselining on what is left would forgive the loss
    // already taken. The trip settles when the book reads flat (below); only a position that is not this chart's switches the guard off.
    void exitChart(chart as 1 | 2, reason).then(done => { if (done === 'kept') settle(chart, reason, at, false); }).catch(() => { /* retried */ });
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
        const loaded = c.loaded ?? positionsLoaded;
        const g = slot.guard;
        if (g.tripped) {
          // Still holding: keep exiting (retried, never faster than every few seconds). Flat and read: the guard has done its job.
          if (pos) {
            if (nowS - (exitedAt.current[c.chart] ?? 0) > RETRY_EXIT_S) { exitedAt.current[c.chart] = nowS; exitThen(c.chart, g.tripped, g.firedAt); }
          } else if (loaded && nowS - (g.firedAt ?? nowS) >= (scope.endsWith(':REAL') ? RETRY_EXIT_S : 1)) settle(c.chart, g.tripped, g.firedAt, true);
          continue;
        }
        // A new AUTO trade (the trend rule exits and re-enters within a tick, so the book is never seen flat in between): it is measured
        // from its own start, with its own best-so-far and locked floor.
        const tk = tradeKey(c.chart);
        if (!(c.chart in lastTrade.current)) lastTrade.current[c.chart] = tk;
        else if (lastTrade.current[c.chart] !== tk) {
          lastTrade.current[c.chart] = tk;
          lastRpb.current[c.chart] = 0; warnedBox.current[c.chart] = false;
          if (slot.base !== null || g.peak !== undefined || g.floor !== undefined) {
            setSlots(s => ({ ...s, [c.chart]: { guard: { ...g, peak: undefined, floor: undefined }, base: null } }));
            continue;
          }
        }
        // Flat (the book read): the last trade is over, whoever closed it. Its baseline, peak and locked floor are dropped so the next
        // trade is measured from its own start; the guard itself stays ON. A REAL book must read flat for a while first (a poll can miss a
        // position for a moment, and forgetting its loss then would delay the stop); PAPER is local and exact.
        if (pos) flatSince.current[c.chart] = null;
        else if (loaded) {
          const since = (flatSince.current[c.chart] ??= nowS);
          const wait = scope.endsWith(':REAL') ? FLAT_RESET_S_REAL : 0;
          if (nowS - since >= wait && (slot.base !== null || g.peak !== undefined || g.floor !== undefined)) {
            setSlots(s => ({ ...s, [c.chart]: { guard: { ...g, peak: undefined, floor: undefined }, base: null } }));
            continue;
          }
        }
        // No baseline yet: the first priced position sets it (earlier realised P&L must not count).
        if (slot.base === null) {
          if (pos && pos.pnl !== null) { const b0 = pos.entryPnl ?? pos.pnl; setSlots(s => ({ ...s, [c.chart]: { ...slot, base: b0 } })); }
          continue;
        }
        const mtm = pos && pos.pnl !== null ? pos.pnl - slot.base : null;
        // Box levels become rupee levels at the position's current box value; the first level reached (rupees or boxes) exits.
        // The box value is remembered from this trade's earlier ticks: a momentary gap (box still loading, lots read as 0) must not turn a
        // box-only stop into no stop at all. Never known while a position is open: say so, once per trade.
        const now = rupeesPerBox(c.chart);
        if (now !== null && (typeof now !== 'number' || now > 0)) lastRpb.current[c.chart] = now;
        const last = lastRpb.current[c.chart];
        const rpb = now ?? (last && (typeof last !== 'number' || last > 0) ? last : null);
        if (rpb === null && pos && (g.targetBoxes !== undefined || g.stopBoxes !== undefined) && !warnedBox.current[c.chart]) {
          warnedBox.current[c.chart] = true;
          onEventRef.current(c.chart, 'warn', 'MTM guard cannot read the box value of this position yet: its box target / stop are NOT enforced until it can. Use a rupee level if this persists.');
        }
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
   * The server holds this chart's guard (from before a reload, another tab, or this page in another mode): switch it on here with the
   * server's levels, or take its levels when the card is already on (its runtime - peak, floor, a trip in progress, the baseline - is kept).
   */
  const adopt = (chart: 1 | 2, serverLevels: LadderGuard) => {
    const ix = rupeesOnlyOf(chart);
    const levels = ix ? rupeeLevels(serverLevels) : serverLevels;
    setSlots(s => {
      const cur = s[chart];
      const clean = Object.fromEntries(FIELDS.filter(f => levels[f] != null).map(f => [f, levels[f]])) as Partial<LadderGuard>;
      if (cur?.guard.on) {
        const kept = Object.fromEntries(Object.entries(cur.guard).filter(([k]) => !(FIELDS as readonly string[]).includes(k)));
        return { ...s, [chart]: { guard: { ...kept, ...clean, on: true } as LadderGuard, base: cur.base } };
      }
      return { ...s, [chart]: { guard: { ...clean, on: true }, base: null } };
    });
    saveLevels(storeKey, chart, levels, ix);
  };
  /** The server copy this page had seen was removed elsewhere (another tab switched it off): switch the card off here too, without a sync. */
  const release = (chart: 1 | 2) => {
    setSlots(s => {
      const cur = s[chart];
      if (!cur?.guard.on) return s;
      if (cur.guard.tripped) return s;                     // an exit in progress finishes first; its settle switches it off
      return { ...s, [chart]: { guard: { ...cur.guard, on: false, peak: undefined, floor: undefined }, base: null } };
    });
  };
  const localChangedAt = (chart: 1 | 2) => localAt.current[chart] ?? 0;

  return { guardOf: levelsOf, mtmOf, post, adopt, release, localChangedAt };
}
