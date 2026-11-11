'use client';

/**
 * Fresh Money board — live trading pieces. REAL MONEY (Dhan, MARKET, INTRADAY).
 *
 * - `useFreshMoneyTrades` polls /api/fresh-money/trade (fast while anything is open or in flight) and sends orders.
 *   Every reply is classified with lib/orderOutcome (placed / rejected / UNKNOWN); an UNKNOWN is never retried.
 * - `TradeBar` is the ARM switch (per page load, never persisted), the lots stepper (commit on blur) and the P&L.
 * - `TradeCell` sits beside the strike: B / S buttons, the running P&L chip and × to square off this page's position.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Minus, Plus, X, ShieldAlert, Loader2 } from 'lucide-react';
import { sendOrderRequest, UNKNOWN_ORDER_HINT } from '@/lib/orderOutcome';
import type { FreshMoneyTradeState } from '@/app/api/fresh-money/trade/route';
import type { FmBroker, FmPosition, OptType, TxnSide } from '@/lib/freshMoneyTrades';
import { BrokerPicker } from '@/components/BrokerPicker';
import type { ExitSpec, FmExit } from '@/lib/freshMoneyExits';
import { ExitSpecInput, exitLevelsText, exitNeedsLook } from './ExitInputs';

/** The header's target / stop-loss defaults, stamped onto each position an order opens. */
export interface ExitDefaultsUi { target: ExitSpec | null; sl: ExitSpec | null }

export const FM_BROKERS: readonly FmBroker[] = ['dhan', 'kotak', 'zerodha'];
export const brokerLabel = (b: FmBroker) => (b === 'kotak' ? 'Kotak' : b === 'zerodha' ? 'Zerodha' : 'Dhan');
/** In-flight lock key: one per broker + contract. */
export const lockKey = (b: FmBroker, underlying: string, strike: number, opt: string) => `${b}:${underlying}:${strike}:${opt}`;

const TRADE_URL = '/api/fresh-money/trade';
const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 10_000;

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70';

export function fmtRs(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '–';
  const r = Math.round(n);
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r).toLocaleString('en-IN')}`;
}

const pnlClass = (n: number | null) => (n === null ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-300');

const newKey = () => `fm-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random()}`}`;

export interface TradeApi {
  state: FreshMoneyTradeState | null;
  inflight: ReadonlySet<string>;
  order: (o: { broker: FmBroker; underlying: string; expiry: string; strike: number; opt: OptType; side: TxnSide; lots: number; exitDefaults: ExitDefaultsUi }) => void;
  close: (p: FmPosition) => void;
  /** Change or clear one position's target / stop-loss; resolves true when the server took it. */
  setExit: (key: string, target: ExitSpec | null, sl: ExitSpec | null) => Promise<boolean>;
}

export function useFreshMoneyTrades(): TradeApi {
  const [state, setState] = useState<FreshMoneyTradeState | null>(null);
  const [inflight, setInflight] = useState<ReadonlySet<string>>(new Set());
  const inflightRef = useRef(new Set<string>());
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetch(TRADE_URL, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as FreshMoneyTradeState;
      if (my === seq.current) setState(body);
    } catch { /* keep the last state; the next poll retries */ }
  }, []);

  // Poll fast while a position is open or an order is in flight, slowly otherwise.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = !!state && (state.positions.some(p => p.netQty !== 0 || p.busy) || inflight.size > 0);
  }, [state, inflight]);
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      if (!document.hidden) await refresh();
      if (alive) timer.current = setTimeout(loop, busyRef.current ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    loop();
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);

  const run = useCallback(async (lockKey: string, label: string, body: Record<string, unknown>) => {
    if (inflightRef.current.has(lockKey)) return; // synchronous double-click guard
    inflightRef.current.add(lockKey);
    setInflight(new Set(inflightRef.current));
    try {
      const { outcome, reply } = await sendOrderRequest(TRADE_URL, { ...body, idempotencyKey: newKey() });
      if (outcome.kind !== 'placed' && reply?.partial === true) {
        // Part of a sliced close went out: never word it as a plain "rejected".
        toast.warning(`${label}: PARTLY sent${outcome.kind === 'unknown' ? ' (rest UNKNOWN)' : ''}`, {
          description: `${outcome.error}${outcome.kind === 'unknown' ? ` ${UNKNOWN_ORDER_HINT}` : ''}`, duration: 20_000,
        });
      } else if (outcome.kind === 'placed') toast.success(`${label} sent`, { description: `MARKET · INTRADAY${typeof reply?.note === 'string' ? ` · ${reply.note}` : ''}` });
      else if (outcome.kind === 'unknown') toast.error(`${label}: status UNKNOWN`, { description: `${outcome.error} ${UNKNOWN_ORDER_HINT}`, duration: 20_000 });
      else toast.error(`${label} rejected`, { description: outcome.error, duration: 8_000 });
    } finally {
      inflightRef.current.delete(lockKey);
      setInflight(new Set(inflightRef.current));
      refresh();
    }
  }, [refresh]);

  const order: TradeApi['order'] = useCallback(o => {
    const label = `${o.side} ${o.lots} lot${o.lots === 1 ? '' : 's'} ${o.underlying} ${o.strike} ${o.opt} on ${brokerLabel(o.broker)}`;
    run(lockKey(o.broker, o.underlying, o.strike, o.opt), label, { action: 'order', ...o });
  }, [run]);

  const close: TradeApi['close'] = useCallback(p => {
    const label = `Close ${p.underlying} ${p.strike} ${p.opt} on ${brokerLabel(p.broker)}`;
    run(lockKey(p.broker, p.underlying, p.strike, p.opt), label, { action: 'close', key: p.key });
  }, [run]);

  const setExit: TradeApi['setExit'] = useCallback(async (key, target, sl) => {
    try {
      const res = await fetch(TRADE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setExit', key, target, sl }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (res.ok && j?.success) { toast.success(target || sl ? 'Target / SL saved' : 'Target / SL cleared'); return true; }
      toast.error('Target / SL not saved', { description: j?.error ?? `HTTP ${res.status}` });
      return false;
    } catch (e) {
      toast.error('Target / SL not saved', { description: String((e as Error).message ?? e) });
      return false;
    } finally {
      refresh();
    }
  }, [refresh]);

  return { state, inflight, order, close, setExit };
}

// ── ARM / lots / P&L bar ──────────────────────────────────────────────────────────────────────────────────────────

// Tints here are -600/NN on purpose: globals.css forces dark text inside any bg-red-500/NN or bg-emerald-500/NN element
// in the light theme, which would turn the armed button's white label and a short chip's profit rose.
export function TradeBar({
  underlying, armed, onArm, lots, onLots, maxLots, lotSize, mcxMult, tradable, blocked, positions,
  broker, onBroker, brokerReady, brokerSessions, exitDefaults, onExitDefaults, exitWatcher, hasExits,
}: {
  underlying: string;
  armed: boolean;
  onArm: (v: boolean) => void;
  lots: number;
  onLots: (n: number) => void;
  maxLots: number;
  lotSize: number | null;
  /** Barrels per lot on MCX (order quantity there is lots); null on NSE. */
  mcxMult: number | null;
  tradable: boolean;
  blocked: string | null;
  positions: FmPosition[];
  broker: FmBroker;
  onBroker: (b: FmBroker) => void;
  /** False until the saved broker has been read (the first render is always Dhan): no arming before that. */
  brokerReady: boolean;
  brokerSessions: Record<FmBroker, boolean> | null;
  exitDefaults: ExitDefaultsUi;
  onExitDefaults: (d: ExitDefaultsUi) => void;
  /** The server's exit watcher heartbeat; null = not known yet. */
  exitWatcher: { alive: boolean } | null;
  /** Any position (any underlying / broker) has a target / stop-loss record. */
  hasExits: boolean;
}) {
  const [draft, setDraft] = useState(String(lots));
  // Escape blurs the box; the blur must then NOT commit what was typed (the field still holds it at that moment).
  const cancelBlur = useRef(false);
  // A stepper click (or the restored preference) changes `lots` from outside: follow it.
  const [shownLots, setShownLots] = useState(lots);
  if (shownLots !== lots) { setShownLots(lots); setDraft(String(lots)); }
  const commit = (raw: string) => {
    const n = Math.min(maxLots, Math.max(1, parseInt(raw, 10) || 1));
    onLots(n);
    setDraft(String(n));
  };

  const totals = useMemo(() => {
    let realised: number | null = 0, open: number | null = 0, openCount = 0;
    for (const p of positions) {
      realised = realised === null || p.realised === null ? null : realised + p.realised;
      if (p.netQty !== 0) openCount++;
      open = open === null || p.unrealised === null ? null : open + p.unrealised;
    }
    return { realised, open, pnl: open === null || realised === null ? null : realised + open, openCount };
  }, [positions]);

  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 ${armed ? 'border-red-500/40 bg-red-600/10' : 'border-zinc-800 bg-zinc-950/40'}`}>
      {tradable && (
        <div className="flex items-center gap-1.5">
          <BrokerPicker<FmBroker> value={broker} onChange={onBroker} brokers={FM_BROKERS}
            disabled={!brokerReady} disabledReason="Loading the saved broker…" />
          {brokerSessions && !brokerSessions[broker] && (
            <span className="text-[11px] font-bold text-amber-300">{brokerLabel(broker)} not logged in</span>
          )}
        </div>
      )}
      {tradable ? (
        <button
          type="button"
          onClick={() => onArm(!armed)}
          disabled={!brokerReady}
          aria-pressed={armed}
          className={`${FOCUS} flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors ${
            armed
              ? 'border-red-500 bg-red-600 text-oncolor hover:bg-red-500'
              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-red-500/60 hover:text-red-300'}`}
        >
          <ShieldAlert className="h-3.5 w-3.5" />
          {armed ? `Live · real money · ${brokerLabel(broker)} — disarm` : `Arm live trading (${brokerLabel(broker)})`}
        </button>
      ) : (
        <span className="text-[11px] text-zinc-400">{underlying} board is watch-only (BSE contracts are not supported for trading here)</span>
      )}

      {tradable && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-400">Lots</span>
          <button type="button" aria-label="One lot fewer" onClick={() => onLots(Math.max(1, lots - 1))}
            className={`${FOCUS} flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white`}>
            <Minus className="h-3 w-3" />
          </button>
          <input
            aria-label="Lots per order"
            inputMode="numeric"
            value={draft}
            onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={e => { if (cancelBlur.current) { cancelBlur.current = false; return; } commit(e.currentTarget.value); }}
            onKeyDown={e => {
              if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
              if (e.key === 'Escape') { cancelBlur.current = true; setDraft(String(lots)); e.currentTarget.blur(); }
            }}
            className={`${FOCUS} h-6 w-12 rounded border border-zinc-700 bg-zinc-900 text-center text-[12px] font-bold tabular-nums text-white`}
          />
          <button type="button" aria-label="One lot more" onClick={() => onLots(Math.min(maxLots, lots + 1))}
            className={`${FOCUS} flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white`}>
            <Plus className="h-3 w-3" />
          </button>
          <span className="text-[11px] tabular-nums text-zinc-500">
            {mcxMult ? `= ${(lots * mcxMult).toLocaleString('en-IN')} bbl` : lotSize ? `= ${(lots * lotSize).toLocaleString('en-IN')} qty` : ''} · max {maxLots} · MARKET · MIS
          </span>
        </div>
      )}

      {tradable && (
        <div className="flex flex-wrap items-center gap-2" title="Stamped onto each position an order opens (adding lots keeps its levels). % of the fill price or premium points. Blank = off.">
          <ExitSpecInput label="Target" value={exitDefaults.target} onCommit={t => onExitDefaults({ ...exitDefaults, target: t })} />
          <ExitSpecInput label="SL" value={exitDefaults.sl} onCommit={v => onExitDefaults({ ...exitDefaults, sl: v })} />
        </div>
      )}
      {exitWatcher && (exitWatcher.alive ? (
        (hasExits || exitDefaults.target || exitDefaults.sl) && (
          <span className="flex items-center gap-1 text-[11px] text-zinc-400" title="The dashboard server checks every position's target / stop-loss every 2 s, with or without this tab">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />Exits: watching
          </span>
        )
      ) : hasExits && (
        <span role="alert" className="rounded border border-red-500/50 bg-red-600/15 px-1.5 py-0.5 text-[11px] font-bold text-red-300">
          Exits watcher STOPPED — levels are not being watched
        </span>
      ))}

      {blocked && tradable && <span className="text-[11px] text-amber-300">{blocked}</span>}

      <div className="ml-auto flex items-center gap-3 text-[12px] tabular-nums">
        <span className="text-zinc-400">Open <span className={`font-bold ${pnlClass(totals.open)}`}>{fmtRs(totals.open)}</span></span>
        <span className="text-zinc-400">Booked <span className={`font-bold ${pnlClass(totals.realised)}`}>{fmtRs(totals.realised)}</span></span>
        <span className="text-zinc-300">P&amp;L <span className={`text-[14px] font-bold ${pnlClass(totals.pnl)}`}>{fmtRs(totals.pnl)}</span></span>
      </div>
    </div>
  );
}

// ── per strike / side ─────────────────────────────────────────────────────────────────────────────────────────────

export function TradeCell({
  side, opt, strike, pos, showButtons, canOrder, canClose, busy, onBuy, onSell, onClose, armed, ltpSource, exit,
}: {
  side: 'put' | 'call';
  opt: OptType;
  strike: number;
  pos: FmPosition | undefined;
  showButtons: boolean;
  canOrder: boolean;
  canClose: boolean;
  busy: boolean;
  armed: boolean;
  /** Where the position's LTP came from: the WebSocket ('ws') or the REST fallback. */
  ltpSource?: 'ws' | 'rest';
  /** This position's target / stop-loss record, if any. */
  exit?: FmExit;
  onBuy: () => void;
  onSell: () => void;
  onClose: () => void;
}) {
  const held = pos && pos.netQty !== 0;
  const showChip = pos && (held || pos.realised !== 0);
  const unpriced = pos ? pos.realised === null || (held && pos.avgPrice === null) : false;
  const lotsHeld = pos && pos.lot > 0 ? Math.abs(pos.netQty) / pos.lot : 0;
  const title = pos
    ? `${held ? `${pos.netQty > 0 ? 'Long' : 'Short'} ${lotsHeld} lot${lotsHeld === 1 ? '' : 's'} @ ${pos.avgPrice?.toFixed(2) ?? 'price pending'} · LTP ${pos.ltp?.toFixed(2) ?? '–'}${pos.ltp != null && ltpSource ? (ltpSource === 'ws' ? ' (live)' : ' (REST)') : ''} · ` : ''}booked ${fmtRs(pos.realised)}${pos.realised === null ? ' (a fill price is still pending)' : ''}${pos.busy === 'unknown' ? ' · an order has UNKNOWN status' : ''}${exit ? ` · ${exitLevelsText(exit)}` : ''}`
    : '';

  const chip = showChip ? (
    <span title={title} className={`flex items-center gap-0.5 rounded px-1.5 text-[12px] font-bold tabular-nums leading-5 ${
      held ? (pos!.netQty > 0 ? 'bg-emerald-600/15' : 'bg-red-600/15') : 'bg-zinc-800'} ${pnlClass(pos!.pnl)}`}>
      {held && <span className="text-[9px] font-bold text-zinc-300">{pos!.netQty > 0 ? 'L' : 'S'}{lotsHeld}</span>}
      {fmtRs(pos!.pnl ?? (held ? null : pos!.realised))}
      {(pos!.busy === 'unknown' || unpriced) && <span className="text-amber-300">?</span>}
      {/* A dot, not text: the chip must fit its 150px trade column beside B / S and ×. Full levels are in the hover. */}
      {held && exit && (
        <span className={`ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${exitNeedsLook(exit) ? 'bg-amber-400' : 'bg-sky-400'}`}>
          <span className="sr-only">{exitNeedsLook(exit) ? 'exit needs a look' : 'target / stop-loss set'}</span>
        </span>
      )}
    </span>
  ) : null;

  const closeBtn = held && armed ? (
    <button type="button" onClick={onClose} disabled={busy || !!pos!.busy || !canClose} aria-label={`Close ${strike} ${opt} position`}
      title="Square off this page's position (MARKET)"
      className={`${FOCUS} flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-40`}>
      <X className="h-3.5 w-3.5" />
    </button>
  ) : null;

  const buttons = showButtons ? (
    <span className="flex items-center gap-1">
      {busy ? (
        // Same footprint as the two buttons, so the row does not jump while an order is in flight.
        <span className="flex h-5 w-[56px] items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-zinc-400" aria-label="Order in flight" /></span>
      ) : (
        <>
          <button type="button" onClick={onBuy} disabled={!canOrder} aria-label={`Buy ${strike} ${opt}`} title={`BUY ${strike} ${opt} at market`}
            className={`${FOCUS} h-5 w-[26px] rounded bg-emerald-600 text-[11px] font-bold leading-5 text-oncolor shadow-sm transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-30`}>B</button>
          <button type="button" onClick={onSell} disabled={!canOrder} aria-label={`Sell ${strike} ${opt}`} title={`SELL ${strike} ${opt} at market`}
            className={`${FOCUS} h-5 w-[26px] rounded bg-red-600 text-[11px] font-bold leading-5 text-oncolor shadow-sm transition-colors hover:bg-red-500 active:bg-red-700 disabled:cursor-not-allowed disabled:opacity-30`}>S</button>
        </>
      )}
    </span>
  ) : null;

  return side === 'put' ? (
    <span className="flex items-center justify-end gap-1 pr-1">{chip}{closeBtn}{buttons}</span>
  ) : (
    <span className="flex items-center justify-start gap-1 pl-1">{buttons}{closeBtn}{chip}</span>
  );
}

// ── open positions the board is not showing ───────────────────────────────────────────────────────────────────────

/** Positions this page holds that have no row on the current board (another underlying, a rolled expiry, or a strike
 *  that left the window): listed with their P&L and × so none can drop out of sight. */
export function OffBoardPositions({ positions, armed, inflight, canClose, onClose }: {
  positions: FmPosition[];
  armed: boolean;
  inflight: ReadonlySet<string>;
  canClose: (p: FmPosition) => boolean;
  onClose: (p: FmPosition) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-1.5 text-[11px]">
      <span className="text-zinc-400">Open, not on this board:</span>
      {positions.map(p => {
        const lots = p.lot > 0 ? Math.abs(p.netQty) / p.lot : 0;
        const busy = inflight.has(lockKey(p.broker, p.underlying, p.strike, p.opt));
        return (
          <span key={p.key} className="flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950/40 px-1.5 py-0.5 tabular-nums">
            <span className="rounded bg-zinc-800 px-1 text-[9px] font-bold uppercase text-zinc-300">{brokerLabel(p.broker)}</span>
            <span className="font-bold text-zinc-200">{p.underlying} {p.strike} {p.opt}</span>
            <span className="text-zinc-500">{p.expiry}</span>
            <span className="text-[10px] font-bold text-zinc-300">{p.netQty > 0 ? 'L' : 'S'}{lots}</span>
            <span className={`font-bold ${pnlClass(p.pnl)}`}>{fmtRs(p.pnl)}</span>
            {armed && (
              busy ? <Loader2 className="h-3 w-3 animate-spin text-zinc-400" aria-label="Order in flight" /> : (
                <button type="button" onClick={() => onClose(p)} disabled={!!p.busy || !canClose(p)}
                  aria-label={`Close ${p.underlying} ${p.strike} ${p.opt} position on ${brokerLabel(p.broker)}`} title="Square off this page's position (MARKET)"
                  className={`${FOCUS} flex h-4 w-4 items-center justify-center rounded text-zinc-400 hover:bg-zinc-700 hover:text-white disabled:opacity-40`}>
                  <X className="h-3 w-3" />
                </button>
              )
            )}
          </span>
        );
      })}
    </div>
  );
}
