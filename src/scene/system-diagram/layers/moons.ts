// Moons layer — two Points pools split by angular hemisphere. A moon
// whose angle puts it on the upper half of the parent ring (sin θ > 0)
// goes in the "back" pool (draws under the parent disc); lower-half
// moons go in the "front" pool (draws over the disc). Angles are
// per-planet seeded so the same parent always lays its moons out the
// same way across reloads.

import { BufferAttribute, BufferGeometry, Points, Scene, ShaderMaterial } from 'three';
import { BODIES } from '../../../data/stars';
import { makePlanetMaterial } from '../../materials';
import { buildDiscPalette, lerpTowardWhite } from '../disc-palette';
import {
  MOON_BRIGHTEN, MOON_DISC_BASE, MOON_DISC_MAX, MOON_DISC_MIN, MOON_EDGE_BIAS,
  RENDER_ORDER_BACK_MOON, RENDER_ORDER_FRONT_MOON,
  Z_BACK_MOON, Z_FRONT_MOON, Z_STRIDE,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import { hash32, mulberry32 } from '../geom/prng';
import type { DiagramPick, PlanetCenterIndex } from '../types';

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
      const attr = pool.geometry.attributes.aHovered as BufferAttribute;
      attr.setX(slotIdx, value);
      attr.needsUpdate = true;
      return;
    }
  }

  dispose(): void {
    this.backPool?.geometry.dispose();
    this.backPool?.material.dispose();
    this.frontPool?.geometry.dispose();
    this.frontPool?.material.dispose();
  }
}

function pickFromPool(pool: MoonPool | null, x: number, y: number): DiagramPick | null {
  if (!pool) return null;
  const pos = pool.geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < pool.slots.length; i++) {
    const slot = pool.slots[i];
    const cx = pos[i * 3 + 0];
    const cy = pos[i * 3 + 1];
    const r = slot.discPx / 2;
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= r * r) {
      return { kind: 'moon', bodyIdx: slot.bodyIdx };
    }
  }
  return null;
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
  const r = radiusEarth ?? 0.3;
  const px = Math.cbrt(Math.max(r, 0.0001)) * MOON_DISC_BASE;
  return Math.max(MOON_DISC_MIN, Math.min(MOON_DISC_MAX, Math.round(px)));
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
  const positions = new Float32Array(N * 3);
  // Packed render metadata: stride 4 = [size, mode, seed, tilt]. See
  // planets.ts for the rationale.
  const renderMeta = new Float32Array(N * 4);
  // Hover flag per moon; flipped to 1 by MoonsLayer.setHovered.
  const hoveredAttr = new Float32Array(N);
  // Procedural-texture inputs — same shape as PlanetsLayer. Every
  // palette entry is lifted toward white by MOON_BRIGHTEN so the moon's
  // rim doesn't merge into a same-class parent at the inner overlap.
  const palette0  = new Float32Array(N * 3);
  const palette1  = new Float32Array(N * 3);
  const palette2  = new Float32Array(N * 3);
  const weights   = new Float32Array(N * 3);
  // Packed coverage scalars: stride 4 = [waterFrac, iceFrac,
  // biomeCoverage, hazeTint].
  const coverageScalars = new Float32Array(N * 4);
  const biomeColors = new Float32Array(N * 3);
  const hazeColors  = new Float32Array(N * 3);
  // Packed atmospheric strokes: stride 2 = [rimWidthPx, cloudDensity].
  const atmoStrokes = new Float32Array(N * 2);
  slots.forEach((slot, i) => {
    const b = BODIES[slot.bodyIdx];
    const disc = buildDiscPalette(b, slot.discPx, c => lerpTowardWhite(c, MOON_BRIGHTEN));
    palette0[i * 3 + 0] = disc.palette[0];
    palette0[i * 3 + 1] = disc.palette[1];
    palette0[i * 3 + 2] = disc.palette[2];
    palette1[i * 3 + 0] = disc.palette[3];
    palette1[i * 3 + 1] = disc.palette[4];
    palette1[i * 3 + 2] = disc.palette[5];
    palette2[i * 3 + 0] = disc.palette[6];
    palette2[i * 3 + 1] = disc.palette[7];
    palette2[i * 3 + 2] = disc.palette[8];
    weights[i * 3 + 0] = disc.weights[0];
    weights[i * 3 + 1] = disc.weights[1];
    weights[i * 3 + 2] = disc.weights[2];
    renderMeta[i * 4 + 0] = slot.discPx;
    renderMeta[i * 4 + 1] = disc.mode;
    renderMeta[i * 4 + 2] = disc.seed;
    renderMeta[i * 4 + 3] = disc.tilt;
    coverageScalars[i * 4 + 0] = disc.waterFrac;
    coverageScalars[i * 4 + 1] = disc.iceFrac;
    coverageScalars[i * 4 + 2] = disc.biomeCoverage;
    coverageScalars[i * 4 + 3] = disc.hazeTint;
    biomeColors[i * 3 + 0] = disc.biomeColor[0];
    biomeColors[i * 3 + 1] = disc.biomeColor[1];
    biomeColors[i * 3 + 2] = disc.biomeColor[2];
    hazeColors[i * 3 + 0] = disc.hazeColor[0];
    hazeColors[i * 3 + 1] = disc.hazeColor[1];
    hazeColors[i * 3 + 2] = disc.hazeColor[2];
    atmoStrokes[i * 2 + 0] = disc.rimWidthPx;
    atmoStrokes[i * 2 + 1] = disc.cloudDensity;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',     new BufferAttribute(positions, 3));
  geometry.setAttribute('aRenderMeta',  new BufferAttribute(renderMeta, 4));
  geometry.setAttribute('aHovered',     new BufferAttribute(hoveredAttr, 1));
  geometry.setAttribute('aPalette0',    new BufferAttribute(palette0, 3));
  geometry.setAttribute('aPalette1',    new BufferAttribute(palette1, 3));
  geometry.setAttribute('aPalette2',    new BufferAttribute(palette2, 3));
  geometry.setAttribute('aWeights',     new BufferAttribute(weights, 3));
  geometry.setAttribute('aCoverageScalars', new BufferAttribute(coverageScalars, 4));
  geometry.setAttribute('aBiomeColor',  new BufferAttribute(biomeColors, 3));
  geometry.setAttribute('aHazeColor',   new BufferAttribute(hazeColors, 3));
  geometry.setAttribute('aAtmoStrokes', new BufferAttribute(atmoStrokes, 2));
  const material = makePlanetMaterial(1.0);
  const points = new Points(geometry, material);
  points.renderOrder = renderOrder;
  // Stale-bounding-sphere workaround — same as planetPoints. Moon
  // positions move per resize; the cached sphere doesn't, so Three.js
  // would eventually cull the whole pool after the points shift outside
  // their original bounds. GPU per-vertex clipping handles anything
  // actually off-screen.
  points.frustumCulled = false;
  const slotByBodyIdx = new Map(slots.map((s, i) => [s.bodyIdx, i]));
  return { slots, geometry, material, points, slotByBodyIdx };
}
