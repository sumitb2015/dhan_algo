'use client';

// Idempotent start for the shared live-indices WebSocket bridge that feeds
// scalper/top-indices' `fromHub` path (the 9 NSE index rows on both the
// Advanced Scalper's Top 10 Markets panel and the Markets Overview page).
// The route no-ops if the bridge is already running (see
// app/api/live-indices/route.ts's POST 'start' handler) — safe to call from
// every consumer's mount effect, same as AdvancedScalper.tsx already does.
export function startLiveIndicesBridge(): void {
  fetch('/api/live-indices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  }).catch(() => {});
}
