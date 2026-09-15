import {
  AdditiveBlending,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  AssetManager,
  AudioListener,
  Bone,
  BufferGeometry,
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  Entity,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  LoopRepeat,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { CometTrail } from '../../comet/comet-trail-component.js';
import { CometTrailSystem } from '../../comet/comet-trail-system.js';
import { GatherableField, GatherState } from '../../comet/gatherable-field.js';
import { getGlobals } from '../../core/globals.js';
import {
  GAS_ACCUSER_INDEX,
  GAS_GRIEVER_INDEX,
  GAS_GRUMP_INDEX,
  GAS_MOURNER_INDEX,
  GAS_RANTER_INDEX,
} from '../../core/notification-copy.js';
import { Phase } from '../../core/phase.js';
import { playPayoffChime } from '../../vfx/audio/payoff-chime.js';
import { PebbleSynth } from '../../vfx/audio/pebble-synth.js';
import { TwinkleSynth } from '../../vfx/audio/twinkle-synth.js';
import { buildPlaceholderPerson, PERSON_HEIGHT } from '../../vfx/geometry/placeholder-person.js';
import {
  buildAnimatedPerson,
  loadAnimatedPersonTemplate,
  loadPersonClip,
  PERSON_BODY_COLOR,
} from '../../vfx/geometry/animated-person.js';
import {
  convertZUpToYUp,
  loadFbxMeshesByName,
  normalizeGeometryToUnitRadiusFromOrigin,
} from '../../vfx/geometry/fbx-field-loader.js';
import { placePlanets } from '../../vfx/geometry/weave-path.js';
import { sampleTrailOffset } from '../../vfx/particles/trail-sampler.js';
import { SOUL_ISLAND_PALETTE } from '../../vfx/shaders/pebble-material.js';
import {
  makeToonRimFlatMaterial,
  makeToonRimInstancedWigglyLiveRimMaterial,
  makeToonRimSkinnedMaterial,
} from '../../vfx/shaders/toon-rim-material.js';
import { hexToRgb, NAMED_RIM, ORGANIC_PALETTE, WHITE } from '../../vfx/color/color-scheme.js';
import { ConstellationsSystem } from '../constellations/constellations-system.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import {
  CROWD_CAP_DIRECTION,
  EXPLAIN_FIGURE_INDEX,
  FateBeat,
  FateEventSystem,
  GAS_NAMED_COUNT,
  NAMED_FIGURE_COUNT,
} from './fate-event-system.js';
import { SeedBlossom } from './seed-blossom.js';

const JUMP_FREQUENCY = 5; // Hz — speed of the single hop, see _jumpElapsed
const JUMP_AMPLITUDE = 0.135; // scaled with PERSON_HEIGHT's 2.2x then 3x bumps (0.045 -> 0.135)

// Bumped from 0.14/0.07 (canvas 256x128) — long dialogue lines routinely
// wrapped to more lines than the old canvas had height for, clipping the
// bottom (or top) of the text. Canvas keeps the same aspect ratio as the
// plane so text isn't stretched. Bumped again (0.2/0.13 -> 0.26/0.17, ~30%)
// for easier reading at arm's-length VR distance — canvas resolution/font
// size are untouched, so the same texture just renders larger.
const BUBBLE_WIDTH = 0.26;
const BUBBLE_HEIGHT = 0.17;
// Doubled from 0.03 — sits noticeably higher above the person's head now,
// per the same "easier to read" pass as the size bump above.
const BUBBLE_GAP = 0.06;
// Fast catch-up ease on top of FateEventSystem's own analytic fade-in/hold/
// fade-out curve (see getBubbleOpacity()) — the curve already does the real
// fading; this just smooths the snap-to-0 the instant a hand leaves.
const BUBBLE_EASE_RATE = 8;
const BUBBLE_CANVAS_W = 384;
const BUBBLE_CANVAS_H = 250;

// "Talk to me" markers for this playthrough's named figures — just
// EXPLAIN_FIGURE_INDEX/PAIRED_FIGURE_INDEX for Soul/Organic (the only two
// people per scene with individual narrative lines rather than shared
// ambient chatter), but every visible person for Gas (see
// FateEventSystem.getNamedCount()) — whoever's "named" is worth calling out
// from across the crowd. Reuses the existing
// starIllustration texture (already in the asset manifest, see index.ts)
// rather than drawing a new glyph — quicker, and its bright four-point-star
// shape already reads as "notice me" at a glance. Floats well above
// PERSON_HEIGHT + BUBBLE_GAP's own bubble height so it's visible over the
// whole crowd cap, not just up close, and disappears for good the instant
// that figure's own dialogue actually shows (see _talkedTo/update()) — a
// one-way "found them" signal, not a repeating reminder.
const MARKER_TEXTURE_KEY = 'starIllustration';
const MARKER_SIZE = 0.11;
const MARKER_HEIGHT = PERSON_HEIGHT * 2.3;
const MARKER_PULSE_FREQ = 0.8; // Hz — gentle, same "flash while inviting interaction" idiom as the start menu's own pinch hint
const MARKER_PULSE_MIN_SCALE = 0.85;
const BUBBLE_LINE_HEIGHT = 34;

const SOUL_DUST_TYPE = 0;
const ORGANIC_MATTER_TYPE = 1;
const VOLATILE_GASSES_TYPE = 2;

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

// Beat 4's Soul ghosts / Organic seeds are a Fate-Events-onward mechanic —
// unlike the crowd/decorations above (which progressively form during
// Constellations' own spin, well before Fate Events begins), these two
// GatherableFields shouldn't render at all until Fate Events actually
// starts (see _updateCollectibles's `show` argument below).
const COLLECTIBLE_VISIBLE_FROM = new Set<Phase>([Phase.FateEvents, Phase.Launch, Phase.Finale]);

// Same reasoning/same phase set as PLANET_ARRIVAL_ELIGIBLE_FROM, guarding
// getSpinProgress() the same way — Leg A (the spin transition) only ever
// starts once Constellations begins, so reading its progress before that is
// meaningless (and, worse, this system's own update() runs from world boot,
// where a naive read could misread "never started" as "already at 0").
const SPIN_ELIGIBLE_FROM = PLANET_ARRIVAL_ELIGIBLE_FROM;

// Each person's threshold (i/N) across the Leg A spin's 0-1 progress at
// which it starts scaling in, plus how much of that range its own scale-in
// takes — a STAGGER_WINDOW < 1/N would leave gaps where nobody is actively
// growing; this is comfortably wide so the population reads as continuously
// forming rather than popping in discrete batches.
const STAGGER_WINDOW = 0.3;
const PERSON_SURFACE_OFFSET = 0; // people sit exactly on the surface, no clearance needed

// Every crowd figure now shares the one real animated rig (BreathingIdle.fbx
// — see animated-person.ts's own comment) instead of the old primitive-box
// or OBJ-island placeholders. Body is a fixed black (PERSON_BODY_COLOR,
// shared with earth-situations-vfx-system.ts's King/bench figures — see
// animated-person.ts) rather than retinted per dominant type — see
// _buildPeople's own comment on what that replaced.

// PebbleSynth.playPickup() normally scales its tone off swing speed — there's
// no equivalent for a person activating, so every activation just gets a
// fixed mid-range value for a consistent little "voice" blip.
const VOICE_BLIP_FIXED_SPEED = 1.1;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// Per-constellation "situation" animation layered on top of the base
// bob/bubble behavior above — see EarthSituationsVfxSystem for the
// non-person-attached half of this same feature (ambient decorations,
// dialogue pairing). This stays here because
// it directly manipulates this system's own person arm meshes.
const POINT_UP_DURATION = 4; // seconds organic matter's "point at the comet" pose holds
const POINT_UP_EASE_RATE = 5;
// These apply as an ADDITIVE rotation on the crowd's shared rig's own right-
// arm bone (mixamorigRightArm), layered on top of whatever that frame's
// idle-breathing animation already set — NOT an absolute pose like the old
// primitive-figure code used (see _updateSituations' own comment on why that
// distinction matters now that the arm is animated). Carried over unchanged
// from the old primitive-figure tuning as a starting guess — the Mixamo
// rig's own bone-local axes don't necessarily match the old cylinder-arm's
// convention, so these may need re-tuning once actually seen in headset.
const POINT_UP_ROTATION_X = -1.3;

// Gas's Beat 2.5 (Ambient) crowd reaction — see earth-situations-vfx-
// system.ts's own top comment for the full 0-10s sub-beat breakdown; this
// file owns the sub-beats that manipulate person arm/orientation (watching/
// waving 0-3s, then turning once the King has actually died), since it's
// what already owns those meshes. The death itself is earth-situations-vfx-
// system.ts's own (it owns the king/tower/ghost).
const GAS_WATCH_DURATION = 3;
const GAS_WAVE_ROTATION_X = -0.9;
const GAS_WAVE_FREQ = 2; // Hz
const GAS_WAVE_AMPLITUDE = 0.35; // radians, side-to-side
// The crowd stays in its base outward-facing pose all through the King's
// death, THEN turns to face him over this ramp — started by
// globals.kingDeathComplete flipping true (see _crowdTurnElapsed), not by
// Ambient's own beat-entry timing. Everyone except Pointer (see
// EXPLAIN_FIGURE_INDEX/_gasFacingBlendFor) stays facing the King forever
// once turned — Pointer alone later breaks off to address the player, since
// it's the one whose own line tells the player to go talk to everyone.
const GAS_KING_TURN_RAMP_SECONDS = 1.5;
// How long Pointer keeps facing the fallen King (after finishing the ramp
// above) before breaking off toward the player — see _gasFacingBlendFor.
const POINTER_KING_HOLD_SECONDS = 1.5;
// Pointer's own swivel from King to player, once POINTER_KING_HOLD_SECONDS
// has elapsed.
const GAS_TURN_DURATION = 2;

// Mourner/Griever's shared reaction pose (see GAS_CHARACTER_POSES below).
// Reuses animated-person.ts's loadPersonClip (same technique the King's own
// DyingBackwards.fbx already uses) since it's just another Mixamo clip
// sharing the crowd's existing 'mixamorig...' rig — no separate geometry/
// material/mixer needed, just a clip swap on each figure's already-built
// mixer.
const SITTING_DISBELIEF_URL = '/medium/SittingDisbelief.fbx';
// How long _applyCustomPersonClip's crossfade from idle into the new pose
// takes — same rough "readable but not slow" range as this file's other
// short blends (GAS_KING_TURN_RAMP_SECONDS/POINTER_KING_HOLD_SECONDS).
const CUSTOM_POSE_CROSSFADE_SECONDS = 0.6;

// Gas/Throne's own cast (see notification-copy.ts's GAS_CHARACTER_NAMES for
// the name<->index<->animation mapping this table mirrors) — six figures
// each locked onto one fixed pose instead of the shared BreathingIdle loop.
// Everyone (Pointer included) stays on the plain idle loop through the
// king's death and the crowd's own turn-to-face-the-player, THEN switches
// onto these poses permanently, all at once — see _applyGasCharacterPoses,
// gated on dominantPebbleType being Gas since Soul/Organic never show
// anyone past EXPLAIN_FIGURE_INDEX anyway (see peopleEnabled above).
const ANGRY_URL = '/medium/Angry.fbx';
const ANGRY_POINT_URL = '/medium/AngryPoint.fbx';
const ANGRY_GESTURE_URL = '/medium/AngryGesture.fbx';
// Pointer's own accusatory point reads better slowed down against the
// crowd's normal-speed idle/angry poses — half of the clip's authored speed.
const POINTER_TIME_SCALE = 0.5;

interface GasCharacterPose {
  index: number;
  url: string;
  timeScale: number;
}
const GAS_CHARACTER_POSES: GasCharacterPose[] = [
  { index: EXPLAIN_FIGURE_INDEX, url: ANGRY_POINT_URL, timeScale: POINTER_TIME_SCALE }, // Pointer
  { index: GAS_ACCUSER_INDEX, url: ANGRY_GESTURE_URL, timeScale: 1 }, // Accuser
  { index: GAS_GRUMP_INDEX, url: ANGRY_URL, timeScale: 1 }, // Grump
  { index: GAS_RANTER_INDEX, url: ANGRY_GESTURE_URL, timeScale: 1 }, // Ranter
  { index: GAS_MOURNER_INDEX, url: SITTING_DISBELIEF_URL, timeScale: 1 }, // Mourner
  { index: GAS_GRIEVER_INDEX, url: SITTING_DISBELIEF_URL, timeScale: 1 }, // Griever
];

// Beat 4 — Gas's "symbol added to your tail" flourish. A simpler, inline
// version of the plan's own suggested standalone pooled class: with exactly
// N_PEOPLE (10) possible symbols and each person visitable only once, a
// person's own index already IS a stable, unique ring slot — no separate
// pool/allocation bookkeeping needed, just per-person flight state.
// SIZE bumped 5x and FLIGHT_DURATION correspondingly slowed (0.6 -> 3.0) —
// the original flight read as a blink-and-you-miss-it flick; RING_RADIUS
// widened to match so five-times-bigger icons don't overlap once attached.
const SKULL_FLIGHT_DURATION = 3.0;
const SKULL_RING_RADIUS = 0.12;
const SKULL_SIZE = 0.15;
const SKULL_CANVAS_SIZE = 96;

const enum SkullState {
  Hidden,
  Flying,
  Attached,
}

// Warm gold outline (vs. the crowd's default white rim) — the only visual
// cue that a figure is one of the two named ones, alongside the name shown
// in its speech bubble (see _drawBubbleText's caller). Blinks between a dim
// and bright extreme using the exact same dim<->bright flash constellations-
// vfx-system.ts's own untouched stars use (its FLASH_MIN/FLASH_MAX/
// FLASH_FREQUENCY, reused verbatim rather than re-tuned) — "notice me" reads
// the same way across both scenes. Per-figure random phase (_namedRimPhase,
// same idiom as that file's own per-star flashPhase) keeps the two named
// figures from blinking in lockstep. Also reused (same constants, same
// blink) for Beat 4's graveyard-ghost/seed collectibles (see
// _updateCollectibles) — one consistent "notice me, this is interactive"
// language across every gold-rimmed thing in this file.
const RIM_FLASH_MIN = 0.15;
const RIM_FLASH_MAX = 1.0;
const RIM_FLASH_FREQUENCY = 0.7; // Hz, full dim-to-bright-to-dim cycles per second
const NAMED_RIM_COLOR: [number, number, number] = hexToRgb(NAMED_RIM);
// Build-time sizing for the named-figure materials/markers below — big
// enough to cover whichever type needs the most named slots. Soul/Organic
// only ever use the first NAMED_FIGURE_COUNT (2); Gas uses all GAS_NAMED_
// COUNT (6, see that constant's own comment) since every visible Gas person
// is equally "named" now. Which slots actually GET the gold rim/marker each
// playthrough is decided live via FateEventSystem.getNamedCount() (see
// update()'s own namedCount), not by this constant — this is purely "how
// many instances to build up front."
const MAX_NAMED_FIGURES = Math.max(NAMED_FIGURE_COUNT, GAS_NAMED_COUNT);
// Collectibles' rim settles back to this the instant they're captured — the
// crowd's own ordinary/default rim color (see NAMED_RIM_COLOR's own comment),
// same "gold means interactive, white means settled" language the rest of
// this file already uses.
const COLLECTIBLE_NORMAL_RIM_COLOR: [number, number, number] = hexToRgb(WHITE);

const N_FIRE_QUADS = 8;
const FIRE_RING_RADIUS = 0.4;
const FIRE_RING_Y_OFFSET = -0.15; // below the planet's lowest point
const FIRE_QUAD_W = 0.15;
const FIRE_QUAD_H = 0.2;
const FIRE_FLICKER_FREQ = 3;
const FIRE_BOB_FREQ = 0.8;
const FIRE_BOB_AMP = 0.03;
const FIRE_CANVAS_SIZE = 128;

// Beat 4's Soul ghosts / Organic seeds — both rendered as a handful of
// small glowing spheres (placeholder fidelity, same "simple primitive"
// treatment as everything else in this phase) driven by FateEventSystem's
// own GatherableField instances (see getGraveyardField/getSeedField).
// Free/Attracting particles sit at the field's own live positions; Captured
// ones ride the comet's trail like every other gathered thing in this
// codebase (see trail-sampler.ts). Soul's own Beat 5 payoff ("ghosts dance
// together in your tail") is layered onto the captured ones' trail position
// here too, once FateEventSystem enters FateBeat.Payoff.
// Bumped from 0.025/0.012 — at the old size these were nearly impossible to
// spot scattered across the graveyard/organic cap's actual physical extent
// (PLANET_RADIUS=1.4, CAP_HALF_ANGLE~34-40°  a roughly meter-wide region),
// especially buried among ~28-30 similarly small static decorations; the
// Beat 4 quest read as invisible/broken rather than just small. Paired with
// COLLECTIBLE_PULSE below so the still-uncaptured ones visibly stand out
// from the static scenery around them instead of just being bigger dots.
// 5x back up from 0.009 (that 1/5 cut read as way too small once actually
// seen in headset), then 3x again alongside the crowd's own 3x bump — see
// PERSON_HEIGHT. 0.045 -> 0.135, then cut to 2/3 (0.09).
const GHOST_SIZE = 0.09;
// Ghost spheres render with the exact same translucent wiggly blue look real
// soul-dust pebbles use (pebble-material.ts's SOUL_ISLAND_PALETTE, via a
// per-slot makeToonRimInstancedWigglyLiveRimMaterial instance — see
// _buildGhostMeshes' own comment on why each slot needs its own material
// rather than sharing kSoulIslandMat), so Beat 4's collectibles read as
// literally made of soul dust rather than a separately-tuned glow.
const IDENTITY_MAT4 = new Matrix4();
// Real ghost shapes, swapped in over the placeholder sphere once loaded (see
// _buildGhostMeshes) — one pack shared with fate-event-system.ts's crowd
// (blobpeople.fbx also has several blob-person/person variants in it, not
// used here), picked from by exact name since this file bundles many
// unrelated shapes as siblings (see loadFbxMeshesByName's own comment).
// Confirmed by directly parsing the file: all three are Z-up authored (same
// convention as the plant packs — see convertZUpToYUp) with each mesh's own
// local origin already placed at the base of its tail, so
// normalizeGeometryToUnitRadiusFromOrigin (not the box-center-relative
// normalizer) is the correct fit here — see that function's own comment.
const BLOB_PEOPLE_URL = '/medium/blobpeople.fbx';
const GHOST_MESH_NAMES = ['BlobGhost', 'ghost', 'simpleGhost'] as const;
// Organic's own seed collectibles — same file, same "ground origin at the
// base" authoring convention as the ghost shapes above (confirmed by
// directly parsing the file), so normalizeGeometryToUnitRadiusFromOrigin is
// the right fit here too (see _buildSeedMeshes).
const SEED_MESH_NAMES = ['Blob1', 'Blob2', 'Blob3', 'Blob4'] as const;
const SEED_SIZE = 0.035;
const COLLECTIBLE_PULSE_FREQ = 1.2; // Hz — "come find me" glow, Free/Attracting only
const COLLECTIBLE_PULSE_AMPLITUDE = 0.2; // fractional size swing
// Soul's ghosts float rather than sit on the ground — a gentle constant
// vertical bob (world +Y, not camera-relative like DANCE below, since "up"
// reads the same from any viewing angle) applies in every state (Free,
// Attracting, AND Captured — "should all be bobbing", not just while
// uncaptured), independent of and additive with Beat 5's own dance offset.
const COLLECTIBLE_BOB_FREQ = 0.45; // Hz — slowed from 0.9 for a gentler ghost float
const COLLECTIBLE_BOB_AMPLITUDE = 0.02; // meters
const DANCE_FREQ = 1.4; // Hz
const DANCE_AMPLITUDE = 0.025; // meters, in camera-right/up space
// Organic's Beat 5 "seeds blossom in your tail" (see seed-blossom.ts) — each
// bloom plays PebbleSynth's green/earthy catch plus a light glass twinkle for
// the dust, pitched up bloom by bloom (the synths' own speed->pitch mapping,
// pentatonic-snapped) so the sequence reads as a rising arpeggio, capped by
// the same resolving chime Soul's dance gets once the last one opens.
const BLOOM_SPEED_MIN = 0.2;
const BLOOM_SPEED_MAX = 1.8;
const BLOOM_FINAL_CHIME_FREQ = 520;

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

// kSoulIslandMat's required per-instance attributes (see toon-rim-material.ts)
// stamped onto a single-instance geometry — needed both on the initial
// placeholder sphere and again on each real ghost geometry once swapped in
// (a fresh clone has no instance attributes of its own). aTinted stays 0/
// aTint stays black so the body reads as plain SOUL_ISLAND_PALETTE, same as
// every real soul-dust pebble — no per-ghost recolor.
function stampSoulIslandInstanceAttrs(geo: BufferGeometry): void {
  geo.setAttribute('aBright', new InstancedBufferAttribute(new Float32Array([0.7]), 1));
  geo.setAttribute('aTint', new InstancedBufferAttribute(new Float32Array(3), 3));
  geo.setAttribute('aTinted', new InstancedBufferAttribute(new Float32Array([0]), 1));
  geo.setAttribute('aWigglePhase', new InstancedBufferAttribute(new Float32Array([Math.random()]), 1));
}

// Drawn as canvas primitives, not a fillText('☠', ...) glyph — a Unicode
// glyph is only as good as whatever font the browser happens to resolve
// 'sans-serif' to, and this one was silently rendering as nothing (missing-
// glyph) in at least this environment. Same "drawn object, not a font's
// problem" fix earth-situations-vfx-system.ts's own banner skull already
// uses (see its _drawSkull), just filled red instead of bone-white — Gas's
// skull symbols read as a hot, angry red flying at the player, not a pale
// death's-head.
function buildSkullTexture(): CanvasTexture {
  const s = SKULL_CANVAS_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const cx = s / 2;
  const cy = s / 2;
  const radius = s * 0.42;

  ctx.fillStyle = '#e0201a';
  ctx.beginPath();
  ctx.arc(cx, cy - radius * 0.15, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - radius * 0.55, cy + radius * 0.15);
  ctx.quadraticCurveTo(cx, cy + radius * 1.05, cx + radius * 0.55, cy + radius * 0.15);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(20, 4, 4, 0.9)';
  ctx.beginPath();
  ctx.arc(cx - radius * 0.38, cy - radius * 0.1, radius * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + radius * 0.38, cy - radius * 0.1, radius * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + radius * 0.05);
  ctx.lineTo(cx - radius * 0.12, cy + radius * 0.32);
  ctx.lineTo(cx + radius * 0.12, cy + radius * 0.32);
  ctx.closePath();
  ctx.fill();
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(cx + i * radius * 0.22 - radius * 0.03, cy + radius * 0.55, radius * 0.06, radius * 0.22);
  }
  return new CanvasTexture(canvas);
}

// Renders FateEventSystem's simulation state: the big planet's N
// placeholder people (bobbing when their proximity-triggered "active" state
// is on), their per-person speech bubbles (canvas-texture quads,
// billboarded toward the camera, redrawn only when their dialogue line
// actually changes), Beat 3's single forced explainer line, Beat 4's
// per-type collectible flourish (Gas's skull symbols, Soul's ghosts/
// Organic's seeds), and — only when the dominant type was volatile gasses —
// a small ring of ambient flame quads below the planet. Always-on and
// self-gated via gamePhase (like ConstellationsVfxSystem/
// PlanetSeedingVfxSystem), NOT director-managed: the civilization now forms
// progressively DURING Leg A (the Seeding->Constellations spin transition —
// see PlanetSeedingVfxSystem.getSpinProgress(), read in update()), fully
// formed by the time the spin stops and well before Constellations' own
// gameplay is won — so this system's own visibility can't be tied to Fate
// Events' play()/stop() the way it used to be. People/bubbles/fire also
// track the planet's LIVE position/radius every frame (not a fixed baked
// layout) so they correctly follow through Leg B's later zoom into Fate
// Events too. FateEventSystem itself stays director-managed — its
// proximity/dialogue simulation only runs during Phase.FateEvents, same as
// always.
export class FateEventVfxSystem extends createSystem({
  // CometBody only (no HandAnchor) — Beat 4/5's skull symbols and dancing
  // ghosts need to keep tracking the comet past Orbital Launch's detach,
  // which strips HandAnchor from the entity (see earth-situations-vfx-
  // system.ts's own matching comment on this exact bug).
  comets: { required: [CometBody] },
}) {
  private _fateEvents!: FateEventSystem;
  private _planetSeeding!: PlanetSeedingVfxSystem;
  private _constellations!: ConstellationsSystem;
  private _trailSystem!: CometTrailSystem;
  // Fire stays hidden until PlanetSeedingVfxSystem's Leg B (the final
  // grow/zoom-in — see planet-fate-transition.ts) finishes bringing the
  // planet to its true Fate Events PLANET_CENTER/PLANET_RADIUS — revealing
  // it earlier would show fire around a planet that hasn't visually arrived
  // at its final interaction size/position yet. Renamed from
  // _revealedAfterTransition since it now also gates fire, independent of
  // the people-forming timing (see SPIN_ELIGIBLE_FROM/getSpinProgress()
  // below for that).
  private _planetArrived = false;

  // Fixed black body (see PERSON_BODY_COLOR) — no longer a live-retintable
  // uniform per dominant type, so a plain makeToonRimSkinnedMaterial call
  // rather than makeToonRimFlatMaterial's old per-figure uBodyColor pattern.
  // Named figures still get their own instance purely for the gold rim (see
  // NAMED_RIM_COLOR) — rim color is still baked in at construction.
  private _peopleMaterial!: ReturnType<typeof makeToonRimSkinnedMaterial>;
  private _namedMaterials: ReturnType<typeof makeToonRimSkinnedMaterial>[] = [];
  // Per-named-figure random offset (0-1) into the rim flash cycle — see
  // RIM_FLASH_* constants' own comment.
  private _namedRimPhase!: Float32Array;
  private _personGroups: Group[] = [];
  private _personEntities: Entity[] = [];
  // The crowd's shared animated rig (see animated-person.ts) — one
  // AnimationMixer per figure (each clone has its own independent skeleton/
  // playback state despite sharing one template+clip), and the rig's own
  // right-arm bone for the point-up/wave overlays below (replaces the old
  // primitive figure's raw `rightArm` Mesh).
  private _mixers: (AnimationMixer | null)[] = [];
  private _rightArmBones: (Bone | null)[] = [];
  // The idle-breathing action itself (see animated-person.ts's own
  // AnimatedPerson.idleAction) — kept around so Gas's post-death cast switch
  // below (_applyGasCharacterPoses) can swap each figure's mixer off it.
  private _idleActions: (AnimationAction | null)[] = [];
  // Current EASED additive offset applied on top of the idle animation's own
  // bone rotation each frame (see _updateSituations) — NOT an absolute pose
  // like the old primitive-figure code's _armRestZ/rotation.set() approach,
  // since the bone's base rotation is now animated, not static.
  private _armOffsetX!: Float32Array;
  private _armOffsetZ!: Float32Array;
  // Seconds since THIS activation's single jump started; -1 = not currently
  // jumping (either never activated, or the jump already finished). Set to
  // 0 on the active[i] rising edge, counted up each frame, reset to -1 once
  // the one-shot hop completes — see the main update() loop's own comment.
  // Replaces the old continuous eased-bob-amplitude approach (every active
  // person bobbed for as long as they stayed active); now it's a single hop
  // followed by stillness, with the bubble gated on the hop being done.
  private _jumpElapsed!: Float32Array;
  // Each person's own fixed surface-normal orientation, captured once at
  // build time — Gas's Beat 2.5 "turn to face the player" (see
  // _gasTurnAmount) yaws AWAY from this base each frame rather than
  // accumulating rotation onto a mutating quaternion.
  private _baseQuats: Quaternion[] = [];

  // Per-constellation situation state — see the constants block above.
  private _pointUpTimer = 0;
  private _wasComplete = false;

  // Gas's crowd-turn — seconds since globals.kingDeathComplete was first
  // observed true, counted up each frame once it is; -1 = not yet started
  // (still in the crowd's base outward-facing pose). Drives both
  // _gasTurnAmount (turned-away-from-base ramp, shared by everyone) and
  // _gasFacingBlendFor (per-person King-vs-player gaze target).
  private _crowdTurnElapsed = -1;

  // Set by _applyCustomPersonClip — true for any figure whose mixer is
  // currently NOT on the shared idle loop (Gas's own post-death cast switch
  // below), so both _updateSituations' arm overlay and _resetAll's
  // revert-to-idle logic know to leave/undo that figure alone rather than
  // fight it. Sticky per person (never cleared except on a fresh loop) and
  // doubles as _applyGasCharacterPoses' own per-character one-shot guard.
  private _customPoseActive!: Uint8Array;
  // Gas's own cast (see GAS_CHARACTER_POSES) — one clip per pose, index-
  // matched, loaded once in init(); null until each resolves.
  private _gasCharacterClips: (AnimationClip | null)[] = new Array(GAS_CHARACTER_POSES.length).fill(null);

  private _bubbleMeshes: Mesh[] = [];
  private _bubbleEntities: Entity[] = [];
  private _bubbleCtxs: CanvasRenderingContext2D[] = [];
  private _bubbleTextures: CanvasTexture[] = [];
  private _bubbleOpacity!: Float32Array;
  private _lastLineIndex!: Int16Array;
  private _explainerDrawn = false;

  // "Talk to me" markers, one per built named-figure slot (MAX_NAMED_
  // FIGURES) — see MARKER_* constants' own comment.
  private _markerMeshes: Mesh[] = [];
  private _talkedTo!: Uint8Array;

  private _fireMeshes: Mesh[] = [];
  private _fireEntities: Entity[] = [];
  private _firePositions!: Float32Array;
  private _firePhase!: Float32Array;

  // Beat 4 — Gas's skull-symbol flight (see SkullState/SKULL_* constants).
  private _skullMeshes: Mesh[] = [];
  private _skullState!: Uint8Array;
  private _skullT!: Float32Array;
  private _skullFromX!: Float32Array;
  private _skullFromY!: Float32Array;
  private _skullFromZ!: Float32Array;
  private _wasVisited!: Uint8Array;

  // Beat 4 — Soul's ghosts / Organic's seeds (see GHOST_*/SEED_* constants).
  private _ghostMeshes: Mesh[] = [];
  private _seedMeshes: Mesh[] = [];
  // Random per-slot phase offset into the RIM_FLASH_* blink cycle (same
  // idiom as _namedRimPhase above) — read alongside each mesh's own material
  // (mesh.material, cast to ShaderMaterial; one live-rim instance per ghost/
  // seed, NOT a shared singleton — see _buildGhostMeshes' own comment) in
  // _updateCollectibles.
  private _ghostRimPhase!: Float32Array;
  private _seedRimPhase!: Float32Array;
  // Beat 5 — Organic's seeds-to-plants payoff, riding on _seedMeshes' own
  // trail positions (see seed-blossom.ts).
  private _seedBlossom!: SeedBlossom;

  private _camWorldPos!: Vector3;
  private _faceDir!: Vector3;
  private _upAxis!: Vector3;
  private _zAxis!: Vector3;
  private _normalVec!: Vector3;
  private _scratchPos!: Vector3;
  private _scratchLiveCenter!: Vector3;
  // Gas's Beat 2.5 "turn to face the player" (see _gasTurnAmount's caller) —
  // computed live per-person each frame rather than baked as a fixed
  // world-space yaw constant, since the correct amount depends on each
  // person's own base orientation (itself derived from CROWD_CAP_DIRECTION,
  // see fate-event-system.ts), which can change independently of this file.
  private _scratchGasUp!: Vector3;
  private _scratchGasForward!: Vector3;
  private _scratchGasRight!: Vector3;
  private _scratchGasToTarget!: Vector3;
  private _scratchGasMatrix!: Matrix4;
  private _scratchGasTargetQuat!: Quaternion;
  // Player's live world position — one shared point, recomputed once per
  // frame, not per person. _scratchKingPos is the other shared point (the
  // fallen King); _scratchGasPersonTarget below is where each person's own
  // gaze actually blends BETWEEN the two, per _gasFacingBlendFor(i).
  private _scratchGasFaceTarget!: Vector3;
  private _scratchKingPos!: Vector3;
  private _scratchGasPersonTarget!: Vector3;
  // General "look at the player when a hand lingers nearby" turn (Collect
  // beat only, see FateEventSystem.getTurnAmount) — same up/forward/right
  // basis-construction idiom as the Gas scratch vectors above, kept
  // separate so this doesn't fight that mechanic's own quaternion writes
  // once the Gas King-facing blend (gasTurn) takes over post-King-death.
  private _scratchTurnUp!: Vector3;
  private _scratchTurnForward!: Vector3;
  private _scratchTurnRight!: Vector3;
  private _scratchTurnToTarget!: Vector3;
  private _scratchTurnMatrix!: Matrix4;
  private _scratchTurnQuat!: Quaternion;
  private _scratchTurnTarget!: Vector3;
  private _camRight!: Vector3;
  private _camUp!: Vector3;
  private _camFwd!: Vector3;
  private _scratchTrailPos!: Vector3;
  private _scratchCometPos!: Vector3;

  // "Voice" blip on activation — reuses PebbleSynth's own red/harsh,
  // green/earthy, blue/heavenly character split (see pebble-synth.ts)
  // rather than inventing a new synth, tying Chapter 2's identity through to
  // Fate Events.
  private _audioListener!: AudioListener;
  private _voiceSynth!: PebbleSynth;
  // Beat-4 "you picked one up" cue for the graveyard-ghost/seed collectibles
  // — shares _audioListener (one extra gain node, not a second device, same
  // idiom this file's own class comment on _audioListener already
  // establishes) rather than building a dedicated listener just for this.
  private _twinkleSynth!: TwinkleSynth;
  private _scratchCollectSoundPos!: Vector3;
  private _wasActive!: Uint8Array;
  private _payoffChimePlayed = false;

  init(): void {
    this._fateEvents = this.world.getSystem(FateEventSystem)!;
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;
    // ConstellationsSystem/CometTrailSystem must be registered before this
    // system (see index.ts) so they already exist when this init() runs.
    this._constellations = this.world.getSystem(ConstellationsSystem)!;
    this._trailSystem = this.world.getSystem(CometTrailSystem)!;

    this._camWorldPos = new Vector3();
    this._faceDir = new Vector3();
    this._upAxis = new Vector3(0, 1, 0);
    this._zAxis = new Vector3(0, 0, 1);
    this._normalVec = new Vector3();
    this._scratchPos = new Vector3();
    this._scratchLiveCenter = new Vector3();
    this._scratchGasUp = new Vector3();
    this._scratchGasForward = new Vector3();
    this._scratchGasRight = new Vector3();
    this._scratchGasToTarget = new Vector3();
    this._scratchGasMatrix = new Matrix4();
    this._scratchGasTargetQuat = new Quaternion();
    this._scratchGasFaceTarget = new Vector3();
    this._scratchKingPos = new Vector3();
    this._scratchTurnUp = new Vector3();
    this._scratchTurnForward = new Vector3();
    this._scratchTurnRight = new Vector3();
    this._scratchTurnToTarget = new Vector3();
    this._scratchTurnMatrix = new Matrix4();
    this._scratchTurnQuat = new Quaternion();
    this._scratchTurnTarget = new Vector3();
    this._scratchGasPersonTarget = new Vector3();
    this._camRight = new Vector3();
    this._camUp = new Vector3();
    this._camFwd = new Vector3();
    this._scratchTrailPos = new Vector3();
    this._scratchCometPos = new Vector3();

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._voiceSynth = new PebbleSynth();
    this._voiceSynth.build(this._audioListener, this.scene);
    this._twinkleSynth = new TwinkleSynth();
    this._twinkleSynth.build(this._audioListener, this.scene);
    this._scratchCollectSoundPos = new Vector3();
    this._wasActive = new Uint8Array(this._fateEvents.getPersonCount());
    this._wasVisited = new Uint8Array(this._fateEvents.getPersonCount());
    this._skullState = new Uint8Array(this._fateEvents.getPersonCount());
    this._skullT = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromX = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromY = new Float32Array(this._fateEvents.getPersonCount());
    this._skullFromZ = new Float32Array(this._fateEvents.getPersonCount());

    this._talkedTo = new Uint8Array(MAX_NAMED_FIGURES);
    this._customPoseActive = new Uint8Array(this._fateEvents.getPersonCount());
    GAS_CHARACTER_POSES.forEach((pose, slot) => {
      loadPersonClip(pose.url).then((clip) => {
        this._gasCharacterClips[slot] = clip;
      });
    });

    this._buildPeople();
    this._buildBubbles();
    this._buildTalkMarkers();
    this._buildFire();
    this._buildSkulls();
    this._buildGhostMeshes(this._ghostMeshes, this._fateEvents.getGraveyardField().count);
    this._buildSeedMeshes(this._seedMeshes, this._fateEvents.getSeedField().count);
    this._seedBlossom = new SeedBlossom();
    this._seedBlossom.build(this.world, this._fateEvents.getSeedField().count, (rank, total, position) =>
      this._onSeedBloom(rank, total, position),
    );

    // signal.subscribe() fires immediately, so state is correct before the
    // first frame renders (same idiom ConstellationsVfxSystem/
    // PlanetSeedingVfxSystem use for their own gamePhase gating).
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => this._onPhaseChange(phase)),
    );
  }

  private _onPhaseChange(phase: Phase): void {
    if (phase === Phase.FateEvents) {
      // People are already visible from Constellations — this just adds the
      // interactive bubble layer. Body color is fixed black now (see
      // PERSON_BODY_COLOR) — no more per-phase dominant-type/mood retint.
      for (const mesh of this._bubbleMeshes) mesh.visible = true;
    } else if (phase === Phase.Stardust) {
      this._resetAll();
    }
  }

  private _resetAll(): void {
    this._planetArrived = false;
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      group.visible = false;
      group.scale.setScalar(0);
      group.rotation.z = 0;
      if (this._baseQuats[i]) group.quaternion.copy(this._baseQuats[i]);
    }
    this._armOffsetX.fill(0);
    this._armOffsetZ.fill(0);
    for (const mesh of this._bubbleMeshes) mesh.visible = false;
    for (const mesh of this._markerMeshes) mesh.visible = false;
    this._talkedTo.fill(0);
    for (const mesh of this._fireMeshes) mesh.visible = false;
    for (const mesh of this._skullMeshes) mesh.visible = false;
    for (const mesh of this._ghostMeshes) mesh.visible = false;
    for (const mesh of this._seedMeshes) mesh.visible = false;
    this._seedBlossom.reset();
    this._wasActive.fill(0);
    this._wasVisited.fill(0);
    this._skullState.fill(SkullState.Hidden);
    this._bubbleOpacity.fill(0);
    this._lastLineIndex.fill(-1);
    this._jumpElapsed.fill(-1);
    this._pointUpTimer = 0;
    this._wasComplete = false;
    this._explainerDrawn = false;
    this._payoffChimePlayed = false;
    this._crowdTurnElapsed = -1;

    // Undo _applyCustomPersonClip's action swap (Gas's own per-character
    // poses, and/or the king-death sitting-disbelief reaction) so a fresh
    // loop's crowd comes back up breathing/idle again instead of frozen
    // mid-pose — same idiom earth-situations-vfx-system.ts's own
    // _resetAll() already uses to undo the King's DyingBackwards swap.
    for (let i = 0; i < this._customPoseActive.length; i++) {
      if (!this._customPoseActive[i]) continue;
      this._mixers[i]?.stopAllAction();
      this._idleActions[i]?.reset().play();
    }
    this._customPoseActive.fill(0);
  }

  private _buildPeople(): void {
    const count = this._fateEvents.getPersonCount();
    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();

    // Fixed black body for every human figure now (PERSON_BODY_COLOR) — the
    // old per-dominant-type retint is gone (see _onPhaseChange, which used
    // to set this live each phase change). Named figures still get their
    // own material instance purely for the gold rim — NAMED_RIM_COLOR is
    // baked in at construction, unlike body color which used to be a live
    // per-instance uniform override.
    this._peopleMaterial = makeToonRimSkinnedMaterial(PERSON_BODY_COLOR);
    this._namedRimPhase = new Float32Array(MAX_NAMED_FIGURES);
    for (let i = 0; i < MAX_NAMED_FIGURES; i++) {
      this._namedMaterials.push(makeToonRimSkinnedMaterial(PERSON_BODY_COLOR, NAMED_RIM_COLOR));
      this._namedRimPhase[i] = Math.random();
    }
    this._jumpElapsed = new Float32Array(count).fill(-1);
    this._armOffsetX = new Float32Array(count);
    this._armOffsetZ = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const material = i < MAX_NAMED_FIGURES ? this._namedMaterials[i] : this._peopleMaterial;
      // Non-animated primitive placeholder immediately (visible/functional
      // right away, same graceful-degradation idiom every other FBX
      // consumer in this codebase uses) — swapped for the real shared
      // animated rig once BreathingIdle.fbx resolves (see
      // _swapToAnimatedPeople). makeToonRimSkinnedMaterial works fine on
      // this plain (non-skinned) geometry too — USE_SKINNING only compiles
      // in for an actual SkinnedMesh (see the material's own comment), so
      // the unused skinIndex/skinWeight attributes are simply inert here.
      const { group } = buildPlaceholderPerson(material);
      group.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      group.quaternion.setFromUnitVectors(this._upAxis, this._normalVec);
      group.visible = false;
      this._personGroups.push(group);
      this._mixers.push(null); // no real rig/mixer until the swap below resolves
      this._rightArmBones.push(null); // _updateSituations skips the arm overlay entirely until this is real
      this._idleActions.push(null);
      this._baseQuats.push(group.quaternion.clone());
      this._personEntities.push(this.world.createTransformEntity(group));
    }

    loadAnimatedPersonTemplate().then((template) => this._swapToAnimatedPeople(template));
  }

  // Rebuilds every person's group in place (same Entity, same position/
  // orientation logic already applied in _buildPeople) once the shared
  // BreathingIdle rig has loaded — until then the primitive placeholder
  // figures built above keep showing.
  private _swapToAnimatedPeople(template: Awaited<ReturnType<typeof loadAnimatedPersonTemplate>>): void {
    if (!template) {
      console.warn('[FateEventVfxSystem] BreathingIdle.fbx unavailable — keeping the primitive placeholder figures.');
      return;
    }
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      while (group.children.length > 0) group.remove(group.children[0]);

      const material = i < MAX_NAMED_FIGURES ? this._namedMaterials[i] : this._peopleMaterial;
      const animated = buildAnimatedPerson(template, material, PERSON_HEIGHT);
      group.add(animated.group);
      this._mixers[i] = animated.mixer;
      this._rightArmBones[i] = animated.rightArmBone;
      this._idleActions[i] = animated.idleAction;
    }
  }

  // Blends from whatever this figure's mixer currently has playing (always
  // the idle action — see _customPoseActive's own one-shot-guard comment,
  // this only ever fires once per figure) into the new clip over
  // CUSTOM_POSE_CROSSFADE_SECONDS, instead of a hard mixer.stopAllAction()
  // cut — the idle breathing loop otherwise vanishes and the reaction pose
  // snaps in on the very same frame, which read as an abrupt switch rather
  // than someone's posture actually changing.
  private _applyCustomPersonClip(i: number, clip: AnimationClip, timeScale = 1): void {
    const mixer = this._mixers[i];
    const idleAction = this._idleActions[i];
    if (!mixer || !idleAction) return; // still on the primitive placeholder — no real rig to switch yet
    this._customPoseActive[i] = 1;
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(LoopRepeat, Infinity);
    action.timeScale = timeScale;
    // Staggered per-person start offset into the clip's own loop — without
    // this the pair sharing Sitting Disbelief (Mourner/Griever) would move in
    // perfect unison, same "everyone starts at t=0 together" problem
    // buildAnimatedPerson's own idle-phase randomization already solves for
    // the breathing loop (see animated-person.ts).
    action.time = Math.random() * clip.duration;
    action.play();
    action.crossFadeFrom(idleAction, CUSTOM_POSE_CROSSFADE_SECONDS, false);
  }

  // Gas/Throne only (see GAS_CHARACTER_POSES' own comment) — everyone in the
  // gas vignette (Pointer included) stays on the plain idle loop through the
  // king's death and the crowd's own turn (see _crowdTurnElapsed/
  // _gasFacingBlendFor), THEN switches permanently onto their individual
  // pose once Ambient itself ends (fate-event-system.ts's AMBIENT_BEAT_
  // SECONDS) — comfortably after both the death and the full turn sequence
  // (crowd-turn ramp + Pointer's own hold + break-off, all tuned to finish
  // well inside Ambient's fixed 10s). kingDeathComplete is checked
  // explicitly too, tying this to the actual gameplay event rather than
  // just Ambient's timing. _customPoseActive itself is this method's
  // per-character one-shot guard, so it's cheap to just re-check all 6
  // every frame once past Ambient rather than needing a separate
  // applied-everything flag.
  private _applyGasCharacterPoses(dominant: number, beat: FateBeat): void {
    if (dominant !== VOLATILE_GASSES_TYPE) return;
    if (beat === FateBeat.Zoom || beat === FateBeat.Ambient) return;
    if (!getGlobals(this.world).kingDeathComplete.peek()) return;
    for (let slot = 0; slot < GAS_CHARACTER_POSES.length; slot++) {
      const pose = GAS_CHARACTER_POSES[slot];
      if (this._customPoseActive[pose.index]) continue;
      const clip = this._gasCharacterClips[slot];
      if (!clip) continue;
      this._applyCustomPersonClip(pose.index, clip, pose.timeScale);
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

  // See MARKER_* constants' own comment — one shared material (one texture,
  // no per-instance tint needed) across both named figures' markers.
  private _buildTalkMarkers(): void {
    const material = new MeshBasicMaterial({
      map: AssetManager.getTexture(MARKER_TEXTURE_KEY),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    const geo = new PlaneGeometry(MARKER_SIZE, MARKER_SIZE);
    for (let i = 0; i < MAX_NAMED_FIGURES; i++) {
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._markerMeshes.push(mesh);
      this.world.createTransformEntity(mesh);
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

  private _buildSkulls(): void {
    const count = this._fateEvents.getPersonCount();
    const geo = new PlaneGeometry(SKULL_SIZE, SKULL_SIZE);
    const texture = buildSkullTexture();
    for (let i = 0; i < count; i++) {
      const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide });
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._skullMeshes.push(mesh);
      this.world.createTransformEntity(mesh);
    }
  }

  // Beat 4's Soul ghosts, one InstancedMesh (count=1) per slot rather than a
  // real Mesh — the wiggly toon-rim shader is instanced-only (its vertex
  // stage reads `instanceMatrix` directly and needs aBright/aTint/aTinted/
  // aWigglePhase attributes, see toon-rim-material.ts), so a plain Mesh
  // can't use it. Each instance's transform stays identity forever — this
  // file's existing _updateCollectibles already drives per-ghost position/
  // scale through the mesh's own Object3D transform (InstancedMesh extends
  // Mesh), which composes on top of that identity instance untouched.
  // aTinted stays 0 and aTint stays black, same as every real soul-dust
  // pebble (see pebble-field-vfx-system.ts's own TYPE_SOUL branch) — no
  // per-ghost body recolor, just the material's own SOUL_ISLAND_PALETTE body.
  //
  // Each slot gets its OWN material (makeToonRimInstancedWigglyLiveRimMaterial,
  // same SOUL_ISLAND_PALETTE/amplitude/opacity kSoulIslandMat itself uses)
  // rather than sharing that module-scope singleton — kSoulIslandMat is
  // reused by every real soul-dust pebble across the whole game (see
  // pebble-material.ts), so mutating ITS rim uniform to blink gold would blink
  // every pebble everywhere, not just Beat 4's own collectibles. Each ghost's
  // own uTime must now be kept fresh here too (see _updateCollectibles) —
  // previously free-riding on kSoulIslandMat's uTime being updated elsewhere
  // (pebble-field-vfx-system.ts/pebble-comet-presentation-system.ts) now that
  // it's no longer that shared instance.
  //
  // Starts every slot with a placeholder sphere (visible/functional
  // immediately, same graceful-degradation idiom every other FBX consumer in
  // this codebase uses), then — once blobpeople.fbx resolves — swaps each
  // slot's geometry to a clone of one of the three real ghost shapes, picked
  // at random per slot (~1/3 each, same uniform-random-pick idiom
  // PLANT_PALETTE/PEBBLE_COLORED_PALETTE already use elsewhere rather than a
  // strict round-robin partition). Falls back to whichever of the three
  // names actually resolved (or leaves the placeholder spheres alone if none
  // did) rather than failing all-or-nothing on one bad name.
  private _buildGhostMeshes(target: Mesh[], count: number): void {
    this._ghostRimPhase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const geo = new SphereGeometry(GHOST_SIZE, 8, 6);
      stampSoulIslandInstanceAttrs(geo);
      const material = makeToonRimInstancedWigglyLiveRimMaterial(SOUL_ISLAND_PALETTE, {
        amplitude: 0.19,
        opacity: 0.55,
      });
      this._ghostRimPhase[i] = Math.random();
      const mesh = new InstancedMesh(geo, material, 1);
      mesh.setMatrixAt(0, IDENTITY_MAT4);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      mesh.visible = false;
      target.push(mesh);
      this.world.createTransformEntity(mesh);
    }

    loadFbxMeshesByName(BLOB_PEOPLE_URL, GHOST_MESH_NAMES, normalizeGeometryToUnitRadiusFromOrigin).then((geos) => {
      const variants = geos.filter((geo): geo is BufferGeometry => geo !== null);
      if (variants.length === 0) return; // none resolved — keep the placeholder spheres
      for (const geo of variants) convertZUpToYUp(geo);
      for (const mesh of target) {
        const picked = variants[Math.floor(Math.random() * variants.length)];
        const geo = picked.clone();
        // `picked` is unit-radius (normalizeGeometryToUnitRadiusFromOrigin) —
        // bake GHOST_SIZE in directly, same "size lives in the geometry, not
        // the instance scale" convention the placeholder sphere above already
        // uses (SphereGeometry(GHOST_SIZE, ...)), so _updateCollectibles'
        // pulse multiplier (~1) means the same thing for both.
        const pos = geo.getAttribute('position');
        for (let v = 0; v < pos.count; v++) {
          pos.setXYZ(v, pos.getX(v) * GHOST_SIZE, pos.getY(v) * GHOST_SIZE, pos.getZ(v) * GHOST_SIZE);
        }
        pos.needsUpdate = true;
        stampSoulIslandInstanceAttrs(geo);
        (mesh.geometry as BufferGeometry).dispose();
        mesh.geometry = geo;
      }
    });
  }

  // Organic's own seed collectibles — starts every slot with a placeholder
  // toon-rim sphere (same graceful-degradation idiom _buildGhostMeshes uses
  // above), then swaps each slot's geometry to a clone of one of the real
  // Blob1-4 shapes (see SEED_MESH_NAMES) once blobpeople.fbx resolves,
  // picked at random per slot. Each slot also gets its own random body color
  // off ORGANIC_PALETTE (color-scheme.ts — the same fixed 5-color set
  // PlanetGrowthPool's plants and the pebble field's own organics draw from)
  // instead of the old single flat SEED_COLOR — "multicolored
  // organic" — picked once and kept for both the placeholder and the
  // eventual real mesh so a slot's color never pops when the swap happens.
  // Gold rim (NAMED_RIM_COLOR — the same identity color the two featured
  // figures already use) rather than the old additive glow, matching the
  // toon-rim silhouette look everything else in Fate Events uses. Blinks the
  // same RIM_FLASH_* cadence as the named figures' own gold rim (see
  // _updateCollectibles) and settles to COLLECTIBLE_NORMAL_RIM_COLOR the
  // instant it's captured — makeToonRimFlatMaterial's rimColor is already a
  // live uRimColor uniform per its own per-owner instance (one material per
  // seed here, never shared), so no material-factory changes were needed for
  // this one, unlike the ghosts above.
  private _buildSeedMeshes(target: Mesh[], count: number): void {
    const palette = ORGANIC_PALETTE;
    this._seedRimPhase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const bodyColor = palette[Math.floor(Math.random() * palette.length)];
      const material = makeToonRimFlatMaterial(bodyColor, NAMED_RIM_COLOR);
      this._seedRimPhase[i] = Math.random();
      const mesh = new Mesh(new SphereGeometry(SEED_SIZE, 8, 6), material);
      mesh.visible = false;
      target.push(mesh);
      this.world.createTransformEntity(mesh);
    }

    loadFbxMeshesByName(BLOB_PEOPLE_URL, SEED_MESH_NAMES, normalizeGeometryToUnitRadiusFromOrigin).then((geos) => {
      const variants = geos.filter((geo): geo is BufferGeometry => geo !== null);
      if (variants.length === 0) return; // none resolved — keep the placeholder spheres
      for (const geo of variants) convertZUpToYUp(geo);
      for (const mesh of target) {
        const picked = variants[Math.floor(Math.random() * variants.length)];
        const geo = picked.clone();
        // `picked` is unit-radius (normalizeGeometryToUnitRadiusFromOrigin,
        // origin at the shape's own ground/base point) — bake SEED_SIZE in
        // directly, same "size lives in the geometry, not the instance
        // scale" convention the placeholder sphere above uses.
        const pos = geo.getAttribute('position');
        for (let v = 0; v < pos.count; v++) {
          pos.setXYZ(v, pos.getX(v) * SEED_SIZE, pos.getY(v) * SEED_SIZE, pos.getZ(v) * SEED_SIZE);
        }
        pos.needsUpdate = true;
        (mesh.geometry as BufferGeometry).dispose();
        mesh.geometry = geo;
      }
    });
  }

  update(delta: number, time: number): void {
    const phase = getGlobals(this.world).gamePhase.peek();
    const dominant = getGlobals(this.world).dominantPebbleType.peek();

    // Advances every figure's shared idle-breathing animation — null until
    // BreathingIdle.fbx resolves and _swapToAnimatedPeople runs (see its own
    // comment). Must run BEFORE _updateSituations below so that method's
    // point-up/wave overlay composes on top of THIS frame's fresh idle pose
    // rather than last frame's. Cheap at N_PEOPLE=10 — always safe to run
    // regardless of visibility, same reasoning _updateLivePositions below
    // already uses.
    for (const mixer of this._mixers) mixer?.update(delta);

    if (this._constellations.isComplete() && !this._wasComplete) {
      this._wasComplete = true;
      if (dominant === ORGANIC_MATTER_TYPE) this._pointUpTimer = POINT_UP_DURATION;
    }

    this._applyGasCharacterPoses(dominant, this._fateEvents.getBeat());

    const positions = this._fateEvents.getSurfacePositions();
    const normals = this._fateEvents.getNormals();
    const count = this._fateEvents.getPersonCount();
    // Re-derive every person's world position from its fixed normal (see
    // scatterOnSphereCap — radius/center-independent by construction) plus
    // the planet's LIVE position/radius, so people correctly follow through
    // both Leg A (spin+recede) and Leg B (final zoom-in) instead of only
    // matching one fixed final layout. Cheap at N_PEOPLE=10 — always safe to
    // run, even before either transition has started (harmless, since
    // nobody's visible yet).
    this._updateLivePositions(positions, normals, count);

    if (
      !this._planetArrived &&
      PLANET_ARRIVAL_ELIGIBLE_FROM.has(phase) &&
      !this._planetSeeding.isFateTransitionActive()
    ) {
      this._planetArrived = true;
      const showFire = this._fateEvents.getShowFire();
      for (const mesh of this._fireMeshes) mesh.visible = showFire;
    }

    // Core-narrative trim: the ambient CROWD is disabled for Soul/Organic —
    // their Beat 4 quests are the graveyard ghosts / seed field, not
    // visiting people, so a whole crowd was pure (distracting) flavor there.
    // Gas keeps its full crowd since visiting everyone IS that type's actual
    // Beat 4 mechanic. Soul/Organic still keep exactly ONE figure visible
    // (EXPLAIN_FIGURE_INDEX, via maxVisible=1 below) — the player still
    // needs someone to actually deliver Beat 3's "here's what these ghosts/
    // seeds are" line before Collect starts, just not a whole crowd around
    // them. The underlying simulation (FateEventSystem's active/visited/
    // dialogue state) keeps running untouched either way — this only gates
    // the VISUAL layer (meshes/ambient bubbles/voice blips below) so the
    // dialogue system stays intact as a backup to re-enable later.
    const peopleEnabled = dominant === VOLATILE_GASSES_TYPE;
    // Lightweight "society" cap per dominant type (see fate-event-system.ts's
    // VISIBLE_PEOPLE_BY_TYPE) — a sparser ghost-town read for volatile
    // gasses, denser for organics. Read live every frame rather than cached,
    // same reasoning as FateEventSystem.getVisiblePeopleCount() itself.
    const maxVisible = peopleEnabled ? this._fateEvents.getVisiblePeopleCount() : 1;

    // Civilization forms DURING Leg A (see SPIN_ELIGIBLE_FROM/
    // getSpinProgress()) — each person has its own staggered threshold
    // across the 0-1 spin progress so the population grows in one-by-one
    // rather than popping in all at once, easing scale via smoothstep
    // rather than a hard visibility toggle. Monotonic within a loop (see
    // PlanetSpinTransition.getProgress()), so no separate clamping needed
    // to prevent regression once fully formed.
    // Past Constellations the civilization is always fully formed — Leg A is
    // long over by then, so getSpinProgress() already returns 1 in normal
    // play and this max() changes nothing. It only matters on a dev-menu
    // jump straight to Fate Events (skipping Constellations, so Leg A never
    // ran at all): PlanetSpinTransition.getProgress() reports 0 for "never
    // started", which would otherwise leave every person scaled to 0 and the
    // whole crowd invisible for a phase whose entire content is that crowd.
    // Same dev-menu-skip safety-net idiom planet-seeding-vfx-system.ts's own
    // startFateEventsTransition() already documents.
    const rawSpinProgress = SPIN_ELIGIBLE_FROM.has(phase) ? this._planetSeeding.getSpinProgress() : 0;
    const spinProgress = phase === Phase.Constellations ? rawSpinProgress : Math.max(rawSpinProgress, SPIN_ELIGIBLE_FROM.has(phase) ? 1 : 0);
    // 1.0 at Fate Events' own full PLANET_RADIUS, shrinking in lockstep the
    // rest of the time — keeps the crowd correctly sized relative to the
    // planet through Leg A's smaller intermediate radius and Leg C's later
    // recede/shrink for Launch, not just fixed at their Fate-Events-tuned
    // absolute size forever once formed.
    const radiusScale = this._planetSeeding.getLivePlanetRadius() / this._fateEvents.getPlanetRadius();
    const beat = this._fateEvents.getBeat();
    const isGasFateEvents = dominant === VOLATILE_GASSES_TYPE && phase === Phase.FateEvents;
    // Starts counting the instant the King's death actually finishes (see
    // globals.kingDeathComplete) rather than on Ambient's own beat-entry
    // timing, so the crowd stays in its base outward-facing pose right up
    // until he's actually dead. Sticky once started (never reset except on a
    // fresh loop, see _resetAll) — keeps counting through later beats too, so
    // the turn (and Pointer's later break-off) both persist into Explain/
    // Collect/Payoff same as before.
    if (this._crowdTurnElapsed < 0) {
      if (dominant === VOLATILE_GASSES_TYPE && getGlobals(this.world).kingDeathComplete.peek()) {
        this._crowdTurnElapsed = 0;
      }
    } else {
      this._crowdTurnElapsed += delta;
    }
    const gasTurn = isGasFateEvents ? this._gasTurnAmount() : 0;
    if (gasTurn > 0) {
      // King/player world points — shared by everyone, computed once here
      // rather than per-person inside the loop below. Each person then
      // blends between the two per their OWN _gasFacingBlendFor(i).
      this.camera.getWorldPosition(this._scratchGasFaceTarget);
      const liveReach = this._planetSeeding.getLivePlanetRadius() + PERSON_SURFACE_OFFSET;
      this._scratchKingPos.copy(this._scratchLiveCenter).addScaledVector(CROWD_CAP_DIRECTION, liveReach);
    }
    for (let i = 0; i < this._personGroups.length; i++) {
      const group = this._personGroups[i];
      if (i >= maxVisible) {
        group.visible = false;
        continue;
      }
      const t = clamp01((spinProgress - i / this._personGroups.length) / STAGGER_WINDOW);
      const formed = smoothstep(t);
      group.visible = formed > 0;
      group.scale.setScalar(formed * radiusScale);

      if (gasTurn > 0) {
        // mix(king, player, facingBlend) — facingBlend 0 = facing the King
        // (everyone starts here and, except Pointer, stays here forever), 1
        // = facing the player (Pointer only, once it breaks off — see
        // _gasFacingBlendFor).
        const facingBlend = this._gasFacingBlendFor(i);
        this._scratchGasPersonTarget.copy(this._scratchKingPos).lerp(this._scratchGasFaceTarget, facingBlend);

        // Recover this person's own outward "up" straight from their base
        // quaternion (it's exactly the normal that baseQuat's own
        // setFromUnitVectors(worldUp, normal) was built from) rather than
        // assuming a shared/fixed up axis — keeps them standing correctly on
        // their own patch of the curved surface regardless of where
        // CROWD_CAP_DIRECTION currently points. group.position is one frame
        // stale here (this loop runs before the one that positions people
        // this frame) — harmless given how slowly it actually moves.
        this._scratchGasUp.set(0, 1, 0).applyQuaternion(this._baseQuats[i]);
        this._scratchGasToTarget.copy(this._scratchGasPersonTarget).sub(group.position);
        const alongUp = this._scratchGasToTarget.dot(this._scratchGasUp);
        this._scratchGasForward.copy(this._scratchGasToTarget).addScaledVector(this._scratchGasUp, -alongUp);
        if (this._scratchGasForward.lengthSq() < 1e-6) this._scratchGasForward.set(0, 0, 1);
        this._scratchGasForward.normalize();
        this._scratchGasRight.crossVectors(this._scratchGasUp, this._scratchGasForward).normalize();
        this._scratchGasMatrix.makeBasis(this._scratchGasRight, this._scratchGasUp, this._scratchGasForward);
        this._scratchGasTargetQuat.setFromRotationMatrix(this._scratchGasMatrix);
        group.quaternion.copy(this._baseQuats[i]).slerp(this._scratchGasTargetQuat, gasTurn);
      } else {
        // General "turn to look at the player" for the Collect beat's
        // ambient dwell interaction (see FateEventSystem.getTurnAmount) —
        // only reached once gasTurn is 0, i.e. everyone before the Gas
        // King-facing blend takes over (that mechanic owns orientation for
        // the rest of the phase once it starts, see the branch above), which
        // covers Soul/Organic entirely and Gas up until the King's death.
        const turnAmount = beat === FateBeat.Collect ? this._fateEvents.getTurnAmount(i) : 0;
        if (turnAmount > 0) {
          this.camera.getWorldPosition(this._scratchTurnTarget);
          this._computeFaceQuaternion(this._baseQuats[i], group.position, this._scratchTurnTarget, this._scratchTurnQuat);
          group.quaternion.copy(this._baseQuats[i]).slerp(this._scratchTurnQuat, turnAmount);
        } else if (!group.quaternion.equals(this._baseQuats[i])) {
          group.quaternion.copy(this._baseQuats[i]);
        }
      }
    }

    this.camera.getWorldPosition(this._camWorldPos);
    this._camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._camUp.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this._camFwd.setFromMatrixColumn(this.camera.matrixWorld, 2);

    const active = this._fateEvents.getActiveMask();
    const lineIndex = this._fateEvents.getLineIndex();
    // Live per-playthrough switch (see FateEventSystem.getNamedCount()'s own
    // comment) — 2 for Soul/Organic, all of GAS_NAMED_COUNT for Gas.
    const namedCount = this._fateEvents.getNamedCount();

    const bubblePull = 1 - Math.exp(-BUBBLE_EASE_RATE * delta);
    // Livelier idle bob for organics, sluggish for a gasses "ghost town" —
    // see fate-event-system.ts's BOB_FREQUENCY_MULT_BY_TYPE. Now the speed
    // of the ONE hop (see _jumpElapsed) rather than a continuous bob's
    // frequency, but the same "organics spring, gasses lumber" character
    // still comes through in how snappy that single hop reads.
    const bobFrequency = JUMP_FREQUENCY * this._fateEvents.getBobFrequencyMultiplier();
    const jumpAmplitude = JUMP_AMPLITUDE;
    const isExplain = phase === Phase.FateEvents && beat === FateBeat.Explain;

    for (let i = 0; i < count; i++) {
      this._normalVec.set(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
      this._scratchPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      // Recomputed fresh every frame rather than cached once at _buildPeople()
      // time — FateEventSystem can now rebuild `normals` per play() (Throne's
      // semicircle vs. everyone else's cap, see its own _buildSurfaceLayout),
      // which happens well after this system's one-time init(). A stale
      // cached quaternion would leave a person's orientation matching
      // whichever layout was active at boot instead of the current one, even
      // though their (correctly live-tracked) position already moved to the
      // new spot. Cheap at N_PEOPLE=10.
      this._baseQuats[i].setFromUnitVectors(this._upAxis, this._normalVec);

      if (active[i] && !this._wasActive[i]) {
        this._wasActive[i] = 1;
        this._jumpElapsed[i] = 0; // triggers the one-shot hop below
        if (peopleEnabled) this._voiceSynth.playPickup(dominant, this._scratchPos, VOICE_BLIP_FIXED_SPEED);
      } else if (!active[i]) {
        this._wasActive[i] = 0;
      }

      // Math.sin over a single half-period (phase 0->PI is exactly one
      // up-and-back-down hump) rather than the old Math.max(0, sin(...))
      // repeating-hump approach — that read as continuous bobbing for as
      // long as `active` stayed true. Once phase reaches PI the hop is
      // over and _jumpElapsed resets to -1 (not currently jumping), which
      // is also what un-gates the bubble just below.
      let bobOffset = 0;
      if (this._jumpElapsed[i] >= 0) {
        this._jumpElapsed[i] += delta;
        const jumpPhase = this._jumpElapsed[i] * bobFrequency * Math.PI * 2;
        if (jumpPhase < Math.PI) {
          bobOffset = jumpAmplitude * Math.sin(jumpPhase);
        } else {
          this._jumpElapsed[i] = -1;
        }
      }
      const jumping = this._jumpElapsed[i] >= 0;

      const group = this._personGroups[i];
      group.position.copy(this._scratchPos).addScaledVector(this._normalVec, bobOffset);

      // Not gated on peopleEnabled — the explainer figure is the ONE person
      // Soul/Organic keep visible (see maxVisible above), specifically so
      // this line still shows for them, not just Gas's full crowd. Also not
      // gated on `jumping` — the explainer's own reveal is scripted
      // (Beat 3), not proximity-triggered, so it has no hop to wait out.
      const isExplainerFigure = isExplain && i === EXPLAIN_FIGURE_INDEX;
      const bubbleMesh = this._bubbleMeshes[i];
      // Ambient ("ghost-town"/idle) dialogue only ever advances while
      // FateEventSystem's own _updateCollect is running (Beat 4/Collect) —
      // once the beat moves on to Payoff, `active`/the current line just
      // stay frozen at whatever they last were, with nothing to clear them.
      // Without the phase check, a bubble still open at that moment would
      // otherwise keep reading as "on" straight through the rest of Fate
      // Events and into Launch. Explicitly off once Launch begins.
      const targetOpacity = isExplainerFigure
        ? this._fateEvents.getExplainerOpacity()
        : phase === Phase.FateEvents && peopleEnabled && active[i] && !jumping
          ? this._fateEvents.getBubbleOpacity(i)
          : 0;
      this._bubbleOpacity[i] += (targetOpacity - this._bubbleOpacity[i]) * bubblePull;
      (bubbleMesh.material as MeshBasicMaterial).opacity = this._bubbleOpacity[i];

      if (isExplainerFigure) {
        if (!this._explainerDrawn) {
          this._explainerDrawn = true;
          this._drawBubbleText(i, this._fateEvents.getExplainerText());
          this._lastLineIndex[i] = -1; // force a redraw once Collect's own ambient line takes back over
        }
      } else if (active[i] && this._lastLineIndex[i] !== lineIndex[i]) {
        this._lastLineIndex[i] = lineIndex[i];
        // getLineText already routes through getDialogueLinesFor for
        // non-featured figures (see fate-event-system.ts), so the
        // paired-ghost override still applies — the two featured figures'
        // own arc just takes priority.
        const text = this._fateEvents.getLineText(i);
        this._drawBubbleText(i, text);
      }
      if (!isExplain) this._explainerDrawn = false;

      bubbleMesh.position
        .copy(this._scratchPos)
        .addScaledVector(this._normalVec, PERSON_HEIGHT + BUBBLE_GAP + bobOffset);
      this._faceDir.copy(this._camWorldPos).sub(bubbleMesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) {
        bubbleMesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
      }

      // Named figures only (i < namedCount — see MARKER_* constants' own
      // comment). targetOpacity > 0 means this exact frame is the one where
      // that figure's own line actually starts showing (explainer reveal or
      // ambient/paired/named dialogue), so that's the single moment "talked
      // to" flips permanently true.
      if (i < namedCount) {
        if (!this._talkedTo[i] && targetOpacity > 0) this._talkedTo[i] = 1;

        const markerMesh = this._markerMeshes[i];
        markerMesh.visible = phase === Phase.FateEvents && group.visible && !this._talkedTo[i];
        if (markerMesh.visible) {
          markerMesh.position.copy(this._scratchPos).addScaledVector(this._normalVec, MARKER_HEIGHT);
          this._faceDir.copy(this._camWorldPos).sub(markerMesh.position).normalize();
          if (this._faceDir.lengthSq() > 0.0001) {
            markerMesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
          }
          const pulse = MARKER_PULSE_MIN_SCALE + (1 - MARKER_PULSE_MIN_SCALE) * (0.5 + 0.5 * Math.sin(time * MARKER_PULSE_FREQ * Math.PI * 2));
          markerMesh.scale.setScalar(pulse);
        }

        // Gold rim blinks dim<->bright on the same cadence as constellations-
        // vfx-system.ts's untouched-star flash (see RIM_FLASH_* constants'
        // own comment) while nobody's listening — this._bubbleOpacity[i]
        // (already eased toward targetOpacity just above) doubles as "how
        // much this figure is currently being talked to," so the blink holds
        // at a steady RIM_FLASH_MAX instead of continuing to flash "notice
        // me" mid-conversation, then eases back into blinking as the bubble
        // itself fades out. Mutates the material's existing uRimColor
        // Vector3 in place rather than allocating a new one every frame.
        const blinkT = 0.5 + 0.5 * Math.sin(time * RIM_FLASH_FREQUENCY * Math.PI * 2 + this._namedRimPhase[i] * Math.PI * 2);
        const blinkBrightness = RIM_FLASH_MIN + (RIM_FLASH_MAX - RIM_FLASH_MIN) * blinkT;
        const rimBrightness = blinkBrightness + (RIM_FLASH_MAX - blinkBrightness) * this._bubbleOpacity[i];
        (this._namedMaterials[i].uniforms.uRimColor.value as Vector3).set(
          NAMED_RIM_COLOR[0] * rimBrightness,
          NAMED_RIM_COLOR[1] * rimBrightness,
          NAMED_RIM_COLOR[2] * rimBrightness,
        );
      }
    }

    this._updateSituations(count, dominant, delta, time, phase, beat);
    this._updateFire(time);

    for (const entity of this.queries.comets.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchCometPos.fromArray(posView);
      this._updateSkulls(delta, dominant, phase);

      const trail = this._trailSystem.getBuffer(entity);
      if (trail) {
        const samples = entity.getValue(CometTrail, 'samples') as number;
        const stride = entity.getValue(CometTrail, 'stride') as number;
        const dancing = beat === FateBeat.Payoff && dominant === SOUL_DUST_TYPE;
        this._updateCollectibles(
          this._ghostMeshes,
          this._ghostRimPhase,
          this._fateEvents.getGraveyardField(),
          dominant === SOUL_DUST_TYPE && COLLECTIBLE_VISIBLE_FROM.has(phase),
          trail,
          samples,
          stride,
          dancing,
          true, // bob — ghosts float, always bobbing regardless of state
          time,
          phase,
        );
        const seedField = this._fateEvents.getSeedField();
        const showSeeds = dominant === ORGANIC_MATTER_TYPE && COLLECTIBLE_VISIBLE_FROM.has(phase);
        this._updateCollectibles(
          this._seedMeshes,
          this._seedRimPhase,
          seedField,
          showSeeds,
          trail,
          samples,
          stride,
          false,
          false, // bob — seeds sit on the ground, no float
          time,
          phase,
        );
        // After _updateCollectibles — the blossom reads each seed mesh's
        // fresh trail position as its plant's anchor, and hides the seed.
        if (showSeeds && beat === FateBeat.Payoff && !this._seedBlossom.isTriggered()) {
          this._seedBlossom.trigger(seedField.capturedT, seedField.states);
        }
        this._seedBlossom.update(delta, this._seedMeshes, showSeeds);
      }
      break; // exactly one comet entity, see comet-handoff-system.ts
    }

    for (const ev of this._fateEvents.drainCollectCaptureEvents()) {
      this._scratchCollectSoundPos.set(ev.x, ev.y, ev.z);
      this._twinkleSynth.playCatch(this._scratchCollectSoundPos, ev.speed);
    }

    if (beat === FateBeat.Payoff && dominant === SOUL_DUST_TYPE && !this._payoffChimePlayed) {
      this._payoffChimePlayed = true;
      playPayoffChime(this._audioListener, this.scene, this._scratchCometPos, 520);
    }
    if (beat !== FateBeat.Payoff) {
      this._payoffChimePlayed = false;
      this._seedBlossom.reset(); // no-op unless a previous loop's blossom is still showing
    }
  }

  // See BLOOM_* constants' own comment.
  private _onSeedBloom(rank: number, total: number, position: Vector3): void {
    const t = total > 1 ? rank / (total - 1) : 1;
    const speed = BLOOM_SPEED_MIN + (BLOOM_SPEED_MAX - BLOOM_SPEED_MIN) * t;
    this._voiceSynth.playCatch(ORGANIC_MATTER_TYPE, position, speed);
    this._twinkleSynth.playPickup(position, speed);
    if (rank === total - 1) playPayoffChime(this._audioListener, this.scene, position, BLOOM_FINAL_CHIME_FREQ);
  }

  // Builds the quaternion that orients baseQuat's own local +Z toward
  // targetPos, keeping baseQuat's own "up" (recovered from it directly, not
  // assumed to be world +Y — see the Gas turn block's matching comment
  // above) fixed, so a person keeps standing correctly on their own patch of
  // the curved planet surface while turning to face targetPos. Same
  // up/forward/right/makeBasis idiom as the Gas King-facing blend above,
  // factored out here since the general player-turn case below needs it too
  // without a King point to blend against.
  private _computeFaceQuaternion(baseQuat: Quaternion, personPos: Vector3, targetPos: Vector3, out: Quaternion): void {
    this._scratchTurnUp.set(0, 1, 0).applyQuaternion(baseQuat);
    this._scratchTurnToTarget.copy(targetPos).sub(personPos);
    const alongUp = this._scratchTurnToTarget.dot(this._scratchTurnUp);
    this._scratchTurnForward.copy(this._scratchTurnToTarget).addScaledVector(this._scratchTurnUp, -alongUp);
    if (this._scratchTurnForward.lengthSq() < 1e-6) this._scratchTurnForward.set(0, 0, 1);
    this._scratchTurnForward.normalize();
    this._scratchTurnRight.crossVectors(this._scratchTurnUp, this._scratchTurnForward).normalize();
    this._scratchTurnMatrix.makeBasis(this._scratchTurnRight, this._scratchTurnUp, this._scratchTurnForward);
    out.setFromRotationMatrix(this._scratchTurnMatrix);
  }

  // 0 = still standing in the base outward-facing pose, 1 = fully turned
  // toward this frame's face target (see _gasFacingBlendFor for WHICH
  // target — the same amount applies to everyone, but WHO they're turned
  // toward differs per person). Driven by _crowdTurnElapsed, which only
  // starts counting once the King has actually died (see update()'s own
  // comment) rather than on Ambient's own beat-entry timing.
  private _gasTurnAmount(): number {
    if (this._crowdTurnElapsed < 0) return 0;
    return smoothstep(clamp01(this._crowdTurnElapsed / GAS_KING_TURN_RAMP_SECONDS));
  }

  // 0 = facing the King, 1 = facing the player — only meaningful once
  // _gasTurnAmount above has actually turned this person away from their
  // base pose. Everyone except Pointer (EXPLAIN_FIGURE_INDEX) stays at 0
  // (facing the King) forever once turned — Pointer alone breaks off toward
  // the player after POINTER_KING_HOLD_SECONDS, since it's the one whose
  // own line tells the player to go talk to everyone.
  private _gasFacingBlendFor(i: number): number {
    if (i !== EXPLAIN_FIGURE_INDEX) return 0;
    const t = this._crowdTurnElapsed - GAS_KING_TURN_RAMP_SECONDS - POINTER_KING_HOLD_SECONDS;
    return smoothstep(clamp01(t / GAS_TURN_DURATION));
  }

  // Organic matter's one-shot "point at the comet" pose, and Gas's Beat 2.5
  // watching/waving pose (0-3s of Ambient — see GAS_WATCH_DURATION's own
  // comment). A separate pass over the crowd is simplest to reason about
  // here; N_PEOPLE=10 makes it negligible.
  //
  // Unlike the old primitive-figure code (which set the arm Mesh's rotation
  // to an ABSOLUTE value each frame, safe when nothing else ever touched
  // it), the right-arm bone now also has this frame's idle-breathing
  // animation already applied to it (mixer.update() ran earlier in update()
  // above) — setting an absolute rotation here would overwrite that instead
  // of layering on top of it. So this eases a per-person OFFSET
  // (_armOffsetX/_armOffsetZ, target 0 when neither pose is active) and
  // applies it as an ADDITIVE rotation via rotateX/rotateZ, composing with
  // whatever the animation already set this bone to.
  private _updateSituations(
    count: number,
    dominant: number,
    delta: number,
    time: number,
    phase: Phase,
    beat: FateBeat,
  ): void {
    if (this._pointUpTimer > 0) this._pointUpTimer = Math.max(0, this._pointUpTimer - delta);
    const pointUpActive = dominant === ORGANIC_MATTER_TYPE && this._pointUpTimer > 0;
    const gasWatchActive =
      dominant === VOLATILE_GASSES_TYPE &&
      phase === Phase.FateEvents &&
      beat === FateBeat.Ambient &&
      this._fateEvents.getBeatElapsed() < GAS_WATCH_DURATION;

    const armPull = 1 - Math.exp(-POINT_UP_EASE_RATE * delta);
    for (let i = 0; i < count; i++) {
      if (this._customPoseActive[i]) continue; // Gas's own post-death cast pose owns this figure now, not the idle/point-up/wave overlay
      const bone = this._rightArmBones[i];
      if (!bone) continue; // still on the primitive placeholder — no real bone to pose yet

      let targetX = 0;
      let targetZ = 0;
      if (pointUpActive) {
        targetX = POINT_UP_ROTATION_X;
      } else if (gasWatchActive) {
        targetX = GAS_WAVE_ROTATION_X;
        targetZ = Math.sin(time * GAS_WAVE_FREQ * Math.PI * 2 + i) * GAS_WAVE_AMPLITUDE;
      }
      // Undo last frame's offset before easing toward + applying the new
      // one — rotateX/rotateZ compose onto the bone's CURRENT rotation, so
      // without this the old offset would never be removed, only added to.
      // Rotation composition doesn't commute, so the undo must happen in
      // exactly the REVERSE order it was originally applied in (Z was
      // applied last below, so it's undone first here) — undoing X before Z
      // would leave a small residual drift instead of exactly canceling.
      bone.rotateZ(-this._armOffsetZ[i]);
      bone.rotateX(-this._armOffsetX[i]);
      this._armOffsetX[i] += (targetX - this._armOffsetX[i]) * armPull;
      this._armOffsetZ[i] += (targetZ - this._armOffsetZ[i]) * armPull;
      bone.rotateX(this._armOffsetX[i]);
      bone.rotateZ(this._armOffsetZ[i]);
    }
  }

  // Beat 4 — edge-detects a person's visited flip and flies their skull icon
  // to the comet, then holds it at a small fixed per-person ring slot (see
  // this file's own top comment on why person-index alone is a stable ring
  // slot here).
  private _updateSkulls(delta: number, dominant: number, phase: Phase): void {
    const visited = this._fateEvents.getVisitedMask();
    const count = this._fateEvents.getPersonCount();
    const gasActive = dominant === VOLATILE_GASSES_TYPE && phase === Phase.FateEvents;

    for (let i = 0; i < count; i++) {
      if (gasActive && visited[i] && !this._wasVisited[i]) {
        this._wasVisited[i] = 1;
        this._skullState[i] = SkullState.Flying;
        this._skullT[i] = 0;
        const group = this._personGroups[i];
        this._skullFromX[i] = group.position.x;
        this._skullFromY[i] = group.position.y + PERSON_HEIGHT;
        this._skullFromZ[i] = group.position.z;
      }

      const mesh = this._skullMeshes[i];
      if (this._skullState[i] === SkullState.Hidden) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      if (this._skullState[i] === SkullState.Flying) {
        this._skullT[i] = Math.min(1, this._skullT[i] + delta / SKULL_FLIGHT_DURATION);
        const t = smoothstep(this._skullT[i]);
        const angle = (i / count) * Math.PI * 2;
        const targetX = this._scratchCometPos.x + Math.cos(angle) * SKULL_RING_RADIUS;
        const targetY = this._scratchCometPos.y;
        const targetZ = this._scratchCometPos.z + Math.sin(angle) * SKULL_RING_RADIUS;
        mesh.position.set(
          this._skullFromX[i] + (targetX - this._skullFromX[i]) * t,
          this._skullFromY[i] + (targetY - this._skullFromY[i]) * t,
          this._skullFromZ[i] + (targetZ - this._skullFromZ[i]) * t,
        );
        if (this._skullT[i] >= 1) this._skullState[i] = SkullState.Attached;
      } else {
        const angle = (i / count) * Math.PI * 2;
        mesh.position.set(
          this._scratchCometPos.x + Math.cos(angle) * SKULL_RING_RADIUS,
          this._scratchCometPos.y,
          this._scratchCometPos.z + Math.sin(angle) * SKULL_RING_RADIUS,
        );
      }
      this._faceDir.copy(this._camWorldPos).sub(mesh.position).normalize();
      if (this._faceDir.lengthSq() > 0.0001) mesh.quaternion.setFromUnitVectors(this._zAxis, this._faceDir);
    }
  }

  // Shared Beat-4 renderer for a GatherableField-backed collectible (Soul's
  // ghosts / Organic's seeds) — Free/Attracting particles sit at the field's
  // own live positions; Captured ones ride the comet's trail exactly like
  // every other gathered thing in this codebase (see trail-sampler.ts).
  // `dance`, when true (Soul's own Beat 5 payoff only), layers a small
  // per-ghost sinusoidal offset in camera-right/up space onto the captured
  // position so they read as dancing together in the tail. `bob`, when true
  // (Soul's ghosts only — they float rather than sit on the ground), adds a
  // separate, always-on world-+Y sinusoidal offset in EVERY state (Free,
  // Attracting, and Captured alike, additive with `dance`), since "up" reads
  // the same regardless of viewing angle — unlike DANCE, this doesn't need
  // camera-relative basis vectors.
  private _updateCollectibles(
    meshes: Mesh[],
    rimPhase: Float32Array,
    field: GatherableField,
    show: boolean,
    trail: Float32Array,
    samples: number,
    stride: number,
    dance: boolean,
    bob: boolean,
    time: number,
    phase: Phase,
  ): void {
    if (!show) {
      for (const mesh of meshes) mesh.visible = false;
      return;
    }
    const { positions, states, capturedField } = field;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];

      // A collectible left uncaptured once Fate Events ends (the phase's
      // own timeoutSeconds safety net can force everyone through Beat 4
      // before a player finds the very last one — see index.ts's
      // Phase.FateEvents comment) has no reason to keep sitting there,
      // still pulsing, on a planet that's now visibly receding into the
      // Launch choice — despawn it here rather than let it linger all the
      // way through Launch/Finale (COLLECTIBLE_VISIBLE_FROM's own comment
      // is about keeping ALREADY-CAPTURED ones riding the tail visible
      // that far, not these). Captured ones are unaffected — that branch
      // below always sets its own mesh.visible = true regardless of phase.
      if (states[i] !== GatherState.Captured && phase !== Phase.FateEvents) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      // uTime drives the ghost material's own wiggle vertex displacement
      // (see makeToonRimInstancedWigglyLiveRimMaterial) — harmless/unused on
      // the seeds' flat material, which has no uTime uniform at all.
      const material = mesh.material as ShaderMaterial;
      if (material.uniforms.uTime) material.uniforms.uTime.value = time;

      const bobOffset = bob
        ? Math.sin(time * COLLECTIBLE_BOB_FREQ * Math.PI * 2 + i * 2.3) * COLLECTIBLE_BOB_AMPLITUDE
        : 0;
      if (states[i] === GatherState.Captured) {
        sampleTrailOffset(
          trail,
          samples,
          stride,
          capturedField.t[i],
          capturedField.dx[i],
          capturedField.dy[i],
          capturedField.dz[i],
          this._camRight,
          this._camUp,
          this._camFwd,
          this._scratchTrailPos,
        );
        if (dance) {
          const phase = i * 1.7;
          this._scratchTrailPos.addScaledVector(
            this._camRight,
            Math.sin(time * DANCE_FREQ * Math.PI * 2 + phase) * DANCE_AMPLITUDE,
          );
          this._scratchTrailPos.addScaledVector(
            this._camUp,
            Math.cos(time * DANCE_FREQ * Math.PI * 2 + phase * 1.3) * DANCE_AMPLITUDE,
          );
        }
        mesh.position.copy(this._scratchTrailPos);
        mesh.position.y += bobOffset;
        mesh.scale.setScalar(1);
        // Captured — the "notice me" blink is done its job, settle for good
        // on the ordinary rim color rather than continuing to flash gold
        // while riding the tail (see COLLECTIBLE_NORMAL_RIM_COLOR's comment).
        (material.uniforms.uRimColor.value as Vector3).set(...COLLECTIBLE_NORMAL_RIM_COLOR);
      } else {
        mesh.position.set(positions[i * 3], positions[i * 3 + 1] + bobOffset, positions[i * 3 + 2]);
        // Still out on the surface (Free/Attracting) — pulse so it reads as
        // an active collectible against the static decorations around it.
        mesh.scale.setScalar(1 + Math.sin(time * COLLECTIBLE_PULSE_FREQ * Math.PI * 2 + i * 0.7) * COLLECTIBLE_PULSE_AMPLITUDE);
        // Not yet captured — blink gold, same RIM_FLASH_* cadence/idiom as
        // the named figures' own rim (see that constant's own comment).
        const t = 0.5 + 0.5 * Math.sin(time * RIM_FLASH_FREQUENCY * Math.PI * 2 + rimPhase[i] * Math.PI * 2);
        const brightness = RIM_FLASH_MIN + (RIM_FLASH_MAX - RIM_FLASH_MIN) * t;
        (material.uniforms.uRimColor.value as Vector3).set(
          NAMED_RIM_COLOR[0] * brightness,
          NAMED_RIM_COLOR[1] * brightness,
          NAMED_RIM_COLOR[2] * brightness,
        );
      }
    }
  }

  private _updateLivePositions(positions: Float32Array, normals: Float32Array, count: number): void {
    this._scratchLiveCenter.copy(this._planetSeeding.getLivePlanetPosition());
    const liveReach = this._planetSeeding.getLivePlanetRadius() + PERSON_SURFACE_OFFSET;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = this._scratchLiveCenter.x + normals[i * 3] * liveReach;
      positions[i * 3 + 1] = this._scratchLiveCenter.y + normals[i * 3 + 1] * liveReach;
      positions[i * 3 + 2] = this._scratchLiveCenter.z + normals[i * 3 + 2] * liveReach;
    }
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
    // Doubled from 10 — this insets BOTH the box from the canvas edge AND
    // (via wrapLines' own `w - pad * 4`) the text from the box's own border;
    // text read as cramped right up against the bubble's edge at the old
    // value.
    const pad = 20;
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
