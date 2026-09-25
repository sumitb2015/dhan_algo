'use client';

import { useEffect } from 'react';
import { initTheme } from '@/lib/theme';
import { initPreferences } from '@/lib/preferences';

/**
 * Syncs the theme + heading-font stores with whatever the pre-paint script in
 * app/layout.tsx already applied to <html>.
 *
 * Mounted in the root layout rather than left to ThemeToggle/SettingsPanel:
 * those only exist inside NavBar, so on a page that doesn't render one
 * (/login) the stores would stay on their defaults while the DOM was already
 * showing the real preference — and any consumer of useResolvedTheme() there
 * (the canvas charts read chrome from it) would paint mismatched chrome.
 * Both init functions are idempotent.
 */
export default function ThemeInit() {
  useEffect(() => {
    initTheme();
    initPreferences();
  }, []);
  return null;
}
