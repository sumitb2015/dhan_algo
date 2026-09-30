'use client';

import { useState, useEffect } from 'react';
import { isUnderlyingLive } from './marketHours';

/**
 * Whether `underlying`'s exchange session is open (NSE, or MCX for crude),
 * re-checked every 30s. Used to stop auto-refresh polls outside market hours.
 * `initial` is the value for the server render / first paint, before the
 * client clock is read.
 */
export function useMarketLive(underlying = 'NIFTY', initial = true): boolean {
  const [live, setLive] = useState(initial);
  useEffect(() => {
    const update = () => setLive(isUnderlyingLive(underlying, new Date()));
    // First read deferred a task: no setState during the mount pass.
    const first = setTimeout(update, 0);
    const id = setInterval(update, 30_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [underlying]);
  return live;
}
