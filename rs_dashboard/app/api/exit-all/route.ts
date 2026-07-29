import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { getDhanCredentials } from '@/lib/dhanToken';
import { DEBUG_DIR, allStateKeys, isStrategyRunning } from '@/lib/strategyRegistry';

const DHAN_POSITIONS = 'https://api.dhan.co/v2/positions';

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

export async function POST() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }

    // â”€â”€ Step 1: Broker-level nuclear exit (DELETE /positions) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Do this FIRST â€” strategies must not race to close positions themselves.
    // Called directly against the Dhan REST API (same pattern as
    // scalper/fast-order): the old exit_all_positions.py subprocess spent
    // ~10s on interpreter + DhanHelper startup before sending this one call.
    let brokerExit = false;
    let brokerError: string | null = null;
    try {
      const { clientId, token } = getDhanCredentials();
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
    } catch (err) {
      brokerError = String((err as Error).message ?? err);
      console.error('[exit-all] Dhan DELETE /positions error:', brokerError);
    }

    // â”€â”€ Step 2: Sync all strategy processes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Positions are already closed at the broker. Force-kill each running
    // strategy so it cannot attempt its own position-close or re-enter.
    // Then immediately clear its state file so the dashboard shows STOPPED.
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
      killed,
      trigger_fallback: triggerFallback,
      error: brokerError,
    });
  } catch (err) {
    console.error('Error in exit-all API:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
