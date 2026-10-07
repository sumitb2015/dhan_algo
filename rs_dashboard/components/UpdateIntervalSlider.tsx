'use client';

// User-chosen refresh interval for the GEX pages: 1 to 30 minutes in 1-minute steps, remembered per browser.
import React, { useEffect, useState } from 'react';

export const MIN_UPDATE_MIN = 1;
export const MAX_UPDATE_MIN = 30;
const KEY = 'gex_update_min';

const clamp = (n: number) => Math.min(MAX_UPDATE_MIN, Math.max(MIN_UPDATE_MIN, Math.round(n)));

/** Minutes between refreshes. Defaults to 1; the saved choice is read after mount so server and client first paint agree. */
export function useUpdateInterval(): [number, (m: number) => void] {
  const [minutes, setMinutes] = useState(MIN_UPDATE_MIN);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = Number(localStorage.getItem(KEY));
        if (Number.isFinite(saved) && saved >= MIN_UPDATE_MIN) setMinutes(clamp(saved));
      } catch { /* storage blocked: keep the default */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const set = (m: number) => {
    const v = clamp(m);
    setMinutes(v);
    try { localStorage.setItem(KEY, String(v)); } catch { /* storage blocked */ }
  };
  return [minutes, set];
}

export default function UpdateIntervalSlider({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  return (
    <label
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900"
      title="How often the page refreshes the option chain, the spot and the level chart. Dhan limits chain calls account-wide, so a longer gap means fewer rate-limit failures."
    >
      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Update</span>
      <input
        type="range"
        min={MIN_UPDATE_MIN}
        max={MAX_UPDATE_MIN}
        step={1}
        value={minutes}
        onChange={e => onChange(Number(e.target.value))}
        aria-label="Update frequency in minutes"
        aria-valuetext={`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}
        className="w-28 accent-emerald-500 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500/50 rounded"
      />
      <span className="w-12 text-xs font-mono font-semibold text-zinc-200 tabular-nums">{minutes} min</span>
    </label>
  );
}
