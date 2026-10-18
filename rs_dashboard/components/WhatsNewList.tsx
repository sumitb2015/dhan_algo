'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { groupByDay, type NoteType, type ReleaseNote } from '@/lib/releaseNotes';

const TYPE_STYLE: Record<NoteType, { label: string; cls: string }> = {
  new: { label: 'NEW', cls: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400' },
  fix: { label: 'FIX', cls: 'bg-amber-500/10 border-amber-500/25 text-amber-400' },
  perf: { label: 'PERF', cls: 'bg-sky-500/10 border-sky-500/25 text-sky-400' },
};

function dayLabel(day: string): string {
  // `day` is the commit's calendar date; parse at noon UTC so no timezone shifts it.
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

interface WhatsNewListProps {
  notes: ReleaseNote[];
  /** Notes newer than this ISO date get an "unread" marker. */
  unreadAfter: string | null;
  onNavigate?: () => void;
}

export default function WhatsNewList({ notes, unreadAfter, onNavigate }: WhatsNewListProps) {
  const seenMs = unreadAfter ? Date.parse(unreadAfter) : Infinity;
  return (
    <div className="flex flex-col gap-5">
      {groupByDay(notes).map((group) => (
        <section key={group.day}>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500 mb-2">
            {dayLabel(group.day)}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {group.notes.map((n) => {
              const t = TYPE_STYLE[n.type];
              const unread = Date.parse(n.date) > seenMs;
              return (
                <li
                  key={n.hash}
                  className={cn(
                    'rounded-xl border px-3 py-2',
                    unread ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-900/60',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className={cn('mt-0.5 shrink-0 rounded-md border px-1.5 py-px text-[10px] font-bold', t.cls)}>
                      {t.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      {n.scope && (
                        <p className="text-[10px] font-medium text-zinc-500">{n.scope}</p>
                      )}
                      <p className="text-xs font-medium text-zinc-100 break-words">{n.subject}</p>
                      {n.detail && (
                        <p className="mt-1 whitespace-pre-line text-[11px] text-zinc-400 break-words">{n.detail}</p>
                      )}
                    </div>
                    {n.href && (
                      <Link
                        href={n.href}
                        onClick={onNavigate}
                        aria-label={`Open ${n.scope ?? 'page'}`}
                        className="shrink-0 flex items-center justify-center h-6 w-6 rounded-lg border border-zinc-700/60 text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors"
                      >
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
