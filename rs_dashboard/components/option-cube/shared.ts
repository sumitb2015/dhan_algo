import { clamp, type Signal } from '@/lib/optionScatter3d';

// Data colours
export const CE_COLOR = '#3b82f6';
export const PE_COLOR = '#f59e0b';
export const SIGNAL_COLOR: Record<Signal, string> = {
  'Long buildup':   '#10b981',
  'Short buildup':  '#f43f5e',
  'Short covering': '#0ea5e9',
  'Long unwinding': '#a855f7',
};
export const SIGNALS = Object.keys(SIGNAL_COLOR) as Signal[];

export const SCORE_SCALE: [number, string][] = [
  [0, '#27272a'], [0.25, '#0e7490'], [0.5, '#059669'], [0.75, '#10b981'], [1, '#a3e635'],
];

/** Bearish-bias ramp, light -> deep red. Every stop stays visible on both the dark and white surfaces. */
export const BEARISH_SCALE: [number, string][] = [
  [0,    '#fda4af'],
  [0.25, '#fb7185'],
  [0.50, '#f43f5e'],
  [0.75, '#e11d48'],
  [1.00, '#be123c'],
];

export const FONT = 'Geist, ui-sans-serif, system-ui, sans-serif';

export function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function interpolateColor(color1: string, color2: string, factor: number): string {
  const c1 = parseInt(color1.slice(1), 16);
  const c2 = parseInt(color2.slice(1), 16);

  const r1 = (c1 >> 16) & 255;
  const g1 = (c1 >> 8) & 255;
  const b1 = c1 & 255;

  const r2 = (c2 >> 16) & 255;
  const g2 = (c2 >> 8) & 255;
  const b2 = c2 & 255;

  const r = Math.round(r1 + factor * (r2 - r1));
  const g = Math.round(g1 + factor * (g2 - g1));
  const b = Math.round(b1 + factor * (b2 - b1));

  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function getBearishColor(score: number): string {
  const t = clamp(score, 0, 100) / 100;
  for (let i = 1; i < BEARISH_SCALE.length; i++) {
    const [t1, c1] = BEARISH_SCALE[i];
    if (t <= t1) {
      const [t0, c0] = BEARISH_SCALE[i - 1];
      return interpolateColor(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return BEARISH_SCALE[BEARISH_SCALE.length - 1][1];
}

export type ColorMode = 'signal' | 'bearish' | 'side' | 'score' | 'iv';
export type SideFilter = 'ALL' | 'CE' | 'PE';
export type MoneynessFilter = 'ALL' | 'OTM' | 'ATM' | 'ITM';

/** What a left-drag on the scene does: rotate around Z, rotate freely, or move (pan) the scene. */
export type DragMode = 'turntable' | 'orbit' | 'pan';

export type CameraView = 'iso' | 'top' | 'front' | 'side' | 'reset' | 'atm';
export interface Vec3 { x: number; y: number; z: number }
export interface Camera { eye: Vec3; up: Vec3; center: Vec3 }
export interface SceneCamera extends Camera { projection?: { type: 'perspective' | 'orthographic' } }
export const Z_UP: Vec3 = { x: 0, y: 0, z: 1 };
export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
export const CAMERAS: Record<CameraView, Camera> = {
  iso:   { eye: { x: 1.8, y: -1.9, z: 1.05 }, up: Z_UP, center: ORIGIN },
  // Top-down 2D quadrant view (Price vs OI)
  top:   { eye: { x: 0, y: 0.0001, z: 2.5 }, up: { x: 0, y: 1, z: 0 }, center: ORIGIN },
  // Elevation views: Price vs IV skew / OI vs IV positioning
  front: { eye: { x: 0, y: -2.6, z: 0.0001 }, up: Z_UP, center: ORIGIN },
  side:  { eye: { x: 2.6, y: 0.0001, z: 0.0001 }, up: Z_UP, center: ORIGIN },
  atm:   { eye: { x: 1.4, y: -1.4, z: 0.8 }, up: Z_UP, center: ORIGIN },
  // Far enough back that the whole box and its axis titles sit inside the canvas at the default zoom.
  // center.z < 0 looks below the box's middle, which lifts the box towards the top of the panel and
  // leaves the space beneath it free for the near/bottom edge to grow into when the user zooms in.
  reset: { eye: { x: 1.55, y: -2.7, z: 1.15 }, up: Z_UP, center: { x: 0, y: 0, z: -0.45 } },
};

/** Camera the scene opens with and the reset button returns to. */
export const DEFAULT_CAMERA: SceneCamera = { ...CAMERAS.reset, projection: { type: 'perspective' } };

export function cmp(a: number | string, b: number | string): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
}

export function fmtOi(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

export const sgn = (v: number, d = 1) => {
  const t = v.toFixed(d);
  const z = Number(t) === 0;
  return z ? (0).toFixed(d) : `${v > 0 ? '+' : ''}${t}`;
};
