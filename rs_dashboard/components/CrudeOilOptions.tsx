'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Clock, Fuel, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TooltipProvider } from '@/components/ui/tooltip';

import CrudeOilOITab from './CrudeOilOITab';
import CrudeOilCumulativeOITab from './CrudeOilCumulativeOITab';

import ActivityPanel, { type ActivityTab } from './crudeoil/ActivityPanel';
import ChainTable from './crudeoil/ChainTable';
import ConfirmDialog from './crudeoil/ConfirmDialog';
import MarketSnapshot from './crudeoil/MarketSnapshot';
import TradeTicketBar from './crudeoil/TradeTicketBar';
import NavBar from './NavBar';
import {
  computeMaxPain, daysToExpiry, fmtExpiryLong, fmtExpiryShort, fmtNum,
  parseStrikeEntries, pctColor, pctSign, sideIV, todayIso,
} from './crudeoil/format';
import {
  CRUDE_BROKERS, CRUDE_BROKER_LABELS, CRUDE_UNDERLYINGS, CRUDE_UNDERLYING_LABELS,
  EMPTY_CHAIN_STATS, STRIKE_STEP_BY_UNDERLYING, WING_OPTIONS,
  type ChainStats, type ConfirmPayload, type CrudeBroker, type CrudeOrder,
  type CrudePosition, type CrudeTrade, type CrudeUnderlying, type KotakSymbolMap,
  type ProcessedRow, type RawChainEntry, type Wings,
} from './crudeoil/types';

// ─── Constants ────────────────────────────────────────────────────

const POLL_MS     = 15_000;
const SPOT_FALLBACK_POLL_MS = 60_000;
// Background pricing for the non-displayed underlying's open positions only
// needs to be fresh enough for P&L, not trading-fast — kept slower than the
// main chain's POLL_MS so it never doubles up the Dhan option-chain rate
// limit the way concurrent fetchChain+fetchSpot calls once did.
const OTHER_UNDERLYING_POLL_MS = 45_000;

// Chain, spot, IV and OI always come from Dhan regardless of the selected
// broker. An option's LTP is set by the exchange, not the broker, so Kotak's
// numbers would be identical — only order routing and the position book are
// broker-specific. Same reasoning as app/api/options/chain's QUOTE_SOURCE.
const POSITIONS_ROUTE: Record<CrudeBroker, string> = {
  dhan:  '/api/crudeoil-trades',
  kotak: '/api/crudeoil-trades/kotak',
};

// SL/Target thresholds are per broker AND per underlying — see the loader
// below for why (Kotak/Dhan name the same contract differently, and CRUDEOIL
// vs CRUDEOILM are separate contract families with their own symbols).
const RISK_KEY_LEGACY = 'crude_risk_configs_v2';
const RISK_KEY = (b: CrudeBroker, u: CrudeUnderlying) => `${RISK_KEY_LEGACY}:${b}:${u}`;

/**
 * Which of the two contract families a trading symbol belongs to, from its
 * own prefix (e.g. "CRUDEOILM17SEP267500PE" / "CRUDEOIL17SEP268100CE") — used
 * to price a position against the RIGHT underlying's chain regardless of
 * which one is currently selected for display. Checks the digit right after
 * the prefix so "CRUDEOILM..." never false-matches the "CRUDEOIL" prefix.
 */
function crudeSymbolUnderlying(symbol: string): CrudeUnderlying | null {
  const s = symbol.toUpperCase();
  for (const u of CRUDE_UNDERLYINGS) {
    if (s.startsWith(u) && /[0-9]/.test(s[u.length] ?? '')) return u;
  }
  return null;
}

// ─── Main Component ───────────────────────────────────────────────

export default function CrudeOilOptions() {
  const router = useRouter();

  // ─── Underlying selection ──────────────────────────────────────────
  const [underlying, setUnderlying]   = useState<CrudeUnderlying>('CRUDEOIL');
  const underlyingLabel               = CRUDE_UNDERLYING_LABELS[underlying];
  const strikeStep                    = STRIKE_STEP_BY_UNDERLYING[underlying];
  // The one not currently on screen — its open positions still need pricing
  // for the Positions tab, which lists both families regardless of the
  // selector (see the background chain poll further down).
  const otherUnderlying: CrudeUnderlying = underlying === 'CRUDEOIL' ? 'CRUDEOILM' : 'CRUDEOIL';
  const otherStrikeStep                = STRIKE_STEP_BY_UNDERLYING[otherUnderlying];

  const [expiries, setExpiries]       = useState<string[]>([]);
  const [expiry, setExpiry]           = useState<string>('');
  const [spot, setSpot]               = useState(0);
  const [prevClose, setPrevClose]     = useState(0);
  const [change, setChange]           = useState(0);
  const [changePct, setChangePct]     = useState(0);

  const [rows, setRows]               = useState<ProcessedRow[]>([]);
  const [stats, setStats]             = useState<ChainStats>(EMPTY_CHAIN_STATS);
  const [wings, setWings]             = useState<Wings>(10);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [stale, setStale]             = useState(false);   // last poll failed but we keep showing prior rows

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const chainFailsRef = useRef(0);   // consecutive fetchChain failures
  const STALE_ERROR_AFTER = 4;       // only show a blocking error after this many consecutive failures

  const [lots, setLots]               = useState(1);
  // Dhan MCX order quantity is in LOTS (verified from the live order book), so its
  // lot size is 1 — NOT 100 (barrels per lot, already baked into the contract).
  // Kotak is the opposite: `qt` is absolute, so its lot size really is 100
  // (CRUDEOIL) / 10 (CRUDEOILM) and comes from the instrument cache.
  const [dhanLotSize, setDhanLotSize] = useState(1);
  const [orderMessage, setOrderMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const [ordering, setOrdering]       = useState(false);

  // ─── Broker selection ─────────────────────────────────────────────
  const [broker, setBroker]                   = useState<CrudeBroker>('dhan');
  const [brokerAuth, setBrokerAuth]           = useState<Record<CrudeBroker, boolean> | null>(null);
  const [kotakSymbols, setKotakSymbols]       = useState<KotakSymbolMap | null>(null);
  const [kotakSymbolsError, setKotakSymbolsError] = useState<string | null>(null);
  const isKotak     = broker === 'kotak';
  const brokerLabel = CRUDE_BROKER_LABELS[broker];
  const lotSize     = isKotak ? (kotakSymbols?.lotSize ?? 100) : dhanLotSize;

  // Single confirmation modal shared by the SL/Target auto-exit and Exit All.
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmPayload | null>(null);

  // The book is stamped with the broker it came from and only rendered when
  // that matches the current selection. Clearing it in an effect instead would
  // leave one render where the previous broker's positions are on screen and
  // Exit All would act on them.
  const [book, setBook] = useState<{
    broker: CrudeBroker;
    positions: CrudePosition[];
    orders: CrudeOrder[];
    trades: CrudeTrade[];
    error: string | null;
    loaded: boolean;
  }>({ broker: 'dhan', positions: [], orders: [], trades: [], error: null, loaded: false });
  const [activeActivityTab, setActiveActivityTab] = useState<ActivityTab>('positions');
  const tradesIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [clock, setClock] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utc + 5.5 * 3600000);
      setClock(ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  const mcxSession = useMemo(() => {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const ist = new Date(utc + 5.5 * 3600000);
    const day = ist.getDay();
    const hour = ist.getHours();
    const minute = ist.getMinutes();
    const timeNum = hour * 60 + minute;

    if (day === 0 || day === 6) {
      return { status: 'CLOSED', label: 'MCX WEEKEND CLOSED', tone: 'neutral' as const };
    }
    if (timeNum >= 540 && timeNum <= 1410) { // 09:00 to 23:30
      return { status: 'OPEN', label: 'MCX LIVE 09:00–23:30', tone: 'live' as const };
    }
    return { status: 'CLOSED', label: 'MCX SESSION CLOSED', tone: 'neutral' as const };
  }, [clock]);

  // ─── Background pricing for the OTHER underlying's open positions ──────
  // The Positions tab lists both CRUDEOIL and CRUDEOILM regardless of which
  // one is selected for the chain view. Dhan positions already carry a real
  // LTP from the broker itself, but Kotak's never do (see shapeKotakPosition)
  // — those need a live price joined in from a chain, and the selected
  // chain only covers the selected underlying. This is that second, slower
  // chain for whichever underlying is NOT on screen, kept minimal (strike ->
  // CE/PE last_price only, no OI/stats) and only run when there is actually
  // an open Kotak position to price.
  const [otherExpiry, setOtherExpiry]           = useState('');
  const [otherRows, setOtherRows]               = useState<ProcessedRow[]>([]);
  const [otherSpot, setOtherSpot]               = useState(0);
  const [otherKotakSymbols, setOtherKotakSymbols] = useState<KotakSymbolMap | null>(null);

  // CRUDEOIL and CRUDEOILM are separate contract families (different strike
  // ladders, different expiry lists) — clear everything chain-shaped on
  // switch so a stale chain never renders under the new underlying's heading
  // while the fresh expiries/spot/chain fetches are in flight.
  useEffect(() => {
    setExpiry('');
    setExpiries([]);
    setRows([]);
    setStats(EMPTY_CHAIN_STATS);
    setSpot(0);
    setPrevClose(0);
    setChange(0);
    setChangePct(0);
    setKotakSymbols(null);
    setKotakSymbolsError(null);
    setError('');
    chainFailsRef.current = 0;
    // "Other" flips along with the selector — its old data belongs to what
    // is now the SELECTED underlying and would be wrong background pricing.
    setOtherExpiry('');
    setOtherRows([]);
    setOtherSpot(0);
    setOtherKotakSymbols(null);
  }, [underlying]);

  const bookIsCurrent  = book.broker === broker;

  // Kotak's own positions payload never carries an LTP (see shapeKotakPosition),
  // so realizedProfit/unrealizedProfit come back 0 for every open leg. Join the
  // live LTP from a Dhan-sourced chain onto each Kotak position by trading
  // symbol — the same join Scalper.tsx does for the scalper terminals — and
  // recompute unrealizedProfit from it. Dhan positions already carry a real
  // LTP and pass through unchanged. The Positions tab lists BOTH underlyings
  // regardless of the selector, so the join is keyed by each POSITION's own
  // underlying (from its symbol), not by whichever one is on screen.
  function buildStrikeMap(km: KotakSymbolMap | null): Record<string, { strike: number; side: 'ce' | 'pe' }> {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    if (!km) return map;
    for (const [strikeStr, entry] of Object.entries(km.strikes)) {
      const strike = Number(strikeStr);
      if (entry.ceSymbol) map[entry.ceSymbol] = { strike, side: 'ce' };
      if (entry.peSymbol) map[entry.peSymbol] = { strike, side: 'pe' };
    }
    return map;
  }

  const kotakSymbolToStrikeByUnderlying = useMemo(() => ({
    [underlying]: buildStrikeMap(kotakSymbols),
    [otherUnderlying]: buildStrikeMap(otherKotakSymbols),
  } as Record<CrudeUnderlying, Record<string, { strike: number; side: 'ce' | 'pe' }>>),
  [underlying, otherUnderlying, kotakSymbols, otherKotakSymbols]);

  const rowsByUnderlying = useMemo(() => ({
    [underlying]: rows,
    [otherUnderlying]: otherRows,
  } as Record<CrudeUnderlying, ProcessedRow[]>), [underlying, otherUnderlying, rows, otherRows]);

  const spotByUnderlying = useMemo(() => ({
    [underlying]: spot,
    [otherUnderlying]: otherSpot,
  } as Record<CrudeUnderlying, number>), [underlying, otherUnderlying, spot, otherSpot]);

  /**
   * True when `symbol` is the nearest-month MCX future for `u` (e.g.
   * "CRUDEOILM21SEP26FUT"), not an option on it. Checked digit-after-prefix
   * the same way the backend's `isCrude()` regex does, so CRUDEOIL doesn't
   * false-match a CRUDEOILM future (both start with "CRUDEOIL").
   */
  function isCrudeFutureFor(symbol: string, u: CrudeUnderlying): boolean {
    const s = symbol.toUpperCase();
    if (!s.endsWith('FUT') || !s.startsWith(u)) return false;
    return /[0-9]/.test(s[u.length] ?? '');
  }

  const crudePositions = useMemo(() => {
    const base = bookIsCurrent ? book.positions : [];
    if (!isKotak) return base;
    return base.map(p => {
      const sym = p.tradingSymbol ?? p.symbol;
      const posUnderlying = crudeSymbolUnderlying(sym);
      if (!posUnderlying) return p;
      const mapping = kotakSymbolToStrikeByUnderlying[posUnderlying][sym];
      let liveLtp = 0;
      if (mapping) {
        const row = rowsByUnderlying[posUnderlying].find(r => r.strike === mapping.strike);
        liveLtp = row?.[mapping.side]?.last_price ?? 0;
      } else if (isCrudeFutureFor(sym, posUnderlying)) {
        // A futures leg has no strike to join through the option chain — the
        // page already has its live price as that underlying's own SPOT
        // reading (chain fetch pulls it from the nearest-month future's own
        // OHLC). Only correct while that future is still the nearest month;
        // a rolled/far-month position would need its own OHLC lookup.
        liveLtp = spotByUnderlying[posUnderlying];
      }
      if (liveLtp <= 0) return p;
      const netQty = p.netQty;
      const unrealizedProfit = netQty === 0
        ? p.unrealizedProfit
        : netQty > 0
          ? netQty * (liveLtp - p.buyAvg)
          : Math.abs(netQty) * (p.sellAvg - liveLtp);
      return { ...p, lastPrice: liveLtp, unrealizedProfit };
    });
  }, [bookIsCurrent, book.positions, isKotak, kotakSymbolToStrikeByUnderlying, rowsByUnderlying, spotByUnderlying]);

  // Only run the background chain/lookup poll for the OTHER underlying when
  // there is an actual open Kotak position to price there — otherwise it's
  // pure wasted Dhan option-chain calls (rate-limited to ~1 call/3s).
  const hasOtherOpenKotakPosition = useMemo(() => {
    if (!isKotak || !bookIsCurrent) return false;
    return book.positions.some(p =>
      p.netQty !== 0 && crudeSymbolUnderlying(p.tradingSymbol ?? p.symbol) === otherUnderlying);
  }, [isKotak, bookIsCurrent, book.positions, otherUnderlying]);

  const crudeOrders    = bookIsCurrent ? book.orders : [];
  const crudeTrades    = bookIsCurrent ? book.trades : [];
  const tradesError    = bookIsCurrent ? book.error : null;
  const tradesLoading  = !bookIsCurrent || !book.loaded;

  const [activeTab, setActiveTab]           = useState<'chain' | 'oi' | 'cumulative'>('chain');

  const [exitingAll, setExitingAll]         = useState(false);

  const activePositions = crudePositions.filter(p => p.netQty !== 0);

  const totalRealized   = crudePositions.reduce((sum, p) => sum + p.realizedProfit, 0);
  const totalUnrealized = crudePositions.reduce((sum, p) => sum + p.unrealizedProfit, 0);
  const totalPnl        = totalRealized + totalUnrealized;

  const dte         = useMemo(() => daysToExpiry(expiry), [expiry]);
  const qtyLabel    = `${lots} lot${lots > 1 ? 's' : ''} · ${lots * lotSize} qty`;

  // Fetch crude oil positions/orders/trades from the selected broker
  const fetchCrudeTrades = useCallback(async () => {
    // Captured up front: an in-flight request must never land under a broker
    // the user switched to while it was outstanding.
    const forBroker = broker;
    try {
      const res = await fetch(POSITIONS_ROUTE[forBroker]);
      const json = await res.json() as {
        success: boolean;
        positions?: CrudePosition[];
        orders?: CrudeOrder[];
        trades?: CrudeTrade[];
        error?: string;
      };
      setBook(prev => ({
        broker: forBroker,
        positions: json.success ? json.positions ?? [] : prev.broker === forBroker ? prev.positions : [],
        orders:    json.success ? json.orders    ?? [] : prev.broker === forBroker ? prev.orders : [],
        trades:    json.success ? json.trades    ?? [] : prev.broker === forBroker ? prev.trades : [],
        error:     json.success ? null : json.error ?? 'Failed to load crude oil trades data',
        loaded: true,
      }));
    } catch (err) {
      // Keep the last good book only if it belongs to this broker. Carrying it
      // across a switch would relabel the other account's positions as this
      // one's — wrong P&L, and Exit All aimed at the wrong book.
      setBook(prev => prev.broker === forBroker
        ? { ...prev, error: String(err), loaded: true }
        : { broker: forBroker, positions: [], orders: [], trades: [], error: String(err), loaded: true });
    }
  }, [broker]);

  useEffect(() => {
    fetch('/api/auth/broker-status')
      .then(r => r.json())
      .then((j: Partial<Record<CrudeBroker, boolean>>) =>
        setBrokerAuth({ dhan: Boolean(j.dhan), kotak: Boolean(j.kotak) }))
      .catch(() => {});
  }, []);

  // Kotak routes orders by trading symbol, so the chain's strikes have to be
  // resolved against its instrument master before any button can fire.
  useEffect(() => {
    if (!isKotak || !expiry) { setKotakSymbols(null); setKotakSymbolsError(null); return; }
    let cancelled = false;
    setKotakSymbolsError(null);
    fetch(`/api/scalper/kotak/lookup?underlying=${underlying}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: KotakSymbolMap; error?: string }) => {
        if (cancelled) return;
        if (j.success && j.data) setKotakSymbols(j.data);
        else { setKotakSymbols(null); setKotakSymbolsError(j.error ?? 'Kotak contract lookup failed'); }
      })
      .catch(err => { if (!cancelled) { setKotakSymbols(null); setKotakSymbolsError(String(err)); } });
    return () => { cancelled = true; };
  }, [isKotak, expiry, underlying]);

  /** Kotak trading symbol for a strike/side, or null when the contract is unlisted. */
  const kotakSymbolFor = useCallback((strike: number, optType: 'CE' | 'PE'): string | null => {
    const entry = kotakSymbols?.strikes?.[String(Math.round(strike))];
    return (optType === 'CE' ? entry?.ceSymbol : entry?.peSymbol) ?? null;
  }, [kotakSymbols]);

  /**
   * Square-off legs for the current broker. `netQty` is always sent verbatim —
   * it is already in whatever unit the reporting broker uses (lots on Dhan,
   * absolute barrels on Kotak), so converting it here would misfire by 100x.
   */
  const buildExitRequest = useCallback((positions: CrudePosition[]) => {
    if (isKotak) {
      return {
        url: '/api/crudeoil/kotak-order',
        body: {
          legs: positions.map(p => ({
            tradingsymbol: p.tradingSymbol || p.symbol,
            quantity: Math.abs(p.netQty),
            side: (p.netQty > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          })),
          mode: 'positional',
        },
      };
    }
    return {
      url: '/api/options/order',
      body: {
        legs: positions.map(p => ({
          securityId: p.securityId || '',
          quantity: Math.abs(p.netQty),
          side: (p.netQty > 0 ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          exchangeSegment: p.exchangeSegment || 'MCX_COMM',
        })),
        mode: 'positional',
      },
    };
  }, [isKotak]);

  const doExitAll = useCallback(async () => {
    setExitingAll(true);
    setOrderMessage(null);

    const { url, body } = buildExitRequest(activePositions);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const json = await res.json() as { success: boolean; error?: string };
      if (json.success) {
        setOrderMessage({ text: `Square-off orders placed on ${brokerLabel} for all active positions.`, isError: false });
        void fetchCrudeTrades();
      } else {
        setOrderMessage({ text: json.error ?? 'Failed to square off some positions.', isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error during square off: ${String(err)}`, isError: true });
    } finally {
      setExitingAll(false);
    }
  }, [activePositions, buildExitRequest, brokerLabel, fetchCrudeTrades]);

  /**
   * Places a MARKET order in the position's own direction (BUY for a long,
   * SELL for a short) for `addLots` lots, using the position's own
   * securityId/tradingSymbol directly rather than re-resolving a strike —
   * it's already the exact contract held.
   */
  const handleAddToPosition = useCallback(async (position: CrudePosition, addLots: number) => {
    if (ordering) return;
    if (!Number.isInteger(addLots) || addLots <= 0) {
      setOrderMessage({ text: 'Enter a whole number of lots to add.', isError: true });
      return;
    }

    const side: 'BUY' | 'SELL' = position.netQty < 0 ? 'SELL' : 'BUY';
    // Kotak's netQty/lotSize are absolute barrels; Dhan's MCX quantity is
    // already a lot count (its lot size is always 1), so no multiplier there.
    const posLotSize = isKotak ? (position.lotSize ?? 1) : 1;
    const qty = addLots * posLotSize;

    let url: string;
    let body: unknown;
    if (isKotak) {
      const tradingsymbol = position.tradingSymbol || position.symbol;
      url = '/api/crudeoil/kotak-order';
      body = { legs: [{ tradingsymbol, quantity: qty, side }], mode: 'positional' };
    } else {
      url = '/api/options/order';
      body = {
        legs: [{
          securityId: position.securityId || '',
          quantity: qty,
          side,
          exchangeSegment: position.exchangeSegment || 'MCX_COMM',
        }],
        mode: 'positional',
      };
    }

    setOrdering(true);
    setOrderMessage(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setOrderMessage({
          text: `${brokerLabel}: MARKET ${side} ${position.symbol} — added ${qty} qty (${addLots} lot${addLots > 1 ? 's' : ''}).`,
          isError: false,
        });
        void fetchCrudeTrades();
      } else {
        setOrderMessage({ text: `Failed to add to ${position.symbol}: ${json.error || 'Unknown error'}`, isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error adding to position: ${String(err)}`, isError: true });
    } finally {
      setOrdering(false);
    }
  }, [ordering, isKotak, brokerLabel, fetchCrudeTrades]);

  /** Squares off a single position at market, behind the same confirmation dialog Exit All uses. */
  const handleClosePosition = useCallback((position: CrudePosition) => {
    if (position.netQty === 0) return;
    const { url, body } = buildExitRequest([position]);

    setPendingConfirm({
      title: 'Close position?',
      subtitle: `${position.symbol} · ${brokerLabel}`,
      reason: `This position will be closed immediately at market on ${brokerLabel}.`,
      detail: (
        <>
          A <span className="font-bold text-zinc-300">MARKET</span> order will be sent to{' '}
          <span className="font-bold text-zinc-300">{brokerLabel}</span> to close{' '}
          <span className="font-bold text-zinc-300">{position.symbol}</span>. This cannot be undone.
        </>
      ),
      confirmLabel: 'Close Position',
      onConfirm: () => {
        setPendingConfirm(null);
        void (async () => {
          setOrdering(true);
          setOrderMessage(null);
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const json = await res.json() as { success: boolean; error?: string };
            setOrderMessage(json.success
              ? { text: `Close order placed for ${position.symbol} on ${brokerLabel}.`, isError: false }
              : { text: `Failed to close ${position.symbol}: ${json.error ?? 'Unknown error'}`, isError: true });
            void fetchCrudeTrades();
          } catch (err) {
            setOrderMessage({ text: `Error closing position: ${String(err)}`, isError: true });
          } finally {
            setOrdering(false);
          }
        })();
      },
    });
  }, [buildExitRequest, brokerLabel, fetchCrudeTrades]);

  const handleExitAll = useCallback(() => {
    if (activePositions.length === 0) return;
    setPendingConfirm({
      title: 'Square off everything?',
      subtitle: `${activePositions.length} open Crude Oil position${activePositions.length > 1 ? 's' : ''} on ${brokerLabel}`,
      reason: `All ${activePositions.length} open Crude Oil position${activePositions.length > 1 ? 's' : ''} will be closed immediately at market on ${brokerLabel}.`,
      detail: (
        <>
          MARKET orders will be sent to <span className="font-bold text-zinc-300">{brokerLabel}</span> for every leg
          listed in the Positions panel. This cannot be undone.
        </>
      ),
      confirmLabel: 'Exit All',
      onConfirm: () => { setPendingConfirm(null); void doExitAll(); },
    });
  }, [activePositions, brokerLabel, doExitAll]);

  useEffect(() => {
    fetch(`/api/lotsize?symbol=${underlying}`)
      .then(r => r.json())
      .then(json => {
        if (json.lot_size) setDhanLotSize(json.lot_size);
      })
      .catch(() => {});
  }, [underlying]);

  useEffect(() => {
    if (orderMessage) {
      const t = setTimeout(() => setOrderMessage(null), 6000);
      return () => clearTimeout(t);
    }
  }, [orderMessage]);

  /**
   * Reason the selected broker cannot trade this leg, or '' when it can.
   * Surfaced on the chain buttons so an unroutable strike is visibly disabled
   * rather than failing only once the order has been fired.
   */
  const tradeBlockedReason = useCallback((row: ProcessedRow, optType: 'CE' | 'PE'): string => {
    if (brokerAuth && !brokerAuth[broker]) return `No ${brokerLabel} session — log in to trade`;
    if (!isKotak) {
      const side = optType === 'CE' ? row.ce : row.pe;
      return side?.security_id ? '' : 'No Dhan security id for this strike';
    }
    if (kotakSymbolsError) return `Kotak contracts unavailable: ${kotakSymbolsError}`;
    if (!kotakSymbols) return 'Loading Kotak contracts…';
    return kotakSymbolFor(row.strike, optType)
      ? ''
      : `Kotak does not list ${underlying} ${row.strike} ${optType} for this expiry`;
  }, [broker, brokerAuth, brokerLabel, isKotak, kotakSymbols, kotakSymbolsError, kotakSymbolFor, underlying]);

  const handlePlaceOrder = useCallback(async (strike: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL') => {
    if (ordering) return;

    const row = rows.find(r => r.strike === strike);
    if (!row) return;
    const blocked = tradeBlockedReason(row, optType);
    if (blocked) { setOrderMessage({ text: blocked, isError: true }); return; }

    const qty = lots * lotSize;
    let url: string;
    let body: unknown;

    if (isKotak) {
      const tradingsymbol = kotakSymbolFor(strike, optType);
      if (!tradingsymbol) {
        setOrderMessage({ text: `No Kotak contract for ${strike} ${optType}.`, isError: true });
        return;
      }
      url = '/api/crudeoil/kotak-order';
      body = { legs: [{ tradingsymbol, quantity: qty, side }], mode: 'positional' };
    } else {
      const securityId = (optType === 'CE' ? row.ce : row.pe)?.security_id;
      url = '/api/options/order';
      body = {
        legs: [{ securityId: String(securityId), quantity: qty, side, exchangeSegment: 'MCX_COMM' }],
        mode: 'positional',
      };
    }

    setOrdering(true);
    setOrderMessage(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        setOrderMessage({
          text: `${brokerLabel}: MARKET ${side} ${strike} ${optType} — ${qty} qty (${lots} lot${lots > 1 ? 's' : ''}). Order ID: ${json.data?.[0]?.orderId || 'N/A'}`,
          isError: false
        });
        void fetchCrudeTrades();
      } else {
        setOrderMessage({ text: `Failed: ${json.error || 'Unknown error'}`, isError: true });
      }
    } catch (err) {
      setOrderMessage({ text: `Error placing order: ${String(err)}`, isError: true });
    } finally {
      setOrdering(false);
    }
  }, [brokerLabel, fetchCrudeTrades, isKotak, kotakSymbolFor, lots, lotSize, ordering, rows, tradeBlockedReason]);

  // Fetch expiries — re-runs on underlying switch, since CRUDEOIL and
  // CRUDEOILM are separate contract families with independent expiry lists.
  useEffect(() => {
    async function loadExpiries() {
      try {
        const res = await fetch(`/api/options/expiries?underlying=${underlying}`);
        const json = await res.json() as { success: boolean; data?: string[]; error?: string };
        if (json.success && json.data?.length) {
          setExpiries(json.data);
          setExpiry(json.data[0]);
        } else {
          setError(json.error ?? 'Failed to load expiries');
        }
      } catch (err) {
        setError(String(err));
      }
    }
    void loadExpiries();
  }, [underlying]);

  // Fetch spot price
  const fetchSpot = useCallback(async () => {
    try {
      const res = await fetch(`/api/options/spot?underlying=${underlying}`);
      const json = await res.json() as {
        success: boolean;
        spot?: number;
        prev_close?: number;
        change?: number;
        change_pct?: number;
      };
      if (json.success) {
        setSpot(json.spot ?? 0);
        setPrevClose(json.prev_close ?? 0);
        setChange(json.change ?? 0);
        setChangePct(json.change_pct ?? 0);
      }
    } catch { /* ignore spot errors, chain fetch has fallback spot */ }
  }, [underlying]);

  // Fetch option chain
  const fetchChain = useCallback(async () => {
    if (!expiry) return;

    // A transient poll failure must not blank an already-loaded chain. Keep the
    // last-good rows, mark the view "stale", keep polling, and only surface a
    // blocking error once we have nothing to show or fail repeatedly.
    const onTransientFail = (msg: string) => {
      chainFailsRef.current += 1;
      setStale(true);
      setRows(prev => {
        if (prev.length === 0 || chainFailsRef.current >= STALE_ERROR_AFTER) setError(msg);
        return prev;
      });
    };

    try {
      const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: {
          chain: { oc?: Record<string, RawChainEntry> };
          spot: number;
          prev_close?: number;
          change?: number;
          change_pct?: number;
        };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        onTransientFail(json.error ?? 'No chain data — retrying');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      if (spotPrice <= 0) {
        onTransientFail('Spot price unavailable — retrying');
        return;
      }
      const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;

      const oc        = json.data.chain.oc;
      if (!oc || Object.keys(oc).length === 0) {
        onTransientFail('Option chain empty — retrying');
        return;
      }

      const allEntries = parseStrikeEntries(oc).filter(({ strike }) => strike % strikeStep === 0);
      const mpStrike = computeMaxPain(allEntries);

      // Slicing window around ATM
      const atmIdx  = allEntries.reduce((best, { strike }, i) =>
        Math.abs(strike - atmStrike) < Math.abs(allEntries[best].strike - atmStrike) ? i : best, 0);
      const lo      = Math.max(0, atmIdx - wings);
      const hi      = Math.min(allEntries.length - 1, atmIdx + wings);
      const visible = allEntries.slice(lo, hi + 1);

      // Chain-wide totals and the support/resistance walls. These deliberately scan
      // *every* strike, not just the visible window — a wall two strikes outside the
      // ±N view is still the wall.
      let totCE = 0, totPE = 0, totCEVol = 0, totPEVol = 0;
      let wallCEOI = 0, wallPEOI = 0;
      let wallCEStrike: number | null = null, wallPEStrike: number | null = null;
      for (const { strike, entry } of allEntries) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        totCE += ceOI;
        totPE += peOI;
        totCEVol += entry.ce?.volume ?? 0;
        totPEVol += entry.pe?.volume ?? 0;
        if (ceOI > wallCEOI) { wallCEOI = ceOI; wallCEStrike = strike; }
        if (peOI > wallPEOI) { wallPEOI = peOI; wallPEStrike = strike; }
      }

      // Visible-window maxima drive the in-row MAX badges so the table stays
      // self-consistent with what the user can actually see.
      let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
      for (const { strike, entry } of visible) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = strike; }
        if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = strike; }
      }

      const straddleMap = new Map<number, number>();
      let minStraddle = Infinity, minStraddleStrike = 0;
      for (const { strike, entry } of visible) {
        const s = (entry.ce?.last_price ?? 0) + (entry.pe?.last_price ?? 0);
        straddleMap.set(strike, s);
        if (s > 0 && s < minStraddle) { minStraddle = s; minStraddleStrike = strike; }
      }

      const processed: ProcessedRow[] = visible.map(({ strike, entry }) => {
        const ce    = entry.ce ?? null;
        const pe    = entry.pe ?? null;
        const ceOI  = ce?.oi ?? 0;
        const peOI  = pe?.oi ?? 0;
        const strad = straddleMap.get(strike) ?? 0;
        return {
          strike,
          ce,
          pe,
          ceOIPct:       maxCEOI > 0 ? (ceOI / maxCEOI) * 100 : 0,
          peOIPct:       maxPEOI > 0 ? (peOI / maxPEOI) * 100 : 0,
          pcr:           ceOI > 0 ? peOI / ceOI : null,
          straddle:      strad,
          isATM:         strike === atmStrike,
          isMaxCEOI:     strike === maxCEStrike && maxCEOI > 0,
          isMaxPEOI:     strike === maxPEStrike && maxPEOI > 0,
          isMinStraddle: strike === minStraddleStrike && minStraddle < Infinity,
        };
      });

      const atmRow = processed.find(r => r.isATM);
      const atmStrad = atmRow ? atmRow.straddle : null;

      // Update states
      if (spotPrice > 0) setSpot(spotPrice);
      if (json.data.prev_close !== undefined) setPrevClose(json.data.prev_close);
      if (json.data.change !== undefined) setChange(json.data.change);
      if (json.data.change_pct !== undefined) setChangePct(json.data.change_pct);
      setRows(processed);
      setStats({
        atm: atmStrike,
        pcr: totCE > 0 ? totPE / totCE : null,
        maxPain: mpStrike,
        totalCEOI: totCE,
        totalPEOI: totPE,
        totalCEVol: totCEVol,
        totalPEVol: totPEVol,
        atmStraddle: atmStrad && atmStrad > 0 ? atmStrad : null,
        atmCeIV: sideIV(atmRow?.ce),
        atmPeIV: sideIV(atmRow?.pe),
        resistanceStrike: wallCEStrike,
        resistanceOI: wallCEOI,
        supportStrike: wallPEStrike,
        supportOI: wallPEOI,
      });
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      chainFailsRef.current = 0;
      setStale(false);
      setError('');
    } catch (e) {
      onTransientFail(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry, wings, underlying, strikeStep]);

  // Combined fetch trigger. Spot is intentionally NOT fetched here every
  // cycle: fetchChain's response already carries a dedicated live spot/
  // prev_close/change (see options_data_fetch.py's `chain` command), and
  // firing fetchSpot concurrently with fetchChain doubles the Dhan OHLC
  // calls fired in parallel every 15s, which was tripping the shared
  // account-level rate limit and surfacing as "stale — retrying".
  const runPoll = useCallback(async () => {
    setLoading(true);
    await fetchChain();
    setLoading(false);
  }, [fetchChain]);

  // Set up polling
  useEffect(() => {
    if (!expiry) return;
    void runPoll();
    intervalRef.current = setInterval(runPoll, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry, runPoll]);

  // Slow fallback spot poll — only needed to seed the header change-chip
  // before the first chain response lands, and to recover it if chain
  // fetches keep failing for a while.
  useEffect(() => {
    void fetchSpot();
    const id = setInterval(fetchSpot, SPOT_FALLBACK_POLL_MS);
    return () => clearInterval(id);
  }, [fetchSpot]);

  // ─── Background pricing for the OTHER underlying ───────────────────
  // Only runs while there's an open Kotak position on the non-displayed
  // underlying to price (Dhan positions already carry a real LTP and need
  // none of this). Expiry first, then chain+Kotak-symbol-lookup off it —
  // mirrors the main fetch pipeline above but scoped to `otherUnderlying`.
  useEffect(() => {
    if (!hasOtherOpenKotakPosition) { setOtherExpiry(''); return; }
    let cancelled = false;
    fetch(`/api/options/expiries?underlying=${otherUnderlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (!cancelled && j.success && j.data?.length) setOtherExpiry(j.data[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hasOtherOpenKotakPosition, otherUnderlying]);

  useEffect(() => {
    if (!hasOtherOpenKotakPosition || !otherExpiry) { setOtherKotakSymbols(null); return; }
    let cancelled = false;
    fetch(`/api/scalper/kotak/lookup?underlying=${otherUnderlying}&expiry=${otherExpiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: KotakSymbolMap }) => {
        if (!cancelled && j.success && j.data) setOtherKotakSymbols(j.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hasOtherOpenKotakPosition, otherUnderlying, otherExpiry]);

  useEffect(() => {
    if (!hasOtherOpenKotakPosition || !otherExpiry) return;
    let cancelled = false;
    const fetchOtherChain = async () => {
      try {
        const res = await fetch(`/api/options/chain?underlying=${otherUnderlying}&expiry=${otherExpiry}`);
        const json = await res.json() as {
          success: boolean;
          data?: { chain: { oc?: Record<string, RawChainEntry> }; spot: number };
        };
        if (cancelled || !json.success || !json.data?.chain?.oc) return;
        setOtherSpot(json.data.spot ?? 0);
        const entries = parseStrikeEntries(json.data.chain.oc)
          .filter(({ strike }) => strike % otherStrikeStep === 0);
        // Minimal rows — only strike/ce/pe are read by the position join, so
        // the OI-wall/max-pain/straddle stats the main chain computes are
        // skipped here on purpose.
        setOtherRows(entries.map(({ strike, entry }) => ({
          strike, ce: entry.ce ?? null, pe: entry.pe ?? null,
          ceOIPct: 0, peOIPct: 0, pcr: null, straddle: 0,
          isATM: false, isMaxCEOI: false, isMaxPEOI: false, isMinStraddle: false,
        })));
      } catch { /* best-effort background pricing — leave last-known rows in place */ }
    };
    void fetchOtherChain();
    const id = setInterval(fetchOtherChain, OTHER_UNDERLYING_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [hasOtherOpenKotakPosition, otherUnderlying, otherExpiry, otherStrikeStep]);

  useEffect(() => {
    void fetchCrudeTrades();
    tradesIntervalRef.current = setInterval(fetchCrudeTrades, POLL_MS);
    return () => { if (tradesIntervalRef.current) clearInterval(tradesIntervalRef.current); };
  }, [fetchCrudeTrades]);

  // --- SL and Target: dashboard-level thresholds ---
  const [editingConfigs, setEditingConfigs] = useState<Record<string, { sl?: string; target?: string }>>({});

  // riskConfigs holds committed threshold values (these are only dashboard-level triggers — NOT broker orders)
  const [riskConfigs, setRiskConfigs] = useState<Record<string, { sl: number | null; target: number | null }>>({});

  // Thresholds are stored PER BROKER AND PER UNDERLYING. The two brokers name
  // the same contract differently (CRUDEOIL17AUG267300CE on Kotak vs Dhan's
  // own symbol), and the prune-on-close effect below deletes any config with
  // no matching open position — so a single shared store loses every Dhan
  // threshold the moment you look at the Kotak book (same reasoning extends
  // to CRUDEOIL vs CRUDEOILM, which are separate contract families).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RISK_KEY(broker, underlying))
        // One-time carry-over: the pre-broker-selector store held Dhan's CRUDEOIL.
        ?? (broker === 'dhan' && underlying === 'CRUDEOIL' ? localStorage.getItem(RISK_KEY_LEGACY) : null);
      setRiskConfigs(saved ? JSON.parse(saved) : {});
    } catch { setRiskConfigs({}); }
  }, [broker, underlying]);

  const saveRiskConfigs = (updated: typeof riskConfigs) => {
    setRiskConfigs(updated);
    localStorage.setItem(RISK_KEY(broker, underlying), JSON.stringify(updated));
  };

  const handleInputChange = (symbol: string, key: 'sl' | 'target', value: string) => {
    setEditingConfigs(prev => ({
      ...prev,
      [symbol]: { ...(prev[symbol] || {}), [key]: value },
    }));
  };

  // Called when user presses Enter or blurs the input
  // Only stores a threshold locally — never touches the broker here.
  // `overrideValue` bypasses the editing buffer (setState is async, so a caller that
  // just queued a value can't rely on editingConfigs having it yet — e.g. the ✕ button).
  const handleInputCommit = useCallback((symbol: string, key: 'sl' | 'target', overrideValue?: string) => {
    const editState = editingConfigs[symbol];
    if (overrideValue === undefined && (!editState || editState[key] === undefined)) return;

    const rawVal = overrideValue !== undefined ? overrideValue : editState![key]!;
    const price = (rawVal === '' || isNaN(parseFloat(rawVal))) ? null : parseFloat(rawVal);

    // Always clear the editing buffer
    setEditingConfigs(prev => {
      const copy = { ...prev };
      if (copy[symbol]) {
        delete copy[symbol][key];
        if (Object.keys(copy[symbol]).length === 0) delete copy[symbol];
      }
      return copy;
    });

    if (price === null || price <= 0) {
      // User cleared the field → just remove the threshold
      const updated = { ...riskConfigs };
      if (updated[symbol]) {
        updated[symbol] = { ...updated[symbol], [key]: null };
        if (updated[symbol].sl === null && updated[symbol].target === null) delete updated[symbol];
      }
      saveRiskConfigs(updated);
      setOrderMessage({ text: `${key === 'sl' ? 'Stop-Loss' : 'Target'} removed for ${symbol}.`, isError: false });
      return;
    }

    // Find the position to validate direction against current LTP
    const pos = crudePositions.find(p => p.symbol === symbol && p.netQty !== 0);
    if (!pos) {
      setOrderMessage({ text: `Cannot set ${key.toUpperCase()}: active position not found for ${symbol}.`, isError: true });
      return;
    }

    const ltp = pos.lastPrice;
    const isShort = pos.netQty < 0;

    // Require a known LTP — reject if 0/unavailable
    if (ltp <= 0) {
      setOrderMessage({ text: `Cannot set ${key.toUpperCase()}: LTP for ${symbol} is not yet available. Wait for price data and try again.`, isError: true });
      return;
    }

    // ─── Direction validation ─────────────────────────────────────────────────────────
    // SHORT (sold options): price must RISE to hit SL, FALL to hit Target
    //   SL must be ABOVE ltp    |   Target must be BELOW ltp
    // LONG (bought options): price must FALL to hit SL, RISE to hit Target
    //   SL must be BELOW ltp    |   Target must be ABOVE ltp
    if (key === 'sl') {
      if (isShort && price <= ltp) {
        setOrderMessage({
          text: `❌ SL rejected: You are SHORT ${symbol} (LTP ₹${ltp.toFixed(1)}). SL (₹${price}) must be ABOVE the current price. The monitor fires when price rises to your SL.`,
          isError: true,
        });
        return;
      }
      if (!isShort && price >= ltp) {
        setOrderMessage({
          text: `❌ SL rejected: You are LONG ${symbol} (LTP ₹${ltp.toFixed(1)}). SL (₹${price}) must be BELOW the current price. The monitor fires when price falls to your SL.`,
          isError: true,
        });
        return;
      }
    } else {
      if (isShort && price >= ltp) {
        setOrderMessage({
          text: `❌ Target rejected: You are SHORT ${symbol} (LTP ₹${ltp.toFixed(1)}). Target (₹${price}) must be BELOW the current price. The monitor fires when the option decays to your target.`,
          isError: true,
        });
        return;
      }
      if (!isShort && price <= ltp) {
        setOrderMessage({
          text: `❌ Target rejected: You are LONG ${symbol} (LTP ₹${ltp.toFixed(1)}). Target (₹${price}) must be ABOVE the current price.`,
          isError: true,
        });
        return;
      }
    }

    // All checks passed — save threshold locally
    const updated = {
      ...riskConfigs,
      [symbol]: {
        ...(riskConfigs[symbol] || { sl: null, target: null }),
        [key]: price,
      },
    };
    saveRiskConfigs(updated);
    const dir = key === 'sl'
      ? (isShort ? 'will fire when price RISES to' : 'will fire when price FALLS to')
      : (isShort ? 'will fire when price FALLS to' : 'will fire when price RISES to');
    setOrderMessage({
      text: `✅ ${key === 'sl' ? 'Stop-Loss' : 'Target'} set for ${symbol}: monitor ${dir} ₹${price}. A confirmation dialog will appear before any order is placed.`,
      isError: false,
    });
  }, [editingConfigs, crudePositions, riskConfigs]);

  // Prune stale configs when positions close.
  // Only ever prune against a LOADED book for the CURRENT broker: while a fetch
  // is in flight (mount, broker switch, a failed poll) crudePositions is [], and
  // pruning then would delete every threshold the user had set.
  useEffect(() => {
    if (tradesLoading || !bookIsCurrent || book.error) return;
    if (Object.keys(riskConfigs).length === 0) return;
    let hasStale = false;
    const cleaned = { ...riskConfigs };
    Object.keys(cleaned).forEach(sym => {
      const pos = crudePositions.find(p => p.symbol === sym);
      if (!pos || pos.netQty === 0) { delete cleaned[sym]; hasStale = true; }
    });
    if (hasStale) saveRiskConfigs(cleaned);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crudePositions, tradesLoading, bookIsCurrent, book.error]);

  // ─── Keyboard Shortcut: F10 → Nifty Options ────────────────────────────
  // Matches the "[F10] NIFTY OPTIONS" label on the header link below.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === 'F10') {
        e.preventDefault();
        router.push('/options');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [router]);

  // ─── Auto-exit monitor: check SL/Target thresholds each poll tick ─────────────────
  // When breached, set pendingConfirm so the user sees a dialog BEFORE any order fires.
  useEffect(() => {
    if (crudePositions.length === 0 || pendingConfirm) return;

    for (const p of crudePositions) {
      if (p.netQty === 0) continue;
      const config = riskConfigs[p.symbol];
      if (!config) continue;
      const ltp = p.lastPrice;
      if (ltp <= 0) continue;

      const isShort = p.netQty < 0;
      let triggered: { type: 'SL' | 'Target'; threshold: number } | null = null;

      if (isShort) {
        if (config.sl   !== null && config.sl   > 0 && ltp >= config.sl)   triggered = { type: 'SL',     threshold: config.sl };
        if (config.target !== null && config.target > 0 && ltp <= config.target) triggered = { type: 'Target', threshold: config.target };
      } else {
        if (config.sl   !== null && config.sl   > 0 && ltp <= config.sl)   triggered = { type: 'SL',     threshold: config.sl };
        if (config.target !== null && config.target > 0 && ltp >= config.target) triggered = { type: 'Target', threshold: config.target };
      }

      // Kotak has no securityId; it joins on the trading symbol instead.
      const routable = isKotak ? Boolean(p.tradingSymbol || p.symbol) : Boolean(p.securityId);
      if (triggered && routable) {
        // Immediately clear the config to prevent re-triggering on next tick
        const cleaned = { ...riskConfigs };
        delete cleaned[p.symbol];
        saveRiskConfigs(cleaned);

        const { url, body } = buildExitRequest([p]);
        const exitSide = isShort ? 'BUY' : 'SELL';
        const exitQty  = Math.abs(p.netQty);
        const symbol = p.symbol;

        setPendingConfirm({
          title: 'Exit position?',
          subtitle: `${symbol} · ${brokerLabel}`,
          reason: `${triggered.type} hit! LTP ₹${ltp.toFixed(1)} ${triggered.type === 'SL' ? (isShort ? '≥' : '≤') : (isShort ? '≤' : '≥')} threshold ₹${triggered.threshold}`,
          detail: (
            <>
              A <span className="font-bold text-zinc-300">MARKET {exitSide}</span> order for{' '}
              <span className="font-bold text-zinc-300">{exitQty}</span> will be sent to{' '}
              <span className="font-bold text-zinc-300">{brokerLabel}</span>.
            </>
          ),
          confirmLabel: 'Confirm Exit',
          onConfirm: () => {
            setPendingConfirm(null);
            void (async () => {
              try {
                const res = await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                const json = await res.json() as { success: boolean; error?: string };
                setOrderMessage(json.success
                  ? { text: `Exit order placed for ${symbol} on ${brokerLabel}.`, isError: false }
                  : { text: `Exit order failed: ${json.error ?? 'Unknown error'}`, isError: true }
                );
                void fetchCrudeTrades();
              } catch (err) {
                setOrderMessage({ text: `Exit order error: ${String(err)}`, isError: true });
              }
            })();
          },
        });
        break; // Handle one at a time
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crudePositions, riskConfigs, pendingConfirm]);

  const showChainMeta = activeTab === 'chain' || activeTab === 'oi';

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-amber-500/20 selection:text-amber-300">
        {/* ─── Sticky Bloomberg Terminal Header ────────────────────────── */}
        <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/20 bg-zinc-950/95 px-4 lg:px-6 py-2.5 backdrop-blur shadow-md">
          {/* Title Block */}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 shadow-inner">
              <Fuel className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400 font-mono">
                  BLOOMBERG TERMINAL · COMMODITY DESK
                </span>
                <span className="text-[10px] text-zinc-600">/</span>
                <span className="font-mono text-[9px] text-zinc-400">MCX CRUDE v2.4</span>
              </div>
              <h1 className="text-sm lg:text-base font-bold leading-none tracking-tight text-white">
                {underlyingLabel} Options Matrix
              </h1>
            </div>
          </div>

          {/* Telemetry Strip & Quick Controls */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Market Session Status */}
            <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold">
              <span
                className={`h-2 w-2 rounded-full ${
                  mcxSession.tone === 'live'
                    ? 'bg-emerald-400 animate-pulse'
                    : 'bg-zinc-500'
                }`}
              />
              <span className={mcxSession.tone === 'live' ? 'text-emerald-300' : 'text-zinc-400'}>
                {mcxSession.label}
              </span>
            </div>

            {/* Live IST Clock */}
            <div className="hidden sm:flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-400">
              <Clock className="h-3 w-3 text-amber-400" />
              <span className="tabular-nums font-bold text-zinc-200">{clock || '--:--:--'} IST</span>
            </div>

            {/* Spot Quote Badge */}
            <div className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold tabular-nums ${
              changePct > 0
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                : changePct < 0
                ? 'border-red-500/40 bg-red-500/10 text-red-400'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300'
            }`}>
              <span className="text-zinc-500 font-normal">FUT SPOT:</span>
              <span>{spot > 0 ? `₹${fmtNum(spot, 1)}` : '—'}</span>
              {spot > 0 && prevClose > 0 && (
                <span className={`text-[9px] ${pctColor(changePct)}`}>
                  ({pctSign(changePct)})
                </span>
              )}
            </div>

            {/* ATM Strike Badge */}
            <div className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-300">
              <span className="text-zinc-500 font-normal">ATM:</span>
              <span>{stats.atm ? fmtNum(stats.atm) : '—'}</span>
            </div>

            {/* Expiry Badge */}
            <div className="hidden md:flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-bold text-zinc-300">
              <span className="text-zinc-500 font-normal">EXP:</span>
              <span>{fmtExpiryShort(expiry)}</span>
              {dte !== null && dte >= 0 && (
                <span className="text-amber-400 font-bold ml-0.5">· {dte}d</span>
              )}
            </div>

            {/* Contract Lot Badge */}
            <div className="hidden lg:flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-400">
              <span className="text-zinc-500">LOT:</span>
              <span className="text-zinc-200 font-bold tabular-nums">{lotSize} BBL</span>
            </div>

            {/* DATA Date */}
            <div className="hidden xl:flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-400">
              <span className="text-zinc-500">DATA:</span>
              <span className="text-zinc-300">{todayIso()}</span>
            </div>

            {/* Live Feed Status */}
            <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] font-mono text-zinc-400">
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
              ) : (
                <span className={`h-1.5 w-1.5 rounded-full ${stale ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
              )}
              <span className={stale ? 'text-amber-400 font-bold' : 'text-zinc-300 font-semibold'}>
                {stale ? 'RETRYING' : 'LIVE 15s'}
              </span>
              <span className="text-zinc-600 hidden sm:inline">· {lastUpdated ?? '—'}</span>
            </div>

            {/* Back to Nifty Options */}
            <Link
              href="/options"
              className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/80 px-2.5 py-1 font-mono text-[10px] font-bold text-zinc-300 hover:text-amber-300 hover:border-amber-500/40 hover:bg-amber-500/10 transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              <span>[F10] NIFTY OPTIONS</span>
            </Link>

            <span className="h-5 w-px bg-zinc-800 shrink-0" />
            <NavBar />
          </div>
        </header>

        {/* ─── Command Ribbon: Underlying Family, Expiry, Broker & Views ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 lg:px-6 py-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            {/* Segmented Underlying Selector */}
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/90 p-0.5 font-mono">
              {CRUDE_UNDERLYINGS.map(u => {
                const active = underlying === u;
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setUnderlying(u)}
                    className={`px-3 py-1 text-xs font-bold rounded transition-all cursor-pointer ${
                      active
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {CRUDE_UNDERLYING_LABELS[u]}
                  </button>
                );
              })}
            </div>

            {/* Expiry Dropdown */}
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">EXPIRY:</span>
              {expiries.length === 0 ? (
                <Loader2 className="size-3.5 animate-spin text-zinc-500" />
              ) : (
                <Select
                  value={expiry}
                  onValueChange={(v) => { if (typeof v === 'string' && v) setExpiry(v); }}
                >
                  <SelectTrigger size="sm" className="min-w-36 font-mono text-xs bg-zinc-900 border-zinc-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-zinc-950 border-zinc-800">
                    {expiries.map(exp => (
                      <SelectItem key={exp} value={exp} className="font-mono text-xs">
                        {fmtExpiryLong(exp)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Broker Selector */}
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">BROKER:</span>
              <Select
                value={broker}
                onValueChange={(v) => { if (typeof v === 'string' && v) setBroker(v as CrudeBroker); }}
              >
                <SelectTrigger size="sm" className="min-w-32 font-mono text-xs bg-zinc-900 border-zinc-700">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-950 border-zinc-800">
                  {CRUDE_BROKERS.map(b => (
                    <SelectItem key={b} value={b} className="font-mono text-xs">
                      {CRUDE_BROKER_LABELS[b]}
                      {brokerAuth && !brokerAuth[b] && <span className="ml-1.5 text-zinc-500">(no session)</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* View Mode Segmented Tabs */}
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/90 p-0.5 font-mono text-xs">
            {[
              { id: 'chain', label: 'OPTION CHAIN' },
              { id: 'oi', label: 'OPEN INTEREST' },
              { id: 'cumulative', label: 'CUMULATIVE OI' },
            ].map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id as typeof activeTab)}
                  className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded transition-all cursor-pointer ${
                    active
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── Main Workspace Body ───────────────────────────────────── */}
        <main className="flex-1 flex flex-col gap-4 p-4 lg:p-6">
          {brokerAuth && !brokerAuth[broker] && (
            <Alert variant="destructive" className="border-amber-500/40 bg-amber-500/10 font-mono">
              <AlertCircle className="text-amber-400" />
              <AlertTitle className="text-amber-300 font-bold uppercase tracking-wider text-xs">
                NO {brokerLabel.toUpperCase()} SESSION DETECTED
              </AlertTitle>
              <AlertDescription className="text-zinc-300 text-xs">
                Market data is streaming via Dhan Data API, but order execution and positions tracking for {brokerLabel} require an active broker login.
              </AlertDescription>
            </Alert>
          )}

          {isKotak && kotakSymbolsError && (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10 font-mono">
              <AlertCircle className="text-red-400" />
              <AlertTitle className="text-red-300 font-bold uppercase tracking-wider text-xs">
                KOTAK CONTRACT LOOKUP FAILURE
              </AlertTitle>
              <AlertDescription className="text-zinc-300 text-xs">
                {kotakSymbolsError} — execution buttons remain locked until contracts map to Kotak instrument tokens.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10 font-mono">
              <AlertCircle className="text-red-400" />
              <AlertTitle className="text-red-300 font-bold uppercase tracking-wider text-xs">
                OPTION CHAIN DATA ERROR
              </AlertTitle>
              <AlertDescription className="text-zinc-300 text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {orderMessage && (
            <Alert
              variant={orderMessage.isError ? 'destructive' : 'default'}
              className={`font-mono text-xs ${
                orderMessage.isError
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              }`}
            >
              <AlertCircle className={orderMessage.isError ? 'text-red-400' : 'text-emerald-400'} />
              <AlertTitle className="font-bold uppercase tracking-wider">
                {orderMessage.isError ? 'ORDER REJECTED / FAILED' : 'ORDER CONFIRMED'}
              </AlertTitle>
              <AlertDescription className={orderMessage.isError ? 'text-red-200' : 'text-emerald-200'}>
                {orderMessage.text}
              </AlertDescription>
            </Alert>
          )}

          {showChainMeta && (
            <MarketSnapshot
              spot={spot}
              change={change}
              changePct={changePct}
              stats={stats}
              dte={dte}
              expiryLabel={fmtExpiryLong(expiry)}
            />
          )}

          {activeTab === 'chain' && (
            <div className="flex flex-col gap-4">
              <TradeTicketBar
                lots={lots}
                lotSize={lotSize}
                setLots={setLots}
                brokerLabel={brokerLabel}
                loading={tradesLoading}
                totalRealized={totalRealized}
                totalUnrealized={totalUnrealized}
                totalPnl={totalPnl}
                openCount={activePositions.length}
                exitingAll={exitingAll}
                onExitAll={handleExitAll}
              />

              {/* Strikes Wing Filter Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400 font-mono">
                    STRIKES AROUND ATM:
                  </span>
                  <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 font-mono">
                    {WING_OPTIONS.map(w => {
                      const active = wings === w;
                      return (
                        <button
                          key={w}
                          type="button"
                          onClick={() => setWings(w)}
                          className={`px-2.5 py-0.5 text-xs font-bold rounded transition-colors cursor-pointer ${
                            active
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : 'text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          ±{w}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-zinc-400">
                  {rows.length} ROWS · ROUTING: <span className="text-amber-300 font-bold">{brokerLabel.toUpperCase()}</span> · TICKET: <span className="text-zinc-200 font-bold">{qtyLabel}</span>
                </span>
              </div>

              <ChainTable
                rows={rows}
                spot={spot}
                loading={loading}
                ordering={ordering}
                qtyLabel={qtyLabel}
                onOrder={handlePlaceOrder}
                canTrade={tradeBlockedReason}
              />

              {tradesError && (
                <Alert variant="destructive" className="border-red-500/40 bg-red-500/10 font-mono">
                  <AlertCircle className="text-red-400" />
                  <AlertTitle className="text-red-300 font-bold uppercase tracking-wider text-xs">
                    POSITIONS FEED UNAVAILABLE
                  </AlertTitle>
                  <AlertDescription className="text-zinc-300 text-xs">{tradesError}</AlertDescription>
                </Alert>
              )}

              <ActivityPanel
                tab={activeActivityTab}
                setTab={setActiveActivityTab}
                positions={crudePositions}
                positionsLoading={tradesLoading}
                orders={crudeOrders}
                trades={crudeTrades}
                loading={tradesLoading}
                riskConfigs={riskConfigs}
                editingConfigs={editingConfigs}
                onThresholdChange={handleInputChange}
                onThresholdCommit={handleInputCommit}
                onAddToPosition={handleAddToPosition}
                onClosePosition={handleClosePosition}
                actionsBusy={ordering || exitingAll}
              />
            </div>
          )}

          {activeTab === 'oi' && <CrudeOilOITab expiry={expiry} />}
          {activeTab === 'cumulative' && <CrudeOilCumulativeOITab expiry={expiry} />}
        </main>

        <ConfirmDialog payload={pendingConfirm} onCancel={() => setPendingConfirm(null)} />
      </div>
    </TooltipProvider>
  );
}
