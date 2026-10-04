import { signal, Signal } from '@preact/signals-core';

const STORAGE_KEY = 'kometa:achievements';
const COMBO_STORAGE_KEY = 'kometa:achievement-combos';
const COMETS_STORAGE_KEY = 'kometa:comets-released';

// Every localStorage access goes through these helpers — storage can throw at
// any time (blocked in an embedding iframe, private browsing, quota full),
// and an unlock is called from the middle of gameplay code, so a storage
// failure must only ever cost persistence, never the unlock itself or the
// caller's frame. In-memory signals stay correct for the session either way.
function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function loadCount(key: string): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

function persist(key: string, raw: string | null): void {
  try {
    if (raw !== null) localStorage.setItem(key, raw);
    else localStorage.removeItem(key);
  } catch (err) {
    console.warn(`[achievement-store] couldn't persist ${key} — progress kept for this session only`, err);
  }
}

function persistSet(key: string, value: Set<string> | null): void {
  persist(key, value ? JSON.stringify([...value]) : null);
}

// Persisted, session-independent unlock state — kept separate from
// globals.ts (whose signals reset every boot) since this one deliberately
// doesn't. Any future system can read/write this directly; it isn't owned
// by AchievementSystem.
export const unlockedAchievements: Signal<Set<string>> = signal(loadSet(STORAGE_KEY));

export function isUnlocked(id: string): boolean {
  return unlockedAchievements.value.has(id);
}

// Idempotent. Returns true only if this call actually unlocked something new
// (so callers know whether to fire a notification) — false if it was already
// unlocked. Callable from anywhere, not just AchievementSystem: adding a
// future granular milestone achievement is just calling this with a new id
// from wherever that moment happens, plus one entry in achievement-list.ts.
export function unlockAchievement(id: string): boolean {
  if (unlockedAchievements.value.has(id)) return false;
  const next = new Set(unlockedAchievements.value);
  next.add(id);
  unlockedAchievements.value = next;
  persistSet(STORAGE_KEY, next);
  return true;
}

// Persisted set of "<dominantPebbleType>-<launchChoice>" combos the player
// has actually experienced across separate runs — separate from
// unlockedAchievements since this tracks raw history, not a single unlock
// flag. Drives the 'complete-collection' achievement (see hasAllCombos) once
// all 3 pebble types x 2 launch choices have each been seen at least once.
export const seenCombos: Signal<Set<string>> = signal(loadSet(COMBO_STORAGE_KEY));

export function recordCombo(dominantType: number, choice: 'orbit' | 'launch'): void {
  const key = `${dominantType}-${choice}`;
  if (seenCombos.value.has(key)) return;
  const next = new Set(seenCombos.value);
  next.add(key);
  seenCombos.value = next;
  persistSet(COMBO_STORAGE_KEY, next);
}

// 3 pebble types x 2 launch choices — see recordCombo's own comment.
export function hasAllCombos(): boolean {
  return seenCombos.value.size >= 6;
}

// Lifetime count of comets this player has released (one per run that
// reaches Launch's detach — see OrbitalLaunchSystem). Feeds the VIVERSE
// "comets released" leaderboard via progress-sync.ts. Like the sets above
// it only ever grows, so merging with a cloud copy is just max().
export const cometsReleased: Signal<number> = signal(loadCount(COMETS_STORAGE_KEY));

export function recordCometRelease(): void {
  cometsReleased.value = cometsReleased.value + 1;
  persist(COMETS_STORAGE_KEY, String(cometsReleased.value));
}

// Unions a cloud-saved copy (see progress-sync.ts) into both persisted sets,
// and takes the larger comet count. Both are always safe since none of this
// ever shrinks in normal play, so there's no "which side wins" conflict.
export function mergeProgress(
  achievements: readonly string[],
  combos: readonly string[],
  comets = 0,
): void {
  if (comets > cometsReleased.value) {
    cometsReleased.value = comets;
    persist(COMETS_STORAGE_KEY, String(comets));
  }
  const nextAchievements = new Set([...unlockedAchievements.value, ...achievements]);
  if (nextAchievements.size !== unlockedAchievements.value.size) {
    unlockedAchievements.value = nextAchievements;
    persistSet(STORAGE_KEY, nextAchievements);
  }
  const nextCombos = new Set([...seenCombos.value, ...combos]);
  if (nextCombos.size !== seenCombos.value.size) {
    seenCombos.value = nextCombos;
    persistSet(COMBO_STORAGE_KEY, nextCombos);
  }
}

// Dev/debug utility — wipes persisted unlock state so achievement unlocks
// can be re-triggered/re-tested without waiting on their real conditions.
// When cloud sync is active (see progress-sync.ts) the emptied sets are
// saved to the cloud too, so a reset doesn't get merged right back in.
export function resetAchievements(): void {
  unlockedAchievements.value = new Set();
  persistSet(STORAGE_KEY, null);
  seenCombos.value = new Set();
  persistSet(COMBO_STORAGE_KEY, null);
}
