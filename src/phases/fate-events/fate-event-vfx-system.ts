import {
  CanvasTexture,
  createSystem,
  DoubleSide,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  AdditiveBlending,
} from '@iwsdk/core';
import { getGlobals } from '../../core/globals.js';
import { Phase } from '../../core/phase.js';
import { buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import { placePlanets } from '../../vfx/geometry/weave-path.js';
import { makeToonRimFlatMaterial } from '../../vfx/shaders/toon-rim-material.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { FateEventSystem } from './fate-event-system.js';

const JUMP_FREQUENCY = 5; // Hz
const JUMP_AMPLITUDE = 0.045; // scaled with PERSON_HEIGHT's 2.2x bump
const BOB_EASE_RATE = 6; // 1/s exponential ease, same idiom as PlanetSeedingVfxSystem's coverage ease

const BUBBLE_WIDTH = 0.14;
const BUBBLE_HEIGHT = 0.07;
const BUBBLE_GAP = 0.03;
const BUBBLE_EASE_RATE = 8; // faster than the HUD's 0.5s fade — a small in-world element
const BUBBLE_CANVAS_W = 256;
const BUBBLE_CANVAS_H = 128;
const BUBBLE_LINE_HEIGHT = 34;

// isFateTransitionActive() defaults to false before the transition has ever
// been started (not just once it's finished) — since this system is
// always-on and update() runs from world boot, checking that alone would
// read as "already arrived" on frame 1, long before Constellations ever
// kicks the transition off. Gating the arrival check on having reached at
// least Constellations closes that gap for the normal flow; a dev-menu jump
// straight to Fate Events (skipping Constellations) still works because
// FateEventSystem.play() re-triggers the transition itself and this set
// also covers Phase.FateEvents.
const PLANET_ARRIVAL_ELIGIBLE_FROM = new Set<Phase>([
  Phase.Constellations,
  Phase.FateEvents,
  Phase.Launch,
  Phase.Finale,
]);

const N_FIRE_QUADS = 8;
const FIRE_RING_RADIUS = 0.4;
const FIRE_RING_Y_OFFSET = -0.15; // below the planet's lowest point
const FIRE_QUAD_W = 0.15;
const FIRE_QUAD_H = 0.2;
const FIRE_FLICKER_FREQ = 3;
const FIRE_BOB_FREQ = 0.8;
const FIRE_BOB_AMP = 0.03;
const FIRE_CANVAS_SIZE = 128;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(test).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function buildFireTexture(): CanvasTexture {
  const s = FIRE_CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(s / 2, s * 0.6, 0, s / 2, s * 0.6, s / 2);
  gradient.addColorStop(0, 'rgba(255, 240, 180, 0.95)');
  gradient.addColorStop(0.4, 'rgba(255, 140, 40, 0.85)');
  gradient.addColorStop(0.75, 'rgba(200, 30, 10, 0.4)');
  gradient.addColorStop(1, 'rgba(200, 30, 10, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, s, s);
  return new CanvasTexture(canvas);
}

// Renders FateEventSystem's simulation state: the big planet's N
// placeholder people (bobbing when their proximity-triggered "active" state
// is on), their per-person speech bubbles (canvas-texture quads,
// billboarded toward the camera, redrawn only when their dialogue line
// actually changes), and — only when the dominant type was volatile gasses
// — a small ring of ambient flame quads below the planet. Always-on and
// self-gated via gamePhase (like ConstellationsVfxSystem/
// PlanetSeedingVfxSystem), NOT director-managed: people now start appearing
// progressively during Constellations (tied to ConstellationsSystem's
// getRevealProgress(), see update()) rather than popping in all at once
// when Fate Events itself starts, so this system's own visibility can't be
// tied to Fate Events' play()/stop() the way it used to be. FateEventSystem
// itself stays director-managed — its proximity/dialogue simulation only
// runs during Phase.FateEvents, same as always.
export class FateEventVfxSystem extends createSystem({}) {
  private _fateEvents!: FateEventSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _constellations!: ConstellationsSystem;
  // People/fire stay hidden until PlanetSeedingVfxSystem's rotate/grow
  // transition (see planet-fate-transition.ts) finishes bringing the
  // selected ring planet into this phase's fixed PLANET_CENTER/PLANET_RADIUS
  // slot — revealing them earlier would show people standing on a planet
  // that hasn't visually arrived yet. Renamed from _revealedAfterTransition
  // since it now also gates fire, independent of the people-reveal timing.
  private _planetArrived = false;

  private _peopleMaterial!: ReturnType<typeof makeToonRimFlatMaterial>;
  private _personGroups: Group[] = [];
  private _personEntities: Entity[] = [];
  private _bobPhase!: Float32Array;
  private _bobAmp!: Float32Array;

  private _bubbleMeshes: Mesh[] = [];
  private _bubbleEntities: Entity[] = [];
  private _bubbleCtxs: CanvasRenderingContext2D[] = [];
  private _bubbleTextures: CanvasTexture[] = [];
  private _bubbleOpacity!: Float32Array;
  private _lastLineIndex!: Int16Array;

  private _fireMeshes: Mesh[] = [];
  private _fireEntities: Entity[] = [];
  private _firePositions!: Float32Array;
  private _firePhase!: Float32Array;

  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;
  private _upAxis!: Vector3;
  private _zAxis!: Vector3;
  private _normalVec!: Vector3;
  private _scratchPos!: Vector3;

  init(): void {
    this._fateEvents = this.world.getSystem(FateEventSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    // ConstellationsSystem must be registered before this system (see
    // index.ts) so it already exists when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;

    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._upAxis = new Vector3(0, 1, 0);
    this._zAxis = new Vector3(0, 0, 1);
    this._normalVec = new Vector3();
    this._scratchPos = new Vector3();

    this._buildPeople();
    this._buildBubbles();
    this._buildFire();

    // signal.subscribe() fires immediately, so state is correct before the
    // first frame renders (same idiom ConstellationsVfxSystem/
    // PlanetSeedingVfxSystem use for their own gamePhase gating).
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  private _onPhaseChange(phase: Phase): void {
    if (phase === Phase.Constellations) {
      // The dialogue-specific mood color (if any) isn't resolved until a
      // constellation is actually won — fall back to the dominant type's
      // color for however long people are progressively appearing here.
      const dominant = getGlobals(this.world).dominantPebbleType.peek();
      const color = PEBBLE_TYPES[dominant].color;
      (this._peopleMaterial.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
    } else if (phase === Phase.FateEvents) {
      // celestialSymbol is resolved by now — pick up the real (possibly
      // dialogue-overridden) color, and reveal bubbles: people are already
      // visible from Constellations, this just adds the interactive layer.
      const color = this._fateEvents.getPeopleColor();
      (this._peopleMaterial.uniforms.uBodyColor.value as Vector3).set(color[0], color[1], color[2]);
      for (const mesh of this._bubbleMeshes) mesh.visible = true;
    } else if (phase === Phase.Stardust) {
      this._resetAll();
    }
  }

  private _resetAll(): void {
    this._planetArrived = false;
    for (const group of this._personGroups) group.visible = false;
    for (const mesh of this._bubbleMeshes) mesh.visible = false;
    for (const mesh of this._fireMeshes) mesh.visible = false;
    this._bubbleOpacity.fill(0);
    this._lastLineIndex.fill(-1);
    this._bobAmp.fill(0);
  }

  private _buildPeople(): void {
    const count = this._fateEvents.getPersonCount();
    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();

    // dominantPebbleType isn't known this early (world boot, well before
    // Pebbles completes) either way — this is just a harmless placeholder
    // until _onPhaseChange sets the real color on entering Constellations;
    // people stay hidden until then regardless.
    const initialDominant = getGlobals(this.world).dominantPebbleType.peek();
    this._peopleMaterial = makeToonRimFlatMaterial(PEBBLE_TYPES[initialDominant].color);
    this._bobPhase = new Float32Array(count);
    this._bobAmp = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      this._bobPhase[i] = Math.random() * Math.PI * 2;
      const group = buildPlaceholderPerson(this._peopleMaterial);
      group.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      group.quaternion.setFromUnitVectors(this._upAxis, this._normalVec);
      group.visible = false;
      this._personGroups.push(group);
      this._personEntities.push(this.world.createTransformEntity(group));
    }
  }

  private _buildBubbles(): void {
    const count = this._fateEvents.getPersonCount();
    this._bubbleOpacity = new Float32Array(count);
    this._lastLineIndex = new Int16Array(count).fill(-1);

    const geo = new PlaneGeometry(BUBBLE_WIDTH, BUBBLE_HEIGHT);
    for (let i = 0; i < count; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = BUBBLE_CANVAS_W;
      canvas.height = BUBBLE_CANVAS_H;
      const ctx = canvas.getContext('2d')!;
      const texture = new CanvasTexture(canvas);
      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        opacity: 0,
      });
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._bubbleCtxs.push(ctx);
      this._bubbleTextures.push(texture);
      this._bubbleMeshes.push(mesh);
      this._bubbleEntities.push(this.world.createTransformEntity(mesh));
    }
  }

  private _buildFire(): void {
    const [px, , pz] = this._fateEvents.getPlanetCenter();
    const fireY = this._fateEvents.getPlanetCenter()[1] - this._fateEvents.getPlanetRadius() + FIRE_RING_Y_OFFSET;
    const ring = placePlanets(N_FIRE_QUADS, FIRE_RING_RADIUS, fireY);
    this._firePositions = ring;
    this._firePhase = new Float32Array(N_FIRE_QUADS);

    const geo = new PlaneGeometry(FIRE_QUAD_W, FIRE_QUAD_H);
    const texture = buildFireTexture();
    for (let i = 0; i < N_FIRE_QUADS; i++) {
      this._firePositions[i * 3] += px;
      this._firePositions[i * 3 + 2] += pz;
      this._firePhase[i] = Math.random() * Math.PI * 2;

      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(geo, material);
      mesh.position.set(this._firePositions[i * 3], this._firePositions[i * 3 + 1], this._firePositions[i * 3 + 2]);
      mesh.visible = false;
      this._fireMeshes.push(mesh);
      this._fireEntities.push(this.world.createTransformEntity(mesh));
    }
  }

  update(delta: number, time: number): void {
    const phase = getGlobals(this.world).gamePhase.peek();

    if (
      !this._planetArrived &&
      PLANET_ARRIVAL_ELIGIBLE_FROM.has(phase) &&
      !this._planetSeeding.isFateTransitionActive()
    ) {
      this._planetArrived = true;
      const showFire = this._fateEvents.getShowFire();
      for (const mesh of this._fireMeshes) mesh.visible = showFire;
    }

    if (this._planetArrived) {
      // Progressive during Constellations (tied to how close the player is
      // to winning); fully revealed for every phase after it — the
      // constellation must have been won to leave that phase normally, and
      // a dev-menu jump straight past it should still show everyone.
      const progress = phase === Phase.Constellations ? this._constellations.getRevealProgress() : 1;
      const revealCount = Math.floor(progress * this._personGroups.length);
      for (let i = 0; i < this._personGroups.length; i++) {
        this._personGroups[i].visible = i < revealCount;
      }
    }

    this.camera.getWorldPosition(this._camWorldPos);

    const active = this._fateEvents.getActiveMask();
    const lineIndex = this._fateEvents.getLineIndex();
    const lines = this._fateEvents.getDialogueLines();
    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();
    const count = this._fateEvents.getPersonCount();

    const bobPull = 1 - Math.exp(-BOB_EASE_RATE * delta);
    const bubblePull = 1 - Math.exp(-BUBBLE_EASE_RATE * delta);

    for (let i = 0; i < count; i++) {
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);

      const targetAmp = active[i] ? JUMP_AMPLITUDE : 0;
      this._bobAmp[i] += (targetAmp - this._bobAmp[i]) * bobPull;
      const bobOffset =
        this._bobAmp[i] * Math.max(0, Math.sin(time * JUMP_FREQUENCY * Math.PI * 2 + this._bobPhase[i]));

      this._scratchPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const group = this._personGroups[i];
      group.position.copy(this._scratchPos).addScaledVector(this._normalVec, bobOffset);

      const bubbleMesh = this._bubbleMeshes[i];
      const targetOpacity = active[i] ? 1 : 0;
      this._bubbleOpacity[i] += (targetOpacity - this._bubbleOpacity[i]) * bubblePull;
      (bubbleMesh.material as MeshBasicMaterial).opacity = this._bubbleOpacity[i];

      if (active[i] && this._lastLineIndex[i] !== lineIndex[i]) {
        this._lastLineIndex[i] = lineIndex[i];
        this._drawBubbleText(i, lines[lineIndex[i]] ?? '');
      }

      bubbleMesh.position
        .copy(this._scratchPos)
        .addScaledVector(this._normalVec, PERSON_HEIGHT + BUBBLE_GAP + bobOffset);
      this._faceDir.copy(this._camWorldPos).sub(bubbleMesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        bubbleMesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }

    this._updateFire(time);
  }

  private _updateFire(time: number): void {
    for (let i = 0; i < N_FIRE_QUADS; i++) {
      const mesh = this._fireMeshes[i];
      if (!mesh.visible) continue;
      const phase = this._firePhase[i];
      const flicker = 1 + Math.sin(time * FIRE_FLICKER_FREQ + phase) * 0.15;
      mesh.scale.setScalar(flicker);
      const bob = Math.sin(time * FIRE_BOB_FREQ + phase) * FIRE_BOB_AMP;
      mesh.position.set(
        this._firePositions[i * 3],
        this._firePositions[i * 3 + 1] + bob,
        this._firePositions[i * 3 + 2],
      );
      this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }
    }
  }

  private _drawBubbleText(i: number, text: string): void {
    const ctx = this._bubbleCtxs[i];
    const w = BUBBLE_CANVAS_W;
    const h = BUBBLE_CANVAS_H;
    const pad = 10;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(8, 8, 16, 0.82)';
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 3;
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, 18);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, text, w - pad * 4);
    const totalHeight = lines.length * BUBBLE_LINE_HEIGHT;
    let y = h / 2 - totalHeight / 2 + BUBBLE_LINE_HEIGHT / 2;
    for (const line of lines) {
      ctx.fillText(line, w / 2, y);
      y += BUBBLE_LINE_HEIGHT;
    }

    this._bubbleTextures[i].needsUpdate = true;
  }
}
