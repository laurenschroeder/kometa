import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Same additive-synthesis skeleton TwinkleSynth (twinkle-synth.ts) uses,
// plus an optional per-partial partialTypes override (same extension point
// PebbleSynth's red-pebble profile already established) — the fundamental
// carries a square wave for the "chiptune" identity, upper partials stay
// sine/triangle so the overall chime still reads as musical rather than
// harsh/buzzy across the whole spectrum. Undefined entries default to
// 'sine', same as PebbleSynth.
interface PixelTwinkleProfile {
  partialRatios: number[];
  partialGains: number[];
  partialDecay: number[];
  partialTypes?: OscillatorType[];
  freqMin: number;
  freqMax: number;
  outputGainMin: number;
  outputGainMax: number;
  reverbSend: number;
  maxVoices: number;
}

const ATTACK_SECONDS = 0.006;
const SPEED_FOR_MAX_BRIGHTNESS = 1.8;

// Same shape/timing as TwinkleSynth's CATCH_PROFILE — only the waveform mix
// changes, so this reads as a clear "square-wave sibling" of the original
// chime rather than an unrelated new sound.
const CATCH_PROFILE: PixelTwinkleProfile = {
  partialRatios: [1.0, 2.4, 3.76, 5.4],
  partialGains: [0.85, 0.45, 0.22, 0.12],
  partialDecay: [0.3, 0.22, 0.15, 0.1],
  partialTypes: ['square', 'sine', 'triangle', 'sine'],
  freqMin: 1900,
  freqMax: 3400,
  outputGainMin: 0.1,
  outputGainMax: 0.24,
  reverbSend: 0.55,
  maxVoices: 10,
};

const PICKUP_PROFILE: PixelTwinkleProfile = {
  partialRatios: [1.0, 2.7],
  partialGains: [0.55, 0.22],
  partialDecay: [0.09, 0.06],
  partialTypes: ['square', 'sine'],
  freqMin: 2200,
  freqMax: 3200,
  outputGainMin: 0.025,
  outputGainMax: 0.06,
  reverbSend: 0.4,
  maxVoices: 16,
};

const PENTATONIC_DEGREES = [0, 2, 4, 7, 9];

const DISTANCE_PITCH_CENTS = 160;
const DISTANCE_MIN = 0.25;
const DISTANCE_MAX = 1.8;

const REVERB_DURATION = 1.9;
const REVERB_DECAY_EXPONENT = 3;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function snapToPentatonic(freq: number, rootFreq: number): number {
  const semitones = 12 * Math.log2(freq / rootFreq);
  const octave = Math.floor(semitones / 12);
  const withinOctave = semitones - octave * 12;

  let bestDegree = PENTATONIC_DEGREES[0];
  let bestDist = Math.abs(withinOctave - bestDegree);
  for (const degree of PENTATONIC_DEGREES) {
    const dist = Math.abs(withinOctave - degree);
    if (dist < bestDist) {
      bestDist = dist;
      bestDegree = degree;
    }
  }
  const distToNextRoot = Math.abs(withinOctave - 12);
  const bestSemitones = distToNextRoot < bestDist ? (octave + 1) * 12 : octave * 12 + bestDegree;

  return rootFreq * Math.pow(2, bestSemitones / 12);
}

function buildReverbImpulse(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * REVERB_DURATION);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, REVERB_DECAY_EXPONENT);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

// Square-wave-forward sibling of TwinkleSynth (see that file's own class
// comment for the full generative-audio rationale) — used in place of it
// once StardustSystem's swirl finale begins (see stardust-vfx-system.ts),
// so the pickup/catch cue shifts to match the pixel-CRT swirls' chiptune
// aesthetic without losing the pentatonic/distance-detune/reverb-bus
// character that makes a flurry of catches sound musically coherent.
export class PixelTwinkleSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _activeCatchVoices = 0;
  private _activePickupVoices = 0;
  private _scratchListenerPos = new Vector3();

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;

    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    context.resume().catch(() => {});
  }

  playCatch(position: Vector3, speed: number): void {
    if (this._activeCatchVoices >= CATCH_PROFILE.maxVoices) return;
    this._activeCatchVoices++;
    this._play(CATCH_PROFILE, position, speed, () => this._activeCatchVoices--);
  }

  playPickup(position: Vector3, speed: number): void {
    if (this._activePickupVoices >= PICKUP_PROFILE.maxVoices) return;
    this._activePickupVoices++;
    this._play(PICKUP_PROFILE, position, speed, () => this._activePickupVoices--);
  }

  private _play(profile: PixelTwinkleProfile, position: Vector3, speed: number, onDone: () => void): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      onDone();
      return;
    }

    const now = context.currentTime;
    const t = clamp01(speed / SPEED_FOR_MAX_BRIGHTNESS);
    const rawFreq = lerp(profile.freqMin, profile.freqMax, t);
    const scaleFreq = snapToPentatonic(rawFreq, profile.freqMin);

    this._listener.getWorldPosition(this._scratchListenerPos);
    const distance = position.distanceTo(this._scratchListenerPos);
    const distanceT = clamp01((distance - DISTANCE_MIN) / (DISTANCE_MAX - DISTANCE_MIN));
    const cents = lerp(-DISTANCE_PITCH_CENTS, DISTANCE_PITCH_CENTS, distanceT);
    const baseFreq = scaleFreq * Math.pow(2, cents / 1200);

    const brightness = lerp(0.5, 1.0, t);
    const outputPeak = lerp(profile.outputGainMin, profile.outputGainMax, t);

    const partialsSum = context.createGain();
    partialsSum.gain.value = 1;

    let maxLifetime = 0;
    for (let k = 0; k < profile.partialRatios.length; k++) {
      const osc = context.createOscillator();
      osc.type = profile.partialTypes?.[k] ?? 'sine';
      osc.frequency.value = baseFreq * profile.partialRatios[k];

      const decay = profile.partialDecay[k];
      const peak = profile.partialGains[k] * (k === 0 ? 1 : brightness);
      const partialGain = context.createGain();
      partialGain.gain.setValueAtTime(0, now);
      partialGain.gain.linearRampToValueAtTime(peak, now + ATTACK_SECONDS);
      partialGain.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK_SECONDS + decay);

      osc.connect(partialGain);
      partialGain.connect(partialsSum);
      osc.start(now);
      const lifetime = ATTACK_SECONDS + decay + 0.05;
      osc.stop(now + lifetime);
      maxLifetime = Math.max(maxLifetime, lifetime);
    }

    const dryGain = context.createGain();
    dryGain.gain.value = outputPeak;
    const sendGain = context.createGain();
    sendGain.gain.value = outputPeak * profile.reverbSend;
    partialsSum.connect(dryGain);
    partialsSum.connect(sendGain);
    sendGain.connect(this._convolver);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(dryGain as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);

    setTimeout(() => {
      this._scene.remove(sound);
      dryGain.disconnect();
      sendGain.disconnect();
      partialsSum.disconnect();
      onDone();
    }, maxLifetime * 1000);
  }
}
