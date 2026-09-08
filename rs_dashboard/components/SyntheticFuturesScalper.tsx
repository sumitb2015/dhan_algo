'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  Zap,
  Shield,
  Crosshair,
  TrendingUp,
  TrendingDown,
  Activity,
  AlertTriangle,
  RotateCcw,
  Sliders,
  ChevronDown,
  Layers,
  ArrowRight,
  Sparkles,
  Lock,
  Unlock,
  Radio,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Gauge,
  Clock,
  RefreshCw,
  ExternalLink,
} from 'lucide-react';
import { useLiveOptionsWS, type Broker } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Types & Interfaces ──────────────────────────────────────────────────────

type Underlying = 'NIFTY' | 'SENSEX' | 'BANKNIFTY';
type SyntheticDirection = 'LONG' | 'SHORT';
type SlMode = 'POINTS' | 'RUPEES';
type OrderMode = 'MARKET' | 'LIMIT';
type ProductType = 'INTRADAY' | 'MARGIN';

interface IndexQuote {
  symbol: string;
  name: string;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
}

interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
  detail?: string;
}

interface SyntheticLeg {
  role: 'MAIN_CE' | 'MAIN_PE' | 'HEDGE';
  optionType: 'CE' | 'PE';
  strike: number;
  side: 'BUY' | 'SELL';
  qty: number;
  entryPrice: number;
  currentLtp: number;
  pnl: number;
  securityId?: string;
  tradingSymbol?: string;
  productType: ProductType;
  exchangeSegment: string;
}

interface ActiveSyntheticPosition {
  id: string;
  direction: SyntheticDirection;
  underlying: Underlying;
  expiry: string;
  atmStrike: number;
  lots: number;
  lotSize: number;
  entrySyntheticPrice: number;
  enteredAt: string;
  hedged: boolean;
  hedgeOffset: number;
  productType: ProductType;
  legs: SyntheticLeg[];
  peakPoints: number;
  peakPnl: number;
}

interface LogEvent {
  id: string;
  time: string;
  type: 'ENTRY' | 'EXIT' | 'TRAIL' | 'REVERSE' | 'ERROR';
  message: string;
  detail?: string;
}

// ─── RuleNumInput (Commit-on-blur pattern) ───────────────────────────────────

function RuleNumInput({
  value,
  onCommit,
  placeholder,
  className = '',
  disabled = false,
  min,
  step = '1',
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  min?: string;
  step?: string;
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
      type="number"
      value={draft}
      min={min}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => {
        focusedRef.current = false;
        commit(e.currentTarget.value);
      }}
      onKeyDown={e => {
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

// ─── Helper Formatters ───────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined, dec = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function fmtSignedNum(n: number | null | undefined, dec = 2): string {
  if (n == null || isNaN(n)) return '—';
  const prefix = n > 0 ? '+' : '';
  return prefix + fmtNum(n, dec);
}

function fmtINR(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return (n < 0 ? '-₹' : '₹') + formatted;
}

function fmtSignedINR(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const prefix = n > 0 ? '+₹' : n < 0 ? '-₹' : '₹';
  return prefix + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function SyntheticFuturesScalper() {
  // Underlying, Expiry & Broker
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('');
  const [lotSize, setLotSize] = useState<number>(75);
  const [strikeMap, setStrikeMap] = useState<Record<string, StrikeIdentifier>>({});

  // Broker selector hook
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();

  // Indices ticker data
  const [indices, setIndices] = useState<Record<string, IndexQuote>>({});
  const [indicesLoading, setIndicesLoading] = useState(false);

  // Scalper order settings
  const [lots, setLots] = useState<number>(1);
  const [productType, setProductType] = useState<ProductType>('INTRADAY');
  const [orderMode, setOrderMode] = useState<OrderMode>('MARKET');
  const [limitBuffer, setLimitBuffer] = useState<string>('0.5');

  // Option Hedging Settings
  const [hedgeEnabled, setHedgeEnabled] = useState<boolean>(true);
  const [hedgeOffset, setHedgeOffset] = useState<number>(200);

  // Risk & Trailing Stop Settings
  const [slMode, setSlMode] = useState<SlMode>('POINTS');
  const [stopLoss, setStopLoss] = useState<string>('30');
  const [target, setTarget] = useState<string>('60');
  const [trailingEnabled, setTrailingEnabled] = useState<boolean>(true);
  const [trailTrigger, setTrailTrigger] = useState<string>('20');
  const [trailStep, setTrailStep] = useState<string>('10');

  // Active Synthetic Position State
  const [activePosition, setActivePosition] = useState<ActiveSyntheticPosition | null>(null);
  const [inFlight, setInFlight] = useState<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  const [visualFlash, setVisualFlash] = useState<'LONG' | 'SHORT' | 'EXIT' | null>(null);

  // Restore active synthetic position from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('dhan_algo.synthetic_position');
      if (saved) {
        const parsed = JSON.parse(saved) as ActiveSyntheticPosition;
        if (parsed && parsed.id && Array.isArray(parsed.legs) && parsed.legs.length > 0) {
          setActivePosition({
            ...parsed,
            peakPoints: parsed.peakPoints ?? 0,
            peakPnl: parsed.peakPnl ?? 0,
          });
        }
      }
    } catch {}
  }, []);

  // Persist active synthetic position to localStorage
  useEffect(() => {
    try {
      if (activePosition) {
        localStorage.setItem('dhan_algo.synthetic_position', JSON.stringify(activePosition));
      } else {
        localStorage.removeItem('dhan_algo.synthetic_position');
      }
    } catch {}
  }, [activePosition]);

  // Logs & Toasts
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // WebSocket Live Options Feed
  const { liveQuotes, bridgeStatus, transport } = useLiveOptionsWS(
    expiry,
    broker,
    authenticatedBrokers,
    underlying
  );

  // Add Toast Notification
  const addToast = useCallback((type: 'success' | 'error' | 'info', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev.slice(-4), { id, type, message, detail }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  }, []);

  // Add Log Event
  const addLog = useCallback((type: LogEvent['type'], message: string, detail?: string) => {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const id = `${Date.now()}-${Math.random()}`;
    setLogs(prev => [{ id, time, type, message, detail }, ...prev.slice(0, 49)]);
  }, []);

  // ── 1. Fetch Headline Indices ──────────────────────────────────────────────
  const fetchIndices = useCallback(async () => {
    try {
      setIndicesLoading(true);
      const res = await fetch('/api/synthetic-futures/indices');
      const json = (await res.json()) as { success: boolean; quotes?: Record<string, IndexQuote> };
      if (json.success && json.quotes) {
        setIndices(json.quotes);
      }
    } catch (err) {
      console.error('Failed to fetch indices:', err);
    } finally {
      setIndicesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIndices();
    const timer = setInterval(fetchIndices, 4000);
    return () => clearInterval(timer);
  }, [fetchIndices]);

  // ── 2. Fetch Expiries for Selected Underlying ──────────────────────────────
  useEffect(() => {
    async function loadExpiries() {
      try {
        const res = await fetch(`/api/options/expiries?underlying=${underlying}`);
        const json = await res.json();
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          setExpiries(json.data);
          // Set nearest expiry if current expiry is not in list
          if (!json.data.includes(expiry)) {
            setExpiry(json.data[0]);
          }
        }
      } catch (err) {
        console.error('Failed to fetch expiries:', err);
      }
    }
    loadExpiries();
  }, [underlying]);

  // ── 3. Fetch Strike Identifiers & Lot Size via Scalper Lookup ───────────────
  useEffect(() => {
    if (!expiry) return;
    async function loadLookup() {
      try {
        const res = await fetch(`/api/scalper/lookup?underlying=${underlying}&expiry=${expiry}`);
        const json = await res.json();
        if (json.success && json.data) {
          if (json.data.lotSize) setLotSize(json.data.lotSize);
          if (json.data.strikes) setStrikeMap(json.data.strikes);
        }
      } catch (err) {
        console.error('Failed to load strike lookup:', err);
      }
    }
    loadLookup();
  }, [underlying, expiry]);

  // ── 4. Ensure Options Live Bridge is active ─────────────────────────────────
  useEffect(() => {
    if (!expiry) return;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying, expiry, broker }),
    }).catch(() => {});
  }, [underlying, expiry, broker]);

  // ── 5. Derived Market Metrics ──────────────────────────────────────────────
  const strikeStep = underlying === 'NIFTY' ? 50 : 100;

  // Dynamic wing offset distances tailored to underlying index step
  const wingOffsets = useMemo(() => {
    return underlying === 'NIFTY'
      ? [100, 150, 200, 250, 300, 400]
      : [100, 200, 300, 400, 500, 600];
  }, [underlying]);

  // Snap hedgeOffset to valid strike offset when underlying changes
  useEffect(() => {
    const validOffsets = underlying === 'NIFTY'
      ? [100, 150, 200, 250, 300, 400]
      : [100, 200, 300, 400, 500, 600];
    setHedgeOffset(prev => (validOffsets.includes(prev) ? prev : 200));
  }, [underlying]);

  // Spot price: prioritize live options WS tick, then indices snapshot
  const liveSpot =
    liveQuotes?.spot && liveQuotes.spot > 0
      ? liveQuotes.spot
      : indices[underlying]?.spot ?? (underlying === 'NIFTY' ? 23635.1 : 75577.58);

  const prevClose =
    indices[underlying]?.prevClose ?? (underlying === 'NIFTY' ? 23779.15 : 76132.81);

  const spotChange =
    liveQuotes?.spot_change != null
      ? liveQuotes.spot_change
      : liveSpot - prevClose;

  const spotChangePct =
    liveQuotes?.spot_change_pct != null
      ? liveQuotes.spot_change_pct
      : prevClose > 0
        ? ((liveSpot - prevClose) / prevClose) * 100
        : 0;

  // Real-time ATM Strike
  const atmStrike = useMemo(() => {
    if (liveQuotes?.atm && liveQuotes.atm > 0) return liveQuotes.atm;
    if (liveSpot > 0) {
      return Math.round(liveSpot / strikeStep) * strikeStep;
    }
    return underlying === 'NIFTY' ? 23650 : 75600;
  }, [liveQuotes?.atm, liveSpot, strikeStep, underlying]);

  // Option quotes for ATM
  const atmQuotes = liveQuotes?.strikes?.[String(atmStrike)];
  const atmCeLtp = atmQuotes?.ce?.ltp ?? 0;
  const atmPeLtp = atmQuotes?.pe?.ltp ?? 0;

  // Live Synthetic Future Price: ATM + CE_ltp - PE_ltp
  const syntheticFuturePrice = useMemo(() => {
    if (atmStrike > 0 && atmCeLtp > 0 && atmPeLtp > 0) {
      return atmStrike + atmCeLtp - atmPeLtp;
    }
    return liveSpot;
  }, [atmStrike, atmCeLtp, atmPeLtp, liveSpot]);

  // Basis / Cost of Carry (Synthetic Price - Spot Price)
  const syntheticBasis = syntheticFuturePrice - liveSpot;

  // Hedge Strike Calculations
  const longHedgeStrike = atmStrike - hedgeOffset;
  const shortHedgeStrike = atmStrike + hedgeOffset;
  const longHedgeQuotes = liveQuotes?.strikes?.[String(longHedgeStrike)];
  const shortHedgeQuotes = liveQuotes?.strikes?.[String(shortHedgeStrike)];
  const longHedgePeLtp = longHedgeQuotes?.pe?.ltp ?? 0;
  const shortHedgeCeLtp = shortHedgeQuotes?.ce?.ltp ?? 0;

  // Combined Entry Costs
  // Long Synthetic: Buy CE @ atmCeLtp, Sell PE @ atmPeLtp, (Buy PE @ longHedgePeLtp)
  const longEntryNetPrice = atmCeLtp - atmPeLtp + (hedgeEnabled ? longHedgePeLtp : 0);
  // Short Synthetic: Sell CE @ atmCeLtp, Buy PE @ atmPeLtp, (Buy CE @ shortHedgeCeLtp)
  const shortEntryNetPrice = atmPeLtp - atmCeLtp + (hedgeEnabled ? shortHedgeCeLtp : 0);

  // ── 6. Update Active Position Live Telemetry ───────────────────────────────
  useEffect(() => {
    if (!activePosition) return;

    setActivePosition(prev => {
      if (!prev) return null;

      // Current Synthetic Price
      const currentSynth = syntheticFuturePrice;
      const pointsDiff =
        prev.direction === 'LONG'
          ? currentSynth - prev.entrySyntheticPrice
          : prev.entrySyntheticPrice - currentSynth;

      // Update legs LTP and P&L (safely ignoring 0 or missing ticks to avoid phantom losses)
      const updatedLegs: SyntheticLeg[] = prev.legs.map(leg => {
        const quote = liveQuotes?.strikes?.[String(leg.strike)];
        const reported = leg.optionType === 'CE' ? quote?.ce?.ltp : quote?.pe?.ltp;
        const ltp = reported != null && reported > 0 ? reported : leg.currentLtp;
        const pnl =
          leg.side === 'BUY'
            ? (ltp - leg.entryPrice) * leg.qty
            : (leg.entryPrice - ltp) * leg.qty;
        return {
          ...leg,
          currentLtp: ltp,
          pnl,
        };
      });

      const totalPnl = updatedLegs.reduce((acc, l) => acc + l.pnl, 0);
      const newPeakPoints = Math.max(prev.peakPoints, pointsDiff);
      const newPeakPnl = Math.max(prev.peakPnl, totalPnl);

      return {
        ...prev,
        legs: updatedLegs,
        peakPoints: newPeakPoints,
        peakPnl: newPeakPnl,
      };
    });
  }, [syntheticFuturePrice, liveQuotes]);

  // Trailing SL Live Telemetry Status
  const trailingStatus = useMemo(() => {
    if (!trailingEnabled) {
      return { armed: false, active: false, label: 'OFF', detail: 'Trailing SL Disabled' };
    }
    const trigVal = parseFloat(trailTrigger) || 0;
    const stepVal = parseFloat(trailStep) || 0;
    if (trigVal <= 0 || stepVal <= 0) {
      return { armed: false, active: false, label: 'INACTIVE', detail: 'Trigger/Step <= 0' };
    }

    if (!activePosition) {
      return {
        armed: false,
        active: true,
        label: 'STANDBY',
        detail: `Arms @ +${trigVal} ${slMode === 'POINTS' ? 'pts' : '₹'}`,
      };
    }

    if (slMode === 'POINTS') {
      const isArmed = activePosition.peakPoints >= trigVal;
      if (!isArmed) {
        const ptsNeeded = Math.max(0, trigVal - activePosition.peakPoints).toFixed(1);
        return {
          armed: false,
          active: true,
          label: 'STANDBY',
          detail: `Arms @ +${trigVal} pts (${ptsNeeded} pts left)`,
        };
      }
      const stepsBeyond = Math.floor((activePosition.peakPoints - trigVal) / stepVal);
      const lockedPoints = stepsBeyond * stepVal;
      return {
        armed: true,
        active: true,
        label: 'ARMED & LOCKING',
        detail: `Locked profit floor: +${lockedPoints} pts`,
        lockedValue: lockedPoints,
        unit: 'pts',
      };
    } else {
      const isArmed = activePosition.peakPnl >= trigVal;
      if (!isArmed) {
        const needed = Math.max(0, Math.round(trigVal - activePosition.peakPnl));
        return {
          armed: false,
          active: true,
          label: 'STANDBY',
          detail: `Arms @ +₹${trigVal} (₹${needed} left)`,
        };
      }
      const stepsBeyond = Math.floor((activePosition.peakPnl - trigVal) / stepVal);
      const lockedPnl = stepsBeyond * stepVal;
      return {
        armed: true,
        active: true,
        label: 'ARMED & LOCKING',
        detail: `Locked profit floor: +₹${lockedPnl}`,
        lockedValue: lockedPnl,
        unit: '₹',
      };
    }
  }, [trailingEnabled, trailTrigger, trailStep, activePosition, slMode]);

  // ── 7. Execute Synthetic Order (Long or Short) ──────────────────────────────
  const handleEnterSynthetic = async (direction: SyntheticDirection) => {
    if (inFlightRef.current) return;
    if (!atmStrike || atmStrike <= 0) {
      addToast('error', 'ATM Strike unavailable', 'Waiting for market quotes');
      return;
    }

    inFlightRef.current = true;
    setInFlight(true);
    setVisualFlash(direction);
    setTimeout(() => setVisualFlash(null), 1200);

    const dirLabel = direction === 'LONG' ? 'BULLISH LONG' : 'BEARISH SHORT';
    addToast('info', `Firing Synthetic ${dirLabel}…`, `${lots} Lots @ ATM ${atmStrike}`);

    try {
      const res = await fetch('/api/synthetic-futures/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enter',
          broker,
          underlying,
          expiry,
          direction,
          atmStrike,
          lots,
          lotSize,
          hedgeEnabled,
          hedgeOffset,
          productType,
          orderType: orderMode,
          strikeMap,
        }),
      });

      const json = await res.json();
      if (!json.success) {
        addToast('error', 'Execution Failed', json.error || 'Broker rejected order');
        addLog('ERROR', `Synthetic ${direction} Failed: ${json.error || 'Unknown error'}`);
        return;
      }

      // Build active synthetic position state
      const totalQty = lots * lotSize;
      const initialLegs: SyntheticLeg[] = [];
      const exchSeg = underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO';

      if (direction === 'LONG') {
        if (hedgeEnabled && hedgeOffset > 0) {
          initialLegs.push({
            role: 'HEDGE',
            optionType: 'PE',
            strike: longHedgeStrike,
            side: 'BUY',
            qty: totalQty,
            entryPrice: longHedgePeLtp,
            currentLtp: longHedgePeLtp,
            pnl: 0,
            securityId: strikeMap[String(longHedgeStrike)]?.peId,
            tradingSymbol: strikeMap[String(longHedgeStrike)]?.peSymbol,
            productType,
            exchangeSegment: exchSeg,
          });
        }
        initialLegs.push({
          role: 'MAIN_CE',
          optionType: 'CE',
          strike: atmStrike,
          side: 'BUY',
          qty: totalQty,
          entryPrice: atmCeLtp,
          currentLtp: atmCeLtp,
          pnl: 0,
          securityId: strikeMap[String(atmStrike)]?.ceId,
          tradingSymbol: strikeMap[String(atmStrike)]?.ceSymbol,
          productType,
          exchangeSegment: exchSeg,
        });
        initialLegs.push({
          role: 'MAIN_PE',
          optionType: 'PE',
          strike: atmStrike,
          side: 'SELL',
          qty: totalQty,
          entryPrice: atmPeLtp,
          currentLtp: atmPeLtp,
          pnl: 0,
          securityId: strikeMap[String(atmStrike)]?.peId,
          tradingSymbol: strikeMap[String(atmStrike)]?.peSymbol,
          productType,
          exchangeSegment: exchSeg,
        });
      } else {
        if (hedgeEnabled && hedgeOffset > 0) {
          initialLegs.push({
            role: 'HEDGE',
            optionType: 'CE',
            strike: shortHedgeStrike,
            side: 'BUY',
            qty: totalQty,
            entryPrice: shortHedgeCeLtp,
            currentLtp: shortHedgeCeLtp,
            pnl: 0,
            securityId: strikeMap[String(shortHedgeStrike)]?.ceId,
            tradingSymbol: strikeMap[String(shortHedgeStrike)]?.ceSymbol,
            productType,
            exchangeSegment: exchSeg,
          });
        }
        initialLegs.push({
          role: 'MAIN_PE',
          optionType: 'PE',
          strike: atmStrike,
          side: 'BUY',
          qty: totalQty,
          entryPrice: atmPeLtp,
          currentLtp: atmPeLtp,
          pnl: 0,
          securityId: strikeMap[String(atmStrike)]?.peId,
          tradingSymbol: strikeMap[String(atmStrike)]?.peSymbol,
          productType,
          exchangeSegment: exchSeg,
        });
        initialLegs.push({
          role: 'MAIN_CE',
          optionType: 'CE',
          strike: atmStrike,
          side: 'SELL',
          qty: totalQty,
          entryPrice: atmCeLtp,
          currentLtp: atmCeLtp,
          pnl: 0,
          securityId: strikeMap[String(atmStrike)]?.ceId,
          tradingSymbol: strikeMap[String(atmStrike)]?.ceSymbol,
          productType,
          exchangeSegment: exchSeg,
        });
      }

      const newPos: ActiveSyntheticPosition = {
        id: `synth-${Date.now()}`,
        direction,
        underlying,
        expiry,
        atmStrike,
        lots,
        lotSize,
        entrySyntheticPrice: syntheticFuturePrice,
        enteredAt: new Date().toLocaleTimeString('en-GB', { hour12: false }),
        hedged: hedgeEnabled,
        hedgeOffset,
        productType,
        legs: initialLegs,
        peakPoints: 0,
        peakPnl: 0,
      };

      setActivePosition(newPos);
      addToast('success', `Synthetic ${dirLabel} Entered!`, `Entry Synth Price: ₹${fmtNum(syntheticFuturePrice, 2)}`);
      addLog(
        'ENTRY',
        `Entered Synthetic ${direction} @ ${fmtNum(syntheticFuturePrice, 2)} (${lots} lots · ATM ${atmStrike})`,
        `Orders: ${(json.orderIds || []).join(', ')}`
      );
    } catch (err) {
      addToast('error', 'Execution Error', String(err));
      addLog('ERROR', `Network error executing synthetic ${direction}: ${String(err)}`);
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  };

  // ── 8. Flatten / Exit Synthetic Position ───────────────────────────────────
  const handleFlattenSynthetic = async (reason = 'Manual Exit'): Promise<boolean> => {
    if (inFlightRef.current) return false;
    if (!activePosition || activePosition.legs.length === 0) {
      addToast('info', 'No active synthetic position to flatten');
      return false;
    }

    inFlightRef.current = true;
    setInFlight(true);
    setVisualFlash('EXIT');
    setTimeout(() => setVisualFlash(null), 1200);

    addToast('info', `Flattening Synthetic Position…`, `Reason: ${reason}`);

    try {
      // Build exit legs: reverse transaction type
      const legsToExit = activePosition.legs.map(l => ({
        securityId: l.securityId,
        tradingSymbol: l.tradingSymbol,
        quantity: l.qty,
        side: l.side === 'BUY' ? ('SELL' as const) : ('BUY' as const),
        productType: l.productType,
        exchangeSegment: l.exchangeSegment,
      }));

      const res = await fetch('/api/synthetic-futures/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'exit',
          broker,
          underlying: activePosition.underlying,
          expiry: activePosition.expiry,
          legsToExit,
        }),
      });

      const json = await res.json();
      if (!json.success) {
        addToast('error', 'Flatten Failed', json.error || 'Broker rejected close orders');
        addLog('ERROR', `Flatten Failed: ${json.error || 'Unknown error'}`);
        return false;
      }

      const totalClosedPnl = activePosition.legs.reduce((acc, l) => acc + l.pnl, 0);
      addToast(
        'success',
        'Synthetic Position Flattened!',
        `Net P&L: ${fmtSignedINR(totalClosedPnl)} · Reason: ${reason}`
      );
      addLog('EXIT', `Flattened Synthetic (${reason}): Net P&L ${fmtSignedINR(totalClosedPnl)}`);

      setActivePosition(null);
      try {
        localStorage.removeItem('dhan_algo.synthetic_position');
      } catch {}
      return true;
    } catch (err) {
      addToast('error', 'Exit Error', String(err));
      addLog('ERROR', `Error flattening position: ${String(err)}`);
      return false;
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  };

  // ── 9. Flip / Reverse Position ─────────────────────────────────────────────
  const handleReversePosition = async () => {
    if (!activePosition) return;
    const targetDirection: SyntheticDirection = activePosition.direction === 'LONG' ? 'SHORT' : 'LONG';
    addToast('info', `Flipping Position to ${targetDirection}…`);
    const ok = await handleFlattenSynthetic('Reversing Position');
    if (!ok) {
      addToast('error', 'Reversal Aborted', 'Could not safely flatten current position first');
      return;
    }
    setTimeout(() => {
      handleEnterSynthetic(targetDirection);
    }, 400);
  };

  // ── 10. Trailing Stop Loss & Auto-Exit Rule Watcher ─────────────────────────
  useEffect(() => {
    if (!activePosition || inFlight) return;

    const currentSynth = syntheticFuturePrice;
    const capturedPoints =
      activePosition.direction === 'LONG'
        ? currentSynth - activePosition.entrySyntheticPrice
        : activePosition.entrySyntheticPrice - currentSynth;

    const currentPnl = activePosition.legs.reduce((acc, l) => acc + l.pnl, 0);

    const slVal = parseFloat(stopLoss) || 0;
    const tgtVal = parseFloat(target) || 0;
    const trailTrigVal = parseFloat(trailTrigger) || 0;
    const trailStepVal = parseFloat(trailStep) || 0;

    // Check Stop Loss
    if (slVal > 0) {
      if (slMode === 'POINTS' && capturedPoints <= -slVal) {
        handleFlattenSynthetic(`Stop Loss Hit (-${slVal} pts)`);
        return;
      }
      if (slMode === 'RUPEES' && currentPnl <= -slVal) {
        handleFlattenSynthetic(`Stop Loss Hit (-₹${slVal})`);
        return;
      }
    }

    // Check Profit Target
    if (tgtVal > 0) {
      if (slMode === 'POINTS' && capturedPoints >= tgtVal) {
        handleFlattenSynthetic(`Target Reached (+${tgtVal} pts)`);
        return;
      }
      if (slMode === 'RUPEES' && currentPnl >= tgtVal) {
        handleFlattenSynthetic(`Target Reached (+₹${tgtVal})`);
        return;
      }
    }

    // Check Trailing Stop Loss
    if (trailingEnabled && trailTrigVal > 0 && trailStepVal > 0) {
      if (slMode === 'POINTS') {
        if (activePosition.peakPoints >= trailTrigVal) {
          // Trailing SL is armed!
          // For every trailStepVal beyond trigger, lock in trailStepVal
          const stepsBeyond = Math.floor((activePosition.peakPoints - trailTrigVal) / trailStepVal);
          const trailingStopPoint = (stepsBeyond * trailStepVal); // locked in profit points
          if (capturedPoints <= trailingStopPoint) {
            handleFlattenSynthetic(`Trailing SL Hit (Locked ${trailingStopPoint} pts)`);
            return;
          }
        }
      } else {
        if (activePosition.peakPnl >= trailTrigVal) {
          const stepsBeyond = Math.floor((activePosition.peakPnl - trailTrigVal) / trailStepVal);
          const trailingStopPnl = (stepsBeyond * trailStepVal);
          if (currentPnl <= trailingStopPnl) {
            handleFlattenSynthetic(`Trailing SL Hit (Locked ₹${trailingStopPnl})`);
            return;
          }
        }
      }
    }
  }, [syntheticFuturePrice, activePosition, stopLoss, target, trailingEnabled, trailTrigger, trailStep, slMode, inFlight]);

  // ── 11. Keyboard Shortcuts (B: Buy, S: Sell, X: Flatten) ───────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore when user is focused inside an input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;

      if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleEnterSynthetic('LONG');
      } else if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleEnterSynthetic('SHORT');
      } else if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleFlattenSynthetic('Hotkey [X] Triggered');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleEnterSynthetic, handleFlattenSynthetic]);

  // Current Active P&L
  const activePnl = activePosition ? activePosition.legs.reduce((acc, l) => acc + l.pnl, 0) : 0;
  const activePoints = activePosition
    ? activePosition.direction === 'LONG'
      ? syntheticFuturePrice - activePosition.entrySyntheticPrice
      : activePosition.entrySyntheticPrice - syntheticFuturePrice
    : 0;

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex flex-col font-sans pb-16 selection:bg-emerald-500/20 selection:text-emerald-300">
      {/* ── Visual Flash Border on Execution ───────────────────────────────── */}
      <div
        className={`pointer-events-none fixed inset-0 z-50 transition-opacity duration-700 ${
          visualFlash === 'LONG'
            ? 'border-4 border-emerald-500/80 bg-emerald-500/5 opacity-100'
            : visualFlash === 'SHORT'
              ? 'border-4 border-red-500/80 bg-red-500/5 opacity-100'
              : visualFlash === 'EXIT'
                ? 'border-4 border-amber-500/80 bg-amber-500/5 opacity-100'
                : 'opacity-0'
        }`}
      />

      {/* ── Toast Notifications ─────────────────────────────────────────────── */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border p-3.5 shadow-2xl backdrop-blur-md transition-all animate-in slide-in-from-top-2 duration-200 ${
              t.type === 'success'
                ? 'border-emerald-500/40 bg-zinc-900/90 text-emerald-300'
                : t.type === 'error'
                  ? 'border-red-500/40 bg-zinc-900/90 text-red-300'
                  : 'border-zinc-700 bg-zinc-900/90 text-zinc-200'
            }`}
          >
            {t.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
            ) : t.type === 'error' ? (
              <XCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
            ) : (
              <Radio className="h-4 w-4 shrink-0 text-sky-400 mt-0.5 animate-pulse" />
            )}
            <div className="flex-1 text-xs">
              <p className="font-bold">{t.message}</p>
              {t.detail && <p className="text-[11px] text-zinc-400 mt-0.5">{t.detail}</p>}
            </div>
          </div>
        ))}
      </div>

      {/* ── Header Telemetry & Ticker HUD ──────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-md px-4 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Logo & Desk Title */}
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.25)]">
              <Zap className="h-4 w-4 fill-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold tracking-wider uppercase text-zinc-100">
                  Quantum Synthetic Futures
                </h1>
                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[9px] font-mono font-bold text-emerald-400 tracking-wide">
                  ATM SCALPER
                </span>
              </div>
              <p className="text-[10px] text-zinc-400 font-mono">
                1-Click Directional Futures via Replicated Options · Zero Slippage Basis
              </p>
            </div>
          </div>

          {/* Real-time Headline Indices Ticker (NIFTY & SENSEX) */}
          <div className="flex items-center gap-3 font-mono">
            {/* NIFTY 50 Ticker */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 flex items-center gap-2.5 shadow-sm">
              <span className="text-[10px] font-bold tracking-wider text-zinc-400">NIFTY 50</span>
              <span className="text-xs font-bold tabular-nums text-zinc-100">
                {fmtNum(indices.NIFTY?.spot ?? liveSpot, 2)}
              </span>
              <span
                className={`text-[10px] font-semibold tabular-nums flex items-center gap-0.5 ${
                  (indices.NIFTY?.change ?? spotChange) >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {(indices.NIFTY?.change ?? spotChange) >= 0 ? '▲' : '▼'}
                {fmtSignedNum(indices.NIFTY?.change ?? spotChange, 2)} (
                {fmtSignedNum(indices.NIFTY?.changePct ?? spotChangePct, 2)}%)
              </span>
            </div>

            {/* SENSEX Ticker */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 flex items-center gap-2.5 shadow-sm">
              <span className="text-[10px] font-bold tracking-wider text-zinc-400">SENSEX</span>
              <span className="text-xs font-bold tabular-nums text-zinc-100">
                {fmtNum(indices.SENSEX?.spot, 2)}
              </span>
              <span
                className={`text-[10px] font-semibold tabular-nums flex items-center gap-0.5 ${
                  (indices.SENSEX?.change ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {(indices.SENSEX?.change ?? 0) >= 0 ? '▲' : '▼'}
                {fmtSignedNum(indices.SENSEX?.change, 2)} (
                {fmtSignedNum(indices.SENSEX?.changePct, 2)}%)
              </span>
            </div>

            {/* WebSocket Stream Radar Status */}
            <div
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-mono font-semibold ${
                transport === 'ws' && bridgeStatus.status === 'RUNNING'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  transport === 'ws' && bridgeStatus.status === 'RUNNING'
                    ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                    : 'bg-zinc-500'
                }`}
              />
              <span>{transport === 'ws' ? 'WS 40Hz' : 'POLL 100ms'}</span>
            </div>
          </div>
        </div>
      </header>

      {/* ── Main Workspace ──────────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-4 py-4 w-full flex flex-col gap-4">
        {/* ── Command Config Bar ────────────────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-md">
          {/* Left Group: Underlying & Expiry & Broker */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Underlying Pill Toggle */}
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/90 p-0.5 text-xs font-mono">
              {(['NIFTY', 'SENSEX', 'BANKNIFTY'] as Underlying[]).map(u => (
                <button
                  key={u}
                  onClick={() => setUnderlying(u)}
                  className={`px-3 py-1 rounded-md font-bold transition-all ${
                    underlying === u
                      ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>

            {/* Expiry Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">Expiry</span>
              <select
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs font-mono font-bold text-zinc-100 focus:outline-none focus:border-emerald-500/50"
              >
                {expiries.map(exp => (
                  <option key={exp} value={exp}>
                    {exp}
                  </option>
                ))}
              </select>
            </div>

            {/* Broker Pill */}
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-[11px] font-bold text-zinc-400 uppercase">Broker</span>
              <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 font-mono text-[11px]">
                {(['dhan', 'zerodha', 'kotak'] as Broker[]).map(b => (
                  <button
                    key={b}
                    onClick={() => setBroker(b)}
                    className={`px-2.5 py-0.5 rounded uppercase font-bold transition-all ${
                      broker === b
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right Group: Lots, Product & Order Type */}
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            {/* Quick Lots Stepper */}
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
              <span className="text-[10px] font-bold text-zinc-400 px-1">LOTS</span>
              {[1, 2, 3, 5, 10].map(l => (
                <button
                  key={l}
                  onClick={() => setLots(l)}
                  className={`px-2 py-0.5 rounded text-[11px] font-bold transition-all ${
                    lots === l
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {l}
                </button>
              ))}
              <span className="text-[10px] text-zinc-500 pl-1">
                ({lots * lotSize} qty)
              </span>
            </div>

            {/* Product Type Toggle */}
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]">
              <button
                onClick={() => setProductType('INTRADAY')}
                className={`px-2 py-0.5 rounded font-bold transition-all ${
                  productType === 'INTRADAY'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                MIS
              </button>
              <button
                onClick={() => setProductType('MARGIN')}
                className={`px-2 py-0.5 rounded font-bold transition-all ${
                  productType === 'MARGIN'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                NRML
              </button>
            </div>

            {/* Order Mode Toggle */}
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]">
              <button
                onClick={() => setOrderMode('MARKET')}
                className={`px-2 py-0.5 rounded font-bold transition-all ${
                  orderMode === 'MARKET'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                MKT
              </button>
              <button
                onClick={() => setOrderMode('LIMIT')}
                className={`px-2 py-0.5 rounded font-bold transition-all ${
                  orderMode === 'LIMIT'
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                LMT
              </button>
            </div>
          </div>
        </div>

        {/* ── Futuristic ATM & Synthetic Gauge Panel ───────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Card 1: Spot Price & Distance to ATM */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
            <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
              <span className="flex items-center gap-1.5 font-bold uppercase">
                <Activity className="h-3.5 w-3.5 text-emerald-400" />
                Underlying Spot Index
              </span>
              <span className="text-[10px] text-zinc-500">{underlying}</span>
            </div>
            <div className="my-2">
              <div className="text-2xl font-bold tracking-tight font-mono text-zinc-100 tabular-nums">
                {fmtNum(liveSpot, 2)}
              </div>
              <div
                className={`text-xs font-mono font-semibold tabular-nums mt-0.5 ${
                  spotChange >= 0 ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {spotChange >= 0 ? '▲ +' : '▼ '}
                {fmtNum(spotChange, 2)} ({fmtSignedNum(spotChangePct, 2)}%)
              </div>
            </div>
            <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[11px] font-mono text-zinc-400">
              <span>ATM Strike:</span>
              <span className="font-bold text-zinc-200">{atmStrike}</span>
              <span className="text-[10px] text-zinc-500">
                (Δ {fmtSignedNum(liveSpot - atmStrike, 1)} pts)
              </span>
            </div>
          </div>

          {/* Card 2: Synthetic Future Live Price (Replicated Matrix) */}
          <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-4 flex flex-col justify-between shadow-sm relative overflow-hidden">
            <div className="flex items-center justify-between text-sky-400 text-xs font-mono">
              <span className="flex items-center gap-1.5 font-bold uppercase">
                <Gauge className="h-3.5 w-3.5 text-sky-400" />
                Live Synthetic Future Price
              </span>
              <span className="rounded bg-sky-500/20 border border-sky-500/30 px-1 py-0.2 text-[9px] font-bold text-sky-300">
                K + CE - PE
              </span>
            </div>
            <div className="my-2">
              <div className="text-2xl font-bold tracking-tight font-mono text-sky-200 tabular-nums">
                {fmtNum(syntheticFuturePrice, 2)}
              </div>
              <div className="text-xs font-mono text-zinc-400 mt-0.5">
                Basis vs Spot:{' '}
                <strong
                  className={`tabular-nums ${
                    syntheticBasis >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {fmtSignedNum(syntheticBasis, 2)} pts
                </strong>
              </div>
            </div>
            <div className="pt-2 border-t border-sky-900/60 flex items-center justify-between text-[11px] font-mono text-zinc-300">
              <span>ATM CE: ₹{fmtNum(atmCeLtp, 1)}</span>
              <span className="text-zinc-500">|</span>
              <span>ATM PE: ₹{fmtNum(atmPeLtp, 1)}</span>
              <span className="text-zinc-500">|</span>
              <span className="text-amber-400 font-semibold">
                Diff: {fmtSignedNum(atmCeLtp - atmPeLtp, 1)}
              </span>
            </div>
          </div>

          {/* Card 3: Active Position P&L or Idle Telemetry */}
          <div
            className={`rounded-xl border p-4 flex flex-col justify-between shadow-sm relative overflow-hidden ${
              activePosition
                ? activePnl >= 0
                  ? 'border-emerald-500/50 bg-emerald-950/20'
                  : 'border-red-500/50 bg-red-950/20'
                : 'border-zinc-800 bg-zinc-950'
            }`}
          >
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="flex items-center gap-1.5 font-bold uppercase text-zinc-400">
                <Crosshair className="h-3.5 w-3.5 text-amber-400" />
                Active Position Live P&L
              </span>
              {activePosition ? (
                <span
                  className={`rounded px-1.5 py-0.2 text-[9px] font-bold ${
                    activePosition.direction === 'LONG'
                      ? 'border border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                      : 'border border-red-500/40 bg-red-500/20 text-red-300'
                  }`}
                >
                  {activePosition.direction} SYNTHETIC
                </span>
              ) : (
                <span className="text-[10px] text-zinc-500">FLAT / NO POSITION</span>
              )}
            </div>
            <div className="my-2">
              <div
                className={`text-2xl font-bold tracking-tight font-mono tabular-nums ${
                  activePosition
                    ? activePnl >= 0
                      ? 'text-emerald-400'
                      : 'text-red-400'
                    : 'text-zinc-400'
                }`}
              >
                {activePosition ? fmtSignedINR(activePnl) : '₹0.00'}
              </div>
              <div className="text-xs font-mono text-zinc-400 mt-0.5">
                {activePosition ? (
                  <>
                    Points Captured:{' '}
                    <strong
                      className={`tabular-nums ${
                        activePoints >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {fmtSignedNum(activePoints, 2)} pts
                    </strong>{' '}
                    · Entry: ₹{fmtNum(activePosition.entrySyntheticPrice, 1)}
                  </>
                ) : (
                  'Ready to fire synthetic long or short order'
                )}
              </div>
            </div>
            <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[11px] font-mono text-zinc-400">
              {activePosition ? (
                <>
                  <span>
                    Peak P&L:{' '}
                    <strong className="text-emerald-400 tabular-nums">
                      {fmtSignedINR(activePosition.peakPnl)}
                    </strong>
                  </span>
                  <span>
                    Peak Pts:{' '}
                    <strong className="text-emerald-400 tabular-nums">
                      +{fmtNum(activePosition.peakPoints, 1)}
                    </strong>
                  </span>
                </>
              ) : (
                <>
                  <span>Delta: ~1.00 per lot</span>
                  <span>Qty: {lots * lotSize}</span>
                </>
              )}
            </div>

            {/* Trailing Stop Level Status HUD Chip */}
            {activePosition && trailingEnabled && (
              <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-[11px] font-mono">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 text-amber-400" />
                  Trailing Stop Level:
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold flex items-center gap-1.5 ${
                    trailingStatus.armed
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      trailingStatus.armed ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'
                    }`}
                  />
                  <span>{trailingStatus.label}: {trailingStatus.detail}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── Dual Futuristic Execution Cockpit ─────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 🟢 BULLISH SYNTHETIC LONG PAD */}
          <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-b from-zinc-950 to-emerald-950/20 p-5 flex flex-col justify-between shadow-xl relative overflow-hidden group hover:border-emerald-500/50 transition-all">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
                </span>
                <span className="text-sm font-bold tracking-wider uppercase text-emerald-400 font-mono">
                  BULLISH LONG SYNTHETIC
                </span>
              </div>
              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-300">
                DELTA +1.00
              </span>
            </div>

            {/* Leg Execution Specification */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3 flex flex-col gap-2 font-mono text-xs mb-4">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  BUY ATM Call (CE):
                </span>
                <span className="font-bold text-zinc-100">
                  {atmStrike} CE @ ₹{fmtNum(atmCeLtp, 2)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                  SELL ATM Put (PE):
                </span>
                <span className="font-bold text-zinc-100">
                  {atmStrike} PE @ ₹{fmtNum(atmPeLtp, 2)}
                </span>
              </div>
              {hedgeEnabled && (
                <div className="flex items-center justify-between border-t border-zinc-800 pt-1.5 text-amber-300">
                  <span className="flex items-center gap-1.5">
                    <Shield className="h-3 w-3 text-amber-400" />
                    HEDGE: BUY OTM Put:
                  </span>
                  <span className="font-bold">
                    {longHedgeStrike} PE @ ₹{fmtNum(longHedgePeLtp, 2)}
                  </span>
                </div>
              )}
            </div>

            {/* Price & Margin Telemetry */}
            <div className="flex items-center justify-between font-mono text-xs text-zinc-400 mb-4 px-1">
              <div>
                <span>Net Carry:{' '}</span>
                <strong className="text-zinc-200">
                  {longEntryNetPrice >= 0 ? `Debit ₹${fmtNum(longEntryNetPrice, 2)}` : `Credit ₹${fmtNum(Math.abs(longEntryNetPrice), 2)}`}
                </strong>
              </div>
              <div>
                <span>Est. Margin:{' '}</span>
                <strong className={hedgeEnabled ? 'text-emerald-400' : 'text-zinc-300'}>
                  {hedgeEnabled ? '~₹38,000 (Hedged)' : '~₹1,35,000 (Naked)'}
                </strong>
              </div>
            </div>

            {/* Big Action Button */}
            <button
              onClick={() => handleEnterSynthetic('LONG')}
              disabled={inFlight}
              className="w-full py-3.5 px-4 rounded-xl font-mono text-sm font-bold tracking-wider uppercase text-emerald-950 bg-emerald-400 hover:bg-emerald-300 active:scale-[0.99] disabled:opacity-50 transition-all shadow-[0_0_25px_rgba(16,185,129,0.35)] hover:shadow-[0_0_35px_rgba(16,185,129,0.5)] flex items-center justify-center gap-2 cursor-pointer"
            >
              <Zap className="h-4 w-4 fill-emerald-950" />
              BUY SYNTHETIC (LONG)
              <span className="text-[11px] opacity-75 font-normal tracking-normal border border-emerald-900/40 rounded px-1.5 py-0.2 bg-emerald-500/30">
                KEY [B]
              </span>
            </button>
          </div>

          {/* 🔴 BEARISH SYNTHETIC SHORT PAD */}
          <div className="rounded-2xl border border-red-500/30 bg-gradient-to-b from-zinc-950 to-red-950/20 p-5 flex flex-col justify-between shadow-xl relative overflow-hidden group hover:border-red-500/50 transition-all">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="flex h-3 w-3 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                </span>
                <span className="text-sm font-bold tracking-wider uppercase text-red-400 font-mono">
                  BEARISH SHORT SYNTHETIC
                </span>
              </div>
              <span className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-red-300">
                DELTA -1.00
              </span>
            </div>

            {/* Leg Execution Specification */}
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3 flex flex-col gap-2 font-mono text-xs mb-4">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                  SELL ATM Call (CE):
                </span>
                <span className="font-bold text-zinc-100">
                  {atmStrike} CE @ ₹{fmtNum(atmCeLtp, 2)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  BUY ATM Put (PE):
                </span>
                <span className="font-bold text-zinc-100">
                  {atmStrike} PE @ ₹{fmtNum(atmPeLtp, 2)}
                </span>
              </div>
              {hedgeEnabled && (
                <div className="flex items-center justify-between border-t border-zinc-800 pt-1.5 text-amber-300">
                  <span className="flex items-center gap-1.5">
                    <Shield className="h-3 w-3 text-amber-400" />
                    HEDGE: BUY OTM Call:
                  </span>
                  <span className="font-bold">
                    {shortHedgeStrike} CE @ ₹{fmtNum(shortHedgeCeLtp, 2)}
                  </span>
                </div>
              )}
            </div>

            {/* Price & Margin Telemetry */}
            <div className="flex items-center justify-between font-mono text-xs text-zinc-400 mb-4 px-1">
              <div>
                <span>Net Carry:{' '}</span>
                <strong className="text-zinc-200">
                  {shortEntryNetPrice >= 0 ? `Debit ₹${fmtNum(shortEntryNetPrice, 2)}` : `Credit ₹${fmtNum(Math.abs(shortEntryNetPrice), 2)}`}
                </strong>
              </div>
              <div>
                <span>Est. Margin:{' '}</span>
                <strong className={hedgeEnabled ? 'text-emerald-400' : 'text-zinc-300'}>
                  {hedgeEnabled ? '~₹38,000 (Hedged)' : '~₹1,35,000 (Naked)'}
                </strong>
              </div>
            </div>

            {/* Big Action Button */}
            <button
              onClick={() => handleEnterSynthetic('SHORT')}
              disabled={inFlight}
              className="w-full py-3.5 px-4 rounded-xl font-mono text-sm font-bold tracking-wider uppercase text-white bg-red-600 hover:bg-red-500 active:scale-[0.99] disabled:opacity-50 transition-all shadow-[0_0_25px_rgba(239,68,68,0.35)] hover:shadow-[0_0_35px_rgba(239,68,68,0.5)] flex items-center justify-center gap-2 cursor-pointer"
            >
              <Zap className="h-4 w-4 fill-white" />
              SELL SYNTHETIC (SHORT)
              <span className="text-[11px] opacity-75 font-normal tracking-normal border border-red-300/40 rounded px-1.5 py-0.2 bg-red-700/50">
                KEY [S]
              </span>
            </button>
          </div>
        </div>

        {/* ── Option Hedging & Scalping Risk Module ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Box A: Option Hedging Controls (Wings / Margin Optimizer) */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 flex flex-col justify-between shadow-md">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-amber-400" />
                <span className="text-xs font-bold font-mono tracking-wider uppercase text-zinc-100">
                  Option Hedging Protection
                </span>
              </div>
              {/* Toggle Switch */}
              <button
                onClick={() => setHedgeEnabled(!hedgeEnabled)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold transition-all ${
                  hedgeEnabled
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
                    : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                }`}
              >
                {hedgeEnabled ? <Lock className="h-3 w-3 text-amber-400" /> : <Unlock className="h-3 w-3 text-zinc-500" />}
                {hedgeEnabled ? 'HEDGE ARMED' : 'NAKED RISK'}
              </button>
            </div>

            <p className="text-[11px] text-zinc-400 mb-3">
              Buys OTM protective wings first to eliminate undefined tail risk and unlock exchange basket margin reduction (~70-80% margin relief).
            </p>

            {/* Wing Distance Stepper */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-mono text-zinc-400 uppercase font-bold">
                Wing Offset Distance (OTM Points)
              </span>
              <div className="grid grid-cols-6 gap-1.5 font-mono text-xs">
                {wingOffsets.map(pts => (
                  <button
                    key={pts}
                    disabled={!hedgeEnabled}
                    onClick={() => setHedgeOffset(pts)}
                    className={`py-1.5 rounded-lg border font-bold transition-all ${
                      hedgeOffset === pts && hedgeEnabled
                        ? 'border-amber-500/50 bg-amber-500/20 text-amber-300'
                        : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                    } disabled:opacity-30`}
                  >
                    {pts} pts
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400 mt-1">
                <span>Long Wing: {longHedgeStrike} PE</span>
                <span>Short Wing: {shortHedgeStrike} CE</span>
              </div>
            </div>
          </div>

          {/* Box B: Stop Loss, Target & Trailing SL Cockpit */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 flex flex-col justify-between shadow-md">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Crosshair className="h-4 w-4 text-emerald-400" />
                <span className="text-xs font-bold font-mono tracking-wider uppercase text-zinc-100">
                  Scalping Risk & Trailing SL
                </span>
              </div>
              {/* SL Mode: Points vs Rupees */}
              <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-[10px] font-mono">
                <button
                  onClick={() => setSlMode('POINTS')}
                  className={`px-2 py-0.5 rounded font-bold transition-all ${
                    slMode === 'POINTS' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
                  }`}
                >
                  POINTS
                </button>
                <button
                  onClick={() => setSlMode('RUPEES')}
                  className={`px-2 py-0.5 rounded font-bold transition-all ${
                    slMode === 'RUPEES' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'
                  }`}
                >
                  ₹ P&L
                </button>
              </div>
            </div>

            {/* Inputs: SL, Target, Trailing */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  Stop Loss ({slMode === 'POINTS' ? 'Pts' : '₹'})
                </label>
                <RuleNumInput
                  value={stopLoss}
                  onCommit={setStopLoss}
                  placeholder="30"
                  className="w-full mt-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-mono font-bold text-red-300 focus:outline-none focus:border-red-500/50"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono font-bold text-zinc-400 uppercase">
                  Profit Target ({slMode === 'POINTS' ? 'Pts' : '₹'})
                </label>
                <RuleNumInput
                  value={target}
                  onCommit={setTarget}
                  placeholder="60"
                  className="w-full mt-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-mono font-bold text-emerald-300 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
            </div>

            {/* Trailing SL Settings */}
            <div className="pt-2 border-t border-zinc-800/80 flex flex-col gap-2 font-mono text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 text-[11px] flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={trailingEnabled}
                    onChange={e => setTrailingEnabled(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0 cursor-pointer"
                  />
                  Enable Dynamic Trailing Stop Loss
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold flex items-center gap-1 ${
                    trailingStatus.armed
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse'
                      : trailingStatus.active
                        ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                        : 'bg-zinc-900 text-zinc-500'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      trailingStatus.armed ? 'bg-emerald-400' : 'bg-zinc-500'
                    }`}
                  />
                  {trailingStatus.label}: {trailingStatus.detail}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] text-zinc-500">Arm Trigger ({slMode === 'POINTS' ? 'Pts' : '₹'})</span>
                  <RuleNumInput
                    value={trailTrigger}
                    disabled={!trailingEnabled}
                    onCommit={setTrailTrigger}
                    placeholder="20"
                    className="w-full mt-0.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs font-mono font-semibold text-zinc-200 disabled:opacity-40"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-zinc-500">Trail Step ({slMode === 'POINTS' ? 'Pts' : '₹'})</span>
                  <RuleNumInput
                    value={trailStep}
                    disabled={!trailingEnabled}
                    onCommit={setTrailStep}
                    placeholder="10"
                    className="w-full mt-0.5 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs font-mono font-semibold text-zinc-200 disabled:opacity-40"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Emergency Instant Actions Bar ─────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 flex flex-wrap items-center justify-between gap-3 shadow-md font-mono">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-bold uppercase text-zinc-300">
              Instant Scalper Controls
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* Flip Position Button */}
            <button
              onClick={handleReversePosition}
              disabled={!activePosition || inFlight}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 text-xs font-bold disabled:opacity-30 cursor-pointer transition-all active:scale-[0.98]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              FLIP POSITION
            </button>

            {/* Emergency Flatten All Button */}
            <button
              onClick={() => handleFlattenSynthetic('Manual Close All')}
              disabled={!activePosition || inFlight}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-500/50 bg-red-600 hover:bg-red-500 text-white text-xs font-bold disabled:opacity-30 cursor-pointer transition-all active:scale-[0.98] shadow-[0_0_15px_rgba(239,68,68,0.3)]"
            >
              <XCircle className="h-4 w-4" />
              CLOSE SYNTHETIC (FLATTEN)
              <span className="text-[10px] opacity-80 font-normal border border-red-300/40 rounded px-1 bg-red-700/40">
                [X]
              </span>
            </button>
          </div>
        </div>

        {/* ── Active Position Breakdown Table ───────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/40">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-emerald-400" />
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-100 font-mono">
                Active Position Leg Book
              </span>
              {activePosition && (
                <span className="rounded bg-zinc-800 px-1.5 py-0.2 text-[10px] font-mono text-zinc-400">
                  {activePosition.legs.length} LEGS
                </span>
              )}
            </div>

            {activePosition && (
              <div className="flex items-center gap-3 font-mono text-xs">
                <span className="text-zinc-400">
                  Points Captured:{' '}
                  <strong className={activePoints >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {fmtSignedNum(activePoints, 2)}
                  </strong>
                </span>
                <span className="text-zinc-600">|</span>
                <span className="text-zinc-400">
                  Net P&L:{' '}
                  <strong className={activePnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {fmtSignedINR(activePnl)}
                  </strong>
                </span>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-zinc-800">
                  <th className="px-4 py-2.5 text-xs font-bold text-white">Leg Role</th>
                  <th className="px-4 py-2.5 text-xs font-bold text-white">Side</th>
                  <th className="px-4 py-2.5 text-xs font-bold text-white">Contract / Strike</th>
                  <th className="px-4 py-2.5 text-right text-xs font-bold text-white">Qty</th>
                  <th className="px-4 py-2.5 text-right text-xs font-bold text-white">Entry Avg</th>
                  <th className="px-4 py-2.5 text-right text-xs font-bold text-white">LTP</th>
                  <th className="px-4 py-2.5 text-right text-xs font-bold text-white">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 font-mono text-xs">
                {activePosition && activePosition.legs.length > 0 ? (
                  activePosition.legs.map((leg, idx) => (
                    <tr key={idx} className="hover:bg-zinc-900/40 transition-colors">
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            leg.role === 'HEDGE'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-zinc-800 text-zinc-300'
                          }`}
                        >
                          {leg.role}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            leg.side === 'BUY'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
                              : 'bg-red-500/10 text-red-400 border border-red-500/25'
                          }`}
                        >
                          {leg.side}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-bold text-zinc-100">
                        {activePosition.underlying} {leg.strike} {leg.optionType}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-200">
                        {leg.qty}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">
                        ₹{fmtNum(leg.entryPrice, 2)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-100 font-bold">
                        ₹{fmtNum(leg.currentLtp, 2)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums font-bold ${
                          leg.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {fmtSignedINR(leg.pnl)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 font-mono text-xs">
                      No active synthetic legs open. Click BUY or SELL above to initiate a synthetic trade.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Scalp Activity Log ────────────────────────────────────────────── */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider">
              Scalp Execution Event Stream
            </span>
            <span className="text-[10px] font-mono text-zinc-500">{logs.length} events</span>
          </div>
          <div className="max-h-36 overflow-y-auto space-y-1 font-mono text-[11px] divide-y divide-zinc-900">
            {logs.length > 0 ? (
              logs.map(l => (
                <div key={l.id} className="pt-1 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500 text-[10px]">{l.time}</span>
                    <span
                      className={`font-bold px-1 rounded text-[9px] ${
                        l.type === 'ENTRY'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : l.type === 'EXIT'
                            ? 'bg-amber-500/20 text-amber-400'
                            : l.type === 'ERROR'
                              ? 'bg-red-500/20 text-red-400'
                              : 'bg-zinc-800 text-zinc-300'
                      }`}
                    >
                      {l.type}
                    </span>
                    <span className="text-zinc-200">{l.message}</span>
                  </div>
                  {l.detail && <span className="text-zinc-500 text-[10px]">{l.detail}</span>}
                </div>
              ))
            ) : (
              <p className="text-zinc-600 text-center py-4">
                No orders placed in this session yet. Realtime events will stream here.
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
