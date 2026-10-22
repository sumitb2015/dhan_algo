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
  blendExitAvg, cleanLegSlPct, fillLeg, legHeld, lotsOnContract, splitOneLot, pairBias, pairCombined, pairLevelSane, pairName, patchPair, PAIR_STRIKE_STEP, MIN_PAIR_TRAIL_PTS,
  LEG_KEYS, type LadderPair, type PairLeg, type PairLegKey, type PairStructure,
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
const round2 = (v: number) => Number(v.toFixed(2));
const ok = (state: LadderState, extra: Record<string, unknown> = {}) => NextResponse.json({ success: true, data: { state, ...extra } });

/** The live combined premium of a pair's legs, or null. */
async function liveCombined(p: Pick<LadderPair, 'legs'>): Promise<number | null> {
  const prices = await loadPrices([], [p.legs.ce.contract, p.legs.pe.contract]);
  return pairCombined(p, prices.ltps);
}

/** Resolve the root pair ID by following joinedTo links. */
function rootPairId(st: LadderState, id: string): string {
  let cur = id;
  const seen = new Set<string>([cur]);
  while (true) {
    const p = (st.pairs ?? []).find(y => y.id === cur);
    if (!p?.joinedTo || seen.has(p.joinedTo)) break;
    seen.add(p.joinedTo);
    cur = p.joinedTo;
  }
  return cur;
}

/**
 * Open (and placing joined) pairs sharing `p`'s exits: pairs linked by explicit joinedTo relationships
 * (sharing the same root pair), same broker, mode, side, and contracts.
 *
 * Bug 8 fix: the old implementation matched by SL+TGT levels, so two independent same-strike no-bracket pairs would
 * silently share each other's leg-SL. Explicit joinedTo links are used now; two independently-armed pairs never share.
 */
function joinedTo(st: LadderState, p: LadderPair): LadderPair[] {
  const root = rootPairId(st, p.id);
  return (st.pairs ?? []).filter(y =>
    (y.state === 'open' || (y.state === 'placing' && !!y.joinedTo)) &&
    y.broker === p.broker && y.mode === p.mode && y.side === p.side &&
    y.legs.ce.contract.securityId === p.legs.ce.contract.securityId &&
    y.legs.pe.contract.securityId === p.legs.pe.contract.securityId &&
    rootPairId(st, y.id) === root
  );
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

/**
 * Bug 10 fix: the session / arm / session checks were copy-pasted into arm(), addLot() and roll(). One place now.
 * Returns an error string to return to the caller, or null when the open is allowed.
 * `isArm` = true for arm() which checks the auto-exit itself differently (arms are allowed up to close).
 */
function checkOpenAllowed(
  u: string, now: number, mode: 'sim' | 'real', broker: LadderBroker, st: LadderState,
  { isArm = false }: { isArm?: boolean } = {},
): string | null {
  const sess = sessionFor(u, istDay(now));
  const hhmm = istHhmm(now);
  if (sess.open >= sess.close) return sess.note ?? 'The market is closed today';
  if (!isArm && (hhmm < sess.open || hhmm >= sess.close)) return 'The market is closed';
  if (hhmm >= sess.autoExit) return `After ${sess.autoExitLabel} the ladder only exits`;
  if (mode === 'real') {
    if (!realArmed(st, istDay(now))) return 'Switch on LIVE · REAL MONEY first';
    if (!brokerSessionOk(broker)) return `${BROKER_NAME[broker]} session is not logged in`;
  }
  return null;
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
  const legSlPct = b.legSlPct == null || Number(b.legSlPct) === 0 ? null : cleanLegSlPct(b.legSlPct, side);
  if (b.legSlPct != null && Number(b.legSlPct) !== 0 && legSlPct == null) return bad(side === 'SELL' ? 'Leg SL must be 1-1000 % (a short leg rising by it)' : 'Leg SL must be 1-99 % (a long leg falling by it)');
  // Bug 10 fix: shared session / arm / broker check (isArm=true: session hours are checked by the auto-exit guard only).
  const openErr = checkOpenAllowed(u, now, mode, broker, readLadderState(), { isArm: true });
  if (openErr) return bad(openErr, openErr.includes('LIVE') || openErr.includes('session') ? 403 : 400);

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
    ...(legSlPct ? { legSlPct } : {}),
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
      // Every pair on these exits moves together (a '+1 lot' shares its pair's target / SL).
      const all = joinedTo(st, (st.pairs ?? []).find(y => y.id === id)!);
      let next = st;
      for (const y of all) next = patchPair(next, y.id, patch);
      return pushEvent(next, ev('info', `Pair bracket moved: TGT ${tgtY ?? '—'} / SL ${slY}${all.length > 1 ? ` (${all.length} pairs)` : ''}`, id));
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
    const trailPts = trailedBracket(y.bracket!, req, MIN_PAIR_TRAIL_PTS).trailPts ?? 0;
    label = trailPts ? `Trailing SL ${trailPts} pts behind the best combined premium` : 'Trailing off';
    // The same trail on every pair sharing these exits.
    const all = joinedTo(st, y);
    let next = st;
    for (const z of all) {
      const bracket = trailedBracket(z.bracket!, { abs: trailPts, delta: null }, MIN_PAIR_TRAIL_PTS);
      next = patchPair(next, z.id, { bracket, ...(z.state === 'open' && now != null ? { peakY: now } : {}) });
    }
    return pushEvent(next, ev('info', `${label}${all.length > 1 ? ` (${all.length} pairs)` : ''}`, id));
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
    // Back to where it was: an exit, a roll, or an entry.
    const state = settled ? (p.exitReason ? 'exiting' : p.rollTo ? 'rolling' : 'placing') : 'unknown';
    return pushEvent(patchPair(st, id, { legs, state, ...(settled ? { note: undefined } : {}) }, now),
      ev('info', `${pairName(p)}: ${k.toUpperCase()} resolved as ${outcome}${settled ? ' — the pair carries on' : ''}`, id));
  });
  if (!r.applied) return bad('That leg is not UNKNOWN any more', 409);
  return ok(r.state);
}

/**
 * + 1 lot on an open pair: both legs at MARKET now, joining that pair's target / SL / trail / leg SL (exited with them).
 * An opening order, so every arm check applies: market hours, the auto-exit time, the shared 20-lot cap per leg and, for
 * REAL, the live arm, the broker session and funds. SIM fills at the live prices here; a REAL one is written as
 * `placing` + `sendWanted` and the watcher sends it like an entry (confirm each fill; a lone leg is unwound).
 */
async function addLot(id: string): Promise<NextResponse> {
  const now = Date.now();
  const st0 = readLadderState();
  const p = (st0.pairs ?? []).find(y => y.id === id);
  if (!p || p.state !== 'open') return bad('That pair is not open');
  const u = p.legs.ce.contract.underlying;
  // Bug 10 fix: use the shared open-allowed check instead of the inline copy.
  const openErr = checkOpenAllowed(u, now, p.mode, p.broker, st0);
  if (openErr) return bad(openErr, openErr.includes('LIVE') || openErr.includes('session') ? 403 : 400);
  for (const k of LEG_KEYS) {
    const held = lotsOnContract(st0, p.legs[k].contract.securityId, p.broker, p.mode, p.side);
    if (held + 1 > MAX_LADDER_LOTS) return bad(`The ladder holds ${held} lots of ${p.legs[k].contract.strike}${p.legs[k].contract.opt} — the cap is ${MAX_LADDER_LOTS}`);
  }
  const lot = p.legs.ce.contract.lotSize;
  const prices = await loadPrices([], [p.legs.ce.contract, p.legs.pe.contract]);
  const ce = prices.ltps[p.legs.ce.contract.securityId], pe = prices.ltps[p.legs.pe.contract.securityId];
  if (!(ce > 0) || !(pe > 0)) return bad('No live price for both legs yet — try again in a moment');
  if (p.mode === 'real') {
    const blocked = await realPairBlocked(p.broker, u, { ce: p.legs.ce.contract, pe: p.legs.pe.contract }, p.side, lot, p.product, prices.ltps);
    if (blocked) return bad(blocked);
  }
  const fresh = (l: PairLeg): PairLeg => ({ contract: l.contract });
  const levels = { entryY: p.entryY, tgtY: p.tgtY, slY: p.slY, slY0: p.slY0, peakY: p.peakY, trailFrom: p.trailFrom };
  const base: LadderPair = {
    id: newLadderId('pp'), broker: p.broker, mode: p.mode, structure: p.structure, side: p.side, lots: 1, qty: lot, product: p.product,
    state: p.mode === 'real' ? 'placing' : 'open', legs: { ce: fresh(p.legs.ce), pe: fresh(p.legs.pe) }, createdAt: now, updatedAt: now,
    entryLevel: p.entryLevel, entryDir: p.entryDir, orderType: p.orderType, ...(p.bracket ? { bracket: p.bracket } : {}),
    ...(p.legSlPct ? { legSlPct: p.legSlPct } : {}), joinedTo: p.id, ...levels,
  };
  const child: LadderPair = p.mode === 'real'
    ? { ...base, sendWanted: true, crossY: round2(ce + pe) }
    : { ...base, openedAt: now, legs: {
      ce: fillLeg(base.legs.ce, lot, ce),
      pe: fillLeg(base.legs.pe, lot, pe),
    } };
  let capped = false;
  const s = await updateLadderState(st => {
    // Re-checked inside the lock: the pair may have closed, or another click taken the cap, since the reads above.
    const cur = (st.pairs ?? []).find(y => y.id === id);
    if (!cur || cur.state !== 'open') { capped = true; return st; }
    if (LEG_KEYS.some(k => lotsOnContract(st, p.legs[k].contract.securityId, p.broker, p.mode, p.side) + 1 > MAX_LADDER_LOTS)) { capped = true; return st; }
    return pushEvent({ ...st, pairs: [...(st.pairs ?? []), child] },
      ev('info', `${p.mode === 'real' ? '' : 'SIM '}+1 lot ${p.side} ${pairName(p)}${p.mode === 'real' ? ' — both legs at MARKET' : ` filled: CE ${ce.toFixed(2)} + PE ${pe.toFixed(2)}`}`, child.id));
  });
  if (capped) return bad('The pair closed, or the lot cap was reached, before the lot was added', 409);
  return ok(s, { id: child.id });
}

/**
 * Roll an open pair: `legs` 'both' = shift the pair, 'ce' / 'pe' = roll that leg only; `steps` strikes up (+) or down
 * (−). The old leg(s) close in full before the new strike(s) open (dhan-terminal-position-ownership Inv 4); the other
 * leg is not touched. Refused if it would invert the pair (CE strike below PE). A new leg is an opening order, so the
 * arm checks apply to it: hours, auto-exit, the lot cap on the new strike and, for REAL, the live arm, session and funds.
 */
async function roll(b: Record<string, unknown>, id: string): Promise<NextResponse> {
  const now = Date.now();
  const which = b.legs;
  if (which !== 'both' && which !== 'ce' && which !== 'pe') return bad("legs must be 'both', 'ce' or 'pe'");
  const steps = Number(b.steps);
  if (!Number.isInteger(steps) || steps === 0 || Math.abs(steps) > 20) return bad('steps must be a whole number of strikes, 1-20 up or down');
  const st0 = readLadderState();
  const p = (st0.pairs ?? []).find(y => y.id === id);
  if (!p || p.state !== 'open') return bad('Only an open pair can be rolled');
  if (LEG_KEYS.some(k => (p.legs[k].held ?? p.qty) !== p.qty)) return bad('Its legs no longer hold the same quantity — exit it from the pair table');
  // Bug 6 fix: refuse a roll when an exit is already queued. A roll arriving in the same tick as an Exit click would
  // otherwise silently clear exitWanted and open new strikes instead of exiting.
  if (p.exitWanted) return bad('An exit is already queued for this pair — let it exit first', 409);
  const u = p.legs.ce.contract.underlying;
  // Bug 10 fix: use the shared open-allowed check instead of the inline copy.
  const openErr = checkOpenAllowed(u, now, p.mode, p.broker, st0);
  if (openErr) return bad(openErr, openErr.includes('LIVE') || openErr.includes('session') ? 403 : 400);
  const step = PAIR_STRIKE_STEP[u];
  if (!step) return bad(`No strike step for ${u}`);
  const moving: readonly PairLegKey[] = which === 'both' ? LEG_KEYS : [which];
  const strike = (k: 'ce' | 'pe') => p.legs[k].contract.strike + (moving.includes(k) ? steps * step : 0);
  // Inversion guard (CLAUDE.md): never a CE strike below the PE strike.
  if (strike('ce') < strike('pe')) return bad(`That would put the CE (${strike('ce')}) below the PE (${strike('pe')}) — refused`);
  const resolved = await Promise.all(moving.map(k => resolveContract(p.broker, u, p.legs[k].contract.expiry, strike(k), k === 'ce' ? 'CE' : 'PE')));
  const bad1 = resolved.find(r => typeof r === 'string');
  if (bad1) return bad(bad1 as string);
  const rollTo: NonNullable<LadderPair['rollTo']> = { steps };
  moving.forEach((k, i) => { rollTo[k] = resolved[i] as LadderContract; });
  for (const k of moving) {
    const c = rollTo[k]!;
    if (c.lotSize !== p.legs.ce.contract.lotSize) return bad(`${c.strike}${c.opt} has a different lot size — refused`);
    const held = lotsOnContract(st0, c.securityId, p.broker, p.mode, p.side, p.id);
    if (held + p.lots > MAX_LADDER_LOTS) return bad(`The ladder already holds or has armed ${held} lots of ${c.strike}${c.opt} — the cap is ${MAX_LADDER_LOTS}`);
  }
  const prices = await loadPrices([], moving.map(k => rollTo[k]!));
  if (moving.some(k => !(prices.ltps[rollTo[k]!.securityId] > 0))) return bad('No live price for the new strike yet — try again in a moment');
  if (p.mode === 'real') {
    // The new leg(s) checked on their own (the old leg's margin is not counted as freed — fail closed).
    const funds = await availableFunds(p.broker);
    if (funds == null) return bad(`Could not read ${BROKER_NAME[p.broker]} funds — roll refused (fail closed)`);
    let need: number | null = 0;
    for (const k of moving) {
      const c = rollTo[k]!, px = prices.ltps[c.securityId];
      const m = p.side === 'BUY' ? px * p.qty * (c.mult ?? 1) * 1.02 : await dhanSellMargin(c, p.qty, p.product, px);
      need = m == null || need == null ? null : need + m;
    }
    if (need == null || !(need > 0)) return bad('Could not read the margin for the new leg — refused (fail closed)');
    const have = p.side === 'BUY' ? funds.buy : funds.sell;
    if (need > have) return bad(`The new leg needs about ₹${Math.round(need).toLocaleString('en-IN')}, ${BROKER_NAME[p.broker]} has ₹${Math.round(have).toLocaleString('en-IN')}`);
  }
  const what = `${which === 'both' ? 'Shift' : `Roll ${which.toUpperCase()}`} ${steps > 0 ? '+' : ''}${steps} strike(s): ${moving.map(k => `${p.legs[k].contract.strike}${k.toUpperCase()} → ${rollTo[k]!.strike}${k.toUpperCase()}`).join(', ')}`;
  const r = await guarded(id, y => y.state === 'open' && !y.exitWanted, st => {
    const cur = (st.pairs ?? []).find(y => y.id === id)!;
    // The kept leg's own fill stands as "filled in full", so the roll's verdict reads both legs.
    const legs = { ...cur.legs };
    for (const k of LEG_KEYS) {
      const held = legHeld(cur, legs[k]);
      legs[k] = { ...legs[k], held, ...(moving.includes(k) ? {} : { entry: 'filled' as const, filledQty: held }) };
    }
    return pushEvent(patchPair(st, id, { state: 'rolling', rollTo, legs, exitWanted: undefined, note: what }, now), ev('info', `${pairName(cur)}: ${what} — closing first`, id));
  });
  if (!r.applied) return bad('That pair is not open, or an exit is queued — let it settle first', 409);
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
    case 'add':
      return addLot(id);
    case 'roll':
      return roll(b, id);
    case 'reduce': {
      // − 1 lot: split one lot off as its own pair that exits both legs (a one-lot pair just exits). Only reduces.
      const childId = newLadderId('pp');
      let err = '';
      const r = await guarded(id, y => y.state === 'open', st => {
        const p = (st.pairs ?? []).find(y => y.id === id)!;
        const sp = splitOneLot(p, childId, Date.now());
        if (typeof sp === 'string') { err = sp; return st; }
        let next = patchPair(st, id, sp.parent);
        if (sp.child) next = { ...next, pairs: [...(next.pairs ?? []), sp.child] };
        return pushEvent(next, ev('info', `${pairName(p)}: −1 lot — exiting it at market`, id));
      });
      if (err) return bad(err, 409);
      if (!r.applied) return bad('That pair is not open', 409);
      return ok(r.state);
    }
    case 'legsl': {
      // Set (or 0 = clear) an armed / open pair's per-leg stop, on every pair sharing its exits.
      const p0 = (readLadderState().pairs ?? []).find(y => y.id === id);
      if (!p0 || (p0.state !== 'armed' && p0.state !== 'open')) return bad('Leg SL can be set on an armed or open pair', 409);
      const off = Number(b.legSlPct) === 0;
      const pct = off ? null : cleanLegSlPct(b.legSlPct, p0.side);
      if (!off && pct == null) return bad(p0.side === 'SELL' ? 'Leg SL must be 1-1000 % (0 = off)' : 'Leg SL must be 1-99 % (0 = off)');
      const r = await guarded(id, y => y.state === 'armed' || y.state === 'open', st => {
        const all = joinedTo(st, (st.pairs ?? []).find(y => y.id === id)!);
        let next = st;
        for (const y of all) next = patchPair(next, y.id, { legSlPct: pct ?? undefined });
        return pushEvent(next, ev('info', pct ? `Leg SL ${pct}% — either leg ${p0.side === 'SELL' ? 'rising' : 'falling'} that far from its fill exits both` : 'Leg SL off', id));
      });
      if (!r.applied) return bad('That pair is not armed or open', 409);
      return ok(r.state);
    }
    case 'exit': {
      // Both legs exit together on the watcher's next tick (at their live prices).
      // A BROKEN pair exits what is left of it (its bracket is off; nothing else would close it).
      // Bug 2 fix: a ROLLING pair must also accept Exit — the watcher detects exitWanted and cancels the roll.
      // Every joined pair exits together so adding lots doesn't leave orphan positions.
      const r = await guarded(id, y => y.state === 'open' || y.state === 'broken' || y.state === 'rolling', st => {
        const cur = (st.pairs ?? []).find(y => y.id === id)!;
        const all = joinedTo(st, cur);
        let next = st;
        for (const y of all) next = patchPair(next, y.id, { exitWanted: 'Manual exit' });
        return pushEvent(next, ev('info', `Pair exit requested${all.length > 1 ? ` (${all.length} pairs)` : ''}`, id));
      });
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
