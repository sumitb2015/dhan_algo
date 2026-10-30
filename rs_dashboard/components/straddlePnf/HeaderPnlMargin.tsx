'use client';

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { BROKER_LABELS, scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { bookPnl, fmtFunds, type Book } from '@/lib/pnfAccount';
import { fmtInr } from '@/lib/deltaDesk';

// The P&F header's account chips for the broker picked in the header: available margin and P&L. Read-only: no order code.
// REAL mode shows the account's day P&L (realised + unrealised over every position); PAPER mode shows the page's simulated P&L.

export interface HeaderPnlMarginProps {
  /** The page header's broker (the same one the trade bar sends orders to). */
  broker: Broker;
  mode?: 'PAPER' | 'REAL';
  paperPnl?: number;
  /** How the paper figure is made up (trade bar + AUTO), for the chip's tooltip. */
  paperNote?: string;
}

export default function HeaderPnlMargin({ broker, mode = 'PAPER', paperPnl = 0, paperNote }: HeaderPnlMarginProps) {
  // Each value is tagged with the broker it was read from, so a switch never shows the old account's figures under the new name.
  const [funds, setFunds] = useState<{ broker: Broker; available: number | null; error?: string } | null>(null);
  const [book, setBook] = useState<{ broker: Broker; pnl: Book | null; error?: string } | null>(null);

  // Available margin, every 15 s.
  useEffect(() => {
    let dead = false;
    const read = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'funds'));
        const j = (await res.json()) as { success?: boolean; error?: string; data?: { availabelBalance?: number } };
        if (dead) return;
        const v = Number(j.data?.availabelBalance);
        setFunds(j.success && Number.isFinite(v) ? { broker, available: v } : { broker, available: null, error: j.error ?? 'Funds unavailable' });
      } catch {
        if (!dead) setFunds({ broker, available: null, error: 'Funds unavailable' });
      }
    };
    void read();
    const id = setInterval(read, 15_000);
    return () => { dead = true; clearInterval(id); };
  }, [broker]);

  // Positions every 5 s, only in REAL mode (PAPER shows the page's own P&L). The poll route prices Kotak legs from the live chain.
  useEffect(() => {
    if (mode !== 'REAL') return;
    let dead = false;
    const read = async () => {
      try {
        const res = await fetch(`${scalperRoute(broker, 'poll')}?only=positions`);
        const j = (await res.json()) as { positions?: Array<Record<string, unknown>>; positionsError?: string | null; error?: string };
        if (dead) return;
        if (j.positionsError || !Array.isArray(j.positions)) setBook({ broker, pnl: null, error: j.positionsError ?? j.error ?? 'Positions unavailable' });
        else setBook({ broker, pnl: bookPnl(j.positions) });
      } catch {
        if (!dead) setBook({ broker, pnl: null, error: 'Positions unavailable' });
      }
    };
    void read();
    const id = setInterval(read, 5_000);
    return () => { dead = true; clearInterval(id); };
  }, [broker, mode]);

  const f = funds && funds.broker === broker ? funds : null;
  const b = book && book.broker === broker ? book : null;
  const available = f?.available ?? null;
  const real = mode === 'REAL';
  const pnl: number | null = real ? b?.pnl?.total ?? null : paperPnl;
  const unpriced = real ? b?.pnl?.unpriced ?? 0 : 0;
  const pnlTone = pnl == null || pnl === 0
    ? 'bg-zinc-900 border-zinc-800 text-zinc-300'
    : pnl > 0 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400';
  const pnlTitle = !real
    ? `Simulated paper P&L today: ${fmtInr(paperPnl, true)}${paperNote ? ` — ${paperNote}` : ''}`
    : b?.error ? `${BROKER_LABELS[broker]} positions: ${b.error}`
    : b?.pnl ? `${BROKER_LABELS[broker]} day P&L: realised ${fmtInr(b.pnl.realised, true)}, unrealised ${fmtInr(b.pnl.unrealised, true)}`
      + (unpriced ? ` — ${unpriced} open leg${unpriced > 1 ? 's' : ''} without a live price (their unrealised P&L is not included)` : '')
    : `${BROKER_LABELS[broker]} day P&L: loading`;

  return (
    <div className="flex items-center gap-1.5 shrink-0" data-testid="header-pnl-margin">
      <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono"
           title={f?.error ? `${BROKER_LABELS[broker]} funds: ${f.error}` : `Available margin on ${BROKER_LABELS[broker]}`}>
        <Wallet className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Margin</span>
        <span className="font-bold text-zinc-100 tabular-nums">{available != null ? fmtFunds(available) : '—'}</span>
      </div>
      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-mono transition-colors ${pnlTone}`} title={pnlTitle}>
        <span className="text-[10px] font-bold uppercase tracking-wider">{real ? 'P&L' : 'PAPER P&L'}</span>
        <span className="font-bold tabular-nums">
          {pnl == null ? '—' : pnl === 0 ? '₹0' : `${pnl > 0 ? '+' : '-'}₹${Math.round(Math.abs(pnl)).toLocaleString('en-IN')}`}
        </span>
        {unpriced > 0 && <span data-testid="pnl-unpriced" className="text-[10px] font-bold text-amber-400" aria-label={`${unpriced} open legs unpriced`}>*</span>}
      </div>
    </div>
  );
}
