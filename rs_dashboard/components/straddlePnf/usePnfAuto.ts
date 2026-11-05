'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { autoProductOf, decideAdd, decideAuto, reentryBlockOf, rowMarket, trailLevel, trailOf, type AutoProduct } from '@/lib/pnfAuto';
import { ignoredByFilter, SIDE_LABEL, withSide, type AutoSide } from '@/lib/pnfAutoRule';
import { isSellSignal } from '@/lib/straddlePnf';
import { EMPTY_LEDGER, isLive, PYRAMID_HARD_MAX, type AutoLedger, type AutoLeg, type AutoOp, type AutoRow } from '@/lib/pnfAutoLedger';
import { istDateIso } from '@/lib/nseHolidays';
import { targetKey, type Target } from '@/lib/pnfTarget';
import type { LegResult } from '@/lib/pnfOrderLogic';
import type { Broker } from '@/hooks/useBrokerSelector';
import type { Market } from '@/lib/straddlePnfLive';
import type { PanelModel } from '@/lib/straddlePnfModel';
import { scopeQuery, type PnfScope } from '@/lib/pnfScope';
import { fullFillAvg, readOrderPrice } from '@/lib/tradedPriceClient';

// The P&F AUTO engine for ONE chart (rules: lib/pnfAuto.ts; ledger: lib/pnfAutoLedger.ts; spec: strategies/pnf_auto/strategy.md).
// Runs from the open page, in the leader tab only, on a stable 1 s tick. Entries need AUTO armed on this chart (armed per page
// load, in the page's mode at arming); exits run for this chart's open row whatever the switch says. REAL orders are reserved
// in the ledger before they are sent and an unknown outcome is never resent: the chart halts and the user resolves it.

const TICK_MS = 1_000;
/** A REAL fill that cannot be read after this many tries (a minute apart) stays at its decision price. */
const SETTLE_MAX_TRIES = 5;
const SETTLE_POLL_MS = 15_000;
/** A gap this long between two ticks means the browser slowed the tab's timers. */
const LAG_WARN_MS = 8_000;
const LAG_WARN_EVERY_MS = 5 * 60_000;
const LEDGER_POLL_MS = 3_000;
const MAX_REJECTS = 3;
/** A refused REAL exit is retried this often (the order route also holds a close cooldown). */
const EXIT_RETRY_MS = 10_000;
/** A pyramid add that failed before anything was sent is retried this many times on its bar. */
const ADD_MAX_TRIES = 3;

type Reply = { success?: boolean; error?: string; outcome?: string; legs?: LegResult[]; message?: string };
type LegInfo = { label: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null };

/** The shared ledger: polled, and replaced only by a newer `rev` so a slow poll never rolls back an op's reply. `scope`: whose ledger (P&F or Renko). */
export function usePnfAutoLedger(scope: PnfScope = 'pnf') {
  const [ledger, setLedger] = useState<AutoLedger>(EMPTY_LEDGER);
  const accept = useCallback((l: AutoLedger | undefined) => {
    if (l) setLedger(prev => (l.rev > prev.rev || prev.rev === 0 ? l : prev));
  }, []);
  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/auto${scopeQuery(scope)}`)).json() as { ledger?: AutoLedger };
        if (!dead) accept(j.ledger);
      } catch { /* the next poll retries */ }
    };
    void read();
    const id = setInterval(read, LEDGER_POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [accept, scope]);
  const post = useCallback(async (op: AutoOp): Promise<{ ok: boolean; error?: string; ledger?: AutoLedger }> => {
    try {
      const res = await fetch(`/api/straddle-pnf/auto${scopeQuery(scope)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
      const j = await res.json() as { success?: boolean; error?: string; ledger?: AutoLedger };
      accept(j.ledger);
      return { ok: Boolean(j.success), error: j.error, ledger: j.ledger };
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Ledger unreachable' };
    }
  }, [accept, scope]);
  return { ledger, post };
}

export type AutoEvent = { chart: 1 | 2; kind: 'entry' | 'exit' | 'halt' | 'info'; text: string; side?: 'BUY' | 'SELL'; price?: number; target?: Target; mode?: 'PAPER' | 'REAL'; lots?: number };

/** `armT`: the saved arming this follows (lib/pnfAutoLedger.ts AutoArmRecord.t); absent when the save failed (this tab only). */
export interface AutoArm {
  on: boolean; mode: 'PAPER' | 'REAL'; watermarkT: number; armT?: number;
  /** The product new entries are sent with (MIS when absent); a row keeps the product it was opened with. */
  product?: AutoProduct;
}

/**
 * Pyramid (Renko): add one lot every `every` new bricks while a position is open, up to `max` total lots (lib/pnfAuto.ts decideAdd).
 * `trailOn` / `trail`: once a lot was added, exit on a closed brick `trail` boxes back from the best brick (lib/pnfAuto.ts trailOf).
 */
export interface AutoPyramid { on: boolean; max: number; every: number; trailOn: boolean; trail: number }

export function usePnfAuto({ chart, arm, lots, target, model: ruleModel, side = 'both', pyramid, price, stale, market, complete, broker, mode, leaderRef, ledger, post, onEvent, onDisarm, scope = 'pnf' }: {
  chart: 1 | 2;
  /** Renko only: add a lot per new best brick (the row keeps its cap from entry; adds run only while armed with this on). */
  pyramid?: AutoPyramid;
  arm: AutoArm;
  lots: number;
  target: Target;
  /** The chart's CLOSED-bar model (signals / columns never include the forming minute), with the selected rule's signals. */
  model: PanelModel;
  /** Which side AUTO may OPEN (default both). Applied here, so the status can say when it holds a signal back; exits are never filtered. */
  side?: AutoSide;
  /** The chart's live price (a straddle's CE + PE), or null. */
  price: number | null;
  stale: boolean;
  market: Market;
  complete: boolean;
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  leaderRef: React.RefObject<boolean>;
  ledger: AutoLedger;
  post: (op: AutoOp) => Promise<{ ok: boolean; error?: string; ledger?: AutoLedger }>;
  onEvent: (e: AutoEvent) => void;
  /** The engine switched AUTO off itself (a halt, or the page mode changed under it). */
  onDisarm: (why: string) => void;
  /** The page whose ledgers these orders belong to (the order route reads its resting ledger for the close note). */
  scope?: PnfScope;
}) {
  const model = withSide(ruleModel, side);                                  // entries read the allowed side's signals only
  const ignoredRef = useRef<string>('');                                      // the kind of the last held-back signal that was logged
  useEffect(() => { ignoredRef.current = ''; }, [arm.on, side]);
  const [note, setNote] = useState<string>('');
  const [halt, setHalt] = useState<string | null>(null);
  const [info, setInfo] = useState<{ key: string; legs: LegInfo[]; unsupported: string | null } | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; });
  const busyRef = useRef(false);
  const haltRef = useRef<string | null>(null);
  const rejectsRef = useRef(0);
  const exitRetryAtRef = useRef(0);
  const watermarkRef = useRef(0);
  /**
   * Adds tried on a bar. An order that went out (or a definite refusal) spends the bar; a failure before anything was sent (ledger
   * unreachable, contract lookup pending) is retried on the next ticks, at most ADD_MAX_TRIES times, while the bar is the newest.
   */
  const addTriesRef = useRef<{ barT: number; n: number; spent: boolean } | null>(null);
  /** A signal whose entry failed before anything was sent (retried while fresh), so a miss is logged once. */
  const retryRef = useRef<{ id: string; side: 'BUY' | 'SELL'; why: string } | null>(null);

  const tk = targetKey(target);
  const infoKey = `${broker}|${tk}`;
  // One lot of this chart on the broker (server-resolved), for paper P&L and for REAL leg keys.
  useEffect(() => {
    if (target.kind === 'index' || !complete) return;
    let dead = false;
    void (async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/order?broker=${broker}&target=${encodeURIComponent(JSON.stringify(target))}`)).json() as
          { success?: boolean; legs?: LegInfo[]; unsupported?: string | null; error?: string };
        if (!dead) setInfo({ key: infoKey, legs: j.legs ?? [], unsupported: j.success ? j.unsupported ?? null : j.error ?? 'Contract lookup failed' });
      } catch { if (!dead) setInfo({ key: infoKey, legs: [], unsupported: 'Contract lookup failed' }); }
    })();
    return () => { dead = true; };
    // target is fully described by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoKey, complete]);

  // Arming moves the watermark to the newest closed bar: a signal already on the chart is never entered.
  useEffect(() => { watermarkRef.current = arm.watermarkT; }, [arm.watermarkT]);
  // A new arming clears a halt (the user switched AUTO back on).
  useEffect(() => {
    if (!arm.on) return;
    haltRef.current = null; rejectsRef.current = 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHalt(null);
  }, [arm.on, arm.watermarkT]);

  const row: AutoRow | undefined = ledger.rows.find(r => r.chart === chart && isLive(r));

  // The dashboard SERVER exited this chart's position (its MTM guard, with or without this tab): AUTO is switched off here too, or a trend
  // rule would re-enter on the next brick. Only an exit after this arming counts (an older one must not disarm a fresh arming).
  useEffect(() => {
    if (!arm.on) return;
    // Measured from the ARMING (wall clock), not the watermark (a bar time a minute or more earlier): a guard exit just before arming is not this arming's.
    const since = arm.armT ?? arm.watermarkT;
    const hit = ledger.rows.find(r => r.chart === chart && r.mode === arm.mode && (r.exitT ?? r.pendingSince ?? 0) > since
      && ((r.state === 'closed' && (r.reason ?? '').startsWith('server guard')) || (r.state === 'unknownExit' && (r.note ?? '').startsWith('server guard'))));
    if (hit) onDisarm(`the server guard exited chart ${chart}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, arm.on, arm.watermarkT, arm.armT]);

  // REAL fills: a row's entry / exit price starts as the chart's price at the DECISION. Once the broker reports its orders FULLY traded, the
  // broker's average traded price (summed over a straddle's legs) replaces it and the P&L is recomputed (the `fillPrice` ledger op). Any
  // leader tab does this from the order ids kept on the row, so it also happens after a reload or for an exit the server sent.
  // It only prices what it can price whole: one order per leg (a leg that was already flat has none), each fully traded for the leg's
  // units (a partial fill, a cancelled remainder or the first slice of a split order is NOT the price of the position). Anything else
  // keeps its decision price - shown with a `~` - after a few tries, and is said once in the ledger log.
  const settlingRef = useRef<Map<string, number>>(new Map());
  const settleTriesRef = useRef<Map<string, number>>(new Map());
  const settleRef = useRef<() => void>(() => {});
  useEffect(() => {
    settleRef.current = () => {
      if (!leaderRef.current) return;
      const todo: { r: AutoRow; which: 'entry' | 'exit' | 'add'; addId?: string }[] = [];
      for (const r of ledger.rows) {
        if (r.chart !== chart || r.mode !== 'REAL') continue;
        // closed without an AUTO order (flat at the broker, resolved by hand, refused): no real exit to price against
        if (r.state === 'closed' && (r.reason === 'flat at broker' || r.reason === 'resolved' || r.reason === 'refused')) continue;
        if (r.entryOrderIds?.length && !r.entryFilled && (r.state === 'open' || r.state === 'exiting' || r.state === 'closed' || r.state === 'adding' || r.state === 'unknownAdd')) todo.push({ r, which: 'entry' });
        if (r.state === 'closed' && r.exitOrderIds?.length && !r.exitFilled) todo.push({ r, which: 'exit' });
        for (const a of r.adds ?? []) if (a.status === 'done' && a.orderIds?.length && !a.filled) todo.push({ r, which: 'add', addId: a.id });
      }
      for (const { r, which, addId } of todo) {
        const key = `${r.id}:${which}${addId ? `:${addId}` : ''}`;
        if (Date.now() < (settlingRef.current.get(key) ?? 0)) continue;
        const add = addId ? r.adds?.find(a => a.id === addId) : undefined;
        const ids = (which === 'entry' ? r.entryOrderIds : which === 'add' ? add?.orderIds : r.exitOrderIds) ?? [];
        // an add's units per leg, not the row's totals
        const unitsOf = (k: number) => (which === 'add' && add ? add.units[k] : r.legs[k].units);
        // one order per leg, or it is not the whole price: left at the decision price for good
        if (ids.length !== r.legs.length) { settlingRef.current.set(key, Number.POSITIVE_INFINITY); continue; }
        settlingRef.current.set(key, Date.now() + 60_000);                       // in flight, or retried after a minute
        void (async () => {
          const reads = await Promise.all(ids.map(async (id, k) => {
            for (const wait of [800, 1500, 3000, 6000]) {
              await new Promise(res => setTimeout(res, wait));
              const px = fullFillAvg(await readOrderPrice(id, r.broker as Broker), unitsOf(k));
              if (px > 0) return px;
            }
            return 0;
          }));
          if (reads.every(px => px > 0)) {
            const res = await post({ op: 'fillPrice', id: r.id, which, price: Math.round(reads.reduce((a, b) => a + b, 0) * 100) / 100, legCount: ids.length, ...(addId ? { addId } : {}) });
            if (res.ok) { settlingRef.current.set(key, Number.POSITIVE_INFINITY); return; }           // done for good
            // refused for good (a price outside the band, a row closed another way): the decision price stands
            if (res.error && /more than|closed as|covers/.test(res.error)) settlingRef.current.set(key, Number.POSITIVE_INFINITY);
          }
          const tries = (settleTriesRef.current.get(key) ?? 0) + 1;
          settleTriesRef.current.set(key, tries);
          if (tries >= SETTLE_MAX_TRIES) {
            settlingRef.current.set(key, Number.POSITIVE_INFINITY);
            void post({ op: 'log', chart, t: Date.now() / 1000, text: `could not read the broker's ${which} fill (${ids.join(', ')}); the ${which} price stays at the decision price` });
          }
        })();
      }
    };
  });
  // on every ledger change, and on a timer so a tab that becomes the leader later (or a ledger that sits idle) still settles
  useEffect(() => { settleRef.current(); }, [ledger]);
  useEffect(() => {
    const id = setInterval(() => settleRef.current(), SETTLE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  const haltNow = useCallback((why: string) => {
    haltRef.current = why;
    setHalt(why);
    onDisarm(why);
    onEvent({ chart, kind: 'halt', text: `AUTO C${chart} halted: ${why}` });
    void post({ op: 'log', chart, t: Date.now() / 1000, text: `halted: ${why}` });
  }, [chart, onDisarm, onEvent, post]);

  const sendOrder = async (body: Record<string, unknown>): Promise<Reply | null> => {
    try {
      const res = await fetch('/api/straddle-pnf/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'auto', scope, ...body }) });
      return await res.json() as Reply;
    } catch { return null; }                                  // no clean reply: UNKNOWN, never a failure
  };

  /**
   * `livePx`: the chart's price now; `box`: the confirmed box the signal bar reached (PAPER books it; REAL books the live price).
   * Returns why NOTHING was sent when it may work on the next tick (no contract lookup yet, the ledger unreachable - a dashboard
   * restart - or refusing the reservation): the tick then keeps the signal and tries again while it is still the newest closed bar's.
   * null once the entry was taken, or sent, or refused for good (a REAL order that went out is never retried).
   */
  const enter = async (side: 'BUY' | 'SELL', signalT: number, livePx: number, box: number | null, stop?: number, exitBy?: 'supertrend'): Promise<string | null> => {
    const px = arm.mode === 'PAPER' && box !== null ? box : livePx;
    const cur = info && info.key === infoKey ? info : null;
    if (!cur || !cur.legs.length) { setNote('waiting for the contract lookup'); return 'the contract lookup has not answered'; }
    if (arm.mode === 'REAL' && cur.unsupported) { haltNow(cur.unsupported); return null; }
    const unitsPerPoint = (cur.legs[0].unitsPerLot ?? cur.legs[0].lot) * lots;
    const id = `pnfa-${chart}-${Date.now()}`;
    const nowS = Date.now() / 1000;
    const product = target.kind === 'equity' ? 'INTRADAY' : autoProductOf(arm.product);   // a stock is MIS only
    const base = {
      id, day: istDateIso(Date.now()), chart, target, market, ...(product === 'MARGIN' ? { product } : {}), mode: arm.mode, broker, side, lots, unitsPerPoint,
      legs: cur.legs.map(l => ({ label: l.label, key: l.key, units: (l.lotUnits ?? l.lot) * lots })), entryT: nowS, entryBarT: signalT, entryPrice: px,
      ...(box !== null ? { entryBox: box } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(exitBy ? { exitBy } : {}),
      ...(pyramid?.on && pyramid.max > lots ? { pyramidMax: Math.min(pyramid.max, PYRAMID_HARD_MAX), ...(pyramid.every > 1 ? { pyramidEvery: pyramid.every } : {}), ...(pyramid.trailOn ? { trailBoxes: pyramid.trail } : {}) } : {}),
    };
    if (arm.mode === 'PAPER') {
      const j = await sendOrder({ broker, mode: 'PAPER', target, action: side, lots, product });
      if (!j?.success) { setNote(`paper order refused: ${j?.error ?? 'no reply'}`); return `paper order refused (${j?.error ?? 'no reply'})`; }
      const r = await post({ op: 'open', row: base });
      if (!r.ok) { setNote(`ledger refused: ${r.error}`); return `the ledger refused it (${r.error ?? 'unreachable'})`; }
      onEvent({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [PAPER] ${side} ${lots}L @ ${px.toFixed(2)}` });
      return null;
    }
    // REAL: reserve, send, then confirm / void / mark unknown. A refused reservation sent nothing: it may be tried again.
    const reserved = await post({ op: 'open', row: { ...base, state: 'entering' } });
    if (!reserved.ok) { setNote(`ledger refused the entry: ${reserved.error}`); return `the ledger refused the reservation (${reserved.error ?? 'unreachable'})`; }
    const j = await sendOrder({ broker, mode: 'REAL', target, action: side, lots, product });
    if (!j || j.outcome === 'unknown') {
      await post({ op: 'markUnknown', id, note: j?.message ?? 'no reply from the order route' });
      haltNow('entry outcome unknown - check Orders/Positions, then resolve it');
      return null;
    }
    if (j.outcome === 'placed') {
      const legs: AutoLeg[] = (j.legs ?? []).filter(l => l.status === 'placed').map((l, i) => ({ label: l.label, key: base.legs[i]?.key ?? null, units: l.qty }));
      const ok = await post({ op: 'confirmEntry', id, legs, orderIds: (j.legs ?? []).filter(l => l.status === 'placed' && l.orderId).map(l => String(l.orderId)) });
      if (!ok.ok) { haltNow(`order placed but the ledger refused it (${ok.error}) - check Positions`); return null; }
      rejectsRef.current = 0;
      onEvent({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [REAL] ${side} ${lots}L @ ~${px.toFixed(2)}` });
      return null;
    }
    if (j.outcome === 'partial') {
      await post({ op: 'markUnknown', id, note: j.message ?? 'partial' });
      haltNow('only part of the straddle was placed - check Positions, then resolve it');
      return null;
    }
    // rejected / reversed: nothing is open.
    await post({ op: 'voidEntry', id, t: Date.now() / 1000, note: j.message ?? j.error ?? 'refused' });
    rejectsRef.current += 1;
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} entry refused: ${j.message ?? j.error ?? ''}` });
    if (rejectsRef.current >= MAX_REJECTS) haltNow(`${MAX_REJECTS} entries in a row were refused`);
    return null;
  };

  /** `barT`: the bar that triggered the exit (the reversal column's first bar), for the chart marker. */
  /** True when the row was closed (PAPER ledger close, or a REAL exit the broker placed / found already flat). */
  const exit = async (r: AutoRow, reason: string, px: number | null, barT?: number, box?: number | null): Promise<boolean> => {
    // PAPER books the confirmed box the reversal reached; REAL (and an EOD exit, which has no box) the live price. Only an EOD
    // exit can run without a price (E5): it books the entry price then.
    const exitPx = r.mode === 'PAPER' && box != null ? box : px ?? r.entryPrice;
    const boxField = box != null ? { exitBox: box } : {};
    const side = r.side === 'BUY' ? 'SELL' : 'BUY';
    if (r.mode === 'PAPER') {
      const c = await post({ op: 'close', id: r.id, exitT: Date.now() / 1000, exitPrice: exitPx, reason, exitBarT: barT, ...boxField });
      if (c.ok) onEvent({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [PAPER] exit (${reason}) @ ${exitPx.toFixed(2)}` });
      return c.ok;
    }
    if (Date.now() < exitRetryAtRef.current) return false;
    const reserved = await post({ op: 'beginExit', id: r.id, t: Date.now() / 1000 });
    if (!reserved.ok) { setNote(`ledger refused the exit: ${reserved.error}`); return false; }
    // The broker it was opened on and the units AUTO owns, never the Lots box or the page broker.
    const j = await sendOrder({ broker: r.broker, mode: 'REAL', target: r.target, exitOwn: { side, units: r.legs.map(l => l.units), product: autoProductOf(r.product) } });
    if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
      await post({ op: 'markUnknown', id: r.id, note: j?.message ?? 'no reply from the order route' });
      haltNow('exit outcome unknown - check Orders/Positions, then resolve it');
      return false;
    }
    if (j.outcome === 'placed' || j.outcome === 'flat') {
      const c = await post({ op: 'close', id: r.id, exitT: Date.now() / 1000, exitPrice: exitPx, reason, exitBarT: barT, ...boxField, note: j.outcome === 'flat' ? 'already flat at the broker' : undefined, orderIds: (j.legs ?? []).filter(l => l.status === 'placed' && l.orderId).map(l => String(l.orderId)) });
      if (!c.ok) { haltNow(`exit sent but the ledger refused it (${c.error})`); return false; }
      onEvent({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [REAL] exit (${reason}) @ ~${exitPx.toFixed(2)}${j.outcome === 'flat' ? ' - already flat at the broker' : ''}` });
      return true;
    }
    await post({ op: 'abortExit', id: r.id, note: j.message ?? j.error ?? 'exit refused' });
    exitRetryAtRef.current = Date.now() + EXIT_RETRY_MS;
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} exit refused, retrying: ${j.message ?? j.error ?? ''}` });
    return false;
  };

  /**
   * Pyramid: add one lot to the open row on a new best brick. PAPER books the brick; REAL reserves the add in the ledger (open → adding), sends
   * ONE order in the row's own direction on the broker it was opened on, then confirms / voids it; an unclear outcome halts the chart and
   * waits for the user (never resent). `barT` is tried once: a refused add waits for the next new best brick.
   */
  const addLot = async (r: AutoRow, barT: number, box: number, livePx: number): Promise<void> => {
    const tries = addTriesRef.current?.barT === barT ? addTriesRef.current : { barT, n: 0, spent: false };
    tries.n += 1;
    addTriesRef.current = tries;
    const spend = () => { tries.spent = true; };
    const id = `add-${Date.now()}`;
    const t = Date.now() / 1000;
    const total = r.lots + 1;
    if (r.mode === 'PAPER') {
      const res = await post({ op: 'addPaper', id: r.id, add: { id, t, barT, box, lots: 1, price: box } });
      if (!res.ok) { setNote(`add refused: ${res.error}`); return; }      // nothing booked: retried while the bar is fresh
      spend();
      onEvent({ chart, kind: 'entry', side: r.side, price: box, target: r.target, mode: r.mode, lots: 1, text: `AUTO C${chart} [PAPER] add 1L @ ${box.toFixed(2)} → ${total}L` });
      return;
    }
    // The checks an entry makes before it sends: the contract lookup for THIS broker and contract, and REAL support for it.
    const cur = info && info.key === infoKey ? info : null;
    if (!cur || !cur.legs.length) { setNote('add waiting for the contract lookup'); return; }
    if (cur.unsupported) { spend(); haltNow(cur.unsupported); return; }
    const reserved = await post({ op: 'beginAdd', id: r.id, add: { id, t, barT, box, lots: 1, price: livePx } });
    if (!reserved.ok) { setNote(`ledger refused the add: ${reserved.error}`); return; }
    spend();                                                          // reserved: whatever happens next, this bar's add is never sent again
    const j = await sendOrder({ broker: r.broker, mode: 'REAL', target: r.target, action: r.side, lots: 1, product: autoProductOf(r.product) });
    if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
      await post({ op: 'markUnknown', id: r.id, note: `add: ${j?.message ?? 'no reply from the order route'}` });
      haltNow('add outcome unknown - check Orders/Positions, then resolve it');
      return;
    }
    if (j.outcome === 'placed') {
      const placed = (j.legs ?? []).filter(l => l.status === 'placed');
      const ok = await post({ op: 'confirmAdd', id: r.id, units: placed.map(l => l.qty), orderIds: placed.filter(l => l.orderId).map(l => String(l.orderId)) });
      if (!ok.ok) {
        await post({ op: 'markUnknown', id: r.id, note: `add placed but not as reserved: ${ok.error}` });
        haltNow(`add placed but the ledger refused it (${ok.error}) - check Positions, then resolve it`);
        return;
      }
      onEvent({ chart, kind: 'entry', side: r.side, price: livePx, target: r.target, mode: r.mode, lots: 1, text: `AUTO C${chart} [REAL] add 1L @ ~${livePx.toFixed(2)} → ${total}L` });
      return;
    }
    // rejected / reversed: nothing was added
    await post({ op: 'voidAdd', id: r.id, note: `add refused: ${j.message ?? j.error ?? 'refused'}` });
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} add refused: ${j.message ?? j.error ?? ''} - the next new best brick tries again` });
  };

  // E1: the tick is rebuilt every render and called through a ref from one stable interval.
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    tickRef.current = async () => {
      if (!leaderRef.current || busyRef.current) return;
      const nowS = Date.now() / 1000;
      if (row) {
        retryRef.current = null;                                 // a row exists: the signal being retried was taken (or reserved)
        if (row.state !== 'open') { setNote(row.state === 'entering' || row.state === 'exiting' || row.state === 'adding' ? `${row.state}…` : 'unresolved - check the broker'); return; }
        if (row.targetKey !== tk) {
          // The chart was switched away from its position: only the EOD exit can still run (no model for that contract here).
          const d = decideAuto({ model: { box: 0, signals: [], columns: [], columnTimes: [], lastBarT: null }, position: { side: row.side, entryBarT: row.entryBarT }, watermarkT: 0, nowS, market: rowMarket(row), product: autoProductOf(row.product) });
          setNote('position on another contract: watching the EOD exit only');
          if (d.action === 'exit' && d.reason === 'eod') { busyRef.current = true; try { await exit(row, 'eod', null); } finally { busyRef.current = false; } }
          return;
        }
        // The end-of-day time is the POSITION's market (saved on the row), never the chart's `market`: that reads 'NSE' until the history has
        // loaded (a page reload, an instrument or setting change), which would flatten an MCX position at the NSE 15:15 straight away.
        const position = { side: row.side, entryBarT: row.entryBarT, stop: row.stop, exitBy: row.exitBy, trail: trailOf(row) };
        const d = decideAuto({ model, position, watermarkT: watermarkRef.current, nowS, market: rowMarket(row), price, product: autoProductOf(row.product) });
        if (d.action !== 'exit') {
          const tl = trailLevel(model, position);
          const trailTxt = tl !== null ? ` · trail SL ${tl.toFixed(2)}` : '';
          // Pyramid: only while armed in the row's own mode, with adds still switched on, a fresh price and no halt.
          // `complete`: the chart's history is fully loaded (a partial model would miss the best brick so far and add after a pullback).
          // The row's broker must be the page's: the contract lookup and the order route are the page broker's.
          if (arm.on && arm.mode === row.mode && pyramid?.on && row.pyramidMax && !haltRef.current && !stale && price !== null && complete && row.broker === broker) {
            const a = decideAdd({ model, row, nowS, market: rowMarket(row), maxLots: Math.min(row.pyramidMax, pyramid.max, PYRAMID_HARD_MAX) });
            const tried = a.add && addTriesRef.current?.barT === a.barT ? addTriesRef.current : null;
            if (a.add && !(tried && (tried.spent || tried.n >= ADD_MAX_TRIES))) {
              busyRef.current = true;
              try { await addLot(row, a.barT, a.box, price); } finally { busyRef.current = false; }
              return;
            }
            setNote(a.add || a.why === 'no new best brick on the newest bar' || a.why === 'already added on this bar' || a.why.startsWith('waiting for') ? `holding ${row.lots}L (+1L/${row.pyramidEvery ?? 1} br to ${Math.min(row.pyramidMax, pyramid.max)}L)${trailTxt}` : `holding ${row.lots}L (${a.why})${trailTxt}`);
            return;
          }
          setNote((arm.on ? 'holding' : 'holding - AUTO is OFF: it will exit by its rule, not re-enter') + trailTxt);
          return;
        }
        if ((d.reason === 'reversal' || d.reason === 'trail') && price === null) { setNote(`${d.reason} seen, waiting for a price`); return; }
        busyRef.current = true;
        const barT = (d.reason === 'reversal' || d.reason === 'trail') && d.col !== undefined ? model.columnTimes[d.col]?.start : undefined;
        let closed = false;
        try { closed = await exit(row, d.reason, price, barT, d.boxPrice); } finally { busyRef.current = false; }
        // A rule exit with AUTO off (a reload, another tab, a halt) is the end of the trade: said out loud, so a missing re-entry is never silent.
        if (closed && !arm.on && d.reason !== 'eod') {
          const text = `exited (${d.reason}) while AUTO was OFF on this chart: no re-entry - arm AUTO to trade the next signal`;
          onEvent({ chart, kind: 'info', text: `AUTO C${chart} ${text}` });
          void post({ op: 'log', chart, t: Date.now() / 1000, text });
        }
        return;
      }
      if (!arm.on || haltRef.current) return;
      if (arm.mode !== mode) { onDisarm(`the page switched to ${mode}`); return; }
      if (target.kind === 'index') { setNote('an index cannot be traded'); return; }
      if (!complete || stale || price === null) { setNote(stale ? 'feed stale: no entries' : 'waiting for a price'); return; }
      // The chart's last trade, if the trailing SL closed it today on this contract in this mode: same-side entries wait for a new best brick.
      const lastRow = [...ledger.rows].reverse().find(r => r.chart === chart);
      const reentryBlock = lastRow && lastRow.targetKey === tk && lastRow.mode === arm.mode && lastRow.day === istDateIso(Date.now()) ? reentryBlockOf(lastRow, model) : undefined;
      const d = decideAuto({ model, position: null, watermarkT: watermarkRef.current, nowS, market, product: target.kind === 'equity' ? 'INTRADAY' : autoProductOf(arm.product), reentryBlock });
      // A signal whose entry kept failing before anything was sent, and is no longer enterable (a newer bar closed, it aged out): said once.
      const pending = retryRef.current;
      if (pending && !(d.action === 'enter' && d.signal.id === pending.id)) {
        retryRef.current = null;
        const text = `missed the ${pending.side} signal: ${pending.why} until it was no longer the newest bar's - nothing was sent`;
        onEvent({ chart, kind: 'info', text: `AUTO C${chart} ${text}` });
        void post({ op: 'log', chart, t: nowS, text });
      }
      if (d.action !== 'enter') {
        const held = d.action === 'none' ? ignoredByFilter(ruleModel, side, watermarkRef.current) : null;
        if (held) {
          const what = `${isSellSignal(held.kind) ? 'SELL' : 'BUY'} signal ignored (${SIDE_LABEL[side]})`;
          setNote(what);
          if (ignoredRef.current !== held.kind) { ignoredRef.current = held.kind; void post({ op: 'log', chart, t: Date.now() / 1000, text: what }); }   // once per change of direction, not per brick
        } else setNote(d.action === 'none' ? d.why : '');
        return;
      }
      ignoredRef.current = '';
      const before = watermarkRef.current;
      watermarkRef.current = d.signal.t;                       // handled: this signal is never entered again...
      busyRef.current = true;
      try {
        const again = await enter(d.side, d.signal.t, price, d.boxPrice, d.signal.stop, d.signal.exitBy);
        if (again === null) retryRef.current = null;
        // ...unless nothing was sent and it may work next tick: the signal is kept (never across a new arming, which moved the watermark)
        else if (watermarkRef.current === d.signal.t) {
          watermarkRef.current = before;
          if (retryRef.current?.id !== d.signal.id) void post({ op: 'log', chart, t: nowS, text: `${d.side} signal not entered yet: ${again} - retrying while it is fresh` });
          retryRef.current = { id: d.signal.id, side: d.side, why: again };
        }
      } finally { busyRef.current = false; }
    };
  });
  // A hidden tab has its timers slowed by the browser (about once a minute after a few minutes), and AUTO's entries, rule exits and the
  // page's guard all run on this one timer. A gap far beyond the tick is said out loud (at most every 5 minutes), so a slowed tab is not
  // mistaken for a working one; a REAL position still has the dashboard server's guard and end-of-day exit behind it.
  const lastTickRef = useRef(0);
  const lastLagWarnRef = useRef(-Infinity);
  const armedOrOpenRef = useRef(false);
  useEffect(() => { armedOrOpenRef.current = arm.on || !!row; });
  useEffect(() => {
    // The monotonic clock (not Date.now): a wall-clock jump (a clock sync, a changed system time) is not a slowed timer.
    lastTickRef.current = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const gap = now - lastTickRef.current;
      lastTickRef.current = now;
      if (leaderRef.current && armedOrOpenRef.current && gap > LAG_WARN_MS && now - lastLagWarnRef.current > LAG_WARN_EVERY_MS) {
        lastLagWarnRef.current = now;
        onEventRef.current({ chart, kind: 'info', text: `AUTO C${chart}: this tab's timers were slowed (${Math.round(gap / 1000)} s since the last check) - entries and exits ran late. Keep the tab in view; the server guard still protects a REAL position.` });
      }
      void tickRef.current();
    }, TICK_MS);
    return () => clearInterval(id);
  }, [chart, leaderRef]);

  const resolve = (as: 'open' | 'flat' | 'added' | 'notAdded') => {
    if (!row) return;
    void post({ op: 'resolve', id: row.id, as, exitPrice: price ?? undefined, t: Date.now() / 1000 });
  };

  /**
   * Manual (or MTM-guard) exit of the open row, at the live price (PAPER: the ledger close; REAL: the same reserved exit as a rule exit). It also
   * switches AUTO off: otherwise a state-based rule would re-enter on the next brick. Never runs on an unresolved row.
   */
  const exitNow = async (why = 'manual'): Promise<boolean> => {
    if (!row || row.state !== 'open' || busyRef.current) return false;
    // A close at the entry price would book a loss as flat: only the end-of-day exit may run without a price.
    if (price === null) { setNote('exit waiting for a live price'); onEvent({ chart, kind: 'info', text: `AUTO C${chart} exit (${why}) is waiting for a live price` }); return false; }
    busyRef.current = true;
    try {
      onDisarm(`${why} exit`);
      return await exit(row, why, price);
    } finally { busyRef.current = false; }
  };

  // The open row's trailing SL level now, for the position line: computed on render (every tab, leader or not), only for its own contract.
  const trailSl = row && row.state === 'open' && row.targetKey === tk ? trailLevel(model, { side: row.side, entryBarT: row.entryBarT, trail: trailOf(row) }) : null;
  return { row, note, halt, resolve, exitNow, trailSl };
}
