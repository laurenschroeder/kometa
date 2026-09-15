import { signal, Signal } from '@preact/signals-core';

const STORAGE_KEY = 'kometa:achievements';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

// Persisted, session-independent unlock state — kept separate from
// globals.ts (whose signals reset every boot) since this one deliberately
// doesn't. Any future system can read/write this directly; it isn't owned
// by AchievementSystem.
export const unlockedAchievements: Signal<Set<string>> = signal(load());

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  return true;
}

const COMBO_STORAGE_KEY = 'kometa:achievement-combos';

function loadCombos(): Set<string> {
  try {
    const raw = localStorage.getItem(COMBO_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

// Persisted set of "<dominantPebbleType>-<launchChoice>" combos the player
// has actually experienced across separate runs — separate from
// unlockedAchievements since this tracks raw history, not a single unlock
// flag. Drives the 'complete-collection' achievement (see hasAllCombos) once
// all 3 pebble types x 2 launch choices have each been seen at least once.
export const seenCombos: Signal<Set<string>> = signal(loadCombos());

export function recordCombo(dominantType: number, choice: 'orbit' | 'launch'): void {
  const key = `${dominantType}-${choice}`;
  if (seenCombos.value.has(key)) return;
  const next = new Set(seenCombos.value);
  next.add(key);
  seenCombos.value = next;
  localStorage.setItem(COMBO_STORAGE_KEY, JSON.stringify([...next]));
}

// 3 pebble types x 2 launch choices — see recordCombo's own comment.
export function hasAllCombos(): boolean {
  return seenCombos.value.size >= 6;
}

// Dev/debug utility — wipes persisted unlock state so achievement unlocks
// can be re-triggered/re-tested without waiting on their real conditions.
export function resetAchievements(): void {
  unlockedAchievements.value = new Set();
  localStorage.removeItem(STORAGE_KEY);
  seenCombos.value = new Set();
  localStorage.removeItem(COMBO_STORAGE_KEY);
}
