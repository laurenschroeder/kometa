import { Phase } from './phase.js';
import { PEBBLE_TYPES } from '../phases/pebbles/pebble-type.js';

// Single source of truth for the notification HUD's per-phase blurb + how
// long it stays up — edit copy here, not in ui/notification-hud.uikitml.
export interface NotificationCopy {
  text: string;
  holdSeconds: number;
}

// Every phase gets a sequence (most are one message) — NotificationHudSystem
// queues them, so a multi-entry sequence plays as consecutive messages, each
// fully fading out before the next fades in.
export const NOTIFICATION_COPY: Record<Phase, NotificationCopy[]> = {
  [Phase.Stardust]: [
    { text: 'You are stardust unformed. Gather yourself into being.', holdSeconds: 3.4 },
    { text: 'Move your hand around to collect stardust.', holdSeconds: 3.5 },
    { text: 'The faster you swing, the further you go.', holdSeconds: 3.5 },
  ],
  [Phase.Pebbles]: [
    {
      text: 'Three paths call to you: the dust of souls, the pulse of living things, the violence of raw gasses.',
      holdSeconds: 5.5,
    },
    {
      text: 'What you gather will not just change yourself, but affect other planets you come into contact with.',
      holdSeconds: 5.5,
    },

  ],

  [Phase.Seeding]: [
    {
      text: 'Follow the glowing path around your planets. Linger near each one to seed it with stardust.',
      holdSeconds: 4,
    },
  ],
  [Phase.Constellations]: [
    {
      text: 'Some blinking stars. Let them guide you.',
      holdSeconds: 4,
    },
  ],
  [Phase.FateEvents]: [
    { text: 'The planet you seeded has grown into a world of its own. Go and see what you have made.', holdSeconds: 3.6 },
  ],
  [Phase.Launch]: [
    {
      text: 'You can choose to continue orbiting this planet indefinitely, or fling yourself into space forever.',
      holdSeconds: 4.5,
    },
  ],
  [Phase.Finale]: [
    {
      text: 'What began as scattered dust has become a comet whole — watch it find its place among the stars.',
      holdSeconds: 4.2,
    },
  ],
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
    text: `You've collected so much ${typeName}! Let's go out and show off your new colors.`,
    holdSeconds: 3.5,
  };
}

// Fired by ConstellationsSystem the first time a hand touches a dot on a
// not-yet-started constellation's path.
export function constellationSpottedMessage(name: string): NotificationCopy {
  return {
    text: `The creatures of a nearby planet have spied you near the ${name} constellation…`,
    holdSeconds: 3.5,
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
  Dog: 'A dog runs loose below — has always run loose. Tonight, they say it is chasing your light.',
  Human: 'Two people are parting ways down there, as people always do. Tonight, they blame the comet.',
  Horn: 'The horns were already sounding for the festival. Now they say you are the reason to celebrate.',
  Bird: 'The birds were always going to sing tonight. Now they say it is a song for you.',
  Giraffe: 'The giraffes graze on, same as any other night. Tonight, someone below decided that means something.',
  Tree: 'The trees have swayed like this for a hundred years. Tonight, they say it is because you are watching.',
  Locust: 'The locusts were already coming this season. Tonight, they have found something else to blame.',
  'Bow and Arrow': 'The war was already close to breaking out. Tonight, they have found a banner to rally under.',
  Crown: 'The king was already failing. Tonight, they have found something to blame for it.',
};

export function celestialSymbolMessage(name: string): NotificationCopy {
  const line = CELESTIAL_SYMBOL_LINES[name] ?? `It's been realized, you are the celestial symbol of ${name}.`;
  return { text: line, holdSeconds: 4 };
}

// Fired once by OrbitalLaunchSystem.play() — a retrospective beat right as
// Fate Events ends, summarizing the impact you leave behind. Same "this was
// always their story, you're just in it now" principle as
// celestialSymbolMessage above, but past-tense/retrospective (what gets
// remembered) rather than present-tense (what's happening right now).
// celestialSymbol can be null on a dev-menu skip that never actually traced
// a constellation — falls back to a generic line rather than throwing.
const CIVILIZATION_REFLECTION_LINES: Record<string, string> = {
  Dog: 'Long after you are gone, they will still tell the story of the comet and the dog that chased it into the sky.',
  Human: 'They will tell this story for generations — not of a comet, but of someone who became one with the sky the night you passed.',
  Horn: 'The festival will come again next year, same as always. But in the telling, it will always be the year the comet blessed it.',
  Bird: 'The birds will keep singing long after you are forgotten by everyone but the ones who first heard you in their song.',
  Giraffe: 'Nothing below truly changed because of you. But for one turning of the sky, they watched you the way they watch the tallest, oldest things.',
  Tree: 'The forest will keep growing, root and branch, the way it always has. Somewhere in it now, there is a story about the night the sky bent down.',
  Locust: 'The locusts would have come regardless. But now there is a comet in every telling of that season — easier to blame than the weather.',
  'Bow and Arrow': 'The war was always theirs to fight. You just gave it a sign to rally behind, and they will swear by it for years.',
  Crown: 'The king was always going to fall. But from now on, every version of that story has a comet in the sky above the tower.',
};

export function civilizationReflectionMessage(celestialSymbol: string | null): NotificationCopy {
  const line =
    (celestialSymbol && CIVILIZATION_REFLECTION_LINES[celestialSymbol]) ??
    'Whatever was already unfolding down there will keep unfolding without you. But for one night, they looked up and saw you in it.';
  return { text: line, holdSeconds: 4.5 };
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
    holdSeconds: 4,
  };
}

// Fired once by EndRunMenuSystem after Finale's payoff has had time to read,
// right before its Main-Menu/New-Comet choice panel appears.
export const END_RUN_MESSAGE: NotificationCopy = {
  text: 'Your time with the comet is done.',
  holdSeconds: 3.2,
};

// Fired by OrbitalLaunchSystem the moment the player commits to one of the
// two choice zones — static (no interpolated argument needed), unlike the
// dynamic messages above.
export const ORBIT_COMMIT_MESSAGE: NotificationCopy = {
  text: 'You will stay as a light in their sky, forever watching over the world you shaped.',
  holdSeconds: 3.4,
};
export const UNKNOWN_COMMIT_MESSAGE: NotificationCopy = {
  text: 'You will leave them to carry your story onward without you.',
  holdSeconds: 3.4,
};

// Queued right after the commit message above (same call site) — coaches
// the player to keep swinging the comet, since OrbitalLaunchSystem now
// detaches once real speed is built up rather than on a fixed timer, and
// CometAutopilotSystem carries whatever velocity exists at that instant
// into orbit/launch. One shared sequence for both choices — the physical
// instruction is identical either way.
export const LAUNCH_BUILDUP_SEQUENCE: NotificationCopy[] = [
  { text: 'Swing your comet to build up speed.', holdSeconds: 2 },
  { text: 'Faster!', holdSeconds: 1.8 },
  { text: 'Keep going!', holdSeconds: 1.8 },
];
