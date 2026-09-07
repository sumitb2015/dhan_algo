'use client';
import { usePathname } from 'next/navigation';
import { usePnlAlert } from '@/hooks/usePnlAlert';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function fmtINR(v: number): string {
  const abs = Math.abs(v);
  return `${v >= 0 ? '+' : '-'}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function PnlAlertModal() {
  const pathname = usePathname();
  const { pending, dismiss } = usePnlAlert(pathname !== '/login');
  if (!pending) return null;

  const up = pending.totalPnl >= 0;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="P&L alert"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-oncolor-dark/70 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <Card className="w-full max-w-sm border border-amber-500/30 bg-zinc-900 shadow-2xl">
        <CardContent className="flex flex-col gap-4 py-1">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">
              P&L moved {fmtINR(pending.delta)}
            </div>
            <div className={`mt-1 font-mono text-3xl font-bold tabular-nums ${up ? 'text-emerald-400' : 'text-red-400'}`}>
              {fmtINR(pending.totalPnl)}
            </div>
            <div className="text-[11px] text-zinc-500">Combined day P&L, all brokers</div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm">
            <span className="text-zinc-400">Open positions</span>
            <span className="font-mono font-bold text-zinc-100">{pending.openPositions}</span>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm">
            <span className="text-zinc-400">NIFTY</span>
            {pending.nifty ? (
              <span className="font-mono">
                <span className="font-bold text-zinc-100">{pending.nifty.ltp.toLocaleString('en-IN')}</span>
                {pending.nifty.changePct != null && (
                  <span className={`ml-2 ${pending.nifty.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pending.nifty.changePct >= 0 ? '+' : ''}{pending.nifty.changePct.toFixed(2)}%
                  </span>
                )}
              </span>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
          </div>

          <Button autoFocus size="sm" className="w-full" onClick={dismiss}>
            Got it
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
