import { BackSide, BufferAttribute, Color, createSystem, Mesh, MeshBasicMaterial, SphereGeometry } from '@iwsdk/core';
import { BLACK, DOME_EQUATOR, DOME_GROUND, DOME_SKY, hexToRgb, HexColor, RGB } from '../vfx/color/color-scheme.js';
import { getGlobals } from './globals.js';

// Radius beyond StarfieldSystem's own shell (SHELL_MAX_RADIUS = 40 there) so
// the starfield always renders in front of this, never poking through.
const SKY_RADIUS = 45;

// hexToRgb() decodes raw sRGB-encoded bytes (e.g. #080e22 -> a small,
// gamma-encoded 0-1 triple) — three.js's renderer treats vertex/material
// colors as LINEAR and re-encodes to sRGB on output, so baking sRGB values
// straight into the vertex-color buffer gets them brightened a second time
// on display (small values especially, which is why this sky's near-black
// navy read as washed-out grey instead of dark). Converting through
// THREE.Color's own sRGB->linear conversion here is what DomeGradient's own
// shader apparently did internally that a plain MeshBasicMaterial does not.
function toLinearRgb(hex: HexColor): RGB {
  const [r, g, b] = hexToRgb(hex);
  const c = new Color(r, g, b).convertSRGBToLinear();
  return [c.r, c.g, c.b];
}

const GROUND_RGB = toLinearRgb(DOME_GROUND);
const EQUATOR_RGB = toLinearRgb(DOME_EQUATOR);
const SKY_RGB = toLinearRgb(DOME_SKY);

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Replaces IWSDK's built-in DomeGradient as the "virtual sky when passthrough
// is off" backdrop. DomeGradient can't be used at all here — this game now
// boots straight into SessionMode.ImmersiveAR (see index.ts), and IWSDK's own
// EnvironmentSystem permanently force-hides DomeGradient/scene.background for
// the life of any AR session regardless of what this app wants. Passthrough
// on/off is instead a purely visual toggle within that one persistent AR
// session (never a session restart — WebXR can't change environmentBlendMode
// mid-session anyway), so this system fully owns its own opaque backdrop mesh
// plus the renderer's clear alpha, both driven off globals.passthroughEnabled.
// Bakes the exact same 3-stop ground/equator/sky gradient DomeGradient used
// to render as per-vertex colors on a plain sphere rather than a runtime
// shader — this backdrop was always deliberately faint (index.ts's own former
// comment), so a baked approximation reads identically without the extra
// complexity of a custom shader. Always-on (never GameDirector-managed),
// same idiom as StarfieldSystem/SkyBackdropSystem.
export class VirtualSkySystem extends createSystem({}) {
  private _mesh!: Mesh;

  init(): void {
    const geometry = new SphereGeometry(SKY_RADIUS, 32, 24);
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
      // Normalized -1..1 vertical position on the sphere, independent of
      // SKY_RADIUS since position.y scales with it — >=0 lerps ground-color
      // equator up to sky, <0 lerps equator down to ground.
      const ny = positions.getY(i) / SKY_RADIUS;
      const rgb = ny >= 0 ? lerp3(EQUATOR_RGB, SKY_RGB, ny) : lerp3(EQUATOR_RGB, GROUND_RGB, -ny);
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));

    // BackSide so the camera (inside the sphere) renders its interior face;
    // fog:false since this IS the backdrop, it shouldn't fade into itself.
    const material = new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    this._mesh = mesh;
    this.world.createTransformEntity(mesh);

    const globals = getGlobals(this.world);
    const applyState = (passthroughEnabled: boolean) => {
      this._mesh.visible = !passthroughEnabled;
      // 0 alpha lets the AR camera feed composite through wherever nothing
      // opaque covers it; 1 is an opaque safety net for whatever this
      // sphere (or anything else) fails to cover when passthrough is off —
      // an app that's never intentionally rendered with alpha < 1 before,
      // so this pairing is the one thing that must never drift apart.
      this.world.renderer.setClearColor(BLACK, passthroughEnabled ? 0 : 1);
    };
    // Subscribe callbacks don't fire for the signal's starting value — apply
    // it once explicitly too, same double-entry-point idiom
    // NotificationHudSystem's own _maybeTriggerBoot already establishes.
    applyState(globals.passthroughEnabled.peek());
    this.cleanupFuncs.push(globals.passthroughEnabled.subscribe(applyState));
  }

  update(): void {
    // Re-centers on the player every frame — same reasoning as
    // StarfieldSystem's own shell-follows-player idiom: a fixed-in-world
    // shell would visibly jump relative to the viewer every time
    // StartMenuSystem._recenterToHead() (or a native WebXR reference-space
    // reset) moves world.player.
    this._mesh.position.copy(this.player.position);
  }
}
