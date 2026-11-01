// Which chart page a P&F-family ledger belongs to. The Renko page (/renko) reuses the Point & Figure page's trading machinery but
// keeps its own AUTO and resting-order ledgers, so its chart 1 / chart 2 never meet the P&F page's (one live AUTO row per chart).
export type PnfScope = 'pnf' | 'renko';

/** Anything but 'renko' is the P&F page: an old client that sends no scope keeps using the original files. */
export const parseScope = (v: unknown): PnfScope => (v === 'renko' ? 'renko' : 'pnf');

/** `?scope=renko` for the Renko page's ledger routes, nothing for P&F (its URLs stay exactly as they were). */
export const scopeQuery = (scope: PnfScope) => (scope === 'renko' ? '?scope=renko' : '');
