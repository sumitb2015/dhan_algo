'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV_LINKS = [
  { href: '/', label: 'RS Scanner' },
  { href: '/movers', label: 'Movers' },
  { href: '/movers-plus', label: 'Movers+' },
  { href: '/scanner', label: 'Scanner' },
  { href: '/normalized', label: 'Charts' },
  { href: '/breadth', label: 'Breadth' },
  { href: '/diffusion', label: 'Diffusion' },
  { href: '/futures', label: 'Futures' },
  { href: '/distribution', label: 'Distribution' },
  { href: '/live', label: 'Live' },
  { href: '/strategies', label: 'Strategies' },
  { href: '/strategies-plus', label: 'Strategies+' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/portfolio-new', label: 'Portfolio+' },
  { href: '/reports', label: 'Reports' },
  { href: '/performance', label: 'Performance' },
  { href: '/rrg', label: 'RRG' },
  { href: '/options', label: 'Options' },
  { href: '/iv-charts', label: 'IV Charts' },
  { href: '/scalper', label: 'Scalper' },
];

export default function NavBar() {
  const pathname = usePathname();
  const router   = useRouter();

  async function handleDisconnect() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <div className="flex items-center bg-zinc-900/80 border border-zinc-800 p-0.5 rounded-xl flex-wrap">
      {NAV_LINKS.map(({ href, label }) =>
        pathname === href ? (
          <span key={href} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            {label}
          </span>
        ) : (
          <Link key={href} href={href} className="px-3 py-1.5 text-xs font-bold rounded-lg text-zinc-300 hover:text-white transition-all">
            {label}
          </Link>
        )
      )}
      <span className="w-px h-4 bg-zinc-700 mx-1 shrink-0" />
      <button
        onClick={handleDisconnect}
        className="px-2.5 py-1 text-xs font-medium rounded-lg text-zinc-400 hover:text-red-400 hover:bg-zinc-800 transition-colors whitespace-nowrap"
      >
        Disconnect
      </button>
    </div>
  );
}
