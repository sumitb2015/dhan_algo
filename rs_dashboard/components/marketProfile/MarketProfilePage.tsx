'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NavBar from '@/components/NavBar';
import TpoChart, { type ProfileNote, type TpoOverlays, type TpoStyle } from './TpoChart';
import {
  averageIb,
  buildCompositeProfiles,
  buildDayProfiles,
  classifyDay,
  isoWeekKey,
  MAX_ROWS_PER_PROFILE,
  minRowSize,
  nakedPocs,
  powerDegree,
  splitSessions,
  suggestRowSize,
  tpoSkew,
  vaTop,
  type Bar,
  type Profile,
} from '@/lib/marketProfile';
import type { FootprintFetchResponse } from '@/app/api/volume-footprint/route';
import type { UniverseIndex, UniverseResponse } from '@/app/api/volume-footprint/universe/route';
import { isNseCashLive } from '@/lib/marketHours';
import { istToday } from '@/lib/istTime';
import { readPref, savePref } from '@/lib/localPref';
import { ChartNoAxesGantt, RefreshCw } from 'lucide-react';

type View = 'day' | 'week' | 'month';

interface Config {
  symbol: string;
  view: View;
  days: number;
  periodMin: number;
  /** 0 = automatic. */
  rowSize: number;
  vaPct: number;
  style: TpoStyle;
  show: TpoOverlays;
  live: boolean;
}

const DEFAULT_CONFIG: Config = {
  symbol: 'NIFTY',
  view: 'day',
  days: 10,
  periodMin: 30,
  rowSize: 0,
  vaPct: 70,
  style: 'letters',
  show: { ib: true, va: true, singles: true, nakedPoc: true, prevVa: false, vpoc: false, stats: true },
  live: true,
};

const PREF_KEY = 'market-profile-config';
/** Sessions fetched for composites: ~10 weeks or ~2 months (the fetcher's cap). */
const COMPOSITE_DAYS = 50;
const DAY_OPTIONS = [5, 10, 20, 30, 50];
const LIVE_POLL_MS = 10_000;
const STALE_BAR_MS = 3 * 60_000;

const OVERLAY_LABELS: [keyof TpoOverlays, string, string][] = [
  ['ib', 'IB', 'Initial balance bar (first hour)'],
  ['va', 'VA', 'Value area lines and shading'],
  ['singles', 'Singles', 'Single prints and tails'],
  ['nakedPoc', 'nPOC', 'Naked (untested) points of control'],
  ['prevVa', 'Prev VA', "Previous profile's value area carried forward"],
  ['vpoc', 'VPOC', 'Volume point of control (stocks only)'],
  ['stats', 'Stats', 'Stats block under each profile'],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`;
}

function profileLabel(p: Profile): string {
  if (p.kind === 'day') return dayLabel(p.start);
  if (p.kind === 'week') return `${p.key.slice(5)} · ${dayLabel(p.start).slice(4)}`;
  const [y, m] = p.key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Merge today's live bars over the history load: the live poll owns its own session date(s). */
function mergeLive(history: Bar[], live: Bar[]): Bar[] {
  if (live.length === 0) return history;
  const liveDays = new Set(live.map((b) => b.t.slice(0, 10)));
  return [...history.filter((b) => !liveDays.has(b.t.slice(0, 10))), ...live];
}

interface Loaded {
  key: string;
  bars: Bar[];
  meta: FootprintFetchResponse;
}

const NO_BARS: Bar[] = [];

function Segmented<T extends string>({
  value, options, onChange, label,
}: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`px-2 py-0.5 rounded-md text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
            value === v ? 'bg-sky-500/20 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Row size: free-typed, so it commits on blur / Enter only (a half-typed "0.0" must not re-bucket 20k cells). */
function RowSizeInput({ value, auto, onCommit }: { value: number; auto: number; onCommit: (v: number) => void }) {
  // The parent remounts this with key={value}, so the draft resets on a committed change.
  const [draft, setDraft] = useState(value > 0 ? String(value) : '');
  const commit = () => {
    const n = Number(draft);
    onCommit(Number.isFinite(n) && n > 0 ? n : 0);
  };
  return (
    <label className="flex items-center gap-1 text-[11px] text-zinc-400">
      Row
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder={`auto ${auto}`}
        inputMode="decimal"
        aria-label="Row size in price points (blank = automatic)"
        className="w-20 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[11px] text-zinc-400">{label}</span>
      <span className={`text-xs font-mono font-semibold ${tone ?? 'text-zinc-100'}`}>{value}</span>
    </div>
  );
}

export default function MarketProfilePage() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [indices, setIndices] = useState<UniverseIndex[]>([]);
  const [stocks, setStocks] = useState<string[]>([]);
  const [history, setHistory] = useState<Loaded | null>(null);
  const [live, setLive] = useState<{ key: string; bars: Bar[]; at: number } | null>(null);
  // Errors carry the request key they belong to, so a failure on one symbol is not shown
  // (as "No session data") while the next symbol is still loading.
  const [error, setError] = useState<{ key: string; msg: string } | null>(null);
  const [liveError, setLiveError] = useState<{ key: string; msg: string; since: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Wall clock for the stale banner and market-open chip; Date.now() in render is impure.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  // Restore after mount: localStorage during render would break hydration.
  useEffect(() => {
    try {
      const raw = readPref(PREF_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Config>;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
        setConfig({ ...DEFAULT_CONFIG, ...saved, show: { ...DEFAULT_CONFIG.show, ...(saved.show ?? {}) } });
      }
    } catch { /* defaults */ }
  }, []);
  const patch = useCallback((p: Partial<Config>) => {
    setConfig((c) => {
      const next = { ...c, ...p };
      savePref(PREF_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    fetch('/api/volume-footprint/universe')
      .then((r) => r.json())
      .then((j: UniverseResponse) => {
        if (j.success) {
          setIndices(j.indices);
          setStocks(j.stocks);
        }
      })
      .catch(() => { /* the picker falls back to the current symbol */ });
  }, []);

  const fetchDays = config.view === 'day' ? config.days : COMPOSITE_DAYS;
  const histKey = `${config.symbol}|${fetchDays}`;

  // One history request at a time. A newer load (effect or the Reload button) aborts the
  // older one, and the sequence check drops any reply that still lands late: a manual reload
  // of the previous symbol must never overwrite the current one's key (that left the page on
  // the loading spinner forever).
  const histSeq = useRef(0);
  const histAbort = useRef<AbortController | null>(null);
  const loadHistory = useCallback(async () => {
    histAbort.current?.abort();
    const ctrl = new AbortController();
    histAbort.current = ctrl;
    const seq = ++histSeq.current;
    const key = histKey;
    try {
      const res = await fetch(
        `/api/volume-footprint?symbol=${encodeURIComponent(config.symbol)}&days=${fetchDays}`,
        { signal: ctrl.signal },
      );
      const json: FootprintFetchResponse = await res.json();
      if (seq !== histSeq.current) return;
      if (!json.success) {
        setError({ key, msg: json.error ?? 'Failed to load 1-minute bars' });
        return;
      }
      setHistory({ key, bars: json.bars ?? [], meta: json });
      setError(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (seq === histSeq.current) setError({ key, msg: e instanceof Error ? e.message : String(e) });
    }
  }, [config.symbol, fetchDays, histKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadHistory sets state only after its fetch resolves
    void loadHistory();
  }, [loadHistory]);
  useEffect(() => () => histAbort.current?.abort(), []);

  // Live: poll only today's session (days=1) and merge it over the history — re-fetching
  // 50 sessions every 10 s would respawn an 18k-bar Dhan pull each time. Failures are
  // surfaced (expired token, Dhan error), never swallowed: a dead feed under a pulsing
  // "10s Live" chip reads as a quiet market.
  const liveSeq = useRef(0);
  useEffect(() => {
    if (!config.live) return;
    const ctrl = new AbortController();
    const key = config.symbol;
    const fail = (msg: string) =>
      setLiveError((prev) => ({ key, msg, since: prev?.key === key ? prev.since : Date.now() }));
    const tick = async () => {
      if (!isNseCashLive(new Date())) return;
      const seq = ++liveSeq.current;
      try {
        const res = await fetch(`/api/volume-footprint?symbol=${encodeURIComponent(key)}&days=1`, { signal: ctrl.signal });
        const json: FootprintFetchResponse = await res.json();
        // Drop out-of-order replies: an older poll must not overwrite a newer one.
        if (seq !== liveSeq.current) return;
        if (!json.success) {
          fail(json.error ?? 'live poll failed');
          return;
        }
        setLive({ key, bars: json.bars ?? [], at: Date.now() });
        setLiveError(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (seq === liveSeq.current) fail(e instanceof Error ? e.message : String(e));
      }
    };
    const timer = setInterval(tick, LIVE_POLL_MS);
    return () => {
      clearInterval(timer);
      ctrl.abort();
    };
  }, [config.live, config.symbol]);

  const refreshNow = useCallback(async () => {
    setBusy(true);
    try {
      await loadHistory();
    } finally {
      setBusy(false);
    }
  }, [loadHistory]);

  const current = history?.key === histKey ? history : null;
  const histBars = current?.bars ?? NO_BARS;
  const liveBars = live?.key === config.symbol ? live.bars : NO_BARS;
  const bars = useMemo(() => mergeLive(histBars, liveBars), [histBars, liveBars]);
  const meta = current?.meta ?? null;
  const today = istToday();

  // ── derived profiles: every control recomputes client-side, no refetch ──
  // Row size comes from the HISTORY load, never the live merge, and the automatic one
  // ignores today's still-growing range: otherwise a live tick that nudges the median across
  // a ladder step re-buckets every profile and resets the user's zoom mid-session.
  const { autoRowSize, minRow } = useMemo(() => {
    const groups = new Map<string, { h: number; l: number; today: boolean }>();
    for (const [day, list] of splitSessions(histBars)) {
      const k = config.view === 'day' ? day : config.view === 'week' ? isoWeekKey(day) : day.slice(0, 7);
      const g = groups.get(k) ?? { h: -Infinity, l: Infinity, today: false };
      for (const b of list) {
        g.h = Math.max(g.h, b.h);
        g.l = Math.min(g.l, b.l);
      }
      if (day === today) g.today = true;
      groups.set(k, g);
    }
    const all = [...groups.values()];
    const settled = all.filter((g) => !g.today);
    const ranges = (settled.length ? settled : all).map((g) => g.h - g.l);
    return {
      autoRowSize: suggestRowSize(ranges, config.view === 'day' ? 50 : 60),
      minRow: minRowSize(Math.max(0, ...all.map((g) => g.h - g.l))),
    };
  }, [histBars, config.view, today]);
  // A manual row size below the drawable minimum is raised (a 0.05 row on a monthly NIFTY
  // profile is ~30k rows and freezes the tab).
  const rowRaised = config.rowSize > 0 && config.rowSize < minRow;
  const rowSize = config.rowSize > 0 ? Math.max(config.rowSize, minRow) : autoRowSize;

  const profiles = useMemo(() => {
    if (bars.length === 0) return [];
    const opts = { rowSize, periodMin: config.periodMin, vaPct: config.vaPct, today };
    return config.view === 'day' ? buildDayProfiles(bars, opts) : buildCompositeProfiles(bars, config.view, opts);
  }, [bars, rowSize, config.periodMin, config.vaPct, config.view, today]);

  const notes = useMemo(() => {
    const m = new Map<string, ProfileNote>();
    profiles.forEach((p, i) => {
      m.set(p.key, {
        label: profileLabel(p),
        dayType: p.kind === 'day'
          ? (() => {
            const t = classifyDay(p, averageIb(profiles, i));
            return t && p.developing ? `${t} (developing)` : t;
          })()
          : null,
        power: i > 0 ? powerDegree(p, profiles[i - 1], p.close) : null,
      });
    });
    return m;
  }, [profiles]);

  // The newest profile's POC has no later session to test it, so it is never "naked" — on the
  // chart or in the panel.
  const nPocs = useMemo(() => {
    const lastKey = profiles[profiles.length - 1]?.key;
    return nakedPocs(profiles).filter((n) => n.key !== lastKey);
  }, [profiles]);
  const lastPrice = bars.length ? bars[bars.length - 1].c : null;

  const selected = profiles.find((p) => p.key === selectedKey) ?? profiles[profiles.length - 1] ?? null;
  const selIdx = selected ? profiles.indexOf(selected) : -1;
  const selPrev = selIdx > 0 ? profiles[selIdx - 1] : null;
  const selNote = selected ? notes.get(selected.key) : undefined;

  const lastBarT = bars.length ? bars[bars.length - 1].t : null;
  const dataDate = lastBarT?.slice(0, 10) ?? null;
  const marketOpen = clock > 0 && isNseCashLive(new Date(clock));
  const stale = config.live && marketOpen && live?.key === config.symbol && clock - live.at > STALE_BAR_MS;
  const liveFailing = config.live && marketOpen && liveError?.key === config.symbol ? liveError : null;
  const histError = error?.key === histKey ? error.msg : null;
  const openNaked = nPocs.filter((n) => !n.touchedBy);
  const fitKey = `${config.symbol}|${config.view}|${rowSize}|${config.periodMin}|${fetchDays}|${config.show.stats}`;

  const symbolOptions = useMemo(() => {
    const idx = indices.length ? indices : [{ symbol: 'NIFTY', exchange: 'NSE', label: 'NIFTY 50' }];
    return { idx, stocks };
  }, [indices, stocks]);

  const loading = !current && !histError;
  const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* HEADER */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-sky-500/10 border border-sky-500/25">
            <ChartNoAxesGantt className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-sky-400 mb-0.5">Market Structure · {config.symbol}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Market Profile (TPO)</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Time at price · {config.periodMin}-min periods · {config.vaPct}% value area · row {rowSize}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={config.symbol}
            onChange={(e) => { patch({ symbol: e.target.value, rowSize: 0 }); setSelectedKey(null); }}
            aria-label="Symbol"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs font-semibold text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400"
          >
            <optgroup label="Indices">
              {symbolOptions.idx.map((i) => <option key={i.symbol} value={i.symbol}>{i.label}</option>)}
            </optgroup>
            {symbolOptions.stocks.length > 0 && (
              <optgroup label="F&O stocks">
                {symbolOptions.stocks.map((s) => <option key={s} value={s}>{s}</option>)}
              </optgroup>
            )}
            {!symbolOptions.idx.some((i) => i.symbol === config.symbol) && !stocks.includes(config.symbol) && (
              <option value={config.symbol}>{config.symbol}</option>
            )}
          </select>
          <Segmented
            label="Profile period"
            value={config.view}
            options={[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]}
            onChange={(v) => { patch({ view: v }); setSelectedKey(null); }}
          />
          {config.view === 'day' && (
            <select
              value={config.days}
              onChange={(e) => patch({ days: Number(e.target.value) })}
              aria-label="Sessions"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-sky-400"
            >
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          )}
          <select
            value={config.periodMin}
            onChange={(e) => patch({ periodMin: Number(e.target.value) })}
            aria-label="TPO period minutes"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-sky-400"
          >
            {[15, 30, 60].map((m) => <option key={m} value={m}>{m}m TPO</option>)}
          </select>
          <RowSizeInput key={config.rowSize} value={config.rowSize} auto={autoRowSize} onCommit={(v) => patch({ rowSize: v })} />
          <select
            value={config.vaPct}
            onChange={(e) => patch({ vaPct: Number(e.target.value) })}
            aria-label="Value area percent"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-sky-400"
          >
            {[60, 68, 70, 80].map((p) => <option key={p} value={p}>VA {p}%</option>)}
          </select>
          <button
            type="button"
            onClick={() => patch({ live: !config.live })}
            aria-pressed={config.live}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
              config.live ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-zinc-900 text-zinc-500 border-zinc-800'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${liveFailing ? 'bg-amber-400' : config.live && marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
            {config.live ? (marketOpen ? '10s Live' : 'Live (closed)') : 'Paused'}
          </button>
          <button
            type="button"
            onClick={refreshNow}
            disabled={busy}
            aria-label="Reload history"
            title="Reload history"
            className="p-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate ?? '—'}{dataDate && dataDate !== today ? ' · last session' : ''}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 px-6 py-4">
        {/* SECOND ROW: style + overlays */}
        <div className="flex items-center gap-2 flex-wrap">
          <Segmented
            label="Chart style"
            value={config.style}
            options={[['letters', 'Letters'], ['blocks', 'Blocks'], ['histogram', 'Histogram']]}
            onChange={(v) => patch({ style: v })}
          />
          <span className="w-px h-5 bg-zinc-800" />
          {OVERLAY_LABELS.map(([k, text, title]) => (
            <button
              key={k}
              type="button"
              title={title}
              aria-pressed={config.show[k]}
              onClick={() => patch({ show: { ...config.show, [k]: !config.show[k] } })}
              className={`px-2 py-0.5 rounded-md border text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                config.show[k] ? 'bg-sky-500/15 text-sky-300 border-sky-500/30' : 'bg-zinc-900 text-zinc-500 border-zinc-800'
              }`}
            >
              {text}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-zinc-500">
            {meta ? `${meta.sessions ?? 0} sessions · source ${meta.source ?? '—'}` : ''} · wheel zoom · Shift+wheel width · drag price axis height · drag pan · double-click fit
          </span>
        </div>

        {histError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 p-3 rounded-xl text-xs flex items-center justify-between">
            <span>{histError}</span>
            <button type="button" onClick={refreshNow} className="underline font-bold hover:text-red-200">Retry</button>
          </div>
        )}
        {meta?.api_error && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-[11px]">
            Dhan reported: {meta.api_error} — the profile may be incomplete.
          </div>
        )}
        {liveFailing && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-[11px]">
            Live updates are failing ({liveFailing.msg}) — today&apos;s profile is not updating. Check the Dhan session.
          </div>
        )}
        {rowRaised && (
          <div className="text-[11px] text-amber-300">
            Row {config.rowSize} would draw over {MAX_ROWS_PER_PROFILE} rows per profile — using {rowSize} instead.
          </div>
        )}
        {stale && !liveFailing && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-[11px]">
            Live updates have stalled for over 3 minutes — today&apos;s profile may be behind.
          </div>
        )}
        {config.view !== 'day' && meta && (meta.sessions ?? 0) < COMPOSITE_DAYS && (
          <div className="text-[11px] text-zinc-500">Only {meta.sessions} sessions available — the oldest composite may be partial.</div>
        )}

        <div className="flex gap-3 min-h-0">
          {/* CHART */}
          <div className="flex-1 min-w-0 bg-zinc-900/50 border border-zinc-800 rounded-xl p-1 h-[calc(100vh-170px)] min-h-[520px]">
            {loading ? (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-zinc-500">
                <RefreshCw className="w-6 h-6 animate-spin text-sky-400" />
                <span className="text-xs font-medium">Loading 1-minute bars…</span>
              </div>
            ) : profiles.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                No session data for {config.symbol}.
              </div>
            ) : (
              <TpoChart
                profiles={profiles}
                notes={notes}
                nPocs={nPocs}
                style={config.style}
                show={config.show}
                lastPrice={lastPrice}
                selectedKey={selected?.key ?? null}
                onSelect={setSelectedKey}
                fitKey={fitKey}
              />
            )}
          </div>

          {/* SELECTED PROFILE */}
          {selected && (
            <aside className="w-72 shrink-0 bg-zinc-900/50 border border-zinc-800 rounded-xl p-3 flex flex-col gap-3 overflow-y-auto h-[calc(100vh-170px)] min-h-[520px]">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-sky-400">
                  {selected.kind === 'day' ? 'Session' : selected.kind === 'week' ? 'Week' : 'Month'}
                  {selected.developing ? ' · developing' : ''}
                </p>
                <h2 className="text-sm font-bold text-zinc-100">{selNote?.label}</h2>
                {selected.kind !== 'day' && (
                  <p className="text-[10px] text-zinc-500">{selected.start} → {selected.end} · letters = day</p>
                )}
              </div>

              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Value</h3>
                <Stat label="POC" value={fmt(selected.poc)} tone="text-red-400" />
                <Stat label="VAH" value={fmt(selected.vah)} tone="text-violet-300" />
                <Stat label="VAL" value={fmt(selected.val)} tone="text-violet-300" />
                <Stat label="VA width" value={fmt(selected.vah - selected.val + rowSize)} />
                {selected.vpoc !== null && <Stat label="Volume POC" value={fmt(selected.vpoc)} />}
              </section>

              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Range</h3>
                <Stat label="Open / Close" value={`${fmt(selected.open)} / ${fmt(selected.close)}`} />
                <Stat label="High / Low" value={`${fmt(selected.high)} / ${fmt(selected.low)}`} />
                {selected.ibHigh !== null && selected.ibLow !== null && (
                  <>
                    <Stat label="IB high / low" value={`${fmt(selected.ibHigh)} / ${fmt(selected.ibLow)}`} tone="text-sky-300" />
                    <Stat label="IB range" value={fmt(selected.ibHigh - selected.ibLow)} />
                    <Stat label="Extension ▲ / ▼" value={`${fmt(selected.extUp)} / ${fmt(selected.extDown)}`} />
                  </>
                )}
              </section>

              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Read</h3>
                {selNote?.dayType && <Stat label="Day type" value={selNote.dayType} />}
                {selNote?.power && (
                  <>
                    <Stat
                      label="Power"
                      value={selNote.power.side === 'balanced' ? 'Balanced' : `${selNote.power.side === 'bullish' ? 'Bullish' : 'Bearish'} ${selNote.power.degree}/6`}
                      tone={selNote.power.side === 'bullish' ? 'text-emerald-400' : selNote.power.side === 'bearish' ? 'text-red-400' : 'text-zinc-300'}
                    />
                    <p className="text-[10px] text-zinc-500 leading-snug">
                      At the {selected.developing ? 'last price' : 'close'}: {selNote.power.reason}.
                    </p>
                  </>
                )}
                <Stat
                  label="TPO above / below POC"
                  value={`${selected.tpoAbove} / ${selected.tpoBelow}`}
                />
                <Stat
                  label="Skew pressure"
                  value={tpoSkew(selected)}
                  tone={tpoSkew(selected) === 'bullish' ? 'text-emerald-400' : tpoSkew(selected) === 'bearish' ? 'text-red-400' : 'text-zinc-300'}
                />
                <Stat label="Rotation factor" value={selected.rotationFactor > 0 ? `+${selected.rotationFactor}` : selected.rotationFactor} />
                <Stat label="TPO count" value={selected.totalTpo} />
              </section>

              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Structure</h3>
                <Stat label="Selling tail" value={selected.sellingTail ? `${fmt(selected.sellingTail.from)}–${fmt(selected.sellingTail.to + rowSize)}` : '—'} tone="text-red-400" />
                <Stat label="Buying tail" value={selected.buyingTail ? `${fmt(selected.buyingTail.from)}–${fmt(selected.buyingTail.to + rowSize)}` : '—'} tone="text-emerald-400" />
                <Stat label="Poor high / low" value={`${selected.poorHigh ? 'yes' : 'no'} / ${selected.poorLow ? 'yes' : 'no'}`} tone={selected.poorHigh || selected.poorLow ? 'text-amber-400' : undefined} />
                {selected.singlePrints.length > 0 ? (
                  selected.singlePrints.map((s) => (
                    <Stat key={s.from} label="Single prints" value={`${fmt(s.from)}–${fmt(s.to + rowSize)}`} tone="text-amber-300" />
                  ))
                ) : (
                  <Stat label="Single prints" value="—" />
                )}
              </section>

              {selPrev && (
                <section>
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Previous {selected.kind === 'day' ? 'session' : selected.kind}</h3>
                  <Stat label="POC" value={fmt(selPrev.poc)} />
                  <Stat label="VA" value={`${fmt(selPrev.val)} – ${fmt(selPrev.vah)}`} />
                  <Stat label="Range" value={`${fmt(selPrev.low)} – ${fmt(selPrev.high)}`} />
                  <Stat
                    label="Open vs prev"
                    value={selected.open > selPrev.high ? 'above range' : selected.open < selPrev.low ? 'below range'
                      : selected.open > vaTop(selPrev) ? 'above value' : selected.open < selPrev.val ? 'below value' : 'inside value'}
                  />
                </section>
              )}

              <section>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">Naked POCs ({openNaked.length})</h3>
                {openNaked.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">Every earlier POC has been revisited.</p>
                ) : (
                  [...openNaked]
                    .sort((a, b) => Math.abs(a.poc - (lastPrice ?? 0)) - Math.abs(b.poc - (lastPrice ?? 0)))
                    .slice(0, 8)
                    .map((n) => (
                      <Stat
                        key={n.key}
                        label={notes.get(n.key)?.label ?? n.key}
                        value={`${fmt(n.poc)}${lastPrice !== null ? ` (${n.poc >= lastPrice ? '+' : ''}${fmt(n.poc - lastPrice)})` : ''}`}
                        tone="text-amber-300"
                      />
                    ))
                )}
              </section>

              <p className="text-[10px] text-zinc-500 leading-snug mt-auto">
                Day type and power degree are rule-of-thumb labels from the TPO course, not signals.
                Indices carry no volume, so VPOC shows only for stocks.
              </p>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
