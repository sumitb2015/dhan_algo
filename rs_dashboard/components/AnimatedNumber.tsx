'use client';

import { useEffect, useRef, useState } from 'react';
import { animate, useMotionValue } from 'framer-motion';

/**
 * Smoothly counts from the previous value to a new one on change, and briefly
 * flashes emerald/red depending on direction — the standard "this just moved"
 * cue for a live-polling number. Shared across any page with ticking figures
 * (portfolio P&L, index LTPs, option premiums) rather than reimplemented per page.
 */
export default function AnimatedNumber({
  value,
  format,
}: {
  value: number;
  format: (v: number) => string;
}) {
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(() => format(value));
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevValue = useRef(value);
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prevValue.current === value) return;
    const direction = value > prevValue.current ? 'up' : 'down';
    prevValue.current = value;

    const controls = animate(motionValue, value, {
      duration: 0.6,
      ease: 'easeOut',
      onUpdate: latest => setDisplay(format(latest)),
    });

    setFlash(direction);
    if (flashTimeout.current) clearTimeout(flashTimeout.current);
    flashTimeout.current = setTimeout(() => setFlash(null), 600);

    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => () => {
    if (flashTimeout.current) clearTimeout(flashTimeout.current);
  }, []);

  const flashClass =
    flash === 'up' ? 'text-emerald-400' : flash === 'down' ? 'text-red-400' : '';

  return (
    <span className={`transition-colors duration-500 ${flashClass}`}>{display}</span>
  );
}
