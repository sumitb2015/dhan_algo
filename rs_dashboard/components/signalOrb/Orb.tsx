'use client';

import { useEffect, useRef, useState } from 'react';
import type { IndicatorReading, Signal } from '@/lib/signalOrb';

// The Signal Orb itself: a layered sphere that breathes in the signal's colour, a slow orbit ring, one satellite per active indicator
// lit in its own vote, and a single ripple each time the colour flips. Colours are theme/data tokens (emerald / red / slate — slate,
// not zinc, so the neutral sphere stays a dark glass with white text in the light and beige themes too). Animations are transform /
// opacity only and stop under prefers-reduced-motion.

const PALETTE: Record<Signal, { c: string; hi: string; deep: string; label: string }> = {
  BULL: { c: 'var(--color-emerald-500)', hi: 'var(--color-emerald-300)', deep: 'var(--color-emerald-950)', label: 'BULLISH' },
  BEAR: { c: 'var(--color-red-500)', hi: 'var(--color-red-300)', deep: 'var(--color-red-950)', label: 'BEARISH' },
  NEUTRAL: { c: 'var(--color-slate-500)', hi: 'var(--color-slate-300)', deep: 'var(--color-slate-900)', label: 'NEUTRAL' },
};
const VOTE_COLOR = { 1: 'var(--color-emerald-400)', [-1]: 'var(--color-red-400)', 0: 'var(--color-slate-500)' } as const;

const STYLE = `
@keyframes orbBreathe { 0%,100% { transform: scale(0.94); opacity: .45 } 50% { transform: scale(1.08); opacity: .8 } }
@keyframes orbSpin { to { transform: rotate(360deg) } }
@keyframes orbSpinBack { to { transform: rotate(-360deg) } }
@keyframes orbFloat { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes orbRipple { from { transform: scale(1); opacity: .7 } to { transform: scale(1.9); opacity: 0 } }
@keyframes orbPulseDot { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(1.35); opacity: .7 } }
.orb-breathe { animation: orbBreathe 4.8s ease-in-out infinite }
.orb-spin { animation: orbSpin 38s linear infinite }
.orb-spin-back { animation: orbSpinBack 60s linear infinite }
.orb-float { animation: orbFloat 6s ease-in-out infinite }
.orb-ripple { animation: orbRipple 1.6s cubic-bezier(.2,.7,.3,1) forwards }
.orb-dot { animation: orbPulseDot 2.4s ease-in-out infinite }
@media (prefers-reduced-motion: reduce) {
  .orb-breathe, .orb-spin, .orb-spin-back, .orb-float, .orb-ripple, .orb-dot { animation: none }
}`;

export function Orb({ signal, readings, position, pnl, ltp, busy, since, progress, secsLeft }: {
  signal: Signal;
  /** IST HH:MM the current colour began, or null. */
  since: string | null;
  /** 0..1 of the current bar elapsed, and seconds until it closes (the next signal read). */
  progress: number;
  secsLeft: number;
  readings: IndicatorReading[];
  position: 'LONG' | 'SHORT' | 'FLAT' | 'PENDING';
  pnl: number | null;
  ltp: number | null;
  busy: boolean;
}) {
  const p = PALETTE[signal];
  // one ripple per colour change (not on first paint)
  const [ripples, setRipples] = useState<number[]>([]);
  const prev = useRef<Signal | null>(null);
  useEffect(() => {
    if (prev.current !== null && prev.current !== signal) {
      const id = Date.now();
      setRipples(r => [...r.slice(-2), id]);
      const t = setTimeout(() => setRipples(r => r.filter(x => x !== id)), 1700);
      prev.current = signal;
      return () => clearTimeout(t);
    }
    prev.current = signal;
  }, [signal]);

  const n = readings.length;
  return (
    <div
      className="relative aspect-square w-[min(74vw,54vh,420px)] min-w-[240px] select-none"
      style={{ ['--orb-c' as string]: p.c, ['--orb-hi' as string]: p.hi, ['--orb-deep' as string]: p.deep }}
      role="img"
      aria-label={`Signal ${p.label}. Position ${position}.${readings.map(r => ` ${r.label} ${r.vote === 1 ? 'bullish' : r.vote === -1 ? 'bearish' : 'neutral'}.`).join('')}`}
    >
      <style>{STYLE}</style>

      {/* polar field, centred on the orb (coordinates rounded: SSR and the client must print the same numbers) */}
      <svg viewBox="-100 -100 200 200" className="pointer-events-none absolute left-1/2 top-1/2 h-[260%] w-[260%] -translate-x-1/2 -translate-y-1/2 text-zinc-800" aria-hidden>
        {[62, 78, 96].map((r, i) => <circle key={r} r={r} fill="none" stroke="currentColor" strokeWidth=".18" strokeDasharray={i === 2 ? '.6 2.4' : undefined} />)}
        {SPOKES.map(([x1, y1, x2, y2], i) => <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth=".12" />)}
      </svg>

      {/* aura */}
      <div className="orb-breathe absolute inset-[4%] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, var(--orb-c) 0%, transparent 68%)' }} />

      {/* orbit rings */}
      <svg viewBox="0 0 100 100" className="orb-spin absolute inset-0 h-full w-full" aria-hidden>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-c)" strokeOpacity=".35" strokeWidth=".25" strokeDasharray=".6 2.2" />
        <path d="M50 1 A49 49 0 0 1 84.6 15.4" fill="none" stroke="var(--orb-hi)" strokeOpacity=".55" strokeWidth=".45" strokeLinecap="round" />
      </svg>
      <svg viewBox="0 0 100 100" className="orb-spin-back absolute inset-[9%] h-[82%] w-[82%]" aria-hidden>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-c)" strokeOpacity=".22" strokeWidth=".3" strokeDasharray="12 6 2 6" />
      </svg>

      {/* bar clock: a hairline that fills as the forming bar runs; the orb re-reads at its close */}
      <svg viewBox="0 0 100 100" className="absolute inset-[13%] h-[74%] w-[74%] -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-c)" strokeOpacity=".12" strokeWidth=".8" />
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-hi)" strokeOpacity=".75" strokeWidth=".8" strokeLinecap="round"
          pathLength={100} strokeDasharray="100 100" strokeDashoffset={(100 - Math.min(1, Math.max(0, progress)) * 100).toFixed(2)}
          className={progress > 0.04 ? 'transition-[stroke-dashoffset] duration-1000 ease-linear' : undefined} />
      </svg>

      {/* ripples on flip */}
      {ripples.map(id => (
        <div key={id} className="orb-ripple pointer-events-none absolute inset-[18%] rounded-full border-2" style={{ borderColor: 'var(--orb-c)' }} />
      ))}

      {/* sphere */}
      <div className="orb-float absolute inset-[18%]">
        <div className="relative h-full w-full rounded-full"
          style={{
            background: 'radial-gradient(circle at 34% 28%, var(--orb-hi) 0%, var(--orb-c) 34%, var(--orb-deep) 88%)',
            boxShadow: '0 0 60px -10px var(--orb-c), inset 0 -18px 40px -10px var(--orb-deep), inset 0 10px 30px -12px var(--orb-hi)',
          }}>
          {/* glass highlight */}
          <div className="absolute left-[20%] top-[10%] h-[22%] w-[40%] rotate-[-18deg] rounded-full bg-oncolor opacity-20 blur-md" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-oncolor">
            <span className="text-[10px] font-bold uppercase tracking-[0.5em] opacity-90">{p.label}</span>
            {since && <span className="font-mono text-[10px] font-semibold tracking-widest opacity-80">since {since}</span>}
            <span className="font-mono text-4xl font-black tracking-wider sm:text-5xl">{position}</span>
            {pnl !== null && (
              <span className="font-mono text-lg font-bold tabular-nums">
                {`${pnl >= 0 ? '+' : '−'}₹${Math.abs(pnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
              </span>
            )}
            <span className="mt-1 rounded-full bg-oncolor-dark/25 px-2.5 py-0.5 font-mono text-xs tabular-nums">
              {ltp === null ? 'no price' : `LTP ${ltp.toFixed(0)}`}
            </span>
            <span className="mt-0.5 font-mono text-[10px] tabular-nums opacity-80" title="Seconds until the bar closes and the signal is read again">
              {busy ? 'sending…' : `next read ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`}
            </span>
          </div>
        </div>
      </div>

      {/* satellites: one lit dot per indicator, on the outer orbit (the chips below carry names and values) */}
      {readings.map((r, i) => {
        const a = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2 - (n > 1 ? Math.PI / n : 0);
        const x = (50 + 46 * Math.cos(a)).toFixed(2), y = (50 + 46 * Math.sin(a)).toFixed(2);
        const col = VOTE_COLOR[r.vote];
        return (
          <span key={r.id} title={`${r.label}: ${r.value}`} aria-hidden
            className="orb-dot absolute block h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${x}%`, top: `${y}%`, background: col, boxShadow: `0 0 14px 2px ${col}` }} />
        );
      })}
    </div>
  );
}

/** Twelve spokes from r=62 to r=100 in the polar field, rounded to 2 dp once at module load. */
const SPOKES: [string, string, string, string][] = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
  const f = (v: number) => v.toFixed(2);
  return [f(62 * Math.cos(a)), f(62 * Math.sin(a)), f(100 * Math.cos(a)), f(100 * Math.sin(a))];
});
