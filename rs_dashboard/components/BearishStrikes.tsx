'use client';

/**
 * Bearish Strikes (/bearish-strikes) — live CE/PE strikes trading below their own Supertrend(10,2),
 * session VWAP and EMA20: the ones an option seller wants to be short.
 *
 * Ticks come from the shared live-options WS bridge (useLiveOptionsWS); candles from
 * /api/bearish-strikes/bars (1-min backfill, resampled here). Signals read CLOSED bars only — see
 * lib/bearishStrikes.ts. Orders use the Multi-Leg Focus tickets (AddNewLegModal / ExitLotsModal)
 * against this page's OWN ledger (lib/bearishLedger.ts, debug/bearish_strikes_state.json): SIM by
 * default, REAL armed per page load, Dhan only. Exit size always comes from the ledger, never from
 * the broker's netted position (dhan-terminal-position-ownership).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Settings, X, TrendingDown, ClipboardList, LogOut, Bell, BellOff, TriangleAlert, ShieldAlert, Trash2 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import AddNewLegModal from '@/components/multiLegFocus/AddNewLegModal';
import ExitLotsModal from '@/components/multiLegFocus/ExitLotsModal';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';
import { FOCUS_RING } from '@/components/Scalper';
import { BrokerPicker, usePageBroker, type DhanKotak } from '@/components/BrokerPicker';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useLiveTickerPoll, isStale } from '@/lib/useLiveTickerPoll';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import {
  computeIndicators, DEFAULT_IND_PARAMS, sessionStartFor, type IndParams, evaluateBearish, istNowMs, mergeBars, oiView, passesFilters, pctBelow, recordTick,
  type BearishSignal, type LiveMinutes, type OiMode, type StrikeFilters, type Timeframe,
} from '@/lib/bearishStrikes';
import { RESERVATION_PREFIX, isReservation, legPnl, type BsPosition, type LedgerOp, type PendingOrder } from '@/lib/bearishLedger';
import { NO_RISK, riskHit, riskLevels, type RiskCfg, type RiskHit } from '@/lib/bearishRisk';
import {
  LEVELS, activeLevels, levelStates, stepTracker, watchState,
  type Basis, type Level, type LevelState, type Tracker, type WatchState,
} from '@/lib/bearishAlerts';
import type { Bar } from '@/lib/volumeProfile';
import type { Indicators } from '@/lib/bearishStrikes';
import { fallbackLotSize, formatExpiryLabel, type MultiLegBasket, type MultiLegLeg } from '@/lib/multiLegFocus';
import { resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOILM'] as const;
type Underlying = (typeof UNDERLYINGS)[number];
const MAX_LOTS = 50;
const SOURCE = 'bs';
const FILL_GRACE_MS = 30_000;
const SETTLE_GIVE_UP_MS = 6 * 3600_000;
/** A reservation (order recorded, broker id not back yet) older than this belongs to a tab that died mid-send. */
const RESERVATION_STALE_MS = 60_000;
const FEED_FRESH_MS = 15_000;

interface LookupEntry { lotSize: number; strikes: Record<string, StrikeIdentifier> }
interface Row {
  key: string; option: 'CE' | 'PE'; strike: number; ltp: number; oi: number; volume: number;
  changePct: number | null; oiChgPct: number | null; buildup: string; sig: BearishSignal;
  liveBelowAll: boolean;
}

interface HeaderIndices { updated_at?: string; quotes?: Record<string, { ltp?: number | null }> }
// Module scope: the poll hook compares this by identity (see useLiveTickerPoll).
function pickIndexLtps(d: HeaderIndices): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ['NIFTY', 'VIX']) { const v = d?.quotes?.[k]?.ltp; if (typeof v === 'number' && v > 0) out[k] = v; }
  return out;
}

interface PosWatch { ws: WatchState; states: Record<Level, LevelState>; ind: Indicators | null; ltp: number | null }
const WATCH_WHY: Record<Exclude<WatchState, 'watching'>, string> = {
  'other-chain': 'not watched: switch the page to this contract\'s underlying and expiry',
  'no-price': 'not watched: no live price (feed stale)',
  'no-bars': 'not watched: candles not loaded',
  warming: 'not watched yet: indicators warming up',
};

/** Three descending beeps. The AudioContext is created on the user's click (autoplay policy), never on load. */
function playAlertSound(ctx: AudioContext | null) {
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume();
    [880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = f; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.28;
      o.start(t); o.stop(t + 0.2);
    });
  } catch { /* audio unavailable: the toast and banner still show */ }
}

const fmt = (n: number | null | undefined, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
const money = (n: number | null) => (n == null ? '—' : `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const pnlCls = (n: number | null) => (n == null ? 'text-zinc-500' : n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-300');
const istDate = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const dte = (expiry: string) => Math.round((Date.parse(expiry) - Date.parse(istDate())) / 86_400_000);

/** HH:MM:SS in IST for a ledger timestamp (ms). */
function clockIst(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
}

const clampInt = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Free-typed number that only commits on blur / Enter (dhan-commit-on-blur): "2" on the way to "25" must not filter live. */
function NumField({ label, value, onCommit, step = 1, min = 0, width = 'w-16', title }: {
  title?: string; label: string; value: number; onCommit: (n: number) => void; step?: number; min?: number; width?: string;
}) {
  const [draft, setDraft] = useState<string>(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(String(value)); }   // external change (clamped / reset) wins over a stale draft
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n >= min) onCommit(n); else setDraft(String(value));
  };
  return (
    <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400" title={title}>
      {label}
      <input
        type="number" inputMode="decimal" step={step} min={min} value={draft} aria-label={label}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`${width} h-7 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-xs rounded px-1.5 ${FOCUS_RING}`}
      />
    </label>
  );
}

function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center rounded border border-zinc-700 overflow-hidden">
      {options.map((o) => (
        <button
          key={String(o.v)} type="button" onClick={() => onChange(o.v)} aria-pressed={value === o.v}
          className={`h-7 px-2 text-[11px] font-bold font-mono ${FOCUS_RING} ${value === o.v ? 'bg-emerald-600 text-oncolor' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
        >{o.l}</button>
      ))}
    </div>
  );
}

export default function BearishStrikes() {
  // ── Header filters ──────────────────────────────────────────────
  const [underlying, setUnderlyingRaw] = useState<Underlying>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [tf, setTf] = useState<Timeframe>(3);
  const [side, setSide] = useState<'BOTH' | 'CE' | 'PE'>('BOTH');
  const [requireSt, setRequireSt] = useState(true);
  const [requireVwap, setRequireVwap] = useState(true);
  const [requireEma, setRequireEma] = useState(true);
  const [otmOnly, setOtmOnly] = useState(true);
  const [belowOpenOnly, setBelowOpenOnly] = useState(true);
  const [strike100, setStrike100] = useState(false);   // CRUDEOILM only: skip the 50-point strikes
  const [oiMode, setOiMode] = useState<OiMode>('any');
  const [minLtp, setMinLtp] = useState(5);
  const [maxLtp, setMaxLtp] = useState(0);              // 0 = off; only strikes priced at or below this premium
  const [minOiLots, setMinOiLots] = useState(0);
  const [minVolLots, setMinVolLots] = useState(0);
  const [atmWindow, setAtmWindow] = useState(12);
  const [atmMin, setAtmMin] = useState(0);            // inner edge: scan only strikes atmMin..atmWindow steps from ATM (either side)
  const [maxScan, setMaxScan] = useState(40);

  // ── Mode ────────────────────────────────────────────────────────
  // Switching underlying clears the expiry list in the same update, so no stale expiry is ever paired with the new underlying.
  const setUnderlying = (u: Underlying) => { setUnderlyingRaw(u); setExpiries([]); setExpiry(''); };
  const [armed, setArmed] = useState(false);     // REAL money — per page load, never persisted
  const mode: 'SIM' | 'REAL' = armed ? 'REAL' : 'SIM';
  // Account NEW sells go to. A row keeps the broker it was opened on; its exits, settles and reconcile follow the row.
  const [broker, setBroker] = usePageBroker('bearishStrikes.broker');

  // ── Exit alerts for open positions (settings are per-viewer conveniences, kept in localStorage) ──
  const [watchSt, setWatchSt] = useState(true);
  const [watchVwap, setWatchVwap] = useState(false);
  const [watchEma, setWatchEma] = useState(false);
  const [alertBasis, setAlertBasis] = useState<Basis>('live');
  const [alertSound, setAlertSound] = useState(true);
  const [alertNotify, setAlertNotify] = useState(false);
  const [autoExit, setAutoExit] = useState(false);   // buys back a position at MARKET when a ticked alert fires — per page load, never persisted
  const [indCfg, setIndCfg] = useState<IndParams>(DEFAULT_IND_PARAMS);   // indicator settings (Supertrend period/multiplier, EMA length)
  const [showSettings, setShowSettings] = useState(false);
  const stName = `Supertrend(${indCfg.stPeriod},${indCfg.stMult})`;
  const emaName = `EMA${indCfg.emaPeriod}`;
  const levelLabel = useMemo<Record<Level, string>>(() => ({ st: 'Supertrend', vwap: 'VWAP', ema: `EMA${indCfg.emaPeriod}` }), [indCfg.emaPeriod]);
  const [risk, setRisk] = useState<RiskCfg>(NO_RISK);   // % of avg sell premium, 0 = off; applies to every open position
  const audioRef = useRef<AudioContext | null>(null);
  const cfgLoaded = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const c = JSON.parse(localStorage.getItem('bs_alert_cfg') ?? 'null') as Partial<Record<string, unknown>> | null;
        if (c) {
          if (typeof c.st === 'boolean') setWatchSt(c.st);
          if (typeof c.vwap === 'boolean') setWatchVwap(c.vwap);
          if (typeof c.ema === 'boolean') setWatchEma(c.ema);
          if (c.basis === 'live' || c.basis === 'closed') setAlertBasis(c.basis);
          if (typeof c.sound === 'boolean') setAlertSound(c.sound);
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000 ? v : 0);
          setRisk({ sl: num(c.sl), tgt: num(c.tgt), trail: num(c.trail) });
          const ip = c.ind as Partial<Record<keyof IndParams, unknown>> | undefined;
          if (ip && typeof ip.stPeriod === 'number' && typeof ip.stMult === 'number' && typeof ip.emaPeriod === 'number') {
            setIndCfg({ stPeriod: clampInt(ip.stPeriod, 2, 100), stMult: Math.min(10, Math.max(0.5, ip.stMult)), emaPeriod: clampInt(ip.emaPeriod, 2, 200) });
          }
        }
      } catch { /* storage blocked: defaults */ }
      cfgLoaded.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!cfgLoaded.current) return;
    try { localStorage.setItem('bs_alert_cfg', JSON.stringify({ st: watchSt, vwap: watchVwap, ema: watchEma, basis: alertBasis, sound: alertSound, sl: risk.sl, tgt: risk.tgt, trail: risk.trail, ind: indCfg })); } catch { /* ignore */ }
  }, [watchSt, watchVwap, watchEma, alertBasis, alertSound, risk, indCfg]);

  const viewer = useRef(`bs-${Math.random().toString(36).slice(2, 10)}`);
  const [nowTick, setNowTick] = useState(0);

  // Nifty and India VIX for the header. Live LTP comes from the shared indices feed (/api/scalper/top-indices), independent
  // of the option bridge. The previous close is fetched ONCE per index at page load (Dhan-only, close-flip-safe, cached per
  // IST day by the route) and the % change is computed here as (live - prevClose) / prevClose — so it never depends on the
  // feed's own prev_close field, which reads equal to the price whenever the feed has just reconnected.
  useEffect(() => { startLiveIndicesBridge(); }, []);
  const { data: idx, now: idxNow } = useLiveTickerPoll<HeaderIndices>('/api/scalper/top-indices', pickIndexLtps);
  const idxStale = !idx?.updated_at || isStale(Date.parse(idx.updated_at), idxNow);
  const [prevClose, setPrevClose] = useState<{ NIFTY: number | null; VIX: number | null }>({ NIFTY: null, VIX: null });
  useEffect(() => {
    let dead = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const get = async (u: 'NIFTY' | 'VIX'): Promise<number | null> => {
        try {
          const j = await (await fetch(`/api/scalper/nifty-prev-close?underlying=${u}`)).json() as { success?: boolean; prevClose?: number };
          return j.success && typeof j.prevClose === 'number' && j.prevClose > 0 ? j.prevClose : null;
        } catch { return null; }
      };
      const [n, v] = await Promise.all([get('NIFTY'), get('VIX')]);
      if (dead) return;
      setPrevClose((p) => ({ NIFTY: n ?? p.NIFTY, VIX: v ?? p.VIX }));
      // Only a missing value is retried (the route caches a good one for the day). Slow on purpose: a miss usually means Dhan
      // is rate-limiting this account (805), and asking again quickly is what turns a throttle into a block. 30s, 60s ... 150s.
      if ((n == null || v == null) && ++tries < 6) timer = setTimeout(load, 30_000 * tries);
    };
    timer = setTimeout(load, 0);
    return () => { dead = true; if (timer) clearTimeout(timer); };
  }, []);
  const indexChip = (label: string, key: 'NIFTY' | 'VIX') => {
    const ltp = idx?.quotes?.[key]?.ltp;
    const live = typeof ltp === 'number' && ltp > 0 ? ltp : null;
    const prev = prevClose[key];
    const pct = live != null && prev != null ? ((live - prev) / prev) * 100 : null;
    // VIX up = fear up, so its colour is not the P&L colour: amber when rising, calm when falling.
    const tone = idxStale || pct == null ? 'text-zinc-500'
      : key === 'VIX' ? (pct > 0 ? 'text-amber-300' : 'text-sky-400')
      : (pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-zinc-300');
    return (
      <span className="text-xs font-mono text-zinc-300 flex items-baseline gap-1"
        title={idxStale ? `${label}: feed stale or unavailable` : prev != null ? `${label} vs previous close ${prev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${label}: previous close unavailable`}>
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">{label}</span>
        <span className={`font-bold ${idxStale ? 'text-zinc-500' : 'text-white'}`}>{live == null ? '—' : live.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        <span className={`text-[11px] font-bold ${tone}`}>{pct == null ? '' : `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''} ${Math.abs(pct).toFixed(2)}%`}</span>
      </span>
    );
  };

  // ── Expiries ────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !j.data?.length) return;
        setExpiries(j.data);
        setExpiry(j.data[0]);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [underlying]);

  // ── Bridge (shared per underlying; never spawn it ourselves) ────
  // Switching underlying leaves the previous bridge running, so flipping back (e.g. NIFTY <-> CRUDEOILM) is instant and
  // the other feed keeps its history. Everything this page started is stopped when the page itself unmounts; the route's
  // 7 s grace and its multi-viewer guard still apply, so another open tab keeps the feed alive.
  const startedBridges = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!expiry) return;
    startedBridges.current.add(underlying);
    fetch('/api/options/live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 35, broker: 'dhan', viewer: viewer.current }),
    }).catch(() => {});
  }, [underlying, expiry]);
  useEffect(() => {
    const started = startedBridges.current;
    const viewerId = viewer.current;
    return () => {
      for (const u of started) {
        fetch('/api/options/live', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', brokers: ['dhan'], underlying: u, viewer: viewerId }),
        }).catch(() => {});
      }
    };
  }, []);

  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, 'dhan', ['dhan'], underlying);
  const quotesRef = useRef(liveQuotes);
  useEffect(() => { quotesRef.current = liveQuotes; }, [liveQuotes]);

  // ── Lot size + security ids ─────────────────────────────────────
  const [lookupState, setLookup] = useState<{ scope: string; entry: LookupEntry } | null>(null);
  // Per broker: Dhan gives security ids (MCX lot size 1 = lots), Kotak trading symbols (MCX lot size = barrels per lot).
  const lookup = lookupState && lookupState.scope === `${broker}|${underlying}|${expiry}` ? lookupState.entry : null;
  useEffect(() => {
    if (!expiry) return;
    let dead = false;
    fetch(`/api/scalper/${broker === 'kotak' ? 'kotak/' : ''}lookup?underlying=${underlying}&expiry=${expiry}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIdentifier> } }) => {
        if (dead || !j.success || !j.data) return;
        setLookup({ scope: `${broker}|${underlying}|${expiry}`, entry: { lotSize: j.data.lotSize ?? fallbackLotSize(underlying, broker), strikes: j.data.strikes ?? {} } });
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [underlying, expiry, broker]);
  const lotSize = lookup?.lotSize ?? fallbackLotSize(underlying, broker);

  // ── Candles: 1-min backfill per contract + LTP-built live minutes ─
  const barsRef = useRef<Map<string, { minute: string; bars: Bar[]; error?: string }>>(new Map());
  const liveMinRef = useRef<Map<string, LiveMinutes>>(new Map());
  const scopeKey = `${underlying}|${expiry}`;
  const scopeRef = useRef(scopeKey);
  const [rateLimitS, setRateLimitS] = useState(0);
  const [barsStatus, setBarsStatus] = useState<{ have: number; want: number; failed: number }>({ have: 0, want: 0, failed: 0 });

  // Open positions are always fetched, whatever the filters say: the "below day open" prefilter would otherwise drop
  // exactly the strike that has turned against the position.
  const positionsRef = useRef<BsPosition[]>([]);

  useEffect(() => {          // new underlying/expiry: drop every cached bar, they belong to other contracts
    scopeRef.current = scopeKey;
    barsRef.current = new Map();
    liveMinRef.current = new Map();
  }, [scopeKey]);

  /** Contracts worth fetching bars for, nearest ATM first. */
  const candidateContracts = useCallback((): { key: string; option: 'CE' | 'PE'; strike: number }[] => {
    const q = quotesRef.current;
    if (!q) return [];
    const only100 = strike100 && underlying === 'CRUDEOILM';
    const spot = q.spot || 0;
    const atm = q.atm || spot;
    const strikes = Object.keys(q.strikes).map(Number).sort((a, b) => a - b);
    const step = strikes.length > 1 ? Math.min(...strikes.slice(1).map((s, i) => s - strikes[i]).filter((d) => d > 0)) : 50;
    const out: { key: string; option: 'CE' | 'PE'; strike: number; dist: number }[] = [];
    for (const s of strikes) {
      const dSteps = Math.abs(s - atm) / step;
      if (dSteps > atmWindow || dSteps < atmMin) continue;
      if (only100 && s % 100 !== 0) continue;
      for (const option of ['CE', 'PE'] as const) {
        if (side !== 'BOTH' && side !== option) continue;
        if (otmOnly && spot > 0 && ((option === 'CE' && s <= spot) || (option === 'PE' && s >= spot))) continue;
        const d = q.strikes[String(s)]?.[option === 'CE' ? 'ce' : 'pe'];
        if (!d || !(d.ltp > 0) || d.ltp < minLtp || (maxLtp > 0 && d.ltp > maxLtp)) continue;
        // Cheap prefilter that caps Data API calls: a short-able strike is trading below where the day started.
        if (belowOpenOnly && ((d.open ?? 0) > 0 || (d.prev_close ?? 0) > 0) && d.ltp >= Math.max(d.open ?? 0, d.prev_close ?? 0)) continue;
        out.push({ key: `${s}${option}`, option, strike: s, dist: Math.abs(s - atm) });
      }
    }
    return out.sort((a, b) => a.dist - b.dist).slice(0, maxScan);
  }, [atmWindow, atmMin, side, otmOnly, minLtp, maxLtp, belowOpenOnly, maxScan, strike100, underlying]);

  useEffect(() => {
    if (!expiry) return;
    let dead = false;
    let busy = false;
    const minuteNow = () => new Date().toISOString().slice(0, 16);
    const cycle = async () => {
      if (busy || dead || !quotesRef.current) return;
      busy = true;
      const myScope = scopeRef.current;
      try {
        const cands = candidateContracts();
        const heldKeys = positionsRef.current
          .filter((p) => p.status === 'OPEN' && p.qty > 0 && `${p.underlying}|${p.expiry}` === scopeRef.current).map((p) => `${p.strike}${p.option}`);
        const want = [...new Set([...heldKeys, ...cands.map((c) => c.key)])];   // positions first: they alert
        const stale = want.filter((k) => barsRef.current.get(k)?.minute !== minuteNow());
        for (let i = 0; i < stale.length && !dead; i += 10) {
          const chunk = stale.slice(i, i + 10);
          const res = await fetch(`/api/bearish-strikes/bars?underlying=${underlying}&expiry=${expiry}&contracts=${chunk.join(',')}`);
          const j = await res.json() as { success: boolean; bars?: Record<string, Bar[]>; errors?: Record<string, string>; rateLimited?: boolean; retryInS?: number };
          if (!dead) setRateLimitS(j.rateLimited ? (j.retryInS ?? 0) : 0);
          if (scopeRef.current !== myScope) return;          // switched underlying/expiry mid-flight
          for (const k of chunk) {
            const b = j.bars?.[k];
            barsRef.current.set(k, b ? { minute: minuteNow(), bars: b } : { minute: minuteNow(), bars: barsRef.current.get(k)?.bars ?? [], error: j.errors?.[k] ?? 'no data' });
          }
          if (j.rateLimited) break;                              // the route is backing off: do not queue more chunks
        }
        const have = cands.filter((c) => (barsRef.current.get(c.key)?.bars.length ?? 0) > 0).length;
        const failed = cands.filter((c) => barsRef.current.get(c.key)?.error).length;
        if (!dead) setBarsStatus({ have, want: cands.length, failed });
      } catch { /* next cycle retries */ } finally { busy = false; }
    };
    const t0 = setTimeout(cycle, 1500);
    const id = setInterval(cycle, 20_000);
    return () => { dead = true; clearTimeout(t0); clearInterval(id); };
  }, [underlying, expiry, candidateContracts]);

  // ── 1 s compute tick: fold LTP into live minutes, evaluate signals ─
  const [rows, setRows] = useState<Row[]>([]);
  const filters: StrikeFilters = useMemo(() => ({
    side, minLtp, maxLtp, minOiLots, minVolLots, maxSpreadPct: 0, otmOnly, requireSt, requireVwap, requireEma, oiMode,
  }), [side, minLtp, maxLtp, minOiLots, minVolLots, otmOnly, requireSt, requireVwap, requireEma, oiMode]);

  useEffect(() => {
    const id = setInterval(() => {
      const q = quotesRef.current;
      const nowIst = istNowMs();
      setNowTick(Date.now());
      if (!q) return;
      // A stalled feed repeats its last price: folding that into live minutes would fabricate flat bars.
      const feedFresh = !!q.updated_at && Date.now() - Date.parse(q.updated_at) < FEED_FRESH_MS;
      // Only strikes still in the scan (plus held ones) are shown: a strike that left the scan keeps its old candles,
      // and with zero-volume live minutes its VWAP would sit frozen while the row still reads BEARISH.
      const inScan = new Set([
        ...candidateContracts().map((c) => c.key),
        ...positionsRef.current.filter((p) => p.status === 'OPEN' && p.qty > 0 && `${p.underlying}|${p.expiry}` === scopeRef.current).map((p) => `${p.strike}${p.option}`),
      ]);
      const spot = q.spot || 0;
      const next: Row[] = [];
      const only100 = strike100 && underlying === 'CRUDEOILM';
      const sorted = Object.keys(q.strikes).map(Number).sort((a, b) => a - b);
      const gap = sorted.length > 1 ? Math.min(...sorted.slice(1).map((v, i) => v - sorted[i]).filter((d) => d > 0)) : 50;
      const atm = q.atm || spot;
      for (const s of Object.keys(q.strikes)) {
        if (only100 && Number(s) % 100 !== 0) continue;
        if (atmMin > 0 && atm > 0 && Math.abs(Number(s) - atm) / gap < atmMin) continue;   // inside the excluded inner band
        for (const option of ['CE', 'PE'] as const) {
          const d = q.strikes[s]?.[option === 'CE' ? 'ce' : 'pe'];
          if (!d || !(d.ltp > 0)) continue;
          const key = `${s}${option}`;
          let lm = liveMinRef.current.get(key);
          if (!lm) { lm = new Map(); liveMinRef.current.set(key, lm); }
          if (feedFresh) recordTick(lm, d.ltp, nowIst);
          if (!inScan.has(key)) continue;
          const cached = barsRef.current.get(key);
          if (!cached || !cached.bars.length) continue;          // no backfill = no VWAP/ST: never guess
          const ind = computeIndicators(mergeBars(cached.bars, lm), tf, nowIst, indCfg, sessionStartFor(underlying));
          const sig = evaluateBearish(ind);
          const liveBelowAll = sig.stLine != null && sig.vwap != null && sig.ema != null && sig.stDir === -1
            && d.ltp < sig.stLine && d.ltp < sig.vwap && d.ltp < sig.ema;
          const row: Row = {
            key, option, strike: Number(s), ltp: d.ltp, oi: d.oi ?? 0, volume: d.volume ?? 0,
            changePct: d.change_pct ?? null, oiChgPct: d.oi_chg_pct ?? null, buildup: d.buildup ?? '', sig, liveBelowAll,
          };
          if (passesFilters({ option, strike: row.strike, ltp: d.ltp, oi: row.oi, volume: row.volume, spreadPct: null, sig, buildup: row.buildup }, spot, lotSize, filters)) next.push(row);
        }
      }
      const rank = (r: Row) => Number(r.liveBelowAll) * 2 + Number(oiView(r.buildup, r.sig) === 'confirm');   // live-bearish first, OI-backed ahead of the rest
      next.sort((a, b) => (rank(b) - rank(a)) || (b.ltp - a.ltp));
      setRows(next);
    }, 1000);
    return () => clearInterval(id);
  }, [tf, filters, lotSize, strike100, underlying, atmMin, indCfg, candidateContracts]);

  // ── Ledger ──────────────────────────────────────────────────────
  const [positions, setPositions] = useState<BsPosition[]>([]);
  const [ledgerOk, setLedgerOk] = useState(true);
  const refreshLedger = useCallback(async () => {
    try {
      const j = await (await fetch('/api/bearish-strikes/state')).json() as { success: boolean; positions?: BsPosition[] };
      if (j.success && j.positions) { setPositions(j.positions); setLedgerOk(true); }
    } catch { setLedgerOk(false); }
  }, []);
  useEffect(() => {
    const t0 = setTimeout(refreshLedger, 0);
    const id = setInterval(refreshLedger, 5000);
    return () => { clearTimeout(t0); clearInterval(id); };
  }, [refreshLedger]);

  useEffect(() => { positionsRef.current = positions; }, [positions]);

  // ── Exit alerts ─────────────────────────────────────────────────
  // Every second, evaluate each open position of the page's current chain against the ticked levels. A position is
  // evaluated from its own candles + live price, NOT from the table, so it is watched even when the filters hide it.
  const trackerRef = useRef<Tracker>({});
  const [posWatch, setPosWatch] = useState<Record<string, PosWatch>>({});
  const [activeAlerts, setActiveAlerts] = useState<Record<string, Level[]>>({});
  const levelValue = (w: PosWatch | undefined, l: Level): number | null => (!w?.ind ? null : l === 'st' ? w.ind.stLine : l === 'vwap' ? w.ind.vwap : w.ind.ema);

  useEffect(() => {
    const watch: Record<Level, boolean> = { st: watchSt, vwap: watchVwap, ema: watchEma };
    const id = setInterval(() => {
      const q = quotesRef.current;
      const now = Date.now();
      const nowIst = istNowMs();
      const feedFresh = !!q?.updated_at && now - Date.parse(q.updated_at) < 15_000;
      const next: Record<string, PosWatch> = {};
      const obs: { positionId: string; level: Level; state: LevelState }[] = [];
      for (const p of positionsRef.current) {
        if (p.status !== 'OPEN' || !(p.qty > 0)) continue;
        const inScope = `${p.underlying}|${p.expiry}` === scopeRef.current;
        const d = inScope ? q?.strikes[String(p.strike)]?.[p.option === 'CE' ? 'ce' : 'pe'] : undefined;
        const ltp = d && d.ltp > 0 ? d.ltp : null;
        const key = `${p.strike}${p.option}`;
        const cached = inScope ? barsRef.current.get(key) : undefined;
        const ind = cached?.bars.length ? computeIndicators(mergeBars(cached.bars, liveMinRef.current.get(key) ?? new Map()), tf, nowIst, indCfg, sessionStartFor(p.underlying)) : null;
        const states = ind ? levelStates(ind, ltp, alertBasis) : { st: null, vwap: null, ema: null };
        const ws = watchState({ inScope, feedFresh, hasPrice: ltp != null, hasBars: !!ind, states, watch });
        next[p.id] = { ws, states, ind, ltp };
        // While a position cannot be watched its state is "unknown" so an active alert is held, not cleared.
        for (const l of LEVELS) if (watch[l]) obs.push({ positionId: p.id, level: l, state: ws === 'watching' ? states[l] : null });
      }
      const { tracker, events } = stepTracker(trackerRef.current, obs, now);
      trackerRef.current = tracker;
      setPosWatch(next);
      const act: Record<string, Level[]> = {};
      for (const p of positionsRef.current) { const a = activeLevels(tracker, p.id); if (a.length) act[p.id] = a; }
      setActiveAlerts(act);

      for (const ev of events) {
        const p = positionsRef.current.find((x) => x.id === ev.positionId);
        if (!p) continue;
        const w = next[p.id];
        const label = `${p.underlying} ${p.strike} ${p.option}`;
        if (ev.kind === 'recovered') { toast.dismiss(ev.key); toast.success(`${label}: back below ${levelLabel[ev.level]}`, { duration: 4000 }); continue; }
        const lv = levelValue(w, ev.level);
        const text = `${label} — price ${alertBasis === 'live' ? (w?.ltp ?? 0).toFixed(2) : (w?.ind?.close ?? 0).toFixed(2)} is above ${levelLabel[ev.level]}${lv != null ? ` ${lv.toFixed(2)}` : ''}`;
        toast.error(`⚠ ${text}`, { id: ev.key, duration: 10_000, action: { label: 'Exit', onClick: () => setExitId(p.id) } });
        if (alertSound) playAlertSound(audioRef.current);
        try {
          if (alertNotify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('Short position against you', { body: text, tag: ev.key, requireInteraction: true });
          }
        } catch { /* notifications unavailable */ }
      }
    }, 1000);
    return () => clearInterval(id);
  }, [watchSt, watchVwap, watchEma, alertBasis, alertSound, alertNotify, tf, indCfg, levelLabel]);

  // Tab title: the one thing visible from another tab. (Browsers slow background timers, so a hidden tab may be a
  // few tens of seconds late — keep the page in its own window if it must be watched closely.)
  const alertCount = Object.values(activeAlerts).reduce((a, l) => a + l.length, 0);
  useEffect(() => {
    if (alertCount === 0) return;
    const base = document.title;
    document.title = `⚠ ${alertCount} ALERT · ${base}`;
    return () => { document.title = base; };
  }, [alertCount]);

  // Browsers only allow audio after a user gesture: create the context on the first click anywhere on the page.
  useEffect(() => {
    const unlock = () => {
      try {
        if (!audioRef.current && typeof AudioContext !== 'undefined') audioRef.current = new AudioContext();
        if (audioRef.current?.state === 'suspended') void audioRef.current.resume();
      } catch { /* no audio */ }
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  const toggleSound = () => {
    const on = !alertSound;
    setAlertSound(on);
    if (on) playAlertSound(audioRef.current);   // audible confirmation that it works
  };
  const toggleNotify = async () => {
    if (alertNotify) { setAlertNotify(false); return; }
    if (typeof Notification === 'undefined') { toast.error('This browser does not support desktop notifications'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setAlertNotify(perm === 'granted');
    if (perm !== 'granted') toast.warning('Desktop notifications are blocked — allow them in the browser site settings');
  };

  const op = useCallback(async (o: LedgerOp): Promise<boolean> => {
    try {
      const res = await fetch('/api/bearish-strikes/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
      const j = await res.json() as { success: boolean; error?: string; positions?: BsPosition[] };
      if (!j.success) { toast.error(j.error ?? 'Ledger write failed'); return false; }
      // The 1 s loops read positionsRef: update it now, not a render later, so a write is seen by the very next tick.
      if (j.positions) { positionsRef.current = j.positions; setPositions(j.positions); }
      return true;
    } catch { toast.error('Ledger write failed'); return false; }
  }, []);

  // Order outcomes: an ACK is not a fill. Poll every pending order and settle it by order id.
  const settling = useRef(false);
  const warnedUnknown = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = setInterval(async () => {
      if (settling.current) return;
      settling.current = true;
      try {
        for (const p of positionsRef.current) {
          for (const o of p.pendingOrders ?? []) {
            if (p.mode !== 'REAL') continue;
            const bkName = p.broker === 'kotak' ? 'Kotak' : 'Dhan';
            if (isReservation(o.orderId)) {
              // Recorded before sending, broker id never written back: the sending tab died (or is still sending).
              if (Date.now() - o.at > RESERVATION_STALE_MS) {
                await op({ op: 'pending', id: p.id, pending: null, clearOrderId: o.orderId });
                toast.warning(`${p.strike} ${p.option}: an ${o.kind} order may have been sent without being recorded — check the ${bkName} order book`, { duration: 15_000 });
              }
              continue;
            }
            const r = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(o.orderId)}&broker=${p.broker ?? 'dhan'}`).then((x) => x.json()).catch(() => null) as
              { success: boolean; data?: { orderStatus: string; filledQty: number; averageTradedPrice: number } } | null;
            if (!r?.success || !r.data) {
              if (Date.now() - o.at > SETTLE_GIVE_UP_MS && !warnedUnknown.current.has(o.orderId)) {
                warnedUnknown.current.add(o.orderId);
                toast.warning(`Order ${o.orderId} status unknown — check the ${bkName} order book`);
              }
              continue;
            }
            const st = r.data.orderStatus;
            if (st === 'TRADED') await op({ op: 'settle', id: p.id, orderId: o.orderId, filledQty: r.data.filledQty, avgPrice: r.data.averageTradedPrice, at: Date.now() });
            else if (['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(st)) {
              await op({ op: 'settle', id: p.id, orderId: o.orderId, filledQty: r.data.filledQty, avgPrice: r.data.averageTradedPrice, at: Date.now() });
              if (r.data.filledQty === 0) toast.error(`${p.strike} ${p.option} ${o.kind} order ${st.toLowerCase()}`);
            }
          }
        }
      } finally { settling.current = false; }
    }, 4000);
    return () => clearInterval(id);
  }, [op]);

  // Down-only reconcile against the broker for REAL rows: the broker may have LESS than the ledger (closed outside
  // this page), never more. Skipped inside the fill grace and while any order is unresolved.
  useEffect(() => {
    const id = setInterval(async () => {
      const real = positionsRef.current.filter((p) => p.mode === 'REAL' && p.status === 'OPEN' && p.qty > 0 && !p.pendingOrders?.length && Date.now() - p.filledAt > FILL_GRACE_MS);
      if (!real.length) return;
      // Each row against ITS broker's book: Dhan by security id, Kotak by trading symbol (product MIS = INTRADAY).
      for (const bk of ['dhan', 'kotak'] as const) {
        const mine = real.filter((p) => (p.broker ?? 'dhan') === bk);
        if (!mine.length) continue;
        try {
          const j = await (await fetch(bk === 'kotak' ? '/api/scalper/kotak/positions' : '/api/scalper/positions')).json() as { success: boolean; data?: Record<string, unknown>[] };
          if (!j.success || !Array.isArray(j.data)) continue;                     // unreadable book: touch nothing
          for (const p of mine) {
            const rows = j.data.filter((r) => (bk === 'kotak' ? String(r.tradingSymbol) === p.symbol : String(r.securityId) === p.securityId)
              && ['INTRADAY', 'MIS'].includes(String(r.productType ?? 'INTRADAY').toUpperCase()));
            const shortQty = rows.reduce((a, r) => a + Math.max(0, -(Number(r.netQty) || 0)), 0);
            if (shortQty < p.qty) {
              // Price the vanished qty at the live LTP when the page has one (an estimate — the real fill is unknown).
              const q = quotesRef.current;
              const d = `${p.underlying}|${p.expiry}` === scopeRef.current ? q?.strikes[String(p.strike)]?.[p.option === 'CE' ? 'ce' : 'pe'] : undefined;
              const fresh = !!q?.updated_at && Date.now() - Date.parse(q.updated_at) < FEED_FRESH_MS;
              await op({ op: 'clamp', id: p.id, qty: shortQty, at: Date.now(), ...(fresh && d && d.ltp > 0 ? { price: d.ltp } : {}) });
            }
          }
        } catch { /* retry next tick */ }
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [op]);

  // ── Live price lookup for a ledger row ──────────────────────────
  const ltpOf = useCallback((p: Pick<BsPosition, 'underlying' | 'expiry' | 'option' | 'strike'>): number | null => {
    const q = liveQuotes;
    if (!q || p.underlying !== underlying || p.expiry !== expiry) return null;
    const d = q.strikes[String(p.strike)]?.[p.option === 'CE' ? 'ce' : 'pe'];
    return d && d.ltp > 0 ? d.ltp : null;
  }, [liveQuotes, underlying, expiry]);

  // ── Broker order book / trade book / positions (the selected account's whole book — not just this page's rows) ──
  const [showBook, setShowBook] = useState(false);
  const [bookData, setBookData] = useState<{ orders: Record<string, unknown>[]; trades: Record<string, unknown>[]; positions: Record<string, unknown>[] }>({ orders: [], trades: [], positions: [] });
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const fetchBook = useCallback(async () => {
    setBookLoading(true); setBookError(null);
    try {
      const j = await (await fetch(broker === 'kotak' ? '/api/scalper/kotak/poll' : '/api/scalper/poll')).json() as {
        success: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[];
        positionsError?: string | null; error?: string;
      };
      if (j.success) {
        // A positionsError poll carries an EMPTY list ("unknown", not "flat") — keep the last good rows.
        setBookData((d) => ({
          orders: Array.isArray(j.orders) ? j.orders : d.orders,
          trades: Array.isArray(j.trades) ? j.trades : d.trades,
          positions: Array.isArray(j.positions) && !j.positionsError ? j.positions : d.positions,
        }));
      } else setBookError(j.error || j.positionsError || 'Failed to fetch the order book');
    } catch (e) { setBookError(String((e as Error).message)); } finally { setBookLoading(false); }
  }, [broker]);
  useEffect(() => {
    if (!showBook) return;
    const t0 = setTimeout(fetchBook, 0);
    const id = setInterval(fetchBook, 5000);
    return () => { clearTimeout(t0); clearInterval(id); };
  }, [showBook, fetchBook]);

  // ── Tickets (Multi-Leg Focus modals on synthetic basket / leg) ──
  const [sellTicket, setSellTicket] = useState<{ option: 'CE' | 'PE'; strike: number; n: number } | null>(null);
  const [exitId, setExitId] = useState<string | null>(null);

  const basket: MultiLegBasket = useMemo(() => ({
    id: 'bearish-strikes', name: 'Bearish Strikes', underlying, expiry, broker,
    // Today's losing closed shorts feed the Add Leg "bigger than a short that lost today" warning.
    legs: positions.filter((p) => p.underlying === underlying && p.status === 'CLOSED').map((p) => legOf(p)),
    createdAt: '', updatedAt: '',
  }), [underlying, expiry, positions, broker]);

  const strikeList = useMemo(() => Object.keys(liveQuotes?.strikes ?? {}).map(Number).sort((a, b) => a - b), [liveQuotes]);
  const ltpForStrike = useCallback((strike: number, option: 'CE' | 'PE') => ltpOf({ underlying, expiry, option, strike }) ?? 0, [ltpOf, underlying, expiry]);

  const lock = useRef(false);   // taken synchronously before any await: a double-click cannot place twice

  const confirmOrder = useCallback(async (orderId: string, bk: DhanKotak, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const j = await (await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}&broker=${bk}`)).json() as
          { success: boolean; data?: { orderStatus: string; filledQty: number; averageTradedPrice: number; reason: string } };
        if (j.success && j.data) {
          const st = j.data.orderStatus;
          if (st === 'TRADED') return { phase: 'filled' as const, qty: j.data.filledQty, avg: j.data.averageTradedPrice, reason: '' };
          if (['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(st)) return { phase: 'dead' as const, qty: j.data.filledQty, avg: j.data.averageTradedPrice, reason: j.data.reason };
        }
      } catch { /* retry until deadline */ }
      if (Date.now() + 500 > deadline) return { phase: 'pending' as const, qty: 0, avg: 0, reason: '' };
      await new Promise((r) => setTimeout(r, 500));
    }
  }, []);

  /** Sends one order: Dhan through the shared fast-order route (server caps `bs` at 3750 units per order), Kotak by
   *  trading symbol through its own route (which checks the order book itself when the reply is unclear). */
  const sendOrder = useCallback(async (args: {
    broker: DhanKotak; underlying: string;
    side: 'S' | 'B'; option: 'CE' | 'PE'; strike: number; qty: number; type: 'MARKET' | 'LIMIT'; price?: number; ident: string; idem: string;
  }): Promise<{ orderId: string | null; error?: string; unknown?: boolean }> => {
    const req = resolveOrderRequest(args.broker, {
      side: args.side, option: args.option, strike: args.strike, qty: args.qty, type: args.type, price: args.price,
      underlying: args.underlying, productType: 'INTRADAY',
      ...(args.broker === 'kotak' ? { tradingsymbol: args.ident } : { securityId: args.ident }),
    }, {}, SOURCE);
    if (!req) return { orderId: null, error: 'Could not build the order' };
    try {
      const res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req.body, idempotencyKey: args.idem }) });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success && j.order_id) return { orderId: j.order_id };
      return { orderId: null, error: j.error ?? 'Order rejected', unknown: res.status === 504 };
    } catch (e) { return { orderId: null, error: String(e), unknown: true }; }
  }, []);

  const placeSell = useCallback(async (p: {
    option: 'CE' | 'PE'; strike: number; expiry: string; lots: number; orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SLM'; limitPrice?: number;
  }) => {
    if (lock.current) { toast.warning('Another order is still in flight'); return; }
    if (p.orderType !== 'MARKET' && p.orderType !== 'LIMIT') { toast.error('Stop entries are not supported on this page'); return; }
    if (!(p.lots >= 1 && p.lots <= MAX_LOTS) || !Number.isInteger(p.lots)) { toast.error(`Lots must be a whole number between 1 and ${MAX_LOTS}`); return; }
    lock.current = true;
    try {
      const qty = p.lots * lotSize;
      const ltp = ltpOf({ underlying, expiry: p.expiry, option: p.option, strike: p.strike });
      // The same contract on the OTHER broker is another account's position, never one to add to.
      const existing = positions.find((x) => x.status === 'OPEN' && x.mode === mode && (mode === 'SIM' || (x.broker ?? 'dhan') === broker)
        && x.underlying === underlying && x.expiry === p.expiry && x.option === p.option && x.strike === p.strike);
      const label = `${underlying} ${p.strike} ${p.option}`;

      if (mode === 'SIM') {
        const price = p.orderType === 'LIMIT' ? (p.limitPrice ?? 0) : (ltp ?? 0);
        if (!(price > 0)) { toast.error('No live price for this strike yet'); return; }
        if (p.orderType === 'LIMIT' && ltp != null && ltp < price) { toast.error(`SIM limit ${price} is above the market (${ltp}); a sell limit would rest — use MARKET or a lower price`); return; }
        const ok = existing
          ? await op({ op: 'add', id: existing.id, qty, price, at: Date.now() })
          : await op({ op: 'open', position: newPosition({ mode, underlying, expiry: p.expiry, option: p.option, strike: p.strike, lotSize, qty, avgPrice: price }) });
        if (ok) toast.success(`SIM sold ${p.lots} lot${p.lots > 1 ? 's' : ''} ${label} @ ${price.toFixed(2)}`);
        return;
      }

      const ident = lookup?.strikes[String(p.strike)];
      const contract = broker === 'kotak'
        ? (p.option === 'CE' ? ident?.ceSymbol : ident?.peSymbol)
        : (p.option === 'CE' ? ident?.ceId : ident?.peId);
      if (!contract) { toast.error(`No ${broker === 'kotak' ? 'Kotak trading symbol' : 'security id'} for ${label} — lookup not loaded`); return; }
      const bkName = broker === 'kotak' ? 'Kotak' : 'Dhan';
      const idem = `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Record the order BEFORE sending it. The ledger refuses a CLOSED row (this tab's copy can be 5 s old), so a sell
      // can never fill onto a row nothing watches; nothing is sent if the reservation is refused.
      const resv: PendingOrder = { orderId: `${RESERVATION_PREFIX}${idem}`, kind: 'entry', side: 'SELL', qty, at: Date.now() };
      let rowId: string;
      if (existing) {
        if (!await op({ op: 'pending', id: existing.id, pending: resv })) { void refreshLedger(); return; }
        rowId = existing.id;
      } else {
        const np = newPosition({
          mode, underlying, expiry: p.expiry, option: p.option, strike: p.strike, lotSize, qty: 0, avgPrice: 0, broker,
          ...(broker === 'kotak' ? { symbol: contract } : { securityId: contract }), pendingOrders: [resv],
        });
        if (!await op({ op: 'open', position: np })) { void refreshLedger(); return; }
        rowId = np.id;
      }
      const r = await sendOrder({ broker, underlying, side: 'S', option: p.option, strike: p.strike, qty, type: p.orderType, price: p.limitPrice, ident: contract, idem });
      if (!r.orderId) {
        // Unknown outcome: keep the reservation — it blocks a blind re-send and is cleared with a warning after a minute.
        if (!r.unknown) await op({ op: 'pending', id: rowId, pending: null, clearOrderId: resv.orderId });
        toast.error(r.unknown ? `Order status unknown for ${label} — check ${bkName} Positions/Orders before retrying` : `Order rejected: ${r.error}`);
        return;
      }
      const tracked = await op({ op: 'pending', id: rowId, pending: { ...resv, orderId: r.orderId, at: Date.now() }, clearOrderId: resv.orderId });
      if (!tracked) { toast.error(`Order ${r.orderId} was sent but could not be recorded — check ${bkName} Positions`); return; }
      const c = await confirmOrder(r.orderId, broker);
      if (c.phase === 'pending') { toast.warning(`${label} order still working — it is tracked and will settle automatically`); return; }
      await op({ op: 'settle', id: rowId, orderId: r.orderId, filledQty: c.qty, avgPrice: c.avg, at: Date.now() });
      if (c.phase === 'filled') toast.success(`Sold ${p.lots} lot${p.lots > 1 ? 's' : ''} ${label} @ ${c.avg.toFixed(2)}`);
      else toast.error(`${label} order ${c.reason || 'rejected'}`);
    } finally { lock.current = false; }
  }, [lotSize, ltpOf, underlying, positions, mode, op, lookup, sendOrder, confirmOrder, broker, refreshLedger]);

  const doExit = useCallback(async (pos: BsPosition, lots: number, orderType: 'MARKET' | 'LIMIT', limitPrice?: number): Promise<boolean> => {
    if (lock.current) { toast.warning('Another order is still in flight'); return false; }
    lock.current = true;
    try {
      const label = `${pos.underlying} ${pos.strike} ${pos.option}`;
      // Exit what THIS ledger owns, never what the broker nets.
      const qty = Math.min(pos.qty, Math.round(lots * pos.lotSize));
      if (!(qty > 0)) { toast.error('Nothing to exit'); return false; }
      const ltp = ltpOf(pos);
      if (pos.mode === 'SIM') {
        const price = orderType === 'LIMIT' ? (limitPrice ?? 0) : (ltp ?? 0);
        if (!(price > 0)) { toast.error('No live price for this strike yet'); return false; }
        if (orderType === 'LIMIT' && ltp != null && ltp > price) { toast.error(`SIM limit ${price} is below the market (${ltp}); a buy limit would rest — use MARKET`); return false; }
        const ok = await op({ op: 'reduce', id: pos.id, qty, price, at: Date.now() });
        if (ok) toast.success(`SIM bought back ${label} @ ${price.toFixed(2)}`);
        return ok;
      }
      const bk: DhanKotak = pos.broker ?? 'dhan';
      const bkName = bk === 'kotak' ? 'Kotak' : 'Dhan';
      const contract = bk === 'kotak' ? pos.symbol : pos.securityId;
      if (!contract) { toast.error(`Position has no ${bkName === 'Kotak' ? 'Kotak trading symbol' : 'security id'}`); return false; }
      // A resting exit must be cancelled first or the two would together over-buy; abort if the cancel fails.
      for (const o of (pos.pendingOrders ?? []).filter((x) => x.kind === 'exit')) {
        if (isReservation(o.orderId)) { toast.error(`Another exit for ${label} is being sent right now — wait for it to settle`); return false; }
        const cr = await fetch('/api/scalper/orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: o.orderId, broker: bk }) }).then((x) => x.json()).catch(() => null) as { success?: boolean } | null;
        if (!cr?.success) { toast.error(`Could not cancel the resting exit ${o.orderId}; exit not sent`); return false; }
        // A cancel ACK is not proof (Kotak can answer 200 with an error body), and the order may have part-filled before
        // it died: read its final state and book exactly what it filled, or send nothing.
        const fin = await confirmOrder(o.orderId, bk, 5000);
        if (fin.phase === 'pending') { toast.error(`Resting exit ${o.orderId} still shows as working after the cancel — new exit not sent; check the ${bkName} order book`); return false; }
        await op({ op: 'settle', id: pos.id, orderId: o.orderId, filledQty: fin.qty, avgPrice: fin.avg, at: Date.now() });
      }
      // Size from the ledger as it is NOW, not as this modal last saw it (a cancelled exit may have part-filled).
      const now = await readLedgerRow(pos.id);
      if (!now) { toast.error('Ledger unreachable — exit not sent'); return false; }
      setPositions(now.all);
      const row = now.row;
      if (!row || row.status !== 'OPEN' || !(row.qty > 0)) { toast.success(`${label} is already flat`); return true; }
      const xqty = Math.min(row.qty, Math.round(lots * row.lotSize));
      const idem = `bs-x-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // Reserve before sending: the ledger refuses an exit that would take the working exits past the owned qty, so a
      // second tab (or auto-exit racing a click) cannot send a second buy-back.
      const resv: PendingOrder = { orderId: `${RESERVATION_PREFIX}${idem}`, kind: 'exit', side: 'BUY', qty: xqty, at: Date.now() };
      if (!await op({ op: 'pending', id: row.id, pending: resv })) return false;
      const r = await sendOrder({ broker: bk, underlying: row.underlying, side: 'B', option: row.option, strike: row.strike, qty: xqty, type: orderType, price: limitPrice, ident: contract, idem });
      if (!r.orderId) {
        if (!r.unknown) await op({ op: 'pending', id: row.id, pending: null, clearOrderId: resv.orderId });
        toast.error(r.unknown ? `Exit status unknown for ${label} — check ${bkName} Positions before retrying` : `Exit rejected: ${r.error}`);
        return false;
      }
      await op({ op: 'pending', id: row.id, pending: { ...resv, orderId: r.orderId, at: Date.now() }, clearOrderId: resv.orderId });
      const c = await confirmOrder(r.orderId, bk);
      if (c.phase === 'pending') { toast.warning(`${label} exit still working — tracked, will settle automatically`); return true; }
      await op({ op: 'settle', id: row.id, orderId: r.orderId, filledQty: c.qty, avgPrice: c.avg, at: Date.now() });
      if (c.phase === 'filled') toast.success(`Bought back ${label} @ ${c.avg.toFixed(2)}`);
      else toast.error(`${label} exit ${c.reason || 'rejected'} — position is still open`);
      return c.phase === 'filled';
    } finally { lock.current = false; }
  }, [ltpOf, op, sendOrder, confirmOrder]);

  const exitAll = useCallback(async () => {
    const open = positions.filter((p) => p.status === 'OPEN' && p.qty > 0 && p.mode === mode);
    if (!open.length) return;
    if (!window.confirm(`Buy back ${open.length} open ${mode} short${open.length > 1 ? 's' : ''} at market?`)) return;
    for (const p of open) await doExit(p, p.qty / p.lotSize, 'MARKET');
  }, [positions, mode, doExit]);

  // ── SL / Target / Trailing SL ───────────────────────────────────
  // Live premium vs the % rules in `risk`. The trailing anchor (lowest premium while the trail is on) is persisted on
  // the ledger row, so a reload cannot loosen the trail. Fires on the live price only (no closed-bar basis).
  // The anchor is tracked only while Trail > 0 and restarts when the user switches Trail on: a low recorded while
  // the trail was off would otherwise fire it (and auto-exit at MARKET) the instant it is enabled.
  const [riskHits, setRiskHits] = useState<Record<string, RiskHit>>({});
  const lowSent = useRef<Record<string, { v: number; at: number }>>({});
  const riskNotified = useRef<Record<string, string>>({});
  useEffect(() => {
    const id = setInterval(() => {
      const q = quotesRef.current;
      const now = Date.now();
      const fresh = !!q?.updated_at && now - Date.parse(q.updated_at) < 15_000;
      const hits: Record<string, RiskHit> = {};
      for (const p of positionsRef.current) {
        if (p.status !== 'OPEN' || !(p.qty > 0) || p.side !== 'S') continue;
        if (`${p.underlying}|${p.expiry}` !== scopeRef.current || !fresh) continue;
        const d = q?.strikes[String(p.strike)]?.[p.option === 'CE' ? 'ce' : 'pe'];
        const ltp = d && d.ltp > 0 ? d.ltp : null;
        if (ltp == null) continue;
        const sent = lowSent.current[p.id];
        const known = Math.min(p.low ?? Infinity, sent?.v ?? Infinity);
        if (risk.trail > 0) {     // new low: remember it now, persist at most every 5 s (a low held back is flushed on a later tick)
          if (ltp < known) lowSent.current[p.id] = { v: ltp, at: sent?.at ?? 0 };
          const cur = lowSent.current[p.id];
          if (cur && cur.v < (p.low ?? Infinity) && now - cur.at > 5000) { cur.at = now; void op({ op: 'low', id: p.id, low: cur.v }); }
        }
        const low = Math.min(known, ltp);
        const hit = riskHit(p.avgPrice, Number.isFinite(low) ? low : null, ltp, risk);
        if (!hit) { delete riskNotified.current[p.id]; continue; }
        hits[p.id] = hit;
        if (riskNotified.current[p.id] !== hit) {
          riskNotified.current[p.id] = hit;
          const label = `${p.underlying} ${p.strike} ${p.option}`;
          toast.error(`⚠ ${label} — ${hit === 'SL' ? 'stop-loss' : hit === 'TRAIL' ? 'trailing stop' : 'target'} hit @ ${ltp.toFixed(2)}`,
            { id: `risk-${p.id}`, duration: 10_000, action: { label: 'Exit', onClick: () => setExitId(p.id) } });
          if (alertSound) playAlertSound(audioRef.current);
        }
      }
      setRiskHits((prev) => (JSON.stringify(prev) === JSON.stringify(hits) ? prev : hits));
    }, 1000);
    return () => clearInterval(id);
  }, [risk, alertSound, op]);

  /** Trail switched on (0 -> >0) by the user: restart every open short's anchor at its entry, so trailing starts now. */
  const restartTrailAnchors = useCallback(async () => {
    for (const p of positionsRef.current) {
      if (p.status !== 'OPEN' || !(p.qty > 0) || !(p.avgPrice > 0)) continue;
      delete lowSent.current[p.id];
      await op({ op: 'low', id: p.id, low: p.avgPrice, reset: true });
    }
  }, [op]);

  // ── Auto-exit: an active alert (already debounced by the tracker) on a position sends a MARKET buy-back for what
  // this ledger owns. Opt-in per page load. At most 3 tries per position, 8 s apart, then it is left to the user.
  const autoTries = useRef<Record<string, { n: number; at: number }>>({});
  useEffect(() => {
    if (!autoExit) return;
    const now = Date.now();
    for (const id of Array.from(new Set([...Object.keys(activeAlerts), ...Object.keys(riskHits)]))) {
      if (lock.current) return;
      const p = positionsRef.current.find((x) => x.id === id);
      if (!p || p.status !== 'OPEN' || !(p.qty > 0)) continue;
      if (p.pendingOrders?.some((o) => o.kind === 'exit')) continue;   // an exit is already working
      const t = autoTries.current[id] ?? { n: 0, at: 0 };
      if (t.n >= 3 || now - t.at < 8000) continue;
      autoTries.current[id] = { n: t.n + 1, at: now };
      const why = [...(activeAlerts[id] ?? []).map((l) => `${levelLabel[l]} breached`), ...(riskHits[id] ? [riskHits[id] === 'SL' ? 'stop-loss hit' : riskHits[id] === 'TRAIL' ? 'trailing stop hit' : 'target hit'] : [])].join(' + ');
      toast.warning(`AUTO-EXIT ${p.underlying} ${p.strike} ${p.option} — ${why}`, { duration: 6000 });
      void doExit(p, p.qty / p.lotSize, 'MARKET');
      return;   // one order at a time; the next position goes on the next pass
    }
  }, [autoExit, activeAlerts, riskHits, doExit, levelLabel]);

  // ── Derived header state ────────────────────────────────────────
  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const exitPos = positions.find((p) => p.id === exitId) ?? null;
  const spot = liveQuotes?.spot ?? 0;
  const feedAge = liveQuotes?.updated_at ? (nowTick - new Date(liveQuotes.updated_at).getTime()) / 1000 : null;
  const stale = bridgeStatus.status !== 'RUNNING' || (feedAge != null && feedAge > 15);
  const dataDate = liveQuotes?.updated_at ? liveQuotes.updated_at.slice(0, 10) : null;
  const totalPnl = openPositions.reduce<number | null>((a, p) => {
    const v = legPnl(p, ltpOf(p));
    return a == null || v == null ? null : a + v;
  }, 0);
  const warming = rows.length === 0 && barsStatus.want > 0 && barsStatus.have < barsStatus.want;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ── Header ── */}
      <div className="sticky top-0 z-30 flex flex-col gap-2 px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 bg-emerald-500/10 border-emerald-500/25">
              <TrendingDown className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 text-emerald-400">Scalping · {underlying}</p>
              <h1 className="text-sm font-bold text-white tracking-tight leading-none">Bearish Strikes</h1>
              <p className="text-[10px] text-zinc-500 font-medium mt-1">Below {stName}, VWAP and {emaName} — short candidates, live</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {indexChip('Nifty', 'NIFTY')}
            {indexChip('India VIX', 'VIX')}
            {underlying !== 'NIFTY' && <span className="text-xs font-mono text-zinc-300">{underlying} <span className="font-bold text-white">{fmt(spot)}</span></span>}
            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${stale ? 'text-amber-300 bg-amber-500/10 border-amber-500/20' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'}`}
              title={`Bridge ${bridgeStatus.status} · ${transport.toUpperCase()}${lastUpdated ? ` · ${lastUpdated}` : ''}`}>
              {bridgeStatus.status !== 'RUNNING' ? `FEED ${bridgeStatus.status}` : stale ? `STALE ${feedAge != null ? Math.round(feedAge) : '?'}s` : `LIVE · ${transport.toUpperCase()}`}
            </span>
            <button
              type="button" onClick={() => setShowBook(true)}
              title={`${broker === 'kotak' ? 'Kotak' : 'Dhan'} order book, trade book and open positions (whole account)`}
              className={`h-7 px-2 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800 hover:text-white flex items-center gap-1 ${FOCUS_RING}`}
            >
              <ClipboardList className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />Orders · Trades · Positions
            </button>
            {alertCount > 0 && (
              <span role="status" className="text-[11px] font-bold font-mono px-2 py-0.5 rounded border border-red-500/50 bg-red-500/15 text-red-400 flex items-center gap-1 animate-pulse">
                <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />{alertCount} ALERT{alertCount > 1 ? 'S' : ''}
              </span>
            )}
            <BrokerPicker value={broker} onChange={setBroker} disabled={armed}
              disabledReason="Return to SIM first: new sells must not switch account while armed. Open rows always exit on their own broker." />
            <button
              type="button" onClick={() => setArmed((a) => !a)} aria-pressed={armed}
              title={armed ? `REAL orders go to ${broker === 'kotak' ? 'Kotak' : 'Dhan'}. Click to return to SIM.` : `SIM: paper fills at live LTP. Click to arm REAL (${broker === 'kotak' ? 'Kotak' : 'Dhan'}, per page load).`}
              className={`h-7 px-2 rounded border text-[11px] font-bold font-mono flex items-center gap-1 ${FOCUS_RING} ${armed ? 'bg-red-600 border-red-500 text-oncolor' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white'}`}
            >
              <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />{armed ? 'LIVE · REAL MONEY' : 'SIM'}
            </button>
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
              DATA: {dataDate || '—'}
            </span>
            <span className="w-px h-5 bg-zinc-800 shrink-0" />
            <NavBar />
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
          <Seg label="Underlying" value={underlying} onChange={setUnderlying} options={UNDERLYINGS.map((u) => ({ v: u, l: u }))} />
          <select aria-label="Expiry" value={expiry} onChange={(e) => setExpiry(e.target.value)}
            className={`h-7 bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono text-xs rounded px-1.5 ${FOCUS_RING}`}>
            {expiries.map((e) => <option key={e} value={e}>{formatExpiryLabel(e)} · {dte(e)}d</option>)}
          </select>
          <Seg label="Timeframe" value={tf} onChange={setTf} options={[{ v: 1, l: '1m' }, { v: 3, l: '3m' }, { v: 5, l: '5m' }]} />
          <Seg label="Side" value={side} onChange={setSide} options={[{ v: 'BOTH', l: 'CE+PE' }, { v: 'CE', l: 'CE' }, { v: 'PE', l: 'PE' }]} />
          <div role="group" aria-label="Conditions" className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 h-7"
            title="A strike must be below EVERY ticked level on the last closed bar. Untick one to ignore it (e.g. EMA20 while it is still warming up).">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Below</span>
            {([['Supertrend', requireSt, setRequireSt], ['VWAP', requireVwap, setRequireVwap], [emaName, requireEma, setRequireEma]] as const).map(([l, v, set]) => (
              <label key={l} className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} className={FOCUS_RING} />{l}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-1" title="OI buildup vs the bearish signal. Confirmed = short buildup (SB) or long unwinding (LU); conflict = long buildup (LB). Labels are the live feed's, measured against the previous day.">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">OI</span>
            <Seg label="OI buildup" value={oiMode} onChange={setOiMode} options={[{ v: 'any', l: 'Any' }, { v: 'confirm', l: 'SB / LU' }, { v: 'no-conflict', l: 'Not LB' }]} />
          </div>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
            <input type="checkbox" checked={otmOnly} onChange={(e) => setOtmOnly(e.target.checked)} className={FOCUS_RING} />OTM only
          </label>
          <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400"
            title="Only fetch candles for strikes trading below the day's open / previous close. Caps Data API calls; untick to scan every strike in the window.">
            <input type="checkbox" checked={belowOpenOnly} onChange={(e) => setBelowOpenOnly(e.target.checked)} className={FOCUS_RING} />Below day open
          </label>
          {underlying === 'CRUDEOILM' && (
            <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400"
              title="Only consider strikes divisible by 100 (e.g. 8500, 8600) — skips the 50-point strikes like 8550">
              <input type="checkbox" checked={strike100} onChange={(e) => setStrike100(e.target.checked)} className={FOCUS_RING} />100s only
            </label>
          )}
          <NumField label="Min ₹" value={minLtp} onCommit={setMinLtp} step={0.5} />
          <NumField label="Max ₹" value={maxLtp} onCommit={setMaxLtp} step={5} title="Only strikes priced at or below this premium. 0 = off." />
          <NumField label="Min OI lots" value={minOiLots} onCommit={setMinOiLots} width="w-20" />
          <NumField label="Min vol lots" value={minVolLots} onCommit={setMinVolLots} width="w-20" />
          <NumField label="ATM from" value={atmMin} title="Inner edge in strikes from ATM, both sides. 4 with ATM ± 8 scans ATM+4…+8 and ATM-4…-8 only."
            onCommit={(n) => { const v = Math.round(n); setAtmMin(v); setAtmWindow((w) => Math.max(w, v, 1)); }} />
          <NumField label="to ±" value={atmWindow} onCommit={(n) => { const v = Math.max(1, Math.round(n)); setAtmWindow(v); setAtmMin((m) => Math.min(m, v)); }} />
          <button type="button" onClick={() => setShowSettings(true)} aria-label="Indicator settings" title="Indicator settings"
            className={`h-7 w-7 inline-flex items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
            <Settings className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <NumField label="Scan max" value={maxScan} onCommit={(n) => setMaxScan(Math.min(60, Math.max(5, Math.round(n))))} />
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {alertCount > 0 && (
          // The red tint is its own empty layer, NOT a class on the container: in white mode globals.css recolours every
          // DESCENDANT of a bg-red-500/NN element dark red with !important, which turned the EXIT NOW label into dark red
          // on red. With the tint on a sibling layer nothing inside the banner is a descendant of it.
          <section aria-label="Position alerts" role="alert" className="relative rounded-xl border border-red-500/50 px-4 py-3 space-y-2">
            <div aria-hidden="true" className="absolute inset-0 rounded-xl bg-red-500/10 pointer-events-none" />
            <h2 className="relative text-xs font-bold text-red-400 uppercase tracking-wide flex items-center gap-1.5"><TriangleAlert className="w-4 h-4" aria-hidden="true" />Your short is moving against you</h2>
            {openPositions.filter((p) => activeAlerts[p.id]).map((p) => {
              const w = posWatch[p.id];
              return (
                <div key={p.id} className="relative flex items-center justify-between gap-3 flex-wrap text-xs font-mono">
                  <span className="text-zinc-100">
                    <span className="font-bold">{p.mode} · {p.underlying} {p.strike} {p.option}</span>
                    {' — price '}<span className="font-bold">{fmt(w?.ltp)}</span>{' above '}
                    {activeAlerts[p.id].map((l, i) => <span key={l} className="text-red-400 font-bold">{i ? ', ' : ''}{levelLabel[l]} {fmt(levelValue(w, l))}</span>)}
                  </span>
                  <button type="button" onClick={() => setExitId(p.id)} aria-label={`Exit ${p.strike} ${p.option} now`}
                    className={`h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-oncolor text-[11px] font-bold ${FOCUS_RING}`}>EXIT NOW</button>
                </div>
              );
            })}
          </section>
        )}
        {(() => {
          const blind = openPositions.filter((p) => posWatch[p.id] && posWatch[p.id].ws !== 'watching' && (watchSt || watchVwap || watchEma));
          if (!blind.length) return null;
          return (
            <section aria-label="Unmonitored positions" role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
              <span className="font-bold">{blind.length} open position{blind.length > 1 ? 's are' : ' is'} not being watched right now.</span>{' '}
              {blind.map((p) => `${p.strike} ${p.option}: ${WATCH_WHY[posWatch[p.id].ws as Exclude<WatchState, 'watching'>]}`).join(' · ')}
            </section>
          );
        })()}
        {/* Table */}
        <section aria-label="Bearish strikes" className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <table className="w-full text-xs font-mono tabular-nums">
            <thead>
              <tr className="bg-zinc-800">
                {[
                  ['Strike', 'text-left'], ['LTP · Chg%', 'text-right'], [`Supertrend ${tf}m`, 'text-right'], ['VWAP', 'text-right'], [emaName, 'text-right'],
                  ['OI lots · Δ% · Build', 'text-right'], ['Vol lots', 'text-right'], ['ST · VW · EMA · OI', 'text-center'], ['Signal', 'text-center'], ['', 'text-right'],
                ].map(([h, al], i) => (
                  <th key={i} className={`px-3 py-2 text-xs font-bold text-white whitespace-nowrap ${al}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const lot = lotSize || 1;
                const full = r.sig.bearish === true;
                const oi = oiView(r.buildup, r.sig);
                // Which levels the live price has climbed back above (the reason a closed-bar-bearish row is only WATCH).
                const aboveNames = (x: Row) => {
                  const n = [x.sig.stLine != null && x.ltp >= x.sig.stLine ? 'ST' : '', x.sig.vwap != null && x.ltp >= x.sig.vwap ? 'VWAP' : '',
                    x.sig.ema != null && x.ltp >= x.sig.ema ? emaName : ''].filter(Boolean);
                  return n.length ? n.join(' + ') : 'a level';
                };
                // Level over "how far price sits from it": ▼ price is below the level (what a seller wants), ▲ above.
                const level = (v: number | null, below: boolean | null) => {
                  const d = pctBelow(v, r.ltp);
                  return (
                    <div className="leading-tight">
                      <div className="text-zinc-200">{fmt(v)}</div>
                      <div className={`text-[10px] ${below ? 'text-emerald-400' : 'text-zinc-500'}`}>
                        {d == null ? '—' : `${d >= 0 ? '▼' : '▲'} ${Math.abs(d).toFixed(1)}%`}
                      </div>
                    </div>
                  );
                };
                return (
                  <tr key={r.key} className="border-t border-zinc-800 hover:bg-zinc-900/60">
                    <td className={`px-3 py-1.5 text-left whitespace-nowrap border-l-2 ${oi === 'confirm' ? 'border-l-emerald-500' : oi === 'conflict' ? 'border-l-amber-400' : 'border-l-transparent'}`}>
                      <span className="font-bold text-zinc-100">{r.strike}</span>
                      <span className={`ml-1.5 px-1 py-0.5 rounded text-[10px] font-bold ${r.option === 'CE' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{r.option}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="leading-tight">
                        <div className="font-bold text-zinc-100">{fmt(r.ltp)}</div>
                        <div className={`text-[10px] ${pnlCls(r.changePct)}`}>{r.changePct == null ? '—' : `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(1)}%`}</div>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">{level(r.sig.stLine, r.sig.below.st)}</td>
                    <td className="px-3 py-1.5 text-right">{level(r.sig.vwap, r.sig.below.vwap)}</td>
                    <td className="px-3 py-1.5 text-right">{level(r.sig.ema, r.sig.below.ema)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <div className="leading-tight">
                        <div className="text-zinc-200">{(r.oi / lot).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                        <div className="text-[10px]">
                          <span className={pnlCls(r.oiChgPct)}>{r.oiChgPct == null ? '—' : `${r.oiChgPct > 0 ? '+' : ''}${r.oiChgPct.toFixed(0)}%`}</span>
                          {r.buildup && <span className={`ml-1 ${oi === 'confirm' ? 'text-emerald-400 font-bold' : oi === 'conflict' ? 'text-amber-300 font-bold' : 'text-zinc-400'}`}>{r.buildup}</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-200">{(r.volume / lot).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td className="px-3 py-1.5 text-center whitespace-nowrap">
                      {/* Traffic lights. Green = price below the level (what a seller wants), red = above it, amber = the closed bar
                          is below but the live price has crept back above, grey = still warming up. OI: green = SB/LU, red = LB. */}
                      <span className="inline-flex items-center gap-1.5" role="img"
                        aria-label="Indicator lights: Supertrend, VWAP, EMA20, open interest">
                        {([['Supertrend', r.sig.below.st, r.sig.stLine], ['VWAP', r.sig.below.vwap, r.sig.vwap], [emaName, r.sig.below.ema, r.sig.ema]] as const).map(([name, below, lv]) => {
                          const liveAbove = below === true && lv != null && r.ltp >= lv;
                          const cls = below == null ? 'bg-zinc-600' : liveAbove ? 'bg-amber-400' : below ? 'bg-emerald-400' : 'bg-red-400';
                          const why = below == null ? 'warming up' : liveAbove ? 'closed bar below, but live price is back above' : below ? 'price is below (good for a short)' : 'price is above (against a short)';
                          return <span key={name} className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} title={`${name}: ${why}`} />;
                        })}
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${oi === 'confirm' ? 'bg-emerald-400' : oi === 'conflict' ? 'bg-red-400' : 'bg-zinc-600'}`}
                          title={oi === 'confirm' ? `OI: ${r.buildup} backs the short` : oi === 'conflict' ? 'OI: long buildup disagrees' : 'OI: no clear read'} />
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-center whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${full && r.liveBelowAll ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : full ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' : 'bg-zinc-900 text-zinc-400 border-zinc-700'}`}
                        title={full ? (r.liveBelowAll ? 'Closed bar AND live price are below all three levels' : `WATCH: the closed bar is bearish, but the live price is back above ${aboveNames(r)}`) : 'Not all three conditions hold on the closed bar'}>
                        {full ? (r.liveBelowAll ? 'BEARISH' : `WATCH · ${aboveNames(r)}`) : `${[r.sig.below.st, r.sig.below.vwap, r.sig.below.ema].filter(Boolean).length}/3`}
                      </span>
                      {oi && (
                        <div className="mt-1">
                          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${oi === 'confirm' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-amber-500/10 text-amber-300 border-amber-500/40'}`}
                            title={oi === 'confirm'
                              ? `${r.buildup === 'SB' ? 'Short buildup: price down with OI up (writers adding)' : 'Long unwinding: price down with OI down (longs leaving)'} — positioning backs the bearish signal`
                              : 'Long buildup: price up with OI up (fresh longs) — today\'s positioning disagrees with the bearish bars. Labels are vs the previous day.'}>
                            {oi === 'confirm' ? `OI ✓ ${r.buildup}` : `OI ⚠ ${r.buildup}`}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <button type="button" onClick={() => setSellTicket({ option: r.option, strike: r.strike, n: Date.now() })}
                        aria-label={`Sell ${r.strike} ${r.option}`}
                        className={`h-6 px-2.5 rounded bg-red-600 hover:bg-red-500 text-oncolor text-[11px] font-bold ${FOCUS_RING}`}>SELL</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-xs text-zinc-400" role="status">
              {!expiry ? 'Loading expiries…'
                : !liveQuotes ? (bridgeStatus.status === 'ERROR' ? 'Live feed error — check the Dhan session and the options bridge.' : 'Waiting for the live options feed…')
                : warming ? `Loading candles… ${barsStatus.have}/${barsStatus.want} contracts${barsStatus.failed ? ` (${barsStatus.failed} failed)` : ''}`
                : barsStatus.failed && barsStatus.failed === barsStatus.want ? 'Candle fetch failed for every contract — the Dhan Data API may be rate-limited or the session expired.'
                : 'No strike matches right now. Indicators are warmed from the previous 2 sessions (a strike with no earlier history needs 11+ closed bars for Supertrend and 20+ for EMA20) — widen the filters or untick a level.'}
            </div>
          )}
          <div className="px-3 py-1.5 border-t border-zinc-800 text-[10px] text-zinc-500 flex flex-wrap gap-x-4">
            {rateLimitS > 0 && <span className="text-amber-300 font-bold">Dhan Data API rate-limited — showing cached candles, retrying in ~{rateLimitS}s</span>}
            <span>{rows.length} shown · candles {barsStatus.have}/{barsStatus.want}{barsStatus.failed ? ` · ${barsStatus.failed} failed` : ''}</span>
            <span>OI ✓ = bearish signal backed by short buildup (SB) or long unwinding (LU); OI ⚠ = bearish signal but long buildup (LB).</span>
            <span>Signals use the last CLOSED {tf}m bar. ▼ = price below that level. BEARISH = live price also below all three; WATCH = closed bar bearish but live price back above one.</span>
            <span>Lot {lotSize} · feed window is fixed when the bridge starts.</span>
          </div>
        </section>

        {/* Positions */}
        <section aria-label="Positions on this page" className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-x-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <h2 className="text-xs font-bold text-zinc-100 uppercase tracking-wide">
              Positions ({openPositions.length} open) <span className={`ml-2 font-mono ${pnlCls(totalPnl)}`}>{money(totalPnl)}</span>
              {!ledgerOk && <span className="ml-2 text-amber-300 text-[10px]">ledger unreachable</span>}
            </h2>
            <div role="group" aria-label="Exit alerts" className="flex items-center gap-2 flex-wrap"
              title="Alert when the live price (or the last closed bar) of an open short goes ABOVE a ticked level.">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1"><Bell className="w-3 h-3" aria-hidden="true" />Alert above</span>
              {([['Supertrend', watchSt, setWatchSt], ['VWAP', watchVwap, setWatchVwap], [emaName, watchEma, setWatchEma]] as const).map(([l, v, set]) => (
                <label key={l} className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-300 cursor-pointer">
                  <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} className={FOCUS_RING} />{l}
                </label>
              ))}
              <Seg label="Alert basis" value={alertBasis} onChange={setAlertBasis} options={[{ v: 'live', l: 'Live price' }, { v: 'closed', l: 'Closed bar' }]} />
              <button type="button" onClick={toggleSound} aria-pressed={alertSound} aria-label="Alert sound"
                title={alertSound ? 'Sound on' : 'Sound off'}
                className={`h-7 w-7 inline-flex items-center justify-center rounded border ${FOCUS_RING} ${alertSound ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-500'}`}>
                {alertSound ? <Bell className="w-3.5 h-3.5" aria-hidden="true" /> : <BellOff className="w-3.5 h-3.5" aria-hidden="true" />}
              </button>
              <button type="button" onClick={toggleNotify} aria-pressed={alertNotify}
                title="Desktop notification (works while the tab is in the background)"
                className={`h-7 px-2 rounded border text-[10px] font-bold uppercase tracking-wider ${FOCUS_RING} ${alertNotify ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                Desktop {alertNotify ? 'on' : 'off'}
              </button>
            </div>
            <NumField label="SL %" value={risk.sl} step={5} width="w-14" title="Stop-loss: exit when the premium rises this % above your average sell price. 0 = off."
              onCommit={(n) => setRisk((r0) => ({ ...r0, sl: Math.min(1000, n) }))} />
            <NumField label="Target %" value={risk.tgt} step={5} width="w-14" title="Target: exit when the premium falls this % below your average sell price. 0 = off."
              onCommit={(n) => setRisk((r0) => ({ ...r0, tgt: Math.min(100, n) }))} />
            <NumField label="Trail pts" value={risk.trail} step={0.5} width="w-14" title="Trailing stop in premium points: once the premium has traded below your entry, the stop sits this many points above its lowest point and follows it 1:1 as it falls. 0 = off."
              onCommit={(n) => {
                const v = Math.min(1000, n);
                // Switching on: the new trail only takes effect once every anchor has restarted.
                if (risk.trail <= 0 && v > 0) void restartTrailAnchors().then(() => setRisk((r0) => ({ ...r0, trail: v })));
                else setRisk((r0) => ({ ...r0, trail: v }));
              }} />
            <label className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-300 cursor-pointer"
              title="When a ticked alert fires, or the SL / Target / Trail below is hit, on an open position (SIM or REAL), buy it back at MARKET automatically. Works only while this tab is open; off after a reload. Max 3 tries per position.">
              <input type="checkbox" checked={autoExit} onChange={(e) => setAutoExit(e.target.checked)} className={FOCUS_RING} />Auto-exit on alert
            </label>
            <button type="button" onClick={exitAll} disabled={!openPositions.some((p) => p.mode === mode)}
              className={`h-7 px-2 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 flex items-center gap-1 ${FOCUS_RING}`}>
              <LogOut className="w-3.5 h-3.5" aria-hidden="true" />Exit all {mode}
            </button>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-zinc-800">
                {['Mode', 'Side', 'Contract', 'Qty', 'Avg', 'LTP', 'Exit', 'Decay %', 'P&L', 'Opened', 'Closed', 'SL / Tgt / Trail', 'Watch', 'Status', ''].map((h, i) => (
                  <th key={i} className={`px-2 py-2 text-xs font-bold text-white ${i < 3 ? 'text-left' : 'text-right'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.filter((p) => p.status === 'OPEN' || p.openedAt > Date.now() - 12 * 3600_000).slice().reverse().map((p) => {
                const ltp = ltpOf(p);
                const pnl = legPnl(p, p.status === 'OPEN' ? ltp : null);
                const prior = p.status === 'OPEN' && p.openedAt < Date.parse(`${istDate()}T00:00:00+05:30`);
                return (
                  <tr key={p.id} className="border-t border-zinc-800">
                    <td className="px-2 py-1.5 text-left"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.mode === 'REAL' ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-300'}`}>{p.mode}</span></td>
                    <td className="px-2 py-1.5 text-left"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.side === 'S' ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{p.side === 'S' ? 'SELL' : 'BUY'}</span></td>
                    <td className="px-2 py-1.5 text-left text-zinc-100">{p.underlying} {p.strike} {p.option} · {formatExpiryLabel(p.expiry)}</td>
                    <td className="px-2 py-1.5 text-right">{p.qty}{p.qty > 0 ? ` (${(p.qty / p.lotSize).toFixed(p.qty % p.lotSize ? 1 : 0)}L)` : ''}</td>
                    <td className="px-2 py-1.5 text-right">{p.avgPrice > 0 ? p.avgPrice.toFixed(2) : '—'}</td>
                    <td className="px-2 py-1.5 text-right">{p.status === 'OPEN' ? fmt(ltp) : '—'}</td>
                    <td className="px-2 py-1.5 text-right">{p.exitPrice ? p.exitPrice.toFixed(2) : '—'}</td>
                    {(() => {
                      // Premium move from entry in the trade's favour: a short gains as the premium decays (+), loses as it rises (−).
                      const ref = p.status === 'OPEN' ? ltp : (p.exitPrice ?? null);
                      const d = p.avgPrice > 0 && ref != null && ref > 0 ? ((p.side === 'S' ? p.avgPrice - ref : ref - p.avgPrice) / p.avgPrice) * 100 : null;
                      return <td className={`px-2 py-1.5 text-right ${d == null ? 'text-zinc-600' : pnlCls(d)}`}>{d == null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`}</td>;
                    })()}
                    <td className={`px-2 py-1.5 text-right font-bold ${pnlCls(pnl)}`}>{money(pnl)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-300">{clockIst(p.filledAt || p.openedAt)}</td>
                    <td className="px-2 py-1.5 text-right text-zinc-300">{p.closedAt ? clockIst(p.closedAt) : '—'}</td>
                    <td className="px-2 py-1.5 text-right">
                      {p.status === 'OPEN' && p.qty > 0 && (() => {
                        const lv = riskLevels(p.avgPrice, Math.min(p.low ?? Infinity, lowSent.current[p.id]?.v ?? Infinity), risk);
                        const hit = riskHits[p.id];
                        const f = (v: number | null) => (v == null ? '—' : v.toFixed(2));
                        if (lv.sl == null && lv.target == null && risk.trail <= 0) return <span className="text-zinc-600">off</span>;
                        return (
                          <span className={`text-[11px] ${hit ? 'text-red-400 font-bold animate-pulse' : 'text-zinc-300'}`}
                            title={hit ? `${hit} hit` : `SL ${f(lv.sl)} · Target ${f(lv.target)} · Trail ${lv.trail == null ? 'not armed (premium has not traded below entry)' : f(lv.trail)}`}>
                            <span className="text-red-400">{f(lv.sl)}</span> / <span className="text-emerald-400">{f(lv.target)}</span> / <span className="text-amber-300">{f(lv.trail)}</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {p.status === 'OPEN' && p.qty > 0 && (() => {
                        const w = posWatch[p.id];
                        if (!w) return <span className="text-zinc-600">…</span>;
                        if (w.ws !== 'watching') return <span className="text-amber-300 text-[10px]" title={WATCH_WHY[w.ws]}>{w.ws === 'other-chain' ? 'other chain' : w.ws === 'no-price' ? 'no price' : w.ws === 'no-bars' ? 'no candles' : 'warming'}</span>;
                        return (
                          <span className="inline-flex gap-1 justify-end">
                            {LEVELS.map((l) => {
                              const lv = levelValue(w, l);
                              const watched = l === 'st' ? watchSt : l === 'vwap' ? watchVwap : watchEma;
                              const alerting = !!activeAlerts[p.id]?.includes(l);
                              const above = w.states[l];
                              const dist = lv != null && w.ltp != null && lv > 0 ? ((w.ltp - lv) / lv) * 100 : null;   // + = price above the level = against a short
                              const cls = !watched ? 'border-zinc-800 text-zinc-600' : alerting ? 'border-red-500/60 bg-red-500/15 text-red-400 font-bold animate-pulse'
                                : above ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : above === false ? 'border-emerald-500/30 text-emerald-400' : 'border-zinc-700 text-zinc-500';
                              return (
                                <span key={l} className={`px-1 py-0.5 rounded border text-[10px] leading-tight ${cls}`}
                                  title={`${levelLabel[l]} ${lv != null ? lv.toFixed(2) : 'warming up'}${watched ? '' : ' (not alerting)'}`}>
                                  {l === 'st' ? 'ST' : l === 'vwap' ? 'VW' : 'EM'} {dist == null ? '—' : `${dist > 0 ? '▲' : '▼'}${Math.abs(dist).toFixed(1)}%`}
                                </span>
                              );
                            })}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-1.5 text-right text-zinc-400">
                      {p.pendingOrders?.length ? `${p.pendingOrders[0].kind} order working` : p.status === 'OPEN' ? (prior ? 'OPEN · prior day' : 'OPEN') : (p.note ?? 'CLOSED')}
                    </td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      {p.status === 'OPEN' && p.qty > 0 && (
                        <button type="button" onClick={() => setExitId(p.id)} aria-label={`Exit ${p.strike} ${p.option}`}
                          className={`h-6 px-2 rounded border border-zinc-600 bg-zinc-900 text-[11px] font-bold text-zinc-100 hover:bg-zinc-800 ${FOCUS_RING}`}>EXIT</button>
                      )}
                      {p.mode === 'SIM' && p.status === 'CLOSED' && (
                        <button type="button" onClick={() => op({ op: 'remove', id: p.id })} aria-label="Remove paper row"
                          className={`ml-1 h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 ${FOCUS_RING}`}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {positions.length === 0 && (
                <tr><td colSpan={15} className="px-4 py-6 text-center text-zinc-500" role="status">No trades yet. Press SELL on a row to open a ticket ({mode}).</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/60 px-4" role="dialog" aria-modal="true" aria-label="Indicator settings"
          onClick={() => setShowSettings(false)} onKeyDown={(e) => { if (e.key === 'Escape') setShowSettings(false); }}>
          <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">Indicator settings</h2>
              <button type="button" onClick={() => setShowSettings(false)} aria-label="Close settings" autoFocus
                className={`h-7 w-7 inline-flex items-center justify-center rounded text-zinc-400 hover:text-white ${FOCUS_RING}`}><X className="w-4 h-4" aria-hidden="true" /></button>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <NumField label="ST period" value={indCfg.stPeriod} width="w-16" onCommit={(n) => setIndCfg((v) => ({ ...v, stPeriod: clampInt(n, 2, 100) }))} />
              <NumField label="ST multiplier" value={indCfg.stMult} step={0.5} width="w-16" onCommit={(n) => setIndCfg((v) => ({ ...v, stMult: Math.min(10, Math.max(0.5, n)) }))} />
              <NumField label="EMA period" value={indCfg.emaPeriod} width="w-16" onCommit={(n) => setIndCfg((v) => ({ ...v, emaPeriod: clampInt(n, 2, 200) }))} />
            </div>
            <p className="text-[11px] text-zinc-400 leading-snug">
              Supertrend 2–100 / 0.5–10, EMA 2–200. VWAP is the session VWAP and has no setting. Changes apply to the scan, the lights,
              the alerts and the SL levels immediately, and are remembered in this browser. Longer periods need more closed bars before a strike stops showing as warming up.
            </p>
            <div className="flex justify-between">
              <button type="button" onClick={() => setIndCfg(DEFAULT_IND_PARAMS)}
                className={`h-7 px-2.5 rounded border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-300 hover:text-white ${FOCUS_RING}`}>Reset to 10 · 2 · 20</button>
              <button type="button" onClick={() => setShowSettings(false)}
                className={`h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-oncolor text-[11px] font-bold ${FOCUS_RING}`}>Done</button>
            </div>
          </div>
        </div>
      )}

      <OrdersTradesModal
        isOpen={showBook} onClose={() => setShowBook(false)} broker={broker}
        ordersData={bookData.orders} tradesData={bookData.trades} positionsData={bookData.positions}
        isLoading={bookLoading} error={bookError} onRefresh={fetchBook}
      />

      {/* ── Tickets: the Multi-Leg Focus modals ── */}
      {sellTicket && (
        <AddNewLegModal
          key={sellTicket.n} isOpen onClose={() => setSellTicket(null)} basket={basket}
          allStrikes={strikeList} listedExpiries={expiries} atmStrike={liveQuotes?.atm ?? 0} lotSize={lotSize}
          ltpForStrike={ltpForStrike} initial={{ side: 'S', option: sellTicket.option, strike: sellTicket.strike }}
          sellOnly allowStops={false}
          onAddLeg={async (p) => { await placeSell(p); }}
        />
      )}
      {exitPos && (
        <ExitLotsModal
          key={exitPos.id} isOpen onClose={() => setExitId(null)} leg={legOf(exitPos)} basket={{ ...basket, expiry: exitPos.expiry, broker: exitPos.broker ?? 'dhan' }}
          lotSize={exitPos.lotSize} currentLtp={ltpOf(exitPos) ?? 0} broker={exitPos.broker ?? 'dhan'}
          onConfirm={async (p) => doExit(exitPos, p.lots, p.orderType, p.limitPrice)}
        />
      )}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────
function newPosition(p: Pick<BsPosition, 'mode' | 'underlying' | 'expiry' | 'option' | 'strike' | 'lotSize' | 'qty' | 'avgPrice'> & Partial<BsPosition>): BsPosition {
  const now = Date.now();
  return {
    id: `bs-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, side: 'S', status: 'OPEN',
    openedAt: now, filledAt: now, realized: 0, ...p,
  };
}

/** Adapt a ledger row to the leg shape the Multi-Leg Focus tickets read. */
function legOf(p: BsPosition): MultiLegLeg {
  const lots = Math.max(1, Math.round(p.qty / p.lotSize) || 1);
  return {
    id: p.id, side: p.side, option: p.option, strike: p.strike, expiry: p.expiry, lots, type: 'MARKET',
    fill: { qty: p.qty, avgPrice: p.avgPrice },
    status: p.status,
    ...(p.status === 'CLOSED' ? { closedAt: p.closedAt, closedFill: { qty: p.maxQty ?? p.lotSize * lots, exitPrice: p.exitPrice ?? 0 } } : {}),
  } as MultiLegLeg;
}

/** One row as the ledger holds it right now (plus the whole list); null when the ledger cannot be read. */
async function readLedgerRow(id: string): Promise<{ row: BsPosition | null; all: BsPosition[] } | null> {
  try {
    const j = await (await fetch('/api/bearish-strikes/state')).json() as { success?: boolean; positions?: BsPosition[] };
    if (!j.success || !Array.isArray(j.positions)) return null;
    return { row: j.positions.find((x) => x.id === id) ?? null, all: j.positions };
  } catch { return null; }
}
