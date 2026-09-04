'use client';

/**
 * Combined payoff / Greeks / P&L analysis for the open option positions of one
 * underlying.
 *
 * Data sourcing rule that runs through the whole file: **positions come from the
 * selected broker, market data always comes from Dhan.** /api/options/chain
 * serves non-Dhan brokers out of a cached instrument master whose prices are all
 * zero and which carries no greeks, so joining greeks/IV/OI from anywhere but
 * Dhan would silently produce a flat, wrong chart.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, AlertTriangle, Loader2, Sparkles, LineChart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import {
  buildPositionLegs, buildInstrumentIndex, computeExposure, legExpiries,
  type PositionLeg, type UnparseableLeg, type InstrumentRow,
} from '@/lib/positionLegs';
import {
  buildMultiExpiryCurve, computePayoffStats, legsMissingIv, daysBetweenDates,
  impliedVolFromPrice, lookupChainLegData, resolveFreeformLegs,
  type ChainOc, type PayoffStats, type ResolvedLeg,
} from '@/lib/optionsStrategy';
import { fetchMarginSummary } from '@/lib/optionsMargin';
import { STRIKE_STEP, lotSizeOverride, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import { todayIso, fmtExpiryShort } from '@/components/crudeoil/format';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import { closeLeg } from '@/lib/legClose';
import { placeOptionOrder } from '@/lib/optionOrder';
import { fetchStrikeMap } from '@/lib/strikeLookup';
import { legKey } from '@/components/analytics/PositionsLegTable';
import type { ClosePct } from '@/lib/partialQty';
import { isIntradayProduct } from '@/lib/positionProduct';
import type { Suggestion } from '@/app/api/options/suggestions/route';

import PositionsPayoffChart, { pnlAt, type OiBar } from '@/components/analytics/PositionsPayoffChart';
import PayoffMetricStrip from '@/components/analytics/PayoffMetricStrip';
import BookRiskCard from '@/components/analytics/BookRiskCard';
import SuggestedActionsCard from '@/components/analytics/SuggestedActionsCard';
import AnalyzeModal from '@/components/analytics/AnalyzeModal';
import PositionsLegTable, { legPnl } from '@/components/analytics/PositionsLegTable';
import AddStrikePicker from '@/components/analytics/AddStrikePicker';
import DraftStrikeBuilder, { type DraftLegSpec } from '@/components/analytics/DraftStrikeBuilder';
import GreeksTab from '@/components/analytics/GreeksTab';
import PnlTableTab from '@/components/analytics/PnlTableTab';

interface Toast { id: number; type: 'success' | 'error'; message: string; detail?: string }

/** Brokers this page supports. Zerodha is deliberately out of scope. */
const BROKERS: Broker[] = ['dhan', 'kotak'];

const SPAN_STEPS = [0.01, 0.02, 0.04, 0.06, 0.10] as const;
const DEFAULT_SPAN_INDEX = 2;

const POSITIONS_POLL_MS = 15_000;
const FUNDS_POLL_MS = 15_000;
/** Dhan's option-chain API is rate limited (~1 call / 3.5 s per underlying). */
const CHAIN_SPACING_MS = 3_800;
const MAX_CHAIN_EXPIRIES = 4;
// The route serializes spawns per underlying to >=3.5s apart and caches each
// (underlying, expiry) response for 10s server-side, so this stays well clear
// of the rate limit even with MAX_CHAIN_EXPIRIES loaded.
const CHAIN_POLL_MS = 15_000;

type Tab = 'payoff' | 'greeks' | 'pnl' | 'intraday';

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function pnlColor(n: number): string {
  return n > 0 ? 'text-emerald-400' : n < 0 ? 'text-red-400' : 'text-zinc-400';
}

/** Local ISO date `days` from today. */
function isoPlusDays(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function PositionsAnalysis({ underlying }: { underlying: AnalyticsUnderlying }) {
  const { broker, setBroker, authenticatedBrokers, authChecked } = useBrokerSelector();
  const strikeStep = STRIKE_STEP[underlying];

  const [positions, setPositions] = useState<ScalperPosition[]>([]);
  const [rawPositions, setRawPositions] = useState<Record<string, unknown>[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [dataDate, setDataDate] = useState<string | null>(null);
  useEffect(() => { setDataDate(todayIso()); }, []);

  const [instruments, setInstruments] = useState<Map<string, InstrumentRow> | undefined>(undefined);
  const [chains, setChains] = useState<Record<string, ChainOc>>({});
  const [spot, setSpot] = useState<number>(0);
  const [spotChangePct, setSpotChangePct] = useState<number>(0);
  const [chainError, setChainError] = useState<string | null>(null);
  const [chainLoading, setChainLoading] = useState(false);

  const [fetchedLotSize, setFetchedLotSize] = useState<number | null>(null);
  const [fetchedLotError, setFetchedLotError] = useState<string | null>(null);
  const [funds, setFunds] = useState<number | null>(null);
  const [usedMargin, setUsedMargin] = useState<number | null>(null);
  const [standaloneMargin, setStandaloneMargin] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<Set<string>>(new Set());
  const [showAnalyzeModal, setShowAnalyzeModal] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeSummary, setAnalyzeSummary] = useState<string | null>(null);
  const [sentinelRunning, setSentinelRunning] = useState(false);
  const [sentinelToggling, setSentinelToggling] = useState(false);

  const [tab, setTab] = useState<Tab>('payoff');
  const [expiryFilter, setExpiryFilter] = useState<string>('ALL');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [closingKeys, setClosingKeys] = useState<Set<string>>(new Set());
  const [addingKeys, setAddingKeys] = useState<Set<string>>(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [draftLegs, setDraftLegs] = useState<DraftLegSpec[]>([]);
  const [draftBuilderExpiry, setDraftBuilderExpiry] = useState<string | null>(null);
  const [placingDrafts, setPlacingDrafts] = useState(false);
  const [confirmExitExpiry, setConfirmExitExpiry] = useState<string | null>(null);
  const [spanIndex, setSpanIndex] = useState<number>(DEFAULT_SPAN_INDEX);
  const [showOi, setShowOi] = useState(true);
  const [targetSpot, setTargetSpot] = useState<number | null>(null);
  const [targetDaysRaw, setTargetDays] = useState<number>(0);

  const brokerRef = useRef(broker);
  useEffect(() => { brokerRef.current = broker; }, [broker]);

  /** Serialized last-seen positions payload, so an unchanged poll is a no-op. */
  const positionsSigRef = useRef<string>('');

  // Restrict the selector to the supported brokers; if the shared hook lands on
  // an unsupported one, fall back to Dhan rather than silently reading the wrong
  // account's book.
  const availableBrokers = useMemo(
    () => BROKERS.filter((b) => authenticatedBrokers.includes(b)),
    [authenticatedBrokers],
  );
  useEffect(() => {
    if (authChecked && !BROKERS.includes(broker)) setBroker('dhan');
  }, [authChecked, broker, setBroker]);

  // ── lot size (once per underlying) ─────────────────────────────────────────
  // Derived synchronously, not via setState-in-effect, so a CRUDEOIL mount never
  // renders once with the wrong (fetched) lot size before the override lands.
  const lotOverride = useMemo(() => lotSizeOverride(underlying), [underlying]);
  const lotSize = lotOverride ?? fetchedLotSize;
  const lotError = lotOverride !== null ? null : fetchedLotError;

  useEffect(() => {
    if (lotOverride !== null) return; // no fetch needed — see lotSizeOverride
    let cancelled = false;
    fetch(`/api/lotsize?symbol=${underlying}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (typeof j?.lot_size === 'number' && j.lot_size > 0) { setFetchedLotSize(j.lot_size); setFetchedLotError(null); }
        else { setFetchedLotSize(null); setFetchedLotError(j?.error ?? 'lot size unavailable'); }
      })
      .catch((e) => { if (!cancelled) setFetchedLotError(String(e)); });
    return () => { cancelled = true; };
  }, [underlying, lotOverride]);

  // ── broker instrument cache (non-Dhan only) ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // Dhan needs no instrument cache — its positions carry drvStrikePrice /
    // drvOptionType / drvExpiryDate natively.
    const url = broker === 'dhan'
      ? null
      : `/api/options/instruments?broker=${broker}&underlying=${underlying.toLowerCase()}`;
    Promise.resolve(url ? fetch(url).then((r) => r.json()) : null)
      .then((j) => {
        if (cancelled) return;
        setInstruments(j?.available ? buildInstrumentIndex(j.data as InstrumentRow[]) : undefined);
      })
      .catch(() => { if (!cancelled) setInstruments(undefined); });
    return () => { cancelled = true; };
  }, [broker, underlying]);

  // ── positions ──────────────────────────────────────────────────────────────
  const loadPositions = useCallback(async () => {
    const forBroker = brokerRef.current;
    try {
      const res = await fetch(scalperRoute(forBroker, 'positions'));
      const json = await res.json();
      if (brokerRef.current !== forBroker) return; // broker switched mid-flight
      if (!json?.success) {
        setPositionsError(json?.error ?? 'Failed to fetch positions');
        return;
      }
      const rows = (json.data ?? []) as Record<string, unknown>[];
      // Only replace state when the book actually changed. Every setState here
      // invalidates the whole memo chain down to the margin effect, which spawns
      // a ~3 s Python process — at a 2 s poll that was a permanent request storm
      // against a flat book (17 concurrent /api/options/margin calls observed).
      const sig = JSON.stringify(rows);
      if (sig !== positionsSigRef.current) {
        positionsSigRef.current = sig;
        setRawPositions(rows);
        setPositions(rows as unknown as ScalperPosition[]);
      }
      setPositionsError(null);
      setRefreshedAt(new Date());
    } catch (err) {
      setPositionsError(String((err as Error).message ?? err));
    } finally {
      setLoadedOnce(true);
    }
  }, []);

  useEffect(() => {
    loadPositions();
    const id = setInterval(loadPositions, POSITIONS_POLL_MS);
    return () => clearInterval(id);
  }, [loadPositions, broker]);

  // ── leg exit / adjust (real orders) ─────────────────────────────────────────
  const addToast = useCallback((type: Toast['type'], message: string, detail?: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === 'error' ? 7000 : 3500);
  }, []);

  const handleCloseLeg = useCallback(async (leg: PositionLeg, pct: ClosePct) => {
    if (!lotSize) { addToast('error', 'Lot size unresolved', `Cannot size a close order for ${underlying}`); return; }
    const key = legKey(leg);
    if (closingKeys.has(key)) return;
    setClosingKeys((prev) => new Set(prev).add(key));
    const label = `${leg.side === 'SELL' ? 'S' : 'B'} ${leg.strike} ${leg.type}`;
    try {
      const res = await closeLeg(broker, leg, lotSize, pct / 100);
      if (res.ok && res.units === 0) {
        addToast('success', `${label} already flat`);
      } else if (res.ok) {
        addToast('success', `${pct === 100 ? 'Closed' : `Trimmed ${pct}% of`} ${label}`, res.orderId ? `ID: ${res.orderId}` : undefined);
        setTimeout(loadPositions, 1000);
      } else {
        addToast('error', `${label} close failed`, res.error);
      }
    } finally {
      setClosingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [broker, lotSize, underlying, closingKeys, addToast, loadPositions]);

  /**
   * Scale into an EXISTING leg's strike — a fresh order on the same
   * (expiry, strike, type), not a close. Looks up this leg's own expiry's
   * strike map (cached by lib/strikeLookup.ts) rather than trusting the
   * leg's chain-derived securityId, which is Dhan-only and useless for a
   * Kotak order.
   */
  const handleAddToLeg = useCallback(async (leg: PositionLeg, side: 'BUY' | 'SELL', lots: number) => {
    if (!lotSize) { addToast('error', 'Lot size unresolved', `Cannot size an add order for ${underlying}`); return; }
    if (!leg.expiry) { addToast('error', 'Cannot add', 'This leg has no resolved expiry'); return; }
    const key = legKey(leg);
    if (addingKeys.has(key)) return;
    setAddingKeys((prev) => new Set(prev).add(key));
    const label = `${side === 'BUY' ? 'B' : 'S'} ${leg.strike} ${leg.type} × ${lots}L`;
    try {
      const map = await fetchStrikeMap(broker, underlying, leg.expiry);
      const entry = map?.strikes?.[String(leg.strike)];
      if (!entry) { addToast('error', `${label} failed`, 'Strike data unavailable for this expiry'); return; }
      const res = await placeOptionOrder({
        broker, underlying, side, quantity: lots * lotSize,
        dhanSecurityId: leg.type === 'CE' ? entry.ceId : entry.peId,
        tradingSymbol: leg.type === 'CE' ? entry.ceSymbol : entry.peSymbol,
      });
      if (res.ok) {
        addToast('success', `${label} placed`, res.orderId ? `ID: ${res.orderId}` : undefined);
        setTimeout(loadPositions, 1000);
      } else {
        addToast('error', `${label} failed`, res.error);
      }
    } finally {
      setAddingKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [broker, lotSize, underlying, addingKeys, addToast, loadPositions]);

  /** `scopeKey` arms independently per button (e.g. 'ALL' vs one expiry's date), so confirming one never fires another. */
  const handleExitScope = useCallback(async (scopeKey: string, targets: PositionLeg[]) => {
    if (confirmExitExpiry !== scopeKey) {
      setConfirmExitExpiry(scopeKey);
      setTimeout(() => setConfirmExitExpiry((e) => (e === scopeKey ? null : e)), 3000);
      return;
    }
    setConfirmExitExpiry(null);
    for (const leg of targets) {
      // Sequential, not Promise.all: closeLeg() re-fetches live positions before
      // each order, and firing them concurrently would race that fetch against
      // the previous leg's own not-yet-reflected fill.
      // eslint-disable-next-line no-await-in-loop
      await handleCloseLeg(leg, 100);
    }
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      targets.forEach((leg) => next.delete(legKey(leg)));
      return next;
    });
  }, [confirmExitExpiry, handleCloseLeg]);

  const toggleSelectLeg = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAllLegs = useCallback((keys: string[]) => {
    setSelectedKeys((prev) => {
      const allSelected = keys.length > 0 && keys.every((k) => prev.has(k));
      if (allSelected) {
        const next = new Set(prev);
        keys.forEach((k) => next.delete(k));
        return next;
      }
      return new Set([...prev, ...keys]);
    });
  }, []);

  const handlePlaceDrafts = useCallback(async () => {
    if (!lotSize || placingDrafts || !draftLegs.length) return;
    setPlacingDrafts(true);
    for (const d of draftLegs) {
      // Sequential — same reasoning as handleExitScope: avoid bursting the
      // broker order API and keep per-leg toasts in a legible order.
      // eslint-disable-next-line no-await-in-loop
      const map = await fetchStrikeMap(broker, underlying, d.expiry);
      const entry = map?.strikes?.[String(d.strike)];
      const label = `${d.side === 'BUY' ? 'B' : 'S'} ${d.strike} ${d.type} × ${d.lots}L`;
      if (!entry) { addToast('error', `${label} failed`, 'Strike data unavailable for this expiry'); continue; }
      // eslint-disable-next-line no-await-in-loop
      const res = await placeOptionOrder({
        broker, underlying, side: d.side, quantity: d.lots * lotSize,
        dhanSecurityId: d.type === 'CE' ? entry.ceId : entry.peId,
        tradingSymbol: d.type === 'CE' ? entry.ceSymbol : entry.peSymbol,
      });
      if (res.ok) addToast('success', `${label} placed`, res.orderId ? `ID: ${res.orderId}` : undefined);
      else addToast('error', `${label} failed`, res.error);
    }
    setDraftLegs([]);
    setPlacingDrafts(false);
    setTimeout(loadPositions, 1000);
  }, [draftLegs, broker, underlying, lotSize, placingDrafts, addToast, loadPositions]);

  const handleAnalyze = useCallback(async () => {
    setShowAnalyzeModal(true);
    setAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeSummary(null);
    try {
      const res = await fetch('/api/options/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying, broker }),
      });
      const json = await res.json();
      if (!json.success) { setAnalyzeError(json.error ?? 'Analysis failed'); return; }
      setAnalyzeSummary(json.summary ?? null);
      // The route already persisted these to debug/options_suggestions_<underlying>.json —
      // setting state directly here just means the sidebar card doesn't have to
      // wait for its next poll to show the same result.
      setSuggestions(json.suggestions ?? []);
    } catch (err) {
      setAnalyzeError(String((err as Error).message ?? err));
    } finally {
      setAnalyzing(false);
    }
  }, [underlying, broker]);

  // ── daemon status poll ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const checkDaemon = async () => {
      try {
        const res = await fetch('/api/options/analyzer-daemon');
        const json = await res.json();
        if (cancelled || !json?.success) return;
        setSentinelRunning(json.status?.status === 'RUNNING');
      } catch { /* advisory */ }
    };
    checkDaemon();
    const id = setInterval(checkDaemon, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleToggleSentinel = useCallback(async () => {
    setSentinelToggling(true);
    try {
      const action = sentinelRunning ? 'stop' : 'start';
      const res = await fetch('/api/options/analyzer-daemon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, underlying, broker, interval: 180 }),
      });
      const json = await res.json();
      if (json.success) {
        setSentinelRunning(action === 'start');
        setToasts((t) => [
          ...t,
          {
            id: Date.now(),
            type: 'success',
            message: action === 'start' ? `Antigravity Sentinel started for ${underlying}` : 'Antigravity Sentinel stopped',
            detail: action === 'start' ? 'Monitoring risk in background every 3m' : undefined,
          },
        ]);
      }
    } catch (err) {
      setToasts((t) => [
        ...t,
        { id: Date.now(), type: 'error', message: 'Failed to toggle sentinel', detail: String(err) },
      ]);
    } finally {
      setSentinelToggling(false);
    }
  }, [sentinelRunning, underlying, broker]);

  // ── funds ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(scalperRoute(brokerRef.current, 'funds'));
        const json = await res.json();
        if (cancelled || !json?.success) return;
        // Dhan misspells this field; the Kotak and Zerodha shims emit it too.
        const bal = json.data?.availabelBalance ?? json.data?.availableBalance;
        setFunds(typeof bal === 'number' ? bal : null);
        const used = json.data?.utilizedAmount;
        setUsedMargin(typeof used === 'number' ? used : null);
      } catch { /* funds are advisory — a failure must not blank the page */ }
    };
    load();
    const id = setInterval(load, FUNDS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [broker]);

  // ── suggested actions (written by a Claude session asked to review this book —
  // see rs_dashboard/scripts/analyze-positions.ts) ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/options/suggestions?underlying=${underlying}`);
        const json = await res.json();
        if (cancelled || !json?.success) return;
        setSuggestions(json.suggestions ?? []);
      } catch { /* suggestions are advisory — a failure must not blank the page */ }
    };
    load();
    const id = setInterval(load, FUNDS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [underlying]);

  // ── legs (needs chains for greeks, so it runs twice: bare, then enriched) ───
  const { legs: allLegs, unparseable } = useMemo(() => {
    if (!positions.length) return { legs: [] as PositionLeg[], unparseable: [] as UnparseableLeg[] };
    // Merge every fetched expiry's chain into one lookup: a leg is joined by
    // strike+type, and strikes do not collide across expiries in practice
    // because we only ever look up a leg in its own expiry's chain below.
    return buildPositionLegs(positions, {
      raw: broker === 'dhan' ? rawPositions : undefined,
      instruments,
      underlying,
    });
  }, [positions, rawPositions, instruments, underlying, broker]);

  // Join greeks/IV per leg from that leg's OWN expiry chain. A leg whose expiry
  // has no chain loaded keeps its null greeks and is disclosed downstream by
  // legsMissingIv() rather than being quietly treated as zero-greek.
  const legs = useMemo<PositionLeg[]>(() => {
    if (!allLegs.length) return allLegs;
    return allLegs.map((leg) => {
      const oc = leg.expiry ? chains[leg.expiry] : undefined;
      if (!oc) return leg;
      const cl = lookupChainLegData(oc, leg.strike, leg.type);
      if (!cl) return leg;
      return {
        ...leg,
        delta: cl.greeks?.delta ?? leg.delta,
        gamma: cl.greeks?.gamma ?? leg.gamma,
        theta: cl.greeks?.theta ?? leg.theta,
        vega: cl.greeks?.vega ?? leg.vega,
        // Dhan reports IV as a percent; bsPrice() takes a fraction.
        iv: typeof cl.implied_volatility === 'number' && cl.implied_volatility > 0
          ? cl.implied_volatility / 100
          : leg.iv,
        display: {
          ...leg.display,
          // Kotak reports no LTP — the chain's mark is the only live price there
          // is. `> 0`, not `??`: a genuine 0 (no trade yet today) is not the same
          // as "worthless" for a deep ITM/OTM contract, and letting it through
          // would report a short leg as fully profitable instead of unpriced.
          ltp: leg.display.ltp ?? (cl.last_price > 0 ? cl.last_price : null),
        },
      };
    });
  }, [allLegs, chains]);

  const bookExpiries = useMemo(() => legExpiries(legs), [legs]);
  const bookExpiriesKey = bookExpiries.join(',');

  // Expiries a draft leg needs a chain for — the builder's in-progress
  // (not-yet-added) expiry selection plus every committed draft leg's expiry.
  const draftExpiries = useMemo(
    () => [...new Set([...draftLegs.map((d) => d.expiry), draftBuilderExpiry].filter((e): e is string => !!e))],
    [draftLegs, draftBuilderExpiry],
  );
  const draftExpiriesKey = draftExpiries.join(',');

  // ── chains, one per expiry present in the book (+ any draft expiries) ──────
  useEffect(() => {
    if (!bookExpiries.length && !draftExpiries.length) return;
    let cancelled = false;

    const fetchChains = async () => {
      setChainLoading(true);
      // Real positions take priority within the rate-limited budget — a draft
      // is exploratory, not committed capital, and can wait a poll cycle.
      const extraDraft = draftExpiries.filter((e) => !bookExpiries.includes(e));
      const wanted = [...bookExpiries, ...extraDraft].slice(0, MAX_CHAIN_EXPIRIES);
      for (let i = 0; i < wanted.length; i++) {
        if (cancelled) return;
        // Spaced sequentially: the Dhan chain API 429s on parallel calls for the
        // same underlying, and the route's own dedupe cannot help across expiries.
        if (i > 0) await new Promise((r) => setTimeout(r, CHAIN_SPACING_MS));
        try {
          const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${wanted[i]}`);
          const json = await res.json();
          if (cancelled) return;
          if (!json?.success) { setChainError(json?.error ?? 'chain unavailable'); continue; }
          const oc = (json.data?.chain?.oc ?? {}) as ChainOc;
          setChains((prev) => ({ ...prev, [wanted[i]]: oc }));
          if (i === 0) {
            setSpot(json.data?.spot ?? 0);
            setSpotChangePct(json.data?.change_pct ?? 0);
          }
          setChainError(null);
        } catch (err) {
          if (!cancelled) setChainError(String((err as Error).message ?? err));
        }
      }
      const droppedBook = Math.max(0, bookExpiries.length - MAX_CHAIN_EXPIRIES);
      const droppedDraft = extraDraft.length - Math.max(0, MAX_CHAIN_EXPIRIES - bookExpiries.length);
      if (droppedBook > 0) {
        setChainError(`Greeks loaded for the nearest ${MAX_CHAIN_EXPIRIES} expiries only; ${droppedBook} further expiry/expiries will price without IV.`);
      } else if (droppedDraft > 0) {
        setChainError(`Chain budget full with real positions; ${droppedDraft} draft expiry/expiries will load once a slot frees up.`);
      }
      if (!cancelled) setChainLoading(false);
    };

    fetchChains();
    // Re-poll so spot/greeks/IV/OI keep tracking the live market rather than
    // freezing at the values captured when the book's expiry set last changed.
    const id = setInterval(fetchChains, CHAIN_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // Deliberately keyed on the JOINED expiry lists, not the arrays: `bookExpiries`
    // is a fresh array on every 2 s positions poll and `draftExpiries` is a fresh
    // array on every render that touches draft state, so depending on either
    // reference would refetch a rate-limited chain API continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookExpiriesKey, draftExpiriesKey, underlying]);

  // ── filtering ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (expiryFilter !== 'ALL' && bookExpiries.length > 0 && !bookExpiries.includes(expiryFilter)) {
      setExpiryFilter('ALL');
    }
  }, [bookExpiries, expiryFilter]);

  const visibleLegs = useMemo(
    () => (expiryFilter === 'ALL' ? legs : legs.filter((l) => l.expiry === expiryFilter)),
    [legs, expiryFilter],
  );

  const selectedVisibleLegs = useMemo(
    () => visibleLegs.filter((l) => selectedKeys.has(legKey(l))),
    [visibleLegs, selectedKeys],
  );

  /** The date at which every visible leg has settled — the "on expiry" view. */
  const finalExpiry = useMemo(() => {
    const es = legExpiries(visibleLegs);
    return es.length ? es[es.length - 1] : null;
  }, [visibleLegs]);

  const maxTargetDays = useMemo(
    () => (finalExpiry ? daysBetweenDates(todayIso(), finalExpiry) : 0),
    [finalExpiry],
  );
  const spanPct = SPAN_STEPS[spanIndex];

  // Fill in IV the chain omitted by inverting the leg's own CURRENT mark.
  // Without this a leg silently prices intrinsically in the target-date curve.
  //
  // Must use the live LTP, never `leg.price` (the entry average) as a fallback:
  // the entry price was struck against a different spot on a different day, so
  // solving IV from it at today's spot produces a confident-looking but wrong
  // number — and because the leg now has a non-null `iv`, legsMissingIv() stops
  // flagging it, silently hiding the exact problem the warning exists to catch.
  // A leg with no live mark stays unsolved and correctly still "missing IV".
  const pricedLegs = useMemo<PositionLeg[]>(() => {
    if (!spot || !finalExpiry) return visibleLegs;
    return visibleLegs.map((leg) => {
      if (leg.iv && leg.iv > 0) return leg;
      const mark = leg.display.ltp;
      if (mark === null || !(mark > 0)) return leg;
      const t = leg.expiry ? daysBetweenDates(todayIso(), leg.expiry) / 365 : 0;
      const solved = impliedVolFromPrice(leg.type, spot, leg.strike, t, mark);
      return solved ? { ...leg, iv: solved } : leg;
    });
  }, [visibleLegs, spot, finalExpiry]);

  // ── Intraday (MIS) scope, for the dedicated tab ─────────────────────────────
  // Its own final-expiry, NOT the page's `finalExpiry`: that is the latest
  // expiry across every VISIBLE leg (which can be a far-dated positional one)
  // and has nothing to do with what an intraday leg is actually pricing against.
  const intradayLegs = useMemo(
    () => pricedLegs.filter((l) => isIntradayProduct(l.display.productType)),
    [pricedLegs],
  );
  const intradayFinalExpiry = useMemo(() => {
    const es = legExpiries(intradayLegs);
    return es.length ? es[es.length - 1] : null;
  }, [intradayLegs]);
  const intradayCurve = useMemo(
    () => (intradayLegs.length && spot && intradayFinalExpiry
      ? buildMultiExpiryCurve(intradayLegs, spot, 1, intradayFinalExpiry, strikeStep, spanPct)
      : []),
    [intradayLegs, spot, intradayFinalExpiry, strikeStep, spanPct],
  );
  const intradayStats = useMemo<PayoffStats | null>(
    () => (intradayLegs.length && spot && intradayFinalExpiry
      ? computePayoffStats(intradayLegs, spot, 1, intradayFinalExpiry, strikeStep, spanPct)
      : null),
    [intradayLegs, spot, intradayFinalExpiry, strikeStep, spanPct],
  );

  const expiryCurve = useMemo(
    () => (pricedLegs.length && spot && finalExpiry
      ? buildMultiExpiryCurve(pricedLegs, spot, 1, finalExpiry, strikeStep, spanPct)
      : []),
    [pricedLegs, spot, finalExpiry, strikeStep, spanPct],
  );

  // Clamped rather than stored: the book can shrink (a leg closes, the last
  // expiry moves nearer) while the slider still holds a larger number, and a
  // target date past the final expiry would price every leg at zero time value
  // while still being drawn as a distinct "before expiry" curve.
  const targetDays = Math.min(targetDaysRaw, maxTargetDays);

  const targetDate = useMemo(() => isoPlusDays(targetDays), [targetDays]);

  const targetCurve = useMemo(() => {
    if (!pricedLegs.length || !spot || !finalExpiry) return null;
    if (targetDays >= maxTargetDays) return null; // identical to the expiry curve
    return buildMultiExpiryCurve(pricedLegs, spot, 1, targetDate, strikeStep, spanPct);
  }, [pricedLegs, spot, finalExpiry, targetDate, targetDays, maxTargetDays, strikeStep, spanPct]);

  const stats = useMemo<PayoffStats | null>(
    () => (pricedLegs.length && spot && finalExpiry
      ? computePayoffStats(pricedLegs, spot, 1, finalExpiry, strikeStep, spanPct)
      : null),
    [pricedLegs, spot, finalExpiry, strikeStep, spanPct],
  );

  // ── draft ("what-if") legs — client-only, resolved against the same chain
  // cache, never touching the broker until the user commits ──────────────────
  const draftGroups = useMemo(() => {
    const byExpiry = new Map<string, DraftLegSpec[]>();
    for (const d of draftLegs) {
      const arr = byExpiry.get(d.expiry) ?? [];
      arr.push(d);
      byExpiry.set(d.expiry, arr);
    }
    return byExpiry;
  }, [draftLegs]);

  const { resolvedDraftLegs, draftMissingStrikes } = useMemo(() => {
    const resolved: ResolvedLeg[] = [];
    const missing: number[] = [];
    for (const [expiry, specs] of draftGroups) {
      const oc = chains[expiry];
      if (!oc) { missing.push(...specs.map((s) => s.strike)); continue; }
      const { legs: legsFromChain, missingStrikes } = resolveFreeformLegs(
        specs.map((s) => ({ strike: s.strike, type: s.type, side: s.side, qtyLots: s.lots * (lotSize ?? 0) })),
        oc,
      );
      // resolveFreeformLegs does not stamp `.expiry` — without it, a draft leg
      // on a later expiry than the book would silently price at pure intrinsic
      // (buildMultiExpiryCurve treats a legless expiry as "expires today").
      resolved.push(...legsFromChain.map((l) => ({ ...l, expiry })));
      missing.push(...missingStrikes);
    }
    return { resolvedDraftLegs: resolved, draftMissingStrikes: missing };
  }, [draftGroups, chains, lotSize]);

  const combinedLegs = useMemo(() => [...pricedLegs, ...resolvedDraftLegs], [pricedLegs, resolvedDraftLegs]);

  const draftExpiriesForCurve = useMemo(
    () => [...new Set(resolvedDraftLegs.map((l) => l.expiry).filter((e): e is string => !!e))],
    [resolvedDraftLegs],
  );

  const combinedFinalExpiry = useMemo(() => {
    const all = [finalExpiry, ...draftExpiriesForCurve].filter((e): e is string => !!e);
    return all.length ? all.sort().at(-1)! : null;
  }, [finalExpiry, draftExpiriesForCurve]);

  // Guard on resolvedDraftLegs (actually resolved against a loaded chain),
  // not draftLegs.length — a draft whose chain hasn't loaded yet must not
  // draw a misleading flat/unchanged curve.
  const hasResolvedDrafts = resolvedDraftLegs.length > 0;

  const draftCurve = useMemo(
    () => (hasResolvedDrafts && spot && combinedFinalExpiry
      ? buildMultiExpiryCurve(combinedLegs, spot, 1, combinedFinalExpiry, strikeStep, spanPct)
      : null),
    [hasResolvedDrafts, combinedLegs, spot, combinedFinalExpiry, strikeStep, spanPct],
  );

  const draftStats = useMemo<PayoffStats | null>(
    () => (hasResolvedDrafts && spot && combinedFinalExpiry
      ? computePayoffStats(combinedLegs, spot, 1, combinedFinalExpiry, strikeStep, spanPct)
      : null),
    [hasResolvedDrafts, combinedLegs, spot, combinedFinalExpiry, strikeStep, spanPct],
  );

  const ivWarning = useMemo(() => {
    if (!finalExpiry || targetDays >= maxTargetDays) return null;
    const missing = legsMissingIv(pricedLegs, targetDate);
    if (!missing.length) return null;
    return `${missing.length} leg(s) (${missing.map((l) => `${l.strike} ${l.type}`).join(', ')}) have no implied volatility and could not be solved from their mark — they are priced at intrinsic value only, so the target-date curve understates their remaining time value.`;
  }, [pricedLegs, targetDate, finalExpiry, targetDays, maxTargetDays]);

  // ── OI histogram from the nearest expiry's chain ───────────────────────────
  const oiBars = useMemo<OiBar[]>(() => {
    const oc = finalExpiry ? chains[finalExpiry] ?? chains[bookExpiries[0]] : undefined;
    if (!oc) return [];
    return Object.entries(oc)
      .map(([k, v]) => ({ strike: Number(k), callOi: v.ce?.oi ?? 0, putOi: v.pe?.oi ?? 0 }))
      .filter((b) => Number.isFinite(b.strike) && (b.callOi > 0 || b.putOi > 0))
      .sort((a, b) => a.strike - b.strike);
  }, [chains, finalExpiry, bookExpiries]);

  // Dhan's margin calculator takes ONE expiry per call. Passing `finalExpiry`
  // (the LATEST expiry, used for the payoff/greeks views) for every leg would
  // margin an earlier-dated leg as if it were that later contract — wrong
  // strike lookup at best, a silently wrong margin figure at worst. Only
  // compute margin when the whole priceable book shares a single, known expiry.
  const marginExpiry = useMemo(() => {
    if (!pricedLegs.length) return null;
    const first = pricedLegs[0].expiry;
    return first && pricedLegs.every((l) => l.expiry === first) ? first : null;
  }, [pricedLegs]);

  const standaloneMarginReason = useMemo(() => {
    if (!pricedLegs.length || marginExpiry) return null;
    return legExpiries(pricedLegs).length > 1
      ? 'Book spans multiple expiries — standalone margin needs one expiry at a time'
      : 'One or more legs have an unresolved expiry';
  }, [pricedLegs, marginExpiry]);

  // ── margin ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    const priceable = pricedLegs.length > 0 && !!marginExpiry && !!lotSize;
    // fetchMarginSummary already returns null for an empty leg set, so the
    // not-priceable case takes the same path rather than a synchronous reset.
    (priceable
      ? fetchMarginSummary(
          underlying,
          marginExpiry!,
          pricedLegs.map((l) => ({
            strike: l.strike, type: l.type, side: l.side,
            // The margin script sizes in LOTS, unlike the payoff engine, which
            // works in contracts. Convert here rather than changing the leg
            // convention — rounding a partial leg up to 1 lot overstates margin
            // slightly, which is the safe direction for a risk figure.
            qtyLots: Math.max(1, Math.round(l.qtyLots / lotSize!)),
            price: l.price,
          })),
          ctrl.signal,
        )
      : Promise.resolve(null)
    ).then((m) => { if (!ctrl.signal.aborted) setStandaloneMargin(m?.overall_margin ?? null); })
     .catch(() => {});
    return () => ctrl.abort();
  }, [pricedLegs, marginExpiry, lotSize, underlying]);

  // ── P&L rollup ─────────────────────────────────────────────────────────────
  const rollup = useMemo(() => {
    let booked = 0, unbooked = 0, unknown = 0;
    for (const l of visibleLegs) {
      const p = legPnl(l);
      booked += p.booked;
      if (p.unbooked === null) unknown++; else unbooked += p.unbooked;
    }
    return { booked, unbooked, total: booked + unbooked, unknown };
  }, [visibleLegs]);

  const intradayRollup = useMemo(() => {
    let booked = 0, unbooked = 0;
    for (const l of intradayLegs) {
      const p = legPnl(l);
      booked += p.booked;
      if (p.unbooked !== null) unbooked += p.unbooked;
    }
    return { total: booked + unbooked };
  }, [intradayLegs]);

  const exposure = useMemo(
    () => computeExposure(pricedLegs, { capital: funds, nav: funds }),
    [pricedLegs, funds],
  );

  const effectiveTargetSpot = targetSpot ?? spot;
  const projected = expiryCurve.length ? pnlAt(expiryCurve, effectiveTargetSpot) : null;
  const projectedTarget = targetCurve ? pnlAt(targetCurve, effectiveTargetSpot) : null;

  const curveLo = expiryCurve.length ? expiryCurve[0].spot : spot * 0.95;
  const curveHi = expiryCurve.length ? expiryCurve[expiryCurve.length - 1].spot : spot * 1.05;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300">
      {/* Sticky header */}
      <div className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/90 px-4 py-2.5 backdrop-blur-xl">
        <div className="mx-auto flex flex-wrap items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/10 shadow-inner">
            <LineChart className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mr-1">
            <p className="mb-0.5 text-[9px] font-extrabold uppercase tracking-[0.18em] text-emerald-400">
              Options · Positions Analysis
            </p>
            <h1 className="text-sm font-bold leading-none tracking-tight text-white">{underlying}</h1>
          </div>

          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 py-1 font-mono text-[10px] font-semibold text-zinc-400">
            DATA: {dataDate ?? '—'}
          </span>
          {spot > 0 && (
            <span className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 font-mono text-xs font-bold tabular-nums shadow-sm',
              spotChangePct >= 0
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400',
            )}>
              {spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ({spotChangePct >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%)
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 py-1 font-mono text-[10px] text-zinc-400">
            Lot {lotSize ?? '—'}
          </span>

          {availableBrokers.length > 1 && (
            <select
              value={broker}
              onChange={(e) => setBroker(e.target.value as Broker)}
              className="rounded-lg border border-zinc-750 bg-zinc-900 px-2.5 py-1 text-xs font-semibold text-zinc-200 shadow-sm transition-colors hover:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
            >
              {availableBrokers.map((b) => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
            </select>
          )}

          {(funds !== null || usedMargin !== null) && (
            <div
              className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/80 px-2.5 py-1 font-mono text-[10px] shadow-inner"
              title={`${BROKER_LABELS[broker]} portfolio margin — used vs. available`}
            >
              <span className="font-semibold text-zinc-500">Margin</span>
              <span className="text-amber-400">
                Used {usedMargin === null ? '—' : fmtInr(usedMargin)}
              </span>
              <span className="text-zinc-700">/</span>
              <span className="text-emerald-400">
                Avail {funds === null ? '—' : fmtInr(funds)}
              </span>
              {funds !== null && usedMargin !== null && (
                <>
                  <span className="text-zinc-700">/</span>
                  <span className="text-zinc-400">Total {fmtInr(funds + usedMargin)}</span>
                </>
              )}
            </div>
          )}

          <button type="button" onClick={loadPositions}
            className="flex items-center gap-1 rounded-lg border border-zinc-750 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 shadow-sm transition-colors hover:border-zinc-600 hover:bg-zinc-850 hover:text-white">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button type="button" onClick={handleAnalyze} disabled={analyzing}
            className="flex items-center gap-1.5 rounded-lg border border-sky-700/60 bg-sky-950/80 px-2.5 py-1.5 text-xs font-bold text-sky-300 shadow-sm transition-all hover:bg-sky-900 hover:border-sky-500 disabled:opacity-50">
            <Sparkles className="h-3 w-3 text-sky-400" /> {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
          <button type="button" onClick={handleToggleSentinel} disabled={sentinelToggling}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-all disabled:opacity-50 shadow-sm',
              sentinelRunning
                ? 'border-emerald-700/80 bg-emerald-950/80 text-emerald-300 hover:bg-emerald-900 hover:border-emerald-500'
                : 'border-zinc-750 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600',
            )}
            title={sentinelRunning ? 'Antigravity Sentinel is actively monitoring risk in the background' : 'Enable continuous background risk monitoring'}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', sentinelRunning ? 'animate-pulse bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]' : 'bg-zinc-500')} />
            {sentinelRunning ? 'Sentinel: ON' : 'Sentinel: OFF'}
          </button>
          {refreshedAt && (
            <span className="font-mono text-[10px] text-zinc-500">
              {refreshedAt.toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          )}

          <Link href="/options-analytics"
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs font-medium text-zinc-400 transition-all hover:border-zinc-700 hover:bg-zinc-850 hover:text-white">
            <ArrowLeft className="h-3 w-3" /> Back to Positions
          </Link>
        </div>
      </div>

      <div className="mx-auto space-y-4 px-4 py-5 max-w-[1720px]">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-850/60 pb-2">
          <p className="text-xs text-zinc-400">
            Analyse combined payoff, Greeks and P&amp;L for your open {underlying} positions.
            Positions from <span className="font-medium text-zinc-200">{BROKER_LABELS[broker]}</span>; chain, Greeks, IV and OI from <span className="font-medium text-zinc-200">Dhan</span>.
          </p>
        </div>

        {lotError && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-800/80 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>
              Lot size for {underlying} could not be resolved ({lotError}). Lot counts and margin are unavailable —
              rupee figures below are still exact, because the payoff engine sizes in contracts, not lots.
            </span>
          </div>
        )}
        {positionsError && (
          <div className="flex items-center gap-2 rounded-xl border border-rose-800/80 bg-rose-950/40 px-3.5 py-2.5 text-xs text-rose-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{positionsError}</span>
          </div>
        )}
        {chainError && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-800/80 bg-amber-950/40 px-3.5 py-2.5 text-xs text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>{chainError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)]">
          {/* ── Left: positions + sizing ────────────────────────────────── */}
          <div className="flex flex-col gap-4">
          <SuggestedActionsCard
            suggestions={suggestions.filter((s) => !dismissedSuggestionIds.has(s.id))}
            legs={legs}
            closingKeys={closingKeys}
            legKeyOf={legKey}
            onConfirm={handleCloseLeg}
            onDismiss={(id) => setDismissedSuggestionIds((prev) => new Set(prev).add(id))}
          />
          <section className="space-y-3.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              <h2 className="text-xs font-bold uppercase tracking-wider text-white">{underlying} Positions</h2>
              {chainLoading && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
              <span className="ml-auto font-mono text-[11px] font-medium text-zinc-400">{visibleLegs.length} leg(s)</span>
              {visibleLegs.length > 0 && (
                <button type="button" onClick={() => handleExitScope(`scope:${expiryFilter}`, visibleLegs)}
                  className={cn('rounded-lg border px-2.5 py-1 font-mono text-[10px] font-bold transition-all shadow-sm',
                    confirmExitExpiry === `scope:${expiryFilter}`
                      ? 'border-rose-500 bg-rose-500/25 text-rose-200 animate-pulse'
                      : 'border-rose-800/70 bg-rose-950/80 text-rose-300 hover:bg-rose-900 hover:border-rose-600')}>
                  {confirmExitExpiry === `scope:${expiryFilter}`
                    ? 'Confirm Exit All?'
                    : expiryFilter === 'ALL' ? 'Exit All' : `Exit ${fmtExpiryShort(expiryFilter)}`}
                </button>
              )}
              {selectedVisibleLegs.length > 0 && (
                <button type="button" onClick={() => handleExitScope('scope:selected', selectedVisibleLegs)}
                  className={cn('rounded-lg border px-2.5 py-1 font-mono text-[10px] font-bold transition-all shadow-sm',
                    confirmExitExpiry === 'scope:selected'
                      ? 'border-rose-500 bg-rose-500/25 text-rose-200 animate-pulse'
                      : 'border-rose-800/70 bg-rose-950/80 text-rose-300 hover:bg-rose-900 hover:border-rose-600')}>
                  {confirmExitExpiry === 'scope:selected' ? 'Confirm?' : `Exit Selected (${selectedVisibleLegs.length})`}
                </button>
              )}
            </div>

            {bookExpiries.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-1.5">
                <span className="px-1 text-[9px] font-bold uppercase tracking-widest text-zinc-400">Expiry</span>
                <button type="button" onClick={() => setExpiryFilter('ALL')}
                  className={cn('rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold transition-colors',
                    expiryFilter === 'ALL'
                      ? 'border-sky-500/50 bg-sky-500/20 text-sky-200 shadow-sm'
                      : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200')}>
                  All ({legs.length})
                </button>
                {bookExpiries.map((e) => (
                  <div key={e} className="flex items-center gap-1">
                    <button type="button" onClick={() => setExpiryFilter(e)}
                      className={cn('rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold transition-colors',
                        expiryFilter === e
                          ? 'border-sky-500/50 bg-sky-500/20 text-sky-200 shadow-sm'
                          : 'border-zinc-800 bg-zinc-900/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200')}>
                      {fmtExpiryShort(e)} ({legs.filter((l) => l.expiry === e).length})
                    </button>
                    <button type="button"
                      title={`Exit every ${fmtExpiryShort(e)} leg`}
                      onClick={() => handleExitScope(`expiry:${e}`, legs.filter((l) => l.expiry === e))}
                      className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold transition-colors',
                        confirmExitExpiry === `expiry:${e}`
                          ? 'border-rose-500 bg-rose-500/25 text-rose-200'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-rose-800 hover:text-rose-300')}>
                      {confirmExitExpiry === `expiry:${e}` ? 'Confirm?' : 'Exit'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2.5">
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Booked</div>
                <div className={cn('mt-0.5 font-mono text-sm font-bold tabular-nums', pnlColor(rollup.booked))}>
                  {fmtInr(rollup.booked)}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Unbooked</div>
                <div className={cn('mt-0.5 font-mono text-sm font-bold tabular-nums', pnlColor(rollup.unbooked))}>
                  {fmtInr(rollup.unbooked)}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800/80 border-t-2 border-t-sky-500 bg-zinc-950/60 p-3 shadow-inner">
                <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">Total P&amp;L</div>
                <div className={cn('mt-0.5 font-mono text-sm font-bold tabular-nums', pnlColor(rollup.total))}>
                  {fmtInr(rollup.total)}
                </div>
              </div>
              {rollup.unknown > 0 && (
                <div className="col-span-3 text-[10px] text-amber-400 font-medium">
                  {rollup.unknown} leg(s) have no live price — excluded from unbooked
                </div>
              )}
            </div>

            <AddStrikePicker
              broker={broker} underlying={underlying} strikeStep={strikeStep} spot={spot} lotSize={lotSize}
              onPlaced={(label, orderId) => {
                addToast('success', `${label} placed`, orderId ? `ID: ${orderId}` : undefined);
                setTimeout(loadPositions, 1000);
              }}
              onError={(label, error) => addToast('error', `${label} failed`, error)}
            />

            <DraftStrikeBuilder
              broker={broker} underlying={underlying} strikeStep={strikeStep} spot={spot} lotSize={lotSize}
              chains={chains}
              draftLegs={draftLegs}
              onAddDraft={(leg) => setDraftLegs((prev) => [...prev, leg])}
              onRemoveDraft={(id) => setDraftLegs((prev) => prev.filter((d) => d.id !== id))}
              onClearDrafts={() => setDraftLegs([])}
              onExpirySelected={setDraftBuilderExpiry}
              onPlaceDrafts={handlePlaceDrafts}
              placing={placingDrafts}
              missingStrikesCount={draftMissingStrikes.length}
            />

            {!loadedOnce
              ? <p className="px-3 py-6 text-center text-xs text-zinc-500">Loading positions…</p>
              : <PositionsLegTable
                  legs={visibleLegs} unparseable={unparseable} lotSize={lotSize ?? 0}
                  onClose={handleCloseLeg} closingKeys={closingKeys}
                  onAdd={handleAddToLeg} addingKeys={addingKeys}
                  selectedKeys={selectedKeys} onToggleSelect={toggleSelectLeg} onToggleSelectAll={toggleSelectAllLegs}
                />}
          </section>

          <BookRiskCard
            exposure={exposure} capital={funds} nav={funds} stopMultiple={2} />
          </div>

          {/* ── Right: analytics ────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="flex items-center gap-1 rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-1 backdrop-blur-sm">
              {([['payoff', 'Payoff Graph'], ['greeks', 'Greeks'], ['pnl', 'P&L Table'], ['intraday', 'Intraday (MIS)']] as const).map(([id, label]) => (
                <button key={id} type="button" onClick={() => setTab(id)}
                  className={cn(
                    'rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all',
                    tab === id ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700/50' : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200',
                  )}>
                  {label}
                </button>
              ))}
            </div>

            {/* Combined-book stats. Suppressed on the Intraday tab, which shows its
                own MIS-scoped strip below — otherwise this would sit above an
                intraday-scoped chart while still describing the whole book. */}
            {stats && tab !== 'intraday' && <PayoffMetricStrip
              stats={stats} lotSize={lotSize ?? 0}
              standaloneMargin={standaloneMargin} standaloneMarginReason={standaloneMarginReason}
              marginAvailable={funds} livePnl={rollup.total} usedMargin={usedMargin} spot={spot} />}

            {draftStats && tab !== 'intraday' && (
              <div className="rounded-xl border-l-2 border-violet-600">
                <div className="px-2 pt-2 text-[10px] font-bold uppercase tracking-widest text-violet-400">
                  Preview — Book + Draft
                </div>
                <PayoffMetricStrip
                  stats={draftStats} lotSize={lotSize ?? 0}
                  standaloneMargin={null} standaloneMarginReason="Draft preview — margin not computed"
                  marginAvailable={funds} spot={spot} />
              </div>
            )}

            {tab === 'payoff' && (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
                <PositionsPayoffChart
                  height={440}
                  expiryCurve={expiryCurve}
                  targetCurve={targetCurve}
                  draftCurve={draftCurve}
                  breakevens={stats?.breakevensExpiry ?? []}
                  spot={spot}
                  targetSpot={effectiveTargetSpot}
                  expiryLabel={finalExpiry ? fmtExpiryShort(finalExpiry) : '—'}
                  targetLabel={targetDays === 0 ? 'Today' : `+${targetDays}d`}
                  oiBars={oiBars}
                  showOi={showOi}
                  onToggleOi={() => setShowOi((v) => !v)}
                  onZoomIn={() => setSpanIndex((i) => Math.max(0, i - 1))}
                  onZoomOut={() => setSpanIndex((i) => Math.min(SPAN_STEPS.length - 1, i + 1))}
                  canZoomIn={spanIndex > 0}
                  canZoomOut={spanIndex < SPAN_STEPS.length - 1}
                  ivWarning={ivWarning}
                  emptyReason={
                    !loadedOnce ? 'Loading positions…'
                    : !legs.length ? `No open ${underlying} option positions on ${BROKER_LABELS[broker]}`
                    : !spot ? 'Waiting for spot price from the option chain…'
                    : undefined
                  }
                />

                {expiryCurve.length > 0 && (
                  <div className="mt-3.5 grid grid-cols-1 gap-4 border-t border-zinc-800/80 pt-3.5 md:grid-cols-2 rounded-xl bg-zinc-950/40 p-3.5 shadow-inner">
                    <label className="block">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Target Price</span>
                        <span className="font-mono text-xs font-bold tabular-nums text-sky-300">
                          {Math.round(effectiveTargetSpot).toLocaleString('en-IN')}
                        </span>
                      </div>
                      <input type="range" min={curveLo} max={curveHi} step={strikeStep / 10}
                        value={effectiveTargetSpot}
                        onChange={(e) => setTargetSpot(Number(e.target.value))}
                        className="mt-1.5 w-full accent-sky-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer" />
                    </label>

                    <label className="block">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[9.5px] font-bold uppercase tracking-wider text-zinc-400">Days to Target</span>
                        <span className="font-mono text-xs font-bold tabular-nums text-sky-300">
                          {targetDays}d / {maxTargetDays}d to expiry
                        </span>
                      </div>
                      <input type="range" min={0} max={Math.max(1, maxTargetDays)} step={1}
                        value={targetDays} disabled={maxTargetDays === 0}
                        onChange={(e) => setTargetDays(Number(e.target.value))}
                        className="mt-1.5 w-full accent-sky-500 h-1.5 bg-zinc-800 rounded-lg cursor-pointer disabled:opacity-30" />
                    </label>

                    <div className="md:col-span-2 flex flex-wrap items-center gap-x-6 gap-y-1.5 font-mono text-xs tabular-nums border-t border-zinc-850/60 pt-2.5">
                      <span className="text-zinc-400">
                        At expiry @ {Math.round(effectiveTargetSpot).toLocaleString('en-IN')}:{' '}
                        <strong className={projected !== null ? pnlColor(projected) : 'text-zinc-400'}>
                          {projected === null ? '—' : fmtInr(projected)}
                        </strong>
                      </span>
                      {projectedTarget !== null && (
                        <span className="text-zinc-400">
                          In {targetDays}d:{' '}
                          <strong className={pnlColor(projectedTarget)}>{fmtInr(projectedTarget)}</strong>
                        </span>
                      )}
                      <span className="text-zinc-400">
                        Live P&amp;L: <strong className={pnlColor(rollup.total)}>{fmtInr(rollup.total)}</strong>
                      </span>
                      <span className="text-zinc-500 font-semibold ml-auto">
                        Range ±{(spanPct * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'greeks' && (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
                <GreeksTab legs={pricedLegs} lotSize={lotSize ?? 0} spot={spot} />
              </div>
            )}

            {tab === 'pnl' && (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
                <PnlTableTab legs={pricedLegs} spot={spot} strikeStep={strikeStep} expiry={finalExpiry ?? ''} />
              </div>
            )}

            {tab === 'intraday' && (
              <div className="space-y-4">
                <div className="space-y-3.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
                  <AddStrikePicker
                    broker={broker} underlying={underlying} strikeStep={strikeStep} spot={spot} lotSize={lotSize}
                    onPlaced={(label, orderId) => {
                      addToast('success', `${label} placed`, orderId ? `ID: ${orderId}` : undefined);
                      setTimeout(loadPositions, 1000);
                    }}
                    onError={(label, error) => addToast('error', `${label} failed`, error)}
                  />
                  <PositionsLegTable
                    legs={intradayLegs} unparseable={[]} lotSize={lotSize ?? 0}
                    onClose={handleCloseLeg} closingKeys={closingKeys}
                    onAdd={handleAddToLeg} addingKeys={addingKeys}
                  />
                </div>

                {intradayStats && <PayoffMetricStrip
                  stats={intradayStats} lotSize={lotSize ?? 0}
                  standaloneMargin={null} standaloneMarginReason="Margin sizing shown only on the combined view"
                  marginAvailable={funds} livePnl={intradayRollup.total} usedMargin={usedMargin} spot={spot} />}

                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 backdrop-blur-md shadow-sm">
                  <PositionsPayoffChart
                    height={440}
                    expiryCurve={intradayCurve}
                    targetCurve={null}
                    breakevens={intradayStats?.breakevensExpiry ?? []}
                    spot={spot}
                    targetSpot={spot}
                    expiryLabel={intradayFinalExpiry ? fmtExpiryShort(intradayFinalExpiry) : '—'}
                    targetLabel="Today"
                    oiBars={oiBars}
                    showOi={showOi}
                    onToggleOi={() => setShowOi((v) => !v)}
                    onZoomIn={() => setSpanIndex((i) => Math.max(0, i - 1))}
                    onZoomOut={() => setSpanIndex((i) => Math.min(SPAN_STEPS.length - 1, i + 1))}
                    canZoomIn={spanIndex > 0}
                    canZoomOut={spanIndex < SPAN_STEPS.length - 1}
                    emptyReason={
                      !loadedOnce ? 'Loading positions…'
                      : !intradayLegs.length ? 'No intraday (MIS) positions open'
                      : !spot ? 'Waiting for spot price from the option chain…'
                      : undefined
                    }
                  />
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      <AnalyzeModal
        open={showAnalyzeModal}
        onClose={() => setShowAnalyzeModal(false)}
        loading={analyzing}
        error={analyzeError}
        summary={analyzeSummary}
        suggestions={suggestions.filter((s) => !dismissedSuggestionIds.has(s.id))}
        legs={legs}
        closingKeys={closingKeys}
        legKeyOf={legKey}
        onConfirm={handleCloseLeg}
        onDismiss={(id) => setDismissedSuggestionIds((prev) => new Set(prev).add(id))}
      />

      {/* Order-result toasts (leg exit/adjust) */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-md',
                t.type === 'success'
                  ? 'border-emerald-700 bg-emerald-950/90 text-emerald-200'
                  : 'border-rose-700 bg-rose-950/90 text-rose-200',
              )}>
              <div className="font-bold">{t.message}</div>
              {t.detail && <div className="mt-0.5 text-[11px] opacity-80">{t.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
