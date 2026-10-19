import { isKotakTokenValid } from '@/lib/kotakToken';
import { readGuardState, updateGuardState, startKotakGuardLoop } from '@/lib/kotakGuardServer';
import { guardRouteHandlers } from '@/lib/guardRoute';

// The server-resident Kotak P&L Guard and brackets: validation and actions are shared with Zerodha in lib/guardRoute.ts.
export const { GET, POST } = guardRouteHandlers({
  label: 'Kotak', idPrefix: 'kb', isSessionValid: isKotakTokenValid, readGuardState, updateGuardState, startLoop: startKotakGuardLoop,
});
