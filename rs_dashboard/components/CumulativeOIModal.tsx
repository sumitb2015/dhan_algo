'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { X, ExternalLink } from 'lucide-react';
import { FOCUS_RING } from '@/components/optionsScreener/format';

// The same tab the Options page renders. It polls only while mounted, so closing the modal stops its requests.
const OptionsCumulativeOITab = dynamic(() => import('./OptionsCumulativeOITab'), {
  ssr: false,
  loading: () => <p className="py-16 text-center text-xs text-zinc-400">Loading cumulative OI…</p>,
});
// MCX crude (CRUDEOIL and CRUDEOILM share one option chain's OI, collected by crudeoil_oi_collector.py).
const CrudeOilCumulativeOITab = dynamic(() => import('./CrudeOilCumulativeOITab'), {
  ssr: false,
  loading: () => <p className="py-16 text-center text-xs text-zinc-400">Loading cumulative OI…</p>,
});

/** The live cumulative OI view (ATM ± wings), opened over a page without leaving it. NIFTY by default; `crude` shows
 *  the MCX crude view. `zClass` raises it over a page whose own floating layers sit above z-50 (the Index Scalper). */
export default function CumulativeOIModal({ onClose, crude = false, zClass = 'z-50' }: { onClose: () => void; crude?: boolean; zClass?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 ${zClass} flex items-center justify-center p-4 bg-oncolor-dark/60 backdrop-blur-sm`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="Cumulative OI"
        className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900">
          <h2 className="text-sm font-bold text-white">Cumulative OI · {crude ? 'CRUDEOIL' : 'NIFTY'}</h2>
          <div className="flex items-center gap-2">
            <Link href={crude ? '/options/crudeoil' : '/options'} target="_blank" rel="noreferrer"
              className={`inline-flex items-center gap-1 text-xs font-bold text-zinc-300 hover:text-white ${FOCUS_RING}`}>
              Open full page <ExternalLink className="w-3 h-3" />
            </Link>
            <button type="button" onClick={onClose} aria-label="Close cumulative OI"
              className={`p-1 rounded text-zinc-400 hover:text-zinc-100 ${FOCUS_RING}`}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="px-5 py-4">
          {crude ? <CrudeOilCumulativeOITab expiry="" /> : <OptionsCumulativeOITab expiry="" />}
        </div>
      </div>
    </div>
  );
}
