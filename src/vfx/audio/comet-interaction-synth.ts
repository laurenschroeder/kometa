import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Snap (grab) — a quick, soft, low thump. Two close sine partials, very fast
// attack, short decay — reads as tactile "you've got a firm hold of it" cue.
const SNAP_FREQ = 210;
const SNAP_RATIO2 = 1.5;
const SNAP_GAIN = 0.18;
const SNAP_ATTACK = 0.003;
const SNAP_DECAY = 0.12;

// Catch (hand-to-hand toss/catch) — brighter and higher than snap so the two
// never get confused, with a touch of reverb for a pleasant "got it" sparkle
// (snap/release stay dry — punchy, not pretty).
const CATCH_FREQ = 620;
const CATCH_RATIO2 = 2.4;
const CATCH_GAIN = 0.16;
const CATCH_ATTACK = 0.004;
const CATCH_DECAY = 0.16;
const CATCH_REVERB_SEND = 0.35;

// Release (throw) — filtered white-noise whoosh, bandpass center frequency
// sweeping upward. Speed-scaled: a harder throw gets a louder, higher, more
// dramatic sweep than a gentle release.
const RELEASE_DURATION = 0.35;
const RELEASE_FREQ_MIN = 300;
const RELEASE_FREQ_MAX = 2200;
const RELEASE_GAIN_MIN = 0.05;
const RELEASE_GAIN_MAX = 0.16;
const RELEASE_SPEED_FOR_MAX = 3.0; // matches CometPhysicsSystem's own MOMENTUM_REFERENCE_SPEED

const REVERB_DURATION = 1.4;
const REVERB_DECAY_EXPONENT = 3;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
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

function buildNoiseBuffer(context: AudioContext, duration: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// The comet's own hand-interaction sounds — grab (snap), throw (release),
// and hand-to-hand toss/catch. Same raw-Web-Audio-via-
// PositionalAudio.setNodeSource technique as every other synth in this
// folder (IWSDK's AudioSource/AudioUtils layer is buffer-only). Fire-and-
// forget one-shots, not a voice pool — these can't realistically overlap
// with themselves (there's exactly one comet), unlike Stardust/Pebbles'
// many-simultaneous-particles case.
export class CometInteractionSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _noiseBuffer!: AudioBuffer;

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;
    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    this._noiseBuffer = buildNoiseBuffer(context, RELEASE_DURATION);
    context.resume().catch(() => {});
  }

  playSnap(position: Vector3): void {
    this._playPluck(position, SNAP_FREQ, SNAP_RATIO2, SNAP_GAIN, SNAP_ATTACK, SNAP_DECAY, 0);
  }

  playCatch(position: Vector3): void {
    this._playPluck(position, CATCH_FREQ, CATCH_RATIO2, CATCH_GAIN, CATCH_ATTACK, CATCH_DECAY, CATCH_REVERB_SEND);
  }

  private _playPluck(
    position: Vector3,
    freq: number,
    ratio2: number,
    peakGain: number,
    attack: number,
    decay: number,
    reverbSend: number,
  ): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;

    const sum = context.createGain();
    sum.gain.value = 1;
    const ratios = [1.0, ratio2];
    const gains = [0.8, 0.4];
    for (let i = 0; i < ratios.length; i++) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * ratios[i];
      const g = context.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(gains[i] * peakGain, now + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
      osc.connect(g);
      g.connect(sum);
      osc.start(now);
      osc.stop(now + attack + decay + 0.05);
    }

    const sound = new PositionalAudio(this._listener);
    if (reverbSend > 0) {
      const dry = context.createGain();
      dry.gain.value = 1;
      sum.connect(dry);
      sound.setNodeSource(dry as unknown as AudioScheduledSourceNode);
      const send = context.createGain();
      send.gain.value = reverbSend;
      sum.connect(send);
      send.connect(this._convolver);
    } else {
      sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
    }
    sound.position.copy(position);
    this._scene.add(sound);

    setTimeout(() => {
      this._scene.remove(sound);
      sum.disconnect();
    }, (attack + decay + 0.1) * 1000);
  }

  playRelease(position: Vector3, speed: number): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;
    const t = clamp01(speed / RELEASE_SPEED_FOR_MAX);
    const peakFreq = RELEASE_FREQ_MIN + (RELEASE_FREQ_MAX - RELEASE_FREQ_MIN) * t;
    const peakGain = RELEASE_GAIN_MIN + (RELEASE_GAIN_MAX - RELEASE_GAIN_MIN) * t;

    const noise = context.createBufferSource();
    noise.buffer = this._noiseBuffer;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(RELEASE_FREQ_MIN * 0.6, now);
    filter.frequency.linearRampToValueAtTime(peakFreq, now + RELEASE_DURATION * 0.6);
    filter.frequency.exponentialRampToValueAtTime(RELEASE_FREQ_MIN * 0.4, now + RELEASE_DURATION);

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + RELEASE_DURATION);

    noise.connect(filter);
    filter.connect(gain);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(gain as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);

    noise.start(now);
    noise.stop(now + RELEASE_DURATION);

    setTimeout(() => {
      this._scene.remove(sound);
      gain.disconnect();
      filter.disconnect();
    }, (RELEASE_DURATION + 0.1) * 1000);
  }
}
