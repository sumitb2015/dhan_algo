'use client';

import React, { useEffect, useState } from 'react';
import { X, BookOpen, RefreshCw, AlertTriangle } from 'lucide-react';

interface Props {
  strategyKey: string;
  fallbackName: string;
  onClose: () => void;
}

/**
 * Readme content is hand-written per strategy in strategies/<group>/readmes/<key>.md,
 * using only '#'/'##' headings, '-'/'1.' lists, `code`/**bold** inline spans and
 * blank-line paragraphs — this renderer intentionally supports just that subset
 * rather than pulling in a markdown dependency for content this codebase fully controls.
 */
function renderMarkdown(md: string): React.ReactNode {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const renderInline = (text: string): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, idx) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={idx} className="font-bold text-zinc-100">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={idx} className="rounded-sm bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-sky-300">
            {part.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      blocks.push(
        <h3 key={key++} className="text-[11px] font-bold uppercase tracking-wider text-amber-400 mt-5 first:mt-0">
          {line.slice(3)}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(
        <h2 key={key++} className="text-sm font-bold text-zinc-100 mt-2">
          {line.slice(2)}
        </h2>
      );
      i++;
      continue;
    }
    if (line.trim().startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push(
        <ul key={key++} className="flex flex-col gap-1.5 mt-1.5">
          {items.map((it, idx) => (
            <li key={idx} className="flex gap-2 text-[12px] leading-relaxed text-zinc-300">
              <span className="text-zinc-600 shrink-0">•</span>
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }
    if (/^\d+\.\s/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} className="flex flex-col gap-1.5 mt-1.5">
          {items.map((it, idx) => (
            <li key={idx} className="flex gap-2 text-[12px] leading-relaxed text-zinc-300">
              <span className="text-zinc-500 shrink-0 font-mono">{idx + 1}.</span>
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Paragraph: consume consecutive non-blank, non-heading, non-bullet, non-numbered lines.
    const paraLines: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') &&
      !lines[i].trim().startsWith('- ') && !/^\d+\.\s/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-[12px] leading-relaxed text-zinc-300 mt-1.5">
        {renderInline(paraLines.join(' '))}
      </p>
    );
  }

  return blocks;
}

export default function StrategyReadmeModal({ strategyKey, fallbackName, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(fallbackName);
  const [content, setContent] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/strategies/readme?key=${encodeURIComponent(strategyKey)}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.success) {
          setName(data.name || fallbackName);
          setContent(data.content || '');
        } else {
          setError(data.error || 'Failed to load readme.');
        }
      })
      .catch(() => { if (!cancelled) setError('Network error loading readme.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [strategyKey, fallbackName]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-oncolor-dark/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-2xl rounded-md border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3 rounded-t-md">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-amber-400" />
            <div>
              <h2 className="text-[15px] font-bold text-zinc-100">{name}</h2>
              <p className="mt-0.5 font-mono text-[11px] text-zinc-500">
                Strategy readme — entry, exit, target &amp; stop-loss rules
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-zinc-500 text-xs font-mono py-6 justify-center">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Loading readme…
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-amber-300 text-xs font-mono py-6 justify-center">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </div>
          ) : (
            <div className="flex flex-col">{renderMarkdown(content)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
