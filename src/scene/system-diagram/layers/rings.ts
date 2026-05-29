// Rings layer — one Mesh per ring per half (back + front), drawn
// through a triangle-strip annulus around the host planet. Both halves
// share one ShaderMaterial per ring; hover flips a single uniform that
// covers the whole annulus.
//
// Composition is read from the ring body's six-resource grid via
// `bodyIcyness`: resVolatiles-dominant rings lerp toward the bright
// Saturn-class palette, rocky-dominant rings lerp toward the dark
// Uranus/Neptune-class palette. The same data drives mining yields,
// so visual character and gameplay attribute can't disagree.

import { BufferAttribute, BufferGeometry, Color, Mesh, Scene, ShaderMaterial } from 'three';
import { BODIES, type Body } from '../../../data/stars';
import {
  BELT_RING_COLOR_ICY, BELT_RING_COLOR_ROCKY,
  bodyIcyness,
  RING_ALPHA_DUSTY, RING_ALPHA_ICY,
} from '../body-palette';
import { makeRingMaterial } from '../../materials';
import {
  RENDER_ORDER_BACK_RING, RENDER_ORDER_FRONT_RING,
  RING_MINOR_OVER_MAJOR, RING_SEGMENTS,
  Z_BACK_RING, Z_FRONT_RING, Z_STRIDE,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import { hitsRing, ringEllipseParams } from '../geom/ring';
import type { DiagramPick, PlanetCenterIndex } from '../types';

interface Ring {
  bodyIdx: number;
  hostBodyIdx: number;
  backMesh: Mesh;
  frontMesh: Mesh;
  backGeometry: BufferGeometry;
  frontGeometry: BufferGeometry;
  // Both halves share a material (the hover state covers the whole
  // ring; toggling one half without the other would look broken).
  material: ShaderMaterial;
  outerR: number;
  innerR: number;
  tiltRad: number;
}

export class RingsLayer {
  private readonly rings: Ring[] = [];
  // bodyIdx → Ring ref, so setHovered can flip the material uniform
  // without scanning rings.
  private readonly ringByBodyIdx: Map<number, Ring> = new Map();

  constructor(scene: Scene, rowSlots: readonly RowSlot[]) {
    const planetItems = rowSlots.filter(r => r.kind === 'planet');
    for (const item of planetItems) {
      const planet = BODIES[item.bodyIdx];
      if (planet.ring == null) continue;
      const ring = BODIES[planet.ring];
      const built = buildRing(ring, planet, planet.ring, item.bodyIdx, item.widthPx);
      this.rings.push(built);
      this.ringByBodyIdx.set(built.bodyIdx, built);
      scene.add(built.backMesh);
      scene.add(built.frontMesh);
    }
  }

  layout(centers: PlanetCenterIndex): void {
    for (const ring of this.rings) {
      const c = centers.get(ring.hostBodyIdx);
      if (!c) continue;
      const baseZ = c.rowIdx * Z_STRIDE;
      ring.backMesh.position.set(c.cx, c.cy, baseZ + Z_BACK_RING);
      ring.frontMesh.position.set(c.cx, c.cy, baseZ + Z_FRONT_RING);
    }
  }

  pickFront(x: number, y: number, centers: PlanetCenterIndex): DiagramPick | null {
    return this.pick(x, y, centers, 'front');
  }

  pickBack(x: number, y: number, centers: PlanetCenterIndex): DiagramPick | null {
    return this.pick(x, y, centers, 'back');
  }

  private pick(x: number, y: number, centers: PlanetCenterIndex, half: 'back' | 'front'): DiagramPick | null {
    for (const ring of this.rings) {
      const c = centers.get(ring.hostBodyIdx);
      if (!c) continue;
      const hit = hitsRing(x, y, {
        hostCx: c.cx, hostCy: c.cy,
        outerR: ring.outerR, innerR: ring.innerR, tiltRad: ring.tiltRad,
      }, half);
      if (hit) return { kind: 'ring', bodyIdx: ring.bodyIdx };
    }
    return null;
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'ring') return;
    const ring = this.ringByBodyIdx.get(pick.bodyIdx);
    if (!ring) return;
    ring.material.uniforms.uHovered.value = value;
  }

  dispose(): void {
    for (const ring of this.rings) {
      ring.backGeometry.dispose();
      ring.frontGeometry.dispose();
      ring.material.dispose();
    }
  }
}

function buildRing(ring: Body, hostPlanet: Body, ringBodyIdx: number, hostBodyIdx: number, hostDiscPx: number): Ring {
  const { innerR, outerR, tiltRad } = ringEllipseParams(ring, hostPlanet, hostDiscPx);
  const t = bodyIcyness(ring);
  const color = new Color().copy(BELT_RING_COLOR_ROCKY).lerp(BELT_RING_COLOR_ICY, t);
  const alpha = RING_ALPHA_DUSTY + (RING_ALPHA_ICY - RING_ALPHA_DUSTY) * t;
  const material = makeRingMaterial(color, alpha);
  const backGeometry  = buildHalfAnnulusGeometry(innerR, outerR, tiltRad, /*upperHalf=*/ true);
  const frontGeometry = buildHalfAnnulusGeometry(innerR, outerR, tiltRad, /*upperHalf=*/ false);
  const backMesh  = new Mesh(backGeometry,  material);
  const frontMesh = new Mesh(frontGeometry, material);
  // renderOrder is a secondary tiebreaker behind z (which the row-item
  // banding does the heavy lifting for); the back-then-planet-then-
  // front sequence keeps tied-z scenarios settling the right way.
  backMesh.renderOrder  = RENDER_ORDER_BACK_RING;
  frontMesh.renderOrder = RENDER_ORDER_FRONT_RING;
  // Geometry vertices live in planet-local coords; layout writes the
  // per-row z into mesh.position.z so the host planet's disc paints
  // over the back mesh and the front mesh paints over the disc.
  backMesh.frustumCulled  = false;
  frontMesh.frustumCulled = false;
  return { bodyIdx: ringBodyIdx, hostBodyIdx, backMesh, frontMesh, backGeometry, frontGeometry, material, outerR, innerR, tiltRad };
}

// Build one half of the ring's annulus as a triangle strip. The arc
// runs from angle 0 to π (upperHalf=true) or π to 2π (upperHalf=false)
// in the ring's local frame, then rotates by tiltRad so the visible
// silhouette matches the picker's hit-test math.
function buildHalfAnnulusGeometry(innerR: number, outerR: number, tiltRad: number, upperHalf: boolean): BufferGeometry {
  const N = RING_SEGMENTS;
  const start = upperHalf ? 0 : Math.PI;
  const end   = start + Math.PI;
  const positions = new Float32Array((N + 1) * 2 * 3);
  const indices: number[] = [];
  const cosT = Math.cos(tiltRad);
  const sinT = Math.sin(tiltRad);
  for (let i = 0; i <= N; i++) {
    const t = start + (i / N) * (end - start);
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    // Inner + outer points on the un-tilted ellipse.
    const ix = innerR * cos;
    const iy = innerR * sin * RING_MINOR_OVER_MAJOR;
    const ox = outerR * cos;
    const oy = outerR * sin * RING_MINOR_OVER_MAJOR;
    // Apply tilt rotation (positive tiltRad = counter-clockwise in
    // scene coords where y grows upward).
    const ixR = ix * cosT - iy * sinT;
    const iyR = ix * sinT + iy * cosT;
    const oxR = ox * cosT - oy * sinT;
    const oyR = ox * sinT + oy * cosT;
    positions[i * 6 + 0] = ixR; positions[i * 6 + 1] = iyR; positions[i * 6 + 2] = 0;
    positions[i * 6 + 3] = oxR; positions[i * 6 + 4] = oyR; positions[i * 6 + 5] = 0;
    if (i < N) {
      const v0 = i * 2, v1 = i * 2 + 1, v2 = (i + 1) * 2, v3 = (i + 1) * 2 + 1;
      indices.push(v0, v1, v2);
      indices.push(v1, v3, v2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}
