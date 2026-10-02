'use client';
import { useEffect, useState } from 'react';

export interface MarketHistory {
  last_date: string;
  c1w: number | null; c1m: number | null; cytd: number | null;
  hi52: number | null; lo52: number | null;
}

// Daily-CSV reference closes; they only change when the data sync runs.
export function useMarketHistory(): Record<string, MarketHistory> {
  const [h, setH] = useState<Record<string, MarketHistory>>({});
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/markets/history').then(r => r.json())
      .then(d => { if (alive && d?.success) setH(d.history); }).catch(() => {});
    load();
    const t = setInterval(load, 300_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return h;
}
