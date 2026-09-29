'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDownUp, Binoculars, ChevronDown, ChevronRight, Loader2, Play, Plus, Save, Square, X } from 'lucide-react';
import NavBar from '@/components/NavBar';
import ResultsTable, { type SeenInfo } from '@/components/optionsScreener/ResultsTable';
import ContractModal from '@/components/optionsScreener/ContractModal';
import { FOCUS_RING, fmtExpiry, fmtIstTime } from '@/components/optionsScreener/format';
import {
  METRICS,
  PRESETS,
  PRESET_GROUPS,
  WINDOWS,
  sanitizeConditions,
  type MetricId,
  type PresetGroupId,
  type PresetId,
  type ResultRow,
  type ScanCondition,
  type ScanResponse,
  type Segment,
  type WindowMin,
} from '@/lib/optionsScreener';

// ---------------------------------------------------------------------------
// persistence (per-viewer conveniences only — every read/write is guarded)
// ---------------------------------------------------------------------------

const PREFS_KEY = 'options-screener:prefs:v1';
const SAVED_SCANS_KEY = 'options-screener:saved-scans:v1';
const WATCHLISTS_KEY = 'options-screener:watchlists:v1';
const SEEN_KEY = 'options-screener:seen:v1';

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked/full */ }
}

type SegmentSel = 'all' | Segment;
type ExpirySel = 'all' | 'near' | 'next' | string;

interface Prefs {
  segment: SegmentSel;
  symbols: string[];
  watchlist: string;
  expiry: ExpirySel;
  type: 'both' | 'CE' | 'PE';
  maxOff: number;
  windowSel: 'default' | WindowMin;
  conditions: ScanCondition[];
  presets: PresetId[];
  match: 'any' | 'all';
  customOpen: boolean;
  presetOpen: boolean;
}

const DEFAULT_PREFS: Prefs = {
  segment: 'all',
  symbols: [],
  watchlist: '',
  expiry: 'all',
  type: 'both',
  maxOff: 15,
  windowSel: 'default',
  conditions: [
    { metric: 'premium_pct', window: 5, op: 'gte', value: 5 },
    { metric: 'oi_pct', window: 5, op: 'gte', value: 10 },
  ],
  presets: ['unusual_volume', 'short_covering'],
  match: 'any',
  customOpen: true,
  presetOpen: true,
};

function loadPrefs(): Prefs {
  const p = readLS<Partial<Prefs>>(PREFS_KEY, {});
  return {
    ...DEFAULT_PREFS,
    ...p,
    conditions: p.conditions ? sanitizeConditions(p.conditions) : DEFAULT_PREFS.conditions,
    presets: Array.isArray(p.presets) ? p.presets.filter((x) => PRESETS.some((d) => d.id === x)) : DEFAULT_PREFS.presets,
  };
}

/** First-seen times and acknowledgements, reset every trading day. */
interface SeenStore {
  date: string;
  custom: Record<string, Record<string, number>>;   // scan signature → id → epoch s
  preset: Record<string, Record<string, number>>;
  acked: Record<string, number>;
}
const EMPTY_SEEN: SeenStore = { date: '', custom: {}, preset: {}, acked: {} };

function trimMap(m: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(m);
  if (entries.length <= max) return m;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, max));
}

/** Keep rows already on screen where they are; new ids go on top. */
function mergeOrder(prev: string[], incoming: string[]): string[] {
  const inc = new Set(incoming);
  const kept = prev.filter((id) => inc.has(id));
  const had = new Set(kept);
  const fresh = incoming.filter((id) => !had.has(id));
  return [...fresh, ...kept];
}

const useMounted = () => useSyncExternalStore(() => () => {}, () => true, () => false);

// ---------------------------------------------------------------------------
// small controls
// ---------------------------------------------------------------------------

const SELECT = `bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 ${FOCUS_RING}`;
const LABEL = 'text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      {children}
    </div>
  );
}

/** Text/number input that commits on blur/Enter only (dhan-commit-on-blur). */
function CommitInput({
  value, onCommit, placeholder, ariaLabel, className, type = 'text', list,
}: {
  value: string; onCommit: (v: string) => void; placeholder?: string; ariaLabel: string;
  className?: string; type?: 'text' | 'number'; list?: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      type={type}
      list={list}
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className={`bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 ${FOCUS_RING} ${className ?? ''}`}
    />
  );
}

const GROUP_DOT: Record<PresetGroupId, string> = {
  buildup: 'bg-emerald-400',
  activity: 'bg-amber-400',
  volatility: 'bg-violet-400',
  underlying: 'bg-sky-400',
};

interface CollectorStatus {
  status: 'RUNNING' | 'STARTING' | 'STOPPED';
  reason?: string;
  error?: string;
  last_error?: string | null;
  last_scan?: string;
  scan_seconds?: number;
  contracts?: number;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export default function OptionsScreener() {
  const mounted = useMounted();
  if (!mounted) {
    return (
      <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
        <div className="flex-1 flex items-center justify-center text-xs text-zinc-500">
          <Loader2 className="w-4 h-4 mr-2 animate-spin text-emerald-400" /> Loading Options Screener…
        </div>
      </div>
    );
  }
  return <ScreenerInner />;
}

function ScreenerInner() {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      writeLS(PREFS_KEY, next);
      return next;
    });
  }, []);

  const [savedScans, setSavedScans] = useState<{ name: string; conditions: ScanCondition[] }[]>(
    () => readLS(SAVED_SCANS_KEY, []),
  );
  const [watchlists, setWatchlists] = useState<Record<string, string[]>>(() => readLS(WATCHLISTS_KEY, {}));
  const [seen, setSeen] = useState<SeenStore>(() => readLS(SEEN_KEY, EMPTY_SEEN));

  const [data, setData] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [collector, setCollector] = useState<CollectorStatus | null>(null);
  const [collectorBusy, setCollectorBusy] = useState(false);
  const [customOrder, setCustomOrder] = useState<{ sig: string; ids: string[] }>({ sig: '', ids: [] });
  const [presetOrder, setPresetOrder] = useState<{ sig: string; ids: string[] }>({ sig: '', ids: [] });
  const [selected, setSelected] = useState<ResultRow | null>(null);

  const effWindow: WindowMin = prefs.windowSel === 'default'
    ? (prefs.conditions[0]?.window ?? 5)
    : prefs.windowSel;

  const symbols = prefs.watchlist && watchlists[prefs.watchlist] ? watchlists[prefs.watchlist] : prefs.symbols;
  const filters = useMemo(() => ({
    segment: prefs.segment, symbols, expiry: prefs.expiry, type: prefs.type, maxOff: prefs.maxOff,
  }), [prefs.segment, symbols, prefs.expiry, prefs.type, prefs.maxOff]);

  const filterSig = JSON.stringify([filters, effWindow]);
  const customSig = JSON.stringify([filterSig, prefs.conditions]);
  const presetSig = JSON.stringify([filterSig, [...prefs.presets].sort(), prefs.match]);

  // Contracts already logged as preset hits today — sent back so they keep their row.
  const stickyIds = useMemo(() => {
    const m = seen.preset[presetSig] ?? {};
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 300).map(([id]) => id);
  }, [seen.preset, presetSig]);
  const stickyRef = useRef(stickyIds);
  useEffect(() => { stickyRef.current = stickyIds; }, [stickyIds]);

  const requestBody = useMemo(() => JSON.stringify({
    filters,
    window: effWindow,
    conditions: prefs.conditions,
    presets: prefs.presets,
    match: prefs.match,
  }), [filters, effWindow, prefs.conditions, prefs.presets, prefs.match]);

  // ---- scan polling -------------------------------------------------------
  const seq = useRef(0);
  const runScan = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const body = { ...JSON.parse(requestBody), sticky: stickyRef.current };
      const res = await fetch('/api/options-screener/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as ScanResponse;
      if (mySeq !== seq.current) return; // a newer request (filter change) owns the screen
      if (!json.success) throw new Error(json.error || `Scan failed (${res.status})`);
      const now = Math.floor(Date.now() / 1000);

      setSeen((prev) => {
        const base = json.dataDate && prev.date !== json.dataDate
          ? { ...EMPTY_SEEN, date: json.dataDate }
          : prev;
        const cMap = { ...(base.custom[customSig] ?? {}) };
        for (const r of json.custom) if (!cMap[r.id]) cMap[r.id] = now;
        const pMap = { ...(base.preset[presetSig] ?? {}) };
        for (const r of json.presetHits) if (r.active && !pMap[r.id]) pMap[r.id] = now;
        const next: SeenStore = {
          ...base,
          custom: { ...base.custom, [customSig]: trimMap(cMap, 500) },
          preset: { ...base.preset, [presetSig]: trimMap(pMap, 400) },
        };
        writeLS(SEEN_KEY, next);
        return next;
      });
      setCustomOrder((prev) => ({
        sig: customSig,
        ids: prev.sig === customSig ? mergeOrder(prev.ids, json.custom.map((r) => r.id)) : json.custom.map((r) => r.id),
      }));
      setPresetOrder((prev) => ({
        sig: presetSig,
        ids: prev.sig === presetSig ? mergeOrder(prev.ids, json.presetHits.map((r) => r.id)) : json.presetHits.map((r) => r.id),
      }));
      setData(json);
      setError(null);
      setFetchedAt(Date.now());
    } catch (e) {
      if (mySeq !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [requestBody, customSig, presetSig]);

  useEffect(() => {
    const t0 = setTimeout(runScan, 150); // coalesce a burst of control changes
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') runScan();
    }, 20_000);
    return () => { clearTimeout(t0); clearInterval(id); };
  }, [runScan]);

  // ---- collector status ---------------------------------------------------
  const refreshCollector = useCallback(async () => {
    try {
      const res = await fetch('/api/options-screener/collector');
      const json = await res.json();
      if (json.success) setCollector(json.status as CollectorStatus);
    } catch { /* keep last known */ }
  }, []);
  useEffect(() => {
    const t0 = setTimeout(refreshCollector, 0);
    const id = setInterval(refreshCollector, 15_000);
    return () => { clearTimeout(t0); clearInterval(id); };
  }, [refreshCollector]);

  const collectorAction = async (action: 'start' | 'stop') => {
    setCollectorBusy(true);
    try {
      await fetch('/api/options-screener/collector', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } finally {
      setTimeout(() => { refreshCollector(); setCollectorBusy(false); }, 1500);
    }
  };

  // ---- derived rows -------------------------------------------------------
  const customRows = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.custom.map((r) => [r.id, r]));
    const ids = customOrder.sig === customSig ? customOrder.ids : data.custom.map((r) => r.id);
    return ids.map((id) => byId.get(id)).filter((r): r is ResultRow => !!r);
  }, [data, customOrder, customSig]);

  const presetRows = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.presetHits.map((r) => [r.id, r]));
    const ids = presetOrder.sig === presetSig ? presetOrder.ids : data.presetHits.map((r) => r.id);
    return ids.map((id) => byId.get(id)).filter((r): r is ResultRow => !!r);
  }, [data, presetOrder, presetSig]);

  const customSeen = useMemo(() => {
    const m = seen.custom[customSig] ?? {};
    const out: Record<string, SeenInfo> = {};
    for (const [id, t] of Object.entries(m)) out[id] = { first: t, isNew: false };
    return out;
  }, [seen.custom, customSig]);

  const presetSeen = useMemo(() => {
    const m = seen.preset[presetSig] ?? {};
    const out: Record<string, SeenInfo> = {};
    for (const [id, t] of Object.entries(m)) out[id] = { first: t, isNew: !seen.acked[id] };
    return out;
  }, [seen.preset, seen.acked, presetSig]);

  const ack = useCallback((ids: string[]) => {
    setSeen((prev) => {
      const acked = { ...prev.acked };
      const now = Math.floor(Date.now() / 1000);
      for (const id of ids) acked[id] = now;
      const next = { ...prev, acked: trimMap(acked, 2000) };
      writeLS(SEEN_KEY, next);
      return next;
    });
  }, []);

  const resortCustom = () => {
    if (data) setCustomOrder({ sig: customSig, ids: [...data.custom].sort((a, b) => b.score - a.score).map((r) => r.id) });
  };
  const resortPresets = () => {
    if (!data) return;
    const rows = [...data.presetHits].sort((a, b) => {
      const na = presetSeen[a.id]?.isNew ? 1 : 0, nb = presetSeen[b.id]?.isNew ? 1 : 0;
      if (na !== nb) return nb - na;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (presetSeen[b.id]?.first ?? 0) - (presetSeen[a.id]?.first ?? 0);
    });
    setPresetOrder({ sig: presetSig, ids: rows.map((r) => r.id) });
  };

  // ---- conditions ---------------------------------------------------------
  const updateCond = (i: number, patch: Partial<ScanCondition>) => {
    setPrefs({ conditions: prefs.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  };
  const addCond = () => {
    if (prefs.conditions.length >= 8) return;
    setPrefs({ conditions: [...prefs.conditions, { metric: 'volume', window: effWindow, op: 'gte', value: 50 }] });
  };
  const removeCond = (i: number) => setPrefs({ conditions: prefs.conditions.filter((_, j) => j !== i) });

  const saveScan = () => {
    const name = window.prompt('Save this custom scan as:', `Scan ${savedScans.length + 1}`)?.trim();
    if (!name) return;
    const next = [...savedScans.filter((s) => s.name !== name), { name, conditions: prefs.conditions }];
    setSavedScans(next);
    writeLS(SAVED_SCANS_KEY, next);
  };
  const loadScan = (name: string) => {
    const s = savedScans.find((x) => x.name === name);
    if (s) setPrefs({ conditions: sanitizeConditions(s.conditions) });
  };
  const deleteScan = (name: string) => {
    const next = savedScans.filter((s) => s.name !== name);
    setSavedScans(next);
    writeLS(SAVED_SCANS_KEY, next);
  };

  // ---- watchlists ---------------------------------------------------------
  const onWatchlist = (v: string) => {
    if (v === '__save__') {
      const syms = prefs.symbols;
      if (!syms.length) { window.alert('Type some symbols in SYMBOLS first, then save them as a watchlist.'); return; }
      const name = window.prompt(`Save ${syms.length} symbol(s) as watchlist:`, 'My watchlist')?.trim();
      if (!name) return;
      const next = { ...watchlists, [name]: syms };
      setWatchlists(next);
      writeLS(WATCHLISTS_KEY, next);
      setPrefs({ watchlist: name });
      return;
    }
    if (v === '__delete__') {
      if (!prefs.watchlist) return;
      if (!window.confirm(`Delete watchlist "${prefs.watchlist}"?`)) return;
      const next = { ...watchlists };
      delete next[prefs.watchlist];
      setWatchlists(next);
      writeLS(WATCHLISTS_KEY, next);
      setPrefs({ watchlist: '' });
      return;
    }
    setPrefs({ watchlist: v });
  };

  const togglePreset = (id: PresetId) => {
    const has = prefs.presets.includes(id);
    setPrefs({ presets: has ? prefs.presets.filter((p) => p !== id) : [...prefs.presets, id] });
  };

  const openRow = (r: ResultRow, fromPresets: boolean) => {
    if (fromPresets) ack([r.id]);
    setSelected(r);
  };

  // ---- header status ------------------------------------------------------
  const ageSec = data?.snapshotAgeSec ?? null;
  const exchChip = (ex: 'NSE' | 'BSE' | 'MCX') => {
    const e = data?.exchanges?.[ex];
    if (!e || (!e.contracts && ex === 'BSE')) return null;
    const stale = e.live && (ageSec == null || ageSec > 180);
    const tone = !e.live ? 'text-zinc-400' : stale ? 'text-amber-400' : 'text-emerald-400';
    const dot = !e.live ? 'bg-zinc-500' : stale ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse';
    return (
      <span key={ex} className={`flex items-center gap-1.5 text-[10px] font-mono ${tone}`}
        title={`${e.contracts} ${ex} contracts in the last scan`}>
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {ex} {fmtIstTime(e.last_scan)} IST · {!e.live ? 'closed' : stale ? 'stale' : 'live'}
      </span>
    );
  };

  const lastScan = Math.max(0, ...Object.values(data?.exchanges ?? {}).map((e) => e.last_scan ?? 0)) || null;
  const collectorRunning = collector?.status === 'RUNNING' || collector?.status === 'STARTING';
  const windowLabel = `${effWindow}M`;
  const presetCountTicked = prefs.presets.length;
  const newCount = presetRows.filter((r) => presetSeen[r.id]?.isNew).length;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ---------------- header ---------------- */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Binoculars className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Trading · Index, stock &amp; MCX options</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Options Screener</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              What changed in the last 1–30 min across index, stock &amp; MCX options · rescanned every minute
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {exchChip('NSE')}
          {exchChip('BSE')}
          {exchChip('MCX')}
          <span className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border ${
            collectorRunning ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-900'
          }`} title={collector?.last_error ? `Last API error: ${collector.last_error}` : 'Minute-by-minute snapshot collector'}>
            Collector {collector?.status ?? '…'}
          </span>
          <button
            type="button"
            disabled={collectorBusy}
            onClick={() => collectorAction(collectorRunning ? 'stop' : 'start')}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition disabled:opacity-50 ${FOCUS_RING} ${
              collectorRunning ? 'border-zinc-700 text-zinc-300 hover:border-red-500/50 hover:text-red-300' : 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
            }`}
          >
            {collectorBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : collectorRunning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            {collectorRunning ? 'Stop' : 'Start'}
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {data?.dataDate ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-3 px-4 md:px-6 py-4 max-w-[1800px] w-full mx-auto">
        {/* ---------------- filters ---------------- */}
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <Field label="Segment">
            <div className="flex bg-zinc-950 border border-zinc-700 rounded-md p-0.5">
              {([['all', 'All'], ['index', 'Indices'], ['stock', 'Stocks'], ['mcx', 'MCX']] as [SegmentSel, string][]).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setPrefs({ segment: v })} aria-pressed={prefs.segment === v}
                  className={`px-2.5 py-1 rounded text-xs font-semibold transition ${FOCUS_RING} ${
                    prefs.segment === v ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                  }`}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Symbols">
            <CommitInput
              key={prefs.symbols.join(',')}
              value={prefs.symbols.join(', ')}
              placeholder="All underlyings"
              ariaLabel="Symbols, comma separated"
              list="options-screener-symbols"
              className="w-48"
              onCommit={(v) => setPrefs({
                symbols: [...new Set(v.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))],
                watchlist: '',
              })}
            />
            <datalist id="options-screener-symbols">
              {(data?.symbols ?? []).map((s) => <option key={s.u} value={s.u} />)}
            </datalist>
          </Field>
          <Field label="Watchlist">
            <select className={`${SELECT} w-44`} value={prefs.watchlist} onChange={(e) => onWatchlist(e.target.value)} aria-label="Watchlist">
              <option value="">None</option>
              {Object.keys(watchlists).map((n) => <option key={n} value={n}>{n} ({watchlists[n].length})</option>)}
              <option value="__save__">+ Save typed symbols…</option>
              {prefs.watchlist && <option value="__delete__">Delete “{prefs.watchlist}”</option>}
            </select>
          </Field>
          <Field label="Expiry">
            <select className={SELECT} value={prefs.expiry} onChange={(e) => setPrefs({ expiry: e.target.value })} aria-label="Expiry">
              <option value="all">All</option>
              <option value="near">Nearest</option>
              <option value="next">Next</option>
              {(data?.expiries ?? []).map((e) => <option key={e} value={e}>{fmtExpiry(e)} ({e})</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className={SELECT} value={prefs.type} onChange={(e) => setPrefs({ type: e.target.value as Prefs['type'] })} aria-label="Option type">
              <option value="both">CE + PE</option>
              <option value="CE">CE</option>
              <option value="PE">PE</option>
            </select>
          </Field>
          <Field label="Strikes from ATM">
            <select className={SELECT} value={prefs.maxOff} onChange={(e) => setPrefs({ maxOff: Number(e.target.value) })} aria-label="Strikes from ATM">
              <option value={15}>Any (±10)</option>
              {[0, 1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n === 0 ? 'ATM only' : `±${n}`}</option>)}
            </select>
          </Field>
          <Field label="Columns window">
            <select className={SELECT} value={String(prefs.windowSel)} aria-label="Columns window"
              onChange={(e) => setPrefs({ windowSel: e.target.value === 'default' ? 'default' : (Number(e.target.value) as WindowMin) })}>
              <option value="default">Default ({prefs.conditions[0]?.window ?? 5}m)</option>
              {WINDOWS.map((w) => <option key={w} value={w}>{w} min</option>)}
            </select>
          </Field>
          <div className="ml-auto text-[10px] text-zinc-500 self-center">
            {data?.hasData ? `${data.filteredContracts.toLocaleString('en-IN')} of ${data.totalContracts.toLocaleString('en-IN')} contracts in view` : ''}
          </div>
        </div>

        {/* ---------------- banners ---------------- */}
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">Scan error: {error}</div>
        )}
        {collector?.status === 'STOPPED' && (collector.reason === 'error' || collector.reason === 'crashed') && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            Collector {collector.reason === 'crashed' ? 'exited unexpectedly' : 'failed'}{collector.error ? `: ${collector.error}` : ''}
            {' '}— see <span className="font-mono">debug/options_screener_collector.log</span>. Dhan token expired? Run login.py, then Start.
          </div>
        )}
        {data && !data.hasData && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-8 text-center">
            <p className="text-sm font-semibold text-zinc-200">No snapshot yet</p>
            <p className="text-xs text-zinc-400 mt-1 max-w-xl mx-auto">
              The screener reads a minute-by-minute snapshot written by <span className="font-mono">options_screener_collector.py</span>.
              Start it and the first results appear after one scan; the 1–30 min change columns fill in as history builds.
            </p>
            {!collectorRunning && (
              <button type="button" onClick={() => collectorAction('start')} disabled={collectorBusy}
                className={`mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold bg-emerald-600 text-oncolor hover:bg-emerald-500 ${FOCUS_RING}`}>
                <Play className="w-3.5 h-3.5" /> Start collector
              </button>
            )}
          </div>
        )}
        {data?.hasData && ageSec != null && ageSec > 180 && Object.values(data.exchanges ?? {}).some((e) => e.live) && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Snapshot is {Math.round(ageSec / 60)} min old while a market is open — {collectorRunning ? 'the collector is lagging (Dhan rate limit?)' : 'the collector is not running'}.
            {collector?.last_error ? ` Last API error: ${collector.last_error}` : ''}
          </div>
        )}
        {!data && !error && (
          <div className="flex items-center justify-center py-16 text-xs text-zinc-500">
            <Loader2 className="w-4 h-4 mr-2 animate-spin text-emerald-400" /> Loading scan…
          </div>
        )}

        {data?.hasData && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
            {/* ================= left: custom scan ================= */}
            <div className="flex flex-col gap-3 min-w-0">
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <button type="button" onClick={() => setPrefs({ customOpen: !prefs.customOpen })}
                    aria-expanded={prefs.customOpen}
                    className={`flex items-center gap-2 text-left ${FOCUS_RING}`}>
                    {prefs.customOpen ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />}
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-200">Custom scan</span>
                    <span className="text-[11px] text-zinc-500">all conditions must be true</span>
                  </button>
                  <div className="flex items-center gap-1.5">
                    {savedScans.length > 0 && (
                      <select className={`${SELECT} py-1`} value="" aria-label="Load saved scan"
                        onChange={(e) => { if (e.target.value) loadScan(e.target.value); }}>
                        <option value="">Load…</option>
                        {savedScans.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                    )}
                    {savedScans.length > 0 && (
                      <select className={`${SELECT} py-1`} value="" aria-label="Delete saved scan"
                        onChange={(e) => { if (e.target.value && window.confirm(`Delete saved scan "${e.target.value}"?`)) deleteScan(e.target.value); }}>
                        <option value="">Delete…</option>
                        {savedScans.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      </select>
                    )}
                    <button type="button" onClick={saveScan} disabled={prefs.conditions.length === 0}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 text-[11px] font-semibold text-zinc-200 hover:border-zinc-500 disabled:opacity-40 ${FOCUS_RING}`}>
                      <Save className="w-3 h-3" /> Save…
                    </button>
                  </div>
                </div>
                {prefs.customOpen && (
                  <div className="px-4 pb-3 flex flex-col gap-2">
                    {prefs.conditions.map((c, i) => {
                      const def = METRICS.find((m) => m.id === c.metric)!;
                      return (
                        <div key={i} className="flex items-center gap-2 flex-wrap">
                          <span className="w-12 text-[10px] font-bold uppercase text-zinc-500">{i === 0 ? 'Where' : 'And'}</span>
                          <select className={`${SELECT} w-48`} value={c.metric} aria-label={`Condition ${i + 1} metric`}
                            onChange={(e) => updateCond(i, { metric: e.target.value as MetricId })}>
                            {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                          <select className={`${SELECT} w-24 disabled:opacity-40`} value={c.window} disabled={!def.windowed}
                            aria-label={`Condition ${i + 1} window`}
                            onChange={(e) => updateCond(i, { window: Number(e.target.value) as WindowMin })}>
                            {WINDOWS.map((w) => <option key={w} value={w}>in {w} min</option>)}
                          </select>
                          <select className={`${SELECT} w-14`} value={c.op} aria-label={`Condition ${i + 1} operator`}
                            onChange={(e) => updateCond(i, { op: e.target.value as 'gte' | 'lte' })}>
                            <option value="gte">≥</option>
                            <option value="lte">≤</option>
                          </select>
                          <CommitInput
                            key={`${i}-${c.value}`}
                            type="number"
                            value={String(c.value)}
                            ariaLabel={`Condition ${i + 1} value`}
                            className="w-24 font-mono"
                            onCommit={(v) => { const n = Number(v); if (v.trim() !== '' && Number.isFinite(n)) updateCond(i, { value: n }); }}
                          />
                          <span className="text-[11px] text-zinc-500 w-8">{def.unit}</span>
                          <button type="button" onClick={() => removeCond(i)} aria-label={`Remove condition ${i + 1}`}
                            className={`p-1 rounded text-zinc-500 hover:text-red-300 ${FOCUS_RING}`}>
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                    <div>
                      <button type="button" onClick={addCond}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded-md border border-dashed border-zinc-700 text-[11px] font-semibold text-emerald-300 hover:border-emerald-500/50 ${FOCUS_RING}`}>
                        <Plus className="w-3 h-3" /> Add condition
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-200">Custom scan results</span>
                  <button type="button" onClick={resortCustom}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 text-[11px] font-semibold text-zinc-200 hover:border-zinc-500 ${FOCUS_RING}`}>
                    <ArrowDownUp className="w-3 h-3" /> Re-sort
                  </button>
                </div>
                <div className="max-h-[62vh] overflow-y-auto">
                  <ResultsTable
                    rows={customRows}
                    seen={customSeen}
                    windowLabel={windowLabel}
                    timeLabel="SEEN"
                    onOpen={(r) => openRow(r, false)}
                    emptyText={prefs.conditions.length === 0 ? 'Add a condition to run a custom scan.' : 'No contract matches every condition right now.'}
                  />
                </div>
                <div className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
                  {data.customTotal > customRows.length
                    ? `showing ${customRows.length} of ${data.customTotal} contracts`
                    : `${customRows.length} contract${customRows.length === 1 ? '' : 's'}`}
                  {' · '}scanned {fmtIstTime(lastScan, true)} IST
                  {fetchedAt ? ` · refreshed ${new Date(fetchedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })}` : ''}
                </div>
              </section>
            </div>

            {/* ================= right: presets ================= */}
            <div className="flex flex-col gap-3 min-w-0">
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 flex-wrap">
                  <button type="button" onClick={() => setPrefs({ presetOpen: !prefs.presetOpen })}
                    aria-expanded={prefs.presetOpen}
                    className={`flex items-center gap-2 text-left ${FOCUS_RING}`}>
                    {prefs.presetOpen ? <ChevronDown className="w-3.5 h-3.5 text-zinc-400" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />}
                    <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-200">Preset scans</span>
                    <span className="text-[11px] text-zinc-500">
                      {presetCountTicked} ticked · {prefs.match === 'any' ? 'any can match' : 'all must match'}
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    <span className={LABEL}>Match</span>
                    <div className="flex bg-zinc-950 border border-zinc-700 rounded-md p-0.5">
                      {(['any', 'all'] as const).map((m) => (
                        <button key={m} type="button" onClick={() => setPrefs({ match: m })} aria-pressed={prefs.match === m}
                          className={`px-2.5 py-0.5 rounded text-[11px] font-semibold capitalize ${FOCUS_RING} ${
                            prefs.match === m ? 'bg-emerald-500/15 text-emerald-300' : 'text-zinc-400 hover:text-zinc-200'
                          }`}>
                          {m}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={() => setPrefs({ presets: [] })}
                      className={`px-2 py-0.5 rounded text-[11px] font-semibold text-zinc-400 hover:text-zinc-100 ${FOCUS_RING}`}>
                      Clear
                    </button>
                  </div>
                </div>
                {prefs.presetOpen && (
                  <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-4">
                    {PRESET_GROUPS.map((g) => (
                      <div key={g.id} className="flex flex-col gap-1.5">
                        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-400">
                          <span className={`h-1.5 w-1.5 rounded-full ${GROUP_DOT[g.id]}`} />{g.label}
                        </span>
                        {PRESETS.filter((p) => p.group === g.id).map((p) => {
                          const on = prefs.presets.includes(p.id);
                          const n = data.presetCounts[p.id] ?? 0;
                          return (
                            <label key={p.id} title={p.desc}
                              className={`flex items-center gap-2 px-2 py-1 rounded-md border cursor-pointer text-[11px] transition ${
                                on ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                              }`}>
                              <input type="checkbox" checked={on} onChange={() => togglePreset(p.id)}
                                className="h-3 w-3 accent-emerald-500" />
                              <span className="flex-1">{p.label}</span>
                              <span className={`px-1.5 rounded text-[10px] font-mono font-bold ${n ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-600'}`}>{n}</span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-zinc-200">
                    Preset scan hits
                    {newCount > 0 && <span className="ml-2 text-amber-300 normal-case tracking-normal">{newCount} new</span>}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {newCount > 0 && (
                      <button type="button" onClick={() => ack(presetRows.map((r) => r.id))}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 ${FOCUS_RING}`}>
                        Mark all seen
                      </button>
                    )}
                    <button type="button" onClick={resortPresets}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 text-[11px] font-semibold text-zinc-200 hover:border-zinc-500 ${FOCUS_RING}`}>
                      <ArrowDownUp className="w-3 h-3" /> Re-sort
                    </button>
                  </div>
                </div>
                <div className="max-h-[62vh] overflow-y-auto">
                  <ResultsTable
                    rows={presetRows}
                    seen={presetSeen}
                    windowLabel={windowLabel}
                    timeLabel="TIME"
                    highlightNew
                    onOpen={(r) => openRow(r, true)}
                    emptyText={prefs.presets.length === 0 ? 'Tick one or more preset scans.' : 'No preset hits yet today for this selection.'}
                  />
                </div>
                <div className="px-4 py-2 border-t border-zinc-800 text-[10px] text-zinc-500">
                  {presetRows.length} contract{presetRows.length === 1 ? '' : 's'} logged today · dimmed rows no longer match
                  {' · '}tags: {PRESETS.filter((p) => prefs.presets.includes(p.id)).map((p) => `${p.tag} ${p.label}`).join(', ') || '—'}
                </div>
              </section>
            </div>
          </div>
        )}

        <p className="text-[10px] text-zinc-500 px-1">
          OI and volume are in lots. RVOL = window volume vs the contract&apos;s own session-average pace. IV is solved locally from LTP
          (Black-Scholes; Black-76 for MCX). Click any row for all look-back windows and a Dhan order ticket — orders are real.
        </p>
      </div>

      {selected && (
        <ContractModal
          key={selected.id}
          row={(data && [...data.custom, ...data.presetHits].find((r) => r.id === selected.id)) || selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
