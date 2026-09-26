'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Zap,
  ChevronUp,
  ChevronDown,
  Layers,
  Calendar,
  PieChart,
  ListTree,
  ExternalLink,
  Maximize2,
  Minimize2,
  X,
  TrendingDown,
  Flame,
  LayoutGrid,
} from 'lucide-react';
import NavBar from '@/components/NavBar';
import CumulativeOiWidget from '@/components/scalpCockpit/CumulativeOiWidget';
import OpenInterestStrikesWidget from '@/components/scalpCockpit/OpenInterestStrikesWidget';
import VixWidget from '@/components/scalpCockpit/VixWidget';
import StraddleDecayWidget from '@/components/scalpCockpit/StraddleDecayWidget';
import OiQuadrantsWidget from '@/components/scalpCockpit/OiQuadrantsWidget';
import MultiLegFocus from '@/components/MultiLegFocus';
import MultiLegOptionChainModal from '@/components/multiLegFocus/MultiLegOptionChainModal';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
type Underlying = typeof UNDERLYINGS[number];

type ViewMode = 'balanced' | 'trader' | 'analytics';

interface ToolWindow {
  id: 'expiryAnalysis' | 'distribution';
  title: string;
  url: string;
  maximized: boolean;
}

export default function ScalpCockpit() {
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [isChangingUnderlying, setIsChangingUnderlying] = useState(false);
  const [telemetryCollapsed, setTelemetryCollapsed] = useState(false);
  const [tradeDeskCollapsed, setTradeDeskCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('balanced');

  const handleSelectUnderlying = useCallback((next: Underlying) => {
    if (next === underlying) return;
    setIsChangingUnderlying(true);
    setUnderlying(next);
    setSelectedExpiry('');
    setActiveSpot(0);
    setAtmStrike(0);
    setSharedChainOc(null);
    setTimeout(() => {
      setIsChangingUnderlying(false);
    }, 700);
  }, [underlying]);

  // Option Chain Modal & Shared Expiries state
  const [isOptionChainOpen, setIsOptionChainOpen] = useState(false);
  const [expiriesMap, setExpiriesMap] = useState<Record<string, string[]>>({});

  // Shared options telemetry state across widgets to eliminate duplicate fetches & rate limits
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');
  const [activeSpot, setActiveSpot] = useState<number>(0);
  const [atmStrike, setAtmStrike] = useState<number>(0);
  const [sharedChainOc, setSharedChainOc] = useState<Record<string, any> | null>(null);

  // Active floating/docked tool windows
  const [activeWindows, setActiveWindows] = useState<ToolWindow[]>([]);

  // Extra widgets toggle in telemetry row
  const [showSecondaryGrid, setShowSecondaryGrid] = useState(false);

  // Fetch expiries ONLY for the active underlying on mount or switch (never burst 5 calls!)
  useEffect(() => {
    if (expiriesMap[underlying]?.length) {
      if (!selectedExpiry || !expiriesMap[underlying].includes(selectedExpiry)) {
        setSelectedExpiry(expiriesMap[underlying][0]);
      }
      return;
    }
    fetch(`/api/options/expiries?underlying=${underlying}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data?.length) {
          setExpiriesMap(prev => ({ ...prev, [underlying]: j.data! }));
          setSelectedExpiry(prev => (j.data!.includes(prev) ? prev : j.data![0]));
        }
      })
      .catch(() => {});
  }, [underlying, expiriesMap, selectedExpiry]);

  const isTraderFocus = viewMode === 'trader' || telemetryCollapsed;
  const isAnalyticsFocus = viewMode === 'analytics' || tradeDeskCollapsed;

  const handleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'trader') {
      setTelemetryCollapsed(true);
      setTradeDeskCollapsed(false);
    } else if (mode === 'analytics') {
      setTelemetryCollapsed(false);
      setTradeDeskCollapsed(true);
    } else {
      setTelemetryCollapsed(false);
      setTradeDeskCollapsed(false);
    }
  };

  const handleChainLoaded = useCallback((oc: Record<string, any>, spot: number, atm: number, exp: string) => {
    setSharedChainOc(oc);
    setActiveSpot(spot);
    setAtmStrike(atm);
    setSelectedExpiry(exp);
  }, []);

  // Multi-tab interactive tool window state
  const [activeWindowTab, setActiveWindowTab] = useState<'expiryAnalysis' | 'distribution'>('expiryAnalysis');
  const [windowMaximized, setWindowMaximized] = useState(false);

  const openToolWindow = (id: 'expiryAnalysis' | 'distribution', title: string, url: string) => {
    setActiveWindows(prev => {
      const exists = prev.find(w => w.id === id);
      if (exists) return prev;
      return [...prev, { id, title, url, maximized: false }];
    });
    setActiveWindowTab(id);
  };

  const closeToolWindow = (id: 'expiryAnalysis' | 'distribution') => {
    setActiveWindows(prev => {
      const remaining = prev.filter(w => w.id !== id);
      if (remaining.length > 0 && activeWindowTab === id) {
        setActiveWindowTab(remaining[0].id);
      }
      return remaining;
    });
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      {/* ── STICKY PAGE HEADER (z-30 per dhan-page-theme) ────────────── */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-4 py-2 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        {/* Left: Domain Accent Tile & Title */}
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Zap className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-400">
                Trading · Scalp Cockpit
              </p>
              <span className="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                Tight Layout
              </span>
            </div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Fast Scalper Desk
            </h1>
          </div>
        </div>

        {/* Center: Underlying Tabs, Option Chain, & Tool Windows Buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Underlying Selector */}
          <div className="flex items-center gap-0.5 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800">
            {UNDERLYINGS.map(u => {
              const isSelected = underlying === u;
              const isThisLoading = isSelected && isChangingUnderlying;
              return (
                <button
                  key={u}
                  type="button"
                  onClick={() => handleSelectUnderlying(u)}
                  className={`px-2 py-0.5 text-[11px] font-bold rounded transition-colors inline-flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-zinc-700 text-white shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                  title={`Switch Scalp Cockpit to ${u}`}
                >
                  {isThisLoading && (
                    <span className="w-2 h-2 rounded-full border border-current border-t-transparent animate-spin" />
                  )}
                  <span>{u}</span>
                </button>
              );
            })}
          </div>

          {/* Option Chain Button */}
          <button
            type="button"
            onClick={() => setIsOptionChainOpen(true)}
            className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-[11px] font-bold text-zinc-300 hover:text-white transition-colors"
            title="Open Option Chain with Greeks (Delta, Theta, Gamma, Vega, IV)"
          >
            <ListTree className="w-3.5 h-3.5 text-violet-400" />
            <span>Option Chain</span>
          </button>

          {/* Quick Window Buttons */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openToolWindow('expiryAnalysis', 'Expiry Analysis', '/expiry-analysis')}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
                activeWindows.some(w => w.id === 'expiryAnalysis')
                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-sm'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
              title="Open Expiry Analysis interactive window"
            >
              <Calendar className="w-3.5 h-3.5 text-sky-400" />
              <span>Expiry Analysis</span>
              {activeWindows.some(w => w.id === 'expiryAnalysis') && (
                <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              )}
            </button>

            <button
              type="button"
              onClick={() => openToolWindow('distribution', 'Returns Distribution', '/distribution')}
              className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg border text-[11px] font-bold transition-colors ${
                activeWindows.some(w => w.id === 'distribution')
                  ? 'bg-purple-500/20 text-purple-300 border-purple-500/40 shadow-sm'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
              title="Open Returns Distribution interactive window"
            >
              <PieChart className="w-3.5 h-3.5 text-purple-400" />
              <span>Distribution</span>
              {activeWindows.some(w => w.id === 'distribution') && (
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
              )}
            </button>
          </div>
        </div>

        {/* Right: View Mode, Controls, and NavBar */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* View Mode Segmented Control */}
          <div className="hidden lg:flex items-center gap-0.5 bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 text-[11px]">
            <button
              type="button"
              onClick={() => handleViewMode('balanced')}
              className={`px-2 py-0.5 font-bold rounded transition-colors ${
                viewMode === 'balanced'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Balanced: Telemetry charts + Trading desk"
            >
              Balanced
            </button>
            <button
              type="button"
              onClick={() => handleViewMode('trader')}
              className={`px-2 py-0.5 font-bold rounded transition-colors ${
                viewMode === 'trader'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Trader Focus: Collapse telemetry for maximum order space"
            >
              Execution
            </button>
            <button
              type="button"
              onClick={() => handleViewMode('analytics')}
              className={`px-2 py-0.5 font-bold rounded transition-colors ${
                viewMode === 'analytics'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Analytics Focus: Full-grid analytics with collapsed trade desk"
            >
              Analytics Grid
            </button>
          </div>

          {/* Quick Collapse/Expand Telemetry Strip Button */}
          <button
            type="button"
            onClick={() => setTelemetryCollapsed(prev => !prev)}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-[11px] font-semibold text-zinc-300 hover:text-white transition-colors"
            title={telemetryCollapsed ? 'Show Telemetry Strip' : 'Hide Telemetry Strip'}
          >
            {telemetryCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-emerald-400" /> : <ChevronUp className="w-3.5 h-3.5 text-zinc-400" />}
            <span className="hidden sm:inline">{telemetryCollapsed ? 'Telemetry' : 'Compact'}</span>
          </button>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />

          {/* NavBar is always rendered last inside the header per dhan-page-theme */}
          <NavBar />
        </div>
      </div>

      {/* ── TOP MARKET TELEMETRY ROW (3 CORE WINDOWS) ────────────────── */}
      {!isTraderFocus && (
        <div className="relative border-b border-zinc-800/80 bg-zinc-950/70 p-2.5">
          {/* Active Underlying Transition Shimmer Line */}
          {isChangingUnderlying && (
            <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse z-10" />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5">
            {/* Window 1: Cumulative OI & Regime (1/3 width) */}
            <div className={isAnalyticsFocus ? 'h-[260px]' : 'h-[210px]'}>
              <CumulativeOiWidget underlying={underlying} />
            </div>

            {/* Window 2: Open Interest Across Strikes & Delta with Slider (1/3 width) */}
            <div className={isAnalyticsFocus ? 'h-[260px]' : 'h-[210px]'}>
              <OpenInterestStrikesWidget
                underlying={underlying}
                expiriesProp={expiriesMap[underlying]}
                selectedExpiryProp={selectedExpiry}
                onExpiryChange={setSelectedExpiry}
                onChainLoaded={handleChainLoaded}
              />
            </div>

            {/* Window 3: India VIX 1-min Chart (1/3 width) */}
            <div className={isAnalyticsFocus ? 'h-[260px]' : 'h-[210px]'}>
              <VixWidget />
            </div>
          </div>

          {/* Secondary Grid Toggle Strip */}
          <div className="mt-2 pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={() => setShowSecondaryGrid(v => !v)}
              className="flex items-center gap-1.5 text-zinc-400 hover:text-zinc-200 font-bold uppercase tracking-wider"
            >
              <LayoutGrid className="w-3 h-3 text-emerald-400" />
              <span>{showSecondaryGrid ? 'Hide Straddle & Quadrants Grid' : 'Show Straddle Decay & OI Quadrants Grid'}</span>
              {showSecondaryGrid ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            <span className="text-[10px] text-zinc-500">
              {showSecondaryGrid ? 'Expanded 5-widget analytics view' : 'Click to display ATM Straddle Decay & OI Buildup Quadrants'}
            </span>
          </div>

          {/* Secondary Analytics Grid (Straddle Decay + OI Quadrants) */}
          {(showSecondaryGrid || isAnalyticsFocus) && (
            <div className="mt-2.5 grid grid-cols-1 lg:grid-cols-12 gap-2.5">
              {/* Window 4: ATM Straddle Premium Decay Curve */}
              <div className="lg:col-span-6 h-[215px]">
                <StraddleDecayWidget
                  underlying={underlying}
                  atmStrikeProp={atmStrike}
                  expiryProp={selectedExpiry}
                />
              </div>

              {/* Window 5: OI Buildup Quadrants */}
              <div className="lg:col-span-6 h-[215px]">
                <OiQuadrantsWidget
                  underlying={underlying}
                  chainOc={sharedChainOc}
                  expiry={selectedExpiry}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Collapsed Telemetry Summary Strip */}
      {isTraderFocus && (
        <div className="flex items-center justify-between px-3 py-1 bg-zinc-900/60 border-b border-zinc-800 text-[11px] text-zinc-400">
          <div className="flex items-center gap-3">
            <span className="text-zinc-500 font-bold uppercase tracking-wider text-[10px]">Telemetry Mini-Bar:</span>
            <span className="flex items-center gap-1 font-mono font-bold text-zinc-200">
              {underlying}
            </span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-400">Cumulative OI, Strikes OI &amp; VIX collapsed for maximum execution view</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setTelemetryCollapsed(false);
              setViewMode('balanced');
            }}
            className="flex items-center gap-1 text-[10px] font-bold text-emerald-400 hover:text-emerald-300"
          >
            <span>Expand Telemetry Strip</span>
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ── LOWER SECTION: COLLAPSIBLE FAST SCALPING TRADING DESK ───── */}
      <div className="flex-1 flex flex-col w-full bg-zinc-950">
        {/* Collapsible Section Header Bar */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/80 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTradeDeskCollapsed(prev => !prev)}
              className="flex items-center gap-1.5 text-xs font-bold text-white hover:text-emerald-400 transition-colors uppercase tracking-wider"
              title={tradeDeskCollapsed ? 'Expand Trading Desk' : 'Collapse Trading Desk'}
            >
              {tradeDeskCollapsed ? (
                <ChevronDown className="w-4 h-4 text-emerald-400" />
              ) : (
                <ChevronUp className="w-4 h-4 text-zinc-400" />
              )}
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>Multi-Leg Trade Desk</span>
            </button>
            <span className="text-[10px] text-zinc-400 font-semibold">
              (Compact Scalper Mode · JSON Synced)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTradeDeskCollapsed(prev => !prev)}
              className="text-[10px] font-bold text-zinc-400 hover:text-white px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800"
            >
              {tradeDeskCollapsed ? 'Expand Desk' : 'Collapse Desk'}
            </button>
          </div>
        </div>

        {/* Collapsed Trade Desk Banner */}
        {tradeDeskCollapsed ? (
          <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/30 border-b border-zinc-800/80 text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-semibold text-zinc-300">Trade Execution Desk is collapsed.</span>
              <span className="text-zinc-500">Orders, legs, and payoff diagrams are running in the background.</span>
            </div>
            <button
              type="button"
              onClick={() => setTradeDeskCollapsed(false)}
              className="px-2.5 py-1 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
            >
              Open Trading Desk
            </button>
          </div>
        ) : (
          /* Expanded Compact Multi-Leg Focus Desk */
          <div className="flex-1 w-full overflow-hidden">
            <MultiLegFocus
              embedded={true}
              hideHeader={true}
              activeUnderlyingProp={underlying}
              onUnderlyingChangeProp={setUnderlying}
              expiriesMapProp={expiriesMap}
            />
          </div>
        )}
      </div>

      {/* ── OPTION CHAIN WITH GREEKS MODAL ──────────────────────────── */}
      {isOptionChainOpen && (
        <MultiLegOptionChainModal
          isOpen={isOptionChainOpen}
          onClose={() => setIsOptionChainOpen(false)}
          underlying={underlying}
          expiriesMap={expiriesMap}
        />
      )}

      {/* ── INTERACTIVE IN-APP TOOL WINDOWS (EXPIRY ANALYSIS & DISTRIBUTION) ─ */}
      {activeWindows.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className={`flex flex-col bg-zinc-900 border border-zinc-700/80 rounded-xl shadow-2xl overflow-hidden w-full transition-all duration-200 ${
              windowMaximized ? 'h-full max-h-full' : 'h-[85vh] max-w-6xl'
            }`}
          >
            {/* Header with tabs */}
            <div className="flex items-center justify-between px-3 py-2 bg-zinc-950 border-b border-zinc-800 select-none flex-wrap gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                {activeWindows.map(win => (
                  <div
                    key={win.id}
                    onClick={() => setActiveWindowTab(win.id)}
                    className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-xs font-bold cursor-pointer transition-colors ${
                      activeWindowTab === win.id
                        ? 'bg-zinc-800 text-white shadow-sm border border-zinc-700'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-transparent'
                    }`}
                  >
                    {win.id === 'expiryAnalysis' ? (
                      <Calendar className="w-3.5 h-3.5 text-sky-400" />
                    ) : (
                      <PieChart className="w-3.5 h-3.5 text-purple-400" />
                    )}
                    <span>{win.title}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeToolWindow(win.id);
                      }}
                      className="ml-1 p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-white"
                      title={`Close ${win.title}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                {/* Pop out to external tab */}
                {activeWindows.find(w => w.id === activeWindowTab) && (
                  <a
                    href={activeWindows.find(w => w.id === activeWindowTab)!.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-6 px-2 inline-flex items-center gap-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-[10px] font-bold text-zinc-300 hover:text-white"
                    title="Open active tool in a browser tab"
                  >
                    <span>New Tab</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}

                {/* Maximize / Restore */}
                <button
                  type="button"
                  onClick={() => setWindowMaximized(v => !v)}
                  className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white"
                  title={windowMaximized ? 'Restore Window Size' : 'Maximize Window'}
                >
                  {windowMaximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                </button>

                {/* Close All */}
                <button
                  type="button"
                  onClick={() => setActiveWindows([])}
                  className="p-1 rounded bg-zinc-900 hover:bg-rose-900/60 border border-zinc-700 hover:border-rose-700 text-zinc-400 hover:text-rose-200"
                  title="Close Tools Window"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Iframes kept warm in DOM */}
            <div className="flex-1 w-full bg-zinc-950 relative">
              {activeWindows.map(win => (
                <iframe
                  key={win.id}
                  src={win.url}
                  title={win.title}
                  className={`w-full h-full border-0 absolute inset-0 ${
                    activeWindowTab === win.id ? 'opacity-100 z-10 pointer-events-auto' : 'opacity-0 -z-10 pointer-events-none'
                  }`}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
