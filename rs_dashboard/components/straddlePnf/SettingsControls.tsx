'use client';

import { useState } from 'react';
import { DEFAULT_OFFSETS, MAX_OFFSET, STRIKE_STEP, parseOffset, type Offsets } from '@/lib/straddlePnfStrikes';
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

/** Free-typed offset from ATM; commits on Enter / blur, an invalid or duplicate entry reverts. The parent re-keys it on the committed value. */
function OffsetInput({ index, value, onCommit }: { index: number; value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const invalid = draft.trim() !== '' && parseOffset(draft) === null;
  const commit = () => {
    const n = parseOffset(draft);
    if (n === null) { setDraft(String(value)); return; }
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      aria-label={`Chart ${index + 1} offset`} type="text" inputMode="numeric" value={draft} aria-invalid={invalid}
      title={`Strike offset from ATM, a multiple of ${STRIKE_STEP} (max ±${MAX_OFFSET}); press Enter to apply`}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setDraft(String(value)); }}
      className={`${FIELD} w-14 ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
    />
  );
}

export function OffsetControls({ offsets, onChange }: { offsets: Offsets; onChange: (next: Offsets) => void }) {
  const set = (i: number, n: number) => {
    const next = [...offsets] as Offsets;
    next[i] = n;
    if (new Set(next).size === 3) onChange(next); // two charts on one strike would share a key
  };
  const isDefault = offsets.every((o, i) => o === DEFAULT_OFFSETS[i]);
  return (
    <div className={LABEL} role="group" aria-label="Strike offsets">
      Offsets
      {offsets.map((o, i) => <OffsetInput key={`${i}:${o}`} index={i} value={o} onCommit={n => set(i, n)} />)}
      {!isDefault && (
        <button type="button" onClick={() => onChange(DEFAULT_OFFSETS)}
                className="h-7 px-2 rounded-md border border-zinc-700 bg-zinc-900 text-[11px] font-bold text-zinc-300 hover:bg-zinc-800">
          Reset
        </button>
      )}
    </div>
  );
}
