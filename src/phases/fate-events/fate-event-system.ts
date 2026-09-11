import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { GatherableField, GatherHandInput } from '../../comet/gatherable-field.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import {
  farewellMessage,
  FateDialogueEntry,
  fateEventsIntroMessage,
  getFateDialogue,
  NamedFigureArc,
  NAMED_FIGURES_BY_TYPE,
} from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';

const ORIGIN = new Vector3(0, 0, 0);

// Beat 2's "tabletop" framing: rather than a dome facing the player's chest
// (the old PLANET_CENTER=[0,1.3,-2.6] + toward-player cap), the planet now
// settles low and close, mostly out of sight below, with only its TOP
// hemisphere cresting up within reach — the player looks down onto it like a
// low round table/altar instead of staring straight at an approaching wall.
// CROWD_CAP_DIRECTION (world up, not toward-player) is what actually
// produces that — every populated cap (people here, decorations/graveyard/
// king tower in earth-situations-vfx-system.ts, which imports this same
// constant so every scattered element lands on the same near-top region)
// scatters around +Y from PLANET_CENTER instead of +Z. First-pass numbers —
// same as every other transition constant in this stretch, expect to retune
// in-headset (see PlanetFateTransition, whose own _faceRef/dolly math
// derives entirely from these two constants, no separate change needed
// there).
export const PLANET_CENTER: [number, number, number] = [0, -0.35, -1.9];
export const PLANET_RADIUS = 1.4;
export const CROWD_CAP_DIRECTION = new Vector3(0, 1, 0);
export const N_PEOPLE = 10;
// Bumped from 28 — the populated cap now faces straight up on a much closer
// sphere (see CROWD_CAP_DIRECTION above) rather than a distant near-face;
// a bit wider keeps the crowd from reading as one tight clump directly
// overhead.
const CAP_HALF_ANGLE = (34 * Math.PI) / 180;
const PROXIMITY_RADIUS = 0.3;
// A person's speech bubble now runs its own fade-in -> hold (readable) ->
// fade-out cycle per line, rather than the old instant swap every
// LINE_CYCLE_SECONDS — the swap read as the bubble popping straight to new
// text with the old text having no chance to be read in full. See
// getBubbleOpacity()/update()'s _lineTimer advance below.
const BUBBLE_FADE_IN_SECONDS = 0.4;
const BUBBLE_HOLD_SECONDS = 2.8;
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
// Reuses named figure 0's bubble for Beat 3's single scripted explainer line
// (see getExplainerText/getExplainerOpacity) — bypassing proximity and the
// ambient dialogue pool entirely for that one beat.
export const EXPLAIN_FIGURE_INDEX = 0;
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
const EXPLAIN_HOLD_SECONDS = 5;
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

  private _active!: Uint8Array;
  private _awayTimer!: Float32Array;
  private _lineIndex!: Uint8Array;
  private _lineTimer!: Float32Array;
  private _visited!: Uint8Array;
  private _visitedCount = 0;
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

  private _scratchHandPos!: Vector3;
  private _scratchHandVel!: Vector3;

  init(): void {
    this._planetSeeding = this.world.getSystem(PlanetSeedingVfxSystem)!;

    const center = new Vector3(...PLANET_CENTER);
    const { positions, normals } = scatterOnSphereCap(
      N_PEOPLE,
      center,
      PLANET_RADIUS,
      CROWD_CAP_DIRECTION,
      CAP_HALF_ANGLE,
    );
    this._surfacePositions = positions;
    this._normals = normals;

    this._active = new Uint8Array(N_PEOPLE);
    this._awayTimer = new Float32Array(N_PEOPLE);
    this._lineIndex = new Uint8Array(N_PEOPLE);
    this._lineTimer = new Float32Array(N_PEOPLE);
    this._visited = new Uint8Array(N_PEOPLE);
    this._namedDwell = new Float32Array(NAMED_FIGURE_COUNT);

    this._dialogue = getFateDialogue(null);
    this._namedArcs = NAMED_FIGURES_BY_TYPE[0];
    this._color = PEBBLE_TYPES[0].color;

    this._scratchHandPos = new Vector3();
    this._scratchHandVel = new Vector3();
    this._hand = { position: new Vector3(), speed: 0, seen: false };

    this._graveyardNormals = scatterOnSphereCap(
      COLLECTIBLE_COUNT,
      ORIGIN,
      1,
      CROWD_CAP_DIRECTION,
      CAP_HALF_ANGLE,
    ).normals;
    this._seedNormals = scatterOnSphereCap(COLLECTIBLE_COUNT, ORIGIN, 1, CROWD_CAP_DIRECTION, CAP_HALF_ANGLE).normals;
    this._graveyardField = this._buildCollectibleField(this._graveyardNormals);
    this._seedField = this._buildCollectibleField(this._seedNormals);
  }

  // Shared constructor for both Beat-4 collectible fields — spawnPoint maps
  // each fixed normal to a world direction FROM PLANET_CENTER (matching
  // GatherableFieldParams' own {dir, radiusT, type} contract), so every
  // particle starts just above its own grave/plant's surface point rather
  // than a generic random shell.
  private _buildCollectibleField(normals: Float32Array): GatherableField {
    const dir = new Vector3();
    return new GatherableField({
      count: COLLECTIBLE_COUNT,
      spawnCenter: PLANET_CENTER,
      spawnRadiusMin: PLANET_RADIUS + COLLECTIBLE_SURFACE_OFFSET_MIN,
      spawnRadiusMax: PLANET_RADIUS + COLLECTIBLE_SURFACE_OFFSET_MAX,
      attractRadius: COLLECTIBLE_ATTRACT_RADIUS,
      captureDistance: COLLECTIBLE_CAPTURE_DISTANCE,
      attractRate: COLLECTIBLE_ATTRACT_RATE,
      capturedAgeDecay: COLLECTIBLE_CAPTURED_AGE_DECAY,
      capturedSpreadBase: COLLECTIBLE_CAPTURED_SPREAD_BASE,
      capturedSpreadGrowth: COLLECTIBLE_CAPTURED_SPREAD_GROWTH,
      capturedDepthRatio: COLLECTIBLE_CAPTURED_DEPTH_RATIO,
      spawnPoint: (index) => {
        dir.set(normals[index * 3], normals[index * 3 + 1], normals[index * 3 + 2]);
        return { dir: dir.clone(), radiusT: Math.random(), type: 0 };
      },
    });
  }

  // celestialSymbol/dominantPebbleType were already set (Constellations/
  // Pebbles) well before this phase can ever be reached — safe to read
  // fresh here, same pattern ConstellationsSystem.play() uses.
  play(): void {
    super.play();
    const globals = getGlobals(this.world);
    const dominantType = globals.dominantPebbleType.peek();
    this._dialogue = getFateDialogue(globals.celestialSymbol.peek());
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
    this._namedDwell.fill(0);
    this._explainTriggered = false;
    this._explainElapsed = 0;
    this._dialogueOffset = Math.floor(Math.random() * this._dialogue.entries.length);

    this._graveyardField.reset();
    this._seedField.reset();

    this._beat = FateBeat.Zoom;
    this._beatTimer = 0;

    // Primary trigger for Leg B — the final grow/zoom-in from wherever
    // Constellations' spin transition (Leg A) left the planet, to Fate
    // Events' true PLANET_CENTER/PLANET_RADIUS (see planet-seeding-vfx-
    // system.ts's startFateEventsTransition, which syncs Leg B's start state
    // from Leg A before starting it). Also doubles as a dev-menu-skip safety
    // net: a jump straight to Fate Events (skipping both Seeding and
    // Constellations) still works, since Leg A always has a sane default
    // position/radius even if it never ran.
    this._planetSeeding.startFateEventsTransition();
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
      if (this._beatTimer >= AMBIENT_BEAT_SECONDS) this._enterBeat(FateBeat.Explain);
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
          if (!this._visited[i]) {
            this._visited[i] = 1;
            this._visitedCount++;
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

  private _enterBeat(beat: FateBeat): void {
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
  getPlanetCenter(): [number, number, number] {
    return PLANET_CENTER;
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
  // Drives both the jump animation and speech-bubble visibility.
  getActiveMask(): Uint8Array {
    return this._active;
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
  // Per-person dialogue. The two featured figures (see NAMED_FIGURE_COUNT)
  // always get their own NAMED_FIGURES_BY_TYPE arc. Every ambient crowd
  // member gets ONE entry from this._dialogue.entries, unique to them for
  // this playthrough — see _dialogueOffset's own comment — rather than
  // everyone sharing/repeating the same shared lines. The one exception:
  // whichever ambient person index EarthSituationsVfxSystem picked as
  // "paired" (Dog only — see globals.pairedPersonIndex/pairedPersonLine, set
  // on that constellation's completion edge) gets a fixed single-line
  // override instead, replacing their assigned entry entirely. Routed
  // through globals rather than a direct system reference so this file and
  // earth-situations-vfx-system.ts don't need to import each other. Checked
  // AFTER the named-figure check (not before) so a named figure's own arc
  // always wins over a paired override.
  getDialogueLinesFor(personIndex: number): readonly string[] {
    if (personIndex < NAMED_FIGURE_COUNT) return this._namedArcs[personIndex].lines;
    const globals = getGlobals(this.world);
    if (personIndex === globals.pairedPersonIndex.peek()) {
      const line = globals.pairedPersonLine.peek();
      if (line) return [line];
    }
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
  // getExplainerOpacity for its matching fade curve.
  getExplainerText(): string {
    return this._dialogue.explainerLine;
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
}
