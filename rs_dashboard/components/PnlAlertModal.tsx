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
      role="status"
      aria-label="P&L alert"
      className="fixed bottom-4 right-4 z-[70] w-full max-w-sm pointer-events-none"
    >
      <Card className="pointer-events-auto border border-amber-500/30 bg-zinc-900 shadow-2xl">
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

          <Button size="sm" className="w-full" onClick={dismiss}>
            Got it
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
