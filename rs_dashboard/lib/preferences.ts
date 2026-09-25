'use client';

/**
 * Heading-font preference — same store shape as lib/theme.ts (module state +
 * useSyncExternalStore + localStorage), kept separate because it's an
 * independent axis from color theme: any font works with any of the three
 * themes. Persists to its own localStorage key so it survives restarts and
 * applies via `data-heading-font` on <html>, which app/globals.css keys off
 * to repoint the real `--heading-font` custom property (the Tailwind
 * `font-heading` utility itself is inlined to `--font-sans` at build time —
 * see the note in globals.css — so this can't go through that utility).
 */

import { useSyncExternalStore } from 'react';

export type HeadingFont = 'inter' | 'poppins' | 'dmsans' | 'playfair' | 'lora' | 'montserrat';

export const HEADING_FONT_STORAGE_KEY = 'dhan-heading-font';
const DEFAULT_FONT: HeadingFont = 'inter';

export const HEADING_FONT_OPTIONS: { value: HeadingFont; label: string; sample: string }[] = [
  { value: 'inter', label: 'Default (Inter)', sample: 'Institutional Market Dashboard' },
  { value: 'poppins', label: 'Poppins', sample: 'Institutional Market Dashboard' },
  { value: 'dmsans', label: 'DM Sans', sample: 'Institutional Market Dashboard' },
  { value: 'montserrat', label: 'Montserrat', sample: 'Institutional Market Dashboard' },
  { value: 'playfair', label: 'Playfair Display', sample: 'Institutional Market Dashboard' },
  { value: 'lora', label: 'Lora', sample: 'Institutional Market Dashboard' },
];

const listeners = new Set<() => void>();

let font: HeadingFont = DEFAULT_FONT;
let initialised = false;

function isFont(value: unknown): value is HeadingFont {
  return value === 'inter' || value === 'poppins' || value === 'dmsans'
    || value === 'playfair' || value === 'lora' || value === 'montserrat';
}

function apply() {
  document.documentElement.setAttribute('data-heading-font', font);
  listeners.forEach((l) => l());
}

export function initPreferences() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(HEADING_FONT_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  font = isFont(stored) ? stored : DEFAULT_FONT;

  window.addEventListener('storage', (e) => {
    if (e.key !== HEADING_FONT_STORAGE_KEY) return;
    font = isFont(e.newValue) ? e.newValue : DEFAULT_FONT;
    apply();
  });

  apply();
}

export function setHeadingFont(next: HeadingFont) {
  font = next;
  try {
    window.localStorage.setItem(HEADING_FONT_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useHeadingFont(): HeadingFont {
  return useSyncExternalStore(subscribe, () => font, () => DEFAULT_FONT);
}
