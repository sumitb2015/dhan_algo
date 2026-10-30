'use client';

import { useEffect, useRef } from 'react';
import { newSignalsAfter, nextWatermark } from '@/lib/straddlePnfLive';
import { alertId, type Target } from '@/lib/pnfTarget';
import type { PanelModel } from '@/lib/straddlePnfModel';
import type { LogEntry } from './AlertLog';

// One chart's signal alerts: new signals on newly CLOSED bars, once each, keyed on bar time (never column numbers). Each
// chart keeps its own watermark. When `drawKey` changes (history reloaded, another instrument, other box settings) the
// chart re-baselines: the watermark moves to its last closed bar and nothing alerts, so old signals never fire as new.

export function usePnfAlerts({ model, ready, drawKey, chart, target, label, strike, onFresh }: {
  model: Pick<PanelModel, 'signals' | 'lastBarT'>;
  ready: boolean;
  drawKey: string;
  chart: 1 | 2;
  target: Target | null;
  label: string;
  strike: number;
  onFresh: (entries: LogEntry[], chart: 1 | 2) => void;
}) {
  const watermarkRef = useRef(0);
  const seenKeyRef = useRef<string | null>(null);
  const onFreshRef = useRef(onFresh);
  useEffect(() => { onFreshRef.current = onFresh; });

  useEffect(() => {
    if (!ready || !target) return;
    if (seenKeyRef.current !== drawKey) {
      seenKeyRef.current = drawKey;
      watermarkRef.current = model.lastBarT ?? 0;
      return;
    }
    const wm = watermarkRef.current || model.lastBarT || 0;
    const fresh: LogEntry[] = newSignalsAfter(model.signals, wm).map(s => ({
      // Chart 2's ids carry its number: the same signal on two charts of one scrip is two entries.
      id: `${chart === 2 ? 'c2:' : ''}${alertId(target, s.kind, s.t)}`, t: s.t, strike, label, kind: s.kind, price: s.price, belowVwap: s.belowVwap,
    }));
    watermarkRef.current = nextWatermark(wm, model.lastBarT);
    if (fresh.length) onFreshRef.current(fresh, chart);
  }, [model, ready, drawKey, chart, target, label, strike]);
}
