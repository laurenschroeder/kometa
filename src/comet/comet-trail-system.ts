import { createSystem, Entity, Vector3 } from '@iwsdk/core';
import { getGlobals } from '../core/globals.js';
import { Phase } from '../core/phase.js';
import { CometBody } from './comet-body-component.js';
import { CometTrail } from './comet-trail-component.js';

interface TrailBuffer {
  data: Float32Array;
  total: number; // samples * stride
  resetToHand: boolean; // true once the buffer has been snapped to the hand's first real position
}

// Extracted from the original comet-system.ts _pushTrail/_resetTrail —
// maintains a circular history of CometBody positions per entity so
// presentation/vfx systems can sample "how this comet moved recently" to
// build a billowing tail. Buffers are allocated per-entity on query qualify
// and freed on disqualify (a typed array isn't expressible as fixed-width
// component data, so it lives in this Map instead of on CometTrail itself).
export class CometTrailSystem extends createSystem({
  trails: { required: [CometBody, CometTrail] },
}) {
  private _buffers = new Map<number, TrailBuffer>();
  private _pos!: Vector3;

  init(): void {
    this._pos = new Vector3();

    this.queries.trails.subscribe(
      'qualify',
      (entity) => {
        const samples = entity.getValue(CometTrail, 'samples') as number;
        const stride = entity.getValue(CometTrail, 'stride') as number;
        const total = samples * stride;
        this._buffers.set(entity.index, {
          data: new Float32Array(total * 3),
          total,
          resetToHand: false,
        });
      },
      true,
    );

    this.queries.trails.subscribe('disqualify', (entity) => {
      this._buffers.delete(entity.index);
    });

    // Not GameDirector-managed (there's only ever one persistent comet
    // entity for the whole playthrough, see this file's own class comment —
    // it never dis/requalifies on a replay loop), so this has no play() to
    // hook a reset into; same "reset on Phase.Stardust re-entry" idiom
    // StarfieldSystem/SkyBackdropSystem/etc. use for their own always-on
    // state. Without this, a fresh loop's tail starts by whipping in from
    // wherever the PREVIOUS run's comet was last sitting (Finale's orbit/
    // launch position) instead of reading as a clean new comet.
    this.cleanupFuncs.push(
      getGlobals(this.world).gamePhase.subscribe((phase) => {
        if (phase !== Phase.Stardust) return;
        for (const entity of this.queries.trails.entities) {
          const buf = this._buffers.get(entity.index);
          if (!buf) continue;
          const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
          this._pos.fromArray(posView);
          this._resetBuffer(buf, this._pos);
        }
      }),
    );

    this.cleanupFuncs.push(() => this._buffers.clear());
  }

  update(): void {
    for (const entity of this.queries.trails.entities) {
      const buf = this._buffers.get(entity.index);
      if (!buf) continue;

      const posView = entity.getVectorView(CometBody, 'position') as Float32Array;
      this._pos.fromArray(posView);

      const initialized = entity.getValue(CometBody, 'initialized');
      // First real frame of hand tracking: snap the whole trail history to
      // the hand too, so the tail doesn't stretch in from a placeholder
      // (0,0,0) origin default.
      if (initialized && !buf.resetToHand) {
        this._resetBuffer(buf, this._pos);
        buf.resetToHand = true;
      }

      this._pushSample(buf, this._pos);
    }
  }

  private _pushSample(buf: TrailBuffer, pos: Vector3): void {
    const data = buf.data;
    data.copyWithin(3, 0, (buf.total - 1) * 3);
    data[0] = pos.x;
    data[1] = pos.y;
    data[2] = pos.z;
  }

  private _resetBuffer(buf: TrailBuffer, pos: Vector3): void {
    const data = buf.data;
    for (let i = 0; i < buf.total; i++) {
      data[i * 3] = pos.x;
      data[i * 3 + 1] = pos.y;
      data[i * 3 + 2] = pos.z;
    }
  }

  // Exposed for presentation/vfx systems to sample the trail — returns null
  // until the entity has qualified (buffer allocated).
  getBuffer(entity: Entity): Float32Array | null {
    return this._buffers.get(entity.index)?.data ?? null;
  }
}
