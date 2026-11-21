'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePnfFeed } from '@/components/straddlePnf/usePnfFeed';
import { istMinuteOfDay } from '@/lib/istTime';
import { istDateIso } from '@/lib/nseHolidays';
import {
  alertSoundReady, installAlertSoundUnlock, playBearChime, playBullChime, playEntryChime, playExitChime, playNeutralChime, playWarnChime,
} from '@/lib/alertSound';
import { orbAlert, type OrbAlertSnap, type OrbSound } from '@/lib/signalOrbChime';
import type { Target } from '@/lib/pnfTarget';
import {
  ORB_CODE_VERSION, closedBars, computeEffectiveStop, decideOrb, evaluate, replay, rowPnl, sideOf,
  type EffectiveStopResult, type Evaluation, type ReplaySummary, type Side,
} from '@/lib/signalOrb';
import { isStuck, liveRow, realisedToday, type OrbLedger, type OrbRow } from '@/lib/signalOrbLedger';
import { keyLevels, mtfTable, signalChanges } from '@/lib/signalOrbPanels';

// The Signal Orb's live engine (browser). Leader tab only (localStorage lock); the tick is rebuilt every render and called through
// a ref from ONE interval, so quotes never restart it. It decides on closed bars (lib/signalOrb.ts) and asks the server to act
// (/api/signal-orb/trade); the server sizes, sends and books. Stale feed blocks entries, never exits; a missing price skips the stop
// but not the cutoff. REAL entries also need this page load's ARM click, which is never saved.

/** `contract` is always the FUTURE the signal reads; `optionLtp` is a live option row's premium (server WebSocket), else null. */
type StateReply = { success: boolean; ledger: OrbLedger; contract: Target | null; unitsPerLot: number; optionLtp?: number | null; today: string; codeVersion?: string };

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
/** 1-minute bars the replay reads: ~20 sessions (MCX 870 min each, NSE 375) plus indicator warm-up. */
const REPLAY_BARS_1M = 20_000;
export const REPLAY_SESSIONS = 20;

export type OrbEngine = ReturnType<typeof useOrbEngine>;

/** Sound switches, each in its own key (never shared with another page): trade chimes, and signal / warning alerts. */
const TRADE_SOUND_KEY = 'signalOrb.tradeSound';
const ALERT_SOUND_KEY = 'signalOrb.alertSound';
const readOn = (key: string) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const saveOn = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* best effort */ } };
const PLAY: Record<OrbSound, () => boolean> = { bull: playBullChime, bear: playBearChime, neutral: playNeutralChime, warn: playWarnChime };

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
  const peakSentAt = useRef(0);
  const bestPriceRef = useRef<{ id: string; price: number } | null>(null);
  // when the price last changed (a frozen feed keeps folding the same LTP into the open bar)
  const [priceAt, setPriceAt] = useState(0);
  const liftedRef = useRef<{ side: Side | null; lifted: boolean }>({ side: null, lifted: false });
  const staleWarned = useRef<string | null>(null);
  // sound: two switches (default on), read through refs so the 1 s tick never restarts when they change
  const [tradeSound, setTradeSoundState] = useState(true);
  const [alertSound, setAlertSoundState] = useState(true);
  const [soundReady, setSoundReady] = useState(false);
  const tradeSoundRef = useRef(true);
  const alertSoundRef = useRef(true);
  const prevSnap = useRef<OrbAlertSnap | null>(null);

  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    const t = setTimeout(() => {
      const a = readOn(TRADE_SOUND_KEY), b = readOn(ALERT_SOUND_KEY);
      tradeSoundRef.current = a; alertSoundRef.current = b;
      setTradeSoundState(a); setAlertSoundState(b);
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const setTradeSound = useCallback((on: boolean) => { tradeSoundRef.current = on; setTradeSoundState(on); saveOn(TRADE_SOUND_KEY, on); }, []);
  const setAlertSound = useCallback((on: boolean) => { alertSoundRef.current = on; setAlertSoundState(on); saveOn(ALERT_SOUND_KEY, on); }, []);
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
      // unchanged rev + contract keeps the same ledger/contract objects (so indicator memos don't recompute every poll),
      // but optionLtp and unitsPerLot always refresh — they change every tick independent of the ledger rev.
      setState(prev => {
        if (!prev) return j;
        const sameContract = JSON.stringify(prev.contract) === JSON.stringify(j.contract);
        if (j.ledger.rev === prev.ledger.rev && sameContract && prev.today === j.today) {
          // Ledger unchanged: keep heavy objects stable but always update live price fields
          if (prev.optionLtp === j.optionLtp && prev.unitsPerLot === j.unitsPerLot) return prev;
          return { ...prev, optionLtp: j.optionLtp, unitsPerLot: j.unitsPerLot };
        }
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

  // Context panels (information only, never read by the rules): the chosen indicators on every timeframe, the orb's recent colour
  // changes, and today's / yesterday's key levels. Recomputed when a minute closes or the history reloads, like the orb itself.
  const mtf = useMemo(
    () => (nowMinute && cfg ? mtfTable(cfg.indicators, bars.slice(0, lastClosed + 1), nowMinute * 60 + 1) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey, cfg?.indicators, nowMinute],
  );
  const history = useMemo(() => signalChanges(cfg?.indicators ?? [], closed, 10), [cfg?.indicators, closed]);
  const levels = useMemo(
    () => keyLevels(bars.slice(-6_000)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey, nowMinute],
  );

  // The same rules replayed over the recent sessions (lib/signalOrb.ts replay): recomputed when the history reloads or a rule
  // changes, not per tick. Reads the bars up to the newest history load, so today's closed bars are in it.
  const unitsPerLot = state?.unitsPerLot ?? 10;
  const hasClock = nowMinute > 0;
  const replayed: ReplaySummary | null = useMemo(() => {
    if (!cfg || !nowMinute) return null;
    return replay(cfg.indicators, closedBars(bars.slice(-REPLAY_BARS_1M), tf, nowMinute * 60 + 1),
      { times: cfg, stopPts: cfg.stopPts, trailStartPts: cfg.trailStartPts, trailGapPts: cfg.trailGapPts, lots: cfg.lots, unitsPerLot }, REPLAY_SESSIONS);
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
    if (!live || live.status !== 'open') {
      bestPriceRef.current = null;
    } else if (price !== null) {
      if (bestPriceRef.current?.id !== live.id) {
        // resume from the ledger's saved peak (a reload or a new leader tab must not forget it)
        const saved = live.bestPrice;
        bestPriceRef.current = { id: live.id, price: saved === undefined ? price : live.side === 'LONG' ? Math.max(saved, price) : Math.min(saved, price) };
      } else {
        bestPriceRef.current.price = live.side === 'LONG'
          ? Math.max(bestPriceRef.current.price, price)
          : Math.min(bestPriceRef.current.price, price);
      }
      // save a new peak (leader only, at most every 3 s; the server keeps only improvements)
      const peak = bestPriceRef.current.price;
      const t = Date.now();
      const better = live.bestPrice === undefined || (live.side === 'LONG' ? peak > live.bestPrice : peak < live.bestPrice);
      if (better && isLeader && t - peakSentAt.current >= 3_000) {
        peakSentAt.current = t;
        void op({ op: 'peak', id: live.id, price: peak });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, live?.id, live?.status, live?.side, live?.bestPrice, isLeader]);
  const priceFresh = price !== null && priceAt > 0 && now - priceAt < PRICE_STALE_MS && !feed.stale;

  const today = now ? istDateIso(now) : '';
  // the server runs newer code than this tab's bundle (a hot update that never arrived): reload before trading on it
  const outdated = !!state?.codeVersion && state.codeVersion !== ORB_CODE_VERSION;
  // the row's own mark: the future's LTP, or (options) the sold option's premium from the state poll
  const isOption = live?.target.kind === 'options';
  const mark = isOption ? (state?.optionLtp ?? null) : price;
  const openPnl = live?.status === 'open' && mark !== null && mark > 0 ? rowPnl(live, mark) : null;
  const realised = ledger && today ? realisedToday(ledger, ledger.mode, today) : 0;

  const trade = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await fetch('/api/signal-orb/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: OrbLedger };
      if (j.ledger) accept(j);
      // trade chimes ring in the tab that sent the order (the leader for automatic ones, this tab for a manual close)
      if (tradeSoundRef.current) { if (!j.success) playWarnChime(); else if (body.action === 'exit') playExitChime(); else playEntryChime(); }
      if (!j.success) setNote(j.error ?? 'Refused');
      return j.success;
    } catch (e) {
      // no reply: the server finishes and books what it sent; the next poll shows the row's real status
      if (tradeSoundRef.current) playWarnChime();
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

  /** One engine step (leader only). True when it sent an entry or a reversal this tick (that trade's chime speaks for the flip). */
  const step = (t: number): boolean => {
    if (!ledger || !cfg) return false;
    if (busyRef.current) return false;

    // stop-out block: lifts (in this tab) once the colour is anything but the stopped side; the server clears it on the next entry
    if (liftedRef.current.side !== ledger.blockedSide) liftedRef.current = { side: ledger.blockedSide, lifted: false };
    if (ledger.blockedSide && sideOf(ev.signal) !== ledger.blockedSide) liftedRef.current.lifted = true;
    const blockedSide = liftedRef.current.lifted ? null : ledger.blockedSide;

    if (live && live.status !== 'open') {
      setNote(live.status === 'unknown' || isStuck(live, t) ? 'Order outcome unknown - check the broker book and resolve the row' : `Position ${live.status.toUpperCase()} - waiting`);
      return false;
    }
    const staleDay = live && live.day !== today;
    if (staleDay && staleWarned.current !== live.id) {
      staleWarned.current = live.id;
      void op({ op: 'addLog', level: 'warn', msg: `Open row ${live.id} is from ${live.day}: not auto-managed. Check the broker, then Close or mark it.` });
    }
    // the stop is measured on the FUTURE the signal reads (an options row's own entry is its premium)
    const position = live && !staleDay ? {
      side: live.side,
      entry: live.signalEntry ?? live.entry,
      bestPrice: bestPriceRef.current?.price,
    } : null;
    const d = decideOrb({
      signal: ev.signal, barT: ev.barT, watermarkT: ledger.watermarkT, position, price: priceFresh ? price : null,
      minute: istMinuteOfDay(t), times: cfg, stopPts: cfg.stopPts, trailStartPts: cfg.trailStartPts, trailGapPts: cfg.trailGapPts, blockedSide,
    });

    // E11: realised + open P&L past the limit closes the position (the server then halts)
    if (position && openPnl !== null && realised + openPnl <= -cfg.dailyLossLimit && t >= exitRetryAt.current) {
      exitRetryAt.current = t + EXIT_RETRY_MS;
      void trade({ action: 'exit', price: price ?? live!.signalEntry ?? live!.entry, reason: `Daily loss limit ₹${cfg.dailyLossLimit}`, exitKind: 'manual', auto: true });
      return false;
    }
    if (d.action === 'exit') {
      if (t < exitRetryAt.current) return false;
      exitRetryAt.current = t + EXIT_RETRY_MS;
      // the cutoff exits without a quote: the ledger books the last price seen
      const px = price ?? live!.signalEntry ?? live!.entry;
      void trade({ action: 'exit', price: px, reason: d.reason, exitKind: d.kind, auto: true });
      return false;
    }
    if (d.action === 'none') { setNote(ledger.engineActive ? d.reason : 'Auto is OFF'); return false; }
    // entries / reversals
    if (!ledger.engineActive) { setNote(ledger.haltReason ? `Halted: ${ledger.haltReason}` : 'Auto is OFF'); return false; }
    if (outdated) { setNote('This tab runs an older version - reload it before new entries'); return false; }
    if (ledger.mode === 'REAL' && !armed) { setNote('REAL is not armed on this page load'); return false; }
    if (!priceFresh || price === null) { setNote('Price feed stale - no entries'); return false; }
    if (staleDay) { setNote('An earlier day\'s row is open - close it first'); return false; }
    if (realised <= -cfg.dailyLossLimit) { setNote('Daily loss limit reached'); return false; }
    setNote(d.reason);
    void trade({ action: d.action, side: d.side, price, barT: ev.barT, reason: d.reason, v: ORB_CODE_VERSION });
    return true;
  };
  const runEngine = () => {
    const t = Date.now();
    const leader = claimLock(t);
    if (leader !== isLeader) setIsLeader(leader);
    const ready = alertSoundReady();
    if (ready !== soundReady) setSoundReady(ready);
    if (!ledger || !cfg) return;
    let traded = false;
    if (leader) traded = step(t);
    else setNote('Another tab is running the engine');
    // Alerts: every tab keeps its snapshot current (a tab that becomes leader must not replay old changes); only the leader rings.
    const snap: OrbAlertSnap = {
      signal: ev.signal, barT: ev.barT, halt: ledger.haltReason, fresh: priceFresh, engineActive: ledger.engineActive,
      unresolved: !live ? null : live.status === 'unknown' ? `Row ${live.id} outcome UNKNOWN`
        : isStuck(live, t) ? `Row ${live.id} stuck in flight` : live.day !== today ? `Row ${live.id} is from ${live.day}` : null,
    };
    const alert = orbAlert(prevSnap.current, snap, traded);
    prevSnap.current = snap;
    if (alert && leader && alertSoundRef.current) PLAY[alert.sound]();
  };

  const engineRef = useRef<() => void>(() => {});
  useEffect(() => { engineRef.current = runEngine; });
  useEffect(() => {
    const id = setInterval(() => engineRef.current(), 1_000);
    return () => clearInterval(id);
  }, []);

  const closeAndStop = useCallback(async () => {
    await op({ op: 'setEngine', active: false });
    if (live?.status === 'open') await trade({ action: 'exit', price: price ?? live.signalEntry ?? live.entry, reason: 'Closed by user', exitKind: 'manual', auto: false });
  }, [op, trade, live, price]);

  const effectiveStop = useMemo((): EffectiveStopResult | null => {
    if (!live || live.status !== 'open' || !cfg) return null;
    const sigEntry = live.signalEntry ?? live.entry;
    return computeEffectiveStop({
      side: live.side,
      entry: sigEntry,
      stopPts: cfg.stopPts,
      trailStartPts: cfg.trailStartPts,
      trailGapPts: cfg.trailGapPts,
      bestPrice: bestPriceRef.current?.price,
      currentPrice: price,
    });
  }, [live, cfg, price]);

  return {
    state, ledger, live: live as OrbRow | null, contract, feed, ev, price, priceFresh, openPnl, mark, realised, now, isLeader, note, stateError,
    armed, setArmed, busy, op, closeAndStop, today, replayed, secsToClose, barSecs,
    tradeSound, setTradeSound, alertSound, setAlertSound, soundReady, outdated, effectiveStop, mtf, history, levels, tf,
  };
}
