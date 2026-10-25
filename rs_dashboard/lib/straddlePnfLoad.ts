// Small decisions in the Straddle P&F page's data loading, kept pure so they can be tested.

/**
 * Query for /api/straddle-pnf. If user specifies a numeric ATM, that strike is pinned; otherwise only a fresh load or
 * Re-center picks a new ATM from spot ('auto'), while quiet refreshes keep the loaded strike.
 */
export function historyQuery(expiry: string, reset: boolean, loadedAtm: number | null, userAtm?: string): string {
  if (userAtm !== undefined && userAtm.trim() !== '') {
    const trimmed = userAtm.trim();
    if (trimmed.toLowerCase() !== 'auto') return `expiry=${expiry}&atm=${trimmed}`;
    return `expiry=${expiry}&atm=${reset || loadedAtm === null ? 'auto' : loadedAtm}`;
  }
  return `expiry=${expiry}&atm=${reset || loadedAtm === null ? 'auto' : loadedAtm}`;
}

/**
 * A live tick may fold into the loaded bars only when the loaded history, the page's selected expiry and (if the quote says
 * so) the bridge's expiry are the same contract; otherwise a closed bar would jump between two different straddles.
 */
export function tickAcceptable(pageExpiry: string, loadedExpiry: string, quoteExpiry: string | undefined): boolean {
  return pageExpiry !== '' && pageExpiry === loadedExpiry && (quoteExpiry === undefined || quoteExpiry === '' || quoteExpiry === loadedExpiry);
}
