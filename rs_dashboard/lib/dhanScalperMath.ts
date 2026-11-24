// Pure calculation and formatting helpers for Dhan Scalper tool
// Used by DhanScalperWidget and tested via indexScalper.test.ts

/** Format expiry like '01 DEC' */
export function formatDhanExpiry(expiryStr: string): string {
  if (!expiryStr) return '';
  try {
    const parts = expiryStr.split('-');
    if (parts.length === 3) {
      // YYYY-MM-DD
      const [y, m, d] = parts.map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      const day = String(d).padStart(2, '0');
      const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
      return `${day} ${month}`;
    }
    const d = new Date(expiryStr);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
      return `${day} ${month}`;
    }
  } catch {
    // fallback
  }
  return expiryStr;
}

/** Format expiry for Manage Scrips dropdown like '1 DEC 2026' */
export function formatManageScripExpiry(expiryStr: string): string {
  if (!expiryStr) return '';
  try {
    const parts = expiryStr.split('-');
    if (parts.length === 3) {
      const [y, m, d] = parts.map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
      return `${d} ${month} ${y}`;
    }
    const d = new Date(expiryStr);
    if (!isNaN(d.getTime())) {
      const day = d.getDate();
      const month = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
      const year = d.getFullYear();
      return `${day} ${month} ${year}`;
    }
  } catch {
    // fallback
  }
  return expiryStr;
}

/** The widget's PE and CE strikes: the strike at or below spot for the PUT, at or above for the CALL (both = spot on a
 *  round strike), each moved by its Manage Scrips offset in strike steps. null when there is no price: strikes are never
 *  picked from a guessed spot. */
export function computeAtmStrikes(spot: number | null, step = 50, peOffset = 0, ceOffset = 0): { peStrike: number; ceStrike: number } | null {
  if (spot === null || !Number.isFinite(spot) || spot <= 0) return null;
  const pe = spot % step === 0 ? spot : Math.floor(spot / step) * step;
  const ce = spot % step === 0 ? spot : Math.ceil(spot / step) * step;
  return { peStrike: pe + peOffset * step, ceStrike: ce + ceOffset * step };
}

/** Offset label relative to ATM strike (e.g. ATM, ATM+1, ATM-1) */
export function getStrikeOffsetLabel(strike: number, atm: number, step = 50): string {
  if (strike === atm) return 'ATM';
  const diff = Math.round((strike - atm) / step);
  return diff > 0 ? `ATM+${diff}` : `ATM-${Math.abs(diff)}`;
}

/** Premium to buy: units x LTP; null when the price or lot size is unknown (never a made-up 0). Sell margin is not
 *  estimated here: the widget asks Dhan's margin calculator (/api/options/margin). */
export function calcOptionBuyReq(ltp: number | null, lots: number, lotSize: number | null): number | null {
  if (!ltp || ltp <= 0 || lots <= 0 || !lotSize || lotSize <= 0) return null;
  return ltp * (lots * lotSize);
}
