import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT = 640;

/** True below Tailwind's `sm` breakpoint. Used to pick a bottom-sheet Drawer
 * over a side Sheet for panels that need to work well one-handed on a phone. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
