'use client';

import { useState, useEffect } from 'react';

export const BROKERS = ['dhan', 'zerodha', 'kotak'] as const;
export type Broker = typeof BROKERS[number];

/** Display names for the broker selector. */
export const BROKER_LABELS: Record<Broker, string> = {
  dhan: 'Dhan',
  zerodha: 'Zerodha',
  kotak: 'Kotak',
};

/**
 * Picks the API path for the currently selected broker.
 *
 * Takes a map rather than positional arguments: with three brokers a positional
 * pair silently routes the third one to Dhan's endpoint, which on an order
 * placement means trading the wrong account. A missing entry falls back to
 * `dhan`, which is always present.
 */
export function brokerRoute(broker: Broker, paths: Partial<Record<Broker, string>>): string {
  return paths[broker] ?? paths.dhan ?? '';
}

/** The conventional `/api/scalper/<x>` layout: Dhan at the root, others nested. */
export function scalperRoute(broker: Broker, endpoint: string): string {
  return broker === 'dhan' ? `/api/scalper/${endpoint}` : `/api/scalper/${broker}/${endpoint}`;
}

const STORAGE_KEY = 'dhan_algo.selected_broker';

/**
 * Tracks the selected broker (persisted in localStorage so choices survive
 * reloads) and which brokers currently have a valid session, fetched
 * once from /api/auth/broker-status.
 */
export function useBrokerSelector() {
  // Always initialize to 'dhan' so the client's first render matches the SSR
  // HTML — reading localStorage here (even guarded by typeof window) still
  // runs during the client's first render pass, before hydration reconciles,
  // so it diverged from the server's output and threw a hydration mismatch.
  const [broker, setBrokerState] = useState<Broker>('dhan');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Broker | null;
      if (saved && BROKERS.includes(saved)) setBrokerState(saved);
    } catch {}
  }, []);
  const [authenticatedBrokers, setAuthenticatedBrokers] = useState<Broker[]>(['dhan']);
  // True once /api/auth/broker-status has actually confirmed at least one
  // broker session — distinct from authenticatedBrokers, which always falls
  // back to ['dhan'] so existing broker-select dropdowns keep working even
  // when no session is live. Callers that gate real-money actions (order
  // placement) should check this instead of authenticatedBrokers.length.
  const [hasAuthenticatedBroker, setHasAuthenticatedBroker] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  const setBroker = (b: Broker) => {
    setBrokerState(b);
    try {
      localStorage.setItem(STORAGE_KEY, b);
    } catch {}
  };

  useEffect(() => {
    fetch('/api/auth/broker-status')
      .then(r => r.json())
      .then((j: Partial<Record<Broker, boolean>>) => {
        const brokers = BROKERS.filter(b => j[b]);
        setAuthenticatedBrokers(brokers.length ? brokers : ['dhan']);
        setHasAuthenticatedBroker(brokers.length > 0);
        setAuthChecked(true);
      })
      .catch(() => {});
  }, []);

  return { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker, authChecked };
}
