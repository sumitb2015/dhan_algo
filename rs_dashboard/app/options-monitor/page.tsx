'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import TopMetricBar from '@/components/options-monitor/TopMetricBar';
import PositionsStrategyMonitor from '@/components/options-monitor/PositionsStrategyMonitor';
import RiskGreeksMatrix from '@/components/options-monitor/RiskGreeksMatrix';
import AddLegModal from '@/components/options-monitor/AddLegModal';
import HotkeysModal from '@/components/options-monitor/HotkeysModal';
import {
  UNDERLYINGS,
  OptionLegModel,
  OptType,
  Side,
  computeBsGreeks,
  generatePayoffCurve,
  computePortfolioMetrics,
} from '@/lib/optionsMonitorMath';

export default function OptionsMonitorPage() {
  // Underlying configuration
  const [selectedUnderlying, setSelectedUnderlying] = useState<string>('NIFTY');
  const uConfig = UNDERLYINGS[selectedUnderlying] || UNDERLYINGS.NIFTY;

  // Spot price state
  const [spot, setSpot] = useState<number>(uConfig.defaultSpot);
  const [prevClose, setPrevClose] = useState<number>(uConfig.defaultSpot - 34.5);
  const [change, setChange] = useState<number>(34.5);
  const [changePct, setChangePct] = useState<number>(0.14);
  const [ivPct, setIvPct] = useState<number>(14.5);
  const [isLiveLoading, setIsLiveLoading] = useState<boolean>(false);

  // Strategy title
  const [strategyName, setStrategyName] = useState<string>('Short Strangle');

  // Modals state
  const [isAddLegOpen, setIsAddLegOpen] = useState<boolean>(false);
  const [isHotkeysOpen, setIsHotkeysOpen] = useState<boolean>(false);

  // Last action toast/notification
  const [lastActionMessage, setLastActionMessage] = useState<string | null>(
    'Session initialized. Keyboard hotkeys active: [C, P, H, W, X, ESC]'
  );

  // Active Legs initialized precisely to the prompt's diagram:
  // Short Strangle (2 Lots / 150 Qty):
  // SELL CE 24950 | LTP 38.5 | Entry 34.5 | -₹330 | Delta -0.24 | IV 14.2%
  // SELL PE 24650 | LTP 28.9 | Entry 34.6 | +₹578 | Delta +0.18 | IV 14.8%
  const [legs, setLegs] = useState<OptionLegModel[]>([
    {
      id: 'leg_ce_init',
      type: 'CE',
      side: 'SELL',
      strike: 24950,
      lots: 2,
      qty: 150,
      entryPrice: 34.5,
      ltp: 38.5,
      delta: -0.24,
      gamma: 0.0022,
      theta: 3950,
      vega: 750,
      iv: 0.142,
    },
    {
      id: 'leg_pe_init',
      type: 'PE',
      side: 'SELL',
      strike: 24650,
      lots: 2,
      qty: 150,
      entryPrice: 34.6,
      ltp: 28.9,
      delta: 0.18,
      gamma: 0.0020,
      theta: 3652,
      vega: 717,
      iv: 0.148,
    },
  ]);

  // Fetch live spot quote from /api/options/spot
  const fetchLiveSpot = useCallback(async () => {
    setIsLiveLoading(true);
    try {
      const res = await fetch(`/api/options/spot?underlying=${selectedUnderlying}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (data && data.success && typeof data.spot === 'number' && data.spot > 0) {
        setSpot(data.spot);
        if (typeof data.prev_close === 'number') setPrevClose(data.prev_close);
        if (typeof data.change === 'number') setChange(data.change);
        if (typeof data.change_pct === 'number') setChangePct(data.change_pct);
      }
    } catch {
      // Graceful fallback to default spot
    } finally {
      setIsLiveLoading(false);
    }
  }, [selectedUnderlying]);

  // Poll spot every 15 seconds
  useEffect(() => {
    document.title = 'Options Risk & Strategy Monitor | Dhan Algo';
    fetchLiveSpot();
    const timer = setInterval(fetchLiveSpot, 15000);
    return () => clearInterval(timer);
  }, [fetchLiveSpot]);

  // Handle switching underlying
  const handleSelectUnderlying = (sym: string) => {
    setSelectedUnderlying(sym);
    const cfg = UNDERLYINGS[sym] || UNDERLYINGS.NIFTY;
    setSpot(cfg.defaultSpot);
    const atm = Math.round(cfg.defaultSpot / cfg.strikeStep) * cfg.strikeStep;

    // Re-initialize default strangle for the new underlying
    setLegs([
      {
        id: `leg_${Date.now()}_ce`,
        type: 'CE',
        side: 'SELL',
        strike: atm + cfg.strikeStep * 2,
        lots: 2,
        qty: 2 * cfg.lotSize,
        entryPrice: 35.0,
        ltp: 38.5,
        delta: -0.24,
        gamma: 0.0022,
        theta: 3900,
        vega: 750,
        iv: 0.145,
      },
      {
        id: `leg_${Date.now()}_pe`,
        type: 'PE',
        side: 'SELL',
        strike: atm - cfg.strikeStep * 2,
        lots: 2,
        qty: 2 * cfg.lotSize,
        entryPrice: 35.0,
        ltp: 29.0,
        delta: 0.18,
        gamma: 0.002,
        theta: 3700,
        vega: 720,
        iv: 0.145,
      },
    ]);
    setLastActionMessage(`Switched underlying to ${cfg.name} (ATM: ${atm})`);
  };

  // Compute portfolio metrics
  const portfolioGreeks = useMemo(() => {
    return computePortfolioMetrics(legs, spot, uConfig.lotSize);
  }, [legs, spot, uConfig.lotSize]);

  // Compute 2D payoff curve & breakevens
  const { points: payoffPoints, breakevens } = useMemo(() => {
    return generatePayoffCurve(legs, spot, uConfig.lotSize, 2 / 365, ivPct / 100, uConfig.strikeStep);
  }, [legs, spot, uConfig.lotSize, ivPct, uConfig.strikeStep]);

  // Total lots & total quantity
  const totalLots = useMemo(() => {
    return legs.reduce((sum, l) => sum + l.lots, 0);
  }, [legs]);

  const totalQty = useMemo(() => {
    return legs.reduce((sum, l) => sum + l.qty, 0);
  }, [legs]);

  // Show notification helper
  const notifyAction = (msg: string) => {
    setLastActionMessage(msg);
  };

  // ── LEGS MUTATION ACTIONS ──────────────────────────────────────────────────

  // Add custom leg (Open for all strikes)
  const handleAddLeg = (newLegData: {
    type: OptType;
    side: Side;
    strike: number;
    lots: number;
    entryPrice: number;
  }) => {
    const g = computeBsGreeks(
      newLegData.type,
      spot,
      newLegData.strike,
      2 / 365,
      ivPct / 100,
      uConfig.lotSize
    );

    const newLeg: OptionLegModel = {
      id: `leg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: newLegData.type,
      side: newLegData.side,
      strike: newLegData.strike,
      lots: newLegData.lots,
      qty: newLegData.lots * uConfig.lotSize,
      entryPrice: newLegData.entryPrice,
      ltp: g.price,
      delta: g.delta,
      gamma: g.gamma,
      theta: g.theta,
      vega: g.vega,
      iv: ivPct / 100,
    };

    setLegs((prev) => [...prev, newLeg]);
    setStrategyName('Custom Strikes');
    notifyAction(`Added ${newLegData.side} ${newLegData.strike} ${newLegData.type} (${newLegData.lots} Lots)`);
  };

  // Remove specific leg
  const handleRemoveLeg = (id: string) => {
    const leg = legs.find((l) => l.id === id);
    setLegs((prev) => prev.filter((l) => l.id !== id));
    if (leg) {
      notifyAction(`Closed ${leg.side} ${leg.strike} ${leg.type}`);
    }
  };

  // Update specific leg strike directly from dropdown
  const handleUpdateLegStrike = (id: string, newStrike: number) => {
    setLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const g = computeBsGreeks(l.type, spot, newStrike, 2 / 365, l.iv, uConfig.lotSize);
        return {
          ...l,
          strike: newStrike,
          ltp: g.price,
          delta: g.delta,
          gamma: g.gamma,
          theta: g.theta,
          vega: g.vega,
        };
      })
    );
    notifyAction(`Updated strike to ${newStrike}`);
  };

  // Quick Shift strike by steps (+1 or -1 strikeStep)
  const handleQuickShiftStrike = (id: string, steps: number) => {
    setLegs((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const newStrike = l.strike + steps * uConfig.strikeStep;
        const g = computeBsGreeks(l.type, spot, newStrike, 2 / 365, l.iv, uConfig.lotSize);
        return {
          ...l,
          strike: newStrike,
          ltp: g.price,
          delta: g.delta,
          gamma: g.gamma,
          theta: g.theta,
          vega: g.vega,
        };
      })
    );
    const leg = legs.find((l) => l.id === id);
    if (leg) {
      notifyAction(`Shifted ${leg.side} ${leg.type} to ${leg.strike + steps * uConfig.strikeStep}`);
    }
  };

  // Load Strategy Preset Template
  const handleSelectStrategyPreset = (presetId: string) => {
    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;

    if (presetId === 'clear') {
      setLegs([]);
      setStrategyName('No Active Legs');
      notifyAction('Cleared all positions.');
      return;
    }

    if (presetId === 'short_strangle') {
      setStrategyName('Short Strangle');
      setLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm + uConfig.strikeStep * 2,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 34.5,
          ltp: 38.5,
          delta: -0.24,
          gamma: 0.0022,
          theta: 3950,
          vega: 750,
          iv: 0.142,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm - uConfig.strikeStep * 2,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 34.6,
          ltp: 28.9,
          delta: 0.18,
          gamma: 0.002,
          theta: 3652,
          vega: 717,
          iv: 0.148,
        },
      ]);
      notifyAction(`Loaded Short Strangle at ${atm - uConfig.strikeStep * 2} PE / ${atm + uConfig.strikeStep * 2} CE`);
    } else if (presetId === 'short_straddle') {
      setStrategyName('Short Straddle');
      setLegs([
        {
          id: `ce_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 85.0,
          ltp: 82.5,
          delta: -0.5,
          gamma: 0.0042,
          theta: 5200,
          vega: 1100,
          iv: 0.145,
        },
        {
          id: `pe_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 84.0,
          ltp: 81.0,
          delta: 0.5,
          gamma: 0.0042,
          theta: 5100,
          vega: 1080,
          iv: 0.145,
        },
      ]);
      notifyAction(`Loaded Short Straddle at ATM ${atm}`);
    } else if (presetId === 'iron_condor') {
      setStrategyName('Iron Condor');
      setLegs([
        // Short wings
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm + uConfig.strikeStep * 2,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 35.0,
          ltp: 38.0,
          delta: -0.24,
          gamma: 0.0022,
          theta: 3900,
          vega: 750,
          iv: 0.145,
        },
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm - uConfig.strikeStep * 2,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 35.0,
          ltp: 29.0,
          delta: 0.18,
          gamma: 0.002,
          theta: 3700,
          vega: 720,
          iv: 0.145,
        },
        // Long protective wings
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: atm + uConfig.strikeStep * 5,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 10.0,
          ltp: 9.5,
          delta: 0.08,
          gamma: 0.0009,
          theta: 1100,
          vega: 240,
          iv: 0.15,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: atm - uConfig.strikeStep * 5,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 10.5,
          ltp: 8.5,
          delta: -0.07,
          gamma: 0.0008,
          theta: 1050,
          vega: 230,
          iv: 0.15,
        },
      ]);
      notifyAction(`Loaded Iron Condor with defined risk wings`);
    } else if (presetId === 'bull_put_spread') {
      setStrategyName('Bull Put Spread');
      setLegs([
        {
          id: `pe_short_${Date.now()}`,
          type: 'PE',
          side: 'SELL',
          strike: atm - uConfig.strikeStep,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 42.0,
          ltp: 40.0,
          delta: 0.28,
          gamma: 0.0028,
          theta: 4200,
          vega: 820,
          iv: 0.145,
        },
        {
          id: `pe_long_${Date.now()}`,
          type: 'PE',
          side: 'BUY',
          strike: atm - uConfig.strikeStep * 3,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 16.0,
          ltp: 15.0,
          delta: -0.12,
          gamma: 0.0014,
          theta: 1700,
          vega: 360,
          iv: 0.148,
        },
      ]);
      notifyAction(`Loaded Bull Put Credit Spread`);
    } else if (presetId === 'bear_call_spread') {
      setStrategyName('Bear Call Spread');
      setLegs([
        {
          id: `ce_short_${Date.now()}`,
          type: 'CE',
          side: 'SELL',
          strike: atm + uConfig.strikeStep,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 42.0,
          ltp: 41.0,
          delta: -0.3,
          gamma: 0.003,
          theta: 4300,
          vega: 840,
          iv: 0.145,
        },
        {
          id: `ce_long_${Date.now()}`,
          type: 'CE',
          side: 'BUY',
          strike: atm + uConfig.strikeStep * 3,
          lots: 2,
          qty: 2 * uConfig.lotSize,
          entryPrice: 16.0,
          ltp: 15.5,
          delta: 0.13,
          gamma: 0.0015,
          theta: 1750,
          vega: 370,
          iv: 0.148,
        },
      ]);
      notifyAction(`Loaded Bear Call Credit Spread`);
    }
  };

  // ── QUICK EXECUTION & ADJUSTMENT HANDLERS (HOTKEYS) ───────────────────────

  // Hotkey: [C] Roll CE further OTM
  const handleRollCe = useCallback(() => {
    const ceLeg = legs.find((l) => l.type === 'CE' && l.side === 'SELL');
    if (!ceLeg) {
      notifyAction('No active short CE leg found to roll.');
      return;
    }
    const newStrike = ceLeg.strike + uConfig.strikeStep;
    handleUpdateLegStrike(ceLeg.id, newStrike);
    notifyAction(`[HOTKEY C] Rolled Short CE from ${ceLeg.strike} to ${newStrike} (+${uConfig.strikeStep} pts OTM)`);
  }, [legs, uConfig.strikeStep]);

  // Hotkey: [P] Roll PE further OTM
  const handleRollPe = useCallback(() => {
    const peLeg = legs.find((l) => l.type === 'PE' && l.side === 'SELL');
    if (!peLeg) {
      notifyAction('No active short PE leg found to roll.');
      return;
    }
    const newStrike = peLeg.strike - uConfig.strikeStep;
    handleUpdateLegStrike(peLeg.id, newStrike);
    notifyAction(`[HOTKEY P] Rolled Short PE from ${peLeg.strike} to ${newStrike} (-${uConfig.strikeStep} pts OTM)`);
  }, [legs, uConfig.strikeStep]);

  // Hotkey: [H] 1-Click Delta Hedge
  const handleDeltaHedge = useCallback(() => {
    const currentDelta = portfolioGreeks.netDelta;
    if (Math.abs(currentDelta) < 1.0) {
      notifyAction(`Delta is already balanced (${currentDelta > 0 ? '+' : ''}${currentDelta.toFixed(2)} Δ). No hedge required.`);
      return;
    }

    const atm = Math.round(spot / uConfig.strikeStep) * uConfig.strikeStep;

    // If net delta is positive, buy PE or sell CE to offset
    if (currentDelta > 0) {
      const hedgeStrike = atm - uConfig.strikeStep;
      handleAddLeg({
        type: 'PE',
        side: 'BUY',
        strike: hedgeStrike,
        lots: 1,
        entryPrice: 28.0,
      });
      notifyAction(`[HOTKEY H] Delta Hedge executed: Bought 1 Lot ${hedgeStrike} PE to neutralize +${currentDelta.toFixed(2)} Δ`);
    } else {
      const hedgeStrike = atm + uConfig.strikeStep;
      handleAddLeg({
        type: 'CE',
        side: 'BUY',
        strike: hedgeStrike,
        lots: 1,
        entryPrice: 28.0,
      });
      notifyAction(`[HOTKEY H] Delta Hedge executed: Bought 1 Lot ${hedgeStrike} CE to neutralize ${currentDelta.toFixed(2)} Δ`);
    }
  }, [portfolioGreeks.netDelta, spot, uConfig.strikeStep]);

  // Hotkey: [W] Add Wings (convert to Iron Condor)
  const handleAddWings = useCallback(() => {
    const ceLeg = legs.find((l) => l.type === 'CE' && l.side === 'SELL');
    const peLeg = legs.find((l) => l.type === 'PE' && l.side === 'SELL');

    if (!ceLeg || !peLeg) {
      notifyAction('Add Wings requires active Short CE and Short PE legs.');
      return;
    }

    const wingCeStrike = ceLeg.strike + uConfig.strikeStep * 3;
    const wingPeStrike = peLeg.strike - uConfig.strikeStep * 3;

    // Add CE wing
    const gCe = computeBsGreeks('CE', spot, wingCeStrike, 2 / 365, ivPct / 100, uConfig.lotSize);
    const ceWing: OptionLegModel = {
      id: `wing_ce_${Date.now()}`,
      type: 'CE',
      side: 'BUY',
      strike: wingCeStrike,
      lots: ceLeg.lots,
      qty: ceLeg.lots * uConfig.lotSize,
      entryPrice: gCe.price,
      ltp: gCe.price,
      delta: gCe.delta,
      gamma: gCe.gamma,
      theta: gCe.theta,
      vega: gCe.vega,
      iv: ivPct / 100,
    };

    // Add PE wing
    const gPe = computeBsGreeks('PE', spot, wingPeStrike, 2 / 365, ivPct / 100, uConfig.lotSize);
    const peWing: OptionLegModel = {
      id: `wing_pe_${Date.now()}`,
      type: 'PE',
      side: 'BUY',
      strike: wingPeStrike,
      lots: peLeg.lots,
      qty: peLeg.lots * uConfig.lotSize,
      entryPrice: gPe.price,
      ltp: gPe.price,
      delta: gPe.delta,
      gamma: gPe.gamma,
      theta: gPe.theta,
      vega: gPe.vega,
      iv: ivPct / 100,
    };

    setLegs((prev) => [...prev, ceWing, peWing]);
    setStrategyName('Iron Condor (Wings Added)');
    notifyAction(`[HOTKEY W] Wings Added: Bought ${wingPeStrike} PE & ${wingCeStrike} CE (Tail risk capped)`);
  }, [legs, spot, ivPct, uConfig.strikeStep, uConfig.lotSize]);

  // Hotkey: [X] Trim 50%
  const handleTrim50 = useCallback(() => {
    if (legs.length === 0) {
      notifyAction('No active legs to trim.');
      return;
    }
    setLegs((prev) =>
      prev.map((l) => {
        const newLots = Math.max(1, Math.round(l.lots / 2));
        return {
          ...l,
          lots: newLots,
          qty: newLots * uConfig.lotSize,
        };
      })
    );
    notifyAction('[HOTKEY X] Trimmed 50% of position lots across all legs.');
  }, [legs, uConfig.lotSize]);

  // Hotkey: [Escape] FLATTEN
  const handleFlatten = useCallback(() => {
    if (legs.length === 0) {
      notifyAction('Position already flat.');
      return;
    }
    setLegs([]);
    setStrategyName('Flat / No Position');
    notifyAction('[HOTKEY ESC] FLATTEN EXECUTED: All open positions squared off.');
  }, [legs]);

  // ── GLOBAL KEYBOARD BINDINGS LISTENER ──────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keystrokes when typing in an input or textarea
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const key = e.key.toUpperCase();

      if (key === 'C') {
        e.preventDefault();
        handleRollCe();
      } else if (key === 'P') {
        e.preventDefault();
        handleRollPe();
      } else if (key === 'H') {
        e.preventDefault();
        handleDeltaHedge();
      } else if (key === 'W') {
        e.preventDefault();
        handleAddWings();
      } else if (key === 'X') {
        e.preventDefault();
        handleTrim50();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleFlatten();
      } else if (key === 'A') {
        e.preventDefault();
        setIsAddLegOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRollCe, handleRollPe, handleDeltaHedge, handleAddWings, handleTrim50, handleFlatten]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col font-sans">
      {/* ── TOP METRIC BAR (Matches prompt diagram) ────────────────────────── */}
      <TopMetricBar
        selectedUnderlying={selectedUnderlying}
        onSelectUnderlying={handleSelectUnderlying}
        spot={spot}
        prevClose={prevClose}
        change={change}
        changePct={changePct}
        ivPct={ivPct}
        totalMtm={portfolioGreeks.totalMtm}
        mtmPct={portfolioGreeks.mtmPct}
        netTheta={portfolioGreeks.netTheta}
        estimatedMargin={portfolioGreeks.estimatedMargin}
        isLiveLoading={isLiveLoading}
        onRefreshQuotes={fetchLiveSpot}
        onToggleHotkeysModal={() => setIsHotkeysOpen(true)}
      />

      {/* ── MAIN WORKSPACE (60% / 40% Two-Column Layout) ───────────────────── */}
      <main className="flex-1 w-full max-w-[1700px] mx-auto p-3.5 md:p-4">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* LEFT COLUMN: 60% Width */}
          <div className="w-full lg:w-[60%] flex-1">
            <PositionsStrategyMonitor
              strategyName={strategyName}
              totalLots={totalLots}
              totalQty={totalQty}
              legs={legs}
              spot={spot}
              strikeStep={uConfig.strikeStep}
              payoffPoints={payoffPoints}
              breakevens={breakevens}
              onAddLegClick={() => setIsAddLegOpen(true)}
              onRemoveLeg={handleRemoveLeg}
              onUpdateLegStrike={handleUpdateLegStrike}
              onQuickShiftStrike={handleQuickShiftStrike}
              onSelectStrategyPreset={handleSelectStrategyPreset}
            />
          </div>

          {/* RIGHT COLUMN: 40% Width */}
          <div className="w-full lg:w-[40%] shrink-0">
            <RiskGreeksMatrix
              greeks={portfolioGreeks}
              lastActionMessage={lastActionMessage}
              onRollCe={handleRollCe}
              onRollPe={handleRollPe}
              onDeltaHedge={handleDeltaHedge}
              onAddWings={handleAddWings}
              onTrim50={handleTrim50}
              onFlatten={handleFlatten}
            />
          </div>
        </div>
      </main>

      {/* ── MODALS ───────────────────────────────────────────────────────── */}
      <AddLegModal
        isOpen={isAddLegOpen}
        onClose={() => setIsAddLegOpen(false)}
        spot={spot}
        strikeStep={uConfig.strikeStep}
        defaultLots={2}
        onAddLeg={handleAddLeg}
      />

      <HotkeysModal
        isOpen={isHotkeysOpen}
        onClose={() => setIsHotkeysOpen(false)}
      />
    </div>
  );
}
