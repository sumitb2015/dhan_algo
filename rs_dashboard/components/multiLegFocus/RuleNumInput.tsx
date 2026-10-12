'use client';

import React, { useState, useRef, useEffect } from 'react';
import { FOCUS_RING } from '@/components/Scalper';
import { parseRuleNum } from '@/lib/ruleNum';

interface RuleNumInputProps {
  value: number | undefined;
  onCommit: (val: number | undefined) => void;
  placeholder?: string;
  className?: string;
  title?: string;
  disabled?: boolean;
  min?: number;
  step?: number;
  /** Accept zero and negative numbers (Greek bands). Default: only numbers above 0. */
  signed?: boolean;
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
  signed = false,
}: RuleNumInputProps) {
  const strVal = value != null && (signed ? Number.isFinite(value) : value > 0) ? String(value) : '';
  const [draft, setDraft] = useState(strVal);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(strVal);
    }
  }, [strVal]);

  const commit = (raw: string) => {
    const p = parseRuleNum(raw, signed);
    if (p.kind === 'value') {
      if (p.n !== value) onCommit(p.n);
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
