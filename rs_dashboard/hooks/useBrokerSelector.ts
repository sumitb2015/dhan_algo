'use client';

import { useState, useEffect } from 'react';

export type Broker = 'dhan' | 'zerodha';

/** Picks the Dhan or Zerodha URL for the currently selected broker. */
export function brokerRoute(broker: Broker, dhanPath: string, zerodhaPath: string): string {
  return broker === 'zerodha' ? zerodhaPath : dhanPath;
}

/**
 * Tracks the selected broker (always defaults to 'dhan' on mount, no
 * persistence) and which brokers currently have a valid session, fetched
 * once from /api/auth/broker-status.
 */
export function useBrokerSelector() {
  const [broker, setBroker] = useState<Broker>('dhan');
  const [authenticatedBrokers, setAuthenticatedBrokers] = useState<Broker[]>(['dhan']);
  // True once /api/auth/broker-status has actually confirmed at least one
  // broker session — distinct from authenticatedBrokers, which always falls
  // back to ['dhan'] so existing broker-select dropdowns keep working even
  // when no session is live. Callers that gate real-money actions (order
  // placement) should check this instead of authenticatedBrokers.length.
  const [hasAuthenticatedBroker, setHasAuthenticatedBroker] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    fetch('/api/auth/broker-status')
      .then(r => r.json())
      .then((j: { dhan: boolean; zerodha: boolean }) => {
        const brokers: Broker[] = [];
        if (j.dhan) brokers.push('dhan');
        if (j.zerodha) brokers.push('zerodha');
        setAuthenticatedBrokers(brokers.length ? brokers : ['dhan']);
        setHasAuthenticatedBroker(brokers.length > 0);
        setAuthChecked(true);
      })
      .catch(() => {});
  }, []);

  return { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker, authChecked };
}
