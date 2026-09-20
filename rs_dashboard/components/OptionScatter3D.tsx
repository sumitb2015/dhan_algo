'use client';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useChartChrome } from '@/lib/chartTheme';
import {
  buildPoints, clamp, clipRange, topByGoal, computeChainSummary,
  type OcEntry, type ScatterPoint, type Goal, type Signal, type ChainSummary,
} from '@/lib/optionScatter3d';
import { CAMERAS, SIGNALS, cmp, type CameraView, type ColorMode, type MoneynessFilter, type SideFilter } from './option-cube/shared';
import { buildScene } from './option-cube/buildScene';
import { ControlBar, SignalPills } from './option-cube/ControlBar';
import { ViewportToolbar } from './option-cube/ViewportToolbar';
import { HoverCard } from './option-cube/HoverCard';
import { InspectorCard } from './option-cube/InspectorCard';
import { CandidatesTable } from './option-cube/CandidatesTable';
import { Guide } from './option-cube/Guide';
import type { PlotlyRoot } from 'plotly.js-gl3d-dist-min';

interface Props {
  underlying: string;
  expiry: string;
  onMeta?: (m: { spot: number; updatedAt: number; count: number; summary?: ChainSummary | null }) => void;
}

interface ChainRes {
  success: boolean;
  data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
  error?: string;
}

const POLL_MS = 15_000;

export default function OptionScatter3D({ underlying, expiry, onMeta }: Props) {
  const chrome = useChartChrome();
  const plotEl = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<typeof import('plotly.js-gl3d-dist-min').default | null>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);

  // Data state
  const [oc, setOc] = useState<Record<string, OcEntry> | null>(null);
  const [spot, setSpot] = useState(0);
  const [error, setError] = useState('');
  const [renderError, setRenderError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);

  // Primary Controls
  const [goal, setGoal] = useState<Goal>('buy');
  const [colorMode, setColorMode] = useState<ColorMode>('signal');
  const [strikeWindow, setStrikeWindow] = useState(15);
  const [minOiPct, setMinOiPct] = useState(2);
  const [minLtp, setMinLtp] = useState(3);
  const [clip, setClip] = useState(true);

  // Granular Filter Controls
  const [sideFilter, setSideFilter] = useState<SideFilter>('ALL');
  const [moneynessFilter, setMoneynessFilter] = useState<MoneynessFilter>('ALL');
  const [selectedSignals, setSelectedSignals] = useState<Set<Signal>>(new Set(SIGNALS));

  // Layer Visibility
  const [showStems, setShowStems] = useState(true);
  const [showZeroPlanes, setShowZeroPlanes] = useState(true);
  const [showFloorShadow, setShowFloorShadow] = useState(true);

  // Interaction & UI State
  const [selected, setSelected] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [isOrbiting, setIsOrbiting] = useState(false);
  const [dragMode, setDragMode] = useState<'turntable' | 'orbit'>('turntable');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [tableSortCol, setTableSortCol] = useState<string>('score');
  const [tableSortAsc, setTableSortAsc] = useState(false);

  // ── Load Plotly dynamically (client-side only) ──
  useEffect(() => {
    let alive = true;
    import('plotly.js-gl3d-dist-min').then(m => {
      if (!alive) return;
      plotlyRef.current = m.default ?? (m as unknown as typeof m.default);
      setPlotlyReady(true);
    }).catch(e => setError(`Failed to load 3D engine: ${String(e)}`));
    return () => { alive = false; };
  }, []);

  // ── Poll Option Chain ──
  const seq = useRef(0);
  const inflight = useRef(false);
  const load = useCallback(async () => {
    if (!expiry || inflight.current) return;
    inflight.current = true;
    const mine = ++seq.current;
    try {
      const res = await fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}`, { cache: 'no-store' });
      const j = await res.json() as ChainRes;
      if (mine !== seq.current) return;
      if (!j.success || !j.data?.chain?.oc) {
        setError(j.error ?? 'No chain data available');
        return;
      }
      setError('');
      setOc(j.data.chain.oc);
      setUpdatedAt(Date.now());
      if (j.data.spot > 0) setSpot(j.data.spot);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      inflight.current = false;
    }
  }, [underlying, expiry]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [load]);

  // ── Compute Points & Chain Summary ──
  const rawPoints = useMemo<ScatterPoint[]>(
    () => (oc && spot > 0 ? buildPoints(oc, { spot, strikeWindow, minOiPct, minLtp }) : []),
    [oc, spot, strikeWindow, minOiPct, minLtp],
  );

  const chainSummary = useMemo<ChainSummary | null>(
    () => (oc && spot > 0 ? computeChainSummary(oc, spot) : null),
    [oc, spot],
  );

  useEffect(() => {
    if (spot > 0 && oc) {
      onMeta?.({ spot, updatedAt, count: Object.keys(oc).length, summary: chainSummary });
    }
  }, [spot, oc, updatedAt, chainSummary, onMeta]);

  // Filtered points
  const points = useMemo<ScatterPoint[]>(() => {
    return rawPoints.filter(p => {
      if (sideFilter !== 'ALL' && p.side !== sideFilter) return false;
      if (selectedSignals.size < SIGNALS.length && !selectedSignals.has(p.signal)) return false;
      if (moneynessFilter !== 'ALL' && p.moneyness !== moneynessFilter) return false;
      return true;
    });
  }, [rawPoints, sideFilter, selectedSignals, moneynessFilter]);

  const scoreOf = useCallback((p: ScatterPoint) => (goal === 'buy' ? p.buyScore : p.sellScore), [goal]);

  // Sorted candidates for the table
  const candidates = useMemo(() => {
    const list = topByGoal(points, goal, 20);
    const value = (p: ScatterPoint): number | string => {
      switch (tableSortCol) {
        case 'strike': return p.strike;
        case 'side': return p.side;
        case 'ltp': return p.ltp;
        case 'priceChg': return p.priceChg;
        case 'oi': return p.oi;
        case 'oiChg': return p.oiChg;
        case 'iv': return p.iv;
        case 'ivResidual': return p.ivResidual;
        case 'delta': return p.delta ?? 0;
        case 'signal': return p.signal;
        default: return scoreOf(p) ?? -1;
      }
    };
    return [...list].sort((a, b) => (tableSortAsc ? 1 : -1) * cmp(value(a), value(b)));
  }, [points, goal, tableSortCol, tableSortAsc, scoreOf]);

  // Axes bounds
  const axes = useMemo(() => ({
    x: clipRange(points.map(p => p.priceChg), clip),
    y: clipRange(points.map(p => p.oiChg), clip),
    z: clipRange(points.map(p => p.iv), clip),
  }), [points, clip]);

  // Selected item reference
  const selectedPoint = useMemo(() => {
    return selected ? rawPoints.find(p => p.key === selected) ?? null : null;
  }, [selected, rawPoints]);

  // Hovered item reference
  const hoveredPoint = useMemo(() => {
    return hoveredKey ? rawPoints.find(p => p.key === hoveredKey) ?? null : null;
  }, [hoveredKey, rawPoints]);

  // Tooltip position is applied straight to the element: it follows the cursor
  // without re-rendering this whole component on every mouse move.
  const hudRef = useRef<HTMLDivElement | null>(null);
  const lastMouse = useRef({ x: 0, y: 0 });
  const placeHud = useCallback(() => {
    const hud = hudRef.current;
    const box = viewportRef.current;
    if (!hud || !box) return;
    const r = box.getBoundingClientRect();
    const x = clamp(lastMouse.current.x - r.left + 16, 12, r.width - hud.offsetWidth - 12);
    const y = clamp(lastMouse.current.y - r.top + 16, 12, r.height - hud.offsetHeight - 12);
    hud.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  // ── Auto-Orbit / Turntable 360° Animation ──
  const orbitAngleRef = useRef(0);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    if (!isOrbiting || !plotlyReady || !Plotly || !el) {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      return;
    }

    let lastTime = performance.now();
    const radius = 2.4;
    const zHeight = 0.95;

    const step = (now: number) => {
      if (!isOrbiting) return;
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      orbitAngleRef.current += dt * 0.28; // ~16 deg/sec
      const x = radius * Math.cos(orbitAngleRef.current);
      const y = radius * Math.sin(orbitAngleRef.current);

      Plotly.relayout(el, {
        'scene.camera.eye': { x, y, z: zHeight },
      }).catch(() => {});

      animFrameRef.current = requestAnimationFrame(step);
    };

    animFrameRef.current = requestAnimationFrame(step);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isOrbiting, plotlyReady]);

  // ── Preset Camera View Transitions ──
  const setCameraView = (view: CameraView) => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    if (!el || !Plotly) return;
    setIsOrbiting(false);
    Plotly.relayout(el, { 'scene.camera': CAMERAS[view] }).catch(() => {});
  };

  // ── High-Res Snapshot Export ──
  const handleDownloadSnapshot = async () => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    if (!el || !Plotly) return;
    try {
      await Plotly.downloadImage(el, {
        format: 'png',
        width: 1920,
        height: 1080,
        filename: `${underlying}_${expiry}_OptionCube3D`,
      });
    } catch (err) {
      console.error('Failed to export 3D image', err);
    }
  };

  // ── Toggle Fullscreen ──
  const toggleFullscreen = () => setIsFullscreen(prev => !prev);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // ── Next / Previous Strike Navigation ──
  const navigateStrike = (direction: 'prev' | 'next') => {
    if (!selectedPoint) return;
    const sameSide = rawPoints
      .filter(p => p.side === selectedPoint.side)
      .sort((a, b) => a.strike - b.strike);
    const currIdx = sameSide.findIndex(p => p.key === selectedPoint.key);
    if (currIdx === -1) return;
    const nextIdx = direction === 'next'
      ? Math.min(sameSide.length - 1, currIdx + 1)
      : Math.max(0, currIdx - 1);
    setSelected(sameSide[nextIdx].key);
  };

  const copySymbol = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }).catch(() => { /* clipboard blocked (insecure context / permission) */ });
  };

  // ── Render Plotly 3D Scene ──
  useEffect(() => {
    const Plotly = plotlyRef.current;
    const el = plotEl.current;
    if (!plotlyReady || !Plotly || !el) return;

    const { traces, layout } = buildScene({
      points, axes, colorMode, goal, scoreOf, showStems, showZeroPlanes, showFloorShadow,
      selected, chrome, viewKey: `${underlying}|${expiry}`, dragMode,
    });

    Plotly.react(el, traces, layout, {
      responsive: true,
      displaylogo: false,
      displayModeBar: false, // We supply our own high-polish quant toolbar
    }).then(() => {
      setRenderError('');
      try { Plotly.Plots.resize(el); } catch { /* ignore */ }
      const g = el as PlotlyRoot;
      g.removeAllListeners?.('plotly_click');
      g.removeAllListeners?.('plotly_hover');
      g.removeAllListeners?.('plotly_unhover');

      g.on?.('plotly_click', d => {
        const key = d.points?.[0]?.customdata;
        if (typeof key === 'string') setSelected(prev => (prev === key ? null : key));
      });

      g.on?.('plotly_hover', d => {
        const key = d.points?.[0]?.customdata;
        if (typeof key !== 'string') return;
        if (d.event) lastMouse.current = { x: d.event.clientX, y: d.event.clientY };
        setHoveredKey(key);
      });

      g.on?.('plotly_unhover', () => setHoveredKey(null));
    }).catch(e => setRenderError(`3D view failed to render — is WebGL enabled? (${String(e)})`));
  }, [
    plotlyReady, points, axes, colorMode, goal, scoreOf, selected, chrome, underlying, expiry,
    showStems, showZeroPlanes, showFloorShadow, dragMode,
  ]);

  // ── Auto-resize Plotly when container width changes (100% responsive) ──
  useEffect(() => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    if (!el || !Plotly || !plotlyReady) return;

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        try {
          Plotly.Plots.resize(el);
        } catch {
          // ignore before canvas ready
        }
      });
    });

    ro.observe(el);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [plotlyReady]);

  useEffect(() => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    return () => { if (el && Plotly) Plotly.purge(el); };
  }, [plotlyReady]);

  const clippedTotal = axes.x.clipped + axes.y.clipped + axes.z.clipped;

  // Toggle signal filter helper
  const toggleSignal = (s: Signal) => {
    setSelectedSignals(prev => {
      const next = new Set(prev);
      if (next.has(s)) {
        if (next.size > 1) next.delete(s); // Keep at least one
      } else {
        next.add(s);
      }
      return next;
    });
  };

  const handleTableSort = (col: string) => {
    if (tableSortCol === col) {
      setTableSortAsc(prev => !prev);
    } else {
      setTableSortCol(col);
      setTableSortAsc(false);
    }
  };

  return (
    <div className={`flex flex-col gap-4 w-full min-w-0 ${isFullscreen ? 'fixed inset-0 z-50 bg-zinc-950 p-6 overflow-y-auto' : ''}`}>
      <ControlBar
        goal={goal} setGoal={setGoal} colorMode={colorMode} setColorMode={setColorMode}
        sideFilter={sideFilter} setSideFilter={setSideFilter}
        moneynessFilter={moneynessFilter} setMoneynessFilter={setMoneynessFilter}
        strikeWindow={strikeWindow} setStrikeWindow={setStrikeWindow}
        minOiPct={minOiPct} setMinOiPct={setMinOiPct} minLtp={minLtp} setMinLtp={setMinLtp}
        clip={clip} setClip={setClip}
      />

      <SignalPills
        selectedSignals={selectedSignals} toggleSignal={toggleSignal}
        pointCount={points.length} clip={clip} clippedTotal={clippedTotal}
      />

      {/* ── 3D Viewport with Quant Toolbars & HUD ── */}
      <div
        ref={viewportRef}
        className="relative bg-zinc-900/80 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl w-full min-w-0"
        onMouseMove={e => {
          lastMouse.current = { x: e.clientX, y: e.clientY };
          placeHud();
        }}
        onMouseLeave={() => setHoveredKey(null)}
      >
        <ViewportToolbar
          setCameraView={setCameraView} isOrbiting={isOrbiting} setIsOrbiting={setIsOrbiting}
          dragMode={dragMode} setDragMode={setDragMode} showStems={showStems} setShowStems={setShowStems}
          showZeroPlanes={showZeroPlanes} setShowZeroPlanes={setShowZeroPlanes}
          showFloorShadow={showFloorShadow} setShowFloorShadow={setShowFloorShadow}
          isFullscreen={isFullscreen} onSnapshot={handleDownloadSnapshot} onToggleFullscreen={toggleFullscreen}
        />
        {/* ── 3D Canvas ── */}
        <div
          ref={plotEl}
          className="w-full min-w-0 block"
          style={{ width: '100%', height: isFullscreen ? 'calc(100vh - 120px)' : 'max(760px, calc(100vh - 200px))' }}
        />

        {/* Empty / Loading State */}
        {!points.length && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400 pointer-events-none">
            {error ? '' : oc ? 'No strikes pass the active filters — adjust Min OI / Min ₹ / Filters' : 'Loading option chain data…'}
          </div>
        )}

        {/* ── Floating Strike Hover Tooltip HUD (Active on Cursor Hover) ── */}
        {hoveredPoint && (
          <div
            ref={el => { hudRef.current = el; if (el) placeHud(); }}
            className="absolute left-0 top-0 z-30 pointer-events-none"
          >
            <HoverCard point={hoveredPoint} />
          </div>
        )}

        {selectedPoint && (
          <InspectorCard
            point={selectedPoint} goal={goal} score={scoreOf(selectedPoint)} copied={copiedKey}
            onCopy={() => copySymbol(`${underlying} ${selectedPoint.strike} ${selectedPoint.side}`)}
            onNavigate={navigateStrike}
            onClose={() => setSelected(null)}
          />
        )}

        {/* Bottom Chart Footer Legend Note */}
        <div className="px-4 py-2 bg-zinc-950/90 border-t border-zinc-800/80 flex items-center justify-between text-[11px] text-zinc-400 flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span><b>X:</b> Premium Chg (%)</span>
            <span><b>Y:</b> OI Chg (%)</span>
            <span><b>Z:</b> Implied Volatility (IV %)</span>
            <span><b>Size:</b> Open Interest (OI)</span>
          </div>
          <span className="text-zinc-500">
            Drag to orbit · Scroll to zoom · Click point to inspect · Double click to reset
          </span>
        </div>
      </div>

      {(error || renderError) && (
        <div className="px-4 py-2.5 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-400">
          {error || renderError}
        </div>
      )}

      <CandidatesTable
        candidates={candidates} goal={goal} selected={selected}
        sortCol={tableSortCol} sortAsc={tableSortAsc} scoreOf={scoreOf}
        onSelect={key => setSelected(prev => (prev === key ? null : key))}
        onSort={handleTableSort}
      />

      <Guide />
    </div>
  );
}
