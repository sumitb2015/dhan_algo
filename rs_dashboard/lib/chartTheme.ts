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
}

const CHROME: Record<ResolvedTheme, ChartChrome> = {
  dark: {
    gridline: '#27272a',
    baseline: '#3f3f46',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
  },
  light: {
    gridline: '#b8c5d8',   /* --chart-grid  */
    baseline: '#9aaac0',   /* --chart-axis  */
    textSecondary: '#374252', /* --chart-tick  */
    textMuted: '#546070',
  },
};

export function chartChrome(theme: ResolvedTheme): ChartChrome {
  return CHROME[theme];
}

/** Re-renders the caller whenever the theme changes. */
export function useChartChrome(): ChartChrome {
  return CHROME[useResolvedTheme()];
}
