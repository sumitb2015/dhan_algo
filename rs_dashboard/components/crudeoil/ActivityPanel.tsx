'use client';

import React from 'react';
import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtLTP, fmtPnl, pctColor, statusColor } from './format';
import type { CrudeOrder, CrudePosition, CrudeTrade } from './types';

const TH = 'bg-zinc-800 text-xs font-bold text-white whitespace-nowrap px-3 py-2';

export type ActivityTab = 'positions' | 'orders' | 'trades';

type RiskConfigs = Record<string, { sl: number | null; target: number | null }>;
type EditingConfigs = Record<string, { sl?: string; target?: string }>;

/**
 * Position size label. Dhan reports MCX quantity in lots; Kotak reports absolute
 * barrels (100 per CRUDEOIL lot, 10 per CRUDEOILM). Showing the raw number alone
 * would read as "SHORT 100" vs "SHORT 1" for the same economic position, so the
 * lot count is spelled out whenever the two differ.
 */
function qtyLabelFor(p: CrudePosition): string {
  const qty = Math.abs(p.netQty);
  const lotSize = p.lotSize ?? 1;
  if (lotSize <= 1) return `${qty} lot${qty === 1 ? '' : 's'}`;
  const lots = qty / lotSize;
  const lotText = Number.isInteger(lots) ? String(lots) : lots.toFixed(2);
  return `${lotText} lot${lots === 1 ? '' : 's'} · ${qty}`;
}

/** Broker product code -> Intraday/Normal label. Dhan: INTRADAY/MARGIN. Kotak: MIS/NRML. */
function productLabelFor(p: CrudePosition): string {
  const code = (p.productType ?? '').toUpperCase();
  if (code === 'INTRADAY' || code === 'MIS') return 'Intraday';
  if (code === 'MARGIN' || code === 'NRML' || code === 'CNC') return 'Normal';
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
        ? 'You are SHORT — the stop must sit ABOVE the current LTP. The monitor fires when price rises to it.'
        : 'You are LONG — the stop must sit BELOW the current LTP. The monitor fires when price falls to it.')
    : (isShort
        ? 'You are SHORT — the target must sit BELOW the current LTP. The monitor fires when the option decays to it.'
        : 'You are LONG — the target must sit ABOVE the current LTP. The monitor fires when price rises to it.');

  if (committed !== null && editingValue === undefined) {
    return (
      <div className="flex items-center gap-1">
        <Badge
          variant="outline"
          className={`font-mono tabular-nums ${
            isSl
              ? 'border-orange-500/50 bg-orange-500/10 text-orange-300'
              : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {isSl ? 'SL' : 'TGT'} ₹{committed}
        </Badge>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${label} for ${position.symbol}`}
          onClick={() => onCommit(position.symbol, kind, '')}
          className="text-zinc-500 hover:text-red-400"
        >
          <X />
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
          placeholder={isSl ? 'SL price' : 'Target price'}
          value={editingValue ?? (committed !== null ? String(committed) : '')}
          onChange={(e) => onChange(position.symbol, kind, e.target.value)}
          onBlur={() => onCommit(position.symbol, kind)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className={`h-7 w-24 text-center text-xs tabular-nums ${
            isSl ? 'focus-visible:border-orange-500' : 'focus-visible:border-emerald-500'
          }`}
        />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Add-lots stepper + Close button for one position row. Kept as its own
 * component (rather than lifting the input value into ActivityPanel state)
 * so typing in one row's box never re-renders the rest of the table.
 */
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
        min="0"
        step="1"
        value={addLots}
        onChange={(e) => setAddLots(e.target.value)}
        disabled={disabled}
        aria-label={`Lots to add to ${position.symbol}`}
        className="h-7 w-16 text-center text-xs tabular-nums"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !validAdd}
        onClick={() => onAdd(position, parsed)}
        className="h-7 border-emerald-500/40 bg-emerald-500/10 px-2 text-xs text-emerald-300 hover:bg-emerald-500/20"
      >
        Add
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => onClose(position)}
        className="h-7 border-red-500/40 bg-red-500/10 px-2 text-xs text-red-300 hover:bg-red-500/20"
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
  /** Places a market order in the position's own direction for `addLots` lots. */
  onAddToPosition: (position: CrudePosition, addLots: number) => void;
  /** Squares off this single position at market (with confirmation upstream). */
  onClosePosition: (position: CrudePosition) => void;
  /** True while any order for this book is in flight — disables Add/Close. */
  actionsBusy: boolean;
}) {
  const count = tab === 'positions' ? positions.length : tab === 'orders' ? orders.length : trades.length;

  return (
    <Card className="bg-zinc-900">
      <CardHeader className="flex flex-row items-center justify-between border-b [.border-b]:pb-3">
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">
          Activity <span className="text-zinc-500">({count})</span>
        </CardTitle>
        <Tabs value={tab} onValueChange={(v) => setTab(v as ActivityTab)}>
          <TabsList className="bg-zinc-950">
            <TabsTrigger value="positions">
              Positions {positions.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{positions.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="orders">
              Orders {orders.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{orders.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="trades">
              Trades {trades.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{trades.length}</Badge>}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent className="px-0">
        {tab === 'positions' ? (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
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
                <TableRow className="hover:bg-transparent"><TableCell colSpan={12} className="py-8 text-center text-zinc-500">Loading positions…</TableCell></TableRow>
              ) : positions.length === 0 ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={12} className="py-8 text-center text-zinc-500">No open positions</TableCell></TableRow>
              ) : (
                positions.map((p, i) => {
                  const config  = riskConfigs[p.symbol] ?? { sl: null, target: null };
                  const editing = editingConfigs[p.symbol] ?? {};
                  const isShort = p.netQty < 0;
                  const flat    = p.netQty === 0;

                  return (
                    <TableRow key={`${p.symbol}-${i}`} className="border-b border-zinc-800 hover:bg-zinc-800/40">
                      <TableCell className="font-mono font-semibold text-zinc-100">{p.symbol}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            flat
                              ? 'border-zinc-700 bg-zinc-900 font-mono tabular-nums text-zinc-400'
                              : isShort
                                ? 'border-red-500/40 bg-red-500/10 font-mono tabular-nums text-red-300'
                                : 'border-emerald-500/40 bg-emerald-500/10 font-mono tabular-nums text-emerald-300'
                          }
                        >
                          {flat ? 'FLAT' : isShort ? 'SHORT' : 'LONG'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-zinc-300">{productLabelFor(p)}</TableCell>
                      <TableCell className="text-right tabular-nums text-zinc-200">{qtyLabelFor(p)}</TableCell>
                      <TableCell className="text-right tabular-nums text-zinc-200">{fmtLTP(p.lastPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums text-zinc-400">{fmtLTP(p.buyAvg)}</TableCell>
                      <TableCell className="text-right tabular-nums text-zinc-400">{fmtLTP(p.sellAvg)}</TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${pctColor(p.unrealizedProfit)}`}>{fmtPnl(p.unrealizedProfit)}</TableCell>
                      <TableCell className={`text-right tabular-nums font-semibold ${pctColor(p.realizedProfit)}`}>{fmtPnl(p.realizedProfit)}</TableCell>
                      <TableCell>
                        {flat ? <span className="text-zinc-600">—</span> : (
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
                        {flat ? <span className="text-zinc-600">—</span> : (
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
                        {flat ? <span className="flex justify-end text-zinc-600">—</span> : (
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
              <TableRow className="hover:bg-transparent">
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
                <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="py-8 text-center text-zinc-500">Loading orders…</TableCell></TableRow>
              ) : orders.length === 0 ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="py-8 text-center text-zinc-500">No orders today</TableCell></TableRow>
              ) : (
                orders.map(o => (
                  <TableRow key={o.orderId} className="border-b border-zinc-800 hover:bg-zinc-800/40">
                    <TableCell className="font-mono text-zinc-400">{o.orderId}</TableCell>
                    <TableCell className="font-mono font-semibold text-zinc-100">{o.symbol}</TableCell>
                    <TableCell className={`font-bold ${o.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{o.transactionType}</TableCell>
                    <TableCell className="text-zinc-400">{o.productType}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-200">{o.quantity}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-400">{o.filledQty}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-200">{fmtLTP(o.price)}</TableCell>
                    <TableCell className={`font-semibold ${statusColor(o.status)}`}>{o.status}</TableCell>
                    <TableCell className="text-zinc-500">{o.updateTime || o.createTime}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        ) : (
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TH}>Order ID</TableHead>
                <TableHead className={TH}>Symbol</TableHead>
                <TableHead className={TH}>Side</TableHead>
                <TableHead className={`${TH} text-right`}>Qty</TableHead>
                <TableHead className={`${TH} text-right`}>Price</TableHead>
                <TableHead className={TH}>Exchange Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={6} className="py-8 text-center text-zinc-500">Loading trades…</TableCell></TableRow>
              ) : trades.length === 0 ? (
                <TableRow className="hover:bg-transparent"><TableCell colSpan={6} className="py-8 text-center text-zinc-500">No trades today</TableCell></TableRow>
              ) : (
                trades.map((t, i) => (
                  <TableRow key={`${t.orderId}-${i}`} className="border-b border-zinc-800 hover:bg-zinc-800/40">
                    <TableCell className="font-mono text-zinc-400">{t.orderId}</TableCell>
                    <TableCell className="font-mono font-semibold text-zinc-100">{t.symbol}</TableCell>
                    <TableCell className={`font-bold ${t.transactionType === 'SELL' ? 'text-red-400' : 'text-emerald-400'}`}>{t.transactionType}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-200">{t.tradedQuantity}</TableCell>
                    <TableCell className="text-right tabular-nums text-zinc-200">{fmtLTP(t.tradedPrice)}</TableCell>
                    <TableCell className="text-zinc-500">{t.exchangeTime}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
