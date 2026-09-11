'use client';

import React, { useRef, useMemo } from 'react';
import { Layers, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtLTP, fmtPnl, pctColor, statusColor } from './format';
import { TerminalPanel } from './TerminalPanel';
import type { CrudeOrder, CrudePosition, CrudeTrade } from './types';

const TH = 'bg-zinc-800 text-xs font-bold text-white whitespace-nowrap px-3 py-2 font-mono';

export type ActivityTab = 'positions' | 'orders' | 'trades';

type RiskConfigs = Record<string, { sl: number | null; target: number | null }>;
type EditingConfigs = Record<string, { sl?: string; target?: string }>;

/**
 * Position size label. Dhan reports MCX quantity in lots; Kotak reports absolute
 * barrels (100 per CRUDEOIL lot, 10 per CRUDEOILM).
 */
function qtyLabelFor(p: CrudePosition): string {
  const qty = Math.abs(p.netQty);
  const lotSize = p.lotSize ?? 1;
  if (lotSize <= 1) return `${qty} lot${qty === 1 ? '' : 's'}`;
  const lots = qty / lotSize;
  const lotText = Number.isInteger(lots) ? String(lots) : lots.toFixed(2);
  return `${lotText} lot${lots === 1 ? '' : 's'} · ${qty} bbl`;
}

/** Broker product code -> Intraday/Normal label. Dhan: INTRADAY/MARGIN. Kotak: MIS/NRML. */
function productLabelFor(p: CrudePosition): string {
  const code = (p.productType ?? '').toUpperCase();
  if (code === 'INTRADAY' || code === 'MIS') return 'INTRADAY';
  if (code === 'MARGIN' || code === 'NRML' || code === 'CNC') return 'NORMAL';
  return code || '—';
}

function ThresholdField({
  kind,
  position,
  committed,
  editingValue,
  onChange,
  onCommit,
}: {
  kind: 'sl' | 'target';
  position: CrudePosition;
  committed: number | null;
  editingValue: string | undefined;
  onChange: (symbol: string, key: 'sl' | 'target', value: string) => void;
  onCommit: (symbol: string, key: 'sl' | 'target', override?: string) => void;
}) {
  const isSl    = kind === 'sl';
  const isShort = position.netQty < 0;
  const label   = isSl ? 'Stop-Loss' : 'Target';
  const hint = isSl
    ? (isShort
        ? 'You are SHORT — stop must sit ABOVE current LTP. Monitors price rising.'
        : 'You are LONG — stop must sit BELOW current LTP. Monitors price falling.')
    : (isShort
        ? 'You are SHORT — target must sit BELOW current LTP. Monitors option decay.'
        : 'You are LONG — target must sit ABOVE current LTP. Monitors price rising.');

  if (committed !== null && editingValue === undefined) {
    return (
      <div className="flex items-center gap-1">
        <Badge
          variant="outline"
          className={`font-mono tabular-nums text-[11px] ${
            isSl
              ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
              : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
          }`}
        >
          {isSl ? 'SL' : 'TGT'} ₹{committed}
        </Badge>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${label} for ${position.symbol}`}
          onClick={() => onCommit(position.symbol, kind, '')}
          className="text-zinc-500 hover:text-red-400 cursor-pointer"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block" />}>
        <Input
          type="number"
          step="0.1"
          placeholder={isSl ? 'SL ₹' : 'Target ₹'}
          value={editingValue ?? (committed !== null ? String(committed) : '')}
          onChange={(e) => onChange(position.symbol, kind, e.target.value)}
          onBlur={() => onCommit(position.symbol, kind)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') onCommit(position.symbol, kind, committed !== null ? String(committed) : '');
          }}
          className={`h-7 w-20 font-mono text-center text-xs tabular-nums bg-zinc-950 border-zinc-700 ${
            isSl ? 'focus-visible:border-amber-400' : 'focus-visible:border-emerald-400'
          }`}
        />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

function PositionActionsCell({
  position,
  disabled,
  onAdd,
  onClose,
}: {
  position: CrudePosition;
  disabled: boolean;
  onAdd: (position: CrudePosition, addLots: number) => void;
  onClose: (position: CrudePosition) => void;
}) {
  const [addLots, setAddLots] = React.useState('1');
  const parsed = parseFloat(addLots);
  const validAdd = Number.isInteger(parsed) && parsed > 0;

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Input
        type="number"
        min="1"
        step="1"
        value={addLots}
        onChange={(e) => setAddLots(e.target.value)}
        disabled={disabled}
        aria-label={`Lots to add to ${position.symbol}`}
        className="h-7 w-14 font-mono text-center text-xs tabular-nums bg-zinc-950 border-zinc-700"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !validAdd}
        onClick={() => onAdd(position, parsed)}
        className="h-7 border-emerald-500/40 bg-emerald-500/10 px-2 font-mono text-xs font-bold text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
      >
        Add
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onClose(position)}
        className="h-7 border-red-500/40 bg-red-500/10 px-2 font-mono text-xs font-bold text-red-300 hover:bg-red-500/25 cursor-pointer"
      >
        Close
      </Button>
    </div>
  );
}

export default function ActivityPanel({
  tab,
  setTab,
  positions,
  positionsLoading,
  orders,
  trades,
  loading,
  riskConfigs,
  editingConfigs,
  onThresholdChange,
  onThresholdCommit,
  onAddToPosition,
  onClosePosition,
  actionsBusy,
}: {
  tab: ActivityTab;
  setTab: (t: ActivityTab) => void;
  positions: CrudePosition[];
  positionsLoading: boolean;
  orders: CrudeOrder[];
  trades: CrudeTrade[];
  loading: boolean;
  riskConfigs: RiskConfigs;
  editingConfigs: EditingConfigs;
  onThresholdChange: (symbol: string, key: 'sl' | 'target', value: string) => void;
  onThresholdCommit: (symbol: string, key: 'sl' | 'target', override?: string) => void;
  onAddToPosition: (position: CrudePosition, addLots: number) => void;
  onClosePosition: (position: CrudePosition) => void;
  actionsBusy: boolean;
}) {
  const openPositions = positions.filter(p => p.netQty !== 0);
  const totalUnrealized = positions.reduce((s, p) => s + (p.unrealizedProfit || 0), 0);
  const totalRealized = positions.reduce((s, p) => s + (p.realizedProfit || 0), 0);
  const totalMtm = totalUnrealized + totalRealized;

  // Pin each symbol to the order it was first seen so the table doesn't
  // reshuffle on every broker-API poll (the API doesn't guarantee stable
  // row ordering). Same pattern as PositionsTable in Scalper.tsx.
  const rowOrderRef = useRef<Map<string, number>>(new Map());
  const nextOrderRef = useRef(0);
  const stablePositions = useMemo(() => {
    const order = rowOrderRef.current;
    for (const p of positions) {
      if (!order.has(p.symbol)) order.set(p.symbol, nextOrderRef.current++);
    }
    return [...positions].sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
  }, [positions]);

  const tabButtons = (
    <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 font-mono">
      {(['positions', 'orders', 'trades'] as const).map((t) => {
        const count = t === 'positions' ? positions.length : t === 'orders' ? orders.length : trades.length;
        const active = tab === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded transition-colors cursor-pointer ${
              active
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <span>{t}</span>
            {count > 0 && (
              <span className={`text-[9px] px-1 rounded ${active ? 'bg-amber-400/20 text-amber-200' : 'bg-zinc-800 text-zinc-400'}`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <TerminalPanel
      title="COMMODITY EXECUTION BLOTTER & RISK MONITOR"
      icon={Layers}
      action={tabButtons}
    >
      <div className="flex flex-col">
        {/* Blotter KPI Summary Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-zinc-800 border-b border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs font-mono">
          <div className="flex items-center justify-between px-2.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Open Scrips</span>
            <span className="font-bold tabular-nums text-zinc-200">{openPositions.length} active</span>
          </div>
          <div className="flex items-center justify-between px-2.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Realized P&L</span>
            <span className={`font-bold tabular-nums ${pctColor(totalRealized)}`}>{fmtPnl(totalRealized)}</span>
          </div>
          <div className="flex items-center justify-between px-2.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Unrealized P&L</span>
            <span className={`font-bold tabular-nums ${pctColor(totalUnrealized)}`}>{fmtPnl(totalUnrealized)}</span>
          </div>
          <div className="flex items-center justify-between px-2.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Net MTM</span>
            <span className={`font-bold tabular-nums text-sm ${pctColor(totalMtm)}`}>{fmtPnl(totalMtm)}</span>
          </div>
        </div>

        {tab === 'positions' ? (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent border-b border-zinc-700">
                <TableHead className={TH}>Symbol</TableHead>
                <TableHead className={TH}>Side</TableHead>
                <TableHead className={TH}>Product</TableHead>
                <TableHead className={`${TH} text-right`}>Qty</TableHead>
                <TableHead className={`${TH} text-right`}>LTP</TableHead>
                <TableHead className={`${TH} text-right`}>Buy Avg</TableHead>
                <TableHead className={`${TH} text-right`}>Sell Avg</TableHead>
                <TableHead className={`${TH} text-right`}>Unrealized</TableHead>
                <TableHead className={`${TH} text-right`}>Realized</TableHead>
                <TableHead className={TH}>Stop-Loss</TableHead>
                <TableHead className={TH}>Target</TableHead>
                <TableHead className={`${TH} text-right`}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positionsLoading ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={12} className="py-12 text-center font-mono text-zinc-500">
                    SYNCING POSITIONS BOOK…
                  </TableCell>
                </TableRow>
              ) : positions.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={12} className="py-12 text-center font-mono text-zinc-500">
                    NO OPEN COMMODITY POSITIONS
                  </TableCell>
                </TableRow>
              ) : (
                stablePositions.map((p) => {
                  const config  = riskConfigs[p.symbol] ?? { sl: null, target: null };
                  const editing = editingConfigs[p.symbol] ?? {};
                  const isShort = p.netQty < 0;
                  const flat    = p.netQty === 0;

                  return (
                    <TableRow key={p.symbol} className="border-b border-zinc-800/80 hover:bg-zinc-800/40 transition-colors">
                      <TableCell className="font-mono font-bold text-zinc-100">{p.symbol}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`font-mono font-bold text-[10px] ${
                            flat
                              ? 'border-zinc-700 bg-zinc-900 text-zinc-400'
                              : isShort
                              ? 'border-red-500/40 bg-red-500/10 text-red-400'
                              : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                          }`}
                        >
                          {flat ? 'FLAT' : isShort ? 'SHORT' : 'LONG'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-zinc-400">{productLabelFor(p)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-zinc-200">{qtyLabelFor(p)}</TableCell>
                      <TableCell className="text-right font-mono font-bold tabular-nums text-zinc-100">{fmtLTP(p.lastPrice)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-zinc-400">{fmtLTP(p.buyAvg)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums text-zinc-400">{fmtLTP(p.sellAvg)}</TableCell>
                      <TableCell className={`text-right font-mono tabular-nums font-bold ${pctColor(p.unrealizedProfit)}`}>{fmtPnl(p.unrealizedProfit)}</TableCell>
                      <TableCell className={`text-right font-mono tabular-nums font-bold ${pctColor(p.realizedProfit)}`}>{fmtPnl(p.realizedProfit)}</TableCell>
                      <TableCell>
                        {flat ? <span className="text-zinc-600 font-mono">—</span> : (
                          <ThresholdField
                            kind="sl"
                            position={p}
                            committed={config.sl}
                            editingValue={editing.sl}
                            onChange={onThresholdChange}
                            onCommit={onThresholdCommit}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        {flat ? <span className="text-zinc-600 font-mono">—</span> : (
                          <ThresholdField
                            kind="target"
                            position={p}
                            committed={config.target}
                            editingValue={editing.target}
                            onChange={onThresholdChange}
                            onCommit={onThresholdCommit}
                          />
                        )}
                      </TableCell>
                      <TableCell>
                        {flat ? <span className="flex justify-end text-zinc-600 font-mono">—</span> : (
                          <PositionActionsCell
                            position={p}
                            disabled={actionsBusy}
                            onAdd={onAddToPosition}
                            onClose={onClosePosition}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        ) : tab === 'orders' ? (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent border-b border-zinc-700">
                <TableHead className={TH}>Order ID</TableHead>
                <TableHead className={TH}>Symbol</TableHead>
                <TableHead className={TH}>Side</TableHead>
                <TableHead className={TH}>Product</TableHead>
                <TableHead className={`${TH} text-right`}>Qty</TableHead>
                <TableHead className={`${TH} text-right`}>Filled</TableHead>
                <TableHead className={`${TH} text-right`}>Price</TableHead>
                <TableHead className={TH}>Status</TableHead>
                <TableHead className={TH}>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="py-12 text-center font-mono text-zinc-500">SYNCING WORKING ORDERS…</TableCell></TableRow>
              ) : orders.length === 0 ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="py-12 text-center font-mono text-zinc-500">NO ORDERS TODAY</TableCell></TableRow>
              ) : (
                orders.map(o => (
                  <TableRow key={o.orderId} className="border-b border-zinc-800/80 hover:bg-zinc-800/40 transition-colors">
                    <TableCell className="font-mono text-zinc-400">{o.orderId}</TableCell>
                    <TableCell className="font-mono font-bold text-zinc-100">{o.symbol}</TableCell>
                    <TableCell className={`font-mono font-bold ${o.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{o.transactionType}</TableCell>
                    <TableCell className="font-mono text-zinc-400">{o.productType}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-zinc-200">{o.quantity}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-zinc-400">{o.filledQty}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-zinc-200">{fmtLTP(o.price)}</TableCell>
                    <TableCell className={`font-mono font-bold ${statusColor(o.status)}`}>{o.status}</TableCell>
                    <TableCell className="font-mono text-zinc-400">{o.updateTime || o.createTime}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent border-b border-zinc-700">
                <TableHead className={TH}>Order ID</TableHead>
                <TableHead className={TH}>Symbol</TableHead>
                <TableHead className={TH}>Side</TableHead>
                <TableHead className={`${TH} text-right`}>Traded Qty</TableHead>
                <TableHead className={`${TH} text-right`}>Traded Price</TableHead>
                <TableHead className={TH}>Exchange Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={6} className="py-12 text-center font-mono text-zinc-500">SYNCING TRADES LOG…</TableCell></TableRow>
              ) : trades.length === 0 ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={6} className="py-12 text-center font-mono text-zinc-500">NO EXECUTED TRADES TODAY</TableCell></TableRow>
              ) : (
                trades.map((t, i) => (
                  <TableRow key={`${t.orderId}-${i}`} className="border-b border-zinc-800/80 hover:bg-zinc-800/40 transition-colors">
                    <TableCell className="font-mono text-zinc-400">{t.orderId}</TableCell>
                    <TableCell className="font-mono font-bold text-zinc-100">{t.symbol}</TableCell>
                    <TableCell className={`font-mono font-bold ${t.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{t.transactionType}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-zinc-200">{t.tradedQuantity}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-zinc-200">{fmtLTP(t.tradedPrice)}</TableCell>
                    <TableCell className="font-mono text-zinc-400">{t.exchangeTime}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </TerminalPanel>
  );
}
