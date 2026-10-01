import { getDhanCredentials } from './dhanToken';
import { pacedQuoteCall } from './dhanQuotePacer';
import { dedupe } from './pyExec';

// Live last price for one NSE cash-equity security. Market data always comes from Dhan; the call
// goes through the account-wide quote lane (~1 req/s) and identical concurrent calls share one.

const LTP_URL = 'https://api.dhan.co/v2/marketfeed/ltp';

export async function fetchEquityLtp(securityId: string): Promise<number> {
  return dedupe(`eq-ltp:${securityId}`, () =>
    pacedQuoteCall(async () => {
      const { clientId, token } = getDhanCredentials();
      const res = await fetch(LTP_URL, {
        method: 'POST',
        headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ NSE_EQ: [Number(securityId)] }),
        signal: AbortSignal.timeout(6_000),
      });
      if (res.status === 429) throw Object.assign(new Error('Dhan quote rate limited (429)'), { status: 429 });
      if (!res.ok) throw new Error(`Dhan LTP HTTP ${res.status}`);
      const json = (await res.json()) as { data?: Record<string, Record<string, { last_price?: number }>> };
      const ltp = Number(json.data?.NSE_EQ?.[securityId]?.last_price);
      if (!(ltp > 0)) throw new Error('Dhan returned no price for this stock');
      return ltp;
    }),
  );
}
