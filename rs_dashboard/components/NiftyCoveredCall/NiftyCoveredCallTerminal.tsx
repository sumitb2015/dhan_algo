'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Shield, RefreshCw, TrendingDown } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import DeltaPanel from './DeltaPanel';
import TradeSheet, { type LiveLegRow } from './TradeSheet';
import {
  suggestShortCallStrike,
  evaluateRollNeed,
  buildFuturesLeg,
  buildCallLeg,
  computeCoveredCallGreeks,
  type ShortCallSuggestion,
} from '@/lib/coveredCallEngine';
import type { ChainOc } from '@/lib/optionsStrategy';
import type { CoveredCallTradeRow } from '@/app/api/nifty-covered-call/state/route';

// ── Dhan-only, real-money terminal. See components/CyberScalper/CyberScalperTerminal.tsx
// for the futures/options resolution + sticky-header conventions this mirrors, and
// components/SyntheticFuturesScalper.tsx for the target/SL/trailing-SL watcher this
// adapts inline (single consumer — no shared hook per the approved plan).

type SlMode = 'POINTS' | 'RUPEES';

interface FuturesContract {
  securityId: string;
  tradingSymbol: string;
  expiry: string;
  lotSize: number;
  exchange: string;
  exchangeSegment: string;
  ltp: number;
  tickSize: number;
}

interface OpenLeg {
  id: string;
  leg: 'FUTURE' | 'CALL';
  strike?: number;
  side: 'BUY' | 'SELL';
  quantity: number; // lots
  entryPrice: number;
  securityId: string;
  tradingSymbol: string;
  expiry: string;
  exchangeSegment: string;
  productType: 'INTRADAY' | 'MARGIN';
  orderId?: string;
}

function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// ── Commit-on-blur numeric input (dhan-commit-on-blur skill; RuleNumInput
// pattern from components/FocusTool.tsx). Single consumer — declared locally. ──
function RuleNumInput({
  value,
  onCommit,
  placeholder,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      className={className}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => { focusedRef.current = false; commit(e.currentTarget.value); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// Rebuild this terminal's own fill ledger from its trade log — never from a
// raw broker position query (dhan-terminal-position-ownership).
function reconstructLedger(trades: CoveredCallTradeRow[]): { future: OpenLeg | null; calls: OpenLeg[] } {
  let future: OpenLeg | null = null;
  const calls: OpenLeg[] = [];
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);

  for (const t of sorted) {
    if (t.leg === 'FUTURE') {
      if (t.action === 'ENTRY') {
        future = {
          id: t.id,
          leg: 'FUTURE',
          side: t.side,
          quantity: t.quantity,
          entryPrice: t.price,
          securityId: t.securityId || '',
          tradingSymbol: t.tradingSymbol || 'NIFTY-FUT',
          expiry: t.expiry || '',
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
          orderId: t.orderId,
        };
      } else if (t.action === 'EXIT') {
        future = null;
      }
    } else {
      if (t.action === 'ENTRY' || t.action === 'ROLL_OPEN') {
        calls.push({
          id: t.id,
          leg: 'CALL',
          strike: t.strike,
          side: t.side,
          quantity: t.quantity,
          entryPrice: t.price,
          securityId: t.securityId || '',
          tradingSymbol: t.tradingSymbol || '',
          expiry: t.expiry || '',
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
          orderId: t.orderId,
        });
      } else if (t.action === 'EXIT' || t.action === 'ROLL_CLOSE') {
        // Prefer matching the exact leg that was closed (openLegId). Only
        // fall back to strike+side for older rows logged before that field
        // existed — ambiguous when two legs share a strike and side.
        const idx = t.openLegId
          ? calls.findIndex((c) => c.id === t.openLegId)
          : calls.findIndex((c) => c.strike === t.strike && c.side === t.side);
        if (idx >= 0) calls.splice(idx, 1);
      }
    }
  }
  return { future, calls };
}

export default function NiftyCoveredCallTerminal() {
  // ── Contract resolution ─────────────────────────────────────────────────
  const [expiries, setExpiries] = useState<string[]>([]);
  const [optionExpiry, setOptionExpiry] = useState<string | null>(null);
  const [futuresContract, setFuturesContract] = useState<FuturesContract | null>(null);
  const [optionLotSize, setOptionLotSize] = useState<number>(75);

  const [chainOc, setChainOc] = useState<ChainOc | null>(null);
  const [spot, setSpot] = useState(0);
  const [futuresLtp, setFuturesLtp] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  // ── Own fill ledger (dhan-terminal-position-ownership) ──────────────────
  const [futureLeg, setFutureLeg] = useState<OpenLeg | null>(null);
  const [callLegs, setCallLegs] = useState<OpenLeg[]>([]);
  const [history, setHistory] = useState<CoveredCallTradeRow[]>([]);
  const [isBusy, setIsBusy] = useState(false);

  // ── Order pad inputs ─────────────────────────────────────────────────────
  const [futureLots, setFutureLots] = useState(1);
  const [callLots, setCallLots] = useState(1);
  const [manualStrike, setManualStrike] = useState<number | null>(null);

  // ── Hedge/roll engine inputs (commit-on-blur — feed live suggestions) ───
  const [targetDeltaStr, setTargetDeltaStr] = useState('0.30');
  const [targetNetDeltaStr, setTargetNetDeltaStr] = useState('0');
  const [bandWidthStr, setBandWidthStr] = useState('0.25');
  const targetDelta = parseFloat(targetDeltaStr) || 0;
  const targetNetDelta = parseFloat(targetNetDeltaStr) || 0;
  const bandWidth = parseFloat(bandWidthStr) || 0.25;

  // ── Target / SL / trailing-SL (book-level, mirrors SyntheticFuturesScalper) ─
  const [slMode, setSlMode] = useState<SlMode>('POINTS');
  const [targetStr, setTargetStr] = useState('0');
  const [stopLossStr, setStopLossStr] = useState('0');
  const [trailingEnabled, setTrailingEnabled] = useState(false);
  const [trailTriggerStr, setTrailTriggerStr] = useState('0');
  const [trailStepStr, setTrailStepStr] = useState('0');
  const peakRef = useRef<{ points: number; pnl: number }>({ points: -Infinity, pnl: -Infinity });
  const flattenInFlightRef = useRef(false);
  const flattenCooldownUntilRef = useRef(0);

  // ── Load contracts / chain ──────────────────────────────────────────────
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
      .then((j) => { if (j.lot_size) setOptionLotSize(j.lot_size); })
      .catch(() => {});
  }, []);

  const fetchFutures = useCallback(async () => {
    try {
      const res = await fetch('/api/futures/order?symbol=NIFTY');
      const json = await res.json();
      if (json.success && json.data) setFuturesContract(json.data);
    } catch {}
  }, []);

  const chainInFlight = useRef(false);
  const fetchChain = useCallback(async () => {
    if (!optionExpiry || chainInFlight.current) return;
    chainInFlight.current = true;
    try {
      const res = await fetch(`/api/options/chain?underlying=NIFTY&expiry=${optionExpiry}`);
      const json = await res.json();
      if (json.success && json.data) {
        setChainOc((json.data.chain?.oc as ChainOc) ?? null);
        setSpot(json.data.spot ?? 0);
        if (json.data.future_price) setFuturesLtp(json.data.future_price);
        setFeedError(null);
      } else {
        setFeedError(json.error || 'Failed to load option chain');
      }
    } catch (err: unknown) {
      setFeedError(String((err as Error).message ?? err));
    } finally {
      setIsLoading(false);
      chainInFlight.current = false;
    }
  }, [optionExpiry]);

  useEffect(() => { fetchFutures(); }, [fetchFutures]);
  useEffect(() => { fetchChain(); }, [fetchChain]);

  useEffect(() => {
    const t = setInterval(() => { fetchChain(); fetchFutures(); }, 3000);
    return () => clearInterval(t);
  }, [fetchChain, fetchFutures]);

  // Futures LTP fallback when the chain response hasn't carried one yet.
  useEffect(() => {
    if (!futuresLtp && futuresContract?.ltp) setFuturesLtp(futuresContract.ltp);
  }, [futuresContract, futuresLtp]);

  // ── Load / reload the trade log ledger ──────────────────────────────────
  const reloadLedger = useCallback(async () => {
    try {
      const res = await fetch('/api/nifty-covered-call/state');
      const json = await res.json();
      if (json.success && Array.isArray(json.trades)) {
        setHistory(json.trades);
        const { future, calls } = reconstructLedger(json.trades);
        setFutureLeg(future);
        setCallLegs(calls);
      }
    } catch {}
  }, []);

  useEffect(() => { reloadLedger(); }, [reloadLedger]);

  const logTrade = useCallback(async (row: Omit<CoveredCallTradeRow, 'id' | 'ts'>) => {
    try {
      const res = await fetch('/api/nifty-covered-call/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade: row }),
      });
      const json = await res.json();
      if (json.success && Array.isArray(json.trades)) setHistory(json.trades);
    } catch {}
  }, []);

  // ── Order placement helpers ──────────────────────────────────────────────
  const placeLeg = useCallback(async (leg: {
    role: 'FUTURE' | 'CALL';
    side: 'BUY' | 'SELL';
    quantity: number;
    securityId: string;
    tradingSymbol: string;
    exchangeSegment: string;
  }) => {
    const res = await fetch('/api/nifty-covered-call/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leg: {
          role: leg.role,
          side: leg.side,
          quantity: leg.quantity,
          securityId: leg.securityId,
          tradingSymbol: leg.tradingSymbol,
          orderType: 'MARKET',
          productType: 'INTRADAY',
          exchangeSegment: leg.exchangeSegment,
        },
      }),
    });
    return res.json();
  }, []);

  const handleEnterFuture = useCallback(async () => {
    if (!futuresContract || isBusy) return;
    setIsBusy(true);
    try {
      const unitQty = futureLots * futuresContract.lotSize;
      const json = await placeLeg({
        role: 'FUTURE',
        side: 'SELL',
        quantity: unitQty,
        securityId: futuresContract.securityId,
        tradingSymbol: futuresContract.tradingSymbol,
        exchangeSegment: futuresContract.exchangeSegment,
      });
      if (json.success) {
        await logTrade({
          leg: 'FUTURE', action: 'ENTRY', side: 'SELL', quantity: futureLots,
          price: futuresLtp || futuresContract.ltp, expiry: futuresContract.expiry,
          orderId: json.orderId, securityId: futuresContract.securityId,
          tradingSymbol: futuresContract.tradingSymbol,
        });
        await reloadLedger();
        peakRef.current = { points: -Infinity, pnl: -Infinity };
      } else {
        alert(`Futures order failed: ${json.error}`);
      }
    } finally {
      setIsBusy(false);
    }
  }, [futuresContract, futureLots, futuresLtp, isBusy, placeLeg, logTrade, reloadLedger]);

  const handleExitFuture = useCallback(async (reason: string) => {
    if (!futureLeg || !futuresContract) return false;
    const unitQty = futureLeg.quantity * futuresContract.lotSize;
    const json = await placeLeg({
      role: 'FUTURE', side: 'BUY', quantity: unitQty,
      securityId: futureLeg.securityId, tradingSymbol: futureLeg.tradingSymbol,
      exchangeSegment: futureLeg.exchangeSegment,
    });
    if (json.success) {
      const exitPrice = futuresLtp || futuresContract.ltp;
      const realizedPnl = (futureLeg.entryPrice - exitPrice) * unitQty;
      await logTrade({
        leg: 'FUTURE', action: 'EXIT', side: 'BUY', quantity: futureLeg.quantity,
        price: exitPrice, expiry: futureLeg.expiry, orderId: json.orderId,
        securityId: futureLeg.securityId, tradingSymbol: futureLeg.tradingSymbol,
        realizedPnl, note: reason,
      });
      await reloadLedger();
      return true;
    }
    return false;
  }, [futureLeg, futuresContract, futuresLtp, placeLeg, logTrade, reloadLedger]);

  const callLtp = useCallback((strike: number): number | null => {
    if (!chainOc) return null;
    const row = chainOc[String(strike)];
    return row?.ce && row.ce.last_price > 0 ? row.ce.last_price : null;
  }, [chainOc]);

  const handleEnterCall = useCallback(async (strike: number, lots: number) => {
    if (!chainOc || isBusy) return;
    const row = chainOc[String(strike)];
    const ce = row?.ce;
    if (!ce || !ce.security_id) { alert('No security ID for this strike/chain not loaded'); return; }
    setIsBusy(true);
    try {
      const unitQty = lots * optionLotSize;
      const json = await placeLeg({
        role: 'CALL', side: 'SELL', quantity: unitQty,
        securityId: String(ce.security_id), tradingSymbol: `NIFTY-${optionExpiry}-${strike}-CE`,
        exchangeSegment: 'NSE_FNO',
      });
      if (json.success) {
        await logTrade({
          leg: 'CALL', action: 'ENTRY', side: 'SELL', quantity: lots, strike,
          price: ce.last_price, expiry: optionExpiry || undefined, orderId: json.orderId,
          securityId: String(ce.security_id), tradingSymbol: `NIFTY-${optionExpiry}-${strike}-CE`,
        });
        await reloadLedger();
      } else {
        alert(`Call order failed: ${json.error}`);
      }
    } finally {
      setIsBusy(false);
    }
  }, [chainOc, optionExpiry, optionLotSize, isBusy, placeLeg, logTrade, reloadLedger]);

  const handleExitCall = useCallback(async (leg: OpenLeg, action: 'EXIT' | 'ROLL_CLOSE', reason?: string) => {
    const ltp = leg.strike != null ? callLtp(leg.strike) : null;
    const exitPrice = ltp ?? leg.entryPrice;
    const unitQty = leg.quantity * optionLotSize;
    const json = await placeLeg({
      role: 'CALL', side: 'BUY', quantity: unitQty,
      securityId: leg.securityId, tradingSymbol: leg.tradingSymbol, exchangeSegment: leg.exchangeSegment,
    });
    if (json.success) {
      const realizedPnl = (leg.entryPrice - exitPrice) * unitQty;
      await logTrade({
        leg: 'CALL', action, side: 'BUY', quantity: leg.quantity, strike: leg.strike,
        price: exitPrice, expiry: leg.expiry, orderId: json.orderId,
        securityId: leg.securityId, tradingSymbol: leg.tradingSymbol, realizedPnl, note: reason,
        openLegId: leg.id,
      });
      await reloadLedger();
      return true;
    }
    return false;
  }, [callLtp, optionLotSize, placeLeg, logTrade, reloadLedger]);

  const handleRollCall = useCallback(async (oldLeg: OpenLeg, suggestion: ShortCallSuggestion) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const closedOk = await handleExitCall(oldLeg, 'ROLL_CLOSE', 'Delta-drift roll');
      if (!closedOk) { alert('Roll aborted: could not close the existing call leg'); return; }
      const row = chainOc?.[String(suggestion.strike)];
      const ce = row?.ce;
      if (!ce || !ce.security_id) { alert('Roll aborted: new strike has no security ID'); return; }
      const unitQty = suggestion.callLots * optionLotSize;
      if (unitQty <= 0) {
        alert('Roll closed the old call, but the new target needs 0 call lots — the book is now a naked short future. Sell a new call manually to re-hedge.');
        return;
      }
      const json = await placeLeg({
        role: 'CALL', side: 'SELL', quantity: unitQty,
        securityId: String(ce.security_id), tradingSymbol: `NIFTY-${optionExpiry}-${suggestion.strike}-CE`,
        exchangeSegment: 'NSE_FNO',
      });
      if (json.success) {
        await logTrade({
          leg: 'CALL', action: 'ROLL_OPEN', side: 'SELL', quantity: suggestion.callLots, strike: suggestion.strike,
          price: ce.last_price, expiry: optionExpiry || undefined, orderId: json.orderId,
          securityId: String(ce.security_id), tradingSymbol: `NIFTY-${optionExpiry}-${suggestion.strike}-CE`,
          note: 'Delta-drift roll',
        });
        await reloadLedger();
      } else {
        alert(`Roll re-open failed: ${json.error}`);
      }
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, handleExitCall, chainOc, optionExpiry, optionLotSize, placeLeg, logTrade, reloadLedger]);

  const handleFlattenAll = useCallback(async (reason: string) => {
    if (flattenInFlightRef.current) return;
    flattenInFlightRef.current = true;
    try {
      let ok = true;
      for (const leg of callLegs) {
        const r = await handleExitCall(leg, 'EXIT', reason);
        ok = ok && r;
      }
      if (futureLeg) {
        const r = await handleExitFuture(reason);
        ok = ok && r;
      }
      if (!ok) flattenCooldownUntilRef.current = Date.now() + 15000;
      return ok;
    } finally {
      flattenInFlightRef.current = false;
    }
  }, [callLegs, futureLeg, handleExitCall, handleExitFuture]);

  // ── Live greeks / hedge engine ───────────────────────────────────────────
  const netGreeks = useMemo(() => {
    if (!futureLeg && callLegs.length === 0) return null;
    const legs = [];
    if (futureLeg) {
      legs.push(buildFuturesLeg({
        side: futureLeg.side, qtyLots: futureLeg.quantity, price: futureLeg.entryPrice,
        securityId: futureLeg.securityId, expiry: futureLeg.expiry, tradingSymbol: futureLeg.tradingSymbol,
        ltp: futuresLtp || null,
      }));
    }
    for (const c of callLegs) {
      const row = c.strike != null ? chainOc?.[String(c.strike)] : undefined;
      legs.push(buildCallLeg({
        strike: c.strike ?? 0, side: c.side, qtyLots: c.quantity, price: c.entryPrice,
        chainLeg: row?.ce, securityId: c.securityId, expiry: c.expiry, tradingSymbol: c.tradingSymbol,
        ltp: c.strike != null ? callLtp(c.strike) : null, spot,
      }));
    }
    return computeCoveredCallGreeks(legs);
  }, [futureLeg, callLegs, chainOc, futuresLtp, spot, callLtp]);

  const suggestion = useMemo(() => {
    if (!chainOc || !futuresLtp || !futureLeg) return null;
    return suggestShortCallStrike(chainOc, futuresLtp, futureLeg.quantity, targetDelta, { targetNetDelta });
  }, [chainOc, futuresLtp, futureLeg, targetDelta, targetNetDelta]);

  const engineNetDelta = suggestion?.netDelta ?? targetNetDelta;
  const rollCheck = useMemo(
    () => evaluateRollNeed(engineNetDelta, { targetDelta: targetNetDelta, bandWidth }),
    [engineNetDelta, targetNetDelta, bandWidth],
  );

  // ── Target / SL / trailing watcher (adapted from SyntheticFuturesScalper) ─
  const capturedPoints = futureLeg
    ? (futureLeg.side === 'SELL' ? futureLeg.entryPrice - futuresLtp : futuresLtp - futureLeg.entryPrice)
    : 0;
  const currentPnl = useMemo(() => {
    let pnl = 0;
    if (futureLeg && futuresContract) {
      const unitQty = futureLeg.quantity * futuresContract.lotSize;
      pnl += (futureLeg.entryPrice - futuresLtp) * unitQty;
    }
    for (const c of callLegs) {
      const ltp = c.strike != null ? callLtp(c.strike) : null;
      if (ltp === null) continue;
      pnl += (c.entryPrice - ltp) * c.quantity * optionLotSize;
    }
    return pnl;
  }, [futureLeg, futuresContract, futuresLtp, callLegs, callLtp, optionLotSize]);

  useEffect(() => {
    if (!futureLeg && callLegs.length === 0) {
      peakRef.current = { points: -Infinity, pnl: -Infinity };
      return;
    }
    peakRef.current.points = Math.max(peakRef.current.points, capturedPoints);
    peakRef.current.pnl = Math.max(peakRef.current.pnl, currentPnl);
  }, [futureLeg, callLegs.length, capturedPoints, currentPnl]);

  const trailingStatus = useMemo(() => {
    if (!trailingEnabled) return { armed: false, label: 'OFF', detail: 'Trailing SL disabled' };
    const trigVal = parseFloat(trailTriggerStr) || 0;
    const stepVal = parseFloat(trailStepStr) || 0;
    if (trigVal <= 0 || stepVal <= 0) return { armed: false, label: 'INACTIVE', detail: 'Trigger/step <= 0' };
    if (!futureLeg && callLegs.length === 0) return { armed: false, label: 'STANDBY', detail: `Arms @ +${trigVal} ${slMode === 'POINTS' ? 'pts' : '₹'}` };
    const peak = slMode === 'POINTS' ? peakRef.current.points : peakRef.current.pnl;
    const isArmed = peak >= trigVal;
    if (!isArmed) return { armed: false, label: 'STANDBY', detail: `Arms @ +${trigVal} ${slMode === 'POINTS' ? 'pts' : '₹'}` };
    const stepsBeyond = Math.floor((peak - trigVal) / stepVal);
    const locked = stepsBeyond * stepVal;
    return { armed: true, label: 'ARMED & LOCKING', detail: `Locked floor: ${slMode === 'POINTS' ? `+${locked} pts` : `+₹${locked}`}` };
  }, [trailingEnabled, trailTriggerStr, trailStepStr, futureLeg, callLegs.length, slMode]);

  useEffect(() => {
    if (!futureLeg && callLegs.length === 0) return;
    if (Date.now() < flattenCooldownUntilRef.current) return;

    const slVal = parseFloat(stopLossStr) || 0;
    const tgtVal = parseFloat(targetStr) || 0;
    const trigVal = parseFloat(trailTriggerStr) || 0;
    const stepVal = parseFloat(trailStepStr) || 0;

    if (slVal > 0) {
      if (slMode === 'POINTS' && capturedPoints <= -slVal) { handleFlattenAll(`Stop loss hit (-${slVal} pts)`); return; }
      if (slMode === 'RUPEES' && currentPnl <= -slVal) { handleFlattenAll(`Stop loss hit (-₹${slVal})`); return; }
    }
    if (tgtVal > 0) {
      if (slMode === 'POINTS' && capturedPoints >= tgtVal) { handleFlattenAll(`Target reached (+${tgtVal} pts)`); return; }
      if (slMode === 'RUPEES' && currentPnl >= tgtVal) { handleFlattenAll(`Target reached (+₹${tgtVal})`); return; }
    }
    if (trailingEnabled && trigVal > 0 && stepVal > 0) {
      const peak = slMode === 'POINTS' ? peakRef.current.points : peakRef.current.pnl;
      const cur = slMode === 'POINTS' ? capturedPoints : currentPnl;
      if (peak >= trigVal) {
        const stepsBeyond = Math.floor((peak - trigVal) / stepVal);
        const floor = stepsBeyond * stepVal;
        if (cur <= floor) { handleFlattenAll(`Trailing SL hit (locked ${slMode === 'POINTS' ? `${floor} pts` : `₹${floor}`})`); return; }
      }
    }
  }, [futureLeg, callLegs.length, capturedPoints, currentPnl, stopLossStr, targetStr, trailTriggerStr, trailStepStr, trailingEnabled, slMode, handleFlattenAll]);

  // ── Live legs for the trade sheet ────────────────────────────────────────
  const liveLegRows: LiveLegRow[] = useMemo(() => {
    const rows: LiveLegRow[] = [];
    if (futureLeg && futuresContract) {
      const unitQty = futureLeg.quantity * futuresContract.lotSize;
      rows.push({
        id: futureLeg.id, leg: 'FUTURE', side: futureLeg.side, quantity: unitQty,
        entryPrice: futureLeg.entryPrice, ltp: futuresLtp || null,
        target: null, stopLoss: null, trailingSlFloor: trailingStatus.armed ? peakRef.current.points : null,
        livePnl: (futureLeg.entryPrice - futuresLtp) * unitQty,
      });
    }
    for (const c of callLegs) {
      const ltp = c.strike != null ? callLtp(c.strike) : null;
      const unitQty = c.quantity * optionLotSize;
      rows.push({
        id: c.id, leg: 'CALL', strike: c.strike, side: c.side, quantity: unitQty,
        entryPrice: c.entryPrice, ltp, target: null, stopLoss: null, trailingSlFloor: null,
        livePnl: ltp !== null ? (c.entryPrice - ltp) * unitQty : 0,
      });
    }
    return rows;
  }, [futureLeg, futuresContract, futuresLtp, callLegs, callLtp, optionLotSize, trailingStatus.armed]);

  const openMtm = liveLegRows.reduce((s, r) => s + r.livePnl, 0);

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
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                NIFTY COVERED CALL
              </span>
              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-bold">
                DATA: {todayIST()}
              </span>
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-2 mt-0.5">
              <span className="font-mono font-bold">NIFTY</span>
              <span className="text-xs font-mono font-bold text-zinc-200">₹{spot.toFixed(2)}</span>
              <span className="text-zinc-600 font-normal">|</span>
              <span className="text-[10px] font-mono text-zinc-500">FUT</span>
              <span className="text-xs font-mono font-bold text-zinc-200">
                ₹{futuresLtp ? futuresLtp.toFixed(2) : '—'} ({futuresContract?.expiry || '—'})
              </span>
              <span className="text-zinc-600 font-normal">|</span>
              <span className="text-[10px] font-mono text-zinc-500">MTM</span>
              <span className={cn('text-xs font-mono font-bold', openMtm >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {openMtm >= 0 ? '+' : ''}₹{openMtm.toFixed(0)}
              </span>
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            {expiries.slice(0, 6).map((e) => (
              <button
                key={e}
                onClick={() => setOptionExpiry(e)}
                className={cn(
                  'px-2 py-1 rounded text-xs font-mono font-bold transition-all',
                  optionExpiry === e ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40' : 'text-zinc-400 hover:text-white',
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <button
            onClick={() => { fetchChain(); fetchFutures(); }}
            className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-cyan-400 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin text-cyan-400')} />
          </button>
          <NavBar />
        </div>
      </div>

      {feedError && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/40 text-xs text-rose-300">
          {feedError}
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-3 p-4">
        {/* ── ORDER PAD ── */}
        <div className="bg-zinc-950/40 border border-zinc-800/60 rounded-xl p-3 space-y-4">
          <div className="text-xs font-bold text-zinc-100 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown className="w-3.5 h-3.5 text-rose-400" /> Order Pad
          </div>

          {/* Futures leg */}
          <div className="bg-zinc-900/60 rounded-lg p-2.5 space-y-2">
            <div className="text-[10px] text-zinc-500 uppercase font-bold">Futures Leg (Short)</div>
            <div className="flex items-center gap-2">
              <select
                value={futureLots}
                onChange={(e) => setFutureLots(Number(e.target.value))}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"
              >
                {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} lot{n > 1 ? 's' : ''}</option>)}
              </select>
              {!futureLeg ? (
                <button
                  disabled={isBusy || !futuresContract}
                  onClick={handleEnterFuture}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-bold hover:bg-rose-500/30 disabled:opacity-40"
                >
                  SELL FUTURES
                </button>
              ) : (
                <button
                  disabled={isBusy}
                  onClick={() => handleExitFuture('Manual exit')}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-xs font-bold hover:bg-emerald-500/30 disabled:opacity-40"
                >
                  BUY TO COVER
                </button>
              )}
            </div>
            {futureLeg && (
              <div className="text-[10px] text-zinc-400">
                Open: {futureLeg.quantity} lot(s) @ {futureLeg.entryPrice.toFixed(2)}
              </div>
            )}
          </div>

          {/* Call leg */}
          <div className="bg-zinc-900/60 rounded-lg p-2.5 space-y-2">
            <div className="text-[10px] text-zinc-500 uppercase font-bold">Short Call Leg</div>
            <div className="flex items-center gap-2">
              <RuleNumInput
                value={manualStrike != null ? String(manualStrike) : ''}
                onCommit={(v) => setManualStrike(v ? Number(v) : null)}
                placeholder={suggestion ? String(suggestion.strike) : 'Strike'}
                className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"
              />
              <select
                value={callLots}
                onChange={(e) => setCallLots(Number(e.target.value))}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"
              >
                {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} lot{n > 1 ? 's' : ''}</option>)}
              </select>
            </div>
            <button
              disabled={isBusy || (!manualStrike && !suggestion)}
              onClick={() => handleEnterCall(manualStrike ?? suggestion!.strike, callLots)}
              className="w-full px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-bold hover:bg-rose-500/30 disabled:opacity-40"
            >
              SELL CALL
            </button>
            {callLegs.length > 0 && (
              <div className="space-y-1 pt-1 border-t border-zinc-800/60">
                {callLegs.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-[10px] text-zinc-400">
                    <span>{c.strike} CE × {c.quantity} @ {c.entryPrice.toFixed(2)}</span>
                    <div className="flex gap-1">
                      {suggestion && suggestion.strike !== c.strike && (
                        <button
                          disabled={isBusy}
                          onClick={() => handleRollCall(c, suggestion)}
                          className="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold"
                        >
                          ROLL → {suggestion.strike}
                        </button>
                      )}
                      <button
                        disabled={isBusy}
                        onClick={() => handleExitCall(c, 'EXIT', 'Manual exit')}
                        className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-bold"
                      >
                        BUY BACK
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hedge engine inputs */}
          <div className="bg-zinc-900/60 rounded-lg p-2.5 space-y-2">
            <div className="text-[10px] text-zinc-500 uppercase font-bold">Hedge Engine</div>
            <div className="grid grid-cols-3 gap-2">
              <LabeledInput label="Strike Δ" value={targetDeltaStr} onCommit={setTargetDeltaStr} />
              <LabeledInput label="Net Δ Target" value={targetNetDeltaStr} onCommit={setTargetNetDeltaStr} />
              <LabeledInput label="Band ±" value={bandWidthStr} onCommit={setBandWidthStr} />
            </div>
          </div>

          {/* Target / SL / Trailing */}
          <div className="bg-zinc-900/60 rounded-lg p-2.5 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] text-zinc-500 uppercase font-bold">Target / SL</div>
              <div className="flex bg-zinc-800 rounded p-0.5">
                {(['POINTS', 'RUPEES'] as SlMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSlMode(m)}
                    className={cn('px-2 py-0.5 rounded text-[10px] font-bold', slMode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400')}
                  >
                    {m === 'POINTS' ? 'Pts' : '₹'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <LabeledInput label={`Target (${slMode === 'POINTS' ? 'pts' : '₹'})`} value={targetStr} onCommit={setTargetStr} />
              <LabeledInput label={`Stop (${slMode === 'POINTS' ? 'pts' : '₹'})`} value={stopLossStr} onCommit={setStopLossStr} />
            </div>
            <label className="flex items-center gap-2 text-[10px] text-zinc-400">
              <input type="checkbox" checked={trailingEnabled} onChange={(e) => setTrailingEnabled(e.target.checked)} />
              Trailing SL
            </label>
            {trailingEnabled && (
              <div className="grid grid-cols-2 gap-2">
                <LabeledInput label="Arm Trigger" value={trailTriggerStr} onCommit={setTrailTriggerStr} />
                <LabeledInput label="Trail Step" value={trailStepStr} onCommit={setTrailStepStr} />
              </div>
            )}
            <div className="text-[10px] text-zinc-500">{trailingStatus.label}: {trailingStatus.detail}</div>
            <button
              disabled={isBusy || (!futureLeg && callLegs.length === 0)}
              onClick={() => handleFlattenAll('Manual flatten')}
              className="w-full px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-bold hover:bg-zinc-700 disabled:opacity-40"
            >
              FLATTEN ALL
            </button>
          </div>
        </div>

        {/* ── DELTA PANEL ── */}
        <div className="space-y-3">
          <DeltaPanel
            greeks={netGreeks}
            suggestion={suggestion}
            rollNeeded={rollCheck.needsRoll}
            rollReason={rollCheck.reason}
            targetNetDelta={targetNetDelta}
            bandWidth={bandWidth}
          />
        </div>

        {/* ── TRADE SHEET ── */}
        <div className="lg:col-span-1">
          <TradeSheet liveLegs={liveLegRows} history={history} />
        </div>
      </div>
    </div>
  );
}

function LabeledInput({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[9px] text-zinc-500">{label}</span>
      <RuleNumInput
        value={value}
        onCommit={onCommit}
        className="w-full mt-0.5 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"
      />
    </label>
  );
}
