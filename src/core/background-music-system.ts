import { AudioSource, AudioUtils, createSystem, Entity, PlaybackMode } from '@iwsdk/core';
import { getGlobals } from './globals.js';

const VOLUME = 0.3;

// Ambient background music for the whole experience — one non-positional
// (plays from the listener, not a world position) looping track, started
// the moment the player actually starts the game (globals.gameStarted,
// flipped by StartMenuSystem's own pinch-to-start gesture) rather than at
// world boot: browsers require audio playback to originate from a user
// gesture, and that gesture is exactly what flips gameStarted. Always-on,
// never GameDirector-managed — it plays straight through every phase and
// loop of the game, same "no phase owns this" reasoning as
// StarfieldSystem/PebbleCometPresentationSystem.
export class BackgroundMusicSystem extends createSystem({}) {
  private _entity!: Entity;

  init(): void {
    this._entity = this.world.createTransformEntity();
    this._entity.addComponent(AudioSource, {
      src: 'backgroundMusic',
      positional: false,
      loop: true,
      volume: VOLUME,
      playbackMode: PlaybackMode.Ignore,
    });

    this.cleanupFuncs.push(
      getGlobals(this.world).gameStarted.subscribe((started) => {
        if (started) AudioUtils.play(this._entity);
      }),
    );
  }
}
