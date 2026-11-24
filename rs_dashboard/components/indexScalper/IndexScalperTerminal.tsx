'use client';

// /index-scalper — TradingView-style NIFTY chart for scalping options. Dhan only.
//
// SIM (paper, never calls an order route) is the default. REAL is armed per page load and never persisted. Every REAL
// order goes through /api/scalper/fast-order tagged source 'isx' (server-side cap), carries an idempotency key, and an
// unknown outcome is reported, never retried. Exit quantities come from the broker's live position, not from UI state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, CandlestickChart, LayoutList, Maximize2, Minus, MousePointer2, RefreshCw, Ruler, Trash2, TrendingUp, Zap,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import DataChip, { toIsoDate } from '@/components/DataChip';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { scalperRoute } from '@/hooks/useBrokerSelector';
import ScalperChart, { type DrawTool } from './ScalperChart';
import OptionChainPanel, { type PickedContract } from './OptionChainPanel';
import OrderTicket, { type TicketRequest } from './OrderTicket';
import DhanScalperWidget from './DhanScalperWidget';
import AccountPanel from './AccountPanel';
import {
  fundsView, holdingRows, orderRows, positionRows, symbolLabel, type FundsView, type PositionRowView,
} from '@/lib/indexScalperAccount';
import IndicatorPicker from './IndicatorPicker';
import { useIndexScalperFeed } from './useIndexScalperFeed';
import {
  applyTick, mergeHistory, migrateIndicatorsV1, newIndicator, type Bar, type IndicatorInstance, type IndicatorKind,
} from '@/lib/indexScalperIndicators';
import { istDateIso, isRegularSession } from '@/lib/nseHolidays';
import { inMarketSession } from '@/lib/indexScalperSession';
import {
  INSTRUMENTS, dhanOrderQty, kotakOrderQty, pnlMultiplier, displayLotUnits, type Underlying,
} from '@/lib/indexScalperInstrument';
import {
  MAX_LOTS, applyFill, legsFromDhanPositions, orderUnits, ownedCloseOrder, ownedQtyFromOrders, type ScalperLeg,
} from '@/lib/indexScalperPositions';
import { closeOrderProduct } from '@/lib/positionProduct';
import {
  dashProduct, freezeSlices, heldByUnknown, kotakOrdersAsDhan, legsFromKotakPositions, ownedQtyFromKotakOrders, recordedIds,
  withResolvedUnknowns, type KotakRecord, type KotakSymbolInfo,
} from '@/lib/indexScalperKotak';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';

type Interval = '1' | '3' | '5' | '15';
const INTERVALS: Interval[] = ['1', '3', '5', '15'];
const RANGES: { label: string; days: number; focus: number }[] = [
  { label: '2M', days: 60, focus: 60 * 86400 }, { label: '1M', days: 30, focus: 30 * 86400 }, { label: '2W', days: 15, focus: 14 * 86400 },
  { label: '1W', days: 10, focus: 7 * 86400 }, { label: '3D', days: 10, focus: 3 * 86400 }, { label: '1D', days: 10, focus: 86400 },
];

const IND_KEY = 'indexScalper.indicators.v2';
const IND_KEY_V1 = 'indexScalper.indicators.v1';
const SIM_KEY = 'indexScalper.sim.v1';
const SPOT_KEY = 'indexScalper.entrySpots.v1';

interface SimLeg { securityId: string; symbol: string; strike: number; type: 'CE' | 'PE' | 'FUT'; netQty: number; avg: number; /** realized P&L of this leg today */ realized?: number }
interface SimState { day: string; legs: Record<string, SimLeg>; realized: number }

const istDayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const newKey = () => `isx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const nextId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function loadJson<T>(key: string, fallback: T): T {
  try { const raw = readPref(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function defaultIndicators(): IndicatorInstance[] {
  return [newIndicator('supertrend', nextId()), newIndicator('ema', nextId())];
}

interface Toast { ok: boolean; text: string }

const UNDERLYING_KEY = 'indexScalper.underlying';

export default function IndexScalperTerminal() {
  // Underlying instrument (NIFTY index or CRUDEOILM mini crude). Switching is locked while REAL is armed.
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  useEffect(() => {
    const u = readPref(UNDERLYING_KEY);
    if (u === 'NIFTY' || u === 'CRUDEOILM') setUnderlying(u);
  }, []);
  const selectUnderlying = (u: Underlying) => {
    if (real) return;
    setUnderlying(u);
    savePref(UNDERLYING_KEY, u);
  };

  // Broker for REAL orders and the account panel (Dhan or Kotak). Prices are always Dhan's live feed. The first render
  // is always Dhan; every account read and REAL send waits for `brokerLoaded` so a page saved on Kotak never touches
  // Dhan's account. The picker is locked while REAL is armed: a REAL session trades one account.
  const [broker, setBroker, brokerLoaded] = usePageBroker('indexScalper.broker');
  const brokerRef = useRef(broker);
  const brokerLoadedRef = useRef(brokerLoaded);
  useEffect(() => { brokerRef.current = broker; brokerLoadedRef.current = brokerLoaded; });
  const brokerName = broker === 'kotak' ? 'Kotak' : 'Dhan';
  const feed = useIndexScalperFeed(broker, underlying);

  const [interval, setIntervalSel] = useState<Interval>('5');
  const [days, setDays] = useState(15);
  // Range-button request; `seq` makes a repeat click of the same range a new request.
  const [focus, setFocus] = useState<{ seconds: number; seq: number } | null>(null);
  // REST history, tagged with the interval it was loaded for so a switch never mixes two intervals' bars.
  const [history, setHistory] = useState<{ interval: Interval; bars: Bar[] } | null>(null);
  const [liveBars, setLiveBars] = useState<Bar[]>([]);
  const [candleErr, setCandleErr] = useState<string | null>(null);
  const [loadingBars, setLoadingBars] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  const [indicators, setIndicators] = useState<IndicatorInstance[]>([]);
  const [indReady, setIndReady] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [tool, setTool] = useState<DrawTool>('cursor');
  const [clearToken, setClearToken] = useState(0);
  const [logScale, setLogScale] = useState(false);
  const [pctScale, setPctScale] = useState(false);
  const [autoScale, setAutoScale] = useState(true);

  // The chain and scalper widget are floating windows opened from toolbar buttons, not shown on load.
  const [chainOpen, setChainOpen] = useState(false);
  // One switch: the Scalper widget is open <=> one-click is armed (Buy CE / Buy PE and the chain's B / S trade at once).
  // Two flags drifted apart: closing the widget with its X left one-click armed with nothing on screen saying so.
  const [scalperOn, setScalperOn] = useState(false);
  const [ticket, setTicket] = useState<PickedContract | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState<Toast | null>(null);

  const [real, setReal] = useState(false);
  const [armOpen, setArmOpen] = useState(false);
  const [sim, setSim] = useState<SimState>({ day: istDayKey(), legs: {}, realized: 0 });
  const [simReady, setSimReady] = useState(false);
  const [entrySpots, setEntrySpots] = useState<Record<string, number>>({});
  const [realRows, setRealRows] = useState<Record<string, unknown>[]>([]);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [funds, setFunds] = useState<FundsView>(() => fundsView(null));
  // Dhan account reads for the bottom panel (read-only): order book and demat holdings.
  const [orderBook, setOrderBook] = useState<Record<string, unknown>[]>([]);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [holdingsRaw, setHoldingsRaw] = useState<Record<string, unknown>[]>([]);
  const [holdingsErr, setHoldingsErr] = useState<string | null>(null);
  const [holdingsLoaded, setHoldingsLoaded] = useState(false);
  // Kotak: the order IDs this page placed today (server day file), i.e. what it owns and may cancel on Kotak.
  const [kotakRecords, setKotakRecords] = useState<KotakRecord[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // REAL positions have been read successfully at least once since REAL was armed (the day P&L is unknown before).
  const [realLoaded, setRealLoaded] = useState(false);
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // One-click size: the widget's top stepper sets it; Buy CE / Buy PE and the chain's B / S use it too.
  const [scalpLots, setScalpLots] = useState(1);
  const [clock, setClock] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef(feed);
  const simRef = useRef(sim);
  useEffect(() => { feedRef.current = feed; simRef.current = sim; });

  const flash = useCallback((t: Toast) => {
    setToast(t);
    window.setTimeout(() => setToast(cur => (cur === t ? null : cur)), 6000);
  }, []);

  // ── persisted per-viewer state ─────────────────────────────────────
  useEffect(() => {
    const v2 = loadJson<IndicatorInstance[] | null>(IND_KEY, null);
    const v1 = v2 ? null : loadJson<IndicatorInstance[] | null>(IND_KEY_V1, null);
    const saved = v2 ?? (Array.isArray(v1) ? migrateIndicatorsV1(v1) : null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIndicators(Array.isArray(saved) ? saved : defaultIndicators());
    setIndReady(true);
    const s = loadJson<SimState | null>(SIM_KEY, null);
    if (s && s.day === istDayKey() && s.legs) setSim(s);
    setSimReady(true);
    const sp = loadJson<{ day: string; spots: Record<string, number> } | null>(SPOT_KEY, null);
    if (sp && sp.day === istDayKey()) setEntrySpots(sp.spots);
  }, []);
  useEffect(() => { if (indReady) savePref(IND_KEY, JSON.stringify(indicators)); }, [indicators, indReady]);
  useEffect(() => { if (simReady) savePref(SIM_KEY, JSON.stringify(sim)); }, [sim, simReady]);
  const rememberSpot = useCallback((id: string, spot: number | null) => {
    if (!spot) return;
    setEntrySpots(prev => {
      const next = { ...prev, [id]: spot };
      savePref(SPOT_KEY, JSON.stringify({ day: istDayKey(), spots: next }));
      return next;
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);

  // ── candles ────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingBars(true);
    const futParam = underlying === 'CRUDEOILM' && feed.future?.dhanId ? `&securityId=${feed.future.dhanId}` : '';
    fetch(`/api/index-scalper/candles?underlying=${underlying}&interval=${interval}&days=${days}${futParam}`)
      .then(r => r.json())
      .then((j: { success: boolean; candles?: { t: number; o: number; h: number; l: number; c: number }[]; error?: string }) => {
        if (dead) return;
        if (!j.success || !j.candles) { setCandleErr(j.error ?? 'No candles'); return; }
        setCandleErr(null);
        setHistory({ interval, bars: j.candles });
      })
      .catch(e => { if (!dead) setCandleErr(String(e?.message ?? e)); })
      .finally(() => { if (!dead) setLoadingBars(false); });
    return () => { dead = true; };
  }, [underlying, interval, days, refreshTick, feed.future?.dhanId]);

  // Live candles are built from the WebSocket ticks; the REST
  // history above is only the backfill: loaded per interval / range, and again after a gap the ticks cannot have covered
  // (the tab was hidden, or the feed went stale and came back). Nothing polls it on a timer.
  const liveIntervalRef = useRef<Interval | null>(null);
  useEffect(() => {
    if (!history || history.interval !== interval) {
      // Switched interval, history not loaded yet: show nothing rather than the old interval's bars, and take no ticks.
      liveIntervalRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLiveBars([]);
      return;
    }
    const same = liveIntervalRef.current === interval;
    liveIntervalRef.current = interval;
    setLiveBars(prev => (same ? mergeHistory(history.bars, prev, Number(interval), Date.now() / 1000) : history.bars));
  }, [history, interval]);

  useEffect(() => {
    const spot = feed.spot;
    if (spot === null || feed.stale || feed.feedAgeSec === null) return;
    // Outside market session, must not invent a candle.
    if (!inMarketSession(underlying, Date.now())) return;
    setLiveBars(prev => (liveIntervalRef.current === interval ? applyTick(prev, spot, Number(interval), Date.now() / 1000, underlying) : prev));
    // feed.stale / feedAgeSec are read as guards only: a new tick is what moves a bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.spot, feed.quotes, interval, underlying]);

  const wasStaleRef = useRef(false);
  useEffect(() => {
    if (wasStaleRef.current && !feed.stale && feed.feedAgeSec !== null) setRefreshTick(n => n + 1);
    wasStaleRef.current = feed.stale;
  }, [feed.stale, feed.feedAgeSec]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setRefreshTick(n => n + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── funds + REAL positions ─────────────────────────────────────────
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFunds(fundsView(null));
    if (!brokerLoaded) return;
    let dead = false;
    const load = () => fetch(scalperRoute(broker, 'funds')).then(r => r.json()).then((j: { success: boolean; data?: Record<string, unknown> }) => {
      if (dead || !j.success || !j.data) return;
      setFunds(fundsView(j.data));
    }).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [broker, brokerLoaded]);

  const loadKotakRecords = useCallback(async (): Promise<KotakRecord[] | null> => {
    if (brokerRef.current !== 'kotak') return [];
    try {
      const r = await fetch('/api/index-scalper/kotak-order');
      const j = await r.json() as { success: boolean; records?: KotakRecord[] };
      if (!j.success || !Array.isArray(j.records)) return null;
      setKotakRecords(j.records);
      return j.records;
    } catch { return null; }
  }, []);

  /** `fresh`: a live read for exit sizing. Display polls on Kotak go through the shared Kotak positions cache. */
  const loadPositions = useCallback(async (fresh = false): Promise<Record<string, unknown>[] | null> => {
    try {
      if (!brokerLoadedRef.current) return null;
      const kotakCached = brokerRef.current === 'kotak' && fresh !== true;
      const r = await fetch(kotakCached ? '/api/index-scalper/kotak-positions' : scalperRoute(brokerRef.current, 'positions'));
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !j.data) { setPosErr(j.error ?? 'Could not load positions'); return null; }
      setPosErr(null);
      setRealRows(j.data);
      setRealLoaded(true);
      return j.data;
    } catch (e) { setPosErr(String((e as Error).message ?? e)); return null; }
  }, []);

  // Order book reads: the timer skips while one is in flight or the tab is hidden, and only the newest request's reply
  // is applied (a slow old reply must not put a just-cancelled order back to PENDING). A read asked for by an action
  // (placement, cancel) always goes, superseding any in flight.
  const ordersSeqRef = useRef(0);
  const ordersInFlightRef = useRef(false);
  const loadOrders = useCallback(async (fromTimer = false) => {
    if (fromTimer && (ordersInFlightRef.current || document.visibilityState === 'hidden')) return;
    const seq = ++ordersSeqRef.current;
    ordersInFlightRef.current = true;
    try {
      if (!brokerLoadedRef.current) return;
      if (brokerRef.current === 'kotak') void loadKotakRecords();
      const r = await fetch(scalperRoute(brokerRef.current, 'orders'));
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (seq !== ordersSeqRef.current) return;
      if (!j.success || !Array.isArray(j.data)) { setOrdersErr(j.error ?? 'Could not load orders'); return; }
      setOrdersErr(null);
      setOrderBook(j.data);
    } catch (e) {
      if (seq === ordersSeqRef.current) setOrdersErr(String((e as Error).message ?? e));
    } finally {
      if (seq === ordersSeqRef.current) ordersInFlightRef.current = false;
    }
  }, [loadKotakRecords]);
  useEffect(() => {
    // the order book is read on mount (and on a broker change) and then every 5 s
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrderBook([]); setOrdersErr(null); setKotakRecords([]);
    if (!brokerLoaded) return;
    void loadOrders();
    // Kotak rate-limits its account reads (stCode 100025): its order book is read every 10 s, Dhan's every 5 s.
    const t = setInterval(() => { void loadOrders(true); }, broker === 'kotak' ? 10_000 : 5000);
    const onVis = () => { if (document.visibilityState === 'visible') void loadOrders(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [loadOrders, broker, brokerLoaded]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHoldingsRaw([]); setHoldingsLoaded(false); setHoldingsErr(null);
    if (!brokerLoaded) return;
    let dead = false;
    // Kotak holdings come from the equity ticket's read (quantity + average, no price: Holding P&L stays unknown there).
    const url = broker === 'kotak' ? '/api/equity-order/holdings?broker=kotak' : '/api/index-scalper/holdings';
    const load = () => fetch(url).then(r => r.json()).then((j: { success: boolean; data?: unknown; error?: string }) => {
      if (dead) return;
      const rows = broker === 'kotak' && j.success && j.data && typeof j.data === 'object' && !Array.isArray(j.data)
        ? Object.values(j.data as Record<string, { symbol?: string; securityId?: string; totalQty?: number; avgCost?: number }>)
          .map(h => ({ tradingSymbol: h.symbol, securityId: h.securityId ?? h.symbol, totalQty: h.totalQty, avgCostPrice: h.avgCost, lastTradedPrice: 0 }))
        : j.data;
      if (!j.success || !Array.isArray(rows)) { setHoldingsErr(j.error ?? 'Could not load holdings'); return; }
      setHoldingsErr(null);
      setHoldingsRaw(rows as Record<string, unknown>[]);
      setHoldingsLoaded(true);
    }).catch(e => { if (!dead) setHoldingsErr(String((e as Error)?.message ?? e)); });
    load();
    const t = setInterval(load, 60_000);
    return () => { dead = true; clearInterval(t); };
  }, [broker, brokerLoaded]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!real) { setRealRows([]); setPosErr(null); setRealLoaded(false); return; }
    loadPositions();
    const t = setInterval(() => { void loadPositions(); }, 3000);
    return () => clearInterval(t);
  }, [real, loadPositions, broker, brokerLoaded]);

  // ── legs shown on the chart ────────────────────────────────────────
  // A Kotak contract's live premium: Kotak rows carry no price, so they are priced off Dhan's feed through the
  // contract (expiry, strike, side). Only the expiry on screen is in the feed; anything else is unpriced (null).
  const kotakPrice = useCallback((info: KotakSymbolInfo): number | null => {
    if (info.side === 'FUT') {
      return (info.expiry === feed.future?.expiry || info.expiry === feed.expiry) ? feed.future?.ltp ?? null : null;
    }
    if (info.expiry !== feed.expiry) return null;
    const ids = feed.strikeIds.get(info.strike);
    const id = info.side === 'CE' ? ids?.ceId : ids?.peId;
    return id ? feed.ltpById.get(id) ?? null : null;
  }, [feed.expiry, feed.future, feed.strikeIds, feed.ltpById]);
  const kotakSymbols = feed.kotak?.symbols;

  const legs: ScalperLeg[] = useMemo(() => {
    if (real && broker === 'kotak') return legsFromKotakPositions(realRows, kotakSymbols ?? {}, kotakPrice, underlying);
    if (real) return legsFromDhanPositions(realRows, feed.ltpById, underlying);
    return Object.values(sim.legs).filter(l => l.netQty !== 0).map(l => {
      const live = feed.ltpById.get(l.securityId);
      return { id: l.securityId, securityId: l.securityId, product: '', symbol: l.symbol, strike: l.strike, type: l.type, netQty: l.netQty, avg: l.avg, ltp: live ?? null, sim: true, mult: 1 };
    });
  }, [real, broker, realRows, sim.legs, feed.ltpById, kotakSymbols, kotakPrice, underlying]);
  // Bottom panel rows: the REAL Dhan book (open + closed rows), or the SIM paper book in the same shape.
  const panelPositions: PositionRowView[] = useMemo(() => {
    if (real && broker === 'kotak') {
      // Kotak rows into the Dhan row shape: the trading symbol is the identity (in securityId, the repo rule), the
      // product in Dhan's words, contract fields from the symbol map, and NO unrealized figure (Kotak sends none: the
      // open part is priced off the live feed or stays unknown).
      const rows = realRows.map(r => {
        const sym = String(r.tradingSymbol ?? '');
        const info = kotakSymbols?.[sym];
        const isMcx = sym.startsWith('CRUDEOIL');
        return {
          ...r, securityId: sym, productType: dashProduct(r.productType), exchangeSegment: isMcx ? 'MCX_COMM' : 'NSE_FNO', unrealizedProfit: undefined,
          ...(info && info.side !== 'FUT' ? { drvExpiryDate: info.expiry, drvOptionType: info.side === 'CE' ? 'CALL' : 'PUT', drvStrikePrice: info.strike } : info ? { drvExpiryDate: info.expiry } : {}),
        };
      });
      return positionRows(rows, row => { const info = kotakSymbols?.[String(row.securityId ?? '')]; return info ? kotakPrice(info) ?? undefined : undefined; });
    }
    if (real) return positionRows(realRows, feed.ltpById);
    return Object.values(sim.legs).map(l => {
      const isFut = l.type === 'FUT';
      const m = /^([A-Z]+)-(\d{4}-\d{2}-\d{2})-/.exec(l.symbol);
      const root = m?.[1] ?? underlying;
      const live = feed.ltpById.get(l.securityId);
      const ltp = l.netQty !== 0 && live !== undefined && live > 0 ? live : null;
      const mult = pnlMultiplier(underlying, 'sim');
      const unrealized = l.netQty === 0 ? 0 : ltp !== null ? (ltp - l.avg) * l.netQty * mult : null;
      const realized = l.realized ?? 0;
      return {
        key: l.securityId, securityId: l.securityId,
        symbol: symbolLabel({
          tradingSymbol: root,
          drvExpiryDate: m?.[2] ?? '',
          drvStrikePrice: l.strike,
          drvOptionType: isFut ? 'FUT' : (l.type === 'CE' ? 'CALL' : 'PUT'),
        }),
        exchange: underlying === 'CRUDEOILM' ? 'MCX' : 'NSE',
        product: 'Intraday (SIM)', productCode: '', netQty: l.netQty, buyQty: null, sellQty: null, buyAvg: null, sellAvg: null,
        avg: l.netQty !== 0 ? l.avg : null, ltp, realized, unrealized, pnl: unrealized === null ? realized : realized + unrealized,
      };
    });
  }, [real, broker, realRows, sim.legs, feed.ltpById, kotakSymbols, kotakPrice, underlying]);
  const legForRow = useCallback((row: PositionRowView): ScalperLeg | undefined =>
    legs.find(l => (real ? l.id === `${row.securityId}|${row.productCode}` : l.id === row.securityId)), [legs, real]);
  const exitingRowKey = exitingId === null ? null : (panelPositions.find(r => legForRow(r)?.id === exitingId)?.key ?? 'busy');
  const panelOrders = useMemo(
    () => orderRows(broker === 'kotak' ? kotakOrdersAsDhan(orderBook, kotakSymbols ?? {}, recordedIds(withResolvedUnknowns(kotakRecords, orderBook))) : orderBook),
    [orderBook, broker, kotakSymbols, kotakRecords],
  );
  const panelHoldings = useMemo(() => holdingRows(holdingsRaw), [holdingsRaw]);

  // ── order placement ────────────────────────────────────────────────
  interface Outcome { ok: boolean; unknown?: boolean; text: string }

  /** One REAL order on the page's broker. Dhan: /api/scalper/fast-order (security id, `isx` correlation). Kotak: the
   *  page's own route, which records the order ID as this page's (trading symbol; opens capped, closes not). */
  const sendReal = useCallback(async (body: Record<string, unknown>, intent: 'open' | 'close' = 'open'): Promise<Outcome> => {
    try {
      const kotak = brokerRef.current === 'kotak';
      const res = await fetch(kotak ? '/api/index-scalper/kotak-order' : '/api/scalper/fast-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kotak
          ? { ...body, intent, idempotencyKey: newKey() }
          : { exchangeSegment: INSTRUMENTS[underlying].dhanSegment, ...body, source: 'isx', idempotencyKey: newKey() }),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string; unknown?: boolean; warning?: string };
      if (kotak) void loadKotakRecords();
      if (j.success) return { ok: true, text: `Order ${j.order_id ?? ''} placed${j.warning ? ` (${j.warning})` : ''}` };
      if (j.unknown || res.status === 504) return { ok: false, unknown: true, text: j.error ?? 'Order status unknown: check Positions / Orders before retrying' };
      return { ok: false, text: j.error ?? 'Order rejected' };
    } catch (e) {
      // A throw after the request left may still have booked it: report unknown, never retry.
      return { ok: false, unknown: true, text: `No reply (${String((e as Error).message ?? e)}). Check Positions / Orders before retrying` };
    }
  }, [loadKotakRecords, underlying]);

  const simFill = useCallback((c: PickedContract, side: 'BUY' | 'SELL', units: number, price: number, symbol: string) => {
    const id = c.securityId ?? `${c.type}${c.strike}`;
    // A fill that opens a position (from flat, or flipping through zero) anchors the chip at today's spot, as REAL does:
    // a leg closed and reopened later must not stay drawn at the first entry.
    const before = simRef.current.legs[id]?.netQty ?? 0;
    const after = before + (side === 'BUY' ? units : -units);
    const opens = after !== 0 && (before === 0 || Math.sign(after) !== Math.sign(before));
    setSim(prev => {
      const cur = prev.legs[id] ?? { securityId: id, symbol, strike: c.strike, type: c.type, netQty: 0, avg: 0 };
      const next = applyFill(cur.netQty, cur.avg, side, units, price);
      // realized P&L on the part that closed
      let realized = prev.realized;
      let legRealized = cur.realized ?? 0;
      const closing = cur.netQty !== 0 && Math.sign(cur.netQty) !== (side === 'BUY' ? 1 : -1);
      if (closing) {
        const closed = Math.min(Math.abs(cur.netQty), units);
        const r = (price - cur.avg) * closed * Math.sign(cur.netQty);
        realized += r;
        legRealized += r;
      }
      return { ...prev, realized, legs: { ...prev.legs, [id]: { ...cur, netQty: next.netQty, avg: next.avg, realized: legRealized } } };
    });
    if (opens) rememberSpot(id, feedRef.current.spot);
  }, [rememberSpot]);

  const placeContract = useCallback(async (req: TicketRequest): Promise<Outcome> => {
    const f = feedRef.current;
    const isCrude = underlying === 'CRUDEOILM';
    const isFut = req.contract.type === 'FUT';
    const defaultLot = isCrude ? 1 : 65;
    const size = orderUnits(req.lots, f.lotSize ?? defaultLot);
    if (!size.ok) return { ok: false, text: size.error };
    const c = req.contract;
    if (!c.securityId && !c.tradingSymbol) return { ok: false, text: 'No contract identifier for this order' };
    // The security id was picked for one expiry; never send it under a ticket that now shows another (except futures).
    if (!isFut && c.expiry !== f.expiry) return { ok: false, text: `This ticket was opened for the ${c.expiry || 'previous'} expiry: reopen it from the chain` };
    const live = (c.securityId ? f.ltpById.get(c.securityId) : null) ?? c.ltp ?? null;
    const symbol = isFut
      ? `${underlying}-${c.expiry}-FUT`
      : `${underlying}-${f.expiry}-${c.strike}-${c.type}`;

    if (!real) {
      if (req.orderType !== 'MARKET' && req.orderType !== 'LIMIT') return { ok: false, text: 'SIM fills market and marketable limit orders only' };
      if (!(live && live > 0)) return { ok: false, text: 'No live price to fill the paper order' };
      if (f.stale) return { ok: false, text: 'Live prices are stale: not filling a paper order on an old price' };
      if (!f.marketOpen) return { ok: false, text: `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed: paper orders fill only during the session` };
      let fillPx = live;
      if (req.orderType === 'LIMIT') {
        const lim = req.price ?? 0;
        const marketable = req.side === 'BUY' ? lim >= live : lim <= live;
        if (!marketable) return { ok: false, text: `Limit ${lim} is not marketable at ${live.toFixed(2)} (SIM does not rest orders)` };
        fillPx = live;
      }
      const simUnits = displayLotUnits(underlying, f.lotSize) * req.lots;
      simFill(c, req.side, simUnits, fillPx, symbol);
      return { ok: true, text: `SIM ${req.side} ${req.lots} lot${req.lots > 1 ? 's' : ''} ${isFut ? 'FUT' : `${c.strike} ${c.type}`} @ ${fillPx.toFixed(2)}` };
    }

    // A market order needs a live feed: stale ticks, or none at all (the chain may be a REST snapshot then), refuse it.
    if (req.orderType === 'MARKET' && !f.marketOpen) return { ok: false, text: `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed: refusing a market order` };
    if (req.orderType === 'MARKET' && (f.stale || f.feedAgeSec === null)) return { ok: false, text: f.stale ? 'Live prices are stale: refusing a market order' : 'No live prices (tick feed not running): refusing a market order' };
    if (!brokerLoadedRef.current) return { ok: false, text: 'Broker not loaded yet' };
    if (brokerRef.current === 'kotak') {
      // Kotak: its own trading symbol and lot size for the contract on screen, never the Dhan security id.
      const k = f.kotak;
      if (!k) return { ok: false, text: f.kotakError ?? 'Kotak contracts are still loading' };
      if (!isFut && k.expiry !== c.expiry) return { ok: false, text: 'Kotak contracts are for another expiry: wait for them to load' };
      const sym = isFut
        ? (f.future?.kotakSymbol ?? c.tradingSymbol)
        : (c.type === 'CE' ? k.strikes.get(c.strike)?.ceSymbol : k.strikes.get(c.strike)?.peSymbol);
      if (!sym) return { ok: false, text: `No Kotak contract for ${isFut ? 'FUT' : `${c.strike} ${c.type}`} on ${c.expiry}` };
      const kotakLot = isCrude ? 10 : (k.lotSize ?? 65);
      const kQty = kotakOrderQty(underlying, req.lots, kotakLot);
      const before = legs.find(l => l.securityId === sym)?.netQty ?? 0;
      const out = await sendReal({
        tradingSymbol: sym, quantity: kQty, side: req.side, orderType: req.orderType,
        price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, product: req.product,
      }, 'open');
      if (out.ok && before === 0) rememberSpot(sym, f.spot);
      loadPositions();
      void loadOrders();
      return out;
    }
    if (!c.securityId) return { ok: false, text: 'No Dhan security id for this contract' };
    const dQty = dhanOrderQty(underlying, req.lots, f.lotSize ?? defaultLot);
    const before = legs.find(l => l.securityId === c.securityId)?.netQty ?? 0;
    const out = await sendReal({
      securityId: c.securityId, quantity: dQty, side: req.side, orderType: req.orderType,
      exchangeSegment: INSTRUMENTS[underlying].dhanSegment,
      price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, productType: req.product,
    });
    if (out.ok && before === 0) rememberSpot(c.securityId, f.spot);
    loadPositions();
    void loadOrders();
    return out;
  }, [real, legs, sendReal, simFill, rememberSpot, loadPositions, loadOrders, underlying]);

  const submitTicket = useCallback(async (req: TicketRequest) => {
    if (ticketBusy) return;
    setTicketBusy(true); setTicketMsg(null);
    const out = await placeContract(req);
    setTicketMsg({ ok: out.ok, text: out.text });
    setTicketBusy(false);
  }, [placeContract, ticketBusy]);

  // ── exits ──────────────────────────────────────────────────────────
  const exitSimLeg = useCallback((leg: ScalperLeg): Outcome => {
    if (leg.ltp === null) return { ok: false, text: 'No live price to close the paper position' };
    // Same rule as a paper entry: never book P&L on a price the feed stopped updating.
    if (feedRef.current.stale) return { ok: false, text: 'Live prices are stale: not closing a paper position on an old price' };
    if (!feedRef.current.marketOpen) return { ok: false, text: `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed: paper positions close only during the session` };
    const sl = sim.legs[leg.id];
    if (!sl || sl.netQty === 0) return { ok: true, text: 'Already flat' };
    simFill({ strike: sl.strike, type: sl.type, securityId: sl.securityId, ltp: leg.ltp, expiry: '' }, sl.netQty > 0 ? 'SELL' : 'BUY', Math.abs(sl.netQty), leg.ltp, sl.symbol);
    return { ok: true, text: `SIM closed ${sl.strike} ${sl.type} @ ${leg.ltp.toFixed(2)}` };
  }, [sim.legs, simFill]);

  /** Signed units this page's own (`isx`-tagged) orders filled today, per security + product, from Dhan's order book.
   *  null when the book cannot be read: an exit is then refused rather than sized off the broker's whole position. */
  const loadOwned = useCallback(async (): Promise<{ owned: Map<string, number>; records: KotakRecord[]; book: Record<string, unknown>[] } | null> => {
    try {
      if (brokerRef.current === 'kotak') {
        // Kotak: what THIS page's recorded order IDs filled, from Kotak's own order book.
        const [records, r] = await Promise.all([loadKotakRecords(), fetch(scalperRoute('kotak', 'orders'))]);
        const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (!records || !j.success || !Array.isArray(j.data)) return null;
        return { owned: ownedQtyFromKotakOrders(j.data, records), records, book: j.data };
      }
      const r = await fetch('/api/scalper/orders');
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
      return j.success && Array.isArray(j.data) ? { owned: ownedQtyFromOrders(j.data), records: [], book: [] } : null;
    } catch { return null; }
  }, [loadKotakRecords]);

  /** Close what THIS page opened on one broker row (security + product), clamped by what the broker still shows.
   *  Quantity a strategy, another terminal or a manual order holds on the same contract is never touched. */
  const exitRealRow = useCallback(async (leg: ScalperLeg, owned: Map<string, number>, records: KotakRecord[] = [], book: Record<string, unknown>[] = []): Promise<Outcome & { skipped?: boolean }> => {
    const label = `${leg.strike} ${leg.type}${leg.product ? ` ${leg.product}` : ''}`;
    const kotak = brokerRef.current === 'kotak';
    // Kotak: an order on this contract whose outcome is unknown may still fill; an exit sized before it lands could flip.
    if (kotak && heldByUnknown(records, leg.securityId, Date.now(), 60_000, book)) {
      return { ok: false, text: `${label}: an order on this contract has an unknown outcome; exit held for up to 60 s (check Orders)` };
    }
    const order = ownedCloseOrder(leg.netQty, owned.get(leg.id) ?? 0);
    if (!order) return { ok: false, skipped: true, text: `${label}: not opened from this page today, left open (square it off where it was opened)` };
    const product = closeOrderProduct(kotak ? 'kotak' : 'dhan', kotak ? (leg.product === 'MARGIN' ? 'NRML' : leg.product === 'INTRADAY' ? 'MIS' : leg.product) : leg.product);
    if (!product || product.assumed) return { ok: false, text: `${label}: unsupported or missing product "${leg.product}", square it off at the broker` };
    let out: Outcome;
    if (kotak) {
      // Above the exchange freeze quantity a single order is rejected: close in freeze-sized slices, stopping at the
      // first one that is not placed (an unknown slice is never followed by another).
      const k = feedRef.current.kotak;
      const slices = freezeSlices(order.units, k?.freezeQty ?? null, k?.lotSize ?? null);
      let sent = 0;
      out = { ok: true, text: 'Closed' };
      for (const q of slices) {
        out = await sendReal({ tradingSymbol: leg.securityId, quantity: q, side: order.side, orderType: 'MARKET', product: leg.product }, 'close');
        if (!out.ok) break;
        sent += q;
      }
      if (slices.length > 1) {
        out = out.ok
          ? { ...out, text: `${label}: closed ${sent} in ${slices.length} orders (exchange freeze limit)` }
          : { ...out, text: `${label}: ${sent} of ${order.units} closed, then: ${out.text}` };
      }
    } else {
      out = await sendReal({ securityId: leg.securityId, quantity: order.units, side: order.side, orderType: 'MARKET', ...product.fields });
    }
    if (out.ok && order.units < Math.abs(leg.netQty)) {
      return { ...out, text: `${out.text}: closed ${order.units} of ${Math.abs(leg.netQty)}, the rest was not opened from this page` };
    }
    return out;
  }, [sendReal]);

  /** Fresh broker rows + ownership, read together right before an exit. */
  const readExitState = useCallback(async (): Promise<{ live: ScalperLeg[]; owned: Map<string, number>; records: KotakRecord[]; book: Record<string, unknown>[] } | string> => {
    const [rows, own] = await Promise.all([loadPositions(true), loadOwned()]);
    if (!rows) return 'Could not read live positions: nothing was closed';
    if (!own) return 'Could not read the order book to tell which quantity this page opened: nothing was closed';
    const f = feedRef.current;
    if (brokerRef.current === 'kotak' && !f.kotak) return `${f.kotakError ?? 'Kotak contracts are not loaded yet'}: nothing was closed`;
    const live = brokerRef.current === 'kotak'
      ? legsFromKotakPositions(rows, f.kotak?.symbols ?? {}, () => null, underlying)
      : legsFromDhanPositions(rows, f.ltpById, underlying);
    return { live, owned: own.owned, records: own.records, book: own.book };
  }, [loadPositions, loadOwned, underlying]);

  const exitLeg = useCallback(async (leg: ScalperLeg) => {
    if (exitingId) return;
    setExitingId(leg.id);
    try {
      let out: Outcome;
      if (!real) out = exitSimLeg(leg);
      else {
        const st = await readExitState();
        if (typeof st === 'string') out = { ok: false, text: st };
        else {
          const row = st.live.find(l => l.id === leg.id);
          out = row ? await exitRealRow(row, st.owned, st.records, st.book) : { ok: true, text: 'Already flat' };
        }
        loadPositions();
      }
      flash({ ok: out.ok, text: out.text });
    } finally { setExitingId(null); }
  }, [exitingId, real, exitSimLeg, readExitState, exitRealRow, loadPositions, flash]);

  const exitAll = useCallback(async () => {
    if (exitingId || legs.length === 0) return;
    setExitingId('all');
    try {
      if (!real) {
        let failed = 0;
        for (const l of legs) { const o = exitSimLeg(l); if (!o.ok) failed++; }
        flash({ ok: failed === 0, text: failed ? `${failed} paper leg(s) not closed: no live price, or prices are stale` : 'SIM: all positions closed' });
        return;
      }
      const st = await readExitState();
      if (typeof st === 'string') { flash({ ok: false, text: st }); return; }
      // One pass per broker row (legs are already one per security + product, duplicates collapsed), so no row is
      // closed twice. Cover shorts before selling longs so a hedge is never gone while its short is still open.
      const ordered = [...st.live.filter(l => l.netQty < 0), ...st.live.filter(l => l.netQty > 0)];
      const problems: string[] = [];
      let skipped = 0;
      let sent = 0;
      for (const l of ordered) {
        const o = await exitRealRow(l, st.owned, st.records, st.book);
        if (o.skipped) { skipped++; continue; }
        if (!o.ok) { problems.push(o.text); if (o.unknown) break; continue; }
        sent++;
      }
      const note = skipped ? ` · ${skipped} leg(s) not opened from this page left open` : '';
      flash({
        ok: problems.length === 0,
        text: problems.length ? `Exit All incomplete: ${problems.join(' · ')}${note}` : `Exit All sent for ${sent} leg(s) opened from this page${note}`,
      });
      loadPositions();
    } finally { setExitingId(null); }
  }, [exitingId, legs, real, exitSimLeg, readExitState, exitRealRow, loadPositions, flash]);

  // ── one-click scalper (buy ATM CE / PE) ────────────────────────────
  const atmContract = useCallback((type: 'CE' | 'PE'): PickedContract | null => {
    const q = feed.quotes;
    if (!q || !q.atm) return null;
    const ids = feed.strikeIds.get(q.atm);
    const sd = q.strikes?.[String(q.atm)] ?? Object.values(q.strikes ?? {}).find(r => r.strike === q.atm);
    const id = type === 'CE' ? ids?.ceId : ids?.peId;
    const ltp = type === 'CE' ? sd?.ce?.ltp : sd?.pe?.ltp;
    const prevClose = type === 'CE' ? sd?.ce?.prev_close : sd?.pe?.prev_close;
    const finalLtp = ltp && ltp > 0 ? ltp : (prevClose && prevClose > 0 ? prevClose : null);
    const kotakSym = type === 'CE' ? feed.kotak?.strikes?.get(q.atm)?.ceSymbol : feed.kotak?.strikes?.get(q.atm)?.peSymbol;
    return {
      strike: q.atm,
      type,
      securityId: id ?? kotakSym ?? null,
      ltp: finalLtp,
      expiry: feed.expiry,
      tradingSymbol: kotakSym,
    };
  }, [feed.quotes, feed.strikeIds, feed.kotak, feed.expiry]);

  /** Cancel one of THIS page's working orders (the panel offers it only for isx-tagged ones). */
  const cancelOrder = useCallback(async (orderId: string) => {
    if (cancellingId) return;
    setCancellingId(orderId);
    try {
      const r = brokerRef.current === 'kotak'
        ? await fetch('/api/scalper/kotak/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId }) })
        : await fetch('/api/scalper/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, broker: 'dhan' }) });
      const j = await r.json() as { success: boolean; error?: string };
      flash({ ok: j.success, text: j.success ? `Cancel sent for order ${orderId}` : (j.error ?? 'Cancel failed') });
    } catch (e) {
      flash({ ok: false, text: `Cancel: no reply (${String((e as Error).message ?? e)}). Check Orders before retrying` });
    } finally {
      setCancellingId(null);
      void loadOrders();
    }
  }, [cancellingId, flash, loadOrders]);

  // One click, one order: a ref (not state) so a fast double click cannot send twice before React re-renders.
  const oneClickBusyRef = useRef(false);
  /** Buy CE / Buy PE and the chain's B / S. In one-click (Scalper) mode: a MARKET order now, sized by the Scalper lots,
   *  through placeContract's guards (live price, stale feed, lot cap, expiry match, SIM vs REAL). Otherwise: the ticket. */
  const tradeNow = useCallback(async (c: PickedContract, side: 'BUY' | 'SELL') => {
    if (!scalperOn) { setTicket(c); setTicketMsg(null); return; }
    if (oneClickBusyRef.current || ticketBusy) return;
    oneClickBusyRef.current = true;
    setTicketBusy(true);
    try {
      const out = await placeContract({ contract: c, side, orderType: 'MARKET', price: null, trigger: null, product: 'INTRADAY', lots: scalpLots });
      flash({ ok: out.ok, text: out.text });
    } finally {
      oneClickBusyRef.current = false;
      setTicketBusy(false);
    }
  }, [scalperOn, ticketBusy, placeContract, scalpLots, flash]);

  const quickBuy = useCallback((type: 'CE' | 'PE') => {
    const c = atmContract(type);
    if (!c) { flash({ ok: false, text: 'ATM contract not ready yet' }); return; }
    void tradeNow(c, 'BUY');
  }, [atmContract, tradeNow, flash]);

  const quickTradeFut = useCallback((side: 'BUY' | 'SELL') => {
    const f = feed.future;
    const isKotak = brokerRef.current === 'kotak';
    if (!f || (isKotak ? !f.kotakSymbol : !f.dhanId)) {
      flash({ ok: false, text: 'Future contract not ready yet' });
      return;
    }
    const c: PickedContract = {
      strike: 0,
      type: 'FUT',
      securityId: f.dhanId ?? f.kotakSymbol ?? 'FUT',
      ltp: f.ltp,
      expiry: f.expiry ?? feed.expiry,
      tradingSymbol: f.kotakSymbol ?? undefined,
    };
    void tradeNow(c, side);
  }, [feed.future, feed.expiry, tradeNow, flash]);

  const onTradeContract = useCallback(async (
    c: PickedContract,
    side: 'BUY' | 'SELL',
    lots: number,
    product: 'INTRADAY' | 'MARGIN' = 'INTRADAY'
  ): Promise<{ ok: boolean; text: string }> => {
    if (oneClickBusyRef.current || ticketBusy) return { ok: false, text: 'Order in progress' };
    oneClickBusyRef.current = true;
    setTicketBusy(true);
    try {
      const out = await placeContract({
        contract: c,
        side,
        orderType: 'MARKET',
        price: null,
        trigger: null,
        product,
        lots,
      });
      flash({ ok: out.ok, text: out.text });
      return out;
    } finally {
      oneClickBusyRef.current = false;
      setTicketBusy(false);
    }
  }, [ticketBusy, placeContract, flash]);

  // ── REAL arming ────────────────────────────────────────────────────
  const goSim = () => { setReal(false); };

  // ── indicators ─────────────────────────────────────────────────────
  const addIndicator = (k: IndicatorKind) => { setIndicators(p => [...p, newIndicator(k, nextId())]); setPickerOpen(false); };
  const patchIndicator = (id: string, patch: Partial<IndicatorInstance>) => setIndicators(p => p.map(i => (i.id === id ? { ...i, ...patch } : i)));
  const removeIndicator = (id: string) => setIndicators(p => p.filter(i => i.id !== id));

  // A ticket belongs to the expiry it was picked under (its security id is that expiry's): close it on a switch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTicket(cur => (cur && cur.expiry !== feed.expiry ? null : cur));
  }, [feed.expiry]);

  const ticketLtp = useMemo(() => {
    if (!ticket?.securityId) return null;
    return feed.ltpById.get(ticket.securityId) ?? null;
  }, [ticket, feed.ltpById]);

  const lastBar = liveBars[liveBars.length - 1];
  const dataDate = lastBar ? toIsoDate(String(lastBar.t)) : null;
  // Live spot; else the chain snapshot's index price (Dhan's official close on a closed day: the intraday candles stop at
  // the value frozen at 15:15, which is not the close); else the last candle.
  const spotDisplay = feed.spot ?? feed.chain?.spot ?? lastBar?.c ?? null;
  const notLive = feed.feedAgeSec === null && feed.chainSource === 'snapshot';

  const btn = 'h-7 px-2 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 transition-colors';
  const sep = <span className="w-px h-5 bg-zinc-800 shrink-0" />;

  const toolBtn = (t: DrawTool, label: string, Icon: typeof Minus) => (
    <button key={t} type="button" aria-label={label} title={label} aria-pressed={tool === t} onClick={() => setTool(tool === t ? 'cursor' : t)}
      className={cn('w-9 h-9 flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
        tool === t ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:text-white hover:bg-zinc-800')}>
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );

  return (
    <div ref={rootRef} data-testid="index-scalper" className={cn('flex flex-col h-screen overflow-hidden bg-zinc-950 text-white', real && 'ring-2 ring-inset ring-rose-600/70')}>
      {/* header toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 h-11 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div role="group" aria-label="Underlying" className="flex rounded border border-zinc-700 overflow-hidden" title={real ? 'Switch to SIM to change underlying: a REAL session trades one account' : undefined}>
            <button
              type="button"
              aria-pressed={underlying === 'NIFTY'}
              disabled={real}
              onClick={() => selectUnderlying('NIFTY')}
              className={cn('h-7 px-2 text-xs font-bold transition-colors disabled:opacity-50', underlying === 'NIFTY' ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}
            >
              NIFTY
            </button>
            <button
              type="button"
              aria-pressed={underlying === 'CRUDEOILM'}
              disabled={real}
              onClick={() => selectUnderlying('CRUDEOILM')}
              className={cn('h-7 px-2 text-xs font-bold transition-colors disabled:opacity-50', underlying === 'CRUDEOILM' ? 'bg-amber-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}
            >
              CRUDEOILM
            </button>
          </div>
          {sep}
          <div role="group" aria-label="Timeframe" className="flex items-center">
            {INTERVALS.map(i => (
              <button key={i} type="button" aria-pressed={interval === i} onClick={() => setIntervalSel(i)}
                className={cn(btn, interval === i && 'bg-zinc-800 text-white')}>{i}m</button>
            ))}
          </div>
          {sep}
          <button type="button" onClick={() => { setEditId(null); setPickerOpen(true); }} className={cn(btn, 'flex items-center gap-1')}>
            <BarChart3 className="w-4 h-4" />Indicators{indicators.length > 0 && <span className="text-sky-400">{indicators.length}</span>}
          </button>
          {sep}
          {underlying === 'CRUDEOILM' && (
            <>
              <button
                type="button"
                onClick={() => quickTradeFut('BUY')}
                className="h-7 px-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              >
                Buy FUT
              </button>
              <button
                type="button"
                onClick={() => quickTradeFut('SELL')}
                className="h-7 px-2.5 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
              >
                Sell FUT
              </button>
            </>
          )}
          <button type="button" onClick={() => quickBuy('PE')} className="h-7 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300">Buy PE</button>
          <button type="button" onClick={() => quickBuy('CE')} className="h-7 px-3 rounded bg-sky-600 hover:bg-sky-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">Buy CE</button>
          <button type="button" aria-pressed={scalperOn} onClick={() => setScalperOn(v => !v)}
            title="Scalper: opens the instant-order window and arms one-click (Buy CE / Buy PE and the chain's B / S trade at once). Close it to disarm."
            className={cn('h-7 px-2 rounded border text-xs font-bold flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
              scalperOn ? 'border-amber-400 text-amber-300 bg-amber-500/10' : 'border-sky-500/60 text-sky-300 hover:bg-sky-500/10')}>
            <Zap className="w-3.5 h-3.5" />Scalper
          </button>
          {sep}
          <button type="button" aria-pressed={chainOpen} aria-label="Option chain" title="Option chain" onClick={() => setChainOpen(v => !v)} className={cn(btn, chainOpen && 'bg-zinc-800 text-white')}><LayoutList className="w-4 h-4" /></button>
          <button type="button" aria-label="Refresh candles" title="Refresh candles" onClick={() => setRefreshTick(n => n + 1)} className={btn}><RefreshCw className={cn('w-4 h-4', loadingBars && 'animate-spin')} /></button>
          <button type="button" disabled={legs.length === 0 || exitingId !== null} onClick={exitAll}
            className="h-7 px-2 rounded border border-rose-500/70 text-rose-300 hover:bg-rose-500/10 text-xs font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
            Exit All
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn('text-[11px] tabular-nums font-mono', feed.stale ? 'text-amber-400' : 'text-zinc-400')} title="Live tick bridge">
            {spotDisplay ? spotDisplay.toFixed(2) : '—'} <span className={cn('inline-block w-1.5 h-1.5 rounded-full align-middle', feed.feedAgeSec === null ? 'bg-zinc-600' : feed.stale ? 'bg-amber-400' : 'bg-emerald-400')} />
          </span>
          <BrokerPicker value={broker} onChange={setBroker} brokers={['dhan', 'kotak']} disabled={real || !brokerLoaded}
            disabledReason={real ? 'Switch to SIM to change the broker: a REAL session trades one account' : 'Loading the saved broker'} />
          <div role="group" aria-label="Order mode" className="flex rounded border border-zinc-700 overflow-hidden">
            <button type="button" aria-pressed={!real} onClick={goSim} className={cn('h-7 px-2 text-xs font-bold', !real ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400 hover:bg-zinc-800')}>SIM</button>
            <button type="button" aria-pressed={real} onClick={() => (real ? undefined : setArmOpen(true))} className={cn('h-7 px-2 text-xs font-bold', real ? 'bg-rose-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}>REAL</button>
          </div>
          <DataChip date={dataDate} />
          <button type="button" aria-label="Fullscreen" title="Fullscreen" className={btn}
            onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void rootRef.current?.requestFullscreen?.(); }}><Maximize2 className="w-4 h-4" /></button>
          <NavBar compact />
        </div>
      </div>

      {(candleErr || posErr || feed.stale || notLive || !feed.marketOpen || feed.kotakError) && (
        <div role="alert" className="px-3 py-1 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
          {candleErr && <span className="mr-3">Candles: {candleErr}</span>}
          {posErr && <span className="mr-3">Positions: {posErr}</span>}
          {feed.kotakError && <span data-testid="kotak-error" className="mr-3">{feed.kotakError}: Kotak orders and exits wait for it.</span>}
          {!feed.marketOpen && <span data-testid="market-closed" className="mr-3">{underlying === 'CRUDEOILM' ? 'MCX is closed (session 09:00-23:30/23:55 IST)' : 'NSE is closed (session 09:15-15:30 IST)'}: paper fills and market orders are off.</span>}
          {notLive && <span className="mr-3">No live ticks (market closed or the tick bridge is not running): the option chain is Dhan&apos;s last snapshot, and market orders are refused.</span>}
          {feed.stale && <span>Live ticks are stale ({Math.round(feed.feedAgeSec ?? 0)}s): market closed or bridge down. Market orders are refused.</span>}
        </div>
      )}

      {/* body: drawing toolbar + chart */}
      <div className="flex flex-1 min-h-0">
        <div className="w-11 shrink-0 border-r border-zinc-800 flex flex-col items-center py-2 gap-1">
          {toolBtn('cursor', 'Cursor', MousePointer2)}
          {toolBtn('trend', 'Trend line (two clicks)', TrendingUp)}
          {toolBtn('hline', 'Horizontal line (one click)', Minus)}
          {toolBtn('ruler', 'Measure (two clicks)', Ruler)}
          <button type="button" aria-label="Remove all drawings" title="Remove all drawings" onClick={() => setClearToken(n => n + 1)}
            className="w-9 h-9 flex items-center justify-center rounded text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"><Trash2 className="w-[18px] h-[18px]" /></button>
        </div>

        <div className="relative flex-1 min-w-0 min-h-0">
          {indReady && (
            <ScalperChart
              bars={liveBars} indicators={indicators} tool={tool} onToolDone={() => setTool('cursor')} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} exitingId={exitingId}
              onToggleIndicator={id => setIndicators(p => p.map(i => (i.id === id ? { ...i, visible: !i.visible } : i)))}
              onRemoveIndicator={removeIndicator} onEditIndicator={id => { setEditId(id); setPickerOpen(true); }}
              symbolLabel={underlying === 'CRUDEOILM' ? `CRUDEOILM · ${interval} · FUT` : `NIFTY · ${interval} · IDX`} focus={focus}
            />
          )}
          {liveBars.length === 0 && !loadingBars && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500 pointer-events-none">No candles to show{candleErr ? '' : ' yet'}.</div>
          )}
          {toast && (
            <div role="status" className={cn('absolute left-1/2 -translate-x-1/2 bottom-4 z-30 max-w-[70%] px-3 py-2 rounded border text-xs font-semibold',
              toast.ok ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-rose-500/15 text-rose-300 border-rose-500/40')}>{toast.text}</div>
          )}
        </div>
      </div>

      {/* range strip */}
      <div className="flex items-center justify-between px-3 h-8 border-t border-zinc-800 text-[11px] text-zinc-400 shrink-0">
        <div className="flex items-center gap-1">
          {RANGES.map(r => (
            <button key={r.label} type="button" className={btn} onClick={() => { setDays(r.days); setFocus(f => ({ seconds: r.focus, seq: (f?.seq ?? 0) + 1 })); }}>{r.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 tabular-nums font-mono">
          <span>{clock} (UTC+05:30)</span>
          <button type="button" aria-pressed={pctScale} onClick={() => { setPctScale(v => !v); setLogScale(false); }} className={cn('hover:text-white', pctScale && 'text-sky-400')}>%</button>
          <button type="button" aria-pressed={logScale} onClick={() => { setLogScale(v => !v); setPctScale(false); }} className={cn('hover:text-white', logScale && 'text-sky-400')}>log</button>
          <button type="button" aria-pressed={autoScale} onClick={() => setAutoScale(v => !v)} className={cn('hover:text-white', autoScale && 'text-sky-400')}>auto</button>
        </div>
      </div>

      {/* account panel (Dhan-style) */}
      <AccountPanel
        real={real}
        brokerName={brokerName}
        positions={panelPositions}
        positionsLoaded={real ? realLoaded && !posErr : true}
        canExit={r => r.netQty !== 0 && !!legForRow(r)}
        onExit={r => { const l = legForRow(r); if (l) void exitLeg(l); }}
        exitingKey={exitingRowKey}
        orders={panelOrders}
        onCancelOrder={id => void cancelOrder(id)}
        cancellingId={cancellingId}
        holdings={panelHoldings}
        holdingsLoaded={holdingsLoaded && !holdingsErr}
        funds={funds}
        errors={{ positions: real ? posErr : null, orders: ordersErr, holdings: holdingsErr }}
      />

      {scalperOn && (
        <DhanScalperWidget
          feed={feed}
          real={real}
          broker={broker}
          busy={ticketBusy}
          topLots={scalpLots}
          onTopLotsChange={setScalpLots}
          onTradeContract={onTradeContract}
          onClose={() => setScalperOn(false)}
        />
      )}
      {chainOpen && (
        <OptionChainPanel feed={feed} onClose={() => setChainOpen(false)} onPick={c => { setTicket(c); setTicketMsg(null); }}
          onTrade={(c, side) => void tradeNow(c, side)} oneClick={scalperOn} />
      )}
      {ticket && (
        <OrderTicket key={`${ticket.expiry}:${ticket.strike}${ticket.type}`} contract={ticket} liveLtp={ticketLtp} expiry={ticket.expiry} lotSize={feed.lotSize}
          underlying={underlying} real={real} available={funds.available} busy={ticketBusy} message={ticketMsg} onSubmit={submitTicket} onClose={() => setTicket(null)} />
      )}
      <IndicatorPicker open={pickerOpen} indicators={indicators} editId={editId} onAdd={addIndicator} onChange={patchIndicator}
        onRemove={removeIndicator} onEdit={setEditId} onClose={() => { setPickerOpen(false); setEditId(null); }} />

      {armOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
          <div role="alertdialog" aria-label="Arm real orders" className="w-[380px] rounded-lg border border-rose-500/70 bg-zinc-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-rose-300 mb-2">Arm REAL orders on {brokerName}?</h2>
            <p className="text-xs text-zinc-300 mb-4">Buy/Sell, Scalper and Exit will place live orders with real money on your {brokerName} account (max {MAX_LOTS} lots per order). The chart then shows your {brokerName} {underlying} positions; prices stay Dhan&apos;s live feed. REAL is switched off again whenever this page reloads.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setArmOpen(false)} className="h-8 px-3 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button type="button" autoFocus disabled={!brokerLoaded} onClick={() => { if (brokerLoaded) { setReal(true); setArmOpen(false); } }} className="h-8 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold disabled:opacity-50">Arm REAL on {brokerName}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

