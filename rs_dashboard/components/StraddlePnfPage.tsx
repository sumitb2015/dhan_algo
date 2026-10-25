'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, ChartScatter, LocateFixed, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from './NavBar';
import DataChip from './DataChip';
import PnfPanel from './straddlePnf/PnfPanel';
import AlertLog, { type LogEntry } from './straddlePnf/AlertLog';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useTabLeader } from '@/hooks/useTabLeader';
import { installAlertSoundUnlock, playEntryChime, playExitChime } from '@/lib/alertSound';
import { buildPanelModel, type Overlay } from '@/lib/straddlePnfModel';
import { foldTick, newSignalsAfter, nextWatermark, capLog } from '@/lib/straddlePnfLive';
import { historyQuery, tickAcceptable } from '@/lib/straddlePnfLoad';
import { pickExpiries, type PnfExpiry } from '@/lib/straddlePnfExpiries';
import type { Bar } from '@/lib/straddlePnf';

// Straddle Point & Figure: three NIFTY straddle charts (ATM-200 / ATM / ATM+200), signals only — this page places no orders.

type Row = { bars: Bar[]; openT: number | null };
type Loaded = { expiry: string; atm: number; strikes: number[]; dataDate: string | null; errors: Record<string, string> };

const STALE_MS = 60_000;
const POLL_FALLBACK_MS = 60_000;
const FLASH_MS = 4000;
const TITLES = ['ATM −200', 'ATM', 'ATM +200'];
const LOG_KEY = 'straddle-pnf-log';
const SOUND_KEY = 'straddle-pnf-sound';
const OVERLAY_KEY = 'straddle-pnf-overlay';

const minuteOf = (t: number) => Math.floor(t / 60) * 60;
const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function readPref(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private window / blocked storage: the page works without it */ }
}

export default function StraddlePnfPage() {
  const [expiries, setExpiries] = useState<PnfExpiry[]>([]);
  const [expiry, setExpiry] = useState('');
  const [overlay, setOverlay] = useState<Overlay>('vwap');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recenter, setRecenter] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [flash, setFlash] = useState<Record<string, 'buy' | 'sell'>>({});
  const [now, setNow] = useState(0);
  const [fallback, setFallback] = useState<{ spot: number | null; future: number | null }>({ spot: null, future: null });

  const { leaderRef } = useTabLeader('straddle-pnf');
  const mutedRef = useRef(false);
  const reqRef = useRef(0);
  const lastTickRef = useRef<string | null>(null);
  // Per strike: the last closed bar already evaluated for alerts. Alerts are keyed on bar time, never on column numbers.
  const watermarkRef = useRef<Record<string, number>>({});
  const loadedAtmRef = useRef<number | null>(null);
  const logLoadedRef = useRef(false);

  const { liveQuotes } = useLiveOptionsWS(expiry, 'dhan', ['dhan'], 'NIFTY');

  // ── preferences, sound unlock, clock ────────────────────────────────────
  useEffect(() => installAlertSoundUnlock(), []);
  useEffect(() => {
    if (readPref(OVERLAY_KEY) === 'sma') setOverlay('sma');
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

  // ── expiries ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/options/expiries?underlying=NIFTY')
      .then(r => r.json())
      .then((j: { success?: boolean; data?: string[] }) => {
        if (cancelled || !j.success || !Array.isArray(j.data)) return;
        const picked = pickExpiries(j.data, istToday());
        setExpiries(picked);
        setExpiry(prev => prev || picked[0]?.value || '');
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load expiries'); });
    return () => { cancelled = true; };
  }, []);

  // ── history load. reset = new expiry / Re-center (new strikes, alerts restart); otherwise a quiet refresh ──
  const load = useCallback(async (reset: boolean) => {
    if (!expiry) return;
    const id = ++reqRef.current;
    if (reset) { setLoading(true); setLoadError(null); }
    try {
      const res = await fetch(`/api/straddle-pnf?${historyQuery(expiry, reset, loadedAtmRef.current)}`);
      const j = await res.json() as {
        success?: boolean; error?: string; atm: number; strikes: number[]; dataDate: string | null;
        bars: Record<string, Bar[]>; errors: Record<string, string>;
      };
      if (id !== reqRef.current) return; // a newer request owns the screen
      if (!j.success) throw new Error(j.error ?? 'Failed to load straddle history');
      const nowMin = minuteOf(Date.now() / 1000);
      const next: Record<string, Row> = {};
      for (const strike of j.strikes) {
        const k = String(strike);
        const bars = j.bars[k] ?? [];
        const last = bars[bars.length - 1];
        const open = last && last.t >= nowMin ? last.t : null; // the minute still forming is not closed yet
        next[k] = { bars, openT: open };
        if (reset) {
          // History never alerts: only bars that close after the last CLOSED history bar can (a bar still forming at load can).
          const lastClosed = open !== null ? bars[bars.length - 2] : last;
          watermarkRef.current[k] = lastClosed ? lastClosed.t : 0;
        }
      }
      if (reset) loadedAtmRef.current = j.atm;
      setRows(next);
      setLoaded({ expiry, atm: j.atm, strikes: j.strikes, dataDate: j.dataDate, errors: j.errors ?? {} });
      setLoadError(null);
    } catch (e) {
      if (id !== reqRef.current) return;
      setLoadError(e instanceof Error ? e.message : 'Failed to load straddle history');
    } finally {
      if (id === reqRef.current) setLoading(false);
    }
  }, [expiry]);

  useEffect(() => { void load(true); }, [load, recenter]);

  const liveFresh = useMemo(() => {
    if (!liveQuotes?.updated_at || now === 0) return false;
    const t = Date.parse(liveQuotes.updated_at);
    return Number.isFinite(t) && now - t < STALE_MS && Object.keys(liveQuotes.strikes ?? {}).length > 0;
  }, [liveQuotes, now]);

  // Bridge down or stale: fall back to polling the history API so the charts keep moving.
  useEffect(() => {
    if (liveFresh || !expiry) return;
    const id = setInterval(() => { void load(false); }, POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [liveFresh, expiry, load]);

  // Index and futures price for the header: the live feed when it is fresh, otherwise the option-chain route (rate-limited, polled slowly).
  useEffect(() => {
    if (liveFresh || !expiry) return;
    let cancelled = false;
    const pull = () => fetch(`/api/options/chain?underlying=NIFTY&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { data?: { spot?: number; future_price?: number } }) => {
        if (cancelled) return;
        setFallback({ spot: Number(j.data?.spot) > 0 ? Number(j.data?.spot) : null, future: Number(j.data?.future_price) > 0 ? Number(j.data?.future_price) : null });
      })
      .catch(() => { /* header shows a dash; the charts do not depend on it */ });
    void pull();
    const id = setInterval(pull, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [liveFresh, expiry]);
  const headerSpot = liveFresh && liveQuotes?.spot ? liveQuotes.spot : fallback.spot;
  const headerFuture = liveFresh && liveQuotes?.future?.ltp ? liveQuotes.future.ltp : fallback.future;

  // ── live ticks → open bar ───────────────────────────────────────────────
  useEffect(() => {
    if (!liveQuotes?.updated_at || !loaded || liveQuotes.updated_at === lastTickRef.current) return;
    // Never fold a tick into history of a different expiry (a switch is still loading) — it would jump a closed bar between contracts.
    if (!tickAcceptable(expiry, loaded.expiry, liveQuotes.expiry)) return;
    const t = Date.parse(liveQuotes.updated_at) / 1000; // the tick's own time, so a slow render never mis-buckets a minute
    if (!Number.isFinite(t)) return;
    lastTickRef.current = liveQuotes.updated_at;
    const quotes = Object.values(liveQuotes.strikes ?? {});
    setRows(prev => {
      let changed = false;
      const next = { ...prev };
      for (const strike of loaded.strikes) {
        const q = quotes.find(s => Number(s.strike) === strike);
        const row = prev[String(strike)];
        if (!q || !row) continue;
        const cumVol = Number(q.ce?.volume) + Number(q.pe?.volume); // the bridge's cumulative day volume, same units as history
        const res = foldTick(row.bars, { t, ce: Number(q.ce?.ltp), pe: Number(q.pe?.ltp), cumVol: Number.isFinite(cumVol) ? cumVol : undefined });
        if (res.bars === row.bars) continue;
        changed = true;
        next[String(strike)] = { bars: res.bars, openT: res.bars[res.bars.length - 1].t };
      }
      return changed ? next : prev;
    });
  }, [liveQuotes, loaded, expiry]);

  // ── panel models: CLOSED bars only, so a signal never repaints ──────────
  const strikes = useMemo(() => loaded?.strikes ?? [0, 0, 0], [loaded]);
  const models = useMemo(() => strikes.map(strike => {
    const row = rows[String(strike)];
    const bars = row?.bars ?? [];
    const forming = row?.openT != null && bars[bars.length - 1]?.t === row.openT;
    return buildPanelModel(forming ? bars.slice(0, -1) : bars, overlay);
  }), [rows, strikes, overlay]);

  // ── alerts: new signals on newly closed bars, once each ─────────────────
  useEffect(() => {
    if (!loaded) return;
    const fresh: LogEntry[] = [];
    loaded.strikes.forEach((strike, i) => {
      const k = String(strike);
      const wm = watermarkRef.current[k] ?? models[i].lastBarT ?? 0; // a strike with no watermark never alerts on what is already there
      for (const s of newSignalsAfter(models[i].signals, wm)) {
        fresh.push({ id: `${strike}:${loaded.expiry}:${s.kind}:${s.t}`, t: s.t, strike, kind: s.kind, price: s.price, belowVwap: s.belowVwap });
      }
      watermarkRef.current[k] = nextWatermark(wm, models[i].lastBarT);
    });
    if (!fresh.length) return;
    setLog(prev => fresh.filter(e => !prev.some(p => p.id === e.id)).reduce((l, e) => capLog(l, e), prev));
    for (const e of fresh) {
      const sell = e.kind === 'DOUBLE_BOTTOM_SELL';
      const title = `${e.strike} straddle · ${sell ? 'Double bottom SELL' : 'Double top BUY'} @ ${e.price.toFixed(2)}`;
      if (sell) toast.error(title, { description: e.belowVwap ? 'Below VWAP — entry zone' : undefined });
      else toast.success(title);
      setFlash(f => ({ ...f, [e.strike]: sell ? 'sell' : 'buy' }));
      setTimeout(() => setFlash(f => { const rest = { ...f }; delete rest[e.strike]; return rest; }), FLASH_MS);
    }
    // Sound only in the leader tab, so two open tabs never double-ring; the toast and log still show everywhere.
    if (leaderRef.current && !mutedRef.current) {
      const last = fresh[fresh.length - 1];
      if (last.kind === 'DOUBLE_BOTTOM_SELL') playEntryChime(); else playExitChime();
    }
  }, [models, loaded, leaderRef]);

  const pickOverlay = (o: Overlay) => { setOverlay(o); savePref(OVERLAY_KEY, o); };
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

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <ChartScatter className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Scalping · NIFTY</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Straddle Point &amp; Figure</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">1-min · 0.5% box · 3-box reversal · signals only</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span data-testid="pnf-spot" className="text-xs font-mono text-zinc-300">
            Nifty <b className="text-white">{headerSpot ? fmt(headerSpot) : '—'}</b>
          </span>
          <span data-testid="pnf-future" className="text-xs font-mono text-zinc-300">
            Fut <b className="text-white">{headerFuture ? fmt(headerFuture) : '—'}</b>
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <select
            aria-label="Expiry"
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            className="h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200"
          >
            {expiries.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-900" role="group" aria-label="Overlay">
            <button type="button" aria-pressed={overlay === 'vwap'} onClick={() => pickOverlay('vwap')} className={seg(overlay === 'vwap')}>VWAP</button>
            <button type="button" aria-pressed={overlay === 'sma'} onClick={() => pickOverlay('sma')} className={seg(overlay === 'sma')}>SMA 10</button>
          </div>
          <button type="button" onClick={() => setRecenter(n => n + 1)} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800">
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

      <div className="flex-1 flex flex-col gap-3 px-4 py-4">
        {loadError && <p role="alert" className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-md px-3 py-2">{loadError}</p>}
        {logOpen && <AlertLog entries={log} />}
        <div className="grid grid-cols-3 gap-3">
          {strikes.map((strike, i) => {
            const row = rows[String(strike)];
            const last = row?.bars[row.bars.length - 1];
            return (
              <PnfPanel
                key={i}
                title={`${TITLES[i]} · ${strike || '—'} straddle`}
                strike={strike}
                model={models[i]}
                live={last ? { ce: last.ce, pe: last.pe } : null}
                overlay={overlay}
                stale={!liveFresh}
                flash={flash[strike] ?? null}
                loading={loading && !row}
                error={loaded?.errors[String(strike)]}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
