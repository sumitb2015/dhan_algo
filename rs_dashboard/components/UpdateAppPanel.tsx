'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitPullRequest, RefreshCw, CheckCircle2, XCircle, AlertTriangle, GitCommitHorizontal,
} from 'lucide-react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

interface RepoStatus {
  success: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  incomingCommits?: string[];
  isProd?: boolean;
  error?: string;
}

interface PullResult {
  success: boolean;
  message?: string;
  updated?: boolean;
  needsRestart?: boolean;
  changedFiles?: string[];
  isProd?: boolean;
  error?: string;
}

interface UpdateAppPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function UpdateAppPanel({ open, onClose }: UpdateAppPanelProps) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [result, setResult] = useState<PullResult | null>(null);
  const [reloading, setReloading] = useState(false);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkStatus = useCallback(async () => {
    setChecking(true);
    setResult(null);
    try {
      const res = await fetch('/api/update-repo');
      const json: RepoStatus = await res.json();
      setStatus(json);
    } catch {
      setStatus({ success: false, error: 'Could not reach the server' });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    checkStatus();
  }, [open, checkStatus]);

  useEffect(() => {
    return () => {
      if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    };
  }, []);

  const pull = async () => {
    setPulling(true);
    setResult(null);
    try {
      const res = await fetch('/api/update-repo', { method: 'POST' });
      const json: PullResult = await res.json();
      setResult(json);
      if (json.success && json.updated && !json.needsRestart) {
        setReloading(true);
        // Give the dev server's file watcher a moment to recompile the pulled
        // changes before the reload asks for them.
        reloadTimerRef.current = setTimeout(() => window.location.reload(), 1500);
      } else if (json.success) {
        await checkStatus();
      }
    } catch {
      setResult({ success: false, error: 'Could not reach the server' });
    } finally {
      setPulling(false);
    }
  };

  const behind = status?.behind ?? 0;
  const ahead = status?.ahead ?? 0;
  const canPull = status?.success && behind > 0 && !pulling && !reloading;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[440px] max-w-[100vw] p-0 flex flex-col bg-zinc-950 border-l border-zinc-800 gap-0"
      >
        {/* Header */}
        <SheetHeader className="flex-none px-5 py-4 border-b border-zinc-800 flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
              <GitPullRequest className="h-4 w-4 text-indigo-400" />
            </div>
            <div>
              <SheetTitle className="text-sm font-bold text-white">Update App</SheetTitle>
              <SheetDescription className="text-[10px] text-zinc-500">Pull the latest changes from GitHub</SheetDescription>
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

        <div className="flex-1 flex flex-col min-h-0 px-5 py-4 gap-4 overflow-y-auto">
          {/* Branch / ahead-behind summary */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {checking ? (
                <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30 gap-1.5">
                  <RefreshCw className="h-3 w-3 animate-spin" />Checking…
                </Badge>
              ) : status?.success ? (
                behind > 0 ? (
                  <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 gap-1.5">
                    <GitCommitHorizontal className="h-3 w-3" />{behind} behind
                  </Badge>
                ) : (
                  <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1.5">
                    <CheckCircle2 className="h-3 w-3" />Up to date
                  </Badge>
                )
              ) : (
                <Badge className="bg-red-500/15 text-red-400 border-red-500/30 gap-1.5">
                  <XCircle className="h-3 w-3" />Check failed
                </Badge>
              )}
              {status?.branch && (
                <span className="text-[10px] text-zinc-500 font-mono">{status.branch}</span>
              )}
              {ahead > 0 && (
                <span className="text-[10px] text-zinc-500 font-mono">· {ahead} ahead</span>
              )}
            </div>
            <Button
              onClick={checkStatus}
              disabled={checking || pulling}
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
            >
              <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
              Recheck
            </Button>
          </div>

          {status?.isProd && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-indigo-500/25 bg-indigo-950/20 text-xs text-indigo-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Running via <code className="text-indigo-200">npm start</code> — any pull
                will need a manual rebuild and restart to actually take effect; the page
                won&apos;t reload automatically.
              </span>
            </div>
          )}

          {status?.dirty && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-950/20 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                You have uncommitted local changes. A pull only ever fast-forwards —
                it will fail loudly rather than overwrite anything if that&apos;s a problem.
              </span>
            </div>
          )}

          {!checking && status?.success === false && (
            <div className="px-3 py-2 rounded-lg border border-red-500/25 bg-red-950/20 text-xs text-red-400 font-mono whitespace-pre-wrap break-all">
              {status.error}
            </div>
          )}

          {/* Incoming commits */}
          {behind > 0 && status?.incomingCommits && status.incomingCommits.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                Incoming commits
              </span>
              <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3 space-y-1 font-mono text-[11px] leading-relaxed max-h-48 overflow-y-auto">
                {status.incomingCommits.map((line, i) => (
                  <div key={i} className="text-zinc-400 whitespace-pre-wrap break-all">{line}</div>
                ))}
              </div>
            </div>
          )}

          <Separator className="bg-zinc-800/60" />

          <Button
            onClick={pull}
            disabled={!canPull}
            className="w-full flex items-center justify-center gap-2 bg-indigo-500/10 hover:bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 rounded-xl h-11 font-semibold text-sm"
            variant="ghost"
          >
            {pulling ? <RefreshCw className="h-4 w-4 animate-spin" /> : <GitPullRequest className="h-4 w-4" />}
            {pulling ? 'Pulling…' : behind > 0 ? `Pull ${behind} commit${behind === 1 ? '' : 's'}` : 'Nothing to pull'}
          </Button>

          {/* Result */}
          {result && (
            result.success ? (
              result.needsRestart ? (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-950/20 text-xs text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold">Pulled — rebuild needed</p>
                    {result.isProd ? (
                      <p className="text-amber-400/80">
                        Running via <code className="text-amber-300">npm start</code> — it
                        serves a pre-built bundle, so this won&apos;t take effect until you
                        stop it, run <code className="text-amber-300">npm run build</code>,
                        then <code className="text-amber-300">npm start</code> again.
                      </p>
                    ) : (
                      <p className="text-amber-400/80">
                        {result.changedFiles?.filter((f) => f.endsWith('package.json') || f.endsWith('package-lock.json') || f.endsWith('next.config.ts')).join(', ')}{' '}
                        changed. Stop and restart <code className="text-amber-300">npm run dev</code> for this to take effect.
                      </p>
                    )}
                  </div>
                </div>
              ) : result.updated ? (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-emerald-500/25 bg-emerald-950/20 text-xs text-emerald-400 font-semibold">
                  {reloading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  {reloading ? 'Reloading…' : 'Updated — reloading'}
                </div>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-400">
                  <CheckCircle2 className="h-3.5 w-3.5 text-zinc-500" />
                  {result.message}
                </div>
              )
            ) : (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-500/25 bg-red-950/20 text-xs text-red-400 font-mono whitespace-pre-wrap break-all">
                <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {result.error}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="flex-none px-5 py-3 border-t border-zinc-800/60 text-[10px] text-zinc-600">
          Pulls with <code className="text-zinc-500">--ff-only</code> — never merges or rebases.
          Diverged history or a conflicting local change fails loudly instead of guessing.
        </div>
      </SheetContent>
    </Sheet>
  );
}
