import { NextRequest, NextResponse } from 'next/server';
import { buildLadderView, resolveContract } from '@/lib/priceLadderView';
import { pairAction } from '@/lib/priceLadderPairActions';
import { basketAction } from '@/lib/priceLadderBasketActions';
import { isPairLive, lotsOnContract, patchPair } from '@/lib/priceLadderPair';
import { planExitAll } from '@/lib/priceLadderExitAll';
import {
  readLadderState, updateLadderState, startPriceLadderLoop, loadPrices, afterSend, cancelAtBroker,
  brokerSessionOk, availableFunds, dhanSellMargin, withJob, commitIf, safePlace, openedPatch, LADDER_UNDERLYINGS,
} from '@/lib/priceLadderServer';
import {
  paneOf, sessionFor, spotKey, MAX_LADDER_LOTS, cleanBufferPct, stopLimitPrice, DEFAULT_SL_BUFFER_PCT, MIN_SL_BUFFER_PCT, MAX_SL_BUFFER_PCT, capLots, classifyClick, cleanBracket, istDay, istHhmm, levelSane, pushEvent, realArmed,
  snapToStep, spotFresh, bias, TERMINAL, patchSlice, ev, newLadderId, parseTrailRequest, replanBracket, trailedBracket,
  type ClickType, type LadderZones, type LadderBroker, type LadderContract, type LadderMode, type LadderSide, type LadderSlice, type LadderState, type OptType,
  isTradedStrike, legTag, FUT_TICK,
} from '@/lib/priceLadder';
import { carryRuntime, cleanGuard, guardKey, guardLabel } from '@/lib/priceLadderGuard';
import { setCutoffsFromBody } from '@/lib/priceLadderCutoff';
import { isBasketLive, patchBasket } from '@/lib/priceLadderBasket';

// The Price Ladder's ledger (debug/price_ladder_state.json) and its actions. Real-money endpoint: every check that can
// refuse an order runs here, server-side — lot cap, level sanity, the contract resolved from the brokers' own masters
// (never a security id from the browser), the daily LIVE · REAL MONEY arm, a live broker session and a fail-closed
// funds/margin check. Armed index levels are then fired by the server watcher (lib/priceLadderServer.ts).

const OPTION_TICK = 0.05;
/** The price step orders on this contract snap to. */
const tickOf = (c: Pick<LadderContract, 'opt' | 'tick'>) => (c.opt === 'FUT' ? (c.tick ?? FUT_TICK) : OPTION_TICK);
const parseBroker = (v: unknown): LadderBroker | null => (v === 'dhan' || v === 'kotak' || v === 'zerodha' ? v : null);
const BROKER_NAME: Record<LadderBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };
const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const newId = () => newLadderId('pl');

export async function GET(req: NextRequest): Promise<NextResponse> {
  startPriceLadderLoop();
  try {
    return NextResponse.json({ success: true, data: await buildLadderView(req.nextUrl.searchParams) });
  } catch (err) {
    return bad(String((err as Error).message ?? err), 500);
  }
}

interface ArmBody {
  action: 'arm';
  kind: LadderMode; broker: LadderBroker; mode: 'sim' | 'real';
  underlying: string; expiry: string; strike: number; opt: OptType;
  side: LadderSide; lots: number; product: 'NRML' | 'MIS';
  orderType: 'LIMIT' | 'SL';
  /** XY: the index level. Plain: the option price. */
  level: number;
  bracket?: unknown;
  /** 'anywhere': a click outside the limit zone is a stop without Order Type SL (plain: an SL-limit). */
  zones?: string;
  /** Plain + Anywhere stops: the SL-limit buffer %, the limit is computed here from it (never sent as a price). */
  slBufferPct?: unknown;
  /** What the page showed / the user confirmed ('limit' | 'stop', and which side of the price). Refused if the server's
   *  own read of the price makes it a different order. */
  expect?: { kind?: unknown; dir?: unknown };
  /** 2 = placed from ladder 2 (which table lists it). */
  pane?: unknown;
}


/**
 * Funds/margin for a REAL open on any broker; fails closed (an unreadable figure refuses the order). A BUY needs its
 * premium (+2%) in cash; a SELL needs the exchange margin from Dhan's calculator — SPAN + exposure are the exchange's,
 * the same on every broker, as Multi-Leg Focus prices Kotak/Zerodha baskets — against that broker's own funds.
 */
async function realOpenBlocked(broker: LadderBroker, c: LadderContract, side: LadderSide, qty: number, product: string, price: number): Promise<string | null> {
  const funds = await availableFunds(broker);
  if (funds == null) return `Could not read ${BROKER_NAME[broker]} funds — order refused (fail closed)`;
  // A future is margined both ways (no premium is paid): Dhan's calculator for the side, against the margin balance.
  const isFut = c.opt === 'FUT';
  const need = side === 'BUY' && !isFut ? qty * (c.mult ?? 1) * price * 1.02 : await dhanSellMargin(c, qty, product, price, side);
  if (need == null || !(need > 0)) return 'Could not read the margin for this order — refused (fail closed)';
  const have = side === 'BUY' && !isFut ? funds.buy : funds.sell;
  if (need > have) return `Needs about ₹${Math.round(need).toLocaleString('en-IN')}, ${BROKER_NAME[broker]} has ₹${Math.round(have).toLocaleString('en-IN')}`;
  return null;
}

async function arm(b: ArmBody): Promise<NextResponse> {
  const now = Date.now();
  const u = String(b.underlying ?? '').toUpperCase();
  if (!LADDER_UNDERLYINGS.includes(u)) return bad(`Unsupported underlying ${b.underlying}`);
  if (b.kind !== 'xy' && b.kind !== 'plain') return bad('kind must be xy or plain');
  if (b.broker !== 'dhan' && b.broker !== 'kotak' && b.broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  if (b.mode !== 'sim' && b.mode !== 'real') return bad('mode must be sim or real');
  if (b.opt !== 'CE' && b.opt !== 'PE' && b.opt !== 'FUT') return bad('opt must be CE, PE or FUT');
  if (b.side !== 'BUY' && b.side !== 'SELL') return bad('side must be BUY or SELL');
  if (b.product !== 'NRML' && b.product !== 'MIS') return bad('product must be NRML or MIS');
  if (b.orderType !== 'LIMIT' && b.orderType !== 'SL') return bad('orderType must be LIMIT or SL');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry))) return bad('expiry must be YYYY-MM-DD');
  const lots = capLots(b.lots);
  if (lots == null) return bad('Lots must be a whole number from 1 to 20');
  // A future has no strike: the contract is its expiry alone.
  const strike = b.opt === 'FUT' ? 0 : Number(b.strike);
  if (b.opt !== 'FUT' && !(strike > 0)) return bad('Invalid strike');
  if (b.opt !== 'FUT' && !isTradedStrike(u, strike)) return bad(`${u} strike ${strike} is not offered — the Price Ladder trades 100-point strikes only`);
  const state = readLadderState();
  const sess = sessionFor(u, istDay(now), state.settings?.mcxAutoExitTime, state.settings?.nseAutoExitTime);
  if (sess.open >= sess.close) return bad(sess.note ?? 'The market is closed today');
  if (istHhmm(now) >= sess.autoExit) return bad(`After ${sess.autoExitLabel} the ladder only exits`);
  // A REAL plain order goes to the broker now, so the market must be open. (An XY level may be armed early: the
  // watcher only fires it inside the session.)
  if (b.mode === 'real' && b.kind === 'plain' && (istHhmm(now) < sess.open || istHhmm(now) >= sess.close)) return bad('The market is closed');
  const bracket = b.bracket == null ? null : cleanBracket(b.bracket);
  if (b.bracket != null && !bracket) return bad('Bracket needs a positive SL in points (target 0 = Cover order)');
  if (bracket && b.kind !== 'xy') return bad('Brackets are index-level (XY) orders only');

  if (b.mode === 'real') {
    if (!realArmed(state, istDay(now))) return bad('Switch on LIVE · REAL MONEY first', 403);
    if (!brokerSessionOk(b.broker)) return bad(`${BROKER_NAME[b.broker]} session is not logged in`, 403);
  }
  const c = await resolveContract(b.broker, u, b.expiry, strike, b.opt);
  if (typeof c === 'string') return bad(c);
  const qty = lots * c.lotSize;
  const probe = { contract: c, broker: b.broker, mode: b.mode, side: b.side } as LadderSlice;
  const held0 = lotsHeld(state, probe);
  if (held0 + lots > MAX_LADDER_LOTS) return bad(`The ladder already holds or has armed ${held0} lots of this contract — the cap is ${MAX_LADDER_LOTS}`);

  const prices = await loadPrices([spotKey(c)], [c]);
  const spot = prices.spots[spotKey(c)];
  const ltp = prices.ltps[c.securityId] ?? 0;
  const level = b.kind === 'xy' ? Number(b.level) : snapToStep(Number(b.level), tickOf(c));

  if (b.kind === 'xy') {
    if (!spot || !spotFresh(spot.at, now)) return bad(`No fresh live ${u}${c.ref ? ' futures' : ''} price yet — the WebSocket feed may still be subscribing, or the market is quiet or shut; try again in a moment`);
    if (!levelSane(level, spot.spot)) return bad(`Level ${level} is more than 5% from spot ${spot.spot}`);
  } else if (!(ltp > 0)) {
    return bad('No live option price yet');
  }
  const ref = b.kind === 'xy' ? spot!.spot : ltp;
  const zones: LadderZones = b.zones === 'anywhere' ? 'anywhere' : 'classic';
  const verdict = classifyClick({ mode: b.kind, opt: b.opt, side: b.side, level, ref, orderType: b.orderType, zones });
  if (!verdict.ok) return bad(verdict.error);
  // The price may have crossed the level between the click and now: never turn a confirmed LIMIT into a stop (or a dip
  // entry into a breakout) behind the user's back.
  if (b.expect && (b.expect.kind !== verdict.kind || b.expect.dir !== verdict.dir)) {
    return bad(`The price crossed ${level} since you clicked — that would now be a ${verdict.kind === 'stop' ? 'stop' : 'LIMIT'} order, not what you placed. Nothing was sent; click again.`, 409);
  }
  // What the order really is: a stop is SL; otherwise what was chosen (a Classic SL in the limit zone stays SL, so it
  // can still be dragged across the price).
  const orderType: ClickType = verdict.kind === 'stop' ? 'SL' : b.orderType;
  // Plain + Anywhere stop = SL-limit: its limit comes from the validated buffer, computed here.
  let stopLimit: number | null = null;
  if (b.kind === 'plain' && verdict.kind === 'stop' && zones === 'anywhere') {
    const buf = cleanBufferPct(b.slBufferPct ?? DEFAULT_SL_BUFFER_PCT);
    if (buf == null) return bad(`SL limit buffer must be ${MIN_SL_BUFFER_PCT}-${MAX_SL_BUFFER_PCT}%`);
    stopLimit = stopLimitPrice(b.side, level, buf, tickOf(c));
    if (stopLimit == null) return bad('Could not price the SL-limit — pick another level or buffer');
  }

  if (b.mode === 'real') {
    // A BUY stop can fill above its trigger: check funds at the worst case — an SL-limit's limit, an SL-M's trigger + 5%
    // (it fills at market). XY entries fire at market from the live premium.
    const price = b.kind === 'xy' ? (b.side === 'BUY' ? snapToStep(ltp * 1.05, tickOf(c)) : ltp)
      : b.side === 'BUY' && verdict.kind === 'stop' ? (stopLimit ?? snapToStep(level * 1.05, tickOf(c)))
        : level;
    if (!(price > 0)) return bad('No live option price to check margin against');
    const blocked = await realOpenBlocked(b.broker, c, b.side, qty, b.product, price);
    if (blocked) return bad(blocked);
  }

  const base: LadderSlice = {
    id: newId(), kind: b.kind, broker: b.broker, mode: b.mode, contract: c, side: b.side, lots, qty, product: b.product,
    state: 'armed', createdAt: now, updatedAt: now, ...(b.pane === 2 ? { pane: 2 as const } : {}),
  };
  const what = `${b.mode === 'sim' ? 'SIM ' : ''}${b.side} ${lots} lot(s) ${u} ${legTag(c)}`;

  if (b.kind === 'xy') {
    const slice: LadderSlice = { ...base, entryLevel: level, entryDir: verdict.dir, seenSafe: true, orderType, ...(zones === 'anywhere' ? { zones } : {}), ...(bracket ? { bracket } : {}) };
    const br = bracket ? ` · ${bracket.tgtPts > 0 ? `TGT ${bracket.tgtPts} / ` : 'Cover · '}SL ${bracket.slPts}${bracket.trailPts ? ` / trailing ${bracket.trailPts} behind` : ''} pts` : '';
    let capped = false;
    const s = await updateLadderState(st => {
      // Re-checked inside the lock: two clicks in flight must not both pass the read above.
      if (lotsHeld(st, slice) + lots > MAX_LADDER_LOTS) { capped = true; return st; }
      return pushEvent({ ...st, slices: [...st.slices, slice] }, ev('info', `Armed ${what} when ${u} ${verdict.dir === 'below' ? '≤' : '≥'} ${level}${br}`, slice.id));
    });
    if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
    return NextResponse.json({ success: true, data: { id: slice.id, state: s } });
  }

  // Plain: a resting order on the option's own price.
  const plain: LadderSlice = {
    ...base, orderType,
    ...(verdict.kind === 'limit' ? { limitPrice: level } : { triggerPrice: level, ...(stopLimit ? { stopLimitPrice: stopLimit } : {}) }),
  };
  const kindLabel = verdict.kind === 'limit' ? 'LIMIT' : stopLimit ? 'SL-limit' : 'SL';
  const at = stopLimit ? `trigger ${level} → limit ${stopLimit.toFixed(2)}` : `@ ${level}`;
  // Re-checked inside the lock like the XY arm and the Market button: two clicks in flight must not both pass the read above.
  let capped = false;
  const withPlain = (add: LadderSlice, log?: ReturnType<typeof ev>) => (st: LadderState): LadderState => {
    if (lotsHeld(st, add) + lots > MAX_LADDER_LOTS) { capped = true; return st; }
    const next = { ...st, slices: [...st.slices, add] };
    return log ? pushEvent(next, log) : next;
  };
  const cappedReply = () => bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
  if (b.mode === 'sim') {
    const s = await updateLadderState(withPlain({ ...plain, state: 'working' }, ev('info', `SIM ${kindLabel} ${what} ${at}`, plain.id)));
    if (capped) return cappedReply();
    return NextResponse.json({ success: true, data: { id: plain.id, state: s } });
  }
  // REAL: checkpoint before the order (Triple Straddle rule) — if this write fails nothing is sent.
  await updateLadderState(withPlain({ ...plain, state: 'placing', sentAt: now }));
  if (capped) return cappedReply();
  const r = await withJob(plain.id, () => safePlace(plain, b.side, qty, true, verdict.kind === 'limit'
    ? { type: 'LIMIT', price: level }
    : { type: 'SL', trigger: level, ...(stopLimit ? { limit: stopLimit } : {}) }));
  const s = await commitIf(plain.id, 'placing', st => pushEvent(afterSend(st, plain.id, r, 'entry'), ev('info', `${kindLabel} ${what} ${at}: ${r.status}`, plain.id)));
  if (r.status === 'placed') return NextResponse.json({ success: true, data: { id: plain.id, state: s } });
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error, data: { state: s } }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error, data: { state: s } });
}

/**
 * Buy / Sell Market buttons: one option contract at MARKET now, no level, no bracket (Single style; exit it from its
 * widget or the MTM guard). An opening order, so every check an arm has applies — the REAL arm, a live session, market
 * hours, the auto-exit time, the 20-lot cap and funds/margin. SIM opens at the live premium, as the "+1 lot" does.
 */
async function marketOrder(b: Record<string, unknown>): Promise<NextResponse> {
  const now = Date.now();
  const u = String(b.underlying ?? '').toUpperCase();
  if (!LADDER_UNDERLYINGS.includes(u)) return bad(`Unsupported underlying ${b.underlying}`);
  const broker = b.broker;
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  if (b.mode !== 'sim' && b.mode !== 'real') return bad('mode must be sim or real');
  if (b.opt !== 'CE' && b.opt !== 'PE' && b.opt !== 'FUT') return bad('opt must be CE, PE or FUT');
  if (b.side !== 'BUY' && b.side !== 'SELL') return bad('side must be BUY or SELL');
  if (b.product !== 'NRML' && b.product !== 'MIS') return bad('product must be NRML or MIS');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry))) return bad('expiry must be YYYY-MM-DD');
  const lots = capLots(b.lots);
  if (lots == null) return bad('Lots must be a whole number from 1 to 20');
  // A future has no strike: the contract is its expiry alone.
  const strike = b.opt === 'FUT' ? 0 : Number(b.strike);
  if (b.opt !== 'FUT' && !(strike > 0)) return bad('Invalid strike');
  const mode = b.mode, side = b.side, opt = b.opt, product = b.product;
  const st0 = readLadderState();
  const sess = sessionFor(u, istDay(now), st0.settings?.mcxAutoExitTime, st0.settings?.nseAutoExitTime);
  if (sess.open >= sess.close) return bad(sess.note ?? 'The market is closed today');
  if (istHhmm(now) >= sess.autoExit) return bad(`After ${sess.autoExitLabel} the ladder only exits`);
  if (mode === 'real') {
    if (istHhmm(now) < sess.open || istHhmm(now) >= sess.close) return bad('The market is closed');
    if (!realArmed(st0, istDay(now))) return bad('Switch on LIVE · REAL MONEY first', 403);
    if (!brokerSessionOk(broker)) return bad(`${BROKER_NAME[broker]} session is not logged in`, 403);
  }
  const c = await resolveContract(broker, u, String(b.expiry), strike, opt);
  if (typeof c === 'string') return bad(c);
  const qty = lots * c.lotSize;
  const prices = await loadPrices([spotKey(c)], [c]);
  const ltp = prices.ltps[c.securityId] ?? 0;
  if (!(ltp > 0)) return bad('No live option price yet');
  // Where the axis (index / futures) stood when the order went: the Index ladder draws the position on that row. A stale
  // price is left out rather than drawn at a level the market was not at.
  const axis = prices.spots[spotKey(c)];
  const child: LadderSlice = {
    id: newId(), kind: 'plain', broker, mode, contract: c, side, lots, qty, product, state: 'placing',
    createdAt: now, updatedAt: now, sentAt: now, orderType: 'LIMIT', market: true,
    // Without a live axis price the Index ladder cannot place the position on a row: say so on the slice.
    note: axis && spotFresh(axis.at, now) ? 'Market order' : `Market order (no live ${u} price: not drawn on the Index ladder)`,
    ...(axis && spotFresh(axis.at, now) ? { entryY: axis.spot } : {}), ...(b.pane === 2 ? { pane: 2 as const } : {}),
  };
  if (lotsHeld(st0, child) + lots > MAX_LADDER_LOTS) return bad(`The ladder already holds or has armed ${lotsHeld(st0, child)} lots of this contract — the cap is ${MAX_LADDER_LOTS}`);
  if (mode === 'real') {
    // Worst case a market BUY fills a little above the last price.
    const blocked = await realOpenBlocked(broker, c, side, qty, product, side === 'BUY' ? snapToStep(ltp * 1.05, tickOf(c)) : ltp);
    if (blocked) return bad(blocked);
  }
  const what = `${mode === 'sim' ? 'SIM ' : ''}${side} ${lots} lot(s) ${u} ${legTag(c)} at MARKET`;
  let capped = false;
  const withSlice = (st: LadderState): LadderState => {
    // Re-checked inside the lock: two clicks in flight must not both pass the read above.
    if (lotsHeld(st, child) + lots > MAX_LADDER_LOTS) { capped = true; return st; }
    return { ...st, slices: [...st.slices, child] };
  };
  if (mode === 'sim') {
    const s = await updateLadderState(st => { const n = withSlice(st); return n === st ? st : openedPatch(pushEvent(n, ev('info', what, child.id)), child, qty, ltp, now); });
    if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
    return NextResponse.json({ success: true, data: { id: child.id, state: s } });
  }
  // REAL: checkpoint before the order; the watcher settles its fill like any entry.
  await updateLadderState(withSlice);
  if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
  const r = await withJob(child.id, () => safePlace(child, side, qty, true));
  const s = await commitIf(child.id, 'placing', st => pushEvent(afterSend(st, child.id, r, 'entry'), ev('info', `${what}: ${r.status}`, child.id)));
  if (r.status === 'placed') return NextResponse.json({ success: true, data: { id: child.id, state: s } });
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error, data: { state: s } }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error, data: { state: s } });
}

/**
 * Lots this ladder holds, has on the wire or has armed on the same contract, broker, mode and side (the 20-lot holding
 * cap). Armed XY levels count: the watcher fires them at market without re-checking, so several could cross at once.
 */
function lotsHeld(st: LadderState, p: LadderSlice, exceptId?: string): number {
  // Pair legs on the same contract count too (one cap across single options and pairs).
  return lotsOnContract(st, p.contract.securityId, p.broker, p.mode, p.side, exceptId);
}

/**
 * The + on an open position's widget: one more lot of the same contract at MARKET now, joining that position's
 * target / SL / trailing levels (it is exited with them). An opening order: every check an arm has applies — the
 * REAL arm, a live session, market hours, the auto-exit time, the 20-lot cap (on the whole open position) and funds/margin.
 */
async function addLot(id: string): Promise<NextResponse> {
  const now = Date.now();
  const st0 = readLadderState();
  const p = st0.slices.find(y => y.id === id);
  if (!p || p.state !== 'open') return bad('That position is not open');
  const hhmm = istHhmm(now);
  const sess = sessionFor(p.contract.underlying, istDay(now), st0.settings?.mcxAutoExitTime, st0.settings?.nseAutoExitTime);
  if (sess.open >= sess.close) return bad(sess.note ?? 'The market is closed today');
  if (hhmm >= sess.autoExit) return bad(`After ${sess.autoExitLabel} the ladder only exits`);
  if (p.mode === 'real') {
    if (hhmm < sess.open || hhmm >= sess.close) return bad('The market is closed');
    if (!realArmed(st0, istDay(now))) return bad('Switch on LIVE · REAL MONEY first', 403);
    if (!brokerSessionOk(p.broker)) return bad(`${BROKER_NAME[p.broker]} session is not logged in`, 403);
  }
  const heldLots = lotsHeld(st0, p);
  if (heldLots + 1 > MAX_LADDER_LOTS) return bad(`The ladder holds ${heldLots} lots of this contract — the cap is ${MAX_LADDER_LOTS}`);
  const prices = await loadPrices([spotKey(p.contract)], [p.contract]);
  const ltp = prices.ltps[p.contract.securityId] ?? 0;
  if (!(ltp > 0)) return bad('No live option price yet');
  const qty = p.contract.lotSize;
  if (p.mode === 'real') {
    const blocked = await realOpenBlocked(p.broker, p.contract, p.side, qty, p.product, p.side === 'BUY' ? snapToStep(ltp * 1.05, tickOf(p.contract)) : ltp);
    if (blocked) return bad(blocked);
  }
  const child: LadderSlice = {
    id: newId(), kind: p.kind, broker: p.broker, mode: p.mode, contract: p.contract, side: p.side, lots: 1, qty,
    product: p.product, state: 'placing', createdAt: now, updatedAt: now, sentAt: now, orderType: p.orderType, market: true,
    entryLevel: p.entryLevel, entryDir: p.entryDir, entryY: p.entryY,
    ...(p.bracket ? { bracket: p.bracket, tgtY: p.tgtY, slY: p.slY, slY0: p.slY0, trailFrom: p.trailFrom, peakY: p.peakY } : {}),
    note: `Added to ${p.id}`, ...(p.pane ? { pane: p.pane } : {}),
  };
  let capped = false;
  const what = `${p.mode === 'sim' ? 'SIM ' : ''}+1 lot ${p.side} ${legTag(p.contract)}`;
  if (p.mode === 'sim') {
    const s = await updateLadderState(st => {
      // Re-checked inside the lock: two + clicks in flight must not both pass the read above.
      if (lotsHeld(st, child) + 1 > MAX_LADDER_LOTS) { capped = true; return st; }
      return openedPatch(pushEvent({ ...st, slices: [...st.slices, child] }, ev('info', what, child.id)), child, qty, ltp, now);
    });
    if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
    return NextResponse.json({ success: true, data: { id: child.id, state: s } });
  }
  // REAL: checkpoint before the order; the watcher settles its fill like any entry.
  await updateLadderState(st => {
    if (lotsHeld(st, child) + 1 > MAX_LADDER_LOTS) { capped = true; return st; }
    return { ...st, slices: [...st.slices, child] };
  });
  if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
  const r = await withJob(child.id, () => safePlace(child, child.side, qty, true));
  const s = await commitIf(child.id, 'placing', st => pushEvent(afterSend(st, child.id, r, 'entry'), ev('info', `${what} at MARKET: ${r.status}`, child.id)));
  if (r.status === 'placed') return NextResponse.json({ success: true, data: { id: child.id, state: s } });
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error, data: { state: s } }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error, data: { state: s } });
}

/** Apply `mutate` only if the slice still passes `ok` inside the lock (the watcher can move it between a read and the write). */
async function guarded(id: string, ok: (x: LadderSlice) => boolean, mutate: (s: LadderState) => LadderState): Promise<{ applied: boolean; state: LadderState }> {
  let applied = false;
  const state = await updateLadderState(st => {
    const x = st.slices.find(y => y.id === id);
    if (!x || !ok(x)) return st;
    applied = true;
    return mutate(st);
  });
  return { applied, state };
}

/**
 * Mark slices of one contract for exit, oldest first, splitting one if the amount stops inside it. Whole lots only.
 * The amount is `pct` of what is open, or a number of `lots` (the − on a ladder widget exits one).
 */
function markExit(st: LadderState, filter: (x: LadderSlice) => boolean, amount: { pct: number } | { lots: number }): LadderState {
  const open = st.slices.filter(x => x.state === 'open' && !x.exitWanted && filter(x)).sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  if (!open.length) return st;
  const lot = open[0].contract.lotSize;
  const total = open.reduce((a, x) => a + (Number(x.filledQty) || 0), 0);
  let left = 'lots' in amount ? Math.min(total, amount.lots * lot)
    : amount.pct >= 100 ? total : Math.max(lot, Math.floor((total * amount.pct) / 100 / lot) * lot);
  let next = st;
  for (const x of open) {
    if (left <= 0) break;
    const q = Number(x.filledQty) || 0;
    if (q <= left) {
      next = patchSlice(next, x.id, { exitWanted: 'Manual exit' });
      left -= q;
    } else {
      const remainder: LadderSlice = { ...x, id: `${x.id}-r${Date.now().toString(36)}`, filledQty: q - left, qty: q - left, lots: Math.max(1, Math.round((q - left) / lot)), updatedAt: Date.now() };
      next = patchSlice(next, x.id, { filledQty: left, qty: left, lots: Math.max(1, Math.round(left / lot)), exitWanted: 'Manual exit' });
      next = { ...next, slices: [...next.slices, remainder] };
      left = 0;
    }
  }
  return next;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  startPriceLadderLoop();
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return bad('Invalid JSON'); }
  const action = String(body.action ?? '');
  const id = typeof body.id === 'string' ? body.id : '';
  const today = istDay();
  try {
    switch (action) {
      case 'arm':
        return await arm(body as unknown as ArmBody);

      case 'market':
        return await marketOrder(body);

      case 'basket':
        // Basket mode (prebuilt multi-leg strategies on their net premium): SIM and REAL (priceLadderBasketActions).
        return await basketAction(body);

      case 'pair':
        // Pair mode (straddle / strangle on the combined premium): SIM only for now.
        return await pairAction(body);

      case 'live': {
        const on = body.on === true;
        const s = await updateLadderState(st => pushEvent({ ...st, liveArmedOn: on ? today : undefined }, ev(on ? 'warn' : 'info', on ? 'LIVE · REAL MONEY armed for today' : 'LIVE · REAL MONEY off — armed REAL levels will be cancelled')));
        return NextResponse.json({ success: true, data: { state: s } });
      }

      case 'guard': {
        // The MTM guard of one ladder + broker + mode. It only ever exits (and cancels entries), so no REAL arm is needed.
        // `pane: 2` = ladder 2's guard; absent = ladder 1 (the pre-pane key, so an existing guard stays ladder 1's).
        const broker = parseBroker(body.broker);
        const mode = body.mode === 'real' ? 'real' : body.mode === 'sim' ? 'sim' : null;
        if (!broker || !mode) return bad('broker and mode required');
        if (body.pane !== undefined && body.pane !== 1 && body.pane !== 2) return bad('pane must be 1 or 2');
        const sc = { broker, mode, pane: body.pane === 2 ? 2 : 1 } as const;
        const key = guardKey(broker, mode, sc.pane);
        if (body.on !== true) {
          // Switching off never validates: a half-edited draft must not keep a live exit-everything rule on.
          const s = await updateLadderState(st => {
            const old = st.guards?.[key];
            const off = { ...(old ?? {}), on: false, tripped: undefined, peak: undefined, floor: undefined, firedReason: undefined };
            return pushEvent({ ...st, guards: { ...(st.guards ?? {}), [key]: off } }, ev('info', `MTM guard ${guardLabel(sc)} off`));
          });
          return NextResponse.json({ success: true, data: { state: s } });
        }
        const g = cleanGuard(body);
        if (typeof g === 'string') return bad(g);
        const s = await updateLadderState(st => {
          const guards = { ...(st.guards ?? {}) };
          guards[key] = carryRuntime(g, guards[key]);
          return pushEvent({ ...st, guards }, ev('info', `MTM guard ${guardLabel(sc)} ${g.on ? 'on' : 'off'}`));
        });
        return NextResponse.json({ success: true, data: { state: s } });
      }

      case 'settings': {
        // The MCX / NSE cutoffs: one server path with /api/price-ladder/settings (range check; a passed time needs confirmPast).
        const r = await setCutoffsFromBody(body);
        if (!r.ok) return NextResponse.json({ success: false, error: r.error, ...(r.needsConfirm ? { needsConfirm: true } : {}) }, { status: r.status });
        return NextResponse.json({ success: true, settings: r.settings, data: { state: readLadderState() } });
      }

      case 'cancel': {
        const x = readLadderState().slices.find(y => y.id === id);
        if (!x) return bad('Unknown order');
        if (x.state === 'armed' || (x.state === 'working' && x.mode === 'sim')) {
          // Re-checked under the lock: the watcher may have fired this level since the read above.
          const r = await guarded(id, y => y.state === 'armed' || (y.state === 'working' && y.mode === 'sim'),
            st => pushEvent(patchSlice(st, id, { state: 'cancelled', note: 'Cancelled by you' }), ev('info', 'Cancelled', id)));
          if (!r.applied) return bad('Too late — it has just fired; check the orders list', 409);
          return NextResponse.json({ success: true, data: { state: r.state } });
        }
        if (x.state === 'working' && x.mode === 'real' && x.orderId) {
          // The watcher settles it from the order book once the broker confirms the cancel.
          try { await cancelAtBroker(x.broker, x.orderId); } catch (err) {
            return bad(`${BROKER_NAME[x.broker]} did not confirm the cancel: ${String((err as Error).message ?? err)} — check Orders before retrying`, 502);
          }
          const s = await updateLadderState(st => pushEvent(st, ev('info', `Cancel sent for order ${x.orderId}`, id)));
          return NextResponse.json({ success: true, data: { state: s } });
        }
        return bad(`Cannot cancel an order that is ${x.state}`);
      }

      case 'cancelAll': {
        // Every pending order of this contract on this broker and mode (OptionX's "cancel all"). Positions are untouched.
        const securityId = typeof body.securityId === 'string' ? body.securityId : '';
        const broker = parseBroker(body.broker);
        const mode = body.mode === 'real' ? 'real' : body.mode === 'sim' ? 'sim' : null;
        if (!securityId || !broker || !mode) return bad('securityId, broker and mode required');
        const match = (x: LadderSlice) => x.contract.securityId === securityId && x.broker === broker && x.mode === mode;
        const local = (x: LadderSlice) => match(x) && (x.state === 'armed' || (x.state === 'working' && x.mode === 'sim'));
        let n = 0;
        const s0 = await updateLadderState(st => {
          const ids = st.slices.filter(local).map(x => x.id);
          n = ids.length;
          return ids.reduce((acc, i) => patchSlice(acc, i, { state: 'cancelled', note: 'Cancelled by you (all)' }), st);
        });
        const atBroker = s0.slices.filter(x => match(x) && x.state === 'working' && x.mode === 'real' && x.orderId);
        const failed: string[] = [];
        for (const x of atBroker) {
          try { await cancelAtBroker(x.broker, x.orderId!); } catch { failed.push(x.orderId!); }
        }
        const s = await updateLadderState(st => pushEvent(st, ev(failed.length ? 'error' : 'info',
          `Cancel all: ${n} level(s) cancelled${atBroker.length ? `, ${atBroker.length - failed.length} broker cancel(s) sent` : ''}${failed.length ? `, failed for ${failed.join(', ')}` : ''}`)));
        if (failed.length) return NextResponse.json({ success: false, error: `Cancel failed for order(s) ${failed.join(', ')}`, data: { state: s } });
        return NextResponse.json({ success: true, data: { state: s } });
      }

      case 'exitAll': {
        // Every ladder at once (both panes, every broker, SIM and REAL): mark each open position for exit, exactly as the
        // per-ladder Exit does, and the watcher sends the orders, each sized against the broker's own book. Needs no REAL arm
        // (exits never do). `signature` is the plan the user saw in the confirm dialog: if a position opened or closed since,
        // nothing is done and the dialog is shown again. With `cancelPending`, armed levels and resting entry orders are
        // cancelled too (as cancelAll does), so nothing re-enters right after. UNKNOWN slices are never touched.
        const cancelPending = body.cancelPending === true;
        const signature = typeof body.signature === 'string' ? body.signature : '';
        let changed = false;
        const out = { marked: 0, cancelled: 0, unknown: 0, inFlight: 0 };
        const atBroker: LadderSlice[] = [];
        const s0 = await updateLadderState(st => {
          const plan = planExitAll(st);
          if (plan.signature !== signature) { changed = true; return st; }
          out.unknown = plan.unknown;
          out.inFlight = plan.inFlight;
          out.marked = plan.sliceIds.length + plan.pairIds.length + plan.basketIds.length;
          let next = st;
          for (const sid of plan.sliceIds) next = patchSlice(next, sid, { exitWanted: 'Manual exit' });
          for (const pid of plan.pairIds) next = patchPair(next, pid, { exitWanted: 'Manual exit' });
          for (const kid of plan.basketIds) next = patchBasket(next, kid, { exitWanted: 'Manual exit' });
          if (cancelPending) {
            const byId = new Map(st.slices.map(x => [x.id, x]));
            for (const sid of plan.cancelSliceIds) {
              const x = byId.get(sid);
              if (!x) continue;
              if (x.state === 'working' && x.mode === 'real') { if (x.orderId) atBroker.push(x); continue; } // a REAL resting order: cancelled at the broker below
              next = patchSlice(next, sid, { state: 'cancelled', note: 'Cancelled by you (exit all)' });
              out.cancelled++;
            }
            for (const pid of plan.cancelPairIds) { next = patchPair(next, pid, { state: 'cancelled', note: 'Cancelled by you (exit all)' }); out.cancelled++; }
            for (const kid of plan.cancelBasketIds) { next = patchBasket(next, kid, { state: 'cancelled', note: 'Cancelled by you (exit all)' }); out.cancelled++; }
          }
          if (!out.marked && !out.cancelled && !atBroker.length) return st;
          return pushEvent(next, ev('info', `Exit all: ${out.marked} position(s) marked for exit${cancelPending ? `, ${out.cancelled + atBroker.length} pending level(s)/order(s) cancelled` : ''}`));
        });
        if (changed) return bad('The ladders changed since you opened this — review the list and try again', 409);
        if (!out.marked && !out.cancelled && !atBroker.length) return bad('Nothing to exit', 409);
        const failed: string[] = [];
        for (const x of atBroker) {
          try { await cancelAtBroker(x.broker, x.orderId!); } catch { failed.push(x.orderId!); }
        }
        const s = failed.length
          ? await updateLadderState(st => pushEvent(st, ev('error', `Exit all: broker cancel failed for order(s) ${failed.join(', ')}`)))
          : s0;
        const cancelledAll = out.cancelled + atBroker.length - failed.length;
        if (failed.length) return NextResponse.json({ success: false, error: `Positions are being exited, but cancelling order(s) ${failed.join(', ')} failed — cancel them in Orders`, data: { state: s, ...out, cancelled: cancelledAll } });
        return NextResponse.json({ success: true, data: { state: s, ...out, cancelled: cancelledAll } });
      }

      case 'lots': {
        // The + / − on an order that has not filled: change its lots in place (an armed XY level, or a SIM resting
        // order). A REAL order resting at the broker is not modified here — cancel it and place it again.
        const lots = capLots(body.lots);
        if (lots == null) return bad('Lots must be a whole number from 1 to 20');
        const st0 = readLadderState();
        const x0 = st0.slices.find(y => y.id === id);
        if (!x0) return bad('Unknown order');
        // More lots on a REAL level is a bigger opening order: the same holding cap and funds/margin check as an arm.
        if (x0.mode === 'real' && lots > x0.lots) {
          if (lotsHeld(st0, x0, x0.id) + lots > MAX_LADDER_LOTS) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
          const prices = await loadPrices([spotKey(x0.contract)], [x0.contract]);
          const ltp = prices.ltps[x0.contract.securityId] ?? 0;
          if (!(ltp > 0)) return bad('No live option price to check margin against');
          const blocked = await realOpenBlocked(x0.broker, x0.contract, x0.side, lots * x0.contract.lotSize, x0.product, ltp);
          if (blocked) return bad(blocked);
        }
        let capped = false;
        const r = await guarded(id, y => y.state === 'armed' || (y.state === 'working' && y.mode === 'sim'), st => {
          const x = st.slices.find(y => y.id === id)!;
          // Re-checked inside the lock: two + clicks in flight must not both pass the read above.
          if (x.mode === 'real' && lots > x.lots && lotsHeld(st, x, x.id) + lots > MAX_LADDER_LOTS) { capped = true; return st; }
          return pushEvent(patchSlice(st, id, { lots, qty: lots * x.contract.lotSize }), ev('info', `Lots changed to ${lots}`, id));
        });
        if (capped) return bad(`That would take this contract past the ${MAX_LADDER_LOTS}-lot cap`);
        if (!r.applied) return bad('Only an armed level or a SIM resting order can change its lots — cancel and place it again', 409);
        return NextResponse.json({ success: true, data: { state: r.state } });
      }

      case 'add':
        return await addLot(id);

      case 'exit': {
        const pct = Number(body.pct ?? 100);
        const lots = body.lots == null ? null : capLots(body.lots);
        if (body.lots != null && lots == null) return bad('lots must be a whole number from 1 to 20');
        if (lots == null && ![25, 50, 75, 100].includes(pct)) return bad('pct must be 25, 50, 75 or 100');
        const ids = Array.isArray(body.ids) ? new Set(body.ids.map(String)) : null;
        const securityId = typeof body.securityId === 'string' ? body.securityId : '';
        const broker = parseBroker(body.broker);
        const mode = body.mode === 'real' ? 'real' : body.mode === 'sim' ? 'sim' : null;
        if (!id && !ids && !(securityId && broker && mode)) return bad('id, ids, or securityId with broker and mode, required');
        const s = await updateLadderState(st => {
          const filter = id ? (x: LadderSlice) => x.id === id
            : ids ? (x: LadderSlice) => ids.has(x.id)
              : (x: LadderSlice) => x.contract.securityId === securityId && x.broker === broker && x.mode === mode;
          const next = markExit(st, filter, lots != null ? { lots } : { pct });
          return next === st ? st : pushEvent(next, ev('info', lots != null ? `Exit ${lots} lot(s) requested` : `Exit ${pct}% requested`, id || undefined));
        });
        return NextResponse.json({ success: true, data: { state: s } });
      }

      case 'modify': {
        const x = readLadderState().slices.find(y => y.id === id);
        if (!x) return bad('Unknown order');
        if (x.kind === 'plain' && x.state === 'working' && x.mode === 'sim') {
          // A SIM resting order moved in place (same id): the same rules as a click, against the option's own price.
          const c = x.contract;
          const level = snapToStep(Number(body.level), tickOf(c));
          const ltp = (await loadPrices([spotKey(c)], [c])).ltps[c.securityId] ?? 0;
          if (!(level > 0) || !(ltp > 0)) return bad('No live option price to check the new level against');
          const zones: LadderZones = body.zones === 'anywhere' ? 'anywhere' : 'classic';
          const v = classifyClick({ mode: 'plain', opt: c.opt, side: x.side, level, ref: ltp, orderType: x.orderType ?? 'LIMIT', zones });
          if (!v.ok) return bad(v.error);
          let stopLimit: number | null = null;
          if (v.kind === 'stop' && zones === 'anywhere') {
            const buf = cleanBufferPct(body.slBufferPct ?? DEFAULT_SL_BUFFER_PCT);
            if (buf == null) return bad(`SL limit buffer must be ${MIN_SL_BUFFER_PCT}-${MAX_SL_BUFFER_PCT}%`);
            stopLimit = stopLimitPrice(x.side, level, buf, tickOf(c));
            if (stopLimit == null) return bad('Could not price the SL-limit — pick another level or buffer');
          }
          const orderType: ClickType = v.kind === 'stop' ? 'SL' : zones === 'anywhere' ? 'LIMIT' : (x.orderType ?? 'LIMIT');
          const r = await guarded(id, y => y.state === 'working' && y.mode === 'sim', st => pushEvent(
            patchSlice(st, id, v.kind === 'limit'
              ? { orderType, limitPrice: level, triggerPrice: undefined, stopLimitPrice: undefined }
              : { orderType, triggerPrice: level, limitPrice: undefined, stopLimitPrice: stopLimit ?? undefined }),
            ev('info', `SIM order moved to ${level}`, id)));
          if (!r.applied) return bad('Too late — it has just filled or been cancelled', 409);
          return NextResponse.json({ success: true, data: { state: r.state } });
        }
        const prices = await loadPrices([spotKey(x.contract)], []);
        const sp = prices.spots[spotKey(x.contract)];
        if (!sp || !spotFresh(sp.at, Date.now())) return bad('No fresh spot to check the level against');
        if (x.state === 'armed' && x.kind === 'xy' && x.bracket && (body.tgtY != null || body.slY != null) && body.level == null) {
          // A planned target / SL dragged before the fill: stored as points from the entry level, so they still move
          // with the entry and open where the fill lands.
          const b = bias(x.contract.opt, x.side);
          const entry = Number(x.entryLevel);
          const tgtY = body.tgtY == null ? null : Number(body.tgtY);
          const slY = body.slY == null ? null : Number(body.slY);
          const sane = (v: number) => levelSane(v, sp.spot);
          const check = replanBracket(x.bracket, entry, b, tgtY, slY, sane);
          if (typeof check === 'string') return bad(check);
          const r = await guarded(id, y => y.state === 'armed' && !!y.bracket && y.entryLevel === x.entryLevel, st => {
            const y = st.slices.find(z => z.id === id)!;
            const bracket = replanBracket(y.bracket!, entry, b, tgtY, slY, sane) as typeof check;
            return pushEvent(patchSlice(st, id, { bracket }), ev('info', `Planned bracket: TGT ${bracket.tgtPts > 0 ? `${bracket.tgtPts} pts` : '—'} / SL ${bracket.slPts} pts`, id));
          });
          if (!r.applied) return bad('Too late — it has just fired or moved; try again', 409);
          return NextResponse.json({ success: true, data: { state: r.state } });
        }
        if (x.state === 'armed' && x.kind === 'xy') {
          const level = Number(body.level);
          if (!levelSane(level, sp.spot)) return bad('Level is more than 5% from spot');
          // The same rules as a click, in the view it was armed in: a Classic LIMIT entry cannot be dragged across spot into
          // a breakout; an Anywhere one can, and becomes a stop there (and a LIMIT again if dragged back).
          const v = classifyClick({ mode: 'xy', opt: x.contract.opt, side: x.side, level, ref: sp.spot, orderType: x.orderType ?? 'LIMIT', zones: x.zones });
          if (!v.ok) return bad(x.zones === 'anywhere' ? v.error : `${v.error} (or arm it in the Anywhere view)`);
          const orderType: ClickType = v.kind === 'stop' ? 'SL' : x.zones === 'anywhere' ? 'LIMIT' : (x.orderType ?? 'LIMIT');
          const r = await guarded(id, y => y.state === 'armed',
            st => pushEvent(patchSlice(st, id, { entryLevel: level, entryDir: v.dir, seenSafe: true, orderType }), ev('info', `Entry moved to ${level}${v.kind === 'stop' ? ' (breakout)' : ''}`, id)));
          if (!r.applied) return bad('Too late — it has just fired', 409);
          return NextResponse.json({ success: true, data: { state: r.state } });
        }
        if (x.state === 'open' && x.kind === 'xy' && x.bracket) {
          // A widget can stand for several slices (a '+1 lot' joins its parent's levels): move them all together.
          const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : [id];
          const b = bias(x.contract.opt, x.side);
          const tgtY = body.tgtY == null ? x.tgtY : Number(body.tgtY);
          const slY = body.slY == null ? x.slY : Number(body.slY);
          if (tgtY != null && !(levelSane(tgtY, sp.spot) && (b > 0 ? tgtY > sp.spot : tgtY < sp.spot))) return bad('Target must be on the profit side of spot');
          if (slY != null && !(levelSane(slY, sp.spot) && (b > 0 ? slY < sp.spot : slY > sp.spot))) return bad('SL must be on the loss side of spot');
          let moved = 0;
          const state = await updateLadderState(st => {
            let next = st;
            for (const sid of ids) {
              const y = next.slices.find(z => z.id === sid);
              if (!y || y.state !== 'open' || y.kind !== 'xy' || !y.bracket || y.contract.securityId !== x.contract.securityId) continue;
              const patch: Partial<LadderSlice> = {};
              if (body.tgtY != null) patch.tgtY = tgtY;
              // Only a moved SL restarts trailing (from the new SL, measured from here). A target-only move leaves the
              // trail's base untouched — resetting trailFrom/peakY there froze an already-trailed SL.
              if (body.slY != null) Object.assign(patch, { slY, slY0: slY, trailFrom: sp.spot, peakY: sp.spot });
              next = patchSlice(next, sid, patch);
              moved++;
            }
            return moved ? pushEvent(next, ev('info', `Bracket moved: TGT ${tgtY ?? '—'} / SL ${slY} (${moved} slice${moved === 1 ? '' : 's'})`, id)) : st;
          });
          if (!moved) return bad('It is exiting or closed — not modified', 409);
          return NextResponse.json({ success: true, data: { state } });
        }
        return bad(`Cannot modify an order that is ${x.state}`);
      }

      case 'trail': {
        // Continuous trailing SL for a position (and the '+1 lot' slices that share its levels): `trailPts` sets the
        // distance (0 = off); `delta` widens (+) or tightens (-) the current one (the ladder SL marker's +/-). The SL
        // never loosens: widening only lets it follow from further back from here on; tightening pulls it up now.
        const req = parseTrailRequest(body);
        if (typeof req === 'string') return bad(req);
        const x0 = readLadderState().slices.find(y => y.id === id);
        if (!x0 || !x0.bracket || TERMINAL.has(x0.state)) return bad('It is closed — trailing not changed', 409);
        // An open position's trail starts from the index level now (not an old peak), so switching it on or changing it
        // cannot jump the SL up to a level the market has already left.
        let spotNow: number | null = null;
        if (x0.state === 'open') {
          const sp = (await loadPrices([spotKey(x0.contract)], [])).spots[spotKey(x0.contract)];
          if (!sp || !spotFresh(sp.at, Date.now())) return bad('No fresh price to start the trail from — try again in a moment');
          spotNow = sp.spot;
        }
        let n = 0;
        let label = '';
        const s = await updateLadderState(st => {
          const x = st.slices.find(y => y.id === id);
          if (!x || !x.bracket || TERMINAL.has(x.state)) return st;
          // Index points: tightening below one point would park the SL on the price.
          const trail = trailedBracket(x.bracket, req, 1).trailPts ?? 0;
          label = trail ? `Trailing SL ${trail} pts behind the best level` : 'Trailing off';
          // A '+1 lot' child shares its parent's target / SL: an open position's trail covers every open slice on those
          // same levels, so no lot is left on the old, wider stop.
          const joined = (y: LadderSlice) => y.id === id || (x.state === 'open' && y.state === 'open' && !!y.bracket && y.kind === x.kind
            && y.contract.securityId === x.contract.securityId && y.broker === x.broker && y.mode === x.mode && y.side === x.side
            && y.slY === x.slY && y.tgtY === x.tgtY);
          let next = st;
          for (const y of st.slices.filter(joined)) {
            const bracket = trailedBracket(y.bracket!, { abs: trail, delta: null }, 1);
            next = patchSlice(next, y.id, { bracket, ...(y.state === 'open' && spotNow != null ? { peakY: spotNow } : {}) });
            n++;
          }
          return pushEvent(next, ev('info', `${label}${n > 1 ? ` (${n} slices)` : ''}`, id));
        });
        if (!n) return bad('It is closed — trailing not changed', 409);
        return NextResponse.json({ success: true, data: { state: s } });
      }

      case 'resolve': {
        // The user checked Orders/Positions for an UNKNOWN order: 'open' = a position exists, 'flat' = nothing open.
        const outcome = body.outcome;
        if (outcome !== 'open' && outcome !== 'flat') return bad("outcome must be 'open' or 'flat'");
        const x = readLadderState().slices.find(y => y.id === id);
        if (!x || x.state !== 'unknown') return bad('That order is not UNKNOWN');
        const prices = await loadPrices([spotKey(x.contract)], [x.contract]);
        const ltp = prices.ltps[x.contract.securityId] ?? 0;
        const now = Date.now();
        const r = await guarded(id, y => y.state === 'unknown', st => {
          const cur = st.slices.find(y => y.id === id)!;
          const hadPosition = Number(cur.filledQty) > 0;     // an UNKNOWN exit: the position (and its bracket) existed
          let next: LadderState;
          if (outcome === 'open') {
            // An UNKNOWN entry confirmed open is opened like a fill, so an XY bracket gets its target/SL again.
            next = hadPosition
              ? patchSlice(st, id, { state: 'open', exitRetryAt: undefined, exitOrderId: undefined, note: 'Confirmed open by you' })
              : patchSlice(openedPatch(st, cur, cur.qty, cur.avg || ltp, now), id, { note: 'Confirmed open by you' });
          } else {
            next = patchSlice(st, id, hadPosition
              ? { state: 'closed', exitAvg: ltp || undefined, closedAt: now, note: 'Confirmed flat by you' }
              : { state: 'cancelled', note: 'Confirmed: nothing opened' });
          }
          return pushEvent(next, ev('info', `UNKNOWN resolved as ${outcome}`, id));
        });
        if (!r.applied) return bad('That order is not UNKNOWN any more', 409);
        return NextResponse.json({ success: true, data: { state: r.state } });
      }

      case 'clear': {
        // `pane`: only that ladder's finished rows (two ladders open); none = every finished row.
        const pane = body.pane === 1 || body.pane === 2 ? body.pane : null;
        const keep = (x: { pane?: number }) => pane != null && paneOf(x) !== pane;
        const s = await updateLadderState(st => ({ ...st, slices: st.slices.filter(x => !TERMINAL.has(x.state) || keep(x)), ...(st.pairs ? { pairs: st.pairs.filter(p => isPairLive(p) || keep(p)) } : {}), ...(st.baskets ? { baskets: st.baskets.filter(b => isBasketLive(b) || keep(b)) } : {}) }));
        return NextResponse.json({ success: true, data: { state: s } });
      }

      default:
        return bad(`Unknown action ${action}`);
    }
  } catch (err) {
    console.error('[price-ladder] action failed:', action, err);
    return bad(String((err as Error).message ?? err), 500);
  }
}
