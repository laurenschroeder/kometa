import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// A slow, doom-laden brass blast — fired from the king's own tower a few
// seconds BEFORE his actual death (see earth-situations-vfx-system.ts's
// _updateGasHorn, triggered at the very start of the Ambient beat's death
// sub-beat, GAS_DEATH_START_SECONDS later than this), so the player gets an
// audible "something bad is about to happen" beat before king-death-tone.ts's
// own sinking-dread cue actually plays at the topple itself. Sawtooth (not
// king-death-tone.ts's sine) for a brassy, horn-like harmonic buzz, with a
// slow vibrato and a slow swell-then-hold-then-fade envelope — reads as a
// distant warning horn rather than that file's own low drone.
const BASE_FREQ = 98; // G2 — a low, doom-laden brass fundamental
const DETUNE_RATIO = 1.003; // second sawtooth, barely detuned, for a thicker/rougher blast
const VIBRATO_FREQ = 4.5; // Hz
const VIBRATO_DEPTH = 2; // Hz of pitch wobble
const FILTER_FREQ = 700; // keeps the sawtooth's harsh upper harmonics dark/distant
const ATTACK = 0.5;
const HOLD = 1.2;
const RELEASE = 1.8;
const GAIN = 0.11;

// Same raw-Web-Audio-via-PositionalAudio.setNodeSource one-shot technique
// every other generative cue in this codebase uses (see payoff-chime.ts/
// king-death-tone.ts).
export function playKingHorn(listener: AudioListener, scene: Scene, position: Vector3): void {
  const context = listener.context;
  if (context.state !== 'running') {
    context.resume().catch(() => {});
    return;
  }
  const now = context.currentTime;
  const totalDuration = ATTACK + HOLD + RELEASE;

  const sum = context.createGain();
  sum.gain.value = 1;

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = FILTER_FREQ;
  filter.connect(sum);

  const vibrato = context.createOscillator();
  vibrato.type = 'sine';
  vibrato.frequency.value = VIBRATO_FREQ;
  const vibratoGain = context.createGain();
  vibratoGain.gain.value = VIBRATO_DEPTH;
  vibrato.connect(vibratoGain);
  vibrato.start(now);
  vibrato.stop(now + totalDuration + 0.05);

  for (const ratio of [1.0, DETUNE_RATIO]) {
    const osc = context.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = BASE_FREQ * ratio;
    vibratoGain.connect(osc.frequency);

    const g = context.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(GAIN, now + ATTACK);
    g.gain.setValueAtTime(GAIN, now + ATTACK + HOLD);
    g.gain.exponentialRampToValueAtTime(0.0001, now + totalDuration);

    osc.connect(g);
    g.connect(filter);
    osc.start(now);
    osc.stop(now + totalDuration + 0.05);
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
      vibratoGain.disconnect();
    },
    (totalDuration + 0.1) * 1000,
  );
}
