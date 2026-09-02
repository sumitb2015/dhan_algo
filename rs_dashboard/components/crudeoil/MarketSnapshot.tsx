'use client';

import React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtIV, fmtNum, fmtOI, fmtVol, pctColor, pctSign } from './format';
import type { ChainStats } from './types';

function Tile({
  label,
  hint,
  value,
  sub,
  subClass = 'text-zinc-400',
}: {
  label: string;
  hint: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subClass?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="w-fit cursor-help text-[10px] font-bold uppercase tracking-widest text-zinc-500 underline decoration-zinc-700 decoration-dotted underline-offset-4">
              {label}
            </span>
          }
        />
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
      <span className="truncate text-base font-bold tabular-nums text-zinc-100">{value}</span>
      <span className={`truncate text-[11px] tabular-nums ${subClass}`}>{sub ?? '—'}</span>
    </div>
  );
}

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

  const oiTotal    = totalCEOI + totalPEOI;
  const callSharePct = oiTotal > 0 ? (totalCEOI / oiTotal) * 100 : 50;

  const sentiment = pcr === null
    ? { text: '—', cls: 'text-zinc-500' }
    : pcr > 1.2 ? { text: 'Bullish', cls: 'text-emerald-400' }
    : pcr < 0.8 ? { text: 'Bearish', cls: 'text-red-400' }
    : { text: 'Neutral', cls: 'text-zinc-400' };

  const painGap = maxPain !== null && spot > 0 ? maxPain - spot : null;

  return (
    <Card className="bg-zinc-900">
      <CardContent className="px-0">
        <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800 sm:grid-cols-4 xl:grid-cols-8 xl:divide-y-0">
          <Tile
            label="Spot (Fut)"
            hint="Live CRUDEOIL futures price. Crude options are priced off the futures contract, not a spot index."
            value={spot ? `₹${fmtNum(spot, 1)}` : '—'}
            sub={spot && change !== 0 ? `${change >= 0 ? '+' : ''}${fmtNum(change, 1)} (${pctSign(changePct)})` : 'Fetching…'}
            subClass={pctColor(changePct)}
          />
          <Tile
            label="ATM"
            hint="Strike nearest the futures price, rounded to the ₹100 strike grid."
            value={atm ? fmtNum(atm) : '—'}
            sub={atm && spot ? `${spot > atm ? '+' : ''}${fmtNum(spot - atm, 1)} from spot` : undefined}
          />
          <Tile
            label="PCR"
            hint="Put-Call Ratio = total put OI ÷ total call OI across the whole chain. Above 1.2 reads bullish (put writers dominant), below 0.8 bearish."
            value={pcr !== null ? pcr.toFixed(3) : '—'}
            sub={sentiment.text}
            subClass={sentiment.cls}
          />
          <Tile
            label="Max Pain"
            hint="Strike at which the total payout to option buyers is smallest — where writers would most like the contract to settle."
            value={maxPain !== null ? fmtNum(maxPain) : '—'}
            sub={painGap !== null ? `${painGap >= 0 ? '+' : ''}${fmtNum(painGap, 1)} from spot` : undefined}
            subClass={painGap === null ? 'text-zinc-400' : painGap > 0 ? 'text-emerald-400' : painGap < 0 ? 'text-red-400' : 'text-zinc-400'}
          />
          <Tile
            label="ATM Straddle"
            hint="Combined ATM call + put premium. This is what the market charges for the expected move to expiry."
            value={atmStraddle ? `₹${fmtNum(atmStraddle, 1)}` : '—'}
            sub={impliedMovePct !== null ? `± ${impliedMovePct.toFixed(2)}% implied move` : undefined}
            subClass="text-cyan-400"
          />
          <Tile
            label="Expected Range"
            hint="Straddle breakevens: ATM strike ± the straddle premium. Outside this band the straddle seller loses."
            value={atmStraddle && atm ? `${fmtNum(atm - atmStraddle)} – ${fmtNum(atm + atmStraddle)}` : '—'}
            sub={atmStraddle && spot > 0 ? `±${((atmStraddle / spot) * 100).toFixed(2)}% (${fmtNum(2 * atmStraddle, 1)} wide)` : atmStraddle ? `width ${fmtNum(2 * atmStraddle, 1)}` : undefined}
          />
          <Tile
            label="ATM IV"
            hint="Mean of the ATM call and put implied volatilities. Skew is CE IV − PE IV: positive means calls are bid richer than puts."
            value={fmtIV(atmIV)}
            sub={ivSkew !== null ? `skew ${ivSkew >= 0 ? '+' : ''}${ivSkew.toFixed(1)}` : undefined}
            subClass={ivSkew === null ? 'text-zinc-400' : ivSkew > 0 ? 'text-blue-400' : 'text-red-400'}
          />
          <Tile
            label="Days to Expiry"
            hint="Calendar days from today to the selected expiry. Theta decay accelerates sharply in the final week."
            value={dte === null ? '—' : dte <= 0 ? 'Today' : `${dte}d`}
            sub={expiryLabel}
          />
        </div>

        <Separator className="bg-zinc-800" />

        {/* OI bias meter — one bar beats three separate OI tiles for reading balance at a glance */}
        <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:gap-6">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
              <span className="text-blue-400">Call OI {fmtOI(totalCEOI)}</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="cursor-help text-zinc-500">
                      OI Balance
                    </span>
                  }
                />
                <TooltipContent>
                  Share of total open interest sitting in calls vs puts. A call-heavy chain caps rallies; a put-heavy chain cushions falls.
                </TooltipContent>
              </Tooltip>
              <span className="text-red-400">{fmtOI(totalPEOI)} Put OI</span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div className="bg-blue-500 transition-all duration-500" style={{ width: `${callSharePct}%` }} />
              <div className="bg-red-500 transition-all duration-500" style={{ width: `${100 - callSharePct}%` }} />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[10px] tabular-nums text-zinc-500">
              <span>{callSharePct.toFixed(1)}% calls</span>
              <span>Vol · CE {fmtVol(totalCEVol)} / PE {fmtVol(totalPEVol)}</span>
              <span>{(100 - callSharePct).toFixed(1)}% puts</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="cursor-help border-blue-500/40 bg-blue-500/10 font-mono tabular-nums text-blue-300">
                    RESISTANCE {resistanceStrike !== null ? fmtNum(resistanceStrike) : '—'} · {fmtOI(resistanceOI)}
                  </Badge>
                }
              />
              <TooltipContent>Strike with the highest call OI across the entire chain — the wall sellers defend on the way up.</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="cursor-help border-red-500/40 bg-red-500/10 font-mono tabular-nums text-red-300">
                    SUPPORT {supportStrike !== null ? fmtNum(supportStrike) : '—'} · {fmtOI(supportOI)}
                  </Badge>
                }
              />
              <TooltipContent>Strike with the highest put OI across the entire chain — the floor put writers defend on the way down.</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
