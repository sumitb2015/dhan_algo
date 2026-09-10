'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import QuikTradeQuadrants from './QuikTradeQuadrants';
import QuikTradePositions from './QuikTradePositions';
import NavBar from './NavBar';

const UNDERLYING = 'NIFTY';
const PNL_POLL_MS = 5_000;

interface PortfolioResponse {
  success: boolean;
  total_realized_pnl?: number;
  total_unrealized_pnl?: number;
  total_pnl?: number;
  error?: string;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? '+' : '') + '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function QuikTradeTab() {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [expiriesLoading, setExpiriesLoading] = useState(false);
  const [expiriesError, setExpiriesError] = useState('');

  const [pnl, setPnl] = useState<PortfolioResponse | null>(null);
  const [dataUpdated, setDataUpdated] = useState('');
  const pnlIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pnlInFlightRef = useRef(false);

  useEffect(() => {
    setExpiriesLoading(true);
    fetch(`/api/options/expiries?underlying=${UNDERLYING}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[]; error?: string }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(j.data[0]);
        } else {
          setExpiriesError(j.error ?? 'Failed to load expiries');
        }
      })
      .catch(e => setExpiriesError(String(e)))
      .finally(() => setExpiriesLoading(false));
  }, []);

  const fetchPnl = useCallback(async () => {
    if (pnlInFlightRef.current) return;
    pnlInFlightRef.current = true;
    try {
      const res  = await fetch('/api/portfolio');
      const json = await res.json() as PortfolioResponse;
      if (json.success) {
        setPnl(json);
        setDataUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      }
      // keep last-known P&L when the route reports success: false
    } catch {
      // keep last-known P&L on transient failure
    } finally {
      pnlInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchPnl();
    pnlIntervalRef.current = setInterval(fetchPnl, PNL_POLL_MS);
    return () => { if (pnlIntervalRef.current) clearInterval(pnlIntervalRef.current); };
  }, [fetchPnl]);

  const totalPnl = pnl?.success ? (pnl.total_pnl ?? 0) : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">QuikTrade</h1>
            <p className="text-[10px] text-zinc-400 font-medium">OI buildup quadrants &amp; live trading terminal</p>
          </div>


          {totalPnl !== null && (
            <div className={`text-[11px] font-bold px-2.5 py-1 rounded-lg border tabular-nums flex items-center gap-1.5 shrink-0 ${
              totalPnl > 0
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : totalPnl < 0
                  ? 'bg-red-500/10 text-red-400 border-red-500/20'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400'
            }`}>
              <span className="text-[9px] uppercase text-zinc-500 font-extrabold tracking-wider">P&amp;L:</span>
              <span>{fmtPnl(totalPnl)}</span>
            </div>
          )}

          {dataUpdated && (
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
              DATA: {dataUpdated}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wide">Expiry</label>
          <select
            value={expiry}
            onChange={e => setExpiry(e.target.value)}
            disabled={expiriesLoading}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-zinc-200 disabled:opacity-50"
          >
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-5 px-6 py-5">
        {expiriesError && (
          <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
            {expiriesError}
          </div>
        )}

        <QuikTradeQuadrants expiry={expiry} />
        <QuikTradePositions />
      </div>
    </div>
  );
}
