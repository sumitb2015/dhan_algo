'use client';

import { cn } from '@/lib/utils';
import { gbContractLabel, legAgainstDir, type Dir, type DirLeg } from '@/lib/gearboxLedger';
import { FOCUS_RING } from './TradeStrip';
import type { GearboxEngine } from './useGearboxEngine';

// What ↑ and ↓ trade: per direction, BUY / SELL, CE / PE / FUT, the strike offset from ATM (OTM positive) and the expiry (Nearest = the
// first expiry after today, or a listed one). FUT trades the signal future itself (the page's road), so offset and expiry are hidden.
// The summary line shows the contract the server would pick now (from its own fresh futures price) and its live price. Safety cues:
// a SELL leg is flagged "margin, unlimited risk", and a leg that gains on the OTHER direction's move (lib/gearboxLedger legAgainstDir:
// ↑ with a PE BUY / CE SELL / FUT SELL, ↓ with a CE BUY / PE SELL / FUT BUY) gets a ⚠. Locked while a leg is held.

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
        const listed = e.state?.expiries ?? [];
        const expiries = leg.expiry !== 'nearest' && !listed.includes(leg.expiry) ? [leg.expiry, ...listed] : listed;
        const against = legAgainstDir(d, leg);
        const fut = leg.opt === 'FUT';
        return (
          <div key={d} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className={cn('w-14 font-bold', d === 'LONG' ? 'text-emerald-300' : 'text-red-300')}>{d === 'LONG' ? '↑ Long' : '↓ Short'}</span>
            <select aria-label={`${d} action`} disabled={locked} value={leg.action} onChange={ev => set(d, { action: ev.target.value as DirLeg['action'] })} className={cn(SEL, FOCUS_RING)}>
              <option value="BUY">BUY</option><option value="SELL">SELL</option>
            </select>
            <select aria-label={`${d} option`} disabled={locked} value={leg.opt} className={cn(SEL, FOCUS_RING)}
              onChange={ev => { const opt = ev.target.value as DirLeg['opt']; set(d, opt === 'FUT' ? { opt, offset: 0, expiry: 'nearest' } : { opt }); }}>
              <option value="CE">CE</option><option value="PE">PE</option><option value="FUT">FUT</option>
            </select>
            {!fut && <>
              <select aria-label={`${d} strike offset`} disabled={locked} value={leg.offset} onChange={ev => set(d, { offset: Number(ev.target.value) })} className={cn(SEL, FOCUS_RING)}>
                {[-3, -2, -1, 0, 1, 2, 3].map(o => <option key={o} value={o}>{o === 0 ? 'ATM' : o > 0 ? `${o} OTM` : `${-o} ITM`}</option>)}
              </select>
              <select aria-label={`${d} expiry`} disabled={locked} value={leg.expiry} onChange={ev => set(d, { expiry: ev.target.value })} className={cn(SEL, FOCUS_RING)}
                title="Nearest = the first option expiry after today (never one expiring today)">
                <option value="nearest">Nearest</option>
                {expiries.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </>}
            {against && (
              <span data-testid={`gb-map-against-${d}`} className="font-bold text-amber-400"
                title={`This leg gains when price moves ${d === 'LONG' ? 'DOWN' : 'UP'}, the opposite of the ${d === 'LONG' ? '↑' : '↓'} button`}>
                ⚠ gains on a {d === 'LONG' ? 'fall' : 'rise'}
              </span>
            )}
            {leg.action === 'SELL' && (
              <span data-testid={`gb-map-sell-${d}`} className="rounded bg-red-500/15 px-1.5 text-[11px] font-bold text-red-300" title={fut ? 'A SELL FUT leg is a short future: margin, and the loss grows with every point the price rises' : 'A SELL leg is a short option'}>
                margin, unlimited risk
              </span>
            )}
            <span data-testid={`gb-map-pick-${d}`} className="tabular-nums text-zinc-300"
              title={err ?? (fut ? `The signal future${t?.expiry ? ` (expires ${t.expiry})` : ''}` : 'The option the server would pick now, at this expiry')}>
              {t ? (t.kind === 'futures' ? `${leg.action} ${gbContractLabel(t)}` : `${leg.action} ${t.strike} ${t.side}`) : <span className="text-amber-400">{err ?? '—'}</span>}
              {t && <span className="ml-1.5 text-zinc-400">{q ? `@ ${q.ltp.toFixed(2)}${q.ageMs > 10_000 ? ' (stale)' : ''}` : '@ —'}</span>}
            </span>
          </div>
        );
      })}
      {locked && <span className="text-[11px] text-zinc-500">locked while a leg is held</span>}
    </div>
  );
}
