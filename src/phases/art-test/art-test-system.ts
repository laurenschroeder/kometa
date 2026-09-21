import { createSystem } from '@iwsdk/core';

// Kill switch for the whole dev-only art-comparison sandbox (ArtTestSystem +
// ArtTestVfxSystem + Phase.ArtTest's registration + its dev-menu button) —
// flip back to true to bring it back; nothing else needs to change. See
// index.ts's own use (skips registering/defining the phase entirely, not
// just no-opping it — this sandbox is the single largest file in the
// codebase at 2,500+ lines, so skipping registration avoids paying for it
// at all while it's off) and PhaseMenuSystem's own use (hides/disables the
// now-dead-end "Art Test" button rather than leaving it reachable to
// nothing).
export const ART_TEST_ENABLED = false;

// Ordered to match ArtTestVfxSystem's own variant-building order — index
// here is exactly the index that system toggles visible.
export const ART_TEST_VARIANT_LABELS: readonly string[] = [
  'Stardust — current',
  'Pebbles — current',
  'Pebbles — black + magical haze',
  'Stardust — star illustration (billboarded, sparkle)',
  'Pebbles — OBJ islands (biggest 8, random)',
  'Pebbles — OBJ islands, wiggly',
  'Magic stardust — swept trails',
  'Stardust — organic specks + star shapes',
  'Stardust — blue/green/yellow nebula tones',
  'Pixel CRT glow (moon + galaxy)',
  'Everything — mixture of every other test',
];
export const ART_TEST_VARIANT_COUNT = ART_TEST_VARIANT_LABELS.length;

// Dev-only art-comparison sandbox (see Phase.ArtTest, reachable only from
// PhaseMenuSystem's dev menu) — cycles through ART_TEST_VARIANT_COUNT visual
// treatments of the stardust/pebble fields, right-hand pinch/select to step
// forward and left-hand to step backward (both edge-detected via
// getSelectStart(), same technique PhaseMenuSystem's own tap-count trigger
// uses — a single left pinch here doesn't fight with that gesture, which
// needs 5 in a row within a short window), wrapping at both ends. Pure
// index-tracking here — ArtTestVfxSystem owns building and showing/hiding
// each variant's actual geometry, and reads getVariant() to know which one
// to show.
export class ArtTestSystem extends createSystem({}) {
  private _variant = 0;

  play(): void {
    super.play();
    this._variant = 0;
  }

  update(): void {
    if (this.input.xr.gamepads.right?.getSelectStart()) {
      this._variant = (this._variant + 1) % ART_TEST_VARIANT_COUNT;
    }
    if (this.input.xr.gamepads.left?.getSelectStart()) {
      this._variant = (this._variant - 1 + ART_TEST_VARIANT_COUNT) % ART_TEST_VARIANT_COUNT;
    }
  }

  getVariant(): number {
    return this._variant;
  }
}
