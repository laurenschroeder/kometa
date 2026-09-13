import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Low fundamental plus a slightly detuned unison partner (RATIOS[1]) for a
// slow, dissonant beating rather than a clean drone, plus a quiet sub-octave
// (RATIOS[2]) for weight. A lowpass filter keeps the whole thing dark instead
// of buzzy, and the fundamental itself sags downward over the tone's life
// (see PITCH_DROP_RATIO) — a classic "sinking dread" cue, distinct from
// every other generative sound here (payoff-chime.ts/notification-chime.ts),
// which are all bright, fast, upward-reading pops/chimes.
const BASE_FREQ = 55; // A1
const RATIOS = [1.0, 1.01, 0.5];
const PITCH_DROP_RATIO = 0.6; // fundamental eases down to this fraction of BASE_FREQ
const FILTER_FREQ = 320;
const ATTACK = 0.6;
const DECAY = 3.5;
const GAIN = 0.13;

// Same raw-Web-Audio-via-PositionalAudio.setNodeSource one-shot technique
// every other generative cue in this codebase uses (see payoff-chime.ts) —
// fired once from earth-situations-vfx-system.ts's _triggerKingDeath(), at
// the king's own tower position, the instant his death animation starts.
export function playKingDeathTone(listener: AudioListener, scene: Scene, position: Vector3): void {
  const context = listener.context;
  if (context.state !== 'running') {
    context.resume().catch(() => {});
    return;
  }
  const now = context.currentTime;
  const sum = context.createGain();
  sum.gain.value = 1;

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = FILTER_FREQ;
  filter.connect(sum);

  for (const ratio of RATIOS) {
    const osc = context.createOscillator();
    osc.type = 'sine';
    const freq = BASE_FREQ * ratio;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.linearRampToValueAtTime(freq * PITCH_DROP_RATIO, now + ATTACK + DECAY);
    const g = context.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(GAIN, now + ATTACK);
    g.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK + DECAY);
    osc.connect(g);
    g.connect(filter);
    osc.start(now);
    osc.stop(now + ATTACK + DECAY + 0.05);
  }

  const sound = new PositionalAudio(listener);
  sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
  sound.position.copy(position);
  scene.add(sound);
  setTimeout(
    () => {
      scene.remove(sound);
      sum.disconnect();
      filter.disconnect();
    },
    (ATTACK + DECAY + 0.1) * 1000,
  );
}
