'use client';

import { useEffect } from 'react';
import { Sun, Moon, Coffee } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  initTheme,
  nextThemeMode,
  setThemeMode,
  useThemeMode,
  type ThemeMode,
} from '@/lib/theme';

/** 3-way cycle: Dark -> White -> Beige -> Dark. The icon shown is always the
 * TARGET mode (what clicking does), matching the toggle's original behavior. */
const LABEL: Record<ThemeMode, string> = {
  dark: 'Dark mode',
  light: 'White mode',
  beige: 'Beige mode',
};

const ICON: Record<ThemeMode, typeof Sun> = {
  dark: Moon,
  light: Sun,
  beige: Coffee,
};

export default function ThemeToggle({ className }: { className?: string }) {
  const mode = useThemeMode();

  useEffect(() => { initTheme(); }, []);

  const target = nextThemeMode(mode);
  const Icon = ICON[target];

  return (
    <Tooltip>
      <TooltipTrigger
        onClick={() => setThemeMode(target)}
        render={
          <button
            type="button"
            aria-label={`Current: ${LABEL[mode]}. Switch to ${LABEL[target]}.`}
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
        Switch to {LABEL[target]}
      </TooltipContent>
    </Tooltip>
  );
}
