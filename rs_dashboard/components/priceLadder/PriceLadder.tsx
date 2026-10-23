'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Rows3, Crosshair, AlertTriangle, ShieldAlert, Trash2, Briefcase, ClipboardList, ReceiptText, ChevronRight, ChevronUp, ChevronDown, Clock, Settings, X, Plus, Info, Table2, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import NavBar from '@/components/NavBar';
import { sharedJson } from '@/lib/sharedPoll';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { BROKER_LABELS, scalperRoute } from '@/hooks/useBrokerSelector';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';
import { FOCUS_RING } from '@/components/Scalper';
import type { BrokerPortfolio } from '@/app/api/dashboard/portfolio/route';
import { LadderGrid, type EntryMark, widgetsFor, pairWidgetsFor, type LadderWidget } from '@/components/priceLadder/LadderGrid';
import { isPairLive, legSlPrice, pairName, pairNowPnl, LEG_KEYS, PAIR_STRIKE_STEP, type LadderPair, type PairLeg, type PairLegKey, type PairStructure } from '@/lib/priceLadderPair';
import { LadderOptionChain } from '@/components/priceLadder/LadderOptionChain';
import { StepArrows } from '@/components/priceLadder/StepArrows';
import { guardKey, scopeMtm } from '@/lib/priceLadderGuard';
import { MtmGuardCard } from '@/components/priceLadder/MtmGuardCard';
import { installAlertSoundUnlock, playEntryChime, playExitChime, playWarnChime } from '@/lib/alertSound';
import { chimeFor } from '@/lib/priceLadderChime';
import {
  MAX_LADDER_LOTS, isTradedStrike, paneOf, MCX_LADDER_UNDERLYINGS, DEFAULT_SL_BUFFER_PCT, MIN_SL_BUFFER_PCT, MAX_SL_BUFFER_PCT, stopLimitPrice, isMcxUnderlying, sessionFor, spotKeyUnderlying, istDay, istHhmm, isLive, limitZone, ownNet, sliceNowPnl, sumSlicePnl, classifyClick,
  type ClickType, type LadderZones, type LadderBroker, type LadderMode, type LadderSide, type LadderSlice, type LadderState, type OptType,
  type LadderContract,
} from '@/lib/priceLadder';

// Price Ladder (/price-ladder). XY mode trades an option on the INDEX's levels (OptionX "Price Ladder XY"): click a
// level to arm an entry, with a bracket target / SL / trailing SL in index points. The dashboard SERVER watches and
// fires them (lib/priceLadderServer.ts), so closing this tab does not disarm anything. Plain mode is a one-click
// LIMIT / SL ladder on the option's own premium. This component only draws and asks; every rule and check is server-side.

/** Index underlyings, then the MCX ones the ladder trades (MCX_LADDER_UNDERLYINGS). */
const UNDERLYINGS: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', ...MCX_LADDER_UNDERLYINGS];
/** Accounts the ladder can trade on. Prices always come from Dhan; only orders, positions and order books are per broker. */
const LADDER_BROKERS = ['dhan', 'kotak', 'zerodha'] as const;
/** The server checks a strangle against the same steps (lib/priceLadderPair.ts). */
const STRIKE_STEP = PAIR_STRIKE_STEP;
const XY_TICKS = [1, 5, 10, 25];
const PLAIN_TICKS = [0.05, 0.5, 1];
/** Pair mode's axis is the combined CE + PE premium. */
const PAIR_TICKS = [0.5, 1, 2, 5];
/** The page's ladder: the two single-option modes, or Pair (a straddle / strangle on its combined premium). */
type PageMode = LadderMode | 'pair';
const MODE_TICK: Record<PageMode, number> = { xy: 5, plain: 1, pair: 1 };
const TICKS_OF: Record<PageMode, readonly number[]> = { xy: XY_TICKS, plain: PLAIN_TICKS, pair: PAIR_TICKS };
const ROWS = 31;
const POLL_MS = 1000;
/** The one-shot expiry / option-chain loads retry this many times, LOAD_RETRY_MS × attempt apart. */
const LOAD_RETRIES = 4;
const LOAD_RETRY_MS = 4000;

interface SpotView { spot: number; at: number; source: string; fresh: boolean }
interface StateResp {
  state: LadderState; spots: Record<string, SpotView>; ltps: Record<string, number>; liveArmed: boolean; now: number;
  /** Where the page's XY axis sits in `spots`: the index name, or for MCX the option month's futures contract. */
  spotKey?: string | null;
  /** Why the selected contract could not be resolved (e.g. no MCX futures month), or null. */
  contractError?: string | null;
  /** Pair mode: why a pair leg could not be resolved, or null. */
  pairError?: string | null;
  /** The selection this reply describes. */
  request?: { underlying: string; expiry: string; strike: number | null; opt: string | null; pairCe?: number | null; pairPe?: number | null };
  /** Pair mode: the CE / PE legs on screen and their combined premium (null when a leg has no live price). */
  pair?: {
    ce: { strike: number; securityId: string; ltp: number | null }; pe: { strike: number; securityId: string; ltp: number | null };
    combined: number | null; lotSize: number; mult: number;
  } | null;
  contract: {
    securityId: string; lotSize: number; ltp: number | null; mult?: number; refExpiry?: string;
    /** MCX: the futures axis's day high / low / previous close, from its WebSocket quote. */
    axisDay?: { high: number | null; low: number | null; prevClose: number | null } | null;
  } | null;
  /** Key market levels (PDH, PDL, Today High, Today Low) for the active underlying. */
  keyLevels?: {
    pdh: number | null;
    pdl: number | null;
    dayHigh: number | null;
    dayLow: number | null;
  } | null;
}
interface IndexQuote { ltp: number; prev_close: number; change_pct: number | null; day_high: number | null; day_low: number | null }

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); if (v && (allowed as readonly string[]).includes(v)) return v as T; } catch { /* none */ }
  return fallback;
}
function savePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* best effort */ } }

/** A number box that commits on blur / Enter only (dhan-commit-on-blur), so a half-typed value never reaches a rule. */
function NumField({ value, onCommit, min, max, step, label, width = 'w-16', compact }: {
  value: number; onCommit: (v: number) => void; min: number; max?: number; step?: number; label: string; width?: string; compact?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Arrow steps only move the draft; the value is committed once the user stops stepping (or on blur / Enter), so a
  // held key or a run of clicks sends ONE change to a live rule instead of one per step.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  // A step still waiting to commit is dropped with the row: the stale onCommit must not post for a closed leg.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const commit = () => {
    clearTimer();
    if (draft == null) return;
    const n = pending.current ?? Number(draft);
    pending.current = null;
    if (Number.isFinite(n) && n >= min && (max == null || n <= max)) onCommit(n);
    setDraft(null);
  };
  const stepBy = (dir: 1 | -1) => {
    const inc = step ?? 1;
    const cur = pending.current ?? Number(draft ?? value);
    const base = Number.isFinite(cur) ? cur : value;
    const decimals = (v: number) => (String(v).split('.')[1] ?? '').length;
    const dp = Math.max(decimals(inc), decimals(base));
    let n = Number((base + dir * inc).toFixed(dp));
    if (n < min) n = min;
    if (max != null && n > max) n = max;
    pending.current = n;
    setDraft(String(n));
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      const v = pending.current;
      pending.current = null;
      setDraft(null);
      if (v != null && v !== value) onCommit(v);
    }, 500);
  };
  return (
    <div className={`${width} relative inline-flex`}>
      <input
        aria-label={label} inputMode="decimal"
        className={`w-full pl-2 pr-5 ${compact ? 'py-0.5' : 'py-1'} rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500`}
        value={draft ?? String(value)}
        onChange={e => { clearTimer(); pending.current = null; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') { clearTimer(); pending.current = null; setDraft(null); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepBy(e.key === 'ArrowUp' ? 1 : -1); }
        }}
      />
      <StepArrows label={label} onStep={stepBy} />
    </div>
  );
}

/** Loud paper-trading marker: SIM orders never reach the broker, so it must be impossible to mistake for REAL. */
function SimBadge({ className = '' }: { className?: string }) {
  return (
    <span role="status" title="SIM mode: paper orders only — nothing is sent to the broker"
      className={`inline-flex items-center gap-1.5 rounded-md bg-amber-400 px-2 py-1 text-xs font-extrabold uppercase tracking-wider text-oncolor-dark ring-2 ring-amber-400/50 animate-pulse ${className}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-oncolor-dark" aria-hidden />SIM · PAPER — NOT REAL
    </span>
  );
}

function Seg<T extends string>({ value, options, onChange, labels, disabled, compact }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; disabled?: boolean; compact?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
      {options.map(o => (
        <button
          key={o} type="button" disabled={disabled} aria-pressed={value === o} onClick={() => onChange(o)}
          className={`px-2.5 ${compact ? 'py-0.5' : 'py-1'} text-xs font-semibold transition-colors disabled:opacity-50 ${value === o ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
        >
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

const fmtMoney = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const pnlClass = (v: number | null) => (v == null ? 'text-zinc-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400');
const timeOf = (at: number) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

/** One ladder pane. The page can show two side by side: the second keeps its own saved choices (keys end in `-2`), has no
 *  NavBar, and neither auto-focuses a live contract nor chimes (the first pane already does both). The ledger and the
 *  server watcher are shared — every slice carries its own contract, so the panes only differ in what they display. */
export default function PriceLadder({ ladderId = 1, dual = false, onAddLadder, onRemoveLadder, onBrokerChange, peerBroker, onHeaderHeight, headerMinHeight, collapsed = false, onToggleCollapsed }: {
  ladderId?: 1 | 2; dual?: boolean; onAddLadder?: () => void; onRemoveLadder?: () => void;
  /** Reports this pane's broker; the other pane gets it as `peerBroker`. */
  onBrokerChange?: (b: LadderBroker) => void; peerBroker?: LadderBroker | null;
  /** Side by side: this header's own height is reported, and both headers are held to the taller one so the two ladders start level. */
  onHeaderHeight?: (h: number) => void; headerMinHeight?: number;
  /** The header's control rows folded away (shared by both panes), leaving the title row. */
  collapsed?: boolean; onToggleCollapsed?: () => void;
}) {
  const second = ladderId === 2;
  const k = useCallback((key: string) => (second ? `${key}-2` : key), [second]);
  const [broker, setBroker, brokerLoaded] = usePageBroker<LadderBroker>(k('price-ladder-broker'), LADDER_BROKERS);
  useEffect(() => { onBrokerChange?.(broker); }, [broker, onBrokerChange]);
  // The broker account chip and the Positions / Order / Trade book buttons are shown once: on ladder 1, and on ladder 2
  // only when it trades a different broker (they describe that broker's account, not the ladder).
  const showAccount = !second || peerBroker == null || peerBroker !== broker;
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = headRef.current;
    if (!el || !onHeaderHeight) return;
    const ro = new ResizeObserver(() => onHeaderHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeaderHeight]);
  const [mode, setModeRaw] = useState<PageMode>('xy');
  // Pair mode: a straddle on the centre strike, or a strangle `wing` strikes either side of it (CE above, PE below).
  const [structure, setStructure] = useState<PairStructure>('straddle');
  const [wing, setWing] = useState(2);
  // Pair mode: a leg moving this % against its own fill exits both legs (0 = off).
  const [legSlPct, setLegSlPct] = useState(0);
  const [real, setReal] = useState(false);               // per page load, never persisted
  const [soundOn, setSoundOn] = useState(true);          // trade chimes; remembered per browser
  const [realAck, setRealAck] = useState(false);         // first REAL click this page load asks first
  // A REAL order's first-click confirmation (confirming it lets later clicks this page load straight through), or a
  // `setting` confirmation (its own title and button; it never switches the REAL-order confirmation off).
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void; setting?: { title: string; button: string } }>(null);
  const [armModal, setArmModal] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [underlying, setUnderlyingRaw] = useState<string>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [strikes, setStrikes] = useState<number[]>([]);
  const [strike, setStrike] = useState<number | null>(null);
  // Ladder 1 starts on the ATM call, ladder 2 on the ATM put (the strike defaults to ATM once the chain loads).
  const [opt, setOpt] = useState<OptType>(second ? 'PE' : 'CE');
  const [product, setProduct] = useState<'NRML' | 'MIS'>('MIS');
  const [orderType, setOrderType] = useState<ClickType>('LIMIT');
  // Classic: fixed limit zones (the other side needs Order Type SL). Anywhere: both columns at every level, the side of
  // the price deciding LIMIT or stop (plain: an SL-limit `slBufferPct` past the trigger).
  const [zones, setZonesRaw] = useState<LadderZones>('classic');
  const setZones = (z: LadderZones) => { setZonesRaw(z); savePref(k('price-ladder-zones'), z); };
  /** The mode's tick: the one last chosen for it (remembered per mode), else its default. */
  const tickFor = useCallback((m: PageMode) => Number(readPref(k(`price-ladder-tick-${m}`), TICKS_OF[m].map(String), String(MODE_TICK[m]))), [k]);
  const chooseTick = (t: number, m: PageMode) => { setTick(t); savePref(k(`price-ladder-tick-${m}`), String(t)); };
  const [slBufferPct, setSlBufferPct] = useState(DEFAULT_SL_BUFFER_PCT);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [style, setStyle] = useState<'Single' | 'Bracket' | 'Cover'>('Bracket');
  const [tgtPts, setTgtPts] = useState(40);
  const [slPts, setSlPts] = useState(30);
  const [trailOn, setTrailOn] = useState(false);
  const [trailPts, setTrailPts] = useState(30);
  const [lots, setLots] = useState(1);
  const [tick, setTick] = useState(5);
  const [center, setCenter] = useState(0);
  const [follow, setFollow] = useState(true);
  // The user scrolled the ladder away: hold the window where they put it until Centre / Follow price.
  const [manual, setManual] = useState(false);
  const [data, setData] = useState<StateResp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, IndexQuote>>({});
  // An index's change and day range come from top-indices. Its CRUDEOILM row is the FRONT futures month, not the option
  // month's futures on this ladder's axis, so MCX takes them from that axis's own WebSocket quote instead (below).
  const topIndexQ = isMcxUnderlying(underlying) ? null : quotes[underlying] ?? null;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastEventAt = useRef<number>(0);

  // Preferences (after mount: the first render must match the server HTML).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const savedMode = readPref(k('price-ladder-mode'), ['xy', 'plain', 'pair'] as const, 'xy');
    setModeRaw(savedMode);
    // The tick belongs to the mode (setMode sets it on a click): a page reopened into Plain must not keep XY's 5.
    setTick(tickFor(savedMode));
    setZonesRaw(readPref(k('price-ladder-zones'), ['classic', 'anywhere'] as const, 'classic'));
    setEventsOpen(readPref(k('price-ladder-events-open'), ['0', '1'] as const, '0') === '1');
    setSoundOn(readPref(k('price-ladder-sound'), ['0', '1'] as const, '1') === '1');
    setUnderlyingRaw(readPref(k('price-ladder-underlying'), UNDERLYINGS, 'NIFTY'));
    /* eslint-enable react-hooks/set-state-in-effect */
    return installAlertSoundUnlock();
  }, [k, tickFor]);
  // Each mode has its own axis (index / premium / combined premium): drop the old rows until the new price arrives,
  // so a Pair ladder never shows the XY futures levels as if they were combined premiums.
  const setMode = (m: PageMode) => { setModeRaw(m); savePref(k('price-ladder-mode'), m); setTick(tickFor(m)); setCenter(0); setFollow(true); setManual(false); };
  // The pair's strikes: CE = centre + wing steps, PE = centre − wing steps (a straddle: both on the centre). Null when a
  // leg is not in the chain's strike list.
  const pairStep = STRIKE_STEP[underlying] ?? 50;
  const pairCe = mode === 'pair' && strike ? (structure === 'straddle' ? strike : strike + wing * pairStep) : null;
  const pairPe = mode === 'pair' && strike ? (structure === 'straddle' ? strike : strike - wing * pairStep) : null;
  const pairOk = pairCe != null && pairPe != null && strikes.includes(pairCe) && strikes.includes(pairPe);
  // The expiry is cleared too: the old underlying's date must not be asked of the new one's chain for a render.
  const setUnderlying = (u: string) => { setUnderlyingRaw(u); savePref(k('price-ladder-underlying'), u); setExpiry(''); setExpiries([]); setStrike(null); setCenter(0); setFollow(true); setManual(false); };

  // The indices feed is the XY ladder's spot source. There is no REST fallback: if the feed is down the levels pause (a quote call would feed Dhan's 1/s limit).
  useEffect(() => {
    fetch('/api/live-indices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => {});
  }, []);

  // Expiries -> strikes (the chain gives the strike list and an ATM to start on).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One-shot per underlying. A failure (Dhan rate limit, a slow spawn) is retried a few times, spaced wider than the
    // option-chain limit (~1 call / 3 s), instead of leaving the page on an error until a reload.
    const load = (attempt: number) => {
      fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
        .then(r => r.json())
        .then((j: { success: boolean; data?: string[] }) => {
          if (cancelled) return;
          if (j.success && j.data?.length) { setExpiries(j.data); setExpiry(prev => (j.data!.includes(prev) ? prev : j.data![0])); setLoadError(null); }
          else throw new Error('no expiries');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < LOAD_RETRIES) timer = setTimeout(() => load(attempt + 1), LOAD_RETRY_MS * (attempt + 1));
          else setLoadError(`Could not load ${underlying} expiries`);
        });
    };
    load(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [underlying]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (attempt: number) => {
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain?: { oc?: Record<string, { ce?: { last_price?: number }; pe?: { last_price?: number } }> }; spot?: number; future_price?: number } }) => {
        if (cancelled) return;
        const oc = j.data?.chain?.oc;
        if (!j.success || !oc) throw new Error('no chain');
        const list = Object.keys(oc).map(Number).filter(n => n > 0 && isTradedStrike(underlying, n)).sort((a, b) => a - b);
        setStrikes(list);
        // MCX chains can come back with spot 0 but the option month's futures price set: that is the right ATM base.
        const spot = Number(j.data?.spot) || Number(j.data?.future_price) || 0;
        const step = STRIKE_STEP[underlying] ?? 50;
        setStrike(prev => {
          if (prev != null && list.includes(prev)) return prev;
          if (!list.length) return null;
          // No spot in the reply: the strike where call and put are closest in price (put-call parity's ATM).
          const parity = () => {
            let best: number | null = null, gap = Infinity;
            for (const k of list) {
              const row = oc[String(k)] ?? oc[k.toFixed(6)];
              const ce = Number(row?.ce?.last_price), pe = Number(row?.pe?.last_price);
              // Both legs priced above a token tick: two untraded far strikes at 0.05 / 0.05 are "equal" but not ATM.
              if (ce >= 1 && pe >= 1 && Math.abs(ce - pe) < gap) { gap = Math.abs(ce - pe); best = k; }
            }
            return best;
          };
          const atm = spot > 0 ? Math.round(spot / step) * step : parity() ?? list[Math.floor(list.length / 2)];
          return list.reduce((a, b) => (Math.abs(b - atm) < Math.abs(a - atm) ? b : a));
        });
        setLoadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // The chain is Dhan's rate-limited REST call (~1 per 3 s, shared with every other tab): back off, then give up.
        if (attempt < LOAD_RETRIES) timer = setTimeout(() => load(attempt + 1), LOAD_RETRY_MS * (attempt + 1));
        else setLoadError(`Could not load the ${underlying} option chain`);
      });
    };
    load(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [underlying, expiry]);

  // Ladder state + spot + the shown contract's LTP. Pushed by /api/price-ladder/stream (Server-Sent Events) the moment
  // it changes; the 1 s poll below only runs while the stream is not delivering. A view's ledger is applied only if it
  // is not OLDER than the one on screen (state.rev, bumped per write) — a late push or poll must not undo a click.
  const applyView = useCallback((v: StateResp) => {
    setData(d => {
      if (!d) return v;
      const older = v.state.date === d.state.date && (v.state.rev ?? 0) < (d.state.rev ?? 0);
      return older ? { ...v, state: d.state, liveArmed: d.liveArmed } : v;
    });
  }, []);
  // Open = the stream is connected (it sends only on change, plus a keepalive comment, so silence is not a failure).
  const streamOpen = useRef(false);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const q = new URLSearchParams({ underlying });
    if (expiry && strike) { q.set('expiry', expiry); q.set('strike', String(strike)); q.set('opt', opt); }
    if (expiry && pairOk) { q.set('pairCe', String(pairCe)); q.set('pairPe', String(pairPe)); }
    // Open only while the tab is visible: each open stream holds one of the browser's ~6 connections to this server
    // (HTTP/1.1), shared with every dashboard tab — a hidden ladder must not hold one and queue another tab's orders.
    let es: EventSource | null = null;
    const open = () => {
      if (es || document.hidden) return;
      es = new EventSource(`/api/price-ladder/stream?${q}`);
      es.onmessage = onMsg;
      es.onopen = () => { streamOpen.current = true; };
      // EventSource reconnects on its own; until it does, the poll below takes over.
      es.onerror = () => { streamOpen.current = false; };
    };
    const close = () => { es?.close(); es = null; streamOpen.current = false; };
    const onVis = () => (document.hidden ? close() : open());
    const onMsg = (e: MessageEvent<string>) => {
      try {
        const j = JSON.parse(e.data) as { success: boolean; data?: StateResp; error?: string };
        if (!j.success || !j.data) { setLoadError(j.error ?? 'Could not read the ladder'); return; }
        applyView(j.data);
        setLoadError(null);
      } catch { /* a malformed event: the next one replaces it */ }
    };
    open();
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); close(); };
  }, [underlying, expiry, strike, opt, pairOk, pairCe, pairPe, applyView]);

  // Fallback poll: out-of-order replies are dropped, one request per selection at a time (a reply can outlive the 1 s
  // tick, and a new poll every tick would make every reply "out of order").
  const seq = useRef(0);
  const pollInFlight = useRef<string | null>(null);
  const poll = useCallback(async () => {
    if (streamOpen.current) return;
    const key = `${underlying}|${expiry}|${strike}|${opt}|${pairOk ? `${pairCe}/${pairPe}` : ''}`;
    if (pollInFlight.current === key) return;
    pollInFlight.current = key;
    const my = ++seq.current;
    const q = new URLSearchParams({ underlying });
    if (expiry && strike) { q.set('expiry', expiry); q.set('strike', String(strike)); q.set('opt', opt); }
    if (expiry && pairOk) { q.set('pairCe', String(pairCe)); q.set('pairPe', String(pairPe)); }
    try {
      const r = await fetch(`/api/price-ladder/state?${q}`, { cache: 'no-store' });
      const j = await r.json() as { success: boolean; data?: StateResp; error?: string };
      if (my !== seq.current) return;
      if (!j.success || !j.data) { setLoadError(j.error ?? 'Could not read the ladder'); return; }
      applyView(j.data);
      setLoadError(null);
    } catch {
      if (my === seq.current) setLoadError('Could not reach the dashboard server');
    } finally {
      if (pollInFlight.current === key) pollInFlight.current = null;
    }
  }, [underlying, expiry, strike, opt, pairOk, pairCe, pairPe, applyView]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll();
    const t = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Index card: change and day range.
  useEffect(() => {
    let cancelled = false;
    const load = () => sharedJson<{ quotes?: Record<string, IndexQuote> }>('/api/scalper/top-indices', 2500).then(j => {
      if (!cancelled) setQuotes(j.quotes ?? {});
    }).catch(() => {});
    void load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Whether each broker's saved session is still valid (/api/auth/broker-status, a file check — no broker call). A REAL
  // order on an expired session is refused by the server anyway; this says so up front instead of on the click.
  const [sessions, setSessions] = useState<Partial<Record<LadderBroker, boolean>>>({});
  useEffect(() => {
    let cancelled = false;
    const load = () => sharedJson<Partial<Record<LadderBroker, boolean>>>('/api/auth/broker-status', 30_000)
      .then(j => { if (!cancelled) setSessions(j); }).catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Header account P&L: the shared, server-cached portfolio read (display only — it never sizes an order), every 5 s
  // while the tab is visible. A failed or incomplete read shows '—', never a stale or partial number.
  const [acct, setAcct] = useState<{ pnl: number | null; open: number | null; note: string | null }>({ pnl: null, open: null, note: null });
  const acctSeq = useRef(0);
  useEffect(() => {
    const my = ++acctSeq.current;     // a broker switch drops the previous broker's in-flight reply
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcct({ pnl: null, open: null, note: null });
    if (!brokerLoaded) return;
    const fail = (note: string) => { if (my === acctSeq.current) setAcct({ pnl: null, open: null, note }); };
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const j = await sharedJson<{ success?: boolean; brokers?: BrokerPortfolio[] }>(`/api/dashboard/portfolio?broker=${broker}`, 4000);
        if (my !== acctSeq.current) return;
        const b = j.brokers?.find(x => x.broker === broker);
        if (!j.success || !b) return fail('Could not read the account');
        if (!b.connected) return fail(b.error ?? 'Not connected');
        if (b.error && /positions|ltp-join/.test(b.error)) return fail(b.error);
        if (b.unpricedPositions > 0) {
          return void setAcct({ pnl: null, open: b.openPositions, note: `${b.unpricedPositions} open leg(s) have no live price — total unknown` });
        }
        setAcct({ pnl: b.totalPnl, open: b.openPositions, note: null });
      } catch (e) {
        fail(String((e as Error).message ?? e));
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [broker, brokerLoaded]);

  // The broker book (positions / orders / trades), fetched only while its window is open. View only on this page:
  // ladder orders are changed from the ladder, so the book never resizes one behind the engine's lot cap.
  type BookTab = 'positions' | 'orders' | 'trades';
  const [bookOpen, setBookOpen] = useState<BookTab | null>(null);
  const [book, setBook] = useState<{ positions: Record<string, unknown>[]; orders: Record<string, unknown>[]; trades: Record<string, unknown>[] }>({ positions: [], orders: [], trades: [] });
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const bookSeq = useRef(0);
  const fetchBook = useCallback(async () => {
    const my = ++bookSeq.current;
    setBookLoading(true);
    try {
      // Kotak sends no LTP: ?ltp=1 prices its open option legs from Dhan's chain (unpriced legs stay 0 = unknown).
      const r = await fetch(`${scalperRoute(broker, 'poll')}${broker === 'kotak' ? '?ltp=1' : ''}`, { cache: 'no-store' });
      const j = await r.json() as { success?: boolean; positions?: Record<string, unknown>[]; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; positionsError?: string | null; ordersError?: string | null; tradesError?: string | null; error?: string };
      if (my !== bookSeq.current) return;
      if (!j.success) { setBookError(j.error ?? 'Could not read the broker book'); return; }
      // A part that failed keeps its last good rows; the error says so rather than showing an empty book.
      setBook(d => ({
        positions: !j.positionsError && Array.isArray(j.positions) ? j.positions : d.positions,
        orders: !j.ordersError && Array.isArray(j.orders) ? j.orders : d.orders,
        trades: !j.tradesError && Array.isArray(j.trades) ? j.trades : d.trades,
      }));
      const errs = [j.positionsError && `positions: ${j.positionsError}`, j.ordersError && `orders: ${j.ordersError}`, j.tradesError && `trades: ${j.tradesError}`].filter(Boolean);
      setBookError(errs.length ? `${errs.join(' · ')} — showing the last good rows` : null);
    } catch (e) {
      if (my === bookSeq.current) setBookError(String((e as Error).message ?? e));
    } finally {
      if (my === bookSeq.current) setBookLoading(false);
    }
  }, [broker]);
  useEffect(() => {
    ++bookSeq.current;                // a broker switch or close drops any reply still in flight
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBook({ positions: [], orders: [], trades: [] });
    setBookError(null);
    if (!bookOpen || !brokerLoaded) return;
    void fetchBook();
    const t = setInterval(() => { void fetchBook(); }, 5000);
    return () => clearInterval(t);
  }, [bookOpen, brokerLoaded, fetchBook]);

  // Chime on fills and exits (the server writes the event; any open tab hears it).
  useEffect(() => {
    const evs = data?.state.events ?? [];
    if (!evs.length) return;
    const newest = evs[evs.length - 1].at;
    if (lastEventAt.current === 0) { lastEventAt.current = newest; return; }
    const fresh = evs.filter(e => e.at > lastEventAt.current);
    lastEventAt.current = Math.max(lastEventAt.current, newest);
    const chime = !second && soundOn ? chimeFor(fresh.map(e => e.msg)) : null;
    if (chime === 'warn') playWarnChime(); else if (chime === 'exit') playExitChime(); else if (chime === 'entry') playEntryChime();
    for (const e of fresh) if (e.level === 'error') toast.error(e.msg);
  }, [data?.state.events, second, soundOn]);

  const mcx = isMcxUnderlying(underlying);
  // The reply describes the selection on screen (it can lag one poll behind an expiry / strike / underlying switch).
  // Anything tied to the contract — its LTP, lot, and for MCX the futures month on the axis — is read only from a
  // matching reply; until then the ladder shows no price and cannot place.
  const rq = data?.request;
  const matches = !!rq && rq.underlying === underlying && rq.expiry === expiry && rq.strike === strike && rq.opt === opt;
  const shownC = matches ? data?.contract ?? null : null;
  // The pair on screen, from a reply for exactly these two strikes.
  const pairView = mode === 'pair' && pairOk && matches && rq?.pairCe === pairCe && rq?.pairPe === pairPe ? data?.pair ?? null : null;
  const combined = pairView?.combined ?? 0;
  const axisKey = mcx
    ? (matches && data?.spotKey && spotKeyUnderlying(data.spotKey) === underlying ? data.spotKey : null)
    : underlying;
  const spotView = axisKey ? data?.spots[axisKey] : undefined;
  const axisName = mcx ? `${underlying} FUT${shownC?.refExpiry ? ` ${shownC.refExpiry}` : ''}` : underlying;
  // Each error is shown only in the mode it belongs to: a pair leg's in Pair mode, the single contract's in XY / Plain.
  const contractError = matches && mode !== 'pair' ? data?.contractError ?? null : null;
  const pairError = matches && mode === 'pair' ? data?.pairError ?? null : null;
  const sessionNote = sessionFor(underlying, istDay(), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime).note ?? null;
  // False only once the status says so (unknown = not blocked; the server still checks every REAL order).
  const sessionDown = sessions[broker] === false;
  const spot = spotView?.spot ?? 0;
  const spotFreshNow = !!spotView?.fresh;
  const optLtp = shownC?.ltp ?? 0;
  const ax = shownC?.axisDay;
  const indexQ: IndexQuote | null = !mcx ? topIndexQ : ax && spot > 0 ? {
    ltp: spot, prev_close: ax.prevClose ?? 0, day_high: ax.high, day_low: ax.low,
    change_pct: ax.prevClose ? ((spot - ax.prevClose) / ax.prevClose) * 100 : null,
  } : null;
  const lotSize = shownC?.lotSize ?? null;
  const securityId = shownC?.securityId ?? null;
  const refPrice = mode === 'xy' ? spot : mode === 'pair' ? combined : optLtp;

  // The pointer (or keyboard focus) is on the ladder: its rows hold still, so a price tick cannot re-centre a different
  // level under the mouse between aiming and clicking (seen live: a click armed a breakout three rows from the aim).
  const [held, setHeld] = useState(false);
  // Keep the ladder centred on the reference price while following; re-centre when it walks off the visible window.
  // Held rows only move for a first price (center 0); the re-centre catches up the moment the pointer leaves.
  useEffect(() => {
    if (!(refPrice > 0)) return;
    if (held && center !== 0) return;
    const half = Math.floor(ROWS / 2) * tick;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (follow || center === 0 || (!manual && Math.abs(refPrice - center) > half * 0.8)) setCenter(refPrice);
  }, [refPrice, follow, manual, tick, center, held]);
  // A different contract (strike / CE-PE / expiry, or an Active Trades chip) is a new price axis in plain mode: drop the
  // scroll hold so the walk-off re-centre can bring its price back on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setManual(false);
  }, [underlying, expiry, strike, opt]);
  const scrollLadder = useCallback((ticks: number) => {
    setFollow(false); setManual(true);
    setCenter(c => {
      const next = Number(((c > 0 ? c : refPrice) + ticks * tick).toFixed(2));
      return next > tick * Math.floor(ROWS / 2) ? next : c;
    });
  }, [refPrice, tick]);

  const slices = useMemo(() => data?.state.slices ?? [], [data?.state.slices]);
  // The position block, its P&L and Exit follow the page's SIM/REAL switch: paper and real slices never net together.
  const pageMode = real ? 'real' : 'sim';
  // Ladder markers follow the SIM/REAL switch too: a paper level must never look like a real one on the ladder.
  const mine = useMemo(() => slices.filter(s => isLive(s) && s.broker === broker && s.mode === pageMode && s.contract.securityId === securityId), [slices, broker, pageMode, securityId]);
  const pairs = useMemo(() => data?.state.pairs ?? [], [data?.state.pairs]);
  // Pairs drawn on the ladder: this broker, the page's mode, exactly the two legs on screen.
  const myPairs = useMemo(() => (pairView ? pairs.filter(p => isPairLive(p) && p.broker === broker && p.mode === pageMode
    && p.legs.ce.contract.securityId === pairView.ce.securityId && p.legs.pe.contract.securityId === pairView.pe.securityId) : []),
  [pairs, pairView, broker, pageMode]);
  // Where each open position was entered, on the ladder's own axis (index level in XY, fill premium in plain).
  const entryMarks = useMemo(() => {
    const marks: EntryMark[] = [];
    if (mode === 'pair') {
      // A pair's entry on the combined axis (the row IS the combined fill, so no separate fill tag).
      for (const p of myPairs) if ((p.state === 'open' || p.state === 'broken' || p.state === 'exiting' || p.state === 'unknown') && p.entryY) marks.push({ y: p.entryY, side: p.side, qty: p.qty, pnl: pairNowPnl(p, data?.ltps ?? {}) });
      return marks;
    }
    for (const s of mine) {
      const held = Number(s.filledQty) || 0;
      if ((s.state !== 'open' && s.state !== 'exiting') || held <= 0) continue;
      const y = mode === 'xy' ? (s.kind === 'xy' ? s.entryY ?? s.entryLevel : undefined) : s.avg;
      if (y && Number.isFinite(y)) marks.push({ y, side: s.side, qty: held, avg: s.avg, pnl: sliceNowPnl(s, optLtp) ?? null });
    }
    return marks;
  }, [mine, mode, myPairs, optLtp, data?.ltps]);
  const net = securityId ? ownNet(slices.filter(s => s.broker === broker && s.mode === pageMode), securityId) : { qty: 0, avg: null };
  const contractPnl = useMemo(() => sumSlicePnl(slices, s => s.broker === broker && s.mode === pageMode && s.contract.securityId === securityId, () => optLtp),
    [slices, broker, pageMode, securityId, optLtp]);
  // This ladder's own P&L across every contract it placed, for this broker and the page's SIM/REAL mode (open legs at
  // live LTP). Pairs count too; '—' when any open slice or pair has no price (a partial sum would hide that leg's loss).
  // The same function and scope the server's MTM guard reads, so the chip and the guard can never disagree. Each ladder
  // has its own guard over only the orders it placed, even when both are on one broker.
  const guardScope = useMemo(() => ({ broker, mode: pageMode, pane: ladderId } as const), [broker, pageMode, ladderId]);
  const ladderPnl = useMemo(() => (data ? scopeMtm(data.state, guardScope, data.ltps ?? {}) : null), [data, guardScope]);
  const myGuardKey = guardKey(broker, pageMode, ladderId);

  const liveArmed = !!data?.liveArmed;
  const realBlocked = real && !liveArmed;

  const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try {
      const r = await fetch('/api/price-ladder/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})) as { success?: boolean; error?: string; unknown?: boolean; data?: { state?: LadderState } };
      if (j.data?.state) {
        // Newer than any poll still in flight: bump seq so an older GET reply cannot put back what this changed.
        seq.current++;
        const st = j.data.state;
        setData(d => (d && !(st.date === d.state.date && (st.rev ?? 0) < (d.state.rev ?? 0)) ? { ...d, state: st } : d));
      }
      if (j.unknown) { toast.error(`Order status UNKNOWN — check Positions/Orders before doing anything else. ${j.error ?? ''}`); return false; }
      if (!j.success) { toast.error(j.error ?? `Request failed (${r.status})`); return false; }
      return true;
    } catch {
      toast.error('No reply from the server — the request may or may not have gone through. Check the orders list.');
      return false;
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }, []);

  // `expect` = the verdict the user saw / confirmed: the server refuses rather than place a different kind of order if
  // the price crossed the level in between.
  const send = useCallback((side: LadderSide, price: number, expect: { kind: 'limit' | 'stop'; dir: 'above' | 'below' }) => {
    if (!expiry || !strike) return;
    void post({
      action: 'arm', kind: mode, broker, mode: real ? 'real' : 'sim', underlying, expiry, strike, opt, side, lots, product,
      orderType, level: price, zones, expect, ...(zones === 'anywhere' && mode === 'plain' ? { slBufferPct } : {}), ...(second ? { pane: 2 } : {}),
      // Cover = SL only (tgtPts 0), as OptionX's Cover order; Bracket = target + SL.
      // Single + trail = a trailing stop on its own: SL only, starting at the trail distance.
      ...(mode === 'xy' && style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } }
        : mode === 'xy' && trailOn ? { bracket: { tgtPts: 0, slPts: trailPts, trailPts } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${mode === 'xy' ? 'armed at' : 'placed at'} ${price}`); });
  }, [post, mode, broker, real, underlying, expiry, strike, opt, lots, product, orderType, zones, slBufferPct, style, tgtPts, slPts, trailOn, trailPts, second]);

  // Buy / Sell Market buttons: the selected contract at market now (single option; the server applies every arm check).
  const sendMarket = useCallback((side: LadderSide) => {
    if (!expiry || !strike) return;
    const what = `${side} ${lots} lot(s) ${underlying} ${strike}${opt} at MARKET now`;
    // Like every REAL ladder click, the first one this page load asks first.
    const run = () => void post({
      action: 'market', broker, mode: real ? 'real' : 'sim', underlying, expiry, strike, opt, side, lots, product, ...(second ? { pane: 2 } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${lots} lot(s) ${underlying} ${strike}${opt} sent at MARKET`); });
    if (real && !realAck) setConfirm({ text: what, run }); else run();
  }, [post, broker, real, realAck, underlying, expiry, strike, opt, lots, product, second]);

  // Pair mode: the entry is on the combined premium (Buy below / Sell above = limit-like; the other side a breakout).
  const sendPair = useCallback((side: LadderSide, price: number, expect: { kind: 'limit' | 'stop'; dir: 'above' | 'below' }) => {
    if (!expiry || !pairOk) return;
    void post({
      action: 'pair', op: 'arm', broker, mode: real ? 'real' : 'sim', underlying, expiry, structure, ceStrike: pairCe, peStrike: pairPe,
      side, lots, product, orderType, level: price, zones, expect, ...(legSlPct > 0 ? { legSlPct } : {}), ...(second ? { pane: 2 } : {}),
      ...(style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } }
        : trailOn ? { bracket: { tgtPts: 0, slPts: trailPts, trailPts } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${structure} armed at combined ${price}`); });
  }, [post, broker, real, underlying, expiry, structure, pairOk, pairCe, pairPe, lots, product, orderType, zones, legSlPct, style, tgtPts, slPts, trailOn, trailPts, second]);

  const onPlace = (side: LadderSide, price: number) => {
    if (mode === 'pair') {
      const v = classifyClick({ mode: 'plain', opt: 'CE', side, level: price, ref: refPrice, orderType, zones });
      if (!v.ok) { toast.warning(v.error); return; }
      if (real && !realAck) {
        const name = structure === 'straddle' ? `${pairCe} straddle` : `${pairCe}CE / ${pairPe}PE strangle`;
        setConfirm({
          text: `${side} ${lots} lot(s) ${underlying} ${name} — BOTH legs at MARKET when the combined premium ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price}. If only one leg fills, it is closed again at market`,
          run: () => sendPair(side, price, { kind: v.kind, dir: v.dir }),
        });
        return;
      }
      sendPair(side, price, { kind: v.kind, dir: v.dir });
      return;
    }
    // Same verdict the server applies, shown before the click costs a round trip.
    const v = classifyClick({ mode, opt, side, level: price, ref: refPrice, orderType, zones });
    if (!v.ok) { toast.warning(v.error); return; }
    if (real && !realAck) {
      // The server computes the SL-limit's limit from the same buffer; this preview uses the same function.
      const lim = mode === 'plain' && v.kind === 'stop' && zones === 'anywhere' ? stopLimitPrice(side, price, slBufferPct) : null;
      const what = mode === 'xy'
        ? `${side} ${lots} lot(s) ${underlying} ${strike}${opt} at MARKET when ${axisName} ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price}`
        : lim
          ? `SL-limit ${side} ${lots} lot(s) ${underlying} ${strike}${opt}: trigger ${price.toFixed(2)}, limit ${lim.toFixed(2)}`
          : `${v.kind === 'limit' ? 'LIMIT' : 'SL'} ${side} ${lots} lot(s) ${underlying} ${strike}${opt} at ${price}`;
      setConfirm({ text: what, run: () => send(side, price, { kind: v.kind, dir: v.dir }) });
      return;
    }
    send(side, price, { kind: v.kind, dir: v.dir });
  };

  // Shift a pair (both legs) or roll one leg N strikes: the old leg closes in full first, then the new strike opens at
  // MARKET — opening orders, so a REAL pair asks first (every time: a roll is two trades, never a one-click habit).
  const onRoll = (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => {
    const step = STRIKE_STEP[p.legs.ce.contract.underlying] ?? 50;
    const moving = legs === 'both' ? (['ce', 'pe'] as const) : [legs];
    const to = moving.map(k => `${p.legs[k].contract.strike}${k.toUpperCase()} → ${p.legs[k].contract.strike + steps * step}${k.toUpperCase()}`).join(', ');
    const run = () => void post({ action: 'pair', op: 'roll', id: p.id, legs, steps }).then(ok => { if (ok) toast.success(`Rolling ${to}`); });
    if (p.mode === 'real') {
      setConfirm({ text: `${legs === 'both' ? 'Shift' : `Roll the ${legs.toUpperCase()} leg of`} the ${pairName(p)} ${steps > 0 ? 'up' : 'down'} ${Math.abs(steps)} strike(s): ${to}. The old leg is closed at MARKET first, then the new one opened at MARKET (if it fails, the whole pair is closed)`, run });
      return;
    }
    run();
  };

  // The MCX / NSE cutoffs (MIS square-off / "only exits" time). A time already passed would square off open MIS positions
  // at once: the server refuses that without confirmPast, and the page asks first, naming what it would do.
  const setCutoff = (market: 'mcx' | 'nse', time: string) => {
    const label = market === 'mcx' ? 'MCX' : 'NSE';
    const field = market === 'mcx' ? 'mcxAutoExitTime' : 'nseAutoExitTime';
    const send = async (confirmPast: boolean) => {
      try {
        const r = await fetch('/api/price-ladder/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', [field]: time, confirmPast }) });
        const j = await r.json().catch(() => ({})) as { success?: boolean; error?: string; needsConfirm?: boolean; data?: { state?: LadderState } };
        if (j.needsConfirm && !confirmPast) {
          setConfirm({ text: j.error ?? `Set the ${label} cutoff to ${time}?`, run: () => { void send(true); }, setting: { title: `Set the ${label} cutoff to ${time}?`, button: 'Set cutoff and square off' } });
          return;
        }
        if (!j.success) { toast.error(j.error ?? `Could not set the cutoff (${r.status})`); return; }
        if (j.data?.state) { seq.current++; const st = j.data.state; setData(d => (d ? { ...d, state: st } : d)); }
        toast.success(`${label} cutoff set to ${time} IST`);
      } catch {
        toast.error('No reply from the server — check the cutoff before trading');
      }
    };
    void send(false);
  };

  // Drag-to-modify (OptionX): an armed entry moves its level; an open bracket moves its target or SL. The server re-checks
  // every rule (a LIMIT entry cannot be dragged across spot into a breakout; target/SL must stay on their side of spot).
  const onMove = (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => {
    const done = (ok: boolean) => { if (ok) toast.success(`${what === 'entry' ? 'Entry' : what === 'tgt' ? 'Target' : 'SL'} moved to ${price}`); };
    if (mode === 'pair') {
      void post({ action: 'pair', op: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : what === 'tgt' ? { tgtY: price } : { slY: price }) }).then(done);
      return;
    }
    void post({ action: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : { ids, ...(what === 'tgt' ? { tgtY: price } : { slY: price }) }) })
      .then(ok => { if (ok) toast.success(`${what === 'entry' ? 'Entry' : what === 'tgt' ? 'Target' : 'SL'} moved to ${price}`); });
  };

  // The + / − on a ladder widget. An unfilled order changes its lots in place (− stops at 1 lot: × cancels). An open
  // position: − exits one lot at market (never confirmed — it only reduces), + adds one lot at market under the same
  // target / SL — an opening order, so on REAL the first one this page load asks first, like a ladder click.
  const onAdjust = (w: LadderWidget, delta: 1 | -1, pair = mode === 'pair') => {
    if (pair) {
      if (w.adjust !== 'position') return;
      // − exits one lot of both legs (only reduces: never confirmed); + adds one to both at market — an opening order,
      // so the first REAL one this page load asks first.
      if (delta < 0) { void post({ action: 'pair', op: 'reduce', id: w.ids[0] }).then(ok => { if (ok) toast.success('Exiting 1 lot of both legs'); }); return; }
      const addOne = () => void post({ action: 'pair', op: 'add', id: w.ids[0] }).then(ok => { if (ok) toast.success('Adding 1 lot to both legs at market'); });
      // The pair's own mode decides (the table can show a REAL pair while the page is on SIM).
      const target = pairs.find(x => x.id === w.ids[0]);
      if ((target?.mode === 'real' || (!target && real)) && !realAck) {
        setConfirm({ text: `Add 1 lot to BOTH legs of this pair at MARKET (it joins the same target / SL; if only one leg fills, it is closed again)`, run: addOne });
        return;
      }
      addOne();
      return;
    }
    if (w.adjust === 'order') {
      const lots = w.lots + delta;
      if (lots < 1) { toast.info('One lot is the minimum — use × to cancel'); return; }
      if (lots > MAX_LADDER_LOTS) { toast.warning(`${MAX_LADDER_LOTS} lots is the cap`); return; }
      void post({ action: 'lots', id: w.ids[0], lots });
      return;
    }
    if (w.adjust !== 'position') return;
    if (delta < 0) {
      void post({ action: 'exit', ids: w.ids, lots: 1 }).then(ok => { if (ok) toast.success('Exiting 1 lot'); });
      return;
    }
    const addOne = () => void post({ action: 'add', id: w.ids[0] }).then(ok => { if (ok) toast.success('Adding 1 lot at market'); });
    if (real && !realAck) {
      setConfirm({ text: `Add 1 lot to the ${underlying} ${strike}${opt} position at MARKET (it joins the same target / SL)`, run: addOne });
      return;
    }
    addOne();
  };
  const pendingHere = mode === 'pair' ? 0 : mine.filter(s => (s.state === 'armed' || s.state === 'working') && s.mode === pageMode).length;

  // A price that has not moved is only a problem while the market is trading: outside the session there are no live
  // prices, so the stale warning is not shown (the server still refuses to arm without a fresh price).
  // The server's own clock (its last reply), so render stays pure; before the first reply there is nothing to warn about.
  const sess = sessionFor(underlying, istDay(data?.now), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime);
  const hhmmNow = data ? istHhmm(data.now) : 0;
  const inSession = !!data && sess.open < sess.close && hhmmNow >= sess.open && hhmmNow < sess.close;
  const stale = mode === 'xy' && !spotFreshNow;
  const placeDisabled = busy || !brokerLoaded || !strike || !(refPrice > 0) || realBlocked || (real && sessionDown) || (mode === 'xy' && stale)
    || (mode === 'pair' && !pairView);
  const decimals = mode === 'xy' ? (tick < 1 ? 2 : 0) : 2;
  const ticks = mode === 'xy' ? XY_TICKS : mode === 'pair' ? PAIR_TICKS : PLAIN_TICKS;
  const HELP_TEXT = mode === 'pair'
                ? `Pair: the ladder is the combined premium (CE + PE). Sell above it / Buy below it = limit-like entry; the other side ${zones === 'anywhere' ? 'is a breakout (BO)' : 'needs Order Type SL (breakout)'}. Both legs go at MARKET together when the combined crosses the level (REAL: if only one fills, it is closed again); target / SL / trail are in combined-premium points and exit both legs.`
                : mode === 'xy'
                ? `Click the Buy or Sell column at an index level. ${opt === 'PE' ? 'Put: the ladder is inverted — a Buy is a limit ABOVE spot. ' : ''}Limit = the option is cheaper/dearer at that level; the other side ${zones === 'anywhere' ? 'is a breakout by itself (Anywhere)' : 'needs SL (breakout)'}. The option order goes at MARKET when ${axisName} crosses the level.`
                : zones === 'anywhere'
                  ? `Anywhere: Buy below LTP / Sell above it = LIMIT; Sell below / Buy above = SL-limit, its limit ${slBufferPct}% past the trigger. Orders rest at the broker.`
                  : 'Click Buy below LTP or Sell above it for a LIMIT; the other side places an SL-M stop (Order Type SL). Orders rest at the broker.';
  const dataDate = data ? data.state.date : null;
  const optLabel = mode === 'pair'
    ? (pairOk ? `${underlying} ${expiry} ${structure === 'straddle' ? `${pairCe} straddle` : `${pairCe}CE / ${pairPe}PE strangle`}` : `${underlying} — pair strikes not in the chain`)
    : strike ? `${underlying} ${expiry} ${strike} ${opt}` : `${underlying} —`;
  // With two ladders open each lists only the orders it placed (ladder 1 also every order from before panes); one
  // ladder lists everything, so closing ladder 2 never hides its positions.
  const inPane = useCallback((x: { pane?: number }) => !dual || paneOf(x) === ladderId, [dual, ladderId]);
  const paneSlices = useMemo(() => slices.filter(inPane), [slices, inPane]);
  const panePairs = useMemo(() => pairs.filter(inPane), [pairs, inPane]);
  const paneEvents = useMemo(() => {
    const evs = data?.state.events ?? [];
    if (!dual) return evs;
    const ids = new Set([...paneSlices.map(x => x.id), ...panePairs.map(p => p.id)]);
    return evs.filter(e => (e.sliceId ? ids.has(e.sliceId) : ladderId === 1));
  }, [data?.state.events, dual, ladderId, paneSlices, panePairs]);
  const live = paneSlices.filter(isLive);
  const latestEvent = paneEvents.length ? paneEvents[paneEvents.length - 1] : null;
  // Live slices grouped per position (contract + broker + mode + side): one chip / banner line, not one per slice.
  const liveGroups = useMemo(() => {
    const m = new Map<string, { key: string; slices: LadderSlice[]; lots: number; armed: number }>();
    for (const x of paneSlices.filter(isLive)) {
      const key = `${x.contract.securityId}|${x.broker}|${x.mode}|${x.side}`;
      const g = m.get(key) ?? m.set(key, { key, slices: [], lots: 0, armed: 0 }).get(key)!;
      g.slices.push(x);
      const held = Number(x.filledQty) || 0;
      if (held > 0) g.lots += Math.max(1, Math.round(held / x.contract.lotSize));
      else g.armed += 1;
    }
    return [...m.values()];
  }, [paneSlices]);
  // Live orders on the contract on screen that the ladder does not draw (the other SIM/REAL mode, or another broker).
  // Pair mode: live pairs on these same two legs that the ladder does not draw (another broker or SIM/REAL).
  const hiddenPairs = mode === 'pair' && pairView ? pairs.filter(p => isPairLive(p)
    && p.legs.ce.contract.securityId === pairView.ce.securityId && p.legs.pe.contract.securityId === pairView.pe.securityId
    && (p.broker !== broker || p.mode !== pageMode)) : [];
  const done = paneSlices.filter(s => !isLive(s));
  const livePairs = panePairs.filter(isPairLive);

  // Switch the page to a slice's contract (Active Trades chip, orders list). Moving into REAL re-arms the first-click
  // confirmation, exactly like the SIM/REAL switch.
  const selectContract = useCallback((s: { contract: LadderContract; broker?: LadderBroker; mode?: 'real' | 'sim' }) => {
    // Another underlying is another price axis: drop the old rows until its price arrives.
    if (s.contract.underlying && s.contract.underlying !== underlying) setCenter(0);
    if (s.contract.underlying) setUnderlyingRaw(s.contract.underlying);
    if (s.contract.expiry) setExpiry(s.contract.expiry);
    if (s.contract.strike) setStrike(s.contract.strike);
    if (s.contract.opt) setOpt(s.contract.opt);
    if (s.broker) setBroker(s.broker);
    if (s.mode) { setReal(s.mode === 'real'); setRealAck(false); }
  }, [setBroker, underlying]);

  // Show a pair on the ladder: Pair mode on its underlying / expiry, centre strike and wing.
  const selectPair = useCallback((p: LadderPair) => {
    const c = p.legs.ce.contract, pc = p.legs.pe.contract;
    if (c.underlying !== underlying) setCenter(0);
    setUnderlyingRaw(c.underlying);
    setExpiry(c.expiry);
    setModeRaw('pair'); setTick(tickFor('pair'));
    setStructure(p.structure);
    const step = STRIKE_STEP[c.underlying] ?? 50;
    setStrike((c.strike + pc.strike) / 2);
    setWing(Math.max(1, Math.round((c.strike - pc.strike) / 2 / step)));
    setBroker(p.broker);
    setReal(p.mode === 'real'); setRealAck(false);
  }, [setBroker, underlying, tickFor]);

  // Auto-focus the contract of the newest live trade on first load so the user immediately sees it. It never switches
  // the page into REAL on its own: it prefers a trade in the page's mode (SIM on load) and otherwise shows the contract
  // only — the REAL chip in Active Trades switches mode with a click.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (autoFocusedRef.current || !data || second) return;
    const liveSlices = data.state.slices.filter(isLive);
    if (!liveSlices.length) return;
    const sameMode = liveSlices.filter(x => x.mode === (real ? 'real' : 'sim'));
    const latest = (sameMode.length ? sameMode : liveSlices)[(sameMode.length ? sameMode : liveSlices).length - 1];
    if (!latest.contract) return;
    autoFocusedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot on first data, guarded by autoFocusedRef
    selectContract({ contract: latest.contract, broker: latest.broker });
  }, [data, real, selectContract, second]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white min-w-0">
      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur xl:min-h-[var(--ladder-head-h)]" style={headerMinHeight ? ({ '--ladder-head-h': `${headerMinHeight + 1}px` } as React.CSSProperties) : undefined}>
      <div ref={headRef}>
      {/* Indices + P&L: always visible, above the foldable controls */}
      <div className="flex items-center gap-2 flex-wrap px-6 pt-2.5 text-xs">
        {!second && <>
          <QuoteChip label="NIFTY" q={quotes.NIFTY} />
          <QuoteChip label="INDIA VIX" q={quotes.VIX} />
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
        </>}
        <PnlChip label={`Ladder P&L · ${real ? 'REAL' : 'SIM'}`} value={ladderPnl}
          title={`The ladder's own P&L on ${BROKER_LABELS[broker]}, every contract, ${real ? 'REAL' : 'SIM'} orders only: closed at their exit, open at the live LTP, since entry (a carried NRML position counts from its entry). '—' if an open leg has no price.`} />
        {showAccount && <PnlChip label={`${BROKER_LABELS[broker]} P&L`} value={acct.pnl}
          title={`${BROKER_LABELS[broker]} account P&L today: realised + unrealised over all positions, as the broker reports it (includes trades not made on the ladder)${acct.note ? ` — ${acct.note}` : ''}`} />}
        {showAccount && acct.note && <span className="text-amber-300 truncate max-w-[18rem]" title={acct.note}>{acct.note}</span>}
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Rows3 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">PRICE LADDER{dual ? ` ${ladderId}` : ''} · {mode === 'xy' ? 'XY' : mode === 'pair' ? 'PAIR' : 'PLAIN'}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              {axisName} <span className="font-mono">{spot ? spot.toFixed(2) : '—'}</span>
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              {mode === 'xy' ? `Trade the option on ${mcx ? 'its futures month\'s' : 'index'} levels — the server fires armed levels with this tab closed`
                : mode === 'pair' ? 'Straddles / strangles on their combined CE + PE premium — the server fires both legs with this tab closed'
                  : 'One-click LIMIT / SL orders on the option premium'}
            </p>
          </div>
          {onToggleCollapsed && (
            <button type="button" onClick={onToggleCollapsed} aria-expanded={!collapsed}
              aria-label={collapsed ? 'Show header controls' : 'Hide header controls'}
              title={collapsed ? 'Show the controls (broker, SIM/REAL, P&L, books)' : 'Hide the controls for more room'}
              className="p-1.5 rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer">
              {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          )}
          {collapsed && (
            <>
              <span className={`text-[10px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${real ? 'text-red-300 bg-red-500/10 border-red-500/30' : 'text-zinc-300 bg-zinc-900 border-zinc-700'}`}
                title="Broker and order mode for this ladder (shown while the controls are hidden)">
                {BROKER_LABELS[broker]} · {real ? 'REAL' : 'SIM'}
              </span>
              {!real && <SimBadge />}
            </>
          )}
        </div>
        {!collapsed && <div className="flex items-center gap-2 flex-wrap">
          <BrokerPicker value={broker} onChange={setBroker} disabled={busy} brokers={LADDER_BROKERS} />
          <Seg value={real ? 'REAL' : 'SIM'} options={['SIM', 'REAL'] as const} onChange={v => { setReal(v === 'REAL'); setRealAck(false); }} />
          {!real && <SimBadge />}
          {!second && <button type="button" aria-pressed={soundOn} aria-label={soundOn ? 'Mute trade chimes' : 'Unmute trade chimes'}
            title={soundOn ? 'Trade chimes on: rising = entry, falling = exit, low buzz = rejected / unknown. Click to mute' : 'Trade chimes muted. Click to unmute'}
            onClick={() => { const v = !soundOn; setSoundOn(v); savePref(k('price-ladder-sound'), v ? '1' : '0'); }}
            className={`p-1.5 rounded-md border bg-zinc-900 cursor-pointer ${soundOn ? 'border-zinc-700 text-zinc-300 hover:text-white' : 'border-amber-500/50 text-amber-400'}`}>
            {soundOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>}
          {!second && <button
            type="button" onClick={() => (liveArmed ? void post({ action: 'live', on: false }) : setArmModal(true))}
            className={`px-2.5 py-1 rounded-md text-xs font-bold border transition-colors ${liveArmed ? 'bg-red-600 border-red-500 text-oncolor' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white'}`}
          >
            {liveArmed ? 'LIVE · REAL MONEY ON' : 'Arm LIVE · REAL MONEY'}
          </button>}
          {!second && <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate ?? '—'}
          </span>}
          <button type="button" onClick={() => setChainOpen(true)} disabled={!expiry}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer disabled:opacity-50"
            title={`The ${underlying} option chain for ${expiry || 'the selected expiry'}`}>
            <Table2 className="w-3.5 h-3.5 text-emerald-400" /> Option chain
          </button>
          {!second && <button
            type="button"
            onClick={() => setSettingsModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer"
            title="Configure Price Ladder trading cutoff & session thresholds"
          >
            <Settings className="w-3.5 h-3.5 text-amber-400" />
            Settings
          </button>}
          {second ? (
            <button type="button" onClick={onRemoveLadder} title="Close this ladder (orders it placed keep running on the server)"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer">
              <X className="w-3.5 h-3.5 text-red-400" /> Close ladder 2
            </button>
          ) : !dual && onAddLadder && (
            <button type="button" onClick={onAddLadder} title="Show a second, independent ladder beside this one (max 2)"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold border border-zinc-700 bg-zinc-900 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors cursor-pointer">
              <Plus className="w-3.5 h-3.5 text-emerald-400" /> Add ladder
            </button>
          )}
          {!second && (<><span className="w-px h-5 bg-zinc-800 shrink-0" /><NavBar /></>)}
        </div>}
      </div>
      {/* Books: part of the foldable controls (the chips above stay visible) */}
      {!collapsed && showAccount && <div className="flex items-center gap-2 flex-wrap px-6 pb-2.5 text-xs">
        <BookButton icon={<Briefcase className="w-3.5 h-3.5" />} label="Positions" count={acct.open} onClick={() => setBookOpen('positions')} />
        <BookButton icon={<ClipboardList className="w-3.5 h-3.5" />} label="Order book" onClick={() => setBookOpen('orders')} />
        <BookButton icon={<ReceiptText className="w-3.5 h-3.5" />} label="Trade book" onClick={() => setBookOpen('trades')} />
      </div>}
      </div>
      </div>
      {bookOpen && (
        <OrdersTradesModal
          isOpen
          readOnly
          subtitle="View only — change ladder orders from the ladder"
          initialTab={bookOpen}
          onClose={() => setBookOpen(null)}
          broker={broker}
          ordersData={book.orders}
          tradesData={book.trades}
          positionsData={book.positions}
          isLoading={bookLoading}
          error={bookError}
          onRefresh={() => { void fetchBook(); }}
        />
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {loadError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4" /> {loadError}
          </div>
        )}
        {stale && inSession && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" /> {axisName} {mcx ? 'price' : 'spot'} is stale{spotView ? ` (last ${timeOf(spotView.at)}, ${spotView.source})` : ''} — {mcx ? 'futures' : 'index'} levels are paused until it updates.
          </div>
        )}
        {pairError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4" /> Pair leg: {pairError}
          </div>
        )}
        {contractError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <AlertTriangle className="w-4 h-4" /> {contractError}
          </div>
        )}
        {mcx && sessionNote && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" /> {sessionNote}
          </div>
        )}
        {sessionDown && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" />
            {BROKER_LABELS[broker]} session is not logged in — {real ? 'REAL orders are off until you log in (Autologin); exits already sent keep retrying.' : 'SIM works; REAL needs a fresh login (Autologin).'}
          </div>
        )}
        {mode === 'pair' && pairView && !(pairView.combined && pairView.combined > 0) && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" /> No live price for {pairView.ce.ltp ? 'the PE leg' : pairView.pe.ltp ? 'the CE leg' : 'either leg'} yet — pair levels are paused until both legs price (the feed may still be subscribing).
          </div>
        )}
        {realBlocked && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <ShieldAlert className="w-4 h-4" /> REAL mode: arm LIVE · REAL MONEY for today before placing. Exits always work.
          </div>
        )}

        <div className={`grid grid-cols-1 gap-4 ${dual ? '2xl:grid-cols-[272px_minmax(0,1fr)]' : 'lg:grid-cols-[272px_minmax(0,1fr)]'}`}>
          {/* ── left panel ── */}
          <div className="flex flex-col gap-2" style={{ fontFeatureSettings: '"cv11", "ss01"' }}>
            {/* Side by side below 2xl when two ladders stack their panel above the grid: the two cards share a row. */}
            <div className={dual ? 'grid grid-cols-2 2xl:grid-cols-1 gap-2 items-start [&>*:only-child]:col-span-2 2xl:[&>*:only-child]:col-span-1' : 'contents'}>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
              <p className="text-[13px] font-semibold tracking-tight text-zinc-100">{optLabel}</p>
              {mode === 'pair' ? (
                <>
                  <p className="text-xl font-mono font-semibold tracking-tight text-white leading-tight" title="Combined premium: CE LTP + PE LTP">{combined ? combined.toFixed(2) : '—'}</p>
                  <p className="font-mono text-xs text-zinc-400">
                    CE {pairView?.ce.strike ?? '—'} <span className="text-zinc-200">{pairView?.ce.ltp?.toFixed(2) ?? '—'}</span>
                    {' + '}PE {pairView?.pe.strike ?? '—'} <span className="text-zinc-200">{pairView?.pe.ltp?.toFixed(2) ?? '—'}</span>
                  </p>
                </>
              ) : (
                <p className="text-xl font-mono font-semibold tracking-tight text-white leading-tight">{optLtp ? optLtp.toFixed(2) : '—'}</p>
              )}
              <div className="mt-1.5 pt-1.5 border-t border-zinc-800 text-xs">
                <p className="font-semibold text-zinc-300">{axisName} <span className="font-mono text-zinc-100">{spot ? spot.toFixed(2) : '—'}</span>
                  {indexQ?.change_pct != null && <span className={`ml-2 font-mono ${indexQ.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{indexQ.change_pct >= 0 ? '+' : ''}{indexQ.change_pct.toFixed(2)}%</span>}
                </p>
                <p className="font-mono text-zinc-500 mt-0.5">H {indexQ?.day_high?.toFixed(2) ?? '—'} · L {indexQ?.day_low?.toFixed(2) ?? '—'}</p>
              </div>
            </div>

            {mode !== 'pair' && <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 grid grid-cols-2 gap-y-0.5 text-xs">
              <span className="text-zinc-400 font-medium">Net Pos <span className="text-zinc-500">({pageMode.toUpperCase()})</span></span><span className="font-mono text-right text-zinc-100">{net.qty}</span>
              <span className="text-zinc-400 font-medium">P&amp;L</span><span className={`font-mono text-right ${pnlClass(contractPnl)}`}>{fmtMoney(contractPnl)}</span>
              <span className="text-zinc-400 font-medium">Avg Price</span><span className="font-mono text-right text-zinc-100">{net.avg ? net.avg.toFixed(2) : '—'}</span>
              <div className="col-span-2 flex gap-1 mt-1.5">
                {[25, 50, 75, 100].map(p => (
                  <button
                    key={p} type="button" disabled={busy || net.qty === 0}
                    onClick={() => void post({ action: 'exit', securityId, broker, mode: pageMode, pct: p })}
                    className="flex-1 px-1 py-0.5 rounded text-xs font-semibold border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40"
                  >
                    {p === 100 ? `Exit (${net.qty})` : `${p}%`}
                  </button>
                ))}
              </div>
            </div>}
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 flex flex-col gap-1.5 text-xs">
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Ladder</span>
                <Seg compact value={mode} options={['xy', 'plain', 'pair'] as const} labels={{ xy: 'XY (index)', plain: 'Plain', pair: 'Pair' }} onChange={setMode} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Product</span>
                <Seg compact value={product} options={['NRML', 'MIS'] as const} onChange={setProduct} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Underlying</span>
                <select aria-label="Underlying" value={underlying} onChange={e => setUnderlying(e.target.value)} className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100">
                  {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Expiry</span>
                <select aria-label="Expiry" value={expiry} onChange={e => { setExpiry(e.target.value); setStrike(null); }} className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100">
                  {expiries.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2"><span className="text-zinc-400 font-medium">Strike</span>
                <div className="flex items-center gap-2">
                  <select aria-label="Strike" value={strike ?? ''} onChange={e => setStrike(Number(e.target.value))} className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono">
                    {strikes.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                  {mode !== 'pair' && <Seg compact value={opt} options={['CE', 'PE'] as const} labels={{ CE: 'Call', PE: 'Put' }} onChange={setOpt} />}
                </div>
              </div>
              {mode === 'pair' && (
                <>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Straddle: CE and PE on the strike above. Strangle: CE the wing above it, PE the wing below.">Structure</span>
                    <Seg compact value={structure} options={['straddle', 'strangle'] as const} labels={{ straddle: 'Straddle', strangle: 'Strangle' }} onChange={setStructure} />
                  </div>
                  {structure === 'strangle' && (
                    <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title={`Strikes either side of the centre (${pairStep} each)`}>Wing (strikes)</span>
                      <NumField compact label="Strangle wing in strikes" value={wing} onCommit={v => setWing(Math.max(1, Math.min(20, Math.round(v))))} min={1} max={20} width="w-14" />
                    </div>
                  )}
                  <p className="text-zinc-500">{pairOk ? `CE ${pairCe} · PE ${pairPe}` : 'Those strikes are not in the chain — pick another centre or wing'}</p>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Per-leg stop: either leg moving this % against its own fill exits BOTH legs (a short leg rising — 100 = doubled; a long leg falling). 0 = off. Runs alongside the combined target / SL.">Leg SL %</span>
                    <NumField compact label="Per-leg stop-loss percent (0 = off)" value={legSlPct} onCommit={v => setLegSlPct(Math.max(0, Math.round(v)))} min={0} max={1000} step={5} width="w-16" />
                  </div>
                </>
              )}
              <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="Classic: Buy and Sell each work on their limit side (the other side needs Order Type SL). Anywhere: both columns at every level — the other side is a stop by itself.">Zones</span>
                <Seg compact value={zones} options={['classic', 'anywhere'] as const} labels={{ classic: 'Classic', anywhere: 'Anywhere' }} onChange={setZones} />
              </div>
              {zones === 'classic' ? (
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium">Order Type</span>
                  <Seg compact value={orderType} options={['LIMIT', 'SL'] as const} labels={{ LIMIT: 'Limit', SL: 'SL' }} onChange={setOrderType} />
                </div>
              ) : mode === 'plain' ? (
                <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title="An SL-limit's limit sits this % past its trigger: below it for a Sell, above it for a Buy">SL limit buffer %</span>
                  <NumField compact label="SL limit buffer percent" value={slBufferPct} onCommit={setSlBufferPct} min={MIN_SL_BUFFER_PCT} max={MAX_SL_BUFFER_PCT} step={0.1} />
                </div>
              ) : null}
              {(mode === 'xy' || mode === 'pair') && (
                <>
                  <div className="flex items-center justify-between"><span className="text-zinc-400 font-medium" title={mode === 'pair' ? 'Target / SL / trail are points of the combined premium' : undefined}>Style</span>
                    <Seg compact value={style} options={['Single', 'Bracket', 'Cover'] as const} onChange={setStyle} />
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 items-center">
                    {style === 'Bracket' && <><span className="text-zinc-400 font-medium">Target pts</span><NumField compact label="Target points" value={tgtPts} onCommit={setTgtPts} min={1} /></>}
                    {style !== 'Single' && <><span className="text-zinc-400 font-medium">SL pts</span><NumField compact label="Stop-loss points" value={slPts} onCommit={setSlPts} min={1} /></>}
                    {/* Every style: Single + trail = a trailing stop on its own (the SL starts at the trail distance). */}
                    <label className="flex items-center gap-1.5 text-zinc-400" title="Continuous trailing SL: the SL stays this many points behind the best level reached and moves with every new high / low — never back">
                      <input type="checkbox" checked={trailOn} onChange={e => setTrailOn(e.target.checked)} /> Trail SL by
                    </label>
                    <NumField compact label="Trailing SL distance in points" value={trailPts} onCommit={setTrailPts} min={1} />
                  </div>
                </>
              )}
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"><span className="text-zinc-400 font-medium">Lots {lotSize ? <span className="text-zinc-500">({mcx ? `${lots * (MCX_LOT_MULTIPLIER[underlying] ?? 1)} bbl` : `${lots * lotSize} qty`})</span> : null}</span>
                <div className="flex flex-wrap items-center gap-1">
                  <NumField compact label="Lots" value={lots} onCommit={v => setLots(Math.min(MAX_LADDER_LOTS, Math.max(1, Math.round(v))))} min={1} max={MAX_LADDER_LOTS} width="w-14" />
                  {[1, 5, 10].map(n => (
                    <button key={n} type="button" onClick={() => setLots(l => Math.min(MAX_LADDER_LOTS, l + n))} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">+{n}</button>
                  ))}
                  <button type="button" onClick={() => setLots(1)} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-white">Clear</button>
                </div>
              </div>
              {mode !== 'pair' && (
                <div className="grid grid-cols-2 gap-1.5">
                  <button type="button" disabled={busy || !expiry || !strike} onClick={() => sendMarket('BUY')}
                    title={`BUY ${lots} lot(s) ${strike ?? ''}${opt} at market now`} aria-label="Buy at market"
                    className="px-2 py-1.5 rounded bg-emerald-600 text-oncolor font-bold hover:bg-emerald-500 disabled:opacity-50">Buy Market</button>
                  <button type="button" disabled={busy || !expiry || !strike} onClick={() => sendMarket('SELL')}
                    title={`SELL ${lots} lot(s) ${strike ?? ''}${opt} at market now`} aria-label="Sell at market"
                    className="px-2 py-1.5 rounded bg-red-600 text-oncolor font-bold hover:bg-red-500 disabled:opacity-50">Sell Market</button>
                </div>
              )}
            </div>
            <MtmGuardCard key={myGuardKey} broker={broker} real={real} ladderId={ladderId} mtm={ladderPnl} guard={data?.state?.guards?.[myGuardKey]} post={post} />
            <p className="flex items-center gap-1.5 text-[10px] text-zinc-500">
              <span className="inline-flex" title={HELP_TEXT} aria-label={HELP_TEXT} role="img"><Info className="w-3.5 h-3.5" aria-hidden /></span>
            </p>
          </div>

          {/* ── ladder ── */}
          <div className="flex flex-col gap-2 min-w-0">
            {(live.length > 0 || livePairs.length > 0) && (
              <div className="flex items-center gap-1.5 flex-wrap px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs">
                <span className="text-zinc-400 font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Active Trades:
                </span>
                {liveGroups.map(g => {
                  const s0 = g.slices[0];
                  const isCur = s0.contract.securityId === securityId && s0.broker === broker && s0.mode === pageMode;
                  return (
                    <button
                      key={g.key} type="button"
                      onClick={() => selectContract(s0)}
                      title={isCur ? 'On the ladder now' : `Show it on the ladder (${s0.mode.toUpperCase()} · ${BROKER_LABELS[s0.broker]})`}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-colors ${FOCUS_RING} ${isCur ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold shadow-sm' : 'bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500'}`}
                    >
                      <span>{s0.contract.underlying} {s0.contract.strike}{s0.contract.opt}</span>
                      <span className={s0.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{s0.side}</span>
                      <span className="text-[10px] text-zinc-400">
                        ({s0.mode === 'real' ? <span className="text-red-400 font-bold">REAL</span> : 'SIM'} · {g.lots}L{s0.contract.mult ? ` · ${g.lots * s0.contract.mult} bbl` : ''}{g.armed ? ` · ${g.armed} armed` : ''})
                      </span>
                      {!isCur && <span className="text-[10px] text-amber-300 underline font-sans ml-0.5">View on ladder</span>}
                    </button>
                  );
                })}
                {livePairs.map(p => {
                  const isCur = myPairs.some(y => y.id === p.id);
                  return (
                    <button
                      key={p.id} type="button" onClick={() => selectPair(p)}
                      title={isCur ? 'On the ladder now' : 'Show this pair on the ladder (Pair mode)'}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-colors ${FOCUS_RING} ${isCur ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold shadow-sm' : 'bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500'}`}
                    >
                      <span>{p.legs.ce.contract.underlying} {pairName(p)}</span>
                      <span className={p.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{p.side}</span>
                      <span className="text-[10px] text-zinc-400">({p.mode === 'real' ? <span className="text-red-400 font-bold">REAL</span> : 'SIM'} · {p.lots}L{p.state !== 'open' ? ` · ${p.state}` : ''})</span>
                      {!isCur && <span className="text-[10px] text-amber-300 underline font-sans ml-0.5">View on ladder</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {hiddenPairs.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-xs text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {hiddenPairs.map(p => (
                  <span key={p.id} className="inline-flex items-center gap-2">
                    {p.lots} lot(s) {p.side} {p.state === 'armed' ? 'armed ' : ''}{p.mode === 'real' ? 'REAL' : 'SIM'} {pairName(p)} on {BROKER_LABELS[p.broker]} — not shown: the ladder is on {real ? 'REAL' : 'SIM'} · {BROKER_LABELS[broker]}.
                    <button type="button" onClick={() => selectPair(p)}
                      className={`px-2 py-0.5 rounded border border-amber-500/50 font-bold hover:bg-amber-500/20 ${FOCUS_RING}`}>
                      Show {p.mode === 'real' ? 'REAL' : 'SIM'}{p.broker !== broker ? ` · ${BROKER_LABELS[p.broker]}` : ''}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-zinc-400">Tick</span>
              <Seg value={String(tick)} options={ticks.map(String)} onChange={v => chooseTick(Number(v), mode)} />
              <button type="button" onClick={() => { setFollow(true); setManual(false); setCenter(refPrice); }} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white">
                <Crosshair className="w-3.5 h-3.5" /> Centre
              </button>
              <label className="flex items-center gap-1.5 text-zinc-400"><input type="checkbox" checked={follow} onChange={e => { setFollow(e.target.checked); if (e.target.checked) setManual(false); }} /> Follow price</label>
              {held && <span className="text-[10px] text-amber-300" title="The rows stay put while the pointer is on the ladder, so a price tick cannot move a level under the mouse; they re-centre when it leaves">Rows held</span>}
              <button
                type="button"
                onClick={() => setSettingsModalOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:text-white hover:border-zinc-500 cursor-pointer"
                title="Configure trading cutoff & Price Ladder settings"
              >
                <Settings className="w-3.5 h-3.5 text-amber-400" /> Settings
              </button>
              <button
                type="button" disabled={busy || pendingHere === 0}
                onClick={() => void post({ action: 'cancelAll', securityId, broker, mode: pageMode })}
                className="px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white disabled:opacity-40"
              >
                Cancel all ({pendingHere})
              </button>
              <span className="ml-auto text-zinc-500">{real ? <span className="font-bold text-red-400">REAL</span> : <span className="rounded bg-amber-400 px-1.5 py-0.5 font-extrabold text-oncolor-dark">SIM</span>} · {BROKER_LABELS[broker]}</span>
            </div>
            <LadderGrid
              center={center} refPrice={refPrice} tick={tick} rows={ROWS}
              widgets={mode === 'pair' ? pairWidgetsFor(myPairs) : widgetsFor(mine, mode)}
              limitZoneBuy={limitZone(mode === 'pair' ? 'plain' : mode, opt, 'BUY')}
              zones={zones} stopLimitFor={mode === 'plain' ? (side, p) => stopLimitPrice(side, p, slBufferPct) : undefined}
              onPlace={onPlace} onCancel={id => void post(mode === 'pair' ? { action: 'pair', op: 'cancel', id } : { action: 'cancel', id })} onMove={onMove} onAdjust={onAdjust}
              disabled={placeDisabled} decimals={decimals} entryMarks={entryMarks}
              onScroll={refPrice > 0 ? scrollLadder : undefined}
              onTrail={(w, delta) => { void post(mode === 'pair' ? { action: 'pair', op: 'trail', id: w.ids[0], delta } : { action: 'trail', id: w.ids[0], delta }); }}
              onHoldChange={setHeld}
              keyLevels={mode === 'xy' ? {
                pdh: data?.keyLevels?.pdh ?? null,
                pdl: data?.keyLevels?.pdl ?? null,
                dayHigh: indexQ?.day_high ?? data?.keyLevels?.dayHigh ?? null,
                dayLow: indexQ?.day_low ?? data?.keyLevels?.dayLow ?? null,
              } : undefined}
            />
          </div>
        </div>

        {/* ── orders ── */}
        <div className="rounded-lg border border-zinc-800 overflow-x-auto">
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
            <p className="text-xs font-bold text-white">Ladder orders &amp; positions <span className="text-zinc-500 font-medium">({live.length} live)</span></p>
            {(done.length > 0 || panePairs.some(p => !isPairLive(p))) && (
              <button type="button" onClick={() => void post({ action: 'clear', ...(dual ? { pane: ladderId } : {}) })} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
                <Trash2 className="w-3.5 h-3.5" /> Clear finished
              </button>
            )}
          </div>
          {paneSlices.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">No ladder orders today{dual ? ' from this ladder' : ''}. Click a price on the ladder to place one.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-zinc-800">
                <tr className="text-left">
                  {[
                    ['Time', 'When the order was placed / armed'],
                    ['Mode', ''],
                    ['Contract', ''],
                    ['Side', ''],
                    ['Qty', 'Filled quantity (ordered while unfilled), in lots'],
                    ['Trigger', 'XY: the index / futures level that fires the entry. Plain: the LIMIT / SL price'],
                    ['Fired at', 'XY: the index / futures level when the entry fired (the bracket is measured from it)'],
                    ['Entry ₹', 'Option entry price: the average fill'],
                    ['LTP ₹', 'Option live price (open positions)'],
                    ['Exit ₹', 'Option exit price: the average exit fill, with the exit time'],
                    ['TGT / SL', 'Bracket target / stop on the index / futures level (T = trailing step)'],
                    ['State', ''],
                    ['P&L', 'Closed: at the exit price. Open: at the live price'],
                    ['', ''],
                  ].map(([h, t], i) => (
                    <th key={`${h}-${i}`} title={t || undefined} className="px-2 py-1.5 text-xs font-bold text-white whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...paneSlices].reverse().map(s => <SliceRow key={s.id} s={s} ltp={data?.ltps[s.contract.securityId]} busy={busy} post={post} trailPts={trailPts} onSelect={selectContract} />)}
              </tbody>
            </table>
          )}
        </div>

        {panePairs.length > 0 && (
          <PairTable pairs={panePairs} ltps={data?.ltps ?? {}} busy={busy} post={post} trailPts={trailPts} onSelect={selectPair}
            onLots={(p, d) => onAdjust({ key: p.id, price: 0, column: p.side, kind: 'pos', label: 'Pair position', qty: p.qty, lots: p.lots, ids: [p.id], adjust: 'position' }, d, true)}
            onRoll={onRoll} />
        )}

        {/* Collapsed by default (remembered per browser); the header keeps the count and the newest event in view. */}
        <details
          open={eventsOpen}
          onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; setEventsOpen(o); savePref(k('price-ladder-events-open'), o ? '1' : '0'); }}
          className="rounded-lg border border-zinc-800 group"
        >
          <summary className={`flex items-center gap-2 px-3 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-lg ${FOCUS_RING}`}>
            <ChevronRight className="w-3.5 h-3.5 text-zinc-400 transition-transform group-open:rotate-90" aria-hidden />
            <span className="text-xs font-bold text-white">Events</span>
            <span className="text-xs text-zinc-500">({paneEvents.length})</span>
            {latestEvent && (
              <span className={`ml-2 min-w-0 truncate font-mono text-[11px] ${latestEvent.level === 'error' ? 'text-red-400' : latestEvent.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'}`}>
                {timeOf(latestEvent.at)} {latestEvent.msg}
              </span>
            )}
          </summary>
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto font-mono text-[11px] px-3 pb-3">
            {paneEvents.slice(-60).reverse().map((e, i) => (
              <p key={`${e.at}-${i}`} className={e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'}>
                {timeOf(e.at)} {e.msg}
              </p>
            ))}
            {!paneEvents.length && <p className="text-zinc-500">Nothing yet.</p>}
          </div>
        </details>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">{confirm.setting ? confirm.setting.title : 'Place a REAL-money order?'}</p>
            <p className="text-xs text-zinc-300">{confirm.setting ? confirm.text : `${confirm.text} on ${BROKER_LABELS[broker]}.`}</p>
            {!confirm.setting && <p className="text-[11px] text-zinc-500">Further clicks on this page load go straight through.</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { const c = confirm; setConfirm(null); if (!c.setting) setRealAck(true); c.run(); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">{confirm.setting ? confirm.setting.button : 'Place REAL order'}</button>
            </div>
          </div>
        </div>
      )}
      {armModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">Arm LIVE · REAL MONEY for today?</p>
            <p className="text-xs text-zinc-300">REAL ladder orders will place real orders on your broker account. Armed index levels are fired by the dashboard server even with this tab closed, until {sessionFor(underlying, istDay(), data?.state?.settings?.mcxAutoExitTime, data?.state?.settings?.nseAutoExitTime).autoExitLabel} IST{mcx ? ` (${underlying}, today)` : ''}.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setArmModal(false)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { setArmModal(false); void post({ action: 'live', on: true }); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">Arm for today</button>
            </div>
          </div>
        </div>
      )}
      {chainOpen && expiry && (
        <LadderOptionChain underlying={underlying} expiry={expiry} selectedStrike={strike} selectedOpt={opt}
          onPick={(k, o) => { setStrike(k); setOpt(o); }} onClose={() => setChainOpen(false)} />
      )}
      {settingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 flex flex-col gap-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <Settings className="w-4 h-4 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Price Ladder Settings</h3>
                  <p className="text-[10px] text-zinc-400">Configure trading cutoffs and session thresholds</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  MCX Trading Cutoff (CRUDEOILM)
                </span>
                <span className="text-xs font-mono font-bold text-amber-300">
                  {data?.state?.settings?.mcxAutoExitTime ?? '23:15'} IST
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Trading cutoff and MIS auto square-off threshold. After this time, new orders and armed levels are rejected ahead of the session close.
              </p>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {(['23:00', '23:15', '23:20', '23:25'] as const).map(time => {
                  const active = (data?.state?.settings?.mcxAutoExitTime ?? '23:15') === time;
                  return (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setCutoff('mcx', time)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                        active
                          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300 font-bold ring-1 ring-amber-500/30'
                          : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      {time}
                      <span className="text-[9px] font-sans font-normal text-zinc-500">
                        {time === '23:15' ? 'Default' : time === '23:00' ? '11:00 PM' : 'IST'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3 pt-3 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-400" />
                  NSE Trading Cutoff (Nifty, Bank Nifty & other indices)
                </span>
                <span className="text-xs font-mono font-bold text-amber-300">
                  {data?.state?.settings?.nseAutoExitTime ?? '15:17'} IST
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                Trading cutoff and MIS auto square-off for NSE / BSE index options. After this time, new orders and armed levels are rejected ahead of the 15:30 close.
              </p>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {(['15:00', '15:10', '15:17', '15:25'] as const).map(time => {
                  const active = (data?.state?.settings?.nseAutoExitTime ?? '15:17') === time;
                  return (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setCutoff('nse', time)}
                      className={`flex flex-col items-center justify-center py-2 px-1 rounded-lg border text-xs font-mono transition-all cursor-pointer ${
                        active
                          ? 'border-amber-500/50 bg-amber-500/20 text-amber-300 font-bold ring-1 ring-amber-500/30'
                          : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      }`}
                    >
                      {time}
                      <span className="text-[9px] font-sans font-normal text-zinc-500">
                        {time === '15:17' ? 'Default' : 'IST'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="pt-3 border-t border-zinc-800 flex justify-end">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="px-4 py-1.5 rounded-lg bg-zinc-800 text-xs font-semibold text-white hover:bg-zinc-700 transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuoteChip({ label, q }: { label: string; q?: IndexQuote }) {
  const ch = q?.change_pct;
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900">
      <span className="text-[10px] font-bold tracking-wider text-zinc-400">{label}</span>
      <span className="font-mono font-bold text-zinc-100">{q?.ltp ? q.ltp.toFixed(2) : '—'}</span>
      {ch != null && <span className={`font-mono ${ch >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{ch >= 0 ? '+' : ''}{ch.toFixed(2)}%</span>}
    </span>
  );
}

function PnlChip({ label, value, title }: { label: string; value: number | null; title: string }) {
  const tone = value == null ? 'text-zinc-400' : value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : 'text-zinc-200';
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900" title={title}>
      <span className="text-[10px] font-bold tracking-wider text-zinc-400 uppercase">{label}</span>
      <span className={`font-mono font-bold ${tone}`}>{value == null ? '—' : `${value >= 0 ? '+' : '−'}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}</span>
    </span>
  );
}

function BookButton({ icon, label, count, onClick }: { icon: ReactNode; label: string; count?: number | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 ${FOCUS_RING}`}>
      {icon}{label}{count != null && <span className="font-mono text-zinc-400">({count})</span>}
    </button>
  );
}

/** A position's trailing SL: its distance (edit = set, 0 = off), or a button to switch it on at the panel's distance. */
function TrailControl({ s, busy, post, fallback }: { s: LadderSlice; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; fallback: number }) {
  const cur = s.bracket?.trailPts ?? 0;
  const step = s.bracket?.trailMode !== 'distance' && cur > 0;   // an older step trail, kept until changed
  if (!cur) {
    return (
      <button type="button" disabled={busy} onClick={() => void post({ action: 'trail', id: s.id, trailPts: fallback })}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}
        title={`Trail the SL ${fallback} points behind the best level from now on`}>
        Trail {fallback}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={step ? `Step trail: ${cur} pts of SL per ${cur} pts of move. Change the distance to switch to continuous trailing.` : `Continuous trailing SL, ${cur} pts behind the best level`}>
      <span className="text-amber-300 text-[11px]">{step ? 'Step' : 'Trail'}</span>
      <NumField label="Trailing SL distance in points" value={cur} min={0} width="w-14" onCommit={v => { if (v !== cur) void post({ action: 'trail', id: s.id, trailPts: v }); }} />
      <button type="button" disabled={busy} onClick={() => void post({ action: 'trail', id: s.id, trailPts: 0 })}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        Off
      </button>
    </span>
  );
}

function SliceRow({ s, ltp, busy, post, trailPts, onSelect }: { s: LadderSlice; ltp: number | undefined; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; trailPts: number; onSelect?: (s: LadderSlice) => void }) {
  const live = isLive(s);
  const pnl = sliceNowPnl(s, ltp) ?? null;
  const qty = Number(s.filledQty) || s.qty;
  const trig = s.kind === 'xy'
    ? (s.entryLevel ? `${s.contract.underlying}${s.contract.ref ? ' FUT' : ''} ${s.entryDir === 'below' ? '≤' : '≥'} ${s.entryLevel}` : '—')
    : s.stopLimitPrice ? `SL ${s.triggerPrice} → ${s.stopLimitPrice.toFixed(2)}`
      : `${s.orderType === 'SL' ? 'SL ' : ''}${s.limitPrice ?? s.triggerPrice ?? '—'}`;
  const stateClass = s.state === 'unknown' || s.state === 'rejected' ? 'text-red-400 font-bold'
    : s.state === 'open' ? 'text-emerald-400 font-bold' : s.state === 'armed' || s.state === 'working' ? 'text-sky-300' : 'text-zinc-400';
  return (
    <tr className={`border-t border-zinc-900 ${live ? '' : 'opacity-60'}`}>
      <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{timeOf(s.createdAt)}</td>
      <td className="px-2 py-1 whitespace-nowrap"><span className={s.mode === 'real' ? 'font-bold text-red-400' : 'text-zinc-300'}>{s.mode.toUpperCase()}</span> <span className="text-zinc-500">{s.broker}</span></td>
      <td
        onClick={() => onSelect?.(s)}
        title={onSelect ? 'Click to view this contract on the ladder' : undefined}
        className={`px-2 py-1 whitespace-nowrap text-zinc-200 ${onSelect ? 'cursor-pointer hover:text-white hover:underline' : ''}`}
      >
        {s.contract.underlying} {s.contract.expiry.slice(5)} {s.contract.strike}{s.contract.opt} <span className="text-zinc-500">{s.product}</span>
      </td>
      <td className={`px-2 py-1 font-bold ${s.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{s.side}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
        {/* MCX on Dhan: qty is lots, so show the barrels too. */}
        {s.contract.mult ? <>{qty}L <span className="text-zinc-500">({qty * s.contract.mult} bbl)</span></> : <>{qty} <span className="text-zinc-500">({s.lots}L)</span></>}
      </td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{trig}</td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{s.kind === 'xy' && s.entryY ? s.entryY.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono font-bold text-zinc-100 whitespace-nowrap">{s.avg ? s.avg.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">{(s.state === 'open' || s.state === 'exiting') && ltp ? ltp.toFixed(2) : '—'}</td>
      <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
        {s.exitAvg ? <>{s.exitAvg.toFixed(2)}{s.closedAt ? <span className="text-zinc-500"> · {timeOf(s.closedAt)}</span> : null}</> : '—'}
      </td>
      <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">
        {s.bracket ? `${s.bracket.tgtPts > 0 ? (s.tgtY ?? `+${s.bracket.tgtPts}`) : 'Cover'} / ${s.slY ?? `-${s.bracket.slPts}`}${s.bracket.trailPts ? ` · T${s.bracket.trailPts}` : ''}` : '—'}
      </td>
      <td className={`px-2 py-1 whitespace-nowrap ${stateClass}`} title={s.note ?? s.exitReason ?? ''}>
        {s.state.toUpperCase()}{s.state === 'closed' && s.exitReason ? <span className="text-zinc-500 font-normal"> · {s.exitReason}</span> : null}
        {s.note && s.state !== 'closed' ? <span className="block text-[10px] font-normal text-zinc-500 max-w-64 truncate">{s.note}</span> : null}
      </td>
      <td className={`px-2 py-1 font-mono ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</td>
      <td className="px-2 py-1 whitespace-nowrap">
        <div className="flex gap-1">
          {(s.state === 'armed' || s.state === 'working') && (
            <button type="button" disabled={busy} onClick={() => void post({ action: 'cancel', id: s.id })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Cancel</button>
          )}
          {s.state === 'open' && (
            <button type="button" disabled={busy} onClick={() => void post({ action: 'exit', id: s.id, pct: 100 })} className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15">Exit</button>
          )}
          {/* Trailing SL, switched on or changed any time: the distance behind the best level (commit on Enter / blur). */}
          {(s.state === 'open' || s.state === 'armed') && s.bracket && (
            <TrailControl s={s} busy={busy} post={post} fallback={trailPts} />
          )}
          {s.state === 'unknown' && (
            <>
              <button type="button" disabled={busy} onClick={() => void post({ action: 'resolve', id: s.id, outcome: 'open' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white" title="You checked Positions and it is open: track it">It is open</button>
              <button type="button" disabled={busy} onClick={() => void post({ action: 'resolve', id: s.id, outcome: 'flat' })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white" title="You checked Positions and nothing is open">Nothing open</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Pair mode's own orders & positions (both legs on one row, with each leg's own order status). */
function PairTable({ pairs, ltps, busy, post, trailPts, onSelect, onLots, onRoll }: {
  pairs: LadderPair[]; ltps: Record<string, number>; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>;
  trailPts: number; onSelect: (p: LadderPair) => void;
  /** + / − one lot on both legs (the page asks first for a REAL add, as on the ladder). */
  onLots: (p: LadderPair, delta: 1 | -1) => void;
  /** Shift both legs / roll one leg N strikes (the page asks first for a REAL pair). */
  onRoll: (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => void;
}) {
  const heads: [string, string][] = [
    ['Time', 'When the pair was armed'], ['Mode', ''], ['Pair', ''], ['Side', ''], ['Qty', 'Per leg, in lots'],
    ['Trigger', 'The combined premium (CE + PE) that fires the entry'],
    ['Entry ₹', 'CE fill + PE fill = combined fill'], ['Now ₹', 'Live CE + PE (open pairs)'], ['Exit ₹', 'CE exit + PE exit, with the exit time'],
    ['TGT / SL', 'Bracket target / stop on the combined premium (T = trailing distance)'], ['State', ''],
    ['P&L', 'Both legs: closed at their exits, open at live prices'], ['', ''],
  ];
  const two = (a?: number, b?: number) => (a && b ? `${a.toFixed(2)} + ${b.toFixed(2)} = ${(a + b).toFixed(2)}` : '—');
  return (
    <div className="rounded-lg border border-zinc-800 overflow-x-auto">
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
        <p className="text-xs font-bold text-white">Pair orders &amp; positions <span className="text-zinc-500 font-medium">({pairs.filter(isPairLive).length} live)</span></p>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-zinc-800">
          <tr className="text-left">
            {heads.map(([h, t], i) => <th key={`${h}-${i}`} title={t || undefined} className="px-2 py-1.5 text-xs font-bold text-white whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...pairs].reverse().map(p => {
            const live = isPairLive(p);
            const pnl = pairNowPnl(p, ltps) ?? null;
            const ce = p.legs.ce, pe = p.legs.pe;
            const nowCe = ltps[ce.contract.securityId], nowPe = ltps[pe.contract.securityId];
            const mult = ce.contract.mult;
            const stateClass = p.state === 'unknown' || p.state === 'broken' ? 'text-red-400 font-bold'
              : p.state === 'open' ? 'text-emerald-400 font-bold' : p.state === 'armed' || p.state === 'placing' || p.state === 'exiting' || p.state === 'rolling' ? 'text-sky-300' : 'text-zinc-400';
            const holding = p.state === 'open' || p.state === 'broken' || p.state === 'exiting' || p.state === 'rolling';
            const unknownLegs = LEG_KEYS.filter(k => p.legs[k].unknown);
            return (
              <tr key={p.id} className={`border-t border-zinc-900 ${live ? '' : 'opacity-60'}`}>
                <td className="px-2 py-1 font-mono text-zinc-400 whitespace-nowrap">{timeOf(p.createdAt)}</td>
                <td className="px-2 py-1 whitespace-nowrap"><span className={p.mode === 'real' ? 'font-bold text-red-400' : 'text-zinc-300'}>{p.mode.toUpperCase()}</span> <span className="text-zinc-500">{p.broker}</span></td>
                <td className="px-2 py-1 whitespace-nowrap text-zinc-200">
                  <span onClick={() => onSelect(p)} title="Click to view this pair on the ladder" className="cursor-pointer hover:text-white hover:underline">
                    {ce.contract.underlying} {ce.contract.expiry.slice(5)} {pairName(p)} <span className="text-zinc-500">{p.product}</span>
                  </span>
                  {/* REAL: each leg's own order, so a one-legged moment is visible as it happens. */}
                  {p.mode === 'real' && p.state !== 'armed' && (
                    <span className="block text-[10px] font-mono text-zinc-400">{LEG_KEYS.map(k => <span key={k} className={`mr-2 ${p.legs[k].unknown || p.legs[k].outside || p.legs[k].entry === 'dead' ? 'text-red-400' : ''}`}>{legStatus(k, p.legs[k])}</span>)}</span>
                  )}
                </td>
                <td className={`px-2 py-1 font-bold ${p.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{p.side}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
                  {mult ? <>{p.qty}L <span className="text-zinc-500">({p.qty * mult} bbl)</span></> : <>{p.qty} <span className="text-zinc-500">({p.lots}L)</span></>}
                </td>
                <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">{p.entryLevel ? `CE+PE ${p.entryDir === 'below' ? '≤' : '≥'} ${p.entryLevel}` : '—'}</td>
                <td className="px-2 py-1 font-mono font-bold text-zinc-100 whitespace-nowrap">{two(ce.avg, pe.avg)}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">{holding ? two(nowCe, nowPe) : '—'}</td>
                <td className="px-2 py-1 font-mono text-zinc-200 whitespace-nowrap">
                  {ce.exitAvg && pe.exitAvg ? <>{two(ce.exitAvg, pe.exitAvg)}{p.closedAt ? <span className="text-zinc-500"> · {timeOf(p.closedAt)}</span> : null}</>
                    : ce.exitAvg || pe.exitAvg ? `${ce.exitAvg ? `CE ${ce.exitAvg.toFixed(2)}` : ''}${pe.exitAvg ? ` PE ${pe.exitAvg.toFixed(2)}` : ''}` : '—'}
                </td>
                <td className="px-2 py-1 font-mono text-zinc-300 whitespace-nowrap">
                  {p.bracket ? `${p.bracket.tgtPts > 0 ? (p.tgtY ?? `±${p.bracket.tgtPts}`) : 'Cover'} / ${p.slY ?? `±${p.bracket.slPts}`}${p.bracket.trailPts ? ` · T${p.bracket.trailPts}` : ''}` : '—'}
                  {p.legSlPct ? (
                    <span className="block text-[10px] text-amber-300" title="Per-leg stop: either leg reaching its level exits both legs">
                      Leg SL {p.legSlPct}%{LEG_KEYS.map(k => { const v = legSlPrice(p, p.legs[k]); return v != null ? ` · ${k.toUpperCase()} ${v.toFixed(2)}` : ''; }).join('')}
                    </span>
                  ) : null}
                </td>
                <td className={`px-2 py-1 whitespace-nowrap ${stateClass}`} title={p.note ?? p.exitReason ?? ''}>
                  {p.state.toUpperCase()}{p.state === 'closed' && p.exitReason ? <span className="text-zinc-500 font-normal"> · {p.exitReason}</span> : null}
                  {p.note && p.state !== 'closed' ? <span className="block text-[10px] font-normal text-zinc-500 max-w-64 truncate">{p.note}</span> : null}
                </td>
                <td className={`px-2 py-1 font-mono ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <div className="flex gap-1">
                    {p.state === 'armed' && (
                      <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'cancel', id: p.id })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Cancel</button>
                    )}
                    {(p.state === 'open' || p.state === 'broken') && (
                      <button type="button" disabled={busy || !!p.exitWanted} onClick={() => void post({ action: 'pair', op: 'exit', id: p.id })}
                        title={p.state === 'broken' ? 'Exit what is left of this pair at market' : 'Exit both legs at market'}
                        className="px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40">
                        {p.exitWanted ? 'Exiting…' : p.state === 'broken' ? 'Exit remaining' : 'Exit both'}
                      </button>
                    )}
                    {/* UNKNOWN: the user checks Orders / Positions and says what each unknown leg really is. */}
                    {p.state === 'unknown' && unknownLegs.map(k => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <span className="text-[10px] font-bold text-red-400">{k.toUpperCase()}</span>
                        <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'resolve', id: p.id, leg: k, outcome: 'open' })}
                          title={p.legs[k].unknown === 'entry' ? 'You checked Positions: this leg filled — track it' : 'You checked Positions: this leg is still open — send its exit again'}
                          className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">It is open</button>
                        <button type="button" disabled={busy} onClick={() => void post({ action: 'pair', op: 'resolve', id: p.id, leg: k, outcome: 'flat' })}
                          title={p.legs[k].unknown === 'entry' ? 'You checked Positions: nothing opened on this leg' : 'You checked Positions: this leg is closed'}
                          className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white">Nothing open</button>
                      </span>
                    ))}
                    {p.state === 'open' && (
                      <span className="inline-flex rounded border border-zinc-700 overflow-hidden">
                        <button type="button" disabled={busy} onClick={() => onLots(p, 1)} title="Add 1 lot to both legs at market (joins this pair's target / SL)" aria-label={`Add 1 lot to ${pairName(p)}`}
                          className="px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40">+1</button>
                        <button type="button" disabled={busy} onClick={() => onLots(p, -1)} title="Exit 1 lot of both legs at market" aria-label={`Exit 1 lot of ${pairName(p)}`}
                          className="px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 border-l border-zinc-700 disabled:opacity-40">−1</button>
                      </span>
                    )}
                    {p.state === 'open' && <PairRollControl p={p} busy={busy} onRoll={onRoll} />}
                    {(p.state === 'open' || p.state === 'armed') && (
                      <span className="inline-flex items-center gap-1" title="Per-leg stop %: either leg moving this far against its own fill exits both legs (0 = off)">
                        <span className="text-[11px] text-zinc-400">Leg SL%</span>
                        <NumField label="Per-leg stop-loss percent (0 = off)" value={p.legSlPct ?? 0} min={0} max={1000} step={5} width="w-14"
                          onCommit={v => { if (v !== (p.legSlPct ?? 0)) void post({ action: 'pair', op: 'legsl', id: p.id, legSlPct: Math.round(v) }); }} />
                      </span>
                    )}
                    {(p.state === 'open' || p.state === 'armed') && p.bracket && <PairTrailControl p={p} busy={busy} post={post} fallback={trailPts} />}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One REAL leg's order status, short: "CE 65 @ 120.50", "PE rejected", "CE UNKNOWN", "PE exit sent". */
function legStatus(k: PairLegKey, l: PairLeg): string {
  const K = k.toUpperCase();
  if (l.unknown) return `${K} UNKNOWN (${l.unknown})`;
  if (l.entry === 'dead') return `${K} rejected${l.note ? `: ${l.note}` : ''}`;
  if (l.entry === 'sent') return `${K} sent`;
  if (l.exitOrderId || l.exitSentAt) return `${K} exit sent`;
  const held = l.held ?? 0;
  const bits = [held > 0 ? `${held} held` : (l.exitedQty ?? 0) > 0 ? 'flat' : '', l.avg ? `@ ${l.avg.toFixed(2)}` : '', l.outside ? '(closed outside)' : ''].filter(Boolean);
  return `${K} ${bits.join(' ') || '—'}`;
}

/** Shift both legs / roll one leg of an open pair N strikes up (+) or down (−). */
function PairRollControl({ p, busy, onRoll }: { p: LadderPair; busy: boolean; onRoll: (p: LadderPair, legs: 'both' | 'ce' | 'pe', steps: number) => void }) {
  const [legs, setLegs] = useState<'both' | 'ce' | 'pe'>('both');
  const [steps, setSteps] = useState(1);
  const btn = `px-1.5 py-0.5 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 ${FOCUS_RING}`;
  return (
    <span className="inline-flex items-center gap-1" title="Shift both legs, or roll one leg, by N strikes: the old leg closes first, then the new strike opens">
      <select aria-label="What to roll" value={legs} onChange={e => setLegs(e.target.value as 'both' | 'ce' | 'pe')}
        className="px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-[11px] text-zinc-200">
        <option value="both">Shift</option>
        <option value="ce">Roll CE</option>
        <option value="pe">Roll PE</option>
      </select>
      <NumField label="Strikes to roll" value={steps} min={1} max={20} width="w-12" onCommit={v => setSteps(Math.max(1, Math.min(20, Math.round(v))))} />
      <span className="inline-flex rounded border border-zinc-700 overflow-hidden">
        <button type="button" disabled={busy} className={btn} aria-label={`${legs === 'both' ? 'Shift' : `Roll ${legs.toUpperCase()}`} up ${steps} strike(s)`} title={`Up ${steps} strike(s)`} onClick={() => onRoll(p, legs, steps)}>↑</button>
        <button type="button" disabled={busy} className={`${btn} border-l border-zinc-700`} aria-label={`${legs === 'both' ? 'Shift' : `Roll ${legs.toUpperCase()}`} down ${steps} strike(s)`} title={`Down ${steps} strike(s)`} onClick={() => onRoll(p, legs, -steps)}>↓</button>
      </span>
    </span>
  );
}

/** A pair's continuous trailing SL (combined-premium points): edit = set, 0 / Off = off. */
function PairTrailControl({ p, busy, post, fallback }: { p: LadderPair; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; fallback: number }) {
  const cur = p.bracket?.trailPts ?? 0;
  const send = (trailPts: number) => void post({ action: 'pair', op: 'trail', id: p.id, trailPts });
  if (!cur) {
    return (
      <button type="button" disabled={busy} onClick={() => send(fallback)} title={`Trail the SL ${fallback} points of combined premium behind the best level from now on`}
        className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>
        Trail {fallback}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1" title={`Continuous trailing SL, ${cur} pts of combined premium behind the best level`}>
      <span className="text-amber-300 text-[11px]">Trail</span>
      <NumField label="Pair trailing SL distance in points" value={cur} min={0} width="w-14" onCommit={v => { if (v !== cur) send(v); }} />
      <button type="button" disabled={busy} onClick={() => send(0)} className={`px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white ${FOCUS_RING}`}>Off</button>
    </span>
  );
}
