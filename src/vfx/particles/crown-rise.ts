import {
  AudioListener,
  Group,
  Mesh,
  PositionalAudio,
  Scene,
  ShaderMaterial,
  Vector3,
  World,
} from '@iwsdk/core';
import { buildOrganicGeometry } from '../geometry/organic-rock-geometry.js';
import { makeToonRimFlatMaterial } from '../shaders/toon-rim-material.js';

const SPIKE_COUNT_MIN = 7;
const SPIKE_COUNT_MAX = 11;
const RING_RADIUS = 0.045;
const SPIKE_BASE_SIZE = 0.02;
const SPIKE_SIZE_JITTER = 0.3; // fraction of base, +/-
// Non-uniform scale on the organic-rock base shape fakes an elongated
// spike/tooth silhouette — same trick _buildDogs/_buildOrganicScene already
// use to get varied shapes out of one generator without a second geometry
// function.
const SPIKE_SCALE_XZ = 0.55;
const SPIKE_SCALE_Y = 1.8;
const RING_HEIGHT_JITTER = 0.006;
const RING_ANGLE_JITTER = 0.25; // radians, breaks perfect evenness

// A piece "rises out of the ground" straight up into its ring slot rather
// than flying in from an arbitrary scatter — cheaper to stage convincingly
// and reads clearly as "emerging from the earth."
const EMERGE_DROP_HEIGHT = 0.18;
// Same per-piece staggered-reveal idiom _updateSet/_updateOrganicScene in
// earth-situations-vfx-system.ts already use (a piece's own progress is
// offset by its index/count along the stage's timeline) — reused here so
// the crown assembles piece-by-piece instead of all spikes popping in
// unison.
const EMERGE_STAGGER_WINDOW = 0.5;

// Stage durations sum to the requested ~30s cinematic — see crown-rise's
// own state machine below for what each stage does.
const EMERGE_DURATION = 8;
const HOVER_DURATION = 3;
const TRAVEL_DURATION = 15;
const LAND_DURATION = 4;

// Height of the travel arc's peak above a straight lerp — purely a "reads
// as a flight path, not a straight-line glide" flourish.
const TRAVEL_ARC_HEIGHT = 0.35;
// Fixed local offset above the comet's tracked position once attached —
// own constant rather than importing PebbleCometPresentationSystem's
// HEAD_RADIUS, same "stay decoupled" reasoning GhostRise's own orbit offset
// already follows.
const CROWN_HEAD_OFFSET_Y = 0.045;

const SPIN_SPEED_EMERGE = 0.4; // rad/s
const SPIN_SPEED_TRAVEL = 1.1;
const SPIN_SPEED_ATTACHED = 0.15;

// Same additive-partials-plus-reverb-bus idiom GhostRise's own shimmer/
// settle audio uses, stretched to cover this mechanic's much longer
// Emerging+Hovering+Traveling span (~26s vs Ghost's ~4.4s) — a slow swell
// partway through (see _updateShimmerSwell) keeps that span from reading as
// one static drone.
const SHIMMER_BASE_FREQ_MIN = 340;
const SHIMMER_BASE_FREQ_MAX = 460;
const SHIMMER_DETUNE_CENTS = 5;
const SHIMMER_SPARKLE_RATIO = 2.5;
const SHIMMER_FILTER_CUTOFF = 1800;
const SHIMMER_PEAK_GAIN = 0.045;
const SHIMMER_FADE_IN = 1.4;
const SHIMMER_FADE_OUT = 0.8;
const SHIMMER_LFO_RATE = 0.09;
const SHIMMER_LFO_DEPTH = 0.5;
const SHIMMER_REVERB_SEND = 0.55;

const SETTLE_RATIOS = [1.0, 1.5, 2.0, 3.0];
const SETTLE_ATTACK = 0.03;
const SETTLE_DECAY = 1.6;
const SETTLE_GAIN = 0.1;

const REVERB_DURATION = 3.2;
const REVERB_DECAY_EXPONENT = 2.2;

const enum CrownState {
  Idle,
  Emerging,
  Hovering,
  Traveling,
  Landing,
  Attached,
}

interface Spike {
  mesh: Mesh;
  scatterStart: Vector3;
  ringTarget: Vector3;
  // buildOrganicGeometry() returns a unit-radius (~1m) base shape — this is
  // the actual small per-spike scale to grow toward, multiplied by
  // Emerging's own localT each frame. Scaling by localT alone (0-1) would
  // leave a ~1m blob at full grown-in, not the intended few-centimeter
  // spike.
  targetScale: Vector3;
  staggerOffset: number; // 0-1, this spike's own start delay within Emerging
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

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
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

// The Constellations payoff: on every constellation's completion, a
// generative crown of small spikes rises out of the planet's surface,
// assembles into a ring, travels to the comet, and lands permanently on its
// head — worn, not just nearby, unlike GhostRise's circling orbit (see
// CROWN_HEAD_OFFSET_Y's own comment). Not an ECS System — a plain class
// driven by explicit build()/trigger()/update()/reset() calls, same idiom
// as GhostRise/HeartBurstPool/PlanetGrowthPool. Only one crown ever exists
// per playthrough (one constellation can complete); trigger() disposes and
// rebuilds a fresh randomized spike set each time (count within
// [SPIKE_COUNT_MIN, SPIKE_COUNT_MAX], each spike its own buildOrganicGeometry()
// call, already internally randomized) so "generative" means a genuinely
// different crown each loop, not just a recolor.
export class CrownRise {
  private _group!: Group;
  private _material!: ShaderMaterial;
  private _spikes: Spike[] = [];
  private _state: CrownState = CrownState.Idle;
  private _t = 0;
  private _origin = new Vector3();
  private _travelFrom = new Vector3();
  private _scratchPos = new Vector3();
  private _scratchOffset = new Vector3();

  private _listener!: AudioListener;
  private _scene!: Scene;
  private _convolver!: ConvolverNode;
  private _shimmer: ShimmerVoice | null = null;
  private _shimmerElapsed = 0;

  build(world: World, listener: AudioListener, scene: Scene): void {
    this._group = new Group();
    this._group.visible = false;
    world.createTransformEntity(this._group);

    // Uniform-based body/rim color, retinted per trigger() to that
    // playthrough's dominant pebble color — same retintable-flat-material
    // pattern _buildDogs/_buildKingTower already use, shared across every
    // spike Mesh rather than one material per spike.
    this._material = makeToonRimFlatMaterial([1, 1, 1]);

    this._listener = listener;
    this._scene = scene;
    const context = listener.context;
    this._convolver = context.createConvolver();
    this._convolver.buffer = buildReverbImpulse(context);
    this._convolver.connect(listener.gain);
    context.resume().catch(() => {});
  }

  trigger(origin: Vector3, color: [number, number, number]): void {
    if (this._state !== CrownState.Idle) return; // one crown per playthrough
    (this._material.uniforms.uBodyColor.value as Vector3).set(...color);

    this._rebuildSpikes();

    this._origin.copy(origin);
    this._group.position.copy(origin);
    this._group.rotation.set(0, 0, 0);
    this._group.visible = true;
    this._state = CrownState.Emerging;
    this._t = 0;
    this._shimmerElapsed = 0;
    this._startShimmer(origin);
  }

  private _rebuildSpikes(): void {
    for (const spike of this._spikes) {
      this._group.remove(spike.mesh);
      spike.mesh.geometry.dispose();
    }
    this._spikes = [];

    const count = SPIKE_COUNT_MIN + Math.floor(Math.random() * (SPIKE_COUNT_MAX - SPIKE_COUNT_MIN + 1));
    for (let i = 0; i < count; i++) {
      const geo = buildOrganicGeometry({ ampMin: 0.03, ampMax: 0.07 });
      const mesh = new Mesh(geo, this._material);
      const size = SPIKE_BASE_SIZE * (1 + (Math.random() * 2 - 1) * SPIKE_SIZE_JITTER);
      const targetScale = new Vector3(size * SPIKE_SCALE_XZ, size * SPIKE_SCALE_Y, size * SPIKE_SCALE_XZ);

      const angle = (i / count) * Math.PI * 2 + (Math.random() * 2 - 1) * RING_ANGLE_JITTER;
      const ringTarget = new Vector3(
        Math.cos(angle) * RING_RADIUS,
        (Math.random() * 2 - 1) * RING_HEIGHT_JITTER,
        Math.sin(angle) * RING_RADIUS,
      );
      const scatterStart = new Vector3(ringTarget.x, ringTarget.y - EMERGE_DROP_HEIGHT, ringTarget.z);

      mesh.position.copy(scatterStart);
      mesh.scale.setScalar(0); // grows in during Emerging, see _updateEmerging
      this._group.add(mesh);
      this._spikes.push({ mesh, scatterStart, ringTarget, targetScale, staggerOffset: i / count });
    }
  }

  update(delta: number, cometPosition: Vector3): void {
    if (this._state === CrownState.Idle) return;
    if (this._shimmer) this._updateShimmerSwell(delta);

    if (this._state === CrownState.Emerging) {
      this._t = Math.min(1, this._t + delta / EMERGE_DURATION);
      this._updateEmerging();
      this._group.rotation.y += SPIN_SPEED_EMERGE * delta;
      if (this._shimmer) this._shimmer.sound.position.copy(this._group.position);
      if (this._t >= 1) {
        this._state = CrownState.Hovering;
        this._t = 0;
      }
      return;
    }

    if (this._state === CrownState.Hovering) {
      this._t = Math.min(1, this._t + delta / HOVER_DURATION);
      this._group.rotation.y += SPIN_SPEED_EMERGE * delta;
      if (this._shimmer) this._shimmer.sound.position.copy(this._group.position);
      if (this._t >= 1) {
        this._travelFrom.copy(this._group.position);
        this._state = CrownState.Traveling;
        this._t = 0;
      }
      return;
    }

    if (this._state === CrownState.Traveling) {
      this._t = Math.min(1, this._t + delta / TRAVEL_DURATION);
      const eased = smoothstep(this._t);
      this._scratchPos.lerpVectors(this._travelFrom, cometPosition, eased);
      // Arc bump peaks mid-flight — a straight lerp reads as sliding, not
      // flying.
      this._scratchPos.y += Math.sin(this._t * Math.PI) * TRAVEL_ARC_HEIGHT;
      this._group.position.copy(this._scratchPos);
      this._group.rotation.y += SPIN_SPEED_TRAVEL * delta;
      if (this._shimmer) this._shimmer.sound.position.copy(this._group.position);
      if (this._t >= 1) {
        this._travelFrom.copy(this._group.position);
        this._state = CrownState.Landing;
        this._t = 0;
      }
      return;
    }

    if (this._state === CrownState.Landing) {
      this._t = Math.min(1, this._t + delta / LAND_DURATION);
      const eased = smoothstep(this._t);
      this._scratchOffset.set(cometPosition.x, cometPosition.y + CROWN_HEAD_OFFSET_Y, cometPosition.z);
      this._group.position.lerpVectors(this._travelFrom, this._scratchOffset, eased);
      // Settle "pop" — a brief overshoot past 1.0 scale, back to 1.0 — a
      // simple sin envelope rather than a spring simulation.
      const pop = 1 + Math.sin(eased * Math.PI) * 0.12;
      this._group.scale.setScalar(pop);
      this._group.rotation.y += SPIN_SPEED_TRAVEL * (1 - eased) * delta;
      if (this._t >= 1) {
        this._group.scale.setScalar(1);
        this._state = CrownState.Attached;
        this._settleAscension(this._group.position);
      }
      return;
    }

    // Attached — permanently worn at a fixed offset above the comet's live
    // head position (not an orbit, per this class's own comment — a crown
    // that circled the comet wouldn't read as "worn").
    this._group.position.set(cometPosition.x, cometPosition.y + CROWN_HEAD_OFFSET_Y, cometPosition.z);
    this._group.rotation.y += SPIN_SPEED_ATTACHED * delta;
  }

  // Each spike lerps from its scatterStart (underground) to ringTarget
  // (worn position) on its own staggered slice of Emerging's timeline —
  // same smoothstep(clamp01((t - offset)/window)) shape earth-situations-
  // vfx-system.ts's own _updateSet/_updateOrganicScene already establish.
  private _updateEmerging(): void {
    for (const spike of this._spikes) {
      const localT = smoothstep(clamp01((this._t - spike.staggerOffset) / EMERGE_STAGGER_WINDOW));
      spike.mesh.position.lerpVectors(spike.scatterStart, spike.ringTarget, localT);
      spike.mesh.scale.set(
        spike.targetScale.x * localT,
        spike.targetScale.y * localT,
        spike.targetScale.z * localT,
      );
    }
  }

  isAttached(): boolean {
    return this._state === CrownState.Attached;
  }

  reset(): void {
    this._state = CrownState.Idle;
    this._t = 0;
    this._group.visible = false;
    this._group.scale.setScalar(1);
    this._hardStopShimmer();
  }

  private _startShimmer(position: Vector3): void {
    const context = this._listener.context;
    if (context.state !== 'running') {
      context.resume().catch(() => {});
      return;
    }
    const now = context.currentTime;
    const freq = SHIMMER_BASE_FREQ_MIN;

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
    sparkleGain.gain.value = 0.22;

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

  // A slow brightening swell partway through the long Emerging+Hovering+
  // Traveling span (~26s) — filter cutoff opens up, sparkle brightens —
  // purely so a listener doesn't hear one static drone for that long.
  private _updateShimmerSwell(delta: number): void {
    const shimmer = this._shimmer;
    if (!shimmer) return;
    this._shimmerElapsed += delta;
    const span = EMERGE_DURATION + HOVER_DURATION + TRAVEL_DURATION;
    const swell = smoothstep(clamp01(this._shimmerElapsed / span));
    shimmer.filter.frequency.value = SHIMMER_FILTER_CUTOFF * (1 + swell * 0.8);
    shimmer.sparkle.detune.setValueAtTime(swell * 12, this._listener.context.currentTime);
  }

  // Fades the sustained shimmer out and plays a one-shot resolving chime —
  // called once, the instant the crown settles onto the comet's head.
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
