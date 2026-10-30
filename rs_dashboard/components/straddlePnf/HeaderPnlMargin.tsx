'use client';

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { useBrokerSelector, BROKER_LABELS, scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { fmtInr } from '@/lib/deltaDesk';

export interface HeaderPnlMarginProps {
  broker?: Broker;
  mode?: 'PAPER' | 'REAL';
  paperPnl?: number;
}

export function fmtFunds(v: number): string {
  if (v >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)}Cr`;
  if (v >= 100_000) return `₹${(v / 100_000).toFixed(2)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

export default function HeaderPnlMargin({ broker: propBroker, mode = 'PAPER', paperPnl = 0 }: HeaderPnlMarginProps) {
  const { broker: hookBroker } = useBrokerSelector();
  const broker = propBroker ?? hookBroker;

  const [funds, setFunds] = useState<{ availabelBalance?: number; utilizedAmount?: number } | null>(null);
  const [brokerPnl, setBrokerPnl] = useState<{ total: number; realised: number; unrealised: number }>({
    total: 0,
    realised: 0,
    unrealised: 0,
  });

  // Poll broker funds (available margin) every 15s
  useEffect(() => {
    let dead = false;
    const fetchFunds = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'funds'));
        const j = (await res.json()) as { success?: boolean; data?: { availabelBalance?: number; utilizedAmount?: number } };
        if (!dead && j.success && j.data) {
          setFunds(j.data);
        }
      } catch {
        /* ignore network errors */
      }
    };
    void fetchFunds();
    const id = setInterval(fetchFunds, 15_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [broker]);

  // Poll broker positions to calculate Realised, Unrealised, and Total P&L every 5s
  useEffect(() => {
    let dead = false;
    const fetchPositions = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'positions'));
        const j = (await res.json()) as { success?: boolean; data?: Array<Record<string, unknown>> };
        if (!dead && j.success && Array.isArray(j.data)) {
          let realised = 0;
          let unrealised = 0;
          for (const p of j.data) {
            const r = Number(p.realizedProfit ?? p.realized_profit ?? p.realizedPnl ?? 0);
            const u = Number(p.unrealizedProfit ?? p.unrealized_profit ?? p.unrealizedPnl ?? p.pnl ?? 0);
            realised += Number.isFinite(r) ? r : 0;
            unrealised += Number.isFinite(u) ? u : 0;
          }
          setBrokerPnl({ total: realised + unrealised, realised, unrealised });
        }
      } catch {
        /* ignore network errors */
      }
    };
    void fetchPositions();
    const id = setInterval(fetchPositions, 5_000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [broker]);

  const availableMargin = funds?.availabelBalance != null ? Number(funds.availabelBalance) : null;
  const pnl = mode === 'REAL' ? brokerPnl.total : paperPnl;
  const pnlTone =
    pnl > 0
      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
      : pnl < 0
        ? 'bg-red-500/10 border-red-500/30 text-red-400'
        : 'bg-zinc-900 border-zinc-800 text-zinc-300';
  const pnlSign = pnl > 0 ? '+' : '';

  return (
    <div className="flex items-center gap-1.5 shrink-0" data-testid="header-pnl-margin">
      {/* Margin Available chip */}
      <div
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono"
        title={`Available Margin on ${BROKER_LABELS[broker]} (${availableMargin != null ? fmtFunds(availableMargin) : 'Not available'})`}
      >
        <Wallet className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Margin</span>
        <span className="font-bold text-zinc-100 tabular-nums">
          {availableMargin != null ? fmtFunds(availableMargin) : '—'}
        </span>
      </div>

      {/* P&L chip */}
      <div
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono transition-colors ${pnlTone}`}
        title={
          mode === 'REAL'
            ? `Broker P&L (${BROKER_LABELS[broker]}): Realised ₹${Math.round(brokerPnl.realised).toLocaleString('en-IN')}, Unrealised ₹${Math.round(brokerPnl.unrealised).toLocaleString('en-IN')}`
            : `Simulated Paper P&L: ${fmtInr(pnl, true)}`
        }
      >
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-75">
          {mode === 'PAPER' ? 'PAPER P&L' : 'P&L'}
        </span>
        <span className="font-bold tabular-nums">
          {pnl !== 0 ? `${pnlSign}₹${Math.round(Math.abs(pnl)).toLocaleString('en-IN')}` : '₹0'}
        </span>
      </div>
    </div>
  );
}
