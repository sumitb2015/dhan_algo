import { isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { readZerodhaGuardState, updateZerodhaGuardState, startZerodhaGuardLoop } from '@/lib/zerodhaGuardServer';
import { guardRouteHandlers } from '@/lib/guardRoute';

// The server-resident Zerodha P&L Guard and brackets: validation and actions are shared with Kotak in lib/guardRoute.ts.
export const { GET, POST } = guardRouteHandlers({
  label: 'Zerodha', idPrefix: 'zb', isSessionValid: isZerodhaTokenValid,
  readGuardState: readZerodhaGuardState, updateGuardState: updateZerodhaGuardState, startLoop: startZerodhaGuardLoop,
});
