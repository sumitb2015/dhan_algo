'use client';

import React, { useState, useEffect } from 'react';
import OptionsPremiumBarTab from './OptionsPremiumBarTab';
import NavBar from './NavBar';

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
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M3 17l5-6 4 4 9-11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 21h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Options · {UNDERLYING}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Premium &amp; Volatility Smile</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              CE / PE premium distribution and straddle curve across the strike chain
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Expiry */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={expiriesLoading}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                         disabled:opacity-50 tabular-nums"
            >
              {expiries.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
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
