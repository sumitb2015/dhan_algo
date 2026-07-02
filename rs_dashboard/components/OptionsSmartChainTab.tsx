'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────

interface RawChainSide {
  last_price?: number;
  oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
}

interface RawChainEntry { ce?: RawChainSide; pe?: RawChainSide }

interface ProcessedRow {
  strike: number;
  ce: RawChainSide | null;
  pe: RawChainSide | null;
  ceOIPct: number;
  peOIPct: number;
  pcr: number | null;
  ivSkew: number | null;   // CE IV − PE IV
  straddle: number;        // CE LTP + PE LTP
  isATM: boolean;
  isMaxCEOI: boolean;
  isMaxPEOI: boolean;
  isMinStraddle: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const POLL_MS     = 15_000;

const WING_OPTIONS = [5, 10, 15] as const;
type Wings = typeof WING_OPTIONS[number];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  if (n === 0) return '—';
  const abs  = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${sign}${(abs / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtLTP(n: number | undefined): string {
  if (!n) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtIV(n: number | undefined): string {
  if (!n) return '—';
  return `${n.toFixed(1)}%`;
}

function fmtPCR(n: number | null): string {
  if (n === null) return '—';
  return n.toFixed(2);
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

interface StrikeEntry { key: string; strike: number; entry: RawChainEntry }

function parseStrikeEntries(oc: Record<string, RawChainEntry>): StrikeEntry[] {
  return Object.entries(oc)
    .map(([key, entry]) => ({ key, strike: Number(key), entry }))
    .filter(x => !isNaN(x.strike))
    .sort((a, b) => a.strike - b.strike);
}

function computeMaxPain(entries: StrikeEntry[]): number {
  if (!entries.length) return 0;
  let maxPain = entries[0].strike;
  let minPayout = Infinity;
  for (const { strike: K } of entries) {
    let payout = 0;
    for (const { strike: s, entry } of entries) {
      // CE holders at strike s gain max(0, K - s) if expiry is at K
      payout += (entry.ce?.oi ?? 0) * Math.max(0, K - s);
      // PE holders at strike s gain max(0, s - K) if expiry is at K
      payout += (entry.pe?.oi ?? 0) * Math.max(0, s - K);
    }
    if (payout < minPayout) { minPayout = payout; maxPain = K; }
  }
  return maxPain;
}

// ─── Sub-components ───────────────────────────────────────────────

function StatChip({ label, value, color = 'text-white' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col px-4 border-r border-zinc-800 last:border-r-0">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
    </div>
  );
}

function PCRPill({ pcr }: { pcr: number | null }) {
  if (pcr === null) return <span className="text-zinc-600 text-xs">—</span>;
  const cls = pcr > 1.3
    ? 'bg-emerald-500/20 text-emerald-400'
    : pcr < 0.7
      ? 'bg-red-500/20 text-red-400'
      : 'bg-amber-500/20 text-amber-400';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold tabular-nums ${cls}`}>
      {fmtPCR(pcr)}
    </span>
  );
}

// OI% mini bar — fills from right for CE side, left for PE side
function OIBar({ pct, side }: { pct: number; side: 'ce' | 'pe' }) {
  const barColor = side === 'ce' ? 'rgba(59,130,246,0.35)' : 'rgba(239,68,68,0.35)';
  const width = `${Math.min(pct, 100)}%`;
  return (
    <div className="relative h-4 w-full min-w-[48px]">
      {side === 'ce' ? (
        <div
          className="absolute inset-y-0 right-0 rounded-sm"
          style={{ width, backgroundColor: barColor }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-sm"
          style={{ width, backgroundColor: barColor }}
        />
      )}
      <span className={`relative z-10 text-xs tabular-nums font-bold text-zinc-200 ${side === 'ce' ? 'float-right' : 'float-left'}`}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsSmartChainTab({ expiry }: { expiry: string }) {
  const [rows, setRows]               = useState<ProcessedRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [chainPCR, setChainPCR]       = useState<number | null>(null);
  const [maxPain, setMaxPain]         = useState<number | null>(null);
  const [totalCEOI, setTotalCEOI]     = useState(0);
  const [totalPEOI, setTotalPEOI]     = useState(0);
  const [atmStraddle, setAtmStraddle] = useState<number | null>(null);
  const [wings, setWings]             = useState<Wings>(10);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchChain = useCallback(async () => {
    if (!expiry) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, RawChainEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      // Parse all strikes, preserving original keys for correct lookups
      const allEntries = parseStrikeEntries(oc);

      // Max pain over full chain
      const mpStrike = computeMaxPain(allEntries);

      // Find ATM index and slice visible window
      const atmIdx  = allEntries.reduce((best, { strike }, i) =>
        Math.abs(strike - atmStrike) < Math.abs(allEntries[best].strike - atmStrike) ? i : best, 0);
      const lo      = Math.max(0, atmIdx - wings);
      const hi      = Math.min(allEntries.length - 1, atmIdx + wings);
      const visible = allEntries.slice(lo, hi + 1);

      // Totals and max-OI detection over visible window
      let totCE = 0, totPE = 0;
      let maxCEOI = 0, maxPEOI = 0, maxCEStrike = 0, maxPEStrike = 0;
      for (const { strike, entry } of visible) {
        const ceOI = entry.ce?.oi ?? 0;
        const peOI = entry.pe?.oi ?? 0;
        totCE += ceOI;
        totPE += peOI;
        if (ceOI > maxCEOI) { maxCEOI = ceOI; maxCEStrike = strike; }
        if (peOI > maxPEOI) { maxPEOI = peOI; maxPEStrike = strike; }
      }

      // First pass: compute straddle per row, find min straddle strike
      const straddleMap = new Map<number, number>();
      let minStraddle = Infinity, minStraddleStrike = 0;
      for (const { strike, entry } of visible) {
        const s = (entry.ce?.last_price ?? 0) + (entry.pe?.last_price ?? 0);
        straddleMap.set(strike, s);
        if (s > 0 && s < minStraddle) { minStraddle = s; minStraddleStrike = strike; }
      }

      const processed: ProcessedRow[] = visible.map(({ strike, entry }) => {
        const ce    = entry.ce ?? null;
        const pe    = entry.pe ?? null;
        const ceOI  = ce?.oi ?? 0;
        const peOI  = pe?.oi ?? 0;
        const ceIV  = ce?.implied_volatility ?? 0;
        const peIV  = pe?.implied_volatility ?? 0;
        const strad = straddleMap.get(strike) ?? 0;
        return {
          strike,
          ce,
          pe,
          ceOIPct:       maxCEOI > 0 ? (ceOI / maxCEOI) * 100 : 0,
          peOIPct:       maxPEOI > 0 ? (peOI / maxPEOI) * 100 : 0,
          pcr:           ceOI > 0 ? peOI / ceOI : null,
          ivSkew:        (ceIV > 0 || peIV > 0) ? ceIV - peIV : null,
          straddle:      strad,
          isATM:         strike === atmStrike,
          isMaxCEOI:     strike === maxCEStrike && maxCEOI > 0,
          isMaxPEOI:     strike === maxPEStrike && maxPEOI > 0,
          isMinStraddle: strike === minStraddleStrike && minStraddle < Infinity,
        };
      });

      // ATM straddle for expected move
      const atmRow = processed.find(r => r.isATM);
      const atmStrad = atmRow ? atmRow.straddle : null;

      setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(processed);
      setTotalCEOI(totCE);
      setTotalPEOI(totPE);
      setChainPCR(totCE > 0 ? totPE / totCE : null);
      setMaxPain(mpStrike);
      setAtmStraddle(atmStrad && atmStrad > 0 ? atmStrad : null);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry, wings]);

  // Initial fetch + polling
  useEffect(() => {
    fetchChain();
    intervalRef.current = setInterval(fetchChain, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchChain]);

  const pcrColor = chainPCR === null ? 'text-white'
    : chainPCR > 1.3 ? 'text-emerald-400'
    : chainPCR < 0.7 ? 'text-red-400'
    : 'text-amber-400';

  // TH classes
  const thCls = 'text-xs font-bold text-white bg-zinc-800 px-3 py-2 whitespace-nowrap';

  return (
    <div className="flex flex-col gap-3">

      {/* Status bar */}
      <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-xl px-2 py-3 flex-wrap gap-y-2">
        <StatChip label="Spot"         value={spot ? `₹${spot.toLocaleString('en-IN')}` : '—'} />
        <StatChip label="ATM"          value={atm  ? fmtStrike(atm) : '—'} />
        <StatChip label="Chain PCR"    value={chainPCR !== null ? chainPCR.toFixed(2) : '—'} color={pcrColor} />
        <StatChip label="Max Pain"     value={maxPain !== null ? fmtStrike(maxPain) : '—'} color="text-violet-300" />
        <StatChip label="Total CE OI"  value={fmtOI(totalCEOI)} color="text-blue-400" />
        <StatChip label="Total PE OI"  value={fmtOI(totalPEOI)} color="text-red-400" />
        <StatChip
          label="Exp Move (±)"
          value={atmStraddle ? `±${atmStraddle.toFixed(0)}` : '—'}
          color="text-cyan-300"
        />
        {atmStraddle && atm ? (
          <div className="flex flex-col px-4 border-r border-zinc-800">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Range</span>
            <span className="text-sm font-bold tabular-nums text-cyan-300">
              {(atm - atmStraddle).toFixed(0)}–{(atm + atmStraddle).toFixed(0)}
            </span>
          </div>
        ) : null}
        <StatChip
          label="OI Delta (CE−PE)"
          value={(totalCEOI === 0 && totalPEOI === 0) ? '—' : (totalCEOI - totalPEOI >= 0 ? '+' : '') + fmtOI(totalCEOI - totalPEOI)}
          color={totalCEOI - totalPEOI > 0 ? 'text-red-400' : totalCEOI - totalPEOI < 0 ? 'text-emerald-400' : 'text-zinc-300'}
        />
        <div className="flex flex-col px-4">
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Updated</span>
          <span className="text-sm font-bold tabular-nums text-zinc-300">{lastUpdated ?? '—'}</span>
        </div>
        {loading && (
          <div className="ml-auto pr-4">
            <span className="text-[10px] text-zinc-500 animate-pulse">Refreshing…</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-zinc-400 font-semibold">Strikes:</span>
        {WING_OPTIONS.map(w => (
          <button
            key={w}
            onClick={() => setWings(w)}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
              wings === w
                ? 'bg-blue-600 text-white'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
            }`}
          >
            ±{w}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-zinc-600">Auto-refresh: 15s</span>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      {/* Chain table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              {/* CE side headers */}
              <th className={`${thCls} text-right text-blue-300`}>CE OI</th>
              <th className={`${thCls} text-right text-blue-300`}>CE OI ▌</th>
              <th className={`${thCls} text-right text-blue-300`}>CE IV</th>
              <th className={`${thCls} text-right text-blue-300`}>CE LTP</th>
              {/* Center */}
              <th className={`${thCls} text-center text-amber-300 border-x border-zinc-700`}>STRIKE</th>
              <th className={`${thCls} text-center text-cyan-300`}>STRADDLE</th>
              <th className={`${thCls} text-center text-violet-300`}>IV SKEW</th>
              <th className={`${thCls} text-center`}>PCR</th>
              {/* PE side headers */}
              <th className={`${thCls} text-left text-red-300`}>PE LTP</th>
              <th className={`${thCls} text-left text-red-300`}>PE IV</th>
              <th className={`${thCls} text-left text-red-300`}>PE OI ▌</th>
              <th className={`${thCls} text-left text-red-300`}>PE OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const isITM_CE = row.strike < spot && spot > 0;
              const isITM_PE = row.strike > spot && spot > 0;

              const ceDim  = isITM_CE ? 'text-zinc-400' : 'text-white';
              const peDim  = isITM_PE ? 'text-zinc-400' : 'text-white';

              const ceBg   = row.ce?.oi ? `rgba(59,130,246,${Math.min(row.ceOIPct * 0.006, 0.55)})` : 'transparent';
              const peBg   = row.pe?.oi ? `rgba(239,68,68,${Math.min(row.peOIPct * 0.006, 0.55)})` : 'transparent';

              const rowBg  = row.isATM
                ? 'bg-amber-500/10'
                : 'bg-zinc-950 hover:bg-zinc-900/60';

              const rowBorderL = row.isATM
                ? 'border-l-2 border-l-amber-400'
                : row.isMaxCEOI
                  ? 'border-l-4 border-l-blue-400'
                  : '';

              const rowBorderR = row.isMaxPEOI
                ? 'border-r-4 border-r-red-400'
                : '';

              return (
                <tr
                  key={row.strike}
                  className={`transition-colors border-b border-zinc-800/60 last:border-b-0 ${rowBg} ${rowBorderL} ${rowBorderR}`}
                >
                  {/* CE OI */}
                  <td className="px-3 py-2 text-right" style={{ backgroundColor: ceBg }}>
                    <div className="flex items-center justify-end gap-1.5">
                      {row.isMaxCEOI && (
                        <span className="text-[10px] font-bold text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">MAX</span>
                      )}
                      <span className={`tabular-nums font-bold ${ceDim}`}>
                        {fmtOI(row.ce?.oi ?? 0)}
                      </span>
                    </div>
                  </td>

                  {/* CE OI% bar */}
                  <td className="px-3 py-2 w-24">
                    <OIBar pct={row.ceOIPct} side="ce" />
                  </td>

                  {/* CE IV */}
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${isITM_CE ? 'text-zinc-500' : 'text-violet-200'}`}>
                    {fmtIV(row.ce?.implied_volatility ?? row.ce?.greeks?.iv)}
                  </td>

                  {/* CE LTP */}
                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${isITM_CE ? 'text-zinc-400' : 'text-white'}`}>
                    {fmtLTP(row.ce?.last_price)}
                  </td>

                  {/* Strike */}
                  <td className={`px-4 py-2 text-center font-bold tabular-nums border-x border-zinc-700 ${
                    row.isATM ? 'text-amber-300 text-sm' : 'text-zinc-100'
                  }`}>
                    {fmtStrike(row.strike)}
                    {row.isATM && <span className="ml-1 text-[10px] text-amber-500">ATM</span>}
                  </td>

                  {/* Straddle */}
                  <td className="px-3 py-2 text-center">
                    {row.straddle > 0 ? (
                      <div className="flex items-center justify-center gap-1">
                        <span className="tabular-nums font-bold text-cyan-200">
                          ₹{row.straddle.toFixed(1)}
                        </span>
                        {row.isMinStraddle && (
                          <span className="text-[10px] font-bold text-amber-400 bg-amber-500/20 px-1 py-0.5 rounded">MIN</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>

                  {/* IV Skew (CE IV − PE IV) */}
                  <td className="px-3 py-2 text-center">
                    {row.ivSkew !== null ? (
                      <span className={`tabular-nums font-bold text-xs ${
                        row.ivSkew > 0.5  ? 'text-emerald-400' :
                        row.ivSkew < -0.5 ? 'text-red-400' :
                        'text-zinc-400'
                      }`}>
                        {row.ivSkew > 0 ? '+' : ''}{row.ivSkew.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>

                  {/* PCR */}
                  <td className="px-3 py-2 text-center">
                    <PCRPill pcr={row.pcr} />
                  </td>

                  {/* PE LTP */}
                  <td className={`px-3 py-2 text-left tabular-nums font-bold ${isITM_PE ? 'text-zinc-400' : 'text-white'}`}>
                    {fmtLTP(row.pe?.last_price)}
                  </td>

                  {/* PE IV */}
                  <td className={`px-3 py-2 text-left tabular-nums font-bold ${isITM_PE ? 'text-zinc-500' : 'text-violet-200'}`}>
                    {fmtIV(row.pe?.implied_volatility ?? row.pe?.greeks?.iv)}
                  </td>

                  {/* PE OI% bar */}
                  <td className="px-3 py-2 w-24">
                    <OIBar pct={row.peOIPct} side="pe" />
                  </td>

                  {/* PE OI */}
                  <td className="px-3 py-2 text-left" style={{ backgroundColor: peBg }}>
                    <div className="flex items-center gap-1.5">
                      <span className={`tabular-nums font-bold ${peDim}`}>
                        {fmtOI(row.pe?.oi ?? 0)}
                      </span>
                      {row.isMaxPEOI && (
                        <span className="text-[10px] font-bold text-red-400 bg-red-500/20 px-1.5 py-0.5 rounded">MAX</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}

            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={12} className="text-center text-zinc-500 py-12">
                  {expiry ? 'No chain data available' : 'Select an expiry to load chain'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
