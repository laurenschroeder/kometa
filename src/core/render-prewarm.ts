import type { Material, Object3D, Texture, World } from '@iwsdk/core';

// One-time GPU work moved out of gameplay. Profiling a full run on Quest
// showed nearly every remaining frame drop was a FIRST-use cost: a shader
// program linking the first time something new appeared (three.js then
// blocks in getProgramInfoLog/getProgramParameter until it's done), or a
// large texture uploading the first time it was drawn (the comet face
// decals: ~49ms each). Both are paid up front here instead.

// Every texture reachable from a material — standard map slots plus
// ShaderMaterial uniforms (single values or arrays).
function collectTextures(material: Material, out: Set<Texture>): void {
  const consider = (v: unknown) => {
    if (v && typeof v === 'object' && (v as Texture).isTexture) out.add(v as Texture);
  };
  for (const v of Object.values(material)) consider(v);
  const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
  if (uniforms) {
    for (const u of Object.values(uniforms)) {
      if (Array.isArray(u?.value)) u.value.forEach(consider);
      else consider(u?.value);
    }
  }
}

function forEachMaterial(root: Object3D, fn: (m: Material) => void): void {
  root.traverse((obj) => {
    const m = (obj as Object3D & { material?: Material | Material[] }).material;
    if (Array.isArray(m)) m.forEach(fn);
    else if (m) fn(m);
  });
}

// Uploads every texture currently in the scene, plus `extra` ones that
// aren't attached to anything yet (e.g. decals swapped in mid-game).
// Textures render identically in the 2D page and in XR, so this runs during
// the loading screen. Never throws — a failure just leaves that texture to
// upload lazily as before.
export function uploadTextures(world: World, extra: (Texture | null | undefined)[] = []): void {
  try {
    const textures = new Set<Texture>();
    forEachMaterial(world.scene, (m) => collectTextures(m, textures));
    for (const t of extra) if (t) textures.add(t);
    for (const t of textures) world.renderer.initTexture(t);
  } catch (err) {
    console.warn('[prewarm] texture upload failed', err);
  }
}

// Compiles a shader program for every material in the scene — INCLUDING
// objects that are currently hidden until a later phase, which a plain
// renderer.compile() skips (it only walks visible objects).
//
// Must run INSIDE the XR session: IWSDK renders XR with multiview stereo,
// which makes three.js build a different program variant than in the 2D
// page, so programs compiled before entering XR wouldn't be reused. Runs
// once, shortly after the first session starts (while the player is on the
// start menu, before any gameplay).
export function prewarmShadersOnFirstXRSession(world: World): void {
  let done = false;
  world.renderer.xr.addEventListener('sessionstart', () => {
    if (done) return;
    done = true;
    // Give the session a moment to install its multiview render target —
    // compile() picks the program variant from the current render target.
    setTimeout(() => {
      const hidden: Object3D[] = [];
      try {
        world.scene.traverse((obj) => {
          if (!obj.visible) {
            hidden.push(obj);
            obj.visible = true;
          }
        });
        // compileAsync() runs compile() synchronously before its first
        // await, so visibility can be restored immediately below — nothing
        // hidden is ever actually drawn. The returned promise resolves once
        // the GPU has finished linking in the background.
        world.renderer.compileAsync(world.scene, world.camera).catch(() => {});
      } catch (err) {
        console.warn('[prewarm] shader compile failed', err);
      } finally {
        for (const obj of hidden) obj.visible = false;
      }
    }, 500);
  });
}
