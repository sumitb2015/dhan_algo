'use client';

import { useEffect, useRef, useState } from 'react';
import type { BrokerPortfolio, DashboardPortfolioResponse } from '@/app/api/dashboard/portfolio/route';
import { sharedJson } from '@/lib/sharedPoll';

export interface BrokerPnlState {
  connected: boolean;
  totalPnl: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  openPositions: number | null;
  error: string | null;
  loading: boolean;
}

const POLL_MS = 5_000;

export function useBrokerPnl(broker: string | undefined): BrokerPnlState {
  const [state, setState] = useState<BrokerPnlState>({
    connected: false,
    totalPnl: null,
    realizedPnl: null,
    unrealizedPnl: null,
    openPositions: null,
    error: null,
    loading: true,
  });
  const seq = useRef(0);

  useEffect(() => {
    if (!broker) return;
    const mySeq = ++seq.current;

    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const j = await sharedJson<DashboardPortfolioResponse>(`/api/dashboard/portfolio?broker=${broker}`, 3_000);
        if (mySeq !== seq.current) return;
        const b = j.brokers?.find((x: BrokerPortfolio) => x.broker.toLowerCase() === broker.toLowerCase());
        if (!j.success || !b) {
          setState(prev => ({ ...prev, loading: false, error: 'Unavailable' }));
          return;
        }
        if (!b.connected) {
          setState({
            connected: false,
            totalPnl: null,
            realizedPnl: null,
            unrealizedPnl: null,
            openPositions: null,
            error: b.error ?? 'Disconnected',
            loading: false,
          });
          return;
        }
        setState({
          connected: true,
          totalPnl: b.totalPnl,
          realizedPnl: b.realizedPnl,
          unrealizedPnl: b.unrealizedPnl,
          openPositions: b.openPositions,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (mySeq !== seq.current) return;
        setState(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : 'Failed' }));
      }
    };

    void load();
    const interval = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(interval);
  }, [broker]);

  return state;
}
