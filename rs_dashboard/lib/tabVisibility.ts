// Shared tab-visibility utilities for polling hooks and background intervals.
// When a browser tab is hidden, pollers should pause upstream calls to save
// broker rate limits, CPU, and bandwidth. When the tab becomes visible again,
// pollers should resume or immediately trigger an update.

/** Returns true if running in browser and the tab is currently hidden. */
export function isTabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Returns true if running in browser and the tab is currently visible (or SSR). */
export function isTabVisible(): boolean {
  return !isTabHidden();
}

/**
 * Registers a listener that executes `fn` whenever the tab transitions from
 * hidden to visible. Returns an unregister cleanup function.
 */
export function onTabVisible(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (document.visibilityState === 'visible') {
      fn();
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => {
    document.removeEventListener('visibilitychange', handler);
  };
}
