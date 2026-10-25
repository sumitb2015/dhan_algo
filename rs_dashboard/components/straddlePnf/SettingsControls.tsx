'use client';

import { useState } from 'react';
import { INTERVALS, type Interval } from '@/lib/straddlePnfInterval';
import { MAX_BOX_PCT, MIN_BOX_PCT, REVERSALS, parseBoxPct, type PnfSettings, type Reversal } from '@/lib/straddlePnfSettings';

// Bar interval, box size and reversal: shared by the live page and the simulator so they behave identically.

const LABEL = 'flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500';
const FIELD = 'h-7 rounded-md border bg-zinc-900 px-2 text-xs text-zinc-200';

/**
 * Free-typed, so it commits on Enter / blur only (a half-typed "0." must not rebuild the charts). An invalid or out-of-range entry
 * reverts to the last valid value. The parent re-keys it on the committed value so the draft always starts from it.
 */
function BoxPctInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const invalid = draft.trim() !== '' && parseBoxPct(draft) === null;
  const commit = () => {
    const n = parseBoxPct(draft);
    if (n === null) { setDraft(String(value)); return; }
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      aria-label="Box %" type="text" inputMode="decimal" value={draft} aria-invalid={invalid}
      title={`Box size as a % of the first price (${MIN_BOX_PCT}-${MAX_BOX_PCT}); press Enter to apply`}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setDraft(String(value)); }}
      className={`${FIELD} w-16 ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
    />
  );
}

export default function SettingsControls({ settings, onChange }: { settings: PnfSettings; onChange: (next: PnfSettings) => void }) {
  return (
    <>
      <label className={LABEL}>
        Interval
        <select aria-label="Interval" value={settings.interval} className={`${FIELD} border-zinc-700`}
                onChange={e => onChange({ ...settings, interval: Number(e.target.value) as Interval })}>
          {INTERVALS.map(n => <option key={n} value={n}>{n} min</option>)}
        </select>
      </label>
      <label className={LABEL}>
        Box %
        <BoxPctInput key={settings.boxPct} value={settings.boxPct} onCommit={n => onChange({ ...settings, boxPct: n })} />
      </label>
      <label className={LABEL}>
        Reversal
        <select aria-label="Reversal" value={settings.reversal} className={`${FIELD} border-zinc-700`}
                onChange={e => onChange({ ...settings, reversal: Number(e.target.value) as Reversal })}>
          {REVERSALS.map(n => <option key={n} value={n}>{n}-box</option>)}
        </select>
      </label>
    </>
  );
}
