'use client';

import React, { useState, useEffect, useCallback } from 'react';
import OptionScatter3D from './OptionScatter3D';
import NavBar from './NavBar';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;

export default function OptionScatter3DPage() {
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [expiryPick, setExpiryPick] = useState<{ underlying: string; expiry: string } | null>(null);
  // Expiry list is stored with the underlying it was fetched for, so switching
  // underlying is "loading" by derivation — no synchronous reset inside the effect.
  const [expData, setExpData] = useState<{ underlying: string; list: string[]; error: string } | null>(null);
  const [meta, setMeta] = useState<{ spot: number; updatedAt: number } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/options/expiries?underlying=${underlying}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (!alive) return;
        setExpData(j.success && j.data?.length
          ? { underlying, list: j.data, error: '' }
          : { underlying, list: [], error: j.error ?? 'Failed to load expiries' });
      })
      .catch(e => alive && setExpData({ underlying, list: [], error: String(e) }));
    return () => { alive = false; };
  }, [underlying]);

  const fresh = expData?.underlying === underlying ? expData : null;
  const loadingExp = !fresh;
  const expiries = fresh?.list ?? [];
  const error = fresh?.error ?? '';
  const expiry = expiryPick?.underlying === underlying && expiries.includes(expiryPick.expiry)
    ? expiryPick.expiry
    : expiries[0] ?? ''; // nearest = current week
  const setExpiry = (e: string) => setExpiryPick({ underlying, expiry: e });

  const onMeta = useCallback((m: { spot: number; updatedAt: number }) => setMeta(m), []);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-emerald-400">
              <path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <path d="M12 12l9-5M12 12L3 7M12 12v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em] mb-0.5">
              Options · {underlying}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Option Cube · Price × OI × IV</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              3D scatter of every strike&apos;s premium change, OI change and implied vol — spot the best buys and sells
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-mono tabular-nums text-amber-300 font-bold uppercase tracking-wide">
            DATA: {today}
          </span>
          {meta && meta.spot > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-zinc-400">
              Spot {meta.spot.toFixed(2)} · {new Date(meta.updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' })}
            </span>
          )}
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <select
            value={underlying}
            onChange={e => { setUnderlying(e.target.value); setMeta(null); }}
            className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                       rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500"
          >
            {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Expiry</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              disabled={loadingExp}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                         rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500
                         disabled:opacity-50 tabular-nums"
            >
              {expiries.map((e, i) => <option key={e} value={e}>{e}{i === 0 ? ' (current)' : ''}</option>)}
            </select>
          </div>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">{error}</div>
      )}

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {expiry ? (
          <OptionScatter3D key={`${underlying}|${expiry}`} underlying={underlying} expiry={expiry} onMeta={onMeta} />
        ) : (
          !loadingExp && <p className="text-sm text-zinc-500">No expiry available.</p>
        )}
      </div>
    </div>
  );
}
