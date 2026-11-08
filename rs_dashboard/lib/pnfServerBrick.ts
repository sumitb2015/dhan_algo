// Does the server AUTO engine's newest brick differ from the page's? (the "SERVER SEES" chip, components/straddlePnf/usePnfAuto.ts). Pure.
import type { PnfColumn } from './straddlePnf.ts';

/** The server's newest brick as lib/pnfAutoEngine.ts reports it; `low` / `high` are absent from an older server. */
export type ServerBrick = { n: number; dir: 'X' | 'O'; barT: number; box: number; low?: number; high?: number };

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/**
 * With the server's edges, the same newest brick (direction, bar, edges) is a match even when the two builds hold different brick
 * COUNTS: a history that starts a few bars earlier adds bricks at the front, and both builds converge on the same bricks after the first
 * move both read. Without edges (an older server) the count and box are compared, as before.
 */
export function serverBrickDiffers(sb: ServerBrick, page: { last: PnfColumn; n: number; barT: number; box: number }): boolean {
  if (sb.dir !== page.last.dir || sb.barT !== page.barT) return true;
  if (sb.low !== undefined && sb.high !== undefined) return !(near(sb.low, page.last.low) && near(sb.high, page.last.high));
  return sb.n !== page.n || Math.abs(sb.box - page.box) > 1e-9;
}
