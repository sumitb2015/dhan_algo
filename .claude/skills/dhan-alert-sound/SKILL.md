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
  a browser, and the entry / exit / warning chime family for order-placing terminals (distinct sounds, mute toggle,
  pure event classifier). Not for order-click sound effects (lib/cyberAudio.ts, Cyber
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

## Trade chimes: entry, exit, warning (Price Ladder, 2026-10-23)
For an order-placing terminal, one chime is not enough: the user must tell an entry from an exit without looking.
`lib/alertSound.ts` therefore exports a family that shares ONE `ctx`, the unlock and the 1.5 s throttle (a private
`playTones(freqs, type, now, step)` builds them all):

| Function | Sound | Use for |
|---|---|---|
| `playAlertChime` | 3 rising triangle tones | generic alert (risk rules, level hit) |
| `playEntryChime` | 2 rising sine tones (784, 1047 Hz) | a trade was taken |
| `playExitChime` | 2 falling sine tones (1047, 698 Hz) | a trade was closed |
| `playWarnChime` | 3 low flat square buzzes (330 Hz) | rejected / UNKNOWN order, needs a look |

Adding a new sound: add a one-line export on top of `playTones`; never a second AudioContext.

**Pick the sound from the server's event messages, in a pure module** (`lib/priceLadderChime.ts` — `chimeFor(messages)`
returns `'warn' | 'exit' | 'entry' | null`, tested in `lib/priceLadderChime.test.ts`). Priority inside one poll batch:
a problem (`UNKNOWN`, `rejected`) beats an exit (`Exited`, `SIM exit`) beats an entry (` filled `), so a burst never hides a
rejection behind a friendly sound, and the 1.5 s throttle plays only one sound per burst. Matching is on message text,
so **if you reword a ladder event message, update the regexes and the test**.

Wiring pattern (PriceLadder.tsx): the page diffs `state.events` against `lastEventAt` each poll, then
`chimeFor(fresh.map(e => e.msg))` → one `play*Chime()`. The first poll after load only records the newest time (no chime
for history). Only the first ladder pane chimes (`!second`) so two panes do not double-ring.

**Mute toggle** (the one this skill used to say "add later"): a Volume2/VolumeX icon button, `aria-pressed`, labelled
"Mute trade chimes" / "Unmute trade chimes", stored in its own localStorage key (`price-ladder-sound`, '1'/'0', default
on, read/written through the page's try/catch `readPref`/`savePref`). Put it on the main controls row, not only the
collapsed one, and render it once per terminal. Sound stays an addition to the toast: muted or locked, errors still toast.

**Gotcha when inserting JSX with a script:** matching a short indented string can hit the same text inside another
block (the collapsed-header fragment matched the main-row anchor and the button rendered only when collapsed). Anchor
on a unique line, and let an e2e test click the control.

Testing: `lib/alertSound.test.ts` covers the family (oscillator counts 2/2/3, shared throttle);
`e2e/price-ladder.spec.ts` covers the toggle and that it is remembered across a reload.

## Checklist
- [ ] `installAlertSoundUnlock()` in a mount `useEffect` of the page (returns its own cleanup).
- [ ] `playAlertChime()` next to each announced alert, in the leader-only path.
- [ ] Announce-once/hysteresis exists so the chime is not per-tick.
- [ ] Toast/banner still shows when sound is blocked.
- [ ] No pure rule module imports `alertSound`.
- [ ] `node --test lib/alertSound.test.ts` passes; tell the user about the first-click limitation.
