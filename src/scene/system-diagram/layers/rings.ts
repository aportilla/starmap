// Rings layer — one Mesh per ring per half (back + front), drawn
// through a triangle-strip annulus around the host planet. Both halves
// share one ShaderMaterial per ring; hover flips a single uniform that
// covers the whole annulus.
//
// Composition is read from the ring body's six-resource grid via
// `bodyIcyness`: resVolatiles-dominant rings lerp toward the bright
// Saturn-class palette (and a more opaque floor), rocky-dominant rings
// toward the dark Uranus/Neptune-class palette (and a fainter floor). The
// same data drives mining yields, so visual character and gameplay
// attribute can't disagree. The dithered ringlet structure on top of that
// floor lives in makeRingMaterial, seeded per ring off the body id.
//
// layout() also resolves each ring's planet-shadow inputs: it picks the
// dominant star from the published lights and writes the screen-space
// direction + center the material's shadow block needs (see
// writeShadowUniforms).

import { BufferAttribute, BufferGeometry, Mesh, Scene, ShaderMaterial } from 'three';
import { BODIES, type Body } from '../../../data/stars';
import {
  beltRingColor,
  bodyIcyness,
} from '../color-science';
import { makeRingMaterial } from '../../materials';
import {
  RENDER_ORDER_BACK_RING, RENDER_ORDER_FRONT_RING,
  RING_FLOOR_ALPHA_DUSTY, RING_FLOOR_ALPHA_ICY,
  RING_MINOR_OVER_MAJOR, RING_SEGMENTS,
  Z_BACK_RING, Z_FRONT_RING,
} from '../layout/constants';
import type { RowSlot } from '../layout/row';
import { hitsRing, ringEllipseParams } from '../geom/ring';
import { hash32, mulberry32 } from '../geom/prng';
import { bandZ } from '../geom/snap';
import { disableCulling } from '../geom/cull';
import { disposePool } from './dispose';
import type { DiagramHit, DiagramPick, PlanetCenterIndex, StarLightSource } from '../types';

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
  // (innerR/outerR)² — the picker's squared normalized inner-edge
  // radius. Constant per ring, so hoisted off hitsRing's hot path.
  innerRho2: number;
}

export class RingsLayer {
  private readonly rings: Ring[] = [];
  // bodyIdx → Ring ref, so setHovered can flip the material uniform
  // without scanning rings.
  private readonly ringByBodyIdx: Map<number, Ring> = new Map();
  // Latest published star lights; consumed in layout() to resolve each
  // ring's dominant-star shadow direction. Stored (not applied on receipt)
  // because the shadow dir is per-ring — it needs each host's screen
  // center, which layout() has.
  private lights: readonly StarLightSource[] = [];

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
      ring.backMesh.position.set(c.cx, c.cy, bandZ(c.rowIdx, Z_BACK_RING));
      ring.frontMesh.position.set(c.cx, c.cy, bandZ(c.rowIdx, Z_FRONT_RING));
      this.writeShadowUniforms(ring, c.cx, c.cy);
    }
  }

  // Publish the cluster's star lights. Stored rather than applied here —
  // each ring's shadow direction is relative to its own host center, which
  // only layout() has, so resolution happens there.
  setLightSources(lights: readonly StarLightSource[]): void {
    this.lights = lights;
  }

  // Resolve the dominant star (brightest, tie-break nearest to the host)
  // and write the ring's per-layout shadow uniforms. uCenter is the same
  // screen-px center written to mesh.position so (gl_FragCoord - uCenter)
  // is the planet-local screen offset the shader expects.
  private writeShadowUniforms(ring: Ring, cx: number, cy: number): void {
    const u = ring.material.uniforms;
    let best: StarLightSource | null = null;
    let bestDist2 = Infinity;
    for (const L of this.lights) {
      const dx = L.x - cx, dy = L.y - cy;
      const d2 = dx * dx + dy * dy;
      if (best === null || L.intensity > best.intensity ||
          (L.intensity === best.intensity && d2 < bestDist2)) {
        best = L;
        bestDist2 = d2;
      }
    }
    if (best === null) {
      u.uHasShadow.value = 0;
      return;
    }
    const dx = best.x - cx, dy = best.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    u.uLightDir2D.value.set(dx / len, dy / len);
    u.uCenter.value.set(cx, cy);
    u.uHasShadow.value = 1;
  }

  pickFront(x: number, y: number, centers: PlanetCenterIndex): DiagramHit | null {
    return this.pick(x, y, centers, 'front');
  }

  pickBack(x: number, y: number, centers: PlanetCenterIndex): DiagramHit | null {
    return this.pick(x, y, centers, 'back');
  }

  private pick(x: number, y: number, centers: PlanetCenterIndex, half: 'back' | 'front'): DiagramHit | null {
    const layerZ = half === 'front' ? Z_FRONT_RING : Z_BACK_RING;
    let best: DiagramHit | null = null;
    for (const ring of this.rings) {
      const c = centers.get(ring.hostBodyIdx);
      if (!c) continue;
      const hit = hitsRing(x, y, {
        hostCx: c.cx, hostCy: c.cy,
        outerR: ring.outerR, innerR: ring.innerR, tiltRad: ring.tiltRad,
        innerRho2: ring.innerRho2,
      }, half);
      // Same band z layout() wrote into this half's mesh.position.z;
      // keep the topmost when two planets' rings overlap.
      if (hit) {
        const z = bandZ(c.rowIdx, layerZ);
        if (best === null || z > best.z) best = { pick: { kind: 'ring', bodyIdx: ring.bodyIdx }, z };
      }
    }
    return best;
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'ring') return;
    const ring = this.ringByBodyIdx.get(pick.bodyIdx);
    if (!ring) return;
    ring.material.uniforms.uHovered.value = value;
  }

  dispose(): void {
    for (const ring of this.rings) {
      // Both halves share one material — free it with the back geometry,
      // then the front geometry on its own (no second material to drop).
      disposePool({ geometry: ring.backGeometry, material: ring.material });
      ring.frontGeometry.dispose();
    }
  }
}

function buildRing(ring: Body, hostPlanet: Body, ringBodyIdx: number, hostBodyIdx: number, hostDiscPx: number): Ring {
  const { innerR, outerR, tiltRad } = ringEllipseParams(ring, hostPlanet, hostDiscPx);
  const t = bodyIcyness(ring);
  const color = beltRingColor(t);
  // Icy↔dusty drives the solid floor's opacity; dusty rings ride a faint
  // floor so the background reads through. The dither layers ringlets on
  // top of this floor.
  const floorAlpha = RING_FLOOR_ALPHA_DUSTY + (RING_FLOOR_ALPHA_ICY - RING_FLOOR_ALPHA_DUSTY) * t;
  // Per-ring seed off the body id (same convention as bodyVisualTiltRad)
  // so each ring's band frequencies / phases / gap position are stable
  // across builds yet don't comb-align between planets.
  const seed = mulberry32(hash32(`ring-density:${ring.id}`))();
  const material = makeRingMaterial(color, floorAlpha, seed);
  // Constant per-ring shadow inputs (the rest — center, light dir — are
  // written each layout). Both normalized into outerR units, matching the
  // shader's frame.
  material.uniforms.uInnerNorm.value  = innerR / outerR;
  material.uniforms.uPlanetNorm.value = (hostDiscPx / 2) / outerR;
  material.uniforms.uInvOuterR.value  = 1 / outerR;
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
  // over the back mesh and the front mesh paints over the disc. The
  // mesh.position moves each layout — see disableCulling.
  disableCulling(backMesh);
  disableCulling(frontMesh);
  const innerRho2 = (innerR / outerR) * (innerR / outerR);
  return { bodyIdx: ringBodyIdx, hostBodyIdx, backMesh, frontMesh, backGeometry, frontGeometry, material, outerR, innerR, tiltRad, innerRho2 };
}

// Build one half of the ring's annulus as a triangle strip. The arc
// runs from angle 0 to π (upperHalf=true) or π to 2π (upperHalf=false)
// in the ring's local frame, then rotates by tiltRad so the visible
// silhouette matches the picker's hit-test math.
//
// Beyond position, each vertex carries `aRho` (0 on the inner edge, 1 on
// the outer edge — the strip interpolates it to a smooth radial
// coordinate per fragment) and `aAngle` (the parametric angle normalized
// over the FULL ellipse, so the two halves share one continuous phase
// where they meet). makeRingMaterial reads both to drive the radial
// density profile + faint azimuthal break-up.
function buildHalfAnnulusGeometry(innerR: number, outerR: number, tiltRad: number, upperHalf: boolean): BufferGeometry {
  const N = RING_SEGMENTS;
  const start = upperHalf ? 0 : Math.PI;
  const end   = start + Math.PI;
  const positions = new Float32Array((N + 1) * 2 * 3);
  const rho      = new Float32Array((N + 1) * 2);
  const angle    = new Float32Array((N + 1) * 2);
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
    // Inner vertex → rho 0, outer vertex → rho 1. Angle normalized by the
    // full circle so upper (0..π) and lower (π..2π) halves stay in phase.
    const a = t / (2 * Math.PI);
    rho[i * 2 + 0] = 0; angle[i * 2 + 0] = a;
    rho[i * 2 + 1] = 1; angle[i * 2 + 1] = a;
    if (i < N) {
      const v0 = i * 2, v1 = i * 2 + 1, v2 = (i + 1) * 2, v3 = (i + 1) * 2 + 1;
      indices.push(v0, v1, v2);
      indices.push(v1, v3, v2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aRho', new BufferAttribute(rho, 1));
  geometry.setAttribute('aAngle', new BufferAttribute(angle, 1));
  geometry.setIndex(indices);
  return geometry;
}
