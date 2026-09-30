'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { FOCUS_RING } from '@/components/optionsScreener/format';

/** Inline markdown: **bold**, *italic*, `code`. Enough for the per-page app/<page>/README.md guides. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i} className="font-semibold text-zinc-100">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={i} className="font-mono text-[11px] px-1 rounded bg-zinc-800 text-zinc-200">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Block markdown: #/## headings, "- " bullets, "> " callouts, paragraphs. */
function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (!bullets.length) return;
    out.push(
      <ul key={`ul-${out.length}`} className="list-disc pl-5 flex flex-col gap-1 text-xs text-zinc-300">
        {bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('- ')) { bullets.push(line.slice(2)); continue; }
    flush();
    if (!line || line.startsWith('# ')) continue; // the title is the modal header
    if (line.startsWith('## ')) {
      out.push(<h3 key={out.length} className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-300 mt-2">{inline(line.slice(3))}</h3>);
    } else if (line.startsWith('> ')) {
      out.push(<p key={out.length} className="text-xs text-amber-200 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10">{inline(line.slice(2))}</p>);
    } else {
      out.push(<p key={out.length} className="text-xs text-zinc-300">{inline(line)}</p>);
    }
  }
  flush();
  return out;
}

export default function HelpModal({ title, markdown, onClose }: { title: string; markdown: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label={title}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-900">
          <h2 className="text-sm font-bold text-white">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close help"
            className={`p-1 rounded text-zinc-400 hover:text-zinc-100 ${FOCUS_RING}`}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 flex flex-col gap-2.5">
          {markdown ? renderMarkdown(markdown) : <p className="text-xs text-zinc-400">Help file not found.</p>}
        </div>
      </div>
    </div>
  );
}
