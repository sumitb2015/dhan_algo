import type { ChartCandle } from '@/lib/optionsChartTypes';

function formatPts(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

/** Same sign+₹ convention as LiveTradingDesk's fmtRupee, so the two P&L figures on this page
 * read identically when compared side by side. */
function fmtRupee(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
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
  qty,
}: {
  candles: ChartCandle[];
  sellerConvention?: boolean;
  /** Underlying-unit quantity (lots × lot size) of a live position this page's own ledger has
   *  open at this exact strike/leg combination. When present, the premium move is converted to
   *  real rupees for that quantity so this chip and the Trading Desk's P&L agree; when absent
   *  (no matching open position), the raw premium points are shown instead of a money figure
   *  that would otherwise misrepresent an untraded contract as your actual P&L. */
  qty?: number;
}) {
  if (candles.length === 0) return null;

  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const points = sellerConvention ? open - close : close - open;
  const pnlColor = points >= 0 ? 'lc-stat-profit' : 'lc-stat-loss';
  const hasQty = typeof qty === 'number' && qty > 0;
  const pnlLabel = hasQty ? 'Day P&L' : 'Day Δ (pts)';
  const pnlValue = hasQty ? fmtRupee(points * qty) : formatPts(points);

  return (
    <>
      <style>{`
        .lc-stat-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          padding: 2px 6px;
          background: rgba(15, 20, 40, 0.7);
          border: 1px solid rgba(99, 102, 241, 0.1);
          border-radius: 6px;
          backdrop-filter: blur(8px);
          min-width: 30px;
          flex-shrink: 0;
        }
        .lc-stat-label {
          font-size: 8px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.60);
          white-space: nowrap;
        }
        .lc-stat-value {
          font-size: 11px;
          font-weight: 700;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          tabular-nums: true;
          white-space: nowrap;
        }
        .lc-stat-neutral { color: rgba(255,255,255,0.85); }
        .lc-stat-profit  { color: #34d399; text-shadow: 0 0 6px rgba(52, 211, 153, 0.4); }
        .lc-stat-loss    { color: #f87171; text-shadow: 0 0 6px rgba(248, 113, 113, 0.4); }

        /* ── White mode overrides ───────────────────────────────────── */
        :root:not(.dark) .lc-stat-card {
          background: #ffffff;
          border: 1px solid #cbd5e1;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
        }
        :root:not(.dark) .lc-stat-label {
          color: #64748b;
        }
        :root:not(.dark) .lc-stat-neutral {
          color: #0f172a;
        }
        :root:not(.dark) .lc-stat-profit {
          color: #059669;
          text-shadow: none;
        }
        :root:not(.dark) .lc-stat-loss {
          color: #dc2626;
          text-shadow: none;
        }
      `}</style>
      <span
        className="flex items-center gap-1.5"
        title={
          hasQty
            ? `Day P&L for your open ${qty} qty position at this strike (premium move × qty).`
            : sellerConvention
            ? 'Positive = combined premium decayed since 9:15 open (gain for a seller). Negative = premium rose (loss for a seller). Shown in points — no open position at this strike to convert to ₹.'
            : 'Positive = value rose since 9:15 open (gain for this debit position). Negative = value fell (loss). Shown in points — no open position at this strike to convert to ₹.'
        }
      >
        <StatCard label={pnlLabel} value={pnlValue} colorClass={pnlColor} />
        <StatCard label="O" value={open.toFixed(2)} />
        <StatCard label="H" value={high.toFixed(2)} />
        <StatCard label="L" value={low.toFixed(2)} />
        <StatCard label="C" value={close.toFixed(2)} />
      </span>
    </>
  );
}
