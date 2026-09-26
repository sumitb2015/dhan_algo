'use client';

import React from 'react';

export interface CockpitSpinnerProps {
  label?: string;
  sublabel?: string;
  color?: 'cyan' | 'blue' | 'violet' | 'amber' | 'emerald';
  size?: 'sm' | 'md' | 'lg';
}

const COLOR_MAP = {
  cyan: {
    ringTop: 'border-t-cyan-400 border-r-cyan-500/80',
    ringInner: 'border-b-blue-400',
    glowDot: 'bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]',
    text: 'text-cyan-400',
  },
  blue: {
    ringTop: 'border-t-blue-400 border-r-indigo-500',
    ringInner: 'border-b-cyan-400',
    glowDot: 'bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.8)]',
    text: 'text-blue-400',
  },
  violet: {
    ringTop: 'border-t-violet-400 border-r-purple-500',
    ringInner: 'border-b-fuchsia-400',
    glowDot: 'bg-violet-400 shadow-[0_0_10px_rgba(167,139,250,0.8)]',
    text: 'text-violet-400',
  },
  amber: {
    ringTop: 'border-t-amber-400 border-r-orange-500',
    ringInner: 'border-b-yellow-300',
    glowDot: 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)]',
    text: 'text-amber-400',
  },
  emerald: {
    ringTop: 'border-t-emerald-400 border-r-teal-500',
    ringInner: 'border-b-green-300',
    glowDot: 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]',
    text: 'text-emerald-400',
  },
};

export default function CockpitSpinner({
  label = 'Loading market data...',
  sublabel,
  color = 'cyan',
  size = 'md',
}: CockpitSpinnerProps) {
  const c = COLOR_MAP[color] ?? COLOR_MAP.cyan;

  const outerSize = size === 'sm' ? 'w-6 h-6' : size === 'lg' ? 'w-12 h-12' : 'w-9 h-9';
  const innerSize = size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-8 h-8' : 'w-6 h-6';
  const dotSize = size === 'sm' ? 'w-1 h-1' : size === 'lg' ? 'w-2 h-2' : 'w-1.5 h-1.5';

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 gap-2.5 animate-fadeIn">
      {/* Orbital Dual-Ring Radar */}
      <div className={`relative flex items-center justify-center ${outerSize}`}>
        {/* Outer subtle glow ring */}
        <div className="absolute inset-0 rounded-full border border-zinc-800/80 bg-zinc-950/60" />
        
        {/* Primary Forward Fast Spinning Segment */}
        <div
          className={`absolute inset-0 rounded-full border-2 border-transparent ${c.ringTop} animate-spin`}
          style={{ animationDuration: '0.9s' }}
        />

        {/* Secondary Reverse Counter-Spinning Ring */}
        <div
          className={`absolute ${innerSize} rounded-full border border-transparent ${c.ringInner} animate-spin`}
          style={{ animationDuration: '1.4s', animationDirection: 'reverse' }}
        />

        {/* Core Glowing Radar Pulse Dot */}
        <div className={`rounded-full ${dotSize} ${c.glowDot} animate-pulse`} />
      </div>

      {/* Modern HUD Typography */}
      <div className="flex flex-col items-center gap-0.5 text-center">
        <span className={`text-[10px] font-mono font-bold uppercase tracking-widest ${c.text} flex items-center gap-1.5`}>
          <span>{label}</span>
          <span className="inline-flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
        </span>
        {sublabel && (
          <span className="text-[9px] font-mono text-zinc-500 tracking-wider">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}
