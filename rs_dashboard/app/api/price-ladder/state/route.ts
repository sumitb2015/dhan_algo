import { NextRequest, NextResponse } from 'next/server';
import { getDhanStrikeLookup } from '@/lib/dhanStrikeLookup';
import { MCX_LOT_MULTIPLIER } from '@/lib/positionPnl';
import { kotakOptionContract } from '@/lib/kotakContracts';
import { zerodhaOptionContract } from '@/lib/zerodhaContracts';
import {
  readLadderState, updateLadderState, startPriceLadderLoop, loadPrices, placeFor, afterSend, cancelAtBroker,
  brokerSessionOk, availableFunds, dhanSellMargin, withJob, commitIf, dhanSegmentFor, openedPatch, LADDER_UNDERLYINGS,
} from '@/lib/priceLadderServer';
import {
  sessionFor, spotKey, isMcxUnderlying, MAX_LADDER_LOTS, capLots, classifyClick, cleanBracket, isLive, istDay, istHhmm, levelSane, pushEvent, realArmed,
  snapToStep, spotFresh, bias, TERMINAL, patchSlice, ev,
  type LadderBroker, type LadderContract, type LadderMode, type LadderSide, type LadderSlice, type LadderState, type OptType,
} from '@/lib/priceLadder';

// The Price Ladder's ledger (debug/price_ladder_state.json) and its actions. Real-money endpoint: every check that can
// refuse an order runs here, server-side — lot cap, level sanity, the contract resolved from the brokers' own masters
// (never a security id from the browser), the daily LIVE · REAL MONEY arm, a live broker session and a fail-closed
// funds/margin check. Armed index levels are then fired by the server watcher (lib/priceLadderServer.ts).

const OPTION_TICK = 0.05;
const parseBroker = (v: unknown): LadderBroker | null => (v === 'dhan' || v === 'kotak' || v === 'zerodha' ? v : null);
const BROKER_NAME: Record<LadderBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };
const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const newId = () => `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function GET(req: NextRequest): Promise<NextResponse> {
  startPriceLadderLoop();
  try {
    const want = (req.nextUrl.searchParams.get('underlying') ?? '').toUpperCase();
    const state = readLadderState();
    const live = state.slices.filter(isLive);
    // The contract the page is showing (Dhan ids price every broker's contract): its live LTP rides the same snapshot.
    const expiry = req.nextUrl.searchParams.get('expiry') ?? '';
    const strike = Number(req.nextUrl.searchParams.get('strike'));
    const opt = req.nextUrl.searchParams.get('opt');
    let shown: LadderContract | null = null;
    let contractError: string | null = null;
    if (LADDER_UNDERLYINGS.includes(want) && /^\d{4}-\d{2}-\d{2}$/.test(expiry) && strike > 0 && (opt === 'CE' || opt === 'PE')) {
      const c = await resolveContract('dhan', want, expiry, strike, opt);
      if (typeof c !== 'string') shown = c; else contractError = c;
    }
    // The page's XY axis: the index, or for MCX the shown option month's own futures (known once a contract is picked).
    const shownKey = shown ? spotKey(shown) : (LADDER_UNDERLYINGS.includes(want) && !isMcxUnderlying(want) ? want : null);
    const unders = [...new Set([...(shownKey ? [shownKey] : []), ...live.map(x => spotKey(x.contract))])];
    const prices = await loadPrices(unders, [...live.map(x => x.contract), ...(shown ? [shown] : [])]);
    const now = Date.now();
    const spots = Object.fromEntries(Object.entries(prices.spots).map(([u, v]) => [u, { ...v, fresh: spotFresh(v.at, now) }]));
    return NextResponse.json({
      success: true,
      data: {
        state, spots, ltps: prices.ltps, liveArmed: realArmed(state, istDay()), now, spotKey: shownKey, contractError,
        // Which contract this reply describes: the page ignores a reply for a selection it has since moved off.
        request: { underlying: want, expiry, strike: strike > 0 ? strike : null, opt },
        contract: shown ? {
          securityId: shown.securityId, lotSize: shown.lotSize, ltp: prices.ltps[shown.securityId] ?? null,
          mult: shown.mult ?? 1, ...(shown.ref ? { refExpiry: shown.ref.expiry } : {}),
        } : null,
      },
    });
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
}

async function resolveContract(broker: LadderBroker, u: string, expiry: string, strike: number, opt: OptType): Promise<LadderContract | string> {
  const look = await getDhanStrikeLookup(u, expiry);
  const row = look?.strikes?.[String(strike)] ?? look?.strikes?.[strike.toFixed(1)];
  const securityId = opt === 'CE' ? row?.ceId : row?.peId;
  if (!look || !securityId || !(look.lotSize > 0)) return `${u} ${expiry} ${strike}${opt} is not in Dhan's master list`;
  const c: LadderContract = { underlying: u, expiry, strike, opt, securityId: String(securityId), lotSize: look.lotSize, exchangeSegment: dhanSegmentFor(u) };
  if (isMcxUnderlying(u)) {
    // Dhan only: Kotak / Zerodha MCX order sizing (absolute units) and symbols are not wired into the ladder.
    if (broker !== 'dhan') return `${u} trades on Dhan only in the Price Ladder`;
    // Dhan orders MCX in LOTS (lotSize 1); P&L and premium cost need the barrels per lot.
    const mult = MCX_LOT_MULTIPLIER[u];
    if (look.lotSize !== 1 || !(mult > 1)) return `${u}: unexpected lot size ${look.lotSize} — refused`;
    if (!look.future) return `${u}: no futures month on or after ${expiry} in Dhan's master list (restart the dashboard if the master was just refreshed)`;
    c.mult = mult;
    c.ref = { securityId: look.future.securityId, segment: 'MCX_COMM', expiry: look.future.expiry };
  }
  if (broker === 'zerodha') {
    // Kite's own instrument dump (metadata only — prices stay Dhan-sourced).
    const z = await zerodhaOptionContract(u, expiry, strike, opt);
    if (!z) return `Zerodha does not list ${u} ${expiry} ${strike}${opt}`;
    c.tradingSymbol = z.tradingsymbol;
    c.lotSize = z.lotSize;
  }
  if (broker === 'kotak') {
    const k = await kotakOptionContract(u, expiry, strike, opt);
    if (!k) return `Kotak does not list ${u} ${expiry} ${strike}${opt}`;
    c.tradingSymbol = k.tradingsymbol;
    c.lotSize = k.lotSize;
  }
  return c;
}

/**
 * Funds/margin for a REAL open on any broker; fails closed (an unreadable figure refuses the order). A BUY needs its
 * premium (+2%) in cash; a SELL needs the exchange margin from Dhan's calculator — SPAN + exposure are the exchange's,
 * the same on every broker, as Multi-Leg Focus prices Kotak/Zerodha baskets — against that broker's own funds.
 */
async function realOpenBlocked(broker: LadderBroker, c: LadderContract, side: LadderSide, qty: number, product: string, price: number): Promise<string | null> {
  const funds = await availableFunds(broker);
  if (funds == null) return `Could not read ${BROKER_NAME[broker]} funds — order refused (fail closed)`;
  const need = side === 'BUY' ? qty * (c.mult ?? 1) * price * 1.02 : await dhanSellMargin(c, qty, product, price);
  if (need == null || !(need > 0)) return 'Could not read the margin for this order — refused (fail closed)';
  const have = side === 'BUY' ? funds.buy : funds.sell;
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
  if (b.opt !== 'CE' && b.opt !== 'PE') return bad('opt must be CE or PE');
  if (b.side !== 'BUY' && b.side !== 'SELL') return bad('side must be BUY or SELL');
  if (b.product !== 'NRML' && b.product !== 'MIS') return bad('product must be NRML or MIS');
  if (b.orderType !== 'LIMIT' && b.orderType !== 'SL') return bad('orderType must be LIMIT or SL');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry))) return bad('expiry must be YYYY-MM-DD');
  const lots = capLots(b.lots);
  if (lots == null) return bad('Lots must be a whole number from 1 to 20');
  const strike = Number(b.strike);
  if (!(strike > 0)) return bad('Invalid strike');
  const sess = sessionFor(u, istDay(now));
  if (sess.open >= sess.close) return bad(sess.note ?? 'The market is closed today');
  if (istHhmm(now) >= sess.autoExit) return bad(`After ${sess.autoExitLabel} the ladder only exits`);
  // A REAL plain order goes to the broker now, so the market must be open. (An XY level may be armed early: the
  // watcher only fires it inside the session.)
  if (b.mode === 'real' && b.kind === 'plain' && (istHhmm(now) < sess.open || istHhmm(now) >= sess.close)) return bad('The market is closed');
  const bracket = b.bracket == null ? null : cleanBracket(b.bracket);
  if (b.bracket != null && !bracket) return bad('Bracket needs a positive SL in points (target 0 = Cover order)');
  if (bracket && b.kind !== 'xy') return bad('Brackets are index-level (XY) orders only');

  const state = readLadderState();
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
  const level = b.kind === 'xy' ? Number(b.level) : snapToStep(Number(b.level), OPTION_TICK);

  if (b.kind === 'xy') {
    if (!spot || !spotFresh(spot.at, now)) return bad(c.ref ? `No fresh ${u} futures price yet — try again in a moment` : `No fresh ${u} spot — start the indices feed`);
    if (!levelSane(level, spot.spot)) return bad(`Level ${level} is more than 5% from spot ${spot.spot}`);
  } else if (!(ltp > 0)) {
    return bad('No live option price yet');
  }
  const ref = b.kind === 'xy' ? spot!.spot : ltp;
  const verdict = classifyClick({ mode: b.kind, opt: b.opt, side: b.side, level, ref, orderType: b.orderType });
  if (!verdict.ok) return bad(verdict.error);

  if (b.mode === 'real') {
    const price = b.kind === 'xy' ? ltp : level;
    if (!(price > 0)) return bad('No live option price to check margin against');
    const blocked = await realOpenBlocked(b.broker, c, b.side, qty, b.product, price);
    if (blocked) return bad(blocked);
  }

  const base: LadderSlice = {
    id: newId(), kind: b.kind, broker: b.broker, mode: b.mode, contract: c, side: b.side, lots, qty, product: b.product,
    state: 'armed', createdAt: now, updatedAt: now,
  };
  const what = `${b.mode === 'sim' ? 'SIM ' : ''}${b.side} ${lots} lot(s) ${u} ${strike}${b.opt}`;

  if (b.kind === 'xy') {
    const slice: LadderSlice = { ...base, entryLevel: level, entryDir: verdict.dir, seenSafe: true, orderType: b.orderType, ...(bracket ? { bracket } : {}) };
    const br = bracket ? ` · ${bracket.tgtPts > 0 ? `TGT ${bracket.tgtPts} / ` : 'Cover · '}SL ${bracket.slPts}${bracket.trailPts ? ` / trail ${bracket.trailPts}` : ''} pts` : '';
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
    ...base, orderType: b.orderType,
    ...(verdict.kind === 'limit' ? { limitPrice: level } : { triggerPrice: level }),
  };
  if (b.mode === 'sim') {
    const s = await updateLadderState(st => pushEvent({ ...st, slices: [...st.slices, { ...plain, state: 'working' }] }, ev('info', `SIM ${verdict.kind === 'limit' ? 'LIMIT' : 'SL'} ${what} @ ${level}`, plain.id)));
    return NextResponse.json({ success: true, data: { id: plain.id, state: s } });
  }
  // REAL: checkpoint before the order (Triple Straddle rule) — if this write fails nothing is sent.
  await updateLadderState(st => ({ ...st, slices: [...st.slices, { ...plain, state: 'placing', sentAt: now }] }));
  const r = await withJob(plain.id, () => placeFor(plain, b.side, qty, true, verdict.kind === 'limit' ? { type: 'LIMIT', price: level } : { type: 'SL', trigger: level }));
  const s = await commitIf(plain.id, 'placing', st => pushEvent(afterSend(st, plain.id, r, 'entry'), ev('info', `${verdict.kind === 'limit' ? 'LIMIT' : 'SL'} ${what} @ ${level}: ${r.status}`, plain.id)));
  if (r.status === 'placed') return NextResponse.json({ success: true, data: { id: plain.id, state: s } });
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error, data: { state: s } }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error, data: { state: s } });
}

/**
 * Lots this ladder holds, has on the wire or has armed on the same contract, broker, mode and side (the 20-lot holding
 * cap). Armed XY levels count: the watcher fires them at market without re-checking, so several could cross at once.
 */
function lotsHeld(st: LadderState, p: LadderSlice, exceptId?: string): number {
  return st.slices
    .filter(x => x.id !== exceptId && x.contract.securityId === p.contract.securityId && x.broker === p.broker && x.mode === p.mode && x.side === p.side
      && ['armed', 'open', 'exiting', 'placing', 'working'].includes(x.state))
    .reduce((a, x) => a + x.lots, 0);
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
  const sess = sessionFor(p.contract.underlying, istDay(now));
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
    const blocked = await realOpenBlocked(p.broker, p.contract, p.side, qty, p.product, ltp);
    if (blocked) return bad(blocked);
  }
  const child: LadderSlice = {
    id: newId(), kind: p.kind, broker: p.broker, mode: p.mode, contract: p.contract, side: p.side, lots: 1, qty,
    product: p.product, state: 'placing', createdAt: now, updatedAt: now, sentAt: now, orderType: p.orderType, market: true,
    entryLevel: p.entryLevel, entryDir: p.entryDir, entryY: p.entryY,
    ...(p.bracket ? { bracket: p.bracket, tgtY: p.tgtY, slY: p.slY, slY0: p.slY0, trailFrom: p.trailFrom, peakY: p.peakY } : {}),
    note: `Added to ${p.id}`,
  };
  const what = `${p.mode === 'sim' ? 'SIM ' : ''}+1 lot ${p.side} ${p.contract.strike}${p.contract.opt}`;
  if (p.mode === 'sim') {
    const s = await updateLadderState(st => openedPatch(pushEvent({ ...st, slices: [...st.slices, child] }, ev('info', what, child.id)), child, qty, ltp, now));
    return NextResponse.json({ success: true, data: { id: child.id, state: s } });
  }
  // REAL: checkpoint before the order; the watcher settles its fill like any entry.
  await updateLadderState(st => ({ ...st, slices: [...st.slices, child] }));
  const r = await withJob(child.id, () => placeFor(child, child.side, qty, true));
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

      case 'live': {
        const on = body.on === true;
        const s = await updateLadderState(st => pushEvent({ ...st, liveArmedOn: on ? today : undefined }, ev(on ? 'warn' : 'info', on ? 'LIVE · REAL MONEY armed for today' : 'LIVE · REAL MONEY off — armed REAL levels will be cancelled')));
        return NextResponse.json({ success: true, data: { state: s } });
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
          await cancelAtBroker(x.broker, x.orderId);
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
        const r = await guarded(id, y => y.state === 'armed' || (y.state === 'working' && y.mode === 'sim'), st => {
          const x = st.slices.find(y => y.id === id)!;
          return pushEvent(patchSlice(st, id, { lots, qty: lots * x.contract.lotSize }), ev('info', `Lots changed to ${lots}`, id));
        });
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
          if (tgtY != null && x.bracket.tgtPts <= 0) return bad('A Cover order has no target');
          if (tgtY != null && !(levelSane(tgtY, sp.spot) && (tgtY - entry) * b > 0)) return bad('Target must be on the profit side of the entry');
          if (slY != null && !(levelSane(slY, sp.spot) && (entry - slY) * b > 0)) return bad('SL must be on the loss side of the entry');
          const r = await guarded(id, y => y.state === 'armed' && !!y.bracket && y.entryLevel === x.entryLevel, st => {
            const y = st.slices.find(z => z.id === id)!;
            const bracket = {
              ...y.bracket!,
              ...(tgtY != null ? { tgtPts: Number(((tgtY - entry) * b).toFixed(2)) } : {}),
              ...(slY != null ? { slPts: Number(((entry - slY) * b).toFixed(2)) } : {}),
            };
            return pushEvent(patchSlice(st, id, { bracket }), ev('info', `Planned bracket: TGT ${bracket.tgtPts > 0 ? `${bracket.tgtPts} pts` : '—'} / SL ${bracket.slPts} pts`, id));
          });
          if (!r.applied) return bad('Too late — it has just fired or moved; try again', 409);
          return NextResponse.json({ success: true, data: { state: r.state } });
        }
        if (x.state === 'armed' && x.kind === 'xy') {
          const level = Number(body.level);
          if (!levelSane(level, sp.spot)) return bad('Level is more than 5% from spot');
          // The same rules as a click: a LIMIT entry cannot be dragged across spot into a breakout.
          const v = classifyClick({ mode: 'xy', opt: x.contract.opt, side: x.side, level, ref: sp.spot, orderType: x.orderType ?? 'LIMIT' });
          if (!v.ok) return bad(v.error);
          const r = await guarded(id, y => y.state === 'armed',
            st => pushEvent(patchSlice(st, id, { entryLevel: level, entryDir: v.dir, seenSafe: true }), ev('info', `Entry moved to ${level}`, id)));
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
        const trail = Number(body.trailPts);
        if (!(trail >= 0) || !Number.isFinite(trail)) return bad('trailPts must be 0 or more');
        let n = 0;
        const s = await updateLadderState(st => {
          const x = st.slices.find(y => y.id === id);
          if (!x || !x.bracket || TERMINAL.has(x.state)) return st;
          // A '+1 lot' child shares its parent's target / SL: an open position's trail covers every open slice on those
          // same levels, so no lot is left on the old, wider stop.
          const joined = (y: LadderSlice) => y.id === id || (x.state === 'open' && y.state === 'open' && !!y.bracket && y.kind === x.kind
            && y.contract.securityId === x.contract.securityId && y.broker === x.broker && y.mode === x.mode && y.side === x.side
            && y.slY === x.slY && y.tgtY === x.tgtY);
          let next = st;
          for (const y of st.slices.filter(joined)) {
            // Trailing restarts from the SL as it stands, so switching it on never loosens a stop.
            next = patchSlice(next, y.id, { bracket: { ...y.bracket!, trailPts: trail || undefined }, slY0: y.slY ?? y.slY0, trailFrom: y.state === 'open' ? (y.peakY ?? y.entryY) : undefined });
            n++;
          }
          return pushEvent(next, ev('info', `${trail ? `Trailing SL every ${trail} pts` : 'Trailing off'}${n > 1 ? ` (${n} slices)` : ''}`, id));
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
        const s = await updateLadderState(st => ({ ...st, slices: st.slices.filter(x => !TERMINAL.has(x.state)) }));
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
