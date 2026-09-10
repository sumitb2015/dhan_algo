'use client';

import React from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtDelta, fmtIV, fmtLTP, fmtNum, fmtOI, fmtVol, sideDeltaOI, sideIV } from './format';
import { TerminalPanel } from './TerminalPanel';
import type { ProcessedRow } from './types';

const TH = 'bg-zinc-800 text-xs font-bold text-white whitespace-nowrap px-2 py-2 font-mono';

function DeltaOI({ value }: { value: number | null }) {
  const cls = value === null || value === 0
    ? 'text-zinc-500'
    : value > 0 ? 'text-emerald-400' : 'text-red-400';
  return <span className={`font-mono tabular-nums ${cls}`}>{fmtDelta(value)}</span>;
}

/** OI value with a proportional bar behind it. `side` decides which edge the bar grows from. */
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
  const barColor = isCE ? 'rgba(56,189,248,0.25)' : 'rgba(244,63,94,0.25)';
  const width = `${Math.min(Math.max(pct, 0), 100)}%`;

  return (
    <div className={`relative flex h-6 items-center gap-1.5 ${isCE ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`absolute inset-y-0 rounded-sm ${isCE ? 'right-0' : 'left-0'}`}
        style={{ width, backgroundColor: barColor }}
      />
      {isCE && isMax && (
        <span className="relative z-10 rounded border border-sky-500/40 bg-sky-500/25 px-1 font-mono text-[9px] font-extrabold text-sky-300">
          MAX
        </span>
      )}
      <span className="relative z-10 font-mono text-[11px] font-semibold tabular-nums text-zinc-100">{fmtOI(oi)}</span>
      <span className="relative z-10 font-mono text-[10px] tabular-nums text-zinc-400">{pct.toFixed(0)}%</span>
      {!isCE && isMax && (
        <span className="relative z-10 rounded border border-red-500/40 bg-red-500/25 px-1 font-mono text-[9px] font-extrabold text-red-300">
          MAX
        </span>
      )}
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
                ? 'border-red-500/40 bg-red-500/10 font-mono text-[10px] font-bold text-red-400 hover:bg-red-500 hover:text-oncolor cursor-pointer'
                : 'border-emerald-500/40 bg-emerald-500/10 font-mono text-[10px] font-bold text-emerald-400 hover:bg-emerald-500 hover:text-oncolor cursor-pointer'
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
  canTrade: (row: ProcessedRow, optType: 'CE' | 'PE') => string;
}) {
  return (
    <TerminalPanel
      title="OPTION CHAIN MATRIX & ONE-CLICK EXECUTION DOCK"
      icon={SlidersHorizontal}
      meta={`${rows.length} ACTIVE STRIKES · TICKET: ${qtyLabel}`}
    >
      <div className="overflow-hidden bg-zinc-950 [&>[data-slot=table-container]]:max-h-[72vh] [&>[data-slot=table-container]]:overflow-auto">
        <Table className="border-collapse text-xs">
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="border-b border-zinc-700 hover:bg-transparent">
              <TableHead className={`${TH} text-right text-sky-300`}>CE OI</TableHead>
              <TableHead className={`${TH} text-right text-sky-300`}>Δ OI</TableHead>
              <TableHead className={`${TH} text-right text-sky-300`}>Vol</TableHead>
              <TableHead className={`${TH} text-right text-sky-300`}>IV</TableHead>
              <TableHead className={`${TH} text-right text-sky-300`}>CE LTP</TableHead>
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
                <TableCell colSpan={11} className="py-12 text-center font-mono text-xs text-zinc-500">
                  {loading ? 'INITIALIZING MCX OPTION CHAIN…' : 'NO CHAIN DATA — SELECT AN EXPIRY'}
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
                  <TableRow key={row.strike} className={`border-b border-zinc-800/80 transition-colors ${rowCls}`}>
                    <TableCell className={`px-2 py-1 text-right ${isITM_CE ? 'bg-zinc-900/60' : ''}`}>
                      <OICell oi={row.ce?.oi ?? 0} pct={row.ceOIPct} side="ce" isMax={row.isMaxCEOI} />
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right text-[11px]">
                      <DeltaOI value={sideDeltaOI(row.ce)} />
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-400">
                      {fmtVol(row.ce?.volume)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-400">
                      {fmtIV(sideIV(row.ce))}
                    </TableCell>
                    <TableCell className={`px-2 py-1 text-right font-bold font-mono tabular-nums ${ceText}`}>
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

                    <TableCell className={`border-x border-zinc-800 px-3 py-1 text-center font-bold font-mono tabular-nums ${row.isATM ? 'text-amber-300' : 'text-zinc-200'}`}>
                      <span className="inline-flex items-center gap-1.5">
                        {fmtNum(row.strike)}
                        {row.isATM && (
                          <span className="rounded border border-amber-500/40 bg-amber-500/25 px-1 font-mono text-[9px] font-extrabold text-amber-300">
                            ATM
                          </span>
                        )}
                        {row.isMinStraddle && !row.isATM && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="cursor-help rounded border border-cyan-500/40 bg-cyan-500/20 px-1 font-mono text-[9px] font-extrabold text-cyan-300">
                                  MIN
                                </span>
                              }
                            />
                            <TooltipContent>Cheapest straddle in view — market implied expiry pin.</TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>

                    <TableCell className={`px-2 py-1 text-left font-bold font-mono tabular-nums ${peText}`}>
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
                    <TableCell className="px-2 py-1 text-left font-mono text-[11px] tabular-nums text-zinc-400">
                      {fmtIV(sideIV(row.pe))}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-left font-mono text-[11px] tabular-nums text-zinc-400">
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
    </TerminalPanel>
  );
}
