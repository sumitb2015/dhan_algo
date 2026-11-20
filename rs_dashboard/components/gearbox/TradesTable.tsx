'use client';

import { rowPnl, type GbLedger, type GbRow } from '@/lib/gearboxLedger';
import { istClock } from '@/lib/istTime';
import { cn } from '@/lib/utils';

// Today's Gearbox rows (both modes), newest first, in the dashboard's standard table style. P&L is (exit | LTP - entry) x lots x
// barrels per lot, from the ledger (lib/gearboxLedger.ts rowPnl); null prices show "—", never 0.

const TH = 'px-2 py-1.5 text-left text-xs font-bold text-white';
const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export function TradesTable({ ledger, today, ltpOf }: { ledger: GbLedger | null; today: string; ltpOf: (r: GbRow) => number | null }) {
  const rows = ledger ? ledger.rows.filter(r => r.day === today).slice().reverse() : [];
  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-xs tabular-nums" data-testid="gb-trades">
        <thead className="bg-zinc-800">
          <tr>
            <th className={TH}>Time</th><th className={TH}>Mode</th><th className={TH}>Dir</th><th className={TH}>Leg</th><th className={TH}>Lots</th>
            <th className={TH}>Entry</th><th className={TH}>Exit / LTP</th><th className={TH}>P&amp;L</th><th className={TH}>Status</th><th className={TH}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const ltp = r.status === 'closed' ? r.exit ?? null : ltpOf(r);
            const pnl = rowPnl(r, ltp);
            return (
              <tr key={r.id} className={cn('border-t border-zinc-800', i % 2 === 1 && 'bg-zinc-900/20')}>
                <td className="px-2 py-1 text-zinc-400">{istClock(r.entryAt).slice(0, 8)}</td>
                <td className={cn('px-2 py-1 font-bold', r.mode === 'REAL' ? 'text-red-400' : 'text-zinc-400')}>{r.mode}</td>
                <td className={cn('px-2 py-1 font-bold', r.dir === 'LONG' ? 'text-emerald-400' : 'text-red-400')}>{r.dir}</td>
                <td className="px-2 py-1 text-zinc-200">{r.leg.action} {r.target.symbol} {r.target.strike} {r.target.side}</td>
                <td className="px-2 py-1 text-zinc-300">{r.lots}</td>
                <td className="px-2 py-1 text-zinc-200">{r.entry.toFixed(2)}</td>
                <td className="px-2 py-1 text-zinc-200">{ltp === null ? '—' : ltp.toFixed(2)}</td>
                <td className={cn('px-2 py-1 font-bold', pnl === null ? 'text-zinc-500' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>{pnl === null ? '—' : inr(pnl)}</td>
                <td className={cn('px-2 py-1', r.status === 'unknown' || r.status === 'failed' ? 'text-amber-400' : 'text-zinc-400')} title={r.note}>{r.status}</td>
                <td className="max-w-[18rem] truncate px-2 py-1 text-zinc-400" title={r.reason}>{r.reason ?? ''}</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={10} className="px-2 py-3 text-center text-zinc-500">No trades today</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
