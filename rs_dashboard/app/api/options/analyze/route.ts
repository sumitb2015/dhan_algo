import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { buildPositionSnapshot } from '@/lib/positionSnapshot';
import { ANALYTICS_UNDERLYINGS, type AnalyticsUnderlying } from '@/lib/analyticsUnderlyings';
import type { Suggestion } from '../suggestions/route';

/**
 * The "Analyze" button on /options-analytics/[underlying]: builds the same
 * positions/payoff/greeks snapshot the page itself computes
 * (lib/positionSnapshot.ts, shared with scripts/analyze-positions.ts), asks
 * Claude to review it, and returns a short summary plus 0-3 concrete
 * close/trim suggestions — the SAME shape the "Suggested Actions" panel
 * already knows how to render and confirm. This route also persists the
 * result to debug/options_suggestions_<UNDERLYING>.json so it keeps showing
 * in that panel after the modal is closed, exactly as if a Claude Code
 * session had written it there by hand.
 *
 * This never places an order. Every suggestion still requires a human click
 * on the existing Confirm button, which drives the existing
 * handleCloseLeg()/closeLeg() flow — this route only proposes.
 */

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DEBUG_DIR = path.join(PROJECT_ROOT, 'debug');

const MODEL = 'claude-opus-5';
const SUGGESTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — long enough to act on, short enough not to go stale

const SYSTEM_PROMPT = `You are a risk-review assistant for one options trader's OPEN positions on a single underlying. You are given a JSON snapshot: live legs (strike, type CE/PE, side, quantity in contracts, entry price, live greeks), net portfolio greeks, payoff statistics (max profit/loss, breakevens, probability of profit, exposure), and available capital.

Your job: identify the single biggest near-term risk in this specific book (not general options education) and, if warranted, propose 0-3 concrete adjustments.

Hard constraints:
- You may ONLY propose closing or trimming a leg that is already in the "legs" array of the snapshot you were given — match by exact strike, type, and expiry. Never propose opening a new position, rolling to a different strike, or adjusting a leg you were not given.
- "action" must be "CLOSE" (full exit) or "TRIM" (partial); "pct" must be 25, 50, 75, or 100, and 100 only when action is "CLOSE".
- Ground every rationale in the actual numbers you were given (delta, unrealized P&L, distance from spot, days to expiry, net greeks) — do not invent numbers or speculate about news/events not in the data.
- If the book looks fine as-is (defined risk, comfortable delta, no leg under near-term pressure), return an empty suggestions array and say so plainly in the summary — do not manufacture a suggestion to have something to say.
- Prefer trimming the least-hedged, most-at-risk leg over broad restructuring — this trader can only execute close/trim on existing legs from this page today, nothing else.

Keep the summary to 2-4 sentences.`;

const EMIT_ANALYSIS_TOOL: Anthropic.Tool = {
  name: 'emit_analysis',
  description: 'Report the risk summary and any concrete close/trim suggestions for this book.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentence plain-language risk read of this specific book.' },
      suggestions: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            strike: { type: 'number' },
            type: { type: 'string', enum: ['CE', 'PE'] },
            expiry: { type: 'string', description: 'YYYY-MM-DD, must match a leg in the snapshot exactly' },
            side: { type: 'string', enum: ['BUY', 'SELL'] },
            action: { type: 'string', enum: ['CLOSE', 'TRIM'] },
            pct: { type: 'number', enum: [25, 50, 75, 100] },
            rationale: { type: 'string', description: '1-3 sentences, grounded in the given numbers.' },
          },
          required: ['strike', 'type', 'expiry', 'side', 'action', 'pct', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'suggestions'],
    additionalProperties: false,
  },
  strict: true,
};

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ANTHROPIC_API_KEY is not set. Add it to .env at the project root and restart the server.' },
      { status: 501 },
    );
  }

  let body: { underlying?: string; broker?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const underlyingRaw = (body.underlying ?? '').toUpperCase();
  if (!ANALYTICS_UNDERLYINGS.includes(underlyingRaw as AnalyticsUnderlying)) {
    return NextResponse.json({ success: false, error: `Unknown underlying: ${underlyingRaw}` }, { status: 400 });
  }
  const underlying = underlyingRaw as AnalyticsUnderlying;
  const broker = body.broker === 'kotak' ? 'kotak' : 'dhan';

  const cookie = request.headers.get('cookie') ?? '';
  if (!cookie) {
    return NextResponse.json({ success: false, error: 'No session cookie on this request' }, { status: 401 });
  }

  try {
    const snapshot = await buildPositionSnapshot({ underlying, broker, baseUrl: request.nextUrl.origin, cookie });

    if (!snapshot.legs.length) {
      return NextResponse.json({
        success: true, underlying, summary: `No open ${underlying} option positions on this broker — nothing to analyze.`, suggestions: [],
      });
    }

    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      tools: [EMIT_ANALYSIS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_analysis' },
      messages: [{
        role: 'user',
        content: `Analyze this ${underlying} book:\n\n${JSON.stringify({
          spot: snapshot.spot,
          legs: snapshot.legs.map((l) => ({
            strike: l.strike, type: l.type, side: l.side, expiry: l.expiry,
            qtyContracts: l.qtyLots, entryPrice: l.price, ltp: l.display.ltp,
            unrealizedPnl: l.display.unrealizedProfit, delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega, iv: l.iv,
          })),
          netGreeks: snapshot.netGreeks,
          payoffStats: snapshot.payoffStats,
          exposure: snapshot.exposure,
        })}`,
      }],
    });

    const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'emit_analysis');
    if (!toolUse) {
      return NextResponse.json({ success: false, error: `Claude did not return an analysis (stop_reason: ${msg.stop_reason})` }, { status: 502 });
    }
    const parsed = toolUse.input as { summary: string; suggestions: Omit<Suggestion, 'id'>[] };

    // Defense in depth: only keep suggestions that match a leg ACTUALLY in the
    // snapshot, even though the tool schema and prompt already constrain this —
    // never trust a model's own claim that a leg exists.
    const validSuggestions: Suggestion[] = parsed.suggestions
      .filter((s) => snapshot.legs.some((l) => l.strike === s.strike && l.type === s.type && l.expiry === s.expiry))
      .map((s, i) => ({ ...s, id: `sugg_${Date.now()}_${i}` }));

    if (validSuggestions.length > 0) {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const file = path.join(DEBUG_DIR, `options_suggestions_${underlying}.json`);
      fs.writeFileSync(file, JSON.stringify({
        underlying,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SUGGESTION_TTL_MS).toISOString(),
        suggestions: validSuggestions,
      }, null, 2));
    }

    return NextResponse.json({ success: true, underlying, summary: parsed.summary, suggestions: validSuggestions });
  } catch (err) {
    console.error('[/api/options/analyze]', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
