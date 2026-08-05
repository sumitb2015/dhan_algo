'use client';

import React from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { fmtLTP, statusColor } from './format';
import type { CrudeOrder, CrudeTrade } from './types';

const TH = 'bg-zinc-800 text-xs font-bold text-white whitespace-nowrap px-3 py-2';

export type ActivityTab = 'orders' | 'trades';

export default function ActivityTables({
  tab,
  setTab,
  orders,
  trades,
  loading,
}: {
  tab: ActivityTab;
  setTab: (t: ActivityTab) => void;
  orders: CrudeOrder[];
  trades: CrudeTrade[];
  loading: boolean;
}) {
  const count = tab === 'orders' ? orders.length : trades.length;

  return (
    <Card className="bg-zinc-900">
      <CardHeader className="flex flex-row items-center justify-between border-b [.border-b]:pb-3">
        <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">
          Activity <span className="text-zinc-500">({count})</span>
        </CardTitle>
        <Tabs value={tab} onValueChange={(v) => setTab(v as ActivityTab)}>
          <TabsList className="bg-zinc-950">
            <TabsTrigger value="orders">Orders {orders.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{orders.length}</Badge>}</TabsTrigger>
            <TabsTrigger value="trades">Trades {trades.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{trades.length}</Badge>}</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>

      <CardContent className="px-0">
        {tab === 'orders' ? (
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
