'use client';

import { usePathname } from 'next/navigation';
import NavBar from '@/components/NavBar';

// Shared layout for all options-related routes. NavBar lives here (not inside
// each page component) so it persists across navigations instead of
// re-mounting, and stays interactive while the next page loads — but only
// for the routes below, which still need it: every other page under this
// layout now renders NavBar itself, inline at the far right of its own
// sticky header, instead of getting this separate strip above it (that
// strip was a 3rd header level, stacked on top of a page's own title row
// and its tab row).
//
// /options/live-charts is the one holdout: it's a bespoke full-height shell
// (its own mini sidebar, a centered gradient title bar with no room for
// controls) rather than the sticky-header pattern every other page here
// uses, so it hasn't been given the same treatment yet.
const SHARED_NAVBAR_ROUTES = new Set(['/options/live-charts']);

export default function OptionsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const useSharedStrip = SHARED_NAVBAR_ROUTES.has(pathname);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {useSharedStrip && (
        <div className="flex items-center px-6 py-2 border-b border-zinc-900 bg-zinc-950">
          <NavBar />
        </div>
      )}
      {children}
    </div>
  );
}
