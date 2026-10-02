'use client';
import { useEffect, useState } from 'react';

export interface DxyQuote {
  ltp: number; prev_close: number; change_pct: number | null;
  day_high: number | null; day_low: number | null; source: string; date: string; ts?: number;
}

// Live (Yahoo 1-min) with EOD-CSV fallback; the route caches 15 s.
export function useDxyQuote(): DxyQuote | null {
  const [q, setQ] = useState<DxyQuote | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/markets/dxy').then(r => r.json())
      .then(d => { if (alive && d?.success) setQ(d); }).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return q;
}
