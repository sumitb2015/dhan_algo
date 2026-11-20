'use client';

import { cn } from '@/lib/utils';
import type { Dir, DirLeg } from '@/lib/gearboxLedger';
import { FOCUS_RING } from './TradeStrip';
import type { GearboxEngine } from './useGearboxEngine';

// What ↑ and ↓ trade: per direction, BUY / SELL, CE / PE and the strike offset from ATM (OTM positive). The summary line shows the
// contract the server would pick now (from its own fresh futures price) and that option's live price. Locked while a leg is held.

const SEL = 'h-7 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-100 disabled:opacity-40';

export function DirectionMap({ e }: { e: GearboxEngine }) {
  const c = e.config;
  if (!c) return null;
  const locked = !!e.held;
  const set = (d: Dir, p: Partial<DirLeg>) => void e.setConfig({ map: { ...c.map, [d]: { ...c.map[d], ...p } } });
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-2" data-testid="gb-map">
      {(['LONG', 'SHORT'] as const).map(d => {
        const leg = c.map[d];
        const t = e.contracts[d];
        const q = e.prices?.contracts[d] ?? null;
        const err = e.state?.contractErrors?.[d] ?? null;
        return (
          <div key={d} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={cn('w-14 font-bold', d === 'LONG' ? 'text-emerald-300' : 'text-red-300')}>{d === 'LONG' ? '↑ Long' : '↓ Short'}</span>
            <select aria-label={`${d} action`} disabled={locked} value={leg.action} onChange={ev => set(d, { action: ev.target.value as DirLeg['action'] })} className={cn(SEL, FOCUS_RING)}>
              <option value="BUY">BUY</option><option value="SELL">SELL</option>
            </select>
            <select aria-label={`${d} option`} disabled={locked} value={leg.opt} onChange={ev => set(d, { opt: ev.target.value as DirLeg['opt'] })} className={cn(SEL, FOCUS_RING)}>
              <option value="CE">CE</option><option value="PE">PE</option>
            </select>
            <select aria-label={`${d} strike offset`} disabled={locked} value={leg.offset} onChange={ev => set(d, { offset: Number(ev.target.value) })} className={cn(SEL, FOCUS_RING)}>
              {[-3, -2, -1, 0, 1, 2, 3].map(o => <option key={o} value={o}>{o === 0 ? 'ATM' : o > 0 ? `${o} OTM` : `${-o} ITM`}</option>)}
            </select>
            <span className="tabular-nums text-zinc-300" title={err ?? 'The option the server would pick now (nearest expiry after today)'}>
              {t ? `${leg.action} ${t.strike} ${t.side}` : <span className="text-amber-400">{err ?? '—'}</span>}
              {t && <span className="ml-1.5 text-zinc-400">{q ? `@ ${q.ltp.toFixed(2)}${q.ageMs > 10_000 ? ' (stale)' : ''}` : '@ —'}</span>}
            </span>
          </div>
        );
      })}
      {locked && <span className="text-[11px] text-zinc-500">locked while a leg is held</span>}
    </div>
  );
}
