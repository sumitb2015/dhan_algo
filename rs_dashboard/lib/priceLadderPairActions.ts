import { NextResponse } from 'next/server';
import { resolveContract } from '@/lib/priceLadderView';
import {
  readLadderState, updateLadderState, loadPrices, availableFunds, brokerSessionOk, dhanSellMargin, LADDER_UNDERLYINGS,
} from '@/lib/priceLadderServer';
import { fetchNettedMargin } from '@/lib/ultimateScannerDhan';
import {
  capLots, classifyClick, cleanBracket, ev, istDay, istHhmm, isMcxUnderlying, newLadderId, parseTrailRequest, pushEvent, realArmed, replanBracket,
  sessionFor, snapToStep, trailedBracket, MAX_LADDER_LOTS,
  type ClickType, type LadderBroker, type LadderContract, type LadderProduct, type LadderSide, type LadderState, type LadderZones,
} from '@/lib/priceLadder';
import {
  blendExitAvg, lotsOnContract, pairBias, pairCombined, pairLevelSane, pairName, patchPair, PAIR_STRIKE_STEP, MIN_PAIR_TRAIL_PTS,
  LEG_KEYS, type LadderPair, type PairLeg, type PairStructure,
} from '@/lib/priceLadderPair';

// The Price Ladder's Pair-mode actions (POST /api/price-ladder/state with action 'pair'). Real-money endpoint: every
// check that can refuse a pair runs here, server-side — both legs resolved from the broker's own master (never an id
// from the browser), the strangle inversion guard (CE strike above PE strike), the lot cap shared with single options,
// the level against the live combined premium, the verdict the user saw and, for REAL, the daily LIVE · REAL MONEY arm,
// a live broker session and a fail-closed funds / margin check. The watcher (planPairs + the pair jobs) fires and exits.

const BROKER_NAME: Record<LadderBroker, string> = { dhan: 'Dhan', kotak: 'Kotak', zerodha: 'Zerodha' };

/**
 * Funds for a REAL pair, fail closed (an unreadable figure refuses it). A BUY pays both premiums (+2%) in cash. A SELL
 * needs the exchange margin: Dhan's hedged basket margin for the two legs (NSE / BSE — SPAN + exposure are the
 * exchange's, the same on every broker), or for MCX the two single-leg margins added, against that broker's own funds.
 */
async function realPairBlocked(broker: LadderBroker, u: string, legs: { ce: LadderContract; pe: LadderContract }, side: LadderSide, qty: number, product: LadderProduct, ltps: Record<string, number>): Promise<string | null> {
  const funds = await availableFunds(broker);
  if (funds == null) return `Could not read ${BROKER_NAME[broker]} funds — order refused (fail closed)`;
  const ceLtp = ltps[legs.ce.securityId] ?? 0, peLtp = ltps[legs.pe.securityId] ?? 0;
  let need: number | null;
  if (side === 'BUY') need = (ceLtp + peLtp) * qty * (legs.ce.mult ?? 1) * 1.02;
  else if (isMcxUnderlying(u)) {
    const [a, b] = await Promise.all([dhanSellMargin(legs.ce, qty, product, ceLtp), dhanSellMargin(legs.pe, qty, product, peLtp)]);
    need = a != null && b != null ? a + b : null;
  } else {
    need = await fetchNettedMargin(u, [
      { side: 'SELL', securityId: legs.ce.securityId, quantity: qty },
      { side: 'SELL', securityId: legs.pe.securityId, quantity: qty },
    ]);
  }
  if (need == null || !(need > 0)) return 'Could not read the margin for this pair — refused (fail closed)';
  const have = side === 'BUY' ? funds.buy : funds.sell;
  if (need > have) return `Needs about ₹${Math.round(need).toLocaleString('en-IN')}, ${BROKER_NAME[broker]} has ₹${Math.round(have).toLocaleString('en-IN')}`;
  return null;
}

const bad = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });
const ok = (state: LadderState, extra: Record<string, unknown> = {}) => NextResponse.json({ success: true, data: { state, ...extra } });

/** The live combined premium of a pair's legs, or null. */
async function liveCombined(p: Pick<LadderPair, 'legs'>): Promise<number | null> {
  const prices = await loadPrices([], [p.legs.ce.contract, p.legs.pe.contract]);
  return pairCombined(p, prices.ltps);
}

/** Apply `mutate` only if the pair still passes `okFn` inside the lock (the watcher can move it in between). */
async function guarded(id: string, okFn: (p: LadderPair) => boolean, mutate: (s: LadderState) => LadderState): Promise<{ applied: boolean; state: LadderState }> {
  let applied = false;
  const state = await updateLadderState(st => {
    const p = (st.pairs ?? []).find(y => y.id === id);
    if (!p || !okFn(p)) return st;
    applied = true;
    return mutate(st);
  });
  return { applied, state };
}

async function arm(b: Record<string, unknown>): Promise<NextResponse> {
  const now = Date.now();
  const mode = b.mode;
  if (mode !== 'sim' && mode !== 'real') return bad('mode must be sim or real');
  const broker = b.broker as LadderBroker;
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
  if (mode === 'real') {
    if (!realArmed(readLadderState(), istDay(now))) return bad('Switch on LIVE · REAL MONEY first', 403);
    if (!brokerSessionOk(broker)) return bad(`${BROKER_NAME[broker]} session is not logged in`, 403);
  }
  const u = String(b.underlying ?? '').toUpperCase();
  if (!LADDER_UNDERLYINGS.includes(u)) return bad(`Unsupported underlying ${b.underlying}`);
  const expiry = String(b.expiry ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return bad('expiry must be YYYY-MM-DD');
  const structure = b.structure as PairStructure;
  if (structure !== 'straddle' && structure !== 'strangle') return bad('structure must be straddle or strangle');
  const ceStrike = Number(b.ceStrike), peStrike = Number(b.peStrike);
  if (!(ceStrike > 0) || !(peStrike > 0)) return bad('Invalid strikes');
  if (structure === 'straddle' && ceStrike !== peStrike) return bad('A straddle has one strike for both legs');
  // Inversion guard (CLAUDE.md): a strangle's call strike is above its put strike.
  if (structure === 'strangle' && !(ceStrike > peStrike)) return bad('A strangle needs the CE strike above the PE strike');
  // Symmetric about a listed centre, a whole number of strike steps each side: the only shape the page builds and can
  // show again (centre + wing).
  const step = PAIR_STRIKE_STEP[u];
  if (structure === 'strangle' && (!step || (ceStrike - peStrike) % (2 * step) !== 0)) {
    return bad(`A strangle needs its legs the same number of ${step ?? '?'}-point strikes either side of a centre strike`);
  }
  const side = b.side as LadderSide;
  if (side !== 'BUY' && side !== 'SELL') return bad('side must be BUY or SELL');
  if (b.product !== 'NRML' && b.product !== 'MIS') return bad('product must be NRML or MIS');
  const orderType = b.orderType as ClickType;
  if (orderType !== 'LIMIT' && orderType !== 'SL') return bad('orderType must be LIMIT or SL');
  const lots = capLots(b.lots);
  if (lots == null) return bad('Lots must be a whole number from 1 to 20');
  const bracket = b.bracket == null ? null : cleanBracket(b.bracket);
  if (b.bracket != null && !bracket) return bad('Bracket needs a positive SL in points (target 0 = Cover order)');
  const sess = sessionFor(u, istDay(now));
  if (sess.open >= sess.close) return bad(sess.note ?? 'The market is closed today');
  if (istHhmm(now) >= sess.autoExit) return bad(`After ${sess.autoExitLabel} the ladder only exits`);

  const [ce, pe] = await Promise.all([resolveContract(broker, u, expiry, ceStrike, 'CE'), resolveContract(broker, u, expiry, peStrike, 'PE')]);
  if (typeof ce === 'string') return bad(ce);
  if (typeof pe === 'string') return bad(pe);
  if (ce.lotSize !== pe.lotSize) return bad(`The legs have different lot sizes (${ce.lotSize} / ${pe.lotSize}) — refused`);
  const legs = { ce: { contract: ce }, pe: { contract: pe } };
  const qty = lots * ce.lotSize;
  // One 20-lot cap per contract, shared with single-option orders on the same strike.
  const st0 = readLadderState();
  for (const c of [ce, pe]) {
    const held = lotsOnContract(st0, c.securityId, broker, mode, side);
    if (held + lots > MAX_LADDER_LOTS) return bad(`The ladder already holds or has armed ${held} lots of ${c.strike}${c.opt} — the cap is ${MAX_LADDER_LOTS}`);
  }
  const prices = await loadPrices([], [ce, pe]);
  const combined = pairCombined({ legs }, prices.ltps);
  if (combined == null) return bad('No live price for both legs yet — the WebSocket feed may still be subscribing; try again in a moment');
  const level = snapToStep(Number(b.level), 0.05);
  if (!pairLevelSane(level, combined)) return bad(`Level ${level} is too far from the combined premium ${combined}`);
  const zones: LadderZones = b.zones === 'anywhere' ? 'anywhere' : 'classic';
  // Buy below / Sell above the combined is a limit-like entry; the other side is a breakout (Anywhere, or Order Type SL).
  const verdict = classifyClick({ mode: 'plain', opt: 'CE', side, level, ref: combined, orderType, zones });
  if (!verdict.ok) return bad(verdict.error);
  const expect = b.expect as { kind?: unknown; dir?: unknown } | undefined;
  if (expect && (expect.kind !== verdict.kind || expect.dir !== verdict.dir)) {
    return bad(`The combined premium crossed ${level} since you clicked — that would now be a ${verdict.kind === 'stop' ? 'breakout' : 'limit'} entry, not what you placed. Nothing was armed; click again.`, 409);
  }
  if (mode === 'real') {
    const blocked = await realPairBlocked(broker, u, { ce, pe }, side, qty, b.product, prices.ltps);
    if (blocked) return bad(blocked);
  }

  const pair: LadderPair = {
    id: newLadderId('pp'), broker, mode, structure, side, lots, qty, product: b.product, state: 'armed',
    legs, createdAt: now, updatedAt: now, entryLevel: level, entryDir: verdict.dir, seenSafe: true,
    orderType: verdict.kind === 'stop' ? 'SL' : orderType, ...(zones === 'anywhere' ? { zones } : {}), ...(bracket ? { bracket } : {}),
  };
  const br = bracket ? ` · ${bracket.tgtPts > 0 ? `TGT ${bracket.tgtPts} / ` : 'Cover · '}SL ${bracket.slPts}${bracket.trailPts ? ` / trailing ${bracket.trailPts} behind` : ''} pts` : '';
  let capped = false;
  const s = await updateLadderState(st => {
    // Re-checked inside the lock: two clicks in flight must not both pass the read above.
    if (LEG_KEYS.some(k => lotsOnContract(st, legs[k].contract.securityId, broker, mode, side) + lots > MAX_LADDER_LOTS)) { capped = true; return st; }
    return pushEvent({ ...st, pairs: [...(st.pairs ?? []), pair] },
    ev('info', `Armed ${mode === 'real' ? 'REAL' : 'SIM'} ${side} ${lots} lot(s) ${u} ${pairName(pair)} when the combined ${verdict.dir === 'below' ? '≤' : '≥'} ${level}${br}`, pair.id));
  });
  if (capped) return bad(`That would take a leg past the ${MAX_LADDER_LOTS}-lot cap`);
  return ok(s, { id: pair.id });
}

async function modify(b: Record<string, unknown>, id: string): Promise<NextResponse> {
  const p = (readLadderState().pairs ?? []).find(y => y.id === id);
  if (!p) return bad('Unknown pair');
  const c = await liveCombined(p);
  if (c == null) return bad('No live price for both legs to check the level against');
  const bs = pairBias(p.side);
  if (p.state === 'armed' && p.bracket && (b.tgtY != null || b.slY != null) && b.level == null) {
    // A planned target / SL dragged before the fill: kept as points from the entry level.
    const entry = Number(p.entryLevel);
    const tgtY = b.tgtY == null ? null : Number(b.tgtY);
    const slY = b.slY == null ? null : Number(b.slY);
    const check = replanBracket(p.bracket, entry, bs, tgtY, slY, v => v > 0);
    if (typeof check === 'string') return bad(check);
    const r = await guarded(id, y => y.state === 'armed' && !!y.bracket && y.entryLevel === p.entryLevel, st => {
      const y = (st.pairs ?? []).find(z => z.id === id)!;
      const bracket = replanBracket(y.bracket!, entry, bs, tgtY, slY, v => v > 0) as typeof check;
      return pushEvent(patchPair(st, id, { bracket }), ev('info', `Planned bracket: TGT ${bracket.tgtPts > 0 ? `${bracket.tgtPts} pts` : '—'} / SL ${bracket.slPts} pts`, id));
    });
    if (!r.applied) return bad('Too late — it has just fired or moved; try again', 409);
    return ok(r.state);
  }
  if (p.state === 'armed') {
    const level = snapToStep(Number(b.level), 0.05);
    if (!pairLevelSane(level, c)) return bad('Level is too far from the combined premium');
    const v = classifyClick({ mode: 'plain', opt: 'CE', side: p.side, level, ref: c, orderType: p.orderType ?? 'LIMIT', zones: p.zones });
    if (!v.ok) return bad(p.zones === 'anywhere' ? v.error : `${v.error} (or arm it in the Anywhere view)`);
    const orderType: ClickType = v.kind === 'stop' ? 'SL' : p.zones === 'anywhere' ? 'LIMIT' : (p.orderType ?? 'LIMIT');
    const r = await guarded(id, y => y.state === 'armed',
      st => pushEvent(patchPair(st, id, { entryLevel: level, entryDir: v.dir, seenSafe: true, orderType }), ev('info', `Pair entry moved to ${level}${v.kind === 'stop' ? ' (breakout)' : ''}`, id)));
    if (!r.applied) return bad('Too late — it has just fired', 409);
    return ok(r.state);
  }
  if (p.state === 'open' && p.bracket) {
    const tgtY = b.tgtY == null ? p.tgtY : Number(b.tgtY);
    const slY = b.slY == null ? p.slY : Number(b.slY);
    if (tgtY != null && !(tgtY > 0 && (bs > 0 ? tgtY > c : tgtY < c))) return bad('Target must be on the profit side of the combined premium');
    if (slY != null && !(slY > 0 && (bs > 0 ? slY < c : slY > c))) return bad('SL must be on the loss side of the combined premium');
    const r = await guarded(id, y => y.state === 'open' && !!y.bracket, st => {
      const patch: Partial<LadderPair> = {};
      if (b.tgtY != null) patch.tgtY = tgtY;
      // Only a moved SL restarts trailing (from here); a target-only move leaves the trail's base alone.
      if (b.slY != null) Object.assign(patch, { slY, slY0: slY, trailFrom: c, peakY: c });
      return pushEvent(patchPair(st, id, patch), ev('info', `Pair bracket moved: TGT ${tgtY ?? '—'} / SL ${slY}`, id));
    });
    if (!r.applied) return bad('It is closed — not modified', 409);
    return ok(r.state);
  }
  return bad(`Cannot modify a pair that is ${p.state}`);
}

async function trail(b: Record<string, unknown>, id: string): Promise<NextResponse> {
  // As a slice's trail: `trailPts` sets the distance (0 = off), `delta` widens / tightens it. An open pair's trail starts
  // from the combined premium now, so switching it on cannot jump the SL to a level the market has left.
  const req = parseTrailRequest(b);
  if (typeof req === 'string') return bad(req);
  const p0 = (readLadderState().pairs ?? []).find(y => y.id === id);
  // Only where the bracket runs: an exiting / broken / unknown pair's bracket is off, so a trail there would protect nothing.
  const trailable = (y: LadderPair) => !!y.bracket && (y.state === 'armed' || y.state === 'open');
  if (!p0 || !trailable(p0)) return bad('The bracket is not running on this pair — trailing not changed', 409);
  let now: number | null = null;
  if (p0.state === 'open') {
    now = await liveCombined(p0);
    if (now == null) return bad('No live price for both legs to start the trail from — try again in a moment');
  }
  let label = '';
  const r = await guarded(id, trailable, st => {
    const y = (st.pairs ?? []).find(z => z.id === id)!;
    const bracket = trailedBracket(y.bracket!, req, MIN_PAIR_TRAIL_PTS);
    label = bracket.trailPts ? `Trailing SL ${bracket.trailPts} pts behind the best combined premium` : 'Trailing off';
    return pushEvent(patchPair(st, id, { bracket, ...(y.state === 'open' && now != null ? { peakY: now } : {}) }), ev('info', label, id));
  });
  if (!r.applied) return bad('It is closed — trailing not changed', 409);
  return ok(r.state);
}

/**
 * An UNKNOWN leg resolved by the user after checking Orders / Positions. Entry: 'open' = it filled (tracked at its
 * fill or the live price), 'flat' = nothing opened. Exit: 'open' = still held (its exit is sent again), 'flat' = it is
 * closed (booked at the live price). Once no leg is unknown the pair carries on: an entry gets its verdict (open, or
 * unwind the filled leg), an exit goes on until both legs are flat.
 */
async function resolve(b: Record<string, unknown>, id: string): Promise<NextResponse> {
  const k = b.leg;
  if (k !== 'ce' && k !== 'pe') return bad("leg must be 'ce' or 'pe'");
  const outcome = b.outcome;
  if (outcome !== 'open' && outcome !== 'flat') return bad("outcome must be 'open' or 'flat'");
  const p0 = (readLadderState().pairs ?? []).find(y => y.id === id);
  if (!p0 || p0.state !== 'unknown' || !p0.legs[k].unknown) return bad('That leg is not UNKNOWN');
  const ltp = (await loadPrices([], [p0.legs[k].contract])).ltps[p0.legs[k].contract.securityId] ?? 0;
  const now = Date.now();
  const r = await guarded(id, y => y.state === 'unknown' && !!y.legs[k].unknown, st => {
    const p = (st.pairs ?? []).find(y => y.id === id)!;
    const l = p.legs[k];
    let leg: PairLeg;
    if (l.unknown === 'entry') {
      leg = outcome === 'open'
        ? { ...l, entry: 'filled', filledQty: p.qty, avg: l.avg || ltp || undefined, unknown: undefined, note: 'Confirmed open by you' }
        : { ...l, entry: 'dead', filledQty: 0, unknown: undefined, note: 'Confirmed: nothing opened' };
    } else {
      const cleared = { unknown: undefined, exitOrderId: undefined, exitSentAt: undefined, exitQty: undefined };
      if (outcome === 'open') leg = { ...l, ...cleared, exitRetryAt: now, note: 'Confirmed still open — its exit is sent again' };
      else {
        const held = l.held ?? 0;
        leg = { ...l, ...cleared, held: 0, exitedQty: (l.exitedQty ?? 0) + held, exitAvg: blendExitAvg(l, held, ltp), note: `Confirmed closed by you${ltp > 0 ? '' : ' (no live price — booked at entry)'}` };
      }
    }
    const legs = { ...p.legs, [k]: leg };
    const settled = LEG_KEYS.every(x => !legs[x].unknown);
    const state = settled ? (p.exitReason ? 'exiting' : 'placing') : 'unknown';
    return pushEvent(patchPair(st, id, { legs, state, ...(settled ? { note: undefined } : {}) }, now),
      ev('info', `${pairName(p)}: ${k.toUpperCase()} resolved as ${outcome}${settled ? ' — the pair carries on' : ''}`, id));
  });
  if (!r.applied) return bad('That leg is not UNKNOWN any more', 409);
  return ok(r.state);
}

/** `{ action: 'pair', op, ... }` */
export async function pairAction(b: Record<string, unknown>): Promise<NextResponse> {
  const op = String(b.op ?? '');
  const id = typeof b.id === 'string' ? b.id : '';
  switch (op) {
    case 'arm':
      return arm(b);
    case 'cancel': {
      const r = await guarded(id, y => y.state === 'armed',
        st => pushEvent(patchPair(st, id, { state: 'cancelled', note: 'Cancelled by you' }), ev('info', 'Pair cancelled', id)));
      if (!r.applied) return bad('Too late — it has just fired or is gone; check the pair list', 409);
      return ok(r.state);
    }
    case 'exit': {
      // Both legs exit together on the watcher's next tick (at their live prices).
      // A BROKEN pair exits what is left of it (its bracket is off; nothing else would close it).
      const r = await guarded(id, y => y.state === 'open' || y.state === 'broken',
        st => pushEvent(patchPair(st, id, { exitWanted: 'Manual exit' }), ev('info', 'Pair exit requested', id)));
      if (!r.applied) return bad('That pair is not open', 409);
      return ok(r.state);
    }
    case 'resolve':
      return resolve(b, id);
    case 'modify':
      return modify(b, id);
    case 'trail':
      return trail(b, id);
    default:
      return bad(`Unknown pair op ${op}`);
  }
}
