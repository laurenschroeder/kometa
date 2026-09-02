import { Color, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, World } from '@iwsdk/core';

const POOL_SIZE = 12;
const SCATTER_RADIUS = 0.12; // meters, flat horizontal disc around the anchor
const HOP_HEIGHT = 0.02;
const HOP_RISE_FRACTION = 0.3; // fraction of each locust's own cycle spent airborne
const LOCUST_COLOR = 0.35;

// Locust's ambient swarm ("a bunch of little locusts jumping around") and
// its completion payoff ("the locusts multiply") are the same mechanic —
// revealUpTo() raises how many of the fixed POOL_SIZE locusts are visible,
// called once with a small count for the ambient reveal and again with a
// bigger count on the constellation's completion edge (see
// EarthSituationsVfxSystem). Each visible locust independently hops on its
// own randomized cycle. Not a System — a plain pooled class, same idiom as
// HeartBurstPool/PlanetGrowthPool. Positions are a fixed local offset from
// a live anchor supplied every update() call (same "recompute from the
// planet's current position/radius" technique used everywhere else in this
// phase) rather than a baked world position.
export class LocustPool {
  private _meshes: Mesh[] = [];
  private _offsetX = new Float32Array(POOL_SIZE);
  private _offsetZ = new Float32Array(POOL_SIZE);
  private _hopPhase = new Float32Array(POOL_SIZE);
  private _hopInterval = new Float32Array(POOL_SIZE);
  private _visibleCount = 0;

  build(world: World): void {
    const material = new MeshBasicMaterial({ color: new Color(LOCUST_COLOR, 0.28, 0.12) });
    const geo = new SphereGeometry(0.012, 6, 5);
    geo.scale(1, 0.7, 1.8);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new Mesh(geo, material);
      mesh.visible = false;
      this._meshes.push(mesh);
      world.createTransformEntity(mesh);

      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * SCATTER_RADIUS;
      this._offsetX[i] = Math.cos(angle) * r;
      this._offsetZ[i] = Math.sin(angle) * r;
      this._hopPhase[i] = Math.random();
      this._hopInterval[i] = 0.5 + Math.random() * 0.6;
    }
  }

  revealUpTo(count: number): void {
    const target = Math.min(POOL_SIZE, Math.max(this._visibleCount, count));
    for (let i = this._visibleCount; i < target; i++) this._meshes[i].visible = true;
    this._visibleCount = target;
  }

  update(time: number, anchor: Vector3): void {
    for (let i = 0; i < this._visibleCount; i++) {
      const cycleT = ((time + this._hopPhase[i] * this._hopInterval[i]) % this._hopInterval[i]) / this._hopInterval[i];
      const hop = cycleT < HOP_RISE_FRACTION ? Math.sin((cycleT / HOP_RISE_FRACTION) * Math.PI) * HOP_HEIGHT : 0;
      this._meshes[i].position.set(anchor.x + this._offsetX[i], anchor.y + hop, anchor.z + this._offsetZ[i]);
    }
  }

  reset(): void {
    this._visibleCount = 0;
    for (const mesh of this._meshes) mesh.visible = false;
  }
}
