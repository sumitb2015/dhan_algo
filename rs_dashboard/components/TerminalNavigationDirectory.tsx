'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  BarChart2,
  BookOpen,
  Bot,
  Briefcase,
  Calendar,
  ChevronRight,
  Compass,
  Cpu,
  Crosshair,
  DollarSign,
  ExternalLink,
  Flame,
  Gauge,
  Grid,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  PieChart,
  Radar,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  Target,
  Terminal as TerminalIcon,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
  Zap,
} from 'lucide-react';

// ─── Data Types ───────────────────────────────────────────────────────────────

export interface TerminalDeskItem {
  name: string;
  href: string;
  badge?: string;
  desc: string;
  hot?: boolean;
}

export interface TerminalPillarGroup {
  id: string;
  title: string;
  shortLabel: string;
  tagline: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'emerald' | 'amber' | 'sky' | 'indigo' | 'purple';
  items: TerminalDeskItem[];
}

// ─── Authoritative 5 Quantitative Pillars ─────────────────────────────────────

export const TERMINAL_PILLARS: TerminalPillarGroup[] = [
  {
    id: 'desks',
    title: 'Execution & Scalping Desks',
    shortLabel: 'TRADING DESKS',
    tagline: 'Ultra-low latency multi-broker execution & order management',
    icon: Zap,
    tone: 'emerald',
    items: [
      {
        name: 'Pro Scalper Terminal',
        href: '/scalper',
        badge: 'PRIMARY',
        desc: '1-Click fast execution across Dhan, Zerodha and Kotak Neo with hotkeys',
        hot: true,
      },
      {
        name: 'Advanced Scalper',
        href: '/advanced-scalper',
        badge: 'PRO',
        desc: 'Market depth ladder, bracket order controls, auto-hedging and trailing',
        hot: true,
      },
      {
        name: 'Options QuikTrade',
        href: '/options/quiktrade',
        badge: 'FAST',
        desc: 'Rapid strike entry, ATM quick buy/sell and instant square-off',
        hot: true,
      },
      {
        name: 'Intraday Fast Terminal',
        href: '/terminal',
        desc: 'Cash equities and index futures real-time momentum order book',
      },
      {
        name: 'Focus VWAP Desk',
        href: '/focus-tool',
        desc: 'Intraday equity & futures momentum scanner with VWAP distance',
      },
      {
        name: 'Multi-Leg Spreads & Baskets',
        href: '/baskets',
        desc: 'Pre-packaged option spreads, margin optimizer, and basket execution',
      },
      {
        name: 'Multi-Leg Focus Desk',
        href: '/multi-leg-focus',
        desc: 'Real-time multi-broker margin utilization & multi-leg execution monitor',
      },
    ],
  },
  {
    id: 'options',
    title: 'Options & Volatility Analytics',
    shortLabel: 'OPTIONS & VOL',
    tagline: 'Straddles, strangles, Greeks, IV surface & open interest velocity',
    icon: Radar,
    tone: 'amber',
    items: [
      {
        name: 'Options Analytics Hub',
        href: '/options-analytics',
        badge: 'CORE',
        desc: 'Real-time Greeks, strike-by-strike PCR, max pain, and live strike heatmaps',
        hot: true,
      },
      {
        name: 'Combined Premium Bar',
        href: '/options/premium-bar',
        badge: 'VOL',
        desc: 'Intraday combined ATM Straddle & Strangle premium compression & decay tracker',
        hot: true,
      },
      {
        name: 'Live Straddle Analysis',
        href: '/straddle-analysis',
        desc: 'Real-time ATM straddle decay vs intraday expected move cone',
      },
      {
        name: 'Strangle Volatility Tracking',
        href: '/strangle-analysis',
        desc: 'OTM strangle premium decay, delta imbalance, and strike roll alerts',
      },
      {
        name: 'Cross-Expiry Straddle Matrix',
        href: '/straddle-matrix',
        desc: 'Multi-strike & multi-expiry ATM straddle pricing & IV term structure',
      },
      {
        name: 'Live Candlestick & OI Charts',
        href: '/options/live-charts',
        desc: 'Lightweight candlestick charts with real-time Open Interest overlays',
      },
      {
        name: 'Implied Volatility (IV) Surface',
        href: '/iv-charts',
        desc: 'Historical IV percentiles, IV rank, and volatility smile comparison',
      },
      {
        name: 'Trending Open Interest',
        href: '/trending-oi',
        badge: 'REALTIME',
        desc: 'Second-by-second OI velocity (PE vs CE buildup) detecting institutional sweeps',
      },
      {
        name: 'Strike OI Concentration Profile',
        href: '/nifty-oi-profile',
        desc: 'Strike-by-strike open interest walls, shifts, and pin levels',
      },
      {
        name: 'Historical Expiry Move Analysis',
        href: '/expiry-analysis',
        desc: 'Statistical expiry-day range distributions, settlement pin risk & moves',
      },
      {
        name: 'MCX Crude Oil Desk',
        href: '/options/crudeoil',
        badge: 'COMMODITY',
        desc: 'Crude oil futures, options chain, inventory cycle, and OI trends',
      },
      {
        name: 'Cash-Secured Puts (CSP) Hub',
        href: '/cash-secured-puts',
        badge: 'INCOME',
        desc: 'Systematic high-probability options income selling on bluechip equities',
      },
      {
        name: 'Portfolio Delta Neutral',
        href: '/options/delta',
        desc: 'Portfolio delta exposure, dynamic beta-weighted hedging, and drift alerts',
      },
      {
        name: 'Strategy Payoff Analyzer',
        href: '/options/analyzer',
        desc: 'Multi-leg option payoff graphs, Greek sensitivity, and scenario testing',
      },
    ],
  },
  {
    id: 'screening',
    title: 'Technical Screening & Regimes',
    shortLabel: 'SCREENERS & RS',
    tagline: 'Relative Strength, momentum leaders, breadth & order flow',
    icon: Compass,
    tone: 'sky',
    items: [
      {
        name: 'Market Movers Terminal',
        href: '/movers',
        badge: 'KEY',
        desc: 'Top gainers, losers, volume surge multipliers, and NR7 compression breakout setups',
        hot: true,
      },
      {
        name: 'RS Movers Plus',
        href: '/movers-plus',
        desc: 'Relative Strength ranked market movers with sector participation',
      },
      {
        name: 'Mansfield RS Momentum Scanner',
        href: '/scanner',
        badge: 'ALPHA',
        desc: 'Institutional Relative Strength ranking against Nifty 50 and Nifty 500',
        hot: true,
      },
      {
        name: 'Ultimate Multi-Factor Screener',
        href: '/ultimate-scanner',
        desc: 'Multi-condition screener: EMAs (20/50/200), 52W Highs, RSI, and Mansfield RS',
      },
      {
        name: 'Relative Rotation Graphs (RRG)',
        href: '/rrg',
        desc: 'Sector & stock rotation across Leading, Weakening, Lagging, and Improving quadrants',
      },
      {
        name: 'Market Breadth Sentiment',
        href: '/breadth',
        badge: 'MACRO',
        desc: 'Nifty 50 & 500 advance/decline breadth, % above 20/50/200-day EMAs',
      },
      {
        name: 'Intraday Tick Breadth',
        href: '/breadth-intraday',
        desc: 'Real-time cumulative tick breadth and advance-decline momentum',
      },
      {
        name: 'Sector Breadth Diffusion',
        href: '/diffusion',
        desc: 'Sectoral thrust and diffusion index measuring broad market participation depth',
      },
      {
        name: 'Institutional Distribution Days',
        href: '/distribution',
        desc: "O'Neil distribution vs accumulation days tracking market top risk",
      },
      {
        name: 'Seasonality Edge Analytics',
        href: '/seasonality',
        desc: 'Historical day-of-week and month-of-year seasonal edge statistics',
      },
      {
        name: 'Pre-Market Setup & Global Cues',
        href: '/premarket',
        desc: 'Gift Nifty, Asian markets, US ADRs, and expected opening gap calculations',
      },
      {
        name: 'Volume Footprint & Order Flow',
        href: '/volume-footprint',
        badge: 'FLOW',
        desc: 'Intrabar order flow footprint, point of control (POC), and delta imbalance',
      },
      {
        name: 'Key Levels & Pivot Matrix',
        href: '/level-chart',
        desc: 'Automatic detection of previous day high/low, CPR, and pivot levels',
      },
      {
        name: 'Mega-Cap Technicals',
        href: '/top-mcap-charts',
        desc: 'High-beta index heavyweights multi-timeframe technical charts',
      },
      {
        name: 'Equity Watchlist',
        href: '/equity-watchlist',
        desc: 'Custom price and volume alert watchlist for intraday setups',
      },
    ],
  },
  {
    id: 'algos',
    title: 'Algorithmic Trading Systems',
    shortLabel: 'ALGO TRADING',
    tagline: 'Autonomous execution bots, strategy testing & portfolio automation',
    icon: Bot,
    tone: 'indigo',
    items: [
      {
        name: 'Algo Trading Bots Desk',
        href: '/strategies',
        badge: 'LIVE',
        desc: 'Real-time bot controller, P&L tracking, adjustments counter, and shutdown triggers',
        hot: true,
      },
      {
        name: 'Multi-Broker Algo Desk',
        href: '/strategies-plus',
        desc: 'Cross-broker algorithmic strategy orchestrator and execution router',
      },
      {
        name: 'Quantitative Strategy Builder',
        href: '/strategy-builder',
        badge: 'BUILDER',
        desc: 'Visual rules designer, entry/exit criteria, and parameter tuner',
        hot: true,
      },
      {
        name: 'Historical Backtesting Engine',
        href: '/backtest',
        desc: 'Walk-forward equity curves, maximum drawdown, Sharpe, and win rates',
      },
      {
        name: 'Nifty 500 Momentum Portfolio',
        href: '/momentum',
        badge: 'CNC',
        desc: 'Systematic CNC positional equity momentum portfolio with weekly rotation',
      },
    ],
  },
  {
    id: 'portfolio',
    title: 'Portfolio, Audit & Trader Diary',
    shortLabel: 'PORTFOLIO & DIARY',
    tagline: 'Consolidated balance sheet, journaling, performance metrics & trade audit',
    icon: Wallet,
    tone: 'purple',
    items: [
      {
        name: 'Consolidated Balance Sheet',
        href: '/portfolio',
        badge: 'CAPITAL',
        desc: 'Multi-broker capital, collateral, utilized margin, and equity holdings',
        hot: true,
      },
      {
        name: 'Margin Allocator',
        href: '/margin-allocator',
        badge: 'YIELD',
        desc: 'Idle margin by broker, blocked margin by straddle/strangle/condor structure, and near-dated deployment plan',
        hot: true,
      },
      {
        name: "Trader's Diary & Journal",
        href: '/portfolio/diary',
        badge: 'DIARY',
        desc: 'Institutional trading journal with calendar heatmaps, win rates, and tags',
        hot: true,
      },
      {
        name: 'Performance Analytics & Risk',
        href: '/portfolio/stats',
        desc: 'Trade expectancy, average win/loss ratio, profit factor, and drawdowns',
      },
      {
        name: 'Real-Time Audit Tradebook',
        href: '/portfolio/trades',
        desc: 'Broker execution audit trail with timestamps, prices, and slippage',
      },
      {
        name: 'Weekly Compounding Target',
        href: '/portfolio/weekly-target',
        desc: 'Systematic 1-2% weekly compounding milestone and drawdown limit tracker',
      },
      {
        name: 'Institutional EOD Reports',
        href: '/reports',
        desc: 'Daily PDF and Excel trading recap, P&L attribution, and tax reports',
      },
    ],
  },
];

// Flat list for searching
const ALL_TERMINAL_ITEMS = TERMINAL_PILLARS.flatMap(pillar =>
  pillar.items.map(item => ({
    ...item,
    pillarId: pillar.id,
    pillarTitle: pillar.title,
    pillarTone: pillar.tone,
  }))
);

// ─── 1. Command Palette / Searchable Modal (⌘K / / / F9) ──────────────────────

export function TerminalCommandPaletteModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard navigation & Esc to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALL_TERMINAL_ITEMS.filter(item => {
      const matchCat = activeCategory === 'all' || item.pillarId === activeCategory;
      if (!matchCat) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.href.toLowerCase().includes(q) ||
        item.pillarTitle.toLowerCase().includes(q) ||
        (item.badge && item.badge.toLowerCase().includes(q))
      );
    });
  }, [query, activeCategory]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Search Header */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3.5 bg-zinc-900/70">
          <Search className="h-5 w-5 text-amber-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to any trading desk or analytics page (e.g. straddle, scalper, diary, crude, rrg, iv)..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="w-full bg-transparent font-mono text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-zinc-500 hover:text-zinc-300 p-1 rounded"
              title="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400 shrink-0">
            ESC TO CLOSE
          </span>
        </div>

        {/* Category Pills Bar */}
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950 px-4 py-2 text-xs font-mono">
          <button
            onClick={() => setActiveCategory('all')}
            className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors ${
              activeCategory === 'all'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            }`}
          >
            ALL DESKS ({ALL_TERMINAL_ITEMS.length})
          </button>
          {TERMINAL_PILLARS.map(p => (
            <button
              key={p.id}
              onClick={() => setActiveCategory(p.id)}
              className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors whitespace-nowrap ${
                activeCategory === p.id
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              {p.shortLabel} ({p.items.length})
            </button>
          ))}
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center font-mono text-zinc-500 text-xs">
              No matching desks or pages found for &quot;{query}&quot;. Try searching for &quot;options&quot;, &quot;scalper&quot;, or &quot;breadth&quot;.
            </div>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {filteredItems.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className="group flex flex-col justify-between rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 transition-all hover:border-amber-500/50 hover:bg-zinc-800/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-zinc-100 group-hover:text-amber-400 transition-colors">
                        {item.name}
                      </span>
                      {item.badge && (
                        <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.2 font-mono text-[9px] font-bold text-zinc-300">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-600 group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all shrink-0" />
                  </div>

                  <p className="mt-1 font-mono text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">
                    {item.desc}
                  </p>

                  <div className="mt-2 flex items-center justify-between border-t border-zinc-800/60 pt-1.5 font-mono text-[10px] text-zinc-500">
                    <span className="uppercase text-zinc-400 font-semibold">{item.pillarTitle}</span>
                    <span className="text-zinc-600 group-hover:text-zinc-400">{item.href}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Modal Footer Tip */}
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950 px-4 py-2 text-[10px] font-mono text-zinc-500">
          <span>Tip: Press <strong>⌘K</strong> or <strong>/</strong> anywhere on the terminal to open quick jump</span>
          <span>{filteredItems.length} destinations ready</span>
        </div>
      </div>
    </div>
  );
}

// ─── 2. Top Pillars Navigation Ribbon (Sub-Header Hub) ─────────────────────────

export function PillarsNavigationRibbon({
  onOpenDirectory,
}: {
  onOpenDirectory: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 overflow-x-auto border-b border-zinc-800/90 bg-zinc-950 px-6 py-2">
      <div className="flex items-center gap-1.5 text-xs font-mono shrink-0">
        <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-amber-500">
          SECTIONS:
        </span>
        {TERMINAL_PILLARS.map(p => {
          const Icon = p.icon;
          return (
            <a
              key={p.id}
              href={`#section-${p.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-zinc-300 transition-colors hover:border-amber-500/40 hover:bg-zinc-800 hover:text-white"
            >
              <Icon className="h-3 w-3 text-amber-400" />
              <span className="text-[11px] font-bold">{p.shortLabel}</span>
            </a>
          );
        })}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onOpenDirectory}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1 font-mono text-[11px] font-bold text-amber-400 hover:bg-amber-500/20 transition-colors shadow-sm cursor-pointer"
        >
          <Grid className="h-3.5 w-3.5 text-amber-400" />
          <span>DIRECTORY</span>
          <span className="rounded bg-amber-500/20 px-1 py-0.2 text-[9px] text-amber-300">
            ⌘K
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── 3. In-Section Contextual Toolbars ─────────────────────────────────────────

export function SectionQuickLinks({
  links,
  categoryLabel,
}: {
  links: { label: string; href: string; badge?: string }[];
  categoryLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-zinc-800/80 bg-zinc-900/30 px-3 py-2 text-xs font-mono">
      {categoryLabel && (
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 mr-1">
          {categoryLabel}:
        </span>
      )}
      {links.map(l => (
        <Link
          key={l.href}
          href={l.href}
          className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-zinc-300 transition-colors hover:border-amber-500/40 hover:bg-zinc-800 hover:text-amber-300"
        >
          <span>{l.label}</span>
          {l.badge && (
            <span className="rounded bg-zinc-800 px-1 py-0.2 text-[8px] font-bold text-zinc-400">
              {l.badge}
            </span>
          )}
          <ArrowRight className="h-2.5 w-2.5 text-zinc-500" />
        </Link>
      ))}
    </div>
  );
}

// ─── 4. Full Institutional Terminal Site Directory (Bottom Grid) ───────────────

export function TerminalSiteDirectory({
  onOpenDirectory,
}: {
  onOpenDirectory: () => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
            <LayoutGrid className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-100">
              Institutional Terminal Navigation Hub
            </h2>
            <p className="font-mono text-[10px] text-zinc-400">
              Direct access to all 35+ quantitative desks, analytics suites, and execution systems
            </p>
          </div>
        </div>

        <button
          onClick={onOpenDirectory}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-[11px] font-bold text-zinc-300 hover:border-amber-500/40 hover:text-amber-400 transition-colors"
        >
          <Search className="h-3 w-3 text-amber-400" />
          <span>SEARCH DIRECTORY (⌘K)</span>
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {TERMINAL_PILLARS.map(pillar => {
          const Icon = pillar.icon;
          return (
            <div
              key={pillar.id}
              className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 shadow-sm"
            >
              <div className="flex items-center gap-2 border-b border-zinc-800/80 pb-2 mb-2.5">
                <Icon className="h-4 w-4 text-amber-400 shrink-0" />
                <div className="truncate">
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-zinc-100">
                    {pillar.shortLabel}
                  </span>
                  <div className="text-[10px] font-mono text-zinc-500 truncate">
                    {pillar.items.length} tools
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                {pillar.items.map(item => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex flex-col rounded-lg border border-transparent p-1.5 transition-colors hover:border-zinc-800 hover:bg-zinc-900/60"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-[11px] font-semibold text-zinc-200 group-hover:text-amber-400 transition-colors truncate">
                        {item.name}
                      </span>
                      {item.badge && (
                        <span className="rounded bg-zinc-800 px-1 py-0.2 font-mono text-[8px] font-bold text-zinc-400 shrink-0">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-zinc-500 truncate group-hover:text-zinc-400 transition-colors">
                      {item.desc}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
