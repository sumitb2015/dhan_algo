import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { getDhanCredentials } from '@/lib/dhanToken';
import { DEBUG_DIR, allStateKeys, isStrategyRunning } from '@/lib/strategyRegistry';
import { runPythonJson, PROJECT_ROOT } from '@/lib/pyExec';

const DHAN_POSITIONS = 'https://api.dhan.co/v2/positions';
const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const PENDING_ORDER_STATUSES = new Set(['PENDING', 'TRANSIT', 'OPEN', 'PART_TRADED']);

function isFnoSegment(segment: unknown): boolean {
  return typeof segment === 'string' && segment.toUpperCase().includes('FNO');
}

/** Dhan's raw REST error body is `{errorCode, errorType, errorMessage}` — never an array
 *  and never `{data: [...]}` — so it's distinguishable from a genuine empty list/array response. */
function dhanErrorDetail(json: unknown): string | null {
  if (json && typeof json === 'object' && !Array.isArray(json) && ('errorCode' in json || 'errorType' in json || 'errorMessage' in json)) {
    const j = json as Record<string, unknown>;
    return String(j.errorMessage ?? j.errorType ?? j.errorCode ?? JSON.stringify(json));
  }
  return null;
}

/** Fetch open F&O positions, flatten each with an opposite-side market order, then
 *  cancel any pending F&O orders. Equity (NSE_EQ/BSE_EQ) positions/orders are left untouched. */
async function exitFnoOnly(clientId: string, token: string): Promise<{ ok: boolean; error: string | null }> {
  const headers = {
    'access-token': token,
    'client-id': clientId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const errors: string[] = [];

  try {
    const posRes = await fetch(DHAN_POSITIONS, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    const posJson = await posRes.json().catch(() => null);
    const posErr = dhanErrorDetail(posJson);
    if (posErr || !posRes.ok) {
      errors.push(`positions fetch: HTTP ${posRes.status}${posErr ? ` - ${posErr}` : ''}`);
    } else {
      const positions: Record<string, unknown>[] = Array.isArray(posJson) ? posJson : (Array.isArray((posJson as any)?.data) ? (posJson as any).data : []);
      const openFno = positions.filter(p => Number(p.netQty ?? 0) !== 0 && isFnoSegment(p.exchangeSegment));

      for (const pos of openFno) {
        const netQty = Number(pos.netQty ?? 0);
        const payload = {
          dhanClientId: clientId,
          transactionType: netQty > 0 ? 'SELL' : 'BUY',
          exchangeSegment: pos.exchangeSegment,
          productType: pos.productType,
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: String(pos.securityId),
          quantity: Math.abs(netQty),
          disclosedQuantity: 0,
          price: 0,
          afterMarketOrder: false,
          boProfitValue: 0,
          boStopLossValue: 0,
          triggerPrice: 0,
        };
        const res = await fetch(DHAN_ORDERS, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
        const json = await res.json().catch(() => ({} as Record<string, unknown>));
        const orderId = String((json as any).orderId ?? (json as any).data?.orderId ?? '');
        if (!orderId) {
          errors.push(`close ${pos.tradingSymbol ?? pos.securityId}: ${String((json as any).remarks ?? (json as any).message ?? JSON.stringify(json))}`);
        }
      }
    }
  } catch (err) {
    errors.push(`positions fetch: ${String((err as Error).message ?? err)}`);
  }

  try {
    const ordRes = await fetch(DHAN_ORDERS, { method: 'GET', headers, signal: AbortSignal.timeout(15_000) });
    const ordJson = await ordRes.json().catch(() => null);
    const ordErr = dhanErrorDetail(ordJson);
    if (ordErr || !ordRes.ok) {
      errors.push(`orders fetch: HTTP ${ordRes.status}${ordErr ? ` - ${ordErr}` : ''}`);
    } else {
      const orders: Record<string, unknown>[] = Array.isArray(ordJson) ? ordJson : (Array.isArray((ordJson as any)?.data) ? (ordJson as any).data : []);
      const pendingFno = orders.filter(o => PENDING_ORDER_STATUSES.has(String(o.orderStatus ?? '').toUpperCase()) && isFnoSegment(o.exchangeSegment));

      for (const ord of pendingFno) {
        const res = await fetch(`${DHAN_ORDERS}/${ord.orderId}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
          const json = await res.json().catch(() => ({} as Record<string, unknown>));
          errors.push(`cancel order ${ord.orderId}: ${String((json as any).remarks ?? (json as any).message ?? `HTTP ${res.status}`)}`);
        }
      }
    }
  } catch (err) {
    errors.push(`orders fetch: ${String((err as Error).message ?? err)}`);
  }

  return { ok: errors.length === 0, error: errors.length ? errors.join('; ') : null };
}

/** Flatten every open position on one child broker (Kotak/Zerodha) by shelling out to
 *  scripts/tools/exit_all_broker_positions.py — strategies launched with --broker
 *  kotak/zerodha (lib/execution_broker.py) hold their positions at that broker, not
 *  Dhan, so the Dhan-only sweep above never touches them. Failure here (broker not
 *  logged in, no positions, etc.) is reported but never blocks the rest of exit-all —
 *  this is a best-effort addition to the Dhan sweep, not a replacement for it. */
async function exitChildBroker(broker: 'kotak' | 'zerodha'): Promise<{ ok: boolean; closed: number; error: string | null }> {
  try {
    const script = path.join(PROJECT_ROOT, 'scripts', 'tools', 'exit_all_broker_positions.py');
    const result = await runPythonJson<{ status: string; closed: unknown[]; errors: string[] }>(
      script, [broker], 30_000);
    if (result.status === 'error') {
      return { ok: false, closed: 0, error: result.errors?.join('; ') || 'unknown error' };
    }
    return { ok: result.status === 'ok', closed: result.closed?.length ?? 0,
             error: result.errors?.length ? result.errors.join('; ') : null };
  } catch (err) {
    return { ok: false, closed: 0, error: String((err as Error).message ?? err) };
  }
}

function forceKillPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/** Write a STOPPED state for a strategy so the dashboard clears zombie state immediately. */
function clearStrategyState(key: string, existingState: Record<string, any>) {
  try {
    const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
    const cleared = {
      ...existingState,
      status: 'STOPPED',
      // Clear live position fields so the dashboard shows no stale data
      ce_strike: null,
      pe_strike: null,
      ce_ltp: 0,
      pe_ltp: 0,
      ce_lots: 0,
      pe_lots: 0,
      ce_active: false,
      pe_active: false,
      ce_sl: 0,
      pe_sl: 0,
      active_spread: null,
      short_symbol: null,
      long_symbol: null,
      short_strike: null,
      long_strike: null,
      short_ltp: 0,
      long_ltp: 0,
      in_position: false,
      sold_strike: null,
      current_ltp: 0,
      combined_best_premium: null,
      last_update: new Date().toISOString(),
    };
    const tmpPath = stateFile + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cleared, null, 2));
    fs.renameSync(tmpPath, stateFile);
  } catch {
    // Non-fatal â€” dashboard will eventually re-read
  }
}

/** Remove any stale shutdown trigger files so a future strategy start isn't auto-stopped. */
function cleanTriggerFile(key: string) {
  try {
    const triggerFile = path.join(DEBUG_DIR, `${key}_shutdown.trigger`);
    if (fs.existsSync(triggerFile)) fs.unlinkSync(triggerFile);
  } catch {}
}

export async function POST(req: NextRequest) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    const reqBody = await req.json().catch(() => ({} as Record<string, unknown>));
    const fnoOnly = (reqBody as Record<string, unknown>)?.scope === 'fno';

    // â”€â”€ Step 1: Broker-level exit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Do this FIRST â€” strategies must not race to close positions themselves.
    // Called directly against the Dhan REST API (same pattern as
    // scalper/fast-order): the old exit_all_positions.py subprocess spent
    // ~10s on interpreter + DhanHelper startup before sending this one call.
    //
    // scope: 'fno' (scalper terminals) â€” close only F&O positions/orders,
    // leaving equity untouched, since Dhan's DELETE /positions is all-or-nothing.
    // default (strategies-plus portfolio page) â€” full account nuclear exit.
    let brokerExit = false;
    let brokerError: string | null = null;
    try {
      const { clientId, token } = getDhanCredentials();

      if (fnoOnly) {
        const result = await exitFnoOnly(clientId, token);
        brokerExit = result.ok;
        brokerError = result.error;
        if (!result.ok) console.error('[exit-all] FNO-scoped exit had errors:', result.error);
      } else {
        const res = await fetch(DHAN_POSITIONS, {
          method: 'DELETE',
          headers: {
            'access-token': token,
            'client-id': clientId,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          brokerExit = true;
        } else {
          let detail = `HTTP ${res.status}`;
          try {
            const json = await res.json() as Record<string, unknown>;
            detail = String(json.remarks ?? json.message ?? (json.errorMessage as string) ?? JSON.stringify(json));
          } catch {}
          brokerError = detail;
          console.error('[exit-all] Dhan DELETE /positions failed:', detail);
        }
      }
    } catch (err) {
      brokerError = String((err as Error).message ?? err);
      console.error('[exit-all] Dhan broker exit error:', brokerError);
    }

    // ── Step 1b: Child-broker exit (Kotak/Zerodha) ───────────────────────
    // Strategies launched with --broker kotak/zerodha hold positions at that
    // broker, not Dhan — Step 1 above never sees them. A full nuclear exit
    // (not the scalper's F&O-only scope) must flatten those too, or Step 2's
    // force-kill below orphans a live position with no process managing it.
    // Best-effort: a broker that was never logged in for the day reports an
    // error here but does not fail the overall exit-all call.
    const childBrokerResults: Record<string, { ok: boolean; closed: number; error: string | null }> = {};
    if (!fnoOnly) {
      const [kotakResult, zerodhaResult] = await Promise.all([
        exitChildBroker('kotak'),
        exitChildBroker('zerodha'),
      ]);
      childBrokerResults.kotak = kotakResult;
      childBrokerResults.zerodha = zerodhaResult;
      if (!kotakResult.ok && kotakResult.error) {
        console.error('[exit-all] Kotak child broker exit:', kotakResult.error);
      }
      if (!zerodhaResult.ok && zerodhaResult.error) {
        console.error('[exit-all] Zerodha child broker exit:', zerodhaResult.error);
      }
    }

    // â”€â”€ Step 2: Sync all strategy processes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Broker-side exit orders/cancellations from Step 1 are already in flight
    // (atomic under the default path; async MARKET orders under scope:'fno').
    // Force-kill each running strategy so it cannot attempt its own
    // position-close or re-enter. Then immediately clear its state file so
    // the dashboard shows STOPPED.
    const killed: string[] = [];
    const triggerFallback: string[] = [];

    // allStateKeys() covers every strategy AND every duplicated ("+ Add run") instance.
    // Missing an instance here would be dangerous: step 1 already liquidated its positions
    // account-wide, so an instance left alive would keep managing — and could re-enter —
    // a position that no longer exists.
    for (const { stateKey: key } of allStateKeys()) {
      const stateFile = path.join(DEBUG_DIR, `${key}_state.json`);
      if (!fs.existsSync(stateFile)) continue;

      let existingState: Record<string, any> = {};
      try {
        existingState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch {
        continue;
      }

      const pid: number | undefined = existingState.pid;
      if (!pid || !isStrategyRunning(pid, key)) {
        // Process already dead â€” just clear state and remove any stale trigger
        cleanTriggerFile(key);
        if (existingState.status !== 'STOPPED') clearStrategyState(key, existingState);
        continue;
      }

      const didKill = forceKillPid(pid);
      if (didKill) {
        killed.push(key);
      } else {
        // Kill failed (permissions?) â€” fall back to graceful shutdown trigger
        const triggerFile = path.join(DEBUG_DIR, `${key}_shutdown.trigger`);
        fs.writeFileSync(triggerFile, '');
        triggerFallback.push(key);
      }

      // Always clear state file immediately regardless of kill method
      clearStrategyState(key, existingState);
    }

    return NextResponse.json({
      success: brokerExit,
      broker_exit: brokerExit,
      child_broker_exit: childBrokerResults,
      killed,
      trigger_fallback: triggerFallback,
      error: brokerError,
    });
  } catch (err) {
    console.error('Error in exit-all API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
