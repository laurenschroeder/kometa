import { Phase } from './phase.js';
import { FATE_THRONE_DIALOGUE, hexToRgb } from '../vfx/color/color-scheme.js';
import { PEBBLE_TYPES } from '../phases/pebbles/pebble-type.js';

// Single source of truth for ALL of this game's narrative text — both the
// notification HUD's per-phase blurbs (edit copy here, not in
// ui/notification-hud.uikitml) and Fate Events' in-world speech-bubble
// dialogue (FATE_DIALOGUE/NAMED_FIGURES_BY_TYPE/getFateDialogue further
// down — rendered by fate-event-vfx-system.ts over each placeholder person,
// not through the HUD at all). Keeping both in one file means the whole
// story can be reviewed/edited in one place even though they're rendered
// through two different mechanisms.
// `text` may contain '\n' to split across multiple lines (up to
// NotificationHudSystem's MAX_LINES) — each line spawns in staggered, one
// after another, rather than all fading in together (see LINE_STAGGER_
// SECONDS). A plain single-line string still fades in as one block, exactly
// as before.
export interface NotificationCopy {
  text: string;
  holdSeconds: number;
  // Silent gap (no box shown) before this message starts fading in — unlike
  // back-to-back queued messages (which fade in the instant the previous one
  // finishes fading out), this actually pauses first. Omit for the default
  // (no gap).
  delaySeconds?: number;
  // Only meaningful alongside a "hold until X" idiom (see STARDUST_INTRO_
  // TEXT/VISIT_STARS_TEXT) where something calls dismissByText() the instant
  // a gameplay condition is met, which could otherwise cut the message off
  // almost before it's readable if that condition fires fast (e.g. the
  // player's hand already sits inside the stardust field the moment the
  // phase starts). dismissByText() honors this as a floor — the message
  // still fades out early once it's met, just never sooner. Omit for no
  // floor (dismiss takes effect immediately, the original behavior).
  minHoldSeconds?: number;
  // Per-line text color (0-1 RGB), index-matched against text.split('\n') —
  // e.g. Pebbles' "the blue dust of souls" line tinted to match
  // PEBBLE_TYPES[0].color. A line with no entry (array too short, or an
  // explicit null) falls back to the HUD's default white — see
  // NotificationHudSystem._beginShow, which always sets an explicit color
  // per line so a previous message's tint can't leak onto the next one's
  // text elements.
  lineColors?: (readonly [number, number, number] | null)[];
  // Seconds after the message begins that each line starts fading in,
  // index-matched against text's lines. Omit for the HUD's default even
  // stagger. Use when other things (e.g. Pebbles' field reveals) are timed
  // against specific lines.
  lineStartSeconds?: readonly number[];
}

// Exported so ConstellationsSystem can dismiss this exact message the
// instant the player touches their first star — see its own use of
// NotificationHudSystem.dismissByText() and Phase.Constellations' own entry
// below.
export const VISIT_STARS_TEXT = 'Why not visit those nearby stars? The people on the planet seem very interested in them.';

// Exported so StardustSystem can dismiss this exact message the instant the
// player actually gathers their first stardust — see its own use of
// NotificationHudSystem.dismissByText() and Phase.Stardust's own entry
// below, same "hold until X" idiom as VISIT_STARS_TEXT above.
// Exported so ConstellationsVfxSystem can reveal the constellation the moment
// this (the last message before VISIT_STARS_TEXT) has finished — the
// VISIT_STARS_TEXT hint then follows CONSTELLATION_HINT_DELAY_SECONDS later.
export const CONSTELLATIONS_PRE_HINT_TEXT = 'What a nice looking planet.';
const CONSTELLATION_HINT_DELAY_SECONDS = 2;

// Pebbles' "Three paths call to you" intro is paced as: a path's line fades
// in, PEBBLE_INTRO_WAIT_SECONDS later that path's pebbles appear, then
// another PEBBLE_INTRO_WAIT_SECONDS later the next path's line fades in.
// Shared with PebbleWeavingSystem, which reveals each type's pebbles at
// PEBBLE_TYPE_REVEAL_SECONDS. Line 0 is the generic "Three paths" line; lines
// 1-3 name soul dust/organic matter/volatile gasses in that order.
const PEBBLE_INTRO_WAIT_SECONDS = 2;
const PEBBLE_INTRO_LINE_FADE_SECONDS = 0.5; // matches NotificationHudSystem's FADE_SECONDS
const PEBBLE_INTRO_FIRST_PATH_LINE_START = 2;
const PEBBLE_INTRO_PATH_STEP =
  PEBBLE_INTRO_LINE_FADE_SECONDS + PEBBLE_INTRO_WAIT_SECONDS + PEBBLE_INTRO_WAIT_SECONDS;
export const PEBBLE_INTRO_LINE_START_SECONDS: readonly number[] = [
  0,
  PEBBLE_INTRO_FIRST_PATH_LINE_START,
  PEBBLE_INTRO_FIRST_PATH_LINE_START + PEBBLE_INTRO_PATH_STEP,
  PEBBLE_INTRO_FIRST_PATH_LINE_START + PEBBLE_INTRO_PATH_STEP * 2,
];
export const PEBBLE_TYPE_REVEAL_SECONDS: readonly [number, number, number] = [
  PEBBLE_INTRO_LINE_START_SECONDS[1] + PEBBLE_INTRO_LINE_FADE_SECONDS + PEBBLE_INTRO_WAIT_SECONDS,
  PEBBLE_INTRO_LINE_START_SECONDS[2] + PEBBLE_INTRO_LINE_FADE_SECONDS + PEBBLE_INTRO_WAIT_SECONDS,
  PEBBLE_INTRO_LINE_START_SECONDS[3] + PEBBLE_INTRO_LINE_FADE_SECONDS + PEBBLE_INTRO_WAIT_SECONDS,
];

export const STARDUST_INTRO_TEXT = 'You are stardust unformed. Move your hand around to gather yourself into being.';

// Exported so PlanetSeedingSystem can hold the planet at its far-away
// PLANET_INITIAL_POSITION until this has actually been shown (see
// NotificationHudSystem.hasShown()), rather than starting its float-toward-
// the-player ease the instant Seeding begins regardless of whether the
// player has actually been told to go look for it yet.
export const SEEDING_INTRO_TEXT = 'Take a spin around this planet. Linger near its surface to seed it with stardust and leave your mark.';

// The wrist Continue button (ContinueButtonSystem) already announces itself
// with a chime, haptic pulse and glow when it unlocks — set this true to ALSO
// show CONTINUE_READY_TEXT as a HUD notification at that moment. Off by
// default since the audiovisual cue on the hand is usually enough.
export const CONTINUE_NOTIFICATIONS_ENABLED = false;
export const CONTINUE_READY_TEXT = 'Continue whenever you are ready.';

// Stardust's introduction to the Continue button — the button itself stays
// hidden in Stardust until this message has started showing (see
// ContinueButtonSystem), so it pops up right as the player is told about it.
export const CONTINUE_INTRO_TEXT =
  "Take your time here. Whenever you're ready to move onto the next Phase, use this Continue button.";

// Every phase gets a sequence (most are one message) — NotificationHudSystem
// queues them, so a multi-entry sequence plays as consecutive messages, each
// fully fading out before the next fades in.
export const NOTIFICATION_COPY: Record<Phase, NotificationCopy[]> = {
  [Phase.Stardust]: [
    // A few seconds' breathing room before the very first line — this is
    // also the instant the whole game starts, so text popping up literally
    // frame one left no time to get oriented first. holdSeconds is a
    // generous fallback cap, not the real hold time — see STARDUST_INTRO_
    // TEXT's own comment: StardustSystem dismisses this the instant the
    // player actually gathers their first stardust, same "hold until X"
    // idiom as VISIT_STARS_TEXT/Phase.Constellations. minHoldSeconds is the
    // original fixed hold this line used to have before it became
    // dismiss-on-condition — keeps a fast first capture (hand already near
    // the field) from cutting the instruction off before it's readable.
    {
      text: STARDUST_INTRO_TEXT,
      holdSeconds: 60,
      minHoldSeconds: 7.4,
      delaySeconds: 3,
    },
    { text: 'The faster you swing, the further the comet goes. Your comet collects the stardust it hits.', holdSeconds: 5.5, delaySeconds: 3 },
    {
      text: 'If you want to control the comet with a different hand, pinch it (or pull trigger on it) with the hand you want it to follow.',
      holdSeconds: 5,
      delaySeconds: 12,
    },
    {
      text: CONTINUE_INTRO_TEXT,
      holdSeconds: 5,
      delaySeconds: 12,
    },
  ],
  [Phase.Pebbles]: [
    {
      text: 'Three paths call to you\nthe blue forms of souls\nthe green pulse of living things\nthe red spectacle of volatile gasses.',
      // Hold starts once the last line is fully visible; the last type's
      // pebbles appear 2.5s after that line starts, so leave a few seconds
      // after that to take them in.
      holdSeconds: 6,
      lineColors: [null, PEBBLE_TYPES[0].color, PEBBLE_TYPES[1].color, PEBBLE_TYPES[2].color],
      lineStartSeconds: PEBBLE_INTRO_LINE_START_SECONDS,
    },
    {
      text: "Collect what you'd like to bring along with you.",
      holdSeconds: 4.5,
    },

  ],

  [Phase.Seeding]: [
    {
      text: SEEDING_INTRO_TEXT,
      holdSeconds: 8,
    },
  ],
  // Constellations onward: holds bumped up from their original values —
  // this whole stretch (transitions and notifications alike) was reading as
  // too fast-paced. See PlanetSpinTransition's own SPIN_DURATION comment for
  // the matching transition-side bump.
  [Phase.Constellations]: [
    { text: '*Many years later*', holdSeconds: 3.5 },
    {
      text: 'A whole ecosystem has developed, thanks to the unique stardust you seeded the planet with.',
      holdSeconds: 5.5,
    },
    { text: CONSTELLATIONS_PRE_HINT_TEXT, holdSeconds: 3 },
    {
      text: VISIT_STARS_TEXT,
      // The constellation appears the moment the message above finishes
      // (see ConstellationsVfxSystem's reveal gate), then this hint follows
      // after this gap.
      delaySeconds: CONSTELLATION_HINT_DELAY_SECONDS,
      // Generously long — this one is meant to stay up until the player
      // actually touches their first star, not fade out on its own clock.
      // ConstellationsSystem calls NotificationHudSystem.dismissByText()
      // the instant that happens, cutting this short (or canceling it
      // outright if it hasn't started showing yet) — see dismissByText's
      // own comment. This hold is just the fallback cap for a player who
      // never does.
      holdSeconds: 45,
      // Without a floor, a player who reaches the first star within
      // moments of this appearing (or before it's even started fading in)
      // let ConstellationsSystem's own constellationSpottedMessage —
      // queued right behind via notifyNext() — effectively override this
      // one before it was ever actually readable. Same "hold until X, but
      // no less than this" idiom as STARDUST_INTRO_TEXT's own
      // minHoldSeconds — dismissByText() defers until this floor is met
      // (showing immediately if still in its own delay), so the spied
      // message just waits its turn in the queue instead.
      minHoldSeconds: 5.5,
    },
  ],
  // Was one generic line for every type (Gas alone also got a supplemental
  // line via the old fateEventsGasIntroMessage) — now empty, since all
  // three types fire their own single intro line instead, matching their
  // actual mission rather than one shared blurb. See
  // fateEventsIntroMessage(), fired directly by FateEventSystem.play().
  [Phase.FateEvents]: [],
  // Was one generic "orbit or fling yourself into space" line for every
  // type — now empty; see launchIntroMessage(), fired directly by
  // OrbitalLaunchSystem.play(), which also needs its holdSeconds to time
  // when the choice zones become active (see that system's own comment).
  [Phase.Launch]: [],
  // Was one generic "you now find your place among the stars" line
  // regardless of what the player actually chose at Launch — now empty;
  // see finaleMessage(), fired directly by EndRunMenuSystem, which folds
  // this same closing sentiment together with the comet-naming beat
  // (formerly a separate cometNameMessage) and branches it by orbit-vs-
  // launch choice, since "finds a place among the stars" only actually
  // describes the orbit path.
  [Phase.Finale]: [],
  // Dev-only sandbox — no phase-entry blurb; ArtTestSystem shows its own
  // per-variant label via notify() instead.
  [Phase.ArtTest]: [],
};

// Everything below is ordered to match when it actually fires over the
// course of a playthrough (declaration order has no effect on behavior —
// this is purely for readability). Stardust -> Pebbles -> Constellations are
// still shared/generic; the three pebble types' narratives properly diverge
// starting partway through Constellations (CELESTIAL_SYMBOL_LINES/
// celestialSymbolMessage's 3-way branch, then Gas's own
// fateEventsGasIntroMessage supplement moments later) and stay generic again
// from there through Finale.

// Fired by StardustSystem once the tutorial's gather threshold is reached —
// not a phase-entry sequence (see NOTIFICATION_COPY above), a mid-phase,
// win-condition-triggered one, called directly via
// NotificationHudSystem.notify() (same pattern AchievementSystem uses).
export const STARDUST_WIN_SEQUENCE: NotificationCopy[] = [
  { text: 'You have so much stardust!', holdSeconds: 3.8 },
  { text: "Let's gather more, and grow even bigger..", holdSeconds: 4 },
  { text: 'Be warned. What you choose to gather next will shape the comet you become.', holdSeconds: 5 },
];

// Pebbles' completion message needs the dominant-type name interpolated in,
// so it can't be a static table entry like the ones above.
export function pebbleCompletionMessage(typeName: string): NotificationCopy {
  return {
    text: `You've collected so much matter, especially ${typeName}! Let's continue further into the universe.`,
    holdSeconds: 3.5,
  };
}

// Fired by ConstellationsSystem the first time a hand touches a dot on a
// not-yet-started constellation's path.
export function constellationSpottedMessage(name: string): NotificationCopy {
  return {
    text: `Creatures on this planet have spied you near the ${name} constellation..`,
    holdSeconds: 6,
  };
}

// --- Shepherd/Harvest/Throne diverge from here through Fate Events' opening ---

// Split into two beats, both fired together the instant a constellation's
// path is fully traced (the same edge EarthSituationsVfxSystem's crown-rise
// cinematic starts from — see its own _onCompletion):
//  - celestialSymbolFlavorMessage — the "this means something to them"
//    myth-beat, displays first (see ConstellationsSystem's notifyNext
//    ordering comment).
//  - celestialSymbolMessage (the explicit "you are crowned" reveal) displays
//    right after, then stays up (see its own comment) until globals.
//    crownLanded flips true, which is also what gates phaseComplete.
// Each line deliberately does NOT claim the comet caused whatever's
// happening below — the dog running loose, the war already brewing, the
// king already failing — that was always going to happen. What changes is
// that the people below now weave your passing into the story they tell
// about it; they're the ones making the myth, not you. Keyed by the same
// celestialSymbol strings the Fate Events dialogue tables below use.
const CELESTIAL_SYMBOL_LINES: Record<string, (name: string) => string> = {
  Shepherd: (name) => `The ${name} constellation means more to these creatures than you could realize.`,
  Harvest: (name) => `The creatures find it fitting, seeing you in the ${name} constellation.`,
  Throne: (name) => `Your fiery tail has captured a lot of attention while flying through the ${name} constellation.`,
};

export function celestialSymbolFlavorMessage(name: string): NotificationCopy | null {
  const flavor = CELESTIAL_SYMBOL_LINES[name]?.(name);
  if (!flavor) return null;
  return { text: flavor, holdSeconds: 8 };
}

// holdSeconds is a generous fallback cap, not the real hold time — this is
// meant to stay up the whole ~30s crown-rise cinematic (see crown-rise.ts's
// Emerge/Hover/Travel/Land stage durations), actively dismissed the instant
// globals.crownLanded flips true (see ConstellationsSystem's own dismissal),
// same "long fallback + active dismiss" idiom VISIT_STARS_TEXT already uses.
// delaySeconds gives celestialSymbolFlavorMessage (queued right before this
// one — see ConstellationsSystem's trace-completion block) a few silent
// seconds to breathe on its own before this reveal fades in, rather than
// cutting straight into it the instant the flavor line fades out.
export function celestialSymbolMessage(name: string): NotificationCopy {
  return {
    text: `It's been realized, you are crowned the celestial symbol of ${name}.`,
    holdSeconds: 8,
    delaySeconds: 1,
  };
}

// Fired directly by FateEventSystem.play() (indexed by dominantPebbleType —
// replaces NOTIFICATION_COPY[Phase.FateEvents], now empty) so every type
// gets its own Fate Events intro line matching its actual mission, instead
// of one shared generic blurb.
// Exported so EarthSituationsVfxSystem can hold Gas's king-death sequence until
// this message has fully faded out (NotificationHudSystem.hasFinished()).
export const FATE_GAS_INTRO_TEXT =
  'It seems you have arrived at a bad time..';

const FATE_EVENTS_INTRO_BY_TYPE: NotificationCopy[] = [
  // soul dust — the graveyard/ghost-gathering vignette.
  {
    text: 'The soul dust you gathered sense something interesting nearby..',
    holdSeconds: 6,
  },
  // organic matter — the seed-gathering vignette.
  {
    text: 'This planet has intelligent life, and they understand your mission.',
    holdSeconds: 6.2,
  },
  // volatile gasses — the king's-death/blame vignette (was the old
  // Gas-only fateEventsGasIntroMessage, unchanged).
  {
    text: FATE_GAS_INTRO_TEXT,
    holdSeconds: 6.5,
  },
];
export function fateEventsIntroMessage(dominantType: number): NotificationCopy {
  return FATE_EVENTS_INTRO_BY_TYPE[dominantType] ?? FATE_EVENTS_INTRO_BY_TYPE[0];
}

// --- Fate Events in-world dialogue (rendered as speech bubbles over each
// placeholder person by fate-event-vfx-system.ts, NOT top-HUD notify() calls
// like everything else in this file) — moved here from the old standalone
// fate-dialogue.ts so all of the game's narrative text lives in one place.
// Keyed by the same celestialSymbol strings (Shepherd/Harvest/Throne) used above. ---

// `entries` is a pool of per-person scripts: each entry is either a single
// line (a length-1 array) or a short ordered sequence that progresses and
// holds on its last line (same "tiny story" idiom as the two named figures
// below) while a hand stays near that person. Every ambient crowd member
// (index >= NAMED_FIGURE_COUNT) gets assigned exactly ONE entry, unique to
// them for that playthrough — see FateEventSystem's _dialogueOffset — so
// walking down the crowd never hears the same line twice, and a fresh loop
// (a new random offset into the pool) surfaces a different subset when a
// constellation's pool has more entries than it has visible ambient slots
// (see VISIBLE_PEOPLE_BY_TYPE in fate-event-system.ts).
export interface FateDialogueEntry {
  entries: string[][];
  // Only Throne overrides the family color (Shepherd/Harvest fall back to
  // PEBBLE_TYPES[dominantPebbleType].color in fate-event-system.ts).
  color?: [number, number, number];
  // Shepherd/Harvest only — the full override line EarthSituationsVfxSystem
  // gives to the one paired person's dialogue instead of the lines above (see
  // FateEventSystem.getDialogueLinesFor and earth-situations-vfx-system.ts).
  // Throne doesn't use this — every one of its people gets a namedLine below
  // instead, no featured "paired" figure singled out.
  pairedLine?: string;
  // Beat 3's single scripted "who you are / what you need to do" line —
  // force-assigned to EXPLAIN_FIGURE_INDEX's bubble for the whole Explain
  // beat, bypassing the proximity-triggered ambient pool above entirely (see
  // FateEventSystem.getExplainerText/getBeat). Shepherd/Harvest only — Throne
  // skips Explain entirely (see FateEventSystem.update()'s Ambient->Collect
  // branch), so nobody there needs a scripted narrator line.
  explainerLine?: string;
  // One fixed, hardcoded line per named crowd member (see
  // GAS_CHARACTER_NAMES) — takes priority over both pairedLine/explainerLine
  // above and the random `entries` pool below for whichever person index
  // that name currently maps to (see FateEventSystem.getDialogueLinesFor).
  // Keyed by NAME rather than person index so each line lives right next to
  // a readable character name here instead of a magic index number. Throne
  // populates one of these for EVERY visible person (see GAS_CHARACTER_NAMES
  // — no featured/explainer/paired split, everyone's just a named crowd
  // member), so `entries` below is unused for Throne.
  namedLines?: Record<string, string>;
}

// Gas/Throne's crowd — every visible person (VISIBLE_PEOPLE_BY_TYPE[2] = 6)
// is an equally "named" figure now: same gold rim, same "talk to me" marker,
// same individual namedLine below, no featured explainer/paired split like
// Shepherd/Harvest still have. Each also gets its own downloaded animation
// (see fate-event-vfx-system.ts's GAS_CHARACTER_POSES, keyed off these same
// indices) instead of sharing the crowd's default breathing-idle loop.
// Indices 4/5 land right next to each other in the crowd's own semicircle
// layout (see scatterSemicircleAroundPoint's ordering in sphere-scatter.ts),
// which is why Mourner/Griever share the same Sitting Disbelief animation as
// a visual pair rather than each getting a distinct one.
export const GAS_POINTER_INDEX = 0; // == fate-event-system.ts's EXPLAIN_FIGURE_INDEX
export const GAS_ACCUSER_INDEX = 1; // == fate-event-system.ts's PAIRED_FIGURE_INDEX
export const GAS_GRUMP_INDEX = 2;
export const GAS_RANTER_INDEX = 3;
export const GAS_MOURNER_INDEX = 4;
export const GAS_GRIEVER_INDEX = 5;

export const GAS_CHARACTER_NAMES: Record<number, string> = {
  [GAS_POINTER_INDEX]: 'Pointer', // Angry Point, half speed
  [GAS_ACCUSER_INDEX]: 'Accuser', // Angry Gesture
  [GAS_GRUMP_INDEX]: 'Grump', // Angry
  [GAS_RANTER_INDEX]: 'Ranter', // Angry Gesture
  [GAS_MOURNER_INDEX]: 'Mourner', // Sitting Disbelief
  [GAS_GRIEVER_INDEX]: 'Griever', // Sitting Disbelief
};

export const FATE_DIALOGUE: Record<string, FateDialogueEntry> = {
  // soul dust — VISIBLE_PEOPLE_BY_TYPE[0] = 9, so 7 ambient slots (9 minus
  // the 2 named figures); this pool is sized to exactly match.
  Shepherd: {
    entries: [
      ['What are these strange alien souls I see in your tail?'],
      ['Take good care of our souls.'],
      ['Bring them somewhere interesting.'],

    ],
    pairedLine: "What are these strange alien souls I see in your tail?",
    explainerLine:
      "We have so many detached souls here. Collect them so they can join you on your travels.",
  },
  // organic matter — VISIBLE_PEOPLE_BY_TYPE[1] = N_PEOPLE (10), so 8
  // ambient slots; this pool is sized to match.
  Harvest: {
    entries: [
      ['The beauty of the planet all started with your stardust. We want to pass it on.'],
      ['Maybe these plants can take root on a distant planet'],

    ],
    pairedLine: 'The beauty of the planet all started with your stardust. We want to return the favor.',
    explainerLine:
      'Take these seeds from our best plants and spread them around this universe.',
  },
  // volatile gasses — every one of VISIBLE_PEOPLE_BY_TYPE[2]'s 6 visible
  // people gets a namedLine below (see GAS_CHARACTER_NAMES), so this pool is
  // never actually drawn from — kept empty rather than deleted so
  // FateDialogueEntry's required `entries` field stays satisfied.
  Throne: {
    entries: [],
    color: hexToRgb(FATE_THRONE_DIALOGUE),
    // One fixed line per named crowd member — picked to match each one's own
    // animation (see GAS_CHARACTER_NAMES). Every visible person gets one now
    // (no separate pairedLine/explainerLine narrator role) — Pointer/Accuser
    // carry what used to be the explainer/paired lines.
    namedLines: {
      Pointer: "Wretched king-killer! We'd all like a word with you.",
      Accuser: 'You visit our planet and bring death to our king!',
      Grump: 'How dare you take our king from us!',
      Ranter: 'Leave us and never come back!',
      Mourner: 'This is too much chaos for me. Why comet, why?',
      Griever: 'The comet has brought death to our king!',
    },
  },
};

// The two featured figures (see fate-event-system.ts's NAMED_FIGURE_COUNT) —
// always person-indices 0/1 — get their own short arc per dominant pebble
// type instead of drawing from the ambient pool above. Written per pebble
// type (not per constellation, unlike FATE_DIALOGUE above) to keep the
// content scope manageable — 2 figures x ~3 lines x 3 types. Like every
// ambient entry now, these progress and hold on the last line rather than
// wrapping back to the start (see fate-event-system.ts's update()). No
// display name — their speech bubbles show only the line text, same as the
// ambient crowd's.
export interface NamedFigureArc {
  lines: string[];
}

// Indexed binantPebbleType (0=soul dust, 1=organic matter, 2=volatile
// gasses — see pebble-type.ts).
export const NAMED_FIGURES_BY_TYPE: [NamedFigureArc, NamedFigureArc][] = [
  [
    {
      lines: ['You remind me of someone..', "Actually no, you're taller.", 'Anyway. Nice comet.'],
    },
    {
      lines: [
        'Are you actually made of stardust, or is that just a brand thing?',
        'Either way I want to come with you.',
        "You're not going to answer that, are you.",
      ],
    },
  ],
  [
    {
      lines: [
        'Welcome to our lush planet. Try not to step on anything.',
        "The harvest hasn't been this good in years. We're crediting you.",
        'Statisticy domally it\'s probably the rain. But thank you.',
      ],
    },
    {
      lines: [
        '*sniff sniff* You smell like rain.',
        "We haven't needed rain since you showed up.",
        "Don't overthink it, just take the compliment.",
      ],
    },
  ],
  [
    {
      lines: [
        "The sky's been doing that bleeding-red thing again. Cool color, bad omen.",
        'Every prophecy about you has come true so far, which is genuinely inconvenient.',
        'Please leave. Nothing personal. Extremely personal.',
      ],
    },
    {
      lines: [
        "You don't scare me, comet.",
        'Okay, a little.',
        "We rebuilt after the locusts. We'll rebuild again. Probably.",
      ],
    },
  ],
];

const FATE_DIALOGUE_NAMES = Object.keys(FATE_DIALOGUE);

// celestialSymbol is only ever null if the dev phase-jump menu is used to
// reach FateEvents without ever completing Constellations — rather than a
// placeholder "undecided" message, just pick one of the 3 real
// constellations at random so the phase always shows real content.
export function getFateDialogue(celestialSymbol: string | null): FateDialogueEntry {
  if (celestialSymbol && FATE_DIALOGUE[celestialSymbol]) return FATE_DIALOGUE[celestialSymbol];
  const randomName = FATE_DIALOGUE_NAMES[Math.floor(Math.random() * FATE_DIALOGUE_NAMES.length)];
  return FATE_DIALOGUE[randomName];
}

// --- Generic again from here through Launch's own buildup sequence, which
// branches by type one more time (see launchIntroMessage/orbitCommitMessage/
// unknownCommitMessage below) ---

// Fired by FateEventSystem.stop() if the player lingered near one of the
// phase's two featured figures (see NAMED_FIGURES_BY_TYPE above) more than
// the other — a small personalized callback rather than a generic
// phase-end message. Silent if the player never meaningfully engaged with
// either. Anonymous — the figures no longer carry a display name.
export function farewellMessage(): NotificationCopy {
  return {
    text: "They watch you go, and don't look away.",
    holdSeconds: 5.7,
  };
}

// Fired directly by OrbitalLaunchSystem.play(), right before the per-type
// launchIntroMessage below — a short, generic heads-up that a decision is
// coming, before the type-specific line actually explains what it is.
export const FINAL_CHOICE_MESSAGE: NotificationCopy = {
  text: 'You have a final choice to make.',
  holdSeconds: 3,
};

// Fired directly by OrbitalLaunchSystem.play() (indexed by
// dominantPebbleType — replaces NOTIFICATION_COPY[Phase.Launch], now empty)
// so the phase's opening line ties to what's actually riding in the tail by
// this point (ghosts/seeds/skulls) instead of one shared generic blurb.
const LAUNCH_INTRO_BY_TYPE: NotificationCopy[] = [
  {
    text: 'The souls you gathered are quiet now, riding with you. You can choose to orbit close to home, or carry them on forever.',
    holdSeconds: 9.5,
  },
  {
    text: 'The seeds are packed in tight, waiting for new ground. Would you like to orbit this planet and keep and eye on things, or scatter them further out into the universe?',
    holdSeconds: 9.5,
  },
  {
    text: "They've already started telling stories about the comet that took their king. Take on the role of curse-bringer orbiting this planet forever, or continue on into the universe?",
    holdSeconds: 10,
  },
];
export function launchIntroMessage(dominantType: number): NotificationCopy {
  return LAUNCH_INTRO_BY_TYPE[dominantType] ?? LAUNCH_INTRO_BY_TYPE[0];
}

// Fired by OrbitalLaunchSystem the moment the player commits to one of the
// two choice zones — indexed by dominantPebbleType, same reasoning as
// launchIntroMessage above (was static/generic before).
const ORBIT_COMMIT_BY_TYPE: NotificationCopy[] = [
  { text: 'You will stay as a light in their sky, reminding the creatures of the ones who followed.', holdSeconds: 5.5 },
  { text: 'You will stay as a light in their sky, watching everything you started grow.', holdSeconds: 5.9 },
  { text: 'You will stay as a light in their sky. The omen they can point to forever.', holdSeconds: 6 },
];
const UNKNOWN_COMMIT_BY_TYPE: NotificationCopy[] = [
  { text: 'You will carry them onward, to new cosmic lands.', holdSeconds: 5.7 },
  { text: 'You will leave to spread these unique plants elsewhere.', holdSeconds: 5.2 },
  { text: 'You will leave the planet with only the story, and no one left to blame.', holdSeconds: 5.9 },
];
export function orbitCommitMessage(dominantType: number): NotificationCopy {
  return ORBIT_COMMIT_BY_TYPE[dominantType] ?? ORBIT_COMMIT_BY_TYPE[0];
}
export function unknownCommitMessage(dominantType: number): NotificationCopy {
  return UNKNOWN_COMMIT_BY_TYPE[dominantType] ?? UNKNOWN_COMMIT_BY_TYPE[0];
}

// Queued right after the commit message above (same call site) — coaches
// the player to keep swinging the comet, since OrbitalLaunchSystem now
// detaches once real speed is built up rather than on a fixed timer, and
// CometAutopilotSystem carries whatever velocity exists at that instant
// into orbit/launch. One shared sequence for both choices — the physical
// instruction is identical either way. Holds bumped up a bit less than the
// rest of this Constellations-onward pass (see NOTIFICATION_COPY's own
// comment) — this sequence is meant to read as a quickening countdown, not
// a leisurely one, but it still needed a little more room.
export const LAUNCH_BUILDUP_SEQUENCE: NotificationCopy[] = [
  { text: 'Get ready to go. Swing your comet to build up speed.', holdSeconds: 5 },
  { text: 'Faster!', holdSeconds: 2.5 },
  { text: 'Keep going!', holdSeconds: 2.5 },
];

// A quiet, one-line real-world echo per dominant type — never spelled out
// as literal exposition, just a narrator's aside a thoughtful player can
// connect to something true: Gas gestures at how people reach for a story
// (a curse, an omen) to explain what they don't understand rather than sit
// with chance; Organic gestures at panspermia — comets/asteroids are a real
// hypothesis for how early Earth got the organic building blocks for life;
// Soul gestures at consciousness/the metaphysical still being genuinely
// unexplained, not just unexplained-to-these-characters. Indexed by
// dominantPebbleType, same convention as ORBIT_COMMIT_BY_TYPE above.
const FINALE_MEANING_BY_TYPE: string[] = [
  "Nobody ever told you what a soul actually is. Somehow you ended up with a whole pack of them anyway.",
  'Long before you arrived, comets like you were already carrying the first ingredients of life from space to planet.',
  "They will remember you as an omen. It's easier than remembering there wasn't one.",
];

// Fired once by EndRunMenuSystem, right before the "time is done" message —
// closes out the run as two SEPARATE queued notifications (each fully
// fades out before the next fades in — see NotificationHudSystem.notify()/
// _triggerPhase's own array-of-entries idiom), not one multi-line box: the
// quiet type-specific meaning first, then what your final identity means
// given the choice made at Launch (OrbitalLaunchSystem.getChoice()) — orbit
// settles permanently into this world's sky under the name you earned
// (celestialSymbol, tying back to whichever constellation you became —
// falls back to the dominant pebble type's own name on a dev-menu skip that
// never traced one), launch carries on past it into anonymity instead, so
// no name is named there.
export function finaleMessage(
  dominantType: number,
  celestialSymbol: string | null,
  choice: 'orbit' | 'launch',
): NotificationCopy[] {
  const name = celestialSymbol ?? PEBBLE_TYPES[dominantType]?.name ?? 'the unnamed';
  const meaning = FINALE_MEANING_BY_TYPE[dominantType] ?? FINALE_MEANING_BY_TYPE[0];
  const closing =
    choice === 'orbit'
      ? `A lifetime spent gathering and delivering space dust ends here. You have found your place as ${name}.`
      : 'A life spent gathering and delivering space dust carries you onward, for whatever comes next.';
  const typeColor = PEBBLE_TYPES[dominantType]?.color ?? null;
  return [
    { text: meaning, holdSeconds: 9, lineColors: [typeColor] },
    { text: closing, holdSeconds: 8, lineColors: [typeColor] },
  ];
}
