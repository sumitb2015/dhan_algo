---
name: dhan-alert-sound
description: >-
  Use when a dashboard page should make a sound for an alert — a price/level
  trigger, stop or target hit, max-loss or margin warning, an automatic exit,
  a scanner signal, or any "beep/chime/ding when X happens" request — or when
  an existing alert sound is silent, plays a burst of overlapping beeps, or is
  muted by another page's setting. Covers the shared chime in
  rs_dashboard/lib/alertSound.ts (installAlertSoundUnlock + playAlertChime),
  the browser autoplay rule that silences timer-fired sounds until the user
  clicks, throttling, which tab should chime, and how to unit-test it without
  a browser. Not for order-click sound effects (lib/cyberAudio.ts, Cyber
  Scalper) and not for desktop notifications or persistent banners.
---

# Alert sound for dashboard alerts

Reference implementation: Multi-Leg Focus risk rules (2026-10-15) — `rs_dashboard/lib/alertSound.ts`,
wired in `components/MultiLegFocus.tsx`, tested in `lib/alertSound.test.ts`.

## The one rule that makes or breaks it: autoplay
Browsers let a page make sound **only after the user has clicked, tapped or pressed a key on it**. Alerts fire from
timers, polls and WebSocket ticks, never from a click, so an `AudioContext` created at alert time starts `suspended`
and `resume()` is refused: the sound is silently lost.

So: create and resume the context **inside a user-gesture handler**, before any alert can fire. `installAlertSoundUnlock()`
adds one-shot `pointerdown`/`keydown` listeners on `window` that do exactly that and then remove themselves. Never
create the context at module load or on first alert.

Consequence to tell the user: after a page reload, alerts are silent until their first click anywhere on the page.
The visual toast must still show, so **sound is always an addition to a toast/banner, never the only signal**.

## How to add it to a page (3 lines)
```tsx
import { installAlertSoundUnlock, playAlertChime } from '@/lib/alertSound';

// once per page: unlock audio on the first click / key press
useEffect(() => installAlertSoundUnlock(), []);

// wherever the alert is announced, next to the toast
addToast('error', title, detail);
playAlertChime();
```
- Call it where the alert is **announced**, not where the condition is evaluated. Announce-once logic (e.g.
  `nextAlarmState`, `rt.alerted` in `lib/multiLegGuardEngine.ts`) already stops repeats every poll; the chime rides on it.
  If the page has no announce-once state, add it first, or the chime plays every tick while the condition holds.
- `playAlertChime()` returns `false` when it did not play (not unlocked yet, throttled, audio unavailable). It never throws.
- Built-in throttle: at most one chime per 1.5 s (`MIN_GAP_MS`), so several rules firing on one tick give one chime.
- Keep the pure engine/rules modules sound-free. The engine returns effects (`toast`, `exitAll`, ...); the component
  performs them and plays the chime. Tests of the engine stay deterministic.

## Which tab chimes
Automatic alerts on terminal pages run only in the **leader tab** (`isLeader`), so only that tab announces and
chimes. Do not add a chime in a code path every open tab runs (a render, a shared poll in each tab), or two tabs
double-ring. If a non-leader tab must also show the alert, show the toast there without sound.

## Do not
- Do not reuse `lib/cyberAudio.ts` for alerts: it is Cyber Scalper's click/buy/sell effects and its mute lives in
  localStorage key `cyber-scalper-audio`, so muting Cyber Scalper would silently mute your alerts.
- Do not copy `BearishStrikes.tsx`'s private `playAlertSound` (older pattern, its own AudioContext ref and sound toggle);
  new pages use `lib/alertSound.ts`. Migrating BearishStrikes is optional.
- Do not ship audio files or `new Audio(url)`: they load late and the first alert can be lost. Synthesize with oscillators.
- Do not keep a toast on screen until dismissed to "make up" for sound unless the user asks; the agreed behaviour is the
  normal toast lifetime (7 s for error toasts in Multi-Leg Focus) plus the chime.
- Do not hardcode colours or add UI for this; it has none. If a mute toggle is requested later, give it its own
  localStorage key per feature (wrap reads/writes in try/catch) and check it before calling `playAlertChime()`.

## Extending the sound
Need a different sound per severity (e.g. a lower tone for a heads-up, the current chime for a breach)? Add a second
exported function in `lib/alertSound.ts` sharing the same `ctx`, unlock and throttle — never a second AudioContext.
Keep gains at or below ~0.2 and use short exponential envelopes (as `playAlertChime` does) so it does not click or blast.

## Testing
Node has no Web Audio, so `lib/alertSound.test.ts` installs a fake `window` with an `AudioContext` that starts
`suspended`, fires the captured `pointerdown` listener, and checks: silent before interaction, plays after (3
oscillators), throttled within 1.5 s, unlock listener removed. Import the module **after** setting the fake
(`await import('./alertSound.ts')`) because it reads `window` lazily but caches the context in module state.
Engine tests should assert the `toast` effect, not the sound.

Manual check: open the page, click once, trigger the alert (e.g. a spot rule just past the current price in a SIM/paper
setup — never a live exit to test a sound), and listen; then reload without clicking and confirm the toast shows silently.

## Checklist
- [ ] `installAlertSoundUnlock()` in a mount `useEffect` of the page (returns its own cleanup).
- [ ] `playAlertChime()` next to each announced alert, in the leader-only path.
- [ ] Announce-once/hysteresis exists so the chime is not per-tick.
- [ ] Toast/banner still shows when sound is blocked.
- [ ] No pure rule module imports `alertSound`.
- [ ] `node --test lib/alertSound.test.ts` passes; tell the user about the first-click limitation.
