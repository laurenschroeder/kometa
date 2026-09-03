import { createSystem } from '@iwsdk/core';

// Ordered to match ArtTestVfxSystem's own variant-building order — index
// here is exactly the index that system toggles visible.
export const ART_TEST_VARIANT_LABELS: readonly string[] = [
  'Stardust — current',
  'Pebbles — current',
  'Pebbles — black + magical haze',
  'Pebbles — soul billboards (fabric ghosts)',
  'Stardust — star illustration (billboarded, sparkle)',
  'Pebbles — OBJ islands (biggest 8, random)',
  'Pebbles — black + fabric ghost decal',
  'Magic stardust — swept trails',
];
export const ART_TEST_VARIANT_COUNT = ART_TEST_VARIANT_LABELS.length;

// Dev-only art-comparison sandbox (see Phase.ArtTest, reachable only from
// PhaseMenuSystem's dev menu) — cycles through ART_TEST_VARIANT_COUNT visual
// treatments of the stardust/pebble fields, one right-hand pinch/select at a
// time (edge-detected via getSelectStart(), same technique PhaseMenuSystem's
// own triple-tap trigger uses), wrapping back to the first after the last.
// Pure index-tracking here — ArtTestVfxSystem owns building and showing/
// hiding each variant's actual geometry, and reads getVariant() to know
// which one to show.
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
  }

  getVariant(): number {
    return this._variant;
  }
}
