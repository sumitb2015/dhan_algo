'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DatabaseZap, RefreshCw } from 'lucide-react';
import { useRefreshStatus } from '@/lib/useRefreshStatus';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import DataRefreshPanel from './DataRefreshPanel';
import ThemeToggle from './ThemeToggle';

export default function NavBar() {
  const router = useRouter();
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const sync = useRefreshStatus();

  async function handleDisconnect() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <>
    <div className="flex items-center gap-1 shrink-0">
      <ThemeToggle />
      <Tooltip>
        <TooltipTrigger
          onClick={() => setSyncPanelOpen(true)}
          render={<button className="flex items-center gap-1.5 px-2.5 border border-zinc-700/60 dark:border-zinc-800 bg-zinc-900 text-zinc-100 dark:text-zinc-300 hover:text-black dark:hover:text-emerald-400 hover:border-emerald-500/40 rounded-xl text-xs h-7 cursor-pointer font-medium transition-all" />}
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
      <button
        onClick={handleDisconnect}
        className="px-3 py-1.8 text-xs font-semibold rounded-lg text-zinc-100 dark:text-zinc-400 hover:text-red-700 dark:hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 active:scale-[0.98] transition-all duration-200 whitespace-nowrap cursor-pointer"
      >
        Disconnect
      </button>
    </div>

    <DataRefreshPanel
      open={syncPanelOpen}
      onClose={() => setSyncPanelOpen(false)}
      onRefreshComplete={() => router.refresh()}
    />
    </>
  );
}
