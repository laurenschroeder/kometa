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

// Compiling isn't the whole first-use cost: three.js defers each program's
// uniform/attribute location lookup (WebGLProgram's onFirstUse) until the
// first frame it's actually drawn — measured on Quest at 10-14ms per phase
// transition, all on the frame a phase's objects first appear. Calling the
// lazy getters pays it here instead, one program per tick so the prewarm
// itself never stalls a frame by more than one program's worth.
const PROGRAM_SETUP_INTERVAL_MS = 20;

// Even with every program compiled and set up, the first frame an object is
// actually DRAWN still uploads its geometry buffers and builds its vertex
// array object — measured on Quest at ~13ms of each phase-entry frame, since
// a phase's objects all appear on the same frame. This draws every hidden
// object once, during the start menu, with color and depth writes off so
// nothing shows: a few hidden subtrees per frame (each subtree all-or-
// nothing, so a sibling never gets drawn with its real material). Renderables
// whose material is also on something currently visible are left hidden —
// turning off that material's writes would blank the visible object for a
// frame — and simply keep paying their first-draw cost as before.
const DRAW_PREWARM_RENDERABLES_PER_FRAME = 40;

type Renderable = Object3D & { material: Material | Material[]; frustumCulled: boolean };

function isRenderable(obj: Object3D): obj is Renderable {
  return !!(obj as Partial<Renderable>).material && (obj as Object3D & { isLight?: boolean }).isLight !== true;
}

function materialsOf(obj: Renderable): Material[] {
  return Array.isArray(obj.material) ? obj.material : [obj.material];
}

function drawHiddenOnce(world: World): void {
  // Materials on currently drawn objects — never touched (see above).
  const visibleMaterials = new Set<Material>();
  // Maximal hidden subtrees: hidden objects whose ancestors are all visible.
  const roots: Object3D[] = [];
  const collect = (obj: Object3D) => {
    if (!obj.visible) {
      roots.push(obj);
      return;
    }
    if (isRenderable(obj)) for (const m of materialsOf(obj)) visibleMaterials.add(m);
    for (const child of obj.children) collect(child);
  };
  collect(world.scene);

  const scene = world.scene;
  const previousAfterRender = scene.onAfterRender;
  const drawBatch = () => {
    if (roots.length === 0) {
      scene.onAfterRender = previousAfterRender;
      return;
    }
    const flipped: Object3D[] = [];
    const keptHidden: Object3D[] = [];
    const culled: Renderable[] = [];
    const muted = new Map<Material, [boolean, boolean]>();
    let count = 0;
    while (roots.length > 0 && count < DRAW_PREWARM_RENDERABLES_PER_FRAME) {
      roots.pop()!.traverse((obj) => {
        const materials = isRenderable(obj) ? materialsOf(obj) : null;
        if (materials && materials.some((m) => visibleMaterials.has(m))) {
          if (obj.visible) {
            obj.visible = false;
            keptHidden.push(obj);
          }
          return;
        }
        if (!obj.visible) {
          obj.visible = true;
          flipped.push(obj);
        }
        if (!materials) return;
        for (const m of materials) {
          if (!muted.has(m)) {
            muted.set(m, [m.colorWrite, m.depthWrite]);
            m.colorWrite = false;
            m.depthWrite = false;
          }
        }
        const renderable = obj as Renderable;
        if (renderable.frustumCulled) {
          renderable.frustumCulled = false;
          culled.push(renderable);
        }
        count++;
      });
    }
    // Restored right after the one render that draws this batch.
    scene.onAfterRender = (...args) => {
      for (const obj of flipped) obj.visible = false;
      for (const obj of keptHidden) obj.visible = true;
      for (const obj of culled) obj.frustumCulled = true;
      for (const [m, [colorWrite, depthWrite]] of muted) {
        m.colorWrite = colorWrite;
        m.depthWrite = depthWrite;
      }
      previousAfterRender.apply(scene, args);
      scene.onAfterRender = () => {
        scene.onAfterRender = previousAfterRender;
        drawBatch();
      };
    };
  };
  drawBatch();
}

function finishProgramSetup(world: World): void {
  const programs = [...(world.renderer.info.programs ?? [])] as unknown as {
    getUniforms(): unknown;
    getAttributes(): unknown;
  }[];
  const step = () => {
    const program = programs.shift();
    if (!program) return;
    try {
      program.getUniforms();
      program.getAttributes();
    } catch (err) {
      console.warn('[prewarm] program setup failed', err);
    }
    setTimeout(step, PROGRAM_SETUP_INTERVAL_MS);
  };
  step();
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
        world.renderer
          .compileAsync(world.scene, world.camera)
          .then(() => {
            drawHiddenOnce(world);
            finishProgramSetup(world);
          })
          .catch(() => {});
      } catch (err) {
        console.warn('[prewarm] shader compile failed', err);
      } finally {
        for (const obj of hidden) obj.visible = false;
      }
    }, 500);
  });
}
