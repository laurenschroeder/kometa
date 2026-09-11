import {
  AdditiveBlending,
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DynamicDrawUsage,
  Entity,
  Points,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { GatherableField, GatherState } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { PixelTwinkleSynth } from '../../vfx/audio/pixel-twinkle-synth.js';
import { TwinkleSynth } from '../../vfx/audio/twinkle-synth.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { makePixelCrtMaterial } from '../../vfx/shaders/pixel-crt-material.js';
import { makeSparkleMaterial } from '../../vfx/shaders/sparkle-material.js';
import { StardustSystem } from './stardust-system.js';

// The swirl finale's collectible gold gather-field (see
// StardustSystem.getSwirlField()) — a warm gold, distinct from the cream
// STARDUST_COLOR ambient motes, so captured swirl points read as a clear
// "you gained this" accent riding the tail.
const SWIRL_GOLD_COLOR: [number, number, number] = [1.0, 0.75, 0.25];
const SWIRL_POINT_SIZE = 0.022;
const SWIRL_CAPTURED_SIZE = 0.03;
const SWIRL_FADE_IN_RATE = 0.7; // 1/s exponential ease toward opacity 1

// Exported so ArtTestVfxSystem's "current stardust field" variant renders
// with the exact same color, not an eyeballed copy.
export const STARDUST_COLOR: [number, number, number] = [1.0, 0.96, 0.82];
const AMBIENT_SIZE = 0.05;
const CAPTURED_SIZE = 0.035;

// Phases where stardust already collected onto the comet's trail should stay
// visible — Stardust (where it's gathered) through Seeding (where
// PlanetSeedingSystem "spends" it onto the planets, via
// StardustSystem.releaseCaptured). Only the ambient (ungathered) field is
// Stardust-only.
const CAPTURED_VISIBLE_DURING = new Set<Phase>([Phase.Stardust, Phase.Pebbles, Phase.Seeding]);

// Renders StardustSystem's particle state: ungathered motes as a plain
// world-space sparkle field (zero-copy over StardustSystem's live position
// array — hidden per-mote by zeroing point size, not by removing them from
// the draw range, so no per-frame reordering is needed), and captured motes
// as a single trail-following sparkle pool using the same camera-relative
// trail-sampling technique the pebbles use (see
// vfx/particles/trail-sampler.ts) — just a different shader/palette. There's
// only ever one {CometBody, CometTrail, HandAnchor} entity (see
// comet/comet-handoff-system.ts), so this pool just rides whichever hand the
// comet currently follows — a hand switch mid-flight is invisible here since
// the trail buffer itself is per-entity, not per-hand.
//
// Not GameDirector-managed (unlike StardustSystem itself) — the captured
// pool needs to keep rendering past Stardust ending (see
// CAPTURED_VISIBLE_DURING), so this system reads globals.gamePhase directly
// instead, same pattern as PebbleCometPresentationSystem. It runs every
// frame regardless of phase; that's cheap (StardustSystem's own gather
// physics is what's expensive, and that IS director-paused outside
// Stardust).
export class StardustVfxSystem extends createSystem({
  comets: { required: [CometBody, CometTrail, HandAnchor] },
}) {
  private _stardust!: StardustSystem;
  private _trailSystem!: CometTrailSystem;
  private _material!: ShaderMaterial;

  private _moteBright!: Float32Array;
  private _motePhase!: Float32Array;
  private _ambientSize!: Float32Array;
  private _ambientGeo!: BufferGeometry;
  private _ambientEntity!: Entity;
  private _ambientPoints!: Points;

  private _capturedPositions!: Float32Array;
  private _capturedBright!: Float32Array;
  private _capturedPhase!: Float32Array;
  private _capturedGeo!: BufferGeometry;
  private _capturedEntity!: Entity;
  private _capturedPoints!: Points;

  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchOffset!: Vector3;
  private _scratchCapturePos!: Vector3;

  // IWSDK's own AudioSource/AudioUtils layer only ever plays pre-loaded
  // buffers (see AudioPool) — there's no exposed way to reach the
  // AudioListener it creates for generative/synthesized audio, so the
  // twinkle sound gets its own listener here, attached to the same
  // player.head. This adds one extra gain node to the audio graph, not a
  // second audio device — both listeners share the same underlying
  // AudioContext singleton (THREE.AudioContext.getContext()).
  private _audioListener!: AudioListener;
  private _twinkleSynth!: TwinkleSynth;
  // Square-wave sibling synth, swapped in once StardustSystem.isSwirling()
  // — see pixel-twinkle-synth.ts's own class comment.
  private _pixelSynth!: PixelTwinkleSynth;

  // Built lazily (see _buildSwirlRender) the first frame
  // StardustSystem.getSwirlField() returns non-null — its point count and
  // positions aren't known until then.
  private _swirlBuilt = false;
  private _swirlOpacity = 0;
  private _swirlSize!: Float32Array;
  private _swirlGeo!: BufferGeometry;
  private _swirlMaterial!: ShaderMaterial;
  private _swirlPoints!: Points;
  private _swirlEntity!: Entity;

  private _swirlCapturedPositions!: Float32Array;
  private _swirlCapturedGeo!: BufferGeometry;
  private _swirlCapturedMaterial!: ShaderMaterial;
  private _swirlCapturedPoints!: Points;
  private _swirlCapturedEntity!: Entity;

  init(): void {
    // StardustSystem/CometTrailSystem must be registered before this system
    // (see index.ts) so they already exist when this init() runs.
    this._stardust = this.world.getSystem(StardustSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;
    this._material = makeSparkleMaterial({ color: STARDUST_COLOR, blending: AdditiveBlending });

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._twinkleSynth = new TwinkleSynth();
    this._twinkleSynth.build(this._audioListener, this.scene);
    this._pixelSynth = new PixelTwinkleSynth();
    this._pixelSynth.build(this._audioListener, this.scene);
    this._scratchCapturePos = new Vector3();

    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchOffset = new Vector3();

    const n = this._stardust.getParticleCount();
    this._moteBright = new Float32Array(n);
    this._motePhase = new Float32Array(n);
    this._ambientSize = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this._moteBright[i] = 0.6 + Math.random() * 0.4;
      this._motePhase[i] = Math.random();
    }

    this._ambientGeo = new BufferGeometry();
    // Zero-copy: shares StardustSystem's live position array directly.
    // StardustSystem must run before this system each frame (see priorities
    // in index.ts) for this to reflect the current frame's motion.
    const ambientPosAttr = new BufferAttribute(this._stardust.getPositions(), 3);
    ambientPosAttr.setUsage(DynamicDrawUsage);
    this._ambientGeo.setAttribute('position', ambientPosAttr);
    this._ambientGeo.setAttribute('aSize', new BufferAttribute(this._ambientSize, 1));
    this._ambientGeo.setAttribute('aBright', new BufferAttribute(this._moteBright, 1));
    this._ambientGeo.setAttribute('aPhase', new BufferAttribute(this._motePhase, 1));
    this._ambientPoints = new Points(this._ambientGeo, this._material);
    this._ambientPoints.frustumCulled = false;
    this._ambientEntity = this.world.createTransformEntity(this._ambientPoints);

    this._capturedPositions = new Float32Array(n * 3);
    this._capturedBright = new Float32Array(n);
    this._capturedPhase = new Float32Array(n);
    this._capturedGeo = new BufferGeometry();
    const capturedPosAttr = new BufferAttribute(this._capturedPositions, 3);
    capturedPosAttr.setUsage(DynamicDrawUsage);
    this._capturedGeo.setAttribute('position', capturedPosAttr);
    this._capturedGeo.setAttribute('aSize', new BufferAttribute(new Float32Array(n).fill(CAPTURED_SIZE), 1));
    this._capturedGeo.setAttribute('aBright', new BufferAttribute(this._capturedBright, 1));
    this._capturedGeo.setAttribute('aPhase', new BufferAttribute(this._capturedPhase, 1));
    this._capturedGeo.setDrawRange(0, 0);
    this._capturedPoints = new Points(this._capturedGeo, this._material);
    this._capturedPoints.frustumCulled = false;
    this._capturedEntity = this.world.createTransformEntity(this._capturedPoints);

    // signal.subscribe() fires immediately with the current value, so
    // visibility is correct before the first frame renders.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        this._ambientPoints.visible = phase === Phase.Stardust;
        this._capturedPoints.visible = CAPTURED_VISIBLE_DURING.has(phase);

        if (phase === Phase.Stardust) {
          // Fresh loop re-entering Stardust — same "reset on phase re-entry"
          // idiom PlanetSeedingVfxSystem uses, since this system isn't
          // GameDirector-managed (no play() to hook a reset into). Unlike
          // the ambient/captured stardust pools (which just get their state
          // zeroed elsewhere), the swirl's geometry/material are rebuilt
          // from scratch each loop, so a full dispose is needed here rather
          // than a reset.
          this._disposeSwirlRender();
        }
        if (this._swirlBuilt) {
          this._swirlPoints.visible = phase === Phase.Stardust;
          this._swirlCapturedPoints.visible = CAPTURED_VISIBLE_DURING.has(phase);
        }
      }),
    );
  }

  update(delta: number, time: number): void {
    this._material.uniforms.uTime.value = time;

    const states = this._stardust.getStates();
    for (let i = 0; i < states.length; i++) {
      this._ambientSize[i] = states[i] === GatherState.Captured ? 0 : AMBIENT_SIZE;
    }
    (this._ambientGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this._ambientGeo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;

    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    this._updateSwirl(delta, time);

    for (const entity of this.queries.comets.entities) {
      const trail = this._trailSystem.getBuffer(entity);
      if (!trail) continue;
      const samples = entity.getValue(CometTrail, 'samples') as number;
      const stride = entity.getValue(CometTrail, 'stride') as number;
      this._placeCapturedPool(trail, samples, stride);
      this._placeSwirlCapturedPool(trail, samples, stride);
    }

    // Once the swirl finale begins, the pickup/catch cue switches to the
    // square-wave sibling synth to match the pixel-CRT aesthetic — see
    // pixel-twinkle-synth.ts's own class comment.
    const synth = this._stardust.isSwirling() ? this._pixelSynth : this._twinkleSynth;
    for (const ev of this._stardust.drainAttractEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      synth.playPickup(this._scratchCapturePos, ev.speed);
    }
    for (const ev of this._stardust.drainCaptureEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      synth.playCatch(this._scratchCapturePos, ev.speed);
    }
    // Collecting the swirl makes the same square-wave chime as collecting
    // stardust during the finale — reinforcing "this is the same kind of
    // gathering, on a new object."
    for (const ev of this._stardust.drainSwirlAttractEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      synth.playPickup(this._scratchCapturePos, ev.speed);
    }
    for (const ev of this._stardust.drainSwirlCaptureEvents()) {
      this._scratchCapturePos.set(ev.x, ev.y, ev.z);
      synth.playCatch(this._scratchCapturePos, ev.speed);
    }
  }

  // Lazily builds the swirl's rendering the first frame StardustSystem's
  // swirl field exists (Stage A just triggered — see
  // StardustSystem._buildSwirlField), then every frame after: keeps the
  // ambient cloud's per-point size zeroed once captured (so it visibly
  // thins out as points are swept up, same idiom as the main ambient
  // stardust field) and eases its fade-in toward full opacity.
  private _updateSwirl(delta: number, time: number): void {
    const swirlField = this._stardust.getSwirlField();
    if (!swirlField) return;
    if (!this._swirlBuilt) {
      this._buildSwirlRender(swirlField);
    }

    const states = swirlField.states;
    for (let i = 0; i < states.length; i++) {
      this._swirlSize[i] = states[i] === GatherState.Captured ? 0 : SWIRL_POINT_SIZE;
    }
    (this._swirlGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this._swirlGeo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;

    const pull = 1 - Math.exp(-SWIRL_FADE_IN_RATE * delta);
    this._swirlOpacity += (1 - this._swirlOpacity) * pull;
    this._swirlMaterial.uniforms.uOpacity.value = this._swirlOpacity;
    this._swirlMaterial.uniforms.uTime.value = time;
    this._swirlCapturedMaterial.uniforms.uTime.value = time;
  }

  // Ambient cloud: a zero-copy Points over swirlField.positions (same
  // share-the-live-array idiom as _ambientGeo over the main stardust
  // field) — its own material fades in via uOpacity. Captured/tail pool:
  // same shape as _capturedGeo, own material intentionally left at
  // uOpacity 1 (never faded — points only appear here already-captured,
  // one at a time).
  private _buildSwirlRender(swirlField: GatherableField): void {
    this._swirlBuilt = true;
    this._swirlOpacity = 0;
    const n = this._stardust.getSwirlPointCount();

    this._swirlSize = new Float32Array(n);
    const bright = new Float32Array(n);
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bright[i] = 0.6 + Math.random() * 0.4;
      phase[i] = Math.random();
    }

    this._swirlMaterial = makePixelCrtMaterial({ color: SWIRL_GOLD_COLOR, blending: AdditiveBlending });
    this._swirlMaterial.uniforms.uOpacity.value = 0;

    this._swirlGeo = new BufferGeometry();
    const posAttr = new BufferAttribute(swirlField.positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    this._swirlGeo.setAttribute('position', posAttr);
    this._swirlGeo.setAttribute('aSize', new BufferAttribute(this._swirlSize, 1));
    this._swirlGeo.setAttribute('aBright', new BufferAttribute(bright, 1));
    this._swirlGeo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    this._swirlPoints = new Points(this._swirlGeo, this._swirlMaterial);
    this._swirlPoints.frustumCulled = false;
    this._swirlEntity = this.world.createTransformEntity(this._swirlPoints);

    this._swirlCapturedMaterial = makePixelCrtMaterial({ color: SWIRL_GOLD_COLOR, blending: AdditiveBlending });
    this._swirlCapturedPositions = new Float32Array(n * 3);
    this._swirlCapturedGeo = new BufferGeometry();
    const capPosAttr = new BufferAttribute(this._swirlCapturedPositions, 3);
    capPosAttr.setUsage(DynamicDrawUsage);
    this._swirlCapturedGeo.setAttribute('position', capPosAttr);
    this._swirlCapturedGeo.setAttribute('aSize', new BufferAttribute(new Float32Array(n).fill(SWIRL_CAPTURED_SIZE), 1));
    this._swirlCapturedGeo.setAttribute('aBright', new BufferAttribute(bright, 1));
    this._swirlCapturedGeo.setAttribute('aPhase', new BufferAttribute(phase, 1));
    this._swirlCapturedGeo.setDrawRange(0, 0);
    this._swirlCapturedPoints = new Points(this._swirlCapturedGeo, this._swirlCapturedMaterial);
    this._swirlCapturedPoints.frustumCulled = false;
    this._swirlCapturedEntity = this.world.createTransformEntity(this._swirlCapturedPoints);

    const currentPhase = getGlobals(this.world).gamePhase.peek();
    this._swirlPoints.visible = currentPhase === Phase.Stardust;
    this._swirlCapturedPoints.visible = CAPTURED_VISIBLE_DURING.has(currentPhase);
  }

  private _placeSwirlCapturedPool(trail: Float32Array, samples: number, stride: number): void {
    if (!this._swirlBuilt) return;
    const swirlField = this._stardust.getSwirlField();
    if (!swirlField) return;
    const indices = swirlField.captured;
    const field = swirlField.capturedField;

    for (let slot = 0; slot < indices.length; slot++) {
      const i = indices[slot];
      sampleTrailOffset(
        trail,
        samples,
        stride,
        field.t[i],
        field.dx[i],
        field.dy[i],
        field.dz[i],
        this._camRight,
        this._camUp,
        this._camFwd,
        this._scratchOffset,
      );
      this._swirlCapturedPositions[slot * 3] = this._scratchOffset.x;
      this._swirlCapturedPositions[slot * 3 + 1] = this._scratchOffset.y;
      this._swirlCapturedPositions[slot * 3 + 2] = this._scratchOffset.z;
    }

    this._swirlCapturedGeo.setDrawRange(0, indices.length);
    (this._swirlCapturedGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  // Full teardown (not just a state reset) since the swirl's geometry/
  // material are rebuilt from scratch on the next Stage A trigger — see the
  // gamePhase.subscribe callback's own comment for why this differs from
  // the ambient/captured stardust pools' plain reset.
  private _disposeSwirlRender(): void {
    if (!this._swirlBuilt) return;
    this._swirlBuilt = false;
    this._swirlOpacity = 0;
    this._swirlEntity.dispose();
    this._swirlCapturedEntity.dispose();
  }

  private _placeCapturedPool(trail: Float32Array, samples: number, stride: number): void {
    const indices = this._stardust.getCapturedIndices();
    const field = this._stardust.getCapturedField();

    for (let slot = 0; slot < indices.length; slot++) {
      const i = indices[slot];
      sampleTrailOffset(
        trail,
        samples,
        stride,
        field.t[i],
        field.dx[i],
        field.dy[i],
        field.dz[i],
        this._camRight,
        this._camUp,
        this._camFwd,
        this._scratchOffset,
      );
      this._capturedPositions[slot * 3] = this._scratchOffset.x;
      this._capturedPositions[slot * 3 + 1] = this._scratchOffset.y;
      this._capturedPositions[slot * 3 + 2] = this._scratchOffset.z;
      this._capturedBright[slot] = this._moteBright[i];
      this._capturedPhase[slot] = this._motePhase[i];
    }

    this._capturedGeo.setDrawRange(0, indices.length);
    (this._capturedGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this._capturedGeo.getAttribute('aBright') as BufferAttribute).needsUpdate = true;
    (this._capturedGeo.getAttribute('aPhase') as BufferAttribute).needsUpdate = true;
  }
}
