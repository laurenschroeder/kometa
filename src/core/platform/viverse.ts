import type { CloudProgress, Platform, PlatformUser } from './platform.js';

// VIVERSE Login + Storage (Cloud Save) SDK — see
// https://docs.viverse.com/developer-tools/javascript/javascript-login and
// .../javascript-storage. There's no npm package; the SDK is a UMD script
// that installs globalThis.viverse. Pinned so a VIVERSE-side release can't
// silently change behavior under a live build.
const SDK_URL = 'https://www.viverse.com/static-assets/viverse-sdk/1.3.3/index.umd.cjs';
const AUTH_DOMAIN = 'account.htcvive.com';
// One key-value entry holding the whole CloudProgress blob — setPlayerData
// rather than the versioned save()/getLatest() API, since progress is a
// small always-merged set, not a history worth keeping versions of.
const PROGRESS_KEY = 'kometa-progress';

// The docs don't publish the response shape of getPlayerData, so this logs
// the raw value when the page is opened with ?kometa_debug — the first
// deployed test build is how we find out what it actually returns.
const DEBUG = new URLSearchParams(location.search).has('kometa_debug');

// Upper bound on any single SDK step (script load, checkAuth, a storage
// call) — a hung request must never leave sync waiting forever. Every
// failure here surfaces as a rejected promise that progress-sync.ts catches;
// nothing in this file is ever on the gameplay path.
const SDK_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`VIVERSE ${label} timed out`)), SDK_TIMEOUT_MS);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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

interface ViverseGlobal {
  client: new (options: { clientId: string; domain: string }) => ViverseClient;
  storage: new () => ViverseStorage;
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
  // Wrapped in an async thunk so a synchronous throw inside the SDK still
  // becomes a rejection instead of escaping.
  return withTimeout((async () => client.checkAuth())(), 'checkAuth');
}

// Tolerant of whatever wrapper getPlayerData turns out to use (raw string,
// parsed object, or either nested under value/data) — returns null rather
// than throwing on anything unrecognized, so a shape surprise degrades to
// "no cloud save yet" instead of breaking boot.
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
    return {
      version: 1,
      achievements: obj.achievements.filter((a): a is string => typeof a === 'string'),
      combos: obj.combos.filter((c): c is string => typeof c === 'string'),
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

export function createViversePlatform(appId: string): Platform {
  let client: ViverseClient | null = null;
  let cloudSave: ViverseCloudSaveClient | null = null;
  let token: string | null = null;
  let tokenExpiresAt = 0;

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

  return {
    name: 'viverse',
    supportsLogin: true,

    async init(): Promise<PlatformUser | null> {
      const viverse = await withTimeout(loadSdk(), 'SDK load');
      client = new viverse.client({ clientId: appId, domain: AUTH_DOMAIN });
      const auth = await checkAuth(client);
      if (DEBUG) console.info('[viverse] checkAuth', auth ? { account_id: auth.account_id, expires_in: auth.expires_in } : auth);
      if (!auth?.access_token) return null;
      token = auth.access_token;
      tokenExpiresAt = Date.now() + auth.expires_in * 1000 * 0.9;
      // Storage failing is not the same as being signed out — the player
      // still IS signed in (so no sign-in button), there's just no cloud
      // save this session; loadProgress() then rejects and sync stays off.
      try {
        cloudSave = await withTimeout(new viverse.storage().newCloudSaveClient(appId), 'storage init');
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
      const raw = await withTimeout((async () => save.getPlayerData(PROGRESS_KEY, t))(), 'getPlayerData');
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
      const result = await withTimeout(
        (async () => save.setPlayerData(PROGRESS_KEY, JSON.stringify(progress), t))(),
        'setPlayerData',
      );
      if (DEBUG) console.info('[viverse] setPlayerData result', result);
    },
  };
}
