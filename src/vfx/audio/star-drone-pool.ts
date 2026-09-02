import { AudioListener, PositionalAudio, Scene } from '@iwsdk/core';

const MAX_VOICES = 10;
const BASE_FREQ = 110; // A2 — low and ambient, not melodic
// Two octaves of major pentatonic, one fixed degree per voice index — with
// up to MAX_VOICES drones sounding at once, this keeps however many are
// currently playing a consonant cluster instead of a dissonant mess.
const SCALE_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
const DETUNE_CENTS = 5; // gentle beating between each voice's two oscillators
const FILTER_CUTOFF = 900;
const PEAK_GAIN = 0.06; // quiet even with several voices layered
const FADE_IN_SECONDS = 1.4;
const FADE_OUT_SECONDS = 0.5;
const LFO_RATE = 0.15; // Hz — slow "breathing" swell
const LFO_DEPTH = 0.35; // fraction of PEAK_GAIN
const REVERB_DURATION = 3.2;
const REVERB_DECAY_EXPONENT = 2.5;
const REVERB_SEND = 0.5;

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

interface Voice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  sendGain: GainNode;
  sound: PositionalAudio;
}

// Sustained, quiet ambient drone per constellation star — up to MAX_VOICES
// simultaneous, one per star, positionally anchored and live-tracked (see
// updatePositions()). Each voice is two gently-detuned sine oscillators
// (soft beating/warmth) through a lowpass filter and a slow gain LFO
// ("breathing"), partly sent into a shared reverb bus for "beautiful"
// instead of flat. Touching a star stops just that one voice (see stop()) —
// the "pretty twinkle" on touch is a separate, unrelated sound (see
// ConstellationsVfxSystem's own TwinkleSynth). Not a System — a plain
// class driven by explicit build()/startAll()/updatePositions()/stop()/
// stopAll() calls, same idiom as HeartBurstPool/PlanetGrowthPool. Same raw-
// Web-Audio-via-PositionalAudio.setNodeSource technique as TwinkleSynth/
// PlanetSpinSynth (IWSDK's AudioSource/AudioUtils layer is buffer-only, no
// generative-audio hook).
export class StarDronePool {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _voices: (Voice | null)[] = new Array(MAX_VOICES).fill(null);

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;
    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    context.resume().catch(() => {});
  }

  // Starts (or restarts) drones for star indices [0, count), positioned
  // from posArray (a star-position Float32Array, xyz per star — same array
  // ConstellationsVfxSystem live-updates every frame).
  startAll(count: number, posArray: Float32Array): void {
    for (let i = 0; i < count && i < MAX_VOICES; i++) {
      this._start(i, posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    }
  }

  private _start(index: number, x: number, y: number, z: number): void {
    this.stop(index);
    const context = this._listener.context;
    if (context.state !== 'running') {
      // Cosmetic-only ambience, not gameplay-critical — skip this voice
      // rather than scheduling nodes a suspended context would never
      // actually render, and nudge toward unlocking for next time.
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;
    const freq = BASE_FREQ * Math.pow(2, SCALE_SEMITONES[index % SCALE_SEMITONES.length] / 12);

    const oscA = context.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(freq, now);
    oscA.detune.setValueAtTime(-DETUNE_CENTS, now);

    const oscB = context.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.setValueAtTime(freq, now);
    oscB.detune.setValueAtTime(DETUNE_CENTS, now);

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_CUTOFF;
    filter.Q.value = 0.7;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + FADE_IN_SECONDS);

    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = LFO_RATE;
    const lfoGain = context.createGain();
    lfoGain.gain.value = PEAK_GAIN * LFO_DEPTH;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(gain);

    const sendGain = context.createGain();
    sendGain.gain.value = REVERB_SEND;
    gain.connect(sendGain);
    sendGain.connect(this._convolver);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(gain as unknown as AudioScheduledSourceNode);
    sound.position.set(x, y, z);
    this._scene.add(sound);

    oscA.start(now);
    oscB.start(now);
    lfo.start(now);

    this._voices[index] = { oscA, oscB, lfo, lfoGain, gain, filter, sendGain, sound };
  }

  // Live-syncs every currently-active voice's position — call every frame
  // while the constellation is revealed, since star positions move as the
  // planet does (see ConstellationsVfxSystem._applyLiveOffsets).
  updatePositions(posArray: Float32Array, count: number): void {
    for (let i = 0; i < count && i < MAX_VOICES; i++) {
      const voice = this._voices[i];
      if (!voice) continue;
      voice.sound.position.set(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]);
    }
  }

  // Fades out and hard-stops one star's drone. Safe to call on an
  // already-stopped/never-started index.
  stop(index: number): void {
    const voice = this._voices[index];
    if (!voice) return;
    this._voices[index] = null;
    const context = this._listener.context;
    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SECONDS);
    voice.oscA.stop(now + FADE_OUT_SECONDS + 0.02);
    voice.oscB.stop(now + FADE_OUT_SECONDS + 0.02);
    voice.lfo.stop(now + FADE_OUT_SECONDS + 0.02);
    setTimeout(() => {
      this._scene.remove(voice.sound);
      voice.gain.disconnect();
      voice.filter.disconnect();
      voice.lfoGain.disconnect();
      voice.sendGain.disconnect();
    }, (FADE_OUT_SECONDS + 0.05) * 1000);
  }

  stopAll(): void {
    for (let i = 0; i < MAX_VOICES; i++) this.stop(i);
  }
}
