'use client';

import React, { useEffect } from 'react';
import { X, Info } from 'lucide-react';

/** "How to use this page" guide for the CSP screener — usage steps plus the
 *  actual candidate-selection methodology, kept separate from CspGlossary
 *  (which documents what each column/figure means, not how to use them). */

interface Step {
  title: string;
  desc: string;
}

const USAGE: Step[] = [
  {
    title: '1. Run a scan',
    desc: 'Rescan sweeps the F&O universe (~2.5 min for Nifty 50, ~10 min for Nifty 500) and only replaces the table once it finishes — a running scan keeps showing the previous results, not a frozen page.',
  },
  {
    title: '2. Check the No-hit floor first',
    desc: 'This is the risk gate, not a display filter — it defaults to 65% so the page opens on the safe side of the curve, but the scan itself still fetches down to 40%. Raise or lower it to the lowest no-hit probability you are actually willing to hold before looking at anything else.',
  },
  {
    title: '3. Narrow with Min yield / ann. / premium',
    desc: 'These hide strikes not worth transacting (too little premium to clear brokerage and STT) — they are not risk controls, the No-hit floor is.',
  },
  {
    title: '4. Collapse duplicates',
    desc: 'Tick "Best per symbol" once you are comparing candidates — otherwise the same stock appears once per liquid strike.',
  },
  {
    title: '5. Sell to trade',
    desc: 'Sell places a REAL market order on Dhan and starts tracking the position. Buy is intentionally disabled — a cash-secured put is sold, not bought.',
  },
  {
    title: '6. Manage tracked positions',
    desc: '"Sync entry spots" refreshes marks for P&L. "Reconcile" replaces tracked quantity/avg price with the broker’s own figures and finds fills that landed without a tracked row. "Shift" rolls to a lower strike as two real market legs.',
  },
  {
    title: '7. Re-scan before you trade',
    desc: 'Results are a point-in-time snapshot of last-traded prices. When markets are closed the scan can only return the last session’s quotes, however recently you ran it — re-run it once the market you plan to trade in is actually live.',
  },
];

const CANDIDATES: Step[] = [
  {
    title: 'Filter by No-hit / Touch, not Score or Yield',
    desc: 'No-hit and Touch are the only columns that measure risk directly. The 65% default is a starting point, not a rule — raise it further for real capital and confirm it matches your actual risk tolerance before you look at Score or Yield at all.',
  },
  {
    title: 'Don’t chase Yield / Ann. across the whole list',
    desc: 'Higher premium and lower safety are almost perfectly correlated here — a richer strike pays more because it sits closer to spot or the stock is more volatile, which is exactly what makes it riskier. Sorting the unfiltered universe by Yield or Ann. is effectively sorting by risk.',
  },
  {
    title: 'Use Score as a tiebreaker, not a reason',
    desc: 'Score blends safety, return and liquidity into one number, which softens — but doesn’t remove — the yield-chasing problem above. Its weights are a hand-tuned heuristic, not something backtested against realised outcomes, so let it break ties within your safety band rather than decide which strikes qualify.',
  },
  {
    title: 'Sort by Yield only after filtering for safety',
    desc: 'Once every visible row already clears your No-hit floor, ranking by Yield/Ann. is legitimate — you’re choosing the best return among strikes you’ve already accepted as safe enough, not letting return pick the risk level for you.',
  },
  {
    title: 'Check OI per candidate',
    desc: 'The scanner filters on open interest, but a strike can clear that floor and still have a wide bid-ask spread. Sanity-check liquidity on the actual chain before sizing a real order, especially on mid- and small-lot names.',
  },
  {
    title: 'Diversify across symbols and sectors',
    desc: 'Rows are ranked independently, so the top of the list can cluster in one sector without any warning. Spread real positions across symbols rather than taking the top N rows as-is.',
  },
  {
    title: 'Treat every probability as a model estimate',
    desc: 'No-hit and Touch come from Black–Scholes / GBM off the chain’s implied volatility — they assume lognormal returns with no dividends or earnings gaps, and none of it is a guarantee.',
  },
];

export default function CspGuide({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-oncolor-dark/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-3xl rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-sky-400" />
            <div>
              <h2 className="text-[15px] font-bold text-zinc-100">How to Use This Page</h2>
              <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                Cash Secured Put screener — page walkthrough and how to pick trade candidates
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-4 py-4">
          <Section title="Using the page" steps={USAGE} />
          <Section title="Choosing trade candidates" steps={CANDIDATES} />

          <p className="rounded-sm border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
            Selling a cash-secured put obliges you to buy the stock at the strike. The premium is
            capped; the loss if the stock falls is not.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-sky-400">{title}</h3>
      <dl className="flex flex-col divide-y divide-zinc-900">
        {steps.map((s) => (
          <div key={s.title} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[190px_1fr] sm:gap-3">
            <dt className="text-[12px] font-bold text-zinc-100">{s.title}</dt>
            <dd className="text-[11px] leading-relaxed text-zinc-400">{s.desc}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
