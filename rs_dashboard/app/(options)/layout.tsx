'use client';

import { usePathname } from 'next/navigation';
import NavBar from '@/components/NavBar';

// Shared layout for all options-related routes. NavBar lives here (not inside
// each page component) so it persists across navigations instead of
// re-mounting, and stays interactive while the next page loads.
//
// Pages listed here render NavBar themselves, inline at the far right of
// their own sticky header, instead of getting this separate strip above it
// — that strip was a 3rd header level stacked on top of a page's own title
// row and its tab row. Add a route here once its header has room for the
// cluster; see components/OptionsCharts.tsx for the pattern to copy.
const OWNS_NAVBAR_PLACEMENT = new Set(['/options']);

export default function OptionsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const ownsPlacement = OWNS_NAVBAR_PLACEMENT.has(pathname);

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {!ownsPlacement && (
        <div className="flex items-center px-6 py-2 border-b border-zinc-900 bg-zinc-950">
          <NavBar />
        </div>
      )}
      {children}
    </div>
  );
}
