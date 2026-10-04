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
        return <strong key={idx} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={idx} className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-xs text-sky-300">
            {part.slice(1, -1)}
          </code>
        );
      }
      return <React.Fragment key={idx}>{part}</React.Fragment>;
    });
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++; // skip opening ```
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-900/90 p-3.5 font-mono text-xs sm:text-[13px] text-zinc-200 shadow-inner">
          <pre className="leading-relaxed">{codeLines.join('\n')}</pre>
        </div>
      );
      continue;
    }

    if (line.startsWith('## ')) {
      blocks.push(
        <h3 key={key++} className="text-xs sm:text-sm font-bold uppercase tracking-wider text-amber-400 mt-6 mb-2.5 first:mt-0 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
          {line.slice(3)}
        </h3>
      );
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(
        <h2 key={key++} className="text-base sm:text-lg font-bold text-white mt-5 mb-2 pb-1 border-b border-zinc-800">
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
        <ul key={key++} className="flex flex-col gap-2.5 mt-2">
          {items.map((it, idx) => (
            <li key={idx} className="flex items-start gap-2.5 text-sm sm:text-[15px] leading-relaxed text-zinc-200">
              <span className="text-amber-400/80 shrink-0 font-bold select-none">•</span>
              <span className="flex-1">{renderInline(it)}</span>
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
        <ol key={key++} className="flex flex-col gap-2.5 mt-2">
          {items.map((it, idx) => (
            <li key={idx} className="flex items-start gap-2.5 text-sm sm:text-[15px] leading-relaxed text-zinc-200">
              <span className="text-zinc-400 shrink-0 font-mono font-medium select-none">{idx + 1}.</span>
              <span className="flex-1">{renderInline(it)}</span>
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
      <p key={key++} className="text-sm sm:text-[15px] leading-relaxed text-zinc-200 mt-2">
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-oncolor-dark/70 p-4 sm:p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="my-6 sm:my-8 w-full max-w-4xl xl:max-w-5xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-zinc-800 bg-zinc-950/95 px-6 py-4 rounded-t-lg backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-amber-500/10 p-2 text-amber-400 border border-amber-500/20">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white">{name}</h2>
              <p className="mt-0.5 font-mono text-xs text-zinc-400">
                Strategy Documentation &amp; Execution Specification
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 py-6 sm:px-8 sm:py-7 max-h-[calc(88vh-80px)] overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-zinc-400 text-sm font-mono py-12 justify-center">
              <RefreshCw className="h-4 w-4 animate-spin text-amber-400" />
              Loading strategy documentation…
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-amber-300 text-sm font-mono py-12 justify-center">
              <AlertTriangle className="h-4 w-4" />
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
