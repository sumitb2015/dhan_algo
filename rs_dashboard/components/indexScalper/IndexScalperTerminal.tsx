'use client';

// /index-scalper — TradingView-style NIFTY chart for scalping options. Dhan only.
//
// SIM (paper, never calls an order route) is the default. REAL is armed per page load and never persisted. Every REAL
// order goes through /api/scalper/fast-order tagged source 'isx' (server-side cap), carries an idempotency key, and an
// unknown outcome is reported, never retried. Exit quantities come from the broker's live position, not from UI state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, CandlestickChart, LayoutList, Maximize2, Minus, MousePointer2, RefreshCw, Ruler, Trash2, TrendingUp, Zap,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import DataChip, { toIsoDate } from '@/components/DataChip';
import ScalperChart, { type DrawTool } from './ScalperChart';
import OptionChainPanel, { type PickedContract } from './OptionChainPanel';
import OrderTicket, { type TicketRequest } from './OrderTicket';
import IndicatorPicker from './IndicatorPicker';
import { useIndexScalperFeed } from './useIndexScalperFeed';
import {
  applyTick, mergeHistory, migrateIndicatorsV1, newIndicator, type Bar, type IndicatorInstance, type IndicatorKind,
} from '@/lib/indexScalperIndicators';
import { istDateIso, isRegularSession } from '@/lib/nseHolidays';
import {
  MAX_LOTS, applyFill, fmtRupees, legsFromDhanPositions, orderUnits, ownedCloseOrder, ownedQtyFromOrders, pnlSummary, type ScalperLeg,
} from '@/lib/indexScalperPositions';
import { closeOrderProduct } from '@/lib/positionProduct';
import { readPref, savePref } from '@/lib/localPref';
import { cn } from '@/lib/utils';

type Interval = '1' | '3' | '5' | '15';
const INTERVALS: Interval[] = ['1', '3', '5', '15'];
const RANGES: { label: string; days: number; focus: number }[] = [
  { label: '2M', days: 60, focus: 60 * 86400 }, { label: '1M', days: 30, focus: 30 * 86400 }, { label: '2W', days: 15, focus: 14 * 86400 },
  { label: '1W', days: 10, focus: 7 * 86400 }, { label: '3D', days: 10, focus: 3 * 86400 }, { label: '1D', days: 10, focus: 86400 },
];

const IND_KEY = 'indexScalper.indicators.v2';
const IND_KEY_V1 = 'indexScalper.indicators.v1';
const SIM_KEY = 'indexScalper.sim.v1';
const SPOT_KEY = 'indexScalper.entrySpots.v1';

interface SimLeg { securityId: string; symbol: string; strike: number; type: 'CE' | 'PE'; netQty: number; avg: number }
interface SimState { day: string; legs: Record<string, SimLeg>; realized: number }

const istDayKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const newKey = () => `isx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const nextId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function loadJson<T>(key: string, fallback: T): T {
  try { const raw = readPref(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function defaultIndicators(): IndicatorInstance[] {
  return [newIndicator('supertrend', nextId()), newIndicator('ema', nextId())];
}

interface Toast { ok: boolean; text: string }

export default function IndexScalperTerminal() {
  const feed = useIndexScalperFeed();

  const [interval, setIntervalSel] = useState<Interval>('5');
  const [days, setDays] = useState(15);
  // Range-button request; `seq` makes a repeat click of the same range a new request.
  const [focus, setFocus] = useState<{ seconds: number; seq: number } | null>(null);
  // REST history, tagged with the interval it was loaded for so a switch never mixes two intervals' bars.
  const [history, setHistory] = useState<{ interval: Interval; bars: Bar[] } | null>(null);
  const [liveBars, setLiveBars] = useState<Bar[]>([]);
  const [candleErr, setCandleErr] = useState<string | null>(null);
  const [loadingBars, setLoadingBars] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  const [indicators, setIndicators] = useState<IndicatorInstance[]>([]);
  const [indReady, setIndReady] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const [tool, setTool] = useState<DrawTool>('cursor');
  const [clearToken, setClearToken] = useState(0);
  const [logScale, setLogScale] = useState(false);
  const [pctScale, setPctScale] = useState(false);
  const [autoScale, setAutoScale] = useState(true);

  const [chainOpen, setChainOpen] = useState(true);
  const [scalperOn, setScalperOn] = useState(false);
  const [ticket, setTicket] = useState<PickedContract | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState<Toast | null>(null);

  const [real, setReal] = useState(false);
  const [armOpen, setArmOpen] = useState(false);
  const [sim, setSim] = useState<SimState>({ day: istDayKey(), legs: {}, realized: 0 });
  const [simReady, setSimReady] = useState(false);
  const [entrySpots, setEntrySpots] = useState<Record<string, number>>({});
  const [realRows, setRealRows] = useState<Record<string, unknown>[]>([]);
  const [posErr, setPosErr] = useState<string | null>(null);
  const [funds, setFunds] = useState<{ available: number | null; used: number | null }>({ available: null, used: null });
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [scalpLots, setScalpLots] = useState('1');
  const [clock, setClock] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef(feed);
  const simRef = useRef(sim);
  useEffect(() => { feedRef.current = feed; simRef.current = sim; });

  const flash = useCallback((t: Toast) => {
    setToast(t);
    window.setTimeout(() => setToast(cur => (cur === t ? null : cur)), 6000);
  }, []);

  // ── persisted per-viewer state ─────────────────────────────────────
  useEffect(() => {
    const v2 = loadJson<IndicatorInstance[] | null>(IND_KEY, null);
    const v1 = v2 ? null : loadJson<IndicatorInstance[] | null>(IND_KEY_V1, null);
    const saved = v2 ?? (Array.isArray(v1) ? migrateIndicatorsV1(v1) : null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIndicators(Array.isArray(saved) ? saved : defaultIndicators());
    setIndReady(true);
    const s = loadJson<SimState | null>(SIM_KEY, null);
    if (s && s.day === istDayKey() && s.legs) setSim(s);
    setSimReady(true);
    const sp = loadJson<{ day: string; spots: Record<string, number> } | null>(SPOT_KEY, null);
    if (sp && sp.day === istDayKey()) setEntrySpots(sp.spots);
  }, []);
  useEffect(() => { if (indReady) savePref(IND_KEY, JSON.stringify(indicators)); }, [indicators, indReady]);
  useEffect(() => { if (simReady) savePref(SIM_KEY, JSON.stringify(sim)); }, [sim, simReady]);
  const rememberSpot = useCallback((id: string, spot: number | null) => {
    if (!spot) return;
    setEntrySpots(prev => {
      const next = { ...prev, [id]: spot };
      savePref(SPOT_KEY, JSON.stringify({ day: istDayKey(), spots: next }));
      return next;
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);

  // ── candles ────────────────────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingBars(true);
    fetch(`/api/index-scalper/candles?interval=${interval}&days=${days}`)
      .then(r => r.json())
      .then((j: { success: boolean; candles?: { t: number; o: number; h: number; l: number; c: number }[]; error?: string }) => {
        if (dead) return;
        if (!j.success || !j.candles) { setCandleErr(j.error ?? 'No candles'); return; }
        setCandleErr(null);
        setHistory({ interval, bars: j.candles });
      })
      .catch(e => { if (!dead) setCandleErr(String(e?.message ?? e)); })
      .finally(() => { if (!dead) setLoadingBars(false); });
    return () => { dead = true; };
  }, [interval, days, refreshTick]);

  // Live candles are built from the WebSocket index ticks (the shared options bridge pushes every tick); the REST
  // history above is only the backfill: loaded per interval / range, and again after a gap the ticks cannot have covered
  // (the tab was hidden, or the feed went stale and came back). Nothing polls it on a timer.
  const liveIntervalRef = useRef<Interval | null>(null);
  useEffect(() => {
    if (!history || history.interval !== interval) {
      // Switched interval, history not loaded yet: show nothing rather than the old interval's bars, and take no ticks.
      liveIntervalRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLiveBars([]);
      return;
    }
    const same = liveIntervalRef.current === interval;
    liveIntervalRef.current = interval;
    setLiveBars(prev => (same ? mergeHistory(history.bars, prev, Number(interval), Date.now() / 1000) : history.bars));
  }, [history, interval]);

  useEffect(() => {
    const spot = feed.spot;
    if (spot === null || feed.stale || feed.feedAgeSec === null) return;
    // A held-over spot on a holiday / weekend (the bridge still answers with the last close) must not invent a candle.
    if (!isRegularSession(istDateIso(Date.now()))) return;
    setLiveBars(prev => (liveIntervalRef.current === interval ? applyTick(prev, spot, Number(interval), Date.now() / 1000) : prev));
    // feed.stale / feedAgeSec are read as guards only: a new tick is what moves a bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.spot, interval]);

  const wasStaleRef = useRef(false);
  useEffect(() => {
    if (wasStaleRef.current && !feed.stale && feed.feedAgeSec !== null) setRefreshTick(n => n + 1);
    wasStaleRef.current = feed.stale;
  }, [feed.stale, feed.feedAgeSec]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setRefreshTick(n => n + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── funds + REAL positions ─────────────────────────────────────────
  useEffect(() => {
    let dead = false;
    const load = () => fetch('/api/scalper/funds').then(r => r.json()).then((j: { success: boolean; data?: Record<string, unknown> }) => {
      if (dead || !j.success || !j.data) return;
      const a = Number(j.data.availabelBalance ?? j.data.availableBalance);
      const u = Number(j.data.utilizedAmount);
      setFunds({ available: Number.isFinite(a) ? a : null, used: Number.isFinite(u) ? u : null });
    }).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, []);

  const loadPositions = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    try {
      const r = await fetch('/api/scalper/positions');
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[]; error?: string };
      if (!j.success || !j.data) { setPosErr(j.error ?? 'Could not load positions'); return null; }
      setPosErr(null);
      setRealRows(j.data);
      return j.data;
    } catch (e) { setPosErr(String((e as Error).message ?? e)); return null; }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!real) { setRealRows([]); setPosErr(null); return; }
    loadPositions();
    const t = setInterval(loadPositions, 3000);
    return () => clearInterval(t);
  }, [real, loadPositions]);

  // ── legs shown on the chart ────────────────────────────────────────
  const legs: ScalperLeg[] = useMemo(() => {
    if (real) return legsFromDhanPositions(realRows, feed.ltpById);
    return Object.values(sim.legs).filter(l => l.netQty !== 0).map(l => {
      const live = feed.ltpById.get(l.securityId);
      return { id: l.securityId, securityId: l.securityId, product: '', symbol: l.symbol, strike: l.strike, type: l.type, netQty: l.netQty, avg: l.avg, ltp: live ?? null, sim: true };
    });
  }, [real, realRows, sim.legs, feed.ltpById]);
  const { pnl: openPnl, unpriced } = pnlSummary(legs);

  // ── order placement ────────────────────────────────────────────────
  interface Outcome { ok: boolean; unknown?: boolean; text: string }

  const sendReal = useCallback(async (body: Record<string, unknown>): Promise<Outcome> => {
    try {
      const res = await fetch('/api/scalper/fast-order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, exchangeSegment: 'NSE_FNO', source: 'isx', idempotencyKey: newKey() }),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string; unknown?: boolean };
      if (j.success) return { ok: true, text: `Order ${j.order_id ?? ''} placed` };
      if (j.unknown || res.status === 504) return { ok: false, unknown: true, text: j.error ?? 'Order status unknown: check Positions / Orders before retrying' };
      return { ok: false, text: j.error ?? 'Order rejected' };
    } catch (e) {
      // A throw after the request left may still have booked it: report unknown, never retry.
      return { ok: false, unknown: true, text: `No reply (${String((e as Error).message ?? e)}). Check Positions / Orders before retrying` };
    }
  }, []);

  const simFill = useCallback((c: PickedContract, side: 'BUY' | 'SELL', units: number, price: number, symbol: string) => {
    const id = c.securityId ?? `${c.type}${c.strike}`;
    // A fill that opens a position (from flat, or flipping through zero) anchors the chip at today's spot, as REAL does:
    // a leg closed and reopened later must not stay drawn at the first entry.
    const before = simRef.current.legs[id]?.netQty ?? 0;
    const after = before + (side === 'BUY' ? units : -units);
    const opens = after !== 0 && (before === 0 || Math.sign(after) !== Math.sign(before));
    setSim(prev => {
      const cur = prev.legs[id] ?? { securityId: id, symbol, strike: c.strike, type: c.type, netQty: 0, avg: 0 };
      const next = applyFill(cur.netQty, cur.avg, side, units, price);
      // realized P&L on the part that closed
      let realized = prev.realized;
      const closing = cur.netQty !== 0 && Math.sign(cur.netQty) !== (side === 'BUY' ? 1 : -1);
      if (closing) {
        const closed = Math.min(Math.abs(cur.netQty), units);
        realized += (price - cur.avg) * closed * Math.sign(cur.netQty);
      }
      return { ...prev, realized, legs: { ...prev.legs, [id]: { ...cur, netQty: next.netQty, avg: next.avg } } };
    });
    if (opens) rememberSpot(id, feedRef.current.spot);
  }, [rememberSpot]);

  const placeContract = useCallback(async (req: TicketRequest): Promise<Outcome> => {
    const f = feedRef.current;
    const size = orderUnits(req.lots, f.lotSize);
    if (!size.ok) return { ok: false, text: size.error };
    const c = req.contract;
    if (!c.securityId) return { ok: false, text: 'No security id for this strike' };
    // The security id was picked for one expiry; never send it under a ticket that now shows another.
    if (c.expiry !== f.expiry) return { ok: false, text: `This ticket was opened for the ${c.expiry || 'previous'} expiry: reopen it from the chain` };
    const live = f.ltpById.get(c.securityId) ?? null;
    const symbol = `NIFTY-${f.expiry}-${c.strike}-${c.type}`;

    if (!real) {
      if (req.orderType !== 'MARKET' && req.orderType !== 'LIMIT') return { ok: false, text: 'SIM fills market and marketable limit orders only' };
      if (!(live && live > 0)) return { ok: false, text: 'No live price to fill the paper order' };
      if (f.stale) return { ok: false, text: 'Live prices are stale: not filling a paper order on an old price' };
      let fillPx = live;
      if (req.orderType === 'LIMIT') {
        const lim = req.price ?? 0;
        const marketable = req.side === 'BUY' ? lim >= live : lim <= live;
        if (!marketable) return { ok: false, text: `Limit ${lim} is not marketable at ${live.toFixed(2)} (SIM does not rest orders)` };
        fillPx = live;
      }
      simFill(c, req.side, size.units, fillPx, symbol);
      return { ok: true, text: `SIM ${req.side} ${req.lots} lot${req.lots > 1 ? 's' : ''} ${c.strike} ${c.type} @ ${fillPx.toFixed(2)}` };
    }

    if (req.orderType === 'MARKET' && f.stale) return { ok: false, text: 'Live prices are stale: refusing a market order' };
    const before = legs.find(l => l.securityId === c.securityId)?.netQty ?? 0;
    const out = await sendReal({
      securityId: c.securityId, quantity: size.units, side: req.side, orderType: req.orderType,
      price: req.price ?? undefined, triggerPrice: req.trigger ?? undefined, productType: req.product,
    });
    if (out.ok && before === 0) rememberSpot(c.securityId, f.spot);
    loadPositions();
    return out;
  }, [real, legs, sendReal, simFill, rememberSpot, loadPositions]);

  const submitTicket = useCallback(async (req: TicketRequest) => {
    if (ticketBusy) return;
    setTicketBusy(true); setTicketMsg(null);
    const out = await placeContract(req);
    setTicketMsg({ ok: out.ok, text: out.text });
    setTicketBusy(false);
  }, [placeContract, ticketBusy]);

  // ── exits ──────────────────────────────────────────────────────────
  const exitSimLeg = useCallback((leg: ScalperLeg): Outcome => {
    if (leg.ltp === null) return { ok: false, text: 'No live price to close the paper position' };
    // Same rule as a paper entry: never book P&L on a price the feed stopped updating.
    if (feedRef.current.stale) return { ok: false, text: 'Live prices are stale: not closing a paper position on an old price' };
    const sl = sim.legs[leg.id];
    if (!sl || sl.netQty === 0) return { ok: true, text: 'Already flat' };
    simFill({ strike: sl.strike, type: sl.type, securityId: sl.securityId, ltp: leg.ltp, expiry: '' }, sl.netQty > 0 ? 'SELL' : 'BUY', Math.abs(sl.netQty), leg.ltp, sl.symbol);
    return { ok: true, text: `SIM closed ${sl.strike} ${sl.type} @ ${leg.ltp.toFixed(2)}` };
  }, [sim.legs, simFill]);

  /** Signed units this page's own (`isx`-tagged) orders filled today, per security + product, from Dhan's order book.
   *  null when the book cannot be read: an exit is then refused rather than sized off the broker's whole position. */
  const loadOwned = useCallback(async (): Promise<Map<string, number> | null> => {
    try {
      const r = await fetch('/api/scalper/orders');
      const j = await r.json() as { success: boolean; data?: Record<string, unknown>[] };
      return j.success && Array.isArray(j.data) ? ownedQtyFromOrders(j.data) : null;
    } catch { return null; }
  }, []);

  /** Close what THIS page opened on one broker row (security + product), clamped by what the broker still shows.
   *  Quantity a strategy, another terminal or a manual order holds on the same contract is never touched. */
  const exitRealRow = useCallback(async (leg: ScalperLeg, owned: Map<string, number>): Promise<Outcome & { skipped?: boolean }> => {
    const label = `${leg.strike} ${leg.type}${leg.product ? ` ${leg.product}` : ''}`;
    const order = ownedCloseOrder(leg.netQty, owned.get(leg.id) ?? 0);
    if (!order) return { ok: false, skipped: true, text: `${label}: not opened from this page today, left open (square it off where it was opened)` };
    const product = closeOrderProduct('dhan', leg.product);
    if (!product || product.assumed) return { ok: false, text: `${label}: unsupported or missing product "${leg.product}", square it off at the broker` };
    const out = await sendReal({ securityId: leg.securityId, quantity: order.units, side: order.side, orderType: 'MARKET', ...product.fields });
    if (out.ok && order.units < Math.abs(leg.netQty)) {
      return { ...out, text: `${out.text}: closed ${order.units} of ${Math.abs(leg.netQty)}, the rest was not opened from this page` };
    }
    return out;
  }, [sendReal]);

  /** Fresh broker rows + ownership, read together right before an exit. */
  const readExitState = useCallback(async (): Promise<{ live: ScalperLeg[]; owned: Map<string, number> } | string> => {
    const [rows, owned] = await Promise.all([loadPositions(), loadOwned()]);
    if (!rows) return 'Could not read live positions: nothing was closed';
    if (!owned) return 'Could not read the order book to tell which quantity this page opened: nothing was closed';
    return { live: legsFromDhanPositions(rows, feedRef.current.ltpById), owned };
  }, [loadPositions, loadOwned]);

  const exitLeg = useCallback(async (leg: ScalperLeg) => {
    if (exitingId) return;
    setExitingId(leg.id);
    try {
      let out: Outcome;
      if (!real) out = exitSimLeg(leg);
      else {
        const st = await readExitState();
        if (typeof st === 'string') out = { ok: false, text: st };
        else {
          const row = st.live.find(l => l.id === leg.id);
          out = row ? await exitRealRow(row, st.owned) : { ok: true, text: 'Already flat' };
        }
        loadPositions();
      }
      flash({ ok: out.ok, text: out.text });
    } finally { setExitingId(null); }
  }, [exitingId, real, exitSimLeg, readExitState, exitRealRow, loadPositions, flash]);

  const exitAll = useCallback(async () => {
    if (exitingId || legs.length === 0) return;
    setExitingId('all');
    try {
      if (!real) {
        let failed = 0;
        for (const l of legs) { const o = exitSimLeg(l); if (!o.ok) failed++; }
        flash({ ok: failed === 0, text: failed ? `${failed} paper leg(s) not closed: no live price, or prices are stale` : 'SIM: all positions closed' });
        return;
      }
      const st = await readExitState();
      if (typeof st === 'string') { flash({ ok: false, text: st }); return; }
      // One pass per broker row (legs are already one per security + product, duplicates collapsed), so no row is
      // closed twice. Cover shorts before selling longs so a hedge is never gone while its short is still open.
      const ordered = [...st.live.filter(l => l.netQty < 0), ...st.live.filter(l => l.netQty > 0)];
      const problems: string[] = [];
      let skipped = 0;
      let sent = 0;
      for (const l of ordered) {
        const o = await exitRealRow(l, st.owned);
        if (o.skipped) { skipped++; continue; }
        if (!o.ok) { problems.push(o.text); if (o.unknown) break; continue; }
        sent++;
      }
      const note = skipped ? ` · ${skipped} leg(s) not opened from this page left open` : '';
      flash({
        ok: problems.length === 0,
        text: problems.length ? `Exit All incomplete: ${problems.join(' · ')}${note}` : `Exit All sent for ${sent} leg(s) opened from this page${note}`,
      });
      loadPositions();
    } finally { setExitingId(null); }
  }, [exitingId, legs, real, exitSimLeg, readExitState, exitRealRow, loadPositions, flash]);

  // ── one-click scalper (buy ATM CE / PE) ────────────────────────────
  const atmContract = useCallback((type: 'CE' | 'PE'): PickedContract | null => {
    const q = feed.quotes;
    if (!q || !q.atm) return null;
    const ids = feed.strikeIds.get(q.atm);
    const sd = q.strikes?.[String(q.atm)] ?? Object.values(q.strikes ?? {}).find(r => r.strike === q.atm);
    const id = type === 'CE' ? ids?.ceId : ids?.peId;
    const ltp = type === 'CE' ? sd?.ce?.ltp : sd?.pe?.ltp;
    return { strike: q.atm, type, securityId: id ?? null, ltp: ltp && ltp > 0 ? ltp : null, expiry: feed.expiry };
  }, [feed.quotes, feed.strikeIds, feed.expiry]);

  const quickBuy = useCallback(async (type: 'CE' | 'PE') => {
    const c = atmContract(type);
    if (!c) { flash({ ok: false, text: 'ATM contract not ready yet' }); return; }
    if (!scalperOn) { setTicket(c); setTicketMsg(null); return; }
    if (ticketBusy) return;
    setTicketBusy(true);
    const out = await placeContract({ contract: c, side: 'BUY', orderType: 'MARKET', price: null, trigger: null, product: 'INTRADAY', lots: Number(scalpLots) });
    setTicketBusy(false);
    flash({ ok: out.ok, text: out.text });
  }, [atmContract, scalperOn, ticketBusy, placeContract, scalpLots, flash]);

  // ── REAL arming ────────────────────────────────────────────────────
  const goSim = () => { setReal(false); };

  // ── indicators ─────────────────────────────────────────────────────
  const addIndicator = (k: IndicatorKind) => { setIndicators(p => [...p, newIndicator(k, nextId())]); setPickerOpen(false); };
  const patchIndicator = (id: string, patch: Partial<IndicatorInstance>) => setIndicators(p => p.map(i => (i.id === id ? { ...i, ...patch } : i)));
  const removeIndicator = (id: string) => setIndicators(p => p.filter(i => i.id !== id));

  // A ticket belongs to the expiry it was picked under (its security id is that expiry's): close it on a switch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTicket(cur => (cur && cur.expiry !== feed.expiry ? null : cur));
  }, [feed.expiry]);

  const ticketLtp = useMemo(() => {
    if (!ticket?.securityId) return null;
    return feed.ltpById.get(ticket.securityId) ?? null;
  }, [ticket, feed.ltpById]);

  const lastBar = liveBars[liveBars.length - 1];
  const dataDate = lastBar ? toIsoDate(String(lastBar.t)) : null;
  const spotDisplay = feed.spot ?? lastBar?.c ?? null;

  const btn = 'h-7 px-2 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 transition-colors';
  const sep = <span className="w-px h-5 bg-zinc-800 shrink-0" />;

  const toolBtn = (t: DrawTool, label: string, Icon: typeof Minus) => (
    <button key={t} type="button" aria-label={label} title={label} aria-pressed={tool === t} onClick={() => setTool(tool === t ? 'cursor' : t)}
      className={cn('w-9 h-9 flex items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
        tool === t ? 'bg-sky-600 text-oncolor' : 'text-zinc-400 hover:text-white hover:bg-zinc-800')}>
      <Icon className="w-[18px] h-[18px]" />
    </button>
  );

  return (
    <div ref={rootRef} data-testid="index-scalper" className={cn('flex flex-col h-screen overflow-hidden bg-zinc-950 text-white', real && 'ring-2 ring-inset ring-rose-600/70')}>
      {/* header toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 h-11 border-b border-zinc-800 bg-zinc-950 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex items-center gap-1.5 px-2 h-7 rounded text-sm font-bold text-white"><CandlestickChart className="w-4 h-4 text-sky-400" />NIFTY</span>
          {sep}
          <div role="group" aria-label="Timeframe" className="flex items-center">
            {INTERVALS.map(i => (
              <button key={i} type="button" aria-pressed={interval === i} onClick={() => setIntervalSel(i)}
                className={cn(btn, interval === i && 'bg-zinc-800 text-white')}>{i}m</button>
            ))}
          </div>
          {sep}
          <button type="button" onClick={() => { setEditId(null); setPickerOpen(true); }} className={cn(btn, 'flex items-center gap-1')}>
            <BarChart3 className="w-4 h-4" />Indicators{indicators.length > 0 && <span className="text-sky-400">{indicators.length}</span>}
          </button>
          {sep}
          <button type="button" onClick={() => quickBuy('PE')} className="h-7 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300">Buy PE</button>
          <button type="button" onClick={() => quickBuy('CE')} className="h-7 px-3 rounded bg-sky-600 hover:bg-sky-500 text-oncolor text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">Buy CE</button>
          <button type="button" aria-pressed={scalperOn} onClick={() => setScalperOn(v => !v)} title="One-click: Buy CE / Buy PE place a market order for the ATM strike at once"
            className={cn('h-7 px-2 rounded border text-xs font-bold flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
              scalperOn ? 'border-amber-400 text-amber-300 bg-amber-500/10' : 'border-sky-500/60 text-sky-300 hover:bg-sky-500/10')}>
            <Zap className="w-3.5 h-3.5" />Scalper
          </button>
          {sep}
          <button type="button" aria-pressed={chainOpen} aria-label="Option chain" title="Option chain" onClick={() => setChainOpen(v => !v)} className={cn(btn, chainOpen && 'bg-zinc-800 text-white')}><LayoutList className="w-4 h-4" /></button>
          <button type="button" aria-label="Refresh candles" title="Refresh candles" onClick={() => setRefreshTick(n => n + 1)} className={btn}><RefreshCw className={cn('w-4 h-4', loadingBars && 'animate-spin')} /></button>
          <button type="button" disabled={legs.length === 0 || exitingId !== null} onClick={exitAll}
            className="h-7 px-2 rounded border border-rose-500/70 text-rose-300 hover:bg-rose-500/10 text-xs font-bold disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
            Exit All
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={cn('text-[11px] tabular-nums font-mono', feed.stale ? 'text-amber-400' : 'text-zinc-400')} title="Live tick bridge">
            {spotDisplay ? spotDisplay.toFixed(2) : '—'} <span className={cn('inline-block w-1.5 h-1.5 rounded-full align-middle', feed.feedAgeSec === null ? 'bg-zinc-600' : feed.stale ? 'bg-amber-400' : 'bg-emerald-400')} />
          </span>
          <div role="group" aria-label="Order mode" className="flex rounded border border-zinc-700 overflow-hidden">
            <button type="button" aria-pressed={!real} onClick={goSim} className={cn('h-7 px-2 text-xs font-bold', !real ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400 hover:bg-zinc-800')}>SIM</button>
            <button type="button" aria-pressed={real} onClick={() => (real ? undefined : setArmOpen(true))} className={cn('h-7 px-2 text-xs font-bold', real ? 'bg-rose-600 text-oncolor' : 'text-zinc-400 hover:bg-zinc-800')}>REAL</button>
          </div>
          <DataChip date={dataDate} />
          <button type="button" aria-label="Fullscreen" title="Fullscreen" className={btn}
            onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void rootRef.current?.requestFullscreen?.(); }}><Maximize2 className="w-4 h-4" /></button>
          <NavBar compact />
        </div>
      </div>

      {(candleErr || posErr || feed.stale) && (
        <div role="alert" className="px-3 py-1 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/30">
          {candleErr && <span className="mr-3">Candles: {candleErr}</span>}
          {posErr && <span className="mr-3">Positions: {posErr}</span>}
          {feed.stale && <span>Live ticks are stale ({Math.round(feed.feedAgeSec ?? 0)}s): market closed or bridge down. Market orders are refused.</span>}
        </div>
      )}

      {/* body: drawing toolbar + chart */}
      <div className="flex flex-1 min-h-0">
        <div className="w-11 shrink-0 border-r border-zinc-800 flex flex-col items-center py-2 gap-1">
          {toolBtn('cursor', 'Cursor', MousePointer2)}
          {toolBtn('trend', 'Trend line (two clicks)', TrendingUp)}
          {toolBtn('hline', 'Horizontal line (one click)', Minus)}
          {toolBtn('ruler', 'Measure (two clicks)', Ruler)}
          <button type="button" aria-label="Remove all drawings" title="Remove all drawings" onClick={() => setClearToken(n => n + 1)}
            className="w-9 h-9 flex items-center justify-center rounded text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"><Trash2 className="w-[18px] h-[18px]" /></button>
        </div>

        <div className="relative flex-1 min-w-0 min-h-0">
          {indReady && (
            <ScalperChart
              bars={liveBars} indicators={indicators} tool={tool} onToolDone={() => setTool('cursor')} clearToken={clearToken}
              logScale={logScale} pctScale={pctScale} autoScale={autoScale}
              legs={legs} entrySpots={entrySpots} onExitLeg={exitLeg} exitingId={exitingId}
              onToggleIndicator={id => setIndicators(p => p.map(i => (i.id === id ? { ...i, visible: !i.visible } : i)))}
              onRemoveIndicator={removeIndicator} onEditIndicator={id => { setEditId(id); setPickerOpen(true); }}
              symbolLabel={`NIFTY · ${interval} · IDX`} focus={focus}
            />
          )}
          {liveBars.length === 0 && !loadingBars && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500 pointer-events-none">No candles to show{candleErr ? '' : ' yet'}.</div>
          )}
          {toast && (
            <div role="status" className={cn('absolute left-1/2 -translate-x-1/2 bottom-4 z-30 max-w-[70%] px-3 py-2 rounded border text-xs font-semibold',
              toast.ok ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-rose-500/15 text-rose-300 border-rose-500/40')}>{toast.text}</div>
          )}
          {scalperOn && (
            <div className="absolute left-1/2 -translate-x-1/2 top-3 z-30 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-500/50 bg-zinc-900 shadow-lg">
              <Zap className="w-4 h-4 text-amber-300" />
              <label className="text-[11px] text-zinc-400 flex items-center gap-1">Lots
                <input inputMode="numeric" value={scalpLots} onChange={e => setScalpLots(e.target.value)} aria-label="Scalper lots"
                  className="w-12 h-6 px-1 rounded bg-zinc-800 border border-zinc-700 text-center text-xs tabular-nums text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
              </label>
              <span className="text-[10px] text-zinc-500">max {MAX_LOTS} · ATM {feed.quotes?.atm ?? '—'}</span>
            </div>
          )}
        </div>
      </div>

      {/* range strip */}
      <div className="flex items-center justify-between px-3 h-8 border-t border-zinc-800 text-[11px] text-zinc-400 shrink-0">
        <div className="flex items-center gap-1">
          {RANGES.map(r => (
            <button key={r.label} type="button" className={btn} onClick={() => { setDays(r.days); setFocus(f => ({ seconds: r.focus, seq: (f?.seq ?? 0) + 1 })); }}>{r.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 tabular-nums font-mono">
          <span>{clock} (UTC+05:30)</span>
          <button type="button" aria-pressed={pctScale} onClick={() => { setPctScale(v => !v); setLogScale(false); }} className={cn('hover:text-white', pctScale && 'text-sky-400')}>%</button>
          <button type="button" aria-pressed={logScale} onClick={() => { setLogScale(v => !v); setPctScale(false); }} className={cn('hover:text-white', logScale && 'text-sky-400')}>log</button>
          <button type="button" aria-pressed={autoScale} onClick={() => setAutoScale(v => !v)} className={cn('hover:text-white', autoScale && 'text-sky-400')}>auto</button>
        </div>
      </div>

      {/* account strip */}
      <div className="flex items-center justify-between gap-4 px-3 h-9 border-t border-zinc-800 bg-zinc-900 text-[11px] shrink-0">
        <span className="font-semibold text-zinc-300">Account Manager <span className={cn('ml-2 font-bold', real ? 'text-rose-400' : 'text-amber-300')}>{real ? 'REAL · Dhan' : 'SIM'}</span></span>
        <div className="flex items-center gap-6 tabular-nums">
          <span className="text-zinc-400">Open P&amp;L <b data-testid="open-pnl" className={cn(openPnl === null ? 'text-zinc-400' : openPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtRupees(openPnl)}</b>
            {unpriced > 0 && <span data-testid="open-pnl-partial" className="ml-1 text-amber-300" title="Legs with no live price (e.g. an expiry other than the one in the chain) are not in this total">partial · {unpriced} unpriced</span>}</span>
          {!real && <span className="text-zinc-400">Realized (SIM) <b className={sim.realized >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{fmtRupees(sim.realized)}</b></span>}
          <span className="text-zinc-400">Available Margin <b className="text-sky-300">{funds.available === null ? '—' : `₹${funds.available.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</b></span>
          <span className="text-zinc-400">Used Margin <b className="text-zinc-200">{funds.used === null ? '—' : `₹${funds.used.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}</b></span>
        </div>
      </div>

      {chainOpen && (
        <OptionChainPanel feed={feed} onClose={() => setChainOpen(false)} onPick={c => { setTicket(c); setTicketMsg(null); }} />
      )}
      {ticket && (
        <OrderTicket key={`${ticket.expiry}:${ticket.strike}${ticket.type}`} contract={ticket} liveLtp={ticketLtp} expiry={ticket.expiry} lotSize={feed.lotSize}
          real={real} available={funds.available} busy={ticketBusy} message={ticketMsg} onSubmit={submitTicket} onClose={() => setTicket(null)} />
      )}
      <IndicatorPicker open={pickerOpen} indicators={indicators} editId={editId} onAdd={addIndicator} onChange={patchIndicator}
        onRemove={removeIndicator} onEdit={setEditId} onClose={() => { setPickerOpen(false); setEditId(null); }} />

      {armOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70">
          <div role="alertdialog" aria-label="Arm real orders" className="w-[380px] rounded-lg border border-rose-500/70 bg-zinc-900 p-5 shadow-2xl">
            <h2 className="text-sm font-bold text-rose-300 mb-2">Arm REAL orders on Dhan?</h2>
            <p className="text-xs text-zinc-300 mb-4">Buy/Sell, Scalper and Exit will place live orders with real money (max {MAX_LOTS} lots per order). The chart then shows your Dhan NIFTY option positions. REAL is switched off again whenever this page reloads.</p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setArmOpen(false)} className="h-8 px-3 rounded text-xs font-semibold text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button type="button" autoFocus onClick={() => { setReal(true); setArmOpen(false); }} className="h-8 px-3 rounded bg-rose-600 hover:bg-rose-500 text-oncolor text-xs font-bold">Arm REAL</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

