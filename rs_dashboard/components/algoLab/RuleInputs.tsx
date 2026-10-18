'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Free-typed rule inputs commit on blur / Enter only (dhan-commit-on-blur): a half-typed value can never reach a
 * running engine. Escape reverts. The server validates every commit again (lib/algoLab/configSchema.ts).
 */
export function NumInput({
  value,
  onCommit,
  label,
  step,
  disabled,
}: {
  value: number;
  onCommit: (v: number) => void;
  label: string;
  step?: number;
  disabled?: boolean;
}) {
  const str = String(value ?? '');
  const [draft, setDraft] = useState(str);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(str);
  }, [str]);
  const commit = () => {
    const t = draft.trim();
    const n = Number(t);
    if (t !== str && t !== '' && Number.isFinite(n)) onCommit(n);
    else setDraft(str);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      aria-label={label}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(str);
          e.currentTarget.blur();
        } else if (step && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          const decimals = (String(step).split('.')[1] ?? '').length;
          setDraft(String(Number(((Number(draft) || 0) + (e.key === 'ArrowUp' ? step : -step)).toFixed(decimals))));
        }
      }}
      className={cn(
        'h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white tabular-nums',
        'focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    />
  );
}

export function TimeInput({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft)) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? value}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      placeholder="HH:MM"
      maxLength={5}
      className="h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white focus:border-emerald-500/50 focus:outline-none"
    />
  );
}
