'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Fuel, Loader2 } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TooltipProvider } from '@/components/ui/tooltip';

import CrudeOilOITab from './CrudeOilOITab';
import CrudeOilCumulativeOITab from './CrudeOilCumulativeOITab';

import ActivityTables, { type ActivityTab } from './crudeoil/ActivityTables';
import ChainTable from './crudeoil/ChainTable';
import ConfirmDialog from './crudeoil/ConfirmDialog';
import MarketSnapshot from './crudeoil/MarketSnapshot';
import RiskRail from './crudeoil/RiskRail';
import {
  computeMaxPain, daysToExpiry, fmtExpiryLong, fmtExpiryShort, fmtNum,
  parseStrikeEntries, pctColor, pctSign, sideIV, todayIso,
} from './crudeoil/format';
import {
  CRUDE_BROKERS, CRUDE_BROKER_LABELS, EMPTY_CHAIN_STATS, WING_OPTIONS,
  type ChainStats, type ConfirmPayload, type CrudeBroker, type CrudeOrder,
  type CrudePosition, type CrudeTrade, type KotakSymbolMap, type ProcessedRow,
  type RawChainEntry, type Wings,
} from './crudeoil/types';

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'CRUDEOIL';
const STRIKE_STEP = 100;
const POLL_MS     = 15_000;
const SPOT_FALLBACK_POLL_MS = 60_000;

// Chain, spot, IV and OI always come from Dhan regardless of the selected
// broker. An option's LTP is set by the exchange, not the broker, so Kotak's
// numbers would be identical — only order routing and the position book are
// broker-specific. Same reasoning as app/api/options/chain's QUOTE_SOURCE.
const POSITIONS_ROUTE: Record<CrudeBroker, string> = {
  dhan:  '/api/crudeoil-trades',
  kotak: '/api/crudeoil-trades/kotak',
};

// SL/Target thresholds are per broker — see the loader below for why.
const RISK_KEY_LEGACY = 'crude_risk_configs_v2';
const RISK_KEY = (b: CrudeBroker) => `${RISK_KEY_LEGACY}:${b}`;

// ─── Main Component ───────────────────────────────────────────────

export default function CrudeOilOptions() {
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
  const [activeActivityTab, setActiveActivityTab] = useState<ActivityTab>('orders');
  const tradesIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const bookIsCurrent  = book.broker === broker;
  const crudePositions = bookIsCurrent ? book.positions : [];
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
    fetch(`/api/scalper/kotak/lookup?underlying=${UNDERLYING}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: KotakSymbolMap; error?: string }) => {
        if (cancelled) return;
        if (j.success && j.data) setKotakSymbols(j.data);
        else { setKotakSymbols(null); setKotakSymbolsError(j.error ?? 'Kotak contract lookup failed'); }
      })
      .catch(err => { if (!cancelled) { setKotakSymbols(null); setKotakSymbolsError(String(err)); } });
    return () => { cancelled = true; };
  }, [isKotak, expiry]);

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
          mode: 'intraday',
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
        mode: 'intraday',
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
    fetch(`/api/lotsize?symbol=${UNDERLYING}`)
      .then(r => r.json())
      .then(json => {
        if (json.lot_size) setDhanLotSize(json.lot_size);
      })
      .catch(() => {});
  }, []);

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
      : `Kotak does not list ${UNDERLYING} ${row.strike} ${optType} for this expiry`;
  }, [broker, brokerAuth, brokerLabel, isKotak, kotakSymbols, kotakSymbolsError, kotakSymbolFor]);

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
      body = { legs: [{ tradingsymbol, quantity: qty, side }], mode: 'intraday' };
    } else {
      const securityId = (optType === 'CE' ? row.ce : row.pe)?.security_id;
      url = '/api/options/order';
      body = {
        legs: [{ securityId: String(securityId), quantity: qty, side, exchangeSegment: 'MCX_COMM' }],
        mode: 'intraday',
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

  // Fetch expiries
  useEffect(() => {
    async function loadExpiries() {
      try {
        const res = await fetch(`/api/options/expiries?underlying=${UNDERLYING}`);
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
  }, []);

  // Fetch spot price
  const fetchSpot = useCallback(async () => {
    try {
      const res = await fetch(`/api/options/spot?underlying=${UNDERLYING}`);
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
  }, []);

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
      const res = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
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
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;

      const oc        = json.data.chain.oc;
      if (!oc || Object.keys(oc).length === 0) {
        onTransientFail('Option chain empty — retrying');
        return;
      }

      const allEntries = parseStrikeEntries(oc).filter(({ strike }) => strike % STRIKE_STEP === 0);
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
  }, [expiry, wings]);

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

  useEffect(() => {
    void fetchCrudeTrades();
    tradesIntervalRef.current = setInterval(fetchCrudeTrades, POLL_MS);
    return () => { if (tradesIntervalRef.current) clearInterval(tradesIntervalRef.current); };
  }, [fetchCrudeTrades]);

  // --- SL and Target: dashboard-level thresholds ---
  const [editingConfigs, setEditingConfigs] = useState<Record<string, { sl?: string; target?: string }>>({});

  // riskConfigs holds committed threshold values (these are only dashboard-level triggers — NOT broker orders)
  const [riskConfigs, setRiskConfigs] = useState<Record<string, { sl: number | null; target: number | null }>>({});

  // Thresholds are stored PER BROKER. The two brokers name the same contract
  // differently (CRUDEOIL17AUG267300CE on Kotak vs Dhan's own symbol), and the
  // prune-on-close effect below deletes any config with no matching open
  // position — so a single shared store loses every Dhan threshold the moment
  // you look at the Kotak book.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RISK_KEY(broker))
        // One-time carry-over: the pre-broker-selector store held Dhan's.
        ?? (broker === 'dhan' ? localStorage.getItem(RISK_KEY_LEGACY) : null);
      setRiskConfigs(saved ? JSON.parse(saved) : {});
    } catch { setRiskConfigs({}); }
  }, [broker]);

  const saveRiskConfigs = (updated: typeof riskConfigs) => {
    setRiskConfigs(updated);
    localStorage.setItem(RISK_KEY(broker), JSON.stringify(updated));
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
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        {/* ─── Header ─────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-700 shadow">
              <Fuel className="size-4 text-white" />
            </div>
            <div>
              <div className="text-sm font-bold leading-none text-zinc-100">Crude Oil Options</div>
              <div className="mt-0.5 text-[10px] text-zinc-500">MCX · CRUDEOIL</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={`font-mono tabular-nums ${
                changePct > 0
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : changePct < 0
                    ? 'border-red-500/40 bg-red-500/10 text-red-400'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-300'
              }`}
            >
              SPOT {spot > 0 ? fmtNum(spot, 1) : '—'}
            </Badge>
            {spot > 0 && prevClose > 0 && (
              <Badge variant="outline" className={`border-zinc-700 bg-zinc-900 font-mono tabular-nums ${pctColor(changePct)}`}>
                {change >= 0 ? '+' : ''}{fmtNum(change, 1)} ({pctSign(changePct)})
              </Badge>
            )}
            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 font-mono tabular-nums text-amber-300">
              ATM {stats.atm ? fmtNum(stats.atm) : '—'}
            </Badge>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono tabular-nums text-zinc-300">
              EXP {fmtExpiryShort(expiry)}{dte !== null && dte >= 0 ? ` · ${dte}d` : ''}
            </Badge>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono tabular-nums text-zinc-400">
              LOT {lotSize}
            </Badge>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-900 font-mono text-zinc-400">
              DATA: {todayIso()}
            </Badge>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              {loading ? (
                <Loader2 className="size-3 animate-spin text-zinc-400" />
              ) : (
                <span className={`inline-block size-1.5 rounded-full ${stale ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`} />
              )}
              {stale ? <span className="font-semibold text-amber-400">stale — retrying</span> : <span>live</span>}
              <span className="tabular-nums">· {lastUpdated ?? '—'} · 15s</span>
            </span>

            <Select
              value={broker}
              onValueChange={(v) => { if (typeof v === 'string' && v) setBroker(v as CrudeBroker); }}
            >
              <SelectTrigger size="sm" className="min-w-32 font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRUDE_BROKERS.map(b => (
                  <SelectItem key={b} value={b} className="font-mono">
                    {CRUDE_BROKER_LABELS[b]}
                    {brokerAuth && !brokerAuth[b] && <span className="ml-1.5 text-zinc-500">(no session)</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {expiries.length === 0 ? (
              <Loader2 className="size-3.5 animate-spin text-zinc-500" />
            ) : (
              <Select
                value={expiry}
                onValueChange={(v) => { if (typeof v === 'string' && v) setExpiry(v); }}
              >
                <SelectTrigger size="sm" className="min-w-40 font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expiries.map(exp => (
                    <SelectItem key={exp} value={exp} className="font-mono">
                      {fmtExpiryLong(exp)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Button variant="outline" size="sm" render={<Link href="/options" />}>
              <ArrowLeft />
              Nifty Options
            </Button>
          </div>
        </header>

        <main className="flex flex-col gap-4 px-4 py-5">
          {brokerAuth && !brokerAuth[broker] && (
            <Alert variant="destructive" className="border-amber-500/40 bg-amber-500/10">
              <AlertCircle />
              <AlertTitle>No {brokerLabel} session</AlertTitle>
              <AlertDescription>
                Chain data still loads (it comes from Dhan either way), but orders and the position book
                for {brokerLabel} are unavailable until you log in.
              </AlertDescription>
            </Alert>
          )}

          {isKotak && kotakSymbolsError && (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
              <AlertCircle />
              <AlertTitle>Kotak contract lookup failed</AlertTitle>
              <AlertDescription>
                {kotakSymbolsError} — trading buttons stay disabled until strikes can be resolved to Kotak symbols.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
              <AlertCircle />
              <AlertTitle>Option chain unavailable</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {orderMessage && (
            <Alert
              variant={orderMessage.isError ? 'destructive' : 'default'}
              className={orderMessage.isError
                ? 'border-red-500/40 bg-red-500/10'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}
            >
              <AlertCircle />
              <AlertTitle>{orderMessage.isError ? 'Order failed' : 'Order update'}</AlertTitle>
              <AlertDescription className={orderMessage.isError ? undefined : 'text-emerald-300'}>
                {orderMessage.text}
              </AlertDescription>
            </Alert>
          )}

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList variant="line" className="border-b border-zinc-800">
              <TabsTrigger value="chain">Option Chain</TabsTrigger>
              <TabsTrigger value="oi">Open Interest</TabsTrigger>
              <TabsTrigger value="cumulative">Cumulative OI</TabsTrigger>
            </TabsList>
          </Tabs>

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
            <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start xl:gap-4">
              {/* Left: chain + activity */}
              <div className="order-2 flex min-w-0 flex-col gap-4 xl:order-1">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Strikes around ATM</span>
                    <ToggleGroup
                      value={[String(wings)]}
                      onValueChange={(v) => { if (v[0]) setWings(Number(v[0]) as Wings); }}
                      variant="outline"
                      size="sm"
                      spacing={0}
                    >
                      {WING_OPTIONS.map(w => (
                        <ToggleGroupItem key={w} value={String(w)} className="tabular-nums">
                          ±{w}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <span className="text-[11px] tabular-nums text-zinc-500">
                    {rows.length} rows · {brokerLabel} · ticket {qtyLabel}
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
                  <Alert variant="destructive" className="border-red-500/40 bg-red-500/10">
                    <AlertCircle />
                    <AlertTitle>Positions feed unavailable</AlertTitle>
                    <AlertDescription>{tradesError}</AlertDescription>
                  </Alert>
                )}

                <ActivityTables
                  tab={activeActivityTab}
                  setTab={setActiveActivityTab}
                  orders={crudeOrders}
                  trades={crudeTrades}
                  loading={tradesLoading}
                />
              </div>

              {/* Right: live risk rail — sticks beside the chain on wide screens,
                  sits above it on narrower ones so it is never buried. */}
              <div className="order-1 xl:order-2 xl:sticky xl:top-24 xl:self-start">
                <RiskRail
                  lots={lots}
                  lotSize={lotSize}
                  setLots={setLots}
                  brokerLabel={brokerLabel}
                  positions={crudePositions}
                  loading={tradesLoading}
                  totalRealized={totalRealized}
                  totalUnrealized={totalUnrealized}
                  totalPnl={totalPnl}
                  exitingAll={exitingAll}
                  onExitAll={handleExitAll}
                  riskConfigs={riskConfigs}
                  editingConfigs={editingConfigs}
                  onThresholdChange={handleInputChange}
                  onThresholdCommit={handleInputCommit}
                />
              </div>
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
