import { withTimeout } from '../with-timeout.js';
import type { CloudProgress, LeaderboardEntry, LeaderboardView, Platform, PlatformUser } from './platform.js';

// VIVERSE Login + Storage (Cloud Save) + Leaderboard SDK — see
// https://docs.viverse.com/developer-tools/javascript/javascript-login,
// .../javascript-storage and .../javascript-leaderboard. There's no npm
// package; the SDK is a UMD script that installs globalThis.viverse. Pinned
// so a VIVERSE-side release can't silently change behavior under a live
// build.
const SDK_URL = 'https://www.viverse.com/static-assets/viverse-sdk/1.3.3/index.umd.cjs';
const AUTH_DOMAIN = 'account.htcvive.com';
// Leaderboard API hosts, straight from the leaderboard docs.
const DASHBOARD_BASE_URL = 'https://www.viveport.com/';
const DASHBOARD_COMMUNITY_URL = 'https://www.viverse.com/';
// One key-value entry holding the whole CloudProgress blob — setPlayerData
// rather than the versioned save()/getLatest() API, since progress is a
// small always-merged set, not a history worth keeping versions of.
const PROGRESS_KEY = 'kometa-progress';

// The docs don't fully pin down response shapes (getPlayerData's especially),
// so raw responses are logged when the page is opened with ?kometa_debug —
// the first deployed test build is how we find out what they actually are.
const DEBUG = new URLSearchParams(location.search).has('kometa_debug');

// Upper bound on any single SDK step (script load, checkAuth, a storage or
// leaderboard call) — a hung request must never leave anything waiting
// forever. Every failure here surfaces as a rejected promise that the caller
// (progress-sync.ts) catches; nothing in this file is ever on the gameplay
// path.
const SDK_TIMEOUT_MS = 15000;

function sdkCall<T>(work: () => T | Promise<T>, label: string): Promise<T> {
  return withTimeout(work, SDK_TIMEOUT_MS, `VIVERSE ${label}`);
}

interface ViverseAuth {
  access_token: string;
  account_id: string;
  expires_in: number;
}

interface ViverseClient {
  checkAuth(): Promise<ViverseAuth | undefined>;
  loginWithWorlds(options?: { state?: string }): void;
}

interface ViverseCloudSaveClient {
  getPlayerData(key: string, accessToken: string): Promise<unknown>;
  setPlayerData(key: string, value: unknown, accessToken: string): Promise<unknown>;
}

interface ViverseStorage {
  newCloudSaveClient(appId: string): Promise<ViverseCloudSaveClient>;
}

interface LeaderboardQuery {
  name: string;
  range_start: number;
  range_end: number;
  region: 'global';
  time_range: 'alltime';
  around_user: boolean;
}

interface ViverseGameDashboard {
  uploadLeaderboardScore(appId: string, scores: { name: string; value: string }[]): Promise<unknown>;
  getLeaderboard(appId: string, query: LeaderboardQuery): Promise<unknown>;
  getGuestLeaderboard(appId: string, query: LeaderboardQuery): Promise<unknown>;
}

interface ViverseGlobal {
  client: new (options: { clientId: string; domain: string }) => ViverseClient;
  storage: new () => ViverseStorage;
  gameDashboard: new (options: { baseURL: string; communityBaseURL: string; token: string }) => ViverseGameDashboard;
}

function loadSdk(): Promise<ViverseGlobal> {
  const existing = (globalThis as { viverse?: ViverseGlobal }).viverse;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      const v = (globalThis as { viverse?: ViverseGlobal }).viverse;
      if (v) resolve(v);
      else reject(new Error('VIVERSE SDK loaded but globalThis.viverse is missing'));
    };
    script.onerror = () => reject(new Error(`Failed to load VIVERSE SDK from ${SDK_URL}`));
    document.head.appendChild(script);
  });
}

function checkAuth(client: ViverseClient | null): Promise<ViverseAuth | undefined> {
  if (!client) return Promise.resolve(undefined);
  return sdkCall(() => client.checkAuth(), 'checkAuth');
}

// Tolerant of whatever wrapper getPlayerData turns out to use (raw string,
// parsed object, or either nested under value/data) — returns null rather
// than throwing on anything unrecognized; loadProgress() then decides
// whether that null means "empty" or "error" (see looksEmpty).
function parseProgress(raw: unknown, depth = 0): CloudProgress | null {
  if (raw == null || depth > 2) return null;
  if (typeof raw === 'string') {
    try {
      return parseProgress(JSON.parse(raw), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.achievements) && Array.isArray(obj.combos)) {
    const comets = Number(obj.cometsReleased);
    return {
      version: 1,
      achievements: obj.achievements.filter((a): a is string => typeof a === 'string'),
      combos: obj.combos.filter((c): c is string => typeof c === 'string'),
      ...(Number.isFinite(comets) && comets > 0 ? { cometsReleased: Math.floor(comets) } : {}),
    };
  }
  return parseProgress(obj.value ?? obj.data, depth + 1);
}

// What a "nothing saved under this key yet" response could plausibly look
// like — anything else that parseProgress can't read is treated as an
// error, not as empty.
function looksEmpty(raw: unknown): boolean {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return true;
  return ('value' in obj || 'data' in obj) && (obj.value ?? obj.data) == null;
}

interface RankedEntry extends LeaderboardEntry {
  uid: string;
}

// Documented shape is { ranking: [{ uid, name, value, rank }], total_count },
// also tolerated one level down under `data`. Throws on anything else — the
// leaderboard UI is hidden on failure, never shown half-parsed.
function parseLeaderboard(raw: unknown): { entries: RankedEntry[]; totalCount: number } {
  const top = (raw ?? {}) as Record<string, unknown>;
  const obj = (Array.isArray(top.ranking) ? top : (top.data ?? {})) as Record<string, unknown>;
  if (!Array.isArray(obj.ranking)) throw new Error('unrecognized leaderboard format');
  const entries: RankedEntry[] = [];
  for (const item of obj.ranking) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const rank = Number(e.rank);
    const value = Number(e.value);
    if (!Number.isFinite(rank) || !Number.isFinite(value)) continue;
    entries.push({
      rank,
      value,
      name: typeof e.name === 'string' ? e.name : '',
      uid: typeof e.uid === 'string' || typeof e.uid === 'number' ? String(e.uid) : '',
    });
  }
  entries.sort((a, b) => a.rank - b.rank);
  const totalCount = Number(obj.total_count);
  return { entries, totalCount: Number.isFinite(totalCount) ? totalCount : entries.length };
}

export function createViversePlatform(appId: string): Platform {
  let sdk: ViverseGlobal | null = null;
  let client: ViverseClient | null = null;
  let cloudSave: ViverseCloudSaveClient | null = null;
  let accountId: string | null = null;
  let token: string | null = null;
  let tokenExpiresAt = 0;
  // Rebuilt whenever its token changes (refresh, or guest vs signed-in),
  // since the dashboard client takes its token once, at construction.
  let dashboard: ViverseGameDashboard | null = null;
  let dashboardToken: string | null = null;

  // Re-runs checkAuth once the cached token is near expiry — a long session
  // (or a festival headset left on the title screen) can outlive it.
  async function getToken(): Promise<string | null> {
    if (token && Date.now() < tokenExpiresAt) return token;
    const auth = await checkAuth(client);
    if (!auth?.access_token) return (token = null);
    token = auth.access_token;
    tokenExpiresAt = Date.now() + auth.expires_in * 1000 * 0.9;
    return token;
  }

  function getDashboard(t: string): ViverseGameDashboard {
    if (!sdk) throw new Error('VIVERSE SDK not loaded');
    if (!dashboard || dashboardToken !== t) {
      dashboard = new sdk.gameDashboard({
        baseURL: DASHBOARD_BASE_URL,
        communityBaseURL: DASHBOARD_COMMUNITY_URL,
        token: t,
      });
      dashboardToken = t;
    }
    return dashboard;
  }

  return {
    name: 'viverse',
    supportsLogin: true,
    supportsLeaderboard: true,

    async init(): Promise<PlatformUser | null> {
      const loaded = await sdkCall(loadSdk, 'SDK load');
      sdk = loaded;
      client = new loaded.client({ clientId: appId, domain: AUTH_DOMAIN });
      const auth = await checkAuth(client);
      if (DEBUG) console.info('[viverse] checkAuth', auth ? { account_id: auth.account_id, expires_in: auth.expires_in } : auth);
      if (!auth?.access_token) return null;
      token = auth.access_token;
      tokenExpiresAt = Date.now() + auth.expires_in * 1000 * 0.9;
      accountId = auth.account_id;
      // Storage failing is not the same as being signed out — the player
      // still IS signed in (so no sign-in button), there's just no cloud
      // save this session; loadProgress() then rejects and sync stays off.
      try {
        cloudSave = await sdkCall(() => new loaded.storage().newCloudSaveClient(appId), 'storage init');
      } catch (err) {
        console.warn('[viverse] cloud save unavailable this session', err);
      }
      return { id: auth.account_id };
    },

    login(): void {
      try {
        client?.loginWithWorlds();
      } catch (err) {
        console.warn('[viverse] login failed to start', err);
      }
    },

    async loadProgress(): Promise<CloudProgress | null> {
      const t = await getToken();
      if (!cloudSave) throw new Error('cloud save unavailable');
      if (!t) throw new Error('no access token');
      const save = cloudSave;
      const raw = await sdkCall(() => save.getPlayerData(PROGRESS_KEY, t), 'getPlayerData');
      if (DEBUG) console.info('[viverse] getPlayerData raw', raw);
      const progress = parseProgress(raw);
      // Unrecognized-but-present data must NOT read as "no save yet", or
      // sync would overwrite it with local-only progress.
      if (!progress && !looksEmpty(raw)) throw new Error('unrecognized cloud save format');
      return progress;
    },

    async saveProgress(progress: CloudProgress): Promise<void> {
      const t = await getToken();
      if (!cloudSave) throw new Error('cloud save unavailable');
      if (!t) throw new Error('no access token');
      const save = cloudSave;
      const result = await sdkCall(() => save.setPlayerData(PROGRESS_KEY, JSON.stringify(progress), t), 'setPlayerData');
      if (DEBUG) console.info('[viverse] setPlayerData result', result);
    },

    async submitScore(leaderboard: string, value: number): Promise<void> {
      const t = await getToken();
      if (!t) throw new Error('no access token');
      const board = getDashboard(t);
      const result = await sdkCall(
        () => board.uploadLeaderboardScore(appId, [{ name: leaderboard, value: String(value) }]),
        'uploadLeaderboardScore',
      );
      if (DEBUG) console.info('[viverse] uploadLeaderboardScore result', result);
    },

    async getLeaderboard(leaderboard: string, top: number): Promise<LeaderboardView> {
      const query: LeaderboardQuery = {
        name: leaderboard,
        range_start: 0,
        range_end: top,
        region: 'global',
        time_range: 'alltime',
        around_user: false,
      };
      // Guests read through the guest endpoint, with no token of their own.
      const t = accountId ? await getToken() : null;
      const board = getDashboard(t ?? '');
      const raw = await sdkCall(
        () => (t ? board.getLeaderboard(appId, query) : board.getGuestLeaderboard(appId, query)),
        'getLeaderboard',
      );
      if (DEBUG) console.info('[viverse] getLeaderboard raw', raw);
      const { entries, totalCount } = parseLeaderboard(raw);

      // The player's own standing is a bonus — failing to find it just
      // leaves it null, it never fails the whole leaderboard.
      let me: LeaderboardView['me'] = null;
      if (t && accountId) {
        const mine = entries.find((e) => e.uid === accountId);
        if (mine) {
          me = { rank: mine.rank, value: mine.value };
        } else {
          try {
            const aroundRaw = await sdkCall(
              () => board.getLeaderboard(appId, { ...query, range_end: 1, around_user: true }),
              'getLeaderboard (around user)',
            );
            if (DEBUG) console.info('[viverse] getLeaderboard around_user raw', aroundRaw);
            const found = parseLeaderboard(aroundRaw).entries.find((e) => e.uid === accountId);
            if (found) me = { rank: found.rank, value: found.value };
          } catch (err) {
            if (DEBUG) console.warn('[viverse] own rank unavailable', err);
          }
        }
      }

      return {
        entries: entries.slice(0, top).map(({ rank, name, value }) => ({ rank, name, value })),
        me,
        totalCount,
      };
    },
  };
}
