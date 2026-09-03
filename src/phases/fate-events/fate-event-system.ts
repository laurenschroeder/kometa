import { createSystem, Vector3 } from '@iwsdk/core';
import { CometBody } from '../../comet/comet-body-component.js';
import { HandAnchor } from '../../comet/hand-anchor-component.js';
import { getGlobals } from '../../core/globals.js';
import { farewellMessage } from '../../core/notification-copy.js';
import { NotificationHudSystem } from '../../core/notification-hud-system.js';
import { scatterOnSphereCap } from '../../vfx/geometry/sphere-scatter.js';
import { PlanetSeedingVfxSystem } from '../planet-seeding/planet-seeding-vfx-system.js';
import { PEBBLE_TYPES } from '../pebbles/pebble-type.js';
import { FateDialogueEntry, getFateDialogue, NamedFigureArc, NAMED_FIGURES_BY_TYPE } from './fate-dialogue.js';

// Z pulled back from -2.0 — at that distance the near surface sat only
// ~0.6m from the player's face (PLANET_RADIUS 1.4 leaves centerDistance-
// PLANET_RADIUS of clearance), which read as the planet growing into your
// head right as Leg B's grow transition (planet-fate-transition.ts) landed.
// -2.6 leaves ~1.2m of clearance instead, a comfortable distance for
// something this large to loom at. PlanetFateTransition derives its whole
// end state from this constant, so every consumer (crowd placement below,
// comet-autopilot's live orbit math, constellation-vfx's reveal) moves
// together with it — nothing else needed to change.
export const PLANET_CENTER: [number, number, number] = [0, 1.3, -2.6];
export const PLANET_RADIUS = 1.4;
export const N_PEOPLE = 10;
// 28 degrees (was 45) — tighter cluster on the patch of surface most
// directly facing the player, instead of spreading wide enough that people
// near the cap's edge sit at a steep, foreshortened angle relative to the
// viewer and are easy to miss against the planet's curvature.
const CAP_HALF_ANGLE = (28 * Math.PI) / 180;
const PROXIMITY_RADIUS = 0.3;
// How long a person keeps its current dialogue line before cycling to the
// next one in its constellation's line array, while a hand stays near it.
const LINE_CYCLE_SECONDS = 3.2;
// Grace window before "near" -> "far" actually clears state, so brushing
// the proximity radius's edge doesn't flicker the jump/bubble on and off.
const LEAVE_GRACE_SECONDS = 0.4;
// Volatile gasses' index in PEBBLE_TYPES/dominantPebbleType — gates the
// ambient "big fire" effect (see fate-event-vfx-system.ts).
const VOLATILE_GASSES_TYPE = 2;

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
// the phase early — otherwise it falls back to the timeout (see index.ts).
// 1.0 — talking to everyone is what unlocks moving on, not just half of them.
const VISIT_FRACTION_TO_COMPLETE = 1.0;

// The first two people (always within range — VISIBLE_PEOPLE_BY_TYPE's
// smallest value is 6) get individual identity instead of sharing the
// ambient crowd's dialogue — see NAMED_FIGURES_BY_TYPE. Exported so
// FateEventVfxSystem uses the same indices for its gold-rim material swap.
export const NAMED_FIGURE_COUNT = 2;
// Minimum accumulated near-time (see _namedDwell) before stop()'s farewell
// message will name a figure at all — guards against firing for a player
// who barely brushed past one on their way to somewhere else.
const NAMED_DWELL_THRESHOLD = 0.5;

// Gameplay for Fate Events: a big planet appears near the player, populated
// with N_PEOPLE placeholder figures scattered across its near-facing surface
// (see sphere-scatter.ts — normals double as each figure's "up" direction).
// Whichever hand gets close to a person triggers that person to jump (see
// FateEventVfxSystem's per-frame bob easing, driven by getActiveMask() here)
// and show a speech bubble cycling through dialogue lines tied to whichever
// constellation the player became the celestial symbol of (globals.
// celestialSymbol) — see fate-dialogue.ts. Volatile-gasses winners also get
// an ambient "big fire" effect (globals.dominantPebbleType). Pure simulation
// here: no mesh/entity creation happens in this file (see
// FateEventVfxSystem), only surface layout math and proximity/dialogue
// state. Visiting every one of the type's visible people (see
// VISIT_FRACTION_TO_COMPLETE) completes the phase; otherwise it falls back
// to the timeout (see index.ts).
export class FateEventSystem extends createSystem({
  hands: { required: [CometBody, HandAnchor] },
}) {
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

  private _scratchHandPos!: Vector3;

  init(): void {
    const center = new Vector3(...PLANET_CENTER);
    const towardPlayer = new Vector3(0, 0, 1);
    const { positions, normals } = scatterOnSphereCap(
      N_PEOPLE,
      center,
      PLANET_RADIUS,
      towardPlayer,
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

    this._active.fill(0);
    this._awayTimer.fill(0);
    this._lineIndex.fill(0);
    this._lineTimer.fill(0);
    this._visited.fill(0);
    this._visitedCount = 0;
    this._namedDwell.fill(0);
    this._dialogueOffset = Math.floor(Math.random() * this._dialogue.entries.length);

    // Primary trigger for Leg B — the final grow/zoom-in from wherever
    // Constellations' spin transition (Leg A) left the planet, to Fate
    // Events' true PLANET_CENTER/PLANET_RADIUS (see planet-seeding-vfx-
    // system.ts's startFateEventsTransition, which syncs Leg B's start state
    // from Leg A before starting it). Also doubles as a dev-menu-skip safety
    // net: a jump straight to Fate Events (skipping both Seeding and
    // Constellations) still works, since Leg A always has a sane default
    // position/radius even if it never ran.
    this.world.getSystem(PlanetSeedingVfxSystem)?.startFateEventsTransition();
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
    // Only the type's own visible figures (see VISIBLE_PEOPLE_BY_TYPE) are
    // reachable — the rest stay hidden scenery (see fate-event-vfx-system.ts's
    // matching revealCount cap), so they never activate/count as visited.
    const visibleCount = this.getVisiblePeopleCount();

    for (const entity of this.queries.hands.entities) {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
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

    if (this._visitedCount >= Math.ceil(visibleCount * VISIT_FRACTION_TO_COMPLETE)) {
      getGlobals(this.world).phaseComplete.value = true;
    }

    // Every visible person — named or ambient — now progresses and holds on
    // their own assigned line/sequence's last line rather than wrapping
    // back to the start (see getDialogueLinesFor's own comment): a "tiny
    // story" idiom, not chatter that loops forever.
    for (let i = 0; i < visibleCount; i++) {
      if (!this._active[i]) continue;
      if (i < NAMED_FIGURE_COUNT) this._namedDwell[i] += delta;
      const lineCount = this.getDialogueLinesFor(i).length;

      this._lineTimer[i] += delta;
      if (this._lineTimer[i] >= LINE_CYCLE_SECONDS) {
        this._lineTimer[i] = 0;
        this._lineIndex[i] = Math.min(this._lineIndex[i] + 1, lineCount - 1);
      }
    }
  }

  // Read-only accessors for FateEventVfxSystem — callers must not mutate.
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
  // Drives both the jump animation and speech-bubble visibility.
  getActiveMask(): Uint8Array {
    return this._active;
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
  // "paired" with a risen ghost (Dog/Human only — see globals.
  // pairedPersonIndex/pairedPersonLine, set on that constellation's
  // completion edge) gets a fixed single-line override instead, replacing
  // their assigned entry entirely. Routed through globals rather than a
  // direct system reference so this file and earth-situations-vfx-system.ts
  // don't need to import each other. Checked AFTER the named-figure check
  // (not before) so a named figure's own arc always wins over a ghost
  // pairing, same precedence as before this refactor.
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
