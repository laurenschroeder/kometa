import { signal, Signal } from '@preact/signals-core';
import { mergeProgress, seenCombos, unlockedAchievements } from './achievement-store.js';
import type { Platform, PlatformUser } from './platform/platform.js';

// Backs achievement-store.ts's localStorage sets up to the host platform's
// cloud save (VIVERSE today). localStorage stays the source of truth the
// game reads synchronously at boot — the cloud copy is only ever merged in
// after the fact, so a slow/failed network never delays or breaks play.
//
// Both sets only ever grow (outside the dev-menu reset), so merging is a
// plain set union: no conflicts, nothing lost, and an unflushed write when
// the tab closes just gets picked up from localStorage on the next boot.
//
// Never rejects and never throws into gameplay: every platform call is
// caught here, and the change listener below runs inside unlockAchievement()'s
// own signal write — so any failure just means "no cloud sync this session",
// with localStorage (and the game) carrying on untouched.

const SAVE_DEBOUNCE_MS = 2000;

// Undefined until the platform has answered; null for a guest. Drives the
// 2D sign-in button in index.ts.
export const platformUser: Signal<PlatformUser | null | undefined> = signal(undefined);

export async function startProgressSync(platform: Platform): Promise<void> {
  let user: PlatformUser | null;
  try {
    user = await platform.init();
  } catch (err) {
    console.warn('[progress-sync] platform init failed — local-only this session', err);
    platformUser.value = null;
    return;
  }
  platformUser.value = user;
  if (!user) return;

  let remoteSize = -1;
  try {
    const remote = await platform.loadProgress();
    if (remote) {
      mergeProgress(remote.achievements, remote.combos);
      remoteSize = remote.achievements.length + remote.combos.length;
    }
  } catch (err) {
    // Without a successful load we can't tell what's in the cloud, so never
    // write — a blind save would clobber progress from another device.
    console.warn('[progress-sync] cloud load failed — not syncing this session', err);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      platform
        .saveProgress({
          version: 1,
          achievements: [...unlockedAchievements.peek()],
          combos: [...seenCombos.peek()],
        })
        .catch((err) => console.warn('[progress-sync] cloud save failed', err));
    } catch (err) {
      console.warn('[progress-sync] cloud save failed', err);
    }
  };

  // Only push the merged result back if it actually differs from the cloud
  // copy (union ⊇ remote, so a size match means identical).
  const localSize = unlockedAchievements.peek().size + seenCombos.peek().size;
  if (localSize !== remoteSize) save();

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
  primed = true;
}
