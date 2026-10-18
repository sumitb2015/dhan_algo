'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Target, ClipboardList, BookOpen } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { BrokerPicker, usePageBroker, type DhanKotak } from '@/components/BrokerPicker';
import { useLiveTickerPoll } from '@/lib/useLiveTickerPoll';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';
import { recordTick, mergeBars, type LiveMinutes } from '@/lib/bearishStrikes';
import { fallbackLotSize } from '@/lib/multiLegFocus';
import type { Bar } from '@/lib/volumeProfile';
import {
  evaluateOptionBreakdown,
  evaluateUnderlyingTrend,
  rankBreakdownSignals,
  evaluatePositionRisk,
  type CandidateSignal,
  type UnderlyingTrend,
} from '@/lib/breakdownScalper';
import {
  ALLOWED_UNDERLYINGS,
  DEFAULT_CONFIG,
  REAL_BROKERS,
  istDayOf,
  legPnl,
  type AuditLogItem,
  type BreakdownPosition,
  type BreakdownStateFile,
  type LedgerOp,
} from '@/lib/breakdownLedger';
import { MarketBiasStrip } from './breakdownScalper/MarketBiasStrip';
import { PositionsTable } from './breakdownScalper/PositionsTable';
import { ScannerGrid } from './breakdownScalper/ScannerGrid';
import { RulesConfigDrawer } from './breakdownScalper/RulesConfigDrawer';
import { AuditLogPanel } from './breakdownScalper/AuditLogPanel';
import BreakdownDocModal from './breakdownScalper/BreakdownDocModal';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';

const UNDERLYINGS = ALLOWED_UNDERLYINGS;
type Underlying = (typeof UNDERLYINGS)[number];

/** Dhan exchange segment per underlying (fast-order defaults to NSE_FNO, which is wrong for SENSEX). */
const EXCHANGE_SEGMENT: Record<Underlying, string> = {
  NIFTY: 'NSE_FNO',
  BANKNIFTY: 'NSE_FNO',
  SENSEX: 'BSE_FNO',
};

const STALE_FEED_MS = 10_000;
const STALE_TREND_MS = 45_000;
const ENTRY_COOLDOWN_MS = 30_000;
/** After an exit, the same contract is not re-shorted for this long (a stop-out is still "in breakdown"). */
const REENTRY_LOCK_MS = 5 * 60_000;
const EXIT_RETRY_MS = 15_000;
const ENGINE_LOCK_KEY = 'breakdownScalper.engineLock';
const MAX_AUTO_REJECTS = 3;

/**
 * Per-position exit state, shared by every tab through localStorage and kept across reloads:
 *  - 'inflight' an exit order is being sent right now (any tab); others must not send one. Expires after
 *               INFLIGHT_TTL_MS, longer than fast-order's worst case (10 s send + ~28 s correlationId reconcile).
 *  - 'exited'   the broker accepted the exit but the ledger close has not landed: retry only the ledger close.
 *  - 'unknown'  the exit's outcome is unknown and it may have filled. Never resent automatically; a person has to
 *               check the order book and choose (see confirmUnknownExit).
 * In-memory fallback when storage is blocked (single tab).
 */
type ExitMark = { s: 'inflight' | 'exited' | 'unknown'; at: number };
const EXIT_STATE_KEY = 'breakdownScalper.exitState';
const INFLIGHT_TTL_MS = 60_000;
const EXIT_MARK_MAX_AGE_MS = 24 * 3600_000;
const memExitState: Record<string, ExitMark> = {};

function readExitState(): Record<string, ExitMark> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXIT_STATE_KEY) ?? '{}') as Record<string, ExitMark>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return memExitState;
  }
}

function exitMark(id: string): ExitMark | null {
  const m = readExitState()[id];
  if (!m || typeof m.at !== 'number') return null;
  const age = Date.now() - m.at;
  if (age > EXIT_MARK_MAX_AGE_MS) return null;
  if (m.s === 'inflight' && age > INFLIGHT_TTL_MS) return null;
  return m;
}

function setExitMark(id: string, s: ExitMark['s'] | null): void {
  const all = { ...readExitState() };
  const cutoff = Date.now() - EXIT_MARK_MAX_AGE_MS;
  for (const [k, v] of Object.entries(all)) if (!v || v.at < cutoff) delete all[k];
  if (s) all[id] = { s, at: Date.now() };
  else delete all[id];
  try {
    localStorage.setItem(EXIT_STATE_KEY, JSON.stringify(all));
  } catch {
    for (const k of Object.keys(memExitState)) delete memExitState[k];
    Object.assign(memExitState, all);
  }
}
const ENGINE_LOCK_TTL_MS = 5_000;
const EMPTY_CANDIDATES: CandidateSignal[] = [];

/** Clock and id helpers live at module level: they run in event handlers and timers, never during render. */
const clock = () => Date.now();
const newId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const istDate = () => istDayOf(Date.now());
/** IST wall-clock HH:MM (same +5:30 shift as istDayOf). */
const istTime = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16);

/** Identity of a contract across underlyings and expiries (a bare "24500CE" is not unique). */
const contractId = (p: { underlying: string; expiry: string; strike: number; option: string }) =>
  `${p.underlying}|${p.expiry}|${p.strike}${p.option}`;

type OrderOutcome = 'ok' | 'failed' | 'unknown';

/** POST an order and classify the answer. A network error or 504 may still have booked: that is 'unknown', never 'failed'. */
async function postOrder(url: string, body: Record<string, unknown>): Promise<{ outcome: OrderOutcome; orderId?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => null)) as {
      success?: boolean;
      unknown?: boolean;
      error?: string;
      order_id?: string;
    } | null;
    if (j?.success) return { outcome: 'ok', orderId: j.order_id };
    if (j?.unknown || res.status === 504) return { outcome: 'unknown', error: j?.error };
    return { outcome: 'failed', error: j?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { outcome: 'unknown', error: String((err as Error).message ?? err) };
  }
}

interface HeaderIndices {
  updated_at?: string;
  quotes?: Record<string, { ltp?: number | null; prev_close?: number | null; change_pct?: number | null }>;
}

function pickIndexLtps(d: HeaderIndices): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ['NIFTY', 'VIX']) {
    const v = d?.quotes?.[k]?.ltp;
    if (typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

const INITIAL_TREND: UnderlyingTrend = {
  spot: 0,
  vwap: null,
  ema9: null,
  ema20: null,
  spread: null,
  trend: 'SIDEWAYS',
  eligibleSide: 'NONE',
  headline: 'Initializing',
  detail: 'Loading underlying market feed...',
};

/** Per-strike contract handles. Dhan's lookup returns numeric ids (ceId/peId); Kotak's returns trading symbols. */
interface StrikeIds {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

const kotakExchange = (u: string) => (u === 'SENSEX' ? 'bse_fo' : 'nse_fo');

export default function BreakdownScalper() {
  const [broker, setBroker, brokerLoaded] = usePageBroker('breakdownScalper.broker');
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('');
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isDocOpen, setIsDocOpen] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);

  // 1 Hz wall clock for render-time ages (clock() must not be called while rendering).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowMs(clock()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Live NIFTY & INDIA VIX ticker poll (/api/scalper/top-indices) ────────
  const { data: indicesData } = useLiveTickerPoll<HeaderIndices>('/api/scalper/top-indices', pickIndexLtps);
  const [prevCloseMap, setPrevCloseMap] = useState<{ NIFTY: number | null; VIX: number | null }>({
    NIFTY: null,
    VIX: null,
  });

  useEffect(() => {
    let dead = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const get = async (u: 'NIFTY' | 'VIX'): Promise<number | null> => {
        try {
          const j = (await (await fetch(`/api/scalper/nifty-prev-close?underlying=${u}`)).json()) as {
            success?: boolean;
            prevClose?: number;
          };
          return j.success && typeof j.prevClose === 'number' && j.prevClose > 0 ? j.prevClose : null;
        } catch {
          return null;
        }
      };
      const [n, v] = await Promise.all([get('NIFTY'), get('VIX')]);
      if (dead) return;
      setPrevCloseMap((p) => ({ NIFTY: n ?? p.NIFTY, VIX: v ?? p.VIX }));
      if ((n == null || v == null) && ++tries < 6) timer = setTimeout(load, 30_000 * tries);
    };
    timer = setTimeout(load, 0);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const vixQuote = indicesData?.quotes?.VIX;
  const vixLtp = vixQuote?.ltp && vixQuote.ltp > 0 ? vixQuote.ltp : null;
  const vixPrevClose = prevCloseMap.VIX ?? vixQuote?.prev_close ?? null;
  const vixChangePct =
    vixLtp != null && vixPrevClose != null && vixPrevClose > 0
      ? ((vixLtp - vixPrevClose) / vixPrevClose) * 100
      : vixQuote?.change_pct ?? null;

  // Broker Order Book, Tradebook & Positions state
  const [bookData, setBookData] = useState<{
    orders: Record<string, unknown>[];
    trades: Record<string, unknown>[];
    positions: Record<string, unknown>[];
  }>({ orders: [], trades: [], positions: [] });
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const bookSeq = useRef(0);

  const fetchBook = useCallback(async () => {
    if (!brokerLoaded) return;
    const seq = ++bookSeq.current;
    setBookLoading(true);
    setBookError(null);
    try {
      const res = await fetch(broker === 'kotak' ? '/api/scalper/kotak/poll' : '/api/scalper/poll');
      const j = (await res.json()) as {
        success: boolean;
        positions?: Record<string, unknown>[];
        orders?: Record<string, unknown>[];
        trades?: Record<string, unknown>[];
        positionsError?: string | null;
        error?: string;
      };
      if (seq !== bookSeq.current) return; // a newer poll (or a broker switch) superseded this one
      if (j.success) {
        setBookData((d) => ({
          orders: Array.isArray(j.orders) ? j.orders : d.orders,
          trades: Array.isArray(j.trades) ? j.trades : d.trades,
          positions: Array.isArray(j.positions) && !j.positionsError ? j.positions : d.positions,
        }));
      } else {
        setBookError(j.error || j.positionsError || 'Failed to fetch order book');
      }
    } catch (e) {
      if (seq === bookSeq.current) setBookError(String((e as Error).message));
    } finally {
      if (seq === bookSeq.current) setBookLoading(false);
    }
  }, [broker, brokerLoaded]);

  useEffect(() => {
    const t0 = setTimeout(fetchBook, 0);
    const id = setInterval(fetchBook, 5000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [fetchBook]);

  // State from server / ledger
  const [stateFile, setStateFile] = useState<BreakdownStateFile>({
    rev: 0,
    mode: 'SIM',
    config: DEFAULT_CONFIG,
    positions: [],
    logs: [],
    date: istDate(),
  });

  const config = stateFile.config;
  const mode = stateFile.mode;
  const positions = stateFile.positions;
  const logs = stateFile.logs;

  // Chime on exits (lib/alertSound: unlocked by the first click, throttled).
  useEffect(() => installAlertSoundUnlock(), []);

  // Viewer ID for shared WebSocket live options bridge
  const [viewerId] = useState(() => newId('bds'));

  // Start live indices bridge once on mount
  useEffect(() => {
    startLiveIndicesBridge();
  }, []);

  // Live minutes accumulator and 1-minute bars backfill: both belong to ONE underlying+expiry, so reset on change.
  const liveMinRef = useRef<Map<string, LiveMinutes>>(new Map());
  const barsCache = useRef<Map<string, { minute: string; bars: Bar[] }>>(new Map());
  useEffect(() => {
    liveMinRef.current = new Map();
    barsCache.current = new Map();
  }, [underlying, expiry]);

  // ── 1. Expiries ──────────────────────────────────────────────────
  useEffect(() => {
    if (!brokerLoaded) return;
    let dead = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !j.data?.length) return;
        const list = j.data;
        setExpiries(list);
        setExpiry((prev) => (list.includes(prev) ? prev : list[0]));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, broker, brokerLoaded]);

  // ── 2. Live Options WebSocket Bridge ─────────────────────────────
  const startedBridges = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expiry || !brokerLoaded) return;
    startedBridges.current.add(`${underlying}|${broker}`);
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        underlying,
        expiry,
        numStrikes: 35,
        broker,
        viewer: viewerId,
      }),
    }).catch(() => {});
  }, [underlying, expiry, broker, brokerLoaded, viewerId]);

  useEffect(() => {
    const started = startedBridges.current;
    return () => {
      for (const k of started) {
        const [u, b] = k.split('|');
        fetch('/api/options/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', brokers: [b], underlying: u, viewer: viewerId }),
        }).catch(() => {});
      }
    };
  }, [viewerId]);

  const { liveQuotes: rawQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, [broker], underlying);
  // Quotes of the underlying+expiry on screen only (the hook can still hold the previous selection for a moment).
  const liveQuotes = useMemo(() => {
    if (!rawQuotes) return null;
    if (rawQuotes.underlying && rawQuotes.underlying.toUpperCase() !== underlying) return null;
    if (rawQuotes.expiry && expiry && rawQuotes.expiry !== expiry) return null;
    return rawQuotes;
  }, [rawQuotes, underlying, expiry]);

  const lastTickTime = liveQuotes?.updated_at ? Date.parse(liveQuotes.updated_at) : 0;
  const feedAge = lastTickTime > 0 && nowMs > 0 ? Math.max(0, (nowMs - lastTickTime) / 1000) : null;
  const isWsStale = feedAge != null && feedAge > STALE_FEED_MS / 1000;

  // ── 3. Lot Size + security ids Lookup ────────────────────────────
  const [lotSize, setLotSize] = useState<number>(fallbackLotSize(underlying, broker));
  const [strikeIds, setStrikeIds] = useState<Record<string, StrikeIds>>({});
  const [lookupFor, setLookupFor] = useState('');
  const lookupKey = `${broker}|${underlying}|${expiry}`;
  // Ordering waits for THIS underlying/expiry/broker's own lookup: a fallback or a previous underlying's lot is never used.
  const lotReady = lookupFor === lookupKey;

  useEffect(() => {
    if (!expiry || !brokerLoaded) return;
    let dead = false;
    const key = `${broker}|${underlying}|${expiry}`;
    fetch(`/api/scalper/${broker === 'kotak' ? 'kotak/' : ''}lookup?underlying=${underlying}&expiry=${expiry}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIds> } }) => {
        if (dead || !j.success || !j.data) return;
        if (j.data.strikes) setStrikeIds(j.data.strikes);
        if (typeof j.data.lotSize === 'number' && j.data.lotSize > 0) {
          setLotSize(j.data.lotSize);
          setLookupFor(key);
        }
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, expiry, broker, brokerLoaded]);

  /** Strike (number) -> security ids; lookup keys may be "24500" or "24500.0". */
  const strikeIdMap = useMemo(() => {
    const m = new Map<number, StrikeIds>();
    for (const [k, v] of Object.entries(strikeIds)) m.set(Number(k), v);
    return m;
  }, [strikeIds]);

  const changeUnderlying = (u: Underlying) => {
    if (u === underlying || chainLocked) return;
    setUnderlying(u);
    // Everything below belongs to the previous underlying: never run the new one on the old expiry/lot/trend.
    setExpiry('');
    setExpiries([]);
    setLotSize(fallbackLotSize(u, broker));
    setStrikeIds({});
    setUnderlyingTrend(INITIAL_TREND);
    trendAtRef.current = 0;
  };

  // ── 4. Underlying Telemetry & Feed (Spot, VWAP, EMA9, EMA20) ──────
  const [underlyingTrend, setUnderlyingTrend] = useState<UnderlyingTrend>(INITIAL_TREND);
  const trendKeyRef = useRef('');
  const trendAtRef = useRef(0);
  /** Underlying the current trend was computed for: a trend of another underlying never gates an entry. */
  const trendForRef = useRef('');

  const fetchUnderlyingFeed = useCallback(async () => {
    const key = `${underlying}|${config.timeframe}|${expiry}|${config.trendMode}`;
    trendKeyRef.current = key;
    try {
      const q = new URLSearchParams({ symbol: underlying, interval: String(config.timeframe) });
      if (expiry) q.set('expiry', expiry);

      const res = await fetch(`/api/cyber-scalper/feed?${q.toString()}`);
      const json = await res.json();
      if (trendKeyRef.current !== key) return; // selection changed while this was in flight

      if (json.success && json.live) {
        const spot = json.spot || json.live.close || 0;
        const vwap = json.live.vwap || null;
        const ema9 = json.live.ema9 || null;
        const ema20 = json.live.ema20 || null;

        setUnderlyingTrend(evaluateUnderlyingTrend(spot, vwap, ema9, ema20, config.trendMode));
        trendAtRef.current = clock();
        trendForRef.current = underlying;
      }
    } catch {
      // Keep the last trend; its age is checked before any entry (STALE_TREND_MS).
    }
  }, [underlying, config.timeframe, config.trendMode, expiry]);

  useEffect(() => {
    const t0 = setTimeout(fetchUnderlyingFeed, 0);
    const id = setInterval(fetchUnderlyingFeed, 10_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [fetchUnderlyingFeed]);

  // ── 5. Ledger State Load & Mutations ──────────────────────────────
  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/breakdown-scalper/state');
      const j = await res.json();
      // Only a NEWER revision replaces local state: a slow poll must not roll back a mutation's answer.
      if (!j.success) return;
      setStateFile((prev) => (j.rev > prev.rev ? j : prev));
      // Pin the page to the chain of today's open positions: stops are evaluated only on the chain on screen, so a
      // reload (which starts on NIFTY) or another tab's entry must bring the view to where the positions are.
      const file = j as BreakdownStateFile;
      const today = istDayOf(clock());
      const pin = file.positions.find(
        (p) => p.status === 'OPEN' && istDayOf(p.openedAt) === today && (ALLOWED_UNDERLYINGS as readonly string[]).includes(p.underlying),
      );
      if (pin) {
        setUnderlying(pin.underlying as Underlying);
        setExpiry(pin.expiry);
      }
    } catch {
      // offline / retry next tick
    }
  }, []);

  useEffect(() => {
    const t0 = setTimeout(loadState, 0);
    const id = setInterval(loadState, 3_000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [loadState]);

  /** Apply a ledger op on the server. Resolves true only when the server accepted it. */
  const mutateLedger = useCallback(async (op: LedgerOp): Promise<boolean> => {
    try {
      const res = await fetch('/api/breakdown-scalper/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      });
      const j = await res.json();
      if (j.success) {
        setStateFile((prev) => (j.rev >= prev.rev ? j : prev));
        return true;
      }
      toast.error(j.error || 'Failed to update ledger');
      return false;
    } catch (err) {
      toast.error(String(err));
      return false;
    }
  }, []);

  const addAuditLog = useCallback(
    (level: AuditLogItem['level'], message: string) => {
      const item: AuditLogItem = {
        id: newId('log'),
        at: clock(),
        level,
        message,
      };
      void mutateLedger({ op: 'addLog', item });
    },
    [mutateLedger],
  );

  // ── 6. 1-Minute Bars Backfill for Scanned Strikes ─────────────────
  // The scanned set is a STRING key so it only changes when the strike list does, not on every tick
  // (ticks arrive at 20-40 Hz; re-running the effects per tick restarted their timers and re-fetched).
  const scanKey = useMemo(() => {
    const q = liveQuotes;
    if (!q || !q.strikes) return '';
    const spot = q.spot || 0;
    const atm = q.atm || spot;
    const strikes = Object.keys(q.strikes)
      .map(Number)
      .filter((s) => Number.isFinite(s) && s > 0)
      .sort((a, b) => a - b);
    if (!strikes.length) return '';

    const atmIdx = strikes.reduce(
      (bestIdx, s, idx) => (Math.abs(s - atm) < Math.abs(strikes[bestIdx] - atm) ? idx : bestIdx),
      0,
    );
    const minIdx = Math.max(0, atmIdx - config.strikeWindow);
    const maxIdx = Math.min(strikes.length - 1, atmIdx + config.strikeWindow);
    return strikes
      .slice(minIdx, maxIdx + 1)
      .flatMap((s) => [`${s}CE`, `${s}PE`])
      .join(',');
  }, [liveQuotes, config.strikeWindow]);

  const scannedContracts = useMemo(
    () =>
      scanKey
        ? scanKey.split(',').map((k) => ({
            strike: Number(k.slice(0, -2)),
            option: (k.endsWith('CE') ? 'CE' : 'PE') as 'CE' | 'PE',
            key: k,
          }))
        : [],
    [scanKey],
  );

  // Open positions that are on the chain currently on screen (the only ones with a live quote here).
  const heldViewKey = useMemo(
    () =>
      positions
        .filter((p) => p.status === 'OPEN' && p.underlying === underlying && p.expiry === expiry)
        .map((p) => `${p.strike}${p.option}`)
        .sort()
        .join(','),
    [positions, underlying, expiry],
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
        const want = [...new Set([...(heldViewKey ? heldViewKey.split(',') : []), ...scanKey.split(',')])];
        const stale = want.filter((k) => barsCache.current.get(k)?.minute !== minuteNow());

        for (let i = 0; i < stale.length && !dead; i += 10) {
          const chunk = stale.slice(i, i + 10);
          const res = await fetch(
            `/api/bearish-strikes/bars?underlying=${underlying}&expiry=${expiry}&contracts=${chunk.join(',')}`,
          );
          const j = (await res.json()) as {
            success: boolean;
            bars?: Record<string, Bar[]>;
            errors?: Record<string, string>;
            rateLimited?: boolean;
          };
          if (dead) return; // selection changed: these bars belong to the previous underlying/expiry

          if (j.bars) {
            for (const [k, b] of Object.entries(j.bars)) {
              barsCache.current.set(k, { minute: minuteNow(), bars: b });
            }
          }
          if (j.rateLimited) break;
        }
      } catch {
        // retry next interval
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
  }, [underlying, expiry, scanKey, heldViewKey]);

  // ── 7. Ledger-derived P&L (today, active mode) ─────────────────────
  // Scanner rows are tagged with the chain they were computed on; rows of any other chain are never shown or traded
  // (after an expiry switch the old premiums would otherwise stay clickable until the new feed lands).
  const chainKey = `${underlying}|${expiry}`;
  const [scan, setScan] = useState<{ chain: string; rows: CandidateSignal[] }>({ chain: '', rows: [] });
  const candidates = scan.chain === chainKey ? scan.rows : EMPTY_CANDIDATES;

  const todayIst = nowMs > 0 ? istDayOf(nowMs) : stateFile.date;
  const openPositions = useMemo(() => positions.filter((p) => p.status === 'OPEN'), [positions]);
  /** Today's open rows, any mode: these pin the page to their chain (see loadState). */
  const openToday = useMemo(() => openPositions.filter((p) => istDayOf(p.openedAt) === todayIst), [openPositions, todayIst]);
  const chainLocked = openToday.length > 0;
  /** Open rows the page cannot see a quote for: their stops are NOT being evaluated. */
  const unwatched = useMemo(
    () => openToday.filter((p) => p.underlying !== underlying || p.expiry !== expiry),
    [openToday, underlying, expiry],
  );

  const quotesMap = useMemo(() => {
    const out: Record<string, { ltp?: number | null }> = {};
    if (!liveQuotes?.strikes) return out;
    for (const [sStr, strObj] of Object.entries(liveQuotes.strikes)) {
      const s = Number(sStr);
      if (strObj.ce) out[`${s}CE`] = { ltp: strObj.ce.ltp };
      if (strObj.pe) out[`${s}PE`] = { ltp: strObj.pe.ltp };
    }
    return out;
  }, [liveQuotes]);

  // The loss limit and header P&L are for TODAY and the ACTIVE mode: SIM never counts against REAL, and
  // yesterday's closes never halt today's engine.
  const realizedPnl = useMemo(
    () =>
      positions
        .filter((p) => p.status === 'CLOSED' && p.mode === mode && p.closedAt != null && istDayOf(p.closedAt) === todayIst)
        .reduce((acc, p) => acc + p.realized, 0),
    [positions, mode, todayIst],
  );

  const unrealizedPnl = useMemo(() => {
    let sum = 0;
    for (const p of openPositions) {
      if (p.mode !== mode || p.underlying !== underlying || p.expiry !== expiry) continue;
      const legVal = legPnl(p, quotesMap[`${p.strike}${p.option}`]?.ltp ?? null);
      if (legVal != null) sum += legVal;
    }
    return sum;
  }, [openPositions, quotesMap, mode, underlying, expiry]);

  /** Price of a contract on the chain on screen, or null (never another chain's quote, never a stale feed). */
  const liveLtpOf = (u: string, exp: string, strike: number, opt: 'CE' | 'PE'): number | null => {
    if (u !== underlying || exp !== expiry || !liveQuotes) return null;
    const row = liveQuotes.strikes[String(strike)];
    const v = (opt === 'CE' ? row?.ce : row?.pe)?.ltp;
    return typeof v === 'number' && v > 0 ? v : null;
  };

  // ── 8. Engine halts ──────────────────────────────────────────────
  /** Set by any halt in this tab and cleared only when the user turns the engine back on, so entries stop at once
   *  even if the ledger write that turns the engine off is slow or refused. */
  const engineSuppressed = useRef(false);

  const haltEngine = useCallback(
    (message: string) => {
      engineSuppressed.current = true;
      void mutateLedger({ op: 'setConfig', config: { engineActive: false } }).then((ok) => {
        if (!ok) toast.error('Could not save the engine stop', { description: 'Entries are blocked in this tab; check the ledger.' });
      });
      addAuditLog('ERROR', message);
    },
    [mutateLedger, addAuditLog],
  );

  const toggleEngine = () => {
    const turningOn = !config.engineActive;
    if (turningOn) engineSuppressed.current = false;
    void mutateLedger({ op: 'setConfig', config: { engineActive: turningOn } });
  };

  // ── 9. Orders: exits ─────────────────────────────────────────────
  /** Same-tab guard (the cross-tab one is the 'inflight' exit mark). */
  const exitInFlight = useRef<Set<string>>(new Set());
  /** Rows this tab has closed: skipped until the ledger state that still shows them OPEN is replaced. */
  const closedIds = useRef<Set<string>>(new Set());
  const exitBlockedUntil = useRef<Map<string, number>>(new Map());
  const lastLtp = useRef<Map<string, number>>(new Map());
  const reentryLock = useRef<Map<string, number>>(new Map());
  const warnedUnknown = useRef<Set<string>>(new Set());

  const sendExitOrder = useCallback(async (pos: BreakdownPosition, curLtp: number) => {
    // Dhan is the only broker that orders by numeric security id; every other broker needs its own route. An
    // unsupported broker is refused here, never sent to Dhan's endpoint.
    if (pos.broker === 'dhan') {
      return postOrder('/api/scalper/fast-order', {
        securityId: pos.securityId,
        exchangeSegment: EXCHANGE_SEGMENT[pos.underlying as Underlying] ?? 'NSE_FNO',
        quantity: pos.qty,
        side: 'BUY',
        orderType: 'MARKET',
        price: curLtp,
        productType: 'INTRADAY',
        idempotencyKey: `exit_${pos.id}`,
        source: 'bdx',
      });
    }
    if (pos.broker === 'kotak') {
      return postOrder('/api/scalper/kotak/order', {
        tradingsymbol: pos.symbol,
        exchange: kotakExchange(pos.underlying),
        quantity: pos.qty,
        side: 'BUY',
        orderType: 'MARKET',
        product: 'MIS',
      });
    }
    return { outcome: 'failed' as const, error: `No exit route for broker ${pos.broker}` };
  }, []);

  type ExitResult = 'closed' | 'busy' | 'failed' | 'unknown';

  const executePositionExit = useCallback(
    async (
      pos: BreakdownPosition,
      curLtp: number,
      reason: string,
      opts: { resendUnknown?: boolean; ledgerOnly?: boolean } = {},
    ): Promise<ExitResult> => {
      if (exitInFlight.current.has(pos.id) || closedIds.current.has(pos.id)) return 'busy';
      const mark = exitMark(pos.id);
      if (mark?.s === 'inflight') return 'busy'; // another tab is sending this exit
      if (mark?.s === 'unknown' && !opts.resendUnknown && !opts.ledgerOnly) return 'unknown';

      exitInFlight.current.add(pos.id);
      try {
        const needOrder = pos.mode === 'REAL' && mark?.s !== 'exited' && !opts.ledgerOnly;
        if (needOrder) {
          setExitMark(pos.id, 'inflight');
          const r = await sendExitOrder(pos, curLtp);
          if (r.outcome === 'failed') {
            // Rejected before booking: safe to retry after a pause.
            setExitMark(pos.id, null);
            exitBlockedUntil.current.set(pos.id, clock() + EXIT_RETRY_MS);
            addAuditLog('ERROR', `[REAL] EXIT REJECTED for ${pos.strike} ${pos.option}: ${r.error ?? 'no detail'}. Retrying in ${EXIT_RETRY_MS / 1000}s.`);
            toast.error(`Exit rejected: ${pos.strike} ${pos.option}`, { description: r.error });
            return 'failed';
          }
          if (r.outcome === 'unknown') {
            // May have filled. Never resent automatically (a resend after the idempotency window books a second BUY).
            setExitMark(pos.id, 'unknown');
            haltEngine(
              `[REAL] EXIT STATUS UNKNOWN for ${pos.strike} ${pos.option} (${r.error ?? 'no confirmation'}). Engine halted and no exit will be resent: check the broker order book, then use Close on the row.`,
            );
            toast.error(`Exit status unknown: ${pos.strike} ${pos.option}`, { description: 'Check the order book, then use Close.' });
            return 'unknown';
          }
          setExitMark(pos.id, 'exited');
        }

        const closed = await mutateLedger({ op: 'close', id: pos.id, exitPrice: curLtp, exitReason: reason, at: clock() });
        if (!closed) {
          // The broker exit (if any) is recorded as 'exited', so the retry only re-attempts the ledger close.
          exitBlockedUntil.current.set(pos.id, clock() + EXIT_RETRY_MS);
          return 'failed';
        }

        setExitMark(pos.id, null);
        closedIds.current.add(pos.id);
        reentryLock.current.set(contractId(pos), clock() + REENTRY_LOCK_MS);
        addAuditLog('EXIT', `Closed ${pos.strike} ${pos.option} @ ₹${curLtp.toFixed(1)}. Reason: ${reason}`);
        toast.info(`Position Closed: ${pos.strike} ${pos.option}`, { description: reason });
        playAlertChime();
        void fetchBook();
        return 'closed';
      } finally {
        exitInFlight.current.delete(pos.id);
        // A mark still 'inflight' here means we threw mid-send: treat it as unknown, never as clear.
        if (exitMark(pos.id)?.s === 'inflight') setExitMark(pos.id, 'unknown');
      }
    },
    [sendExitOrder, mutateLedger, addAuditLog, fetchBook, haltEngine],
  );

  // ── 10. Orders: entries ───────────────────────────────────────────
  /** One entry at a time: the ledger only learns of a REAL entry after its order answers, so a second pick in that
   *  window would not see it in the caps. */
  const entryBusy = useRef(false);
  const autoRejects = useRef(0);
  const cooldownMap = useRef<Map<string, number>>(new Map());

  const realAllowed = (REAL_BROKERS as readonly string[]).includes(broker);

  const openShort = async (pick: { strike: number; option: 'CE' | 'PE' }, tag: 'AUTO' | 'MANUAL'): Promise<void> => {
    const fail = (msg: string) => {
      if (tag === 'MANUAL') toast.error(msg);
    };
    if (entryBusy.current) return fail('Another order is still being placed');
    if (!lotReady || !(lotSize > 0)) return fail('Lot size not loaded yet for this underlying/expiry');
    if (mode === 'REAL' && !realAllowed) return fail('REAL orders are limited to Dhan and Kotak');

    // Price from the live chain on screen at the moment of the order — never the scanner row's (possibly older) price.
    const tickMs = liveQuotes?.updated_at ? Date.parse(liveQuotes.updated_at) : NaN;
    if (!Number.isFinite(tickMs) || clock() - tickMs > STALE_FEED_MS) return fail('Options feed is stale');
    const entryPrice = liveLtpOf(underlying, expiry, pick.strike, pick.option);
    if (entryPrice == null) return fail(`No live price for ${pick.strike} ${pick.option}`);

    // The contract handle comes from THIS broker's lookup for the chain on screen.
    const ids = strikeIdMap.get(pick.strike);
    const securityId = pick.option === 'CE' ? ids?.ceId : ids?.peId;
    const symbol = pick.option === 'CE' ? ids?.ceSymbol : ids?.peSymbol;
    if (mode === 'REAL') {
      if (broker === 'dhan' && !securityId) return fail(`No Dhan security id for ${pick.strike} ${pick.option}`);
      if (broker !== 'dhan' && !symbol) return fail(`No ${broker} trading symbol for ${pick.strike} ${pick.option}`);
    }
    const id = contractId({ underlying, expiry, strike: pick.strike, option: pick.option });
    if (openPositions.some((p) => p.mode === mode && contractId(p) === id)) return fail('Already short this contract');

    const initialSl = Number((entryPrice * (1 + config.slPct / 100)).toFixed(2));
    const targetPrice = config.targetPct > 0 ? Number((entryPrice * (1 - config.targetPct / 100)).toFixed(2)) : null;
    const qty = config.lotsPerTrade * lotSize;

    const newPos: BreakdownPosition = {
      id: newId('pos'),
      mode,
      broker,
      underlying,
      expiry,
      option: pick.option,
      strike: pick.strike,
      securityId: broker === 'dhan' ? securityId : undefined,
      symbol: broker !== 'dhan' ? symbol : undefined,
      lotSize,
      qty,
      entryPrice,
      lowestPrice: entryPrice,
      initialSl,
      // The trailing stop STARTS at the initial stop and only ratchets down once the premium falls
      // (evaluatePositionRisk). Seeding it at trailPct made the effective stop trailPct, not slPct.
      trailingSl: initialSl,
      targetPrice,
      status: 'OPEN',
      openedAt: clock(),
      realized: 0,
    };

    entryBusy.current = true;
    try {
      if (mode === 'REAL') {
        const r =
          broker === 'dhan'
            ? await postOrder('/api/scalper/fast-order', {
                securityId,
                exchangeSegment: EXCHANGE_SEGMENT[underlying],
                quantity: qty,
                side: 'SELL',
                orderType: 'MARKET',
                price: entryPrice,
                productType: 'INTRADAY',
                idempotencyKey: `entry_${newPos.id}`,
                source: 'bds',
              })
            : broker === 'kotak'
              ? await postOrder('/api/scalper/kotak/order', {
                  tradingsymbol: symbol,
                  exchange: kotakExchange(underlying),
                  quantity: qty,
                  side: 'SELL',
                  orderType: 'MARKET',
                  product: 'MIS',
                  source: 'bds',
                })
              : { outcome: 'failed' as const, error: `No order route for broker ${broker}` };
        if (r.outcome === 'failed') {
          addAuditLog('ERROR', `[REAL] Order Failed: ${r.error || 'Broker rejected order'}`);
          toast.error(`Order Rejected: ${r.error || 'Failed to place real order'}`);
          if (tag === 'AUTO') {
            // A rejection (dead session, no margin, ...) repeats on every retry: back off, then halt.
            reentryLock.current.set(id, clock() + REENTRY_LOCK_MS);
            if (++autoRejects.current >= MAX_AUTO_REJECTS) {
              autoRejects.current = 0;
              haltEngine(`Engine halted after ${MAX_AUTO_REJECTS} rejected entries in a row. Fix the cause (session, margin, contract), then re-enable.`);
            }
          }
          return;
        }
        if (r.outcome === 'unknown') {
          // May have filled. Stop the engine so nothing else is added on top of an unknown book.
          haltEngine(
            `[REAL] ENTRY STATUS UNKNOWN for ${pick.strike} ${pick.option} (${r.error ?? 'no confirmation'}). Engine halted: check the broker order book / positions before re-enabling.`,
          );
          toast.error('Entry status unknown — engine halted', { description: 'Check the broker order book.' });
          return;
        }
        const ok = await mutateLedger({ op: 'open', position: newPos });
        if (!ok) {
          haltEngine(
            `[REAL] ORDER PLACED BUT NOT RECORDED: short ${pick.strike} ${pick.option} x${qty} (order #${r.orderId ?? '?'}). Engine halted: close it at the broker.`,
          );
          return;
        }
        autoRejects.current = 0;
        addAuditLog(
          'ORDER',
          `[REAL${tag === 'MANUAL' ? ' MANUAL' : ''}] Shorted ${config.lotsPerTrade}L ${pick.strike} ${pick.option} @ ₹${entryPrice.toFixed(1)} (Order #${r.orderId ?? '?'})`,
        );
        toast.success(`[REAL] Order placed: Short ${pick.strike} ${pick.option} @ ~₹${entryPrice.toFixed(1)}`);
        void fetchBook();
      } else {
        const ok = await mutateLedger({ op: 'open', position: newPos });
        if (!ok) return;
        addAuditLog(
          'ORDER',
          `[SIM${tag === 'MANUAL' ? ' MANUAL' : ''}] Shorted ${config.lotsPerTrade}L ${pick.strike} ${pick.option} @ ₹${entryPrice.toFixed(1)}. Initial SL: ₹${initialSl.toFixed(1)}`,
        );
        toast.success(`[SIM] Short Filled: ${pick.strike} ${pick.option} @ ₹${entryPrice.toFixed(1)}`);
      }
    } finally {
      entryBusy.current = false;
    }
  };

  // ── 11. Engine (1 s) ───────────────────────────────────────────────
  // The tick function is rebuilt every render and called through a ref from ONE stable interval. (It used to be the
  // interval's effect body with ~15 dependencies; with ticks at 20-40 Hz the timer restarted before it could fire.)
  const [isLeader, setIsLeader] = useState(true);
  const [engineNote, setEngineNote] = useState('');
  const haltedAt = useRef(0);
  const warnedStale = useRef<Set<string>>(new Set());
  const warnedUnwatched = useRef<Set<string>>(new Set());

  const claimEngineLock = (): boolean => {
    try {
      const now = clock();
      const raw = localStorage.getItem(ENGINE_LOCK_KEY);
      const cur = raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
      if (!cur || cur.id === viewerId || now - (cur.at ?? 0) > ENGINE_LOCK_TTL_MS) {
        localStorage.setItem(ENGINE_LOCK_KEY, JSON.stringify({ id: viewerId, at: now }));
        return true;
      }
      return false;
    } catch {
      return true; // storage blocked: single-tab assumption
    }
  };

  const runEngine = () => {
    if (!brokerLoaded) return;
    const now = clock();
    const nowIstMs = now + 5.5 * 3600_000;
    const today = istDayOf(now);
    const nowTimeStr = istTime();

    // Only one tab acts on the ledger; the others just display.
    const leader = claimEngineLock();
    setIsLeader((p) => (p === leader ? p : leader));

    // Open ledger rows opened on an earlier session day are not managed (the broker squares INTRADAY off):
    // flag them once and leave them for a manual close.
    const live = openPositions.filter((p) => istDayOf(p.openedAt) === today && !closedIds.current.has(p.id));
    for (const p of openPositions) {
      if (istDayOf(p.openedAt) !== today && !warnedStale.current.has(p.id)) {
        warnedStale.current.add(p.id);
        if (leader) addAuditLog('WARN', `Ledger row ${p.strike} ${p.option} (${p.mode}) is from ${istDayOf(p.openedAt)} and is not auto-managed. Verify at the broker, then close it manually.`);
      }
    }

    const q = liveQuotes;
    const rowOf = (strike: number, opt: 'CE' | 'PE') => {
      const row = q?.strikes[String(strike)];
      return opt === 'CE' ? row?.ce : row?.pe;
    };

    // ── Scanner (display + entry candidate) ──
    let ranked: CandidateSignal[] = [];
    if (q && scannedContracts.length) {
      const spot = q.spot || underlyingTrend.spot || 0;
      const atm = q.atm || spot;
      const strikes = Object.keys(q.strikes).map(Number).sort((a, b) => a - b);
      const diffs = strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0);
      const step = diffs.length ? Math.min(...diffs) : 50;

      const heldHere = new Set(
        live
          .filter((p) => p.mode === mode && p.underlying === underlying && p.expiry === expiry)
          .map((p) => `${p.strike}${p.option}`),
      );

      for (const c of scannedContracts) {
        const ltp = rowOf(c.strike, c.option)?.ltp ?? 0;
        if (ltp > 0) {
          let lm = liveMinRef.current.get(c.key);
          if (!lm) {
            lm = new Map();
            liveMinRef.current.set(c.key, lm);
          }
          recordTick(lm, ltp, nowIstMs);
        }
      }

      const rawCandidates = scannedContracts.map((c) => {
        const od = rowOf(c.strike, c.option);
        const cachedBars = barsCache.current.get(c.key)?.bars ?? [];
        const merged = mergeBars(cachedBars, liveMinRef.current.get(c.key) ?? new Map());
        const ids = strikeIdMap.get(c.strike);
        return {
          strike: c.strike,
          option: c.option,
          contractKey: c.key,
          securityId: c.option === 'CE' ? ids?.ceId : ids?.peId,
          ltp: od?.ltp ?? 0,
          volume: od?.volume ?? 0,
          oi: od?.oi ?? 0,
          buildup: od?.buildup,
          state: evaluateOptionBreakdown(merged, config.timeframe, nowIstMs),
        };
      });

      ranked = rankBreakdownSignals(rawCandidates, spot, atm, step, underlyingTrend, heldHere);
      // A contract exited (or rejected) minutes ago is shown (and treated) as locked, so it neither reads as the top candidate
      // nor blocks the next eligible contract.
      ranked = ranked
        .map((c) => {
          const until = reentryLock.current.get(contractId({ underlying, expiry, strike: c.strike, option: c.option })) ?? 0;
          return c.isEligible && until > now
            ? { ...c, isEligible: false, blockReason: `Re-entry lock (${Math.ceil((until - now) / 1000)}s left)` }
            : c;
        })
        .sort((a, b) => Number(b.isEligible) - Number(a.isEligible) || b.rankScore - a.rankScore);
      setScan({ chain: chainKey, rows: ranked });
    }

    if (!leader) return;

    // ── Risk: stops, targets and the EOD cutoff for every live row ──
    const updates: { id: string; lowestPrice: number; trailingSl: number }[] = [];
    const isEodHit = nowTimeStr >= config.eodExit;

    for (const pos of live) {
      if ((exitBlockedUntil.current.get(pos.id) ?? 0) > now) continue;
      if (exitMark(pos.id)?.s === 'unknown') {
        if (!warnedUnknown.current.has(pos.id)) {
          warnedUnknown.current.add(pos.id);
          toast.error(`${pos.strike} ${pos.option}: exit status unknown`, { description: 'Not auto-managed until you resolve it with Close.' });
        }
        continue;
      }

      const key = `${pos.strike}${pos.option}`;
      const liveLtp = liveLtpOf(pos.underlying, pos.expiry, pos.strike, pos.option);
      if (liveLtp != null) lastLtp.current.set(pos.id, liveLtp);

      if (isEodHit) {
        // The cutoff must exit even with no quote; it books the last price we saw (the order itself is MARKET).
        const px = liveLtp ?? lastLtp.current.get(pos.id) ?? pos.entryPrice;
        void executePositionExit(pos, px, `EOD MANDATORY EXIT: Session cutoff at ${config.eodExit} IST`);
        continue;
      }
      // No live quote => a stop cannot be evaluated; never substitute the entry price. The page pins itself to the
      // open chain (loadState), so this is only a missing strike or a feed gap: say so once.
      if (liveLtp == null) {
        if (!warnedUnwatched.current.has(pos.id)) {
          warnedUnwatched.current.add(pos.id);
          addAuditLog('WARN', `No live quote for open ${pos.underlying} ${pos.strike} ${pos.option} (${pos.expiry}): its stops are not being evaluated.`);
        }
        continue;
      }
      warnedUnwatched.current.delete(pos.id);

      const merged = mergeBars(barsCache.current.get(key)?.bars ?? [], liveMinRef.current.get(key) ?? new Map());
      const optState = evaluateOptionBreakdown(merged, config.timeframe, nowIstMs);

      const risk = evaluatePositionRisk(
        pos.entryPrice,
        liveLtp,
        pos.lowestPrice,
        config.slPct,
        config.trailPct,
        config.targetPct,
        optState.indicators.stLine,
        optState.indicators.ema,
        config.recoveryExit,
        pos.trailingSl,
      );

      if (risk.lowestPrice !== pos.lowestPrice || risk.trailingSl !== pos.trailingSl) {
        updates.push({ id: pos.id, lowestPrice: risk.lowestPrice, trailingSl: risk.trailingSl });
      }
      if (risk.shouldExit) {
        void executePositionExit(pos, liveLtp, risk.exitReason || 'STOP LOSS HIT');
      }
    }

    if (updates.length > 0) void mutateLedger({ op: 'updateLowsAndSl', updates });

    // ── Automated entry ──
    const block = (note: string) => setEngineNote((p) => (p === note ? p : note));
    if (!config.engineActive) return block('');
    // A halt this tab could not save to the ledger still stops entries here until the user re-enables.
    if (engineSuppressed.current) return block('Halted in this tab — toggle the engine off and on to resume');

    if (mode === 'REAL' && !realAllowed) return block('REAL entries are limited to Dhan and Kotak');
    if (!q || !scannedContracts.length) return block('Waiting for the options feed');
    if (!lotReady) return block('Waiting for lot size / security ids');

    // Caps and the loss limit count the active mode's live rows on every chain.
    const modeLive = live.filter((p) => p.mode === mode);
    if (modeLive.some((p) => exitMark(p.id)?.s === 'unknown')) return block('An exit has unknown status — resolve it first');

    // Daily loss limit: today's realized (this mode) + open P&L of EVERY open row of this mode. A row with no price
    // at all makes the total unknowable, so entries wait rather than trade on a partial number.
    let openPnl = 0;
    for (const p of modeLive) {
      const px = liveLtpOf(p.underlying, p.expiry, p.strike, p.option) ?? lastLtp.current.get(p.id) ?? null;
      const v = legPnl(p, px);
      if (v == null) return block(`Cannot price open ${p.strike} ${p.option} — entries paused`);
      openPnl += v;
    }
    const engineTotal = realizedPnl + openPnl;
    if (engineTotal <= -config.dailyLossLimit) {
      if (now - haltedAt.current > 5000) {
        haltedAt.current = now;
        haltEngine(`Auto-Trader halted: Daily loss limit of ₹${config.dailyLossLimit} reached! Total P&L: ₹${engineTotal.toFixed(0)}`);
        toast.error('Daily Loss Limit Breached', { description: `Auto-Trader halted. Total loss ₹${Math.abs(engineTotal).toFixed(0)}.` });
      }
      return;
    }

    if (nowTimeStr < config.entryStart || nowTimeStr > config.entryEnd) return block('Outside the entry window');

    // Stale data never opens a position.
    const tickMs = q.updated_at ? Date.parse(q.updated_at) : NaN;
    if (!Number.isFinite(tickMs) || now - tickMs > STALE_FEED_MS) return block('Options feed is stale — entries paused');
    if (trendForRef.current !== underlying || trendAtRef.current === 0 || now - trendAtRef.current > STALE_TREND_MS) {
      return block('Underlying trend is stale — entries paused');
    }
    block('');

    if (entryBusy.current) return;
    if (modeLive.length >= config.maxConcurrent) return;

    // The best-ranked contract that passes every entry rule — a locked or cooling contract never blocks the next one.
    const sideCount = (opt: 'CE' | 'PE') => modeLive.filter((p) => p.option === opt).length;
    const topPick = ranked.find((c) => {
      if (!c.isEligible || !(c.ltp > 0)) return false;
      if (sideCount(c.option) >= config.maxSameSide) return false;
      const cid = contractId({ underlying, expiry, strike: c.strike, option: c.option });
      if ((reentryLock.current.get(cid) ?? 0) > now) return false;
      return now - (cooldownMap.current.get(cid) ?? 0) >= ENTRY_COOLDOWN_MS;
    });
    if (!topPick) return;

    cooldownMap.current.set(contractId({ underlying, expiry, strike: topPick.strike, option: topPick.option }), now);
    void openShort(topPick, 'AUTO');
  };

  const engineRef = useRef<() => void>(() => {});
  useEffect(() => {
    engineRef.current = runEngine;
  });
  useEffect(() => {
    const id = setInterval(() => engineRef.current(), 1000);
    return () => {
      clearInterval(id);
      try {
        const raw = localStorage.getItem(ENGINE_LOCK_KEY);
        if (raw && (JSON.parse(raw) as { id?: string }).id === viewerId) localStorage.removeItem(ENGINE_LOCK_KEY);
      } catch {
        // storage blocked
      }
    };
  }, [viewerId]);

  // ── 12. Manual actions ───────────────────────────────────────────
  const handleManualShort = (cand: CandidateSignal) => {
    void openShort({ strike: cand.strike, option: cand.option }, 'MANUAL');
  };

  const priceForExit = (pos: BreakdownPosition): number =>
    liveLtpOf(pos.underlying, pos.expiry, pos.strike, pos.option) ?? lastLtp.current.get(pos.id) ?? pos.entryPrice;

  /** True (with a toast) while an earlier exit for this position was rejected and is cooling down. */
  const exitOnHold = (pos: BreakdownPosition): boolean => {
    const until = exitBlockedUntil.current.get(pos.id) ?? 0;
    if (until <= clock()) return false;
    toast.warning(`Exit for ${pos.strike} ${pos.option} is retrying (${Math.ceil((until - clock()) / 1000)}s)`);
    return true;
  };

  /**
   * An exit whose status is unknown is resolved by a person who has looked at the broker's order book: either it
   * filled (close the ledger row, send nothing) or it did not (send one new exit). Returns null when they back out.
   */
  const confirmUnknownExit = (pos: BreakdownPosition): { ledgerOnly?: boolean; resendUnknown?: boolean } | null => {
    if (exitMark(pos.id)?.s !== 'unknown') return {};
    const label = `${pos.strike} ${pos.option}`;
    if (confirm(`The last exit for ${label} has UNKNOWN status — it may already have filled.\n\nCheck the broker order book.\n\nOK = it FILLED: close the ledger row WITHOUT sending another order.\nCancel = more options.`)) {
      return { ledgerOnly: true };
    }
    if (confirm(`Send a NEW exit order for ${label}?\n\nOnly if the order book shows the earlier exit did NOT fill — otherwise this flips the position long.`)) {
      return { resendUnknown: true };
    }
    return null;
  };

  const handleClosePosition = (id: string) => {
    const pos = positions.find((p) => p.id === id);
    if (!pos || exitOnHold(pos)) return;
    const opts = confirmUnknownExit(pos);
    if (!opts) return;
    void executePositionExit(pos, priceForExit(pos), opts.ledgerOnly ? 'MANUAL: earlier exit confirmed filled at broker' : 'MANUAL EXIT: Closed by user', opts).then((r) => {
      if (r === 'busy') toast.info(`Exit for ${pos.strike} ${pos.option} is already in progress`);
    });
  };

  const handleSquareOffAll = async () => {
    if (!openPositions.length) return;
    if (!confirm(`Are you sure you want to close ALL ${openPositions.length} active positions?`)) return;

    // Stop entries first, or the engine re-enters the moment a slot frees up. The local stop applies at once even if
    // the ledger write fails (haltEngine reports that failure).
    haltEngine(`EMERGENCY SQUARE OFF requested for ${openPositions.length} positions: engine stopped.`);

    const results = await Promise.all(
      openPositions.map((pos) =>
        exitOnHold(pos) ? Promise.resolve<ExitResult>('failed') : executePositionExit(pos, priceForExit(pos), 'MANUAL EXIT: Emergency Square Off All'),
      ),
    );
    const n = (r: ExitResult) => results.filter((x) => x === r).length;
    const closed = n('closed');
    const busy = n('busy');
    const unknown = n('unknown');
    const failed = n('failed');
    addAuditLog('WARN', `EMERGENCY SQUARE OFF: ${closed} closed, ${busy} already exiting, ${unknown} unknown status, ${failed} failed.`);
    if (failed + unknown === 0) toast.warning(`Square-off: ${closed} closed${busy ? `, ${busy} already exiting` : ''}.`);
    else toast.error(`Square-off: ${failed + unknown} position(s) need attention`, { description: unknown ? 'Unknown-status exits: resolve with Close.' : undefined });
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-white">
      {/* Sticky Header — Standard Dhan Page Theme */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Target className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">
              Scalping · Multi-Strike Breakdown
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Breakdown Auto-Scalper
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Automated multi-strike option breakdown seller with NIFTY trend bias & trailing SL
            </p>
          </div>
        </div>

        {/* Right Header Controls */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Underlying Selector */}
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs font-bold">
            {UNDERLYINGS.map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => changeUnderlying(u)}
                disabled={chainLocked && underlying !== u}
                title={chainLocked ? 'Locked to the chain of the open positions (their stops need its quotes)' : undefined}
                className={cn(
                  'rounded-md px-2.5 py-1 transition-all disabled:cursor-not-allowed disabled:opacity-50',
                  underlying === u
                    ? 'bg-zinc-800 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {u}
              </button>
            ))}
          </div>

          {/* Expiry Selector */}
          {expiries.length > 0 && (
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              disabled={chainLocked}
              title={chainLocked ? 'Locked to the expiry of the open positions (their stops need its quotes)' : undefined}
              aria-label="Expiry"
              className="disabled:cursor-not-allowed disabled:opacity-50 h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-200 focus:outline-none focus:border-zinc-700"
            >
              {expiries.map((exp) => (
                <option key={exp} value={exp}>
                  {exp}
                </option>
              ))}
            </select>
          )}

          {/* Broker Picker */}
          <BrokerPicker value={broker as DhanKotak} onChange={(b) => setBroker(b as 'dhan' | 'kotak')} />

          {/* India VIX Live Chip */}
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs">
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
              INDIA VIX
            </span>
            <span className="font-mono font-bold text-white">
              {vixLtp != null ? vixLtp.toFixed(2) : '—'}
            </span>
            {vixChangePct != null && (
              <span
                className={cn(
                  'font-mono text-[11px] font-bold',
                  vixChangePct > 0 ? 'text-amber-400' : 'text-sky-400',
                )}
                title={vixPrevClose != null ? `Yesterday close: ₹${vixPrevClose.toFixed(2)}` : undefined}
              >
                {vixChangePct > 0 ? '▲' : vixChangePct < 0 ? '▼' : ''}{' '}
                {vixChangePct > 0 ? `+${vixChangePct.toFixed(2)}%` : `${vixChangePct.toFixed(2)}%`}
              </span>
            )}
          </div>

          {/* WebSocket Feed Indicator */}
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-mono font-bold transition-all',
              bridgeStatus.status !== 'RUNNING'
                ? 'border-zinc-800 bg-zinc-900 text-zinc-400'
                : isWsStale
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
            )}
            title={`Options WebSocket Feed: ${bridgeStatus.status} · Transport: ${transport.toUpperCase()}${lastUpdated ? ` · Last Tick: ${lastUpdated}` : ''}`}
          >
            <span
              className={cn(
                'h-2 w-2 rounded-full shrink-0',
                bridgeStatus.status !== 'RUNNING'
                  ? 'bg-zinc-500'
                  : isWsStale
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-emerald-400 animate-ping',
              )}
            />
            <span>
              {bridgeStatus.status !== 'RUNNING'
                ? `WS ${bridgeStatus.status}`
                : isWsStale
                ? `WS STALE (${feedAge != null ? Math.round(feedAge) : '?'}s)`
                : `LIVE WS · ${transport.toUpperCase()}`}
            </span>
          </div>

          {/* DATA Chip */}
          <div className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400 tracking-wider">
            <span>DATA: {istDate()}</span>
          </div>

          {/* Playbook / Docs Header Button */}
          <button
            type="button"
            onClick={() => setIsDocOpen(true)}
            className="flex items-center gap-1.5 h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:text-white hover:bg-zinc-800 hover:border-zinc-700 transition"
            title="Strategy Playbook & Rules Documentation"
          >
            <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span>DOCS</span>
          </button>

          {/* Orders, Trades & Positions Header Button */}
          <button
            type="button"
            onClick={() => setShowBookModal(true)}
            className="flex items-center gap-1.5 h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 hover:text-white hover:bg-zinc-800 hover:border-zinc-700 transition"
            title="Broker Order Book, Trade Book and Open Positions"
          >
            <ClipboardList className="w-3.5 h-3.5 text-sky-400" />
            <span>ORDERS ({bookData.orders.length})</span>
          </button>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {/* Main Workspace Body */}
      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1720px] w-full mx-auto">
        {unwatched.length > 0 && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs font-bold text-red-400">
            {unwatched.length} open position(s) are on another chain (
            {unwatched.map((p) => `${p.underlying} ${p.expiry} ${p.strike}${p.option}`).join(', ')}): their stops are NOT
            being evaluated from this view. Close them or check them at the broker.
          </div>
        )}

        {config.engineActive && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-400"
          >
            <span className="font-bold">Engine runs in this browser tab only.</span> Keep it open and visible: stops are
            software-only (no resting broker stop), and a hidden tab slows its timers.
            {!isLeader && <span className="ml-1 font-bold">Another tab is running the engine; this tab is view-only.</span>}
            {engineNote && <span className="ml-1 font-bold">· {engineNote}</span>}
          </div>
        )}

        {/* 1. Market Direction Bias & Telemetry Strip */}
        <MarketBiasStrip
          underlying={underlying}
          trend={underlyingTrend}
          config={config}
          mode={mode}
          openCount={openPositions.length}
          realizedPnl={realizedPnl}
          unrealizedPnl={unrealizedPnl}
          onToggleEngine={toggleEngine}
          onSquareOffAll={handleSquareOffAll}
          onOpenSettings={() => setIsRulesOpen(true)}
          onOpenDocs={() => setIsDocOpen(true)}
          vixLtp={vixLtp}
          vixChangePct={vixChangePct}
          vixPrevClose={vixPrevClose}
          wsTransport={transport}
          wsStatus={bridgeStatus.status}
          wsStale={isWsStale}
        />

        {/* 2. Unified Trade & Orders Desk (Positions, Order Book, Trade Book) */}
        <PositionsTable
          positions={positions}
          quotes={quotesMap}
          onClosePosition={handleClosePosition}
          viewUnderlying={underlying}
          viewExpiry={expiry}
          broker={broker as 'dhan' | 'kotak'}
          ordersData={bookData.orders}
          tradesData={bookData.trades}
          brokerPositionsData={bookData.positions}
          isBookLoading={bookLoading}
          bookError={bookError}
          onRefreshBook={fetchBook}
          onOpenBookModal={() => setShowBookModal(true)}
        />

        {/* 3. Multi-Strike Scanner Matrix */}
        <ScannerGrid
          candidates={candidates}
          atm={liveQuotes?.atm || underlyingTrend.spot}
          onManualShort={handleManualShort}
        />

        {/* 4. Execution & Audit Log */}
        <AuditLogPanel logs={logs} onClearLogs={() => mutateLedger({ op: 'clearLogs' })} />
      </div>

      {/* Rules & Risk Configuration Drawer */}
      <RulesConfigDrawer
        isOpen={isRulesOpen}
        onClose={() => setIsRulesOpen(false)}
        config={config}
        mode={mode}
        onUpdateConfig={(patch) => mutateLedger({ op: 'setConfig', config: patch })}
        onSetMode={(m) => mutateLedger({ op: 'setMode', mode: m })}
        onResetSim={() => mutateLedger({ op: 'resetSim' })}
      />

      {/* Strategy Playbook & Rules Documentation Modal */}
      <BreakdownDocModal
        isOpen={isDocOpen}
        onClose={() => setIsDocOpen(false)}
      />

      {/* Full-Screen Broker Order Book, Trade Book & Positions Modal */}
      <OrdersTradesModal
        isOpen={showBookModal}
        onClose={() => setShowBookModal(false)}
        broker={broker}
        ordersData={bookData.orders}
        tradesData={bookData.trades}
        positionsData={bookData.positions}
        isLoading={bookLoading}
        error={bookError}
        onRefresh={fetchBook}
      />
    </div>
  );
}
