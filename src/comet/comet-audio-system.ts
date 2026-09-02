import { AudioListener, createSystem, Vector3 } from '@iwsdk/core';
import { CometInteractionSynth } from '../vfx/audio/comet-interaction-synth.js';
import { CometBody } from './comet-body-component.js';
import { CometCaught, CometReleased, CometSnapped } from './comet-event-tags.js';
import { HandAnchor } from './hand-anchor-component.js';

// Comet grab/throw/hand-catch sounds. Always-on, never phase-gated — same
// reasoning as the comet/ mechanic itself (comet-handoff-system.ts et al.):
// this interaction exists throughout nearly every phase, not just one.
// Registered after CometHandoffSystem(9)/CometPhysicsSystem(10) — see
// index.ts — so this frame's tag additions are already in place by the time
// this system's queries evaluate. Reacts to the three one-frame edge tags
// (CometSnapped/CometReleased from CometPhysicsSystem, CometCaught from
// CometHandoffSystem) via query subscribe('qualify', ...), same idiom the
// tags' own comments call out audio for. Own AudioListener, same reason
// every other generative-audio system here has one (IWSDK's AudioSource/
// AudioUtils layer only plays pre-loaded buffers).
export class CometAudioSystem extends createSystem({
  snapped: { required: [CometBody, HandAnchor, CometSnapped] },
  released: { required: [CometBody, HandAnchor, CometReleased] },
  caught: { required: [CometBody, HandAnchor, CometCaught] },
}) {
  private _audioListener!: AudioListener;
  private _synth!: CometInteractionSynth;
  private _scratchPos!: Vector3;

  init(): void {
    this._audioListener = new AudioListener();
    this.player.head.add(this._audioListener);
    this._synth = new CometInteractionSynth();
    this._synth.build(this._audioListener, this.scene);
    this._scratchPos = new Vector3();

    this.queries.snapped.subscribe('qualify', (entity) => {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchPos.fromArray(posView);
      this._synth.playSnap(this._scratchPos);
    });
    this.queries.released.subscribe('qualify', (entity) => {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      const velView = entity.getVectorView(CometBody, 'velocity') as Float32Array;
      this._scratchPos.fromArray(posView);
      const speed = Math.hypot(velView[0], velView[1], velView[2]);
      this._synth.playRelease(this._scratchPos, speed);
    });
    this.queries.caught.subscribe('qualify', (entity) => {
      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._scratchPos.fromArray(posView);
      this._synth.playCatch(this._scratchPos);
    });
  }
}
