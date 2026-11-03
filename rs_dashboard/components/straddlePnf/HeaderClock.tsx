'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

// The current time (IST) in the page header, ticking every second: AUTO's entry window, the 15:15 / MCX end-of-day exits and the
// closed-bar timing are all read against this clock. Rendered blank until mounted so the server and first client render agree.
export default function HeaderClock() {
  const [t, setT] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setT(Date.now());
    const id = setInterval(() => setT(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const text = t === null ? '--:--:--' : new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return (
    <span data-testid="pnf-clock" title="Current time (IST)" aria-label={`Current time ${text} IST`}
          className="inline-flex items-center gap-1.5 h-6 px-2 rounded border border-zinc-800 bg-zinc-900 text-[11px] font-mono font-bold text-zinc-200 tabular-nums">
      <Clock className="w-3 h-3 text-zinc-400" aria-hidden="true" />
      {text}
      <span className="text-[10px] font-semibold text-zinc-500">IST</span>
    </span>
  );
}
