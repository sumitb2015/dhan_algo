'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Rows3, Crosshair, AlertTriangle, ShieldAlert, Trash2, Briefcase, ClipboardList, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import NavBar from '@/components/NavBar';
import { BrokerPicker, usePageBroker } from '@/components/BrokerPicker';
import { BROKER_LABELS, scalperRoute } from '@/hooks/useBrokerSelector';
import OrdersTradesModal from '@/components/multiLegFocus/OrdersTradesModal';
import { FOCUS_RING } from '@/components/Scalper';
import type { BrokerPortfolio } from '@/app/api/dashboard/portfolio/route';
import { LadderGrid, type EntryMark, widgetsFor, type LadderWidget } from '@/components/priceLadder/LadderGrid';
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';
import {
  MAX_LADDER_LOTS, MCX_LADDER_UNDERLYINGS, isMcxUnderlying, sessionFor, spotKeyUnderlying, istDay, isLive, limitZone, ownNet, sliceNowPnl, sumSlicePnl, classifyClick,
  type ClickType, type LadderBroker, type LadderMode, type LadderSide, type LadderSlice, type LadderState, type OptType,
  type LadderContract,
} from '@/lib/priceLadder';

// Price Ladder (/price-ladder). XY mode trades an option on the INDEX's levels (OptionX "Price Ladder XY"): click a
// level to arm an entry, with a bracket target / SL / trailing SL in index points. The dashboard SERVER watches and
// fires them (lib/priceLadderServer.ts), so closing this tab does not disarm anything. Plain mode is a one-click
// LIMIT / SL ladder on the option's own premium. This component only draws and asks; every rule and check is server-side.

/** Index underlyings, then the MCX ones the ladder trades (MCX_LADDER_UNDERLYINGS — Dhan only). */
const UNDERLYINGS: readonly string[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', ...MCX_LADDER_UNDERLYINGS];
/** Accounts the ladder can trade on. Prices always come from Dhan; only orders, positions and order books are per broker. */
const LADDER_BROKERS = ['dhan', 'kotak', 'zerodha'] as const;
const STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, CRUDEOILM: 50 };
const XY_TICKS = [1, 5, 10, 25];
const PLAIN_TICKS = [0.05, 0.5, 1];
const ROWS = 31;
const POLL_MS = 1000;

interface SpotView { spot: number; at: number; source: string; fresh: boolean }
interface StateResp {
  state: LadderState; spots: Record<string, SpotView>; ltps: Record<string, number>; liveArmed: boolean; now: number;
  /** Where the page's XY axis sits in `spots`: the index name, or for MCX the option month's futures contract. */
  spotKey?: string | null;
  /** Why the selected contract could not be resolved (e.g. no MCX futures month), or null. */
  contractError?: string | null;
  /** The selection this reply describes. */
  request?: { underlying: string; expiry: string; strike: number | null; opt: string | null };
  contract: { securityId: string; lotSize: number; ltp: number | null; mult?: number; refExpiry?: string } | null;
}
interface IndexQuote { ltp: number; prev_close: number; change_pct: number | null; day_high: number | null; day_low: number | null }

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); if (v && (allowed as readonly string[]).includes(v)) return v as T; } catch { /* none */ }
  return fallback;
}
function savePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* best effort */ } }

/** A number box that commits on blur / Enter only (dhan-commit-on-blur), so a half-typed value never reaches a rule. */
function NumField({ value, onCommit, min, max, step, label, width = 'w-16' }: {
  value: number; onCommit: (v: number) => void; min: number; max?: number; step?: number; label: string; width?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft);
    if (Number.isFinite(n) && n >= min && (max == null || n <= max)) onCommit(n);
    setDraft(null);
  };
  return (
    <input
      aria-label={label} inputMode="decimal" step={step}
      className={`${width} px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500`}
      value={draft ?? String(value)}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setDraft(null); }}
    />
  );
}

function Seg<T extends string>({ value, options, onChange, labels, disabled }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
      {options.map(o => (
        <button
          key={o} type="button" disabled={disabled} onClick={() => onChange(o)}
          className={`px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${value === o ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}
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

export default function PriceLadder() {
  const [broker, setBroker, brokerLoaded] = usePageBroker<LadderBroker>('price-ladder-broker', LADDER_BROKERS);
  const [mode, setModeRaw] = useState<LadderMode>('xy');
  const [real, setReal] = useState(false);               // per page load, never persisted
  const [realAck, setRealAck] = useState(false);         // first REAL click this page load asks first
  const [confirm, setConfirm] = useState<null | { text: string; run: () => void }>(null);
  const [armModal, setArmModal] = useState(false);
  const [underlying, setUnderlyingRaw] = useState<string>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [strikes, setStrikes] = useState<number[]>([]);
  const [strike, setStrike] = useState<number | null>(null);
  const [opt, setOpt] = useState<OptType>('CE');
  const [side, setSide] = useState<LadderSide>('BUY');
  const [product, setProduct] = useState<'NRML' | 'MIS'>('MIS');
  const [orderType, setOrderType] = useState<ClickType>('LIMIT');
  const [style, setStyle] = useState<'Single' | 'Bracket' | 'Cover'>('Bracket');
  const [tgtPts, setTgtPts] = useState(40);
  const [slPts, setSlPts] = useState(30);
  const [trailOn, setTrailOn] = useState(false);
  const [trailPts, setTrailPts] = useState(10);
  const [lots, setLots] = useState(1);
  const [tick, setTick] = useState(5);
  const [center, setCenter] = useState(0);
  const [follow, setFollow] = useState(true);
  // The user scrolled the ladder away: hold the window where they put it until Centre / Follow price.
  const [manual, setManual] = useState(false);
  const [data, setData] = useState<StateResp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, IndexQuote>>({});
  // Change and day range come from top-indices, whose CRUDEOILM row is the FRONT futures month — not the option month's
  // futures on this ladder's axis — so MCX shows neither rather than mix two contracts.
  const indexQ = isMcxUnderlying(underlying) ? null : quotes[underlying] ?? null;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const lastEventAt = useRef<number>(0);

  // Preferences (after mount: the first render must match the server HTML).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setModeRaw(readPref('price-ladder-mode', ['xy', 'plain'] as const, 'xy'));
    setUnderlyingRaw(readPref('price-ladder-underlying', UNDERLYINGS, 'NIFTY'));
    /* eslint-enable react-hooks/set-state-in-effect */
    return installAlertSoundUnlock();
  }, []);
  const setMode = (m: LadderMode) => { setModeRaw(m); savePref('price-ladder-mode', m); setTick(m === 'xy' ? 5 : 0.05); setFollow(true); setManual(false); };
  // The expiry is cleared too: the old underlying's date must not be asked of the new one's chain for a render.
  const setUnderlying = (u: string) => { setUnderlyingRaw(u); savePref('price-ladder-underlying', u); setExpiry(''); setExpiries([]); setStrike(null); setCenter(0); setFollow(true); setManual(false); };

  // The indices feed is the XY ladder's spot source; the server falls back to a paced REST quote if it is down.
  useEffect(() => {
    fetch('/api/live-indices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => {});
  }, []);

  // Expiries -> strikes (the chain gives the strike list and an ATM to start on).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (cancelled) return;
        if (j.success && j.data?.length) { setExpiries(j.data); setExpiry(prev => (j.data!.includes(prev) ? prev : j.data![0])); }
        else setLoadError(`Could not load ${underlying} expiries`);
      })
      .catch(() => { if (!cancelled) setLoadError(`Could not load ${underlying} expiries`); });
    return () => { cancelled = true; };
  }, [underlying]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain?: { oc?: Record<string, { ce?: { last_price?: number }; pe?: { last_price?: number } }> }; spot?: number; future_price?: number } }) => {
        if (cancelled) return;
        const oc = j.data?.chain?.oc;
        if (!j.success || !oc) { setLoadError(`Could not load the ${underlying} option chain`); return; }
        const list = Object.keys(oc).map(Number).filter(n => n > 0).sort((a, b) => a - b);
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
      .catch(() => { if (!cancelled) setLoadError(`Could not load the ${underlying} option chain`); });
    return () => { cancelled = true; };
  }, [underlying, expiry]);

  // Ladder state + spot + the shown contract's LTP, once a second. Out-of-order replies are dropped. One request per
  // selection at a time: a reply can take longer than the 1 s tick (an MCX contract waits on the shared quote lane), and
  // starting a new poll every tick would make every reply "out of order" and the page would never update.
  const seq = useRef(0);
  const pollInFlight = useRef<string | null>(null);
  const poll = useCallback(async () => {
    const key = `${underlying}|${expiry}|${strike}|${opt}`;
    if (pollInFlight.current === key) return;
    pollInFlight.current = key;
    const my = ++seq.current;
    const q = new URLSearchParams({ underlying });
    if (expiry && strike) { q.set('expiry', expiry); q.set('strike', String(strike)); q.set('opt', opt); }
    try {
      const r = await fetch(`/api/price-ladder/state?${q}`, { cache: 'no-store' });
      const j = await r.json() as { success: boolean; data?: StateResp; error?: string };
      if (my !== seq.current) return;
      if (!j.success || !j.data) { setLoadError(j.error ?? 'Could not read the ladder'); return; }
      setData(j.data);
      setLoadError(null);
    } catch {
      if (my === seq.current) setLoadError('Could not reach the dashboard server');
    } finally {
      if (pollInFlight.current === key) pollInFlight.current = null;
    }
  }, [underlying, expiry, strike, opt]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void poll();
    const t = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(t);
  }, [poll]);

  // Index card: change and day range.
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/scalper/top-indices').then(r => r.json()).then((j: { quotes?: Record<string, IndexQuote> }) => {
      if (!cancelled) setQuotes(j.quotes ?? {});
    }).catch(() => {});
    void load();
    const t = setInterval(load, 3000);
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
        const r = await fetch(`/api/dashboard/portfolio?broker=${broker}`, { cache: 'no-store' });
        const j = await r.json() as { success?: boolean; brokers?: BrokerPortfolio[] };
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
    if (fresh.some(e => /filled|Exited|SIM exit|UNKNOWN|rejected/i.test(e.msg))) playAlertChime();
    for (const e of fresh) if (e.level === 'error') toast.error(e.msg);
  }, [data?.state.events]);

  const mcx = isMcxUnderlying(underlying);
  // The reply describes the selection on screen (it can lag one poll behind an expiry / strike / underlying switch).
  // Anything tied to the contract — its LTP, lot, and for MCX the futures month on the axis — is read only from a
  // matching reply; until then the ladder shows no price and cannot place.
  const rq = data?.request;
  const matches = !!rq && rq.underlying === underlying && rq.expiry === expiry && rq.strike === strike && rq.opt === opt;
  const shownC = matches ? data?.contract ?? null : null;
  const axisKey = mcx
    ? (matches && data?.spotKey && spotKeyUnderlying(data.spotKey) === underlying ? data.spotKey : null)
    : underlying;
  const spotView = axisKey ? data?.spots[axisKey] : undefined;
  const axisName = mcx ? `${underlying} FUT${shownC?.refExpiry ? ` ${shownC.refExpiry}` : ''}` : underlying;
  const contractError = matches ? data?.contractError ?? null : null;
  const sessionNote = sessionFor(underlying, istDay()).note ?? null;
  // MCX on the ladder is Dhan only (the server refuses the others too).
  const brokerUnsupported = mcx && broker !== 'dhan';
  const spot = spotView?.spot ?? 0;
  const spotFreshNow = !!spotView?.fresh;
  const optLtp = shownC?.ltp ?? 0;
  const lotSize = shownC?.lotSize ?? null;
  const securityId = shownC?.securityId ?? null;
  const refPrice = mode === 'xy' ? spot : optLtp;

  // Keep the ladder centred on the reference price while following; re-centre when it walks off the visible window.
  useEffect(() => {
    if (!(refPrice > 0)) return;
    const half = Math.floor(ROWS / 2) * tick;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (follow || center === 0 || (!manual && Math.abs(refPrice - center) > half * 0.8)) setCenter(refPrice);
  }, [refPrice, follow, manual, tick, center]);
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
  // Where each open position was entered, on the ladder's own axis (index level in XY, fill premium in plain).
  const entryMarks = useMemo(() => {
    const marks: EntryMark[] = [];
    for (const s of mine) {
      const held = Number(s.filledQty) || 0;
      if ((s.state !== 'open' && s.state !== 'exiting') || held <= 0) continue;
      const y = mode === 'xy' ? (s.kind === 'xy' ? s.entryY ?? s.entryLevel : undefined) : s.avg;
      if (y && Number.isFinite(y)) marks.push({ y, side: s.side, qty: held, avg: s.avg });
    }
    return marks;
  }, [mine, mode]);
  const net = securityId ? ownNet(slices.filter(s => s.broker === broker && s.mode === pageMode), securityId) : { qty: 0, avg: null };
  const contractPnl = useMemo(() => sumSlicePnl(slices, s => s.broker === broker && s.mode === pageMode && s.contract.securityId === securityId, () => optLtp),
    [slices, broker, pageMode, securityId, optLtp]);
  // The ladder's own P&L across every contract, for this broker and the page's SIM/REAL mode (open legs at live LTP).
  const ladderPnl = useMemo(() => sumSlicePnl(slices, s => s.broker === broker && s.mode === pageMode, s => data?.ltps[s.contract.securityId]),
    [slices, broker, pageMode, data?.ltps]);

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
        setData(d => (d ? { ...d, state: j.data!.state! } : d));
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

  const send = useCallback((side: LadderSide, price: number) => {
    if (!expiry || !strike) return;
    void post({
      action: 'arm', kind: mode, broker, mode: real ? 'real' : 'sim', underlying, expiry, strike, opt, side, lots, product,
      orderType, level: price,
      // Cover = SL only (tgtPts 0), as OptionX's Cover order; Bracket = target + SL.
      ...(mode === 'xy' && style !== 'Single' ? { bracket: { tgtPts: style === 'Cover' ? 0 : tgtPts, slPts, ...(trailOn ? { trailPts } : {}) } } : {}),
    }).then(ok => { if (ok) toast.success(`${real ? 'REAL' : 'SIM'} ${side} ${mode === 'xy' ? 'armed at' : 'placed at'} ${price}`); });
  }, [post, mode, broker, real, underlying, expiry, strike, opt, lots, product, orderType, style, tgtPts, slPts, trailOn, trailPts]);

  const onPlace = (side: LadderSide, price: number) => {
    // Same verdict the server applies, shown before the click costs a round trip.
    const v = classifyClick({ mode, opt, side, level: price, ref: refPrice, orderType });
    if (!v.ok) { toast.warning(v.error); return; }
    if (real && !realAck) {
      const what = mode === 'xy'
        ? `${side} ${lots} lot(s) ${underlying} ${strike}${opt} at MARKET when ${underlying} ${v.dir === 'below' ? 'falls to' : 'rises to'} ${price}`
        : `${v.kind === 'limit' ? 'LIMIT' : 'SL'} ${side} ${lots} lot(s) ${underlying} ${strike}${opt} at ${price}`;
      setConfirm({ text: what, run: () => send(side, price) });
      return;
    }
    send(side, price);
  };

  // Drag-to-modify (OptionX): an armed entry moves its level; an open bracket moves its target or SL. The server re-checks
  // every rule (a LIMIT entry cannot be dragged across spot into a breakout; target/SL must stay on their side of spot).
  const onMove = (ids: string[], what: 'entry' | 'tgt' | 'sl', price: number) => {
    void post({ action: 'modify', id: ids[0], ...(what === 'entry' ? { level: price } : { ids, ...(what === 'tgt' ? { tgtY: price } : { slY: price }) }) })
      .then(ok => { if (ok) toast.success(`${what === 'entry' ? 'Entry' : what === 'tgt' ? 'Target' : 'SL'} moved to ${price}`); });
  };

  // The + / − on a ladder widget. An unfilled order changes its lots in place (− stops at 1 lot: × cancels). An open
  // position: − exits one lot at market (never confirmed — it only reduces), + adds one lot at market under the same
  // target / SL — an opening order, so on REAL the first one this page load asks first, like a ladder click.
  const onAdjust = (w: LadderWidget, delta: 1 | -1) => {
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
  const pendingHere = mine.filter(s => (s.state === 'armed' || s.state === 'working') && s.mode === pageMode).length;

  const stale = mode === 'xy' && !spotFreshNow;
  const placeDisabled = busy || !brokerLoaded || !strike || !(refPrice > 0) || realBlocked || brokerUnsupported || (mode === 'xy' && stale);
  const decimals = mode === 'xy' ? (tick < 1 ? 2 : 0) : 2;
  const ticks = mode === 'xy' ? XY_TICKS : PLAIN_TICKS;
  const dataDate = data ? data.state.date : null;
  const optLabel = strike ? `${underlying} ${expiry} ${strike} ${opt}` : `${underlying} —`;
  const live = slices.filter(isLive);
  const done = slices.filter(s => !isLive(s));

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

  // Auto-focus the contract of the newest live trade on first load so the user immediately sees it. It never switches
  // the page into REAL on its own: it prefers a trade in the page's mode (SIM on load) and otherwise shows the contract
  // only — the REAL chip in Active Trades switches mode with a click.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (autoFocusedRef.current || !data) return;
    const liveSlices = data.state.slices.filter(isLive);
    if (!liveSlices.length) return;
    const sameMode = liveSlices.filter(x => x.mode === (real ? 'real' : 'sim'));
    const latest = (sameMode.length ? sameMode : liveSlices)[(sameMode.length ? sameMode : liveSlices).length - 1];
    if (!latest.contract) return;
    autoFocusedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot on first data, guarded by autoFocusedRef
    selectContract({ contract: latest.contract, broker: latest.broker });
  }, [data, real, selectContract]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="flex items-center justify-between gap-3 flex-wrap px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Rows3 className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">PRICE LADDER · {mode === 'xy' ? 'XY' : 'PLAIN'}</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              {axisName} <span className="font-mono">{spot ? spot.toFixed(2) : '—'}</span>
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              {mode === 'xy' ? `Trade the option on ${mcx ? 'its futures month\'s' : 'index'} levels — the server fires armed levels with this tab closed` : 'One-click LIMIT / SL orders on the option premium'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <BrokerPicker value={broker} onChange={setBroker} disabled={busy} brokers={LADDER_BROKERS} />
          <Seg value={real ? 'REAL' : 'SIM'} options={['SIM', 'REAL'] as const} onChange={v => { setReal(v === 'REAL'); setRealAck(false); }} />
          <button
            type="button" onClick={() => (liveArmed ? void post({ action: 'live', on: false }) : setArmModal(true))}
            className={`px-2.5 py-1 rounded-md text-xs font-bold border transition-colors ${liveArmed ? 'bg-red-600 border-red-500 text-oncolor' : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white'}`}
          >
            {liveArmed ? 'LIVE · REAL MONEY ON' : 'Arm LIVE · REAL MONEY'}
          </button>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate ?? '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>
      {/* Market + P&L + broker book strip */}
      <div className="flex items-center gap-2 flex-wrap px-6 pb-2.5 text-xs">
        <QuoteChip label="NIFTY" q={quotes.NIFTY} />
        <QuoteChip label="INDIA VIX" q={quotes.VIX} />
        <span className="w-px h-5 bg-zinc-800 shrink-0" />
        <PnlChip label={`Ladder P&L · ${real ? 'REAL' : 'SIM'}`} value={ladderPnl}
          title={`The ladder's own P&L on ${BROKER_LABELS[broker]}, every contract, ${real ? 'REAL' : 'SIM'} orders only: closed at their exit, open at the live LTP, since entry (a carried NRML position counts from its entry). '—' if an open leg has no price.`} />
        <PnlChip label={`${BROKER_LABELS[broker]} P&L`} value={acct.pnl}
          title={`${BROKER_LABELS[broker]} account P&L today: realised + unrealised over all positions, as the broker reports it (includes trades not made on the ladder)${acct.note ? ` — ${acct.note}` : ''}`} />
        {acct.note && <span className="text-amber-300 truncate max-w-[18rem]" title={acct.note}>{acct.note}</span>}
        <span className="w-px h-5 bg-zinc-800 shrink-0" />
        <BookButton icon={<Briefcase className="w-3.5 h-3.5" />} label="Positions" count={acct.open} onClick={() => setBookOpen('positions')} />
        <BookButton icon={<ClipboardList className="w-3.5 h-3.5" />} label="Order book" onClick={() => setBookOpen('orders')} />
        <BookButton icon={<ReceiptText className="w-3.5 h-3.5" />} label="Trade book" onClick={() => setBookOpen('trades')} />
      </div>
      </div>
      {bookOpen && (
        <OrdersTradesModal
          isOpen
          readOnly
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
        {stale && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" /> {axisName} {mcx ? 'price' : 'spot'} is stale{spotView ? ` (last ${timeOf(spotView.at)}, ${spotView.source})` : ''} — {mcx ? 'futures' : 'index'} levels are paused until it updates.
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
        {brokerUnsupported && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4" /> {underlying} trades on Dhan only in the Price Ladder — switch the broker to Dhan to place orders.
          </div>
        )}
        {realBlocked && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-300">
            <ShieldAlert className="w-4 h-4" /> REAL mode: arm LIVE · REAL MONEY for today before placing. Exits always work.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4">
          {/* ── left panel ── */}
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <p className="text-xs font-bold text-white">{optLabel}</p>
              <p className="text-lg font-mono font-bold text-zinc-100">{optLtp ? optLtp.toFixed(2) : '—'}</p>
              <div className="mt-2 pt-2 border-t border-zinc-800 text-xs">
                <p className="font-bold text-zinc-300">{axisName} <span className="font-mono text-zinc-100">{spot ? spot.toFixed(2) : '—'}</span>
                  {indexQ?.change_pct != null && <span className={`ml-2 font-mono ${indexQ.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{indexQ.change_pct >= 0 ? '+' : ''}{indexQ.change_pct.toFixed(2)}%</span>}
                </p>
                <p className="font-mono text-zinc-500 mt-0.5">H {indexQ?.day_high?.toFixed(2) ?? '—'} · L {indexQ?.day_low?.toFixed(2) ?? '—'}</p>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 grid grid-cols-2 gap-y-1 text-xs">
              <span className="text-zinc-400">Net Pos <span className="text-zinc-500">({pageMode.toUpperCase()})</span></span><span className="font-mono text-right text-zinc-100">{net.qty}</span>
              <span className="text-zinc-400">P&amp;L</span><span className={`font-mono text-right ${pnlClass(contractPnl)}`}>{fmtMoney(contractPnl)}</span>
              <span className="text-zinc-400">Avg Price</span><span className="font-mono text-right text-zinc-100">{net.avg ? net.avg.toFixed(2) : '—'}</span>
              <div className="col-span-2 flex gap-1 mt-2">
                {[25, 50, 75, 100].map(p => (
                  <button
                    key={p} type="button" disabled={busy || net.qty === 0}
                    onClick={() => void post({ action: 'exit', securityId, broker, mode: pageMode, pct: p })}
                    className="flex-1 px-1 py-1 rounded text-xs font-bold border border-red-500/40 text-red-300 hover:bg-red-500/15 disabled:opacity-40"
                  >
                    {p === 100 ? `Exit (${net.qty})` : `${p}%`}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between"><span className="text-zinc-400">Ladder</span>
                <Seg value={mode} options={['xy', 'plain'] as const} labels={{ xy: 'XY (index)', plain: 'Plain' }} onChange={setMode} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Product</span>
                <Seg value={product} options={['NRML', 'MIS'] as const} onChange={setProduct} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Underlying</span>
                <select aria-label="Underlying" value={underlying} onChange={e => setUnderlying(e.target.value)} className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-100">
                  {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Expiry</span>
                <select aria-label="Expiry" value={expiry} onChange={e => { setExpiry(e.target.value); setStrike(null); }} className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-100">
                  {expiries.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between gap-2"><span className="text-zinc-400">Strike</span>
                <div className="flex items-center gap-2">
                  <select aria-label="Strike" value={strike ?? ''} onChange={e => setStrike(Number(e.target.value))} className="px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 font-mono">
                    {strikes.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <Seg value={opt} options={['CE', 'PE'] as const} labels={{ CE: 'Call', PE: 'Put' }} onChange={setOpt} />
                </div>
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Order Type</span>
                <Seg value={orderType} options={['LIMIT', 'SL'] as const} labels={{ LIMIT: 'Limit', SL: 'SL' }} onChange={setOrderType} />
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-400">Side</span>
                <div className="grid grid-cols-2 gap-1.5 w-32">
                  <button
                    type="button"
                    onClick={() => setSide('BUY')}
                    className={`py-1 rounded text-xs font-bold transition-all ${side === 'BUY' ? 'bg-emerald-600 text-oncolor shadow' : 'bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    onClick={() => setSide('SELL')}
                    className={`py-1 rounded text-xs font-bold transition-all ${side === 'SELL' ? 'bg-red-600 text-oncolor shadow' : 'bg-zinc-900 border border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                  >
                    Sell
                  </button>
                </div>
              </div>
              {mode === 'xy' && (
                <>
                  <div className="flex items-center justify-between"><span className="text-zinc-400">Style</span>
                    <Seg value={style} options={['Single', 'Bracket', 'Cover'] as const} onChange={setStyle} />
                  </div>
                  {style !== 'Single' && (
                    <div className="grid grid-cols-2 gap-2 items-center">
                      {style === 'Bracket' && <><span className="text-zinc-400">Target pts</span><NumField label="Target points" value={tgtPts} onCommit={setTgtPts} min={1} /></>}
                      <span className="text-zinc-400">SL pts</span><NumField label="Stop-loss points" value={slPts} onCommit={setSlPts} min={1} />
                      <label className="flex items-center gap-1.5 text-zinc-400">
                        <input type="checkbox" checked={trailOn} onChange={e => setTrailOn(e.target.checked)} /> Trail every
                      </label>
                      <NumField label="Trailing step points" value={trailPts} onCommit={setTrailPts} min={1} />
                    </div>
                  )}
                </>
              )}
              <div className="flex items-center justify-between"><span className="text-zinc-400">Lots {lotSize ? <span className="text-zinc-500">({mcx ? `${lots * (shownC?.mult ?? 1)} bbl` : `${lots * lotSize} qty`})</span> : null}</span>
                <div className="flex items-center gap-1">
                  <NumField label="Lots" value={lots} onCommit={v => setLots(Math.min(MAX_LADDER_LOTS, Math.max(1, Math.round(v))))} min={1} max={MAX_LADDER_LOTS} width="w-14" />
                  {[1, 5, 10].map(n => (
                    <button key={n} type="button" onClick={() => setLots(l => Math.min(MAX_LADDER_LOTS, l + n))} className="px-1.5 py-1 rounded border border-zinc-700 text-zinc-300 hover:text-white">+{n}</button>
                  ))}
                  <button type="button" onClick={() => setLots(1)} className="px-1.5 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-white">Clear</button>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              {mode === 'xy'
                ? `Click the Buy or Sell column at an index level. ${opt === 'PE' ? 'Put: the ladder is inverted — a Buy is a limit ABOVE spot. ' : ''}Limit = the option is cheaper/dearer at that level; the other side needs SL (breakout). The option order goes at MARKET when ${axisName} crosses the level.`
                : 'Click Buy below LTP or Sell above it for a LIMIT; the other side places an SL-M stop. Orders rest at the broker.'}
            </p>
          </div>

          {/* ── ladder ── */}
          <div className="flex flex-col gap-2 min-w-0">
            {live.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap px-2.5 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs">
                <span className="text-zinc-400 font-semibold flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Active Trades:
                </span>
                {live.map(s => {
                  const isCur = s.contract.securityId === securityId && s.broker === broker && s.mode === pageMode;
                  return (
                    <button
                      key={s.id} type="button"
                      onClick={() => selectContract(s)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition-colors ${isCur ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 font-bold shadow-sm' : 'bg-zinc-800/90 border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500'}`}
                    >
                      <span>{s.contract.underlying} {s.contract.strike}{s.contract.opt}</span>
                      <span className="text-[10px] text-zinc-400">({s.mode.toUpperCase()} · {s.qty})</span>
                      {!isCur && <span className="text-[10px] text-amber-300 underline font-sans ml-0.5">View on ladder</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className="text-zinc-400">Tick</span>
              <Seg value={String(tick)} options={ticks.map(String)} onChange={v => setTick(Number(v))} />
              <button type="button" onClick={() => { setFollow(true); setManual(false); setCenter(refPrice); }} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white">
                <Crosshair className="w-3.5 h-3.5" /> Centre
              </button>
              <label className="flex items-center gap-1.5 text-zinc-400"><input type="checkbox" checked={follow} onChange={e => { setFollow(e.target.checked); if (e.target.checked) setManual(false); }} /> Follow price</label>
              <button
                type="button" disabled={busy || pendingHere === 0}
                onClick={() => void post({ action: 'cancelAll', securityId, broker, mode: pageMode })}
                className="px-2 py-1 rounded-md border border-zinc-700 text-zinc-300 hover:text-white disabled:opacity-40"
              >
                Cancel all ({pendingHere})
              </button>
              <span className="ml-auto text-zinc-500">{real ? <span className="font-bold text-red-400">REAL</span> : <span className="font-bold text-zinc-300">SIM</span>} · {BROKER_LABELS[broker]}</span>
            </div>
            <LadderGrid
              center={center} refPrice={refPrice} tick={tick} rows={ROWS}
              widgets={widgetsFor(mine, mode)}
              limitZoneBuy={limitZone(mode, opt, 'BUY')}
              onPlace={onPlace} onCancel={id => void post({ action: 'cancel', id })} onMove={onMove} onAdjust={onAdjust}
              disabled={placeDisabled} decimals={decimals} entryMarks={entryMarks}
              onScroll={refPrice > 0 ? scrollLadder : undefined}
            />
          </div>
        </div>

        {/* ── orders ── */}
        <div className="rounded-lg border border-zinc-800 overflow-x-auto">
          <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/40">
            <p className="text-xs font-bold text-white">Ladder orders &amp; positions <span className="text-zinc-500 font-medium">({live.length} live)</span></p>
            {done.length > 0 && (
              <button type="button" onClick={() => void post({ action: 'clear' })} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
                <Trash2 className="w-3.5 h-3.5" /> Clear finished
              </button>
            )}
          </div>
          {slices.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">No ladder orders today. Click a price on the ladder to place one.</p>
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
                {[...slices].reverse().map(s => <SliceRow key={s.id} s={s} ltp={data?.ltps[s.contract.securityId]} busy={busy} post={post} trailPts={trailPts} onSelect={selectContract} />)}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-lg border border-zinc-800 p-3">
          <p className="text-xs font-bold text-white mb-2">Events</p>
          <div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto font-mono text-[11px]">
            {(data?.state.events ?? []).slice(-60).reverse().map((e, i) => (
              <p key={`${e.at}-${i}`} className={e.level === 'error' ? 'text-red-400' : e.level === 'warn' ? 'text-amber-300' : 'text-zinc-400'}>
                {timeOf(e.at)} {e.msg}
              </p>
            ))}
            {!data?.state.events.length && <p className="text-zinc-500">Nothing yet.</p>}
          </div>
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">Place a REAL-money order?</p>
            <p className="text-xs text-zinc-300">{confirm.text} on {BROKER_LABELS[broker]}.</p>
            <p className="text-[11px] text-zinc-500">Further clicks on this page load go straight through.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { const c = confirm; setConfirm(null); setRealAck(true); c.run(); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">Place REAL order</button>
            </div>
          </div>
        </div>
      )}
      {armModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 flex flex-col gap-3">
            <p className="text-sm font-bold text-white">Arm LIVE · REAL MONEY for today?</p>
            <p className="text-xs text-zinc-300">REAL ladder orders will place real orders on your broker account. Armed index levels are fired by the dashboard server even with this tab closed, until {sessionFor(underlying, istDay()).autoExitLabel} IST{mcx ? ` (${underlying}, today)` : ''}.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setArmModal(false)} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs text-zinc-300">Cancel</button>
              <button type="button" onClick={() => { setArmModal(false); void post({ action: 'live', on: true }); }} className="px-3 py-1.5 rounded-md bg-red-600 text-xs font-bold text-oncolor">Arm for today</button>
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

function SliceRow({ s, ltp, busy, post, trailPts, onSelect }: { s: LadderSlice; ltp: number | undefined; busy: boolean; post: (b: Record<string, unknown>) => Promise<boolean>; trailPts: number; onSelect?: (s: LadderSlice) => void }) {
  const live = isLive(s);
  const pnl = sliceNowPnl(s, ltp) ?? null;
  const qty = Number(s.filledQty) || s.qty;
  const trig = s.kind === 'xy'
    ? (s.entryLevel ? `${s.contract.underlying} ${s.entryDir === 'below' ? '≤' : '≥'} ${s.entryLevel}` : '—')
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
          {/* Auto trailing SL, switched on any time (the video enables it after the entry fills), with the panel's step. */}
          {(s.state === 'open' || s.state === 'armed') && s.bracket && (
            <button type="button" disabled={busy} onClick={() => void post({ action: 'trail', id: s.id, trailPts: s.bracket!.trailPts ? 0 : trailPts })} className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 hover:text-white" title={s.bracket.trailPts ? undefined : `Trail the SL every ${trailPts} index points`}>
              {s.bracket.trailPts ? 'Trail off' : `Trail ${trailPts}`}
            </button>
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
