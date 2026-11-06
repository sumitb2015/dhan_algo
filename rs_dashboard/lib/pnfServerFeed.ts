import { loadPnfHistory } from '@/lib/pnfHistory';
import { askBridge, ensureBridge, readBack, readBridgeBook } from '@/lib/pnfLiveBridge';
import { forgetOtherDays, istDate, readTickFile, rowsBetween, SETTLE_MS, tickFile } from '@/lib/pnfTicksServer';
import { feedStale, foldLive, idsOf, liveRead, marketOf, type Instrument } from '@/lib/pnfFeedCore';
import { mergeHistory, type LegQuote, type Market, type Tick } from '@/lib/straddlePnfLive';
import { mergeTail } from '@/lib/pnfTail';
import { bucketTickBars, foldTickRows, newTickBuild, spliceTicks, type SecBuild, type TickBuild } from '@/lib/pnfTicks';
import { targetQuery, type Target } from '@/lib/pnfTarget';
import type { WantedPair } from '@/lib/pnfWanted';
import type { Bar } from '@/lib/straddlePnf';

// One chart's price series on the dashboard SERVER, for the AUTO engine (lib/pnfAutoEngine.ts) with every tab closed: the same history
// (lib/pnfHistory.ts, shared cache with the page), the same live fold of the price bridge (lib/pnfFeedCore.ts) and the same Tick /
// N-second build from the bridge's tick log as the page's usePnfFeed, so the server's bricks are the page's. Read-only: no orders.

const REFRESH_MS = 30_000;
/** Sessions the refresh of an index asks for (its full history is two years of minutes). */
const TAIL_SESSIONS = 4;
const RETRY_MS = 15_000;

export class ServerFeed {
  readonly target: Target;
  /** Renko Tick / N-second bars: 0 = one bar per recorded price, N = N-second bars; null = 1-minute bars. */
  readonly tickSec: number | null;
  /** The asker key the bridge knows this chart by. */
  private readonly asker: string;
  private bars: Bar[] = [];
  private instruments: Instrument[] = [];
  private cas = false;
  anchorT: number | null = null;
  /** The whole history has loaded at least once: until then the chart is not complete (a partial model would mislead the rules). */
  loaded = false;
  error: string | null = null;
  /** Bumped on every history load (the API may revise closed bars): part of the engine's rebuild key. */
  histVersion = 0;
  private loading = false;
  private lastLoadMs = 0;
  private lastTick: Tick | null = null;
  /** A price outside the session (pre-open / post-close) or, in Tick mode, the newest live read: the price AUTO reads, never a bar. */
  private headPrice: number | null = null;
  // Tick mode
  private tickDay = '';
  private tickSince = 0;
  private tickBuild: TickBuild = newTickBuild(1);
  private secBuild: SecBuild | null = null;
  private tickBars: Bar[] | null = null;

  constructor(target: Target, tickSec: number | null, asker: string) {
    this.target = target; this.tickSec = tickSec; this.asker = asker;
  }

  get market(): Market { return marketOf(this.instruments, this.cas); }
  private get single() { return this.instruments.length < 2; }

  /** History: the whole of it first, then every 30 s (an index's last few sessions only), merged as the page merges it. */
  private async refresh(nowMs: number): Promise<void> {
    if (this.loading || nowMs - this.lastLoadMs < (this.error && !this.loaded ? RETRY_MS : REFRESH_MS)) return;
    this.loading = true;
    this.lastLoadMs = nowMs;
    try {
      const tail = this.loaded && this.target.kind === 'index';
      const r = await loadPnfHistory(new URLSearchParams(`${targetQuery(this.target)}${tail ? `&tail=${TAIL_SESSIONS}` : ''}`));
      const j = r.body as { success?: boolean; error?: string; strikes?: number[]; instruments?: Instrument[]; anchorT?: number | null; cas?: boolean; bars?: Record<string, Bar[]> };
      if (!j.success) throw new Error(j.error ?? `history load failed (HTTP ${r.status})`);
      const hist = j.bars?.[String(j.strikes?.[0] ?? 0)] ?? [];
      const instruments = j.instruments ?? [];
      if (idsOf(instruments) !== idsOf(this.instruments)) { this.tickBuild = newTickBuild(instruments.length); this.secBuild = null; this.tickBars = null; this.tickSince = 0; this.tickDay = ''; }
      this.instruments = instruments;
      this.cas = j.cas === true;
      this.anchorT = j.anchorT ?? null;
      this.bars = mergeHistory(tail ? mergeTail(this.bars, hist) : hist, this.bars, this.lastTick, instruments.length < 2);
      this.loaded = true;
      this.error = null;
      this.histVersion++;
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'history load failed';
    } finally {
      this.loading = false;
    }
  }

  /** The bridge's latest price for the chart's legs, folded into the 1-minute bars (or kept as the head price). */
  private live(nowMs: number): void {
    if (!this.instruments.length) return;
    const pairs = this.instruments.map(i => [i.segment, i.security_id]) as WantedPair[];
    try { askBridge(this.asker, pairs, nowMs); } catch { return; }
    ensureBridge(nowMs);
    const { book } = readBridgeBook(nowMs);
    const legs = this.instruments.map(i => readBack(book?.[`${i.segment}:${i.security_id}`]));
    const quotes: LegQuote[] = legs.map(l => l.quote);
    const last = this.bars[this.bars.length - 1];
    const r = liveRead(last?.straddle, quotes, this.market, this.tickSec !== null);
    if (r.kind === 'none') { this.headPrice = null; return; }
    if (r.kind === 'wild') return;
    if (r.kind === 'out' || r.kind === 'head') { this.headPrice = r.tick.ce + r.tick.pe; return; }
    this.headPrice = null;
    this.lastTick = r.tick;
    this.bars = foldLive(this.bars, r.tick, this.single);
  }

  /** Renko Tick / N-second mode: the bridge's tick log since the last read, as closed bars. */
  private ticks(nowMs: number): void {
    if (this.tickSec === null || !this.instruments.length) return;
    const upTo = nowMs - SETTLE_MS;
    const day = istDate(nowMs);
    forgetOtherDays(day);
    if (day !== this.tickDay) { this.tickDay = day; this.tickSince = 0; this.tickBuild = newTickBuild(this.instruments.length); this.secBuild = null; }
    let legs;
    try { legs = this.instruments.map(i => rowsBetween(readTickFile(tickFile(day, i.segment, i.security_id)), this.tickSince, upTo)); } catch { return; }
    const h = this.bars[this.bars.length - 1];
    this.tickBuild = foldTickRows(this.tickBuild, legs, this.market, h?.straddle, h ? [h.ce, h.pe] : undefined);
    this.tickSince = upTo;
    if (this.tickSec) this.secBuild = bucketTickBars(this.secBuild, this.tickBuild.bars, this.tickSec, upTo / 1000);
    this.tickBars = this.tickSec ? this.secBuild!.bars : this.tickBuild.bars;
  }

  /** One step: history when due (in the background), the live price, the tick log. */
  step(nowMs: number): void {
    void this.refresh(nowMs);
    this.live(nowMs);
    this.ticks(nowMs);
  }

  /** The chart's bars as the page draws them: in Tick / N-second mode the history up to the tick log, then the recorded prices. */
  chartBars(nowMs: number): Bar[] {
    if (this.tickSec === null) return this.bars;
    if (this.tickBars === null) return [];
    return spliceTicks(this.bars, this.tickBars, Math.floor(nowMs / 60_000) * 60);
  }

  /** The chart's live price (a straddle's CE + PE), the page's priceOf(feed). `bars`: this step's chartBars, when already built. */
  price(nowMs: number, bars?: Bar[]): number | null {
    if (this.headPrice !== null) return this.headPrice;
    const b = bars ?? this.chartBars(nowMs);
    const last = b[b.length - 1];
    return last ? last.ce + last.pe : null;
  }

  stale(nowMs: number, bars?: Bar[]): boolean {
    const b = bars ?? this.chartBars(nowMs);
    return feedStale(b[b.length - 1]?.t, nowMs / 1000);
  }
}
