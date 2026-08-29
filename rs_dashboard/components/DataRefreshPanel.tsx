'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Download, RefreshCw, CheckCircle2, XCircle, AlertCircle,
  Database, TrendingUp, BarChart2, Layers, Square
} from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';

interface RefreshStatus {
  pid: number;
  phase: string;
  message: string;
  current: number;
  total: number;
  done: boolean;
  error: string | null;
  log: string[];
  updated_at: string;
}

interface DataRefreshPanelProps {
  open: boolean;
  onClose: () => void;
  onRefreshComplete: () => void;
}

const TARGETS = [
  {
    id: 'nifty50',
    label: 'Nifty 50 Index',
    desc: 'NIFTY_50_Daily_5Y.csv — daily OHLCV for Nifty 50 index',
    icon: <TrendingUp className="h-4 w-4" />,
  },
  {
    id: 'nifty500-index',
    label: 'Nifty 500 Index',
    desc: 'NIFTY_500_Daily.csv — daily OHLCV for Nifty 500 index',
    icon: <BarChart2 className="h-4 w-4" />,
  },
  {
    id: 'indices',
    label: 'Sector Indices',
    desc: 'Historical Data/Indices — BankNifty, IT, FMCG, Auto, Pharma and 13 more',
    icon: <Layers className="h-4 w-4" />,
  },
  {
    id: 'stocks',
    label: 'Nifty 500 Stocks',
    desc: 'Daily_Historical_Data_Fresh — individual stock CSVs',
    icon: <Database className="h-4 w-4" />,
  },
] as const;

type TargetId = (typeof TARGETS)[number]['id'] | 'all';

function phaseLabel(phase: string): string {
  if (phase === 'nifty50')        return 'Nifty 50 Index';
  if (phase === 'nifty500_index') return 'Nifty 500 Index';
  if (phase === 'indices')        return 'Sector Indices';
  if (phase === 'stocks')         return 'Nifty 500 Stocks';
  if (phase === 'done')           return 'Complete';
  if (phase === 'error')          return 'Error';
  if (phase === 'stopped')        return 'Stopped';
  return phase;
}

function phaseStatusBadge(phase: string) {
  if (phase === 'done')    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1.5"><CheckCircle2 className="h-3 w-3" />Done</Badge>;
  if (phase === 'error')   return <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1.5"><XCircle className="h-3 w-3" />Error</Badge>;
  if (phase === 'stopped') return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1.5"><AlertCircle className="h-3 w-3" />Stopped</Badge>;
  return <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30 gap-1.5"><RefreshCw className="h-3 w-3 animate-spin" />{phaseLabel(phase)}</Badge>;
}

function logLineColor(line: string): string {
  const t = line.trimStart();
  if (t.startsWith('✅') || t.startsWith('✓')) return 'text-emerald-400';
  if (t.startsWith('✗') || line.includes('ERROR') || /\berror\b/i.test(line)) return 'text-red-400';
  if (t.startsWith('⏹') || line.includes('Stopped')) return 'text-amber-400';
  if (t.startsWith('▶') || t.startsWith('[')) return 'text-zinc-300';
  return 'text-zinc-500';
}

export default function DataRefreshPanel({ open, onClose, onRefreshComplete }: DataRefreshPanelProps) {
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didCompleteRef = useRef(false);

  interface OptionsRefreshStatus {
    running: boolean;
    done: boolean;
    message: string;
    error: string | null;
  }
  const [optStatus, setOptStatus] = useState<OptionsRefreshStatus | null>(null);
  const optPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOptStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/options-refresh');
      const json: OptionsRefreshStatus = await res.json();
      setOptStatus(json);
      if (!json.running && json.done) {
        if (optPollRef.current) { clearInterval(optPollRef.current); optPollRef.current = null; }
      }
    } catch { /* ignore */ }
  }, []);

  const stopOptDownload = useCallback(async () => {
    try {
      await fetch('/api/options-refresh', { method: 'DELETE' });
    } catch { /* ignore */ }
  }, []);

  const startOptDownload = useCallback(async () => {
    try {
      const res = await fetch('/api/options-refresh', { method: 'POST' });
      if (!res.ok) return;
      setOptStatus({ running: true, done: false, message: 'Starting…', error: null });
      if (optPollRef.current) clearInterval(optPollRef.current);
      optPollRef.current = setInterval(fetchOptStatus, 2000);
    } catch { /* ignore */ }
  }, [fetchOptStatus]);

  useEffect(() => {
    if (!open) {
      if (optPollRef.current) { clearInterval(optPollRef.current); optPollRef.current = null; }
      return;
    }
    fetchOptStatus();
    optPollRef.current = setInterval(fetchOptStatus, 2000);
    return () => { if (optPollRef.current) clearInterval(optPollRef.current); };
  }, [open, fetchOptStatus]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/refresh');
      const json = await res.json();
      setRunning(json.running);
      setStatus(json.status);

      if (json.status?.done && !didCompleteRef.current) {
        didCompleteRef.current = true;
        onRefreshComplete();
      }
      if (!json.status?.done) {
        didCompleteRef.current = false;
      }
    } catch { /* ignore */ }
  }, [onRefreshComplete]);

  useEffect(() => {
    if (!open) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [open, fetchStatus]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [status?.log]);

  const startRefresh = async (target: TargetId) => {
    setStarting(true);
    didCompleteRef.current = false;
    try {
      await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      setRunning(true);
      await fetchStatus();
    } finally {
      setStarting(false);
    }
  };

  const stopRefresh = async () => {
    await fetch('/api/refresh', { method: 'DELETE' });
  };

  const isDone = status?.done;
  const isError = status?.phase === 'error';
  const pct = (status?.total ?? 0) > 0
    ? Math.round(((status?.current ?? 0) / (status?.total ?? 1)) * 100)
    : 0;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[480px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0"
      >
        {/* Header */}
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <Layers className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">Sync Market Data</SheetTitle>
              <SheetDescription className="text-[10px] text-zinc-500">Incremental update from Dhan API</SheetDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="shrink-0 text-zinc-500 hover:text-white"
          >
            ×
          </Button>
        </SheetHeader>

        {/* Dataset buttons */}
        <div className="flex-none px-5 pt-4 pb-3 space-y-2">
          <Button
            onClick={() => startRefresh('all')}
            disabled={running || starting}
            className="w-full flex items-center justify-between bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded-xl h-11 px-4"
            variant="ghost"
          >
            <div className="flex items-center gap-2 font-semibold text-sm">
              {starting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Refresh All Data
            </div>
          </Button>

          <div className="grid grid-cols-2 gap-2">
            {TARGETS.map((t) => (
              <Button
                key={t.id}
                onClick={() => startRefresh(t.id)}
                disabled={running || starting}
                title={t.desc}
                variant="outline"
                className="flex flex-col items-center gap-1.5 h-auto px-3 py-2.5 rounded-xl border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 text-[11px] font-semibold text-center"
              >
                {t.icon}
                {t.label}
              </Button>
            ))}
          </div>

          <Separator className="my-3 bg-zinc-800/60" />

          <div className="space-y-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Historical Options Data</span>
            {optStatus?.running ? (
              <div className="w-full flex items-center justify-between bg-sky-950/20 border border-sky-500/20 rounded-xl h-11 px-4 text-sky-400">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <RefreshCw className="h-4 w-4 animate-spin shrink-0" />
                  <span className="font-mono text-[11px] truncate max-w-[200px]" title={optStatus.message}>
                    {optStatus.message || 'Downloading…'}
                  </span>
                </div>
                <Button
                  onClick={stopOptDownload}
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2.5 text-xs gap-1"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  onClick={startOptDownload}
                  className="w-full flex items-center justify-between bg-sky-500/10 hover:bg-sky-500/15 text-sky-400 border border-sky-500/30 rounded-xl h-11 px-4"
                  variant="ghost"
                  title="Download expired weekly options 1-min data since 2021 (skips existing files)"
                >
                  <div className="flex items-center gap-2 font-semibold text-sm">
                    <Download className="h-4 w-4" />
                    Download Expired Options
                  </div>
                  {optStatus?.done && !optStatus?.error && (
                    <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                      <CheckCircle2 className="h-3 w-3" />
                      Up to date
                    </span>
                  )}
                </Button>
                {optStatus?.message && !optStatus?.running && (
                  <p className="text-[10px] text-zinc-400 font-mono mt-1 px-1 truncate" title={optStatus.message}>
                    {optStatus.message}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Status area */}
        {status && (
          <div className="flex-none px-5 pb-3 space-y-3">
            <Separator className="bg-zinc-800/60" />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {phaseStatusBadge(status.phase)}
                {running && (
                  <span className="text-[10px] text-zinc-500 font-mono">PID {status.pid}</span>
                )}
              </div>
              {running && (
                <Button
                  onClick={stopRefresh}
                  size="sm"
                  variant="destructive"
                  className="h-7 gap-1.5"
                >
                  <Square className="h-3 w-3" />
                  Stop
                </Button>
              )}
              {isDone && !isError && (
                <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Dashboard refreshed
                </span>
              )}
            </div>

            {status.total > 0 && (status.phase === 'stocks' || status.phase === 'indices') && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                  <span>{status.current} / {status.total} {status.phase === 'indices' ? 'indices' : 'stocks'}</span>
                  <span>{pct}%</span>
                </div>
                <Progress value={pct} className="h-1.5 bg-zinc-800 [&>div]:bg-gradient-to-r [&>div]:from-emerald-600 [&>div]:to-teal-400" />
              </div>
            )}

            {isError && (
              <div className="px-3 py-2 rounded-lg border border-red-500/25 bg-red-950/20 text-xs text-red-400">
                {status.error || status.message}
              </div>
            )}
          </div>
        )}

        {/* Log console */}
        <div className="flex-1 flex flex-col min-h-0 px-5 pb-5">
          <div className="flex-none flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Log</span>
            {status?.updated_at && (
              <span className="text-[9px] text-zinc-700 font-mono">
                {new Date(status.updated_at).toLocaleTimeString('en-IN', {
                  timeZone: 'Asia/Kolkata', hour12: false
                })}
              </span>
            )}
          </div>
          <div
            ref={logRef}
            className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-0.5 font-mono text-[11px] leading-relaxed"
          >
            {!status?.log?.length ? (
              <div className="text-zinc-600 text-center py-4">
                Start a refresh to see log output here.
              </div>
            ) : (
              status.log.map((line, i) => (
                <div key={i} className={`whitespace-pre-wrap break-all ${logLineColor(line)}`}>
                  {line}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex-none px-5 py-3 border-t border-zinc-800/60 text-[10px] text-zinc-600">
          Requires a valid Dhan access token (<code className="text-zinc-500">access_token.json</code>).
          Run <code className="text-zinc-500">login.py</code> if auth fails.
        </div>
      </SheetContent>
    </Sheet>
  );
}
