'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, FlaskConical, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import SettingsControls from './straddlePnf/SettingsControls';
import { DEFAULT_SETTINGS, SETTINGS_KEY, readSettings, serializeSettings, type PnfSettings } from '@/lib/straddlePnfSettings';
import { buildPanelModel, type Overlay } from '@/lib/straddlePnfModel';
import { newSignalsAfter, nextWatermark, capLog } from '@/lib/straddlePnfLive';
import { sessionOf, type Bar } from '@/lib/straddlePnf';
import {
  SPEEDS, barsUpTo, clockLabel, msPerBar, timelineOf, validateSimParams, valueAt, type ExpiryInfo, type Speed,
} from '@/lib/straddleSim';
import { installAlertSoundUnlock, playEntryChime, playExitChime } from '@/lib/alertSound';

// Straddle Simulator: replays past NIFTY straddle sessions through the same P&F engine as the live page. Signals only — no orders.
// One replay step = one 1-min bar closing; at speed N a bar takes 60 s / N. The preload day (the session before From) is drawn
// already; only replayed bars can alert, and scrubbing never alerts.

type Loaded = {
  expiry: string; atm: number; strikes: number[]; preloadSession: string | null; sessions: string[];
  bars: Record<string, Bar[]>; coverage: Record<string, number>; spotT: number[]; spotV: number[]; replayStartT: number;
};

const TITLES = ['ATM −200', 'ATM', 'ATM +200'];
const FLASH_MS = 4000;
const SOUND_KEY = 'straddle-sim-sound';

const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const istYesterday = () => new Date(Date.now() + 5.5 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the page works without it */ }
}

export default function StraddleSimulatorPage() {
  const [expiries, setExpiries] = useState<ExpiryInfo[]>([]);
  const [expiry, setExpiry] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [index, setIndex] = useState('NIFTY');
  const [atmText, setAtmText] = useState('auto');
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  const [settings, setSettings] = useState<PnfSettings>(DEFAULT_SETTINGS);
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(50);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<Record<string, 'buy' | 'sell'>>({});

  const mutedRef = useRef(false);
  const reqRef = useRef(0);
  const seekRef = useRef(false);                       // the next evaluation is a jump (load / scrub / reset): re-baseline, never alert
  const watermarkRef = useRef<Record<string, number>>({});
  const flashTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    if (readPref(SOUND_KEY) === '0') { setMuted(true); mutedRef.current = true; }
    setSettings(readSettings(readPref(SETTINGS_KEY)));   // the same preference the live page uses
    const timers = flashTimers.current;
    return () => { timers.forEach(clearTimeout); };
  }, []);

  // ── the store's expiries, newest first; the form starts on the latest expiry and its most recent past day ──
  const pickExpiry = useCallback((list: ExpiryInfo[], value: string) => {
    const info = list.find(e => e.expiry === value);
    if (!info) return;
    const last = info.last < istToday() ? info.last : istYesterday();
    setExpiry(value);
    setTo(last);
    setFrom(last < info.first ? info.first : last);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/straddle-simulator?mode=expiries')
      .then(r => r.json())
      .then((j: { success?: boolean; expiries?: ExpiryInfo[]; error?: string }) => {
        if (cancelled) return;
        if (!j.success || !j.expiries?.length) { setError(j.error ?? 'No expiries in the options store.'); return; }
        setExpiries(j.expiries);
        pickExpiry(j.expiries, j.expiries[0].expiry);
      })
      .catch(() => { if (!cancelled) setError('Could not load the expiry list.'); });
    return () => { cancelled = true; };
  }, [pickExpiry]);

  // ── load ───────────────────────────────────────────────────────────────
  const load = async () => {
    const v = validateSimParams({ index, expiry, from, to, atm: atmText.trim() === '' ? 'auto' : atmText.trim() }, expiries.length ? expiries : null, istToday());
    if (!v.ok) { setError(v.error); return; }
    const id = ++reqRef.current;
    setError(null);
    setLoading(true);
    setPlaying(false);
    try {
      const res = await fetch(`/api/straddle-simulator?index=${index}&expiry=${expiry}&from=${from}&to=${to}&atm=${v.atm}`);
      const j = await res.json() as Loaded & { success?: boolean; error?: string };
      if (id !== reqRef.current) return;
      if (!j.success) throw new Error(j.error ?? 'Failed to load the replay');
      seekRef.current = true;           // baseline the alert watermarks on the preload day
      setData(j);
      setCursor(0);
      setLog([]);
    } catch (e) {
      if (id === reqRef.current) setError(e instanceof Error ? e.message : 'Failed to load the replay');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  };

  // ── replay clock ───────────────────────────────────────────────────────
  const times = useMemo(() => (data ? timelineOf(data.bars, data.replayStartT) : []), [data]);
  const total = times.length;
  const T = data ? (cursor === 0 ? data.replayStartT - 60 : times[cursor - 1]) : 0;

  useEffect(() => {
    if (!playing || total === 0) return;
    const id = setInterval(() => setCursor(c => Math.min(total, c + 1)), msPerBar(speed));
    return () => clearInterval(id);
  }, [playing, speed, total]);
  useEffect(() => { if (playing && total > 0 && cursor >= total) setPlaying(false); }, [playing, cursor, total]);

  const reset = useCallback(() => {
    seekRef.current = true;
    setPlaying(false);
    setCursor(0);
    setLog([]);
  }, []);
  const togglePlay = useCallback(() => {
    if (!data || total === 0) return;
    if (playing) { setPlaying(false); return; }
    if (cursor >= total) { seekRef.current = true; setCursor(0); setLog([]); }
    setPlaying(true);
  }, [data, total, playing, cursor]);

  // Space plays / pauses (ignored while typing in a field or when a button has focus, which Space already activates).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  // ── charts: only the bars up to the replay time exist ───────────────────
  const strikes = useMemo(() => data?.strikes ?? [0, 0, 0], [data]);
  const models = useMemo(
    () => strikes.map(strike => buildPanelModel(data ? barsUpTo(data.bars[String(strike)] ?? [], T) : [], overlay, settings)),
    [data, strikes, T, overlay, settings],
  );

  // ── alerts: only bars that close during playback; a jump (load / scrub / reset) re-baselines the watermark silently ──
  useEffect(() => {
    if (!data) return;
    const jumped = seekRef.current;
    seekRef.current = false;
    const fresh: LogEntry[] = [];
    data.strikes.forEach((strike, i) => {
      const k = String(strike);
      const m = models[i];
      if (jumped) { watermarkRef.current[k] = m.lastBarT ?? watermarkRef.current[k] ?? 0; return; }
      const wm = watermarkRef.current[k] ?? m.lastBarT ?? 0;
      for (const s of newSignalsAfter(m.signals, wm)) {
        fresh.push({ id: `${strike}:${data.expiry}:${s.kind}:${s.t}`, t: s.t, strike, kind: s.kind, price: s.price, belowVwap: s.belowVwap });
      }
      watermarkRef.current[k] = nextWatermark(wm, m.lastBarT);
    });
    if (!fresh.length) return;
    setLog(prev => fresh.filter(e => !prev.some(p => p.id === e.id)).reduce((l, e) => capLog(l, e), prev));
    for (const e of fresh) {
      const sell = e.kind === 'DOUBLE_BOTTOM_SELL';
      const title = `${e.strike} straddle · ${sell ? 'Double bottom SELL' : 'Double top BUY'} @ ${e.price.toFixed(2)}`;
      if (sell) toast.error(title, { description: e.belowVwap ? 'Below VWAP — entry zone' : undefined });
      else toast.success(title);
      setFlash(f => ({ ...f, [e.strike]: sell ? 'sell' : 'buy' }));
      flashTimers.current.push(setTimeout(() => setFlash(f => { const rest = { ...f }; delete rest[e.strike]; return rest; }), FLASH_MS));
    }
    if (!mutedRef.current) {
      const last = fresh[fresh.length - 1];
      if (last.kind === 'DOUBLE_BOTTOM_SELL') playEntryChime(); else playExitChime();
    }
  }, [models, data]);

  const applySettings = (next: PnfSettings) => {
    seekRef.current = true;             // the charts are about to be redrawn from the same bars: re-baseline, alert on nothing
    setSettings(next);
    savePref(SETTINGS_KEY, serializeSettings(next));
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    savePref(SOUND_KEY, next ? '0' : '1');
  };

  // ── derived header values ──────────────────────────────────────────────
  const shownT = data ? Math.max(T, data.replayStartT) : 0;
  const spot = data ? valueAt(data.spotT, data.spotV, shownT) : null;
  const dataDate = data ? sessionOf(shownT) : null;
  const maxCoverage = data ? Math.max(0, ...Object.values(data.coverage)) : 0;
  const thin = data ? data.strikes.filter(s => (data.coverage[String(s)] ?? 0) < maxCoverage * 0.99) : [];

  const seg = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-bold rounded-md transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`;
  const field = 'h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200';
  const iconBtn = 'inline-flex items-center justify-center h-7 w-7 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800';
  const info = expiries.find(e => e.expiry === expiry);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <FlaskConical className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Scalping · NIFTY replay</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Straddle Simulator</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Replay past sessions · {settings.interval}-min · {settings.boxPct}% box · {settings.reversal}-box reversal · signals only</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Index
            <select aria-label="Index" value={index} onChange={e => setIndex(e.target.value)} className={field}>
              <option value="NIFTY">NIFTY</option>
              <option value="SENSEX" disabled>SENSEX — no data</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Expiry
            <select aria-label="Expiry" value={expiry} onChange={e => pickExpiry(expiries, e.target.value)} className={field}
                    title={info ? `Data from ${info.first} to ${info.last}` : undefined}>
              {expiries.map(e => <option key={e.expiry} value={e.expiry}>{e.expiry}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            From
            <input aria-label="From" type="date" value={from} min={info?.first} max={istYesterday()} onChange={e => setFrom(e.target.value)} className={field} />
          </label>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            To
            <input aria-label="To" type="date" value={to} min={info?.first} max={istYesterday()} onChange={e => setTo(e.target.value)} className={field} />
          </label>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            ATM
            <input aria-label="ATM" type="text" inputMode="numeric" value={atmText} onChange={e => setAtmText(e.target.value)} placeholder="auto"
                   className={`${field} w-20`} />
          </label>
          <button type="button" onClick={() => setAtmText('auto')} className="h-7 px-2 rounded-md border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-300 hover:bg-zinc-800">Auto</button>
          <button type="button" onClick={load} aria-busy={loading} disabled={loading}
                  className="h-7 px-3 rounded-md bg-emerald-600 text-[11px] font-bold text-oncolor hover:bg-emerald-500 disabled:opacity-60">
            {loading ? 'Loading…' : 'Load'}
          </button>
          <DataChip date={dataDate} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-3 px-4 py-4">
        {error && <p role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{error}</p>}
        {thin.length > 0 && data && (
          <p role="status" className="text-xs text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-md px-3 py-2">
            The store is missing some minutes for {thin.map(s => `${s} (${data.coverage[String(s)]} of ${maxCoverage} bars)`).join(', ')}; those charts have gaps.
          </p>
        )}

        <div className="relative">
        <div className="flex items-center gap-3 flex-wrap rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
          <button type="button" onClick={togglePlay} disabled={!data || total === 0} aria-label={playing ? 'Pause' : 'Play'}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-600 text-xs font-bold text-oncolor hover:bg-emerald-500 disabled:opacity-50">
            {playing ? <Pause className="w-3.5 h-3.5" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={reset} disabled={!data} aria-label="Reset" className={`${iconBtn} h-8 w-8 disabled:opacity-50`}>
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Speed">
            {SPEEDS.map(s => (
              <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)} className={seg(speed === s)}>{s}X</button>
            ))}
          </div>
          <input
            type="range" aria-label="Replay position" min={0} max={total} step={1} value={cursor} disabled={!data || total === 0}
            onChange={e => { seekRef.current = true; setCursor(Number(e.target.value)); }}
            className="flex-1 min-w-40 accent-emerald-500"
          />
          <span data-testid="sim-clock" className="text-xs font-mono text-zinc-300">
            {data ? `${clockLabel(shownT)} · minute ${cursor} of ${total}` : 'Load a range to start'}
          </span>
          <span data-testid="sim-spot" className="text-xs font-mono text-zinc-300">Spot <b className="text-white">{spot !== null ? fmt(spot) : '—'}</b></span>
          {data?.preloadSession && <span className="text-[10px] font-mono text-zinc-500">Preloaded {data.preloadSession}</span>}
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <SettingsControls settings={settings} onChange={applySettings} />
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Overlay">
            <button type="button" aria-pressed={overlay === 'vwap'} onClick={() => setOverlay('vwap')} className={seg(overlay === 'vwap')}>VWAP</button>
            <button type="button" aria-pressed={overlay === 'sma'} onClick={() => setOverlay('sma')} className={seg(overlay === 'sma')}>SMA 10</button>
          </div>
          <button type="button" aria-label="Alert log" aria-pressed={logOpen} onClick={() => setLogOpen(o => !o)} className={`${iconBtn} relative`}>
            <Bell className="w-3.5 h-3.5" aria-hidden="true" />
            {log.length > 0 && <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-emerald-500 text-oncolor text-[9px] font-bold leading-4 text-center">{log.length}</span>}
          </button>
          <button type="button" aria-label={muted ? 'Unmute alert sound' : 'Mute alert sound'} aria-pressed={muted} onClick={toggleMute} className={iconBtn}>
            {muted ? <VolumeX className="w-3.5 h-3.5" aria-hidden="true" /> : <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
        </div>

        {logOpen && <div className="absolute right-0 top-full mt-2 z-40 w-96 shadow-xl"><AlertLog entries={log} /></div>}
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-3 gap-3" style={{ gridTemplateRows: 'minmax(0, 1fr)' }}>
          {strikes.map((strike, i) => {
            const shown = data ? barsUpTo(data.bars[String(strike)] ?? [], T) : [];
            const last = shown[shown.length - 1];
            return (
              <PnfPanel
                key={i}
                title={`${TITLES[i]} · ${strike || '—'} straddle`}
                strike={strike}
                model={models[i]}
                live={last ? { ce: last.ce, pe: last.pe } : null}
                overlay={overlay}
                stale={false}
                flash={flash[strike] ?? null}
                loading={loading}
                interval={settings.interval}
                boxPct={settings.boxPct}
                reversal={settings.reversal}
                fill
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
