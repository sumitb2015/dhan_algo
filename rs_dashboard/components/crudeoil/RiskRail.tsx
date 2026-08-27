'use client';

import React from 'react';
import { AlertCircle, Loader2, Minus, Plus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtLTP, fmtPnl, pctColor } from './format';
import type { CrudePosition } from './types';

type RiskConfigs = Record<string, { sl: number | null; target: number | null }>;
type EditingConfigs = Record<string, { sl?: string; target?: string }>;

/**
 * Position size label. Dhan reports MCX quantity in lots; Kotak reports absolute
 * barrels (100 per CRUDEOIL lot). Showing the raw number alone would read as
 * "SHORT 100" vs "SHORT 1" for the same economic position, so the lot count is
 * spelled out whenever the two differ.
 */
function qtyLabelFor(p: CrudePosition): string {
  const qty = Math.abs(p.netQty);
  const lotSize = p.lotSize ?? 1;
  if (lotSize <= 1) return `${qty} lot${qty === 1 ? '' : 's'}`;
  const lots = qty / lotSize;
  const lotText = Number.isInteger(lots) ? String(lots) : lots.toFixed(2);
  return `${lotText} lot${lots === 1 ? '' : 's'} · ${qty}`;
}

function Metric({ label, value, cls = 'text-zinc-200' }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${cls}`}>{value}</span>
    </div>
  );
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

  // A committed threshold shows as a badge; clearing it drops back to the input.
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
          className={`h-7 text-center text-xs tabular-nums ${
            isSl ? 'focus-visible:border-orange-500' : 'focus-visible:border-emerald-500'
          }`}
        />
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export default function RiskRail({
  lots,
  lotSize,
  setLots,
  brokerLabel,
  positions,
  loading,
  totalRealized,
  totalUnrealized,
  totalPnl,
  exitingAll,
  onExitAll,
  riskConfigs,
  editingConfigs,
  onThresholdChange,
  onThresholdCommit,
}: {
  lots: number;
  /** Units the selected broker wants per lot: 1 on Dhan, 100/10 on Kotak. */
  lotSize: number;
  setLots: React.Dispatch<React.SetStateAction<number>>;
  brokerLabel: string;
  positions: CrudePosition[];
  loading: boolean;
  totalRealized: number;
  totalUnrealized: number;
  totalPnl: number;
  exitingAll: boolean;
  onExitAll: () => void;
  riskConfigs: RiskConfigs;
  editingConfigs: EditingConfigs;
  onThresholdChange: (symbol: string, key: 'sl' | 'target', value: string) => void;
  onThresholdCommit: (symbol: string, key: 'sl' | 'target', override?: string) => void;
}) {
  const openPositions = positions.filter(p => p.netQty !== 0);

  return (
    // Stacked in the xl rail; below xl the three cards sit side by side so the
    // chain is not pushed three card-heights down the page.
    <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-3 xl:grid-cols-1">
      {/* ─── Trade ticket: what the chain's B/S buttons will fire ─────────── */}
      <Card className="bg-zinc-900">
        <CardHeader className="border-b [.border-b]:pb-3">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Trade Ticket</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Lots</span>
            <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-0.5">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Decrease lots"
                disabled={lots <= 1}
                onClick={() => setLots(prev => Math.max(1, prev - 1))}
              >
                <Minus />
              </Button>
              <span className="w-10 text-center text-sm font-bold tabular-nums text-zinc-100">{lots}</span>
              <Button size="icon-xs" variant="ghost" aria-label="Increase lots" onClick={() => setLots(prev => prev + 1)}>
                <Plus />
              </Button>
            </div>
          </div>
          <Separator className="bg-zinc-800" />
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Order quantity</span>
            <span className="font-bold tabular-nums text-zinc-100">{lots * lotSize} qty</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-500">Routing to</span>
            <span className="font-bold text-zinc-100">{brokerLabel}</span>
          </div>
          {/* The two brokers disagree on what "quantity" means, and the gap is
              100x — state the resolved number rather than leaving it implied. */}
          <p className="text-[11px] leading-relaxed text-zinc-500">
            {lotSize > 1
              ? <>{brokerLabel} takes absolute quantity, so {lots} lot{lots > 1 ? 's' : ''} is sent as <span className="font-bold text-zinc-300">{lots * lotSize}</span>.</>
              : <>{brokerLabel} takes MCX quantity in lots, so {lots} lot{lots > 1 ? 's' : ''} is sent as <span className="font-bold text-zinc-300">{lots * lotSize}</span>.</>}
          </p>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            The <span className="font-bold text-emerald-400">B</span> / <span className="font-bold text-red-400">S</span> buttons
            in the chain fire a <span className="font-bold text-zinc-300">MARKET, intraday</span> order for this size — immediately, with no further prompt.
          </p>
        </CardContent>
      </Card>

      {/* ─── P&L ─────────────────────────────────────────────────────────── */}
      <Card className="bg-zinc-900">
        <CardHeader className="border-b [.border-b]:pb-3">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">Crude P&amp;L</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-1">
          {/* Loading and "confirmed zero positions" must never look identical —
              a slow/failed first fetch showing "Open 0" reads as "you have no
              positions" when it may just not have loaded yet. */}
          <div className={`text-2xl font-bold tabular-nums ${loading ? 'text-zinc-600' : pctColor(totalPnl)}`}>
            {loading ? '—' : fmtPnl(totalPnl)}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Realized"   value={loading ? '—' : fmtPnl(totalRealized)}   cls={loading ? 'text-zinc-600' : pctColor(totalRealized)} />
            <Metric label="Unrealized" value={loading ? '—' : fmtPnl(totalUnrealized)} cls={loading ? 'text-zinc-600' : pctColor(totalUnrealized)} />
            <Metric label="Open"       value={loading ? '—' : String(openPositions.length)} cls={loading ? 'text-zinc-600' : undefined} />
          </div>
          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            disabled={exitingAll || openPositions.length === 0}
            onClick={onExitAll}
          >
            {exitingAll ? <Loader2 className="animate-spin" /> : <AlertCircle />}
            Exit All Positions ({openPositions.length})
          </Button>
        </CardContent>
      </Card>

      {/* ─── Positions with per-leg SL / Target ──────────────────────────── */}
      <Card className="bg-zinc-900">
        <CardHeader className="border-b [.border-b]:pb-3">
          <CardTitle className="text-xs font-bold uppercase tracking-wider text-white">
            Positions {positions.length > 0 && <span className="text-zinc-500">({positions.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-1">
          {loading ? (
            <p className="py-6 text-center text-xs text-zinc-500">Loading positions…</p>
          ) : positions.length === 0 ? (
            <p className="py-6 text-center text-xs text-zinc-500">No open positions</p>
          ) : (
            positions.map((p, i) => {
              const config  = riskConfigs[p.symbol] ?? { sl: null, target: null };
              const editing = editingConfigs[p.symbol] ?? {};
              const isShort = p.netQty < 0;
              const flat    = p.netQty === 0;

              return (
                <div
                  key={`${p.symbol}-${i}`}
                  className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-zinc-100">{p.symbol}</span>
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
                      {flat ? 'FLAT' : isShort ? 'SHORT' : 'LONG'} {qtyLabelFor(p)}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Metric label="LTP" value={fmtLTP(p.lastPrice)} />
                    <Metric label="Unrealized" value={fmtPnl(p.unrealizedProfit)} cls={pctColor(p.unrealizedProfit)} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Metric label="Buy Avg"  value={fmtLTP(p.buyAvg)}  cls="text-zinc-400" />
                    <Metric label="Sell Avg" value={fmtLTP(p.sellAvg)} cls="text-zinc-400" />
                    <Metric label="Realized" value={fmtPnl(p.realizedProfit)} cls={pctColor(p.realizedProfit)} />
                  </div>

                  {!flat && (
                    <>
                      <Separator className="bg-zinc-800" />
                      <div className="grid grid-cols-2 gap-2">
                        <ThresholdField
                          kind="sl"
                          position={p}
                          committed={config.sl}
                          editingValue={editing.sl}
                          onChange={onThresholdChange}
                          onCommit={onThresholdCommit}
                        />
                        <ThresholdField
                          kind="target"
                          position={p}
                          committed={config.target}
                          editingValue={editing.target}
                          onChange={onThresholdChange}
                          onCommit={onThresholdCommit}
                        />
                      </div>
                      <p className="text-[10px] leading-relaxed text-zinc-500">
                        Dashboard-side triggers only — no resting order sits with the broker. A confirmation appears before any exit fires.
                      </p>
                    </>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
