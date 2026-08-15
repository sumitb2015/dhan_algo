'use client';

import React, { useEffect } from 'react';
import { X, BookOpen } from 'lucide-react';

/** Column definitions for the CSP screener.
 *
 *  Formulas here are transcribed from scripts/tools/csp_scanner.py — if the
 *  scoring weights or probability model change there, change them here too, or
 *  the page will confidently document something it no longer does. */

interface Entry {
  term: string;
  formula?: string;
  desc: React.ReactNode;
}

const COLUMNS: Entry[] = [
  {
    term: 'Score',
    formula: 'no-hit×45 + min(ann÷30, 1)×40 + min(OI÷5000, 1)×15',
    desc: 'Heuristic 0–100 blend of safety, return and liquidity. Caps stop one very rich or very liquid strike from swamping the rest. It ranks attractiveness *within* whatever no-hit band you filter to — it is not a risk measure on its own.',
  },
  {
    term: 'LTP',
    desc: 'Live spot price of the underlying at scan time.',
  },
  {
    term: 'DTE',
    desc: 'Calendar days to expiry. The scanner picks the nearest expiry at least 5 days out — a 1-day contract has almost no premium left and would distort the yield ranking.',
  },
  {
    term: 'Cycle Start',
    formula: 'first session after the previous monthly expiry',
    desc: 'When the current option cycle opened, with the underlying’s close on that day beneath it. Indian stock options are monthly, so this is the natural window for the contract being sold.',
  },
  {
    term: '1D / 5D',
    desc: 'Underlying’s percentage move over the last 1 and 5 trading sessions.',
  },
  {
    term: 'Cycle',
    formula: '(LTP − cycle-open price) ÷ cycle-open price',
    desc: 'Move since the cycle opened — i.e. how the stock has travelled over the life of this contract.',
  },
  {
    term: 'Suggested Strike',
    desc: 'The OTM put strike for this row, with its no-hit probability and lot size. Every liquid strike above the scan floor gets its own row, so one symbol usually appears several times at different risk levels.',
  },
  {
    term: 'To Strike',
    formula: '(cycle-open price − strike) ÷ cycle-open price',
    desc: 'Headroom between the cycle-open price and the strike, anchored the same way the move columns are. The smaller "now" figure underneath is the same gap measured from today’s LTP. Negative means the strike now sits above where the cycle opened.',
  },
  {
    term: 'Yield',
    formula: 'premium ÷ strike',
    desc: 'Premium collected as a percentage of the strike — your return on the cash securing the put, for this contract’s duration only.',
  },
  {
    term: 'Ann.',
    formula: 'yield × (365 ÷ DTE)',
    desc: 'Yield scaled to a year so strikes on different expiries compare honestly. Treat it as a run-rate, not a forecast: it extrapolates a ~10-day contract and assumes you keep redeploying at the same rate.',
  },
  {
    term: 'Premium',
    formula: 'premium/share × lot size',
    desc: 'Total rupees collected for one lot, with the per-share figure beneath.',
  },
  {
    term: 'No-hit',
    formula: 'N(d₂),  d₂ = [ln(S/K) + (r − σ²/2)T] ÷ σ√T',
    desc: 'Black–Scholes probability the underlying finishes ABOVE the strike at expiry — i.e. the put expires worthless and you keep the whole premium. Uses the chain’s implied volatility and a 6.5% risk-free rate.',
  },
  {
    term: 'Touch',
    formula: 'GBM first-passage probability',
    desc: 'Chance the underlying trades at or below the strike at ANY point before expiry. Always higher than (100 − No-hit), because a stock can dip through the strike and recover. This is the number that reflects how uncomfortable the position is likely to get, even when it ends up expiring worthless.',
  },
  {
    term: 'Capital Req.',
    formula: 'strike × lot size',
    desc: 'Cash to fully secure the put — what you pay if assigned. Your broker will block margin rather than this full amount, so actual margin is lower.',
  },
];

const FILTERS: Entry[] = [
  {
    term: 'No-hit range',
    desc: 'Shows only strikes whose no-hit probability falls in the band. This is the primary risk control — lower the floor to see aggressive, higher-premium strikes.',
  },
  {
    term: 'Min yield / Min ann. / Min prem',
    desc: 'Hide strikes not worth transacting. Min yield defaults to 0.25% because a deep-OTM strike paying 0.02% loses to brokerage and STT. Min prem is an absolute rupee floor for the same reason.',
  },
  {
    term: 'Best per symbol',
    desc: 'Collapses to the single highest-scoring surviving strike per symbol — useful once the filters leave hundreds of rows.',
  },
];

const NOTES: string[] = [
  'Universe: Nifty 500 members that actually have stock option (OPTSTK) contracts — about 208 names.',
  'Strikes with open interest under 100, or implied volatility above 100%, are dropped. Those quotes are stale and back-solve to a fabricated IV that makes a deep-OTM strike look far safer than it is.',
  'All probabilities are model estimates from implied volatility, not guarantees. They assume lognormal returns and no dividends or earnings gaps.',
  'A scan sweeps the whole universe and takes ~10 minutes — the Dhan option-chain endpoint allows one call every 3 seconds. Results replace the table only when the scan completes.',
];

export default function CspGlossary({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-3xl rounded-md border border-zinc-800 bg-[#0a0a0a] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between border-b border-zinc-800 bg-[#0a0a0a] px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-amber-400" />
            <div>
              <h2 className="text-[15px] font-bold text-zinc-100">Column Definitions</h2>
              <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                Cash Secured Put screener — what each figure means and how it is computed
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-5 px-4 py-4">
          <Section title="Columns" entries={COLUMNS} />
          <Section title="Filters" entries={FILTERS} />

          <div className="flex flex-col gap-2">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-amber-400">
              How the scan works
            </h3>
            <ul className="flex flex-col gap-1.5">
              {NOTES.map((n) => (
                <li key={n} className="flex gap-2 text-[11px] leading-relaxed text-zinc-400">
                  <span className="text-zinc-600">•</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="rounded-sm border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
            Selling a cash-secured put obliges you to buy the stock at the strike. The premium is
            capped; the loss if the stock falls is not.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({ title, entries }: { title: string; entries: Entry[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-amber-400">{title}</h3>
      <dl className="flex flex-col divide-y divide-zinc-900">
        {entries.map((e) => (
          <div key={e.term} className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[130px_1fr] sm:gap-3">
            <dt className="font-mono text-[12px] font-bold text-zinc-100">{e.term}</dt>
            <dd className="flex flex-col gap-1">
              {e.formula && (
                <code className="w-fit rounded-sm bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-sky-300">
                  {e.formula}
                </code>
              )}
              <span className="text-[11px] leading-relaxed text-zinc-400">{e.desc}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
