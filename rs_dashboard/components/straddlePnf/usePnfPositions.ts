'use client';

import { useEffect, useMemo, useState } from 'react';
import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import { legPositions } from '@/lib/pnfAccount';
import { paperPosition, realPosition, type LadderPosition } from '@/lib/pnfLadderPosition';
import type { PaperLeg } from '@/lib/pnfOrderLogic';
import type { RailChart } from './usePnfResting';

// Each chart's open position (entry premium + P&L) for the ladder rail. PAPER comes from the page's paper ledger; REAL reads
// the selected broker's positions book once every 5 s for both charts (read-only, display only: it never sizes an order).
const POLL_MS = 5_000;

export function usePnfPositions({ charts, broker, mode, paper }: {
  charts: RailChart[]; broker: Broker; mode: 'PAPER' | 'REAL'; paper: Record<string, PaperLeg[]>;
}): { byKey: Record<string, LadderPosition | null>; /** REAL: the broker book has been read at least once for this broker (PAPER: always). */ loaded: boolean } {
  const [rows, setRows] = useState<{ broker: string; rows: Array<Record<string, unknown>> } | null>(null);
  const sig = charts.map(c => c.keys.join(',')).join('|');
  useEffect(() => {
    if (mode !== 'REAL' || !sig.replace(/[|,]/g, '')) return;
    let dead = false;
    const read = async () => {
      try {
        const j = await (await fetch(`${scalperRoute(broker, 'poll')}?only=positions`)).json() as { positions?: Array<Record<string, unknown>>; positionsError?: string | null };
        if (!dead) setRows(!j.positionsError && Array.isArray(j.positions) ? { broker, rows: j.positions } : null);
      } catch { if (!dead) setRows(null); }
    };
    void read();
    const id = setInterval(read, POLL_MS);
    return () => { dead = true; clearInterval(id); };
  }, [mode, broker, sig]);

  const byKey = useMemo(() => {
    const out: Record<string, LadderPosition | null> = {};
    for (const c of charts) {
      if (mode === 'PAPER') {
        const legs = paper[c.targetKey];
        out[c.targetKey] = legs?.length ? paperPosition(legs, c.legPrices, c.unitsPerLot) : null;
      } else if (rows && rows.broker === broker && c.keys.length) {
        const bySymbol = broker !== 'dhan';
        const { lots, book } = legPositions(rows.rows, bySymbol, c.keys, c.lotUnits);
        const mine = rows.rows.filter(r => c.keys.includes(String((bySymbol ? r.tradingSymbol : r.securityId) ?? '')));
        out[c.targetKey] = realPosition(mine, bySymbol, c.keys, lots, book);
      } else out[c.targetKey] = null;
    }
    return out;
  }, [charts, mode, paper, rows, broker]);
  return { byKey, loaded: mode === 'PAPER' || (rows !== null && rows.broker === broker) };
}
