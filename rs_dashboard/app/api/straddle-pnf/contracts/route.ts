import { NextRequest, NextResponse } from 'next/server';
import { findEquity } from '@/lib/equityMaster';
import { fetchLtp } from '@/lib/dhanEquityQuote';
import { isSymbol } from '@/lib/straddlePnfSearch';
import { atmStrike, expiriesFor, hasUnderlying, indexSpotId, resolveFuture, spotSourceKind, strikesFor } from '@/lib/pnfContracts';

// Contract choices for the Point & Figure page's Futures / Options pickers, from master_list.csv (read-only, no orders):
// the live expiries; for options also the strikes that have both a CE and a PE, the underlying's spot and the ATM strike.
// The spot comes from Dhan (index / stock / nearest future) through the shared quote lane; without it ATM is the middle strike.

async function spotOf(underlying: string): Promise<number | null> {
  try {
    const kind = spotSourceKind(underlying);
    if (kind === 'index') {
      const id = indexSpotId(underlying);
      return id ? await fetchLtp('IDX_I', id) : null;
    }
    if (kind === 'equity') {
      const eq = findEquity(underlying);
      return eq ? await fetchLtp('NSE_EQ', eq.securityId) : null;
    }
    if (kind === 'future') {
      const near = expiriesFor('futures', underlying)[0];
      const fut = near ? resolveFuture(underlying, near) : null;
      return fut ? await fetchLtp(fut.segment, fut.securityId) : null;
    }
  } catch { /* no quote (rate limit, session): ATM falls back to the middle strike */ }
  return null;
}

export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const kind = p.get('kind');
  const underlying = (p.get('underlying') ?? '').toUpperCase();
  if ((kind !== 'futures' && kind !== 'options') || !isSymbol(underlying)) {
    return NextResponse.json({ success: false, error: 'Use kind=futures|options&underlying=<symbol>' }, { status: 400 });
  }
  try {
    if (!hasUnderlying(kind, underlying)) {
      return NextResponse.json({ success: false, error: `${underlying} has no live ${kind}` }, { status: 404 });
    }
    const expiries = expiriesFor(kind, underlying);
    if (kind === 'futures') return NextResponse.json({ success: true, expiries });
    const asked = p.get('expiry');
    const expiry = asked && expiries.includes(asked) ? asked : expiries[0];
    const strikes = strikesFor(underlying, expiry);
    const spot = await spotOf(underlying);
    return NextResponse.json({ success: true, expiries, expiry, strikes, spot, atm: atmStrike(strikes, spot) });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not read the contract list: ${(e as Error).message}` }, { status: 500 });
  }
}
