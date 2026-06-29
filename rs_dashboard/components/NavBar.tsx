'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/', label: 'RS Scanner' },
  { href: '/movers', label: 'Movers' },
  { href: '/movers-plus', label: 'Movers+' },
  { href: '/scanner', label: 'Scanner' },
  { href: '/normalized', label: 'Charts' },
  { href: '/breadth', label: 'Breadth' },
  { href: '/distribution', label: 'Distribution' },
  { href: '/live', label: 'Live' },
  { href: '/strategies', label: 'Strategies' },
  { href: '/strategies-plus', label: 'Strategies+' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/portfolio-new', label: 'Portfolio+' },
  { href: '/reports', label: 'Reports' },
  { href: '/performance', label: 'Performance' },
  { href: '/options', label: 'Options' },
  { href: '/scalper', label: 'Scalper' },
];

export default function NavBar() {
  const pathname = usePathname();
  return (
    <div className="flex items-center bg-zinc-900/80 border border-zinc-800 p-0.5 rounded-xl flex-wrap">
      {NAV_LINKS.map(({ href, label }) =>
        pathname === href ? (
          <span key={href} className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            {label}
          </span>
        ) : (
          <Link key={href} href={href} className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-500 hover:text-zinc-300 transition-all">
            {label}
          </Link>
        )
      )}
    </div>
  );
}
