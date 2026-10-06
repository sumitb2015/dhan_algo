'use client';

import { useMemo, type ReactNode } from 'react';
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

export default function RsStrategyGuide({
  open, onClose, markdown,
  title = 'RS Strategy Guide',
  description = 'Complete strategy rules, indicators, signal states, and order mechanics',
  summary,
}: {
  open: boolean; onClose: () => void; markdown: string;
  title?: string; description?: string;
  /** Replaces the default RS Strategy signals callout. Pass `null` for no callout. */
  summary?: ReactNode | null;
}) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full data-[side=right]:w-full sm:max-w-none data-[side=right]:sm:max-w-none max-w-none inset-x-0 data-[side=right]:inset-x-0 p-0 flex flex-col bg-zinc-950 border-0 gap-0 shadow-2xl"
      >
        <SheetHeader className="flex-none px-6 lg:px-10 py-4 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
          <div className="max-w-6xl mx-auto w-full flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg border bg-emerald-500/10 border-emerald-500/25">
                <BookOpen className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              </div>
              <div>
                <SheetTitle className="text-base font-bold text-white">{title}</SheetTitle>
                <SheetDescription className="text-xs text-zinc-400">{description}</SheetDescription>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close guide"
              className="px-3 py-1.5 rounded-lg text-sm font-bold text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 flex items-center gap-1.5"
            >
              <span>Close</span>
              <span className="text-base leading-none">×</span>
            </button>
          </div>
        </SheetHeader>

        {summary === undefined ? (
        <div className="flex-none px-6 lg:px-10 py-3.5 border-b border-zinc-800 bg-zinc-900/60 text-xs text-zinc-300 leading-relaxed">
          <div className="max-w-6xl mx-auto w-full space-y-1.5">
            <div className="text-[10px] uppercase font-bold text-zinc-400 tracking-wider">Strategy Signals Summary</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
              <div>
                <strong className="text-emerald-400 font-bold">Buy</strong>: when RS is above zero, price is above the Supertrend, RSI(14) is above 50 and price is above the 200 EMA (entry only).
              </div>
              <div>
                <strong className="text-sky-400 font-bold">In Trend</strong>: while a buy has weakened but not yet turned negative on both.
              </div>
              <div>
                <strong className="text-red-400 font-bold">Sell</strong>: only when RS is below zero and price is below the Supertrend.
              </div>
              <div>
                <strong className="text-zinc-200 font-bold">Wait</strong>: means no buy yet.
              </div>
            </div>
            <div className="text-[11px] font-mono text-zinc-400 pt-0.5">
              Signals use the latest daily close.
            </div>
          </div>
        </div>

        ) : summary}

        <div className="flex-1 min-h-0 overflow-y-auto px-6 lg:px-10 pb-12 pt-3">
          <div className="max-w-6xl mx-auto w-full">
            {blocks.map((b, i) => <BlockView key={i} b={b} />)}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
