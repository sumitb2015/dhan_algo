'use client';

import { serverBrickDiffers } from '@/lib/pnfServerBrick';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trailLevel, trailOf } from '@/lib/pnfAuto';
import { EMPTY_LEDGER, isLive, type AutoLedger, type AutoLogEntry, type AutoOp } from '@/lib/pnfAutoLedger';
import { targetKey, type Target } from '@/lib/pnfTarget';
import type { PanelModel } from '@/lib/straddlePnfModel';
import { scopeQuery, type PnfScope } from '@/lib/pnfScope';
import { ChartEngine, type AutoArm, type AutoEvent, type AutoPyramid, type OrderReply } from '@/lib/pnfAutoChart';
import { readOrderPrice } from '@/lib/tradedPriceClient';
import type { EngineFile } from '@/lib/pnfAutoEngine';

type Heartbeat = { t: number; idle: boolean; pid: number; started?: boolean; ticks?: number; owner?: boolean; error?: string | null };

export type { AutoArm, AutoEvent, AutoPyramid };

// The page's side of P&F / Renko AUTO. AUTO itself runs on the dashboard SERVER (lib/pnfAutoEngine.ts), with or without this tab: the
// page arms and disarms it (ledger `setArm`, with the chart the server is to trade), shows what the engine says, and asks it for a
// manual or MTM-guard exit. Nothing here sends an order.

const LEDGER_POLL_MS = 3_000;
/** The engine writes its status every second: this old, it has stopped (the dashboard is down, or another process holds the lock). */
const ENGINE_QUIET_MS = 8_000;
const nowSec = () => Date.now() / 1000;

/**
 * The shared ledger and the server engine's status: polled, the ledger replaced only by a newer `rev` so a slow poll never rolls back an
 * op's reply. `onLog`: the engine's entry / exit / halt / info lines written since this page loaded, once each (the page toasts them).
 */
export function usePnfAutoLedger(scope: PnfScope = 'pnf', onLog?: (e: AutoLogEntry) => void) {
  const [ledger, setLedger] = useState<AutoLedger>(EMPTY_LEDGER);
  const [engine, setEngine] = useState<{ file: EngineFile | null; heartbeat: Heartbeat | null; skewMs: number } | null>(null);
  const accept = useCallback((l: AutoLedger | undefined) => {
    if (l) setLedger(prev => (l.rev > prev.rev || prev.rev === 0 ? l : prev));
  }, []);
  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/auto${scopeQuery(scope)}`)).json() as { ledger?: AutoLedger; engine?: EngineFile | null; heartbeat?: Heartbeat; serverNow?: number };
        if (dead) return;
        accept(j.ledger);
        // the server's clock against this one, so a skewed PC clock does not make a working engine look quiet
        setEngine({ file: j.engine ?? null, heartbeat: j.heartbeat ?? null, skewMs: typeof j.serverNow === 'number' ? j.serverNow - Date.now() : 0 });
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
  // The engine's lines since this page loaded (an older line was toasted, if at all, by the tab open then).
  const loadedAtRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const onLogRef = useRef(onLog);
  useEffect(() => { onLogRef.current = onLog; });
  useEffect(() => {
    if (!loadedAtRef.current) loadedAtRef.current = Date.now() / 1000 - 5;
    for (const e of ledger.log) {
      if (!e.kind || e.t < loadedAtRef.current) continue;
      const id = `${e.t}:${e.chart}:${e.text}`;
      if (seenRef.current.has(id)) continue;
      seenRef.current.add(id);
      onLogRef.current?.(e);
    }
  }, [ledger]);
  return { ledger, post, engine };
}

export type EngineStatus = ReturnType<typeof usePnfAutoLedger>['engine'];

/**
 * One chart's AUTO on the page: its open row, the server engine's status line / halt, whether the engine has gone quiet, the brick the
 * server sees when it differs from this page's chart, and the manual exit / resolve actions.
 */
export function usePnfAuto({ chart, target, model, price, ledger, engine, post, onEvent, onDisarm, scope = 'pnf', nowMs }: {
  chart: 1 | 2;
  target: Target;
  /** This page's CLOSED-bar model of the chart (for the trailing-SL line and the brick check). */
  model: PanelModel;
  /** The chart's live price (a straddle's CE + PE), or null: an unresolved row's "close at" price. */
  price: number | null;
  ledger: AutoLedger;
  engine: EngineStatus;
  post: (op: AutoOp) => Promise<{ ok: boolean; error?: string; ledger?: AutoLedger }>;
  onEvent: (e: AutoEvent) => void;
  /** The page's fallback exit switched this chart's AUTO off. */
  onDisarm: (why: string) => void;
  scope?: PnfScope;
  /** The page clock (ms), so the quiet check re-renders with it. */
  nowMs: number;
}) {
  const k = String(chart) as '1' | '2';
  const view = engine?.file?.charts[k];
  const row = ledger.rows.find(r => r.chart === chart && isLive(r));
  const tk = targetKey(target);
  // Quiet: the dashboard process serving this page has not ticked the engine lately (it is down, or another process holds the engine lock),
  // or it is working but its status file has stopped moving. An idle engine (nothing armed or open) writes no status: that is not quiet.
  const srvNow = nowMs + (engine?.skewMs ?? 0);
  const hb = engine?.heartbeat;
  const quiet = engine !== null && (!hb || srvNow - hb.t > ENGINE_QUIET_MS || (!hb.idle && (!engine.file || srvNow - engine.file.t > ENGINE_QUIET_MS)));
  // The server's newest brick against this page's, on the same contract: a mismatch seen on two polls in a row is shown (one poll can
  // fall between the two builds of the same brick).
  const lc = model.columns.length ? model.columns[model.columns.length - 1] : null;
  const sb = view?.lastBrick ?? null;
  const differs = !!sb && view?.targetKey === tk && !!lc
    && serverBrickDiffers(sb, { last: lc, n: model.columns.length, barT: model.columnTimes[model.columns.length - 1]?.start ?? 0, box: model.box });
  const [seenDiff, setSeenDiff] = useState(0);
  const lastSigRef = useRef('');
  useEffect(() => {
    const sig = engine?.file ? String(engine.file.t) : '';
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    setSeenDiff(n => (differs ? n + 1 : 0));
  }, [engine, differs]);
  const serverBrick = differs && seenDiff >= 2 && sb ? sb : null;

  const resolve = (as: 'open' | 'flat' | 'added' | 'notAdded') => {
    if (!row) return;
    void post({ op: 'resolve', id: row.id, as, exitPrice: price ?? undefined, t: nowSec() });
  };

  // The page's own exit, for when the server cannot exit the row (it does not run the engine, or has no fresh price for the row's
  // contract): the same reserved exit (lib/pnfAutoChart.ts exitNow: beginExit, the own-units order, close / markUnknown / abortExit), so
  // whoever takes the row's beginExit first owns it. Exits only: it never ticks.
  const postRef = useRef(post), onEventRef = useRef(onEvent), onDisarmRef = useRef(onDisarm);
  useEffect(() => { postRef.current = post; onEventRef.current = onEvent; onDisarmRef.current = onDisarm; });
  // The deps read the latest callbacks through refs, only when called (never during render).
  // eslint-disable-next-line react-hooks/refs
  const [pageExit] = useState(() => new ChartEngine(chart, {
    post: op => postRef.current(op),
    sendOrder: async body => (await (await fetch('/api/straddle-pnf/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'auto', scope, ...body }) })).json()) as OrderReply,
    readOrderPrice: (id, b) => readOrderPrice(id, b),
    event: e => onEventRef.current(e),
    disarm: why => onDisarmRef.current(why),
    nowMs: () => Date.now(),
    sleep: ms => new Promise(res => setTimeout(res, ms)),
    // an index chart's row exits its option: priced from the same bridge the page reads (null when it has no price yet)
    premium: async ids => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/live?ids=${ids}`)).json() as { success?: boolean; legs?: { quote: { ltp: number } | null }[] };
        const ltp = j.success ? j.legs?.[0]?.quote?.ltp : null;
        return ltp && ltp > 0 ? ltp : null;
      } catch { return null; }
    },
  }));

  /**
   * Manual (or MTM-guard) exit of the open row by the server engine, at its live price; it also switches AUTO off on this chart. When the
   * server cannot (see above), the page exits it at this chart's price, only when the chart shows the row's own contract.
   */
  const exitNow = async (why = 'manual'): Promise<boolean> => {
    if (!row || row.state !== 'open') return false;
    let j: { success?: boolean; error?: string; fallback?: boolean };
    try {
      const res = await fetch(`/api/straddle-pnf/auto/exit${scopeQuery(scope)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chart, why }) });
      j = await res.json() as typeof j;
      if (!j.success && !j.error) j.error = `HTTP ${res.status}`;
    } catch (e) {
      j = { success: false, error: (e as Error).message };
    }
    if (j.success) return true;
    if (j.fallback && row.targetKey === tk && price !== null) {
      onEvent({ chart, kind: 'info', text: `AUTO C${chart} exit (${why}): ${j.error} - this page is exiting it` });
      return pageExit.exitNow({ ledger, price }, why);
    }
    onEvent({ chart, kind: 'info', text: `AUTO C${chart} exit (${why}) not done: ${j.error}` });
    return false;
  };

  // The open row's trailing SL level now, for the position line: only for its own contract.
  const trailSl = row && row.state === 'open' && row.targetKey === tk ? trailLevel(model, { side: row.side, entryBarT: row.entryBarT, trail: trailOf(row) }) : null;
  const quietWhy = !hb ? 'no reply from the dashboard' : hb.error ? `engine error: ${hb.error}` : hb.started === false ? 'the engine was never started in this dashboard process' : !hb.ticks ? 'the engine has not ticked yet' : hb.owner === false && !hb.idle ? 'another dashboard process holds the engine lock' : 'the engine has stopped ticking';
  const note = quiet ? `SERVER ENGINE QUIET - AUTO is not trading: ${quietWhy}` : view?.note ?? '';
  return { row, note, halt: view?.halt ?? null, quiet, serverBrick, feedError: view?.feedError ?? null, resolve, exitNow, trailSl };
}
