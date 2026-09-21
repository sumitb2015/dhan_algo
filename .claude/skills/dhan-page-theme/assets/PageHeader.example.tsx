'use client';

/**
 * Reference implementation of the dhan-page-theme standard header. NOT wired into the app: no
 * shared PageHeader exists yet, so today each page inlines this markup. Copy it, or if you are
 * touching three or more pages, promote it to components/PageHeader.tsx in the same change.
 *
 *   <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
 *     <PageHeader icon={Activity} accent="emerald" eyebrow="Options · NIFTY" title="IV Charts"
 *                 subtitle="Implied volatility history and skew" dataDate={data?.dataDate}>
 *       {selectors, refresh}
 *     </PageHeader>
 *     <div className="flex-1 flex flex-col gap-4 px-6 py-5">{body}</div>
 *   </div>
 *
 * Tailwind only generates class names it can read literally, so accents are looked up in ACCENT
 * below. Never build them with `bg-${accent}-500/10`: it renders unstyled in production.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import NavBar from '@/components/NavBar';

export type Accent = 'emerald' | 'sky' | 'amber' | 'indigo' | 'violet' | 'purple' | 'blue';

// Accent text uses -400 (a themed step); -500 does not flip between dark and white mode.
const ACCENT: Record<Accent, { tile: string; icon: string; eyebrow: string }> = {
  emerald: { tile: 'bg-emerald-500/10 border-emerald-500/25', icon: 'text-emerald-400', eyebrow: 'text-emerald-400' },
  sky:     { tile: 'bg-sky-500/10 border-sky-500/25',         icon: 'text-sky-400',     eyebrow: 'text-sky-400' },
  amber:   { tile: 'bg-amber-500/10 border-amber-500/25',     icon: 'text-amber-400',   eyebrow: 'text-amber-400' },
  indigo:  { tile: 'bg-indigo-500/10 border-indigo-500/25',   icon: 'text-indigo-400',  eyebrow: 'text-indigo-400' },
  violet:  { tile: 'bg-violet-500/10 border-violet-500/25',   icon: 'text-violet-400',  eyebrow: 'text-violet-400' },
  purple:  { tile: 'bg-purple-500/10 border-purple-500/25',   icon: 'text-purple-400',  eyebrow: 'text-purple-400' },
  blue:    { tile: 'bg-blue-500/10 border-blue-500/25',       icon: 'text-blue-400',    eyebrow: 'text-blue-400' },
};

interface Props {
  icon: LucideIcon;
  accent?: Accent;
  /** "Domain · Scope", e.g. "Options · NIFTY". */
  eyebrow?: string;
  title: string;
  subtitle?: string;
  /** The data's own date (YYYY-MM-DD) from the payload, never `new Date()`. Omit on pages with no dated data. */
  dataDate?: string | null;
  /** True when dataDate is not today's session. */
  lastSession?: boolean;
  /** Page selectors, toggles and the refresh button; rendered before the DATA chip. */
  children?: ReactNode;
}

export default function PageHeader({
  icon: Icon, accent = 'emerald', eyebrow, title, subtitle, dataDate, lastSession, children,
}: Props) {
  const a = ACCENT[accent];
  return (
    <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className={`flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 ${a.tile}`}>
          <Icon className={`w-4 h-4 ${a.icon}`} aria-hidden="true" />
        </div>
        <div>
          {eyebrow && (
            <p className={`text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 ${a.eyebrow}`}>{eyebrow}</p>
          )}
          <h1 className="text-sm font-bold text-white tracking-tight leading-none">{title}</h1>
          {subtitle && <p className="text-[10px] text-zinc-500 font-medium mt-1">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {children}
        {dataDate !== undefined && (
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate || '—'}{lastSession ? ' · last session' : ''}
          </span>
        )}
        <span className="w-px h-5 bg-zinc-800 shrink-0" />
        <NavBar />
      </div>
    </div>
  );
}
