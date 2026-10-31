'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { carryRuntime, cleanGuard, evalGuard, type LadderGuard } from '@/lib/priceLadderGuard';
import type { LadderPosition } from '@/lib/pnfLadderPosition';

// The MTM guard of a P&F chart (same rules and card as the Price Ladder: target, stop-loss, trailing, Protect profit), held by
// this page: it reads the chart's own P&L (paper ledger or broker book) and, when a rule trips, the leader tab exits that chart.
// It runs only while the page is open (nothing here runs on the server). Levels are remembered; the guard starts OFF every load.
// The P&L it watches is measured from the moment the guard was switched on, so earlier realised P&L never trips it.

const FIELDS = ['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep'] as const;
const KEY = 'straddle-pnf-guard-';
const TICK_MS = 1_000;
const RETRY_EXIT_S = 6;

export interface GuardChart { chart: 1 | 2; targetKey: string }
/** `base` is the chart's P&L when the guard was switched on, or null when it was flat then: captured when a position first appears. */
type Slot = { guard: LadderGuard; base: number | null };

const readLevels = (chart: number): LadderGuard => {
  try {
    const raw = localStorage.getItem(`${KEY}${chart}`);
    const j = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const g: LadderGuard = { on: false };
    for (const f of FIELDS) { const n = Number(j[f]); if (Number.isFinite(n) && (n > 0 || (f === 'lockKeep' && n === 0))) g[f] = n; }
    return g;
  } catch { return { on: false }; }
};
const saveLevels = (chart: number, g: LadderGuard) => {
  try { localStorage.setItem(`${KEY}${chart}`, JSON.stringify(Object.fromEntries(FIELDS.filter(f => g[f] != null).map(f => [f, g[f]])))); } catch { /* ignore */ }
};

export function usePnfGuard({ charts, positions, positionsLoaded, scope, leaderRef, exitChart, onEvent }: {
  charts: GuardChart[];
  positions: Record<string, LadderPosition | null>;
  positionsLoaded: boolean;
  /** broker + mode: a guard belongs to one account and mode, so changing either switches every guard off. */
  scope: string;
  leaderRef: React.RefObject<boolean>;
  /** Cancel the chart's resting orders and bracket exits, then square its position off. */
  exitChart: (chart: 1 | 2, reason: string) => Promise<void>;
  onEvent: (chart: 1 | 2, kind: 'warn' | 'info', text: string) => void;
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

  const levelsOf = useCallback((chart: number): LadderGuard => slots[chart]?.guard ?? readLevels(chart), [slots]);
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
      const g = old ?? readLevels(chart.chart);
      setSlots(s => ({ ...s, [chart.chart]: { guard: { ...g, on: false, tripped: undefined, peak: undefined, floor: undefined }, base: null } }));
      return true;
    }
    const cleaned = cleanGuard(body);
    if (typeof cleaned === 'string') { toast.error(cleaned); return false; }
    const pos = positions[chart.targetKey];
    if (pos && pos.pnl === null) { toast.error('No live price for this position yet - the guard cannot read its P&L'); return false; }
    const next = carryRuntime(cleaned, old);
    saveLevels(chart.chart, next);
    setSlots(s => ({ ...s, [chart.chart]: { guard: next, base: old?.on ? s[chart.chart]?.base ?? null : pos?.pnl ?? null } }));
    return true;
  };

  const exitedAt = useRef<Record<number, number>>({});
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
            if (nowS - (exitedAt.current[c.chart] ?? 0) > RETRY_EXIT_S) { exitedAt.current[c.chart] = nowS; void exitChart(c.chart, g.tripped); }
          } else if (positionsLoaded && nowS - (g.firedAt ?? nowS) > RETRY_EXIT_S) {
            setSlots(s => ({ ...s, [c.chart]: { guard: { ...g, on: false, tripped: undefined, firedReason: g.tripped }, base: null } }));
          }
          continue;
        }
        // Flat when switched on: the first priced position sets the baseline (earlier realised P&L must not count).
        if (slot.base === null) {
          if (pos && pos.pnl !== null) { const b0 = pos.pnl; setSlots(s => ({ ...s, [c.chart]: { ...slot, base: b0 } })); }
          continue;
        }
        const mtm = pos && pos.pnl !== null ? pos.pnl - slot.base : null;
        const r = evalGuard(g, mtm);
        if (r.reason) {
          exitedAt.current[c.chart] = nowS;
          setSlots(s => ({ ...s, [c.chart]: { guard: { ...r.guard, tripped: r.reason!, firedAt: nowS }, base: slot.base } }));
          onEvent(c.chart, 'warn', `MTM guard: ${r.reason} - exiting chart ${c.chart}`);
          void exitChart(c.chart, r.reason);
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

  return { guardOf: levelsOf, mtmOf, post };
}
