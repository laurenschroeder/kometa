import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Orbit — warm, low, settling: a stable major triad, slower decay, no pitch
// movement. Reads as "staying put."
const ORBIT_ROOT = 220;
const ORBIT_RATIOS = [1.0, 1.25, 1.5];
// The Great Unknown — brighter, higher, open: an ascending arpeggio with a
// slight upward pitch drift on the last note. Reads as "heading outward."
const UNKNOWN_ROOT = 380;
const UNKNOWN_RATIOS = [1.0, 1.5, 2.0];
const UNKNOWN_STAGGER = 0.07;
const UNKNOWN_RISE_CENTS = 40;

const COMMIT_ATTACK = 0.02;
const COMMIT_DECAY = 0.9;
const COMMIT_GAIN = 0.12;

// Detach whoosh — bigger/longer than the comet's own release whoosh
// (comet-interaction-synth.ts) since this is the actual "you're gone" launch
// moment, plus a soft low swelling "bloom" tail underneath it for a
// satisfying finish rather than just cutting off.
const DETACH_DURATION = 0.7;
const DETACH_FREQ_MIN = 250;
const DETACH_FREQ_MAX = 2600;
const DETACH_GAIN = 0.2;
const BLOOM_FREQ = 90;
const BLOOM_ATTACK = 0.15;
const BLOOM_DECAY = 1.0;
const BLOOM_GAIN = 0.1;

const REVERB_DURATION = 2.2;
const REVERB_DECAY_EXPONENT = 2.4;
const REVERB_SEND = 0.4;

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

// Orbital Launch's two audio beats: committing to Orbit or The Great
// Unknown (see OrbitalLaunchSystem._commit, already fires ORBIT_COMMIT_
// MESSAGE/UNKNOWN_COMMIT_MESSAGE), and the detach itself (_detach — the
// comet actually being released to autopilot). Same raw-Web-Audio-via-
// PositionalAudio.setNodeSource technique as every other synth here.
export class OrbitalLaunchSynth {
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
    this._noiseBuffer = buildNoiseBuffer(context, DETACH_DURATION);
    context.resume().catch(() => {});
  }

  playCommit(choice: 'orbit' | 'launch', position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;
    const sum = context.createGain();
    sum.gain.value = 1;

    if (choice === 'orbit') {
      for (const ratio of ORBIT_RATIOS) {
        const osc = context.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(ORBIT_ROOT * ratio, now);
        const g = context.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(COMMIT_GAIN, now + COMMIT_ATTACK);
        g.gain.exponentialRampToValueAtTime(0.0001, now + COMMIT_ATTACK + COMMIT_DECAY);
        osc.connect(g);
        g.connect(sum);
        osc.start(now);
        osc.stop(now + COMMIT_ATTACK + COMMIT_DECAY + 0.05);
      }
    } else {
      for (let i = 0; i < UNKNOWN_RATIOS.length; i++) {
        const start = now + i * UNKNOWN_STAGGER;
        const osc = context.createOscillator();
        osc.type = 'sine';
        const freq = UNKNOWN_ROOT * UNKNOWN_RATIOS[i];
        osc.frequency.setValueAtTime(freq, start);
        if (i === UNKNOWN_RATIOS.length - 1) {
          osc.frequency.exponentialRampToValueAtTime(
            freq * Math.pow(2, UNKNOWN_RISE_CENTS / 1200),
            start + COMMIT_DECAY * 0.6,
          );
        }
        const g = context.createGain();
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(COMMIT_GAIN, start + COMMIT_ATTACK);
        g.gain.exponentialRampToValueAtTime(0.0001, start + COMMIT_ATTACK + COMMIT_DECAY);
        osc.connect(g);
        g.connect(sum);
        osc.start(start);
        osc.stop(start + COMMIT_ATTACK + COMMIT_DECAY + 0.05);
      }
    }

    const dry = context.createGain();
    dry.gain.value = 1;
    const send = context.createGain();
    send.gain.value = REVERB_SEND;
    sum.connect(dry);
    sum.connect(send);
    send.connect(this._convolver);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(dry as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);

    const lifetime =
      (choice === 'launch' ? (UNKNOWN_RATIOS.length - 1) * UNKNOWN_STAGGER : 0) + COMMIT_ATTACK + COMMIT_DECAY + 0.1;
    setTimeout(() => {
      this._scene.remove(sound);
      sum.disconnect();
    }, lifetime * 1000);
  }

  playDetach(position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;

    const noise = context.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.0;
    filter.frequency.setValueAtTime(DETACH_FREQ_MIN, now);
    filter.frequency.linearRampToValueAtTime(DETACH_FREQ_MAX, now + DETACH_DURATION * 0.55);
    filter.frequency.exponentialRampToValueAtTime(DETACH_FREQ_MIN * 0.5, now + DETACH_DURATION);
    const whooshGain = context.createGain();
    whooshGain.gain.setValueAtTime(0, now);
    whooshGain.gain.linearRampToValueAtTime(DETACH_GAIN, now + 0.05);
    whooshGain.gain.exponentialRampToValueAtTime(0.0001, now + DETACH_DURATION);
    noise.connect(filter);
    filter.connect(whooshGain);

    const bloom = context.createOscillator();
    bloom.type = 'sine';
    bloom.frequency.value = BLOOM_FREQ;
    const bloomGain = context.createGain();
    bloomGain.gain.setValueAtTime(0, now);
    bloomGain.gain.linearRampToValueAtTime(BLOOM_GAIN, now + BLOOM_ATTACK);
    bloomGain.gain.exponentialRampToValueAtTime(0.0001, now + BLOOM_ATTACK + BLOOM_DECAY);
    bloom.connect(bloomGain);

    const sum = context.createGain();
    sum.gain.value = 1;
    whooshGain.connect(sum);
    bloomGain.connect(sum);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);

    noise.start(now);
    noise.stop(now + DETACH_DURATION);
    bloom.start(now);
    bloom.stop(now + BLOOM_ATTACK + BLOOM_DECAY + 0.05);

    const lifetime = Math.max(DETACH_DURATION, BLOOM_ATTACK + BLOOM_DECAY) + 0.1;
    setTimeout(() => {
      this._scene.remove(sound);
      sum.disconnect();
      whooshGain.disconnect();
      bloomGain.disconnect();
    }, lifetime * 1000);
  }
}
