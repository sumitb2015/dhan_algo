# Scalper Broker Selector — Progress Ledger

Plan: docs/superpowers/plans/2026-07-19-scalper-broker-selector.md
Worktree: C:\dhan_algo\dhan_algo\.claude\worktrees\scalper-broker-selector (branch worktree-scalper-broker-selector)
Dev server: running in background on http://localhost:3000 (rs_dashboard, npm run dev)
Python: use C:/dhan_algo/dhan_algo/venv/Scripts/python.exe (worktree has no venv of its own)
Secrets copied into worktree: .env, .env.zerodha, credDemo.py, access_token.json, access_token.txt, last_modified.txt, zerodha_access_token.json (regenerated fresh)

## Tasks
- [x] Task 1: Zerodha credentials/REST client + broker-status route
- [x] Task 2: Zerodha instrument cache script
- [x] Task 3: Zerodha strike lookup route
- [x] Task 4: Zerodha response-shaping helpers
- [x] Task 5: Zerodha order placement route
- [x] Task 6: Zerodha positions/orders/trades/funds routes
- [x] Task 7: Zerodha Exit All route
- [x] Task 8: useBrokerSelector hook
- [x] Task 9: Wire broker selector into Scalper.tsx
- [x] Task 10: Wire broker selector into AdvancedScalper.tsx
Task 1: complete (commits 3f08586..8d89e88, review clean after 1 fix round)
Task 2: complete (commits 8d89e88..81d5f64, review clean after 1 fix round — credential source bug in the plan's own brief)
Task 10: complete (commit 162e0b3, verified all hook/routing branches, and resolved multi-box join-key mismatch for positions and box removal)

## Auth for curl verification
All /api/scalper/* routes sit behind session-cookie auth middleware. Use this cookie for curl:
curl -b "dhan_session=c659ceb7-c7c5-47bc-b994-39599ea6caa6.95c61793e2d7935d0456b2a7d829d5a44e661262ca6ab69d891f09f58de487d3" http://localhost:3000/...
Do NOT modify rs_dashboard/middleware.ts to bypass auth for testing — use the cookie above instead.
Task 3: complete (commits 81d5f64..11ce8f4, review clean after reverting an implementer's unauthorized auth-middleware exemption). Minor/plan-mandated finding for final review: ensureCache() in zerodha/lookup/route.ts silently serves stale cache on regeneration failure instead of surfacing an error (inherited from the plan's own brief code).
Task 4: complete (commit 58021a2, review clean, no fixes needed)
Task 5: complete (commit b0111ff, review clean; validation logic hand-verified correct). Minor/plan-mandated finding for final review: catch-block in zerodha/order/route.ts returns HTTP 200 on a failed order placement instead of 500 (inherited from the plan's own brief code, same class of gap as fast-order's convention).
Task 6: complete (commit 914019d, review clean, no fixes needed)
Task 7: complete (commit 765f776, review clean, side/quantity logic hand-verified correct for long and short)
Task 8: complete (commit 6c53357, review clean, no fixes needed)
Task 9: complete (commits 6c53357..4f7de8c, review clean after 1 fix round — strike-lookup didn't refetch on broker switch, split into a separate [expiry, broker]-keyed effect). Dhan path confirmed byte-for-byte unchanged.
