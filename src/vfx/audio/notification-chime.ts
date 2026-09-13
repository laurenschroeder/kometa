import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// A soft, quiet two-partial "pop" — much shorter/quieter than
// payoff-chime.ts's own triad burst (that one's built for rare, big Beat-5
// payoff moments; this fires on every single HUD notification, so it needs
// to stay unobtrusive rather than announce itself).
const RATIOS = [1.0, 2.0]; // clean octave, reads as a gentle "pop" not a chord
const BASE_FREQ = 660;
const ATTACK = 0.012;
const DECAY = 0.32;
const GAIN = 0.045;

// Same raw-Web-Audio-via-PositionalAudio.setNodeSource technique every other
// generative cue in this codebase uses (see payoff-chime.ts) — a plain
// function rather than a class since NotificationHudSystem only ever needs
// one voice at a time (a burst of queued notifications still plays them
// one at a time, never overlapping — see NotificationHudSystem._pump).
export function playNotificationChime(listener: AudioListener, scene: Scene, position: Vector3): void {
  const context = listener.context;
  if (context.state !== 'running') {
    context.resume().catch(() => {});
    return;
  }
  const now = context.currentTime;
  const sum = context.createGain();
  sum.gain.value = 1;
  for (const ratio of RATIOS) {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = BASE_FREQ * ratio;
    const g = context.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(GAIN, now + ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK + DECAY);
    osc.connect(g);
    g.connect(sum);
    osc.start(now);
    osc.stop(now + ATTACK + DECAY + 0.05);
  }
  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(() => {
    scene.remove(sound);
    sum.disconnect();
  }, (ATTACK + DECAY + 0.1) * 1000);
}
