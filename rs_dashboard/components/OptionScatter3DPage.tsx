'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import OptionScatter3D from './OptionScatter3D';
import NavBar from './NavBar';
import { describeExpiries, lastSessionDate, type ChainSummary } from '@/lib/optionScatter3d';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
const NO_EXPIRIES: string[] = []; // stable identity so memos keyed on the list don't re-run while loading

function fmtOiCompact(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function OptionScatter3DPage() {
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [expiryPick, setExpiryPick] = useState<{ underlying: string; expiry: string } | null>(null);
  // Expiry list is stored with the underlying it was fetched for, so switching
  // underlying is "loading" by derivation — no synchronous reset inside the effect.
  const [expData, setExpData] = useState<{ underlying: string; list: string[]; error: string } | null>(null);
  const [rawMeta, setMeta] = useState<{ viewKey: string; spot: number; updatedAt: number; summary?: ChainSummary | null } | null>(null);

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
  const expiries = fresh?.list ?? NO_EXPIRIES;
  const error = fresh?.error ?? '';
  const expiry = expiryPick?.underlying === underlying && expiries.includes(expiryPick.expiry)
    ? expiryPick.expiry
    : expiries[0] ?? ''; // nearest = current week
  const setExpiry = (e: string) => setExpiryPick({ underlying, expiry: e });

  // Stats belong to one underlying|expiry. Anything from another expiry is hidden, so switching
  // never leaves the previous expiry's PCR / OI under the new one while its chain loads.
  const viewKey = `${underlying}|${expiry}`;
  const meta = rawMeta && rawMeta.viewKey === viewKey ? rawMeta : null;
  const onMeta = useCallback((m: { viewKey: string; spot: number; updatedAt: number; count: number; summary?: ChainSummary | null }) => setMeta(m), []);

  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const expiryOptions = useMemo(() => describeExpiries(expiries, todayIst), [expiries, todayIst]);
  const currentExpiry = expiryOptions.find(o => o.value === expiry);
  const expiryIdx = expiries.indexOf(expiry);

  // The chain carries no timestamp, so the chip shows the session it belongs to
  // (weekend / pre-open roll back to the prior weekday) rather than today's date.
  const session = lastSessionDate();
  const isLive = session === todayIst;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white w-full min-w-0">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-4 sm:px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur w-full">
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
            DATA: {session}{isLive ? '' : ' · last session'}
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
            <div className="flex items-center rounded-lg border border-emerald-500/40 bg-zinc-900 focus-within:border-emerald-400">
              <button
                onClick={() => setExpiry(expiries[expiryIdx - 1])}
                disabled={loadingExp || expiryIdx <= 0}
                aria-label="Previous (nearer) expiry"
                title="Previous (nearer) expiry"
                className="px-1.5 py-1.5 text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <select
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                disabled={loadingExp}
                aria-label="Select expiry"
                className="bg-transparent text-zinc-100 text-xs font-mono font-semibold px-1 py-1.5
                           focus:outline-none disabled:opacity-50 tabular-nums min-w-[15.5rem]"
              >
                {expiryOptions.map((o, i) => (
                  <option key={o.value} value={o.value}>{o.label}{i === 0 ? ' · current' : ''}</option>
                ))}
              </select>
              <button
                onClick={() => setExpiry(expiries[expiryIdx + 1])}
                disabled={loadingExp || expiryIdx < 0 || expiryIdx >= expiries.length - 1}
                aria-label="Next (later) expiry"
                title="Next (later) expiry"
                className="px-1.5 py-1.5 text-zinc-400 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-400"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {/* Market Metrics Strip */}
      {meta?.summary && (
        <div className="px-4 sm:px-6 py-2 bg-zinc-900/40 border-b border-zinc-800 flex items-center gap-4 text-xs font-mono tabular-nums flex-wrap w-full">
          {currentExpiry && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Expiry</span>
                <span className="text-emerald-400 font-bold">{currentExpiry.label}</span>
              </div>
              <span className="w-px h-3.5 bg-zinc-800 shrink-0" />
            </>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">ATM Strike</span>
            <span className="text-amber-300 font-bold">{meta.summary.atmStrike}</span>
          </div>
          <span className="w-px h-3.5 bg-zinc-800 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">PCR</span>
            <span className={`font-bold ${meta.summary.pcr >= 1 ? 'text-emerald-400' : meta.summary.pcr <= 0.7 ? 'text-red-400' : 'text-zinc-200'}`}>
              {meta.summary.pcr.toFixed(2)}
            </span>
          </div>
          <span className="w-px h-3.5 bg-zinc-800 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Total CE OI</span>
            <span className="text-blue-400 font-bold">{fmtOiCompact(meta.summary.totalCeOi)}</span>
          </div>
          <span className="w-px h-3.5 bg-zinc-800 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Total PE OI</span>
            <span className="text-amber-400 font-bold">{fmtOiCompact(meta.summary.totalPeOi)}</span>
          </div>
          <span className="w-px h-3.5 bg-zinc-800 shrink-0" />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Max OI Strikes</span>
            <span className="text-zinc-300">
              <span className="text-blue-400 font-semibold">{meta.summary.maxCeOiStrike} CE</span> / <span className="text-amber-400 font-semibold">{meta.summary.maxPeOiStrike} PE</span>
            </span>
          </div>
        </div>
      )}

      {error && (
        <div className="mx-4 sm:mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400 w-auto">
          {error}
        </div>
      )}

      <main className="flex-1 flex flex-col gap-4 px-4 sm:px-6 py-4 w-full min-w-0">
        {expiry ? (
          <OptionScatter3D key={underlying} underlying={underlying} expiry={expiry} onMeta={onMeta} />
        ) : (
          !loadingExp && <p className="text-sm text-zinc-500">No expiry available.</p>
        )}
      </main>
    </div>
  );
}
