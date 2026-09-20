import type { ChartChrome } from '@/lib/chartTheme';
import { bearishIntensity, clamp, type AxisClip, type Goal, type ScatterPoint, type Signal } from '@/lib/optionScatter3d';
import { BEARISH_SCALE, CE_COLOR, DEFAULT_CAMERA, FONT, PE_COLOR, SCORE_SCALE, SIGNALS, SIGNAL_COLOR, rgba, type ColorMode, type SceneCamera } from './shared';

export interface SceneInput {
  points: ScatterPoint[];
  axes: { x: AxisClip; y: AxisClip; z: AxisClip };
  colorMode: ColorMode;
  goal: Goal;
  scoreOf: (p: ScatterPoint) => number | null;
  showStems: boolean;
  showZeroPlanes: boolean;
  showFloorShadow: boolean;
  selected: string | null;
  chrome: ChartChrome;
  /** Plotly `uirevision`: keeps the user's camera while the same underlying+expiry live-updates. */
  viewKey: string;
  dragMode: 'turntable' | 'orbit';
  /**
   * The camera to draw with. The caller owns it: Plotly's uirevision does not reliably keep a
   * dragged/zoomed camera when the layout also names one, so every re-render passes the live one.
   */
  camera?: SceneCamera;
}

/** Pure translation of the filtered points + view options into Plotly traces and layout. */
export function buildScene(input: SceneInput): { traces: unknown[]; layout: Record<string, unknown> } {
  const {
    points, axes, colorMode, goal, scoreOf, showStems, showZeroPlanes, showFloorShadow,
    selected, chrome, viewKey, dragMode, camera,
  } = input;

    const maxOi = Math.max(1, ...points.map(p => p.oi));
  // Dynamic non-linear sphere sizing for superior visual hierarchy
  const size = (p: ScatterPoint) => Math.round(7 + 18 * Math.pow(p.oi / maxOi, 0.45));
  const X = (p: ScatterPoint) => clamp(p.priceChg, axes.x.lo, axes.x.hi);
  const Y = (p: ScatterPoint) => clamp(p.oiChg, axes.y.lo, axes.y.hi);
  const Z = (p: ScatterPoint) => clamp(p.iv, axes.z.lo, axes.z.hi);

  const mk = (list: ScatterPoint[], name: string, marker: Record<string, unknown>) => ({
    type: 'scatter3d',
    mode: 'markers',
    name,
    x: list.map(X),
    y: list.map(Y),
    z: list.map(Z),
    customdata: list.map(p => p.key),
    // 'none' hides Plotly's label but still emits plotly_hover; the HUD card is the tooltip.
    hoverinfo: 'none',
    marker: {
      size: list.map(size),
      opacity: 0.92,
      line: { color: chrome.surface, width: 1.2 },
      lighting: { ambient: 0.85, diffuse: 0.75, specular: 0.35, roughness: 0.4 },
      ...marker,
    },
    projection: {
      z: { show: showFloorShadow, opacity: 0.32, scale: 0.65 },
    },
  });

  let traces: unknown[] = [];

  // Base point traces based on selected color mode
  if (colorMode === 'side') {
    traces = [
      mk(points.filter(p => p.side === 'CE'), 'Calls (CE)', { color: CE_COLOR }),
      mk(points.filter(p => p.side === 'PE'), 'Puts (PE)', { color: PE_COLOR }),
    ];
  } else if (colorMode === 'signal') {
    traces = SIGNALS.map(sig => mk(points.filter(p => p.signal === sig), sig, { color: SIGNAL_COLOR[sig] }));
  } else if (colorMode === 'bearish') {
    // Continuous Bearish Heatmap Mode across all active points
    traces = [
      mk(points, 'Bearish bias', {
        color: points.map(bearishIntensity),
        cmin: 0,
        cmax: 100,
        colorscale: BEARISH_SCALE,
        colorbar: {
          title: { text: 'Bearish bias %', font: { color: chrome.textMuted, size: 11 } },
          tickfont: { color: chrome.textMuted, size: 10 },
          len: 0.55,
          thickness: 10,
          outlinewidth: 0,
          x: 1.0,
          xpad: 8,
        },
      }),
    ];
  } else if (colorMode === 'score') {
    traces = [
      mk(points, `${goal === 'buy' ? 'Buy' : 'Sell'} score`, {
        color: points.map(p => scoreOf(p) ?? 0),
        cmin: 0,
        cmax: 100,
        colorscale: SCORE_SCALE,
        colorbar: {
          title: { text: `${goal === 'buy' ? 'Buy' : 'Sell'} score`, font: { color: chrome.textMuted, size: 11 } },
          tickfont: { color: chrome.textMuted, size: 10 },
          len: 0.55,
          thickness: 10,
          outlinewidth: 0,
          x: 1.0,
          xpad: 8,
        },
      }),
    ];
  } else {
    // IV Heatmap Mode
    const ivs = points.map(p => p.iv);
    const minIv = ivs.length ? Math.min(...ivs) : 0;
    const maxIv = ivs.length ? Math.max(...ivs) : 1;
    traces = [
      mk(points, 'Implied Volatility', {
        color: ivs,
        cmin: minIv,
        cmax: maxIv,
        colorscale: 'Plasma',
        colorbar: {
          title: { text: 'Implied Vol %', font: { color: chrome.textMuted, size: 11 } },
          tickfont: { color: chrome.textMuted, size: 10 },
          len: 0.55,
          thickness: 10,
          outlinewidth: 0,
          x: 1.0,
          xpad: 8,
        },
      }),
    ];
  }

  // ── Drop Lines / Stem Needles ──
  if (showStems && points.length > 0) {
    const stemX: (number | null)[] = [];
    const stemY: (number | null)[] = [];
    const stemZ: (number | null)[] = [];
    for (const p of points) {
      const px = X(p);
      const py = Y(p);
      const pz = Z(p);
      stemX.push(px, px, null);
      stemY.push(py, py, null);
      stemZ.push(pz, axes.z.lo, null);
    }
    traces.unshift({
      type: 'scatter3d',
      mode: 'lines',
      name: 'Drop Lines',
      showlegend: false,
      hoverinfo: 'skip',
      x: stemX,
      y: stemY,
      z: stemZ,
      line: {
        color: rgba(chrome.baseline, 0.28),
        width: 1.2,
      },
    });
  }

  // ── Highlight Selected Point with Target Crosshair & Halo ──
  const sel = points.find(p => p.key === selected);
  if (sel) {
    traces.push(
      {
        type: 'scatter3d',
        mode: 'lines',
        showlegend: false,
        hoverinfo: 'skip',
        x: [X(sel), X(sel)],
        y: [Y(sel), Y(sel)],
        z: [Z(sel), axes.z.lo],
        line: { color: '#38bdf8', width: 3.5, dash: 'dot' },
      },
      {
        type: 'scatter3d',
        mode: 'markers+text',
        name: 'Selected Contract',
        showlegend: false,
        hoverinfo: 'skip',
        x: [X(sel)],
        y: [Y(sel)],
        z: [Z(sel)],
        text: [`  ${sel.strike} ${sel.side}`],
        textposition: 'top right',
        textfont: { color: '#38bdf8', size: 13, family: FONT },
        marker: {
          size: size(sel) + 12,
          color: 'rgba(56, 189, 248, 0.15)',
          line: { color: '#38bdf8', width: 3 },
        },
      }
    );
  }

  // ── Zero Reference Planes & Quadrant Labels ──
  const padded = (r: { lo: number; hi: number }) => {
    const d = (r.hi - r.lo) * 0.04;
    return [r.lo - d, r.hi + d] as const;
  };
  const [x0, x1] = padded(axes.x);
  const [y0, y1] = padded(axes.y);
  const [z0, z1] = padded(axes.z);

  const plane = (xs: number[], ys: number[], zs: number[], col: string) => ({
    type: 'mesh3d',
    x: xs, y: ys, z: zs,
    i: [0, 0], j: [1, 2], k: [2, 3],
    color: col,
    opacity: 0.06,
    hoverinfo: 'skip',
    showlegend: false,
    flatshading: true,
    lighting: { ambient: 1, diffuse: 0, specular: 0 },
  });

  const underlay: unknown[] = [];
  if (showZeroPlanes && points.length) {
    if (x0 < 0 && x1 > 0) {
      underlay.push(plane([0, 0, 0, 0], [y0, y1, y1, y0], [z0, z0, z1, z1], chrome.baseline));
      underlay.push({
        type: 'scatter3d', mode: 'lines', showlegend: false, hoverinfo: 'skip',
        x: [0, 0, 0, 0, 0], y: [y0, y1, y1, y0, y0], z: [z0, z0, z1, z1, z0],
        line: { color: rgba(chrome.baseline, 0.4), width: 1.2 },
      });
    }
    if (y0 < 0 && y1 > 0) {
      underlay.push(plane([x0, x1, x1, x0], [0, 0, 0, 0], [z0, z0, z1, z1], chrome.baseline));
      underlay.push({
        type: 'scatter3d', mode: 'lines', showlegend: false, hoverinfo: 'skip',
        x: [x0, x1, x1, x0, x0], y: [0, 0, 0, 0, 0], z: [z0, z0, z1, z1, z0],
        line: { color: rgba(chrome.baseline, 0.4), width: 1.2 },
      });
    }
    if (x0 < 0 && x1 > 0 && y0 < 0 && y1 > 0) {
      const q: [Signal, number, number, string][] = [
        ['Long buildup', x1 * 0.75, y1 * 0.75, '#10b981'],
        ['Short buildup', x0 * 0.75, y1 * 0.75, '#f43f5e'],
        ['Short covering', x1 * 0.75, y0 * 0.75, '#0ea5e9'],
        ['Long unwinding', x0 * 0.75, y0 * 0.75, '#a855f7'],
      ];
      underlay.push({
        type: 'scatter3d',
        mode: 'text',
        showlegend: false,
        hoverinfo: 'skip',
        x: q.map(v => v[1]),
        y: q.map(v => v[2]),
        z: q.map(() => z0),
        text: q.map(v => `<b>${v[0].toUpperCase()}</b>`),
        textfont: { color: q.map(v => v[3]), size: 11, family: FONT },
      });
    }
  }

  traces = [...underlay, ...traces];

  const axis = (title: string, r: { lo: number; hi: number }, fmt: string) => {
    const d = (r.hi - r.lo) * 0.04;
    return {
      title: { text: title, font: { color: chrome.textSecondary, size: 12, family: FONT } },
      range: [r.lo - d, r.hi + d],
      tickformat: fmt,
      ticksuffix: '%',
      nticks: 6,
      tickfont: { color: chrome.textSecondary, size: 11, family: FONT },
      color: chrome.textSecondary,
      gridcolor: rgba(chrome.baseline, 0.35),
      gridwidth: 1,
      zerolinecolor: chrome.baseline,
      zerolinewidth: 2,
      linecolor: chrome.baseline,
      showbackground: true,
      backgroundcolor: rgba(chrome.surface, 0.55),
      showspikes: true,
      spikecolor: chrome.baseline,
      spikethickness: 1,
      spikesides: false,
    };
  };

  const isSingleScale = colorMode === 'score' || colorMode === 'iv' || colorMode === 'bearish';

  const layout = {
    autosize: true,
    paper_bgcolor: 'rgba(0,0,0,0)',
    margin: { l: 0, r: 0, t: 0, b: 0 },
    uirevision: viewKey, // Preserves user's custom camera angle on live poll
    font: { family: FONT, color: chrome.textSecondary },
    hovermode: 'closest',
    hoverdistance: 50,
    showlegend: !isSingleScale,
    legend: {
      orientation: 'h',
      x: 0.01,
      y: 0.99,
      itemsizing: 'constant',
      font: { color: chrome.textSecondary, size: 11, family: FONT },
      bgcolor: rgba(chrome.surface, 0.8),
      bordercolor: chrome.gridline,
      borderwidth: 1,
    },
    scene: {
      hovermode: 'closest',
      xaxis: axis('▲ Premium Change (%)', axes.x, '+.0f'),
      yaxis: axis('▲ OI Change (%)', axes.y, '+.0f'),
      zaxis: axis('▲ Implied Volatility (%)', axes.z, '.0f'),
      bgcolor: 'rgba(0,0,0,0)',
      aspectmode: 'manual',
      // Stretched along X so the box fills a wide panel instead of sitting as a
      // compact cube with empty bands either side.
      aspectratio: { x: 2.2, y: 1.35, z: 1.25 },
      camera: camera ?? DEFAULT_CAMERA,
      dragmode: dragMode,
    },
  };

  return { traces, layout };
}
