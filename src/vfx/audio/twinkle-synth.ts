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

// The full "caught it" chime — lightened/shortened from the original pass
// per feedback (was [1.0,0.55,0.3,0.18]/[0.45,0.32,0.22,0.15]/[0.12,0.3]).
const CATCH_PROFILE: TwinkleProfile = {
  partialRatios: [1.0, 2.4, 3.76, 5.4],
  partialGains: [0.85, 0.45, 0.22, 0.12],
  partialDecay: [0.3, 0.22, 0.15, 0.1],
  freqMin: 1400,
  freqMax: 2600,
  outputGainMin: 0.1,
  outputGainMax: 0.24,
  reverbSend: 0.35,
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
  freqMin: 1700,
  freqMax: 2500,
  outputGainMin: 0.025,
  outputGainMax: 0.06,
  reverbSend: 0.18,
  maxVoices: 16,
};

const REVERB_DURATION = 1.3; // seconds
const REVERB_DECAY_EXPONENT = 3;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
    const now = context.currentTime;
    const t = clamp01(speed / SPEED_FOR_MAX_BRIGHTNESS);
    const baseFreq = lerp(profile.freqMin, profile.freqMax, t);
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
