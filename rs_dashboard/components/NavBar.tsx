'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  TrendingUp,
  Layers,
  Activity,
  Cpu,
  Briefcase,
  ChevronDown,
  DatabaseZap,
  RefreshCw,
  LineChart,
  Zap,
} from 'lucide-react';
import { useRefreshStatus } from '@/lib/useRefreshStatus';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { buttonVariants } from './ui/button';
import DataRefreshPanel from './DataRefreshPanel';
import ThemeToggle from './ThemeToggle';

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


export default function NavBar() {
  const pathname = usePathname();
  const router   = useRouter();
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const sync = useRefreshStatus();

  async function handleDisconnect() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  const isGroupActive = (group: typeof NAV_GROUPS[0]) => {
    return group.links.some(link => link.href === pathname);
  };

  return (
    <>
    <div className="flex items-center bg-zinc-950/40 backdrop-blur-md border border-zinc-850 p-1 rounded-xl flex-wrap gap-1 shadow-lg shadow-black/30">
      {NAV_GROUPS.map((group) => {
        const Icon = group.icon;
        const active = isGroupActive(group);
        return (
          <DropdownMenu key={group.label}>
            <DropdownMenuTrigger
              render={
                <button
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.8 text-xs font-bold rounded-lg transition-all duration-200 outline-none border cursor-pointer select-none",
                    active
                      ? "bg-emerald-500/20 text-black dark:text-emerald-300 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.06)] font-extrabold"
                      : "border-transparent text-zinc-100 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-100 hover:bg-zinc-800/20 dark:hover:bg-zinc-800/40 hover:border-zinc-700/40"
                  )}
                />
              }
            >
              <Icon className={cn("h-3.5 w-3.5 transition-colors duration-200", active ? "text-emerald-800 dark:text-emerald-400" : "text-zinc-200 dark:text-zinc-400")} />
              <span className={cn(active ? "text-black dark:text-emerald-300 font-extrabold" : "text-zinc-100 dark:text-zinc-200 font-bold")}>{group.label}</span>
              <ChevronDown className={cn("h-3 w-3 opacity-80 transition-transform duration-200 group-hover:translate-y-0.5", active ? "text-emerald-800 dark:text-emerald-400" : "text-zinc-300 dark:text-zinc-400")} />
            </DropdownMenuTrigger>
            {/* Derivatives has grown past 20 entries — without a scroll cap the
                tail renders below the fold and is unreachable entirely. */}
            <DropdownMenuContent align="start" className="min-w-[240px] max-w-[280px] max-h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl p-1.5 gap-1 flex flex-col z-50">
              {group.links.map((link) => {
                const isLinkActive = pathname === link.href;
                return (
                  <DropdownMenuItem
                    key={link.href}
                    render={
                      <Link
                        href={link.href}
                        className="w-full flex flex-col items-start text-left cursor-pointer p-2 transition-all duration-150 rounded-lg"
                      />
                    }
                    className={cn(
                      "cursor-pointer text-zinc-100 dark:text-zinc-300 hover:text-black dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800",
                      isLinkActive && "bg-emerald-500/15 text-emerald-950 dark:text-emerald-300 hover:text-black dark:hover:text-emerald-200 hover:bg-emerald-500/20 focus:bg-emerald-500/20"
                    )}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className={cn("text-xs font-bold transition-colors", isLinkActive ? "text-emerald-950 dark:text-emerald-300 font-extrabold" : "text-zinc-100 dark:text-zinc-200")}>
                        {link.label}
                      </span>
                      {isLinkActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-500 animate-pulse" />}
                    </div>
                    {link.desc && (
                      <span className={cn("text-[10px] font-normal leading-tight mt-0.5 block transition-colors", isLinkActive ? "text-emerald-900 dark:text-emerald-400/70" : "text-zinc-400")}>
                        {link.desc}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      <span className="w-px h-5 bg-zinc-750 mx-1 shrink-0" />
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


