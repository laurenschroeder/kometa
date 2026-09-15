import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Same additive-synthesis/shared-reverb-bus skeleton TwinkleSynth/
// PixelTwinkleSynth use, but tuned for a "glittery, magical, fizzy" character
// distinct from either — the swirl finale used to reuse PixelTwinkleSynth's
// square-wave chiptune chime, which read too close to the pebble pickup
// chime's own additive-twinkle shape. Two things make this read as its own
// thing: more partials than either sibling, each nudged by a small per-play
// random detune (so a flurry of catches sparkles rather than repeating the
// exact same chord), and a short bandpass-filtered noise burst layered under
// every hit — the "fizz," like a struck sparkler — that neither sibling has.
interface SwirlProfile {
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
  // Fraction (+/-) of random detune applied per partial per play — the
  // "glitter": no two hits sound quite identical.
  detuneJitter: number;
  // Fizz noise burst — bandpass-filtered around fizzFreqRatio * baseFreq,
  // gain scaled by fizzGain relative to the tone's own outputPeak.
  fizzGain: number;
  fizzDecay: number;
  fizzFreqRatio: number;
  fizzQ: number;
}

const ATTACK_SECONDS = 0.005;
const SPEED_FOR_MAX_BRIGHTNESS = 1.8;

// Bright, widely-spread partials (well into "chime" territory) rather than a
// clean harmonic stack — reads as glassy/sparkly rather than musical-bell.
const CATCH_PROFILE: SwirlProfile = {
  partialRatios: [1.0, 2.0, 3.17, 4.5, 6.3],
  partialGains: [0.75, 0.55, 0.38, 0.24, 0.14],
  partialDecay: [0.5, 0.4, 0.32, 0.24, 0.16],
  partialTypes: ['sine', 'triangle', 'sine', 'triangle', 'sine'],
  freqMin: 2600,
  freqMax: 4600,
  outputGainMin: 0.09,
  outputGainMax: 0.22,
  reverbSend: 0.6,
  maxVoices: 12,
  detuneJitter: 0.012,
  fizzGain: 0.5,
  fizzDecay: 0.16,
  fizzFreqRatio: 3.2,
  fizzQ: 3.5,
};

const PICKUP_PROFILE: SwirlProfile = {
  partialRatios: [1.0, 2.8],
  partialGains: [0.5, 0.24],
  partialDecay: [0.1, 0.07],
  partialTypes: ['sine', 'triangle'],
  freqMin: 3000,
  freqMax: 4200,
  outputGainMin: 0.02,
  outputGainMax: 0.05,
  reverbSend: 0.45,
  maxVoices: 18,
  detuneJitter: 0.018,
  fizzGain: 0.35,
  fizzDecay: 0.07,
  fizzFreqRatio: 3.6,
  fizzQ: 3,
};

const PENTATONIC_DEGREES = [0, 2, 4, 7, 9];

const DISTANCE_PITCH_CENTS = 160;
const DISTANCE_MIN = 0.25;
const DISTANCE_MAX = 1.8;

// Longer and airier than either sibling's reverb — "magical" ambience rather
// than a tight glassy slap-back.
const REVERB_DURATION = 2.8;
const REVERB_DECAY_EXPONENT = 2;

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
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, REVERB_DECAY_EXPONENT);
    }
  }
  return buffer;
}

// A few seconds of plain white noise, reused (via a fresh BufferSource) for
// every fizz burst rather than rebuilt per play — only the envelope/filter
// around it change per hit.
const NOISE_BUFFER_SECONDS = 2;
function buildNoiseBuffer(context: AudioContext): AudioBuffer {
  const length = Math.floor(context.sampleRate * NOISE_BUFFER_SECONDS);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Stardust swirl finale's own "glittery/magical/fizzy" catch+pickup cue —
// used in place of PixelTwinkleSynth once StardustSystem's swirls begin (see
// stardust-vfx-system.ts). Not a System — a plain class driven by explicit
// build()/playCatch()/playPickup() calls, same idiom as TwinkleSynth/
// PebbleSynth/HeartBurstPool.
export class SwirlSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _noiseBuffer!: AudioBuffer;
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
    this._noiseBuffer = buildNoiseBuffer(context);
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

  private _play(profile: SwirlProfile, position: Vector3, speed: number, onDone: () => void): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      onDone();
      return;
    }

    const now = context.currentTime;
    const t = clamp01(speed / SPEED_FOR_MAX_BRIGHTNESS);
    // Descending, not ascending — a faster swing lands a LOWER tone (t=1 ->
    // freqMin) rather than a higher one, reading as settling/coming to rest
    // rather than an excited climb, same "materializing, not building" idea
    // as the swirl finale itself. freqMin stays the pentatonic root
    // reference below regardless of which end of the range t lands on.
    const rawFreq = lerp(profile.freqMax, profile.freqMin, t);
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
      // Glitter: a small random detune per partial per play, so repeated
      // hits at the same pitch bucket never sound quite identical.
      const jitter = 1 + (Math.random() * 2 - 1) * profile.detuneJitter;
      const osc = context.createOscillator();
      osc.type = profile.partialTypes?.[k] ?? 'sine';
      osc.frequency.value = baseFreq * profile.partialRatios[k] * jitter;

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

    // Fizz — a short bandpass-filtered noise burst, like a struck sparkler,
    // summed into the same partialsSum bus so it shares the tone's own
    // dry/reverb split below.
    const fizzSource = context.createBufferSource();
    fizzSource.buffer = this._noiseBuffer;
    fizzSource.loop = true;
    const fizzFilter = context.createBiquadFilter();
    fizzFilter.type = 'bandpass';
    fizzFilter.frequency.value = baseFreq * profile.fizzFreqRatio;
    fizzFilter.Q.value = profile.fizzQ;
    const fizzGainNode = context.createGain();
    const fizzPeak = profile.fizzGain * outputPeak;
    fizzGainNode.gain.setValueAtTime(0, now);
    fizzGainNode.gain.linearRampToValueAtTime(fizzPeak, now + ATTACK_SECONDS);
    fizzGainNode.gain.exponentialRampToValueAtTime(0.0001, now + ATTACK_SECONDS + profile.fizzDecay);
    fizzSource.connect(fizzFilter);
    fizzFilter.connect(fizzGainNode);
    fizzGainNode.connect(partialsSum);
    const fizzLifetime = ATTACK_SECONDS + profile.fizzDecay + 0.05;
    fizzSource.start(now);
    fizzSource.stop(now + fizzLifetime);
    maxLifetime = Math.max(maxLifetime, fizzLifetime);

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
