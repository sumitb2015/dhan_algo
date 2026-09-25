'use client';

import React, { useState, useMemo, useCallback } from 'react';
import {
  ChevronDown, ChevronUp, Trash2, Plus, Minus, X, Check, Layers, Sigma, Loader2, RefreshCw,
} from 'lucide-react';
import MultiLegLegRow from './MultiLegLegRow';
import RuleNumInput from './RuleNumInput';
import AddLotsModal from './AddLotsModal';
import AddNewLegModal from './AddNewLegModal';
import {
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, computeBasketStatus, computeCalendarPayoffCurve,
  classifyBasketStructure, legPnl,
  findSiblingLegCollisions, type SiblingLegCollision,
  type MultiLegBasket, type MultiLegLeg, type StrategyRiskConfig,
} from '@/lib/multiLegFocus';
import { computePayoff, type PayoffLeg, type PayoffResult } from '@/lib/basketStrategies';
import { computeBsGreeks, calculateTimeToExpiryYears } from '@/lib/optionsMonitorMath';
import { FOCUS_RING } from '@/components/Scalper';
import { clampShiftSteps, MAX_SHIFT_STEPS } from '@/lib/strikeShift';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import { StatChip } from '@/components/analytics/PayoffMetricStrip';
import { basketToGreekLegs, computeBasketGreeks } from '@/lib/multiLegGreeks';
import type { ChainOc } from '@/lib/optionsStrategy';

/** Dhan's option-chain API is rate limited (~1 call / 3.5 s per underlying). */
const GREEKS_CHAIN_SPACING_MS = 3_800;

/** Placeholder IV used only when no live chain IV is available yet for a leg's
 *  strike — same role as the `atmIv > 0 ? atmIv / 100 : 0.1313`-style fallback
 *  used elsewhere in the dashboard (Baskets.tsx), just without a tracked ATM
 *  IV of its own here. Never a claim about the real market IV. */
const FALLBACK_IV = 0.15;

type LegSortKey = 'side' | 'option' | 'strike' | 'lots' | 'ltp' | 'expiry' | 'margin' | 'pnl' | 'status';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
type Underlying = typeof UNDERLYINGS[number];

const STATUS_STYLE: Record<string, string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  PLACING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  OPEN:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  CLOSING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLOSED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  FAILED:  'bg-rose-500/10 text-rose-400 border-rose-500/20',
};

// Matches the broker badge colors already used in StrategyCard.tsx / StrategyRowWide.tsx.
const BROKER_STYLE: Record<string, string> = {
  dhan:    'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  zerodha: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  kotak:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
};

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export interface MultiLegStrategyRowProps {
  basket: MultiLegBasket;
  index: number;
  broker: Broker;
  hasAuthenticatedBroker: boolean;
  expiries: string[];
  allStrikes: number[];
  lotSize: number | null;
  step: number;
  atmStrike: number;
  spot?: number;
  ltpFor: (leg: MultiLegLeg) => number;
  ltpForStrike?: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
  /** Live chain IV (fraction) for a strike/option/expiry, 0 when not yet
   *  resolved — only consumed for a Calendar/Diagonal far leg's payoff curve. */
  ivForStrike?: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
  onUpdate: (patch: Partial<MultiLegBasket>) => void;
  onDelete: () => void;
  onPlace: () => Promise<void>;
  onExit: () => Promise<void>;
  onExitLeg: (leg: MultiLegLeg) => Promise<void>;
  /** Roll the given OPEN legs N strikes up/down (close, then reopen). */
  onShiftLegs?: (legIds: string[], direction: 'UP' | 'DOWN', steps: number) => Promise<void>;
  onAddLots?: (params: {
    legId: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    newSl?: number;
    newTp?: number;
  }) => Promise<void>;
  onAddNewLeg?: (params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    expiry?: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
  }) => Promise<void>;
  placing: boolean;
  exiting: boolean;
  exitingLegs: Set<string>;
  legMargins?: Record<string, number>;
  legMarginSource?: Record<string, 'live' | 'estimate'>;
  basketMargin?: number;
  basketMarginSource?: 'live' | 'estimate';
  overallMargin?: number;
  hedgeBenefit?: number;
  availableFunds?: number;
  /** Keyed `${basketId}:${legId}` — see MultiLegFocus.tsx's legQtyWarnings. */
  legQtyWarnings?: Record<string, { ownQty: number; brokerQty: number }>;
  /** All baskets on the page — used only to flag Greeks legs that share a contract with a sibling. */
  allBaskets?: MultiLegBasket[];
}

export default function MultiLegStrategyRow({
  basket,
  index,
  broker,
  hasAuthenticatedBroker,
  expiries,
  allStrikes,
  lotSize,
  step,
  atmStrike,
  spot,
  ltpFor,
  ltpForStrike,
  ivForStrike,
  onUpdate,
  onDelete,
  onPlace,
  onExit,
  onExitLeg,
  onShiftLegs,
  onAddLots,
  onAddNewLeg,
  placing,
  exiting,
  exitingLegs,
  legMargins,
  legMarginSource,
  basketMargin,
  basketMarginSource,
  overallMargin,
  hedgeBenefit,
  availableFunds,
  legQtyWarnings,
  allBaskets,
}: MultiLegStrategyRowProps) {
  // Existing/already-placed positions default collapsed (this page can carry
  // several parallel strategies, most of them just sitting open) — the user
  // expands via the chevron when they want the legs table. A brand-new DRAFT
  // basket (built from a preset or "New Strategy Row") stays expanded since
  // the user is actively configuring its legs. Lazy-init only: placing a
  // basket after mount must not yank it closed on the user mid-interaction.
  const [expanded, setExpanded] = useState(() => !basket.legs.some(l => l.status !== 'DRAFT'));
  // The payoff chart is a big element and every strategy row already opens
  // expanded by default once it has a placed leg (see `expanded` above) — so
  // without its own collapse this chart would be the first thing shoved in
  // front of every row's legs table on load. Collapsed by default; the user
  // opens it only when they actually want to look at the curve.
  const [showPayoffChart, setShowPayoffChart] = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const [shiftSteps, setShiftSteps] = useState(1);   // per-strategy Steps stepper (UI only, not persisted)
  const [shifting, setShifting] = useState(false);
  const runShift = useCallback(async (legIds: string[], direction: 'UP' | 'DOWN') => {
    if (!onShiftLegs || !legIds.length) return;
    setShifting(true);
    try { await onShiftLegs(legIds, direction, shiftSteps); } finally { setShifting(false); }
  }, [onShiftLegs, shiftSteps]);
  const [selectedLegForAddLots, setSelectedLegForAddLots] = useState<MultiLegLeg | null>(null);
  const [isAddNewLegModalOpen, setIsAddNewLegModalOpen] = useState<boolean>(false);

  // Legs-table view state: purely presentational (never written back to the
  // basket). Sorting is opt-in — with no sort key the legs keep their stored
  // order, so a draft leg being edited doesn't jump rows as its strike changes.
  const [legFilter, setLegFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [legSort, setLegSort] = useState<{ key: LegSortKey; dir: 'asc' | 'desc' } | null>(null);
  const toggleLegSort = useCallback((key: LegSortKey) => {
    setLegSort(prev => (!prev || prev.key !== key) ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null);
  }, []);

  const hasPlacedLeg = useMemo(() => {
    return basket.legs.some(l => l.status !== 'DRAFT');
  }, [basket.legs]);

  const hasActivePositions = useMemo(() => {
    return basket.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING' || l.status === 'CLOSING');
  }, [basket.legs]);

  const basketStatus = useMemo(() => computeBasketStatus(basket.legs), [basket.legs]);

  const legCounts = useMemo(() => {
    let closed = 0;
    for (const l of basket.legs) if (l.status === 'CLOSED') closed++;
    return { all: basket.legs.length, closed, open: basket.legs.length - closed };
  }, [basket.legs]);

  const crudeMult = broker === 'dhan'
    ? (basket.underlying === 'CRUDEOIL' ? 100 : basket.underlying === 'CRUDEOILM' ? 10 : 1)
    : 1;

  const visibleLegs = useMemo(() => {
    // No closed legs → chips are hidden, so a stale 'open'/'closed' filter must not linger.
    const filter = legCounts.closed > 0 ? legFilter : 'all';
    let legs = filter === 'all' ? basket.legs
      : basket.legs.filter(l => (filter === 'closed') === (l.status === 'CLOSED'));
    if (legSort) {
      const val = (l: MultiLegLeg): number | string => {
        switch (legSort.key) {
          case 'side': return l.side;
          case 'option': return l.option;
          case 'strike': return l.strike;
          case 'lots': return l.lots;
          case 'ltp': return ltpFor(l);
          case 'expiry': return l.expiry || basket.expiry;
          case 'margin': return legMargins?.[l.id] ?? 0;
          case 'pnl': return l.fill ? legPnl(l, ltpFor(l), crudeMult) : 0;
          case 'status': return l.status;
        }
      };
      const dir = legSort.dir === 'asc' ? 1 : -1;
      legs = [...legs].sort((x, y) => {
        const a = val(x), b = val(y);
        return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * dir;
      });
    }
    return legs;
  }, [basket.legs, basket.expiry, legCounts.closed, legFilter, legSort, ltpFor, legMargins, crudeMult]);

  const stratMetrics = useMemo(
    () => computeStrategyMetrics(basket.legs, ltpFor, crudeMult),
    [basket.legs, ltpFor, crudeMult],
  );
  const totalPnl = stratMetrics.totalPnlRupees;

  const defaultLotSize = useMemo(() => {
    if (lotSize && lotSize > 0) return lotSize;
    if (basket.underlying === 'NIFTY') return 65;
    if (basket.underlying === 'BANKNIFTY') return 15;
    if (basket.underlying === 'SENSEX') return 20;
    return broker === 'dhan' ? 1 : (basket.underlying === 'CRUDEOIL' ? 100 : 10);
  }, [lotSize, basket.underlying, broker]);

  // On-demand Greeks: nothing is fetched until the user clicks the button.
  const [greeks, setGreeks] = useState<{
    result: ReturnType<typeof computeBasketGreeks>; at: Date; errors: string[];
    collisions: SiblingLegCollision[];
  } | null>(null);
  const [greeksLoading, setGreeksLoading] = useState(false);
  const [greeksOpen, setGreeksOpen] = useState(false);
  const greeksReq = React.useRef(0);
  const runGreeks = useCallback(async () => {
    const legs = basketToGreekLegs(basket, defaultLotSize, crudeMult);
    setGreeksOpen(true);
    if (!legs.length) { setGreeks({ result: computeBasketGreeks([], {}), at: new Date(), errors: [], collisions: [] }); return; }
    const req = ++greeksReq.current;
    setGreeksLoading(true);
    const expiriesNeeded = [...new Set(legs.map(l => l.expiry))];
    const chains: Record<string, ChainOc | undefined> = {};
    const errors: string[] = [];
    for (let i = 0; i < expiriesNeeded.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, GREEKS_CHAIN_SPACING_MS));
      const ex = expiriesNeeded[i];
      try {
        // No `broker` param — greeks always come from Dhan's chain.
        const res = await fetch(`/api/options/chain?underlying=${basket.underlying}&expiry=${ex}`);
        const json = await res.json();
        if (!json?.success || !json.data?.chain?.oc) errors.push(`${ex}: ${json?.error ?? 'chain unavailable'}`);
        else chains[ex] = json.data.chain.oc as ChainOc;
      } catch (e) {
        errors.push(`${ex}: ${String((e as Error).message ?? e)}`);
      }
    }
    if (req !== greeksReq.current) return; // superseded by a newer click
    // Sibling baskets holding the same contract share one netted broker row,
    // so this basket's own ledger quantity may not match the broker's.
    const collisions = allBaskets
      ? findSiblingLegCollisions(allBaskets, basket.id, legs.map(l => ({ side: l.side, option: l.option, strike: l.strike, expiry: l.expiry })))
      : [];
    setGreeks({ result: computeBasketGreeks(legs, chains), at: new Date(), errors, collisions });
    setGreeksLoading(false);
  }, [basket, allBaskets, defaultLotSize, crudeMult]);




  // Calendar/Diagonal strategies stage legs on two different expiries — a
  // single "payoff at expiry, both legs at intrinsic value" curve/BE/max-P&L
  // isn't meaningful across two different expiration dates (see
  // dhan-payoff-diagrams skill's "hasMixedExpiry" pattern in Baskets.tsx), so
  // the ordinary computePayoff()-based numbers below are suppressed in favor
  // of the dedicated calendarCurve computed further down. Only counts
  // still-active legs — a CLOSED leg's stale expiry must not permanently pin
  // this flag once it's exited, or a partial exit (e.g. closing just the far
  // leg) would suppress a real payoff for the remaining single-expiry leg
  // forever.
  const hasMixedExpiry = useMemo(
    () => basket.legs.some(l => l.status !== 'CLOSED' && l.expiry && l.expiry !== basket.expiry),
    [basket.legs, basket.expiry],
  );

  // Re-derived from the live legs rather than trusting the stored preset
  // label, which is frozen at creation and goes stale the moment a leg is
  // edited (strike moved, ratio changed) — see classifyBasketStructure's
  // doc comment. Skipped for Calendar/Diagonal baskets: the classifier is
  // strike-only and has no notion of `expiry`, so it can't tell a same-strike
  // calendar from a naked leg.
  const derivedStructure = useMemo(
    () => (hasMixedExpiry ? null : classifyBasketStructure(basket.legs)),
    [basket.legs, hasMixedExpiry],
  );
  const strategyLabel = derivedStructure?.structure
    ?? (basket.presetKey ? basket.presetKey.replace(/-/g, ' ') : (basket.name ?? `Strategy #${index + 1}`));

  // The Calendar/Diagonal spread's actual payoff shape: strategy value AS OF
  // THE NEAR (front) LEG'S EXPIRY, where the front leg is pure intrinsic and
  // the far leg still carries residual Black-76/Black-Scholes time value —
  // see computeCalendarPayoffCurve's own doc comment for why this (not a
  // same-day-both-legs-at-intrinsic curve) is the economically meaningful one.
  const calendarCurve = useMemo(() => {
    if (!hasMixedExpiry || !basket.farExpiry || !spot || spot <= 0) return null;
    const activeLegs = basket.legs.filter(l => l.status !== 'CLOSED');
    if (activeLegs.length === 0) return null;

    const legs = activeLegs.map(l => {
      const legExpiry = l.expiry || basket.expiry;
      const isFar = legExpiry !== basket.expiry;
      const entryPrice = (l.fill?.avgPrice && l.fill.avgPrice > 0)
        ? l.fill.avgPrice
        : (ltpFor(l) > 0 ? ltpFor(l) : (l.price || 0));
      const qty = ((l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : (l.lots * defaultLotSize)) * crudeMult;
      const iv = isFar ? (ivForStrike?.(l.strike, l.option, legExpiry) || FALLBACK_IV) : FALLBACK_IV;
      return { side: l.side, option: l.option, strike: l.strike, qty, entryPrice, iv, expiry: legExpiry };
    });

    if (legs.some(l => l.entryPrice <= 0)) return null;

    try {
      return computeCalendarPayoffCurve(legs, spot, basket.expiry, basket.farExpiry, step || 50);
    } catch {
      return null;
    }
  }, [hasMixedExpiry, basket.farExpiry, basket.expiry, basket.legs, spot, step, defaultLotSize, crudeMult, ltpFor, ivForStrike]);

  // ── Payoff: Breakevens, Max Profit, Max Loss ───────────────────────
  const payoffResult: PayoffResult | null = useMemo(() => {
    if (hasMixedExpiry) return null;
    if (!basket.legs || basket.legs.length === 0) return null;
    const activeLegs = basket.legs.filter(l => l.status !== 'CLOSED');
    if (activeLegs.length === 0) return null;

    const payoffMultiplier = (broker === 'dhan' && (basket.underlying === 'CRUDEOIL' || basket.underlying === 'CRUDEOILM')) ? crudeMult : 1;

    const payoffLegs: PayoffLeg[] = activeLegs.map(l => {
      const currentLtp = ltpFor(l);
      const premium = (l.fill?.avgPrice && l.fill.avgPrice > 0)
        ? l.fill.avgPrice
        : (currentLtp > 0 ? currentLtp : (l.price || 0));
      const qty = ((l.fill?.qty && l.fill.qty > 0)
        ? l.fill.qty
        : (l.lots * defaultLotSize)) * payoffMultiplier;
      return {
        side: l.side,
        option: l.option,
        strike: l.strike,
        premium,
        qty,
      };
    });

    const strikes = payoffLegs.map(l => l.strike);
    if (strikes.length === 0) return null;
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const span = Math.max(Math.round(minStrike * 0.08), (maxStrike - minStrike) * 2, 1200);
    const lo = Math.max(0, minStrike - span);
    const hi = maxStrike + span;

    try {
      return computePayoff(payoffLegs, lo, hi);
    } catch {
      return null;
    }
  }, [basket.legs, basket.underlying, lotSize, ltpFor, hasMixedExpiry]);

  // ── T+0 live mark-to-market curve (dhan-payoff-diagrams: every payoff
  // diagram must plot this alongside the at-expiry curve) ────────────────
  // Reuses whichever expiry-side curve (calendarCurve or payoffResult) is
  // active purely for its x-axis samples, so both lines share one x grid and
  // can never visually drift apart — then prices each leg today via
  // Black-76/Black-Scholes (computeBsGreeks) at that leg's OWN expiry and IV,
  // not the basket's front expiry, so a calendar spread's far leg still
  // carries its own residual time value in the T+0 curve too. Missing IV
  // falls back to FALLBACK_IV same as the calendar curve above; a leg with
  // no resolvable premium yet (nothing filled, no live LTP) makes the whole
  // curve return null rather than drawing a partially-wrong line — the
  // PayoffDiagram component treats a missing todayCurve as "nothing to show
  // yet", not an error.
  //
  // Gated on `showPayoffChart`: unlike payoffResult/calendarCurve (which also
  // feed the always-visible header stats), this curve is ONLY ever consumed
  // by the collapsed-by-default chart below. `ltpFor` is a fresh closure every
  // parent render, so without this gate every collapsed strategy row would
  // re-run Black-Scholes over ~120-240 samples on every WebSocket tick for a
  // chart nobody has opened.
  const todayCurve = useMemo(() => {
    if (!showPayoffChart) return null;
    if (!spot || spot <= 0) return null;
    const xs = hasMixedExpiry ? calendarCurve?.points.map(p => p.x) : payoffResult?.points.map(p => p.x);
    if (!xs || xs.length === 0) return null;

    const activeLegs = basket.legs.filter(l => l.status !== 'CLOSED');
    if (activeLegs.length === 0) return null;

    const payoffMultiplier = (broker === 'dhan' && (basket.underlying === 'CRUDEOIL' || basket.underlying === 'CRUDEOILM')) ? crudeMult : 1;

    const legsForPricing = activeLegs.map(l => {
      const legExpiry = l.expiry || basket.expiry;
      const currentLtp = ltpFor(l);
      const premium = (l.fill?.avgPrice && l.fill.avgPrice > 0)
        ? l.fill.avgPrice
        : (currentLtp > 0 ? currentLtp : (l.price || 0));
      const qty = ((l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : (l.lots * defaultLotSize)) * payoffMultiplier;
      const iv = ivForStrike?.(l.strike, l.option, legExpiry) || FALLBACK_IV;
      const timeYears = calculateTimeToExpiryYears(legExpiry);
      return { side: l.side, option: l.option, strike: l.strike, premium, qty, iv, timeYears };
    });

    if (legsForPricing.some(l => l.premium <= 0)) return null;

    try {
      return xs.map(x => {
        const pnl = legsForPricing.reduce((sum, l) => {
          // isFutures=false: standard Black-Scholes on spot, which already
          // embeds cost-of-carry via the r*t drift term — the documented
          // fallback for when no live futures price is wired to this page.
          const price = computeBsGreeks(l.option, x, l.strike, l.timeYears, l.iv, 1).price;
          const perUnit = l.side === 'B' ? (price - l.premium) : (l.premium - price);
          return sum + perUnit * l.qty;
        }, 0);
        return { spot: x, pnl };
      });
    } catch {
      return null;
    }
  }, [showPayoffChart, spot, hasMixedExpiry, calendarCurve, payoffResult, basket.legs, basket.underlying, basket.expiry, broker, crudeMult, defaultLotSize, ltpFor, ivForStrike]);

  const breakevensDisplay = useMemo(() => {
    if (!payoffResult || payoffResult.breakevens.length === 0) return 'None';
    return payoffResult.breakevens.map(b => {
      const pct = spot && spot > 0 ? ((b - spot) / spot) * 100 : null;
      const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
      return `${Math.round(b).toLocaleString('en-IN')}${pctStr}`;
    }).join(' — ');
  }, [payoffResult, spot]);

  const maxProfitDisplay = useMemo(() => {
    if (!payoffResult) return '—';
    if (payoffResult.maxProfitUnlimited) return 'Unlimited';
    return payoffResult.maxProfit > 0 ? `+${fmtMoney(payoffResult.maxProfit)}` : fmtMoney(payoffResult.maxProfit);
  }, [payoffResult]);

  // Max profit as a % of margin blocked — a return-on-capital measure, since
  // rupee P&L alone doesn't say whether a trade is worth the margin it ties up.
  const maxProfitPctOfMargin = useMemo(() => {
    if (!payoffResult || payoffResult.maxProfitUnlimited || !basketMargin || basketMargin <= 0) return null;
    return (payoffResult.maxProfit / basketMargin) * 100;
  }, [payoffResult, basketMargin]);

  const maxLossDisplay = useMemo(() => {
    if (!payoffResult) return '—';
    if (payoffResult.maxLossUnlimited) return 'Unlimited';
    return fmtMoney(payoffResult.maxLoss);
  }, [payoffResult]);

  // Same "None"/"Undefined" language brokers use for a calendar spread whose
  // sampled window never crosses zero (a pure debit calendar's theoretical
  // value curve is often entirely positive or entirely negative in-range).
  const calendarBreakevensDisplay = useMemo(() => {
    if (!calendarCurve || calendarCurve.breakevens.length === 0) return 'Undefined';
    return calendarCurve.breakevens.map(b => {
      const pct = spot && spot > 0 ? ((b - spot) / spot) * 100 : null;
      const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
      return `${Math.round(b).toLocaleString('en-IN')}${pctStr}`;
    }).join(' — ');
  }, [calendarCurve, spot]);

  const calendarMaxProfitDisplay = useMemo(() => {
    if (!calendarCurve) return '—';
    return calendarCurve.maxPnl > 0 ? `+${fmtMoney(calendarCurve.maxPnl)}` : fmtMoney(calendarCurve.maxPnl);
  }, [calendarCurve]);

  const calendarMaxLossDisplay = useMemo(() => {
    if (!calendarCurve) return '—';
    return fmtMoney(calendarCurve.minPnl);
  }, [calendarCurve]);

  const strategyRisk: StrategyRiskConfig = useMemo(() => {
    return basket.riskConfig ?? {
      targetValue: undefined,
      targetUnit: 'pts',
      slValue: undefined,
      slUnit: 'pts',
      armed: false,
    };
  }, [basket.riskConfig]);

  const updateRisk = useCallback((patch: Partial<StrategyRiskConfig>) => {
    const nextRisk: StrategyRiskConfig = { ...strategyRisk, ...patch };
    onUpdate({ riskConfig: nextRisk });
  }, [strategyRisk, onUpdate]);

  const updateLeg = useCallback((legId: string, patch: Partial<MultiLegLeg>) => {
    const updatedLegs = basket.legs.map(l => {
      if (l.id !== legId) return l;
      if (hasPlacedLeg) {
        // Allow live editing of risk rules even when active
        const allowed: Partial<MultiLegLeg> = {};
        if ('sl' in patch) allowed.sl = patch.sl;
        if ('slType' in patch) allowed.slType = patch.slType;
        if ('tp' in patch) allowed.tp = patch.tp;
        if ('tpType' in patch) allowed.tpType = patch.tpType;
        if ('trail' in patch) allowed.trail = patch.trail;
        return { ...l, ...allowed };
      }
      return { ...l, ...patch };
    });
    onUpdate({ legs: updatedLegs });
  }, [basket.legs, hasPlacedLeg, onUpdate]);

  const removeLeg = useCallback((legId: string) => {
    if (hasPlacedLeg) return;
    onUpdate({ legs: basket.legs.filter(l => l.id !== legId) });
  }, [basket.legs, hasPlacedLeg, onUpdate]);

  const addBlankLeg = useCallback(() => {
    if (hasPlacedLeg) return;
    const atm = atmStrike > 0 ? atmStrike : (allStrikes[0] ?? 24000);
    const newLeg: MultiLegLeg = {
      id: `mll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      side: 'S',
      option: 'CE',
      strike: atm,
      expiry: basket.expiry,
      lots: 1,
      type: 'MARKET',
      status: 'DRAFT',
    };
    onUpdate({ legs: [...basket.legs, newLeg] });
  }, [hasPlacedLeg, atmStrike, allStrikes, basket.legs, onUpdate]);

  // Only blocks once margin has actually been computed for this exact
  // composition — before that resolves, `basketMargin` is undefined and this
  // stays false so a fresh strategy isn't blocked on a number that hasn't
  // loaded yet. onPlace (MultiLegFocus.tsx's placeBasket) re-checks the same
  // condition right before firing orders, so a stale/disabled-but-clicked
  // button can't bypass it.
  const insufficientMargin = basketMargin != null && availableFunds != null && basketMargin > availableFunds;

  const handlePlace = () => {
    if (insufficientMargin) return;
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    onPlace();
  };

  return (
    <div className="border border-zinc-800 bg-zinc-900/50 rounded-xl overflow-hidden shadow-lg transition-all">
      {/* Strategy Header Bar — the collapsed state's entire summary, so this
         must never wrap to a second line: flex-nowrap everywhere here, with a
         horizontal scroll escape hatch only if a viewport is genuinely too
         narrow to fit it (full detail is one click away via the chevron, this
         row's job is just the at-a-glance summary). */}
      <div className="px-3 py-2 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between gap-3 flex-nowrap overflow-x-auto">
        <div className="flex items-center gap-2.5 flex-nowrap shrink-0">
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
            title={expanded ? 'Collapse strategy' : 'Expand strategy'}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-zinc-100 uppercase tracking-wider">
              {strategyLabel}
            </span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLE[basketStatus]}`}>
              {basketStatus}
            </span>
            {/* This strategy is permanently bound to whichever broker created it — fills/exits
               always route through it regardless of the page-level broker selector, so it needs
               its own label or switching that selector looks like it does nothing. */}
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${
                BROKER_STYLE[basket.broker] ?? 'bg-zinc-800 text-zinc-300 border-zinc-700'
              }`}
              title="This strategy's orders always route through this broker, regardless of the broker selected above"
            >
              {BROKER_LABELS[basket.broker as Broker] ?? basket.broker}
            </span>
          </div>

          {/* Underlying + Expiry — a placed basket can't change either (the
             disabled selects below were just dead weight eating header width
             on every already-open row, which is most rows most of the time),
             so show them as plain compact text once placed and keep the real
             editable dropdowns only for a still-DRAFT basket. */}
          {hasPlacedLeg ? (
            <span className="text-xs font-bold text-zinc-300 whitespace-nowrap">
              {basket.underlying} <span className="text-zinc-600">·</span> {basket.expiry}
              {hasMixedExpiry && basket.farExpiry && (
                <span className="text-fuchsia-400"> / {basket.farExpiry}</span>
              )}
            </span>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <label className="text-[10px] text-zinc-400 font-semibold uppercase">Index:</label>
                <select
                  value={basket.underlying}
                  onChange={e => onUpdate({ underlying: e.target.value })}
                  className="h-7 bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs font-bold rounded px-2 focus:outline-none focus:border-emerald-500"
                >
                  {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <label className="text-[10px] text-zinc-400 font-semibold uppercase">Expiry:</label>
                <select
                  value={basket.expiry}
                  onChange={e => onUpdate({ expiry: e.target.value })}
                  className="h-7 bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs font-bold rounded px-2 focus:outline-none focus:border-emerald-500"
                >
                  {!expiries.includes(basket.expiry) && basket.expiry && (
                    <option value={basket.expiry}>{basket.expiry}</option>
                  )}
                  {expiries.map(exp => <option key={exp} value={exp}>{exp}</option>)}
                </select>
              </div>

              {/* Far Expiry — only meaningful for a Calendar/Diagonal strategy
                 (a preset with a 'far' leg, or a leg someone toggled to FAR
                 in the table below). Legs already on FAR keep their current
                 expiry until the user re-toggles them onto the new value. */}
              {(hasMixedExpiry || basket.presetKey?.includes('calendar') || basket.presetKey?.includes('diagonal')) && (
                <div className="flex items-center gap-1">
                  <label className="text-[10px] text-fuchsia-400 font-semibold uppercase">Far Expiry:</label>
                  <select
                    value={basket.farExpiry ?? ''}
                    onChange={e => onUpdate({ farExpiry: e.target.value || undefined })}
                    className="h-7 bg-zinc-950 border border-fuchsia-500/40 text-zinc-200 text-xs font-bold rounded px-2 focus:outline-none focus:border-fuchsia-500"
                  >
                    {!expiries.some(e => e !== basket.expiry) && (
                      <option value="">No 2nd expiry listed</option>
                    )}
                    {/* Stray option for a stored farExpiry that has since rolled
                       off the live expiries list — mirrors the Expiry select
                       above so the dropdown always reflects what's actually
                       persisted instead of silently defaulting to another
                       value. */}
                    {basket.farExpiry && !expiries.includes(basket.farExpiry) && (
                      <option value={basket.farExpiry}>{basket.farExpiry}</option>
                    )}
                    {expiries.filter(exp => exp !== basket.expiry).map(exp => (
                      <option key={exp} value={exp}>{exp}</option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right Side: Breakevens, Max P/L, Total P&L & Strategy Actions */}
        <div className="flex items-center gap-2 flex-nowrap shrink-0">
          {hasMixedExpiry ? (
            <div
              className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-zinc-950 border border-fuchsia-500/20 text-xs font-mono"
              title="Calendar/Diagonal value as of the near leg's expiry — see the payoff curve below for the full shape"
            >
              <div className="flex items-center gap-1">
                <span className="text-fuchsia-400 text-[10px] uppercase font-semibold">BE:</span>
                <span className="text-zinc-200 font-bold">{calendarBreakevensDisplay}</span>
              </div>
              <span className="text-zinc-700">·</span>
              <div className="flex items-center gap-1">
                <span className="text-fuchsia-400 text-[10px] uppercase font-semibold">Max P/L:</span>
                <span className="text-emerald-400 font-bold">{calendarMaxProfitDisplay}</span>
                <span className="text-zinc-600">/</span>
                <span className="text-rose-400 font-bold">{calendarMaxLossDisplay}</span>
              </div>
            </div>
          ) : payoffResult && (
            <div className="hidden md:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-xs font-mono" title="Strategy Payoff: Breakevens & Max Profit / Loss">
              <div className="flex items-center gap-1">
                <span className="text-zinc-500 text-[10px] uppercase font-semibold">BE:</span>
                <span className="text-zinc-200 font-bold">{breakevensDisplay}</span>
              </div>
              <span className="text-zinc-700">·</span>
              <div className="flex items-center gap-1">
                <span className="text-zinc-500 text-[10px] uppercase font-semibold">Max P/L:</span>
                <span className="text-emerald-400 font-bold">
                  {maxProfitDisplay}
                  {maxProfitPctOfMargin != null && (
                    <span className="text-[10px] opacity-80"> ({maxProfitPctOfMargin >= 0 ? '+' : ''}{maxProfitPctOfMargin.toFixed(1)}% of margin)</span>
                  )}
                </span>
                <span className="text-zinc-600">/</span>
                <span className="text-rose-400 font-bold">{maxLossDisplay}</span>
              </div>
            </div>
          )}

          {/* Strategy Total P&L */}
          <span className={`h-7 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums border ${
            totalPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
          }`}>
            {totalPnl >= 0 ? '+' : ''}{fmtMoney(totalPnl)}
            {stratMetrics.combinedEntryPts > 0 && (
              <span className="ml-1.5 text-[10px] opacity-80">
                ({stratMetrics.pnlPct >= 0 ? '+' : ''}{stratMetrics.pnlPct.toFixed(1)}%)
              </span>
            )}
          </span>

          <button
            type="button"
            onClick={runGreeks}
            disabled={greeksLoading}
            title="Compute Net Delta / Gamma / Theta / Vega for this strategy (fetches the option chain now)"
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 disabled:opacity-50 ${FOCUS_RING}`}
          >
            {greeksLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sigma className="w-3 h-3" />}
            Greeks
          </button>

          {/* Draft Actions */}
          {!hasPlacedLeg && (
            <>
              <button
                type="button"
                onClick={addBlankLeg}
                className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 ${FOCUS_RING}`}
              >
                <Plus className="w-3 h-3" /> Add Leg
              </button>
              {basket.legs.length > 0 && (
                <button
                  type="button"
                  onClick={handlePlace}
                  disabled={placing || insufficientMargin}
                  title={insufficientMargin
                    ? `Needs ~${fmtMoney(basketMargin!)} margin but only ${fmtMoney(availableFunds!)} is available`
                    : undefined}
                  className={`h-7 px-3 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border transition-all disabled:opacity-50 ${
                    insufficientMargin
                      ? 'bg-rose-500/10 border-rose-500/40 text-rose-300'
                      : confirmPlace
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                      : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20'
                  } ${FOCUS_RING}`}
                >
                  {placing ? 'Placing…' : insufficientMargin ? 'Insufficient Margin' : confirmPlace ? 'Confirm Place?' : 'Place Basket'}
                </button>
              )}
            </>
          )}

          {/* Open Strategy Actions */}
          {basket.legs.some(l => l.status === 'OPEN' || l.status === 'CLOSING') && (
            <div className="flex items-center gap-1.5">
              {onShiftLegs && (() => {
                const openLegs = basket.legs.filter(l => l.status === 'OPEN');
                if (!openLegs.length) return null;
                const busy = placing || exiting || shifting;
                const groups: { label: string; ids: string[] }[] = [
                  { label: 'CE', ids: openLegs.filter(l => l.option === 'CE').map(l => l.id) },
                  { label: 'PE', ids: openLegs.filter(l => l.option === 'PE').map(l => l.id) },
                  { label: 'All', ids: openLegs.map(l => l.id) },
                ].filter((g, i, arr) => g.ids.length > 0 && !(g.label !== 'All' && g.ids.length === arr[arr.length - 1].ids.length));
                const btn = `h-7 w-6 inline-flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;
                return (
                  <div className="flex items-center gap-1.5">
                    <div className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden" title="Strikes moved per shift click">
                      <button type="button" className={btn} disabled={busy || shiftSteps <= 1}
                        aria-label="Decrease shift steps" onClick={() => setShiftSteps(n => clampShiftSteps(n - 1))}>
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="px-1.5 text-[11px] font-mono font-bold text-zinc-200 tabular-nums" aria-live="polite">
                        {shiftSteps}<span className="text-zinc-500 font-sans font-semibold"> step{shiftSteps > 1 ? 's' : ''}</span>
                      </span>
                      <button type="button" className={btn} disabled={busy || shiftSteps >= MAX_SHIFT_STEPS}
                        aria-label="Increase shift steps" onClick={() => setShiftSteps(n => clampShiftSteps(n + 1))}>
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    {groups.map(g => (
                      <div key={g.label} className="inline-flex items-center rounded-lg border border-zinc-700 overflow-hidden">
                        <span className="px-1.5 text-[10px] font-bold text-zinc-400 bg-zinc-900">{g.label}</span>
                        <button type="button" className={`${btn} border-l border-zinc-700`} disabled={busy}
                          aria-label={`Shift ${g.label === 'All' ? 'all open legs' : `${g.label} legs`} down ${shiftSteps} strike${shiftSteps > 1 ? 's' : ''}`}
                          title={`Roll ${g.label === 'All' ? 'all open legs' : `${g.label} legs`} down ${shiftSteps}`}
                          onClick={() => runShift(g.ids, 'DOWN')}>
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" className={`${btn} border-l border-zinc-700`} disabled={busy}
                          aria-label={`Shift ${g.label === 'All' ? 'all open legs' : `${g.label} legs`} up ${shiftSteps} strike${shiftSteps > 1 ? 's' : ''}`}
                          title={`Roll ${g.label === 'All' ? 'all open legs' : `${g.label} legs`} up ${shiftSteps}`}
                          onClick={() => runShift(g.ids, 'UP')}>
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {shifting && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" aria-label="Shifting" />}
                  </div>
                );
              })()}
              {onAddNewLeg && (
                <button
                  type="button"
                  onClick={() => setIsAddNewLegModalOpen(true)}
                  disabled={shifting}
                  title="Add a new leg to this active strategy"
                  className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
                >
                  <Plus className="w-3 h-3" /> Add Leg
                </button>
              )}
              <button
                type="button"
                onClick={onExit}
                disabled={exiting || shifting}
                className={`h-7 px-3 text-[11px] font-bold rounded-lg border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50 ${FOCUS_RING}`}
              >
                {exiting ? 'Exiting…' : 'Exit Strategy'}
              </button>
            </div>
          )}

          {/* Delete Row button — strictly disabled when positions are active to prevent losing tracking */}
          <button
            type="button"
            onClick={() => {
              if (hasActivePositions) return;
              onDelete();
            }}
            disabled={hasActivePositions}
            title={hasActivePositions ? "Cannot delete strategy row while positions are active — exit positions first" : "Delete this strategy row"}
            className={`p-1 transition-colors ${
              hasActivePositions
                ? "text-zinc-700 cursor-not-allowed opacity-30"
                : "text-zinc-500 hover:text-rose-400"
            }`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {greeksOpen && (
        <div className="px-4 py-2.5 border-t border-zinc-800/80 bg-zinc-950/40 flex flex-col gap-2">
          {greeksLoading && !greeks ? (
            <div className="flex items-center gap-2 text-xs text-zinc-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" /> Loading option chain…
            </div>
          ) : greeks && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex flex-wrap items-center rounded-lg border border-zinc-800/80 bg-zinc-950/60 py-1.5">
                  <StatChip label="Net Delta" value={greeks.result.net.delta.toFixed(2)}
                    color={greeks.result.net.delta > 0 ? 'text-emerald-400' : greeks.result.net.delta < 0 ? 'text-red-400' : 'text-zinc-100'} />
                  <StatChip label="Net Gamma" value={greeks.result.net.gamma.toFixed(4)}
                    color={greeks.result.net.gamma < 0 ? 'text-rose-400' : 'text-zinc-100'} />
                  <StatChip label="Net Theta" value={`₹${greeks.result.net.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                    sub="per day" color={greeks.result.net.theta > 0 ? 'text-emerald-400' : 'text-red-400'} />
                  <StatChip label="Net Vega" value={greeks.result.net.vega.toFixed(2)} sub="per 1 vol pt"
                    color={greeks.result.net.vega < 0 ? 'text-rose-400' : 'text-zinc-100'} />
                  <StatChip label="Legs" value={String(greeks.result.legs.length)} />
                </div>
                <span className="text-[10px] text-zinc-500">as of {greeks.at.toLocaleTimeString('en-IN')}</span>
                <button type="button" onClick={runGreeks} disabled={greeksLoading} aria-label="Recompute greeks"
                  className={`h-6 px-2 inline-flex items-center gap-1 text-[10px] font-bold rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 ${FOCUS_RING}`}>
                  {greeksLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Refresh
                </button>
                <button type="button" onClick={() => setGreeksOpen(false)} aria-label="Close greeks"
                  className={`ml-auto h-6 w-6 inline-flex items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-white ${FOCUS_RING}`}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {greeks.result.legs.length === 0 && (
                <p className="text-[11px] text-zinc-500">No open legs to compute greeks for.</p>
              )}
              {greeks.result.legs.length > 0 && (
                <table className="text-[11px] font-mono tabular-nums w-full max-w-2xl">
                  <thead>
                    <tr className="bg-zinc-800 text-xs font-bold text-white">
                      <th className="text-left px-2 py-1">Leg</th>
                      <th className="text-right px-2 py-1">Delta</th>
                      <th className="text-right px-2 py-1">Gamma</th>
                      <th className="text-right px-2 py-1">Theta</th>
                      <th className="text-right px-2 py-1">Vega</th>
                      <th className="text-right px-2 py-1">IV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {greeks.result.legs.map(l => {
                      const k = (l.side === 'S' ? -1 : 1) * l.units;
                      const f = (v: number | null, d: number) => v === null ? '—' : (v * k).toFixed(d);
                      return (
                        <tr key={l.legId} className="border-b border-zinc-800/60 text-zinc-300">
                          <td className="px-2 py-1">{l.side === 'S' ? 'SELL' : 'BUY'} {l.strike} {l.option}</td>
                          <td className="text-right px-2 py-1">{f(l.delta, 2)}</td>
                          <td className="text-right px-2 py-1">{f(l.gamma, 4)}</td>
                          <td className="text-right px-2 py-1">{f(l.theta, 0)}</td>
                          <td className="text-right px-2 py-1">{f(l.vega, 2)}</td>
                          <td className="text-right px-2 py-1">{l.iv === null ? '—' : `${(l.iv * 100).toFixed(1)}%`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {greeks.result.missing.length > 0 && (
                <p className="text-[11px] text-amber-300">
                  {greeks.result.missing.length} leg(s) had no greeks in the chain ({greeks.result.missing.map(l => `${l.strike} ${l.option}`).join(', ')}) — excluded from the net figures; real exposure is larger.
                </p>
              )}
              {greeks.collisions.length > 0 && (
                <p className="text-[11px] text-amber-300">
                  Shares a contract with another strategy ({[...new Set(greeks.collisions.map(c => `${c.basketName}: ${c.strike} ${c.option}`))].join(', ')}).
                  These Greeks follow this strategy&apos;s own record, not the broker&apos;s netted position, so they may be off.
                </p>
              )}
              {greeks.errors.length > 0 && (
                <p className="text-[11px] text-zinc-400">Chain fetch failed for: {greeks.errors.join('; ')}</p>
              )}
            </>
          )}
        </div>
      )}

      {expanded && (
        <div className="p-4 flex flex-col gap-3">
          {/* Strategy-Level Target & SL Bar */}
          <div className="p-2.5 bg-zinc-950/60 border border-zinc-800/80 rounded-lg flex items-center justify-between gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">Premium:</span>
                <span className="font-mono text-zinc-200 font-bold">{stratMetrics.combinedCurrentPts.toFixed(1)} pts</span>
                {stratMetrics.combinedEntryPts > 0 && (
                  <span className="text-[10px] text-zinc-500 font-mono">(Entry {stratMetrics.combinedEntryPts.toFixed(1)} pts)</span>
                )}
              </div>
              <div className="h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">P&L:</span>
                <span className={`font-mono font-bold ${stratMetrics.pnlPts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {stratMetrics.pnlPts >= 0 ? '+' : ''}{stratMetrics.pnlPts.toFixed(2)} pts
                  {' '}({stratMetrics.pnlPct >= 0 ? '+' : ''}{stratMetrics.pnlPct.toFixed(1)}%)
                </span>
              </div>
              <div className="h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">
                  {basketStatus === 'OPEN' ? 'Margin Blocked:' : 'Margin Req:'}
                </span>
                <span className="font-mono text-zinc-200 font-bold">
                  {basketMargin && basketMargin > 0 ? fmtMoney(basketMargin) : '—'}
                </span>
                {basketMargin != null && basketMargin > 0 && (
                  <span
                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                      basketMarginSource === 'live'
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    }`}
                    title={
                      basketMarginSource === 'live'
                        ? "Real SPAN+exposure margin from Dhan's multi-leg margin calculator"
                        : broker !== 'dhan'
                          ? `${broker} has no live margin-calculator API — this is a flat ~12% estimate`
                          : 'Flat ~12% estimate — a leg is not yet resolved to a security ID or the live calculator call failed'
                    }
                  >
                    {basketMarginSource === 'live' ? 'Live' : 'Est.'}
                  </span>
                )}
                {hedgeBenefit != null && hedgeBenefit > 0 && (
                  <span className="text-[10px] text-emerald-400 font-mono" title={`Hedge Benefit: ${fmtMoney(hedgeBenefit)} (Standalone: ${overallMargin ? fmtMoney(overallMargin) : ''})`}>
                    (-{fmtMoney(hedgeBenefit)})
                  </span>
                )}
              </div>
              {hasMixedExpiry ? (
                <>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Strategy value as of the near leg's expiry — see the payoff curve below">
                    <span className="text-fuchsia-400 text-[11px] font-semibold uppercase tracking-wider">Breakevens:</span>
                    <span className="font-mono text-zinc-100 font-bold">{calendarBreakevensDisplay}</span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Highest P&L observed across the charted price range">
                    <span className="text-fuchsia-400 text-[11px] font-semibold uppercase tracking-wider">Max Profit:</span>
                    <span className="font-mono text-emerald-400 font-bold">{calendarMaxProfitDisplay}</span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Lowest P&L observed across the charted price range">
                    <span className="text-fuchsia-400 text-[11px] font-semibold uppercase tracking-wider">Max Loss:</span>
                    <span className="font-mono text-rose-400 font-bold">{calendarMaxLossDisplay}</span>
                  </div>
                </>
              ) : payoffResult && (
                <>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Strategy Breakeven Price Points at Expiry">
                    <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">Breakevens:</span>
                    <span className="font-mono text-zinc-100 font-bold">{breakevensDisplay}</span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Maximum Theoretical Profit Possible, as % of margin blocked = return on capital">
                    <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">Max Profit:</span>
                    <span className="font-mono text-emerald-400 font-bold">
                      {maxProfitDisplay}
                      {maxProfitPctOfMargin != null && (
                        <span className="ml-1 text-[10px] opacity-80">({maxProfitPctOfMargin >= 0 ? '+' : ''}{maxProfitPctOfMargin.toFixed(1)}%)</span>
                      )}
                    </span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Maximum Theoretical Loss Possible">
                    <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">Max Loss:</span>
                    <span className="font-mono text-rose-400 font-bold">{maxLossDisplay}</span>
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              {/* Target */}
              <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5">
                <span className="text-emerald-400 text-[11px] font-bold">Target</span>
                <RuleNumInput
                  value={strategyRisk.targetValue}
                  onCommit={v => updateRisk({ targetValue: v })}
                  placeholder={strategyRisk.targetUnit === 'pts' ? 'pts' : '%'}
                  className="w-14 h-6 text-center text-emerald-300"
                  title="Strategy Target in points or percentage"
                />
                <button
                  type="button"
                  onClick={() => updateRisk({ targetUnit: strategyRisk.targetUnit === 'pts' ? 'pct' : 'pts' })}
                  className="h-6 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white"
                  title="Toggle between Points (pts) and Percentage (%)"
                >
                  {strategyRisk.targetUnit === 'pts' ? 'pts' : '%'}
                </button>
                {strategyRisk.targetValue != null && strategyRisk.targetValue > 0 && stratMetrics.combinedEntryPts > 0 && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {strategyRisk.targetUnit === 'pts'
                      ? `(+${((strategyRisk.targetValue / stratMetrics.combinedEntryPts) * 100).toFixed(1)}%)`
                      : `(+${((strategyRisk.targetValue / 100) * stratMetrics.combinedEntryPts).toFixed(1)} pts)`}
                  </span>
                )}
              </div>

              {/* Stop Loss */}
              <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5">
                <span className="text-rose-400 text-[11px] font-bold">SL</span>
                <RuleNumInput
                  value={strategyRisk.slValue}
                  onCommit={v => updateRisk({ slValue: v })}
                  placeholder={strategyRisk.slUnit === 'pts' ? 'pts' : '%'}
                  className="w-14 h-6 text-center text-rose-300"
                  title="Strategy Stop Loss in points or percentage"
                />
                <button
                  type="button"
                  onClick={() => updateRisk({ slUnit: strategyRisk.slUnit === 'pts' ? 'pct' : 'pts' })}
                  className="h-6 px-1 text-[10px] font-mono font-bold rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white"
                  title="Toggle between Points (pts) and Percentage (%)"
                >
                  {strategyRisk.slUnit === 'pts' ? 'pts' : '%'}
                </button>
                {strategyRisk.slValue != null && strategyRisk.slValue > 0 && stratMetrics.combinedEntryPts > 0 && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {strategyRisk.slUnit === 'pts'
                      ? `(-${((strategyRisk.slValue / stratMetrics.combinedEntryPts) * 100).toFixed(1)}%)`
                      : `(-${((strategyRisk.slValue / 100) * stratMetrics.combinedEntryPts).toFixed(1)} pts)`}
                  </span>
                )}
              </div>

              {/* Auto-Exit Armed */}
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px] font-semibold text-zinc-300 bg-zinc-900 border border-zinc-800 rounded px-2 py-1">
                <input
                  type="checkbox"
                  checked={strategyRisk.armed}
                  onChange={e => updateRisk({ armed: e.target.checked })}
                  className="rounded border-zinc-700 text-emerald-500 focus:ring-0"
                />
                <span className={strategyRisk.armed ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>
                  {strategyRisk.armed ? 'Auto-Exit Armed' : 'Arm Guard'}
                </span>
              </label>
            </div>
          </div>

          {/* Legs Table */}
          {basket.legs.length === 0 ? (
            <div className="py-8 text-center text-zinc-500 text-xs flex flex-col items-center gap-1">
              <p>No legs configured in this strategy.</p>
              <button
                type="button"
                onClick={addBlankLeg}
                className="mt-1 text-emerald-400 hover:underline font-semibold"
              >
                + Add a leg
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              {legCounts.closed > 0 && (
                <div className="flex items-center gap-1 pb-1.5" role="group" aria-label="Filter legs by status">
                  {([['all', 'All', legCounts.all], ['open', 'Open', legCounts.open], ['closed', 'Closed', legCounts.closed]] as const).map(([k, label, n]) => (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={legFilter === k}
                      onClick={() => setLegFilter(k)}
                      className={`px-2 py-0.5 rounded text-xs font-semibold border ${FOCUS_RING} ${legFilter === k ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
                    >
                      {label} <span className="text-zinc-500">{n}</span>
                    </button>
                  ))}
                </div>
              )}
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                  <col className="w-[8%]" />
                  <col className="w-[5%]" />
                  <col className="w-[6%]" />
                  <col className="w-[6%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[4%]" />
                  <col className="w-[6%]" />
                  <col className="w-[9%]" />
                  <col className="w-[7%]" />
                  <col className="w-[6%]" />
                  <col className="w-[14%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
                    <th className="px-2 py-2 text-left" aria-sort={legSort?.key === 'side' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('side')} className={`inline-flex w-full items-center gap-0.5 justify-start font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Side<span aria-hidden className="text-[10px]">{legSort?.key === 'side' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-1.5 py-2 text-left" aria-sort={legSort?.key === 'option' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('option')} className={`inline-flex w-full items-center gap-0.5 justify-start font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        CE/PE<span aria-hidden className="text-[10px]">{legSort?.key === 'option' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left" aria-sort={legSort?.key === 'strike' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('strike')} className={`inline-flex w-full items-center gap-0.5 justify-start font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Strike<span aria-hidden className="text-[10px]">{legSort?.key === 'strike' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-1.5 py-2 text-center" aria-sort={legSort?.key === 'lots' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('lots')} className={`inline-flex w-full items-center gap-0.5 justify-center font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Lots<span aria-hidden className="text-[10px]">{legSort?.key === 'lots' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left">Type</th>
                    <th className="px-2 py-2 text-right" aria-sort={legSort?.key === 'ltp' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('ltp')} className={`inline-flex w-full items-center gap-0.5 justify-end font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        LTP<span aria-hidden className="text-[10px]">{legSort?.key === 'ltp' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left">SL</th>
                    <th className="px-2 py-2 text-left">TP</th>
                    <th className="px-1 py-2 text-center">Trail</th>
                    <th className="px-1.5 py-2 text-center" aria-sort={legSort?.key === 'expiry' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('expiry')} className={`inline-flex w-full items-center gap-0.5 justify-center font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Expiry<span aria-hidden className="text-[10px]">{legSort?.key === 'expiry' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-right" aria-sort={legSort?.key === 'margin' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('margin')} className={`inline-flex w-full items-center gap-0.5 justify-end font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Margin<span aria-hidden className="text-[10px]">{legSort?.key === 'margin' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-right" aria-sort={legSort?.key === 'pnl' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('pnl')} className={`inline-flex w-full items-center gap-0.5 justify-end font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        P&L<span aria-hidden className="text-[10px]">{legSort?.key === 'pnl' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-1.5 py-2 text-center" aria-sort={legSort?.key === 'status' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('status')} className={`inline-flex w-full items-center gap-0.5 justify-center font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Status<span aria-hidden className="text-[10px]">{legSort?.key === 'status' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLegs.map(leg => (
                    <MultiLegLegRow
                      key={leg.id}
                      leg={leg}
                      allStrikes={allStrikes}
                      spot={spot}
                      ltp={ltpFor(leg)}
                      editable={!hasPlacedLeg}
                      exiting={exitingLegs.has(leg.id)}
                      margin={legMargins?.[leg.id]}
                      multiplier={crudeMult}
                      frontExpiry={basket.expiry}
                      farExpiry={basket.farExpiry}
                      onChange={patch => updateLeg(leg.id, patch)}
                      onRemove={() => removeLeg(leg.id)}
                      onExit={() => onExitLeg(leg)}
                      onOpenAddLots={() => setSelectedLegForAddLots(leg)}
                      onShift={onShiftLegs ? (d => runShift([leg.id], d)) : undefined}
                      shiftSteps={shiftSteps}
                      shiftBusy={placing || exiting || shifting}
                      qtyWarning={legQtyWarnings?.[`${basket.id}:${leg.id}`]}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Payoff diagram — collapsed by default (this chart, plus the
             legs table above it, would otherwise make every already-open
             strategy row very tall on load). The current-spot marker inside
             tracks the live spot feed same as the header stats; the curve
             itself is fixed by each leg's entry price once filled, which is
             correct for a payoff-AT-EXPIRY chart — see dhan-payoff-diagrams. */}
          {basket.legs.length > 0 && (
            <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40">
              <button
                type="button"
                onClick={() => setShowPayoffChart(v => !v)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-bold text-zinc-300 hover:text-white transition-colors ${FOCUS_RING}`}
              >
                <span className="uppercase tracking-wider">Payoff Diagram</span>
                {showPayoffChart ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showPayoffChart && (
                <div className="px-3 pb-3">
                  {/* Calendar/Diagonal payoff curve — strategy value as of the
                     near leg's expiry, not a same-day-at-intrinsic curve (see
                     calendarCurve's own comment above). Only rendered once
                     every active leg is priced (calendarCurve returns null
                     otherwise). */}
                  {hasMixedExpiry && calendarCurve && (
                    <>
                      <PayoffDiagram
                        curve={calendarCurve.points.map(p => ({ spot: p.x, pnl: p.y }))}
                        currentSpot={spot ?? 0}
                        breakevens={calendarCurve.breakevens}
                        todayCurve={todayCurve ?? undefined}
                      />
                      <p className="mt-1 text-[10px] text-zinc-500 font-mono">
                        Value as of the near leg&apos;s expiry ({basket.expiry}) — the far leg
                        ({basket.farExpiry}) still carries {calendarCurve.daysBetweenExpiries}d of theoretical time value, priced via Black-76/Black-Scholes.
                      </p>
                    </>
                  )}
                  {hasMixedExpiry && !calendarCurve && (
                    <p className="text-xs text-zinc-500 text-center py-2">
                      Waiting for live prices to draw the calendar spread&apos;s payoff curve…
                    </p>
                  )}

                  {/* Single-expiry strategy payoff curve — the combined payoff
                     of every active leg in this basket (Iron Condor, Short
                     Strangle, etc.) at expiry, using the same computePayoff()
                     result the BE/Max P&L stats above are already derived
                     from, so the chart never disagrees with the numbers next
                     to it. */}
                  {!hasMixedExpiry && payoffResult && (
                    <PayoffDiagram
                      curve={payoffResult.points.map(p => ({ spot: p.x, pnl: p.y }))}
                      currentSpot={spot ?? 0}
                      breakevens={payoffResult.breakevens}
                      todayCurve={todayCurve ?? undefined}
                    />
                  )}
                  {!hasMixedExpiry && !payoffResult && (
                    <p className="text-xs text-zinc-500 text-center py-2">
                      Waiting for live prices to draw the payoff curve…
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add Lots Modal */}
      {selectedLegForAddLots && onAddLots && (
        <AddLotsModal
          isOpen={!!selectedLegForAddLots}
          onClose={() => setSelectedLegForAddLots(null)}
          leg={selectedLegForAddLots}
          basket={basket}
          lotSize={defaultLotSize}
          currentLtp={ltpFor(selectedLegForAddLots)}
          broker={broker}
          onConfirm={onAddLots}
        />
      )}

      {/* Add New Leg Modal */}
      {isAddNewLegModalOpen && onAddNewLeg && (
        <AddNewLegModal
          isOpen={isAddNewLegModalOpen}
          onClose={() => setIsAddNewLegModalOpen(false)}
          basket={basket}
          allStrikes={allStrikes}
          atmStrike={atmStrike}
          lotSize={defaultLotSize}
          ltpForStrike={ltpForStrike ?? ((s, o) => 0)}
          onAddLeg={onAddNewLeg}
        />
      )}
    </div>
  );
}
