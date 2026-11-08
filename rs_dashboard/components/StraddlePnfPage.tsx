'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Bot, Boxes, ChartScatter, Crosshair, Eye, Rewind, EyeOff, Flag, LocateFixed, XCircle, Volume2, VolumeX, Zap, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import InstrumentBar from './straddlePnf/InstrumentBar';
import { effectiveInterval, hasLongIntervals, intervalLabel, isTickInterval, tickBucketSec } from '@/lib/straddlePnfInterval';
import SettingsControls, { SmaPeriodInput, SupertrendControls } from './straddlePnf/SettingsControls';
import PnfTradeBar from './straddlePnf/PnfTradeBar';
import ScalperWindow, { type ScalperPos } from './straddlePnf/ScalperWindow';
import IndexMapControls from './straddlePnf/IndexMapControls';
import { useIndexHeld, useTradedLive } from './straddlePnf/useIndexHeld';
import { DEFAULT_INDEX_MAP, legShort, legText, readIndexMap, type IndexMap } from '@/lib/pnfIndexMap';
import { usePnfTrade } from './straddlePnf/usePnfTrade';
import BrokerBooks from './straddlePnf/BrokerBooks';
import HeaderClock from './straddlePnf/HeaderClock';
import { buildPaperTrades } from '@/lib/pnfPaperBook';
import { decodeMarkers, encodeMarkers } from '@/lib/pnfMarkerStore';
import { rupeesPerBox } from '@/lib/pnfGuardBoxes';
import type { LadderGuard } from '@/lib/priceLadderGuard';
import { AUTO_RULES, AUTO_SIDES, DEFAULT_AUTO_RULE, DEFAULT_AUTO_SIDE, SIDE_LABEL, ruleText, type AutoSide } from '@/lib/pnfAutoRule';
import HeaderPnlMargin from './straddlePnf/HeaderPnlMargin';
import { BROKERS, useBrokerSelector } from '@/hooks/useBrokerSelector';
import { withSavedBroker } from '@/hooks/withSavedBroker';
import { BrokerPicker } from './BrokerPicker';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock } from '@/lib/alertSound';
import { pnfChimeFor, playPnfChime, type PnfSoundEvent } from '@/lib/pnfChime';
import { buildConfirmedModel, withLive, type ChartType, type ConfirmedModel, type Overlay } from '@/lib/straddlePnfModel';
import { capLog, sessionWindow, tradingSession } from '@/lib/straddlePnfLive';
import {
  EMPTY_BOOK, countUpTo, cursorBefore, firstAvailableT, nextStepT, openLots, practiceAutoArm, practiceAutoStep, practiceCancel, practiceCross, practiceCrossBars,
  practiceFill, practiceFlatten, practiceMove, practicePlace, practicePnl, randomStartT, type PracticeBook, type PracticeQuote,
} from '@/lib/pnfReplay';
import { paperPosition, type LadderPosition } from '@/lib/pnfLadderPosition';
import { crosshairStamp } from '@/lib/straddlePnfTimeAxis';
import { useReplay } from './straddlePnf/useReplay';
import ReplayBar from './straddlePnf/ReplayBar';
import { HeaderIndexChips } from '@/components/triplestraddle/HeaderIndexChips';
import { useStableHandlers } from '@/lib/useStableHandlers';
import {
  DEFAULT_CHART1_SETTINGS, DEFAULT_CHART2_SETTINGS, DEFAULT_RENKO_SETTINGS, SETTINGS_KEY, SETTINGS_KEY_2, CHART_VIEW_KEY,
  boxText, readSettings, serializeSettings, type PnfSettings,
} from '@/lib/straddlePnfSettings';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';
import {
  DEFAULT_TARGETS, SEGMENTS, parseActiveChart, parseTarget, restoreChart, targetKey, targetLabel, type ChartPicks, type Segment, type Target,
} from '@/lib/pnfTarget';
import { usePnfFeed, type PnfFeed } from './straddlePnf/usePnfFeed';
import { usePnfAlerts } from './straddlePnf/usePnfAlerts';
import { detectTriangles, type PnfTriangle } from '@/lib/pnfTriangle';
import { isSellSignal } from '@/lib/straddlePnf';
import type { PnfScope } from '@/lib/pnfScope';
import { usePnfAuto, usePnfAutoLedger, type AutoArm, type AutoEvent, type AutoPyramid } from './straddlePnf/usePnfAuto';
import { autoDaySummary, autoMarkers, holdsPosition, isLive, PYRAMID_HARD_MAX, rowPnl } from '@/lib/pnfAutoLedger';
import AutoControls, { type AutoRule } from './straddlePnf/AutoControls';
import { AUTO_PRODUCT_LABEL, autoProductOf, autoWindow, pyramidEveryOf, rowMarket, TRAIL_BOXES_MAX, TRAIL_BOXES_MIN, type AutoProduct } from '@/lib/pnfAuto';
import { guardLevelsText, syncGuardFromServer, type ServerGuardView } from '@/lib/pnfServerGuardView';
import { usePnfPositions } from './straddlePnf/usePnfPositions';
import { usePnfGuard } from './straddlePnf/usePnfGuard';
import PnfOrderStyle, { DEFAULT_STYLE, type StyleState } from './straddlePnf/PnfOrderStyle';
import { cleanBracketSpec, planBracketChildren, type BracketSpec } from '@/lib/pnfBracket';
import { useChartLegs, usePnfResting, type RailChart, type RestingEvent } from './straddlePnf/usePnfResting';
import { applyPaperFill, FLAT_LEG, type PaperLeg, type PnfProduct } from '@/lib/pnfOrderLogic';
import { needsResolve, type RestingRow } from '@/lib/pnfRestingLedger';

// The same page draws Renko at /renko (`chart="renko"`): bricks instead of P&F columns (lib/renko.ts), N-brick confirmation
// signals, and its own preferences (every `straddle-pnf-*` key becomes `renko-*`), AUTO and resting-order ledgers (lib/pnfScope.ts)
// and leader tab, so the two pages can run side by side without touching each other's chart 1 / chart 2.
//
// Point & Figure with a 1-click execution trade bar, picked with Index | Equity | Futures | Options: an NSE index or stock, a
// future, one option, or a CE + PE straddle. Two charts can show two different instruments with their own box settings; the
// ACTIVE chart is the one the header controls and the trade bar act on. Each chart's bars come from the history API (re-fetched
// every 30 s, usePnfFeed); signals are only ever evaluated on CLOSED one-minute bars, so the poll never delays one.

const FLASH_MS = 4000;
const LOG_KEY = 'straddle-pnf-log';
const SOUND_KEY = 'straddle-pnf-sound';
const OVERLAY_KEY = 'straddle-pnf-overlay';
const OVERLAY_SHOWN_KEY = 'straddle-pnf-overlay-shown';
/** Renko only: whether the Supertrend line is drawn (shown unless switched off). */
const ST_SHOWN_KEY = 'straddle-pnf-supertrend-shown';
const COVER_SHOWN_KEY = 'straddle-pnf-cover-shown';
const TRADE_OPEN_KEY = 'straddle-pnf-trade-open';
// The Renko Scalper window: open / minimised and where it sits are remembered; its REAL unlock never is.
const SCALPER_OPEN_KEY = 'straddle-pnf-scalper-open';
const SCALPER_MIN_KEY = 'straddle-pnf-scalper-min';
/** Renko index chart -> option map, per chart (lib/pnfIndexMap.ts): `renko-index-map-1` / `-2`. */
const INDEX_MAP_KEY = 'straddle-pnf-index-map-';
const SCALPER_POS_KEY = 'straddle-pnf-scalper-pos';
/** The positions / order book / trade book / P&L strip at the bottom: collapsed by default (expanded it takes chart height). */
const BOOKS_OPEN_KEY = 'straddle-pnf-books-open';
/** The last pick in each segment, and which segment is open. `straddle-pnf-target` (one target) is the pre-switch key, read once. */
const TARGETS_KEY = 'straddle-pnf-targets';
const SEGMENT_KEY = 'straddle-pnf-segment';
/** Chart 2's own picks (its first visit copies chart 1), and which chart the controls act on. */
const TARGETS_KEY_2 = 'straddle-pnf-targets-2';
const SEGMENT_KEY_2 = 'straddle-pnf-segment-2';
const ACTIVE_CHART_KEY = 'straddle-pnf-active-chart';
const MARKERS_KEY = 'straddle-pnf-markers-';
/** AUTO lots per chart (AUTO itself is never remembered: it is armed per page load). */
const AUTO_LOTS_KEY = 'straddle-pnf-auto-lots-';
const AUTO_RULE_KEY = 'straddle-pnf-auto-rule-';
const AUTO_SIDE_KEY = 'straddle-pnf-auto-side-';
/** Renko pyramid (add a lot every N new bricks) per chart: JSON {on, max, every}. */
const AUTO_PYR_KEY = 'straddle-pnf-auto-pyr-';
/** The product AUTO opens with per chart: 'MARGIN' (NRML) or MIS (anything else). */
const AUTO_PROD_KEY = 'straddle-pnf-auto-prod-';
const DEFAULT_PYRAMID: AutoPyramid = { on: false, max: 10, every: 1, trailOn: true, trail: 2 };
const parsePyramid = (raw: string | null): AutoPyramid => {
  try {
    const j = JSON.parse(raw ?? 'null') as Partial<AutoPyramid> | null;
    if (!j) return DEFAULT_PYRAMID;
    return { on: j.on === true, max: Number.isInteger(j.max) && j.max! >= 1 && j.max! <= PYRAMID_HARD_MAX ? j.max! : DEFAULT_PYRAMID.max, every: pyramidEveryOf(j.every),
      trailOn: j.trailOn !== false, trail: Number.isInteger(j.trail) && j.trail! >= 1 && j.trail! <= TRAIL_BOXES_MAX ? Math.max(TRAIL_BOXES_MIN, j.trail!) : DEFAULT_PYRAMID.trail };   // a saved 1 was the same as 2
  } catch { return DEFAULT_PYRAMID; }
};
/** Per chart: '0' = the B / S trade markers are hidden. */
const MARKERS_SHOWN_KEY = 'straddle-pnf-markers-shown-';
const LINES_SHOWN_KEY = 'straddle-pnf-lines-shown-';
const TRI_SHOW_KEY = 'straddle-pnf-tri-show-';
const TRI_MIN_KEY = 'straddle-pnf-tri-min-';
const PIV_SHOW_KEY = 'straddle-pnf-piv-show-';
const PIV_K_KEY = 'straddle-pnf-piv-k-';
// v2: the target / SL / trail numbers are P&F BOXES now; the old key held points and must not be re-read as boxes
const STYLE_KEY = 'straddle-pnf-order-style-v2';
const TAG_LEFT_KEY = 'straddle-pnf-tag-left-';
const DISARMED: AutoArm = { on: false, mode: 'PAPER', watermarkT: 0 };

type ChartId = 1 | 2;
const LEGACY_TARGET_KEY = 'straddle-pnf-target';

const minuteOf = (t: number) => Math.floor(t / 60) * 60;
/** Wall clock in epoch seconds, for event handlers (module scope: never called during render). */
const nowSec = () => Date.now() / 1000;
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

/** A preference key on this page: the P&F page keeps its original keys, the Renko page swaps the `straddle-pnf` prefix for `renko`. */
const prefKey = (chart: ChartType, key: string) => (chart === 'renko' ? key.replace(/^straddle-pnf/, 'renko') : key);
const NO_TRIANGLES: PnfTriangle[] = [];
const NO_BARS: PnfFeed['bars'] = [];

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window / blocked storage: the page works without it */ }
}
/**
 * True at `px` wide and up (follows the window). The header places the Nifty / VIX chips by it: they fit beside the title only on a
 * wide screen, and they are rendered once (they start the indices bridge), so CSS alone cannot move them between rows.
 */
function useMinWidth(px: number): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${px}px)`);
    const onChange = () => setWide(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [px]);
  return wide;
}

/** A small icon-only header button with a tooltip (the label is also its accessible name). */
function IconButton({ icon: Icon, label, onClick, pressed, badge }: { icon: LucideIcon; label: string; onClick: () => void; pressed?: boolean; badge?: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        render={<button type="button" aria-label={label} aria-pressed={pressed}
                        className={`relative inline-flex items-center justify-center h-7 w-7 rounded-md border transition-colors ${pressed ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20' : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:bg-zinc-800'}`} />}
      >
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        {badge ? <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-oncolor text-[9px] font-bold leading-4 text-center">{badge}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One chart's P&F model: CLOSED bars only (so a signal never repaints), with the forming minute laid on top. */
function useChartModel(feed: PnfFeed, target: Target, rawSettings: PnfSettings, overlay: Overlay, liveNow: number, chart: ChartType, replayT: number | null = null, replayOnly = false, replayStartT: number | null = null) {
  // A long interval picked on a stock does not carry over to an instrument that has no such history.
  const interval = effectiveInterval(rawSettings.interval, hasLongIntervals(target.kind), chart === 'renko');
  const settings = useMemo(() => (interval === rawSettings.interval ? rawSettings : { ...rawSettings, interval }), [rawSettings, interval]);
  // An index's feed "volume" is its constituents' turnover, not traded volume: no VWAP. Whatever the instrument, the button follows
  // the model once bars are in (bars without volume, e.g. an illiquid option, get the box SMA too), so the toggle never
  // contradicts the chart.
  const indexNoVwap = target.kind === 'index';
  // Bar Replay: the chart as it stood at the cursor — its 1-min bars up to it, all closed (the clock sits a minute past the cursor).
  // `replayOnly`: the replay copy of a chart, which builds nothing while no replay runs (the live copy draws the chart then).
  // In replay the slice only changes when the bars up to the cursor do (a step, or a history reload swapping the bar objects),
  // not on each live tick past the cursor, which would re-slice years of minutes about once a second.
  const upTo = replayT === null ? 0 : countUpTo(feed.bars, replayT);
  const sliceHead = replayT === null ? feed.bars : feed.bars[0];
  const sliceTail = upTo > 0 ? feed.bars[upTo - 1] : null;
  const live = replayT === null;
  const bars = useMemo(
    () => (live ? (replayOnly ? NO_BARS : feed.bars) : feed.bars.slice(0, upTo)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sliceHead, sliceTail, upTo, live, replayOnly],
  );
  // The bar a % box is measured on (its session's first price: PanelOptions.boxBaseT), pinned so the box holds still: live, the last
  // bar when the history (re)loaded (a new instrument or Re-center; not the 30 s refresh, which keeps the epoch); in replay, the bar
  // before the replay's start, so stepping across sessions never resizes the box.
  const hasBars = feed.bars.length > 0;
  const loadBaseT = useMemo(
    () => (hasBars ? feed.bars[feed.bars.length - 1].t : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed.epoch, hasBars],
  );
  const boxBaseT = replayT !== null && replayStartT !== null ? replayStartT - 1 : loadBaseT;
  const now = replayT === null ? liveNow : (replayT + 60) * 1000;
  const last = bars[bars.length - 1];
  // the minute still forming; a Tick / 10 sec chart has none (its bars are emitted only once closed: lib/pnfTicks.ts)
  const formingBar = !isTickInterval(interval) && last !== undefined && now > 0 && last.t >= minuteOf(now / 1000) ? last : undefined;
  // The closed bars are sliced off only when the confirmed chart is rebuilt (a copy of years of minutes per tick otherwise).
  const closedLen = formingBar ? bars.length - 1 : bars.length;
  const closedLast = closedLen > 0 ? bars[closedLen - 1] : undefined;
  // The confirmed chart depends only on the closed bars, so it is rebuilt when a bar closes or history reloads, not on every tick.
  const closedKey = `${closedLen}:${bars[0]?.t ?? 0}:${closedLast?.t ?? 0}:${closedLast?.straddle ?? 0}:${feed.histVersion}`;
  const sessionClose = sessionWindow(feed.market, now / 1000)[1];
  // The previous build is handed back in: a closed bar or a replay step then only carries the chart on over the new bars.
  const prevRef = useRef<ConfirmedModel | null>(null);
  const confirmed = useMemo(
    // Reading the ref here is safe: `prev` only speeds the build up, the result is the same without it (straddlePnfModel.test.ts).
    // eslint-disable-next-line react-hooks/refs
    () => buildConfirmedModel(closedLen < bars.length ? bars.slice(0, closedLen) : bars, overlay, { ...settings, sessionCloseMin: sessionClose || undefined, volume: !indexNoVwap, anchorT: feed.loaded?.anchorT ?? undefined, boxBaseT, chart }, prevRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey, overlay, settings, sessionClose, indexNoVwap, feed.loaded?.anchorT, boxBaseT, chart],
  );
  useEffect(() => { prevRef.current = confirmed; }, [confirmed]);
  const model = useMemo(() => withLive(confirmed, formingBar), [confirmed, formingBar]);
  const vwapAllowed = !indexNoVwap && (closedLen === 0 || model.vwapAvailable);
  return { model, indexNoVwap, vwapAllowed, lastBar: closedLast ?? null, boxBaseT };
}

const readMarkers = (prefix: string, key: string): PnfExecutionMarker[] => {
  try { return decodeMarkers(localStorage.getItem(`${prefix}${key}`), istToday()); } catch { return []; }
};

function StraddlePnfPage({ chart = 'pnf' }: { chart?: ChartType }) {
  const renko = chart === 'renko';
  const scope: PnfScope = renko ? 'renko' : 'pnf';
  const readP = useCallback((key: string) => readPref(prefKey(chart, key)), [chart]);
  const saveP = useCallback((key: string, value: string) => savePref(prefKey(chart, key), value), [chart]);
  const markersPrefix = prefKey(chart, MARKERS_KEY);
  const defaults1 = renko ? DEFAULT_RENKO_SETTINGS : DEFAULT_CHART1_SETTINGS;
  const defaults2 = renko ? DEFAULT_RENKO_SETTINGS : DEFAULT_CHART2_SETTINGS;
  const [chartView, setChartView] = useState<'1' | '2'>('2');
  // Two charts: the one the header controls (instrument, box settings, price strip) and the trade bar act on.
  const [activeChart, setActiveChart] = useState<ChartId>(1);
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  // Whether the VWAP / SMA line is drawn at all: a display switch only, the signals still measure against it.
  const [overlayShown, setOverlayShown] = useState(true);
  // The Renko Supertrend line: a display switch only, nothing trades on it.
  const [supertrendShown, setSupertrendShown] = useState(true);
  // The COVER tag is a short-side hint nothing trades on: hidden unless switched on.
  const [coverShown, setCoverShown] = useState(false);
  const [target1, setTarget1] = useState<Target>(DEFAULT_TARGETS.index);
  const [target2, setTarget2] = useState<Target>(DEFAULT_TARGETS.index);
  // Each chart's last pick per segment (so switching segments brings it back) and its open segment.
  const picksRef = useRef<Record<ChartId, ChartPicks>>({ 1: { targets: { ...DEFAULT_TARGETS }, open: 'index' }, 2: { targets: { ...DEFAULT_TARGETS }, open: 'index' } });
  // No chart loads before the saved picks are read, so the default instrument is never fetched just to be replaced.
  const [prefsReady, setPrefsReady] = useState(false);
  const [settings, setSettings] = useState<PnfSettings>(defaults1);
  const [settings2, setSettings2] = useState<PnfSettings>(defaults2);
  // The contract pickers' error (e.g. an underlying with no live futures): shown in that chart instead of an endless "Loading…".
  const [contractError, setContractError] = useState<Record<ChartId, string | null>>({ 1: null, 2: null });
  const [recenter, setRecenter] = useState(0);
  // Re-center reloads and then resets the charts' zoom/pan to the centre; the flag waits for that load to land.
  const [viewTick, setViewTick] = useState(0);
  const recenterViewRef = useRef(false);
  const recenterNow = () => { recenterViewRef.current = true; setRecenter(n => n + 1); };
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(true);
  const [booksOpen, setBooksOpen] = useState(false);
  const [scalperOpen, setScalperOpen] = useState(false);
  const [scalperMin, setScalperMin] = useState(false);
  const [indexMap, setIndexMap] = useState<Record<ChartId, IndexMap>>({ 1: DEFAULT_INDEX_MAP, 2: DEFAULT_INDEX_MAP });
  const [scalperPos, setScalperPos] = useState<ScalperPos | null>(null);
  // REAL unlock of the Scalper, for ONE chart + instrument + mode: a chart switch, a new instrument or a mode change re-locks it
  // (the key no longer matches). Never remembered.
  const [scalperUnlockKey, setScalperUnlockKey] = useState<string | null>(null);
  const [autoArm, setAutoArm] = useState<Record<ChartId, AutoArm>>({ 1: DISARMED, 2: DISARMED });
  const [autoSide, setAutoSide] = useState<Record<ChartId, AutoSide>>({ 1: DEFAULT_AUTO_SIDE, 2: DEFAULT_AUTO_SIDE });
  const [autoRule, setAutoRule] = useState<Record<ChartId, AutoRule>>({ 1: DEFAULT_AUTO_RULE, 2: DEFAULT_AUTO_RULE });
  const [autoLots, setAutoLots] = useState<Record<ChartId, number>>({ 1: 1, 2: 1 });
  const [autoPyr, setAutoPyr] = useState<Record<ChartId, AutoPyramid>>({ 1: DEFAULT_PYRAMID, 2: DEFAULT_PYRAMID });
  const [autoProd, setAutoProd] = useState<Record<ChartId, AutoProduct>>({ 1: 'INTRADAY', 2: 'INTRADAY' });
  // Single | Bracket | Cover for the next entry (trade bar and chart rail), with its points; remembered, never armed silently.
  const [orderStyle, setOrderStyle] = useState<StyleState>(DEFAULT_STYLE);
  // Triangles (nested-column squeezes): drawn or not, and the fewest nested columns that count (3-6), per chart, remembered.
  const [triShown, setTriShown] = useState<Record<ChartId, boolean>>({ 1: true, 2: true });
  const [triMin, setTriMin] = useState<Record<ChartId, number>>({ 1: 3, 2: 3 });
  // Renko pivot high / low lines: drawn or not, and the swing each side needs in bricks (1-3), per chart, remembered.
  const [pivShown, setPivShown] = useState<Record<ChartId, boolean>>({ 1: true, 2: true });
  const [pivK, setPivK] = useState<Record<ChartId, number>>({ 1: 2, 2: 2 });
  const [markersShown, setMarkersShown] = useState<Record<ChartId, boolean>>({ 1: true, 2: true });
  // Order / position lines on the chart (like Kite's price lines) can be hidden, and their tags aligned left or right.
  const [linesShown, setLinesShown] = useState<Record<ChartId, boolean>>({ 1: true, 2: true });
  const [tagLeft, setTagLeft] = useState<Record<ChartId, boolean>>({ 1: false, 2: false });
  // REAL: moving / cancelling a broker order asks first, unless Instant is on for that chart (never remembered).
  const [instant, setInstant] = useState<Record<ChartId, boolean>>({ 1: false, 2: false });
  // ONE broker for the whole page: the header picker sets it (saved dashboard-wide, like the scalpers), and the trade bar and the
  // Margin / P&L chips read it from here, so the chips always show the account orders go to.
  const { broker, setBroker } = useBrokerSelector();
  const [tradeMode, setTradeMode] = useState<'PAPER' | 'REAL'>('PAPER');
  // REAL: the chart rail ignores clicks until it is unlocked (never remembered; PAPER needs no lock).
  const [railUnlocked, setRailUnlocked] = useState(false);
  const railArmed = tradeMode === 'PAPER' || railUnlocked;
  const [paperPnl, setPaperPnl] = useState(0);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<Record<ChartId, 'buy' | 'sell' | null>>({ 1: null, 2: null });
  const [now, setNow] = useState(0);
  // The active chart's price/summary strip is drawn into the top header (PnfPanel `headerSlot`).
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const { leaderRef } = useTabLeader(renko ? 'renko' : 'straddle-pnf');
  const wideHeader = useMinWidth(1400);
  const mutedRef = useRef(false);
  const logLoadedRef = useRef(false);

  // ── preferences, sound unlock, clock ────────────────────────────────────
  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    // Saved preferences are read after mount, not in useState initialisers: localStorage does not exist on the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (readP(OVERLAY_KEY) === 'sma') setOverlay('sma');
    if (readP(OVERLAY_SHOWN_KEY) === '0') setOverlayShown(false);
    if (readP(ST_SHOWN_KEY) === '0') setSupertrendShown(false);
    if (readP(COVER_SHOWN_KEY) === '1') setCoverShown(true);
    const savedView = readP(CHART_VIEW_KEY);
    if (savedView === '1' || savedView === '2') setChartView(savedView);
    setSettings(readSettings(readP(SETTINGS_KEY), defaults1));
    setSettings2(readSettings(readP(SETTINGS_KEY_2), defaults2));
    const raw1 = readP(TARGETS_KEY);
    const p1 = restoreChart(raw1, readP(SEGMENT_KEY));
    const legacy = parseTarget((() => { try { return JSON.parse(readP(LEGACY_TARGET_KEY) ?? 'null'); } catch { return null; } })());
    if (legacy && !raw1) { p1.targets[legacy.kind] = legacy; if (!readP(SEGMENT_KEY)) p1.open = legacy.kind; }   // one-time carry-over
    const raw2 = readP(TARGETS_KEY_2);
    const p2 = restoreChart(raw2, readP(SEGMENT_KEY_2), p1);
    // Chart 2's first visit copies chart 1 once and saves it, so it never follows later chart-1 picks by accident.
    if (raw2 === null) { saveP(TARGETS_KEY_2, JSON.stringify(p2.targets)); saveP(SEGMENT_KEY_2, p2.open); }
    picksRef.current = { 1: p1, 2: p2 };
    setTarget1(p1.targets[p1.open]);
    setTarget2(p2.targets[p2.open]);
    setActiveChart(parseActiveChart(readP(ACTIVE_CHART_KEY)));
    setPrefsReady(true);
    if (readP(SOUND_KEY) === '0') { setMuted(true); mutedRef.current = true; }
    if (readP(TRADE_OPEN_KEY) === '0') setTradeOpen(false);
    if (readP(BOOKS_OPEN_KEY) === '1') setBooksOpen(true);
    if (readP(SCALPER_OPEN_KEY) === '1') setScalperOpen(true);
    if (readP(SCALPER_MIN_KEY) === '1') setScalperMin(true);
    setIndexMap({ 1: readIndexMap(readP(`${INDEX_MAP_KEY}1`)), 2: readIndexMap(readP(`${INDEX_MAP_KEY}2`)) });
    try {
      const p = JSON.parse(readP(SCALPER_POS_KEY) ?? 'null') as ScalperPos | null;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) setScalperPos({ x: p.x, y: p.y });
    } catch { /* a bad saved spot: the window opens in its corner */ }
    const lotsOf = (c: ChartId) => { const n = Number(readP(`${AUTO_LOTS_KEY}${c}`)); return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 1; };
    setAutoLots({ 1: lotsOf(1), 2: lotsOf(2) });
    // The chosen AUTO rule is remembered per chart (AUTO itself never is): a reload must not put the default rule back under an open position.
    const ruleOf = (c: ChartId): AutoRule => { const v = readP(`${AUTO_RULE_KEY}${c}`); return AUTO_RULES.includes(v as AutoRule) ? v as AutoRule : DEFAULT_AUTO_RULE; };
    setAutoRule({ 1: ruleOf(1), 2: ruleOf(2) });
    const sideOf = (c: ChartId): AutoSide => { const v = readP(`${AUTO_SIDE_KEY}${c}`); return AUTO_SIDES.includes(v as AutoSide) ? v as AutoSide : DEFAULT_AUTO_SIDE; };
    setAutoSide({ 1: sideOf(1), 2: sideOf(2) });
    setAutoPyr({ 1: parsePyramid(readP(`${AUTO_PYR_KEY}1`)), 2: parsePyramid(readP(`${AUTO_PYR_KEY}2`)) });
    setAutoProd({ 1: autoProductOf(readP(`${AUTO_PROD_KEY}1`)), 2: autoProductOf(readP(`${AUTO_PROD_KEY}2`)) });
    setMarkersShown({ 1: readP(`${MARKERS_SHOWN_KEY}1`) !== '0', 2: readP(`${MARKERS_SHOWN_KEY}2`) !== '0' });
    try { const raw = readP(STYLE_KEY); if (raw) { const j = JSON.parse(raw); setOrderStyle({ style: j.style === 'Bracket' || j.style === 'Cover' ? j.style : 'Single', tgt: String(j.tgt ?? ''), sl: String(j.sl ?? ''), trail: String(j.trail ?? ''), trailOn: j.trailOn === true }); } } catch { /* keep Single */ }
    const minOf = (c: ChartId) => { const n = Number(readP(`${TRI_MIN_KEY}${c}`)); return Number.isInteger(n) && n >= 3 && n <= 6 ? n : 3; };
    setTriMin({ 1: minOf(1), 2: minOf(2) });
    setTriShown({ 1: readP(`${TRI_SHOW_KEY}1`) !== '0', 2: readP(`${TRI_SHOW_KEY}2`) !== '0' });
    const pivKOf = (c: ChartId) => { const n = Number(readP(`${PIV_K_KEY}${c}`)); return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 2; };
    setPivK({ 1: pivKOf(1), 2: pivKOf(2) });
    setPivShown({ 1: readP(`${PIV_SHOW_KEY}1`) !== '0', 2: readP(`${PIV_SHOW_KEY}2`) !== '0' });
    setLinesShown({ 1: readP(`${LINES_SHOWN_KEY}1`) !== '0', 2: readP(`${LINES_SHOWN_KEY}2`) !== '0' });
    setTagLeft({ 1: readP(`${TAG_LEFT_KEY}1`) === '1', 2: readP(`${TAG_LEFT_KEY}2`) === '1' });
    try {
      const raw = readP(LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setLog(parsed.slice(0, 30));
    } catch { /* corrupt stored log: start empty */ }
    logLoadedRef.current = true;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
    // the chart type is fixed per page, so this still runs once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart]);
  useEffect(() => { if (logLoadedRef.current) saveP(LOG_KEY, JSON.stringify(log)); }, [log, saveP]);

  // ── the two charts: each its own instrument, history, live price, model and alerts ──
  const dual = chartView === '2';
  const active: ChartId = dual && activeChart === 2 ? 2 : 1;
  // Renko Tick / 10 sec: the feed lays the bridge's recorded prices into the bars (lib/pnfTicks.ts). null = minute bars.
  const tickSec = (s: PnfSettings, t: Target) => { const n = effectiveInterval(s.interval, hasLongIntervals(t.kind), true); return renko && isTickInterval(n) ? tickBucketSec(n) : null; };
  const tick1 = tickSec(settings, target1) !== null;
  const tick2 = tickSec(settings2, target2) !== null;
  const feed1 = usePnfFeed(prefsReady ? target1 : null, recenter, now, tickSec(settings, target1));
  const feed2 = usePnfFeed(prefsReady && dual ? target2 : null, recenter, now, tickSec(settings2, target2));
  const c1 = useChartModel(feed1, target1, settings, overlay, now, chart);
  const c2 = useChartModel(feed2, target2, settings2, overlay, now, chart);

  // ── Bar Replay (lib/pnfReplay.ts): both charts as they stood at one past moment, played forward one bar of the active chart's
  // interval at a time. c1 / c2 stay LIVE and keep feeding everything that trades or alerts (AUTO, alerts, the rail's engine, the
  // MTM guard); the replay copies r1 / r2 only draw the charts and price the practice book.
  const intervalOf = (c: ChartId) => effectiveInterval((c === 2 ? settings2 : settings).interval, hasLongIntervals((c === 2 ? target2 : target1).kind), renko);
  const tickName1 = intervalLabel(intervalOf(1)), tickName2 = intervalLabel(intervalOf(2));
  const replay = useReplay({
    storageKey: prefKey(chart, 'straddle-pnf-replay'),
    charts: `${targetKey(target1)}|${dual ? targetKey(target2) : ''}`,
    stepFrom: t => { const f = active === 2 ? feed2 : feed1; return nextStepT(f.bars, t, intervalOf(active), sessionWindow(f.market, t)[1] || undefined); },
  });
  const replayT = replay.replaying ? replay.cursorT : null;
  const r1 = useChartModel(feed1, target1, settings, overlay, now, chart, replayT, true, replay.startT);
  const r2 = useChartModel(feed2, target2, settings2, overlay, now, chart, replayT, true, replay.startT);
  const shownOf = (c: ChartId) => (replayT === null ? (c === 2 ? c2 : c1) : (c === 2 ? r2 : r1));
  const activeTarget = active === 2 ? target2 : target1;
  const activeFeed = active === 2 ? feed2 : feed1;
  const activeSettings = active === 2 ? settings2 : settings;
  const activeChartModel = active === 2 ? c2 : c1;

  // Re-center: reset the zoom once the reload has landed.
  useEffect(() => {
    if (!recenterViewRef.current) return;
    recenterViewRef.current = false;
    setViewTick(n => n + 1);
  }, [feed1.epoch, feed2.epoch]);

  // ── alerts: new signals on newly closed bars, once each, per chart ───────
  const onFresh = (fresh: LogEntry[], chart: ChartId) => {
    const m = chart === 2 ? c2.model : c1.model;
    setLog(prev => fresh.filter(e => !prev.some(p => p.id === e.id)).reduce((l, e) => capLog(l, e), prev));
    for (const e of fresh) {
      if (e.kind === 'TRIANGLE_UP' || e.kind === 'TRIANGLE_DOWN') {
        const dn = e.kind === 'TRIANGLE_DOWN';
        const t = `${e.label} · △ ${dn ? 'breakdown' : 'breakout'} @ ${e.price.toFixed(2)}`;
        if (dn) toast.error(t, { description: e.detail }); else toast.success(t, { description: e.detail });
        setFlash(f => ({ ...f, [chart]: dn ? 'sell' : 'buy' }));
        setTimeout(() => setFlash(f => ({ ...f, [chart]: null })), FLASH_MS);
        continue;
      }
      const sell = isSellSignal(e.kind);
      const what = renko ? `Renko ${sell ? 'SELL' : 'BUY'} (${(chart === 2 ? settings2 : settings).reversal} bricks)` : sell ? 'Double bottom SELL' : 'Double top BUY';
      const title = `${e.label} · ${what} @ ${e.price.toFixed(2)}`;
      if (sell) toast.error(title, { description: e.belowVwap ? `Below ${m.vwapAvailable ? 'VWAP' : `SMA ${m.smaPeriod}`} — short entry zone` : undefined });
      else toast.success(title);
      setFlash(f => ({ ...f, [chart]: sell ? 'sell' : 'buy' }));
      setTimeout(() => setFlash(f => ({ ...f, [chart]: null })), FLASH_MS);
    }
    // Sound only in the leader tab, so two open tabs never double-ring; the toast and log still show everywhere. A signal is not a
    // trade: the neutral alert chime, or none when AUTO is armed on that chart (the trade it takes rings instead).
    if (leaderRef.current) chime({ kind: 'signal', autoArmed: autoArm[chart].on });
  };
  /** The Price Ladder's chime set (lib/pnfChime.ts), behind the page's mute. */
  const chime = (e: PnfSoundEvent) => { if (!mutedRef.current) playPnfChime(pnfChimeFor(e)); };
  const tk1 = targetKey(target1), tk2 = targetKey(target2);
  // Triangles of each chart's CLOSED columns (lib/pnfTriangle.ts). Kept apart from model.signals, which AUTO trades.
  // Triangles are a P&F pattern: a Renko chart has none.
  const tri1 = useMemo(() => renko ? NO_TRIANGLES : detectTriangles(c1.model.columns, c1.model.signals, c1.model.box, settings.reversal, triMin[1]), [renko, c1.model, settings.reversal, triMin]);
  // The replayed charts' own triangles (drawn while replaying; alerts keep using the live ones above).
  const rtri1 = useMemo(() => (renko || replayT === null ? NO_TRIANGLES : detectTriangles(r1.model.columns, r1.model.signals, r1.model.box, settings.reversal, triMin[1])), [renko, replayT, r1.model, settings.reversal, triMin]);
  const rtri2 = useMemo(() => (renko || replayT === null ? NO_TRIANGLES : detectTriangles(r2.model.columns, r2.model.signals, r2.model.box, settings2.reversal, triMin[2])), [renko, replayT, r2.model, settings2.reversal, triMin]);
  const tri2 = useMemo(() => renko ? NO_TRIANGLES : detectTriangles(c2.model.columns, c2.model.signals, c2.model.box, settings2.reversal, triMin[2]), [renko, c2.model, settings2.reversal, triMin]);
  usePnfAlerts({
    model: c1.model, ready: Boolean(feed1.loaded), chart: 1, target: target1, label: dual ? `${feed1.label} · C1` : feed1.label,
    strike: feed1.loaded?.key ?? 0, drawKey: `${tk1}|${feed1.epoch}|${serializeSettings(settings)}`, onFresh, triangles: tri1,
  });
  usePnfAlerts({
    model: c2.model, ready: dual && Boolean(feed2.loaded), chart: 2, target: target2, label: `${feed2.label} · C2`,
    strike: feed2.loaded?.key ?? 0, drawKey: `${tk2}|${feed2.epoch}|${serializeSettings(settings2)}|${dual}`, onFresh, triangles: tri2,
  });

  // ── trade execution markers, per instrument (a chart shows its own instrument's) ──
  const [markers, setMarkers] = useState<Record<string, PnfExecutionMarker[]>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMarkers(prev => {
      let next = prev;
      for (const k of [tk1, tk2]) if (!(k in next)) next = { ...next, [k]: readMarkers(markersPrefix, k) };
      return next;
    });
  }, [tk1, tk2, markersPrefix]);
  const saveMarkers = useCallback((key: string, update: (prev: PnfExecutionMarker[]) => PnfExecutionMarker[]) => {
    setMarkers(prev => {
      const list = update(prev[key] ?? readMarkers(markersPrefix, key));
      try { localStorage.setItem(`${markersPrefix}${key}`, encodeMarkers(istToday(), list)); } catch { /* ignore */ }
      return { ...prev, [key]: list };
    });
  }, [markersPrefix]);
  // Every instrument's stored markers (the trade book lists the day's paper fills of all of them, not just the two charts' contracts).
  const [storedMarkers, setStoredMarkers] = useState<Record<string, PnfExecutionMarker[]>>({});
  useEffect(() => {
    const out: Record<string, PnfExecutionMarker[]> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(markersPrefix)) out[k.slice(markersPrefix.length)] = readMarkers(markersPrefix, k.slice(markersPrefix.length));
      }
    } catch { /* storage blocked: only the open charts' markers are listed */ }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStoredMarkers(out);
  }, [markers, markersPrefix]);
  const handleTradeExecuted = useCallback((m: PnfExecutionMarker, t: Target) => saveMarkers(targetKey(t), prev => [...prev, m]), [saveMarkers]);

  // ── AUTO: each chart trades its own scrip (double-bottom SELL / double-top BUY, exit on the first column reversal) ──
  const onAutoEvent = useCallback((e: AutoEvent) => {
    if (e.kind === 'halt') toast.error(e.text, { duration: Infinity });
    else if (e.kind === 'info') toast.warning(e.text);
    else {
      (e.kind === 'entry' && e.side === 'SELL' ? toast.error : toast.success)(e.text);
      // The chart markers of AUTO trades come from the ledger (autoMarkers): on the signal bar, not at the decision time.
    }
    // AUTO runs on the dashboard server; only the leader tab rings for it: entry (rising), exit (falling), a refusal or a halt (warn buzz).
    if (leaderRef.current && !mutedRef.current) playPnfChime(pnfChimeFor({ kind: 'auto', type: e.kind }));
  }, [leaderRef]);
  // The server engine's entry / exit / halt lines become this page's toasts (and chimes), whether or not this tab was open for them.
  const { ledger: autoLedger, post: autoPost, engine: autoEngine } = usePnfAutoLedger(scope, e => onAutoEvent({ chart: e.chart, kind: e.kind ?? 'info', text: `AUTO C${e.chart} ${e.text}` }));
  // The arm switch is SAVED in the AUTO ledger (`arms`), and the dashboard server trades from it; every tab follows it (effect below).
  // `armDoneRef`: the armings this tab has stopped (or seen stopped): one is never shown on again from a ledger that has not caught up
  // with the stop yet (the effect below runs again before the stop's reply lands).
  const armDoneRef = useRef<Set<number>>(new Set());
  const autoArmRef = useRef(autoArm);
  useEffect(() => { autoArmRef.current = autoArm; });
  /** Every switch-off says why, in the ledger log (a silent one is how a missing re-entry went unexplained on 2026-11-04). */
  const disarm = useCallback((c: ChartId, why: string) => {
    const t = autoArmRef.current[c].armT;
    if (t !== undefined) armDoneRef.current.add(t);
    setAutoArm(a => (a[c].on ? { ...a, [c]: DISARMED } : a));
    // Idempotent in the ledger: a second switch-off (another tab, a repeated halt) logs nothing. A halt clears an arm waiting to resume too.
    void autoPost({ op: 'setArm', chart: c, arm: null, t: nowSec(), text: `AUTO switched off: ${why}` });
  }, [autoPost]);
  const priceOf = (f: PnfFeed) => (f.live ? f.live.ce + f.live.pe : null);

  // ── resting LIMIT / SL-limit orders from each chart's B / S rail (ladder-style) ──
  // The paper ledger lives here (not in the trade bar) so a rail fill and a trade-bar order build one paper position.
  const [paper, setPaper] = useState<Record<string, PaperLeg[]>>({});
  const [sizing, setSizing] = useState<{ lots: number; product: PnfProduct }>({ lots: 1, product: 'INTRADAY' });
  const onSizing = useCallback((s: { lots: number; product: PnfProduct }) => {
    setSizing(prev => (prev.lots === s.lots && prev.product === s.product ? prev : s));
  }, []);
  const legs1 = useChartLegs(broker, target1, targetKey(target1), prefsReady && target1.kind !== 'index' && feed1.complete);
  const legs2 = useChartLegs(broker, target2, targetKey(target2), prefsReady && dual && target2.kind !== 'index' && feed2.complete);
  const railChartOf = (c: ChartId): RailChart | null => {
    const target = c === 2 ? target2 : target1;
    const feed = c === 2 ? feed2 : feed1;
    const legs = c === 2 ? legs2 : legs1;
    if (target.kind === 'index' || !legs || (c === 2 && !dual)) return null;
    const straddle = target.kind === 'options' && target.side === 'STRADDLE';
    return {
      chart: c, target, targetKey: targetKey(target), price: priceOf(feed), stale: feed.stale, straddle, tick: legs.tick, unitsPerLot: legs.unitsPerLot, keys: legs.keys, lotUnits: legs.lotUnits,
      legPrices: !feed.live ? [null] : straddle ? [feed.live.ce, feed.live.pe] : [feed.live.ce + feed.live.pe],
    };
  };
  const railCharts = ([1, 2] as const).map(railChartOf).filter((x): x is RailChart => x !== null);
  // The header's account P&L prices open broker legs the book sends without a price (Kotak) from these: every chart leg's live price, by
  // the broker's key, fresh feeds only (a stale price would show a wrong running P&L; the leg stays unpriced, marked *, instead).
  const headerPrices = new Map<string, number>();
  for (const rc of railCharts) {
    if (rc.stale) continue;
    rc.keys.forEach((k, i) => { const px = rc.legPrices[i]; if (k && px != null && px > 0 && !headerPrices.has(k)) headerPrices.set(k, px); });
  }

  // ── practice trading in replay: a book of its own at the replayed prices — never an order route, a ledger or a broker ──
  const [book, setBook] = useState<PracticeBook>(EMPTY_BOOK);
  const [practiceLots, setPracticeLots] = useState(1);
  const quoteOf = (c: ChartId): PracticeQuote | null => {
    if (replayT === null || (c === 2 && !dual)) return null;
    const target = c === 2 ? target2 : target1;
    const legs = c === 2 ? legs2 : legs1;
    const bar = (c === 2 ? r2 : r1).lastBar;
    if (!bar || target.kind === 'index' || !legs) return null;
    const straddle = target.kind === 'options' && target.side === 'STRADDLE';
    return { chart: c, targetKey: targetKey(target), t: replayT, price: bar.ce + bar.pe, legPrices: straddle ? [bar.ce, bar.pe] : [bar.ce + bar.pe], unitsPerLot: legs.unitsPerLot };
  };
  // Each new cursor: resting practice orders the replayed price reached fill, then practice AUTO decides on the replayed chart.
  // The book records the cursor it was last advanced to, so each cursor is processed once (a start point is recorded unprocessed).
  useEffect(() => {
    if (replayT === null || book.at === replayT) return;
    const steps = ([1, 2] as const).map(c => ({ q: quoteOf(c), model: (c === 2 ? r2 : r1).model, market: (c === 2 ? feed2 : feed1).market, bars: (c === 2 ? feed2 : feed1).bars,
      product: ((c === 2 ? target2 : target1).kind === 'equity' ? 'INTRADAY' : autoProd[c]) as AutoProduct }));
    const from = book.at;
    // Resting orders see every minute the step revealed; AUTO decides once, on the chart bar that closed.
    const advance = (b: PracticeBook) => steps.reduce((out, st) => {
      if (!st.q) return out;
      const q = st.q;
      const crossed = from === null ? practiceCross(out, q) : practiceCrossBars(out, st.bars, from, replayT, bar => ({
        ...q, t: bar.t, price: bar.ce + bar.pe, legPrices: q.legPrices.length === 2 ? [bar.ce, bar.pe] : [bar.ce + bar.pe],
      }));
      return practiceAutoStep(crossed, q, st.model, st.market, st.product);
    }, b);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBook(b => (b.at === replayT ? b : { ...advance(b), at: replayT }));
  // quoteOf reads r1 / r2 / the legs of this render: the models listed are the ones that change with the cursor
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayT, book.at, r1.model, r2.model]);
  /** A new start point: the book starts empty and the start itself fills nothing. */
  const startReplayAt = (c: ChartId, t: number) => {
    // The same rule as opening Replay: a chart running live AUTO must keep showing what AUTO trades on
    const busy = ([1, 2] as const).filter(x => (x === 1 || dual) && (autoArm[x].on || !!(x === 2 ? auto2 : auto1).row));
    if (busy.length) { toast.warning(`Chart ${busy.join(' and ')} is running AUTO: stop it (and let its position close) before replaying`); return; }
    const bars = (c === 2 ? feed2 : feed1).bars;
    const i = countUpTo(bars, t - 1);
    if (i >= bars.length) { toast.warning('No bars after that time to replay'); return; }
    const first = bars[i].t;
    const cursor = cursorBefore(bars, first);
    setBook({ ...EMPTY_BOOK, at: cursor });
    replay.start(cursor, first);
  };
  const practiceQuotes = { [targetKey(target1)]: quoteOf(1) ?? undefined, ...(dual ? { [targetKey(target2)]: quoteOf(2) ?? undefined } : {}) };
  const practiceRailFor = (c: ChartId) => {
    const q = quoteOf(c);
    if (!q) return undefined;
    const tk = q.targetKey;
    return {
      position: paperPosition(book.legs[tk] ?? [], q.legPrices, q.unitsPerLot),
      armed: true,
      lockable: false,
      linesShown: true,
      orders: book.orders.filter(o => o.targetKey === tk).map(o => ({
        id: o.id, side: o.side, kind: o.kind, level: o.level, price: o.level, trigger: o.kind === 'stop' ? o.level : undefined, lots: o.lots, state: 'working', mode: 'PAPER' as const,
      })),
      onPlace: (side: 'BUY' | 'SELL', level: number) => setBook(b => practicePlace(b, c, tk, side, level, practiceLots, q.price)),
      onModify: (id: string, level: number) => setBook(b => practiceMove(b, id, level)),
      onCancel: (id: string) => setBook(b => practiceCancel(b, id)),
      onLots: (id: string, delta: number) => setBook(b => ({ ...b, orders: b.orders.map(o => (o.id === id ? { ...o, lots: Math.max(1, o.lots + delta) } : o)) })),
      onCancelAll: () => setBook(b => ({ ...b, orders: b.orders.filter(o => o.targetKey !== tk) })),
    };
  };
  const positionsInfo = usePnfPositions({ charts: railCharts, broker, mode: tradeMode, paper });
  const positions = positionsInfo.byKey;
  const changeStyle = (s: StyleState) => { setOrderStyle(s); saveP(STYLE_KEY, JSON.stringify(s)); };
  /** The next entry's bracket: a spec, null (Single), or why it is not ready (then nothing is sent). */
  // The Style bar's numbers are P&F boxes of the chart the order goes to: they become price points with that chart's own box size.
  const bracketSpecNow = (chart: ChartId = active): BracketSpec | null | string => {
    if (orderStyle.style === 'Single') return null;
    const box = (chart === 2 ? c2 : c1).model.box;
    if (!(box > 0)) return 'The chart has no box size yet - wait for its data';
    const pts = (v: string) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) && n > 0 ? String(+(n * box).toFixed(6)) : v; };
    const spec = cleanBracketSpec(orderStyle.style, pts(orderStyle.tgt), pts(orderStyle.sl), orderStyle.trailOn ? pts(orderStyle.trail) : undefined);
    return typeof spec === 'string' ? spec.replace(/points/g, 'boxes') : spec;
  };
  const onRestingEvent = (e: RestingEvent) => {
    if (e.kind === 'warn') { toast.warning(e.text, { duration: 15_000 }); chime({ kind: 'manual', outcome: 'rejected', close: false }); return; }
    if (e.kind === 'info') { toast(e.text); return; }
    toast.success(e.text);
    chime({ kind: 'manual', outcome: 'placed', close: false });
    if (e.target && e.side && e.price) {
      const t = Math.floor(nowSec());
      handleTradeExecuted({ id: e.id ?? `rail-${t}-${e.chart}`, t, action: e.side, price: e.price, lots: e.lots ?? 1, mode: e.mode ?? 'PAPER', estimate: e.estimate ?? false }, e.target);
    }
  };
  const onPaperFill = (row: RestingRow, legPrices: number[]) => {
    const unitsOf = (i: number) => (row.legUnits?.[i] ?? row.unitsPerPoint) / Math.max(1, row.lots);
    const delta = row.side === 'BUY' ? row.lots : -row.lots;
    setPaper(prev => {
      const legs = prev[row.targetKey] ?? legPrices.map(() => FLAT_LEG);
      return { ...prev, [row.targetKey]: legs.map((l, i) => applyPaperFill(l, delta, legPrices[i] ?? 0, unitsOf(i))) };
    });
  };
  const resting = usePnfResting({
    charts: railCharts, broker, mode: tradeMode, lots: sizing.lots, product: sizing.product, leaderRef, onEvent: onRestingEvent, onPaperFill, instant, positions, positionsLoaded: positionsInfo.loaded, scope,
  });
  // Header: cancel every working order on both charts (stop-loss / target exits included). REAL broker orders ask once first.
  const workingRows = resting.ledger.rows.filter(r => r.state === 'working');
  const cancelEveryOrder = () => {
    if (!workingRows.length) return;
    const real = workingRows.filter(r => r.venue === 'broker').length;
    // PAPER orders and page-held levels cancel at once; only orders resting at a REAL broker ask first
    if (real && !window.confirm(`Cancel ${workingRows.length} working order${workingRows.length === 1 ? '' : 's'} on every chart?\n\n${real} REAL order${real === 1 ? ' rests' : 's rest'} at your broker and will be cancelled there.`)) return;
    void resting.cancelEverything();
  };
  // MTM guard (page-held, per chart): on a trip, cancel the chart's orders and bracket exits, then square its position off.
  /** Resolves true when nothing of this chart's is left to exit (the guard is done), false / void while it should keep trying. */
  const exitChart = async (c: ChartId, reason: string): Promise<boolean | 'kept'> => {
    const rc = railCharts.find(x => x.chart === c);
    if (!rc) return false;
    await resting.cancelAllFor(rc.targetKey);
    // AUTO's own position on this chart: closed through AUTO's own exit (a PAPER row lives in the AUTO ledger, not the paper book
    // below; a REAL one exits only the units AUTO opened). It also switches AUTO off, so a trend rule cannot re-enter at once.
    const ar = autoOf(c).row;
    const aRow = ar && ar.targetKey === rc.targetKey && ar.mode === tradeMode ? ar : null;
    if (aRow) {
      // An AUTO row on another broker than the page's cannot be exited from here (the exit goes to the broker the row was opened on).
      if (aRow.broker !== broker) { toast.warning(`MTM guard: chart ${c}'s AUTO position is on ${aRow.broker}, not ${broker} - switch the page back to exit it`, { duration: 15_000 }); return false; }
      if (aRow.state !== 'open') return false;
      const closed = await autoOf(c).exitNow('mtm guard');
      // REAL: anything else on the contract (a manual lot) goes on the next retry, once the book shows what is left - an immediate close
      // could repeat AUTO's own exit before the broker has booked it. PAPER is local and exact: it carries on below.
      if (!closed || tradeMode === 'REAL') return false;
    }
    if (tradeMode === 'PAPER') {
      const legs = paper[rc.targetKey];
      if (!legs?.some(l => l.lots !== 0)) return aRow !== null;                                            // nothing else open (AUTO's row was the position)
      if (rc.legPrices.some(p => p == null || p <= 0)) return false;                                       // no price yet: retried
      const lotsOpen = Math.max(...legs.map(l => Math.abs(l.lots)));
      const action = legs[0].lots > 0 ? 'SELL' : 'BUY';
      setPaper(prev => {
        const cur = prev[rc.targetKey];
        return cur ? { ...prev, [rc.targetKey]: cur.map((l, i) => applyPaperFill(l, -l.lots, rc.legPrices[i] ?? 0, rc.unitsPerLot[i] ?? 1)) } : prev;
      });
      handleTradeExecuted({ id: `guard-${rc.chart}-${Math.floor(nowSec())}`, t: Math.floor(nowSec()), action, price: rc.price ?? 0, lots: lotsOpen, mode: 'PAPER', estimate: false }, rc.target);
      chime({ kind: 'manual', outcome: 'placed', close: true });
      return true;
    }
    try {
      const res = await fetch('/api/straddle-pnf/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, mode: 'REAL', target: rc.target, close: true, scope, guardChart: c }) });
      const j = await res.json() as { success?: boolean; error?: string; message?: string; outcome?: string };
      // What is left on the contract is another AUTO position (the other page's, or this page's other chart): this chart has nothing more to exit
      if (j.outcome === 'kept') { toast.info(`MTM guard on chart ${c}: ${j.message}`, { duration: 15_000 }); return 'kept'; }
      if (j.success) { toast.success(`MTM guard squared off chart ${c}: ${reason}`); chime({ kind: 'manual', outcome: 'placed', close: true }); }
      else if (res.status !== 409) toast.warning(`MTM guard exit: ${j.error ?? j.message ?? 'not confirmed'} - it is retried while the position is open`, { duration: 15_000 });
    } catch { toast.warning('MTM guard exit: no clean reply - check Positions; it is retried', { duration: 15_000 }); }
    return false;
  };
  // + / − on the ladder's position chip: one lot more (+, the position's own side) or one lot less (−, the opposite side) at
  // MARKET on that chart's contract. A plain order (no bracket), refused while the rail is locked, while AUTO holds the chart or
  // while the previous click is still out; REAL asks first unless Instant is on. An unclear reply is never resent.
  const adjustBusyRef = useRef<Record<number, boolean>>({});
  const adjustSeqRef = useRef(0);   // marker ids: two clicks in one second must not share one
  const adjustPosition = async (c: ChartId, dir: 1 | -1) => {
    const rc = railCharts.find(x => x.chart === c);
    const pos = rc ? positions[rc.targetKey] : null;
    if (!rc || !pos || pos.side === 'MIXED' || !railArmed || adjustBusyRef.current[c]) return;
    if (autoArm[c].on || autoOf(c).row) { toast.warning(`Chart ${c} is run by AUTO: stop it before changing its position by hand`); return; }
    const action: 'BUY' | 'SELL' = (pos.side === 'LONG') === (dir === 1) ? 'BUY' : 'SELL';
    const reduces = dir === -1;
    const what = `${action} 1 lot at MARKET (${reduces ? 'reduce' : 'add to'} ${pos.side} ${pos.lots}L) on ${rc.target.symbol}`;
    if (tradeMode === 'REAL' && !instant[c] && !window.confirm(`${what}?\n\nThis is a REAL order at your broker.`)) return;
    const t = Math.floor(nowSec());
    if (tradeMode === 'PAPER') {
      if (rc.legPrices.some(p => p == null || p <= 0)) { toast.error('No live price yet - paper order not filled'); return; }
      const delta = action === 'BUY' ? 1 : -1;
      setPaper(prev => {
        const legs = prev[rc.targetKey] ?? rc.legPrices.map(() => FLAT_LEG);
        return { ...prev, [rc.targetKey]: legs.map((l, i) => applyPaperFill(l, delta, rc.legPrices[i] ?? 0, rc.unitsPerLot[i] ?? 1)) };
      });
      handleTradeExecuted({ id: `adj-${c}-${t}-${++adjustSeqRef.current}`, t, action, price: rc.price ?? 0, lots: 1, mode: 'PAPER', estimate: false }, rc.target);
      chime({ kind: 'manual', outcome: 'placed', close: reduces });
      toast.success(`[PAPER] ${what}`);
      return;
    }
    adjustBusyRef.current[c] = true;
    try {
      const res = await fetch('/api/straddle-pnf/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker, mode: 'REAL', target: rc.target, action, lots: 1, product: sizing.product, scope }),
      });
      const j = await res.json() as { outcome?: string; error?: string; message?: string };
      chime({ kind: 'manual', outcome: j.outcome, close: reduces });
      const msg = j.message ?? j.error ?? 'Unknown error';
      if (j.outcome === 'placed') {
        toast.success(`[${broker.toUpperCase()}] ${what}. ${msg}`);
        handleTradeExecuted({ id: `adj-${c}-${t}-${++adjustSeqRef.current}`, t, action, price: rc.price ?? 0, lots: 1, mode: 'REAL', estimate: true }, rc.target);
      } else if (j.outcome === 'kept') toast.info(msg, { duration: 15_000 });
      else if (j.outcome === 'partial') toast.error(msg, { duration: Infinity });
      else if (j.outcome === 'unknown') toast.warning(`${msg} - check Orders/Positions before retrying`, { duration: Infinity });
      else if (j.outcome === 'reversed') toast.warning(msg, { duration: 15_000 });
      else toast.error(`Order failed: ${msg}`);
    } catch (err) {
      chime({ kind: 'manual', outcome: 'unknown', close: reduces });
      toast.warning(`Order status unknown - check Orders/Positions before retrying (${(err as Error).message})`, { duration: Infinity });
    } finally {
      adjustBusyRef.current[c] = false;
    }
  };
  // The guard watches AUTO's PAPER position too: it lives in the AUTO ledger, not the trade bar's paper book. A REAL AUTO position is
  // already in the broker's book, which `positions` reads.
  const guardPositions: Record<string, LadderPosition | null> = { ...positions };
  if (tradeMode === 'PAPER') {
    for (const rc of railCharts) {
      const r = autoLedger.rows.find(x => x.mode === 'PAPER' && x.state === 'open' && x.chart === rc.chart && x.targetKey === rc.targetKey);
      if (r && !guardPositions[rc.targetKey]) {
        guardPositions[rc.targetKey] = { side: r.side === 'SELL' ? 'SHORT' : 'LONG', lots: r.lots, avg: r.entryPrice, entryPnl: 0, pnl: rc.price != null && rc.price > 0 ? rowPnl(r.side, r.entryPrice, rc.price, r.unitsPerPoint) : null };
      }
    }
  }
  // What one box of a chart is worth on its open position (box points x lots x rupees per point per lot): the guard's box levels.
  const boxRupees = (c: ChartId): number | null => {
    const rc = railCharts.find(x => x.chart === c);
    return rc ? rupeesPerBox((c === 2 ? c2 : c1).model.box, guardPositions[rc.targetKey]?.lots, rc.unitsPerLot[0]) : null;
  };
  // The guard is also enforced by the dashboard SERVER on open REAL AUTO positions (lib/autoServerWatcher.ts), so a closed or sleeping tab
  // does not leave one without its stop: every change of a chart's guard is synced to it.
  const syncServerGuard = (c: 1 | 2, g: LadderGuard | null, quiet = false) => {
    const boxPts = (c === 2 ? c2 : c1).model.box;
    if (g && (g.targetBoxes != null || g.stopBoxes != null) && !(boxPts > 0)) {
      // A box that merely became unknown (chart 2 switched off in single-chart view, or still loading) is not a user action: the server
      // keeps the copy it already has, and the effect below re-syncs as soon as the box is known. Only a click on the card warns.
      if (quiet) return;
      toast.warning(`The server copy of chart ${c}'s guard was NOT updated: its box size is not known yet, so the box levels cannot be enforced with the tab closed. It updates once the chart has its box.`, { duration: 15_000 });
      return;
    }
    const levels = g ? Object.fromEntries((['target', 'stop', 'trailBy', 'lockAt', 'lockKeep', 'lockStepEvery', 'lockStepKeep', 'targetBoxes', 'stopBoxes'] as const).filter(k => g[k] != null).map(k => [k, g[k]])) : undefined;
    void fetch(`/api/straddle-pnf/server-guard?scope=${scope}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g ? { chart: c, on: true, broker, mode: tradeMode, boxPts, levels } : { chart: c, on: false }),
    }).catch(() => { /* the page's own guard still runs; the server copy is the backstop */ });
  };
  const guards = usePnfGuard({
    charts: railCharts.map(c => ({ chart: c.chart, targetKey: c.targetKey })), positions: guardPositions, positionsLoaded: positionsInfo.loaded,
    scope: `${broker}:${tradeMode}`, leaderRef, exitChart, rupeesPerBox: boxRupees, tradeKey: c => autoOf(c).row?.id ?? null, syncServer: syncServerGuard, storeKey: prefKey(chart, 'straddle-pnf-guard-'),
    onEvent: (c, kind, text) => { if (kind === 'warn') { toast.warning(text, { duration: 15_000 }); chime({ kind: 'manual', outcome: 'rejected', close: false }); } else toast(text); void c; },
  });
  // A box-level guard is converted to rupees with the chart's box size: when that changes (or first becomes known), the server copy follows.
  useEffect(() => {
    for (const c of [1, 2] as const) {
      const g = guards.guardOf(c);
      if (g.on && (g.targetBoxes != null || g.stopBoxes != null)) syncServerGuard(c, g, true);
    }
    // only when a chart's box size changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c1.model.box, c2.model.box]);
  // A guard the server holds (the tab was closed or reloaded with it on, or it was set in another broker / mode): the page picks it up
  // whenever the page's broker or mode becomes the guard's, so what the server enforces is always what the card shows. Checked on load AND
  // on every broker / mode change: a page loads in PAPER, so a once-per-load check skipped a REAL guard for good and the card read OFF while
  // the server kept exiting REAL AUTO trades by it (2026-11-05).
  const adoptSeqRef = useRef(0);
  const adoptWarnedRef = useRef<Set<string>>(new Set());
  const guardsRef = useRef(guards);
  useEffect(() => { guardsRef.current = guards; });
  /** Every guard the server holds for this page, any broker / mode: always listed beside the MTM Guard button. */
  const [serverGuards, setServerGuards] = useState<{ chart: 1 | 2; view: ServerGuardView }[]>([]);
  useEffect(() => {
    const seq = ++adoptSeqRef.current;
    // Which charts had a server copy for THIS broker + mode on the previous poll (a copy that disappears switches the card off).
    const wasOn: Record<1 | 2, boolean> = { 1: false, 2: false };
    let dead = false;
    const poll = async () => {
      try {
        const j = await (await fetch(`/api/straddle-pnf/server-guard?scope=${scope}`)).json() as { guards?: Record<string, ServerGuardView> };
        if (dead || seq !== adoptSeqRef.current) return;             // the broker / mode changed meanwhile: that newer poll decides
        const byChart: Partial<Record<1 | 2, ServerGuardView>> = {};
        for (const [k, cfg] of Object.entries(j.guards ?? {})) {
          const chartN = Number(k.split(':')[1]);
          if (chartN === 1 || chartN === 2) byChart[chartN] = { broker: cfg.broker, mode: cfg.mode, levels: cfg.levels ?? {} };
        }
        const list = ([1, 2] as const).filter(c => byChart[c]).map(c => ({ chart: c, view: byChart[c]! }));
        setServerGuards(prev => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
        const g = guardsRef.current;
        for (const c of [1, 2] as const) {
          const server = byChart[c];
          const d = syncGuardFromServer({
            card: g.guardOf(c), server, broker, mode: tradeMode, wasOnServer: wasOn[c],
            recentLocalChange: Date.now() - g.localChangedAt(c) < 6_000,
          });
          const mine = !!server && server.broker === broker && server.mode === tradeMode;
          if (Date.now() - g.localChangedAt(c) >= 6_000) wasOn[c] = mine;
          if (d.action === 'adopt') g.adopt(c, { on: true, ...d.levels });
          if (d.action === 'release' && !g.guardOf(c).tripped) { g.release(c); toast.info(`MTM guard on chart ${c} was switched off on the server (another tab): it is OFF here too.`, { duration: 10_000 }); }
          if (!server || mine) continue;
          const warnKey = `${c}:${server.broker}:${server.mode}`;
          if (adoptWarnedRef.current.has(warnKey)) continue;
          // Held for another broker / mode than the page's. It is always listed beside the MTM Guard button; it is also said out loud while a
          // REAL AUTO position is actually open on that chart (then it is a live stop the card here does not show).
          let liveRow = true;
          try {
            const l = await (await fetch(`/api/straddle-pnf/auto?scope=${scope}`)).json() as { ledger?: { rows?: { chart: number; mode: string; state: string }[] } };
            liveRow = (l.ledger?.rows ?? []).some(r => r.chart === c && r.mode === 'REAL' && r.state !== 'closed');
          } catch { /* unknown: warn */ }
          if (!liveRow || dead) continue;
          adoptWarnedRef.current.add(warnKey);
          toast.warning(`The server is still guarding chart ${c}'s open ${server.mode} position on ${server.broker} (MTM guard with the tab closed). Switch the page to ${server.broker} ${server.mode} to see and edit it.`, {
            duration: 30_000, closeButton: true,
            action: { label: 'Switch it off', onClick: () => { void fetch(`/api/straddle-pnf/server-guard?scope=${scope}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chart: c, on: false }) }); } },
          });
        }
      } catch { /* the next poll retries */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, 3_000);
    return () => { dead = true; clearInterval(id); };
  }, [scope, broker, tradeMode]);
  const railFor = (c: ChartId) => {
    const rc = railCharts.find(x => x.chart === c);
    if (!rc) return undefined;
    const rows = resting.openFor(rc.targetKey);
    const byId = (id: string) => rows.find(r => r.id === id);
    const now = nowSec();
    return {
      position: positions[rc.targetKey] ?? null,
      armed: railArmed,
      lockable: tradeMode === 'REAL',
      instant: instant[c],
      onToggleInstant: () => setInstant(v => ({ ...v, [c]: !v[c] })),
      linesShown: linesShown[c],
      onToggleLines: () => { const next = !linesShown[c]; saveP(`${LINES_SHOWN_KEY}${c}`, next ? '1' : '0'); setLinesShown(v => ({ ...v, [c]: next })); },
      alignLeft: tagLeft[c],
      onToggleAlign: () => { const next = !tagLeft[c]; saveP(`${TAG_LEFT_KEY}${c}`, next ? '1' : '0'); setTagLeft(v => ({ ...v, [c]: next })); },
      onToggleArm: () => setRailUnlocked(v => !v),
      onPositionLots: (dir: 1 | -1) => { void adjustPosition(c, dir); },
      onCancelAll: () => { for (const r of rows) if (r.state === 'working') void resting.cancel(r); },
      orders: rows.map(r => ({
        id: r.id, side: r.side, kind: r.kind, level: r.level, price: r.price, trigger: r.trigger, lots: r.lots, state: r.state, mode: r.mode, role: r.role, trailPts: r.trailPts, bracket: r.bracket?.style,
        resolvable: needsResolve(r, now),
        // What a Bracket / Cover entry will get when it fills, drawn dimmed in the ladder (the exits themselves are created at the fill)
        ...(r.bracket && !r.group && r.state === 'working' ? (() => {
          const kids = planBracketChildren({ side: r.side, entry: r.kind === 'stop' ? r.trigger ?? r.level : r.price, tick: rc.tick, spec: r.bracket });
          return typeof kids === 'string' ? {} : { planned: kids.map(k => ({ role: k.role, level: k.level })) };
        })() : {}),
      })),
      onPlace: (side: 'BUY' | 'SELL', level: number) => {
        if (!railArmed) return;
        // An order against the open position reduces it: it never carries a bracket (the trade bar does the same).
        const pos = positions[rc.targetKey];
        const reduces = !!pos && pos.side !== 'MIXED' && (pos.side === 'LONG') === (side === 'SELL');
        const spec = reduces ? null : bracketSpecNow(c);
        if (typeof spec === 'string') { toast.error(spec); return; }            // Bracket / Cover not filled in: nothing is placed
        void resting.place(rc, side, level, spec);
      },
      onModify: (id: string, level: number) => { const r = byId(id); if (r) void resting.modify(r, level); },
      onCancel: (id: string) => { const r = byId(id); if (r) void resting.cancel(r); },
      onLots: (id: string, delta: number) => { const r = byId(id); if (r) void resting.changeLots(r, delta); },
      onPlannedMove: (id: string, role: 'sl' | 'target', level: number) => { const r = byId(id); if (r) void resting.movePlanned(r, role, level); },
    };
  };
  // AUTO runs on the dashboard server (lib/pnfAutoEngine.ts); these show what it does on each chart and ask it for a manual exit.
  const auto1 = usePnfAuto({ chart: 1, target: target1, model: c1.model, price: priceOf(feed1), ledger: autoLedger, engine: autoEngine, post: autoPost, onEvent: onAutoEvent, onDisarm: why => disarm(1, why), scope, nowMs: now });
  const auto2 = usePnfAuto({ chart: 2, target: target2, model: c2.model, price: priceOf(feed2), ledger: autoLedger, engine: autoEngine, post: autoPost, onEvent: onAutoEvent, onDisarm: why => disarm(2, why), scope, nowMs: now });
  const autoOf = (c: ChartId) => (c === 2 ? auto2 : auto1);
  /** The AUTO status line: the server engine's own, plus the brick it trades on when that differs from this chart's, and a feed problem. */
  const autoNote = (c: ChartId): string => {
    const a = autoOf(c);
    const hm = (t: number) => new Date((t + 19_800) * 1000).toISOString().slice(11, 16);
    const brick = a.serverBrick ? ` · SERVER SEES ${a.serverBrick.dir === 'X' ? '▲' : '▼'} brick @ ${hm(a.serverBrick.barT)} (box ${a.serverBrick.box.toFixed(2)}, ${a.serverBrick.n} bricks)` : '';
    return `${a.note}${brick}${a.feedError ? ` · server feed: ${a.feedError}` : ''}`;
  };
  /** When chart c's AUTO squares off today (HH:MM IST): its open row's own product and market, else the product picked for the next entry. */
  const eodText = (c: ChartId): string | null => {
    const row = autoOf(c).row;
    const feed = c === 2 ? feed2 : feed1;
    const tgt = c === 2 ? target2 : target1;
    const prod: AutoProduct = row ? autoProductOf(row.product) : tgt.kind === 'equity' ? 'INTRADAY' : autoProd[c];
    // The feed reads 'NSE' (a 15:30 close) until the history has loaded: no times until the chart's real market is known.
    if (!row && !feed.loaded) return null;
    const win = autoWindow(row ? rowMarket(row) : feed.market, now / 1000, prod);
    if (!win) return null;
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `${AUTO_PRODUCT_LABEL[prod]}: entries stop ${hm(win.entryCutoff)}, squared off ${hm(win.eodExit)}`;
  };
  // The saved AUTO switch (ledger `arms`) IS the switch: the dashboard server runs AUTO from it (lib/pnfAutoEngine.ts), with or without a tab.
  //  - a saving exists: the chart shows armed, with the rule, side, lots, adds and product it was armed with (restored once per arming);
  //  - armed here and the saving is gone or replaced (stopped in another tab, a halt, the server guard, the day rolled): shown off here too;
  //  - an open AUTO position on a chart that is not armed is said once: it exits by its rule on the server, nothing re-enters.
  const [resumeNote, setResumeNote] = useState<Record<ChartId, string | null>>({ 1: null, 2: null });
  const offWarnedRef = useRef<Set<string>>(new Set());
  const armRevRef = useRef<Record<ChartId, number>>({ 1: Infinity, 2: Infinity });
  /** armChart's bookkeeping (refs are only touched from callbacks, never during render). */
  const noteArmSaved = useCallback((c: ChartId, rev: number | undefined) => { armRevRef.current[c] = rev ?? Infinity; }, []);
  const row1 = auto1.row, row2 = auto2.row;
  /* eslint-disable react-hooks/set-state-in-effect -- the effect follows the saved switch: arming / disarming IS its job */
  useEffect(() => {
    if (!prefsReady || autoLedger.rev === 0) return;
    const notes: Record<ChartId, string | null> = { 1: null, 2: null };
    for (const c of [1, 2] as const) {
      const local = autoArm[c];
      const rec = autoLedger.arms?.[String(c) as '1' | '2'];
      const tgt = c === 2 ? target2 : target1;
      if (rec) {
        if (rec.run && targetKey(rec.run.target) !== targetKey(tgt)) notes[c] = `AUTO trades ${targetLabel(rec.run.target)} on the server - this chart shows another contract`;
        if (!local.on || local.armT !== rec.t) {
          if (local.on && local.armT === undefined) continue;        // this tab's own arming, its save still on the wire
          if (armDoneRef.current.has(rec.t)) continue;               // stopped here: the ledger has not caught up yet
          armRevRef.current[c] = autoLedger.rev;                     // a later ledger without it switches it off here
          if (renko && AUTO_RULES.includes(rec.rule as AutoRule)) { setAutoRule(a => ({ ...a, [c]: rec.rule as AutoRule })); saveP(`${AUTO_RULE_KEY}${c}`, rec.rule!); }
          if (AUTO_SIDES.includes(rec.side as AutoSide)) { setAutoSide(a => ({ ...a, [c]: rec.side as AutoSide })); saveP(`${AUTO_SIDE_KEY}${c}`, rec.side!); }
          setAutoLots(l => ({ ...l, [c]: rec.lots })); saveP(`${AUTO_LOTS_KEY}${c}`, String(rec.lots));
          if (renko) {
            const pyr: AutoPyramid = rec.pyramid ? { on: true, max: rec.pyramid.max, every: pyramidEveryOf(rec.pyramid.every), trailOn: rec.pyramid.trail !== 0, trail: rec.pyramid.trail || autoPyr[c].trail }   // trail absent: armed before the setting existed, so ON (its default)
              : { ...autoPyr[c], on: false };
            setAutoPyr(a => ({ ...a, [c]: pyr })); saveP(`${AUTO_PYR_KEY}${c}`, JSON.stringify(pyr));
          }
          const prod = autoProductOf(rec.product);
          setAutoProd(a => ({ ...a, [c]: prod })); saveP(`${AUTO_PROD_KEY}${c}`, prod);
          setAutoArm(a => ({ ...a, [c]: { on: true, mode: rec.mode, watermarkT: rec.watermarkT, armT: rec.t, product: prod } }));
        }
        continue;
      }
      if (local.on && local.armT !== undefined && autoLedger.rev >= armRevRef.current[c]) {
        armDoneRef.current.add(local.armT);
        setAutoArm(a => (a[c].on && a[c].armT === local.armT ? { ...a, [c]: DISARMED } : a));
        continue;
      }
      const row = c === 2 ? row2 : row1;
      if (row?.state === 'open' && !local.on && !offWarnedRef.current.has(row.id)) {
        offWarnedRef.current.add(row.id);
        toast.warning(`Chart ${c} holds an AUTO ${row.side} position but AUTO is OFF: the server exits it by its rule and does NOT re-enter. Arm AUTO to keep trading.`, { duration: 15_000 });
      }
    }
    setResumeNote(prev => (prev[1] === notes[1] && prev[2] === notes[2] ? prev : notes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLedger, autoArm, prefsReady, target1, target2, row1, row2]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // An open AUTO row is marked at the price of a chart showing its contract (null when neither chart does).
  // An index chart's AUTO row holds an OPTION: its premium is read here (the chart only has the index), for the row's P&L everywhere.
  const autoTraded1 = autoLedger.rows.find(r => r.chart === 1 && isLive(r) && r.traded)?.traded ?? null;
  const autoTraded2 = autoLedger.rows.find(r => r.chart === 2 && isLive(r) && r.traded)?.traded ?? null;
  const autoOpt1 = useTradedLive(autoTraded1?.ids ?? null), autoOpt2 = useTradedLive(autoTraded2?.ids ?? null);
  const autoPrice = (k: string) => (k === targetKey(target1) ? priceOf(feed1) : dual && k === targetKey(target2) ? priceOf(feed2)
    : autoTraded1 && k === autoTraded1.targetKey ? autoOpt1.ltp : autoTraded2 && k === autoTraded2.targetKey ? autoOpt2.ltp : null);
  // An AUTO position still open from an earlier day (a missed end-of-day exit, e.g. an NRML row carried overnight): AUTO never exits an earlier
  // day's row, so it is said loudly, once per row per page load, and stays on screen until dismissed.
  const staleWarnedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const r of autoLedger.rows) {
      if (!holdsPosition(r) || r.day === istToday() || staleWarnedRef.current.has(r.id)) continue;
      staleWarnedRef.current.add(r.id);
      toast.error(`AUTO chart ${r.chart} [${r.mode}${autoProductOf(r.product) === 'MARGIN' ? ' NRML' : ''}] ${r.side} ${r.lots}L from ${r.day} is STILL OPEN: its end-of-day exit was missed. Close it at the broker, then resolve it here.`, { duration: Infinity });
    }
  }, [autoLedger]);
  const autoToday = autoLedger.rows.filter(r => r.day === istToday());
  // Each chart's execution markers: manual trade-bar markers (this browser session) + AUTO trades from the ledger, or the practice
  // book's in a replay. Rebuilt on every page render (each 2.5 s ledger poll) but handed on by content, so an unchanged list keeps its
  // identity and the panels do not redraw their whole chart layer (100-300 ms on a long Renko chart) for nothing.
  const markersFor = (c: ChartId): PnfExecutionMarker[] => {
    const tk = targetKey(c === 2 ? target2 : target1);
    return replayT !== null
      ? book.trades.filter(x => x.targetKey === tk).map(x => ({ id: x.id, t: x.t, action: x.side, price: x.price, lots: x.lots, mode: 'PAPER' as const, estimate: false }))
      : [...(markers[tk] ?? []), ...autoMarkers(autoToday, tk).map(m => ({ ...m, estimate: m.mode === 'REAL' }))];
  };
  // the books' paper-trade list: only when the markers or the AUTO ledger change, not on every live tick
  const paperTrades = useMemo(
    () => buildPaperTrades({ ...storedMarkers, ...markers }, autoLedger.rows.filter(r => r.day === istToday()), istToday()),
    [storedMarkers, markers, autoLedger.rows],
  );
  const tm1Raw = markersFor(1), tm2Raw = markersFor(2);
  const tm1Key = JSON.stringify(tm1Raw), tm2Key = JSON.stringify(tm2Raw);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tradeMarkers1 = useMemo(() => tm1Raw, [tm1Key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tradeMarkers2 = useMemo(() => tm2Raw, [tm2Key]);
  const autoPaper = autoDaySummary(autoToday, istToday(), 'PAPER', autoPrice);
  // Signals depend on the instrument and the box settings: while a chart is armed or holds an AUTO position, they are frozen.
  const locked = (c: ChartId) => autoArm[c].on || !!autoOf(c).row;
  const activeLocked = locked(active);
  // Replay draws the past on the charts; a chart running live AUTO must keep showing what AUTO trades on, so it is stopped first.
  const toggleReplay = () => {
    if (replay.active) { replay.close(); return; }
    const busy = ([1, 2] as const).filter(c => (c === 1 || dual) && locked(c));
    if (busy.length) { toast.warning(`Chart ${busy.join(' and ')} is running AUTO: stop it (and let its position close) before replaying`); return; }
    replay.open();
  };
  const armChart = useCallback((c: ChartId, on: boolean) => {
    // The MTM guard is the user's choice: arming AUTO leaves it as it is (OFF unless switched on from the MTM Guard card, whose levels start
    // at 10 boxes / 10 boxes). Said once, because the Supertrend / N-brick rules have no stop of their own.
    if (on && autoSide[c] !== 'both') toast.info(`AUTO armed on chart ${c}: ${SIDE_LABEL[autoSide[c]].toUpperCase()} - signals for the other side are ignored (open positions still exit normally).`, { duration: 8_000 });
    // Tick mode: every brick the live price prints is a closed bar, so AUTO enters, exits and adds within a second or two of it.
    if (on && (c === 2 ? tick2 : tick1)) toast.warning(`AUTO armed on a ${c === 2 ? tickName2 : tickName1} chart ${c}: it acts on bricks within seconds of the live price (not at a 1-minute close) - expect more trades and whipsaws than on a minute chart.`, { duration: 12_000 });
    if (on && tradeMode === 'REAL' && !guards.guardOf(c).on) toast.info(`AUTO armed on chart ${c} with the MTM guard OFF - switch it on from the MTM Guard card if you want a profit target / stop-loss.`, { duration: 10_000 });
    if (!on) { disarm(c, 'stopped by the user'); return; }
    const m = (c === 2 ? c2 : c1).model;
    const t = nowSec();
    const watermarkT = m.lastBarT ?? Math.floor(t);
    const tgt = c === 2 ? target2 : target1;
    const product: AutoProduct = tgt.kind === 'equity' ? 'INTRADAY' : autoProd[c];      // a stock is MIS only
    const cm = c === 2 ? c2 : c1, feed = c === 2 ? feed2 : feed1;
    if (!feed.complete || cm.model.lastBarT === null) { toast.warning(`Chart ${c} has not loaded yet - arm AUTO once its chart is drawn`); return; }
    if (autoOf(c).quiet) toast.error(`The dashboard's AUTO engine is not running - AUTO on chart ${c} will not trade until the server is up`, { duration: 15_000 });
    setAutoArm(a => ({ ...a, [c]: { on: true, mode: tradeMode, watermarkT, armedAtS: t, product } }));       // armed at once; `armT` once the ledger has saved it
    // The chart the SERVER builds and trades (lib/pnfAutoLedger.ts ArmRun): this chart's contract and settings (locked while armed) and the
    // times its box is measured from, so the server's bricks are the ones on screen.
    // A Renko INDEX chart trades the CE / PE of its map: the map is frozen with the arming (the server picks the strike at each entry).
    const indexArm = renko && tgt.kind === 'index';
    if (indexArm && autoPyr[c].on) toast.info(`Chart ${c} is an index chart: AUTO trades its option map without pyramid adds`, { duration: 8_000 });
    const run = {
      target: tgt, settings: c === 2 ? settings2 : settings, volume: !cm.indexNoVwap,
      ...(feed.loaded?.anchorT ? { anchorT: feed.loaded.anchorT } : {}), ...(cm.boxBaseT ? { boxBaseT: cm.boxBaseT } : {}),
      ...(indexArm ? { indexMap: indexMap[c] } : {}),
    };
    const rec = {
      run,
      mode: tradeMode, broker, targetKey: targetKey(tgt), day: istToday(), t, watermarkT, lots: autoLots[c],
      side: autoSide[c], ...(renko ? { rule: autoRule[c] } : {}),
      ...(renko && !indexArm && autoPyr[c].on && autoPyr[c].max > autoLots[c] ? { pyramid: { max: autoPyr[c].max, ...(autoPyr[c].every > 1 ? { every: autoPyr[c].every } : {}), trail: autoPyr[c].trailOn ? autoPyr[c].trail : 0 } } : {}),
      ...(product === 'MARGIN' ? { product: 'MARGIN' as const } : {}),
    };
    const pyrText = (rec.pyramid ? `, +1L/${rec.pyramid.every ? `${rec.pyramid.every} bricks` : 'brick'} to ${rec.pyramid.max}L${rec.pyramid.trail ? `, trail ${rec.pyramid.trail} bx` : ''}` : '') + (product === 'MARGIN' ? ', NRML' : '');
    if (renko && autoPyr[c].on && !rec.pyramid) toast.warning(`Chart ${c}: adds are on but Max (${autoPyr[c].max}) is not above the base lots (${autoLots[c]}) - no lots will be added`, { duration: 10_000 });
    const mapText = indexArm ? `, bull ${legText(indexMap[c].bull)} / bear ${legText(indexMap[c].bear)}` : '';
    void autoPost({ op: 'setArm', chart: c, arm: rec, t, text: `AUTO armed (${tradeMode}, ${autoLots[c]} lot${autoSide[c] !== 'both' ? `, ${SIDE_LABEL[autoSide[c]]}` : ''}${pyrText}${mapText})` }).then(r => {
      if (r.ok) {
        noteArmSaved(c, r.ledger?.rev);
        setAutoArm(a => (a[c].on && a[c].watermarkT === watermarkT && a[c].armT === undefined ? { ...a, [c]: { ...a[c], armT: t } } : a));
      } else {
        // AUTO runs on the server from the saved arming: an arming that was not saved trades nothing.
        setAutoArm(a => (a[c].on && a[c].watermarkT === watermarkT && a[c].armT === undefined ? { ...a, [c]: DISARMED } : a));
        toast.error(`AUTO on chart ${c} was NOT armed: it could not be saved (${r.error ?? 'no reply'})`, { duration: 15_000 });
      }
    });
    // autoOf reads auto1 / auto2 of this render (their `quiet` flag only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSide, autoLots, autoRule, autoPyr, autoProd, tradeMode, guards, disarm, c1, c2, feed1, feed2, settings, settings2, noteArmSaved, broker, target1, target2, renko, autoPost, tick1, tick2, tickName1, tickName2, indexMap]);
  const setLotsFor = (c: ChartId, n: number) => { setAutoLots(l => ({ ...l, [c]: n })); saveP(`${AUTO_LOTS_KEY}${c}`, String(n)); };
  // The page mode is the mode new AUTO armings trade in: switching it disarms the charts armed in the OTHER mode (arming REAL is always an
  // explicit step). A REAL arming the server runs is left alone when the page (which always loads in PAPER) is switched to REAL.
  const changeTradeMode = (m: 'PAPER' | 'REAL') => {
    if (m === tradeMode) return;
    if (m === 'REAL' && !window.confirm('Switch to REAL?\n\nOrders from the trade bar, the chart rail and AUTO will go to your broker with real money. The rail stays locked until you unlock it, and every page load starts in PAPER.')) return;
    for (const c of [1, 2] as const) if (autoArm[c].on && autoArm[c].mode !== m) disarm(c, `the page switched to ${m}`);
    setRailUnlocked(false);
    setScalperUnlockKey(null);
    setInstant({ 1: false, 2: false });
    setTradeMode(m);
  };
  // Arrives seconds after the order: found by id in the store as it is THEN (never a list captured at the click).
  const handleMarkerPrice = useCallback((id: string, price: number) => {
    setMarkers(prev => {
      let next = prev;
      for (const [key, list] of Object.entries(prev)) {
        if (!list.some(m => m.id === id)) continue;
        const updated = list.map(m => (m.id === id ? { ...m, price, estimate: false } : m));
        try { localStorage.setItem(`${markersPrefix}${key}`, encodeMarkers(istToday(), updated)); } catch { /* ignore */ }
        next = { ...next, [key]: updated };
      }
      return next;
    });
  }, [markersPrefix]);

  // ── picking: every control acts on the active chart ──────────────────────
  const choose = (next: Target) => {
    const c = active;
    if (locked(c)) { toast.warning(`Chart ${c} is running AUTO: stop it (and let its position close) to change the instrument`); return; }
    const picks = picksRef.current[c];
    picksRef.current = { ...picksRef.current, [c]: { targets: { ...picks.targets, [next.kind]: next }, open: next.kind } };
    saveP(c === 1 ? TARGETS_KEY : TARGETS_KEY_2, JSON.stringify(picksRef.current[c].targets));
    saveP(c === 1 ? SEGMENT_KEY : SEGMENT_KEY_2, next.kind);
    (c === 1 ? setTarget1 : setTarget2)(t => (targetKey(t) === targetKey(next) ? t : next));
  };
  const pickSegment = (s: Segment) => { if (s !== activeTarget.kind) choose(picksRef.current[active].targets[s]); };
  const activate = (c: ChartId) => { setActiveChart(c); saveP(ACTIVE_CHART_KEY, String(c)); };
  // Picking VWAP or SMA also shows the line again; the eye button hides / shows it without changing the choice.
  const pickOverlay = (o: Overlay) => { setOverlay(o); saveP(OVERLAY_KEY, o); setOverlayShown(true); saveP(OVERLAY_SHOWN_KEY, '1'); };
  const toggleCoverShown = () => { const next = !coverShown; setCoverShown(next); saveP(COVER_SHOWN_KEY, next ? '1' : '0'); };
  const toggleSupertrendShown = () => { const next = !supertrendShown; setSupertrendShown(next); saveP(ST_SHOWN_KEY, next ? '1' : '0'); };
  const toggleOverlayShown = () => { const next = !overlayShown; setOverlayShown(next); saveP(OVERLAY_SHOWN_KEY, next ? '1' : '0'); };
  const applySettings = (next: PnfSettings) => {
    if (active === 2) { setSettings2(next); saveP(SETTINGS_KEY_2, serializeSettings(next)); }
    else { setSettings(next); saveP(SETTINGS_KEY, serializeSettings(next)); }
  };
  const toggleChartView = (v: '1' | '2') => {
    if (v === '1' && locked(2)) { toast.warning('Chart 2 is running AUTO: stop it (and let its position close) before hiding it'); return; }
    setChartView(v);
    saveP(CHART_VIEW_KEY, v);
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    saveP(SOUND_KEY, next ? '0' : '1');
  };
  const changeBooksOpen = (next: boolean) => {
    setBooksOpen(next);
    saveP(BOOKS_OPEN_KEY, next ? '1' : '0');
  };
  const toggleTradeOpen = () => {
    setTradeOpen(prev => {
      const next = !prev;
      saveP(TRADE_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  };

  // Order Style (Single / Bracket / Cover) and MTM guard: in the trade bar's row while it is shown, else a row of its own above the
  // charts (the chart rail still places orders with it). Never floated over the charts, where it hid their header lines.
  const tradeBarShown = tradeOpen && !replay.active;
  // Renko index chart -> options (lib/pnfIndexMap.ts): the index gives the direction, the map's CE / PE is traded. The held option is
  // the server's REAL ledger (or page memory in PAPER), so Close / Reverse act on the contract actually opened, not the map's pick now.
  const indexTradable = renko && activeTarget.kind === 'index';
  const indexHeld = useIndexHeld({ enabled: indexTradable, scope, chart: active, indexKey: targetKey(activeTarget), broker, mode: tradeMode });
  const tradedLive = useTradedLive(indexHeld.held?.ids ?? null);
  const changeIndexMap = (c: ChartId, m: IndexMap) => { setIndexMap(v => ({ ...v, [c]: m })); saveP(`${INDEX_MAP_KEY}${c}`, JSON.stringify(m)); };
  const activeMap = indexMap[active];
  const indexSideHints = indexTradable ? { BUY: legShort(activeMap.bull), SELL: legShort(activeMap.bear) } : undefined;
  const indexSideTitles = indexTradable ? { BUY: legText(activeMap.bull), SELL: legText(activeMap.bear) } : undefined;
  /** No rail on an index chart yet, so no page-held exits: Bracket / Cover are off there (the bar shows Single). */
  const INDEX_NO_BRACKETS = 'No Bracket / Cover on an index chart yet: no rail holds the exits for the option it trades. Exit by hand, or chart the option itself.';
  // ONE order engine for the trade bar and the Scalper window: the same position, the same lots.
  const trade = usePnfTrade({
    target: activeTarget,
    live: activeFeed.live,
    broker,
    mode: tradeMode,
    onPnlChange: setPaperPnl,
    onTradeExecuted: handleTradeExecuted,
    onMarkerPrice: handleMarkerPrice,
    onSound: (outcome, close) => chime({ kind: 'manual', outcome, close }),
    paper,
    setPaper,
    onSizing,
    bracketSpec: indexTradable ? () => null : bracketSpecNow,
    onEntered: e => {
      const rc = railCharts.find(x => x.chart === active);
      if (rc) void resting.armBracket({ chart: rc.chart, target: rc.target, targetKey: rc.targetKey, side: e.action, lots: e.lots, mode: e.mode, product: e.product, bracket: e.spec }, e.price);
    },
    onSquaredOff: () => { const rc = railCharts.find(x => x.chart === active); if (rc) void resting.cancelBracketsFor(rc.targetKey); },
    scope,
    index: indexTradable ? {
      chart: active, map: activeMap, held: indexHeld.held, heldLoading: indexHeld.loading, heldError: indexHeld.error, ops: indexHeld.ops,
      tradedLtp: tradedLive.ltp,
    } : undefined,
  });
  const indexMapSlot = indexTradable ? (
    <IndexMapControls symbol={activeTarget.symbol} map={activeMap} onChange={m => changeIndexMap(active, m)}
                      spot={activeFeed.live ? activeFeed.live.ce + activeFeed.live.pe : null} held={indexHeld.held}
                      disabled={locked(active)}
                      ownLots={trade.ownLots} mismatch={trade.heldMismatch} onForget={trade.forgetHeld}
                      onSettle={as => { const h = indexHeld.held; if (h) void indexHeld.ops.resolve(h.id, as); }} />
  ) : null;
  const scalperShown = renko && scalperOpen && !replay.active && (activeTarget.kind !== 'index' || indexTradable);
  const scalperKey = `${active}|${targetKey(activeTarget)}|${tradeMode}`;
  const toggleScalper = () => {
    const next = !scalperOpen;
    setScalperOpen(next);
    saveP(SCALPER_OPEN_KEY, next ? '1' : '0');
    if (!next) setScalperUnlockKey(null);
  };
  const styleBar = (
    <PnfOrderStyle
      value={orderStyle} onChange={changeStyle} boxPts={activeChartModel.model.box} bracketsOff={indexTradable ? INDEX_NO_BRACKETS : undefined}
      guardOn={[1, 2].some(n => guards.guardOf(n).on)}
      serverGuards={serverGuards.map(({ chart: c, view }) => ({
        chart: c, mine: view.broker === broker && view.mode === tradeMode,
        text: `C${c}${view.broker === broker && view.mode === tradeMode ? '' : ` ${view.broker} ${view.mode}`} ${guardLevelsText(view.levels)}`,
      }))}
      guard={(() => {
        const rc = railCharts.find(x => x.chart === active);
        if (!rc) return undefined;
        const gc = { chart: rc.chart, targetKey: rc.targetKey };
        return { broker: broker, real: tradeMode === 'REAL', chart: rc.chart, chartLabel: `Chart ${rc.chart} · ${rc.target.symbol}`, mtm: guards.mtmOf(gc), rupeesPerBox: boxRupees(rc.chart), guard: guards.guardOf(rc.chart), post: guards.post(gc) };
      })()}
    />
  );
  const today = istToday();
  const seg = (active: boolean) =>
    `px-2.5 h-6 text-[11px] font-bold rounded-md transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-100'}`;
  const segLabel = SEGMENTS.find(x => x.id === activeTarget.kind)?.label ?? '';
  const activeFno = activeTarget.kind === 'futures' || activeTarget.kind === 'options';
  const shownOverlay: Overlay = activeChartModel.vwapAllowed ? overlay : 'sma';
  const boxShort = (s: PnfSettings) => boxText(s).replace(/ box$/, '');
  const loadErrors = [feed1.loadError && (dual ? `Chart 1: ${feed1.loadError}` : feed1.loadError), dual && feed2.loadError && `Chart 2: ${feed2.loadError}`].filter(Boolean);
  const chartProps = (c: ChartId) => {
    const feed = c === 2 ? feed2 : feed1;
    const target = c === 2 ? target2 : target1;
    const st = c === 2 ? settings2 : settings;
    // Replaying: the chart, its price, markers, rail and AUTO are the practice session's; nothing live is drawn on it.
    const rp = replayT !== null;
    const rbar = (c === 2 ? r2 : r1).lastBar;
    const pAuto = book.auto[c];
    return {
      model: shownOf(c).model,
      live: rp ? (rbar ? { ce: rbar.ce, pe: rbar.pe } : null) : feed.live,
      overlay,
      overlayShown,
      supertrendShown: renko && supertrendShown,
      coverShown,
      stale: rp ? false : feed.stale,
      legs: target.kind === 'options' && target.side === 'STRADDLE',
      flash: rp ? null : flash[c],
      loading: (feed.loading || !feed.complete) && feed.bars.length === 0,
      interval: effectiveInterval(st.interval, hasLongIntervals(target.kind), renko),
      // the bar-close countdown under the live price; none in a replay (its bars are not on the clock) or on an NSE weekend / holiday
      session: rp || !now ? null : tradingSession(feed.market, now / 1000),
      boxPct: st.boxPct,
      reversal: st.reversal,
      resetTick: viewTick,
      headerSlot: active === c ? headerSlot : null,
      showHeader: dual,
      scrip: dual ? `${feed.scrip} (${boxText(st)})` : feed.scrip,
      feedPrevClose: rp ? null : feed.trustedPrevClose,
      sessionTag: rp ? `Replay · ${crosshairStamp(replayT)}` : replay.picking ? 'Replay · pick a bar' : feed.sessionTag,
      replayPick: replay.picking ? (t: number) => startReplayAt(c, t) : undefined,
      replayStartT: rp ? replay.startT : null,
      // Every instrument gets TradingView's bottom time axis and crosshair date chip, so no top date strip or dashed date lines.
      sessionLines: false,
      timeAxis: true,
      sessionDividers: target.kind !== 'equity' && target.kind !== 'index',
      // Manual trade-bar markers (this browser session) + AUTO trades from the ledger, on their signal / reversal bars.
      tradeMarkers: c === 2 ? tradeMarkers2 : tradeMarkers1,
      error: feed.loaded?.error ?? (feed.complete ? undefined : contractError[c] ?? undefined),
      active: active === c,
      onActivate: dual ? () => activate(c) : undefined,
      markersShown: markersShown[c],
      triangles: rp ? (c === 2 ? rtri2 : rtri1) : c === 2 ? tri2 : tri1,
      triShown: triShown[c],
      triMin: triMin[c],
      onToggleTri: renko ? undefined : () => { const next = !triShown[c]; saveP(`${TRI_SHOW_KEY}${c}`, next ? '1' : '0'); setTriShown(v => ({ ...v, [c]: next })); },
      onCycleTriMin: renko ? undefined : () => { const next = triMin[c] >= 6 ? 3 : triMin[c] + 1; saveP(`${TRI_MIN_KEY}${c}`, String(next)); setTriMin(v => ({ ...v, [c]: next })); },
      pivotsShown: pivShown[c],
      pivotStrength: pivK[c],
      onTogglePivots: renko ? () => { const next = !pivShown[c]; saveP(`${PIV_SHOW_KEY}${c}`, next ? '1' : '0'); setPivShown(v => ({ ...v, [c]: next })); } : undefined,
      onCyclePivotStrength: renko ? () => { const next = pivK[c] >= 3 ? 1 : pivK[c] + 1; saveP(`${PIV_K_KEY}${c}`, String(next)); setPivK(v => ({ ...v, [c]: next })); } : undefined,
      rail: rp ? practiceRailFor(c) : railFor(c),
      onToggleMarkers: () => {
        const next = !markersShown[c];
        saveP(`${MARKERS_SHOWN_KEY}${c}`, next ? '1' : '0');
        setMarkersShown(m => ({ ...m, [c]: next }));
      },
      autoSlot: rp ? (
        // Practice AUTO: the live engine's rules on the replayed chart, filled in the practice book
        <button type="button" data-testid={`pnf-practice-auto-${c}`} aria-pressed={!!pAuto?.on} disabled={target.kind === 'index'}
                onClick={() => setBook(b => practiceAutoArm(b, c, !b.auto[c]?.on, replayT, autoLots[c]))}
                title={target.kind === 'index' ? 'No AUTO on an index' : 'Practice AUTO on the replayed chart: same rules as live AUTO, filled in the practice book'}
                className={`inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[10px] font-bold uppercase tracking-wider disabled:opacity-40 ${pAuto?.on ? 'border-sky-500/50 bg-sky-500/15 text-sky-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100'}`}>
          <Bot className="w-3 h-3" aria-hidden="true" />{pAuto?.on ? 'Practice AUTO on' : 'Practice AUTO'}
          {pAuto?.position && <span className={pAuto.position.side === 'BUY' ? 'text-emerald-300' : 'text-red-300'}>{pAuto.position.side === 'BUY' ? 'LONG' : 'SHORT'}</span>}
        </button>
      ) : (
        <AutoControls chart={c} armed={autoArm[c].on} mode={tradeMode} lots={autoLots[c]} onLots={n => setLotsFor(c, n)}
                      // eslint-disable-next-line react-hooks/refs -- armChart's refs are touched only when the button is clicked, never during render
                      onArm={on => armChart(c, on)} row={autoOf(c).row}
                      price={autoOf(c).row?.traded ? autoPrice(autoOf(c).row!.traded!.targetKey) : priceOf(feed)} note={autoNote(c)} trailSl={autoOf(c).trailSl} halt={autoOf(c).halt}
                      onResolve={autoOf(c).resolve} onExit={() => { void autoOf(c).exitNow(); }} nowMs={now} resumeNote={resumeNote[c]}
                      autoSide={autoSide[c]} onAutoSide={sd => { setAutoSide(a => ({ ...a, [c]: sd })); saveP(`${AUTO_SIDE_KEY}${c}`, sd); }}
                      pyramid={renko && target.kind !== 'index' ? autoPyr[c] : undefined}
                      product={target.kind === 'equity' ? undefined : autoProd[c]}
                      onProduct={target.kind === 'equity' ? undefined : p => { setAutoProd(a => ({ ...a, [c]: p })); saveP(`${AUTO_PROD_KEY}${c}`, p); }}
                      eodText={eodText(c)}
                      onPyramid={renko ? p => { setAutoPyr(a => ({ ...a, [c]: p })); saveP(`${AUTO_PYR_KEY}${c}`, JSON.stringify(p)); } : undefined}
                      autoRule={renko ? autoRule[c] : undefined} onAutoRule={renko ? r => { setAutoRule(a => ({ ...a, [c]: r })); saveP(`${AUTO_RULE_KEY}${c}`, r); } : undefined}
                      rule={renko ? ruleText(autoRule[c], (c === 2 ? settings2 : settings).reversal) : undefined}
                      disabledReason={target.kind === 'index' && !renko ? 'No AUTO on an index: chart its future or an option'
                        : replay.active ? 'Bar replay is open: close it to arm live AUTO'
                        : null} />
      ),
    };
  };

  // Row 3's chart settings: built from the values it shows, with stable handlers, so a live tick (which re-renders this page every
  // second) does not rebuild the toolbar and its tooltips. Every value read below must be in the deps list.
  const h = useStableHandlers({
    toggleChartView, activate, applySettings, pickOverlay, toggleOverlayShown, toggleCoverShown, toggleSupertrendShown, cancelEveryOrder,
    toggleReplay, recenterNow, toggleLog: () => setLogOpen(o => !o), toggleMute, toggleTradeOpen, toggleScalper,
  });
  const label1 = feed1.label, label2 = feed2.label;
  const vwapAllowed = activeChartModel.vwapAllowed, indexNoVwap = activeChartModel.indexNoVwap;
  const stLocked = activeLocked && (autoRule[active] === 'supertrend' || autoOf(active).row?.exitBy === 'supertrend');
  const workingCount = workingRows.length, logCount = log.length;
  const longIntervals = hasLongIntervals(activeTarget.kind);
  const settingsBar = useMemo(() => (
    <>
            {/* 1 Chart vs 2 Charts view toggle */}
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Chart view">
              <button
                type="button"
                aria-label="1 Chart View"
                title="Single chart view"
                aria-pressed={chartView === '1'}
                onClick={() => h.toggleChartView('1')}
                className={seg(chartView === '1')}
              >
                1
              </button>
              <button
                type="button"
                aria-label="2 Charts View"
                title={renko ? 'Dual chart view' : 'Dual chart view (0.1% & 1%)'}
                aria-pressed={chartView === '2'}
                onClick={() => h.toggleChartView('2')}
                className={seg(chartView === '2')}
              >
                2
              </button>
            </div>
            <span className="w-px h-5 bg-zinc-800 shrink-0" />

            {/* Two charts: which one the instrument bar, the settings and the trade bar act on (clicking a chart does the same) */}
            {dual && (
              <>
                <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Active chart">
                  {([1, 2] as const).map(c => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={active === c}
                      aria-label={`Chart ${c} (${boxShort(c === 2 ? settings2 : settings)})`}
                      title={`Chart ${c}: ${(c === 2 ? label2 : label1)} · ${boxText(c === 2 ? settings2 : settings)}`}
                      onClick={() => h.activate(c)}
                      className={`px-2 h-6 rounded text-[11px] font-bold transition-colors ${active === c ? 'bg-amber-500/15 text-amber-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                    >
                      C{c} · {boxShort(c === 2 ? settings2 : settings)}
                    </button>
                  ))}
                </div>
                <span className="w-px h-5 bg-zinc-800 shrink-0" />
              </>
            )}

            <fieldset disabled={activeLocked} className="contents"><SettingsControls settings={activeSettings} onChange={h.applySettings} equity={longIntervals} renko={renko} /></fieldset>
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Overlay">
              {/* An index has no traded volume, so no VWAP: the button is disabled and the SMA is drawn (the saved choice is kept for
                  stocks, futures and options). */}
              <button type="button" aria-pressed={overlayShown && shownOverlay === 'vwap'} onClick={() => h.pickOverlay('vwap')} disabled={!vwapAllowed}
                      title={vwapAllowed ? undefined : indexNoVwap
                        ? `An index has no traded volume, so there is no VWAP: the SMA of the ${renko ? 'brick closes' : 'P&F boxes'} is used`
                        : `These bars carry no volume, so there is no VWAP: the SMA of the ${renko ? 'brick closes' : 'P&F boxes'} is used`}
                      className={`${seg(overlayShown && shownOverlay === 'vwap')} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400`}>VWAP</button>
              <button type="button" aria-pressed={overlayShown && shownOverlay === 'sma'} onClick={() => h.pickOverlay('sma')} className={seg(overlayShown && shownOverlay === 'sma')}>SMA {activeSettings.smaPeriod}</button>
              <button type="button" aria-pressed={!overlayShown} aria-label={overlayShown ? 'Hide the VWAP / SMA line' : 'Show the VWAP / SMA line'} title={overlayShown ? 'Hide the VWAP / SMA line' : 'Show the VWAP / SMA line'}
                      onClick={h.toggleOverlayShown} className={`${seg(!overlayShown)} inline-flex items-center`}>
                {overlayShown ? <Eye className="w-3.5 h-3.5" aria-hidden="true" /> : <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />}
              </button>
              {!renko && <button type="button" aria-pressed={coverShown} aria-label={coverShown ? 'Hide the COVER tag' : 'Show the COVER tag'}
                      title="COVER tag: where an X column first trades above the VWAP / SMA (a hint for covering a short; nothing trades on it)"
                      onClick={h.toggleCoverShown} className={`${seg(coverShown)} inline-flex items-center`}>
                <Flag className="w-3.5 h-3.5" aria-hidden="true" />
              </button>}
            </div>
            <fieldset disabled={activeLocked} className="contents"><SmaPeriodInput settings={activeSettings} onChange={h.applySettings} /></fieldset>
            {renko && (
              <>
                <span className="w-px h-5 bg-zinc-800 shrink-0" />
                {/* Outside the general AUTO lock (the line is only drawn for the other rules), but locked while AUTO trades it: armed with the
                    Supertrend rule, or holding a Supertrend position (the row remembers it across a reload). */}
                <SupertrendControls settings={activeSettings} onChange={h.applySettings}
                                    locked={stLocked}
                                    shown={supertrendShown} onToggleShown={h.toggleSupertrendShown} />
              </>
            )}
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <button type="button" data-testid="pnf-cancel-every-order" onClick={h.cancelEveryOrder} disabled={workingCount === 0}
                    aria-label={`Cancel all orders (${workingCount} working)`} title={workingCount ? `Cancel all ${workingCount} working orders on every chart` : 'No working orders'}
                    className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-200 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60">
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
              Cancel all orders{workingCount ? ` (${workingCount})` : ''}
            </button>
            <IconButton icon={Rewind} label={replay.active ? 'Close bar replay' : 'Bar replay'} onClick={h.toggleReplay} pressed={replay.active} />
            <IconButton icon={LocateFixed} label="Re-center" onClick={h.recenterNow} />
            <IconButton icon={Bell} label="Alert log" onClick={h.toggleLog} pressed={logOpen} badge={logCount} />
            <IconButton icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute alert sound' : 'Mute alert sound'} onClick={h.toggleMute} pressed={muted} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <IconButton icon={Zap} label={tradeOpen ? 'Hide trade desk' : 'Show trade desk'} onClick={h.toggleTradeOpen} pressed={tradeOpen} />
            {renko && !replay.active && (

              <IconButton icon={Crosshair} label={scalperOpen ? 'Close scalper' : 'Scalper'} onClick={h.toggleScalper} pressed={scalperOpen} />
            )}
    </>
  // seg / boxShort are pure helpers rebuilt every render; h is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [chartView, renko, dual, active, settings, settings2, label1, label2, activeLocked, activeSettings, longIntervals, overlayShown, shownOverlay,
      vwapAllowed, indexNoVwap, coverShown, stLocked, supertrendShown, workingCount, replay.active, logOpen, logCount, muted, tradeOpen,
      scalperOpen, activeTarget.kind]);

  return (
    <div className={`flex flex-col h-screen bg-zinc-950 text-white ${tradeMode === 'REAL' ? 'border-t-4 border-red-500' : ''}`} data-trade-mode={tradeMode}>
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        {/* row 1: identity, data date and navigation. */}
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 pt-3 pb-2">
          <div className="flex items-center gap-3 shrink-0 min-w-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
              {renko ? <Boxes className="w-4 h-4 text-emerald-400" aria-hidden="true" /> : <ChartScatter className="w-4 h-4 text-emerald-400" aria-hidden="true" />}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Scalping · {segLabel}</p>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none flex items-center gap-2">
                {renko ? 'Renko' : <>Point &amp; Figure</>}
                {tradeMode === 'REAL' && <span data-testid="pnf-real-banner" className="px-1.5 py-0.5 rounded bg-red-600 text-oncolor text-[11px] font-bold tracking-wide">LIVE · REAL MONEY</span>}
              </h1>
              <p className="text-[10px] text-zinc-500 font-medium mt-1 truncate">
                {`${dual ? `Chart ${active} · ` : ''}${intervalLabel(effectiveInterval(activeSettings.interval, hasLongIntervals(activeTarget.kind), renko))} · ${boxText(activeSettings)} · ${renko ? `confirm ${activeSettings.reversal} brick${activeSettings.reversal === 1 ? '' : 's'}` : `${activeSettings.reversal}-box reversal`} · ${activeFno ? activeFeed.label : activeFeed.name ?? activeTarget.name}`}
              </p>
            </div>
          </div>
          {/* Nifty and India VIX vs the previous close: market context, beside the data date on a wide screen. */}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {wideHeader && <><HeaderIndexChips /><span className="w-px h-5 bg-zinc-800 shrink-0" /></>}
            <HeaderClock />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <DataChip date={activeFeed.loaded?.dataDate} lastSession={Boolean(activeFeed.loaded?.dataDate) && activeFeed.loaded?.dataDate !== today} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <NavBar />
          </div>
        </div>

        {/* row 2: WHAT the active chart shows (left) and the market / account it trades on (right), at every width. */}
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 pb-2.5">
          {/* Remounted per chart, so one chart's contract lists never show on the other. */}
          <fieldset disabled={activeLocked} className="contents" title={activeLocked ? `Chart ${active} is running AUTO` : undefined}>
            <InstrumentBar key={active} target={activeTarget} onSegment={pickSegment} onPick={choose}
                           onError={msg => setContractError(e => (e[active] === msg ? e : { ...e, [active]: msg }))} />
          </fieldset>
          {/* The account the trade bar and AUTO trade on (and, on a narrower screen, the Nifty / VIX chips). */}
          <div className="ml-auto shrink-0 flex items-center gap-2">
            {!wideHeader && <><HeaderIndexChips /><span className="w-px h-5 bg-zinc-800 shrink-0" /></>}
            <BrokerPicker value={broker} onChange={setBroker} brokers={BROKERS} />
            <HeaderPnlMargin broker={broker} mode={tradeMode} paperPnl={paperPnl + autoPaper.total} prices={headerPrices}
                             paperNote={autoToday.some(r => r.mode === 'PAPER') ? `trade bar ${Math.round(paperPnl)} + AUTO ${Math.round(autoPaper.total)} (booked ${Math.round(autoPaper.realised)}, open ${Math.round(autoPaper.unrealised)})` : undefined} />
          </div>
        </div>

        {/* row 3: the live price strip, then how the chart is drawn. The strip claims at least 560px and clips what does not fit, so
            on a narrow screen the settings move to the next line instead of sliding over the price. */}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap px-6 py-2 border-t border-zinc-800 bg-zinc-900/40">
          <div ref={setHeaderSlot} data-testid="pnf-header-summary" className="flex items-center grow basis-[560px] min-w-0 overflow-hidden" />
          <div className="flex items-center gap-2 flex-wrap ml-auto" role="group" aria-label="Chart settings">
            {settingsBar}
          </div>
        </div>
      </header>

      {/* interactive 1-click execution trade bar */}
      {tradeBarShown && (
        <div className="shrink-0">
          <PnfTradeBar
            trade={trade}
            styleSlot={styleBar}
            target={activeTarget}
            broker={broker}
            mode={tradeMode}
            onModeChange={changeTradeMode}
            onSwitchTarget={choose}
            tradesLabel={dual ? `C${active} · ${activeFeed.label}` : undefined}
            indexSlot={indexMapSlot}
            sideHints={indexSideHints}
            sideTitles={indexSideTitles}
          />
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex flex-col gap-3 px-4 pt-2 pb-2">
        {loadErrors.map(e => <p key={e as string} role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{e}</p>)}
        {logOpen && <div className="absolute right-4 top-2 z-40 w-96 shadow-xl"><AlertLog entries={log} interval={effectiveInterval(activeSettings.interval, hasLongIntervals(activeTarget.kind), renko)} renko={renko} /></div>}
        {!tradeBarShown && <div className="shrink-0 self-center px-2 py-1 rounded-lg border border-zinc-800 bg-zinc-900">{styleBar}</div>}
        <div
          className={`flex-1 min-h-0 grid gap-3 ${dual ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}
          style={{ gridTemplateRows: 'minmax(0, 1fr)' }}
        >
          <PnfPanel
            title={dual ? `C1 · ${feed1.label} · ${boxText(settings)}` : `${feed1.label} · ${boxText(settings)}`}
            strike={feed1.loaded?.key ?? 0}
            fill
            {...chartProps(1)}
          />
          {dual && (
            <PnfPanel
              title={`C2 · ${feed2.label} · ${boxText(settings2)}`}
              strike={feed2.loaded?.key ? -feed2.loaded.key : -1}
              fill
              {...chartProps(2)}
            />
          )}
        </div>
      </div>
      {replay.active && (() => {
        const q = quoteOf(active);
        const tk = targetKey(activeTarget);
        const lots = openLots(book, tk);
        const avg = (book.legs[tk] ?? []).reduce((sum, l) => sum + l.avg, 0);
        const activeBars = activeFeed.bars;
        return (
          <>
            {tradeMode === 'REAL' && (
              <p className="shrink-0 px-4 py-1 text-[11px] text-amber-300 bg-amber-500/10 border-t border-amber-500/30">
                REAL mode stays on underneath: working orders ({workingRows.length}) and positions at your broker keep running on live prices while you practise.
              </p>
            )}
            <ReplayBar
              picking={replay.picking} cursorT={replay.cursorT} playing={replay.playing} speed={replay.speed} ended={replay.ended}
              savedCursorT={replay.saved && !replay.replaying ? replay.saved.cursorT : null}
              dataEndT={activeBars.length ? activeBars[activeBars.length - 1].t : null}
              stepLabel={intervalLabel(intervalOf(active))}
              onPickBar={replay.pick}
              onSelectDate={t => startReplayAt(active, t)}
              onFirst={() => { const t = firstAvailableT(activeBars, activeFeed.loaded?.anchorT); if (t !== null) startReplayAt(active, t); }}
              onRandom={() => { const t = randomStartT(activeBars, Math.random, activeFeed.loaded?.anchorT); if (t !== null) startReplayAt(active, t); }}
              onContinue={() => { setBook({ ...EMPTY_BOOK, at: replay.saved?.cursorT ?? null }); replay.resume(); }}
              onTogglePlay={replay.togglePlay}
              onStep={replay.step}
              onSpeed={replay.setSpeed}
              onRealtime={replay.close}
              onClose={replay.close}
              practice={{
                blocked: activeTarget.kind === 'index' ? 'Index: practise on its future or an option' : !q && replay.replaying ? 'Loading the contract…' : null,
                lots: practiceLots,
                onLots: setPracticeLots,
                onBuy: () => { if (q) setBook(b => practiceFill(b, q, 'BUY', practiceLots, 'manual')); },
                onSell: () => { if (q) setBook(b => practiceFill(b, q, 'SELL', practiceLots, 'manual')); },
                onFlatten: () => { if (q) setBook(b => practiceFlatten(b, q)); },
                position: lots === 0 ? 'FLAT' : `${lots > 0 ? 'LONG' : 'SHORT'} ${Math.abs(lots)}L @ ${avg.toFixed(2)}`,
                pnl: practicePnl(book, practiceQuotes),
                trades: book.trades.length,
              }}
            />
          </>
        );
      })()}
      {scalperShown && (
        <ScalperWindow
          trade={trade}
          label={dual ? `C${active} · ${activeFeed.label}` : activeFeed.label}
          sideHints={indexSideHints}
          subtitle={!indexTradable ? null : indexHeld.held
            ? `Holds ${indexHeld.held.dir === 'bull' ? 'BULL' : 'BEAR'} · ${indexHeld.held.action} ${targetLabel(indexHeld.held.traded)}`
            : `Flat · Bull ${legText(activeMap.bull)} · Bear ${legText(activeMap.bear)}`}
          broker={broker}
          mode={tradeMode}
          unlocked={scalperUnlockKey === scalperKey}
          onUnlockedChange={v => setScalperUnlockKey(v ? scalperKey : null)}
          blocked={locked(active) ? `Chart ${active} is run by AUTO - stop it to trade by hand` : null}
          styleText={orderStyle.style === 'Single' || indexTradable ? 'Single (no exits)'
            : `${orderStyle.style} · ${orderStyle.style === 'Bracket' ? `TGT ${orderStyle.tgt || '?'} · ` : ''}SL ${orderStyle.sl || '?'} boxes${orderStyle.trailOn ? ' · trail' : ''}`}
          pos={scalperPos}
          onMove={p => { setScalperPos(p); saveP(SCALPER_POS_KEY, JSON.stringify(p)); }}
          minimized={scalperMin}
          onMinimizedChange={v => { setScalperMin(v); saveP(SCALPER_MIN_KEY, v ? '1' : '0'); }}
          onClose={toggleScalper}
        />
      )}
      <BrokerBooks broker={broker} open={booksOpen} onOpenChange={changeBooksOpen} autoRows={autoToday} autoPrice={autoPrice}
        paperTrades={paperTrades}
        chartKeys={railCharts.find(c => c.chart === active)?.keys.filter(Boolean) ?? []} chartName={`C${active} · ${activeFeed.label}`} />
    </div>
  );
}

// The first render must already be on the saved broker, or a page saved on Kotak / Zerodha reads the Dhan account on mount.
export default withSavedBroker(StraddlePnfPage);
