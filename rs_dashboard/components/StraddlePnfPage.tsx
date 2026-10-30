'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChartScatter, LocateFixed, Volume2, VolumeX, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import InstrumentBar from './straddlePnf/InstrumentBar';
import SettingsControls, { SmaPeriodInput } from './straddlePnf/SettingsControls';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock, playEntryChime, playExitChime } from '@/lib/alertSound';
import { buildPanelModel, type Overlay } from '@/lib/straddlePnfModel';
import {
  foldTick, newSignalsAfter, nextWatermark, capLog, inSession, mergeHistory, feedCloseTrusted, istMinuteOfDay, legsTick, SESSION_MIN,
  type LegQuote, type Market, type Tick,
} from '@/lib/straddlePnfLive';
import { isNseTradingDay, istDateIso } from '@/lib/nseHolidays';
import { DEFAULT_SETTINGS, SETTINGS_KEY, boxText, readSettings, serializeSettings, type PnfSettings } from '@/lib/straddlePnfSettings';
import { sessionOf, type Bar } from '@/lib/straddlePnf';
import {
  DEFAULT_TARGETS, SEGMENTS, isComplete, parseTarget, readTargets, targetKey, targetLabel, targetQuery, type Segment, type Target,
} from '@/lib/pnfTarget';

// Point & Figure of ONE price series, signals only (this page places no orders), picked with Index | Equity | Futures | Options:
// an NSE index or stock, a future, one option, or a CE + PE straddle. Bars come from the history API and the page re-fetches them
// every 30 s; signals are only ever evaluated on CLOSED one-minute bars, so the poll never delays one.

type Instrument = { segment: string; security_id: string };
type Loaded = { key: number; dataDate: string | null; error?: string; instruments: Instrument[] };
type LiveLeg = { quote: (NonNullable<LegQuote> & { prevClose: number | null }) | null; last: { ltp: number; prevClose: number | null } | null };

const POLL_MS = 30_000;
const LIVE_MS = 1_000;   // how often the page reads the WebSocket bridge's latest price (the bridge itself is push, from the shared hub)
const FRESH_S = 180;
const FLASH_MS = 4000;
const LOG_KEY = 'straddle-pnf-log';
const SOUND_KEY = 'straddle-pnf-sound';
const OVERLAY_KEY = 'straddle-pnf-overlay';
/** The last pick in each segment, and which segment is open. `straddle-pnf-target` (one target) is the pre-switch key, read once. */
const TARGETS_KEY = 'straddle-pnf-targets';
const SEGMENT_KEY = 'straddle-pnf-segment';
const LEGACY_TARGET_KEY = 'straddle-pnf-target';

const minuteOf = (t: number) => Math.floor(t / 60) * 60;
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
                        className="relative inline-flex items-center justify-center h-7 w-7 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:bg-zinc-800" />}
      >
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        {badge ? <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-oncolor text-[9px] font-bold leading-4 text-center">{badge}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function StraddlePnfPage() {
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  const [target, setTarget] = useState<Target>(DEFAULT_TARGETS.index);
  const targetsRef = useRef<Record<Segment, Target>>({ ...DEFAULT_TARGETS });
  const [name, setName] = useState<string | null>(null); // the full name the server resolved for the chosen symbol
  const [settings, setSettings] = useState<PnfSettings>(DEFAULT_SETTINGS);
  const [bars, setBars] = useState<Bar[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recenter, setRecenter] = useState(0);
  // Re-center reloads and then resets the chart's zoom/pan to the centre; the flag waits for that load to land.
  const [viewTick, setViewTick] = useState(0);
  const recenterViewRef = useRef(false);
  const recenterNow = () => { recenterViewRef.current = true; setRecenter(n => n + 1); };
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<'buy' | 'sell' | null>(null);
  const [now, setNow] = useState(0);
  // The newest WebSocket price; kept so a history refresh (which replaces the bars) can lay it back on top.
  const tickRef = useRef<Tick | null>(null);
  const [feedPrevClose, setFeedPrevClose] = useState<number | null>(null);
  // A feed price outside the trading session (NSE pre-open, post-close): shown in the header, never folded into a chart bar.
  const [outQuote, setOutQuote] = useState<{ ce: number; pe: number; t: number } | null>(null);
  // The chart's price/summary strip is drawn into the top header (PnfPanel `headerSlot`) instead of a card header above the chart.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  const { leaderRef } = useTabLeader('straddle-pnf');
  const mutedRef = useRef(false);
  const reqRef = useRef(0);
  // The last closed bar already evaluated for alerts. Alerts are keyed on bar time, never on column numbers.
  const watermarkRef = useRef(0);
  // The next alert evaluation is a re-baseline (history loaded / chart redrawn with other settings): move the watermark to the new
  // chart's last closed bar and alert on nothing, so old signals can never fire as new ones.
  const rebaselineRef = useRef(false);
  const logLoadedRef = useRef(false);

  // ── preferences, sound unlock, clock ────────────────────────────────────
  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    // Saved preferences are read after mount, not in useState initialisers: localStorage does not exist on the server render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (readPref(OVERLAY_KEY) === 'sma') setOverlay('sma');
    setSettings(readSettings(readPref(SETTINGS_KEY)));
    const targets = readTargets(readPref(TARGETS_KEY));
    const legacy = parseTarget((() => { try { return JSON.parse(readPref(LEGACY_TARGET_KEY) ?? 'null'); } catch { return null; } })());
    if (legacy && !readPref(TARGETS_KEY)) targets[legacy.kind] = legacy;   // one-time carry-over from the single-target key
    targetsRef.current = targets;
    const seg = readPref(SEGMENT_KEY) as Segment | null;
    const open = seg && SEGMENTS.some(x => x.id === seg) ? seg : legacy?.kind ?? 'index';
    setTarget(t => (targetKey(t) === targetKey(targets[open]) ? t : targets[open]));
    rebaselineRef.current = true;
    if (readPref(SOUND_KEY) === '0') { setMuted(true); mutedRef.current = true; }
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

  // ── history load. reset = new instrument / Re-center (alerts restart); otherwise a quiet refresh ──
  const complete = isComplete(target);
  const tKey = targetKey(target);   // any field changing is a new instrument
  const load = useCallback(async (reset: boolean) => {
    if (!complete) return;                // a future / option waits for its contract (the pickers fill it in)
    const id = ++reqRef.current;
    if (reset) { setLoading(true); setLoadError(null); }
    try {
      const res = await fetch(`/api/straddle-pnf?${targetQuery(target)}`);
      const j = await res.json() as {
        success?: boolean; error?: string; strikes: number[]; dataDate: string | null; name?: string; instruments?: Instrument[];
        instrument?: Instrument | null; bars: Record<string, Bar[]>; errors: Record<string, string>;
      };
      if (id !== reqRef.current) return; // a newer request owns the screen
      if (!j.success) throw new Error(j.error ?? 'Failed to load price history');
      const key = j.strikes[0] ?? 0;
      if (reset) rebaselineRef.current = true; // history never alerts
      if (recenterViewRef.current) { recenterViewRef.current = false; setViewTick(n => n + 1); }
      const hist = j.bars[String(key)] ?? [];
      const tk = tickRef.current;
      const instruments = j.instruments ?? (j.instrument ? [j.instrument] : []);
      setBars(prev => mergeHistory(hist, prev, tk, instruments.length < 2));
      setLoaded({ key, dataDate: j.dataDate, error: j.errors?.[String(key)], instruments });
      if (j.name) setName(j.name);
      setLoadError(null);
    } catch (e) {
      if (id !== reqRef.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load price history');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tKey, complete]);

  // The load is the effect's job (instrument changed / Re-center); its loading flag is set synchronously on purpose.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(true); }, [load, recenter]);
  useEffect(() => {
    const id = setInterval(() => { void load(false); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // ── live price over the WebSocket bridge → the open bar ─────────────────
  const instruments = loaded?.instruments ?? [];
  const ids = instruments.map(i => `${i.segment}:${i.security_id}`).join(',');
  const single = instruments.length < 2;
  // The session clock follows the contract: MCX for a commodity future / option, NSE otherwise.
  const market: Market = instruments[0]?.segment === 'MCX_COMM' ? 'MCX' : 'NSE';
  useEffect(() => {
    if (!ids) return;
    let dead = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/straddle-pnf/live?ids=${ids}`);
        const j = await res.json() as { success?: boolean; legs?: LiveLeg[] };
        if (dead || !j.success || !j.legs) return;
        const legs = j.legs;
        // A straddle's previous close is the sum of both legs', and only when both have one.
        const closes = legs.map(l => l.quote?.prevClose ?? l.last?.prevClose ?? null);
        setFeedPrevClose(closes.every(c => c !== null) ? closes.reduce((a, c) => a + (c as number), 0) : null);
        const tick = legsTick(legs.map(l => l.quote));
        if (!tick) { setOutQuote(null); return; }
        // Pre-open values are indicative, not trades, and the history API has no bars for them: header only.
        if (!inSession(tick.t, market)) { setOutQuote({ ce: tick.ce, pe: tick.pe, t: tick.t }); return; }
        setOutQuote(null);
        tickRef.current = tick;
        setBars(prev => (prev.length ? foldTick(prev, tick, single).bars : prev));
      } catch { /* the header keeps the last price and shows Stale until the next read lands */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, LIVE_MS);
    return () => { dead = true; clearInterval(id); };
  }, [ids, market, single]);

  // ── panel model: CLOSED bars only, so a signal never repaints ───────────
  // An index's feed "volume" is its constituents' turnover, not traded volume: no VWAP, the box SMA stands in for it.
  const vwapAllowed = target.kind !== 'index';
  const shownOverlay: Overlay = vwapAllowed ? overlay : 'sma';
  const model = useMemo(() => {
    const last = bars[bars.length - 1];
    const forming = last !== undefined && last.t >= minuteOf(now / 1000) && now > 0; // the minute still forming is not closed yet
    return buildPanelModel(forming ? bars.slice(0, -1) : bars, overlay, {
      ...settings, sessionCloseMin: SESSION_MIN[market][1], forming: forming ? last : undefined,
      volume: vwapAllowed,
    });
  }, [bars, overlay, settings, now, market, vwapAllowed]);

  // A chart's name for the alert log and the header's scrip: the symbol (with its full name for an index / stock), or the contract.
  const label = targetLabel(target);
  const fno = target.kind === 'futures' || target.kind === 'options';
  const scrip = fno ? label : name && name !== target.symbol ? `${target.symbol} · ${name}` : target.symbol;

  // ── alerts: new signals on newly closed bars, once each ─────────────────
  useEffect(() => {
    if (!loaded) return;
    const rebaseline = rebaselineRef.current;
    rebaselineRef.current = false;
    if (rebaseline) { watermarkRef.current = model.lastBarT ?? watermarkRef.current; return; }
    const wm = watermarkRef.current || model.lastBarT || 0;
    const fresh: LogEntry[] = newSignalsAfter(model.signals, wm).map(s => ({
      id: `${target.kind}:${target.symbol}:${s.kind}:${s.t}`, t: s.t, strike: loaded.key, label, kind: s.kind, price: s.price, belowVwap: s.belowVwap,
    }));
    watermarkRef.current = nextWatermark(wm, model.lastBarT);
    if (!fresh.length) return;
    setLog(prev => fresh.filter(e => !prev.some(p => p.id === e.id)).reduce((l, e) => capLog(l, e), prev));
    for (const e of fresh) {
      const sell = e.kind === 'DOUBLE_BOTTOM_SELL';
      const title = `${label} · ${sell ? 'Double bottom SELL' : 'Double top BUY'} @ ${e.price.toFixed(2)}`;
      if (sell) toast.error(title, { description: e.belowVwap ? `Below ${model.vwapAvailable ? 'VWAP' : `SMA ${model.smaPeriod}`} — short entry zone` : undefined });
      else toast.success(title);
      setFlash(sell ? 'sell' : 'buy');
      setTimeout(() => setFlash(null), FLASH_MS);
    }
    // Sound only in the leader tab, so two open tabs never double-ring; the toast and log still show everywhere.
    if (leaderRef.current && !mutedRef.current) {
      const last = fresh[fresh.length - 1];
      if (last.kind === 'DOUBLE_BOTTOM_SELL') playEntryChime(); else playExitChime();
    }
  }, [model, loaded, leaderRef, label, target]);

  const lastBarT = bars.length ? bars[bars.length - 1].t : 0;
  const stale = now === 0 || !lastBarT || now / 1000 - lastBarT > FRESH_S;

  const choose = (next: Target) => {
    targetsRef.current = { ...targetsRef.current, [next.kind]: next };
    savePref(TARGETS_KEY, JSON.stringify(targetsRef.current));
    savePref(SEGMENT_KEY, next.kind);
    if (targetKey(next) === targetKey(target)) return;
    // Everything on screen belongs to the old instrument: drop it so no refresh or alert crosses over.
    reqRef.current++;
    watermarkRef.current = 0;
    rebaselineRef.current = true;
    tickRef.current = null; setFeedPrevClose(null); setOutQuote(null);
    setLoaded(null); setBars([]); setLoading(true); setLoadError(null); setName(null);
    setTarget(next);
  };
  const pickSegment = (s: Segment) => { if (s !== target.kind) choose(targetsRef.current[s]); };
  const pickOverlay = (o: Overlay) => { setOverlay(o); savePref(OVERLAY_KEY, o); };
  const applySettings = (next: PnfSettings) => {
    rebaselineRef.current = true;     // the chart is about to be redrawn from the same data: that must not alert
    setSettings(next);
    savePref(SETTINGS_KEY, serializeSettings(next));
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    savePref(SOUND_KEY, next ? '0' : '1');
  };

  const today = istToday();
  const seg = (active: boolean) =>
    `px-2.5 h-6 text-[11px] font-bold rounded-md transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-100'}`;
  const isStraddle = target.kind === 'options' && target.side === 'STRADDLE';
  const lastBar = bars[bars.length - 1];
  const live = outQuote ? { ce: outQuote.ce, pe: outQuote.pe } : lastBar ? { ce: lastBar.ce, pe: lastBar.pe } : null;
  const segLabel = SEGMENTS.find(x => x.id === target.kind)?.label ?? '';
  const sessionTag = outQuote ? (istMinuteOfDay(outQuote.t) < SESSION_MIN[market][0] ? 'Pre-open' : 'Post-close') : null;
  // The feed's previous close is the official one (a stock's closing price is not its last 1-min close), but only until the bell.
  const tradingDay = market === 'NSE' ? isNseTradingDay(istDateIso(now)) : true;
  // Before today's first price the header shows the last session's close, measured (from history) against the session before it.
  const priceToday = (outQuote ? sessionOf(outQuote.t) : bars.length ? sessionOf(bars[bars.length - 1].t) : null) === istDateIso(now);
  const trustedPrevClose = now > 0 && priceToday && feedCloseTrusted(now / 1000, market, tradingDay) ? feedPrevClose : null;

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
                {settings.interval}-min · {boxText(settings)} · {settings.reversal}-box reversal · signals only · {fno ? label : name ?? target.name}
              </p>
            </div>
          </div>
          <span className="hidden 2xl:block w-px h-8 bg-zinc-800 shrink-0 2xl:order-2" />
          <div className="order-4 basis-full 2xl:order-3 2xl:basis-0 2xl:flex-1 min-w-0">
            <InstrumentBar target={target} onSegment={pickSegment} onPick={choose} />
          </div>
          <div className="order-3 2xl:order-4 ml-auto flex items-center gap-2 shrink-0">
            <DataChip date={loaded?.dataDate} lastSession={Boolean(loaded?.dataDate) && loaded?.dataDate !== today} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <NavBar />
          </div>
        </div>

        {/* row 2: the live price strip, then how the chart is drawn. The strip claims at least 560px and clips what does not fit, so
            on a narrow screen the settings move to the next line instead of sliding over the price. */}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap px-6 py-2 border-t border-zinc-800 bg-zinc-900/40">
          <div ref={setHeaderSlot} data-testid="pnf-header-summary" className="flex items-center grow basis-[560px] min-w-0 overflow-hidden" />
          <div className="flex items-center gap-2 flex-wrap ml-auto" role="group" aria-label="Chart settings">
            <SettingsControls settings={settings} onChange={applySettings} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Overlay">
              {/* An index has no traded volume, so no VWAP: the button is disabled and the SMA is drawn (the saved choice is kept for
                  stocks, futures and options). */}
              <button type="button" aria-pressed={shownOverlay === 'vwap'} onClick={() => pickOverlay('vwap')} disabled={!vwapAllowed}
                      title={vwapAllowed ? undefined : 'An index has no traded volume, so there is no VWAP: the SMA of the P&F boxes is used'}
                      className={`${seg(shownOverlay === 'vwap')} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400`}>VWAP</button>
              <button type="button" aria-pressed={shownOverlay === 'sma'} onClick={() => pickOverlay('sma')} className={seg(shownOverlay === 'sma')}>SMA {settings.smaPeriod}</button>
            </div>
            <SmaPeriodInput settings={settings} onChange={applySettings} />
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <IconButton icon={LocateFixed} label="Re-center" onClick={recenterNow} />
            <IconButton icon={Bell} label="Alert log" onClick={() => setLogOpen(o => !o)} pressed={logOpen} badge={log.length} />
            <IconButton icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute alert sound' : 'Mute alert sound'} onClick={toggleMute} pressed={muted} />
          </div>
        </div>
      </header>

      <div className="relative flex-1 min-h-0 flex flex-col gap-3 px-4 py-4">
        {loadError && <p role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{loadError}</p>}
        {logOpen && <div className="absolute right-4 top-2 z-40 w-96 shadow-xl"><AlertLog entries={log} interval={settings.interval} /></div>}
        <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }}>
          <PnfPanel
            title={`${label} price chart`}
            strike={loaded?.key ?? 0}
            model={model}
            live={live}
            overlay={overlay}
            stale={stale}
            legs={isStraddle}
            flash={flash}
            loading={(loading || !complete) && bars.length === 0}
            interval={settings.interval}
            boxPct={settings.boxPct}
            reversal={settings.reversal}
            fill
            resetTick={viewTick}
            headerSlot={headerSlot}
            scrip={scrip}
            feedPrevClose={trustedPrevClose}
            sessionTag={sessionTag}
            error={loaded?.error}
          />
        </div>
      </div>
    </div>
  );
}
