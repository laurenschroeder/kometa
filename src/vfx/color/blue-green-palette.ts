export function hslToRgb(hueDeg: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hueDeg / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

const HUE_MIN = 130; // green
const HUE_MAX = 230; // blue

// "A huge range of shades of blue and green, neon, pastel, etc" — sweeps hue
// across the blue<->green arc (130deg green through 230deg blue on the
// standard HSL wheel, covering green/teal/cyan/blue) and crosses every hue
// with 3 lightness/saturation treatments — neon (saturated, punchy), pastel
// (light, soft), and a mid "true color" tone — for hueCount * 3 total
// colors. Originally built for the art-test "colored pebbles" variant;
// shared here so production pebble rendering (organic-type glitter body) can
// draw from the exact same spectrum.
export function buildBlueGreenPalette(hueCount = 12): [number, number, number][] {
  return Array.from({ length: hueCount }, (_, i) => {
    const t = hueCount === 1 ? 0 : i / (hueCount - 1);
    const hue = HUE_MIN + t * (HUE_MAX - HUE_MIN);
    return [
      hslToRgb(hue, 0.55, 0.85), // pastel
      hslToRgb(hue, 0.95, 0.55), // neon
      hslToRgb(hue, 0.75, 0.5), // mid "true color" tone
    ];
  }).flat();
}
