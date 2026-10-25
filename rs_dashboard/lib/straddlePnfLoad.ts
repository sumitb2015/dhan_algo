// Small decisions in the Straddle P&F page's data loading, kept pure so they can be tested.

/**
 * Query for /api/straddle-pnf. Only a fresh load or Re-center may pick a new ATM; a quiet refresh (the bridge-down fallback
 * poll) must keep the strikes the page is showing, or the charts would swap to different contracts as spot moves.
 */
export function historyQuery(expiry: string, reset: boolean, loadedAtm: number | null): string {
  return `expiry=${expiry}&atm=${reset || loadedAtm === null ? 'auto' : loadedAtm}`;
}

/**
 * A live tick may fold into the loaded bars only when the loaded history, the page's selected expiry and (if the quote says
 * so) the bridge's expiry are the same contract; otherwise a closed bar would jump between two different straddles.
 */
export function tickAcceptable(pageExpiry: string, loadedExpiry: string, quoteExpiry: string | undefined): boolean {
  return pageExpiry !== '' && pageExpiry === loadedExpiry && (quoteExpiry === undefined || quoteExpiry === '' || quoteExpiry === loadedExpiry);
}
