'use client';

import { ghostScore, type GbState, type GhostTrade } from '@/lib/gearbox';
import { istDateIso } from '@/lib/nseHolidays';
import { rowPnl, type GbLedger, type GbMode } from '@/lib/gearboxLedger';
import { cn } from '@/lib/utils';

// You vs Ghost. You = this ledger's rows today in the current mode (₹, closed + the open leg at its LTP). Ghost = the rules followed
// mechanically on the signal future (lib/gearbox.ts ghostTrades), today's trades, in futures points on paper: not a validated strategy.

const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const pts = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}`;

export function Scoreboard({ ledger, mode, today, heldPnl, states, ghost }: {
  ledger: GbLedger | null; mode: GbMode; today: string; heldPnl: number | null; states: GbState[]; ghost: GhostTrade[];
}) {
  const rows = ledger ? ledger.rows.filter(r => r.mode === mode && r.day === today && r.status === 'closed') : [];
  const booked = rows.reduce((s, r) => s + (rowPnl(r, null) ?? 0), 0);
  const wins = rows.filter(r => (rowPnl(r, null) ?? 0) > 0).length;
  const you = booked + (heldPnl ?? 0);
  const todays = states.length ? ghost.filter(x => istDateIso(states[x.ei].t * 1000) === today) : [];
  const g = states.length ? ghostScore(todays, states, states.length - 1) : { points: 0, closed: 0, wins: 0, open: 0 as const };
  return (
    <div className="grid grid-cols-2 gap-2.5" data-testid="gb-score">
      <div className="rounded-xl bg-zinc-800/60 px-3 py-2.5">
        <h3 className="text-sm font-bold text-zinc-100">You <span className="text-[11px] font-medium text-zinc-500">· today · {mode}</span></h3>
        <div className={cn('text-3xl font-bold tabular-nums', you >= 0 ? 'text-emerald-400' : 'text-red-400')} data-testid="gb-you">{inr(you)}</div>
        <div className="text-xs text-zinc-400">
          {rows.length} closed · {rows.length ? Math.round((wins / rows.length) * 100) : 0}% wins{heldPnl !== null ? ` · open ${inr(heldPnl)}` : ''}
        </div>
      </div>
      <div className="rounded-xl bg-zinc-800/60 px-3 py-2.5">
        <h3 className="text-sm font-bold text-zinc-100">Ghost driver <span className="text-[11px] font-medium text-amber-400">· rules unvalidated · futures points</span></h3>
        <div className={cn('text-3xl font-bold tabular-nums', g.points >= 0 ? 'text-emerald-400' : 'text-red-400')}>{pts(g.points)} <span className="text-base text-zinc-400">pts</span></div>
        <div className="text-xs text-zinc-400">
          {g.closed} closed · {g.closed ? Math.round((g.wins / g.closed) * 100) : 0}% wins · {g.open ? (g.open > 0 ? 'long now' : 'short now') : 'flat'} · paper, no costs
        </div>
      </div>
    </div>
  );
}
