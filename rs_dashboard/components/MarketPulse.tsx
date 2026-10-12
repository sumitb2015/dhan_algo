'use client';

import { useCallback, useState } from 'react';
import { Newspaper } from 'lucide-react';
import NavBar from '@/components/NavBar';
import { cn } from '@/lib/utils';
import NewsPanel from '@/components/market-pulse/NewsPanel';
import MoversPanel from '@/components/market-pulse/MoversPanel';
import CompanyInfoDrawer, { type CompanyTarget } from '@/components/market-pulse/CompanyInfoDrawer';

type Tab = 'news' | 'movers';
const TABS: { key: Tab; label: string }[] = [{ key: 'news', label: 'Headlines' }, { key: 'movers', label: 'Live movers' }];

export default function MarketPulse() {
  const [tab, setTab] = useState<Tab>('news');
  const [moversVisited, setMoversVisited] = useState(false);
  const pickTab = (t: Tab) => { setTab(t); if (t === 'movers') setMoversVisited(true); };
  const [company, setCompany] = useState<CompanyTarget | null>(null);
  // Each tab reports the date of its own data; the header chip shows the active tab's.
  const [dates, setDates] = useState<Record<Tab, string | null>>({ news: null, movers: null });
  const setNewsDate = useCallback((d: string | null) => setDates(p => (p.news === d ? p : { ...p, news: d })), []);
  const setMoversDate = useCallback((d: string | null) => setDates(p => (p.movers === d ? p : { ...p, movers: d })), []);
  const closeCompany = useCallback(() => setCompany(null), []);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Newspaper className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400 mb-0.5">Equity · Dhan Market Analytics</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Market Pulse</h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">Live headlines with sentiment, exchange-ranked movers, one-click company fundamentals</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div role="tablist" aria-label="Market Pulse view" className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {TABS.map(t => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => pickTab(t.key)}
                className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all',
                  tab === t.key ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
                {t.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dates[tab] || '—'}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5 max-w-[1680px] w-full mx-auto">
        {/* A visited panel stays mounted so switching tabs keeps its filters and last data; only the active one polls. */}
        <div className={tab === 'news' ? 'contents' : 'hidden'}><NewsPanel active={tab === 'news'} onOpenCompany={setCompany} onDataDate={setNewsDate} /></div>
        {moversVisited && (
          <div className={tab === 'movers' ? 'contents' : 'hidden'}><MoversPanel active={tab === 'movers'} onOpenCompany={setCompany} onDataDate={setMoversDate} /></div>
        )}
      </div>

      <CompanyInfoDrawer target={company} onClose={closeCompany} />
    </div>
  );
}
