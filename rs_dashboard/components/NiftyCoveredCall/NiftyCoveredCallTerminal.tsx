'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Shield, RefreshCw, PenLine, Wallet, Link2 } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import DeltaPanel from './DeltaPanel';
import TradeSheet, { type OpenCallRow } from './TradeSheet';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';
import {
  reconstructCallLedger,
  reconcileCallsDown,
  computeBook,
  suggestCoveredCall,
  coveredCallReturns,
  beesNiftyUnits,
  daysToExpiry,
  type CallTrade,
  type CallMark,
  type OpenCall,
} from '@/lib/coveredCallEngine';
import type { CoveredCallBookResponse } from '@/app/api/nifty-covered-call/book/route';
import type { CoveredCallOrderResult } from '@/app/api/nifty-covered-call/order/route';

// ── NIFTYBEES Covered Call desk — Dhan-only, REAL MONEY (calls only).
//
// The long leg is the NIFTYBEES holding, read from Dhan holdings + today's CNC
// position by /api/nifty-covered-call/book; this page never orders NIFTYBEES.
// The short legs are NIFTY index calls owned by this page's own ledger
// (/api/nifty-covered-call/state) — the account carries CE shorts from other
// strategies, so a broker short is only part of this book once sold here or
// explicitly adopted (dhan-terminal-position-ownership). The ledger is
// reconciled DOWN against the broker every poll, never up.

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
  const [restSpot, setRestSpot] = useState(0);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ── Broker book (NIFTYBEES + broker CE shorts) ──────────────────────────
  const [book, setBook] = useState<CoveredCallBookResponse | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);

  // ── Own call ledger ─────────────────────────────────────────────────────
  const [trades, setTrades] = useState<CallTrade[]>([]);
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
  const reloadLedger = useCallback(async () => {
    try {
      const j = await (await fetch('/api/nifty-covered-call/state')).json();
      if (j.success && Array.isArray(j.trades)) setTrades(j.trades);
    } catch {}
  }, []);
  useEffect(() => { reloadLedger(); }, [reloadLedger]);

  const logTrade = useCallback(async (row: Omit<CallTrade, 'id' | 'ts'>) => {
    const j = await (await fetch('/api/nifty-covered-call/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trade: row }),
    })).json();
    if (j.success && Array.isArray(j.trades)) setTrades(j.trades);
    else throw new Error(j.error || 'Ledger write failed');
  }, []);

  const ledger = useMemo(() => reconstructCallLedger(trades), [trades]);
  const legExpiries = useMemo(() => [...new Set(ledger.open.map((o) => o.expiry))], [ledger.open]);

  // ── Chain polling: the selected expiry every tick, plus each open leg's own
  // expiry in rotation (a leg's Greeks must come from its own expiry's chain).
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
    const id = setInterval(() => { fetchBook(); setNow(Date.now()); }, BOOK_POLL_MS);
    return () => clearInterval(id);
  }, [fetchBook]);

  // ── Derived market values ───────────────────────────────────────────────
  const spot = liveQuotes?.spot && liveQuotes.spot > 0 ? liveQuotes.spot : restSpot;
  const bees = book?.bees ?? null;
  const beesQty = bees?.qty ?? 0;
  const beesLtp = bees?.ltp ?? 0;
  const beesUnits = beesNiftyUnits(beesQty, beesLtp, spot);
  const holdingValue = beesQty * beesLtp;

  /** Call LTP for a strike on a given expiry: WS tick for the bridged expiry, else REST chain. */
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
      calls: reconciled.legs, marks, callsRealized: ledger.realized,
    });
  }, [bees, beesQty, beesLtp, spot, reconciled.legs, marks, ledger.realized]);

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

  // ── Write-call suggestion ───────────────────────────────────────────────
  const targetDelta = parseFloat(targetDeltaStr) || 0.25;
  const selDte = optionExpiry ? daysToExpiry(optionExpiry, now) : 1;
  const selChain = optionExpiry ? chains[optionExpiry] : undefined;
  const suggestion = useMemo(
    () => (selChain && spot > 0 ? suggestCoveredCall(selChain, spot, beesUnits, lotSize, targetDelta, selDte) : null),
    [selChain, spot, beesUnits, lotSize, targetDelta, selDte],
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

  // Seed the limit price from the live LTP whenever the contract changes.
  const writeKey = `${optionExpiry}:${writeStrike}`;
  const seededKey = useRef('');
  useEffect(() => {
    if (writeLtp && seededKey.current !== writeKey) {
      seededKey.current = writeKey;
      setLimitStr(writeLtp.toFixed(2));
    }
  }, [writeKey, writeLtp]);

  // ── Order helpers ───────────────────────────────────────────────────────
  const placeOrder = useCallback(async (req: { side: 'BUY' | 'SELL'; securityId: string; units: number; orderType: 'MARKET' | 'LIMIT'; price?: number }) => {
    const res = await fetch('/api/nifty-covered-call/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return (await res.json()) as CoveredCallOrderResult;
  }, []);

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

  /** Sell `units` of a call; books only what the broker confirms filled. Returns filled units. */
  const sellCall = useCallback(async (strike: number, expiry: string, units: number, type: 'MARKET' | 'LIMIT', price: number | undefined, note?: string) => {
    const oc = chains[expiry];
    const ce = oc ? lookupChainLegData(oc, strike, 'CE') : undefined;
    if (!ce?.security_id) throw new Error(`No security id for ${strike} CE ${expiry} — chain not loaded`);
    const securityId = String(ce.security_id);
    const r = await placeOrder({ side: 'SELL', securityId, units, orderType: type, price });
    if (!r.success) throw new Error(`Sell ${strike} CE failed: ${r.error ?? r.status}`);
    const filled = r.filledUnits ?? 0;
    if (filled > 0) {
      await logTrade({
        action: 'SELL_OPEN', strike, expiry, units: filled, price: r.avgPrice || price || ce.last_price,
        securityId, tradingSymbol: `NIFTY-${expiry}-${strike}-CE`, orderId: r.orderId, note,
      });
    }
    if (filled < (r.units ?? units)) {
      alert(`Order ${r.orderId} is ${r.status}: ${filled}/${r.units ?? units} units confirmed filled so far.\n` +
        'Only the filled part was booked. If the rest fills later, add it with ADOPT in the Broker Shorts panel.');
    }
    return filled;
  }, [chains, placeOrder, logTrade]);

  /** Buy back up to `units` of an open leg; books the confirmed fill. Returns filled units. */
  const buyBack = useCallback(async (leg: OpenCall, units: number, note: string) => {
    const r = await placeOrder({ side: 'BUY', securityId: leg.securityId, units, orderType: 'MARKET' });
    if (!r.success) throw new Error(`Buy-back of ${leg.strike} CE failed: ${r.error ?? r.status}`);
    const filled = r.filledUnits ?? 0;
    if (filled > 0) {
      const px = r.avgPrice || callLtp(leg.strike, leg.expiry) || 0;
      await logTrade({
        action: 'BUY_CLOSE', strike: leg.strike, expiry: leg.expiry, units: filled, price: px,
        securityId: leg.securityId, tradingSymbol: leg.tradingSymbol, orderId: r.orderId,
        openLegId: leg.id, realizedPnl: (leg.entryPrice - px) * filled, note,
      });
    }
    if (r.clampedFrom) alert(`Buy-back clamped from ${r.clampedFrom} to ${r.units} units — the broker shows only that much short.`);
    if (filled < (r.units ?? units)) alert(`Buy-back order ${r.orderId} is ${r.status}: only ${filled} units confirmed filled.`);
    return filled;
  }, [placeOrder, logTrade, callLtp]);

  const legById = useCallback((id: string) => reconciled.legs.find((l) => l.id === id), [reconciled.legs]);

  const handleWrite = () => withBusy(async () => {
    if (!writeStrike || !optionExpiry || !(writeUnits > 0)) throw new Error('Pick a strike, expiry and lots first');
    const price = orderType === 'LIMIT' ? parseFloat(limitStr) : undefined;
    if (orderType === 'LIMIT' && !(price! > 0)) throw new Error('Enter a limit price');
    const covMsg = coverageAfter != null && coverageAfter > 1.0001
      ? `\n\n⚠ This takes calls written to ${(coverageAfter * 100).toFixed(0)}% of your NIFTYBEES — ${(((snapshot?.shortCallUnits ?? 0) + writeUnits) - beesUnits).toFixed(1)} Nifty units would be a NAKED short call.`
      : '';
    if (!confirm(`REAL ORDER: SELL ${writeLots} lot(s) (${writeUnits} units) NIFTY ${writeStrike} CE ${optionExpiry} @ ${orderType === 'LIMIT' ? price : 'MARKET'} (NRML).${covMsg}`)) return;
    await sellCall(writeStrike, optionExpiry, writeUnits, orderType, price, 'Covered call write');
  });

  const handleBuyBack = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg || leg.units <= 0) return;
    if (!confirm(`REAL ORDER: BUY BACK ${leg.units} units NIFTY ${leg.strike} CE ${leg.expiry} at MARKET?`)) return;
    await buyBack(leg, leg.units, 'Manual buy-back');
  });

  // Roll = full close, then reopen the same units (Invariant 4: never reopen a
  // shortfall — a partial close aborts the reopen).
  const handleRoll = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg || !writeStrike || !optionExpiry) return;
    if (!confirm(`REAL ORDERS — ROLL ${leg.units} units:\n1) BUY BACK ${leg.strike} CE ${leg.expiry} at MARKET\n2) SELL ${writeStrike} CE ${optionExpiry} at MARKET\n\nStep 2 only runs if step 1 fully fills.`)) return;
    const closed = await buyBack(leg, leg.units, `Roll → ${writeStrike} ${optionExpiry}`);
    if (closed < leg.units) throw new Error(`Roll stopped: buy-back filled ${closed}/${leg.units}. No new call was written.`);
    await sellCall(writeStrike, optionExpiry, closed, 'MARKET', undefined, `Roll from ${leg.strike} ${leg.expiry}`);
  });

  // The broker shows less short than the ledger (closed elsewhere / expired):
  // write the ledger down to match, at the current LTP (or 0 when expired worthless).
  const handleSync = (row: OpenCallRow) => withBusy(async () => {
    const leg = legById(row.id);
    if (!leg) return;
    const gap = leg.ledgerUnits - leg.units;
    if (gap <= 0) return;
    const px = callLtp(leg.strike, leg.expiry) ?? 0;
    if (!confirm(`Ledger-only (no order): mark ${gap} units of ${leg.strike} CE ${leg.expiry} as closed outside this desk at ₹${px.toFixed(2)}?`)) return;
    await logTrade({
      action: 'BUY_CLOSE', strike: leg.strike, expiry: leg.expiry, units: gap, price: px,
      securityId: leg.securityId, tradingSymbol: leg.tradingSymbol, openLegId: leg.id,
      realizedPnl: (leg.entryPrice - px) * gap, note: 'Reconciled: closed outside desk / expired (price estimated)',
    });
  });

  // ── Broker CE shorts not owned by this ledger (Adopt) ───────────────────
  const ledgerUnitsBySid = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of ledger.open) m[l.securityId] = (m[l.securityId] ?? 0) + l.units;
    return m;
  }, [ledger.open]);
  const adoptable = useMemo(() => (book?.brokerCalls ?? [])
    .map((c) => ({ ...c, unowned: c.shortUnits - (ledgerUnitsBySid[c.securityId] ?? 0) }))
    .filter((c) => c.unowned > 0), [book?.brokerCalls, ledgerUnitsBySid]);

  const handleAdopt = (c: (typeof adoptable)[number]) => withBusy(async () => {
    const lots = adoptLots[c.securityId] ?? (lotSize > 0 ? Math.floor(c.unowned / lotSize) : 0);
    const units = Math.min(c.unowned, lots * lotSize);
    if (!(units > 0)) throw new Error('Choose at least one lot to adopt');
    if (!confirm(`Ledger-only (no order): adopt ${units} units of ${c.tradingSymbol} short @ ₹${c.sellAvg.toFixed(2)} (broker avg) as a covered call of this desk?`)) return;
    await logTrade({
      action: 'ADOPT', strike: c.strike, expiry: c.expiry, units, price: c.sellAvg,
      securityId: c.securityId, tradingSymbol: c.tradingSymbol, note: 'Adopted existing broker short',
    });
  });

  // ── Headline numbers ────────────────────────────────────────────────────
  const totalPnl = snapshot?.totalPnl ?? null;
  const effCost = bees && beesQty > 0 && snapshot
    ? bees.avgCost - (snapshot.callsRealized + snapshot.callsOpenPnl) / beesQty
    : null;
  const inputCls = cn(TXT_CAPTION, 'w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-100 font-mono');

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
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
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="font-mono">NIFTY</span>
              <span className={cn(TXT_CAPTION, 'font-mono font-bold text-zinc-200')}>{spot > 0 ? spot.toFixed(2) : '—'}</span>
              <LiveBadge live={wsLive} />
              <span className="text-zinc-600 font-normal">|</span>
              <span className={cn(TXT_VALUE, 'font-mono text-zinc-500')}>NIFTYBEES</span>
              <span className={cn(TXT_CAPTION, 'font-mono font-bold text-zinc-200')}>{beesLtp > 0 ? `₹${beesLtp.toFixed(2)}` : '—'}</span>
              {bees?.ltpSource === 'holdings' && <span className={cn(TXT_LABEL, 'text-amber-300')} title="Quote lane busy — using the holdings row's LTP">HOLDINGS LTP</span>}
              <span className="text-zinc-600 font-normal">|</span>
              <span className={cn(TXT_VALUE, 'font-mono text-zinc-500')}>TOTAL P&amp;L</span>
              <span className={cn(TXT_CAPTION, 'font-mono font-bold', totalPnl == null ? 'text-zinc-600' : totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {totalPnl == null ? '—' : signed(totalPnl)}
              </span>
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 flex-wrap">
            {expiries.slice(0, 8).map((e) => (
              <button
                key={e}
                onClick={() => setOptionExpiry(e)}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold transition-all',
                  optionExpiry === e ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'text-zinc-400 hover:text-white',
                )}
              >
                {e}
              </button>
            ))}
          </div>
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

      {/* P&L STRIP */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 px-4 pt-4">
        <StatTile
          label="NIFTYBEES unrealized"
          value={snapshot?.beesPnl ?? null}
          sub={bees ? `${fmtInt(beesQty)} @ ₹${bees.avgCost.toFixed(2)} avg` : 'loading holdings…'}
        />
        <StatTile
          label="Calls open MTM"
          value={snapshot ? snapshot.callsOpenPnl : null}
          sub={`${rows.filter((r) => r.units > 0).length} open leg(s)`}
        />
        <StatTile label="Calls realized" value={ledger.realized} sub={`₹${fmtInt(ledger.premiumSold)} premium sold to date`} />
        <StatTile label="Total P&L" value={totalPnl} sub="holding + calls" emphasis />
        <StatTile
          label="Effective cost / BEES"
          value={effCost}
          raw
          sub={bees && effCost != null ? `avg ₹${bees.avgCost.toFixed(2)} less call P&L` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 p-4">
        {/* WRITE CALL */}
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-3">
          <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide flex items-center gap-1.5">
            <PenLine className="w-3.5 h-3.5 text-rose-400" /> Write Call
            <span className={cn(TXT_LABEL, 'ml-auto font-mono text-zinc-400')}>{optionExpiry ?? '—'} · {selDte.toFixed(1)} DTE</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className={cn(TXT_LABEL, 'text-zinc-500')}>Target Δ</span>
              <RuleNumInput value={targetDeltaStr} onCommit={setTargetDeltaStr} className={cn(inputCls, 'mt-0.5')} ariaLabel="Target delta" />
            </label>
            <label className="block">
              <span className={cn(TXT_LABEL, 'text-zinc-500')}>Strike</span>
              <RuleNumInput
                value={manualStrikeStr}
                onCommit={setManualStrikeStr}
                placeholder={suggestion ? String(suggestion.strike) : 'auto'}
                className={cn(inputCls, 'mt-0.5')}
                ariaLabel="Strike (blank = suggested)"
              />
            </label>
            <label className="block">
              <span className={cn(TXT_LABEL, 'text-zinc-500')}>Lots</span>
              <select value={writeLots} onChange={(e) => setWriteLots(Number(e.target.value))} className={cn(inputCls, 'mt-0.5')}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>

          {suggestion && (
            <div className={cn(TXT_VALUE, 'text-zinc-400')}>
              Suggested <span className="font-bold text-emerald-400">{suggestion.strike} CE</span> (Δ {suggestion.strikeDelta.toFixed(2)}
              {suggestion.deltaEstimated && <span className="text-amber-300"> est.</span>}). Holding covers{' '}
              <span className="font-bold text-zinc-200">{lotSize > 0 ? (beesUnits / lotSize).toFixed(2) : '—'}</span> lots
              {suggestion.coveredLots === 0 && beesUnits > 0 && <span className="text-amber-300"> — less than one full lot</span>}.
              {manualStrike && (
                <button className="ml-1 underline text-zinc-300" onClick={() => setManualStrikeStr('')}>use suggested</button>
              )}
            </div>
          )}

          <div className="rounded-lg bg-zinc-900/60 p-2.5 grid grid-cols-2 gap-x-3 gap-y-1">
            <Kv label="Premium (LTP)" value={writeLtp != null ? `₹${writeLtp.toFixed(2)}` : '—'} />
            <Kv label="Δ / IV" value={writeLeg ? `${writeLeg.greeks?.delta?.toFixed(2) ?? '—'} / ${writeLeg.implied_volatility?.toFixed(1) ?? '—'}%` : '—'} />
            <Kv label="Credit" value={writeReturns ? `₹${fmtInt(writeReturns.credit)}` : '—'} />
            <Kv label="OTM by" value={writeStrike && spot > 0 ? `${(writeStrike - spot).toFixed(0)} pts (${(((writeStrike - spot) / spot) * 100).toFixed(1)}%)` : '—'} />
            <Kv label="Static yield" value={writeReturns ? `${writeReturns.staticPct.toFixed(2)}% (${writeReturns.staticAnnualPct.toFixed(0)}% ann.)` : '—'} />
            <Kv label="If called" value={writeReturns ? `${writeReturns.ifCalledPct.toFixed(2)}%` : '—'} />
            <Kv label="Downside cushion" value={writeReturns ? `${writeReturns.protectionPts.toFixed(0)} pts (${writeReturns.protectionPct.toFixed(2)}%)` : '—'} />
            <Kv
              label="Written after"
              value={coverageAfter != null ? `${(coverageAfter * 100).toFixed(0)}%` : '—'}
              tone={coverageAfter != null && coverageAfter > 1.0001 ? 'warn' : 'ok'}
            />
          </div>

          <div className="flex items-center gap-2">
            <div className="flex bg-zinc-800 rounded p-0.5">
              {(['LIMIT', 'MARKET'] as const).map((t) => (
                <button key={t} onClick={() => setOrderType(t)}
                  className={cn(TXT_VALUE, 'px-2 py-0.5 rounded font-bold', orderType === t ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400')}>
                  {t}
                </button>
              ))}
            </div>
            {orderType === 'LIMIT' && (
              <RuleNumInput value={limitStr} onCommit={setLimitStr} className={cn(inputCls, 'w-24')} ariaLabel="Limit price" />
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !writeStrike || !writeLeg?.security_id || !(lotSize > 0)}
            onClick={handleWrite}
            className="w-full bg-rose-500/20 border-rose-500/40 text-rose-300 font-bold hover:bg-rose-500/30 hover:text-rose-200"
          >
            SELL {writeLots} × {writeStrike ?? '—'} CE
          </Button>
          <div className={cn(TXT_LABEL, 'text-zinc-500')}>
            NRML (carried to expiry). Only the broker-confirmed fill is booked. LIMIT orders that don&apos;t fill within ~5 s stay
            open at the broker — adopt them below once filled.
          </div>
        </div>

        {/* GREEKS */}
        <DeltaPanel book={snapshot} spot={spot} beesLtp={beesLtp} lotSize={lotSize} />

        {/* HOLDING + BROKER SHORTS */}
        <div className="space-y-3">
          <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-2">
            <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5 text-emerald-400" /> NIFTYBEES Holding
            </div>
            {bees ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <Kv label="Total qty" value={fmtInt(bees.qty)} />
                <Kv label="Value" value={`₹${fmtInt(holdingValue)}`} />
                <Kv label="Demat (DP)" value={fmtInt(bees.dpQty)} />
                <Kv label="T1 (settling)" value={fmtInt(bees.t1Qty)} />
                <Kv label="Bought today" value={fmtInt(bees.todayQty)} />
                <Kv label="Avg cost" value={`₹${bees.avgCost.toFixed(2)}`} />
                <Kv label="Nifty-equivalent" value={`${beesUnits.toFixed(1)} units`} />
                <Kv label="= lots" value={lotSize > 0 ? (beesUnits / lotSize).toFixed(2) : '—'} />
                <Kv label="BEES per Nifty pt" value={beesLtp > 0 && spot > 0 ? `1 : ${(spot / beesLtp).toFixed(1)}` : '—'} />
              </div>
            ) : (
              <div className={cn(TXT_CAPTION, 'text-zinc-500')}>{book?.beesError ?? 'Loading holdings…'}</div>
            )}
            <div className={cn(TXT_LABEL, 'text-zinc-500')}>
              Holdings (DP + T1) + today&apos;s CNC position, refreshed every 5 s. Read-only — this desk never trades NIFTYBEES.
            </div>
          </div>

          <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-2">
            <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5 text-sky-400" /> Broker NIFTY CE Shorts (not in this book)
            </div>
            {adoptable.length === 0 ? (
              <div className={cn(TXT_VALUE, 'text-zinc-500')}>
                {book?.brokerShortUnits == null ? 'Positions unavailable.' : 'Every NIFTY CE short at the broker is already in this book (or there are none).'}
              </div>
            ) : (
              <div className="space-y-1.5">
                {adoptable.map((c) => {
                  const maxLots = lotSize > 0 ? Math.floor(c.unowned / lotSize) : 0;
                  const lots = Math.min(adoptLots[c.securityId] ?? maxLots, maxLots);
                  return (
                    <div key={c.securityId} className={cn(TXT_VALUE, 'flex items-center gap-2 text-zinc-300')}>
                      <span className="font-mono flex-1 truncate" title={c.tradingSymbol}>
                        {c.strike} CE {c.expiry} · {c.unowned}u @ {c.sellAvg.toFixed(1)}
                      </span>
                      <select
                        value={lots}
                        aria-label={`Lots to adopt for ${c.tradingSymbol}`}
                        onChange={(e) => setAdoptLots((p) => ({ ...p, [c.securityId]: Number(e.target.value) }))}
                        className={cn(TXT_VALUE, 'bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-zinc-100')}
                      >
                        {Array.from({ length: maxLots + 1 }, (_, i) => i).map((n) => <option key={n} value={n}>{n}L</option>)}
                      </select>
                      <Button size="xs" variant="outline" disabled={busy || lots <= 0} onClick={() => handleAdopt(c)}
                        className="bg-sky-500/20 border-sky-500/40 text-sky-300 font-bold hover:bg-sky-500/30 hover:text-sky-200">
                        ADOPT
                      </Button>
                    </div>
                  );
                })}
                <div className={cn(TXT_LABEL, 'text-zinc-500')}>
                  Other strategies on this account short NIFTY calls too — adopt only the ones you wrote against NIFTYBEES.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-3">
          <TradeSheet
            rows={rows}
            history={trades}
            lotSize={lotSize}
            busy={busy}
            rollTarget={writeStrike && optionExpiry ? { strike: writeStrike, expiry: optionExpiry } : null}
            onBuyBack={handleBuyBack}
            onRoll={handleRoll}
            onSyncLedger={handleSync}
          />
        </div>
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

function StatTile({ label, value, sub, emphasis, raw }: { label: string; value: number | null; sub?: string; emphasis?: boolean; raw?: boolean }) {
  const tone = raw ? 'text-zinc-100' : value == null ? 'text-zinc-600' : value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-zinc-200';
  return (
    <div className={cn('rounded-xl border px-3 py-2', emphasis ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800/60 bg-zinc-950/40')}>
      <div className={cn(TXT_LABEL, 'text-zinc-500 uppercase font-bold tracking-wide')}>{label}</div>
      <div className={cn(emphasis ? 'text-lg' : 'text-base', 'font-bold font-mono tabular-nums', tone)}>
        {value == null ? '—' : raw ? `₹${value.toFixed(2)}` : signed(value)}
      </div>
      {sub && <div className={cn(TXT_VALUE, 'text-zinc-500 truncate')} title={sub}>{sub}</div>}
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
