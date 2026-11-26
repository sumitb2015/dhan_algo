// A short attention chime for automatic alerts (Multi-Leg Focus risk rules). Synthesized with the Web Audio API: no audio
// file, no loading delay.
//
// Browsers only let a page make sound after the user has interacted with it (autoplay policy). An alert fires from a timer,
// not a click, so the AudioContext is created and unlocked on the page's first pointer/key event (installAlertSoundUnlock).
// Before that the chime is silently skipped; the on-screen toast still shows.

let ctx: AudioContext | null = null;
let lastPlayed = 0;
/** Several rules firing on the same tick give one chime, not a pile-up. */
const MIN_GAP_MS = 1500;

function getCtx(): AudioContext | null {
  if (ctx || typeof window === 'undefined') return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try { ctx = new Ctor(); } catch { ctx = null; }
  return ctx;
}

/** Unlocks audio on the first click/tap/keypress. Returns a cleanup for useEffect. */
export function installAlertSoundUnlock(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === 'suspended') void c.resume().catch(() => {});
    if (c && c.state !== 'suspended') remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  return remove;
}

/** Plays `freqs` one after another on the shared context. Gated like every chime: unlocked, and one per MIN_GAP_MS. */
function playTones(freqs: number[], type: OscillatorType, now: number, step = 0.18, throttled = true): boolean {
  const c = ctx;
  if (!c || c.state !== 'running') return false;
  if (throttled) {
    if (now - lastPlayed < MIN_GAP_MS) return false;
    lastPlayed = now;
  }
  try {
    freqs.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      const t = c.currentTime + i * step;
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.02);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + step - 0.01);
    });
    return true;
  } catch {
    return false;   // audio unavailable: the toast still shows
  }
}

/** Two rising tones then one high tone (~0.6 s). No-op until audio is unlocked, and at most once per MIN_GAP_MS. */
export function playAlertChime(now = Date.now()): boolean {
  return playTones([660, 880, 1175], 'triangle', now);
}

/** A trade was taken: two quick rising tones. */
export function playEntryChime(now = Date.now()): boolean {
  return playTones([784, 1047], 'sine', now, 0.14);
}

/** A trade was closed: two falling tones, so an exit never sounds like an entry. */
export function playExitChime(now = Date.now()): boolean {
  return playTones([1047, 698], 'sine', now, 0.14);
}

/** Something needs attention (a rejection or an unknown order): three low, flat buzzes. */
export function playWarnChime(now = Date.now()): boolean {
  return playTones([330, 330, 330], 'square', now, 0.16);
}

// ── Signal chimes (Signal Orb): the indicator consensus changed colour. Softer, lower triangle arpeggios, so a signal never sounds
// like a trade (the trade chimes are two high sine tones).

/** Signal turned bullish: an A-major arpeggio up. */
export function playBullChime(now = Date.now()): boolean {
  return playTones([440, 554, 659], 'triangle', now, 0.15);
}

/** Signal turned bearish: the same arpeggio down. */
export function playBearChime(now = Date.now()): boolean {
  return playTones([659, 554, 440], 'triangle', now, 0.15);
}

/** Signal went neutral: two soft level tones. */
export function playNeutralChime(now = Date.now()): boolean {
  return playTones([523, 523], 'triangle', now, 0.16);
}

// ── Alarm (Price Alerts): the alert chime repeated for a set time, with a stop handle.

/** How often the alarm repeats its three-tone chime. */
export const ALARM_REPEAT_MS = 800;

/**
 * Plays the alert chime every ALARM_REPEAT_MS for `durationMs` (a price alert's "sound for N seconds"). Every repeat is
 * scheduled up front on the audio clock, not on a timer, so a background tab's timer throttling cannot stretch or drop it.
 * Outside the shared MIN_GAP_MS throttle — an alarm is one deliberate sound, and taking the slot would silence another
 * page's chime. Returns stop() for the toast's "Stop sound" button (a no-op when audio is not unlocked yet).
 */
export function playAlarm(durationMs: number): () => void {
  const c = ctx;
  if (!c || c.state !== 'running') return () => {};
  const step = 0.18;
  const freqs = [660, 880, 1175];
  const repeats = Math.max(1, Math.ceil(durationMs / ALARM_REPEAT_MS));
  try {
    const master = c.createGain();
    master.connect(c.destination);
    for (let r = 0; r < repeats; r++) {
      freqs.forEach((f, i) => {
        const o = c.createOscillator();
        const g = c.createGain();
        const t = c.currentTime + r * (ALARM_REPEAT_MS / 1000) + i * step;
        o.type = 'triangle';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + step - 0.02);
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + step - 0.01);
      });
    }
    let stopped = false;
    return () => { if (!stopped) { stopped = true; try { master.disconnect(); } catch { /* already gone */ } } };
  } catch {
    return () => {};   // audio unavailable: the toast still shows
  }
}

/** True once audio is unlocked and running (the page can show "click to enable sound" until then). */
export function alertSoundReady(): boolean {
  return ctx !== null && ctx.state === 'running';
}
