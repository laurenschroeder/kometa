import { Phase } from './phase.js';
import { PEBBLE_TYPES } from '../phases/pebbles/pebble-type.js';

// Single source of truth for the notification HUD's per-phase blurb + how
// long it stays up — edit copy here, not in ui/notification-hud.uikitml.
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

// Every phase gets a sequence (most are one message) — NotificationHudSystem
// queues them, so a multi-entry sequence plays as consecutive messages, each
// fully fading out before the next fades in.
export const NOTIFICATION_COPY: Record<Phase, NotificationCopy[]> = {
  [Phase.Stardust]: [
    { text: 'You are stardust unformed. Gather yourself into being.', holdSeconds: 5.4 },
    { text: 'Move your hand around to collect stardust.', holdSeconds: 5.5 },
    { text: 'The faster you swing, the further you go.', holdSeconds: 5.5 },
    {
      text: 'If you want to control the comet with a different hand, simply pinch it with your other hand and it will move over.',
      holdSeconds: 5,
      delaySeconds: 10,
    },
  ],
  [Phase.Pebbles]: [
    {
      text: 'Three paths call to you\nthe blue dust of souls\nthe green pulse of living things\nthe red violence of raw gasses.',
      holdSeconds: 5.5,
      lineColors: [null, PEBBLE_TYPES[0].color, PEBBLE_TYPES[1].color, PEBBLE_TYPES[2].color],
    },
    {
      text: 'What you gather will not just change yourself, but affect other planets you come into contact with.',
      holdSeconds: 5.5,
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
      text: 'A whole society has developed, thanks to the resources you seeded the planet with.',
      holdSeconds: 5.5,
    },
    { text: "What a nice looking planet.", holdSeconds: 3 },
    {
      text: 'Why not visit those nearby stars? The people on the planet seem very interested in them.',
      holdSeconds: 6.5,
    },
  ],
  [Phase.FateEvents]: [
    { text: 'This planet now sees you in a new way. Come meet the people.', holdSeconds: 6.1 },
  ],
  [Phase.Launch]: [
    {
      text: 'You can choose to continue orbiting this planet indefinitely, or fling yourself into space forever.',
      holdSeconds: 7,
    },
  ],
  [Phase.Finale]: [
    {
      text: 'You have spent a lifetime gathering and delivering space dust. You now find your place among the stars.',
      holdSeconds: 6.7,
    },
  ],
  // Dev-only sandbox — no phase-entry blurb; ArtTestSystem shows its own
  // per-variant label via notify() instead.
  [Phase.ArtTest]: [],
};

// Fired by StardustSystem once the tutorial's gather threshold is reached —
// not a phase-entry sequence (see NOTIFICATION_COPY above), a mid-phase,
// win-condition-triggered one, called directly via
// NotificationHudSystem.notify() (same pattern AchievementSystem uses).
export const STARDUST_WIN_SEQUENCE: NotificationCopy[] = [
  { text: 'You have so much stardust!', holdSeconds: 2.8 },
  { text: "Now you're ready to grow even bigger.", holdSeconds: 3 },
  { text: 'But be warned. What you choose to gather next will shape the comet you become.', holdSeconds: 4 },
];

// Pebbles' completion message needs the dominant-type name interpolated in,
// so it can't be a static table entry like the ones above.
export function pebbleCompletionMessage(typeName: string): NotificationCopy {
  return {
    text: `You've collected so many space pebbles, especially ${typeName}! Let's go out and show off your new form.`,
    holdSeconds: 3.5,
  };
}

// Fired by ConstellationsSystem the first time a hand touches a dot on a
// not-yet-started constellation's path.
export function constellationSpottedMessage(name: string): NotificationCopy {
  return {
    text: `The creatures of a nearby planet have spied you near the ${name} constellation…`,
    holdSeconds: 6,
  };
}

// Fired once, the instant a constellation's path is fully traced. Each line
// deliberately does NOT claim the comet caused whatever's happening below —
// the dog running loose, the war already brewing, the king already
// failing — that was always going to happen. What changes is that the
// people below now weave your passing into the story they tell about it;
// they're the ones making the myth, not you. Keyed by the same
// celestialSymbol strings fate-dialogue.ts uses.
const CELESTIAL_SYMBOL_LINES: Record<string, string> = {
  Dog: 'A dog has left the world below. Tonight, they say it is chasing your light.',
  Human: 'Two people are parting ways down there, as people always do. Tonight, they blame the comet.',
  Horn: 'The horns were already sounding for the festival. Now they say you are the reason to celebrate.',
  Bird: 'The birds were always going to sing tonight. Now they say it is a song for you.',
  Giraffe: 'The giraffes graze, same as any other night. Tonight, someone below decided that means something.',
  Tree: 'The trees have swayed like this for a hundred years. Tonight, they say it is because you have passed by.',
  Locust: 'The locusts were already coming this season. Tonight, they have found something else to blame.',
  'Bow and Arrow': 'The war was already close to breaking out. Tonight, they have found a banner to rally under.',
  Crown: 'The king was already failing. Tonight, they have found something to blame for it.',
};

export function celestialSymbolMessage(name: string): NotificationCopy {
  const reveal = `It's been realized, you are the celestial symbol of ${name}.`;
  const flavor = CELESTIAL_SYMBOL_LINES[name];
  // flavor (the "myth" beat) is always followed by the explicit reveal line
  // now, not replaced by it as a missing-flavor fallback — '\n' splits into
  // its own staggered line (see NotificationHudSystem's LINE_STAGGER_
  // SECONDS), same multi-line convention the Pebbles intro uses. holdSeconds
  // bumped from 6.5 to give the second line room to actually be read once
  // it fades in behind the first, when flavor exists.
  const text = flavor ? `${flavor}\n${reveal}` : reveal;
  return { text, holdSeconds: flavor ? 9 : 6.5 };
}

// Fired once by EndRunMenuSystem, right before the "time is done" message —
// a closing name for the comet you shaped, tying its final identity back to
// whichever constellation you became. celestialSymbol can be null on a
// dev-menu skip that never traced one — falls back to the dominant pebble
// type's own name instead.
export function cometNameMessage(dominantType: number, celestialSymbol: string | null): NotificationCopy {
  const name = celestialSymbol ?? PEBBLE_TYPES[dominantType]?.name ?? 'the unnamed';
  return {
    text: `You leave as ${name}, remembered in the sky above the world you touched.`,
    holdSeconds: 6.5,
  };
}

// Fired by FateEventSystem.stop() if the player lingered near one of the
// phase's two featured figures (see fate-dialogue.ts's NAMED_FIGURES_BY_TYPE)
// more than the other — a small personalized callback rather than a generic
// phase-end message. Silent if the player never meaningfully engaged with
// either. Anonymous — the figures no longer carry a display name.
export function farewellMessage(): NotificationCopy {
  return {
    text: "They watch you go, and don't look away.",
    holdSeconds: 5.7,
  };
}

// Fired by OrbitalLaunchSystem the moment the player commits to one of the
// two choice zones — static (no interpolated argument needed), unlike the
// dynamic messages above.
export const ORBIT_COMMIT_MESSAGE: NotificationCopy = {
  text: 'You will stay as a light in their sky, forever watching over the world you shaped.',
  holdSeconds: 5.9,
};
export const UNKNOWN_COMMIT_MESSAGE: NotificationCopy = {
  text: 'You will leave them to carry your story onward without you.',
  holdSeconds: 5.9,
};

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
  { text: 'Swing your comet to build up speed.', holdSeconds: 3 },
  { text: 'Faster!', holdSeconds: 2.5 },
  { text: 'Keep going!', holdSeconds: 2.5 },
];
