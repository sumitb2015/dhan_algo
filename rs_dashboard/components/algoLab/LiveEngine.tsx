'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';
import { recordTick, type LiveMinutes } from '@/lib/bearishStrikes';
import { fallbackLotSize } from '@/lib/multiLegFocus';
import type { Bar } from '@/lib/volumeProfile';
import { buildLiveCtx } from '@/lib/algoLab/liveCtx';
import { stepPosition } from '@/lib/algoLab/engineStep';
import { claimLeader, classifyOrderReply, exitMarks, releaseLeader, type KV, type OrderOutcome } from '@/lib/algoLab/liveGuards';
import { legOf, openPnlOf, REAL_BROKERS, type LedgerOp } from '@/lib/algoLab/ledger';
import { exitSideOf } from '@/lib/algoLab/risk';
import type { AlgoPosition, AlgoStateFile, AuditLogItem, Candidate, CtxOpen, GateResult, Json, StrategyDefinition } from '@/lib/algoLab/types';
import { BiasStrip, LogPanel, PositionsTable, ScannerTable } from './LivePanels';

const STALE_FEED_MS = 10_000;
const STALE_SPOT_MS = 3 * 60_000;
const ENTRY_COOLDOWN_MS = 30_000;
const REENTRY_LOCK_MS = 5 * 60_000; // same as the simulator's REENTRY_LOCK_MIN
const EXIT_RETRY_MS = 15_000;
const MAX_AUTO_REJECTS = 3;
const OPEN_PNL_WRITE_MS = 15_000;
const SEGMENT: Record<string, { dhan: string; kotak: string }> = {
  NIFTY: { dhan: 'NSE_FNO', kotak: 'nse_fo' },
  BANKNIFTY: { dhan: 'NSE_FNO', kotak: 'nse_fo' },
  SENSEX: { dhan: 'BSE_FNO', kotak: 'bse_fo' },
};

const clock = () => Date.now();
const newId = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const istHm = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16);
const storage = (): KV | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};
const keyOf = (p: AlgoPosition) => `${legOf(p).strike}${legOf(p).option}`;

async function postOrder(url: string, body: Record<string, unknown>): Promise<{ outcome: OrderOutcome; orderId?: string; error?: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => null);
    return classifyOrderReply(res.status, j);
  } catch (err) {
    return classifyOrderReply(null, { error: String((err as Error).message ?? err) });
  }
}

interface StrikeIds {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export function LiveEngine({
  def,
  state,
  mutate,
  broker,
  brokerLoaded,
  viewerId,
  onOpenRules,
  onChainLock,
  vixLtp,
  vixChangePct,
  vixPrevClose,
}: {
  def: StrategyDefinition;
  state: AlgoStateFile;
  mutate: (op: LedgerOp) => Promise<boolean>;
  broker: 'dhan' | 'kotak';
  brokerLoaded: boolean;
  viewerId: string;
  onOpenRules: () => void;
  /** Reports the expiry selector state to the header. */
  onChainLock: (info: { expiries: string[]; expiry: string; setExpiry: (e: string) => void; locked: boolean; feed: string }) => void;
  vixLtp?: number | null;
  vixChangePct?: number | null;
  vixPrevClose?: number | null;
}) {
  const underlying = def.underlyings[0];
  const config = state.config;
  const mode = state.mode;
  const positions = state.positions;
  const marks = useMemo(() => exitMarks(storage(), def.key), [def.key]);

  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => installAlertSoundUnlock(), []);

  const addLog = useCallback(
    (level: AuditLogItem['level'], message: string) => void mutate({ op: 'addLog', item: { id: newId('log'), at: clock(), level, message } }),
    [mutate],
  );

  // ── Expiries + chain pin ──
  const [expiries, setExpiries] = useState<string[]>([]);
  const [pickedExpiry, setExpiry] = useState('');
  useEffect(() => {
    if (!brokerLoaded) return;
    let dead = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !j.data?.length) return;
        setExpiries(j.data);
        setExpiry((prev) => (j.data!.includes(prev) ? prev : j.data![0]));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, broker, brokerLoaded]);

  const today = nowMs > 0 ? istDay(nowMs) : '';
  const openPositions = useMemo(() => positions.filter((p) => p.status === 'OPEN'), [positions]);
  const openToday = useMemo(() => openPositions.filter((p) => istDay(p.openedAt) === today), [openPositions, today]);
  // Stops are evaluated only on the chain on screen: while positions are open the page is pinned to their expiry.
  const expiry = openToday[0]?.expiry ?? pickedExpiry;
  const chainLocked = openToday.length > 0;
  const unwatched = openToday.filter((p) => p.expiry !== expiry);

  // ── Live options bridge + quotes ──
  const started = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expiry || !brokerLoaded) return;
    started.current.add(broker);
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 35, broker, viewer: viewerId }),
    }).catch(() => {});
  }, [underlying, expiry, broker, brokerLoaded, viewerId]);
  useEffect(() => {
    const s = started.current;
    return () => {
      for (const b of s) {
        fetch('/api/options/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', brokers: [b], underlying, viewer: viewerId }),
        }).catch(() => {});
      }
    };
  }, [underlying, viewerId]);

  const { liveQuotes: rawQuotes, bridgeStatus, transport } = useLiveOptionsWS(expiry, broker, [broker], underlying);
  const quotes = useMemo(() => {
    if (!rawQuotes) return null;
    if (rawQuotes.underlying && rawQuotes.underlying.toUpperCase() !== underlying) return null;
    if (rawQuotes.expiry && expiry && rawQuotes.expiry !== expiry) return null;
    return rawQuotes;
  }, [rawQuotes, underlying, expiry]);
  const tickMs = quotes?.updated_at ? Date.parse(quotes.updated_at) : 0;
  const feedAge = tickMs > 0 && nowMs > 0 ? (nowMs - tickMs) / 1000 : null;
  const feedStale = feedAge != null && feedAge * 1000 > STALE_FEED_MS;
  const feed = bridgeStatus.status !== 'RUNNING' ? `WS ${bridgeStatus.status}` : feedStale ? `WS STALE (${Math.round(feedAge ?? 0)}s)` : `LIVE · ${transport.toUpperCase()}`;

  useEffect(() => {
    onChainLock({ expiries, expiry, setExpiry, locked: chainLocked, feed });
  }, [expiries, expiry, chainLocked, feed, onChainLock]);

  // ── Lot size + contract ids (this broker / expiry only) ──
  const [lotSize, setLotSize] = useState(fallbackLotSize(underlying, broker));
  const [strikeIds, setStrikeIds] = useState<Record<string, StrikeIds>>({});
  const [lookupFor, setLookupFor] = useState('');
  const lookupKey = `${broker}|${underlying}|${expiry}`;
  const lotReady = lookupFor === lookupKey;
  useEffect(() => {
    if (!expiry || !brokerLoaded) return;
    let dead = false;
    fetch(`/api/scalper/${broker === 'kotak' ? 'kotak/' : ''}lookup?underlying=${underlying}&expiry=${expiry}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIds> } }) => {
        if (dead || !j.success || !j.data) return;
        if (j.data.strikes) setStrikeIds(j.data.strikes);
        if (typeof j.data.lotSize === 'number' && j.data.lotSize > 0) {
          setLotSize(j.data.lotSize);
          setLookupFor(`${broker}|${underlying}|${expiry}`);
        }
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, expiry, broker, brokerLoaded]);
  const idsOf = (strike: number) => strikeIds[String(strike)] ?? strikeIds[`${strike}.0`];

  // ── Bars: 1-minute backfill (previous session + today) per scanned / held contract, LTP-built minutes on top ──
  const liveMin = useRef<Map<string, LiveMinutes>>(new Map());
  const barsCache = useRef<Map<string, { minute: string; bars: Bar[] }>>(new Map());
  const spotLive = useRef<LiveMinutes>(new Map());
  useEffect(() => {
    liveMin.current = new Map();
    barsCache.current = new Map();
  }, [expiry]);

  const scanKey = useMemo(() => {
    if (!quotes?.strikes) return '';
    const strikes = Object.keys(quotes.strikes).map(Number).filter((s) => s > 0).sort((a, b) => a - b);
    if (!strikes.length) return '';
    const ref = quotes.atm || quotes.spot;
    const ai = strikes.reduce((b, s, i) => (Math.abs(s - ref) < Math.abs(strikes[b] - ref) ? i : b), 0);
    return strikes
      .slice(Math.max(0, ai - config.strikeWindow), ai + config.strikeWindow + 1)
      .flatMap((s) => [`${s}CE`, `${s}PE`])
      .join(',');
  }, [quotes, config.strikeWindow]);
  const heldKey = useMemo(
    () => openToday.filter((p) => p.expiry === expiry).map(keyOf).sort().join(','),
    [openToday, expiry],
  );

  useEffect(() => {
    if (!expiry || !scanKey) return;
    let dead = false;
    let busy = false;
    const minuteNow = () => new Date().toISOString().slice(0, 16);
    const cycle = async () => {
      if (busy || dead) return;
      busy = true;
      try {
        const want = [...new Set([...(heldKey ? heldKey.split(',') : []), ...scanKey.split(',')])];
        const stale = want.filter((k) => barsCache.current.get(k)?.minute !== minuteNow());
        for (let i = 0; i < stale.length && !dead; i += 10) {
          const chunk = stale.slice(i, i + 10);
          const j = (await (await fetch(`/api/bearish-strikes/bars?underlying=${underlying}&expiry=${expiry}&contracts=${chunk.join(',')}`)).json()) as {
            bars?: Record<string, Bar[]>;
            rateLimited?: boolean;
          };
          if (dead) return; // selection changed: these bars belong to the previous expiry
          for (const [k, b] of Object.entries(j.bars ?? {})) barsCache.current.set(k, { minute: minuteNow(), bars: b });
          if (j.rateLimited) break;
        }
      } catch {
        /* retry next cycle */
      } finally {
        busy = false;
      }
    };
    void cycle();
    const id = setInterval(cycle, 20_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [underlying, expiry, scanKey, heldKey]);

  const spotCloses = useRef<{ at: number; bars: [string, number][] }>({ at: 0, bars: [] });
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const j = (await (await fetch(`/api/algo-lab/spot?underlying=${underlying}`)).json()) as { success?: boolean; date?: string; bars?: [string, number][] };
        if (!dead && j.success && j.date === istDay(clock()) && Array.isArray(j.bars)) spotCloses.current = { at: clock(), bars: j.bars };
      } catch {
        /* keep the last; its age gates entries */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [underlying]);

  // ── Ledger-derived numbers (today, active mode) ──
  const ltpOf = useCallback(
    (p: AlgoPosition): number | null => {
      if (p.expiry !== expiry || !quotes) return null;
      const l = legOf(p);
      const row = quotes.strikes[String(l.strike)];
      const v = (l.option === 'CE' ? row?.ce : row?.pe)?.ltp;
      return typeof v === 'number' && v > 0 ? v : null;
    },
    [expiry, quotes],
  );
  const realizedToday = useMemo(
    () => positions.filter((p) => p.status === 'CLOSED' && p.mode === mode && p.closedAt != null && istDay(p.closedAt) === today).reduce((a, p) => a + p.realized, 0),
    [positions, mode, today],
  );
  const openPnlNow = useMemo(() => {
    let s = 0;
    for (const p of openToday) if (p.mode === mode) s += openPnlOf(p, ltpOf(p)) ?? 0;
    return s;
  }, [openToday, mode, ltpOf]);

  // ── Account-wide REAL loss cap across all Algo Lab strategies ──
  const [account, setAccount] = useState<{ total: number; limit: number; at: number } | null>(null);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const j = (await (await fetch('/api/algo-lab/account')).json()) as { success?: boolean; total?: number; limit?: number };
        if (!dead && j.success && typeof j.total === 'number' && typeof j.limit === 'number') setAccount({ total: j.total, limit: j.limit, at: clock() });
      } catch {
        /* the age check below pauses REAL entries */
      }
    };
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, []);

  // ── Halts ──
  const suppressed = useRef(false);
  const haltEngine = useCallback(
    (message: string) => {
      suppressed.current = true;
      void mutate({ op: 'setConfig', config: { engineActive: false } }).then((ok) => {
        if (!ok) toast.error('Could not save the engine stop', { description: 'Entries stay blocked in this tab.' });
      });
      addLog('ERROR', message);
      playAlertChime();
    },
    [mutate, addLog],
  );
  const toggleEngine = () => {
    const on = !config.engineActive;
    if (on) suppressed.current = false;
    void mutate({ op: 'setConfig', config: { engineActive: on } });
  };

  // ── Orders ──
  const sendOrder = useCallback(
    (pos: AlgoPosition, side: 'BUY' | 'SELL', px: number, opening: boolean) => {
      const l = legOf(pos);
      const seg = SEGMENT[pos.underlying] ?? SEGMENT.NIFTY;
      if (pos.broker === 'dhan') {
        if (!l.securityId) return Promise.resolve({ outcome: 'failed' as const, error: 'no security id' });
        return postOrder('/api/scalper/fast-order', {
          securityId: l.securityId,
          exchangeSegment: seg.dhan,
          quantity: l.qty,
          side,
          orderType: 'MARKET',
          price: px,
          productType: 'INTRADAY',
          idempotencyKey: `${opening ? 'entry' : 'exit'}_${pos.id}`,
          source: opening ? 'alab' : 'alx',
        });
      }
      if (pos.broker === 'kotak') {
        if (!l.symbol) return Promise.resolve({ outcome: 'failed' as const, error: 'no trading symbol' });
        return postOrder('/api/scalper/kotak/order', {
          tradingsymbol: l.symbol,
          exchange: seg.kotak,
          quantity: l.qty,
          side,
          orderType: 'MARKET',
          product: 'MIS',
          ...(opening ? { source: 'alab' } : {}),
        });
      }
      return Promise.resolve({ outcome: 'failed' as const, error: `no order route for ${pos.broker}` });
    },
    [],
  );

  const inFlight = useRef<Set<string>>(new Set());
  const closedIds = useRef<Set<string>>(new Set());
  const exitBlockedUntil = useRef<Map<string, number>>(new Map());
  const lastLtp = useRef<Map<string, number>>(new Map());
  const reentryLock = useRef<Map<string, number>>(new Map());
  const cooldown = useRef<Map<string, number>>(new Map());
  const lastPnlWrite = useRef<Map<string, number>>(new Map());
  const warned = useRef<Set<string>>(new Set());
  const entryBusy = useRef(false);
  const autoRejects = useRef(0);

  const executeExit = useCallback(
    async (pos: AlgoPosition, px: number, kind: string, reason: string, opts: { ledgerOnly?: boolean; resendUnknown?: boolean } = {}) => {
      if (inFlight.current.has(pos.id) || closedIds.current.has(pos.id)) return 'busy';
      const mark = marks.get(pos.id, clock());
      if (mark?.s === 'inflight') return 'busy';
      if (mark?.s === 'unknown' && !opts.ledgerOnly && !opts.resendUnknown) return 'unknown';
      inFlight.current.add(pos.id);
      try {
        if (pos.mode === 'REAL' && !opts.ledgerOnly && mark?.s !== 'exited') {
          marks.set(pos.id, 'inflight', clock());
          const r = await sendOrder(pos, exitSideOf(pos.side), px, false);
          if (r.outcome === 'failed') {
            marks.set(pos.id, null, clock());
            exitBlockedUntil.current.set(pos.id, clock() + EXIT_RETRY_MS);
            addLog('ERROR', `[REAL] Exit rejected for ${keyOf(pos)}: ${r.error ?? 'rejected'}. Retrying in 15 s.`);
            return 'failed';
          }
          if (r.outcome === 'unknown') {
            marks.set(pos.id, 'unknown', clock());
            haltEngine(`[REAL] EXIT STATUS UNKNOWN for ${keyOf(pos)} (${r.error ?? 'no confirmation'}). Engine halted; no exit will be resent. Check the order book, then use Close on the row.`);
            return 'unknown';
          }
          marks.set(pos.id, 'exited', clock());
        }
        const ok = await mutate({ op: 'close', id: pos.id, exitPrice: px, exitKind: kind, exitReason: reason, at: clock() });
        if (!ok) {
          exitBlockedUntil.current.set(pos.id, clock() + EXIT_RETRY_MS);
          return 'failed';
        }
        marks.set(pos.id, null, clock());
        closedIds.current.add(pos.id);
        reentryLock.current.set(`${pos.expiry}|${keyOf(pos)}`, clock() + REENTRY_LOCK_MS);
        addLog('TRADE', `[${pos.mode}] Closed ${keyOf(pos)} ${pos.side} @ ₹${px.toFixed(2)} · ${reason}`);
        playAlertChime();
        return 'closed';
      } finally {
        inFlight.current.delete(pos.id);
      }
    },
    [marks, sendOrder, mutate, addLog, haltEngine],
  );

  const openPosition = useCallback(
    async (cand: Candidate, tag: 'AUTO' | 'MANUAL') => {
      if (entryBusy.current) return;
      if (!lotReady) return void toast.error('Lot size / contract ids not loaded yet');
      if (!(cand.ltp > 0)) return void toast.error('No live price for this contract');
      if (mode === 'REAL' && !(REAL_BROKERS as readonly string[]).includes(broker)) return void toast.error('REAL orders: Dhan or Kotak only');
      const ids = idsOf(cand.strike);
      const securityId = cand.option === 'CE' ? ids?.ceId : ids?.peId;
      const symbol = cand.option === 'CE' ? ids?.ceSymbol : ids?.peSymbol;
      if (mode === 'REAL' && broker === 'dhan' && !securityId) return void toast.error(`No security id for ${cand.key}`);
      if (mode === 'REAL' && broker === 'kotak' && !symbol) return void toast.error(`No Kotak symbol for ${cand.key}`);
      const entry = cand.ltp;
      const plan = def.onEntry(cand, entry, config);
      const qty = config.lotsPerTrade * lotSize;
      const pos: AlgoPosition = {
        id: newId(def.key.slice(0, 6)),
        strategy: def.key,
        mode,
        broker,
        tag,
        underlying,
        expiry,
        side: def.side,
        legs: [{ strike: cand.strike, option: cand.option, side: def.side, qty, lotSize, securityId, symbol, entryPrice: entry }],
        initialStop: plan.stop,
        stop: plan.stop,
        best: entry,
        target: plan.target,
        state: plan.state ?? null,
        entryCols: cand.cols,
        status: 'OPEN',
        openedAt: clock(),
        realized: 0,
      };
      entryBusy.current = true;
      try {
        if (mode === 'REAL') {
          const r = await sendOrder(pos, def.side, entry, true);
          if (r.outcome === 'failed') {
            addLog('ERROR', `[REAL] Entry rejected for ${cand.key}: ${r.error ?? 'rejected'}`);
            toast.error(`Order rejected: ${r.error ?? 'rejected'}`);
            reentryLock.current.set(`${expiry}|${cand.key}`, clock() + REENTRY_LOCK_MS);
            if (tag === 'AUTO' && ++autoRejects.current >= MAX_AUTO_REJECTS) {
              haltEngine(`Engine halted after ${MAX_AUTO_REJECTS} rejected entries in a row. Fix the cause (session, margin, contract), then re-enable.`);
            }
            return;
          }
          if (r.outcome === 'unknown') {
            haltEngine(`[REAL] ENTRY STATUS UNKNOWN for ${cand.key} (${r.error ?? 'no confirmation'}). Engine halted: check the broker order book before re-enabling.`);
            return;
          }
          autoRejects.current = 0;
        }
        const ok = await mutate({ op: 'open', position: pos });
        if (ok) {
          addLog('TRADE', `[${mode}] ${tag} ${def.side} ${cand.key} x${qty} @ ₹${entry.toFixed(2)} · stop ₹${plan.stop}${plan.target != null ? ` · target ₹${plan.target}` : ''}`);
          playAlertChime();
        } else if (mode === 'REAL') {
          haltEngine(`[REAL] ORDER PLACED BUT NOT RECORDED: ${def.side} ${cand.key} x${qty}. Engine halted: close it at the broker.`);
        }
      } finally {
        entryBusy.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lotReady, mode, broker, def, config, lotSize, underlying, expiry, sendOrder, mutate, addLog, haltEngine, strikeIds],
  );

  // ── Engine tick (1 s): one stable interval calling the latest closure ──
  const [scan, setScan] = useState<{ chain: string; gate: GateResult | null; rows: Candidate[] }>({ chain: '', gate: null, rows: [] });
  const [isLeader, setIsLeader] = useState(true);
  const [engineNote, setEngineNote] = useState('');

  const runEngine = () => {
    if (!brokerLoaded || !expiry) return;
    const now = clock();
    const kv = storage();
    const leader = claimLeader(kv, def.key, viewerId, now);
    setIsLeader((p) => (p === leader ? p : leader));
    const dayNow = istDay(now);
    const hmNow = istHm();

    for (const id of [...closedIds.current]) if (!positions.some((p) => p.id === id && p.status === 'OPEN')) closedIds.current.delete(id);
    const live = openPositions.filter((p) => istDay(p.openedAt) === dayNow && !closedIds.current.has(p.id));
    for (const p of openPositions) {
      if (istDay(p.openedAt) !== dayNow && !warned.current.has(`old:${p.id}`)) {
        warned.current.add(`old:${p.id}`);
        if (leader) addLog('WARN', `Row ${keyOf(p)} (${p.mode}) is from ${istDay(p.openedAt)} and is not auto-managed. Verify at the broker, then close it.`);
      }
    }

    const q = quotes;
    if (q?.strikes) {
      const strikes = q.strikes;
      for (const k of scanKey ? scanKey.split(',') : []) {
        const row = strikes[k.slice(0, -2)];
        const ltp = (k.endsWith('CE') ? row?.ce : row?.pe)?.ltp;
        if (typeof ltp === 'number' && ltp > 0) {
          let lm = liveMin.current.get(k);
          if (!lm) liveMin.current.set(k, (lm = new Map()));
          recordTick(lm, ltp, now + 5.5 * 3600_000);
        }
      }
      for (const p of live) {
        const k = keyOf(p);
        const ltp = ltpOf(p);
        if (ltp != null && !(scanKey.split(',').includes(k))) {
          let lm = liveMin.current.get(k);
          if (!lm) liveMin.current.set(k, (lm = new Map()));
          recordTick(lm, ltp, now + 5.5 * 3600_000);
        }
      }
      if (q.spot > 0) recordTick(spotLive.current, q.spot, now + 5.5 * 3600_000);
    }

    const modeOpen: CtxOpen[] = live
      .filter((p) => p.mode === mode && p.expiry === expiry)
      .map((p) => ({ id: p.id, key: keyOf(p), option: legOf(p).option, side: p.side, entryPrice: legOf(p).entryPrice }));
    const ctx = q
      ? buildLiveCtx({
          nowMs: now,
          underlying,
          expiry,
          lotSize,
          spot: q.spot,
          strikes: q.strikes,
          strikeWindow: config.strikeWindow,
          open: modeOpen,
          apiBars: (k) => barsCache.current.get(k)?.bars,
          liveMinutes: (k) => liveMin.current.get(k),
          spotCloses: spotCloses.current.bars,
          spotLive: spotLive.current,
        })
      : null;

    let ranked: Candidate[] = [];
    let gate: GateResult | null = null;
    if (ctx) {
      gate = def.gate(ctx, config);
      const held = new Set(modeOpen.map((o) => o.key));
      ranked = def
        .scan(ctx, config, gate)
        .map((c) => {
          const until = reentryLock.current.get(`${expiry}|${c.key}`) ?? 0;
          if (held.has(c.key)) return { ...c, eligible: false, blockReason: 'Held' };
          return c.eligible && until > now ? { ...c, eligible: false, blockReason: `Re-entry lock (${Math.ceil((until - now) / 1000)}s)` } : c;
        })
        .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
      setScan({ chain: expiry, gate, rows: ranked });
    }

    if (!leader) return;

    // ── Risk: every live row on this chain, once a second ──
    const updates: { id: string; stop: number; best: number; state?: Json; openPnl?: number | null }[] = [];
    const eod = hmNow >= config.eodExit;
    for (const pos of live) {
      if ((exitBlockedUntil.current.get(pos.id) ?? 0) > now) continue;
      if (marks.get(pos.id, now)?.s === 'unknown') {
        if (!warned.current.has(`unk:${pos.id}`)) {
          warned.current.add(`unk:${pos.id}`);
          toast.error(`${keyOf(pos)}: exit status unknown`, { description: 'Not auto-managed until you resolve it with Close.' });
        }
        continue;
      }
      const ltp = ltpOf(pos);
      const prev = lastLtp.current.get(pos.id) ?? ltp;
      if (ltp != null) lastLtp.current.set(pos.id, ltp);
      if (eod) {
        // The cutoff exits even with no quote (MARKET order); it books the last price seen.
        void executeExit(pos, ltp ?? prev ?? legOf(pos).entryPrice, 'EOD', `EOD square-off at ${config.eodExit}`);
        continue;
      }
      if (ltp == null || !ctx) {
        if (!warned.current.has(`nq:${pos.id}`)) {
          warned.current.add(`nq:${pos.id}`);
          addLog('WARN', `No live quote for open ${keyOf(pos)} (${pos.expiry}): its stops are not being evaluated.`);
        }
        continue;
      }
      warned.current.delete(`nq:${pos.id}`);
      const l = legOf(pos);
      const r = stepPosition(
        def,
        { id: pos.id, key: keyOf(pos), strike: l.strike, option: l.option, side: pos.side, entryPrice: l.entryPrice, stop: pos.stop, initialStop: pos.initialStop, best: pos.best, target: pos.target, state: pos.state, openedAt: pos.openedAt },
        ltp,
        prev ?? ltp,
        ctx,
        config,
      );
      const pnl = openPnlOf(pos, ltp);
      const writePnl = now - (lastPnlWrite.current.get(pos.id) ?? 0) > OPEN_PNL_WRITE_MS;
      if (r.stop !== pos.stop || r.best !== pos.best || JSON.stringify(r.state) !== JSON.stringify(pos.state) || writePnl) {
        updates.push({ id: pos.id, stop: r.stop, best: r.best, state: r.state, ...(writePnl ? { openPnl: pnl } : {}) });
        if (writePnl) lastPnlWrite.current.set(pos.id, now);
      }
      if (r.exit) void executeExit(pos, ltp, r.exit.kind, r.exit.reason);
    }
    if (updates.length) void mutate({ op: 'updateRisk', updates });

    // ── Entries ──
    const block = (note: string) => setEngineNote((p) => (p === note ? p : note));
    if (!config.engineActive) return block('');
    if (suppressed.current) return block('Halted in this tab — turn the engine off and on to resume');
    if (mode === 'REAL' && !(REAL_BROKERS as readonly string[]).includes(broker)) return block('REAL entries are limited to Dhan and Kotak');
    if (!q || !ctx || !gate) return block('Waiting for the options feed');
    if (!lotReady) return block('Waiting for lot size / contract ids');
    const modeLive = live.filter((p) => p.mode === mode);
    if (modeLive.some((p) => marks.get(p.id, now)?.s === 'unknown')) return block('An exit has unknown status — resolve it first');
    let openPnl = 0;
    for (const p of modeLive) {
      const v = openPnlOf(p, ltpOf(p) ?? lastLtp.current.get(p.id) ?? null);
      if (v == null) return block(`Cannot price open ${keyOf(p)} — entries paused`);
      openPnl += v;
    }
    if (realizedToday + openPnl <= -config.dailyLossLimit) {
      if (!warned.current.has(`loss:${dayNow}`)) {
        warned.current.add(`loss:${dayNow}`);
        haltEngine(`Daily loss limit ₹${config.dailyLossLimit} reached (₹${(realizedToday + openPnl).toFixed(0)}): engine halted.`);
        if (config.hardCircuitBreaker !== false && modeLive.length > 0) {
          addLog('WARN', `HARD CIRCUIT BREAKER: Emergency square-off triggered for ${modeLive.length} open position(s).`);
          for (const pos of modeLive) {
            void executeExit(
              pos,
              ltpOf(pos) ?? lastLtp.current.get(pos.id) ?? legOf(pos).entryPrice,
              'RISK',
              `CIRCUIT BREAKER: Daily loss limit ₹${config.dailyLossLimit} hit`,
            );
          }
        }
      }
      return block('Daily loss limit reached');
    }
    if (mode === 'REAL') {
      if (!account || now - account.at > 60_000) return block('Account loss cap unknown — REAL entries paused');
      if (account.total <= -account.limit) return block(`Account loss cap ₹${account.limit} reached across Algo Lab — REAL entries paused`);
    }
    if (hmNow < config.entryStart || hmNow > config.entryEnd) return block('Outside the entry window');
    if (!Number.isFinite(tickMs) || now - tickMs > STALE_FEED_MS) return block('Options feed is stale — entries paused');
    if (!spotCloses.current.at || now - spotCloses.current.at > STALE_SPOT_MS) return block('Index bars are stale — entries paused');
    block('');
    if (entryBusy.current || modeLive.length >= config.maxConcurrent) return;
    const sideCount = (o: string) => modeLive.filter((p) => legOf(p).option === o).length;
    const pick = ranked.find((c) => {
      if (!c.eligible || !(c.ltp > 0) || sideCount(c.option) >= config.maxSameSide) return false;
      if ((reentryLock.current.get(`${expiry}|${c.key}`) ?? 0) > now) return false;
      return now - (cooldown.current.get(`${expiry}|${c.key}`) ?? 0) >= ENTRY_COOLDOWN_MS;
    });
    if (!pick) return;
    cooldown.current.set(`${expiry}|${pick.key}`, now);
    void openPosition(pick, 'AUTO');
  };

  const engineRef = useRef(runEngine);
  useEffect(() => {
    engineRef.current = runEngine;
  });
  useEffect(() => {
    const id = setInterval(() => engineRef.current(), 1000);
    return () => {
      clearInterval(id);
      releaseLeader(storage(), def.key, viewerId);
    };
  }, [def.key, viewerId]);

  // ── Manual actions ──
  const closeRow = (pos: AlgoPosition) => {
    const px = ltpOf(pos) ?? lastLtp.current.get(pos.id) ?? legOf(pos).entryPrice;
    const mark = marks.get(pos.id, clock());
    if (mark?.s === 'unknown') {
      if (confirm(`The last exit for ${keyOf(pos)} has UNKNOWN status — it may already have filled.\n\nCheck the broker order book.\n\nOK = it FILLED: close the ledger row WITHOUT sending another order.\nCancel = more options.`)) {
        void executeExit(pos, px, 'MANUAL', 'Manual close (exit confirmed filled at the broker)', { ledgerOnly: true });
      } else if (confirm(`Send a NEW exit order for ${keyOf(pos)}?\n\nOnly if the order book shows the earlier exit did NOT fill.`)) {
        void executeExit(pos, px, 'MANUAL', 'Manual close (new exit after an unknown one)', { resendUnknown: true });
      }
      return;
    }
    if (pos.expiry !== expiry && pos.mode === 'REAL' && !confirm(`${keyOf(pos)} is on ${pos.expiry}, not on screen: it will book the last price seen. Send the exit?`)) return;
    void executeExit(pos, px, 'MANUAL', 'Manual close');
  };
  const squareOffAll = () => {
    const rows = openToday.filter((p) => p.mode === mode);
    if (!rows.length || !confirm(`Close all ${rows.length} open ${mode} position(s) of ${def.label}?`)) return;
    for (const p of rows) void executeExit(p, ltpOf(p) ?? lastLtp.current.get(p.id) ?? legOf(p).entryPrice, 'MANUAL', 'Square off all');
  };
  const manualEntry = (c: Candidate) => {
    if (mode === 'REAL' && !confirm(`Place a REAL ${def.side} of ${config.lotsPerTrade} lot(s) ${c.key} at market?`)) return;
    void openPosition(c, 'MANUAL');
  };

  const rows = scan.chain === expiry ? scan.rows : [];
  return (
    <div className="flex flex-col gap-4">
      {unwatched.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-400">
          {unwatched.length} open position(s) are on another expiry ({unwatched.map((p) => `${p.expiry} ${keyOf(p)}`).join(', ')}): their stops are
          NOT being evaluated from this view.
        </div>
      )}
      {config.engineActive && (
        <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-400">
          <span className="font-bold">The engine runs in this browser tab only.</span> Keep it open and visible: stops are software-only (no resting
          broker stop).
          {!isLeader && <span className="ml-1 font-bold">Another tab is running this strategy; this tab is view-only.</span>}
          {engineNote && <span className="ml-1 font-bold">· {engineNote}</span>}
        </div>
      )}
      <BiasStrip
        def={def}
        gate={scan.chain === expiry ? scan.gate : null}
        engineActive={config.engineActive}
        mode={mode}
        openCount={openToday.filter((p) => p.mode === mode).length}
        realized={realizedToday}
        unrealized={openPnlNow}
        account={account}
        dailyLossLimit={Number(config.dailyLossLimit ?? 5000)}
        maxConcurrent={Number(config.maxConcurrent ?? 2)}
        maxSameSide={Number(config.maxSameSide ?? 1)}
        underlying={underlying}
        vixLtp={vixLtp}
        vixChangePct={vixChangePct}
        vixPrevClose={vixPrevClose}
        wsTransport={transport}
        wsStatus={bridgeStatus.status}
        wsStale={feedStale}
        onToggleEngine={toggleEngine}
        onSquareOff={squareOffAll}
        onOpenRules={onOpenRules}
      />
      <PositionsTable def={def} positions={positions} ltpOf={ltpOf} today={today} isUnknown={(id) => marks.get(id, nowMs || clock())?.s === 'unknown'} onClose={closeRow} />
      <ScannerTable def={def} rows={rows} atm={quotes?.atm ?? null} onEnter={manualEntry} />
      <LogPanel logs={state.logs} onClear={() => void mutate({ op: 'clearLogs' })} />
    </div>
  );
}
