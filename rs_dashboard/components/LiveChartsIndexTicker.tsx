'use client';

// Compact NIFTY + India VIX ticker for the Live Options Charts header - LTP and % change vs
// yesterday's close for both. Reuses /api/scalper/top-indices (already Dhan-sourced, already
// handles the 15:30 close-flip and pre-market "no today yet" cases per the
// dhan-prevclose-pct-change skill) rather than computing this page's own prev-close, and reuses
// useLiveTickerPoll/PctPill/fmtPrice so this reads identically to the Advanced Scalper's Top
// Indices panel instead of being a third, slightly-different implementation of the same number.

import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { PctPill, fmtPrice } from '@/components/LiveTickerPanel';

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
}

interface IndicesResponse {
  success: boolean;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, IndexQuote>;
  count: number;
  errors: string[];
}

const TRACKED: { key: string; label: string }[] = [
  { key: 'NIFTY', label: 'NIFTY' },
  { key: 'VIX', label: 'VIX' },
];

// Module scope keeps this referentially stable, as useLiveTickerPoll requires.
function pickLtps(d: IndicesResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key } of TRACKED) {
    const q = d?.quotes?.[key];
    if (typeof q?.ltp === 'number') out[key] = q.ltp;
  }
  return out;
}

export function LiveChartsIndexTicker() {
  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);
  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  return (
    <div className="lc-idx-ticker" title={stale ? `Feed stale (${ageLabel(ageMs)} old)` : undefined}>
      {TRACKED.map(({ key, label }) => {
        const q = data?.quotes?.[key];
        const f = flash[key];
        return (
          <span key={key} className={`lc-idx-chip${stale ? ' lc-idx-chip--stale' : ''}`}>
            <span className="lc-idx-label">{label}</span>
            <span className={`lc-idx-value${f === 'up' ? ' lc-idx-flash-up' : f === 'down' ? ' lc-idx-flash-down' : ''}`}>
              {q && q.ltp > 0 ? fmtPrice(q.ltp) : '—'}
            </span>
            <PctPill v={q?.change_pct ?? null} />
          </span>
        );
      })}
      <style>{`
        .lc-idx-ticker { display: flex; align-items: center; gap: 6px; }
        .lc-idx-chip {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 3px 8px;
          border-radius: 8px;
          background: rgba(99, 102, 241, 0.06);
          border: 1px solid rgba(99, 102, 241, 0.15);
        }
        .lc-idx-chip--stale { opacity: 0.5; }
        :root:not(.dark) .lc-idx-chip {
          background: #f8fafc;
          border-color: #cbd5e1;
        }
        .lc-idx-label {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.45);
        }
        :root:not(.dark) .lc-idx-label { color: #64748b; }
        .lc-idx-value {
          font-size: 12px;
          font-weight: 700;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          color: #e2e8f0;
          transition: color 0.3s ease;
        }
        :root:not(.dark) .lc-idx-value { color: #0f172a; }
        .lc-idx-flash-up { color: #34d399 !important; }
        .lc-idx-flash-down { color: #f87171 !important; }
      `}</style>
    </div>
  );
}
