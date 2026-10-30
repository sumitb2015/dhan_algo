'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChartScatter, LocateFixed, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import SymbolSearch from './straddlePnf/SymbolSearch';
import SettingsControls from './straddlePnf/SettingsControls';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock, playEntryChime, playExitChime } from '@/lib/alertSound';
import { buildPanelModel, type Overlay } from '@/lib/straddlePnfModel';
import { foldTick, newSignalsAfter, nextWatermark, capLog, type Tick } from '@/lib/straddlePnfLive';
import { DEFAULT_SETTINGS, SETTINGS_KEY, readSettings, serializeSettings, type PnfSettings } from '@/lib/straddlePnfSettings';
import type { PnfPick } from '@/lib/straddlePnfSearch';
import type { Bar } from '@/lib/straddlePnf';

// Point & Figure of ONE price series, signals only (this page places no orders): an NSE index or stock picked in the search box
// (default the NIFTY index), or the nearest CRUDEOILM future. There are no options here. Bars come from the history API and the page
// re-fetches them every 30 s; signals are only ever evaluated on CLOSED one-minute bars, so the poll never delays one.

type Target = { kind: 'index' | 'equity' | 'futures'; symbol: string; name: string };
type Instrument = { segment: string; security_id: string };
type Loaded = { key: number; dataDate: string | null; error?: string; expiry?: string; instrument?: Instrument };
type LiveQuote = { ltp: number; changedMs: number; prevClose: number | null; volume: number | null };

const DEFAULT_TARGET: Target = { kind: 'index', symbol: 'NIFTY', name: 'Nifty 50' };
const FUTURES_TARGET: Target = { kind: 'futures', symbol: 'CRUDEOILM', name: 'CRUDEOILM futures' };
const POLL_MS = 30_000;
const LIVE_MS = 1_000;   // how often the page reads the WebSocket bridge's latest price (the bridge itself is push, from the shared hub)
const FRESH_S = 180;
const FLASH_MS = 4000;
const LOG_KEY = 'straddle-pnf-log';
const SOUND_KEY = 'straddle-pnf-sound';
const OVERLAY_KEY = 'straddle-pnf-overlay';
const TARGET_KEY = 'straddle-pnf-target';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const minuteOf = (t: number) => Math.floor(t / 60) * 60;
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window / blocked storage: the page works without it */ }
}
function readTarget(raw: string | null): Target {
  try {
    const t = raw ? JSON.parse(raw) : null;
    if (t && (t.kind === 'index' || t.kind === 'equity' || t.kind === 'futures') && /^[A-Z0-9&-]{1,20}$/.test(t.symbol)) {
      return { kind: t.kind, symbol: t.symbol, name: typeof t.name === 'string' ? t.name : t.symbol };
    }
  } catch { /* corrupt: default */ }
  return DEFAULT_TARGET;
}
const apiQuery = (t: Target) => (t.kind === 'futures' ? `underlying=${t.symbol}` : `mode=price&kind=${t.kind}&symbol=${encodeURIComponent(t.symbol)}`);

export default function StraddlePnfPage() {
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  const [target, setTarget] = useState<Target>(DEFAULT_TARGET);
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
    if (readPref(OVERLAY_KEY) === 'sma') setOverlay('sma');
    setSettings(readSettings(readPref(SETTINGS_KEY)));
    const saved = readTarget(readPref(TARGET_KEY));
    setTarget(t => (t.kind === saved.kind && t.symbol === saved.symbol ? t : saved));
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
  const load = useCallback(async (reset: boolean) => {
    const id = ++reqRef.current;
    if (reset) { setLoading(true); setLoadError(null); }
    try {
      const res = await fetch(`/api/straddle-pnf?${apiQuery(target)}`);
      const j = await res.json() as {
        success?: boolean; error?: string; strikes: number[]; dataDate: string | null; name?: string; instrument?: Instrument | null;
        expiries?: Record<string, string>; bars: Record<string, Bar[]>; errors: Record<string, string>;
      };
      if (id !== reqRef.current) return; // a newer request owns the screen
      if (!j.success) throw new Error(j.error ?? 'Failed to load price history');
      const key = j.strikes[0] ?? 0;
      if (reset) rebaselineRef.current = true; // history never alerts
      if (recenterViewRef.current) { recenterViewRef.current = false; setViewTick(n => n + 1); }
      const hist = j.bars[String(key)] ?? [];
      const tk = tickRef.current;
      setBars(tk && hist.length && tk.t >= hist[hist.length - 1].t ? foldTick(hist, tk, true).bars : hist);
      setLoaded({ key, dataDate: j.dataDate, error: j.errors?.[String(key)], expiry: j.expiries?.[String(key)], instrument: j.instrument ?? undefined });
      if (j.name) setName(j.name);
      setLoadError(null);
    } catch (e) {
      if (id !== reqRef.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load price history');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.symbol]);

  useEffect(() => { void load(true); }, [load, recenter]);
  useEffect(() => {
    const id = setInterval(() => { void load(false); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // ── live price over the WebSocket bridge → the open bar ─────────────────
  const inst = loaded?.instrument;
  useEffect(() => {
    if (!inst) return;
    let dead = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/straddle-pnf/live?segment=${inst.segment}&id=${inst.security_id}`);
        const j = await res.json() as { success?: boolean; quote?: LiveQuote | null; last?: { prevClose: number | null } | null };
        if (dead || !j.success) return;
        setFeedPrevClose(j.quote?.prevClose ?? j.last?.prevClose ?? null);
        const q = j.quote;
        if (!q) return;
        const tick: Tick = { t: q.changedMs / 1000, ce: q.ltp, pe: 0, cumVol: q.volume ?? undefined };
        tickRef.current = tick;
        setBars(prev => (prev.length ? foldTick(prev, tick, true).bars : prev));
      } catch { /* the header keeps the last price and shows Stale until the next read lands */ }
    };
    void poll();
    const id = setInterval(() => { void poll(); }, LIVE_MS);
    return () => { dead = true; clearInterval(id); };
  }, [inst?.segment, inst?.security_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── panel model: CLOSED bars only, so a signal never repaints ───────────
  const model = useMemo(() => {
    const last = bars[bars.length - 1];
    const forming = last !== undefined && last.t >= minuteOf(now / 1000) && now > 0; // the minute still forming is not closed yet
    return buildPanelModel(forming ? bars.slice(0, -1) : bars, overlay, settings);
  }, [bars, overlay, settings, now]);

  // A chart's name for the alert log: the symbol, with the contract month for a future.
  const label = useMemo(() => {
    if (target.kind !== 'futures') return target.symbol;
    const iso = loaded?.expiry;
    return iso ? `${target.symbol} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : target.symbol;
  }, [target, loaded]);

  // The header's scrip: the symbol, with the contract month for a future and the resolved full name for an index / stock.
  const scrip = target.kind === 'futures' ? label : name && name !== target.symbol ? `${target.symbol} · ${name}` : target.symbol;

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
      if (sell) toast.error(title, { description: e.belowVwap ? 'Below VWAP — entry zone' : undefined });
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
    if (next.kind === target.kind && next.symbol === target.symbol) return;
    savePref(TARGET_KEY, JSON.stringify(next));
    // Everything on screen belongs to the old instrument: drop it so no refresh or alert crosses over.
    reqRef.current++;
    watermarkRef.current = 0;
    rebaselineRef.current = true;
    tickRef.current = null; setFeedPrevClose(null);
    setLoaded(null); setBars([]); setLoading(true); setLoadError(null); setName(null);
    setTarget(next);
  };
  const pickSearch = (p: PnfPick) => choose({ kind: p.kind, symbol: p.symbol, name: p.name });
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
    `px-2.5 py-1 text-[11px] font-bold rounded-md transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`;
  const iconBtn = 'inline-flex items-center justify-center h-7 w-7 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800';
  const isNifty = target.kind === 'index' && target.symbol === 'NIFTY';
  const isCrude = target.kind === 'futures';
  const live = bars.length ? { ce: bars[bars.length - 1].ce, pe: 0 } : null;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <ChartScatter className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Scalping · {target.symbol}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Point &amp; Figure</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              {settings.interval}-min · {settings.boxPct}% box · {settings.reversal}-box reversal · signals only · {isCrude ? label : name ?? target.name}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div ref={setHeaderSlot} data-testid="pnf-header-summary" className="flex items-center min-w-0" />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Instrument">
            <button type="button" aria-pressed={isNifty} onClick={() => choose(DEFAULT_TARGET)} className={seg(isNifty)}>NIFTY</button>
            <button type="button" aria-pressed={isCrude} onClick={() => choose(FUTURES_TARGET)} className={seg(isCrude)}>CRUDEOILM</button>
          </div>
          <SymbolSearch active={target.kind === 'futures' || isNifty ? null : { kind: target.kind, symbol: target.symbol, name: target.name }} onPick={pickSearch} />
          <SettingsControls settings={settings} onChange={applySettings} />
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Overlay">
            <button type="button" aria-pressed={overlay === 'vwap'} onClick={() => pickOverlay('vwap')} className={seg(overlay === 'vwap')}>VWAP</button>
            <button type="button" aria-pressed={overlay === 'sma'} onClick={() => pickOverlay('sma')} className={seg(overlay === 'sma')}>SMA 10</button>
          </div>
          <button type="button" onClick={recenterNow} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">
            <LocateFixed className="w-3.5 h-3.5" aria-hidden="true" /> Re-center
          </button>
          <button type="button" aria-label="Alert log" aria-pressed={logOpen} onClick={() => setLogOpen(o => !o)} className={`${iconBtn} relative`}>
            <Bell className="w-3.5 h-3.5" aria-hidden="true" />
            {log.length > 0 && <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-oncolor text-[9px] font-bold leading-4 text-center">{log.length}</span>}
          </button>
          <button type="button" aria-label={muted ? 'Unmute alert sound' : 'Mute alert sound'} aria-pressed={muted} onClick={toggleMute} className={iconBtn}>
            {muted ? <VolumeX className="w-3.5 h-3.5" aria-hidden="true" /> : <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
          <DataChip date={loaded?.dataDate} lastSession={Boolean(loaded?.dataDate) && loaded?.dataDate !== today} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col gap-3 px-4 py-4">
        {loadError && <p role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{loadError}</p>}
        {logOpen && <div className="absolute right-4 top-2 z-40 w-96 shadow-xl"><AlertLog entries={log} /></div>}
        <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }}>
          <PnfPanel
            title={`${label} price chart`}
            strike={loaded?.key ?? 0}
            model={model}
            live={live}
            overlay={overlay}
            stale={stale}
            legs={false}
            flash={flash}
            loading={loading && bars.length === 0}
            interval={settings.interval}
            boxPct={settings.boxPct}
            reversal={settings.reversal}
            fill
            resetTick={viewTick}
            headerSlot={headerSlot}
            scrip={scrip}
            feedPrevClose={feedPrevClose}
            error={loaded?.error}
          />
        </div>
      </div>
    </div>
  );
}
