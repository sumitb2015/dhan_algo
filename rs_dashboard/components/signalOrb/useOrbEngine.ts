'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePnfFeed } from '@/components/straddlePnf/usePnfFeed';
import { istMinuteOfDay } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import { installAlertSoundUnlock, playEntryChime, playExitChime, playWarnChime } from '@/lib/alertSound';
import type { Target } from '@/lib/pnfTarget';
import { closedBars, decideOrb, evaluate, positionPnl, replay, sideOf, type Evaluation, type ReplaySummary, type Side } from '@/lib/signalOrb';
import { isStuck, liveRow, realisedToday, type OrbLedger, type OrbRow } from '@/lib/signalOrbLedger';

// The Signal Orb's live engine (browser). Leader tab only (localStorage lock); the tick is rebuilt every render and called through
// a ref from ONE interval, so quotes never restart it. It decides on closed bars (lib/signalOrb.ts) and asks the server to act
// (/api/signal-orb/trade); the server sizes, sends and books. Stale feed blocks entries, never exits; a missing price skips the stop
// but not the cutoff. REAL entries also need this page load's ARM click, which is never saved.

type StateReply = { success: boolean; ledger: OrbLedger; contract: Target | null; unitsPerLot: number; maxLots: number; today: string };

const STATE_POLL_MS = 3_000;
const LOCK_KEY = 'signalOrb.engineLock';
const LOCK_TTL_MS = 5_000;
/** No new price for this long = no entries (MCX futures tick every second in session). */
const PRICE_STALE_MS = 30_000;
const EXIT_RETRY_MS = 5_000;
/**
 * 1-minute bars the indicators read (x timeframe). The feed holds every session the contract has traded (tens of thousands of
 * bars); the slowest default (Wilder RSI / StochRSI, EMA up to 400) has converged long before 3000 bars, and the tick stays cheap.
 */
const READ_BARS_1M = 3_000;
/** 1-minute bars the replay reads: ~20 MCX sessions (870 min each) plus indicator warm-up. */
const REPLAY_BARS_1M = 20_000;
export const REPLAY_SESSIONS = 20;

export type OrbEngine = ReturnType<typeof useOrbEngine>;

export function useOrbEngine() {
  const [state, setState] = useState<StateReply | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [isLeader, setIsLeader] = useState(false);
  const [note, setNote] = useState('Loading…');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewerId] = useState(() => `orb-${Math.random().toString(36).slice(2, 10)}`);
  const busyRef = useRef(false);
  const exitRetryAt = useRef(0);
  // when the price last changed (a frozen feed keeps folding the same LTP into the open bar)
  const [priceAt, setPriceAt] = useState(0);
  const liftedRef = useRef<{ side: Side | null; lifted: boolean }>({ side: null, lifted: false });
  const staleWarned = useRef<string | null>(null);

  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);

  // L3: only a newer rev replaces what is on screen (a slow poll never rolls back a mutation's reply)
  const accept = useCallback((j: Partial<StateReply> & { ledger?: OrbLedger }) => {
    if (!j.ledger) return;
    setState(prev => {
      if (prev && j.ledger!.rev <= prev.ledger.rev) return prev;
      return prev ? { ...prev, ...j, ledger: j.ledger! } as StateReply : (j.contract !== undefined ? j as StateReply : prev);
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/signal-orb/state', { cache: 'no-store' });
      const j = await r.json() as StateReply & { error?: string };
      if (!j.success) { setStateError(j.error ?? 'State unavailable'); return; }
      setStateError(null);
      // unchanged rev + contract keeps the same objects, so the indicator memos do not recompute every poll
      setState(prev => {
        if (!prev) return j;
        const sameContract = JSON.stringify(prev.contract) === JSON.stringify(j.contract);
        if (j.ledger.rev === prev.ledger.rev && sameContract && prev.today === j.today) return prev;
        if (j.ledger.rev < prev.ledger.rev) return sameContract ? prev : { ...prev, contract: j.contract };
        return j;
      });
    } catch (e) { setStateError(e instanceof Error ? e.message : 'State unavailable'); }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, STATE_POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load]);

  const op = useCallback(async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const r = await fetch('/api/signal-orb/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: OrbLedger };
      if (j.ledger) accept(j);
      return j.success ? null : (j.error ?? 'Refused');
    } catch (e) { return e instanceof Error ? e.message : 'Request failed'; }
  }, [accept]);

  const ledger = state?.ledger ?? null;
  const live = ledger ? liveRow(ledger) : null;
  const contract = state?.contract ?? null;
  const feed = usePnfFeed(contract, 0, now);
  const cfg = ledger?.config;

  const tf = cfg?.timeframe ?? 1;
  const nowMinute = Math.floor(now / 60_000);   // closed bars change once a minute, not every second
  // feed.bars changes every second (the live price is folded into the forming minute), but the CLOSED bars change only when a
  // minute closes or a history refresh revises them: the memo keys on those, so the indicators recompute about once a minute.
  const bars = feed.bars;
  let lastClosed = bars.length - 1;
  while (lastClosed >= 0 && bars[lastClosed].t + 60 > nowMinute * 60) lastClosed--;
  const closedKey = `${feed.histVersion}|${lastClosed}|${bars[lastClosed]?.t}|${bars[lastClosed]?.straddle}`;
  const closed = useMemo(
    () => (nowMinute ? closedBars(bars.slice(Math.max(0, lastClosed + 1 - READ_BARS_1M * tf), lastClosed + 1), tf, nowMinute * 60 + 1) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey, tf, nowMinute],
  );
  const ev: Evaluation = useMemo(() => evaluate(cfg?.indicators ?? [], closed), [cfg?.indicators, closed]);

  // The same rules replayed over the recent sessions (lib/signalOrb.ts replay): recomputed when the history reloads or a rule
  // changes, not per tick. Reads the bars up to the newest history load, so today's closed bars are in it.
  const unitsPerLot = state?.unitsPerLot ?? 10;
  const hasClock = nowMinute > 0;
  const replayed: ReplaySummary | null = useMemo(() => {
    if (!cfg || !nowMinute) return null;
    return replay(cfg.indicators, closedBars(bars.slice(-REPLAY_BARS_1M), tf, nowMinute * 60 + 1),
      { times: cfg, stopPts: cfg.stopPts, lots: cfg.lots, unitsPerLot }, REPLAY_SESSIONS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.histVersion, cfg, unitsPerLot, tf, hasClock]);

  const barSecs = tf * 60;
  // bars sit on the IST clock (lib/signalOrb.ts closedBars): an hourly bar closes on the IST hour, not the UTC one
  const secsToClose = now ? barSecs - ((Math.floor(now / 1000) + 19_800) % barSecs) : barSecs;

  const lastBar = feed.bars[feed.bars.length - 1];
  const price = lastBar && lastBar.straddle > 0 ? lastBar.straddle : null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (price !== null) setPriceAt(Date.now());
  }, [price]);
  const priceFresh = price !== null && priceAt > 0 && now - priceAt < PRICE_STALE_MS && !feed.stale;

  const today = now ? istDateIso(now) : '';
  const openPnl = live?.status === 'open' && price !== null ? positionPnl(live.side, live.entry, price, live.lots, live.unitsPerLot) : null;
  const realised = ledger && today ? realisedToday(ledger, ledger.mode, today) : 0;

  const trade = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fetch('/api/signal-orb/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: OrbLedger };
      if (j.ledger) accept(j);
      if (j.success) { if (body.action === 'exit') playExitChime(); else playEntryChime(); }
      else { playWarnChime(); setNote(j.error ?? 'Refused'); }
      return j.success;
    } catch (e) {
      // no reply: the server finishes and books what it sent; the next poll shows the row's real status
      playWarnChime();
      setNote(`No reply from the trade route (${e instanceof Error ? e.message : 'network'}) - waiting for the ledger`);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
      void load();
    }
  }, [accept, load]);

  // E2: one leader tab
  const claimLock = (t: number): boolean => {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      const cur = raw ? JSON.parse(raw) as { id?: string; at?: number } : null;
      if (!cur || cur.id === viewerId || t - (cur.at ?? 0) > LOCK_TTL_MS) {
        localStorage.setItem(LOCK_KEY, JSON.stringify({ id: viewerId, at: t }));
        return true;
      }
      return false;
    } catch { return true; }   // storage blocked: single-tab assumption
  };
  useEffect(() => () => {
    try { const raw = localStorage.getItem(LOCK_KEY); if (raw && (JSON.parse(raw) as { id?: string }).id === viewerId) localStorage.removeItem(LOCK_KEY); } catch { /* */ }
  }, [viewerId]);

  const runEngine = () => {
    const t = Date.now();
    const leader = claimLock(t);
    if (leader !== isLeader) setIsLeader(leader);
    if (!ledger || !cfg) return;
    if (!leader) { setNote('Another tab is running the engine'); return; }
    if (busyRef.current) return;

    // stop-out block: lifts (in this tab) once the colour is anything but the stopped side; the server clears it on the next entry
    if (liftedRef.current.side !== ledger.blockedSide) liftedRef.current = { side: ledger.blockedSide, lifted: false };
    if (ledger.blockedSide && sideOf(ev.signal) !== ledger.blockedSide) liftedRef.current.lifted = true;
    const blockedSide = liftedRef.current.lifted ? null : ledger.blockedSide;

    if (live && live.status !== 'open') {
      setNote(live.status === 'unknown' || isStuck(live, t) ? 'Order outcome unknown - check the broker book and resolve the row' : `Position ${live.status.toUpperCase()} - waiting`);
      return;
    }
    const staleDay = live && live.day !== today;
    if (staleDay && staleWarned.current !== live.id) {
      staleWarned.current = live.id;
      void op({ op: 'addLog', level: 'warn', msg: `Open row ${live.id} is from ${live.day}: not auto-managed. Check the broker, then Close or mark it.` });
    }
    const position = live && !staleDay ? { side: live.side, entry: live.entry } : null;
    const d = decideOrb({
      signal: ev.signal, barT: ev.barT, watermarkT: ledger.watermarkT, position, price: priceFresh ? price : null,
      minute: istMinuteOfDay(t), times: cfg, stopPts: cfg.stopPts, blockedSide,
    });

    // E11: realised + open P&L past the limit closes the position (the server then halts)
    if (position && openPnl !== null && realised + openPnl <= -cfg.dailyLossLimit && t >= exitRetryAt.current) {
      exitRetryAt.current = t + EXIT_RETRY_MS;
      void trade({ action: 'exit', price, reason: `Daily loss limit ₹${cfg.dailyLossLimit}`, exitKind: 'manual', auto: true });
      return;
    }
    if (d.action === 'exit') {
      if (t < exitRetryAt.current) return;
      exitRetryAt.current = t + EXIT_RETRY_MS;
      // the cutoff exits without a quote: the ledger books the last price seen
      const px = price ?? live!.entry;
      void trade({ action: 'exit', price: px, reason: d.reason, exitKind: d.kind, auto: true });
      return;
    }
    if (d.action === 'none') { setNote(ledger.engineActive ? d.reason : 'Auto is OFF'); return; }
    // entries / reversals
    if (!ledger.engineActive) { setNote(ledger.haltReason ? `Halted: ${ledger.haltReason}` : 'Auto is OFF'); return; }
    if (ledger.mode === 'REAL' && !armed) { setNote('REAL is not armed on this page load'); return; }
    if (!priceFresh || price === null) { setNote('Price feed stale - no entries'); return; }
    if (staleDay) { setNote('An earlier day\'s row is open - close it first'); return; }
    if (realised <= -cfg.dailyLossLimit) { setNote('Daily loss limit reached'); return; }
    setNote(d.reason);
    void trade({ action: d.action, side: d.side, price, barT: ev.barT, reason: d.reason });
  };
  const engineRef = useRef<() => void>(() => {});
  useEffect(() => { engineRef.current = runEngine; });
  useEffect(() => {
    const id = setInterval(() => engineRef.current(), 1_000);
    return () => clearInterval(id);
  }, []);

  const closeAndStop = useCallback(async () => {
    await op({ op: 'setEngine', active: false });
    if (live?.status === 'open') await trade({ action: 'exit', price: price ?? live.entry, reason: 'Closed by user', exitKind: 'manual', auto: false });
  }, [op, trade, live, price]);

  return {
    state, ledger, live: live as OrbRow | null, contract, feed, ev, price, priceFresh, openPnl, realised, now, isLeader, note, stateError,
    armed, setArmed, busy, op, closeAndStop, today, replayed, secsToClose, barSecs,
  };
}
