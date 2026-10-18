/**
 * Nifty Managed Straddle — Algo Lab Strategy (spec: strategies/managed_straddle/strategy.md).
 *
 * Sells ATM Straddle (CE and PE) starting at 09:20 if balanced (< 10% premium diff).
 * Manages with:
 *  - 20% Combined SL across both legs (global emergency exit).
 *  - 20% Individual Leg SL: losing leg closes, scanner matches opposite surviving leg's LTP.
 *  - 30% Individual Leg Target decay: winning leg closes, scanner matches opposite surviving leg's LTP.
 *  - Global EOD square-off at 15:15 IST.
 */

import { initialStop, r2, targetHit, targetOf } from '../risk.ts';
import type {
  AlgoConfig,
  AlgoCtx,
  Candidate,
  ExitSignal,
  GateResult,
  OptType,
  StrategyDefinition,
} from '../types.ts';

const num = (c: AlgoConfig, k: string) => Number(c[k]);

export const managedStraddle: StrategyDefinition = {
  key: 'managed_straddle',
  label: 'Nifty Managed Straddle',
  description: 'Sells balanced ATM straddle at 09:20 (<10% diff). Manages with 20% combined SL, 20% leg SL, 30% target with premium-matching rolls.',
  docPath: 'strategies/managed_straddle/strategy.md',
  side: 'SELL',
  underlyings: ['NIFTY'],
  status: 'VALIDATED',
  schema: [
    // Entry Group
    {
      key: 'entryDiffPct',
      label: 'ATM balance threshold',
      group: 'Entry',
      kind: 'number',
      min: 1,
      max: 30,
      step: 0.5,
      unit: '%',
      help: 'Maximum % difference between ATM CE and PE prices allowed to trigger entry.',
    },

    // Exit Group
    {
      key: 'combinedSlPct',
      label: 'Combined premium stop-loss',
      group: 'Exit',
      kind: 'number',
      min: 5,
      max: 100,
      integer: true,
      unit: '%',
      help: 'Global stop-loss: exits all legs if combined entry premium expands by this percentage.',
    },
    {
      key: 'legSlPct',
      label: 'Individual leg stop-loss',
      group: 'Exit',
      kind: 'number',
      min: 5,
      max: 100,
      integer: true,
      unit: '%',
      help: 'Stop-loss on individual legs: closes losing leg and rolls to match opposite surviving leg premium.',
    },
    {
      key: 'legTargetPct',
      label: 'Individual leg target decay',
      group: 'Exit',
      kind: 'number',
      min: 5,
      max: 100,
      integer: true,
      unit: '%',
      help: 'Profit target on individual legs: closes winning leg and rolls to match opposite surviving leg premium.',
    },
    {
      key: 'maxAdjustments',
      label: 'Max adjustment rolls',
      group: 'Exit',
      kind: 'number',
      min: 0,
      max: 30,
      integer: true,
      help: 'Maximum number of premium-matching rolls allowed per session.',
    },

    // Risk Group
    {
      key: 'hardCircuitBreaker',
      label: 'Hard circuit breaker',
      group: 'Risk',
      kind: 'boolean',
      help: 'Emergency square off all open positions when daily loss limit is reached',
    },

    // Costs Group
    {
      key: 'dataSource',
      label: 'Backtest data source',
      group: 'Costs',
      kind: 'select',
      options: [
        { value: 'dhan', label: 'Dhan DB' },
        { value: 'breeze', label: 'ICICI Breeze DB' },
      ],
      backtestOnly: true,
      help: 'Backtest option chain data source',
    },
  ],

  defaults: {
    timeframe: 1,
    strikeWindow: 8,
    maxConcurrent: 2,
    maxSameSide: 1,
    lotsPerTrade: 1,
    dailyLossLimit: 5000,
    entryStart: '09:20',
    entryEnd: '15:00',
    eodExit: '15:15',
    brokerage: 20,
    slippagePts: 0,
    btWarmOnly: false,
    entryDiffPct: 10,
    combinedSlPct: 20,
    legSlPct: 20,
    legTargetPct: 30,
    maxAdjustments: 10,
    hardCircuitBreaker: true,
  },

  warmupBars(_c: AlgoConfig): number {
    return 1;
  },

  gate(ctx: AlgoCtx, c: AlgoConfig): GateResult {
    const hm = ctx.hm;
    if (hm < c.entryStart || hm > c.entryEnd || hm >= c.eodExit) {
      return {
        bias: 'WINDOW',
        tone: 'neutral',
        allowed: [],
        detail: `Outside entry window (${c.entryStart} - ${c.entryEnd})`,
      };
    }

    const step = ctx.step || 50;
    const atm = Math.round(ctx.spot / step) * step;
    const ceKey = `${atm}CE`;
    const peKey = `${atm}PE`;
    const ce = ctx.contracts[ceKey];
    const pe = ctx.contracts[peKey];

    if (!ce || !pe || !(ce.ltp > 0) || !(pe.ltp > 0)) {
      return {
        bias: 'QUOTES',
        tone: 'neutral',
        allowed: [],
        detail: `Waiting for ATM ${atm} quotes (spot ₹${ctx.spot.toFixed(1)})`,
        metrics: { spot: ctx.spot, atm },
      };
    }

    const minPx = Math.min(ce.ltp, pe.ltp);
    const diffPct = minPx > 0 ? ((Math.abs(ce.ltp - pe.ltp) / minPx) * 100) : 0;
    const maxDiff = num(c, 'entryDiffPct') || 10.0;

    if (diffPct > maxDiff) {
      return {
        bias: 'UNBALANCED',
        tone: 'neutral',
        allowed: [],
        detail: `ATM ${atm} diff ${diffPct.toFixed(1)}% > ${maxDiff}% (CE: ₹${ce.ltp.toFixed(1)}, PE: ₹${pe.ltp.toFixed(1)})`,
        metrics: { spot: ctx.spot, atm, diffPct: r2(diffPct), ceLtp: ce.ltp, peLtp: pe.ltp },
      };
    }

    return {
      bias: 'BALANCED',
      tone: 'neutral',
      allowed: ['CE', 'PE'],
      detail: `ATM ${atm} balanced (diff ${diffPct.toFixed(1)}% <= ${maxDiff}%). CE: ₹${ce.ltp.toFixed(1)}, PE: ₹${pe.ltp.toFixed(1)}`,
      metrics: { spot: ctx.spot, atm, diffPct: r2(diffPct), ceLtp: ce.ltp, peLtp: pe.ltp },
    };
  },

  scan(ctx: AlgoCtx, c: AlgoConfig, gate: GateResult): Candidate[] {
    const step = ctx.step || 50;
    const atm = Math.round(ctx.spot / step) * step;
    const ceOpen = ctx.open.find((p) => p.option === 'CE');
    const peOpen = ctx.open.find((p) => p.option === 'PE');
    const maxDiff = num(c, 'entryDiffPct') || 10.0;

    const allKeys = Object.keys(ctx.contracts);

    // ── Case 1: Both legs open -> Straddle active, no new entries ──
    if (ceOpen && peOpen) {
      return allKeys.map((k) => {
        const ct = ctx.contracts[k];
        return {
          key: ct.key,
          strike: ct.strike,
          option: ct.option,
          ltp: ct.ltp,
          score: 0,
          eligible: false,
          blockReason: 'Straddle active (both CE and PE open)',
          cols: {
            role: ct.key === ceOpen.key ? 'HELD CE' : ct.key === peOpen.key ? 'HELD PE' : '-',
            strike: ct.strike,
            diffPct: null,
            targetMatch: null,
            notes: 'Straddle active',
          },
        };
      });
    }

    // ── Case 2: Neither leg open -> Initial ATM Straddle Entry ──
    if (!ceOpen && !peOpen) {
      const ceKey = `${atm}CE`;
      const peKey = `${atm}PE`;
      const ce = ctx.contracts[ceKey];
      const pe = ctx.contracts[peKey];
      const minPx = ce && pe && ce.ltp > 0 && pe.ltp > 0 ? Math.min(ce.ltp, pe.ltp) : 0;
      const diffPct = minPx > 0 ? ((Math.abs(ce!.ltp - pe!.ltp) / minPx) * 100) : 999;
      const isBalanced = diffPct <= maxDiff && gate.allowed.includes('CE') && gate.allowed.includes('PE');

      return allKeys.map((k) => {
        const ct = ctx.contracts[k];
        const isAtmCe = k === ceKey;
        const isAtmPe = k === peKey;
        const isCandidate = isAtmCe || isAtmPe;
        const eligible = isCandidate && isBalanced && ct.ltp > 0;

        return {
          key: ct.key,
          strike: ct.strike,
          option: ct.option,
          ltp: ct.ltp,
          score: eligible ? 100 : 0,
          eligible,
          blockReason: eligible ? undefined : !isCandidate ? 'Non-ATM' : !isBalanced ? `Diff ${diffPct.toFixed(1)}% > ${maxDiff}%` : 'No LTP',
          cols: {
            role: isAtmCe ? 'ATM CE' : isAtmPe ? 'ATM PE' : 'OUTSIDE',
            strike: ct.strike,
            diffPct: isCandidate ? r2(diffPct) : null,
            targetMatch: isAtmCe ? (pe?.ltp ?? null) : isAtmPe ? (ce?.ltp ?? null) : null,
            notes: eligible ? 'Balanced ATM Entry' : isCandidate ? `Diff ${diffPct.toFixed(1)}%` : '-',
          },
        };
      });
    }

    // ── Case 3: Exactly one leg open -> Premium-Matching Roll Mode ──
    const surviving = ceOpen ?? peOpen!;
    const missingOpt: OptType = surviving.option === 'CE' ? 'PE' : 'CE';
    const survivingLtp = ctx.contracts[surviving.key]?.ltp ?? surviving.entryPrice;
    const survivingStrike = ctx.contracts[surviving.key]?.strike ?? atm;

    // Find all valid replacement candidates on the missing side
    // Inversion guard: CE strike must be >= PE strike
    const eligiblePool = allKeys
      .map((k) => ctx.contracts[k])
      .filter((ct) => {
        if (ct.option !== missingOpt || !(ct.ltp > 0)) return false;
        if (missingOpt === 'PE' && ct.strike > survivingStrike) return false; // PE must be <= CE strike
        if (missingOpt === 'CE' && ct.strike < survivingStrike) return false; // CE must be >= PE strike
        return true;
      });

    // Best candidate minimizes |ltp - survivingLtp|
    let bestMatchKey: string | null = null;
    let minDev = Infinity;
    for (const ct of eligiblePool) {
      const dev = Math.abs(ct.ltp - survivingLtp);
      if (dev < minDev) {
        minDev = dev;
        bestMatchKey = ct.key;
      }
    }

    return allKeys.map((k) => {
      const ct = ctx.contracts[k];
      const isSurviving = k === surviving.key;
      const isBestMatch = k === bestMatchKey;
      const dev = isBestMatch ? minDev : Math.abs(ct.ltp - survivingLtp);
      const diffPct = survivingLtp > 0 ? (dev / survivingLtp) * 100 : null;

      return {
        key: ct.key,
        strike: ct.strike,
        option: ct.option,
        ltp: ct.ltp,
        score: isBestMatch ? 100 : 0,
        eligible: isBestMatch,
        blockReason: isBestMatch ? undefined : isSurviving ? 'Surviving leg already held' : ct.option === surviving.option ? `${surviving.option} already held` : 'Non-closest match',
        cols: {
          role: isSurviving ? `HELD ${surviving.option}` : isBestMatch ? `ROLL ${missingOpt}` : '-',
          strike: ct.strike,
          diffPct: diffPct != null ? r2(diffPct) : null,
          targetMatch: r2(survivingLtp),
          notes: isBestMatch ? `Match ${surviving.option} @ ₹${survivingLtp.toFixed(1)}` : isSurviving ? 'Held leg' : '-',
        },
      };
    });
  },

  onEntry(cand: Candidate, entry: number, c: AlgoConfig) {
    const legSlPct = num(c, 'legSlPct') || 20.0;
    const legTargetPct = num(c, 'legTargetPct') || 30.0;

    return {
      stop: initialStop('SELL', entry, legSlPct),
      target: targetOf('SELL', entry, legTargetPct),
      state: {
        role: cand.cols.role ?? 'INITIAL',
        entryPrice: entry,
        strike: cand.strike,
        option: cand.option,
      },
    };
  },

  manage(pos, px, ctx, c) {
    const exits: ExitSignal[] = [];
    const combinedSlPct = num(c, 'combinedSlPct') || 20.0;
    const legTargetPct = num(c, 'legTargetPct') || 30.0;

    // 1. Combined SL Check (across both CE and PE)
    const opp = ctx.open.find((p) => p.option !== pos.option);
    if (opp) {
      const oppLtp = ctx.contracts[opp.key]?.ltp ?? opp.entryPrice;
      const combinedEntry = pos.entryPrice + opp.entryPrice;
      const combinedCurrent = px + oppLtp;
      const combinedSlLevel = combinedEntry * (1 + combinedSlPct / 100);

      if (combinedCurrent >= combinedSlLevel) {
        exits.push({
          kind: 'COMBINED_SL',
          level: px,
          reason: `Combined SL (${combinedSlPct}%) hit: ₹${combinedCurrent.toFixed(1)} >= ₹${combinedSlLevel.toFixed(1)}`,
        });
      }
    }

    // 2. Individual Leg Target Check (30% decay)
    if (targetHit('SELL', px, pos.target)) {
      exits.push({
        kind: 'LEG_TARGET',
        level: pos.target!,
        reason: `Leg Target (${legTargetPct}% decay) reached: ₹${px.toFixed(1)} <= ₹${pos.target?.toFixed(1)}`,
      });
    }

    return {
      stop: pos.stop,
      state: pos.state,
      exits: exits.length ? exits : undefined,
    };
  },

  columns: {
    scanner: [
      { key: 'role', label: 'Role', fmt: 'text' },
      { key: 'strike', label: 'Strike', fmt: 'int' },
      { key: 'diffPct', label: 'Dev / Diff', fmt: 'pct', digits: 1 },
      { key: 'targetMatch', label: 'Target Match', fmt: 'num', digits: 1 },
      { key: 'notes', label: 'Notes', fmt: 'text' },
    ],
  },
};

