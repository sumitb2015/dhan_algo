'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DatabaseZap, GitPullRequest, LogOut, RefreshCw, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useRefreshStatus } from '@/lib/useRefreshStatus';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import DataRefreshPanel from './DataRefreshPanel';
import UpdateAppPanel from './UpdateAppPanel';
import SettingsPanel from './SettingsPanel';
import ThemeToggle from './ThemeToggle';

export default function NavBar() {
  const router = useRouter();
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const sync = useRefreshStatus();

  async function handleDisconnect() {
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (!res.ok) throw new Error(`logout failed: ${res.status}`);
      toast.success('Session ended');
    } catch {
      toast.error('Failed to end session — try again');
      return;
    }
    router.push('/login');
  }

  return (
    <>
    <div className="flex items-center gap-1 shrink-0">
      <ThemeToggle />
      <Tooltip>
        <TooltipTrigger
          onClick={() => setSettingsPanelOpen(true)}
          render={
            <button
              type="button"
              aria-label="Settings"
              className="flex items-center justify-center h-7 w-7 rounded-xl border border-zinc-700/60 dark:border-zinc-800 bg-zinc-900/80 text-zinc-300 transition-all duration-200 cursor-pointer hover:text-amber-400 hover:border-amber-500/40 hover:bg-zinc-800 active:scale-[0.94]"
            />
          }
        >
          <Settings className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent>
          Settings — theme &amp; heading font
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          onClick={() => setSyncPanelOpen(true)}
          render={<button className="flex items-center gap-1.5 px-2.5 border border-zinc-700/60 dark:border-zinc-800 bg-zinc-900 text-zinc-100 dark:text-zinc-300 hover:text-emerald-400 hover:border-emerald-500/40 rounded-xl text-xs h-7 cursor-pointer font-medium transition-all" />}
        >
          <DatabaseZap className="h-3.5 w-3.5" />
          Sync Data
          {sync.running && (
            <>
              <RefreshCw className="h-3 w-3 animate-spin text-sky-500" />
              {sync.total > 0 && (
                <span className="text-[10px] font-mono text-sky-500">
                  {sync.current}/{sync.total}
                </span>
              )}
            </>
          )}
          {!sync.running && sync.error && (
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {sync.running
            ? `Syncing ${sync.phase || 'data'}…`
            : sync.error
              ? `Last sync failed: ${sync.error.slice(0, 120)}`
              : 'Sync latest market data from Dhan API'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          onClick={() => setUpdatePanelOpen(true)}
          render={<button className="flex items-center gap-1.5 px-2.5 border border-zinc-700/60 dark:border-zinc-800 bg-zinc-900 text-zinc-100 dark:text-zinc-300 hover:text-indigo-400 hover:border-indigo-500/40 rounded-xl text-xs h-7 cursor-pointer font-medium transition-all" />}
        >
          <GitPullRequest className="h-3.5 w-3.5" />
          Update
        </TooltipTrigger>
        <TooltipContent>
          Pull the latest changes from GitHub
        </TooltipContent>
      </Tooltip>
      <button
        onClick={handleDisconnect}
        className="flex items-center gap-1.5 px-2.5 h-7 border border-zinc-700/60 dark:border-zinc-800 bg-zinc-900 text-zinc-100 dark:text-zinc-300 hover:text-red-400 hover:border-red-500/40 rounded-xl text-xs cursor-pointer font-medium active:scale-[0.98] transition-all whitespace-nowrap"
      >
        <LogOut className="h-3.5 w-3.5" />
        Disconnect
      </button>
    </div>

    <DataRefreshPanel
      open={syncPanelOpen}
      onClose={() => setSyncPanelOpen(false)}
      onRefreshComplete={() => router.refresh()}
    />

    <UpdateAppPanel
      open={updatePanelOpen}
      onClose={() => setUpdatePanelOpen(false)}
    />

    <SettingsPanel
      open={settingsPanelOpen}
      onClose={() => setSettingsPanelOpen(false)}
    />
    </>
  );
}
