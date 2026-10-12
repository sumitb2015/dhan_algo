'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Building2, ChevronDown, Loader2, Newspaper, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtAge } from '@/lib/marketStatus';
import { NEWS_CATEGORIES, type NewsItem } from '@/lib/dhanAnalytics';
import type { CompanyTarget } from './CompanyInfoDrawer';

const POLL_MS = 60_000;
type Sentiment = 'all' | 'positive' | 'negative' | 'neutral';
type Universe = '' | 'PORTFOLIO' | 'WATCHLIST';

const SENTIMENT_DOT: Record<NewsItem['sentiment'], string> = {
  positive: 'bg-emerald-400', negative: 'bg-red-400', neutral: 'bg-zinc-500',
};
const SENTIMENT_LABEL: Record<NewsItem['sentiment'], string> = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };

function pretty(s: string): string {
  return s.replace(/[-_]/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

const selectCls = 'h-8 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

function Segmented<T extends string>({ items, value, onChange, label }: { items: { key: T; label: string }[]; value: T; onChange: (k: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
      {items.map(i => (
        <button key={i.key} onClick={() => onChange(i.key)} aria-pressed={value === i.key}
          className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all',
            value === i.key ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

export default function NewsPanel({ active, onOpenCompany, onDataDate }: { active: boolean; onOpenCompany: (t: CompanyTarget) => void; onDataDate: (d: string | null) => void }) {
  const [category, setCategory] = useState<string>('ALL');
  const [universe, setUniverse] = useState<Universe>('');
  const [limit, setLimit] = useState<number>(30);
  const [sentiment, setSentiment] = useState<Sentiment>('all');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // The expanded headline is remembered by identity. An index would point at a different headline after a refresh or a filter change.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const isStale = () => mine !== seq.current;
    setLoading(true);
    const qs = new URLSearchParams({ categories: category, limit: String(limit) });
    if (universe) qs.set('universe', universe);
    try {
      const r = await fetch(`/api/dhan-news?${qs}`);
      const j = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (isStale()) return;
      if (!r.ok || !j || j.success !== true) { setError(String(j?.error ?? `HTTP ${r.status}`)); return; }
      const list = j.items as NewsItem[];
      setItems(list);
      setError(null);
      setStale(j.stale === true);
      setFetchedAt(typeof j.fetchedAt === 'number' ? j.fetchedAt : Date.now());
      onDataDate(list.reduce<string | null>((m, n) => (n.publishDate && (!m || n.publishDate > m) ? n.publishDate : m), null));
    } catch (e) {
      if (!isStale()) setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [category, universe, limit, onDataDate]);

  // Refetch on filter change, then poll while the tab is visible. The error path keeps the last list on screen.
  // Only the visible tab fetches: a hidden panel polling would spend the account-wide Data-API budget for nothing.
  useEffect(() => {
    if (!active) return;
    const counter = seq;
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearInterval(t); counter.current++; };
  }, [load, active]);

  // A dead feed produces no state updates, so staleness needs its own clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(n =>
      (sentiment === 'all' || n.sentiment === sentiment) &&
      (!q || n.title.toLowerCase().includes(q) || n.stockName.toLowerCase().includes(q) || n.symbol.toLowerCase().includes(q)));
  }, [items, sentiment, query]);

  // Stable identity per headline (date + symbol + title); a repeat of the same triple gets an occurrence suffix so React keys stay unique.
  const keyed = useMemo(() => {
    const seen = new Map<string, number>();
    return visible.map(n => {
      const base = `${n.publishDate}|${n.symbol}|${n.title}`;
      const k = seen.get(base) ?? 0;
      seen.set(base, k + 1);
      return { n, key: k === 0 ? base : `${base}#${k}` };
    });
  }, [visible]);

  const counts = useMemo(() => {
    const c = { positive: 0, negative: 0, neutral: 0 };
    for (const n of items ?? []) c[n.sentiment]++;
    return c;
  }, [items]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="sr-only" htmlFor="news-category">Category</label>
        <select id="news-category" className={selectCls} value={category} onChange={e => setCategory(e.target.value)}>
          {NEWS_CATEGORIES.map(c => <option key={c} value={c}>{c === 'ALL' ? 'All categories' : pretty(c)}</option>)}
        </select>
        <Segmented<Universe> label="Scope" value={universe} onChange={setUniverse}
          items={[{ key: '', label: 'Market' }, { key: 'PORTFOLIO', label: 'My portfolio' }, { key: 'WATCHLIST', label: 'My watchlist' }]} />
        <Segmented<Sentiment> label="Sentiment" value={sentiment} onChange={setSentiment}
          items={[{ key: 'all', label: 'All' }, { key: 'positive', label: `Positive ${counts.positive}` }, { key: 'negative', label: `Negative ${counts.negative}` }, { key: 'neutral', label: `Neutral ${counts.neutral}` }]} />
        <label className="sr-only" htmlFor="news-limit">Items</label>
        <select id="news-limit" className={selectCls} value={limit} onChange={e => setLimit(Number(e.target.value))}>
          {[20, 30, 50].map(n => <option key={n} value={n}>{n} items</option>)}
        </select>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter loaded headlines" aria-label="Filter loaded headlines"
            className={cn(selectCls, 'pl-7 w-48')} />
        </div>
        <button onClick={load} aria-label="Refresh headlines" title="Refresh"
          className="h-8 w-8 flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
        </button>
        {fetchedAt && <span className="text-[10px] text-zinc-500">updated {fmtAge(now, fetchedAt)}</span>}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}{items ? ' - showing the last loaded headlines.' : ''}</span>
        </div>
      )}
      {!error && stale && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>Dhan did not answer the last refresh - showing headlines from {fetchedAt ? fmtAge(now, fetchedAt) : 'earlier'}.</span>
        </div>
      )}

      {items === null && !error && (
        <div className="flex flex-col items-center gap-2 py-16">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-400" aria-hidden="true" />
          <p className="text-zinc-200 font-semibold text-sm">Loading headlines</p>
        </div>
      )}

      {items !== null && visible.length === 0 && !error && (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Newspaper className="h-6 w-6 text-zinc-600" aria-hidden="true" />
          <p className="text-sm text-zinc-400">
            {items.length === 0
              ? `No headlines for ${category === 'ALL' ? 'this scope' : pretty(category)}${universe ? ` in your ${universe.toLowerCase()}` : ''}.`
              : 'No loaded headline matches the sentiment or text filter - loosen it.'}
          </p>
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {keyed.map(({ n, key }) => {
          const seg: CompanyTarget | null = n.nseSecurityId
            ? { securityId: n.nseSecurityId, exchangeSegment: 'NSE_EQ', label: n.stockName || n.symbol }
            : n.bseSecurityId ? { securityId: n.bseSecurityId, exchangeSegment: 'BSE_EQ', label: n.stockName || n.symbol } : null;
          const isOpen = openKey === key;
          return (
            <li key={key} className="rounded-lg border border-zinc-800 bg-zinc-900">
              <div className="flex items-start gap-2 px-3 py-2">
                <span title={SENTIMENT_LABEL[n.sentiment]} className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', SENTIMENT_DOT[n.sentiment])} />
                <button onClick={() => setOpenKey(isOpen ? null : key)} aria-expanded={isOpen}
                  className="flex-1 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded">
                  <span className="block text-[13px] font-semibold text-zinc-100 leading-snug">{n.title}</span>
                  <span className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-zinc-500">
                    {n.stockName && <span className="font-bold text-zinc-300">{n.symbol || n.stockName}</span>}
                    <span>{pretty(n.category)}{n.subCategory ? ` · ${pretty(n.subCategory)}` : ''}</span>
                    <span className="tabular-nums">{n.publishDate}</span>
                  </span>
                </button>
                {seg && (
                  <button onClick={() => onOpenCompany(seg)} aria-label={`Company info for ${seg.label}`} title="Company info"
                    className="shrink-0 h-7 w-7 flex items-center justify-center rounded-md border border-zinc-800 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
                    <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                <ChevronDown className={cn('mt-1 h-3.5 w-3.5 shrink-0 text-zinc-600 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" />
              </div>
              {isOpen && <p className="px-3 pb-3 pl-7 text-xs text-zinc-300 leading-relaxed">{n.text || 'No body text supplied.'}</p>}
            </li>
          );
        })}
      </ul>
      <p className="text-[10px] text-zinc-500">
        Dhan sends a publish date only, no time, so order within a day is exactly as Dhan returns it. Dhan lists this API under its Pro Traders plan.
      </p>
    </div>
  );
}
