import type { ChartCandle } from '@/lib/optionsChartTypes';

function formatPts(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function Stat({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <span className="flex items-baseline gap-1 tabular-nums">
      <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</span>
      <span className={`font-semibold text-xs ${colorClass ?? 'text-zinc-200'}`}>{value}</span>
    </span>
  );
}

/** Straddle/Strangle/Rolling Straddle are always long-premium series by construction, but in
 * practice these are watched by someone running the *sell* side intraday (sell at 9:15, buy
 * back later), for whom a falling combined premium is a gain - so Day P&L defaults to the
 * seller's convention (open - close). The Strategy chart's legs can be BUY or SELL individually,
 * so its P&L direction isn't fixed - pass its own `net_credit` flag as `sellerConvention` so a
 * decaying credit position still reads as a gain and a rising debit position also reads
 * correctly, instead of being inverted. Ported from dhanHQ_skills' DayChangeChip.tsx. */
export function DayChangeChip({ candles, sellerConvention = true }: { candles: ChartCandle[]; sellerConvention?: boolean }) {
  if (candles.length === 0) return null;

  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const points = sellerConvention ? open - close : close - open;
  const colorClass = points >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <span className="flex items-center gap-3">
      <span
        title={
          sellerConvention
            ? 'Positive = combined premium decayed since 9:15 open (gain for a seller). Negative = premium rose (loss for a seller).'
            : 'Positive = value rose since 9:15 open (gain for this debit position). Negative = value fell (loss).'
        }
      >
        <Stat label="Day P&L" value={formatPts(points)} colorClass={colorClass} />
      </span>
      <Stat label="O" value={open.toFixed(2)} />
      <Stat label="H" value={high.toFixed(2)} />
      <Stat label="L" value={low.toFixed(2)} />
      <Stat label="C" value={close.toFixed(2)} />
    </span>
  );
}
