'use client';

import { useEffect, useState } from 'react';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

export type DhanKotak = 'dhan' | 'kotak';
const DHAN_KOTAK: readonly DhanKotak[] = ['dhan', 'kotak'];

/**
 * Per-page Dhan / Kotak choice for the terminals that trade on either (Triple Straddle, Bearish Strikes, Options Screener,
 * Covered Call, Equity ticket, CSP desk, Live Options Charts, Option Strats – Stocks, Options Monitor). Remembered per page in this browser only; it is a convenience, never the
 * authority for an open position, which always keeps the broker it was opened on.
 *
 * `allowed` is the set of accounts the page can trade on (Dhan + Kotak by default). A page that also supports Zerodha passes
 * all three here AND to BrokerPicker; a saved choice outside `allowed` falls back to Dhan.
 */
export function usePageBroker<B extends Broker = DhanKotak>(storageKey: string, allowed: readonly B[] = DHAN_KOTAK as readonly B[]): [B, (b: B) => void, boolean] {
  const [broker, setBroker] = useState<B>('dhan' as B);
  // False until the stored choice has been read: the first render is always 'dhan' (it must match the server HTML), so
  // a page saved on Kotak that polls an account on that first render reads DHAN's. Account reads wait for this.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v && (allowed as readonly string[]).includes(v)) setBroker(v as B);
    } catch { /* storage unavailable: Dhan */ }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const set = (b: B) => {
    setBroker(b);
    try { localStorage.setItem(storageKey, b); } catch { /* best effort */ }
  };
  return [broker, set, loaded];
}

export function BrokerPicker<B extends Broker = DhanKotak>({ value, onChange, disabled, disabledReason, brokers }: {
  value: B; onChange: (b: B) => void; disabled?: boolean; disabledReason?: string; brokers?: readonly B[];
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as B)}
      disabled={disabled}
      aria-label="Broker for new orders"
      title={disabled ? disabledReason : 'Account NEW orders go to. Open positions keep the broker they were opened on.'}
      className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-bold rounded-lg px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {(brokers ?? (DHAN_KOTAK as readonly B[])).map(b => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
    </select>
  );
}
