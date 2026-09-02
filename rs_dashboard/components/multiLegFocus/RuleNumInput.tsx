'use client';

import React, { useState, useRef, useEffect } from 'react';
import { FOCUS_RING } from '@/components/Scalper';

interface RuleNumInputProps {
  value: number | undefined;
  onCommit: (val: number | undefined) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  min?: number;
  step?: number;
}

/**
 * Commit-on-blur and Enter numeric input component conforming to the
 * dhan-commit-on-blur skill. Prevents mid-edit keystrokes from firing real orders.
 */
export default function RuleNumInput({
  value,
  onCommit,
  placeholder,
  className = '',
  title,
  disabled,
  min,
  step = 0.5,
}: RuleNumInputProps) {
  const strVal = value != null && value > 0 ? String(value) : '';
  const [draft, setDraft] = useState(strVal);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(strVal);
    }
  }, [strVal]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const num = parseFloat(trimmed);
    if (!isNaN(num) && num > 0) {
      if (num !== value) onCommit(num);
    } else if (value !== undefined) {
      onCommit(undefined);
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      min={min}
      step={step}
      onFocus={() => { focusedRef.current = true; }}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => {
        focusedRef.current = false;
        commit(e.currentTarget.value);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setDraft(strVal);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={`h-7 bg-zinc-900 border border-zinc-700 text-zinc-100 text-xs font-mono rounded px-1.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING} ${className}`}
    />
  );
}
