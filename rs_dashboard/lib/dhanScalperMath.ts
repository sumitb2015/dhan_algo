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

/** Compute ATM Put and Call strikes matching Dhan's scalper convention */
export function computeAtmStrikes(spot: number, step = 50): { peStrike: number; ceStrike: number } {
  if (!spot || spot <= 0) return { peStrike: 25000, ceStrike: 25000 };
  const peStrike = spot % step === 0 ? spot : Math.floor(spot / step) * step;
  const ceStrike = spot % step === 0 ? spot : Math.ceil(spot / step) * step;
  return { peStrike, ceStrike };
}

/** Offset label relative to ATM strike (e.g. ATM, ATM+1, ATM-1) */
export function getStrikeOffsetLabel(strike: number, atm: number, step = 50): string {
  if (strike === atm) return 'ATM';
  const diff = Math.round((strike - atm) / step);
  return diff > 0 ? `ATM+${diff}` : `ATM-${Math.abs(diff)}`;
}

/** Buy requirement = quantity * ltp */
export function calcOptionBuyReq(ltp: number | null, lots: number, lotSize: number): number {
  if (!ltp || ltp <= 0 || lots <= 0 || lotSize <= 0) return 0;
  return ltp * (lots * lotSize);
}

/** Sell requirement = SPAN base (~7.5%) + Exposure (~2%) + premium - OTM buffer */
export function calcOptionSellReq(
  strike: number,
  spot: number,
  ltp: number | null,
  lots: number,
  lotSize: number,
  type: 'CE' | 'PE'
): number {
  if (lots <= 0 || lotSize <= 0) return 0;
  const s = spot > 0 ? spot : strike;
  const units = lots * lotSize;
  const spanBase = s * units * 0.075;
  const expBase = s * units * 0.02;
  const prem = (ltp ?? 0) * units;
  let otmDiscount = 0;
  if (type === 'CE' && strike > s) {
    otmDiscount = Math.min((strike - s) * units * 0.3, spanBase * 0.25);
  } else if (type === 'PE' && strike < s) {
    otmDiscount = Math.min((s - strike) * units * 0.3, spanBase * 0.25);
  }
  return Math.max(spanBase + expBase + prem - otmDiscount, 120000 * lots);
}
