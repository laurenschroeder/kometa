import { AudioListener, PositionalAudio, Scene, Vector3 } from '@iwsdk/core';

// Major triad + octave, ascending — the classic "unlock" shape.
const NOTE_RATIOS = [1.0, 1.26, 1.5, 2.0];
const NOTE_STAGGER = 0.09; // seconds between each note's start
const ROOT_FREQ = 520;
const NOTE_ATTACK = 0.006;
const NOTE_DECAY = 0.35;
const NOTE_GAIN = 0.14;
const REVERB_DURATION = 1.8;
const REVERB_DECAY_EXPONENT = 2.6;
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

// A short, bright ascending arpeggio — AchievementSystem's own "unlock" cue,
// currently a HUD-text-only moment. Same raw-Web-Audio-via-
// PositionalAudio.setNodeSource technique as every other synth here. Not
// positioned on any particular gameplay object (achievements aren't tied to
// a world location) — callers just pass roughly where the player is looking.
export class AchievementSynth {
  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;

  build(listener: AudioListener, scene: Scene): void {
    this._listener = listener;
    this._scene = scene;
    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    context.resume().catch(() => {});
  }

  playUnlock(position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;

    const sum = context.createGain();
    sum.gain.value = 1;

    for (let i = 0; i < NOTE_RATIOS.length; i++) {
      const start = now + i * NOTE_STAGGER;
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = ROOT_FREQ * NOTE_RATIOS[i];

      const partial2 = context.createOscillator();
      partial2.type = 'sine';
      partial2.frequency.value = ROOT_FREQ * NOTE_RATIOS[i] * 2;

      const g = context.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(NOTE_GAIN, start + NOTE_ATTACK);
      g.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_ATTACK + NOTE_DECAY);

      const partial2Gain = context.createGain();
      partial2Gain.gain.value = 0.3;

      osc.connect(g);
      partial2.connect(partial2Gain);
      partial2Gain.connect(g);
      g.connect(sum);

      osc.start(start);
      osc.stop(start + NOTE_ATTACK + NOTE_DECAY + 0.05);
      partial2.start(start);
      partial2.stop(start + NOTE_ATTACK + NOTE_DECAY + 0.05);
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

    const totalLifetime = (NOTE_RATIOS.length - 1) * NOTE_STAGGER + NOTE_ATTACK + NOTE_DECAY + 0.1;
    setTimeout(() => {
      this._scene.remove(sound);
      sum.disconnect();
    }, totalLifetime * 1000);
  }
}
