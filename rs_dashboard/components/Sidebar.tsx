'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import {
  TrendingUp,
  Layers,
  Activity,
  Cpu,
  Briefcase,
  LineChart,
  Zap,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from './ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const NAV_GROUPS = [
  {
    label: 'Equity',
    icon: TrendingUp,
    links: [
      { href: '/', label: 'RS Scanner', desc: 'Relative strength scanner vs Nifty index' },
      { href: '/scanner', label: 'Scanner', desc: 'Custom criteria and queries scanner' },
      { href: '/movers', label: 'Movers', desc: 'Top gainers, losers & volume breakouts' },
      { href: '/movers-plus', label: 'Movers+', desc: 'Multi-timeframe activity dashboard' },
      { href: '/rrg', label: 'RRG', desc: 'Relative Rotation Graphs & sector trends' },
      { href: '/normalized', label: 'Charts', desc: 'Multi-asset normalized charts comparisons' },
      { href: '/candlestick', label: 'Candlestick', desc: 'Plotly candlestick charts for Nifty 50 stocks' },
      { href: '/top-mcap-charts', label: 'Top 8 by Mcap', desc: 'Daily charts for the 8 heaviest Nifty constituents by market cap, and the top 8 indices' },
      { href: '/volume-footprint', label: 'Volume Footprint', desc: 'Buy/sell volume profile, POC/VAH/VAL & footprint table for indices and F&O stocks' },
      { href: '/seasonality', label: 'Seasonality', desc: 'Monthly % gain heatmap by year' },
      { href: '/equity-watchlist', label: 'Forever Watchlist', desc: 'Manage Forever/GTT orders for your equity watchlist' },
    ],
  },
  // Derivatives used to hold all 21 F&O pages in one dropdown, which overflowed
  // the viewport and made the tail unreachable. Split by what you're doing:
  // reading market structure, researching a trade, or placing one.
  {
    label: 'Derivatives',
    icon: Layers,
    links: [
      { href: '/options', label: 'Options', desc: 'Max pain, PCR & live options chain' },
      { href: '/nifty-oi-profile', label: 'Nifty OI Profile', desc: 'Futures 5-min chart with 7-day 3-column OI & OI Change profile' },
      { href: '/trending-oi', label: 'Trending OI', desc: 'Chain-wide OI/LTP interval table with call/put diff, direction & sentiment' },
      { href: '/futures', label: 'Futures', desc: 'OI buildup & short/long coverage analysis' },
      { href: '/iv-charts', label: 'IV Charts', desc: 'Implied Volatility history & skew' },
      { href: '/options/crudeoil', label: 'Crude Oil Options', desc: 'Max pain, PCR & live option chain for MCX Crude Oil' },
    ],
  },
  {
    label: 'Options Analysis',
    icon: LineChart,
    links: [
      { href: '/options-analytics', label: 'Positions Analytics', desc: 'Combined payoff, Greeks, P&L and Kelly sizing for your open NIFTY / SENSEX positions' },
      { href: '/options/analyzer', label: 'Option Analyzer', desc: 'Rank strikes based on technical indicators & OI change' },
      { href: '/options/premium-bar', label: 'Premium Bar Chart', desc: 'CE vs PE premium bar charts & straddle curve across strikes' },
      { href: '/options/live-charts', label: 'Live Options Charts', desc: 'Live straddle, rolling straddle, strangle & custom strategy premium charts' },
      { href: '/straddle-analysis', label: 'Straddle Analysis', desc: 'ATM straddle premium patterns by weekday, DTE & regime' },
      { href: '/strangle-analysis', label: 'Strangle Analysis', desc: 'OTM strangle premium patterns by offset, weekday, DTE & regime' },
      { href: '/options/strangle-matrix', label: 'Live Strangle Matrix', desc: 'Live ATM-offset strangle premiums across expiries, ranked by RoM%' },
      { href: '/options/strike-history', label: 'Strike History', desc: '1-minute close price line chart for one strike across its expiry lifetime' },
      { href: '/option-strats', label: 'Option Strats', desc: 'Multi-leg P&L heatmap analyzer — strike × date, IV-adjustable' },
      { href: '/option-strats-stocks', label: 'Option Strats (Stocks)', desc: 'Same P&L heatmap analyzer for Nifty 50 F&O stocks' },
    ],
  },
  {
    label: 'Trading',
    icon: Zap,
    links: [
      { href: '/ultimate-scanner', label: 'Ultimate Scanner', desc: 'Process-driven Nifty & Sensex option chain scanner, watchlist & multi-leg execution' },
      { href: '/straddle-matrix', label: 'ATM Straddle Matrix', desc: 'Live ATM short straddle entry stats across timestamps & leg-wise SL%' },
      { href: '/level-chart', label: 'Level Chart', desc: 'Live High/50%/Low interval-level zones for any stock, index or crude oil future' },
      { href: '/options-analytics/live', label: 'Live Payoff', desc: 'Live combined payoff diagram for every underlying with open option positions' },
      { href: '/scalper', label: 'Scalper', desc: 'Multi-window active trading & scalping order ticket' },
      { href: '/advanced-scalper', label: 'Advanced Scalper', desc: 'Configurable 2-5 box scalper with per-box CE/PE, strike & lot presets' },
      { href: '/focus-tool', label: 'Ultimate Scalper Terminal', desc: 'Straddles & strangles terminal — timed entry, level exits, real-money armed orders' },
      { href: '/options/quiktrade', label: 'QuikTrade', desc: 'OI buildup quadrants, live positions & P&L' },
      { href: '/baskets', label: 'Baskets', desc: 'Predefined option strategies with payoff diagram & quick basket order entry' },
      { href: '/multi-leg-focus', label: 'Multi-Leg Focus', desc: 'N-leg strategy builder from presets — live P&L monitor with manual exits' },
      { href: '/strategy-builder', label: 'Strategy Builder', desc: 'Build & track multi-leg NIFTY options strategies' },
      { href: '/csp-screener', label: 'CSP Screener', desc: 'Scan Nifty 500 F&O stocks for cash-secured-put candidates, track & roll positions' },
      { href: '/cash-secured-puts', label: 'Cash Secured Puts', desc: 'Track underlyings, sell PUTs, monitor active orders & trades' },
      { href: '/options/delta', label: 'Net Delta', desc: 'Track live delta risk and net delta exposure of active positions' },
    ],
  },
  {
    label: 'Market Health',
    icon: Activity,
    links: [
      { href: '/breadth', label: 'Breadth', desc: 'Market index moving average breadth status' },
      { href: '/breadth-intraday', label: 'Intraday Breadth', desc: 'Live 1-min advance/decline breadth for Nifty 50 & Bank Nifty' },
      { href: '/diffusion', label: 'Diffusion', desc: 'Diffusion index indicators & trend line charts' },
      { href: '/distribution', label: 'Distribution', desc: 'Returns frequency & statistical distribution' },
      { href: '/live', label: 'Live', desc: 'Live ticking market breadth & indexes' },
      { href: '/expiry-analysis', label: 'Expiry Analysis', desc: 'Weekly OC return distribution & outlier analysis' },
      { href: '/premarket', label: 'Premarket', desc: 'Morning market bias, VIX, OI levels & global snapshot' },
    ],
  },
  {
    label: 'Algo',
    icon: Cpu,
    links: [
      { href: '/terminal', label: 'Intraday Terminal', desc: 'Nifty 50 intraday VWAP + RS signal blotter, positions & auto-trader control' },
      { href: '/strategies', label: 'Strategies', desc: 'Automated execution control panel' },
      { href: '/strategies-plus', label: 'Strategies+', desc: 'Advanced multi-leg algorithm inputs' },
      { href: '/backtest', label: 'Backtest', desc: 'Short straddle historical simulation' },
      { href: '/momentum', label: 'Momentum Portfolio', desc: 'Nifty 500 momentum investing portfolio — holdings, ranks, stops & signals' },
    ],
  },
  {
    label: 'Portfolio',
    icon: Briefcase,
    links: [
      { href: '/portfolio', label: 'Portfolio', desc: 'Live positions, P&L & margin monitoring' },
      { href: '/portfolio-new', label: 'Portfolio+', desc: 'Multi-account advanced tracker & assets' },
      { href: '/portfolio/trades', label: 'Trade P&L', desc: 'FIFO realized P&L by segment (Equity/F&O/Commodity)' },
      { href: '/portfolio/diary', label: "Trader's Diary", desc: 'Weekly & monthly P&L calendar, streaks, in-profit days' },
      { href: '/portfolio/weekly-target', label: 'Weekly Target', desc: 'Track progress against a recurring weekly profit goal' },
      { href: '/portfolio/stats', label: 'P&L Stats', desc: 'FY performance vs starting capital — month grid, win rate, equity curve' },
      { href: '/performance', label: 'Performance', desc: 'Historical backtests & drawdown statistics' },
      { href: '/reports', label: 'Reports', desc: 'Trade journals & execution logs' },
    ],
  },
];

const STORAGE_KEY = 'dhan-sidebar-collapsed';
const EXPANDED_W = 220;
const COLLAPSED_W = 56;

/** True only once mounted on the client — used to defer the portal (needs
 * `document`) and localStorage read past hydration without a setState-in-effect. */
function useMounted() {
  return useSyncExternalStore(() => () => {}, () => true, () => false);
}

function readStoredCollapsed(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === '1';
  } catch {
    return true;
  }
}

/** Which top-level group (by label) contains the current route — that group
 * starts expanded so the active page's section is never hidden on load. */
function findActiveGroupLabel(pathname: string): string | null {
  return NAV_GROUPS.find((g) => g.links.some((l) => l.href === pathname))?.label ?? null;
}

export default function Sidebar() {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';
  const mounted = useMounted();
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const [openGroups, setOpenGroups] = useState(() => {
    const active = findActiveGroupLabel(pathname);
    return active ? new Set([active]) : new Set<string>();
  });

  // Sidebar is mounted once in the root layout, so it persists across every
  // client-side navigation — re-derive (rather than only initialize) which
  // group should be open whenever the route changes, so navigating into a
  // page whose section is currently collapsed doesn't hide it. Adjusted
  // during render (React's documented pattern for this) rather than in an
  // effect, so it takes effect in the same commit as the route change.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    const active = findActiveGroupLabel(pathname);
    if (active) {
      setOpenGroups((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
    }
  }

  useEffect(() => {
    if (!mounted || isLoginPage) return;
    const w = collapsed ? COLLAPSED_W : EXPANDED_W;
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
    return () => {
      document.documentElement.style.setProperty('--sidebar-w', '0px');
    };
  }, [collapsed, mounted, isLoginPage]);

  const isGroupActive = (group: typeof NAV_GROUPS[0]) =>
    group.links.some((link) => link.href === pathname);

  const setGroupOpen = (label: string, open: boolean) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(label); else next.delete(label);
      return next;
    });
  };

  /** Collapsed rail has no room for a submenu — expand the rail and open
   * that group's section instead of trying to render a tree at 56px. */
  const expandAndOpenGroup = (label: string) => {
    setCollapsed(false);
    setGroupOpen(label, true);
  };

  if (!mounted || isLoginPage) return null;

  const sidebar = (
    <aside
      className="fixed inset-y-0 left-0 z-40 flex flex-col bg-zinc-950/60 backdrop-blur-md border-r border-zinc-850 shadow-lg shadow-black/30 transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? COLLAPSED_W : EXPANDED_W }}
    >
      <div className={cn("flex items-center h-11 shrink-0 border-b border-zinc-850/80 px-2", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && (
          <span className="text-[11px] font-bold tracking-wide text-zinc-100 pl-1.5">DHAN ALGO</span>
        )}
        <Tooltip>
          <TooltipTrigger
            onClick={() => setCollapsed((c) => !c)}
            render={
              <button
                className="flex items-center justify-center h-6 w-6 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              />
            }
          >
            {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? 'Expand' : 'Collapse'}</TooltipContent>
        </Tooltip>
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-1.5 flex flex-col gap-0.5 px-1.5">
        {NAV_GROUPS.map((group) => {
          const Icon = group.icon;
          const active = isGroupActive(group);

          // Collapsed rail: no room to show a tree at 56px, so a click just
          // expands the rail and opens this group's section instead.
          if (collapsed) {
            return (
              <Tooltip key={group.label}>
                <TooltipTrigger
                  onClick={() => expandAndOpenGroup(group.label)}
                  render={
                    <button
                      aria-label={group.label}
                      className={cn(
                        "flex items-center justify-center h-8 rounded-lg transition-all duration-150 outline-none cursor-pointer select-none border",
                        active
                          ? "bg-emerald-500/20 border-emerald-500/50"
                          : "border-transparent hover:bg-zinc-800/40 hover:border-zinc-700/40"
                      )}
                    />
                  }
                >
                  <Icon className={cn("h-4 w-4 shrink-0 transition-colors duration-150", active ? "text-emerald-800 dark:text-emerald-400" : "text-zinc-200 dark:text-zinc-400")} />
                </TooltipTrigger>
                <TooltipContent side="right">{group.label}</TooltipContent>
              </Tooltip>
            );
          }

          const open = openGroups.has(group.label);

          return (
            <Collapsible
              key={group.label}
              open={open}
              onOpenChange={(o) => setGroupOpen(group.label, o)}
            >
              <CollapsibleTrigger
                render={
                  <button
                    className={cn(
                      "group flex items-center gap-2 w-full rounded-lg px-2 py-1.8 text-xs font-medium transition-all duration-150 outline-none cursor-pointer select-none border",
                      active
                        ? "bg-emerald-500/20 text-zinc-100 dark:text-emerald-300 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.06)] font-semibold"
                        : "border-transparent text-zinc-100 dark:text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40 hover:border-zinc-700/40"
                    )}
                  />
                }
              >
                <Icon className={cn("h-4 w-4 shrink-0 transition-colors duration-150", active ? "text-emerald-800 dark:text-emerald-400" : "text-zinc-200 dark:text-zinc-400")} />
                <span className={cn("truncate", active ? "text-zinc-100 dark:text-emerald-300 font-semibold" : "text-zinc-100 dark:text-zinc-200 font-medium")}>
                  {group.label}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className={cn("ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform duration-150", open && "rotate-90")}
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-0.5 pt-0.5 pb-0.5">
                  {group.links.map((link) => {
                    const isLinkActive = pathname === link.href;
                    return (
                      <Tooltip key={link.href}>
                        <TooltipTrigger
                          render={
                            <Link
                              href={link.href}
                              className={cn(
                                "flex items-center gap-2 rounded-lg py-1.25 pr-2 pl-7 text-xs font-medium transition-all duration-150 border",
                                isLinkActive
                                  ? "bg-emerald-500/15 text-emerald-950 dark:text-emerald-300 border-emerald-500/30 font-semibold"
                                  : "border-transparent text-zinc-200 dark:text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40"
                              )}
                            />
                          }
                        >
                          <span className="truncate">{link.label}</span>
                          {isLinkActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-500 animate-pulse shrink-0" />}
                        </TooltipTrigger>
                        {link.desc && <TooltipContent side="right">{link.desc}</TooltipContent>}
                      </Tooltip>
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </nav>
    </aside>
  );

  return createPortal(sidebar, document.body);
}
