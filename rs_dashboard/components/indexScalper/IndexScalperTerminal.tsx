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
  AreaChart, OctagonX, BarChart3, Building2, CandlestickChart, Columns2, Gauge, LayoutList, Square, AlignRight, Crosshair, Settings2, Maximize2, Minus, MousePointer2, RefreshCw, Ruler, Scaling, Target, Trash2, TrendingUp, Volume2, VolumeX, Zap,
  Compass, Scale, ChartBarDecreasing,
} from 'lucide-react';
import { installAlertSoundUnlock, playEntryChime, playExitChime, playWarnChime } from '@/lib/alertSound';
import { useTabLeader } from '@/hooks/useTabLeader';
import { qtyBook, tradeChimeFor } from '@/lib/indexScalperChime';
import { reverseBlockers, reverseLotsError } from '@/lib/indexScalperReverse';
import { netBySecurity, ocoActions, ocoEvents, type OcoEvent } from '@/lib/indexScalperOco';
import { isSimOrderId, simOrderRow, simOrderStep, validSimOrders, type SimOrder } from '@/lib/indexScalperSimOrders';
import { armTrail, retrail, stepTrail, trailStillValid, validTrails, type TrailState } from '@/lib/indexScalperTrail';
import NavBar from '@/components/NavBar';
import DataChip from '@/components/DataChip';
import MarketWatchWindow from './MarketWatchWindow';
import { useMarketWatch } from './useMarketWatch';
import { useNiftyContribution } from './useNiftyContribution';
import { NiftyBreadthWindow, NiftyContributionWindow } from './NiftyBreadthWindows';
import { indexRows, stockRows } from '@/lib/indexScalperMarketWatch';
import IstClock from './IstClock';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { scalperRoute } from '@/hooks/useBrokerSelector';
import { type DrawTool } from './ScalperChart';
import ChartPane, { type PaneCfg } from './ChartPane';
import TrendStrip from './TrendStrip';
import { clampTrendSettings, DEFAULT_TREND_SETTINGS, TREND_SETTINGS_KEY, type TrendSettings } from '@/lib/indexScalperTrend';
import OptionChainPanel, { type PickedContract } from './OptionChainPanel';
import OrderTicket, { type TicketRequest, type TicketOrderType } from './OrderTicket';
import DhanScalperWidget from './DhanScalperWidget';
import { belowHeaderY, topMiddleX } from './useDraggable';
import AccountPanel from './AccountPanel';
import {
  dayPnl, fundsView, holdingRows, orderRows, positionRows, symbolLabel, type FundsView, type OrderRowView, type PositionRowView,
} from '@/lib/indexScalperAccount';
import MtmGuardControl from './MtmGuardControl';
import { guardScopeIds, mtmGuardTrip, readMtmGuard, MTM_GUARD_DEFAULTS, type MtmGuardSettings } from '@/lib/indexScalperMtmGuard';
import IndicatorPicker from './IndicatorPicker';
import dynamic from 'next/dynamic';

// Loaded on first use. Until the code arrives, a layer says so at once: with no fallback a cold first click showed
// nothing for seconds (the button lit, no window), which read as "Cum OI does not open". It ignores the pointer, so the
// button still toggles it off. Hovering / focusing the button fetches the code early (preloadCumOi).
const preloadCumOi = (crude: boolean) => {
  void import('@/components/CumulativeOIModal');
  void (crude ? import('@/components/CrudeOilCumulativeOITab') : import('@/components/OptionsCumulativeOITab'));
};
const CumulativeOIModal = dynamic(() => import('@/components/CumulativeOIModal'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-oncolor-dark/60 pointer-events-none" role="status">
      <p className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-300">Loading cumulative OI…</p>
    </div>
  ),
});
import { useIndexScalperFeed } from './useIndexScalperFeed';
import {
  migrateIndicatorsV1, newIndicator, withStructure, withStructureLine, withVolume, type IndicatorInstance, type IndicatorKind,
} from '@/lib/indexScalperIndicators';
import { istDateIso, isRegularSession } from '@/lib/nseHolidays';
import {
  INSTRUMENTS, dhanOrderQty, dhanSegmentOfSymbol, isMcx, isUnderlying, kotakOrderQty, pnlMultiplier, lotUnits, qtyLots, nrmlOnly, openingProduct, type Underlying,
} from '@/lib/indexScalperInstrument';
import { buildLotMap, contractLot, missingLotIds } from '@/lib/indexScalperLots';
import {
  applyFill, brokerCloseOrder, legsFromDhanPositions, legsKey, legsOpenedElsewhere, orderUnits, pageFilledQty, type ScalperLeg,
} from '@/lib/indexScalperPositions';
import { closeOrderProduct } from '@/lib/positionProduct';
import {
  dashProduct, exitBlockers, freezeSlices, heldByUnknown, kotakOrdersAsDhan, legsFromKotakPositions, ownedQtyFromKotakOrders, recordedIds,
  withResolvedUnknowns, type KotakRecord, type KotakSymbolInfo,
} from '@/lib/indexScalperKotak';
import { readPref, savePref } from '@/lib/localPref';
import { CANDLE_COLOR_KEY, CANDLE_COLOR_RULES, parseCandleColorRule, type CandleColorRule } from '@/lib/indexScalperCandleColor';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { parseOiMode, type OiMode } from '@/lib/indexScalperOiProfile';
import { editLotsError, isEditable, movedLevels, orderEditError } from '@/lib/indexScalperOrderEdit';
import { DEFAULT_BRACKETS, DEFAULT_BRACKETS_KEY, SL_PCT_OPTIONS, TP_PCT_OPTIONS, bracketLabel, clampDefaultBrackets, parseBracketPoints, type BracketUnit, defaultBracketPlan, opensPosition, pendingLeg, type DefaultBracketSettings, type PendingDefault } from '@/lib/indexScalperDefaultBrackets';
import { optionStopLimit, placedOrderState, premiumBracketsFor } from '@/lib/indexScalperPremiumBrackets';
import { QUICK_ON_KEY, QUICK_SETTINGS_KEY, DEFAULT_QUICK, MAX_QUICK_RANGE, clampQuickSettings, lotsToRemove, type QuickSettings } from '@/lib/indexScalperQuickTrade';

// v2: v1 could hold an ATM pin taken before any spot was known (the middle of the strike list, e.g. 24200). v1 is
// read for the layout, instruments and timeframes only; its option strikes go back to ATM.
const LAYOUT_KEY = 'indexScalper.layout.v2';
const LAYOUT_KEY_V1 = 'indexScalper.layout.v1';
const OI_KEY = 'indexScalper.oiProfile';
const TREND_KEY = 'indexScalper.trend';
const GRID_KEY = 'indexScalper.grid';
// The old scale-bar volume switch (read once, to add the Volume indicator hidden for a viewer who had turned it off).
const VOL_KEY = 'indexScalper.volume';
const VOL_ADDED_KEY = 'indexScalper.volumeIndicatorAdded';
/** The chart's Market structure labels, added once (2026-11-27) to a list saved before, when the strip's Market structure
 *  switch is on: the switch shows / hides them. Once only, so removing the indicator from the Indicators menu sticks. */
const STRUCTURE_ADDED_KEY = 'indexScalper.structureIndicatorAdded';
const DAY_HL_ADDED_KEY = 'indexScalper.dayLevelsIndicatorAdded';
/** Dhan tag for this page's CLOSING orders: no per-order cap (none is listed for it), still an 'isx…' order. */
const CLOSE_SOURCE = 'isxx';
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
  const interval = iv === '1' || iv === '3' || iv === '5' || iv === '15' || iv === '30' || iv === '60' ? iv : fallback.interval;
  const chartType = c?.chartType === 'line' || c?.chartType === 'linemarkers' || c?.chartType === 'bar' || c?.chartType === 'candlestick' ? c.chartType : fallback.chartType;
  const src = c?.source as PaneCfg['source'] | undefined;
  if (src?.kind === 'underlying' || src?.kind === 'future') return { source: { kind: src.kind }, interval, ...(chartType ? { chartType } : {}) };
  if (src?.kind === 'option' && (src.type === 'CE' || src.type === 'PE') && Number.isFinite(src.strike)) {
    return { source: { kind: 'option', type: src.type, strike: src.auto ? 0 : src.strike }, interval, ...(chartType ? { chartType } : {}) };
  }
  return { ...fallback, interval, ...(chartType ? { chartType } : {}) };
}
const RANGES: { label: string; days: number; focus: number }[] = [
  { label: '2M', days: 60, focus: 60 * 86400 }, { label: '1M', days: 30, focus: 30 * 86400 }, { label: '2W', days: 15, focus: 14 * 86400 },
  { label: '1W', days: 10, focus: 7 * 86400 }, { label: '3D', days: 10, focus: 3 * 86400 }, { label: '1D', days: 10, focus: 86400 },
];

const IND_KEY = 'indexScalper.indicators.v2';
const IND_KEY_V1 = 'indexScalper.indicators.v1';
const SIM_KEY = 'indexScalper.sim.v1';
/** Trade chimes (entry / exit / order problem) on or off: '1' / '0', default on. */
const SOUND_KEY = 'indexScalper.tradeSound';
/** SIM trailing stops (REAL ones live in memory only: REAL is armed per page load). */
const TRAIL_KEY = 'indexScalper.trail.v1';
const MTM_KEY = 'indexScalper.mtmGuard.v1';
/** Paper working orders (SIM limits / stops waiting for their price): today's only. */
const SIM_ORDERS_KEY = 'indexScalper.simOrders.v1';
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
  return [newIndicator('supertrend', nextId()), newIndicator('ema', nextId()), newIndicator('volume', nextId()), newIndicator('daylevels', nextId())];
}

interface Toast { ok: boolean; text: string }

const UNDERLYING_KEY = 'indexScalper.underlying';

export default function IndexScalperTerminal() {
  // Underlying instrument (NIFTY index, SENSEX index, CRUDEOILM mini crude or CRUDEOIL full-size crude). Switching is locked while REAL
  // is armed.
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [cumOiOpen, setCumOiOpen] = useState(false);
  useEffect(() => {
    const u = readPref(UNDERLYING_KEY);
    if (isUnderlying(u)) setUnderlying(u);
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
  // Trend strip + multi-timeframe check above the charts (TrendStrip.tsx; display only), on by default.
  const [showTrend, setShowTrend] = useState(true);
  // Its optional lights (futures OI buildup, market structure), gear menu beside the switch; all on by default.
  const [trendSettings, setTrendSettingsState] = useState<TrendSettings>(DEFAULT_TREND_SETTINGS);
  const [trendMenu, setTrendMenu] = useState(false);
  const [showGrid, setShowGridState] = useState(true);
  const [candleColorRule, setCandleColorRuleState] = useState<CandleColorRule>('off');
  // Quick Trade (strike lines with live C / P chips, Buy / Sell in one click). OFF by default: off, the page is exactly
  // what it was before the feature existed.
  const [quickOn, setQuickOnState] = useState(false);
  const [quickSettings, setQuickSettingsState] = useState<QuickSettings>(DEFAULT_QUICK);
  const [quickMenu, setQuickMenu] = useState(false);
  // Default target / stop for a new option position opened here (lib/indexScalperDefaultBrackets): on, 30 % / 20 %.
  const [defBrackets, setDefBracketsState] = useState<DefaultBracketSettings>(DEFAULT_BRACKETS);
  const defBracketsRef = useRef(defBrackets);
  useEffect(() => { defBracketsRef.current = defBrackets; }, [defBrackets]);
  const [defMenu, setDefMenu] = useState(false);
  /** Pending defaults by leg key (Dhan security id / Kotak trading symbol / paper id), with the mode they were made in. */
  const pendingDefaultsRef = useRef(new Map<string, { p: PendingDefault; real: boolean }>());
  const [pendingSeq, setPendingSeq] = useState(0);
  // What the bars show: the total OI, or today's change in OI.
  const [oiMode, setOiModeState] = useState<OiMode>('total');
  const [days, setDays] = useState(15);
  // Range-button request; `seq` makes a repeat click of the same range a new request.
  const [focus, setFocus] = useState<{ seconds: number; seq: number } | null>(null);
  const [resetSeq, setResetSeq] = useState(0);
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
  // Watch-only market windows (Top Indices / Top 10 Stocks), fed by the Dhan WebSocket hub over SSE while open.
  const [watchIdx, setWatchIdx] = useState(false);
  const [watchStk, setWatchStk] = useState(false);
  const watch = useMarketWatch(watchIdx, watchStk);
  const watchIdxRows = useMemo(() => indexRows(watch.data.indices?.quotes), [watch.data.indices]);
  const watchStkRows = useMemo(() => stockRows(watch.data.stocks?.quotes), [watch.data.stocks]);
  const watchIdxFlash = useMemo(() => prefixFlash(watch.flash, 'i:'), [watch.flash]);
  const watchStkFlash = useMemo(() => prefixFlash(watch.flash, 's:'), [watch.flash]);
  // Nifty 50 Advance / Decline and Contribution windows: one poll of /api/nifty-contribution while either is open.
  const [watchAd, setWatchAd] = useState(false);
  const [watchContrib, setWatchContrib] = useState(false);
  const niftyContrib = useNiftyContribution(watchAd || watchContrib);
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
  // Confirmations for touching what this page did not open: Exit All over such legs, a Cancel on another placer's order.
  const [exitAllAsk, setExitAllAsk] = useState<ScalperLeg[] | null>(null);
  const [cancelAsk, setCancelAsk] = useState<OrderRowView | null>(null);
  const [sim, setSim] = useState<SimState>(() => ({ day: istDayKey(), legs: {}, realized: 0 }));
  const [simReady, setSimReady] = useState(false);
  const [simBrackets, setSimBrackets] = useState<Record<string, { tp?: number; sl?: number }>>({});
  // Paper working orders (lib/indexScalperSimOrders.ts). The ref is the source of truth for the fill watcher, so a price
  // update that arrives before React re-renders can never fill one order twice.
  const [simOrders, setSimOrdersState] = useState<SimOrder[]>([]);
  const simOrdersRef = useRef<SimOrder[]>([]);
  const setSimOrders = useCallback((next: SimOrder[]) => {
    simOrdersRef.current = next;
    setSimOrdersState(next);
    savePref(SIM_ORDERS_KEY, JSON.stringify(next));
  }, []);
  useEffect(() => {
    let saved: SimOrder[] = [];
    try { saved = validSimOrders(JSON.parse(readPref(SIM_ORDERS_KEY) ?? '[]'), istDayKey()); } catch { saved = []; }
    simOrdersRef.current = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSimOrdersState(saved);
  }, []);
  const simOrderSeq = useRef(0);
  const [entrySpots, setEntrySpots] = useState<Record<string, number>>({});
  const [realRows, setRealRows] = useState<Record<string, unknown>[]>([]);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [funds, setFunds] = useState<FundsView>(() => fundsView(null));
  // Dhan account reads for the bottom panel (read-only): order book and demat holdings.
  const [orderBook, setOrderBook] = useState<Record<string, unknown>[]>([]);
  // Targets / stops just placed, awaiting the order book's word (watchPlaced). A cancel sent from here drops its check.
  const placedChecksRef = useRef(new Map<string, { label: string; deadline: number }>());
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
  // While a REAL reverse runs (reverseReal): OCO and the default target / stop watcher keep off its contract.
  const reverseBusyRef = useRef(false);
  const [toast, setToast] = useState<Toast | null>(null);
  // One-click size: the widget's top stepper sets it; Buy CE / Buy PE and the chain's B / S use it too.
  const [scalpLots, setScalpLots] = useState(1);

  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef(feed);
  const simRef = useRef(sim);
  useEffect(() => { feedRef.current = feed; simRef.current = sim; });

  // ── trade chimes ───────────────────────────────────────────────────
  // Entry / exit chimes come from changes in the position book (tradeChimeFor), a warning buzz from a REAL order that was
  // rejected or has an unknown outcome. Sound only adds to the toast. Browsers keep it silent until the first click.
  const [soundOn, setSoundOnState] = useState(true);
  const soundOnRef = useRef(true);
  useEffect(() => {
    const on = readPref(SOUND_KEY) !== '0';
    soundOnRef.current = on;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSoundOnState(on);
  }, []);
  const setSoundOn = useCallback((on: boolean) => { soundOnRef.current = on; setSoundOnState(on); savePref(SOUND_KEY, on ? '1' : '0'); }, []);
  useEffect(() => installAlertSoundUnlock(), []);
  // Every open tab polls the same REAL book: only the leader tab (or the tab that just sent an order) rings for it.
  const { leaderRef: soundLeaderRef } = useTabLeader('index-scalper-sound');
  const lastSentAtRef = useRef(0);

  // A warning (ok: false) stays up 15 s, a confirmation 6 s: "no stop on this position" must not flash past unread.
  const flash = useCallback((t: Toast) => {
    setToast(t);
    window.setTimeout(() => setToast(cur => (cur === t ? null : cur)), t.ok ? 6000 : 15000);
  }, []);

  // ── persisted per-viewer state ─────────────────────────────────────
  useEffect(() => {
    const v2 = loadJson<IndicatorInstance[] | null>(IND_KEY, null);
    const v1 = v2 ? null : loadJson<IndicatorInstance[] | null>(IND_KEY_V1, null);
    let saved = v2 ?? (Array.isArray(v1) ? migrateIndicatorsV1(v1) : null);
    // Volume became an indicator: add it once to a list saved before (hidden if the old "vol" switch was off). Once
    // only, so a viewer who later removes it keeps it removed.
    if (Array.isArray(saved) && readPref(VOL_ADDED_KEY) !== '1') saved = withVolume(saved, nextId(), readPref(VOL_KEY) !== '0');
    savePref(VOL_ADDED_KEY, '1');
    // Day High / Low (PDH, PDL, DH, DL) added 2026-11-26: switched on once for a saved list, so removing it sticks.
    if (Array.isArray(saved) && readPref(DAY_HL_ADDED_KEY) !== '1' && !saved.some(i => i.kind === 'daylevels')) saved = [...saved, newIndicator('daylevels', nextId())];
    savePref(DAY_HL_ADDED_KEY, '1');
    const trendSet = clampTrendSettings(loadJson<unknown>(TREND_SETTINGS_KEY, null));
    if (readPref(STRUCTURE_ADDED_KEY) !== '1') {
      if (trendSet.structure) {
        saved = withStructureLine(withStructure(Array.isArray(saved) ? saved : defaultIndicators(), true, nextId()), trendSet.structureLine);
        // Saved with the flag, in one step: this effect can run twice (React dev Strict Mode), and a second run that
        // found the flag but the old list would drop the indicator again.
        savePref(IND_KEY, JSON.stringify(saved));
      }
      savePref(STRUCTURE_ADDED_KEY, '1');
    }
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
    if (readPref(TREND_KEY) === '0') setShowTrend(false);
    setTrendSettingsState(trendSet);
    if (readPref(GRID_KEY) === '0') setShowGridState(false);
    setCandleColorRuleState(parseCandleColorRule(readPref(CANDLE_COLOR_KEY)));
    setOiModeState(parseOiMode(readPref(OI_MODE_KEY)));
    if (readPref(QUICK_ON_KEY) === '1') setQuickOnState(true);
    setQuickSettingsState(clampQuickSettings(loadJson<unknown>(QUICK_SETTINGS_KEY, null)));
    setDefBracketsState(clampDefaultBrackets(loadJson<unknown>(DEFAULT_BRACKETS_KEY, null)));
    setLayoutReady(true);
  }, []);
  const setOi = (on: boolean) => { setShowOi(on); savePref(OI_KEY, on ? '1' : '0'); };
  const setTrend = (on: boolean) => { setShowTrend(on); if (!on) setTrendMenu(false); savePref(TREND_KEY, on ? '1' : '0'); };
  const patchTrendSettings = (patch: Partial<TrendSettings>) => {
    setTrendSettingsState(prev => {
      const next = clampTrendSettings({ ...prev, ...patch });
      savePref(TREND_SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
    // One switch for the strip's Structure light AND the chart's HH / HL / LH / LL labels.
    if (patch.structure !== undefined) {
      const on = patch.structure;
      const line = trendSettings.structureLine;   // a click handler: this render's settings are the current ones
      setIndicators(p => withStructureLine(withStructure(p, on, nextId()), line));
    }
    // The line joining the chart's swings (the Market structure indicator's own `line` setting).
    if (patch.structureLine !== undefined) {
      const on = patch.structureLine;
      setIndicators(p => withStructureLine(p, on));
    }
  };
  // Trend candles: cycles through CANDLE_COLOR_RULES (Off -> EMA 9 & 20 -> ...), remembered.
  const cycleCandleColor = () => {
    const i = CANDLE_COLOR_RULES.findIndex(r => r.id === candleColorRule);
    const next = CANDLE_COLOR_RULES[(i + 1) % CANDLE_COLOR_RULES.length].id;
    setCandleColorRuleState(next); savePref(CANDLE_COLOR_KEY, next);
  };
  const toggleGrid = () => { const on = !showGrid; setShowGridState(on); savePref(GRID_KEY, on ? '1' : '0'); };
  const setOiMode = (m: OiMode) => { setOiModeState(m); savePref(OI_MODE_KEY, m); };
  const setQuickOn = (on: boolean) => { setQuickOnState(on); savePref(QUICK_ON_KEY, on ? '1' : '0'); if (!on) setQuickMenu(false); };
  const patchDefBrackets = (patch: Partial<DefaultBracketSettings>) => setDefBracketsState(prev => {
    const next = clampDefaultBrackets({ ...prev, ...patch });
    savePref(DEFAULT_BRACKETS_KEY, JSON.stringify(next));
    return next;
  });
  // Another tab changed it (switched it off): this tab follows at once, so it never keeps placing levels the user turned off.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEFAULT_BRACKETS_KEY) return;
      let v: unknown = null;
      try { v = e.newValue ? JSON.parse(e.newValue) : null; } catch { /* unreadable: the defaults */ }
      setDefBracketsState(clampDefaultBrackets(v));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const patchQuick = (patch: Partial<QuickSettings>) => setQuickSettingsState(prev => {
    const next = clampQuickSettings({ ...prev, ...patch });
    savePref(QUICK_SETTINGS_KEY, JSON.stringify(next));
    return next;
  });
  // The pane prop: null when off, else the settings (identity changes only when a setting does).
  // The saved settings capped at this instrument's per-order lots (CRUDEOIL 5): what Quick Trade shows and sends. The
  // saved values are left alone, so going back to NIFTY keeps its 10 lots.
  const quickMax = INSTRUMENTS[underlying].maxLots;
  const quickEff = useMemo<QuickSettings>(() => ({
    ...quickSettings,
    buyLots: Math.min(quickSettings.buyLots, quickMax),
    sellLots: Math.min(quickSettings.sellLots, quickMax),
    stepLots: Math.min(quickSettings.stepLots, quickMax),
  }), [quickSettings, quickMax]);
  const quickProp = useMemo(() => (quickOn ? quickEff : null), [quickOn, quickEff]);
  // The chip's + / - step, read at click time (a settings change must not rebuild the order callbacks).
  const stepLotsRef = useRef(quickEff.stepLots);
  useEffect(() => { stepLotsRef.current = quickEff.stepLots; }, [quickEff.stepLots]);
  // The widget's one-click lots, capped the same way when the instrument changes (10 on CRUDEOILM -> 5 on CRUDEOIL).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScalpLots(l => Math.min(l, INSTRUMENTS[underlying].maxLots));
  }, [underlying]);
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
  // Only a reply newer than the last one shown is drawn: a display poll sent before an order can land after the post-order
  // read (a Kotak cached read waits out the order's priority window) and would put the pre-order book back on screen.
  const posSeqRef = useRef(0);
  const posShownSeqRef = useRef(0);
  const loadPositions = useCallback(async (fresh = false): Promise<Record<string, unknown>[] | null> => {
    const seq = ++posSeqRef.current;
    try {
      if (!brokerLoadedRef.current) return null;
      const kotakCached = brokerRef.current === 'kotak' && fresh !== true;
      const r = await fetch(kotakCached ? '/api/index-scalper/kotak-positions' : scalperRoute(brokerRef.current, 'positions'));
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !j.data) { if (seq > posShownSeqRef.current) setPosErr(j.error ?? 'Could not load positions'); return null; }
      // The caller still gets its own (fresh) rows for sizing; only the screen skips an out-of-date reply.
      if (seq > posShownSeqRef.current) {
        posShownSeqRef.current = seq;
        setPosErr(null);
        setRealRows(j.data);
        setRealLoaded(true);
      }
      return j.data;
    } catch (e) { if (seq > posShownSeqRef.current) setPosErr(String((e as Error).message ?? e)); return null; }
  }, []);
  /** After this page's own REAL order or exit. Dhan's positions read is already live. Kotak's display read goes through the
   *  shared cache, which an order empties and then holds behind a 2 s priority window plus the account's read lane, so a
   *  new position took 5-6 s to show: read it live now, and once more 1.6 s later in case Kotak books the fill just after
   *  answering the order (just past the server's 1.5 s gap between Kotak positions reads, so it does not queue). */
  const refreshAfterOrder = useCallback(() => {
    if (brokerRef.current !== 'kotak') { void loadPositions(); return; }
    void loadPositions(true);
    setTimeout(() => { if (brokerRef.current === 'kotak') void loadPositions(true); }, 1600);
  }, [loadPositions]);

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
    // Kotak answers 100025 (and pauses every Kotak read) when positions are read too often: its book is polled every 5 s,
    // Dhan's every 3 s. The server also throttles Kotak positions reads (lib/kotakToken.ts KOTAK_PATH_GATES).
    const t = setInterval(() => { void loadPositions(); }, broker === 'kotak' ? 5000 : 3000);
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
  // For callbacks handed to the memoised chart: kotakPrice is rebuilt on every feed push (ltpById), so a callback that
  // listed it as a dependency gave the chart a new prop 20-40 times a second (full chart re-render on every push).
  const kotakPriceRef = useRef(kotakPrice);
  const kotakSymbolsRef = useRef(kotakSymbols);
  useEffect(() => { kotakPriceRef.current = kotakPrice; kotakSymbolsRef.current = kotakSymbols; });

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

  // Entry / exit chime off the book. The first book after a mode, broker or instrument change (or before it has loaded)
  // is only the baseline, so arming REAL over an open position or switching instruments never rings.
  const bookBaseRef = useRef<{ key: string; book: Map<string, number> } | null>(null);
  const bookReady = real ? realLoaded && (broker !== 'kotak' || !!kotakSymbols) : simReady;
  useEffect(() => {
    const key = `${real ? 'R' : 'S'}|${broker}|${underlying}`;
    const book = qtyBook(legs);
    const base = bookBaseRef.current;
    if (!bookReady) { bookBaseRef.current = null; return; }
    bookBaseRef.current = { key, book };
    if (!base || base.key !== key || !soundOnRef.current) return;
    // SIM is this tab's own paper book; a REAL change rings in the leader tab, or in the tab that just sent an order.
    if (real && !soundLeaderRef.current && Date.now() - lastSentAtRef.current > 15_000) return;
    const kind = tradeChimeFor(base.book, book);
    if (kind === 'entry') playEntryChime();
    else if (kind === 'exit') playExitChime();
  }, [legs, real, broker, underlying, bookReady, soundLeaderRef]);
  // Bottom panel rows: the REAL Dhan book (open + closed rows), or the SIM paper book in the same shape.
  const panelPositions: PositionRowView[] = useMemo(() => {
    if (real && broker === 'kotak') {
      // Kotak rows into the Dhan row shape: the trading symbol is the identity (in securityId, the repo rule), the
      // product in Dhan's words, contract fields from the symbol map, and NO unrealized figure (Kotak sends none: the
      // open part is priced off the live feed or stays unknown).
      const rows = realRows.map(r => {
        const sym = String(r.tradingSymbol ?? '');
        const info = kotakSymbols?.[sym];
        return {
          ...r, securityId: sym, productType: dashProduct(r.productType), exchangeSegment: dhanSegmentOfSymbol(sym), unrealizedProfit: undefined,
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
        exchange: INSTRUMENTS[underlying].exchange,
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
  // What the Orders tab and the charts show: in SIM the paper working orders come first (status "PENDING (SIM)").
  const simOrderRows = useMemo(() => simOrders.filter(o => o.underlying === underlying).map(simOrderRow), [simOrders, underlying]);
  const ordersView = useMemo(() => (real ? panelOrders : [...simOrderRows, ...panelOrders]), [real, panelOrders, simOrderRows]);

  // Each contract's OWN lot size (lib/indexScalperLots.ts): the expiry on screen gives its strikes' lot, Kotak's symbol
  // lookup each Kotak contract's, and the master list (api/index-scalper/lots) a Dhan position / order in another expiry.
  // SENSEX's lot changes with the series (20 -> 25 from Jan 2027): a Dec leg sized with a Jan screen's lot could send 5
  // Dec lots for "4". Unknown = refused, never the screen's lot.
  const [masterLots, setMasterLots] = useState<{ u: Underlying; lots: Record<string, number> }>({ u: underlying, lots: {} });
  const lotMap = useMemo(() => buildLotMap({
    screenDhanIds: [...feed.strikeIds.values()].flatMap(v => [v.ceId, v.peId].filter((x): x is string => !!x)),
    screenLot: feed.lotSize,
    screenKotakSymbols: feed.kotak ? [...feed.kotak.strikes.values()].flatMap(v => [v.ceSymbol, v.peSymbol].filter((x): x is string => !!x)) : [],
    kotakScreenLot: feed.kotak?.lotSize ?? null,
    kotakSymbols: feed.kotak?.symbols ?? null,
    master: masterLots.u === underlying ? masterLots.lots : null,
  }), [feed.strikeIds, feed.lotSize, feed.kotak, masterLots, underlying]);
  const lotMapRef = useRef(lotMap);
  useEffect(() => { lotMapRef.current = lotMap; });
  /** The lot of this contract (Dhan id or Kotak symbol), for qtyLots / lotUnits; null = unknown (refuse). */
  const lotOf = useCallback((id: string | null | undefined) => contractLot(underlying, id, lotMapRef.current), [underlying]);
  // Ask the master list for the lot of every held / working Dhan contract the screen expiry does not cover.
  const lotWanted = useMemo(() => isMcx(underlying) ? [] : missingLotIds([
    ...legs.map(l => l.securityId), ...ordersView.map(o => o.securityId ?? ''),
  ], lotMap), [underlying, legs, ordersView, lotMap]);
  const lotWantedKey = lotWanted.join(',');
  useEffect(() => {
    if (!lotWantedKey) return;
    let dead = false;
    fetch(`/api/index-scalper/lots?segment=${INSTRUMENTS[underlying].dhanSegment}&ids=${lotWantedKey}`)
      .then(r => r.json())
      .then((j: { success: boolean; lots?: Record<string, number> }) => {
        if (dead || !j.success || !j.lots) return;
        setMasterLots(prev => ({ u: underlying, lots: { ...(prev.u === underlying ? prev.lots : {}), ...j.lots } }));
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [lotWantedKey, underlying]);

  // ── order placement ────────────────────────────────────────────────
  interface Outcome { ok: boolean; unknown?: boolean; text: string; orderId?: string }

  /** One REAL order on the page's broker. Dhan: /api/scalper/fast-order (security id, `isx` correlation). Kotak: the
   *  page's own route, which records the order ID as this page's (trading symbol; opens capped, closes not). */
  const sendRealOnce = useCallback(async (body: Record<string, unknown>, intent: 'open' | 'close'): Promise<Outcome> => {
    try {
      const kotak = brokerRef.current === 'kotak';
      const res = await fetch(kotak ? '/api/index-scalper/kotak-order' : '/api/scalper/fast-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kotak
          ? { ...body, intent, idempotencyKey: newKey() }
          // Opens carry the instrument's capped tag (isx / isxc); closes the uncapped 'isxx', so a position larger than
          // one order's cap (10 CRUDEOIL lots vs its 5-lot cap) can always be closed. Every tag starts with 'isx'.
          : { exchangeSegment: INSTRUMENTS[underlying].dhanSegment, ...body, source: intent === 'close' ? CLOSE_SOURCE : INSTRUMENTS[underlying].orderSource, idempotencyKey: newKey() }),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string; unknown?: boolean; warning?: string };
      if (kotak) void loadKotakRecords();
      if (j.success) return { ok: true, orderId: j.order_id, text: `Order ${j.order_id ?? ''} placed${j.warning ? ` (${j.warning})` : ''}` };
      if (j.unknown || res.status === 504) return { ok: false, unknown: true, text: j.error ?? 'Order status unknown: check Positions / Orders before retrying' };
      return { ok: false, text: j.error ?? 'Order rejected' };
    } catch (e) {
      // A throw after the request left may still have booked it: report unknown, never retry.
      return { ok: false, unknown: true, text: `No reply (${String((e as Error).message ?? e)}). Check Positions / Orders before retrying` };
    }
  }, [loadKotakRecords, underlying]);
  /** sendRealOnce plus the warning buzz on a rejected / unknown order, and the "this tab just sent" mark for chimes. */
  const sendReal = useCallback(async (body: Record<string, unknown>, intent: 'open' | 'close' = 'open'): Promise<Outcome> => {
    lastSentAtRef.current = Date.now();
    const out = await sendRealOnce(body, intent);
    if (!out.ok && soundOnRef.current) playWarnChime();
    return out;
  }, [sendRealOnce]);

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
    // Flat or flipped through zero: the old side's paper target / stop no longer belongs to this position (a long's
    // target left on a new short reads as already hit and closed it at once). Reverse already clears them.
    if (before !== 0 && (after === 0 || Math.sign(after) !== Math.sign(before))) {
      setSimBrackets(prev => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
    }
  }, [rememberSpot, setSimBrackets]);

  /** After this page's MARKET order on an option was accepted: when it opened a position from flat (or flipped one), the
   *  default target / stop is queued for that leg; the watcher below places it once the book shows the leg. */
  // `before` / `orderQty` are in the leg's own unit (broker netQty; paper units); `entry` is the price the order went out
  // at (the live premium; the paper fill), never the broker's day average (lib/indexScalperDefaultBrackets).
  const queueDefaultBrackets = useCallback((key: string, req: TicketRequest, o: { before: number; orderQty: number; entry: number; product: string; isReal: boolean }) => {
    const s = defBracketsRef.current;
    if (!s.on || req.closesLeg || req.orderType !== 'MARKET' || req.contract.type === 'FUT') return;
    const long = req.side === 'BUY';
    if (!opensPosition(o.before, long, o.orderQty)) return; // adding to or reducing a position: its levels stay as they are
    pendingDefaultsRef.current.set(key, {
      p: { legKey: key, long, at: Date.now(), tpPct: s.tpPct, slPct: s.slPct,
        tpUnit: s.tpUnit, slUnit: s.slUnit, tpPts: s.tpPts, slPts: s.slPts, entry: o.entry, product: o.product,
        expectQty: o.before + (long ? o.orderQty : -o.orderQty) },
      real: o.isReal,
    });
    setPendingSeq(n => n + 1);
  }, [setPendingSeq]);

  const placeContract = useCallback(async (req: TicketRequest): Promise<Outcome> => {
    const f = feedRef.current;
    const isFut = req.contract.type === 'FUT';
    // THIS contract's own lot (lotOf: the screen expiry's strikes, Kotak's symbol map, or the master list for another
    // expiry): a held SENSEX Dec leg traded with a Jan screen must not be sized at 25. Unknown = refused, never guessed.
    const c0 = req.contract;
    const unitsPerLot = lotUnits(underlying, lotOf(c0.securityId) ?? lotOf(c0.tradingSymbol));
    // Per-instrument cap on OPENING orders (CRUDEOIL 5 lots, else 20); the server re-checks it through the source tag.
    // An order that closes a leg (TP / SL bracket, the chip's "-") is never refused for its size.
    const size = orderUnits(req.lots, unitsPerLot, req.closesLeg ? Number.MAX_SAFE_INTEGER : INSTRUMENTS[underlying].maxLots);
    if (!size.ok) return { ok: false, text: `${underlying}: ${size.error}` };
    const c = req.contract;
    if (!c.securityId && !c.tradingSymbol) return { ok: false, text: 'No contract identifier for this order' };
    // MCX crude opens NRML (MARGIN) only, whatever the caller asked. An order closing an existing leg (TP / SL bracket)
    // keeps that leg's own product: a MARGIN order against an MIS leg would open a second position, not reduce it.
    const product = req.closesLeg ? req.product : openingProduct(underlying, req.product);
    // The security id was picked for one expiry; never send it under a ticket that now shows another (except futures).
    if (!isFut && !req.exactContract && c.expiry !== f.expiry) return { ok: false, text: `This ticket was opened for the ${c.expiry || 'previous'} expiry: reopen it from the chain` };
    // Live tick only (ltpById is built from the bridge's live chain): never the ticket's display price, which can be a
    // REST snapshot or the previous close.
    const live = c.securityId ? f.ltpById.get(c.securityId) ?? null : null;
    const symbol = isFut
      ? `${underlying}-${c.expiry}-FUT`
      : `${underlying}-${f.expiry}-${c.strike}-${c.type}`;

    if (!real) {
      if (!(live && live > 0) || f.feedAgeSec === null) return { ok: false, text: 'No live price for the paper order' };
      if (f.stale) return { ok: false, text: 'Live prices are stale: not taking a paper order on an old price' };
      if (!f.marketOpen) return { ok: false, text: `${INSTRUMENTS[underlying].exchange} is closed: paper orders work only during the session` };
      const fillNow = req.orderType === 'MARKET'
        || (req.orderType === 'LIMIT' && (req.side === 'BUY' ? (req.price ?? 0) >= live : (req.price ?? 0) <= live));
      if (!fillNow) {
        // A limit away from the market, a stop or a stop-limit: a paper WORKING order, filled by the watcher when the
        // contract's live price reaches it. The same placement rules as the broker's (lib/indexScalperOrderEdit).
        const tick = isFut ? INSTRUMENTS[underlying].futTick : INSTRUMENTS[underlying].optTick;
        const err = orderEditError(req.orderType, req.side, req.price ?? 0, req.trigger ?? 0, live, tick);
        if (err) return { ok: false, text: `SIM: ${err}` };
        const o: SimOrder = {
          id: `SIM-${Date.now().toString(36)}${++simOrderSeq.current}`, underlying, securityId: c.securityId!, symbol,
          type: c.type, strike: c.strike, expiry: isFut ? c.expiry : (f.expiry ?? ''), side: req.side,
          orderType: req.orderType as SimOrder['orderType'], price: req.orderType === 'STOP_LOSS_MARKET' ? null : req.price,
          trigger: req.orderType === 'LIMIT' ? null : req.trigger, units: size.units, lots: req.lots, product,
          placedAt: Date.now(), day: istDayKey(),
        };
        setSimOrders([...simOrdersRef.current, o]);
        const lvl = o.orderType === 'LIMIT' ? `@ ${o.price?.toFixed(2)}` : o.orderType === 'STOP_LOSS' ? `trigger ${o.trigger?.toFixed(2)} limit ${o.price?.toFixed(2)}` : `trigger ${o.trigger?.toFixed(2)}`;
        return { ok: true, text: `SIM ${req.side} ${o.orderType === 'LIMIT' ? 'Limit' : o.orderType === 'STOP_LOSS' ? 'Stop Limit' : 'Stop'} ${req.lots} lot${req.lots > 1 ? 's' : ''} ${isFut ? 'FUT' : `${c.strike} ${c.type}`} ${lvl}: working, fills when the price gets there` };
      }
      const fillPx = live;
      const simKey = c.securityId ?? `${c.type}${c.strike}`;
      const simBefore = simRef.current.legs[simKey]?.netQty ?? 0;
      simFill(c, req.side, size.units, fillPx, symbol);
      queueDefaultBrackets(simKey, req, { before: simBefore, orderQty: size.units, entry: fillPx, product: '', isReal: false });
      return { ok: true, text: `SIM ${req.side} ${req.lots} lot${req.lots > 1 ? 's' : ''} ${isFut ? 'FUT' : `${c.strike} ${c.type}`} @ ${fillPx.toFixed(2)}` };
    }

    // A market order needs a live feed: stale ticks, or none at all (the chain may be a REST snapshot then), refuse it.
    if (req.orderType === 'MARKET' && !f.marketOpen) return { ok: false, text: `${INSTRUMENTS[underlying].exchange} is closed: refusing a market order` };
    if (req.orderType === 'MARKET' && (f.stale || f.feedAgeSec === null)) return { ok: false, text: f.stale ? 'Live prices are stale: refusing a market order' : 'No live prices (tick feed not running): refusing a market order' };
    if (!brokerLoadedRef.current) return { ok: false, text: 'Broker not loaded yet' };
    if (brokerRef.current === 'kotak') {
      // Kotak: its own trading symbol and lot size for the contract on screen, never the Dhan security id.
      const k = f.kotak;
      if (!k) return { ok: false, text: f.kotakError ?? 'Kotak contracts are still loading' };
      if (!isFut && !req.exactContract && k.expiry !== c.expiry) return { ok: false, text: 'Kotak contracts are for another expiry: wait for them to load' };
      // An existing position's own trading symbol (Reverse) is sent as is: a lookup by strike in the expiry on screen
      // would pick another contract when the position is in another expiry or futures month.
      const sym = req.exactContract ? c.tradingSymbol : isFut
        ? (f.future?.kotakSymbol ?? c.tradingSymbol)
        : (c.type === 'CE' ? k.strikes.get(c.strike)?.ceSymbol : k.strikes.get(c.strike)?.peSymbol);
      if (!sym) return { ok: false, text: `No Kotak contract for ${isFut ? 'FUT' : `${c.strike} ${c.type}`} on ${c.expiry}` };
      const kotakLot = lotUnits(underlying, lotOf(sym));
      if (kotakLot === null) return { ok: false, text: 'Kotak lot size unknown for this contract: refusing the order' };
      const kQty = kotakOrderQty(underlying, req.lots, kotakLot);
      const before = legsRef.current.find(l => l.securityId === sym)?.netQty ?? 0;
      const out = await sendReal({
        tradingSymbol: sym, quantity: kQty, side: req.side, orderType: req.orderType,
        price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, product,
      }, req.closesLeg ? 'close' : 'open');
      if (out.ok && before === 0) rememberSpot(sym, f.spot);
      if (out.ok) queueDefaultBrackets(sym, req, { before, orderQty: kQty, entry: live ?? 0, product, isReal: true });
      refreshAfterOrder();
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
    }, req.closesLeg ? 'close' : 'open');
    if (out.ok && before === 0) rememberSpot(c.securityId, f.spot);
    if (out.ok) queueDefaultBrackets(c.securityId, req, { before, orderQty: dQty, entry: live ?? 0, product, isReal: true });
    loadPositions();
    void loadOrders();
    return out;
  }, [real, sendReal, simFill, setSimOrders, rememberSpot, loadPositions, refreshAfterOrder, loadOrders, underlying, queueDefaultBrackets, lotOf]);

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
    if (!feedRef.current.marketOpen) return { ok: false, text: `${INSTRUMENTS[underlying].exchange} is closed: paper positions close only during the session` };
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

  // A placed target / stop is not a working one until the order book says so: a broker can return an order number and
  // reject it a moment later in RMS (Kotak: SL-M on options, 2026-11-26). Each placed bracket is checked against the
  // order book (an extra read 2.5 s after the send, then the regular poll) for up to 30 s; a rejection or cancel is
  // reported loudly with its reason, and an order never seen in that time is reported too.
  const watchPlaced = useCallback((orderId: string, label: string) => {
    placedChecksRef.current.set(orderId, { label, deadline: Date.now() + 30_000 });
    setTimeout(() => { void loadOrders(); }, 2500);
    setTimeout(() => { setPlacedCheckSeq(n => n + 1); }, 31_000);
  }, [loadOrders]);
  const [placedCheckSeq, setPlacedCheckSeq] = useState(0);
  useEffect(() => { placedChecksRef.current.clear(); }, [real, broker, underlying]);
  useEffect(() => {
    const checks = placedChecksRef.current;
    if (!checks.size) return;
    const now = Date.now();
    for (const [id, c] of [...checks]) {
      const v = placedOrderState(orderBook, id);
      if (v.state === 'live') { checks.delete(id); continue; }
      if (v.state === 'missing' && now < c.deadline) continue;
      checks.delete(id);
      const text = v.state === 'rejected'
        ? `${c.label} REJECTED by the broker (order ${id}): ${v.reason}. ${c.label.startsWith('Exit') ? 'The position is STILL OPEN.' : `The position has NO ${c.label.startsWith('Stop') ? 'stop' : 'target'}.`}`
        : v.state === 'cancelled'
          ? `${c.label} was cancelled at the broker (order ${id}): it is not working.`
          : `${c.label} (order ${id}) is not in the order book after 30 s: check Orders before relying on it.`;
      flash({ ok: false, text });
      if (soundOnRef.current) playWarnChime();
    }
  }, [orderBook, placedCheckSeq, flash]);

  const cancelQuiet = useCallback(async (orderId: string): Promise<string | null> => {
    placedChecksRef.current.delete(orderId);
    try {
      const r = brokerRef.current === 'kotak'
        ? await fetch('/api/scalper/kotak/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId }) })
        : await fetch('/api/scalper/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, broker: 'dhan' }) });
      const j = await r.json() as { success: boolean; error?: string };
      return j.success ? null : (j.error ?? 'cancel failed');
    } catch (e) { return `no reply (${String((e as Error).message ?? e)})`; }
  }, []);

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
      // Slices are whole lots in Kotak's unit: lotUnits gives barrels per lot on MCX (contractLot's 1 would allow a
      // part-lot slice, rejected mid-exit), the contract's own lot on an index.
      const slices = freezeSlices(order.units, k?.freezeQty ?? null, lotUnits(underlying, lotOf(leg.securityId)));
      // Kotak's RMS adds the closing side's working orders to the exit: a full-size target still working turns the exit
      // into a fresh position, rejected for margin (2026-11-26). Cancel THIS page's own ones first and see them gone;
      // another placer's order is never cancelled from here, so an exit it would overfill is refused.
      const blk = exitBlockers(book, leg.securityId, order.side, order.units, Math.abs(leg.netQty), recordedIds(withResolvedUnknowns(records, book)));
      if (blk.foreign.length) {
        return { ok: false, text: `${label}: working ${order.side} order${blk.foreign.length === 1 ? '' : 's'} ${blk.foreign.join(', ')} placed elsewhere would make this exit a fresh position (Kotak rejects it for margin): cancel ${blk.foreign.length === 1 ? 'it' : 'them'} first, nothing sent` };
      }
      if (blk.cancel.length) {
        const errs: string[] = [];
        for (const id of blk.cancel) { const e = await cancelQuiet(id); if (e) errs.push(`${id} (${e})`); }
        if (errs.length) return { ok: false, text: `${label}: could not cancel this page's working order${errs.length === 1 ? '' : 's'} ${errs.join(', ')} before the exit, nothing sent` };
        let gone = false;
        for (let i = 0; i < 6 && !gone; i++) {
          await new Promise(r => setTimeout(r, 500));
          const g = await loadKotakGuard();
          if (g) gone = exitBlockers(g.book, leg.securityId, order.side, order.units, Math.abs(leg.netQty), new Set(blk.cancel)).cancel.length === 0;
        }
        if (!gone) return { ok: false, text: `${label}: cancelled ${blk.cancel.join(', ')} but Kotak still shows ${blk.cancel.length === 1 ? 'it' : 'them'} working; nothing sent, try Exit again` };
        flash({ ok: true, text: `${label}: cancelled this page's working order${blk.cancel.length === 1 ? '' : 's'} ${blk.cancel.join(', ')} so the exit is not refused` });
      }
      let sent = 0;
      out = { ok: true, text: 'Closed' };
      for (const q of slices) {
        out = await sendReal({ tradingSymbol: leg.securityId, quantity: q, side: order.side, orderType: 'MARKET', product: leg.product }, 'close');
        if (!out.ok) break;
        // Kotak returns an order number and may reject it a moment later in RMS: check the order book for each slice.
        if (out.orderId) watchPlaced(out.orderId, `Exit ${label}`);
        sent += q;
      }
      if (slices.length > 1) {
        out = out.ok
          ? { ...out, text: `${label}: closed ${sent} in ${slices.length} orders (exchange freeze limit)` }
          : { ...out, text: `${label}: ${sent} of ${order.units} closed, then: ${out.text}` };
      }
    } else {
      out = await sendReal({ securityId: leg.securityId, quantity: order.units, side: order.side, orderType: 'MARKET', ...product.fields }, 'close');
      if (out.ok && out.orderId) watchPlaced(out.orderId, `Exit ${label}`);
    }
    return out;
  }, [sendReal, cancelQuiet, loadKotakGuard, watchPlaced, flash, lotOf, underlying]);

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
        refreshAfterOrder();
      }
      flash({ ok: out.ok, text: out.text });
    } finally { setExitingId(null); }
  }, [exitingId, real, exitSimLeg, readExitState, exitRealRow, refreshAfterOrder, flash]);

  // Quantity this page's own orders filled today, per leg id: only to say which legs Exit All would close that were opened
  // elsewhere (exits themselves close any position). Read from the polled order book (at most one poll old).
  const openedHere = useMemo(
    () => (broker === 'kotak' ? ownedQtyFromKotakOrders(orderBook, kotakRecords) : pageFilledQty(orderBook)),
    [broker, orderBook, kotakRecords],
  );
  /** True when every leg's close was sent (SIM: closed); false when something was refused, unknown or not started. */
  const exitAll = useCallback(async (confirmed = false): Promise<boolean> => {
    if (exitingId || legs.length === 0) return false;
    if (real && !confirmed) {
      const elsewhere = legsOpenedElsewhere(legs, openedHere);
      if (elsewhere.length) { setExitAllAsk(elsewhere); return false; }
    }
    setExitAllAsk(null);
    setExitingId('all');
    try {
      if (!real) {
        let failed = 0;
        for (const l of legs) { const o = exitSimLeg(l); if (!o.ok) failed++; }
        flash({ ok: failed === 0, text: failed ? `${failed} paper leg(s) not closed: no live price, or prices are stale` : 'SIM: all positions closed' });
        return failed === 0;
      }
      const st = await readExitState();
      if (typeof st === 'string') { flash({ ok: false, text: st }); return false; }
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
      refreshAfterOrder();
      return problems.length === 0;
    } finally { setExitingId(null); }
  }, [exitingId, legs, real, openedHere, exitSimLeg, readExitState, exitRealRow, refreshAfterOrder, flash]);

  // ── global MTM target / stop (lib/indexScalperMtmGuard.ts) ────────────────────────────────────────────────────────
  // Watches the day P&L (realized + open) of the underlying on screen (REAL: only its rows of the account's book, shown in
  // the control; the account panel's total is account-wide) and runs Exit All once when it reaches the
  // target or falls to minus the stop, then switches itself off (re-arm to carry on), like the Price Ladder's guard.
  // Paused on stale prices or a partial total. Browser-only: the page must be open (REAL: armed). A Web Lock and a
  // 2 s hold after the exit keep a second open tab from closing the same book twice (its Exit All re-reads it).
  const [mtm, setMtm] = useState<MtmGuardSettings>(MTM_GUARD_DEFAULTS);
  // The guard acts only on the SAVED settings (read after mount), never on the defaults of the first render.
  const [mtmLoaded, setMtmLoaded] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- per-viewer settings read after mount (no SSR mismatch)
    setMtm(readMtmGuard(readPref(MTM_KEY)));
    setMtmLoaded(true);
  }, []);
  const saveMtm = useCallback((next: MtmGuardSettings) => { setMtm(next); savePref(MTM_KEY, JSON.stringify(next)); }, []);
  const [mtmNote, setMtmNote] = useState<string | null>(null);
  const mtmFiringRef = useRef(false);
  // REAL rows are the whole account; Exit All closes only this underlying, so only its rows (open and closed) are summed.
  const guardIds = useMemo(() => (real ? guardScopeIds(realRows, underlying, broker === 'kotak' ? 'kotak' : 'dhan') : null), [real, realRows, underlying, broker]);
  const dayTotal = useMemo(
    () => dayPnl(guardIds ? panelPositions.filter(r => guardIds.has(r.securityId)) : panelPositions, real ? realLoaded && !posErr : true),
    [panelPositions, guardIds, real, realLoaded, posErr]);
  const pricesLive = !feed.stale && feed.feedAgeSec !== null;
  // The first priced total after a mode / broker / instrument change is a baseline: a day ALREADY past a level when the
  // book loads (arming REAL after a loss) switches the guard off with a message instead of exiting everything at once.
  const mtmBaseRef = useRef<string | null>(null);
  const mtmScopeKey = `${real ? 'real' : 'sim'}|${broker}|${underlying}`;
  useEffect(() => {
    if (!mtmLoaded || !mtm.on || mtmFiringRef.current || exitingId !== null || legs.length === 0) return;
    if (!pricesLive || !bookReady) return; // a P&L on old prices / a book not read yet must not exit (or hold) anything
    const trip = mtmGuardTrip(mtm, dayTotal.pnl, dayTotal.unpriced, legs.length);
    const firstLook = mtmBaseRef.current !== mtmScopeKey;
    if (dayTotal.pnl !== null && dayTotal.unpriced === 0) mtmBaseRef.current = mtmScopeKey;
    if (!trip) return;
    if (firstLook) {
      saveMtm({ ...mtm, on: false });
      setMtmNote(`already past the ${trip.kind} at load: off`);
      flash({ ok: false, text: `MTM exit switched OFF, not fired: this book's day P&L ${Math.round(trip.pnl).toLocaleString('en-IN')} was already past the ${trip.kind} (₹${trip.level.toLocaleString('en-IN')}) when it loaded. Change the level, then switch it on.` });
      if (soundOnRef.current) playWarnChime();
      return;
    }
    mtmFiringRef.current = true;
    saveMtm({ ...mtm, on: false });
    const what = trip.kind === 'target' ? `target ₹${trip.level.toLocaleString('en-IN')} reached` : `stop loss ₹${trip.level.toLocaleString('en-IN')} hit`;
    const text = `MTM ${what} (P&L ${trip.pnl >= 0 ? '+' : ''}${Math.round(trip.pnl).toLocaleString('en-IN')}): Exit All${real ? '' : ' (SIM)'}. The MTM exit is now off; switch it on to re-arm.`;
    setMtmNote(`${trip.kind === 'target' ? 'Target' : 'Stop'} hit: exited, now off`);
    flash({ ok: trip.kind === 'target', text });
    if (soundOnRef.current) playWarnChime();
    const run = async () => {
      const ok = await exitAll(true);
      if (!ok) {
        // The guard is already off: say loudly that something may still be open (Exit All's own message has the detail).
        setMtmNote('exit incomplete: check positions');
        flash({ ok: false, text: `MTM ${trip.kind} exit did not close everything: check Positions now. The MTM exit is off.` });
        if (soundOnRef.current) playWarnChime();
      }
      if (real) await new Promise(r => setTimeout(r, 2000));
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    void (locks?.request ? locks.request('index-scalper-mtm-exit', run) : run()).finally(() => { mtmFiringRef.current = false; });
  }, [mtm, mtmLoaded, dayTotal, legs.length, exitingId, pricesLive, bookReady, mtmScopeKey, real, saveMtm, exitAll, flash]);
  const onMtmChange = useCallback((next: MtmGuardSettings): boolean => {
    if (next.on) {
      // Switching on, or editing a level while on, so that the current P&L is already past it would exit at once: refuse.
      const t = mtmGuardTrip(next, dayTotal.pnl, dayTotal.unpriced, legs.length);
      if (t) { flash({ ok: false, text: `Day P&L ${Math.round(t.pnl).toLocaleString('en-IN')} is already past that ${t.kind} (₹${t.level.toLocaleString('en-IN')}): not applied, it would Exit All at once` }); return false; }
    }
    setMtmNote(null);
    saveMtm(next);
    return true;
  }, [dayTotal, legs.length, saveMtm, flash]);
  const mtmShownNote = mtmNote ?? (mtm.on && legs.length > 0
    ? (!pricesLive ? 'paused: prices stale' : dayTotal.unpriced > 0 ? 'paused: a position has no price' : null)
    : null);

  // ── trailing stop loss (TSL) ───────────────────────────────────────
  // Browser-only (owner's choice, 2026-11-25): no broker order. The stop follows the best price of the leg's own
  // instrument (lib/indexScalperTrail.ts = the XY ladder's continuous trail) and this tab sends a market exit through the
  // normal exit path (fresh broker read, any owner) when it is crossed. Each tab runs the trails it holds; a REAL trail
  // exit takes a per-contract Web Lock, so a second tab's exit re-reads the book after the first and finds it flat.
  // SIM trails are saved with the paper book; REAL trails end when REAL is disarmed or the page reloads.
  const [trails, setTrailsState] = useState<Record<string, TrailState>>({});
  const trailsRef = useRef(trails);
  const saveTrails = useCallback((next: Record<string, TrailState>) => {
    trailsRef.current = next;
    setTrailsState(next);
    const sim = Object.fromEntries(Object.entries(next).filter(([, t]) => t.mode === 'SIM'));
    savePref(TRAIL_KEY, JSON.stringify(sim));
  }, []);
  useEffect(() => {
    let saved: Record<string, TrailState> = {};
    try { saved = validTrails(JSON.parse(readPref(TRAIL_KEY) ?? '{}')); } catch { saved = {}; }
    const sim = Object.fromEntries(Object.entries(saved).filter(([, t]) => t.mode === 'SIM'));
    trailsRef.current = sim;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrailsState(sim);
  }, []);
  // Leaving REAL (or switching broker) ends its trails: they would otherwise wake up on a book they no longer watch.
  useEffect(() => {
    const cur = trailsRef.current;
    const keep = Object.fromEntries(Object.entries(cur).filter(([, t]) => t.mode === 'SIM' || (real && t.broker === broker)));
    if (Object.keys(keep).length !== Object.keys(cur).length) saveTrails(keep);
  }, [real, broker, saveTrails]);
  const trailTick = useCallback((leg: ScalperLeg) => (leg.type === 'FUT' ? INSTRUMENTS[underlying].futTick : INSTRUMENTS[underlying].optTick), [underlying]);

  const onSetTrail = useCallback((leg: ScalperLeg, pts: number, tick: number) => {
    const f = feedRef.current;
    const cur = trailsRef.current[leg.id];
    let t: TrailState | string;
    if (cur) t = retrail(cur, pts, tick);
    else if (f.stale || f.feedAgeSec === null) t = 'Live prices are stale: not starting a trailing stop on an old price';
    else t = armTrail(leg, leg.ltp, pts, tick, real ? 'REAL' : 'SIM', brokerRef.current);
    if (typeof t === 'string') { flash({ ok: false, text: t }); return; }
    saveTrails({ ...trailsRef.current, [leg.id]: t });
    flash({ ok: true, text: `${real ? '' : 'SIM '}TSL ${leg.type}${leg.type === 'FUT' ? '' : ` ${leg.strike}`}: stop ${t.sl.toFixed(2)}, ${pts} pts behind the best price (runs in this tab)` });
  }, [real, saveTrails, flash]);
  const onCancelTrail = useCallback((legId: string) => {
    if (!trailsRef.current[legId]) return;
    const next = { ...trailsRef.current };
    delete next[legId];
    saveTrails(next);
    flash({ ok: true, text: 'Trailing stop removed' });
  }, [saveTrails, flash]);

  // Retry gate and failure count per leg: an exit that was refused before sending is retried after 3 s, three times.
  const trailRetryRef = useRef<Record<string, { at: number; fails: number }>>({});
  const exitingIdRef = useRef(exitingId);
  useEffect(() => { exitingIdRef.current = exitingId; });
  const dropTrail = useCallback((legId: string) => {
    if (!trailsRef.current[legId]) return;
    const next = { ...trailsRef.current };
    delete next[legId];
    saveTrails(next);
  }, [saveTrails]);
  const fireTrail = useCallback(async (leg: ScalperLeg, t: TrailState) => {
    const name = `${leg.type}${leg.type === 'FUT' ? '' : ` ${leg.strike}`}`;
    const gate = trailRetryRef.current[leg.id] ?? { at: 0, fails: 0 };
    trailRetryRef.current[leg.id] = { at: Date.now() + 3000, fails: gate.fails };
    const failed = (text: string) => {
      const fails = gate.fails + 1;
      if (fails >= 3) { dropTrail(leg.id); delete trailRetryRef.current[leg.id]; flash({ ok: false, text: `TSL ${name}: exit failed 3 times, trailing stop removed: ${text}` }); return; }
      trailRetryRef.current[leg.id] = { at: Date.now() + 3000, fails };
      flash({ ok: false, text: `TSL ${name}: ${text} (retrying)` });
    };
    if (t.mode === 'SIM') {
      const o = exitSimLeg(leg);
      if (!o.ok) { failed(o.text); return; }
      dropTrail(leg.id); delete trailRetryRef.current[leg.id];
      flash({ ok: false, text: `Trailing SL hit: SIM ${name} closed @ ${leg.ltp?.toFixed(2) ?? '—'} (stop ${t.sl.toFixed(2)})` });
      return;
    }
    const run = async () => {
      if (exitingIdRef.current) { trailRetryRef.current[leg.id] = { at: Date.now() + 1000, fails: gate.fails }; return; }
      setExitingId(leg.id);
      try {
        const st = await readExitState();
        if (typeof st === 'string') { failed(st); return; }
        const row = st.live.find(l => l.id === leg.id);
        // Gone or flipped since: nothing of this trail is left to close.
        if (!row || (row.netQty > 0) !== t.isLong) { dropTrail(leg.id); delete trailRetryRef.current[leg.id]; return; }
        const o = await exitRealRow(row, st.records, st.book);
        refreshAfterOrder();
        if (o.ok || o.unknown) {
          // An unknown outcome is never resent (the page rule): the trail ends and the warning is shown.
          dropTrail(leg.id); delete trailRetryRef.current[leg.id];
          flash({ ok: o.ok, text: o.ok ? `Trailing SL hit: ${name} exit sent (stop ${t.sl.toFixed(2)}): ${o.text}` : `TSL ${name}: ${o.text}` });
          return;
        }
        failed(o.text);
      } finally { setExitingId(null); }
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks?.request) await locks.request(`index-scalper-exit:${leg.securityId}`, run);
    else await run();
  }, [exitSimLeg, readExitState, exitRealRow, refreshAfterOrder, dropTrail, flash]);

  // The watcher: every book / price change steps each trail of the current mode; stale or closed-market prices pause it.
  useEffect(() => {
    if (!bookReady) return;
    const cur = trailsRef.current;
    const ids = Object.keys(cur);
    if (ids.length === 0) return;
    const mode = real ? 'REAL' : 'SIM';
    const f = feedRef.current;
    const priceOk = !f.stale && f.feedAgeSec !== null && f.marketOpen;
    let next = cur;
    const fire: [ScalperLeg, TrailState][] = [];
    for (const id of ids) {
      const t = cur[id];
      if (t.mode !== mode) continue;
      const leg = legs.find(l => l.id === id);
      if (!trailStillValid(t, leg, mode, broker)) {
        next = { ...next }; delete next[id]; delete trailRetryRef.current[id];
        continue;
      }
      if (!priceOk || !leg || leg.ltp === null || !(leg.ltp > 0)) continue;
      const r = stepTrail(t, leg.ltp, trailTick(leg));
      if (r.state !== t) next = { ...next, [id]: r.state };
      if (r.hit && (trailRetryRef.current[id]?.at ?? 0) <= Date.now()) fire.push([leg, r.state]);
    }
    if (next !== cur) saveTrails(next);
    for (const [leg, t] of fire) void fireTrail(leg, t);
  }, [legs, real, broker, bookReady, trailTick, saveTrails, fireTrail]);

  /** Cancel any working order on the broker's book (this page's, the mobile app's, another terminal's). */
  const sendCancel = useCallback(async (orderId: string) => {
    placedChecksRef.current.delete(orderId);
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
  /** Cancel from the panel / chart: this page's own order at once; any other placer's (a strategy's stop, the mobile
   *  app, another terminal) only after a confirmation, since on the chart it looks just like this page's own. */
  const panelOrdersRef = useRef(ordersView);
  useEffect(() => { panelOrdersRef.current = ordersView; });
  const cancelOrder = useCallback(async (orderId: string) => {
    if (isSimOrderId(orderId)) {
      if (!simOrdersRef.current.some(o => o.id === orderId)) return;
      setSimOrders(simOrdersRef.current.filter(o => o.id !== orderId));
      flash({ ok: true, text: 'SIM order cancelled' });
      return;
    }
    const row = panelOrdersRef.current.find(o => o.id === orderId);
    if (row && !row.own) { setCancelAsk(row); return; }
    await sendCancel(orderId);
  }, [sendCancel, setSimOrders, flash]);

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
    if (isMcx(underlying)) {
      const exp = feed.future?.expiry
        ? new Date(feed.future.expiry).toLocaleString('en-US', { month: 'short' }).toUpperCase()
        : 'DEC';
      return `${underlying} ${exp} FUT`;
    }
    return `${underlying} FUT`;
  }, [underlying, feed.future?.expiry]);

  const chartOpenOrders = useMemo(() => {
    // The exact root, then a space / dash / digit: CRUDEOIL and CRUDEOILM never draw each other's orders (a "contains
    // CRUDE" match put a CRUDEOIL future order on the CRUDEOILM chart), NIFTY never NIFTYNXT50's.
    const root = new RegExp(`^${underlying}(?=[\\s\\d-]|$)`);
    return ordersView.filter(o => o.bucket === 'open' && root.test(o.symbol.toUpperCase()));
  }, [ordersView, underlying]);

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
      // An option stop goes as a stop-LIMIT (brokers refuse SL-M on options: optionStopLimit); a future keeps SL-M.
      const optStop = isStop && c.type !== 'FUT' ? optionStopLimit(req.side, req.price, INSTRUMENTS[underlying].optTick) : null;
      const out = await placeContract({
        contract: c,
        side: req.side,
        orderType: optStop ? 'STOP_LOSS' : isStop ? 'STOP_LOSS_MARKET' : 'LIMIT',
        price: optStop ? optStop.price : isStop ? null : req.price,
        trigger: optStop ? optStop.trigger : isStop ? req.price : null,
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
  }, [ticketBusy, placeContract, flash, loadOrders, loadPositions, underlying]);

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

  // In SIM mode: fill paper working orders when their contract's live price reaches them (lib/indexScalperSimOrders.ts).
  // Same pause as every paper fill: stale prices or a closed market fill nothing. An order fills only while its
  // instrument is on screen (the feed streams that one); a day-old order expires.
  useEffect(() => {
    if (real || !simReady) return;
    const list = simOrdersRef.current;
    if (!list.length) return;
    const today = istDayKey();
    const priceOk = !feed.stale && feed.feedAgeSec !== null && feed.marketOpen;
    let changed = false;
    const keep: SimOrder[] = [];
    const fills: [SimOrder, number][] = [];
    for (const o of list) {
      if (o.day !== today) { changed = true; continue; }
      const live = priceOk && o.underlying === underlying ? feed.ltpById.get(o.securityId) : undefined;
      if (!live) { keep.push(o); continue; }
      const r = simOrderStep(o, live);
      if (r.fill !== null) { fills.push([o, r.fill]); changed = true; continue; }
      if (r.order !== o) changed = true;
      keep.push(r.order);
    }
    if (!changed) return;
    setSimOrders(keep);
    for (const [o, px] of fills) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- booking a fill the price update just caused
      simFill({ strike: o.strike, type: o.type, securityId: o.securityId, expiry: o.expiry, ltp: px }, o.side, o.units, px, o.symbol);
      const kind = o.orderType === 'LIMIT' ? 'Limit' : o.orderType === 'STOP_LOSS' ? 'Stop Limit' : 'Stop';
      flash({ ok: true, text: `SIM ${o.side} ${kind} filled: ${o.lots} lot${o.lots > 1 ? 's' : ''} ${o.type === 'FUT' ? 'FUT' : `${o.strike} ${o.type}`} @ ${px.toFixed(2)}` });
    }
  }, [real, simReady, feed.ltpById, feed.stale, feed.feedAgeSec, feed.marketOpen, underlying, simFill, setSimOrders, flash]);


  /** `quiet`: the caller shows one summary (the default target / stop) instead of a message per level. */
  const onSetBracket = useCallback(async (req: { leg: ScalperLeg; kind: 'TP' | 'SL'; price: number }, opts?: { quiet?: boolean }): Promise<Outcome> => {
    const say = (o: Outcome): Outcome => { if (!opts?.quiet) flash(o); return o; };
    if (!real || req.leg.sim) {
      setSimBrackets(prev => ({
        ...prev,
        [req.leg.id]: {
          ...prev[req.leg.id],
          [req.kind === 'TP' ? 'tp' : 'sl']: req.price,
        },
      }));
      return say({ ok: true, text: `SIM ${req.kind} set at ₹${req.price.toFixed(2)}` });
    }

    const isLong = req.leg.netQty > 0;
    const oppSide: 'BUY' | 'SELL' = isLong ? 'SELL' : 'BUY';
    // An option's stop is a stop-LIMIT a 5% cushion beyond the trigger: Kotak's RMS rejects SL-M on NSE options (2026-11-26:
    // accepted with an order number, then rejected, so the position had no stop). A future keeps SL-M.
    const optStop = req.kind === 'SL' && req.leg.type !== 'FUT' ? optionStopLimit(oppSide, req.price, INSTRUMENTS[underlying].optTick) : null;
    const targetType: TicketOrderType = req.kind === 'TP' ? 'LIMIT' : optStop ? 'STOP_LOSS' : 'STOP_LOSS_MARKET';

    // Replace this page's own bracket order of this kind on THIS contract (never another contract's). Another placer's
    // order of the same kind (a strategy's resting stop) is never cancelled from here: two would both close the leg.
    const sameKind = chartOpenOrders.filter(o => {
      if (o.side !== oppSide || !o.securityId || o.securityId !== req.leg.securityId) return false;
      const ot = (o.orderType || '').toUpperCase();
      const isLimit = ot.includes('LIMIT');
      const isStop = ot.includes('SL') || ot.includes('STOP');
      return req.kind === 'TP' ? isLimit : isStop;
    });
    const foreign = sameKind.find(o => !o.own);
    if (foreign) {
      return say({ ok: false, text: `A ${req.kind === 'TP' ? 'target' : 'stop'} placed elsewhere (order ${foreign.id}) already works on ${req.leg.type} ${req.leg.strike}: cancel it first (Orders), nothing sent` });
    }
    const existing = sameKind.find(o => o.own);
    if (existing) {
      await sendCancel(existing.id);
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
    const lots = qtyLots(underlying, req.leg.netQty, req.leg.mult ?? 1, lotOf(req.leg.securityId));
    if (lots === null) {
      return say({ ok: false, text: `Cannot size the ${req.kind}: ${Math.abs(req.leg.netQty)} is not a whole number of lots (or the lot size is unknown)` });
    }

    const out = await placeContract({
      contract: c,
      side: oppSide,
      orderType: targetType,
      price: req.kind === 'TP' ? req.price : optStop ? optStop.price : null,
      trigger: req.kind === 'SL' ? (optStop ? optStop.trigger : req.price) : null,
      product: (req.leg.product as 'INTRADAY' | 'MARGIN') || 'INTRADAY',
      lots,
      // A TP / SL closes this leg: it keeps the leg's product (an MIS crude leg is squared off as MIS).
      closesLeg: true,
    });
    void loadOrders();
    if (out.ok && out.orderId) watchPlaced(out.orderId, `${req.kind === 'TP' ? 'Target' : 'Stop loss'} on ${req.leg.type} ${req.leg.strike || ''}`.trim());
    return say(out);
  }, [real, chartOpenOrders, chartContract, sendCancel, feed.expiry, lotOf, underlying, placeContract, flash, loadOrders, watchPlaced]);

  // Default target / stop watcher: a queued default (queueDefaultBrackets) is placed once the book shows its leg on the
  // expected side and product, filled in full, with a live premium, through onSetBracket like a level typed on the chip.
  // It is taken off the queue BEFORE anything is sent, so the next pass (the order book still without the new orders)
  // never sends twice. REAL re-reads the broker first (an Exit / Reverse may have closed the leg since the poll); nothing
  // runs while an exit, a reverse or a ticket order is in progress. A default that cannot be placed says so, loudly.
  const defaultsBusyRef = useRef(false);
  useEffect(() => {
    const pend = pendingDefaultsRef.current;
    if (!pend.size) return;
    const again = () => { const t = setTimeout(() => setPendingSeq(n => n + 1), 1000); return () => clearTimeout(t); };
    if (defaultsBusyRef.current || exitingId !== null || ticketBusy || reverseBusyRef.current) return again();
    const warn = (text: string) => { flash({ ok: false, text }); if (soundOnRef.current) playWarnChime(); };
    const tick = INSTRUMENTS[underlying].optTick;
    const now = Date.now();
    for (const [key, { p, real: madeReal }] of [...pend]) {
      if (madeReal !== real) { pend.delete(key); continue; } // the mode changed since: that book is not on screen
      const leg = pendingLeg(p, legs.filter(l => l.type !== 'FUT'));
      const b = leg ? premiumBracketsFor(leg, chartOpenOrders, simBrackets[leg.id]) : null;
      const plan = defaultBracketPlan(p, leg, { tp: !!b?.tp, sl: !!b?.sl }, tick, now);
      if (plan.kind === 'wait') continue;
      pend.delete(key);
      const name = leg ? `${leg.type} ${leg.strike}` : key;
      if (plan.kind === 'drop') {
        if (plan.warn) warn(`No default target / stop on ${name}: ${plan.reason}. Set them on the position chip`);
        continue;
      }
      if (!leg) continue;
      defaultsBusyRef.current = true;
      void (async () => {
        try {
          let use: ScalperLeg = leg;
          if (madeReal) {
            // A fresh broker read, as an exit does: never size or send closing orders off the 3-5 s old poll.
            const st = await readExitState();
            if (typeof st === 'string') { warn(`No default target / stop on ${name}: ${st}`); return; }
            const fresh = pendingLeg(p, st.live.filter(l => l.type !== 'FUT'));
            if (!fresh) { flash({ ok: true, text: `${name} closed before its default target / stop: nothing sent` }); return; }
            if (Math.abs(fresh.netQty) < Math.abs(p.expectQty)) { pend.set(key, { p, real: madeReal }); return; } // fill still arriving
            use = { ...leg, netQty: fresh.netQty, product: fresh.product, mult: fresh.mult };
          }
          const outs: string[] = [];
          let ok = plan.skipped.length === 0;
          if (plan.tp !== null) {
            const o = await onSetBracket({ leg: use, kind: 'TP', price: plan.tp }, { quiet: true });
            outs.push(o.ok ? `TP ${plan.tp.toFixed(2)}` : `TP not set (${o.text})`); ok &&= o.ok;
          }
          if (plan.sl !== null) {
            const o = await onSetBracket({ leg: use, kind: 'SL', price: plan.sl }, { quiet: true });
            outs.push(o.ok ? `SL ${plan.sl.toFixed(2)}` : `SL not set (${o.text})`); ok &&= o.ok;
          }
          const text = `Default ${outs.join(' / ') || 'target / stop'} on ${name}${plan.skipped.length ? `: skipped ${plan.skipped.join('; ')}` : ''}`;
          if (ok) flash({ ok: true, text }); else warn(text);
        } finally {
          defaultsBusyRef.current = false;
          setPendingSeq(n => n + 1);
        }
      })();
      break; // one leg at a time: the next pass (after this one's sends) takes the next
    }
    // Waiting ones are looked at again each second (a leg's live premium may move without the legs list changing).
    if (!pend.size) return;
    return again();
  }, [pendingSeq, legs, chartOpenOrders, simBrackets, real, underlying, onSetBracket, readExitState, flash, exitingId, ticketBusy]);

  /** Edit one of this page's working orders: move it to `level` (its line was dragged; a Limit moves its price, an SL-M
   *  its trigger, an SL-limit both by the same amount) and / or change its `lots`. Checked against the live price like a
   *  new order (lib/indexScalperOrderEdit), sent as a modify (PATCH /api/scalper/orders, `source: 'isx'`: the server
   *  re-checks the lot cap). REAL only: in SIM the page sends nothing to the broker. */
  const modifyBusyRef = useRef(false);
  const onModifyOrder = useCallback(async (req: { orderId: string; level?: number; lots?: number }): Promise<boolean> => {
    const row = panelOrdersRef.current.find(o => o.id === req.orderId);
    if (!row) { flash({ ok: false, text: `Order ${req.orderId} is no longer in the order book` }); return false; }
    if (!isEditable(row)) { flash({ ok: false, text: `Order ${req.orderId} cannot be edited here (only this page's working Limit / SL / SL-M orders)` }); return false; }
    if (isSimOrderId(row.id)) {
      // A paper working order: moved / resized in place, checked like a broker modify against the live price.
      const o = simOrdersRef.current.find(x => x.id === row.id);
      if (!o) return false;
      const f = feedRef.current;
      const tick = row.isOption ? INSTRUMENTS[underlying].optTick : INSTRUMENTS[underlying].futTick;
      const live = f.ltpById.get(o.securityId) ?? null;
      const levels = req.level !== undefined ? movedLevels(row, req.level, tick) : { price: row.price ?? 0, trigger: row.trigger ?? 0 };
      const levelErr = orderEditError(row.rawType, o.side, levels.price, levels.trigger, live, tick);
      if (levelErr) { flash({ ok: false, text: `SIM order: ${levelErr}` }); return false; }
      let units = o.units, lots = o.lots;
      if (req.lots !== undefined) {
        const lotsErr = editLotsError(req.lots, 0, INSTRUMENTS[underlying].maxLots);
        if (lotsErr) { flash({ ok: false, text: `SIM order: ${lotsErr}` }); return false; }
        units = (o.units / o.lots) * req.lots; lots = req.lots;
      }
      const isLimit = row.rawType === 'LIMIT';
      setSimOrders(simOrdersRef.current.map(x => (x.id === o.id ? {
        ...x, units, lots,
        price: isLimit || x.orderType === 'STOP_LOSS' ? levels.price : x.price,
        trigger: isLimit ? x.trigger : levels.trigger,
      } : x)));
      flash({ ok: true, text: `SIM order moved${req.lots !== undefined ? `: ${lots} lot${lots === 1 ? '' : 's'}` : ''}` });
      return true;
    }
    if (!real) { flash({ ok: false, text: 'Arm REAL to edit a broker order' }); return false; }
    if (modifyBusyRef.current) return false;
    const f = feedRef.current;
    const kotak = brokerRef.current === 'kotak';
    const tick = row.isOption ? INSTRUMENTS[underlying].optTick : INSTRUMENTS[underlying].futTick;
    // The contract's live price: an option from the chain, the future from the feed; Kotak rows by their trading symbol.
    let ltp: number | null = null;
    if (kotak) {
      const info = kotakSymbolsRef.current?.[row.securityId];
      ltp = info ? kotakPriceRef.current(info) : null;
    } else if (f.future && f.future.dhanId === row.securityId) ltp = f.future.ltp ?? null;
    else ltp = f.ltpById.get(row.securityId) ?? null;
    const side = row.side as 'BUY' | 'SELL';
    const levels = req.level !== undefined ? movedLevels(row, req.level, tick) : { price: row.price ?? 0, trigger: row.trigger ?? 0 };
    const levelErr = orderEditError(row.rawType, side, levels.price, levels.trigger, ltp, tick);
    if (levelErr) { flash({ ok: false, text: `Order ${row.id}: ${levelErr}` }); return false; }
    // Quantity in the broker's own unit: the current one, or the new lots converted like a new order.
    // The ORDER's own contract lot (a Dec order shown under a Jan screen keeps 20), never the screen's.
    const unitsPerLot = lotUnits(underlying, lotOf(row.securityId));
    let quantity = row.qty ?? 0;
    if (req.lots !== undefined) {
      const lotsErr = editLotsError(req.lots, row.tradedQty, INSTRUMENTS[underlying].maxLots);
      if (lotsErr) { flash({ ok: false, text: `Order ${row.id}: ${lotsErr}` }); return false; }
      if (unitsPerLot === null) { flash({ ok: false, text: 'Lot size unknown: nothing sent' }); return false; }
      quantity = kotak ? kotakOrderQty(underlying, req.lots, unitsPerLot) : dhanOrderQty(underlying, req.lots, unitsPerLot);
    }
    if (!(quantity > 0)) { flash({ ok: false, text: `Order ${row.id}: unknown quantity, nothing sent` }); return false; }
    modifyBusyRef.current = true;
    try {
      const r = await fetch('/api/scalper/orders', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: row.id, broker: kotak ? 'kotak' : 'dhan', orderType: row.rawType, quantity,
          price: levels.price, triggerPrice: levels.trigger, validity: 'DAY',
          // The cap tag only when this page changes the size of its own order: a price-only move (another placer's
          // 10-lot stop on CRUDEOIL, a bracket) must never be refused by the 5-lot cap.
          ...(req.lots !== undefined && row.own ? { source: INSTRUMENTS[underlying].orderSource } : {}),
          exchangeSegment: row.segment || INSTRUMENTS[underlying].dhanSegment, tradingSymbol: row.securityId, underlying,
        }),
      });
      const j = await r.json() as { success: boolean; error?: string };
      const what = [req.level !== undefined ? (row.rawType === 'LIMIT' ? `price ${levels.price.toFixed(2)}` : `trigger ${levels.trigger.toFixed(2)}${row.rawType === 'STOP_LOSS' ? ` (limit ${levels.price.toFixed(2)})` : ''}`) : '', req.lots !== undefined ? `${req.lots} lot${req.lots === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
      flash({ ok: j.success, text: j.success ? `Order ${row.id} modified: ${what}` : `Modify refused: ${j.error ?? 'unknown error'}` });
      return j.success;
    } catch (e) {
      flash({ ok: false, text: `Modify: no reply (${String((e as Error).message ?? e)}). Check Orders before retrying` });
      return false;
    } finally {
      modifyBusyRef.current = false;
      void loadOrders();
    }
  }, [real, underlying, flash, loadOrders, setSimOrders, lotOf]);

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

  // ── reverse ────────────────────────────────────────────────────────
  // Close the position in full, then open the same lots on the other side of THE SAME contract. REAL asks first, re-reads
  // the broker (never the 3 s-old chip), cancels this page's working orders on the closing side of that contract (after
  // the flip they would add to the new position), refuses while another placer's order works there, and opens only once
  // the close was placed. Rules in lib/indexScalperReverse.ts.
  const [reverseAsk, setReverseAsk] = useState<ScalperLeg | null>(null);
  const legName = (l: ScalperLeg) => `${l.type}${l.type === 'FUT' ? '' : ` ${l.strike}`}`;
  const ownContract = (l: ScalperLeg): PickedContract => ({
    strike: l.strike, type: l.type, expiry: feedRef.current.expiry ?? '', securityId: l.securityId, tradingSymbol: l.symbol, ltp: l.ltp ?? l.avg,
  });

  const reverseSimBusyRef = useRef(false);
  const reverseSim = useCallback(async (leg: ScalperLeg) => {
    if (reverseSimBusyRef.current) return;
    reverseSimBusyRef.current = true;
    try { await reverseSimOnce(leg); } finally { reverseSimBusyRef.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, exitSimLeg, placeContract, dropTrail, flash]);
  const reverseSimOnce = async (leg: ScalperLeg) => {
    const lots = qtyLots(underlying, leg.netQty, leg.mult ?? 1, lotOf(leg.securityId));
    const lotsErr = reverseLotsError(lots, INSTRUMENTS[underlying].maxLots);
    if (lotsErr) { flash({ ok: false, text: `Cannot reverse ${legName(leg)}: ${lotsErr}` }); return; }
    const revSide: 'BUY' | 'SELL' = leg.netQty > 0 ? 'SELL' : 'BUY';
    setSimBrackets(prev => { if (!prev[leg.id]) return prev; const next = { ...prev }; delete next[leg.id]; return next; });
    dropTrail(leg.id);
    // Paper limits / stops on the closing side would add to the reversed position: cancelled first, as in REAL.
    const paperBlk = reverseBlockers(simOrdersRef.current.map(simOrderRow), leg.securityId, leg.netQty > 0);
    if (paperBlk.own.length) setSimOrders(simOrdersRef.current.filter(o => !paperBlk.own.includes(o.id)));
    // Only open the other side once the close went through: otherwise "reverse" would double the position.
    const closed = exitSimLeg(leg);
    if (!closed.ok) { flash({ ok: false, text: `Reverse ${legName(leg)}: not closed: ${closed.text}` }); return; }
    const out = await placeContract({ contract: ownContract(leg), side: revSide, orderType: 'MARKET', price: null, trigger: null, product: 'INTRADAY', lots: lots!, exactContract: true });
    flash(out.ok
      ? { ok: true, text: `SIM reversed ${legName(leg)}: ${revSide} ${lots} lot${lots === 1 ? '' : 's'}` }
      : { ok: false, text: `SIM ${legName(leg)} closed, but the other side was not opened: ${out.text}` });
  };

  /** A cancel whose outcome the caller needs (Reverse); sendCancel is the panel's, with its own toast. */

  /** This broker's order book read now, in panel rows (own / cancellable / raw type). Kotak needs the page's order
   *  records to tell its own orders; pass them when already read (readExitState), else they are read here. */
  const freshOrderRows = useCallback(async (kotakRecords?: KotakRecord[]): Promise<OrderRowView[] | null> => {
    try {
      if (brokerRef.current === 'kotak') {
        const records = kotakRecords ?? await loadKotakRecords();
        const r = await fetch(scalperRoute('kotak', 'orders'));
        const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (!records || !j.success || !Array.isArray(j.data)) return null;
        return orderRows(kotakOrdersAsDhan(j.data, kotakSymbolsRef.current ?? {}, recordedIds(withResolvedUnknowns(records, j.data))));
      }
      const r = await fetch(scalperRoute('dhan', 'orders'));
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
      return j.success && Array.isArray(j.data) ? orderRows(j.data) : null;
    } catch { return null; }
  }, [loadKotakRecords]);

  // reverseBusyRef (declared with the page state above): while a REAL reverse runs, the flat moment between its close
  // and its open is not a "position closed" event.
  const reverseReal = useCallback(async (leg: ScalperLeg) => {
    const f = feedRef.current;
    const kotak = brokerRef.current === 'kotak';
    const name = legName(leg);
    const st = await readExitState();
    if (typeof st === 'string') return { ok: false, text: `Reverse ${name}: ${st}` };
    const row = st.live.find(l => l.id === leg.id);
    if (!row) return { ok: false, text: `Reverse ${name}: the position is no longer at the broker` };
    // MCX crude opens NRML only: an MIS crude leg cannot reopen as MIS (refused at the broker), nor flip into NRML here.
    if (nrmlOnly(underlying) && row.product !== 'MARGIN') return { ok: false, text: `${underlying} is NRML-only: Exit this ${row.product || 'intraday'} position, then open the other side (it goes as NRML)` };
    const lots = qtyLots(underlying, row.netQty, row.mult ?? 1, lotOf(row.securityId));
    const lotsErr = reverseLotsError(lots, INSTRUMENTS[underlying].maxLots);
    if (lotsErr) return { ok: false, text: `Cannot reverse ${name}: ${lotsErr}` };
    // A fresh order book: another placer's order on the closing side refuses (nothing sent); this page's own are
    // cancelled AFTER the close is placed, so a rejected close never leaves the position without its stop.
    const rows = await freshOrderRows(st.records);
    if (!rows) return { ok: false, text: `Reverse ${name}: could not read the order book: nothing was sent` };
    const isLong = row.netQty > 0;
    const blk = reverseBlockers(rows, row.securityId, isLong);
    if (blk.foreign.length) return { ok: false, text: `Reverse ${name}: order ${blk.foreign.join(', ')} placed elsewhere works on the closing side of this contract (after the flip it would add to the new position). Cancel it first (Orders): nothing was sent` };
    dropTrail(leg.id);
    // 1. Close in full: the exit path (uncapped isxx, Kotak freeze slices, unknown-outcome hold).
    const closed = await exitRealRow(row, st.records, st.book);
    if (!closed.ok) {
      loadPositions(); void loadOrders();
      return { ok: false, text: `Reverse ${name}: ${closed.unknown ? 'the close has an unknown outcome, so the other side was NOT opened' : 'not closed (its target / stop orders are untouched)'}: ${closed.text}` };
    }
    // 2. Cancel this page's target / stop on the old closing side: after the flip they would add to the new position.
    for (const id of blk.own) {
      const err = await cancelQuiet(id);
      if (err) { loadPositions(); void loadOrders(); return { ok: false, text: `Reverse ${name}: closed, but this page's order ${id} could not be cancelled (${err}), so the other side was NOT opened. Cancel it in Orders` }; }
    }
    // 3. The position must not have flipped meanwhile (a stop that fired between the close and its cancel): opening
    //    then would double the new side. Still open the old way (close not filled yet) or flat is fine.
    const after = await loadPositions(true);
    if (!after) return { ok: false, text: `Reverse ${name}: closed, but positions could not be re-read, so the other side was NOT opened` };
    const afterLegs = kotak ? legsFromKotakPositions(after, kotakSymbolsRef.current ?? {}, () => null, underlying) : legsFromDhanPositions(after, f.ltpById, underlying);
    const nowQty = netBySecurity(afterLegs).get(row.securityId) ?? 0;
    if (nowQty !== 0 && Math.sign(nowQty) !== Math.sign(row.netQty)) {
      return { ok: false, text: `Reverse ${name}: the position already shows the other side (${nowQty}), so nothing more was opened. Check Positions / Orders` };
    }
    // 2. Open the same lots on the other side of the same contract, in the row's own product.
    const opened = await placeContract({
      contract: { ...ownContract(row), expiry: f.expiry ?? '' }, side: isLong ? 'SELL' : 'BUY', orderType: 'MARKET', price: null, trigger: null,
      product: (row.product as 'INTRADAY' | 'MARGIN') || 'INTRADAY', lots: lots!, exactContract: true,
    });
    const cancelled = blk.own.length ? ` (cancelled this page's order${blk.own.length === 1 ? '' : 's'} ${blk.own.join(', ')})` : '';
    return opened.ok
      ? { ok: true, text: `Reversed ${name}: closed, then ${isLong ? 'SELL' : 'BUY'} ${lots} lot${lots === 1 ? '' : 's'}${cancelled}: ${opened.text}` }
      : { ok: false, text: `${name} closed${cancelled}, but the other side was not opened: ${opened.text}` };
  }, [underlying, readExitState, freshOrderRows, exitRealRow, placeContract, cancelQuiet, dropTrail, loadPositions, loadOrders, lotOf]);

  const onReversePosition = useCallback(async (leg: ScalperLeg, confirmed = false) => {
    if (ticketBusy || exitingId) return;
    if (!real || leg.sim) { await reverseSim(leg); return; }
    if (!confirmed) { setReverseAsk(leg); return; }
    setReverseAsk(null);
    setTicketBusy(true);
    setExitingId(leg.id);
    reverseBusyRef.current = true;
    try {
      flash(await reverseReal(leg));
    } finally {
      reverseBusyRef.current = false;
      setExitingId(null);
      setTicketBusy(false);
      refreshAfterOrder();
      void loadOrders();
    }
  }, [ticketBusy, exitingId, real, reverseSim, reverseReal, flash, refreshAfterOrder, loadOrders]);
  // What the REAL reverse confirmation shows (from the polled book; the reverse itself re-reads both books).
  const reverseView = useMemo(() => {
    if (!reverseAsk) return null;
    const l = reverseAsk;
    const isLong = l.netQty > 0;
    return {
      leg: l, isLong,
      lots: qtyLots(underlying, l.netQty, l.mult ?? 1, contractLot(underlying, l.securityId, lotMap)),
      blk: reverseBlockers(panelOrders, l.securityId, isLong),
    };
  }, [reverseAsk, underlying, broker, lotMap, panelOrders]);

  // ── one-cancels-other for REAL targets / stops (lib/indexScalperOco.ts) ─────────────────────────────────────────────
  // Watches the REAL book: a contract that went flat gets this page's leftover target / stop cancelled (a stop left on
  // a flat position would open a new one); one that was reduced gets this page's bigger untouched target / stop cut to
  // what is left. A flat is confirmed with a fresh positions read first (one empty reply must never cancel stops), and
  // the order book is re-read. Runs in the browser, REAL only, so the page must be open and armed; a Web Lock makes a
  // second open tab do it after the first, against the book the first left.
  const ocoPrevRef = useRef<{ key: string; book: Map<string, number>; mult: Map<string, number> } | null>(null);
  const ocoQueueRef = useRef<OcoEvent[]>([]);
  const ocoBusyRef = useRef(false);
  const drainOco = useCallback(async () => {
    if (ocoBusyRef.current) return;
    ocoBusyRef.current = true;
    const run = async () => {
      while (ocoQueueRef.current.length) {
        const events = ocoQueueRef.current.splice(0);
        let confirmed = events;
        if (events.some(e => e.kind === 'flat' || e.kind === 'increased')) {
          const fresh = await loadPositions(true);
          if (!fresh) continue; // cannot confirm: never cancel a stop on an unconfirmed flat, nor grow one on an unconfirmed add
          const f = feedRef.current;
          const kotak = brokerRef.current === 'kotak';
          const now = netBySecurity(kotak ? legsFromKotakPositions(fresh, kotakSymbolsRef.current ?? {}, () => null, underlying) : legsFromDhanPositions(fresh, f.ltpById, underlying));
          // An add is grown only to what the FRESH read shows on the same side (a later add makes its own event).
          confirmed = events.filter(e => e.kind === 'flat' ? !now.has(e.securityId)
            : e.kind === 'increased' ? Math.abs(now.get(e.securityId) ?? 0) === e.left && Math.sign(now.get(e.securityId) ?? 0) === (e.closeSide === 'SELL' ? 1 : -1)
            : true);
        }
        if (!confirmed.length) continue;
        const rows = await freshOrderRows();
        if (!rows) { flash({ ok: false, text: 'A position closed, but the order book could not be read to cancel its target / stop: check Orders' }); continue; }
        const acts = ocoActions(confirmed, rows);
        const done: string[] = [];
        const failed: string[] = [];
        for (const o of acts.cancel) {
          const err = await cancelQuiet(o.id);
          if (err) failed.push(`${o.id} (${err})`); else done.push(o.id);
        }
        const grown: string[] = [];
        for (const { order, qty } of acts.resize) {
          const mult = ocoPrevRef.current?.mult.get(order.securityId) ?? 1;
          const f = feedRef.current;
          const lots = qtyLots(underlying, qty, mult, lotOf(order.securityId));
          const grow = order.qty !== null && qty > order.qty;
          if (lots === null || !(await onModifyOrder({ orderId: order.id, lots }))) failed.push(`${order.id} (could not ${grow ? 'grow' : 'cut'} it to ${qty})`);
          else if (grow) grown.push(`${order.rawType === 'LIMIT' ? 'target' : 'stop'} ${order.id} -> ${lots} lot${lots === 1 ? '' : 's'}`);
        }
        if (done.length) flash({ ok: true, text: `Position closed: cancelled its other target / stop order${done.length === 1 ? '' : 's'} ${done.join(', ')}` });
        if (grown.length && !failed.length) flash({ ok: true, text: `Lots added: ${grown.join(', ')} so the whole position is covered` });
        if (acts.ambiguous.length) {
          flash({ ok: false, text: `Lots added, but ${acts.ambiguous.map(o => o.id).join(', ')} are two orders of one kind: not resized (the added lots may have no target / stop). Check Orders` });
          if (soundOnRef.current) playWarnChime();
        }
        if (failed.length) { flash({ ok: false, text: `Target / stop clean-up failed: ${failed.join(' · ')}. Check Orders` }); if (soundOnRef.current) playWarnChime(); }
        void loadOrders();
      }
    };
    try {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      if (locks?.request) await locks.request('index-scalper-oco', run); else await run();
    } finally { ocoBusyRef.current = false; }
  }, [underlying, loadPositions, freshOrderRows, cancelQuiet, onModifyOrder, flash, loadOrders, lotOf]);
  useEffect(() => {
    if (!real || !bookReady) { ocoPrevRef.current = null; return; }
    const key = `${broker}|${underlying}`;
    const book = netBySecurity(legs);
    const mult = new Map(legs.map(l => [l.securityId, l.mult ?? 1]));
    const prev = ocoPrevRef.current;
    // Keep the multipliers of contracts that just went flat (a resize needs them; a flat needs none).
    ocoPrevRef.current = { key, book, mult: new Map([...(prev?.mult ?? []), ...mult]) };
    if (!prev || prev.key !== key || reverseBusyRef.current) return;
    const events = ocoEvents(prev.book, book);
    if (!events.length) return;
    ocoQueueRef.current.push(...events);
    void drainOco();
  }, [legs, real, broker, underlying, bookReady, drainOco]);

  // SIM one-cancels-other on the paper book, by the same rules as REAL (lib/indexScalperOco.ts): when a paper position goes
  // flat, the paper limit / stop orders left on its old closing side are cancelled; when it is reduced, bigger ones are cut.
  const simOcoPrevRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    if (real || !simReady) { simOcoPrevRef.current = null; return; }
    const book = netBySecurity(legs);
    const prev = simOcoPrevRef.current;
    simOcoPrevRef.current = book;
    if (!prev) return;
    const events = ocoEvents(prev, book);
    if (!events.length) return;
    const rows = simOrdersRef.current.map(simOrderRow);
    const acts = ocoActions(events, rows);
    if (!acts.cancel.length && !acts.resize.length) return;
    const drop = new Set(acts.cancel.map(o => o.id));
    const cut = new Map(acts.resize.map(r => [r.order.id, r.qty]));
    setSimOrders(simOrdersRef.current.filter(o => !drop.has(o.id)).map(o => {
      const q = cut.get(o.id);
      return q === undefined ? o : { ...o, units: q, lots: Math.max(1, Math.round((q / o.units) * o.lots)) };
    }));
    if (drop.size) flash({ ok: true, text: `SIM position closed: cancelled its other paper order${drop.size === 1 ? '' : 's'}` });
  }, [legs, real, simReady, setSimOrders, flash]);

  // SIM: a paper target / stop belongs to the open leg only. Exit, a trailing-stop hit or a reverse leaves the leg flat;
  // its old levels must not come back on the next position on that contract.
  useEffect(() => {
    if (real || !simReady) return;
    const open = new Set(legs.map(l => l.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSimBrackets(prev => {
      const stale = Object.keys(prev).filter(id => !open.has(id));
      if (!stale.length) return prev;
      const next = { ...prev };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [legs, real, simReady]);

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
    // The leg's OWN contract lot (a held Dec SENSEX leg under a Jan screen keeps 20): "+ 4" opened 5 Dec lots before.
    const contractUnits = lotUnits(underlying, lotOf(leg.securityId));
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
    const oneLeft = 'One lot left: use Exit (x) to close the leg';
    if (lotsToRemove(step, Math.abs(leg.netQty) / brokerUnitsPerLot) === 0) { flash({ ok: false, text: oneLeft }); return; }
    setExitingId(leg.id);
    try {
      let out: Outcome;
      let n = 0;
      if (!real || leg.sim) {
        n = lotsToRemove(step, Math.abs(leg.netQty) / brokerUnitsPerLot);
        out = await placeContract({ contract: c, side: isLong ? 'SELL' : 'BUY', orderType: 'MARKET', price: null, trigger: null, product, lots: n, closesLeg: true });
      } else {
        // Sized off the FRESH broker row, not the chip: if the mobile app / a strategy reduced the position since, the
        // step is re-cut so one lot still stays (sizing off the chip could close the whole leg).
        const st = await readExitState();
        const row = typeof st === 'string' ? undefined : st.live.find(l => l.id === leg.id);
        n = row ? lotsToRemove(step, Math.abs(row.netQty) / brokerUnitsPerLot) : 0;
        if (typeof st === 'string') out = { ok: false, text: st };
        else if (!row) out = { ok: false, text: 'Position not found at the broker' };
        else if (n === 0) out = { ok: false, text: oneLeft };
        else out = await exitRealRow(row, st.records, st.book, n * brokerUnitsPerLot);
        refreshAfterOrder();
      }
      flash({ ok: out.ok, text: out.ok ? `${leg.type} ${leg.strike}: ${n} lot${n === 1 ? '' : 's'} taken off` : out.text });
    } finally { setExitingId(null); }
  }, [exitingId, ticketBusy, real, underlying, placeContract, onTradeContract, readExitState, exitRealRow, refreshAfterOrder, flash]);


  // ── REAL arming ────────────────────────────────────────────────────
  const goSim = () => { setReal(false); };

  // ── indicators ─────────────────────────────────────────────────────
  // Volume is one per chart: picking it again just shows the one there is.
  const addIndicator = (k: IndicatorKind) => {
    setIndicators(p => (k === 'volume' && p.some(i => i.kind === 'volume') ? p.map(i => (i.kind === 'volume' ? { ...i, visible: true } : i)) : [...p, newIndicator(k, nextId())]));
    setPickerOpen(false);
  };
  // Volume bars show while the Volume indicator is visible.
  const volumeInd = indicators.find(i => i.kind === 'volume' && i.visible);
  const showVolume = !!volumeInd;
  const volumeMaLen = volumeInd ? (volumeInd.params.ma ?? 20) : 20;
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

  const btn = 'h-7 px-1.5 whitespace-nowrap rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 transition-colors';
  const sep = <span className="w-px h-5 bg-zinc-800 shrink-0" />;
  const scaleBtn = 'h-6 px-1.5 rounded hover:text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 transition-colors';

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
  // The pane opens the Price Alerts dialog itself (ChartPane addAlert); this only runs when it cannot name the instrument yet.
  const onChartAlert = useCallback((sym: string) => { flash({ ok: false, text: `${sym}: the contract is still loading — try the alert again in a moment` }); }, [flash]);

  return (
    <div ref={rootRef} data-testid="index-scalper" className={cn('flex flex-col h-screen overflow-hidden bg-zinc-950 text-white', real && 'ring-2 ring-inset ring-rose-600/70')}>
      {/* header toolbar */}
      {/* One row where it fits. The left group is display:contents so every cluster is a direct item of this row: on a narrow window it
          wraps between clusters (never clips a control; overlapping groups once hid REAL / SIM and Exit All). */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 py-1.5 min-h-11 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <div className="contents whitespace-nowrap [&>*]:shrink-0">
          <div className="flex items-center gap-1">
          <div role="group" aria-label="Underlying" className="flex rounded border border-zinc-700 overflow-hidden" title={real ? 'Switch to SIM to change underlying: a REAL session trades one account' : undefined}>
            {(['NIFTY', 'SENSEX'] as const).map(u => (
              <button
                key={u}
                type="button"
                aria-pressed={underlying === u}
                disabled={real}
                title={u === 'SENSEX' ? 'BSE SENSEX: index, future (chart) and options; lot size per expiry' : 'NIFTY 50: index, future (chart) and options'}
                onClick={() => selectUnderlying(u)}
                className={cn('h-7 px-1.5 text-xs font-bold transition-colors disabled:opacity-50', underlying === u ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}
              >
                {u}
              </button>
            ))}
            {(['CRUDEOILM', 'CRUDEOIL'] as const).map(u => (
              <button
                key={u}
                type="button"
                aria-pressed={underlying === u}
                disabled={real}
                title={u === 'CRUDEOIL' ? 'Full-size crude: 100 barrels a lot, max 5 lots per order' : 'Mini crude: 10 barrels a lot'}
                onClick={() => selectUnderlying(u)}
                className={cn('h-7 px-1.5 text-xs font-bold transition-colors disabled:opacity-50', underlying === u ? 'bg-amber-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}
              >
                {u}
              </button>
            ))}
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
            <span className="hidden min-[2200px]:inline">OI</span>
            <Switch size="sm" checked={showOi} onCheckedChange={setOi} aria-label="OI profile" />
            <span className={cn('w-6 text-[10px] font-bold hidden min-[2200px]:inline', showOi ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden>{showOi ? 'ON' : 'OFF'}</span>
          </label>
          <div className="relative flex items-center">
            <label className="flex items-center gap-1.5 h-7 px-1.5 rounded text-xs font-semibold text-zinc-300 cursor-pointer select-none hover:bg-zinc-800"
              title="Trend strip: VWAP / EMA 9-20 / Supertrend / ADX and the bias on 3m, 5m, 15m and 1h, above the charts">
              <Compass className="w-4 h-4" aria-hidden />
              <span className="hidden min-[2200px]:inline">Trend</span>
              <Switch size="sm" checked={showTrend} onCheckedChange={setTrend} aria-label="Trend strip" />
            </label>
            <button type="button" aria-label="Trend strip settings" aria-expanded={trendMenu} disabled={!showTrend}
              title={showTrend ? 'Trend strip settings: futures OI buildup, market structure' : 'Turn the trend strip on first'}
              onClick={() => setTrendMenu(v => !v)} className={cn(btn, 'px-1.5 disabled:opacity-40', trendMenu && 'bg-zinc-800 text-white')}>
              <Settings2 className="w-4 h-4" />
            </button>
            {trendMenu && showTrend && (
              <TrendSettingsMenu settings={trendSettings} onPatch={patchTrendSettings} onClose={() => setTrendMenu(false)} />
            )}
          </div>
          {sep}
          <div className="relative flex items-center">
            <label className="flex items-center gap-1.5 h-7 px-1.5 rounded text-xs font-semibold text-zinc-300 cursor-pointer select-none hover:bg-zinc-800"
              title="Quick Trade: every strike on the chart shows its live Call / Put price; click one to Buy or Sell your preset lots at market">
              <Crosshair className="w-4 h-4" aria-hidden />
              <span className="hidden min-[2200px]:inline">Quick</span>
              <Switch size="sm" checked={quickOn} onCheckedChange={setQuickOn} aria-label="Quick Trade" />
            </label>
            <button type="button" aria-label="Quick Trade settings" aria-expanded={quickMenu} disabled={!quickOn}
              title={quickOn ? 'Quick Trade settings: lots per click, product' : 'Turn Quick Trade on first'}
              onClick={() => setQuickMenu(v => !v)} className={cn(btn, 'px-1.5 disabled:opacity-40', quickMenu && 'bg-zinc-800 text-white')}>
              <Settings2 className="w-4 h-4" />
            </button>
            {quickMenu && quickOn && (
              <QuickSettingsMenu settings={quickEff} onPatch={patchQuick} nrmlLocked={nrmlOnly(underlying)}
                maxLots={INSTRUMENTS[underlying].maxLots} onClose={() => setQuickMenu(false)} />
            )}
          </div>
          {sep}
          <div className="relative flex items-center">
            <button type="button" aria-label="Default target and stop settings" aria-expanded={defMenu}
              title={defBrackets.on
                ? `Every new option position opened here at market gets a target ${bracketLabel(defBrackets, 'TP')} and a stop ${bracketLabel(defBrackets, 'SL')} from its entry premium`
                : 'Default target / stop is off: new positions get no automatic levels'}
              onClick={() => setDefMenu(v => !v)}
              className={cn(btn, 'flex items-center px-1.5 gap-1 text-xs font-semibold', defMenu && 'bg-zinc-800 text-white')}>
              <Target className={cn('w-4 h-4', defBrackets.on ? 'text-emerald-400' : 'text-zinc-500')} aria-hidden />
              <span data-testid="default-brackets-chip" className={defBrackets.on ? 'text-zinc-200' : 'text-zinc-500'}>
                {defBrackets.on ? `TP ${bracketLabel(defBrackets, 'TP')} · SL ${bracketLabel(defBrackets, 'SL')}` : 'TP/SL off'}
              </span>
            </button>
            {defMenu && <DefaultBracketsMenu settings={defBrackets} onPatch={patchDefBrackets} onClose={() => setDefMenu(false)} />}
          </div>
          {sep}
          <div role="group" aria-label="OI shows" className={cn('flex rounded border border-zinc-700 overflow-hidden', !showOi && 'opacity-50')}
            title={showOi ? 'Total OI; Chg = today\'s change (added filled, shed outlined); OI + Δ = total with today\'s change inside it (held dim, added bright, cut a dashed tail); Δ OI = Call − Put OI (red = calls heavier, green = puts heavier)' : 'Turn the OI profile on first'}>
            {([['total', 'Total', 'Total OI'], ['change', 'Chg', 'Change in OI'], ['both', 'OI+Δ', 'OI plus change'], ['delta', 'ΔOI', 'Call minus Put OI']] as const).map(([m, label, name]) => (
              <button key={m} type="button" aria-pressed={oiMode === m} disabled={!showOi} onClick={() => setOiMode(m)}
                aria-label={name}
                className={cn('h-6 px-1.5 text-[11px] font-bold transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  oiMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>{label}</button>
            ))}
          </div>
          {sep}
          <button type="button" aria-label={`Indicators${indicators.length > 0 ? ` ${indicators.length}` : ''}`} title="Indicators" onClick={() => { setEditId(null); setPickerOpen(true); }} className={cn(btn, 'flex items-center gap-1')}>
            <BarChart3 className="w-4 h-4" /><span className="hidden min-[2200px]:inline">Indicators</span>{indicators.length > 0 && <span className="text-sky-400">{indicators.length}</span>}
          </button>
          </div>
          <div className="flex items-center gap-1">
          <button type="button" aria-pressed={scalperOn} aria-label="Scalper" onClick={() => setScalperOn(v => !v)}
            title="Scalper: opens the instant-order window and arms one-click (Buy CE / Buy PE and the chain's B / S trade at once). Close it to disarm."
            className={cn('h-7 px-2 rounded border text-xs font-bold flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
              scalperOn ? 'border-amber-400 text-amber-300 bg-amber-500/10' : 'border-sky-500/60 text-sky-300 hover:bg-sky-500/10')}>
            <Zap className="w-3.5 h-3.5" /><span className="hidden min-[2200px]:inline">Scalper</span>
          </button>
          </div>
          <div className="flex items-center gap-1">
          <button type="button" aria-pressed={!soundOn} aria-label={soundOn ? 'Mute trade chimes' : 'Unmute trade chimes'}
            title={soundOn ? 'Trade chimes on: entry, exit and order problems (sounds start after your first click on the page). Click to mute.' : 'Trade chimes muted. Click to turn them on.'}
            onClick={() => setSoundOn(!soundOn)} className={cn(btn, !soundOn && 'text-zinc-500')}>
            {soundOn ? <Volume2 className="w-4 h-4" aria-hidden /> : <VolumeX className="w-4 h-4" aria-hidden />}
          </button>
          <button type="button" aria-pressed={watchIdx} aria-label="Top indices" title="Top indices: live Nifty, Bank Nifty, sectors and India VIX (watch only)"
            onClick={() => setWatchIdx(v => !v)} className={cn(btn, 'flex items-center gap-1', watchIdx && 'bg-zinc-800 text-white')}>
            <Gauge className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">Indices</span>
          </button>
          <button type="button" aria-pressed={watchStk} aria-label="Top 10 stocks" title="Top 10 stocks: the heaviest Nifty 50 weights, live (watch only)"
            onClick={() => setWatchStk(v => !v)} className={cn(btn, 'flex items-center gap-1', watchStk && 'bg-zinc-800 text-white')}>
            <Building2 className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">Top 10</span>
          </button>
          <button type="button" aria-pressed={watchAd} aria-label="Nifty advance decline" title="Advance / Decline: how many Nifty 50 stocks are up vs down, live, with today's A/D line (watch only)"
            onClick={() => setWatchAd(v => !v)} className={cn(btn, 'flex items-center gap-1', watchAd && 'bg-zinc-800 text-white')}>
            <Scale className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">A/D</span>
          </button>
          <button type="button" aria-pressed={watchContrib} aria-label="Nifty contribution" title="Nifty contribution: index points each Nifty 50 stock is adding or taking away, live (watch only)"
            onClick={() => setWatchContrib(v => !v)} className={cn(btn, 'flex items-center gap-1', watchContrib && 'bg-zinc-800 text-white')}>
            <ChartBarDecreasing className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">Contrib</span>
          </button>
          <button type="button" aria-pressed={cumOiOpen} aria-label="Cumulative OI"
            disabled={underlying === 'SENSEX'}
            title={underlying === 'SENSEX' ? 'Cumulative OI has no SENSEX view yet (NIFTY and MCX crude only); the chart\'s OI profile works for SENSEX' : 'Cumulative OI: call and put open interest across strikes'}
            onPointerEnter={() => preloadCumOi(isMcx(underlying))} onFocus={() => preloadCumOi(isMcx(underlying))}
            onClick={() => setCumOiOpen(v => !v)} className={cn(btn, 'flex items-center gap-1', cumOiOpen && 'bg-zinc-800 text-white')}>
            <AreaChart className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">Cum OI</span>
          </button>
          {sep}
          <button type="button" aria-pressed={chainOpen} aria-label="Option chain" title="Option chain" onClick={() => setChainOpen(v => !v)} className={cn(btn, chainOpen && 'bg-zinc-800 text-white')}><LayoutList className="w-4 h-4" /></button>
          <button type="button" aria-label="Reset scale" title="Reset scale: auto-scale the price axis and fit the time axis (undo a manual zoom)"
            onClick={() => { setAutoScale(true); setResetSeq(n => n + 1); }} className={btn}><Scaling className="w-4 h-4" /></button>
          <button type="button" aria-label="Refresh candles" title="Refresh candles" onClick={() => setRefreshTick(n => n + 1)} className={btn}><RefreshCw className={cn('w-4 h-4', loadingBars && 'animate-spin')} /></button>
          </div>
          <div className="flex items-center gap-1">
          <MtmGuardControl settings={mtm} onChange={onMtmChange} note={mtmShownNote} pnl={dayTotal.pnl} scope={underlying} />
          <button type="button" aria-label="Exit All" title="Exit All: close every position on this underlying" disabled={legs.length === 0 || exitingId !== null} onClick={() => void exitAll()}
            className="h-7 px-1.5 rounded border border-rose-500/70 text-rose-300 hover:bg-rose-500/10 text-xs font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
            <span className="flex items-center gap-1"><OctagonX className="w-4 h-4" aria-hidden /><span className="hidden min-[2200px]:inline">Exit All</span></span>
          </button>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-auto whitespace-nowrap">
          <span title="Current time (IST)" className="h-7 px-1.5 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 text-xs font-bold tabular-nums font-mono text-zinc-100"><IstClock /><span className="hidden min-[2200px]:inline">IST</span></span>
          <span className={cn('text-[11px] tabular-nums font-mono', feed.stale ? 'text-amber-400' : 'text-zinc-400')} title={`Live tick bridge${spotDisplay ? `: ${spotDisplay.toFixed(2)}` : ''}`}>
            <span className="hidden min-[2200px]:inline">{spotDisplay ? spotDisplay.toFixed(2) : '—'} </span><span className={cn('inline-block w-1.5 h-1.5 rounded-full align-middle', feed.feedAgeSec === null ? 'bg-zinc-600' : feed.stale ? 'bg-amber-400' : 'bg-emerald-400')} />
          </span>
          <BrokerPicker value={broker} onChange={setBroker} brokers={['dhan', 'kotak']} disabled={real || !brokerLoaded}
            disabledReason={real ? 'Switch to SIM to change the broker: a REAL session trades one account' : 'Loading the saved broker'} />
          <div role="group" aria-label="Order mode" className="flex rounded border border-zinc-700 overflow-hidden">
            <button type="button" aria-pressed={!real} onClick={goSim} className={cn('h-7 px-1.5 text-xs font-bold', !real ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400 hover:bg-zinc-800')}>SIM</button>
            <button type="button" aria-pressed={real} onClick={() => (real ? undefined : setArmOpen(true))} className={cn('h-7 px-1.5 text-xs font-bold', real ? 'bg-rose-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}>REAL</button>
          </div>
          <DataChip date={dataDate} />
          <button type="button" aria-label="Fullscreen" title="Fullscreen" className={btn}
            onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void rootRef.current?.requestFullscreen?.(); }}><Maximize2 className="w-4 h-4" /></button>
          <NavBar compact />
        </div>
      </div>

      {cumOiOpen && underlying !== 'SENSEX' && <CumulativeOIModal crude={isMcx(underlying)} zClass="z-[80]" chartsOnly onClose={() => setCumOiOpen(false)} />}

      {(candleErr || posErr || feed.stale || notLive || !feed.marketOpen || feed.kotakError) && (
        <div role="alert" className="px-3 py-1 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
          {candleErr && <span className="mr-3">Candles: {candleErr}</span>}
          {posErr && <span className="mr-3">Positions: {posErr}</span>}
          {feed.kotakError && <span data-testid="kotak-error" className="mr-3">{feed.kotakError}: Kotak orders and exits wait for it.</span>}
          {!feed.marketOpen && <span data-testid="market-closed" className="mr-3">{isMcx(underlying) ? 'MCX is closed (session 09:00-23:30/23:55 IST)' : `${INSTRUMENTS[underlying].exchange} F&O is closed (session 09:15-15:40 IST)`}: paper fills and market orders are off.</span>}
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

        <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {showTrend && layoutReady && <TrendStrip key={underlying} underlying={underlying} feed={feed} refreshTick={refreshTick} chartsIdle={indReady && !loadingBars} settings={trendSettings} />}
        <div className="relative flex flex-1 min-w-0 min-h-0">
          {indReady && layoutReady && (
            <>
            <ChartPane
              index={0} cfg={panes[0]} onCfgChange={onPaneCfg} onStatus={onPaneStatus}
              underlying={underlying} feed={feed} days={days} refreshTick={refreshTick}
              futureContract={chartContract} futureName={chartContractName}
              indicators={indicators} tool={tool} onToolDone={onToolDone} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale} showGrid={showGrid} candleColorRule={candleColorRule} showVolume={showVolume} volumeMaLen={volumeMaLen}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} onAdjustLeg={adjustLeg} exitingId={exitingId}
              onToggleIndicator={onToggleIndicator} onRemoveIndicator={removeIndicator} onEditIndicator={onEditIndicator}
              focus={focus} resetSeq={resetSeq} lots={scalpLots} openOrders={chartOpenOrders} onCancelOrder={cancelOrder} onModifyOrder={onModifyOrder}
              onPlaceChartOrder={onPlaceChartOrder} onOpenTicket={onOpenChartTicket} onAlert={onChartAlert}
              simBrackets={simBrackets} onSetBracket={onSetBracket} onCancelBracket={onCancelBracket}
              onReversePosition={onReversePosition} trails={trails} onSetTrail={onSetTrail} onCancelTrail={onCancelTrail} feedLotSize={feed.lotSize} lotSizes={lotMap} orderQtyMult={orderQtyMult} showOi={showOi} oiMode={oiMode}
              quick={quickProp} stepLots={quickEff.stepLots} real={real} onQuickTrade={onTradeContract} broker={broker}
            />
              {layout === 2 && <div className="w-px bg-zinc-800 shrink-0" />}
              {layout === 2 && (
            <ChartPane
              index={1} cfg={panes[1]} onCfgChange={onPaneCfg} onStatus={onPaneStatus}
              underlying={underlying} feed={feed} days={days} refreshTick={refreshTick}
              futureContract={chartContract} futureName={chartContractName}
              indicators={indicators} tool={tool} onToolDone={onToolDone} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale} showGrid={showGrid} candleColorRule={candleColorRule} showVolume={showVolume} volumeMaLen={volumeMaLen}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} onAdjustLeg={adjustLeg} exitingId={exitingId}
              onToggleIndicator={onToggleIndicator} onRemoveIndicator={removeIndicator} onEditIndicator={onEditIndicator}
              focus={focus} resetSeq={resetSeq} lots={scalpLots} openOrders={chartOpenOrders} onCancelOrder={cancelOrder} onModifyOrder={onModifyOrder}
              onPlaceChartOrder={onPlaceChartOrder} onOpenTicket={onOpenChartTicket} onAlert={onChartAlert}
              simBrackets={simBrackets} onSetBracket={onSetBracket} onCancelBracket={onCancelBracket}
              onReversePosition={onReversePosition} trails={trails} onSetTrail={onSetTrail} onCancelTrail={onCancelTrail} feedLotSize={feed.lotSize} lotSizes={lotMap} orderQtyMult={orderQtyMult} showOi={showOi} oiMode={oiMode}
              quick={quickProp} stepLots={quickEff.stepLots} real={real} onQuickTrade={onTradeContract} broker={broker}
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
      </div>

      {/* range strip */}
      <div className="flex items-center justify-between px-3 h-8 border-t border-zinc-800 text-[11px] text-zinc-400 shrink-0">
        <div className="flex items-center gap-1">
          {RANGES.map(r => (
            <button key={r.label} type="button" title={`Show the last ${r.label}`} className={btn} onClick={() => { setDays(r.days); setFocus(f => ({ seconds: r.focus, seq: (f?.seq ?? 0) + 1 })); }}>{r.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 tabular-nums font-mono">
          <IstClock suffix=" (UTC+05:30)" />
          <button type="button" aria-pressed={pctScale} title="Price axis in % change from the first visible bar" onClick={() => { setPctScale(v => !v); setLogScale(false); }} className={cn(scaleBtn, pctScale && 'text-sky-400')}>%</button>
          <button type="button" aria-pressed={logScale} title="Logarithmic price axis" onClick={() => { setLogScale(v => !v); setPctScale(false); }} className={cn(scaleBtn, logScale && 'text-sky-400')}>log</button>
          <button type="button" aria-pressed={autoScale} title="Auto-fit the price axis to the visible bars" onClick={() => setAutoScale(v => !v)} className={cn(scaleBtn, autoScale && 'text-sky-400')}>auto</button>
          <button type="button" aria-pressed={showGrid} aria-label="Grid" title="Background grid lines on / off (remembered)" onClick={toggleGrid} className={cn(scaleBtn, showGrid && 'text-sky-400')}>grid</button>
          {(() => {
            const rule = CANDLE_COLOR_RULES.find(r => r.id === candleColorRule) ?? CANDLE_COLOR_RULES[0];
            const on = candleColorRule !== 'off';
            return (
              <button type="button" data-testid="candle-color-rule" aria-pressed={on} aria-label={`Trend candles: ${rule.label}`}
                title={`Trend candles: ${rule.label}. ${rule.hint}. Click to change (remembered)`}
                onClick={cycleCandleColor} className={cn(scaleBtn, on && 'text-sky-400')}>
                {on ? `trend: ${rule.label}` : 'trend'}
              </button>
            );
          })()}
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
        orders={ordersView}
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
      {watchIdx && (
        <MarketWatchWindow kind="indices" rows={watchIdxRows} updatedAt={watch.data.indices?.updated_at ?? null}
          flash={watchIdxFlash} now={watch.now} initial={{ x: topMiddleX('left'), y: belowHeaderY() }} onClose={() => setWatchIdx(false)} />
      )}
      {watchStk && (
        <MarketWatchWindow kind="stocks" rows={watchStkRows} updatedAt={watch.data.stocks?.updated_at ?? null}
          flash={watchStkFlash} now={watch.now} initial={{ x: topMiddleX('right'), y: belowHeaderY() }} onClose={() => setWatchStk(false)} />
      )}
      {watchAd && (
        <NiftyBreadthWindow data={niftyContrib.data} error={niftyContrib.error} history={niftyContrib.history}
          initial={{ x: Math.max(64, topMiddleX('left') - 372), y: belowHeaderY() }} onClose={() => setWatchAd(false)} />
      )}
      {watchContrib && (
        <NiftyContributionWindow data={niftyContrib.data} error={niftyContrib.error}
          initial={{ x: Math.max(64, Math.min(topMiddleX('right') + 372, window.innerWidth - 368)), y: belowHeaderY() }} onClose={() => setWatchContrib(false)} />
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

      {exitAllAsk && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
          <div role="alertdialog" aria-label="Exit all including positions opened elsewhere" className="w-[420px] rounded-lg border border-rose-500/70 bg-zinc-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-rose-300 mb-2">Exit All will also close positions not opened from this page</h2>
            <p className="text-xs text-zinc-300 mb-2">These were opened elsewhere (a strategy, another terminal, the mobile app) or before today. A running strategy is not told and will still think it holds them.</p>
            <ul data-testid="exit-all-elsewhere" className="mb-4 max-h-40 overflow-auto text-xs font-mono text-zinc-200">
              {exitAllAsk.map(l => <li key={l.id}>{l.type} {l.strike} {l.product || ''} · {l.netQty > 0 ? '+' : ''}{l.netQty}</li>)}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setExitAllAsk(null)} className="h-8 px-3 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button type="button" onClick={() => void exitAll(true)} className="h-8 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold">Close all {legs.length} leg{legs.length === 1 ? '' : 's'}</button>
            </div>
          </div>
        </div>
      )}
      {reverseView && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
            <div role="alertdialog" aria-label="Reverse position" className="w-[420px] rounded-lg border border-rose-500/70 bg-zinc-900 p-5 shadow-2xl">
              <h2 className="text-sm font-bold text-rose-300 mb-2">Reverse {reverseView.isLong ? 'long' : 'short'} {reverseView.leg.type}{reverseView.leg.type === 'FUT' ? '' : ` ${reverseView.leg.strike}`}{reverseView.lots ? ` · ${reverseView.lots} lot${reverseView.lots === 1 ? '' : 's'}` : ''}?</h2>
              <p className="text-xs text-zinc-300 mb-2">Two market orders on {brokerName}: close the whole position (as the broker shows it now), then {reverseView.isLong ? 'SELL' : 'BUY'} the same lots on the same contract ({reverseView.leg.symbol}). The other side is opened only if the close is placed.</p>
              {reverseView.blk.own.length > 0 && <p className="text-xs text-zinc-300 mb-2">This page&apos;s working order{reverseView.blk.own.length === 1 ? '' : 's'} {reverseView.blk.own.join(', ')} on the closing side will be cancelled first (after the flip {reverseView.blk.own.length === 1 ? 'it' : 'they'} would add to the new position).</p>}
              {reverseView.blk.foreign.length > 0 && <p className="text-xs text-amber-400 mb-2">Order {reverseView.blk.foreign.join(', ')} placed elsewhere works on the closing side: the reverse will be refused until it is cancelled.</p>}
              <div className="flex justify-end gap-2 mt-3">
                <button type="button" autoFocus onClick={() => setReverseAsk(null)} className="h-8 px-3 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Cancel</button>
                <button type="button" onClick={() => void onReversePosition(reverseView.leg, true)} className="h-8 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold">Reverse to {reverseView.isLong ? 'short' : 'long'}</button>
              </div>
            </div>
          </div>
      )}
      {cancelAsk && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
          <div role="alertdialog" aria-label="Cancel an order placed elsewhere" className="w-[400px] rounded-lg border border-amber-500/70 bg-zinc-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-amber-300 mb-2">Cancel an order this page did not place?</h2>
            <p className="text-xs text-zinc-300 mb-2">It may be a strategy&apos;s or another terminal&apos;s stop protecting a position: cancelling it leaves that position without it.</p>
            <p className="mb-4 text-xs font-mono text-zinc-200">{cancelAsk.symbol} · {cancelAsk.side} {cancelAsk.qty ?? ''} {cancelAsk.orderType} {cancelAsk.trigger && cancelAsk.trigger > 0 ? `trigger ${cancelAsk.trigger.toFixed(2)}${cancelAsk.price && cancelAsk.price > 0 ? ` / limit ${cancelAsk.price.toFixed(2)}` : ''}` : (cancelAsk.price ?? '')} · order {cancelAsk.id}</p>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setCancelAsk(null)} className="h-8 px-3 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Keep it</button>
              <button type="button" onClick={() => { const id = cancelAsk.id; setCancelAsk(null); void sendCancel(id); }} className="h-8 px-3 rounded bg-amber-600 hover:bg-amber-500 text-oncolor text-xs font-bold">Cancel order {cancelAsk.id}</button>
            </div>
          </div>
        </div>
      )}
      {armOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
          <div role="alertdialog" aria-label="Arm real orders" className="w-[380px] rounded-lg border border-rose-500/70 bg-zinc-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-rose-300 mb-2">Arm REAL orders on {brokerName}?</h2>
            <p className="text-xs text-zinc-300 mb-4">Buy/Sell, Scalper and Exit will place live orders with real money on your {brokerName} account (max {INSTRUMENTS[underlying].maxLots} lots per order on {underlying}). The chart then shows your {brokerName} {underlying} positions; prices stay Dhan&apos;s live feed. REAL is switched off again whenever this page reloads.</p>
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
      className="absolute left-0 top-9 z-[60] w-60 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2.5 text-xs whitespace-normal">
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

/** The trend strip's optional lights (gear beside its switch), each on / off and remembered. Switches, so a change
 *  applies at once and there is nothing half-typed. Display only: none of these sends or blocks an order. */
function TrendSettingsMenu({ settings, onPatch, onClose }: {
  settings: TrendSettings; onPatch: (p: Partial<TrendSettings>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.('[aria-label="Trend strip settings"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const row = 'flex items-center justify-between gap-2 text-zinc-300 cursor-pointer';
  return (
    <div ref={ref} role="dialog" aria-label="Trend strip settings panel"
      className="absolute left-0 top-9 z-[60] w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2.5 text-xs whitespace-normal">
      <div className="font-bold text-zinc-100">Trend strip</div>
      <label className={row} title="Long / short buildup, short covering, long unwinding on the future's last closed candle (price x OI change)">
        <span>Futures OI buildup</span>
        <Switch size="sm" checked={settings.oiBuildup} onCheckedChange={v => onPatch({ oiBuildup: v })} aria-label="Futures OI buildup" />
      </label>
      <label className={row} title="The strip's Structure light (HH + HL = up, LH + LL = down) and the chart's HH / HL / LH / LL labels">
        <span>Market structure</span>
        <Switch size="sm" checked={settings.structure} onCheckedChange={v => onPatch({ structure: v })} aria-label="Market structure" />
      </label>
      <label className={cn(row, 'pl-3', !settings.structure && 'opacity-50 cursor-not-allowed')}
        title="The thin line on the chart joining the swings (HH to HL, LH to LL, ...); the labels stay">
        <span>Line joining the swings</span>
        <Switch size="sm" checked={settings.structureLine} disabled={!settings.structure}
          onCheckedChange={v => onPatch({ structureLine: v })} aria-label="Line joining the swings" />
      </label>
      <p className="text-[10px] leading-snug text-zinc-500">
        Both are extra lights, never part of the bias. Turning OI buildup off also stops its candle request.
        Market structure also shows / hides the HH / HL / LH / LL labels on the chart (swing length: Indicators → Market structure).
      </p>
    </div>
  );
}

/** The market-watch hook keys flashes 'i:NIFTY' / 's:HDFCBANK'; each window wants its own, unprefixed. */
function prefixFlash(all: Record<string, 'up' | 'down'>, prefix: string): Record<string, 'up' | 'down'> {
  const out: Record<string, 'up' | 'down'> = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  return out;
}

/** Default target / stop settings (header "TP / SL" button). Selects, not typed boxes: a half-typed value must never
 *  reach a live rule (dhan-commit-on-blur). Saved per browser in indexScalper.defaultBrackets.v1. */
function DefaultBracketsMenu({ settings, onPatch, onClose }: {
  settings: DefaultBracketSettings; onPatch: (p: Partial<DefaultBracketSettings>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest?.('[aria-label="Default target and stop settings"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const sel = 'h-7 w-16 px-1 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
  return (
    <div ref={ref} role="dialog" aria-label="Default target and stop panel"
      className="absolute left-0 top-9 z-[60] w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-3 flex flex-col gap-2.5 text-xs whitespace-normal">
      <label className="flex items-center justify-between gap-2 font-bold text-zinc-100 cursor-pointer">
        <span>Default target / stop</span>
        <Switch size="sm" checked={settings.on} onCheckedChange={on => onPatch({ on })} aria-label="Default target and stop" />
      </label>
      <DefaultLevelRow kind="TP" settings={settings} onPatch={onPatch} />
      <DefaultLevelRow kind="SL" settings={settings} onPatch={onPatch} />
      <p className="text-[10px] leading-snug text-zinc-500">
        A new option position opened here at market gets these levels from its entry premium once it shows in the book:
        a buy&apos;s target above entry and stop below, a sell&apos;s the other way. REAL places a Limit target and a stop-limit (SL) stop;
        SIM sets paper levels. Not for futures, added lots or limit entries; a position that already has a target / stop keeps it.
        A 100% stop is 2x entry on a sell; on a buy it would be 0, so a buy gets no stop. Points are premium points
        from entry (like the TSL), snapped to the tick away from entry.
      </p>
    </div>
  );
}

/** One side of the default levels: a % / pts unit switch, then a % select or a points box. The points box commits on
 *  blur / Enter only (dhan-commit-on-blur); a refused value puts the box back. */
function DefaultLevelRow({ kind, settings, onPatch }: {
  kind: 'TP' | 'SL'; settings: DefaultBracketSettings; onPatch: (p: Partial<DefaultBracketSettings>) => void;
}) {
  const isTp = kind === 'TP';
  const u = isTp ? settings.tpUnit : settings.slUnit;
  const saved = isTp ? settings.tpPts : settings.slPts;
  const [draft, setDraft] = useState(String(saved));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setDraft(String(saved)); setErr(null); }, [saved]);
  const commit = () => {
    if (draft.trim() === String(saved)) { setErr(null); return; }
    const r = parseBracketPoints(draft);
    if (r.error !== null) { setErr(r.error); setDraft(String(saved)); return; }
    setErr(null);
    onPatch(isTp ? { tpPts: r.pts } : { slPts: r.pts });
  };
  const name = isTp ? 'target' : 'stop';
  const ctl = 'h-7 w-16 px-1 rounded border border-zinc-700 bg-zinc-900 text-xs font-mono text-zinc-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-zinc-300">
        <span>{isTp ? 'Target' : 'Stop loss'} ({u === 'pts' ? 'points' : '% of entry'})</span>
        <div className="flex items-center gap-1.5">
          <div role="group" aria-label={`Default ${name} unit`} className={cn('flex rounded border border-zinc-700 overflow-hidden', !settings.on && 'opacity-40')}>
            {([['pct', '%'], ['pts', 'Pts']] as const).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={u === v} disabled={!settings.on}
                aria-label={`Default ${name} in ${v === 'pct' ? 'percent' : 'points'}`}
                onClick={() => onPatch(isTp ? { tpUnit: v as BracketUnit } : { slUnit: v as BracketUnit })}
                className={cn('h-7 px-1.5 text-[11px] font-bold disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  u === v ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:bg-zinc-800')}>{label}</button>
            ))}
          </div>
          {u === 'pct' ? (
            <select aria-label={`Default ${name} percent`} value={isTp ? settings.tpPct : settings.slPct} disabled={!settings.on}
              onChange={e => onPatch(isTp ? { tpPct: Number(e.target.value) } : { slPct: Number(e.target.value) })} className={ctl}>
              {(isTp ? TP_PCT_OPTIONS : SL_PCT_OPTIONS).map(n => <option key={n} value={n}>{n}%</option>)}
            </select>
          ) : (
            <input aria-label={`Default ${name} points`} inputMode="decimal" value={draft} disabled={!settings.on}
              aria-invalid={err !== null}
              onChange={e => setDraft(e.target.value)} onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(String(saved)); setErr(null); } e.stopPropagation(); }}
              className={cn(ctl, 'text-right')} />
          )}
        </div>
      </div>
      {err && <p role="alert" className="text-[10px] text-red-400">{err}</p>}
    </div>
  );
}
