'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Sliders,
  Eye,
  Zap,
  Activity,
  Layers,
  HelpCircle,
  TrendingUp,
  CheckCircle,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import NavBar from './NavBar';
import ScannerStep from './ultimateScanner/ScannerStep';
import WatchlistStep from './ultimateScanner/WatchlistStep';
import WorkflowGuideStep from './ultimateScanner/WorkflowGuideStep';
import type {
  ScannedStrategy,
  WatchlistItem,
} from '@/lib/ultimateScannerTypes';
import type { MultiLegBasket } from '@/lib/multiLegFocus';

export default function UltimateScannerPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'scanner' | 'watchlist' | 'guide'>('scanner');
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'info' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Load Watchlist on Mount ─────────────────────────────────────────
  const fetchWatchlist = useCallback(async () => {
    try {
      const res = await fetch('/api/ultimate-scanner/watchlist');
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setWatchlist(data.data);
      }
    } catch (err) {
      console.error('Failed to load watchlist:', err);
    }
  }, []);

  useEffect(() => {
    fetchWatchlist();
  }, [fetchWatchlist]);

  // ── Add Item to Watchlist ───────────────────────────────────────────
  const handleAddToWatchlist = async (candidate: ScannedStrategy) => {
    try {
      const res = await fetch('/api/ultimate-scanner/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setWatchlist(data.data);
        showToast(`Added ${candidate.name} to Watchlist!`, 'success');
      }
    } catch (err) {
      showToast(`Failed to add to watchlist: ${String(err)}`, 'error');
    }
  };

  // ── Update Watchlist Item ───────────────────────────────────────────
  const handleUpdateItem = async (id: string, patch: Partial<WatchlistItem>) => {
    try {
      const res = await fetch('/api/ultimate-scanner/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, patch }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setWatchlist(data.data);
        showToast('Updated strategy rules', 'info');
      }
    } catch (err) {
      showToast(`Failed to update item: ${String(err)}`, 'error');
    }
  };

  // ── Delete Watchlist Item ───────────────────────────────────────────
  const handleDeleteItem = async (id: string) => {
    try {
      const res = await fetch(`/api/ultimate-scanner/watchlist?id=${id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setWatchlist(data.data);
        showToast('Removed strategy from Watchlist', 'info');
      }
    } catch (err) {
      showToast(`Failed to delete item: ${String(err)}`, 'error');
    }
  };

  // ── Bridge to Multi-Leg Focus ───────────────────────────────────────
  const handleTradeInMultiLegFocus = async (item: ScannedStrategy | WatchlistItem) => {
    try {
      showToast(`Preparing ${item.name} for Multi-Leg Focus...`, 'info');

      // 1. Map to MultiLegBasket format
      const basket: Partial<MultiLegBasket> = {
        name: item.name,
        underlying: item.underlying,
        expiry: item.expiry,
        broker: 'dhan',
        presetKey: item.type.replace(/_/g, '-'),
        legs: item.legs.map((leg, i) => ({
          id: String(i + 1),
          side: leg.side === 'SELL' ? 'S' : 'B',
          option: leg.option,
          strike: leg.strike,
          lots: leg.lots || 1,
          type: 'MARKET',
          status: 'DRAFT',
        })),
      };

      // 2. Save via Multi-Leg Focus API
      await fetch('/api/multi-leg-focus/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basket),
      });

      // 3. Seamless redirection to Multi-Leg Focus
      router.push('/multi-leg-focus');
    } catch (err) {
      showToast(`Failed to transfer to Multi-Leg Focus: ${String(err)}`, 'error');
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white font-sans">
      <NavBar />

      {/* ── Toast Notification ───────────────────────────────────────── */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 animate-bounce">
          <div
            className={`px-4 py-2.5 rounded-xl text-xs font-bold shadow-2xl flex items-center gap-2 border ${
              toast.type === 'success'
                ? 'bg-emerald-950/95 text-emerald-300 border-emerald-500/50'
                : toast.type === 'error'
                ? 'bg-red-950/95 text-red-300 border-red-500/50'
                : 'bg-zinc-900/95 text-zinc-200 border-zinc-700'
            }`}
          >
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            <span>{toast.message}</span>
          </div>
        </div>
      )}

      {/* ── Quant Terminal Sticky Header ─────────────────────────────── */}
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Layers className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
                Process Driven &bull; Options Strategy Discovery
              </span>
              <span className="text-amber-300 font-bold uppercase tracking-wide text-[10px] bg-amber-500/10 px-2 py-0.2 rounded border border-amber-500/20">
                DATA: {new Date().toISOString().split('T')[0]}
              </span>
            </div>
            <h1 className="text-base font-bold text-white tracking-tight leading-none mt-0.5">
              Ultimate Scanner
            </h1>
          </div>
        </div>

        {/* 3-Step Process Subpage Stepper */}
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-1 rounded-xl shadow-inner">
          <button
            onClick={() => setActiveTab('scanner')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'scanner'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/40'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            <span>Step 1: Scanner</span>
          </button>

          <button
            onClick={() => setActiveTab('watchlist')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'watchlist'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/40'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Step 2: Watchlist</span>
            {watchlist.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-zinc-950 text-emerald-400 font-extrabold border border-emerald-500/30">
                {watchlist.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('guide')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'guide'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/40'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>Process Guide</span>
          </button>
        </div>
      </div>

      {/* ── Main Tab Content ─────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col px-6 py-6 max-w-7xl mx-auto w-full">
        {activeTab === 'scanner' && (
          <ScannerStep
            onAddToWatchlist={handleAddToWatchlist}
            onTradeInMultiLegFocus={handleTradeInMultiLegFocus}
            onNavigateToWatchlist={() => setActiveTab('watchlist')}
            watchlistCount={watchlist.length}
          />
        )}

        {activeTab === 'watchlist' && (
          <WatchlistStep
            watchlist={watchlist}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={handleDeleteItem}
            onTradeInMultiLegFocus={handleTradeInMultiLegFocus}
            onNavigateToScanner={() => setActiveTab('scanner')}
            onRefresh={fetchWatchlist}
          />
        )}

        {activeTab === 'guide' && (
          <WorkflowGuideStep
            onNavigateToScanner={() => setActiveTab('scanner')}
            onNavigateToWatchlist={() => setActiveTab('watchlist')}
          />
        )}
      </main>
    </div>
  );
}
