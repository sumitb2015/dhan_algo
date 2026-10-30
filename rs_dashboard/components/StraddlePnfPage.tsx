'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChartScatter, LocateFixed, Volume2, VolumeX, Zap, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import InstrumentBar from './straddlePnf/InstrumentBar';
import SettingsControls, { SmaPeriodInput } from './straddlePnf/SettingsControls';
import PnfTradeBar from './straddlePnf/PnfTradeBar';
import BrokerBooks from './straddlePnf/BrokerBooks';
import HeaderPnlMargin from './straddlePnf/HeaderPnlMargin';
import { BROKERS, useBrokerSelector } from '@/hooks/useBrokerSelector';
import { withSavedBroker } from '@/hooks/withSavedBroker';
import { BrokerPicker } from './BrokerPicker';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock } from '@/lib/alertSound';
import { pnfChimeFor, playPnfChime, type PnfSoundEvent } from '@/lib/pnfChime';
import { buildConfirmedModel, withLive, type Overlay } from '@/lib/straddlePnfModel';
import { capLog, sessionWindow } from '@/lib/straddlePnfLive';
import { HeaderIndexChips } from '@/components/triplestraddle/HeaderIndexChips';
import {
  DEFAULT_CHART1_SETTINGS, DEFAULT_CHART2_SETTINGS, SETTINGS_KEY, SETTINGS_KEY_2, CHART_VIEW_KEY,
  boxText, readSettings, serializeSettings, type PnfSettings,
} from '@/lib/straddlePnfSettings';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';
import {
  DEFAULT_TARGETS, SEGMENTS, parseActiveChart, parseTarget, restoreChart, targetKey, type ChartPicks, type Segment, type Target,
} from '@/lib/pnfTarget';
import { usePnfFeed, type PnfFeed } from './straddlePnf/usePnfFeed';
import { usePnfAlerts } from './straddlePnf/usePnfAlerts';
import { usePnfAuto, usePnfAutoLedger, type AutoArm, type AutoEvent } from './straddlePnf/usePnfAuto';
import AutoControls from './straddlePnf/AutoControls';

// Point & Figure with a 1-click execution trade bar, picked with Index | Equity | Futures | Options: an NSE index or stock, a
// future, one option, or a CE + PE straddle. Two charts can show two different instruments with their own box settings; the
// ACTIVE chart is the one the header controls and the trade bar act on. Each chart's bars come from the history API (re-fetched
// every 30 s, usePnfFeed); signals are only ever evaluated on CLOSED one-minute bars, so the poll never delays one.

const FLASH_MS = 4000;
const LOG_KEY = 'straddle-pnf-log';
const SOUND_KEY = 'straddle-pnf-sound';
const OVERLAY_KEY = 'straddle-pnf-overlay';
const TRADE_OPEN_KEY = 'straddle-pnf-trade-open';
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
const DISARMED: AutoArm = { on: false, mode: 'PAPER', watermarkT: 0 };

type ChartId = 1 | 2;
const LEGACY_TARGET_KEY = 'straddle-pnf-target';

const minuteOf = (t: number) => Math.floor(t / 60) * 60;
/** Wall clock in epoch seconds, for event handlers (module scope: never called during render). */
const nowSec = () => Date.now() / 1000;
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window / blocked storage: the page works without it */ }
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
function useChartModel(feed: PnfFeed, target: Target, settings: PnfSettings, overlay: Overlay, now: number) {
  // An index's feed "volume" is its constituents' turnover, not traded volume: no VWAP. Whatever the instrument, the button follows
  // the model once bars are in (bars without volume, e.g. an illiquid option, get the box SMA too), so the toggle never
  // contradicts the chart.
  const indexNoVwap = target.kind === 'index';
  const bars = feed.bars;
  const last = bars[bars.length - 1];
  const formingBar = last !== undefined && now > 0 && last.t >= minuteOf(now / 1000) ? last : undefined;   // the minute still forming
  const closed = formingBar ? bars.slice(0, -1) : bars;
  const closedLast = closed[closed.length - 1];
  // The confirmed chart depends only on the closed bars, so it is rebuilt when a bar closes or history reloads, not on every tick.
  const closedKey = `${closed.length}:${closed[0]?.t ?? 0}:${closedLast?.t ?? 0}:${closedLast?.straddle ?? 0}:${feed.histVersion}`;
  const sessionClose = sessionWindow(feed.market, now / 1000)[1];
  const confirmed = useMemo(
    () => buildConfirmedModel(closed, overlay, { ...settings, sessionCloseMin: sessionClose || undefined, volume: !indexNoVwap }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closedKey, overlay, settings, sessionClose, indexNoVwap],
  );
  const model = useMemo(() => withLive(confirmed, formingBar), [confirmed, formingBar]);
  const vwapAllowed = !indexNoVwap && (closed.length === 0 || model.vwapAvailable);
  return { model, indexNoVwap, vwapAllowed };
}

const readMarkers = (key: string): PnfExecutionMarker[] => {
  try {
    const raw = sessionStorage.getItem(`${MARKERS_KEY}${key}`);
    const parsed = raw ? JSON.parse(raw) as PnfExecutionMarker[] : [];
    // A marker carries only its time and price: each chart finds its own column from its own box size. Older ones drop theirs.
    return Array.isArray(parsed) ? parsed.map(m => ({ ...m, col: undefined })) : [];
  } catch { return []; }
};

function StraddlePnfPage() {
  const [chartView, setChartView] = useState<'1' | '2'>('2');
  // Two charts: the one the header controls (instrument, box settings, price strip) and the trade bar act on.
  const [activeChart, setActiveChart] = useState<ChartId>(1);
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  const [target1, setTarget1] = useState<Target>(DEFAULT_TARGETS.index);
  const [target2, setTarget2] = useState<Target>(DEFAULT_TARGETS.index);
  // Each chart's last pick per segment (so switching segments brings it back) and its open segment.
  const picksRef = useRef<Record<ChartId, ChartPicks>>({ 1: { targets: { ...DEFAULT_TARGETS }, open: 'index' }, 2: { targets: { ...DEFAULT_TARGETS }, open: 'index' } });
  // No chart loads before the saved picks are read, so the default instrument is never fetched just to be replaced.
  const [prefsReady, setPrefsReady] = useState(false);
  const [settings, setSettings] = useState<PnfSettings>(DEFAULT_CHART1_SETTINGS);
  const [settings2, setSettings2] = useState<PnfSettings>(DEFAULT_CHART2_SETTINGS);
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
  const [autoArm, setAutoArm] = useState<Record<ChartId, AutoArm>>({ 1: DISARMED, 2: DISARMED });
  const [autoLots, setAutoLots] = useState<Record<ChartId, number>>({ 1: 1, 2: 1 });
  // ONE broker for the whole page: the header picker sets it (saved dashboard-wide, like the scalpers), and the trade bar and the
  // Margin / P&L chips read it from here, so the chips always show the account orders go to.
  const { broker, setBroker } = useBrokerSelector();
  const [tradeMode, setTradeMode] = useState<'PAPER' | 'REAL'>('PAPER');
  const [paperPnl, setPaperPnl] = useState(0);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<Record<ChartId, 'buy' | 'sell' | null>>({ 1: null, 2: null });
  const [now, setNow] = useState(0);
  // The active chart's price/summary strip is drawn into the top header (PnfPanel `headerSlot`).
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const { leaderRef } = useTabLeader('straddle-pnf');
  const mutedRef = useRef(false);
  const logLoadedRef = useRef(false);

  // ── preferences, sound unlock, clock ────────────────────────────────────
  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    // Saved preferences are read after mount, not in useState initialisers: localStorage does not exist on the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (readPref(OVERLAY_KEY) === 'sma') setOverlay('sma');
    const savedView = readPref(CHART_VIEW_KEY);
    if (savedView === '1' || savedView === '2') setChartView(savedView);
    setSettings(readSettings(readPref(SETTINGS_KEY), DEFAULT_CHART1_SETTINGS));
    setSettings2(readSettings(readPref(SETTINGS_KEY_2), DEFAULT_CHART2_SETTINGS));
    const raw1 = readPref(TARGETS_KEY);
    const p1 = restoreChart(raw1, readPref(SEGMENT_KEY));
    const legacy = parseTarget((() => { try { return JSON.parse(readPref(LEGACY_TARGET_KEY) ?? 'null'); } catch { return null; } })());
    if (legacy && !raw1) { p1.targets[legacy.kind] = legacy; if (!readPref(SEGMENT_KEY)) p1.open = legacy.kind; }   // one-time carry-over
    const raw2 = readPref(TARGETS_KEY_2);
    const p2 = restoreChart(raw2, readPref(SEGMENT_KEY_2), p1);
    // Chart 2's first visit copies chart 1 once and saves it, so it never follows later chart-1 picks by accident.
    if (raw2 === null) { savePref(TARGETS_KEY_2, JSON.stringify(p2.targets)); savePref(SEGMENT_KEY_2, p2.open); }
    picksRef.current = { 1: p1, 2: p2 };
    setTarget1(p1.targets[p1.open]);
    setTarget2(p2.targets[p2.open]);
    setActiveChart(parseActiveChart(readPref(ACTIVE_CHART_KEY)));
    setPrefsReady(true);
    if (readPref(SOUND_KEY) === '0') { setMuted(true); mutedRef.current = true; }
    if (readPref(TRADE_OPEN_KEY) === '0') setTradeOpen(false);
    if (readPref(BOOKS_OPEN_KEY) === '1') setBooksOpen(true);
    const lotsOf = (c: ChartId) => { const n = Number(readPref(`${AUTO_LOTS_KEY}${c}`)); return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 1; };
    setAutoLots({ 1: lotsOf(1), 2: lotsOf(2) });
    try {
      const raw = readPref(LOG_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setLog(parsed.slice(0, 30));
    } catch { /* corrupt stored log: start empty */ }
    logLoadedRef.current = true;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { if (logLoadedRef.current) savePref(LOG_KEY, JSON.stringify(log)); }, [log]);

  // ── the two charts: each its own instrument, history, live price, model and alerts ──
  const dual = chartView === '2';
  const active: ChartId = dual && activeChart === 2 ? 2 : 1;
  const feed1 = usePnfFeed(prefsReady ? target1 : null, recenter, now);
  const feed2 = usePnfFeed(prefsReady && dual ? target2 : null, recenter, now);
  const c1 = useChartModel(feed1, target1, settings, overlay, now);
  const c2 = useChartModel(feed2, target2, settings2, overlay, now);
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
      const sell = e.kind === 'DOUBLE_BOTTOM_SELL';
      const title = `${e.label} · ${sell ? 'Double bottom SELL' : 'Double top BUY'} @ ${e.price.toFixed(2)}`;
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
  usePnfAlerts({
    model: c1.model, ready: Boolean(feed1.loaded), chart: 1, target: target1, label: dual ? `${feed1.label} · C1` : feed1.label,
    strike: feed1.loaded?.key ?? 0, drawKey: `${tk1}|${feed1.epoch}|${serializeSettings(settings)}`, onFresh,
  });
  usePnfAlerts({
    model: c2.model, ready: dual && Boolean(feed2.loaded), chart: 2, target: target2, label: `${feed2.label} · C2`,
    strike: feed2.loaded?.key ?? 0, drawKey: `${tk2}|${feed2.epoch}|${serializeSettings(settings2)}|${dual}`, onFresh,
  });

  // ── trade execution markers, per instrument (a chart shows its own instrument's) ──
  const [markers, setMarkers] = useState<Record<string, PnfExecutionMarker[]>>({});
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMarkers(prev => {
      let next = prev;
      for (const k of [tk1, tk2]) if (!(k in next)) next = { ...next, [k]: readMarkers(k) };
      return next;
    });
  }, [tk1, tk2]);
  const saveMarkers = useCallback((key: string, update: (prev: PnfExecutionMarker[]) => PnfExecutionMarker[]) => {
    setMarkers(prev => {
      const list = update(prev[key] ?? readMarkers(key));
      try { sessionStorage.setItem(`${MARKERS_KEY}${key}`, JSON.stringify(list)); } catch { /* ignore */ }
      return { ...prev, [key]: list };
    });
  }, []);
  const handleTradeExecuted = useCallback((m: PnfExecutionMarker, t: Target) => saveMarkers(targetKey(t), prev => [...prev, m]), [saveMarkers]);

  // ── AUTO: each chart trades its own scrip (double-bottom SELL / double-top BUY, exit on the first column reversal) ──
  const { ledger: autoLedger, post: autoPost } = usePnfAutoLedger();
  const onAutoEvent = useCallback((e: AutoEvent) => {
    if (e.kind === 'halt') toast.error(e.text, { duration: Infinity });
    else if (e.kind === 'info') toast.warning(e.text);
    else {
      (e.kind === 'entry' && e.side === 'SELL' ? toast.error : toast.success)(e.text);
      if (e.target && e.side && e.price) {
        const t = Math.floor(nowSec());
        handleTradeExecuted({ id: `auto-${t}-${e.chart}-${e.kind}`, t, action: e.side, price: e.price, lots: e.lots ?? 1, mode: e.mode ?? 'PAPER', estimate: e.mode === 'REAL' }, e.target);
      }
    }
    // Only the leader tab runs AUTO, so only it rings: entry (rising), exit (falling), a refusal or a halt (warn buzz).
    if (leaderRef.current && !mutedRef.current) playPnfChime(pnfChimeFor({ kind: 'auto', type: e.kind }));
  }, [handleTradeExecuted, leaderRef]);
  const disarm = useCallback((c: ChartId) => setAutoArm(a => (a[c].on ? { ...a, [c]: DISARMED } : a)), []);
  const priceOf = (f: PnfFeed) => (f.live ? f.live.ce + f.live.pe : null);
  const auto1 = usePnfAuto({
    chart: 1, arm: autoArm[1], lots: autoLots[1], target: target1, model: c1.model, price: priceOf(feed1), stale: feed1.stale,
    market: feed1.market, complete: feed1.complete, broker, mode: tradeMode, leaderRef, ledger: autoLedger, post: autoPost,
    onEvent: onAutoEvent, onDisarm: () => disarm(1),
  });
  const auto2 = usePnfAuto({
    chart: 2, arm: autoArm[2], lots: autoLots[2], target: target2, model: c2.model, price: priceOf(feed2), stale: feed2.stale,
    market: feed2.market, complete: feed2.complete, broker, mode: tradeMode, leaderRef, ledger: autoLedger, post: autoPost,
    onEvent: onAutoEvent, onDisarm: () => disarm(2),
  });
  const autoOf = (c: ChartId) => (c === 2 ? auto2 : auto1);
  // Signals depend on the instrument and the box settings: while a chart is armed or holds an AUTO position, they are frozen.
  const locked = (c: ChartId) => autoArm[c].on || !!autoOf(c).row;
  const activeLocked = locked(active);
  const armChart = (c: ChartId, on: boolean) => {
    const m = (c === 2 ? c2 : c1).model;
    setAutoArm(a => ({ ...a, [c]: on ? { on: true, mode: tradeMode, watermarkT: m.lastBarT ?? Math.floor(nowSec()) } : DISARMED }));
    void autoPost({ op: 'log', chart: c, t: nowSec(), text: on ? `AUTO armed (${tradeMode}, ${autoLots[c]} lot)` : 'AUTO stopped' });
  };
  const setLotsFor = (c: ChartId, n: number) => { setAutoLots(l => ({ ...l, [c]: n })); savePref(`${AUTO_LOTS_KEY}${c}`, String(n)); };
  // The page mode is the mode AUTO trades in: switching it disarms both charts (arming REAL is always an explicit step).
  const changeTradeMode = (m: 'PAPER' | 'REAL') => {
    if (m !== tradeMode) setAutoArm(a => ({ 1: a[1].on ? DISARMED : a[1], 2: a[2].on ? DISARMED : a[2] }));
    setTradeMode(m);
  };
  // Arrives seconds after the order: found by id in the store as it is THEN (never a list captured at the click).
  const handleMarkerPrice = useCallback((id: string, price: number) => {
    setMarkers(prev => {
      let next = prev;
      for (const [key, list] of Object.entries(prev)) {
        if (!list.some(m => m.id === id)) continue;
        const updated = list.map(m => (m.id === id ? { ...m, price, estimate: false } : m));
        try { sessionStorage.setItem(`${MARKERS_KEY}${key}`, JSON.stringify(updated)); } catch { /* ignore */ }
        next = { ...next, [key]: updated };
      }
      return next;
    });
  }, []);

  // ── picking: every control acts on the active chart ──────────────────────
  const choose = (next: Target) => {
    const c = active;
    if (locked(c)) { toast.warning(`Chart ${c} is running AUTO: stop it (and let its position close) to change the instrument`); return; }
    const picks = picksRef.current[c];
    picksRef.current = { ...picksRef.current, [c]: { targets: { ...picks.targets, [next.kind]: next }, open: next.kind } };
    savePref(c === 1 ? TARGETS_KEY : TARGETS_KEY_2, JSON.stringify(picksRef.current[c].targets));
    savePref(c === 1 ? SEGMENT_KEY : SEGMENT_KEY_2, next.kind);
    (c === 1 ? setTarget1 : setTarget2)(t => (targetKey(t) === targetKey(next) ? t : next));
  };
  const pickSegment = (s: Segment) => { if (s !== activeTarget.kind) choose(picksRef.current[active].targets[s]); };
  const activate = (c: ChartId) => { setActiveChart(c); savePref(ACTIVE_CHART_KEY, String(c)); };
  const pickOverlay = (o: Overlay) => { setOverlay(o); savePref(OVERLAY_KEY, o); };
  const applySettings = (next: PnfSettings) => {
    if (active === 2) { setSettings2(next); savePref(SETTINGS_KEY_2, serializeSettings(next)); }
    else { setSettings(next); savePref(SETTINGS_KEY, serializeSettings(next)); }
  };
  const toggleChartView = (v: '1' | '2') => {
    if (v === '1' && locked(2)) { toast.warning('Chart 2 is running AUTO: stop it (and let its position close) before hiding it'); return; }
    setChartView(v);
    savePref(CHART_VIEW_KEY, v);
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    savePref(SOUND_KEY, next ? '0' : '1');
  };
  const changeBooksOpen = (next: boolean) => {
    setBooksOpen(next);
    savePref(BOOKS_OPEN_KEY, next ? '1' : '0');
  };
  const toggleTradeOpen = () => {
    setTradeOpen(prev => {
      const next = !prev;
      savePref(TRADE_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  };

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
    return {
      model: (c === 2 ? c2 : c1).model,
      live: feed.live,
      overlay,
      stale: feed.stale,
      legs: target.kind === 'options' && target.side === 'STRADDLE',
      flash: flash[c],
      loading: (feed.loading || !feed.complete) && feed.bars.length === 0,
      interval: st.interval,
      boxPct: st.boxPct,
      reversal: st.reversal,
      resetTick: viewTick,
      headerSlot: active === c ? headerSlot : null,
      showHeader: dual,
      scrip: dual ? `${feed.scrip} (${boxText(st)})` : feed.scrip,
      feedPrevClose: feed.trustedPrevClose,
      sessionTag: feed.sessionTag,
      tradeMarkers: markers[targetKey(target)] ?? [],
      error: feed.loaded?.error ?? (feed.complete ? undefined : contractError[c] ?? undefined),
      active: active === c,
      onActivate: dual ? () => activate(c) : undefined,
      autoSlot: (
        <AutoControls chart={c} armed={autoArm[c].on} mode={tradeMode} lots={autoLots[c]} onLots={n => setLotsFor(c, n)}
                      onArm={on => armChart(c, on)} row={autoOf(c).row} price={priceOf(feed)} note={autoOf(c).note} halt={autoOf(c).halt}
                      onResolve={autoOf(c).resolve} nowMs={now}
                      disabledReason={target.kind === 'index' ? 'No AUTO on an index: chart its future or an option' : null} />
      ),
    };
  };

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        {/* row 1: what is charted. Below 2xl the instrument bar drops to its own full-width line under the title, so its pickers
            stay on one line instead of being squeezed between the title and the NavBar. */}
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 pt-3 pb-2.5">
          <div className="order-1 flex items-center gap-3 shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
              <ChartScatter className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Scalping · {segLabel}</p>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none">Point &amp; Figure</h1>
              <p className="text-[10px] text-zinc-500 font-medium mt-1">
                {`${dual ? `Chart ${active} · ` : ''}${activeSettings.interval}-min · ${boxText(activeSettings)} · ${activeSettings.reversal}-box reversal · signals only · ${activeFno ? activeFeed.label : activeFeed.name ?? activeTarget.name}`}
              </p>
            </div>
          </div>
          <span className="hidden 2xl:block w-px h-8 bg-zinc-800 shrink-0 2xl:order-2" />
          <div className="order-4 basis-full 2xl:order-3 2xl:basis-0 2xl:flex-1 min-w-0 flex items-center gap-x-4 gap-y-2 flex-wrap">
            {/* Remounted per chart, so one chart's contract lists never show on the other. */}
            <fieldset disabled={activeLocked} className="contents" title={activeLocked ? `Chart ${active} is running AUTO` : undefined}>
            <InstrumentBar key={active} target={activeTarget} onSegment={pickSegment} onPick={choose}
                           onError={msg => setContractError(e => (e[active] === msg ? e : { ...e, [active]: msg }))} />
            </fieldset>
            {/* Nifty and India VIX vs the previous close: the shared indices WebSocket bridge's snapshot, started on mount. */}
            <div className="ml-auto shrink-0 flex items-center gap-2">
              <HeaderIndexChips />
              <span className="w-px h-5 bg-zinc-800 shrink-0" />
              <BrokerPicker value={broker} onChange={setBroker} brokers={BROKERS} />
              <HeaderPnlMargin broker={broker} mode={tradeMode} paperPnl={paperPnl} />
            </div>
          </div>
          <div className="order-3 2xl:order-4 ml-auto flex items-center gap-2 shrink-0">
            <DataChip date={activeFeed.loaded?.dataDate} lastSession={Boolean(activeFeed.loaded?.dataDate) && activeFeed.loaded?.dataDate !== today} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <NavBar />
          </div>
        </div>

        {/* row 2: the live price strip, then how the chart is drawn. The strip claims at least 560px and clips what does not fit, so
            on a narrow screen the settings move to the next line instead of sliding over the price. */}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap px-6 py-2 border-t border-zinc-800 bg-zinc-900/40">
          <div ref={setHeaderSlot} data-testid="pnf-header-summary" className="flex items-center grow basis-[560px] min-w-0 overflow-hidden" />
          <div className="flex items-center gap-2 flex-wrap ml-auto" role="group" aria-label="Chart settings">
            {/* 1 Chart vs 2 Charts view toggle */}
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Chart view">
              <button
                type="button"
                aria-label="1 Chart View"
                title="Single chart view"
                aria-pressed={chartView === '1'}
                onClick={() => toggleChartView('1')}
                className={seg(chartView === '1')}
              >
                1
              </button>
              <button
                type="button"
                aria-label="2 Charts View"
                title="Dual chart view (0.1% & 1%)"
                aria-pressed={chartView === '2'}
                onClick={() => toggleChartView('2')}
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
                      title={`Chart ${c}: ${(c === 2 ? feed2 : feed1).label} · ${boxText(c === 2 ? settings2 : settings)}`}
                      onClick={() => activate(c)}
                      className={`px-2 h-6 rounded text-[11px] font-bold transition-colors ${active === c ? 'bg-amber-500/15 text-amber-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                    >
                      C{c} · {boxShort(c === 2 ? settings2 : settings)}
                    </button>
                  ))}
                </div>
                <span className="w-px h-5 bg-zinc-800 shrink-0" />
              </>
            )}

            <fieldset disabled={activeLocked} className="contents"><SettingsControls settings={activeSettings} onChange={applySettings} /></fieldset>
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Overlay">
              {/* An index has no traded volume, so no VWAP: the button is disabled and the SMA is drawn (the saved choice is kept for
                  stocks, futures and options). */}
              <button type="button" aria-pressed={shownOverlay === 'vwap'} onClick={() => pickOverlay('vwap')} disabled={!activeChartModel.vwapAllowed}
                      title={activeChartModel.vwapAllowed ? undefined : activeChartModel.indexNoVwap
                        ? 'An index has no traded volume, so there is no VWAP: the SMA of the P&F boxes is used'
                        : 'These bars carry no volume, so there is no VWAP: the SMA of the P&F boxes is used'}
                      className={`${seg(shownOverlay === 'vwap')} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400`}>VWAP</button>
              <button type="button" aria-pressed={shownOverlay === 'sma'} onClick={() => pickOverlay('sma')} className={seg(shownOverlay === 'sma')}>SMA {activeSettings.smaPeriod}</button>
            </div>
            <fieldset disabled={activeLocked} className="contents"><SmaPeriodInput settings={activeSettings} onChange={applySettings} /></fieldset>
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <IconButton icon={LocateFixed} label="Re-center" onClick={recenterNow} />
            <IconButton icon={Bell} label="Alert log" onClick={() => setLogOpen(o => !o)} pressed={logOpen} badge={log.length} />
            <IconButton icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute alert sound' : 'Mute alert sound'} onClick={toggleMute} pressed={muted} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <IconButton icon={Zap} label={tradeOpen ? 'Hide trade desk' : 'Show trade desk'} onClick={toggleTradeOpen} pressed={tradeOpen} />
          </div>
        </div>
      </header>

      {/* interactive 1-click execution trade bar */}
      {tradeOpen && (
        <div className="shrink-0">
          <PnfTradeBar
            target={activeTarget}
            live={activeFeed.live}
            broker={broker}
            mode={tradeMode}
            onModeChange={changeTradeMode}
            onPnlChange={setPaperPnl}
            onSwitchTarget={choose}
            onTradeExecuted={handleTradeExecuted}
            onMarkerPrice={handleMarkerPrice}
            onSound={(outcome, close) => chime({ kind: 'manual', outcome, close })}
          />
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex flex-col gap-3 px-4 pt-2 pb-2">
        {loadErrors.map(e => <p key={e as string} role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{e}</p>)}
        {logOpen && <div className="absolute right-4 top-2 z-40 w-96 shadow-xl"><AlertLog entries={log} interval={activeSettings.interval} /></div>}
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
      <BrokerBooks broker={broker} open={booksOpen} onOpenChange={changeBooksOpen} autoRows={autoLedger.rows.filter(r => r.day === today)} />
    </div>
  );
}

// The first render must already be on the saved broker, or a page saved on Kotak / Zerodha reads the Dhan account on mount.
export default withSavedBroker(StraddlePnfPage);
