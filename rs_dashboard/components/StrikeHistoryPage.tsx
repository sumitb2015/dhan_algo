'use client';

import React, { useState, useEffect } from 'react';
import StrikeHistoryTab from './StrikeHistoryTab';

const UNDERLYING = 'NIFTY';

const OFFSETS = [
  'ATM-10', 'ATM-9', 'ATM-8', 'ATM-7', 'ATM-6', 'ATM-5', 'ATM-4', 'ATM-3', 'ATM-2', 'ATM-1',
  'ATM',
  'ATM+1', 'ATM+2', 'ATM+3', 'ATM+4', 'ATM+5', 'ATM+6', 'ATM+7', 'ATM+8', 'ATM+9', 'ATM+10',
];

export default function StrikeHistoryPage() {
  const [expiry, setExpiry]     = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [strikeRelative, setStrikeRelative] = useState('ATM');
  const [optionType, setOptionType] = useState<'CE' | 'PE'>('CE');
  const [error, setError] = useState('');

  useEffect(() => {
    setExpiriesLoading(true);
    setError('');

    fetch('/api/options/strike-history?mode=expiries')
      .then(r => r.json())
      .then((j: { success: boolean; expiries?: string[]; error?: string }) => {
        if (j.success && j.expiries?.length) {
          setExpiries(j.expiries);
          setExpiry(j.expiries[0]);
        } else {
          setError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M3 3v18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 16l4-6 4 3 6-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Options · {UNDERLYING}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Strike History</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              1-minute close price of one strike across its expiry lifetime
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {expiry && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold
                             bg-zinc-900 text-zinc-400 border border-zinc-700 font-mono tracking-wide">
              DATA: {expiry}
            </span>
          )}

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

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Strike</span>
            <select
              value={strikeRelative}
              onChange={e => setStrikeRelative(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 tabular-nums"
            >
              {OFFSETS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {(['CE', 'PE'] as const).map(t => (
              <button
                key={t}
                onClick={() => setOptionType(t)}
                className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-md transition-colors ${
                  optionType === t
                    ? t === 'CE'
                      ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                      : 'bg-red-500/15 text-red-400 border border-red-500/25'
                    : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                }`}
              >
                {t}
              </button>
            ))}
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
          <StrikeHistoryTab expiry={expiry} strikeRelative={strikeRelative} optionType={optionType} />
        ) : (
          !expiriesLoading && (
            <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
              Please select an expiry to display strike history.
            </div>
          )
        )}
      </div>
    </div>
  );
}
