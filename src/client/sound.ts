// Tiny Web Audio helpers — no audio files, just synthesized blips.
// Browsers require a user gesture before audio can start, so we lazily create
// the context and resume it on the first interaction (join/sit/tap).

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call once on the first user gesture so later sounds are allowed to play. */
export function unlockAudio() {
  getCtx();
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem("ruung_muted") === "1";
  } catch {
    return false;
  }
}

export function setMuted(m: boolean) {
  try {
    localStorage.setItem("ruung_muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function blip(freq: number, start: number, dur: number, gain = 0.15) {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t = c.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** Rising two-note chime when it becomes your turn. */
export function playTurnChime() {
  if (isMuted()) return;
  blip(660, 0, 0.16);
  blip(880, 0.12, 0.2);
}

/** Soft click when a card is played. */
export function playCardSound() {
  if (isMuted()) return;
  blip(420, 0, 0.08, 0.1);
}
