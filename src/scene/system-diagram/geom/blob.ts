// Blob/chunk primitives — shape libraries, baking, sampling, and the
// shared indexed-triangle Mesh pool wrapper. Only the belts layer uses
// these now; rings render through a triangle-strip annulus (see
// geom/ring.ts + layers/rings.ts).

import { BufferAttribute, BufferGeometry, Mesh, ShaderMaterial } from 'three';
import { makeBlobMaterial } from '../../materials';

// Two libraries of irregular convex polygon silhouettes — `potato`
// shapes for asteroid + debris chunks (rounded, weathered boulder
// reads), `crystal` shapes for ice chunks (sharp angles, shard reads).
// Each entry is a CCW-ordered vertex list in normalized [-1, 1] space
// inscribed in the unit circle; bakeBlob picks a shape, scales by the
// chunk's size, rotates by a per-chunk angle, then translates onto
// the chunk's center.
//
// Fan-triangulation in bakeBlob requires CCW winding around the
// centroid — keep new shapes that way (or the triangle winding flips
// and the rasterizer may cull them depending on side settings).

// Potato shapes — 6-8 vertices with all radii in [0.7, 1.0] so corners
// stay near the bounding circle and the silhouette reads as a smoothed
// blob rather than a faceted gem.
const POTATO_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // Round-ish hexagon
  [[1.00, 0.05], [0.50, 0.85], [-0.55, 0.82], [-0.95, 0.10], [-0.45, -0.88], [0.60, -0.80]],
  // 7-sided potato
  [[1.00, 0.00], [0.65, 0.78], [-0.15, 0.95], [-0.85, 0.50], [-0.95, -0.30], [-0.30, -0.93], [0.70, -0.75]],
  // Lumpy 8-vert oval (elongated horizontally)
  [[1.00, 0.00], [0.70, 0.55], [0.05, 0.70], [-0.70, 0.45], [-1.00, 0.00], [-0.70, -0.50], [0.05, -0.70], [0.70, -0.55]],
  // Asymmetric 7-vert (top-heavy)
  [[0.95, 0.20], [0.35, 0.95], [-0.55, 0.85], [-0.95, 0.15], [-0.75, -0.60], [0.00, -0.95], [0.80, -0.55]],
  // Squashed potato (7-vert)
  [[1.00, -0.10], [0.55, 0.65], [-0.40, 0.80], [-0.95, 0.30], [-0.85, -0.35], [-0.10, -0.85], [0.75, -0.55]],
  // Round 6-vert
  [[0.95, 0.30], [0.30, 0.95], [-0.65, 0.75], [-0.95, -0.05], [-0.45, -0.85], [0.55, -0.80]],
];

// Crystal shapes — 3-5 vertices, mixed radii (some flats, some sharp
// points) so the silhouette reads as a faceted shard rather than a
// rounded blob. Used by icy-leaning belt chunks (chosen by `shapesFor`
// when bodyIcyness > 0.5).
const CRYSTAL_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // Asymmetric pentagon shard
  [[1.00, 0.00], [0.25, 0.95], [-0.85, 0.25], [-0.40, -0.65], [0.55, -0.70]],
  // Sharp triangle (one tall point)
  [[1.00, -0.40], [0.00, 1.00], [-1.00, -0.30]],
  // Diamond / rhombus
  [[1.00, 0.00], [0.00, 1.00], [-1.00, 0.00], [0.00, -1.00]],
  // Skewed kite (sharp top)
  [[0.85, 0.10], [-0.20, 1.00], [-0.95, -0.15], [-0.10, -0.85]],
  // Quad with one extra-sharp corner
  [[0.95, 0.15], [-0.30, 0.95], [-0.95, -0.10], [-0.15, -0.95]],
  // Narrow shard
  [[1.00, 0.05], [0.45, 0.85], [-0.85, 0.45], [-0.60, -0.55], [0.40, -0.85]],
];

export type ShapeLibrary = ReadonlyArray<ReadonlyArray<readonly [number, number]>>;

// Belt chunks pick a shape library based on icyness: volatile-dominant
// belts read as faceted ice shards (CRYSTAL_SHAPES); rocky-dominant
// belts read as weathered boulders (POTATO_SHAPES). The 0.5 cut is the
// midpoint of the bodyIcyness 0..1 scalar.
export function shapesFor(icyness: number): ShapeLibrary {
  return icyness > 0.5 ? CRYSTAL_SHAPES : POTATO_SHAPES;
}

// Per-chunk spec produced by the position samplers and consumed by
// bakeBlob. Sizes are polygon half-extents; positions are offsets from
// the slot's anchor (belt slot center, or planet center for rings).
export interface ChunkSpec {
  cx: number;
  cy: number;
  size: number;
  shapeIdx: number;
  rotation: number;
}

// Bake one chunk's geometry into the destination arrays. Returns the
// number of vertices written (so the caller can advance its cursor).
// Triangle indices are emitted as a triangle fan rooted at vertex 0 of
// the shape — works correctly for convex polygons, which is all the
// shape libraries contain.
//
// chunkCenterOffsetOut / chunkSizeOut carry the per-vertex chunk
// metadata needed by makeBlobMaterial's sphere-lighting pass — every
// vertex of one chunk shares its chunk's center (CX, CY) and half-
// extent (size), so the fragment shader can reconstruct a local sphere
// normal from gl_FragCoord. chunkCenterOffsetOut stores the SLOT-
// RELATIVE center (the same cx, cy the caller passes in) so the owning
// layer can translate it to world space on every resize without
// rebaking; chunkSizeOut is invariant and stays as-is across resizes.
export function bakeBlob(
  shapes: ShapeLibrary,
  shapeIdx: number,
  size: number,
  rotation: number,
  cx: number, cy: number,
  posOut: number[], idxOut: number[], colorOut: number[], hoverOut: number[],
  chunkCenterOffsetOut: number[], chunkSizeOut: number[],
  r: number, g: number, b: number,
  vertexBase: number,
): number {
  const shape = shapes[shapeIdx];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let i = 0; i < shape.length; i++) {
    const [vx, vy] = shape[i];
    const rx = (vx * cos - vy * sin) * size;
    const ry = (vx * sin + vy * cos) * size;
    posOut.push(cx + rx, cy + ry, 0);
    colorOut.push(r, g, b);
    hoverOut.push(0);
    chunkCenterOffsetOut.push(cx, cy);
    chunkSizeOut.push(size);
  }
  for (let i = 1; i < shape.length - 1; i++) {
    idxOut.push(vertexBase, vertexBase + i, vertexBase + i + 1);
  }
  return shape.length;
}

// Box-Muller normal sample, clamped to ±clamp. Returns a single value
// from N(0, sd); the second normal sample (cos vs sin pair) is
// discarded — cheap for our chunk densities.
export function sampleGaussian(rng: () => number, sd: number, clamp: number): number {
  const u1 = Math.max(rng(), 1e-6);
  const u2 = rng();
  const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(-clamp, Math.min(clamp, g * sd));
}

// Test a candidate (cx, cy, size) against already-placed chunks for
// bounding-circle overlap. Returns true if the candidate collides with
// any prior placement (within sumOfRadii + CHUNK_GAP_PX).
const CHUNK_GAP_PX = 1;
export function overlapsAny(cx: number, cy: number, size: number, placed: ReadonlyArray<ChunkSpec>): boolean {
  for (const p of placed) {
    const dx = cx - p.cx;
    const dy = cy - p.cy;
    const minDist = size + p.size + CHUNK_GAP_PX;
    if (dx * dx + dy * dy < minDist * minDist) return true;
  }
  return false;
}

// Belt chunk sampler — produces N chunks with:
//   - Y biased toward the slot center (Gaussian, SD = halfH/3)
//   - X biased toward the slot center (Gaussian, SD = halfW/2)
//   - Size correlated with proximity to center (bigger near y=0,
//     smaller near ±halfH) — gives the "stretched out, larger toward
//     middle, attenuating with randomness" silhouette
//   - Non-overlapping: each candidate is retried up to CHUNK_PLACE_ATTEMPTS
//     times before being skipped (skipped chunks naturally rarefy the
//     edges where placement is already sparse anyway)
export const CHUNK_PLACE_ATTEMPTS = 10;
export function sampleBeltChunks(
  rng: () => number,
  N: number,
  halfW: number,
  halfH: number,
  sizes: ReadonlyArray<number>,
  shapes: ShapeLibrary,
): ChunkSpec[] {
  const placed: ChunkSpec[] = [];
  for (let i = 0; i < N; i++) {
    let chosen: ChunkSpec | null = null;
    for (let attempt = 0; attempt < CHUNK_PLACE_ATTEMPTS; attempt++) {
      const cy = sampleGaussian(rng, halfH * 0.33, halfH);
      const cx = sampleGaussian(rng, halfW * 0.50, halfW);
      // Size: biased upward when near center. Pick a uniform index,
      // then bias via pow(u, k): k<1 skews toward last (largest), k>1
      // toward first (smallest). centerProx ∈ [0, 1].
      const centerProx = 1 - Math.abs(cy) / Math.max(halfH, 1);
      const k = 2.2 - 1.8 * centerProx;
      const u = rng();
      const sizeIdx = Math.min(sizes.length - 1, Math.floor(Math.pow(u, k) * sizes.length));
      const size = sizes[sizeIdx];
      if (overlapsAny(cx, cy, size, placed)) continue;
      chosen = {
        cx, cy, size,
        shapeIdx: Math.floor(rng() * shapes.length),
        rotation: rng() * Math.PI * 2,
      };
      break;
    }
    if (chosen) placed.push(chosen);
  }
  return placed;
}

// Generic chunk pool — one indexed triangle Mesh shared by N slots
// (belts share the belt pool; back debris rings share the back-ring
// pool; etc.). Each slot occupies a contiguous vertex range plus its
// own contiguous index range; hover writes `aHovered = 1` across the
// vertex range to flip every polygon in the slot to white at once.
export interface ChunkPool<S> {
  slots: S[];
  geometry: BufferGeometry;
  material: ShaderMaterial;
  mesh: Mesh;
}

// Chunk pool builder — wraps the accumulated per-vertex (positions,
// colors, chunk metadata) and per-triangle (indices) arrays into an
// indexed Mesh with makeBlobMaterial. aHovered is allocated zero; the
// owning layer flips it per-slot on hover. aChunkCenter is allocated
// here from the caller's chunkCenterOffsets (slot-relative) — the
// owning layer rewrites it on every resize alongside positions so the
// shader sees world-space chunk centers. aChunkSize is invariant.
export function buildChunkPool<S>(
  slots: S[],
  positions: number[],
  indices: number[],
  colors: number[],
  chunkCenters: number[],
  chunkSizes: number[],
  renderOrder: number,
): ChunkPool<S> {
  const V = positions.length / 3;
  const posArr = new Float32Array(positions);
  const colorArr = new Float32Array(colors);
  const hoverArr = new Float32Array(V);
  const chunkCenterArr = new Float32Array(chunkCenters);
  const chunkSizeArr   = new Float32Array(chunkSizes);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',     new BufferAttribute(posArr, 3));
  geometry.setAttribute('color',        new BufferAttribute(colorArr, 3));
  geometry.setAttribute('aHovered',     new BufferAttribute(hoverArr, 1));
  geometry.setAttribute('aChunkCenter', new BufferAttribute(chunkCenterArr, 2));
  geometry.setAttribute('aChunkSize',   new BufferAttribute(chunkSizeArr, 1));
  // Index width: 16-bit if total vertex count fits, else 32. A system
  // with hundreds of chunks each contributing 4-6 verts can creep past
  // 65 K in pathological cases.
  if (V > 65535) geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  else           geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  const material = makeBlobMaterial();
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  // Three.js computes the bounding sphere from the initial positions
  // and never recomputes it when positions change on resize. Disabling
  // frustum culling sidesteps the stale sphere; per-vertex GPU clipping
  // still discards anything genuinely off-screen.
  mesh.frustumCulled = false;
  return { slots, geometry, material, mesh };
}
