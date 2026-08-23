'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import NavBar from './NavBar';
import { Zap, RefreshCw, Shield, ShieldOff, Plus, Scissors } from 'lucide-react';
import {
  OptionPanel, PositionsTable, TabTable, FundsView, pollPositionFlat, pollPositionReduced,
  type ChainOcEntry, type Toast,
  type PnlGuardStatus, type PositionGuard, type SortState,
  FOCUS_RING, TXT_LABEL, TXT_VALUE, TXT_CAPTION, RiskRail,
} from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useProfitLock, ProfitLockControls } from './ProfitLock';
import { useCopyTrade, CopyTradeControls } from './CopyTrade';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import { contractMultiplier, scaleBrokerPnl } from '@/lib/positionPnl';
import { openLots, fractionUnits } from '@/lib/partialQty';
import { positionKey, positionProduct, findLivePosition, closeOrderProduct } from '@/lib/positionProduct';
import { cn } from '@/lib/utils';
import TopWeightStocks from './TopWeightStocks';
import TopIndices from './TopIndices';
import MtmChart, { useMtmHistory } from './MtmChart';

// ─── Types ────────────────────────────────────────────────────────

interface BoxConfig {
  id: string;
  side: 'CE' | 'PE';
  strike: number | null;
  lots: number;
  limitPrice: string;
  /** Fraction of the open position the shift chevrons roll. Absent ⇒ 'FULL' (legacy behaviour). */
  moveFraction?: 'HALF' | 'FULL';
}

const MIN_BOXES = 2;
const MAX_BOXES = 5;

/** One leg of the "close 50% of everything" plan. */
interface HalfLeg {
  pos: Record<string, unknown>;
  sym: string;
  /** Absolute units to close — already rounded down to whole lots. */
  units: number;
  lots: number;
}

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const STRIKE_STEP: Record<string, number> = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 };

/**
 * True for index/stock F&O segments across all three brokers (Dhan NSE_FNO /
 * BSE_FNO, Zerodha NFO / BFO, Kotak nse_fo / bse_fo).
 *
 * MCX is excluded explicitly: Kotak spells its commodity segment `mcx_fo`, which
 * a bare "contains FO" test accepts, and a CRUDEOIL leg has no business being
 * summed into an index terminal's CE/PE values or its premium-decay basis.
 */
function isFnoSegment(pos: Record<string, unknown>): boolean {
  const seg = String(pos.exchangeSegment ?? pos.exchange ?? '').toUpperCase();
  if (seg.startsWith('MCX')) return false;
  return seg.includes('FNO') || seg.includes('FO');
}

// ─── Main Component ───────────────────────────────────────────────

export default function AdvancedScalper() {
  // Underlying
  const [underlying, setUnderlying] = useState<typeof UNDERLYINGS[number]>('NIFTY');
  const strikeStep = STRIKE_STEP[underlying] ?? 50;

  // Expiry
  const [expiries, setExpiries]   = useState<string[]>([]);
  const [expiry, setExpiry]       = useState('');

  // Chain data (one-time fetch per expiry for prev close + strike list)
  const [allStrikes, setAllStrikes]     = useState<number[]>([]);
  const [prevClose, setPrevClose]       = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]       = useState(0);
  const [prevSpot, setPrevSpot]         = useState(0);

  // Security ID map per strike — enables fast-order (no Python per order)
  const [strikeMap, setStrikeMap]   = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  // null until the lookup resolves it from DhanHelper.get_lot_size(). Never seed
  // this with a literal: exchange lot sizes get revised (NIFTY has been 75 and is
  // 65 today), and a seeded value is indistinguishable from a resolved one — it
  // would size real orders and partial-close chips against a stale number, and
  // would carry the previous underlying's lot across a NIFTY→SENSEX switch.
  const [lotSize, setLotSize]       = useState<number | null>(null);

  // Orders in flight, keyed by box id — blocks double-fire and gates the Buy/Sell
  // buttons until strikeMap is loaded (avoids a silent fallback to the slow
  // Python order path right after an expiry switch).
  const [orderPendingBoxes, setOrderPendingBoxes] = useState<Set<string>>(new Set());
  const orderInFlightRef = useRef<Set<string>>(new Set());

  // Live data: direct WebSocket to the Python bridge (HTTP polling fallback)
  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);

  // Trading controls
  const [orderMode, setOrderMode] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [productType, setProductType] = useState<'INTRADAY' | 'MARGIN'>('INTRADAY');

  // Top-10-by-weight stocks panel. Off by default so no equity bridge is
  // spawned unless it's actually wanted.
  const [showTop10, setShowTop10] = useState(false);
  const boxCounterRef = useRef(2);
  const [boxes, setBoxes] = useState<BoxConfig[]>([
    { id: 'box-1', side: 'CE', strike: null, lots: 1, limitPrice: '' },
    { id: 'box-2', side: 'PE', strike: null, lots: 1, limitPrice: '' },
  ]);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Exit-all confirm-arm
  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);

  // Halve-all confirm-arm (close 50% of every open leg)
  const [confirmHalfAll, setConfirmHalfAll] = useState(false);
  const [halvingAll, setHalvingAll] = useState(false);
  // The exact plan the user armed. The live plan is recomputed on every
  // positions poll, so without this the second click would fire a different
  // set of orders than the first click previewed.
  const armedHalfPlanRef = useRef<{ legs: HalfLeg[]; skipped: string[] } | null>(null);

  // Bottom tabs
  const [activeTab, setActiveTab]       = useState<'positions' | 'orders' | 'trades' | 'funds' | 'mtm'>('positions');
  const [positionsData, setPositionsData] = useState<Record<string, unknown>[]>([]);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [ordersData, setOrdersData]       = useState<Record<string, unknown>[]>([]);
  const [tradesData, setTradesData]       = useState<Record<string, unknown>[]>([]);
  const [fundsData, setFundsData]         = useState<Record<string, any> | null>(null);
  const [tabLoading, setTabLoading]       = useState(false);
  const [tableSort, setTableSort] = useState<SortState>({ key: 'none', dir: 'asc' });
  const handleTableSort = useCallback((key: string) => {
    setTableSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
  }, []);

  // P&L Guard
  const [pnlGuardStatus, setPnlGuardStatus]   = useState<PnlGuardStatus | null>(null);
  const [profitTarget, setProfitTarget]       = useState('');
  const [lossLimit, setLossLimit]             = useState('');
  const [guardProductTypes, setGuardProductTypes] = useState<string[]>(['INTRADAY']);
  const [enableKillSwitch, setEnableKillSwitch]   = useState(false);
  const [settingPnl, setSettingPnl]     = useState(false);
  const [clearingPnl, setClearingPnl]   = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [guardError, setGuardError]     = useState('');

  // Per-position guards (target / SL / trailing SL).
  // Keyed by lib/positionProduct's `positionKey` — (symbol, product), not symbol
  // alone: the same strike can be open under both INTRADAY and MARGIN, and those
  // are two positions that must be guarded and closed independently.
  const [posGuards, setPosGuards] = useState<Record<string, PositionGuard>>({});
  const [closingPositions, setClosingPositions] = useState<Set<string>>(new Set());

  const positionsRef = useRef<Record<string, unknown>[]>([]);
  const posGuardsRef = useRef<Record<string, PositionGuard>>({});
  // Synchronous re-entrancy lock: React state updates are async, so the guard
  // loop and a manual Close click can both enter closePosition before either
  // sees the other's `triggered`/`closingPositions` update.
  const closingInFlightRef = useRef<Set<string>>(new Set());
  const expiryRef = useRef('');
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);

  // NOTE: a position never gets a target or SL on its own. Every level in
  // `posGuards` is one the user typed or clicked onto that specific row.
  //
  // There used to be an "⚡ Auto-Apply" mode here that stamped a default target
  // (+10%) and SL (-5%) onto every newly opened leg, configured by a PRESETS bar
  // in the header. Both are gone. The flag was persisted in localStorage, so
  // enabling it once silently armed auto-exits on every position in every later
  // session — including on positions opened by something other than this page —
  // with nothing on screen to explain where the levels came from. Per-row levels
  // are still available on demand from the Target/SL inputs and the ±% chips in
  // the Positions table; they just have to be asked for.
  //
  // Any `autoApplyGuards` / `defaultTargetVal` / `defaultSlVal` / `presetMode`
  // keys left in a browser's stored blob are simply ignored and dropped on the
  // next write below.

  // Combined Multi-Leg % Presets state (remembers selection even when flat).
  // Unrelated to the removed per-position defaults: these size the ACCOUNT-level
  // Dhan P&L Guard and never write to a position's own target/SL.
  const [combinedTargetPct, setCombinedTargetPct] = useState<number | null>(null);
  const [combinedSlPct, setCombinedSlPct] = useState<number | null>(null);

  // Load preset preferences from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('advanced_scalper_presets');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.combinedTargetPct !== undefined) setCombinedTargetPct(parsed.combinedTargetPct);
        if (parsed.combinedSlPct !== undefined) setCombinedSlPct(parsed.combinedSlPct);
      }
    } catch {}
  }, []);

  // Save preset preferences to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('advanced_scalper_presets', JSON.stringify({
        combinedTargetPct, combinedSlPct,
      }));
    } catch {}
  }, [combinedTargetPct, combinedSlPct]);

  // ─── Derived values ──────────────────────────────────────────────

  const spot = liveQuotes?.spot ?? chainSpot;
  const atm  = spot > 0 ? Math.round(spot / strikeStep) * strikeStep : 0;

  const visibleStrikes = useMemo(() => {
    if (!allStrikes.length) return allStrikes;
    if (atm === 0) return allStrikes.slice(0, 21);
    const idx = allStrikes.reduce((best, sk, i) =>
      Math.abs(sk - atm) < Math.abs(allStrikes[best] - atm) ? i : best, 0);
    return allStrikes.slice(Math.max(0, idx - 10), idx + 11);
  }, [allStrikes, atm]);

  // True once the lookup for the current expiry has returned security IDs —
  // gates ordering so a click can never silently fall back to the slow
  // Python order path (strikeMap is reset to {} on every expiry change).
  const strikesReady = Object.keys(strikeMap).length > 0;

  const secIdToStrikeSide = useMemo(() => {
    const map: Record<string, { strike: number; side: 'ce' | 'pe' }> = {};
    for (const [strike, ids] of Object.entries(strikeMap)) {
      // Dhan is the only broker with a numeric securityId; everything else
      // joins on the trading symbol.
      if (broker !== 'dhan') {
        if (ids.ceSymbol) map[ids.ceSymbol] = { strike: Number(strike), side: 'ce' };
        if (ids.peSymbol) map[ids.peSymbol] = { strike: Number(strike), side: 'pe' };
      } else {
        if (ids.ceId) map[ids.ceId] = { strike: Number(strike), side: 'ce' };
        if (ids.peId) map[ids.peId] = { strike: Number(strike), side: 'pe' };
      }
    }
    return map;
  }, [strikeMap, broker]);

  const positionJoinKey = useCallback((pos: Record<string, unknown>): string => {
    return broker !== 'dhan'
      ? String(pos.tradingSymbol ?? '')
      : String(pos.securityId ?? (pos as Record<string, unknown>).security_id ?? '');
  }, [broker]);

  /**
   * CE / PE for an option leg, or null if the row is not an option this terminal
   * should be aggregating. Single source of truth for every per-side sum below,
   * so the CE/PE pill and the multi-leg banner can never disagree about what
   * counts as a leg.
   *
   * The F&O segment test runs FIRST, before the strike map: security IDs are only
   * unique within a segment, so an equity ID could in principle collide with an
   * option ID and mark a stock holding as a call.
   *
   * Resolution order after that, most to least authoritative:
   *   1. strikeMap  — exact, but only covers the currently selected expiry.
   *   2. optionType — present on Dhan rows (`drvOptionType`), absent on the
   *                   Zerodha/Kotak shapes, which drop it entirely.
   *   3. symbol suffix — the fallback that actually carries legs on OTHER
   *      expiries. It matches a bare trailing CE/PE (`NIFTY25AUG24500CE`) as
   *      well as a delimited one (`NIFTY-Aug2026-24500-CE`); the previous
   *      `/\bCE\b|-CE$/` required a word boundary before the C, which a digit
   *      never provides, so every Zerodha and Kotak leg outside the selected
   *      expiry was silently dropped from the CE/PE totals.
   */
  const optionSideOf = useCallback((pos: Record<string, unknown>): 'CE' | 'PE' | null => {
    if (!isFnoSegment(pos)) return null;

    const mapping = secIdToStrikeSide[positionJoinKey(pos)];
    if (mapping) return mapping.side.toUpperCase() as 'CE' | 'PE';

    const optType = String(pos.optionType ?? pos.option_type ?? pos.drvOptionType ?? '').toUpperCase();
    if (optType.includes('CALL') || optType === 'CE') return 'CE';
    if (optType.includes('PUT') || optType === 'PE') return 'PE';

    const sym = String(pos.tradingSymbol ?? pos.tradingsymbol ?? pos.symbol ?? '').toUpperCase();
    if (/CE$/.test(sym)) return 'CE';
    if (/PE$/.test(sym)) return 'PE';
    return null;
  }, [secIdToStrikeSide, positionJoinKey]);

  // Same realizedProfit=0-on-flat-position fix as the base Scalper (Dhan quirk, see Scalper.tsx)
  const realizedFixedPositions = useMemo(() => {
    return positionsData.map(pos => {
      const netQty = Number(pos.netQty);
      const mult  = contractMultiplier(pos);

      // Dhan reports MCX P&L unscaled by barrels-per-lot (see scaleBrokerPnl). Rescale before
      // anything below reads it - the LTP back-calculation divides by that same multiplier, so
      // an unscaled figure derives an LTP a hundredth of the way back from the entry price.
      const row = scaleBrokerPnl(pos, mult);

      // ── LTP fallback: Dhan's /positions v2 API omits lastTradedPrice.
      // Back-calculate from unrealizedProfit so the table shows a value
      // even before the live WS bridge enriches the row, and for positions
      // on expiries / segments the bridge isn't watching (monthly options,
      // equities, Kotak positions with ltp=0 from their API).
      const brokerLtp = Number(row.lastTradedPrice);
      let withLtp: typeof pos = row;
      if ((!brokerLtp || !Number.isFinite(brokerLtp)) && netQty !== 0) {
        const unrealized = Number(row.unrealizedProfit);
        const buyAvg     = Number(row.buyAvg);
        const sellAvg    = Number(row.sellAvg);
        if (Number.isFinite(unrealized) && mult > 0) {
          const derivedLtp = netQty > 0
            ? buyAvg  + unrealized / (netQty  * mult)
            : sellAvg - unrealized / (Math.abs(netQty) * mult);
          if (Number.isFinite(derivedLtp) && derivedLtp > 0) {
            withLtp = { ...row, lastTradedPrice: derivedLtp };
          }
        }
      }

      // ── realizedProfit=0-on-flat-position fix
      if (netQty !== 0) return withLtp;

      const buyQty  = Number(pos.buyQty);
      const sellQty = Number(pos.sellQty);
      const buyAvgF = Number(pos.buyAvg);
      const sellAvgF = Number(pos.sellAvg);
      if (!buyQty || !sellQty) return withLtp;

      const recomputedRealized = mult * (sellQty * sellAvgF - buyQty * buyAvgF);
      if (Number(row.realizedProfit) === recomputedRealized) return withLtp;

      return { ...withLtp, realizedProfit: recomputedRealized };
    });
  }, [positionsData]);

  const enrichedPositions = useMemo(() => {
    if (!liveQuotes?.strikes || Object.keys(secIdToStrikeSide).length === 0)
      return realizedFixedPositions;

    return realizedFixedPositions.map(pos => {
      const secId = positionJoinKey(pos);
      const mapping = secIdToStrikeSide[secId];
      if (!mapping) return pos;

      const strikeData = liveQuotes.strikes[String(mapping.strike)];
      if (!strikeData) return pos;

      const liveLtp = strikeData[mapping.side]?.ltp ?? 0;
      if (liveLtp <= 0) return pos;

      const netQty = Number(pos.netQty);
      const buyAvg = Number(pos.buyAvg);
      const sellAvg = Number(pos.sellAvg);
      const mult = contractMultiplier(pos);
      const unrealizedProfit = netQty === 0
        ? Number(pos.unrealizedProfit)
        : netQty > 0
          ? mult * netQty * (liveLtp - buyAvg)
          : mult * Math.abs(netQty) * (sellAvg - liveLtp);

      return { ...pos, lastTradedPrice: liveLtp, unrealizedProfit };
    });
  }, [realizedFixedPositions, liveQuotes, secIdToStrikeSide, positionJoinKey]);

  const totalPnl = useMemo(() => enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.realizedProfit) || 0) + (Number(p.unrealizedProfit) || 0), 0),
    [enrichedPositions]);

  const totalUnrealizedPnl = useMemo(() => enrichedPositions.reduce((sum, p) =>
    sum + (Number(p.unrealizedProfit) || 0), 0),
    [enrichedPositions]);

  // Anchored on the trade book's own realized total, not totalPnl — see useMtmHistory for why.
  const { data: mtmHistory, stats: mtmStats, source: mtmSource } = useMtmHistory(broker, tradesData, totalUnrealizedPnl);

  // Combined Multi-Leg Premium Tracking & Strategy Stats
  const combinedStrategyStats = useMemo(() => {
    let openLegsCount = 0;

    // Signed, so a hedge nets off: short legs count +credit, long legs -debit.
    // Summing both sides gross would make a long hedge appreciating LOOK like lost
    // decay even though it is profit, and would size the combined % target off
    // (credit + debit) instead of the net credit actually at risk.
    let signedEntry = 0;
    let signedLive = 0;

    for (const pos of enrichedPositions) {
      const netQty = Number(pos.netQty);
      if (netQty === 0) continue;

      // Option legs only. Without this the basis picked up equity holdings, MCX
      // futures and anything else open in the account — which not only inflated
      // the banner's leg count and entry capital, but sized the ₹ figure the
      // Combined % chips push into the P&L Guard off positions this terminal is
      // not trading. "Premium decay" is an options statement; keep the basis to
      // instruments the statement is true of.
      if (!optionSideOf(pos)) continue;

      const mult = contractMultiplier(pos);
      const isLong = netQty > 0;
      const entryPrice = isLong ? Number(pos.buyAvg) : Number(pos.sellAvg);
      const liveLtp = Number(pos.lastTradedPrice) || entryPrice;
      const absQty = Math.abs(netQty);

      if (entryPrice > 0 && mult > 0) {
        const sign = isLong ? -1 : 1;
        signedEntry += sign * entryPrice * absQty * mult;
        signedLive += sign * liveLtp * absQty * mult;
        openLegsCount += 1;
      }
    }

    // Basis = the net credit received (seller) or net debit paid (buyer).
    const entryCapitalSum = Math.abs(signedEntry);
    // Measured in the SAME direction as the entry basis rather than as a bare
    // magnitude, so a credit book that flips to a net debit reads as a negative
    // current value instead of an unsigned number that looks unchanged.
    const liveCapitalSum = signedEntry < 0 ? -signedLive : signedLive;

    // MIN_BASIS, not > 0: a near-perfectly-hedged book (short and long legs almost
    // cancelling) leaves a basis of a few paise, which would divide into a decayPct
    // in the thousands of percent and a combined % target of ~₹0. Below a rupee the
    // ratio is meaningless, so report it as unmeasurable rather than as a huge number.
    const MIN_BASIS = 1;
    if (openLegsCount === 0 || entryCapitalSum < MIN_BASIS) {
      return { entryCapitalSum: 0, liveCapitalSum: 0, decayPct: 0, openLegsCount, isNetSeller: true };
    }

    // signedEntry - signedLive is profit for BOTH directions: a short decaying
    // 100 -> 60 gives +40, a long appreciating 100 -> 140 also gives +40.
    const decayPct = ((signedEntry - signedLive) / entryCapitalSum) * 100;
    const isNetSeller = signedEntry > 0;

    return { entryCapitalSum, liveCapitalSum, decayPct, openLegsCount, isNetSeller };
  }, [enrichedPositions, optionSideOf]);

  // Net CE / PE Values & Difference computed strictly from OPEN POSITIONS: short legs add,
  // long legs (hedges) subtract, per side — so a long hedge offsets the shorts on its side
  // instead of inflating the gross total the same way a short would.
  const { totalCEVal, totalPEVal, cePeDiff, peCeRatio } = useMemo(() => {
    let ceSum = 0;
    let peSum = 0;

    for (const pos of enrichedPositions) {
      const netQty = Number(pos.netQty);
      if (!netQty || netQty === 0) continue; // Only open positions

      // Equity trading symbols can coincidentally end in "CE"/"PE" (e.g. "RELIANCE"),
      // which is why optionSideOf gates on the F&O segment before it ever looks
      // at a symbol suffix.
      const side = optionSideOf(pos);
      if (!side) continue;

      // Mark against the price on the leg's OWN side when there is no live LTP.
      // Falling through buyAvg first marked a partially-covered short at its
      // COVER price — the one price on the row that says nothing about what the
      // remaining open quantity is worth.
      const ltp = Number(pos.lastTradedPrice)
        || (netQty > 0 ? Number(pos.buyAvg) : Number(pos.sellAvg))
        || Number(pos.buyAvg) || Number(pos.sellAvg) || 0;
      // netQty is already a total unit count, so qty * price is rupees directly.
      // Dividing by the selected underlying's `lotSize` would misprice any position
      // on a different underlying (e.g. an open SENSEX leg while NIFTY is selected).
      // Net a long leg against the shorts on the same side (e.g. a far-OTM long
      // hedge sitting alongside short strikes) rather than adding both as gross —
      // otherwise a hedge leg inflates CE/PE Val the same way a short does.
      const val = Math.abs(netQty) * ltp * contractMultiplier(pos);
      const signedVal = netQty > 0 ? -val : val;

      if (side === 'CE') ceSum += signedVal;
      else if (side === 'PE') peSum += signedVal;
    }

    return {
      totalCEVal: ceSum,
      totalPEVal: peSum,
      cePeDiff: ceSum - peSum,
      // Scale-free version of the same skew: the rupee Diff says how far apart the
      // sides are, the ratio says how lopsided they are relative to book size.
      // Both sums are SIGNED (a net-long side goes negative), so the ratio is only
      // meaningful when the denominator is a real CE exposure — null renders a dash
      // instead of Infinity/NaN when the CE side is flat or fully hedged out.
      peCeRatio: Math.abs(ceSum) > 0.01 ? peSum / ceSum : null,
    };
  }, [enrichedPositions, optionSideOf]);

  // Auto-calculate P&L Guard Target & SL ₹ when combinedTargetPct or combinedSlPct are selected
  // Only writes while a % chip is actively selected — deselecting a chip (click it
  // again) hands the field back to manual entry. Values are compared before being
  // set so an unchanged basis never clobbers what the user is currently typing.
  //
  // A zero basis BLANKS the field rather than leaving it alone. Returning early on
  // `entryCapitalSum <= 0` (the old behaviour) meant that squaring off left the
  // rupee amount from the position you just closed sitting in the box, with its %
  // chip still lit: open a smaller position, hit Set Guard, and you armed the
  // broker at the previous trade's size. There is nothing to size against when
  // flat, so the honest value is empty.
  useEffect(() => {
    const basis = combinedStrategyStats.entryCapitalSum;
    const rupeesFor = (pct: number): string => {
      if (basis <= 0) return '';
      const v = Math.round((basis * pct) / 100);
      return v > 0 ? String(v) : '';
    };

    if (combinedTargetPct !== null && combinedTargetPct > 0) {
      const next = rupeesFor(combinedTargetPct);
      setProfitTarget(prev => (prev === next ? prev : next));
    }

    if (combinedSlPct !== null && combinedSlPct > 0) {
      const next = rupeesFor(combinedSlPct);
      setLossLimit(prev => (prev === next ? prev : next));
    }
  }, [combinedStrategyStats.entryCapitalSum, combinedTargetPct, combinedSlPct]);

  // Dhan's pnlExit guard only squares off the product types it was configured
  // with, and the INTRADAY/MARGIN toggle that decides how orders are placed was
  // entirely separate state from the guard's product chips. Trading MARGIN while
  // the guard defaulted to INTRADAY armed a guard that would not touch a single
  // one of your positions — silently, with an ACTIVE badge showing.
  //
  // Additive only: switching the toggle puts the product you are about to trade
  // in scope and never removes a chip you selected deliberately. Done here in the
  // handler rather than in an effect on `productType` so there is no intermediate
  // render where the two disagree.
  const handleProductTypeChange = useCallback((pt: 'INTRADAY' | 'MARGIN') => {
    setProductType(pt);
    setGuardProductTypes(prev => (prev.includes(pt) ? prev : [...prev, pt]));
  }, []);

  // Products that are open at the broker RIGHT NOW but outside the guard's scope.
  // The handler above covers what you are about to trade; this covers what you
  // already hold — including legs opened before the guard chips were changed, and
  // anything carried in from another terminal or a strategy process.
  // Dhan-only, matching where the guard controls render: the other brokers report
  // Kite/Neo product names (MIS/NRML) that this vocabulary does not describe.
  const uncoveredGuardProducts = useMemo(() => {
    if (broker !== 'dhan') return [];
    const out = new Set<string>();
    for (const pos of enrichedPositions) {
      if (Number(pos.netQty) === 0) continue;
      const pt = String(pos.productType ?? '').toUpperCase();
      if (pt && !guardProductTypes.includes(pt)) out.add(pt);
    }
    return [...out];
  }, [enrichedPositions, guardProductTypes, broker]);

  // Position row keyed by security ID — lets each box look up its own open position/P&L
  const positionsBySecId = useMemo(() => {
    const map: Record<string, Record<string, unknown>> = {};
    for (const pos of enrichedPositions) {
      const secId = positionJoinKey(pos);
      if (secId) map[secId] = pos;
    }
    return map;
  }, [enrichedPositions, positionJoinKey]);


  const boxSecId = useCallback((box: BoxConfig): string | undefined => {
    if (box.strike == null) return undefined;
    const entry = strikeMap[String(box.strike)];
    return broker !== 'dhan'
      ? entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol']
      : entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
  }, [strikeMap, broker]);

  // ─── useEffect 1: Load expiries based on broker + underlying ───────

  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        const data = j.data;
        if (j.success && data?.length) {
          setExpiries(data);
          setExpiry(prev => data.includes(prev) ? prev : data[0]);
        }
      })
      .catch(() => {});
  }, [broker, underlying]);

  // ─── useEffect 1a: Load prev-close whenever underlying changes ────

  useEffect(() => {
    fetch(`/api/scalper/nifty-prev-close?underlying=${underlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; prevClose?: number }) => {
        if (j.success && j.prevClose) setPrevSpot(j.prevClose);
      })
      .catch(() => {});
  }, [underlying]);

  // ─── useEffect 1b: Load mount data ───────────────────────────────

  useEffect(() => {
    fetch('/api/pnl-exit')
      .then(r => r.json())
      .then((j: { success: boolean; data?: PnlGuardStatus }) => {
        if (j.success && j.data) setPnlGuardStatus(j.data as PnlGuardStatus);
      })
      .catch(() => {});
  }, []);

  // ─── useEffect 2a: On expiry/underlying change — reset selections ──

  // Keyed on the CONTRACT SET only, deliberately not on `broker`: the same
  // contracts exist at every broker, so switching the selector must never move
  // a box that has an open leg sitting on its strike.
  useEffect(() => {
    if (!expiry) return;

    // Reset strike selections when expiry/underlying changes; lots/side presets
    // are preserved. chainSpot must be cleared too — NIFTY and SENSEX spot
    // values differ by ~3x magnitude, so leaving the old value in place would
    // briefly show e.g. "SENSEX 25453" (new underlying's label, old
    // underlying's spot) until the chain fetch below resolves.
    setBoxes(prev => prev.map(b => ({ ...b, strike: null })));
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});   // liveQuotes reset is handled inside useLiveOptionsWS
    setChainSpot(0);
    // Lot size belongs to the OUTGOING underlying (NIFTY 65 vs SENSEX 20). Keeping
    // it would size the first order after a switch against the wrong contract.
    setLotSize(null);
  }, [expiry, underlying]);

  // ─── useEffect 2b: Fetch the chain (strike ladder + prev close) ────

  // Broker-scoped, so it must re-run on a broker switch: /api/options/chain
  // serves Dhan from the live option-chain API and the others from their own
  // instrument cache (and 400s on unsupported broker/underlying pairs). Leaving
  // `broker` out left the ladder and prev-close on the previous broker's data
  // while the strikeMap effect below had already re-resolved for the new one.
  useEffect(() => {
    if (!expiry) return;

    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        const pc: Record<string, { ce: number; pe: number }> = {};
        for (const [sk, entry] of Object.entries(oc)) {
          // Dhan keys the chain by a 6-decimal float string ("23950.000000")
          // but every read below keys by the plain integer strike, so normalise
          // or the prev-close fallback silently never hits.
          pc[String(Number(sk))] = {
            ce: entry.ce?.previous_close_price ?? entry.ce?.previous_close ?? 0,
            pe: entry.pe?.previous_close_price ?? entry.pe?.previous_close ?? 0,
          };
        }
        setPrevClose(pc);

        const spotPrice = j.data.spot ?? 0;
        if (spotPrice > 0) setChainSpot(spotPrice);

        // Default only the boxes that have no strike yet (i.e. right after the
        // reset above) to ATM. A plain re-fetch — which a broker switch now
        // triggers — must leave existing selections alone, or a box holding an
        // open leg would silently jump to ATM and stop showing that position.
        if (strikes.length) {
          const atmTarget = spotPrice > 0 ? Math.round(spotPrice / strikeStep) * strikeStep : 0;
          const nearest = atmTarget > 0
            ? strikes.reduce((prev, cur) => Math.abs(cur - atmTarget) < Math.abs(prev - atmTarget) ? cur : prev)
            : strikes[Math.floor(strikes.length / 2)];
          setBoxes(prev => prev.some(b => b.strike == null)
            ? prev.map(b => (b.strike == null ? { ...b, strike: nearest } : b))
            : prev);
        }
      })
      .catch(() => {});
  }, [expiry, underlying, broker, strikeStep]);

  // ─── useEffect 2c: WS bridge lifecycle ────────────────────────────

  useEffect(() => {
    if (!expiry) return;

    // Start a WS bridge for every authenticated broker concurrently — each
    // runs independently on its own port/files (see useLiveOptionsWS), so
    // switching the broker selector never spawns or kills a process. That is
    // also why `broker` is not a dependency here.
    for (const b of authenticatedBrokers) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    // Cleanup: stop every started bridge when expiry/underlying changes or component unmounts
    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, authenticatedBrokers]);

  // Start the shared Nifty-50 equity bridge when the Top 10 panel is switched
  // on. The route is idempotent — it returns "Bridge already running" without
  // spawning when a live PID exists — so this is safe to fire on every enable.
  //
  // Deliberately NO stop on toggle-off or unmount, unlike the options bridges
  // above: this same process feeds the Live Dashboard page via the same route,
  // so killing it here would silently break that page. Hiding the panel stops
  // its polling; the bridge stays up and remains stoppable from Live Dashboard.
  useEffect(() => {
    if (!showTop10) return;
    fetch('/api/live-equity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    }).catch(() => {});
  }, [showTop10]);

  // Re-resolves strikeMap (Dhan securityId / Zerodha tradingsymbol per strike)
  // whenever the expiry OR the selected broker changes. Order routing is
  // still broker-specific — only the live-quotes WS bridges (started above)
  // run concurrently for both brokers regardless of selection.
  useEffect(() => {
    if (!expiry) return;

    const requestedExpiry = expiry;
    const lookupUrl = `${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }> } }) => {
        if (requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          // Only accept a usable lot size. Leaving it null keeps every
          // sizing-dependent control disabled rather than trading on a bad value.
          setLotSize(Number(j.data.lotSize) > 0 ? Number(j.data.lotSize) : null);
        }
      })
      .catch(() => {});
  }, [expiry, broker, underlying]);

  // Live quotes arrive via useLiveOptionsWS (direct WebSocket push from the
  // Python bridge, rAF-coalesced; falls back to 100ms HTTP polling if the WS
  // is unavailable). The old useEffect-3 poll loop lived here.

  // ─── useEffect 4: Poll positions/orders/trades every 5s ──────────

  const fetchTabData = useCallback(() => {
    setTabLoading(true);
    fetch(scalperRoute(broker, 'all'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; positionsError?: string | null; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[]; funds?: Record<string, any>; pnl_guard?: any }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setPositionsError(j.positionsError ?? null);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
          setFundsData(j.funds ?? null);
          setPnlGuardStatus(j.pnl_guard ?? null);
        }
      })
      .catch(() => {})
      .finally(() => setTabLoading(false));
  }, [broker]);

  const pollTabData = useCallback(() => {
    fetch(scalperRoute(broker, 'poll'))
      .then(r => r.json())
      .then((j: { success: boolean; positions?: Record<string, unknown>[]; positionsError?: string | null; orders?: Record<string, unknown>[]; trades?: Record<string, unknown>[] }) => {
        if (j.success) {
          setPositionsData(j.positions ?? []);
          setPositionsError(j.positionsError ?? null);
          setOrdersData(j.orders ?? []);
          setTradesData(j.trades ?? []);
        }
      })
      .catch(() => {});
  }, [broker]);

  useEffect(() => {
    fetchTabData();
    const id = setInterval(pollTabData, 5000);
    return () => clearInterval(id);
  }, [fetchTabData, pollTabData]);

  useEffect(() => { positionsRef.current = enrichedPositions; }, [enrichedPositions]);
  useEffect(() => { posGuardsRef.current = posGuards; }, [posGuards]);

  // Clear stale data immediately on broker switch so a Dhan position is
  // never displayed or acted on as if it belonged to Zerodha (or vice versa).
  useEffect(() => {
    setPositionsData([]);
    setOrdersData([]);
    setTradesData([]);
    setFundsData(null);
    setStrikeMap({});
  }, [broker]);

  // ─── Toast helper ─────────────────────────────────────────────────

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ─── Box management ─────────────────────────────────────────────

  const updateBox = useCallback((id: string, patch: Partial<BoxConfig>) => {
    setBoxes(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const addBox = useCallback(() => {
    setBoxes(prev => {
      if (prev.length >= MAX_BOXES) return prev;
      const ceCount = prev.filter(b => b.side === 'CE').length;
      const peCount = prev.filter(b => b.side === 'PE').length;
      const side: 'CE' | 'PE' = ceCount <= peCount ? 'CE' : 'PE';
      boxCounterRef.current += 1;
      return [...prev, {
        id: `box-${boxCounterRef.current}`,
        side,
        strike: atm > 0 ? atm : null,
        lots: 1,
        limitPrice: '',
      }];
    });
  }, [atm]);

  const removeBox = useCallback((id: string) => {
    // Validated outside the setBoxes updater: an updater must stay pure, and
    // toasting from inside one fires twice under StrictMode's double
    // invocation — the same hazard the auto-apply effect documents above.
    if (boxes.length <= MIN_BOXES) return;
    const box = boxes.find(b => b.id === id);
    if (!box) return;

    const secId = boxSecId(box);
    // Fail safe: if the box has a strike but the strike→securityId map hasn't
    // loaded yet (e.g. right after an expiry change), we can't verify whether
    // an open position backs this box — block removal instead of assuming flat.
    if (box.strike != null && !secId) {
      addToast('error', 'Cannot remove box', 'Strike data still loading — try again in a moment');
      return;
    }
    const pos = secId ? positionsBySecId[secId] : undefined;
    if (pos && Number(pos.netQty) !== 0) {
      addToast('error', 'Cannot remove box', 'Square off the open position first');
      return;
    }

    // Re-check the floor inside the updater — `boxes` is a render-time snapshot.
    setBoxes(prev => (prev.length > MIN_BOXES ? prev.filter(b => b.id !== id) : prev));
  }, [boxes, boxSecId, positionsBySecId, addToast]);

  // Pre-fill an existing empty box (or add a new one) from an open position so the
  // user can scale in (same strike) or add a hedge (new strike) via the order panel.
  const handleAddLeg = useCallback((pos: Record<string, unknown>) => {
    const sym = String(pos.tradingSymbol ?? '');
    // Resolve through the same broker-aware join the positions table uses.
    // Scanning strikeMap for ceSymbol/peSymbol matched nothing on Dhan — its
    // lookup returns securityIds only (scalper_api.py emits ceId/peId, no
    // symbols), so every Add click on the primary broker failed here.
    const mapping = secIdToStrikeSide[positionJoinKey(pos)];
    if (!mapping) { addToast('error', 'Could not match position to a strike', sym); return; }
    const strike = mapping.strike;
    const side: 'CE' | 'PE' = mapping.side === 'ce' ? 'CE' : 'PE';

    const emptyBox = boxes.find(b => b.side === side && b.strike == null);
    if (emptyBox) {
      updateBox(emptyBox.id, { strike });
      addToast('success', `${side} panel set to ${strike}`, 'Pick Buy/Sell and lots to add this leg');
      return;
    }
    if (boxes.length >= MAX_BOXES) {
      addToast('error', 'Cannot add leg', `Max ${MAX_BOXES} boxes reached — remove one first`);
      return;
    }
    boxCounterRef.current += 1;
    setBoxes(prev => [...prev, { id: `box-${boxCounterRef.current}`, side, strike, lots: 1, limitPrice: '' }]);
    addToast('success', `${side} panel set to ${strike}`, 'Pick Buy/Sell and lots to add this leg');
  }, [secIdToStrikeSide, positionJoinKey, boxes, updateBox, addToast]);

  // ─── placeOrder ───────────────────────────────────────────────────

  const placeOrder = useCallback(async (boxId: string, side: 'BUY' | 'SELL') => {
    const box = boxes.find(b => b.id === boxId);
    if (!box || !box.strike || !expiry) return;
    if (orderInFlightRef.current.has(boxId)) return;

    if (orderMode === 'LIMIT') {
      const priceNum = Number(box.limitPrice);
      if (!box.limitPrice || isNaN(priceNum) || priceNum <= 0) {
        addToast('error', 'Enter a valid limit price');
        return;
      }
    }

    // Quantity is lots × lot size, so an unresolved lot size means the order size
    // is unknown. Refuse rather than fall back to a literal.
    if (!lotSize || lotSize <= 0) {
      addToast('error', `${side} ${box.side} failed`, `Lot size for ${underlying} not resolved yet — retry in a moment`);
      return;
    }

    orderInFlightRef.current.add(boxId);
    setOrderPendingBoxes(prev => new Set([...prev, boxId]));

    try {
      const entry = strikeMap[String(box.strike)];
      let res: Response;
      if (broker !== 'dhan') {
        // Every non-Dhan broker orders by trading symbol (Dhan is the only one
        // with a numeric securityId), so they share one request shape and only
        // the exchange spelling differs.
        const symbol = entry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
        if (!symbol) {
          addToast('error', `${side} ${box.side} failed`, `${BROKER_LABELS[broker]} strike data still loading`);
          return;
        }
        const exchange = broker === 'kotak'
          ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
          : (underlying === 'SENSEX' ? 'BFO' : 'NFO');
        res = await fetch(scalperRoute(broker, 'order'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tradingsymbol: symbol,
            quantity: box.lots * lotSize,
            side,
            orderType: orderMode,
            exchange,
            product: productType === 'MARGIN' ? 'NRML' : 'MIS',
            ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
          }),
        });
      } else {
        const secId = entry?.[box.side === 'CE' ? 'ceId' : 'peId'];
        if (secId) {
          res = await fetch('/api/scalper/fast-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              securityId: secId,
              quantity: box.lots * lotSize,
              side,
              orderType: orderMode,
              exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
              productType,
              ...(orderMode === 'LIMIT' ? { price: Number(box.limitPrice) } : {}),
            }),
          });
        } else {
          const body: Record<string, unknown> = {
            underlying, expiry, strike: box.strike, option: box.side, side, lots: box.lots, type: orderMode,
          };
          if (orderMode === 'LIMIT') body.price = Number(box.limitPrice);
          res = await fetch('/api/scalper/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        }
      }

      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        addToast('success', `${side} ${box.side} placed`, `ID: ${j.order_id}`);
        setTimeout(fetchTabData, 1000);
      } else {
        addToast('error', `${side} ${box.side} failed`, j.error ?? 'Unknown error');
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      orderInFlightRef.current.delete(boxId);
      setOrderPendingBoxes(prev => { const s = new Set(prev); s.delete(boxId); return s; });
    }
  }, [boxes, expiry, underlying, lotSize, strikeMap, orderMode, productType, broker, addToast, fetchTabData]);

  // ─── Per-position close ───────────────────────────────────────────

  // ok=false means the close could not be confirmed (order failed / errored) —
  // callers that chain further actions (e.g. strike shift) MUST NOT proceed as
  // if the position were closed. qty is the signed live netQty seen right
  // before closing (0 if already flat), for sizing a follow-up order off the
  // real prior exposure rather than a possibly-stale value passed in.
  // closedUnits is how much actually left the book (verified when verifyFlat is
  // set, else the requested size) — chain off this, never off a rounded ideal.
  const closePosition = useCallback(async (
    pos: Record<string, unknown>,
    reason: string,
    opts?: {
      verifyFlat?: boolean;
      /**
       * Absolute units to close. Omitted (or ≥ the live netQty) ⇒ full close.
       * Always clamped against the freshly re-fetched live quantity below, so a
       * value computed off a stale table row can under-close but never
       * over-close or flip the position.
       */
      closeUnits?: number;
    },
  ): Promise<{ ok: boolean; qty: number; closedUnits: number; partial: boolean }> => {
    const sym = String(pos.tradingSymbol ?? '');
    const fallbackSecId = String(pos.securityId ?? pos.security_id ?? '');
    // Guards and in-flight tracking key off (symbol, product): the same symbol
    // can be open under two products, and they must be closed independently.
    const key = positionKey(pos);
    const product = positionProduct(pos);

    if (!sym || !fallbackSecId) {
      addToast('error', `Cannot close ${sym || 'position'}`, 'Missing security ID');
      return { ok: false, qty: 0, closedUnits: 0, partial: false };
    }

    // A product this broker cannot book (CO/BO, or a foreign vocabulary) must
    // not be sent — the order route would default it to intraday, which opens a
    // new position instead of reducing this one.
    const productPayload = closeOrderProduct(broker, product);
    if (!productPayload) {
      addToast('error', `Cannot close ${sym}`, `Unsupported product "${product}" — square this leg off at the broker`);
      return { ok: false, qty: 0, closedUnits: 0, partial: false };
    }

    // Prevent double-fire while order is in flight
    if (closingInFlightRef.current.has(key)) return { ok: false, qty: 0, closedUnits: 0, partial: false };
    closingInFlightRef.current.add(key);
    setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: true } } : prev);
    setClosingPositions(prev => new Set([...prev, key]));

    try {
      // Exchange is derived from the POSITION itself (not the currently-selected
      // underlying) — a stale position from a different underlying than what's
      // selected in the UI must still close on its own exchange.
      let liveNetQty = 0;
      let liveSecId = fallbackSecId;
      let liveExchange = String(pos.exchangeSegment ?? pos.exchange ??
        (broker === 'kotak' ? 'nse_fo' : broker === 'zerodha' ? 'NFO' : 'NSE_FNO'));
      try {
        const posUrl = scalperRoute(broker, 'positions');
        const posRes = await fetch(posUrl);
        const posJson = await posRes.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (posJson.success && posJson.data) {
          const found = findLivePosition(posJson.data, pos);
          if (found.kind === 'ambiguous') {
            // `triggered` is deliberately left set: a guard that cannot identify
            // its own row cannot close it either, and re-entering here every
            // second would bury every other toast under a storm of this one.
            addToast('error', `Cannot close ${sym}`,
              `${found.count} rows share this symbol and the position reports no product — close it from the broker terminal`);
            return { ok: false, qty: 0, closedUnits: 0, partial: false };
          }
          if (found.kind === 'match') {
            liveNetQty = Number(found.row.netQty);
            liveSecId = String(found.row.securityId ?? found.row.security_id ?? fallbackSecId);
            liveExchange = String(found.row.exchangeSegment ?? found.row.exchange ?? liveExchange);
          }
        }
      } catch {
        liveNetQty = Number(pos.netQty);
      }

      if (liveNetQty === 0) {
        addToast('success', `${sym} already flat`, `(${reason})`);
        setPosGuards(prev => { const next = { ...prev }; delete next[key]; return next; });
        fetchTabData();
        return { ok: true, qty: 0, closedUnits: 0, partial: false };
      }

      const side = liveNetQty > 0 ? 'SELL' : 'BUY';
      const liveAbs = Math.abs(liveNetQty);
      const reqUnits = Math.floor(Number(opts?.closeUnits ?? liveAbs));
      const qty = Math.max(1, Math.min(liveAbs, reqUnits > 0 ? reqUnits : liveAbs));
      const isPartial = qty < liveAbs;

      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const res = await fetch(orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          // Dhan is the only broker that closes by numeric securityId; the rest
          // close by trading symbol. productPayload books the close under the
          // position's own product so it reduces rather than opens.
          broker !== 'dhan'
            ? { tradingsymbol: sym, quantity: qty, side, orderType: 'MARKET', exchange: liveExchange, ...productPayload.fields }
            : { securityId: liveSecId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: liveExchange, ...productPayload.fields },
        ),
      });
      const j = await res.json() as { success: boolean; order_id?: string; error?: string };
      if (j.success) {
        // A MARKET order accepted by the broker isn't necessarily filled — for
        // callers that chain a follow-up open (strike shift), poll live
        // positions briefly to confirm the size actually came off before
        // reporting success, so a post-acceptance rejection can't lead to a
        // doubled position. Skipped by default: the SL/target/manual-close
        // paths that use closePosition constantly during scalping need the
        // fast return.
        let confirmedUnits = qty;
        if (opts?.verifyFlat) {
          if (isPartial) {
            // A partial can't be verified by "is it flat" — require the book to
            // shrink by at least what we asked for, and report what actually
            // left so the caller sizes its follow-up off reality.
            const removed = await pollPositionReduced(broker, pos, liveAbs, qty);
            if (removed === null) {
              addToast('error', `Could not confirm ${sym} partial close`, `Requested ${qty} of ${liveAbs} qty — book still shows more open, check manually`);
              setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
              return { ok: false, qty: liveNetQty, closedUnits: 0, partial: true };
            }
            confirmedUnits = removed;
          } else {
            const confirmedFlat = await pollPositionFlat(broker, pos);
            if (!confirmedFlat) {
              addToast('error', `Could not confirm ${sym} closed`, 'Order accepted but position still shows open — check manually');
              setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
              return { ok: false, qty: liveNetQty, closedUnits: 0, partial: false };
            }
            confirmedUnits = liveAbs;
          }
        }
        addToast('success', `${isPartial ? 'Partially closed' : 'Closed'} ${sym} (${reason})`,
          `${qty}${isPartial ? ` of ${liveAbs}` : ''} qty${productPayload.assumed ? '' : ` · ${product}`} · ID: ${j.order_id}`);
        if (isPartial) {
          // Quantity survives, so the user's target/SL/trail must survive with
          // it. bestPrice stays valid (same entry, same direction) — only
          // re-arm the trigger so the guard loop resumes on the remainder.
          // Note: if the guard level was already breached when the partial was
          // clicked, the loop will close the remainder within ~1s. That's the
          // guard doing its job; leaving the remainder unprotected is worse.
          setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
        } else {
          // Drop the guard entirely — leaving it would carry stale bestPrice /
          // trailEnabled into a future re-entry on the same symbol.
          setPosGuards(prev => { const next = { ...prev }; delete next[key]; return next; });
        }
        setTimeout(fetchTabData, 800);
        return { ok: true, qty: liveNetQty, closedUnits: confirmedUnits, partial: isPartial };
      } else {
        addToast('error', `Close failed: ${sym}`, j.error ?? 'Unknown error');
        setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
        return { ok: false, qty: liveNetQty, closedUnits: 0, partial: isPartial };
      }
    } catch (e) {
      addToast('error', 'Network error closing position', String(e));
      setPosGuards(prev => prev[key] ? { ...prev, [key]: { ...prev[key], triggered: false } } : prev);
      return { ok: false, qty: 0, closedUnits: 0, partial: false };
    } finally {
      closingInFlightRef.current.delete(key);
      setClosingPositions(prev => { const s = new Set(prev); s.delete(key); return s; });
    }
  }, [broker, addToast, fetchTabData]);

  // Lot size for a positions-table row. `lotSize` state belongs to the SELECTED
  // underlying, but the table also lists legs from other underlyings — giving
  // those the wrong lot granularity would size their partial chips wrongly, so
  // they get null and keep full-close only. The prefix test fails safe for the
  // three supported underlyings (a BANKNIFTY symbol never matches NIFTY).
  const lotSizeForRow = useCallback((row: Record<string, unknown>): number | null => {
    const sym = String(row.tradingSymbol ?? '').toUpperCase();
    if (!sym.startsWith(underlying)) return null;
    // A bare prefix test also swallows longer underlyings that start with this
    // one — NIFTYNXT50 (lot 25) would inherit NIFTY's lot size (75) and size its
    // partials against the wrong granularity. Every broker's symbol continues
    // into the expiry right after the underlying, so the next character is a
    // digit or separator; a letter means this is a different instrument.
    const next = sym.charAt(underlying.length);
    if (next && next >= 'A' && next <= 'Z') return null;
    return lotSize;
  }, [underlying, lotSize]);

  // Partial square-off from the positions table. No verifyFlat: manual closes
  // take the fast path (see closePosition's note), and the 800ms refresh shows
  // the result. closePosition clamps `units` against the live book.
  const handleClosePartial = useCallback((pos: Record<string, unknown>, units: number, pct: number) => {
    closePosition(pos, `Manual ${pct}%`, { closeUnits: units });
  }, [closePosition]);

  // ─── Shift Strike Up/Down (Auto-close active position & shift to new strike) ───
  const handleShiftStrike = useCallback(async (boxId: string, direction: 'UP' | 'DOWN') => {
    const box = boxes.find(b => b.id === boxId);
    if (!box || !box.strike || !visibleStrikes.length) return;
    if (orderInFlightRef.current.has(boxId)) return;

    const strikesToSearch = allStrikes.length ? allStrikes : visibleStrikes;
    const sorted = [...strikesToSearch].sort((a, b) => a - b);
    const currIdx = sorted.indexOf(box.strike);
    let targetIdx = -1;

    if (currIdx === -1) {
      // box.strike isn't in the list (stale/out-of-range) — fall back to a
      // direct step lookup instead of a neighbor index.
      const target = direction === 'UP' ? box.strike + strikeStep : box.strike - strikeStep;
      if (sorted.includes(target)) targetIdx = sorted.indexOf(target);
    } else if (direction === 'UP') {
      if (currIdx < sorted.length - 1) targetIdx = currIdx + 1;
    } else {
      if (currIdx > 0) targetIdx = currIdx - 1;
    }

    if (targetIdx === -1) {
      addToast('error', `Cannot shift ${direction.toLowerCase()}`, `No ${direction.toLowerCase()} strike available`);
      return;
    }

    const newStrike = sorted[targetIdx];

    // Check open position for this box. If strikeMap has no entry for the
    // CURRENT strike, we cannot reliably tell whether a live position exists
    // there (chain still loading, strike outside the fetched range, etc.) —
    // abort rather than silently treating it as flat, which would leave a
    // real position unmanaged while the box moves on to the new strike.
    if (!strikeMap[String(box.strike)]) {
      addToast('error', 'Cannot shift strike', `Position data for ${box.strike} ${box.side} not loaded yet — try again shortly`);
      return;
    }
    const secId = boxSecId(box);
    const pos = secId ? positionsBySecId[secId] : undefined;

    if (pos && Number(pos.netQty) !== 0) {
      // How much of the leg the chevrons roll. The snapshot below only sizes
      // the REQUEST — closePosition re-clamps against the live book, so a stale
      // netQty can only under-move, never over-move.
      const wantHalf = (box.moveFraction ?? 'FULL') === 'HALF';
      const posAbs = Math.abs(Number(pos.netQty) || 0);
      // A half-move needs whole-lot granularity, and re-opening at the new strike
      // needs it too. Without a resolved lot size neither can be sized.
      if (!lotSize || lotSize <= 0) {
        addToast('error', 'Cannot shift strike', `Lot size for ${underlying} not resolved yet — retry in a moment`);
        return;
      }
      const moveUnits = wantHalf ? fractionUnits(posAbs, lotSize, 0.5) : posAbs;
      if (wantHalf && moveUnits <= 0) {
        addToast('error', 'Cannot move half', `${box.strike} ${box.side} is ${openLots(posAbs, lotSize)} lot — need ≥2 lots to split`);
        return;
      }

      orderInFlightRef.current.add(boxId);
      setOrderPendingBoxes(prev => new Set([...prev, boxId]));

      try {
        addToast('success', `Shifting ${wantHalf ? 'half of ' : ''}${box.strike} ${box.side} → ${newStrike} ${box.side}`, `Closing active position first...`);
        // 1. Close current position. closePosition re-fetches live positions
        // itself, so closeResult.qty is the real quantity that was open — not
        // the possibly-stale pos.netQty snapshot.
        const closeResult = await closePosition(
          pos,
          wantHalf ? 'Strike Shift (½)' : 'Strike Shift',
          { verifyFlat: true, ...(wantHalf ? { closeUnits: moveUnits } : {}) },
        );
        if (!closeResult.ok) {
          // Close could not be confirmed — do NOT touch the box's strike or
          // open a new leg, or we'd risk both the old and new position open at
          // once. closePosition already toasted the error.
          addToast('error', 'Shift aborted', `${box.strike} ${box.side} close was not confirmed — position left untouched`);
          return;
        }
        if (closeResult.qty === 0) {
          // Already flat by the time we got here — nothing to roll, just move the box.
          updateBox(boxId, { strike: newStrike, limitPrice: '' });
          addToast('success', `${box.strike} ${box.side} was already flat`, `Strike moved to ${newStrike} ${box.side} — no order placed`);
          return;
        }

        const sideToOpen: 'BUY' | 'SELL' = closeResult.qty < 0 ? 'SELL' : 'BUY';
        // Size the new leg off what ACTUALLY left the book, never off a rounded
        // ideal — rounding a partial fill back up would leave the account net
        // long/short after the roll.
        const movedUnits = closeResult.closedUnits > 0 ? closeResult.closedUnits : Math.abs(closeResult.qty);
        const openLotsN = Math.floor(movedUnits / lotSize);
        if (movedUnits <= 0) {
          addToast('error', 'Shift aborted', 'Nothing was closed — no new leg opened');
          return;
        }

        // 2. Move the box to the new strike. On a half-move the remainder stays
        // at the old strike, still visible and closable in the Positions table
        // (with its guard intact) but no longer bound to this box.
        updateBox(boxId, { strike: newStrike, limitPrice: '' });

        // 3. Place order on new strike
        const newSecEntry = strikeMap[String(newStrike)];
        let res: Response;
        if (broker !== 'dhan') {
          const symbol = newSecEntry?.[box.side === 'CE' ? 'ceSymbol' : 'peSymbol'];
          if (!symbol) {
            addToast('error', `Shift to ${newStrike} failed`, `Strike symbol data loading`);
            return;
          }
          const exchange = broker === 'kotak'
            ? (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
            : (underlying === 'SENSEX' ? 'BFO' : 'NFO');
          res = await fetch(scalperRoute(broker, 'order'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tradingsymbol: symbol,
              quantity: movedUnits,
              side: sideToOpen,
              orderType: 'MARKET',
              exchange,
              product: productType === 'MARGIN' ? 'NRML' : 'MIS',
            }),
          });
        } else {
          const secId = newSecEntry?.[box.side === 'CE' ? 'ceId' : 'peId'];
          if (secId) {
            res = await fetch('/api/scalper/fast-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                securityId: secId,
                quantity: movedUnits,
                side: sideToOpen,
                orderType: 'MARKET',
                exchangeSegment: underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
                productType,
              }),
            });
          } else {
            // Fallback path is lot-denominated, so it can't express a sub-lot
            // remainder — bail rather than silently re-open a different size.
            if (openLotsN < 1) {
              addToast('error', `Shift to ${newStrike} failed`, `${movedUnits} qty is under one lot and the fallback order path accepts whole lots only — re-enter manually`);
              return;
            }
            if (movedUnits % lotSize !== 0) {
              addToast('error', 'Partial re-entry', `Re-opening ${openLotsN} lot(s) = ${openLotsN * lotSize} of ${movedUnits} qty (fallback path is lot-only)`);
            }
            res = await fetch('/api/scalper/order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                underlying, expiry, strike: newStrike, option: box.side, side: sideToOpen, lots: openLotsN, type: 'MARKET',
              }),
            });
          }
        }

        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) {
          // Off the live pre-close quantity, not the table snapshot.
          const residual = Math.abs(closeResult.qty) - movedUnits;
          addToast('success', `Shift complete: ${newStrike} ${box.side}`,
            `${sideToOpen} ${movedUnits} qty placed (ID: ${j.order_id})`
            + (residual > 0 ? ` · ${residual} qty left at ${box.strike}` : ''));
          setTimeout(fetchTabData, 1000);
        } else {
          addToast('error', `New strike order failed`, j.error ?? 'Unknown error');
        }
      } catch (e) {
        addToast('error', 'Shift failed', String(e));
      } finally {
        orderInFlightRef.current.delete(boxId);
        setOrderPendingBoxes(prev => { const s = new Set(prev); s.delete(boxId); return s; });
      }
    } else {
      // No active position: simply update strike
      updateBox(boxId, { strike: newStrike, limitPrice: '' });
      addToast('success', `Strike shifted to ${newStrike} ${box.side}`);
    }
  }, [boxes, visibleStrikes, allStrikes, strikeStep, boxSecId, positionsBySecId, lotSize, updateBox, strikeMap, broker, underlying, productType, expiry, closePosition, addToast, fetchTabData]);

  // ─── Client-side profit lock (total P&L floor) ────────────────────

  const exitAllForLock = useCallback(async (reason: string) => {
    const open = positionsRef.current.filter(p => Number(p.netQty) !== 0);
    await Promise.allSettled(open.map(pos => closePosition(pos, reason)));
    setTimeout(fetchTabData, 1000);
  }, [closePosition, fetchTabData]);

  const hasOpenPositions = useMemo(
    () => enrichedPositions.some(p => Number(p.netQty) !== 0),
    [enrichedPositions]);

  const profitLock = useProfitLock({
    totalPnl,
    hasOpenPositions,
    exitAll: exitAllForLock,
    notify: addToast,
    storageKey: 'profit_lock_v1',
  });

  const copyTrade = useCopyTrade(addToast);

  const handleExitAll = useCallback(async () => {
    if (!confirmExitAll) {
      setConfirmExitAll(true);
      setTimeout(() => setConfirmExitAll(false), 3000);
      return;
    }
    setExitingAll(true);
    setConfirmExitAll(false);
    try {
      if (broker !== 'dhan') {
        const label = BROKER_LABELS[broker];
        const res = await fetch(scalperRoute(broker, 'exit-all'), { method: 'POST' });
        const data = await res.json() as { success: boolean; closed: string[]; errors: string[] };
        if (data.success) {
          addToast('success', `All ${label} positions liquidated.${data.closed.length ? ` (${data.closed.join(', ')})` : ''}`);
        } else {
          addToast('error', `${label} exit failed`, data.errors.join('; ') || 'Unknown error');
        }
      } else {
        const res = await fetch('/api/exit-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'fno' }),
        });
        const data = await res.json();
        if (data.broker_exit) {
          const killed = data.killed?.length ?? 0;
          const fallback = data.trigger_fallback?.length ?? 0;
          const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
          const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
          addToast('success', `All F&O positions liquidated at broker.${detail}${fb}`);
        } else {
          addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
        }
      }
    } catch (e) {
      addToast('error', 'Network error calling exit-all API.', String(e));
    } finally {
      setExitingAll(false);
      setTimeout(fetchTabData, 1000);
    }
  }, [confirmExitAll, broker, addToast, fetchTabData]);

  // ─── Close 50% of every open leg ──────────────────────────────────

  // The plan is derived up front so the button can show what it will do and
  // stay disabled when it would do nothing. Legs are skipped — never
  // approximated — when the lot granularity is unknown or half floors to zero
  // lots: leaving a leg untouched is recoverable, sending a wrong-sized market
  // order is not.
  const halfAllPlan = useMemo(() => {
    const legs: HalfLeg[] = [];
    const skipped: string[] = [];
    for (const pos of enrichedPositions) {
      const netQty = Number(pos.netQty);
      if (!netQty) continue;
      const sym = String(pos.tradingSymbol ?? '');
      const ls = lotSizeForRow(pos);
      // lotSizeForRow returns null for anything outside the selected underlying
      // (see its note) — that also keeps equity/MCX legs out of this action.
      if (!ls || ls <= 0) { skipped.push(`${sym} (not ${underlying})`); continue; }
      // A product this broker cannot book would be refused by closePosition
      // anyway; leaving it out of the plan keeps the count honest.
      if (!closeOrderProduct(broker, positionProduct(pos))) {
        skipped.push(`${sym} (${positionProduct(pos)} not closable here)`);
        continue;
      }
      const units = fractionUnits(netQty, ls, 0.5);
      if (units <= 0) { skipped.push(`${sym} (${openLots(netQty, ls)} lot — needs ≥2)`); continue; }
      legs.push({ pos, sym, units, lots: units / ls });
    }
    return { legs, skipped };
  }, [enrichedPositions, lotSizeForRow, underlying, broker]);

  // Sequential, not parallel: closePosition re-reads the live book per leg, and
  // firing every leg's market order at once risks the broker's rate limit on
  // exactly the requests that must not be dropped.
  const handleHalfAll = useCallback(async () => {
    if (!halfAllPlan.legs.length || halvingAll) return;
    if (!confirmHalfAll) {
      // Freeze what is being confirmed. Every way the book can move between the
      // two clicks then fails safe: a leg that shrank or closed is clamped down
      // (or no-ops) by closePosition against the live quantity, and a leg opened
      // after arming is simply not in the plan the user agreed to.
      armedHalfPlanRef.current = halfAllPlan;
      setConfirmHalfAll(true);
      setTimeout(() => {
        armedHalfPlanRef.current = null;
        setConfirmHalfAll(false);
      }, 3000);
      return;
    }
    setConfirmHalfAll(false);
    setHalvingAll(true);
    // The armed plan, not the live one. Also a genuine snapshot for the loop
    // below: enrichedPositions is rebuilt by the poll, and iterating a list that
    // changed mid-loop would skip or re-close legs.
    const plan = armedHalfPlanRef.current ?? halfAllPlan;
    armedHalfPlanRef.current = null;
    const legs = plan.legs;
    const skipped = plan.skipped;
    let closed = 0;
    let alreadyFlat = 0;
    const failed: string[] = [];
    try {
      for (const leg of legs) {
        // closePosition clamps `units` against the freshly re-fetched live
        // quantity, so a leg that shrank since the snapshot under-closes rather
        // than over-closing or flipping. No verifyFlat — same fast path as the
        // per-row chips; the refresh below shows the result.
        const r = await closePosition(leg.pos, 'Bulk 50%', { closeUnits: leg.units });
        if (!r.ok) failed.push(leg.sym);
        else if (r.closedUnits > 0) closed++;
        else alreadyFlat++;
      }
      // closePosition toasts each leg; this is the roll-up, and the only place
      // the user learns a leg was never attempted.
      const detail = [
        alreadyFlat > 0 ? `${alreadyFlat} already flat` : '',
        skipped.length ? `skipped: ${skipped.join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      if (failed.length) {
        addToast('error', `Halved ${closed} of ${legs.length} legs`,
          `Failed: ${failed.join(', ')} — check manually${detail ? ` · ${detail}` : ''}`);
      } else {
        addToast('success', `Closed 50% on ${closed} leg${closed === 1 ? '' : 's'}`,
          detail || undefined);
      }
    } catch (e) {
      addToast('error', 'Bulk 50% close aborted', String(e));
    } finally {
      setHalvingAll(false);
      setTimeout(fetchTabData, 1000);
    }
  }, [halfAllPlan, halvingAll, confirmHalfAll, closePosition, addToast, fetchTabData]);

  // `posKey` is the composite (symbol, product) key from lib/positionProduct,
  // NOT a trading symbol — see the posGuards declaration.
  const handleGuardChange = useCallback((posKey: string, field: 'target' | 'sl', value: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[posKey] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [posKey]: { ...existing, [field]: value, triggered: false },
      };
    });
  }, []);

  const handleTrailToggle = useCallback((posKey: string) => {
    setPosGuards(prev => {
      const existing: PositionGuard = prev[posKey] ?? { target: '', sl: '', trailEnabled: false, bestPrice: 0, triggered: false };
      return {
        ...prev,
        [posKey]: { ...existing, trailEnabled: !existing.trailEnabled, bestPrice: 0, triggered: false },
      };
    });
  }, []);

  // Guard monitoring — 1s interval reads LTP from positions data and fires closes
  useEffect(() => {
    const id = setInterval(() => {
      const guards = posGuardsRef.current;
      const positions = positionsRef.current;
      const peakUpdates: Record<string, number> = {};

      for (const pos of positions) {
        // Keyed per (symbol, product) — the same symbol open under two products
        // is two independently guarded rows, not one shared guard.
        const posKey = positionKey(pos);
        const guard = guards[posKey];
        if (!guard || guard.triggered) continue;

        const ltp = Number(pos.lastTradedPrice);
        const netQty = Number(pos.netQty);
        if (ltp <= 0 || netQty === 0) continue;

        const isLong = netQty > 0;

        const targetNum = parseFloat(guard.target);
        if (!isNaN(targetNum) && targetNum > 0) {
          if ((isLong && ltp >= targetNum) || (!isLong && ltp <= targetNum)) {
            closePosition(pos, 'Target hit');
            continue;
          }
        }

        if (guard.trailEnabled) {
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            const entryPrice = isLong ? Number(pos.buyAvg) : Number(pos.sellAvg);
            if (entryPrice > 0) {
              const initialRisk = Math.abs(slNum - entryPrice);
              const currentBest = guard.bestPrice;
              const newBest = currentBest === 0
                ? ltp
                : (isLong ? Math.max(currentBest, ltp) : Math.min(currentBest, ltp));
              if (newBest !== currentBest) peakUpdates[posKey] = newBest;

              const effectiveBest = peakUpdates[posKey] ?? currentBest;
              if (effectiveBest > 0) {
                const trailSLPrice = isLong
                  ? effectiveBest - initialRisk
                  : effectiveBest + initialRisk;
                // Only enforce the trail once it's tighter than the original SL;
                // otherwise fall back to the original SL so the position stays protected.
                const trailActive = isLong ? trailSLPrice > slNum : trailSLPrice < slNum;
                if (trailActive) {
                  if ((isLong && ltp <= trailSLPrice) || (!isLong && ltp >= trailSLPrice)) {
                    closePosition(pos, 'Trail SL hit');
                    continue;
                  }
                } else if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
                  closePosition(pos, 'SL hit');
                  continue;
                }
              }
            }
          }
        } else {
          const slNum = parseFloat(guard.sl);
          if (!isNaN(slNum) && slNum > 0) {
            if ((isLong && ltp <= slNum) || (!isLong && ltp >= slNum)) {
              closePosition(pos, 'SL hit');
              continue;
            }
          }
        }
      }

      if (Object.keys(peakUpdates).length > 0) {
        setPosGuards(prev => {
          const next = { ...prev };
          for (const [s, best] of Object.entries(peakUpdates)) {
            if (next[s]) next[s] = { ...next[s], bestPrice: best };
          }
          return next;
        });
      }
    }, 1000);

    return () => clearInterval(id);
  }, [closePosition]);

  // ─── P&L Guard ────────────────────────────────────────────────────

  // After a successful Set, Dhan's own GET can take several seconds to reflect
  // the change. Poll a few times before trusting a "not configured yet"
  // response — otherwise the optimistic ACTIVE badge flips back to NOT SET
  // a couple seconds later even though the guard really was applied.
  //
  // The retry recurses through a local helper rather than through the
  // useCallback binding itself, which would be a read of a component-scope
  // `const` from inside its own initialiser.
  const reconcilePnlGuardAfterSet = useCallback(() => {
    const poll = (attempt: number) => {
      setTimeout(async () => {
        try {
          const res = await fetch('/api/pnl-exit');
          const j = await res.json();
          const hasConfig = j.success && j.data && (Number(j.data.profit) > 0 || Math.abs(Number(j.data.loss)) > 0);
          if (hasConfig || attempt >= 4) {
            if (j.success) setPnlGuardStatus(j.data ?? null);
            return;
          }
          poll(attempt + 1);
        } catch {
          if (attempt < 4) poll(attempt + 1);
        }
      }, 1500);
    };
    poll(1);
  }, []);

  const handleSetPnl = async () => {
    // /api/pnl-exit is Dhan's native account-level guard only — no Zerodha
    // equivalent exists. The UI already hides these controls for Zerodha;
    // this is a defense-in-depth guard against calling it anyway.
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    // The field collects a positive loss magnitude ("exit when loss reaches ₹X"),
    // but Dhan's API rejects lossValue > 0 ("Loss Amount Cannot Be Greater Than
    // Zero") — it wants the P&L level itself, so the magnitude is sent negated.
    const p = Math.abs(parseFloat(profitTarget)) || 0;
    const l = Math.abs(parseFloat(lossLimit)) || 0;
    if (p <= 0 && l <= 0) { addToast('error', 'Enter a profit target or loss limit'); return; }
    setGuardError('');
    setSettingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profitValue: p, lossValue: l > 0 ? -l : 0, productTypes: guardProductTypes, enableKillSwitch }),
      });
      const j = await res.json();
      if (j.success) {
        addToast('success', 'P&L Guard set');
        // Reflect the just-applied config immediately — Dhan's GET can lag a beat
        // behind the POST, so the ACTIVE badge shouldn't depend on winning that race.
        setPnlGuardStatus({
          pnlExitStatus: 'ACTIVE',
          profit: p > 0 ? p : undefined,
          loss: l > 0 ? l : undefined,
          productType: guardProductTypes,
          enableKillSwitch,
        });
        // Reconcile with the broker's actual state after it's had a moment to
        // persist the change, rather than racing it and clobbering the
        // optimistic ACTIVE state with a stale response.
        reconcilePnlGuardAfterSet();
      } else {
        const msg = j.error || 'Failed to set P&L Guard';
        addToast('error', 'Failed to set P&L Guard', j.error);
        setGuardError(msg);
      }
    } catch (e) {
      addToast('error', 'Network error', String(e));
      setGuardError(String(e));
    } finally {
      setSettingPnl(false);
    }
  };

  const handleClearPnl = async () => {
    if (broker !== 'dhan') { addToast('error', 'P&L Guard is Dhan-only'); return; }
    if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return; }
    setClearingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', { method: 'DELETE' });
      const j = await res.json();
      if (j.success) { addToast('success', 'P&L Guard cleared'); setPnlGuardStatus(null); }
      else addToast('error', 'Failed to clear P&L Guard', j.error);
    } catch (e) {
      addToast('error', 'Network error', String(e));
    } finally {
      setClearingPnl(false);
      setConfirmClear(false);
    }
  };

  // ─── JSX ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Fixed toast overlay */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold
            shadow-2xl max-w-xs
            ${t.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200'
              : 'bg-rose-900/95 border-rose-500/40 text-rose-200'}`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      {/* Sticky header */}
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center justify-between gap-3 flex-nowrap overflow-x-auto">
          <div className="flex items-center gap-3 flex-nowrap shrink-0">
            <div className="shrink-0 whitespace-nowrap">
              <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-yellow-400" />
                {underlying} ADVANCED SCALPER
              </h1>
              <p className="text-xs font-bold font-mono tabular-nums text-zinc-200">
                {spot > 0
                  ? `${underlying} ${spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : 'Loading…'}
              </p>
            </div>
            <div className="shrink-0"><NavBar /></div>
          </div>
          <div className="flex items-center gap-3 flex-nowrap shrink-0">
          <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-2.5 py-1">
            {/* Broker selector — only shown when more than one broker is authenticated */}
            {authenticatedBrokers.length > 1 && (
              <select
                value={broker}
                onChange={e => setBroker(e.target.value as Broker)}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                           rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[88px] shrink-0"
              >
                {authenticatedBrokers.map(b => (
                  <option key={b} value={b}>{BROKER_LABELS[b]}</option>
                ))}
              </select>
            )}

            {/* Underlying selector — fixed width so the row layout doesn't shift
                when switching between underlyings of different name lengths
                (e.g. NIFTY vs BANKNIFTY) */}
            <select value={underlying} onChange={e => setUnderlying(e.target.value as typeof UNDERLYINGS[number])}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-[104px] shrink-0">
              {UNDERLYINGS.map(sym => <option key={sym} value={sym}>{sym}</option>)}
            </select>

            {/* Expiry selector */}
            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 shrink-0">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-2.5 py-1">
            {/* Add Box */}
            <button onClick={addBox} disabled={boxes.length >= MAX_BOXES}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold rounded-lg',
                'border border-emerald-600/40 bg-emerald-900/30 text-emerald-400',
                'hover:bg-emerald-800/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap',
                FOCUS_RING,
              )}>
              <Plus className="w-3.5 h-3.5" /> Add Box
            </button>
            <span className={cn(TXT_VALUE, 'text-zinc-500 font-mono shrink-0 whitespace-nowrap')}>{boxes.length}/{MAX_BOXES} boxes</span>

            {/* MARKET / LIMIT toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl shrink-0">
              {(['MARKET', 'LIMIT'] as const).map(m => (
                <button key={m} onClick={() => setOrderMode(m)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-bold rounded-lg transition-all whitespace-nowrap',
                    orderMode === m
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300',
                    FOCUS_RING,
                  )}>
                  {m}
                </button>
              ))}
            </div>

            {/* INTRADAY / MARGIN toggle */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl shrink-0">
              {(['INTRADAY', 'MARGIN'] as const).map(pt => (
                <button key={pt} onClick={() => handleProductTypeChange(pt)}
                  className={cn(
                    'px-3 py-1.5 text-xs font-bold rounded-lg transition-all whitespace-nowrap',
                    productType === pt
                      ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                      : 'text-zinc-500 hover:text-zinc-300',
                    FOCUS_RING,
                  )}>
                  {pt}
                </button>
              ))}
            </div>

            {/* Top 10 NIFTY heavyweights panel — display preference, so it sits
                with the other view toggles rather than the order controls. */}
            <button onClick={() => setShowTop10(v => !v)}
              title="Show the 10 heaviest NIFTY constituents with live % change"
              className={cn(
                'px-3 py-1.5 text-xs font-bold rounded-lg border transition-all shrink-0 whitespace-nowrap',
                showTop10
                  ? 'bg-sky-900/50 border-sky-500/40 text-sky-300'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300',
                FOCUS_RING,
              )}>
              TOP 10 {showTop10 ? 'ON' : 'OFF'}
            </button>
          </div>

            {/* Bridge status dot + transport badge + timestamp */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={cn(
                TXT_LABEL, 'font-bold px-1 py-0.5 rounded border w-9 text-center',
                transport === 'ws'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700',
              )} title={transport === 'ws' ? 'Realtime WebSocket push' : 'HTTP polling fallback'}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className={cn(TXT_VALUE, 'text-zinc-500 font-mono whitespace-nowrap')}>{lastUpdated}</span>}
            </div>

          </div>
        </div>

        {/* P&L Guard bar — always visible; controls themselves are Dhan-only (see below) */}
        <div className="mt-2 pt-2 border-t border-zinc-800">
          {(() => {
            const isActive = pnlGuardStatus?.pnlExitStatus === 'ACTIVE';
            // Dhan may echo loss back as the negative level it was stored at rather
            // than the positive magnitude we sent — compare by magnitude either way.
            const hasConfig = !!(pnlGuardStatus && (Number(pnlGuardStatus.profit) > 0 || Math.abs(Number(pnlGuardStatus.loss)) > 0));
            const guardLabel = isActive ? 'ACTIVE' : hasConfig ? 'CONFIGURED' : 'NOT SET';
            const guardChipCls = isActive
              ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/30'
              : hasConfig
              ? 'bg-amber-900/40 text-amber-400 border border-amber-500/30'
              : 'bg-zinc-800 text-zinc-500 border border-zinc-700';
            return (
              <div className="flex items-center gap-3 flex-nowrap overflow-x-auto pb-1">
                <div className="flex items-center gap-3 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5">
                <span className={cn('flex items-center gap-1', TXT_VALUE, 'font-bold text-zinc-500 uppercase tracking-wider shrink-0 whitespace-nowrap')}>
                  <Shield className="w-3 h-3" /> P&amp;L Guard
                </span>

                {broker !== 'dhan' ? (
                  // Dhan's native /pnlExit is an account-level kill switch with no
                  // Zerodha equivalent — showing live-looking controls here would
                  // silently configure Dhan's guard while this tab shows Zerodha
                  // data, so surface that plainly instead of pretending it works.
                  <span
                    className={cn(TXT_VALUE, 'px-2 py-1 rounded font-bold uppercase tracking-wider bg-zinc-800 text-zinc-500 border border-zinc-700 shrink-0 whitespace-nowrap')}
                    title="P&L Guard uses Dhan's native account-level pnlExit API, which has no Zerodha equivalent. Switch to Dhan to use it.">
                    DHAN ONLY
                  </span>
                ) : (
                  <>
                    <span className={cn(TXT_VALUE, 'px-2 py-1 rounded font-bold uppercase tracking-wider shrink-0 whitespace-nowrap', guardChipCls)}>
                      {guardLabel}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(TXT_VALUE, 'text-zinc-500 font-semibold whitespace-nowrap')}>TARGET ₹</span>
                      <input type="number" min="0" placeholder="e.g. 5000" value={profitTarget}
                        onChange={e => setProfitTarget(e.target.value.replace(/-/g, ''))}
                        className={cn('w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-emerald-500', FOCUS_RING)} />
                    </div>

                    {/* Loss limit — always a positive magnitude ("exit when loss reaches ₹X"); Dhan rejects a negative value */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(TXT_VALUE, 'text-zinc-500 font-semibold whitespace-nowrap')}>SL ₹</span>
                      <input type="number" min="0" placeholder="e.g. 2000" value={lossLimit}
                        onChange={e => setLossLimit(e.target.value.replace(/-/g, ''))}
                        className={cn('w-24 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-rose-500', FOCUS_RING)} />
                    </div>

                    <RiskRail totalPnl={totalPnl} target={Number(profitTarget) || null} stop={Number(lossLimit) || null} />

                    {/* Combined Strategy % Presets (Always visible; calculates Total P&L Guard Target & SL ₹) */}
                    <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded-lg shrink-0">
                      <span className={cn(TXT_VALUE, 'text-zinc-400 font-bold whitespace-nowrap')} title="Target & SL % for combined multi-leg portfolio">COMBINED %:</span>
                      <span className={cn(TXT_VALUE, 'text-emerald-400 font-bold')}>TGT</span>
                      {[10, 15, 20, 25, 30].map(pct => {
                        const isSelected = combinedTargetPct === pct;
                        return (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => {
                              setCombinedTargetPct(prev => prev === pct ? null : pct);
                              if (combinedStrategyStats.entryCapitalSum > 0) {
                                const calcTarget = Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100);
                                if (calcTarget > 0) setProfitTarget(String(calcTarget));
                              }
                            }}
                            className={cn(
                              'px-1.5 py-0.5 rounded font-mono', TXT_VALUE, 'font-bold transition-all',
                              isSelected
                                ? 'bg-emerald-600 text-oncolor border border-emerald-400 shadow-sm'
                                : 'bg-emerald-950/80 border border-emerald-800/80 text-emerald-400 hover:bg-emerald-800 hover:text-oncolor',
                              FOCUS_RING,
                            )}
                            title={combinedStrategyStats.entryCapitalSum > 0
                              ? `Set total P&L Guard Target to +${pct}% (+₹${Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100)})`
                              : `Set combined Target to +${pct}% (will apply when trade opens)`
                            }
                          >
                            +{pct}%
                          </button>
                        );
                      })}
                      <span className={cn(TXT_VALUE, 'text-rose-400 font-bold ml-1')}>SL</span>
                      {[5, 10, 15, 20].map(pct => {
                        const isSelected = combinedSlPct === pct;
                        return (
                          <button
                            key={pct}
                            type="button"
                            onClick={() => {
                              setCombinedSlPct(prev => prev === pct ? null : pct);
                              if (combinedStrategyStats.entryCapitalSum > 0) {
                                const calcLoss = Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100);
                                if (calcLoss > 0) setLossLimit(String(calcLoss));
                              }
                            }}
                            className={cn(
                              'px-1.5 py-0.5 rounded font-mono', TXT_VALUE, 'font-bold transition-all',
                              isSelected
                                ? 'bg-rose-600 text-oncolor border border-rose-400 shadow-sm'
                                : 'bg-rose-950/80 border border-rose-800/80 text-rose-400 hover:bg-rose-800 hover:text-oncolor',
                              FOCUS_RING,
                            )}
                            title={combinedStrategyStats.entryCapitalSum > 0
                              ? `Set total P&L Guard SL limit to -${pct}% (-₹${Math.round((combinedStrategyStats.entryCapitalSum * pct) / 100)})`
                              : `Set combined SL limit to -${pct}% (will apply when trade opens)`
                            }
                          >
                            -{pct}%
                          </button>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {['INTRADAY', 'CNC', 'MARGIN'].map(pt => (
                        <button key={pt} onClick={() => setGuardProductTypes(prev =>
                          prev.includes(pt) ? prev.filter(x => x !== pt) : [...prev, pt]
                        )}
                          className={cn(
                            TXT_VALUE, 'px-2 py-1 rounded font-bold border transition-all whitespace-nowrap',
                            guardProductTypes.includes(pt)
                              ? 'bg-violet-900/50 border-violet-500/40 text-violet-300'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300',
                            FOCUS_RING,
                          )}>
                          {pt}
                        </button>
                      ))}
                    </div>

                    <button onClick={() => setEnableKillSwitch(v => !v)}
                      aria-pressed={enableKillSwitch}
                      className={cn(
                        'flex items-center gap-1.5 px-2.5 py-1 rounded', TXT_VALUE, 'font-bold border transition-all shrink-0 whitespace-nowrap',
                        enableKillSwitch
                          ? 'bg-rose-900/50 border-rose-500/40 text-rose-300'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-500 hover:text-zinc-300',
                        FOCUS_RING,
                      )}>
                      🔴 Kill Switch {enableKillSwitch ? 'ON' : 'OFF'}
                    </button>

                    <button onClick={handleSetPnl} disabled={settingPnl}
                      className={cn('px-3 py-1.5 text-xs font-bold rounded-lg bg-violet-600 hover:bg-violet-500 text-white border border-violet-500/40 transition-all disabled:opacity-50 shrink-0 whitespace-nowrap', FOCUS_RING)}>
                      {settingPnl ? 'Setting…' : 'Set Guard'}
                    </button>

                    {/* Open positions the guard's product scope does not cover.
                        An ACTIVE guard that skips your actual position is the
                        worst failure mode this bar has — say so loudly. */}
                    {uncoveredGuardProducts.length > 0 && (
                      <span
                        className={cn(TXT_VALUE, 'px-2 py-1 rounded font-bold border bg-amber-900/50 border-amber-500/50 text-amber-300 shrink-0 whitespace-nowrap')}
                        title={`You hold open ${uncoveredGuardProducts.join(' / ')} position(s), but the guard is scoped to ${guardProductTypes.join(' / ') || 'nothing'}. Dhan will not square those off. Select the missing product above and press Set Guard again.`}>
                        ⚠ {uncoveredGuardProducts.join('/')} NOT COVERED
                      </span>
                    )}

                    {hasConfig && (
                      <button onClick={handleClearPnl} disabled={clearingPnl}
                        className={cn(
                          'px-3 py-1.5 text-xs font-bold rounded-lg border transition-all disabled:opacity-50 shrink-0 whitespace-nowrap',
                          confirmClear
                            ? 'bg-rose-600 border-rose-500/40 text-oncolor'
                            : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200',
                          FOCUS_RING,
                        )}>
                        {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear Guard'}
                      </button>
                    )}
                  </>
                )}

                {/* Current guard values + persistent error, kept inside the Guard
                    card since both describe its own state. */}
                {broker === 'dhan' && hasConfig && (
                  <span className={cn(TXT_VALUE, 'text-zinc-500 font-mono shrink-0 whitespace-nowrap')}>
                    {Number(pnlGuardStatus?.profit) > 0 ? `🎯 ₹${pnlGuardStatus?.profit}` : ''}
                    {Number(pnlGuardStatus?.profit) > 0 && Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? '  ' : ''}
                    {Math.abs(Number(pnlGuardStatus?.loss)) > 0 ? `🛑 ₹${Math.abs(Number(pnlGuardStatus?.loss))}` : ''}
                  </span>
                )}
                {broker === 'dhan' && guardError && (
                  <span className={cn(TXT_VALUE, 'text-rose-400 font-semibold shrink-0 whitespace-nowrap')}>⚠ {guardError}</span>
                )}
                </div>

                {/* Close 50% of every open leg (lot-rounded, per-leg orders) — left
                    outside the Guard card, alongside EXIT ALL below, so both nuclear
                    actions keep their loud danger styling instead of blending in. */}
                <button onClick={handleHalfAll} disabled={halvingAll || halfAllPlan.legs.length === 0}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg', TXT_CAPTION, 'font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap',
                    halvingAll
                      ? 'bg-amber-900/40 border-amber-800 text-amber-400'
                      : confirmHalfAll
                      ? 'bg-amber-500 border-amber-400 text-oncolor-dark animate-pulse shadow-lg shadow-amber-500/20'
                      : 'bg-amber-950/60 border-amber-900/60 text-amber-400 hover:bg-amber-900/40 hover:border-amber-700 hover:text-amber-300',
                    FOCUS_RING,
                  )}
                  title={
                    halfAllPlan.legs.length === 0
                      ? halfAllPlan.skipped.length
                        ? `No leg can be halved — ${halfAllPlan.skipped.join(', ')}`
                        : 'No open positions to halve'
                      : `Market-close half of each leg, rounded down to whole lots: ${
                          halfAllPlan.legs.map(l => `${l.sym} ${l.units} qty (${l.lots} lot)`).join(', ')
                        }${halfAllPlan.skipped.length ? ` · skipped: ${halfAllPlan.skipped.join(', ')}` : ''}`
                  }>
                  {halvingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Scissors className="h-3 w-3" />}
                  {halvingAll
                    ? 'Closing…'
                    : confirmHalfAll
                    ? `Confirm 50% on ${halfAllPlan.legs.length} leg${halfAllPlan.legs.length === 1 ? '' : 's'}?`
                    : `Close 50% All${halfAllPlan.legs.length ? ` (${halfAllPlan.legs.length})` : ''}`}
                </button>

                {/* Exit ALL Positions (broker-level nuclear) */}
                <button onClick={handleExitAll} disabled={exitingAll}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg', TXT_CAPTION, 'font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap',
                    exitingAll
                      ? 'bg-red-900/40 border-red-800 text-red-400'
                      : confirmExitAll
                      ? 'bg-red-600 border-red-500 text-oncolor animate-pulse shadow-lg shadow-red-500/20'
                      : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300',
                    FOCUS_RING,
                  )}
                  title="Immediately liquidate ALL positions at broker level (DELETE /positions)">
                  {exitingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
                  {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
                </button>

                {/* Client-side minimum profit lock (total P&L floor) — leading
                    divider hidden, same note as Scalper.tsx's identical treatment. */}
                <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5 [&>span:first-child]:hidden">
                  <ProfitLockControls lock={profitLock} totalPnl={totalPnl} />
                </div>

                {/* Dhan → Zerodha trade replication (arm/disarm + multiplier) */}
                <div className="flex items-center gap-2 flex-nowrap shrink-0 bg-zinc-950/40 border border-zinc-800/60 rounded-xl px-3 py-1.5 [&>span:first-child]:hidden">
                  <CopyTradeControls copyTrade={copyTrade} />
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Centered underlying spot price strip with CE/PE Value Summary on Left */}
      {spot > 0 && (() => {
        const chg    = prevSpot > 0 ? spot - prevSpot : 0;
        const chgPct = prevSpot > 0 ? (chg / prevSpot) * 100 : 0;
        const isUp   = chg >= 0;
        return (
          <div className="flex flex-wrap justify-center items-center gap-3 px-4 pb-1 pt-0 select-none">
            {/* Real-time Total P&L Pill (Left Side of CE Value) */}
            <div className={`flex items-center gap-2 bg-zinc-900/80 border rounded-2xl px-4 py-2.5 shadow-lg font-mono text-xs ${
              totalPnl > 0
                ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-300'
                : totalPnl < 0
                ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
                : 'border-zinc-800 text-zinc-400'
            }`} title="Combined Realized + Unrealized P&L across open positions">
              <span className="text-[10px] font-extrabold uppercase bg-zinc-950 border border-zinc-800 px-1.5 py-0.5 rounded text-zinc-400">
                P&amp;L
              </span>
              <span className="font-bold text-sm tabular-nums">
                {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>

            {/* Total CE & PE Value Summary Pill */}
            <div className="flex items-center gap-2.5 bg-zinc-900/80 border border-zinc-800 rounded-2xl px-4 py-2.5 shadow-lg font-mono text-xs">
              {/* Total CE Value */}
              <div className="flex items-center gap-1.5" title="Net Call Value = Sum(short CE Qty × Price) − Sum(long CE Qty × Price)">
                <span className="text-[10px] font-extrabold uppercase text-emerald-400 bg-emerald-950/80 border border-emerald-800/60 px-1.5 py-0.5 rounded">
                  CE Val
                </span>
                <span className="font-bold text-emerald-300 tabular-nums">
                  ₹{totalCEVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <span className="text-zinc-700 font-sans">|</span>

              {/* Total PE Value */}
              <div className="flex items-center gap-1.5" title="Net Put Value = Sum(short PE Qty × Price) − Sum(long PE Qty × Price)">
                <span className="text-[10px] font-extrabold uppercase text-rose-400 bg-rose-950/80 border border-rose-800/60 px-1.5 py-0.5 rounded">
                  PE Val
                </span>
                <span className="font-bold text-rose-300 tabular-nums">
                  ₹{totalPEVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <span className="text-zinc-700 font-sans">|</span>

              {/* PE / CE value ratio — scale-free skew between the two sides */}
              <div className="flex items-center gap-1.5" title="Ratio = Total PE Value ÷ Total CE Value. 1.00 = balanced, above 1 = PE-heavy, below 1 = CE-heavy. Shows — when the CE side is flat.">
                <span className="text-[10px] font-extrabold uppercase text-amber-400 bg-amber-950/80 border border-amber-800/60 px-1.5 py-0.5 rounded">
                  PE/CE
                </span>
                <span className="font-bold text-zinc-200 tabular-nums">
                  {peCeRatio == null ? '—' : `${peCeRatio.toFixed(2)}x`}
                </span>
              </div>

              <span className="text-zinc-700 font-sans">|</span>

              {/* Difference (CE - PE) */}
              <div className="flex items-center gap-1.5" title="Difference = Total CE Value - Total PE Value">
                <span className="text-[10px] font-extrabold uppercase text-zinc-400 bg-zinc-950 border border-zinc-800 px-1.5 py-0.5 rounded">
                  Diff (CE-PE)
                </span>
                <span className={`font-bold tabular-nums ${
                  cePeDiff > 0 ? 'text-emerald-400' : cePeDiff < 0 ? 'text-rose-400' : 'text-zinc-400'
                }`}>
                  {cePeDiff >= 0 ? '+' : ''}₹{cePeDiff.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>

            {/* Index Spot Price Pill */}
            <div className="flex items-baseline gap-3 bg-zinc-900/60 border border-zinc-800 rounded-2xl px-6 py-2">
              <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">{underlying}</span>
              <span className="text-3xl font-bold font-mono tabular-nums text-white">
                {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {prevSpot > 0 && (
                <div className={`flex items-baseline gap-1.5 text-sm font-semibold font-mono tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                  <span>{isUp ? '▲' : '▼'}</span>
                  <span>{Math.abs(chg).toFixed(2)}</span>
                  <span className="text-xs opacity-80">({isUp ? '+' : ''}{chgPct.toFixed(2)}%)</span>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Every box keeps the width it would have in a full 5-box row
          ((100% - 4 gaps) / 5); fewer boxes are centered, not stretched. */}
      <div className="flex flex-row justify-center gap-3 p-4 overflow-x-auto select-none">
        {boxes.map(box => {
          const ltp = box.strike != null
            ? (liveQuotes?.strikes?.[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe']?.ltp ?? 0)
            : 0;
          const sideData = box.strike != null
            ? liveQuotes?.strikes?.[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe']
            : undefined;
          const pc = box.strike != null
            ? (prevClose[String(box.strike)]?.[box.side === 'CE' ? 'ce' : 'pe'] ?? sideData?.prev_close ?? 0)
            : 0;
          const pct = (ltp > 0 && pc > 0) ? ((ltp - pc) / pc) * 100 : (sideData?.change_pct ?? null);
          const high = sideData?.high ?? 0;
          const low  = sideData?.low ?? 0;

          const secId = boxSecId(box);
          const pos = secId ? positionsBySecId[secId] : undefined;
          const boxPnl = pos ? (Number(pos.realizedProfit) || 0) + (Number(pos.unrealizedProfit) || 0) : undefined;
          const hasOpenPosition = !!pos && Number(pos.netQty) !== 0;
          // 0 while the lot size is unresolved — openLots treats an unusable lot
          // size the same way, and the ½-move control stays disabled below.
          const boxOpenLots = pos && lotSize ? openLots(Number(pos.netQty), lotSize) : 0;

          return (
            <div key={box.id} className="flex-none w-[calc(20%-0.6rem)] min-w-[300px]">
              <OptionPanel
                side={box.side}
                label={box.side === 'CE' ? 'CALLS' : 'PUTS'}
                strike={box.strike}
                visibleStrikes={visibleStrikes}
                atm={atm}
                ltp={ltp}
                pct={pct}
                high={high}
                low={low}
                buildup={sideData?.buildup ?? ''}
                oiChgPct={sideData?.oi_chg_pct ?? 0}
                limitPrice={box.limitPrice}
                orderMode={orderMode}
                onStrikeChange={v => updateBox(box.id, { strike: v, limitPrice: '' })}
                onShiftUp={() => handleShiftStrike(box.id, 'UP')}
                onShiftDown={() => handleShiftStrike(box.id, 'DOWN')}
                moveFraction={box.moveFraction ?? 'FULL'}
                onMoveFractionChange={f => updateBox(box.id, { moveFraction: f })}
                halfMoveDisabled={boxOpenLots < 2}
                halfMoveDisabledReason={boxOpenLots === 0
                  ? 'No open position on this strike'
                  : `Needs ≥2 open lots — this leg has ${boxOpenLots} lot`}
                onLimitPriceChange={v => updateBox(box.id, { limitPrice: v })}
                onBuy={() => placeOrder(box.id, 'BUY')}
                onSell={() => placeOrder(box.id, 'SELL')}
                lots={box.lots}
                onLotsChange={l => updateBox(box.id, { lots: l })}
                onRemove={() => removeBox(box.id)}
                canRemove={boxes.length > MIN_BOXES && !hasOpenPosition}
                pnl={boxPnl}
                onSideChange={s => updateBox(box.id, { side: s, limitPrice: '' })}
                pending={orderPendingBoxes.has(box.id)}
                strikesReady={strikesReady}
              />
            </div>
          );
        })}

        {/* Both panels sit to the right of the last option box (the PE box in
            the default 2-box layout). Narrower than an option box — they only
            carry 3-4 numeric columns, so giving them a full box's 20% would
            waste width that the option boxes need for their price/OI blocks.
            Mounting is what starts each panel's polling; hidden costs nothing. */}
        {showTop10 && (
          <>
            <div className="flex-none w-[calc(18%-0.6rem)] min-w-[310px] flex flex-col">
              <TopWeightStocks className="h-full" />
            </div>
            <div className="flex-none w-[calc(18%-0.6rem)] min-w-[310px] flex flex-col">
              <TopIndices className="h-full" />
            </div>
          </>
        )}
      </div>

      {/* Live Combined Multi-Leg Strategy Banner */}
      {combinedStrategyStats.openLegsCount > 1 && combinedStrategyStats.entryCapitalSum > 0 && (
        <div className="mx-4 mb-3 flex items-center justify-between gap-3 bg-violet-950/70 border border-violet-700/60 rounded-xl px-4 py-2.5 shadow-lg">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs font-bold text-violet-300 uppercase tracking-wider">
              <Zap className="w-4 h-4 text-yellow-400" /> MULTI-LEG STRATEGY ({combinedStrategyStats.openLegsCount} LEGS ACTIVE)
            </span>
            <span className="text-xs font-mono text-zinc-300">
              Entry Capital Value: <strong className="text-white">₹{combinedStrategyStats.entryCapitalSum.toFixed(0)}</strong>
              {' '}&rarr; Current Value: <strong className="text-white">
                {combinedStrategyStats.liveCapitalSum < 0 ? '−' : ''}₹{Math.abs(combinedStrategyStats.liveCapitalSum).toFixed(0)}
              </strong>
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className={`text-xs font-bold font-mono tabular-nums px-2.5 py-1 rounded-lg border ${
              combinedStrategyStats.decayPct >= 0
                ? 'bg-emerald-900/60 border-emerald-500/40 text-emerald-300'
                : 'bg-rose-900/60 border-rose-500/40 text-rose-300'
            }`}>
              {combinedStrategyStats.decayPct >= 0 ? '+' : ''}{combinedStrategyStats.decayPct.toFixed(1)}% {
                combinedStrategyStats.decayPct >= 0
                  ? (combinedStrategyStats.isNetSeller ? 'Decay Captured' : 'Premium Growth')
                  : 'Loss'
              }
            </span>
          </div>
        </div>
      )}

      {/* Bottom tabs panel */}
      <div className="flex-1 flex flex-col mx-4 mb-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="flex items-center gap-1 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/40">
          {([
            ['positions', positionsData] as const,
            ['orders',    ordersData]    as const,
            ['trades',    tradesData]    as const,
            ['funds',     []]            as const,
            ['mtm',       []]            as const,
          ]).map(([tab, data]) => (
            <button key={tab} onClick={() => { setActiveTab(tab as typeof activeTab); setTableSort({ key: 'none', dir: 'asc' }); }}
              className={cn(
                'px-3 py-1.5 text-xs font-semibold rounded-lg transition-all capitalize',
                activeTab === tab
                  ? 'bg-zinc-700 text-zinc-100 border border-zinc-600'
                  : 'text-zinc-500 hover:text-zinc-300',
                FOCUS_RING,
              )}>
              {tab}{data.length > 0 ? ` (${data.length})` : ''}
            </button>
          ))}
          <button onClick={fetchTabData} disabled={tabLoading}
            className={cn(
              'ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg',
              'border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200',
              'transition-all disabled:opacity-50', FOCUS_RING,
            )}>
            <RefreshCw className={`w-3 h-3 ${tabLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Table content */}
        <div className="flex-1 overflow-auto">
          {activeTab === 'mtm' ? (
            <MtmChart data={mtmHistory} stats={mtmStats} source={mtmSource} />
          ) : activeTab === 'funds' ? (
            <FundsView
              data={fundsData}
              realizedPnl={enrichedPositions.reduce((sum, p) => sum + (Number(p.realizedProfit) || 0), 0)}
            />
          ) : activeTab === 'positions' ? (
            <PositionsTable
              data={enrichedPositions}
              guards={posGuards}
              closingPositions={closingPositions}
              onGuardChange={handleGuardChange}
              onTrailToggle={handleTrailToggle}
              onClose={pos => closePosition(pos, 'Manual')}
              onAddLeg={handleAddLeg}
              lotSizeFor={lotSizeForRow}
              onClosePartial={handleClosePartial}
              sort={tableSort}
              onSort={handleTableSort}
              error={positionsError}
            />
          ) : (
            <TabTable
              tab={activeTab}
              data={activeTab === 'orders' ? ordersData : tradesData}
              sort={tableSort}
              onSort={handleTableSort}
            />
          )}
        </div>
      </div>
    </div>
  );
}
