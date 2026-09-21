#!/usr/bin/env node
// Build-time content budget check — catches oversized assets (mesh
// triangle counts, texture dimensions) before they cost a dedicated
// debugging session, the way the 4.4M-triangle undecimated OBJ instanced
// 260x on the comet did (see project memory: "Kometa soul-island perf
// bug"). Static-file analysis only — it can't see per-phase runtime
// particle/point counts (those live in code as constants like
// N_STARDUST/COLLECTIBLE_COUNT, not files), so it's a floor, not a full
// perf gate.
//
// Usage: node scripts/content-budget/check.mjs
// Exits non-zero (and lists every offender) if anything exceeds budget —
// wire into CI (e.g. package.json's `build` script, or a dedicated
// workflow step) once budgets below are tuned to this project's real needs.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.join(projectRoot, 'public');

// First-pass budgets — deliberately generous (a VR scene has room for a lot
// more than a mobile web page), tune down once real per-asset costs are
// known. A single asset exceeding these isn't necessarily wrong (e.g. a
// hero prop meant to fill the whole view) — it's a prompt to check whether
// it's *instanced* (the actual bug class this exists to catch: an
// undecimated mesh multiplied by a large instance count is where a
// reasonable single-instance budget becomes a scene-wide problem).
const BUDGETS = {
  maxTrianglesPerMesh: 50_000,
  maxTextureDimension: 2048, // px, per side
  maxTextureFileBytes: 4 * 1024 * 1024,
};

function walk(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

// Counts triangles by counting 'f ' (face) lines — good enough for a
// budget check (doesn't need to handle every OBJ quirk, just flag "this is
// way too many triangles"). Assumes triangulated or quad faces (quads
// counted as 2 triangles, safe overestimate for anything with more
// vertices per face than that).
function countObjTriangles(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  let triangles = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('f ')) continue;
    const vertCount = line.trim().split(/\s+/).length - 1;
    triangles += Math.max(0, vertCount - 2);
  }
  return triangles;
}

// glTF/GLB: sums every accessor referenced as a primitive's `indices` (each
// index-buffer entry is one triangle vertex reference; /3 gives triangle
// count). Falls back to POSITION accessor count /3 for primitives with no
// index buffer (rare, but valid glTF). Handles both embedded (.gltf, JSON
// text) and binary (.glb, JSON chunk) containers.
function extractGltfJson(filePath) {
  if (filePath.endsWith('.gltf')) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  const buf = fs.readFileSync(filePath);
  // GLB layout: 12-byte header, then chunks of [uint32 length][uint32 type][data].
  // Chunk type 0x4E4F534A = 'JSON'.
  let offset = 12;
  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkType === 0x4e4f534a) {
      return JSON.parse(buf.toString('utf8', chunkStart, chunkStart + chunkLength));
    }
    offset = chunkStart + chunkLength;
  }
  throw new Error('No JSON chunk found in GLB');
}

function countGltfTriangles(filePath) {
  const json = extractGltfJson(filePath);
  const accessors = json.accessors || [];
  let triangles = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue; // 4 = TRIANGLES, the default
      if (prim.indices !== undefined) {
        triangles += Math.floor(accessors[prim.indices].count / 3);
      } else if (prim.attributes?.POSITION !== undefined) {
        triangles += Math.floor(accessors[prim.attributes.POSITION].count / 3);
      }
    }
  }
  return triangles;
}

// Reads just the IHDR chunk (width/height are always the first 8 bytes
// after the 8-byte PNG signature + 4-byte length + 4-byte 'IHDR' type) —
// no need to decode the whole image.
function readPngDimensions(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(24);
  fs.readSync(fd, buf, 0, 24, 0);
  fs.closeSync(fd);
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function main() {
  const findings = [];

  for (const file of walk(publicDir, ['.obj'])) {
    const tris = countObjTriangles(file);
    if (tris > BUDGETS.maxTrianglesPerMesh) {
      findings.push(`${path.relative(projectRoot, file)}: ${tris.toLocaleString()} triangles (budget ${BUDGETS.maxTrianglesPerMesh.toLocaleString()})`);
    }
  }

  for (const file of walk(publicDir, ['.gltf', '.glb'])) {
    try {
      const tris = countGltfTriangles(file);
      if (tris > BUDGETS.maxTrianglesPerMesh) {
        findings.push(`${path.relative(projectRoot, file)}: ${tris.toLocaleString()} triangles (budget ${BUDGETS.maxTrianglesPerMesh.toLocaleString()})`);
      }
    } catch (err) {
      findings.push(`${path.relative(projectRoot, file)}: could not parse (${err.message}) — check manually`);
    }
  }

  for (const file of walk(publicDir, ['.png'])) {
    const dims = readPngDimensions(file);
    const size = fs.statSync(file).size;
    const rel = path.relative(projectRoot, file);
    if (dims && (dims.width > BUDGETS.maxTextureDimension || dims.height > BUDGETS.maxTextureDimension)) {
      findings.push(`${rel}: ${dims.width}x${dims.height}px (budget ${BUDGETS.maxTextureDimension}px per side)`);
    }
    if (size > BUDGETS.maxTextureFileBytes) {
      findings.push(`${rel}: ${(size / 1024 / 1024).toFixed(1)}MB file (budget ${(BUDGETS.maxTextureFileBytes / 1024 / 1024).toFixed(1)}MB)`);
    }
  }

  // FBX (binary or ASCII, not parsed here) — flagged purely by file size as
  // a coarse "worth a manual look" signal, not a triangle count.
  const FBX_SIZE_BUDGET = 8 * 1024 * 1024;
  for (const file of walk(publicDir, ['.fbx'])) {
    const size = fs.statSync(file).size;
    if (size > FBX_SIZE_BUDGET) {
      findings.push(
        `${path.relative(projectRoot, file)}: ${(size / 1024 / 1024).toFixed(1)}MB file (FBX triangle counts aren't parsed by this script — budget here is file size only, ${(FBX_SIZE_BUDGET / 1024 / 1024).toFixed(1)}MB); check manually`,
      );
    }
  }

  if (findings.length === 0) {
    console.log('Content budget check passed — no assets over budget.');
    return;
  }

  console.error(`Content budget check found ${findings.length} asset(s) over budget:\n`);
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    '\nThis alone is not necessarily a bug — check whether the asset is instanced multiple times ' +
      '(that\'s what actually turns a single oversized mesh into a scene-wide perf problem).',
  );
  process.exitCode = 1;
}

main();
