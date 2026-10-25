import { getDhanStrikeLookup } from '@/lib/dhanStrikeLookup';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { kotakOptionContract } from '@/lib/kotakContracts';
import { zerodhaOptionContract } from '@/lib/zerodhaContracts';
import { readLadderState, loadPrices, dhanSegmentFor, watcherTickAt, WATCHER_QUIET_MS, LADDER_UNDERLYINGS } from '@/lib/priceLadderServer';
import {
  spotKey, isMcxUnderlying, isLive, istDay, istHhmm, realArmed, sessionFor, spotFresh,
  type LadderBroker, type LadderContract, type OptType,
} from '@/lib/priceLadder';
import { isPairLive, pairCombined } from '@/lib/priceLadderPair';
import { prevDayLevelsNow } from '@/lib/prevDayLevels';

// What the Price Ladder page shows, built once for both the 1 s poll (GET /api/price-ladder/state) and the push stream
// (GET /api/price-ladder/stream), and the contract resolution every order route shares. Server only.

/** A contract resolved from the brokers' own masters (never a security id from the browser), or why it cannot be. */
export async function resolveContract(broker: LadderBroker, u: string, expiry: string, strike: number, opt: OptType): Promise<LadderContract | string> {
  const look = await getDhanStrikeLookup(u, expiry);
  const row = look?.strikes?.[String(strike)] ?? look?.strikes?.[strike.toFixed(1)];
  const securityId = opt === 'CE' ? row?.ceId : row?.peId;
  if (!look || !securityId || !(look.lotSize > 0)) return `${u} ${expiry} ${strike}${opt} is not in Dhan's master list`;
  const c: LadderContract = { underlying: u, expiry, strike, opt, securityId: String(securityId), lotSize: look.lotSize, exchangeSegment: dhanSegmentFor(u) };
  if (isMcxUnderlying(u)) {
    // Dhan's master lists MCX at lotSize 1 and orders it in LOTS; P&L and premium cost need the barrels per lot.
    const mult = MCX_LOT_MULTIPLIER[u];
    if (look.lotSize !== 1 || !(mult > 1)) return `${u}: unexpected lot size ${look.lotSize} — refused`;
    if (!look.future) return `${u}: no futures month on or after ${expiry} in Dhan's master list (restart the dashboard if the master was just refreshed)`;
    // Dhan and Zerodha take MCX quantity in lots (Kite's dump reads lot_size 1), so qty is lots and `mult` converts to
    // barrels. Kotak takes absolute barrels (lot_size 10): qty is barrels already and mult stays 1 (set below).
    if (broker !== 'kotak') c.mult = mult;
    c.ref = { securityId: look.future.securityId, segment: 'MCX_COMM', expiry: look.future.expiry };
  }
  if (broker === 'zerodha') {
    // Kite's own instrument dump (metadata only — prices stay Dhan-sourced).
    const z = await zerodhaOptionContract(u, expiry, strike, opt);
    if (!z) return `Zerodha does not list ${u} ${expiry} ${strike}${opt}`;
    if (isMcxUnderlying(u) && z.lotSize !== 1) return `${u}: unexpected Zerodha lot size ${z.lotSize} — refused`;
    c.tradingSymbol = z.tradingsymbol;
    c.lotSize = z.lotSize;
  }
  if (broker === 'kotak') {
    const k = await kotakOptionContract(u, expiry, strike, opt);
    if (!k) return `Kotak does not list ${u} ${expiry} ${strike}${opt}`;
    if (isMcxUnderlying(u) && k.lotSize !== MCX_LOT_MULTIPLIER[u]) return `${u}: unexpected Kotak lot size ${k.lotSize} — refused`;
    c.tradingSymbol = k.tradingsymbol;
    c.lotSize = k.lotSize;
  }
  return c;
}

/** The ladder state, the page's XY axis and contract prices, for one selection (`underlying` / `expiry` / `strike` / `opt`). */
export async function buildLadderView(params: URLSearchParams) {
  const want = (params.get('underlying') ?? '').toUpperCase();
  const state = readLadderState();
  const live = state.slices.filter(isLive);
  // The contract the page is showing (Dhan ids price every broker's contract): its live LTP rides the same snapshot.
  const expiry = params.get('expiry') ?? '';
  const strike = Number(params.get('strike'));
  const opt = params.get('opt');
  let shown: LadderContract | null = null;
  let contractError: string | null = null;
  if (LADDER_UNDERLYINGS.includes(want) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && strike > 0 && (opt === 'CE' || opt === 'PE')) {
    const c = await resolveContract('dhan', want, expiry, strike, opt);
    if (typeof c !== 'string') shown = c; else contractError = c;
  }
  // The page's XY axis: the index, or for MCX the shown option month's own futures (known once a contract is picked).
  const shownKey = shown ? spotKey(shown) : (LADDER_UNDERLYINGS.includes(want) && !isMcxUnderlying(want) ? want : null);
  // Pair mode: the CE and PE legs on screen (`pairCe` / `pairPe` strikes, same underlying and expiry).
  const pairCe = Number(params.get('pairCe')), pairPe = Number(params.get('pairPe'));
  let pairLegs: { ce: LadderContract; pe: LadderContract } | null = null;
  // A pair leg's own error, apart from the single contract's (the page shows each against its own selection).
  let pairError: string | null = null;
  if (LADDER_UNDERLYINGS.includes(want) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && pairCe > 0 && pairPe > 0) {
    const [ce, pe] = await Promise.all([resolveContract('dhan', want, expiry, pairCe, 'CE'), resolveContract('dhan', want, expiry, pairPe, 'PE')]);
    if (typeof ce !== 'string' && typeof pe !== 'string') pairLegs = { ce, pe };
    else pairError = typeof ce === 'string' ? ce : pe as string;
  }
  const livePairLegs = (state.pairs ?? []).filter(isPairLive)
    .flatMap(p => [p.legs.ce.contract, p.legs.pe.contract, ...(p.rollTo?.ce ? [p.rollTo.ce] : []), ...(p.rollTo?.pe ? [p.rollTo.pe] : [])]);
  const unders = [...new Set([...(shownKey ? [shownKey] : []), ...live.map(x => spotKey(x.contract))])];
  const prices = await loadPrices(unders, [
    ...live.map(x => x.contract), ...(shown ? [shown] : []), ...livePairLegs, ...(pairLegs ? [pairLegs.ce, pairLegs.pe] : []),
  ]);
  const now = Date.now();
  const spots = Object.fromEntries(Object.entries(prices.spots).map(([u, v]) => [u, { ...v, fresh: spotFresh(v.at, now) }]));
  const d = prices.days?.[shownKey ?? want];
  // Cached or null — never awaited: a slow / failing Dhan history call must not stall the ladder's price stream.
  const prevDay = want ? prevDayLevelsNow(want, shown?.ref?.securityId) : null;
  const dayHigh = d?.high ?? (shown?.ref ? axisDayOf(shown, prices.days, now, state.settings?.mcxAutoExitTime)?.high : null);
  const dayLow = d?.low ?? (shown?.ref ? axisDayOf(shown, prices.days, now, state.settings?.mcxAutoExitTime)?.low : null);

  return {
    state, spots, ltps: prices.ltps, liveArmed: realArmed(state, istDay()), now, watcherQuiet: (watcherTickAt() ?? now) < now - WATCHER_QUIET_MS, spotKey: shownKey, contractError, pairError,
    keyLevels: {
      pdh: prevDay?.high ?? null,
      pdl: prevDay?.low ?? null,
      dayHigh: dayHigh && dayHigh > 0 ? dayHigh : null,
      dayLow: dayLow && dayLow > 0 ? dayLow : null,
    },
    // Which contract this reply describes: the page ignores a reply for a selection it has since moved off.
    request: { underlying: want, expiry, strike: strike > 0 ? strike : null, opt, pairCe: pairCe > 0 ? pairCe : null, pairPe: pairPe > 0 ? pairPe : null },
    pair: pairLegs ? {
      ce: { strike: pairLegs.ce.strike, securityId: pairLegs.ce.securityId, ltp: prices.ltps[pairLegs.ce.securityId] ?? null },
      pe: { strike: pairLegs.pe.strike, securityId: pairLegs.pe.securityId, ltp: prices.ltps[pairLegs.pe.securityId] ?? null },
      combined: pairCombined({ legs: { ce: { contract: pairLegs.ce }, pe: { contract: pairLegs.pe } } }, prices.ltps),
      lotSize: pairLegs.ce.lotSize, mult: pairLegs.ce.mult ?? 1,
    } : null,
    contract: shown ? {
      securityId: shown.securityId, lotSize: shown.lotSize, ltp: prices.ltps[shown.securityId] ?? null,
      mult: shown.mult ?? 1, ...(shown.ref ? { refExpiry: shown.ref.expiry, axisDay: axisDayOf(shown, prices.days, now, state.settings?.mcxAutoExitTime) } : {}),
    } : null,
  };
}

/**
 * A futures axis's day range and previous close, for the header card. The quote's `close` is the PREVIOUS session's
 * close only while the session runs — at the bell it flips to today's close (dhan-prevclose-pct-change), so outside the
 * session no previous close is given (the card then shows the range without a % change).
 */
function axisDayOf(c: LadderContract, days: Awaited<ReturnType<typeof loadPrices>>['days'], now: number, mcxTime?: string) {
  const d = days?.[spotKey(c)];
  if (!d) return null;
  const sess = sessionFor(c.underlying, istDay(now), mcxTime);
  const hhmm = istHhmm(now);
  const inSession = hhmm >= sess.open && hhmm < sess.close;
  return { high: d.high, low: d.low, prevClose: inSession ? d.close : null };
}
