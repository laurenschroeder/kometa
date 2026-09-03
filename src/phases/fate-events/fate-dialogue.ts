// Dialogue table for Fate Events' placeholder people — keyed by the exact
// celestialSymbol strings ConstellationsSystem writes (see
// constellation-set.ts). `entries` is a pool of per-person scripts: each
// entry is either a single line (a length-1 array) or a short ordered
// sequence that progresses and holds on its last line (same "tiny story"
// idiom as the two named figures below) while a hand stays near that
// person. Every ambient crowd member (index >= NAMED_FIGURE_COUNT) gets
// assigned exactly ONE entry, unique to them for that playthrough — see
// FateEventSystem's _dialogueOffset — so walking down the crowd never hears
// the same line twice, and a fresh loop (a new random offset into the pool)
// surfaces a different subset when a constellation's pool has more entries
// than it has visible ambient slots (see VISIBLE_PEOPLE_BY_TYPE).
export interface FateDialogueEntry {
  entries: string[][];
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
  // soul dust — VISIBLE_PEOPLE_BY_TYPE[0] = 9, so 7 ambient slots (9 minus
  // the 2 named figures); each of these 3 pools is sized to exactly match.
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
    pairedLine: 'I keep thinking about Luna',
  },
  Human: {
    entries: [
      ['That comet reminds me of someone I know'],
      ['<3'],
      ['We broke up under that comet. Coincidence? Yes. But also no.'],
      ['Every relationship in this town has a comet excuse now.'],
      ['I told her it was a sign.', 'She said it was a rock.', "We're not talking anymore."],
      ["I don't believe in omens, but if I did, that would be a bad one for Steve."],
      ["That's the third couple this week to blame the sky instead of therapy."],
    ],
    pairedLine: 'I wonder if that was her visiting us..',
  },
  Horn: {
    entries: [
      ["This comet is bringing good news! Let's celebrate some more!"],
      ['That comet signals good news'],
      ['Someone out there has a message for us!'],
      ['What could it be?'],
      ["Best PR a festival's had in years."],
      ['Love this comet already.'],
      ["Someone tried to cancel the parade. The comet showed up. Parade's back on."],
    ],
  },
  // organic matter — VISIBLE_PEOPLE_BY_TYPE[1] = N_PEOPLE (10), so 8
  // ambient slots; each pool sized to match.
  Bird: {
    entries: [
      ['Chirp'],
      ['Squawk'],
      ['tweet tweet tweet'],
      ["They've been singing since 5am. The comet has nothing to do with it."],
      ['Ornithologists hate this one weird trick.'],
      ["That's not a song, that's just a bird yelling. We've decided it's prophecy."],
      ["Every bird in this valley suddenly thinks it's a messenger. Ego, honestly."],
      ["The comet didn't teach them to sing. They've just found a captive audience."],
    ],
  },
  Giraffe: {
    entries: [
      ['hmmmmmm'],
      ['*chomp chomp chomp*'],
      ['snort!'],
      ['We asked the giraffe what the comet means.', 'It kept eating.'],
      ["It didn't even look up. Truly the least impressed creature on this planet."],
      ["Giraffes have seen empires fall and they still don't care. Respect."],
      ['Zero reaction. Which, honestly, might be the most spiritually advanced response here.'],
      ['Somehow still the calmest creature at this entire event.'],
    ],
  },
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
    ],
  },
  // volatile gasses — green/red/yellow mapped to Locust/Bow and Arrow/Crown.
  // VISIBLE_PEOPLE_BY_TYPE[2] = 6, so only 4 ambient slots — these 3 pools
  // deliberately hold more than 4 entries each; FateEventSystem's random
  // per-play offset means which 4 actually show up varies loop to loop
  // instead of always the same first 4.
  Locust: {
    entries: [
      ['That comet brought locusts upon us!'],
      ['Where did all these locusts come from??'],
      ['The comet brought these locusts upon us!!'],
      ['i HATE locusts'],
      ['The locusts showed up right on schedule, like every year, but sure, blame the comet.'],
      ["We've named the swarm after you. You're welcome."],
      ['In fairness, the locusts do seem extra confident this year.'],
      ['I HATE locusts and I will absolutely take it out on a passing rock.'],
    ],
    color: [0.35, 0.85, 0.4],
  },
  'Bow and Arrow': {
    entries: [
      ['That comet was the bringer of death and war!'],
      ['Red comet? THIS MEANS WAR'],
      ['Attack'],
      ['Red sky, so obviously war. We were also just kind of looking for a reason.'],
      ['The comet didn\'t start this. But it makes a great banner.'],
      ["Nothing says 'divine mandate' like a rock that doesn't know we exist."],
      ["We've fought three wars this century and blamed the sky for all of them."],
      ["Attack at dawn. Or whenever. The comet's schedule is unclear."],
    ],
    color: [0.9, 0.15, 0.15],
  },
  Crown: {
    entries: [
      ['That comet brings death to kings! Beware!'],
      ['The comet has brought death to our king!'],
      ['Time for an uprising!'],
      ['This is too much chaos for me'],
      ["The king was already sick. The comet's just getting credit for good timing."],
      ['Nothing like a dying monarchy to make a rock look ominous.'],
      ["We're blaming the comet mostly so nobody blames the guy who poisoned the wine."],
      ["Uprising's scheduled for Tuesday. The comet's invited but not required."],
    ],
    color: [1.0, 0.82, 0.15],
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
      lines: [
        'You remind me of someone..',
        "Actually no, you're taller.",
        "Anyway. Nice comet.",
      ],
    },
    {
      lines: [
        'Are you actually made of stardust, or is that just a brand thing?',
        "Either way I want to come with you.",
        "You're not going to answer that, are you.",
      ],
    },
  ],
  [
    {
      lines: [
        'Welcome to our lush planet. Try not to step on anything.',
        "The harvest hasn't been this good in years. We're crediting you.",
        "Statistically it's probably the rain. But thank you.",
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
        "Okay, a little.",
        "We rebuilt after the locusts. We'll rebuild again. Probably.",
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
