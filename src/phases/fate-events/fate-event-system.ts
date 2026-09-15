import { AudioListener, createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { AchievementSystem } from '../../core/achievement-system.js';
import { getGlobals } from '../../core/globals.js';
import {
  farewellMessage,
  FateDialogueEntry,
  fateEventsIntroMessage,
  getFateDialogue,
  GAS_CHARACTER_NAMES,
  NamedFigureArc,
  NAMED_FIGURES_BY_TYPE,
} from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { DwellRiseSynth } from '../../vfx/audio/dwell-rise-synth.js';
import { scatterOnSphereCap, scatterOnSphereCapEven, scatterSemicircleAroundPoint } from '../../vfx/geometry/sphere-scatter.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { CaptureEvent } from '../stardust/stardust-system.js';

const ORIGIN = new Vector3(0, 0, 0);

// Was a straight-up (0,1,0) "tabletop" framing — the planet settled low and
// close with only its TOP hemisphere cresting up, player looking down onto
// it like a low round table/altar. That put the whole populated cap out of
// the player's forward view unless they tilted their head down, and (worse)
// the King specifically — see earth-situations-vfx-system.ts's
// _buildKing — landed at a RANDOM point inside that cap rather than a
// fixed one, so he could end up anywhere within CAP_HALF_ANGLE of the
// center, easily missed entirely. A first pass moved this all the way to
// near-side (mostly +Z, toward the player, same convention
// constellation-path.ts's ANCHOR_ELEVATION uses) — too far the other way,
// reading as too close/off to the side. Split the difference: still tilted
// toward the player, but with more elevation than depth now, landing
// between the old straight-up and the too-far near-side attempt. Every
// populated cap (people here, decorations/graveyard/king in
// earth-situations-vfx-system.ts, which imports this same constant so every
// scattered element lands on the same region) scatters around this same
// direction from PLANET_CENTER.
// Z brought in from -1.9 — the populated cap (CROWD_CAP_DIRECTION's region,
// where every person/king/collectible actually sits) was ~1.9m from the
// player even after play() resolves this against wherever the player
// actually is (see _resolvedPlanetCenter's own comment), too far to
// comfortably reach with the comet for a non-walking/seated player. -1.6
// still leaves the sphere's single closest point (off in the
// KING_EXCLUSION-side direction, nowhere near where anything is actually
// rendered) comfortably outside camera near-clip range.
export const PLANET_CENTER: [number, number, number] = [0, -0.35, -1.6];
export const PLANET_RADIUS = 1.4;
export const CROWD_CAP_DIRECTION = new Vector3(0, 0.95, 0.2).normalize();
export const N_PEOPLE = 10;
// Bumped from 28 for the old straight-up cap on a much closer sphere, then
// again from 34 — with PROXIMITY_RADIUS(0.45) generous enough to trigger a
// visit on a graze, a tight cap let one comet swing/walk sweep past several
// people at once; a wider disc spaces the crowd out enough that a single
// continuous pass is more likely to only catch one person at a time (this
// now works together with the dwell gate above, not instead of it).
// Exported so PlanetSeedingVfxSystem can keep plants from growing under this
// same footprint (see PLANT_EXCLUSION_HALF_ANGLE just below) and
// earth-situations-vfx-system.ts can spread its own decorations a bit wider
// around it.
export const CAP_HALF_ANGLE = (42 * Math.PI) / 180;
// A little wider than the people cap itself — plants have their own base
// radius, so a plant whose CENTER sits just outside CAP_HALF_ANGLE could
// still visually brush against a person standing right at the cap's edge.
// See planet-seeding-vfx-system.ts's _applyHumanZoneExclusion.
export const PLANT_EXCLUSION_HALF_ANGLE = CAP_HALF_ANGLE + (6 * Math.PI) / 180;
// Throne only (see FateEventSystem.play()'s isThrone branch) — the crowd
// forms a single ring at this fixed angular radius from the King (see
// scatterSemicircleAroundPoint) instead of filling the whole cap's disc,
// so they read as gathered AROUND him rather than scattered in front of
// him. Comfortably inside (KING_EXCLUSION_HALF_ANGLE, CAP_HALF_ANGLE).
// Bumped from 26 alongside CAP_HALF_ANGLE's own widening above — Gas's
// Collect beat win condition is purely "visit everyone" (see
// VISIT_FRACTION_TO_COMPLETE), so its crowd benefits the most from more
// room between neighbors.
const THRONE_ARC_ANGLE = (32 * Math.PI) / 180;
// Bumped from 0.3 — easier to trigger just by swinging/walking the comet
// through the crowd instead of needing to land precisely on someone.
const PROXIMITY_RADIUS = 0.45;
// How long a person takes to turn from their base outward-facing pose to
// look at the player once a hand is near (TURN_IN_SECONDS), and to turn
// back once it leaves (TURN_OUT_SECONDS, a little slower — reads as
// settling back rather than snapping) — see _turnAmount/getTurnAmount().
// _visited below is now gated on this actually reaching 1 rather than
// firing the instant a hand grazes past (see PROXIMITY_RADIUS's own
// "easier to trigger" comment above) — a comet just swinging/walking
// through the crowd in one continuous pass no longer silently visits
// everyone it happened to cross, since nobody has time to actually turn
// and notice before it's already moved on. Bumped from 0.9 — that was too
// quick to actually register as a dwell; now paired with its own rising
// tone (see DwellRiseSynth/_updateDwellRiseAudio) so the wait reads as
// "something building," same idiom as OrbitalLaunchSystem's CHARGE_SECONDS.
const TURN_IN_SECONDS = 1.8;
const TURN_OUT_SECONDS = 1.3;
// Keeps the ambient crowd off the exact center point earth-situations-vfx-
// system.ts's _buildKing reserves for the King (see its own comment) —
// an annulus around him rather than a filled cap, so "people behind/to the
// side of him" holds structurally instead of by the luck of a random draw.
const KING_EXCLUSION_HALF_ANGLE = (8 * Math.PI) / 180;
// A person's speech bubble now runs its own fade-in -> hold (readable) ->
// fade-out cycle per line, rather than the old instant swap every
// LINE_CYCLE_SECONDS — the swap read as the bubble popping straight to new
// text with the old text having no chance to be read in full. See
// getBubbleOpacity()/update()'s _lineTimer advance below.
const BUBBLE_FADE_IN_SECONDS = 0.4;
const BUBBLE_HOLD_SECONDS = 5.6; // doubled from 2.8 — stays readable longer before fading
const BUBBLE_FADE_OUT_SECONDS = 0.4;
const BUBBLE_CYCLE_SECONDS = BUBBLE_FADE_IN_SECONDS + BUBBLE_HOLD_SECONDS + BUBBLE_FADE_OUT_SECONDS;
// Grace window before "near" -> "far" actually clears state — originally
// just long enough (0.4s) to stop brushing the proximity radius's edge from
// flickering the jump/bubble on and off, bumped to a full 4s so the bubble
// stays open and readable for a beat after the player moves on, instead of
// vanishing the instant they step away.
const LEAVE_GRACE_SECONDS = 4.0;
// Volatile gasses' index in PEBBLE_TYPES/dominantPebbleType — gates the
// ambient "big fire" effect (see fate-event-vfx-system.ts) and Beat 4's
// reused visit mechanic below.
const VOLATILE_GASSES_TYPE = 2;
const SOUL_DUST_TYPE = 0;
const ORGANIC_MATTER_TYPE = 1;

// Lightweight "society" differentiation per dominant pebble type — same
// index order as PEBBLE_TYPES/dominantPebbleType (souls, organics, gasses).
// Read live from getVisiblePeopleCount()/getBobFrequencyMultiplier() below
// rather than cached at play() time, since people start appearing already
// during Constellations (before this system's own play() ever runs) and
// dominantPebbleType is already final by then — caching would make the
// count jump (and some already-visible figures vanish) right as FateEvents
// begins. Color tint already varies per type via getPeopleColor().
const VISIBLE_PEOPLE_BY_TYPE = [9, N_PEOPLE, 6]; // souls, organics, gasses
const BOB_FREQUENCY_MULT_BY_TYPE = [1, 1.25, 0.6]; // souls, organics, gasses
// Fraction of the type's visible people that must be visited to complete
// Beat 4 (Gas only — see FateBeat.Collect) — otherwise it falls back to the
// timeout (see index.ts). 1.0 — talking to everyone is what unlocks moving
// on, not just half of them.
const VISIT_FRACTION_TO_COMPLETE = 1.0;

// The first two people (always within range — VISIBLE_PEOPLE_BY_TYPE's
// smallest value is 6) get individual identity instead of sharing the
// ambient crowd's dialogue — see NAMED_FIGURES_BY_TYPE. Exported so
// FateEventVfxSystem uses the same indices for its gold-rim material swap.
export const NAMED_FIGURE_COUNT = 2;
// Gas/Throne only — every visible person there is an equally "named" figure
// (gold rim, "talk to me" marker, individual namedLine — see
// notification-copy.ts's GAS_CHARACTER_NAMES), not just the two featured
// ones Soul/Organic still single out. See getNamedCount(), the live
// per-playthrough switch FateEventVfxSystem reads instead of the plain
// NAMED_FIGURE_COUNT constant above.
export const GAS_NAMED_COUNT = VISIBLE_PEOPLE_BY_TYPE[VOLATILE_GASSES_TYPE];
// Reuses named figure 0's bubble for Beat 3's single scripted explainer line
// (see getExplainerText/getExplainerOpacity) — bypassing proximity and the
// ambient dialogue pool entirely for that one beat.
export const EXPLAIN_FIGURE_INDEX = 0;
// "The other standing person" — the second featured figure always carries
// the current dialogue's own pairedLine (see getDialogueLinesFor) instead of
// a scripted arc, so every path has a second reliably-findable talker
// alongside EXPLAIN_FIGURE_INDEX (previously this was a random, often-missed
// AMBIENT figure, and Shepherd-only — see git history).
export const PAIRED_FIGURE_INDEX = NAMED_FIGURE_COUNT - 1;
// Minimum accumulated near-time (see _namedDwell) before stop()'s farewell
// message will name a figure at all — guards against firing for a player
// who barely brushed past one on their way to somewhere else.
const NAMED_DWELL_THRESHOLD = 0.5;

// Beat 4 collectible sub-mechanics (Soul/Organic only — Gas reuses the
// proximity "visit" loop below instead, see _updateCollect). Both fields
// spawn their 10 particles just above the planet's own final PLANET_CENTER/
// PLANET_RADIUS — safe as fixed (non-live-tracked) world positions because
// Beat 4 never starts until Beat 2's zoom (Leg B) has fully settled the
// planet there.
const COLLECTIBLE_COUNT = 10;
const COLLECTIBLE_SURFACE_OFFSET_MIN = 0.02;
const COLLECTIBLE_SURFACE_OFFSET_MAX = 0.06;
// Deliberately much tighter than StardustSystem's own attractRadius/
// captureDistance (0.4/0.05) — these are scattered across the planet's
// surface rather than floating in open space, so a generous attract radius
// let a hand just passing near the planet auto-vacuum several at once
// without the player ever having to actually go find and reach for one.
// Small enough that the hand needs to be right up against a specific
// ghost/seed for it to start pulling in.
const COLLECTIBLE_ATTRACT_RADIUS = 0.08;
const COLLECTIBLE_CAPTURE_DISTANCE = 0.03;
// Soul's ghosts are much bigger than seeds and their mesh origin sits at the
// base of the tail, so a hand touching a ghost's body could still be outside
// the seed-sized radius above — some only latched on after lingering.
const GHOST_ATTRACT_RADIUS = 0.12;
const GHOST_CAPTURE_DISTANCE = 0.05;
const COLLECTIBLE_ATTRACT_RATE = 3.0;
const COLLECTIBLE_CAPTURED_AGE_DECAY = 3.0;
const COLLECTIBLE_CAPTURED_SPREAD_BASE = 0.01;
const COLLECTIBLE_CAPTURED_SPREAD_GROWTH = 0.02;
const COLLECTIBLE_CAPTURED_DEPTH_RATIO = 1.4;

// The 5-beat cinematic sequence (see this phase's own README-style comment
// on the class below): Zoom (Beat 2, the planet settling into its tabletop
// position) -> Ambient (Beat 2.5, a per-type unexplained vignette) -> Explain
// (Beat 3, one scripted line) -> Collect (Beat 4, gathering 10 objects into
// the tail — this is where the OLD proximity/ambient-chatter loop now lives,
// see _updateCollect) -> Payoff (Beat 5, per-type audiovisual finale, holds
// briefly before phaseComplete so its climax lands before the player can
// launch away — see PAYOFF_HOLD_SECONDS). Beat 1 ("you are recognized")
// isn't tracked here at all — it's the existing crown-rise cinematic at the
// tail end of Phase.Constellations (see ConstellationsSystem/CrownRise),
// deliberately left where it is rather than relocated into this phase.
// Gas/Throne skips Explain entirely (see update()'s Ambient->Collect branch)
// — every person there is already an equally "named" figure with their own
// line (see GAS_NAMED_COUNT), so there's no single explainer to wait on
// before skull-gathering can start.
export enum FateBeat {
  Zoom,
  Ambient,
  Explain,
  Collect,
  Payoff,
}

const AMBIENT_BEAT_SECONDS = 10;
// Longer hold than the ambient crowd's own BUBBLE_HOLD_SECONDS — this is the
// one line every player must actually read, not a chatter line that's fine
// to miss.
const EXPLAIN_HOLD_SECONDS = 10; // doubled from 5, matching BUBBLE_HOLD_SECONDS's own doubling
// How long the bubble's own fade-in/hold/fade-out cycle takes ONCE
// triggered (see _updateExplain/_explainTriggered) — not a fixed beat
// duration from entry anymore, since the beat now waits for the player to
// actually be near EXPLAIN_FIGURE_INDEX before this cycle even starts.
const EXPLAIN_BEAT_SECONDS = BUBBLE_FADE_IN_SECONDS + EXPLAIN_HOLD_SECONDS + BUBBLE_FADE_OUT_SECONDS;
// Absolute safety net for a player who never approaches the explainer
// figure at all — generous (comfortably longer than Ambient's own 10s, so
// there's real time to notice and walk over) but still finite, so the
// phase can't stall here forever.
const EXPLAIN_FALLBACK_SECONDS = 30;
// Climax-first (per design decision): Payoff's own audiovisual finale (see
// EarthSituationsVfxSystem/FateEventVfxSystem) runs ~15s total, but
// phaseComplete only fires this far in — the rest keeps playing on into
// Phase.Launch as the comet departs, same precedent as CrownRise/GhostRise
// persisting past their own triggering phase.
const PAYOFF_HOLD_SECONDS = 7;

// Gameplay for Fate Events: a big planet appears near the player, populated
// with N_PEOPLE placeholder figures scattered across its near-facing surface
// (see sphere-scatter.ts — normals double as each figure's "up" direction).
// A fixed 5-beat cinematic sequence (see FateBeat above) replaces what used
// to be unscripted proximity-driven chatter for the whole phase — that old
// loop now only runs during FateBeat.Collect (see _updateCollect), gated
// behind Zoom/Ambient/Explain first. Volatile-gasses winners also get an
// ambient "big fire" effect (globals.dominantPebbleType). Pure simulation
// here: no mesh/entity creation happens in this file (see
// FateEventVfxSystem/EarthSituationsVfxSystem), only surface layout math and
// beat/proximity/dialogue/collectible state.
export class FateEventSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
  private _planetSeeding!: PlanetSeedingVfxSystem;

  private _beat: FateBeat = FateBeat.Zoom;
  private _beatTimer = 0;

  private _surfacePositions!: Float32Array;
  private _normals!: Float32Array;

  // PLANET_CENTER shifted by however far the player has drifted from world
  // origin (see _getPlayerDriftXZ()/play()) — what getPlanetCenter()
  // actually returns once play() has run at least once; defaults to the
  // raw constant before then, same "harmless placeholder" idiom
  // _buildSurfaceLayout(false) uses in init().
  private _resolvedPlanetCenter: [number, number, number] = PLANET_CENTER;

  private _active!: Uint8Array;
  private _awayTimer!: Float32Array;
  private _lineIndex!: Uint8Array;
  private _lineTimer!: Float32Array;
  private _visited!: Uint8Array;
  private _visitedCount = 0;
  // 0-1 per person — eases toward 1 while _active[i] (turning to face the
  // player, see TURN_IN_SECONDS) and back toward 0 once inactive
  // (TURN_OUT_SECONDS). Read by FateEventVfxSystem to animate each Collect-
  // beat person's orientation; _visited is now gated on this actually
  // reaching 1 (see _updateCollect) rather than firing the instant a hand
  // grazes past.
  private _turnAmount!: Float32Array;
  // Which person (if any) the dwell-rise tone is currently voicing — see
  // _updateDwellRiseAudio. -1 when nobody is currently mid-turn.
  private _risingPersonIndex = -1;
  // Random per-play rotation into this._dialogue.entries — see
  // getDialogueLinesFor(). Guarantees every ambient crowd member gets a
  // distinct entry this playthrough (no two people say the same thing) and,
  // when a constellation's pool holds more entries than it has ambient
  // slots (see FATE_DIALOGUE's own comment), surfaces a different subset
  // each fresh loop instead of always the same first few.
  private _dialogueOffset = 0;

  // Cached per play() from NAMED_FIGURES_BY_TYPE[dominantPebbleType] — see
  // that table's own comment for why this is a fixed placeholder until then.
  private _namedArcs!: [NamedFigureArc, NamedFigureArc];
  // Accumulated near-time per named figure, reset each play() — read in
  // stop() to decide who (if anyone) gets the farewell message.
  private _namedDwell!: Float32Array;

  // Own AudioListener, same reason every other generative-audio system in
  // this codebase has one (see e.g. OrbitalLaunchSystem's own comment) —
  // drives the dwell-rise tone (see _updateDwellRiseAudio/DwellRiseSynth).
  private _audioListener!: AudioListener;
  private _dwellRiseSynth!: DwellRiseSynth;
  private _scratchRisingPos!: Vector3;
  private _scratchCamPos!: Vector3;

  private _dialogue!: FateDialogueEntry;
  private _color!: [number, number, number];
  private _showFire = false;

  // Beat 3 — see _updateExplain/getExplainerOpacity. Fires once the player
  // has actually been near EXPLAIN_FIGURE_INDEX, then holds/fades on its
  // own timeline regardless of whether they wander off mid-read.
  private _explainTriggered = false;
  private _explainElapsed = 0;

  // Beat 4's Soul/Organic collectible fields (Gas instead reuses the
  // proximity _visited/_visitedCount mechanic below) — see this file's own
  // COLLECTIBLE_* constants. Built once in init() (fixed world positions,
  // safe since Beat 4 never starts until the planet has settled — see
  // COLLECTIBLE_COUNT's own comment), .reset() each play() for a fresh loop.
  private _graveyardNormals!: Float32Array; // unit sphere directions from PLANET_CENTER, fixed forever
  private _seedNormals!: Float32Array;
  private _graveyardField!: GatherableField;
  private _seedField!: GatherableField;
  private _hand!: GatherHandInput;
  // Fired via GatherableField's onCapture callback (both Beat-4 collectible
  // fields feed the same queue — only one of the two is ever stepped in a
  // given playthrough, see _updateCollect), drained each frame by
  // FateEventVfxSystem to trigger the pickup twinkle sound. Same produce/
  // drain shape StardustSystem's own CaptureEvent/drainCaptureEvents already
  // establishes.
  private _collectCaptureEvents: CaptureEvent[] = [];

  private _scratchHandPos!: Vector3;
  private _scratchHandVel!: Vector3;

  init(): void {
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;

    // Real layout (Throne's semicircle vs. everyone else's cap) isn't known
    // until play() (celestialSymbol is still unset at boot) — this is just a
    // harmless placeholder so the arrays exist before then. See
    // _buildSurfaceLayout's own comment.
    this._buildSurfaceLayout(false);

    this._active = new Uint8Array(N_PEOPLE);
    this._awayTimer = new Float32Array(N_PEOPLE);
    this._lineIndex = new Uint8Array(N_PEOPLE);
    this._lineTimer = new Float32Array(N_PEOPLE);
    this._visited = new Uint8Array(N_PEOPLE);
    this._turnAmount = new Float32Array(N_PEOPLE);
    this._namedDwell = new Float32Array(NAMED_FIGURE_COUNT);

    this._dialogue = getFateDialogue(null);
    this._namedArcs = NAMED_FIGURES_BY_TYPE[0];
    this._color = PEBBLE_TYPES[0].color;

    this._scratchHandPos = new Vector3();
    this._scratchHandVel = new Vector3();
    this._hand = { position: new Vector3(), speed: 0, seen: false };
    this._scratchRisingPos = new Vector3();
    this._scratchCamPos = new Vector3();

    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._dwellRiseSynth = new DwellRiseSynth();
    this._dwellRiseSynth.build(this._audioListener, this.scene);

    // KING_EXCLUSION_HALF_ANGLE passed here too (previously omitted) — without
    // it a graveyard ghost or organic seed could land dead in the crowd cap's
    // exact center point, the one spot earth-situations-vfx-system.ts's own
    // King tower reserves for itself (see that constant's own comment) —
    // reading as a collectible stuck "in the center of the planet" rather
    // than scattered across its populated surface like everything else.
    this._graveyardNormals = scatterOnSphereCap(
      COLLECTIBLE_COUNT,
      ORIGIN,
      1,
      CROWD_CAP_DIRECTION,
      CAP_HALF_ANGLE,
      KING_EXCLUSION_HALF_ANGLE,
    ).normals;
    this._seedNormals = scatterOnSphereCap(
      COLLECTIBLE_COUNT,
      ORIGIN,
      1,
      CROWD_CAP_DIRECTION,
      CAP_HALF_ANGLE,
      KING_EXCLUSION_HALF_ANGLE,
    ).normals;
    this._graveyardField = this._buildCollectibleField(
      this._graveyardNormals,
      GHOST_ATTRACT_RADIUS,
      GHOST_CAPTURE_DISTANCE,
    );
    this._seedField = this._buildCollectibleField(
      this._seedNormals,
      COLLECTIBLE_ATTRACT_RADIUS,
      COLLECTIBLE_CAPTURE_DISTANCE,
    );
  }

  // Shared constructor for both Beat-4 collectible fields — spawnPoint maps
  // each fixed normal to a world direction FROM PLANET_CENTER (matching
  // GatherableFieldParams' own {dir, radiusT, type} contract), so every
  // particle starts just above its own grave/plant's surface point rather
  // than a generic random shell.
  private _buildCollectibleField(normals: Float32Array, attractRadius: number, captureDistance: number): GatherableField {
    const dir = new Vector3();
    return new GatherableField({
      count: COLLECTIBLE_COUNT,
      spawnCenter: PLANET_CENTER,
      spawnRadiusMin: PLANET_RADIUS + COLLECTIBLE_SURFACE_OFFSET_MIN,
      spawnRadiusMax: PLANET_RADIUS + COLLECTIBLE_SURFACE_OFFSET_MAX,
      attractRadius,
      captureDistance,
      attractRate: COLLECTIBLE_ATTRACT_RATE,
      capturedAgeDecay: COLLECTIBLE_CAPTURED_AGE_DECAY,
      capturedSpreadBase: COLLECTIBLE_CAPTURED_SPREAD_BASE,
      capturedSpreadGrowth: COLLECTIBLE_CAPTURED_SPREAD_GROWTH,
      capturedDepthRatio: COLLECTIBLE_CAPTURED_DEPTH_RATIO,
      spawnPoint: (index) => {
        dir.set(normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]);
        return { dir: dir.clone(), radiusT: Math.random(), type: 0 };
      },
      onCapture: (_index, x, y, z, speed) => {
        this._collectCaptureEvents.push({ x, y, z, speed });
      },
    });
  }

  // How far the player has actually wandered from world origin (XZ only) by
  // the time Fate Events begins — PLANET_CENTER/the whole crowd-cap layout
  // is authored assuming the player stands at X=0,Z=0 (see this file's own
  // CROWD_CAP_DIRECTION comment), but room-scale movement during
  // Constellations' star-touching can easily carry them elsewhere. Used to
  // shift where the planet/crowd/decorations actually land (see play()'s
  // own comment) instead of teleporting the player's camera to match the
  // authored layout — the camera never moves; everything that tracks the
  // planet's live position grows in already offset to land in front of
  // wherever the player actually is. Yaw/facing is deliberately NOT
  // corrected, only position — keeping this a straightforward "move the
  // content toward you" rather than also having to re-derive every
  // direction-based normal in this file against a rotated frame.
  private _getPlayerDriftXZ(): { x: number; z: number } {
    this.camera.getWorldPosition(this._scratchCamPos);
    return { x: this._scratchCamPos.x, z: this._scratchCamPos.z };
  }

  // Throne's crowd forms a semicircle around the King instead of filling
  // the cap's whole disc (see scatterSemicircleAroundPoint) — every other
  // symbol keeps the general, evenly-spaced cap layout (scatterOnSphereCapEven,
  // which — unlike the old random scatterOnSphereCap this replaced — never
  // lands two people close enough to overlap, and is a pure function of the
  // params below rather than a fresh random draw each call, so it lands in
  // the exact same spots every time this is called). Called once from
  // init() (celestialSymbol not known yet — see its own comment there) and
  // again from play() once it is, so a fresh loop can pick a different
  // branch than a previous one (e.g. replaying via the dev-menu phase jump).
  private _buildSurfaceLayout(isThrone: boolean): void {
    const center = new Vector3(...PLANET_CENTER);
    if (isThrone) {
      // Gas only ever actually SHOWS VISIBLE_PEOPLE_BY_TYPE[VOLATILE_GASSES_
      // TYPE] (6) of these N_PEOPLE (10) slots (see FateEventVfxSystem's own
      // maxVisible) — scattering all 10 across the semicircle and then only
      // rendering the first 6 left the back half of the arc almost empty
      // (indices 0/1 claim the two open ends, 2-9 sweep the interior in
      // order, so hiding 6-9 cuts off before the sweep ever reaches the far
      // side), crowding the visible 6 into one side instead of spacing them
      // evenly around the King. Scatter exactly the visible count instead,
      // then pad the remaining (never-rendered, but still read every frame —
      // see FateEventVfxSystem._updateLivePositions) slots with copies of
      // the last real one.
      const visibleCount = VISIBLE_PEOPLE_BY_TYPE[VOLATILE_GASSES_TYPE];
      const { positions, normals } = scatterSemicircleAroundPoint(
        visibleCount,
        center,
        PLANET_RADIUS,
        CROWD_CAP_DIRECTION,
        THRONE_ARC_ANGLE,
      );
      this._surfacePositions = new Float32Array(N_PEOPLE * 3);
      this._normals = new Float32Array(N_PEOPLE * 3);
      this._surfacePositions.set(positions);
      this._normals.set(normals);
      for (let i = visibleCount; i < N_PEOPLE; i++) {
        this._surfacePositions[i * 3] = positions[0];
        this._surfacePositions[i * 3 + 1] = positions[1];
        this._surfacePositions[i * 3 + 2] = positions[2];
        this._normals[i * 3] = normals[0];
        this._normals[i * 3 + 1] = normals[1];
        this._normals[i * 3 + 2] = normals[2];
      }
      return;
    }
    const { positions, normals } = scatterOnSphereCapEven(
      N_PEOPLE,
      center,
      PLANET_RADIUS,
      CROWD_CAP_DIRECTION,
      CAP_HALF_ANGLE,
      KING_EXCLUSION_HALF_ANGLE,
    );
    this._surfacePositions = positions;
    this._normals = normals;
  }

  // celestialSymbol/dominantPebbleType were already set (Constellations/
  // Pebbles) well before this phase can ever be reached — safe to read
  // fresh here, same pattern ConstellationsSystem.play() uses.
  play(): void {
    super.play();
    // PLANET_CENTER/the whole crowd-cap layout below is authored assuming
    // the player stands at world X=0,Z=0 facing -Z (see this file's own
    // CROWD_CAP_DIRECTION comment on how carefully that cap placement was
    // tuned for reach) — but by the time a real playthrough reaches here,
    // room-scale movement in earlier phases (Constellations' star-touching
    // especially) can easily have carried the player well away from world
    // origin, leaving that tuning reachable only by accident. Rather than
    // instantly teleporting the player's camera to correct for that (a hard
    // cut that got a lot more noticeable once the planet was brought closer
    // — see PLANET_CENTER's own comment), the drift is folded into where
    // the content itself ends up: _resolvedPlanetCenter below is
    // PLANET_CENTER shifted by the player's actual position, and Leg B (see
    // startFateEventsTransition() further down) grows/recedes toward THAT
    // instead of the raw constant — landing in front of wherever the player
    // actually is, with the camera never moving at all. Everything that
    // already tracks the planet's LIVE position (crowd/decorations/King,
    // via getLivePlanetPosition()/getLivePlanetRadius()) follows
    // automatically; getPlanetCenter() and the two GatherableFields below
    // are updated explicitly since they don't.
    const drift = this._getPlayerDriftXZ();
    this._resolvedPlanetCenter = [PLANET_CENTER[0] + drift.x, PLANET_CENTER[1], PLANET_CENTER[2] + drift.z];
    const globals = getGlobals(this.world);
    const dominantType = globals.dominantPebbleType.peek();
    const celestialSymbol = globals.celestialSymbol.peek();
    // Keyed off dominantPebbleType, not celestialSymbol — the King (and so
    // the semicircle gathered around him) is fundamentally a Gas-dominant
    // mechanic (see VOLATILE_GASSES_TYPE elsewhere in this file/
    // earth-situations-vfx-system.ts), and unlike celestialSymbol this is
    // already set the instant Pebbles ends — including on a dev-menu jump
    // straight to Fate Events, which never sets celestialSymbol at all (see
    // getFateDialogue's own null-fallback comment).
    this._buildSurfaceLayout(dominantType === VOLATILE_GASSES_TYPE);
    this._dialogue = getFateDialogue(celestialSymbol);
    this._namedArcs = NAMED_FIGURES_BY_TYPE[dominantType];
    this._color = this._dialogue.color ?? PEBBLE_TYPES[dominantType].color;
    this._showFire = dominantType === VOLATILE_GASSES_TYPE;
    // Every type now gets its own intro line here (NOTIFICATION_COPY[Phase.
    // FateEvents] is empty — see fateEventsIntroMessage's own comment),
    // replacing the old shared-generic-line-plus-Gas-only-supplement split.
    const notifications = this.world.getSystem(NotificationHudSystem);
    const { text, holdSeconds } = fateEventsIntroMessage(dominantType);
    notifications?.notify(text, holdSeconds);

    this._active.fill(0);
    this._awayTimer.fill(0);
    this._lineIndex.fill(0);
    this._lineTimer.fill(0);
    this._visited.fill(0);
    this._visitedCount = 0;
    this._turnAmount.fill(0);
    this._dwellRiseSynth.stop();
    this._risingPersonIndex = -1;
    this._namedDwell.fill(0);
    this._explainTriggered = false;
    this._explainElapsed = 0;
    this._dialogueOffset = Math.floor(Math.random() * this._dialogue.entries.length);

    // Beat 4's collectible fields were built once at init() (before this
    // playthrough's drift could possibly be known) using the raw,
    // unshifted PLANET_CENTER — recenterTo() nudges their already-baked
    // spawn shell to _resolvedPlanetCenter before reset() copies it into
    // the live positions array, so ghosts/seeds spawn hovering over
    // wherever the planet is actually settling this time, not the old
    // fixed spot. Idempotent, so replaying this phase repeatedly never
    // accumulates drift across loops.
    this._graveyardField.recenterTo(...this._resolvedPlanetCenter);
    this._seedField.recenterTo(...this._resolvedPlanetCenter);
    this._graveyardField.reset();
    this._seedField.reset();
    this._collectCaptureEvents.length = 0;

    this._beat = FateBeat.Zoom;
    this._beatTimer = 0;

    // Primary trigger for Leg B — the final grow/zoom-in from wherever
    // Constellations' spin transition (Leg A) left the planet, to
    // _resolvedPlanetCenter/Fate Events' PLANET_RADIUS (see planet-seeding-
    // vfx-system.ts's startFateEventsTransition, which syncs Leg B's start
    // state from Leg A before starting it, and PlanetFateTransition.start(),
    // which now derives its end state from the drift passed in here rather
    // than the raw constant). Also doubles as a dev-menu-skip safety net: a
    // jump straight to Fate Events (skipping both Seeding and
    // Constellations) still works, since Leg A always has a sane default
    // position/radius even if it never ran.
    this._planetSeeding.startFateEventsTransition(drift.x, drift.z);
  }

  // The "branching" payoff: if the player lingered near one of the two
  // featured figures more than the other, they get a one-line (anonymous —
  // see farewellMessage) farewell as the phase ends — silent if neither
  // crossed NAMED_DWELL_THRESHOLD (the player never meaningfully engaged
  // with either). A tie (including both at 0) also stays silent rather than
  // arbitrarily picking one.
  stop(): void {
    super.stop();
    const [a, b] = this._namedDwell;
    if (a === b || Math.max(a, b) < NAMED_DWELL_THRESHOLD) return;
    const notifications = this.world.getSystem(NotificationHudSystem);
    const { text, holdSeconds } = farewellMessage();
    notifications?.notify(text, holdSeconds);
  }

  update(delta: number): void {
    this._beatTimer += delta;

    if (this._beat === FateBeat.Zoom) {
      if (!this._planetSeeding.isFateTransitionActive()) this._enterBeat(FateBeat.Ambient);
      return;
    }
    if (this._beat === FateBeat.Ambient) {
      if (this._beatTimer >= AMBIENT_BEAT_SECONDS) {
        // Gas skips the scripted Explain beat entirely — every person is
        // already an equally "named," gold-rimmed, must-talk-to figure (see
        // GAS_NAMED_COUNT), so there's no single explainer to wait on before
        // Collect (skull-gathering) can start. Soul/Organic still go through
        // Explain as before.
        const dominant = getGlobals(this.world).dominantPebbleType.peek();
        this._enterBeat(dominant === VOLATILE_GASSES_TYPE ? FateBeat.Collect : FateBeat.Explain);
      }
      return;
    }
    if (this._beat === FateBeat.Explain) {
      this._updateExplain(delta);
      return;
    }
    if (this._beat === FateBeat.Collect) {
      this._updateCollect(delta);
      return;
    }
    // Payoff — the actual audiovisual finale is owned/driven by the
    // always-on EarthSituationsVfxSystem/FateEventVfxSystem (so it can keep
    // playing past this phase ending, see PAYOFF_HOLD_SECONDS's own
    // comment); this system's only job here is the hold-then-advance timer.
    if (this._beatTimer >= PAYOFF_HOLD_SECONDS) {
      // Beat 4's win condition already requires the FULL collection (every
      // ghost/seed/person — see _updateCollect's collectDone check) to ever
      // reach Payoff at all, so this always fires on a normal completion —
      // it's a per-type flavor of "you finished Fate Events," not a bonus
      // threshold. Only one of the three names any given run, since only one
      // dominant type is ever active; seeing all three means playing through
      // with each type across separate loops.
      const dominant = getGlobals(this.world).dominantPebbleType.peek();
      const id =
        dominant === SOUL_DUST_TYPE
          ? 'soul-collector'
          : dominant === ORGANIC_MATTER_TYPE
            ? 'green-thumb'
            : 'faced-the-mob';
      this.world.getSystem(AchievementSystem)?.unlock(id);
      getGlobals(this.world).phaseComplete.value = true;
    }
  }

  // Beat 3 — waits for the player to actually be near EXPLAIN_FIGURE_INDEX
  // before the explainer bubble even starts fading in, instead of the old
  // fixed-timer-from-beat-entry approach, which could fire and finish while
  // the player was looking somewhere else entirely and never noticed it.
  // Once triggered, the bubble holds/fades on its own EXPLAIN_BEAT_SECONDS
  // timeline regardless of whether they wander off mid-read — see
  // getExplainerOpacity(). EXPLAIN_FALLBACK_SECONDS is the absolute safety
  // net for a player who never approaches at all.
  private _updateExplain(delta: number): void {
    let near = false;
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchHandPos.fromArray(posView);
      const dx = this._surfacePositions[EXPLAIN_FIGURE_INDEX * 3] - this._scratchHandPos.x;
      const dy = this._surfacePositions[EXPLAIN_FIGURE_INDEX * 3 + 1] - this._scratchHandPos.y;
      const dz = this._surfacePositions[EXPLAIN_FIGURE_INDEX * 3 + 2] - this._scratchHandPos.z;
      if (dx * dx + dy * dy + dz * dz <= PROXIMITY_RADIUS * PROXIMITY_RADIUS) {
        near = true;
        break;
      }
    }
    // Drives the explainer figure's own bob animation too (see
    // FateEventVfxSystem), same "jumps when you're near" feedback the
    // ambient crowd already gives — a small non-verbal cue that they've
    // noticed you, right as their line is about to appear.
    this._active[EXPLAIN_FIGURE_INDEX] = near ? 1 : 0;

    if (!this._explainTriggered && near) {
      this._explainTriggered = true;
      this._explainElapsed = 0;
    }
    if (this._explainTriggered) this._explainElapsed += delta;

    const readDone = this._explainTriggered && this._explainElapsed >= EXPLAIN_BEAT_SECONDS;
    const timedOut = this._beatTimer >= EXPLAIN_FALLBACK_SECONDS;
    if (readDone || timedOut) this._enterBeat(FateBeat.Collect);
  }

  // Beat 4 — this is the OLD unscripted proximity/dialogue-cycling loop,
  // unchanged in content, just now gated to only run once the first three
  // beats have played out (see this file's own FateBeat comment for why
  // that's what actually satisfies "instead of random chatter"). Gas reuses
  // it as-is (visiting every visible person IS Beat 4 for that type); Soul/
  // Organic additionally step their own GatherableField (see
  // _buildCollectibleField) toward capture.
  private _updateCollect(delta: number): void {
    const visibleCount = this.getVisiblePeopleCount();

    this._hand.seen = false;
    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchHandVel.fromArray(velView);
      this._hand.position.fromArray(posView);
      this._hand.speed = this._scratchHandVel.length();
      this._hand.seen = true;
      this._scratchHandPos.fromArray(posView);

      for (let i = 0; i < visibleCount; i++) {
        const dx = this._surfacePositions[i * 3] - this._scratchHandPos.x;
        const dy = this._surfacePositions[i * 3 + 1] - this._scratchHandPos.y;
        const dz = this._surfacePositions[i * 3 + 2] - this._scratchHandPos.z;
        const near = dx * dx + dy * dy + dz * dz <= PROXIMITY_RADIUS * PROXIMITY_RADIUS;

        if (near) {
          // _visited no longer flips here on first contact — see the
          // _turnAmount dwell pass below, right after this hand loop.
          // Re-approaching after leaving (active was 0) replays the whole
          // dialogue sequence from its first line, instead of staying
          // frozen wherever isLastLine last left it — so a bubble can be
          // read again on a return visit, not just once ever.
          if (!this._active[i]) {
            this._lineIndex[i] = 0;
            this._lineTimer[i] = 0;
          }
          this._active[i] = 1;
          this._awayTimer[i] = 0;
        } else if (this._active[i]) {
          this._awayTimer[i] += delta;
          if (this._awayTimer[i] >= LEAVE_GRACE_SECONDS) {
            this._active[i] = 0;
          }
        }
      }
    }

    // Turns each visible person toward/away from the player in step with
    // _active[i] (see TURN_IN_SECONDS/TURN_OUT_SECONDS) — FateEventVfxSystem
    // reads _turnAmount to actually animate the orientation. _visited only
    // flips once a person has fully turned to face the player, not on first
    // contact — see PROXIMITY_RADIUS's own comment on why that used to make
    // a single sweep through the crowd silently visit everyone it crossed.
    for (let i = 0; i < visibleCount; i++) {
      const target = this._active[i] ? 1 : 0;
      if (this._turnAmount[i] < target) {
        this._turnAmount[i] = Math.min(target, this._turnAmount[i] + delta / TURN_IN_SECONDS);
      } else if (this._turnAmount[i] > target) {
        this._turnAmount[i] = Math.max(target, this._turnAmount[i] - delta / TURN_OUT_SECONDS);
      }
      if (!this._visited[i] && this._turnAmount[i] >= 1) {
        this._visited[i] = 1;
        this._visitedCount++;
      }
    }
    this._updateDwellRiseAudio(visibleCount);

    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    if (dominant === SOUL_DUST_TYPE) this._graveyardField.step(this._hand, delta);
    else if (dominant === ORGANIC_MATTER_TYPE) this._seedField.step(this._hand, delta);

    // Every visible person — named or ambient — now progresses and holds on
    // their own assigned line/sequence's last line rather than wrapping
    // back to the start (see getDialogueLinesFor's own comment): a "tiny
    // story" idiom, not chatter that loops forever.
    for (let i = 0; i < visibleCount; i++) {
      if (!this._active[i]) continue;
      if (i < NAMED_FIGURE_COUNT) this._namedDwell[i] += delta;
      // Bubble/dialogue only starts once the person has actually finished
      // turning to face the player (_turnAmount reaching 1 — see
      // TURN_IN_SECONDS), same "not on first contact" reasoning _visited
      // above already follows — without this, _lineTimer started advancing
      // (and the bubble started fading in) the instant proximity was
      // detected, popping up before the person had even turned toward the
      // player instead of reading as their reaction to actually noticing.
      if (this._turnAmount[i] < 1) continue;
      const lineCount = this.getDialogueLinesFor(i).length;
      const isLastLine = this._lineIndex[i] >= lineCount - 1;

      this._lineTimer[i] += delta;
      if (isLastLine) {
        // No more lines to cycle to — freeze once fully faded in and
        // holding, so the last line just stays readable instead of
        // fading out/in again with nothing new to show.
        this._lineTimer[i] = Math.min(this._lineTimer[i], BUBBLE_FADE_IN_SECONDS + BUBBLE_HOLD_SECONDS);
      } else if (this._lineTimer[i] >= BUBBLE_CYCLE_SECONDS) {
        this._lineTimer[i] = 0;
        this._lineIndex[i]++;
      }
    }

    let collectDone: boolean;
    if (dominant === VOLATILE_GASSES_TYPE) {
      collectDone = this._visitedCount >= Math.ceil(visibleCount * VISIT_FRACTION_TO_COMPLETE);
    } else if (dominant === SOUL_DUST_TYPE) {
      collectDone = this._graveyardField.totalCaptured >= this._graveyardField.count;
    } else {
      collectDone = this._seedField.totalCaptured >= this._seedField.count;
    }
    if (collectDone) this._enterBeat(FateBeat.Payoff);
  }

  // Drives DwellRiseSynth's single shared voice — whoever is currently
  // furthest into their own turn-in (active, but _turnAmount not yet at 1)
  // is who it voices, same "one voice, pick the most relevant candidate"
  // idiom as OrbitalLaunchSystem's own charge tone (only one zone can
  // charge there too). Silent whenever nobody is currently mid-turn.
  private _updateDwellRiseAudio(visibleCount: number): void {
    let best = -1;
    let bestAmount = -1;
    for (let i = 0; i < visibleCount; i++) {
      if (this._active[i] && this._turnAmount[i] < 1 && this._turnAmount[i] > bestAmount) {
        bestAmount = this._turnAmount[i];
        best = i;
      }
    }

    if (best < 0) {
      if (this._risingPersonIndex >= 0) {
        this._dwellRiseSynth.stop();
        this._risingPersonIndex = -1;
      }
      return;
    }

    this._scratchRisingPos.set(
      this._surfacePositions[best * 3],
      this._surfacePositions[best * 3 + 1],
      this._surfacePositions[best * 3 + 2],
    );
    if (this._risingPersonIndex !== best) {
      this._risingPersonIndex = best;
      this._dwellRiseSynth.start(this._scratchRisingPos);
    }
    this._dwellRiseSynth.update(bestAmount, this._scratchRisingPos);
  }

  private _enterBeat(beat: FateBeat): void {
    // Leaving Collect (the only beat _updateDwellRiseAudio ever runs in) —
    // stop it explicitly rather than leaving a voice ringing if this fires
    // while someone happened to still be mid-turn.
    if (this._beat === FateBeat.Collect && beat !== FateBeat.Collect) {
      this._dwellRiseSynth.stop();
      this._risingPersonIndex = -1;
    }
    this._beat = beat;
    this._beatTimer = 0;
  }

  // Read-only accessors for FateEventVfxSystem/EarthSituationsVfxSystem —
  // callers must not mutate.
  getBeat(): FateBeat {
    return this._beat;
  }
  getBeatElapsed(): number {
    return this._beatTimer;
  }
  // PLANET_CENTER shifted by this playthrough's player drift (see
  // _resolvedPlanetCenter's own comment) — the fire ring (fate-event-vfx-
  // system.ts's own _buildFire) is the sole consumer, and it's gated to
  // only appear after Leg B has fully settled there anyway.
  getPlanetCenter(): [number, number, number] {
    return this._resolvedPlanetCenter;
  }
  getPlanetRadius(): number {
    return PLANET_RADIUS;
  }
  getPersonCount(): number {
    return N_PEOPLE;
  }
  getSurfacePositions(): Float32Array {
    return this._surfacePositions;
  }
  getNormals(): Float32Array {
    return this._normals;
  }
  // Fixed unit-sphere directions (from PLANET_CENTER) for Beat 4's Soul/
  // Organic collectibles — shared with EarthSituationsVfxSystem's own
  // graveyard-marker dressing (see its _buildGraveyardScene) so the static
  // grave/plant decorations and the actual ghost/seed collectibles land in
  // the same spots instead of two independent scatters.
  getGraveyardNormals(): Float32Array {
    return this._graveyardNormals;
  }
  getSeedNormals(): Float32Array {
    return this._seedNormals;
  }
  getGraveyardField(): GatherableField {
    return this._graveyardField;
  }
  getSeedField(): GatherableField {
    return this._seedField;
  }
  // Drain-and-clear, same contract as StardustSystem's own
  // drainCaptureEvents() — returns whatever's queued since the last call and
  // empties the queue, so an idle frame with nothing captured returns the
  // same empty array back out (no allocation) rather than a fresh one.
  drainCollectCaptureEvents(): readonly CaptureEvent[] {
    if (this._collectCaptureEvents.length === 0) return this._collectCaptureEvents;
    const events = this._collectCaptureEvents;
    this._collectCaptureEvents = [];
    return events;
  }
  // Drives both the jump animation and speech-bubble visibility.
  getActiveMask(): Uint8Array {
    return this._active;
  }
  // 0-1 turn-toward-player progress per person — see TURN_IN_SECONDS/
  // TURN_OUT_SECONDS's own comment. FateEventVfxSystem reads this to blend
  // each Collect-beat person's orientation between their base outward-facing
  // pose and facing the player.
  getTurnAmount(i: number): number {
    return this._turnAmount[i];
  }
  // Gas's Beat 4 — FateEventVfxSystem edge-detects a person's 0->1 flip here
  // to trigger that person's skull-symbol flight into the comet's tail (see
  // its own _updateGasSymbols). Sticky (never clears once visited), unlike
  // getActiveMask.
  getVisitedMask(): Uint8Array {
    return this._visited;
  }
  getLineIndex(): Uint8Array {
    return this._lineIndex;
  }
  // Per-person dialogue. A fixed line for one specific named crowd member
  // (see notification-copy.ts's GAS_CHARACTER_NAMES/namedLines — GAS_
  // CHARACTER_NAMES maps a person index to a character name, namedLines is
  // keyed by that same name) takes priority over everything else: Throne
  // populates one for EVERY visible person, so this always wins there and
  // the featured-figure branches below are unreachable for that type.
  // Soul/Organic don't populate namedLines, so for them this falls through
  // to PAIRED_FIGURE_INDEX's fixed pairedLine, then EXPLAIN_FIGURE_INDEX/
  // PAIRED_FIGURE_INDEX's own NAMED_FIGURES_BY_TYPE arc (Beat 4, after Beat
  // 3's separate explainerLine — see getExplainerText), then finally the
  // ambient pool: every remaining crowd member (index >= NAMED_FIGURE_COUNT)
  // gets ONE entry from this._dialogue.entries, unique to them for this
  // playthrough — see _dialogueOffset's own comment — rather than everyone
  // sharing/repeating the same shared lines.
  getDialogueLinesFor(personIndex: number): readonly string[] {
    const name = GAS_CHARACTER_NAMES[personIndex];
    const namedLine = name ? this._dialogue.namedLines?.[name] : undefined;
    if (namedLine) return [namedLine];
    if (personIndex === PAIRED_FIGURE_INDEX && this._dialogue.pairedLine) {
      return [this._dialogue.pairedLine];
    }
    if (personIndex < NAMED_FIGURE_COUNT) return this._namedArcs[personIndex].lines;
    const entries = this._dialogue.entries;
    return entries[(this._dialogueOffset + (personIndex - NAMED_FIGURE_COUNT)) % entries.length];
  }
  getLineText(i: number): string {
    return this.getDialogueLinesFor(i)[this._lineIndex[i]] ?? '';
  }
  // 0-1 target opacity for person i's speech bubble, from the current
  // line's own fade-in -> hold -> fade-out position within _lineTimer[i] —
  // see BUBBLE_CYCLE_SECONDS's own comment. Callers still gate on
  // getActiveMask() themselves — this only shapes the curve while active.
  getBubbleOpacity(i: number): number {
    const t = this._lineTimer[i];
    if (t < BUBBLE_FADE_IN_SECONDS) return t / BUBBLE_FADE_IN_SECONDS;
    if (t < BUBBLE_FADE_IN_SECONDS + BUBBLE_HOLD_SECONDS) return 1;
    const outT = t - BUBBLE_FADE_IN_SECONDS - BUBBLE_HOLD_SECONDS;
    if (outT < BUBBLE_FADE_OUT_SECONDS) return 1 - outT / BUBBLE_FADE_OUT_SECONDS;
    return 0;
  }
  // Beat 3's single forced line for EXPLAIN_FIGURE_INDEX — see
  // getExplainerOpacity for its matching fade curve. Gas never reaches Beat
  // 3 at all (see update()'s Ambient->Collect branch) so explainerLine is
  // unset for Throne — the fallback here is just to satisfy the type.
  getExplainerText(): string {
    return this._dialogue.explainerLine ?? '';
  }
  getExplainerOpacity(): number {
    // Timed from _explainElapsed (since the player was first seen near
    // them — see _updateExplain), not _beatTimer — the bubble shouldn't
    // start fading in until they've actually been spotted.
    if (!this._explainTriggered) return 0;
    const t = this._explainElapsed;
    if (t < BUBBLE_FADE_IN_SECONDS) return t / BUBBLE_FADE_IN_SECONDS;
    if (t < BUBBLE_FADE_IN_SECONDS + EXPLAIN_HOLD_SECONDS) return 1;
    const outT = t - BUBBLE_FADE_IN_SECONDS - EXPLAIN_HOLD_SECONDS;
    if (outT < BUBBLE_FADE_OUT_SECONDS) return 1 - outT / BUBBLE_FADE_OUT_SECONDS;
    return 0;
  }
  getPeopleColor(): [number, number, number] {
    return this._color;
  }
  getShowFire(): boolean {
    return this._showFire;
  }
  // Live (not cached) — see VISIBLE_PEOPLE_BY_TYPE's comment for why.
  getVisiblePeopleCount(): number {
    return VISIBLE_PEOPLE_BY_TYPE[getGlobals(this.world).dominantPebbleType.peek()];
  }
  getBobFrequencyMultiplier(): number {
    return BOB_FREQUENCY_MULT_BY_TYPE[getGlobals(this.world).dominantPebbleType.peek()];
  }
  // Live (not cached) — how many of this playthrough's visible people count
  // as "named" (gold rim + talk-to marker, see FateEventVfxSystem's own
  // MAX_NAMED_FIGURES sizing): just the two featured figures for Soul/
  // Organic, but literally everyone for Gas (see GAS_NAMED_COUNT's own
  // comment).
  getNamedCount(): number {
    return getGlobals(this.world).dominantPebbleType.peek() === VOLATILE_GASSES_TYPE
      ? GAS_NAMED_COUNT
      : NAMED_FIGURE_COUNT;
  }
  // 0-1 overall Beat-4 "collect" progress for HandProgressHudSystem's wrist
  // bar — same per-type win metric _updateCollect's own collectDone check
  // uses (visited-fraction for Gas, capture-fraction for Soul/Organic).
  // Naturally reads 0 before Beat 4 even starts, since _visited/the
  // collectible fields are untouched until _updateCollect actually runs.
  getCollectProgress01(): number {
    const dominant = getGlobals(this.world).dominantPebbleType.peek();
    if (dominant === VOLATILE_GASSES_TYPE) {
      const visibleCount = this.getVisiblePeopleCount();
      return visibleCount > 0 ? Math.min(1, this._visitedCount / visibleCount) : 0;
    }
    const field = dominant === SOUL_DUST_TYPE ? this._graveyardField : this._seedField;
    return field.count > 0 ? Math.min(1, field.totalCaptured / field.count) : 0;
  }
}
