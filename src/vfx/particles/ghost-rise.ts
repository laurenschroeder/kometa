import {
  AdditiveBlending,
  AudioListener,
  Mesh,
  MeshBasicMaterial,
  PositionalAudio,
  Scene,
  SphereGeometry,
  Vector3,
  World,
} from '@iwsdk/core';

const GHOST_RADIUS = 0.05;
const RISE_DURATION = 1.5; // seconds, floating straight up from the origin point
const RISE_HEIGHT = 0.2;
const TRAVEL_DURATION = 1.5; // seconds, easing from the rise's end point to the comet
const ORBIT_RADIUS = 0.045; // once attached, a small permanent circling offset from the comet
const ORBIT_SPEED = 1.4; // rad/s

// Ascension shimmer — sustained only through Rising+Traveling (~3s total),
// then fades and hands off to a one-shot "settle" chime the instant it
// attaches (see _settleAscension). A permanent drone would get tiresome
// over the rest of a playthrough; the settle chime is the lasting
// punctuation instead.
const SHIMMER_BASE_FREQ_MIN = 480;
const SHIMMER_BASE_FREQ_MAX = 620;
const SHIMMER_DETUNE_CENTS = 6;
const SHIMMER_SPARKLE_RATIO = 3.0; // third, quiet, high oscillator for airiness
const SHIMMER_FILTER_CUTOFF = 2200;
const SHIMMER_PEAK_GAIN = 0.05;
const SHIMMER_FADE_IN = 1.0;
const SHIMMER_FADE_OUT = 0.6;
const SHIMMER_LFO_RATE = 0.2;
const SHIMMER_LFO_DEPTH = 0.4;
const SHIMMER_REVERB_SEND = 0.6;

const SETTLE_RATIOS = [1.0, 1.5, 2.0]; // gentle resolving triad
const SETTLE_ATTACK = 0.02;
const SETTLE_DECAY = 1.1;
const SETTLE_GAIN = 0.09;

const REVERB_DURATION = 3.5;
const REVERB_DECAY_EXPONENT = 2.2;

const enum GhostState {
  Idle,
  Rising,
  Traveling,
  Attached,
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
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

interface ShimmerVoice {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  sparkle: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  sendGain: GainNode;
  sound: PositionalAudio;
}

// Shared "a soul rises from the planet and permanently attaches to the
// comet" mechanic — Dog (a dog's ghost), Human (a human's ghost), and Crown
// (the king's ghost) all trigger this same single-instance state machine on
// their constellation's completion (see EarthSituationsVfxSystem). Only one
// of the three can ever fire in a playthrough, so this deliberately isn't a
// multi-slot pool like HeartBurstPool — one mesh, one active journey at a
// time. Simple additive glowing-sphere placeholder, tinted per trigger;
// meant to be swapped for a real 3D asset later. Carries its own generative
// audio (an ethereal shimmer while rising/traveling, a soft settle chime on
// arrival) — same raw-Web-Audio-via-PositionalAudio.setNodeSource technique
// as every other synth in vfx/audio/, just kept local here since it's
// entirely driven by this class's own state machine. Not a System — a plain
// class driven by explicit build()/trigger()/update() calls, same idiom as
// HeartBurstPool/PlanetGrowthPool.
export class GhostRise {
  private _mesh!: Mesh;
  private _material!: MeshBasicMaterial;
  private _state: GhostState = GhostState.Idle;
  private _t = 0;
  private _origin = new Vector3();
  private _travelFrom = new Vector3();
  private _orbitAngle = 0;

  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _shimmer: ShimmerVoice | null = null;

  build(world: World, listener: AudioListener, scene: Scene): void {
    this._material = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this._mesh = new Mesh(new SphereGeometry(GHOST_RADIUS, 12, 8), this._material);
    this._mesh.visible = false;
    world.createTransformEntity(this._mesh);

    this._listener = listener;
    this._scene = scene;
    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    context.resume().catch(() => {});
  }

  trigger(origin: Vector3, color: [number, number, number]): void {
    if (this._state !== GhostState.Idle) return; // only one ghost ever, per the mechanic's own design
    this._material.color.setRGB(color[0], color[1], color[2]);
    this._origin.copy(origin);
    this._mesh.position.copy(origin);
    this._mesh.visible = true;
    this._state = GhostState.Rising;
    this._t = 0;
    const brightness = (color[0] + color[1] + color[2]) / 3;
    this._startShimmer(origin, SHIMMER_BASE_FREQ_MIN + (SHIMMER_BASE_FREQ_MAX - SHIMMER_BASE_FREQ_MIN) * brightness);
  }

  update(delta: number, cometPosition: Vector3): void {
    if (this._state === GhostState.Idle) return;

    if (this._state === GhostState.Rising) {
      this._t = Math.min(1, this._t + delta / RISE_DURATION);
      const eased = smoothstep(this._t);
      this._mesh.position.set(this._origin.x, this._origin.y + RISE_HEIGHT * eased, this._origin.z);
      if (this._shimmer) this._shimmer.sound.position.copy(this._mesh.position);
      if (this._t >= 1) {
        this._travelFrom.copy(this._mesh.position);
        this._state = GhostState.Traveling;
        this._t = 0;
      }
      return;
    }

    if (this._state === GhostState.Traveling) {
      this._t = Math.min(1, this._t + delta / TRAVEL_DURATION);
      const eased = smoothstep(this._t);
      this._mesh.position.lerpVectors(this._travelFrom, cometPosition, eased);
      if (this._shimmer) this._shimmer.sound.position.copy(this._mesh.position);
      if (this._t >= 1) {
        this._state = GhostState.Attached;
        this._settleAscension(this._mesh.position);
      }
      return;
    }

    // Attached — permanently circles the comet's live position.
    this._orbitAngle += ORBIT_SPEED * delta;
    this._mesh.position.set(
      cometPosition.x + Math.cos(this._orbitAngle) * ORBIT_RADIUS,
      cometPosition.y + 0.05,
      cometPosition.z + Math.sin(this._orbitAngle) * ORBIT_RADIUS,
    );
  }

  reset(): void {
    this._state = GhostState.Idle;
    this._t = 0;
    this._orbitAngle = 0;
    this._mesh.visible = false;
    this._hardStopShimmer();
  }

  private _startShimmer(position: Vector3, freq: number): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;

    const oscA = context.createOscillator();
    oscA.type = 'sine';
    oscA.frequency.setValueAtTime(freq, now);
    oscA.detune.setValueAtTime(-SHIMMER_DETUNE_CENTS, now);
    const oscB = context.createOscillator();
    oscB.type = 'sine';
    oscB.frequency.setValueAtTime(freq, now);
    oscB.detune.setValueAtTime(SHIMMER_DETUNE_CENTS, now);
    const sparkle = context.createOscillator();
    sparkle.type = 'sine';
    sparkle.frequency.setValueAtTime(freq * SHIMMER_SPARKLE_RATIO, now);

    const sparkleGain = context.createGain();
    sparkleGain.gain.value = 0.25;

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = SHIMMER_FILTER_CUTOFF;
    filter.Q.value = 0.6;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(SHIMMER_PEAK_GAIN, now + SHIMMER_FADE_IN);

    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = SHIMMER_LFO_RATE;
    const lfoGain = context.createGain();
    lfoGain.gain.value = SHIMMER_PEAK_GAIN * SHIMMER_LFO_DEPTH;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    oscA.connect(filter);
    oscB.connect(filter);
    sparkle.connect(sparkleGain);
    sparkleGain.connect(filter);
    filter.connect(gain);

    const sendGain = context.createGain();
    sendGain.gain.value = SHIMMER_REVERB_SEND;
    gain.connect(sendGain);
    sendGain.connect(this._convolver);

    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(gain as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);

    oscA.start(now);
    oscB.start(now);
    sparkle.start(now);
    lfo.start(now);

    this._shimmer = { oscA, oscB, sparkle, lfo, lfoGain, gain, filter, sendGain, sound };
  }

  // Fades the sustained shimmer out and plays a one-shot settle chime —
  // called once, the instant the ghost reaches the comet.
  private _settleAscension(position: Vector3): void {
    this._fadeOutShimmer();

    const context = this._listener.context;
    if (context.state !== 'running') return;
    const now = context.currentTime;
    const sum = context.createGain();
    sum.gain.value = 1;
    for (const ratio of SETTLE_RATIOS) {
      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = SHIMMER_BASE_FREQ_MIN * ratio;
      const g = context.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(SETTLE_GAIN, now + SETTLE_ATTACK);
      g.gain.exponentialRampToValueAtTime(0.0001, now + SETTLE_ATTACK + SETTLE_DECAY);
      osc.connect(g);
      g.connect(sum);
      osc.start(now);
      osc.stop(now + SETTLE_ATTACK + SETTLE_DECAY + 0.05);
    }
    const send = context.createGain();
    send.gain.value = SHIMMER_REVERB_SEND;
    sum.connect(send);
    send.connect(this._convolver);
    const sound = new PositionalAudio(this._listener);
    sound.setNodeSource(sum as unknown as AudioScheduledSourceNode);
    sound.position.copy(position);
    this._scene.add(sound);
    setTimeout(() => {
      this._scene.remove(sound);
      sum.disconnect();
    }, (SETTLE_ATTACK + SETTLE_DECAY + 0.1) * 1000);
  }

  private _fadeOutShimmer(): void {
    const shimmer = this._shimmer;
    if (!shimmer) return;
    this._shimmer = null;
    const context = this._listener.context;
    const now = context.currentTime;
    shimmer.gain.gain.cancelScheduledValues(now);
    shimmer.gain.gain.setValueAtTime(shimmer.gain.gain.value, now);
    shimmer.gain.gain.linearRampToValueAtTime(0, now + SHIMMER_FADE_OUT);
    shimmer.oscA.stop(now + SHIMMER_FADE_OUT + 0.02);
    shimmer.oscB.stop(now + SHIMMER_FADE_OUT + 0.02);
    shimmer.sparkle.stop(now + SHIMMER_FADE_OUT + 0.02);
    shimmer.lfo.stop(now + SHIMMER_FADE_OUT + 0.02);
    setTimeout(() => {
      this._scene.remove(shimmer.sound);
      shimmer.gain.disconnect();
      shimmer.filter.disconnect();
      shimmer.lfoGain.disconnect();
      shimmer.sendGain.disconnect();
    }, (SHIMMER_FADE_OUT + 0.05) * 1000);
  }

  // Immediate teardown (no fade) — used on reset() only, where a fresh loop
  // means this shouldn't keep sounding at all.
  private _hardStopShimmer(): void {
    const shimmer = this._shimmer;
    if (!shimmer) return;
    this._shimmer = null;
    const context = this._listener.context;
    const now = context.currentTime;
    try {
      shimmer.oscA.stop(now);
      shimmer.oscB.stop(now);
      shimmer.sparkle.stop(now);
      shimmer.lfo.stop(now);
    } catch {
      // Already stopped/scheduled to stop — harmless.
    }
    this._scene.remove(shimmer.sound);
    shimmer.gain.disconnect();
    shimmer.filter.disconnect();
    shimmer.lfoGain.disconnect();
    shimmer.sendGain.disconnect();
  }
}
