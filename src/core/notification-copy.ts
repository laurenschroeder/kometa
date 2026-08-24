import { Phase } from './phase.js';

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
    { text: "It's time to create your comet.", holdSeconds: 3 },
    { text: 'Move your hand around to collect stardust.', holdSeconds: 3.5 },
    { text: 'The faster you swing, the further you go.', holdSeconds: 3.5 },
  ],
  [Phase.Pebbles]: [
    {
      text: 'The sky is full of soul dust, organic matter, and volatile gasses. Gather what calls to you — whatever you collect the most of will shape your comet.',
      holdSeconds: 4.5,
    },
  ],
  [Phase.Constellations]: [
    {
      text: 'Three constellations rise before you. Trace the path of the one that calls to you.',
      holdSeconds: 4,
    },
  ],
  [Phase.Seeding]: [
    {
      text: 'Follow the glowing path around your planets. Linger near each one to seed it with stardust.',
      holdSeconds: 4,
    },
  ],
  [Phase.FateEvents]: [
    { text: "Brace yourself. Fate has plans for the world you've built.", holdSeconds: 3.2 },
  ],
  [Phase.Launch]: [
    {
      text: 'You can choose to continue orbiting this planet indefinitely, or fling yourself into space forever.',
      holdSeconds: 4.5,
    },
  ],
  [Phase.Finale]: [{ text: 'Watch your comet find its place among the stars.', holdSeconds: 3.6 }],
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

// Fired once, for whichever constellation's path is fully traced first.
export function celestialSymbolMessage(name: string): NotificationCopy {
  return {
    text: `It's been realized, you are the celestial symbol of ${name}.`,
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
  text: 'You will orbit this planet, forever.',
  holdSeconds: 3,
};
export const UNKNOWN_COMMIT_MESSAGE: NotificationCopy = {
  text: 'You will fling yourself into the great unknown.',
  holdSeconds: 3,
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
