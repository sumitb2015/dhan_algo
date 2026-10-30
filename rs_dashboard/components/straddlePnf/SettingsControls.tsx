'use client';

import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { INTERVALS, type Interval } from '@/lib/straddlePnfInterval';
import {
  MAX_BOX_PCT, MIN_BOX_PCT, MAX_BOX_PTS, MIN_BOX_PTS, MAX_SMA_PERIOD, MIN_SMA_PERIOD, REVERSALS, parseBoxPct, parseBoxPts, parseSmaPeriod, stepBox,
  type PnfSettings, type Reversal,
} from '@/lib/straddlePnfSettings';

// Bar interval, box size, reversal and the SMA period: shared by the live page and the simulator so they behave identically.

const LABEL = 'flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400';
const FIELD = 'h-7 rounded-md border bg-zinc-900 px-2 text-xs font-semibold text-zinc-100';

/**
 * Free-typed, so it commits on Enter / blur only (a half-typed "0." must not rebuild the charts). An invalid or out-of-range entry
 * reverts to the last valid value. The parent re-keys it on the committed value so the draft always starts from it.
 */
function CommitInput({ value, parse, onCommit, label, title, inputMode, width }: {
  value: number; parse: (text: string) => number | null; onCommit: (n: number) => void;
  label: string; title: string; inputMode: 'decimal' | 'numeric'; width: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const invalid = draft.trim() !== '' && parse(draft) === null;
  const commit = () => {
    const n = parse(draft);
    if (n === null) { setDraft(String(value)); return; }
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <input
      aria-label={label} type="text" inputMode={inputMode} value={draft} aria-invalid={invalid} title={title}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setDraft(String(value)); }}
      className={`${FIELD} ${width} ${invalid ? 'border-red-500' : 'border-zinc-700'}`}
    />
  );
}

/**
 * On a stepper button: keep focus in the text box, so pressing the button does not blur it and commit a half-typed draft first.
 * The step then starts from the applied value and the re-keyed box drops the draft (dhan-commit-on-blur: steppers never step
 * from a draft).
 */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const STEP_BTN = 'inline-flex items-center justify-center h-7 w-6 border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:pointer-events-none';

/**
 * The SMA overlay's period in P&F boxes, next to the VWAP / SMA toggle: − / + step it by 1 (Shift: 10), clamped to the allowed
 * range, and apply at once (a click is a finished value); the box between them is free-typed and commits on Enter / blur.
 */
export function SmaPeriodInput({ settings, onChange }: { settings: PnfSettings; onChange: (next: PnfSettings) => void }) {
  const p = settings.smaPeriod;
  const step = (dir: 1 | -1, big: boolean) => {
    const next = Math.min(MAX_SMA_PERIOD, Math.max(MIN_SMA_PERIOD, p + dir * (big ? 10 : 1)));
    if (next !== p) onChange({ ...settings, smaPeriod: next });
  };
  return (
    <div className={LABEL}>
      <span>Period</span>
      <div className="inline-flex items-center">
        <button type="button" aria-label="Decrease SMA period" title="Decrease the SMA period by 1 (Shift: 10)" disabled={p <= MIN_SMA_PERIOD}
                onMouseDown={keepFocus} onClick={e => step(-1, e.shiftKey)} className={`${STEP_BTN} rounded-l-md border-r-0`}>
          <Minus className="w-3 h-3" aria-hidden="true" />
        </button>
        <CommitInput key={p} value={p} parse={parseSmaPeriod} label="SMA period" inputMode="numeric" width="w-12 rounded-none text-center"
                     title={`SMA period in P&F boxes (${MIN_SMA_PERIOD}-${MAX_SMA_PERIOD}): it averages box values, not candle closes; press Enter to apply`}
                     onCommit={n => onChange({ ...settings, smaPeriod: n })} />
        <button type="button" aria-label="Increase SMA period" title="Increase the SMA period by 1 (Shift: 10)" disabled={p >= MAX_SMA_PERIOD}
                onMouseDown={keepFocus} onClick={e => step(1, e.shiftKey)} className={`${STEP_BTN} rounded-r-md border-l-0`}>
          <Plus className="w-3 h-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default function SettingsControls({ settings, onChange }: { settings: PnfSettings; onChange: (next: PnfSettings) => void }) {
  const boxValue = settings.boxMode === 'pct' ? settings.boxPct : settings.boxPts;
  const setBox = (n: number) => { if (n !== boxValue) onChange(settings.boxMode === 'pct' ? { ...settings, boxPct: n } : { ...settings, boxPts: n }); };
  return (
    <>
      <label className={LABEL}>
        Interval
        <select aria-label="Interval" value={settings.interval} className={`${FIELD} border-zinc-700`}
                onChange={e => onChange({ ...settings, interval: Number(e.target.value) as Interval })}>
          {INTERVALS.map(n => <option key={n} value={n}>{n} min</option>)}
        </select>
      </label>
      {/* Box size as a % of the first price or as fixed price points; each mode keeps its own value. */}
      <div className={LABEL}>
        <span>Box</span>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md border border-zinc-800 bg-zinc-900" role="group" aria-label="Box unit">
          {(['pct', 'pts'] as const).map(m => (
            <button key={m} type="button" aria-pressed={settings.boxMode === m} onClick={() => settings.boxMode !== m && onChange({ ...settings, boxMode: m })}
                    className={`px-1.5 h-5 rounded text-[10px] font-bold normal-case tracking-normal ${settings.boxMode === m ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-100'}`}>
              {m === 'pct' ? '%' : 'pts'}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center">
          {/* − / + step to the next round size and apply at once, from the applied value (a half-typed draft is discarded). */}
          <button type="button" aria-label="Decrease box size" title="Smaller box (next round size)" disabled={stepBox(settings.boxMode, boxValue, -1) === boxValue}
                  onMouseDown={keepFocus} onClick={() => setBox(stepBox(settings.boxMode, boxValue, -1))} className={`${STEP_BTN} rounded-l-md border-r-0`}>
            <Minus className="w-3 h-3" aria-hidden="true" />
          </button>
          {settings.boxMode === 'pct' ? (
            <CommitInput key={`pct:${settings.boxPct}`} value={settings.boxPct} parse={parseBoxPct} label="Box %" inputMode="decimal" width="w-14 rounded-none text-center"
                         title={`Box size as a % of the first price (${MIN_BOX_PCT}-${MAX_BOX_PCT}); press Enter to apply`}
                         onCommit={setBox} />
          ) : (
            <CommitInput key={`pts:${settings.boxPts}`} value={settings.boxPts} parse={parseBoxPts} label="Box points" inputMode="decimal" width="w-14 rounded-none text-center"
                         title={`Box size in price points (${MIN_BOX_PTS}-${MAX_BOX_PTS.toLocaleString('en-IN')}); never below ${MIN_BOX_PCT}% of the price; press Enter to apply`}
                         onCommit={setBox} />
          )}
          <button type="button" aria-label="Increase box size" title="Bigger box (next round size)" disabled={stepBox(settings.boxMode, boxValue, 1) === boxValue}
                  onMouseDown={keepFocus} onClick={() => setBox(stepBox(settings.boxMode, boxValue, 1))} className={`${STEP_BTN} rounded-r-md border-l-0`}>
            <Plus className="w-3 h-3" aria-hidden="true" />
          </button>
        </div>
      </div>
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
