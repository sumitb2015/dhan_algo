'use client';

// IST wall clock (HH:MM:SS), ticking every second. Its own component so the 1 s tick re-renders only this text, not
// the terminal (and its memoised charts) around it. Empty until mounted, so the server render never mismatches.

import { useEffect, useState } from 'react';

const fmt = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

export default function IstClock({ suffix = '', className, title }: { suffix?: string; className?: string; title?: string }) {
  const [now, setNow] = useState('');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(fmt());
    const t = setInterval(() => setNow(fmt()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className={className} title={title} suppressHydrationWarning>{now}{now && suffix}</span>;
}
