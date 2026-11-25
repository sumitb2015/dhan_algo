'use client';

// /index-scalper — TradingView-style NIFTY chart for scalping options. Dhan only.
//
// SIM (paper, never calls an order route) is the default. REAL is armed per page load and never persisted. Every REAL
// order goes through /api/scalper/fast-order tagged source 'isx' (server-side cap), carries an idempotency key, and an
// unknown outcome is reported, never retried. Exit quantities come from the broker's live position, not from UI state:
// Exit / Exit All / "-" close ANY position on the underlying (opened here, in the mobile app, another terminal or a
// strategy), sized off a fresh broker read so an exit can never flip a position.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, CandlestickChart, Columns2, LayoutList, Square, AlignRight, Crosshair, Settings2, Maximize2, Minus, MousePointer2, RefreshCw, Ruler, Trash2, TrendingUp, Zap,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import DataChip from '@/components/DataChip';
import IstClock from './IstClock';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { scalperRoute } from '@/hooks/useBrokerSelector';
import { type DrawTool } from './ScalperChart';
import ChartPane, { type PaneCfg } from './ChartPane';
import OptionChainPanel, { type PickedContract } from './OptionChainPanel';
import OrderTicket, { type TicketRequest, type TicketOrderType } from './OrderTicket';
import DhanScalperWidget from './DhanScalperWidget';
import AccountPanel from './AccountPanel';
import {
  fundsView, holdingRows, orderRows, positionRows, symbolLabel, type FundsView, type PositionRowView,
} from '@/lib/indexScalperAccount';
import IndicatorPicker from './IndicatorPicker';
import { useIndexScalperFeed } from './useIndexScalperFeed';
import {
  migrateIndicatorsV1, newIndicator, type IndicatorInstance, type IndicatorKind,
} from '@/lib/indexScalperIndicators';
import { istDateIso, isRegularSession } from '@/lib/nseHolidays';
import {
  INSTRUMENTS, dhanOrderQty, kotakOrderQty, pnlMultiplier, lotUnits, qtyLots, nrmlOnly, openingProduct, type Underlying,
} from '@/lib/indexScalperInstrument';
import {
  MAX_LOTS, applyFill, brokerCloseOrder, legsFromDhanPositions, legsKey, orderUnits, type ScalperLeg,
} from '@/lib/indexScalperPositions';
import { closeOrderProduct } from '@/lib/positionProduct';
import {
  dashProduct, freezeSlices, heldByUnknown, kotakOrdersAsDhan, legsFromKotakPositions, recordedIds,
  withResolvedUnknowns, type KotakRecord, type KotakSymbolInfo,
} from '@/lib/indexScalperKotak';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import type { OiMode } from '@/lib/indexScalperOiProfile';
import { QUICK_ON_KEY, QUICK_SETTINGS_KEY, DEFAULT_QUICK, MAX_QUICK_RANGE, clampQuickSettings, lotsToRemove, type QuickSettings } from '@/lib/indexScalperQuickTrade';

// v2: v1 could hold an ATM pin taken before any spot was known (the middle of the strike list, e.g. 24200). v1 is
// read for the layout, instruments and timeframes only; its option strikes go back to ATM.
const LAYOUT_KEY = 'indexScalper.layout.v2';
const LAYOUT_KEY_V1 = 'indexScalper.layout.v1';
const OI_KEY = 'indexScalper.oiProfile';
const OI_MODE_KEY = 'indexScalper.oiMode';
/** Default panes: the underlying, and its ATM CE (strike 0 resolves to ATM once, then stays pinned). */
const DEFAULT_PANES: [PaneCfg, PaneCfg] = [
  { source: { kind: 'underlying' }, interval: '5' },
  { source: { kind: 'option', type: 'CE', strike: 0 }, interval: '5' },
];
interface PaneStatus { date: string | null; loading: boolean; error: string | null }
const NO_STATUS: PaneStatus = { date: null, loading: true, error: null };

function validPane(x: unknown, fallback: PaneCfg): PaneCfg {
  const c = x as Partial<PaneCfg> | null;
  const iv = c?.interval;
  const interval = iv === '1' || iv === '3' || iv === '5' || iv === '15' ? iv : fallback.interval;
  const src = c?.source as PaneCfg['source'] | undefined;
  if (src?.kind === 'underlying') return { source: src, interval };
  if (src?.kind === 'option' && (src.type === 'CE' || src.type === 'PE') && Number.isFinite(src.strike)) {
    return { source: { kind: 'option', type: src.type, strike: src.auto ? 0 : src.strike }, interval };
  }
  return { ...fallback, interval };
}
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
    if (u !== underlying) {
      // Option panes go back to ATM: the other underlying's strikes are a different ladder.
      setPanes(ps => ps.map(c => (c.source.kind === 'option' ? { ...c, source: { ...c.source, strike: 0 } } : c)) as [PaneCfg, PaneCfg]);
    }
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

  // Chart layout: one chart, or two side by side. Each pane picks the underlying or a CE / PE strike, and its timeframe.
  const [layout, setLayout] = useState<1 | 2>(1);
  const [panes, setPanes] = useState<[PaneCfg, PaneCfg]>(DEFAULT_PANES);
  const [layoutReady, setLayoutReady] = useState(false);
  const [paneStatus, setPaneStatus] = useState<[PaneStatus, PaneStatus]>([NO_STATUS, NO_STATUS]);
  // Call / Put OI bars at each strike on the underlying chart(s). Per viewer, on by default.
  const [showOi, setShowOi] = useState(true);
  // Quick Trade (strike lines with live C / P chips, Buy / Sell in one click). OFF by default: off, the page is exactly
  // what it was before the feature existed.
  const [quickOn, setQuickOnState] = useState(false);
  const [quickSettings, setQuickSettingsState] = useState<QuickSettings>(DEFAULT_QUICK);
  const [quickMenu, setQuickMenu] = useState(false);
  // What the bars show: the total OI, or today's change in OI.
  const [oiMode, setOiModeState] = useState<OiMode>('total');
  const [days, setDays] = useState(15);
  // Range-button request; `seq` makes a repeat click of the same range a new request.
  const [focus, setFocus] = useState<{ seconds: number; seq: number } | null>(null);
  // Bumped to reload every pane's REST backfill (refresh button, a stale feed coming back, the tab shown again).
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
  const [ticketOrderType, setTicketOrderType] = useState<TicketOrderType>('MARKET');
  const [ticketPrice, setTicketPrice] = useState<number | null>(null);
  const [ticketLots, setTicketLots] = useState<number>(1);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState<Toast | null>(null);

  const [real, setReal] = useState(false);
  const [armOpen, setArmOpen] = useState(false);
  const [sim, setSim] = useState<SimState>(() => ({ day: istDayKey(), legs: {}, realized: 0 }));
  const [simReady, setSimReady] = useState(false);
  const [simBrackets, setSimBrackets] = useState<Record<string, { tp?: number; sl?: number }>>({});
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
    const layV2 = loadJson<{ layout?: unknown; panes?: unknown[] } | null>(LAYOUT_KEY, null);
    const lay = layV2 ?? loadJson<{ layout?: unknown; panes?: unknown[] } | null>(LAYOUT_KEY_V1, null);
    if (lay) {
      if (lay.layout === 1 || lay.layout === 2) setLayout(lay.layout);
      if (Array.isArray(lay.panes)) {
        const atmOnly = (x: unknown) => (layV2 ? x : { ...(x as object), source: { ...((x as PaneCfg)?.source ?? {}), auto: true } });
        setPanes([validPane(atmOnly(lay.panes[0]), DEFAULT_PANES[0]), validPane(atmOnly(lay.panes[1]), DEFAULT_PANES[1])]);
      }
    }
    if (readPref(OI_KEY) === '0') setShowOi(false);
    if (readPref(OI_MODE_KEY) === 'change') setOiModeState('change');
    if (readPref(QUICK_ON_KEY) === '1') setQuickOnState(true);
    setQuickSettingsState(clampQuickSettings(loadJson<unknown>(QUICK_SETTINGS_KEY, null)));
    setLayoutReady(true);
  }, []);
  const setOi = (on: boolean) => { setShowOi(on); savePref(OI_KEY, on ? '1' : '0'); };
  const setOiMode = (m: OiMode) => { setOiModeState(m); savePref(OI_MODE_KEY, m); };
  const setQuickOn = (on: boolean) => { setQuickOnState(on); savePref(QUICK_ON_KEY, on ? '1' : '0'); if (!on) setQuickMenu(false); };
  const patchQuick = (patch: Partial<QuickSettings>) => setQuickSettingsState(prev => {
    const next = clampQuickSettings({ ...prev, ...patch });
    savePref(QUICK_SETTINGS_KEY, JSON.stringify(next));
    return next;
  });
  // The pane prop: null when off, else the settings (identity changes only when a setting does).
  const quickProp = useMemo(() => (quickOn ? quickSettings : null), [quickOn, quickSettings]);
  // The chip's + / - step, read at click time (a settings change must not rebuild the order callbacks).
  const stepLotsRef = useRef(quickSettings.stepLots);
  useEffect(() => { stepLotsRef.current = quickSettings.stepLots; }, [quickSettings.stepLots]);
  // An ATM pin the pane made itself is saved as ATM (0), so the next session resolves today's ATM; a picked strike is kept.
  useEffect(() => {
    if (!layoutReady) return;
    const saved = panes.map(c => (c.source.kind === 'option' && c.source.auto ? { ...c, source: { kind: 'option', type: c.source.type, strike: 0 } } : c));
    savePref(LAYOUT_KEY, JSON.stringify({ layout, panes: saved }));
  }, [layout, panes, layoutReady]);
  const onPaneCfg = useCallback((i: number, cfg: PaneCfg) => {
    setPanes(ps => {
      const cur = ps[i];
      if (cur && JSON.stringify(cur) === JSON.stringify(cfg)) return ps;
      const next = [...ps] as [PaneCfg, PaneCfg];
      next[i] = cfg;
      return next;
    });
    // A newly chosen instrument is shown auto-scaled: the shared "auto" switch goes back on (the pane fits itself).
    setAutoScale(true);
  }, []);
  const onPaneStatus = useCallback((i: number, st: PaneStatus) => {
    setPaneStatus(ps => {
      const cur = ps[i];
      if (cur.date === st.date && cur.loading === st.loading && cur.error === st.error) return ps;
      const next = [...ps] as [PaneStatus, PaneStatus];
      next[i] = st;
      return next;
    });
  }, [setPaneStatus]);
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

  // ── candles: each ChartPane loads its own (useChartBars); these only ask every pane to backfill again ──
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
      // Only the future on screen has a price; another month's future (even one expiring with the options) has none.
      return info.expiry === feed.future?.expiry ? feed.future?.ltp ?? null : null;
    }
    if (info.expiry !== feed.expiry) return null;
    const ids = feed.strikeIds.get(info.strike);
    const id = info.side === 'CE' ? ids?.ceId : ids?.peId;
    return id ? feed.ltpById.get(id) ?? null : null;
  }, [feed.expiry, feed.future, feed.strikeIds, feed.ltpById]);
  const kotakSymbols = feed.kotak?.symbols;

  const legsRaw: ScalperLeg[] = useMemo(() => {
    if (real && broker === 'kotak') return legsFromKotakPositions(realRows, kotakSymbols ?? {}, kotakPrice, underlying);
    if (real) return legsFromDhanPositions(realRows, feed.ltpById, underlying);
    return Object.values(sim.legs).filter(l => l.netQty !== 0).map(l => {
      const live = feed.ltpById.get(l.securityId);
      return { id: l.securityId, securityId: l.securityId, product: '', symbol: l.symbol, strike: l.strike, type: l.type, netQty: l.netQty, avg: l.avg, ltp: live ?? null, sim: true, mult: 1 };
    });
  }, [real, broker, realRows, sim.legs, feed.ltpById, kotakSymbols, kotakPrice, underlying]);
  // Same content, same array: ltpById is a new Map on every feed push (20-40 a second), but most pushes move no held leg.
  // Keeping the identity lets the memoised chart skip those renders.
  const legsSig = legsKey(legsRaw);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const legs = useMemo(() => legsRaw, [legsSig]);
  // Order callbacks read the open quantity through a ref, so a P&L tick does not rebuild them (and the chart with them).
  const legsRef = useRef(legs);
  useEffect(() => { legsRef.current = legs; });
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
    const isFut = req.contract.type === 'FUT';
    // The lookup that gives the lot size must have landed for the expiry on screen (f.lotSize is null until then):
    // no guessed lot size, the order is refused instead.
    const unitsPerLot = f.lotSize === null ? null : lotUnits(underlying, f.lotSize);
    const size = orderUnits(req.lots, unitsPerLot);
    if (!size.ok) return { ok: false, text: size.error };
    const c = req.contract;
    if (!c.securityId && !c.tradingSymbol) return { ok: false, text: 'No contract identifier for this order' };
    // MCX crude opens NRML (MARGIN) only, whatever the caller asked. An order closing an existing leg (TP / SL bracket)
    // keeps that leg's own product: a MARGIN order against an MIS leg would open a second position, not reduce it.
    const product = req.closesLeg ? req.product : openingProduct(underlying, req.product);
    // The security id was picked for one expiry; never send it under a ticket that now shows another (except futures).
    if (!isFut && c.expiry !== f.expiry) return { ok: false, text: `This ticket was opened for the ${c.expiry || 'previous'} expiry: reopen it from the chain` };
    // Live tick only (ltpById is built from the bridge's live chain): never the ticket's display price, which can be a
    // REST snapshot or the previous close.
    const live = c.securityId ? f.ltpById.get(c.securityId) ?? null : null;
    const symbol = isFut
      ? `${underlying}-${c.expiry}-FUT`
      : `${underlying}-${f.expiry}-${c.strike}-${c.type}`;

    if (!real) {
      if (req.orderType !== 'MARKET' && req.orderType !== 'LIMIT') return { ok: false, text: 'SIM fills market and marketable limit orders only' };
      if (!(live && live > 0) || f.feedAgeSec === null) return { ok: false, text: 'No live price to fill the paper order' };
      if (f.stale) return { ok: false, text: 'Live prices are stale: not filling a paper order on an old price' };
      if (!f.marketOpen) return { ok: false, text: `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed: paper orders fill only during the session` };
      let fillPx = live;
      if (req.orderType === 'LIMIT') {
        const lim = req.price ?? 0;
        const marketable = req.side === 'BUY' ? lim >= live : lim <= live;
        if (!marketable) return { ok: false, text: `Limit ${lim} is not marketable at ${live.toFixed(2)} (SIM does not rest orders)` };
        fillPx = live;
      }
      simFill(c, req.side, size.units, fillPx, symbol);
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
      const kotakLot = lotUnits(underlying, k.lotSize);
      if (kotakLot === null) return { ok: false, text: 'Kotak lot size unknown for this contract: refusing the order' };
      const kQty = kotakOrderQty(underlying, req.lots, kotakLot);
      const before = legsRef.current.find(l => l.securityId === sym)?.netQty ?? 0;
      const out = await sendReal({
        tradingSymbol: sym, quantity: kQty, side: req.side, orderType: req.orderType,
        price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, product,
      }, req.closesLeg ? 'close' : 'open');
      if (out.ok && before === 0) rememberSpot(sym, f.spot);
      loadPositions();
      void loadOrders();
      return out;
    }
    // A Dhan security id is numeric: a Kotak trading symbol sitting in the field must never reach Dhan's order route.
    if (!c.securityId || !/^\d+$/.test(c.securityId)) return { ok: false, text: 'No Dhan security id for this contract' };
    const dQty = dhanOrderQty(underlying, req.lots, unitsPerLot ?? 0);
    if (!(dQty > 0)) return { ok: false, text: 'Lot size unknown' };
    const before = legsRef.current.find(l => l.securityId === c.securityId)?.netQty ?? 0;
    const out = await sendReal({
      securityId: c.securityId, quantity: dQty, side: req.side, orderType: req.orderType,
      exchangeSegment: INSTRUMENTS[underlying].dhanSegment,
      price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, productType: product,
    });
    if (out.ok && before === 0) rememberSpot(c.securityId, f.spot);
    loadPositions();
    void loadOrders();
    return out;
  }, [real, sendReal, simFill, rememberSpot, loadPositions, loadOrders, underlying]);

  const submitTicket = useCallback(async (req: TicketRequest) => {
    if (ticketBusy) return;
    setTicketBusy(true); setTicketMsg(null);
    const out = await placeContract(req);
    setTicketMsg({ ok: out.ok, text: out.text });
    setTicketBusy(false);
  }, [placeContract, ticketBusy]);

  // ── exits ──────────────────────────────────────────────────────────
  const exitSimLeg = useCallback((leg: ScalperLeg): Outcome => {
    if (leg.ltp === null || feedRef.current.feedAgeSec === null) return { ok: false, text: 'No live price to close the paper position' };
    // Same rule as a paper entry: never book P&L on a price the feed stopped updating.
    if (feedRef.current.stale) return { ok: false, text: 'Live prices are stale: not closing a paper position on an old price' };
    if (!feedRef.current.marketOpen) return { ok: false, text: `${underlying === 'CRUDEOILM' ? 'MCX' : 'NSE'} is closed: paper positions close only during the session` };
    const sl = sim.legs[leg.id];
    if (!sl || sl.netQty === 0) return { ok: true, text: 'Already flat' };
    simFill({ strike: sl.strike, type: sl.type, securityId: sl.securityId, ltp: leg.ltp, expiry: '' }, sl.netQty > 0 ? 'SELL' : 'BUY', Math.abs(sl.netQty), leg.ltp, sl.symbol);
    return { ok: true, text: `SIM closed ${sl.strike} ${sl.type} @ ${leg.ltp.toFixed(2)}` };
  }, [sim.legs, simFill, underlying]);

  /** Kotak only: this page's recorded orders + Kotak's order book, for the unknown-outcome hold before an exit (an
   *  order whose outcome is unknown may still fill, and an exit sized before it lands could flip). Dhan needs nothing. */
  const loadKotakGuard = useCallback(async (): Promise<{ records: KotakRecord[]; book: Record<string, unknown>[] } | null> => {
    try {
      const [records, r] = await Promise.all([loadKotakRecords(), fetch(scalperRoute('kotak', 'orders'))]);
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (!records || !j.success || !Array.isArray(j.data)) return null;
      return { records, book: j.data };
    } catch { return null; }
  }, [loadKotakRecords]);

  /** Close one broker row (security + product) in full, whoever opened it; `leg` is the row from a fresh broker read.
   *  `maxUnits` (broker units) caps the close: the chip's "-" takes one lot off through this same path. */
  const exitRealRow = useCallback(async (leg: ScalperLeg, records: KotakRecord[] = [], book: Record<string, unknown>[] = [], maxUnits?: number): Promise<Outcome> => {
    const label = `${leg.strike} ${leg.type}${leg.product ? ` ${leg.product}` : ''}`;
    const kotak = brokerRef.current === 'kotak';
    // Kotak: an order on this contract whose outcome is unknown may still fill; an exit sized before it lands could flip.
    if (kotak && heldByUnknown(records, leg.securityId, Date.now(), 60_000, book)) {
      return { ok: false, text: `${label}: an order on this contract has an unknown outcome; exit held for up to 60 s (check Orders)` };
    }
    const full = brokerCloseOrder(leg.netQty);
    if (!full) return { ok: true, text: `${label}: already flat` };
    const order = maxUnits !== undefined ? { ...full, units: Math.min(full.units, maxUnits) } : full;
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
    return out;
  }, [sendReal]);

  /** Fresh broker rows (plus, on Kotak, the unknown-outcome guard) read right before an exit. */
  const readExitState = useCallback(async (): Promise<{ live: ScalperLeg[]; records: KotakRecord[]; book: Record<string, unknown>[] } | string> => {
    const kotak = brokerRef.current === 'kotak';
    const [rows, guard] = await Promise.all([loadPositions(true), kotak ? loadKotakGuard() : Promise.resolve({ records: [], book: [] })]);
    if (!rows) return 'Could not read live positions: nothing was closed';
    if (!guard) return 'Could not read the Kotak order book (needed to check for orders with an unknown outcome): nothing was closed';
    const f = feedRef.current;
    if (brokerRef.current === 'kotak' && !f.kotak) return `${f.kotakError ?? 'Kotak contracts are not loaded yet'}: nothing was closed`;
    const live = brokerRef.current === 'kotak'
      ? legsFromKotakPositions(rows, f.kotak?.symbols ?? {}, () => null, underlying)
      : legsFromDhanPositions(rows, f.ltpById, underlying);
    return { live, records: guard.records, book: guard.book };
  }, [loadPositions, loadKotakGuard, underlying]);

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
          out = row ? await exitRealRow(row, st.records, st.book) : { ok: true, text: 'Already flat' };
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
      let sent = 0;
      for (const l of ordered) {
        const o = await exitRealRow(l, st.records, st.book);
        if (!o.ok) { problems.push(o.text); if (o.unknown) break; continue; }
        sent++;
      }
      flash({
        ok: problems.length === 0,
        text: problems.length ? `Exit All incomplete: ${problems.join(' · ')}` : `Exit All sent for ${sent} leg(s)`,
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

  /** Cancel any working order on the broker's book (this page's, the mobile app's, another terminal's). */
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
      securityId: f.dhanId ?? f.kotakSymbol ?? null,
      ltp: f.ltp,
      expiry: f.expiry ?? feed.expiry,
      tradingSymbol: f.kotakSymbol ?? undefined,
    };
    void tradeNow(c, side);
  }, [feed.future, feed.expiry, tradeNow, flash]);

  // The chart's contract (the future on screen). Keyed on its identity only, never its price: feed.future is a new object
  // on every feed push, and the chart callbacks built from this would re-render the memoised chart 20-40 times a second.
  // No price is needed here: orders and the ticket price from the live feed (ltpById / ticketLtp).
  const futDhanId = feed.future?.dhanId ?? null;
  const futKotakSymbol = feed.future?.kotakSymbol ?? null;
  const futExpiry = feed.future?.expiry ?? null;
  const chartContract = useMemo<PickedContract | null>(() => {
    if (broker === 'kotak' ? !futKotakSymbol : !futDhanId) return null;
    return {
      strike: 0,
      type: 'FUT',
      securityId: futDhanId ?? futKotakSymbol ?? null,
      ltp: null,
      expiry: futExpiry ?? feed.expiry,
      tradingSymbol: futKotakSymbol ?? undefined,
    };
  }, [broker, futDhanId, futKotakSymbol, futExpiry, feed.expiry]);

  const chartContractName = useMemo(() => {
    if (underlying === 'CRUDEOILM') {
      const exp = feed.future?.expiry
        ? new Date(feed.future.expiry).toLocaleString('en-US', { month: 'short' }).toUpperCase()
        : 'DEC';
      return `CRUDEOILM ${exp} FUT`;
    }
    return `${underlying} FUT`;
  }, [underlying, feed.future?.expiry]);

  const chartOpenOrders = useMemo(() => {
    return panelOrders.filter(o => o.bucket === 'open' && (
      o.symbol.toUpperCase().includes(underlying) ||
      (underlying === 'CRUDEOILM' && (o.symbol.toUpperCase().includes('CRUDE') || o.exchange === 'MCX')) ||
      (underlying === 'NIFTY' && o.symbol.toUpperCase().includes('NIFTY'))
    ));
  }, [panelOrders, underlying]);

  // `contract` is the pane's: the option it plots, or the underlying's future (ChartPane binds it).
  const onPlaceChartOrder = useCallback(async (c: PickedContract | null, req: { side: 'BUY' | 'SELL'; price: number; lots: number; orderType?: 'LIMIT' | 'STOP_LOSS' }) => {
    if (ticketBusy) return;
    if (!c) {
      flash({ ok: false, text: 'No contract identifier for chart order' });
      return;
    }
    setTicketBusy(true);
    try {
      const isStop = req.orderType === 'STOP_LOSS';
      const out = await placeContract({
        contract: c,
        side: req.side,
        orderType: isStop ? 'STOP_LOSS_MARKET' : 'LIMIT',
        price: isStop ? null : req.price,
        trigger: isStop ? req.price : null,
        product: 'INTRADAY',
        lots: req.lots,
      });
      flash({ ok: out.ok, text: out.text });
      void loadOrders();
      void loadPositions();
    } catch (e) {
      flash({ ok: false, text: String((e as Error)?.message ?? e) });
    } finally {
      setTicketBusy(false);
    }
  }, [ticketBusy, placeContract, flash, loadOrders, loadPositions]);

  // In SIM mode: auto-execute brackets when market price crosses TP or SL
  useEffect(() => {
    if (real) return;
    for (const leg of legs) {
      if (!leg.sim) continue;
      const b = simBrackets[leg.id];
      if (!b) continue;
      // The leg's own live price (an option's premium, the future's LTP): TP / SL are set on that instrument's chart.
      // Never fall back to spot: an index level against a premium bracket fires at once.
      const cur = leg.ltp;
      if (cur === null || !(cur > 0)) continue;
      const isLong = leg.netQty > 0;
      if (b.tp !== undefined && b.tp > 0) {
        const hit = isLong ? cur >= b.tp : cur <= b.tp;
        if (hit) {
          setSimBrackets(prev => {
            const next = { ...prev };
            delete next[leg.id];
            return next;
          });
          exitSimLeg(leg);
          flash({ ok: true, text: `Target hit! SIM ${leg.symbol || leg.strike} closed @ ${cur.toFixed(2)}` });
          break;
        }
      }
      if (b.sl !== undefined && b.sl > 0) {
        const hit = isLong ? cur <= b.sl : cur >= b.sl;
        if (hit) {
          setSimBrackets(prev => {
            const next = { ...prev };
            delete next[leg.id];
            return next;
          });
          exitSimLeg(leg);
          flash({ ok: false, text: `Stop loss hit! SIM ${leg.symbol || leg.strike} closed @ ${cur.toFixed(2)}` });
          break;
        }
      }
    }
  }, [real, legs, simBrackets, exitSimLeg, flash]);

  const onSetBracket = useCallback(async (req: { leg: ScalperLeg; kind: 'TP' | 'SL'; price: number }) => {
    if (!real || req.leg.sim) {
      setSimBrackets(prev => ({
        ...prev,
        [req.leg.id]: {
          ...prev[req.leg.id],
          [req.kind === 'TP' ? 'tp' : 'sl']: req.price,
        },
      }));
      flash({ ok: true, text: `SIM ${req.kind} set at ₹${req.price.toFixed(2)}` });
      return;
    }

    const isLong = req.leg.netQty > 0;
    const oppSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    const targetType: TicketOrderType = req.kind === 'TP' ? 'LIMIT' : 'STOP_LOSS_MARKET';

    // Cancel any existing bracket order of this kind on THIS contract (never another contract's order of the underlying)
    const existing = chartOpenOrders.find(o => {
      if (o.side !== oppSide || !o.securityId || o.securityId !== req.leg.securityId) return false;
      const ot = (o.orderType || '').toUpperCase();
      const isLimit = ot.includes('LIMIT');
      const isStop = ot.includes('SL') || ot.includes('STOP');
      return req.kind === 'TP' ? isLimit : isStop;
    });
    if (existing) {
      await cancelOrder(existing.id);
    }

    const c: PickedContract = (req.leg.type === 'FUT' && chartContract)
      ? chartContract
      : {
          strike: req.leg.strike,
          type: req.leg.type,
          expiry: feed.expiry ?? '',
          securityId: req.leg.securityId,
          tradingSymbol: req.leg.symbol,
          ltp: req.leg.ltp ?? req.price,
        };

    // netQty is in the broker's own unit (Dhan MCX: lots; Kotak / SIM / NSE: units): leg.mult converts it.
    const lots = qtyLots(underlying, req.leg.netQty, req.leg.mult ?? 1, feed.lotSize);
    if (lots === null) {
      flash({ ok: false, text: `Cannot size the ${req.kind}: ${Math.abs(req.leg.netQty)} is not a whole number of lots (or the lot size is unknown)` });
      return;
    }

    const out = await placeContract({
      contract: c,
      side: oppSide,
      orderType: targetType,
      price: req.kind === 'TP' ? req.price : null,
      trigger: req.kind === 'SL' ? req.price : null,
      product: (req.leg.product as 'INTRADAY' | 'MARGIN') || 'INTRADAY',
      lots,
      // A TP / SL closes this leg: it keeps the leg's product (an MIS crude leg is squared off as MIS).
      closesLeg: true,
    });
    flash({ ok: out.ok, text: out.text });
    void loadOrders();
  }, [real, chartOpenOrders, chartContract, cancelOrder, feed.expiry, feed.lotSize, underlying, placeContract, flash, loadOrders]);

  const onCancelBracket = useCallback(async (req: { legId: string; kind: 'TP' | 'SL'; orderId?: string }) => {
    if (req.orderId) {
      await cancelOrder(req.orderId);
    }
    setSimBrackets(prev => {
      if (!prev[req.legId]) return prev;
      const next = { ...prev, [req.legId]: { ...prev[req.legId] } };
      delete next[req.legId][req.kind === 'TP' ? 'tp' : 'sl'];
      return next;
    });
  }, [cancelOrder]);

  const onReversePosition = useCallback(async (leg: ScalperLeg) => {
    if (ticketBusy || exitingId) return;
    const isLong = leg.netQty > 0;
    const revSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    // netQty is in the broker's own unit (Dhan MCX: lots; Kotak / SIM / NSE: units): leg.mult converts it.
    const curLots = qtyLots(underlying, leg.netQty, leg.mult ?? 1, feed.lotSize);
    if (curLots === null) {
      flash({ ok: false, text: `Cannot reverse: ${Math.abs(leg.netQty)} is not a whole number of lots (or the lot size is unknown)` });
      return;
    }
    const revLots = curLots * 2;

    // Clear any active brackets for this leg
    setSimBrackets(prev => {
      const next = { ...prev };
      delete next[leg.id];
      return next;
    });

    const c: PickedContract = {
      strike: leg.strike,
      type: leg.type,
      expiry: feed.expiry ?? '',
      securityId: leg.securityId,
      tradingSymbol: leg.symbol,
      ltp: leg.ltp ?? leg.avg,
    };

    if (!real || leg.sim) {
      // Only open the other side once the close went through: otherwise "reverse" would double the position.
      const closed = exitSimLeg(leg);
      if (!closed.ok) { flash(closed); return; }
      const out = await placeContract({
        contract: c,
        side: revSide,
        orderType: 'MARKET',
        price: null,
        trigger: null,
        product: 'INTRADAY',
        lots: curLots,
      });
      flash({ ok: out.ok, text: `Reversed position to ${revSide} ${curLots} lot${curLots > 1 ? 's' : ''}` });
      return;
    }

    // A REAL reverse is one 2x order in the leg's own product. On MCX crude that product must be MARGIN: reversing an
    // MIS crude leg would open a fresh MIS position (refused: crude is NRML only), so exit it and re-enter instead.
    if (nrmlOnly(underlying) && leg.product !== 'MARGIN') {
      flash({ ok: false, text: `${underlying} is NRML-only: Exit this ${leg.product || 'intraday'} position, then open the other side (it goes as NRML)` });
      return;
    }

    setTicketBusy(true);
    try {
      const out = await placeContract({
        contract: c,
        side: revSide,
        orderType: 'MARKET',
        price: null,
        trigger: null,
        product: (leg.product as 'INTRADAY' | 'MARGIN') || 'INTRADAY',
        lots: revLots,
      });
      flash({ ok: out.ok, text: `Reversed position: ${out.text}` });
      loadPositions();
      void loadOrders();
    } finally {
      setTicketBusy(false);
    }
  }, [ticketBusy, exitingId, underlying, feed.lotSize, feed.expiry, real, exitSimLeg, placeContract, flash, loadPositions, loadOrders]);

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
  // Quick Trade chip +/-: the Quick Trade "Lots per + / -" step more in the leg's own direction, or that many taken off
  // (never the last lot: Exit closes a leg). "+" is an opening order (placeContract: lot cap, live price, session, isx).
  // "-" closes through the exit path (fresh broker read, Kotak freeze slices, unknown-outcome hold), capped at the
  // step; SIM fills the step the other way.
  const adjustLeg = useCallback(async (leg: ScalperLeg, delta: 1 | -1) => {
    if (exitingId || ticketBusy) return;
    const f = feedRef.current;
    const isLong = leg.netQty > 0;
    const lotSize = brokerRef.current === 'kotak' && real ? f.kotak?.lotSize ?? null : f.lotSize;
    const contractUnits = lotUnits(underlying, lotSize);
    if (contractUnits === null) { flash({ ok: false, text: 'Lot size not known yet: nothing sent' }); return; }
    const c: PickedContract = { strike: leg.strike, type: leg.type, securityId: leg.securityId, tradingSymbol: leg.symbol, ltp: leg.ltp, expiry: f.expiry };
    const product = (leg.product as 'INTRADAY' | 'MARGIN') || 'INTRADAY';
    const step = stepLotsRef.current;
    if (delta === 1) {
      await onTradeContract(c, isLong ? 'BUY' : 'SELL', step, product);
      return;
    }
    // One lot in the leg's own quantity unit (Dhan MCX counts lots, Kotak / SIM / NSE count contract units).
    const brokerUnitsPerLot = contractUnits / (leg.mult && leg.mult > 0 ? leg.mult : 1);
    const n = lotsToRemove(step, Math.abs(leg.netQty) / brokerUnitsPerLot);
    if (n === 0) { flash({ ok: false, text: 'One lot left: use Exit (x) to close the leg' }); return; }
    setExitingId(leg.id);
    try {
      let out: Outcome;
      if (!real || leg.sim) {
        out = await placeContract({ contract: c, side: isLong ? 'SELL' : 'BUY', orderType: 'MARKET', price: null, trigger: null, product, lots: n, closesLeg: true });
      } else {
        const st = await readExitState();
        if (typeof st === 'string') out = { ok: false, text: st };
        else {
          const row = st.live.find(l => l.id === leg.id);
          out = row ? await exitRealRow(row, st.records, st.book, n * brokerUnitsPerLot) : { ok: false, text: 'Position not found at the broker' };
        }
        loadPositions();
      }
      flash({ ok: out.ok, text: out.ok ? `${leg.type} ${leg.strike}: ${n} lot${n === 1 ? '' : 's'} taken off` : out.text });
    } finally { setExitingId(null); }
  }, [exitingId, ticketBusy, real, underlying, placeContract, onTradeContract, readExitState, exitRealRow, loadPositions, flash]);


  // ── REAL arming ────────────────────────────────────────────────────
  const goSim = () => { setReal(false); };

  // ── indicators ─────────────────────────────────────────────────────
  const addIndicator = (k: IndicatorKind) => { setIndicators(p => [...p, newIndicator(k, nextId())]); setPickerOpen(false); };
  const patchIndicator = (id: string, patch: Partial<IndicatorInstance>) => setIndicators(p => p.map(i => (i.id === id ? { ...i, ...patch } : i)));
  const removeIndicator = useCallback((id: string) => setIndicators(p => p.filter(i => i.id !== id)), []);

  // A ticket belongs to the expiry it was picked under (its security id is that expiry's): close it on a switch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTicket(cur => (cur && cur.expiry !== feed.expiry ? null : cur));
  }, [feed.expiry]);

  const ticketLtp = useMemo(() => {
    if (!ticket?.securityId) return null;
    return feed.ltpById.get(ticket.securityId) ?? null;
  }, [ticket, feed.ltpById]);

  const shownStatus = layout === 2 ? paneStatus : [paneStatus[0]];
  const dataDate = shownStatus.map(x => x.date).filter((d): d is string => !!d).sort().pop() ?? null;
  const loadingBars = shownStatus.some(x => x.loading);
  const candleErr = shownStatus.map(x => x.error).find(Boolean) ?? null;
  // Live spot; else the chain snapshot's index price (Dhan's official close on a closed day: the intraday candles stop at
  // the value frozen at 15:15, which is not the close).
  const spotDisplay = feed.spot ?? feed.chain?.spot ?? null;
  const orderQtyMult = real ? pnlMultiplier(underlying, broker) : 1;
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

  // Stable callbacks for the memoised chart (inline arrows would re-render it on every feed push).
  const onToolDone = useCallback(() => setTool('cursor'), []);
  const onToggleIndicator = useCallback((id: string) => setIndicators(p => p.map(i => (i.id === id ? { ...i, visible: !i.visible } : i))), []);
  const onEditIndicator = useCallback((id: string) => { setEditId(id); setPickerOpen(true); }, []);
  const onOpenChartTicket = useCallback((c: PickedContract | null, req: { price: number; lots: number; orderType: 'LIMIT' }) => {
    if (c) {
      setTicket(c);
      setTicketOrderType(req.orderType);
      setTicketPrice(req.price);
      setTicketLots(req.lots);
      setTicketMsg(null);
    } else {
      flash({ ok: false, text: 'No contract identifier for chart order' });
    }
  }, [flash]);
  const onChartAlert = useCallback((sym: string, p: number) => { flash({ ok: true, text: `Alert set on ${sym} at ₹${p.toFixed(2)}` }); }, [flash]);

  return (
    <div ref={rootRef} data-testid="index-scalper" className={cn('flex flex-col h-screen overflow-hidden bg-zinc-950 text-white', real && 'ring-2 ring-inset ring-rose-600/70')}>
      {/* header toolbar */}
      {/* Wraps onto a second line when the controls do not fit (a laptop width): overlapping groups hid REAL / SIM. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-1.5 min-h-11 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <div className="flex items-center gap-1.5 whitespace-nowrap [&>*]:shrink-0">
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
          <div role="group" aria-label="Chart layout" className="flex items-center">
            <button type="button" aria-pressed={layout === 1} aria-label="One chart" title="One chart" onClick={() => setLayout(1)}
              className={cn(btn, layout === 1 && 'bg-zinc-800 text-white')}><Square className="w-4 h-4" /></button>
            <button type="button" aria-pressed={layout === 2} aria-label="Two charts side by side" title="Two charts side by side" onClick={() => setLayout(2)}
              className={cn(btn, layout === 2 && 'bg-zinc-800 text-white')}><Columns2 className="w-4 h-4" /></button>
          </div>
          {sep}
          <label className="flex items-center gap-1.5 h-7 px-1.5 rounded text-xs font-semibold text-zinc-300 cursor-pointer select-none hover:bg-zinc-800"
            title="OI profile: Call (red) and Put (green) open interest at each strike, on the index / future chart">
            <AlignRight className="w-4 h-4" aria-hidden />
            OI
            <Switch size="sm" checked={showOi} onCheckedChange={setOi} aria-label="OI profile" />
            <span className={cn('w-6 text-[10px] font-bold', showOi ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden>{showOi ? 'ON' : 'OFF'}</span>
          </label>
          {sep}
          <div className="relative flex items-center">
            <label className="flex items-center gap-1.5 h-7 px-1.5 rounded text-xs font-semibold text-zinc-300 cursor-pointer select-none hover:bg-zinc-800"
              title="Quick Trade: every strike on the chart shows its live Call / Put price; click one to Buy or Sell your preset lots at market">
              <Crosshair className="w-4 h-4" aria-hidden />
              Quick
              <Switch size="sm" checked={quickOn} onCheckedChange={setQuickOn} aria-label="Quick Trade" />
            </label>
            <button type="button" aria-label="Quick Trade settings" aria-expanded={quickMenu} disabled={!quickOn}
              title={quickOn ? 'Quick Trade settings: lots per click, product' : 'Turn Quick Trade on first'}
              onClick={() => setQuickMenu(v => !v)} className={cn(btn, 'px-1.5 disabled:opacity-40', quickMenu && 'bg-zinc-800 text-white')}>
              <Settings2 className="w-4 h-4" />
            </button>
            {quickMenu && quickOn && (
              <QuickSettingsMenu settings={quickSettings} onPatch={patchQuick} nrmlLocked={nrmlOnly(underlying)}
                maxLots={MAX_LOTS} onClose={() => setQuickMenu(false)} />
            )}
          </div>
          {sep}
          <div role="group" aria-label="OI shows" className={cn('flex rounded border border-zinc-700 overflow-hidden', !showOi && 'opacity-50')}
            title={showOi ? 'Bars show the total OI, or today\'s change in OI (added = filled, shed = outlined)' : 'Turn the OI profile on first'}>
            {([['total', 'Total'], ['change', 'Chg']] as const).map(([m, label]) => (
              <button key={m} type="button" aria-pressed={oiMode === m} disabled={!showOi} onClick={() => setOiMode(m)}
                aria-label={m === 'total' ? 'Total OI' : 'Change in OI'}
                className={cn('h-6 px-2 text-[11px] font-bold transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  oiMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>{label}</button>
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
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          <IstClock suffix=" IST" title="Current time (IST)" className="h-7 px-2 flex items-center rounded border border-zinc-700 bg-zinc-900 text-xs font-bold tabular-nums font-mono text-zinc-100" />
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

        <div className="relative flex flex-1 min-w-0 min-h-0">
          {indReady && layoutReady && (
            <>
            <ChartPane
              index={0} cfg={panes[0]} onCfgChange={onPaneCfg} onStatus={onPaneStatus}
              underlying={underlying} feed={feed} days={days} refreshTick={refreshTick}
              futureContract={chartContract} futureName={chartContractName}
              indicators={indicators} tool={tool} onToolDone={onToolDone} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} onAdjustLeg={adjustLeg} exitingId={exitingId}
              onToggleIndicator={onToggleIndicator} onRemoveIndicator={removeIndicator} onEditIndicator={onEditIndicator}
              focus={focus} lots={scalpLots} openOrders={chartOpenOrders} onCancelOrder={cancelOrder}
              onPlaceChartOrder={onPlaceChartOrder} onOpenTicket={onOpenChartTicket} onAlert={onChartAlert}
              simBrackets={simBrackets} onSetBracket={onSetBracket} onCancelBracket={onCancelBracket}
              onReversePosition={onReversePosition} feedLotSize={feed.lotSize} orderQtyMult={orderQtyMult} showOi={showOi} oiMode={oiMode}
              quick={quickProp} real={real} onQuickTrade={onTradeContract}
            />
              {layout === 2 && <div className="w-px bg-zinc-800 shrink-0" />}
              {layout === 2 && (
            <ChartPane
              index={1} cfg={panes[1]} onCfgChange={onPaneCfg} onStatus={onPaneStatus}
              underlying={underlying} feed={feed} days={days} refreshTick={refreshTick}
              futureContract={chartContract} futureName={chartContractName}
              indicators={indicators} tool={tool} onToolDone={onToolDone} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} onAdjustLeg={adjustLeg} exitingId={exitingId}
              onToggleIndicator={onToggleIndicator} onRemoveIndicator={removeIndicator} onEditIndicator={onEditIndicator}
              focus={focus} lots={scalpLots} openOrders={chartOpenOrders} onCancelOrder={cancelOrder}
              onPlaceChartOrder={onPlaceChartOrder} onOpenTicket={onOpenChartTicket} onAlert={onChartAlert}
              simBrackets={simBrackets} onSetBracket={onSetBracket} onCancelBracket={onCancelBracket}
              onReversePosition={onReversePosition} feedLotSize={feed.lotSize} orderQtyMult={orderQtyMult} showOi={showOi} oiMode={oiMode}
              quick={quickProp} real={real} onQuickTrade={onTradeContract}
            />
              )}
            </>
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
          <IstClock suffix=" (UTC+05:30)" />
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
        <OrderTicket
          key={`${ticket.expiry}:${ticket.strike}${ticket.type}:${ticketPrice ?? ''}`}
          contract={ticket}
          liveLtp={ticketLtp}
          expiry={ticket.expiry}
          lotSize={feed.lotSize}
          underlying={underlying}
          broker={broker}
          real={real}
          available={funds.available}
          busy={ticketBusy}
          message={ticketMsg}
          initialOrderType={ticketOrderType}
          initialPrice={ticketPrice}
          initialLots={ticketLots}
          onSubmit={submitTicket}
          onClose={() => setTicket(null)}
        />
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


/** Quick Trade settings popover: lots per click for Buy and for Sell (a select: a discrete choice commits at once and a
 *  half-typed number can never size an order, see dhan-commit-on-blur) and the product. CRUDEOILM opens NRML only. */
function QuickSettingsMenu({ settings, onPatch, nrmlLocked, maxLots, onClose }: {
  settings: QuickSettings; onPatch: (p: Partial<QuickSettings>) => void; nrmlLocked: boolean; maxLots: number; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.('[aria-label="Quick Trade settings"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const opts = Array.from({ length: maxLots }, (_, i) => i + 1);
  const sel = 'h-7 w-16 px-1 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
  const product = nrmlLocked ? 'MARGIN' : settings.product;
  return (
    <div ref={ref} role="dialog" aria-label="Quick Trade settings panel"
      className="absolute left-0 top-9 z-[60] w-60 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2.5 text-xs">
      <div className="font-bold text-zinc-100">Quick Trade</div>
      <label className="flex items-center justify-between gap-2 text-zinc-300">
        <span>Buy lots per click</span>
        <select aria-label="Buy lots per click" value={settings.buyLots} onChange={e => onPatch({ buyLots: Number(e.target.value) })} className={sel}>
          {opts.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-zinc-300">
        <span>Sell lots per click</span>
        <select aria-label="Sell lots per click" value={settings.sellLots} onChange={e => onPatch({ sellLots: Number(e.target.value) })} className={sel}>
          {opts.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-zinc-300" title="Lots one click of a position chip's + adds or − takes off (− always leaves one lot; Exit closes the leg)">
        <span>Lots per + / −</span>
        <select aria-label="Lots per plus or minus" value={settings.stepLots} onChange={e => onPatch({ stepLots: Number(e.target.value) })} className={sel}>
          {opts.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2 text-zinc-300">
        <span>Strikes around ATM (±)</span>
        <select aria-label="Strikes around ATM" value={settings.range} onChange={e => onPatch({ range: Number(e.target.value) })} className={sel}>
          {Array.from({ length: MAX_QUICK_RANGE }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="flex items-center justify-between gap-2 text-zinc-300">
        <span>Product</span>
        <div role="group" aria-label="Quick Trade product" className="flex rounded border border-zinc-700 overflow-hidden"
          title={nrmlLocked ? 'MCX crude opens NRML only' : undefined}>
          {([['INTRADAY', 'Intraday'], ['MARGIN', 'NRML']] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={product === v} disabled={nrmlLocked}
              onClick={() => onPatch({ product: v })}
              className={cn('h-7 px-2 font-bold disabled:cursor-not-allowed', product === v ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>{l}</button>
          ))}
        </div>
      </div>
      <p className="text-[10px] leading-snug text-zinc-500">One click on Buy / Sell sends a market order at once (REAL only when armed). Max {maxLots} lots per order.</p>
    </div>
  );
}
