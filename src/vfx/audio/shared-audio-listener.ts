import { AudioListener } from '@iwsdk/core';
import type { World } from '@iwsdk/core';

// The ONE AudioListener every generative-audio system and synth shares,
// lazily created and parented to player.head on first use.
//
// Why only one: three.js's AudioListener.updateMatrixWorld() pushes the
// head's pose into the browser's single, global WebAudio listener every
// frame — 9 AudioParam.linearRampToValueAtTime() calls per listener. Every
// listener writes the same pose to the same global listener, so extra
// listeners add nothing audible, but each one's 9 ramps per frame pile onto
// the same automation timelines. With one listener per system (11 at the
// time this was introduced) that ramp scheduling alone was over half of all
// main-thread time in a desktop CPU profile, and the bulk of Quest's
// per-frame budget. Sound is unchanged: every listener's own gain node was
// left at its default (no setMasterVolume/filters anywhere), all feeding
// the same destination.
let shared: AudioListener | null = null;

export function getSharedAudioListener(world: World): AudioListener {
  if (!shared) {
    shared = new AudioListener();
    world.player.head.add(shared);
  }
  return shared;
}
