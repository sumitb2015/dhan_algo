'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { PnfPick } from '@/lib/straddlePnfSearch';

// Search box for the Point & Figure page, scoped to a segment: an NSE stock to chart, or an F&O underlying (its contract is then
// picked beside it). Type a symbol or company name; results come from master_list.csv on the server.

const LABEL: Record<'equity' | 'futures' | 'options', string> = { equity: 'Search stock', futures: 'Search futures underlying', options: 'Search options underlying' };
const TAG: Record<PnfPick['kind'], string> = { index: 'Index', equity: 'Stock', futures: 'FUT', options: 'OPT' };

export default function SymbolSearch({ segment, active, onPick }: { segment: 'equity' | 'futures' | 'options'; active: PnfPick | null; onPick: (p: PnfPick) => void }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<PnfPick[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);
  const listId = useId();

  useEffect(() => {
    const q = text.trim();
    if (!q) return;   // an empty box shows no list (render gates on text), so stale results are never visible or pickable
    const id = ++reqRef.current;
    const t = setTimeout(() => {
      fetch(`/api/straddle-pnf/search?q=${encodeURIComponent(q)}&segment=${segment}`)
        .then(r => r.json())
        .then((j: { success?: boolean; results?: PnfPick[]; error?: string }) => {
          if (id !== reqRef.current) return;               // a newer keystroke owns the list
          setResults(j.results ?? []);
          setError(j.success ? null : j.error ?? 'Search failed');
          setHi(0);
        })
        .catch(() => { if (id === reqRef.current) setError('Search failed'); });
    }, 200);
    return () => clearTimeout(t);
  }, [text, segment]);

  const pick = (p: PnfPick) => { onPick(p); setText(''); setResults([]); setOpen(false); };

  return (
    <div className="relative">
      <label className="relative flex items-center">
        <Search className="absolute left-2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" aria-hidden="true" />
        <input
          type="text" role="combobox" aria-label={LABEL[segment]} aria-expanded={open && results.length > 0}
          aria-controls={listId} aria-autocomplete="list" autoComplete="off" spellCheck={false}
          value={text} placeholder={active ? active.symbol : LABEL[segment]}
          onChange={e => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}  // lets a click on a result land first
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(results.length - 1, h + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
            else if (e.key === 'Enter' && text.trim() && results[hi]) { e.preventDefault(); pick(results[hi]); }
            else if (e.key === 'Escape') { setOpen(false); setText(''); }
          }}
          className="h-7 w-40 rounded-md border border-zinc-700 bg-zinc-900 pl-7 pr-2 text-xs font-semibold text-zinc-100 placeholder:text-zinc-200 placeholder:font-semibold focus:placeholder:text-zinc-500"
        />
      </label>
      {open && text.trim() && (
        <ul id={listId} role="listbox" aria-label="Search results"
            className="absolute left-0 top-8 z-50 w-72 max-h-72 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
          {error && <li className="px-3 py-2 text-xs text-red-400">{error}</li>}
          {!error && results.length === 0 && <li className="px-3 py-2 text-xs text-zinc-400">No match</li>}
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.symbol}`} role="option" aria-selected={i === hi}
                onMouseDown={e => { e.preventDefault(); pick(r); }} onMouseEnter={() => setHi(i)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer ${i === hi ? 'bg-zinc-800' : ''}`}>
              <span className="font-mono font-bold text-zinc-100 shrink-0">{r.symbol}</span>
              <span className="truncate text-zinc-400">{r.name}</span>
              <span className="ml-auto shrink-0 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{TAG[r.kind]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
