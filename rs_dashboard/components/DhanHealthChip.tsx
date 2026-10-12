'use client';

import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { HealthCheck, HealthLevel } from '@/lib/dhanHealth';

interface HealthResponse {
  success: boolean;
  level?: HealthLevel;
  checks?: HealthCheck[];
  publicIp?: string | null;
  checkedAt?: string;
  error?: string;
}

const POLL_MS = 60_000;

const TONE: Record<HealthLevel, { chip: string; dot: string; text: string }> = {
  ok:      { chip: 'border-zinc-800 bg-zinc-900',               dot: 'bg-emerald-400', text: 'text-emerald-400' },
  warn:    { chip: 'border-amber-500/40 bg-amber-500/10',       dot: 'bg-amber-400',   text: 'text-amber-400' },
  bad:     { chip: 'border-red-500/40 bg-red-500/10',           dot: 'bg-red-400 animate-pulse', text: 'text-red-400' },
  unknown: { chip: 'border-zinc-800 bg-zinc-900',               dot: 'bg-zinc-500',    text: 'text-zinc-400' },
};

/** Header chip: token validity, kill switch and static-IP whitelist in one glance. */
export default function DhanHealthChip() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      if (typeof document !== 'undefined' && document.hidden) return;
      const mine = ++seq.current;
      try {
        const res = await fetch('/api/dhan-health');
        const json = (await res.json()) as HealthResponse;
        if (alive && mine === seq.current) setData(json);
      } catch {
        if (alive && mine === seq.current) setData({ success: false, error: 'unreachable' });
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const level: HealthLevel = data?.success && data.level ? data.level : 'unknown';
  const tone = TONE[level];
  const bad = (data?.checks ?? []).filter(c => c.level === 'bad' || c.level === 'warn');
  const headline = !data ? 'DHAN …' : !data.success ? 'DHAN ?' : level === 'ok' ? 'DHAN OK' : (bad[0]?.label ?? 'DHAN CHECK').toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="Dhan account health: token, kill switch, static IP"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold cursor-pointer ${tone.chip} ${tone.text}`}
        title="Token validity · kill switch · static IP"
      >
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
        <ShieldCheck className="h-3 w-3" />
        <span>{headline}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-md border border-zinc-700 bg-zinc-900 p-3 shadow-lg">
          {!data?.success ? (
            <p className="text-xs text-zinc-300">Health check failed{data?.error ? `: ${data.error}` : ''}.</p>
          ) : (
            <ul className="space-y-2">
              {(data.checks ?? []).map(c => (
                <li key={c.id} className="text-xs">
                  <span className={`font-bold ${TONE[c.level].text}`}>{c.label}</span>
                  <p className="text-zinc-400">{c.detail}</p>
                </li>
              ))}
            </ul>
          )}
          {data?.publicIp && <p className="mt-2 font-mono text-[10px] text-zinc-500">This machine: {data.publicIp}</p>}
        </div>
      )}
    </div>
  );
}
