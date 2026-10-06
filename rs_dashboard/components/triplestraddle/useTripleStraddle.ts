'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTabLeader } from '@/hooks/useTabLeader';
import {
  evaluateRisk, openPositionFor, pruneState, TS_PRICE_STALE_MS, TS_SLOTS, upsertPosition, validateTrade,
  type TsPosition, type TsProduct, type TsRisk, type TsSide, type TsSlot, type TsState,
} from '@/lib/tripleStraddle';
import {
  checkMarginGate, enterStraddle, exitStraddle, fetchChainLookup, fetchChainPrices, isTsTradable, saveTsPosition,
  type TsChainLookup, type TsLookup,
} from '@/lib/tripleStraddleClient';

export interface TsNotice { id: number; kind: 'error' | 'info' | 'success'; text: string }
export type PriceBook = Record<string, Record<string, { CE: number; PE: number }>>;

const PRICE_POLL_MS = 5000;
const CLOCK_MS = 2000;
const RISK_RETRY_MS = 15_000;
const LOOKUP_RETRY_MS = 3000;

/** State + actions for the page's trade bars. The ledger (TsState) is this page's own
 *  record of what it opened; it is never rebuilt from the broker position book. */
export function useTripleStraddle(args: {
  underlying: string;
  expiry: string;
  strikes: Record<TsSlot, number | null>;
}) {
  const { underlying, expiry, strikes } = args;
  const [ledger, setLedger] = useState<TsState>({ positions: [] });
  const [loaded, setLoaded] = useState(false);
  const [prices, setPrices] = useState<PriceBook>({});
  const [priceAt, setPriceAt] = useState<Record<string, number>>({});
  const [clock, setClock] = useState(0);
  const [chainLookup, setChainLookup] = useState<{ key: string; data: TsChainLookup } | null>(null);
  // REAL is armed per page load only, never persisted: every session starts in SIM.
  const [realArmed, setRealArmed] = useState(false);
  const [busy, setBusy] = useState<Record<TsSlot, string | null>>({ left: null, center: null, right: null });
  const [notices, setNotices] = useState<TsNotice[]>([]);
  // Only one tab per browser runs the automatic stop/target engine.
  const { isLeader, leaderRef } = useTabLeader('triple-straddle');

  const ledgerRef = useRef(ledger);
  const pricesRef = useRef({ prices, priceAt });
  const lockRef = useRef<Set<TsSlot>>(new Set());
  const lastRiskAttempt = useRef<Record<string, number>>({});
  const noticeSeq = useRef(0);

  useEffect(() => { pricesRef.current = { prices, priceAt }; }, [prices, priceAt]);

  const commit = useCallback((next: TsState) => { ledgerRef.current = next; setLedger(next); }, []);
  const notify = useCallback((kind: TsNotice['kind'], text: string) => {
    noticeSeq.current += 1;
    const id = noticeSeq.current;
    setNotices((n) => [...n.slice(-4), { id, kind, text }]);
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  // Clock drives staleness: a dead feed produces no state updates, so time must tick on its own.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  // ── load the ledger once ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/triple-straddle/state').then((r) => r.json()).then((j: { success: boolean; data?: TsState; error?: string }) => {
      if (cancelled) return;
      if (j.success && j.data) commit(pruneState(j.data));
      else notify('error', `Could not load your Triple Straddle positions: ${j.error ?? 'unknown error'}. Trading is disabled until this loads.`);
      setLoaded(!!j.success);
    }).catch((e) => { if (!cancelled) notify('error', `Ledger load failed: ${String(e)}`); });
    return () => { cancelled = true; };
  }, [commit, notify]);

  // ── prices: selected expiry + every expiry an open position is anchored to ──
  const priceKeys = useMemo(() => {
    const keys = new Set<string>();
    if (underlying && expiry) keys.add(`${underlying}|${expiry}`);
    for (const p of ledger.positions) if (p.status === 'OPEN') keys.add(`${p.underlying}|${p.expiry}`);
    return [...keys].sort();
  }, [underlying, expiry, ledger.positions]);
  const priceKeysSig = priceKeys.join(',');

  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const tick = async () => {
      const mine = ++seq;
      for (const key of priceKeysSig.split(',').filter(Boolean)) {
        const [u, e] = key.split('|');
        const chain = await fetchChainPrices(u, e);
        if (cancelled || mine !== seq || !chain) continue;
        setPrices((prev) => ({ ...prev, [key]: chain }));
        setPriceAt((prev) => ({ ...prev, [key]: Date.now() }));
      }
    };
    void tick();
    const id = setInterval(tick, PRICE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [priceKeysSig]);

  const isFresh = useCallback((key: string, now: number) => {
    const at = priceAt[key];
    return at != null && now - at <= TS_PRICE_STALE_MS;
  }, [priceAt]);

  /** Live CE/PE for a position. Empty when the price is stale: P&L shows "—" and stops pause,
   *  rather than acting on a frozen quote. */
  const livePrices = useCallback((p: { underlying: string; expiry: string; strike: number }): { CE?: number; PE?: number } => {
    const key = `${p.underlying}|${p.expiry}`;
    if (!isFresh(key, clock)) return {};
    const hit = prices[key]?.[String(p.strike)];
    return hit ? { CE: hit.CE || undefined, PE: hit.PE || undefined } : {};
  }, [prices, isFresh, clock]);

  const staleOpen = useMemo(
    () => clock > 0 && ledger.positions.some((p) => p.status === 'OPEN' && !isFresh(`${p.underlying}|${p.expiry}`, clock)),
    [ledger.positions, isFresh, clock],
  );
  const wasStale = useRef(false);
  useEffect(() => {
    if (staleOpen && !wasStale.current) notify('error', 'Option prices have stopped updating — stop-loss and target are PAUSED until the feed recovers.');
    if (!staleOpen && wasStale.current) notify('success', 'Option prices are updating again.');
    wasStale.current = staleOpen;
  }, [staleOpen, notify]);

  // ── lookup (lot size + strike -> security ids), one fetch per (underlying, expiry), retried ──
  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = `${underlying}|${expiry}`;
    const attempt = async () => {
      const r = await fetchChainLookup(underlying, expiry);
      if (cancelled) return;
      if (r) setChainLookup({ key, data: r });
      else timer = setTimeout(() => { void attempt(); }, LOOKUP_RETRY_MS);
    };
    void attempt();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [underlying, expiry]);

  const lookups = useMemo(() => {
    const out = { left: null, center: null, right: null } as Record<TsSlot, TsLookup | null>;
    if (!chainLookup || chainLookup.key !== `${underlying}|${expiry}`) return out;
    for (const slot of TS_SLOTS) {
      const k = strikes[slot];
      const ids = k != null ? chainLookup.data.strikes[String(k)] : undefined;
      out[slot] = ids ? { lotSize: chainLookup.data.lotSize, ids } : null;
    }
    return out;
  }, [chainLookup, underlying, expiry, strikes]);

  const persist = useCallback(async (pos: TsPosition): Promise<boolean> => {
    commit(upsertPosition(ledgerRef.current, pos));
    const ok = await saveTsPosition(pos);
    if (!ok) notify('error', `Saving the ${pos.slot} straddle failed. It is live — do not reload this page.`);
    return ok;
  }, [commit, notify]);

  // ── actions ───────────────────────────────────────────────────────
  const trade = useCallback(async (slot: TsSlot, side: TsSide, lots: number, product: TsProduct, risk: TsRisk) => {
    if (lockRef.current.has(slot)) return;           // synchronous: double-click safe
    lockRef.current.add(slot);
    setBusy((b) => ({ ...b, [slot]: 'Placing' }));
    try {
      const strike = strikes[slot];
      const lk = lookups[slot];
      const mode = realArmed ? 'REAL' : 'SIM';
      if (!loaded) return notify('error', 'Ledger not loaded — trading disabled');
      if (!isTsTradable(underlying)) return notify('error', `${underlying} is not tradable from this page`);
      if (strike == null || !expiry || !lk) return notify('error', 'Strike or contract ids not resolved yet');
      if (openPositionFor(ledgerRef.current, slot)) return notify('error', `The ${slot} straddle already has an open position`);
      const bad = validateTrade(lots, lk.lotSize);
      if (bad) return notify('error', bad);
      const key = `${underlying}|${expiry}`;
      const { prices: book, priceAt: at } = pricesRef.current;
      const px = book[key]?.[String(strike)];
      if (!px || !(px.CE > 0) || !(px.PE > 0)) return notify('error', 'No live price for both legs yet — try again in a moment');
      if (Date.now() - (at[key] ?? 0) > TS_PRICE_STALE_MS) return notify('error', 'Option prices are stale — not placing an order on an old quote');

      if (mode === 'REAL') {
        const gate = await checkMarginGate({ underlying, expiry, strike, side, lots, lotSize: lk.lotSize, ids: lk.ids, prices: px });
        if (!gate.ok) return notify('error', gate.message);
        const est = gate.estimate ? '\n(Margin is an ESTIMATE — broker calculator unavailable.)' : '';
        const ok = window.confirm(
          `REAL ORDER — ${side === 'S' ? 'SELL' : 'BUY'} ${lots} lot(s) ${underlying} ${strike} straddle (${expiry}), ${product}.\n`
          + `Qty ${lots * lk.lotSize} per leg. Margin ~₹${Math.round(gate.required ?? 0).toLocaleString('en-IN')}.${est}\nPlace it?`,
        );
        if (!ok) return;
      }

      const out = await enterStraddle({
        slot, underlying, expiry, strike, side, lots, lotSize: lk.lotSize, product, mode, ids: lk.ids, prices: px, risk,
        onIntent: persist,
      });
      for (const n of out.notes) notify('error', n);
      if (out.position) await persist(out.position);
      if (out.ok) notify('success', `${mode === 'SIM' ? 'SIM · ' : ''}${side === 'S' ? 'Sold' : 'Bought'} ${underlying} ${strike} straddle, ${lots} lot(s)`);
    } finally {
      lockRef.current.delete(slot);
      setBusy((b) => ({ ...b, [slot]: null }));
    }
  }, [strikes, lookups, realArmed, loaded, underlying, expiry, notify, persist]);

  const exit = useCallback(async (slot: TsSlot, reason: 'MANUAL' | 'SL' | 'TARGET' = 'MANUAL') => {
    if (lockRef.current.has(slot)) return;
    lockRef.current.add(slot);
    setBusy((b) => ({ ...b, [slot]: 'Exiting' }));
    try {
      // Read AFTER taking the lock so a concurrent write is never exited from a stale copy.
      const pos = openPositionFor(ledgerRef.current, slot);
      if (!pos) return;
      const key = `${pos.underlying}|${pos.expiry}`;
      const { prices: book, priceAt: at } = pricesRef.current;
      const fresh = Date.now() - (at[key] ?? 0) <= TS_PRICE_STALE_MS;
      const hit = fresh ? book[key]?.[String(pos.strike)] : undefined;
      const out = await exitStraddle(pos, hit ? { CE: hit.CE || undefined, PE: hit.PE || undefined } : {}, reason);
      for (const n of out.notes) notify('error', n);
      await persist(out.position);
      notify(out.ok ? 'success' : 'error', out.ok ? `Exited ${slot} straddle${reason !== 'MANUAL' ? ` (${reason})` : ''}` : `${slot} straddle exit incomplete — see notes`);
    } finally {
      lockRef.current.delete(slot);
      setBusy((b) => ({ ...b, [slot]: null }));
    }
  }, [notify, persist]);

  const exitAll = useCallback(async () => {
    for (const slot of TS_SLOTS) {
      if (openPositionFor(ledgerRef.current, slot)) await exit(slot, 'MANUAL');
    }
  }, [exit]);

  const setRisk = useCallback(async (slot: TsSlot, risk: TsRisk) => {
    const pos = openPositionFor(ledgerRef.current, slot);
    if (pos) await persist({ ...pos, risk });
  }, [persist]);

  /** The user has checked Orders/Positions themselves: adopt an unconfirmed leg as open, or
   *  discard it as not-open. This is the only way out of an unconfirmed state. */
  const resolveLeg = useCallback(async (slot: TsSlot, option: 'CE' | 'PE', action: 'adopt' | 'discard') => {
    const pos = openPositionFor(ledgerRef.current, slot);
    if (!pos) return;
    const legs = pos.legs.map((l) => {
      if (l.option !== option) return l;
      if (action === 'adopt') return { ...l, unconfirmed: false, pendingExit: undefined };
      return { ...l, unconfirmed: false, pendingExit: undefined, closed: true, exit: l.exit ?? l.entry };
    }) as TsPosition['legs'];
    const allClosed = legs.every((l) => l.closed);
    await persist({ ...pos, legs, ...(allClosed ? { status: 'CLOSED' as const, closedAt: Date.now(), exitReason: 'MANUAL' as const } : {}) });
  }, [persist]);

  // ── stop / target watcher (open tab only, leader tab only) ─────────
  // A stop is risk-reducing, so it also runs for REAL positions held from an earlier
  // session; the REAL arm gates only opening new REAL positions.
  useEffect(() => {
    if (!loaded || isLeader !== true) return;
    const now = Date.now();
    for (const p of ledger.positions) {
      if (p.status !== 'OPEN') continue;
      const hit = evaluateRisk(p, livePrices(p));
      if (!hit) continue;
      if (!leaderRef.current) return;
      if (now - (lastRiskAttempt.current[p.id] ?? 0) < RISK_RETRY_MS) continue;
      lastRiskAttempt.current[p.id] = now;
      notify('info', `${p.slot} straddle ${hit === 'SL' ? 'stop-loss' : 'target'} hit — exiting`);
      void exit(p.slot, hit);
    }
  }, [ledger.positions, livePrices, loaded, isLeader, leaderRef, exit, notify]);

  return {
    ledger, loaded, realArmed, setRealArmed, busy, notices, dismissNotice, isLeader, staleOpen,
    lookups, prices, livePrices, trade, exit, exitAll, setRisk, resolveLeg,
  };
}
