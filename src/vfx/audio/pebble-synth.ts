import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Same additive-synthesis/shared-reverb-bus architecture as
// vfx/audio/twinkle-synth.ts (Stardust's "glass twinkle"), but tuned for a
// deeper, more resonant feel (lower freqMin/freqMax, longer partialDecay,
// a longer/softer reverb tail) and split into three distinct timbres keyed
// by pebble type — id ordering matches pebble-type.ts's PEBBLE_TYPES (0=soul
// dust/blue/"heavenly", 1=organic matter/green/"earthy-pleasant", 2=volatile
// gasses/red/"harsh"). Not shared with TwinkleSynth (separate convolver/
// reverb impulse, separate profile shape) since the two need independently
// tunable reverb characters and per-type profile maps don't fit
// TwinkleSynth's single-profile design.
interface PebbleProfile {
  partialRatios: number[];
  partialGains: number[]; // seconds-independent peak gain per partial
  partialDecay: number[]; // seconds
  // Per-partial oscillator waveform; omitted entries (and the whole array,
  // for the harmonic-ratio profiles) default to 'sine'. Red's sawtooth
  // partials are what add grit on top of its already-dissonant ratios.
  partialTypes?: OscillatorType[];
  freqMin: number; // Hz
  freqMax: number; // Hz
  outputGainMin: number;
  outputGainMax: number;
  reverbSend: number;
  maxVoices: number;
  attackSeconds: number;
  // Red (harsh) only — a fast downward pitch scoop right at the attack: the
  // partial starts above its target frequency and slides down into it. That
  // "clang" reads as grinding/metallic rather than a clean tone.
  clangBendCents?: number;
  clangBendSeconds?: number;
  // Blue (heavenly) only — a second copy of every partial, detuned by this
  // many cents, summed in alongside the first. Two near-identical sines
  // beating gently against each other is what reads as shimmering/
  // choir-like rather than a single clean tone.
  shimmerDetuneCents?: number;
}

const ATTACK_DEFAULT = 0.012;
// Matches Pebbles' own PebbleWeavingSystem FAST_SPEED (1.5) with the same
// small headroom TwinkleSynth's SPEED_FOR_MAX_BRIGHTNESS gives Stardust's.
const SPEED_FOR_MAX_BRIGHTNESS = 1.8;

// ── Red / volatile gasses — harsh ───────────────────────────────────────
// Closely-packed, non-harmonic ratios (no clean octave/fifth among them)
// grind against each other instead of blending; sawtooth on the lower two
// partials adds extra edge on top of that dissonance.
const RED_CATCH: PebbleProfile = {
  partialRatios: [1.0, 1.5, 2.37, 3.1],
  partialGains: [0.85, 0.55, 0.4, 0.28],
  partialDecay: [0.55, 0.42, 0.32, 0.22],
  partialTypes: ['sawtooth', 'sawtooth', 'sine', 'sine'],
  freqMin: 110,
  freqMax: 190,
  outputGainMin: 0.12,
  outputGainMax: 0.27,
  // Drier than the other two — harsh should feel like it's right in your
  // face, not softened by a pretty ambience.
  reverbSend: 0.32,
  maxVoices: 10,
  attackSeconds: 0.003,
  clangBendCents: -140,
  clangBendSeconds: 0.05,
};
const RED_PICKUP: PebbleProfile = {
  partialRatios: [1.0, 1.5],
  partialGains: [0.5, 0.3],
  partialDecay: [0.14, 0.1],
  partialTypes: ['sawtooth', 'sine'],
  freqMin: 110,
  freqMax: 190,
  outputGainMin: 0.03,
  outputGainMax: 0.07,
  reverbSend: 0.28,
  maxVoices: 16,
  attackSeconds: 0.003,
  clangBendCents: -90,
  clangBendSeconds: 0.03,
};

// ── Green / organic matter — pleasant, earthy ───────────────────────────
// A clean integer harmonic series (root/octave/fifth/two-octaves) is what
// reads as warm and consonant — the "woody" counterpart to red's clashing
// ratios — with a longer, gentler decay than red for a mellow ring.
const GREEN_CATCH: PebbleProfile = {
  partialRatios: [1.0, 2.0, 3.0, 4.0],
  partialGains: [0.9, 0.5, 0.28, 0.14],
  partialDecay: [0.85, 0.62, 0.46, 0.3],
  freqMin: 150,
  freqMax: 260,
  outputGainMin: 0.12,
  outputGainMax: 0.26,
  reverbSend: 0.5,
  maxVoices: 10,
  attackSeconds: 0.012,
};
const GREEN_PICKUP: PebbleProfile = {
  partialRatios: [1.0, 2.0],
  partialGains: [0.5, 0.24],
  partialDecay: [0.22, 0.16],
  freqMin: 150,
  freqMax: 260,
  outputGainMin: 0.03,
  outputGainMax: 0.07,
  reverbSend: 0.4,
  maxVoices: 16,
  attackSeconds: 0.01,
};

// ── Blue / soul dust — heavenly ─────────────────────────────────────────
// An extended, just-intonation-ish series (root/octave/fifth/major-third-
// two-octaves-up/three-octaves-up) reaches further into the overtones than
// green's for an airier, more open quality; shimmerDetuneCents adds the
// choir-like beating; the longest decay and biggest reverb send of the
// three completes the "heavenly" feel.
const BLUE_CATCH: PebbleProfile = {
  partialRatios: [1.0, 2.0, 3.0, 5.0, 8.0],
  partialGains: [0.75, 0.5, 0.32, 0.2, 0.12],
  partialDecay: [1.1, 0.9, 0.7, 0.55, 0.4],
  freqMin: 300,
  freqMax: 480,
  outputGainMin: 0.1,
  outputGainMax: 0.22,
  reverbSend: 0.7,
  maxVoices: 10,
  attackSeconds: 0.018,
  shimmerDetuneCents: 7,
};
const BLUE_PICKUP: PebbleProfile = {
  partialRatios: [1.0, 3.0],
  partialGains: [0.45, 0.22],
  partialDecay: [0.3, 0.22],
  freqMin: 300,
  freqMax: 480,
  outputGainMin: 0.025,
  outputGainMax: 0.06,
  reverbSend: 0.55,
  maxVoices: 16,
  attackSeconds: 0.014,
  shimmerDetuneCents: 6,
};

// Keyed by pebble type id (see pebble-type.ts) — 0=blue/heavenly,
// 1=green/earthy, 2=red/harsh.
const CATCH_PROFILES: Record<number, PebbleProfile> = { 0: BLUE_CATCH, 1: GREEN_CATCH, 2: RED_CATCH };
const PICKUP_PROFILES: Record<number, PebbleProfile> = { 0: BLUE_PICKUP, 1: GREEN_PICKUP, 2: RED_PICKUP };

// Major pentatonic (root, M2, M3, P5, M6), in semitones — same technique as
// TwinkleSynth: every voice's fundamental snaps to the nearest degree of
// this scale (anchored at the profile's own freqMin) so simultaneous
// catches/pickups always sound musically related.
const PENTATONIC_DEGREES = [0, 2, 4, 7, 9];

// Distance-based detune so same-note events (same profile, same speed
// bucket) still sound distinguishable from each other — mirrors
// TwinkleSynth's own DISTANCE_* constants; the Pebbles field uses the exact
// same spawn/attract geometry as Stardust's, so the same range applies.
const DISTANCE_PITCH_CENTS = 160;
const DISTANCE_MIN = 0.25;
const DISTANCE_MAX = 1.8;

// Longer, softer-kneed than TwinkleSynth's own reverb (1.9s / exponent 3) —
// this is the "deeper and more resonant" character applied to the shared
// ambience itself, not just per-voice tuning.
const REVERB_DURATION = 2.6;
const REVERB_DECAY_EXPONENT = 2.2;

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

// Generative, per-pebble-type "resonant tone" — see the file comment for how
// this differs from TwinkleSynth. Not a System — a plain class driven by
// explicit build()/playCatch()/playPickup() calls, same idiom as
// TwinkleSynth/HeartBurstPool/PlanetGrowthPool.
export class PebbleSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _activeCatchVoices: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  private _activePickupVoices: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  private _scratchListenerPos = new Vector3();

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;

    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);

    // See TwinkleSynth's identical comment: harmless no-op once already
    // running, otherwise nudges the AudioContext past the browser's
    // gesture-gated 'suspended' start state as early as possible.
    context.resume().catch(() => {});
  }

  playCatch(type: number, position: Vector3, speed: number): void {
    const profile = CATCH_PROFILES[type];
    if (!profile) return;
    if ((this._activeCatchVoices[type] ?? 0) >= profile.maxVoices) return;
    this._activeCatchVoices[type] = (this._activeCatchVoices[type] ?? 0) + 1;
    this._play(profile, position, speed, () => {
      this._activeCatchVoices[type]--;
    });
  }

  playPickup(type: number, position: Vector3, speed: number): void {
    const profile = PICKUP_PROFILES[type];
    if (!profile) return;
    if ((this._activePickupVoices[type] ?? 0) >= profile.maxVoices) return;
    this._activePickupVoices[type] = (this._activePickupVoices[type] ?? 0) + 1;
    this._play(profile, position, speed, () => {
      this._activePickupVoices[type]--;
    });
  }

  private _play(profile: PebbleProfile, position: Vector3, speed: number, onDone: () => void): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      // See TwinkleSynth's identical guard/comment — skip this one cosmetic
      // voice rather than scheduling nodes a frozen-suspended context will
      // never actually render.
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
    const attack = profile.attackSeconds ?? ATTACK_DEFAULT;

    const partialsSum = context.createGain();
    partialsSum.gain.value = 1;

    let maxLifetime = 0;
    for (let k = 0; k < profile.partialRatios.length; k++) {
      const freq = baseFreq * profile.partialRatios[k];
      const decay = profile.partialDecay[k];
      const peak = profile.partialGains[k] * (k === 0 ? 1 : brightness);
      const oscType: OscillatorType = profile.partialTypes?.[k] ?? 'sine';
      const lifetime = attack + decay + 0.05;
      maxLifetime = Math.max(maxLifetime, lifetime);

      const partialGain = context.createGain();
      partialGain.gain.setValueAtTime(0, now);
      partialGain.gain.linearRampToValueAtTime(peak, now + attack);
      partialGain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

      const osc = context.createOscillator();
      osc.type = oscType;
      if (profile.clangBendCents) {
        const startFreq = freq * Math.pow(2, profile.clangBendCents / 1200);
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(freq, now + (profile.clangBendSeconds ?? 0.05));
      } else {
        osc.frequency.value = freq;
      }
      osc.connect(partialGain);
      partialGain.connect(partialsSum);
      osc.start(now);
      osc.stop(now + lifetime);

      if (profile.shimmerDetuneCents) {
        const shimmerFreq = freq * Math.pow(2, profile.shimmerDetuneCents / 1200);
        const shimmerGain = context.createGain();
        shimmerGain.gain.setValueAtTime(0, now);
        shimmerGain.gain.linearRampToValueAtTime(peak * 0.6, now + attack);
        shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);

        const shimmerOsc = context.createOscillator();
        shimmerOsc.type = oscType;
        shimmerOsc.frequency.value = shimmerFreq;
        shimmerOsc.connect(shimmerGain);
        shimmerGain.connect(partialsSum);
        shimmerOsc.start(now);
        shimmerOsc.stop(now + lifetime);
      }
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
