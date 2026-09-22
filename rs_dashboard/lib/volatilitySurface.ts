/**
 * Pure helper functions and types for the 3D Volatility Surface.
 */

export interface CameraPreset {
  eye: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
}

export const VOL_CAMERAS: Record<'iso' | 'front' | 'side' | 'top', CameraPreset> = {
  // Default 3D Isometric Bloomberg-style perspective
  iso: {
    eye: { x: -1.6, y: -1.7, z: 1.3 },
    center: { x: 0, y: 0, z: -0.2 },
    up: { x: 0, y: 0, z: 1 },
  },
  // Front view: Focus on the Volatility Smile (IV vs Strike / Delta)
  front: {
    eye: { x: 0.0001, y: -2.3, z: 0.1 },
    center: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  // Side view: Focus on Term Structure (IV vs Expiry / Tenor)
  side: {
    eye: { x: -2.3, y: 0.0001, z: 0.1 },
    center: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  // Top view: Heatmap contour view
  top: {
    eye: { x: 0.0001, y: 0.0001, z: 2.4 },
    center: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  },
};

export type XAxisMode = 'strike' | 'moneyness' | 'delta';
export type VolMetric = 'composite' | 'ce' | 'pe';
export type ColorScale = 'Bloomberg' | 'Turbo' | 'Plasma' | 'Viridis';

export const COLOR_SCALES: Record<ColorScale, string | (string | number)[][]> = {
  // Bloomberg terminal RdYlGn reversed: green at bottom (low IV), yellow mid, red at top (high IV wings)
  Bloomberg: [
    [0.0, '#10b981'], // emerald-500 (low IV)
    [0.2, '#34d399'],
    [0.4, '#facc15'], // yellow (mid IV)
    [0.7, '#fb923c'], // orange
    [1.0, '#ef4444'], // red (high IV peaks)
  ],
  Turbo: 'Turbo',
  Plasma: 'Plasma',
  Viridis: 'Viridis',
};

export function formatInr(n: number): string {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

export function formatCompact(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
