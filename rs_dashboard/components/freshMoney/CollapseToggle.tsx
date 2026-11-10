'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';

/** Chevron that collapses / expands a Fresh Money panel (state and its saved preference live with the page). */
export default function CollapseToggle({ collapsed, onToggle, label, controls }: {
  collapsed: boolean;
  onToggle: () => void;
  /** What is collapsed, for the accessible name: "chart", "positions and orders". */
  label: string;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
      title={collapsed ? `Show ${label}` : `Hide ${label}`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950/40 text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
    >
      <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
    </button>
  );
}
