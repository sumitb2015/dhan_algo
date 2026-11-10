import { getDhanCredentials } from './dhanToken';
import { pacedQuoteCall } from './dhanQuotePacer';
import { dedupe } from './pyExec';

// Live last price for one security. Market data always comes from Dhan; the call goes through the account-wide quote lane
// (~1 req/s) and identical concurrent calls share one.

const LTP_URL = 'https://api.dhan.co/v2/marketfeed/ltp';

export type LtpSegment = 'NSE_EQ' | 'IDX_I' | 'NSE_FNO' | 'MCX_COMM';

/** Last price of `securityId` in `segment`; throws `noPrice` when Dhan returns none. */
export async function fetchLtp(segment: LtpSegment, securityId: string, noPrice = 'Dhan returned no price for this instrument'): Promise<number> {
  return dedupe(`ltp:${segment}:${securityId}`, () =>
    pacedQuoteCall(async () => {
      const { clientId, token } = getDhanCredentials();
      const res = await fetch(LTP_URL, {
        method: 'POST',
        headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [segment]: [Number(securityId)] }),
        signal: AbortSignal.timeout(6_000),
      });
      if (res.status === 429) throw Object.assign(new Error('Dhan quote rate limited (429)'), { status: 429 });
      if (!res.ok) throw new Error(`Dhan LTP HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Record<string, Record<string, { last_price?: number }>> };
      const ltp = Number(json.data?.[segment]?.[securityId]?.last_price);
      if (!(ltp > 0)) throw new Error(noPrice);
      return ltp;
    }),
  );
}

/** Live last price for one NSE cash-equity security (the equity order ticket's price source). */
export async function fetchEquityLtp(securityId: string): Promise<number> {
  return fetchLtp('NSE_EQ', securityId, 'Dhan returned no price for this stock');
}

/** Last prices of several securities in one segment, in ONE quote call (same lane and dedupe as fetchLtp). Ids Dhan
 *  returns no price for are left out; throws on a failed call (429 carries `status`). */
export async function fetchLtps(segment: LtpSegment, securityIds: string[]): Promise<Record<string, number>> {
  if (!securityIds.length) return {};
  const ids = [...new Set(securityIds)].sort();
  return dedupe(`ltps:${segment}:${ids.join(',')}`, () =>
    pacedQuoteCall(async () => {
      const { clientId, token } = getDhanCredentials();
      const res = await fetch(LTP_URL, {
        method: 'POST',
        headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [segment]: ids.map(Number) }),
        signal: AbortSignal.timeout(6_000),
      });
      if (res.status === 429) throw Object.assign(new Error('Dhan quote rate limited (429)'), { status: 429 });
      if (!res.ok) throw new Error(`Dhan LTP HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Record<string, Record<string, { last_price?: number }>> };
      const out: Record<string, number> = {};
      for (const [id, v] of Object.entries(json.data?.[segment] ?? {})) {
        const p = Number(v?.last_price);
        if (p > 0) out[id] = p;
      }
      return out;
    }),
  );
}
