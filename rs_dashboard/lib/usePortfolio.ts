'use client';

import { useState, useEffect, useCallback } from 'react';
import type { PortfolioData } from './useStrategyGroups';

const POLL_MS = 20000;

/**
 * Polls GET /api/portfolio for the broker-level P&L / margin summary shown on both
 * strategy control pages.
 *
 * A failed fetch clears the data to null rather than keeping the last good snapshot:
 * these numbers drive Global Exit decisions, and a stale-but-plausible P&L is worse
 * than an explicit "—". An expired token comes back as HTTP 200 with success:false,
 * which is preserved so callers can show the "run login.py" hint.
 */
export function usePortfolio(pollMs: number = POLL_MS) {
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/portfolio');
      setPortfolio(await res.json());
    } catch {
      setPortfolio(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollMs);
    return () => clearInterval(interval);
  }, [refresh, pollMs]);

  return { portfolio, loading, refresh };
}
