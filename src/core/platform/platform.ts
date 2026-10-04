// Host-platform seam — everything that differs between where Kometa is
// hosted (VIVERSE today, possibly a plain static host later) lives behind
// this interface, so the rest of the game never imports a host SDK directly.
// Picked at build time via VITE_PLATFORM (set in the deploy workflow); any
// other host gets LOCAL_ONLY, which keeps progress in localStorage alone and
// has no leaderboard.
//
// Analytics and the shared comet counter deliberately are NOT part of this —
// telemetry.ts / community-stats.ts talk to Firebase, which works
// identically on every host.

export interface PlatformUser {
  id: string;
}

// Cloud copy of achievement-store.ts's persisted state. `version` exists so
// a v2 can migrate older saves instead of guessing at their shape.
// cometsReleased was added after v1 shipped, so it's optional — older saves
// simply lack it.
export interface CloudProgress {
  version: 1;
  achievements: string[];
  combos: string[];
  cometsReleased?: number;
}

// Must match the leaderboard's name as configured in VIVERSE Studio (integer,
// sorted descending, update rule "keep highest" — so re-submitting the same
// lifetime total is harmless).
export const COMETS_LEADERBOARD = 'cometsReleased';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  value: number;
}

export interface LeaderboardView {
  entries: LeaderboardEntry[];
  // The current player's own standing — null for guests, or if it couldn't
  // be determined (never treated as an error on its own).
  me: { rank: number; value: number } | null;
  totalCount: number;
}

export interface Platform {
  readonly name: string;
  readonly supportsLogin: boolean;
  readonly supportsLeaderboard: boolean;
  // Resolves the already-signed-in user, or null for a guest. Must never
  // start a login flow itself — see login().
  init(): Promise<PlatformUser | null>;
  // Starts an interactive sign-in. May redirect/reload the page, so only
  // ever call it from the 2D browser view, never mid-XR-session.
  login(): void;
  // Resolves null ONLY when the cloud definitely has no save yet; rejects
  // whenever it can't tell (no token, network/SDK error). progress-sync.ts
  // relies on that distinction to never blind-overwrite real cloud progress.
  loadProgress(): Promise<CloudProgress | null>;
  saveProgress(progress: CloudProgress): Promise<void>;
  submitScore(leaderboard: string, value: number): Promise<void>;
  // Rejects on any failure, including an unrecognized response format —
  // callers hide the leaderboard entirely rather than showing partial junk.
  getLeaderboard(leaderboard: string, top: number): Promise<LeaderboardView>;
}

const LOCAL_ONLY: Platform = {
  name: 'local',
  supportsLogin: false,
  supportsLeaderboard: false,
  init: async () => null,
  login: () => {},
  loadProgress: async () => null,
  saveProgress: async () => {},
  submitScore: async () => {},
  getLeaderboard: async () => {
    throw new Error('no leaderboard on this platform');
  },
};

// Dynamic import so non-VIVERSE builds never bundle the VIVERSE adapter.
// Never rejects — any failure (e.g. the adapter chunk failing to download)
// degrades to LOCAL_ONLY, so callers don't need their own error handling.
export async function createPlatform(): Promise<Platform> {
  if (import.meta.env.VITE_PLATFORM === 'viverse') {
    const appId = import.meta.env.VITE_VIVERSE_APP_ID as string | undefined;
    if (!appId) {
      console.warn('[platform] VITE_PLATFORM=viverse but VITE_VIVERSE_APP_ID is unset — local-only');
      return LOCAL_ONLY;
    }
    try {
      const { createViversePlatform } = await import('./viverse.js');
      return createViversePlatform(appId);
    } catch (err) {
      console.warn('[platform] VIVERSE adapter failed to load — local-only', err);
      return LOCAL_ONLY;
    }
  }
  return LOCAL_ONLY;
}
