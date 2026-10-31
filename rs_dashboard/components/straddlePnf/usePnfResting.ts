'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { istDateIso } from '@/lib/nseHolidays';
import { paperStep, planResting, reached, snapToTick, DEFAULT_BUFFER_PCT, type RestingSide } from '@/lib/pnfResting';
import { EMPTY_RESTING, isOpenOrder, needsResolve, type RestingLedger, type RestingOp, type RestingRow } from '@/lib/pnfRestingLedger';
import { lotCap } from '@/lib/pnfOrderLogic';
import { toOrderRow } from '@/lib/pnfBooks';
import { planBracketChildren, trailedStop, type BracketSpec } from '@/lib/pnfBracket';
import type { LadderPosition } from '@/lib/pnfLadderPosition';
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
  /** The broker's position keys and quantity per lot, per leg (empty when this broker cannot trade the chart). */
  keys: string[];
  lotUnits: number[];
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

export function usePnfResting({ charts, broker, mode, lots, product, leaderRef, onEvent, onPaperFill, instant, positions, positionsLoaded }: {
  charts: RailChart[];
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  lots: number;
  product: 'INTRADAY' | 'MARGIN' | 'CNC';
  leaderRef: React.RefObject<boolean>;
  onEvent: (e: RestingEvent) => void;
  /** A paper order filled: apply it to the paper ledger (per leg, signed lots) at these leg prices. */
  onPaperFill: (row: RestingRow, legPrices: number[]) => void;
  /** Per chart: skip the REAL confirm on moving / cancelling a broker order (Kite's "Instant order placement"). */
  instant: Record<number, boolean>;
  /** Each chart's open position (null = flat) and whether it has been read yet: a bracket whose position is gone is cancelled. */
  positions: Record<string, LadderPosition | null>;
  positionsLoaded: boolean;
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

  const place = async (c: RailChart, side: RestingSide, level: number, bracket: BracketSpec | null = null) => {
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
      price: spec.price, ...(spec.trigger !== undefined ? { trigger: spec.trigger } : {}), lots, product, ...(bracket ? { bracket } : {}),
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

  /**
   * An entry filled at `entry`: create its bracket / cover exits as page-held rows (the leader tab watches them, one cancels the
   * other). Built from the chart's own tick and rupees-per-point, never from the browser's idea of the contract.
   */
  const armChildren = async (e: { id: string; chart: 1 | 2; target: Target; targetKey: string; side: RestingSide; lots: number; mode: 'PAPER' | 'REAL'; product: string; bracket: BracketSpec }, entry: number) => {
    const c = charts.find(x => x.targetKey === e.targetKey);
    if (!c) return;
    const kids = planBracketChildren({ side: e.side, entry, tick: c.tick, spec: e.bracket });
    if (typeof kids === 'string') { onEvent({ kind: 'warn', chart: e.chart, text: `Bracket not placed: ${kids} - the position is OPEN WITHOUT exits` }); return; }
    let failed = 0;
    for (const k of kids) {
      const r = await post({
        op: 'create', row: {
          id: `${e.id}-${k.role}`, day: istDateIso(Date.now()), chart: e.chart, target: e.target, broker, mode: e.mode, venue: 'page', side: k.side, kind: k.kind,
          level: k.level, price: k.price, ...(k.trigger !== undefined ? { trigger: k.trigger } : {}), lots: e.lots, product: e.product,
          unitsPerPoint: (c.unitsPerLot[0] ?? 1) * e.lots, legUnits: c.unitsPerLot.map(u => u * e.lots), t: Date.now() / 1000,
          group: e.id, role: k.role, ...(k.trailPts ? { trailPts: k.trailPts } : {}),
        },
      });
      if (!r.ok) failed++;
    }
    if (failed) onEvent({ kind: 'warn', chart: e.chart, text: `${failed} bracket exit(s) were not created - check the chart: the position may be OPEN WITHOUT exits` });
    else onEvent({ kind: 'info', chart: e.chart, text: `${e.mode === 'PAPER' ? '[PAPER] ' : '[REAL] '}${e.bracket.style} armed: stop ${kids[0].level}${kids[1] ? ` · target ${kids[1].level}` : ''}${e.mode === 'REAL' ? ' (held by this page: keep it open)' : ''}` });
  };
  const armRef = useRef(armChildren);
  useEffect(() => { armRef.current = armChildren; });
  /** A trade-bar entry (or any entry without a resting row) filled: arm its bracket. */
  const armBracket = (a: { chart: 1 | 2; target: Target; targetKey: string; side: RestingSide; lots: number; mode: 'PAPER' | 'REAL'; product: string; bracket: BracketSpec }, entry: number) =>
    armChildren({ ...a, id: `brk-${a.chart}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }, entry);
  /** Cancel every working bracket exit of a chart (a square off, a guard trip). */
  const cancelBracketsFor = async (targetKeyOf: string) => {
    for (const r of ledgerRef.current.rows) if (r.group && r.targetKey === targetKeyOf && r.state === 'working') await post({ op: 'cancel', id: r.id, t: Date.now() / 1000 });
  };

  const modify = async (row: RestingRow, level: number) => {
    const c = charts.find(x => x.targetKey === row.targetKey);
    if (!c || c.price === null) { toast.error('No live price for this chart - not moved'); return; }
    if (row.group) {
      // A bracket exit moves as it is: a stop's trigger or a target's limit follows the box, never re-classified against the price.
      const lv = snapToTick(level, c.tick, 'nearest');
      const r = await post({ op: 'modify', id: row.id, level: lv, price: row.kind === 'limit' ? lv : row.price, ...(row.kind === 'stop' ? { trigger: lv } : {}) });
      if (!r.ok) toast.error(r.error ?? 'Not moved');
      return;
    }
    const spec = planResting({ side: row.side, level, ref: c.price, tick: c.tick, bufferPct: DEFAULT_BUFFER_PCT });
    if ('error' in spec) { toast.error(spec.error); return; }
    if (spec.kind !== row.kind) { toast.error(`Moving it across the price would turn it into ${spec.kind === 'limit' ? 'a LIMIT' : 'an SL-limit'} - cancel it and place a new one`); return; }
    if (row.venue === 'page') { const r = await post({ op: 'modify', id: row.id, level: spec.level, price: spec.price, trigger: spec.trigger }); if (!r.ok) toast.error(r.error ?? 'Not moved'); return; }
    if (!row.brokerOrderId) { toast.error('The order is still being placed - try again in a moment'); return; }
    if (!instant[row.chart] && !window.confirm(`Move this REAL ${row.side} ${row.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${row.lots}L from ${row.level} to ${spec.level}?\n\nIt is changed at your broker. (Turn on Instant above the chart to skip this question.)`)) return;
    const j = await postOrder({
      broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product,
      orderType: row.kind === 'limit' ? 'LIMIT' : 'SL', price: spec.price, trigger: spec.trigger, brokerOp: { op: 'modify', orderId: row.brokerOrderId },
    });
    if (j?.outcome === 'placed') await post({ op: 'modify', id: row.id, level: spec.level, price: j.price ?? spec.price, trigger: j.trigger ?? spec.trigger });
    else onEvent({ kind: 'warn', chart: row.chart, text: !j || j.outcome === 'unknown' ? 'Move status unknown - the order book will show where it is' : `Not moved: ${j.error ?? j.message ?? ''}` });
  };

  /** + / - on a working entry order's tag: a page-held order changes in the ledger, a REAL broker order is modified at the broker first. */
  const changeLots = async (row: RestingRow, delta: number) => {
    const c = charts.find(x => x.targetKey === row.targetKey);
    if (row.group || row.state !== 'working') return;
    const cap = lotCap(row.target);
    const next = Math.max(1, Math.min(cap, row.lots + delta));
    if (next === row.lots) { if (delta > 0) toast.error(`At most ${cap} ${row.target.kind === 'equity' ? 'shares' : 'lots'} per order`); return; }
    if (row.venue === 'page') { const r = await post({ op: 'lots', id: row.id, lots: next }); if (!r.ok) toast.error(r.error ?? 'Not changed'); return; }
    if (!row.brokerOrderId) { toast.error('The order is still being placed - try again in a moment'); return; }
    if (row.broker === 'zerodha' && row.kind === 'stop') { toast.error('Zerodha SL-limit orders cannot be changed here - cancel it and place a new one'); return; }
    if (!c) return;
    if (!instant[row.chart] && !window.confirm(`Change this REAL ${row.side} ${row.kind === 'limit' ? 'LIMIT' : 'SL-limit'} from ${row.lots}L to ${next}L at ${row.level}?\n\nIt is modified at your broker. (Turn on Instant above the chart to skip this question.)`)) return;
    const j = await postOrder({
      broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: next, product: row.product,
      orderType: row.kind === 'limit' ? 'LIMIT' : 'SL', price: row.price, trigger: row.trigger, brokerOp: { op: 'modify', orderId: row.brokerOrderId },
    });
    if (j?.outcome === 'placed') await post({ op: 'lots', id: row.id, lots: next });
    else onEvent({ kind: 'warn', chart: row.chart, text: !j || j.outcome === 'unknown' ? 'Size change status unknown - the order book will show it' : `Size not changed: ${j.error ?? j.message ?? ''}` });
  };

  const cancel = async (row: RestingRow, force = false) => {
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
    if (!force && !instant[row.chart] && !window.confirm(`Cancel this REAL ${row.side} ${row.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${row.lots}L at ${row.level}?\n\n(Turn on Instant above the chart to skip this question.)`)) return;
    const j = await postOrder({ broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product, brokerOp: { op: 'cancel', orderId: row.brokerOrderId } });
    if (j?.outcome === 'placed') await post({ op: 'cancel', id: row.id, t: Date.now() / 1000 });
    else onEvent({ kind: 'warn', chart: row.chart, text: !j || j.outcome === 'unknown' ? 'Cancel status unknown - the order book will show it' : `Not cancelled: ${j.error ?? ''}` });
  };

  // E1: the tick is rebuilt every render and called through a ref from one stable interval; leader tab only (E2).
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    tickRef.current = async () => {
      if (!leaderRef.current) return;
      // Bracket exits: one filled / firing exit cancels its sibling (OCO); a position that is gone cancels them all; a trailing
      // stop follows the price.
      const nowS = Date.now() / 1000;
      const groups = new Map<string, RestingRow[]>();
      for (const r of ledger.rows) if (r.group) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
      for (const rows of groups.values()) {
        const working = rows.filter(r => r.state === 'working');
        if (!working.length) continue;
        // Only a CONFIRMED exit cancels its sibling: a lost or partial reply (unknown) must not strip the position of its other exit.
        const spent = rows.some(r => r.state === 'filled');
        const first = working[0];
        // A PAPER group is judged against the paper ledger and a REAL one against the broker, so a mode flip never cancels the other side's exits.
        if (first.mode !== mode || first.broker !== broker) continue;
        const tracked = charts.some(x => x.targetKey === first.targetKey);
        const flat = tracked && (first.mode === 'PAPER' || positionsLoaded) && !positions[first.targetKey] && nowS - Math.min(...rows.map(r => r.t)) > (first.mode === 'PAPER' ? 3 : 20);
        if (spent || flat) for (const r of working) await post({ op: 'cancel', id: r.id, t: nowS });
      }
      for (const row of ledger.rows) {
        if (row.role !== 'sl' || !row.trailPts || row.state !== 'working' || row.venue !== 'page') continue;
        const c = charts.find(x => x.targetKey === row.targetKey);
        if (!c || c.price === null || c.stale) continue;
        const next = trailedStop({ exitSide: row.side, trigger: row.trigger ?? row.level, price: c.price, trailPts: row.trailPts, tick: c.tick });
        if (next !== null) await post({ op: 'modify', id: row.id, level: next, price: row.price, trigger: next });
      }
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
                if (row.bracket && !row.group) void armRef.current({ ...row, bracket: row.bracket }, step.price);
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
          // A bracket exit only ever REDUCES: sized from what this page opened, clamped by the broker's own row (exitOwn).
          const j = row.group
            ? await postOrder({ broker: row.broker, mode: 'REAL', target: row.target, exitOwn: { side: row.side, units: c.lotUnits.map(u => u * row.lots) }, product: row.product })
            : await postOrder({ broker: row.broker, mode: 'REAL', target: row.target, action: row.side, lots: row.lots, product: row.product });
          if (row.group && j?.outcome === 'flat') {
            await post({ op: 'resolve', id: row.id, as: 'cancelled', t: Date.now() / 1000 });
            onEvent({ kind: 'info', chart: row.chart, text: 'Bracket exit: nothing left to close at the broker' });
          } else if (j?.outcome === 'placed') {
            await post({ op: 'fill', id: row.id, price: c.price, t: Date.now() / 1000 });
            if (row.bracket && !row.group) void armRef.current({ ...row, bracket: row.bracket }, c.price);
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
            if (ok.ok && r.bracket && !r.group) void armRef.current({ ...r, bracket: r.bracket }, px);
            if (ok.ok) eventRef.current({ id: `rail-${r.id}`, kind: 'fill', chart: r.chart, side: r.side, price: px, target: r.target, mode: 'REAL', lots: r.lots, text: `[REAL] ${r.side} ${r.kind === 'limit' ? 'LIMIT' : 'SL-limit'} ${r.lots}L filled @ ${px.toFixed(2)}` });
          } else if (o.state === 'cancelled' && o.filled && o.filled > 0 && r.state === 'working') {
            // Cancelled after a part fill: the filled lots are a real position, so they are booked as a fill (not dropped).
            const perLot = o.qty && r.lots ? o.qty / r.lots : 0;
            const lots = perLot > 0 ? Math.max(1, Math.min(r.lots, Math.round(o.filled / perLot))) : r.lots;
            const px = o.avg ?? r.price;
            const ok = await post({ op: 'fill', id: r.id, price: px, t, lots });
            if (ok.ok && r.bracket && !r.group) void armRef.current({ ...r, lots, bracket: r.bracket }, px);
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
  /** Cancel every working order of a chart, broker orders included, without asking (a guard trip). */
  const cancelAllFor = async (targetKeyOf: string) => {
    for (const r of ledgerRef.current.rows) if (r.targetKey === targetKeyOf && r.state === 'working') await cancel(r, true);
  };
  return { ledger, place, modify, changeLots, cancel, openFor, armBracket, cancelBracketsFor, cancelAllFor };
}

/** A chart's contract as the server resolves it (the order route's GET): its tick and rupees per point per lot, per leg. */
export interface ChartLegs { tick: number; unitsPerLot: number[]; /** The broker's position keys and quantity per lot, per leg (the ladder's position read). */ keys: string[]; lotUnits: number[] }
export function useChartLegs(broker: Broker, target: Target, targetKeyOf: string, enabled: boolean): ChartLegs | null {
  const [info, setInfo] = useState<(ChartLegs & { key: string }) | null>(null);
  const key = `${broker}|${targetKeyOf}`;
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    void (async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/order?broker=${broker}&target=${encodeURIComponent(JSON.stringify(target))}`)).json() as
          { success?: boolean; unsupported?: string | null; legs?: { tick: number | null; lot: number; unitsPerLot: number | null; key?: string | null; lotUnits?: number | null }[] };
        if (dead || !j.success || !j.legs?.length) return;
        setInfo({ key, tick: j.legs[0].tick && j.legs[0].tick > 0 ? j.legs[0].tick : 0.05, unitsPerLot: j.legs.map(l => l.unitsPerLot ?? l.lot),
          keys: j.unsupported ? [] : j.legs.map(l => l.key ?? ''), lotUnits: j.unsupported ? [] : j.legs.map(l => l.lotUnits ?? 0) });
      } catch { /* the rail waits for it */ }
    })();
    return () => { dead = true; };
    // target is fully described by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return info && info.key === key ? { tick: info.tick, unitsPerLot: info.unitsPerLot, keys: info.keys, lotUnits: info.lotUnits } : null;
}
