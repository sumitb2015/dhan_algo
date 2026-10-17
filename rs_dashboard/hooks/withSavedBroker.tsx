'use client';

import { useEffect, useState, type ComponentProps, type ComponentType } from 'react';
import { markSavedBrokerReadable } from './useBrokerSelector';

/**
 * Renders `Inner` only after mount, so its first render already has the SAVED broker (useBrokerSelector reads it in its
 * initial state once this gate has mounted).
 *
 * Without it the hook starts every page on 'dhan' to match the server HTML and switches after mount, so a page saved on
 * Kotak first rendered as Dhan and its mount effects called Dhan's account routes (/api/scalper/all, /api/pnl-exit,
 * expiries/live for broker=dhan) before switching — 2026-10-17. Wrap every component that uses useBrokerSelector.
 *
 * The gate always starts empty, even when an earlier gate already mounted: a gate hydrated late (inside a Suspense
 * boundary) must match the empty server HTML. The cost is one empty frame per mount; nothing is server-rendered for
 * `Inner`.
 */
// Typed as "returns the component it was given" so a component with an OPTIONAL props parameter (MultiLegFocus's
// `({ ... } = {})`) keeps its props type instead of collapsing to `object`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSavedBroker<C extends ComponentType<any>>(Inner: C): C {
  function SavedBrokerGate(props: ComponentProps<C>) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      markSavedBrokerReadable();
      setReady(true);
    }, []);
    const Component = Inner as ComponentType<ComponentProps<C>>;
    return ready ? <Component {...props} /> : null;
  }
  SavedBrokerGate.displayName = `withSavedBroker(${Inner.displayName ?? Inner.name ?? 'Component'})`;
  return SavedBrokerGate as unknown as C;
}
