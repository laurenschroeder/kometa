// Dialogue table for Fate Events' placeholder people — keyed by the exact
// celestialSymbol strings ConstellationsSystem writes (see
// constellation-set.ts). A person cycles through its entry's whole `lines`
// array while you stay near it (same "queue of short messages" idiom
// notification-copy.ts uses), starting over from index 0 each time you
// approach again.
export interface FateDialogueEntry {
  lines: string[];
  // Only the volatile-gasses trio overrides the family color (soul
  // dust/organic matter fall back to PEBBLE_TYPES[dominantPebbleType].color
  // in fate-event-system.ts) — these three map to the user's own
  // green/red/yellow "mood" grouping for that category.
  color?: [number, number, number];
  // Dog/Human only — the full override line EarthSituationsVfxSystem gives
  // to the one paired person's dialogue instead of the lines above (see
  // FateEventSystem.getDialogueLinesFor and earth-situations-vfx-system.ts).
  pairedLine?: string;
}

export const FATE_DIALOGUE: Record<string, FateDialogueEntry> = {
  // soul dust
  Dog: {
    lines: ['WOOF WOOF WOOF WOOF', 'ruff ruff'],
    pairedLine: 'I keep thinking about Luna'
  },
  Human: {
    lines: ['That comet reminds me of someone I know', '<3'],
    pairedLine: 'I wonder if that was her visiting us..'
  },
  Horn: {
    lines: [
      "This comet is bringing good news! Let's celebrate some more!",
      'That comet signals good news',
      'Someone out there has a message for us!',
      'What could it be?',
    ],
  },
  // organic matter — the placeholder figures "make the sound" of their animal
  Bird: { lines: ['Chirp', 'Squawk', 'tweet tweet tweet'] },
  Giraffe: { lines: ['hmmmmmm', '*chomp chomp chomp*', 'snort!'] },
  Tree: { lines: ['rustle rustle rustle', 'creeeeeak', 'shhhhhh'] },
  // volatile gasses — green/red/yellow mapped to Locust/Bow and Arrow/Crown
  Locust: {
    lines: [
      'That comet brought locusts upon us!',
      'Where did all these locusts come from??',
      'The comet brought these locusts upon us!!',
      'i HATE locusts',
    ],
    color: [0.35, 0.85, 0.4],
  },
  'Bow and Arrow': {
    lines: ['That comet was the bringer of death and war!', 'Red comet? THIS MEANS WAR', 'Attack'],
    color: [0.9, 0.15, 0.15],
  },
  Crown: {
    lines: [
      'That comet brings death to kings! Beware!',
      'The comet has brought death to our king!',
      'Time for an uprising!',
      'This is too much chaos for me',
    ],
    color: [1.0, 0.82, 0.15],
  },
};

// The two featured figures (see fate-event-system.ts's NAMED_FIGURE_COUNT) —
// always person-indices 0/1 — get their own short 3-line arc per dominant
// pebble type instead of sharing the ambient crowd's cycling lines. Written
// per pebble type (not per constellation, unlike FATE_DIALOGUE above) to
// keep the content scope manageable — 2 figures x 3 lines x 3 types. Unlike
// the ambient crowd, these PROGRESS and hold on the last line rather than
// wrapping back to the start (see fate-event-system.ts's update()). No
// display name — their speech bubbles show only the line text, same as the
// ambient crowd's.
export interface NamedFigureArc {
  lines: string[];
}

// Indexed by dominantPebbleType (0=soul dust, 1=organic matter, 2=volatile
// gasses — see pebble-type.ts). Organics' pair leans slightly more
// expressive than the ambient crowd's pure animal-sound onomatopoeia, while
// staying in the same naturalistic register.
export const NAMED_FIGURES_BY_TYPE: [NamedFigureArc, NamedFigureArc][] = [
  [
    {
      lines: [
        "You remind me of someone..",
        "They're with you now, I can feel it.",
      ],
    },
    {
      lines: [
        'Whoa... are you really made of stardust?',
        "I want to go wherever you're going.",
        "Will I see you again?",

      ],
    },
  ],
  [
    {
      lines: [
        'Welcome to our lush planet!', "The harvest hasn't been this good in years.", "Thank you for that!"],
    },
    {
      lines: ['*sniff sniff* You smell like rain.', "We haven't needed rain since you came.", "Don't tell me that's a coincidence."],
    },
  ],
  [
    {
      lines: [
        'The sky is bleeding red again...',
        'Every omen before you came true.',
        'Just leave, and take your curse with you!!',
      ],
    },
    {
      lines: [
        "You don't scare me, comet.",
        "We rebuilt after the locusts. We'll rebuild again.",

      ],
    },
  ],
];

const FATE_DIALOGUE_NAMES = Object.keys(FATE_DIALOGUE);

// celestialSymbol is only ever null if the dev phase-jump menu is used to
// reach FateEvents without ever completing Constellations — rather than a
// placeholder "undecided" message, just pick one of the 9 real
// constellations at random so the phase always shows real content.
export function getFateDialogue(celestialSymbol: string | null): FateDialogueEntry {
  if (celestialSymbol && FATE_DIALOGUE[celestialSymbol]) return FATE_DIALOGUE[celestialSymbol];
  const randomName = FATE_DIALOGUE_NAMES[Math.floor(Math.random() * FATE_DIALOGUE_NAMES.length)];
  return FATE_DIALOGUE[randomName];
}
