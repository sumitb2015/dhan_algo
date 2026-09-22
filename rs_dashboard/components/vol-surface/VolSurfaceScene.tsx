'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw, Compass, Eye, ShieldAlert } from 'lucide-react';
import { useChartChrome } from '@/lib/chartTheme';
import type { VolSurfaceData } from '@/app/api/options/volatility-surface/route';
import {
  VOL_CAMERAS,
  COLOR_SCALES,
  type XAxisMode,
  type VolMetric,
  type ColorScale,
  type CameraPreset,
} from '@/lib/volatilitySurface';
import type { PlotlyRoot } from 'plotly.js-gl3d-dist-min';

interface Props {
  data: VolSurfaceData;
  xAxisMode: XAxisMode;
  volMetric: VolMetric;
  colorScale: ColorScale;
}

export default function VolSurfaceScene({ data, xAxisMode, volMetric, colorScale }: Props) {
  const chrome = useChartChrome();
  const plotEl = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotlyRef = useRef<typeof import('plotly.js-gl3d-dist-min').default | null>(null);
  const [plotlyReady, setPlotlyReady] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Invariant: Own the camera in a ref so user-dragged angles survive re-renders and polls
  const cameraRef = useRef<CameraPreset>(VOL_CAMERAS.iso);

  // 1. Dynamic import of Plotly WebGL (client-only)
  useEffect(() => {
    let alive = true;
    import('plotly.js-gl3d-dist-min')
      .then((m) => {
        if (!alive) return;
        plotlyRef.current = m.default;
        setPlotlyReady(true);
      })
      .catch((err) => {
        if (!alive) return;
        console.error('Failed to load Plotly WebGL module:', err);
        setRenderError('WebGL charting engine could not be loaded');
      });
    return () => {
      alive = false;
    };
  }, []);

  // 2. Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      try {
        await containerRef.current.requestFullscreen();
      } catch (err) {
        console.warn('Fullscreen request failed:', err);
      }
    } else {
      try {
        await document.exitFullscreen();
      } catch {}
    }
  };

  const applyCameraPreset = (preset: 'iso' | 'front' | 'side' | 'top') => {
    const cam = VOL_CAMERAS[preset];
    cameraRef.current = cam;
    if (plotEl.current && plotlyRef.current) {
      plotlyRef.current.relayout(plotEl.current, {
        'scene.camera': cam,
      });
    }
  };

  // 3. Render / Update the 3D surface whenever data, xAxisMode, volMetric, or colorScale changes
  useEffect(() => {
    if (!plotlyReady || !plotlyRef.current || !plotEl.current || !data) return;
    const Plotly = plotlyRef.current;
    const el = plotEl.current as PlotlyRoot;

    try {
      // Choose Z surface matrix
      let zMatrix = data.surface;
      let metricLabel = 'Composite IV';
      if (volMetric === 'ce') {
        zMatrix = data.ce_surface;
        metricLabel = 'Call IV';
      } else if (volMetric === 'pe') {
        zMatrix = data.pe_surface;
        metricLabel = 'Put IV';
      }

      // Choose X axis values and label
      // Plotly's surface trace accepts either a 1D x (shared across all rows) or a
      // 2D x matching z's shape (per-row x values) — delta shifts materially with
      // time to expiry, so delta mode must use the full per-expiry matrix, not one
      // row's values reused for every expiry.
      let xValues: number[] | string[] | number[][] = data.strikes;
      let xLabel = 'Strike Price (₹)';
      if (xAxisMode === 'moneyness') {
        xValues = data.strikes.map((s) => Number(((s / (data.spot || 1)) * 100).toFixed(1)));
        xLabel = 'Moneyness (% of Spot)';
      } else if (xAxisMode === 'delta') {
        xValues = data.delta_surface;
        xLabel = 'Approx Delta (-0.5 PE to +0.5 CE)';
      }

      // Y axis: Expiry labels
      const yLabels = data.expiries.map((e) => {
        const dtePart = e.dte <= 1 ? 'Today' : `${Math.round(e.dte)}d`;
        const shortDate = e.expiry.slice(5); // MM-DD
        return `${shortDate} (${dtePart})`;
      });

      // Plotly 3D Surface Trace
      const surfaceTrace: Record<string, unknown> = {
        type: 'surface',
        x: xValues,
        y: yLabels,
        z: zMatrix,
        colorscale: COLOR_SCALES[colorScale],
        contours: {
          x: { show: true, color: 'rgba(255,255,255,0.08)', width: 1 },
          y: { show: true, color: 'rgba(255,255,255,0.08)', width: 1 },
          z: {
            show: true,
            usecolormap: true,
            project: { z: true }, // Floor contour shadow projection
            width: 1.5,
          },
        },
        lighting: {
          ambient: 0.85,
          diffuse: 0.8,
          specular: 0.15,
          roughness: 0.5,
        },
        colorbar: {
          title: {
            text: `${metricLabel} (%)`,
            font: { color: chrome.textSecondary, size: 11 },
          },
          len: 0.65,
          thickness: 12,
          tickfont: { color: chrome.textMuted, size: 10 },
          tickcolor: chrome.gridline,
          outlinecolor: chrome.baseline,
          outlinewidth: 1,
        },
        hovertemplate:
          `<b>${xLabel}:</b> %{x}<br>` +
          `<b>Expiry:</b> %{y}<br>` +
          `<b>${metricLabel}:</b> %{z:.2f}%<extra></extra>`,
      };

      // Scene layout adhering to dark / white chart chrome
      const layout: Record<string, unknown> = {
        autosize: true,
        margin: { l: 10, r: 10, b: 10, t: 10 },
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        scene: {
          xaxis: {
            title: { text: xLabel, font: { color: chrome.textSecondary, size: 11 } },
            tickfont: { color: chrome.textMuted, size: 9 },
            gridcolor: chrome.gridline,
            zerolinecolor: chrome.baseline,
            showbackground: true,
            backgroundcolor: chrome.surface,
          },
          yaxis: {
            title: { text: 'Expiry (Tenor)', font: { color: chrome.textSecondary, size: 11 } },
            tickfont: { color: chrome.textMuted, size: 9 },
            gridcolor: chrome.gridline,
            zerolinecolor: chrome.baseline,
            showbackground: true,
            backgroundcolor: chrome.surface,
          },
          zaxis: {
            title: { text: `${metricLabel} (%)`, font: { color: chrome.textSecondary, size: 11 } },
            tickfont: { color: chrome.textMuted, size: 9 },
            gridcolor: chrome.gridline,
            zerolinecolor: chrome.baseline,
            showbackground: true,
            backgroundcolor: chrome.surface,
          },
          camera: cameraRef.current,
          aspectratio: { x: 1.2, y: 1.0, z: 0.7 },
        },
      };

      const config = {
        responsive: true,
        displayModeBar: false, // We supply custom clean controls
      };

      Plotly.react(el, [surfaceTrace], layout, config);

      // Listen for camera drag changes and record them in cameraRef
      if (el.removeAllListeners) {
        el.removeAllListeners('plotly_relayout');
      }
      if (el.on) {
        el.on('plotly_relayout', (evtData: Record<string, unknown>) => {
          if (evtData['scene.camera']) {
            cameraRef.current = evtData['scene.camera'] as CameraPreset;
          } else if (evtData['scene.camera.eye']) {
            cameraRef.current = {
              ...cameraRef.current,
              eye: evtData['scene.camera.eye'] as { x: number; y: number; z: number },
            };
          }
        });
      }
      setRenderError(null);
    } catch (err: unknown) {
      console.error('Error rendering Plotly 3D surface:', err);
      setRenderError('Could not construct 3D surface matrix');
    }
  }, [plotlyReady, data, xAxisMode, volMetric, colorScale, chrome]);

  // 4. ResizeObserver for responsive redraws
  useEffect(() => {
    if (!plotEl.current || !plotlyRef.current) return;
    const el = plotEl.current;
    const Plotly = plotlyRef.current;

    const ro = new ResizeObserver(() => {
      Plotly.Plots.resize(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [plotlyReady]);

  // 5. Cleanup on unmount
  useEffect(() => {
    const el = plotEl.current;
    const Plotly = plotlyRef.current;
    return () => {
      if (el && Plotly) {
        try {
          Plotly.purge(el);
        } catch {}
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden transition-all ${
        isFullscreen ? 'fixed inset-0 z-50 rounded-none h-screen w-screen' : 'h-[620px] w-full'
      }`}
    >
      {/* Top Floating Viewport Toolbar */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
        <div className="flex items-center gap-1.5 bg-zinc-900/85 backdrop-blur border border-zinc-700/80 px-2.5 py-1 rounded-lg pointer-events-auto shadow-md">
          <span className="text-[10px] uppercase font-bold tracking-wider text-emerald-400 flex items-center gap-1">
            <Compass className="w-3 h-3" />
            Camera Presets
          </span>
          <span className="w-px h-3.5 bg-zinc-700" />
          <button
            type="button"
            onClick={() => applyCameraPreset('iso')}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 font-medium transition-colors"
            title="Isometric 3D perspective"
          >
            3D Iso
          </button>
          <button
            type="button"
            onClick={() => applyCameraPreset('front')}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 font-medium transition-colors"
            title="Front view (Strike / Smile)"
          >
            Smile (Front)
          </button>
          <button
            type="button"
            onClick={() => applyCameraPreset('side')}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 font-medium transition-colors"
            title="Side view (Term Structure)"
          >
            Term (Side)
          </button>
          <button
            type="button"
            onClick={() => applyCameraPreset('top')}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 font-medium transition-colors"
            title="Top down heatmap view"
          >
            Top (Heatmap)
          </button>
        </div>

        <div className="flex items-center gap-1.5 bg-zinc-900/85 backdrop-blur border border-zinc-700/80 px-2 py-1 rounded-lg pointer-events-auto shadow-md">
          <button
            type="button"
            onClick={() => applyCameraPreset('iso')}
            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 font-medium transition-colors"
            title="Reset to default angle"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
          <span className="w-px h-3.5 bg-zinc-700" />
          <button
            type="button"
            onClick={toggleFullscreen}
            className="p-1 rounded text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Surface Plot Container */}
      <div className="relative flex-1 w-full h-full min-h-0">
        {!plotlyReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/80 z-20">
            <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-zinc-400 font-medium">Initializing 3D WebGL Canvas…</span>
            </div>
          </div>
        )}

        {renderError && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/90 z-20 px-4">
            <div className="flex items-center gap-2 text-rose-400 text-xs bg-rose-950/40 border border-rose-800/60 px-4 py-2.5 rounded-lg">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{renderError}</span>
            </div>
          </div>
        )}

        <div ref={plotEl} className="w-full h-full" />
      </div>

      {/* Bottom Hint Strip */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900/60 border-t border-zinc-800/80 text-[11px] text-zinc-400 font-medium">
        <span className="flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5 text-zinc-500" />
          Click &amp; drag to rotate · Scroll to zoom · Right-click drag to pan
        </span>
        <span className="text-zinc-500 font-mono text-[10px]">
          Floor shadow contour lines indicate equal IV levels
        </span>
      </div>
    </div>
  );
}
