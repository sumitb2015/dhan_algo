'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decideAuto } from '@/lib/pnfAuto';
import { EMPTY_LEDGER, isLive, type AutoLedger, type AutoLeg, type AutoOp, type AutoRow } from '@/lib/pnfAutoLedger';
import { istDateIso } from '@/lib/nseHolidays';
import { targetKey, type Target } from '@/lib/pnfTarget';
import type { LegResult } from '@/lib/pnfOrderLogic';
import type { Broker } from '@/hooks/useBrokerSelector';
import type { Market } from '@/lib/straddlePnfLive';
import type { PanelModel } from '@/lib/straddlePnfModel';

// The P&F AUTO engine for ONE chart (rules: lib/pnfAuto.ts; ledger: lib/pnfAutoLedger.ts; spec: strategies/pnf_auto/strategy.md).
// Runs from the open page, in the leader tab only, on a stable 1 s tick. Entries need AUTO armed on this chart (armed per page
// load, in the page's mode at arming); exits run for this chart's open row whatever the switch says. REAL orders are reserved
// in the ledger before they are sent and an unknown outcome is never resent: the chart halts and the user resolves it.

const TICK_MS = 1_000;
const LEDGER_POLL_MS = 3_000;
const MAX_REJECTS = 3;
/** A refused REAL exit is retried this often (the order route also holds a close cooldown). */
const EXIT_RETRY_MS = 10_000;

type Reply = { success?: boolean; error?: string; outcome?: string; legs?: LegResult[]; message?: string };
type LegInfo = { label: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null };

/** The shared ledger: polled, and replaced only by a newer `rev` so a slow poll never rolls back an op's reply. */
export function usePnfAutoLedger() {
  const [ledger, setLedger] = useState<AutoLedger>(EMPTY_LEDGER);
  const accept = useCallback((l: AutoLedger | undefined) => {
    if (l) setLedger(prev => (l.rev > prev.rev || prev.rev === 0 ? l : prev));
  }, []);
  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const j = await (await fetch('/api/straddle-pnf/auto')).json() as { ledger?: AutoLedger };
        if (!dead) accept(j.ledger);
      } catch { /* the next poll retries */ }
    };
    void read();
    const id = setInterval(read, LEDGER_POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [accept]);
  const post = useCallback(async (op: AutoOp): Promise<{ ok: boolean; error?: string; ledger?: AutoLedger }> => {
    try {
      const res = await fetch('/api/straddle-pnf/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
      const j = await res.json() as { success?: boolean; error?: string; ledger?: AutoLedger };
      accept(j.ledger);
      return { ok: Boolean(j.success), error: j.error, ledger: j.ledger };
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'Ledger unreachable' };
    }
  }, [accept]);
  return { ledger, post };
}

export type AutoEvent = { chart: 1 | 2; kind: 'entry' | 'exit' | 'halt' | 'info'; text: string; side?: 'BUY' | 'SELL'; price?: number; target?: Target; mode?: 'PAPER' | 'REAL'; lots?: number };

export interface AutoArm { on: boolean; mode: 'PAPER' | 'REAL'; watermarkT: number }

export function usePnfAuto({ chart, arm, lots, target, model, price, stale, market, complete, broker, mode, leaderRef, ledger, post, onEvent, onDisarm }: {
  chart: 1 | 2;
  arm: AutoArm;
  lots: number;
  target: Target;
  /** The chart's CLOSED-bar model (signals / columns never include the forming minute). */
  model: PanelModel;
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
}) {
  const [note, setNote] = useState<string>('');
  const [halt, setHalt] = useState<string | null>(null);
  const [info, setInfo] = useState<{ key: string; legs: LegInfo[]; unsupported: string | null } | null>(null);
  const busyRef = useRef(false);
  const haltRef = useRef<string | null>(null);
  const rejectsRef = useRef(0);
  const exitRetryAtRef = useRef(0);
  const watermarkRef = useRef(0);

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

  const haltNow = useCallback((why: string) => {
    haltRef.current = why;
    setHalt(why);
    onDisarm(why);
    onEvent({ chart, kind: 'halt', text: `AUTO C${chart} halted: ${why}` });
    void post({ op: 'log', chart, t: Date.now() / 1000, text: `halted: ${why}` });
  }, [chart, onDisarm, onEvent, post]);

  const sendOrder = async (body: Record<string, unknown>): Promise<Reply | null> => {
    try {
      const res = await fetch('/api/straddle-pnf/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'auto', ...body }) });
      return await res.json() as Reply;
    } catch { return null; }                                  // no clean reply: UNKNOWN, never a failure
  };

  /** `livePx`: the chart's price now; `box`: the confirmed box the signal bar reached (PAPER books it; REAL books the live price). */
  const enter = async (side: 'BUY' | 'SELL', signalT: number, livePx: number, box: number | null) => {
    const px = arm.mode === 'PAPER' && box !== null ? box : livePx;
    const cur = info && info.key === infoKey ? info : null;
    if (!cur || !cur.legs.length) { setNote('waiting for the contract lookup'); return; }
    if (arm.mode === 'REAL' && cur.unsupported) { haltNow(cur.unsupported); return; }
    const unitsPerPoint = (cur.legs[0].unitsPerLot ?? cur.legs[0].lot) * lots;
    const id = `pnfa-${chart}-${Date.now()}`;
    const nowS = Date.now() / 1000;
    const base = {
      id, day: istDateIso(Date.now()), chart, target, mode: arm.mode, broker, side, lots, unitsPerPoint,
      legs: cur.legs.map(l => ({ label: l.label, key: l.key, units: (l.lotUnits ?? l.lot) * lots })), entryT: nowS, entryBarT: signalT, entryPrice: px,
      ...(box !== null ? { entryBox: box } : {}),
    };
    if (arm.mode === 'PAPER') {
      const j = await sendOrder({ broker, mode: 'PAPER', target, action: side, lots, product: 'INTRADAY' });
      if (!j?.success) { setNote(`paper order refused: ${j?.error ?? 'no reply'}`); return; }
      const r = await post({ op: 'open', row: base });
      if (!r.ok) { setNote(`ledger refused: ${r.error}`); return; }
      onEvent({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [PAPER] ${side} ${lots}L @ ${px.toFixed(2)}` });
      return;
    }
    // REAL: reserve, send, then confirm / void / mark unknown.
    const reserved = await post({ op: 'open', row: { ...base, state: 'entering' } });
    if (!reserved.ok) { setNote(`ledger refused the entry: ${reserved.error}`); return; }
    const j = await sendOrder({ broker, mode: 'REAL', target, action: side, lots, product: 'INTRADAY' });
    if (!j || j.outcome === 'unknown') {
      await post({ op: 'markUnknown', id, note: j?.message ?? 'no reply from the order route' });
      haltNow('entry outcome unknown - check Orders/Positions, then resolve it');
      return;
    }
    if (j.outcome === 'placed') {
      const legs: AutoLeg[] = (j.legs ?? []).filter(l => l.status === 'placed').map((l, i) => ({ label: l.label, key: base.legs[i]?.key ?? null, units: l.qty }));
      const ok = await post({ op: 'confirmEntry', id, legs });
      if (!ok.ok) { haltNow(`order placed but the ledger refused it (${ok.error}) - check Positions`); return; }
      rejectsRef.current = 0;
      onEvent({ chart, kind: 'entry', side, price: px, target, mode: arm.mode, lots, text: `AUTO C${chart} [REAL] ${side} ${lots}L @ ~${px.toFixed(2)}` });
      return;
    }
    if (j.outcome === 'partial') {
      await post({ op: 'markUnknown', id, note: j.message ?? 'partial' });
      haltNow('only part of the straddle was placed - check Positions, then resolve it');
      return;
    }
    // rejected / reversed: nothing is open.
    await post({ op: 'voidEntry', id, t: Date.now() / 1000, note: j.message ?? j.error ?? 'refused' });
    rejectsRef.current += 1;
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} entry refused: ${j.message ?? j.error ?? ''}` });
    if (rejectsRef.current >= MAX_REJECTS) haltNow(`${MAX_REJECTS} entries in a row were refused`);
  };

  /** `barT`: the bar that triggered the exit (the reversal column's first bar), for the chart marker. */
  const exit = async (r: AutoRow, reason: string, px: number | null, barT?: number, box?: number | null) => {
    // PAPER books the confirmed box the reversal reached; REAL (and an EOD exit, which has no box) the live price. Only an EOD
    // exit can run without a price (E5): it books the entry price then.
    const exitPx = r.mode === 'PAPER' && box != null ? box : px ?? r.entryPrice;
    const boxField = box != null ? { exitBox: box } : {};
    const side = r.side === 'BUY' ? 'SELL' : 'BUY';
    if (r.mode === 'PAPER') {
      const c = await post({ op: 'close', id: r.id, exitT: Date.now() / 1000, exitPrice: exitPx, reason, exitBarT: barT, ...boxField });
      if (c.ok) onEvent({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [PAPER] exit (${reason}) @ ${exitPx.toFixed(2)}` });
      return;
    }
    if (Date.now() < exitRetryAtRef.current) return;
    const reserved = await post({ op: 'beginExit', id: r.id, t: Date.now() / 1000 });
    if (!reserved.ok) { setNote(`ledger refused the exit: ${reserved.error}`); return; }
    // The broker it was opened on and the units AUTO owns, never the Lots box or the page broker.
    const j = await sendOrder({ broker: r.broker, mode: 'REAL', target: r.target, exitOwn: { side, units: r.legs.map(l => l.units) } });
    if (!j || j.outcome === 'unknown' || j.outcome === 'partial') {
      await post({ op: 'markUnknown', id: r.id, note: j?.message ?? 'no reply from the order route' });
      haltNow('exit outcome unknown - check Orders/Positions, then resolve it');
      return;
    }
    if (j.outcome === 'placed' || j.outcome === 'flat') {
      const c = await post({ op: 'close', id: r.id, exitT: Date.now() / 1000, exitPrice: exitPx, reason, exitBarT: barT, ...boxField, note: j.outcome === 'flat' ? 'already flat at the broker' : undefined });
      if (!c.ok) { haltNow(`exit sent but the ledger refused it (${c.error})`); return; }
      onEvent({ chart, kind: 'exit', side, price: exitPx, target: r.target, mode: r.mode, lots: r.lots, text: `AUTO C${chart} [REAL] exit (${reason}) @ ~${exitPx.toFixed(2)}${j.outcome === 'flat' ? ' - already flat at the broker' : ''}` });
      return;
    }
    await post({ op: 'abortExit', id: r.id, note: j.message ?? j.error ?? 'exit refused' });
    exitRetryAtRef.current = Date.now() + EXIT_RETRY_MS;
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} exit refused, retrying: ${j.message ?? j.error ?? ''}` });
  };

  // E1: the tick is rebuilt every render and called through a ref from one stable interval.
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    tickRef.current = async () => {
      if (!leaderRef.current || busyRef.current) return;
      const nowS = Date.now() / 1000;
      if (row) {
        if (row.state !== 'open') { setNote(row.state === 'entering' || row.state === 'exiting' ? `${row.state}…` : 'unresolved - check the broker'); return; }
        if (row.targetKey !== tk) {
          // The chart was switched away from its position: only the EOD exit can still run (no model for that contract here).
          const d = decideAuto({ model: { box: 0, signals: [], columns: [], columnTimes: [], lastBarT: null }, position: { side: row.side, entryBarT: row.entryBarT }, watermarkT: 0, nowS, market });
          setNote('position on another contract: watching the EOD exit only');
          if (d.action === 'exit' && d.reason === 'eod') { busyRef.current = true; try { await exit(row, 'eod', null); } finally { busyRef.current = false; } }
          return;
        }
        const d = decideAuto({ model, position: { side: row.side, entryBarT: row.entryBarT }, watermarkT: watermarkRef.current, nowS, market });
        if (d.action !== 'exit') { setNote('holding'); return; }
        if (d.reason === 'reversal' && price === null) { setNote('reversal seen, waiting for a price'); return; }
        busyRef.current = true;
        const barT = d.reason === 'reversal' && d.col !== undefined ? model.columnTimes[d.col]?.start : undefined;
        try { await exit(row, d.reason, price, barT, d.boxPrice); } finally { busyRef.current = false; }
        return;
      }
      if (!arm.on || haltRef.current) return;
      if (arm.mode !== mode) { onDisarm(`the page switched to ${mode}`); return; }
      if (target.kind === 'index') { setNote('an index cannot be traded'); return; }
      if (!complete || stale || price === null) { setNote(stale ? 'feed stale: no entries' : 'waiting for a price'); return; }
      const d = decideAuto({ model, position: null, watermarkT: watermarkRef.current, nowS, market });
      if (d.action !== 'enter') { setNote(d.action === 'none' ? d.why : ''); return; }
      watermarkRef.current = d.signal.t;                       // handled: this signal is never entered again
      busyRef.current = true;
      try { await enter(d.side, d.signal.t, price, d.boxPrice); } finally { busyRef.current = false; }
    };
  });
  useEffect(() => {
    const id = setInterval(() => { void tickRef.current(); }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  const resolve = (as: 'open' | 'flat') => {
    if (!row) return;
    void post({ op: 'resolve', id: row.id, as, exitPrice: price ?? undefined, t: Date.now() / 1000 });
  };

  return { row, note, halt, resolve };
}
