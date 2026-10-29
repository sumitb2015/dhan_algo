import { getDhanStrikeLookup } from '@/lib/dhanStrikeLookup';
import { getDhanFutures } from '@/lib/dhanFuturesLookup';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { kotakOptionContract, kotakFutureContract } from '@/lib/kotakContracts';
import { zerodhaOptionContract } from '@/lib/zerodhaContracts';
import { readLadderState, loadPrices, dhanSegmentFor, watcherTickAt, WATCHER_QUIET_MS, LADDER_UNDERLYINGS } from '@/lib/priceLadderServer';
import {
  spotKey, isMcxUnderlying, FUT_TICK, isLive, istDay, istHhmm, realArmed, sessionFor, spotFresh,
  type LadderBroker, type LadderContract, type OptType,
} from '@/lib/priceLadder';
import { isPairLive, pairCombined } from '@/lib/priceLadderPair';
import { isBasketLive, basketAxis, synAxis, synQuoteVerdict, validateDraft, draftFromParam } from '@/lib/priceLadderBasket';
import { prevDayLevelsNow } from '@/lib/prevDayLevels';

// What the Price Ladder page shows, built once for both the 1 s poll (GET /api/price-ladder/state) and the push stream
// (GET /api/price-ladder/stream), and the contract resolution every order route shares. Server only.

/** A contract resolved from the brokers' own masters (never a security id from the browser), or why it cannot be. */
export async function resolveContract(broker: LadderBroker, u: string, expiry: string, strike: number, opt: OptType): Promise<LadderContract | string> {
  if (opt === 'FUT') return resolveFuture(broker, u, expiry);
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

/**
 * A futures contract (MCX, Dhan and Kotak): its XY axis is its own price. Kotak / Zerodha futures quantity units and
 * positions are unconfirmed, so Zerodha is refused rather than guessed (the options' mcxUnitError discipline).
 */
async function resolveFuture(broker: LadderBroker, u: string, expiry: string): Promise<LadderContract | string> {
  if (!isMcxUnderlying(u)) return `${u} futures are not offered on the ladder`;
  if (broker === 'zerodha') return `${u} futures trade on Dhan and Kotak only (Zerodha futures units are unconfirmed)`;
  const mult = MCX_LOT_MULTIPLIER[u];
  if (!(mult > 1)) return `${u}: no MCX lot multiplier — refused`;
  const list = await getDhanFutures(u);
  const f = list?.find(x => x.expiry === expiry);
  if (!f) return `${u} futures ${expiry} is not in Dhan's master list`;
  if (f.lotSize !== 1) return `${u}: unexpected futures lot size ${f.lotSize} — refused`;
  const c: LadderContract = {
    underlying: u, expiry, strike: 0, opt: 'FUT', securityId: f.securityId, lotSize: 1, exchangeSegment: 'MCX_COMM', mult, ...(f.tick > 0 ? { tick: f.tick } : {}),
    ref: { securityId: f.securityId, segment: 'MCX_COMM', expiry },
  };
  if (broker === 'kotak') {
    // Dhan's id prices the contract; Kotak's own master names it and counts BARRELS (lot 10): qty is barrels, so no `mult`.
    const k = await kotakFutureContract(u, expiry);
    if (!k) return `Kotak does not list ${u} futures ${expiry}`;
    if (k.lotSize !== mult) return `${u}: unexpected Kotak lot size ${k.lotSize} — refused`;
    c.tradingSymbol = k.tradingsymbol;
    c.lotSize = k.lotSize;
    delete c.mult;
    if (k.tick) c.tick = k.tick;
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
  if (LADDER_UNDERLYINGS.includes(want) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && ((strike > 0 && (opt === 'CE' || opt === 'PE')) || opt === 'FUT')) {
    const c = await resolveContract('dhan', want, expiry, opt === 'FUT' ? 0 : strike, opt);
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
  // Basket mode: the legs on screen (`basket` = `strike:opt:side:ratio,...`, side B / S as the strategy defines them).
  const { legs: draft, farExpiry: basketFar } = draftFromParam(params.get('basket') ?? '');
  let basketLegs: LadderContract[] | null = null;
  let basketError: string | null = null;
  if (LADDER_UNDERLYINGS.includes(want) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && draft.length) {
    basketError = validateDraft(draft);
    if (!basketError && draft.some(l => l.far) && !(basketFar && basketFar > expiry)) basketError = 'A calendar needs a far expiry after the near one';
    if (!basketError) {
      const cs = await Promise.all(draft.map(l => resolveContract('dhan', want, l.far ? basketFar! : expiry, l.strike, l.opt)));
      const failed = cs.find(c => typeof c === 'string');
      if (failed) basketError = failed as string; else basketLegs = cs as LadderContract[];
    }
  }
  const liveBasketLegs = (state.baskets ?? []).filter(isBasketLive).flatMap(b => b.legs.map(l => l.contract));
  const livePairLegs = (state.pairs ?? []).filter(isPairLive)
    .flatMap(p => [p.legs.ce.contract, p.legs.pe.contract, ...(p.rollTo?.ce ? [p.rollTo.ce] : []), ...(p.rollTo?.pe ? [p.rollTo.pe] : [])]);
  const unders = [...new Set([...(shownKey ? [shownKey] : []), ...(Number(params.get('syn')) > 0 && LADDER_UNDERLYINGS.includes(want) ? [want] : []), ...live.map(x => spotKey(x.contract))])];
  const prices = await loadPrices(unders, [
    ...live.map(x => x.contract), ...(shown ? [shown] : []), ...livePairLegs, ...(pairLegs ? [pairLegs.ce, pairLegs.pe] : []),
    ...liveBasketLegs, ...(basketLegs ?? []),
  ], Number(params.get('syn')) > 0 ? (basketLegs ?? []) : []);
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
      pdc: prevDay?.close ?? null,
      dayHigh: dayHigh && dayHigh > 0 ? dayHigh : null,
      dayLow: dayLow && dayLow > 0 ? dayLow : null,
    },
    // Which contract this reply describes: the page ignores a reply for a selection it has since moved off.
    request: { underlying: want, expiry, strike: opt === 'FUT' ? strike : strike > 0 ? strike : null, opt, pairCe: pairCe > 0 ? pairCe : null, pairPe: pairPe > 0 ? pairPe : null, basket: params.get('basket') ?? '', syn: Number(params.get('syn')) > 0 ? Number(params.get('syn')) : null },
    pair: pairLegs ? {
      ce: { strike: pairLegs.ce.strike, securityId: pairLegs.ce.securityId, ltp: prices.ltps[pairLegs.ce.securityId] ?? null },
      pe: { strike: pairLegs.pe.strike, securityId: pairLegs.pe.securityId, ltp: prices.ltps[pairLegs.pe.securityId] ?? null },
      combined: pairCombined({ legs: { ce: { contract: pairLegs.ce }, pe: { contract: pairLegs.pe } } }, prices.ltps),
      lotSize: pairLegs.ce.lotSize, mult: pairLegs.ce.mult ?? 1,
    } : null,
    basketError,
    basket: basketLegs ? (() => {
      const legsOut = draft.map((l, i) => ({ strike: l.strike, opt: l.opt, side: l.side, ratio: l.ratio, ...(l.far ? { far: true } : {}), expiry: basketLegs![i].expiry, securityId: basketLegs![i].securityId, ltp: prices.ltps[basketLegs![i].securityId] ?? null }));
      const base = { legs: legsOut, lotSize: basketLegs![0].lotSize, mult: basketLegs![0].mult ?? 1 };
      // A synthetic future (`syn` = its strike): the axis is the synthetic price K + CE - PE, not the net premium (which flips sign).
      const synK = Number(params.get('syn'));
      if (synK > 0) {
        const ce = legsOut.find(l => l.opt === 'CE'), pe = legsOut.find(l => l.opt === 'PE');
        const qv = synQuoteVerdict(synK, ce?.ltp ?? undefined, pe?.ltp ?? undefined, ce ? prices.quotes?.[ce.securityId] : undefined, pe ? prices.quotes?.[pe.securityId] : undefined);
        const book = (id?: string) => (id ? prices.quotes?.[id] : undefined);
        return {
          ...base, legs: legsOut.map(l => ({ ...l, bid: book(l.securityId)?.bid ?? null, ask: book(l.securityId)?.ask ?? null })),
          a: synAxis(synK, ce?.ltp ?? undefined, pe?.ltp ?? undefined), credit: null, syn: true,
          // What the legs can really be traded at, and why (if) the last prices are not trusted; `market` null = no depth yet.
          market: qv.market, marketStale: qv.stale, marketWide: qv.wide,
        };
      }
      const ax = basketAxis(draft, l => prices.ltps[basketLegs![draft.indexOf(l)].securityId]);
      return { ...base, a: ax?.a ?? null, credit: ax?.credit ?? null };
    })() : null,
    contract: shown ? {
      securityId: shown.securityId, lotSize: shown.lotSize, ltp: prices.ltps[shown.securityId] ?? null,
      mult: shown.mult ?? 1, tick: shown.opt === 'FUT' ? (shown.tick ?? FUT_TICK) : 0.05, ...(shown.ref ? { refExpiry: shown.ref.expiry, axisDay: axisDayOf(shown, prices.days, now, state.settings?.mcxAutoExitTime) } : {}),
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
