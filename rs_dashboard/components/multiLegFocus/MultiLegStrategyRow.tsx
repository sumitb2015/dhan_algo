'use client';

import React, { useState, useMemo, useCallback } from 'react';
import {
  ChevronDown, ChevronUp, Trash2, Plus, Minus, X, Check, Layers, Sigma, Loader2, RefreshCw, Table2, BarChart3, LineChart, Pencil, Unlink,
} from 'lucide-react';
import MultiLegLegRow from './MultiLegLegRow';
import RuleNumInput from './RuleNumInput';
import AddLotsModal from './AddLotsModal';
import PnlTableModal from './PnlTableModal';
import PositionVisualizerModal from './PositionVisualizerModal';
import StrategyChartModal, { chartLegsFor, isChartableUnderlying } from './StrategyChartModal';
import ScaleStrategyModal from './ScaleStrategyModal';
import AddNewLegModal from './AddNewLegModal';
import LegColumnsMenu from './LegColumnsMenu';
import { DEFAULT_LEG_COLUMNS, type LegColumns } from '@/lib/legColumns';
import {
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk, computeBasketStatus,
  classifyBasketStructure, legCountsToday, legPnl, legAvgPrice, legPnlPct, legQtyUnits, crudeQtyMultiplier, basketLabel,
  findSiblingLegCollisions, type SiblingLegCollision, scaleBasketMultiplier, futuresAsSyntheticPayoffLegs, isOptionLeg,
  type MultiLegBasket, type MultiLegLeg, type StrategyRiskConfig,
} from '@/lib/multiLegFocus';
import { calculateTimeToExpiryYears } from '@/lib/optionsPricing';
import { FOCUS_RING } from '@/components/Scalper';
import { clampShiftSteps, MAX_SHIFT_STEPS } from '@/lib/strikeShift';
import { allowedStrikes, strikeAllowed, snapToAllowed } from '@/lib/farExpiryRules';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import PayoffDiagram, { modelToDiagramProps } from '@/components/strategy/PayoffDiagram';
import { buildPayoffModel, type PayoffModel, type PayoffLegInput } from '@/lib/optionsPayoff';
import { StatChip } from '@/components/analytics/PayoffMetricStrip';
import { basketToGreekLegs, computeBasketGreeks } from '@/lib/multiLegGreeks';

/** Dhan's option-chain API is rate limited (~1 call / 3.5 s per underlying). */

/** Placeholder IV used only when no live chain IV is available yet for a leg's
 *  strike — same role as the `atmIv > 0 ? atmIv / 100 : 0.1313`-style fallback
 *  used elsewhere in the dashboard (Baskets.tsx), just without a tracked ATM
 *  IV of its own here. Never a claim about the real market IV. */
const FALLBACK_IV = 0.15;

type LegSortKey = 'side' | 'option' | 'strike' | 'lots' | 'ltp' | 'expiry' | 'margin' | 'pnl' | 'status' | 'avg' | 'pnlPct' | 'qty';

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
  onExitLeg: (leg: MultiLegLeg, exitLots?: number) => Promise<void>;
  /** Roll the given OPEN legs N strikes up/down (close, then reopen). */
  onShiftLegs?: (legIds: string[], direction: 'UP' | 'DOWN', steps: number) => Promise<void>;
  /** Which optional legs-table columns are shown (owned by MultiLegFocus so every row agrees). */
  legColumns?: LegColumns;
  onLegColumnsChange?: (next: LegColumns) => void;
  onAddLots?: (params: {
    legId: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
    newSl?: number;
    newTp?: number;
  }) => Promise<void>;
  /** Page clock (epoch ms, ticks each minute) that splits Today from earlier days. */
  pnlNow: number;
  onAddNewLeg?: (params: {
    side: 'B' | 'S';
    option: 'CE' | 'PE';
    strike: number;
    expiry?: string;
    lots: number;
    orderType: 'MARKET' | 'LIMIT';
    limitPrice?: number;
  }) => Promise<void>;
  /** Scale all open legs of this strategy by adding N multiplier units (BUYs first, then SELLs). */
  onScaleStrategy?: (multiplierDelta: number, expectedSignature?: string) => Promise<void>;
  scaling?: boolean;
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
  /** All baskets on the page — used only to flag Greeks legs that share a contract with a sibling. */
  allBaskets?: MultiLegBasket[];
  /** Legs ticked for regrouping (page-wide, so a group can span rows). */
  selectedLegIds?: Set<string>;
  onSelectLegs?: (legIds: string[], on: boolean) => void;
  /** Set a leg's tag through the page's functional leg update (never this render's legs). */
  onTagLeg?: (legId: string, tag: string | undefined) => void;
  /** Move every live trade of this group to the Ungrouped trades table. */
  onUngroup?: () => void;
  /** Move one trade of this group to the Ungrouped trades table. */
  onDetachLeg?: (legId: string) => void;
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
  legColumns = DEFAULT_LEG_COLUMNS,
  onLegColumnsChange,
  onAddLots,
  pnlNow,
  onAddNewLeg,
  onScaleStrategy,
  scaling = false,
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
  allBaskets,
  selectedLegIds,
  onSelectLegs,
  onTagLeg,
  onUngroup,
  onDetachLeg,
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
  const [showPnlTable, setShowPnlTable] = useState(false);
  const [showPositionVisualizer, setShowPositionVisualizer] = useState(false);
  const [showStrategyChart, setShowStrategyChart] = useState(false);
  const [simTargetDays, setSimTargetDays] = useState<number>(0);
  const [simIvShift, setSimIvShift] = useState<number>(0);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const [showScale, setShowScale] = useState(false);
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
  // null = the user hasn't picked a chip yet, so the default below applies.
  const [legFilterChoice, setLegFilter] = useState<'all' | 'open' | 'closed' | null>(null);
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

  // A strategy still holding open legs keeps its closed legs (they carry the realized P&L),
  // so it only retires to the archive once fully flat. Until then, default to the Open chip
  // once any leg was closed on an earlier day; if every close is from today, show All.
  const hasEarlierDayClosed = useMemo(() => basket.legs.some(l => !legCountsToday(l)), [basket.legs]);
  const legFilter = legFilterChoice ?? (hasEarlierDayClosed && legCounts.open > 0 ? 'open' : 'all');

  const crudeMult = crudeQtyMultiplier(basket.underlying, broker);

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
          case 'avg': return legAvgPrice(l) ?? 0;
          case 'pnlPct': return legPnlPct(l, ltpFor(l), crudeMult) ?? 0;
          case 'qty': return legQtyUnits(l) ?? 0;
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

  // Columns actually rendered, in table order. Header cells, row cells and this colgroup must all
  // follow the same conditions. Exit only exists once something has closed, so it hides itself
  // (even when enabled) until then rather than showing a column of dashes.
  const showExitCol = legColumns.exit && legCounts.closed > 0;
  const colWeights = [
    ...(onSelectLegs ? [6] : []), 5, 5, 8, ...(legColumns.otm ? [7] : []), ...(legColumns.iv ? [5] : []),
    5, ...(legColumns.qty ? [6] : []), 6, 6, ...(legColumns.avg ? [6] : []), ...(showExitCol ? [6] : []),
    // Action needs ~215px (shift ▲▼, ADD, lots box, EXIT): 19 x 12px at the table's minimum width.
    8, 8, 4, 6, 9, 7, ...(legColumns.pnlPct ? [6] : []), 6, 19,
  ];
  const colTotal = colWeights.reduce((a, b) => a + b, 0);
  const sortTh = (key: LegSortKey, label: string, align: 'left' | 'right' | 'center', title?: string) => {
    const alignCls = { left: 'text-left', right: 'text-right', center: 'text-center' }[align];
    const justifyCls = { left: 'justify-start', right: 'justify-end', center: 'justify-center' }[align];
    return (
      <th className={`px-2 py-2 ${alignCls}`} title={title} aria-sort={legSort?.key === key ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => toggleLegSort(key)} className={`inline-flex w-full items-center gap-0.5 ${justifyCls} font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
          {label}<span aria-hidden className="text-[10px]">{legSort?.key === key ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
        </button>
      </th>
    );
  };

  const stratMetrics = useMemo(
    () => computeStrategyMetrics(basket.legs, ltpFor, crudeMult),
    [basket.legs, ltpFor, crudeMult],
  );
  const totalPnl = stratMetrics.totalPnlRupees;
  // Broker-MTM scope (live legs + legs closed today) — same split as the page header.
  const todayPnl = useMemo(
    () => computeStrategyMetrics(basket.legs.filter(l => legCountsToday(l, pnlNow)), ltpFor, crudeMult).totalPnlRupees,
    [basket.legs, ltpFor, crudeMult, pnlNow],
  );

  const defaultLotSize = useMemo(() => {
    if (lotSize && lotSize > 0) return lotSize;
    if (basket.underlying === 'NIFTY') return 65;
    if (basket.underlying === 'BANKNIFTY') return 15;
    if (basket.underlying === 'SENSEX') return 20;
    return broker === 'dhan' ? 1 : (basket.underlying === 'CRUDEOIL' ? 100 : 10);
  }, [lotSize, basket.underlying, broker]);

  // On-demand Greeks panel. Computed through the central payoff library from each leg's live mark — the same numbers as the payoff
  // chart and the header strips — so there is no chain fetch and nothing to wait for.
  const [greeks, setGreeks] = useState<{
    result: ReturnType<typeof computeBasketGreeks>; at: Date; collisions: SiblingLegCollision[];
  } | null>(null);
  const [greeksOpen, setGreeksOpen] = useState(false);
  const runGreeks = useCallback(() => {
    const legs = basketToGreekLegs(basket, defaultLotSize, crudeMult);
    setGreeksOpen(true);
    const byId = new Map(basket.legs.map(l => [l.id, l]));
    const result = computeBasketGreeks(legs, {
      spot: spot ?? 0,
      markOf: gl => { const l = byId.get(gl.legId); const v = l ? ltpFor(l) : 0; return v > 0 ? v : undefined; },
      chainIvOf: gl => (gl.option === 'FUT' ? undefined : ivForStrike?.(gl.strike, gl.option, gl.expiry) || undefined),
      fallbackIv: FALLBACK_IV,
    });
    // Sibling baskets holding the same contract share one netted broker row, so this basket's own ledger quantity may not
    // match the broker's.
    const collisions = allBaskets
      ? findSiblingLegCollisions(allBaskets, basket.id, legs.map(l => ({ side: l.side, option: l.option, strike: l.strike, expiry: l.expiry })))
      : [];
    setGreeks({ result, at: new Date(), collisions });
  }, [basket, allBaskets, defaultLotSize, crudeMult, spot, ltpFor, ivForStrike]);

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

  const effectiveFarExpiry = useMemo(() => {
    if (basket.farExpiry) return basket.farExpiry;
    const farLeg = basket.legs.find(l => l.status !== 'CLOSED' && l.expiry && l.expiry !== basket.expiry);
    return farLeg?.expiry;
  }, [basket.farExpiry, basket.legs, basket.expiry]);

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
  const chartDisabledReason = hasMixedExpiry
    ? 'Strategy chart supports a single expiry only (Calendar/Diagonal not supported)'
    : !isChartableUnderlying(basket.underlying)
      ? `No chart data for ${basket.underlying}`
      : chartLegsFor(basket.legs).length === 0
        ? 'No live legs to plot'
        : null;
  const strategyLabel = basket.groupName?.trim()
    || derivedStructure?.structure
    || basketLabel(basket, `Strategy #${index + 1}`);
  // Rename: click the name. Commits on blur / Enter, Esc cancels.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const renameSettled = React.useRef(false);
  const commitName = (save: boolean) => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    setRenaming(false);
    const v = nameDraft.trim().slice(0, 40);
    // '' (not undefined) clears: an omitted key would let the server merge keep the old name.
    if (save && v !== (basket.groupName ?? '')) onUpdate({ groupName: v });
  };

  // ── Payoff: ONE call into the central payoff library (lib/optionsPayoff.ts) ───────────────────────────────
  // It prices every leg at its OWN expiry and IV (Black-76, IV solved from the leg's live mark so T+0 shows the real open P&L),
  // values the book as of the NEAREST expiry (later legs keep their time value), finds exact break-evens, and returns the
  // header numbers, curves, SD band, POP and net Greeks the chart and the stats strips below all read. No curve is built here.
  // Collapsed rows only need the header numbers, so they ask for the `light` model (no curves).
  const payoffMultiplier = (broker === 'dhan' && (basket.underlying === 'CRUDEOIL' || basket.underlying === 'CRUDEOILM')) ? crudeMult : 1;

  const payoffLegInputs = basket.legs
    .filter(l => l.status !== 'CLOSED')
    .flatMap((l): PayoffLegInput[] => {
      const legExpiry = l.expiry || basket.expiry;
      const live = ltpFor(l);
      const entry = (l.fill?.avgPrice && l.fill.avgPrice > 0) ? l.fill.avgPrice : (live > 0 ? live : (l.price || 0));
      const units = ((l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : (l.lots * defaultLotSize)) * payoffMultiplier;
      const qty = l.side === 'S' ? -units : units;
      if (l.option === 'FUT') return futuresAsSyntheticPayoffLegs(qty, entry, legExpiry, live);
      return [{
        type: l.option, strike: l.strike, expiry: legExpiry, qty,
        entryPrice: entry, mark: live > 0 ? live : undefined,
        chainIv: ivForStrike?.(l.strike, l.option, legExpiry) || undefined, lotSize: defaultLotSize,
      }];
    });

  // ATM IV of the near expiry (never VIX): the SD band and POP are built on it.
  const atmIvFraction = (() => {
    const ceIv = (atmStrike && ivForStrike?.(atmStrike, 'CE', basket.expiry)) || 0;
    const peIv = (atmStrike && ivForStrike?.(atmStrike, 'PE', basket.expiry)) || 0;
    return (ceIv > 0 && peIv > 0) ? (ceIv + peIv) / 2 : (ceIv > 0 ? ceIv : (peIv > 0 ? peIv : 0));
  })();

  // `ltpFor` is a fresh closure every parent render, so key the memo on the VALUES it produced, not its identity.
  const payoffKey = JSON.stringify([payoffLegInputs, spot, basketMargin, atmIvFraction, simTargetDays, simIvShift, showPayoffChart, step]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const payoffModel: PayoffModel | null = useMemo(() => {
    if (!spot || spot <= 0 || payoffLegInputs.length === 0) return null;
    try {
      return buildPayoffModel({
        legs: payoffLegInputs, spot, margin: basketMargin || undefined, atmIv: atmIvFraction || undefined,
        fallbackIv: FALLBACK_IV, strikeStep: step || 50,
        sim: { days: simTargetDays || 0, ivShift: simIvShift || 0 },
        light: !showPayoffChart,
      });
    } catch {
      return null;
    }
  }, [payoffKey]);

  // ── Max days to expiry for What-If time decay simulation ─────────────
  const maxDays = useMemo(() => {
    if (!basket.expiry) return 7;
    return Math.max(0.1, Math.round(calculateTimeToExpiryYears(basket.expiry) * 365 * 10) / 10);
  }, [basket.expiry]);

  // ── Active leg strike markers for X-axis pins ────────────────────────
  const strategyStrikes = useMemo(() => {
    const activeLegs = basket.legs.filter(isOptionLeg).filter(l => l.status !== 'CLOSED');
    return activeLegs.map(l => ({
      strike: l.strike,
      option: l.option,
      side: l.side,
      lots: l.lots,
    }));
  }, [basket.legs]);

  // Header strings, read straight from the model so the strips and the chart can never disagree.
  const pctFromSpot = (b: number) => (spot && spot > 0 ? ` (${((b - spot) / spot) * 100 >= 0 ? '+' : ''}${(((b - spot) / spot) * 100).toFixed(1)}%)` : '');
  const breakevensDisplay = !payoffModel ? '—'
    : payoffModel.breakevens.length === 0 ? (hasMixedExpiry ? 'Undefined' : 'None')
      : payoffModel.breakevens.map(b => `${Math.round(b).toLocaleString('en-IN')}${pctFromSpot(b)}`).join(' — ');
  const maxProfitDisplay = !payoffModel ? '—'
    : payoffModel.maxProfitUnlimited ? 'Unlimited'
      : payoffModel.maxProfit > 0 ? `+${fmtMoney(payoffModel.maxProfit)}` : fmtMoney(payoffModel.maxProfit);
  const maxLossDisplay = !payoffModel ? '—' : payoffModel.maxLossUnlimited ? 'Unlimited' : fmtMoney(payoffModel.maxLoss);
  // Max profit as a % of margin blocked — a return-on-capital measure, since rupee P&L alone doesn't say whether a trade is
  // worth the margin it ties up.
  const maxProfitPctOfMargin = payoffModel?.rom ?? null;

  // Displayed MTM (broker scope) as a % of margin blocked (Return on Margin / Capital)
  const pnlPctOfMargin = useMemo(() => {
    if (!basketMargin || basketMargin <= 0) return null;
    return (todayPnl / basketMargin) * 100;
  }, [todayPnl, basketMargin]);

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

  const currentMultiplier = basket.multiplier ?? 1;

  const handleMultiplierChange = useCallback((newMultiplier: number) => {
    if (hasPlacedLeg) return;
    const scaled = scaleBasketMultiplier(basket, newMultiplier);
    onUpdate({
      multiplier: scaled.multiplier,
      legs: scaled.legs,
    });
  }, [basket, hasPlacedLeg, onUpdate]);

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
        if ('tag' in patch) allowed.tag = patch.tag;
        return { ...l, ...allowed };
      }
      const next = { ...l, ...patch };
      // When lots are directly edited in draft mode, update base ratio so subsequent multiplier changes scale proportionally
      if (patch.lots !== undefined) {
        const safeLots = isNaN(patch.lots) || patch.lots < 1 ? 1 : Math.round(patch.lots);
        next.lots = safeLots;
        next.ratio = Math.max(1, Math.round(safeLots / currentMultiplier));
      }
      // Toggling a leg onto another expiry: a strike that isn't tradable there (far expiry, not a
      // multiple of 100) snaps to the nearest one that is, instead of leaving an unplaceable leg.
      if (patch.expiry) next.strike = snapToAllowed(basket.underlying, patch.expiry, expiries, next.strike, allStrikes);
      return next;
    });
    onUpdate({ legs: updatedLegs });
  }, [basket.legs, basket.underlying, currentMultiplier, hasPlacedLeg, onUpdate, expiries, allStrikes]);

  const removeLeg = useCallback((legId: string) => {
    if (hasPlacedLeg) return;
    onUpdate({ legs: basket.legs.filter(l => l.id !== legId) });
  }, [basket.legs, hasPlacedLeg, onUpdate]);

  const addBlankLeg = useCallback(() => {
    if (hasPlacedLeg) return;
    const atm = snapToAllowed(basket.underlying, basket.expiry, expiries, atmStrike > 0 ? atmStrike : (allStrikes[0] ?? 24000), allStrikes);
    const newLeg: MultiLegLeg = {
      id: `mll_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      side: 'S',
      option: 'CE',
      strike: atm,
      expiry: basket.expiry,
      ratio: 1,
      lots: 1 * currentMultiplier,
      type: 'MARKET',
      status: 'DRAFT',
    };
    onUpdate({ legs: [...basket.legs, newLeg] });
  }, [hasPlacedLeg, atmStrike, allStrikes, basket.legs, basket.underlying, basket.expiry, currentMultiplier, expiries, onUpdate]);

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
            {renaming ? (
              <input autoFocus value={nameDraft} maxLength={40} aria-label="Group name" placeholder={strategyLabel}
                onChange={e => setNameDraft(e.target.value)} onBlur={() => commitName(true)}
                onKeyDown={e => { if (e.key === 'Enter') commitName(true); else if (e.key === 'Escape') commitName(false); }}
                className={`h-6 w-44 bg-zinc-900 border border-emerald-500 text-zinc-100 text-xs font-bold rounded px-1.5 ${FOCUS_RING}`} />
            ) : (
              <button type="button" onClick={() => { renameSettled.current = false; setNameDraft(basket.groupName ?? ''); setRenaming(true); }}
                title="Click to name this group of trades"
                className={`group inline-flex items-center gap-1 text-xs font-bold text-zinc-100 uppercase tracking-wider hover:text-emerald-300 ${FOCUS_RING}`}>
                {strategyLabel}
                <Pencil className="w-3 h-3 text-zinc-600 group-hover:text-emerald-400" aria-hidden />
              </button>
            )}
            {basket.groupName?.trim() && derivedStructure?.structure && (
              <span className="text-[10px] font-semibold text-zinc-500 normal-case">{derivedStructure.structure}</span>
            )}
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
          {onUngroup && basket.legs.some(l => l.status !== 'CLOSED') && (
            <button
              type="button"
              onClick={onUngroup}
              disabled={placing || exiting || shifting}
              title="Ungroup: move every live trade here to Ungrouped trades; closed trades stay as this row's history (no orders are placed)"
              className={`h-6 px-1.5 inline-flex items-center gap-1 text-[10px] font-bold rounded border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 ${FOCUS_RING}`}
            >
              <Unlink className="w-3 h-3" /> Ungroup
            </button>
          )}
          </div>

          {/* Underlying + Expiry — a placed basket can't change either (the
             disabled selects below were just dead weight eating header width
             on every already-open row, which is most rows most of the time),
             so show them as plain compact text once placed and keep the real
             editable dropdowns only for a still-DRAFT basket. */}
          {hasPlacedLeg ? (
            <span className="text-xs font-bold text-zinc-300 whitespace-nowrap flex items-center gap-1.5">
              <span>
                {basket.underlying} <span className="text-zinc-600">·</span> {basket.expiry}
                {hasMixedExpiry && effectiveFarExpiry && (
                  <span className="text-fuchsia-400"> / {effectiveFarExpiry}</span>
                )}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20" title={`Strategy Multiplier: ${currentMultiplier}×`}>
                {currentMultiplier}×
              </span>
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

              {/* Strategy Multiplier Stepper */}
              <div className="flex items-center gap-1.5 h-7 bg-zinc-950 border border-zinc-700/80 rounded px-1.5" title="Strategy Multiplier: scales all legs according to their ratio">
                <label className="text-[10px] text-zinc-400 font-semibold uppercase select-none">Mult:</label>
                <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-900 overflow-hidden h-5">
                  <button
                    type="button"
                    onClick={() => handleMultiplierChange(currentMultiplier - 1)}
                    disabled={currentMultiplier <= 1}
                    className="w-5 h-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Decrease multiplier"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <RuleNumInput
                    value={currentMultiplier}
                    min={1}
                    step={1}
                    onCommit={val => {
                      if (val != null) handleMultiplierChange(val);
                    }}
                    className="w-8 h-full bg-transparent border-0 text-center font-mono font-bold text-xs text-amber-400 tabular-nums focus:outline-none focus:ring-0 p-0"
                  />
                  <span className="text-[10px] font-bold text-amber-400 pr-1 select-none">×</span>
                  <button
                    type="button"
                    onClick={() => handleMultiplierChange(currentMultiplier + 1)}
                    disabled={currentMultiplier >= 50}
                    className="w-5 h-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Increase multiplier"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
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
                <span className="text-zinc-200 font-bold">{breakevensDisplay}</span>
              </div>
              <span className="text-zinc-700">·</span>
              <div className="flex items-center gap-1">
                <span className="text-fuchsia-400 text-[10px] uppercase font-semibold">Max P/L:</span>
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
          ) : payoffModel && (
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

          {/* Strategy MTM: broker positions scope (open legs + legs closed today) - matches the broker's P&L */}
          <span
            className={`h-7 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums border ${
              todayPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
            }`}
            title={`MTM: open legs (from entry) plus legs closed today, the broker's positions P&L scope${
              pnlPctOfMargin != null ? ` · ${pnlPctOfMargin >= 0 ? '+' : ''}${pnlPctOfMargin.toFixed(2)}% of margin` : ''
            }${
              hasEarlierDayClosed ? ` · Lifetime incl. earlier days' closed legs: ${totalPnl >= 0 ? '+' : ''}${fmtMoney(totalPnl)}` : ''
            }`}
          >
            {todayPnl >= 0 ? '+' : ''}{fmtMoney(todayPnl)}
          </span>

          <button
            type="button"
            onClick={runGreeks}
            title="Net Delta / Gamma / Theta / Vega for this strategy, from each leg's live price"
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 ${FOCUS_RING}`}
          >
            <Sigma className="w-3 h-3" />
            Greeks
          </button>

          <button
            type="button"
            onClick={() => setShowPositionVisualizer(true)}
            title="Position Map: horizontal strike line, vertical position bars, CE/PE annotations, and live spot"
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20 ${FOCUS_RING}`}
          >
            <BarChart3 className="w-3 h-3 text-indigo-400" />
            Position Map
          </button>

          <button
            type="button"
            onClick={() => setShowStrategyChart(true)}
            disabled={chartDisabledReason !== null}
            title={chartDisabledReason ?? 'Strategy chart: live combined premium of this strategy, plotted from its current legs'}
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
          >
            <LineChart className="w-3 h-3" />
            Strategy Chart
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
                const groups: { label: string; noun: string; ids: string[] }[] = [
                  { label: 'CE', noun: 'CE legs', ids: openLegs.filter(l => l.option === 'CE').map(l => l.id) },
                  { label: 'PE', noun: 'PE legs', ids: openLegs.filter(l => l.option === 'PE').map(l => l.id) },
                  { label: 'All', noun: 'all open legs', ids: openLegs.map(l => l.id) },
                ].filter((g, i, arr) => g.ids.length > 0 && !(g.label !== 'All' && g.ids.length === arr[arr.length - 1].ids.length));
                const unit = `strike${shiftSteps > 1 ? 's' : ''}`;
                const iconBtn = `h-full w-6 inline-flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${FOCUS_RING}`;
                return (
                  <div
                    role="group"
                    aria-label="Shift strikes"
                    className="inline-flex items-stretch h-7 rounded-lg border border-zinc-700 bg-zinc-900 overflow-hidden divide-x divide-zinc-700"
                  >
                    {/* How far one click moves */}
                    <div className="flex items-center" title="Strikes moved per click">
                      <span className="pl-2 pr-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500 select-none">Shift</span>
                      <button type="button" className={iconBtn} disabled={busy || shiftSteps <= 1}
                        aria-label="Decrease shift distance" onClick={() => setShiftSteps(n => clampShiftSteps(n - 1))}>
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="min-w-[3.25rem] px-1 text-center text-[11px] font-mono font-bold text-zinc-100 tabular-nums select-none" aria-live="polite">
                        {shiftSteps}<span className="ml-0.5 font-sans text-[10px] font-semibold text-zinc-500">{unit}</span>
                      </span>
                      <button type="button" className={iconBtn} disabled={busy || shiftSteps >= MAX_SHIFT_STEPS}
                        aria-label="Increase shift distance" onClick={() => setShiftSteps(n => clampShiftSteps(n + 1))}>
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    {/* Which legs move, and which way */}
                    {groups.map(g => (
                      <div key={g.label} className="flex items-center">
                        <span className={`px-2 text-[10px] font-bold select-none ${g.label === 'All' ? 'text-zinc-100' : 'text-zinc-300'}`}>{g.label}</span>
                        <button type="button" className={iconBtn} disabled={busy}
                          aria-label={`Shift ${g.noun} down ${shiftSteps} ${unit}`}
                          title={`Move ${g.noun} to lower strikes (${shiftSteps} ${unit})`}
                          onClick={() => runShift(g.ids, 'DOWN')}>
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" className={iconBtn} disabled={busy}
                          aria-label={`Shift ${g.noun} up ${shiftSteps} ${unit}`}
                          title={`Move ${g.noun} to higher strikes (${shiftSteps} ${unit})`}
                          onClick={() => runShift(g.ids, 'UP')}>
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                    {shifting && (
                      <div className="flex items-center px-2" role="status">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" aria-label="Shifting" />
                      </div>
                    )}
                  </div>
                );
              })()}
              {onScaleStrategy && (
                <button
                  type="button"
                  onClick={() => setShowScale(true)}
                  disabled={scaling || shifting || exiting || exitingLegs.size > 0}
                  title="Add more copies of this strategy: preview the lots and margin, then place hedges first and shorts second"
                  className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`}
                >
                  {scaling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  {scaling ? 'Scaling…' : 'Scale…'}
                </button>
              )}
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
          {greeks && (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex flex-wrap items-center rounded-lg border border-zinc-800/80 bg-zinc-950/60 py-1.5">
                  <StatChip label="Net Delta" value={greeks.result.net.delta.toFixed(2)}
                    color={greeks.result.net.delta > 0 ? 'text-emerald-400' : greeks.result.net.delta < 0 ? 'text-red-400' : 'text-zinc-100'} />
                  <StatChip label="Net Gamma" value={greeks.result.net.gamma.toFixed(4)}
                    color={greeks.result.net.gamma < 0 ? 'text-rose-400' : 'text-zinc-100'} />
                  <StatChip label="Net Theta" value={`₹${greeks.result.net.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
                    sub="per day" color={greeks.result.net.theta > 0 ? 'text-emerald-400' : 'text-red-400'} />
                  <StatChip label="Net Vega" value={greeks.result.net.vega.toFixed(2)} sub="per 1% IV"
                    color={greeks.result.net.vega < 0 ? 'text-rose-400' : 'text-zinc-100'} />
                  <StatChip label="Legs" value={String(greeks.result.legs.length)} />
                </div>
                <span className="text-[10px] text-zinc-500">as of {greeks.at.toLocaleTimeString('en-IN')}</span>
                <button type="button" onClick={runGreeks} aria-label="Recompute greeks"
                  className={`h-6 px-2 inline-flex items-center gap-1 text-[10px] font-bold rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 ${FOCUS_RING}`}>
                  <RefreshCw className="w-3 h-3" /> Refresh
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
              {greeks.result.assumed.length > 0 && (
                <p className="text-[11px] text-amber-300">
                  {greeks.result.assumed.length} leg(s) have no live price or chain IV ({greeks.result.assumed.map(l => `${l.strike} ${l.option}`).join(', ')}) — priced on an assumed {(FALLBACK_IV * 100).toFixed(0)}% IV, so their Greeks are indicative.
                </p>
              )}
              {greeks.collisions.length > 0 && (
                <p className="text-[11px] text-amber-300">
                  Shares a contract with another strategy ({[...new Set(greeks.collisions.map(c => `${c.basketName}: ${c.strike} ${c.option}`))].join(', ')}).
                  These Greeks follow this strategy&apos;s own record, not the broker&apos;s netted position, so they may be off.
                </p>
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
                <span className="font-mono text-zinc-200 font-bold" title={stratMetrics.hasFutures ? 'Points do not add up across futures and options' : undefined}>
                  {stratMetrics.hasFutures ? '—' : `${stratMetrics.combinedCurrentPts.toFixed(1)} pts`}
                </span>
                {!stratMetrics.hasFutures && stratMetrics.combinedEntryPts > 0 && (
                  <span className="text-[10px] text-zinc-500 font-mono">(Entry {stratMetrics.combinedEntryPts.toFixed(1)} pts)</span>
                )}
              </div>
              <div className="h-4 w-px bg-zinc-800" />
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 text-[11px] font-semibold uppercase tracking-wider">P&L:</span>
                {stratMetrics.hasFutures ? (
                  // Futures + options: only rupees add up (points would mix a ₹10/pt future with option premium).
                  <span className={`font-mono font-bold ${stratMetrics.totalPnlRupees >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                    title="Rupee P&L of every leg. Points and % are not shown: they do not add up across futures and options.">
                    {stratMetrics.totalPnlRupees >= 0 ? '+' : ''}{fmtMoney(stratMetrics.totalPnlRupees)}
                  </span>
                ) : (
                <span className={`font-mono font-bold ${stratMetrics.pnlPts >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {stratMetrics.pnlPts >= 0 ? '+' : ''}{stratMetrics.pnlPts.toFixed(2)} pts
                  {' '}({stratMetrics.pnlPct >= 0 ? '+' : ''}{stratMetrics.pnlPct.toFixed(1)}%)
                </span>
                )}
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
                    <span className="font-mono text-zinc-100 font-bold">{breakevensDisplay}</span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Highest P&L observed across the charted price range">
                    <span className="text-fuchsia-400 text-[11px] font-semibold uppercase tracking-wider">Max Profit:</span>
                    <span className="font-mono text-emerald-400 font-bold">{maxProfitDisplay}</span>
                  </div>
                  <div className="h-4 w-px bg-zinc-800" />
                  <div className="flex items-center gap-1.5" title="Lowest P&L observed across the charted price range">
                    <span className="text-fuchsia-400 text-[11px] font-semibold uppercase tracking-wider">Max Loss:</span>
                    <span className="font-mono text-rose-400 font-bold">{maxLossDisplay}</span>
                  </div>
                </>
              ) : payoffModel && (
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
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-[11px] font-semibold text-zinc-300 bg-zinc-900 border border-zinc-800 rounded px-2 py-1"
                title={stratMetrics.hasFutures ? 'Strategy Target/SL work in points or %, which do not add up across futures and options. Use leg SL/TP instead.' : undefined}>
                <input
                  type="checkbox"
                  checked={strategyRisk.armed && !stratMetrics.hasFutures}
                  disabled={stratMetrics.hasFutures}
                  onChange={e => updateRisk({ armed: e.target.checked })}
                  className="rounded border-zinc-700 text-emerald-500 focus:ring-0"
                />
                <span className={strategyRisk.armed && !stratMetrics.hasFutures ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>
                  {stratMetrics.hasFutures ? 'Guard off (futures)' : strategyRisk.armed ? 'Auto-Exit Armed' : 'Arm Guard'}
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
            <div>
              <div className="flex items-center justify-between gap-2 pb-1.5">
                <div className="flex items-center gap-1" role="group" aria-label="Filter legs by status">
                  {legCounts.closed > 0 && (
                    <>
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
                    </>
                  )}
                </div>
                {onLegColumnsChange && <LegColumnsMenu columns={legColumns} onChange={onLegColumnsChange} />}
              </div>
              <div className="overflow-x-auto">
              <table className="w-full table-fixed text-xs" style={{ minWidth: `${Math.round(colTotal * 12)}px` }}>
                <colgroup>
                  {colWeights.map((w, i) => <col key={i} style={{ width: `${((w / colTotal) * 100).toFixed(2)}%` }} />)}
                </colgroup>
                <thead>
                  <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
                    {onSelectLegs && (
                      <th className="px-1.5 py-2 text-left" title="Tick trades to group them; click a tag to label a trade">
                        <input type="checkbox" aria-label="Select every trade in this strategy"
                          checked={visibleLegs.length > 0 && visibleLegs.every(l => selectedLegIds?.has(l.id))}
                          onChange={e => onSelectLegs(visibleLegs.map(l => l.id), e.target.checked)}
                          className="h-3.5 w-3.5 accent-emerald-500 cursor-pointer align-middle" />
                        <span className="ml-1">Tag</span>
                      </th>
                    )}
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
                    {legColumns.otm && <th className="px-2 py-2 text-right" title="Distance of the strike from spot (negative = in the money)">OTM %</th>}
                    {legColumns.iv && <th className="px-2 py-2 text-right" title="Live implied volatility">IV</th>}
                    <th className="px-1.5 py-2 text-center" aria-sort={legSort?.key === 'lots' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('lots')} className={`inline-flex w-full items-center gap-0.5 justify-center font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        Lots<span aria-hidden className="text-[10px]">{legSort?.key === 'lots' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    {legColumns.qty && sortTh('qty', 'Qty', 'right', 'Quantity in units (lots x lot size)')}
                    <th className="px-2 py-2 text-left">Type</th>
                    <th className="px-2 py-2 text-right" aria-sort={legSort?.key === 'ltp' ? (legSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleLegSort('ltp')} className={`inline-flex w-full items-center gap-0.5 justify-end font-bold hover:text-emerald-300 ${FOCUS_RING}`}>
                        LTP<span aria-hidden className="text-[10px]">{legSort?.key === 'ltp' ? (legSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                    {legColumns.avg && sortTh('avg', 'Avg', 'right', 'Average entry price')}
                    {showExitCol && <th className="px-2 py-2 text-right" title="Closing fill price">Exit</th>}
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
                    {legColumns.pnlPct && sortTh('pnlPct', 'P&L %', 'right', 'P&L as a % of the entry premium')}
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
                      allStrikes={allowedStrikes(basket.underlying, leg.expiry || basket.expiry, expiries, allStrikes)}
                      spot={spot}
                      ltp={ltpFor(leg)}
                      editable={!hasPlacedLeg}
                      exiting={exitingLegs.has(leg.id)}
                      margin={legMargins?.[leg.id]}
                      multiplier={crudeMult}
                      strategyMultiplier={currentMultiplier}
                      frontExpiry={basket.expiry}
                      farExpiry={effectiveFarExpiry}
                      onChange={patch => updateLeg(leg.id, patch)}
                      onRemove={() => removeLeg(leg.id)}
                      onExit={lots => onExitLeg(leg, lots)}
                      onOpenAddLots={leg.option === 'FUT' ? undefined : () => setSelectedLegForAddLots(leg)}
                      onShift={onShiftLegs && leg.option !== 'FUT' ? (d => runShift([leg.id], d)) : undefined}
                      shiftSteps={shiftSteps}
                      shiftBusy={placing || exiting || shifting}
                      columns={legColumns}
                      showExit={showExitCol}
                      iv={leg.option === 'FUT' ? 0 : ivForStrike?.(leg.strike, leg.option, leg.expiry || basket.expiry) ?? 0}
                      strikeBlocked={leg.status === 'DRAFT' && !strikeAllowed(basket.underlying, leg.expiry || basket.expiry, expiries, leg.strike)}
                      selected={!!selectedLegIds?.has(leg.id)}
                      onSelect={onSelectLegs ? (on => onSelectLegs([leg.id], on)) : undefined}
                      onTag={onTagLeg ? (tag => onTagLeg(leg.id, tag)) : undefined}
                      onDetach={onDetachLeg && leg.status !== 'PLACING' && leg.status !== 'CLOSING'
                        ? (() => onDetachLeg(leg.id)) : undefined}
                    />
                  ))}
                </tbody>
              </table>
              </div>
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
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setShowPayoffChart(v => !v)}
                  className={`flex-1 flex items-center justify-between gap-2 px-3 py-2 text-xs font-bold text-zinc-300 hover:text-white transition-colors ${FOCUS_RING}`}
                >
                  <span className="uppercase tracking-wider">Payoff Diagram</span>
                  {showPayoffChart ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPnlTable(true)}
                  title="P&L table: spot × date, priced with Black-Scholes at live IV"
                  className={`mr-2 inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-bold text-zinc-300 hover:border-zinc-600 hover:text-white transition-colors ${FOCUS_RING}`}
                >
                  <Table2 className="w-3.5 h-3.5" /> P&amp;L Table
                </button>
              </div>
              <PnlTableModal
                isOpen={showPnlTable}
                onClose={() => setShowPnlTable(false)}
                title={strategyLabel}
                legs={basket.legs}
                basketExpiry={basket.expiry}
                spot={spot ?? 0}
                step={step || 50}
                lotSize={defaultLotSize}
                qtyMultiplier={crudeMult}
                ltpFor={ltpFor}
                ivForStrike={ivForStrike}
              />

              {showPayoffChart && (
                <div className="px-3 pb-3">
                  {/* The shared chart, fed by the central payoff library: the same model the header strips above read. */}
                  {payoffModel && payoffModel.points.length > 1 ? (
                    <PayoffDiagram
                      title="Strategy payoff"
                      {...modelToDiagramProps(payoffModel)}
                      currentSpot={spot ?? 0}
                      targetDays={simTargetDays}
                      maxDays={maxDays}
                      onTargetDaysChange={setSimTargetDays}
                      ivShift={simIvShift}
                      onIvShiftChange={setSimIvShift}
                      strikes={strategyStrikes}
                      note={
                        <span>
                          Open P&amp;L at today&apos;s level <span className={payoffModel.nowPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtMoney(payoffModel.nowPnl)}</span>
                          {payoffModel.laterExpiries.length > 0
                            ? ` · value as of the near expiry (${payoffModel.frontExpiry}); later legs (${payoffModel.laterExpiries.join(', ')}) keep their time value, priced via Black-76`
                            : ` · at expiry (${payoffModel.frontExpiry})`}
                          {payoffModel.ivAssumed > 0 && <span className="text-amber-400"> · {payoffModel.ivAssumed} leg(s) priced on an assumed IV</span>}
                        </span>
                      }
                    />
                  ) : (
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
          listedExpiries={expiries}
          atmStrike={atmStrike}
          lotSize={defaultLotSize}
          ltpForStrike={ltpForStrike ?? ((s, o) => 0)}
          onAddLeg={onAddNewLeg}
        />
      )}

      {/* Mounted at the row root (not inside the expanded section) so the header's Position Map
         button works while the row is collapsed. */}
      {onScaleStrategy && (
        <ScaleStrategyModal
          key={showScale ? 'open' : 'closed'} /* remount per opening: N starts at 1, never the last session's value */
          isOpen={showScale}
          onClose={() => setShowScale(false)}
          basket={basket}
          title={strategyLabel}
          currentMargin={basketMargin ?? null}
          marginSource={basketMarginSource}
          availableFunds={availableFunds ?? null}
          onConfirm={onScaleStrategy}
        />
      )}
      {showStrategyChart && (
        <StrategyChartModal
          isOpen
          onClose={() => setShowStrategyChart(false)}
          title={strategyLabel}
          underlying={basket.underlying}
          expiry={basket.expiry}
          legs={basket.legs}
          lotSize={crudeMult === 1 ? defaultLotSize : undefined}
        />
      )}
      <PositionVisualizerModal
        isOpen={showPositionVisualizer}
        onClose={() => setShowPositionVisualizer(false)}
        title={strategyLabel}
        basketId={basket.id}
        underlying={basket.underlying}
        legs={basket.legs}
        basketExpiry={basket.expiry}
        spot={spot ?? 0}
        step={step || 50}
        lotSize={defaultLotSize}
        qtyMultiplier={crudeMult}
        ltpFor={ltpFor}
        ivForStrike={ivForStrike}
      />
    </div>
  );
}
