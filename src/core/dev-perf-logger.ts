import { createSystem, Mesh, Vector3 } from '@iwsdk/core';

// One-shot: the instant total scene triangles crosses this, walk the scene
// and log every mesh whose own geometry accounts for a large share — lets an
// agent find which specific mesh a triangle-count spike came from without
// guessing from source alone.
const TRIANGLE_DUMP_THRESHOLD = 100_000;
const PER_MESH_LOG_THRESHOLD = 300;
// TEMP: re-dump periodically instead of once, so a later state (e.g. after
// PlanetGrowthPool's throttled geometry swaps finish landing real plant
// meshes) isn't missed by the original one-shot latch, which fires on the
// FIRST threshold crossing (right as the comet reveals) and never again.
const DUMP_INTERVAL = 5;

// MCP/agent-testing hook — logs frame-time stats to the console every
// LOG_INTERVAL seconds (avg/min/max delta this window, converted to fps)
// so an agent driving the game headlessly via MCP tools can read real
// performance numbers from browser_get_console_logs instead of guessing
// from a screenshot. Same DEV_MENU_ENABLED-style gate as PhaseMenuSystem/
// DevJumpSystem — never active in a production build.
const LOG_INTERVAL = 1;
const PERF_LOG_ENABLED = import.meta.env.DEV;

export class DevPerfLoggerSystem extends createSystem({}) {
  private _windowElapsed = 0;
  private _frameCount = 0;
  private _minDelta = Infinity;
  private _maxDelta = 0;
  private _sumDelta = 0;
  private _dumped = false;
  private _sinceLastDump = 0;

  private _maybeDumpHeavyMeshes(totalTris: number, delta: number): void {
    if (totalTris < TRIANGLE_DUMP_THRESHOLD) return;
    this._sinceLastDump += delta;
    if (this._dumped && this._sinceLastDump < DUMP_INTERVAL) return;
    this._dumped = true;
    this._sinceLastDump = 0;
    const rows: { total: number; text: string }[] = [];
    this.world.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      const geo = mesh.geometry;
      if (!geo) return;
      // Skip anything not actually reachable in the render list — an
      // invisible object (or one under an invisible ancestor) never reaches
      // WebGLRenderer's draw call regardless of its own geometry size, so
      // including it here would misattribute the real triangle cost.
      let effectivelyVisible = true;
      for (let p: typeof obj | null = obj; p; p = p.parent) {
        if (!p.visible) {
          effectivelyVisible = false;
          break;
        }
      }
      if (!effectivelyVisible) return;
      const indexCount = geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0);
      const tris = indexCount / 3;
      if (tris < PER_MESH_LOG_THRESHOLD) return;
      const instances = (mesh as unknown as { count?: number }).count ?? 1;
      const ancestry: string[] = [];
      let p: typeof obj | null = obj;
      for (let depth = 0; p && depth < 14; depth++, p = p.parent) {
        // Unnamed FBX nodes are noise — only keep named ancestors so the
        // chain shows WHICH system/entity owns the mesh, not how deep the
        // file's own node tree is.
        if (p.name) ancestry.push(p.name);
      }
      const kind = (mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh
        ? 'skinned'
        : (mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh
          ? 'instanced'
          : 'mesh';
      const matName = (mesh.material as { name?: string; type?: string } | undefined);
      const total = tris * instances;
      const wp = mesh.getWorldPosition(new Vector3());
      const ws = mesh.getWorldScale(new Vector3());
      rows.push({
        total,
        text: `${ancestry.join(' < ') || '(no named ancestor)'} [${kind}, mat=${matName?.name || matName?.type || '?'}, geo=${geo.name || '?'}, pos=${wp.x.toFixed(2)},${wp.y.toFixed(2)},${wp.z.toFixed(2)} scale=${ws.x.toFixed(3)}] tris=${tris.toFixed(0)} instances=${instances} total=${total.toFixed(0)}`,
      });
    });
    rows.sort((a, b) => b.total - a.total);
    // Full-scene sum (no per-mesh threshold, no visibility filter) — sanity
    // check against info.render.triangles to see whether the gap is about
    // which meshes count, or something outside world.scene entirely (a
    // second render pass, stereo doubling, etc).
    let allVisibleSum = 0;
    let allSum = 0;
    let meshCount = 0;
    this.world.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      const geo = mesh.geometry;
      if (!geo) return;
      meshCount++;
      const indexCount = geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0);
      const instances = (mesh as unknown as { count?: number }).count ?? 1;
      const total = (indexCount / 3) * instances;
      allSum += total;
      let vis = true;
      for (let p: typeof obj | null = obj; p; p = p.parent) {
        if (!p.visible) {
          vis = false;
          break;
        }
      }
      if (vis) allVisibleSum += total;
    });
    console.info(
      `[DevPerf] heavy-mesh dump (renderer-reported=${totalTris}, all-scene-sum=${allSum}, visible-scene-sum=${allVisibleSum}, meshCount=${meshCount}, ${rows.length} meshes >= ${PER_MESH_LOG_THRESHOLD} tris):\n${rows.map((r) => r.text).join('\n')}`,
    );
  }

  update(delta: number): void {
    if (!PERF_LOG_ENABLED) return;
    this._frameCount++;
    this._sumDelta += delta;
    if (delta < this._minDelta) this._minDelta = delta;
    if (delta > this._maxDelta) this._maxDelta = delta;
    this._windowElapsed += delta;

    if (this._windowElapsed >= LOG_INTERVAL) {
      const avgDelta = this._sumDelta / this._frameCount;
      const info = this.world.renderer.info;
      console.info(
        `[DevPerf] avg=${(1 / avgDelta).toFixed(1)}fps (${(avgDelta * 1000).toFixed(2)}ms) ` +
          `worst=${(1 / this._maxDelta).toFixed(1)}fps (${(this._maxDelta * 1000).toFixed(2)}ms) ` +
          `best=${(1 / this._minDelta).toFixed(1)}fps frames=${this._frameCount} ` +
          `calls=${info.render.calls} tris=${info.render.triangles} ` +
          `geoms=${info.memory.geometries} progs=${info.programs?.length ?? 0}`,
      );
      this._maybeDumpHeavyMeshes(info.render.triangles, LOG_INTERVAL);
      this._windowElapsed = 0;
      this._frameCount = 0;
      this._minDelta = Infinity;
      this._maxDelta = 0;
      this._sumDelta = 0;
    }
  }
}
