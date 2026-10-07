'use client';

// User-chosen refresh interval for the GEX pages: 5 seconds to 3 minutes in 5-second steps, remembered per browser.
import React, { useEffect, useState } from 'react';

export const MIN_UPDATE_SEC = 5;
export const MAX_UPDATE_SEC = 180;
export const STEP_UPDATE_SEC = 5;
const DEFAULT_UPDATE_SEC = 60;
// A new key: the earlier slider stored whole minutes under another name, which would read as hours here.
const KEY = 'gex_update_sec';

const clamp = (n: number) => {
  const stepped = Math.round(n / STEP_UPDATE_SEC) * STEP_UPDATE_SEC;
  return Math.min(MAX_UPDATE_SEC, Math.max(MIN_UPDATE_SEC, stepped));
};

/** "45 s", "1 min", "2 min 30 s". */
export function fmtInterval(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Seconds between refreshes. Starts at 60; the saved choice is read after mount so server and client first paint agree. */
export function useUpdateInterval(): [number, (s: number) => void] {
  const [seconds, setSeconds] = useState(DEFAULT_UPDATE_SEC);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = Number(localStorage.getItem(KEY));
        if (Number.isFinite(saved) && saved >= MIN_UPDATE_SEC) setSeconds(clamp(saved));
      } catch { /* storage blocked: keep the default */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const set = (s: number) => {
    const v = clamp(s);
    setSeconds(v);
    try { localStorage.setItem(KEY, String(v)); } catch { /* storage blocked */ }
  };
  return [seconds, set];
}

export default function UpdateIntervalSlider({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  return (
    <label
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900"
      title="How often the page refreshes the option chain, the spot and the level chart. The server keeps each chain for 30 s, so the chain itself changes at most every 30 s; the spot follows this setting. Dhan limits chain calls account-wide."
    >
      <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Update</span>
      <input
        type="range"
        min={MIN_UPDATE_SEC}
        max={MAX_UPDATE_SEC}
        step={STEP_UPDATE_SEC}
        value={seconds}
        onChange={e => onChange(Number(e.target.value))}
        aria-label="Update frequency in seconds"
        aria-valuetext={fmtInterval(seconds)}
        className="w-28 accent-emerald-500 cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500/50 rounded"
      />
      <span className="w-[4.5rem] text-xs font-mono font-semibold text-zinc-200 tabular-nums">{fmtInterval(seconds)}</span>
    </label>
  );
}
