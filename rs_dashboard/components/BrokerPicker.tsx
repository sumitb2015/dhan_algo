'use client';

import { useEffect, useState } from 'react';
import { BROKER_LABELS } from '@/hooks/useBrokerSelector';

export type DhanKotak = 'dhan' | 'kotak';

/**
 * Per-page Dhan / Kotak choice for the terminals that trade on either (Triple Straddle, Bearish Strikes, Options Screener,
 * Covered Call, Equity ticket, CSP desk, Live Options Charts, Option Strats – Stocks, Options Monitor). Remembered per page in this browser only; it is a convenience, never the
 * authority for an open position, which always keeps the broker it was opened on.
 */
export function usePageBroker(storageKey: string): [DhanKotak, (b: DhanKotak) => void, boolean] {
  const [broker, setBroker] = useState<DhanKotak>('dhan');
  // False until the stored choice has been read: the first render is always 'dhan' (it must match the server HTML), so
  // a page saved on Kotak that polls an account on that first render reads DHAN's. Account reads wait for this.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === 'kotak' || v === 'dhan') setBroker(v);
    } catch { /* storage unavailable: Dhan */ }
    setLoaded(true);
  }, [storageKey]);
  const set = (b: DhanKotak) => {
    setBroker(b);
    try { localStorage.setItem(storageKey, b); } catch { /* best effort */ }
  };
  return [broker, set, loaded];
}

export function BrokerPicker({ value, onChange, disabled, disabledReason }: {
  value: DhanKotak; onChange: (b: DhanKotak) => void; disabled?: boolean; disabledReason?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as DhanKotak)}
      disabled={disabled}
      aria-label="Broker for new orders"
      title={disabled ? disabledReason : 'Account NEW orders go to. Open positions keep the broker they were opened on.'}
      className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-bold rounded-lg px-2 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <option value="dhan">{BROKER_LABELS.dhan}</option>
      <option value="kotak">{BROKER_LABELS.kotak}</option>
    </select>
  );
}
