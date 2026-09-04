'use client';

import React, { useState, useMemo, useCallback } from 'react';
import {
  ChevronDown, ChevronUp, Trash2, Plus, X, AlertTriangle, Check, Layers,
} from 'lucide-react';
import MultiLegLegRow from './MultiLegLegRow';
import RuleNumInput from './RuleNumInput';
import AddLotsModal from './AddLotsModal';
import AddNewLegModal from './AddNewLegModal';
import {
  computeLegTrailingSL, computeStrategyMetrics, checkStrategyRisk,
  type MultiLegBasket, type MultiLegLeg, type StrategyRiskConfig,
} from '@/lib/multiLegFocus';
import { computePayoff, type PayoffLeg, type PayoffResult } from '@/lib/basketStrategies';
import { FOCUS_RING } from '@/components/Scalper';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

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
  ltpForStrike?: (strike: number, option: 'CE' | 'PE') => number;
  onUpdate: (patch: Partial<MultiLegBasket>) => void;
  onDelete: () => void;
  onPlace: () => Promise<void>;
  onExit: () => Promise<void>;
  onExitLeg: (leg: MultiLegLeg) => Promise<void>;
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
  onUpdate,
  onDelete,
  onPlace,
  onExit,
  onExitLeg,
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
}: MultiLegStrategyRowProps) {
  const [expanded, setExpanded] = useState(true);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const [selectedLegForAddLots, setSelectedLegForAddLots] = useState<MultiLegLeg | null>(null);
  const [isAddNewLegModalOpen, setIsAddNewLegModalOpen] = useState<boolean>(false);

  const hasPlacedLeg = useMemo(() => {
    return basket.legs.some(l => l.status !== 'DRAFT');
  }, [basket.legs]);

  const hasActivePositions = useMemo(() => {
    return basket.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING' || l.status === 'CLOSING');
  }, [basket.legs]);

  const basketStatus = useMemo(() => {
    if (basket.legs.length === 0) return 'DRAFT';
    if (basket.legs.some(l => l.status === 'PLACING')) return 'PLACING';
    if (basket.legs.some(l => l.status === 'CLOSING')) return 'CLOSING';
    if (basket.legs.some(l => l.status === 'OPEN')) return 'OPEN';
    if (basket.legs.every(l => l.status === 'CLOSED')) return 'CLOSED';
    if (basket.legs.some(l => l.status === 'FAILED')) return 'FAILED';
    return 'DRAFT';
  }, [basket.legs]);

  const crudeMult = broker === 'dhan'
    ? (basket.underlying === 'CRUDEOIL' ? 100 : basket.underlying === 'CRUDEOILM' ? 10 : 1)
    : 1;

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

  // ── Payoff: Breakevens, Max Profit, Max Loss ───────────────────────
  const payoffResult: PayoffResult | null = useMemo(() => {
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
  }, [basket.legs, basket.underlying, lotSize, ltpFor]);

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
      {/* Strategy Header Bar */}
      <div className="px-4 py-3 bg-zinc-900/90 border-b border-zinc-800 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
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
              {basket.presetKey ? basket.presetKey.replace(/-/g, ' ') : `Strategy #${index + 1}`}
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

          {/* Underlying Selector */}
          <div className="flex items-center gap-1">
            <label className="text-[10px] text-zinc-400 font-semibold uppercase">Index:</label>
            <select
              value={basket.underlying}
              disabled={hasPlacedLeg}
              onChange={e => onUpdate({ underlying: e.target.value })}
              className="h-7 bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs font-bold rounded px-2 focus:outline-none focus:border-emerald-500 disabled:opacity-60"
            >
              {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>

          {/* Expiry Selector */}
          <div className="flex items-center gap-1">
            <label className="text-[10px] text-zinc-400 font-semibold uppercase">Expiry:</label>
            <select
              value={basket.expiry}
              disabled={hasPlacedLeg}
              onChange={e => onUpdate({ expiry: e.target.value })}
              className="h-7 bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs font-bold rounded px-2 focus:outline-none focus:border-emerald-500 disabled:opacity-60"
            >
              {!expiries.includes(basket.expiry) && basket.expiry && (
                <option value={basket.expiry}>{basket.expiry}</option>
              )}
              {expiries.map(exp => <option key={exp} value={exp}>{exp}</option>)}
            </select>
          </div>
        </div>

        {/* Right Side: Breakevens, Max P/L, Total P&L & Strategy Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {payoffResult && (
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
              {onAddNewLeg && (
                <button
                  type="button"
                  onClick={() => setIsAddNewLegModalOpen(true)}
                  title="Add a new leg to this active strategy"
                  className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 ${FOCUS_RING}`}
                >
                  <Plus className="w-3 h-3" /> Add Leg
                </button>
              )}
              <button
                type="button"
                onClick={onExit}
                disabled={exiting}
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
              {payoffResult && (
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
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  <col className="w-[5%]" />
                  <col className="w-[5%]" />
                  <col className="w-[8%]" />
                  <col className="w-[5%]" />
                  <col className="w-[7%]" />
                  <col className="w-[6%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[4%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[6%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
                    <th className="px-2 py-2 text-left">Side</th>
                    <th className="px-1.5 py-2 text-left">CE/PE</th>
                    <th className="px-2 py-2 text-left">Strike</th>
                    <th className="px-1.5 py-2 text-center">Lots</th>
                    <th className="px-2 py-2 text-left">Type</th>
                    <th className="px-2 py-2 text-right">LTP</th>
                    <th className="px-2 py-2 text-left">SL</th>
                    <th className="px-2 py-2 text-left">TP</th>
                    <th className="px-1 py-2 text-center">Trail</th>
                    <th className="px-2 py-2 text-right">Margin</th>
                    <th className="px-2 py-2 text-right">P&L</th>
                    <th className="px-1.5 py-2 text-center">Status</th>
                    <th className="px-2 py-2 text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {basket.legs.map(leg => (
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
                      onChange={patch => updateLeg(leg.id, patch)}
                      onRemove={() => removeLeg(leg.id)}
                      onExit={() => onExitLeg(leg)}
                      onOpenAddLots={() => setSelectedLegForAddLots(leg)}
                    />
                  ))}
                </tbody>
              </table>
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
