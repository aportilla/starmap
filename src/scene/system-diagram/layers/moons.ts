// Moons layer — two Points pools split by angular hemisphere. A moon
// whose angle puts it on the upper half of the parent ring (sin θ > 0)
// goes in the "back" pool (draws under the parent disc); lower-half
// moons go in the "front" pool (draws over the disc). Angles are
// per-planet seeded so the same parent always lays its moons out the
// same way across reloads. Disc geometry + cloud texture come from the
// shared buildBodyDiscGeometry (body-disc.ts) — same packing as planets.

import {
  BufferGeometry, DataTexture, Points, Scene, ShaderMaterial,
} from 'three';
import { BODIES } from '../../../data/stars';
import { makePlanetMaterial } from '../../materials';
import { buildBodyDiscGeometry, setBodyDiscHovered } from './body-disc';
import { disposePool } from './dispose';
import {
  MOON_DISC_BASE, MOON_DISC_MAX, MOON_DISC_MIN, MOON_EDGE_BIAS,
  RENDER_ORDER_BACK_MOON, RENDER_ORDER_FRONT_MOON,
  Z_BACK_MOON, Z_FRONT_MOON, Z_STRIDE,
} from '../layout/constants';
import { discPxFromRadius, type RowSlot } from '../layout/row';
import { writeLightUniforms } from '../lighting';
import { hash32, mulberry32 } from '../geom/prng';
import { pickDiscPool } from '../geom/hit';
import { disableCulling } from '../geom/cull';
import type { DiagramPick, PlanetCenterIndex, StarLightSource } from '../types';

interface MoonSlot {
  // bodyIdx of this moon's parent planet. Layout looks the parent's
  // position up in the PlanetCenterIndex; setHovered + picker don't
  // need it.
  parentBodyIdx: number;
  // bodyIdx of this moon (into BODIES).
  bodyIdx: number;
  // Cached at construction so layout doesn't need to recompute. The
  // host planet's disc never changes size after construction.
  parentR: number;
  // Per-moon disc diameter (px), and per-moon angle around parent.
  discPx: number;
  angle: number;
}

interface MoonPool {
  slots: MoonSlot[];
  geometry: BufferGeometry;
  material: ShaderMaterial;
  points: Points;
  // Per-body cloud-layer texture, kept so dispose() can free it.
  cloudTex: DataTexture | null;
  // bodyIdx → slot index inside this pool. Built at construction so
  // setHovered can locate the moon's BufferAttribute slot in O(1).
  slotByBodyIdx: ReadonlyMap<number, number>;
}

export class MoonsLayer {
  private readonly backPool:  MoonPool | null;
  private readonly frontPool: MoonPool | null;

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    const backSlots:  MoonSlot[] = [];
    const frontSlots: MoonSlot[] = [];
    for (const item of planetItems) {
      const parent = BODIES[item.bodyIdx];
      const Nm = parent.moons.length;
      if (Nm === 0) continue;
      // Pre-compute moon disc sizes so the angle distribution can use
      // real radii for its geometric margins.
      const moonDiscs = parent.moons.map(idx => moonDiscPx(BODIES[idx].radiusEarth));
      const moonRadii = moonDiscs.map(d => d / 2);
      const parentR = item.widthPx / 2;
      const moonAngles = distributeMoonAngles(moonRadii, parentR, parent.id);
      parent.moons.forEach((moonBodyIdx, j) => {
        const angle = moonAngles[j];
        const slot: MoonSlot = {
          parentBodyIdx: item.bodyIdx,
          bodyIdx: moonBodyIdx,
          parentR,
          discPx: moonDiscs[j],
          angle,
        };
        if (Math.sin(angle) > 0) backSlots.push(slot);
        else                     frontSlots.push(slot);
      });
    }

    this.backPool  = backSlots.length  > 0 ? makeMoonPool(backSlots,  RENDER_ORDER_BACK_MOON)  : null;
    this.frontPool = frontSlots.length > 0 ? makeMoonPool(frontSlots, RENDER_ORDER_FRONT_MOON) : null;
    if (this.backPool)  scene.add(this.backPool.points);
    if (this.frontPool) scene.add(this.frontPool.points);
  }

  layout(centers: PlanetCenterIndex): void {
    writePoolPositions(this.backPool,  centers, Z_BACK_MOON);
    writePoolPositions(this.frontPool, centers, Z_FRONT_MOON);
  }

  pickFront(x: number, y: number): DiagramPick | null {
    return pickFromPool(this.frontPool, x, y);
  }

  pickBack(x: number, y: number): DiagramPick | null {
    return pickFromPool(this.backPool, x, y);
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'moon') return;
    // Each moon belongs to exactly one pool; try both.
    for (const pool of [this.frontPool, this.backPool]) {
      if (!pool) continue;
      const slotIdx = pool.slotByBodyIdx.get(pick.bodyIdx);
      if (slotIdx === undefined) continue;
      setBodyDiscHovered(pool.geometry, slotIdx, value);
      return;
    }
  }

  // Same contract as PlanetsLayer.setLightSources — push the current
  // cluster's lights into both pool materials so each moon picks up its
  // own per-fragment lit crescent. Moons sample the same star positions
  // as their host planet; the geometric direction from a moon to a star
  // is essentially identical to the parent's direction (separations are
  // dozens of px, stars are off-screen above), so there's no per-moon
  // light vector to compute.
  setLightSources(lights: readonly StarLightSource[]): void {
    if (this.backPool)  writeLightUniforms(this.backPool.material, lights);
    if (this.frontPool) writeLightUniforms(this.frontPool.material, lights);
  }

  dispose(): void {
    disposePool(this.backPool);
    disposePool(this.frontPool);
  }
}

function pickFromPool(pool: MoonPool | null, x: number, y: number): DiagramPick | null {
  if (!pool) return null;
  const pos = pool.geometry.attributes.position.array as Float32Array;
  return pickDiscPool(
    x, y, pool.slots.length,
    i => pos[i * 3 + 0],
    i => pos[i * 3 + 1],
    i => pool.slots[i].discPx / 2,
    i => ({ kind: 'moon', bodyIdx: pool.slots[i].bodyIdx }),
  );
}

function writePoolPositions(pool: MoonPool | null, centers: PlanetCenterIndex, layerZ: number): void {
  if (!pool) return;
  const out = pool.geometry.attributes.position.array as Float32Array;
  pool.slots.forEach((slot, i) => {
    const parent = centers.get(slot.parentBodyIdx);
    if (!parent) return;
    const D = slot.parentR + MOON_EDGE_BIAS;
    out[i * 3 + 0] = Math.round(parent.cx + Math.cos(slot.angle) * D);
    out[i * 3 + 1] = Math.round(parent.cy + Math.sin(slot.angle) * D);
    out[i * 3 + 2] = parent.rowIdx * Z_STRIDE + layerZ;
  });
  pool.geometry.attributes.position.needsUpdate = true;
}

function moonDiscPx(radiusEarth: number | null): number {
  return discPxFromRadius(radiusEarth, {
    base: MOON_DISC_BASE, min: MOON_DISC_MIN, max: MOON_DISC_MAX, fallback: 0.3,
  });
}

// Procedural moon angle distribution: largest-gap-fill with geometric
// per-pair margins. First moon at a random angle; each subsequent moon
// dropped at a random point inside the current widest gap, with margins
// on each side computed from the actual moon radii of the new placement
// and its left/right neighbors.
//
// Two discs of radius r1, r2 on a ring of radius D are tangent at an
// angular separation of `2 * asin((r1 + r2) / (2D))`. We use that as the
// minimum margin so adjacent moons never visually overlap. The asin
// argument clamps to 1 for the degenerate "oversized moon on a tiny
// parent" case — those fall through to the "ring too crowded" branch
// below and accept some visual overlap.
//
// Determinism: seeded per-planet via the parent's id, identical across
// reloads. Returns angles in the original moon order (matches
// BODIES[parent.moons[j]]).
function distributeMoonAngles(
  moonRadii: readonly number[],
  parentR: number,
  seed: string,
): number[] {
  const N = moonRadii.length;
  if (N === 0) return [];
  const rng = mulberry32(hash32(seed));
  const D = parentR + MOON_EDGE_BIAS;

  interface Placed { angle: number; radius: number; sourceIdx: number }
  const placed: Placed[] = [{
    angle: rng() * Math.PI * 2,
    radius: moonRadii[0],
    sourceIdx: 0,
  }];

  for (let i = 1; i < N; i++) {
    // Walk the sorted angle list once and find the widest gap (wrap-around
    // last → first as a circular gap of length 2π + sorted[0] - last).
    const sorted = [...placed].sort((a, b) => a.angle - b.angle);
    let bestStart = sorted[0];
    let bestEnd   = sorted[0];
    let bestGap   = 0;
    for (let j = 0; j < sorted.length; j++) {
      const startMoon = sorted[j];
      const isLast = j + 1 === sorted.length;
      const endMoon = isLast ? sorted[0] : sorted[j + 1];
      const endAngle = isLast ? endMoon.angle + Math.PI * 2 : endMoon.angle;
      const size = endAngle - startMoon.angle;
      if (size > bestGap) {
        bestGap = size;
        bestStart = startMoon;
        bestEnd = endMoon;
      }
    }

    const rNew = moonRadii[i];
    const leftPad  = 2 * Math.asin(Math.min(1, (rNew + bestStart.radius) / (2 * D)));
    const rightPad = 2 * Math.asin(Math.min(1, (rNew + bestEnd.radius)   / (2 * D)));

    let angle: number;
    if (leftPad + rightPad >= bestGap) {
      // Ring too crowded for non-overlapping placement — drop at gap
      // center and accept the visual overlap. Happens when a parent has
      // many large moons relative to its own size.
      angle = bestStart.angle + bestGap * 0.5;
    } else {
      angle = bestStart.angle + leftPad + rng() * (bestGap - leftPad - rightPad);
    }
    placed.push({ angle, radius: rNew, sourceIdx: i });
  }

  const out: number[] = new Array(N);
  for (const p of placed) out[p.sourceIdx] = p.angle;
  return out;
}

// Build a Points geometry for one moon pool. Colors/sizes pulled from
// each moon's body record via slot.bodyIdx; positions left zeroed and
// rewritten in layout() once parent positions exist.
function makeMoonPool(slots: MoonSlot[], renderOrder: number): MoonPool {
  const N = slots.length;
  const { geometry, cloudTex } = buildBodyDiscGeometry(
    slots.map(s => ({ bodyIdx: s.bodyIdx, discPx: s.discPx })),
  );
  const material = makePlanetMaterial(1.0);
  material.uniforms.uCloudLayerData.value = cloudTex;
  material.uniforms.uCloudLayerRows.value = N;
  const points = new Points(geometry, material);
  points.renderOrder = renderOrder;
  // Moon positions move per resize — see disableCulling.
  disableCulling(points);
  const slotByBodyIdx = new Map(slots.map((s, i) => [s.bodyIdx, i]));
  return { slots, geometry, material, points, cloudTex, slotByBodyIdx };
}
