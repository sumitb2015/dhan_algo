'use client';

import React from 'react';
import { Activity } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtIV, fmtNum, fmtOI, fmtVol, pctColor, pctSign } from './format';
import { TerminalPanel, StatTile } from './TerminalPanel';
import type { ChainStats } from './types';

export default function MarketSnapshot({
  spot,
  change,
  changePct,
  stats,
  dte,
  expiryLabel,
}: {
  spot: number;
  change: number;
  changePct: number;
  stats: ChainStats;
  dte: number | null;
  expiryLabel: string;
}) {
  const {
    atm, pcr, maxPain, totalCEOI, totalPEOI, totalCEVol, totalPEVol,
    atmStraddle, atmCeIV, atmPeIV, resistanceStrike, resistanceOI, supportStrike, supportOI,
  } = stats;

  const impliedMovePct = atmStraddle && spot > 0 ? (atmStraddle / spot) * 100 : null;
  const atmIV = atmCeIV !== null && atmPeIV !== null
    ? (atmCeIV + atmPeIV) / 2
    : atmCeIV ?? atmPeIV;
  const ivSkew = atmCeIV !== null && atmPeIV !== null ? atmCeIV - atmPeIV : null;

  const oiTotal = totalCEOI + totalPEOI;
  const callSharePct = oiTotal > 0 ? (totalCEOI / oiTotal) * 100 : 50;

  const sentiment: { text: string; tone: 'up' | 'down' | 'neutral' } =
    pcr === null
      ? { text: '—', tone: 'neutral' }
      : pcr > 1.2
      ? { text: 'Bullish (Put Writers)', tone: 'up' }
      : pcr < 0.8
      ? { text: 'Bearish (Call Writers)', tone: 'down' }
      : { text: 'Neutral / Balanced', tone: 'neutral' };

  const painGap = maxPain !== null && spot > 0 ? maxPain - spot : null;

  return (
    <TerminalPanel
      title="MCX MARKET TELEMETRY & VOLATILITY MATRIX"
      icon={Activity}
      meta={`EXPIRY: ${expiryLabel}${dte !== null && dte >= 0 ? ` · ${dte}D DTE` : ''}`}
    >
      <div className="flex flex-col">
        {/* 8-Column StatTile Grid */}
        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800/80 sm:grid-cols-4 xl:grid-cols-8 xl:divide-y-0 bg-zinc-950/40 p-2 gap-y-2">
          <StatTile
            label="Spot (Fut)"
            value={spot ? `₹${fmtNum(spot, 1)}` : '—'}
            sub={spot && change !== 0 ? `${change >= 0 ? '+' : ''}${fmtNum(change, 1)} (${pctSign(changePct)})` : 'Fetching quote…'}
            tone={changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'neutral'}
            tooltip="Live CRUDEOIL futures price. Crude options price off the futures contract on MCX."
          />
          <StatTile
            label="ATM Strike"
            value={atm ? fmtNum(atm) : '—'}
            sub={atm && spot ? `${spot > atm ? '+' : ''}${fmtNum(spot - atm, 1)} from spot` : undefined}
            tone="accent"
            tooltip="Strike nearest futures price, rounded to the ₹100 strike ladder"
          />
          <StatTile
            label="PCR Ratio"
            value={pcr !== null ? pcr.toFixed(3) : '—'}
            sub={sentiment.text}
            tone={sentiment.tone}
            tooltip="Put-Call Ratio (Total Put OI ÷ Total Call OI). Above 1.2 bullish, below 0.8 bearish."
          />
          <StatTile
            label="Max Pain"
            value={maxPain !== null ? fmtNum(maxPain) : '—'}
            sub={painGap !== null ? `${painGap >= 0 ? '+' : ''}${fmtNum(painGap, 1)} from spot` : undefined}
            tone={painGap === null ? 'neutral' : painGap > 0 ? 'up' : painGap < 0 ? 'down' : 'neutral'}
            tooltip="Strike at which the total payout to option buyers is minimized at expiry"
          />
          <StatTile
            label="ATM Straddle"
            value={atmStraddle ? `₹${fmtNum(atmStraddle, 1)}` : '—'}
            sub={impliedMovePct !== null ? `±${impliedMovePct.toFixed(2)}% implied move` : undefined}
            tone="accent"
            tooltip="Combined ATM call + put premium — market implied pricing for move to expiry"
          />
          <StatTile
            label="Expected Range"
            value={atmStraddle && atm ? `${fmtNum(atm - atmStraddle)} – ${fmtNum(atm + atmStraddle)}` : '—'}
            sub={atmStraddle ? `Corridor: ${fmtNum(2 * atmStraddle, 1)} pts` : undefined}
            tone="neutral"
            tooltip="Straddle breakevens (ATM ± straddle premium). Pin band for option writers."
          />
          <StatTile
            label="ATM IV & Skew"
            value={fmtIV(atmIV)}
            sub={ivSkew !== null ? `Skew ${ivSkew >= 0 ? '+' : ''}${ivSkew.toFixed(1)}%` : undefined}
            tone="neutral"
            tooltip="Average ATM Call & Put implied volatility. Skew is CE IV minus PE IV."
          />
          <StatTile
            label="Days to Expiry"
            value={dte === null ? '—' : dte <= 0 ? 'Today' : `${dte} DAYS`}
            sub={expiryLabel}
            tone="neutral"
            tooltip="Calendar days remaining until contract expiry"
          />
        </div>

        {/* OI Bias Meter Strip */}
        <div className="flex flex-col gap-3 border-t border-zinc-800 bg-zinc-950/80 px-4 py-3 lg:flex-row lg:items-center lg:gap-6">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.16em]">
              <span className="font-mono text-sky-400">Call OI {fmtOI(totalCEOI)}</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="cursor-help text-zinc-500 font-mono">
                      OI BALANCE · CALLS VS PUTS
                    </span>
                  }
                />
                <TooltipContent>
                  Share of total open interest sitting in calls vs puts across all active strikes.
                </TooltipContent>
              </Tooltip>
              <span className="font-mono text-red-400">{fmtOI(totalPEOI)} Put OI</span>
            </div>

            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="bg-sky-500 transition-all duration-500" style={{ width: `${callSharePct}%` }} />
              <div className="bg-red-500 transition-all duration-500" style={{ width: `${100 - callSharePct}%` }} />
            </div>

            <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] tabular-nums text-zinc-400">
              <span>{callSharePct.toFixed(1)}% calls</span>
              <span>Vol · CE {fmtVol(totalCEVol)} / PE {fmtVol(totalPEVol)}</span>
              <span>{(100 - callSharePct).toFixed(1)}% puts</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="cursor-help border-sky-500/40 bg-sky-500/10 font-mono tabular-nums text-sky-300">
                    CALL WALL (RES) {resistanceStrike !== null ? fmtNum(resistanceStrike) : '—'} · {fmtOI(resistanceOI)}
                  </Badge>
                }
              />
              <TooltipContent>Strike with the highest call OI across the chain — key resistance ceiling.</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="cursor-help border-red-500/40 bg-red-500/10 font-mono tabular-nums text-red-300">
                    PUT WALL (SUPP) {supportStrike !== null ? fmtNum(supportStrike) : '—'} · {fmtOI(supportOI)}
                  </Badge>
                }
              />
              <TooltipContent>Strike with the highest put OI across the chain — key support floor.</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </TerminalPanel>
  );
}
