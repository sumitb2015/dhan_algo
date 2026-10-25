import { NextResponse } from 'next/server';
import { resolveContract } from '@/lib/priceLadderView';
import { readLadderState, updateLadderState, loadPrices, availableFunds, dhanSellMargin, LADDER_UNDERLYINGS } from '@/lib/priceLadderServer';
import { fetchNettedMargin } from '@/lib/ultimateScannerDhan';
import {
  capLots, classifyClick, cleanBracket, ev, isMcxUnderlying, newLadderId, parseTrailRequest, pushEvent, replanBracket, snapToStep, trailedBracket, MAX_LADDER_LOTS,
  type ClickType, type LadderBroker, type LadderContract, type LadderProduct, type LadderSide, type LadderState, type LadderZones,
} from '@/lib/priceLadder';
import { blendExitAvg, lotsOnContract, pairBias, pairLevelSane, PAIR_STRIKE_STEP, MIN_PAIR_TRAIL_PTS } from '@/lib/priceLadderPair';
import {
  applyBasketShare, basketAxis, basketCombined, basketLegQty, basketName, firstPhase, isBasketLive, orientLegs, patchBasket, validateDraft, MAX_REAL_BASKET_LOTS,
  type BasketLeg, type DraftLeg, type LadderBasket,
} from '@/lib/priceLadderBasket';
import { checkOpenAllowed } from '@/lib/priceLadderPairActions';

// The Price Ladder's Basket-mode actions (POST /api/price-ladder/state with action 'basket'). Real-money endpoint for mode
// 'real': a REAL basket also needs the daily LIVE · REAL MONEY arm, a live broker session, at most MAX_REAL_BASKET_LOTS lots
// and a fail-closed funds / margin check; its orders are sent by the watcher's basket jobs (hedges first, then the shorts).
// Every check mirrors the Pair arm: each leg's contract resolved from the broker's own master (never an id from the browser), strikes on the grid, the
// 20-lot cap per contract (counted with slices and pairs, re-checked inside the lock), session / auto-exit, a live price for
// every leg, the click verdict the user saw, and the level against the live net premium.

const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const ok = (state: LadderState, extra: Record<string, unknown> = {}) => NextResponse.json({ success: true, data: { state, ...extra } });

function parseDraft(raw: unknown): DraftLeg[] | string {
  if (!Array.isArray(raw)) return 'legs must be a list';
  const legs: DraftLeg[] = raw.slice(0, 20).map(x => {
    const r = (x ?? {}) as Record<string, unknown>;
    return { side: r.side as LadderSide, opt: r.opt as 'CE' | 'PE', strike: Number(r.strike), ratio: Number(r.ratio) };
  });
  return validateDraft(legs) ?? legs;
}

/** The first leg whose contract would pass the 20-lot cap with `lots` more of the basket (counted per traded side), or null. */
function overCap(st: LadderState, broker: LadderBroker, mode: 'sim' | 'real', legs: { side: LadderSide; ratio: number; contract: LadderContract }[], lots: number): string | null {
  for (const l of legs) {
    const held = lotsOnContract(st, l.contract.securityId, broker, mode, l.side);
    if (held + lots * l.ratio > MAX_LADDER_LOTS) return `The ladder already holds or has armed ${held} lots of ${l.contract.strike}${l.contract.opt} — the cap is ${MAX_LADDER_LOTS}`;
  }
  return null;
}

const BROKER_NAME: Record<LadderBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };

/**
 * Funds for a REAL basket, fail closed (an unreadable figure refuses it). Cash needed = the hedged exchange margin of the whole
 * basket (Dhan's basket margin for NSE / BSE; for MCX each short's own margin, no hedge credit) plus the premium of every
 * BUY leg (+2%): the bought legs are paid for in full on top of the margin. SPAN + exposure are the exchange's, the same on
 * every broker; compared with that broker's own funds.
 */
async function realBasketBlocked(broker: LadderBroker, u: string, legs: BasketLeg[], lots: number, product: LadderProduct, ltps: Record<string, number>): Promise<string | null> {
  const funds = await availableFunds(broker);
  if (funds == null) return `Could not read ${BROKER_NAME[broker]} funds — order refused (fail closed)`;
  const qtyOf = (l: BasketLeg) => basketLegQty(lots, l.ratio, l.contract.lotSize);
  const buyPremium = legs.filter(l => l.side === 'BUY').reduce((a, l) => a + qtyOf(l) * (l.contract.mult ?? 1) * (ltps[l.contract.securityId] ?? 0) * 1.02, 0);
  const sells = legs.filter(l => l.side === 'SELL');
  let margin: number | null = 0;
  if (sells.length) {
    if (isMcxUnderlying(u)) {
      const each = await Promise.all(sells.map(l => dhanSellMargin(l.contract, qtyOf(l), product, ltps[l.contract.securityId] ?? 0)));
      margin = each.every(x => x != null) ? each.reduce((a, x) => a + (x as number), 0) : null;
    } else {
      margin = await fetchNettedMargin(u, legs.map(l => ({ side: l.side, securityId: l.contract.securityId, quantity: qtyOf(l) })));
    }
    if (margin == null || !(margin > 0)) return 'Could not read the margin for this basket — refused (fail closed)';
  }
  const need = margin + buyPremium;
  const have = sells.length ? funds.sell : funds.buy;
  if (need > have) return `Needs about ₹${Math.round(need).toLocaleString('en-IN')}, ${BROKER_NAME[broker]} has ₹${Math.round(have).toLocaleString('en-IN')}`;
  return null;
}

interface Prepared {
  now: number; mode: 'sim' | 'real'; broker: LadderBroker; u: string; side: LadderSide; lots: number; product: LadderProduct; strategy: string; name: string;
  legs: BasketLeg[]; ltps: Record<string, number>; a: number; pane?: 2;
}

/** The checks arm and market share; returns the prepared basket legs and live net premium, or the refusal. */
async function prepare(b: Record<string, unknown>, isMarket: boolean): Promise<Prepared | NextResponse> {
  const now = Date.now();
  const mode = b.mode;
  if (mode !== 'sim' && mode !== 'real') return bad('mode must be sim or real');
  const broker = b.broker as LadderBroker;
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  const u = String(b.underlying ?? '').toUpperCase();
  if (!LADDER_UNDERLYINGS.includes(u)) return bad(`Unsupported underlying ${b.underlying}`);
  const expiry = String(b.expiry ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return bad('expiry must be YYYY-MM-DD');
  const side = b.side as LadderSide;
  if (side !== 'BUY' && side !== 'SELL') return bad('side must be BUY or SELL');
  if (b.product !== 'NRML' && b.product !== 'MIS') return bad('product must be NRML or MIS');
  const lots = capLots(b.lots);
  if (lots == null) return bad('Lots must be a whole number from 1 to 20');
  if (mode === 'real' && lots > MAX_REAL_BASKET_LOTS) return bad(`REAL baskets are limited to ${MAX_REAL_BASKET_LOTS} lots for now`);
  const draft = parseDraft(b.legs);
  if (typeof draft === 'string') return bad(draft);
  const step = PAIR_STRIKE_STEP[u];
  if (!step || draft.some(l => l.strike % step !== 0)) return bad(`Basket strikes must be ${step ?? '?'}-point strikes`);
  // REAL: the daily arm, the broker session and (for a Market order) the open market; a SIM arm may be placed any time.
  const openErr = checkOpenAllowed(u, now, mode, broker, readLadderState(), { isArm: !isMarket });
  if (openErr) return bad(openErr, openErr.includes('LIVE') || openErr.includes('session') ? 403 : 400);

  const contracts = await Promise.all(draft.map(l => resolveContract(broker, u, expiry, l.strike, l.opt)));
  for (const c of contracts) if (typeof c === 'string') return bad(c);
  const cs = contracts as LadderContract[];
  if (new Set(cs.map(c => c.lotSize)).size > 1) return bad('The legs have different lot sizes — refused');
  const prices = await loadPrices([], cs);
  const priceOf = (l: DraftLeg) => prices.ltps[cs[draft.indexOf(l)].securityId];
  const axis = basketAxis(draft, priceOf);
  if (!axis) return bad('No live price for every leg yet (or the strategy nets to nothing) — try again in a moment');
  const oriented = orientLegs(draft, side, axis.credit);
  const legs: BasketLeg[] = oriented.map((l, i) => ({ key: `l${i}`, side: l.side, ratio: l.ratio, contract: cs[i] }));
  const capErr = overCap(readLadderState(), broker, mode, legs, lots);
  if (capErr) return bad(capErr);
  if (mode === 'real') {
    const blocked = await realBasketBlocked(broker, u, legs, lots, b.product, prices.ltps);
    if (blocked) return bad(blocked);
  }
  return { now, mode, broker, u, side, lots, product: b.product, strategy: String(b.strategy ?? 'custom').slice(0, 40), name: String(b.name ?? 'Custom').slice(0, 40), legs, ltps: prices.ltps, a: axis.a, ...(b.pane === 2 ? { pane: 2 as const } : {}) };
}

async function arm(b: Record<string, unknown>): Promise<NextResponse> {
  const p = await prepare(b, false);
  if (p instanceof NextResponse) return p;
  const bracket = b.bracket == null ? null : cleanBracket(b.bracket);
  if (b.bracket != null && !bracket) return bad('Bracket needs a positive SL in points (target 0 = Cover order)');
  const level = snapToStep(Number(b.level), 0.05);
  if (!pairLevelSane(level, p.a)) return bad(`Level ${level} is too far from the net premium ${p.a}`);
  const zones: LadderZones = b.zones === 'anywhere' ? 'anywhere' : 'classic';
  const orderType = b.orderType as ClickType;
  if (orderType !== 'LIMIT' && orderType !== 'SL') return bad('orderType must be LIMIT or SL');
  // Buy below / Sell above the net premium is a limit-like entry; the other side is a breakout (Anywhere, or Order Type SL).
  const verdict = classifyClick({ mode: 'plain', opt: 'CE', side: p.side, level, ref: p.a, orderType, zones });
  if (!verdict.ok) return bad(verdict.error);
  const expect = b.expect as { kind?: unknown; dir?: unknown } | undefined;
  if (expect && (expect.kind !== verdict.kind || expect.dir !== verdict.dir)) {
    return bad(`The net premium crossed ${level} since you clicked — that would now be a ${verdict.kind === 'stop' ? 'breakout' : 'limit'} entry, not what you placed. Nothing was armed; click again.`, 409);
  }
  const basket: LadderBasket = {
    id: newLadderId('pb'), strategy: p.strategy, name: p.name, broker: p.broker, mode: p.mode, side: p.side, lots: p.lots, product: p.product, state: 'armed',
    legs: p.legs, createdAt: p.now, updatedAt: p.now, entryLevel: level, entryDir: verdict.dir, seenSafe: true,
    orderType: verdict.kind === 'stop' ? 'SL' : orderType, ...(zones === 'anywhere' ? { zones } : {}), ...(bracket ? { bracket } : {}), ...(p.pane ? { pane: p.pane } : {}),
  };
  let err: string | null = null;
  const s = await updateLadderState(st => {
    err = overCap(st, p.broker, p.mode, basket.legs, basket.lots);       // re-checked inside the lock: two clicks in flight must not both pass
    if (err) return st;
    return pushEvent({ ...st, baskets: [...(st.baskets ?? []), basket] },
      ev('info', `Armed ${p.mode === 'real' ? 'REAL' : 'SIM'} ${p.side} ${p.lots} lot(s) ${basketName(basket)} when the net ${verdict.dir === 'below' ? '≤' : '≥'} ${level}`, basket.id));
  });
  if (err) return bad(err);
  return ok(s, { id: basket.id });
}

async function market(b: Record<string, unknown>): Promise<NextResponse> {
  const p = await prepare(b, true);
  if (p instanceof NextResponse) return p;
  const isReal = p.mode === 'real';
  // SIM fills every leg at its live price here. REAL is written `placing` + `sendWanted` (hedges phase first): the watcher marks it
  // sent and the basket job places the hedges, then — once they filled in full — the shorts.
  const basket: LadderBasket = isReal
    ? { id: newLadderId('pb'), strategy: p.strategy, name: p.name, broker: p.broker, mode: 'real', side: p.side, lots: p.lots, product: p.product, state: 'placing',
      phase: firstPhase({ legs: p.legs }), sendWanted: true, crossY: p.a, legs: p.legs, createdAt: p.now, updatedAt: p.now, note: 'Market order', ...(p.pane ? { pane: p.pane } : {}) }
    : { id: newLadderId('pb'), strategy: p.strategy, name: p.name, broker: p.broker, mode: 'sim', side: p.side, lots: p.lots, product: p.product, state: 'open',
      legs: p.legs.map(l => ({ ...l, avg: p.ltps[l.contract.securityId], held: basketLegQty(p.lots, l.ratio, l.contract.lotSize), filledQty: basketLegQty(p.lots, l.ratio, l.contract.lotSize), entry: 'filled' as const })),
      createdAt: p.now, updatedAt: p.now, openedAt: p.now, entryY: p.a, note: 'Market order', ...(p.pane ? { pane: p.pane } : {}) };
  let err: string | null = null;
  const s = await updateLadderState(st => {
    err = overCap(st, p.broker, p.mode, basket.legs, basket.lots);
    if (err) return st;
    return pushEvent({ ...st, baskets: [...(st.baskets ?? []), basket] },
      ev('info', isReal
        ? `${p.side} ${p.lots} lot(s) ${basketName(basket)} at MARKET — hedges first, then the shorts`
        : `SIM ${p.side} ${p.lots} lot(s) ${basketName(basket)} at MARKET: filled at net ${p.a.toFixed(2)}`, basket.id));
  });
  if (err) return bad(err);
  return ok(s, { id: basket.id });
}

/** Apply `mutate` only if the basket still passes `okFn` inside the lock (the watcher can move it between a read and the write). */
async function guarded(id: string, okFn: (b: LadderBasket) => boolean, mutate: (s: LadderState) => LadderState): Promise<{ applied: boolean; state: LadderState }> {
  let applied = false;
  const state = await updateLadderState(st => {
    const b = (st.baskets ?? []).find(y => y.id === id);
    if (!b || !okFn(b)) return st;
    applied = true;
    return mutate(st);
  });
  return { applied, state };
}

async function liveNet(b: LadderBasket): Promise<number | null> {
  const prices = await loadPrices([], b.legs.map(l => l.contract));
  return basketCombined(b, prices.ltps);
}

async function modify(body: Record<string, unknown>, id: string): Promise<NextResponse> {
  const b = (readLadderState().baskets ?? []).find(y => y.id === id);
  if (!b) return bad('Unknown basket');
  const c = await liveNet(b);
  if (c == null) return bad('No live price for every leg to check the level against');
  const bs = pairBias(b.side);
  if (b.state === 'armed' && b.bracket && (body.tgtY != null || body.slY != null) && body.level == null) {
    const entry = Number(b.entryLevel);
    const tgtY = body.tgtY == null ? null : Number(body.tgtY);
    const slY = body.slY == null ? null : Number(body.slY);
    const check = replanBracket(b.bracket, entry, bs, tgtY, slY, v => v > 0);
    if (typeof check === 'string') return bad(check);
    const r = await guarded(id, y => y.state === 'armed' && !!y.bracket && y.entryLevel === b.entryLevel, st => {
      const y = (st.baskets ?? []).find(z => z.id === id)!;
      const bracket = replanBracket(y.bracket!, entry, bs, tgtY, slY, v => v > 0) as typeof check;
      return pushEvent(patchBasket(st, id, { bracket }), ev('info', `Planned bracket: TGT ${bracket.tgtPts > 0 ? `${bracket.tgtPts} pts` : '—'} / SL ${bracket.slPts} pts`, id));
    });
    if (!r.applied) return bad('Too late — it has just fired or moved; try again', 409);
    return ok(r.state);
  }
  if (b.state === 'armed') {
    const level = snapToStep(Number(body.level), 0.05);
    if (!pairLevelSane(level, c)) return bad('Level is too far from the net premium');
    const v = classifyClick({ mode: 'plain', opt: 'CE', side: b.side, level, ref: c, orderType: b.orderType ?? 'LIMIT', zones: b.zones });
    if (!v.ok) return bad(b.zones === 'anywhere' ? v.error : `${v.error} (or arm it in the Anywhere view)`);
    const orderType: ClickType = v.kind === 'stop' ? 'SL' : b.zones === 'anywhere' ? 'LIMIT' : (b.orderType ?? 'LIMIT');
    const r = await guarded(id, y => y.state === 'armed',
      st => pushEvent(patchBasket(st, id, { entryLevel: level, entryDir: v.dir, seenSafe: true, orderType }), ev('info', `Basket entry moved to ${level}${v.kind === 'stop' ? ' (breakout)' : ''}`, id)));
    if (!r.applied) return bad('Too late — it has just fired', 409);
    return ok(r.state);
  }
  if (b.state === 'open' && b.bracket) {
    const tgtY = body.tgtY == null ? b.tgtY : Number(body.tgtY);
    const slY = body.slY == null ? b.slY : Number(body.slY);
    if (tgtY != null && !(tgtY > 0 && (bs > 0 ? tgtY > c : tgtY < c))) return bad('Target must be on the profit side of the net premium');
    if (slY != null && !(slY > 0 && (bs > 0 ? slY < c : slY > c))) return bad('SL must be on the loss side of the net premium');
    const r = await guarded(id, y => y.state === 'open' && !!y.bracket, st => {
      const patch: Partial<LadderBasket> = {};
      if (body.tgtY != null) patch.tgtY = tgtY;
      if (body.slY != null) Object.assign(patch, { slY, slY0: slY, trailFrom: c, peakY: c });
      return pushEvent(patchBasket(st, id, patch), ev('info', `Basket bracket moved: TGT ${tgtY ?? '—'} / SL ${slY}`, id));
    });
    if (!r.applied) return bad('It is closed — not modified', 409);
    return ok(r.state);
  }
  return bad(`Cannot modify a basket that is ${b.state}`);
}

async function trail(body: Record<string, unknown>, id: string): Promise<NextResponse> {
  const req = parseTrailRequest(body);
  if (typeof req === 'string') return bad(req);
  const b0 = (readLadderState().baskets ?? []).find(y => y.id === id);
  const trailable = (y: LadderBasket) => !!y.bracket && (y.state === 'armed' || y.state === 'open');
  if (!b0 || !trailable(b0)) return bad('The bracket is not running on this basket — trailing not changed', 409);
  let now: number | null = null;
  if (b0.state === 'open') {
    now = await liveNet(b0);
    if (now == null) return bad('No live price for every leg to start the trail from — try again in a moment');
  }
  let label = '';
  const r = await guarded(id, trailable, st => {
    const y = (st.baskets ?? []).find(z => z.id === id)!;
    const trailPts = trailedBracket(y.bracket!, req, MIN_PAIR_TRAIL_PTS).trailPts ?? 0;
    label = trailPts ? `Trailing SL ${trailPts} pts behind the best net premium` : 'Trailing off';
    const bracket = trailedBracket(y.bracket!, { abs: trailPts, delta: null }, MIN_PAIR_TRAIL_PTS);
    return pushEvent(patchBasket(st, id, { bracket, ...(y.state === 'open' && now != null ? { peakY: now } : {}) }), ev('info', label, id));
  });
  if (!r.applied) return bad('It is closed — trailing not changed', 409);
  return ok(r.state);
}

/** The user checked Orders / Positions for an UNKNOWN leg: 'open' = it filled / is still held, 'flat' = nothing is open on it. */
async function resolve(body: Record<string, unknown>, id: string): Promise<NextResponse> {
  const key = String(body.leg ?? '');
  const outcome = body.outcome;
  if (outcome !== 'open' && outcome !== 'flat') return bad("outcome must be 'open' or 'flat'");
  const b0 = (readLadderState().baskets ?? []).find(y => y.id === id);
  const l0 = b0?.legs.find(l => l.key === key);
  if (!b0 || b0.state !== 'unknown' || !l0?.unknown) return bad('That leg is not UNKNOWN');
  const ltp = (await loadPrices([], [l0.contract])).ltps[l0.contract.securityId] ?? 0;
  const now = Date.now();
  const r = await guarded(id, y => y.state === 'unknown' && !!y.legs.find(l => l.key === key)?.unknown, st => {
    const b = (st.baskets ?? []).find(y => y.id === id)!;
    const l = b.legs.find(x => x.key === key)!;
    let leg: BasketLeg;
    if (l.unknown === 'entry') {
      leg = outcome === 'open'
        ? { ...l, entry: 'filled', filledQty: basketLegQty(b.lots, l.ratio, l.contract.lotSize), avg: l.avg || ltp || undefined, unknown: undefined, note: 'Confirmed open by you' }
        : { ...l, entry: 'dead', filledQty: 0, unknown: undefined, note: 'Confirmed: nothing opened' };
    } else {
      const cleared = { unknown: undefined, exitOrderId: undefined, exitSentAt: undefined, exitQty: undefined };
      if (outcome === 'open') leg = { ...l, ...cleared, exitRetryAt: now, note: 'Confirmed still open — its exit is sent again' };
      else {
        const held = l.held ?? 0;
        leg = { ...l, ...cleared, held: 0, exitedQty: (l.exitedQty ?? 0) + held, exitAvg: blendExitAvg(l, held, ltp), note: `Confirmed closed by you${ltp > 0 ? '' : ' (no live price — booked at entry)'}` };
      }
    }
    const legs = b.legs.map(x => (x.key === key ? leg : x));
    const settled = legs.every(x => !x.unknown);
    // Back to where it was: an exit, or an entry.
    const state = settled ? (b.exitReason ? 'exiting' : 'placing') : 'unknown';
    return pushEvent(patchBasket(st, id, { legs, state, ...(settled ? { note: undefined } : {}) }, now),
      ev('info', `${basketName(b)}: ${l.contract.strike}${l.contract.opt} resolved as ${outcome}${settled ? ' — the basket carries on' : ''}`, id));
  });
  if (!r.applied) return bad('That leg is not UNKNOWN any more', 409);
  return ok(r.state);
}

export async function basketAction(b: Record<string, unknown>): Promise<NextResponse> {
  const op = String(b.op ?? '');
  const id = typeof b.id === 'string' ? b.id : '';
  switch (op) {
    case 'arm':
      return arm(b);
    case 'market':
      return market(b);
    case 'cancel': {
      const r = await guarded(id, y => y.state === 'armed',
        st => pushEvent(patchBasket(st, id, { state: 'cancelled', note: 'Cancelled by you' }), ev('info', 'Basket cancelled', id)));
      if (!r.applied) return bad('Too late — it has just fired or is gone; check the basket list', 409);
      return ok(r.state);
    }
    case 'exit': {
      const r = await guarded(id, y => (y.state === 'open' || y.state === 'broken') && !y.exitWanted,
        st => pushEvent(patchBasket(st, id, { exitWanted: 'Manual exit' }), ev('info', 'Basket exit requested', id)));
      if (!r.applied) return bad('That basket is not open', 409);
      return ok(r.state);
    }
    case 'exitShare': {
      const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 50) : [];
      if (!ids.length) return bad('ids required');
      let err = '', lots = 0;
      const s = await updateLadderState(st => {
        const r = applyBasketShare(st, ids, Number(b.pct), Date.now(), () => newLadderId('pb'));
        if (typeof r === 'string') { err = r; return st; }
        lots = r.lots;
        return pushEvent(r.next, ev('info', `Basket exit ${Number(b.pct)}% requested (${r.lots} lot(s))`, ids[0]));
      });
      if (err) return bad(err, 409);
      return ok(s, { lots });
    }
    case 'resolve':
      return resolve(b, id);
    case 'modify':
      return modify(b, id);
    case 'trail':
      return trail(b, id);
    default:
      return bad(`Unknown basket op ${op}`);
  }
}

export { isBasketLive };
