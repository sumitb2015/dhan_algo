'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { istDateIso } from '@/lib/nseHolidays';
import { paperStep, planResting, reached, DEFAULT_BUFFER_PCT, type RestingSide } from '@/lib/pnfResting';
import { EMPTY_RESTING, isOpenOrder, needsResolve, type RestingLedger, type RestingOp, type RestingRow } from '@/lib/pnfRestingLedger';
import { toOrderRow } from '@/lib/pnfBooks';
import type { Target } from '@/lib/pnfTarget';

// Resting LIMIT / SL-limit orders placed from the P&F charts' B / S rails (rules: lib/pnfResting.ts; ledger:
// lib/pnfRestingLedger.ts). A REAL single-leg order rests at the broker: reserved in the ledger, sent, then followed in the
// broker's order book every 3 s. A PAPER order, and a REAL level on a straddle chart, is held by the page: the leader tab
// fills it (paper) or sends both legs at MARKET (REAL) once the live price reaches it. An unknown outcome is never resent.

const TICK_MS = 1_000;
const LEDGER_POLL_MS = 3_000;
const BOOK_POLL_MS = 3_000;

/** One chart as the rail needs it, refreshed every render. */
export interface RailChart {
  chart: 1 | 2;
  target: Target;
  targetKey: string;
  /** The chart's live price (a straddle's CE + PE). */
  price: number | null;
  /** The feed has stopped ticking (or the market is shut): a held level never fills or fires on that price. */
  stale: boolean;
  /** Per-leg live prices (CE, PE for a straddle; one price otherwise), for a paper fill. */
  legPrices: (number | null)[];
  straddle: boolean;
  tick: number;
  /** Rupees per point per lot, per leg. */
  unitsPerLot: number[];
}

export type RestingEvent = { id?: string; estimate?: boolean; kind: 'fill' | 'warn' | 'info'; text: string; chart: 1 | 2; side?: RestingSide; price?: number; target?: Target; mode?: 'PAPER' | 'REAL'; lots?: number };

type Reply = { success?: boolean; error?: string; outcome?: string; orderId?: string; price?: number; trigger?: number; message?: string };

/** A unique order id: the time alone repeats for two clicks in one millisecond (or under a pinned test clock). */
const newOrderId = (chart: 1 | 2) => `pnfr-${chart}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function postOrder(body: Record<string, unknown>): Promise<Reply | null> {
  try {
    const res = await fetch('/api/straddle-pnf/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json() as Reply;
  } catch { return null; }                                    // no clean reply: UNKNOWN, never a failure
}

export function usePnfResting({ charts, broker, mode, lots, product, leaderRef, onEvent, onPaperFill }: {
  charts: RailChart[];
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  lots: number;
  product: 'INTRADAY' | 'MARGIN' | 'CNC';
  leaderRef: React.RefObject<boolean>;
  onEvent: (e: RestingEvent) => void;
  /** A paper order filled: apply it to the paper ledger (per leg, signed lots) at these leg prices. */
  onPaperFill: (row: RestingRow, legPrices: number[]) => void;
}) {
  const [ledger, setLedger] = useState<RestingLedger>(EMPTY_RESTING);
  const accept = useCallback((l: RestingLedger | undefined) => {
    if (l) setLedger(prev => (l.rev > prev.rev || prev.rev === 0 ? l : prev));
  }, []);
  const post = useCallback(async (op: RestingOp): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/straddle-pnf/resting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
      const j = await res.json() as { success?: boolean; error?: string; ledger?: RestingLedger };
      accept(j.ledger);
      return { ok: !!j.success, error: j.error };
    } catch (e) { return { ok: false, error: (e as Error).message || 'Ledger unreachable' }; }
  }, [accept]);
  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const j = await (await fetch('/api/straddle-pnf/resting')).json() as { ledger?: RestingLedger };
        if (!dead) accept(j.ledger);
      } catch { /* the next poll retries */ }
    };
    void read();
    const id = setInterval(read, LEDGER_POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [accept]);

  const realAskedRef = useRef(false);
  const busyRef = useRef(new Set<string>());

  const place = async (c: RailChart, side: RestingSide, level: number) => {
    if (c.target.kind === 'index') return;
    if (c.price === null) { toast.error('No live price yet - nothing was placed'); return; }
    const spec = planResting({ side, level, ref: c.price, tick: c.tick, bufferPct: DEFAULT_BUFFER_PCT });
    if ('error' in spec) { toast.error(spec.error); return; }
    const what = `${side} ${spec.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${lots}L ${spec.trigger !== undefined ? `${spec.trigger} → ` : ''}${spec.price}`;
    if (mode === 'REAL' && !realAskedRef.current) {
      if (!window.confirm(`Place a REAL ${what} on ${c.target.symbol}?\n\n${c.straddle ? 'A straddle level is held by this page and sent at MARKET (both legs) when the price reaches it - keep the page open.' : 'It rests at the broker.'}\nThis question is asked once per page load.`)) return;
      realAskedRef.current = true;
    }
    const venue = mode === 'REAL' && !c.straddle ? 'broker' : 'page';
    const id = newOrderId(c.chart);
    const row = {
      id, day: istDateIso(Date.now()), chart: c.chart, target: c.target, broker, mode, venue, side, kind: spec.kind, level: spec.level,
      price: spec.price, ...(spec.trigger !== undefined ? { trigger: spec.trigger } : {}), lots, product,
      unitsPerPoint: (c.unitsPerLot[0] ?? 1) * lots, legUnits: c.unitsPerLot.map(u => u * lots), t: Date.now() / 1000,
    } as const;
    const created = await post({ op: 'create', row });
    if (!created.ok) { toast.error(`Not placed: ${created.error}`); return; }
    if (venue === 'page') { onEvent({ kind: 'info', chart: c.chart, text: `${mode === 'PAPER' ? '[PAPER] ' : '[REAL level] '}${what} resting on C${c.chart}` }); return; }
    // REAL at the broker: reserved above, now sent.
    const j = await postOrder({ broker, mode: 'REAL', target: c.target, action: side, lots, product, orderType: spec.kind === 'limit' ? 'LIMIT' : 'SL', price: spec.price, trigger: spec.trigger });
    if (j?.outcome === 'placed' && j.orderId) {
      await post({ op: 'placed', id, brokerOrderId: j.orderId });
      if (j.price && (j.price !== spec.price || (j.trigger ?? spec.trigger) !== spec.trigger)) {
        await post({ op: 'modify', id, level: spec.level, price: j.price, ...(j.trigger ? { trigger: j.trigger } : {}) });
      }
      onEvent({ kind: 'info', chart: c.chart, text: `[REAL] ${what} placed at the broker` });
    } else if (!j || j.outcome === 'unknown') {
      await post({ op: 'markUnknown', id, note: j?.error ?? j?.message ?? 'no reply' });
      onEvent({ kind: 'warn', chart: c.chart, text: `Order status unknown - check the broker's order book (${what})` });
    } else {
      await post({ op: 'reject', id, note: j.error ?? j.message ?? 'refused' });
      onEvent({ kind: 'warn', chart: c.chart, text: `Order refused: ${j.error ?? j.message ?? ''}` });
    }
  };

  const modify = async (row: RestingRow, level: number) => {
    const c = charts.find(x => x.targetKey === row.targetKey);
    if (!c || c.price === null) { toast.error('No live price for this chart - not moved'); return; }
    const spec = planResting({ side: row.side, level, ref: c.price, tick: c.tick, bufferPct: DEFAULT_BUFFER_PCT });
    if ('error' in spec) { toast.error(spec.error); return; }
    if (spec.kind !== row.kind) { toast.error(`Moving it across the price would turn it into ${spec.kind === 'limit' ? 'a LIMIT' : 'an SL-limit'} - cancel it and place a new one`); return; }
    if (row.venue === 'page') { const r = await post({ op: 'modify', id: row.id, level: spec.level, price: spec.price, trigger: spec.trigger }); if (!r.ok) toast.error(r.error ?? 'Not moved'); return; }
    if (!row.brokerOrderId) { toast.error('The order is still being placed - try again in a moment'); return; }
    const j = await postOrder({
      broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product,
      orderType: row.kind === 'limit' ? 'LIMIT' : 'SL', price: spec.price, trigger: spec.trigger, brokerOp: { op: 'modify', orderId: row.brokerOrderId },
    });
    if (j?.outcome === 'placed') await post({ op: 'modify', id: row.id, level: spec.level, price: j.price ?? spec.price, trigger: j.trigger ?? spec.trigger });
    else onEvent({ kind: 'warn', chart: row.chart, text: !j || j.outcome === 'unknown' ? 'Move status unknown - the order book will show where it is' : `Not moved: ${j.error ?? j.message ?? ''}` });
  };

  const cancel = async (row: RestingRow) => {
    if (row.venue === 'page' || row.state !== 'working') {
      if (row.state !== 'working') {
        if (!needsResolve(row, Date.now() / 1000)) { toast.error(`The order is ${row.state} - wait for it`); return; }
        const where = row.venue === 'broker' ? 'the broker\'s order book' : 'Positions';
        if (!window.confirm(`This order's outcome is unknown (${row.note ?? row.state}). Check ${where} first: whatever it shows is what happened.\n\nRemove it from the chart?`)) return;
        const r = await post({ op: 'resolve', id: row.id, as: 'cancelled', t: Date.now() / 1000 });
        if (!r.ok) toast.error(r.error ?? 'Not removed');
        return;
      }
      const r = await post({ op: 'cancel', id: row.id, t: Date.now() / 1000 });
      if (!r.ok) toast.error(r.error ?? 'Not cancelled');
      return;
    }
    if (!row.brokerOrderId) { toast.error('The order is still being placed - try again in a moment'); return; }
    const j = await postOrder({ broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product, brokerOp: { op: 'cancel', orderId: row.brokerOrderId } });
    if (j?.outcome === 'placed') await post({ op: 'cancel', id: row.id, t: Date.now() / 1000 });
    else onEvent({ kind: 'warn', chart: row.chart, text: !j || j.outcome === 'unknown' ? 'Cancel status unknown - the order book will show it' : `Not cancelled: ${j.error ?? ''}` });
  };

  // E1: the tick is rebuilt every render and called through a ref from one stable interval; leader tab only (E2).
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    tickRef.current = async () => {
      if (!leaderRef.current) return;
      for (const row of ledger.rows) {
        if (row.venue !== 'page' || row.state !== 'working' || busyRef.current.has(row.id)) continue;
        const c = charts.find(x => x.targetKey === row.targetKey);
        if (!c || c.price === null || c.stale) continue;       // no chart shows it / no fresh price: nothing is faked or fired
        busyRef.current.add(row.id);
        try {
          if (row.mode === 'PAPER') {
            const step = paperStep(row, c.price);
            if (step.fill) {
              const prices = c.straddle ? c.legPrices.map(p => p ?? 0) : [step.price];
              const r = await post({ op: 'fill', id: row.id, price: step.price, t: Date.now() / 1000 });
              if (r.ok) {
                onPaperFill(row, prices);
                onEvent({ id: `rail-${row.id}`, kind: 'fill', chart: row.chart, side: row.side, price: step.price, target: row.target, mode: 'PAPER', lots: row.lots, text: `[PAPER] ${row.side} ${row.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${row.lots}L filled @ ${step.price.toFixed(2)}` });
              }
            } else if (step.triggered && !row.triggered) await post({ op: 'trigger', id: row.id });
            continue;
          }
          // REAL straddle level: reserve, then both legs at MARKET.
          const at = row.kind === 'stop' ? row.trigger ?? row.level : row.level;
          if (!reached(row.side, row.kind, at, c.price)) continue;
          const fired = await post({ op: 'fire', id: row.id, t: Date.now() / 1000 });
          if (!fired.ok) continue;
          const j = await postOrder({ broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product });
          if (j?.outcome === 'placed') {
            await post({ op: 'fill', id: row.id, price: c.price, t: Date.now() / 1000 });
            // The page only knows the price it fired at, not the traded price: the marker is an estimate until Positions shows the fill.
            onEvent({ id: `rail-${row.id}`, estimate: true, kind: 'fill', chart: row.chart, side: row.side, price: c.price, target: row.target, mode: 'REAL', lots: row.lots, text: `[REAL] level ${row.level.toFixed(2)} reached: ${row.side} ${row.lots}L straddle sent at MARKET` });
          } else if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
            const partial = j?.outcome === 'partial';
            await post({ op: 'markUnknown', id: row.id, note: `${partial ? 'PARTIAL - one leg is open alone: ' : ''}${j?.message ?? 'no reply'}` });
            onEvent({ kind: 'warn', chart: row.chart, text: `${partial ? 'PARTIAL: a leg of the level order is open alone - close it from Positions. ' : 'Level order outcome unknown - check Positions. '}${j?.message ?? 'no reply'}` });
          } else {
            await post({ op: 'reject', id: row.id, note: j.message ?? j.error ?? 'refused' });
            onEvent({ kind: 'warn', chart: row.chart, text: `Level order refused: ${j.message ?? j.error ?? ''}` });
          }
        } finally {
          busyRef.current.delete(row.id);
        }
      }
    };
  });
  useEffect(() => {
    const id = setInterval(() => { void tickRef.current(); }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // REAL broker orders: their fills / cancels / rejections come from the broker's own order book.
  const ledgerRef = useRef(ledger);
  useEffect(() => { ledgerRef.current = ledger; });
  const eventRef = useRef(onEvent);
  useEffect(() => { eventRef.current = onEvent; });
  useEffect(() => {
    const sync = async () => {
      if (!leaderRef.current) return;                        // one tab reads the broker's book (E2), the others follow the ledger
      const live = ledgerRef.current.rows.filter(r => r.venue === 'broker' && r.brokerOrderId && (r.state === 'working' || r.state === 'unknown'));
      for (const b of [...new Set(live.map(r => r.broker))]) {
        let book: ReturnType<typeof toOrderRow>[];
        try {
          const j = await (await fetch(scalperRoute(b as Broker, 'orders'))).json() as { success?: boolean; data?: Record<string, unknown>[] };
          if (!j.success || !Array.isArray(j.data)) continue;
          book = j.data.map(toOrderRow);
        } catch { continue; }
        for (const r of live.filter(x => x.broker === b)) {
          const o = book.find(x => x.id === r.brokerOrderId);
          if (!o || o.state === 'open') continue;
          const t = Date.now() / 1000;
          // Every open tab syncs; only the one whose op lands raises the toast / marker.
          if (o.state === 'done') {
            const px = o.avg ?? r.price;
            const ok = await post(r.state === 'unknown' ? { op: 'resolve', id: r.id, as: 'filled', price: px, t } : { op: 'fill', id: r.id, price: px, t });
            if (ok.ok) eventRef.current({ id: `rail-${r.id}`, kind: 'fill', chart: r.chart, side: r.side, price: px, target: r.target, mode: 'REAL', lots: r.lots, text: `[REAL] ${r.side} ${r.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${r.lots}L filled @ ${px.toFixed(2)}` });
          } else if (o.state === 'cancelled' && o.filled && o.filled > 0 && r.state === 'working') {
            // Cancelled after a part fill: the filled lots are a real position, so they are booked as a fill (not dropped).
            const perLot = o.qty && r.lots ? o.qty / r.lots : 0;
            const lots = perLot > 0 ? Math.max(1, Math.min(r.lots, Math.round(o.filled / perLot))) : r.lots;
            const px = o.avg ?? r.price;
            const ok = await post({ op: 'fill', id: r.id, price: px, t, lots });
            if (ok.ok) eventRef.current({ id: `rail-${r.id}`, kind: 'fill', chart: r.chart, side: r.side, price: px, target: r.target, mode: 'REAL', lots, text: `[REAL] ${r.side} ${r.kind === 'limit' ? 'LIMIT' : 'SL-limit'} part-filled ${o.filled} of ${o.qty}, rest cancelled @ ${px.toFixed(2)} - check Positions` });
          } else {
            const ok = await post(r.state === 'unknown' ? { op: 'resolve', id: r.id, as: 'cancelled', t } : o.state === 'rejected' ? { op: 'reject', id: r.id, note: o.reason || 'rejected by the broker' } : { op: 'cancel', id: r.id, t });
            if (!ok.ok) continue;
            const what = `${r.side} ${r.kind === 'limit' ? 'LIMIT' : 'SL-limit'}`;
            if (o.state === 'rejected') eventRef.current({ kind: 'warn', chart: r.chart, text: `Broker rejected the ${what}: ${o.reason || ''}` });
            // A cancelled order can have filled in part: that quantity is in Positions, not on the rail.

          }
        }
      }
    };
    const id = setInterval(() => { void sync(); }, BOOK_POLL_MS);
    return () => clearInterval(id);
  }, [post, leaderRef]);

  const openFor = (targetKeyOf: string) => ledger.rows.filter(r => r.targetKey === targetKeyOf && isOpenOrder(r));
  return { ledger, place, modify, cancel, openFor };
}

/** A chart's contract as the server resolves it (the order route's GET): its tick and rupees per point per lot, per leg. */
export function useChartLegs(broker: Broker, target: Target, targetKeyOf: string, enabled: boolean): { tick: number; unitsPerLot: number[] } | null {
  const [info, setInfo] = useState<{ key: string; tick: number; unitsPerLot: number[] } | null>(null);
  const key = `${broker}|${targetKeyOf}`;
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    void (async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/order?broker=${broker}&target=${encodeURIComponent(JSON.stringify(target))}`)).json() as
          { success?: boolean; legs?: { tick: number | null; lot: number; unitsPerLot: number | null }[] };
        if (dead || !j.success || !j.legs?.length) return;
        setInfo({ key, tick: j.legs[0].tick && j.legs[0].tick > 0 ? j.legs[0].tick : 0.05, unitsPerLot: j.legs.map(l => l.unitsPerLot ?? l.lot) });
      } catch { /* the rail waits for it */ }
    })();
    return () => { dead = true; };
    // target is fully described by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return info && info.key === key ? { tick: info.tick, unitsPerLot: info.unitsPerLot } : null;
}
