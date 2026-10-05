/**
 * The Focus Tool rule engine: every decision that can open or close a real
 * position, as pure functions.
 *
 * These used to live inside components/FocusTool.tsx, where nothing could
 * reach them — the terminal's shipping rules had no test coverage at all,
 * while the only test file in the feature covered a parallel implementation
 * that was never wired up. They are extracted here so both this page and its
 * server-side twin can be checked against the same cases.
 *
 * PARITY. scripts/tools/focus_tool_rows_worker.py runs these same rules
 * outside the browser, so a disagreement between the two means the screen
 * shows one thing and the account does another. That is no longer asserted
 * only in a comment: lib/focusToolRules.cases.json is a shared fixture that
 * BOTH implementations are run against — focusToolRules.test.ts here and
 * tests/test_focus_tool_parity.py there. Change a rule and you change the
 * fixture, which fails the other side until it is changed too.
 *
 * Everything here is pure: no fetch, no DOM, no clock. Time arrives as
 * 'HH:MM' IST and dates as 'YYYY-MM-DD', because a function that reads the
 * clock itself cannot be tested at 15:17.
 */

import { NSE_HOLIDAYS } from './nseHolidays.ts';
import { greeksForLeg, trustedMark, type FutureQuote } from './optionsPricing.ts';
import type {
  FocusRow, FocusDte, FocusRowStatus, FocusReentryMode, FocusReentryTrigger, FocusPendingReentry, FocusLegSimpleMom, FocusLazyLeg, FocusLegRangeBreakout, FocusOverallMode,
  FocusLegSlRule, FocusLegTrailSl, FocusLegOrbSl, FocusOrbStamp, FocusStrikeCriteria, FocusLegCrit,
} from '@/lib/focusToolRows';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Repo-wide intraday square-off, 15:17 IST (CLAUDE.md — every strategy
 * hardcodes it). Applied to MIS rows as a backstop so a row whose own exit
 * time is later than the broker's auto-square-off never rides into it.
 */
export const INTRADAY_BACKSTOP_HM = '15:17';

/**
 * How long a just-opened leg is protected from being ghost-dropped by a
 * stale netQty===0 position poll — see isGhostDropProtected. Matches the
 * retired focus_tool_rows_worker.py's RECONCILE_GRACE_SECONDS.
 */
export const GHOST_DROP_GRACE_MS = 20_000;

// ── Fill ledger timestamps ────────────────────────────────────────────────────

/**
 * The next `ceOpenedTs`/`peOpenedTs` stamp for one leg, given its qty before
 * and after a fill-ledger adjustment. Pure and takes `now` as an argument (not
 * `Date.now()` internally) so callers — and tests — control the clock.
 *
 * Re-stamps only on the flat→held transition (`prevQty <= 0 && nextQty > 0`):
 * an add-on-top of an already-held leg keeps the original open time, and a
 * leg that's flat (`nextQty <= 0`) has no open time at all.
 */
export function nextOpenedTs(
  prevQty: number, nextQty: number, prevTs: number | null | undefined, now: number,
): number | null {
  if (nextQty <= 0) return null;
  if (prevQty <= 0) return now;
  return prevTs ?? now;
}

/**
 * Whether a leg this row believes it still owns (`pageOwn > 0`) should be
 * protected from a `netQty === 0` broker-poll ghost-drop right now.
 *
 * Kotak/Zerodha have no fill-confirmation socket, so a position poll can
 * still read the pre-fill (flat) book for a few seconds after a real order
 * goes through. Treating that read as "actually flat" zeroes a live short
 * out of the ledger and stops tracking it entirely — this is the guard that
 * refuses to, for GHOST_DROP_GRACE_MS after the leg was opened.
 */
export function isGhostDropProtected(
  pageOwn: number, openedTs: number | null | undefined, now: number,
  graceMs: number = GHOST_DROP_GRACE_MS,
): boolean {
  return pageOwn > 0 && openedTs != null && now - openedTs < graceMs;
}

// ── Sim (paper) rows ─────────────────────────────────────────────────────────

/**
 * Whether a row forward-tests on paper instead of trading real money.
 *
 * Only an explicit 'sim' counts. A row with no `mode` predates the field and
 * has always traded real money — reading it as sim would stop this page from
 * tracking a position that is genuinely open at the broker.
 */
export function isSimRow(row: Pick<FocusRow, 'mode'>): boolean {
  return row.mode === 'sim';
}

/**
 * The position-book row a sim leg would have, built from its paper ledger.
 *
 * Every exit rule, P&L calc and partial-exit chip reads `rowLive.cePosition`/
 * `pePosition`, so a sim row hands them this instead of a broker row and the
 * rules run unchanged. Always short — this tool only ever opens by selling.
 * `unrealizedProfit` is 0: the P&L code marks against the live tick whenever
 * one exists, so the snapshot value is only a fallback, and leaving it out
 * keeps the object stable across ticks.
 */
export function simLegPosition(
  leg: 'CE' | 'PE', qty: number, entry: number | null | undefined,
): PosRow | null {
  if (!(qty > 0)) return null;
  return {
    tradingSymbol: `SIM-${leg}`,
    securityId: '',
    exchangeSegment: '',
    productType: 'SIM',
    netQty: -qty,
    buyAvg: 0,
    sellAvg: Number(entry) || 0,
    realizedProfit: 0,
    unrealizedProfit: 0,
  };
}

// ── Position / row views ─────────────────────────────────────────────────────

/** One leg of a broker position book row, as this page reads it. */
export interface PosRow {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice?: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

/** Everything the rules need to judge one row. */
export interface RowLive {
  ceStrike: number | null;
  peStrike: number | null;
  ltpCe: number | null;
  ltpPe: number | null;
  cePosition: PosRow | null;
  pePosition: PosRow | null;
  /** Realised + unrealised across the legs this row's Side trades, apportioned
   *  to this row's share of a netted broker position. */
  pnl: number;
  /** Combined entry for those same legs: Σ (lots × entry), off each leg's avg. */
  entryPremium: number;
  /** Contracts per lot for this row's underlying — converts fill qty to lots
   *  for pair SL ×. 0 when unresolved. */
  lotSize: number;
  /** Session VWAP of the combined premium; null until fetched, or if VW is off. */
  vwap: number | null;
  /** Combined premium of the last CLOSED candle at the row's chosen VW
   *  interval — what the VW rule actually compares against VWAP, so a live
   *  tick spike can't trigger the exit on its own. Null until fetched, or if
   *  VW is off. */
  vwapClose: number | null;
  /** Display-only OI-buildup label ('LB'|'SB'|'SC'|'LU'|null) and OI change %
   *  per leg, straight off focus_tool_ws.py — the rule engine does not read
   *  these (no exit rule reacts to OI), so they carry no test-fixture weight
   *  in focusToolRules.cases.json. */
  ceBuildup: string | null;
  peBuildup: string | null;
  ceOiChgPct: number | null;
  peOiChgPct: number | null;
  /** Absolute open interest at the row's pinned/resolved CE and PE strikes
   *  (display-only; feeds the OI PCR chip next to premium Val PCR). */
  ceOi: number | null;
  peOi: number | null;
  /** Session VWAP of the combined premium at a FIXED 1-minute interval —
   *  shown under the LTP regardless of the row's own VW exit-rule setting.
   *  Independent of `vwap`/`vwapClose` above, which follow the row's own
   *  configured VW-rule interval and stay null unless `levelVw` is on. Null
   *  until fetched. */
  vwap1m: number | null;
  vwapClose1m: number | null;
  /** |Delta| × 100 of the row's CE / PE strike from the polled chain; null when the chain has none. */
  ceDelta?: number | null;
  peDelta?: number | null;
  /** The same strikes' |delta| × 100 as Dhan's chain reports it: the live side for legs whose entry delta is Dhan's (opened before the model delta). */
  ceDeltaDhan?: number | null;
  peDeltaDhan?: number | null;
}

export const EMPTY_ROW_LIVE: RowLive = {
  ceStrike: null, peStrike: null, ltpCe: null, ltpPe: null,
  cePosition: null, pePosition: null, pnl: 0, entryPremium: 0, lotSize: 0,
  vwap: null, vwapClose: null,
  ceBuildup: null, peBuildup: null, ceOiChgPct: null, peOiChgPct: null,
  ceOi: null, peOi: null, vwap1m: null, vwapClose1m: null,
};

// ── Legs ─────────────────────────────────────────────────────────────────────

/** Legs this row trades. `side` selects which; it is not a direction — this
 *  tool always opens with a SELL. */
export function legsOf(row: Pick<FocusRow, 'side'>): ('CE' | 'PE')[] {
  return row.side === 'BOTH' ? ['CE', 'PE'] : [row.side as 'CE' | 'PE'];
}

/** True once neither leg carries a broker quantity — safe to delete the row. */
export function legsFlat(live: RowLive): boolean {
  return Number(live.cePosition?.netQty ?? 0) === 0
    && Number(live.pePosition?.netQty ?? 0) === 0;
}

/**
 * Whether THIS row opened `leg` — fill ledger, or the worker's open pin.
 *
 * A coincidental broker position at the same strike (another row, another
 * strategy, a leftover from a previous session) is not ownership. Strike
 * config must stay editable on a draft ATM row that merely happens to resolve
 * onto someone else's 24150 PE; locking that selector (or rolling it with the
 * chevrons) would freeze or flatten a position this row never opened.
 */
export type WorkerHold = {
  open?: boolean;
  ceStrike?: number | null;
  peStrike?: number | null;
  /** Absolute contracts this worker still holds on each leg — used to qty-weight
   *  pair SL × when the page fill ledger is empty. */
  ceQty?: number;
  peQty?: number;
} | null | undefined;

export function rowOwnsLeg(
  row: Pick<FocusRow, 'fill'>,
  leg: 'CE' | 'PE',
  workerHold?: WorkerHold,
): boolean {
  const qty = leg === 'CE' ? Number(row.fill?.ceQty) || 0 : Number(row.fill?.peQty) || 0;
  if (qty > 0) return true;
  if (!workerHold?.open) return false;
  const strike = leg === 'CE' ? workerHold.ceStrike : workerHold.peStrike;
  return strike != null;
}

/**
 * True when this row owns neither leg — i.e. every broker position at its
 * resolved strikes belongs to something else (a manual trade, another row, a
 * running strategy). Replaces raw `legsFlat` wherever the real question is
 * "does THIS row hold anything," not "is the broker flat at this strike."
 */
export function rowFlat(row: Pick<FocusRow, 'fill'>, workerHold?: WorkerHold): boolean {
  return !rowOwnsLeg(row, 'CE', workerHold) && !rowOwnsLeg(row, 'PE', workerHold);
}

/**
 * Absolute contracts THIS row owns on a leg, for qty-weighting pair SL ×.
 *
 * Sums the page fill ledger and the worker ledger — NOT "whichever is
 * nonzero" — because the tab and the worker can each independently place
 * real opening orders against the same row (the worker enters/exits without
 * ever writing the page's fill; the tab can add lots without the worker
 * knowing), so a row's true ownership is often split across both. Picking
 * one and discarding the other under-counts real ownership and is exactly
 * how a page ledger has been observed drifting to look like an entire
 * shared-strike broker position — see the module's ownership skill.
 *
 * NEVER falls back to the broker net: a row whose own ledgers both read 0
 * owns 0 on this leg, even if the broker shows real quantity there — that
 * quantity belongs to another row, another strategy, or a manual trade
 * until this row's own ledger says otherwise.
 */
export function legOwnContracts(
  row: Pick<FocusRow, 'fill'>,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
): number {
  if (!rowOwnsLeg(row, leg, workerHold)) return 0;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const net = Math.abs(Number(pos?.netQty) || 0);
  if (net === 0) return 0;
  const pageOwn = Math.abs(Number(leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty) || 0);
  const workerOwn = Math.abs(Number(leg === 'CE' ? workerHold?.ceQty : workerHold?.peQty) || 0);
  return Math.min(pageOwn + workerOwn, net);
}

/**
 * Combined premium across only the legs this row's Side trades AND that are
 * still actually open: Σ (lots × LTP), where lots = ownContracts / lotSize.
 *
 * Example: CE 2 lots @ 40 + PE 4 lots @ 60 → 80 + 240 = 320. Pair SL × scales
 * that figure (320 × 1.2 = 384), not a per-unit average.
 *
 * A leg the Side names but that has already been closed — by a leg-wise stop, a
 * manual Exit, anything — must not keep contributing its market LTP: the pair
 * rules would then be measured against a phantom leg with no position behind
 * it, and would cross their threshold at the wrong number.
 */
export function sidePremium(
  row: Pick<FocusRow, 'side' | 'fill'>,
  live: RowLive,
  workerHold?: WorkerHold,
  lotSize?: number | null,
): number {
  const lot = Number(lotSize);
  if (!(lot > 0)) return 0;
  let num = 0;
  for (const leg of legsOf(row)) {
    const qty = legOwnContracts(row, leg, live, workerHold);
    if (qty <= 0) continue;
    num += ((leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0) * qty;
  }
  return num > 0 ? num / lot : 0;
}

/**
 * Combined entry premium across open owned legs: Σ (lots × entry).
 * Same scale as sidePremium — the baseline for pair SL ×.
 *
 * `qty` on each leg is absolute contracts (never lots); divided by lotSize.
 */
export function entryPremiumWeighted(
  legs: { premium: number; qty: number }[],
  lotSize?: number | null,
): number {
  const lot = Number(lotSize);
  if (!(lot > 0)) return 0;
  let num = 0;
  for (const { premium, qty } of legs) {
    const q = Math.abs(Number(qty) || 0);
    const p = Number(premium) || 0;
    if (q <= 0 || !(p > 0)) continue;
    num += p * q;
  }
  return num > 0 ? num / lot : 0;
}

/**
 * This leg's own SL × breach, or null.
 *
 * Independent of the pair's slMultiplier/slRupees, and independent of
 * `row.side` — a leftover position on a leg the row no longer trades still
 * deserves its own stop. Only fires while that leg actually holds something; a
 * flat leg has no premium to measure a multiple against.
 */
export function legStopReason(
  row: LegStopRow,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
  spot = 0,
): string | null {
  if (!rowOwnsLeg(row, leg, workerHold)) return null;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const qty = Number(pos?.netQty ?? 0);
  if (qty === 0) return null;
  // Short: hurt by this leg's own premium expanding (this tool only ever opens
  // with a SELL), or by the index moving against it. This row's own entry
  // first (legOwnEntry): re-entering a strike already traded today (RE-Cost
  // always does; RE-ASAP often lands back on the same ATM) would otherwise
  // measure the stop from a broker average that blends in the earlier, closed
  // trade on that security.
  const ltp = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  return legStopHit(legStopLevel(row, leg, live, ltp), leg, live, spot);
}

/**
 * The stop level in force on a leg this row owns and holds, or null. The one
 * call the exit watcher makes per leg per tick: it both persists `trailed` and
 * passes the same object to legStopHit, so the level is computed once.
 */
export function ownedLegStop(row: LegStopRow, leg: 'CE' | 'PE', live: RowLive, workerHold?: WorkerHold): LegStopLevel | null {
  if (!rowOwnsLeg(row, leg, workerHold)) return null;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  if (Number(pos?.netQty ?? 0) === 0) return null;
  return legStopLevel(row, leg, live, (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0);
}

/** Has this stop been hit? The breach reason, or null. Spot / delta / premium as the stop says. */
export function legStopHit(stop: LegStopLevel | null, leg: 'CE' | 'PE', live: RowLive, spot = 0): string | null {
  if (!stop) return null;
  const ltp = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  const now = stop.on === 'spot' ? spot : stop.on === 'delta' ? (legDeltaNow(leg, live, stop.deltaBasis) ?? 0) : ltp;
  if (!(now > 0)) return null;
  const hit = stop.dir === 'up' ? now >= stop.level : now <= stop.level;
  if (!hit) return null;
  if ((stop.kind === 'mult' || stop.kind === 'lazy') && !stop.trailed) {
    return `${leg} SL ×${stop.mult} hit (premium ${now.toFixed(2)} vs entry ${stop.entry.toFixed(2)})`;
  }
  return `${leg} ${stop.label} hit (${stop.on === 'spot' ? 'spot' : stop.on === 'delta' ? 'delta' : 'premium'} ${now.toFixed(2)} ${stop.dir === 'up' ? '≥' : '≤'} ${stop.level.toFixed(2)})`;
}

/** Which delta a leg's entry was recorded in: 'model' for fills opened with the model delta, 'dhan' for older ones (no marker). */
export type DeltaBasis = 'model' | 'dhan';

export function legDeltaBasis(fill: { ceDeltaModel?: boolean; peDeltaModel?: boolean } | null | undefined, leg: 'CE' | 'PE'): DeltaBasis {
  return (leg === 'CE' ? fill?.ceDeltaModel : fill?.peDeltaModel) ? 'model' : 'dhan';
}

/**
 * |Delta| × 100 of the leg's strike right now, or null when the chain carried none. `basis` must match the basis the leg's ENTRY
 * delta was recorded in (see `legDeltaBasis`), so a stop built from Dhan's entry delta is never compared with the model's live one.
 */
export function legDeltaNow(leg: 'CE' | 'PE', live: RowLive, basis: DeltaBasis = 'model'): number | null {
  const d = basis === 'dhan' ? (leg === 'CE' ? live.ceDeltaDhan : live.peDeltaDhan) : (leg === 'CE' ? live.ceDelta : live.peDelta);
  return d != null && Number.isFinite(d) && d > 0 ? d : null;
}

/** Dhan chain delta (−1..1, or 0 when it has none) → AlgoTest's absolute 0–100; null when missing. */
export function absDelta100(raw: unknown): number | null {
  const d = Math.abs(Number(raw));
  if (!Number.isFinite(d) || !(d > 0)) return null;
  return Math.round(d * 100 * 100) / 100;
}

/**
 * |Delta| × 100 from the central pricing recipe (forward rolled to the strike's own expiry, IV solved from the strike's premium),
 * so the delta a delta-strike / delta-SL / delta-target rule sees is the one every other page shows. Dhan's own chain delta is the
 * fallback ONLY when the model cannot price the strike (no spot yet, no premium and no IV): a delta stop must keep working rather
 * than silently drop back to SL ×.
 */
export function modelAbsDelta100(
  type: 'CE' | 'PE', strike: number, expiry: string, mark: number | null | undefined,
  chainIvPct: number | null | undefined, chainDelta: unknown,
  market: { spot: number; future?: FutureQuote | null },
  /** The strike's best bid/ask: a last price outside them (or a one-sided book) is not trusted to solve IV from (see trustedMark). */
  book?: { bid?: number | null; ask?: number | null },
): number | null {
  const g = greeksForLeg(
    { type, strike, expiry, mark: book ? trustedMark(mark, book.bid, book.ask) : mark, chainIv: chainIvPct && chainIvPct > 0 ? chainIvPct / 100 : null },
    market,
  );
  return g ? absDelta100(g.delta) ?? absDelta100(chainDelta) : absDelta100(chainDelta);
}

/** Row fields every leg-stop rule reads. */
export type LegStopRow = Pick<FocusRow, 'ceSlMultiplier' | 'peSlMultiplier' | 'fill' | 'lazyLegs'>
  & Partial<Pick<FocusRow, 'ceSlRule' | 'peSlRule' | 'ceTrailSl' | 'peTrailSl' | 'ceOrbSl' | 'peOrbSl'
    | 'ceRangeBreakout' | 'peRangeBreakout'>>;

export interface LegStopLevel {
  /** Which stop is in force. */
  kind: 'mult' | 'lazy' | 'pts' | 'uPts' | 'uPct' | 'delta' | 'orb';
  /** What the level is compared with: the leg's premium, the index spot, or its |delta| × 100. */
  on: 'premium' | 'spot' | 'delta';
  level: number;
  /** 'up' fires at now ≥ level, 'down' at now ≤ level. */
  dir: 'up' | 'down';
  /** The leg's own entry premium the stop was built from. */
  entry: number;
  /** SL × multiple, for kind 'mult' / 'lazy'. */
  mult?: number;
  /** Trail SL steps applied (0 = none). */
  trailed: number;
  /** Short human label, e.g. "SL 30 pts", "SL ×1.3 trailed 2×". */
  label: string;
  /** For a delta stop: the basis its entry delta was recorded in, so the live side is read in the same one. */
  deltaBasis?: DeltaBasis;
}

/** A leg's alternative SL basis, when it is switched on with a value. */
export function legSlRuleOn(rule: FocusLegSlRule | null | undefined): rule is FocusLegSlRule {
  return !!rule && rule.enabled && Number(rule.value) > 0
    && (rule.basis === 'pts' || rule.basis === 'uPts' || rule.basis === 'uPct' || rule.basis === 'delta');
}

/** The SL basis a running Lazy Leg uses, as a rule; null for its plain % stop (handled as SL ×). */
function lazySlRule(lazy: FocusLazyLeg): FocusLegSlRule | null {
  const b = lazy.slBasis ?? 'pct';
  if (b === 'pct') return null;
  const r: FocusLegSlRule = { enabled: true, basis: b, value: lazy.slPct };
  return legSlRuleOn(r) ? r : null;
}

/** A leg's Trail SL, when it is switched on with both amounts. */
export function legTrailOn(t: FocusLegTrailSl | null | undefined): t is FocusLegTrailSl {
  return !!t && t.enabled && Number(t.every) > 0 && Number(t.by) > 0;
}

/**
 * Trail SL steps the premium has earned: one per `every` it has fallen below
 * the entry (a short profits as the premium falls). Points, or % of the entry
 * price — the step stays fixed at what the % of the ENTRY is (AlgoTest: "20% -
 * 10%" on 200 is "40 - 20"). 0 when off or not in profit.
 */
export function legTrailSteps(t: FocusLegTrailSl | null | undefined, entry: number, ltp: number): number {
  if (!legTrailOn(t) || !(entry > 0) || !(ltp > 0)) return 0;
  // 'delta': entry / ltp are the leg's |delta| × 100 at entry and now.
  const every = t.unit === 'pct' ? entry * Number(t.every) / 100 : Number(t.every);
  if (!(every > 0)) return 0;
  return Math.max(0, Math.floor((entry - ltp) / every + 1e-9));
}

/** How far one Trail SL step moves the stop, in premium points. */
export function legTrailStepSize(t: FocusLegTrailSl, entry: number): number {
  return t.unit === 'pct' ? entry * Number(t.by) / 100 : Number(t.by);
}

/**
 * ORB Range stop distance: the range size (high − low) plus or minus `value`
 * points, or `value` % of the range. Range 50, "+ 20 points" → 70; "− 20 % of
 * range" → 40. Null when off, or the distance is not above zero.
 */
export function orbStopDistance(
  range: { high: number; low: number }, cfg: FocusLegOrbSl | null | undefined,
): number | null {
  if (!cfg?.enabled) return null;
  const size = Number(range.high) - Number(range.low);
  const v = Number(cfg.value) || 0;
  if (!(size >= 0) || v < 0) return null;
  const adj = cfg.unit === 'pctRange' ? size * v / 100 : v;
  const d = cfg.sign === '-' ? size - adj : size + adj;
  return d > 0 ? d : null;
}

/**
 * The stop level in force on a leg, or null when it has none. Priority: an ORB
 * Range stop (Range Breakout legs), a running Lazy Leg's SL %, the leg's other
 * SL basis (FocusLegSlRule), else its SL ×. A Trail SL lowers a PREMIUM stop by
 * one step per `every` the premium has fallen below entry — `ltp` counts too,
 * so a step earned on this very tick is not missed while the saved count
 * (fill.ceTrailSteps) catches up. Underlying stops fall back to SL × when the
 * spot at entry was never recorded (a leg opened before it was stamped).
 *
 * Display and the exit rule both read this, so they can never disagree.
 */
export function legStopLevel(row: LegStopRow, leg: 'CE' | 'PE', live: RowLive, ltp = 0): LegStopLevel | null {
  const entry = legOwnEntry(row, leg, live);
  const f = row.fill;
  const lazy = runningLazyLeg(row, leg);

  const orbCfg = leg === 'CE' ? row.ceOrbSl : row.peOrbSl;
  const orb = leg === 'CE' ? f?.ceOrb : f?.peOrb;
  if (!lazy && orb && orbCfg?.enabled) {
    const d = orbStopDistance(orb, orbCfg);
    if (d != null) return orbStopLevel(leg, orb, d, entry);
  }

  let base: LegStopLevel | null = null;
  // A running Lazy Leg's own SL type replaces the row's.
  const rule = lazy ? lazySlRule(lazy) : (leg === 'CE' ? row.ceSlRule : row.peSlRule);
  if (legSlRuleOn(rule)) {
    const v = Number(rule.value);
    if (rule.basis === 'pts') {
      if (entry > 0) base = { kind: 'pts', on: 'premium', level: entry + v, dir: 'up', entry, trailed: 0, label: `SL ${v} pts` };
    } else if (rule.basis === 'delta') {
      // AlgoTest Delta stop on a SELL: entry delta 25, SL 15 → exit at delta 40.
      const de = Number(leg === 'CE' ? f?.ceDeltaEntry : f?.peDeltaEntry) || 0;
      if (de > 0) {
        base = { kind: 'delta', on: 'delta', level: Math.min(100, de + v), dir: 'up', entry, trailed: 0, label: `SL ${v} delta`, deltaBasis: legDeltaBasis(f, leg) };
      }
    } else {
      const se = Number(leg === 'CE' ? f?.ceSpotEntry : f?.peSpotEntry) || 0;
      if (se > 0) {
        const move = rule.basis === 'uPct' ? se * v / 100 : v;
        // Short CE loses as the index rises, short PE as it falls.
        base = {
          kind: rule.basis, on: 'spot', level: leg === 'CE' ? se + move : se - move, dir: leg === 'CE' ? 'up' : 'down',
          entry, trailed: 0, label: `SL ${v}${rule.basis === 'uPct' ? '%' : ' pts'} on the index`,
        };
      }
    }
  }
  if (!base) {
    const mult = Number(legSlMultiplier(row, leg));
    if (!(mult > 1) || !(entry > 0)) return null;
    base = { kind: lazy ? 'lazy' : 'mult', on: 'premium', level: entry * mult, dir: 'up', entry, mult, trailed: 0, label: `SL ×${mult}` };
  }

  const trail = leg === 'CE' ? row.ceTrailSl : row.peTrailSl;
  if (!lazy && legTrailOn(trail)) {
    const saved = Number(leg === 'CE' ? f?.ceTrailSteps : f?.peTrailSteps) || 0;
    if (base.on === 'premium' && trail.unit !== 'delta') {
      const steps = Math.max(saved, legTrailSteps(trail, entry, ltp));
      if (steps > 0) {
        base = { ...base, level: base.level - steps * legTrailStepSize(trail, entry), trailed: steps, label: `${base.label} trailed ${steps}×` };
      }
    } else if (base.on === 'delta' && trail.unit === 'delta') {
      // AlgoTest (sell): entry delta 25, stop 40, trail 5-5 → delta 20 moves it to 35.
      const de = Number(leg === 'CE' ? f?.ceDeltaEntry : f?.peDeltaEntry) || 0;
      const steps = Math.max(saved, legTrailSteps(trail, de, legDeltaNow(leg, live, legDeltaBasis(f, leg)) ?? 0));
      if (steps > 0) {
        base = { ...base, level: base.level - steps * Number(trail.by), trailed: steps, label: `${base.label} trailed ${steps}×` };
      }
    }
  }
  return base;
}

/**
 * ORB Range stop, `d` away from the level the leg broke out at, against the
 * position. On the leg's own premium a short always loses as it rises. On the
 * index: a short CE loses as it rises, a short PE as it falls. (AlgoTest's only
 * example is a BUY CE on a high breakout, stop below the high; this is the
 * same rule — the stop sits on the losing side of the breakout level.)
 */
function orbStopLevel(leg: 'CE' | 'PE', orb: FocusOrbStamp, d: number, entry: number): LegStopLevel {
  const from = orb.side === 'low' ? orb.low : orb.high;
  const up = orb.on === 'instrument' || leg === 'CE';
  return {
    kind: 'orb', on: orb.on === 'underlying' ? 'spot' : 'premium', level: up ? from + d : from - d,
    dir: up ? 'up' : 'down', entry, trailed: 0,
    label: `ORB SL ${d.toFixed(2)} from the range ${orb.side}${orb.on === 'underlying' ? ' (index)' : ''}`,
  };
}

/**
 * The strike a leg is pinned to, or null when it should resolve live.
 *
 * Pinned PER LEG, only while this row still owns that leg. The pin used to be
 * row-wide — any open leg kept BOTH legs on their fill strikes — so after a
 * straddle's CE stopped out with PE still open, the closed CE stayed stuck on
 * its old strike (22750 with spot far away): a fresh CE (+ lots, or an auto
 * roll) would have been sold at that stale strike, and the CE strike selector
 * showed the old strike instead of the current ATM ± offset.
 */
export function legPinnedStrike(
  row: Pick<FocusRow, 'fill'>, leg: 'CE' | 'PE', workerHold?: WorkerHold,
): number | null {
  if (!rowOwnsLeg(row, leg, workerHold)) return null;
  const s = leg === 'CE' ? row.fill?.ceStrike : row.fill?.peStrike;
  return s ?? null;
}

/**
 * This row's own entry premium on a leg — the "cost" the SL-to-cost stop is
 * measured against.
 *
 * The row's own stamped entry first (fill.ceEntry/peEntry: LTP at order time,
 * blended across this row's adds, reset when the leg re-opens from flat). The
 * broker average is only the fallback: it blends in anyone else sharing the
 * strike, and Dhan's sellAvg is the DAY's average of every sell on that
 * security — re-selling a strike this row already traded and closed earlier
 * (a re-entry, or a roll back onto an old strike) would put "cost" at a blend
 * of the old and new trades.
 */
export function legOwnEntry(
  row: Pick<FocusRow, 'fill'>, leg: 'CE' | 'PE', live: RowLive,
): number {
  const stored = Number(leg === 'CE' ? row.fill?.ceEntry : row.fill?.peEntry) || 0;
  if (stored > 0) return stored;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const q = Number(pos?.netQty) || 0;
  return q < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
}

/** Does this leg carry a stop loss of its own (SL ×, another SL basis, or an ORB Range stop)? */
export function legHasOwnSl(row: LegStopRow, leg: 'CE' | 'PE'): boolean {
  if (Number(legSlMultiplier(row, leg)) > 1) return true;
  const lazy = runningLazyLeg(row, leg);
  if (lazy) return lazySlRule(lazy) != null;
  if (legSlRuleOn(leg === 'CE' ? row.ceSlRule : row.peSlRule)) return true;
  return !!(leg === 'CE' ? row.ceOrbSl : row.peOrbSl)?.enabled
    && !!(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout)?.enabled;
}

/**
 * Should a leg's SL hit move `other`'s stop to cost? AlgoTest "Trail SL to
 * Break-even price": 'sl' → only if `other` has an SL of its own, 'all' → any
 * open leg (the default).
 */
export function costStopApplies(
  row: Pick<FocusRow, 'slToCost' | 'slToCostScope'> & LegStopRow, other: 'CE' | 'PE',
): boolean {
  if (!row.slToCost) return false;
  return row.slToCostScope === 'sl' ? legHasOwnSl(row, other) : true;
}

/**
 * The SL-to-cost breach on a leg, or null.
 *
 * Only live once the sibling leg's own SL × has fired (fill.ceCostStop /
 * peCostStop) — arming it at entry would stop a fresh straddle out on its
 * first uptick. Short leg: exits when the premium climbs back to entry.
 */
export function costStopReason(
  row: Pick<FocusRow, 'fill' | 'slToCost'>, leg: 'CE' | 'PE', live: RowLive, workerHold?: WorkerHold,
): string | null {
  // Switching the option off disarms a flag that is already set, too.
  if (!row.slToCost) return null;
  const armed = leg === 'CE' ? row.fill?.ceCostStop : row.fill?.peCostStop;
  if (!armed) return null;
  if (legOwnContracts(row, leg, live, workerHold) <= 0) return null;
  const entry = legOwnEntry(row, leg, live);
  const now = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  if (entry > 0 && now > 0 && now >= entry) {
    return `${leg} SL to cost hit (premium ${now.toFixed(2)} vs entry ${entry.toFixed(2)})`;
  }
  return null;
}

/** Default cap on auto-rolls per leg per cycle when FocusRow.slRollMax is unset. */
export const DEFAULT_SL_ROLL_MAX = 2;

/** AlgoTest's cap on re-entries per leg, for the SL and for the target each. */
export const MAX_LEG_REENTRIES = 20;

/**
 * The strike to re-sell a stopped leg at: `strikes` steps further OTM than
 * the strike that was stopped — up for a CE, down for a PE.
 */
export function slRollStrike(leg: 'CE' | 'PE', stoppedStrike: number, strikes: number, step: number): number {
  const n = Math.max(0, Math.trunc(Number(strikes) || 0));
  return leg === 'CE' ? stoppedStrike + n * step : stoppedStrike - n * step;
}

export interface ReentryContext {
  /** Wall-clock 'HH:MM' IST — when the stop/target hit, or now for a waiting re-entry. */
  nowHm: string;
  product: 'INTRADAY' | 'MARGIN';
  groupEnabled: boolean;
  /** Re-entries of this trigger already taken on this leg this cycle. */
  done: number;
}

/** The re-entry settings that apply to one trigger, with legacy fallbacks. */
export function reentryConfig(
  row: Pick<FocusRow, 'reSlMode' | 'reSlMax' | 'reTgtMode' | 'reTgtMax' | 'slRollStrikes' | 'slRollMax'>,
  trigger: FocusReentryTrigger,
): { mode: FocusReentryMode; max: number; otmStrikes: number } {
  const otmStrikes = Math.max(1, Math.trunc(Number(row.slRollStrikes) || 0));
  if (trigger === 'sl') {
    // Rows saved before re-entry modes existed only had the OTM roll.
    const mode = row.reSlMode ?? (Number(row.slRollStrikes) > 0 ? 'otm' : 'off');
    const max = row.reSlMax ?? row.slRollMax ?? DEFAULT_SL_ROLL_MAX;
    return { mode, max: Math.trunc(Number(max) || 0), otmStrikes };
  }
  const max = row.reTgtMax ?? DEFAULT_SL_ROLL_MAX;
  return { mode: row.reTgtMode ?? 'off', max: Math.trunc(Number(max) || 0), otmStrikes };
}

/**
 * The time gates every re-entry shares — at trigger time and again while a
 * cost / momentum re-entry waits. Null = still inside the window.
 *
 * Never re-open into a window that has closed: the row's own exit time, the
 * 15:17 intraday backstop, "No re-entry after", or a stopped index.
 */
export function reentryWindowClosed(
  row: Pick<FocusRow, 'exitTime' | 'noReEntryAfter'> & Partial<Pick<FocusRow, 'stopMonitoringAfter'>>,
  ctx: Pick<ReentryContext, 'nowHm' | 'product' | 'groupEnabled'>,
  /**
   * True for a cost / momentum / range re-entry that is already WAITING. AlgoTest
   * "No Re-entry After" only looks at when the stop / target hit: one that hit
   * at 12:20 with a 13:00 cutoff still re-enters when its price comes back at
   * 13:20. So a waiting re-entry ignores the cutoff; everything else still applies.
   */
  waiting = false,
): string | null {
  if (!ctx.groupEnabled) return 'index not started';
  if (monitoringStopped(row, ctx.nowHm)) return `monitoring stopped at ${row.stopMonitoringAfter}`;
  if (!waiting && row.noReEntryAfter && ctx.nowHm >= row.noReEntryAfter) {
    return `no re-entry after ${row.noReEntryAfter}`;
  }
  if (row.exitTime && ctx.nowHm >= row.exitTime) return `past its own exit time ${row.exitTime}`;
  if (ctx.product === 'INTRADAY' && ctx.nowHm >= INTRADAY_BACKSTOP_HM) return 'past 15:17 intraday cutoff';
  return null;
}

/**
 * AlgoTest "Stop Monitoring After": past this 'HH:MM' the row runs no rule at
 * all — no entry, re-entry, stop, target or trail — and an open position is
 * left to the exit time. Blank / malformed = never.
 */
export function monitoringStopped(
  row: Partial<Pick<FocusRow, 'stopMonitoringAfter'>>, nowHm: string,
): boolean {
  const t = row.stopMonitoringAfter;
  return !!t && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) && nowHm >= t;
}

/**
 * How RE MOMENTUM re-enters a leg (AlgoTest):
 *  - 'combined' — Overall Momentum is on: Simple Momentum and Range Breakout are
 *    disabled, and a momentum re-entry re-checks the COMBINED premium instead;
 *  - 'range'    — the leg has Range Breakout: a new range of the same length;
 *  - 'simple'   — the leg's own Simple Momentum, from the new strike;
 *  - 'asap'     — none of those: "behaves exactly like RE ASAP" (glossary).
 */
export function momentumReentryKind(
  row: Pick<FocusRow, 'entryTime' | 'entryMomEnabled' | 'entryMomValue' | 'ceSimpleMom' | 'peSimpleMom' | 'ceRangeBreakout' | 'peRangeBreakout'>,
  leg: 'CE' | 'PE',
): 'combined' | 'range' | 'simple' | 'asap' {
  if (entryMomentumOn(row)) return 'combined';
  if (rangeBreakoutOn(leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout, row.entryTime)) return 'range';
  return simpleMomOn(leg === 'CE' ? row.ceSimpleMom : row.peSimpleMom) ? 'simple' : 'asap';
}

/**
 * Should a leg that a stop/target just closed be re-entered, and how?
 * Refuses when the mode is off, the per-cycle cap is used up, or the window
 * has closed (see reentryWindowClosed).
 */
export function evaluateReentry(
  row: Pick<FocusRow, 'reSlMode' | 'reSlMax' | 'reTgtMode' | 'reTgtMax' | 'slRollStrikes' | 'slRollMax'
    | 'exitTime' | 'noReEntryAfter'>,
  trigger: FocusReentryTrigger,
  ctx: ReentryContext,
): EntryDecision & { mode: FocusReentryMode } {
  const { mode, max } = reentryConfig(row, trigger);
  const what = trigger === 'sl' ? 'SL' : 'target';
  if (mode === 'off') return { enter: false, mode, reason: `re-entry on ${what} off` };
  if (ctx.done >= max) return { enter: false, mode, reason: `re-entry limit ${max} on ${what} reached` };
  const closed = reentryWindowClosed(row, ctx);
  if (closed) return { enter: false, mode, reason: closed };
  return { enter: true, mode, reason: `re-entry ${mode} after ${what}` };
}

/**
 * How long a momentum re-entry may wait for its new strike's first premium.
 * The strike is picked when the leg closes, often a strike the quote feed
 * was not carrying yet; without a premium there is no reference to measure
 * the move from. Past this it is cancelled rather than measured from a
 * premium seen long after the stop/target.
 */
export const MOMENTUM_QUOTE_WAIT_MS = 15_000;

/** A momentum re-entry armed before its strike had a premium (price 0). */
export function awaitingMomentumQuote(p: Pick<FocusPendingReentry, 'mode' | 'price'>): boolean {
  return p.mode === 'momentum' && !(p.price > 0);
}

/** Has a waiting cost / momentum re-entry's price been reached? */
export function pendingReentryHit(p: Pick<FocusPendingReentry, 'price' | 'dir'>, ltp: number): boolean {
  if (!(ltp > 0) || !(p.price > 0)) return false;
  return p.dir === 'down' ? ltp <= p.price : ltp >= p.price;
}

/**
 * The entry RE-Cost waits for: the recorded basis while the closed strike is
 * the one it was recorded on, else (first cost re-entry on this strike this
 * cycle) the closed leg's own entry. Null when neither is known.
 */
export function costReentryBasis(
  basis: { strike: number; price: number } | null | undefined,
  closedStrike: number,
  closedEntry: number,
): { strike: number; price: number } | null {
  if (basis && basis.strike === closedStrike && basis.price > 0) return basis;
  return closedEntry > 0 ? { strike: closedStrike, price: closedEntry } : null;
}

/**
 * The trigger level for a waiting re-entry.
 *
 * cost: the leg's initial entry (costReentryBasis). After an SL (premium ran UP through the
 * stop) it waits for the premium to fall back to entry; after a target (it
 * decayed DOWN) it waits for it to climb back to entry.
 *
 * momentum: the start (new strike's premium, or spot) moved by the leg's Simple Momentum.
 *
 * Null when there is nothing sane to wait for (no entry, no quote, no points).
 */
export function pendingReentryLevel(
  mode: 'cost' | 'momentum',
  trigger: FocusReentryTrigger,
  ref: { entry?: number; start?: number; simple?: FocusLegSimpleMom | null },
): { price: number; dir: 'down' | 'up' } | null {
  if (mode === 'cost') {
    const e = Number(ref.entry) || 0;
    if (!(e > 0)) return null;
    return { price: e, dir: trigger === 'sl' ? 'down' : 'up' };
  }
  // momentum: the leg's own Simple Momentum, measured from `start` (the new
  // strike's premium, or the spot when the setting is on the underlying).
  const price = simpleMomLevel(ref.simple, Number(ref.start) || 0);
  return price != null && ref.simple ? { price, dir: ref.simple.dir } : null;
}

/**
 * The premium a leg target fires at: entry × (1 − v/100) in '%' mode, or
 * entry − v in 'pts' mode. Null when off (blank / 0), when there is no entry,
 * or when the target would need the premium at or below zero (% ≥ 100, or
 * points ≥ entry). Shared by legTargetReason and the level display.
 */
export function legTargetLevel(
  entry: number, value: string | number | undefined, unit: FocusRow['legTgtUnit'],
): number | null {
  const v = Number(value);
  if (!(v > 0) || !(entry > 0)) return null;
  if (unit === 'uPts' || unit === 'uPct' || unit === 'delta') return null;   // index / delta — not a premium level
  const level = unit === 'pts' ? entry - v : entry * (1 - v / 100);
  return level > 0 ? level : null;
}

/**
 * AlgoTest Underlying Points / Underlying % target: the index level a short leg
 * takes profit at — the spot at entry moved `value` points / % in its favour
 * (short CE: down; short PE: up). Null when the unit is not on the index, the
 * value is off, or the spot at entry is unknown.
 */
export function legTargetSpotLevel(
  leg: 'CE' | 'PE', spotEntry: number | null | undefined, value: string | number | undefined, unit: FocusRow['legTgtUnit'],
): number | null {
  const v = Number(value);
  const se = Number(spotEntry) || 0;
  if (!(v > 0) || !(se > 0) || (unit !== 'uPts' && unit !== 'uPct')) return null;
  const move = unit === 'uPct' ? se * v / 100 : v;
  return leg === 'CE' ? se - move : se + move;
}

/** Short label for a leg target unit. */
export function legTgtUnitLabel(unit: FocusRow['legTgtUnit']): string {
  return unit === 'pts' ? 'pts' : unit === 'uPts' ? 'idx pts' : unit === 'uPct' ? 'idx %' : unit === 'delta' ? 'Δ' : '%';
}

/** AlgoTest Delta target on a SELL: entry delta 25, target 15 → exit at delta 10. Null when off or unknown. */
export function legTargetDeltaLevel(deltaEntry: number | null | undefined, value: string | number | undefined): number | null {
  const v = Number(value);
  const de = Number(deltaEntry) || 0;
  if (!(v > 0) || !(de > 0)) return null;
  const lvl = de - v;
  return lvl > 0 ? lvl : null;
}

/**
 * This leg's own target breach, or null: premium decayed to legTargetLevel,
 * entry being this row's own (legOwnEntry) — or, on the Underlying units, the
 * index reached legTargetSpotLevel. Only while this row owns an open leg.
 */
export function legTargetReason(
  row: Pick<FocusRow, 'ceTgtPct' | 'peTgtPct' | 'legTgtUnit' | 'fill' | 'lazyLegs'>,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
  spot = 0,
): string | null {
  if (legOwnContracts(row, leg, live, workerHold) <= 0) return null;
  const { value, unit } = legTarget(row, leg);
  if (unit === 'delta') {
    const lvl = legTargetDeltaLevel(leg === 'CE' ? row.fill?.ceDeltaEntry : row.fill?.peDeltaEntry, value);
    const d = legDeltaNow(leg, live, legDeltaBasis(row.fill, leg));
    if (lvl == null || d == null) return null;
    return d <= lvl ? `${leg} target ${Number(value)} delta hit (delta ${d.toFixed(2)} ≤ ${lvl.toFixed(2)})` : null;
  }
  if (unit === 'uPts' || unit === 'uPct') {
    const lvl = legTargetSpotLevel(leg, leg === 'CE' ? row.fill?.ceSpotEntry : row.fill?.peSpotEntry, value, unit);
    if (lvl == null || !(spot > 0)) return null;
    const hit = leg === 'CE' ? spot <= lvl : spot >= lvl;
    return hit
      ? `${leg} target ${Number(value)}${unit === 'uPct' ? '%' : ' pts'} on the index hit (spot ${spot.toFixed(2)} ${leg === 'CE' ? '≤' : '≥'} ${lvl.toFixed(2)})`
      : null;
  }
  const entry = legOwnEntry(row, leg, live);
  const level = legTargetLevel(entry, value, unit);
  if (level == null) return null;
  const now = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  if (now > 0 && now <= level) {
    const what = unit === 'pts' ? `${Number(value)} pts` : `${Number(value)}%`;
    return `${leg} target ${what} hit (premium ${now.toFixed(2)} ≤ ${level.toFixed(2)}, entry ${entry.toFixed(2)})`;
  }
  return null;
}

/**
 * Premium level a stop-multiple fires at: entry × multiplier.
 * Null when the multiple is off (blank / ≤1) or there is no entry to scale.
 * Display-only — evaluateRowExit / legStopReason remain the authority on
 * whether a stop actually fires.
 */
export function stopPremium(
  entry: number,
  multiplier: string | number | null | undefined,
): number | null {
  const m = Number(multiplier);
  const e = Number(entry);
  if (!(m > 1) || !(e > 0) || !Number.isFinite(m) || !Number.isFinite(e)) return null;
  return e * m;
}

/** Flat-row preview: row.lots on each named leg × live LTP, summed. */
function previewCombinedPremium(
  row: Pick<FocusRow, 'side' | 'lots'>,
  live: RowLive,
): number {
  const lots = Number(row.lots) || 0;
  if (!(lots > 0)) return 0;
  let sum = 0;
  for (const leg of legsOf(row)) {
    sum += (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  }
  return sum * lots;
}

/** This leg's SL × level. Uses sell/buy avg while owned and open, else live LTP (preview). */
export function legStopPremium(
  row: LegStopRow,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
): number | null {
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const qty = Number(pos?.netQty ?? 0);
  const ltp = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  const owned = rowOwnsLeg(row, leg, workerHold) && qty !== 0;
  // While held: the same level legStopReason fires on — display must not
  // disagree with it. A stop on the index is not a premium; null here.
  if (owned) {
    const s = legStopLevel(row, leg, live, ltp);
    return s && s.on === 'premium' ? s.level : null;
  }
  return stopPremium(ltp, legSlMultiplier(row, leg));
}

/** Pair SL × level. Uses combined (lots × premium) entry while open, else preview. */
export function pairStopPremium(
  row: Pick<FocusRow, 'slMultiplier' | 'side' | 'fill' | 'lots'>,
  live: RowLive,
  workerHold?: WorkerHold,
  lotSize?: number | null,
): number | null {
  let entry = live.entryPremium;
  if (!(entry > 0)) {
    // Recompute from live legs when entryPremium has not been stamped yet.
    const legs: { premium: number; qty: number }[] = [];
    for (const leg of legsOf(row)) {
      const qty = legOwnContracts(row, leg, live, workerHold);
      const pos = leg === 'CE' ? live.cePosition : live.pePosition;
      const q = Number(pos?.netQty) || 0;
      const avg = q < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
      if (qty > 0 && avg > 0) legs.push({ premium: avg, qty });
    }
    entry = entryPremiumWeighted(legs, lotSize);
  }
  if (!(entry > 0)) entry = previewCombinedPremium(row, live);
  return stopPremium(entry, row.slMultiplier);
}

// ── DTE ──────────────────────────────────────────────────────────────────────

/**
 * Whole calendar days from `today` to `expiry`, both 'YYYY-MM-DD'. 0 means
 * expiry is today, negative means lapsed, null means unparseable.
 *
 * Compared as UTC midnights so a timezone-offset host cannot shift the count
 * by a day.
 */
export function dteForExpiry(expiry: string, today: string): number | null {
  if (!expiry || !today) return null;
  const ms = Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Does a resolved DTE satisfy the row's DTE chip? */
export function dteMatches(filter: FocusDte, dte: number | null): boolean {
  if (filter === 'Any') return true;
  if (dte == null) return false;
  if (filter === '0') return dte === 0;
  if (filter === '1') return dte === 1;
  return dte === 0 || dte === 1;   // '0+1'
}

// ── Exit ─────────────────────────────────────────────────────────────────────

/**
 * The first level-exit rule this row breaches, or null.
 *
 * Checked in this order — H↑, L↓, VW, SL ₹, SL × — matching evaluate_exit in
 * focus_tool_rows_worker.py. Order matters because the reason is what gets
 * logged and shown, and a row breaching two rules on one tick should report the
 * more fundamental one.
 *
 * Every spot-derived rule is suppressed when `spot <= 0`. A failed quote read
 * arrives as 0, and 0 is below every conceivable L↓ — treating that as a breach
 * would flatten the whole book on one dropped tick. Premium-driven rules are
 * likewise suppressed at 0.
 *
 * Does NOT cover the group's Book Exit, the row's exit time or the 15:17 bell:
 * those are clock- and aggregate-driven and live in the scheduler, which keeps
 * firing even when no tick arrives.
 */
export function evaluateRowExit(
  row: FocusRow,
  live: RowLive,
  spot: number,
  workerHold?: WorkerHold,
  lotSize?: number | null,
): string | null {
  const hi = Number(row.levelHigh);
  if (row.levelHigh && Number.isFinite(hi) && spot > 0 && spot >= hi) {
    return `H↑ breached: spot ${spot.toFixed(2)} ≥ ${hi}`;
  }
  const lo = Number(row.levelLow);
  if (row.levelLow && Number.isFinite(lo) && spot > 0 && spot <= lo) {
    return `L↓ breached: spot ${spot.toFixed(2)} ≤ ${lo}`;
  }

  // Combined (lots × premium) of only the legs this row's Side trades AND
  // actually owns. `entryPremium` is restricted the same way, so a CE-only
  // row never compares a CE entry against a CE+PE current figure, and a leg
  // this row doesn't own never contributes either.
  const nowPremium = sidePremium(row, live, workerHold, lotSize);

  if (row.levelVw && live.vwapClose != null && live.vwapClose > 0 && live.vwap != null && live.vwap > 0) {
    // Checked against the last CLOSED candle's premium, not the live tick —
    // a spurious wick shouldn't fire a real exit. bufferPct additionally
    // requires the close to clear VWAP by more than a % margin before it
    // counts as a breach; blank/0 means no buffer. This tool only ever opens
    // with a SELL — hurt by the premium expanding past VWAP, same as
    // slMultiplier below.
    const bufferPct = Number(row.vwapBufferPct) || 0;
    const threshold = live.vwap * (1 + bufferPct / 100);
    if (live.vwapClose >= threshold) {
      return `VW breached: closed premium ${live.vwapClose.toFixed(2)} ≥ VWAP+buffer ${threshold.toFixed(2)}`;
    }
  }

  // MTM limits scale with the Quantity Multiplier (AlgoTest execution setting).
  const slRs = Number(row.slRupees) * rowQtyMultiplier(row);
  if (row.slRupees && Number.isFinite(slRs) && slRs > 0 && live.pnl <= -slRs) {
    return `SL ₹${slRs} hit (P&L ₹${live.pnl.toFixed(0)})`;
  }

  const slMult = Number(row.slMultiplier);
  if (row.slMultiplier && Number.isFinite(slMult) && slMult > 1) {
    const entry = live.entryPremium;
    if (entry > 0 && nowPremium > 0 && nowPremium >= entry * slMult) {
      return `SL ×${slMult} hit (premium ${nowPremium.toFixed(2)} vs entry ${entry.toFixed(2)})`;
    }
  }
  return null;
}

// ── Entry ────────────────────────────────────────────────────────────────────

export interface EntryContext {
  /** Wall-clock 'HH:MM' IST. */
  nowHm: string;
  /** The index group's Start control. */
  groupEnabled: boolean;
  product: 'INTRADAY' | 'MARGIN';
  /** Resolved DTE of the expiry this row would trade; null when unknown. */
  dte: number | null;
  /** At least one leg's strike has resolved. */
  strikesReady: boolean;
  /** The row currently holds nothing. */
  flat: boolean;
}

export interface EntryDecision { enter: boolean; reason: string }

/**
 * Should an armed row open now?
 *
 * A draft row never enters — that is the whole point of Arm, and it is the one
 * invariant worth restating: an unfinished row on screen must not be able to
 * place an order.
 *
 * The order of these checks is part of the contract, not an implementation
 * detail: `reason` is what gets logged and shown, and the Python side reports
 * the same reason for the same row.
 */
export function evaluateEntry(
  row: Pick<FocusRow, 'status' | 'lots' | 'dte' | 'entryTime' | 'exitTime'>,
  ctx: EntryContext,
): EntryDecision {
  if (!ctx.groupEnabled) return { enter: false, reason: 'index not started' };
  if (row.status !== ('armed' as FocusRowStatus)) return { enter: false, reason: `status ${row.status}` };
  if (!(Number(row.lots) > 0)) return { enter: false, reason: 'lots must be > 0' };
  if (!ctx.flat) return { enter: false, reason: 'already holds a position' };
  if (!ctx.strikesReady) return { enter: false, reason: 'strikes unresolved' };
  if (!dteMatches(row.dte, ctx.dte)) return { enter: false, reason: `DTE ${ctx.dte} != ${row.dte}` };

  if (!row.entryTime) return { enter: false, reason: 'no entry time' };
  if (ctx.nowHm < row.entryTime) return { enter: false, reason: `waiting for ${row.entryTime}` };

  // Never open into a window that has already closed — a row armed after its
  // own exit time (or after the bell) would be flattened on the next tick, for
  // nothing but two lots of slippage.
  if (row.exitTime && ctx.nowHm >= row.exitTime) {
    return { enter: false, reason: `past its own exit time ${row.exitTime}` };
  }
  if (ctx.product === 'INTRADAY' && ctx.nowHm >= INTRADAY_BACKSTOP_HM) {
    return { enter: false, reason: 'past 15:17 intraday cutoff' };
  }
  return { enter: true, reason: `entry time ${row.entryTime} reached` };
}

// ── Overall Momentum (entry gate) ───────────────────────────────────────────

/**
 * The level a momentum move releases at: `start` ± v points, or ± v % of
 * `start` (200, 10 → 210 / 190 in points; 220 / 180 in percent).
 */
export function momentumTrigger(start: number, dir: 'up' | 'down', unit: 'pts' | 'pct', v: number): number {
  const move = unit === 'pct' ? start * v / 100 : v;
  return dir === 'up' ? start + move : start - move;
}

export interface EntryMomentumDecision {
  /** True when the gate is off, or the combined premium has moved enough. */
  ready: boolean;
  /** Start premium to remember for the next tick (null until one is seen). */
  ref: number | null;
  /** Premium that releases the entry; null while there is no start premium or the gate is off. */
  trigger: number | null;
  reason: string;
}

export function entryMomentumOn(row: Pick<FocusRow, 'entryMomEnabled' | 'entryMomValue'>): boolean {
  return !!row.entryMomEnabled && Number(row.entryMomValue) > 0;
}

/**
 * AlgoTest "Overall Momentum": enter only once the combined premium has moved
 * `value` points / % from the start premium. Up releases at ref + move, down at
 * ref − move (200 ±10 pts → 210 / 190; ±10% → 220 / 180).
 *
 * `ref` is the start premium (first valid live premium once the entry time was
 * reached); pass null before it is known and keep the returned `ref`.
 * `premium` is what the row's evaluation mode watches (live or last closed
 * candle); null/0 = no quote yet, so wait.
 */
export function evaluateEntryMomentum(
  row: Pick<FocusRow, 'entryMomEnabled' | 'entryMomValue' | 'entryMomDir' | 'entryMomUnit'>,
  ref: number | null,
  premium: number | null,
  liveNow: number | null = premium,
): EntryMomentumDecision {
  if (!entryMomentumOn(row)) return { ready: true, ref, trigger: null, reason: '' };
  const v = Number(row.entryMomValue);
  let start = ref;
  if (!(start != null && start > 0)) {
    start = liveNow != null && liveNow > 0 ? liveNow : null;
    if (start == null) return { ready: false, ref: null, trigger: null, reason: 'momentum: waiting for a start premium' };
  }
  const up = row.entryMomDir !== 'down';
  const trigger = momentumTrigger(start, up ? 'up' : 'down', row.entryMomUnit === 'pct' ? 'pct' : 'pts', v);
  const unit = row.entryMomUnit === 'pct' ? `${v}%` : `${v} pts`;
  if (!(premium != null && premium > 0)) {
    return { ready: false, ref: start, trigger, reason: `momentum: waiting for a premium (start ${start.toFixed(2)})` };
  }
  const hit = up ? premium >= trigger : premium <= trigger;
  return hit
    ? { ready: true, ref: start, trigger, reason: `combined premium ${premium.toFixed(2)} ${up ? '≥' : '≤'} ${trigger.toFixed(2)} (${up ? '+' : '−'}${unit} from ${start.toFixed(2)})` }
    : { ready: false, ref: start, trigger, reason: `momentum: premium ${premium.toFixed(2)}, needs ${up ? '≥' : '≤'} ${trigger.toFixed(2)} (${up ? '+' : '−'}${unit} from ${start.toFixed(2)})` };
}


// ── Simple Momentum (per-leg entry gate) ────────────────────────────────────

export function simpleMomOn(m: FocusLegSimpleMom | null | undefined): m is FocusLegSimpleMom {
  return !!m && m.enabled && Number(m.value) > 0;
}

/**
 * Where a leg's Simple Momentum releases, from the `start` value (this leg's
 * premium or the spot, depending on `m.src`) seen at the entry time. Null when
 * off, there is no start, or a down move would reach zero or below.
 */
export function simpleMomLevel(m: FocusLegSimpleMom | null | undefined, start: number): number | null {
  if (!simpleMomOn(m) || !(start > 0)) return null;
  const level = momentumTrigger(start, m.dir, m.unit, Number(m.value));
  return level > 0 ? level : null;
}

/** Has `now` (premium or spot, matching `m.src`) reached the level? */
export function simpleMomHit(m: FocusLegSimpleMom | null | undefined, start: number, now: number): boolean {
  const level = simpleMomLevel(m, start);
  if (level == null || !(now > 0)) return false;
  return m!.dir === 'down' ? now <= level : now >= level;
}

// ── Range Breakout (per-leg entry gate) ─────────────────────────────────────

const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** On, and its range is valid: an 'HH:MM' end strictly after the row's entry time (intraday). */
export function rangeBreakoutOn(
  rb: FocusLegRangeBreakout | null | undefined, entryTime: string,
): rb is FocusLegRangeBreakout {
  if (!rb || !rb.enabled || !HM_RE.test(rb.end) || !HM_RE.test(entryTime)) return false;
  const kind = rb.kind ?? 'intraday';
  // BTST ends on the next trading day, so its End may be before the entry time.
  if (kind === 'btst') return true;
  if (kind === 'positional') {
    const sd = Math.trunc(Number(rb.startDte));
    const ed = Math.trunc(Number(rb.endDte));
    return sd >= 0 && ed >= 0 && ed <= sd && (sd > ed || rb.end > entryTime);
  }
  return rb.end > entryTime;
}

/** AlgoTest's allowed windows: Entry Time 09:16–15:28, Exit Time 09:17–15:29. */
export const ENTRY_TIME_MIN = '09:16';
export const ENTRY_TIME_MAX = '15:28';
export const EXIT_TIME_MIN = '09:17';
export const EXIT_TIME_MAX = '15:29';

/** Clamp an 'HH:MM' into [min, max]; anything malformed is returned as is (the time input already guards the format). */
export function clampHm(hm: string, min: string, max: string): string {
  if (!HM_RE.test(hm)) return hm;
  return hm < min ? min : hm > max ? max : hm;
}

/** 'HH:MM' plus `minutes`, as 'HH:MM' — null when malformed or it would pass midnight. */
export function addMinutesHm(hm: string, minutes: number): string | null {
  if (!HM_RE.test(hm) || !Number.isFinite(minutes)) return null;
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) + Math.trunc(minutes);
  if (t < 0 || t >= 24 * 60) return null;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Has `price` reached the range's high ('high') or low ('low')? AlgoTest: after
 * the range, "whenever the strike reaches" that level the leg is taken — a touch
 * counts, and so does a price already beyond it when the range ends.
 */
export function rangeBreakoutHit(
  rb: Pick<FocusLegRangeBreakout, 'side'>, range: { high: number; low: number }, price: number,
): boolean {
  if (!(price > 0)) return false;
  return rb.side === 'low' ? price <= range.low : price >= range.high;
}

/**
 * The new range a Range Breakout leg tracks after its SL / target closed it
 * (AlgoTest RE MOMENTUM with Range Breakout): the same length as the original
 * (entry time → End), starting now — 09:20–10:20 closed at 10:45 gives
 * 10:45–11:45. Null if the original range is invalid or the new one would run
 * past midnight.
 */
export function reRangeWindow(
  entryTime: string, end: string, nowHm: string,
): { start: string; end: string } | null {
  if (!HM_RE.test(entryTime) || !HM_RE.test(end) || !HM_RE.test(nowHm) || end <= entryTime) return null;
  const min = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
  const newEnd = addMinutesHm(nowHm, min(end) - min(entryTime));
  return newEnd ? { start: nowHm, end: newEnd } : null;
}

// ── Lazy legs ───────────────────────────────────────────────────────────────

/** The Lazy Leg running in a leg slot right now (only while the row owns that leg). */
/** Most Lazy Legs one row can define (AlgoTest's limit). */
export const MAX_LAZY_LEGS = 10;

export function runningLazyLeg(
  row: Pick<FocusRow, 'fill' | 'lazyLegs'>, leg: 'CE' | 'PE',
): FocusLazyLeg | null {
  if (!rowOwnsLeg(row, leg)) return null;
  const id = leg === 'CE' ? row.fill?.ceLazyId : row.fill?.peLazyId;
  return id ? (row.lazyLegs ?? []).find(l => l.id === id) ?? null : null;
}

/** SL multiple in force on a leg: the running Lazy Leg's (1 + SL %), else the row's. */
export function legSlMultiplier(
  row: Pick<FocusRow, 'ceSlMultiplier' | 'peSlMultiplier' | 'fill' | 'lazyLegs'>, leg: 'CE' | 'PE',
): string | number | undefined {
  const lazy = runningLazyLeg(row, leg);
  if (lazy) return (lazy.slBasis ?? 'pct') === 'pct' && Number(lazy.slPct) > 0 ? 1 + Number(lazy.slPct) / 100 : undefined;
  return leg === 'CE' ? row.ceSlMultiplier : row.peSlMultiplier;
}

/** Target in force on a leg: the running Lazy Leg's (always %), else the row's. */
export function legTarget(
  row: Pick<FocusRow, 'ceTgtPct' | 'peTgtPct' | 'legTgtUnit' | 'fill' | 'lazyLegs'>, leg: 'CE' | 'PE',
): { value: string | undefined; unit: FocusRow['legTgtUnit'] } {
  const lazy = runningLazyLeg(row, leg);
  if (lazy) return { value: lazy.tgtPct, unit: lazy.tgtUnit ?? 'pct' };
  return { value: leg === 'CE' ? row.ceTgtPct : row.peTgtPct, unit: row.legTgtUnit };
}

/**
 * Which Lazy Leg should open after a leg's SL / target closed it, or null.
 * `closedLazyId` is the Lazy Leg that was running in the slot (captured
 * before the close): a lazy leg chains through its own onSl / onTgt. A root leg
 * uses the row's "Re-entry on SL / Tgt: Lazy Leg" pick. Null for an id that no
 * longer exists.
 */
export function nextLazyLegId(
  row: Pick<FocusRow, 'lazyLegs' | 'reSlMode' | 'reTgtMode' | 'reSlLazyId' | 'reTgtLazyId'>,
  closedLazyId: string | null | undefined,
  trigger: FocusReentryTrigger,
): string | null {
  const legs = row.lazyLegs ?? [];
  let id = '';
  if (closedLazyId) {
    const cur = legs.find(l => l.id === closedLazyId);
    id = (trigger === 'sl' ? cur?.onSl : cur?.onTgt) ?? '';
  } else if (trigger === 'sl' ? row.reSlMode === 'lazy' : row.reTgtMode === 'lazy') {
    id = (trigger === 'sl' ? row.reSlLazyId : row.reTgtLazyId) ?? '';
  }
  return id && legs.some(l => l.id === id) ? id : null;
}

/** Strike a Lazy Leg opens at, from the current ATM. CE: +steps = higher; PE: +steps = lower. */
export function lazyLegStrike(lazy: Pick<FocusLazyLeg, 'leg' | 'otmSteps'>, atm: number, step: number): number {
  const n = Math.trunc(Number(lazy.otmSteps) || 0);
  return lazy.leg === 'CE' ? atm + n * step : atm - n * step;
}

// ── Overall Strategy Settings (per row) ─────────────────────────────────────

/** AlgoTest's cap on re-entries after an overall SL / target. */
export const MAX_OVERALL_REENTRIES = 5;

/** The row's Overall SL: SL ₹ (MTM) first, else SL × read as a % of premium. Null = none. */
export function overallSlConfig(
  row: Pick<FocusRow, 'slRupees' | 'slMultiplier'>,
): { mode: FocusOverallMode; value: number } | null {
  const rs = Number(row.slRupees);
  if (row.slRupees && Number.isFinite(rs) && rs > 0) return { mode: 'mtm', value: rs };
  const mult = Number(row.slMultiplier);
  if (row.slMultiplier && Number.isFinite(mult) && mult > 1) return { mode: 'premiumPct', value: (mult - 1) * 100 };
  return null;
}

/** P&L (₹) and premium profit (points) now, and the combined entry premium points. Points null while unquoted. */
export function overallProgress(
  row: Pick<FocusRow, 'side' | 'fill'>, live: RowLive, workerHold?: WorkerHold, lotSize?: number | null,
): { pnl: number; pts: number | null; entryPts: number } {
  const entryPts = live.entryPremium;
  const now = sidePremium(row, live, workerHold, lotSize ?? live.lotSize);
  return { pnl: live.pnl, pts: entryPts > 0 && now > 0 ? entryPts - now : null, entryPts };
}

/** The running peak, never below zero: the trails count profit from the start. */
export function nextOverallPeak(
  prev: { pnl?: number; pts?: number } | undefined, now: { pnl: number; pts: number | null },
): { pnl: number; pts: number } {
  return {
    pnl: Math.max(prev?.pnl ?? 0, now.pnl, 0),
    pts: Math.max(prev?.pts ?? 0, now.pts ?? 0, 0),
  };
}

/** Float slack for the % maths (1.3 − 1 is 0.30000000000000004), well below a paisa. */
const OVERALL_EPS = 1e-6;

export interface OverallExit { kind: 'sl' | 'target'; reason: string }

/**
 * Overall Target and the trailing options. (A plain Overall SL stays in
 * evaluateRowExit — this only adds what a trail changes about it.)
 *
 *  - Target: MTM → P&L ≥ ₹v; Total Premium % → premium profit ≥ v% of the
 *    combined entry premium (30% of 170 + 130 = 90 points).
 *  - Overall Trail SL: with n = floor(peak / every), the SL tightens by n × by:
 *    exit when profit ≤ −(SL − n × by). It may pass zero, which is a locked
 *    profit. Same unit as the SL; needs an Overall SL.
 *  - Lock (MTM): once the peak reached Y, exit if P&L falls to X.
 *  - Lock and Trail (MTM): as Lock, the floor then rising by `by` for every
 *    `every` more peak profit.
 * Trail and lock exits count as 'sl' for re-entry.
 */
export function evaluateOverallExit(
  row: Pick<FocusRow, 'overallTarget' | 'overallTrail' | 'slRupees' | 'slMultiplier' | 'side' | 'fill'> & Partial<Pick<FocusRow, 'qtyMultiplier'>>,
  live: RowLive,
  peak: { pnl: number; pts: number },
  workerHold?: WorkerHold,
  lotSize?: number | null,
): OverallExit | null {
  const p = overallProgress(row, live, workerHold, lotSize);
  // MTM amounts scale with the Quantity Multiplier; % of premium does not.
  const qm = rowQtyMultiplier(row);
  const unitVal = (mode: FocusOverallMode, v: number) => (mode === 'mtm' ? v * qm : v / 100 * p.entryPts);
  const profit = (mode: FocusOverallMode) => (mode === 'mtm' ? p.pnl : p.pts);
  const peakIn = (mode: FocusOverallMode) => (mode === 'mtm' ? peak.pnl : peak.pts);

  const t = row.overallTarget;
  const tv = Number(t?.value);
  if (t?.enabled && tv > 0) {
    const have = profit(t.mode);
    if (have != null && have >= unitVal(t.mode, tv) - OVERALL_EPS) {
      return { kind: 'target', reason: t.mode === 'mtm'
        ? `Overall Target ₹${tv * qm} reached (P&L ₹${p.pnl.toFixed(0)})`
        : `Overall Target ${tv}% of premium reached (${have.toFixed(2)} pts)` };
    }
  }

  const tr = row.overallTrail;
  if (!tr?.enabled) return null;
  const every = Number(tr.every);
  const by = Number(tr.by);
  if (tr.kind === 'trailSl') {
    const sl = overallSlConfig(row);
    if (!sl || !(every > 0) || !(by > 0)) return null;
    const n = Math.floor(peakIn(sl.mode) / unitVal(sl.mode, every));
    if (!(n > 0)) return null;
    const limit = unitVal(sl.mode, sl.value) - n * unitVal(sl.mode, by);
    const have = profit(sl.mode);
    if (have != null && have <= -limit + OVERALL_EPS) {
      return { kind: 'sl', reason: sl.mode === 'mtm'
        ? `Overall Trail SL ₹${(-limit).toFixed(0)} hit (P&L ₹${p.pnl.toFixed(0)})`
        : `Overall Trail SL ${(-limit).toFixed(2)} pts hit (${have.toFixed(2)} pts)` };
    }
    return null;
  }
  const reach = Number(tr.reach) * qm;
  const lock = Number(tr.lock) * qm;
  if (!(reach > 0) || !(lock >= 0) || lock >= reach || !(peak.pnl >= reach)) return null;
  const floor = lock + (tr.kind === 'lockTrail' && every > 0 && by > 0 ? Math.floor((peak.pnl - reach) / (every * qm)) * by * qm : 0);
  if (p.pnl <= floor + OVERALL_EPS) {
    return { kind: 'sl', reason: `Overall ${tr.kind === 'lockTrail' ? 'Lock and Trail' : 'Lock'} ₹${floor.toFixed(0)} hit (P&L ₹${p.pnl.toFixed(0)}, peak ₹${peak.pnl.toFixed(0)})` };
  }
  return null;
}

/** Which overall rule a whole-row exit reason came from, or null (levels, VW, exit time, account risk…). */
export function overallExitKind(reason: string): 'sl' | 'target' | null {
  if (reason.startsWith('Overall Target')) return 'target';
  if (reason.startsWith('SL ₹') || reason.startsWith('SL ×')
    || reason.startsWith('Overall Trail SL') || reason.startsWith('Overall Lock')) return 'sl';
  return null;
}

/**
 * Should the row start a new cycle after an overall SL / target exit? Needs the
 * switch on, the matching overall rule set, re-entries left (max 5 each), and
 * the re-entry window open (reentryWindowClosed).
 */
export function evaluateOverallReentry(
  row: Pick<FocusRow, 'overallReSl' | 'overallReTgt' | 'overallReSlCount' | 'overallReTgtCount'
    | 'overallTarget' | 'slRupees' | 'slMultiplier' | 'exitTime' | 'noReEntryAfter'>,
  kind: 'sl' | 'target',
  ctx: Pick<ReentryContext, 'nowHm' | 'product' | 'groupEnabled'>,
): EntryDecision & { mode: 'asap' | 'momentum' } {
  const cfg = kind === 'sl' ? row.overallReSl : row.overallReTgt;
  const mode = cfg?.mode ?? 'asap';
  const what = kind === 'sl' ? 'overall SL' : 'overall target';
  if (!cfg?.enabled) return { enter: false, mode, reason: `re-entry on ${what} off` };
  const armed = kind === 'sl' ? overallSlConfig(row) != null : !!row.overallTarget?.enabled && Number(row.overallTarget.value) > 0;
  if (!armed) return { enter: false, mode, reason: `${what} is not set` };
  const max = Math.min(MAX_OVERALL_REENTRIES, Math.max(0, Math.trunc(Number(cfg.max) || 0)));
  const done = (kind === 'sl' ? row.overallReSlCount : row.overallReTgtCount) ?? 0;
  if (done >= max) return { enter: false, mode, reason: `re-entry limit ${max} on ${what} reached` };
  const closed = reentryWindowClosed(row, ctx);
  if (closed) return { enter: false, mode, reason: closed };
  return { enter: true, mode, reason: `re-entry ${mode} after ${what}` };
}

// ── Account budget ───────────────────────────────────────────────────────────

export type TrailState = 'INACTIVE' | 'DORMANT' | 'ARMED';

export interface RiskConfig {
  riskEnabled: boolean;
  targetRupees: string;
  stopRupees: string;
  trailEnabled: boolean;
  triggerRupees: string;
  lockRupees: string;
  /** See FocusToolConfig.trailKind. Missing = 'peakGap'. */
  trailKind?: 'peakGap' | 'lock' | 'lockTrail' | 'trailSl';
  trailEvery?: string;
  trailBy?: string;
}

export interface GlobalRiskContext {
  /** P&L across this tool's own rows — NOT the whole account. */
  totalPnl: number;
  /** Highest totalPnl seen this session. */
  peakPnl: number;
  /** The ratcheted floor carried from the previous tick, or null. */
  lockFloor: number | null;
}

export interface GlobalRiskDecision {
  exitAll: boolean;
  reason: string;
  /** The floor to carry into the next tick. */
  lockFloor: number | null;
  trailState: TrailState;
}

/** A config number that arrives as a UI string. '' means "rule off", never 0. */
function num(v: string | number | null | undefined): number | null {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The account-level budget: TARGET ₹ / STOP ₹ and the trailing lock.
 *
 * The trail is dormant until P&L clears TRIGGER, then a floor that ratchets up
 * with every new peak and never moves down. TRIGGER is the hysteresis —
 * without it the floor would arm on the first rupee of profit and fire on the
 * next down-tick.
 *
 * Returns the floor to carry rather than mutating, so a restart mid-session
 * resumes from what was last recorded instead of silently re-arming.
 */
export function evaluateGlobalRisk(cfg: RiskConfig, ctx: GlobalRiskContext): GlobalRiskDecision {
  let lockFloor = ctx.lockFloor;
  const trailState: { v: TrailState } = { v: 'INACTIVE' };

  if (cfg.riskEnabled) {
    const target = num(cfg.targetRupees);
    const stop = num(cfg.stopRupees);
    if (target != null && target > 0 && ctx.totalPnl >= target) {
      return { exitAll: true, reason: `Target ₹${target.toFixed(0)} reached (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState: trailState.v };
    }
    // STOP is stored as a positive magnitude; the UI labels it a loss limit.
    if (stop != null && stop > 0 && ctx.totalPnl <= -stop) {
      return { exitAll: true, reason: `Stop ₹${stop.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState: trailState.v };
    }
  }

  const kind = cfg.trailKind ?? 'peakGap';
  if (cfg.trailEnabled && kind !== 'peakGap') {
    // AlgoTest broker-level trailing options — the same rules as the per-row
    // Overall trails, on the whole book's P&L.
    const every = num(cfg.trailEvery) ?? 0;
    const by = num(cfg.trailBy) ?? 0;
    if (kind === 'trailSl') {
      const stop = num(cfg.stopRupees);
      if (stop == null || !(stop > 0) || !(every > 0) || !(by > 0)) return { exitAll: false, reason: '', lockFloor, trailState: 'INACTIVE' };
      const n = Math.floor(Math.max(0, ctx.peakPnl) / every);
      if (!(n > 0)) return { exitAll: false, reason: '', lockFloor, trailState: 'DORMANT' };
      const floor = -(stop - n * by);
      if (ctx.totalPnl <= floor) {
        return { exitAll: true, reason: `Trail SL ₹${floor.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)}, peak ₹${ctx.peakPnl.toFixed(0)})`, lockFloor: floor, trailState: 'ARMED' };
      }
      return { exitAll: false, reason: '', lockFloor: floor, trailState: 'ARMED' };
    }
    const reach = num(cfg.triggerRupees);
    const lock = num(cfg.lockRupees);
    if (reach == null || !(reach > 0) || lock == null || lock < 0 || lock >= reach) {
      return { exitAll: false, reason: '', lockFloor, trailState: 'INACTIVE' };
    }
    if (!(ctx.peakPnl >= reach)) return { exitAll: false, reason: '', lockFloor, trailState: 'DORMANT' };
    const floor = lock + (kind === 'lockTrail' && every > 0 && by > 0 ? Math.floor((ctx.peakPnl - reach) / every) * by : 0);
    if (ctx.totalPnl <= floor) {
      return { exitAll: true, reason: `${kind === 'lockTrail' ? 'Lock and Trail' : 'Lock'} ₹${floor.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)}, peak ₹${ctx.peakPnl.toFixed(0)})`, lockFloor: floor, trailState: 'ARMED' };
    }
    return { exitAll: false, reason: '', lockFloor: floor, trailState: 'ARMED' };
  }

  const trigger = num(cfg.triggerRupees);
  if (cfg.trailEnabled && trigger != null && trigger > 0) {
    const gap = Math.max(num(cfg.lockRupees) ?? 0, 0);

    if (lockFloor === null) {
      if (ctx.totalPnl >= trigger) {
        lockFloor = trigger - gap;
        trailState.v = 'ARMED';
      } else {
        trailState.v = 'DORMANT';
      }
    } else {
      trailState.v = 'ARMED';
      // Ratchet on the running peak, not the current tick: a spike that has
      // already faded still counts, and the floor can only ever rise.
      const ratchet = ctx.peakPnl - gap;
      if (ratchet > lockFloor) lockFloor = ratchet;
      if (ctx.totalPnl <= lockFloor) {
        return {
          exitAll: true,
          reason: `Trail lock ₹${lockFloor.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)}, peak ₹${ctx.peakPnl.toFixed(0)})`,
          lockFloor,
          trailState: trailState.v,
        };
      }
    }
  }

  return { exitAll: false, reason: '', lockFloor, trailState: trailState.v };
}


// ── Quantity Multiplier (AlgoTest execution setting) ────────────────────────

/** The row's Quantity Multiplier: a whole number ≥ 1. Missing / bad = 1. */
export function rowQtyMultiplier(row: Partial<Pick<FocusRow, 'qtyMultiplier'>>): number {
  const m = Math.trunc(Number(row.qtyMultiplier));
  return m >= 1 ? m : 1;
}

/** Lots an entry of `lots` actually sends once the multiplier is applied. */
export function multipliedLots(row: Partial<Pick<FocusRow, 'qtyMultiplier'>>, lots: number): number {
  return Math.max(0, Math.trunc(Number(lots) || 0)) * rowQtyMultiplier(row);
}

// ── Strike criteria (AlgoTest Select Strike Criteria) ───────────────────────

/** One strike of the polled chain: premiums and |delta| × 100 (null when the chain has none). */
export interface ChainQuote { ce: number; pe: number; ceDelta?: number | null; peDelta?: number | null }

export interface StrikeCtx {
  /** The ATM strike (spot or futures based, per the group's ATM BY). */
  atm: number;
  step: number;
  /** Chain keyed by strike (any string form of the number). */
  oc: Record<string, ChainQuote> | undefined;
  /** ROUND's strike interval. */
  roundInterval?: number;
}

function chainRows(oc: StrikeCtx['oc'], leg: 'CE' | 'PE'): { strike: number; px: number; delta: number | null }[] {
  if (!oc) return [];
  const out: { strike: number; px: number; delta: number | null }[] = [];
  for (const [k, v] of Object.entries(oc)) {
    const strike = Number(k);
    if (!Number.isFinite(strike)) continue;
    const px = Number(leg === 'CE' ? v.ce : v.pe) || 0;
    const d = leg === 'CE' ? v.ceDelta : v.peDelta;
    out.push({ strike, px, delta: d != null && d > 0 ? d : null });
  }
  return out;
}

/**
 * AlgoTest "Closest Premium": the strike whose premium is nearest the target,
 * either side (target 50, strikes at 49 and 52 → 49). A tie goes to the
 * higher premium (this tool sells). Null without a chain or a target.
 */
export function closestPremiumStrike(oc: StrikeCtx['oc'], leg: 'CE' | 'PE', target: number): number | null {
  if (!(target > 0)) return null;
  let best: { strike: number; px: number } | null = null;
  for (const r of chainRows(oc, leg)) {
    if (!(r.px > 0)) continue;
    const d = Math.abs(r.px - target);
    const bd = best ? Math.abs(best.px - target) : Infinity;
    if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best && r.px > best.px)) best = r;
  }
  return best?.strike ?? null;
}

/** Straddle premium (CE + PE) at a strike, or 0 when either side is unquoted. */
function straddleAt(oc: StrikeCtx['oc'], strike: number): number {
  if (!oc) return 0;
  const v = oc[String(strike)] ?? Object.entries(oc).find(([k]) => Number(k) === strike)?.[1];
  const ce = Number(v?.ce) || 0;
  const pe = Number(v?.pe) || 0;
  return ce > 0 && pe > 0 ? ce + pe : 0;
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;

/**
 * The listed strike nearest `x`, if one is within a strike step of it (the
 * chain's own strikes) — else null. Arithmetic criteria (Straddle Width, % of
 * ATM, Synthetic Future) snap to it so they never name a contract that does not
 * exist, and never slide to the chain's edge when the target is beyond it.
 */
function nearestListed(oc: StrikeCtx['oc'], x: number, step: number): number | null {
  if (!oc || !Number.isFinite(x)) return null;
  let best: number | null = null;
  for (const k of Object.keys(oc)) {
    const n = Number(k);
    if (Number.isFinite(n) && (best == null || Math.abs(n - x) < Math.abs(best - x))) best = n;
  }
  return best != null && Math.abs(best - x) <= step ? best : null;
}

/** `x` when the chain lists it, else null — for rules that name one exact strike. */
function listedOrNull(oc: StrikeCtx['oc'], x: number): number | null {
  if (!oc || !Number.isFinite(x)) return null;
  return Object.keys(oc).some(k => Number(k) === x) ? x : null;
}

/**
 * The strike a leg resolves to under an AlgoTest strike criterion, or null when
 * it cannot (no chain / quote / delta, a strike the chain does not list, or
 * nothing qualifies — a Delta Range
 * with no strike inside means the leg is SKIPPED, as on AlgoTest). Sell side:
 * Premium Range and Delta Range take the highest qualifying value.
 *
 * Synthetic Future = ATM strike + ATM CE − ATM PE (the glossary formula; the
 * docs' worked example adds the spot instead — see the vault's open question).
 */
export function resolveCriteriaStrike(
  kind: FocusStrikeCriteria, leg: 'CE' | 'PE', crit: FocusLegCrit | null | undefined, ctx: StrikeCtx,
): number | null {
  const a = Number(crit?.a);
  const b = Number(crit?.b);
  const { atm, step, oc } = ctx;
  if (!(atm > 0) || !(step > 0)) return null;
  const rows = () => chainRows(oc, leg);
  switch (kind) {
    case 'ROUND': {
      const iv = Number(ctx.roundInterval) > 0 ? Number(ctx.roundInterval) : 100;
      const n = Math.trunc(Number.isFinite(a) ? a : 0);
      // ATM reference: the eligible round strike nearest ATM (a tie goes up), not the raw ATM.
      if (n === 0) return listedOrNull(oc, Math.floor(atm / iv + 0.5) * iv);
      // OTM is above ATM for a CE, below for a PE; ITM the other way. ATM itself is never counted.
      const up = (leg === 'CE') === (n > 0);
      const k = Math.abs(n);
      const first = up ? Math.floor(atm / iv) * iv + iv : Math.ceil(atm / iv) * iv - iv;
      return listedOrNull(oc, up ? first + (k - 1) * iv : first - (k - 1) * iv);
    }
    case 'PREM_GTE': {
      if (!(a > 0)) return null;
      let best: { strike: number; px: number } | null = null;
      for (const r of rows()) if (r.px >= a && (!best || r.px < best.px)) best = r;
      return best?.strike ?? null;
    }
    case 'PREM_LTE': {
      if (!(a > 0)) return null;
      let best: { strike: number; px: number } | null = null;
      for (const r of rows()) if (r.px > 0 && r.px <= a && (!best || r.px > best.px)) best = r;
      return best?.strike ?? null;
    }
    case 'PREM_RANGE': {
      if (!(a >= 0) || !(b > 0) || b < a) return null;
      let best: { strike: number; px: number } | null = null;
      for (const r of rows()) if (r.px > 0 && r.px >= a && r.px <= b && (!best || r.px > best.px)) best = r;
      return best?.strike ?? null;
    }
    case 'STRADDLE_WIDTH': {
      const st = straddleAt(oc, atm);
      if (!(st > 0) || !Number.isFinite(a)) return null;
      return nearestListed(oc, roundTo(atm + a * st, step), step);
    }
    case 'PCT_ATM':
      return Number.isFinite(a) ? nearestListed(oc, roundTo(atm * (1 + a / 100), step), step) : null;
    case 'SYNTH_FUT': {
      const v = oc ? (oc[String(atm)] ?? Object.entries(oc).find(([k]) => Number(k) === atm)?.[1]) : undefined;
      const ce = Number(v?.ce) || 0;
      const pe = Number(v?.pe) || 0;
      if (!(ce > 0) || !(pe > 0)) return null;
      const synth = roundTo(atm + ce - pe, step);
      return listedOrNull(oc, synth + Math.trunc(Number.isFinite(a) ? a : 0) * step);
    }
    case 'ATM_PREM_PCT': {
      const st = straddleAt(oc, atm);
      if (!(st > 0) || !(a > 0)) return null;
      return closestPremiumStrike(oc, leg, st * a / 100);
    }
    case 'DELTA': {
      // 0–100 inclusive; a blank box is "not set", not delta 0.
      if (String(crit?.a ?? '').trim() === '' || !(a >= 0 && a <= 100)) return null;
      let best: { strike: number; delta: number } | null = null;
      for (const r of rows()) {
        if (r.delta == null) continue;
        if (!best || Math.abs(r.delta - a) < Math.abs(best.delta - a) - 1e-9) best = { strike: r.strike, delta: r.delta };
      }
      return best?.strike ?? null;
    }
    case 'DELTA_RANGE': {
      if (String(crit?.a ?? '').trim() === '' || String(crit?.b ?? '').trim() === '') return null;
      if (!(a >= 0) || !(b <= 100) || b < a) return null;
      let best: { strike: number; delta: number } | null = null;
      for (const r of rows()) {
        if (r.delta == null || r.delta < a || r.delta > b) continue;
        if (!best || r.delta > best.delta) best = { strike: r.strike, delta: r.delta };
      }
      return best?.strike ?? null;
    }
    case 'EXACT':
      return a > 0 ? listedOrNull(oc, a) : null;
  }
  return null;
}

// ── Multi-day Range Breakout (BTST / Positional ORB) ────────────────────────

const dayMs = 86_400_000;
const isWeekday = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6; };
/** A weekday the exchange is open (NSE_HOLIDAYS covers the years it lists; others are weekdays-only). */
const isTradingDay = (iso: string) => isWeekday(iso) && !NSE_HOLIDAYS.has(iso);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

/** The trading day `n` trading days before `iso` (n = 1 → previous trading day), skipping weekends and NSE holidays. */
export function tradingDaysBack(iso: string, n: number): string {
  let d = iso;
  let left = Math.max(0, Math.trunc(n));
  while (left > 0) { d = addDays(d, -1); if (isTradingDay(d)) left--; }
  return d;
}

/** Trading days from `today` to `expiry`: 0 on expiry day. Null when past or unparseable. */
export function tradingDte(today: string, expiry: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry < today) return null;
  let n = 0;
  for (let d = today; d < expiry; d = addDays(d, 1)) if (isTradingDay(addDays(d, 1))) n++;
  return n;
}

/** The trading day `dte` trading days before `expiry` (an expiry on a holiday moves to the day before, as NSE does). */
export function dateForDte(expiry: string, dte: number): string {
  let d = expiry;
  while (!isTradingDay(d)) d = addDays(d, -1);
  return tradingDaysBack(d, dte);
}

export interface RangeWindow { startDate: string; start: string; endDate: string; end: string }

/**
 * The range a Range Breakout leg tracks, as dates and times:
 *  - intraday: today, entry time → End (End after the entry time);
 *  - btst: the previous trading day at the entry time → today at End;
 *  - positional: the day `startDte` trading days before expiry at the entry time
 *    → the day `endDte` before expiry at End.
 * Null when the settings are invalid. Weekends and NSE holidays (NSE_HOLIDAYS)
 * are skipped; a year that list lacks counts weekdays only.
 */
export function rangeWindow(
  rb: FocusLegRangeBreakout, entryTime: string, today: string, expiry: string,
): RangeWindow | null {
  if (!HM_RE.test(rb.end) || !HM_RE.test(entryTime)) return null;
  const kind = rb.kind ?? 'intraday';
  if (kind === 'intraday') return rb.end > entryTime ? { startDate: today, start: entryTime, endDate: today, end: rb.end } : null;
  if (kind === 'btst') return { startDate: tradingDaysBack(today, 1), start: entryTime, endDate: today, end: rb.end };
  const sd = Math.trunc(Number(rb.startDte));
  const ed = Math.trunc(Number(rb.endDte));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !(sd >= 0) || !(ed >= 0) || ed > sd) return null;
  if (sd === ed && !(rb.end > entryTime)) return null;
  return { startDate: dateForDte(expiry, sd), start: entryTime, endDate: dateForDte(expiry, ed), end: rb.end };
}

/** Where today / now stands against a (possibly multi-day) range. 'over' = its end day has passed. */
export function rangeWindowPhase(w: RangeWindow, today: string, nowHm: string): 'before' | 'tracking' | 'ended' | 'over' {
  if (today > w.endDate) return 'over';
  if (today < w.startDate || (today === w.startDate && nowHm < w.start)) return 'before';
  if (today < w.endDate || nowHm < w.end) return 'tracking';
  return 'ended';
}

/** Does the row have a BTST / Positional range leg (its entry happens on the range's end day, after End)? */
export function rowHasMultiDayRange(row: Pick<FocusRow, 'side' | 'ceRangeBreakout' | 'peRangeBreakout'>): FocusLegRangeBreakout | null {
  for (const leg of legsOf(row)) {
    const rb = leg === 'CE' ? row.ceRangeBreakout : row.peRangeBreakout;
    if (rb?.enabled && (rb.kind === 'btst' || rb.kind === 'positional')) return rb;
  }
  return null;
}

/** 'HH:MM' → the start of its `minutes`-long candle ('09:37', 5 → '09:35'). */
export function candleBucket(hm: string, minutes: number): string {
  const m = Math.max(1, Math.trunc(Number(minutes) || 1));
  const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const b = Math.floor(t / m) * m;
  return `${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`;
}
