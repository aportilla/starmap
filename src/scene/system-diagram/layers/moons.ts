// Moons layer — two Points pools split by angular hemisphere. A moon
// whose angle puts it on the upper half of the parent ring (sin θ > 0)
// goes in the "back" pool (draws under the parent disc); lower-half
// moons go in the "front" pool (draws over the disc). Angles are
// per-planet seeded so the same parent always lays its moons out the
// same way across reloads.

import { BufferAttribute, BufferGeometry, Points, Scene, ShaderMaterial } from 'three';
import { BODIES } from '../../../data/stars';
import { makePlanetMaterial } from '../../materials';
import { buildDiscPalette } from '../disc-palette';
import {
  MOON_DISC_BASE, MOON_DISC_MAX, MOON_DISC_MIN, MOON_EDGE_BIAS,
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
      const attr = pool.geometry.attributes.aHazeColor as BufferAttribute;
      attr.setW(slotIdx, value);
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
  // Packed render metadata: stride 4 = [size, hasSurface, seed, tilt].
  // See planets.ts for the rationale.
  const renderMeta = new Float32Array(N * 4);
  // Procedural-texture inputs — same shape as PlanetsLayer.
  // Palette slots widened to vec4 to piggyback merged rim color in .w.
  // See PlanetsLayer.
  const palette0  = new Float32Array(N * 4);
  const palette1  = new Float32Array(N * 4);
  const palette2  = new Float32Array(N * 4);
  // Weights (xyz) + dustiness (w). See PlanetsLayer for the rationale —
  // shader derives dust color from the palette × xyz blend so dustiness
  // is the only per-body dust value we need to send.
  const weights   = new Float32Array(N * 4);
  // Cloud-layer palette + weights — 4 slots (base blend + 3 accents).
  // Packed into 3 vec4 attributes to stay under gl_MaxVertexAttribs:
  // slot 3 RGB rides in the .w channels of slots 0/1/2 and gets
  // reassembled in the vertex shader. See planets.ts.
  const cloudPalette0 = new Float32Array(N * 4);
  const cloudPalette1 = new Float32Array(N * 4);
  const cloudPalette2 = new Float32Array(N * 4);
  const cloudWeights  = new Float32Array(N * 4);
  const surfaceScalars = new Float32Array(N * 4);
  const atmoScalars    = new Float32Array(N * 4);
  const biomeColors = new Float32Array(N * 4);
  // Rim/haze color + per-vertex hover packed as vec4 [r, g, b, hover].
  // See PlanetsLayer for the rationale (attribute-count cap).
  const hazeColors  = new Float32Array(N * 4);
  slots.forEach((slot, i) => {
    const b = BODIES[slot.bodyIdx];
    const disc = buildDiscPalette(b, slot.discPx);
    palette0[i * 4 + 0] = disc.palette[0];
    palette0[i * 4 + 1] = disc.palette[1];
    palette0[i * 4 + 2] = disc.palette[2];
    palette0[i * 4 + 3] = disc.rimColor[0];
    palette1[i * 4 + 0] = disc.palette[3];
    palette1[i * 4 + 1] = disc.palette[4];
    palette1[i * 4 + 2] = disc.palette[5];
    palette1[i * 4 + 3] = disc.rimColor[1];
    palette2[i * 4 + 0] = disc.palette[6];
    palette2[i * 4 + 1] = disc.palette[7];
    palette2[i * 4 + 2] = disc.palette[8];
    palette2[i * 4 + 3] = disc.rimColor[2];
    weights[i * 4 + 0] = disc.weights[0];
    weights[i * 4 + 1] = disc.weights[1];
    weights[i * 4 + 2] = disc.weights[2];
    weights[i * 4 + 3] = disc.dustiness;
    cloudPalette0[i * 4 + 0] = disc.cloudPalette[0];
    cloudPalette0[i * 4 + 1] = disc.cloudPalette[1];
    cloudPalette0[i * 4 + 2] = disc.cloudPalette[2];
    cloudPalette0[i * 4 + 3] = disc.cloudPalette[9];   // slot3.r
    cloudPalette1[i * 4 + 0] = disc.cloudPalette[3];
    cloudPalette1[i * 4 + 1] = disc.cloudPalette[4];
    cloudPalette1[i * 4 + 2] = disc.cloudPalette[5];
    cloudPalette1[i * 4 + 3] = disc.cloudPalette[10];  // slot3.g
    cloudPalette2[i * 4 + 0] = disc.cloudPalette[6];
    cloudPalette2[i * 4 + 1] = disc.cloudPalette[7];
    cloudPalette2[i * 4 + 2] = disc.cloudPalette[8];
    cloudPalette2[i * 4 + 3] = disc.cloudPalette[11];  // slot3.b
    cloudWeights[i * 4 + 0] = disc.cloudWeights[0];
    cloudWeights[i * 4 + 1] = disc.cloudWeights[1];
    cloudWeights[i * 4 + 2] = disc.cloudWeights[2];
    cloudWeights[i * 4 + 3] = disc.cloudWeights[3];
    renderMeta[i * 4 + 0] = slot.discPx;
    renderMeta[i * 4 + 1] = disc.hasSurface ? 1 : 0;
    renderMeta[i * 4 + 2] = disc.seed;
    renderMeta[i * 4 + 3] = disc.tilt;
    surfaceScalars[i * 4 + 0] = disc.waterFrac;
    surfaceScalars[i * 4 + 1] = disc.iceFrac;
    surfaceScalars[i * 4 + 2] = disc.surfaceAge;
    surfaceScalars[i * 4 + 3] = disc.globalness;
    atmoScalars[i * 4 + 0] = disc.cloudCoverage;
    atmoScalars[i * 4 + 1] = disc.cloudStructure;
    atmoScalars[i * 4 + 2] = disc.hazeOpacity;
    atmoScalars[i * 4 + 3] = disc.rimWidthPx;
    biomeColors[i * 4 + 0] = disc.biomeColor[0];
    biomeColors[i * 4 + 1] = disc.biomeColor[1];
    biomeColors[i * 4 + 2] = disc.biomeColor[2];
    biomeColors[i * 4 + 3] = disc.biomeCoverage;
    hazeColors[i * 4 + 0] = disc.hazeColor[0];
    hazeColors[i * 4 + 1] = disc.hazeColor[1];
    hazeColors[i * 4 + 2] = disc.hazeColor[2];
    hazeColors[i * 4 + 3] = 0;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',        new BufferAttribute(positions, 3));
  geometry.setAttribute('aRenderMeta',     new BufferAttribute(renderMeta, 4));
  geometry.setAttribute('aPalette0',       new BufferAttribute(palette0, 4));
  geometry.setAttribute('aPalette1',       new BufferAttribute(palette1, 4));
  geometry.setAttribute('aPalette2',       new BufferAttribute(palette2, 4));
  geometry.setAttribute('aWeights',        new BufferAttribute(weights, 4));
  geometry.setAttribute('aCloudPalette0',  new BufferAttribute(cloudPalette0, 4));
  geometry.setAttribute('aCloudPalette1',  new BufferAttribute(cloudPalette1, 4));
  geometry.setAttribute('aCloudPalette2',  new BufferAttribute(cloudPalette2, 4));
  geometry.setAttribute('aCloudWeights',   new BufferAttribute(cloudWeights, 4));
  geometry.setAttribute('aSurfaceScalars', new BufferAttribute(surfaceScalars, 4));
  geometry.setAttribute('aAtmoScalars',    new BufferAttribute(atmoScalars, 4));
  geometry.setAttribute('aBiomeColor',     new BufferAttribute(biomeColors, 4));
  geometry.setAttribute('aHazeColor',      new BufferAttribute(hazeColors, 4));
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
