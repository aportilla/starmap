// Belts layer — one shared chunk pool across every belt slot. Chunk
// counts and per-chunk offsets bake at construction so layout only
// translates each cluster around its slot center (no re-roll on resize).

import { BufferAttribute, Scene } from 'three';
import { BODIES } from '../../../data/stars';
import { beltRingColor, bodyIcyness } from '../color-science';
import {
  BELT_CHUNKS_MAX, BELT_CHUNKS_MIN, BELT_CHUNK_SIZES, BELT_HEIGHT_FACTOR,
  BELT_SLOT_WIDTH, PLANET_DISC_MIN, RENDER_ORDER_BELT, Z_BELT,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import {
  bakeBlob, buildChunkPool, sampleBeltChunks, shapesFor, type ChunkPool,
} from './blob';
import { hash32, mulberry32 } from '../geom/prng';
import { bandZ, snapPx } from '../geom/snap';
import { writeLightUniforms } from '../lighting';
import { disposePool } from './dispose';
import type { DiagramPick, StarLightSource } from '../types';

// One belt's footprint inside the shared chunk pool — vertex range +
// the vertical extent used by the picker's bounding-box test.
interface BeltSlot {
  bodyIdx: number;
  // rowSlots index — threaded into the chunk vertex z so this belt's
  // chunks z-stack consistently with its row neighbors.
  rowIdx: number;
  startVertex: number;
  endVertex: number;     // exclusive
  // Pre-baked per-chunk offsets from the belt's slot center. Stable
  // across resizes so re-layout just translates the cluster.
  chunkOffsets: ReadonlyArray<{ dx: number; dy: number }>;
  // Parallel to chunkOffsets — each entry is the OWNING CHUNK's center
  // offset (same value for every vertex of one chunk). On resize the
  // layer translates these to world-space chunk-center coords and
  // writes them into aChunkCenter for the sphere-lighting pass.
  chunkCenterOffsets: ReadonlyArray<{ dx: number; dy: number }>;
  // Slot center in buffer-pixel coords, written by layout() from the
  // row item's cx/cy. Lets the picker bbox-test against the slot
  // without re-walking rowSlots (matches the moon/planet picker shape).
  cx: number;
  cy: number;
  // Bounding box half-extents used by the picker. halfH is clamped to
  // the baked chunk-cluster extent (not the full slot height) so the
  // hit-box bounds the visible scatter rather than the empty sky above
  // and below a tall row.
  halfW: number;
  halfH: number;
}

export class BeltsLayer {
  private readonly pool: ChunkPool<BeltSlot> | null;
  // bodyIdx → BeltSlot ref, so setHovered can iterate the slot's vertex
  // range without scanning pool.slots.
  private readonly slotByBodyIdx: ReadonlyMap<number, BeltSlot>;

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const beltItems = rowSlots.filter(r => r.kind === 'belt');
    if (beltItems.length === 0) {
      this.pool = null;
      this.slotByBodyIdx = new Map();
      return;
    }
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    const largestPlanet = planetItems.reduce((m, r) => Math.max(m, r.widthPx), PLANET_DISC_MIN);
    const heightPx = largestPlanet * BELT_HEIGHT_FACTOR;
    this.pool = buildBeltPool(beltItems.map(r => ({ bodyIdx: r.bodyIdx, rowIdx: r.rowIdx })), heightPx);
    this.slotByBodyIdx = new Map(this.pool.slots.map(s => [s.bodyIdx, s]));
    scene.add(this.pool.mesh);
  }

  // Translate each belt's pre-baked chunk offsets onto the current slot
  // center. No re-randomization on resize — the chunk pattern is stable.
  // Also rewrites aChunkCenter for the sphere-lighting pass: every
  // vertex of a chunk gets the chunk's world-space center, derived
  // from item.cx/cy + the slot-relative chunkCenterOffset. Rounded to
  // integer pixels so the per-fragment gl_FragCoord - vChunkCenter
  // difference lands at clean pixel offsets (matches the planet pass's
  // parity-snap intent at chunk scale).
  layout(rowSlots: readonly RowSlot[]): void {
    if (!this.pool) return;
    const positions    = this.pool.geometry.attributes.position.array as Float32Array;
    const chunkCenters = this.pool.geometry.attributes.aChunkCenter.array as Float32Array;
    let bi = 0;
    for (const item of rowSlots) {
      if (item.kind !== 'belt') continue;
      const slot = this.pool.slots[bi];
      slot.cx = item.cx;
      slot.cy = item.cy;
      const z = bandZ(slot.rowIdx, Z_BELT);
      for (let v = slot.startVertex; v < slot.endVertex; v++) {
        const off    = slot.chunkOffsets[v - slot.startVertex];
        const cOff   = slot.chunkCenterOffsets[v - slot.startVertex];
        positions[v * 3 + 0] = snapPx(item.cx + off.dx);
        positions[v * 3 + 1] = snapPx(item.cy + off.dy);
        positions[v * 3 + 2] = z;
        chunkCenters[v * 2 + 0] = snapPx(item.cx + cOff.dx);
        chunkCenters[v * 2 + 1] = snapPx(item.cy + cOff.dy);
      }
      bi++;
    }
    this.pool.geometry.attributes.position.needsUpdate = true;
    this.pool.geometry.attributes.aChunkCenter.needsUpdate = true;
  }

  // Push the cluster's star positions / colors / intensities into the
  // pool material so the per-chunk sphere-lighting pass picks up the
  // same crescent tint as planets + moons. One material across all
  // belts — they're all lit by the same set of stars.
  setLightSources(lights: readonly StarLightSource[]): void {
    if (!this.pool) return;
    writeLightUniforms(this.pool.material, lights);
  }

  // Bbox test against each belt slot's laid-out center (written by
  // layout()), so the picker needs no rowSlots — same shape as the
  // moon/planet pickers.
  pickAt(x: number, y: number): DiagramPick | null {
    if (!this.pool) return null;
    for (const slot of this.pool.slots) {
      if (Math.abs(x - slot.cx) <= slot.halfW && Math.abs(y - slot.cy) <= slot.halfH) {
        return { kind: 'belt', bodyIdx: slot.bodyIdx };
      }
    }
    return null;
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'belt' || !this.pool) return;
    const slot = this.slotByBodyIdx.get(pick.bodyIdx);
    if (!slot) return;
    const attr = this.pool.geometry.attributes.aHovered as BufferAttribute;
    for (let v = slot.startVertex; v < slot.endVertex; v++) attr.setX(v, value);
    attr.needsUpdate = true;
  }

  dispose(): void {
    disposePool(this.pool);
  }
}

// Extra pixels added around the baked chunk-cluster extent when sizing
// the picker hit-box, so a click landing just outside the outermost
// chunk still selects the belt without re-extending into the empty
// sky the full slot box used to cover.
const BELT_PICK_PAD_PX = 2;

// For each belt, sample N center-weighted non-overlapping chunks via
// sampleBeltChunks, bake each chunk's polygon vertices, and concatenate
// into one indexed triangle mesh. Chunk counts scale log-uniformly with
// belt mass; smallest masses bottom out at BELT_CHUNKS_MIN, largest
// approach BELT_CHUNKS_MAX. Per-belt color and shape library both
// derive from `bodyIcyness` (computed from the resource grid) — icy
// belts read as faceted cyan shards, rocky belts as tan boulders.
function buildBeltPool(
  belts: ReadonlyArray<{ bodyIdx: number; rowIdx: number }>,
  heightPx: number,
): ChunkPool<BeltSlot> {
  const slots: BeltSlot[] = [];
  const positions:    number[] = [];
  const indices:      number[] = [];
  const colors:       number[] = [];
  const hovered:      number[] = [];
  const chunkCenters: number[] = [];
  const chunkSizes:   number[] = [];
  let cursor = 0;
  for (const { bodyIdx, rowIdx } of belts) {
    const belt = BODIES[bodyIdx];
    const rng = mulberry32(hash32(`belt:${belt.id}`));
    const mass = belt.massEarth ?? 0.001;
    const logMass = Math.log10(Math.max(mass, 1e-5));
    const t = Math.max(0, Math.min(1, (logMass + 4) / 3.5));
    const N = Math.round(BELT_CHUNKS_MIN + t * (BELT_CHUNKS_MAX - BELT_CHUNKS_MIN));

    const icyness = bodyIcyness(belt);
    const col = beltRingColor(icyness);
    const halfW = BELT_SLOT_WIDTH / 2;
    const halfH = heightPx / 2;
    const shapes = shapesFor(icyness);
    const chunks = sampleBeltChunks(rng, N, halfW, halfH, BELT_CHUNK_SIZES, shapes);

    // Picker halfH tracks the real chunk scatter, not the full slot box.
    // Chunks cluster near center (Gaussian SD = halfH·CHUNK_CY_SD_FRAC), so
    // a tall slot (sized off the largest planet on the row) leaves empty
    // sky above/below the band that would otherwise still report a hit.
    // Each shape is inscribed in the unit circle, so a chunk reaches at
    // most |cy| + size from center; clamp to that extent plus a small pad.
    let chunkHalfH = 0;
    for (const chunk of chunks) {
      chunkHalfH = Math.max(chunkHalfH, Math.abs(chunk.cy) + chunk.size);
    }
    const pickHalfH = Math.min(halfH, chunkHalfH + BELT_PICK_PAD_PX);

    const slotStart = cursor;
    const offsets:        { dx: number; dy: number }[] = [];
    const centerOffsets:  { dx: number; dy: number }[] = [];
    for (const chunk of chunks) {
      const scratchPos:    number[] = [];
      const scratchCenter: number[] = [];
      const scratchSize:   number[] = [];
      const written = bakeBlob(
        shapes, chunk.shapeIdx, chunk.size, chunk.rotation,
        chunk.cx, chunk.cy,
        scratchPos, indices, colors, hovered,
        scratchCenter, scratchSize,
        col.r, col.g, col.b,
        cursor,
      );
      for (let v = 0; v < written; v++) {
        offsets.push({ dx: scratchPos[v * 3 + 0], dy: scratchPos[v * 3 + 1] });
        centerOffsets.push({ dx: scratchCenter[v * 2 + 0], dy: scratchCenter[v * 2 + 1] });
        positions.push(0, 0, 0);
        chunkCenters.push(0, 0);
        chunkSizes.push(scratchSize[v]);
      }
      cursor += written;
    }
    slots.push({
      bodyIdx, rowIdx,
      startVertex: slotStart,
      endVertex: cursor,
      chunkOffsets: offsets,
      chunkCenterOffsets: centerOffsets,
      cx: 0, cy: 0,   // filled by layout()
      halfW, halfH: pickHalfH,
    });
  }
  return buildChunkPool(
    slots, positions, indices, colors,
    chunkCenters, chunkSizes,
    RENDER_ORDER_BELT,
  );
}
