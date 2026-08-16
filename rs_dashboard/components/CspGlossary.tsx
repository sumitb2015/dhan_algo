'use client';

import React, { useEffect } from 'react';
import { X, BookOpen } from 'lucide-react';
import { SCANNER_COLUMNS, TRACKED_COLUMNS, type ColumnDoc } from './cspColumns';

/** Glossary modal for the CSP screener. The column entries live in
 *  cspColumns.ts because the table headers use the same text for their hover
 *  tooltips — two copies would drift. */

type Entry = ColumnDoc;

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
  'Strikes with open interest under 25 lots, or implied volatility above 100%, are dropped. Those quotes are stale and back-solve to a fabricated IV that makes a deep-OTM strike look far safer than it is. The floor is in lots, not shares, because a lot ranges from 20 to 2075 shares across the universe.',
  'Symbols the scan produced nothing for are counted in the "N skipped" chip above the table, with the reason on hover — a throttled chain call and a name with no liquid puts are otherwise the same empty result.',
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
          <Section title="Scanner columns" entries={SCANNER_COLUMNS} />
          <Section title="Filters" entries={FILTERS} />
          <Section title="Tracked position columns" entries={TRACKED_COLUMNS} />

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
