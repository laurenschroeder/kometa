import { signal, Signal } from '@preact/signals-core';
import { cometsReleased, mergeProgress, seenCombos, unlockedAchievements } from './achievement-store.js';
import {
  COMETS_LEADERBOARD,
  createPlatform,
  type LeaderboardView,
  type Platform,
  type PlatformUser,
} from './platform/platform.js';

// Backs achievement-store.ts's localStorage state up to the host platform's
// cloud save (VIVERSE today), and feeds/reads the platform's "comets
// released" leaderboard. localStorage stays the source of truth the game
// reads synchronously at boot — the cloud copy is only ever merged in after
// the fact, so a slow/failed network never delays or breaks play.
//
// Everything stored only ever grows (outside the dev-menu reset), so merging
// is a plain set union / max: no conflicts, nothing lost, and an unflushed
// write when the tab closes just gets picked up from localStorage on the
// next boot.
//
// Never rejects and never throws into gameplay: every platform call is
// caught here, and the change listener below runs inside unlockAchievement()'s
// own signal write — so any failure just means "no cloud sync / no
// leaderboard this session", with localStorage (and the game) carrying on
// untouched.

const SAVE_DEBOUNCE_MS = 2000;
const LEADERBOARD_TOP = 10;
const LEADERBOARD_CACHE_MS = 60000;

// Undefined until the platform has answered — and stays undefined if the
// platform failed to start at all (e.g. the VIVERSE SDK didn't load), since
// there's then no working login to offer. Null for a confirmed guest. Drives
// the 2D sign-in button in index.ts.
export const platformUser: Signal<PlatformUser | null | undefined> = signal(undefined);

// Null until a leaderboard fetch has fully succeeded — and stays null on
// every failure (unsupported host, network, unrecognized response), which
// is what hides the Leaderboard cube/page and the main menu's rank.
export const cometLeaderboard: Signal<LeaderboardView | null> = signal(null);

// One platform instance for the whole app, created on first use — index.ts
// (sign-in button) and StartMenuSystem (leaderboard refresh) both go through
// this rather than each creating their own.
let platformPromise: Promise<Platform> | null = null;
export function getPlatform(): Promise<Platform> {
  platformPromise ??= createPlatform();
  return platformPromise;
}

// Resolves once platform.init() has settled either way — leaderboard reads
// need the SDK loaded (and to know guest vs signed-in) first.
let resolveInitSettled: () => void = () => {};
const initSettled = new Promise<void>((resolve) => (resolveInitSettled = resolve));

let leaderboardFetchedAt = 0;
let leaderboardInFlight: Promise<void> | null = null;

// Refreshes cometLeaderboard. Never rejects. On failure the last good value
// (if any) is kept — a flaky refresh shouldn't make a visible page vanish.
export function refreshLeaderboard(force = false): Promise<void> {
  if (!force && Date.now() - leaderboardFetchedAt < LEADERBOARD_CACHE_MS) return Promise.resolve();
  leaderboardInFlight ??= (async () => {
    try {
      const platform = await getPlatform();
      if (!platform.supportsLeaderboard) return;
      await initSettled;
      const view = await platform.getLeaderboard(COMETS_LEADERBOARD, LEADERBOARD_TOP);
      cometLeaderboard.value = view;
      leaderboardFetchedAt = Date.now();
    } catch (err) {
      console.warn('[progress-sync] leaderboard unavailable', err);
    } finally {
      leaderboardInFlight = null;
    }
  })();
  return leaderboardInFlight;
}

export async function startProgressSync(): Promise<void> {
  let platform: Platform;
  let user: PlatformUser | null;
  try {
    platform = await getPlatform();
    user = await platform.init();
  } catch (err) {
    console.warn('[progress-sync] platform init failed — local-only this session', err);
    resolveInitSettled();
    return;
  }
  platformUser.value = user;
  resolveInitSettled();
  // Guests can still read the leaderboard (guest endpoint) — only writing to
  // it needs a signed-in user.
  void refreshLeaderboard(true);
  if (!user) return;

  let remoteSize = -1;
  let remoteComets = 0;
  try {
    const remote = await platform.loadProgress();
    if (remote) {
      remoteComets = remote.cometsReleased ?? 0;
      mergeProgress(remote.achievements, remote.combos, remoteComets);
      remoteSize = remote.achievements.length + remote.combos.length;
    }
  } catch (err) {
    // Without a successful load we can't tell what's in the cloud, so never
    // write — a blind save would clobber progress from another device.
    console.warn('[progress-sync] cloud load failed — not syncing this session', err);
    return;
  }

  // The leaderboard keeps each player's highest submission, so re-sending
  // the same lifetime total is harmless — this only skips redundant calls.
  let submittedComets = -1;
  const submitScore = () => {
    const comets = cometsReleased.peek();
    if (comets <= 0 || comets === submittedComets) return;
    submittedComets = comets;
    platform
      .submitScore(COMETS_LEADERBOARD, comets)
      .then(() => refreshLeaderboard(true))
      .catch((err) => {
        submittedComets = -1;
        console.warn('[progress-sync] leaderboard submit failed', err);
      });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      platform
        .saveProgress({
          version: 1,
          achievements: [...unlockedAchievements.peek()],
          combos: [...seenCombos.peek()],
          cometsReleased: cometsReleased.peek(),
        })
        .catch((err) => console.warn('[progress-sync] cloud save failed', err));
      submitScore();
    } catch (err) {
      console.warn('[progress-sync] cloud save failed', err);
    }
  };

  // Only push the merged result back if it actually differs from the cloud
  // copy (union ⊇ remote and max ≥ remote, so equal sizes mean identical).
  const localSize = unlockedAchievements.peek().size + seenCombos.peek().size;
  if (localSize !== remoteSize || cometsReleased.peek() !== remoteComets) save();
  else submitScore();

  // Subscribed only after the initial merge, so nothing can ever save a
  // local-only snapshot over cloud progress that hasn't been loaded yet.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  let primed = false;
  const onChange = () => {
    if (!primed) return;
    try {
      schedule();
    } catch (err) {
      console.warn('[progress-sync] failed to schedule cloud save', err);
    }
  };
  unlockedAchievements.subscribe(onChange);
  seenCombos.subscribe(onChange);
  cometsReleased.subscribe(onChange);
  primed = true;
}
