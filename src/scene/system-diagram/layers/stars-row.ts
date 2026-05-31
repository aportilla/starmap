// Stars row — each cluster member is a Mesh + PlaneGeometry disc
// whose center sits ABOVE the buffer top by STAR_OFFSCREEN_FRAC of
// the disc radius, so the GPU clips the offscreen portion and the
// visible sliver reads as "huge body, mostly hidden up there".
// Mesh (not Points) is load-bearing here: GL_POINTS discards any
// sprite whose vertex falls outside the clip volume, but the
// triangle path rasterizes fine with vertices outside the viewport.

import { Color, Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector2 } from 'three';
import { CLASS_COLOR, STARS, type StarCluster } from '../../../data/stars';
import { sizes } from '../../../ui/theme';
import { makeStarHaloMaterial, makeStarMeshMaterial } from '../../materials';
import {
  DISC_SCALE, MIN_STAR_GAP, RENDER_ORDER_STAR_HALO,
  STAR_HALO_RADIUS_FACTOR, STAR_HORIZ_GAP_FACTOR, STAR_OFFSCREEN_FRAC,
  SYSTEM_VIEW_SATURATION_LIFT_MAX, SYSTEM_VIEW_SATURATION_LIFT_RATE,
} from '../layout/constants';
import { sumOf } from '../layout/row';
import { snapPxParity } from '../geom/snap';
import { pickDiscPool } from '../geom/hit';
import { disposePool } from './dispose';
import type { DiagramHit, DiagramPick, StarLightSource } from '../types';

// Tune a galaxy-view class color for the system view. Lifts the minor
// channels toward white by an amount proportional to color saturation
// (max(R,G,B) − min(R,G,B)), capped at SYSTEM_VIEW_SATURATION_LIFT_MAX.
// Both deep blue (O/B/A/WD) and deep red (M/BD) stars get softened so
// the saturated dithered fringe + halo read naturally against the body
// rather than as a "neon" ring. See SYSTEM_VIEW_SATURATION_LIFT_*
// in layout/constants.ts for context.
function tuneStarColorForSystemView(col: Color): Color {
  const maxC = Math.max(col.r, col.g, col.b);
  const minC = Math.min(col.r, col.g, col.b);
  const saturation = maxC - minC;
  const lift = Math.min(SYSTEM_VIEW_SATURATION_LIFT_MAX, saturation * SYSTEM_VIEW_SATURATION_LIFT_RATE);
  return new Color(
    col.r + (1 - col.r) * lift,
    col.g + (1 - col.g) * lift,
    col.b + (1 - col.b) * lift,
  );
}

// Intensity proxy for per-body lighting. Uses the rendered disc area
// (pxSize²) rather than bolometric luminosity — so the lighting that
// reaches the planets agrees with the visual mass of each star disc on
// screen. Real M-L luminosity spans ~4 orders of magnitude across
// stellar classes (a Fomalhaut B/C-class companion is 50-3000× dimmer
// than the A primary), which buries every dim companion below visual
// detection. Rendered pxSize is already cube-root-compressed against
// radiusSolar in build-catalog.mjs, so the dynamic range is tame and
// a Fomalhaut triple lights every body with all three hues visible
// rather than reading as a single-source A-class wash with imperceptible
// red overtones.
function discAreaIntensity(pxSize: number): number {
  return pxSize * pxSize;
}

interface StarDisc {
  mesh: Mesh;
  geometry: PlaneGeometry;
  material: ShaderMaterial;
  // Halo mesh paired with this disc: a larger plane behind the disc
  // running makeStarHaloMaterial, dithered additive cloud around the
  // disc edge. Same (cx, cy) as the disc; geometry sized to enclose
  // the halo bbox (2·discRadius·STAR_HALO_RADIUS_FACTOR square).
  halo: Mesh;
  haloGeometry: PlaneGeometry;
  haloMaterial: ShaderMaterial;
  // Cached current diameter in px — used to detect when layout()
  // needs to rebuild the geometry (size changed under width-fit scaling).
  currentDiam: number;
  // Per-cluster-normalized intensity in [0, 1] driving body lighting
  // contributions. Computed once at construction; the brightest member's
  // rendered disc area is the normalization anchor.
  intensity: number;
  // System-view-tuned color (the same RGB the disc + halo shaders render).
  // Cached as a plain triple to avoid copying out of a Three.js Color
  // every frame.
  lightColor: readonly [number, number, number];
}

export class StarsRowLayer {
  // starMembers[slot] is the source star index in catalog member order
  // (members[0] = primary), laid out left-to-right. starDiscs[slot] is
  // the corresponding mesh.
  private readonly starMembers: readonly number[];
  private readonly starSlotDiscPx: readonly number[];
  private readonly starDiscs: StarDisc[] = [];
  // starIdx → slot index in starMembers, so setHovered can flip the
  // per-mesh uHovered uniform without scanning starMembers.
  private readonly slotByStarIdx: ReadonlyMap<number, number>;

  constructor(scene: Scene, cluster: StarCluster) {
    // Lay stars out left-to-right in catalog member order: cluster.members[0]
    // is the primary (most massive), so it takes the leftmost slot and
    // companions follow rightward.
    this.starMembers     = cluster.members.slice();
    this.starSlotDiscPx  = this.starMembers.map(m => Math.floor(STARS[m].pxSize * DISC_SCALE + 0.5));
    this.slotByStarIdx   = new Map(this.starMembers.map((s, i) => [s, i]));

    // Pre-normalize per-slot intensities so the largest cluster member
    // anchors at 1.0. Floors at a small positive so a degenerate
    // zero-pxSize input doesn't divide by zero.
    const rawIntensity = this.starSlotDiscPx.map(d => discAreaIntensity(d));
    const maxI = Math.max(1, ...rawIntensity);
    const slotIntensity = rawIntensity.map(i => i / maxI);

    // Build one disc + one halo mesh per star. Both geometries are
    // sized to the star's natural diameter (before any width-fit
    // scaling); layout() rebuilds them if a different size is needed.
    // Initial position is (0, 0); resize fills it in.
    this.starMembers.forEach((starIdx, slot) => {
      const s = STARS[starIdx];
      const classCol = CLASS_COLOR[s.cls] ?? CLASS_COLOR.M;
      const col = tuneStarColorForSystemView(classCol);
      const d = this.starSlotDiscPx[slot];
      const r = d / 2;

      const material = makeStarMeshMaterial();
      material.uniforms.uColor.value.setRGB(col.r, col.g, col.b);
      material.uniforms.uRadius.value = r;
      const geometry = new PlaneGeometry(d, d);
      const mesh = new Mesh(geometry, material);

      const haloMaterial = makeStarHaloMaterial();
      haloMaterial.uniforms.uColor.value.setRGB(col.r, col.g, col.b);
      haloMaterial.uniforms.uDiscRadius.value = r;
      const haloR = r * STAR_HALO_RADIUS_FACTOR;
      haloMaterial.uniforms.uHaloRadius.value = haloR;
      const haloDiam = Math.ceil(haloR * 2);
      const haloGeometry = new PlaneGeometry(haloDiam, haloDiam);
      const halo = new Mesh(haloGeometry, haloMaterial);
      halo.renderOrder = RENDER_ORDER_STAR_HALO;

      // Hidden until first layout() places them; avoids a one-frame
      // flash at the origin.
      mesh.visible = false;
      halo.visible = false;
      scene.add(halo);
      scene.add(mesh);

      this.starDiscs.push({
        mesh, geometry, material,
        halo, haloGeometry, haloMaterial,
        currentDiam: d,
        intensity: slotIntensity[slot],
        lightColor: [col.r, col.g, col.b],
      });
    });
  }

  layout(bufferW: number, bufferH: number): void {
    const N = this.starMembers.length;
    if (N === 0) return;

    const availW = bufferW - 2 * sizes.edgePad;
    const maxDiscPx = Math.max(...this.starSlotDiscPx);
    let gap = N > 1 ? maxDiscPx * STAR_HORIZ_GAP_FACTOR : 0;
    const totalW = sumOf(this.starSlotDiscPx) + (N - 1) * gap;

    // Width-fit: shrink gap first (down to MIN_STAR_GAP), then scale all
    // disc sizes proportionally if even the minimum-gap row would
    // overflow. The proportional scale preserves within-row size ratios.
    let discScale = 1;
    if (totalW > availW && N > 1) {
      const fixed = sumOf(this.starSlotDiscPx);
      const minTotal = fixed + (N - 1) * MIN_STAR_GAP;
      if (minTotal <= availW) {
        gap = (availW - fixed) / (N - 1);
      } else {
        const targetFixed = availW - (N - 1) * MIN_STAR_GAP;
        discScale = targetFixed / Math.max(fixed, 1);
        gap = MIN_STAR_GAP;
      }
    }

    // Pinned to the top-left: the row starts at the edge margin and grows
    // rightward (primary first), rather than centering on the buffer.
    const startX = sizes.edgePad;
    let cursor = startX;
    for (let slot = 0; slot < N; slot++) {
      const d = Math.max(1, Math.round(this.starSlotDiscPx[slot] * discScale));
      const r = d / 2;
      const cxTarget = cursor + r;
      // Star center sits above the buffer top by STAR_OFFSCREEN_FRAC × r,
      // so the disc reads as "huge body, mostly hidden". Mesh path makes
      // this safe; GL_POINTS would discard the off-edge vertex.
      const cyTarget = bufferH + r * STAR_OFFSCREEN_FRAC;

      // Parity-aware snap for pixel-perfect rasterization: even diameter
      // → center on integer (pixel boundary), odd diameter → center on
      // integer+0.5 (pixel center). Same parity-aware floor the disc vertex
      // shaders apply via snapToPixelGrid (materials PIXEL_SNAP_GLSL),
      // computed CPU-side here because the star row resolves centers on the CPU.
      const cx = snapPxParity(cxTarget, d);
      const cy = snapPxParity(cyTarget, d);

      const disc = this.starDiscs[slot];
      // Rebuild the plane geometries only when diameter actually
      // changed; a resize that doesn't change layout leaves them intact.
      if (disc.currentDiam !== d) {
        disc.geometry.dispose();
        disc.geometry = new PlaneGeometry(d, d);
        disc.mesh.geometry = disc.geometry;
        disc.material.uniforms.uRadius.value = r;

        const haloR = r * STAR_HALO_RADIUS_FACTOR;
        disc.haloMaterial.uniforms.uDiscRadius.value = r;
        disc.haloMaterial.uniforms.uHaloRadius.value = haloR;
        disc.haloGeometry.dispose();
        const haloDiam = Math.ceil(haloR * 2);
        disc.haloGeometry = new PlaneGeometry(haloDiam, haloDiam);
        disc.halo.geometry = disc.haloGeometry;

        disc.currentDiam = d;
      }
      disc.mesh.position.set(cx, cy, 0);
      (disc.material.uniforms.uCenter.value as Vector2).set(cx, cy);
      disc.mesh.visible = true;
      disc.halo.position.set(cx, cy, 0);
      (disc.haloMaterial.uniforms.uCenter.value as Vector2).set(cx, cy);
      disc.halo.visible = true;

      cursor += d + gap;
    }
  }

  pickAt(x: number, y: number): DiagramHit | null {
    return pickDiscPool(
      x, y, this.starDiscs.length,
      i => this.starDiscs[i].mesh.position.x,
      i => this.starDiscs[i].mesh.position.y,
      i => this.starDiscs[i].currentDiam / 2,
      // Stars sit at z 0 (their own row, above the dome bands), so they
      // lose every band tie to a body — matching their last-place spot
      // in the coordinator's priority list. Flat z across the pool, so
      // the in-pool resolve is a no-op tiebreak (earliest slot wins).
      i => this.starDiscs[i].mesh.position.z,
      i => ({ pick: { kind: 'star', starIdx: this.starMembers[i] }, z: this.starDiscs[i].mesh.position.z }),
    );
  }

  // Snapshot of every cluster member's current screen position + tuned
  // color + normalized intensity, for the body lighting pass in
  // PlanetsLayer / MoonsLayer. Positions reflect the most recent
  // layout() call (each star's mesh sits above the buffer top by
  // STAR_OFFSCREEN_FRAC × radius); intensities and colors are static.
  // Returns a fresh array each call — cheap (clusters cap at a handful
  // of members) and lets the consumer hold it as long as needed without
  // worrying about underlying mutation.
  getLightSources(): readonly StarLightSource[] {
    return this.starDiscs.map(disc => ({
      x: disc.mesh.position.x,
      y: disc.mesh.position.y,
      r: disc.currentDiam / 2,
      color: disc.lightColor,
      intensity: disc.intensity,
    }));
  }

  setHovered(pick: DiagramPick, value: 0 | 1): void {
    if (pick.kind !== 'star') return;
    const slot = this.slotByStarIdx.get(pick.starIdx);
    if (slot === undefined) return;
    this.starDiscs[slot].material.uniforms.uHovered.value = value;
  }

  dispose(): void {
    for (const disc of this.starDiscs) {
      disposePool({ geometry: disc.geometry, material: disc.material });
      disposePool({ geometry: disc.haloGeometry, material: disc.haloMaterial });
    }
  }
}
