'use client';

import RuleNumInput from '@/components/multiLegFocus/RuleNumInput';
import { activeFloorPct, type TsRisk, type TsTrail, type TsTrailKind } from '@/lib/tripleStraddle';

const KINDS: { id: TsTrailKind | ''; label: string }[] = [
  { id: '', label: 'No trail' },
  { id: 'trailSl', label: 'Trail SL' },
  { id: 'lock', label: 'Lock profit' },
  { id: 'lockTrail', label: 'Lock & trail' },
];

/** Trailing stop / profit lock, all in % of the entry premium (same rules as Focus Tool's overall
 *  trail). `peakPct` is shown on an open position so the live floor is visible. */
export function TrailControls({
  risk, onChange, peakPct,
}: {
  risk: TsRisk;
  onChange: (trail: TsTrail | undefined) => void;
  peakPct?: number;
}) {
  const t = risk.trail;
  const set = (patch: Partial<TsTrail>) => t && onChange({ ...t, ...patch });
  const num = 'w-12';
  const floor = t && peakPct != null ? activeFloorPct(risk, peakPct) : null;
  const needsSl = t?.kind === 'trailSl' && !(risk.slPct && risk.slPct > 0);
  const badStep = (t?.kind === 'trailSl' || t?.kind === 'lockTrail') && t.every != null && t.by != null && t.by > t.every;
  const badLock = (t?.kind === 'lock' || t?.kind === 'lockTrail') && t.reach != null && (t.lock ?? 0) >= t.reach;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={t?.kind ?? ''} aria-label="Trailing rule"
        onChange={(e) => onChange(e.target.value ? { kind: e.target.value as TsTrailKind } : undefined)}
        className="h-7 bg-zinc-900 border border-zinc-700 rounded px-1.5 text-xs text-zinc-100"
      >
        {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
      </select>
      {(t?.kind === 'lock' || t?.kind === 'lockTrail') && (
        <>
          <label className="flex items-center gap-1 text-zinc-300">When profit hits %
            <RuleNumInput value={t.reach} onCommit={(v) => set({ reach: v })} className={num} title="Arms once the profit peak reaches this % of the entry premium" />
          </label>
          <label className="flex items-center gap-1 text-zinc-300">lock %
            <RuleNumInput value={t.lock} onCommit={(v) => set({ lock: v })} className={num} placeholder="0" title="Exit if profit falls back to this %. Empty = 0 = breakeven" />
          </label>
        </>
      )}
      {(t?.kind === 'trailSl' || t?.kind === 'lockTrail') && (
        <>
          <label className="flex items-center gap-1 text-zinc-300">every %
            <RuleNumInput value={t.every} onCommit={(v) => set({ every: v })} className={num} title="For every this much more peak profit…" />
          </label>
          <label className="flex items-center gap-1 text-zinc-300">move %
            <RuleNumInput value={t.by} onCommit={(v) => set({ by: v })} className={num} title="…the stop / floor moves this much in your favour" />
          </label>
        </>
      )}
      {needsSl && <span className="text-amber-300">Trail SL needs an SL %</span>}
      {badStep && <span className="text-amber-300">Move % must not exceed every % (trail ignored)</span>}
      {badLock && <span className="text-amber-300">Lock % must be below the profit that arms it</span>}
      {floor && peakPct != null && (
        <span className="font-mono text-zinc-400">
          peak {peakPct.toFixed(1)}% · {floor.kind === 'SL' ? 'stop' : floor.kind === 'TRAIL' ? 'trail stop' : 'locked floor'} {floor.floor >= 0 ? '+' : ''}{floor.floor.toFixed(1)}%
        </span>
      )}
    </div>
  );
}
