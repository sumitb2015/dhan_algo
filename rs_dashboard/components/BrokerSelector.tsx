'use client';

import React from 'react';
import { BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';

interface BrokerSelectorProps {
  broker: Broker;
  setBroker: (b: Broker) => void;
  authenticatedBrokers?: Broker[];
  className?: string;
}

export default function BrokerSelector({
  broker,
  setBroker,
  authenticatedBrokers = ['dhan', 'zerodha', 'kotak'],
  className = '',
}: BrokerSelectorProps) {
  return (
    <div className={`flex items-center gap-1 bg-zinc-900/80 p-0.5 rounded-lg border border-zinc-800 text-xs ${className}`}>
      {(['dhan', 'zerodha', 'kotak'] as Broker[]).map((b) => {
        const isSelected = broker === b;
        const isAuth = authenticatedBrokers.includes(b);
        return (
          <button
            key={b}
            type="button"
            onClick={() => setBroker(b)}
            className={`px-2.5 py-1 rounded-md font-medium transition-all text-xs flex items-center gap-1.5 ${
              isSelected
                ? 'bg-zinc-800 text-white font-bold shadow-sm'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
            }`}
            title={!isAuth && b !== 'dhan' ? `${BROKER_LABELS[b]} session unverified` : undefined}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isAuth ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            {BROKER_LABELS[b]}
          </button>
        );
      })}
    </div>
  );
}
