'use client';

import { useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  initTheme,
  nextThemeMode,
  setThemeMode,
  useThemeMode,
} from '@/lib/theme';

/** Direct 2-way toggle between Dark mode and White mode (Light). */
export default function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeMode();

  useEffect(() => { initTheme(); }, []);

  const isDark = mode === 'dark';
  const Icon = isDark ? Sun : Moon;
  const targetName = isDark ? 'White mode' : 'Dark mode';

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={() => setThemeMode(nextThemeMode(mode))}
        render={
          <button
            type="button"
            aria-label={`Current: ${isDark ? 'Dark mode' : 'White mode'}. Switch to ${targetName}.`}
            className={cn(
              'flex items-center justify-center h-7 w-7 rounded-xl border border-zinc-700/60',
              'bg-zinc-900/80 text-zinc-300 transition-all duration-200 cursor-pointer',
              'hover:text-amber-400 hover:border-amber-500/40 hover:bg-zinc-800',
              'active:scale-[0.94]',
              className,
            )}
          />
        }
      >
        <Icon className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent>
        Switch to {targetName}
      </TooltipContent>
    </Tooltip>
  );
}

