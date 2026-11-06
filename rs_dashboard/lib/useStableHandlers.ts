import { useLayoutEffect, useMemo, useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (...args: any[]) => any>;

/**
 * Handlers that keep their identity across renders and always call the latest ones passed in, so a memoised block of controls
 * (or a memo component) is not rebuilt just because the page re-created its inline callbacks on an unrelated re-render, such
 * as a live price tick. The set of keys must not change between renders. Calls between a render and its commit still reach the
 * previous handlers, which is fine for click / change handlers (they only fire after a commit).
 */
export function useStableHandlers<T extends Handlers>(handlers: T): T {
  const ref = useRef(handlers);
  useLayoutEffect(() => { ref.current = handlers; });
  return useMemo(
    // eslint-disable-next-line react-hooks/refs -- the ref is read only when a handler is called (after a commit), never during render
    () => Object.fromEntries(Object.keys(handlers).map(k => [k, (...args: unknown[]) => ref.current[k](...args)])) as T,
    // the keys are fixed for the component's life (see above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
}
