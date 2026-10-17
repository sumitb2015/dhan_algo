'use client';

import { useState } from 'react';
import { Terminal, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AuditLogItem } from '@/lib/breakdownLedger';

interface AuditLogPanelProps {
  logs: AuditLogItem[];
  onClearLogs: () => void;
}

export function AuditLogPanel({ logs, onClearLogs }: AuditLogPanelProps) {
  const [filter, setFilter] = useState<'ALL' | 'SIGNAL' | 'ORDER' | 'EXIT'>('ALL');

  const filtered = logs.filter((l) => (filter === 'ALL' ? true : l.level === filter));

  const levelColor = (lvl: AuditLogItem['level']) => {
    switch (lvl) {
      case 'ORDER':
        return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
      case 'EXIT':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
      case 'SIGNAL':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
      case 'WARN':
      case 'ERROR':
        return 'text-red-400 bg-red-500/10 border-red-500/20';
      default:
        return 'text-zinc-400 bg-zinc-800 border-zinc-700';
    }
  };

  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/70 backdrop-blur">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-zinc-400" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-white">Execution & Audit Log</h2>
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
            {logs.length} events
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-[10px]">
            {(['ALL', 'SIGNAL', 'ORDER', 'EXIT'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-2 py-0.5 font-bold transition',
                  filter === f
                    ? 'bg-zinc-800 text-white'
                    : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {f}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClearLogs}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-red-400 transition"
            title="Clear logs"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="h-44 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed divide-y divide-zinc-900">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-600">
            No events logged yet. Scanner and engine events will stream here.
          </div>
        ) : (
          filtered.map((log) => {
            const timeStr = new Date(log.at).toLocaleTimeString('en-IN', { hour12: false });
            return (
              <div key={log.id} className="py-1 flex items-start gap-2 hover:bg-zinc-900/30">
                <span className="text-zinc-500 shrink-0 tabular-nums">[{timeStr}]</span>
                <span
                  className={cn(
                    'rounded px-1.5 py-0.2 text-[9px] font-bold uppercase shrink-0 border',
                    levelColor(log.level),
                  )}
                >
                  {log.level}
                </span>
                <span className="text-zinc-300 break-words flex-1">{log.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
