'use client';

import { useCallback, useRef, useState } from 'react';

/** Drag a floating panel by its header. Position is kept inside the viewport; it is not persisted. */
export function useDraggable(initial: { x: number; y: number }) {
  const [pos, setPos] = useState(initial);
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const x = Math.min(Math.max(0, s.x + e.clientX - s.px), Math.max(0, window.innerWidth - 120));
    const y = Math.min(Math.max(0, s.y + e.clientY - s.py), Math.max(0, window.innerHeight - 60));
    setPos({ x, y });
  }, []);

  const onPointerUp = useCallback(() => { start.current = null; }, []);

  return { pos, handle: { onPointerDown, onPointerMove, onPointerUp } };
}

// The terminal's header grows to two rows on a laptop width, so a fixed top would cover its right-hand controls
// (fullscreen, nav, the SIM / REAL switch): open just under whatever height it has now (and under its status banner).
export function belowHeaderY(): number {
  if (typeof document === 'undefined') return 65;
  const h = document.querySelector('[data-testid="index-scalper"] > div');
  if (!h) return 65;
  // the status banner (market closed / stale ticks) sits right under the header: start below it too
  const banner = h.nextElementSibling?.getAttribute('role') === 'alert' ? h.nextElementSibling : null;
  return Math.round((banner ?? h).getBoundingClientRect().bottom) + 8;
}


/** Left edge for a 360px market-watch window opened at the top middle of the page: the pair sits side by side on the centre
 *  line (Indices just left of it, Top 10 just right), so each is top-middle alone and they never overlap when both are open.
 *  Kept clear of the left sidebar (64) and inside the viewport. */
export function topMiddleX(side: 'left' | 'right', width = 360, gap = 12): number {
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const x = side === 'left' ? vw / 2 - gap / 2 - width : vw / 2 + gap / 2;
  return Math.round(Math.min(Math.max(64, x), Math.max(64, vw - width - 8)));
}
