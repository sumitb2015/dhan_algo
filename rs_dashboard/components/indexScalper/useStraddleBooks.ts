'use client';

// The Straddle pane's own straddles on /index-scalper: one-click Sell / Buy straddle (CE + PE of one strike, same lots),
// their ledger, Exit straddle, and the browser-side rule watcher (target / stop, VWAP close, trail / lock, stop to cost,
// time exit). Real-money hook: rules live in lib/indexScalperStraddle.ts, orders go through the terminal's own
// placeContract / exitRealRow (same routes, caps, tags and guards as every other order on the page).
//
// Ownership: the ledger, never the broker net. An exit closes this straddle's own quantity, clamped by a FRESH broker
// read in the closing direction, so a Quick Trade leg on the same strike is never closed by it. An entry or exit whose
// outcome is unknown is never resent. Rules run only while this tab is open (REAL: only while armed), like every other
// Index Scalper guard; a Web Lock per straddle keeps two tabs from both firing an exit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { settleLegPrice, type TsLeg } from '@/lib/tripleStraddle';
import {
  DEFAULT_STRADDLE_RULES, STRADDLE_STORE_KEY, currentFloor, effectiveLevels, evaluateStraddle, withRuleDefaults, exitQtyFor, lastClosedVwap, parseStraddleStore, premiumAtPct,
  rulesError, serializeStraddleStore, straddleHealth, straddleMtm, type IsxStraddle, type StraddleExitReason, type StraddleRules,
} from '@/lib/indexScalperStraddle';
import { INSTRUMENTS, lotUnits, openingProduct, pnlMultiplier, type Underlying } from '@/lib/indexScalperInstrument';
import { lastBarClosed } from '@/lib/indexScalperIndicators';
import type { ResolvedSource } from '@/lib/indexScalperChartSource';
import type { ScalperLeg } from '@/lib/indexScalperPositions';
import type { KotakRecord } from '@/lib/indexScalperKotak';
import type { OrderRowView } from '@/lib/indexScalperAccount';
import { playWarnChime } from '@/lib/alertSound';
import type { PickedContract } from './OptionChainPanel';
import type { TicketRequest } from './OrderTicket';
import type { IndexScalperFeed } from './useIndexScalperFeed';
import { useChartBars, type Interval } from './useChartBars';
import type { LevelLine } from './ScalperChart';

interface Outcome { ok: boolean; unknown?: boolean; text: string; orderId?: string }
type ExitState = { live: ScalperLeg[]; records: KotakRecord[]; book: Record<string, unknown>[] } | string;

export interface StraddleLegIds { ceId: string | null; peId: string | null; ceSymbol: string | null; peSymbol: string | null }

/** A straddle with the Dhan ids of its legs (prices and candles come from Dhan whatever the broker) and its candle
 *  interval (the VWAP rule reads that timeframe's finished candles). */
export interface PaneStraddle extends IsxStraddle {
  broker: 'dhan' | 'kotak';
  dhanIds: { CE: string; PE: string };
  intervalMin: number;
}

export interface StraddleView {
  book: PaneStraddle;
  mtm: { pnlRs: number; pnlPct: number } | null;
  health: ReturnType<typeof straddleHealth>;
  floor: ReturnType<typeof currentFloor>;
  vwapNow: number | null;
  /** EMA of the straddle (the rule's length) at the last finished candle. */
  emaNow: number | null;
}

const RULES_KEY = 'indexScalper.straddleRules.v1';
function loadDraftRules(): StraddleRules {
  try {
    const r = JSON.parse(localStorage.getItem(RULES_KEY) ?? 'null') as Partial<StraddleRules> | null;
    const w = r ? withRuleDefaults(r) : null;
    return w && !rulesError(w) ? w : DEFAULT_STRADDLE_RULES;
  } catch { return DEFAULT_STRADDLE_RULES; }
}

const TODAY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const RETRY_MS = 5_000;

function loadBooks(): PaneStraddle[] {
  try { return parseStraddleStore(localStorage.getItem(STRADDLE_STORE_KEY), TODAY()) as PaneStraddle[]; } catch { return []; }
}
function saveBooks(b: PaneStraddle[]) {
  try { localStorage.setItem(STRADDLE_STORE_KEY, serializeStraddleStore(b)); } catch { /* private window: memory only */ }
}

export interface UseStraddleArgs {
  underlying: Underlying;
  real: boolean;
  broker: 'dhan' | 'kotak';
  feed: IndexScalperFeed;
  refreshTick: number;
  placeContract: (req: TicketRequest) => Promise<Outcome>;
  readExitState: () => Promise<ExitState>;
  exitRealRow: (leg: ScalperLeg, records?: KotakRecord[], book?: Record<string, unknown>[], maxUnits?: number) => Promise<Outcome>;
  simNet: (securityId: string) => number;
  simClose: (c: PickedContract, side: 'BUY' | 'SELL', units: number, price: number, symbol: string) => void;
  orders: OrderRowView[];
  lotOf: (id: string | null | undefined) => number | null;
  flash: (t: { ok: boolean; text: string }) => void;
  refreshAfterOrder: () => void;
  soundOn: () => boolean;
}

export function useStraddleBooks(a: UseStraddleArgs) {
  const { underlying, real, broker, feed } = a;
  const [books, setBooksState] = useState<PaneStraddle[]>([]);
  const booksRef = useRef<PaneStraddle[]>([]);
  const setBooks = useCallback((f: (prev: PaneStraddle[]) => PaneStraddle[]) => {
    const next = f(booksRef.current);
    booksRef.current = next;
    setBooksState(next);
    saveBooks(next);
  }, []);
  const patch = useCallback((id: string, f: (b: PaneStraddle) => PaneStraddle) => setBooks(prev => prev.map(b => (b.id === id ? f(b) : b))), [setBooks]);

  // The rules a NEW straddle starts with (saved per browser); an open straddle carries its own copy.
  const [draftRules, setDraftState] = useState<StraddleRules>(DEFAULT_STRADDLE_RULES);
  useEffect(() => { setDraftState(loadDraftRules()); }, []); // eslint-disable-line react-hooks/set-state-in-effect
  const setDraftRules = useCallback((r: StraddleRules): string | null => {
    const err = rulesError(r);
    if (err) return err;
    setDraftState(r);
    try { localStorage.setItem(RULES_KEY, JSON.stringify(r)); } catch { /* memory only */ }
    return null;
  }, []);

  // Load once, and follow another tab's writes (it may have exited a straddle: never fire on a stale copy).
  useEffect(() => {
    const b = loadBooks();
    booksRef.current = b;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBooksState(b);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STRADDLE_STORE_KEY) return;
      const nb = loadBooks();
      booksRef.current = nb;
      setBooksState(nb);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const mode = real ? 'REAL' : 'SIM';
  const mine = useCallback((b: PaneStraddle) => b.underlying === underlying && b.mode === mode && (mode === 'SIM' || b.broker === broker), [underlying, mode, broker]);
  const open = useMemo(() => books.find(b => b.status === 'OPEN' && mine(b)) ?? null, [books, mine]);

  const argsRef = useRef(a);
  useEffect(() => { argsRef.current = a; });

  // ── entry ─────────────────────────────────────────────────────────
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const enter = useCallback(async (side: 'S' | 'B', strike: number, ids: StraddleLegIds, lots: number, rules: StraddleRules, intervalMin: number) => {
    const A = argsRef.current;
    if (busyRef.current) return;
    const err = rulesError(rules);
    if (err) { A.flash({ ok: false, text: `Straddle not placed: ${err}` }); return; }
    if (booksRef.current.some(b => b.status === 'OPEN' && mine(b))) { A.flash({ ok: false, text: 'A straddle is already open here: exit it first (one straddle at a time)' }); return; }
    if (!Number.isInteger(lots) || lots < 1 || lots > INSTRUMENTS[underlying].maxLots) { A.flash({ ok: false, text: `Lots must be 1 to ${INSTRUMENTS[underlying].maxLots}` }); return; }
    if (!ids.ceId || !ids.peId) { A.flash({ ok: false, text: 'Both option contracts are not loaded yet' }); return; }
    if (real && broker === 'kotak' && (!ids.ceSymbol || !ids.peSymbol)) { A.flash({ ok: false, text: 'Kotak contracts for this strike are not loaded yet' }); return; }
    const f = A.feed;
    const ce = f.ltpById.get(ids.ceId) ?? null, pe = f.ltpById.get(ids.peId) ?? null;
    if (!(ce && ce > 0 && pe && pe > 0)) { A.flash({ ok: false, text: 'No live price on both legs: straddle not placed' }); return; }
    const unitsCe = lotUnits(underlying, A.lotOf(ids.ceId)), unitsPe = lotUnits(underlying, A.lotOf(ids.peId));
    if (!unitsCe || !unitsPe) { A.flash({ ok: false, text: 'Lot size unknown: straddle not placed' }); return; }
    busyRef.current = true; setBusy(true);
    try {
      const orderSide = side === 'S' ? 'SELL' : 'BUY';
      const req = (type: 'CE' | 'PE', id: string, sym: string | null, ltp: number): TicketRequest => ({
        contract: { strike, type, securityId: id, ltp, expiry: f.expiry, tradingSymbol: sym },
        side: orderSide, orderType: 'MARKET', price: null, trigger: null, product: 'INTRADAY', lots, noDefaultBrackets: true,
      });
      // Both legs go out together (nothing awaited between them): a straddle half-filled for seconds is the risk here.
      const [oc, op] = await Promise.all([A.placeContract(req('CE', ids.ceId, ids.ceSymbol, ce)), A.placeContract(req('PE', ids.peId, ids.peSymbol, pe))]);
      const kotakReal = real && broker === 'kotak';
      const leg = (option: 'CE' | 'PE', out: Outcome, units: number, px: number): TsLeg => ({
        option,
        securityId: kotakReal ? (option === 'CE' ? ids.ceSymbol! : ids.peSymbol!) : (option === 'CE' ? ids.ceId! : ids.peId!),
        // P&L units (contract units / barrels); a rejected leg has 0 and the straddle is ONE LEG.
        qty: out.ok || out.unknown ? lots * units : 0,
        entry: px,
        ...(out.unknown ? { unconfirmed: true } : {}),
        // REAL: the live premium is an estimate until the order book reports the traded average (re-priced below).
        ...(real && out.ok && out.orderId ? { entryEst: out.orderId } : {}),
        orderIds: out.orderId ? [out.orderId] : [],
      });
      const legs: [TsLeg, TsLeg] = [leg('CE', oc, unitsCe, ce), leg('PE', op, unitsPe, pe)];
      if (legs.every(l => l.qty === 0)) {
        A.flash({ ok: false, text: `Straddle not placed. CE: ${oc.text}. PE: ${op.text}` });
        return;
      }
      const book: PaneStraddle = {
        id: `str-${Date.now().toString(36)}`, slot: 'center', mode, broker, side, underlying, expiry: f.expiry ?? '', strike, lots,
        lotSize: unitsCe, product: openingProduct(underlying, 'INTRADAY'), status: 'OPEN', legs, risk: { armed: true },
        openedAt: Date.now(), day: TODAY(), rules, dhanIds: { CE: ids.ceId, PE: ids.peId }, intervalMin,
      };
      setBooks(prev => [...prev, book]);
      const health = straddleHealth(book);
      const what = `${side === 'S' ? 'Sold' : 'Bought'} ${lots} lot${lots > 1 ? 's' : ''} ${strike} straddle${real ? '' : ' (SIM)'}`;
      if (health === 'OK') A.flash({ ok: true, text: `${what} @ ${(ce + pe).toFixed(2)}` });
      else {
        if (A.soundOn()) playWarnChime();
        A.flash({ ok: false, text: `${what}: ONE LEG. CE: ${oc.text}. PE: ${op.text}. Exit the open leg or retry the missing one (an unknown order is never resent)` });
      }
    } finally { busyRef.current = false; setBusy(false); }
  }, [underlying, real, broker, mode, mine, setBooks]);

  // ── exit ──────────────────────────────────────────────────────────
  const exiting = useRef(new Set<string>());
  const retryAt = useRef(new Map<string, number>());
  const exitBook = useCallback(async (id: string, reason: StraddleExitReason): Promise<boolean> => {
    const A = argsRef.current;
    const b0 = booksRef.current.find(b => b.id === id);
    if (!b0 || b0.status !== 'OPEN' || exiting.current.has(id)) return false;
    exiting.current.add(id);
    patch(id, b => ({ ...b, exiting: true, lastError: undefined }));
    const label = `${b0.strike} straddle`;
    const closeSide = b0.side === 'S' ? 'BUY' : 'SELL';
    try {
      const legs = [...b0.legs] as [TsLeg, TsLeg];
      let refused: string | null = null, unknown = false;
      const live = (l: TsLeg) => A.feed.ltpById.get(b0.dhanIds[l.option]) ?? null;
      let st: ExitState | null = null;
      if (b0.mode === 'REAL') {
        st = await A.readExitState();
        if (typeof st === 'string') refused = st;
      }
      for (let i = 0; i < 2 && !refused && !unknown; i++) {
        const l = legs[i];
        if (l.closed || l.qty === 0) continue;
        const px = live(l);
        if (b0.mode === 'SIM') {
          const net = A.simNet(l.securityId!);
          const q = exitQtyFor(l.qty, b0.side, net);
          if (q > 0) {
            if (!(px && px > 0) || A.feed.stale || !A.feed.marketOpen) { refused = `${l.option}: no live price, paper exit refused`; break; }
            A.simClose({ strike: b0.strike, type: l.option, securityId: l.securityId ?? null, ltp: px, expiry: b0.expiry }, closeSide, q, px, `${b0.underlying}-${b0.expiry}-${b0.strike}-${l.option}`);
          }
          legs[i] = { ...l, closed: true, exit: px ?? l.entry, ...(q > 0 ? {} : { priceUnconfirmed: true }) };
          continue;
        }
        const s = st as Exclude<ExitState, string>;
        const want = b0.product === 'MARGIN' ? ['MARGIN', 'NRML'] : ['INTRADAY', 'MIS'];
        const rows = s.live.filter(r => r.securityId === l.securityId);
        const row = rows.find(r => want.includes(r.product.toUpperCase())) ?? (rows.length === 1 ? rows[0] : undefined);
        // Own quantity in the broker's unit (Dhan MCX counts lots), clamped by what the broker shows in the closing direction.
        const ownBroker = l.qty / pnlMultiplier(b0.underlying as Underlying, b0.broker);
        const q = row ? exitQtyFor(ownBroker, b0.side, row.netQty) : 0;
        if (q <= 0) { legs[i] = { ...l, closed: true, exit: px ?? l.entry, priceUnconfirmed: true }; continue; }
        const out = await A.exitRealRow(row!, s.records, s.book, q);
        if (out.ok) legs[i] = { ...l, closed: true, exit: px ?? l.entry, ...(out.orderId ? { exitEst: out.orderId } : {}), orderIds: [...l.orderIds, ...(out.orderId ? [out.orderId] : [])] };
        else if (out.unknown) { unknown = true; refused = `${l.option}: ${out.text}`; legs[i] = { ...l, unknownExitAt: Date.now() }; }
        else refused = `${l.option}: ${out.text}`;
      }
      const allClosed = legs.every(l => l.closed || l.qty === 0);
      patch(id, b => ({
        ...b, legs,
        ...(allClosed ? { status: 'CLOSED' as const, closedAt: Date.now(), closeReason: reason, exiting: false } : {}),
        // An unknown outcome keeps the straddle "exiting" (no rule fires again, nothing is resent); a refusal frees it to retry.
        ...(!allClosed && !unknown ? { exiting: false } : {}),
        lastError: refused ?? undefined,
      }));
      if (b0.mode === 'REAL') A.refreshAfterOrder();
      if (allClosed) A.flash({ ok: true, text: `${label} closed (${REASON_TEXT[reason]})` });
      else {
        retryAt.current.set(id, Date.now() + RETRY_MS);
        if (A.soundOn()) playWarnChime();
        A.flash({ ok: false, text: `${label}: exit ${unknown ? 'outcome unknown, not resent: check Positions / Orders' : 'refused'} (${refused})` });
      }
      return allClosed;
    } finally { exiting.current.delete(id); }
  }, [patch]);

  /** Drop a straddle from the ledger without any order (the user squared it off elsewhere / handled a one-leg state). */
  const forget = useCallback((id: string) => patch(id, b => ({ ...b, status: 'CLOSED', closedAt: Date.now(), exiting: false, closeReason: 'FORGOTTEN' })), [patch]);
  const setRules = useCallback((id: string, rules: StraddleRules): string | null => {
    const err = rulesError(rules);
    if (err) return err;
    patch(id, b => ({ ...b, rules }));
    return null;
  }, [patch]);

  // ── fill re-pricing (REAL): the order book's traded average replaces the live-premium estimate ──
  useEffect(() => {
    if (!a.orders.length) return;
    const avg = new Map(a.orders.filter(o => o.avgTraded && o.avgTraded > 0).map(o => [o.id, o.avgTraded!]));
    for (const b of booksRef.current) {
      const owed = b.legs.flatMap(l => [l.entryEst, l.exitEst]).filter((x): x is string => !!x && avg.has(x));
      if (!owed.length) continue;
      let next = b as IsxStraddle;
      for (const oid of owed) next = settleLegPrice(next, oid, avg.get(oid)!) as IsxStraddle;
      if (next !== b) patch(b.id, () => next as PaneStraddle);
    }
  }, [a.orders, patch]);

  // ── the open straddle's own candles (its strike, its interval): VWAP rule + panel VWAP ──
  const resolved = useMemo<ResolvedSource>(() => ({
    kind: 'straddle', type: null, strike: open?.strike ?? null, dhanId: null, kotakSymbol: null, tick: INSTRUMENTS[underlying].optTick,
    legs: open ? { ceId: open.dhanIds.CE, peId: open.dhanIds.PE, ceSymbol: null, peSymbol: null } : { ceId: null, peId: null, ceSymbol: null, peSymbol: null },
  }), [open?.strike, open?.dhanIds.CE, open?.dhanIds.PE, underlying]); // eslint-disable-line react-hooks/exhaustive-deps
  const iv = String(open?.intervalMin ?? 5) as Interval;
  // 10 days: enough finished bars for the EMA on every interval (60-minute bars: ~60).
  const { bars } = useChartBars(underlying, resolved, iv, 10, a.refreshTick, feed);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 5_000); return () => clearInterval(t); }, []);
  const closed = useMemo(() => {
    if (!open || !bars.length) return null;
    return lastClosedVwap(bars, open.intervalMin, lastBarClosed(bars, open.intervalMin, underlying, true, nowMs), open.rules.ema.len);
  }, [bars, open, underlying, nowMs]);

  // ── rule watcher: on every price push (and the 5 s clock for the time exit) ──
  const ltpOf = useCallback((b: PaneStraddle) => ({ CE: feed.ltpById.get(b.dhanIds.CE), PE: feed.ltpById.get(b.dhanIds.PE) }), [feed.ltpById]);
  useEffect(() => {
    if (!open || open.exiting) return;
    if ((retryAt.current.get(open.id) ?? 0) > Date.now()) return;
    const d = evaluateStraddle(open, {
      ltp: ltpOf(open), nowMs: Date.now(), stale: feed.stale || !feed.marketOpen || feed.feedAgeSec === null,
      closedBar: closed ? { endMs: closed.endMs, close: closed.close } : null, vwapAtClosed: closed?.vwap ?? null, emaAtClosed: closed?.ema ?? null,
    });
    // The peak only ever rises (trail / lock run off it): saved so a reload does not forget how far it ran.
    if (d.peakPct != null && d.peakPct > (open.peakPct ?? 0) + 0.05) patch(open.id, b => ({ ...b, peakPct: d.peakPct! }));
    if (!d.reason) return;
    const reason = d.reason;
    const fire = () => exitBook(open.id, reason);
    // One tab exits; a second tab waiting on the lock then reads the ledger (synced via storage) as exiting / closed.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      void navigator.locks.request(`index-scalper-straddle:${open.id}`, { ifAvailable: true }, async lock => {
        if (!lock) return;
        const cur = loadBooks().find(b => b.id === open.id);
        if (!cur || cur.status !== 'OPEN' || cur.exiting) return;
        await fire();
      });
    } else void fire();
  }, [open, feed.quotes, feed.stale, feed.marketOpen, feed.feedAgeSec, closed, nowMs, ltpOf, exitBook, patch]);

  const view = useMemo<StraddleView | null>(() => {
    if (!open) return null;
    return { book: open, mtm: straddleMtm(open, ltpOf(open)), health: straddleHealth(open), floor: currentFloor(open), vwapNow: closed?.vwap ?? null, emaNow: closed?.ema ?? null };
  }, [open, ltpOf, closed]);

  const closedToday = useMemo(() => books.filter(b => b.status === 'CLOSED' && mine(b)), [books, mine]);

  /** Premium levels for the chart (only on a pane showing this straddle's strike). */
  const levelLines = useMemo<LevelLine[]>(() => {
    if (!open || straddleHealth(open) !== 'OK') return [];
    const out: LevelLine[] = [];
    const entry = open.legs[0].entry + open.legs[1].entry;
    out.push({ id: 'entry', price: entry, title: `${open.side === 'S' ? 'Short' : 'Long'} straddle`, tone: 'entry' });
    const lv = effectiveLevels(open);
    if (lv.targetPct) { const p = premiumAtPct(open, lv.targetPct); if (p !== null) out.push({ id: 'tp', price: p, title: `Target ${lv.targetPct.toFixed(1)}%`, tone: 'target', dashed: true }); }
    const fl = currentFloor(open);
    if (fl) { const p = premiumAtPct(open, fl.floorPct); if (p !== null) out.push({ id: 'sl', price: p, title: fl.kind === 'SL' ? `Stop ${(-fl.floorPct).toFixed(1)}%` : `${fl.kind === 'COST' ? 'Stop at cost' : fl.kind === 'TRAIL' ? 'Trail stop' : 'Lock'} ${fl.floorPct.toFixed(1)}%`, tone: fl.kind === 'SL' ? 'stop' : 'floor', dashed: true }); }
    return out;
  }, [open]);

  return { open: view, closedToday, busy, enter, exitBook, forget, setRules, levelLines, draftRules, setDraftRules };
}

const REASON_TEXT: Record<StraddleExitReason, string> = {
  SL: 'stop loss', TARGET: 'target', TRAIL: 'trailing stop', LOCK: 'profit lock', COST: 'stop at cost', VWAP: 'closed beyond VWAP', EMA: 'closed beyond the EMA', TIME: 'time exit', MANUAL: 'manual',
};
