import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Inharmonic partial ratios — real glass/bells ring at non-integer
// frequency ratios, which is what makes additive synthesis read as
// "glassy/bell-like" rather than a flute-ish pure harmonic tone.
interface TwinkleProfile {
  partialRatios: number[];
  partialGains: number[]; // seconds-independent peak gain per partial
  partialDecay: number[]; // seconds — higher partials fade fastest, like real glass
  freqMin: number; // Hz
  freqMax: number; // Hz
  outputGainMin: number;
  outputGainMax: number;
  reverbSend: number;
  maxVoices: number;
}

const ATTACK_SECONDS = 0.006;
// Speed (m/s) at which pitch/brightness/volume reach their max — matches
// Stardust's own GatherableFieldParams.fastSpeed-ish range, not an
// arbitrary number.
const SPEED_FOR_MAX_BRIGHTNESS = 1.8;

// The full "caught it" chime — lightened/shortened per earlier feedback,
// then pushed higher/more reverberant per a later pass (was
// [1400,2600]/reverbSend 0.35).
const CATCH_PROFILE: TwinkleProfile = {
  partialRatios: [1.0, 2.4, 3.76, 5.4],
  partialGains: [0.85, 0.45, 0.22, 0.12],
  partialDecay: [0.3, 0.22, 0.15, 0.1],
  freqMin: 1900,
  freqMax: 3400,
  outputGainMin: 0.1,
  outputGainMax: 0.24,
  reverbSend: 0.55,
  maxVoices: 10,
};

// The "you've picked this one up" cue — fires on every particle the instant
// it starts being pulled toward the hand, not just on capture, so it needs
// to be quiet/light enough to not compete with (or precede-and-spoil) the
// fuller catch chime moments later.
const PICKUP_PROFILE: TwinkleProfile = {
  partialRatios: [1.0, 2.7],
  partialGains: [0.55, 0.22],
  partialDecay: [0.09, 0.06],
  freqMin: 2200,
  freqMax: 3200,
  outputGainMin: 0.025,
  outputGainMax: 0.06,
  reverbSend: 0.4,
  maxVoices: 16,
};

// Major pentatonic (root, M2, M3, P5, M6), in semitones — every twinkle's
// fundamental snaps to the nearest degree of this scale (anchored at each
// profile's own freqMin) so a flurry of catches/pickups always sounds
// musically related instead of continuously/arbitrarily pitched.
const PENTATONIC_DEGREES = [0, 2, 4, 7, 9];

// With only 5 scale degrees and a fairly narrow speed range, many
// catches/pickups land on the exact same note — this layers a continuous
// detune (in cents, applied AFTER the pentatonic snap so there's still a
// clear tonal center) driven by how far the catch/pickup happened from the
// player's head, so same-note events still sound distinguishable from each
// other rather than repeating identically.
const DISTANCE_PITCH_CENTS = 160; // +/- range
const DISTANCE_MIN = 0.25; // meters — near captureDistance/attractRadius scale
const DISTANCE_MAX = 1.8; // meters — Stardust's own spawnRadiusMax

const REVERB_DURATION = 1.9; // seconds — was 1.3, lusher/longer tail
const REVERB_DECAY_EXPONENT = 3;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Snaps freq to the nearest note of PENTATONIC_DEGREES, in whichever octave
// (relative to rootFreq) puts it closest.
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
  // Also consider the next octave's root (12 semitones up) — the scale
  // wraps, so a note near the top of this octave may be closer to it.
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

// Generative "glass twinkle" — additive synthesis (a few inharmonic sine
// partials, fast attack, short per-partial exponential decay) fed through a
// single shared reverb bus. Two profiles: a fuller CATCH_PROFILE chime for
// captures, and a quiet, shorter PICKUP_PROFILE cue for every particle the
// moment it starts being pulled toward the hand. Not a System — a plain
// class driven by explicit build()/playCatch()/playPickup() calls, same
// idiom as HeartBurstPool/PlanetGrowthPool. IWSDK's own AudioSource/
// AudioUtils layer is buffer-only (see stardust-vfx-system.ts's own comment
// on why this needs its own AudioListener) — this bypasses that layer
// entirely and talks to Web Audio directly via
// THREE.PositionalAudio.setNodeSource().
export class TwinkleSynth {
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
    // The reverb tail is diffuse/ambient by nature — one shared, non-
    // positional bus every voice sends a portion of its dry signal into,
    // rather than a convolver per voice.
    this._convolver.connect(listener.gain);

    // Browsers start AudioContexts 'suspended' until a real user gesture
    // unlocks them — attempt the unlock as early as possible (harmless
    // no-op once already running). Without this, play() below would just
    // keep retrying resume() on every call until something finally unlocks
    // it, which still works but wastes a call each time.
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

  private _play(profile: TwinkleProfile, position: Vector3, speed: number, onDone: () => void): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      // Scheduling nodes now would be pointless AND actively harmful: our
      // cleanup below runs on a real wall-clock setTimeout, which keeps
      // ticking even while the context is suspended (frozen at whatever
      // currentTime it was at) — so the nodes would get torn down before
      // the context ever wakes up to actually render them, i.e. permanent
      // silence. Skip this one voice (it's a cosmetic sound, not
      // gameplay-critical) and keep nudging the context toward unlocking so
      // the very next call succeeds normally.
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
      osc.type = 'sine';
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
