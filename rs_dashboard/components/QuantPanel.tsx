// Shared building blocks for "quant-terminal" chart pages (see the
// dhan-quant-terminal-page skill): the ribbon stat and the chart-panel header.
//
// These were copy-pasted per page and had drifted (hex colour support in one,
// a tooltip in another, ReactNode vs string props). One definition here — add
// a prop rather than forking a new copy. The icon/badge "stat tile" used by
// Movers/Seasonality/matrix pages is a different component, not this one.

import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import AnimatedNumber from './AnimatedNumber';

function withTip(el: React.ReactElement, tip?: string) {
  if (!tip) return el;
  return (
    <Tooltip>
      <TooltipTrigger render={el} />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Label / big number / optional sub-line.
 * `color` is a Tailwind text class, or a hex series colour (e.g. the CE/PE
 * colours on IV Charts) applied inline. `animate` tweens between live values
 * (falls back to `value` when unset).
 */
export function PulseStat({
  label, value, animate, sub, color = 'text-white', size = 'text-lg', tip,
}: {
  label: string;
  value: React.ReactNode;
  animate?: { raw: number; format: (v: number) => string };
  sub?: React.ReactNode;
  color?: string;
  size?: string;
  tip?: string;
}) {
  const isHex = color.startsWith('#');
  return (
    <div className="flex flex-col min-w-0">
      {withTip(
        <span className={`text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5 ${tip ? 'cursor-help' : ''}`}>{label}</span>,
        tip,
      )}
      <span
        className={`${size} font-mono font-bold tabular-nums leading-none ${isHex ? '' : color}`}
        style={isHex ? { color } : undefined}
      >
        {animate ? <AnimatedNumber value={animate.raw} format={animate.format} /> : value}
      </span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

/** Eyebrow / title / sub-line on the left, legend on the right. */
export function ChartHeader({
  eyebrow, title, sub, legend, tip,
}: {
  eyebrow: string;
  title: string;
  sub: React.ReactNode;
  legend?: React.ReactNode;
  tip?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        {withTip(
          <p className={`text-sm font-bold text-white tracking-tight ${tip ? 'cursor-help' : ''}`}>{title}</p>,
          tip,
        )}
        <p className="text-[10px] text-zinc-500 mt-0.5 max-w-xl">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold flex-wrap">{legend}</div>}
    </div>
  );
}
