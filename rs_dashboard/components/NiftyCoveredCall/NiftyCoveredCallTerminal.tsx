'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Shield, RefreshCw, ListChecks, PenLine, Wallet, Link2, BookOpen, ChevronDown, SlidersHorizontal, Table2 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import DeltaPanel from './DeltaPanel';
import HowToUseModal from './HowToUse';
import CoveredCallOptionChainModal from './CoveredCallOptionChainModal';
import TradesPnlModal from './TradesPnlModal';
import TradeSheet, { type OpenCallRow } from './TradeSheet';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useLiveTickerPoll } from '@/lib/useLiveTickerPoll';
import { PctPill } from '@/components/LiveTickerPanel';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';
import {
  reconstructCallLedger,
  summarizeCallTrades,
  callsPerformance,
  reconcileCallsDown,
  computeBook,
  chainLegGreeks,
  suggestCoveredCall,
  coveredCallReturns,
  beesNiftyUnits,
  daysToExpiry,
  type CallTrade,
  type CallMark,
  type OpenCall,
  type PendingOrder,
} from '@/lib/coveredCallEngine';
import { futureQuote, type FutureQuote } from '@/lib/optionsPricing';
import type { CoveredCallBookResponse } from '@/app/api/nifty-covered-call/book/route';
import type { CoveredCallOrderResult } from '@/app/api/nifty-covered-call/order/route';

// ── NIFTYBEES Covered Call desk — Dhan-only, REAL MONEY (calls only).

const TXT_LABEL = 'text-[9px]';
const TXT_VALUE = 'text-[10px]';
const TXT_CAPTION = 'text-[11px]';

const CHAIN_POLL_MS = 3_000;
const BOOK_POLL_MS = 5_000;

function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
const fmtInt = (v: number) => Math.round(v).toLocaleString('en-IN');
const signed = (v: number) => `${v >= 0 ? '+' : '−'}₹${fmtInt(Math.abs(v))}`;

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
}

interface IndicesResponse {
  success: boolean;
  updated_at: string;
  quotes: Record<string, IndexQuote>;
}

function pickIndexLtps(d: IndicesResponse): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof d?.quotes?.NIFTY?.ltp === 'number') out.NIFTY = d.quotes.NIFTY.ltp;
  if (typeof d?.quotes?.VIX?.ltp === 'number') out.VIX = d.quotes.VIX.ltp;
  return out;
}

// ── Commit-on-blur numeric input (dhan-commit-on-blur) ──
function RuleNumInput({ value, onCommit, placeholder, className, ariaLabel }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);
  useEffect(() => { if (!focusedRef.current) setDraft(value); }, [value]);
  const commit = (next: string) => { if (next !== value) onCommit(next); };
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={draft}
      placeholder={placeholder}
      className={className}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => { focusedRef.current = false; commit(e.currentTarget.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

export default function NiftyCoveredCallTerminal() {
  // ── Contracts / market data ─────────────────────────────────────────────
  const [expiries, setExpiries] = useState<string[]>([]);
  const [optionExpiry, setOptionExpiry] = useState<string | null>(null);
  const [lotSize, setLotSize] = useState<number>(0);
  const [chains, setChains] = useState<Record<string, ChainOc>>({});
  // The monthly future from the chain response: each call's Black-76 forward is this rolled to the call's own expiry.
  const [future, setFuture] = useState<FutureQuote | null>(null);
  const [restSpot, setRestSpot] = useState(0);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ── Guide & Option Chain Modals ─────────────────────────────────────────
  const [showGuide, setShowGuide] = useState(false);
  const [showChainModal, setShowChainModal] = useState(false);
  const [showTradesPnl, setShowTradesPnl] = useState(false);

  // ── Broker book (NIFTYBEES + broker CE shorts) ──────────────────────────
  const [book, setBook] = useState<CoveredCallBookResponse | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);

  // ── Own call ledger ─────────────────────────────────────────────────────
  const [trades, setTrades] = useState<CallTrade[]>([]);
  const [pending, setPending] = useState<PendingOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // ── Write-call inputs (commit-on-blur) ──────────────────────────────────
  const [targetDeltaStr, setTargetDeltaStr] = useState('0.25');
  const [manualStrikeStr, setManualStrikeStr] = useState('');
  const [writeLots, setWriteLots] = useState(1);
  const [orderType, setOrderType] = useState<'MARKET' | 'LIMIT'>('LIMIT');
  const [limitStr, setLimitStr] = useState('');
  const [adoptLots, setAdoptLots] = useState<Record<string, number>>({});

  const { liveQuotes, bridgeStatus, transport } = useLiveOptionsWS(optionExpiry ?? '', 'dhan', ['dhan'], 'NIFTY');
  const wsLive = transport === 'ws' && bridgeStatus.status === 'RUNNING';

  // ── Bootstrap ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/options/expiries?underlying=NIFTY')
      .then((r) => r.json())
      .then((j) => {
        if (j.success && Array.isArray(j.data) && j.data.length) {
          setExpiries(j.data);
          setOptionExpiry((prev) => prev ?? j.data[0]);
        }
      })
      .catch(() => {});
    fetch('/api/lotsize?symbol=NIFTY')
      .then((r) => r.json())
      .then((j) => { if (j.lot_size > 0) setLotSize(j.lot_size); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!optionExpiry) return;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying: 'NIFTY', expiry: optionExpiry, broker: 'dhan' }),
    }).catch(() => {});
  }, [optionExpiry]);

  // ── Ledger ──────────────────────────────────────────────────────────────
  const applyLedger = useCallback((j: { trades?: CallTrade[]; pending?: PendingOrder[] }) => {
    if (Array.isArray(j.trades)) setTrades(j.trades);
    if (Array.isArray(j.pending)) setPending(j.pending);
  }, []);
  const reloadLedger = useCallback(async () => {
    try {
      const j = await (await fetch('/api/nifty-covered-call/state')).json();
      if (j.success) applyLedger(j);
    } catch {}
  }, [applyLedger]);
  useEffect(() => { reloadLedger(); }, [reloadLedger]);

  const ledgerAction = useCallback(async (payload: Record<string, unknown>) => {
    const j = await (await fetch('/api/nifty-covered-call/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
    if (j.success) { applyLedger(j); await reloadLedger(); }
    return j as { success: boolean; error?: string; needsPrice?: boolean; gap?: number };
  }, [applyLedger, reloadLedger]);

  const pendingRef = useRef(pending);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  const sweepInFlight = useRef(false);
  const sweepPending = useCallback(async () => {
    if (sweepInFlight.current || pendingRef.current.length === 0) return;
    sweepInFlight.current = true;
    try { await ledgerAction({ action: 'sweep' }); } catch {} finally { sweepInFlight.current = false; }
  }, [ledgerAction]);

  const ledger = useMemo(() => reconstructCallLedger(trades), [trades]);
  const legExpiries = useMemo(() => [...new Set(ledger.open.map((o) => o.expiry))], [ledger.open]);

  // ── Chain polling ───────────────────────────────────────────────────────
  const chainInFlight = useRef(false);
  const tickRef = useRef(0);
  const fetchChain = useCallback(async (expiry: string) => {
    if (chainInFlight.current) return;
    chainInFlight.current = true;
    try {
      const j = await (await fetch(`/api/options/chain?underlying=NIFTY&expiry=${expiry}`)).json();
      if (j.success && j.data) {
        const oc = (j.data.chain?.oc as ChainOc) ?? null;
        if (oc) setChains((prev) => ({ ...prev, [expiry]: oc }));
        if (j.data.spot) setRestSpot(j.data.spot);
        const fq = futureQuote(j.data.future_price, j.data.future_expiry);
        if (fq) setFuture(fq);
        setFeedError(null);
      } else {
        setFeedError(j.error || 'Failed to load option chain');
      }
    } catch (err) {
      setFeedError(String((err as Error).message ?? err));
    } finally {
      setIsLoading(false);
      chainInFlight.current = false;
    }
  }, []);

  const pollChains = useCallback(() => {
    if (!optionExpiry) return;
    const others = legExpiries.filter((e) => e !== optionExpiry);
    const t = tickRef.current++;
    const target = others.length && t % 2 === 1 ? others[Math.floor(t / 2) % others.length] : optionExpiry;
    fetchChain(target);
  }, [optionExpiry, legExpiries, fetchChain]);

  useEffect(() => {
    if (optionExpiry) fetchChain(optionExpiry);
  }, [optionExpiry, fetchChain]);
  useEffect(() => {
    const id = setInterval(pollChains, CHAIN_POLL_MS);
    return () => clearInterval(id);
  }, [pollChains]);

  // ── Book polling ────────────────────────────────────────────────────────
  const bookInFlight = useRef(false);
  const fetchBook = useCallback(async () => {
    if (bookInFlight.current) return;
    bookInFlight.current = true;
    try {
      const j = (await (await fetch('/api/nifty-covered-call/book')).json()) as CoveredCallBookResponse & { error?: string };
      if (j.ts) setBook(j);
      setBookError(j.success ? null : j.error || j.beesError || j.positionsError || 'Broker book unavailable');
    } catch (err) {
      setBookError(String((err as Error).message ?? err));
    } finally {
      bookInFlight.current = false;
    }
  }, []);
  useEffect(() => {
    fetchBook();
    const id = setInterval(() => { fetchBook(); sweepPending(); setNow(Date.now()); }, BOOK_POLL_MS);
    return () => clearInterval(id);
  }, [fetchBook, sweepPending]);

  // ── Live NIFTY & INDIA VIX ticker poll (/api/scalper/top-indices) ───────
  const { data: indicesData } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickIndexLtps);
  const niftyQuote = indicesData?.quotes?.NIFTY;
  const vixQuote = indicesData?.quotes?.VIX;

  // ── Derived market values ───────────────────────────────────────────────
  const spot = liveQuotes?.spot && liveQuotes.spot > 0 ? liveQuotes.spot : restSpot;
  const displayNiftyLtp = (niftyQuote?.ltp && niftyQuote.ltp > 0) ? niftyQuote.ltp : spot;
  const niftyPct = niftyQuote?.change_pct ?? null;
  const vixLtp = vixQuote?.ltp ?? null;
  const vixPct = vixQuote?.change_pct ?? null;

  const bees = book?.bees ?? null;
  const beesQty = bees?.qty ?? 0;
  const beesLtp = bees?.ltp ?? 0;
  const beesUnits = beesNiftyUnits(beesQty, beesLtp, spot);
  const holdingValue = beesQty * beesLtp;

  const callLtp = useCallback((strike: number, expiry: string): number | null => {
    if (expiry === optionExpiry) {
      const ws = liveQuotes?.strikes?.[String(strike)]?.ce?.ltp;
      if (typeof ws === 'number' && ws > 0) return ws;
    }
    const oc = chains[expiry];
    const ce = oc ? lookupChainLegData(oc, strike, 'CE') : undefined;
    return ce && ce.last_price > 0 ? ce.last_price : null;
  }, [liveQuotes, chains, optionExpiry]);

  // ── Reconcile + book snapshot ───────────────────────────────────────────
  const reconciled = useMemo(
    () => reconcileCallsDown(ledger.open, book?.brokerShortUnits ?? null, now),
    [ledger.open, book?.brokerShortUnits, now],
  );

  const marks = useMemo(() => {
    const m: Record<string, CallMark> = {};
    for (const l of reconciled.legs) {
      const oc = chains[l.expiry];
      m[l.id] = { ltp: callLtp(l.strike, l.expiry), chainLeg: oc ? lookupChainLegData(oc, l.strike, 'CE') : undefined, dte: daysToExpiry(l.expiry, now) };
    }
    return m;
  }, [reconciled.legs, chains, callLtp, now]);

  const snapshot = useMemo(() => {
    if (!bees && reconciled.legs.length === 0) return null;
    return computeBook({
      beesQty, beesAvg: bees?.avgCost ?? 0, beesLtp, spot,
      calls: reconciled.legs, marks, callsRealized: ledger.realized, future,
    });
  }, [bees, beesQty, beesLtp, spot, reconciled.legs, marks, ledger.realized, future]);

  const rows: OpenCallRow[] = useMemo(() => reconciled.legs.map((l) => {
    const g = snapshot?.legs.find((x) => x.id === l.id);
    const ltp = marks[l.id]?.ltp ?? null;
    return {
      id: l.id, strike: l.strike, expiry: l.expiry, dte: marks[l.id]?.dte ?? 0,
      units: l.units, ledgerUnits: l.ledgerUnits, entryPrice: l.entryPrice, ltp,
      mtm: ltp != null ? (l.entryPrice - ltp) * l.units : null,
      delta: g?.delta ?? null, theta: g?.theta ?? null, deltaEstimated: g?.deltaEstimated ?? false,
    };
  }), [reconciled.legs, snapshot, marks]);

  // Per-trade P&L and the calls-vs-holding strip. Open MTM per leg comes from the same marks as the table above.
  const tradeSummary = useMemo(() => {
    const mtm: Record<string, number | null> = {};
    for (const r of rows) mtm[r.id] = r.mtm;
    return summarizeCallTrades(trades, mtm, now);
  }, [trades, rows, now]);
  const callsPnl = snapshot ? snapshot.callsOpenPnl + snapshot.callsRealized + snapshot.callsUnsyncedPnl : tradeSummary.total;
  const perf = useMemo(() => callsPerformance({
    callsPnl,
    holdingCost: bees ? bees.avgCost * beesQty : 0,
    holdingPnl: snapshot?.beesPnl ?? null,
    firstTradeTs: trades.length ? Math.min(...trades.map((t) => t.ts)) : null,
    now,
  }), [callsPnl, bees, beesQty, snapshot?.beesPnl, trades, now]);

  // ── Write-call suggestion ───────────────────────────────────────────────
  const parsedDelta = parseFloat(targetDeltaStr);
  const targetDelta = !isNaN(parsedDelta) && parsedDelta > 0
    ? (parsedDelta > 1 && parsedDelta <= 100 ? parsedDelta / 100 : Math.min(0.99, parsedDelta))
    : 0.25;
  const selDte = optionExpiry ? daysToExpiry(optionExpiry, now) : 1;
  const selChain = optionExpiry ? chains[optionExpiry] : undefined;
  const suggestion = useMemo(
    () => (selChain && spot > 0 ? suggestCoveredCall(selChain, spot, beesUnits, lotSize, targetDelta, selDte, { expiry: optionExpiry ?? undefined, future }) : null),
    [selChain, spot, beesUnits, lotSize, targetDelta, selDte, optionExpiry, future],
  );
  const manualStrike = parseFloat(manualStrikeStr) || null;
  const writeStrike = manualStrike ?? suggestion?.strike ?? null;
  const writeLeg = writeStrike && selChain ? lookupChainLegData(selChain, writeStrike, 'CE') : undefined;
  const writeLtp = writeStrike && optionExpiry ? callLtp(writeStrike, optionExpiry) : null;
  const writeUnits = writeLots * lotSize;
  const writeReturns = writeStrike && writeLtp
    ? coveredCallReturns({ premium: writeLtp, units: writeUnits, strike: writeStrike, spot, beesUnits, holdingValue, dte: selDte })
    : null;
  const coverageAfter = beesUnits > 0 ? ((snapshot?.shortCallUnits ?? 0) + writeUnits) / beesUnits : null;

  // Active Trader Net Delta calculation
  const writeGreeks = writeStrike && optionExpiry ? chainLegGreeks('CE', writeStrike, optionExpiry, writeLeg, writeLtp, { spot, future }) : null;
  const writeDeltaPerUnit = writeGreeks ? Math.abs(writeGreeks.delta) : (suggestion?.strikeDelta ?? targetDelta);
  const currentNetDelta = snapshot?.net.delta ?? beesUnits;
  const netDeltaAfter = currentNetDelta - (writeDeltaPerUnit * writeUnits);
  const atmDeltaAfter = currentNetDelta - (0.50 * writeUnits);

  // Seed limit price from live LTP whenever contract changes
  const writeKey = `${optionExpiry}:${writeStrike}`;
  const seededKey = useRef('');
  useEffect(() => {
    if (writeLtp && seededKey.current !== writeKey) {
      seededKey.current = writeKey;
      setLimitStr(writeLtp.toFixed(2));
    }
  }, [writeKey, writeLtp]);

  // ── Order execution ─────────────────────────────────────────────────────
  const placeOrder = useCallback(async (req: {
    side: 'BUY' | 'SELL'; securityId: string; units: number; orderType: 'MARKET' | 'LIMIT'; price?: number;
    strike?: number; expiry?: string; tradingSymbol?: string; openLegId?: string; note?: string;
  }) => {
    const res = await fetch('/api/nifty-covered-call/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const r = (await res.json()) as CoveredCallOrderResult;
    await reloadLedger();
    return r;
  }, [reloadLedger]);

  const withBusy = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { await fn(); } catch (err) { alert(String((err as Error).message ?? err)); } finally {
      busyRef.current = false;
      setBusy(false);
      fetchBook();
    }
  }, [fetchBook]);

  const pendingNote = (r: CoveredCallOrderResult, units: number) =>
    `Order ${r.orderId} is ${r.status}: ${r.filledUnits ?? 0}/${r.units ?? units} units filled and booked so far.\n` +
    'The desk keeps watching it — any later fill is booked automatically.';

  const sellCall = useCallback(async (strike: number, expiry: string, units: number, type: 'MARKET' | 'LIMIT', price: number | undefined, note?: string) => {
    const oc = chains[expiry];
    const ce = oc ? lookupChainLegData(oc, strike, 'CE') : undefined;
    if (!ce?.security_id) throw new Error(`No security id for ${strike} CE ${expiry} — chain not loaded`);
    const r = await placeOrder({
      side: 'SELL', securityId: String(ce.security_id), units, orderType: type, price,
      strike, expiry, tradingSymbol: `NIFTY-${expiry}-${strike}-CE`, note,
    });
    if (!r.success) throw new Error(`Sell ${strike} CE failed: ${r.error ?? r.status}`);
    if (r.pending) alert(pendingNote(r, units));
    return r.filledUnits ?? 0;
  }, [chains, placeOrder]);

  const buyBack = useCallback(async (leg: OpenCall, units: number, note: string) => {
    const r = await placeOrder({ side: 'BUY', securityId: leg.securityId, units, orderType: 'MARKET', openLegId: leg.id, note });
    if (!r.success) throw new Error(`Buy-back of ${leg.strike} CE failed: ${r.error ?? r.status}`);
    if (r.clampedFrom) alert(`Buy-back clamped from ${r.clampedFrom} to ${r.units} units — all that this leg still has short.`);
    if (r.pending) alert(pendingNote(r, units));
    return r.filledUnits ?? 0;
  }, [placeOrder]);

  const legById = useCallback((id: string) => reconciled.legs.find((l) => l.id === id), [reconciled.legs]);

  const handleWrite = () => withBusy(async () => {
    if (!writeStrike || !optionExpiry || !(writeUnits > 0)) throw new Error('Pick a strike, expiry and lots first');
    const price = orderType === 'LIMIT' ? parseFloat(limitStr) : undefined;
    if (orderType === 'LIMIT' && !(price! > 0)) throw new Error('Enter a valid limit price');
    const covMsg = coverageAfter != null && coverageAfter > 1.0001
      ? `\n\n⚠ Deliverable Coverage: ${(coverageAfter * 100).toFixed(0)}% (${(((snapshot?.shortCallUnits ?? 0) + writeUnits) - beesUnits).toFixed(1)} Nifty units deliverable naked).`
      : '';
    const deltaMsg = `\nActive Net Δ: ${netDeltaAfter >= 0 ? '+' : ''}${netDeltaAfter.toFixed(1)} Δ (at ATM: ${atmDeltaAfter >= 0 ? '+' : ''}${atmDeltaAfter.toFixed(1)} Δ).`;
    if (!confirm(`REAL ORDER: SELL ${writeLots} lot(s) (${writeUnits} units) NIFTY ${writeStrike} CE ${optionExpiry} @ ${orderType === 'LIMIT' ? price : 'MARKET'} (NRML).${covMsg}${deltaMsg}`)) return;
    await sellCall(writeStrike, optionExpiry, writeUnits, orderType, price, 'Covered call write');
  });

  const handleBuyBack = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg || leg.units <= 0) return;
    if (!confirm(`REAL ORDER: BUY BACK ${leg.units} units NIFTY ${leg.strike} CE ${leg.expiry} at MARKET?`)) return;
    await buyBack(leg, leg.units, 'Manual buy-back');
  });

  const handleRoll = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg || !writeStrike || !optionExpiry) return;
    const buyPx = row.ltp, sellPx = writeLtp;
    const net = buyPx != null && sellPx != null ? (sellPx - buyPx) * leg.units : null;
    const netMsg = net != null
      ? `\n\nApprox. net ${net >= 0 ? 'CREDIT' : 'DEBIT'} ₹${Math.abs(Math.round(net)).toLocaleString('en-IN')} (buy back ~₹${buyPx!.toFixed(2)}, sell ~₹${sellPx!.toFixed(2)})`
      : '';
    if (!confirm(`REAL ORDERS — ROLL ${leg.units} units:\n1) BUY BACK ${leg.strike} CE ${leg.expiry} at MARKET\n2) SELL ${writeStrike} CE ${optionExpiry} at MARKET (${manualStrike ? 'strike typed in Write panel' : 'strike suggested by Write panel'})${netMsg}\n\nStep 2 only runs if step 1 fully fills.`)) return;
    const closed = await buyBack(leg, leg.units, `Roll → ${writeStrike} ${optionExpiry}`);
    if (closed < leg.units) throw new Error(`Roll stopped: buy-back filled ${closed}/${leg.units}. No new call was written.`);
    await sellCall(writeStrike, optionExpiry, closed, 'MARKET', undefined, `Roll from ${leg.strike} ${leg.expiry}`);
  });

  const handleSync = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg) return;
    const gap = leg.ledgerUnits - leg.units;
    if (gap <= 0) return;
    if (!confirm(`Ledger-only (no order): close ${gap} units of ${leg.strike} CE ${leg.expiry} that the broker no longer shows short?`)) return;
    const j = await ledgerAction({ action: 'sync', legId: leg.id });
    if (j.success) return;
    if (!j.needsPrice) throw new Error(j.error || 'Sync failed');
    const typed = prompt(`${j.error}\n\nEnter the price ${j.gap ?? gap} units were actually closed at (0 if it expired worthless), or Cancel:`);
    if (typed == null || typed.trim() === '') return;
    const px = Number(typed);
    if (!(px >= 0)) throw new Error(`Not a price: ${typed}`);
    const m = await ledgerAction({ action: 'sync', legId: leg.id, manualPrice: px });
    if (!m.success) throw new Error(m.error || 'Sync failed');
  });

  // ── Broker CE shorts not owned by this ledger (Adopt) ───────────────────
  const ledgerUnitsBySid = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of ledger.open) m[l.securityId] = (m[l.securityId] ?? 0) + l.units;
    for (const p of pending) if (p.side === 'SELL') m[p.securityId] = (m[p.securityId] ?? 0) + p.units - p.bookedUnits;
    return m;
  }, [ledger.open, pending]);
  const adoptable = useMemo(() => (book?.brokerCalls ?? [])
    .map((c) => ({ ...c, unowned: c.shortUnits - (ledgerUnitsBySid[c.securityId] ?? 0) }))
    .filter((c) => c.unowned > 0), [book?.brokerCalls, ledgerUnitsBySid]);

  // Calls sold outside the desk are only tracked once adopted — surface them
  // instead of leaving the Adopt panel inside a collapsed section.
  const [advOpen, setAdvOpen] = useState(false);
  const autoOpenedAdopt = useRef(false);
  useEffect(() => {
    if (adoptable.length > 0 && !autoOpenedAdopt.current) {
      autoOpenedAdopt.current = true;
      setAdvOpen(true);
    }
  }, [adoptable.length]);

  const handleAdopt = (c: (typeof adoptable)[number]) => withBusy(async () => {
    const lots = adoptLots[c.securityId] ?? (lotSize > 0 ? Math.floor(c.unowned / lotSize) : 0);
    const cj = await (await fetch(`/api/nifty-covered-call/state?candidates=${c.securityId}`)).json() as {
      success: boolean; error?: string; candidates?: { orderId: string; units: number; price: number; at: number }[];
    };
    if (!cj.success) throw new Error(cj.error || 'Trade book unavailable');
    const cands = [...(cj.candidates ?? [])].sort((x, y) => x.at - y.at);
    // Sells found in today's trade book are adopted directly at their own fill
    // price — no prompt. Each call is capped server-side at the unowned units,
    // so stop at the first 409 once the short is fully claimed.
    if (cands.length > 0) {
      let adopted = 0;
      for (const o of cands) {
        const r = await ledgerAction({ action: 'adopt', securityId: c.securityId, orderId: o.orderId });
        if (r.success) { adopted++; continue; }
        if (adopted > 0) break;
        throw new Error(r.error || 'Adopt failed');
      }
      return;
    }
    // Nothing in today's trade book (sold on an earlier day): price must be typed.
    const typed = prompt(
      `Adopt ${c.tradingSymbol} (ledger only, no order).\n\n` +
      `No sells on this contract in today's trade book.\n\n` +
      `Enter the sell price per unit to adopt ${lots * lotSize} units (e.g. 98.5).`,
    );
    if (typed == null || typed.trim() === '') return;
    const px = Number(typed.trim().replace(/^p/i, ''));
    const units = Math.min(c.unowned, lots * lotSize);
    if (!(px > 0)) throw new Error(`Not a price: ${typed}`);
    if (!(units > 0)) throw new Error('Choose at least one lot to adopt');
    const j = await ledgerAction({ action: 'adopt', securityId: c.securityId, manualPrice: px, units });
    if (!j.success) throw new Error(j.error || 'Adopt failed');
  });

  // ── Headline numbers ────────────────────────────────────────────────────
  const totalPnl = snapshot?.totalPnl ?? null;
  const effCost = bees && beesQty > 0 && snapshot
    ? bees.avgCost - (snapshot.callsRealized + snapshot.callsOpenPnl + snapshot.callsUnsyncedPnl) / beesQty
    : null;
  const inputCls = cn(TXT_CAPTION, 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-100 font-mono');

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* GUIDE MODAL */}
      <HowToUseModal isOpen={showGuide} onClose={() => setShowGuide(false)} />

      <TradesPnlModal isOpen={showTradesPnl} onClose={() => setShowTradesPnl(false)} summary={tradeSummary} />

      {/* OPTION CHAIN MODAL */}
      <CoveredCallOptionChainModal
        isOpen={showChainModal}
        onClose={() => setShowChainModal(false)}
        spot={displayNiftyLtp}
        expiries={expiries}
        currentExpiry={optionExpiry}
        onSelectExpiry={(exp) => {
          setOptionExpiry(exp);
          fetchChain(exp);
        }}
        chains={chains}
        future={future}
        selectedStrike={writeStrike}
        onSelectStrike={(strike, delta) => {
          setManualStrikeStr(String(strike));
          if (delta && delta > 0) {
            setTargetDeltaStr(delta.toFixed(2));
          }
        }}
        lotSize={lotSize}
        onRefresh={() => {
          if (optionExpiry) fetchChain(optionExpiry);
        }}
      />

      {/* STICKY HEADER */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-4 lg:px-6 py-2 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className={cn(TXT_LABEL, 'font-bold text-emerald-400 uppercase tracking-[0.18em]')}>NIFTYBEES COVERED CALL</span>
              <span className={cn(TXT_LABEL, 'font-mono px-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold')}>DATA: {todayIST()}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {/* NIFTY Ticker */}
              <div className="flex items-center gap-1.5 font-mono px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800">
                <span className="text-[10px] font-bold text-zinc-400">NIFTY</span>
                <span className={cn(TXT_CAPTION, 'font-bold text-white')}>
                  {displayNiftyLtp > 0 ? displayNiftyLtp.toFixed(2) : '—'}
                </span>
                <PctPill v={niftyPct} />
                <LiveBadge live={wsLive} />
              </div>

              {/* INDIA VIX Ticker */}
              <div
                className="flex items-center gap-1.5 font-mono px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800"
                title="India VIX: Measures expected 30-day market volatility"
              >
                <span className="text-[10px] font-bold text-amber-400/90">INDIA VIX</span>
                <span className={cn(TXT_CAPTION, 'font-bold text-amber-300')}>
                  {vixLtp != null && vixLtp > 0 ? vixLtp.toFixed(2) : '—'}
                </span>
                <PctPill v={vixPct} />
              </div>

              {/* NIFTYBEES Holding Ticker */}
              <div className="flex items-center gap-1.5 font-mono px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800">
                <span className="text-[10px] font-bold text-emerald-400">NIFTYBEES</span>
                <span className={cn(TXT_CAPTION, 'font-bold text-white')}>
                  {beesLtp > 0 ? `₹${beesLtp.toFixed(2)}` : '—'}
                </span>
                {bees?.ltpSource === 'holdings' && (
                  <span className={cn(TXT_LABEL, 'text-amber-300 font-bold')} title="Holdings quote used">
                    HOLDINGS
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry Selector Pills */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 flex-wrap">
            {expiries.slice(0, 4).map((e) => (
              <button
                key={e}
                onClick={() => setOptionExpiry(e)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs font-mono font-bold transition-all',
                  optionExpiry === e ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm' : 'text-zinc-400 hover:text-white',
                )}
              >
                {e}
              </button>
            ))}
            {expiries.length > 4 && (
              <select
                aria-label="More expiries"
                value={expiries.indexOf(optionExpiry ?? '') >= 4 ? (optionExpiry ?? '') : ''}
                onChange={(ev) => { if (ev.target.value) setOptionExpiry(ev.target.value); }}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold bg-zinc-900 outline-none cursor-pointer',
                  expiries.indexOf(optionExpiry ?? '') >= 4 ? 'text-emerald-300 border border-emerald-500/40' : 'text-zinc-400',
                )}
              >
                <option value="">More…</option>
                {expiries.slice(4).map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            )}
          </div>

          {/* Option Chain Button */}
          <button
            onClick={() => setShowChainModal(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
            title="Open NIFTY Option Chain Table"
          >
            <Table2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Option Chain</span>
          </button>

          {/* Trades P&L Button */}
          <button
            onClick={() => setShowTradesPnl(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
            title="P&L of every call written against NIFTYBEES on this desk"
          >
            <ListChecks className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Trades P&L</span>
          </button>

          {/* Guide Button */}
          <button
            onClick={() => setShowGuide(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
            title="How to use this desk"
          >
            <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden sm:inline">Guide</span>
          </button>

          {/* Refresh */}
          <button
            onClick={() => { if (optionExpiry) fetchChain(optionExpiry); fetchBook(); }}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-cyan-400 transition-colors"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin text-cyan-400')} />
          </button>

          <NavBar />
        </div>
      </div>

      {(feedError || bookError) && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/40 text-xs text-rose-300 space-y-0.5">
          {feedError && <div>Option chain: {feedError}</div>}
          {bookError && <div>Broker book: {bookError}</div>}
        </div>
      )}

      {/* TOP 5 EXECUTIVE KPI CARDS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 px-4 pt-4">
        {/* Card 1: NIFTYBEES Holding */}
        <StatTile
          label="NIFTYBEES Holding"
          tooltip="Total NIFTYBEES shares in your Dhan account (Demat DP + T1 settling + today's delivery buys), converted to cash value and Nifty index-equivalent capacity."
          value={holdingValue}
          raw
          sub={bees ? `${fmtInt(beesQty)} shares @ ₹${bees.avgCost.toFixed(2)} · LTP ${beesLtp > 0 ? `₹${beesLtp.toFixed(2)}` : "—"}` : 'Loading holdings…'}
          badge={lotSize > 0 ? `${(beesUnits / lotSize).toFixed(1)} L Capacity` : undefined}
        />

        {/* Card 2: Coverage Status */}
        <CoverageTile
          book={snapshot}
          lotSize={lotSize}
          beesUnits={beesUnits}
        />

        {/* Card 3: Option Income */}
        <StatTile
          label="Calls Open MTM"
          tooltip="Current mark-to-market profit/loss on active short calls. As the calls decay towards 0, this profit increases."
          value={snapshot ? snapshot.callsOpenPnl : null}
          sub={`${rows.filter((r) => r.units > 0).length} open · ₹${fmtInt(ledger.realized)} realized`}
        />

        {/* Card 4: Total Strategy P&L */}
        <StatTile
          label="Total Strategy P&L"
          tooltip="Combined net profit/loss: NIFTYBEES unrealized capital gain/loss + all option premiums collected (both open MTM and closed realized)."
          value={totalPnl}
          emphasis
          sub={snapshot ? `Holding ${signed(snapshot.beesPnl ?? 0)} · Calls ${signed(snapshot.callsOpenPnl + ledger.realized)}` : 'Holding + Calls'}
        />

        {/* Card 5: Effective Cost */}
        <StatTile
          label="Effective Cost / BEES"
          tooltip="Your reduced purchase cost per share: Original Avg Cost minus option premium profits per share. Shows how much option income has discounted your stock."
          value={effCost}
          raw
          sub={bees && effCost != null ? `Subsidized by ₹${(bees.avgCost - effCost).toFixed(2)}/unit (-${(((bees.avgCost - effCost) / bees.avgCost) * 100).toFixed(1)}%)` : undefined}
        />
      </div>

      {/* PERFORMANCE STRIP: calls against the NIFTYBEES holding */}
      <div className="mx-4 mt-3 rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-1">
        <span className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold tracking-wide')}>Calls vs NIFTYBEES</span>
        <PerfItem label="Holding only" value={perf.holdingOnly != null ? signed(perf.holdingOnly) : '—'} tone={perf.holdingOnly} />
        <PerfItem label="With calls" value={perf.withCalls != null ? signed(perf.withCalls) : '—'} tone={perf.withCalls} />
        <PerfItem label="Calls added" value={signed(callsPnl)} tone={callsPnl} />
        <PerfItem label="% of holding cost" value={perf.pctOfCost != null ? `${perf.pctOfCost.toFixed(2)}%` : '—'} tone={perf.pctOfCost} />
        <PerfItem
          label={`Annualised${perf.days >= 1 ? ` (${Math.floor(perf.days)}d)` : ''}`}
          value={perf.annualisedPct != null ? `${perf.annualisedPct.toFixed(1)}%` : perf.days > 0 ? 'after 7 days' : '—'}
          tone={perf.annualisedPct}
        />
        <PerfItem label="Win rate (closed)" value={tradeSummary.closedCount ? `${tradeSummary.wins}/${tradeSummary.closedCount}` : '—'} tone={null} />
        <PerfItem label="Premium sold" value={`₹${fmtInt(tradeSummary.premiumSold)}`} tone={null} />
        <span className="text-[10px] text-zinc-500">Holding P&L is since your buy, not since the first call.</span>
      </div>

      {/* MAIN 2-COLUMN WORKSPACE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 p-4">
        {/* LEFT COLUMN: ACTIVE COVERED CALLS (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <TradeSheet
            rows={rows}
            history={trades}
            lotSize={lotSize}
            busy={busy}
            rollTarget={writeStrike && optionExpiry ? {
              strike: writeStrike,
              expiry: optionExpiry,
              basis: manualStrike
                ? 'the strike you typed in Write Covered Call'
                : `the strike the Write Covered Call panel suggests for ${(targetDelta * 100).toFixed(0)}Δ target delta`,
            } : null}
            onBuyBack={handleBuyBack}
            onRoll={handleRoll}
            onSyncLedger={handleSync}
          />
        </div>

        {/* RIGHT COLUMN: WRITE COVERED CALL (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-4 space-y-3 shadow-sm">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2.5">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded bg-rose-500/10 flex items-center justify-center">
                  <PenLine className="w-3.5 h-3.5 text-rose-400" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-zinc-100 uppercase tracking-wide">Write Covered Call</h3>
                  <div className="text-[10px] text-zinc-500">Sell OTM NIFTY call against NIFTYBEES</div>
                </div>
              </div>
              <div className="text-right font-mono">
                <span className="text-xs font-bold text-zinc-200">{optionExpiry ?? '—'}</span>
                <span className="text-[10px] text-zinc-500 ml-1.5 font-sans">({selDte.toFixed(0)}d DTE)</span>
              </div>
            </div>

            {/* Quick Delta Preset Pills + Custom Delta Input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px] text-zinc-500 uppercase font-bold mb-1">
                <MetricTooltip
                  label="Target Delta (Probability)"
                  text="Roughly represents the probability of the call expiring in-the-money. Lower delta means further OTM (higher probability of expiring worthless, safer). Higher delta yields more upfront cash credit."
                />
                <div className="flex items-center gap-2">
                  {manualStrike ? (
                    <button onClick={() => setManualStrikeStr('')} className="text-emerald-400 hover:underline">
                      Reset to Auto Strike
                    </button>
                  ) : suggestion ? (
                    <span className="text-[10px] font-mono text-zinc-400 lowercase">
                      matched <span className="text-emerald-400 font-bold">{suggestion.strikeDelta} Δ</span> ({suggestion.strike} CE)
                    </span>
                  ) : null}
                </div>
              </div>

              {/* 3 Quick Presets */}
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { label: '0.15 Δ Safe', val: '0.15', desc: '~85% OTM' },
                  { label: '0.25 Δ Sweet', val: '0.25', desc: '~75% OTM' },
                  { label: '0.35 Δ Aggressive', val: '0.35', desc: '~65% OTM' },
                ].map((p) => {
                  const isSelected = Math.abs(targetDelta - parseFloat(p.val)) < 0.005 && !manualStrike;
                  return (
                    <button
                      key={p.val}
                      type="button"
                      onClick={() => { setTargetDeltaStr(p.val); setManualStrikeStr(''); }}
                      className={cn(
                        'px-2 py-1.5 rounded-lg border text-left transition-all',
                        isSelected
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                      )}
                    >
                      <div className="text-[11px] font-bold font-mono">{p.label}</div>
                      <div className="text-[9px] text-zinc-500">{p.desc}</div>
                    </button>
                  );
                })}
              </div>

              {/* Custom Delta Scrub / Stepper / Free Input Bar */}
              <div className="flex items-center gap-2 rounded-lg bg-zinc-900/80 border border-zinc-800/80 px-2.5 py-1.5">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wide whitespace-nowrap">
                  Custom Δ
                </span>

                {/* Slider */}
                <input
                  type="range"
                  min="0.05"
                  max="0.50"
                  step="0.01"
                  value={Math.min(0.50, Math.max(0.05, targetDelta))}
                  onChange={(e) => {
                    setTargetDeltaStr(Number(e.target.value).toFixed(2));
                    setManualStrikeStr('');
                  }}
                  className="flex-1 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                  aria-label="Target Delta slider"
                />

                {/* Steppers */}
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    title="Decrease delta by 0.01"
                    onClick={() => {
                      const next = Math.max(0.02, Math.round((targetDelta - 0.01) * 100) / 100);
                      setTargetDeltaStr(next.toFixed(2));
                      setManualStrikeStr('');
                    }}
                    className="w-5 h-6 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-bold transition-colors"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    title="Increase delta by 0.01"
                    onClick={() => {
                      const next = Math.min(0.90, Math.round((targetDelta + 0.01) * 100) / 100);
                      setTargetDeltaStr(next.toFixed(2));
                      setManualStrikeStr('');
                    }}
                    className="w-5 h-6 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-bold transition-colors"
                  >
                    +
                  </button>
                </div>

                {/* Exact Numeric Input (Commit-on-blur) */}
                <div className="w-16 relative">
                  <RuleNumInput
                    value={targetDeltaStr}
                    onCommit={(val) => {
                      let n = parseFloat(val);
                      if (isNaN(n) || n <= 0) return;
                      if (n > 1 && n <= 100) n = n / 100;
                      n = Math.min(0.99, Math.max(0.01, Math.round(n * 1000) / 1000));
                      setTargetDeltaStr(String(n));
                      setManualStrikeStr('');
                    }}
                    placeholder="0.25"
                    className={cn(inputCls, 'h-6 px-1.5 text-xs font-mono text-center font-bold text-emerald-400')}
                    ariaLabel="Desired Target Delta input"
                  />
                </div>

                {/* Estimated OTM % indicator */}
                <span className="text-[10px] font-mono text-zinc-400 whitespace-nowrap">
                  ~{Math.round((1 - Math.min(0.99, targetDelta)) * 100)}% OTM
                </span>
              </div>
            </div>

            {/* Strike & Lots Pickers */}
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[10px] font-bold text-zinc-400 uppercase">
                    <MetricTooltip
                      label="Strike Price"
                      text="The price above which your stock upside is capped and you may have to buy back or roll the call."
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowChainModal(true)}
                    className="text-[10px] text-emerald-400 hover:text-emerald-300 font-bold hover:underline flex items-center gap-1 font-mono"
                    title="Open Option Chain Table"
                  >
                    <Table2 className="w-3 h-3" />
                    Chain Table ↗
                  </button>
                </div>
                <div className="relative">
                  <RuleNumInput
                    value={manualStrikeStr}
                    onCommit={setManualStrikeStr}
                    placeholder={suggestion ? String(suggestion.strike) : 'Auto strike'}
                    className={cn(inputCls, 'h-9 px-3 text-sm')}
                    ariaLabel="Strike (blank = suggested)"
                  />
                  {suggestion && !manualStrike && (
                    <span className="absolute right-2 top-2 text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-bold">
                      AUTO
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-zinc-400 uppercase mb-1">
                  <MetricTooltip
                    label="Quantity (Lots)"
                    text="Number of NIFTY option contracts to sell (1 lot = 65 units). Ensure your NIFTYBEES holding can cover this quantity to avoid naked risk."
                  />
                </label>
                <select
                  value={writeLots}
                  onChange={(e) => setWriteLots(Number(e.target.value))}
                  className={cn(inputCls, 'h-9 px-3 text-sm')}
                >
                  {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                    const coveredMax = suggestion?.coveredLots ?? 1;
                    const isExceeding = n > coveredMax;
                    return (
                      <option key={n} value={n}>
                        {n} Lot{n > 1 ? 's' : ''} ({n * lotSize}u) {isExceeding ? '⚠ Uncovered' : '✓ Covered'}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            {/* Projected Income & Metrics Box */}
            <div className="rounded-xl bg-zinc-900/70 border border-zinc-800/80 p-3 space-y-2">
              <div className="flex items-center justify-between border-b border-zinc-800/60 pb-1.5">
                <MetricTooltip
                  label="Contract Premium (LTP)"
                  text="Current market price per unit of this option contract. You receive this amount upfront as an option seller."
                />
                <span className="text-sm font-bold font-mono text-emerald-400">
                  {writeLtp != null ? `₹${writeLtp.toFixed(2)}` : '—'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-0.5 text-xs font-mono">
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Upfront Credit:"
                    text="Total immediate cash credited to your account upon selling the call (Premium × Lots × Lot Size)."
                  />
                  <span className="font-bold text-white">
                    {writeReturns ? `+₹${fmtInt(writeReturns.credit)}` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Static Yield:"
                    text="Immediate cash return on your total NIFTYBEES holding value if NIFTY stays flat or below the strike until expiry. Annualized based on DTE."
                  />
                  <span className="font-bold text-emerald-400">
                    {writeReturns ? `${writeReturns.staticPct.toFixed(2)}%` : '—'}
                    {writeReturns && <span className="text-[10px] text-zinc-500 ml-1 font-sans">({writeReturns.staticAnnualPct.toFixed(0)}% a)</span>}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="OTM Distance:"
                    text="How many points and percentage NIFTY spot must rise before reaching this strike price."
                  />
                  <span className="text-zinc-300">
                    {writeStrike && spot > 0 ? `+${(writeStrike - spot).toFixed(0)} pts (${(((writeStrike - spot) / spot) * 100).toFixed(1)}%)` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Downside Cushion:"
                    text="How many index points NIFTY can drop before your net strategy enters a loss. The option premium buffers your stock against market dips."
                  />
                  <span className="text-sky-300">
                    {writeReturns ? `${writeReturns.protectionPts.toFixed(0)} pts (${writeReturns.protectionPct.toFixed(2)}%)` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="If Called Max:"
                    text="Maximum potential profit if NIFTY rallies to or beyond the strike price (Upfront premium cash + stock capital gain up to strike)."
                  />
                  <span className="text-zinc-300">
                    {writeReturns ? `${writeReturns.ifCalledPct.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Coverage After:"
                    text="Deliverable Unit Coverage: Ratio of short call units sold vs your NIFTYBEES capacity. >100% means more units are sold than shares held (deliverable naked)."
                  />
                  <span className={cn('font-bold', coverageAfter != null && coverageAfter > 1.0001 ? 'text-amber-400' : 'text-emerald-400')}>
                    {coverageAfter != null ? `${(coverageAfter * 100).toFixed(0)}% ${coverageAfter > 1.0001 ? '⚠ Naked' : '✓ Safe'}` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Net Δ After:"
                    text="Active Delta Overlay: Net directional exposure after this trade (NIFTYBEES delta minus short call delta). ~0 Δ indicates delta-neutral balance. An active trader manages this dynamically."
                  />
                  <span className={cn('font-mono font-bold', Math.abs(netDeltaAfter) <= 10 ? 'text-emerald-400' : netDeltaAfter > 0 ? 'text-sky-300' : 'text-amber-400')}>
                    {netDeltaAfter != null ? `${netDeltaAfter >= 0 ? '+' : ''}${netDeltaAfter.toFixed(1)} Δ ${Math.abs(netDeltaAfter) <= 5 ? '(Neutral)' : netDeltaAfter > 0 ? '(Long)' : '(Short)'}` : '—'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <MetricTooltip
                    label="Net Δ if ATM:"
                    text="Convexity & Gamma Risk: If NIFTY rallies to this strike, call delta rises to ~0.50. Net delta flips negative unless actively rolled or hedged as the spot approaches."
                  />
                  <span className={cn('font-mono', atmDeltaAfter < -20 ? 'text-amber-400/90' : 'text-zinc-300')}>
                    {atmDeltaAfter != null ? `${atmDeltaAfter >= 0 ? '+' : ''}${atmDeltaAfter.toFixed(1)} Δ` : '—'}
                  </span>
                </div>
              </div>
            </div>

            {/* Order Type Toggle + Limit Input */}
            <div className="flex items-center gap-2 pt-1">
              <div className="flex bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
                {(['LIMIT', 'MARKET'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setOrderType(t)}
                    className={cn(
                      'px-2.5 py-1 rounded text-xs font-bold transition-all',
                      orderType === t ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
              {orderType === 'LIMIT' && (
                <div className="flex-1 relative">
                  <span className="absolute left-2 top-1.5 text-xs text-zinc-500">₹</span>
                  <RuleNumInput
                    value={limitStr}
                    onCommit={setLimitStr}
                    className={cn(inputCls, 'pl-5 h-8 text-xs font-bold')}
                    ariaLabel="Limit price"
                    placeholder="Limit Price"
                  />
                </div>
              )}
            </div>

            {/* Execute Button */}
            <Button
              size="lg"
              variant="outline"
              disabled={busy || !writeStrike || !writeLeg?.security_id || !(lotSize > 0)}
              onClick={handleWrite}
              className="w-full h-11 bg-rose-500/20 border-rose-500/40 text-rose-300 font-bold hover:bg-rose-500/30 hover:text-rose-100 text-sm shadow-sm transition-all"
            >
              SELL {writeLots} × {writeStrike ?? '—'} CE · COLLECT ₹{writeReturns ? fmtInt(writeReturns.credit) : '—'}
            </Button>

            <div className="text-[10px] text-zinc-500 text-center">
              NRML order · Carried to expiry · Real fills booked automatically
              {pending.length > 0 && <span className="text-amber-300 block">⚠ {pending.length} order(s) still working</span>}
            </div>
          </div>
        </div>
      </div>

      {/* COLLAPSIBLE ADVANCED DETAILS & GREEKS */}
      <div className="px-4 pb-8">
        {adoptable.length > 0 && !advOpen && (
          <button
            type="button"
            onClick={() => setAdvOpen(true)}
            className="w-full mb-3 flex items-center gap-2 px-4 py-2.5 rounded-xl border border-sky-500/40 bg-sky-500/10 text-xs font-bold text-sky-300 hover:bg-sky-500/20 transition-colors"
          >
            <Link2 className="w-4 h-4" />
            {adoptable.length} NIFTY call short{adoptable.length > 1 ? 's' : ''} sold outside this desk — click to choose which to track
          </button>
        )}
        <details
          open={advOpen}
          onToggle={(e) => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="group bg-zinc-950/40 border border-zinc-800/60 rounded-xl overflow-hidden"
        >
          <summary className="flex items-center justify-between px-4 py-2.5 cursor-pointer select-none text-xs font-bold text-zinc-300 uppercase tracking-wide hover:bg-zinc-900/40 transition-colors">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
              Advanced Portfolio Breakdown, Greeks &amp; Unlinked Broker Shorts
            </span>
            <ChevronDown className="w-4 h-4 text-zinc-400 transition-transform group-open:rotate-180" />
          </summary>

          <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-zinc-800/60">
            {/* Greeks */}
            <DeltaPanel book={snapshot} spot={spot} beesLtp={beesLtp} lotSize={lotSize} />

            {/* Holding Breakdown */}
            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-3 space-y-2">
              <div className="text-xs font-bold text-zinc-200 uppercase tracking-wide flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-emerald-400" /> NIFTYBEES Holding Breakdown
              </div>
              {bees ? (
                <div className="space-y-1.5 text-xs font-mono">
                  <Kv label="Demat (DP)" value={`${fmtInt(bees.dpQty)} shares`} />
                  <Kv label="T1 (settling)" value={`${fmtInt(bees.t1Qty)} shares`} />
                  <Kv label="Bought today" value={`${fmtInt(bees.todayQty)} shares`} />
                  <Kv label="Avg purchase cost" value={`₹${bees.avgCost.toFixed(2)}`} />
                  <Kv label="Holding Value" value={`₹${fmtInt(holdingValue)}`} />
                  <Kv label="Nifty-equivalent" value={`${beesUnits.toFixed(1)} units`} />
                  <Kv label="= Lots capacity" value={lotSize > 0 ? (beesUnits / lotSize).toFixed(2) : '—'} />
                  <Kv label="Nifty pts per ₹1 of BEES" value={beesLtp > 0 && spot > 0 ? `1 : ${(spot / beesLtp).toFixed(1)}` : '—'} />
                </div>
              ) : (
                <div className="text-xs text-zinc-500">{book?.beesError ?? 'Loading holdings…'}</div>
              )}
            </div>

            {/* Adoptable Broker Shorts */}
            <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-3 space-y-2">
              <div className="text-xs font-bold text-zinc-200 uppercase tracking-wide flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-sky-400" /> Broker Shorts (Outside This Desk)
              </div>
              {adoptable.length === 0 ? (
                <div className="text-xs text-zinc-500 py-2">
                  {book?.brokerShortUnits == null ? 'Positions unavailable.' : 'Every NIFTY CE short at the broker is already in this book (or there are none).'}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-[11px] text-zinc-400">
                    Calls sold outside this desk that you want to track against NIFTYBEES:
                  </div>
                  {adoptable.map((c) => {
                    const maxLots = lotSize > 0 ? Math.floor(c.unowned / lotSize) : 0;
                    const lots = Math.min(adoptLots[c.securityId] ?? maxLots, maxLots);
                    return (
                      <div key={c.securityId} className="flex items-center justify-between gap-2 p-2 rounded bg-zinc-950/60 border border-zinc-800 text-xs">
                        <div className="font-mono">
                          <span className="font-bold text-zinc-200">{c.strike} CE</span>
                          <span className="text-zinc-500 ml-1">{c.expiry}</span>
                          <div className="text-[10px] text-zinc-400">{c.unowned}u @ ₹{c.sellAvg.toFixed(1)}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <select
                            value={lots}
                            aria-label={`Lots to adopt for ${c.tradingSymbol}`}
                            onChange={(e) => setAdoptLots((p) => ({ ...p, [c.securityId]: Number(e.target.value) }))}
                            className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 font-mono"
                          >
                            {Array.from({ length: maxLots + 1 }, (_, i) => i).map((n) => <option key={n} value={n}>{n}L</option>)}
                          </select>
                          <Button size="xs" variant="outline" disabled={busy || lots <= 0} onClick={() => handleAdopt(c)}
                            className="bg-sky-500/20 border-sky-500/40 text-sky-300 font-bold hover:bg-sky-500/30">
                            ADOPT
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

function LiveBadge({ live }: { live: boolean }) {
  return (
    <Badge className={cn('text-[8px] h-4 px-1 rounded font-bold border',
      live ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border-amber-500/40')}>
      {live ? 'LIVE' : 'POLL'}
    </Badge>
  );
}

function MetricTooltip({
  label,
  text,
  className,
}: {
  label: React.ReactNode;
  text: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn('cursor-help inline-flex items-center gap-0.5 border-b border-dotted border-zinc-600 hover:border-zinc-300 transition-colors', className)}>
            {label}
          </span>
        }
      />
      <TooltipContent className="max-w-xs text-xs p-2.5 bg-zinc-900 border border-zinc-700 text-zinc-200 shadow-xl rounded-lg leading-relaxed z-50">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function PerfItem({ label, value, tone }: { label: string; value: string; tone: number | null }) {
  const cls = tone == null ? 'text-zinc-100' : tone > 0 ? 'text-emerald-400' : tone < 0 ? 'text-rose-400' : 'text-zinc-200';
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <span className={cn('font-mono text-xs font-bold', cls)}>{value}</span>
    </div>
  );
}

function StatTile({
  label,
  tooltip,
  value,
  sub,
  emphasis,
  raw,
  badge,
}: {
  label: string;
  tooltip?: string;
  value: number | null;
  sub?: string;
  emphasis?: boolean;
  raw?: boolean;
  badge?: string;
}) {
  const tone = raw ? 'text-zinc-100' : value == null ? 'text-zinc-600' : value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-zinc-200';
  return (
    <div className={cn('rounded-xl border px-3 py-2 flex flex-col justify-between', emphasis ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800/60 bg-zinc-950/40')}>
      <div className="flex items-center justify-between">
        {tooltip ? (
          <MetricTooltip label={<span className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold tracking-wide')}>{label}</span>} text={tooltip} />
        ) : (
          <span className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold tracking-wide')}>{label}</span>
        )}
        {badge && (
          <span className="text-[9px] font-mono font-bold px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
            {badge}
          </span>
        )}
      </div>
      <div className={cn(emphasis ? 'text-lg' : 'text-base', 'font-bold font-mono tabular-nums my-0.5', tone)}>
        {value == null ? '—' : raw ? `₹${fmtInt(value)}` : signed(value)}
      </div>
      {sub && <div className={cn(TXT_VALUE, 'text-zinc-500 truncate')} title={sub}>{sub}</div>}
    </div>
  );
}

function CoverageTile({
  book,
  lotSize,
  beesUnits,
}: {
  book: import('@/lib/coveredCallEngine').BookSnapshot | null;
  lotSize: number;
  beesUnits: number;
}) {
  const cov = book?.coverage ?? null;
  const covPct = cov != null ? Math.round(cov * 100) : null;
  const isOver = cov != null && cov > 1.0001;
  const shortUnits = book?.shortCallUnits ?? 0;
  const shortLots = lotSize > 0 ? (shortUnits / lotSize) : 0;
  const totalLots = lotSize > 0 ? (beesUnits / lotSize) : 0;
  const netDelta = book?.net.delta ?? beesUnits;

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <MetricTooltip
          label={<span className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold tracking-wide')}>Coverage & Delta</span>}
          text="Deliverable coverage (short calls vs stock capacity) and current Net Directional Delta (NIFTYBEES delta minus short call delta)."
        />
        {covPct != null && (
          <span className={cn('text-[9px] font-bold px-1.5 py-0.2 rounded-full font-mono', isOver ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300')}>
            {isOver ? '⚠ OVER' : '✓ SAFE'}
          </span>
        )}
      </div>

      <div className="my-0.5">
        <div className="flex items-baseline justify-between">
          <div className={cn('text-base font-bold font-mono tabular-nums', covPct == null ? 'text-zinc-600' : isOver ? 'text-amber-400' : 'text-emerald-400')}>
            {covPct == null ? '—' : `${covPct}% Covered`}
          </div>
          <div className="text-xs font-bold font-mono text-zinc-300" title="Net Portfolio Delta">
            {beesUnits > 0 ? `${netDelta >= 0 ? '+' : ''}${netDelta.toFixed(1)} Δ` : '—'}
          </div>
        </div>

        {/* Mini progress bar */}
        <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden mt-1 relative">
          <div
            className={cn('h-full rounded-full transition-all', isOver ? 'bg-amber-400' : 'bg-emerald-400')}
            style={{ width: `${Math.min(100, covPct ?? 0)}%` }}
          />
        </div>
      </div>

      <div className={cn(TXT_VALUE, 'text-zinc-400 truncate font-mono flex justify-between')}>
        <span>{shortLots.toFixed(shortUnits % lotSize ? 1 : 0)} of {totalLots.toFixed(1)} lots</span>
        <span className="text-zinc-500">{Math.abs(netDelta) <= 5 ? 'Neutral' : netDelta > 0 ? 'Net Long' : 'Net Short'}</span>
      </div>
    </div>
  );
}

function Kv({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={cn(TXT_VALUE, 'flex justify-between gap-2 font-mono')}>
      <span className="text-zinc-500">{label}</span>
      <span className={tone === 'warn' ? 'text-amber-300 font-bold' : 'text-zinc-200'}>{value}</span>
    </div>
  );
}
