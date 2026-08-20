'use client';

import React from 'react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtDelta, fmtIV, fmtLTP, fmtNum, fmtOI, fmtVol, sideDeltaOI, sideIV } from './format';
import type { ProcessedRow } from './types';

const TH = 'bg-zinc-800 text-xs font-bold text-white whitespace-nowrap px-2 py-2';

function DeltaOI({ value }: { value: number | null }) {
  const cls = value === null || value === 0
    ? 'text-zinc-500'
    : value > 0 ? 'text-emerald-400' : 'text-red-400';
  return <span className={`tabular-nums ${cls}`}>{fmtDelta(value)}</span>;
}

/** OI value with a proportional bar behind it. `align` decides which edge the bar grows from. */
function OICell({
  oi,
  pct,
  side,
  isMax,
}: {
  oi: number;
  pct: number;
  side: 'ce' | 'pe';
  isMax: boolean;
}) {
  const isCE = side === 'ce';
  const barColor = isCE ? 'rgba(59,130,246,0.30)' : 'rgba(239,68,68,0.30)';
  const width = `${Math.min(Math.max(pct, 0), 100)}%`;

  return (
    <div className={`relative flex h-6 items-center gap-1.5 ${isCE ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`absolute inset-y-0 rounded-sm ${isCE ? 'right-0' : 'left-0'}`}
        style={{ width, backgroundColor: barColor }}
      />
      {isCE && isMax && <span className="relative z-10 rounded bg-blue-500/25 px-1 text-[9px] font-extrabold text-blue-300">MAX</span>}
      <span className="relative z-10 text-[11px] font-semibold tabular-nums text-zinc-100">{fmtOI(oi)}</span>
      <span className="relative z-10 text-[10px] tabular-nums text-zinc-400">{pct.toFixed(0)}%</span>
      {!isCE && isMax && <span className="relative z-10 rounded bg-red-500/25 px-1 text-[9px] font-extrabold text-red-300">MAX</span>}
    </div>
  );
}

function TradeButtons({
  strike,
  optType,
  disabled,
  unavailableReason,
  qtyLabel,
  order,
  reverse,
}: {
  strike: number;
  optType: 'CE' | 'PE';
  disabled: boolean;
  /** Non-empty when this leg cannot be traded on the selected broker. */
  unavailableReason: string;
  qtyLabel: string;
  order: (strike: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL') => void;
  /** Puts render B before S so both sides read outward from the strike column. */
  reverse?: boolean;
}) {
  const blocked = Boolean(unavailableReason);
  const btn = (side: 'BUY' | 'SELL') => (
    <Tooltip key={side}>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="outline"
            disabled={disabled || blocked}
            onClick={() => order(strike, optType, side)}
            className={
              side === 'SELL'
                ? 'border-red-500/40 bg-red-500/10 text-[10px] font-bold text-red-400 hover:bg-red-500 hover:text-oncolor'
                : 'border-emerald-500/40 bg-emerald-500/10 text-[10px] font-bold text-emerald-400 hover:bg-emerald-500 hover:text-oncolor'
            }
            aria-label={`Market ${side.toLowerCase()} ${strike} ${optType}`}
          >
            {side === 'SELL' ? 'S' : 'B'}
          </Button>
        }
      />
      <TooltipContent>
        {blocked ? unavailableReason : `Market ${side} ${strike} ${optType} · ${qtyLabel}`}
      </TooltipContent>
    </Tooltip>
  );
  return <span className="flex gap-1">{reverse ? [btn('BUY'), btn('SELL')] : [btn('SELL'), btn('BUY')]}</span>;
}

export default function ChainTable({
  rows,
  spot,
  loading,
  ordering,
  qtyLabel,
  onOrder,
  canTrade,
}: {
  rows: ProcessedRow[];
  spot: number;
  loading: boolean;
  ordering: boolean;
  qtyLabel: string;
  onOrder: (strike: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL') => void;
  /**
   * Whether the selected broker can route this leg — returns a reason string
   * when it cannot (no Kotak symbol for the strike, no session, …). Returning a
   * reason disables the buttons rather than hiding them, so a missing contract
   * is visible instead of looking like a rendering gap.
   */
  canTrade: (row: ProcessedRow, optType: 'CE' | 'PE') => string;
}) {
  return (
    // The sticky header must stick to the element that actually scrolls, which is
    // Table's own [data-slot=table-container] div — so the height cap goes there.
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 [&>[data-slot=table-container]]:max-h-[72vh] [&>[data-slot=table-container]]:overflow-auto">
      <Table className="border-collapse text-xs">
        <TableHeader className="sticky top-0 z-10">
          <TableRow className="border-b border-zinc-700 hover:bg-transparent">
            <TableHead className={`${TH} text-right text-blue-300`}>CE OI</TableHead>
            <TableHead className={`${TH} text-right text-blue-300`}>Δ OI</TableHead>
            <TableHead className={`${TH} text-right text-blue-300`}>Vol</TableHead>
            <TableHead className={`${TH} text-right text-blue-300`}>IV</TableHead>
            <TableHead className={`${TH} text-right text-blue-300`}>CE LTP</TableHead>
            <TableHead className={`${TH} border-x border-zinc-700 text-center text-amber-300`}>STRIKE</TableHead>
            <TableHead className={`${TH} text-left text-red-300`}>PE LTP</TableHead>
            <TableHead className={`${TH} text-left text-red-300`}>IV</TableHead>
            <TableHead className={`${TH} text-left text-red-300`}>Vol</TableHead>
            <TableHead className={`${TH} text-left text-red-300`}>Δ OI</TableHead>
            <TableHead className={`${TH} text-left text-red-300`}>PE OI</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={11} className="py-10 text-center text-zinc-500">
                {loading ? 'Loading option chain…' : 'No chain data — select an expiry.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map(row => {
              const isITM_CE = spot > 0 && row.strike < spot;
              const isITM_PE = spot > 0 && row.strike > spot;
              const ceText = isITM_CE ? 'text-zinc-400' : 'text-zinc-100';
              const peText = isITM_PE ? 'text-zinc-400' : 'text-zinc-100';

              const rowCls = row.isATM
                ? 'bg-amber-500/10 border-l-2 border-l-amber-400 hover:bg-amber-500/15'
                : 'bg-zinc-900/40 hover:bg-zinc-800/60';

              return (
                <TableRow key={row.strike} className={`border-b border-zinc-800 ${rowCls}`}>
                  <TableCell className={`px-2 py-1 text-right ${isITM_CE ? 'bg-zinc-900/60' : ''}`}>
                    <OICell oi={row.ce?.oi ?? 0} pct={row.ceOIPct} side="ce" isMax={row.isMaxCEOI} />
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right text-[11px]">
                    <DeltaOI value={sideDeltaOI(row.ce)} />
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right text-[11px] tabular-nums text-zinc-400">
                    {fmtVol(row.ce?.volume)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-right text-[11px] tabular-nums text-zinc-400">
                    {fmtIV(sideIV(row.ce))}
                  </TableCell>
                  <TableCell className={`px-2 py-1 text-right font-bold tabular-nums ${ceText}`}>
                    <span className="flex items-center justify-end gap-2">
                      <span>{fmtLTP(row.ce?.last_price)}</span>
                      {row.ce && (
                        <TradeButtons
                          strike={row.strike}
                          optType="CE"
                          disabled={ordering}
                          unavailableReason={canTrade(row, 'CE')}
                          qtyLabel={qtyLabel}
                          order={onOrder}
                        />
                      )}
                    </span>
                  </TableCell>

                  <TableCell className={`border-x border-zinc-800 px-3 py-1 text-center font-bold tabular-nums ${row.isATM ? 'text-amber-300' : 'text-zinc-200'}`}>
                    <span className="inline-flex items-center gap-1">
                      {fmtNum(row.strike)}
                      {row.isATM && <span className="rounded bg-amber-500/25 px-1 text-[9px] font-extrabold text-amber-300">ATM</span>}
                      {row.isMinStraddle && !row.isATM && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="cursor-help rounded bg-cyan-500/20 px-1 text-[9px] font-extrabold text-cyan-300">MIN</span>
                            }
                          />
                          <TooltipContent>Cheapest straddle in view — the market&apos;s implied pin for this expiry.</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </TableCell>

                  <TableCell className={`px-2 py-1 text-left font-bold tabular-nums ${peText}`}>
                    <span className="flex items-center justify-start gap-2">
                      {row.pe && (
                        <TradeButtons
                          strike={row.strike}
                          optType="PE"
                          disabled={ordering}
                          unavailableReason={canTrade(row, 'PE')}
                          qtyLabel={qtyLabel}
                          order={onOrder}
                          reverse
                        />
                      )}
                      <span>{fmtLTP(row.pe?.last_price)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="px-2 py-1 text-left text-[11px] tabular-nums text-zinc-400">
                    {fmtIV(sideIV(row.pe))}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-left text-[11px] tabular-nums text-zinc-400">
                    {fmtVol(row.pe?.volume)}
                  </TableCell>
                  <TableCell className="px-2 py-1 text-left text-[11px]">
                    <DeltaOI value={sideDeltaOI(row.pe)} />
                  </TableCell>
                  <TableCell className={`px-2 py-1 text-left ${isITM_PE ? 'bg-zinc-900/60' : ''}`}>
                    <OICell oi={row.pe?.oi ?? 0} pct={row.peOIPct} side="pe" isMax={row.isMaxPEOI} />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
