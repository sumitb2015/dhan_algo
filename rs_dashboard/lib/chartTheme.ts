'use client';

/**
 * Chart chrome (gridlines, axis borders, tick labels) as plain values.
 *
 * Recharts is SVG, so it themes itself from the CSS rules in app/globals.css.
 * lightweight-charts draws to a <canvas> and takes its colours as JS options,
 * which CSS can't reach — those components read the palette from here and
 * re-apply it when the theme flips.
 */

import { useResolvedTheme, type ResolvedTheme } from './theme';

export interface ChartChrome {
  /** Gridlines inside the plot area. */
  gridline: string;
  /** Axis / crosshair lines and price-scale borders. */
  baseline: string;
  /** Axis tick labels. */
  textSecondary: string;
  /** Crosshair label chips. */
  textMuted: string;
  /** Neutral chart-tooltip surface. */
  surface: string;
}

const CHROME: Record<ResolvedTheme, ChartChrome> = {
  dark: {
    gridline: '#27272a',
    baseline: '#3f3f46',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    surface: '#18181b',
  },
  light: {
    gridline: '#e2e8f0',
    baseline: '#cbd5e1',
    textSecondary: '#475569',
    textMuted: '#64748b',
    surface: '#ffffff',
  },
};

/** Re-renders the caller whenever the theme changes. */
export function useChartChrome(): ChartChrome {
  return CHROME[useResolvedTheme()];
}
