'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function RuleNumInput({
  value,
  onCommit,
  placeholder,
  className,
  title,
  disabled,
  step,
  min = 0,
  max,
  label,
  wrapperClassName,
}: {
  value: string | number;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  step?: number;
  min?: number;
  max?: number;
  label?: string;
  wrapperClassName?: string;
}) {
  const strVal = String(value ?? '');
  const [draft, setDraft] = useState(strVal);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(strVal);
  }, [strVal]);

  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed !== strVal) {
      onCommit(trimmed);
    }
  };

  const nudge = (dir: 1 | -1) => {
    if (!step || disabled) return;
    const base = Number(strVal) || 0;
    const decimals = (String(step).split('.')[1] ?? '').length;
    let n = Number((base + dir * step).toFixed(decimals));
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    const next = String(n);
    setDraft(next);
    commit(next);
  };

  const inputEl = (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      aria-label={label ?? title}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focusedRef.current = false;
        commit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(strVal);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'ArrowUp' && step) {
          e.preventDefault();
          nudge(1);
        } else if (e.key === 'ArrowDown' && step) {
          e.preventDefault();
          nudge(-1);
        }
      }}
      className={cn(
        'h-7 rounded border border-zinc-800 bg-zinc-900/90 px-2 text-xs font-medium text-white tabular-nums',
        'focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    />
  );

  if (!step) return inputEl;

  return (
    <div className={cn('relative inline-flex items-center', wrapperClassName)}>
      {inputEl}
      <div className="absolute right-1 flex flex-col -space-y-1">
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => nudge(1)}
          className="p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          aria-label={label ? `Increase ${label}` : 'Increase'}
        >
          <ChevronUp className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => nudge(-1)}
          className="p-0.5 text-zinc-500 hover:text-zinc-200 disabled:opacity-30"
          aria-label={label ? `Decrease ${label}` : 'Decrease'}
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
