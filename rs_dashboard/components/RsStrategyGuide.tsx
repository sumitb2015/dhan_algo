'use client';

import { useMemo } from 'react';
import { BookOpen } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { parseMarkdown, type Block, type Inline } from '@/lib/miniMarkdown';

// Side panel that renders docs/RS_STRATEGY_GUIDE.md (read on the server and passed in as text), so
// the in-app guide and the repo doc are one source. Theme tokens only, no hardcoded colours.

function Inl({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.t === 'b' ? <strong key={i} className="font-bold text-zinc-100">{p.v}</strong>
        : p.t === 'i' ? <em key={i} className="text-zinc-300">{p.v}</em>
        : p.t === 'code' ? <code key={i} className="px-1 py-0.5 rounded bg-zinc-800 text-[11px] font-mono text-zinc-200">{p.v}</code>
        : <span key={i}>{p.v}</span>,
      )}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'h':
      return b.level === 2
        ? <h3 className="mt-6 mb-2 text-sm font-bold text-white"><Inl parts={b.inline} /></h3>
        : b.level === 3
          ? <h4 className="mt-4 mb-1.5 text-xs font-bold text-zinc-100"><Inl parts={b.inline} /></h4>
          : null; // the page title lives in the panel header
    case 'p':
      return <p className="my-2 text-xs leading-relaxed text-zinc-300"><Inl parts={b.inline} /></p>;
    case 'quote':
      return <p className="my-3 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-xs leading-relaxed text-zinc-200"><Inl parts={b.inline} /></p>;
    case 'ul':
      return (
        <ul className="my-2 ml-4 list-disc space-y-1 text-xs leading-relaxed text-zinc-300 marker:text-zinc-500">
          {b.items.map((it, i) => <li key={i}><Inl parts={it} /></li>)}
        </ul>
      );
    case 'hr':
      return <hr className="my-4 border-zinc-800" />;
    case 'table':
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-[11px] leading-snug">
            <thead className="bg-zinc-800 text-xs font-bold text-white">
              <tr>{b.head.map((c, i) => <th key={i} className="px-3 py-2 align-bottom"><Inl parts={c} /></th>)}</tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80 bg-zinc-950/60">
              {b.rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className={`px-3 py-2 align-top ${j === 0 ? 'text-zinc-100' : 'text-zinc-300'}`}><Inl parts={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default function RsStrategyGuide({ open, onClose, markdown }: { open: boolean; onClose: () => void; markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[720px] sm:max-w-[720px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0"
      >
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg border bg-emerald-500/10 border-emerald-500/25">
              <BookOpen className="w-4 h-4 text-emerald-400" aria-hidden="true" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">RS Strategy guide</SheetTitle>
              <SheetDescription className="text-[10px] text-zinc-500">How the page works and what every column means</SheetDescription>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close guide"
            className="shrink-0 px-2 py-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
          >×</button>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-8 pt-1">
          {blocks.map((b, i) => <BlockView key={i} b={b} />)}
        </div>
      </SheetContent>
    </Sheet>
  );
}
