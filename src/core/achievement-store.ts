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

// Dev/debug utility — wipes persisted unlock state so achievement unlocks
// can be re-triggered/re-tested without waiting on their real conditions.
export function resetAchievements(): void {
  unlockedAchievements.value = new Set();
  localStorage.removeItem(STORAGE_KEY);
}
