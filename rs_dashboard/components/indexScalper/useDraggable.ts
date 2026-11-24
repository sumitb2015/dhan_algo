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
