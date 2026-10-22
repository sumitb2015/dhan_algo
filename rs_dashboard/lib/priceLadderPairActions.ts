import { NextResponse } from 'next/server';
import { resolveContract } from '@/lib/priceLadderView';
import { readLadderState, updateLadderState, loadPrices, LADDER_UNDERLYINGS } from '@/lib/priceLadderServer';
import {
  capLots, classifyClick, cleanBracket, ev, istDay, istHhmm, newLadderId, parseTrailRequest, pushEvent, replanBracket, sessionFor, snapToStep, trailedBracket,
  type ClickType, type LadderBroker, type LadderSide, type LadderState, type LadderZones,
} from '@/lib/priceLadder';
import {
  isPairLive, pairBias, pairCombined, pairLevelSane, pairName, patchPair, PAIR_STRIKE_STEP, MIN_PAIR_TRAIL_PTS,
  type LadderPair, type PairStructure,
} from '@/lib/priceLadderPair';

// The Price Ladder's Pair-mode actions (POST /api/price-ladder/state with action 'pair'). Phase 1 is SIM only: a REAL
// pair is refused here, before anything is stored. Every check runs server-side — both legs resolved from Dhan's own
// master (never an id from the browser), the strangle inversion guard (CE strike above PE strike), the lot cap, the
// level against the live combined premium, and the verdict the user saw. The watcher (planPairs) fires and exits.

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
  if (b.mode === 'real') return bad('Pair mode is SIM only for now — switch the page to SIM', 403);
  if (b.mode !== 'sim') return bad('mode must be sim');
  const broker = b.broker as LadderBroker;
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return bad('broker must be dhan, kotak or zerodha');
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
  const legs = { ce: { contract: ce }, pe: { contract: pe } };
  const combined = await liveCombined({ legs });
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

  const pair: LadderPair = {
    id: newLadderId('pp'), broker, mode: 'sim', structure, side, lots, qty: lots * ce.lotSize, product: b.product, state: 'armed',
    legs, createdAt: now, updatedAt: now, entryLevel: level, entryDir: verdict.dir, seenSafe: true,
    orderType: verdict.kind === 'stop' ? 'SL' : orderType, ...(zones === 'anywhere' ? { zones } : {}), ...(bracket ? { bracket } : {}),
  };
  const br = bracket ? ` · ${bracket.tgtPts > 0 ? `TGT ${bracket.tgtPts} / ` : 'Cover · '}SL ${bracket.slPts}${bracket.trailPts ? ` / trailing ${bracket.trailPts} behind` : ''} pts` : '';
  const s = await updateLadderState(st => pushEvent({ ...st, pairs: [...(st.pairs ?? []), pair] },
    ev('info', `Armed SIM ${side} ${lots} lot(s) ${u} ${pairName(pair)} when the combined ${verdict.dir === 'below' ? '≤' : '≥'} ${level}${br}`, pair.id)));
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
  if (!p0 || !p0.bracket || !isPairLive(p0)) return bad('It is closed — trailing not changed', 409);
  let now: number | null = null;
  if (p0.state === 'open') {
    now = await liveCombined(p0);
    if (now == null) return bad('No live price for both legs to start the trail from — try again in a moment');
  }
  let label = '';
  const r = await guarded(id, y => !!y.bracket && isPairLive(y), st => {
    const y = (st.pairs ?? []).find(z => z.id === id)!;
    const bracket = trailedBracket(y.bracket!, req, MIN_PAIR_TRAIL_PTS);
    label = bracket.trailPts ? `Trailing SL ${bracket.trailPts} pts behind the best combined premium` : 'Trailing off';
    return pushEvent(patchPair(st, id, { bracket, ...(y.state === 'open' && now != null ? { peakY: now } : {}) }), ev('info', label, id));
  });
  if (!r.applied) return bad('It is closed — trailing not changed', 409);
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
      const r = await guarded(id, y => y.state === 'open',
        st => pushEvent(patchPair(st, id, { exitWanted: 'Manual exit' }), ev('info', 'Pair exit requested', id)));
      if (!r.applied) return bad('That pair is not open', 409);
      return ok(r.state);
    }
    case 'modify':
      return modify(b, id);
    case 'trail':
      return trail(b, id);
    default:
      return bad(`Unknown pair op ${op}`);
  }
}
