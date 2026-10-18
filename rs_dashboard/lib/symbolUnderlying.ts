// Whether a broker trading symbol is a contract on `underlying` — the Advanced Scalper's guard for anything sized or
// resolved against the SELECTED underlying (lot size, strike lookup, order exchange).
//
// A bare prefix test is not enough: NIFTYNXT50 starts with NIFTY and CRUDEOILM with CRUDEOIL. Every broker's symbol
// continues into the expiry right after the root (Dhan "NIFTY-Oct2026-25000-CE", Kotak/Zerodha "NIFTY26OCT25000CE"),
// so the next character is a digit or a separator; a letter means a different instrument. FINNIFTY never matches
// NIFTY because it does not start with it.
export function symbolOnUnderlying(symbol: string, underlying: string): boolean {
  const sym = String(symbol ?? '').toUpperCase();
  const root = String(underlying ?? '').toUpperCase();
  if (!root || !sym.startsWith(root)) return false;
  const next = sym.charAt(root.length);
  return !(next >= 'A' && next <= 'Z');
}
