'use client';
import { useEffect, useState } from 'react';

export interface GlobalQuote {
  ltp: number; prev_close: number; change_pct: number | null;
  day_high: number | null; day_low: number | null; source: string; date: string; ts?: number; closed?: boolean;
}

// DXY + US yields: live (Yahoo 1-min) with EOD-CSV fallback; the route caches 15 s.
export function useGlobalQuotes(): Record<string, GlobalQuote> {
  const [q, setQ] = useState<Record<string, GlobalQuote>>({});
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/markets/global').then(r => r.json())
      .then(d => { if (alive && d?.success) setQ(d.quotes); }).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return q;
}
