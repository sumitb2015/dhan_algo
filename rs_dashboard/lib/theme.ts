'use client';

/**
 * Theme store — strict 2-way toggle (dark / light), persisted to localStorage.
 */

import { useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'dhan-theme';
const DEFAULT_MODE: ThemeMode = 'dark';

const listeners = new Set<() => void>();

let mode: ThemeMode = DEFAULT_MODE;
let initialised = false;

function isMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

function apply() {
  const root = document.documentElement;
  const isDark = mode === 'dark';
  root.classList.toggle('dark', isDark);
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

export const THEME_CYCLE: ThemeMode[] = ['dark', 'light'];

export function nextThemeMode(current: ThemeMode): ThemeMode {
  return current === 'dark' ? 'light' : 'dark';
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

