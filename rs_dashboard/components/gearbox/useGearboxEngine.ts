'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePnfFeed } from '@/components/straddlePnf/usePnfFeed';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';
import { computeGearbox, ghostTrades, WARM_BARS, type GbBar, type GbState, type GhostTrade } from '@/lib/gearbox';
import { gbClosedBars, gbClosedKey, gbSession } from '@/lib/gearboxBars';
import { liveRow, realisedToday, type Dir, type GbConfig, type GbLedger, type GbMode, type GbRow } from '@/lib/gearboxLedger';
import type { McxSession } from '@/lib/mcxSession';
import type { Target } from '@/lib/pnfTarget';

// Gearbox Drive's browser engine. The server owns the ledger and every order (lib/gearboxCore.ts): this hook polls the state, builds
// the gearbox on CLOSED bars of the signal future, and names the action (open LONG / SHORT, reverse, exit). REAL entries need this
// page load's arm, keyed to mode + underlying + broker and never saved. The SL / target in premium points run here, in the leader tab
// only: they close nothing when the tab is closed (the server's square-off at the MCX auto-exit does run without it).

type Quote = { ltp: number; ageMs: number };
export type GbStateReply = {
  success: boolean; error?: string; ledger: GbLedger; future: Target | null; contracts: Record<Dir, Target | null>;
  contractErrors?: Record<Dir, string | null>;
  /** Option expiries after today for the underlying (the expiry picker's list). */
  expiries?: string[];
  prices: { future: Quote | null; contracts: Record<Dir, Quote | null>; rows: Record<string, Quote | null> };
  caps: { REAL: number; SIM: number }; unitsPerLot: number; today: string; session: McxSession;
};

const POLL_MS = 2_000;
/** A server quote older than this is not fresh (the server refuses an open on a future price older than 10 s). */
const QUOTE_FRESH_MS = 10_000;
const EXIT_RETRY_MS = 5_000;
/** 1-minute bars the gearbox reads (x timeframe): EMA200 warm-up plus a few sessions. */
const READ_BARS_1M = 1_500;
const CHIME_KEY = 'gearbox.shiftChime';

const readOn = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };   // muted by default
const saveOn = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* best effort */ } };

export type GearboxEngine = ReturnType<typeof useGearboxEngine>;

export function useGearboxEngine() {
  const [state, setState] = useState<GbStateReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const [armKey, setArmKey] = useState<string | null>(null);
  const [chime, setChimeState] = useState(false);
  const chimeRef = useRef(false);
  const inFlight = useRef(false);
  const pollInFlight = useRef(false);
  const seq = useRef(0);
  const exitRetryAt = useRef(0);
  const lastSignalT = useRef<number | null>(null);
  /** A poll whose ledger rev is LOWER than the one on screen, waiting for a second poll to confirm the file was reset. */
  const revDrop = useRef<{ rev: number; updatedAt: number } | null>(null);
  /** The ledger on screen, for the poll's rev check (read outside setState so the updater stays pure). */
  const shownLedger = useRef<GbLedger | null>(null);
  useEffect(() => { shownLedger.current = state?.ledger ?? null; }, [state]);
  const { isLeader, leaderRef } = useTabLeader('gearbox');

  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    const t = setTimeout(() => { const on = readOn(CHIME_KEY); chimeRef.current = on; setChimeState(on); }, 0);
    return () => clearTimeout(t);
  }, []);
  const setChime = useCallback((on: boolean) => { chimeRef.current = on; setChimeState(on); saveOn(CHIME_KEY, on); }, []);

  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);

  /** A reply's ledger replaces the one on screen only when it is newer (a slow poll never rolls back a trade's reply). */
  const acceptLedger = useCallback((l: GbLedger | undefined) => {
    if (!l) return;
    setState(prev => (prev && l.rev > prev.ledger.rev ? { ...prev, ledger: l } : prev));
  }, []);

  const load = useCallback(async () => {
    if (pollInFlight.current) return;   // one poll in flight
    pollInFlight.current = true;
    const id = ++seq.current;
    try {
      const r = await fetch('/api/gearbox/state', { cache: 'no-store' });
      const j = await r.json() as GbStateReply;
      if (id !== seq.current) return;
      if (!j.success) { setError(j.error ?? 'Gearbox state unavailable'); return; }
      // A lower rev is normally a slow poll racing a trade reply: keep the newer ledger. Two polls in a row reporting the same
      // lower rev + updatedAt mean the file itself went back (deleted / restored / reset): accept it then.
      const shown = shownLedger.current;
      let acceptDrop = false;
      if (shown && j.ledger.rev < shown.rev) {
        const d = revDrop.current;
        acceptDrop = !!d && d.rev === j.ledger.rev && d.updatedAt === j.ledger.updatedAt;
        revDrop.current = acceptDrop ? null : { rev: j.ledger.rev, updatedAt: j.ledger.updatedAt };
      } else revDrop.current = null;
      setState(prev => (prev && j.ledger.rev < prev.ledger.rev && !acceptDrop ? { ...j, ledger: prev.ledger } : j));
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : 'Gearbox state unavailable');
    } finally { pollInFlight.current = false; }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void load(); }, 0);
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load]);

  const ledger = state?.ledger ?? null;
  const cfg = ledger?.config ?? null;
  const mode: GbMode = ledger?.mode ?? 'SIM';
  const held: GbRow | null = ledger && cfg ? liveRow(ledger, cfg.underlying) : null;
  const heldQuote = held ? state?.prices.rows[held.id] ?? null : null;
  const heldLtp = heldQuote?.ltp ?? held?.lastLtp ?? null;
  const heldFresh = !!heldQuote && heldQuote.ageMs <= QUOTE_FRESH_MS;

  // ── the signal future and the gearbox on closed bars ───────────────────────────────────────────────
  const feed = usePnfFeed(state?.future ?? null, 0, now);
  const tf = cfg?.tf ?? 5;
  const nowS = Math.floor(now / 1000);
  const nowMinute = Math.floor(now / 60_000);
  const closedKey = gbClosedKey(feed.bars, tf, nowMinute * 60 + 1, feed.histVersion);
  const bars: GbBar[] = useMemo(
    () => (nowMinute ? gbClosedBars(feed.bars.slice(-READ_BARS_1M * tf), tf, nowMinute * 60 + 1) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey],
  );
  const states: GbState[] = useMemo(() => computeGearbox(bars, gbSession), [bars]);
  const ghost: GhostTrade[] = useMemo(() => ghostTrades(bars, states, gbSession), [bars, states]);
  const warming = bars.length < WARM_BARS;

  const lastBar = feed.bars[feed.bars.length - 1];
  const price = lastBar && lastBar.straddle > 0 ? lastBar.straddle : null;
  const futQuote = state?.prices.future ?? null;
  const feedFresh = !!state && !feed.stale && price !== null && !!futQuote && futQuote.ageMs <= QUOTE_FRESH_MS;

  // ── REAL arm: this page load only, for this mode + underlying + broker ───────────────────────────────
  const key = cfg ? `${mode}|${cfg.underlying}|${cfg.broker}` : '';
  const realArmed = mode === 'REAL' && !!key && armKey === key;
  const armReal = useCallback(() => {
    if (!cfg || mode !== 'REAL') return;
    if (!window.confirm(`Arm REAL MONEY for ${cfg.underlying}?\n\n↑ Long and ↓ Short will place live Dhan option orders (1 lot) until you disarm or reload the page.`)) return;
    setArmKey(key);
  }, [cfg, mode, key]);
  const disarm = useCallback(() => setArmKey(null), []);

  /** Why a new entry is refused here (null = allowed). Exits are never refused here. */
  const entryBlock: string | null = !state ? 'Loading…'
    : busy ? 'Sending…'
      : warming ? `Warming up: ${bars.length} / ${WARM_BARS} closed ${tf}-min bars`
        : mode === 'REAL' && !realArmed ? 'REAL is not armed on this page load'
          : !feedFresh ? 'Feed stale - no new entries'
            : null;

  const send = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (inFlight.current) return false;   // one order in flight (a click and a hotkey in one frame both pass a state check)
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await fetch('/api/gearbox/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: GbLedger; unknown?: boolean };
      acceptLedger(j.ledger);
      setError(j.success ? null : (j.error ?? 'Refused'));
      return j.success;
    } catch (e) {
      // no reply: the server finishes and books what it sent; the next poll shows the row's real status
      setError(`No reply from the trade route (${e instanceof Error ? e.message : 'network'}) - waiting for the ledger`);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
      void load();
    }
  }, [acceptLedger, load]);

  const open = useCallback(async (dir: Dir): Promise<void> => {
    if (!cfg || entryBlock || price === null || inFlight.current) return;   // never a confirm while an order is in flight
    if (held && held.status !== 'open') return;
    if (held?.dir === dir) return;
    const action = held ? 'reverse' : 'open';
    if (mode === 'REAL') {
      const c = state?.contracts[dir];
      const leg = cfg.map[dir];
      const what = `${action === 'reverse' ? `Reverse to ${dir}` : dir}: ${leg.action} ${cfg.lots} lot ${c ? `${c.symbol} ${c.strike} ${c.side}` : leg.opt}`;
      if (!window.confirm(`${what}?\n\nThis is a REAL order at your broker.`)) return;
    }
    await send({ action, dir, underlying: cfg.underlying, decisionPrice: price, reason: `Manual ${dir}`, mode, broker: cfg.broker });
  }, [cfg, entryBlock, price, held, mode, state, send]);

  const exitWith = useCallback(async (reason: string, confirmReal: boolean): Promise<void> => {
    if (!cfg || !held || held.status !== 'open' || inFlight.current) return;   // never a confirm while an order is in flight
    if (confirmReal && held.mode === 'REAL' && !window.confirm(`Exit ${held.dir} ${held.lots} lot ${held.target.symbol} ${held.target.strike} ${held.target.side}?\n\nThis is a REAL order at your broker.`)) return;
    await send({ action: 'exit', underlying: cfg.underlying, decisionPrice: price ?? held.entry, reason, mode, broker: cfg.broker });
  }, [cfg, held, price, mode, send]);
  const exit = useCallback(() => exitWith('Manual exit', true), [exitWith]);

  const op = useCallback(async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const r = await fetch('/api/gearbox/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { success: boolean; error?: string; ledger?: GbLedger };
      acceptLedger(j.ledger);
      const err = j.success ? null : (j.error ?? 'Refused');
      setError(err);
      return err;
    } catch (e) { const m = e instanceof Error ? e.message : 'Request failed'; setError(m); return m; }
  }, [acceptLedger]);
  const setConfig = useCallback(async (p: Partial<GbConfig>): Promise<void> => { await op({ op: 'setConfig', patch: p }); }, [op]);
  const setMode = useCallback(async (m: GbMode): Promise<void> => { setArmKey(null); await op({ op: 'setMode', mode: m }); }, [op]);
  const resolve = useCallback(async (id: string, as: 'open' | 'closed' | 'failed', px?: number) => {
    await op({ op: 'resolve', id, as, ...(px !== undefined ? { price: px } : {}) });
  }, [op]);

  // ── leader tab: SL / target in premium points, and the Shift-up chime ─────────────────────────────────
  const legPts = held && heldLtp !== null ? (held.leg.action === 'BUY' ? heldLtp - held.entry : held.entry - heldLtp) : null;
  const tickRef = useRef<() => void>(() => {});
  useEffect(() => {
    tickRef.current = () => {
      if (!leaderRef.current || !cfg) return;
      const s = states[states.length - 1];
      if (s && s.t !== lastSignalT.current) {
        // the first closed bar seen only records where we are: no chime for history
        if (lastSignalT.current !== null && s.signal && chimeRef.current) playAlertChime();
        lastSignalT.current = s.t;
      }
      if (!held || held.status !== 'open' || !heldFresh || legPts === null || inFlight.current) return;
      const t = Date.now();
      if (t < exitRetryAt.current) return;
      const why = cfg.slPts !== null && legPts <= -cfg.slPts ? `SL ${cfg.slPts} pts`
        : cfg.tgtPts !== null && legPts >= cfg.tgtPts ? `Target ${cfg.tgtPts} pts` : null;
      if (!why) return;
      exitRetryAt.current = t + EXIT_RETRY_MS;
      void exitWith(why, false);
    };
  });
  useEffect(() => {
    const id = setInterval(() => tickRef.current(), 1_000);
    return () => clearInterval(id);
  }, []);

  const day = state?.today ?? '';
  const realised = ledger && day ? realisedToday(ledger, mode, day) : 0;
  const heldPnl = held && heldLtp !== null ? legPts! * held.lots * held.unitsPerLot : null;

  return {
    state, ledger, config: cfg, mode, states, bars, ghost, feed, feedFresh, warming, held, heldLtp, heldFresh, heldPnl, realised,
    contracts: state?.contracts ?? { LONG: null, SHORT: null }, prices: state?.prices ?? null, session: state?.session ?? null,
    price, now, nowS, isLeader, realArmed, armReal, disarm, open, exit, setConfig, setMode, resolve, busy, error, setError,
    entryBlock, chime, setChime,
  };
}
