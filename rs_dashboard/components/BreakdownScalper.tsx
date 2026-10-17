'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Target,
  RefreshCw,
  AlertOctagon,
  ShieldAlert,
  Play,
  Pause,
  Sliders,
  TrendingDown,
  Activity,
  BookOpen,
  ClipboardList,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { BrokerPicker, usePageBroker, type DhanKotak } from '@/components/BrokerPicker';
import { useLiveTickerPoll } from '@/lib/useLiveTickerPoll';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import { recordTick, mergeBars, type LiveMinutes } from '@/lib/bearishStrikes';
import { fallbackLotSize } from '@/lib/multiLegFocus';
import type { Bar } from '@/lib/volumeProfile';
import {
  evaluateOptionBreakdown,
  evaluateUnderlyingTrend,
  rankBreakdownSignals,
  evaluatePositionRisk,
  type CandidateSignal,
  type OptionBreakdownState,
  type UnderlyingTrend,
} from '@/lib/breakdownScalper';
import {
  applyOp,
  DEFAULT_CONFIG,
  legPnl,
  type AuditLogItem,
  type BreakdownConfig,
  type BreakdownPosition,
  type BreakdownStateFile,
  type LedgerMode,
} from '@/lib/breakdownLedger';
import { MarketBiasStrip } from './breakdownScalper/MarketBiasStrip';
import { PositionsTable } from './breakdownScalper/PositionsTable';
import { ScannerGrid } from './breakdownScalper/ScannerGrid';
import { RulesConfigDrawer } from './breakdownScalper/RulesConfigDrawer';
import { AuditLogPanel } from './breakdownScalper/AuditLogPanel';
import BreakdownDocModal from './breakdownScalper/BreakdownDocModal';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';

function playAlertSound(ctx: AudioContext | null) {
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.28;
      o.start(t);
      o.stop(t + 0.2);
    });
  } catch {
    // audio unavailable
  }
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOILM'] as const;
type Underlying = (typeof UNDERLYINGS)[number];

const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const istTime = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16);

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

export default function BreakdownScalper() {
  const [broker, setBroker] = usePageBroker('dhan');
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('');
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isDocOpen, setIsDocOpen] = useState(false);
  const [showBookModal, setShowBookModal] = useState(false);

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

  const fetchBook = useCallback(async () => {
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
      setBookError(String((e as Error).message));
    } finally {
      setBookLoading(false);
    }
  }, [broker]);

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

  // Audio Context for sound alerts (playAlertSound)
  const audioRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    const unlock = () => {
      try {
        if (!audioRef.current && typeof AudioContext !== 'undefined') {
          audioRef.current = new AudioContext();
        }
        if (audioRef.current?.state === 'suspended') void audioRef.current.resume();
      } catch {}
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // Viewer ID for shared WebSocket live options bridge
  const viewer = useRef<string>(`bds_${Math.random().toString(36).slice(2, 9)}`);

  // Start live indices bridge once on mount
  useEffect(() => {
    startLiveIndicesBridge();
  }, []);

  // Live minutes accumulator: folds real-time ticks into intra-minute OHLC
  const liveMinRef = useRef<Map<string, LiveMinutes>>(new Map());
  useEffect(() => {
    liveMinRef.current = new Map();
  }, [underlying, expiry]);

  // ── 1. Expiries ──────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !j.data?.length) return;
        setExpiries(j.data);
        setExpiry(j.data[0]);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, broker]);

  // ── 2. Live Options WebSocket Bridge ─────────────────────────────
  const startedBridges = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expiry) return;
    startedBridges.current.add(underlying);
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start',
        underlying,
        expiry,
        numStrikes: 35,
        broker,
        viewer: viewer.current,
      }),
    }).catch(() => {});
  }, [underlying, expiry, broker]);

  useEffect(() => {
    const started = startedBridges.current;
    const viewerId = viewer.current;
    return () => {
      for (const u of started) {
        fetch('/api/options/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', brokers: ['dhan'], underlying: u, viewer: viewerId }),
        }).catch(() => {});
      }
    };
  }, []);

  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, [broker], underlying);
  const quotesRef = useRef(liveQuotes);
  useEffect(() => {
    quotesRef.current = liveQuotes;
  }, [liveQuotes]);

  const lastTickTime = quotesRef.current?.updated_at ? Date.parse(quotesRef.current.updated_at) : 0;
  const feedAge = lastTickTime > 0 ? (Date.now() - lastTickTime) / 1000 : null;
  const isWsStale = feedAge != null && feedAge > 10;

  // ── 3. Lot Size Lookup ───────────────────────────────────────────
  const [lotSize, setLotSize] = useState<number>(fallbackLotSize(underlying, broker));
  const [strikeIdentifiers, setStrikeIdentifiers] = useState<Record<string, { securityId?: string; symbol?: string }>>({});

  useEffect(() => {
    if (!expiry) return;
    let dead = false;
    fetch(`/api/scalper/${broker === 'kotak' ? 'kotak/' : ''}lookup?underlying=${underlying}&expiry=${expiry}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, { securityId?: string; symbol?: string }> } }) => {
        if (dead || !j.success || !j.data) return;
        setLotSize(j.data.lotSize ?? fallbackLotSize(underlying, broker));
        if (j.data.strikes) setStrikeIdentifiers(j.data.strikes);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [underlying, expiry, broker]);

  // ── 4. Underlying Telemetry & Feed (Spot, VWAP, EMA9, EMA20) ──────
  const [underlyingTrend, setUnderlyingTrend] = useState<UnderlyingTrend>({
    spot: 0,
    vwap: null,
    ema9: null,
    ema20: null,
    spread: null,
    trend: 'SIDEWAYS',
    eligibleSide: 'NONE',
    headline: 'Initializing',
    detail: 'Loading underlying market feed...',
  });

  const fetchUnderlyingFeed = useCallback(async () => {
    try {
      const q = new URLSearchParams({
        symbol: underlying === 'CRUDEOILM' ? 'CRUDEOILM' : underlying,
        interval: String(config.timeframe),
      });
      if (expiry) q.set('expiry', expiry);

      const res = await fetch(`/api/cyber-scalper/feed?${q.toString()}`);
      const json = await res.json();

      if (json.success && json.live) {
        const spot = json.spot || json.live.close || 0;
        const vwap = json.live.vwap || null;
        const ema9 = json.live.ema9 || null;
        const ema20 = json.live.ema20 || null;

        const evaluated = evaluateUnderlyingTrend(spot, vwap, ema9, ema20, config.trendMode);
        setUnderlyingTrend(evaluated);
      }
    } catch {
      // Keep existing trend on network hiccup
    }
  }, [underlying, config.timeframe, config.trendMode, expiry]);

  useEffect(() => {
    fetchUnderlyingFeed();
    const id = setInterval(fetchUnderlyingFeed, 10_000);
    return () => clearInterval(id);
  }, [fetchUnderlyingFeed]);

  // ── 5. Ledger State Load & Mutations ──────────────────────────────
  const loadState = useCallback(async () => {
    try {
      const res = await fetch('/api/breakdown-scalper/state');
      const j = await res.json();
      if (j.success) {
        setStateFile((prev) => (j.rev !== prev.rev ? j : prev));
      }
    } catch {
      // offline / retry next tick
    }
  }, []);

  useEffect(() => {
    loadState();
    const id = setInterval(loadState, 3_000);
    return () => clearInterval(id);
  }, [loadState]);

  const mutateLedger = useCallback(async (op: Parameters<typeof applyOp>[1]) => {
    try {
      const res = await fetch('/api/breakdown-scalper/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(op),
      });
      const j = await res.json();
      if (j.success) {
        setStateFile(j);
      } else {
        toast.error(j.error || 'Failed to update ledger');
      }
    } catch (err) {
      toast.error(String(err));
    }
  }, []);

  const addAuditLog = useCallback(
    (level: AuditLogItem['level'], message: string) => {
      const item: AuditLogItem = {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        level,
        message,
      };
      mutateLedger({ op: 'addLog', item });
    },
    [mutateLedger],
  );

  // ── 6. 1-Minute Bars Backfill for Scanned Strikes ─────────────────
  const barsCache = useRef<Map<string, { minute: string; bars: Bar[] }>>(new Map());

  // Helper to determine the ATM ± N strikes list
  const scannedContracts = useMemo(() => {
    const q = liveQuotes;
    if (!q || !q.strikes) return [];
    const spot = q.spot || 0;
    const atm = q.atm || spot;
    const strikes = Object.keys(q.strikes).map(Number).sort((a, b) => a - b);
    if (!strikes.length) return [];

    const step =
      strikes.length > 1
        ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0))
        : 50;

    const windowCount = config.strikeWindow;
    const atmIdx = strikes.reduce(
      (bestIdx, s, idx) => (Math.abs(s - atm) < Math.abs(strikes[bestIdx] - atm) ? idx : bestIdx),
      0,
    );

    const minIdx = Math.max(0, atmIdx - windowCount);
    const maxIdx = Math.min(strikes.length - 1, atmIdx + windowCount);
    const targetStrikes = strikes.slice(minIdx, maxIdx + 1);

    const contracts: { strike: number; option: 'CE' | 'PE'; key: string }[] = [];
    for (const s of targetStrikes) {
      contracts.push({ strike: s, option: 'CE', key: `${s}CE` });
      contracts.push({ strike: s, option: 'PE', key: `${s}PE` });
    }
    return contracts;
  }, [liveQuotes, config.strikeWindow]);

  // Fetch bars for scanned contracts every 20s
  useEffect(() => {
    if (!expiry || !scannedContracts.length) return;
    let dead = false;
    let busy = false;
    const minuteNow = () => new Date().toISOString().slice(0, 16);

    const cycle = async () => {
      if (busy || dead) return;
      busy = true;
      try {
        const heldKeys = positions
          .filter((p) => p.status === 'OPEN')
          .map((p) => `${p.strike}${p.option}`);
        const want = [...new Set([...heldKeys, ...scannedContracts.map((c) => c.key)])];
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

    cycle();
    const id = setInterval(cycle, 20_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [underlying, expiry, scannedContracts, positions]);

  // ── 7. 1s Compute & Auto-Execution Engine Loop ────────────────────
  const [candidates, setCandidates] = useState<CandidateSignal[]>([]);
  const cooldownMap = useRef<Map<string, number>>(new Map()); // contractKey -> timestamp ms

  // Open position PnL computation
  const openPositions = useMemo(() => positions.filter((p) => p.status === 'OPEN'), [positions]);
  const quotesMap = useMemo(() => {
    const out: Record<string, { ltp?: number | null }> = {};
    if (!liveQuotes?.strikes) return out;
    for (const [sStr, strObj] of Object.entries(liveQuotes.strikes)) {
      if (strObj.ce) out[`${sStr}CE`] = { ltp: strObj.ce.ltp };
      if (strObj.pe) out[`${sStr}PE`] = { ltp: strObj.pe.ltp };
    }
    return out;
  }, [liveQuotes]);

  const realizedPnl = useMemo(
    () => positions.filter((p) => p.status === 'CLOSED').reduce((acc, p) => acc + p.realized, 0),
    [positions],
  );

  const unrealizedPnl = useMemo(() => {
    let sum = 0;
    for (const p of openPositions) {
      const qLtp = quotesMap[`${p.strike}${p.option}`]?.ltp ?? null;
      const legVal = legPnl(p, qLtp);
      if (legVal != null) sum += legVal;
    }
    return sum;
  }, [openPositions, quotesMap]);

  const totalPnl = realizedPnl + unrealizedPnl;

  // ── 7. Position Exit Execution (Broker Order + Ledger) ──────────
  const executePositionExit = useCallback(
    async (pos: BreakdownPosition, curLtp: number, reason: string) => {
      if (pos.mode === 'REAL') {
        if (pos.broker === 'kotak') {
          try {
            await fetch('/api/scalper/kotak/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                symbol: pos.symbol,
                quantity: pos.qty,
                side: 'BUY',
                orderType: 'MARKET',
                product: 'MIS',
              }),
            });
          } catch (err) {
            console.error('Failed to submit Kotak exit order:', err);
          }
        } else {
          try {
            await fetch('/api/scalper/fast-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                securityId: pos.securityId,
                quantity: pos.qty,
                side: 'BUY',
                orderType: 'MARKET',
                price: curLtp,
                productType: 'INTRADAY',
                source: 'bds_exit',
              }),
            });
          } catch (err) {
            console.error('Failed to submit Dhan exit order:', err);
          }
        }
      }

      await mutateLedger({
        op: 'close',
        id: pos.id,
        exitPrice: curLtp,
        exitReason: reason,
        at: Date.now(),
      });

      addAuditLog('EXIT', `Closed ${pos.strike} ${pos.option} @ ₹${curLtp.toFixed(1)}. Reason: ${reason}`);
      toast.info(`Position Closed: ${pos.strike} ${pos.option}`, { description: reason });
      playAlertSound(audioRef.current);
      void fetchBook();
    },
    [mutateLedger, addAuditLog, fetchBook],
  );

  // Single-tick Engine execution
  useEffect(() => {
    const id = setInterval(() => {
      const q = quotesRef.current;
      if (!q || !scannedContracts.length) return;

      const spot = q.spot || underlyingTrend.spot || 0;
      const atm = q.atm || spot;
      const strikes = Object.keys(q.strikes).map(Number).sort((a, b) => a - b);
      const step =
        strikes.length > 1
          ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0))
          : 50;

      const nowIstMs = Date.now() + 5.5 * 3600_000;
      const activeHeldKeys = new Set(
        openPositions.map((p) => `${p.strike}${p.option}`),
      );

      // 1. Fold live ticks into live minute accumulator
      scannedContracts.forEach((c) => {
        const optionData = q.strikes[String(c.strike)]?.[c.option === 'CE' ? 'ce' : 'pe'];
        const ltp = optionData?.ltp ?? 0;
        if (ltp > 0) {
          let lm = liveMinRef.current.get(c.key);
          if (!lm) {
            lm = new Map();
            liveMinRef.current.set(c.key, lm);
          }
          recordTick(lm, ltp, nowIstMs);
        }
      });

      // 2. Evaluate breakdown state for each scanned contract
      const rawCandidates = scannedContracts.map((c) => {
        const optionData = q.strikes[String(c.strike)]?.[c.option === 'CE' ? 'ce' : 'pe'];
        const ltp = optionData?.ltp ?? 0;
        const volume = optionData?.volume ?? 0;
        const oi = optionData?.oi ?? 0;
        const buildup = optionData?.buildup;

        const cachedBars = barsCache.current.get(c.key)?.bars ?? [];
        const lm = liveMinRef.current.get(c.key) ?? new Map();
        const mergedBars = mergeBars(cachedBars, lm);
        const state = evaluateOptionBreakdown(mergedBars, config.timeframe, nowIstMs);

        const secId = strikeIdentifiers[c.key]?.securityId;

        return {
          strike: c.strike,
          option: c.option,
          contractKey: c.key,
          securityId: secId,
          ltp,
          volume,
          oi,
          buildup,
          state,
        };
      });

      const ranked = rankBreakdownSignals(
        rawCandidates,
        spot,
        atm,
        step,
        underlyingTrend,
        activeHeldKeys,
      );

      setCandidates(ranked);

      // ── Position Risk & Trailing SL Evaluation for Open Positions ─
      const updates: { id: string; lowestPrice: number; trailingSl: number }[] = [];
      const nowTimeStr = istTime();

      for (const pos of openPositions) {
        const key = `${pos.strike}${pos.option}`;
        const curLtp = quotesMap[key]?.ltp ?? pos.entryPrice;
        if (!curLtp || curLtp <= 0) continue;

        const optBars = barsCache.current.get(key)?.bars ?? [];
        const lm = liveMinRef.current.get(key) ?? new Map();
        const mergedBars = mergeBars(optBars, lm);
        const optState = evaluateOptionBreakdown(mergedBars, config.timeframe, nowIstMs);

        const risk = evaluatePositionRisk(
          pos.entryPrice,
          curLtp,
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
          updates.push({
            id: pos.id,
            lowestPrice: risk.lowestPrice,
            trailingSl: risk.trailingSl,
          });
        }

        // Check EOD exit
        const isEodHit = nowTimeStr >= config.eodExit;

        if (risk.shouldExit || isEodHit) {
          const reason = isEodHit
            ? `EOD MANDATORY EXIT: Session cutoff at ${config.eodExit} IST`
            : risk.exitReason || 'STOP LOSS HIT';

          executePositionExit(pos, curLtp, reason);
        }
      }

      if (updates.length > 0) {
        mutateLedger({ op: 'updateLowsAndSl', updates });
      }

      // ── Automated Entry Logic ────────────────────────────────────
      if (!config.engineActive) return;

      // Rule: Check daily loss limit
      if (totalPnl <= -config.dailyLossLimit) {
        mutateLedger({ op: 'setConfig', config: { engineActive: false } });
        addAuditLog(
          'ERROR',
          `Auto-Trader halted: Daily loss limit of ₹${config.dailyLossLimit} reached! Total P&L: ₹${totalPnl.toFixed(0)}`,
        );
        toast.error('Daily Loss Limit Breached', {
          description: `Auto-Trader halted. Total loss ₹${Math.abs(totalPnl).toFixed(0)}.`,
        });
        return;
      }

      // Rule: Check entry hours window (09:30 to 15:00 IST)
      if (nowTimeStr < config.entryStart || nowTimeStr > config.entryEnd) {
        return;
      }

      // Rule: Check capacity
      if (openPositions.length >= config.maxConcurrent) {
        return;
      }

      // Top eligible candidate
      const topPick = ranked.find((c) => c.isEligible);
      if (!topPick || topPick.ltp <= 0) return;

      // Rule: Check same-side limit
      const sameSideCount = openPositions.filter((p) => p.option === topPick.option).length;
      if (sameSideCount >= config.maxSameSide) {
        return;
      }

      // Rule: Check cooldown (30s cooldown per strike to avoid double entries)
      const lastTrigger = cooldownMap.current.get(topPick.contractKey) || 0;
      if (Date.now() - lastTrigger < 30_000) {
        return;
      }
      cooldownMap.current.set(topPick.contractKey, Date.now());

      // Trigger SHORT Order!
      const entryPrice = topPick.ltp;
      const initialSl = Number((entryPrice * (1 + config.slPct / 100)).toFixed(2));
      const trailingSl = Number((entryPrice * (1 + config.trailPct / 100)).toFixed(2));
      const targetPrice =
        config.targetPct > 0 ? Number((entryPrice * (1 - config.targetPct / 100)).toFixed(2)) : null;

      const newPos: BreakdownPosition = {
        id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        mode,
        broker,
        underlying,
        expiry,
        option: topPick.option,
        strike: topPick.strike,
        securityId: topPick.securityId,
        lotSize,
        qty: config.lotsPerTrade * lotSize,
        entryPrice,
        lowestPrice: entryPrice,
        initialSl,
        trailingSl,
        targetPrice,
        status: 'OPEN',
        openedAt: Date.now(),
        realized: 0,
      };

      if (mode === 'REAL') {
        // Submit Real Order to Broker
        fetch('/api/scalper/fast-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            securityId: topPick.securityId,
            quantity: config.lotsPerTrade * lotSize,
            side: 'SELL',
            orderType: 'MARKET',
            price: entryPrice,
            productType: 'INTRADAY',
            source: 'bds',
          }),
        })
          .then((r) => r.json())
          .then((j: { success?: boolean; error?: string; orderId?: string }) => {
            if (j.success) {
              mutateLedger({ op: 'open', position: newPos });
              addAuditLog(
                'ORDER',
                `[REAL] Shorted ${config.lotsPerTrade}L ${topPick.strike} ${topPick.option} @ ₹${entryPrice.toFixed(1)} (Order #${j.orderId})`,
              );
              toast.success(`[REAL] Order Filled: Short ${topPick.strike} ${topPick.option} @ ₹${entryPrice.toFixed(1)}`);
              void fetchBook();
            } else {
              addAuditLog('ERROR', `[REAL] Order Failed: ${j.error || 'Broker rejected order'}`);
              toast.error(`Order Rejected: ${j.error || 'Failed to place real order'}`);
            }
          })
          .catch((err) => {
            addAuditLog('ERROR', `[REAL] Network Error: ${String(err)}`);
          });
      } else {
        // SIM Paper Order
        mutateLedger({ op: 'open', position: newPos });
        addAuditLog(
          'ORDER',
          `[SIM] Shorted ${config.lotsPerTrade}L ${topPick.strike} ${topPick.option} @ ₹${entryPrice.toFixed(1)}. Initial SL: ₹${initialSl.toFixed(1)}`,
        );
        toast.success(`[SIM] Short Filled: ${topPick.strike} ${topPick.option} @ ₹${entryPrice.toFixed(1)}`);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [
    scannedContracts,
    liveQuotes,
    underlyingTrend,
    openPositions,
    quotesMap,
    config,
    mode,
    broker,
    underlying,
    expiry,
    lotSize,
    totalPnl,
    strikeIdentifiers,
    mutateLedger,
    addAuditLog,
  ]);

  // ── 8. Manual Short Action ───────────────────────────────────────
  const handleManualShort = (cand: CandidateSignal) => {
    const entryPrice = cand.ltp > 0 ? cand.ltp : 100;
    const initialSl = Number((entryPrice * (1 + config.slPct / 100)).toFixed(2));
    const trailingSl = Number((entryPrice * (1 + config.trailPct / 100)).toFixed(2));
    const targetPrice =
      config.targetPct > 0 ? Number((entryPrice * (1 - config.targetPct / 100)).toFixed(2)) : null;

    const newPos: BreakdownPosition = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mode,
      broker,
      underlying,
      expiry,
      option: cand.option,
      strike: cand.strike,
      securityId: cand.securityId,
      lotSize,
      qty: config.lotsPerTrade * lotSize,
      entryPrice,
      lowestPrice: entryPrice,
      initialSl,
      trailingSl,
      targetPrice,
      status: 'OPEN',
      openedAt: Date.now(),
      realized: 0,
    };

    if (mode === 'REAL') {
      fetch('/api/scalper/fast-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityId: cand.securityId,
          quantity: config.lotsPerTrade * lotSize,
          side: 'SELL',
          orderType: 'MARKET',
          price: entryPrice,
          productType: 'INTRADAY',
          source: 'bds',
        }),
      })
        .then((r) => r.json())
        .then((j: { success?: boolean; error?: string; orderId?: string }) => {
          if (j.success) {
            mutateLedger({ op: 'open', position: newPos });
            addAuditLog(
              'ORDER',
              `[REAL MANUAL] Shorted ${config.lotsPerTrade}L ${cand.strike} ${cand.option} @ ₹${entryPrice.toFixed(1)}`,
            );
            toast.success(`[REAL] Short Filled: ${cand.strike} ${cand.option} @ ₹${entryPrice.toFixed(1)}`);
          } else {
            toast.error(`Order Rejected: ${j.error || 'Broker rejection'}`);
          }
        });
    } else {
      mutateLedger({ op: 'open', position: newPos });
      addAuditLog(
        'ORDER',
        `[SIM MANUAL] Shorted ${config.lotsPerTrade}L ${cand.strike} ${cand.option} @ ₹${entryPrice.toFixed(1)}`,
      );
      toast.success(`[SIM] Short Filled: ${cand.strike} ${cand.option} @ ₹${entryPrice.toFixed(1)}`);
    }
  };

  // ── 9. Close Position Action ──────────────────────────────────────
  const handleClosePosition = (id: string, currentLtp: number) => {
    const pos = positions.find((p) => p.id === id);
    if (pos) {
      executePositionExit(pos, currentLtp, 'MANUAL EXIT: Closed by user');
    }
  };

  // ── 10. Square Off All Action ─────────────────────────────────────
  const handleSquareOffAll = () => {
    if (!openPositions.length) return;
    if (!confirm(`Are you sure you want to close ALL ${openPositions.length} active positions?`)) return;

    for (const pos of openPositions) {
      const qLtp = quotesMap[`${pos.strike}${pos.option}`]?.ltp ?? pos.entryPrice;
      executePositionExit(pos, qLtp, 'MANUAL EXIT: Emergency Square Off All');
    }
    addAuditLog('WARN', `EMERGENCY SQUARE OFF: Closed all ${openPositions.length} open positions.`);
    toast.warning(`Closed all ${openPositions.length} active positions.`);
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
                onClick={() => setUnderlying(u)}
                className={cn(
                  'rounded-md px-2.5 py-1 transition-all',
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
              className="h-8 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-200 focus:outline-none focus:border-zinc-700"
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
        {/* 1. Market Direction Bias & Telemetry Strip */}
        <MarketBiasStrip
          underlying={underlying}
          trend={underlyingTrend}
          config={config}
          mode={mode}
          openCount={openPositions.length}
          realizedPnl={realizedPnl}
          unrealizedPnl={unrealizedPnl}
          onToggleEngine={() =>
            mutateLedger({
              op: 'setConfig',
              config: { engineActive: !config.engineActive },
            })
          }
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
          spot={underlyingTrend.spot}
          onManualShort={handleManualShort}
          isEngineActive={config.engineActive}
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
