'use client';

/**
 * Dense config controls for the Focus Tool terminal.
 *
 * Every row on this page is a form, so these are tuned for a table cell rather
 * than a settings panel: 10-11px labels, h-6 inputs, no vertical padding to
 * spare. They are deliberately uncontrolled-on-blur where a value drives real
 * orders — see NumField.
 *
 * Colours are zinc-ramp tokens only (CLAUDE.md), so the whole page flips
 * between dark and white mode without a single `dark:` variant.
 */

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// ─── Pill toggle ──────────────────────────────────────────────────

export function PillToggle({ on, onChange, label, tone = 'cyan', disabled, title }: {
  on: boolean;
  onChange: (next: boolean) => void;
  label?: React.ReactNode;
  tone?: 'cyan' | 'emerald' | 'red';
  disabled?: boolean;
  title?: string;
}) {
  const active = {
    cyan:    'border-cyan-500/40 bg-cyan-500/10 text-zinc-100',
    emerald: 'border-emerald-500/40 bg-emerald-500/10 text-zinc-100',
    red:     'border-red-500/40 bg-red-500/10 text-zinc-100',
  }[tone];
  const knob = { cyan: 'bg-cyan-500', emerald: 'bg-emerald-500', red: 'bg-red-500' }[tone];

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      className={cn(
        'flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full border text-[10px] font-bold transition-colors disabled:opacity-50',
        on ? active : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-300',
      )}
    >
      <span className={cn('relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors',
        on ? knob : 'bg-zinc-600')}>
        {/* bg-oncolor is always white — correct on the coloured track in both themes */}
        <span className={cn('inline-block h-2.5 w-2.5 transform rounded-full bg-oncolor transition-transform',
          on ? 'translate-x-3' : 'translate-x-0.5')} />
      </span>
      {label}
    </button>
  );
}

// ─── Numeric field ────────────────────────────────────────────────

/**
 * A numeric input that commits on blur or Enter, not on every keystroke.
 *
 * These values size orders and set stop levels. Committing per keystroke means
 * typing "1500" transiently commits 1, then 15, then 150 — and a config that is
 * saved or evaluated in that window acts on a number the user never intended.
 * Empty always commits null ("unset"), never 0: a 0 spot level would breach
 * instantly.
 */
export function NumField({ value, onCommit, placeholder, width = 'w-16', disabled, title, min }: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  width?: string;
  disabled?: boolean;
  title?: string;
  min?: number;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  // Re-sync when the value changes underneath us (a load, or the worker
  // reporting a fill) — but never while the user is mid-edit in this field.
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') { onCommit(null); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) { setDraft(value === null ? '' : String(value)); return; }
    if (min !== undefined && n < min) { setDraft(value === null ? '' : String(value)); return; }
    onCommit(n);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(value === null ? '' : String(value)); (e.target as HTMLInputElement).blur(); }
      }}
      className={cn(
        width,
        'h-6 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-mono tabular-nums',
        'rounded px-1.5 focus:outline-none focus:border-cyan-500 disabled:opacity-50',
        '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
      )}
    />
  );
}

// ─── Time field ───────────────────────────────────────────────────

export function TimeField({ value, onCommit, disabled, title }: {
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <input
      type="time"
      value={value}
      disabled={disabled}
      title={title}
      onChange={e => onCommit(e.target.value)}
      className={cn(
        'h-6 w-[86px] bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-mono',
        'rounded px-1.5 focus:outline-none focus:border-cyan-500 disabled:opacity-50',
      )}
    />
  );
}

// ─── Chip group ───────────────────────────────────────────────────

export function ChipGroup<T extends string>({ options, value, onChange, disabled, title }: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 bg-zinc-900 border border-zinc-800 p-0.5 rounded" title={title}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors disabled:opacity-50',
            value === o.value ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-500 hover:text-zinc-300',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────

const BTN_TONES = {
  neutral: 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200',
  emerald: 'bg-emerald-600 border-emerald-500/40 text-oncolor hover:bg-emerald-500',
  red:     'bg-red-600 border-red-500/40 text-oncolor hover:bg-red-500',
  cyan:    'bg-cyan-700 border-cyan-500/40 text-oncolor hover:bg-cyan-600',
  ghostRed: 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20',
} as const;

export function MiniButton({ children, onClick, tone = 'neutral', disabled, title, className }: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: keyof typeof BTN_TONES;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'px-2 py-0.5 rounded border text-[10px] font-bold transition-colors whitespace-nowrap',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        BTN_TONES[tone], className,
      )}
    >
      {children}
    </button>
  );
}

// ─── State badge ──────────────────────────────────────────────────

const STATE_TONE: Record<string, string> = {
  DRAFT:   'bg-zinc-800 text-zinc-400 border-zinc-700',
  ARMED:   'bg-amber-500/10 text-amber-400 border-amber-500/30',
  ENTERED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  EXITED:  'bg-zinc-800 text-zinc-500 border-zinc-700',
  ERROR:   'bg-red-500/10 text-red-400 border-red-500/30',
};

export function StateBadge({ state, title }: { state: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide',
        STATE_TONE[state] ?? STATE_TONE.DRAFT,
      )}
    >
      {state}
    </span>
  );
}

// ─── Field label ──────────────────────────────────────────────────

export function FieldLabel({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider whitespace-nowrap"
    >
      {children}
    </span>
  );
}
