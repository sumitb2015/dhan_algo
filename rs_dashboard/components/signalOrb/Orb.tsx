'use client';

import { useEffect, useRef, useState } from 'react';
import type { IndicatorReading, Signal } from '@/lib/signalOrb';
import { cn } from '@/lib/utils';

// The Signal Orb: a futuristic quantum HUD sphere with holographic telemetry rings,
// multi-layer caustics, dynamic ambient aura, rotating compass reticles, and cybernetic indicator satellites.
// Built with GPU-accelerated transforms, pure CSS glassmorphism, and theme-safe CSS variables.

const PALETTE: Record<Signal, { c: string; hi: string; deep: string; glow: string; label: string }> = {
  BULL: {
    c: 'var(--color-emerald-500)',
    hi: 'var(--color-emerald-300)',
    deep: 'var(--color-emerald-950)',
    glow: 'rgba(16, 185, 129, 0.45)',
    label: 'BULLISH',
  },
  BEAR: {
    c: 'var(--color-red-500)',
    hi: 'var(--color-red-300)',
    deep: 'var(--color-red-950)',
    glow: 'rgba(239, 68, 68, 0.45)',
    label: 'BEARISH',
  },
  NEUTRAL: {
    c: 'var(--color-sky-500)',
    hi: 'var(--color-sky-300)',
    deep: 'var(--color-slate-950)',
    glow: 'rgba(56, 189, 248, 0.35)',
    label: 'NEUTRAL',
  },
};

const VOTE_COLOR = {
  1: 'var(--color-emerald-400)',
  [-1]: 'var(--color-red-400)',
  0: 'var(--color-slate-400)',
} as const;

const STYLE = `
@keyframes orbBreathe {
  0%, 100% { transform: scale(0.95); opacity: 0.55; }
  50% { transform: scale(1.12); opacity: 0.9; }
}
@keyframes orbSpinSlow {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes orbSpinReverse {
  from { transform: rotate(360deg); }
  to { transform: rotate(0deg); }
}
@keyframes orbFloat {
  0%, 100% { transform: translateY(0px) scale(1); }
  50% { transform: translateY(-5px) scale(1.01); }
}
@keyframes orbRippleShock {
  0% { transform: scale(0.9); opacity: 0.85; border-width: 3px; }
  100% { transform: scale(2.2); opacity: 0; border-width: 0.5px; }
}
@keyframes orbRadarSweep {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes orbGlitchPulse {
  0%, 100% { opacity: 0.95; }
  50% { opacity: 0.75; }
}
.orb-breathe { animation: orbBreathe 4.2s ease-in-out infinite; }
.orb-spin-slow { animation: orbSpinSlow 48s linear infinite; }
.orb-spin-reverse { animation: orbSpinReverse 68s linear infinite; }
.orb-float { animation: orbFloat 5.5s ease-in-out infinite; }
.orb-ripple { animation: orbRippleShock 1.8s cubic-bezier(0.1, 0.8, 0.2, 1) forwards; }
.orb-sweep { animation: orbRadarSweep 12s linear infinite; transform-origin: 50% 50%; }
.orb-pulse { animation: orbGlitchPulse 2.8s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .orb-breathe, .orb-spin-slow, .orb-spin-reverse, .orb-float, .orb-ripple, .orb-sweep, .orb-pulse { animation: none; }
}
`;

export function Orb({ signal, readings, positionLabel, busy, since, progress, secsLeft }: {
  signal: Signal;
  since: string | null;
  progress: number;
  secsLeft: number;
  readings: IndicatorReading[];
  positionLabel: string;
  busy: boolean;
}) {
  const p = PALETTE[signal];
  const [ripples, setRipples] = useState<number[]>([]);
  const prev = useRef<Signal | null>(null);

  useEffect(() => {
    if (prev.current !== null && prev.current !== signal) {
      const id = Date.now();
      setRipples(r => [...r.slice(-2), id]);
      const t = setTimeout(() => setRipples(r => r.filter(x => x !== id)), 1900);
      prev.current = signal;
      return () => clearTimeout(t);
    }
    prev.current = signal;
  }, [signal]);

  const n = readings.length;
  const progressPct = Math.min(100, Math.max(0, progress * 100));
  const dashOffset = (100 - progressPct).toFixed(2);

  return (
    <div
      className="relative aspect-square w-[min(78vw,48vh,420px)] min-w-[240px] select-none"
      style={{
        ['--orb-c' as string]: p.c,
        ['--orb-hi' as string]: p.hi,
        ['--orb-deep' as string]: p.deep,
        ['--orb-glow' as string]: p.glow,
      }}
      role="img"
      aria-label={`Signal ${p.label}. Position ${positionLabel}.${readings.map(r => ` ${r.label} ${r.vote === 1 ? 'bullish' : r.vote === -1 ? 'bearish' : 'neutral'}.`).join('')}`}
    >
      <style>{STYLE}</style>

      {/* Atmospheric Nebula Aura */}
      <div
        className="orb-breathe pointer-events-none absolute inset-[-12%] rounded-full blur-3xl transition-colors duration-1000"
        style={{ background: 'radial-gradient(circle, var(--orb-glow) 0%, transparent 68%)' }}
      />
      <div
        className="pointer-events-none absolute inset-[5%] rounded-full blur-xl opacity-40 transition-colors duration-1000"
        style={{ background: 'radial-gradient(circle, var(--orb-hi) 10%, transparent 60%)' }}
      />

      {/* Polar Coordinate HUD Reticle */}
      <svg viewBox="-120 -120 240 240" className="pointer-events-none absolute left-1/2 top-1/2 h-[270%] w-[270%] -translate-x-1/2 -translate-y-1/2 text-zinc-800/80" aria-hidden>
        {/* Concentric rings */}
        {[58, 76, 96, 114].map((r, i) => (
          <circle
            key={r}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={i === 2 ? '0.28' : '0.15'}
            strokeDasharray={i === 1 ? '3 5' : i === 3 ? '1 4' : undefined}
            strokeOpacity={0.65}
          />
        ))}

        {/* Tactical Crosshairs & Spoke Marks */}
        {SPOKES.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="0.16" strokeOpacity={0.7} />
        ))}

        {/* Cardinal Axis Markers */}
        <line x1="-116" y1="0" x2="-108" y2="0" stroke="var(--orb-hi)" strokeWidth="0.6" strokeOpacity={0.5} />
        <line x1="108" y1="0" x2="116" y2="0" stroke="var(--orb-hi)" strokeWidth="0.6" strokeOpacity={0.5} />
        <line x1="0" y1="-116" x2="0" y2="-108" stroke="var(--orb-hi)" strokeWidth="0.6" strokeOpacity={0.5} />
        <line x1="0" y1="108" x2="0" y2="116" stroke="var(--orb-hi)" strokeWidth="0.6" strokeOpacity={0.5} />
      </svg>

      {/* Outer Tactical Gyro Ring (Slow Spin) */}
      <svg viewBox="0 0 100 100" className="orb-spin-slow pointer-events-none absolute inset-[-2%] h-[104%] w-[104%]" aria-hidden>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-c)" strokeOpacity="0.32" strokeWidth="0.35" strokeDasharray="1 3" />
        {/* Corner-style brackets along orbit */}
        <path d="M50 1 A49 49 0 0 1 78 9" fill="none" stroke="var(--orb-hi)" strokeOpacity="0.8" strokeWidth="0.75" strokeLinecap="round" />
        <path d="M50 99 A49 49 0 0 1 22 91" fill="none" stroke="var(--orb-hi)" strokeOpacity="0.8" strokeWidth="0.75" strokeLinecap="round" />
        <circle cx="50" cy="1" r="0.9" fill="var(--orb-hi)" />
        <circle cx="50" cy="99" r="0.9" fill="var(--orb-hi)" />
      </svg>

      {/* Counter-Rotating Cyber Ring */}
      <svg viewBox="0 0 100 100" className="orb-spin-reverse pointer-events-none absolute inset-[6%] h-[88%] w-[88%]" aria-hidden>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--orb-c)" strokeOpacity="0.25" strokeWidth="0.4" strokeDasharray="16 8 3 8" />
        <path d="M99 50 A49 49 0 0 1 93 72" fill="none" stroke="var(--orb-hi)" strokeOpacity="0.7" strokeWidth="0.6" strokeLinecap="round" />
      </svg>

      {/* Precision Bar-Countdown Gauge (Segmented Cyber Ring) */}
      <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-[12%] h-[76%] w-[76%] -rotate-90" aria-hidden>
        {/* Track */}
        <circle cx="50" cy="50" r="48" fill="none" stroke="var(--orb-c)" strokeOpacity="0.15" strokeWidth="1.2" />
        {/* Active Progress Arc */}
        <circle
          cx="50"
          cy="50"
          r="48"
          fill="none"
          stroke="var(--orb-hi)"
          strokeOpacity="0.9"
          strokeWidth="1.4"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="100 100"
          strokeDashoffset={dashOffset}
          className={progress > 0.04 ? 'transition-[stroke-dashoffset] duration-1000 ease-linear' : undefined}
          style={{ filter: 'drop-shadow(0 0 4px var(--orb-hi))' }}
        />
      </svg>

      {/* Ripple Wave on Signal Change */}
      {ripples.map(id => (
        <div
          key={id}
          className="orb-ripple pointer-events-none absolute inset-[17%] rounded-full border-2"
          style={{ borderColor: 'var(--orb-hi)', boxShadow: '0 0 25px var(--orb-c)' }}
        />
      ))}

      {/* Floating Holographic Core Sphere */}
      <div className="orb-float absolute inset-[17%]">
        <div
          className="relative h-full w-full rounded-full transition-all duration-700 overflow-hidden"
          style={{
            background: 'radial-gradient(circle at 35% 26%, var(--orb-hi) 0%, var(--orb-c) 35%, var(--orb-deep) 85%)',
            boxShadow: `
              0 0 70px -5px var(--orb-glow),
              inset 0 -22px 45px -10px rgba(0, 0, 0, 0.85),
              inset 0 12px 35px -8px var(--orb-hi),
              0 0 0 1px rgba(255, 255, 255, 0.12)
            `,
          }}
        >
          {/* Specular Curved Reflection (Caustic Glass Highlight) */}
          <div className="pointer-events-none absolute left-[15%] top-[8%] h-[32%] w-[50%] -rotate-[22deg] rounded-full bg-gradient-to-b from-white/30 via-white/10 to-transparent blur-[2px]" />

          {/* Cybernetic Scanlines / Grid Texture Inside the Orb */}
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.08] mix-blend-overlay"
            style={{
              backgroundImage: 'repeating-linear-gradient(0deg, #fff 0, #fff 1px, transparent 1px, transparent 4px)',
            }}
          />

          {/* Internal Energy Center: Pulsing Core */}
          <div
            className="orb-pulse pointer-events-none absolute inset-[25%] rounded-full blur-md opacity-40"
            style={{ background: 'radial-gradient(circle, var(--orb-hi) 0%, transparent 70%)' }}
          />

          {/* Center Holographic Telemetry & Signal Display */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-oncolor select-none px-4">
            {/* Top Micro-HUD Tag */}
            <div className="flex items-center gap-1.5 opacity-90">
              <span className="h-1 w-1 rounded-full bg-white animate-ping" />
              <span className="font-mono text-[9px] font-black uppercase tracking-[0.45em] drop-shadow-sm text-zinc-100">
                AI CONSENSUS
              </span>
            </div>

            {/* Hero Signal Text with Intense Neon Glow */}
            <div className="relative mt-1 text-center">
              <span
                className={cn(
                  'block font-black leading-none tracking-[0.08em] transition-all duration-500',
                  signal === 'NEUTRAL' ? 'text-3xl sm:text-4xl' : 'text-5xl sm:text-6xl',
                )}
                style={{
                  textShadow: `
                    0 0 20px var(--orb-hi),
                    0 0 45px var(--orb-c),
                    0 2px 4px rgba(0, 0, 0, 0.8)
                  `,
                }}
              >
                {signal}
              </span>
            </div>

            {/* Timestamp Subtitle */}
            <div className="mt-2 flex items-center gap-1.5 font-mono text-[10px] font-semibold tracking-widest text-zinc-200/90 drop-shadow">
              {since ? <span>SINCE {since}</span> : <span className="opacity-60">SCANNING BARS</span>}
            </div>

            {/* Futuristic Segmented Countdown Capsule */}
            <div
              className="mt-3 flex items-center gap-1.5 rounded-full border border-white/20 bg-black/45 px-3 py-0.5 font-mono text-[11px] font-bold backdrop-blur-md shadow-[0_2px_10px_rgba(0,0,0,0.5)]"
              title="Time until current bar closes and signal recalculates"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="tabular-nums tracking-wider text-zinc-100">
                {busy ? 'SYNCHRONIZING' : `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Orbiting Telemetry Satellites (One per Indicator) */}
      {readings.map((r, i) => {
        const angle = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2 - (n > 1 ? Math.PI / n : 0);
        const x = (50 + 46.5 * Math.cos(angle)).toFixed(2);
        const y = (50 + 46.5 * Math.sin(angle)).toFixed(2);
        const col = VOTE_COLOR[r.vote];

        return (
          <div
            key={r.id}
            title={`${r.label}: ${r.value} (${r.vote === 1 ? 'Bullish' : r.vote === -1 ? 'Bearish' : 'Neutral'})`}
            aria-hidden
            className="absolute -translate-x-1/2 -translate-y-1/2 group cursor-pointer"
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            {/* Outer radar pulse aura */}
            <span
              className="absolute -inset-1 rounded-full opacity-60 animate-ping"
              style={{ background: col }}
            />
            {/* Satellite Core Node */}
            <span
              className="relative flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/40 shadow-lg transition-transform group-hover:scale-125"
              style={{
                background: col,
                boxShadow: `0 0 16px 3px ${col}`,
              }}
            >
              <span className="h-1 w-1 rounded-full bg-white" />
            </span>

            {/* Hover Tooltip Capsule */}
            <div className="pointer-events-none absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-950/90 px-2 py-0.5 font-mono text-[9px] font-bold text-zinc-200 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 z-30">
              {r.label} · {r.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Twelve spokes from r=62 to r=112 in the polar field. */
const SPOKES: [string, string, string, string][] = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
  const f = (v: number) => v.toFixed(2);
  return [f(62 * Math.cos(a)), f(62 * Math.sin(a)), f(112 * Math.cos(a)), f(112 * Math.sin(a))];
});
