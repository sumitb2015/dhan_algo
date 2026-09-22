'use client';

/**
 * Theme store — 3-way cycle (dark / light / beige), persisted to localStorage.
 *
 * `.dark` on <html> is kept as the sole switch for the `@custom-variant dark`
 * Tailwind hook (`dark:` utilities) — only the 'dark' mode sets it. Every mode
 * also gets `data-theme` on <html>, which is what the beige palette block in
 * app/globals.css (`:root[data-theme="beige"]`) keys off; 'light' needs no
 * such block since it's the bare `:root` default.
 */

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'beige';
export type ResolvedTheme = 'light' | 'dark' | 'beige';

export const THEME_STORAGE_KEY = 'dhan-theme';
const DEFAULT_MODE: ThemeMode = 'dark';

const listeners = new Set<() => void>();

let mode: ThemeMode = DEFAULT_MODE;
let initialised = false;

function isMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'beige';
}

function apply() {
  const root = document.documentElement;
  const isDark = mode === 'dark';
  root.classList.toggle('dark', isDark);
  root.setAttribute('data-theme', mode);
  root.style.colorScheme = isDark ? 'dark' : 'light';
  listeners.forEach((l) => l());
}

export function initTheme() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  mode = isMode(stored) ? stored : DEFAULT_MODE;

  // Keep multiple tabs in sync
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    mode = isMode(e.newValue) ? e.newValue : DEFAULT_MODE;
    apply();
  });

  apply();
}

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  apply();
}

const CYCLE: Record<ThemeMode, ThemeMode> = {
  dark: 'light',
  light: 'beige',
  beige: 'dark',
};

export function nextThemeMode(current: ThemeMode): ThemeMode {
  return CYCLE[current];
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode, () => DEFAULT_MODE);
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => mode, () => DEFAULT_MODE);
}

