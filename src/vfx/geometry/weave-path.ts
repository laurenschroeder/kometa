// N points evenly spaced by angle around a flat horizontal ring. Originally
// paired with this file's own weave-line dot placement (removed — Seeding no
// longer arranges planets in a ring), still reused elsewhere for "N things
// evenly spaced around a point" layouts (e.g. FateEventVfxSystem's ambient
// fire ring).
export function placePlanets(count: number, ringRadius: number, centerY: number): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    out[i * 3] = Math.cos(angle) * ringRadius;
    out[i * 3 + 1] = centerY;
    out[i * 3 + 2] = Math.sin(angle) * ringRadius;
  }
  return out;
}
