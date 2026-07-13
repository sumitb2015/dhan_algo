'use client';

import React, { useState, useEffect } from 'react';
import OptionsPremiumBarTab from './OptionsPremiumBarTab';

const UNDERLYING = 'NIFTY';

export default function OptionsPremiumBarPage() {
  const [expiry, setExpiry]     = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [error, setError] = useState('');

  // Fetch expiries
  useEffect(() => {
    setExpiry('');
    setExpiries([]);
    setError('');
    setExpiriesLoading(true);

    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        } else {
          setError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">Option Premium Bar Chart</h1>
            <p className="text-[10px] text-zinc-400 font-medium">
              CE vs PE Premium side-by-side & Straddle Curve across strikes
            </p>
          </div>

        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-300 font-medium">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={expiriesLoading}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                         disabled:opacity-50"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {expiry ? (
          <OptionsPremiumBarTab expiry={expiry} />
        ) : (
          !expiriesLoading && (
            <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
              Please select or load an expiry to display the premium bar chart.
            </div>
          )
        )}
      </div>
    </div>
  );
}
