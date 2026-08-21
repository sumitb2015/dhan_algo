'use client';

import { useEffect } from 'react';
import { initTheme } from '@/lib/theme';

/**
 * Syncs the theme store with whatever the pre-paint script in app/layout.tsx
 * already applied to <html>.
 *
 * Mounted in the root layout rather than left to ThemeToggle: the toggle only
 * exists inside NavBar, so on a page that doesn't render one (/login) the store
 * would stay on its 'dark' default while the DOM was actually light — and any
 * consumer of useResolvedTheme() there (the canvas charts read chrome from it)
 * would paint dark chrome on a white page. initTheme() is idempotent.
 */
export default function ThemeInit() {
  useEffect(() => { initTheme(); }, []);
  return null;
}
