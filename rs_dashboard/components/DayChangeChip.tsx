import type { ChartCandle } from '@/lib/optionsChartTypes';

function formatPts(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

function StatCard({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: string;
  colorClass?: string;
}) {
  return (
    <span className="lc-stat-card">
      <span className="lc-stat-label">{label}</span>
      <span className={`lc-stat-value ${colorClass ?? 'lc-stat-neutral'}`}>{value}</span>
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
export function DayChangeChip({
  candles,
  sellerConvention = true,
}: {
  candles: ChartCandle[];
  sellerConvention?: boolean;
}) {
  if (candles.length === 0) return null;

  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const points = sellerConvention ? open - close : close - open;
  const pnlColor = points >= 0 ? 'lc-stat-profit' : 'lc-stat-loss';

  return (
    <>
      <style>{`
        .lc-stat-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 3px 7px;
          background: rgba(15, 20, 40, 0.7);
          border: 1px solid rgba(99, 102, 241, 0.1);
          border-radius: 6px;
          backdrop-filter: blur(8px);
          min-width: 36px;
        }
        .lc-stat-label {
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #4b5563;
          white-space: nowrap;
        }
        .lc-stat-value {
          font-size: 11px;
          font-weight: 700;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          tabular-nums: true;
          white-space: nowrap;
        }
        .lc-stat-neutral { color: #94a3b8; }
        .lc-stat-profit  { color: #34d399; text-shadow: 0 0 6px rgba(52, 211, 153, 0.4); }
        .lc-stat-loss    { color: #f87171; text-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }
      `}</style>
      <span
        className="flex items-center gap-1.5"
        title={
          sellerConvention
            ? 'Positive = combined premium decayed since 9:15 open (gain for a seller). Negative = premium rose (loss for a seller).'
            : 'Positive = value rose since 9:15 open (gain for this debit position). Negative = value fell (loss).'
        }
      >
        <StatCard label="Day P&L" value={formatPts(points)} colorClass={pnlColor} />
        <StatCard label="O" value={open.toFixed(2)} />
        <StatCard label="H" value={high.toFixed(2)} />
        <StatCard label="L" value={low.toFixed(2)} />
        <StatCard label="C" value={close.toFixed(2)} />
      </span>
    </>
  );
}
