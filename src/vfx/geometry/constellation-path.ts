import { Vector3 } from '@iwsdk/core';
import { CONSTELLATION_SHAPES } from '../../phases/constellations/constellation-shapes.js';
import { ConstellationDef } from '../../phases/constellations/constellation-set.js';

// N anchors arced around the big Fate Events planet, offset outward from
// its surface and tilted up so they occupy the upper/side portion of the
// sphere facing the player — leaving the lower/central near-face free for
// Fate Events' people (see fate-event-system.ts's CAP_HALF_ANGLE=28° cap),
// so "constellations rise around the planet" and "people appear on it" read
// as two distinct bands rather than overlapping. Absolute world-space — the
// player doesn't move during this phase, same convention weave-path.ts's
// placePlanets uses for its full-circle ring.
// Exported so callers that need to re-derive an anchor's live position as the
// planet's own radius changes (see ConstellationsVfxSystem's live tracking
// through the Seeding->Constellations->FateEvents transitions) can reuse the
// exact same offset rather than duplicating this number.
export const ANCHOR_SURFACE_OFFSET = 0.3; // clears most constellations' spreadRadius (max 0.58) from the surface
const ANCHOR_AZIMUTH_SPREAD_DEG = 30; // -30/0/+30 around the planet's vertical axis
// Tilted up from "straight at the player" ([0,0,1]) rather than level with
// it — this is what keeps the arc above the people cap instead of sharing it.
const ANCHOR_ELEVATION: [number, number, number] = [0, 0.55, 1];

function rotateAroundY(base: [number, number, number], degrees: number): Vector3 {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return new Vector3(base[0] * cos + base[2] * sin, base[1], -base[0] * sin + base[2] * cos);
}

export function placeConstellationAnchorsAroundPlanet(
  count: number,
  planetCenter: readonly [number, number, number],
  planetRadius: number,
): [number, number, number][] {
  const base = new Vector3(...ANCHOR_ELEVATION).normalize();
  const r = planetRadius + ANCHOR_SURFACE_OFFSET;
  const anchors: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const deg = -ANCHOR_AZIMUTH_SPREAD_DEG + t * (ANCHOR_AZIMUTH_SPREAD_DEG * 2);
    const dir = rotateAroundY([base.x, base.y, base.z], deg);
    anchors.push([
      planetCenter[0] + dir.x * r,
      planetCenter[1] + dir.y * r,
      planetCenter[2] + dir.z * r,
    ]);
  }
  return anchors;
}

// Standard 4-point Catmull-Rom, applied per-axis below. Hand-rolled rather
// than three.js's CatmullRomCurve3 — @iwsdk/core doesn't re-export three's
// Curve classes (checked), and project convention is three types only via
// @iwsdk/core, so this follows weave-path.ts's own precedent of hand-rolling
// path math instead of importing from 'three' directly.
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

// Smoothly interpolates through `points` (its first/last points duplicated
// as phantom endpoints, so the open curve's tangents at the very start/end
// are well-defined), densely resampled into `segments` evenly-u-spaced
// points — used by ConstellationsVfxSystem to trace a smooth curve through a
// constellation's own (now fixed, shape-authored) star positions for the
// ambient "shape traced out" ribbon animation. Not arc-length-corrected
// (unlike the old placeStarsAlongPath this replaced) — that mattered when
// stars needed to land EVENLY along the path; here the star positions are
// already fixed by CONSTELLATION_SHAPES, this is purely for a smooth
// decorative line between them, so plain u-parametrization is enough.
export function sampleSmoothPath(points: readonly Vector3[], segments: number): Vector3[] {
  const padded = [points[0], ...points, points[points.length - 1]];
  const segCount = padded.length - 3;
  const out: Vector3[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const scaled = Math.min(segCount - 1e-6, Math.max(0, u * segCount));
    const seg = Math.floor(scaled);
    const t = scaled - seg;
    const p0 = padded[seg];
    const p1 = padded[seg + 1];
    const p2 = padded[seg + 2];
    const p3 = padded[seg + 3];
    out[i] = new Vector3(
      catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
      catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
      catmullRom1D(p0.z, p1.z, p2.z, p3.z, t),
    );
  }
  return out;
}

export interface ConstellationLayout {
  starPositions: Float32Array; // the shape's own stars — both the visual silhouette AND the touch/trace targets
}

// Embeds def's own named shape (see constellation-shapes.ts —
// CONSTELLATION_SHAPES[def.name], a hand-authored 2D point set, one per
// star) into a flat plane anchored at `anchor`, spanning spreadRadius, and
// oriented perpendicular to awayDir — the same unit direction
// placeConstellationAnchorsAroundPlanet placed this anchor along. `right`/
// `up` are BY CONSTRUCTION perpendicular to awayDir (a cross product), so
// offsetting purely within that plane never changes a star's own distance
// from the planet's center along awayDir — it stays exactly at anchor's own
// distance (planetRadius + ANCHOR_SURFACE_OFFSET), same guarantee the old
// random-hemisphere-scatter version had (no star can ever land inside or
// touch the planet's surface, regardless of spreadRadius or how large the
// planet's own live radius later grows through Leg B), just exact rather
// than probabilistic now that the shape is a flat authored pattern instead
// of a 3D random scatter.
export function generateConstellationLayout(
  def: ConstellationDef,
  anchor: readonly [number, number, number],
  awayDir: Vector3,
): ConstellationLayout {
  const shape = CONSTELLATION_SHAPES[def.name];
  if (!shape) {
    console.warn(`[constellation-path] no CONSTELLATION_SHAPES entry for '${def.name}' — falling back to a single point.`);
    return { starPositions: new Float32Array([anchor[0], anchor[1], anchor[2]]) };
  }
  if (shape.length !== def.starCount) {
    console.warn(
      `[constellation-path] CONSTELLATION_SHAPES['${def.name}'] has ${shape.length} points but starCount is ${def.starCount} — these must match (each point is also a touch/trace target).`,
    );
  }

  const worldUp = new Vector3(0, 1, 0);
  let right = new Vector3().crossVectors(worldUp, awayDir);
  if (right.lengthSq() < 1e-6) right = new Vector3().crossVectors(new Vector3(1, 0, 0), awayDir);
  right.normalize();
  const up = new Vector3().crossVectors(awayDir, right).normalize();

  const [ax, ay, az] = anchor;
  const starPositions = new Float32Array(shape.length * 3);
  for (let i = 0; i < shape.length; i++) {
    const [x, y] = shape[i];
    starPositions[i * 3] = ax + (right.x * x + up.x * y) * def.spreadRadius;
    starPositions[i * 3 + 1] = ay + (right.y * x + up.y * y) * def.spreadRadius;
    starPositions[i * 3 + 2] = az + (right.z * x + up.z * y) * def.spreadRadius;
  }

  return { starPositions };
}
