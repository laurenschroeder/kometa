import { Phase } from './phase.js';
import { FATE_CROWN_DIALOGUE, hexToRgb } from '../vfx/color/color-scheme.js';
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
  // Per-line text color (0-1 RGB), index-matched against text.split('\n') —
  // e.g. Pebbles' "the blue dust of souls" line tinted to match
  // PEBBLE_TYPES[0].color. A line with no entry (array too short, or an
  // explicit null) falls back to the HUD's default white — see
  // NotificationHudSystem._beginShow, which always sets an explicit color
  // per line so a previous message's tint can't leak onto the next one's
  // text elements.
  lineColors?: (readonly [number, number, number] | null)[];
}

// Exported so ConstellationsSystem can dismiss this exact message the
// instant the player touches their first star — see its own use of
// NotificationHudSystem.dismissByText() and Phase.Constellations' own entry
// below.
export const VISIT_STARS_TEXT = 'Why not visit those nearby stars? The people on the planet seem very interested in them.';

// Every phase gets a sequence (most are one message) — NotificationHudSystem
// queues them, so a multi-entry sequence plays as consecutive messages, each
// fully fading out before the next fades in.
export const NOTIFICATION_COPY: Record<Phase, NotificationCopy[]> = {
  [Phase.Stardust]: [
    { text: 'You are stardust unformed. Move your hand around to gather yourself into being.', holdSeconds: 5.4 },
    { text: 'The faster you swing, the further you go.', holdSeconds: 5.5, delaySeconds: 2 },
    {
      text: 'If you want to control the comet with a different hand, pinch (or pull trigger) with the hand you want it to follow.',
      holdSeconds: 5,
      delaySeconds: 12,
    },
  ],
  [Phase.Pebbles]: [
    {
      text: 'Three paths call to you\nthe blue forms of souls\nthe green pulse of living things\nthe red spectacle of volatile gasses.',
      holdSeconds: 5.5,
      lineColors: [null, PEBBLE_TYPES[0].color, PEBBLE_TYPES[1].color, PEBBLE_TYPES[2].color],
    },
    {
      text: 'What you gather will not just change yourself, but affect other planets you come into contact with.',
      holdSeconds: 6.5,
    },

  ],

  [Phase.Seeding]: [
    {
      text: 'Take a spin around this planet. Linger near its surface to seed it with stardust.',
      holdSeconds: 4,
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
    { text: "What a nice looking planet.", holdSeconds: 3 },
    {
      text: VISIT_STARS_TEXT,
      // Generously long — this one is meant to stay up until the player
      // actually touches their first star, not fade out on its own clock.
      // ConstellationsSystem calls NotificationHudSystem.dismissByText()
      // the instant that happens, cutting this short (or canceling it
      // outright if it hasn't started showing yet) — see dismissByText's
      // own comment. This hold is just the fallback cap for a player who
      // never does.
      holdSeconds: 45,
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
// starting partway through Constellations (kingRisingMessage/
// CELESTIAL_SYMBOL_LINES/celestialSymbolMessage's 3-way branch, then Gas's
// own fateEventsGasIntroMessage supplement moments later) and stay generic
// again from there through Finale.

// Fired by StardustSystem once the tutorial's gather threshold is reached —
// not a phase-entry sequence (see NOTIFICATION_COPY above), a mid-phase,
// win-condition-triggered one, called directly via
// NotificationHudSystem.notify() (same pattern AchievementSystem uses).
export const STARDUST_WIN_SEQUENCE: NotificationCopy[] = [
  { text: 'You have so much stardust!', holdSeconds: 2.8 },
  { text: "Now you're ready to grow even bigger..", holdSeconds: 3 },
  { text: 'But be warned. What you choose to gather next will shape the comet you become.', holdSeconds: 4 },
];

// Pebbles' completion message needs the dominant-type name interpolated in,
// so it can't be a static table entry like the ones above.
export function pebbleCompletionMessage(typeName: string): NotificationCopy {
  return {
    text: `You've collected so many pebbles, especially ${typeName}! Let's continue further into the universe.`,
    holdSeconds: 3.5,
  };
}

// Fired by ConstellationsSystem the first time a hand touches a dot on a
// not-yet-started constellation's path.
export function constellationSpottedMessage(name: string): NotificationCopy {
  return {
    text: `The creatures of this planet have spied you near the ${name} constellation…`,
    holdSeconds: 6,
  };
}

// --- Dog/Tree/Crown diverge from here through Fate Events' opening ---

// Fired by ConstellationsSystem the instant the Crown constellation's 3rd
// star is traced — a mid-trace foreshadowing beat, well before the
// constellation actually completes, for the king's death vignette that
// plays later in Fate Events (see earth-situations-vfx-system.ts's Beat 2.5
// gas vignette).
export function kingRisingMessage(): NotificationCopy {
  return {
    text: 'A new king seems to be rising to power on this planet.',
    holdSeconds: 4.5,
  };
}

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
  Dog: (name) => `The ${name} constellation means more to these creatures than you could realize.`,
  Tree: (name) => `There is a poetry to your attention to the ${name} constellation.`,
  Crown: (name) => `Your fiery tail has captured a lot of attention in the ${name} constellation.`,
};

export function celestialSymbolFlavorMessage(name: string): NotificationCopy | null {
  const flavor = CELESTIAL_SYMBOL_LINES[name]?.(name);
  if (!flavor) return null;
  return { text: flavor, holdSeconds: 5 };
}

// holdSeconds is a generous fallback cap, not the real hold time — this is
// meant to stay up the whole ~30s crown-rise cinematic (see crown-rise.ts's
// Emerge/Hover/Travel/Land stage durations), actively dismissed the instant
// globals.crownLanded flips true (see ConstellationsSystem's own dismissal),
// same "long fallback + active dismiss" idiom VISIT_STARS_TEXT already uses.
export function celestialSymbolMessage(name: string): NotificationCopy {
  return {
    text: `It's been realized, you are crowned the celestial symbol of ${name}.`,
    holdSeconds: 40,
  };
}

// Fired directly by FateEventSystem.play() (indexed by dominantPebbleType —
// replaces NOTIFICATION_COPY[Phase.FateEvents], now empty) so every type
// gets its own Fate Events intro line matching its actual mission, instead
// of one shared generic blurb.
const FATE_EVENTS_INTRO_BY_TYPE: NotificationCopy[] = [
  // soul dust — the graveyard/ghost-gathering vignette.
  {
    text: 'The soul dust you gathered sense something interesting on this planet.',
    holdSeconds: 6,
  },
  // organic matter — the seed-gathering vignette.
  {
    text: 'This planet has intelligent life, and they understand who you are. They have a job for you.',
    holdSeconds: 6.2,
  },
  // volatile gasses — the king's-death/blame vignette (was the old
  // Gas-only fateEventsGasIntroMessage, unchanged).
  {
    text: "Your comet burns red across their sky tonight. Lucky for them, they will soon need someone to blame.",
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
// Keyed by the same celestialSymbol strings (Dog/Tree/Crown) used above. ---

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
  // Only Crown overrides the family color (Dog/Tree fall back to
  // PEBBLE_TYPES[dominantPebbleType].color in fate-event-system.ts).
  color?: [number, number, number];
  // Dog only — the full override line EarthSituationsVfxSystem gives to the
  // one paired person's dialogue instead of the lines above (see
  // FateEventSystem.getDialogueLinesFor and earth-situations-vfx-system.ts).
  pairedLine?: string;
  // Beat 3's single scripted "who you are / what you need to do" line —
  // force-assigned to EXPLAIN_FIGURE_INDEX's bubble for the whole Explain
  // beat, bypassing the proximity-triggered ambient pool above entirely (see
  // FateEventSystem.getExplainerText/getBeat).
  explainerLine: string;
}

export const FATE_DIALOGUE: Record<string, FateDialogueEntry> = {
  // soul dust — VISIBLE_PEOPLE_BY_TYPE[0] = 9, so 7 ambient slots (9 minus
  // the 2 named figures); this pool is sized to exactly match.
  Dog: {
    entries: [
      ['WOOF WOOF WOOF WOOF'],
      ['ruff ruff'],
      ["That's not a good omen, that's just Gary's dog again."],
      ['It followed the comet. Or it followed a squirrel. Hard to say.'],
      ['WOOF.', 'Is that you Rover?', 'Bark once for yes', 'the comet is destiny.'],
      ["I've seen that dog steal three sandwiches this week. I don't trust its judgment."],
      ['He\'s been staring at the sky for twenty minutes. He does that for garbage trucks too.'],
    ],
    pairedLine: "You've brought so many alien souls to visit us!",
    explainerLine:
      "We have many detached souls here, too. Collect them so they can join you on your travels.",
  },
  // organic matter — VISIBLE_PEOPLE_BY_TYPE[1] = N_PEOPLE (10), so 8
  // ambient slots; this pool is sized to match.
  Tree: {
    entries: [
      ['rustle rustle rustle'],
      ['creeeeeak'],
      ['shhhhhh'],
      ["It's just wind. But sure, let's make it a prophecy."],
      ["This tree has been 'communicating' since I was a kid. It's just old."],
      ['Every civilization eventually decides a tree is talking to them. Ours just picked this one.'],
      ["The tree creaked. We're calling that a message now."],
      ["It's been doing that since before the comet showed up, but sure."],
      ['Third new species this decade. We\'ve stopped trying to explain it.'],
    ],
    pairedLine: 'The beauty of the planet all started with your stardust. We want to return the favor.',
    explainerLine:
      'Take seeds from our best plants and spread them around this universe.',
  },
  // volatile gasses — VISIBLE_PEOPLE_BY_TYPE[2] = 6, so only 4 ambient
  // slots; this pool deliberately holds more than 4 entries, since
  // FateEventSystem's random per-play offset means which 4 actually show up
  // varies loop to loop instead of always the same first 4.
  Crown: {
    entries: [
      ['That comet brings death to kings! Beware!'],
      ['The comet has brought death to our king!'],
      ['Time for an uprising!'],
      ['This is too much chaos for me'],
      ["The king was already sick. The comet's just getting credit."],
      ["We're blaming the comet mostly so nobody blames the guy who poisoned the wine."],
    ],
    color: hexToRgb(FATE_CROWN_DIALOGUE),
    pairedLine: 'You visit our planet and bring death to our king.',
    explainerLine:
      "We don't take this lightly! Go to each of our people and hear what they think of this curse before you leave.",
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

// Indexed by dominantPebbleType (0=soul dust, 1=organic matter, 2=volatile
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
        'Statistically it\'s probably the rain. But thank you.',
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
    holdSeconds: 7.5,
  },
  {
    text: 'The seeds are packed in tight, waiting for new ground. Would you like to orbit this planet and keep and eye on things, or scatter them further out into the universe?',
    holdSeconds: 7.5,
  },
  {
    text: "They've already started telling stories about the comet that took their king. Take on the role of curse-bringer orbiting this planet forever, or continue on into the universe?",
    holdSeconds: 8,
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
  { text: 'You will leave them with only the story, and no one left to blame.', holdSeconds: 5.9 },
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
  'Long before you arrived, comets like you were already carrying the first ingredients of life from space to world.',
  "They will remember you as an omen. It's easier than remembering there wasn't one.",
];

// Fired once by EndRunMenuSystem, right before the "time is done" message —
// closes out the run in two staggered lines (see NotificationCopy's own
// comment on '\n' + LINE_STAGGER_SECONDS): the quiet type-specific meaning
// above, then what your final identity means given the choice made at
// Launch (OrbitalLaunchSystem.getChoice()) — orbit settles permanently into
// this world's sky under the name you earned (celestialSymbol, tying back
// to whichever constellation you became — falls back to the dominant
// pebble type's own name on a dev-menu skip that never traced one), launch
// carries on past it into anonymity instead, so no name is named there.
export function finaleMessage(
  dominantType: number,
  celestialSymbol: string | null,
  choice: 'orbit' | 'launch',
): NotificationCopy {
  const name = celestialSymbol ?? PEBBLE_TYPES[dominantType]?.name ?? 'the unnamed';
  const meaning = FINALE_MEANING_BY_TYPE[dominantType] ?? FINALE_MEANING_BY_TYPE[0];
  const closing =
    choice === 'orbit'
      ? `A lifetime spent gathering and delivering space dust ends here. You have found your place as ${name}.`
      : 'A lifetime spent gathering and delivering space dust carries you onward still, for whatever comes next.';
  return {
    text: `${meaning}\n${closing}`,
    holdSeconds: 8.5,
    lineColors: [null, PEBBLE_TYPES[dominantType]?.color ?? null, null],
  };
}
