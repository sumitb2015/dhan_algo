// Shared chart furniture for the GEX pages: the call/put wall pill drawn above a wall's reference line.
import React from 'react';

export type WallSide = 'call' | 'put';

/** Saturated data colours (same hues as the call/put bars), as theme variables so they follow the active palette. */
export const WALL_TONE: Record<WallSide, string> = {
  call: 'var(--color-red-400)',
  put: 'var(--color-emerald-400)',
};

interface PillProps {
  viewBox?: { x: number; y: number; width: number; height: number };
  side: WallSide;
  text: string;
}

/**
 * Label for a wall's ReferenceLine. Sits in the chart's top margin: the call-wall pill extends to the right of its line and
 * the put-wall pill to the left, so the two never collide with each other or with the centred SPOT label below them.
 */
export function WallPill({ viewBox, side, text }: PillProps) {
  if (!viewBox || !Number.isFinite(viewBox.x) || !Number.isFinite(viewBox.y)) return null;
  const w = text.length * 5.8 + 18;
  const h = 16;
  const x0 = side === 'call' ? viewBox.x : viewBox.x - w;
  const y0 = viewBox.y - 36;
  const tone = WALL_TONE[side];
  return (
    <g pointerEvents="none">
      <rect x={x0} y={y0} width={w} height={h} rx={4} fill="var(--color-zinc-900)" stroke={tone} strokeWidth={1} />
      <circle cx={x0 + 8} cy={y0 + h / 2} r={2.5} fill={tone} />
      <text x={x0 + 15} y={y0 + h / 2 + 3} fontSize={9} fontWeight={700} fontFamily="var(--font-mono)" fill={tone}>{text}</text>
    </g>
  );
}
